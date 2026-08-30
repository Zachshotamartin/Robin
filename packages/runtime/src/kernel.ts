import { isProxy } from "node:util/types";

import {
  ActionIdKind,
  AgentAttemptIdKind,
  ApprovalIdKind,
  ArtifactIdKind,
  CommandIdKind,
  DriverProposalIdKind,
  PolicyVersionIdKind,
  RunIdKind,
  assertContractSchemaVersion,
  assertEventEnvelope,
  assertNewEvent,
  canonicalSha256Hex,
  canonicalize,
  createDomainError,
  isDomainError,
  isErrorId,
  isGenericEventType,
  parseEventEnvelope,
  parseGenericEventEnvelope,
} from "@guard/contracts";
import type {
  DomainError,
  EventEnvelope,
  GenericEvent,
  GenericEventEnvelope,
  GenericEventType,
  JsonObject,
  JsonValue,
  RunResult,
} from "@guard/contracts";

import { EVENT_LEGAL_STATES, INTENT_LEGAL_STATES } from "./legal-states.js";
import {
  RUN_LIFECYCLE_STATUSES,
  RUN_STATE_SCHEMA_VERSION,
  TERMINAL_RUN_STATUSES,
} from "./types.js";
import type {
  CurrentActionProjection,
  ExpectedObservationProjection,
  RunBudgetCounters,
  RunIntent,
  RunIntentType,
  RunLifecycleStatus,
  RunProjectionStatus,
  RunState,
  RegisteredEventEnvelopeFramer,
  RuntimeCommand,
  RuntimeCommandType,
} from "./types.js";

const RUN_STATUS_SET: ReadonlySet<string> = new Set([
  "uninitialized",
  ...RUN_LIFECYCLE_STATUSES,
]);
const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

const ZERO_BUDGET: RunBudgetCounters = Object.freeze({
  elapsedMs: 0,
  turnsStarted: 0,
  actionsProposed: 0,
  actionsStarted: 0,
  usageRecords: 0,
  inputBytes: 0,
  outputBytes: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostMicros: 0,
  contextBytesReleased: 0,
  agentContentBytes: 0,
  observationsReleased: 0,
  policyDenials: 0,
  retriesScheduled: 0,
  artifactsReferenced: 0,
});

const INTENT_EVENT_TYPES: Readonly<Record<RunIntentType, GenericEventType>> =
  Object.freeze({
    create_run: "RunCreated",
    pin_task_profile: "TaskProfilePinned",
    start_run: "RunStarted",
    append_run_intent: "RunIntentAppended",
    pause_run: "RunPaused",
    resume_run: "RunResumed",
    request_cancellation: "CancellationRequested",
    cancel_run: "RunCancelled",
    fail_run: "RunFailed",
    complete_run: "RunCompleted",
    orphan_run: "RunOrphaned",
  });

const CLEAR_OUTSTANDING_EVENTS: ReadonlySet<GenericEventType> = new Set([
  "AgentAttemptUncertain",
  "AgentAttemptFailed",
  "ContextRequested",
  "ContextReleased",
  "ContextDenied",
  "ActionProposed",
  "ActionSucceeded",
  "ActionFailed",
  "ActionReconciled",
  "OutcomeProposed",
  "CancellationRequested",
  "RecoveryCompleted",
  "RunCancelled",
  "RunFailed",
  "RunCompleted",
  "RunOrphaned",
]);

const WORK_STARTING_EVENTS: ReadonlySet<GenericEventType> = new Set([
  "RunResumed",
  "AgentAttemptStarted",
  "ContextRequested",
  "ActionProposed",
  "ActionStarted",
  "ApprovalRequested",
  "ApprovalConsumed",
  "OutcomeProposed",
  "RetryScheduled",
]);

export function createInitialRunState(): RunState {
  return immutable({
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    status: "uninitialized",
    runId: null,
    streamVersion: 0,
    lastEventId: null,
    lastRecordedAt: null,
    objective: null,
    taskProfile: null,
    startedAt: null,
    pausedFrom: null,
    driver: null,
    usedAgentAttemptIds: [],
    usedDriverProposalIds: [],
    usedActionIds: [],
    usedApprovalIds: [],
    currentAttempt: null,
    currentContextRequest: null,
    currentAction: null,
    pendingApproval: null,
    proposedOutcome: null,
    validatedOutcome: null,
    result: null,
    outstandingCommand: null,
    cancellation: null,
    recovery: null,
    budgetExceeded: null,
    budget: ZERO_BUDGET,
    appendedIntentCount: 0,
    artifacts: [],
  });
}

/** Pure intent decision; callers inject event identity and time in the intent. */
export function decide(
  state: RunState,
  intent: RunIntent
): readonly GenericEvent[] {
  assertStateBoundary(state);
  assertIntentBoundary(intent);

  const legalStates = INTENT_LEGAL_STATES[intent.intentType];
  if (!(legalStates as readonly RunProjectionStatus[]).includes(state.status)) {
    throw illegalTransition(
      `Intent ${intent.intentType} is not legal while the run is ${state.status}.`,
      { intentType: intent.intentType, status: state.status }
    );
  }

  if (intent.event.eventType !== INTENT_EVENT_TYPES[intent.intentType]) {
    throw invalidInput("The run intent carries the wrong event type.", {
      intentType: intent.intentType,
      eventType: intent.event.eventType,
    });
  }
  validateIntentSemantics(state, intent);
  if (state.budgetExceeded !== null && intent.intentType !== "fail_run" &&
      intent.intentType !== "orphan_run" && intent.intentType !== "request_cancellation") {
    throw createDomainError({
      code: "budget_exceeded",
      message: "The run cannot accept new work after a budget was exceeded.",
      details: { budget: state.budgetExceeded.budget },
    });
  }
  if (intent.intentType === "pause_run" &&
      (state.outstandingCommand !== null || state.pendingApproval !== null)) {
    throw illegalTransition(
      "A run with outstanding work or approval cannot be paused.",
      { status: state.status }
    );
  }

  return immutable([intent.event]);
}

/**
 * Pure reducer. It validates ordering and transition legality, derives a new
 * immutable projection, and never invokes an adapter.
 */
export function evolve(
  state: RunState,
  event: GenericEventEnvelope
): RunState {
  try {
    assertStateBoundary(state);
    assertEventBoundary(state, event);
    const commands = planEffectsUnchecked(state, event);
    let next = reduceEvent(state, event);
    next = reconcileOutstandingCommand(state, next, event, commands);
    next = {
      ...next,
      runId: event.streamId,
      streamVersion: event.streamVersion,
      lastEventId: event.eventId,
      lastRecordedAt: event.recordedAt,
      budget: {
        ...next.budget,
        elapsedMs: elapsedMs(next.startedAt, event.recordedAt),
      },
    };
    assertStateInvariants(next);
    return immutable(next);
  } catch (error: unknown) {
    if (isDomainError(error)) {
      throw error;
    }
    throw createDomainError({
      code: "invariant_violated",
      message: "The runtime rejected a malformed or inconsistent transition.",
      details: {
        eventType:
          typeof event === "object" && event !== null && "eventType" in event &&
          typeof event.eventType === "string"
            ? event.eventType
            : "unknown",
      },
    });
  }
}

/** Plans durable command data only; execution belongs to external workers. */
export function planEffects(
  state: RunState,
  event: GenericEventEnvelope
): readonly RuntimeCommand[] {
  assertStateBoundary(state);
  assertEventBoundary(state, event);
  return immutable(planEffectsUnchecked(state, event));
}

/** Replay calls only the pure reducer and requires a gap-free single stream. */
export function replay(history: Iterable<GenericEventEnvelope>): RunState {
  let state = createInitialRunState();
  for (const event of history) {
    state = evolve(state, event);
  }
  return state;
}

/**
 * Evolves either a strict generic event or a parser-confirmed informational
 * extension. The supplied family framer is invoked for every envelope.
 */
