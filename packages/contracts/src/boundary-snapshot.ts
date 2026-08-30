import { isProxy } from "node:util/types";

import type { JsonObject, JsonValue } from "./json-value.js";

/**
 * Hard resource ceilings shared by descriptor-only JSON snapshots and
 * canonical JSON serialization. A node is any scalar, array, or object. Depth
 * counts containers, so a root object has depth one and a scalar has depth
 * zero. String limits apply to both values and object-property names.
 */
export interface JsonBoundaryLimits {
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  readonly maximumArrayLength: number;
  readonly maximumObjectProperties: number;
  readonly maximumStringUtf8Bytes: number;
  readonly maximumCanonicalUtf8Bytes: number;
}

/** Descriptor-only, immutable overrides for JSON boundary resource ceilings. */
export type JsonBoundaryLimitOptions = Readonly<Partial<JsonBoundaryLimits>>;

/**
 * Defaults are intentionally finite and conservative enough for contracts,
 * events, schemas, and capability payloads while bounding CPU and allocation.
 */
export const DEFAULT_JSON_BOUNDARY_LIMITS: Readonly<JsonBoundaryLimits> =
  Object.freeze({
    maximumDepth: 64,
    maximumNodes: 100_000,
    maximumArrayLength: 10_000,
    maximumObjectProperties: 10_000,
    maximumStringUtf8Bytes: 1_048_576,
    maximumCanonicalUtf8Bytes: 8_388_608,
  });

const LIMIT_KEYS = Object.freeze([
  "maximumDepth",
  "maximumNodes",
  "maximumArrayLength",
  "maximumObjectProperties",
  "maximumStringUtf8Bytes",
  "maximumCanonicalUtf8Bytes",
] as const);

type LimitKey = (typeof LIMIT_KEYS)[number];
const LIMIT_KEY_SET: ReadonlySet<string> = new Set(LIMIT_KEYS);
type MutableJsonBoundaryLimits = {
  -readonly [Key in keyof JsonBoundaryLimits]: JsonBoundaryLimits[Key];
};

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
 * make later property reads trustworthy. Traversal is iterative, so an input
 * deeper than the configured ceiling is rejected without consuming the call
 * stack.
 */
export function snapshotBoundaryJsonObject(
  value: unknown,
  options?: JsonBoundaryLimitOptions
): JsonObject {
  try {
    const limits = resolveJsonBoundaryLimits(options);
    const state: SnapshotState = {
      active: new WeakSet<object>(),
      canonicalUtf8Bytes: 0,
      limits,
      nodes: 0,
      root: undefined,
    };
    reserveNodes(state, 1);

    const frames: SnapshotFrame[] = [
      { kind: "visit", value, depth: 0 },
    ];
    while (frames.length > 0) {
      const frame = frames.pop();
      if (frame === undefined) {
        fail();
      }
      if (frame.kind === "leave") {
        state.active.delete(frame.source);
        continue;
      }
      if (frame.kind === "freeze") {
        Object.freeze(frame.target);
        continue;
      }
      visitSnapshotValue(frame, frames, state);
    }

    if (!isRecord(state.root)) {
      fail();
    }
    return state.root;
  } catch {
    throw new BoundarySnapshotError();
  }
}

/**
 * Resolves options without invoking accessors or proxy traps. This helper is
 * exported for the canonical serializer in this package, but is deliberately
 * not part of the package's public barrel.
 */
export function resolveJsonBoundaryLimits(
  options: JsonBoundaryLimitOptions | undefined
): Readonly<JsonBoundaryLimits> {
  if (options === undefined) {
    return DEFAULT_JSON_BOUNDARY_LIMITS;
  }
  if (typeof options !== "object" || options === null || isProxy(options)) {
    fail();
  }
  const prototype: unknown = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    fail();
  }

  const keys = Reflect.ownKeys(options);
  if (
    keys.length > LIMIT_KEYS.length ||
    keys.some((key) => typeof key !== "string" || !LIMIT_KEY_SET.has(key))
  ) {
    fail();
  }

  const resolved: MutableJsonBoundaryLimits = {
    ...DEFAULT_JSON_BOUNDARY_LIMITS,
  };
  for (const key of keys) {
    if (typeof key !== "string" || !LIMIT_KEY_SET.has(key)) {
      fail();
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "number" ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value <= 0
    ) {
      fail();
    }
    resolved[key as LimitKey] = descriptor.value;
  }
  return Object.freeze(resolved);
}

interface SnapshotState {
  readonly active: WeakSet<object>;
  canonicalUtf8Bytes: number;
  readonly limits: Readonly<JsonBoundaryLimits>;
  nodes: number;
  root: JsonValue | undefined;
}

type MutableSnapshotContainer = JsonValue[] | Record<string, JsonValue>;

interface VisitFrame {
  readonly kind: "visit";
  readonly value: unknown;
  readonly depth: number;
  readonly parent?: MutableSnapshotContainer;
  readonly key?: string | number;
}

interface FreezeFrame {
  readonly kind: "freeze";
  readonly target: MutableSnapshotContainer;
}

interface LeaveFrame {
  readonly kind: "leave";
  readonly source: object;
}

type SnapshotFrame = VisitFrame | FreezeFrame | LeaveFrame;

