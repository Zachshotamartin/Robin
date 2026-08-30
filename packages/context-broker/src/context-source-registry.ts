import { isProxy } from "node:util/types";

import { createDomainError } from "@guard/contracts";
import type { JsonObject } from "@guard/contracts";

import type { ContextSource, ContextSourceDescriptor } from "./context-source.js";
import { snapshotBoundaryObject } from "./immutable.js";

interface RegisteredSource {
  readonly source: ContextSource;
  readonly descriptor: ContextSourceDescriptor;
}

/**
 * Immutable exact-version registry for installed trusted context sources.
 * Source methods are executable installation code, not serializable boundary
 * data. Registration inspects their data descriptors without invoking them and
 * snapshots only the source's JSON descriptor.
 */
export class ContextSourceRegistry {
  readonly #sources: ReadonlyMap<string, RegisteredSource>;
  readonly #descriptors: readonly ContextSourceDescriptor[];

  constructor(sources: readonly ContextSource[]) {
    const installedSources = inspectTrustedArray(
      sources,
      "Context sources must be supplied as a dense array.",
    );

    const registered = new Map<string, RegisteredSource>();
    const descriptors: ContextSourceDescriptor[] = [];
    for (const candidate of installedSources) {
      const { source, descriptor } = inspectContextSource(candidate);
      const key = sourceKey(descriptor.sourceId, descriptor.sourceVersion);
      if (registered.has(key)) {
        throw createDomainError({
          code: "conflict",
          message: "A context-source ID and version may be registered only once.",
          details: {
            sourceId: descriptor.sourceId,
            sourceVersion: descriptor.sourceVersion,
          },
        });
      }
      registered.set(key, Object.freeze({ source, descriptor }));
      descriptors.push(descriptor);
    }

    descriptors.sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        left.sourceVersion - right.sourceVersion,
    );
    this.#sources = registered;
    this.#descriptors = Object.freeze(descriptors);
    Object.freeze(this);
  }

  list(): readonly ContextSourceDescriptor[] {
    return this.#descriptors;
  }

  resolve(sourceId: string, sourceVersion: number): ContextSource {
    validateNonEmpty(sourceId, "sourceId");
    validatePositiveVersion(sourceVersion, "sourceVersion");
    const registered = this.#sources.get(sourceKey(sourceId, sourceVersion));
    if (registered === undefined) {
      throw invalidInput("The requested context-source version is not installed.", {
        sourceId,
        sourceVersion,
      });
    }
    return registered.source;
  }
}

function inspectContextSource(value: unknown): RegisteredSource {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      isProxy(value) ||
      Array.isArray(value)
    ) {
      throw new TypeError("not an installable source object");
    }
    const descriptorValue = readDataProperty(value, "descriptor");
    const normalizeRequest = readDataProperty(value, "normalizeRequest");
    const readBounded = readDataProperty(value, "readBounded");
    if (
      typeof normalizeRequest !== "function" ||
      typeof readBounded !== "function" ||
      isProxy(normalizeRequest) ||
      isProxy(readBounded)
    ) {
      throw new TypeError("source handlers must be direct functions");
    }
    const source = value as ContextSource;
    const descriptor = normalizeContextSourceDescriptor(descriptorValue);
    return Object.freeze({ source, descriptor });
  } catch {
    throw invalidInput(
      "A context source must be trusted installed code with data-property handlers and a valid descriptor.",
    );
  }
}

export function normalizeContextSourceDescriptor(
  descriptor: unknown,
): ContextSourceDescriptor {
  const detached = snapshotBoundaryObject(
    descriptor,
    "Context-source descriptor",
  );
  return parseDetachedDescriptor(detached);
}

export function validateDescriptor(descriptor: ContextSourceDescriptor): void {
  normalizeContextSourceDescriptor(descriptor);
}

export function parseDetachedDescriptor(
  descriptor: JsonObject,
): ContextSourceDescriptor {
  const keys = Object.keys(descriptor);
  if (
    keys.length !== 4 ||
    !keys.includes("sourceId") ||
    !keys.includes("sourceVersion") ||
    !keys.includes("scheme") ||
    !keys.includes("description")
  ) {
    throw invalidInput("A context-source descriptor contains unknown or missing properties.");
  }
  const sourceId = descriptor["sourceId"];
  const sourceVersion = descriptor["sourceVersion"];
  const description = descriptor["description"];
  const scheme = descriptor["scheme"];
  validateNonEmpty(sourceId, "sourceId");
  validatePositiveVersion(sourceVersion, "sourceVersion");
  validateNonEmpty(description, "description");
  if (
    typeof scheme !== "string" ||
    !/^[a-z][a-z0-9+.-]*$/u.test(scheme)
  ) {
    throw invalidInput("A context-source scheme must use canonical lowercase URI syntax.");
  }
  return Object.freeze({ sourceId, sourceVersion, scheme, description });
}

export function validateNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput(`${field} must be a non-empty string.`);
  }
}

export function validatePositiveVersion(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidInput(`${field} must be a positive safe integer.`);
  }
}

function sourceKey(sourceId: string, sourceVersion: number): string {
  return `${sourceId}\u0000${String(sourceVersion)}`;
}

function readDataProperty(value: object, key: string): unknown {
  let current: object | null = value;
  while (current !== null) {
    if (isProxy(current)) {
      throw new TypeError("proxy in executable prototype chain");
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw new TypeError("executable accessor property");
      }
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new TypeError("missing executable data property");
}

function inspectTrustedArray(value: unknown, message: string): readonly unknown[] {
  try {
    if (typeof value !== "object" || value === null || isProxy(value)) {
      throw new TypeError("not an array value");
    }
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("not a plain array");
    }
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      keys.some((key) => typeof key !== "string") ||
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      keys.length !== lengthDescriptor.value + 1
    ) {
      throw new TypeError("not a dense array");
    }
    const result: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("array element is not a data property");
      }
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    throw invalidInput(message);
  }
}

function invalidInput(
  message: string,
  details?: Readonly<Record<string, unknown>>,
) {
  return createDomainError({
    code: "invalid_input",
    message,
    ...(details === undefined ? {} : { details }),
  });
}