export function evolveRegistered(
  state: RunState,
  event: unknown,
  framer: RegisteredEventEnvelopeFramer
): RunState {
  const framed = frameRegisteredEnvelope(event, framer);
  if (isGenericEventType(framed.eventType)) {
    return evolve(state, parseGenericEventEnvelope(framed));
  }

  try {
    assertStateBoundary(state);
    assertInformationalExtensionBoundary(state, framed);
    const next: RunState = {
      ...state,
      runId: framed.streamId,
      streamVersion: framed.streamVersion,
      lastEventId: framed.eventId,
      lastRecordedAt: framed.recordedAt,
      budget: {
        ...state.budget,
        elapsedMs: elapsedMs(state.startedAt, framed.recordedAt),
      },
    };
    assertStateInvariants(next);
    return immutable(next);
  } catch (error: unknown) {
    if (isDomainError(error)) {
      throw error;
    }
    throw createDomainError({
      code: "invariant_violated",
      message: "The runtime rejected an inconsistent registered extension fact.",
    });
  }
}

/** Generic events retain their planner; registered extensions plan no effects. */
export function planRegisteredEffects(
  state: RunState,
  event: unknown,
  framer: RegisteredEventEnvelopeFramer
): readonly RuntimeCommand[] {
  const framed = frameRegisteredEnvelope(event, framer);
  if (isGenericEventType(framed.eventType)) {
    return planEffects(state, parseGenericEventEnvelope(framed));
  }
  assertStateBoundary(state);
  assertInformationalExtensionBoundary(state, framed);
  return immutable([]);
}

/** Pure, gap-free replay across generic and registered informational facts. */
export function replayRegistered(
  history: Iterable<unknown>,
  framer: RegisteredEventEnvelopeFramer
): RunState {
  let state = createInitialRunState();
  for (const event of history) {
    state = evolveRegistered(state, event, framer);
  }
  return state;
}

