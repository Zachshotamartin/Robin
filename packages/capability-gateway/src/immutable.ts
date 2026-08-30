import {
  canonicalize,
  createDomainError,
  snapshotBoundaryJsonObject,
} from "@guard/contracts";
import type { JsonObject } from "@guard/contracts";

export function snapshot<T>(value: T): T {
  try {
    const detached = JSON.parse(canonicalize(value)) as T;
    return deepFreeze(detached);
  } catch (error: unknown) {
    if (isObjectWithCode(error)) {
      throw error;
    }
    throw createDomainError({
      code: "invalid_input",
      message: "A capability boundary value must be lossless JSON data.",
    });
  }
}

export function snapshotObject(
  value: unknown,
  label: string,
  code: "invalid_input" | "invariant_violated" = "invalid_input",
): JsonObject {
  try {
    return snapshotBoundaryJsonObject(value);
  } catch {
    throw createDomainError({
      code,
      message: `${label} must be a lossless JSON object.`,
    });
  }
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObjectWithCode(value: unknown): value is { readonly code: unknown } {
  return typeof value === "object" && value !== null && "code" in value;
}
