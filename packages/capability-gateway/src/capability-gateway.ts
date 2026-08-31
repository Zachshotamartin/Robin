import { isProxy } from "node:util/types";

import {
  ActionIdKind,
  ApprovalIdKind,
  CONTRACT_SCHEMA_VERSION,
  PolicyVersionIdKind,
  canonicalBytes,
  canonicalSha256Hex,
  createDomainError,
  isDomainError,
  parseResourceRef,
} from "@guard/contracts";
import type {
  ActionPrecondition,
  ApprovalId,
  JsonObject,
  NormalizedAction,
  ResourceRef,
} from "@guard/contracts";
import type {
  PinnedPolicyEvaluator,
  PolicyDecision,
  PolicyEffect,
} from "@guard/policy-engine";

import type {
  CapabilityActionProposal,
  CapabilityApprovalChallenge,
  CapabilityApprovalChallengeInput,
  CapabilityApprovalClock,
  CapabilityApprovalGrant,
  CapabilityApprovalIdSource,
  CapabilityApprovalResolution,
  CapabilityApprovalResponse,
  CapabilityAuthorizationResult,
  CapabilityAuthorizedExecutionContext,
  CapabilityAuthorizedExecutionResult,
  CapabilityAgentContextReleaseClaim,
  CapabilityAgentContextReleaseDefinition,
  CapabilityAgentContextReleaseDescriptor,
  CapabilityAdvertisement,
  CapabilityContextPolicyProjection,
  CapabilityExecutionContext,
  CapabilityExecutionResult,
  CapabilityGatewayOptions,
  CapabilityNormalizationContext,
  CapabilityReleasedViews,
  CapabilitySemanticNormalization,
  EvaluatedCapabilityAction,
  AuthorizedCapabilityAction,
  PreparedCapabilityAction,
} from "./capability-types.js";
import {
  CapabilityPackRegistry,
  assertAdvertisedOperation,
  resolveRegisteredOperation,
  runCompiledValidation,
  type CompiledOperation,
} from "./capability-pack-registry.js";
import { isPlainRecord, snapshot, snapshotObject } from "./immutable.js";

interface PreparedProvenance {
  readonly operation: CompiledOperation;
  readonly action: NormalizedAction;
  readonly actionHash: string;
}

interface CapturedPolicyEvaluator {
  readonly policyVersionId: PolicyDecision["policyVersionId"];
  readonly evaluate: PinnedPolicyEvaluator["evaluate"];
}

interface EvaluatedProvenance extends PreparedProvenance {
  readonly prepared: PreparedCapabilityAction;
  readonly decision: PolicyDecision;
  readonly decisionHash: string;
  readonly policySnapshotHash: string;
  consumed: boolean;
}

interface ApprovalChallengeProvenance extends EvaluatedProvenance {
  readonly challenge: CapabilityApprovalChallenge;
  readonly challengeHash: string;
  readonly normalizedRequestHash: string;
  readonly preconditionHash: string;
  readonly displayedSummaryHash: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  resolved: boolean;
}

interface ApprovalGrantProvenance extends ApprovalChallengeProvenance {
  readonly grant: CapabilityApprovalGrant;
  readonly grantHash: string;
  readonly grantedAtMs: number;
  grantConsumed: boolean;
}

interface AuthorizationProvenance extends PreparedProvenance {
  readonly authorization: AuthorizedCapabilityAction;
  readonly authorizationHash: string;
  readonly decision: PolicyDecision;
  readonly decisionHash: string;
  readonly preconditionHash: string;
  readonly approvalId: ApprovalId | null;
  readonly grantedAtMs: number | null;
  readonly expiresAtMs: number | null;
  authorizationConsumed: boolean;
}

interface CapabilityGatewayLimits {
  readonly maximumInputBytes: number;
  readonly maximumRawOutputBytes: number;
  readonly maximumReleasedViewBytes: number;
  readonly maximumCombinedReleasedViewBytes: number;
}

interface CapabilityGatewayConfiguration extends CapabilityGatewayLimits {
  readonly approvalClock: CapabilityApprovalClock;
  readonly approvalIdSource: CapabilityApprovalIdSource;
  readonly defaultApprovalLifetimeMs: number;
  readonly maximumApprovalLifetimeMs: number;
}

const DEFAULT_GATEWAY_LIMITS: CapabilityGatewayLimits = Object.freeze({
  maximumInputBytes: 1024 * 1024,
  maximumRawOutputBytes: 1024 * 1024,
  maximumReleasedViewBytes: 1024 * 1024,
  maximumCombinedReleasedViewBytes: 2 * 1024 * 1024,
});

const DEFAULT_APPROVAL_LIFETIME_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const SYSTEM_APPROVAL_CLOCK: CapabilityApprovalClock = Object.freeze({
  now: () => new Date().toISOString(),
});
const SYSTEM_APPROVAL_ID_SOURCE: CapabilityApprovalIdSource = Object.freeze({
  nextApprovalId: () => ApprovalIdKind.generate(),
});

/**
 * Structural validation, semantic normalization, pinned policy evaluation,
 * and execution meet only here. A handler can be dispatched only through the
 * exact one-use receipt this instance issued after evaluating its exact
 * normalized action, preventing policy bypass or reconstructed arguments.
 */
export class CapabilityGateway {
  readonly #registry: CapabilityPackRegistry;
  readonly #policyEvaluator: CapturedPolicyEvaluator;
  readonly #prepared = new WeakMap<PreparedCapabilityAction, PreparedProvenance>();
  readonly #evaluatedPrepared = new WeakSet<PreparedCapabilityAction>();
  readonly #evaluated = new WeakMap<EvaluatedCapabilityAction, EvaluatedProvenance>();
  readonly #approvalChallenges = new WeakMap<
    CapabilityApprovalChallenge,
    ApprovalChallengeProvenance
  >();
  readonly #approvalGrants = new WeakMap<
    CapabilityApprovalGrant,
    ApprovalGrantProvenance
  >();
  readonly #authorizations = new WeakMap<
    AuthorizedCapabilityAction,
    AuthorizationProvenance
  >();
  readonly #usedApprovalIds = new Set<ApprovalId>();
  readonly #maximumInputBytes: number;
  readonly #maximumRawOutputBytes: number;
  readonly #maximumReleasedViewBytes: number;
  readonly #maximumCombinedReleasedViewBytes: number;
  readonly #approvalClock: CapabilityApprovalClock;
  readonly #approvalIdSource: CapabilityApprovalIdSource;
  readonly #defaultApprovalLifetimeMs: number;
  readonly #maximumApprovalLifetimeMs: number;

  constructor(
    registry: CapabilityPackRegistry,
    policyEvaluator: PinnedPolicyEvaluator,
    options: CapabilityGatewayOptions = {},
  ) {
    if (!(registry instanceof CapabilityPackRegistry)) {
      throw createDomainError({
        code: "invalid_input",
        message: "The capability gateway requires a recognized pack registry.",
      });
    }
    const configuration = normalizeGatewayOptions(options);
    this.#registry = registry;
    this.#policyEvaluator = capturePinnedPolicyEvaluator(policyEvaluator);
    this.#maximumInputBytes = configuration.maximumInputBytes;
    this.#maximumRawOutputBytes = configuration.maximumRawOutputBytes;
    this.#maximumReleasedViewBytes = configuration.maximumReleasedViewBytes;
    this.#maximumCombinedReleasedViewBytes =
      configuration.maximumCombinedReleasedViewBytes;
    this.#approvalClock = configuration.approvalClock;
    this.#approvalIdSource = configuration.approvalIdSource;
    this.#defaultApprovalLifetimeMs = configuration.defaultApprovalLifetimeMs;
    this.#maximumApprovalLifetimeMs = configuration.maximumApprovalLifetimeMs;
    Object.freeze(this);
  }

