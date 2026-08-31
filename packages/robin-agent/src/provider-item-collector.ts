import { isProxy } from "node:util/types";

import {
  canonicalBytes,
  canonicalize,
  createDomainError,
  parseContentBlock,
  snapshotBoundaryJsonObject,
  type DomainError,
  type JsonObject,
} from "@guard/contracts";
import type {
  ModelFailure,
  ModelFinishReason,
  ModelProviderEvent,
} from "@guard/model-provider";

import {
  MAXIMUM_PROVIDER_CALL_ID_BYTES,
  isValidProviderCallId,
} from "./provider-call-id.js";

export interface ProviderItemCollectorLimits {
  readonly maximumTextBytes: number;
  readonly maximumArgumentBytes: number;
  readonly maximumCallIdBytes: number;
  readonly maximumCalls: number;
}

export const DEFAULT_PROVIDER_ITEM_COLLECTOR_LIMITS: ProviderItemCollectorLimits =
  Object.freeze({
    maximumTextBytes: 262_144,
    maximumArgumentBytes: 262_144,
    maximumCallIdBytes: MAXIMUM_PROVIDER_CALL_ID_BYTES,
    maximumCalls: 64,
  });

export interface CompletedProviderToolCall {
  readonly callId: string;
  readonly capabilityPackId: string;
  readonly capabilityPackVersion: number;
  readonly operationId: string;
  readonly operationVersion: number;
  /** Exact fragments when supplied; otherwise canonical JSON for `arguments`. */
  readonly argumentsJson: string;
  readonly arguments: JsonObject;
}

export type ProviderCollectorLiveEvent =
  | {
      readonly type: "assistant_text_delta";
      readonly delta: string;
    }
  | {
      readonly type: "usage_reported";
      readonly dimensions: Readonly<Record<string, number>>;
    };

export interface CollectedProviderResponse {
  readonly text: string;
  readonly toolCalls: readonly CompletedProviderToolCall[];
  readonly usage: Readonly<Record<string, number>>;
  readonly finishReason: "stop" | "action_required";
}

interface PendingCall {
  readonly callId: string;
  readonly capabilityPackId: string;
  readonly capabilityPackVersion: number;
  readonly operationId: string;
  readonly operationVersion: number;
  argumentsJson: string;
}

type CapturedTerminal =
  | { readonly type: "response_completed"; readonly finishReason: ModelFinishReason }
  | { readonly type: "response_failed"; readonly failure: ModelFailure };

/**
 * Collects one provider response without allowing fragments to become tool
 * authority. Completed calls are released only after a valid terminal event
 * and a successful `finish()` validation.
 */
export class ProviderItemCollector {
  readonly #limits: ProviderItemCollectorLimits;
  readonly #pending = new Map<string, PendingCall>();
  readonly #seenCallIds = new Set<string>();
  readonly #completed: CompletedProviderToolCall[] = [];
  readonly #usage: Record<string, number> = {};
  #text = "";
  #contentCompleted = false;
  #terminal: CapturedTerminal | null = null;
  #observedProviderOutput = false;

  public constructor(limits: Partial<ProviderItemCollectorLimits> = {}) {
    this.#limits = captureLimits(limits);
  }

  public get hasObservedProviderOutput(): boolean {
    return this.#observedProviderOutput;
  }

  public get hasTerminalEvent(): boolean {
    return this.#terminal !== null;
  }

