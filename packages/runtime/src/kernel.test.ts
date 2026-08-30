import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  AgentAttemptIdKind,
  ApprovalIdKind,
  DriverProposalIdKind,
  EventIdKind,
  GENERIC_EVENT_TYPES,
  PolicyVersionIdKind,
  RunIdKind,
  canonicalSha256Hex,
  createDomainError,
  isDomainError,
} from "@guard/contracts";
import type {
  CompletedRunResult,
  ContentBlock,
  FailedRunResult,
  GenericEvent,
  GenericEventEnvelope,
  GenericEventPayloadMap,
  GenericEventType,
  JsonObject,
  NormalizedAction,
  Observation,
  OrphanedRunResult,
} from "@guard/contracts";

import {
  EVENT_LEGAL_STATES,
  INTENT_LEGAL_STATES,
  RUN_LIFECYCLE_STATUSES,
  TERMINAL_RUN_STATUSES,
  createInitialRunState,
  decide,
  evolve,
  planEffects,
  replay,
} from "./index.js";
import type { RunIntent, RunState } from "./index.js";
import type { RunProjectionStatus } from "./index.js";
import {
  GOLDEN_ACTOR,
  GOLDEN_HISTORY,
  GOLDEN_OBJECTIVE,
  GOLDEN_OUTCOME,
  GOLDEN_PROFILE,
  GOLDEN_RESULT,
  GOLDEN_RUN_ID,
} from "./testdata/golden-history.js";

const TEST_RUN_ID = RunIdKind.parse(
  "run_018f0000-0000-7000-8000-000000000301"
);

function nextEvent<TType extends GenericEventType>(
  state: RunState,
  eventType: TType,
  payload: GenericEventPayloadMap[TType]
): GenericEventEnvelope {
  const streamVersion = state.streamVersion + 1;
  const instant = new Date(Date.UTC(2026, 7, 30, 11, 0, streamVersion));
  return {
    eventId: EventIdKind.generate(),
    streamId: state.runId ?? TEST_RUN_ID,
    streamVersion,
    eventType,
    eventSchemaVersion: 1,
    occurredAt: instant.toISOString(),
    recordedAt: instant.toISOString(),
    actor: GOLDEN_ACTOR,
    correlationId: "correlation:test",
    causationId: state.lastEventId,
    payload,
  } as GenericEventEnvelope;
}

function newEvent<TType extends GenericEventType>(
  eventType: TType,
  payload: GenericEventPayloadMap[TType]
): Extract<GenericEvent, { readonly eventType: TType }> {
  return {
    eventId: EventIdKind.generate(),
    eventType,
    eventSchemaVersion: 1,
    occurredAt: "2026-08-30T11:00:00.000Z",
    actor: GOLDEN_ACTOR,
    correlationId: "correlation:test",
    causationId: null,
    payload,
  } as Extract<GenericEvent, { readonly eventType: TType }>;
}

function apply<TType extends GenericEventType>(
  state: RunState,
  eventType: TType,
  payload: GenericEventPayloadMap[TType]
): RunState {
  return evolve(state, nextEvent(state, eventType, payload));
}

function createStartedState(taskProfile = GOLDEN_PROFILE): RunState {
  let state = createInitialRunState();
  state = apply(state, "RunCreated", { objective: GOLDEN_OBJECTIVE });
  state = apply(state, "TaskProfilePinned", { taskProfile });
  state = apply(state, "RunStarted", { startedAt: "2026-08-30T11:00:03.000Z" });
  state = apply(state, "AgentDriverStarted", {
    driverProfileId: "driver:scripted",
    driverProfileVersion: 1,
    driverFingerprint: "sha256:test-driver",
  });
  return state;
}

function createWaitingForAgentState(taskProfile = GOLDEN_PROFILE): RunState {
  const started = createStartedState(taskProfile);
  return apply(started, "AgentAttemptStarted", {
    attemptId: AgentAttemptIdKind.generate(),
    turn: 1,
  });
}

function makeAction(actionId = ActionIdKind.generate()): NormalizedAction {
  return {
    schemaVersion: 1,
    actionId,
    capabilityPackId: "synthetic.transform",
    capabilityPackVersion: 1,
    operationId: "synthetic.transform",
    operationVersion: 1,
    subject: { kind: "agent_driver", id: "driver:scripted" },
    resource: { scheme: "fixture", locator: "alpha" },
    environment: { mode: "in_memory" },
    request: { reason: "test" },
    normalizedInput: { input: "alpha" },
    sideEffectClass: "local_reversible",
    preconditions: [],
  };
}

function contentBlock(blockId: string, text: string): ContentBlock {
  return {
    schemaVersion: 1,
    blockId,
    modality: "text",
    mediaType: "text/plain; charset=utf-8",
    byteLength: text.length,
    contentHash: `sha256:${blockId}`,
    classification: "internal",
    provenance: {
      source: {
        schemaVersion: 1,
        scheme: "fixture",
        sourceId: "source:synthetic",
        locator: { blockId },
        mediaType: "text/plain",
        classification: "internal",
      },
      producer: { kind: "agent_driver", id: "driver:scripted" },
      capturedAt: "2026-08-30T11:00:05.000Z",
    },
    retentionClass: "run",
    transformation: null,
    text,
    encoding: "utf-8",
    normalization: "none",
  };
}

function observationFor(
  actionId: NormalizedAction["actionId"],
  status: Observation["status"],
  error: Observation["error"]
): Observation {
  return {
    schemaVersion: 1,
    observationId: `observation:${status}`,
    actionId,
    status,
    audit: { hash: `sha256:${status}` },
    human: [],
    agent: [],
    error,
    occurredAt: "2026-08-30T11:00:11.000Z",
  };
}

function createEvaluatingActionState(): {
  readonly state: RunState;
  readonly action: NormalizedAction;
} {
  let state = createWaitingForAgentState();
  state = apply(state, "ActionProposed", {
    proposalId: DriverProposalIdKind.generate(),
    capabilityPackId: "synthetic.transform",
    capabilityPackVersion: 1,
    operationId: "synthetic.transform",
    operationVersion: 1,
    input: { input: "alpha" },
  });
  const action = makeAction();
  state = apply(state, "ActionNormalized", { action });
  return { state, action };
}

