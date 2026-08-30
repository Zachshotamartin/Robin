import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ActionIdKind,
  AgentAttemptIdKind,
  ApprovalIdKind,
  ArtifactIdKind,
  DriverProposalIdKind,
  EventIdKind,
  GENERIC_EVENT_TYPES,
  PolicyVersionIdKind,
  RunIdKind,
  canonicalize,
  isDomainError,
  parseGenericEventEnvelope,
} from "@guard/contracts";
import type {
  ActorIdentity,
  ContentBlock,
  DomainError,
  GenericEvent,
  GenericEventEnvelope,
  GenericEventPayloadMap,
  GenericEventType,
  NormalizedAction,
  Observation,
  RunResult,
} from "@guard/contracts";

import {
  EVENT_LEGAL_STATES,
  INTENT_LEGAL_STATES,
  RUN_LIFECYCLE_STATUSES,
  createInitialRunState,
  decide,
  evolve,
  planEffects,
  replay,
} from "./index.js";
import type {
  RunIntent,
  RunIntentType,
  RunProjectionStatus,
  RunState,
} from "./index.js";
import {
  GOLDEN_OBJECTIVE,
  GOLDEN_OUTCOME,
  GOLDEN_PROFILE,
} from "./testdata/golden-history.js";

const RUN_ID = RunIdKind.parse(
  "run_018f0000-0000-7000-8000-00000000a001",
);
const ATTEMPT_ID = AgentAttemptIdKind.parse(
  "att_018f0000-0000-7000-8000-00000000a002",
);
const PROPOSAL_ID = DriverProposalIdKind.parse(
  "dpr_018f0000-0000-7000-8000-00000000a003",
);
const ACTION_ID = ActionIdKind.parse(
  "act_018f0000-0000-7000-8000-00000000a004",
);
const APPROVAL_ID = ApprovalIdKind.parse(
  "apr_018f0000-0000-7000-8000-00000000a005",
);
const POLICY_ID = PolicyVersionIdKind.parse(
  "pol_018f0000-0000-7000-8000-00000000a006",
);
const ARTIFACT_ID = ArtifactIdKind.parse(
  "art_018f0000-0000-7000-8000-00000000a007",
);
const ERROR_ID = "err_018f0000-0000-7000-8000-00000000a008" as DomainError["errorId"];
const DENIAL_ERROR_ID =
  "err_018f0000-0000-7000-8000-00000000a009" as DomainError["errorId"];
const TIME = "2026-08-31T00:00:00.000Z";
const ACTOR: ActorIdentity = Object.freeze({
  kind: "runtime",
  id: "runtime:gate-a-evidence",
});

const FAILURE: DomainError = Object.freeze({
  errorId: ERROR_ID,
  code: "action_failed",
  message: "The deterministic fixture failed safely.",
  retry: "terminal",
});
const DENIAL: DomainError = Object.freeze({
  errorId: DENIAL_ERROR_ID,
  code: "policy_denied",
  message: "The deterministic fixture was denied.",
  retry: "terminal",
});
const RESOURCE = Object.freeze({
  schemaVersion: 1 as const,
  scheme: "fixture",
  sourceId: "source:gate-a",
  locator: Object.freeze({ record: "alpha" }),
  mediaType: "text/plain",
  classification: "internal",
});
const CONTENT: ContentBlock = Object.freeze({
  schemaVersion: 1,
  blockId: "block:gate-a-alpha",
  modality: "text",
  mediaType: "text/plain; charset=utf-8",
  byteLength: 5,
  contentHash: "sha256:gate-a-alpha",
  classification: "internal",
  provenance: Object.freeze({
    source: RESOURCE,
    producer: Object.freeze({ kind: "context_source", id: "source:gate-a" }),
    capturedAt: TIME,
  }),
  retentionClass: "run",
  transformation: null,
  text: "alpha",
  encoding: "utf-8",
  normalization: "none",
});
const ACTION: NormalizedAction = Object.freeze({
  schemaVersion: 1,
  actionId: ACTION_ID,
  capabilityPackId: "synthetic.transform",
  capabilityPackVersion: 1,
  operationId: "synthetic.transform",
  operationVersion: 1,
  subject: Object.freeze({ kind: "agent_driver", id: "driver:scripted" }),
  resource: Object.freeze({ scheme: "fixture", record: "alpha" }),
  environment: Object.freeze({ mode: "in_memory" }),
  request: Object.freeze({ reason: "gate-a evidence" }),
  normalizedInput: Object.freeze({ input: "alpha" }),
  sideEffectClass: "local_reversible",
  preconditions: Object.freeze([]),
});
const SUCCESS_OBSERVATION: Observation = Object.freeze({
  schemaVersion: 1,
  observationId: "observation:gate-a-success",
  actionId: ACTION_ID,
  status: "succeeded",
  audit: Object.freeze({ receipt: "sha256:gate-a-success" }),
  human: Object.freeze([]),
  agent: Object.freeze([]),
  error: null,
  occurredAt: TIME,
});

