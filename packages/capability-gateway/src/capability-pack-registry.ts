import { isProxy } from "node:util/types";

import {
  DEFAULT_JSON_BOUNDARY_LIMITS,
  createDomainError,
  isDomainError,
} from "@guard/contracts";
import type { JsonObject, VersionedSchema } from "@guard/contracts";
import {
  compileTrustedJsonObjectSchema,
  type CompiledJsonObjectSchema,
} from "@guard/schema-validation";

import type {
  CapabilityAdvertisement,
  CapabilityOperation,
  CapabilityOperationReference,
  CapabilityPack,
  RegisteredPackDescriptor,
} from "./capability-types.js";
import { isPlainRecord, snapshot, snapshotObject } from "./immutable.js";

export interface CompiledOperation {
  readonly reference: CapabilityOperationReference;
  readonly definition: CapabilityOperation["definition"];
  readonly agentContextRelease: CapabilityOperation["agentContextRelease"];
  readonly normalize: CapabilityOperation["normalize"];
  readonly execute: CapabilityOperation["execute"];
  readonly release: CapabilityOperation["release"];
  readonly validateInput: CompiledJsonObjectSchema;
  readonly validateOutput: CompiledJsonObjectSchema;
}

interface RegistryState {
  readonly operations: ReadonlyMap<string, CompiledOperation>;
}

interface InspectedPack {
  readonly packId: string;
  readonly packVersion: number;
  readonly operations: readonly unknown[];
}

const REGISTRY_STATES = new WeakMap<CapabilityPackRegistry, RegistryState>();
const ADVERTISEMENT_OWNERS = new WeakMap<CapabilityAdvertisement, RegistryState>();
const ADVERTISEMENT_OPERATIONS = new WeakMap<
  CapabilityAdvertisement,
  ReadonlySet<string>
>();

export const DEFAULT_MAXIMUM_OPERATION_SCHEMA_BYTES = 256 * 1_024;

export interface CapabilityPackRegistryOptions {
  readonly maximumSchemaBytes?: number;
}

/**
 * Immutable registry that compiles every input and output schema eagerly.
 * Pack handlers are trusted executable installation code, not serializable
 * boundary data. Registration inspects their data descriptors without calling
 * them and detaches only JSON definitions and schemas. An invalid pack stops
 * startup.
 */
export class CapabilityPackRegistry {
  readonly #packs: readonly RegisteredPackDescriptor[];