function reduceEvent(state: RunState, event: GenericEventEnvelope): RunState {
  switch (event.eventType) {
    case "RunCreated": {
      ensureObject(event.payload.objective, "RunCreated.objective");
      ensureNonEmpty(event.payload.objective.profileId, "objective.profileId");
      ensurePositiveInteger(
        event.payload.objective.profileVersion,
        "objective.profileVersion"
      );
      return {
        ...state,
        status: "created",
        objective: event.payload.objective,
      };
    }
    case "TaskProfilePinned": {
      const profile = event.payload.taskProfile;
      ensureObject(profile, "TaskProfilePinned.taskProfile");
      ensure(state.objective !== null, "A profile requires a run objective.");
      ensure(state.taskProfile === null, "A task profile may be pinned only once.");
      ensure(
        profile.profileId === state.objective.profileId &&
          profile.profileVersion === state.objective.profileVersion,
        "The pinned profile must exactly match the objective profile binding."
      );
      validateTaskProfileBudgets(profile.budgetPolicy);
      return { ...state, taskProfile: profile };
    }
    case "RunStarted": {
      ensure(state.taskProfile !== null, "RunStarted requires a pinned task profile.");
      ensureTimestamp(event.payload.startedAt, "RunStarted.startedAt");
      return {
        ...state,
        status: "planning",
        startedAt: event.payload.startedAt,
      };
    }
    case "RunIntentAppended": {
      ensureNonEmpty(event.payload.intentType, "RunIntentAppended.intentType");
      ensurePositiveInteger(event.payload.intentVersion, "intentVersion");
      ensureObject(event.payload.payload, "RunIntentAppended.payload");
      ensureObject(event.payload.submittedBy, "RunIntentAppended.submittedBy");
      return {
        ...state,
        appendedIntentCount: safeAdd(state.appendedIntentCount, 1, "appended intents"),
      };
    }
    case "RunPaused": {
      ensure(
        state.outstandingCommand === null && state.pendingApproval === null,
        "A run with outstanding consequential work or approval cannot be paused."
      );
      ensureNullableString(event.payload.reason, "RunPaused.reason");
      ensure(
        state.status === "created" || state.status === "planning" ||
          state.status === "attempt_result_uncertain",
        "RunPaused requires a resumable idle state."
      );
      return {
        ...state,
        status: "paused",
        pausedFrom: state.status,
      };
    }
    case "RunResumed": {
      ensureTimestamp(event.payload.resumedAt, "RunResumed.resumedAt");
      ensure(state.budgetExceeded === null, "A budget-exceeded run cannot resume.");
      ensure(state.pausedFrom !== null, "RunResumed requires a recorded paused state.");
      return {
        ...state,
        status: state.pausedFrom,
        pausedFrom: null,
      };
    }
    case "CancellationRequested": {
      ensureNullableString(event.payload.reason, "CancellationRequested.reason");
      return {
        ...state,
        status: "cancellation_requested",
        pendingApproval: null,
        cancellation: {
          reason: event.payload.reason,
          requestedByEventId: event.eventId,
        },
      };
    }
    case "RunCancelled": {
      validateTerminalResult(event.payload.result, event.streamId, "cancelled");
      ensure(
        state.outstandingCommand === null,
        "RunCancelled requires all consequential work to be settled."
      );
      return terminalState(state, "cancelled", event.payload.result);
    }
    case "RunFailed": {
      validateTerminalResult(event.payload.result, event.streamId, "failed");
      ensure(
        state.outstandingCommand === null,
        "RunFailed requires consequential work to be settled or orphaned."
      );
      return terminalState(state, "failed", event.payload.result);
    }
    case "RunCompleted": {
      validateTerminalResult(event.payload.result, event.streamId, "completed");
      ensure(state.validatedOutcome !== null, "RunCompleted requires a validated outcome.");
      ensure(
        canonicalSha256Hex(event.payload.result.outcome) ===
          canonicalSha256Hex(state.validatedOutcome),
        "RunCompleted must commit the exact validated outcome."
      );
      ensureQuiescent(state, "RunCompleted");
      return terminalState(state, "completed", event.payload.result);
    }
    case "RunOrphaned": {
      validateTerminalResult(event.payload.result, event.streamId, "orphaned");
      return terminalState(state, "orphaned", event.payload.result);
    }
    case "AgentDriverStarted": {
      ensure(state.taskProfile !== null, "AgentDriverStarted requires a task profile.");
      ensure(
        event.payload.driverProfileId === state.taskProfile.driverProfile.componentId &&
          event.payload.driverProfileVersion ===
            state.taskProfile.driverProfile.componentVersion,
        "The driver must match the exact pinned driver profile."
      );
      ensureNonEmpty(event.payload.driverFingerprint, "driverFingerprint");
      ensure(state.driver === null, "The run driver may be started only once.");
      return {
        ...state,
        driver: {
          driverProfileId: event.payload.driverProfileId,
          driverProfileVersion: event.payload.driverProfileVersion,
          driverFingerprint: event.payload.driverFingerprint,
        },
      };
    }
    case "AgentAttemptStarted": {
      ensure(state.driver !== null, "AgentAttemptStarted requires a started driver.");
      ensure(AgentAttemptIdKind.is(event.payload.attemptId), "Invalid agent attempt id.");
      ensurePositiveInteger(event.payload.turn, "AgentAttemptStarted.turn");
      ensure(
        event.payload.turn === state.budget.turnsStarted + 1,
        "Agent turns must be consecutive."
      );
      ensure(
        state.currentAttempt === null || state.currentAttempt.status !== "active",
        "Only one agent attempt may be active."
      );
      const maxTurns = state.taskProfile?.budgetPolicy.maxTurns;
      if (maxTurns !== undefined && event.payload.turn > maxTurns) {
        throw createDomainError({
          code: "budget_exceeded",
          message: "The run has exhausted its turn budget.",
          details: { budget: "maxTurns", consumed: event.payload.turn, limit: maxTurns },
        });
      }
      const usedAgentAttemptIds = appendUniqueBoundedId(
        state.usedAgentAttemptIds,
        event.payload.attemptId,
        maxTurns,
        "agent attempt"
      );
      return {
        ...state,
        status: "waiting_for_agent",
        usedAgentAttemptIds,
        currentAttempt: {
          attemptId: event.payload.attemptId,
          turn: event.payload.turn,
          status: "active",
        },
        budget: incrementBudget(state.budget, { turnsStarted: 1 }),
      };
    }
    case "AgentContentCompleted": {
      assertCurrentAttempt(state, event.payload.attemptId);
      ensure(Array.isArray(event.payload.content), "Agent content must be an array.");
      const contentBytes = sumByteLengths(event.payload.content, "agent content");
      return {
        ...state,
        budget: incrementBudget(state.budget, { agentContentBytes: contentBytes }),
      };
    }
    case "AgentUsageRecorded": {
      assertCurrentAttempt(state, event.payload.attemptId);
      ensureObject(event.payload.usage, "AgentUsageRecorded.usage");
      return {
        ...state,
        budget: incrementBudget(state.budget, {
          usageRecords: 1,
          inputBytes: usageValue(event.payload.usage, "inputBytes"),
          outputBytes: usageValue(event.payload.usage, "outputBytes"),
          inputTokens: usageValue(event.payload.usage, "inputTokens"),
          outputTokens: usageValue(event.payload.usage, "outputTokens"),
          estimatedCostMicros: usageValue(
            event.payload.usage,
            "estimatedCostMicros"
          ),
        }),
      };
    }
    case "AgentAttemptUncertain": {
      assertCurrentAttempt(state, event.payload.attemptId);
      ensureDomainError(event.payload.error, "AgentAttemptUncertain.error");
      return {
        ...state,
        status:
          state.status === "cancellation_requested"
            ? "cancellation_requested"
            : state.status === "recovering"
              ? "recovering"
              : "attempt_result_uncertain",
        currentAttempt: { ...state.currentAttempt!, status: "uncertain" },
      };
    }
    case "AgentAttemptFailed": {
      assertCurrentAttempt(state, event.payload.attemptId);
      ensureDomainError(event.payload.error, "AgentAttemptFailed.error");
      return {
        ...state,
        status: passiveStatus(state, "planning"),
        currentAttempt: { ...state.currentAttempt!, status: "failed" },
      };
    }
    case "ContextRequested": {
      ensureNonEmpty(event.payload.requestId, "ContextRequested.requestId");
      ensure(state.currentContextRequest === null, "Only one context request may be active.");
      ensureObject(event.payload.resource, "ContextRequested.resource");
      return {
        ...state,
        currentContextRequest: { requestId: event.payload.requestId },
      };
    }
    case "ContextManifestRecorded": {
      ensure(
        event.payload.manifestKind === "release" ||
          event.payload.manifestKind === "agent_input",
        "ContextManifestRecorded requires a recognized manifest kind."
      );
      ensureNonEmpty(
        event.payload.referenceId,
        "ContextManifestRecorded.referenceId"
      );
      ensureObject(event.payload.manifest, "ContextManifestRecorded.manifest");
      return state;
    }
    case "ContextReleased": {
      assertContextRequest(state, event.payload.requestId);
      ensure(Array.isArray(event.payload.content), "Released context must be an array.");
      return {
        ...state,
        currentContextRequest: null,
        budget: incrementBudget(state.budget, {
          contextBytesReleased: sumByteLengths(event.payload.content, "context"),
        }),
      };
    }
    case "ContextDenied": {
      assertContextRequest(state, event.payload.requestId);
      ensureDomainError(event.payload.error, "ContextDenied.error");
      return { ...state, currentContextRequest: null };
    }
    case "ContextRedacted": {
      assertContextRequest(state, event.payload.requestId);
      ensure(
        Array.isArray(event.payload.transformationIds) &&
          event.payload.transformationIds.every(
            (id) => typeof id === "string" && id.trim().length > 0
          ),
        "ContextRedacted requires transformation identifiers."
      );
      return state;
    }
    case "ActionProposed": {
      ensure(state.currentAction === null, "Only one action may be in flight.");
      ensure(DriverProposalIdKind.is(event.payload.proposalId), "Invalid proposal id.");
      ensureNonEmpty(event.payload.capabilityPackId, "capabilityPackId");
      ensurePositiveInteger(
        event.payload.capabilityPackVersion,
        "capabilityPackVersion"
      );
      ensureNonEmpty(event.payload.operationId, "operationId");
      ensurePositiveInteger(event.payload.operationVersion, "operationVersion");
      ensureObject(event.payload.input, "ActionProposed.input");
      const nextActionCount = safeAdd(
        state.budget.actionsProposed,
        1,
        "proposed actions"
      );
      const maxActions = state.taskProfile?.budgetPolicy.maxActions;
      if (maxActions !== undefined && nextActionCount > maxActions) {
        throw createDomainError({
          code: "budget_exceeded",
          message: "The run has exhausted its action budget.",
          details: {
            budget: "maxActions",
            consumed: nextActionCount,
            limit: maxActions,
          },
        });
      }
      assertExactlyOnePinnedCapability(
        state,
        event.payload.capabilityPackId,
        event.payload.capabilityPackVersion
      );
      const usedDriverProposalIds = appendUniqueBoundedId(
        state.usedDriverProposalIds,
        event.payload.proposalId,
        maxActions,
        "driver proposal"
      );
      const currentAttempt = state.currentAttempt === null
        ? null
        : { ...state.currentAttempt, status: "completed" as const };
      return {
        ...state,
        status: "evaluating_action",
        usedDriverProposalIds,
        currentAttempt,
        currentAction: {
          proposalId: event.payload.proposalId,
          capabilityPackId: event.payload.capabilityPackId,
          capabilityPackVersion: event.payload.capabilityPackVersion,
          operationId: event.payload.operationId,
          operationVersion: event.payload.operationVersion,
          input: event.payload.input,
          normalizedAction: null,
          policyEvaluation: null,
          expectedObservation: null,
          phase: "proposed",
        },
        budget: incrementBudget(state.budget, { actionsProposed: 1 }),
      };
    }
    case "ActionNormalized": {
      const current = requireCurrentAction(state);
      ensure(current.phase === "proposed", "An action may be normalized only once.");
      const action = event.payload.action;
      ensureObject(action, "ActionNormalized.action");
      ensure(ActionIdKind.is(action.actionId), "Invalid normalized action id.");
      ensurePositiveInteger(action.capabilityPackVersion, "capabilityPackVersion");
      ensure(
        action.capabilityPackId === current.capabilityPackId &&
          action.capabilityPackVersion === current.capabilityPackVersion &&
          action.operationId === current.operationId &&
          action.operationVersion === current.operationVersion,
        "Normalized action identity must match the proposal."
      );
      assertExactlyOnePinnedCapability(
        state,
        action.capabilityPackId,
        action.capabilityPackVersion
      );
      const usedActionIds = appendUniqueBoundedId(
        state.usedActionIds,
        action.actionId,
        state.taskProfile?.budgetPolicy.maxActions,
        "action"
      );
      return {
        ...state,
        usedActionIds,
        currentAction: {
          ...current,
          normalizedAction: action,
          phase: "normalized",
        },
      };
    }
    case "PolicyEvaluated": {
      const current = requireNormalizedAction(state);
      ensure(current.phase === "normalized", "An action may be policy-evaluated only once.");
      ensure(
        event.payload.actionId === current.normalizedAction.actionId,
        "Policy evaluation action id mismatch."
      );
      ensure(PolicyVersionIdKind.is(event.payload.policyVersionId), "Invalid policy version id.");
      ensure(
        event.payload.decision === "allow" ||
          event.payload.decision === "deny" ||
          event.payload.decision === "require_approval",
        "Unknown policy decision."
      );
      const phase = event.payload.decision === "allow"
        ? "allowed"
        : event.payload.decision === "deny"
          ? "denied"
          : "approval_required";
      return {
        ...state,
        currentAction: {
          ...current,
          policyEvaluation: {
            policyVersionId: event.payload.policyVersionId,
            decision: event.payload.decision,
            trace: event.payload.trace,
          },
          phase,
        },
      };
    }
    case "ActionDenied": {
      const current = requireNormalizedAction(state);
      assertCurrentActionId(current, event.payload.actionId);
      ensureDomainError(event.payload.error, "ActionDenied.error");
      ensure(
        current.phase === "denied" || current.phase === "approval_rejected",
        "ActionDenied requires a denied policy or approval."
      );
      return {
        ...state,
        status: passiveStatus(state, "recording_observation"),
        currentAction: {
          ...current,
          expectedObservation: {
            status: "denied",
            error: {
              kind: "same_error_id",
              errorId: event.payload.error.errorId,
            },
          },
          phase: "denied",
        },
        budget: incrementBudget(state.budget, { policyDenials: 1 }),
      };
    }
    case "ActionStarted": {
      const current = requireNormalizedAction(state);
      assertCurrentActionId(current, event.payload.actionId);
      ensure(
        current.phase === "allowed" || current.phase === "approved",
        "ActionStarted requires an allowed or approved action."
      );
      ensureTimestamp(event.payload.startedAt, "ActionStarted.startedAt");
      return {
        ...state,
        status: "executing_action",
        currentAction: { ...current, phase: "executing" },
        budget: incrementBudget(state.budget, { actionsStarted: 1 }),
      };
    }
    case "ActionSucceeded": {
      const current = requireExecutingAction(state, event.payload.actionId);
      ensureTimestamp(event.payload.completedAt, "ActionSucceeded.completedAt");
      return {
        ...state,
        status: passiveStatus(state, "recording_observation"),
        currentAction: {
          ...current,
          expectedObservation: {
            status: "succeeded",
            error: { kind: "none" },
          },
          phase: "result_recorded",
        },
      };
    }
    case "ActionFailed": {
      const current = requireExecutingAction(state, event.payload.actionId);
      ensureDomainError(event.payload.error, "ActionFailed.error");
      return {
        ...state,
        status: passiveStatus(state, "recording_observation"),
        currentAction: {
          ...current,
          expectedObservation: {
            status: "failed",
            error: {
              kind: "same_error_id",
              errorId: event.payload.error.errorId,
            },
          },
          phase: "result_recorded",
        },
      };
    }
    case "ActionReconciled": {
      const current = requireCurrentAction(state);
      ensure(current.normalizedAction !== null, "Reconciliation requires a normalized action.");
      assertCurrentActionId(current, event.payload.actionId);
      ensure(
        event.payload.disposition === "absent" ||
          event.payload.disposition === "succeeded" ||
          event.payload.disposition === "failed" ||
          event.payload.disposition === "uncertain",
        "Unknown reconciliation disposition."
      );
      if (event.payload.disposition === "absent") {
        return {
          ...state,
          status: passiveStatus(state, "planning"),
          currentAction: null,
        };
      }
      return {
        ...state,
        status:
          event.payload.disposition === "uncertain"
            ? state.status === "recovering"
              ? "recovering"
              : state.status === "cancellation_requested"
                ? "cancellation_requested"
                : "attempt_result_uncertain"
            : passiveStatus(state, "recording_observation"),
        currentAction: {
          ...current,
          expectedObservation: reconciliationObservationExpectation(
            event.payload.disposition
          ),
          phase: "result_recorded",
        },
      };
    }
    case "ObservationReleased": {
      const current = requireNormalizedAction(state);
      assertCurrentActionId(current, event.payload.observation.actionId);
      ensure(
        current.phase === "result_recorded" || current.phase === "denied",
        "ObservationReleased requires a recorded or denied action result."
      );
      assertObservationMatchesExpectation(
        current.expectedObservation,
        event.payload.observation.status,
        event.payload.observation.error
      );
      return {
        ...state,
        status: passiveStatus(state, "planning"),
        currentAction: null,
        budget: incrementBudget(state.budget, { observationsReleased: 1 }),
      };
    }
    case "ApprovalRequested": {
      const current = requireNormalizedAction(state);
      ensure(current.phase === "approval_required", "Policy did not require approval.");
      assertCurrentActionId(current, event.payload.actionId);
      ensure(ApprovalIdKind.is(event.payload.approvalId), "Invalid approval id.");
      ensureNonEmpty(event.payload.preconditionHash, "preconditionHash");
      ensure(state.pendingApproval === null, "Only one approval may be pending.");
      const usedApprovalIds = appendUniqueBoundedId(
        state.usedApprovalIds,
        event.payload.approvalId,
        state.taskProfile?.budgetPolicy.maxActions,
        "approval"
      );
      return {
        ...state,
        status: "waiting_for_approval",
        usedApprovalIds,
        pendingApproval: {
          approvalId: event.payload.approvalId,
          actionId: event.payload.actionId,
          preconditionHash: event.payload.preconditionHash,
          status: "requested",
        },
      };
    }
    case "ApprovalGranted": {
      const pending = requirePendingApproval(state, event.payload.approvalId);
      ensure(pending.status === "requested", "Approval was already granted.");
      return {
        ...state,
        pendingApproval: { ...pending, status: "granted" },
      };
    }
    case "ApprovalDenied": {
      requirePendingApproval(state, event.payload.approvalId);
      return rejectApproval(state);
    }
    case "ApprovalExpired": {
      requirePendingApproval(state, event.payload.approvalId);
      return rejectApproval(state);
    }
    case "ApprovalInvalidated": {
      requirePendingApproval(state, event.payload.approvalId);
      ensureNonEmpty(event.payload.reason, "ApprovalInvalidated.reason");
      return rejectApproval(state);
    }
    case "ApprovalConsumed": {
      const pending = requirePendingApproval(state, event.payload.approvalId);
      ensure(pending.status === "granted", "Only a granted approval can be consumed.");
      ensure(pending.actionId === event.payload.actionId, "Approval action id mismatch.");
      const current = requireNormalizedAction(state);
      assertCurrentActionId(current, event.payload.actionId);
      return {
        ...state,
        status: "evaluating_action",
        pendingApproval: null,
        currentAction: { ...current, phase: "approved" },
      };
    }
    case "OutcomeProposed": {
      ensure(state.taskProfile !== null, "OutcomeProposed requires a task profile.");
      ensure(
        event.payload.outcome.profileId === state.taskProfile.profileId &&
          event.payload.outcome.profileVersion === state.taskProfile.profileVersion,
        "The outcome must match the pinned task profile."
      );
      ensure(
        state.currentAction === null && state.pendingApproval === null,
        "An outcome cannot be proposed while an action or approval is active."
      );
      return {
        ...state,
        status: "planning",
        proposedOutcome: event.payload.outcome,
        validatedOutcome: null,
        currentAttempt:
          state.currentAttempt === null
            ? null
            : { ...state.currentAttempt, status: "completed" },
      };
    }
    case "OutcomeValidated": {
      ensure(state.proposedOutcome !== null, "OutcomeValidated requires a proposed outcome.");
      ensure(state.validatedOutcome === null, "An outcome may be validated only once.");
      ensure(
        event.payload.outcomeId === state.proposedOutcome.outcomeId,
        "Validated outcome id mismatch."
      );
      ensure(
        canonicalSha256Hex(event.payload.evidence) ===
          canonicalSha256Hex(state.proposedOutcome.evidence),
        "Validated evidence must match the proposed outcome evidence."
      );
      ensureTimestamp(event.payload.validatedAt, "OutcomeValidated.validatedAt");
      return { ...state, validatedOutcome: state.proposedOutcome };
    }
    case "ArtifactReferenced": {
      ensure(ArtifactIdKind.is(event.payload.artifactId), "Invalid artifact id.");
      ensureNonEmpty(event.payload.contentHash, "ArtifactReferenced.contentHash");
      ensureNonEmpty(event.payload.mediaType, "ArtifactReferenced.mediaType");
      ensure(
        !state.artifacts.some(({ artifactId }) => artifactId === event.payload.artifactId),
        "An artifact may be referenced only once in a run."
      );
      return {
        ...state,
        artifacts: [
          ...state.artifacts,
          {
            artifactId: event.payload.artifactId,
            contentHash: event.payload.contentHash,
            mediaType: event.payload.mediaType,
          },
        ],
        budget: incrementBudget(state.budget, { artifactsReferenced: 1 }),
      };
    }
    case "RetryScheduled": {
      ensureNonEmpty(event.payload.attemptType, "RetryScheduled.attemptType");
      ensurePositiveInteger(event.payload.ordinal, "RetryScheduled.ordinal");
      ensureTimestamp(event.payload.scheduledAt, "RetryScheduled.scheduledAt");
      ensure(state.outstandingCommand === null, "A retry cannot overlap outstanding work.");
      ensure(state.budgetExceeded === null, "A retry cannot start after budget exhaustion.");
      return {
        ...state,
        status: "planning",
        budget: incrementBudget(state.budget, { retriesScheduled: 1 }),
      };
    }
    case "BudgetExceeded": {
      ensureNonEmpty(event.payload.budget, "BudgetExceeded.budget");
      ensureNonNegativeNumber(event.payload.consumed, "BudgetExceeded.consumed");
      ensureNonNegativeNumber(event.payload.limit, "BudgetExceeded.limit");
      ensure(
        event.payload.consumed >= event.payload.limit,
        "BudgetExceeded consumed value must meet or exceed its limit."
      );
      ensure(state.budgetExceeded === null, "A budget-exceeded fact is already recorded.");
      ensure(
        state.outstandingCommand === null,
        "BudgetExceeded must be recorded after active consequential work settles."
      );
      return {
        ...state,
        status: "planning",
        budgetExceeded: {
          budget: event.payload.budget,
          consumed: event.payload.consumed,
          limit: event.payload.limit,
        },
      };
    }
    case "RecoveryStarted": {
      ensureNonEmpty(event.payload.recoveryId, "RecoveryStarted.recoveryId");
      ensureTimestamp(event.payload.startedAt, "RecoveryStarted.startedAt");
      ensure(state.recovery === null, "Only one recovery may be active.");
      ensure(state.status !== "uninitialized", "An uninitialized run cannot recover.");
      return {
        ...state,
        status: "recovering",
        recovery: {
          recoveryId: event.payload.recoveryId,
          previousStatus: state.status,
          disposition: "pending",
        },
      };
    }
    case "RecoveryCompleted": {
      ensure(state.recovery !== null, "RecoveryCompleted requires active recovery.");
      ensure(
        event.payload.recoveryId === state.recovery.recoveryId,
        "Recovery identifier mismatch."
      );
      ensure(
        event.payload.disposition === "recovered" ||
          event.payload.disposition === "orphaned" ||
          event.payload.disposition === "failed",
        "Unknown recovery disposition."
      );
      const status = event.payload.disposition === "recovered"
        ? recoveredStatus(state.recovery.previousStatus)
        : "recovering";
      return {
        ...state,
        status,
        recovery:
          event.payload.disposition === "recovered"
            ? null
            : { ...state.recovery, disposition: event.payload.disposition },
      };
    }
    default:
      return assertNever(event);
  }
}

