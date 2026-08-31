import { isProxy } from "node:util/types";

import {
  AgentAttemptIdKind,
  canonicalSha256Hex,
  canonicalize,
  createDomainError,
  parseContentBlock,
} from "@guard/contracts";

import {
  cloneAndFreeze,
  invalidInput,
  isRecord,
  nonEmptyString,
  nonNegativeInteger,
  positiveInteger,
  validatePlainData,
} from "./immutable.js";
import {
  MODEL_PROVIDER_SCHEMA_VERSION,
  type ModelProvider,
  type ModelProviderDescriptor,
  type ModelProviderEvent,
  type SemanticModelRequest,
} from "./model-provider.js";

export interface SyntheticModelStep {
  /** Exact semantic request expected at this zero-based script position. */
  readonly expectedRequest: SemanticModelRequest;
  /** Complete normalized response stream, including its terminal event. */
  readonly events: readonly ModelProviderEvent[];
  /** Optional deterministic delay before each corresponding event. */
  readonly delaysBeforeEventsMs?: readonly number[];
}

export interface SyntheticModelScript {
  readonly scriptId: string;
  readonly steps: readonly SyntheticModelStep[];
}

export interface SyntheticModelProviderOptions {
  /** Injectable scheduler used by fake clocks; defaults to an abort-aware timer. */
  readonly delay?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => void | Promise<void>;
}

const SYNTHETIC_DESCRIPTOR: ModelProviderDescriptor = Object.freeze({
  adapterId: "guard.synthetic-model-provider",
  adapterVersion: "1.0.0",
  capabilities: Object.freeze({
    streaming: true,
    structuredActions: true,
    exactUsage: true,
    cancellation: "confirmed",
  }),
});

const FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "action_required",
  "length",
  "content_filter",
  "other",
]);
const FAILURE_RETRIES: ReadonlySet<string> = new Set([
  "terminal",
  "retryable",
  "uncertain",
]);
const RESULT_CERTAINTIES: ReadonlySet<string> = new Set([
  "no_result",
  "partial_result",
  "uncertain",
]);
const CONVERSATION_ROLES: ReadonlySet<string> = new Set([
  "developer",
  "user",
  "assistant",
  "operation",
]);

/**
 * Deterministic executable fixture for provider-port and direct-driver tests.
 * The constructor snapshots and freezes the script so fixture owners cannot
 * alter future output by retaining a mutable reference. No background request
 * exists: cancellation before reservation preserves the step, while later
 * cancellation is confirmed before another event can be yielded.
 */
export class SyntheticModelProvider implements ModelProvider {
  public readonly descriptor = SYNTHETIC_DESCRIPTOR;

  readonly #script: SyntheticModelScript;
  readonly #delay: (
    milliseconds: number,
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly #capturedRequestBytes: Uint8Array[] = [];
  #nextStep = 0;

  public constructor(
    script: SyntheticModelScript,
    options: SyntheticModelProviderOptions = {},
  ) {
    const snapshot = cloneAndFreeze(script);
    validateScript(snapshot);
    this.#script = snapshot;
    this.#delay = captureDelay(options);
  }

  public get remainingSteps(): number {
    return this.#script.steps.length - this.#nextStep;
  }

  /**
   * Exact UTF-8 bytes produced by this synthetic adapter for accepted semantic
   * requests. Each access returns new byte arrays so a test cannot mutate the
   * adapter's evidence. No bytes are recorded for invalid, divergent, or
   * pre-cancelled requests because those never reach the provider boundary.
   */
  public get capturedRequestBytes(): readonly Uint8Array[] {
    return Object.freeze(
      this.#capturedRequestBytes.map((bytes) => Uint8Array.from(bytes)),
    );
  }

