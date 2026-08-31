import {
  ActionIdKind,
  createDomainError,
  type ActionId,
  type JsonObject,
} from "@guard/contracts";
import {
  CapabilityGateway,
  type CapabilityApprovalChallenge,
  type CapabilityApprovalClock,
  type CapabilityGatewayOptions,
} from "@guard/capability-gateway";
import type { SemanticOperationDefinition } from "@guard/model-provider";
import type {
  CompletedProviderToolCall,
  ToolDispatcher,
} from "@guard/robin-agent";
import type {
  RobinApprovalInvalidationReason,
  RobinApprovalOutcome,
} from "@guard/robin-session";
import type { RobinR2CapabilityRuntime } from "@guard/robin-tools";

import { createRobinR2PolicyEvaluator } from "./r2-policy.js";
import type {
  RobinApplicationToolLifecycle,
} from "./tool-lifecycle.js";

export interface R2GatewayActionIdSource {
  nextActionId(): ActionId;
}

export interface R2GatewayToolDispatcherOptions {
  readonly runtime: RobinR2CapabilityRuntime;
  readonly lifecycle: RobinApplicationToolLifecycle;
  readonly permissionMode: "ask" | "plan";
  readonly actionIds?: R2GatewayActionIdSource;
  readonly gateway?: CapabilityGatewayOptions;
  readonly secretCorrelationToken?: string;
}

const SYSTEM_APPROVAL_CLOCK: CapabilityApprovalClock = Object.freeze({
  now: () => new Date().toISOString(),
});

/** Complete R2 normalize → policy → approval → revalidate → execute pipeline. */
export class R2GatewayToolDispatcher implements ToolDispatcher {
  public readonly advertisedOperations: readonly SemanticOperationDefinition[];
  readonly #runtime: RobinR2CapabilityRuntime;
  readonly #gateway: CapabilityGateway;
  readonly #lifecycle: RobinApplicationToolLifecycle;
  readonly #actionIds: R2GatewayActionIdSource;
  readonly #clock: CapabilityApprovalClock;
  readonly #usedActionIds = new Set<ActionId>();

  public constructor(options: R2GatewayToolDispatcherOptions) {
    this.#runtime = options.runtime;
    this.#lifecycle = options.lifecycle;
    const source = options.actionIds ?? Object.freeze({
      nextActionId: () => ActionIdKind.generate(),
    });
    this.#actionIds = Object.freeze({
      nextActionId: source.nextActionId.bind(source),
    });
    this.#clock = captureApprovalClock(
      options.gateway?.approvalClock ?? SYSTEM_APPROVAL_CLOCK,
    );
    this.#gateway = new CapabilityGateway(
      options.runtime.registry,
      createRobinR2PolicyEvaluator(
        options.permissionMode,
        options.secretCorrelationToken,
      ),
      {
        maximumInputBytes: 1024 * 1024,
        maximumRawOutputBytes: 16 * 1024 * 1024,
        maximumReleasedViewBytes: 16 * 1024 * 1024,
        maximumCombinedReleasedViewBytes: 48 * 1024 * 1024,
        defaultApprovalLifetimeMs: 5 * 60 * 1000,
        maximumApprovalLifetimeMs: 15 * 60 * 1000,
        ...options.gateway,
        approvalClock: this.#clock,
      },
    );
    this.advertisedOperations = Object.freeze(
      options.runtime.advertisement.operations.map((operation) =>
        Object.freeze({
          capabilityPackId: operation.packId,
          capabilityPackVersion: operation.packVersion,
          operationId: operation.operationId,
          operationVersion: operation.operationVersion,
          description: operation.description,
          inputSchema: operation.inputSchema.document,
        }),
      ),
    );
  }

  public async dispatch(
    call: CompletedProviderToolCall,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    throwIfAborted(signal);
    const prepared = await this.#gateway.normalize(
      {
        schemaVersion: 1,
        packId: call.capabilityPackId,
        packVersion: call.capabilityPackVersion,
        operationId: call.operationId,
        operationVersion: call.operationVersion,
        input: call.arguments,
      },
      {
        actionId: this.#nextActionId(),
        subject: {
          kind: "agent_driver",
          driverId: "robin.turn-coordinator",
          compatibilityTier: "native",
        },
        environment: {
          profileId: "robin-r2-live-workspace",
          sandboxed: false,
          networkProfile: "ambient_unsandboxed",
          trustLevel: "local_workspace",
        },
      },
      this.#runtime.advertisement,
    );
    throwIfAborted(signal);
    const evaluated = this.#gateway.evaluate(prepared);
    const toolName = r2ToolDisplayName(call);
    this.#lifecycle.permissionDecided({
      actionHash: prepared.actionHash,
      actionId: prepared.action.actionId,
      callId: call.callId,
      effect: evaluated.decision.effect,
      policySnapshotHash: evaluated.policySnapshotHash,
      policyVersionId: evaluated.decision.policyVersionId,
      toolName,
      winningPolicyName: evaluated.decision.winningPolicyName,
    });

    let authorization = this.#gateway.authorize(evaluated);
    if (authorization.status === "denied" || authorization.status === "stale") {
      return authorization.observation;
    }

    let approvedChallenge: CapabilityApprovalChallenge | null = null;
    let approvedResolvedAt: string | null = null;
    if (authorization.status === "approval_required") {
      const challenge = this.#gateway.createApprovalChallenge(evaluated, {
        displayedSummary: this.#runtime.approvalSummary(prepared),
      });
      const binding = approvalBinding(challenge, call.callId, toolName);
      const decision = await this.#lifecycle.requestApproval(
        {
          ...binding,
          displayedSummary: challenge.displayedSummary,
        },
        signal,
      );
      throwIfAborted(signal);
      const resolution = this.#gateway.resolveApproval(challenge, {
        schemaVersion: 1,
        approvalId: challenge.approvalId,
        decision,
        normalizedRequestHash: challenge.normalizedRequestHash,
        preconditionHash: challenge.preconditionHash,
        policySnapshotHash: challenge.policySnapshotHash,
        displayedSummaryHash: challenge.displayedSummaryHash,
      });
      if (resolution.status !== "granted") {
        const resolvedAt = this.#readApprovalTime();
        this.#lifecycle.approvalResolved({
          ...binding,
          decision,
          outcome: resolution.status,
          resolvedAt,
        });
        return resolution.observation;
      }
      approvedResolvedAt = resolution.grant.grantedAt;
      authorization = this.#gateway.authorize(resolution.grant);
      if (authorization.status !== "authorized") {
        const outcome: RobinApprovalOutcome =
          authorization.status === "stale" ? "stale" : "denied";
        this.#lifecycle.approvalResolved({
          ...binding,
          decision,
          outcome,
          resolvedAt: resolution.grant.grantedAt,
        });
        if (authorization.status === "approval_required") {
          throw invariant("An approval grant unexpectedly required another approval.");
        }
        return authorization.observation;
      }
      approvedChallenge = challenge;
      this.#lifecycle.approvalResolved({
        ...binding,
        decision,
        outcome: "granted",
        resolvedAt: resolution.grant.grantedAt,
      });
    }

    if (authorization.status !== "authorized") {
      throw invariant("The gateway produced no execution authority.");
    }
    const executed = await this.#runtime.executeAuthorized(
      this.#gateway,
      authorization.authorization,
      { signal },
    );
    if (executed.status === "executed") return executed.result.agent;

    if (approvedChallenge !== null && approvedResolvedAt !== null) {
      const binding = approvalBinding(
        approvedChallenge,
        call.callId,
        toolName,
      );
      const invalidation = approvalInvalidation(executed.observation);
      this.#lifecycle.approvalInvalidated({
        ...binding,
        invalidatedAt: this.#readApprovalTime(),
        observedPreconditionHash: invalidation.observedPreconditionHash,
        reason: invalidation.reason,
      });
    }
    return executed.observation;
  }

  #nextActionId(): ActionId {
    let actionId: ActionId;
    try {
      actionId = this.#actionIds.nextActionId();
    } catch {
      throw infrastructure("The R2 action identifier source failed.");
    }
    if (!ActionIdKind.is(actionId)) {
      throw infrastructure("The R2 action identifier source returned an invalid identifier.");
    }
    if (this.#usedActionIds.has(actionId)) {
      throw infrastructure("The R2 action identifier source repeated an identifier.");
    }
    this.#usedActionIds.add(actionId);
    return actionId;
  }

  #readApprovalTime(): string {
    let value: string;
    try {
      value = this.#clock.now();
    } catch {
      throw infrastructure("The R2 approval clock failed.");
    }
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value))
    ) {
      throw infrastructure("The R2 approval clock returned an invalid timestamp.");
    }
    return value;
  }
}