  async normalize(
    proposal: CapabilityActionProposal,
    context: CapabilityNormalizationContext,
    advertisement: CapabilityAdvertisement,
  ): Promise<PreparedCapabilityAction> {
    const reference = validateProposalEnvelope(proposal);
    assertAdvertisedOperation(this.#registry, advertisement, reference);
    const operation = resolveRegisteredOperation(this.#registry, reference);
    const input = snapshotObject(reference.input, "Capability operation input");
    const inputBytes = canonicalBytes(input).byteLength;
    if (inputBytes > this.#maximumInputBytes) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "Capability operation input exceeds the gateway byte bound.",
        details: {
          maximumInputBytes: this.#maximumInputBytes,
          inputBytes,
        },
      });
    }
    const structurallyValidInput = runCompiledValidation(
      operation.validateInput,
      input,
      "input",
    );
    const normalizedContext = normalizeContext(context);

    let semantics: CapabilitySemanticNormalization;
    try {
      semantics = await operation.normalize(
        structurallyValidInput,
        normalizedContext,
      );
    } catch (error: unknown) {
      if (isDomainError(error)) {
        throw error;
      }
      throw createDomainError({
        code: "invariant_violated",
        message: "The capability semantic normalizer failed unexpectedly.",
      });
    }
    const normalized = normalizeSemanticResult(semantics);
    const action: NormalizedAction = snapshot({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      actionId: normalizedContext.actionId,
      capabilityPackId: reference.packId,
      capabilityPackVersion: reference.packVersion,
      operationId: reference.operationId,
      operationVersion: reference.operationVersion,
      subject: normalizedContext.subject,
      resource: normalized.resource,
      environment: normalizedContext.environment,
      request: normalized.request,
      normalizedInput: normalized.normalizedInput,
      sideEffectClass: operation.definition.sideEffectClass,
      preconditions: normalized.preconditions,
    });
    const actionHash = canonicalSha256Hex(action);
    const prepared: PreparedCapabilityAction = Object.freeze({ action, actionHash });
    this.#prepared.set(
      prepared,
      Object.freeze({ operation, action, actionHash }),
    );
    return prepared;
  }

  /**
   * Evaluate one exact prepared action through the evaluator pinned when this
   * gateway was constructed. Milestone B evaluators are intentionally
   * synchronous; async policy dependencies are outside the pure policy model.
   */
  evaluate(prepared: PreparedCapabilityAction): EvaluatedCapabilityAction {
    const provenance = this.#preparedProvenance(prepared);
    if (this.#evaluatedPrepared.has(prepared)) {
      throw invariant("A prepared capability action may be evaluated only once.");
    }
    // Set before calling the port so hostile or accidental reentrancy cannot
    // produce two decisions for one normalized action.
    this.#evaluatedPrepared.add(prepared);

    let untrustedDecision: unknown;
    try {
      untrustedDecision = this.#policyEvaluator.evaluate(provenance.action);
    } catch {
      throw policyEvaluationFailure(
        "The pinned policy evaluator failed before producing a decision.",
      );
    }

    let decision: PolicyDecision;
    try {
      decision = normalizePolicyDecision(
        untrustedDecision,
        this.#policyEvaluator.policyVersionId,
      );
    } catch {
      throw policyEvaluationFailure(
        "The pinned policy evaluator returned an invalid decision.",
      );
    }
    const decisionHash = canonicalSha256Hex(decision);
    const policySnapshotHash = policySnapshotHashFor(decision);
    const receipt = Object.freeze({
      prepared,
      decision,
      policySnapshotHash,
    }) as unknown as EvaluatedCapabilityAction;
    this.#evaluated.set(receipt, {
      ...provenance,
      prepared,
      decision,
      decisionHash,
      policySnapshotHash,
      consumed: false,
    });
    return receipt;
  }

  /**
   * Converts an allow decision or a valid one-use approval grant into opaque
   * execution authority. Expected denial is returned as a bounded model-safe
   * observation instead of being confused with a gateway failure.
   */
  authorize(
    candidate: EvaluatedCapabilityAction | CapabilityApprovalGrant,
  ): CapabilityAuthorizationResult {
    const grantProvenance = this.#approvalGrants.get(
      candidate as CapabilityApprovalGrant,
    );
    if (grantProvenance !== undefined) {
      return this.#authorizeGrant(
        candidate as CapabilityApprovalGrant,
        grantProvenance,
      );
    }

    const provenance = this.#evaluatedProvenance(
      candidate as EvaluatedCapabilityAction,
    );
    if (provenance.consumed) {
      throw invariant("An evaluated capability action receipt may be consumed only once.");
    }
    if (provenance.decision.effect === "require_approval") {
      return Object.freeze({ status: "approval_required" });
    }
    provenance.consumed = true;
    if (provenance.decision.effect === "deny") {
      return Object.freeze({
        status: "denied",
        observation: refusalObservation(provenance.action, {
          status: "denied",
          code: "policy_denied",
          reason: "policy_denied",
          nextAction: "choose_alternative",
        }),
      });
    }
    return Object.freeze({
      status: "authorized",
      authorization: this.#issueAuthorization(provenance, {
        source: "policy",
        approvalId: null,
        grantedAtMs: null,
        expiresAtMs: null,
      }),
    });
  }

  /** Creates one immutable challenge for the exact approval-gated receipt. */
  createApprovalChallenge(
    evaluated: EvaluatedCapabilityAction,
    input: CapabilityApprovalChallengeInput,
  ): CapabilityApprovalChallenge {
    const provenance = this.#evaluatedProvenance(evaluated);
    if (provenance.consumed) {
      throw invariant("An evaluated capability action receipt may be consumed only once.");
    }
    if (provenance.decision.effect !== "require_approval") {
      throw invalidInput(
        "An approval challenge requires an exact approval-gated policy decision.",
      );
    }
    const challengeInput = normalizeApprovalChallengeInput(
      input,
      this.#defaultApprovalLifetimeMs,
      this.#maximumApprovalLifetimeMs,
    );
    assertByteBound(
      challengeInput.displayedSummary,
      "approval displayed summary",
      this.#maximumReleasedViewBytes,
      "maximumReleasedViewBytes",
    );

    // Consume before calling clock/ID ports so hostile reentrancy cannot issue
    // two challenges for one evaluated action. Port failure leaves it unusable.
    provenance.consumed = true;
    const requested = readApprovalInstant(this.#approvalClock);
    const approvalId = readApprovalId(this.#approvalIdSource);
    if (this.#usedApprovalIds.has(approvalId)) {
      throw createDomainError({
        code: "infrastructure_failed",
        message: "The approval identifier source repeated an identifier.",
      });
    }
    this.#usedApprovalIds.add(approvalId);
    const expiresAtMs = requested.epochMs + challengeInput.lifetimeMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw createDomainError({
        code: "infrastructure_failed",
        message: "The approval expiry could not be represented safely.",
      });
    }
    const normalizedRequestHash = normalizedRequestHashFor(provenance.action);
    const preconditionHash = preconditionHashFor(provenance.action.preconditions);
    const policySnapshotHash = provenance.policySnapshotHash;
    const displayedSummaryHash = canonicalSha256Hex(
      challengeInput.displayedSummary,
    );
    const challenge = snapshot({
      schemaVersion: 1,
      approvalId,
      actionId: provenance.action.actionId,
      actionHash: provenance.actionHash,
      normalizedRequestHash,
      preconditionHash,
      policySnapshotHash,
      displayedSummary: challengeInput.displayedSummary,
      displayedSummaryHash,
      requestedAt: requested.iso,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }) as CapabilityApprovalChallenge;
    const challengeProvenance: ApprovalChallengeProvenance = {
      ...provenance,
      challenge,
      challengeHash: canonicalSha256Hex(challenge),
      normalizedRequestHash,
      preconditionHash,
      policySnapshotHash,
      displayedSummaryHash,
      requestedAtMs: requested.epochMs,
      expiresAtMs,
      resolved: false,
    };
    this.#approvalChallenges.set(challenge, challengeProvenance);
    return challenge;
  }

  /** Resolves one exact displayed challenge into denial, staleness, or a grant. */
  resolveApproval(
    challenge: CapabilityApprovalChallenge,
    response: CapabilityApprovalResponse,
  ): CapabilityApprovalResolution {
    const provenance = this.#approvalChallengeProvenance(challenge);
    if (provenance.resolved) {
      throw invariant("An approval challenge may be resolved only once.");
    }
    // First attempted response owns the challenge. Invalid or mismatched input
    // fails closed instead of leaving a second approval path available.
    provenance.resolved = true;
    const captured = normalizeApprovalResponse(response);
    if (
      captured.approvalId !== challenge.approvalId ||
      captured.normalizedRequestHash !== provenance.normalizedRequestHash ||
      captured.preconditionHash !== provenance.preconditionHash ||
      captured.policySnapshotHash !== provenance.policySnapshotHash ||
      captured.displayedSummaryHash !== provenance.displayedSummaryHash
    ) {
      throw approvalInvalid(
        "The approval response does not match the displayed request.",
      );
    }
    const responded = readApprovalInstant(this.#approvalClock);
    if (responded.epochMs < provenance.requestedAtMs) {
      throw approvalInvalid("The approval clock moved before the request time.");
    }
    if (responded.epochMs >= provenance.expiresAtMs) {
      return Object.freeze({
        status: "stale",
        observation: refusalObservation(provenance.action, {
          status: "stale",
          code: "approval_invalid",
          reason: "approval_expired",
          nextAction: "request_fresh_approval",
        }),
      });
    }
    if (captured.decision === "deny") {
      return Object.freeze({
        status: "denied",
        observation: refusalObservation(provenance.action, {
          status: "denied",
          code: "policy_denied",
          reason: "user_denied",
          nextAction: "choose_alternative",
        }),
      });
    }

    const grant = snapshot({
      schemaVersion: 1,
      approvalId: challenge.approvalId,
      actionId: provenance.action.actionId,
      actionHash: provenance.actionHash,
      normalizedRequestHash: provenance.normalizedRequestHash,
      preconditionHash: provenance.preconditionHash,
      policySnapshotHash: provenance.policySnapshotHash,
      displayedSummaryHash: provenance.displayedSummaryHash,
      grantedAt: responded.iso,
      expiresAt: challenge.expiresAt,
    }) as CapabilityApprovalGrant;
    const grantProvenance: ApprovalGrantProvenance = {
      ...provenance,
      grant,
      grantHash: canonicalSha256Hex(grant),
      grantedAtMs: responded.epochMs,
      grantConsumed: false,
    };
    this.#approvalGrants.set(grant, grantProvenance);
    return Object.freeze({ status: "granted", grant });
  }

  /**
   * Re-observes live preconditions inside the one-use execution call. Changed
   * state returns a bounded no-effect observation and never reaches the tool.
   */
  async executeAuthorized(
    authorization: AuthorizedCapabilityAction,
    context: CapabilityAuthorizedExecutionContext,
  ): Promise<CapabilityAuthorizedExecutionResult> {
    const provenance = this.#authorizationProvenance(authorization);
    if (provenance.authorizationConsumed) {
      throw invariant("A capability authorization may be executed only once.");
    }
    provenance.authorizationConsumed = true;
    const capturedContext = validateAuthorizedExecutionContext(context);
    assertNotAborted(capturedContext.signal);

    const beforeObservation = provenance.expiresAtMs === null
      ? null
      : readApprovalInstant(this.#approvalClock);
    if (
      beforeObservation !== null &&
      approvalExpired(provenance, beforeObservation.epochMs)
    ) {
      return staleApprovalExecution(provenance.action);
    }

    let currentUnknown: unknown;
    try {
      currentUnknown = await capturedContext.revalidate(
        provenance.action,
        Object.freeze({ signal: capturedContext.signal }),
      );
    } catch (error: unknown) {
      assertNotAborted(capturedContext.signal);
      if (isDomainError(error)) throw error;
      throw createDomainError({
        code: "action_failed",
        message: "Capability precondition revalidation failed.",
      });
    }
    assertNotAborted(capturedContext.signal);
    const current = normalizeObservedPreconditions(currentUnknown);
    const observedPreconditionHash = preconditionHashFor(current);
    if (observedPreconditionHash !== provenance.preconditionHash) {
      return Object.freeze({
        status: "stale",
        observation: refusalObservation(provenance.action, {
          status: "stale",
          code: "approval_invalid",
          reason: "preconditions_changed",
          nextAction: "reobserve_and_retry",
          expectedPreconditionHash: provenance.preconditionHash,
          observedPreconditionHash,
        }),
      });
    }

    if (beforeObservation !== null) {
      const afterObservation = readApprovalInstant(this.#approvalClock);
      if (
        afterObservation.epochMs < beforeObservation.epochMs ||
        approvalExpired(provenance, afterObservation.epochMs)
      ) {
        return staleApprovalExecution(provenance.action);
      }
    }
    assertNotAborted(capturedContext.signal);
    return Object.freeze({
      status: "executed",
      result: await this.#executeOperation(provenance, capturedContext.signal),
    });
  }

  async execute(
    evaluated: EvaluatedCapabilityAction,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecutionResult> {
    const provenance = this.#evaluatedProvenance(evaluated);
    if (provenance.consumed) {
      throw invariant("An evaluated capability action receipt may be consumed only once.");
    }
    if (provenance.decision.effect === "deny") {
      provenance.consumed = true;
      throw createDomainError({
        code: "policy_denied",
        message: "The pinned policy snapshot denied this capability action.",
        details: {
          actionId: provenance.action.actionId,
          policyVersionId: provenance.decision.policyVersionId,
          winningPolicyName: provenance.decision.winningPolicyName,
        },
      });
    }
    if (provenance.decision.effect === "require_approval") {
      throw createDomainError({
        code: "approval_required",
        message: "The pinned policy snapshot requires approval for this capability action.",
        details: {
          actionId: provenance.action.actionId,
          policyVersionId: provenance.decision.policyVersionId,
          winningPolicyName: provenance.decision.winningPolicyName,
        },
      });
    }
    provenance.consumed = true;
    const signal = validateExecutionContext(context);
    assertNotAborted(signal);
    return this.#executeOperation(provenance, signal);
  }

  async #executeOperation(
    provenance: PreparedProvenance,
    signal: AbortSignal,
  ): Promise<CapabilityExecutionResult> {
    let rawUnknown: unknown;
    try {
      rawUnknown = await provenance.operation.execute(
        provenance.action,
        Object.freeze({ signal }),
      );
    } catch (error: unknown) {
      if (isDomainError(error)) {
        throw error;
      }
      throw createDomainError({
        code: "action_failed",
        message: "The capability handler failed.",
      });
    }
    const raw = snapshotObject(
      rawUnknown,
      "Capability raw result",
      "invariant_violated",
    );
    assertByteBound(
      raw,
      "raw output",
      this.#maximumRawOutputBytes,
      "maximumRawOutputBytes",
    );
    const structurallyValidRaw = runCompiledValidation(
      provenance.operation.validateOutput,
      raw,
      "output",
    );

    let released: CapabilityReleasedViews;
    try {
      released = await provenance.operation.release(
        structurallyValidRaw,
        provenance.action,
      );
    } catch (error: unknown) {
      if (isDomainError(error)) {
        throw error;
      }
      throw createDomainError({
        code: "invariant_violated",
        message: "The capability output classifier failed unexpectedly.",
      });
    }
    const views = normalizeReleasedViews(
      released,
      provenance.operation.agentContextRelease,
      provenance.action,
      provenance.actionHash,
      structurallyValidRaw,
    );
    assertByteBound(
      views.audit,
      "audit view",
      this.#maximumReleasedViewBytes,
      "maximumReleasedViewBytes",
    );
    assertByteBound(
      views.human,
      "human view",
      this.#maximumReleasedViewBytes,
      "maximumReleasedViewBytes",
    );
    assertByteBound(
      views.agent,
      "agent view",
      this.#maximumReleasedViewBytes,
      "maximumReleasedViewBytes",
    );
    assertByteBound(
      views.agentContextRelease,
      "agent context-release descriptor",
      this.#maximumReleasedViewBytes,
      "maximumReleasedViewBytes",
    );
    assertByteBound(
      views,
      "combined released views",
      this.#maximumCombinedReleasedViewBytes,
      "maximumCombinedReleasedViewBytes",
    );
    return snapshot({ raw: structurallyValidRaw, ...views });
  }

  #evaluatedProvenance(
    evaluated: EvaluatedCapabilityAction,
  ): EvaluatedProvenance {
    const provenance = this.#evaluated.get(evaluated);
    if (
      provenance === undefined ||
      evaluated.prepared !== provenance.prepared ||
      evaluated.decision !== provenance.decision ||
      evaluated.policySnapshotHash !== provenance.policySnapshotHash ||
      provenance.prepared.action !== provenance.action ||
      provenance.prepared.actionHash !== provenance.actionHash ||
      canonicalSha256Hex(provenance.action) !== provenance.actionHash ||
      canonicalSha256Hex(provenance.decision) !== provenance.decisionHash ||
      policySnapshotHashFor(provenance.decision) !== provenance.policySnapshotHash
    ) {
      throw invariant(
        "Capability authorization requires this gateway's evaluated action receipt.",
      );
    }
    return provenance;
  }

  #approvalChallengeProvenance(
    challenge: CapabilityApprovalChallenge,
  ): ApprovalChallengeProvenance {
    const provenance = this.#approvalChallenges.get(challenge);
    if (
      provenance === undefined ||
      provenance.challenge !== challenge ||
      canonicalSha256Hex(challenge) !== provenance.challengeHash ||
      canonicalSha256Hex(provenance.action) !== provenance.actionHash ||
      canonicalSha256Hex(provenance.decision) !== provenance.decisionHash ||
      normalizedRequestHashFor(provenance.action) !==
        provenance.normalizedRequestHash ||
      preconditionHashFor(provenance.action.preconditions) !==
        provenance.preconditionHash ||
      policySnapshotHashFor(provenance.decision) !==
        provenance.policySnapshotHash ||
      challenge.policySnapshotHash !== provenance.policySnapshotHash ||
      canonicalSha256Hex(challenge.displayedSummary) !==
        provenance.displayedSummaryHash
    ) {
      throw invariant(
        "Approval resolution requires this gateway's exact challenge object.",
      );
    }
    return provenance;
  }

  #authorizeGrant(
    grant: CapabilityApprovalGrant,
    provenance: ApprovalGrantProvenance,
  ): CapabilityAuthorizationResult {
    if (
      provenance.grant !== grant ||
      canonicalSha256Hex(grant) !== provenance.grantHash ||
      grant.approvalId !== provenance.challenge.approvalId ||
      grant.actionId !== provenance.action.actionId ||
      grant.actionHash !== provenance.actionHash ||
      grant.normalizedRequestHash !== provenance.normalizedRequestHash ||
      grant.preconditionHash !== provenance.preconditionHash ||
      grant.policySnapshotHash !== provenance.policySnapshotHash ||
      grant.displayedSummaryHash !== provenance.displayedSummaryHash ||
      canonicalSha256Hex(provenance.decision) !== provenance.decisionHash
    ) {
      throw invariant(
        "Capability authorization requires this gateway's exact approval grant.",
      );
    }
    if (provenance.grantConsumed) {
      throw invariant("An approval grant may authorize only once.");
    }
    provenance.grantConsumed = true;
    const now = readApprovalInstant(this.#approvalClock);
    if (now.epochMs < provenance.grantedAtMs) {
      throw approvalInvalid("The approval clock moved before the grant time.");
    }
    if (now.epochMs >= provenance.expiresAtMs) {
      return Object.freeze({
        status: "stale",
        observation: refusalObservation(provenance.action, {
          status: "stale",
          code: "approval_invalid",
          reason: "approval_expired",
          nextAction: "request_fresh_approval",
        }),
      });
    }
    return Object.freeze({
      status: "authorized",
      authorization: this.#issueAuthorization(provenance, {
        source: "approval",
        approvalId: grant.approvalId,
        grantedAtMs: provenance.grantedAtMs,
        expiresAtMs: provenance.expiresAtMs,
      }),
    });
  }

  #issueAuthorization(
    provenance: EvaluatedProvenance,
    input: {
      readonly source: "policy" | "approval";
      readonly approvalId: ApprovalId | null;
      readonly grantedAtMs: number | null;
      readonly expiresAtMs: number | null;
    },
  ): AuthorizedCapabilityAction {
    const authorization = snapshot({
      schemaVersion: 1,
      actionId: provenance.action.actionId,
      actionHash: provenance.actionHash,
      source: input.source,
      approvalId: input.approvalId,
    }) as AuthorizedCapabilityAction;
    this.#authorizations.set(authorization, {
      operation: provenance.operation,
      action: provenance.action,
      actionHash: provenance.actionHash,
      authorization,
      authorizationHash: canonicalSha256Hex(authorization),
      decision: provenance.decision,
      decisionHash: provenance.decisionHash,
      preconditionHash: preconditionHashFor(provenance.action.preconditions),
      approvalId: input.approvalId,
      grantedAtMs: input.grantedAtMs,
      expiresAtMs: input.expiresAtMs,
      authorizationConsumed: false,
    });
    return authorization;
  }

  #authorizationProvenance(
    authorization: AuthorizedCapabilityAction,
  ): AuthorizationProvenance {
    const provenance = this.#authorizations.get(authorization);
    if (
      provenance === undefined ||
      provenance.authorization !== authorization ||
      canonicalSha256Hex(authorization) !== provenance.authorizationHash ||
      authorization.actionId !== provenance.action.actionId ||
      authorization.actionHash !== provenance.actionHash ||
      authorization.approvalId !== provenance.approvalId ||
      canonicalSha256Hex(provenance.action) !== provenance.actionHash ||
      canonicalSha256Hex(provenance.decision) !== provenance.decisionHash ||
      preconditionHashFor(provenance.action.preconditions) !==
        provenance.preconditionHash
    ) {
      throw invariant(
        "Capability execution requires this gateway's exact authorization object.",
      );
    }
    return provenance;
  }

  #preparedProvenance(prepared: PreparedCapabilityAction): PreparedProvenance {
    const provenance = this.#prepared.get(prepared);
    if (
      provenance === undefined ||
      prepared.action !== provenance.action ||
      prepared.actionHash !== provenance.actionHash ||
      canonicalSha256Hex(provenance.action) !== provenance.actionHash
    ) {
      throw invariant(
        "Policy evaluation requires this gateway's exact prepared action object.",
      );
    }
    return provenance;
  }
}

