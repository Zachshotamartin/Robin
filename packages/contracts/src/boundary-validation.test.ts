import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  AgentAttemptIdKind,
  ApprovalIdKind,
  ArtifactIdKind,
  DriverProposalIdKind,
  EventIdKind,
  PolicyVersionIdKind,
  RunIdKind,
  createDomainError,
  isDomainError,
  isEventEnvelope,
  isGenericEvent,
  isGenericEventEnvelope,
  isNewEvent,
  parseDomainError,
  parseEventEnvelope,
  parseGenericEvent,
  parseGenericEventEnvelope,
  parseNewEvent,
  parseActorIdentity,
  parseContentBlock,
  parseNormalizedAction,
  parseObjectiveEnvelope,
  parseObservation,
  parseOutcomeEnvelope,
  parseResourceRef,
  parseTaskProfile,
  parseVersionedSchema,
  type ContentBlock,
  type EventEnvelope,
  type GenericEvent,
  type GenericEventEnvelope,
  type GenericEventPayloadMap,
  type GenericEventType,
  type NewEvent,
  type NormalizedAction,
  type ObjectiveEnvelope,
  type Observation,
  type OrphanedRunResult,
  type OutcomeEnvelope,
  type TaskProfile,
} from "./index.js";

const RUN_ID = RunIdKind.parse("run_018f05a0-7b01-7000-8000-000000000001");
const EVENT_ID = EventIdKind.parse("evt_018f05a0-7b01-7000-8000-000000000002");
const ATTEMPT_ID = AgentAttemptIdKind.parse(
  "att_018f05a0-7b01-7000-8000-000000000003"
);
const PROPOSAL_ID = DriverProposalIdKind.parse(
  "dpr_018f05a0-7b01-7000-8000-000000000004"
);
const ACTION_ID = ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000005");
const APPROVAL_ID = ApprovalIdKind.parse(
  "apr_018f05a0-7b01-7000-8000-000000000006"
);
const POLICY_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000007"
);
const ARTIFACT_ID = ArtifactIdKind.parse(
  "art_018f05a0-7b01-7000-8000-000000000008"
);

const TIME = "2026-08-30T12:00:00.000Z";
const LATER = "2026-08-30T12:00:01.000Z";
const ACTOR = { kind: "runtime", id: "runtime:test" } as const;

const RESOURCE = {
  schemaVersion: 1,
  scheme: "fixture",
  sourceId: "source:synthetic",
  locator: { record: "alpha" },
  mediaType: "text/plain",
  classification: "internal",
} as const;

const TEXT: ContentBlock = {
  schemaVersion: 1,
  blockId: "block:alpha",
  modality: "text",
  mediaType: "text/plain; charset=utf-8",
  byteLength: 5,
  contentHash: "sha256:alpha",
  classification: "internal",
  provenance: {
    source: RESOURCE,
    producer: { kind: "context_source", id: "source:synthetic" },
    capturedAt: TIME,
  },
  retentionClass: "run",
  transformation: null,
  text: "alpha",
  encoding: "utf-8",
  normalization: "none",
};

const UTF8_TEXT: ContentBlock = {
  ...TEXT,
  blockId: "block:utf8",
  byteLength: 2,
  text: "é",
};

const JSON_CONTENT: ContentBlock = {
  schemaVersion: 1,
  blockId: "block:json",
  modality: "json",
  mediaType: "application/json",
  // Canonical form is {"a":[true,null],"z":"é"}: 26 UTF-8 bytes.
  byteLength: 26,
  contentHash: "sha256:json",
  classification: "internal",
  provenance: TEXT.provenance,
  retentionClass: "run",
  transformation: null,
  value: { z: "é", a: [true, null] },
  jsonSchema: null,
};

const OBJECTIVE: ObjectiveEnvelope = {
  schemaVersion: 1,
  profileId: "profile:synthetic",
  profileVersion: 1,
  objectiveType: "synthetic.transform",
  objectiveTypeVersion: 1,
  payload: { input: "alpha" },
  submittedBy: { kind: "user", id: "user:test" },
  submittedAt: TIME,
};

