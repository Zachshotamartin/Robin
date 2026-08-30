import { randomUUID } from "node:crypto";

import type { Brand } from "./brand.js";

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
  readonly details?: Readonly<Record<string, unknown>>;
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function generateErrorId(): ErrorId {
  return `err_${randomUUID()}` as ErrorId;
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

  const error: DomainError = {
    errorId: generateErrorId(),
    code: input.code,
    message: input.message,
    retry: input.retry ?? DEFAULT_RETRY_CLASS[input.code],
    ...(input.details !== undefined ? { details: deepFreeze(input.details) } : {}),
    ...(input.causeErrorId !== undefined
      ? { causeErrorId: input.causeErrorId }
      : {}),
  };

  return Object.freeze(error);
}

export function isDomainError(value: unknown): value is DomainError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<DomainError>;
  return (
    typeof candidate.errorId === "string" &&
    candidate.errorId.startsWith("err_") &&
    typeof candidate.code === "string" &&
    ERROR_CODE_SET.has(candidate.code) &&
    typeof candidate.message === "string" &&
    candidate.message.length > 0 &&
    typeof candidate.retry === "string" &&
    RETRY_CLASSES.has(candidate.retry)
  );
}
