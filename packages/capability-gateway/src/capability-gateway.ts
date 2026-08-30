import {
  ActionIdKind,
  CONTRACT_SCHEMA_VERSION,
  canonicalBytes,
  canonicalSha256Hex,
  createDomainError,
  isDomainError,
} from "@guard/contracts";
import type {
  ActionPrecondition,
  JsonObject,
  NormalizedAction,
} from "@guard/contracts";

import type {
  CapabilityActionProposal,
  CapabilityAdvertisement,
  CapabilityExecutionContext,
  CapabilityExecutionResult,
  CapabilityGatewayOptions,
  CapabilityNormalizationContext,
  CapabilityReleasedViews,
  CapabilitySemanticNormalization,
  PreparedCapabilityAction,
} from "./capability-types.js";
import {
  CapabilityPackRegistry,
  assertAdvertisedOperation,
  resolveRegisteredOperation,
  runCompiledValidation,
  type CompiledOperation,
} from "./capability-pack-registry.js";
import { isPlainRecord, snapshot, snapshotObject } from "./immutable.js";

interface PreparedProvenance {
  readonly operation: CompiledOperation;
  readonly action: NormalizedAction;
  readonly actionHash: string;
}

interface CapabilityGatewayLimits {
  readonly maximumInputBytes: number;
  readonly maximumRawOutputBytes: number;
  readonly maximumReleasedViewBytes: number;
  readonly maximumCombinedReleasedViewBytes: number;
}

const DEFAULT_GATEWAY_LIMITS: CapabilityGatewayLimits = Object.freeze({
  maximumInputBytes: 1024 * 1024,
  maximumRawOutputBytes: 1024 * 1024,
  maximumReleasedViewBytes: 1024 * 1024,
  maximumCombinedReleasedViewBytes: 2 * 1024 * 1024,
});

/**
 * Structural validation, semantic normalization, hashing, and execution meet
 * only here. Handlers can be dispatched only with an object this instance
 * previously prepared, preventing reconstructed raw arguments after policy.
 */
export class CapabilityGateway {
  readonly #registry: CapabilityPackRegistry;
  readonly #prepared = new WeakMap<PreparedCapabilityAction, PreparedProvenance>();
  readonly #maximumInputBytes: number;
  readonly #maximumRawOutputBytes: number;
  readonly #maximumReleasedViewBytes: number;
  readonly #maximumCombinedReleasedViewBytes: number;

  constructor(
    registry: CapabilityPackRegistry,
    options: CapabilityGatewayOptions = {},
  ) {
    if (!(registry instanceof CapabilityPackRegistry)) {
      throw createDomainError({
        code: "invalid_input",
        message: "The capability gateway requires a recognized pack registry.",
      });
    }
    const limits = normalizeGatewayOptions(options);
    this.#registry = registry;
    this.#maximumInputBytes = limits.maximumInputBytes;
    this.#maximumRawOutputBytes = limits.maximumRawOutputBytes;
    this.#maximumReleasedViewBytes = limits.maximumReleasedViewBytes;
    this.#maximumCombinedReleasedViewBytes =
      limits.maximumCombinedReleasedViewBytes;
    Object.freeze(this);
  }

