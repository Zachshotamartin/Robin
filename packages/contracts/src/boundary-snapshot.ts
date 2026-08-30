import { isProxy } from "node:util/types";

import type { JsonArray, JsonObject, JsonValue } from "./json-value.js";

/** Internal, deliberately value-free failure used at hostile JSON boundaries. */
export class BoundarySnapshotError extends TypeError {
  public constructor() {
    super("The boundary value is not lossless JSON data.");
    this.name = "BoundarySnapshotError";
  }
}

/**
 * Takes one descriptor-only, deeply frozen snapshot of a JSON object. Proxies
 * are rejected explicitly because a predicate over a caller-owned proxy cannot
 * make later property reads trustworthy.
 */
export function snapshotBoundaryJsonObject(value: unknown): JsonObject {
  try {
    const snapshot = snapshotValue(value, new WeakSet<object>());
    if (!isRecord(snapshot)) {
      throw new BoundarySnapshotError();
    }
    return snapshot;
  } catch {
    throw new BoundarySnapshotError();
  }
}

function snapshotValue(value: unknown, stack: WeakSet<object>): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BoundarySnapshotError();
    }
    return value;
  }
  if (typeof value !== "object" || isProxy(value)) {
    throw new BoundarySnapshotError();
  }
  if (stack.has(value)) {
    throw new BoundarySnapshotError();
  }

  stack.add(value);
  try {
    return Array.isArray(value)
      ? snapshotArray(value, stack)
      : snapshotObject(value as Readonly<Record<string, unknown>>, stack);
  } finally {
    stack.delete(value);
  }
}

function snapshotArray(value: readonly unknown[], stack: WeakSet<object>): JsonArray {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype) {
    throw new BoundarySnapshotError();
  }

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new BoundarySnapshotError();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable === true ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new BoundarySnapshotError();
  }
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1) {
    throw new BoundarySnapshotError();
  }

  const result: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new BoundarySnapshotError();
    }
    result.push(snapshotValue(descriptor.value, stack));
  }
  return Object.freeze(result);
}

function snapshotObject(
  value: Readonly<Record<string, unknown>>,
  stack: WeakSet<object>
): JsonObject {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BoundarySnapshotError();
  }

  const result: Record<string, JsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new BoundarySnapshotError();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new BoundarySnapshotError();
    }
    Object.defineProperty(result, key, {
      value: snapshotValue(descriptor.value, stack),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(result);
}

function isRecord(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