function capturePinnedPolicyEvaluator(
  value: PinnedPolicyEvaluator,
): CapturedPolicyEvaluator {
  try {
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      isProxy(value)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== "policyVersionId" && key !== "evaluate")
    ) {
      throw new TypeError();
    }
    const idDescriptor = Object.getOwnPropertyDescriptor(value, "policyVersionId");
    const evaluateDescriptor = Object.getOwnPropertyDescriptor(value, "evaluate");
    if (
      idDescriptor === undefined || !("value" in idDescriptor) ||
      idDescriptor.enumerable !== true ||
      !PolicyVersionIdKind.is(idDescriptor.value) ||
      evaluateDescriptor === undefined || !("value" in evaluateDescriptor) ||
      evaluateDescriptor.enumerable !== true ||
      typeof evaluateDescriptor.value !== "function"
    ) {
      throw new TypeError();
    }
    const policyVersionId = idDescriptor.value;
    if (isProxy(evaluateDescriptor.value)) {
      throw new TypeError();
    }
    const evaluate = evaluateDescriptor.value as PinnedPolicyEvaluator["evaluate"];
    const captured: CapturedPolicyEvaluator = {
      policyVersionId,
      evaluate(action: NormalizedAction): PolicyDecision {
        return Reflect.apply(evaluate, captured, [action]) as PolicyDecision;
      },
    };
    return Object.freeze(captured);
  } catch {
    throw invalidInput(
      "The capability gateway requires one descriptor-safe pinned policy evaluator.",
    );
  }
}