  async normalize(
    proposal: CapabilityActionProposal,
    context: CapabilityNormalizationContext,
    advertisement: CapabilityAdvertisement,
  ): Promise<PreparedCapabilityAction> {
    const reference = validateProposalEnvelope(proposal);
    assertAdvertisedOperation(this.#registry, advertisement, reference);
    const operation = resolveRegisteredOperation(this.#registry, reference);
    const input = snapshotObject(reference.input, "Capability operation input");
    const inputBytes = canonicalBytes(input).byteLength;
    if (inputBytes > this.#maximumInputBytes) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "Capability operation input exceeds the gateway byte bound.",
        details: {
          maximumInputBytes: this.#maximumInputBytes,
          inputBytes,
        },
      });
    }
    const structurallyValidInput = runCompiledValidation(
      operation.validateInput,
      input,
      "input",
    );
    const normalizedContext = normalizeContext(context);

    let semantics: CapabilitySemanticNormalization;
    try {
      semantics = await operation.normalize(
        structurallyValidInput,
        normalizedContext,
      );
    } catch (error: unknown) {
      if (isDomainError(error)) {
        throw error;
      }
      throw createDomainError({
        code: "invariant_violated",
        message: "The capability semantic normalizer failed unexpectedly.",
      });
    }
    const normalized = normalizeSemanticResult(semantics);
    const action: NormalizedAction = snapshot({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      actionId: normalizedContext.actionId,
      capabilityPackId: reference.packId,
      capabilityPackVersion: reference.packVersion,
      operationId: reference.operationId,
      operationVersion: reference.operationVersion,
      subject: normalizedContext.subject,
      resource: normalized.resource,
      environment: normalizedContext.environment,
      request: normalized.request,
      normalizedInput: normalized.normalizedInput,
      sideEffectClass: operation.definition.sideEffectClass,
      preconditions: normalized.preconditions,
    });
    const actionHash = canonicalSha256Hex(action);
    const prepared: PreparedCapabilityAction = Object.freeze({ action, actionHash });
    this.#prepared.set(
      prepared,
      Object.freeze({ operation, action, actionHash }),
    );
    return prepared;
  }

  async execute(
    prepared: PreparedCapabilityAction,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecutionResult> {
    const provenance = this.#prepared.get(prepared);
    if (
      provenance === undefined ||
      prepared.action !== provenance.action ||
      prepared.actionHash !== provenance.actionHash
    ) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Capability dispatch requires this gateway's prepared action object.",
      });
    }
    const signal = validateExecutionContext(context);
    assertNotAborted(signal);

    let rawUnknown: unknown;
    try {
      rawUnknown = await provenance.operation.execute(
        provenance.action,
        Object.freeze({ signal }),
      );
    } catch (error: unknown) {
      if (isDomainError(error)) {
        throw error;
      }
      throw createDomainError({
        code: "action_failed",
        message: "The capability handler failed.",
      });
    }
    const raw = snapshotObject(
      rawUnknown,
      "Capability raw result",
      "invariant_violated",
    );
    assertByteBound(
      raw,
      "raw output",
      this.#maximumRawOutputBytes,
      "maximumRawOutputBytes",
    );
    const structurallyValidRaw = runCompiledValidation(
      provenance.operation.validateOutput,
      raw,
      "output",
    );

    let released: CapabilityReleasedViews;
    try {
      released = await provenance.operation.release(
        structurallyValidRaw,
        provenance.action,
      );
    } catch (error: unknown) {
      if (isDomainError(error)) {
        throw error;
      }
      throw createDomainError({
        code: "invariant_violated",
        message: "The capability output classifier failed unexpectedly.",
      });
    }
    const views = normalizeReleasedViews(released);
    assertByteBound(
      views.audit,
      "audit view",
      this.#maximumReleasedViewBytes,
      "maximumReleasedViewBytes",
    );
    assertByteBound(
      views.human,
      "human view",
      this.#maximumReleasedViewBytes,
      "maximumReleasedViewBytes",
    );
    assertByteBound(
      views.agent,
      "agent view",
      this.#maximumReleasedViewBytes,
      "maximumReleasedViewBytes",
    );
    assertByteBound(
      views,
      "combined released views",
      this.#maximumCombinedReleasedViewBytes,
      "maximumCombinedReleasedViewBytes",
    );
    return snapshot({ raw: structurallyValidRaw, ...views });
  }
}

function validateProposalEnvelope(
  proposal: CapabilityActionProposal,
): CapabilityActionProposal {
  const detached = snapshotObject(proposal, "Capability action proposal");
  const expected = [
    "schemaVersion",
    "packId",
    "packVersion",
    "operationId",
    "operationVersion",
    "input",
  ];
  const keys = Object.keys(detached);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(detached, key))
  ) {
    throw invalidInput("A capability action proposal has unknown or missing properties.");
  }
  const schemaVersion = detached["schemaVersion"];
  const packId = detached["packId"];
  const packVersion = detached["packVersion"];
  const operationId = detached["operationId"];
  const operationVersion = detached["operationVersion"];
  if (schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw invalidInput("The capability action proposal schema version is unsupported.");
  }
  validateNonEmpty(packId, "packId");
  validatePositive(packVersion, "packVersion");
  validateNonEmpty(operationId, "operationId");
  validatePositive(operationVersion, "operationVersion");
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    packId,
    packVersion,
    operationId,
    operationVersion,
    input: detached["input"],
  });
}

function normalizeContext(
  context: CapabilityNormalizationContext,
): CapabilityNormalizationContext {
  const detached = snapshotObject(context, "Capability normalization context");
  const expected = ["actionId", "subject", "environment"];
  const keys = Object.keys(detached);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(detached, key))
  ) {
    throw invalidInput("A normalization context has unknown or missing properties.");
  }
  const rawActionId = detached["actionId"];
  if (typeof rawActionId !== "string") {
    throw invalidInput("A capability normalization context has an invalid actionId.");
  }
  const actionId = ActionIdKind.parse(rawActionId);
  return Object.freeze({
    actionId,
    subject: snapshotObject(detached["subject"], "Capability subject"),
    environment: snapshotObject(
      detached["environment"],
      "Capability environment",
    ),
  });
}

function normalizeSemanticResult(
  value: CapabilitySemanticNormalization,
): CapabilitySemanticNormalization {
  if (!isPlainRecord(value)) {
    throw invariant("A semantic normalizer must return an object.");
  }
  const expected = ["normalizedInput", "resource", "request", "preconditions"];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    !Array.isArray(value.preconditions)
  ) {
    throw invariant("A semantic normalizer returned an incomplete result.");
  }
  const preconditions = value.preconditions.map(normalizePrecondition);
  return Object.freeze({
    normalizedInput: snapshotObject(
      value.normalizedInput,
      "Normalized capability input",
      "invariant_violated",
    ),
    resource: snapshotObject(
      value.resource,
      "Normalized capability resource",
      "invariant_violated",
    ),
    request: snapshotObject(
      value.request,
      "Normalized capability request",
      "invariant_violated",
    ),
    preconditions: Object.freeze(preconditions),
  });
}