  constructor(
    packs: readonly CapabilityPack[],
    options: CapabilityPackRegistryOptions = {},
  ) {
    const maximumSchemaBytes = normalizeMaximumSchemaBytes(options);
    const installedPacks = inspectTrustedArray(
      packs,
      "Capability packs must be supplied as a dense array.",
    );
    const operations = new Map<string, CompiledOperation>();
    const packKeys = new Set<string>();
    const descriptors: RegisteredPackDescriptor[] = [];

    for (const candidate of installedPacks) {
      const pack = inspectPack(candidate);
      const packKey = versionKey(pack.packId, pack.packVersion);
      if (packKeys.has(packKey)) {
        throw createDomainError({
          code: "conflict",
          message: "A capability-pack ID and version may be registered only once.",
          details: { packId: pack.packId, packVersion: pack.packVersion },
        });
      }
      packKeys.add(packKey);
      const operationKeys = new Set<string>();
      const operationDescriptors: RegisteredPackDescriptor["operations"][number][] = [];

      for (const operationCandidate of pack.operations) {
        const operation = inspectOperation(operationCandidate);
        const operationVersionKey = versionKey(
          operation.definition.operationId,
          operation.definition.operationVersion,
        );
        if (operationKeys.has(operationVersionKey)) {
          throw createDomainError({
            code: "conflict",
            message: "An operation ID and version may appear only once in a pack.",
            details: {
              packId: pack.packId,
              packVersion: pack.packVersion,
              operationId: operation.definition.operationId,
              operationVersion: operation.definition.operationVersion,
            },
          });
        }
        operationKeys.add(operationVersionKey);

        const inputSchema = operation.definition.inputSchema;
        const outputSchema = operation.definition.outputSchema;
        const validateInput = compileSchema(
          inputSchema,
          "input",
          maximumSchemaBytes,
        );
        const validateOutput = compileSchema(
          outputSchema,
          "output",
          maximumSchemaBytes,
        );
        const reference: CapabilityOperationReference = Object.freeze({
          packId: pack.packId,
          packVersion: pack.packVersion,
          operationId: operation.definition.operationId,
          operationVersion: operation.definition.operationVersion,
        });
        const definition = operation.definition;
        const compiled: CompiledOperation = Object.freeze({
          reference,
          definition,
          agentContextRelease: operation.agentContextRelease,
          normalize: operation.normalize,
          execute: operation.execute,
          release: operation.release,
          validateInput,
          validateOutput,
        });
        operations.set(referenceKey(reference), compiled);
        operationDescriptors.push(
          snapshot({
            ...reference,
            description: definition.description,
            inputSchema,
            sideEffectClass: definition.sideEffectClass,
            agentContextRelease: operation.agentContextRelease,
          }),
        );
      }

      operationDescriptors.sort(
        (left, right) =>
          left.operationId.localeCompare(right.operationId) ||
          left.operationVersion - right.operationVersion,
      );
      descriptors.push(
        Object.freeze({
          packId: pack.packId,
          packVersion: pack.packVersion,
          operations: Object.freeze(operationDescriptors),
        }),
      );
    }

    descriptors.sort(
      (left, right) =>
        left.packId.localeCompare(right.packId) || left.packVersion - right.packVersion,
    );
    this.#packs = Object.freeze(descriptors);
    const state = Object.freeze({ operations });
    REGISTRY_STATES.set(this, state);
    Object.freeze(this);
  }

  listPacks(): readonly RegisteredPackDescriptor[] {
    return this.#packs;
  }

  createAdvertisement(
    references: readonly CapabilityOperationReference[],
  ): CapabilityAdvertisement {
    if (!Array.isArray(references)) {
      throw invalidInput("Advertised capability operations must be an array.");
    }
    const state = getRegistryState(this);
    const keys = new Set<string>();
    const advertised = references.map((reference) => {
      validateReference(reference);
      const key = referenceKey(reference);
      if (keys.has(key)) {
        throw createDomainError({
          code: "conflict",
          message: "An operation may be advertised only once per advertisement.",
          details: safeReference(reference),
        });
      }
      keys.add(key);
      const registered = state.operations.get(key);
      if (registered === undefined) {
        throw invalidInput("An advertised capability operation is not installed.", {
          ...safeReference(reference),
        });
      }
      return {
        ...registered.reference,
        description: registered.definition.description,
        inputSchema: registered.definition.inputSchema,
        sideEffectClass: registered.definition.sideEffectClass,
      };
    });
    const advertisement = snapshot({ operations: advertised });
    ADVERTISEMENT_OWNERS.set(advertisement, state);
    ADVERTISEMENT_OPERATIONS.set(advertisement, keys);
    return advertisement;
  }
}

export function resolveRegisteredOperation(
  registry: CapabilityPackRegistry,
  reference: CapabilityOperationReference,
): CompiledOperation {
  const operation = getRegistryState(registry).operations.get(referenceKey(reference));
  if (operation === undefined) {
    throw invalidInput("The requested capability operation is not installed.", {
      ...safeReference(reference),
    });
  }
  return operation;
}

export function assertAdvertisedOperation(
  registry: CapabilityPackRegistry,
  advertisement: CapabilityAdvertisement,
  reference: CapabilityOperationReference,
): void {
  const state = getRegistryState(registry);
  if (
    ADVERTISEMENT_OWNERS.get(advertisement) !== state ||
    ADVERTISEMENT_OPERATIONS.get(advertisement)?.has(referenceKey(reference)) !== true
  ) {
    throw invalidInput(
      "The proposed operation was not in this registry's exact advertisement.",
      { ...safeReference(reference) },
    );
  }
}