function policyEvent(
  state: RunState,
  action: NormalizedAction,
  decision: "allow" | "deny" | "require_approval"
): GenericEventEnvelope {
  return nextEvent(state, "PolicyEvaluated", {
    actionId: action.actionId,
    policyVersionId: PolicyVersionIdKind.generate(),
    decision,
    trace: { rule: `test:${decision}` },
  });
}

function domainFailure(runId = TEST_RUN_ID): FailedRunResult {
  return {
    schemaVersion: 1,
    runId,
    status: "failed",
    finishedAt: "2026-08-30T11:01:00.000Z",
    error: createDomainError({
      code: "invariant_violated",
      message: "The synthetic run failed.",
    }),
  };
}

function assertDomainError(error: unknown): boolean {
  return isDomainError(error);
}

test("the lifecycle and event matrices are complete and terminal states are immutable", () => {
  assert.deepEqual(
    [...Object.keys(EVENT_LEGAL_STATES)].sort(),
    [...GENERIC_EVENT_TYPES].sort()
  );
  assert.equal(new Set(RUN_LIFECYCLE_STATUSES).size, RUN_LIFECYCLE_STATUSES.length);
  for (const states of Object.values(EVENT_LEGAL_STATES)) {
    for (const terminal of TERMINAL_RUN_STATUSES) {
      assert.equal(
        (states as readonly RunProjectionStatus[]).includes(terminal),
        false
      );
    }
  }
  assert.deepEqual(Object.keys(INTENT_LEGAL_STATES).sort(), [
    "append_run_intent",
    "cancel_run",
    "complete_run",
    "create_run",
    "fail_run",
    "orphan_run",
    "pause_run",
    "pin_task_profile",
    "request_cancellation",
    "resume_run",
    "start_run",
  ]);
});

test("decide is deterministic, validates intent state, and does not mutate state", () => {
  const state = createInitialRunState();
  const event = newEvent("RunCreated", { objective: GOLDEN_OBJECTIVE });
  const intent: RunIntent = { schemaVersion: 1, intentType: "create_run", event };

  const beforeHash = canonicalSha256Hex(state);
  const first = decide(state, intent);
  const second = decide(state, intent);

  assert.deepEqual(first, [event]);
  assert.deepEqual(second, first);
  assert.equal(canonicalSha256Hex(state), beforeHash);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(
    () =>
      decide(state, {
        schemaVersion: 1,
        intentType: "start_run",
        event: event as never,
      }),
    assertDomainError
  );
  assert.throws(
    () => decide({} as never, intent),
    assertDomainError
  );
});

test("golden history replays to one deterministic immutable terminal projection", () => {
  const first = replay(GOLDEN_HISTORY);
  const second = replay(GOLDEN_HISTORY);

  assert.deepEqual(second, first);
  assert.equal(first.status, "completed");
  assert.equal(first.runId, GOLDEN_RUN_ID);
  assert.equal(first.streamVersion, GOLDEN_HISTORY.length);
  assert.deepEqual(first.result, GOLDEN_RESULT);
  assert.deepEqual(first.budget, {
    elapsedMs: 7_000,
    turnsStarted: 1,
    actionsProposed: 0,
    actionsStarted: 0,
    usageRecords: 1,
    inputBytes: 120,
    outputBytes: 48,
    inputTokens: 30,
    outputTokens: 12,
    estimatedCostMicros: 0,
    contextBytesReleased: 0,
    agentContentBytes: 0,
    observationsReleased: 0,
    policyDenials: 0,
    retriesScheduled: 0,
    artifactsReferenced: 1,
  });
  assert.equal(first.outstandingCommand, null);
  assert.equal(first.pendingApproval, null);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.budget), true);
});

test("effect planning is pure, deterministic, and creates stable event-derived command ids", () => {
  let state = createInitialRunState();
  state = apply(state, "RunCreated", { objective: GOLDEN_OBJECTIVE });
  state = apply(state, "TaskProfilePinned", { taskProfile: GOLDEN_PROFILE });
  const start = nextEvent(state, "RunStarted", {
    startedAt: "2026-08-30T11:00:03.000Z",
  });

  const first = planEffects(state, start);
  const second = planEffects(state, start);

  assert.deepEqual(second, first);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.commandType, "AdvanceAgentDriver");
  assert.equal(
    first[0]?.commandId,
    `cmd_${start.eventId.slice("evt_".length)}`
  );
  assert.equal(Object.isFrozen(first), true);
});

test("allowed action flow serializes one consequential command and returns to planning", () => {
  const setup = createEvaluatingActionState();
  let state = setup.state;
  const policy = policyEvent(state, setup.action, "allow");
  state = evolve(state, policy);

  assert.equal(state.status, "evaluating_action");
  assert.equal(state.outstandingCommand?.commandType, "ExecuteCapabilityAction");

  state = apply(state, "ActionStarted", {
    actionId: setup.action.actionId,
    startedAt: "2026-08-30T11:00:09.000Z",
  });
  assert.equal(state.status, "executing_action");
  assert.equal(state.budget.actionsStarted, 1);

  state = apply(state, "ActionSucceeded", {
    actionId: setup.action.actionId,
    completedAt: "2026-08-30T11:00:10.000Z",
  });
  assert.equal(state.status, "recording_observation");
  assert.equal(state.outstandingCommand, null);

  const observation: Observation = {
    schemaVersion: 1,
    observationId: "observation:synthetic",
    actionId: setup.action.actionId,
    status: "succeeded",
    audit: { hash: "sha256:observation" },
    human: [],
    agent: [],
    error: null,
    occurredAt: "2026-08-30T11:00:11.000Z",
  };
  state = apply(state, "ObservationReleased", { observation });
  assert.equal(state.status, "planning");
  assert.equal(state.currentAction, null);
  assert.equal(state.budget.observationsReleased, 1);
  assert.equal(state.outstandingCommand?.commandType, "AdvanceAgentDriver");
});

