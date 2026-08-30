import { ACTOR_KINDS, type ActorIdentity } from "./actor.js";
import type { ContentBlock } from "./content.js";
import { createDomainError, type DomainError } from "./errors.js";
import {
  ApprovalIdKind,
  EventIdKind,
  RunIdKind,
  type ActionId,
  type AgentAttemptId,
  type ApprovalId,
  type ArtifactId,
  type DriverProposalId,
  type EventId,
  type PolicyVersionId,
  type RunId,
} from "./ids.js";
import { isJsonObject, type JsonObject } from "./json-value.js";
import type { NormalizedAction } from "./action.js";
import type { ResourceRef } from "./resource.js";
import type {
  CancelledRunResult,
  CompletedRunResult,
  FailedRunResult,
  Observation,
  OutcomeEnvelope,
  OutcomeEvidenceRef,
} from "./result.js";
import {
  CONTRACT_SCHEMA_VERSION,
  isContractSchemaVersion,
  isPositiveVersion,
  type ContractSchemaVersion,
} from "./schema-version.js";
import type { ObjectiveEnvelope, TaskProfile } from "./task-profile.js";

export const GENERIC_EVENT_TYPES = [
  "RunCreated",
  "TaskProfilePinned",
  "RunStarted",
  "RunIntentAppended",
  "RunPaused",
  "RunResumed",
  "CancellationRequested",
  "RunCancelled",
  "RunFailed",
  "RunCompleted",
  "RunOrphaned",
  "AgentDriverStarted",
  "AgentAttemptStarted",
  "AgentContentCompleted",
  "AgentUsageRecorded",
  "AgentAttemptUncertain",
  "AgentAttemptFailed",
  "ContextRequested",
  "ContextReleased",
  "ContextDenied",
  "ContextRedacted",
  "ActionProposed",
  "ActionNormalized",
  "PolicyEvaluated",
  "ActionDenied",
  "ActionStarted",
  "ActionSucceeded",
  "ActionFailed",
  "ActionReconciled",
  "ObservationReleased",
  "ApprovalRequested",
  "ApprovalGranted",
  "ApprovalDenied",
  "ApprovalExpired",
  "ApprovalInvalidated",
  "ApprovalConsumed",
  "OutcomeProposed",
  "OutcomeValidated",
  "ArtifactReferenced",
  "RetryScheduled",
  "BudgetExceeded",
  "RecoveryStarted",
  "RecoveryCompleted",
] as const;

export type GenericEventType = (typeof GENERIC_EVENT_TYPES)[number];
const GENERIC_EVENT_TYPE_SET: ReadonlySet<string> = new Set(GENERIC_EVENT_TYPES);

export function isGenericEventType(value: unknown): value is GenericEventType {
  return typeof value === "string" && GENERIC_EVENT_TYPE_SET.has(value);
}

export type EventActor = ActorIdentity;

export interface NewEvent<TType extends string = string, TPayload = JsonObject> {
  readonly eventId: EventId;
  readonly eventType: TType;
  readonly eventSchemaVersion: ContractSchemaVersion;
  readonly occurredAt: string;
  readonly actor: EventActor;
  readonly correlationId: string;
  readonly causationId: EventId | null;
  readonly payload: TPayload;
}

export interface EventEnvelope<TType extends string = string, TPayload = JsonObject>
  extends NewEvent<TType, TPayload> {
  readonly streamId: RunId;
  readonly streamVersion: number;
  readonly recordedAt: string;
}

