import type {
  ActionId,
  AgentAttemptId,
  ApprovalId,
  CommandId,
  ContractSchemaVersion,
  DriverProposalId,
  EventId,
  GenericEvent,
  GenericEventType,
  JsonObject,
  NormalizedAction,
  ObjectiveEnvelope,
  OutcomeEnvelope,
  PolicyVersionId,
  RunId,
  RunResult,
  TaskProfile,
} from "@guard/contracts";

export const RUN_STATE_SCHEMA_VERSION = 1 as const;

export const RUN_LIFECYCLE_STATUSES = [
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
  "completed",
  "failed",
  "cancelled",
  "orphaned",
] as const;

export type RunLifecycleStatus = (typeof RUN_LIFECYCLE_STATUSES)[number];
export type RunProjectionStatus = "uninitialized" | RunLifecycleStatus;

export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "orphaned",
] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export interface RunBudgetCounters {
  readonly elapsedMs: number;
  readonly turnsStarted: number;
  readonly actionsProposed: number;
  readonly actionsStarted: number;
  readonly usageRecords: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostMicros: number;
  readonly contextBytesReleased: number;
  readonly agentContentBytes: number;
  readonly observationsReleased: number;
  readonly policyDenials: number;
  readonly retriesScheduled: number;
  readonly artifactsReferenced: number;
}

export interface DriverProjection {
  readonly driverProfileId: string;
  readonly driverProfileVersion: number;
  readonly driverFingerprint: string;
}

export type AgentAttemptStatus = "active" | "completed" | "uncertain" | "failed";

export interface AgentAttemptProjection {
  readonly attemptId: AgentAttemptId;
  readonly turn: number;
  readonly status: AgentAttemptStatus;
}

export type ActionPhase =
  | "proposed"
  | "normalized"
  | "allowed"
  | "approval_required"
  | "approved"
  | "approval_rejected"
  | "denied"
  | "executing"
  | "result_recorded";

export interface PolicyEvaluationProjection {
  readonly policyVersionId: PolicyVersionId;
  readonly decision: "allow" | "deny" | "require_approval";
  readonly trace: JsonObject;
}

export interface CurrentActionProjection {
  readonly proposalId: DriverProposalId;
  readonly capabilityPackId: string;
  /** Exact pinned version resolved before normalization and rechecked after it. */
  readonly capabilityPackVersion: number;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly input: JsonObject;
  readonly normalizedAction: NormalizedAction | null;
  readonly policyEvaluation: PolicyEvaluationProjection | null;
  readonly phase: ActionPhase;
}

export interface PendingApprovalProjection {
  readonly approvalId: ApprovalId;
  readonly actionId: ActionId;
  readonly preconditionHash: string;
  readonly status: "requested" | "granted";
}

export interface ContextRequestProjection {
  readonly requestId: string;
}

export interface CancellationProjection {
  readonly reason: string | null;
  readonly requestedByEventId: EventId;
}

export interface RecoveryProjection {
  readonly recoveryId: string;
  readonly previousStatus: RunLifecycleStatus;
  readonly disposition: "pending" | "recovered" | "orphaned" | "failed";
}

export interface BudgetExceededProjection {
  readonly budget: string;
  readonly consumed: number;
  readonly limit: number;
}

export interface ArtifactReferenceProjection {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly mediaType: string;
}

export const RUNTIME_COMMAND_TYPES = [
  "AdvanceAgentDriver",
  "FetchContextResource",
  "EvaluateCapabilityAction",
  "CreateApprovalRequest",
  "ExecuteCapabilityAction",
  "CancelCapabilityAction",
  "ValidateOutcome",
  "FinalizeRun",
] as const;

export type RuntimeCommandType = (typeof RUNTIME_COMMAND_TYPES)[number];

export interface RuntimeCommand {
  readonly schemaVersion: ContractSchemaVersion;
  readonly commandId: CommandId;
  readonly commandType: RuntimeCommandType;
  readonly streamId: RunId;
  readonly causedByEventId: EventId;
  readonly consequential: boolean;
  readonly payload: JsonObject;
}

export interface RunState {
  readonly schemaVersion: typeof RUN_STATE_SCHEMA_VERSION;
  readonly status: RunProjectionStatus;
  readonly runId: RunId | null;
  readonly streamVersion: number;
  readonly lastEventId: EventId | null;
  readonly lastRecordedAt: string | null;
  readonly objective: ObjectiveEnvelope | null;
  readonly taskProfile: TaskProfile | null;
  readonly startedAt: string | null;
  readonly pausedFrom: "created" | "planning" | "attempt_result_uncertain" | null;
  readonly driver: DriverProjection | null;
  readonly currentAttempt: AgentAttemptProjection | null;
  readonly currentContextRequest: ContextRequestProjection | null;
  readonly currentAction: CurrentActionProjection | null;
  readonly pendingApproval: PendingApprovalProjection | null;
  readonly proposedOutcome: OutcomeEnvelope | null;
  readonly validatedOutcome: OutcomeEnvelope | null;
  readonly result: RunResult | null;
  readonly outstandingCommand: RuntimeCommand | null;
  readonly cancellation: CancellationProjection | null;
  readonly recovery: RecoveryProjection | null;
  readonly budgetExceeded: BudgetExceededProjection | null;
  readonly budget: RunBudgetCounters;
  readonly appendedIntentCount: number;
  readonly artifacts: readonly ArtifactReferenceProjection[];
}

type EventOf<TType extends GenericEventType> = Extract<
  GenericEvent,
  { readonly eventType: TType }
>;

interface RunIntentBase<TIntentType extends string, TEvent extends GenericEvent> {
  readonly schemaVersion: ContractSchemaVersion;
  readonly intentType: TIntentType;
  readonly event: TEvent;
}

export type RunIntent =
  | RunIntentBase<"create_run", EventOf<"RunCreated">>
  | RunIntentBase<"pin_task_profile", EventOf<"TaskProfilePinned">>
  | RunIntentBase<"start_run", EventOf<"RunStarted">>
  | RunIntentBase<"append_run_intent", EventOf<"RunIntentAppended">>
  | RunIntentBase<"pause_run", EventOf<"RunPaused">>
  | RunIntentBase<"resume_run", EventOf<"RunResumed">>
  | RunIntentBase<"request_cancellation", EventOf<"CancellationRequested">>
  | RunIntentBase<"cancel_run", EventOf<"RunCancelled">>
  | RunIntentBase<"fail_run", EventOf<"RunFailed">>
  | RunIntentBase<"complete_run", EventOf<"RunCompleted">>
  | RunIntentBase<"orphan_run", EventOf<"RunOrphaned">>;

export type RunIntentType = RunIntent["intentType"];