const PROFILE: TaskProfile = {
  schemaVersion: 1,
  profileId: "profile:synthetic",
  profileVersion: 1,
  objectiveSchema: {
    schemaId: "schema:objective",
    schemaVersion: 1,
    document: { type: "object" },
  },
  driverProfile: {
    componentId: "driver:scripted",
    componentVersion: 1,
    configuration: {},
  },
  modelBindings: [],
  contextSources: [],
  capabilityPacks: [],
  policyProfile: {
    componentId: "policy:default",
    componentVersion: 1,
    configuration: {},
  },
  outcomeSchema: {
    schemaId: "schema:outcome",
    schemaVersion: 1,
    document: { type: "object" },
  },
  budgetPolicy: {
    maxTurns: 4,
    maxActions: 2,
    maxElapsedMs: 10_000,
    maxInputBytes: 10_000,
    maxOutputBytes: 10_000,
    extensions: {},
  },
  evidenceMode: "ephemeral_metadata",
  evaluationProfile: null,
};

const ACTION: NormalizedAction = {
  schemaVersion: 1,
  actionId: ACTION_ID,
  capabilityPackId: "capability:synthetic",
  capabilityPackVersion: 1,
  operationId: "synthetic.transform",
  operationVersion: 1,
  subject: { actor: "driver:scripted" },
  resource: { record: "alpha" },
  environment: { mode: "memory" },
  request: { reason: "test" },
  normalizedInput: { input: "alpha" },
  sideEffectClass: "none",
  preconditions: [{
    preconditionType: "fixture.exists",
    preconditionVersion: 1,
    attributes: { record: "alpha" },
  }],
};

const FAILURE = createDomainError({
  code: "action_failed",
  message: "The synthetic action failed safely.",
  details: { category: "fixture" },
});

const OBSERVATION: Observation = {
  schemaVersion: 1,
  observationId: "observation:alpha",
  actionId: ACTION_ID,
  status: "succeeded",
  audit: { resultHash: "sha256:result" },
  human: [TEXT],
  agent: [TEXT],
  error: null,
  occurredAt: LATER,
};

const OUTCOME: OutcomeEnvelope = {
  schemaVersion: 1,
  outcomeId: "outcome:alpha",
  profileId: PROFILE.profileId,
  profileVersion: PROFILE.profileVersion,
  outcomeType: "synthetic.result",
  outcomeTypeVersion: 1,
  payload: { answer: "alpha" },
  evidence: [{
    kind: "observation",
    referenceId: OBSERVATION.observationId,
    contentHash: "sha256:result",
  }],
  proposedAt: LATER,
};

const FAILED_RESULT = {
  schemaVersion: 1,
  runId: RUN_ID,
  status: "failed",
  finishedAt: LATER,
  error: FAILURE,
} as const;

const ORPHANED_RESULT: OrphanedRunResult = {
  schemaVersion: 1,
  runId: RUN_ID,
  status: "orphaned",
  finishedAt: LATER,
  error: FAILURE,
};