function normalizePrecondition(value: ActionPrecondition): ActionPrecondition {
  if (!isPlainRecord(value)) {
    throw invariant("An action precondition must be an object.");
  }
  const expected = [
    "preconditionType",
    "preconditionVersion",
    "attributes",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invariant("An action precondition has unknown or missing properties.");
  }
  if (
    typeof value.preconditionType !== "string" ||
    value.preconditionType.trim().length === 0 ||
    !Number.isSafeInteger(value.preconditionVersion) ||
    value.preconditionVersion < 1
  ) {
    throw invariant("An action precondition has an invalid type or version.");
  }
  return Object.freeze({
    preconditionType: value.preconditionType,
    preconditionVersion: value.preconditionVersion,
    attributes: snapshotObject(
      value.attributes,
      "Action precondition attributes",
      "invariant_violated",
    ),
  });
}

function normalizeReleasedViews(
  value: CapabilityReleasedViews,
): CapabilityReleasedViews {
  if (!isPlainRecord(value)) {
    throw invariant("A capability release classifier must return an object.");
  }
  const expected = ["audit", "human", "agent"];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invariant("A capability release classifier returned incomplete views.");
  }
  return Object.freeze({
    audit: snapshotObject(
      value.audit,
      "Capability audit view",
      "invariant_violated",
    ),
    human: snapshotObject(
      value.human,
      "Capability human view",
      "invariant_violated",
    ),
    agent: snapshotObject(
      value.agent,
      "Capability agent view",
      "invariant_violated",
    ),
  });
}

function validateExecutionContext(
  context: CapabilityExecutionContext,
): AbortSignal {
  try {
    if (typeof context !== "object" || context === null) {
      throw new TypeError("not an object");
    }
    const keys = Reflect.ownKeys(context);
    const descriptor = Object.getOwnPropertyDescriptor(context, "signal");
    if (
      keys.length !== 1 ||
      keys[0] !== "signal" ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !(descriptor.value instanceof AbortSignal)
    ) {
      throw new TypeError("not an exact signal data property");
    }
    readAbortState(descriptor.value);
    return descriptor.value;
  } catch {
    throw invalidInput("A capability execution context requires an AbortSignal.");
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (readAbortState(signal)) {
    throw createDomainError({
      code: "cancelled",
      message: "Capability dispatch was cancelled before execution.",
    });
  }
}

function readAbortState(signal: AbortSignal): boolean {
  try {
    const getter = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    )?.get;
    if (getter === undefined) {
      throw new TypeError("AbortSignal aborted getter is unavailable");
    }
    return getter.call(signal) as boolean;
  } catch {
    throw invalidInput("A capability execution context requires an AbortSignal.");
  }
}

function normalizeGatewayOptions(
  options: CapabilityGatewayOptions,
): CapabilityGatewayLimits {
  const detached = snapshotObject(options, "Capability gateway options");
  const allowed = new Set([
    "maximumInputBytes",
    "maximumRawOutputBytes",
    "maximumReleasedViewBytes",
    "maximumCombinedReleasedViewBytes",
  ]);
  if (Object.keys(detached).some((key) => !allowed.has(key))) {
    throw invalidInput("Capability gateway options contain an unknown property.");
  }
  return Object.freeze({
    maximumInputBytes: positiveOption(
      detached,
      "maximumInputBytes",
      DEFAULT_GATEWAY_LIMITS.maximumInputBytes,
    ),
    maximumRawOutputBytes: positiveOption(
      detached,
      "maximumRawOutputBytes",
      DEFAULT_GATEWAY_LIMITS.maximumRawOutputBytes,
    ),
    maximumReleasedViewBytes: positiveOption(
      detached,
      "maximumReleasedViewBytes",
      DEFAULT_GATEWAY_LIMITS.maximumReleasedViewBytes,
    ),
    maximumCombinedReleasedViewBytes: positiveOption(
      detached,
      "maximumCombinedReleasedViewBytes",
      DEFAULT_GATEWAY_LIMITS.maximumCombinedReleasedViewBytes,
    ),
  });
}

function positiveOption(
  options: JsonObject,
  field: keyof CapabilityGatewayLimits,
  fallback: number,
): number {
  if (!Object.hasOwn(options, field)) return fallback;
  const value = options[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidInput(`${field} must be a positive safe integer.`);
  }
  return value;
}

function assertByteBound(
  value: unknown,
  boundary: string,
  maximumBytes: number,
  maximumField: keyof CapabilityGatewayLimits,
): void {
  const observedBytes = canonicalBytes(value).byteLength;
  if (observedBytes > maximumBytes) {
    throw createDomainError({
      code: "budget_exceeded",
      message: `Capability ${boundary} exceeds the gateway byte bound.`,
      details: { boundary, [maximumField]: maximumBytes, observedBytes },
    });
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

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}

function invariant(message: string) {
  return createDomainError({ code: "invariant_violated", message });
}