function normalizePolicyDecision(
  value: unknown,
  expectedPolicyVersionId: PolicyDecision["policyVersionId"],
): PolicyDecision {
  const detached = snapshotObject(
    value,
    "Policy decision",
    "invariant_violated",
  );
  if (!hasExactKeys(detached, [
    "policyVersionId",
    "effect",
    "winningPolicyName",
    "reason",
    "matchedPolicyNames",
    "trace",
  ])) {
    throw new TypeError("invalid policy decision envelope");
  }
  const policyVersionId = detached["policyVersionId"];
  const effect = detached["effect"];
  const winningPolicyName = detached["winningPolicyName"];
  const reason = detached["reason"];
  const rawMatchedPolicyNames = detached["matchedPolicyNames"];
  const rawTrace = detached["trace"];
  if (
    !PolicyVersionIdKind.is(policyVersionId) ||
    policyVersionId !== expectedPolicyVersionId ||
    !isPolicyEffect(effect) ||
    !isNullableNonEmptyString(winningPolicyName) ||
    typeof reason !== "string" || reason.trim().length === 0 ||
    !Array.isArray(rawMatchedPolicyNames) ||
    !rawMatchedPolicyNames.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    ) ||
    new Set(rawMatchedPolicyNames).size !== rawMatchedPolicyNames.length ||
    !isPlainRecord(rawTrace)
  ) {
    throw new TypeError("invalid policy decision fields");
  }
  const matchedPolicyNames = Object.freeze([...rawMatchedPolicyNames]);
  if (
    (winningPolicyName === null) !== (matchedPolicyNames.length === 0) ||
    (winningPolicyName !== null &&
      matchedPolicyNames[0] !== winningPolicyName)
  ) {
    throw new TypeError("winning policy is inconsistent with matched policies");
  }
  const trace = normalizePolicyTrace(
    rawTrace,
    effect,
    winningPolicyName,
    matchedPolicyNames,
  );
  return Object.freeze({
    policyVersionId,
    effect,
    winningPolicyName,
    reason,
    matchedPolicyNames,
    trace,
  });
}