interface Projection {
  readonly history: readonly GenericEventEnvelope[];
  readonly state: RunState;
}

interface EventOracle {
  readonly prior: Projection;
  readonly event: GenericEventEnvelope;
}

function eventEnvelope<TType extends GenericEventType>(
  state: RunState,
  eventType: TType,
  payload: GenericEventPayloadMap[TType],
): Extract<GenericEventEnvelope, { readonly eventType: TType }> {
  const streamVersion = state.streamVersion + 1;
  const instant = new Date(Date.UTC(2026, 7, 31, 0, 0, streamVersion));
  const suffix = (0xa100 + streamVersion).toString(16).padStart(12, "0");
  return {
    eventId: EventIdKind.parse(
      `evt_018f0000-0000-7000-8000-${suffix}`,
    ),
    streamId: state.runId ?? RUN_ID,
    streamVersion,
    eventType,
    eventSchemaVersion: 1,
    occurredAt: instant.toISOString(),
    recordedAt: instant.toISOString(),
    actor: ACTOR,
    correlationId: "correlation:gate-a-evidence",
    causationId: state.lastEventId,
    payload,
  } as Extract<GenericEventEnvelope, { readonly eventType: TType }>;
}

function append<TType extends GenericEventType>(
  prior: Projection,
  eventType: TType,
  payload: GenericEventPayloadMap[TType],
): Projection {
  const event = eventEnvelope(prior.state, eventType, payload);
  return Object.freeze({
    history: Object.freeze([...prior.history, event]),
    state: evolve(prior.state, event),
  });
}

function oracle<TType extends GenericEventType>(
  prior: Projection,
  eventType: TType,
  payload: GenericEventPayloadMap[TType],
): EventOracle {
  return Object.freeze({
    prior,
    event: eventEnvelope(prior.state, eventType, payload),
  });
}

function initial(): Projection {
  return Object.freeze({ history: Object.freeze([]), state: createInitialRunState() });
}

function created(): Projection {
  return append(initial(), "RunCreated", { objective: GOLDEN_OBJECTIVE });
}

function profiled(): Projection {
  return append(created(), "TaskProfilePinned", { taskProfile: GOLDEN_PROFILE });
}

function started(): Projection {
  return append(profiled(), "RunStarted", { startedAt: TIME });
}

function driverStarted(): Projection {
  return append(started(), "AgentDriverStarted", {
    driverProfileId: GOLDEN_PROFILE.driverProfile.componentId,
    driverProfileVersion: GOLDEN_PROFILE.driverProfile.componentVersion,
    driverFingerprint: "sha256:gate-a-driver",
  });
}

function waitingForAgent(): Projection {
  return append(driverStarted(), "AgentAttemptStarted", {
    attemptId: ATTEMPT_ID,
    turn: 1,
  });
}

function idlePlanning(): Projection {
  return append(waitingForAgent(), "AgentAttemptFailed", {
    attemptId: ATTEMPT_ID,
    error: FAILURE,
  });
}

function uncertainAttempt(): Projection {
  return append(waitingForAgent(), "AgentAttemptUncertain", {
    attemptId: ATTEMPT_ID,
    error: Object.freeze({
      ...FAILURE,
      code: "attempt_result_uncertain",
      retry: "uncertain",
    }),
  });
}

function proposedAction(): Projection {
  return append(waitingForAgent(), "ActionProposed", {
    proposalId: PROPOSAL_ID,
    capabilityPackId: ACTION.capabilityPackId,
    capabilityPackVersion: ACTION.capabilityPackVersion,
    operationId: ACTION.operationId,
    operationVersion: ACTION.operationVersion,
    input: { input: "alpha" },
  });
}

function normalizedAction(): Projection {
  return append(proposedAction(), "ActionNormalized", { action: ACTION });
}