export function runCompiledValidation(
  validator: CompiledJsonObjectSchema,
  value: unknown,
  purpose: "input" | "output",
): JsonObject {
  try {
    return validator.validate(value);
  } catch (error: unknown) {
    if (isDomainError(error) && error.code === "invalid_input") {
      throw createDomainError({
        code: purpose === "input" ? "invalid_input" : "invariant_violated",
        message:
          purpose === "input"
            ? "Capability operation input failed structural schema validation."
            : "Capability output violated its registered structural schema.",
        details: safeValidationDetails(error),
      });
    }
    throw createDomainError({
      code: "invariant_violated",
      message: `The compiled capability ${purpose} validator failed unexpectedly.`,
    });
  }
}

function safeValidationDetails(error: unknown): JsonObject {
  let keyword = "schema";
  try {
    if (isDomainError(error) && error.details !== undefined) {
      const details = snapshotObject(
        error.details,
        "Compiled schema validation details",
        "invariant_violated",
      );
      const violations = details["violations"];
      if (Array.isArray(violations) && violations.length > 0) {
        const first = violations[0];
        if (isPlainRecord(first)) {
          const candidate = first["keyword"];
          if (
            typeof candidate === "string" &&
            /^[A-Za-z0-9_$-]{1,64}$/u.test(candidate)
          ) {
            keyword = candidate;
          }
        }
      }
    }
  } catch {
    keyword = "schema";
  }
  return snapshot({ violations: [{ keyword }] });
}

function getRegistryState(registry: CapabilityPackRegistry): RegistryState {
  const state = REGISTRY_STATES.get(registry);
  if (state === undefined) {
    throw createDomainError({
      code: "invariant_violated",
      message: "The capability registry instance is not recognized.",
    });
  }
  return state;
}

function inspectPack(value: unknown): InspectedPack {
  const pack = inspectTrustedRecord(
    value,
    ["packId", "packVersion", "operations"],
    "capability pack",
  );
  const packId = pack["packId"];
  const packVersion = pack["packVersion"];
  validateNonEmpty(packId, "packId");
  validatePositive(packVersion, "packVersion");
  const operations = inspectTrustedArray(
    pack["operations"],
    "A capability pack operations field must be a dense array.",
  );
  if (operations.length === 0) {
    throw invalidInput("A capability pack requires at least one operation.");
  }
  return Object.freeze({ packId, packVersion, operations });
}

function inspectOperation(value: unknown): CapabilityOperation {
  const operation = inspectTrustedRecord(
    value,
    ["definition", "agentContextRelease", "normalize", "execute", "release"],
    "capability operation",
  );
  const normalize = operation["normalize"];
  const execute = operation["execute"];
  const release = operation["release"];
  if (
    typeof normalize !== "function" ||
    typeof execute !== "function" ||
    typeof release !== "function" ||
    isProxy(normalize) ||
    isProxy(execute) ||
    isProxy(release)
  ) {
    throw invalidInput("A capability operation has an incomplete handler contract.");
  }
  const original = value as CapabilityOperation;
  const definition = normalizeOperationDefinition(operation["definition"]);
  return Object.freeze({
    definition,
    agentContextRelease: normalizeAgentContextReleaseDefinition(
      operation["agentContextRelease"],
    ),
    normalize: Function.prototype.bind.call(
      normalize,
      original,
    ) as CapabilityOperation["normalize"],
    execute: Function.prototype.bind.call(
      execute,
      original,
    ) as CapabilityOperation["execute"],
    release: Function.prototype.bind.call(
      release,
      original,
    ) as CapabilityOperation["release"],
  });
}

