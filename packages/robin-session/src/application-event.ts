import {
  ActionIdKind,
  ApprovalIdKind,
  ERROR_CODES,
  PolicyVersionIdKind,
  canonicalBytes,
  canonicalSha256Hex,
  canonicalize,
  snapshotBoundaryJsonObject,
  type ActionId,
  type ApprovalId,
  type ErrorCode,
  type JsonObject,
  type JsonValue,
  type PolicyVersionId,
} from "@guard/contracts";

export const ROBIN_APPLICATION_EVENT_SCHEMA_VERSION = 1 as const;
export const MAXIMUM_APPLICATION_EVENT_UTF8_BYTES = 524_288;
export const MAXIMUM_APPLICATION_TEXT_UTF8_BYTES = 262_144;
export const MAXIMUM_APPLICATION_IDENTIFIER_UTF8_BYTES = 256;
export const MAXIMUM_APPROVAL_DISPLAY_SUMMARY_UTF8_BYTES = 65_536;
export const UNSAFE_TERMINAL_TEXT_POLICY = "escape" as const;

export type RobinApplicationEventType =
  | "SessionStarted"
  | "PermissionModeChanged"
  | "UserMessageQueued"
  | "UserMessageAccepted"
  | "TurnStarted"
  | "AssistantTextDelta"
  | "ToolCallStarted"
  | "PermissionDecided"
  | "ApprovalRequested"
  | "ApprovalResolved"
  | "ApprovalInvalidated"
  | "ToolCallCompleted"
  | "ToolCallFailed"
  | "UsageReported"
  | "BudgetWarning"
  | "BudgetExhausted"
  | "TurnCancellationRequested"
  | "TurnCancelled"
  | "TurnFailed"
  | "TurnCompleted"
  | "SessionClosed";

export const ROBIN_APPLICATION_EVENT_TYPES: readonly RobinApplicationEventType[] = Object.freeze([
  "SessionStarted",
  "PermissionModeChanged",
  "UserMessageQueued",
  "UserMessageAccepted",
  "TurnStarted",
  "AssistantTextDelta",
  "ToolCallStarted",
  "PermissionDecided",
  "ApprovalRequested",
  "ApprovalResolved",
  "ApprovalInvalidated",
  "ToolCallCompleted",
  "ToolCallFailed",
  "UsageReported",
  "BudgetWarning",
  "BudgetExhausted",
  "TurnCancellationRequested",
  "TurnCancelled",
  "TurnFailed",
  "TurnCompleted",
  "SessionClosed",
]);
export type RobinApplicationEventSchemaVersion =
  typeof ROBIN_APPLICATION_EVENT_SCHEMA_VERSION;
export type RobinPermissionMode = "ask" | "plan";
export type RobinPermissionEffect = "allow" | "deny" | "require_approval";
export type RobinApprovalDecision = "allow_once" | "deny";
export type RobinApprovalOutcome = "granted" | "denied" | "stale";
export type RobinApprovalInvalidationReason =
  | "approval_expired"
  | "preconditions_changed";
export type RobinBudgetDimension =
  | "turns"
  | "model_requests"
  | "tool_calls"
  | "input_tokens"
  | "output_tokens"
  | "output_bytes"
  | "wall_time_ms";

export interface RobinApprovalBinding {
  readonly actionHash: string;
  readonly actionId: ActionId;
  readonly approvalId: ApprovalId;
  readonly callId: string;
  readonly displayedSummaryHash: string;
  readonly expiresAt: string;
  readonly normalizedRequestHash: string;
  readonly policySnapshotHash: string;
  readonly preconditionHash: string;
  readonly requestedAt: string;
  readonly toolName: string;
  readonly turnId: string;
}

export interface RobinApprovalRequestedPayload extends RobinApprovalBinding {
  readonly displayedSummary: JsonObject;
}

export interface RobinApprovalResolvedPayload extends RobinApprovalBinding {
  readonly decision: RobinApprovalDecision;
  readonly outcome: RobinApprovalOutcome;
  readonly resolvedAt: string;
}

