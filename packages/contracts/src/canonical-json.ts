import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  resolveJsonBoundaryLimits,
  type JsonBoundaryLimitOptions,
  type JsonBoundaryLimits,
} from "./boundary-snapshot.js";
import { createDomainError } from "./errors.js";

const INTERNAL_CANONICAL_ERRORS = new WeakSet<object>();

/** Immutable resource-limit overrides accepted by canonical JSON operations. */
export type CanonicalJsonLimitOptions = JsonBoundaryLimitOptions;

/**
 * Canonical JSON per the implementation guide: UTF-8, lexicographically sorted
 * object keys, order-preserving arrays, finite numbers only, and an explicit
 * distinction between absent and null — an `undefined` property or element is
 * an error rather than a silent omission. Only null, booleans, finite numbers,
 * strings, arrays, and plain objects are accepted; everything else fails
 * closed so approval and idempotency hashes never depend on ambiguous input.
 * Traversal and output are bounded by finite defaults and use an explicit stack.
 */
export function canonicalize(
  value: unknown,
  options?: CanonicalJsonLimitOptions
): string {
  return serializeCanonical(value, options).text;
}

export function canonicalBytes(
  value: unknown,
  options?: CanonicalJsonLimitOptions
): Buffer {
  const serialized = serializeCanonical(value, options);
  return Buffer.from(serialized.text, "utf8");
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalSha256Hex(
  value: unknown,
  options?: CanonicalJsonLimitOptions
): string {
  const serialized = serializeCanonical(value, options);
  return createHash("sha256").update(serialized.text, "utf8").digest("hex");
}

interface CanonicalSerialization {
  readonly text: string;
  readonly utf8ByteLength: number;
}

interface CanonicalState {
  readonly active: Set<object>;
  canonicalUtf8Bytes: number;
  readonly chunks: string[];
  readonly limits: Readonly<JsonBoundaryLimits>;
  nodes: number;
}

interface ValueFrame {
  readonly kind: "value";
  readonly value: unknown;
  readonly path: string;
  /** Number of containing arrays/objects above this value. */
  readonly depth: number;
}

interface TextFrame {
  readonly kind: "text";
  readonly text: string;
}

interface LeaveFrame {
  readonly kind: "leave";
  readonly source: object;
}

type CanonicalFrame = ValueFrame | TextFrame | LeaveFrame;

function serializeCanonical(
  value: unknown,
  options: CanonicalJsonLimitOptions | undefined
): CanonicalSerialization {
  try {
    const limits = resolveJsonBoundaryLimits(options);
    const state: CanonicalState = {
      active: new Set<object>(),
      canonicalUtf8Bytes: 0,
      chunks: [],
      limits,
      nodes: 0,
    };
    reserveNodes(state, 1, "$");

    const frames: CanonicalFrame[] = [
      { kind: "value", value, path: "$", depth: 0 },
    ];
    while (frames.length > 0) {
      const frame = frames.pop();
      if (frame === undefined) {
        return reject("$", "canonical traversal ended unexpectedly");
      }
      if (frame.kind === "leave") {
        state.active.delete(frame.source);
        continue;
      }
      if (frame.kind === "text") {
        state.chunks.push(frame.text);
        continue;
      }
      serializeValue(frame, frames, state);
    }

    return {
      text: state.chunks.join(""),
      utf8ByteLength: state.canonicalUtf8Bytes,
    };
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      INTERNAL_CANONICAL_ERRORS.has(error)
    ) {
      throw error;
    }
    return reject("$", "the value or resource limits could not be inspected safely");
  }
}

function serializeValue(
  frame: ValueFrame,
  frames: CanonicalFrame[],
  state: CanonicalState
): void {
  const { value, path } = frame;
  if (value === null) {
    appendScalar("null", path, state);
    return;
  }

  switch (typeof value) {
    case "boolean":
      appendScalar(value ? "true" : "false", path, state);
      return;
    case "number": {
      if (!Number.isFinite(value)) {
        reject(path, "numbers must be finite");
      }
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        reject(path, "the number could not be represented");
      }
      appendScalar(serialized, path, state);
      return;
    }
    case "string": {
      enforceStringLimit(value, path, state.limits);
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        reject(path, "the string could not be represented");
      }
      appendScalar(serialized, path, state);
      return;
    }
    case "undefined":
      reject(path, "undefined is not representable; omit the value instead");
      return;
    case "bigint":
      reject(path, "bigint is not representable; use a string or integer");
      return;
    case "object":
      serializeContainer(value, frame, frames, state);
      return;
    default:
      reject(path, `type ${typeof value} is not representable`);
  }
}

function serializeContainer(
  value: object,
  frame: ValueFrame,
  frames: CanonicalFrame[],
  state: CanonicalState
): void {
  if (isProxy(value)) {
    reject(frame.path, "proxy objects are not representable");
  }
  const containerDepth = frame.depth + 1;
  if (containerDepth > state.limits.maximumDepth) {
    reject(frame.path, "maximum container depth was exceeded");
  }
  if (state.active.has(value)) {
    reject(frame.path, "cyclic references are not representable");
  }

  if (Array.isArray(value)) {
    serializeArray(value, containerDepth, frame.path, frames, state);
    return;
  }
  if (!isPlainObject(value)) {
    reject(frame.path, "only plain objects and arrays are representable");
  }
  serializeObject(
    value as Readonly<Record<string, unknown>>,
    containerDepth,
    frame.path,
    frames,
    state
  );
}