  public respond(
    request: SemanticModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelProviderEvent> {
    return this.#respond(request, signal);
  }

  public assertExhausted(): void {
    if (this.remainingSteps !== 0) {
      throw createDomainError({
        code: "invariant_violated",
        message: `Synthetic model script ended with ${this.remainingSteps} unconsumed step(s).`,
        details: Object.freeze({
          scriptId: this.#script.scriptId,
          nextStep: this.#nextStep,
          remainingSteps: this.remainingSteps,
        }),
      });
    }
  }

  async *#respond(
    request: SemanticModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelProviderEvent, void, undefined> {
    throwIfCancelled(signal);
    const requestSnapshot = cloneAndFreeze(request);
    validateRequest(requestSnapshot, "request");

    const step = this.#script.steps[this.#nextStep];
    if (step === undefined) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Synthetic model script received a request after its final step.",
        details: Object.freeze({
          scriptId: this.#script.scriptId,
          requestIndex: this.#nextStep,
        }),
      });
    }

    const expectedCanonical = canonicalize(step.expectedRequest);
    const actualCanonical = canonicalize(requestSnapshot);
    if (actualCanonical !== expectedCanonical) {
      throw createDomainError({
        code: "invariant_violated",
        message: `Synthetic model request diverged at step ${this.#nextStep}.`,
        details: Object.freeze({
          scriptId: this.#script.scriptId,
          requestIndex: this.#nextStep,
          expectedRequestHash: canonicalSha256Hex(step.expectedRequest),
          actualRequestHash: canonicalSha256Hex(requestSnapshot),
        }),
      });
    }

    this.#capturedRequestBytes.push(
      new TextEncoder().encode(actualCanonical),
    );
    // Reserve only after successful validation. A divergent or pre-cancelled
    // request can therefore be corrected and retried against the same step.
    this.#nextStep += 1;

    for (let index = 0; index < step.events.length; index += 1) {
      const event = step.events[index]!;
      const delayMs = step.delaysBeforeEventsMs?.[index] ?? 0;
      try {
        await this.#delay(delayMs, signal);
      } catch {
        if (signal.aborted) throwCancelled();
        throw createDomainError({
          code: "infrastructure_failed",
          message: "The synthetic model delay scheduler failed.",
        });
      }
      throwIfCancelled(signal);
      yield event;
    }
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createDomainError({
      code: "cancelled",
      message: "Synthetic model response was cancelled.",
    });
  }
}

function validateScript(script: SyntheticModelScript): void {
  validatePlainData(script);
  if (!isRecord(script)) {
    invalidInput("Synthetic model script must be a plain object.");
  }
  requireExactKeys(script, ["scriptId", "steps"], "script");
  nonEmptyString(script.scriptId, "script.scriptId");
  if (!Array.isArray(script.steps) || script.steps.length === 0) {
    invalidInput("Synthetic model script must contain at least one step.");
  }

  for (let index = 0; index < script.steps.length; index += 1) {
    const step = script.steps[index];
    if (!isRecord(step)) {
      invalidInput(`script.steps[${index}] must be a plain object.`);
    }
    const delayPath = `script.steps[${index}].delaysBeforeEventsMs`;
    const hasDelays = Object.hasOwn(step, "delaysBeforeEventsMs");
    requireExactKeys(
      step,
      hasDelays
        ? ["expectedRequest", "events", "delaysBeforeEventsMs"]
        : ["expectedRequest", "events"],
      `script.steps[${index}]`,
    );
    validateRequest(
      step.expectedRequest as SemanticModelRequest,
      `script.steps[${index}].expectedRequest`,
    );
    validateEvents(
      step.events as readonly ModelProviderEvent[],
      index,
      step.expectedRequest as SemanticModelRequest,
    );
    if (hasDelays) {
      if (
        !Array.isArray(step.delaysBeforeEventsMs) ||
        step.delaysBeforeEventsMs.length !==
          (step.events as readonly ModelProviderEvent[]).length
      ) {
        invalidInput(`${delayPath} must contain one delay per event.`);
      }
      step.delaysBeforeEventsMs.forEach((delay, delayIndex) => {
        nonNegativeInteger(delay, `${delayPath}[${delayIndex}]`);
      });
    }
  }
}

