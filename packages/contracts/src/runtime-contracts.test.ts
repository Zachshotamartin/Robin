import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  GENERIC_EVENT_TYPES,
  ActionIdKind,
  ArtifactIdKind,
  EventIdKind,
  RunIdKind,
  assertContractSchemaVersion,
  isContractSchemaVersion,
  isEventEnvelope,
  isGenericEventType,
  type ActorIdentity,
  type ContentBlock,
  type EventEnvelope,
  type GenericEvent,
  type JsonObject,
  type NormalizedAction,
  type ObjectiveEnvelope,
  type Observation,
  type OutcomeEnvelope,
  type ResourceRef,
  type RunResult,
  type TaskProfile,
} from "./index.js";

const ACTOR: ActorIdentity = { kind: "user", id: "user:test" };

const RESOURCE: ResourceRef = {
  schemaVersion: 1,
  scheme: "fixture",
  sourceId: "source:synthetic",
  locator: { record: "alpha" },
  mediaType: "application/json",
  classification: "internal",
};

const TEXT_BLOCK: ContentBlock = {
  schemaVersion: 1,
  blockId: "block:summary",
  modality: "text",
  mediaType: "text/plain; charset=utf-8",
  byteLength: 12,
  contentHash: "sha256:summary",
  classification: "internal",
  provenance: {
    source: RESOURCE,
    producer: { kind: "context_source", id: "source:synthetic" },
    capturedAt: "2026-08-30T12:00:00.000Z",
  },
  retentionClass: "run",
  transformation: null,
  text: "safe summary",
  encoding: "utf-8",
  normalization: "none",
};

const OBJECTIVE: ObjectiveEnvelope = {
  schemaVersion: 1,
  profileId: "profile:synthetic",
  profileVersion: 1,
  objectiveType: "synthetic.transform",
  objectiveTypeVersion: 1,
  payload: { input: "alpha" },
  submittedBy: ACTOR,
  submittedAt: "2026-08-30T12:00:00.000Z",
};

const PROFILE: TaskProfile = {
  schemaVersion: 1,
  profileId: "profile:synthetic",
  profileVersion: 1,
  objectiveSchema: {
    schemaId: "schema:synthetic-objective",
    schemaVersion: 1,
    document: { type: "object" },
  },
  driverProfile: {
    componentId: "driver:scripted",
    componentVersion: 1,
    configuration: {},
  },
  modelBindings: [],
  contextSources: [{
    bindingId: "source:synthetic",
    componentId: "context:memory",
    componentVersion: 1,
    configuration: {},
  }],
  capabilityPacks: [{
    bindingId: "capability:synthetic",
    componentId: "capability:memory",
    componentVersion: 1,
    configuration: {},
  }],
  policyProfile: {
    componentId: "policy:deny-by-default",
    componentVersion: 1,
    configuration: {},
  },
  outcomeSchema: {
    schemaId: "schema:synthetic-outcome",
    schemaVersion: 1,
    document: { type: "object" },
  },
  budgetPolicy: {
    maxTurns: 5,
    maxActions: 3,
    maxElapsedMs: 60_000,
    maxInputBytes: 1_000_000,
    maxOutputBytes: 1_000_000,
    extensions: {},
  },
  evidenceMode: "ephemeral_metadata",
  evaluationProfile: null,
};

const ACTION: NormalizedAction = {
  schemaVersion: 1,
  actionId: ActionIdKind.generate(),
  capabilityPackId: "capability:synthetic",
  operationId: "synthetic.transform",
  operationVersion: 1,
  subject: { kind: "agent_driver", id: "driver:scripted" },
  resource: { scheme: "fixture", sourceId: "source:synthetic" },
  environment: { mode: "in_memory" },
  request: { reason: "fulfil objective" },
  normalizedInput: { input: "alpha" },
  sideEffectClass: "none",
  preconditions: [],
};

const OBSERVATION: Observation = {
  schemaVersion: 1,
  observationId: "observation:alpha",
  actionId: ACTION.actionId,
  status: "succeeded",
  audit: { resultHash: "sha256:result" },
  human: [TEXT_BLOCK],
  agent: [TEXT_BLOCK],
  error: null,
  occurredAt: "2026-08-30T12:00:01.000Z",
};

const OUTCOME: OutcomeEnvelope = {
  schemaVersion: 1,
  outcomeId: "outcome:alpha",
  profileId: PROFILE.profileId,
  profileVersion: PROFILE.profileVersion,
  outcomeType: "synthetic.result",
  outcomeTypeVersion: 1,
  payload: { answer: "alpha transformed" },
  evidence: [{
    kind: "observation",
    referenceId: OBSERVATION.observationId,
    contentHash: "sha256:result",
  }],
  proposedAt: "2026-08-30T12:00:02.000Z",
};