function normalizePolicyTrace(
  trace: Readonly<Record<string, unknown>>,
  effect: PolicyEffect,
  winningPolicyName: string | null,
  matchedPolicyNames: readonly string[],
): JsonObject {
  if (!hasExactKeys(trace, [
    "languageVersion",
    "policyContentHash",
    "attributeCatalogs",
    "combiningAlgorithm",
    "defaultEffect",
    "result",
    "winningPolicyName",
    "evaluations",
    "matchedPolicyNames",
  ])) {
    throw new TypeError("invalid policy trace envelope");
  }
  const traceMatches = trace["matchedPolicyNames"];
  if (
    trace["languageVersion"] !== "1" ||
    typeof trace["policyContentHash"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(trace["policyContentHash"]) ||
    !Array.isArray(trace["attributeCatalogs"]) ||
    trace["combiningAlgorithm"] !== "deny_overrides" ||
    !isPolicyEffect(trace["defaultEffect"]) ||
    (winningPolicyName === null && trace["defaultEffect"] !== effect) ||
    trace["result"] !== effect ||
    trace["winningPolicyName"] !== winningPolicyName ||
    !Array.isArray(trace["evaluations"]) ||
    !Array.isArray(traceMatches) ||
    traceMatches.length !== matchedPolicyNames.length ||
    !traceMatches.every((entry, index) => entry === matchedPolicyNames[index])
  ) {
    throw new TypeError("policy trace does not bind its decision");
  }
  return trace as JsonObject;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function isPolicyEffect(value: unknown): value is PolicyEffect {
  return value === "allow" || value === "deny" || value === "require_approval";
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}

function policyEvaluationFailure(message: string) {
  return createDomainError({
    code: "policy_denied",
    message,
    details: { reason: "policy_evaluation_error" },
  });
}

function validateProposalEnvelope(
  proposal: CapabilityActionProposal,
): CapabilityActionProposal {
  const detached = snapshotObject(proposal, "Capability action proposal");
  const expected = [
    "schemaVersion",
    "packId",
    "packVersion",
    "operationId",
    "operationVersion",
    "input",
  ];
  const keys = Object.keys(detached);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(detached, key))
  ) {
    throw invalidInput("A capability action proposal has unknown or missing properties.");
  }
  const schemaVersion = detached["schemaVersion"];
  const packId = detached["packId"];
  const packVersion = detached["packVersion"];
  const operationId = detached["operationId"];
  const operationVersion = detached["operationVersion"];
  if (schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw invalidInput("The capability action proposal schema version is unsupported.");
  }
  validateNonEmpty(packId, "packId");
  validatePositive(packVersion, "packVersion");
  validateNonEmpty(operationId, "operationId");
  validatePositive(operationVersion, "operationVersion");
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    packId,
    packVersion,
    operationId,
    operationVersion,
    input: detached["input"],
  });
}

function normalizeContext(
  context: CapabilityNormalizationContext,
): CapabilityNormalizationContext {
  const detached = snapshotObject(context, "Capability normalization context");
  const expected = ["actionId", "subject", "environment"];
  const keys = Object.keys(detached);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(detached, key))
  ) {
    throw invalidInput("A normalization context has unknown or missing properties.");
  }
  const rawActionId = detached["actionId"];
  if (typeof rawActionId !== "string") {
    throw invalidInput("A capability normalization context has an invalid actionId.");
  }
  const actionId = ActionIdKind.parse(rawActionId);
  return Object.freeze({
    actionId,
    subject: snapshotObject(detached["subject"], "Capability subject"),
    environment: snapshotObject(
      detached["environment"],
      "Capability environment",
    ),
  });
}

function normalizeSemanticResult(
  value: CapabilitySemanticNormalization,
): CapabilitySemanticNormalization {
  if (!isPlainRecord(value)) {
    throw invariant("A semantic normalizer must return an object.");
  }
  const expected = ["normalizedInput", "resource", "request", "preconditions"];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    !Array.isArray(value.preconditions)
  ) {
    throw invariant("A semantic normalizer returned an incomplete result.");
  }
  const preconditions = value.preconditions.map(normalizePrecondition);
  return Object.freeze({
    normalizedInput: snapshotObject(
      value.normalizedInput,
      "Normalized capability input",
      "invariant_violated",
    ),
    resource: snapshotObject(
      value.resource,
      "Normalized capability resource",
      "invariant_violated",
    ),
    request: snapshotObject(
      value.request,
      "Normalized capability request",
      "invariant_violated",
    ),
    preconditions: Object.freeze(preconditions),
  });
}

function normalizePrecondition(value: ActionPrecondition): ActionPrecondition {
  if (!isPlainRecord(value)) {
    throw invariant("An action precondition must be an object.");
  }
  const expected = [
    "preconditionType",
    "preconditionVersion",
    "attributes",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invariant("An action precondition has unknown or missing properties.");
  }
  if (
    typeof value.preconditionType !== "string" ||
    value.preconditionType.trim().length === 0 ||
    !Number.isSafeInteger(value.preconditionVersion) ||
    value.preconditionVersion < 1
  ) {
    throw invariant("An action precondition has an invalid type or version.");
  }
  return Object.freeze({
    preconditionType: value.preconditionType,
    preconditionVersion: value.preconditionVersion,
    attributes: snapshotObject(
      value.attributes,
      "Action precondition attributes",
      "invariant_violated",
    ),
  });
}

