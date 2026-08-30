import type { GenericEventType } from "@guard/contracts";

import type {
  RunIntentType,
  RunProjectionStatus,
} from "./types.js";

const ACTIVE: readonly RunProjectionStatus[] = [
  "created",
  "planning",
  "waiting_for_agent",
  "attempt_result_uncertain",
  "evaluating_action",
  "waiting_for_approval",
  "executing_action",
  "recording_observation",
  "cancellation_requested",
  "recovering",
  "paused",
];

/**
 * A failed terminal result may be committed only after consequential work has
 * settled. `waiting_for_agent` necessarily owns an Advance/Fetch command and
 * `executing_action` necessarily owns ExecuteCapabilityAction, so those two
 * states must first record AgentAttemptFailed or ActionFailed/Observation.
 */
const FAILABLE: readonly RunProjectionStatus[] = ACTIVE.filter(
  (status) => status !== "waiting_for_agent" && status !== "executing_action"
);

const CANCELLABLE: readonly RunProjectionStatus[] = ACTIVE.filter(
  (status) => status !== "cancellation_requested"
);

const ARTIFACT_STATES: readonly RunProjectionStatus[] = ACTIVE;

/**
 * Authoritative state/event matrix. Semantic guards further narrow transitions
 * that depend on action identity, outstanding work, approval state, or budget.
 */
export const EVENT_LEGAL_STATES = Object.freeze({
  RunCreated: Object.freeze(["uninitialized"]),
  TaskProfilePinned: Object.freeze(["created"]),
  RunStarted: Object.freeze(["created"]),
  RunIntentAppended: Object.freeze([
    "created",
    "planning",
    "waiting_for_agent",
    "attempt_result_uncertain",
    "evaluating_action",
    "waiting_for_approval",
    "recording_observation",
    "paused",
  ]),
  RunPaused: Object.freeze(["created", "planning", "attempt_result_uncertain"]),
  RunResumed: Object.freeze(["paused"]),
  CancellationRequested: Object.freeze(CANCELLABLE),
  RunCancelled: Object.freeze(["cancellation_requested"]),
  RunFailed: Object.freeze(FAILABLE),
  RunCompleted: Object.freeze(["planning"]),
  RunOrphaned: Object.freeze([
    "recovering",
    "attempt_result_uncertain",
    "executing_action",
    "cancellation_requested",
  ]),
  AgentDriverStarted: Object.freeze(["planning"]),
  AgentAttemptStarted: Object.freeze(["planning"]),
  AgentContentCompleted: Object.freeze([
    "waiting_for_agent",
    "cancellation_requested",
  ]),
  AgentUsageRecorded: Object.freeze([
    "waiting_for_agent",
    "planning",
    "evaluating_action",
    "attempt_result_uncertain",
    "cancellation_requested",
    "recovering",
  ]),
  AgentAttemptUncertain: Object.freeze([
    "waiting_for_agent",
    "cancellation_requested",
    "recovering",
  ]),
  AgentAttemptFailed: Object.freeze([
    "waiting_for_agent",
    "cancellation_requested",
    "recovering",
  ]),
  ContextRequested: Object.freeze(["waiting_for_agent"]),
  ContextReleased: Object.freeze([
    "waiting_for_agent",
    "cancellation_requested",
    "recovering",
  ]),
  ContextDenied: Object.freeze([
    "waiting_for_agent",
    "cancellation_requested",
    "recovering",
  ]),
  ContextRedacted: Object.freeze(["waiting_for_agent"]),
  ActionProposed: Object.freeze(["waiting_for_agent"]),
  ActionNormalized: Object.freeze(["evaluating_action"]),
  PolicyEvaluated: Object.freeze(["evaluating_action"]),
  ActionDenied: Object.freeze([
    "evaluating_action",
    "cancellation_requested",
  ]),
  ActionStarted: Object.freeze(["evaluating_action"]),
  ActionSucceeded: Object.freeze([
    "executing_action",
    "cancellation_requested",
    "recovering",
  ]),
  ActionFailed: Object.freeze([
    "executing_action",
    "cancellation_requested",
    "recovering",
  ]),
  ActionReconciled: Object.freeze([
    "executing_action",
    "cancellation_requested",
    "recovering",
  ]),
  ObservationReleased: Object.freeze([
    "recording_observation",
    "cancellation_requested",
    "recovering",
  ]),
  ApprovalRequested: Object.freeze(["evaluating_action"]),
  ApprovalGranted: Object.freeze(["waiting_for_approval"]),
  ApprovalDenied: Object.freeze(["waiting_for_approval"]),
  ApprovalExpired: Object.freeze(["waiting_for_approval"]),
  ApprovalInvalidated: Object.freeze(["waiting_for_approval"]),
  ApprovalConsumed: Object.freeze(["waiting_for_approval"]),
  OutcomeProposed: Object.freeze(["waiting_for_agent", "planning"]),
  OutcomeValidated: Object.freeze(["planning"]),
  ArtifactReferenced: Object.freeze(ARTIFACT_STATES),
  RetryScheduled: Object.freeze([
    "planning",
    "attempt_result_uncertain",
    "recovering",
  ]),
  BudgetExceeded: Object.freeze([
    "created",
    "planning",
    "waiting_for_agent",
    "attempt_result_uncertain",
    "evaluating_action",
    "waiting_for_approval",
    "executing_action",
    "recording_observation",
    "recovering",
    "paused",
  ]),
  RecoveryStarted: Object.freeze([
    "planning",
    "waiting_for_agent",
    "attempt_result_uncertain",
    "evaluating_action",
    "waiting_for_approval",
    "executing_action",
    "recording_observation",
    "cancellation_requested",
    "paused",
  ]),
  RecoveryCompleted: Object.freeze(["recovering"]),
} satisfies Readonly<
  Record<GenericEventType, readonly RunProjectionStatus[]>
>);

export const INTENT_LEGAL_STATES = Object.freeze({
  create_run: Object.freeze(["uninitialized"]),
  pin_task_profile: Object.freeze(["created"]),
  start_run: Object.freeze(["created"]),
  append_run_intent: EVENT_LEGAL_STATES.RunIntentAppended,
  pause_run: EVENT_LEGAL_STATES.RunPaused,
  resume_run: EVENT_LEGAL_STATES.RunResumed,
  request_cancellation: EVENT_LEGAL_STATES.CancellationRequested,
  cancel_run: EVENT_LEGAL_STATES.RunCancelled,
  fail_run: EVENT_LEGAL_STATES.RunFailed,
  complete_run: EVENT_LEGAL_STATES.RunCompleted,
  orphan_run: EVENT_LEGAL_STATES.RunOrphaned,
} satisfies Readonly<Record<RunIntentType, readonly RunProjectionStatus[]>>);