function planEffectsUnchecked(
  state: RunState,
  event: GenericEventEnvelope
): readonly RuntimeCommand[] {
  const one = (
    commandType: RuntimeCommandType,
    consequential: boolean,
    payload: JsonObject
  ): readonly RuntimeCommand[] => [
    makeCommand(event, commandType, consequential, payload),
  ];
  const none: readonly RuntimeCommand[] = [];

  switch (event.eventType) {
    case "RunStarted":
      return one("AdvanceAgentDriver", true, { nextTurn: state.budget.turnsStarted + 1 });
    case "RunResumed":
      if (state.pausedFrom !== "planning") return none;
      if (state.validatedOutcome !== null) {
        return one("FinalizeRun", false, {
          terminalStatus: "completed",
          outcomeId: state.validatedOutcome.outcomeId,
        });
      }
      return state.startedAt === null
        ? none
        : one("AdvanceAgentDriver", true, { nextTurn: state.budget.turnsStarted + 1 });
    case "ContextRequested":
      return one("FetchContextResource", true, { requestId: event.payload.requestId });
    case "ContextReleased":
    case "ContextDenied":
      if (state.status === "cancellation_requested") {
        return one("FinalizeRun", false, { terminalStatus: "cancelled" });
      }
      return state.status === "recovering"
        ? none
        : one("AdvanceAgentDriver", true, { nextTurn: state.budget.turnsStarted });
    case "ActionProposed":
      return one("EvaluateCapabilityAction", false, {
        proposalId: event.payload.proposalId,
        capabilityPackId: event.payload.capabilityPackId,
        capabilityPackVersion: event.payload.capabilityPackVersion,
        operationId: event.payload.operationId,
        operationVersion: event.payload.operationVersion,
      });
    case "PolicyEvaluated":
      if (event.payload.decision === "allow") {
        return one("ExecuteCapabilityAction", true, {
          actionId: event.payload.actionId,
        });
      }
      if (event.payload.decision === "require_approval") {
        return one("CreateApprovalRequest", false, {
          actionId: event.payload.actionId,
        });
      }
      return none;
    case "ApprovalConsumed":
      return one("ExecuteCapabilityAction", true, {
        actionId: event.payload.actionId,
      });
    case "ObservationReleased":
      if (state.status === "cancellation_requested") {
        return one("FinalizeRun", false, { terminalStatus: "cancelled" });
      }
      return state.status === "recovering" || state.budgetExceeded !== null
        ? none
        : one("AdvanceAgentDriver", true, {
            nextTurn: state.budget.turnsStarted + 1,
          });
    case "AgentAttemptFailed":
      return state.status === "cancellation_requested"
        ? one("FinalizeRun", false, { terminalStatus: "cancelled" })
        : none;
    case "RetryScheduled":
      return one("AdvanceAgentDriver", true, {
        retryOrdinal: event.payload.ordinal,
      });
    case "OutcomeProposed":
      return one("ValidateOutcome", false, {
        outcomeId: event.payload.outcome.outcomeId,
      });
    case "OutcomeValidated":
      return one("FinalizeRun", false, {
        terminalStatus: "completed",
        outcomeId: event.payload.outcomeId,
      });
    case "CancellationRequested":
      return state.outstandingCommand === null
        ? one("FinalizeRun", false, { terminalStatus: "cancelled" })
        : one("CancelCapabilityAction", true, {
            outstandingCommandId: state.outstandingCommand.commandId,
            actionId: state.currentAction?.normalizedAction?.actionId ?? null,
          });
    case "BudgetExceeded":
      return one("FinalizeRun", false, {
        terminalStatus: "failed",
        budget: event.payload.budget,
      });
    case "RecoveryCompleted":
      if (event.payload.disposition !== "recovered") {
        return one("FinalizeRun", false, {
          terminalStatus:
            event.payload.disposition === "orphaned" ? "orphaned" : "failed",
        });
      }
      if (state.recovery?.previousStatus === "paused" ||
          state.recovery?.previousStatus === "attempt_result_uncertain") {
        return none;
      }
      return state.recovery?.previousStatus === "cancellation_requested"
        ? one("FinalizeRun", false, { terminalStatus: "cancelled" })
        : one("AdvanceAgentDriver", true, {
            nextTurn: state.budget.turnsStarted + 1,
          });
    case "RunCreated":
    case "TaskProfilePinned":
    case "RunIntentAppended":
    case "RunPaused":
    case "RunCancelled":
    case "RunFailed":
    case "RunCompleted":
    case "RunOrphaned":
    case "AgentDriverStarted":
    case "AgentAttemptStarted":
    case "AgentContentCompleted":
    case "AgentUsageRecorded":
    case "AgentAttemptUncertain":
    case "ContextManifestRecorded":
    case "ContextRedacted":
    case "ActionNormalized":
    case "ActionDenied":
    case "ActionStarted":
    case "ActionSucceeded":
    case "ActionFailed":
    case "ActionReconciled":
    case "ApprovalRequested":
    case "ApprovalGranted":
    case "ApprovalDenied":
    case "ApprovalExpired":
    case "ApprovalInvalidated":
    case "ArtifactReferenced":
    case "RecoveryStarted":
      return none;
    default:
      return assertNever(event);
  }
}