function serializeArray(
  value: readonly unknown[],
  containerDepth: number,
  path: string,
  frames: CanonicalFrame[],
  state: CanonicalState
): void {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable === true ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    reject(path, "array length must be a safe non-enumerable data property");
  }
  const length = lengthDescriptor.value;
  if (length > state.limits.maximumArrayLength) {
    reject(path, "maximum array length was exceeded");
  }
  reserveNodes(state, length, path);
  accountBytes(state, length === 0 ? 2 : length + 1, path);

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) {
    reject(path, "sparse or decorated arrays are not representable");
  }
  if (ownKeys.some((key) => typeof key === "symbol")) {
    reject(path, "symbol keys are not representable");
  }
  for (const key of ownKeys) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      reject(path, "decorated arrays are not representable");
    }
    const index = parseCanonicalArrayIndex(key);
    if (index === null || index >= length) {
      reject(path, "decorated arrays are not representable");
    }
  }

  const children: unknown[] = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const childPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      reject(childPath, "sparse array elements are not representable");
    }
    if (!("value" in descriptor)) {
      reject(childPath, "accessor properties are not representable");
    }
    if (descriptor.enumerable !== true) {
      reject(childPath, "hidden array elements are not representable");
    }
    if (descriptor.value === undefined) {
      reject(childPath, "array elements must not be undefined");
    }
    children[index] = descriptor.value;
  }

  state.active.add(value);
  frames.push({ kind: "leave", source: value });
  frames.push({ kind: "text", text: "]" });
  for (let index = length - 1; index >= 0; index -= 1) {
    frames.push({
      kind: "value",
      value: children[index],
      path: `${path}[${index}]`,
      depth: containerDepth,
    });
    if (index > 0) {
      frames.push({ kind: "text", text: "," });
    }
  }
  frames.push({ kind: "text", text: "[" });
}

interface ObjectEntry {
  readonly key: string;
  readonly serializedKey: string;
  readonly value: unknown;
  readonly path: string;
}

function serializeObject(
  value: Readonly<Record<string, unknown>>,
  containerDepth: number,
  path: string,
  frames: CanonicalFrame[],
  state: CanonicalState
): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > state.limits.maximumObjectProperties) {
    reject(path, "maximum object property count was exceeded");
  }
  if (ownKeys.some((key) => typeof key === "symbol")) {
    reject(path, "symbol keys are not representable");
  }
  const keys = (ownKeys as string[]).sort();
  reserveNodes(state, keys.length, path);
  accountBytes(state, keys.length === 0 ? 2 : keys.length + 1, path);

  const entries: ObjectEntry[] = [];
  for (let propertyIndex = 0; propertyIndex < keys.length; propertyIndex += 1) {
    const key = keys[propertyIndex];
    if (key === undefined) {
      reject(path, "object traversal ended unexpectedly");
    }
    const childPath = appendObjectPath(path, propertyIndex);
    enforceStringLimit(key, childPath, state.limits);
    const serializedKey = JSON.stringify(key);
    accountBytes(state, Buffer.byteLength(serializedKey, "utf8") + 1, childPath);

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      reject(childPath, "the property disappeared during inspection");
    }
    if (!("value" in descriptor)) {
      reject(childPath, "accessor properties are not representable");
    }
    if (descriptor.enumerable !== true) {
      reject(childPath, "hidden properties are not representable");
    }
    if (descriptor.value === undefined) {
      reject(childPath, "properties must not be undefined; delete the key instead");
    }
    entries.push({
      key,
      serializedKey,
      value: descriptor.value,
      path: childPath,
    });
  }

  state.active.add(value);
  frames.push({ kind: "leave", source: value });
  frames.push({ kind: "text", text: "}" });
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) {
      reject(path, "object traversal ended unexpectedly");
    }
    frames.push({
      kind: "value",
      value: entry.value,
      path: entry.path,
      depth: containerDepth,
    });
    frames.push({ kind: "text", text: ":" });
    frames.push({ kind: "text", text: entry.serializedKey });
    if (index > 0) {
      frames.push({ kind: "text", text: "," });
    }
  }
  frames.push({ kind: "text", text: "{" });
}

function appendScalar(text: string, path: string, state: CanonicalState): void {
  accountBytes(state, Buffer.byteLength(text, "utf8"), path);
  state.chunks.push(text);
}

function reserveNodes(
  state: CanonicalState,
  count: number,
  path: string
): void {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > state.limits.maximumNodes - state.nodes
  ) {
    reject(path, "maximum JSON node count was exceeded");
  }
  state.nodes += count;
}

function accountBytes(
  state: CanonicalState,
  count: number,
  path: string
): void {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count >
      state.limits.maximumCanonicalUtf8Bytes - state.canonicalUtf8Bytes
  ) {
    reject(path, "maximum canonical UTF-8 byte length was exceeded");
  }
  state.canonicalUtf8Bytes += count;
}

function enforceStringLimit(
  value: string,
  path: string,
  limits: Readonly<JsonBoundaryLimits>
): void {
  if (Buffer.byteLength(value, "utf8") > limits.maximumStringUtf8Bytes) {
    reject(path, "maximum string UTF-8 byte length was exceeded");
  }
}

function reject(path: string, reason: string): never {
  const error = createDomainError({
    code: "invalid_input",
    message: `Cannot canonicalize value at ${path}: ${reason}.`,
  });
  INTERNAL_CANONICAL_ERRORS.add(error);
  throw error;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function appendObjectPath(path: string, propertyIndex: number): string {
  return `${path}.<property:${propertyIndex}>`;
}

function parseCanonicalArrayIndex(key: string): number | null {
  if (key === "0") {
    return 0;
  }
  if (!/^[1-9][0-9]*$/.test(key)) {
    return null;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && String(index) === key ? index : null;
}