test("the proposal resolves component id and exact version independently of binding id", () => {
  let state = createWaitingForAgentState();
  state = apply(state, "ActionProposed", {
    proposalId: DriverProposalIdKind.generate(),
    capabilityPackId: "synthetic.transform",
    capabilityPackVersion: 1,
    operationId: "synthetic.transform",
    operationVersion: 1,
    input: { input: "alpha" },
  });
  assert.equal(state.currentAction?.capabilityPackVersion, 1);
  assert.equal(state.currentAction?.capabilityPackId, "synthetic.transform");

  const wrongVersion = makeAction();
  assert.throws(
    () => apply(state, "ActionNormalized", {
      action: { ...wrongVersion, capabilityPackVersion: 2 },
    }),
    assertDomainError
  );
});

test("proposal binding resolution fails closed on zero or multiple exact component matches", () => {
  const proposal = {
    proposalId: DriverProposalIdKind.generate(),
    capabilityPackId: "synthetic.transform",
    capabilityPackVersion: 1,
    operationId: "synthetic.transform",
    operationVersion: 1,
    input: { input: "alpha" },
  } as const;

  const missing = createWaitingForAgentState({
    ...GOLDEN_PROFILE,
    capabilityPacks: [],
  });
  assert.throws(
    () => apply(missing, "ActionProposed", proposal),
    assertDomainError
  );

  const duplicate = createWaitingForAgentState({
    ...GOLDEN_PROFILE,
    capabilityPacks: [
      {
        bindingId: "transform-primary",
        componentId: "synthetic.transform",
        componentVersion: 1,
        configuration: {},
      },
      {
        bindingId: "transform-secondary",
        componentId: "synthetic.transform",
        componentVersion: 1,
        configuration: {},
      },
    ],
  });
  assert.throws(
    () => apply(duplicate, "ActionProposed", proposal),
    assertDomainError
  );
});

test("scripted content-action-usage order stays in one active attempt", () => {
  let state = createWaitingForAgentState();
  const attemptId = state.currentAttempt?.attemptId;
  assert.ok(attemptId);
  const advanceCommandId = state.outstandingCommand?.commandId;
  assert.ok(advanceCommandId);

  state = apply(state, "AgentContentCompleted", {
    attemptId,
    content: [contentBlock("analysis:1", "I should transform the input.")],
  });
  assert.equal(state.status, "waiting_for_agent");
  assert.equal(state.currentAttempt?.status, "active");
  assert.equal(state.outstandingCommand?.commandId, advanceCommandId);

  state = apply(state, "ActionProposed", {
    proposalId: DriverProposalIdKind.generate(),
    capabilityPackId: "synthetic.transform",
    capabilityPackVersion: 1,
    operationId: "synthetic.transform",
    operationVersion: 1,
    input: { input: "alpha" },
  });
  assert.equal(state.status, "evaluating_action");
  assert.equal(state.outstandingCommand, null);

  state = apply(state, "AgentUsageRecorded", {
    attemptId,
    usage: { inputBytes: 17, outputBytes: 31 },
  });
  assert.equal(state.budget.usageRecords, 1);
  assert.equal(state.currentAttempt?.attemptId, attemptId);

  assert.throws(
    () => apply(state, "AgentUsageRecorded", {
      attemptId: AgentAttemptIdKind.generate(),
      usage: { inputBytes: 1 },
    }),
    assertDomainError
  );
});

test("scripted outcome-usage order accepts only the originating attempt", () => {
  let state = createWaitingForAgentState();
  const attemptId = state.currentAttempt?.attemptId;
  assert.ok(attemptId);
  state = apply(state, "AgentContentCompleted", {
    attemptId,
    content: [contentBlock("answer:1", "The transformed answer.")],
  });
  state = apply(state, "OutcomeProposed", { outcome: GOLDEN_OUTCOME });
  state = apply(state, "AgentUsageRecorded", {
    attemptId,
    usage: { inputTokens: 9, outputTokens: 4 },
  });
  assert.equal(state.status, "planning");
  assert.equal(state.currentAttempt?.attemptId, attemptId);
  assert.equal(state.budget.usageRecords, 1);
});

test("approval is bound to one action, remains pending until consumed, and cannot replay", () => {
  const setup = createEvaluatingActionState();
  let state = evolve(
    setup.state,
    policyEvent(setup.state, setup.action, "require_approval")
  );
  const approvalId = ApprovalIdKind.generate();
  state = apply(state, "ApprovalRequested", {
    approvalId,
    actionId: setup.action.actionId,
    preconditionHash: "sha256:precondition",
  });

  assert.equal(state.status, "waiting_for_approval");
  assert.equal(state.pendingApproval?.approvalId, approvalId);

  state = apply(state, "ApprovalGranted", {
    approvalId,
    grantedBy: { kind: "user", id: "user:approver" },
  });
  assert.equal(state.pendingApproval?.status, "granted");

  state = apply(state, "ApprovalConsumed", {
    approvalId,
    actionId: setup.action.actionId,
  });
  assert.equal(state.pendingApproval, null);
  assert.equal(state.status, "evaluating_action");
  assert.equal(state.outstandingCommand?.commandType, "ExecuteCapabilityAction");

  assert.throws(
    () =>
      apply(state, "ApprovalConsumed", {
        approvalId,
        actionId: setup.action.actionId,
      }),
    assertDomainError
  );
});

test("denied, expired, and invalidated approvals clear the pending invariant", () => {
  for (const resolution of [
    "ApprovalDenied",
    "ApprovalExpired",
    "ApprovalInvalidated",
  ] as const) {
    const setup = createEvaluatingActionState();
    let state = evolve(
      setup.state,
      policyEvent(setup.state, setup.action, "require_approval")
    );
    const approvalId = ApprovalIdKind.generate();
    state = apply(state, "ApprovalRequested", {
      approvalId,
      actionId: setup.action.actionId,
      preconditionHash: "sha256:precondition",
    });
    const payload = resolution === "ApprovalDenied"
      ? { approvalId, deniedBy: { kind: "user" as const, id: "user:approver" } }
      : resolution === "ApprovalInvalidated"
        ? { approvalId, reason: "precondition changed" }
        : { approvalId };
    state = apply(state, resolution, payload as never);
    assert.equal(state.pendingApproval, null);
    assert.equal(state.status, "evaluating_action");
  }
});