function policyEvaluated(
  decision: "allow" | "deny" | "require_approval",
): Projection {
  return append(normalizedAction(), "PolicyEvaluated", {
    actionId: ACTION_ID,
    policyVersionId: POLICY_ID,
    decision,
    trace: { rule: `gate-a:${decision}` },
  });
}

function executingAction(): Projection {
  return append(policyEvaluated("allow"), "ActionStarted", {
    actionId: ACTION_ID,
    startedAt: TIME,
  });
}

function recordingSuccess(): Projection {
  return append(executingAction(), "ActionSucceeded", {
    actionId: ACTION_ID,
    completedAt: TIME,
  });
}

function deniedAction(): Projection {
  return append(policyEvaluated("deny"), "ActionDenied", {
    actionId: ACTION_ID,
    error: DENIAL,
  });
}

function contextPending(): Projection {
  return append(waitingForAgent(), "ContextRequested", {
    requestId: "context:gate-a",
    resource: RESOURCE,
  });
}

function approvalWaiting(): Projection {
  return append(policyEvaluated("require_approval"), "ApprovalRequested", {
    approvalId: APPROVAL_ID,
    actionId: ACTION_ID,
    preconditionHash: "sha256:gate-a-precondition",
  });
}

function approvalGranted(): Projection {
  return append(approvalWaiting(), "ApprovalGranted", {
    approvalId: APPROVAL_ID,
    grantedBy: { kind: "user", id: "user:gate-a-approver" },
  });
}

function outcomeProposed(): Projection {
  return append(waitingForAgent(), "OutcomeProposed", { outcome: GOLDEN_OUTCOME });
}

function outcomeValidated(): Projection {
  return append(outcomeProposed(), "OutcomeValidated", {
    outcomeId: GOLDEN_OUTCOME.outcomeId,
    evidence: GOLDEN_OUTCOME.evidence,
    validatedAt: TIME,
  });
}

function paused(): Projection {
  return append(profiled(), "RunPaused", { reason: "gate-a pause" });
}

function cancellationReady(): Projection {
  return append(profiled(), "CancellationRequested", { reason: "gate-a cancel" });
}

function recovering(): Projection {
  return append(idlePlanning(), "RecoveryStarted", {
    recoveryId: "recovery:gate-a",
    startedAt: TIME,
  });
}

function failedResult(state: RunState): Extract<RunResult, { readonly status: "failed" }> {
  return {
    schemaVersion: 1,
    runId: state.runId ?? RUN_ID,
    status: "failed",
    finishedAt: TIME,
    error: FAILURE,
  };
}

function orphanedResult(
  state: RunState,
): Extract<RunResult, { readonly status: "orphaned" }> {
  return {
    schemaVersion: 1,
    runId: state.runId ?? RUN_ID,
    status: "orphaned",
    finishedAt: TIME,
    error: FAILURE,
  };
}

function completedResult(
  state: RunState,
): Extract<RunResult, { readonly status: "completed" }> {
  return {
    schemaVersion: 1,
    runId: state.runId ?? RUN_ID,
    status: "completed",
    finishedAt: TIME,
    outcome: state.validatedOutcome ?? GOLDEN_OUTCOME,
  };
}

function cancelledResult(
  state: RunState,
): Extract<RunResult, { readonly status: "cancelled" }> {
  return {
    schemaVersion: 1,
    runId: state.runId ?? RUN_ID,
    status: "cancelled",
    finishedAt: TIME,
    reason: "gate-a cancel",
  };
}