function normalizeAgentContextReleaseDefinition(
  value: unknown,
): CapabilityOperation["agentContextRelease"] {
  const definition = inspectTrustedRecord(
    value,
    [
      "schemaVersion",
      "sourceVersion",
      "catalogId",
      "catalogVersion",
      "catalogContentHash",
      "classification",
      "reason",
    ],
    "capability agent-context release definition",
  );
  if (definition["schemaVersion"] !== 1) {
    throw invalidInput(
      "A capability agent-context release definition has an unsupported schema version.",
    );
  }
  validatePositive(definition["sourceVersion"], "release sourceVersion");
  validateSafeIdentifier(definition["catalogId"], "release catalogId");
  if (
    definition["catalogId"] === "guard.base" ||
    definition["catalogId"] === "guard.context"
  ) {
    throw invalidInput(
      "A capability operation cannot claim a broker-owned policy catalog.",
    );
  }
  validatePositive(definition["catalogVersion"], "release catalogVersion");
  const catalogContentHash = definition["catalogContentHash"];
  if (
    typeof catalogContentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(catalogContentHash)
  ) {
    throw invalidInput("A capability release catalog hash must be canonical SHA-256.");
  }
  validateSafeIdentifier(
    definition["classification"],
    "release classification",
  );
  validateSafeIdentifier(definition["reason"], "release reason");
  return Object.freeze({
    schemaVersion: 1,
    sourceVersion: definition["sourceVersion"],
    catalogId: definition["catalogId"],
    catalogVersion: definition["catalogVersion"],
    catalogContentHash,
    classification: definition["classification"],
    reason: definition["reason"],
  });
}

function normalizeOperationDefinition(
  value: unknown,
): CapabilityOperation["definition"] {
  const definition = snapshotObject(
    value,
    "Capability operation definition",
  );
  assertExactKeys(
    definition,
    [
      "operationId",
      "operationVersion",
      "description",
      "inputSchema",
      "outputSchema",
      "sideEffectClass",
    ],
    "operation definition",
  );
  const operationId = definition["operationId"];
  const operationVersion = definition["operationVersion"];
  const description = definition["description"];
  const sideEffectClass = definition["sideEffectClass"];
  validateNonEmpty(operationId, "operationId");
  validatePositive(operationVersion, "operationVersion");
  validateNonEmpty(description, "description");
  if (
    ![
      "none",
      "local_reversible",
      "local_irreversible",
      "external",
    ].includes(sideEffectClass as string)
  ) {
    throw invalidInput("An operation has an unknown side-effect class.");
  }
  return Object.freeze({
    operationId,
    operationVersion,
    description,
    inputSchema: normalizeSchema(definition["inputSchema"], "input"),
    outputSchema: normalizeSchema(definition["outputSchema"], "output"),
    sideEffectClass: sideEffectClass as CapabilityOperation["definition"]["sideEffectClass"],
  });
}

function normalizeSchema(schema: unknown, purpose: string): VersionedSchema {
  if (!isPlainRecord(schema)) {
    throw invalidInput(`An operation ${purpose} schema must be an object.`);
  }
  assertExactKeys(
    schema,
    ["schemaId", "schemaVersion", "document"],
    `${purpose} schema envelope`,
  );
  const schemaId = schema["schemaId"];
  const schemaVersion = schema["schemaVersion"];
  const documentValue = schema["document"];
  validateNonEmpty(schemaId, `${purpose} schemaId`);
  validatePositive(schemaVersion, `${purpose} schemaVersion`);
  if (!isPlainRecord(documentValue)) {
    throw invalidInput(`An operation ${purpose} schema document must be an object.`);
  }
  const document = documentValue as JsonObject;
  if (document["type"] !== "object" || document["additionalProperties"] !== false) {
    throw invalidInput(
      `An operation ${purpose} schema must reject unknown root properties.`,
    );
  }
  return snapshot({
    schemaId,
    schemaVersion,
    document,
  });
}