test("cancellation is legal from active states, blocks new work, and settles before terminal", () => {
  const setup = createEvaluatingActionState();
  let state = evolve(setup.state, policyEvent(setup.state, setup.action, "allow"));
  state = apply(state, "ActionStarted", {
    actionId: setup.action.actionId,
    startedAt: "2026-08-30T11:00:09.000Z",
  });

  const requested = nextEvent(state, "CancellationRequested", {
    reason: "user requested stop",
  });
  state = evolve(state, requested);
  assert.equal(state.status, "cancellation_requested");
  assert.equal(state.outstandingCommand?.commandType, "CancelCapabilityAction");
  assert.throws(
    () =>
      apply(state, "AgentAttemptStarted", {
        attemptId: AgentAttemptIdKind.generate(),
        turn: 2,
      }),
    assertDomainError
  );

  state = apply(state, "ActionFailed", {
    actionId: setup.action.actionId,
    error: createDomainError({ code: "cancelled", message: "Action cancelled." }),
  });
  assert.equal(state.status, "cancellation_requested");
  assert.equal(state.outstandingCommand, null);

  state = apply(state, "RunCancelled", {
    result: {
      schemaVersion: 1,
      runId: TEST_RUN_ID,
      status: "cancelled",
      finishedAt: "2026-08-30T11:01:00.000Z",
      reason: "user requested stop",
    },
  });
  assert.equal(state.status, "cancelled");
  assert.throws(
    () => apply(state, "ArtifactReferenced", {
      artifactId: "art_018f0000-0000-7000-8000-000000000999" as never,
      contentHash: "sha256:late",
      mediaType: "application/json",
    }),
    assertDomainError
  );
});

test("pause rejects an active consequential command and resume plans new work", () => {
  const active = createWaitingForAgentState();
  assert.throws(
    () => apply(active, "RunPaused", { reason: "operator pause" }),
    assertDomainError
  );

  let idle = createWaitingForAgentState();
  idle = apply(idle, "AgentAttemptFailed", {
    attemptId: idle.currentAttempt?.attemptId ?? assert.fail("missing attempt"),
    error: createDomainError({ code: "driver_failed", message: "Driver stopped." }),
  });
  idle = apply(idle, "RunPaused", { reason: "operator pause" });
  assert.equal(idle.status, "paused");
  idle = apply(idle, "RunResumed", { resumedAt: "2026-08-30T11:00:09.000Z" });
  assert.equal(idle.outstandingCommand?.commandType, "AdvanceAgentDriver");

  let created = createInitialRunState();
  created = apply(created, "RunCreated", { objective: GOLDEN_OBJECTIVE });
  created = apply(created, "TaskProfilePinned", { taskProfile: GOLDEN_PROFILE });
  created = apply(created, "RunPaused", { reason: "before start" });
  assert.equal(created.status, "paused");
  created = apply(created, "RunResumed", { resumedAt: "2026-08-30T11:00:04.000Z" });
  assert.equal(created.status, "created");
  assert.equal(created.outstandingCommand, null);
});

test("context and retry flows replace rather than multiply consequential commands", () => {
  let state = createWaitingForAgentState();
  state = apply(state, "ContextRequested", {
    requestId: "context:1",
    resource: {
      schemaVersion: 1,
      scheme: "fixture",
      sourceId: "source:synthetic",
      locator: { item: "alpha" },
      mediaType: "application/json",
      classification: "internal",
    },
  });
  assert.equal(state.outstandingCommand?.commandType, "FetchContextResource");
  state = apply(state, "ContextRedacted", {
    requestId: "context:1",
    transformationIds: ["transform:redact"],
  });
  state = apply(state, "ContextReleased", {
    requestId: "context:1",
    resource: {
      schemaVersion: 1,
      scheme: "fixture",
      sourceId: "source:synthetic",
      locator: { item: "alpha" },
      mediaType: "application/json",
      classification: "internal",
    },
    content: [],
  });
  assert.equal(state.outstandingCommand?.commandType, "AdvanceAgentDriver");

  state = apply(state, "AgentAttemptUncertain", {
    attemptId: state.currentAttempt?.attemptId ?? AgentAttemptIdKind.generate(),
    error: createDomainError({
      code: "attempt_result_uncertain",
      message: "Attempt result is uncertain.",
    }),
  });
  assert.equal(state.status, "attempt_result_uncertain");
  state = apply(state, "RetryScheduled", {
    attemptType: "agent_driver",
    ordinal: 1,
    scheduledAt: "2026-08-30T11:00:20.000Z",
  });
  assert.equal(state.status, "planning");
  assert.equal(state.budget.retriesScheduled, 1);
  assert.equal(state.outstandingCommand?.commandType, "AdvanceAgentDriver");
});

test("recorded usage and action facts alone advance budget counters", () => {
  let state = createWaitingForAgentState();
  const attemptId = state.currentAttempt?.attemptId;
  assert.ok(attemptId);
  state = apply(state, "AgentUsageRecorded", {
    attemptId,
    usage: {
      inputBytes: 10,
      outputBytes: 20,
      inputTokens: 3,
      outputTokens: 4,
      estimatedCostMicros: 50,
    },
  });
  assert.deepEqual(
    {
      turns: state.budget.turnsStarted,
      usage: state.budget.usageRecords,
      inputBytes: state.budget.inputBytes,
      outputBytes: state.budget.outputBytes,
      cost: state.budget.estimatedCostMicros,
    },
    { turns: 1, usage: 1, inputBytes: 10, outputBytes: 20, cost: 50 }
  );

  const malformed = nextEvent(state, "AgentUsageRecorded", {
    attemptId,
    usage: { inputBytes: -1 } as JsonObject,
  });
  assert.throws(() => evolve(state, malformed), assertDomainError);
});

