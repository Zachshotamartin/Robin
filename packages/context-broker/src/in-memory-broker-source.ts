import {
  CONTRACT_SCHEMA_VERSION,
  createDomainError,
  sha256Hex,
} from "@guard/contracts";
import type { JsonObject, ResourceRef } from "@guard/contracts";

import type {
  BrokerContextSource,
  ContextResourceMetadata,
  NormalizedResourceRequest,
  OpenedContextResource,
  SourceReadBudget,
} from "./context-boundary.js";
import type { ContextSourceDescriptor } from "./context-source.js";
import {
  parseDetachedDescriptor,
  validateNonEmpty,
  validatePositiveVersion,
} from "./context-source-registry.js";
import { snapshot, snapshotBoundaryObject } from "./immutable.js";
import { MEMORY_POLICY_ATTRIBUTE_CATALOG } from "./policy-catalog.js";
import { canonicalizeResourceRef, resourceRefsEqual } from "./resource-ref.js";

export interface InMemoryBrokerRecordInput {
  readonly recordId: string;
  readonly content: string;
  readonly mediaType?: string;
  readonly classification?: string;
}

export interface InMemoryBrokerSourceOptions {
  readonly descriptor: ContextSourceDescriptor;
  readonly records: readonly InMemoryBrokerRecordInput[];
  readonly maximumRecords: number;
  readonly maximumRecordBytes: number;
}

interface StoredRecord {
  readonly recordId: string;
  readonly content: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly classification: string;
  readonly contentHash: string;
}

/** Non-filesystem source proving that the broker pipeline is domain-neutral. */
export class InMemoryBrokerSource implements BrokerContextSource {
  readonly descriptor: ContextSourceDescriptor;
  readonly #records: ReadonlyMap<string, StoredRecord>;

  constructor(options: InMemoryBrokerSourceOptions) {
    const detached = snapshotBoundaryObject(options, "In-memory broker source");
    if (
      !hasExactKeys(detached, [
        "descriptor",
        "records",
        "maximumRecords",
        "maximumRecordBytes",
      ])
    ) {
      throw invalidInput("In-memory broker source options are incomplete or unknown.");
    }
    const descriptorValue = detached["descriptor"];
    if (!isPlainObject(descriptorValue)) {
      throw invalidInput("An in-memory broker source descriptor must be an object.");
    }
    const descriptor = parseDetachedDescriptor(descriptorValue);
    const maximumRecords = detached["maximumRecords"];
    const maximumRecordBytes = detached["maximumRecordBytes"];
    validatePositiveVersion(maximumRecords, "maximumRecords");
    validatePositiveVersion(maximumRecordBytes, "maximumRecordBytes");
    const recordInputs = detached["records"];
    if (!Array.isArray(recordInputs) || recordInputs.length > maximumRecords) {
      throw invalidInput("In-memory broker records exceed their configured bound.");
    }

    const records = new Map<string, StoredRecord>();
    for (const candidate of recordInputs) {
      if (!isPlainObject(candidate)) {
        throw invalidInput("An in-memory broker record must be an object.");
      }
      const record = parseRecord(candidate, maximumRecordBytes);
      if (records.has(record.recordId)) {
        throw createDomainError({
          code: "conflict",
          message: "An in-memory broker record ID may appear only once.",
        });
      }
      records.set(record.recordId, record);
    }
    this.descriptor = descriptor;
    this.#records = records;
    Object.freeze(this);
  }

  normalizeResourceRequest(input: unknown): NormalizedResourceRequest {
    const detached = snapshotBoundaryObject(input, "In-memory resource request");
    if (!hasExactKeys(detached, ["recordId"])) {
      throw invalidInput("An in-memory resource request accepts only recordId.");
    }
    const recordId = detached["recordId"];
    validateNonEmpty(recordId, "recordId");
    const record = this.#records.get(recordId);
    if (record === undefined) {
      throw invalidInput("The requested in-memory resource does not exist.");
    }
    return snapshot({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sourceId: this.descriptor.sourceId,
      sourceVersion: this.descriptor.sourceVersion,
      resource: resourceFor(this.descriptor, record),
      selector: null,
    });
  }

  async inspectMetadata(
    request: NormalizedResourceRequest,
    signal: AbortSignal,
  ): Promise<ContextResourceMetadata> {
    assertNotAborted(signal);
    const record = this.#resolveRequest(request);
    return snapshot({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sourceId: this.descriptor.sourceId,
      sourceVersion: this.descriptor.sourceVersion,
      resource: resourceFor(this.descriptor, record),
      selector: null,
      byteLength: record.bytes.byteLength,
      selectedByteLength: record.bytes.byteLength,
      mediaType: record.mediaType,
      classification: record.classification,
      kind: "record" as const,
      policyProjection: policyProjection(record),
      binding: {
        contentHash: record.contentHash,
        byteLength: record.bytes.byteLength,
      },
    });
  }

