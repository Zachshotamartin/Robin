import {
  canonicalize,
  createDomainError,
  snapshotBoundaryJsonObject,
} from "@guard/contracts";
import type { JsonBoundaryLimitOptions, JsonObject } from "@guard/contracts";

export function snapshot<T>(value: T): T {
  const detached = JSON.parse(canonicalize(value)) as T;
  return deepFreeze(detached);
}

export function snapshotBoundaryObject(
  value: unknown,
  label: string,
  limits?: JsonBoundaryLimitOptions,
): JsonObject {
  try {
    return snapshotBoundaryJsonObject(value, limits);
  } catch {
    throw createDomainError({
      code: "invalid_input",
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