test("budget exhaustion is recorded and prevents further automatic work", () => {
  let state = createWaitingForAgentState();
  state = apply(state, "AgentAttemptFailed", {
    attemptId: state.currentAttempt?.attemptId ?? AgentAttemptIdKind.generate(),
    error: createDomainError({ code: "driver_failed", message: "Attempt failed." }),
  });
  state = apply(state, "BudgetExceeded", {
    budget: "maxTurns",
    consumed: 1,
    limit: 1,
  });
  assert.deepEqual(state.budgetExceeded, {
    budget: "maxTurns",
    consumed: 1,
    limit: 1,
  });
  assert.throws(
    () => apply(state, "RetryScheduled", {
      attemptType: "agent_driver",
      ordinal: 1,
      scheduledAt: "2026-08-30T11:00:30.000Z",
    }),
    assertDomainError
  );

  state = apply(state, "RunFailed", { result: domainFailure() });
  assert.equal(state.status, "failed");
});

test("recovery requires explicit disposition and supports orphaning without retry", () => {
  let state = createWaitingForAgentState();
  state = apply(state, "RecoveryStarted", {
    recoveryId: "recovery:1",
    startedAt: "2026-08-30T11:00:20.000Z",
  });
  assert.equal(state.status, "recovering");
  state = apply(state, "RecoveryCompleted", {
    recoveryId: "recovery:1",
    disposition: "orphaned",
  });
  assert.equal(state.status, "recovering");
  assert.equal(state.recovery?.disposition, "orphaned");

  const orphaned: OrphanedRunResult = {
    ...domainFailure(),
    status: "orphaned",
  };
  state = apply(state, "RunOrphaned", { result: orphaned });
  assert.equal(state.status, "orphaned");
  assert.equal(state.outstandingCommand, null);
});

test("remaining generic facts replay through intent, content, denial, and reconciliation paths", () => {
  let intentState = createInitialRunState();
  intentState = apply(intentState, "RunCreated", { objective: GOLDEN_OBJECTIVE });
  intentState = apply(intentState, "RunIntentAppended", {
    intentType: "follow_up",
    intentVersion: 1,
    payload: { instruction: "continue" },
    submittedBy: { kind: "user", id: "user:test" },
  });
  assert.equal(intentState.appendedIntentCount, 1);

  let contentState = createWaitingForAgentState();
  const contentAttemptId = contentState.currentAttempt?.attemptId;
  assert.ok(contentAttemptId);
  contentState = apply(contentState, "AgentContentCompleted", {
    attemptId: contentAttemptId,
    content: [contentBlock("analysis:remaining", "Still planning.")],
  });
  assert.equal(contentState.status, "waiting_for_agent");
  assert.equal(contentState.currentAttempt?.status, "active");
  assert.equal(contentState.outstandingCommand?.commandType, "AdvanceAgentDriver");

  let contextState = createWaitingForAgentState();
  contextState = apply(contextState, "ContextRequested", {
    requestId: "context:denied",
    resource: {
      schemaVersion: 1,
      scheme: "fixture",
      sourceId: "source:synthetic",
      locator: { item: "secret" },
      mediaType: "application/json",
      classification: "restricted",
    },
  });
  contextState = apply(contextState, "ContextDenied", {
    requestId: "context:denied",
    error: createDomainError({
      code: "policy_denied",
      message: "Context policy denied the resource.",
    }),
  });
  assert.equal(contextState.currentContextRequest, null);
  assert.equal(contextState.outstandingCommand?.commandType, "AdvanceAgentDriver");

  const deniedSetup = createEvaluatingActionState();
  let deniedState = evolve(
    deniedSetup.state,
    policyEvent(deniedSetup.state, deniedSetup.action, "deny")
  );
  deniedState = apply(deniedState, "ActionDenied", {
    actionId: deniedSetup.action.actionId,
    error: createDomainError({
      code: "policy_denied",
      message: "Policy denied the action.",
    }),
  });
  assert.equal(deniedState.status, "recording_observation");
  assert.equal(deniedState.budget.policyDenials, 1);

  const recoverySetup = createEvaluatingActionState();
  let recoveryState = evolve(
    recoverySetup.state,
    policyEvent(recoverySetup.state, recoverySetup.action, "allow")
  );
  recoveryState = apply(recoveryState, "ActionStarted", {
    actionId: recoverySetup.action.actionId,
    startedAt: "2026-08-30T11:00:09.000Z",
  });
  recoveryState = apply(recoveryState, "RecoveryStarted", {
    recoveryId: "recovery:action",
    startedAt: "2026-08-30T11:00:10.000Z",
  });
  recoveryState = apply(recoveryState, "ActionReconciled", {
    actionId: recoverySetup.action.actionId,
    disposition: "succeeded",
    evidence: { receipt: "sha256:receipt" },
  });
  recoveryState = apply(recoveryState, "ObservationReleased", {
    observation: {
      schemaVersion: 1,
      observationId: "observation:recovered",
      actionId: recoverySetup.action.actionId,
      status: "succeeded",
      audit: { receipt: "sha256:receipt" },
      human: [],
      agent: [],
      error: null,
      occurredAt: "2026-08-30T11:00:12.000Z",
    },
  });
  recoveryState = apply(recoveryState, "RecoveryCompleted", {
    recoveryId: "recovery:action",
    disposition: "recovered",
  });
  assert.equal(recoveryState.status, "planning");
  assert.equal(recoveryState.recovery, null);
  assert.equal(recoveryState.outstandingCommand?.commandType, "AdvanceAgentDriver");
});

test("completed, failed, cancelled, and orphaned projections reject every later event", () => {
  const completed = replay(GOLDEN_HISTORY);
  const failed = apply(
    apply(createInitialRunState(), "RunCreated", { objective: GOLDEN_OBJECTIVE }),
    "RunFailed",
    { result: domainFailure() }
  );
  const terminalStates = [completed, failed];
  for (const state of terminalStates) {
    assert.throws(
      () => apply(state, "RunIntentAppended", {
        intentType: "follow_up",
        intentVersion: 1,
        payload: {},
        submittedBy: { kind: "user", id: "user:test" },
      }),
      assertDomainError
    );
  }
});