export interface GenericEventPayloadMap {
  readonly RunCreated: { readonly objective: ObjectiveEnvelope };
  readonly TaskProfilePinned: { readonly taskProfile: TaskProfile };
  readonly RunStarted: { readonly startedAt: string };
  readonly RunIntentAppended: {
    readonly intentType: string;
    readonly intentVersion: number;
    readonly payload: JsonObject;
    readonly submittedBy: ActorIdentity;
  };
  readonly RunPaused: { readonly reason: string | null };
  readonly RunResumed: { readonly resumedAt: string };
  readonly CancellationRequested: { readonly reason: string | null };
  readonly RunCancelled: { readonly result: CancelledRunResult };
  readonly RunFailed: { readonly result: FailedRunResult };
  readonly RunCompleted: { readonly result: CompletedRunResult };
  readonly RunOrphaned: { readonly result: FailedRunResult };
  readonly AgentDriverStarted: {
    readonly driverProfileId: string;
    readonly driverProfileVersion: number;
    readonly driverFingerprint: string;
  };
  readonly AgentAttemptStarted: {
    readonly attemptId: AgentAttemptId;
    readonly turn: number;
  };
  readonly AgentContentCompleted: {
    readonly attemptId: AgentAttemptId;
    readonly content: readonly ContentBlock[];
  };
  readonly AgentUsageRecorded: {
    readonly attemptId: AgentAttemptId;
    readonly usage: JsonObject;
  };
  readonly AgentAttemptUncertain: {
    readonly attemptId: AgentAttemptId;
    readonly error: DomainError;
  };
  readonly AgentAttemptFailed: {
    readonly attemptId: AgentAttemptId;
    readonly error: DomainError;
  };
  readonly ContextRequested: {
    readonly requestId: string;
    readonly resource: ResourceRef;
  };
  readonly ContextReleased: {
    readonly requestId: string;
    readonly resource: ResourceRef;
    readonly content: readonly ContentBlock[];
  };
  readonly ContextDenied: { readonly requestId: string; readonly error: DomainError };
  readonly ContextRedacted: {
    readonly requestId: string;
    readonly transformationIds: readonly string[];
  };
  readonly ActionProposed: {
    readonly proposalId: DriverProposalId;
    readonly capabilityPackId: string;
    readonly operationId: string;
    readonly operationVersion: number;
    readonly input: JsonObject;
  };
  readonly ActionNormalized: { readonly action: NormalizedAction };
  readonly PolicyEvaluated: {
    readonly actionId: ActionId;
    readonly policyVersionId: PolicyVersionId;
    readonly decision: "allow" | "deny" | "require_approval";
    readonly trace: JsonObject;
  };
  readonly ActionDenied: { readonly actionId: ActionId; readonly error: DomainError };
  readonly ActionStarted: { readonly actionId: ActionId; readonly startedAt: string };
  readonly ActionSucceeded: { readonly actionId: ActionId; readonly completedAt: string };
  readonly ActionFailed: { readonly actionId: ActionId; readonly error: DomainError };
  readonly ActionReconciled: {
    readonly actionId: ActionId;
    readonly disposition: "absent" | "succeeded" | "failed" | "uncertain";
    readonly evidence: JsonObject;
  };
  readonly ObservationReleased: { readonly observation: Observation };
  readonly ApprovalRequested: {
    readonly approvalId: ApprovalId;
    readonly actionId: ActionId;
    readonly preconditionHash: string;
  };
  readonly ApprovalGranted: { readonly approvalId: ApprovalId; readonly grantedBy: ActorIdentity };
  readonly ApprovalDenied: { readonly approvalId: ApprovalId; readonly deniedBy: ActorIdentity };
  readonly ApprovalExpired: { readonly approvalId: ApprovalId };
  readonly ApprovalInvalidated: { readonly approvalId: ApprovalId; readonly reason: string };
  readonly ApprovalConsumed: { readonly approvalId: ApprovalId; readonly actionId: ActionId };
  readonly OutcomeProposed: { readonly outcome: OutcomeEnvelope };
  readonly OutcomeValidated: {
    readonly outcomeId: string;
    readonly evidence: readonly OutcomeEvidenceRef[];
    readonly validatedAt: string;
  };
  readonly ArtifactReferenced: {
    readonly artifactId: ArtifactId;
    readonly contentHash: string;
    readonly mediaType: string;
  };
  readonly RetryScheduled: {
    readonly attemptType: string;
    readonly ordinal: number;
    readonly scheduledAt: string;
  };
  readonly BudgetExceeded: { readonly budget: string; readonly consumed: number; readonly limit: number };
  readonly RecoveryStarted: { readonly recoveryId: string; readonly startedAt: string };
  readonly RecoveryCompleted: {
    readonly recoveryId: string;
    readonly disposition: "recovered" | "orphaned" | "failed";
  };
}

