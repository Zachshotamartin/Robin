import type {
  AdvertisedOperation,
  AgentObservation,
  AgentDriver,
  AgentDriverDescriptor,
  AgentTurnRequest,
} from "@guard/agent-driver";
import { parseAgentObservation } from "@guard/agent-driver";
import {
  CapabilityGateway,
  CapabilityPackRegistry,
  type CapabilityPack,
  type CapabilityOperationReference,
} from "@guard/capability-gateway";
import {
  BrokerContextSourceRegistry,
  CONTEXT_POLICY_ATTRIBUTE_CATALOG,
  createContextBrokerIntegrationFactory,
  createContextReleasePolicySnapshot,
  createPinnedContextPolicyAdapter,
  type BrokerContextSource,
} from "@guard/context-broker";
import {
  CONTRACT_SCHEMA_VERSION,
  ActionIdKind,
  AgentAttemptIdKind,
  ApprovalIdKind,
  DriverProposalIdKind,
  EventIdKind,
  PolicyVersionIdKind,
  RunIdKind,
  canonicalBytes,
  canonicalSha256Hex,
  canonicalize,
  parseContentBlock,
  parseObservation,
  parseResourceRef,
  sha256Hex,
  type ActionId,
  type AgentAttemptId,
  type ApprovalId,
  type DriverProposalId,
  type EventId,
  type JsonContentBlock,
  type JsonObject,
  type Observation,
  type PolicyVersionId,
  type ResourceRef,
  type RunId,
} from "@guard/contracts";
import type { EventStore } from "@guard/event-store";
import type { TaskProfileRegistry } from "@guard/profile-registry";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshot,
  composePolicyAttributeCatalogs,
  createPinnedPolicyEvaluator,
  type PolicySnapshot,
} from "@guard/policy-engine";
import {
  SynchronousRuntimeHost,
  type RuntimeHostExecution,
  type RuntimeHostIdFactory,
  type RuntimeHostReplay,
  type SynchronousRuntimeHostOptions,
} from "@guard/runtime-host";

export const SCENARIO_OCCURRED_AT = "2026-01-02T03:04:05.000Z";
export const SCENARIO_RECORDED_AT = "2026-01-02T03:04:06.000Z";

/** Kept byte-identical to policies/context.guard; the tests guard that pin. */
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

/** Kept byte-identical to capability-repository/policies/context.guard. */
export const REPOSITORY_CONTEXT_POLICY_SOURCE = `policy "deny-secret-repository-context-paths" priority 950 {
  when action.pack == "guard.context"
    and (repo.path matches "**/.env*" or repo.paths matches "**/.env*")
  deny
  reason "Secret-bearing repository paths cannot enter agent context"
}
`;

const CATEGORY = Object.freeze({
  run: 0x01,
  event: 0x02,
  attempt: 0x03,
  action: 0x04,
  context: 0x05,
  block: 0x06,
  observation: 0x07,
  proposal: 0x08,
  policy: 0x09,
  outcome: 0x0a,
  approval: 0x0b,
});

const REPLAY_POLICY_SNAPSHOT = compileReplayPolicy();

export interface ScenarioExecution {
  readonly execution: RuntimeHostExecution;
  readonly replay: RuntimeHostReplay;
  readonly expectedTranscript: readonly AgentTurnRequest[];
  readonly liveEffectCalls: ScenarioLiveEffectCalls;
  readonly replayEffectCalls: number;
}

/** Mutable only while composing one live scenario, then copied into its result. */
export interface ScenarioLiveEffectCalls {
  readonly sourceNormalize: number;
  readonly sourceInspect: number;
  readonly sourceOpen: number;
  readonly capabilityNormalize: number;
  readonly capabilityExecute: number;
  readonly capabilityRelease: number;
  readonly repositoryList: number;
  readonly repositoryRead: number;
}

interface MutableScenarioLiveEffectCalls {
  sourceNormalize: number;
  sourceInspect: number;
  sourceOpen: number;
  capabilityNormalize: number;
  capabilityExecute: number;
  capabilityRelease: number;
  repositoryList: number;
  repositoryRead: number;
}

export function createScenarioLiveEffectCalls(): MutableScenarioLiveEffectCalls {
  return {
    sourceNormalize: 0,
    sourceInspect: 0,
    sourceOpen: 0,
    capabilityNormalize: 0,
    capabilityExecute: 0,
    capabilityRelease: 0,
    repositoryList: 0,
    repositoryRead: 0,
  };
}

