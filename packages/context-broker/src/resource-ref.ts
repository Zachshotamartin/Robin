import {
  CONTRACT_SCHEMA_VERSION,
  canonicalBytes,
  canonicalize,
  createDomainError,
} from "@guard/contracts";
import type { JsonObject, ResourceRef } from "@guard/contracts";
import { isProxy } from "node:util/types";

import { snapshotBoundaryObject } from "./immutable.js";

const MAXIMUM_LOCATOR_BYTES = 16 * 1024;
const SCHEME = /^[a-z][a-z0-9+.-]*$/u;

/**
 * Validates the domain-neutral ResourceRef envelope. Locator semantics remain
 * exclusively owned by the installed source adapter.
 */
export function canonicalizeResourceRef(
  input: unknown,
  expected?: {
    readonly scheme?: string;
    readonly sourceId?: string;
  },
): ResourceRef {
  const pinned = parseExpectedSource(expected);
  const detached = snapshotBoundaryObject(input, "Resource reference");
  if (
    !hasExactKeys(detached, [
      "schemaVersion",
      "scheme",
      "sourceId",
      "locator",
      "mediaType",
      "classification",
    ]) ||
    detached["schemaVersion"] !== CONTRACT_SCHEMA_VERSION
  ) {
    throw invalidInput(
      "A resource reference contains unknown, missing, or unsupported fields.",
    );
  }

  const scheme = detached["scheme"];
  const sourceId = detached["sourceId"];
  const locator = detached["locator"];
  const mediaType = detached["mediaType"];
  const classification = detached["classification"];
  if (typeof scheme !== "string" || !SCHEME.test(scheme)) {
    throw invalidInput("A resource scheme must use canonical lowercase URI syntax.");
  }
  if (
    typeof sourceId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(sourceId)
  ) {
    throw invalidInput("A resource sourceId must be a canonical safe identifier.");
  }
  if (!isPlainObject(locator)) {
    throw invalidInput("A resource locator must be a JSON object.");
  }
  if (canonicalBytes(locator).byteLength > MAXIMUM_LOCATOR_BYTES) {
    throw invalidInput("A resource locator exceeds the configured byte bound.");
  }
  if (
    mediaType !== null &&
    (typeof mediaType !== "string" || !isCanonicalMediaType(mediaType))
  ) {
    throw invalidInput("A resource mediaType must be null or canonical MIME syntax.");
  }
  if (
    typeof classification !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(classification)
  ) {
    throw invalidInput("A resource classification must be a canonical safe identifier.");
  }
  if (pinned.scheme !== undefined && scheme !== pinned.scheme) {
    throw invalidInput("A resource scheme does not match its installed source.");
  }
  if (pinned.sourceId !== undefined && sourceId !== pinned.sourceId) {
    throw invalidInput("A resource sourceId does not match its installed source.");
  }

  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scheme,
    sourceId,
    locator,
    mediaType,
    classification,
  }) as ResourceRef;
}

function parseExpectedSource(
  value: { readonly scheme?: string; readonly sourceId?: string } | undefined,
): { readonly scheme?: string; readonly sourceId?: string } {
  if (value === undefined) return Object.freeze({});
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidInput("Expected resource source constraints are malformed.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "scheme" && key !== "sourceId"),
    )
  ) {
    throw invalidInput("Expected resource source constraints contain unknown fields.");
  }
  const result: { scheme?: string; sourceId?: string } = {};
  for (const key of ["scheme", "sourceId"] as const) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) continue;
    if (
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string"
    ) {
      throw invalidInput("Expected resource source constraints require data fields.");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function isCanonicalMediaType(value: string): boolean {
  return (
    value === value.trim().toLowerCase() &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value)
  );
}

export function resourceRefsEqual(left: unknown, right: unknown): boolean {
  try {
    return (
      canonicalize(canonicalizeResourceRef(left)) ===
      canonicalize(canonicalizeResourceRef(right))
    );
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