test("all top-level generic contracts pin the current schema version", () => {
  const result: RunResult = {
    schemaVersion: 1,
    runId: RunIdKind.generate(),
    status: "completed",
    finishedAt: "2026-08-30T12:00:03.000Z",
    outcome: OUTCOME,
  };

  assert.equal(CONTRACT_SCHEMA_VERSION, 1);
  for (const contract of [
    PROFILE, OBJECTIVE, RESOURCE, TEXT_BLOCK, ACTION, OBSERVATION, OUTCOME, result,
  ]) {
    assert.equal(contract.schemaVersion, CONTRACT_SCHEMA_VERSION);
  }
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("schema-version guard accepts only the exact supported integer", () => {
  assert.equal(isContractSchemaVersion(1), true);
  for (const value of [0, 2, -1, 1.5, "1", null, undefined]) {
    assert.equal(isContractSchemaVersion(value), false);
    assert.throws(
      () => assertContractSchemaVersion(value, "test contract"),
      (error: unknown) =>
        typeof error === "object" && error !== null &&
        "code" in error && error.code === "invalid_input"
    );
  }
});

test("content is a modality-discriminated JSON-serializable union", () => {
  const jsonBlock: ContentBlock = {
    ...TEXT_BLOCK,
    blockId: "block:json",
    modality: "json",
    mediaType: "application/json",
    value: { ok: true },
    jsonSchema: null,
  };
  const artifactId = ArtifactIdKind.generate();
  const binaryBlocks: readonly ContentBlock[] = [
    { ...TEXT_BLOCK, blockId: "block:image", modality: "image", mediaType: "image/png", artifactId, width: 640, height: 480 },
    { ...TEXT_BLOCK, blockId: "block:audio", modality: "audio", mediaType: "audio/wav", artifactId, durationMs: 1_000, sampleRateHz: 48_000, channels: 2 },
    { ...TEXT_BLOCK, blockId: "block:document", modality: "document", mediaType: "application/pdf", artifactId, pageCount: 3 },
    { ...TEXT_BLOCK, blockId: "block:embedding", modality: "embedding", mediaType: "application/vnd.guard.embedding-reference+json", vectorStoreId: "vectors:local", vectorId: "vector:alpha", dimensions: 384, modelProfileId: "model:embedding" },
  ];

  assert.deepEqual(
    [TEXT_BLOCK, jsonBlock, ...binaryBlocks].map((block) => block.modality),
    ["text", "json", "image", "audio", "document", "embedding"]
  );
  assert.doesNotThrow(() => JSON.stringify([TEXT_BLOCK, jsonBlock, ...binaryBlocks]));
});

test("the initial generic event union is explicit, unique, and domain-neutral", () => {
  assert.equal(GENERIC_EVENT_TYPES.length >= 40, true);
  assert.equal(new Set(GENERIC_EVENT_TYPES).size, GENERIC_EVENT_TYPES.length);
  for (const eventType of GENERIC_EVENT_TYPES) {
    assert.equal(isGenericEventType(eventType), true);
    assert.equal(eventType.includes("coding."), false);
    assert.equal(eventType.includes("research."), false);
  }
  assert.equal(isGenericEventType("coding.PatchProduced"), false);
  assert.equal(isGenericEventType("RunCreated"), true);
  assert.equal(isGenericEventType("RunCompleted"), true);
});

test("generic event envelopes preserve stable metadata and validate strictly", () => {
  const event: GenericEvent = {
    eventId: EventIdKind.generate(),
    eventType: "RunCreated",
    eventSchemaVersion: 1,
    occurredAt: "2026-08-30T12:00:00.000Z",
    actor: { kind: "runtime", id: "runtime:local" },
    correlationId: "correlation:test",
    causationId: null,
    payload: { objective: OBJECTIVE },
  };
  const envelope: EventEnvelope<"RunCreated", typeof event.payload> = {
    ...event,
    streamId: RunIdKind.generate(),
    streamVersion: 1,
    recordedAt: "2026-08-30T12:00:00.001Z",
  };

  assert.equal(isEventEnvelope(envelope), true);
  assert.equal(isEventEnvelope({ ...envelope, eventSchemaVersion: 2 }), false);
  assert.equal(isEventEnvelope({ ...envelope, streamVersion: 0 }), false);
  assert.equal(isEventEnvelope({ ...envelope, eventId: "evt_not-an-id" }), false);
  assert.equal(isEventEnvelope({ ...envelope, payload: { invalid: undefined } }), false);
  assert.equal(isEventEnvelope({ ...envelope, unexpected: true }), false);
});

test("generic payloads remain JSON data rather than executable domain objects", () => {
  const payloads: readonly JsonObject[] = [
    OBJECTIVE.payload,
    RESOURCE.locator,
    ACTION.normalizedInput,
    OBSERVATION.audit,
    OUTCOME.payload,
  ];
  for (const payload of payloads) {
    assert.doesNotThrow(() => JSON.stringify(payload));
  }
});