test("unknown events, gaps, stream switches, malformed payloads, and unknown states fail closed", () => {
  const initial = createInitialRunState();
  const created = apply(initial, "RunCreated", { objective: GOLDEN_OBJECTIVE });

  const gap = { ...nextEvent(created, "TaskProfilePinned", { taskProfile: GOLDEN_PROFILE }), streamVersion: 3 };
  assert.throws(() => evolve(created, gap), assertDomainError);

  const switched = { ...nextEvent(created, "TaskProfilePinned", { taskProfile: GOLDEN_PROFILE }), streamId: RunIdKind.generate() };
  assert.throws(() => evolve(created, switched), assertDomainError);

  const unknown = {
    ...nextEvent(created, "TaskProfilePinned", { taskProfile: GOLDEN_PROFILE }),
    eventType: "UnknownKernelEvent",
  } as unknown as GenericEventEnvelope;
  assert.throws(() => evolve(created, unknown), assertDomainError);

  const malformedSetup = createEvaluatingActionState();
  const allowed = evolve(
    malformedSetup.state,
    policyEvent(malformedSetup.state, malformedSetup.action, "allow")
  );
  const malformed = {
    ...nextEvent(allowed, "ActionStarted", {
      actionId: malformedSetup.action.actionId,
      startedAt: "2026-08-30T11:00:09.000Z",
    }),
    payload: {},
  } as unknown as GenericEventEnvelope;
  assert.throws(() => evolve(allowed, malformed), assertDomainError);

  assert.throws(
    () => evolve({ ...created, status: "mystery" } as never, nextEvent(created, "TaskProfilePinned", { taskProfile: GOLDEN_PROFILE })),
    assertDomainError
  );
});

test("completion requires the exact validated outcome and a quiescent state", () => {
  let state = createWaitingForAgentState();
  state = apply(state, "OutcomeProposed", { outcome: GOLDEN_OUTCOME });
  state = apply(state, "OutcomeValidated", {
    outcomeId: GOLDEN_OUTCOME.outcomeId,
    evidence: GOLDEN_OUTCOME.evidence,
    validatedAt: "2026-08-30T11:00:10.000Z",
  });
  const wrongResult: CompletedRunResult = {
    ...GOLDEN_RESULT,
    runId: TEST_RUN_ID,
    outcome: { ...GOLDEN_OUTCOME, outcomeId: "outcome:wrong" },
  };
  assert.throws(
    () => apply(state, "RunCompleted", { result: wrongResult }),
    assertDomainError
  );

  const result: CompletedRunResult = {
    ...GOLDEN_RESULT,
    runId: TEST_RUN_ID,
  };
  state = apply(state, "RunCompleted", { result });
  assert.equal(state.status, "completed");
});

test("attempt ids cannot be reused after the prior attempt projection clears", () => {
  let state = createWaitingForAgentState();
  const attemptId = state.currentAttempt?.attemptId;
  assert.ok(attemptId);
  assert.deepEqual(state.usedAgentAttemptIds, [attemptId]);
  assert.equal(Object.isFrozen(state.usedAgentAttemptIds), true);
  const overBudgetState: RunState = {
    ...state,
    usedAgentAttemptIds: [
      attemptId,
      AgentAttemptIdKind.generate(),
      AgentAttemptIdKind.generate(),
      AgentAttemptIdKind.generate(),
    ],
    budget: { ...state.budget, turnsStarted: 4 },
  };
  assert.throws(
    () => planEffects(overBudgetState, nextEvent(overBudgetState, "RecoveryStarted", {
      recoveryId: "recovery:over-budget-ledger",
      startedAt: "2026-08-30T11:00:20.000Z",
    })),
    assertDomainError
  );
  state = apply(state, "AgentAttemptFailed", {
    attemptId,
    error: createDomainError({
      code: "driver_failed",
      message: "The first attempt failed.",
    }),
  });
  state = apply(state, "RetryScheduled", {
    attemptType: "agent_driver",
    ordinal: 1,
    scheduledAt: "2026-08-30T11:00:20.000Z",
  });
  assert.throws(
    () => apply(state, "AgentAttemptStarted", { attemptId, turn: 2 }),
    assertDomainError
  );
});

test("proposal and action ids cannot be rebound by a later action", () => {
  let state = createWaitingForAgentState();
  const firstProposalId = DriverProposalIdKind.generate();
  const firstAction = makeAction();
  state = apply(state, "ActionProposed", {
    proposalId: firstProposalId,
    capabilityPackId: "synthetic.transform",
    capabilityPackVersion: 1,
    operationId: "synthetic.transform",
    operationVersion: 1,
    input: { input: "first" },
  });
  state = apply(state, "ActionNormalized", { action: firstAction });
  state = evolve(state, policyEvent(state, firstAction, "allow"));
  state = apply(state, "ActionStarted", {
    actionId: firstAction.actionId,
    startedAt: "2026-08-30T11:00:10.000Z",
  });
  state = apply(state, "ActionSucceeded", {
    actionId: firstAction.actionId,
    completedAt: "2026-08-30T11:00:11.000Z",
  });
  state = apply(state, "ObservationReleased", {
    observation: observationFor(firstAction.actionId, "succeeded", null),
  });
  state = apply(state, "AgentAttemptStarted", {
    attemptId: AgentAttemptIdKind.generate(),
    turn: 2,
  });

  assert.throws(
    () => apply(state, "ActionProposed", {
      proposalId: firstProposalId,
      capabilityPackId: "synthetic.transform",
      capabilityPackVersion: 1,
      operationId: "synthetic.transform",
      operationVersion: 1,
      input: { input: "second" },
    }),
    assertDomainError
  );

  state = apply(state, "ActionProposed", {
    proposalId: DriverProposalIdKind.generate(),
    capabilityPackId: "synthetic.transform",
    capabilityPackVersion: 1,
    operationId: "synthetic.transform",
    operationVersion: 1,
    input: { input: "second" },
  });
  assert.throws(
    () => apply(state, "ActionNormalized", {
      action: { ...firstAction, normalizedInput: { input: "second" } },
    }),
    assertDomainError
  );
});