function compileSchema(
  schema: VersionedSchema,
  purpose: string,
  maximumSchemaBytes: number,
): CompiledJsonObjectSchema {
  if (schema.document["$async"] === true) {
    throw invalidInput(
      `The operation ${purpose} schema must compile to a synchronous validator.`,
      {
        schemaId: schema.schemaId,
        schemaVersion: schema.schemaVersion,
      },
    );
  }
  try {
    return compileTrustedJsonObjectSchema(
      schema,
      {
        maxSchemaBytes: maximumSchemaBytes,
        maxValueBytes:
          DEFAULT_JSON_BOUNDARY_LIMITS.maximumCanonicalUtf8Bytes,
      },
    );
  } catch {
    throw invalidInput(`The operation ${purpose} schema is invalid in Ajv strict mode.`, {
      schemaId: schema.schemaId,
      schemaVersion: schema.schemaVersion,
    });
  }
}

function normalizeMaximumSchemaBytes(value: unknown): number {
  const options = snapshotObject(value, "Capability registry options");
  const keys = Object.keys(options);
  if (
    keys.some((key) => key !== "maximumSchemaBytes") ||
    keys.length > 1
  ) {
    throw invalidInput("Capability registry options contain an unknown field.");
  }
  const maximum = options["maximumSchemaBytes"] ??
    DEFAULT_MAXIMUM_OPERATION_SCHEMA_BYTES;
  if (
    typeof maximum !== "number" ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > DEFAULT_JSON_BOUNDARY_LIMITS.maximumCanonicalUtf8Bytes
  ) {
    throw invalidInput(
      "maximumSchemaBytes must be a positive safe integer within the JSON boundary.",
    );
  }
  return maximum;
}

function validateReference(
  reference: CapabilityOperationReference,
): asserts reference is CapabilityOperationReference {
  if (!isPlainRecord(reference)) {
    throw invalidInput("A capability operation reference must be an object.");
  }
  assertExactKeys(
    reference,
    ["packId", "packVersion", "operationId", "operationVersion"],
    "operation reference",
  );
  validateNonEmpty(reference.packId, "packId");
  validatePositive(reference.packVersion, "packVersion");
  validateNonEmpty(reference.operationId, "operationId");
  validatePositive(reference.operationVersion, "operationVersion");
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalidInput(`The ${label} contains unknown or missing properties.`);
  }
}

function inspectTrustedRecord(
  value: unknown,
  expected: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      isProxy(value) ||
      Array.isArray(value)
    ) {
      throw new TypeError("not an installable record");
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("installation record has a custom prototype");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string") ||
      expected.some((key) => !keys.includes(key))
    ) {
      throw new TypeError("installation record has inexact keys");
    }
    const inspected: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("installation property is not enumerable data");
      }
      Object.defineProperty(inspected, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(inspected);
  } catch {
    throw invalidInput(
      `The ${label} must be trusted installed code with exact data properties.`,
    );
  }
}

function inspectTrustedArray(value: unknown, message: string): readonly unknown[] {
  try {
    if (typeof value !== "object" || value === null || isProxy(value)) {
      throw new TypeError("not an installable array");
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
        throw new TypeError("array element is not enumerable data");
      }
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    throw invalidInput(message);
  }
}

function validateNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput(`${field} must be a non-empty string.`);
  }
}

function validatePositive(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidInput(`${field} must be a positive safe integer.`);
  }
}

function validateSafeIdentifier(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw invalidInput(`${field} must be a canonical safe identifier.`);
  }
}

function versionKey(id: string, version: number): string {
  return `${id}\u0000${String(version)}`;
}

function referenceKey(reference: CapabilityOperationReference): string {
  return `${versionKey(reference.packId, reference.packVersion)}\u0000${versionKey(
    reference.operationId,
    reference.operationVersion,
  )}`;
}

function safeReference(reference: CapabilityOperationReference): JsonObject {
  return {
    packId: reference.packId,
    packVersion: reference.packVersion,
    operationId: reference.operationId,
    operationVersion: reference.operationVersion,
  };
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