function reconcileOutstandingCommand(
  previous: RunState,
  next: RunState,
  event: GenericEventEnvelope,
  commands: readonly RuntimeCommand[]
): RunState {
  let outstanding = CLEAR_OUTSTANDING_EVENTS.has(event.eventType)
    ? null
    : previous.outstandingCommand;
  const consequential = commands.filter(({ consequential }) => consequential);
  ensure(consequential.length <= 1, "One event planned multiple consequential commands.");
  const command = consequential[0];
  if (command !== undefined) {
    ensure(
      outstanding === null,
      "A second consequential command cannot start while one is outstanding."
    );
    outstanding = command;
  }
  return { ...next, outstandingCommand: outstanding };
}

function makeCommand(
  event: GenericEventEnvelope,
  commandType: RuntimeCommandType,
  consequential: boolean,
  payload: JsonObject
): RuntimeCommand {
  const commandId = CommandIdKind.parse(
    `cmd_${event.eventId.slice(EventIdPrefixLength)}`
  );
  return {
    schemaVersion: 1,
    commandId,
    commandType,
    streamId: event.streamId,
    causedByEventId: event.eventId,
    consequential,
    payload,
  };
}

const EventIdPrefixLength = "evt_".length;

function frameRegisteredEnvelope(
  value: unknown,
  framer: RegisteredEventEnvelopeFramer
): EventEnvelope<string, unknown> {
  try {
    const framedInput = parseEventEnvelope(value);
    const parseEnvelope = inspectFramer(framer);
    const parsed = parseEnvelope(framedInput);
    const framedOutput = parseEventEnvelope(parsed);
    if (
      !isDeeplyFrozenData(parsed) ||
      sharesObjectIdentity(framedInput, parsed) ||
      canonicalize(framedInput) !== canonicalize(framedOutput)
    ) {
      throw new TypeError("invalid registered framing result");
    }
    return framedOutput;
  } catch {
    throw invalidInput("The registered event framer rejected the event envelope.");
  }
}