const PAYLOADS: GenericEventPayloadMap = {
  RunCreated: { objective: OBJECTIVE },
  TaskProfilePinned: { taskProfile: PROFILE },
  RunStarted: { startedAt: TIME },
  RunIntentAppended: {
    intentType: "follow_up",
    intentVersion: 1,
    payload: { instruction: "continue" },
    submittedBy: { kind: "user", id: "user:test" },
  },
  RunPaused: { reason: "operator" },
  RunResumed: { resumedAt: LATER },
  CancellationRequested: { reason: null },
  RunCancelled: {
    result: {
      schemaVersion: 1,
      runId: RUN_ID,
      status: "cancelled",
      finishedAt: LATER,
      reason: "operator",
    },
  },
  RunFailed: { result: FAILED_RESULT },
  RunCompleted: {
    result: {
      schemaVersion: 1,
      runId: RUN_ID,
      status: "completed",
      finishedAt: LATER,
      outcome: OUTCOME,
    },
  },
  RunOrphaned: { result: ORPHANED_RESULT },
  AgentDriverStarted: {
    driverProfileId: "driver:scripted",
    driverProfileVersion: 1,
    driverFingerprint: "sha256:driver",
  },
  AgentAttemptStarted: { attemptId: ATTEMPT_ID, turn: 1 },
  AgentContentCompleted: { attemptId: ATTEMPT_ID, content: [TEXT] },
  AgentUsageRecorded: { attemptId: ATTEMPT_ID, usage: { planningUnits: 1 } },
  AgentAttemptUncertain: { attemptId: ATTEMPT_ID, error: FAILURE },
  AgentAttemptFailed: { attemptId: ATTEMPT_ID, error: FAILURE },
  ContextRequested: { requestId: "request:context", resource: RESOURCE },
  ContextReleased: {
    requestId: "request:context",
    resource: RESOURCE,
    content: [TEXT],
  },
  ContextDenied: { requestId: "request:context", error: FAILURE },
  ContextRedacted: {
    requestId: "request:context",
    transformationIds: ["transform:redact"],
  },
  ActionProposed: {
    proposalId: PROPOSAL_ID,
    capabilityPackId: "capability:synthetic",
    capabilityPackVersion: 1,
    operationId: "synthetic.transform",
    operationVersion: 1,
    input: { input: "alpha" },
  },
  ActionNormalized: { action: ACTION },
  PolicyEvaluated: {
    actionId: ACTION_ID,
    policyVersionId: POLICY_ID,
    decision: "allow",
    trace: { ruleId: "allow-synthetic" },
  },
  ActionDenied: { actionId: ACTION_ID, error: FAILURE },
  ActionStarted: { actionId: ACTION_ID, startedAt: TIME },
  ActionSucceeded: { actionId: ACTION_ID, completedAt: LATER },
  ActionFailed: { actionId: ACTION_ID, error: FAILURE },
  ActionReconciled: {
    actionId: ACTION_ID,
    disposition: "succeeded",
    evidence: { resultHash: "sha256:result" },
  },
  ObservationReleased: { observation: OBSERVATION },
  ApprovalRequested: {
    approvalId: APPROVAL_ID,
    actionId: ACTION_ID,
    preconditionHash: "sha256:preconditions",
  },
  ApprovalGranted: {
    approvalId: APPROVAL_ID,
    grantedBy: { kind: "user", id: "user:approver" },
  },
  ApprovalDenied: {
    approvalId: APPROVAL_ID,
    deniedBy: { kind: "user", id: "user:approver" },
  },
  ApprovalExpired: { approvalId: APPROVAL_ID },
  ApprovalInvalidated: { approvalId: APPROVAL_ID, reason: "precondition_changed" },
  ApprovalConsumed: { approvalId: APPROVAL_ID, actionId: ACTION_ID },
  OutcomeProposed: { outcome: OUTCOME },
  OutcomeValidated: {
    outcomeId: OUTCOME.outcomeId,
    evidence: OUTCOME.evidence,
    validatedAt: LATER,
  },
  ArtifactReferenced: {
    artifactId: ARTIFACT_ID,
    contentHash: "sha256:artifact",
    mediaType: "application/json",
  },
  RetryScheduled: { attemptType: "agent", ordinal: 1, scheduledAt: LATER },
  BudgetExceeded: { budget: "maxActions", consumed: 2, limit: 2 },
  RecoveryStarted: { recoveryId: "recovery:one", startedAt: TIME },
  RecoveryCompleted: { recoveryId: "recovery:one", disposition: "recovered" },
};

function event<TType extends GenericEventType>(
  eventType: TType
): Extract<GenericEvent, { readonly eventType: TType }> {
  return {
    eventId: EVENT_ID,
    eventType,
    eventSchemaVersion: 1,
    occurredAt: TIME,
    actor: ACTOR,
    correlationId: "correlation:test",
    causationId: null,
    payload: PAYLOADS[eventType],
  } as Extract<GenericEvent, { readonly eventType: TType }>;
}