  async openBounded(
    request: NormalizedResourceRequest,
    expected: ContextResourceMetadata,
    budget: SourceReadBudget,
    signal: AbortSignal,
  ): Promise<OpenedContextResource> {
    assertNotAborted(signal);
    const record = this.#resolveRequest(request);
    validateReadBudget(budget);
    const metadata = await this.inspectMetadata(request, signal);
    if (!metadataMatches(metadata, expected)) {
      throw createDomainError({
        code: "conflict",
        message: "The in-memory resource changed between metadata and read.",
      });
    }
    const maximumBytes = Math.min(budget.maximumBytes, record.bytes.byteLength);
    const bounded = completeUtf8Prefix(record.bytes, maximumBytes);
    const bytes = Uint8Array.from(bounded);
    assertNotAborted(signal);
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sourceId: this.descriptor.sourceId,
      sourceVersion: this.descriptor.sourceVersion,
      resource: resourceFor(this.descriptor, record),
      policyProjection: policyProjection(record),
      selector: null,
      mediaType: record.mediaType,
      classification: record.classification,
      binding: metadata.binding,
      bytes,
      byteLength: bytes.byteLength,
      contentHash: sha256Hex(bytes),
      selectionComplete: bytes.byteLength === record.bytes.byteLength,
      truncated: bytes.byteLength < record.bytes.byteLength,
    });
  }

  #resolveRequest(request: NormalizedResourceRequest): StoredRecord {
    const detached = snapshotBoundaryObject(request, "Normalized resource request");
    if (
      !hasExactKeys(detached, [
        "schemaVersion",
        "sourceId",
        "sourceVersion",
        "resource",
        "selector",
      ]) ||
      detached["schemaVersion"] !== CONTRACT_SCHEMA_VERSION ||
      detached["sourceId"] !== this.descriptor.sourceId ||
      detached["sourceVersion"] !== this.descriptor.sourceVersion ||
      detached["selector"] !== null
    ) {
      throw invalidInput("A normalized request does not match this in-memory source.");
    }
    const resource = canonicalizeResourceRef(detached["resource"], {
      scheme: this.descriptor.scheme,
      sourceId: this.descriptor.sourceId,
    });
    const recordId = resource.locator["recordId"];
    if (
      Object.keys(resource.locator).length !== 1 ||
      typeof recordId !== "string"
    ) {
      throw invalidInput("An in-memory resource locator is malformed.");
    }
    const record = this.#records.get(recordId);
    if (record === undefined || !resourceRefsEqual(resource, resourceFor(this.descriptor, record))) {
      throw invalidInput("An in-memory resource reference is stale or unknown.");
    }
    return record;
  }
}

function parseRecord(input: JsonObject, maximumBytes: number): StoredRecord {
  if (
    !hasAllowedKeys(input, ["recordId", "content", "mediaType", "classification"]) ||
    !Object.hasOwn(input, "recordId") ||
    !Object.hasOwn(input, "content")
  ) {
    throw invalidInput("An in-memory broker record is malformed.");
  }
  const recordId = input["recordId"];
  const content = input["content"];
  const mediaType = input["mediaType"] ?? "text/plain";
  const classification = input["classification"] ?? "internal";
  validateNonEmpty(recordId, "recordId");
  if (typeof content !== "string") {
    throw invalidInput("An in-memory broker record content must be a string.");
  }
  validateNonEmpty(mediaType, "mediaType");
  validateNonEmpty(classification, "classification");
  const bytes = Uint8Array.from(Buffer.from(content, "utf8"));
  if (bytes.byteLength > maximumBytes) {
    throw invalidInput("An in-memory broker record exceeds its byte bound.");
  }
  return Object.freeze({
    recordId,
    content,
    bytes,
    mediaType,
    classification,
    contentHash: sha256Hex(bytes),
  });
}

function resourceFor(
  descriptor: ContextSourceDescriptor,
  record: StoredRecord,
): ResourceRef {
  return canonicalizeResourceRef({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scheme: descriptor.scheme,
    sourceId: descriptor.sourceId,
    locator: { recordId: record.recordId },
    mediaType: record.mediaType,
    classification: record.classification,
  });
}

function policyProjection(record: StoredRecord) {
  return snapshot({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    catalogId: MEMORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
    catalogVersion: MEMORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
    catalogContentHash: MEMORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
    resourceAttributes: { recordId: record.recordId },
    requestAttributes: {},
  });
}

function metadataMatches(
  actual: ContextResourceMetadata,
  expected: ContextResourceMetadata,
): boolean {
  return (
    actual.sourceId === expected.sourceId &&
    actual.sourceVersion === expected.sourceVersion &&
    actual.byteLength === expected.byteLength &&
    actual.selectedByteLength === expected.selectedByteLength &&
    actual.mediaType === expected.mediaType &&
    actual.classification === expected.classification &&
    JSON.stringify(actual.policyProjection) ===
      JSON.stringify(expected.policyProjection) &&
    resourceRefsEqual(actual.resource, expected.resource) &&
    JSON.stringify(actual.binding) === JSON.stringify(expected.binding)
  );
}

function completeUtf8Prefix(bytes: Uint8Array, maximumBytes: number): Uint8Array {
  const end = Math.min(maximumBytes, bytes.byteLength);
  for (let candidate = end; candidate >= Math.max(0, end - 3); candidate -= 1) {
    const prefix = bytes.subarray(0, candidate);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(prefix);
      return prefix;
    } catch {
      // A UTF-8 code point may occupy at most four bytes.
    }
  }
  return bytes.subarray(0, 0);
}

function validateReadBudget(budget: SourceReadBudget): void {
  if (
    typeof budget !== "object" ||
    budget === null ||
    Object.keys(budget).length !== 1 ||
    !Object.hasOwn(budget, "maximumBytes") ||
    !Number.isSafeInteger(budget.maximumBytes) ||
    budget.maximumBytes < 0
  ) {
    throw invalidInput("A source read budget must be a non-negative safe integer.");
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createDomainError({ code: "cancelled", message: "The context read was cancelled." });
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isPlainObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
