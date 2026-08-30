import { createHash } from "node:crypto";

import { createDomainError } from "./errors.js";

/**
 * Canonical JSON per the implementation guide: UTF-8, lexicographically sorted
 * object keys, order-preserving arrays, finite numbers only, and an explicit
 * distinction between absent and null — an `undefined` property or element is
 * an error rather than a silent omission. Only null, booleans, finite numbers,
 * strings, arrays, and plain objects are accepted; everything else fails
 * closed so approval and idempotency hashes never depend on ambiguous input.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, "$", new Set());
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

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
    if (Array.isArray(value)) {
      return serializeArray(value, path, seen);
    }
    if (!isPlainObject(value)) {
      reject(path, "only plain objects and arrays are representable");
    }
    return serializeObject(value as Record<string, unknown>, path, seen);
  } finally {
    seen.delete(value);
  }
}

function serializeArray(value: readonly unknown[], path: string, seen: Set<object>): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const element = value[index];
    if (element === undefined) {
      reject(`${path}[${index}]`, "array elements must not be undefined");
    }
    parts.push(serialize(element, `${path}[${index}]`, seen));
  }
  return `[${parts.join(",")}]`;
}

function serializeObject(
  value: Readonly<Record<string, unknown>>,
  path: string,
  seen: Set<object>
): string {
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = value[key];
    const childPath = path === "$" ? `$.${key}` : `${path}.${key}`;
    if (child === undefined) {
      reject(childPath, "properties must not be undefined; delete the key instead");
    }
    parts.push(`${JSON.stringify(key)}:${serialize(child, childPath, seen)}`);
  }
  return `{${parts.join(",")}}`;
}