function inspectFramer(
  value: unknown
): RegisteredEventEnvelopeFramer["parseEnvelope"] {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value)
  ) {
    throw new TypeError("invalid registered event framer");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "parseEnvelope");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function" ||
    isProxy(descriptor.value)
  ) {
    throw new TypeError("invalid registered event framer function");
  }
  return descriptor.value as RegisteredEventEnvelopeFramer["parseEnvelope"];
}

function isDeeplyFrozenData(value: unknown): boolean {
  try {
    const pending: unknown[] = [value];
    const visited = new WeakSet<object>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current !== "object" || current === null) continue;
      if (isProxy(current) || visited.has(current) || !Object.isFrozen(current)) {
        return false;
      }
      visited.add(current);
      for (const key of Reflect.ownKeys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          return false;
        }
        pending.push(descriptor.value);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function sharesObjectIdentity(left: unknown, right: unknown): boolean {
  try {
    const leftObjects = collectDataObjects(left);
    const pending: unknown[] = [right];
    const visited = new WeakSet<object>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current !== "object" || current === null) continue;
      if (isProxy(current) || leftObjects.has(current)) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const key of Reflect.ownKeys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError("non-data framing result");
        }
        pending.push(descriptor.value);
      }
    }
    return false;
  } catch {
    return true;
  }
}

function collectDataObjects(value: unknown): WeakSet<object> {
  const result = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) continue;
    if (isProxy(current) || result.has(current)) {
      throw new TypeError("hostile framed input");
    }
    result.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("non-data framed input");
      }
      pending.push(descriptor.value);
    }
  }
  return result;
}

function assertEventBoundary(state: RunState, event: GenericEventEnvelope): void {
  assertEventEnvelope(event);
  if (!isGenericEventType(event.eventType)) {
    throw invalidInput("The runtime does not recognize this generic event type.", {
      eventType: event.eventType,
    });
  }
  const legalStates = EVENT_LEGAL_STATES[event.eventType];
  if (!(legalStates as readonly RunProjectionStatus[]).includes(state.status)) {
    throw illegalTransition(
      `Event ${event.eventType} is not legal while the run is ${state.status}.`,
      { eventType: event.eventType, status: state.status }
    );
  }
  assertStreamCursorBoundary(state, event);
  if (
    event.eventType === "RecoveryCompleted" &&
    event.payload.disposition === "recovered"
  ) {
    assertRecoveryCanCompleteRecovered(state);
  }
  if (state.budgetExceeded !== null && WORK_STARTING_EVENTS.has(event.eventType)) {
    throw createDomainError({
      code: "budget_exceeded",
      message: "The run cannot start new work after budget exhaustion.",
      details: { budget: state.budgetExceeded.budget, eventType: event.eventType },
    });
  }
}

function assertInformationalExtensionBoundary(
  state: RunState,
  event: EventEnvelope<string, unknown>
): void {
  assertStreamCursorBoundary(state, event);
  if (state.status === "uninitialized" || TERMINAL_STATUS_SET.has(state.status)) {
    throw illegalTransition(
      "A registered informational event requires an active initialized run.",
      { status: state.status }
    );
  }
}

function assertStreamCursorBoundary(
  state: RunState,
  event: EventEnvelope<string, unknown>
): void {
  if (event.streamVersion !== state.streamVersion + 1) {
    throw illegalTransition("Run event versions must be consecutive.", {
      expectedVersion: state.streamVersion + 1,
      actualVersion: event.streamVersion,
    });
  }
  if (state.runId !== null && event.streamId !== state.runId) {
    throw illegalTransition("An event cannot switch aggregate streams.", {
      expectedRunId: state.runId,
      actualRunId: event.streamId,
    });
  }
  if (state.lastRecordedAt !== null && event.recordedAt < state.lastRecordedAt) {
    throw illegalTransition("Event record time cannot move backwards.", {
      previousRecordedAt: state.lastRecordedAt,
      recordedAt: event.recordedAt,
    });
  }
}

function assertIntentBoundary(intent: RunIntent): void {
  if (typeof intent !== "object" || intent === null) {
    throw invalidInput("A run intent must be an object.");
  }
  assertContractSchemaVersion(intent.schemaVersion, "run intent");
  if (typeof intent.intentType !== "string" ||
      !Object.hasOwn(INTENT_EVENT_TYPES, intent.intentType)) {
    throw invalidInput("Unknown run intent type.");
  }
  assertNewEvent(intent.event);
  if (!isGenericEventType(intent.event.eventType)) {
    throw invalidInput("A run intent must carry a generic event.");
  }
}

function validateIntentSemantics(state: RunState, intent: RunIntent): void {
  switch (intent.intentType) {
    case "create_run":
      ensureObject(intent.event.payload.objective, "RunCreated.objective");
      ensureNonEmpty(intent.event.payload.objective.profileId, "objective.profileId");
      return;
    case "pin_task_profile":
      ensure(state.objective !== null, "A profile requires a run objective.");
      ensure(
        intent.event.payload.taskProfile.profileId === state.objective.profileId &&
          intent.event.payload.taskProfile.profileVersion === state.objective.profileVersion,
        "The pinned profile must match the objective."
      );
      validateTaskProfileBudgets(intent.event.payload.taskProfile.budgetPolicy);
      return;
    case "start_run":
      ensure(state.taskProfile !== null, "Starting a run requires a pinned profile.");
      ensureTimestamp(intent.event.payload.startedAt, "RunStarted.startedAt");
      return;
    case "append_run_intent":
      ensureNonEmpty(intent.event.payload.intentType, "RunIntentAppended.intentType");
      ensurePositiveInteger(intent.event.payload.intentVersion, "intentVersion");
      return;
    case "pause_run":
      ensure(
        state.outstandingCommand === null && state.pendingApproval === null,
        "A run with outstanding work or approval cannot be paused."
      );
      return;
    case "resume_run":
      ensure(state.pausedFrom !== null, "Only a paused run can resume.");
      ensureTimestamp(intent.event.payload.resumedAt, "RunResumed.resumedAt");
      return;
    case "request_cancellation":
      ensureNullableString(
        intent.event.payload.reason,
        "CancellationRequested.reason"
      );
      return;
    case "cancel_run":
      ensure(state.runId !== null, "Cancelling requires an initialized run.");
      validateTerminalResult(intent.event.payload.result, state.runId, "cancelled");
      ensure(state.outstandingCommand === null, "Cancellation work has not settled.");
      return;
    case "fail_run":
      ensure(state.runId !== null, "Failing requires an initialized run.");
      validateTerminalResult(intent.event.payload.result, state.runId, "failed");
      ensure(state.outstandingCommand === null, "Consequential work has not settled.");
      return;
    case "complete_run":
      ensure(state.runId !== null, "Completion requires an initialized run.");
      validateTerminalResult(intent.event.payload.result, state.runId, "completed");
      ensure(state.validatedOutcome !== null, "Completion requires a validated outcome.");
      ensure(
        canonicalSha256Hex(intent.event.payload.result.outcome) ===
          canonicalSha256Hex(state.validatedOutcome),
        "Completion result differs from the validated outcome."
      );
      ensureQuiescent(state, "complete_run");
      return;
    case "orphan_run":
      ensure(state.runId !== null, "Orphaning requires an initialized run.");
      validateTerminalResult(intent.event.payload.result, state.runId, "orphaned");
      return;
    default:
      return assertNever(intent);
  }
}

function assertStateBoundary(state: RunState): void {
  try {
    if (typeof state !== "object" || state === null ||
        state.schemaVersion !== RUN_STATE_SCHEMA_VERSION ||
        !RUN_STATUS_SET.has(state.status)) {
      throw invalidInput("Unknown or malformed runtime state.");
    }
    assertStateInvariants(state);
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw invalidInput("Unknown or malformed runtime state.");
  }
}