test("approval ids cannot be rebound by a later action", () => {
  const first = createEvaluatingActionState();
  let state = evolve(first.state, policyEvent(first.state, first.action, "require_approval"));
  const approvalId = ApprovalIdKind.generate();
  state = apply(state, "ApprovalRequested", {
    approvalId,
    actionId: first.action.actionId,
    preconditionHash: "sha256:first",
  });
  state = apply(state, "ApprovalDenied", {
    approvalId,
    deniedBy: { kind: "user", id: "user:approver" },
  });
  const denial = createDomainError({
    code: "policy_denied",
    message: "The first approval was denied.",
  });
  state = apply(state, "ActionDenied", {
    actionId: first.action.actionId,
    error: denial,
  });
  state = apply(state, "ObservationReleased", {
    observation: observationFor(first.action.actionId, "denied", denial),
  });
  state = apply(state, "AgentAttemptStarted", {
    attemptId: AgentAttemptIdKind.generate(),
    turn: 2,
  });
  state = apply(state, "ActionProposed", {
    proposalId: DriverProposalIdKind.generate(),
    capabilityPackId: "synthetic.transform",
    capabilityPackVersion: 1,
    operationId: "synthetic.transform",
    operationVersion: 1,
    input: { input: "second" },
  });
  const secondAction = makeAction();
  state = apply(state, "ActionNormalized", { action: secondAction });
  state = evolve(state, policyEvent(state, secondAction, "require_approval"));
  assert.throws(
    () => apply(state, "ApprovalRequested", {
      approvalId,
      actionId: secondAction.actionId,
      preconditionHash: "sha256:second",
    }),
    assertDomainError
  );
});

test("released observations must match successful and direct-failure dispositions", () => {
  const success = createEvaluatingActionState();
  let successState = evolve(
    success.state,
    policyEvent(success.state, success.action, "allow")
  );
  successState = apply(successState, "ActionStarted", {
    actionId: success.action.actionId,
    startedAt: "2026-08-30T11:00:09.000Z",
  });
  successState = apply(successState, "ActionSucceeded", {
    actionId: success.action.actionId,
    completedAt: "2026-08-30T11:00:10.000Z",
  });
  const unexpectedError = createDomainError({
    code: "action_failed",
    message: "An error cannot accompany success.",
  });
  assert.throws(
    () => apply(successState, "ObservationReleased", {
      observation: observationFor(success.action.actionId, "failed", unexpectedError),
    }),
    assertDomainError
  );
  assert.throws(
    () => apply(successState, "ObservationReleased", {
      observation: observationFor(success.action.actionId, "succeeded", unexpectedError),
    }),
    assertDomainError
  );

  const failure = createEvaluatingActionState();
  let failureState = evolve(
    failure.state,
    policyEvent(failure.state, failure.action, "allow")
  );
  failureState = apply(failureState, "ActionStarted", {
    actionId: failure.action.actionId,
    startedAt: "2026-08-30T11:00:09.000Z",
  });
  const directError = createDomainError({
    code: "action_failed",
    message: "The action failed directly.",
  });
  failureState = apply(failureState, "ActionFailed", {
    actionId: failure.action.actionId,
    error: directError,
  });
  const differentError = createDomainError({
    code: "action_failed",
    message: "This is a different failure.",
  });
  assert.throws(
    () => apply(failureState, "ObservationReleased", {
      observation: observationFor(failure.action.actionId, "failed", differentError),
    }),
    assertDomainError
  );
  failureState = apply(failureState, "ObservationReleased", {
    observation: observationFor(failure.action.actionId, "failed", directError),
  });
  assert.equal(failureState.status, "planning");
});

test("denial and reconciliation observations must match their recorded disposition", () => {
  const denied = createEvaluatingActionState();
  let deniedState = evolve(
    denied.state,
    policyEvent(denied.state, denied.action, "deny")
  );
  const denial = createDomainError({
    code: "policy_denied",
    message: "Policy denied the action.",
  });
  deniedState = apply(deniedState, "ActionDenied", {
    actionId: denied.action.actionId,
    error: denial,
  });
  assert.throws(
    () => apply(deniedState, "ObservationReleased", {
      observation: observationFor(
        denied.action.actionId,
        "denied",
        createDomainError({ code: "policy_denied", message: "Different denial." })
      ),
    }),
    assertDomainError
  );
  deniedState = apply(deniedState, "ObservationReleased", {
    observation: observationFor(denied.action.actionId, "denied", denial),
  });
  assert.equal(deniedState.status, "planning");

  const reconciled = createEvaluatingActionState();
  let recovered = evolve(
    reconciled.state,
    policyEvent(reconciled.state, reconciled.action, "allow")
  );
  recovered = apply(recovered, "ActionStarted", {
    actionId: reconciled.action.actionId,
    startedAt: "2026-08-30T11:00:09.000Z",
  });
  recovered = apply(recovered, "RecoveryStarted", {
    recoveryId: "recovery:disposition",
    startedAt: "2026-08-30T11:00:10.000Z",
  });
  recovered = apply(recovered, "ActionReconciled", {
    actionId: reconciled.action.actionId,
    disposition: "succeeded",
    evidence: { receipt: "sha256:recovered" },
  });
  assert.throws(
    () => apply(recovered, "ObservationReleased", {
      observation: observationFor(
        reconciled.action.actionId,
        "uncertain",
        createDomainError({
          code: "attempt_result_uncertain",
          message: "Wrong reconciliation disposition.",
        })
      ),
    }),
    assertDomainError
  );
  recovered = apply(recovered, "ObservationReleased", {
    observation: observationFor(reconciled.action.actionId, "succeeded", null),
  });
  assert.equal(recovered.status, "recovering");

  for (const [disposition, error] of [
    ["failed", null],
    [
      "uncertain",
      createDomainError({
        code: "attempt_result_uncertain",
        message: "Reconciliation could not establish the result.",
      }),
    ],
  ] as const) {
    const setup = createEvaluatingActionState();
    let state = evolve(setup.state, policyEvent(setup.state, setup.action, "allow"));
    state = apply(state, "ActionStarted", {
      actionId: setup.action.actionId,
      startedAt: "2026-08-30T11:00:09.000Z",
    });
    state = apply(state, "RecoveryStarted", {
      recoveryId: `recovery:${disposition}`,
      startedAt: "2026-08-30T11:00:10.000Z",
    });
    state = apply(state, "ActionReconciled", {
      actionId: setup.action.actionId,
      disposition,
      evidence: { receipt: `sha256:${disposition}` },
    });
    const wrongStatus = disposition === "failed" ? "uncertain" : "failed";
    assert.throws(
      () => apply(state, "ObservationReleased", {
        observation: observationFor(setup.action.actionId, wrongStatus, error),
      }),
      assertDomainError
    );
    state = apply(state, "ObservationReleased", {
      observation: observationFor(setup.action.actionId, disposition, error),
    });
    assert.equal(state.status, "recovering");
  }
});