export interface RobinApprovalInvalidatedPayload extends RobinApprovalBinding {
  readonly invalidatedAt: string;
  readonly observedPreconditionHash: string | null;
  readonly reason: RobinApprovalInvalidationReason;
}

export interface RobinPermissionDecidedPayload {
  readonly actionHash: string;
  readonly actionId: ActionId;
  readonly callId: string;
  readonly effect: RobinPermissionEffect;
  readonly policySnapshotHash: string;
  readonly policyVersionId: PolicyVersionId;
  readonly toolName: string;
  readonly turnId: string;
  readonly winningPolicyName: string | null;
}

export interface RobinApplicationEventPayloadMap {
  readonly SessionStarted: {
    readonly permissionMode: RobinPermissionMode;
    readonly persistence: "ephemeral";
    readonly providerProfile: "synthetic";
  };
  readonly PermissionModeChanged: {
    readonly permissionMode: RobinPermissionMode;
  };
  readonly UserMessageQueued: {
    readonly messageId: string;
    readonly position: number;
    readonly text: string;
    readonly turnId: string;
  };
  readonly UserMessageAccepted: {
    readonly messageId: string;
    readonly text: string;
    readonly turnId: string;
  };
  readonly TurnStarted: {
    readonly messageId: string;
    readonly turnId: string;
  };
  readonly AssistantTextDelta: {
    readonly text: string;
    readonly turnId: string;
  };
  readonly ToolCallStarted: {
    readonly callId: string;
    readonly toolName: string;
    readonly turnId: string;
  };
  readonly PermissionDecided: RobinPermissionDecidedPayload;
  readonly ApprovalRequested: RobinApprovalRequestedPayload;
  readonly ApprovalResolved: RobinApprovalResolvedPayload;
  readonly ApprovalInvalidated: RobinApprovalInvalidatedPayload;
  readonly ToolCallCompleted: {
    readonly callId: string;
    readonly observation: JsonObject;
    readonly toolName: string;
    readonly turnId: string;
  };
  readonly ToolCallFailed: {
    readonly callId: string;
    readonly code: ErrorCode;
    readonly message: string;
    readonly toolName: string;
    readonly turnId: string;
  };
  readonly UsageReported: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly turnId: string;
  };
  readonly BudgetWarning: {
    readonly dimension: RobinBudgetDimension;
    readonly limit: number;
    readonly turnId: string;
    readonly used: number;
  };
  readonly BudgetExhausted: {
    readonly dimension: RobinBudgetDimension;
    readonly limit: number;
    readonly turnId: string;
    readonly used: number;
  };
  readonly TurnCancellationRequested: {
    readonly reason: string;
    readonly turnId: string;
  };
  readonly TurnCancelled: {
    readonly reason: string;
    readonly turnId: string;
  };
  readonly TurnFailed: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly turnId: string;
  };
  readonly TurnCompleted: {
    readonly text: string;
    readonly turnId: string;
  };
  readonly SessionClosed: {
    readonly reason: "user" | "eof" | "shutdown" | "error";
  };
}

interface RobinApplicationEventBase<TType extends RobinApplicationEventType> {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly payload: RobinApplicationEventPayloadMap[TType];
  readonly schemaVersion: RobinApplicationEventSchemaVersion;
  readonly sequence: number;
  readonly sessionId: string;
  readonly type: TType;
}

export type RobinApplicationEvent =
  | RobinApplicationEventBase<"SessionStarted">
  | RobinApplicationEventBase<"PermissionModeChanged">
  | RobinApplicationEventBase<"UserMessageQueued">
  | RobinApplicationEventBase<"UserMessageAccepted">
  | RobinApplicationEventBase<"TurnStarted">
  | RobinApplicationEventBase<"AssistantTextDelta">
  | RobinApplicationEventBase<"ToolCallStarted">
  | RobinApplicationEventBase<"PermissionDecided">
  | RobinApplicationEventBase<"ApprovalRequested">
  | RobinApplicationEventBase<"ApprovalResolved">
  | RobinApplicationEventBase<"ApprovalInvalidated">
  | RobinApplicationEventBase<"ToolCallCompleted">
  | RobinApplicationEventBase<"ToolCallFailed">
  | RobinApplicationEventBase<"UsageReported">
  | RobinApplicationEventBase<"BudgetWarning">
  | RobinApplicationEventBase<"BudgetExhausted">
  | RobinApplicationEventBase<"TurnCancellationRequested">
  | RobinApplicationEventBase<"TurnCancelled">
  | RobinApplicationEventBase<"TurnFailed">
  | RobinApplicationEventBase<"TurnCompleted">
  | RobinApplicationEventBase<"SessionClosed">;