function assertStateInvariants(state: RunState): void {
  ensure(Number.isSafeInteger(state.streamVersion) && state.streamVersion >= 0,
    "State stream version must be a non-negative safe integer.");
  if (state.status === "uninitialized") {
    ensure(
      state.runId === null && state.streamVersion === 0 && state.lastEventId === null,
      "Uninitialized state cannot contain stream history."
    );
  } else {
    ensure(
      state.runId !== null && RunIdKind.is(state.runId) && state.streamVersion > 0,
      "Initialized state requires a valid run id and history."
    );
  }
  ensure(
    (state.status === "waiting_for_approval") === (state.pendingApproval !== null),
    "Waiting-for-approval state must contain exactly one live approval."
  );
  if (state.pendingApproval !== null) {
    ensure(
      state.currentAction?.normalizedAction?.actionId === state.pendingApproval.actionId,
      "Pending approval must be bound to the current normalized action."
    );
  }
  if (state.outstandingCommand !== null) {
    ensure(state.outstandingCommand.consequential,
      "Only consequential commands belong in outstandingCommand.");
    ensure(
      state.runId === null || state.outstandingCommand.streamId === state.runId,
      "Outstanding command stream mismatch."
    );
  }
  if (state.status === "executing_action") {
    ensure(
      state.currentAction?.phase === "executing" &&
        state.outstandingCommand?.commandType === "ExecuteCapabilityAction",
      "Executing state requires exactly one executing action command."
    );
  }
  if (state.status === "recovering") {
    ensure(state.recovery !== null, "Recovering state requires recovery metadata.");
  }
  if (state.status === "paused") {
    ensure(state.pausedFrom !== null, "Paused state requires its resumable predecessor.");
  }
  if (TERMINAL_STATUS_SET.has(state.status)) {
    ensure(
      state.result !== null && state.outstandingCommand === null &&
        state.pendingApproval === null && state.currentContextRequest === null,
      "Terminal state must have a result and no live work."
    );
    ensure(state.result.status === state.status,
      "Terminal projection and result status must match.");
  } else {
    ensure(state.result === null, "A nonterminal state cannot carry a terminal result.");
  }
  for (const [name, value] of Object.entries(state.budget)) {
    ensure(
      Number.isSafeInteger(value) && value >= 0,
      `Budget counter ${name} must be a non-negative safe integer.`
    );
  }
  const maxTurns = state.taskProfile?.budgetPolicy.maxTurns ?? 0;
  const maxActions = state.taskProfile?.budgetPolicy.maxActions ?? 0;
  assertBoundedUniqueIdLedger(
    state.usedAgentAttemptIds,
    (value) => AgentAttemptIdKind.is(value),
    maxTurns,
    "agent attempt"
  );
  assertBoundedUniqueIdLedger(
    state.usedDriverProposalIds,
    (value) => DriverProposalIdKind.is(value),
    maxActions,
    "driver proposal"
  );
  assertBoundedUniqueIdLedger(
    state.usedActionIds,
    (value) => ActionIdKind.is(value),
    maxActions,
    "action"
  );
  assertBoundedUniqueIdLedger(
    state.usedApprovalIds,
    (value) => ApprovalIdKind.is(value),
    maxActions,
    "approval"
  );
  ensure(
    state.usedAgentAttemptIds.length === state.budget.turnsStarted,
    "Attempt identifier history must match the turn counter."
  );
  ensure(
    state.usedDriverProposalIds.length === state.budget.actionsProposed,
    "Proposal identifier history must match the proposed-action counter."
  );
  ensure(
    state.usedActionIds.length <= state.usedDriverProposalIds.length,
    "Action identifier history cannot exceed proposal history."
  );
  ensure(
    state.usedApprovalIds.length <= state.usedActionIds.length,
    "Approval identifier history cannot exceed action history."
  );
  if (state.currentAttempt !== null) {
    ensure(
      state.usedAgentAttemptIds.includes(state.currentAttempt.attemptId),
      "The current attempt must be present in attempt identifier history."
    );
  }
  if (state.currentAction !== null) {
    ensure(
      state.usedDriverProposalIds.includes(state.currentAction.proposalId),
      "The current action proposal must be present in proposal identifier history."
    );
    if (state.currentAction.normalizedAction !== null) {
      ensure(
        state.usedActionIds.includes(state.currentAction.normalizedAction.actionId),
        "The current normalized action must be present in action identifier history."
      );
    }
    assertExpectedObservationProjection(state.currentAction);
  }
  if (state.pendingApproval !== null) {
    ensure(
      state.usedApprovalIds.includes(state.pendingApproval.approvalId),
      "The pending approval must be present in approval identifier history."
    );
  }
  if (state.validatedOutcome !== null) {
    ensure(state.proposedOutcome !== null, "Validated outcome requires a proposal.");
  }
}

function terminalState(
  state: RunState,
  status: "completed" | "failed" | "cancelled" | "orphaned",
  result: RunResult
): RunState {
  return {
    ...state,
    status,
    result,
    currentAttempt: null,
    currentContextRequest: null,
    currentAction: null,
    pausedFrom: null,
    pendingApproval: null,
    outstandingCommand: null,
  };
}

function validateTerminalResult(
  result: RunResult,
  runId: string,
  status: RunResult["status"]
): void {
  ensureObject(result, "terminal result");
  assertContractSchemaVersion(result.schemaVersion, "run result");
  ensure(result.runId === runId, "Terminal result run id mismatch.");
  ensure(result.status === status, "Terminal result status mismatch.");
  ensureTimestamp(result.finishedAt, "result.finishedAt");
}

function ensureQuiescent(state: RunState, operation: string): void {
  ensure(
    state.outstandingCommand === null && state.pendingApproval === null &&
      state.currentContextRequest === null && state.currentAction === null,
    `${operation} requires a quiescent run.`
  );
}

function validateTaskProfileBudgets(value: {
  readonly maxTurns: number;
  readonly maxActions: number;
  readonly maxElapsedMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}): void {
  for (const [name, limit] of Object.entries(value)) {
    if (name === "extensions") continue;
    ensureNonNegativeSafeInteger(limit, `budgetPolicy.${name}`);
  }
}

function appendUniqueBoundedId<TId extends string>(
  used: readonly TId[],
  id: TId,
  limit: number | undefined,
  label: string
): readonly TId[] {
  ensure(limit !== undefined, `A ${label} requires a pinned budget.`);
  ensure(!used.includes(id), `A ${label} id cannot be reused within a run.`);
  ensure(
    used.length < limit,
    `The ${label} identifier history cannot exceed its run budget.`
  );
  return [...used, id];
}

function assertBoundedUniqueIdLedger(
  value: unknown,
  isExpectedId: (candidate: unknown) => boolean,
  limit: number,
  label: string
): asserts value is readonly string[] {
  ensure(Array.isArray(value), `The ${label} identifier history must be an array.`);
  ensure(
    value.every(isExpectedId),
    `The ${label} identifier history contains an invalid id.`
  );
  ensure(
    new Set(value).size === value.length,
    `The ${label} identifier history contains a reused id.`
  );
  ensure(
    value.length <= limit,
    `The ${label} identifier history exceeds its run budget.`
  );
}

function assertExpectedObservationProjection(
  current: CurrentActionProjection
): void {
  const expected = current.expectedObservation;
  if (current.phase === "result_recorded") {
    ensure(expected !== null, "A recorded action result requires an observation disposition.");
  } else if (current.phase !== "denied") {
    ensure(expected === null, "An unsettled action cannot expect an observation.");
  }
  if (expected === null) return;
  ensure(
    expected.status === "succeeded" || expected.status === "failed" ||
      expected.status === "uncertain" || expected.status === "denied",
    "The expected observation status is invalid."
  );
  switch (expected.error.kind) {
    case "none":
    case "unbound":
      return;
    case "same_error_id":
      ensure(isErrorId(expected.error.errorId), "Expected observation error id is invalid.");
      return;
    default:
      return assertNever(expected.error);
  }
}

function reconciliationObservationExpectation(
  disposition: "succeeded" | "failed" | "uncertain"
): ExpectedObservationProjection {
  return disposition === "succeeded"
    ? { status: "succeeded", error: { kind: "none" } }
    : { status: disposition, error: { kind: "unbound" } };
}

function assertObservationMatchesExpectation(
  expected: ExpectedObservationProjection | null,
  actualStatus: ExpectedObservationProjection["status"],
  actualError: DomainError | null
): void {
  ensure(expected !== null, "ObservationReleased requires a recorded disposition.");
  ensure(actualStatus === expected.status, "Observation status differs from the action result.");
  switch (expected.error.kind) {
    case "none":
      ensure(actualError === null, "A successful observation cannot contain an error.");
      return;
    case "same_error_id":
      ensure(
        actualError !== null && isDomainError(actualError) &&
          actualError.errorId === expected.error.errorId,
        "Observation error id differs from the action result."
      );
      return;
    case "unbound":
      return;
    default:
      return assertNever(expected.error);
  }
}

