/** The exact data domain accepted at durable and adapter boundaries. */
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonArray = readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * Checks the lossless JSON data domain. Unlike JSON.stringify, this rejects
 * values that would be omitted, coerced, invoke accessors, or lose structure.
 * A recursion-stack WeakSet rejects cycles while still allowing shared DAGs.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return inspectJsonValue(value, new WeakSet<object>());
  } catch {
    return false;
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  try {
    return isPlainObject(value) && inspectJsonObject(value, new WeakSet<object>());
  } catch {
    return false;
  }
}

/**
 * Validates, copies, and deeply freezes a JSON object. Copying prevents a
 * caller-held alias from mutating a supposedly immutable domain value.
 */
export function cloneAndFreezeJsonObject(
  value: Readonly<Record<string, unknown>>,
  label = "JSON object"
): JsonObject {
  try {
    if (!isPlainObject(value)) {
      throw new TypeError(`${label} must be a plain object.`);
    }
    return cloneObject(value, "$", new WeakSet<object>(), label);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw error;
    }
    throw new TypeError(`${label} is not valid JSON data.`, { cause: error });
  }
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inspectJsonValue(value: unknown, stack: WeakSet<object>): boolean {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (stack.has(value)) {
    return false;
  }
  stack.add(value);
  try {
    return Array.isArray(value)
      ? inspectJsonArray(value, stack)
      : isPlainObject(value) && inspectJsonObject(value, stack);
  } finally {
    stack.delete(value);
  }
}

function inspectJsonArray(value: readonly unknown[], stack: WeakSet<object>): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    return false;
  }
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return false;
    }
    if (!inspectJsonValue(descriptor.value, stack)) {
      return false;
    }
  }
  return true;
}

function inspectJsonObject(
  value: Readonly<Record<string, unknown>>,
  stack: WeakSet<object>
): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return false;
    }
    if (!inspectJsonValue(descriptor.value, stack)) {
      return false;
    }
  }
  return true;
}

function cloneValue(
  value: unknown,
  path: string,
  stack: WeakSet<object>,
  label: string
): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} contains a non-finite number at ${path}.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${label} contains non-JSON type ${typeof value} at ${path}.`);
  }
  if (stack.has(value)) {
    throw new TypeError(`${label} contains a cyclic reference at ${path}.`);
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return cloneArray(value, path, stack, label);
    }
    if (!isPlainObject(value)) {
      throw new TypeError(`${label} contains a non-plain object at ${path}.`);
    }
    return cloneObject(value, path, stack, label);
  } finally {
    stack.delete(value);
  }
}

function cloneArray(
  value: readonly unknown[],
  path: string,
  stack: WeakSet<object>,
  label: string
): JsonArray {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== value.length + 1 ||
    !keys.includes("length")
  ) {
    throw new TypeError(`${label} contains a sparse or decorated array at ${path}.`);
  }
  const result: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} contains an accessor or hole at ${path}[${index}].`);
    }
    result.push(cloneValue(descriptor.value, `${path}[${index}]`, stack, label));
  }
  return Object.freeze(result);
}

function cloneObject(
  value: Readonly<Record<string, unknown>>,
  path: string,
  stack: WeakSet<object>,
  label: string
): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} contains a symbol key at ${path}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} contains an accessor or hidden property at ${path}.${key}.`);
    }
    Object.defineProperty(result, key, {
      value: cloneValue(descriptor.value, `${path}.${key}`, stack, label),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Object.freeze(result);
}