export type RobinTurnApplicationEvent =
  | RobinApplicationEventBase<"UserMessageQueued">
  | RobinApplicationEventBase<"UserMessageAccepted">
  | RobinApplicationEventBase<"TurnStarted">
  | RobinApplicationEventBase<"AssistantTextDelta">
  | RobinApplicationEventBase<"ToolCallStarted">
  | RobinApplicationEventBase<"PermissionDecided">
  | RobinApplicationEventBase<"ApprovalRequested">
  | RobinApplicationEventBase<"ApprovalResolved">
  | RobinApplicationEventBase<"ApprovalInvalidated">
  | RobinApplicationEventBase<"ToolCallCompleted">
  | RobinApplicationEventBase<"ToolCallFailed">
  | RobinApplicationEventBase<"UsageReported">
  | RobinApplicationEventBase<"BudgetWarning">
  | RobinApplicationEventBase<"BudgetExhausted">
  | RobinApplicationEventBase<"TurnCancellationRequested">
  | RobinApplicationEventBase<"TurnCancelled">
  | RobinApplicationEventBase<"TurnFailed">
  | RobinApplicationEventBase<"TurnCompleted">;

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  ROBIN_APPLICATION_EVENT_TYPES,
);
const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);
const APPROVAL_DECISION_SET: ReadonlySet<string> = new Set([
  "allow_once",
  "deny",
]);
const APPROVAL_OUTCOME_SET: ReadonlySet<string> = new Set([
  "granted",
  "denied",
  "stale",
]);
const APPROVAL_INVALIDATION_REASON_SET: ReadonlySet<string> = new Set([
  "approval_expired",
  "preconditions_changed",
]);
const PERMISSION_EFFECT_SET: ReadonlySet<string> = new Set([
  "allow",
  "deny",
  "require_approval",
]);
const PERMISSION_MODE_SET: ReadonlySet<string> = new Set(["ask", "plan"]);
const BUDGET_DIMENSION_SET: ReadonlySet<string> = new Set([
  "turns",
  "model_requests",
  "tool_calls",
  "input_tokens",
  "output_tokens",
  "output_bytes",
  "wall_time_ms",
]);
const SESSION_CLOSE_REASON_SET: ReadonlySet<string> = new Set([
  "user",
  "eof",
  "shutdown",
  "error",
]);
const EVENT_KEYS = new Set([
  "eventId",
  "occurredAt",
  "payload",
  "schemaVersion",
  "sequence",
  "sessionId",
  "type",
]);
const SNAPSHOT_LIMITS = Object.freeze({
  maximumArrayLength: 128,
  maximumCanonicalUtf8Bytes: MAXIMUM_APPLICATION_EVENT_UTF8_BYTES,
  maximumDepth: 16,
  maximumNodes: 4_096,
  maximumObjectProperties: 128,
  maximumStringUtf8Bytes: MAXIMUM_APPLICATION_TEXT_UTF8_BYTES,
});

export type RobinSessionErrorCode =
  | "invalid_event"
  | "illegal_transition"
  | "sequence_conflict"
  | "budget_invalid";

/** A stable, input-independent failure for deterministic parser/reducer tests. */
export class RobinSessionError extends Error {
  public readonly code: RobinSessionErrorCode;

  public constructor(code: RobinSessionErrorCode, message: string) {
    super(message);
    this.name = "RobinSessionError";
    this.code = code;
    Object.freeze(this);
  }
}

/**
 * Parses one detached immutable event. Boundary data is copied by descriptor,
 * bounded before semantic reads, and every text-bearing field is made terminal
 * inert by escaping C0/C1, DEL, line-separator, and surrogate code points.
 */