function normalizeReleasedViews(
  value: CapabilityReleasedViews,
  definition: CapabilityAgentContextReleaseDefinition,
  action: NormalizedAction,
  actionHash: string,
  rawResult: JsonObject,
): {
  readonly audit: JsonObject;
  readonly human: JsonObject;
  readonly agent: JsonObject;
  readonly agentContextRelease: CapabilityAgentContextReleaseDescriptor;
} {
  const fields = readExactInvariantDataProperties(
    value,
    ["audit", "human", "agent", "agentContextRelease"],
    "capability release classifier result",
  );
  const agent = snapshotObject(
    fields["agent"],
    "Capability agent view",
    "invariant_violated",
  );
  return Object.freeze({
    audit: snapshotObject(
      fields["audit"],
      "Capability audit view",
      "invariant_violated",
    ),
    human: snapshotObject(
      fields["human"],
      "Capability human view",
      "invariant_violated",
    ),
    agent,
    agentContextRelease: normalizeAgentContextReleaseClaim(
      fields["agentContextRelease"] as CapabilityAgentContextReleaseClaim,
      definition,
      action,
      actionHash,
      rawResult,
      agent,
    ),
  });
}

function normalizeAgentContextReleaseClaim(
  value: CapabilityAgentContextReleaseClaim,
  definition: CapabilityAgentContextReleaseDefinition,
  action: NormalizedAction,
  actionHash: string,
  rawResult: JsonObject,
  agentView: JsonObject,
): CapabilityAgentContextReleaseDescriptor {
  const claim = readExactInvariantDataProperties(
    value,
    ["descriptor", "binding"],
    "capability agent-context release claim",
  );
  const descriptor = normalizeAgentContextReleaseDescriptor(
    claim["descriptor"],
    definition,
    action,
  );
  const binding = readExactInvariantDataProperties(
    claim["binding"],
    [
      "schemaVersion",
      "normalizedActionHash",
      "rawResultHash",
      "agentViewHash",
      "descriptorHash",
    ],
    "capability agent-context release binding",
  );
  if (
    binding["schemaVersion"] !== CONTRACT_SCHEMA_VERSION ||
    binding["normalizedActionHash"] !== actionHash ||
    binding["rawResultHash"] !== canonicalSha256Hex(rawResult) ||
    binding["agentViewHash"] !== canonicalSha256Hex(agentView) ||
    binding["descriptorHash"] !== canonicalSha256Hex(descriptor)
  ) {
    throw invariant(
      "A capability agent-context release claim is not bound to the exact action and result.",
    );
  }
  return descriptor;
}

function normalizeAgentContextReleaseDescriptor(
  value: unknown,
  definition: CapabilityAgentContextReleaseDefinition,
  action: NormalizedAction,
): CapabilityAgentContextReleaseDescriptor {
  const fields = readExactInvariantDataProperties(
    value,
    [
      "schemaVersion",
      "sourceVersion",
      "resource",
      "policyProjection",
      "classification",
      "reason",
    ],
    "capability agent-context release descriptor",
  );
  if (fields["schemaVersion"] !== CONTRACT_SCHEMA_VERSION) {
    throw invariant(
      "A capability agent-context release descriptor has an unsupported schema version.",
    );
  }
  const resource = normalizeReleaseResource(fields["resource"]);
  const policyProjection = normalizeReleasePolicyProjection(
    fields["policyProjection"],
  );
  if (
    fields["sourceVersion"] !== definition.sourceVersion ||
    fields["classification"] !== definition.classification ||
    fields["reason"] !== definition.reason ||
    policyProjection.catalogId !== definition.catalogId ||
    policyProjection.catalogVersion !== definition.catalogVersion ||
    policyProjection.catalogContentHash !== definition.catalogContentHash
  ) {
    throw invariant(
      "A capability agent-context release descriptor does not match its installed operation definition.",
    );
  }
  if (
    resource.classification !== definition.classification ||
    resource.mediaType !== "application/json"
  ) {
    throw invariant(
      "A capability agent-context release resource has inconsistent classification or media type.",
    );
  }
  assertReleaseMetadataBoundToAction(resource, policyProjection, action);
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceVersion: definition.sourceVersion,
    resource,
    policyProjection,
    classification: definition.classification,
    reason: definition.reason,
  });
}

function normalizeReleaseResource(value: unknown): ResourceRef {
  try {
    return parseResourceRef(value);
  } catch {
    throw invariant("A capability agent-context release resource is malformed.");
  }
}

function normalizeReleasePolicyProjection(
  value: unknown,
): CapabilityContextPolicyProjection {
  const fields = readExactInvariantDataProperties(
    value,
    [
      "schemaVersion",
      "catalogId",
      "catalogVersion",
      "catalogContentHash",
      "resourceAttributes",
      "requestAttributes",
    ],
    "capability context-policy projection",
  );
  if (
    fields["schemaVersion"] !== CONTRACT_SCHEMA_VERSION ||
    typeof fields["catalogId"] !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(fields["catalogId"]) ||
    fields["catalogId"] === "guard.base" ||
    fields["catalogId"] === "guard.context" ||
    typeof fields["catalogVersion"] !== "number" ||
    !Number.isSafeInteger(fields["catalogVersion"]) ||
    fields["catalogVersion"] < 1 ||
    typeof fields["catalogContentHash"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(fields["catalogContentHash"])
  ) {
    throw invariant("A capability context-policy projection identity is malformed.");
  }
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    catalogId: fields["catalogId"],
    catalogVersion: fields["catalogVersion"],
    catalogContentHash: fields["catalogContentHash"],
    resourceAttributes: snapshotObject(
      fields["resourceAttributes"],
      "Capability context-policy resource attributes",
      "invariant_violated",
    ),
    requestAttributes: snapshotObject(
      fields["requestAttributes"],
      "Capability context-policy request attributes",
      "invariant_violated",
    ),
  });
}

const RESERVED_CONTEXT_RESOURCE_ATTRIBUTES = new Set([
  "scheme",
  "sourceId",
  "classification",
  "mediaType",
  "kind",
]);
const RESERVED_CONTEXT_REQUEST_ATTRIBUTES = new Set([
  "intent",
  "reason",
  "turnId",
  "resourceBytes",
  "selectedBytes",
  "sourceBytes",
  "truncated",
  "secretCategories",
  "promptInjectionTags",
]);

function assertReleaseMetadataBoundToAction(
  resource: ResourceRef,
  projection: CapabilityContextPolicyProjection,
  action: NormalizedAction,
): void {
  if (
    resource.scheme !== action.resource["scheme"] ||
    resource.sourceId !== action.resource["sourceId"] ||
    resource.classification !== action.resource["classification"] ||
    Object.keys(resource.locator).length === 0
  ) {
    throw invariant(
      "A capability agent-context release resource is not bound to the normalized action.",
    );
  }
  assertBoundProjectionAttributes(
    projection.resourceAttributes,
    action.resource,
    resource.locator,
    RESERVED_CONTEXT_RESOURCE_ATTRIBUTES,
    "resource",
  );
  assertBoundProjectionAttributes(
    projection.requestAttributes,
    action.request,
    null,
    RESERVED_CONTEXT_REQUEST_ATTRIBUTES,
    "request",
  );
  for (const [key, locatorValue] of Object.entries(resource.locator)) {
    const actionValue = action.resource[key];
    const projectionValue = projection.resourceAttributes[key];
    const expectedValue = actionValue ?? projectionValue;
    if (
      expectedValue === undefined ||
      canonicalSha256Hex(expectedValue) !== canonicalSha256Hex(locatorValue)
    ) {
      throw invariant(
        "A capability agent-context resource locator is not bound to action metadata.",
      );
    }
  }
}

