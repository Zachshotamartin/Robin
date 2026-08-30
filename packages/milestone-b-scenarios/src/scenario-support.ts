import type {
  AgentDriver,
  AgentDriverEvent,
  AgentTurnRequest,
  ScriptedAgentDriverScript,
} from "@guard/agent-driver";
import {
  CapabilityGateway,
  CapabilityPackRegistry,
  type CapabilityPack,
} from "@guard/capability-gateway";
import {
  BrokerContextSourceRegistry,
  CONTEXT_POLICY_ATTRIBUTE_CATALOG,
  MEMORY_POLICY_ATTRIBUTE_CATALOG,
  createContextBrokerIntegrationFactory,
  createContextReleasePolicySnapshot,
  createPinnedContextPolicyAdapter,
  type BrokerContextSource,
  type ContextBrokerConfigurationDescriptor,
  type ContextBrokerIntegrationFactory,
  type ContextBudgetLimits,
  type ContextReleasePolicySnapshot,
} from "@guard/context-broker";
import {
  REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
} from "@guard/capability-repository";
import {
  CONTRACT_SCHEMA_VERSION,
  ActionIdKind,
  AgentAttemptIdKind,
  ApprovalIdKind,
  DriverProposalIdKind,
  EventIdKind,
  PolicyVersionIdKind,
  RunIdKind,
  canonicalize,
  type ActionId,
  type AgentAttemptId,
  type ApprovalId,
  type DriverProposalId,
  type EventId,
  type JsonObject,
  type ObjectiveEnvelope,
  type PolicyVersionId,
  type RunId,
  type TaskProfile,
} from "@guard/contracts";
import { InMemoryEventStore } from "@guard/event-store";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshotSet,
  composePolicyAttributeCatalogs,
  createPinnedPolicyEvaluator,
  createPolicySnapshotManifest,
  type PinnedPolicyEvaluator,
  type PolicySnapshot,
} from "@guard/policy-engine";
import { InMemoryTaskProfileRegistry } from "@guard/profile-registry";
import { replay, type RunState } from "@guard/runtime";
import {
  SynchronousRuntimeHost,
  type RuntimeContextPlanner,
  type RuntimeHostExecution,
  type RuntimeHostIdFactory,
  type RuntimeHostReplay,
} from "@guard/runtime-host";

import {
  CalibrationAgentDriver,
  InvariantProviderBoundaryProbeDriver,
  PROVIDER_BOUNDARY_DRIVER_COMPONENT_ID,
  ProviderBoundaryProbeDriver,
  ZeroCallProviderBoundaryProbeDriver,
  providerScriptFor,
  type ProbeTranscript,
} from "./provider-boundary-probe.js";

export const GATE_B_OCCURRED_AT = "2026-08-30T18:00:00.000Z";
export const GATE_B_RECORDED_AT = "2026-08-30T18:00:01.000Z";

/** Byte-exact copy of the installed root context policy. */
export const ROOT_CONTEXT_POLICY_SOURCE = `policy "deny-restricted-context" priority 1000 {
  when action.pack == "guard.context" and resource.classification in ["restricted", "secret"]
  deny
  reason "Restricted or secret-classified resources cannot enter agent context"
}

policy "deny-networked-context-boundary" priority 900 {
  when action.pack == "guard.context" and environment.network_profile != "disabled"
  deny
  reason "Context processing requires the network-disabled broker profile"
}

policy "allow-reviewed-context-reads" priority 600 {
  when action.pack == "guard.context" and action.operation == "context.read" and action.side_effect == "none" and environment.sandboxed == true and environment.network_profile == "disabled" and resource.classification in ["public", "internal", "synthetic", "fixture"]
  allow
  reason "Reviewed metadata reads may proceed through the sandboxed context broker"
}

policy "allow-reviewed-context-releases" priority 600 {
  when action.pack == "guard.context" and action.operation == "context.release" and action.side_effect == "none" and environment.sandboxed == true and environment.network_profile == "disabled" and resource.classification in ["public", "internal", "synthetic", "fixture"] and context.truncated == false
  allow
  reason "Complete reviewed content may be released through the context broker"
}
`;

/** Byte-exact copy of capability-repository/policies/context.guard. */
export const REPOSITORY_CONTEXT_POLICY_SOURCE = `policy "deny-secret-repository-context-paths" priority 950 {
  when action.pack == "guard.context"
    and (repo.path matches "**/.env*" or repo.paths matches "**/.env*")
  deny
  reason "Secret-bearing repository paths cannot enter agent context"
}
`;