const EVENT_ORACLE_BUILDERS = {
  RunCreated: () => oracle(initial(), "RunCreated", { objective: GOLDEN_OBJECTIVE }),
  TaskProfilePinned: () =>
    oracle(created(), "TaskProfilePinned", { taskProfile: GOLDEN_PROFILE }),
  RunStarted: () => oracle(profiled(), "RunStarted", { startedAt: TIME }),
  RunIntentAppended: () =>
    oracle(profiled(), "RunIntentAppended", {
      intentType: "follow_up",
      intentVersion: 1,
      payload: { instruction: "continue" },
      submittedBy: { kind: "user", id: "user:gate-a" },
    }),
  RunPaused: () => oracle(profiled(), "RunPaused", { reason: "gate-a pause" }),
  RunResumed: () => oracle(paused(), "RunResumed", { resumedAt: TIME }),
  CancellationRequested: () =>
    oracle(profiled(), "CancellationRequested", { reason: "gate-a cancel" }),
  RunCancelled: () => {
    const prior = cancellationReady();
    return oracle(prior, "RunCancelled", { result: cancelledResult(prior.state) });
  },
  RunFailed: () => {
    const prior = profiled();
    return oracle(prior, "RunFailed", { result: failedResult(prior.state) });
  },
  RunCompleted: () => {
    const prior = outcomeValidated();
    return oracle(prior, "RunCompleted", { result: completedResult(prior.state) });
  },
  RunOrphaned: () => {
    const prior = recovering();
    return oracle(prior, "RunOrphaned", { result: orphanedResult(prior.state) });
  },
  AgentDriverStarted: () =>
    oracle(started(), "AgentDriverStarted", {
      driverProfileId: GOLDEN_PROFILE.driverProfile.componentId,
      driverProfileVersion: GOLDEN_PROFILE.driverProfile.componentVersion,
      driverFingerprint: "sha256:gate-a-driver",
    }),
  AgentAttemptStarted: () =>
    oracle(driverStarted(), "AgentAttemptStarted", { attemptId: ATTEMPT_ID, turn: 1 }),
  AgentContentCompleted: () =>
    oracle(waitingForAgent(), "AgentContentCompleted", {
      attemptId: ATTEMPT_ID,
      content: [CONTENT],
    }),
  AgentUsageRecorded: () =>
    oracle(waitingForAgent(), "AgentUsageRecorded", {
      attemptId: ATTEMPT_ID,
      usage: { inputBytes: 5, outputBytes: 2 },
    }),
  AgentAttemptUncertain: () =>
    oracle(waitingForAgent(), "AgentAttemptUncertain", {
      attemptId: ATTEMPT_ID,
      error: { ...FAILURE, code: "attempt_result_uncertain", retry: "uncertain" },
    }),
  AgentAttemptFailed: () =>
    oracle(waitingForAgent(), "AgentAttemptFailed", {
      attemptId: ATTEMPT_ID,
      error: FAILURE,
    }),
  ContextRequested: () =>
    oracle(waitingForAgent(), "ContextRequested", {
      requestId: "context:gate-a",
      resource: RESOURCE,
    }),
  ContextReleased: () =>
    oracle(contextPending(), "ContextReleased", {
      requestId: "context:gate-a",
      resource: RESOURCE,
      content: [CONTENT],
    }),
  ContextDenied: () =>
    oracle(contextPending(), "ContextDenied", {
      requestId: "context:gate-a",
      error: FAILURE,
    }),
  ContextRedacted: () =>
    oracle(contextPending(), "ContextRedacted", {
      requestId: "context:gate-a",
      transformationIds: ["transform:gate-a"],
    }),
  ActionProposed: () =>
    oracle(waitingForAgent(), "ActionProposed", {
      proposalId: PROPOSAL_ID,
      capabilityPackId: ACTION.capabilityPackId,
      capabilityPackVersion: ACTION.capabilityPackVersion,
      operationId: ACTION.operationId,
      operationVersion: ACTION.operationVersion,
      input: { input: "alpha" },
    }),
  ActionNormalized: () => oracle(proposedAction(), "ActionNormalized", { action: ACTION }),
  PolicyEvaluated: () =>
    oracle(normalizedAction(), "PolicyEvaluated", {
      actionId: ACTION_ID,
      policyVersionId: POLICY_ID,
      decision: "allow",
      trace: { rule: "gate-a:allow" },
    }),
  ActionDenied: () =>
    oracle(policyEvaluated("deny"), "ActionDenied", {
      actionId: ACTION_ID,
      error: DENIAL,
    }),
  ActionStarted: () =>
    oracle(policyEvaluated("allow"), "ActionStarted", {
      actionId: ACTION_ID,
      startedAt: TIME,
    }),
  ActionSucceeded: () =>
    oracle(executingAction(), "ActionSucceeded", {
      actionId: ACTION_ID,
      completedAt: TIME,
    }),
  ActionFailed: () =>
    oracle(executingAction(), "ActionFailed", { actionId: ACTION_ID, error: FAILURE }),
  ActionReconciled: () =>
    oracle(executingAction(), "ActionReconciled", {
      actionId: ACTION_ID,
      disposition: "succeeded",
      evidence: { receipt: "sha256:gate-a-reconciled" },
    }),
  ObservationReleased: () =>
    oracle(recordingSuccess(), "ObservationReleased", {
      observation: SUCCESS_OBSERVATION,
    }),
  ApprovalRequested: () =>
    oracle(policyEvaluated("require_approval"), "ApprovalRequested", {
      approvalId: APPROVAL_ID,
      actionId: ACTION_ID,
      preconditionHash: "sha256:gate-a-precondition",
    }),
  ApprovalGranted: () =>
    oracle(approvalWaiting(), "ApprovalGranted", {
      approvalId: APPROVAL_ID,
      grantedBy: { kind: "user", id: "user:gate-a-approver" },
    }),
  ApprovalDenied: () =>
    oracle(approvalWaiting(), "ApprovalDenied", {
      approvalId: APPROVAL_ID,
      deniedBy: { kind: "user", id: "user:gate-a-approver" },
    }),
  ApprovalExpired: () =>
    oracle(approvalWaiting(), "ApprovalExpired", { approvalId: APPROVAL_ID }),
  ApprovalInvalidated: () =>
    oracle(approvalWaiting(), "ApprovalInvalidated", {
      approvalId: APPROVAL_ID,
      reason: "precondition changed",
    }),
  ApprovalConsumed: () =>
    oracle(approvalGranted(), "ApprovalConsumed", {
      approvalId: APPROVAL_ID,
      actionId: ACTION_ID,
    }),
  OutcomeProposed: () =>
    oracle(waitingForAgent(), "OutcomeProposed", { outcome: GOLDEN_OUTCOME }),
  OutcomeValidated: () =>
    oracle(outcomeProposed(), "OutcomeValidated", {
      outcomeId: GOLDEN_OUTCOME.outcomeId,
      evidence: GOLDEN_OUTCOME.evidence,
      validatedAt: TIME,
    }),
  ArtifactReferenced: () =>
    oracle(profiled(), "ArtifactReferenced", {
      artifactId: ARTIFACT_ID,
      contentHash: "sha256:gate-a-artifact",
      mediaType: "application/json",
    }),
  RetryScheduled: () =>
    oracle(uncertainAttempt(), "RetryScheduled", {
      attemptType: "agent_driver",
      ordinal: 1,
      scheduledAt: TIME,
    }),
  BudgetExceeded: () =>
    oracle(idlePlanning(), "BudgetExceeded", {
      budget: "maxTurns",
      consumed: 1,
      limit: 1,
    }),
  RecoveryStarted: () =>
    oracle(idlePlanning(), "RecoveryStarted", {
      recoveryId: "recovery:gate-a",
      startedAt: TIME,
    }),
  RecoveryCompleted: () =>
    oracle(recovering(), "RecoveryCompleted", {
      recoveryId: "recovery:gate-a",
      disposition: "recovered",
    }),
} satisfies Readonly<Record<GenericEventType, () => EventOracle>>;