function assertBoundProjectionAttributes(
  attributes: JsonObject,
  actionAttributes: JsonObject,
  locator: JsonObject | null,
  reserved: ReadonlySet<string>,
  section: "resource" | "request",
): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (reserved.has(key)) {
      throw invariant(
        `A capability context-policy ${section} projection shadows broker metadata.`,
      );
    }
    const actionValue = actionAttributes[key];
    const locatorValue = locator?.[key];
    const expectedValue = actionValue ?? locatorValue;
    if (
      expectedValue === undefined ||
      canonicalSha256Hex(expectedValue) !== canonicalSha256Hex(value)
    ) {
      throw invariant(
        `A capability context-policy ${section} projection is not bound to the normalized action.`,
      );
    }
  }
}

function readExactInvariantDataProperties(
  value: unknown,
  expected: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string") ||
      expected.some((key) => !keys.includes(key))
    ) {
      throw new TypeError();
    }
    const captured: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError();
      }
      Object.defineProperty(captured, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(captured);
  } catch {
    throw invariant(`The ${label} must contain exact enumerable data properties.`);
  }
}

function normalizeApprovalChallengeInput(
  value: CapabilityApprovalChallengeInput,
  defaultLifetimeMs: number,
  maximumLifetimeMs: number,
): { readonly displayedSummary: JsonObject; readonly lifetimeMs: number } {
  const detached = snapshotObject(value, "Capability approval challenge input");
  if (
    !hasExactOptionalKeys(
      detached,
      ["displayedSummary"],
      ["lifetimeMs"],
    ) ||
    !isPlainRecord(detached["displayedSummary"])
  ) {
    throw invalidInput(
      "An approval challenge requires one displayed summary and an optional lifetime.",
    );
  }
  const lifetimeMs = Object.hasOwn(detached, "lifetimeMs")
    ? detached["lifetimeMs"]
    : defaultLifetimeMs;
  if (
    typeof lifetimeMs !== "number" ||
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1 ||
    lifetimeMs > maximumLifetimeMs
  ) {
    throw invalidInput(
      "Approval lifetime must be a positive safe integer within the configured maximum.",
    );
  }
  return Object.freeze({
    displayedSummary: snapshotObject(
      detached["displayedSummary"],
      "Capability approval displayed summary",
    ),
    lifetimeMs,
  });
}

function normalizeApprovalResponse(
  value: CapabilityApprovalResponse,
): CapabilityApprovalResponse {
  let detached: JsonObject;
  try {
    detached = snapshotObject(value, "Capability approval response");
  } catch {
    throw approvalInvalid("The approval response is malformed.");
  }
  if (
    !hasExactKeys(detached, [
      "schemaVersion",
      "approvalId",
      "decision",
      "normalizedRequestHash",
      "preconditionHash",
      "policySnapshotHash",
      "displayedSummaryHash",
    ]) ||
    detached["schemaVersion"] !== 1 ||
    !ApprovalIdKind.is(detached["approvalId"]) ||
    (detached["decision"] !== "allow_once" &&
      detached["decision"] !== "deny") ||
    !isSha256(detached["normalizedRequestHash"]) ||
    !isSha256(detached["preconditionHash"]) ||
    !isSha256(detached["policySnapshotHash"]) ||
    !isSha256(detached["displayedSummaryHash"])
  ) {
    throw approvalInvalid("The approval response is malformed.");
  }
  return Object.freeze({
    schemaVersion: 1,
    approvalId: detached["approvalId"],
    decision: detached["decision"],
    normalizedRequestHash: detached["normalizedRequestHash"],
    preconditionHash: detached["preconditionHash"],
    policySnapshotHash: detached["policySnapshotHash"],
    displayedSummaryHash: detached["displayedSummaryHash"],
  });
}

function normalizedRequestHashFor(action: NormalizedAction): string {
  return canonicalSha256Hex({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    capabilityPackId: action.capabilityPackId,
    capabilityPackVersion: action.capabilityPackVersion,
    operationId: action.operationId,
    operationVersion: action.operationVersion,
    subject: action.subject,
    resource: action.resource,
    environment: action.environment,
    request: action.request,
    normalizedInput: action.normalizedInput,
    sideEffectClass: action.sideEffectClass,
  });
}

function preconditionHashFor(
  preconditions: readonly ActionPrecondition[],
): string {
  return canonicalSha256Hex({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    preconditions,
  });
}

function policySnapshotHashFor(decision: PolicyDecision): string {
  return canonicalSha256Hex({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    policyVersionId: decision.policyVersionId,
    policyContentHash: decision.trace["policyContentHash"]!,
    decision,
  });
}

function refusalObservation(
  action: NormalizedAction,
  input: {
    readonly status: "denied" | "stale";
    readonly code: "policy_denied" | "approval_invalid";
    readonly reason:
      | "policy_denied"
      | "user_denied"
      | "approval_expired"
      | "preconditions_changed";
    readonly nextAction:
      | "choose_alternative"
      | "request_fresh_approval"
      | "reobserve_and_retry";
    readonly expectedPreconditionHash?: string;
    readonly observedPreconditionHash?: string;
  },
): JsonObject {
  return snapshot({
    schemaVersion: 1,
    status: input.status,
    code: input.code,
    reason: input.reason,
    effectOccurred: false,
    actionId: action.actionId,
    capabilityPackId: action.capabilityPackId,
    capabilityPackVersion: action.capabilityPackVersion,
    operationId: action.operationId,
    operationVersion: action.operationVersion,
    nextAction: input.nextAction,
    ...(input.expectedPreconditionHash === undefined
      ? {}
      : { expectedPreconditionHash: input.expectedPreconditionHash }),
    ...(input.observedPreconditionHash === undefined
      ? {}
      : { observedPreconditionHash: input.observedPreconditionHash }),
  });
}

function staleApprovalExecution(
  action: NormalizedAction,
): CapabilityAuthorizedExecutionResult {
  return Object.freeze({
    status: "stale",
    observation: refusalObservation(action, {
      status: "stale",
      code: "approval_invalid",
      reason: "approval_expired",
      nextAction: "request_fresh_approval",
    }),
  });
}

function approvalExpired(
  provenance: AuthorizationProvenance,
  nowMs: number,
): boolean {
  if (provenance.expiresAtMs === null) return false;
  if (
    provenance.grantedAtMs === null ||
    nowMs < provenance.grantedAtMs
  ) {
    throw approvalInvalid("The approval clock moved before the grant time.");
  }
  return nowMs >= provenance.expiresAtMs;
}

function readApprovalInstant(
  clock: CapabilityApprovalClock,
): { readonly iso: string; readonly epochMs: number } {
  try {
    const value = clock.now();
    if (typeof value !== "string" || value.length > 64) throw new TypeError();
    const instant = new Date(value);
    const epochMs = instant.valueOf();
    if (
      !Number.isSafeInteger(epochMs) ||
      Number.isNaN(epochMs) ||
      instant.toISOString() !== value
    ) {
      throw new TypeError();
    }
    return Object.freeze({ iso: value, epochMs });
  } catch {
    throw createDomainError({
      code: "infrastructure_failed",
      message: "The approval clock returned an invalid timestamp.",
    });
  }
}

function readApprovalId(source: CapabilityApprovalIdSource): ApprovalId {
  try {
    const value = source.nextApprovalId();
    if (!ApprovalIdKind.is(value)) throw new TypeError();
    return value;
  } catch {
    throw createDomainError({
      code: "infrastructure_failed",
      message: "The approval identifier source returned an invalid identifier.",
    });
  }
}