export const GATE_B_BROKER_BUDGETS: ContextBudgetLimits = Object.freeze({
  maximumResourceBytes: 256 * 1_024,
  maximumRequestBytes: 128 * 1_024,
  maximumItemsPerTurn: 32,
  maximumBytesPerTurn: 256 * 1_024,
  maximumItemsPerRun: 64,
  maximumBytesPerRun: 512 * 1_024,
  maximumControlCharacterRatio: 0.05,
});

const CATEGORY = Object.freeze({
  run: 0x21,
  event: 0x22,
  attempt: 0x23,
  action: 0x24,
  approval: 0x25,
  context: 0x26,
  block: 0x27,
  observation: 0x28,
  proposal: 0x29,
  policy: 0x2a,
  outcome: 0x2b,
});

export interface EffectCounters extends JsonObject {
  driverCalls: number;
  providerCalls: number;
  normalizations: number;
  executions: number;
  releases: number;
  sourceNormalizations: number;
  sourceMetadataReads: number;
  sourceOpens: number;
}

export interface ScenarioComposition<TArtifacts> {
  readonly host: SynchronousRuntimeHost;
  readonly objective: ObjectiveEnvelope;
  readonly profile: TaskProfile;
  readonly counters: EffectCounters;
  readonly artifacts: TArtifacts;
}

export interface GateBScenarioResult<TArtifacts> {
  readonly execution: RuntimeHostExecution;
  readonly replay: RuntimeHostReplay;
  readonly pureReplayState: RunState;
  readonly expectedRequests: readonly AgentTurnRequest[];
  readonly transcript: ProbeTranscript;
  readonly profile: TaskProfile;
  readonly objective: ObjectiveEnvelope;
  readonly countersAtCompletion: JsonObject;
  readonly countersAfterReplay: JsonObject;
  readonly artifacts: TArtifacts;
}

export class FixedRuntimeHostIdFactory implements RuntimeHostIdFactory {
  readonly #namespace: number;
  #runIssued = false;
  #eventOrdinal = 0;
  #attemptOrdinal = 0;
  #actionOrdinal = 0;
  #approvalOrdinal = 0;
  #contextOrdinal = 0;
  #blockOrdinal = 0;
  #observationOrdinal = 0;

  public constructor(namespace: number) {
    if (!Number.isSafeInteger(namespace) || namespace < 1 || namespace > 0xffff) {
      throw new TypeError("A Gate B namespace must be between 1 and 65535.");
    }
    this.#namespace = namespace;
  }