function captureDelay(
  options: SyntheticModelProviderOptions,
): (milliseconds: number, signal: AbortSignal) => void | Promise<void> {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null)
  ) {
    invalidInput("Synthetic model provider options must be a plain object.");
  }
  const keys = Reflect.ownKeys(options);
  if (
    keys.some((key) => key !== "delay") ||
    keys.length > 1
  ) {
    invalidInput("Synthetic model provider options have unknown fields.");
  }
  if (keys.length === 0) return defaultDelay;
  const descriptor = Object.getOwnPropertyDescriptor(options, "delay");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== true ||
    typeof descriptor.value !== "function"
  ) {
    invalidInput("Synthetic model provider delay must be a function.");
  }
  return descriptor.value as (
    milliseconds: number,
    signal: AbortSignal,
  ) => void | Promise<void>;
}

async function defaultDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds === 0) {
    await Promise.resolve();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(cancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelledError() {
  return createDomainError({
    code: "cancelled",
    message: "Synthetic model response was cancelled.",
  });
}

function throwCancelled(): never {
  throw cancelledError();
}

function validateRequest(request: SemanticModelRequest, path: string): void {
  validatePlainData(request);
  if (!isRecord(request)) {
    invalidInput(`${path} must be a plain object.`);
  }
  requireExactKeys(
    request,
    [
      "schemaVersion",
      "attemptId",
      "model",
      "instructions",
      "conversation",
      "operations",
      "maximumOutputUnits",
      "actionMode",
      "metadata",
    ],
    path,
  );
  if (request.schemaVersion !== MODEL_PROVIDER_SCHEMA_VERSION) {
    invalidInput(`${path}.schemaVersion must be ${MODEL_PROVIDER_SCHEMA_VERSION}.`);
  }
  if (!AgentAttemptIdKind.is(request.attemptId)) {
    invalidInput(`${path}.attemptId must be a valid AgentAttemptId.`);
  }
  if (!isRecord(request.model)) {
    invalidInput(`${path}.model must be a plain object.`);
  }
  requireExactKeys(request.model, ["modelId", "settings"], `${path}.model`);
  nonEmptyString(request.model.modelId, `${path}.model.modelId`);
  if (!isRecord(request.model.settings)) {
    invalidInput(`${path}.model.settings must be a JSON object.`);
  }
  if (!Array.isArray(request.instructions)) {
    invalidInput(`${path}.instructions must be an array.`);
  }
  request.instructions.forEach((instruction, index) => {
    nonEmptyString(instruction, `${path}.instructions[${index}]`);
  });
  if (!Array.isArray(request.conversation)) {
    invalidInput(`${path}.conversation must be an array.`);
  }
  for (let index = 0; index < request.conversation.length; index += 1) {
    const item = request.conversation[index];
    if (!isRecord(item)) {
      invalidInput(`${path}.conversation[${index}] must be a plain object.`);
    }
    requireExactKeys(
      item,
      item.correlationId === undefined
        ? ["role", "content"]
        : ["role", "content", "correlationId"],
      `${path}.conversation[${index}]`,
    );
    if (typeof item.role !== "string" || !CONVERSATION_ROLES.has(item.role)) {
      invalidInput(`${path}.conversation[${index}].role is not supported.`);
    }
    if (!Array.isArray(item.content) || item.content.length === 0) {
      invalidInput(`${path}.conversation[${index}].content must not be empty.`);
    }
    item.content.forEach((content) => parseContentBlock(content));
    if (item.correlationId !== undefined) {
      nonEmptyString(item.correlationId, `${path}.conversation[${index}].correlationId`);
    }
  }
  if (!Array.isArray(request.operations)) {
    invalidInput(`${path}.operations must be an array.`);
  }
  const operationKeys = new Set<string>();
  for (let index = 0; index < request.operations.length; index += 1) {
    const operation = request.operations[index];
    if (!isRecord(operation)) {
      invalidInput(`${path}.operations[${index}] must be a plain object.`);
    }
    requireExactKeys(
      operation,
      [
        "capabilityPackId",
        "capabilityPackVersion",
        "operationId",
        "operationVersion",
        "description",
        "inputSchema",
      ],
      `${path}.operations[${index}]`,
    );
    nonEmptyString(
      operation.capabilityPackId,
      `${path}.operations[${index}].capabilityPackId`,
    );
    positiveInteger(
      operation.capabilityPackVersion,
      `${path}.operations[${index}].capabilityPackVersion`,
    );
    nonEmptyString(operation.operationId, `${path}.operations[${index}].operationId`);
    positiveInteger(
      operation.operationVersion,
      `${path}.operations[${index}].operationVersion`,
    );
    nonEmptyString(operation.description, `${path}.operations[${index}].description`);
    if (!isRecord(operation.inputSchema)) {
      invalidInput(`${path}.operations[${index}].inputSchema must be a JSON object.`);
    }
    const key = operationKey(
      operation.capabilityPackId,
      operation.capabilityPackVersion,
      operation.operationId,
      operation.operationVersion,
    );
    if (operationKeys.has(key)) {
      invalidInput(`${path}.operations contains duplicate operation ${key}.`);
    }
    operationKeys.add(key);
  }
  positiveInteger(request.maximumOutputUnits, `${path}.maximumOutputUnits`);
  if (request.actionMode !== "structured" && request.actionMode !== "none") {
    invalidInput(`${path}.actionMode is not supported.`);
  }
  if (request.actionMode === "none" && request.operations.length !== 0) {
    invalidInput(`${path}.operations must be empty when actionMode is none.`);
  }
  if (!isRecord(request.metadata)) {
    invalidInput(`${path}.metadata must be a JSON object.`);
  }
}

function validateEvents(
  events: readonly ModelProviderEvent[],
  stepIndex: number,
  request: SemanticModelRequest,
): void {
  if (!Array.isArray(events) || events.length === 0) {
    invalidInput(`script.steps[${stepIndex}].events must not be empty.`);
  }

  const startedActions = new Map<string, string>();
  const advertisedOperations = new Set(
    request.operations.map((operation) =>
      operationKey(
        operation.capabilityPackId,
        operation.capabilityPackVersion,
        operation.operationId,
        operation.operationVersion,
      ),
    ),
  );
  let terminalCount = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const path = `script.steps[${stepIndex}].events[${index}]`;
    if (!isRecord(event) || typeof event.type !== "string") {
      invalidInput(`${path} must be a discriminated event object.`);
    }

    switch (event.type) {
      case "text_delta":
        requireExactKeys(event, ["type", "outputIndex", "delta"], path);
        nonNegativeInteger(event.outputIndex, `${path}.outputIndex`);
        nonEmptyString(event.delta, `${path}.delta`);
        break;
      case "content_completed":
        requireExactKeys(event, ["type", "outputIndex", "content"], path);
        nonNegativeInteger(event.outputIndex, `${path}.outputIndex`);
        parseContentBlock(event.content);
        break;
      case "action_started":
        requireExactKeys(
          event,
          [
            "type",
            "callId",
            "capabilityPackId",
            "capabilityPackVersion",
            "operationId",
            "operationVersion",
          ],
          path,
        );
        if (request.actionMode !== "structured") {
          invalidInput(`${path} is forbidden when actionMode is none.`);
        }
        nonEmptyString(event.callId, `${path}.callId`);
        nonEmptyString(event.capabilityPackId, `${path}.capabilityPackId`);
        positiveInteger(event.capabilityPackVersion, `${path}.capabilityPackVersion`);
        nonEmptyString(event.operationId, `${path}.operationId`);
        positiveInteger(event.operationVersion, `${path}.operationVersion`);
        if (startedActions.has(event.callId)) {
          invalidInput(`${path}.callId duplicates an earlier action call.`);
        }
        const startedOperation = operationKey(
          event.capabilityPackId,
          event.capabilityPackVersion,
          event.operationId,
          event.operationVersion,
        );
        if (!advertisedOperations.has(startedOperation)) {
          invalidInput(`${path} references an operation that was not exactly advertised.`);
        }
        startedActions.set(event.callId, startedOperation);
        break;
      case "action_arguments_delta":
        requireExactKeys(event, ["type", "callId", "delta"], path);
        nonEmptyString(event.callId, `${path}.callId`);
        nonEmptyString(event.delta, `${path}.delta`);
        if (!startedActions.has(event.callId)) {
          invalidInput(`${path} references an action call that has not started.`);
        }
        break;
      case "action_completed": {
        requireExactKeys(
          event,
          [
            "type",
            "callId",
            "capabilityPackId",
            "capabilityPackVersion",
            "operationId",
            "operationVersion",
            "arguments",
          ],
          path,
        );
        nonEmptyString(event.callId, `${path}.callId`);
        nonEmptyString(event.capabilityPackId, `${path}.capabilityPackId`);
        positiveInteger(event.capabilityPackVersion, `${path}.capabilityPackVersion`);
        nonEmptyString(event.operationId, `${path}.operationId`);
        positiveInteger(event.operationVersion, `${path}.operationVersion`);
        if (!isRecord(event.arguments)) {
          invalidInput(`${path}.arguments must be a JSON object.`);
        }
        const startedOperation = startedActions.get(event.callId);
        if (startedOperation === undefined) {
          invalidInput(`${path} references an action call that has not started.`);
        }
        if (
          startedOperation !==
          operationKey(
            event.capabilityPackId,
            event.capabilityPackVersion,
            event.operationId,
            event.operationVersion,
          )
        ) {
          invalidInput(`${path} differs from its exact action_started identity.`);
        }
        startedActions.delete(event.callId);
        break;
      }
      case "usage_reported":
        requireExactKeys(event, ["type", "dimensions"], path);
        validateDimensions(event.dimensions, `${path}.dimensions`);
        break;
      case "response_completed":
        requireExactKeys(event, ["type", "finishReason"], path);
        if (
          typeof event.finishReason !== "string" ||
          !FINISH_REASONS.has(event.finishReason)
        ) {
          invalidInput(`${path}.finishReason is not supported.`);
        }
        terminalCount += 1;
        validateTerminalPosition(index, events.length, path);
        if (startedActions.size !== 0) {
          invalidInput(`${path} cannot complete with unfinished action calls.`);
        }
        break;
      case "response_failed":
        requireExactKeys(event, ["type", "failure"], path);
        validateFailure(event.failure, `${path}.failure`);
        terminalCount += 1;
        validateTerminalPosition(index, events.length, path);
        break;
      default:
        invalidInput(`${path}.type is unknown.`);
    }
  }

  if (terminalCount !== 1) {
    invalidInput(`script.steps[${stepIndex}].events must contain exactly one terminal event.`);
  }
}

function operationKey(
  capabilityPackId: string,
  capabilityPackVersion: number,
  operationId: string,
  operationVersion: number,
): string {
  return canonicalize([
    capabilityPackId,
    capabilityPackVersion,
    operationId,
    operationVersion,
  ]);
}

function validateTerminalPosition(index: number, length: number, path: string): void {
  if (index !== length - 1) {
    invalidInput(`${path} is terminal and must be the final event.`);
  }
}

function validateDimensions(value: unknown, path: string): void {
  if (!isRecord(value)) {
    invalidInput(`${path} must be a JSON object.`);
  }
  for (const [name, count] of Object.entries(value)) {
    nonEmptyString(name, `${path} key`);
    nonNegativeInteger(count, `${path}.${name}`);
  }
}

function validateFailure(failure: unknown, path: string): void {
  if (!isRecord(failure)) {
    invalidInput(`${path} must be a plain object.`);
  }
  requireExactKeys(
    failure,
    ["code", "message", "retry", "resultCertainty"],
    path,
  );
  nonEmptyString(failure.code, `${path}.code`);
  nonEmptyString(failure.message, `${path}.message`);
  if (typeof failure.retry !== "string" || !FAILURE_RETRIES.has(failure.retry)) {
    invalidInput(`${path}.retry is not supported.`);
  }
  if (
    typeof failure.resultCertainty !== "string" ||
    !RESULT_CERTAINTIES.has(failure.resultCertainty)
  ) {
    invalidInput(`${path}.resultCertainty is not supported.`);
  }
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  path: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    invalidInput(`${path} has unknown or missing fields.`);
  }
}