  public accept(rawEvent: ModelProviderEvent): ProviderCollectorLiveEvent | null {
    if (this.#terminal !== null) {
      throw providerFailure("The provider emitted data after its terminal event.");
    }
    const event = captureProviderEvent(rawEvent, this.#limits);
    switch (event.type) {
      case "text_delta": {
        if (
          this.#contentCompleted ||
          event.outputIndex !== 0 ||
          event.delta.length === 0 ||
          containsUnpairedSurrogate(event.delta)
        ) {
          throw providerFailure("The provider emitted an invalid text delta.");
        }
        this.#text = appendBounded(
          this.#text,
          event.delta,
          this.#limits.maximumTextBytes,
          "provider text",
        );
        this.#observedProviderOutput = true;
        return Object.freeze({ type: "assistant_text_delta", delta: event.delta });
      }
      case "content_completed": {
        if (
          this.#contentCompleted ||
          event.outputIndex !== 0 ||
          event.content.modality !== "text"
        ) {
          throw providerFailure("The provider emitted invalid completed content.");
        }
        const completed = event.content.text;
        if (containsUnpairedSurrogate(completed)) {
          throw providerFailure("The provider completed invalid text content.");
        }
        let synthesized: ProviderCollectorLiveEvent | null = null;
        if (this.#text.length === 0) {
          if (completed.length > 0) {
            this.#text = appendBounded(
              "",
              completed,
              this.#limits.maximumTextBytes,
              "provider text",
            );
            this.#observedProviderOutput = true;
            synthesized = Object.freeze({
              type: "assistant_text_delta",
              delta: completed,
            });
          }
        } else if (this.#text !== completed) {
          throw providerFailure(
            "The provider completed text that disagreed with its streamed text.",
          );
        }
        this.#contentCompleted = true;
        return synthesized;
      }
      case "action_started": {
        if (this.#seenCallIds.has(event.callId)) {
          throw providerFailure("The provider reused a tool call identifier.");
        }
        if (this.#seenCallIds.size >= this.#limits.maximumCalls) {
          throw budgetFailure("The provider tool-call count exceeded its bound.");
        }
        this.#seenCallIds.add(event.callId);
        this.#pending.set(event.callId, {
          callId: event.callId,
          capabilityPackId: event.capabilityPackId,
          capabilityPackVersion: event.capabilityPackVersion,
          operationId: event.operationId,
          operationVersion: event.operationVersion,
          argumentsJson: "",
        });
        this.#observedProviderOutput = true;
        return null;
      }
      case "action_arguments_delta": {
        const pending = this.#pending.get(event.callId);
        if (pending === undefined || event.delta.length === 0) {
          throw providerFailure(
            "The provider emitted arguments for a tool call that is not active.",
          );
        }
        pending.argumentsJson = appendBounded(
          pending.argumentsJson,
          event.delta,
          this.#limits.maximumArgumentBytes,
          "provider tool arguments",
        );
        this.#observedProviderOutput = true;
        return null;
      }
      case "action_completed": {
        const pending = this.#pending.get(event.callId);
        if (pending === undefined) {
          throw providerFailure(
            "The provider completed a tool call that is not active.",
          );
        }
        assertSameIdentity(pending, event);
        const argumentsValue = captureJsonObject(
          event.arguments,
          this.#limits.maximumArgumentBytes,
          "completed tool arguments",
        );
        const argumentsJson =
          pending.argumentsJson.length === 0
            ? canonicalize(argumentsValue)
            : validateArgumentAgreement(
                pending.argumentsJson,
                argumentsValue,
                this.#limits.maximumArgumentBytes,
              );
        const completed = Object.freeze({
          callId: pending.callId,
          capabilityPackId: pending.capabilityPackId,
          capabilityPackVersion: pending.capabilityPackVersion,
          operationId: pending.operationId,
          operationVersion: pending.operationVersion,
          argumentsJson,
          arguments: argumentsValue,
        });
        this.#pending.delete(event.callId);
        this.#completed.push(completed);
        this.#observedProviderOutput = true;
        return null;
      }
      case "usage_reported": {
        const dimensions = captureUsage(event.dimensions);
        for (const [name, count] of Object.entries(dimensions)) {
          const previous = this.#usage[name];
          if (previous !== undefined && count < previous) {
            throw providerFailure("The provider reported non-monotonic usage.");
          }
        }
        for (const [name, count] of Object.entries(dimensions)) {
          this.#usage[name] = count;
        }
        this.#observedProviderOutput = true;
        return Object.freeze({ type: "usage_reported", dimensions });
      }
      case "response_completed":
        this.#terminal = Object.freeze({
          type: event.type,
          finishReason: event.finishReason,
        });
        return null;
      case "response_failed":
        this.#terminal = Object.freeze({
          type: event.type,
          failure: event.failure,
        });
        return null;
    }
  }

  public finish(): CollectedProviderResponse {
    if (this.#terminal === null) {
      throw this.#observedProviderOutput
        ? uncertainFailure("The provider stream ended before a terminal event.")
        : providerFailure("The provider stream ended before a terminal event.");
    }
    if (this.#terminal.type === "response_failed") {
      const failure = this.#terminal.failure;
      const uncertain =
        this.#observedProviderOutput ||
        failure.retry === "uncertain" ||
        failure.resultCertainty !== "no_result";
      throw createDomainError({
        code: uncertain ? "provider_result_uncertain" : "provider_failed",
        message: `Provider failure (${failure.code}): ${failure.message}`,
        retry: uncertain ? "uncertain" : failure.retry,
        details: {
          providerCode: failure.code,
          resultCertainty: failure.resultCertainty,
          observedPartialOutput: this.#observedProviderOutput,
        },
      });
    }
    if (this.#pending.size !== 0) {
      throw uncertainFailure(
        "The provider terminated with one or more incomplete tool calls.",
      );
    }
    const finishReason = this.#terminal.finishReason;
    if (finishReason !== "stop" && finishReason !== "action_required") {
      throw providerFailure(
        `The provider returned unsupported finish reason ${finishReason}.`,
      );
    }
    if (finishReason === "action_required" && this.#completed.length === 0) {
      throw providerFailure(
        "The provider requested tool execution without a complete tool call.",
      );
    }
    if (finishReason === "stop" && this.#completed.length !== 0) {
      throw providerFailure(
        "The provider stopped while complete tool calls remained unresolved.",
      );
    }
    return Object.freeze({
      text: this.#text,
      toolCalls: Object.freeze([...this.#completed]),
      usage: Object.freeze({ ...this.#usage }),
      finishReason,
    });
  }
}

function captureProviderEvent(
  value: ModelProviderEvent,
  limits: ProviderItemCollectorLimits,
): ModelProviderEvent {
  const record = plainRecord(value);
  const type = record["type"];
  if (typeof type !== "string") throw providerFailure("Invalid provider event.");
  switch (type) {
    case "text_delta":
      exactKeys(record, ["type", "outputIndex", "delta"]);
      return Object.freeze({
        type,
        outputIndex: nonNegativeInteger(record["outputIndex"]),
        delta: requiredString(record["delta"]),
      });
    case "content_completed": {
      exactKeys(record, ["type", "outputIndex", "content"]);
      try {
        return Object.freeze({
          type,
          outputIndex: nonNegativeInteger(record["outputIndex"]),
          content: parseContentBlock(record["content"]),
        });
      } catch {
        throw providerFailure("Invalid provider completed content.");
      }
    }
    case "action_started":
      exactKeys(record, [
        "type",
        "callId",
        "capabilityPackId",
        "capabilityPackVersion",
        "operationId",
        "operationVersion",
      ]);
      return Object.freeze({
        type,
        callId: captureCallId(record["callId"], limits.maximumCallIdBytes),
        capabilityPackId: boundedIdentifier(record["capabilityPackId"]),
        capabilityPackVersion: positiveInteger(record["capabilityPackVersion"]),
        operationId: boundedIdentifier(record["operationId"]),
        operationVersion: positiveInteger(record["operationVersion"]),
      });
    case "action_arguments_delta":
      exactKeys(record, ["type", "callId", "delta"]);
      return Object.freeze({
        type,
        callId: captureCallId(record["callId"], limits.maximumCallIdBytes),
        delta: requiredString(record["delta"]),
      });
    case "action_completed":
      exactKeys(record, [
        "type",
        "callId",
        "capabilityPackId",
        "capabilityPackVersion",
        "operationId",
        "operationVersion",
        "arguments",
      ]);
      return Object.freeze({
        type,
        callId: captureCallId(record["callId"], limits.maximumCallIdBytes),
        capabilityPackId: boundedIdentifier(record["capabilityPackId"]),
        capabilityPackVersion: positiveInteger(record["capabilityPackVersion"]),
        operationId: boundedIdentifier(record["operationId"]),
        operationVersion: positiveInteger(record["operationVersion"]),
        arguments: captureJsonObject(
          record["arguments"],
          limits.maximumArgumentBytes,
          "provider tool arguments",
        ),
      });
    case "usage_reported":
      exactKeys(record, ["type", "dimensions"]);
      return Object.freeze({ type, dimensions: captureUsage(record["dimensions"]) });
    case "response_completed": {
      exactKeys(record, ["type", "finishReason"]);
      const finishReason = record["finishReason"];
      if (
        typeof finishReason !== "string" ||
        !new Set(["stop", "action_required", "length", "content_filter", "other"]).has(
          finishReason,
        )
      ) {
        throw providerFailure("Invalid provider finish reason.");
      }
      return Object.freeze({
        type,
        finishReason: finishReason as ModelFinishReason,
      });
    }
    case "response_failed":
      exactKeys(record, ["type", "failure"]);
      return Object.freeze({ type, failure: captureFailure(record["failure"]) });
    default:
      throw providerFailure("The provider emitted an unknown event.");
  }
}

function captureFailure(value: unknown): ModelFailure {
  const record = plainRecord(value);
  exactKeys(record, ["code", "message", "retry", "resultCertainty"]);
  const code = requiredString(record["code"]);
  const message = requiredString(record["message"]);
  const retry = record["retry"];
  const resultCertainty = record["resultCertainty"];
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(code) ||
    message.trim().length === 0 ||
    Buffer.byteLength(message, "utf8") > 4_096 ||
    containsUnsafeDiagnosticText(message) ||
    (retry !== "terminal" && retry !== "retryable" && retry !== "uncertain") ||
    (resultCertainty !== "no_result" &&
      resultCertainty !== "partial_result" &&
      resultCertainty !== "uncertain")
  ) {
    throw providerFailure("Invalid provider failure record.");
  }
  return Object.freeze({ code, message, retry, resultCertainty });
}

function captureUsage(value: unknown): Readonly<Record<string, number>> {
  const record = plainRecord(value);
  const names = Object.keys(record);
  if (names.length > 64) throw providerFailure("Invalid provider usage.");
  const captured: Record<string, number> = {};
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(name)) {
      throw providerFailure("Invalid provider usage.");
    }
    const count = record[name];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw providerFailure("Invalid provider usage.");
    }
    captured[name] = count as number;
  }
  return Object.freeze(captured);
}