  public nextRunId(): RunId {
    if (this.#runIssued) throw new Error("The fixed run ID was already issued.");
    this.#runIssued = true;
    return fixedRunId(this.#namespace);
  }

  public nextEventId(): EventId {
    this.#eventOrdinal += 1;
    return EventIdKind.parse(
      `evt_${fixedUuid(this.#namespace, CATEGORY.event, this.#eventOrdinal)}`,
    );
  }

  public nextAgentAttemptId(turn: number): AgentAttemptId {
    if (turn !== this.#attemptOrdinal + 1) {
      throw new Error("Fixed attempt IDs must be consumed in turn order.");
    }
    this.#attemptOrdinal = turn;
    return fixedAttemptId(this.#namespace, turn);
  }

  public nextActionId(): ActionId {
    this.#actionOrdinal += 1;
    return fixedActionId(this.#namespace, this.#actionOrdinal);
  }

  public nextApprovalId(): ApprovalId {
    this.#approvalOrdinal += 1;
    return ApprovalIdKind.parse(
      `apr_${fixedUuid(this.#namespace, CATEGORY.approval, this.#approvalOrdinal)}`,
    );
  }

  public nextContextRequestId(): string {
    this.#contextOrdinal += 1;
    return `ctx_${fixedUuid(
      this.#namespace,
      CATEGORY.context,
      this.#contextOrdinal,
    )}`;
  }

  public nextContentBlockId(): string {
    this.#blockOrdinal += 1;
    return `blk_${fixedUuid(this.#namespace, CATEGORY.block, this.#blockOrdinal)}`;
  }

  public nextObservationId(): string {
    this.#observationOrdinal += 1;
    return `obs_${fixedUuid(
      this.#namespace,
      CATEGORY.observation,
      this.#observationOrdinal,
    )}`;
  }
}

export function fixedRunId(namespace: number): RunId {
  return RunIdKind.parse(`run_${fixedUuid(namespace, CATEGORY.run, 1)}`);
}

export function fixedAttemptId(namespace: number, turn: number): AgentAttemptId {
  return AgentAttemptIdKind.parse(
    `att_${fixedUuid(namespace, CATEGORY.attempt, turn)}`,
  );
}

export function fixedActionId(namespace: number, ordinal: number): ActionId {
  return ActionIdKind.parse(
    `act_${fixedUuid(namespace, CATEGORY.action, ordinal)}`,
  );
}

export function fixedProposalId(
  namespace: number,
  ordinal: number,
): DriverProposalId {
  return DriverProposalIdKind.parse(
    `dpr_${fixedUuid(namespace, CATEGORY.proposal, ordinal)}`,
  );
}

export function fixedObservationId(namespace: number, ordinal: number): string {
  return `obs_${fixedUuid(namespace, CATEGORY.observation, ordinal)}`;
}

export function fixedPolicyVersionId(namespace: number): PolicyVersionId {
  return PolicyVersionIdKind.parse(
    `pol_${fixedUuid(namespace, CATEGORY.policy, 1)}`,
  );
}

export function fixedOutcomeId(namespace: number): string {
  return `out_${fixedUuid(namespace, CATEGORY.outcome, 1)}`;
}

export function createReleasePolicy(id: string): ContextReleasePolicySnapshot {
  return createContextReleasePolicySnapshot({
    releasePolicyId: id,
    releasePolicyVersion: 1,
    secretDisposition: "deny",
    promptInjectionDisposition: "tag",
    truncatedDisposition: "deny",
  });
}

export function compileGateBPolicy(input: {
  readonly namespace: number;
  readonly kind: "generic" | "coding";
  readonly actionPolicySource: string;
}): PolicySnapshot {
  const catalogs =
    input.kind === "generic"
      ? composePolicyAttributeCatalogs([
          BASE_POLICY_ATTRIBUTE_CATALOG,
          CONTEXT_POLICY_ATTRIBUTE_CATALOG,
          MEMORY_POLICY_ATTRIBUTE_CATALOG,
        ])
      : composePolicyAttributeCatalogs([
          BASE_POLICY_ATTRIBUTE_CATALOG,
          CONTEXT_POLICY_ATTRIBUTE_CATALOG,
          REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
        ]);
  const result = compilePolicySnapshotSet(
    {
      policyVersionId: fixedPolicyVersionId(input.namespace),
      sources: [
        { sourceId: "gate-b-actions.guard", source: input.actionPolicySource },
        { sourceId: "policies/context.guard", source: ROOT_CONTEXT_POLICY_SOURCE },
        ...(input.kind === "coding"
          ? [
              {
                sourceId: "packages/capability-repository/policies/context.guard",
                source: REPOSITORY_CONTEXT_POLICY_SOURCE,
              },
            ]
          : []),
      ],
      defaultEffect: "deny",
    },
    {},
    catalogs,
  );
  if (!result.ok) {
    throw new Error(
      `Gate B policy compilation failed: ${JSON.stringify(result.diagnostics)}`,
    );
  }
  return result.snapshot;
}

export function createUnifiedBrokerFactory(input: {
  readonly snapshot: PolicySnapshot;
  readonly evaluator: PinnedPolicyEvaluator;
  readonly releasePolicy: ContextReleasePolicySnapshot;
  readonly sources: readonly BrokerContextSource[];
}): ContextBrokerIntegrationFactory {
  return createContextBrokerIntegrationFactory({
    policySnapshotId: input.snapshot.policyVersionId,
    releasePolicy: input.releasePolicy,
    sources: new BrokerContextSourceRegistry(input.sources),
    policy: createPinnedContextPolicyAdapter({
      evaluator: input.evaluator,
      releasePolicy: input.releasePolicy,
    }),
    budgets: GATE_B_BROKER_BUDGETS,
  });
}

export function createProfile(input: {
  readonly profileId: string;
  readonly profileVersion?: number;
  readonly policyComponentId: string;
  readonly policySnapshot: PolicySnapshot;
  readonly brokerConfiguration: ContextBrokerConfigurationDescriptor;
  readonly contextSources: TaskProfile["contextSources"];
  readonly capabilityPacks: TaskProfile["capabilityPacks"];
  readonly objectiveSchema: TaskProfile["objectiveSchema"];
  readonly outcomeSchema: TaskProfile["outcomeSchema"];
  readonly maximumTurns: number;
  readonly maximumActions: number;
}): TaskProfile {
  return immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    profileId: input.profileId,
    profileVersion: input.profileVersion ?? 1,
    objectiveSchema: input.objectiveSchema,
    driverProfile: {
      componentId: PROVIDER_BOUNDARY_DRIVER_COMPONENT_ID,
      componentVersion: 1,
      configuration: { boundary: "synthetic-provider-probe" },
    },
    modelBindings: [],
    contextSources: input.contextSources,
    capabilityPacks: input.capabilityPacks,
    policyProfile: {
      componentId: input.policyComponentId,
      componentVersion: 1,
      configuration: createPolicySnapshotManifest(input.policySnapshot),
    },
    outcomeSchema: input.outcomeSchema,
    budgetPolicy: {
      maxTurns: input.maximumTurns,
      maxActions: input.maximumActions,
      maxElapsedMs: 30_000,
      maxInputBytes: 512 * 1_024,
      maxOutputBytes: 512 * 1_024,
      extensions: {
        contextBroker: input.brokerConfiguration as unknown as JsonObject,
      },
    },
    evidenceMode: "ephemeral_metadata",
    evaluationProfile: null,
  });
}

export function createRuntimeComposition<TArtifacts>(input: {
  readonly namespace: number;
  readonly driver: AgentDriver;
  readonly profile: TaskProfile;
  readonly objective: ObjectiveEnvelope;
  readonly snapshot: PolicySnapshot;
  readonly evaluator: PinnedPolicyEvaluator;
  readonly brokerFactory: ContextBrokerIntegrationFactory;
  readonly packs: readonly CapabilityPack[];
  readonly planner: RuntimeContextPlanner;
  readonly counters: EffectCounters;
  readonly artifacts: TArtifacts;
}): ScenarioComposition<TArtifacts> {
  const profiles = new InMemoryTaskProfileRegistry();
  profiles.register(input.profile);
  const packRegistry = new CapabilityPackRegistry(input.packs);
  const gateway = new CapabilityGateway(packRegistry, input.evaluator);
  const eventStore = new InMemoryEventStore({ now: () => GATE_B_RECORDED_AT });
  const host = new SynchronousRuntimeHost({
    eventStore,
    profileRegistry: profiles,
    installedDriver: {
      componentId: PROVIDER_BOUNDARY_DRIVER_COMPONENT_ID,
      componentVersion: 1,
      driver: input.driver,
    },
    contextBrokerFactory: input.brokerFactory,
    capabilityPacks: packRegistry,
    capabilityGateway: gateway,
    contextPlanner: input.planner,
    installedPolicy: {
      componentId: input.profile.policyProfile.componentId,
      componentVersion: input.profile.policyProfile.componentVersion,
      snapshot: input.snapshot,
    },
    normalizationSubject: {
      kind: "scripted",
      principal: "gate-b-fixture",
      driverId: PROVIDER_BOUNDARY_DRIVER_COMPONENT_ID,
    },
    normalizationEnvironment: {
      profileId: input.profile.profileId,
      sandboxed: true,
      networkProfile: "disabled",
      trustLevel: "trusted_fixture",
    },
    clock: { now: () => GATE_B_OCCURRED_AT },
    ids: new FixedRuntimeHostIdFactory(input.namespace),
  });
  return Object.freeze({
    host,
    objective: input.objective,
    profile: input.profile,
    counters: input.counters,
    artifacts: input.artifacts,
  });
}

export async function runExactCalibratedScenario<TArtifacts>(input: {
  readonly scriptId: string;
  readonly turnEvents: readonly (readonly AgentDriverEvent[])[];
  readonly build: (driver: AgentDriver) => ScenarioComposition<TArtifacts>;
}): Promise<GateBScenarioResult<TArtifacts>> {
  const calibrationDriver = new CalibrationAgentDriver(input.turnEvents);
  const calibration = input.build(calibrationDriver);
  const calibrationExecution = await calibration.host.run(calibration.objective);
  if (calibrationExecution.state.status !== "completed") {
    throw new Error(
      `Gate B calibration did not complete: ${canonicalize(
        calibrationExecution.state.result,
      )}; events=${canonicalize(
        calibrationExecution.history.map((event) => event.eventType),
      )}`,
    );
  }
  calibrationDriver.assertExhausted();
  const expectedRequests = immutable(calibrationDriver.requests);
  const script: ScriptedAgentDriverScript = immutable({
    scriptId: input.scriptId,
    turns: expectedRequests.map((expectedRequest, index) => ({
      expectedRequest,
      events: input.turnEvents[index]!,
    })),
  });
  const providerScript = providerScriptFor(
    `${input.scriptId}.provider`,
    expectedRequests,
  );
  const probe =
    expectedRequests.length === 0
      ? new ZeroCallProviderBoundaryProbeDriver()
      : new ProviderBoundaryProbeDriver(script, providerScript);
  const live = input.build(probe);
  const execution = await live.host.run(live.objective);
  probe.assertExhausted();
  const transcript = probe.transcript();
  live.counters.driverCalls = transcript.driverCallCount;
  live.counters.providerCalls = transcript.providerCallCount;
  const countersAtCompletion = immutable(live.counters);
  const replayed = await live.host.replayRun(execution.runId);
  const pureReplayState = replay(execution.history);
  const countersAfterReplay = immutable(live.counters);
  return Object.freeze({
    execution,
    replay: replayed,
    pureReplayState,
    expectedRequests,
    transcript,
    profile: live.profile,
    objective: live.objective,
    countersAtCompletion,
    countersAfterReplay,
    artifacts: live.artifacts,
  });
}

export async function runInvariantCalibratedScenario<TArtifacts>(input: {
  readonly scriptId: string;
  readonly turnEvents: readonly (readonly AgentDriverEvent[])[];
  readonly build: (driver: AgentDriver) => ScenarioComposition<TArtifacts>;
}): Promise<GateBScenarioResult<TArtifacts>> {
  const calibrationDriver = new CalibrationAgentDriver(input.turnEvents);
  const calibration = input.build(calibrationDriver);
  const calibrationExecution = await calibration.host.run(calibration.objective);
  if (calibrationExecution.state.status !== "completed") {
    throw new Error(
      `Gate B invariant calibration did not complete: ${canonicalize(
        calibrationExecution.state.result,
      )}; events=${canonicalize(
        calibrationExecution.history.map((event) => event.eventType),
      )}`,
    );
  }
  calibrationDriver.assertExhausted();
  const expectedRequests = immutable(calibrationDriver.requests);
  const probe = new InvariantProviderBoundaryProbeDriver(
    expectedRequests,
    input.turnEvents,
    providerScriptFor(`${input.scriptId}.provider`, expectedRequests),
  );
  const live = input.build(probe);
  const execution = await live.host.run(live.objective);
  probe.assertExhausted();
  const transcript = probe.transcript();
  live.counters.driverCalls = transcript.driverCallCount;
  live.counters.providerCalls = transcript.providerCallCount;
  const countersAtCompletion = immutable(live.counters);
  const replayed = await live.host.replayRun(execution.runId);
  const pureReplayState = replay(execution.history);
  const countersAfterReplay = immutable(live.counters);
  return Object.freeze({
    execution,
    replay: replayed,
    pureReplayState,
    expectedRequests,
    transcript,
    profile: live.profile,
    objective: live.objective,
    countersAtCompletion,
    countersAfterReplay,
    artifacts: live.artifacts,
  });
}

/** Calibrates only the requests reached before an expected fail-closed stop. */
export async function runFailingExactCalibratedScenario<TArtifacts>(input: {
  readonly scriptId: string;
  readonly expectedErrorCode: string;
  readonly turnEvents: readonly (readonly AgentDriverEvent[])[];
  readonly build: (driver: AgentDriver) => ScenarioComposition<TArtifacts>;
}): Promise<GateBScenarioResult<TArtifacts>> {
  const calibrationDriver = new CalibrationAgentDriver(input.turnEvents);
  const calibration = input.build(calibrationDriver);
  const calibrationExecution = await calibration.host.run(calibration.objective);
  if (
    calibrationExecution.state.result?.status !== "failed" ||
    calibrationExecution.state.result.error.code !== input.expectedErrorCode
  ) {
    throw new Error(
      `Gate B failing calibration changed result: ${canonicalize(
        calibrationExecution.state.result,
      )}`,
    );
  }
  calibrationDriver.assertExhausted();
  const expectedRequests = immutable(calibrationDriver.requests);
  const script: ScriptedAgentDriverScript = immutable({
    scriptId: input.scriptId,
    turns: expectedRequests.map((expectedRequest, index) => ({
      expectedRequest,
      events: input.turnEvents[index]!,
    })),
  });
  const providerScript = providerScriptFor(
    `${input.scriptId}.provider`,
    expectedRequests,
  );
  const probe =
    expectedRequests.length === 0
      ? new ZeroCallProviderBoundaryProbeDriver()
      : new ProviderBoundaryProbeDriver(script, providerScript);
  const live = input.build(probe);
  const execution = await live.host.run(live.objective);
  if (
    execution.state.result?.status !== "failed" ||
    execution.state.result.error.code !== input.expectedErrorCode
  ) {
    throw new Error(
      `Gate B fail-closed run changed result: ${canonicalize(
        execution.state.result,
      )}`,
    );
  }
  probe.assertExhausted();
  const transcript = probe.transcript();
  live.counters.driverCalls = transcript.driverCallCount;
  live.counters.providerCalls = transcript.providerCallCount;
  const countersAtCompletion = immutable(live.counters);
  const replayed = await live.host.replayRun(execution.runId);
  const pureReplayState = replay(execution.history);
  const countersAfterReplay = immutable(live.counters);
  return Object.freeze({
    execution,
    replay: replayed,
    pureReplayState,
    expectedRequests,
    transcript,
    profile: live.profile,
    objective: live.objective,
    countersAtCompletion,
    countersAfterReplay,
    artifacts: live.artifacts,
  });
}

export function createEvaluator(
  snapshot: PolicySnapshot,
  namespace: number,
): PinnedPolicyEvaluator {
  return createPinnedPolicyEvaluator(snapshot, {
    secretCorrelationToken: `gate-b-policy-correlation-${String(namespace)}`,
  });
}

export function emptyCounters(): EffectCounters {
  return {
    driverCalls: 0,
    providerCalls: 0,
    normalizations: 0,
    executions: 0,
    releases: 0,
    sourceNormalizations: 0,
    sourceMetadataReads: 0,
    sourceOpens: 0,
  };
}

/** Counts every live capability phase without changing the trusted pack API. */
export function countCapabilityPack(
  pack: CapabilityPack,
  counters: EffectCounters,
): CapabilityPack {
  const operations: CapabilityPack["operations"] = pack.operations.map(
    (operation): CapabilityPack["operations"][number] => ({
      definition: operation.definition,
      agentContextRelease: operation.agentContextRelease,
      async normalize(input, context) {
        counters.normalizations += 1;
        return operation.normalize(input, context);
      },
      async execute(action, context) {
        counters.executions += 1;
        return operation.execute(action, context);
      },
      async release(raw, action) {
        counters.releases += 1;
        return operation.release(raw, action);
      },
    }),
  );
  return Object.freeze({
    packId: pack.packId,
    packVersion: pack.packVersion,
    operations: Object.freeze(operations),
  });
}

/** Counts strict metadata-before-bytes source calls while preserving identity. */
export function countBrokerContextSource(
  source: BrokerContextSource,
  counters: EffectCounters,
): BrokerContextSource {
  const counted: BrokerContextSource = {
    descriptor: source.descriptor,
    normalizeResourceRequest(input) {
      counters.sourceNormalizations += 1;
      return source.normalizeResourceRequest(input);
    },
    async inspectMetadata(request, signal) {
      counters.sourceMetadataReads += 1;
      return source.inspectMetadata(request, signal);
    },
    async openBounded(request, expected, budget, signal) {
      counters.sourceOpens += 1;
      return source.openBounded(request, expected, budget, signal);
    },
  };
  return Object.freeze(counted);
}

export function immutable<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalize(value)) as T);
}

function fixedUuid(namespace: number, category: number, ordinal: number): string {
  if (
    !Number.isSafeInteger(namespace) ||
    namespace < 1 ||
    namespace > 0xffff ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > 0xffffffffff
  ) {
    throw new TypeError("A fixed Gate B UUID component is invalid.");
  }
  const first = (0x01910000 + namespace).toString(16).padStart(8, "0");
  const tail = `${category.toString(16).padStart(2, "0")}${ordinal
    .toString(16)
    .padStart(10, "0")}`;
  return `${first}-0000-7000-8000-${tail}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