function completed(): Projection {
  const prior = outcomeValidated();
  return append(prior, "RunCompleted", { result: completedResult(prior.state) });
}

function failed(): Projection {
  const prior = profiled();
  return append(prior, "RunFailed", { result: failedResult(prior.state) });
}

function cancelled(): Projection {
  const prior = cancellationReady();
  return append(prior, "RunCancelled", { result: cancelledResult(prior.state) });
}

function orphaned(): Projection {
  const prior = recovering();
  return append(prior, "RunOrphaned", { result: orphanedResult(prior.state) });
}

const STATUS_BUILDERS = {
  uninitialized: initial,
  created: profiled,
  planning: idlePlanning,
  waiting_for_agent: waitingForAgent,
  attempt_result_uncertain: uncertainAttempt,
  evaluating_action: normalizedAction,
  waiting_for_approval: approvalWaiting,
  executing_action: executingAction,
  recording_observation: recordingSuccess,
  cancellation_requested: cancellationReady,
  recovering,
  paused,
  completed,
  failed,
  cancelled,
  orphaned,
} satisfies Readonly<Record<RunProjectionStatus, () => Projection>>;

function eventOnly<TType extends GenericEventType>(
  eventType: TType,
  payload: GenericEventPayloadMap[TType],
): Extract<GenericEvent, { readonly eventType: TType }> {
  return {
    eventId: EventIdKind.parse(
      "evt_018f0000-0000-7000-8000-00000000afff",
    ),
    eventType,
    eventSchemaVersion: 1,
    occurredAt: TIME,
    actor: ACTOR,
    correlationId: "correlation:gate-a-intent",
    causationId: null,
    payload,
  } as Extract<GenericEvent, { readonly eventType: TType }>;
}