function envelope<TType extends GenericEventType>(
  eventType: TType
): Extract<GenericEventEnvelope, { readonly eventType: TType }> {
  return {
    ...event(eventType),
    streamId: RUN_ID,
    streamVersion: 1,
    recordedAt: LATER,
  } as Extract<GenericEventEnvelope, { readonly eventType: TType }>;
}

test("strict generic-event validation covers every known event family", () => {
  for (const eventType of Object.keys(PAYLOADS) as GenericEventType[]) {
    const newEvent = event(eventType);
    const recorded = envelope(eventType);
    assert.equal(isGenericEvent(newEvent), true, eventType);
    assert.equal(isGenericEventEnvelope(recorded), true, eventType);
    assert.deepEqual(parseGenericEvent(newEvent), newEvent, eventType);
    assert.deepEqual(parseGenericEventEnvelope(recorded), recorded, eventType);
  }
});

test("every known event family rejects an arbitrary JSON payload", () => {
  for (const eventType of Object.keys(PAYLOADS) as GenericEventType[]) {
    const malformed = { ...event(eventType), payload: {} };
    const malformedEnvelope = {
      ...malformed,
      streamId: RUN_ID,
      streamVersion: 1,
      recordedAt: LATER,
    };
    assert.equal(isNewEvent(malformed), true, `${eventType} remains valid framing`);
    assert.equal(isGenericEvent(malformed), false, eventType);
    assert.equal(isGenericEventEnvelope(malformedEnvelope), false, eventType);
    assert.throws(
      () => parseGenericEvent(malformed),
      (error: unknown) => isDomainError(error) && error.code === "invalid_input",
      eventType
    );
  }
});

test("known payload validation is exact and validates nested contracts", () => {
  const mutations: readonly [GenericEventType, (payload: Record<string, unknown>) => void][] = [
    ["RunCreated", (payload) => {
      (payload["objective"] as Record<string, unknown>)["schemaVersion"] = 2;
    }],
    ["TaskProfilePinned", (payload) => {
      (payload["taskProfile"] as Record<string, unknown>)["unexpected"] = true;
    }],
    ["AgentContentCompleted", (payload) => {
      ((payload["content"] as unknown[])[0] as Record<string, unknown>)["modality"] = "video";
    }],
    ["ActionProposed", (payload) => { payload["capabilityPackVersion"] = 0; }],
    ["ActionNormalized", (payload) => {
      (payload["action"] as Record<string, unknown>)["operationVersion"] = 0;
    }],
    ["ObservationReleased", (payload) => {
      (payload["observation"] as Record<string, unknown>)["occurredAt"] = "not-a-time";
    }],
    ["OutcomeProposed", (payload) => {
      const evidence = (payload["outcome"] as { evidence: Record<string, unknown>[] }).evidence;
      evidence[0]!["kind"] = "citation";
    }],
    ["AgentAttemptFailed", (payload) => {
      (payload["error"] as Record<string, unknown>)["unexpected"] = true;
    }],
    ["RunFailed", (payload) => {
      (payload["result"] as Record<string, unknown>)["status"] = "orphaned";
    }],
    ["RunOrphaned", (payload) => {
      (payload["result"] as Record<string, unknown>)["status"] = "failed";
    }],
  ];

  for (const [eventType, mutate] of mutations) {
    const candidate = structuredClone(event(eventType)) as unknown as {
      payload: Record<string, unknown>;
    };
    mutate(candidate.payload);
    assert.equal(isGenericEvent(candidate), false, eventType);
  }

  const extra = structuredClone(event("RunStarted")) as unknown as {
    payload: Record<string, unknown>;
  };
  extra.payload["providerRequestId"] = "must-not-cross";
  assert.equal(isGenericEvent(extra), false);
});