function captureJsonObject(
  value: unknown,
  maximumBytes: number,
  label: string,
): JsonObject {
  let captured: JsonObject;
  try {
    captured = snapshotBoundaryJsonObject(value, {
      maximumDepth: 32,
      maximumNodes: 16_384,
      maximumArrayLength: 4_096,
      maximumObjectProperties: 4_096,
      maximumStringUtf8Bytes: maximumBytes,
    });
  } catch {
    throw providerFailure(`The ${label} are invalid.`);
  }
  if (canonicalBytes(captured).byteLength > maximumBytes) {
    throw budgetFailure(`The ${label} exceed their byte bound.`);
  }
  return captured;
}

function validateArgumentAgreement(
  raw: string,
  completed: JsonObject,
  maximumBytes: number,
): string {
  if (containsUnpairedSurrogate(raw)) {
    throw providerFailure("The provider emitted invalid tool argument text.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw providerFailure("The provider emitted malformed tool argument JSON.");
  }
  const captured = captureJsonObject(
    parsed,
    maximumBytes,
    "streamed tool arguments",
  );
  if (canonicalize(captured) !== canonicalize(completed)) {
    throw providerFailure(
      "The provider completed tool arguments that disagreed with their stream.",
    );
  }
  return raw;
}

function assertSameIdentity(
  pending: PendingCall,
  completed: Extract<ModelProviderEvent, { readonly type: "action_completed" }>,
): void {
  if (
    pending.capabilityPackId !== completed.capabilityPackId ||
    pending.capabilityPackVersion !== completed.capabilityPackVersion ||
    pending.operationId !== completed.operationId ||
    pending.operationVersion !== completed.operationVersion
  ) {
    throw providerFailure(
      "The provider changed a tool call identity while completing it.",
    );
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw providerFailure("Invalid provider event.");
  }
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw providerFailure("Invalid provider event.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw providerFailure("Invalid provider event.");
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(record);
  const allowed = new Set(expected);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw providerFailure("Invalid provider event fields.");
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw providerFailure("Invalid provider string field.");
  }
  return value;
}

function boundedIdentifier(value: unknown): string {
  const captured = requiredString(value);
  if (
    Buffer.byteLength(captured, "utf8") > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(captured)
  ) {
    throw providerFailure("Invalid provider operation identity.");
  }
  return captured;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw providerFailure("Invalid provider integer field.");
  }
  return value as number;
}

