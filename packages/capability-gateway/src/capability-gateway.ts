import { isProxy } from "node:util/types";

import {
  ActionIdKind,
  CONTRACT_SCHEMA_VERSION,
  PolicyVersionIdKind,
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
  PinnedPolicyEvaluator,
  PolicyDecision,
  PolicyEffect,
} from "@guard/policy-engine";

import type {
  CapabilityActionProposal,
  CapabilityAdvertisement,
  CapabilityExecutionContext,
  CapabilityExecutionResult,
  CapabilityGatewayOptions,
  CapabilityNormalizationContext,
  CapabilityReleasedViews,
  CapabilitySemanticNormalization,
  EvaluatedCapabilityAction,
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

interface CapturedPolicyEvaluator {
  readonly policyVersionId: PolicyDecision["policyVersionId"];
  readonly evaluate: PinnedPolicyEvaluator["evaluate"];
}

interface EvaluatedProvenance extends PreparedProvenance {
  readonly prepared: PreparedCapabilityAction;
  readonly decision: PolicyDecision;
  readonly decisionHash: string;
  consumed: boolean;
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
 * Structural validation, semantic normalization, pinned policy evaluation,
 * and execution meet only here. A handler can be dispatched only through the
 * exact one-use receipt this instance issued after evaluating its exact
 * normalized action, preventing policy bypass or reconstructed arguments.
 */
export class CapabilityGateway {
  readonly #registry: CapabilityPackRegistry;
  readonly #policyEvaluator: CapturedPolicyEvaluator;
  readonly #prepared = new WeakMap<PreparedCapabilityAction, PreparedProvenance>();
  readonly #evaluatedPrepared = new WeakSet<PreparedCapabilityAction>();
  readonly #evaluated = new WeakMap<EvaluatedCapabilityAction, EvaluatedProvenance>();
  readonly #maximumInputBytes: number;
  readonly #maximumRawOutputBytes: number;
  readonly #maximumReleasedViewBytes: number;
  readonly #maximumCombinedReleasedViewBytes: number;

  constructor(
    registry: CapabilityPackRegistry,
    policyEvaluator: PinnedPolicyEvaluator,
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
    this.#policyEvaluator = capturePinnedPolicyEvaluator(policyEvaluator);
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

  /**
   * Evaluate one exact prepared action through the evaluator pinned when this
   * gateway was constructed. Milestone B evaluators are intentionally
   * synchronous; async policy dependencies are outside the pure policy model.
   */
  evaluate(prepared: PreparedCapabilityAction): EvaluatedCapabilityAction {
    const provenance = this.#preparedProvenance(prepared);
    if (this.#evaluatedPrepared.has(prepared)) {
      throw invariant("A prepared capability action may be evaluated only once.");
    }
    // Set before calling the port so hostile or accidental reentrancy cannot
    // produce two decisions for one normalized action.
    this.#evaluatedPrepared.add(prepared);

    let untrustedDecision: unknown;
    try {
      untrustedDecision = this.#policyEvaluator.evaluate(provenance.action);
    } catch {
      throw policyEvaluationFailure(
        "The pinned policy evaluator failed before producing a decision.",
      );
    }

    let decision: PolicyDecision;
    try {
      decision = normalizePolicyDecision(
        untrustedDecision,
        this.#policyEvaluator.policyVersionId,
      );
    } catch {
      throw policyEvaluationFailure(
        "The pinned policy evaluator returned an invalid decision.",
      );
    }
    const decisionHash = canonicalSha256Hex(decision);
    const receipt = Object.freeze({
      prepared,
      decision,
    }) as unknown as EvaluatedCapabilityAction;
    this.#evaluated.set(receipt, {
      ...provenance,
      prepared,
      decision,
      decisionHash,
      consumed: false,
    });
    return receipt;
  }

  async execute(
    evaluated: EvaluatedCapabilityAction,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecutionResult> {
    const provenance = this.#evaluated.get(evaluated);
    if (
      provenance === undefined ||
      evaluated.prepared !== provenance.prepared ||
      evaluated.decision !== provenance.decision ||
      provenance.prepared.action !== provenance.action ||
      provenance.prepared.actionHash !== provenance.actionHash ||
      canonicalSha256Hex(provenance.action) !== provenance.actionHash ||
      canonicalSha256Hex(provenance.decision) !== provenance.decisionHash
    ) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Capability dispatch requires this gateway's evaluated action receipt.",
      });
    }
    if (provenance.consumed) {
      throw invariant("An evaluated capability action receipt may be consumed only once.");
    }
    provenance.consumed = true;
    if (provenance.decision.effect === "deny") {
      throw createDomainError({
        code: "policy_denied",
        message: "The pinned policy snapshot denied this capability action.",
        details: {
          actionId: provenance.action.actionId,
          policyVersionId: provenance.decision.policyVersionId,
          winningPolicyName: provenance.decision.winningPolicyName,
        },
      });
    }
    if (provenance.decision.effect === "require_approval") {
      throw createDomainError({
        code: "approval_required",
        message: "The pinned policy snapshot requires approval for this capability action.",
        details: {
          actionId: provenance.action.actionId,
          policyVersionId: provenance.decision.policyVersionId,
          winningPolicyName: provenance.decision.winningPolicyName,
        },
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

  #preparedProvenance(prepared: PreparedCapabilityAction): PreparedProvenance {
    const provenance = this.#prepared.get(prepared);
    if (
      provenance === undefined ||
      prepared.action !== provenance.action ||
      prepared.actionHash !== provenance.actionHash ||
      canonicalSha256Hex(provenance.action) !== provenance.actionHash
    ) {
      throw invariant(
        "Policy evaluation requires this gateway's exact prepared action object.",
      );
    }
    return provenance;
  }
}

function capturePinnedPolicyEvaluator(
  value: PinnedPolicyEvaluator,
): CapturedPolicyEvaluator {
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
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== "policyVersionId" && key !== "evaluate")
    ) {
      throw new TypeError();
    }
    const idDescriptor = Object.getOwnPropertyDescriptor(value, "policyVersionId");
    const evaluateDescriptor = Object.getOwnPropertyDescriptor(value, "evaluate");
    if (
      idDescriptor === undefined || !("value" in idDescriptor) ||
      idDescriptor.enumerable !== true ||
      !PolicyVersionIdKind.is(idDescriptor.value) ||
      evaluateDescriptor === undefined || !("value" in evaluateDescriptor) ||
      evaluateDescriptor.enumerable !== true ||
      typeof evaluateDescriptor.value !== "function"
    ) {
      throw new TypeError();
    }
    const policyVersionId = idDescriptor.value;
    if (isProxy(evaluateDescriptor.value)) {
      throw new TypeError();
    }
    const evaluate = evaluateDescriptor.value as PinnedPolicyEvaluator["evaluate"];
    const captured: CapturedPolicyEvaluator = {
      policyVersionId,
      evaluate(action: NormalizedAction): PolicyDecision {
        return Reflect.apply(evaluate, captured, [action]) as PolicyDecision;
      },
    };
    return Object.freeze(captured);
  } catch {
    throw invalidInput(
      "The capability gateway requires one descriptor-safe pinned policy evaluator.",
    );
  }
}