/**
 * Counts installed source handlers, including metadata-only work, without
 * changing their inputs or outputs. A pre-ledger source preview therefore
 * becomes visible to the scenario regression tests.
 */
export function countBrokerSourceEffects(
  source: BrokerContextSource,
  calls: MutableScenarioLiveEffectCalls,
): BrokerContextSource {
  return {
    descriptor: source.descriptor,
    normalizeResourceRequest(input) {
      calls.sourceNormalize += 1;
      return source.normalizeResourceRequest(input);
    },
    inspectMetadata(request, signal) {
      calls.sourceInspect += 1;
      return source.inspectMetadata(request, signal);
    },
    openBounded(request, expected, budget, signal) {
      calls.sourceOpen += 1;
      return source.openBounded(request, expected, budget, signal);
    },
  };
}

/**
 * Counts the three capability handler boundaries captured by the real pack
 * registry. Scenarios reconcile those counts with normalized, started, and
 * succeeded ledger events, so an unledgered preview cannot remain invisible.
 */
export function countCapabilityPackEffects(
  pack: CapabilityPack,
  calls: MutableScenarioLiveEffectCalls,
): CapabilityPack {
  return {
    packId: pack.packId,
    packVersion: pack.packVersion,
    operations: pack.operations.map((operation) => ({
      definition: operation.definition,
      agentContextRelease: operation.agentContextRelease,
      async normalize(input, context) {
        calls.capabilityNormalize += 1;
        return operation.normalize(input, context);
      },
      async execute(action, context) {
        calls.capabilityExecute += 1;
        return operation.execute(action, context);
      },
      async release(raw, action) {
        calls.capabilityRelease += 1;
        return operation.release(raw, action);
      },
    })),
  };
}