function intentFor(intentType: RunIntentType, state: RunState): RunIntent {
  const runId = state.runId ?? RUN_ID;
  switch (intentType) {
    case "create_run":
      return { schemaVersion: 1, intentType, event: eventOnly("RunCreated", {
        objective: GOLDEN_OBJECTIVE,
      }) };
    case "pin_task_profile":
      return { schemaVersion: 1, intentType, event: eventOnly("TaskProfilePinned", {
        taskProfile: GOLDEN_PROFILE,
      }) };
    case "start_run":
      return { schemaVersion: 1, intentType, event: eventOnly("RunStarted", {
        startedAt: TIME,
      }) };
    case "append_run_intent":
      return { schemaVersion: 1, intentType, event: eventOnly("RunIntentAppended", {
        intentType: "follow_up",
        intentVersion: 1,
        payload: { instruction: "continue" },
        submittedBy: { kind: "user", id: "user:gate-a" },
      }) };
    case "pause_run":
      return { schemaVersion: 1, intentType, event: eventOnly("RunPaused", {
        reason: "gate-a pause",
      }) };
    case "resume_run":
      return { schemaVersion: 1, intentType, event: eventOnly("RunResumed", {
        resumedAt: TIME,
      }) };
    case "request_cancellation":
      return { schemaVersion: 1, intentType, event: eventOnly("CancellationRequested", {
        reason: "gate-a cancel",
      }) };
    case "cancel_run":
      return { schemaVersion: 1, intentType, event: eventOnly("RunCancelled", {
        result: {
          schemaVersion: 1,
          runId,
          status: "cancelled",
          finishedAt: TIME,
          reason: "gate-a cancel",
        },
      }) };
    case "fail_run":
      return { schemaVersion: 1, intentType, event: eventOnly("RunFailed", {
        result: { schemaVersion: 1, runId, status: "failed", finishedAt: TIME, error: FAILURE },
      }) };
    case "complete_run":
      return { schemaVersion: 1, intentType, event: eventOnly("RunCompleted", {
        result: {
          schemaVersion: 1,
          runId,
          status: "completed",
          finishedAt: TIME,
          outcome: state.validatedOutcome ?? GOLDEN_OUTCOME,
        },
      }) };
    case "orphan_run":
      return { schemaVersion: 1, intentType, event: eventOnly("RunOrphaned", {
        result: { schemaVersion: 1, runId, status: "orphaned", finishedAt: TIME, error: FAILURE },
      }) };
    default:
      return assertNever(intentType);
  }
}

function legalIntentProjection(
  intentType: RunIntentType,
  status: RunProjectionStatus,
): Projection {
  if (intentType === "create_run") return initial();
  if (intentType === "pin_task_profile") return created();
  if (intentType === "start_run") return profiled();
  if (intentType === "complete_run") return outcomeValidated();
  return STATUS_BUILDERS[status]();
}

interface PersistedEventCorpus {
  readonly corpusSchemaVersion: number;
  readonly eventSchemaVersion: number;
  readonly events: readonly unknown[];
}

function readPersistedCorpus(): PersistedEventCorpus {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL("../testdata/generic-events-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  const record = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), [
    "corpusSchemaVersion",
    "eventSchemaVersion",
    "events",
  ]);
  assert.equal(record["corpusSchemaVersion"], 1);
  assert.equal(record["eventSchemaVersion"], 1);
  assert.equal(Array.isArray(record["events"]), true);
  return record as unknown as PersistedEventCorpus;
}

test("Gate A persisted v1 corpus has one strict canonical envelope for every event type", () => {
  const document = readPersistedCorpus();
  const parsed = document.events.map((event) => parseGenericEventEnvelope(event));
  const actualTypes = parsed.map(({ eventType }) => eventType);

  assert.equal(parsed.length, GENERIC_EVENT_TYPES.length);
  assert.deepEqual(actualTypes, [...GENERIC_EVENT_TYPES]);
  assert.equal(new Set(actualTypes).size, GENERIC_EVENT_TYPES.length);
  assert.equal(
    new Set(parsed.map(({ eventId }) => eventId)).size,
    GENERIC_EVENT_TYPES.length,
  );
  for (let index = 0; index < parsed.length; index += 1) {
    assert.equal(canonicalize(parsed[index]), canonicalize(document.events[index]));
    assert.equal(parsed[index]?.eventSchemaVersion, document.eventSchemaVersion);
  }
});