test("extensible framing remains distinct from the known generic event union", () => {
  const extension: NewEvent<"coding.PatchProduced", { readonly patchHash: string }> = {
    eventId: EVENT_ID,
    eventType: "coding.PatchProduced",
    eventSchemaVersion: 1,
    occurredAt: TIME,
    actor: { kind: "capability_worker", id: "worker:coding" },
    correlationId: "correlation:extension",
    causationId: null,
    payload: { patchHash: "sha256:patch" },
  };
  assert.equal(isNewEvent(extension), true);
  assert.equal(isGenericEvent(extension), false);
  const snapshot = parseNewEvent(extension);
  assert.deepEqual(snapshot, extension);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.payload), true);
});

test("event and error guards never invoke caller get traps or trust proxy views", () => {
  const secret = "SECRET_GET_TRAP_CANARY_4c4a";
  const validError = JSON.parse(JSON.stringify(FAILURE)) as Record<string, unknown>;
  let errorGets = 0;
  const forgedError = new Proxy(
    { errorId: "bad", code: "bad", message: "bad", retry: "bad" },
    {
      get(_target, key) {
        errorGets += 1;
        if (key in validError) return validError[key as string];
        throw new Error(secret);
      },
    }
  );
  assert.equal(isDomainError(forgedError), false);
  assert.equal(errorGets, 0);
  assert.throws(
    () => parseDomainError(forgedError),
    (error: unknown) =>
      isDomainError(error) &&
      error.code === "invalid_input" &&
      !error.message.includes(secret)
  );

  const validEnvelope = envelope("RunCreated") as unknown as Record<string, unknown>;
  let envelopeGets = 0;
  const forgedEnvelope = new Proxy(
    Object.fromEntries(Object.keys(validEnvelope).map((key) => [key, null])),
    {
      get(_target, key) {
        envelopeGets += 1;
        if (key in validEnvelope) return validEnvelope[key as string];
        throw new Error(secret);
      },
    }
  );
  assert.equal(isEventEnvelope(forgedEnvelope), false);
  assert.equal(isGenericEventEnvelope(forgedEnvelope), false);
  assert.equal(envelopeGets, 0);
  assert.throws(
    () => parseEventEnvelope(forgedEnvelope),
    (error: unknown) =>
      isDomainError(error) &&
      error.code === "invalid_input" &&
      !error.message.includes(secret)
  );

  const revoked = Proxy.revocable(validEnvelope, {});
  revoked.revoke();
  assert.equal(isEventEnvelope(revoked.proxy), false);
  assert.equal(isGenericEventEnvelope(revoked.proxy), false);
});

test("snapshot-returning parsers detach and deeply freeze accepted values", () => {
  const mutableError = JSON.parse(JSON.stringify(FAILURE)) as Record<string, unknown>;
  const parsedError = parseDomainError(mutableError);
  (mutableError["details"] as Record<string, unknown>)["category"] = "tampered";
  assert.equal(parsedError.details?.["category"], "fixture");
  assert.equal(Object.isFrozen(parsedError), true);
  assert.equal(Object.isFrozen(parsedError.details), true);

  const mutableEvent = structuredClone(envelope("RunCreated"));
  const parsed = parseGenericEventEnvelope(mutableEvent);
  (mutableEvent.payload.objective.payload as { input: string }).input = "tampered";
  assert.equal(
    (parsed.payload as GenericEventPayloadMap["RunCreated"]).objective.payload["input"],
    "alpha"
  );
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.payload), true);
});

