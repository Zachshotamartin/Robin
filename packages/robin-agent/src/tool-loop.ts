import { isProxy } from "node:util/types";

import {
  canonicalBytes,
  canonicalize,
  createDomainError,
  isDomainError,
  snapshotBoundaryJsonObject,
  type JsonObject,
} from "@guard/contracts";
import type { SemanticOperationDefinition } from "@guard/model-provider";

import { isValidProviderCallId } from "./provider-call-id.js";
import type { CompletedProviderToolCall } from "./provider-item-collector.js";

export interface ToolDispatcher {
  readonly advertisedOperations: readonly SemanticOperationDefinition[];
  /**
   * Trusted authority boundary: implementations validate `call.arguments`
   * against the exactly advertised schema before permission/effect handling.
   * The agent loop never imports or bypasses that application-owned pipeline.
   */
  dispatch(
    call: CompletedProviderToolCall,
    signal: AbortSignal,
  ): Promise<JsonObject>;
}

export interface SerializedToolLoopOptions {
  readonly maximumObservationBytes?: number;
  readonly maximumArgumentBytes?: number;
}

export interface ToolDispatchResult {
  readonly call: CompletedProviderToolCall;
  readonly observation: JsonObject;
}

export interface PreparedToolDispatch {
  readonly call: CompletedProviderToolCall;
  run(): Promise<ToolDispatchResult>;
}

/**
 * Narrow serialized bridge between the agent loop and the application-owned
 * tool dispatcher. It deliberately knows nothing about capability gateways.
 */
export class SerializedToolLoop {
  readonly #dispatcher: ToolDispatcher;
  readonly #advertisedOperations: readonly SemanticOperationDefinition[];
  readonly #advertisedKeys: ReadonlySet<string>;
  readonly #consumedCallIds = new Set<string>();
  readonly #maximumObservationBytes: number;
  readonly #maximumArgumentBytes: number;
  #tail: Promise<void> = Promise.resolve();

  public constructor(
    dispatcher: ToolDispatcher,
    options: SerializedToolLoopOptions = {},
  ) {
    if (
      typeof dispatcher !== "object" ||
      dispatcher === null ||
      typeof dispatcher.dispatch !== "function" ||
      !Array.isArray(dispatcher.advertisedOperations)
    ) {
      throw createDomainError({
        code: "invalid_input",
        message: "A valid tool dispatcher is required.",
      });
    }
    this.#advertisedOperations = captureOperations(
      dispatcher.advertisedOperations,
    );
    this.#advertisedKeys = new Set(
      this.#advertisedOperations.map(operationKey),
    );
    this.#dispatcher = Object.freeze({
      advertisedOperations: this.#advertisedOperations,
      dispatch: dispatcher.dispatch.bind(dispatcher),
    });
    const maximumObservationBytes = options.maximumObservationBytes ?? 262_144;
    if (!Number.isSafeInteger(maximumObservationBytes) || maximumObservationBytes <= 0) {
      throw createDomainError({
        code: "invalid_input",
        message: "maximumObservationBytes must be a positive safe integer.",
      });
    }
    this.#maximumObservationBytes = maximumObservationBytes;
    const maximumArgumentBytes = options.maximumArgumentBytes ?? 262_144;
    if (!Number.isSafeInteger(maximumArgumentBytes) || maximumArgumentBytes <= 0) {
      throw createDomainError({
        code: "invalid_input",
        message: "maximumArgumentBytes must be a positive safe integer.",
      });
    }
    this.#maximumArgumentBytes = maximumArgumentBytes;
  }

  public get advertisedOperations(): readonly SemanticOperationDefinition[] {
    return this.#advertisedOperations;
  }

  public dispatch(
    call: CompletedProviderToolCall,
    signal: AbortSignal,
  ): Promise<ToolDispatchResult> {
    try {
      return this.prepare(call, signal).run();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Validates and reserves a call before a public tool-started event. */
  public prepare(
    call: CompletedProviderToolCall,
    signal: AbortSignal,
  ): PreparedToolDispatch {
    const capturedCall = captureCompletedCall(call, this.#maximumArgumentBytes);
    this.#validateAndReserve(capturedCall, signal);
    let used = false;
    return Object.freeze({
      call: capturedCall,
      run: () => {
        if (used) {
          return Promise.reject(
            createDomainError({
              code: "conflict",
              message: "A prepared provider tool call may be run only once.",
            }),
          );
        }
        used = true;
        return this.#enqueue(capturedCall, signal);
      },
    });
  }

  #enqueue(
    call: CompletedProviderToolCall,
    signal: AbortSignal,
  ): Promise<ToolDispatchResult> {
    const result = this.#tail.then(() => this.#dispatch(call, signal));
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #validateAndReserve(
    call: CompletedProviderToolCall,
    signal: AbortSignal,
  ): void {
    if (signal.aborted) throw cancelled();
    if (!this.#advertisedKeys.has(operationKey(call))) {
      throw createDomainError({
        code: "invalid_input",
        message: "The provider requested a tool that was not exactly advertised.",
      });
    }
    if (this.#consumedCallIds.has(call.callId)) {
      throw createDomainError({
        code: "conflict",
        message: "A provider tool call identifier may be dispatched only once.",
      });
    }
    this.#consumedCallIds.add(call.callId);
  }

  async #dispatch(
    call: CompletedProviderToolCall,
    signal: AbortSignal,
  ): Promise<ToolDispatchResult> {
    if (signal.aborted) throw cancelled();
    let rawObservation: unknown;
    try {
      rawObservation = await this.#dispatcher.dispatch(call, signal);
    } catch (error) {
      if (isDomainError(error)) throw error;
      if (signal.aborted) throw cancelled();
      throw createDomainError({
        code: "action_failed",
        message: "The tool dispatcher failed without a classified result.",
      });
    }
    if (signal.aborted) throw cancelled();

    let observation: JsonObject;
    try {
      observation = snapshotBoundaryJsonObject(rawObservation, {
        maximumDepth: 32,
        maximumNodes: 16_384,
        maximumArrayLength: 4_096,
        maximumObjectProperties: 4_096,
        maximumStringUtf8Bytes: this.#maximumObservationBytes,
      });
    } catch {
      throw createDomainError({
        code: "action_failed",
        message: "The tool dispatcher returned an invalid observation.",
      });
    }
    if (canonicalBytes(observation).byteLength > this.#maximumObservationBytes) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "The tool observation exceeded its byte bound.",
      });
    }
    return Object.freeze({ call, observation });
  }
}