test("Gate A every persisted event has a reachable reducer, effect, and replay oracle", () => {
  const persisted = readPersistedCorpus().events.map((event) =>
    parseGenericEventEnvelope(event)
  );
  assert.deepEqual(
    Object.keys(EVENT_ORACLE_BUILDERS),
    [...GENERIC_EVENT_TYPES],
  );

  for (const fixture of persisted) {
    const oracleValue = EVENT_ORACLE_BUILDERS[fixture.eventType]();
    assert.equal(oracleValue.event.eventType, fixture.eventType);
    const strictEvent = parseGenericEventEnvelope(oracleValue.event);
    const firstCommands = planEffects(oracleValue.prior.state, strictEvent);
    const secondCommands = planEffects(oracleValue.prior.state, strictEvent);
    assert.deepEqual(secondCommands, firstCommands, fixture.eventType);
    assert.ok(
      firstCommands.filter(({ consequential }) => consequential).length <= 1,
      `${fixture.eventType} planned more than one consequential command`,
    );

    const evolved = evolve(oracleValue.prior.state, strictEvent);
    const replayed = replay([...oracleValue.prior.history, strictEvent]);
    assert.deepEqual(replayed, evolved, fixture.eventType);
    assert.equal(evolved.streamVersion, oracleValue.event.streamVersion);
  }
});

test("Gate A intent matrix accepts every declared state and rejects every other state", () => {
  const allStatuses: readonly RunProjectionStatus[] = [
    "uninitialized",
    ...RUN_LIFECYCLE_STATUSES,
  ];

  for (const intentType of Object.keys(INTENT_LEGAL_STATES) as RunIntentType[]) {
    const legalStatuses = INTENT_LEGAL_STATES[intentType] as readonly RunProjectionStatus[];
    for (const status of allStatuses) {
      const projection = legalStatuses.includes(status)
        ? legalIntentProjection(intentType, status)
        : STATUS_BUILDERS[status]();
      assert.equal(projection.state.status, status);
      const intent = intentFor(intentType, projection.state);
      if (legalStatuses.includes(status)) {
        const decided = decide(projection.state, intent);
        assert.deepEqual(decided, [intent.event], `${intentType} @ ${status}`);
      } else {
        assert.throws(
          () => decide(projection.state, intent),
          (error: unknown) =>
            isDomainError(error) && error.code === "invariant_violated",
          `${intentType} unexpectedly accepted ${status}`,
        );
      }
    }
  }
});

test("Gate A RunFailed requires agent/action settlement before failure is declared legal", () => {
  assert.equal(INTENT_LEGAL_STATES.fail_run.includes("waiting_for_agent"), false);
  assert.equal(INTENT_LEGAL_STATES.fail_run.includes("executing_action"), false);

  const waiting = waitingForAgent();
  assert.throws(() => decide(waiting.state, intentFor("fail_run", waiting.state)));
  const agentSettled = append(waiting, "AgentAttemptFailed", {
    attemptId: ATTEMPT_ID,
    error: FAILURE,
  });
  assert.equal(agentSettled.state.status, "planning");
  assert.doesNotThrow(() =>
    decide(agentSettled.state, intentFor("fail_run", agentSettled.state))
  );

  const executing = executingAction();
  assert.throws(() => decide(executing.state, intentFor("fail_run", executing.state)));
  const actionSettled = append(executing, "ActionFailed", {
    actionId: ACTION_ID,
    error: FAILURE,
  });
  assert.equal(actionSettled.state.status, "recording_observation");
  assert.doesNotThrow(() =>
    decide(actionSettled.state, intentFor("fail_run", actionSettled.state))
  );

  const evaluatingAndQuiescent = normalizedAction();
  assert.equal(evaluatingAndQuiescent.state.status, "evaluating_action");
  assert.equal(evaluatingAndQuiescent.state.outstandingCommand, null);
  assert.doesNotThrow(() =>
    decide(
      evaluatingAndQuiescent.state,
      intentFor("fail_run", evaluatingAndQuiescent.state),
    )
  );

  const evaluatingWithExecutionScheduled = policyEvaluated("allow");
  assert.equal(evaluatingWithExecutionScheduled.state.status, "evaluating_action");
  assert.equal(
    evaluatingWithExecutionScheduled.state.outstandingCommand?.commandType,
    "ExecuteCapabilityAction",
  );
  assert.throws(() =>
    decide(
      evaluatingWithExecutionScheduled.state,
      intentFor("fail_run", evaluatingWithExecutionScheduled.state),
    )
  );
});