test("direct contract parsers return strict detached immutable snapshots", () => {
  const cases: readonly [string, (value: unknown) => unknown, unknown][] = [
    ["actor", parseActorIdentity, ACTOR],
    ["objective", parseObjectiveEnvelope, OBJECTIVE],
    ["task profile", parseTaskProfile, PROFILE],
    ["resource", parseResourceRef, RESOURCE],
    ["content block", parseContentBlock, TEXT],
    ["normalized action", parseNormalizedAction, ACTION],
    ["observation", parseObservation, OBSERVATION],
    ["outcome", parseOutcomeEnvelope, OUTCOME],
    ["versioned schema", parseVersionedSchema, PROFILE.objectiveSchema],
  ];

  for (const [label, parse, valid] of cases) {
    const mutable = structuredClone(valid) as Record<string, unknown>;
    const parsed = parse(mutable) as Record<string, unknown>;
    assert.deepEqual(parsed, mutable, label);
    assert.notStrictEqual(parsed, mutable, label);
    assert.equal(Object.isFrozen(parsed), true, label);

    const withExtra = structuredClone(valid) as Record<string, unknown>;
    withExtra["providerRequestId"] = "must-not-cross";
    assert.throws(
      () => parse(withExtra),
      (error: unknown) => isDomainError(error) && error.code === "invalid_input",
      label
    );
  }
});

test("observation status and error are correlated", () => {
  const succeededWithError = {
    ...structuredClone(OBSERVATION),
    error: FAILURE,
  };
  assert.throws(
    () => parseObservation(succeededWithError),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input"
  );

  for (const status of ["failed", "denied", "uncertain"] as const) {
    const missingError = {
      ...structuredClone(OBSERVATION),
      status,
    };
    assert.throws(
      () => parseObservation(missingError),
      (error: unknown) => isDomainError(error) && error.code === "invalid_input",
      `${status} without an error`
    );

    const withError = {
      ...structuredClone(OBSERVATION),
      status,
      error: FAILURE,
    };
    assert.deepEqual(parseObservation(withError), withError, `${status} with an error`);
  }
});

test("inline content byteLength is bound to the exact UTF-8 representation", () => {
  assert.deepEqual(parseContentBlock(UTF8_TEXT), UTF8_TEXT);
  const textJustUnder = { ...structuredClone(UTF8_TEXT), byteLength: 1 };
  assert.throws(
    () => parseContentBlock(textJustUnder),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input"
  );

  assert.deepEqual(parseContentBlock(JSON_CONTENT), JSON_CONTENT);
  const jsonJustUnder = { ...structuredClone(JSON_CONTENT), byteLength: 25 };
  assert.throws(
    () => parseContentBlock(jsonJustUnder),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input"
  );

  const jsonMismatched = { ...structuredClone(JSON_CONTENT), byteLength: 0 };
  assert.throws(
    () => parseContentBlock(jsonMismatched),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input"
  );
});

test("direct contract parsers reject hostile proxies and accessors without invoking them", () => {
  const secret = "DIRECT_PARSER_SECRET_CANARY_a81e";
  let getCalls = 0;
  const proxy = new Proxy(structuredClone(OBJECTIVE), {
    get(target, key, receiver) {
      getCalls += 1;
      if (key === "payload") throw new Error(secret);
      return Reflect.get(target, key, receiver);
    },
  });
  assert.throws(
    () => parseObjectiveEnvelope(proxy),
    (error: unknown) =>
      isDomainError(error) &&
      error.code === "invalid_input" &&
      !error.message.includes(secret)
  );
  assert.equal(getCalls, 0);

  let getterCalls = 0;
  const accessor = structuredClone(RESOURCE) as Record<string, unknown>;
  Object.defineProperty(accessor, "locator", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(secret);
    },
  });
  assert.throws(
    () => parseResourceRef(accessor),
    (error: unknown) =>
      isDomainError(error) &&
      error.code === "invalid_input" &&
      !error.message.includes(secret)
  );
  assert.equal(getterCalls, 0);
});

// Compile-time correlation: failed and orphaned terminal results are distinct.
const _validOrphaned: OrphanedRunResult = ORPHANED_RESULT;
// @ts-expect-error RunFailed cannot carry an orphaned terminal result.
const _invalidFailedResult: GenericEventPayloadMap["RunFailed"]["result"] = ORPHANED_RESULT;
void _validOrphaned;
void _invalidFailedResult;
