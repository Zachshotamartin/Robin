import {
  AgentAttemptIdKind,
  canonicalSha256Hex,
  canonicalize,
  createDomainError,
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
}

export interface SyntheticModelScript {
  readonly scriptId: string;
  readonly steps: readonly SyntheticModelStep[];
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
  #nextStep = 0;

  public constructor(script: SyntheticModelScript) {
    validateScript(script);
    this.#script = cloneAndFreeze(script);
  }

  public get remainingSteps(): number {
    return this.#script.steps.length - this.#nextStep;
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
    validateRequest(request, "request");

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
    const actualCanonical = canonicalize(request);
    if (actualCanonical !== expectedCanonical) {
      throw createDomainError({
        code: "invariant_violated",
        message: `Synthetic model request diverged at step ${this.#nextStep}.`,
        details: Object.freeze({
          scriptId: this.#script.scriptId,
          requestIndex: this.#nextStep,
          expectedRequestHash: canonicalSha256Hex(step.expectedRequest),
          actualRequestHash: canonicalSha256Hex(request),
        }),
      });
    }

    // Reserve only after successful validation. A divergent or pre-cancelled
    // request can therefore be corrected and retried against the same step.
    this.#nextStep += 1;

    for (const event of step.events) {
      // Provide a scheduling boundary so a consumer can deterministically
      // cancel between two events without timers or real transport activity.
      await Promise.resolve();
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
  nonEmptyString(script.scriptId, "script.scriptId");
  if (!Array.isArray(script.steps) || script.steps.length === 0) {
    invalidInput("Synthetic model script must contain at least one step.");
  }

  for (let index = 0; index < script.steps.length; index += 1) {
    const step = script.steps[index];
    if (!isRecord(step)) {
      invalidInput(`script.steps[${index}] must be a plain object.`);
    }
    validateRequest(
      step.expectedRequest as SemanticModelRequest,
      `script.steps[${index}].expectedRequest`,
    );
    validateEvents(step.events as readonly ModelProviderEvent[], index);
  }
}

function validateRequest(request: SemanticModelRequest, path: string): void {
  validatePlainData(request);
  if (!isRecord(request)) {
    invalidInput(`${path} must be a plain object.`);
  }
  if (request.schemaVersion !== MODEL_PROVIDER_SCHEMA_VERSION) {
    invalidInput(`${path}.schemaVersion must be ${MODEL_PROVIDER_SCHEMA_VERSION}.`);
  }
  if (!AgentAttemptIdKind.is(request.attemptId)) {
    invalidInput(`${path}.attemptId must be a valid AgentAttemptId.`);
  }
  if (!isRecord(request.model)) {
    invalidInput(`${path}.model must be a plain object.`);
  }
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
    if (typeof item.role !== "string" || !CONVERSATION_ROLES.has(item.role)) {
      invalidInput(`${path}.conversation[${index}].role is not supported.`);
    }
    if (!Array.isArray(item.content) || item.content.length === 0) {
      invalidInput(`${path}.conversation[${index}].content must not be empty.`);
    }
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
    nonEmptyString(operation.operationId, `${path}.operations[${index}].operationId`);
    positiveInteger(
      operation.operationVersion,
      `${path}.operations[${index}].operationVersion`,
    );
    nonEmptyString(operation.description, `${path}.operations[${index}].description`);
    if (!isRecord(operation.inputSchema)) {
      invalidInput(`${path}.operations[${index}].inputSchema must be a JSON object.`);
    }
    const key = `${operation.operationId}@${operation.operationVersion}`;
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

function validateEvents(events: readonly ModelProviderEvent[], stepIndex: number): void {
  if (!Array.isArray(events) || events.length === 0) {
    invalidInput(`script.steps[${stepIndex}].events must not be empty.`);
  }

  const startedActions = new Map<string, string>();
  let terminalCount = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const path = `script.steps[${stepIndex}].events[${index}]`;
    if (!isRecord(event) || typeof event.type !== "string") {
      invalidInput(`${path} must be a discriminated event object.`);
    }

    switch (event.type) {
      case "text_delta":
        nonNegativeInteger(event.outputIndex, `${path}.outputIndex`);
        nonEmptyString(event.delta, `${path}.delta`);
        break;
      case "content_completed":
        nonNegativeInteger(event.outputIndex, `${path}.outputIndex`);
        if (!isRecord(event.content)) {
          invalidInput(`${path}.content must be a content block.`);
        }
        break;
      case "action_started":
        nonEmptyString(event.callId, `${path}.callId`);
        nonEmptyString(event.operationId, `${path}.operationId`);
        if (startedActions.has(event.callId)) {
          invalidInput(`${path}.callId duplicates an earlier action call.`);
        }
        startedActions.set(event.callId, event.operationId);
        break;
      case "action_arguments_delta":
        nonEmptyString(event.callId, `${path}.callId`);
        nonEmptyString(event.delta, `${path}.delta`);
        if (!startedActions.has(event.callId)) {
          invalidInput(`${path} references an action call that has not started.`);
        }
        break;
      case "action_completed": {
        nonEmptyString(event.callId, `${path}.callId`);
        nonEmptyString(event.operationId, `${path}.operationId`);
        if (!isRecord(event.arguments)) {
          invalidInput(`${path}.arguments must be a JSON object.`);
        }
        const startedOperation = startedActions.get(event.callId);
        if (startedOperation === undefined) {
          invalidInput(`${path} references an action call that has not started.`);
        }
        if (startedOperation !== event.operationId) {
          invalidInput(`${path}.operationId differs from its action_started event.`);
        }
        startedActions.delete(event.callId);
        break;
      }
      case "usage_reported":
        validateDimensions(event.dimensions, `${path}.dimensions`);
        break;
      case "response_completed":
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