function normalizePolicyDecision(
  value: unknown,
  expectedPolicyVersionId: PolicyDecision["policyVersionId"],
): PolicyDecision {
  const detached = snapshotObject(
    value,
    "Policy decision",
    "invariant_violated",
  );
  if (!hasExactKeys(detached, [
    "policyVersionId",
    "effect",
    "winningPolicyName",
    "reason",
    "matchedPolicyNames",
    "trace",
  ])) {
    throw new TypeError("invalid policy decision envelope");
  }
  const policyVersionId = detached["policyVersionId"];
  const effect = detached["effect"];
  const winningPolicyName = detached["winningPolicyName"];
  const reason = detached["reason"];
  const rawMatchedPolicyNames = detached["matchedPolicyNames"];
  const rawTrace = detached["trace"];
  if (
    !PolicyVersionIdKind.is(policyVersionId) ||
    policyVersionId !== expectedPolicyVersionId ||
    !isPolicyEffect(effect) ||
    !isNullableNonEmptyString(winningPolicyName) ||
    typeof reason !== "string" || reason.trim().length === 0 ||
    !Array.isArray(rawMatchedPolicyNames) ||
    !rawMatchedPolicyNames.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    ) ||
    new Set(rawMatchedPolicyNames).size !== rawMatchedPolicyNames.length ||
    !isPlainRecord(rawTrace)
  ) {
    throw new TypeError("invalid policy decision fields");
  }
  const matchedPolicyNames = Object.freeze([...rawMatchedPolicyNames]);
  if (
    (winningPolicyName === null) !== (matchedPolicyNames.length === 0) ||
    (winningPolicyName !== null &&
      matchedPolicyNames[0] !== winningPolicyName)
  ) {
    throw new TypeError("winning policy is inconsistent with matched policies");
  }
  const trace = normalizePolicyTrace(
    rawTrace,
    effect,
    winningPolicyName,
    matchedPolicyNames,
  );
  return Object.freeze({
    policyVersionId,
    effect,
    winningPolicyName,
    reason,
    matchedPolicyNames,
    trace,
  });
}

function normalizePolicyTrace(
  trace: Readonly<Record<string, unknown>>,
  effect: PolicyEffect,
  winningPolicyName: string | null,
  matchedPolicyNames: readonly string[],
): JsonObject {
  if (!hasExactKeys(trace, [
    "languageVersion",
    "policyContentHash",
    "attributeCatalogs",
    "combiningAlgorithm",
    "defaultEffect",
    "result",
    "winningPolicyName",
    "evaluations",
    "matchedPolicyNames",
  ])) {
    throw new TypeError("invalid policy trace envelope");
  }
  const traceMatches = trace["matchedPolicyNames"];
  if (
    trace["languageVersion"] !== "1" ||
    typeof trace["policyContentHash"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(trace["policyContentHash"]) ||
    !Array.isArray(trace["attributeCatalogs"]) ||
    trace["combiningAlgorithm"] !== "deny_overrides" ||
    !isPolicyEffect(trace["defaultEffect"]) ||
    (winningPolicyName === null && trace["defaultEffect"] !== effect) ||
    trace["result"] !== effect ||
    trace["winningPolicyName"] !== winningPolicyName ||
    !Array.isArray(trace["evaluations"]) ||
    !Array.isArray(traceMatches) ||
    traceMatches.length !== matchedPolicyNames.length ||
    !traceMatches.every((entry, index) => entry === matchedPolicyNames[index])
  ) {
    throw new TypeError("policy trace does not bind its decision");
  }
  return trace as JsonObject;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function isPolicyEffect(value: unknown): value is PolicyEffect {
  return value === "allow" || value === "deny" || value === "require_approval";
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}

function policyEvaluationFailure(message: string) {
  return createDomainError({
    code: "policy_denied",
    message,
    details: { reason: "policy_evaluation_error" },
  });
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