function assertRecoveryCanCompleteRecovered(state: RunState): void {
  ensure(state.outstandingCommand === null,
    "Recovery cannot complete as recovered while a command is outstanding.");
  ensure(state.currentContextRequest === null,
    "Recovery cannot complete as recovered while a context request is active.");
  ensure(state.currentAction === null,
    "Recovery cannot complete as recovered while an action is active.");
  ensure(
    state.currentAttempt === null ||
      (state.currentAttempt.status !== "active" &&
        state.currentAttempt.status !== "uncertain"),
    "Recovery cannot complete as recovered while an agent attempt is unresolved."
  );
}

function assertCurrentAttempt(state: RunState, attemptId: unknown): void {
  ensure(AgentAttemptIdKind.is(attemptId), "Invalid agent attempt id.");
  ensure(
    state.currentAttempt !== null && state.currentAttempt.attemptId === attemptId,
    "Agent attempt id does not match the current attempt."
  );
}

function assertContextRequest(state: RunState, requestId: unknown): void {
  ensureNonEmpty(requestId, "context request id");
  ensure(
    state.currentContextRequest?.requestId === requestId,
    "Context result does not match the active request."
  );
}

function assertExactlyOnePinnedCapability(
  state: RunState,
  capabilityPackId: string,
  capabilityPackVersion: number
): void {
  ensure(state.taskProfile !== null, "A capability requires a pinned task profile.");
  const exactMatches = state.taskProfile.capabilityPacks.filter(
    (binding) =>
      binding.componentId === capabilityPackId &&
      binding.componentVersion === capabilityPackVersion
  );
  ensure(
    exactMatches.length === 1,
    "A capability must resolve to exactly one pinned component id and version."
  );
}

function requireCurrentAction(state: RunState): CurrentActionProjection {
  ensure(state.currentAction !== null, "This event requires a current action.");
  return state.currentAction;
}

function requireNormalizedAction(state: RunState): CurrentActionProjection & {
  readonly normalizedAction: NonNullable<CurrentActionProjection["normalizedAction"]>;
} {
  const current = requireCurrentAction(state);
  ensure(current.normalizedAction !== null, "This event requires a normalized action.");
  return current as CurrentActionProjection & {
    readonly normalizedAction: NonNullable<CurrentActionProjection["normalizedAction"]>;
  };
}

function requireExecutingAction(
  state: RunState,
  actionId: unknown
): CurrentActionProjection {
  const current = requireNormalizedAction(state);
  assertCurrentActionId(current, actionId);
  ensure(current.phase === "executing", "The action is not executing.");
  return current;
}

function assertCurrentActionId(
  current: CurrentActionProjection,
  actionId: unknown
): void {
  ensure(ActionIdKind.is(actionId), "Invalid action id.");
  ensure(
    current.normalizedAction?.actionId === actionId,
    "Action id does not match the current action."
  );
}

function requirePendingApproval(state: RunState, approvalId: unknown) {
  ensure(ApprovalIdKind.is(approvalId), "Invalid approval id.");
  ensure(
    state.pendingApproval !== null && state.pendingApproval.approvalId === approvalId,
    "Approval id does not match the live approval."
  );
  return state.pendingApproval;
}

function rejectApproval(state: RunState): RunState {
  const current = requireNormalizedAction(state);
  return {
    ...state,
    status: "evaluating_action",
    pendingApproval: null,
    currentAction: { ...current, phase: "approval_rejected" },
  };
}

function passiveStatus(
  state: RunState,
  normal: "planning" | "recording_observation"
): RunLifecycleStatus {
  if (state.status === "cancellation_requested") return "cancellation_requested";
  if (state.status === "recovering") return "recovering";
  return normal;
}

function recoveredStatus(previous: RunLifecycleStatus): RunLifecycleStatus {
  if (previous === "cancellation_requested" || previous === "paused" ||
      previous === "attempt_result_uncertain") {
    return previous;
  }
  return "planning";
}

function incrementBudget(
  current: RunBudgetCounters,
  delta: Partial<Record<keyof RunBudgetCounters, number>>
): RunBudgetCounters {
  const add = (key: keyof RunBudgetCounters): number => {
    const value = delta[key] ?? 0;
    ensureNonNegativeSafeInteger(value, `budget delta ${key}`);
    return safeAdd(current[key], value, `budget ${key}`);
  };
  return {
    elapsedMs: add("elapsedMs"),
    turnsStarted: add("turnsStarted"),
    actionsProposed: add("actionsProposed"),
    actionsStarted: add("actionsStarted"),
    usageRecords: add("usageRecords"),
    inputBytes: add("inputBytes"),
    outputBytes: add("outputBytes"),
    inputTokens: add("inputTokens"),
    outputTokens: add("outputTokens"),
    estimatedCostMicros: add("estimatedCostMicros"),
    contextBytesReleased: add("contextBytesReleased"),
    agentContentBytes: add("agentContentBytes"),
    observationsReleased: add("observationsReleased"),
    policyDenials: add("policyDenials"),
    retriesScheduled: add("retriesScheduled"),
    artifactsReferenced: add("artifactsReferenced"),
  };
}

function elapsedMs(startedAt: string | null, recordedAt: string): number {
  if (startedAt === null) return 0;
  const elapsed = new Date(recordedAt).valueOf() - new Date(startedAt).valueOf();
  ensure(Number.isSafeInteger(elapsed) && elapsed >= 0,
    "Recorded time cannot precede run start time.");
  return elapsed;
}

function usageValue(usage: JsonObject, key: string): number {
  const value: JsonValue | undefined = usage[key];
  if (value === undefined) return 0;
  ensureNonNegativeSafeInteger(value, `usage.${key}`);
  return value;
}

function sumByteLengths(
  content: readonly { readonly byteLength: number }[],
  label: string
): number {
  let total = 0;
  for (const block of content) {
    ensureNonNegativeSafeInteger(block.byteLength, `${label} byteLength`);
    total = safeAdd(total, block.byteLength, `${label} bytes`);
  }
  return total;
}

function safeAdd(left: number, right: number, label: string): number {
  const sum = left + right;
  ensure(Number.isSafeInteger(sum) && sum >= 0, `${label} overflowed.`);
  return sum;
}

function ensureDomainError(value: unknown, label: string): void {
  ensure(isDomainError(value), `${label} must be a domain error.`);
}

function ensureObject(value: unknown, label: string): asserts value is object {
  ensure(typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object.`);
}

function ensureNonEmpty(value: unknown, label: string): asserts value is string {
  ensure(typeof value === "string" && value.trim().length > 0,
    `${label} must be a non-empty string.`);
}

function ensureNullableString(value: unknown, label: string): void {
  ensure(value === null || typeof value === "string",
    `${label} must be a string or null.`);
}

function ensureTimestamp(value: unknown, label: string): asserts value is string {
  ensure(typeof value === "string", `${label} must be an ISO timestamp.`);
  const parsed = new Date(value);
  ensure(!Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value,
    `${label} must be a canonical ISO timestamp.`);
}

function ensurePositiveInteger(value: unknown, label: string): asserts value is number {
  ensure(Number.isSafeInteger(value) && typeof value === "number" && value > 0,
    `${label} must be a positive safe integer.`);
}

function ensureNonNegativeSafeInteger(
  value: unknown,
  label: string
): asserts value is number {
  ensure(typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    `${label} must be a non-negative safe integer.`);
}

function ensureNonNegativeNumber(value: unknown, label: string): asserts value is number {
  ensure(typeof value === "number" && Number.isFinite(value) && value >= 0,
    `${label} must be a finite non-negative number.`);
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw illegalTransition(message);
  }
}

function illegalTransition(
  message: string,
  details?: Readonly<Record<string, unknown>>
): DomainError {
  return createDomainError({
    code: "invariant_violated",
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function invalidInput(
  message: string,
  details?: Readonly<Record<string, unknown>>
): DomainError {
  return createDomainError({
    code: "invalid_input",
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function immutable<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalize(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function assertNever(value: never): never {
  throw invalidInput("Unhandled generic event type.", {
    value: String(value),
  });
}
