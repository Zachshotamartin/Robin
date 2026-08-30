import {
  CONTRACT_SCHEMA_VERSION,
  canonicalBytes,
  canonicalSha256Hex,
  createDomainError,
} from "@guard/contracts";
import type { JsonObject, ResourceRef } from "@guard/contracts";

import type {
  BoundedContextResult,
  ContextReadBudget,
  ContextSource,
  ContextSourceDescriptor,
  NormalizedContextRequest,
} from "./context-source.js";
import {
  parseDetachedDescriptor,
  validateNonEmpty,
  validatePositiveVersion,
} from "./context-source-registry.js";
import { snapshot, snapshotBoundaryObject } from "./immutable.js";

export interface InMemoryContextRecordInput {
  readonly recordId: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly mediaType?: string;
  readonly classification?: string;
}

export interface InMemoryContextSourceLimits {
  readonly maximumRecords: number;
  readonly maximumRecordBytes: number;
}

export interface InMemoryContextSourceOptions {
  readonly descriptor: ContextSourceDescriptor;
  readonly records: readonly InMemoryContextRecordInput[];
  readonly limits: InMemoryContextSourceLimits;
}

interface StoredRecord {
  readonly recordId: string;
  readonly value: JsonObject;
  readonly mediaType: string;
  readonly classification: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

/**
 * Deterministic source for tests and non-coding vertical slices. All input is
 * detached at construction and every read is all-or-none under byte budgets.
 */
export class InMemoryContextSource implements ContextSource {
  readonly descriptor: ContextSourceDescriptor;
  readonly #records: ReadonlyMap<string, StoredRecord>;
  readonly #limits: InMemoryContextSourceLimits;

  constructor(options: InMemoryContextSourceOptions) {
    const detached = snapshotBoundaryObject(options, "In-memory source options");
    if (!hasExactKeys(detached, ["descriptor", "records", "limits"])) {
      throw invalidInput("In-memory source options contain unknown or missing properties.");
    }
    const descriptor = parseDetachedDescriptor(
      detachedObject(detached["descriptor"], "In-memory source descriptor"),
    );
    const limits = parseLimits(
      detachedObject(detached["limits"], "In-memory source limits"),
    );
    const recordInputs = detached["records"];
    if (!Array.isArray(recordInputs)) {
      throw invalidInput("In-memory source records must be an array.");
    }
    if (recordInputs.length > limits.maximumRecords) {
      throw invalidInput("The in-memory source exceeds its configured record bound.");
    }

    const records = new Map<string, StoredRecord>();
    for (const input of recordInputs) {
      const record = createRecord(
        detachedObject(input, "In-memory context record"),
        limits.maximumRecordBytes,
      );
      if (records.has(record.recordId)) {
        throw createDomainError({
          code: "conflict",
          message: "An in-memory context record ID may appear only once.",
          details: { recordId: record.recordId },
        });
      }
      records.set(record.recordId, record);
    }

    this.descriptor = descriptor;
    this.#records = records;
    this.#limits = limits;
    Object.freeze(this);
  }

  normalizeRequest(input: unknown): NormalizedContextRequest {
    const detached = snapshotBoundaryObject(input, "In-memory context request");
    const keys = Object.keys(detached);
    if (keys.length !== 1 || keys[0] !== "recordId") {
      throw invalidInput("An in-memory context request accepts only recordId.");
    }
    const recordId = detached["recordId"];
    validateNonEmpty(recordId, "recordId");
    const record = this.#records.get(recordId);
    if (record === undefined) {
      throw invalidInput("The requested in-memory context record does not exist.", {
        recordId,
      });
    }

    return snapshot({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sourceId: this.descriptor.sourceId,
      sourceVersion: this.descriptor.sourceVersion,
      resource: resourceFor(this.descriptor, record),
    });
  }

