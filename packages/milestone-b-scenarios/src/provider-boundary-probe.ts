import type {
  AgentDriver,
  AgentDriverDescriptor,
  AgentDriverEvent,
  AgentTurnRequest,
  ScriptedAgentDriverScript,
} from "@guard/agent-driver";
import {
  ScriptedAgentDriver,
  parseAgentObservation,
} from "@guard/agent-driver";
import {
  CONTRACT_SCHEMA_VERSION,
  canonicalBytes,
  canonicalSha256Hex,
  canonicalize,
  createDomainError,
  parseContentBlock,
  type GenericEventEnvelope,
  type JsonContentBlock,
  type JsonObject,
} from "@guard/contracts";
import {
  SyntheticModelProvider,
  type ModelProviderEvent,
  type SemanticModelRequest,
  type SyntheticModelScript,
} from "@guard/model-provider";

const PROBE_DESCRIPTOR: AgentDriverDescriptor = Object.freeze({
  driverId: "guard.gate-b-provider-boundary-probe",
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

export const PROVIDER_BOUNDARY_DRIVER_COMPONENT_ID =
  "gate-b.provider-boundary-probe";

export interface ProbeTranscript {
  readonly driverCallCount: number;
  readonly providerCallCount: number;
  readonly requests: readonly AgentTurnRequest[];
  readonly semanticRequests: readonly SemanticModelRequest[];
  readonly providerEvents: readonly (readonly ModelProviderEvent[])[];
  readonly capturedRequestBytes: readonly Uint8Array[];
}

/**
 * Exact scripted agent validation followed by a strict provider boundary.
 * Both streams are exhausted before any agent event is yielded to the host,
 * so divergence cannot partially commit a model-produced turn.
 */
export class ProviderBoundaryProbeDriver implements AgentDriver {
  public readonly descriptor = PROBE_DESCRIPTOR;

  readonly #driver: ScriptedAgentDriver;
  readonly #provider: SyntheticModelProvider;
  readonly #requests: AgentTurnRequest[] = [];
  readonly #semanticRequests: SemanticModelRequest[] = [];
  readonly #providerEvents: ModelProviderEvent[][] = [];
  #driverCallCount = 0;
  #providerCallCount = 0;

  public constructor(
    agentScript: ScriptedAgentDriverScript,
    providerScript: SyntheticModelScript,
  ) {
    this.#driver = new ScriptedAgentDriver(agentScript);
    this.#provider = new SyntheticModelProvider(providerScript);
  }

  public advance(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentDriverEvent> {
    return this.#advance(request, signal);
  }

  public assertExhausted(): void {
    this.#driver.assertExhausted();
    this.#provider.assertExhausted();
  }

  public transcript(): ProbeTranscript {
    return Object.freeze({
      driverCallCount: this.#driverCallCount,
      providerCallCount: this.#providerCallCount,
      requests: Object.freeze([...this.#requests]),
      semanticRequests: Object.freeze([...this.#semanticRequests]),
      providerEvents: Object.freeze(
        this.#providerEvents.map((events) => Object.freeze([...events])),
      ),
      capturedRequestBytes: this.#provider.capturedRequestBytes,
    });
  }

  async *#advance(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): AsyncGenerator<AgentDriverEvent, void, undefined> {
    this.#driverCallCount += 1;
    const agentEvents: AgentDriverEvent[] = [];
    for await (const event of this.#driver.advance(request, signal)) {
      agentEvents.push(event);
    }

    const semanticRequest = mapAgentTurnToSemanticRequest(request);
    const providerEvents: ModelProviderEvent[] = [];
    this.#providerCallCount += 1;
    for await (const event of this.#provider.respond(semanticRequest, signal)) {
      providerEvents.push(event);
    }
    this.#requests.push(request);
    this.#semanticRequests.push(semanticRequest);
    this.#providerEvents.push(providerEvents);

    for (const event of agentEvents) yield event;
  }
}

/** Records the broker-era transcript during a disposable calibration run. */
export class CalibrationAgentDriver implements AgentDriver {
  public readonly descriptor = PROBE_DESCRIPTOR;
  public readonly requests: AgentTurnRequest[] = [];

  readonly #turnEvents: readonly (readonly AgentDriverEvent[])[];
  #nextTurn = 0;

  public constructor(turnEvents: readonly (readonly AgentDriverEvent[])[]) {
    this.#turnEvents = turnEvents;
  }

  public advance(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentDriverEvent> {
    return this.#advance(request, signal);
  }

  public assertExhausted(): void {
    if (this.#nextTurn !== this.#turnEvents.length) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Calibration did not consume its complete deterministic turn script.",
      });
    }
  }

  async *#advance(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): AsyncGenerator<AgentDriverEvent, void, undefined> {
    if (signal.aborted) {
      throw createDomainError({
        code: "cancelled",
        message: "Calibration was cancelled.",
      });
    }
    const events = this.#turnEvents[this.#nextTurn];
    if (events === undefined) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Calibration received an unexpected extra agent request.",
      });
    }
    request.observations.forEach((observation) => parseAgentObservation(observation));
    this.requests.push(request);
    this.#nextTurn += 1;
    for (const event of events) {
      await Promise.resolve();
      if (signal.aborted) {
        throw createDomainError({
          code: "cancelled",
          message: "Calibration was cancelled.",
        });
      }
      yield event;
    }
  }
}

/** A zero-turn effect probe for failures that must precede every provider call. */
export class ZeroCallProviderBoundaryProbeDriver implements AgentDriver {
  public readonly descriptor = PROBE_DESCRIPTOR;
  #driverCallCount = 0;

  public advance(
    _request: AgentTurnRequest,
    _signal: AbortSignal,
  ): AsyncIterable<AgentDriverEvent> {
    this.#driverCallCount += 1;
    return this.#unexpected();
  }

  public assertExhausted(): void {
    if (this.#driverCallCount !== 0) {
      throw createDomainError({
        code: "invariant_violated",
        message: "A fail-before-provider probe reached the agent driver.",
      });
    }
  }

  public transcript(): ProbeTranscript {
    return Object.freeze({
      driverCallCount: this.#driverCallCount,
      providerCallCount: 0,
      requests: Object.freeze([]),
      semanticRequests: Object.freeze([]),
      providerEvents: Object.freeze([]),
      capturedRequestBytes: Object.freeze([]),
    });
  }

  async *#unexpected(): AsyncGenerator<AgentDriverEvent, void, undefined> {
    throw createDomainError({
      code: "invariant_violated",
      message: "A fail-before-provider probe reached the agent driver.",
    });
  }
}