export function parseRobinApplicationEvent(
  value: unknown,
): RobinApplicationEvent {
  try {
    const event = snapshotBoundaryJsonObject(value, SNAPSHOT_LIMITS);
    requireExactKeys(event, EVENT_KEYS);
    if (event["schemaVersion"] !== ROBIN_APPLICATION_EVENT_SCHEMA_VERSION) {
      invalidEvent();
    }
    const type = requiredString(event, "type", 64, false);
    if (!EVENT_TYPE_SET.has(type)) invalidEvent();
    const sequence = requiredPositiveInteger(event, "sequence");
    const sessionId = requiredIdentifier(event, "sessionId");
    const eventId = requiredIdentifier(event, "eventId");
    const occurredAt = requiredTimestamp(event, "occurredAt");
    const rawPayload = requiredObject(event, "payload");
    const payload = parsePayload(
      type as RobinApplicationEventType,
      rawPayload,
    );
    return Object.freeze({
      schemaVersion: ROBIN_APPLICATION_EVENT_SCHEMA_VERSION,
      sequence,
      sessionId,
      eventId,
      occurredAt,
      type,
      payload,
    }) as RobinApplicationEvent;
  } catch (error: unknown) {
    if (error instanceof RobinSessionError) throw error;
    throw invalidEventError();
  }
}

/** Parses bounded UTF-8 JSON before applying the object-level event parser. */
export function parseRobinApplicationEventJson(
  input: string | Uint8Array,
): RobinApplicationEvent {
  try {
    const bytes =
      typeof input === "string" ? Buffer.from(input, "utf8") : input;
    if (bytes.byteLength > MAXIMUM_APPLICATION_EVENT_UTF8_BYTES) invalidEvent();
    const text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true }).decode(input);
    if (Buffer.byteLength(text, "utf8") !== bytes.byteLength) invalidEvent();
    return parseRobinApplicationEvent(JSON.parse(text) as unknown);
  } catch (error: unknown) {
    if (error instanceof RobinSessionError) throw error;
    throw invalidEventError();
  }
}

/** Produces stable key-sorted JSON from the normalized immutable event. */
export function serializeRobinApplicationEvent(value: unknown): string {
  const event = parseRobinApplicationEvent(value);
  return canonicalize(event, SNAPSHOT_LIMITS);
}

/** Escapes, rather than interprets or drops, unsafe terminal code points. */
export function escapeUnsafeTerminalText(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (isSafeTerminalCodePoint(codePoint)) {
      safe += character;
    } else {
      safe += `\\u{${codePoint.toString(16).padStart(2, "0")}}`;
    }
  }
  return safe;
}