function positiveInteger(value: unknown): number {
  const captured = nonNegativeInteger(value);
  if (captured === 0) throw providerFailure("Invalid provider version field.");
  return captured;
}

function validateCallId(value: string, maximumBytes: number): void {
  if (!isValidProviderCallId(value, maximumBytes)) {
    throw providerFailure("Invalid provider tool call identifier.");
  }
}

function captureCallId(value: unknown, maximumBytes: number): string {
  const captured = requiredString(value);
  validateCallId(captured, maximumBytes);
  return captured;
}

function appendBounded(
  current: string,
  delta: string,
  maximumBytes: number,
  label: string,
): string {
  const combined = current + delta;
  if (Buffer.byteLength(combined, "utf8") > maximumBytes) {
    throw budgetFailure(`The ${label} exceeded its byte bound.`);
  }
  return combined;
}

function captureLimits(
  value: Partial<ProviderItemCollectorLimits>,
): ProviderItemCollectorLimits {
  const limits = { ...DEFAULT_PROVIDER_ITEM_COLLECTOR_LIMITS, ...value };
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw createDomainError({
        code: "invalid_input",
        message: `${name} must be a positive safe integer.`,
      });
    }
  }
  if (limits.maximumCallIdBytes > MAXIMUM_PROVIDER_CALL_ID_BYTES) {
    throw createDomainError({
      code: "invalid_input",
      message: `maximumCallIdBytes cannot exceed ${MAXIMUM_PROVIDER_CALL_ID_BYTES}.`,
    });
  }
  return Object.freeze(limits);
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function containsUnsafeDiagnosticText(value: string): boolean {
  if (containsUnpairedSurrogate(value)) return true;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

function providerFailure(message: string): DomainError {
  return createDomainError({ code: "provider_failed", message });
}

function uncertainFailure(message: string): DomainError {
  return createDomainError({
    code: "provider_result_uncertain",
    message,
    retry: "uncertain",
  });
}

function budgetFailure(message: string): DomainError {
  return createDomainError({ code: "budget_exceeded", message });
}