test("cancel settlement plans nonconsequential finalization for agent, context, and action", () => {
  let agent = createWaitingForAgentState();
  const agentAttemptId = agent.currentAttempt?.attemptId;
  assert.ok(agentAttemptId);
  agent = apply(agent, "CancellationRequested", { reason: "stop agent" });
  const agentSettled = nextEvent(agent, "AgentAttemptFailed", {
    attemptId: agentAttemptId,
    error: createDomainError({ code: "cancelled", message: "Agent cancelled." }),
  });
  assert.deepEqual(
    planEffects(agent, agentSettled).map(({ commandType, consequential, payload }) => ({
      commandType,
      consequential,
      payload,
    })),
    [{
      commandType: "FinalizeRun",
      consequential: false,
      payload: { terminalStatus: "cancelled" },
    }]
  );
  agent = evolve(agent, agentSettled);
  assert.equal(agent.outstandingCommand, null);

  let context = createWaitingForAgentState();
  context = apply(context, "ContextRequested", {
    requestId: "context:cancel",
    resource: {
      schemaVersion: 1,
      scheme: "fixture",
      sourceId: "source:synthetic",
      locator: { item: "alpha" },
      mediaType: "application/json",
      classification: "internal",
    },
  });
  context = apply(context, "CancellationRequested", { reason: "stop context" });
  const contextSettled = nextEvent(context, "ContextDenied", {
    requestId: "context:cancel",
    error: createDomainError({ code: "cancelled", message: "Context cancelled." }),
  });
  assert.equal(planEffects(context, contextSettled)[0]?.commandType, "FinalizeRun");
  assert.equal(planEffects(context, contextSettled)[0]?.consequential, false);

  const actionSetup = createEvaluatingActionState();
  let action = evolve(
    actionSetup.state,
    policyEvent(actionSetup.state, actionSetup.action, "allow")
  );
  action = apply(action, "ActionStarted", {
    actionId: actionSetup.action.actionId,
    startedAt: "2026-08-30T11:00:09.000Z",
  });
  action = apply(action, "CancellationRequested", { reason: "stop action" });
  const actionError = createDomainError({
    code: "cancelled",
    message: "Action cancelled.",
  });
  action = apply(action, "ActionFailed", {
    actionId: actionSetup.action.actionId,
    error: actionError,
  });
  const observationReleased = nextEvent(action, "ObservationReleased", {
    observation: observationFor(actionSetup.action.actionId, "failed", actionError),
  });
  assert.equal(planEffects(action, observationReleased)[0]?.commandType, "FinalizeRun");
  assert.equal(planEffects(action, observationReleased)[0]?.consequential, false);
});

test("recovered recovery refuses every unresolved command, context, action, or attempt", () => {
  const recovered = (state: RunState, recoveryId: string): void => {
    assert.throws(
      () => apply(state, "RecoveryCompleted", {
        recoveryId,
        disposition: "recovered",
      }),
      assertDomainError
    );
  };

  let commandOnly = createStartedState();
  commandOnly = apply(commandOnly, "RecoveryStarted", {
    recoveryId: "recovery:command",
    startedAt: "2026-08-30T11:00:07.000Z",
  });
  assert.equal(commandOnly.currentAttempt, null);
  assert.equal(commandOnly.currentContextRequest, null);
  assert.equal(commandOnly.currentAction, null);
  assert.ok(commandOnly.outstandingCommand);
  recovered(commandOnly, "recovery:command");

  let activeAttempt = createWaitingForAgentState();
  activeAttempt = apply(activeAttempt, "RecoveryStarted", {
    recoveryId: "recovery:active-attempt",
    startedAt: "2026-08-30T11:00:08.000Z",
  });
  recovered(activeAttempt, "recovery:active-attempt");

  let uncertainAttempt = createWaitingForAgentState();
  uncertainAttempt = apply(uncertainAttempt, "AgentAttemptUncertain", {
    attemptId:
      uncertainAttempt.currentAttempt?.attemptId ?? assert.fail("missing attempt"),
    error: createDomainError({
      code: "attempt_result_uncertain",
      message: "Attempt is uncertain.",
    }),
  });
  uncertainAttempt = apply(uncertainAttempt, "RecoveryStarted", {
    recoveryId: "recovery:uncertain-attempt",
    startedAt: "2026-08-30T11:00:09.000Z",
  });
  recovered(uncertainAttempt, "recovery:uncertain-attempt");

  let context = createWaitingForAgentState();
  context = apply(context, "ContextRequested", {
    requestId: "context:recovery",
    resource: {
      schemaVersion: 1,
      scheme: "fixture",
      sourceId: "source:synthetic",
      locator: { item: "alpha" },
      mediaType: "application/json",
      classification: "internal",
    },
  });
  context = apply(context, "RecoveryStarted", {
    recoveryId: "recovery:context",
    startedAt: "2026-08-30T11:00:10.000Z",
  });
  recovered(context, "recovery:context");

  const actionSetup = createEvaluatingActionState();
  let action = actionSetup.state;
  assert.equal(action.outstandingCommand, null);
  action = apply(action, "RecoveryStarted", {
    recoveryId: "recovery:action",
    startedAt: "2026-08-30T11:00:10.000Z",
  });
  recovered(action, "recovery:action");
});