function captureOperations(
  operations: readonly SemanticOperationDefinition[],
): readonly SemanticOperationDefinition[] {
  if (operations.length > 256) {
    throw createDomainError({
      code: "invalid_input",
      message: "The tool advertisement exceeds its operation-count bound.",
    });
  }
  const seen = new Set<string>();
  return Object.freeze(
    operations.map((operation) => {
      if (typeof operation !== "object" || operation === null) {
        throw createDomainError({
          code: "invalid_input",
          message: "A tool advertisement contains an invalid operation.",
        });
      }
      const captured = Object.freeze({
        capabilityPackId: identifier(operation.capabilityPackId),
        capabilityPackVersion: version(operation.capabilityPackVersion),
        operationId: identifier(operation.operationId),
        operationVersion: version(operation.operationVersion),
        description: boundedText(operation.description),
        inputSchema: snapshotBoundaryJsonObject(operation.inputSchema),
      });
      const key = operationKey(captured);
      if (seen.has(key)) {
        throw createDomainError({
          code: "conflict",
          message: "A tool operation may be advertised only once.",
        });
      }
      seen.add(key);
      return captured;
    }),
  );
}

function operationKey(value: {
  readonly capabilityPackId: string;
  readonly capabilityPackVersion: number;
  readonly operationId: string;
  readonly operationVersion: number;
}): string {
  return JSON.stringify([
    value.capabilityPackId,
    value.capabilityPackVersion,
    value.operationId,
    value.operationVersion,
  ]);
}

function identifier(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)
  ) {
    throw createDomainError({
      code: "invalid_input",
      message: "A tool operation identity is invalid.",
    });
  }
  return value;
}

function version(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createDomainError({
      code: "invalid_input",
      message: "A tool operation version is invalid.",
    });
  }
  return value;
}

function boundedText(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 16_384
  ) {
    throw createDomainError({
      code: "invalid_input",
      message: "A tool operation description is invalid.",
    });
  }
  return value;
}

function captureCompletedCall(
  value: CompletedProviderToolCall,
  maximumArgumentBytes: number,
): CompletedProviderToolCall {
  const record = plainRecord(value);
  exactKeys(record, [
    "callId",
    "capabilityPackId",
    "capabilityPackVersion",
    "operationId",
    "operationVersion",
    "argumentsJson",
    "arguments",
  ]);
  const callId = opaqueCallId(record["callId"]);
  const argumentsJson = boundedArgumentJson(
    record["argumentsJson"],
    maximumArgumentBytes,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw invalidCall("A completed tool call contains malformed argument JSON.");
  }
  let argumentsValue: JsonObject;
  let parsedValue: JsonObject;
  try {
    const limits = {
      maximumDepth: 32,
      maximumNodes: 16_384,
      maximumArrayLength: 4_096,
      maximumObjectProperties: 4_096,
      maximumStringUtf8Bytes: maximumArgumentBytes,
    } as const;
    argumentsValue = snapshotBoundaryJsonObject(record["arguments"], limits);
    parsedValue = snapshotBoundaryJsonObject(parsed, limits);
  } catch {
    throw invalidCall("A completed tool call contains invalid arguments.");
  }
  if (
    canonicalBytes(argumentsValue).byteLength > maximumArgumentBytes ||
    canonicalize(argumentsValue) !== canonicalize(parsedValue)
  ) {
    throw invalidCall(
      "A completed tool call has divergent or oversized arguments.",
    );
  }
  return Object.freeze({
    callId,
    capabilityPackId: identifier(record["capabilityPackId"] as string),
    capabilityPackVersion: version(record["capabilityPackVersion"] as number),
    operationId: identifier(record["operationId"] as string),
    operationVersion: version(record["operationVersion"] as number),
    argumentsJson,
    arguments: argumentsValue,
  });
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
    throw invalidCall("A completed tool call must be a plain object.");
  }
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw invalidCall("A completed tool call has invalid fields.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw invalidCall("A completed tool call has invalid fields.");
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw invalidCall("A completed tool call has unknown or missing fields.");
  }
}

function opaqueCallId(value: unknown): string {
  if (!isValidProviderCallId(value)) {
    throw invalidCall("A completed tool call identifier is invalid.");
  }
  return value;
}

function boundedArgumentJson(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    containsUnpairedSurrogate(value)
  ) {
    throw invalidCall("Completed tool argument JSON is invalid or oversized.");
  }
  return value;
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

function invalidCall(message: string) {
  return createDomainError({ code: "invalid_input", message });
}

function cancelled() {
  return createDomainError({
    code: "cancelled",
    message: "Tool dispatch was cancelled.",
  });
}
