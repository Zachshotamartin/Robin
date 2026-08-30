import {
  ActionIdKind,
  ERROR_CODES,
  createDomainError,
  isErrorId,
  parseContentBlock,
  snapshotBoundaryJsonObject,
  type ActionId,
  type ContentBlock,
  type ErrorCode,
  type ErrorId,
  type ObservationStatus,
  type RetryClass,
} from "@guard/contracts";

export const AGENT_OBSERVATION_SCHEMA_VERSION = 1 as const;

export type AgentObservationSchemaVersion =
  typeof AGENT_OBSERVATION_SCHEMA_VERSION;

/** A safe error projection: diagnostic details and cause chains stay host-side. */
export interface AgentObservationError {
  readonly errorId: ErrorId;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retry: RetryClass;
}

/**
 * The complete observation view that may cross into an agent driver.
 * Capability audit and human views are intentionally unrepresentable here.
 */
export interface AgentObservation {
  readonly schemaVersion: AgentObservationSchemaVersion;
  readonly observationId: string;
  readonly actionId: ActionId;
  readonly status: ObservationStatus;
  readonly content: readonly ContentBlock[];
  readonly error: AgentObservationError | null;
  readonly occurredAt: string;
}

const OBSERVATION_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "uncertain",
  "denied",
]);
const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);
const RETRY_CLASSES: ReadonlySet<string> = new Set([
  "terminal",
  "retryable",
  "uncertain",
]);

/** Returns an exact detached and deeply frozen agent-facing observation. */
export function parseAgentObservation(value: unknown): AgentObservation {
  try {
    const snapshot = snapshotBoundaryJsonObject(value);
    if (validateAgentObservation(snapshot)) {
      return snapshot as unknown as AgentObservation;
    }
  } catch {
    // Deliberately discard hostile values and exceptions at the driver boundary.
  }
  throw createDomainError({
    code: "invalid_input",
    message: "Invalid agent observation.",
  });
}

function validateAgentObservation(
  value: Readonly<Record<string, unknown>>,
): boolean {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "observationId",
      "actionId",
      "status",
      "content",
      "error",
      "occurredAt",
    ]) ||
    value["schemaVersion"] !== AGENT_OBSERVATION_SCHEMA_VERSION ||
    !identifier(value["observationId"]) ||
    !ActionIdKind.is(value["actionId"]) ||
    typeof value["status"] !== "string" ||
    !OBSERVATION_STATUSES.has(value["status"]) ||
    !Array.isArray(value["content"]) ||
    !timestamp(value["occurredAt"])
  ) {
    return false;
  }

  try {
    value["content"].forEach((block) => parseContentBlock(block));
  } catch {
    return false;
  }

  const error = value["error"];
  if (value["status"] === "succeeded") {
    return error === null;
  }
  return validateAgentObservationError(error);
}

function validateAgentObservationError(value: unknown): boolean {
  if (!record(value) || !hasExactKeys(value, ["errorId", "code", "message", "retry"])) {
    return false;
  }
  return (
    isErrorId(value["errorId"]) &&
    typeof value["code"] === "string" &&
    ERROR_CODE_SET.has(value["code"]) &&
    typeof value["message"] === "string" &&
    value["message"].trim().length > 0 &&
    typeof value["retry"] === "string" &&
    RETRY_CLASSES.has(value["retry"])
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value;
}