function validateAuthorizedExecutionContext(
  context: CapabilityAuthorizedExecutionContext,
): {
  readonly signal: AbortSignal;
  readonly revalidate: CapabilityAuthorizedExecutionContext["revalidate"];
} {
  try {
    if (
      typeof context !== "object" ||
      context === null ||
      Array.isArray(context) ||
      isProxy(context)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(context);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const keys = Reflect.ownKeys(context);
    if (
      keys.length !== 2 ||
      !keys.includes("signal") ||
      !keys.includes("revalidate")
    ) {
      throw new TypeError();
    }
    const signalDescriptor = Object.getOwnPropertyDescriptor(context, "signal");
    const revalidateDescriptor = Object.getOwnPropertyDescriptor(
      context,
      "revalidate",
    );
    if (
      signalDescriptor === undefined ||
      !("value" in signalDescriptor) ||
      signalDescriptor.enumerable !== true ||
      !(signalDescriptor.value instanceof AbortSignal) ||
      revalidateDescriptor === undefined ||
      !("value" in revalidateDescriptor) ||
      revalidateDescriptor.enumerable !== true ||
      typeof revalidateDescriptor.value !== "function" ||
      isProxy(revalidateDescriptor.value)
    ) {
      throw new TypeError();
    }
    readAbortState(signalDescriptor.value);
    return Object.freeze({
      signal: signalDescriptor.value,
      revalidate: Function.prototype.bind.call(
        revalidateDescriptor.value,
        context,
      ) as CapabilityAuthorizedExecutionContext["revalidate"],
    });
  } catch {
    throw invalidInput(
      "An authorized execution context requires exact signal and revalidate ports.",
    );
  }
}

function normalizeObservedPreconditions(
  value: unknown,
): readonly ActionPrecondition[] {
  let detached: JsonObject;
  try {
    detached = snapshotObject(
      { preconditions: value },
      "Observed capability preconditions",
      "invariant_violated",
    );
  } catch {
    throw invariant("A capability revalidator returned invalid preconditions.");
  }
  const values = detached["preconditions"];
  if (!Array.isArray(values)) {
    throw invariant("A capability revalidator must return an array of preconditions.");
  }
  return Object.freeze(
    values.map((entry) => normalizePrecondition(entry as ActionPrecondition)),
  );
}

function hasExactOptionalKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => allowed.has(key))
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validateExecutionContext(
  context: CapabilityExecutionContext,
): AbortSignal {
  try {
    if (typeof context !== "object" || context === null) {
      throw new TypeError("not an object");
    }
    const keys = Reflect.ownKeys(context);
    const descriptor = Object.getOwnPropertyDescriptor(context, "signal");
    if (
      keys.length !== 1 ||
      keys[0] !== "signal" ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !(descriptor.value instanceof AbortSignal)
    ) {
      throw new TypeError("not an exact signal data property");
    }
    readAbortState(descriptor.value);
    return descriptor.value;
  } catch {
    throw invalidInput("A capability execution context requires an AbortSignal.");
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (readAbortState(signal)) {
    throw createDomainError({
      code: "cancelled",
      message: "Capability dispatch was cancelled before execution.",
    });
  }
}

function readAbortState(signal: AbortSignal): boolean {
  try {
    const getter = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    )?.get;
    if (getter === undefined) {
      throw new TypeError("AbortSignal aborted getter is unavailable");
    }
    return getter.call(signal) as boolean;
  } catch {
    throw invalidInput("A capability execution context requires an AbortSignal.");
  }
}

function normalizeGatewayOptions(
  options: CapabilityGatewayOptions,
): CapabilityGatewayConfiguration {
  const allowed = new Set([
    "maximumInputBytes",
    "maximumRawOutputBytes",
    "maximumReleasedViewBytes",
    "maximumCombinedReleasedViewBytes",
    "approvalClock",
    "approvalIdSource",
    "defaultApprovalLifetimeMs",
    "maximumApprovalLifetimeMs",
  ]);
  const detached = inspectGatewayOptions(options, allowed);
  const maximumApprovalLifetimeMs = positiveOption(
    detached,
    "maximumApprovalLifetimeMs",
    DEFAULT_MAXIMUM_APPROVAL_LIFETIME_MS,
  );
  const defaultApprovalLifetimeMs = positiveOption(
    detached,
    "defaultApprovalLifetimeMs",
    Math.min(DEFAULT_APPROVAL_LIFETIME_MS, maximumApprovalLifetimeMs),
  );
  if (defaultApprovalLifetimeMs > maximumApprovalLifetimeMs) {
    throw invalidInput(
      "defaultApprovalLifetimeMs cannot exceed maximumApprovalLifetimeMs.",
    );
  }
  return Object.freeze({
    maximumInputBytes: positiveOption(
      detached,
      "maximumInputBytes",
      DEFAULT_GATEWAY_LIMITS.maximumInputBytes,
    ),
    maximumRawOutputBytes: positiveOption(
      detached,
      "maximumRawOutputBytes",
      DEFAULT_GATEWAY_LIMITS.maximumRawOutputBytes,
    ),
    maximumReleasedViewBytes: positiveOption(
      detached,
      "maximumReleasedViewBytes",
      DEFAULT_GATEWAY_LIMITS.maximumReleasedViewBytes,
    ),
    maximumCombinedReleasedViewBytes: positiveOption(
      detached,
      "maximumCombinedReleasedViewBytes",
      DEFAULT_GATEWAY_LIMITS.maximumCombinedReleasedViewBytes,
    ),
    approvalClock: captureApprovalClock(
      detached["approvalClock"] ?? SYSTEM_APPROVAL_CLOCK,
    ),
    approvalIdSource: captureApprovalIdSource(
      detached["approvalIdSource"] ?? SYSTEM_APPROVAL_ID_SOURCE,
    ),
    defaultApprovalLifetimeMs,
    maximumApprovalLifetimeMs,
  });
}

function positiveOption(
  options: Readonly<Record<string, unknown>>,
  field: string,
  fallback: number,
): number {
  if (!Object.hasOwn(options, field)) return fallback;
  const value = options[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidInput(`${field} must be a positive safe integer.`);
  }
  return value;
}

function inspectGatewayOptions(
  value: CapabilityGatewayOptions,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key))
    ) {
      throw new TypeError();
    }
    const captured: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError();
      }
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    throw invalidInput(
      "Capability gateway options contain an unknown or unsafe property.",
    );
  }
}

function captureApprovalClock(value: unknown): CapabilityApprovalClock {
  const method = captureExactPortMethod(value, "now", "approval clock");
  return Object.freeze({ now: method as CapabilityApprovalClock["now"] });
}

function captureApprovalIdSource(value: unknown): CapabilityApprovalIdSource {
  const method = captureExactPortMethod(
    value,
    "nextApprovalId",
    "approval identifier source",
  );
  return Object.freeze({
    nextApprovalId: method as CapabilityApprovalIdSource["nextApprovalId"],
  });
}

function captureExactPortMethod(
  value: unknown,
  name: string,
  label: string,
): (...args: readonly unknown[]) => unknown {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const keys = Reflect.ownKeys(value);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      keys.length !== 1 ||
      keys[0] !== name ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "function" ||
      isProxy(descriptor.value)
    ) {
      throw new TypeError();
    }
    return Function.prototype.bind.call(
      descriptor.value,
      value,
    ) as (...args: readonly unknown[]) => unknown;
  } catch {
    throw invalidInput(`The ${label} must provide one exact trusted method.`);
  }
}

function assertByteBound(
  value: unknown,
  boundary: string,
  maximumBytes: number,
  maximumField: keyof CapabilityGatewayLimits,
): void {
  const observedBytes = canonicalBytes(value).byteLength;
  if (observedBytes > maximumBytes) {
    throw createDomainError({
      code: "budget_exceeded",
      message: `Capability ${boundary} exceeds the gateway byte bound.`,
      details: { boundary, [maximumField]: maximumBytes, observedBytes },
    });
  }
}

function validateNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput(`${field} must be a non-empty string.`);
  }
}

function validatePositive(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidInput(`${field} must be a positive safe integer.`);
  }
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}

function approvalInvalid(message: string) {
  return createDomainError({ code: "approval_invalid", message });
}

function invariant(message: string) {
  return createDomainError({ code: "invariant_violated", message });
}