/**
 * A finite, reproducible UUIDv7 identity source. Category and ordinal occupy
 * only the random portion, while the UUID version and variant bits remain
 * valid. Exhaustion/reuse is an explicit fixture error instead of an implicit
 * fallback to random identity generation.
 */
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
      throw new TypeError("A fixed scenario namespace must be between 1 and 65535.");
    }
    this.#namespace = namespace;
  }

  public nextRunId(): RunId {
    if (this.#runIssued) throw new Error("The fixed run identity was already issued.");
    this.#runIssued = true;
    return fixedRunId(this.#namespace);
  }

  public nextEventId(): EventId {
    this.#eventOrdinal += 1;
    return fixedEventId(this.#namespace, this.#eventOrdinal);
  }

  public nextAgentAttemptId(turn: number): AgentAttemptId {
    if (turn !== this.#attemptOrdinal + 1) {
      throw new Error("Fixed agent-attempt identities must be consumed in turn order.");
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
    return fixedApprovalId(this.#namespace, this.#approvalOrdinal);
  }

  public nextContextRequestId(): string {
    this.#contextOrdinal += 1;
    return `ctx_${fixedUuid(this.#namespace, CATEGORY.context, this.#contextOrdinal)}`;
  }

  public nextContentBlockId(): string {
    this.#blockOrdinal += 1;
    return fixedContentBlockId(this.#namespace, this.#blockOrdinal);
  }

  public nextObservationId(): string {
    this.#observationOrdinal += 1;
    return fixedObservationId(this.#namespace, this.#observationOrdinal);
  }
}

export function fixedRunId(namespace: number): RunId {
  return RunIdKind.parse(`run_${fixedUuid(namespace, CATEGORY.run, 1)}`);
}

export function fixedEventId(namespace: number, ordinal: number): EventId {
  return EventIdKind.parse(`evt_${fixedUuid(namespace, CATEGORY.event, ordinal)}`);
}

export function fixedAttemptId(namespace: number, turn: number): AgentAttemptId {
  return AgentAttemptIdKind.parse(
    `att_${fixedUuid(namespace, CATEGORY.attempt, turn)}`,
  );
}

export function fixedActionId(namespace: number, ordinal: number): ActionId {
  return ActionIdKind.parse(`act_${fixedUuid(namespace, CATEGORY.action, ordinal)}`);
}

export function fixedApprovalId(namespace: number, ordinal: number): ApprovalId {
  return ApprovalIdKind.parse(
    `apr_${fixedUuid(namespace, CATEGORY.approval, ordinal)}`,
  );
}

export function fixedProposalId(namespace: number, ordinal: number): DriverProposalId {
  return DriverProposalIdKind.parse(
    `dpr_${fixedUuid(namespace, CATEGORY.proposal, ordinal)}`,
  );
}

export function fixedPolicyVersionId(namespace: number): PolicyVersionId {
  return PolicyVersionIdKind.parse(
    `pol_${fixedUuid(namespace, CATEGORY.policy, 1)}`,
  );
}

export function fixedContentBlockId(namespace: number, ordinal: number): string {
  return `blk_${fixedUuid(namespace, CATEGORY.block, ordinal)}`;
}

export function fixedObservationId(namespace: number, ordinal: number): string {
  return `obs_${fixedUuid(namespace, CATEGORY.observation, ordinal)}`;
}

export function fixedOutcomeId(namespace: number): string {
  return `out_${fixedUuid(namespace, CATEGORY.outcome, 1)}`;
}

export function fixedClock(): { readonly now: () => string } {
  return Object.freeze({ now: () => SCENARIO_OCCURRED_AT });
}

export function advertisedOperations(
  registry: CapabilityPackRegistry,
  references: readonly CapabilityOperationReference[],
): readonly AdvertisedOperation[] {
  const ordered = [...references].sort(
    (left, right) =>
      left.packId.localeCompare(right.packId) ||
      left.packVersion - right.packVersion ||
      left.operationId.localeCompare(right.operationId) ||
      left.operationVersion - right.operationVersion,
  );
  const advertisement = registry.createAdvertisement(ordered);
  return immutable(
    advertisement.operations.map((operation) => ({
      capabilityPackId: operation.packId,
      capabilityPackVersion: operation.packVersion,
      operationId: operation.operationId,
      operationVersion: operation.operationVersion,
      description: operation.description,
      inputSchema: operation.inputSchema.document,
    })),
  );
}

export function jsonContentBlock(input: {
  readonly namespace: number;
  readonly ordinal: number;
  readonly value: JsonObject;
  readonly source: ResourceRef | null;
  readonly producerKind: "context_source" | "capability_worker";
  readonly producerId: string;
  readonly classification: string;
}): JsonContentBlock {
  const value = immutable(input.value);
  const parsed = parseContentBlock({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    blockId: fixedContentBlockId(input.namespace, input.ordinal),
    modality: "json",
    mediaType: "application/json",
    byteLength: canonicalBytes(value).byteLength,
    contentHash: canonicalSha256Hex(value),
    classification: input.classification,
    provenance: {
      source: input.source,
      producer: { kind: input.producerKind, id: input.producerId },
      capturedAt: SCENARIO_OCCURRED_AT,
    },
    retentionClass: "run",
    transformation: null,
    value,
    jsonSchema: null,
  });
  if (parsed.modality !== "json") {
    throw new Error("The fixture JSON content parser changed modality.");
  }
  return parsed;
}

export function successfulObservation(input: {
  readonly namespace: number;
  readonly observationOrdinal: number;
  readonly actionOrdinal: number;
  readonly firstBlockOrdinal: number;
  readonly capabilityPackId: string;
  readonly audit: JsonObject;
  readonly human: JsonObject;
  readonly agent: JsonObject;
}): Observation {
  return parseObservation({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    observationId: fixedObservationId(input.namespace, input.observationOrdinal),
    actionId: fixedActionId(input.namespace, input.actionOrdinal),
    status: "succeeded",
    audit: input.audit,
    human: [
      jsonContentBlock({
        namespace: input.namespace,
        ordinal: input.firstBlockOrdinal,
        value: input.human,
        source: null,
        producerKind: "capability_worker",
        producerId: input.capabilityPackId,
        classification: "internal",
      }),
    ],
    agent: [
      jsonContentBlock({
        namespace: input.namespace,
        ordinal: input.firstBlockOrdinal + 1,
        value: input.agent,
        source: null,
        producerKind: "capability_worker",
        producerId: input.capabilityPackId,
        classification: "internal",
      }),
    ],
    error: null,
    occurredAt: SCENARIO_OCCURRED_AT,
  });
}

/**
 * Effect-free transcript oracle for the broker's public serialized-item
 * contract. The ScriptedAgentDriver compares this independently constructed
 * block byte-for-byte with what the live broker gives the runtime host.
 */
export function deterministicBrokerJsonContentBlock(input: {
  readonly runId: RunId;
  readonly releaseOrdinal: number;
  readonly value: JsonObject;
  readonly resource: ResourceRef;
  readonly mediaType: string;
  readonly classification: string;
  readonly producerKind: "context_source" | "capability_worker";
}): JsonContentBlock {
  if (!Number.isSafeInteger(input.releaseOrdinal) || input.releaseOrdinal < 1) {
    throw new TypeError("A broker transcript release ordinal must be positive.");
  }
  const value = immutable(input.value);
  const resource = parseResourceRef(input.resource);
  const contentHash = canonicalSha256Hex(value);
  const blockId = `ctx_${sha256Hex(
    `${input.runId}\u0000${String(input.releaseOrdinal)}\u0000${contentHash}`,
  ).slice(0, 40)}`;
  const parsed = parseContentBlock({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    blockId,
    modality: "json",
    mediaType: input.mediaType,
    byteLength: canonicalBytes(value).byteLength,
    contentHash,
    classification: input.classification,
    provenance: {
      source: resource,
      producer: {
        kind: input.producerKind,
        id: resource.sourceId,
      },
      capturedAt: SCENARIO_OCCURRED_AT,
    },
    retentionClass: "run",
    transformation: null,
    value,
    jsonSchema: null,
  });
  if (parsed.modality !== "json") {
    throw new Error("The deterministic broker JSON block changed modality.");
  }
  return parsed;
}

export function successfulBrokeredObservation(input: {
  readonly namespace: number;
  readonly observationOrdinal: number;
  readonly actionOrdinal: number;
  readonly humanBlockOrdinal: number;
  readonly capabilityPackId: string;
  readonly audit: JsonObject;
  readonly human: JsonObject;
  readonly agentContent: readonly JsonContentBlock[];
}): {
  readonly eventObservation: Observation;
  readonly agentObservation: AgentObservation;
} {
  const observationId = fixedObservationId(
    input.namespace,
    input.observationOrdinal,
  );
  const actionId = fixedActionId(input.namespace, input.actionOrdinal);
  const eventObservation = parseObservation({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    observationId,
    actionId,
    status: "succeeded",
    audit: input.audit,
    human: [
      jsonContentBlock({
        namespace: input.namespace,
        ordinal: input.humanBlockOrdinal,
        value: input.human,
        source: null,
        producerKind: "capability_worker",
        producerId: input.capabilityPackId,
        classification: "internal",
      }),
    ],
    agent: input.agentContent,
    error: null,
    occurredAt: SCENARIO_OCCURRED_AT,
  });
  const agentObservation = parseAgentObservation({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    observationId,
    actionId,
    status: "succeeded",
    content: input.agentContent,
    error: null,
    occurredAt: SCENARIO_OCCURRED_AT,
  });
  return Object.freeze({ eventObservation, agentObservation });
}

export async function replayWithFailOnEffectPorts(
  eventStore: EventStore,
  runId: RunId,
): Promise<{ readonly replay: RuntimeHostReplay; readonly effectCalls: number }> {
  let effectCalls = 0;
  const fail = (port: string): never => {
    effectCalls += 1;
    throw new Error(`Replay invoked forbidden effect port: ${port}`);
  };

  const descriptor: AgentDriverDescriptor = Object.freeze({
    driverId: "guard.replay-effect-spy",
    driverVersion: "1.0.0",
    capabilities: Object.freeze({
      driverKind: "scripted",
      contextDelivery: "mediated_items",
      actionDelivery: "structured",
      transcriptVisibility: "exact",
      credentialOwnership: "none",
      resume: "lossless",
      cancellation: "confirmed",
      canSpawnUndeclaredAgents: false,
    }),
  });
  const driver: AgentDriver = Object.freeze({
    descriptor,
    advance() {
      return fail("agent-driver.advance");
    },
  });
  const capabilityPacks = new FailOnCallCapabilityPackRegistry(fail);
  const replayReleasePolicy = createContextReleasePolicySnapshot({
    releasePolicyId: "scenario.replay",
    releasePolicyVersion: 1,
    secretDisposition: "deny",
    promptInjectionDisposition: "tag",
    truncatedDisposition: "deny",
  });
  const replayEvaluator = createPinnedPolicyEvaluator(REPLAY_POLICY_SNAPSHOT, {
    secretCorrelationToken: "scenario-replay-context-token-0001",
  });
  const contextBrokerFactory = createContextBrokerIntegrationFactory({
    policySnapshotId: REPLAY_POLICY_SNAPSHOT.policyVersionId,
    releasePolicy: replayReleasePolicy,
    sources: new BrokerContextSourceRegistry([]),
    policy: createPinnedContextPolicyAdapter({
      evaluator: replayEvaluator,
      releasePolicy: replayReleasePolicy,
    }),
    budgets: {
      maximumResourceBytes: 256,
      maximumRequestBytes: 256,
      maximumItemsPerTurn: 1,
      maximumBytesPerTurn: 256,
      maximumItemsPerRun: 1,
      maximumBytesPerRun: 256,
      maximumControlCharacterRatio: 0.05,
    },
  });
  // Reserve this run before replay. If replay ever attempts to create a live
  // broker, the recognized factory fails instead of silently performing work.
  contextBrokerFactory.createForRun({ runId });

  const options: SynchronousRuntimeHostOptions = {
    eventStore,
    profileRegistry: new FailOnCallTaskProfileRegistry(fail),
    installedDriver: {
      componentId: "replay-effect-spy",
      componentVersion: 1,
      driver,
    },
    contextBrokerFactory,
    capabilityPacks,
    capabilityGateway: new FailOnCallCapabilityGateway(capabilityPacks, fail),
    contextPlanner: Object.freeze({
      plan() {
        return fail("context-planner.plan");
      },
    }),
    installedPolicy: {
      componentId: "replay-effect-spy",
      componentVersion: 1,
      snapshot: REPLAY_POLICY_SNAPSHOT,
    },
    normalizationSubject: { kind: "replay" },
    normalizationEnvironment: {
      profileId: "replay-effect-spy",
      sandboxed: true,
      networkProfile: "disabled",
      trustLevel: "trusted_fixture",
    },
    clock: Object.freeze({
      now() {
        return fail("runtime-clock.now");
      },
    }),
    ids: new FailOnCallRuntimeHostIdFactory(fail),
  };
  const replay = await new SynchronousRuntimeHost(options).replayRun(runId);
  return Object.freeze({ replay, effectCalls });
}

export function immutable<T>(value: T): T {
  const detached = JSON.parse(canonicalize(value)) as T;
  return deepFreeze(detached);
}

function fixedUuid(namespace: number, category: number, ordinal: number): string {
  if (!Number.isSafeInteger(namespace) || namespace < 1 || namespace > 0xffff) {
    throw new TypeError("Invalid fixed UUID namespace.");
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 0xffffffffff) {
    throw new TypeError("Invalid fixed UUID ordinal.");
  }
  const first = (0x018f0000 + namespace).toString(16).padStart(8, "0");
  const tail = `${category.toString(16).padStart(2, "0")}${ordinal
    .toString(16)
    .padStart(10, "0")}`;
  return `${first}-0000-7000-8000-${tail}`;
}

type EffectFailure = (port: string) => never;

const EFFECT_FAILURES = new WeakMap<object, EffectFailure>();

function failEffect(port: object, method: string): never {
  const fail = EFFECT_FAILURES.get(port);
  if (fail === undefined) {
    throw new Error("A fail-on-call scenario port was not initialized.");
  }
  return fail(method);
}

class FailOnCallTaskProfileRegistry implements TaskProfileRegistry {
  public constructor(fail: EffectFailure) {
    EFFECT_FAILURES.set(this, fail);
    Object.freeze(this);
  }

  public register(_profile: unknown): ReturnType<TaskProfileRegistry["register"]> {
    return failEffect(this, "profile-registry.register");
  }

  public resolve(
    _profileId: unknown,
    _profileVersion: unknown,
  ): ReturnType<TaskProfileRegistry["resolve"]> {
    return failEffect(this, "profile-registry.resolve");
  }

  public list(): ReturnType<TaskProfileRegistry["list"]> {
    return failEffect(this, "profile-registry.list");
  }

  public pin(
    _profileId: unknown,
    _profileVersion: unknown,
  ): ReturnType<TaskProfileRegistry["pin"]> {
    return failEffect(this, "profile-registry.pin");
  }

  public validateObjective(
    _value: unknown,
  ): ReturnType<TaskProfileRegistry["validateObjective"]> {
    return failEffect(this, "profile-registry.validateObjective");
  }

  public validateOutcome(
    _value: unknown,
  ): ReturnType<TaskProfileRegistry["validateOutcome"]> {
    return failEffect(this, "profile-registry.validateOutcome");
  }
}

class FailOnCallCapabilityPackRegistry extends CapabilityPackRegistry {
  public constructor(fail: EffectFailure) {
    super([]);
    EFFECT_FAILURES.set(this, fail);
  }

  public override listPacks(): ReturnType<CapabilityPackRegistry["listPacks"]> {
    return failEffect(this, "capability-packs.listPacks");
  }

  public override createAdvertisement(
    _references: Parameters<CapabilityPackRegistry["createAdvertisement"]>[0],
  ): ReturnType<CapabilityPackRegistry["createAdvertisement"]> {
    return failEffect(this, "capability-packs.createAdvertisement");
  }
}

class FailOnCallCapabilityGateway extends CapabilityGateway {
  public constructor(
    registry: CapabilityPackRegistry,
    fail: EffectFailure,
  ) {
    super(
      registry,
      createPinnedPolicyEvaluator(REPLAY_POLICY_SNAPSHOT, {
        secretCorrelationToken: "scenario-replay-policy-token-0001",
      }),
    );
    EFFECT_FAILURES.set(this, fail);
  }

  public override normalize(
    ..._arguments: Parameters<CapabilityGateway["normalize"]>
  ): ReturnType<CapabilityGateway["normalize"]> {
    return failEffect(this, "capability-gateway.normalize");
  }

  public override execute(
    ..._arguments: Parameters<CapabilityGateway["execute"]>
  ): ReturnType<CapabilityGateway["execute"]> {
    return failEffect(this, "capability-gateway.execute");
  }

  public override evaluate(
    ..._arguments: Parameters<CapabilityGateway["evaluate"]>
  ): ReturnType<CapabilityGateway["evaluate"]> {
    return failEffect(this, "capability-gateway.evaluate");
  }
}

class FailOnCallRuntimeHostIdFactory implements RuntimeHostIdFactory {
  public constructor(fail: EffectFailure) {
    EFFECT_FAILURES.set(this, fail);
    Object.freeze(this);
  }

  public nextRunId(): ReturnType<RuntimeHostIdFactory["nextRunId"]> {
    return failEffect(this, "runtime-id-factory.nextRunId");
  }

  public nextEventId(): ReturnType<RuntimeHostIdFactory["nextEventId"]> {
    return failEffect(this, "runtime-id-factory.nextEventId");
  }

  public nextAgentAttemptId(
    _turn: number,
  ): ReturnType<RuntimeHostIdFactory["nextAgentAttemptId"]> {
    return failEffect(this, "runtime-id-factory.nextAgentAttemptId");
  }

  public nextActionId(): ReturnType<RuntimeHostIdFactory["nextActionId"]> {
    return failEffect(this, "runtime-id-factory.nextActionId");
  }

  public nextApprovalId(): ReturnType<RuntimeHostIdFactory["nextApprovalId"]> {
    return failEffect(this, "runtime-id-factory.nextApprovalId");
  }

  public nextContextRequestId(): ReturnType<
    RuntimeHostIdFactory["nextContextRequestId"]
  > {
    return failEffect(this, "runtime-id-factory.nextContextRequestId");
  }

  public nextContentBlockId(): ReturnType<
    RuntimeHostIdFactory["nextContentBlockId"]
  > {
    return failEffect(this, "runtime-id-factory.nextContentBlockId");
  }

  public nextObservationId(): ReturnType<
    RuntimeHostIdFactory["nextObservationId"]
  > {
    return failEffect(this, "runtime-id-factory.nextObservationId");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function compileReplayPolicy(): PolicySnapshot {
  const catalogs = composePolicyAttributeCatalogs([
    BASE_POLICY_ATTRIBUTE_CATALOG,
    CONTEXT_POLICY_ATTRIBUTE_CATALOG,
  ]);
  const result = compilePolicySnapshot({
    policyVersionId: fixedPolicyVersionId(0xfffe),
    source: `policy "allow-replay-fixture" priority 1 {
  when action.side_effect == "none"
  allow
  reason "The replay fixture never evaluates policy or performs effects."
}
`,
    sourceId: "scenario-replay.guard",
    defaultEffect: "deny",
  }, {}, catalogs);
  if (!result.ok) {
    throw new Error(
      `The deterministic replay policy did not compile: ${JSON.stringify(
        result.diagnostics,
      )}`,
    );
  }
  return result.snapshot;
}
