import { isProxy } from "node:util/types";

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;
const MAXIMUM_TREE_DEPTH = 2_048;
const MAXIMUM_TREE_NODES = 200_000;
const MAXIMUM_RECORD_PROPERTIES = 32;

interface VisitFrame {
  readonly kind: "visit";
  readonly value: unknown;
  readonly depth: number;
}

interface LeaveFrame {
  readonly kind: "leave";
  readonly value: object;
}

type TreeFrame = VisitFrame | LeaveFrame;

/**
 * Prove that an AST-like graph is finite descriptor-only data before any
 * formatter property read. Shared acyclic nodes are allowed; cycles are not.
 */
export function assertPlainDataTree(value: unknown, label: string): void {
  try {
    const active = new WeakSet<object>();
    const frames: TreeFrame[] = [{ kind: "visit", value, depth: 0 }];
    let nodes = 0;
    while (frames.length > 0) {
      const frame = frames.pop();
      if (frame === undefined) {
        throw new TypeError();
      }
      if (frame.kind === "leave") {
        active.delete(frame.value);
        continue;
      }
      nodes += 1;
      if (nodes > MAXIMUM_TREE_NODES || frame.depth > MAXIMUM_TREE_DEPTH) {
        throw new TypeError();
      }
      const current = frame.value;
      if (
        current === null || typeof current === "string" ||
        typeof current === "boolean"
      ) {
        continue;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current)) {
          throw new TypeError();
        }
        continue;
      }
      if (typeof current !== "object" || isProxy(current) || active.has(current)) {
        throw new TypeError();
      }
      const prototype: unknown = Object.getPrototypeOf(current);
      const array = Array.isArray(current);
      if (
        (array && prototype !== Array.prototype) ||
        (!array && prototype !== Object.prototype && prototype !== null)
      ) {
        throw new TypeError();
      }
      active.add(current);
      frames.push({ kind: "leave", value: current });
      const keys = Reflect.ownKeys(current);
      if (
        !array &&
        (keys.length > MAXIMUM_RECORD_PROPERTIES ||
          keys.some((key) => typeof key !== "string"))
      ) {
        throw new TypeError();
      }
      const length = array ? (current as readonly unknown[]).length : -1;
      if (
        array &&
        (keys.length !== length + 1 || keys.some((key) =>
          typeof key !== "string" ||
          (key !== "length" && (!ARRAY_INDEX.test(key) || Number(key) >= length))))
      ) {
        throw new TypeError();
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (
          descriptor === undefined || !("value" in descriptor) ||
          (descriptor.enumerable !== true && !(array && key === "length"))
        ) {
          throw new TypeError();
        }
        if (key !== "length") {
          frames.push({ kind: "visit", value: descriptor.value, depth: frame.depth + 1 });
        }
      }
    }
  } catch {
    throw new TypeError(`${label} must be a finite plain-data tree without accessors or proxies.`);
  }
}

/** Capture an options-style object without invoking caller-controlled code. */
export function captureOptionalDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  return captureDataRecord(value, allowedKeys, false, label);
}

/** Capture an AST record whose enumerable data keys must match exactly. */
export function captureExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  return captureDataRecord(value, expectedKeys, true, label);
}

/** Capture a dense undecorated ordinary array through own data descriptors. */
export function captureDataArray(value: unknown, label: string): readonly unknown[] {
  try {
    if (
      typeof value !== "object" || value === null || isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    ) {
      throw new TypeError();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.enumerable === true
    ) {
      throw new TypeError();
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1 ||
      keys.some((key) =>
        typeof key !== "string" ||
        (key !== "length" && (!ARRAY_INDEX.test(key) || Number(key) >= length)))
    ) {
      throw new TypeError();
    }
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined || !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError();
      }
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    throw new TypeError(`${label} must be a dense plain data array.`);
  }
}

function captureDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  requireAll: boolean,
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      isProxy(value)
    ) {
      throw new TypeError();
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError();
    }
    const allowed = new Set(expectedKeys);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      (requireAll && keys.length !== expectedKeys.length)
    ) {
      throw new TypeError();
    }
    const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new TypeError();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined || !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError();
      }
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    throw new TypeError(`${label} must contain only the expected enumerable data properties.`);
  }
}