export function r2ToolDisplayName(call: {
  readonly capabilityPackId: string;
  readonly operationId: string;
  readonly operationVersion: number;
}): string {
  return `${call.capabilityPackId}.${call.operationId}@${call.operationVersion}`;
}

function approvalBinding(
  challenge: CapabilityApprovalChallenge,
  callId: string,
  toolName: string,
) {
  return Object.freeze({
    actionHash: challenge.actionHash,
    actionId: challenge.actionId,
    approvalId: challenge.approvalId,
    callId,
    displayedSummaryHash: challenge.displayedSummaryHash,
    expiresAt: challenge.expiresAt,
    normalizedRequestHash: challenge.normalizedRequestHash,
    policySnapshotHash: challenge.policySnapshotHash,
    preconditionHash: challenge.preconditionHash,
    requestedAt: challenge.requestedAt,
    toolName,
  });
}

function approvalInvalidation(observation: JsonObject): {
  readonly reason: RobinApprovalInvalidationReason;
  readonly observedPreconditionHash: string | null;
} {
  const reason = observation["reason"];
  if (reason !== "approval_expired" && reason !== "preconditions_changed") {
    throw invariant("A stale approved execution had an unknown invalidation reason.");
  }
  const observed = observation["observedPreconditionHash"];
  if (
    observed !== undefined &&
    (typeof observed !== "string" || !/^[a-f0-9]{64}$/u.test(observed))
  ) {
    throw invariant("A stale approved execution had an invalid precondition hash.");
  }
  return Object.freeze({
    reason,
    observedPreconditionHash: observed ?? null,
  });
}

function captureApprovalClock(clock: CapabilityApprovalClock): CapabilityApprovalClock {
  if (clock === null || typeof clock !== "object" || typeof clock.now !== "function") {
    throw createDomainError({
      code: "invalid_input",
      message: "The R2 gateway requires a valid approval clock.",
    });
  }
  return Object.freeze({ now: clock.now.bind(clock) });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createDomainError({
      code: "cancelled",
      message: "The R2 tool dispatch was cancelled.",
    });
  }
}

function invariant(message: string) {
  return createDomainError({ code: "invariant_violated", message });
}

function infrastructure(message: string) {
  return createDomainError({ code: "infrastructure_failed", message });
}