export type GenericEvent = {
  readonly [TType in GenericEventType]: NewEvent<
    TType,
    GenericEventPayloadMap[TType]
  >;
}[GenericEventType];

export type GenericEventEnvelope = {
  readonly [TType in GenericEventType]: EventEnvelope<
    TType,
    GenericEventPayloadMap[TType]
  >;
}[GenericEventType];

const NEW_EVENT_KEYS = new Set([
  "eventId",
  "eventType",
  "eventSchemaVersion",
  "occurredAt",
  "actor",
  "correlationId",
  "causationId",
  "payload",
]);
const ENVELOPE_KEYS = new Set([
  ...NEW_EVENT_KEYS,
  "streamId",
  "streamVersion",
  "recordedAt",
]);
const ACTOR_KIND_SET: ReadonlySet<string> = new Set(ACTOR_KINDS);

export function isNewEvent(value: unknown): value is NewEvent {
  return validateEventRecord(value, false);
}

export function assertNewEvent(value: unknown): asserts value is NewEvent {
  if (!isNewEvent(value)) {
    throw invalidEvent("new event");
  }
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  return validateEventRecord(value, true);
}

export function assertEventEnvelope(value: unknown): asserts value is EventEnvelope {
  if (!isEventEnvelope(value)) {
    throw invalidEvent("event envelope");
  }
}

function validateEventRecord(value: unknown, envelope: boolean): boolean {
  try {
    if (!isPlainRecord(value) || !hasExactDataKeys(value, envelope ? ENVELOPE_KEYS : NEW_EVENT_KEYS)) {
      return false;
    }
    if (
      !EventIdKind.is(value["eventId"]) ||
      typeof value["eventType"] !== "string" ||
      value["eventType"].trim().length === 0 ||
      !isContractSchemaVersion(value["eventSchemaVersion"]) ||
      !isTimestamp(value["occurredAt"]) ||
      !isActor(value["actor"]) ||
      typeof value["correlationId"] !== "string" ||
      value["correlationId"].trim().length === 0 ||
      !(value["causationId"] === null || EventIdKind.is(value["causationId"])) ||
      !isJsonObject(value["payload"])
    ) {
      return false;
    }
    return !envelope || (
      RunIdKind.is(value["streamId"]) &&
      isPositiveVersion(value["streamVersion"]) &&
      isTimestamp(value["recordedAt"])
    );
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size) {
    return false;
  }
  return keys.every((key) => {
    if (typeof key !== "string" || !expected.has(key)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.enumerable === true
    );
  });
}

function isActor(value: unknown): value is EventActor {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, new Set(["kind", "id"])) &&
    typeof value["kind"] === "string" &&
    ACTOR_KIND_SET.has(value["kind"]) &&
    typeof value["id"] === "string" &&
    value["id"].trim().length > 0
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const instant = new Date(value);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value;
}

function invalidEvent(name: string): DomainError {
  return createDomainError({
    code: "invalid_input",
    message: `Invalid ${name}; expected schema version ${CONTRACT_SCHEMA_VERSION}.`,
  });
}

// Compile-time coverage: every canonical name has a payload and vice versa.
const _genericEventPayloadCoverage: Readonly<Record<GenericEventType, true>> =
  Object.freeze(
    Object.fromEntries(GENERIC_EVENT_TYPES.map((eventType) => [eventType, true]))
  ) as Readonly<Record<GenericEventType, true>>;
void _genericEventPayloadCoverage;
void ApprovalIdKind;