test("Gate A bounded deterministic histories replay purely and reject gaps or duplicates", () => {
  let seed = 0x5eed1234;
  const next = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };

  for (let iteration = 0; iteration < 64; iteration += 1) {
    const eventType = GENERIC_EVENT_TYPES[next() % GENERIC_EVENT_TYPES.length]!;
    const oracleValue = EVENT_ORACLE_BUILDERS[eventType]();
    const history = [...oracleValue.prior.history, oracleValue.event];
    const inputSnapshot = canonicalize(history);
    let ambientEffectReads = 0;
    const originalDateNow = Date.now;
    const originalRandom = Math.random;
    const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    Date.now = () => {
      ambientEffectReads += 1;
      throw new Error("Replay attempted to read the ambient clock.");
    };
    Math.random = () => {
      ambientEffectReads += 1;
      throw new Error("Replay attempted to read ambient randomness.");
    };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: () => {
        ambientEffectReads += 1;
        throw new Error("Replay attempted an external network effect.");
      },
    });

    let first: RunState;
    let second: RunState;
    try {
      first = replay(history);
      second = replay(history);
    } finally {
      Date.now = originalDateNow;
      Math.random = originalRandom;
      if (fetchDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "fetch");
      } else {
        Object.defineProperty(globalThis, "fetch", fetchDescriptor);
      }
    }

    assert.deepEqual(second, first, `deterministic replay for ${eventType}`);
    assert.equal(ambientEffectReads, 0, `ambient effect read for ${eventType}`);
    assert.equal(canonicalize(history), inputSnapshot, `input mutation for ${eventType}`);
    assert.equal(Object.isFrozen(first), true, `mutable replay result for ${eventType}`);
    assert.ok(history.length <= GENERIC_EVENT_TYPES.length);

    let state = createInitialRunState();
    for (const event of history) {
      const commands = planEffects(state, event);
      assert.ok(
        commands.filter(({ consequential }) => consequential).length <= 1,
        `${event.eventType} exceeded the consequential-command invariant`,
      );
      state = evolve(state, event);
    }
    assert.deepEqual(state, first);

    const mutationIndex = next() % history.length;
    const selected = history[mutationIndex]!;
    const gap = [
      ...history.slice(0, mutationIndex),
      { ...selected, streamVersion: selected.streamVersion + 1 },
      ...history.slice(mutationIndex + 1),
    ] as readonly GenericEventEnvelope[];
    assert.throws(() => replay(gap), (error: unknown) => isDomainError(error));

    const duplicate = [
      ...history.slice(0, mutationIndex + 1),
      selected,
      ...history.slice(mutationIndex + 1),
    ];
    assert.throws(
      () => replay(duplicate),
      (error: unknown) => isDomainError(error),
    );
  }
});

test("Gate A generated next events cannot reactivate any terminal projection", () => {
  const terminals = [completed(), failed(), cancelled(), orphaned()];
  for (const [terminalIndex, terminal] of terminals.entries()) {
    for (let iteration = 0; iteration < GENERIC_EVENT_TYPES.length; iteration += 1) {
      const eventType = GENERIC_EVENT_TYPES[
        (iteration * 17 + terminalIndex * 7) % GENERIC_EVENT_TYPES.length
      ]!;
      const source = EVENT_ORACLE_BUILDERS[eventType]().event;
      const candidate = {
        ...source,
        eventId: EventIdKind.parse(
          `evt_018f0000-0000-7000-8000-${(0xb000 + terminalIndex * 0x100 + iteration)
            .toString(16)
            .padStart(12, "0")}`,
        ),
        streamId: terminal.state.runId ?? RUN_ID,
        streamVersion: terminal.state.streamVersion + 1,
        recordedAt: "2026-08-31T01:00:00.000Z",
      } as GenericEventEnvelope;
      assert.throws(
        () => evolve(terminal.state, candidate),
        (error: unknown) => isDomainError(error),
        `${terminal.state.status} accepted ${eventType}`,
      );
      assert.throws(
        () => planEffects(terminal.state, candidate),
        (error: unknown) => isDomainError(error),
      );
    }
  }
});

function assertNever(value: never): never {
  throw new TypeError(`Unhandled value: ${String(value)}`);
}
