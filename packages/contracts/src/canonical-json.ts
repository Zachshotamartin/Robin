import { createHash } from "node:crypto";

import { createDomainError, isDomainError } from "./errors.js";

/**
 * Canonical JSON per the implementation guide: UTF-8, lexicographically sorted
 * object keys, order-preserving arrays, finite numbers only, and an explicit
 * distinction between absent and null — an `undefined` property or element is
 * an error rather than a silent omission. Only null, booleans, finite numbers,
 * strings, arrays, and plain objects are accepted; everything else fails
 * closed so approval and idempotency hashes never depend on ambiguous input.
 */
export function canonicalize(value: unknown): string {
  try {
    return serialize(value, "$", new Set());
  } catch (error: unknown) {
    if (isDomainError(error)) {
      throw error;
    }
    return reject("$", "the value could not be inspected safely");
  }
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalSha256Hex(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

function reject(path: string, reason: string): never {
  throw createDomainError({
    code: "invalid_input",
    message: `Cannot canonicalize value at ${path}: ${reason}.`,
  });
}

function isPlainObject(value: object, path: string): boolean {
  const prototype = inspect(path, () => Object.getPrototypeOf(value));
  return prototype === Object.prototype || prototype === null;
}

function inspect<T>(path: string, operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (isDomainError(error)) {
      throw error;
    }
    return reject(path, "the value could not be inspected safely");
  }
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        reject(path, "numbers must be finite");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "undefined":
      reject(path, "undefined is not representable; omit the value instead");
      break;
    case "bigint":
      reject(path, "bigint is not representable; use a string or integer");
      break;
    case "object":
      return serializeContainer(value, path, seen);
    default:
      reject(path, `type ${typeof value} is not representable`);
  }
}

function serializeContainer(value: object, path: string, seen: Set<object>): string {
  if (seen.has(value)) {
    reject(path, "cyclic references are not representable");
  }
  seen.add(value);

  try {
    if (inspect(path, () => Array.isArray(value))) {
      return serializeArray(value as readonly unknown[], path, seen);
    }
    if (!isPlainObject(value, path)) {
      reject(path, "only plain objects and arrays are representable");
    }
    return serializeObject(value as Record<string, unknown>, path, seen);
  } finally {
    seen.delete(value);
  }
}

function serializeArray(value: readonly unknown[], path: string, seen: Set<object>): string {
  const ownKeys = inspect(path, () => Reflect.ownKeys(value));
  if (ownKeys.some((key) => typeof key === "symbol")) {
    reject(path, "symbol keys are not representable");
  }

  const lengthDescriptor = inspect(path, () =>
    Object.getOwnPropertyDescriptor(value, "length")
  );
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
  if (ownKeys.length !== length + 1) {
    reject(path, "sparse or decorated arrays are not representable");
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

  const parts: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const childPath = `${path}[${index}]`;
    const descriptor = inspect(childPath, () =>
      Object.getOwnPropertyDescriptor(value, String(index))
    );
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
    parts.push(serialize(descriptor.value, childPath, seen));
  }
  return `[${parts.join(",")}]`;
}

function serializeObject(
  value: Readonly<Record<string, unknown>>,
  path: string,
  seen: Set<object>
): string {
  const ownKeys = inspect(path, () => Reflect.ownKeys(value));
  if (ownKeys.some((key) => typeof key === "symbol")) {
    reject(path, "symbol keys are not representable");
  }
  const keys = (ownKeys as string[]).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const childPath = appendObjectPath(path, key);
    const descriptor = inspect(childPath, () =>
      Object.getOwnPropertyDescriptor(value, key)
    );
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
    parts.push(
      `${JSON.stringify(key)}:${serialize(descriptor.value, childPath, seen)}`
    );
  }
  return `{${parts.join(",")}}`;
}

function appendObjectPath(path: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return `${path}.${key}`;
  }
  return `${path}[${JSON.stringify(key)}]`;
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
