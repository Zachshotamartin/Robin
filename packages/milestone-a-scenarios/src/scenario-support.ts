import type {
  AdvertisedOperation,
  AgentDriver,
  AgentDriverDescriptor,
  AgentTurnRequest,
} from "@guard/agent-driver";
import type {
  CapabilityOperationReference,
  CapabilityPackRegistry,
  CapabilityGateway,
} from "@guard/capability-gateway";
import type { ContextSourceRegistry } from "@guard/context-broker";
import {
  CONTRACT_SCHEMA_VERSION,
  ActionIdKind,
  AgentAttemptIdKind,
  DriverProposalIdKind,
  EventIdKind,
  PolicyVersionIdKind,
  RunIdKind,
  canonicalBytes,
  canonicalSha256Hex,
  canonicalize,
  parseContentBlock,
  parseObservation,
  type ActionId,
  type AgentAttemptId,
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
  SynchronousRuntimeHost,
  type RuntimeHostExecution,
  type RuntimeHostIdFactory,
  type RuntimeHostReplay,
  type SynchronousRuntimeHostOptions,
} from "@guard/runtime-host";

export const SCENARIO_OCCURRED_AT = "2026-01-02T03:04:05.000Z";
export const SCENARIO_RECORDED_AT = "2026-01-02T03:04:06.000Z";

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
});

export interface ScenarioExecution {
  readonly execution: RuntimeHostExecution;
  readonly replay: RuntimeHostReplay;
  readonly expectedTranscript: readonly AgentTurnRequest[];
  readonly replayEffectCalls: number;
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

  const options: SynchronousRuntimeHostOptions = {
    eventStore,
    profileRegistry: effectSpy<TaskProfileRegistry>(fail, "profile-registry"),
    installedDriver: {
      componentId: "replay-effect-spy",
      componentVersion: 1,
      driver,
    },
    contextSources: effectSpy<ContextSourceRegistry>(fail, "context-sources"),
    capabilityPacks: effectSpy<CapabilityPackRegistry>(fail, "capability-packs"),
    capabilityGateway: effectSpy<CapabilityGateway>(fail, "capability-gateway"),
    contextPlanner: Object.freeze({
      plan() {
        return fail("context-planner.plan");
      },
    }),
    phaseAPolicy: {
      componentId: "replay-effect-spy",
      componentVersion: 1,
      policyVersionId: fixedPolicyVersionId(0xfffe),
    },
    normalizationSubject: {},
    normalizationEnvironment: {},
    clock: Object.freeze({
      now() {
        return fail("runtime-clock.now");
      },
    }),
    ids: effectSpy<RuntimeHostIdFactory>(fail, "runtime-id-factory"),
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

function effectSpy<T>(
  fail: (port: string) => never,
  label: string,
): T {
  return new Proxy(Object.create(null) as object, {
    get(_target, property) {
      return () => fail(`${label}.${String(property)}`);
    },
  }) as unknown as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
