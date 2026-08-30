import { canonicalize, createDomainError } from "@guard/contracts";

export function validatePlainData(value: unknown): void {
  canonicalize(value);
}

export function cloneAndFreeze<T>(value: T): T {
  validatePlainData(value);
  return deepFreeze(structuredClone(value));
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

export function invalidInput(message: string): never {
  throw createDomainError({ code: "invalid_input", message });
}

export function nonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidInput(`${path} must be a non-empty string.`);
  }
}

export function nonNegativeInteger(
  value: unknown,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidInput(`${path} must be a non-negative safe integer.`);
  }
}

export function positiveInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalidInput(`${path} must be a positive safe integer.`);
  }
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
