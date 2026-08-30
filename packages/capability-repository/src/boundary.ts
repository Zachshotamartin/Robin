import {
  createDomainError,
  snapshotBoundaryJsonObject,
} from "@guard/contracts";
import type { JsonObject } from "@guard/contracts";

/** Detach serializable caller input and erase hostile reflection failures. */
export function snapshotBoundaryObject(
  value: unknown,
  label: string,
): JsonObject {
  try {
    return snapshotBoundaryJsonObject(value);
  } catch {
    throw createDomainError({
      code: "invalid_input",
      message: `${label} must be a lossless JSON object.`,
    });
  }
}
