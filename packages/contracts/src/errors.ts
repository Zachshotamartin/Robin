import type { Brand } from "./brand.js";
import {
  cloneAndFreezeJsonObject,
  isJsonObject,
  type JsonObject,
} from "./json-value.js";
import { generateUuidV7, isLowercaseUuidV7 } from "./uuid-v7.js";
import { snapshotBoundaryJsonObject } from "./boundary-snapshot.js";

export type ErrorId = Brand<string, "ErrorId">;

export const ERROR_CODES = [
  "invalid_input",
  "policy_denied",
  "approval_required",
  "approval_invalid",
  "budget_exceeded",
  "action_failed",
  "driver_failed",
  "attempt_result_uncertain",
  "provider_failed",
  "provider_result_uncertain",
  "sandbox_failed",
  "conflict",
  "cancelled",
  "infrastructure_failed",
  "invariant_violated",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type RetryClass = "terminal" | "retryable" | "uncertain";

/**
 * Default retry classification per code. An operation may override the default
 * at creation time; the classification travels with the error so callers never
 * re-derive retryability from message text.
 */
export const DEFAULT_RETRY_CLASS: Readonly<Record<ErrorCode, RetryClass>> =
  Object.freeze({
    invalid_input: "terminal",
    policy_denied: "terminal",
    approval_required: "terminal",
    approval_invalid: "terminal",
    budget_exceeded: "terminal",
    action_failed: "terminal",
    driver_failed: "terminal",
    attempt_result_uncertain: "uncertain",
    provider_failed: "retryable",
    provider_result_uncertain: "uncertain",
    sandbox_failed: "retryable",
    conflict: "retryable",
    cancelled: "terminal",
    infrastructure_failed: "retryable",
    invariant_violated: "terminal",
  });

export interface DomainError {
  readonly errorId: ErrorId;
  readonly code: ErrorCode;
  /** Safe human-readable message; must never contain secret material. */
  readonly message: string;
  readonly retry: RetryClass;
  readonly details?: JsonObject;
  readonly causeErrorId?: ErrorId;
}

export interface DomainErrorInput {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retry?: RetryClass;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly causeErrorId?: ErrorId;
}

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);
const RETRY_CLASSES: ReadonlySet<string> = new Set([
  "terminal",
  "retryable",
  "uncertain",
]);

export function generateErrorId(): ErrorId {
  return `err_${generateUuidV7()}` as ErrorId;
}

export function isErrorId(value: unknown): value is ErrorId {
  return (
    typeof value === "string" &&
    value.startsWith("err_") &&
    isLowercaseUuidV7(value.slice(4))
  );
}

/**
 * Creates an immutable, JSON-serializable domain error. Construction problems
 * are programmer mistakes, so they throw `TypeError` rather than returning a
 * nested domain error.
 */
export function createDomainError(input: DomainErrorInput): DomainError {
  if (!ERROR_CODE_SET.has(input.code)) {
    throw new TypeError(`Unknown domain error code: ${String(input.code)}`);
  }
  if (typeof input.message !== "string" || input.message.trim().length === 0) {
    throw new TypeError("A domain error requires a non-empty safe message.");
  }
  if (input.retry !== undefined && !RETRY_CLASSES.has(input.retry)) {
    throw new TypeError(`Unknown retry class: ${String(input.retry)}`);
  }
  if (input.causeErrorId !== undefined && !isErrorId(input.causeErrorId)) {
    throw new TypeError("A cause error id must use the err_<lowercase-uuidv7> format.");
  }

  const details =
    input.details === undefined
      ? undefined
      : cloneAndFreezeJsonObject(input.details, "Domain error details");

  const error: DomainError = {
    errorId: generateErrorId(),
    code: input.code,
    message: input.message,
    retry: input.retry ?? DEFAULT_RETRY_CLASS[input.code],
    ...(details !== undefined ? { details } : {}),
    ...(input.causeErrorId !== undefined
      ? { causeErrorId: input.causeErrorId }
      : {}),
  };

  return Object.freeze(error);
}

export function isDomainError(value: unknown): value is DomainError {
  try {
    return validateDomainErrorSnapshot(snapshotBoundaryJsonObject(value));
  } catch {
    return false;
  }
}

/** Validates and returns a detached, deeply frozen serialized domain error. */
export function parseDomainError(value: unknown): DomainError {
  try {
    const snapshot = snapshotBoundaryJsonObject(value);
    if (validateDomainErrorSnapshot(snapshot)) {
      return snapshot as unknown as DomainError;
    }
  } catch {
    // The public error is deliberately independent of hostile input details.
  }
  throw createDomainError({
    code: "invalid_input",
    message: "Invalid serialized domain error.",
  });
}

function validateDomainErrorSnapshot(candidate: JsonObject): boolean {
  const allowed = new Set([
    "errorId",
    "code",
    "message",
    "retry",
    "details",
    "causeErrorId",
  ]);
  const keys = Object.keys(candidate);
  if (
    keys.some((key) => !allowed.has(key)) ||
    !Object.hasOwn(candidate, "errorId") ||
    !Object.hasOwn(candidate, "code") ||
    !Object.hasOwn(candidate, "message") ||
    !Object.hasOwn(candidate, "retry")
  ) {
    return false;
  }
  if (
    !isErrorId(candidate["errorId"]) ||
    typeof candidate["code"] !== "string" ||
    !ERROR_CODE_SET.has(candidate["code"]) ||
    typeof candidate["message"] !== "string" ||
    candidate["message"].trim().length === 0 ||
    typeof candidate["retry"] !== "string" ||
    !RETRY_CLASSES.has(candidate["retry"])
  ) {
    return false;
  }
  if (Object.hasOwn(candidate, "details") && !isJsonObject(candidate["details"])) {
    return false;
  }
  return (
    !Object.hasOwn(candidate, "causeErrorId") ||
    isErrorId(candidate["causeErrorId"])
  );
}