/**
 * Adversarial denials generate fresh ErrorIds by contract. This driver keeps
 * every stable request field byte-exact, validates every strict observation,
 * and treats only ErrorId as an invariant-checked volatile field.
 */
export class InvariantProviderBoundaryProbeDriver implements AgentDriver {
  public readonly descriptor = PROBE_DESCRIPTOR;

  readonly #expectedRequests: readonly AgentTurnRequest[];
  readonly #turnEvents: readonly (readonly AgentDriverEvent[])[];
  readonly #provider: SyntheticModelProvider;
  readonly #requests: AgentTurnRequest[] = [];
  readonly #semanticRequests: SemanticModelRequest[] = [];
  readonly #providerEvents: ModelProviderEvent[][] = [];
  #nextTurn = 0;
  #driverCallCount = 0;
  #providerCallCount = 0;

  public constructor(
    expectedRequests: readonly AgentTurnRequest[],
    turnEvents: readonly (readonly AgentDriverEvent[])[],
    providerScript: SyntheticModelScript,
  ) {
    this.#expectedRequests = expectedRequests;
    this.#turnEvents = turnEvents;
    this.#provider = new SyntheticModelProvider(providerScript);
  }

  public advance(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentDriverEvent> {
    return this.#advance(request, signal);
  }

  public assertExhausted(): void {
    if (
      this.#nextTurn !== this.#expectedRequests.length ||
      this.#nextTurn !== this.#turnEvents.length
    ) {
      throw createDomainError({
        code: "invariant_violated",
        message: "The invariant probe did not consume its complete transcript.",
      });
    }
    this.#provider.assertExhausted();
  }

  public transcript(): ProbeTranscript {
    return Object.freeze({
      driverCallCount: this.#driverCallCount,
      providerCallCount: this.#providerCallCount,
      requests: Object.freeze([...this.#requests]),
      semanticRequests: Object.freeze([...this.#semanticRequests]),
      providerEvents: Object.freeze(
        this.#providerEvents.map((events) => Object.freeze([...events])),
      ),
      capturedRequestBytes: this.#provider.capturedRequestBytes,
    });
  }

  async *#advance(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): AsyncGenerator<AgentDriverEvent, void, undefined> {
    this.#driverCallCount += 1;
    const expected = this.#expectedRequests[this.#nextTurn];
    const events = this.#turnEvents[this.#nextTurn];
    if (expected === undefined || events === undefined) {
      throw createDomainError({
        code: "invariant_violated",
        message: "The invariant probe received an unexpected agent request.",
      });
    }
    request.observations.forEach((observation) => parseAgentObservation(observation));
    if (
      canonicalize(stableAgentRequestProjection(request)) !==
      canonicalize(stableAgentRequestProjection(expected))
    ) {
      throw createDomainError({
        code: "invariant_violated",
        message: "An adversarial agent request changed outside its volatile ErrorId.",
      });
    }

    const semanticRequest = mapAgentTurnToSemanticRequest(request);
    const providerEvents: ModelProviderEvent[] = [];
    this.#providerCallCount += 1;
    for await (const event of this.#provider.respond(semanticRequest, signal)) {
      providerEvents.push(event);
    }
    this.#requests.push(request);
    this.#semanticRequests.push(semanticRequest);
    this.#providerEvents.push(providerEvents);
    this.#nextTurn += 1;
    for (const event of events) yield event;
  }
}

export function mapAgentTurnToSemanticRequest(
  request: AgentTurnRequest,
): SemanticModelRequest {
  const objective = objectiveBlock(request);
  const conversation: SemanticModelRequest["conversation"][number][] = [
    Object.freeze({ role: "user" as const, content: Object.freeze([objective]) }),
  ];
  if (request.context.length > 0) {
    conversation.push(
      Object.freeze({
        role: "developer" as const,
        content: Object.freeze([...request.context]),
      }),
    );
  }

  const observationMetadata: JsonObject[] = [];
  for (const candidate of request.observations) {
    const observation = parseAgentObservation(candidate);
    observationMetadata.push({
      observationId: observation.observationId,
      actionId: observation.actionId,
      status: observation.status,
      occurredAt: observation.occurredAt,
      contentBlockIds: observation.content.map((block) => block.blockId),
      contentHashes: observation.content.map((block) => block.contentHash),
    });
    if (observation.content.length > 0) {
      conversation.push(
        Object.freeze({
          role: "operation" as const,
          correlationId: observation.actionId,
          content: Object.freeze([...observation.content]),
        }),
      );
    }
  }

  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    attemptId: request.attemptId,
    model: Object.freeze({
      modelId: "synthetic/gate-b-boundary-probe",
      settings: Object.freeze({ deterministic: true }),
    }),
    instructions: Object.freeze([
      "Use only the exact broker-released context and structured operations provided.",
    ]),
    conversation: Object.freeze(conversation),
    operations: Object.freeze(
      request.advertisedOperations.map((operation) =>
        Object.freeze({
          capabilityPackId: operation.capabilityPackId,
          capabilityPackVersion: operation.capabilityPackVersion,
          operationId: operation.operationId,
          operationVersion: operation.operationVersion,
          description: operation.description,
          inputSchema: operation.inputSchema,
        }),
      ),
    ),
    maximumOutputUnits: 4_096,
    actionMode: request.advertisedOperations.length === 0 ? "none" : "structured",
    metadata: Object.freeze({
      runId: request.runId,
      attemptId: request.attemptId,
      turnNumber: request.turnNumber,
      profileId: request.objective.profileId,
      profileVersion: request.objective.profileVersion,
      objectiveType: request.objective.objectiveType,
      objectiveTypeVersion: request.objective.objectiveTypeVersion,
      contextBlockIds: request.context.map((block) => block.blockId),
      observations: observationMetadata,
    }),
  });
}

export function providerScriptFor(
  scriptId: string,
  requests: readonly AgentTurnRequest[],
): SyntheticModelScript {
  return Object.freeze({
    scriptId,
    steps: Object.freeze(
      requests.map((request, index) =>
        Object.freeze({
          expectedRequest: mapAgentTurnToSemanticRequest(request),
          events: Object.freeze([
            Object.freeze({
              type: "usage_reported" as const,
              dimensions: Object.freeze({
                inputBytes: canonicalBytes(
                  mapAgentTurnToSemanticRequest(request),
                ).byteLength,
                outputUnits: 1,
              }),
            }),
            Object.freeze({
              type: "response_completed" as const,
              finishReason:
                index === requests.length - 1 ? ("stop" as const) : ("action_required" as const),
            }),
          ]),
        }),
      ),
    ),
  });
}

export interface EvidenceSurfaceInput {
  readonly providerRequestBytes: readonly Uint8Array[];
  readonly driverRequests: readonly AgentTurnRequest[];
  readonly histories: readonly (readonly GenericEventEnvelope[])[];
  readonly renderableArtifacts: readonly unknown[];
}

export interface EvidenceSurfaceMatch {
  readonly surface: string;
  readonly forbiddenIndex: number;
}

/** Reusable scanner for every package-owned model, ledger, and artifact surface. */
export function scanEvidenceSurfaces(
  input: EvidenceSurfaceInput,
  forbidden: readonly string[],
): readonly EvidenceSurfaceMatch[] {
  const surfaces: Array<readonly [string, string]> = [];
  input.providerRequestBytes.forEach((bytes, index) => {
    surfaces.push([
      `providerRequestBytes[${String(index)}]`,
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ]);
  });
  input.driverRequests.forEach((request, index) => {
    surfaces.push([`driverRequests[${String(index)}]`, canonicalize(request)]);
  });
  input.histories.forEach((history, historyIndex) => {
    surfaces.push([`histories[${String(historyIndex)}]`, canonicalize(history)]);
    surfaces.push([
      `observations[${String(historyIndex)}]`,
      canonicalize(
        history
          .filter((event) => event.eventType === "ObservationReleased")
          .map((event) => event.payload),
      ),
    ]);
    surfaces.push([
      `manifests[${String(historyIndex)}]`,
      canonicalize(
        history
          .filter((event) => event.eventType === "ContextManifestRecorded")
          .map((event) => event.payload),
      ),
    ]);
  });
  input.renderableArtifacts.forEach((artifact, index) => {
    surfaces.push([
      `renderableArtifacts[${String(index)}]`,
      typeof artifact === "string" ? artifact : canonicalize(artifact as never),
    ]);
  });

  const matches: EvidenceSurfaceMatch[] = [];
  forbidden.forEach((needle, forbiddenIndex) => {
    if (needle.length === 0) {
      throw new TypeError("Evidence scanners cannot search for an empty canary.");
    }
    for (const [surface, value] of surfaces) {
      if (value.includes(needle)) {
        matches.push(Object.freeze({ surface, forbiddenIndex }));
      }
    }
  });
  return Object.freeze(matches);
}

function objectiveBlock(request: AgentTurnRequest): JsonContentBlock {
  const value = request.objective;
  const parsed = parseContentBlock({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    blockId: `provider-objective-turn-${String(request.turnNumber)}`,
    modality: "json",
    mediaType: "application/json",
    byteLength: canonicalBytes(value).byteLength,
    contentHash: canonicalSha256Hex(value),
    classification: "internal",
    provenance: {
      source: null,
      producer: { kind: "agent_driver", id: PROVIDER_BOUNDARY_DRIVER_COMPONENT_ID },
      capturedAt: request.objective.submittedAt,
    },
    retentionClass: "request",
    transformation: null,
    value,
    jsonSchema: null,
  });
  if (parsed.modality !== "json") {
    throw createDomainError({
      code: "invariant_violated",
      message: "The provider objective block changed modality.",
    });
  }
  return parsed;
}

function stableAgentRequestProjection(request: AgentTurnRequest): unknown {
  return {
    ...request,
    observations: request.observations.map((observation) => ({
      ...observation,
      error:
        observation.error === null
          ? null
          : {
              code: observation.error.code,
              message: observation.error.message,
              retry: observation.error.retry,
            },
    })),
  };
}