  async readBounded(
    request: NormalizedContextRequest,
    budget: ContextReadBudget,
    signal: AbortSignal,
  ): Promise<BoundedContextResult> {
    assertNotAborted(signal);
    const detachedBudget = parseBudget(
      snapshotBoundaryObject(budget, "Context read budget"),
    );
    const detachedRequest = snapshotBoundaryObject(
      request,
      "Normalized context request",
    );
    const record = this.#validateRequest(detachedRequest);
    if (record.byteLength > detachedBudget.maximumBytes) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "The context item exceeds the caller's byte budget.",
        details: {
          maximumBytes: detachedBudget.maximumBytes,
          requestedBytes: record.byteLength,
        },
      });
    }
    if (detachedBudget.maximumItems < 1) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "The context item exceeds the caller's item budget.",
      });
    }
    assertNotAborted(signal);

    return snapshot({
      items: [
        {
          resource: resourceFor(this.descriptor, record),
          value: record.value,
          byteLength: record.byteLength,
          contentHash: record.contentHash,
        },
      ],
      totalBytes: record.byteLength,
      truncated: false,
    });
  }

  #validateRequest(request: JsonObject): StoredRecord {
    const requestKeys = [
      "schemaVersion",
      "sourceId",
      "sourceVersion",
      "resource",
    ];
    if (
      !hasExactKeys(request, requestKeys) ||
      request.schemaVersion !== CONTRACT_SCHEMA_VERSION ||
      request.sourceId !== this.descriptor.sourceId ||
      request.sourceVersion !== this.descriptor.sourceVersion ||
      !isPlainRecord(request.resource) ||
      !hasExactKeys(request.resource, [
        "schemaVersion",
        "scheme",
        "sourceId",
        "locator",
        "mediaType",
        "classification",
      ]) ||
      request.resource.schemaVersion !== CONTRACT_SCHEMA_VERSION ||
      request.resource.scheme !== this.descriptor.scheme ||
      request.resource.sourceId !== this.descriptor.sourceId ||
      !isPlainRecord(request.resource.locator)
    ) {
      throw invalidInput("The normalized context request does not match this source version.");
    }
    const locatorKeys = Object.keys(request.resource.locator);
    const recordId = request.resource.locator["recordId"];
    if (
      locatorKeys.length !== 1 ||
      locatorKeys[0] !== "recordId" ||
      typeof recordId !== "string"
    ) {
      throw invalidInput("The normalized in-memory locator is invalid.");
    }
    const record = this.#records.get(recordId);
    if (
      record === undefined ||
      request.resource.mediaType !== record.mediaType ||
      request.resource.classification !== record.classification
    ) {
      throw invalidInput("The normalized context resource is unknown or has changed.");
    }
    return record;
  }
}

function createRecord(
  input: JsonObject,
  maximumRecordBytes: number,
): StoredRecord {
  const allowed = new Set(["recordId", "value", "mediaType", "classification"]);
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    !Object.hasOwn(input, "recordId") ||
    !Object.hasOwn(input, "value")
  ) {
    throw invalidInput(
      "An in-memory context record contains an unknown or missing property.",
    );
  }
  const recordId = input["recordId"];
  validateNonEmpty(recordId, "recordId");
  const value = detachedObject(input["value"], "In-memory context value");
  const mediaType = input["mediaType"] ?? "application/json";
  const classification = input["classification"] ?? "internal";
  validateNonEmpty(mediaType, "mediaType");
  validateNonEmpty(classification, "classification");
  const byteLength = canonicalBytes(value).byteLength;
  if (byteLength > maximumRecordBytes) {
    throw invalidInput("An in-memory context record exceeds the configured byte bound.", {
      maximumRecordBytes,
      recordId,
      recordBytes: byteLength,
    });
  }
  return Object.freeze({
    recordId,
    value,
    mediaType,
    classification,
    byteLength,
    contentHash: canonicalSha256Hex(value),
  });
}

function resourceFor(
  descriptor: ContextSourceDescriptor,
  record: StoredRecord,
): ResourceRef {
  return snapshot({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scheme: descriptor.scheme,
    sourceId: descriptor.sourceId,
    locator: { recordId: record.recordId },
    mediaType: record.mediaType,
    classification: record.classification,
  });
}

function parseLimits(limits: JsonObject): InMemoryContextSourceLimits {
  if (!hasExactKeys(limits, ["maximumRecords", "maximumRecordBytes"])) {
    throw invalidInput("In-memory context limits contain unknown or missing properties.");
  }
  const maximumRecords = limits["maximumRecords"];
  const maximumRecordBytes = limits["maximumRecordBytes"];
  validatePositiveVersion(maximumRecords, "maximumRecords");
  validatePositiveVersion(maximumRecordBytes, "maximumRecordBytes");
  return Object.freeze({ maximumRecords, maximumRecordBytes });
}

function parseBudget(budget: JsonObject): ContextReadBudget {
  if (!hasExactKeys(budget, ["maximumItems", "maximumBytes"])) {
    throw invalidInput("A context read budget contains unknown or missing properties.");
  }
  const maximumItems = budget["maximumItems"];
  const maximumBytes = budget["maximumBytes"];
  validateNonNegativeBudget(maximumItems, "maximumItems");
  validateNonNegativeBudget(maximumBytes, "maximumBytes");
  return Object.freeze({ maximumItems, maximumBytes });
}

function validateNonNegativeBudget(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${field} must be a non-negative safe integer.`);
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function detachedObject(value: unknown, label: string): JsonObject {
  if (!isPlainRecord(value)) {
    throw invalidInput(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createDomainError({
      code: "cancelled",
      message: "The context read was cancelled.",
    });
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