function parsePayload(
  type: RobinApplicationEventType,
  payload: JsonObject,
): RobinApplicationEventPayloadMap[RobinApplicationEventType] {
  switch (type) {
    case "SessionStarted":
      requireExactKeys(
        payload,
        new Set(["permissionMode", "persistence", "providerProfile"]),
      );
      return Object.freeze({
        permissionMode: requiredPermissionMode(payload, "permissionMode"),
        persistence: requiredLiteral(payload, "persistence", "ephemeral"),
        providerProfile: requiredLiteral(
          payload,
          "providerProfile",
          "synthetic",
        ),
      });
    case "PermissionModeChanged":
      requireExactKeys(payload, new Set(["permissionMode"]));
      return Object.freeze({
        permissionMode: requiredPermissionMode(payload, "permissionMode"),
      });
    case "UserMessageQueued":
      requireExactKeys(
        payload,
        new Set(["messageId", "position", "text", "turnId"]),
      );
      return Object.freeze({
        messageId: requiredIdentifier(payload, "messageId"),
        position: requiredPositiveInteger(payload, "position"),
        text: requiredSafeText(payload, "text"),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    case "UserMessageAccepted":
      requireExactKeys(
        payload,
        new Set(["messageId", "text", "turnId"]),
      );
      return Object.freeze({
        messageId: requiredIdentifier(payload, "messageId"),
        text: requiredSafeText(payload, "text"),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    case "TurnStarted":
      requireExactKeys(payload, new Set(["messageId", "turnId"]));
      return Object.freeze({
        messageId: requiredIdentifier(payload, "messageId"),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    case "AssistantTextDelta":
      requireExactKeys(payload, new Set(["text", "turnId"]));
      return Object.freeze({
        text: requiredSafeText(payload, "text"),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    case "ToolCallStarted":
      requireExactKeys(payload, new Set(["callId", "toolName", "turnId"]));
      return Object.freeze({
        callId: requiredIdentifier(payload, "callId"),
        toolName: requiredIdentifier(payload, "toolName"),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    case "PermissionDecided":
      requireExactKeys(
        payload,
        new Set([
          "actionHash",
          "actionId",
          "callId",
          "effect",
          "policySnapshotHash",
          "policyVersionId",
          "toolName",
          "turnId",
          "winningPolicyName",
        ]),
      );
      return Object.freeze({
        actionHash: requiredSha256(payload, "actionHash"),
        actionId: requiredActionId(payload, "actionId"),
        callId: requiredIdentifier(payload, "callId"),
        effect: requiredPermissionEffect(payload, "effect"),
        policySnapshotHash: requiredSha256(payload, "policySnapshotHash"),
        policyVersionId: requiredPolicyVersionId(payload, "policyVersionId"),
        toolName: requiredIdentifier(payload, "toolName"),
        turnId: requiredIdentifier(payload, "turnId"),
        winningPolicyName: requiredNullableSafeIdentity(
          payload,
          "winningPolicyName",
        ),
      });
    case "ApprovalRequested": {
      requireExactKeys(
        payload,
        new Set([
          "actionHash",
          "actionId",
          "approvalId",
          "callId",
          "displayedSummary",
          "displayedSummaryHash",
          "expiresAt",
          "normalizedRequestHash",
          "policySnapshotHash",
          "preconditionHash",
          "requestedAt",
          "toolName",
          "turnId",
        ]),
      );
      const binding = parseApprovalBinding(payload);
      const displayedSummary = requiredApprovalDisplaySummary(
        payload,
        "displayedSummary",
      );
      if (
        canonicalSha256Hex(displayedSummary) !== binding.displayedSummaryHash
      ) {
        invalidEvent();
      }
      return Object.freeze({ ...binding, displayedSummary });
    }
    case "ApprovalResolved": {
      requireExactKeys(
        payload,
        new Set([
          "actionHash",
          "actionId",
          "approvalId",
          "callId",
          "decision",
          "displayedSummaryHash",
          "expiresAt",
          "normalizedRequestHash",
          "outcome",
          "policySnapshotHash",
          "preconditionHash",
          "requestedAt",
          "resolvedAt",
          "toolName",
          "turnId",
        ]),
      );
      const binding = parseApprovalBinding(payload);
      const decision = requiredApprovalDecision(payload, "decision");
      const outcome = requiredApprovalOutcome(payload, "outcome");
      const resolvedAt = requiredTimestamp(payload, "resolvedAt");
      const resolvedAtMs = Date.parse(resolvedAt);
      const expiresAtMs = Date.parse(binding.expiresAt);
      if (
        (decision === "deny" && outcome === "granted") ||
        (decision === "allow_once" && outcome === "denied") ||
        resolvedAtMs < Date.parse(binding.requestedAt) ||
        (outcome === "stale" && resolvedAtMs < expiresAtMs) ||
        (outcome !== "stale" && resolvedAtMs >= expiresAtMs)
      ) {
        invalidEvent();
      }
      return Object.freeze({
        ...binding,
        decision,
        outcome,
        resolvedAt,
      });
    }
    case "ApprovalInvalidated": {
      requireExactKeys(
        payload,
        new Set([
          "actionHash",
          "actionId",
          "approvalId",
          "callId",
          "displayedSummaryHash",
          "expiresAt",
          "invalidatedAt",
          "normalizedRequestHash",
          "observedPreconditionHash",
          "policySnapshotHash",
          "preconditionHash",
          "reason",
          "requestedAt",
          "toolName",
          "turnId",
        ]),
      );
      const binding = parseApprovalBinding(payload);
      const invalidatedAt = requiredTimestamp(payload, "invalidatedAt");
      const observedPreconditionHash = requiredNullableSha256(
        payload,
        "observedPreconditionHash",
      );
      const reason = requiredApprovalInvalidationReason(payload, "reason");
      if (
        Date.parse(invalidatedAt) < Date.parse(binding.requestedAt) ||
        (reason === "approval_expired" &&
          (Date.parse(invalidatedAt) < Date.parse(binding.expiresAt) ||
            observedPreconditionHash !== null)) ||
        (reason === "preconditions_changed" &&
          (observedPreconditionHash === null ||
            observedPreconditionHash === binding.preconditionHash))
      ) {
        invalidEvent();
      }
      return Object.freeze({
        ...binding,
        invalidatedAt,
        observedPreconditionHash,
        reason,
      });
    }
    case "ToolCallCompleted":
      requireExactKeys(
        payload,
        new Set(["callId", "observation", "toolName", "turnId"]),
      );
      return Object.freeze({
        callId: requiredIdentifier(payload, "callId"),
        observation: escapeJsonObject(
          requiredObject(payload, "observation"),
        ),
        toolName: requiredIdentifier(payload, "toolName"),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    case "ToolCallFailed": {
      requireExactKeys(
        payload,
        new Set(["callId", "code", "message", "toolName", "turnId"]),
      );
      const code = requiredString(payload, "code", 64, false);
      if (!ERROR_CODE_SET.has(code)) invalidEvent();
      return Object.freeze({
        callId: requiredIdentifier(payload, "callId"),
        code: code as ErrorCode,
        message: requiredSafeText(payload, "message", 16_384),
        toolName: requiredIdentifier(payload, "toolName"),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    }
    case "UsageReported":
      requireExactKeys(
        payload,
        new Set(["inputTokens", "outputTokens", "turnId"]),
      );
      return Object.freeze({
        inputTokens: requiredNonNegativeInteger(payload, "inputTokens"),
        outputTokens: requiredNonNegativeInteger(payload, "outputTokens"),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    case "BudgetWarning":
    case "BudgetExhausted": {
      requireExactKeys(
        payload,
        new Set(["dimension", "limit", "turnId", "used"]),
      );
      const dimension = requiredString(payload, "dimension", 64, false);
      if (!BUDGET_DIMENSION_SET.has(dimension)) invalidEvent();
      const limit = requiredPositiveInteger(payload, "limit");
      const used = requiredNonNegativeInteger(payload, "used");
      if (
        (type === "BudgetWarning" && used >= limit) ||
        (type === "BudgetExhausted" && used < limit)
      ) {
        invalidEvent();
      }
      return Object.freeze({
        dimension: dimension as RobinBudgetDimension,
        limit,
        turnId: requiredIdentifier(payload, "turnId"),
        used,
      });
    }
    case "TurnCancellationRequested":
    case "TurnCancelled":
      requireExactKeys(payload, new Set(["reason", "turnId"]));
      return Object.freeze({
        reason: requiredSafeText(payload, "reason", 4_096),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    case "TurnFailed": {
      requireExactKeys(payload, new Set(["code", "message", "turnId"]));
      const code = requiredString(payload, "code", 64, false);
      if (!ERROR_CODE_SET.has(code)) invalidEvent();
      return Object.freeze({
        code: code as ErrorCode,
        message: requiredSafeText(payload, "message", 16_384),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    }
    case "TurnCompleted":
      requireExactKeys(payload, new Set(["text", "turnId"]));
      return Object.freeze({
        text: requiredSafeText(payload, "text"),
        turnId: requiredIdentifier(payload, "turnId"),
      });
    case "SessionClosed": {
      requireExactKeys(payload, new Set(["reason"]));
      const reason = requiredString(payload, "reason", 32, false);
      if (!SESSION_CLOSE_REASON_SET.has(reason)) invalidEvent();
      return Object.freeze({
        reason: reason as RobinApplicationEventPayloadMap["SessionClosed"]["reason"],
      });
    }
  }
}

function parseApprovalBinding(payload: JsonObject): RobinApprovalBinding {
  const requestedAt = requiredTimestamp(payload, "requestedAt");
  const expiresAt = requiredTimestamp(payload, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(requestedAt)) invalidEvent();
  return Object.freeze({
    actionHash: requiredSha256(payload, "actionHash"),
    actionId: requiredActionId(payload, "actionId"),
    approvalId: requiredApprovalId(payload, "approvalId"),
    callId: requiredIdentifier(payload, "callId"),
    displayedSummaryHash: requiredSha256(
      payload,
      "displayedSummaryHash",
    ),
    expiresAt,
    normalizedRequestHash: requiredSha256(
      payload,
      "normalizedRequestHash",
    ),
    policySnapshotHash: requiredSha256(payload, "policySnapshotHash"),
    preconditionHash: requiredSha256(payload, "preconditionHash"),
    requestedAt,
    toolName: requiredIdentifier(payload, "toolName"),
    turnId: requiredIdentifier(payload, "turnId"),
  });
}

function requiredApprovalDisplaySummary(
  value: JsonObject,
  key: string,
): JsonObject {
  const summary = requiredObject(value, key);
  if (
    Object.keys(summary).length === 0 ||
    canonicalBytes(summary).byteLength >
      MAXIMUM_APPROVAL_DISPLAY_SUMMARY_UTF8_BYTES
  ) {
    invalidEvent();
  }
  assertDisplaySafeJsonValue(summary);
  return summary;
}

function assertDisplaySafeJsonValue(value: JsonValue): void {
  if (typeof value === "string") {
    if (containsUnsafeTerminalCodePoint(value)) invalidEvent();
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertDisplaySafeJsonValue(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (containsIdentifierControlCodePoint(key)) invalidEvent();
    assertDisplaySafeJsonValue(item);
  }
}

function requiredSha256(value: JsonObject, key: string): string {
  const hash = requiredString(value, key, 64, false);
  if (!/^[a-f0-9]{64}$/u.test(hash)) invalidEvent();
  return hash;
}

function requiredNullableSha256(
  value: JsonObject,
  key: string,
): string | null {
  return value[key] === null ? null : requiredSha256(value, key);
}

function requiredActionId(value: JsonObject, key: string): ActionId {
  const actionId = requiredIdentifier(value, key);
  if (!ActionIdKind.is(actionId)) invalidEvent();
  return actionId;
}

function requiredApprovalId(value: JsonObject, key: string): ApprovalId {
  const approvalId = requiredIdentifier(value, key);
  if (!ApprovalIdKind.is(approvalId)) invalidEvent();
  return approvalId;
}

function requiredPolicyVersionId(
  value: JsonObject,
  key: string,
): PolicyVersionId {
  const policyVersionId = requiredIdentifier(value, key);
  if (!PolicyVersionIdKind.is(policyVersionId)) invalidEvent();
  return policyVersionId;
}

function requiredPermissionEffect(
  value: JsonObject,
  key: string,
): RobinPermissionEffect {
  const effect = requiredString(value, key, 32, false);
  if (!PERMISSION_EFFECT_SET.has(effect)) invalidEvent();
  return effect as RobinPermissionEffect;
}

function requiredNullableSafeIdentity(
  value: JsonObject,
  key: string,
): string | null {
  if (value[key] === null) return null;
  const identity = requiredString(
    value,
    key,
    MAXIMUM_APPLICATION_IDENTIFIER_UTF8_BYTES,
    false,
  );
  if (
    identity.trim() !== identity ||
    containsIdentifierControlCodePoint(identity)
  ) {
    invalidEvent();
  }
  return identity;
}

function requiredApprovalDecision(
  value: JsonObject,
  key: string,
): RobinApprovalDecision {
  const decision = requiredString(value, key, 16, false);
  if (!APPROVAL_DECISION_SET.has(decision)) invalidEvent();
  return decision as RobinApprovalDecision;
}

function requiredApprovalOutcome(
  value: JsonObject,
  key: string,
): RobinApprovalOutcome {
  const outcome = requiredString(value, key, 16, false);
  if (!APPROVAL_OUTCOME_SET.has(outcome)) invalidEvent();
  return outcome as RobinApprovalOutcome;
}

function requiredApprovalInvalidationReason(
  value: JsonObject,
  key: string,
): RobinApprovalInvalidationReason {
  const reason = requiredString(value, key, 32, false);
  if (!APPROVAL_INVALIDATION_REASON_SET.has(reason)) invalidEvent();
  return reason as RobinApprovalInvalidationReason;
}

function escapeJsonObject(value: JsonObject): JsonObject {
  return escapeJsonValue(value) as JsonObject;
}

function escapeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return escapeUnsafeTerminalText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => escapeJsonValue(item)));
  }
  const target: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (containsIdentifierControlCodePoint(key)) invalidEvent();
    target[key] = escapeJsonValue(item);
  }
  return Object.freeze(target);
}

function requiredObject(value: JsonObject, key: string): JsonObject {
  const member = value[key];
  if (typeof member !== "object" || member === null || Array.isArray(member)) {
    invalidEvent();
  }
  return member as JsonObject;
}

function requiredIdentifier(value: JsonObject, key: string): string {
  const identifier = requiredString(
    value,
    key,
    MAXIMUM_APPLICATION_IDENTIFIER_UTF8_BYTES,
    false,
  );
  if (
    identifier.trim() !== identifier ||
    containsIdentifierControlCodePoint(identifier)
  ) {
    invalidEvent();
  }
  return identifier;
}

function requiredSafeText(
  value: JsonObject,
  key: string,
  maximumBytes = MAXIMUM_APPLICATION_TEXT_UTF8_BYTES,
): string {
  const text = requiredString(value, key, maximumBytes, true);
  const safe = escapeUnsafeTerminalText(text);
  if (Buffer.byteLength(safe, "utf8") > maximumBytes) invalidEvent();
  return safe;
}

function requiredString(
  value: JsonObject,
  key: string,
  maximumBytes: number,
  permitEmpty: boolean,
): string {
  const member = value[key];
  if (
    typeof member !== "string" ||
    (!permitEmpty && member.length === 0) ||
    Buffer.byteLength(member, "utf8") > maximumBytes
  ) {
    invalidEvent();
  }
  return member;
}

function requiredPermissionMode(
  value: JsonObject,
  key: string,
): RobinPermissionMode {
  const mode = requiredString(value, key, 16, false);
  if (!PERMISSION_MODE_SET.has(mode)) invalidEvent();
  return mode as RobinPermissionMode;
}

function requiredLiteral<TValue extends string>(
  value: JsonObject,
  key: string,
  literal: TValue,
): TValue {
  if (value[key] !== literal) invalidEvent();
  return literal;
}

function requiredPositiveInteger(value: JsonObject, key: string): number {
  const member = value[key];
  if (!Number.isSafeInteger(member) || typeof member !== "number" || member <= 0) {
    invalidEvent();
  }
  return member;
}

function requiredNonNegativeInteger(value: JsonObject, key: string): number {
  const member = value[key];
  if (!Number.isSafeInteger(member) || typeof member !== "number" || member < 0) {
    invalidEvent();
  }
  return member;
}

function requiredTimestamp(value: JsonObject, key: string): string {
  const timestamp = requiredString(value, key, 64, false);
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.valueOf()) || instant.toISOString() !== timestamp) {
    invalidEvent();
  }
  return timestamp;
}

function requireExactKeys(value: JsonObject, expected: ReadonlySet<string>): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.size ||
    keys.some((key) => !expected.has(key))
  ) {
    invalidEvent();
  }
}

function containsUnsafeTerminalCodePoint(value: string): boolean {
  for (const character of value) {
    if (!isSafeTerminalCodePoint(character.codePointAt(0)!)) return true;
  }
  return false;
}

function containsIdentifierControlCodePoint(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

function isSafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    (codePoint >= 0x20 &&
      codePoint !== 0x7f &&
      (codePoint < 0x80 || codePoint > 0x9f) &&
      (codePoint < 0xd800 || codePoint > 0xdfff) &&
      codePoint !== 0x2028 &&
      codePoint !== 0x2029)
  );
}

function invalidEvent(): never {
  throw invalidEventError();
}

function invalidEventError(): RobinSessionError {
  return new RobinSessionError(
    "invalid_event",
    `Invalid Robin application event; expected schema version ${ROBIN_APPLICATION_EVENT_SCHEMA_VERSION}.`,
  );
}