function visitSnapshotValue(
  frame: VisitFrame,
  frames: SnapshotFrame[],
  state: SnapshotState
): void {
  const { value } = frame;
  if (value === null) {
    accountCanonicalBytes(state, 4);
    attachSnapshot(frame, state, null);
    return;
  }
  if (typeof value === "boolean") {
    accountCanonicalBytes(state, value ? 4 : 5);
    attachSnapshot(frame, state, value);
    return;
  }
  if (typeof value === "string") {
    enforceStringLimit(value, state.limits);
    accountCanonicalBytes(state, jsonStringUtf8ByteLength(value));
    attachSnapshot(frame, state, value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail();
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      fail();
    }
    accountCanonicalBytes(state, Buffer.byteLength(serialized, "utf8"));
    attachSnapshot(frame, state, value);
    return;
  }
  if (typeof value !== "object" || isProxy(value)) {
    fail();
  }

  const containerDepth = frame.depth + 1;
  if (containerDepth > state.limits.maximumDepth || state.active.has(value)) {
    fail();
  }

  if (Array.isArray(value)) {
    snapshotArray(value, containerDepth, frame, frames, state);
    return;
  }
  snapshotObject(
    value as Readonly<Record<string, unknown>>,
    containerDepth,
    frame,
    frames,
    state
  );
}

function snapshotArray(
  value: readonly unknown[],
  containerDepth: number,
  frame: VisitFrame,
  frames: SnapshotFrame[],
  state: SnapshotState
): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fail();
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
    fail();
  }
  const length = lengthDescriptor.value;
  if (length > state.limits.maximumArrayLength) {
    fail();
  }
  reserveNodes(state, length);
  accountCanonicalBytes(state, length === 0 ? 2 : length + 1);

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    keys.some((key) => typeof key !== "string")
  ) {
    fail();
  }
  for (const key of keys) {
    if (key === "length") {
      continue;
    }
    const index = typeof key === "string" ? parseCanonicalArrayIndex(key) : null;
    if (index === null || index >= length) {
      fail();
    }
  }

  const children: unknown[] = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.value === undefined
    ) {
      fail();
    }
    children[index] = descriptor.value;
  }

  const target: JsonValue[] = new Array(length);
  attachSnapshot(frame, state, target);
  state.active.add(value);
  frames.push({ kind: "leave", source: value });
  frames.push({ kind: "freeze", target });
  for (let index = length - 1; index >= 0; index -= 1) {
    frames.push({
      kind: "visit",
      value: children[index],
      depth: containerDepth,
      parent: target,
      key: index,
    });
  }
}

function snapshotObject(
  value: Readonly<Record<string, unknown>>,
  containerDepth: number,
  frame: VisitFrame,
  frames: SnapshotFrame[],
  state: SnapshotState
): void {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail();
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length > state.limits.maximumObjectProperties ||
    keys.some((key) => typeof key !== "string")
  ) {
    fail();
  }
  const stringKeys = keys as string[];
  reserveNodes(state, stringKeys.length);
  accountCanonicalBytes(
    state,
    stringKeys.length === 0 ? 2 : stringKeys.length + 1
  );

  const children: unknown[] = new Array(stringKeys.length);
  for (let index = 0; index < stringKeys.length; index += 1) {
    const key = stringKeys[index];
    if (key === undefined) {
      fail();
    }
    enforceStringLimit(key, state.limits);
    accountCanonicalBytes(state, jsonStringUtf8ByteLength(key) + 1);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.value === undefined
    ) {
      fail();
    }
    children[index] = descriptor.value;
  }

  const target: Record<string, JsonValue> = {};
  attachSnapshot(frame, state, target);
  state.active.add(value);
  frames.push({ kind: "leave", source: value });
  frames.push({ kind: "freeze", target });
  for (let index = stringKeys.length - 1; index >= 0; index -= 1) {
    const key = stringKeys[index];
    if (key === undefined) {
      fail();
    }
    frames.push({
      kind: "visit",
      value: children[index],
      depth: containerDepth,
      parent: target,
      key,
    });
  }
}

function attachSnapshot(
  frame: VisitFrame,
  state: SnapshotState,
  value: JsonValue
): void {
  if (frame.parent === undefined) {
    state.root = value;
    return;
  }
  if (Array.isArray(frame.parent)) {
    if (typeof frame.key !== "number") {
      fail();
    }
    frame.parent[frame.key] = value;
    return;
  }
  if (typeof frame.key !== "string") {
    fail();
  }
  Object.defineProperty(frame.parent, frame.key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

function reserveNodes(state: SnapshotState, count: number): void {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > state.limits.maximumNodes - state.nodes
  ) {
    fail();
  }
  state.nodes += count;
}

function accountCanonicalBytes(state: SnapshotState, count: number): void {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count >
      state.limits.maximumCanonicalUtf8Bytes - state.canonicalUtf8Bytes
  ) {
    fail();
  }
  state.canonicalUtf8Bytes += count;
}

function enforceStringLimit(
  value: string,
  limits: Readonly<JsonBoundaryLimits>
): void {
  if (Buffer.byteLength(value, "utf8") > limits.maximumStringUtf8Bytes) {
    fail();
  }
}

/** Exact UTF-8 byte length of JSON.stringify(value), without allocating it. */
function jsonStringUtf8ByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes += 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
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

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(): never {
  throw new BoundarySnapshotError();
}
