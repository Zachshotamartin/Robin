import { isProxy } from "node:util/types";

import { createDomainError } from "@guard/contracts";

import type { BrokerContextSource } from "./context-boundary.js";
import type { ContextSourceDescriptor } from "./context-source.js";
import {
  normalizeContextSourceDescriptor,
  validateNonEmpty,
  validatePositiveVersion,
} from "./context-source-registry.js";

interface RegisteredBrokerSource {
  readonly descriptor: ContextSourceDescriptor;
  readonly source: BrokerContextSource;
}

/** Immutable exact-version registry for strict two-stage context sources. */
export class BrokerContextSourceRegistry {
  readonly #sources: ReadonlyMap<string, RegisteredBrokerSource>;
  readonly #descriptors: readonly ContextSourceDescriptor[];

  constructor(sources: readonly BrokerContextSource[]) {
    const capturedSources = captureSourceArray(sources);
    const registered = new Map<string, RegisteredBrokerSource>();
    const descriptors: ContextSourceDescriptor[] = [];
    for (const candidate of capturedSources) {
      const { source, descriptor } = captureSource(candidate);
      const key = sourceKey(descriptor.sourceId, descriptor.sourceVersion);
      if (registered.has(key)) {
        throw createDomainError({
          code: "conflict",
          message: "A broker source ID and version may be registered only once.",
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
        compareCanonicalStrings(left.sourceId, right.sourceId) ||
        left.sourceVersion - right.sourceVersion,
    );
    this.#sources = registered;
    this.#descriptors = Object.freeze(descriptors);
    Object.freeze(this);
  }

  list(): readonly ContextSourceDescriptor[] {
    return this.#descriptors;
  }

  resolve(sourceId: string, sourceVersion: number): BrokerContextSource {
    validateNonEmpty(sourceId, "sourceId");
    validatePositiveVersion(sourceVersion, "sourceVersion");
    const registered = this.#sources.get(sourceKey(sourceId, sourceVersion));
    if (registered === undefined) {
      throw invalidInput("The requested broker source version is not installed.", {
        sourceId,
        sourceVersion,
      });
    }
    return registered.source;
  }
}

function captureSourceArray(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value) || isProxy(value)) {
      throw new TypeError("not an array");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > 256
    ) {
      throw new TypeError("invalid array length");
    }
    const length = lengthDescriptor.value as number;
    const allowed = new Set<PropertyKey>([
      "length",
      ...Array.from({ length }, (_item, index) => String(index)),
    ]);
    if (Reflect.ownKeys(value).some((key) => !allowed.has(key))) {
      throw new TypeError("unknown array property");
    }
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new TypeError("sparse or accessor array element");
      }
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    throw invalidInput(
      "Broker context sources must be a bounded dense array of data properties.",
    );
  }
}

function captureSource(value: unknown): RegisteredBrokerSource {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value)
    ) {
      throw new TypeError("not a trusted source");
    }
    const descriptor = normalizeContextSourceDescriptor(
      readDataProperty(value, "descriptor"),
    );
    const normalize = readDataProperty(value, "normalizeResourceRequest");
    const inspect = readDataProperty(value, "inspectMetadata");
    const open = readDataProperty(value, "openBounded");
    for (const handler of [normalize, inspect, open]) {
      if (typeof handler !== "function" || isProxy(handler)) {
        throw new TypeError("source handler is not a direct function");
      }
    }
    const normalizeHandler = normalize as BrokerContextSource["normalizeResourceRequest"];
    const inspectHandler = inspect as BrokerContextSource["inspectMetadata"];
    const openHandler = open as BrokerContextSource["openBounded"];
    const source: BrokerContextSource = Object.freeze({
      descriptor,
      normalizeResourceRequest: normalizeHandler.bind(value),
      inspectMetadata: inspectHandler.bind(value),
      openBounded: openHandler.bind(value),
    });
    return Object.freeze({ source, descriptor });
  } catch {
    throw invalidInput(
      "A broker context source must be trusted installed code with direct handlers.",
    );
  }
}

function readDataProperty(value: object, key: string): unknown {
  let current: object | null = value;
  while (current !== null) {
    if (isProxy(current)) throw new TypeError("proxy in source prototype chain");
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) throw new TypeError("source accessor property");
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new TypeError("missing source property");
}

function sourceKey(sourceId: string, sourceVersion: number): string {
  return `${sourceId}\u0000${String(sourceVersion)}`;
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
