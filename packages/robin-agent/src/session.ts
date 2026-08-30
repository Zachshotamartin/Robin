import {
  CONTRACT_SCHEMA_VERSION,
  AgentAttemptIdKind,
  createDomainError,
  isDomainError,
  parseDomainError,
  parseContentBlock,
  sha256Hex,
  type AgentAttemptId,
  type ContentBlock,
  type DomainError,
  type JsonObject,
} from "@guard/contracts";
import {
  MODEL_PROVIDER_SCHEMA_VERSION,
  type ModelFinishReason,
  type ModelProvider,
  type ModelProviderDescriptor,
  type ModelProviderEvent,
  type ModelFailure,
  type SemanticConversationItem,
  type SemanticModelRequest,
} from "@guard/model-provider";
import { isProxy } from "node:util/types";

export const ROBIN_AGENT_EVENT_SCHEMA_VERSION = 1 as const;
export const MAXIMUM_DIRECT_MODEL_PROMPT_BYTES = 65_536;
export const MAXIMUM_DIRECT_MODEL_HISTORY_BYTES = 1_048_576;

type RobinAgentEventSchemaVersion = typeof ROBIN_AGENT_EVENT_SCHEMA_VERSION;

export interface RobinConversationMessage {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnNumber: number;
  readonly capturedAt: string;
}

interface RobinAgentEventBase {
  readonly schemaVersion: RobinAgentEventSchemaVersion;
  readonly turnNumber: number;
}

export interface RobinTurnFailure {
  readonly code: DomainError["code"];
  readonly message: string;
  readonly retry: DomainError["retry"];
  readonly details?: JsonObject;
}

export type RobinAgentEvent = RobinAgentEventBase &
  (
    | {
      readonly type: "turn_started";
    }
    | {
      readonly type: "assistant_text_delta";
      readonly delta: string;
    }
    | {
      readonly type: "usage_reported";
      readonly dimensions: Readonly<Record<string, number>>;
    }
    | {
      readonly type: "turn_completed";
      readonly text: string;
    }
    | {
      readonly type: "turn_failed";
      readonly error: RobinTurnFailure;
    }
    | {
      readonly type: "turn_cancelled";
      readonly error: RobinTurnFailure;
    }
  );

export interface DirectModelSessionClock {
  now(): string;
}

export interface DirectModelSessionIdSource {
  nextAttemptId(): AgentAttemptId;
}

export interface DirectModelSessionLimits {
  readonly maximumPromptBytes: number;
  readonly maximumAssistantBytes: number;
  readonly maximumHistoryBytes: number;
  readonly maximumProviderEvents: number;
  readonly maximumTurns: number;
}

export const DEFAULT_DIRECT_MODEL_SESSION_LIMITS: DirectModelSessionLimits =
  Object.freeze({
    maximumPromptBytes: MAXIMUM_DIRECT_MODEL_PROMPT_BYTES,
    maximumAssistantBytes: 262_144,
    maximumHistoryBytes: MAXIMUM_DIRECT_MODEL_HISTORY_BYTES,
    maximumProviderEvents: 4_096,
    maximumTurns: 256,
  });

export const DEFAULT_DIRECT_MODEL_SESSION_IDS: DirectModelSessionIdSource =
  Object.freeze({
    nextAttemptId: () => AgentAttemptIdKind.generate(),
  });

export interface DirectModelSessionOptions {
  readonly sessionId: string;
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly clock: DirectModelSessionClock;
  readonly ids: DirectModelSessionIdSource;
  readonly limits?: Partial<DirectModelSessionLimits>;
  readonly instructions?: readonly string[];
}

const DEFAULT_INSTRUCTIONS = Object.freeze([
  "You are Robin, a coding agent. State only observable work and results.",
  "This preview has no repository or process tools. Never claim that a file was read, changed, or tested.",
]);

/**
 * Owns the provider-neutral conversation used by the initial R1 preview. This
 * preview foundation advertises no tools; structured tool handling enters
 * through the same loop in the planned complete R1 slice.
 */
export class DirectModelSession {
  readonly #sessionId: string;
  readonly #provider: ModelProvider;
  readonly #modelId: string;
  readonly #clock: DirectModelSessionClock;
  readonly #ids: DirectModelSessionIdSource;
  readonly #limits: DirectModelSessionLimits;
  readonly #instructions: readonly string[];
  readonly #history: RobinConversationMessage[] = [];
  #active = false;
  #turnsStarted = 0;

  public constructor(options: DirectModelSessionOptions) {
    this.#sessionId = boundedIdentifier(options.sessionId, "sessionId");
    this.#modelId = boundedIdentifier(options.modelId, "modelId");
    this.#provider = captureProvider(options.provider);
    this.#clock = captureClock(options.clock);
    this.#ids = captureIds(options.ids);
    this.#limits = captureLimits(options.limits);
    this.#instructions = captureInstructions(
      options.instructions ?? DEFAULT_INSTRUCTIONS,
    );
  }

  public get history(): readonly RobinConversationMessage[] {
    return Object.freeze(this.#history.map((message) => Object.freeze({ ...message })));
  }

  public submit(
    prompt: string,
    signal: AbortSignal,
  ): AsyncIterable<RobinAgentEvent> {
    return this.#submit(prompt, signal);
  }

  async *#submit(
    prompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<RobinAgentEvent, void, undefined> {
    if (this.#active) {
      throw domainFailure("conflict", "A Robin session can run only one foreground turn.");
    }
    if (this.#turnsStarted >= this.#limits.maximumTurns) {
      throw domainFailure("budget_exceeded", "The Robin session turn budget is exhausted.");
    }
    const capturedPrompt = captureText(
      prompt,
      this.#limits.maximumPromptBytes,
      "The user prompt",
    );
    throwIfAborted(signal);
    if (
      conversationTextBytes(this.#history) +
        Buffer.byteLength(capturedPrompt, "utf8") >
      this.#limits.maximumHistoryBytes
    ) {
      throw domainFailure(
        "budget_exceeded",
        "The Robin conversation history budget is exhausted.",
      );
    }
    const userCapturedAt = captureTimestamp(this.#clock.now());
    this.#turnsStarted += 1;
    const turnNumber = this.#turnsStarted;
    this.#active = true;
    this.#history.push(
      Object.freeze({
        messageId: messageId(this.#sessionId, turnNumber, "user"),
        role: "user",
        text: capturedPrompt,
        turnNumber,
        capturedAt: userCapturedAt,
      }),
    );
    let committed = false;
    let started = false;
    let observedAssistantOutput = false;

    try {
      started = true;
      yield Object.freeze({
        schemaVersion: ROBIN_AGENT_EVENT_SCHEMA_VERSION,
        type: "turn_started",
        turnNumber,
      });
      const request = this.#buildRequest(turnNumber);
      let providerEvents = 0;
      let terminal = false;
      let contentCompleted = false;
      let text = "";
      let streamedText: string | undefined;

      for await (const rawEvent of this.#provider.respond(request, signal)) {
        throwIfAborted(signal);
        providerEvents += 1;
        if (providerEvents > this.#limits.maximumProviderEvents) {
          throw domainFailure(
            "budget_exceeded",
            "The provider event budget was exhausted.",
          );
        }
        if (terminal) {
          throw domainFailure(
            "provider_failed",
            "The provider emitted data after its terminal event.",
          );
        }
        const event = captureProviderEvent(rawEvent);
        switch (event.type) {
          case "text_delta": {
            if (
              contentCompleted ||
              event.outputIndex !== 0 ||
              event.delta.length === 0
            ) {
              throw domainFailure(
                "provider_failed",
                "The provider emitted an unsupported text delta.",
              );
            }
            text = appendBounded(
              text,
              event.delta,
              this.#limits.maximumAssistantBytes,
            );
            streamedText = text;
            observedAssistantOutput = true;
            yield Object.freeze({
              schemaVersion: ROBIN_AGENT_EVENT_SCHEMA_VERSION,
              type: "assistant_text_delta",
              turnNumber,
              delta: event.delta,
            });
            break;
          }
          case "content_completed": {
            if (
              contentCompleted ||
              event.outputIndex !== 0 ||
              event.content.modality !== "text"
            ) {
              throw domainFailure(
                "provider_failed",
                "The provider emitted unsupported completed content.",
              );
            }
            const completed = event.content.text;
            if (streamedText === undefined) {
              text = appendBounded(
                "",
                completed,
                this.#limits.maximumAssistantBytes,
              );
              streamedText = text;
              if (completed.length > 0) {
                observedAssistantOutput = true;
                yield Object.freeze({
                  schemaVersion: ROBIN_AGENT_EVENT_SCHEMA_VERSION,
                  type: "assistant_text_delta",
                  turnNumber,
                  delta: completed,
                });
              }
            } else if (streamedText !== completed) {
              throw domainFailure(
                "provider_failed",
                "The provider completed text that disagreed with its stream.",
              );
            }
            contentCompleted = true;
            break;
          }
          case "usage_reported":
            yield Object.freeze({
              schemaVersion: ROBIN_AGENT_EVENT_SCHEMA_VERSION,
              type: "usage_reported",
              turnNumber,
              dimensions: event.dimensions,
            });
            break;
          case "response_completed":
            if (event.finishReason !== "stop") {
              throw domainFailure(
                "provider_failed",
                "The text-only Robin preview received an unsupported finish reason.",
              );
            }
            terminal = true;
            break;
          case "response_failed":
            terminal = true;
            throw providerFailureToDomain(event.failure, text.length > 0);
          case "action_started":
          case "action_arguments_delta":
          case "action_completed":
            throw domainFailure(
              "provider_failed",
              "The text-only Robin preview does not advertise tool operations.",
            );
        }
      }

      if (!terminal) {
        throw domainFailure(
          "provider_failed",
          "The provider stream ended without a terminal event.",
        );
      }
      if (text.length === 0) {
        throw domainFailure(
          "provider_failed",
          "The provider completed the turn without assistant text.",
        );
      }
      if (
        conversationTextBytes(this.#history) + Buffer.byteLength(text, "utf8") >
        this.#limits.maximumHistoryBytes
      ) {
        throw domainFailure(
          "budget_exceeded",
          "The Robin conversation history budget is exhausted.",
        );
      }
      this.#history.push(
        Object.freeze({
          messageId: messageId(this.#sessionId, turnNumber, "assistant"),
          role: "assistant",
          text,
          turnNumber,
          capturedAt: captureTimestamp(this.#clock.now()),
        }),
      );
      committed = true;
      yield Object.freeze({
        schemaVersion: ROBIN_AGENT_EVENT_SCHEMA_VERSION,
        type: "turn_completed",
        turnNumber,
        text,
      });
    } catch (error) {
      const failure = normalizeTurnError(
        error,
        signal,
        observedAssistantOutput,
      );
      if (started) {
        yield Object.freeze({
          schemaVersion: ROBIN_AGENT_EVENT_SCHEMA_VERSION,
          type:
            failure.code === "cancelled" ? "turn_cancelled" : "turn_failed",
          turnNumber,
          error: projectTurnFailure(failure),
        });
      }
      return;
    } finally {
      if (!committed) {
        const pending = this.#history.at(-1);
        if (pending?.role === "user" && pending.turnNumber === turnNumber) {
          this.#history.pop();
        }
      }
      this.#active = false;
    }
  }

  #buildRequest(turnNumber: number): SemanticModelRequest {
    return Object.freeze({
      schemaVersion: MODEL_PROVIDER_SCHEMA_VERSION,
      attemptId: this.#ids.nextAttemptId(),
      model: Object.freeze({
        modelId: this.#modelId,
        settings: Object.freeze({}),
      }),
      instructions: this.#instructions,
      conversation: Object.freeze(
        this.#history.map((message) => conversationItem(message)),
      ),
      operations: Object.freeze([]),
      maximumOutputUnits: this.#limits.maximumAssistantBytes,
      actionMode: "none",
      metadata: Object.freeze({
        sessionId: this.#sessionId,
        turnNumber,
      }) as JsonObject,
    });
  }
}

const PREVIEW_DESCRIPTOR: ModelProviderDescriptor = Object.freeze({
  adapterId: "robin.synthetic-preview",
  adapterVersion: "1.0.0",
  capabilities: Object.freeze({
    streaming: true,
    structuredActions: false,
    exactUsage: false,
    cancellation: "confirmed",
  }),
});

/**
 * Credential-free deterministic provider for the first interactive product
 * slice. It accepts semantic conversation input and performs no I/O.
 */
export class PreviewModelProvider implements ModelProvider {
  public readonly descriptor = PREVIEW_DESCRIPTOR;

  public respond(
    request: SemanticModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelProviderEvent> {
    return this.#respond(request, signal);
  }

  async *#respond(
    request: SemanticModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelProviderEvent, void, undefined> {
    throwIfAborted(signal);
    if (
      request.actionMode !== "none" ||
      request.operations.length !== 0 ||
      request.conversation.length === 0
    ) {
      throw domainFailure(
        "invalid_input",
        "The synthetic preview received an invalid semantic request.",
      );
    }
    const last = request.conversation.at(-1);
    if (last?.role !== "user") {
      throw domainFailure(
        "invalid_input",
        "The synthetic preview requires a final user message.",
      );
    }
    const prompt = textFromConversation(last);
    const response =
      "Robin received: " +
      prompt +
      "\nSynthetic preview only: no repository files were read or changed, no commands were run, and no network request was made.";
    for (const chunk of splitForStreaming(response)) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfAborted(signal);
      yield Object.freeze({
        type: "text_delta",
        outputIndex: 0,
        delta: chunk,
      });
    }
    yield Object.freeze({
      type: "usage_reported",
      dimensions: Object.freeze({
        input_bytes: Buffer.byteLength(prompt, "utf8"),
        output_bytes: Buffer.byteLength(response, "utf8"),
      }),
    });
    yield Object.freeze({ type: "response_completed", finishReason: "stop" });
  }
}

function conversationItem(
  message: RobinConversationMessage,
): SemanticConversationItem {
  return Object.freeze({
    role: message.role,
    content: Object.freeze([
      textBlock(
        message.messageId,
        message.text,
        message.role,
        message.capturedAt,
      ),
    ]),
  });
}

function textBlock(
  blockId: string,
  text: string,
  role: "user" | "assistant",
  capturedAt: string,
): ContentBlock {
  return parseContentBlock({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    blockId,
    modality: "text",
    mediaType: "text/plain",
    byteLength: Buffer.byteLength(text, "utf8"),
    contentHash: "sha256:" + sha256Hex(text),
    classification: "internal",
    provenance: {
      source: null,
      producer: {
        kind: role === "user" ? "user" : "agent_driver",
        id: role === "user" ? "robin.user" : "robin.direct-model-agent",
      },
      capturedAt,
    },
    retentionClass: "session",
    transformation: null,
    text,
    encoding: "utf-8",
    normalization: "none",
  });
}

function textFromConversation(item: SemanticConversationItem): string {
  const chunks: string[] = [];
  for (const content of item.content) {
    if (content.modality !== "text") {
      throw domainFailure(
        "invalid_input",
        "The synthetic preview accepts text conversation items only.",
      );
    }
    chunks.push(content.text);
  }
  return chunks.join("\n");
}

function splitForStreaming(value: string): readonly string[] {
  const chunks: string[] = [];
  const width = 24;
  let chunk = "";
  let scalarCount = 0;
  for (const scalar of value) {
    chunk += scalar;
    scalarCount += 1;
    if (scalarCount === width) {
      chunks.push(chunk);
      chunk = "";
      scalarCount = 0;
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return Object.freeze(chunks);
}

function captureProviderEvent(value: unknown): ModelProviderEvent {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw domainFailure("provider_failed", "The provider emitted an invalid event.");
  }
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (
    typeDescriptor === undefined ||
    !("value" in typeDescriptor) ||
    typeDescriptor.enumerable !== true ||
    typeof typeDescriptor.value !== "string"
  ) {
    throw domainFailure("provider_failed", "The provider emitted an invalid event.");
  }
  const type = typeDescriptor.value;
  switch (type) {
    case "text_delta": {
      const record = captureExactEventRecord(value, [
        "type",
        "outputIndex",
        "delta",
      ]);
      if (
        !Number.isSafeInteger(record["outputIndex"]) ||
        (record["outputIndex"] as number) < 0 ||
        typeof record["delta"] !== "string"
      ) {
        throw domainFailure("provider_failed", "The provider emitted an invalid event.");
      }
      return Object.freeze({
        type,
        outputIndex: record["outputIndex"] as number,
        delta: record["delta"],
      });
    }
    case "content_completed": {
      const record = captureExactEventRecord(value, [
        "type",
        "outputIndex",
        "content",
      ]);
      if (
        !Number.isSafeInteger(record["outputIndex"]) ||
        (record["outputIndex"] as number) < 0
      ) {
        throw domainFailure("provider_failed", "The provider emitted an invalid event.");
      }
      try {
        return Object.freeze({
          type,
          outputIndex: record["outputIndex"] as number,
          content: parseContentBlock(record["content"]),
        });
      } catch {
        throw domainFailure("provider_failed", "The provider emitted an invalid event.");
      }
    }
    case "usage_reported": {
      const record = captureExactEventRecord(value, ["type", "dimensions"]);
      return Object.freeze({
        type,
        dimensions: captureUsage(
          record["dimensions"] as Readonly<Record<string, number>>,
        ),
      });
    }
    case "response_completed": {
      const record = captureExactEventRecord(value, ["type", "finishReason"]);
      if (
        typeof record["finishReason"] !== "string" ||
        !new Set(["stop", "action_required", "length", "content_filter", "other"])
          .has(record["finishReason"])
      ) {
        throw domainFailure("provider_failed", "The provider emitted an invalid event.");
      }
      return Object.freeze({
        type,
        finishReason: record["finishReason"] as ModelFinishReason,
      });
    }
    case "response_failed": {
      const record = captureExactEventRecord(value, ["type", "failure"]);
      return Object.freeze({
        type,
        failure: captureProviderFailure(record["failure"] as ModelFailure),
      });
    }
    case "action_started":
    case "action_arguments_delta":
    case "action_completed":
      throw domainFailure(
        "provider_failed",
        "The text-only Robin preview does not accept provider action events.",
      );
    default:
      throw domainFailure("provider_failed", "The provider emitted an unknown event.");
  }
}

function captureExactEventRecord(
  value: object,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const expected = new Set(expectedKeys);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw domainFailure("provider_failed", "The provider emitted an invalid event.");
  }
  const captured: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw domainFailure("provider_failed", "The provider emitted an invalid event.");
    }
    captured[key] = descriptor.value;
  }
  return Object.freeze(captured);
}

function providerFailureToDomain(
  value: ModelFailure,
  observedPartialOutput: boolean,
): DomainError {
  const failure = captureProviderFailure(value);
  const uncertain =
    observedPartialOutput ||
    failure.retry === "uncertain" ||
    failure.resultCertainty === "partial_result" ||
    failure.resultCertainty === "uncertain";
  return createDomainError({
    code: uncertain ? "provider_result_uncertain" : "provider_failed",
    message: `Provider failure (${failure.code}): ${failure.message}`,
    retry: uncertain ? "uncertain" : failure.retry,
    details: {
      providerCode: failure.code,
      resultCertainty: failure.resultCertainty,
      observedPartialOutput,
    },
  });
}

function captureProviderFailure(value: ModelFailure): ModelFailure {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw domainFailure("provider_failed", "The provider emitted an invalid failure.");
  }
  const expected = new Set(["code", "message", "retry", "resultCertainty"]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw domainFailure("provider_failed", "The provider emitted an invalid failure.");
  }
  const captured: Record<string, string> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "string"
    ) {
      throw domainFailure("provider_failed", "The provider emitted an invalid failure.");
    }
    captured[key] = descriptor.value;
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(captured["code"]!) ||
    captured["message"]!.trim().length === 0 ||
    Buffer.byteLength(captured["message"]!, "utf8") > 4_096 ||
    containsUnsafeDiagnosticText(captured["message"]!) ||
    !new Set(["terminal", "retryable", "uncertain"]).has(captured["retry"]!) ||
    !new Set(["no_result", "partial_result", "uncertain"]).has(
      captured["resultCertainty"]!,
    )
  ) {
    throw domainFailure("provider_failed", "The provider emitted an invalid failure.");
  }
  return Object.freeze({
    code: captured["code"]!,
    message: captured["message"]!,
    retry: captured["retry"] as ModelFailure["retry"],
    resultCertainty:
      captured["resultCertainty"] as ModelFailure["resultCertainty"],
  });
}

function normalizeTurnError(
  value: unknown,
  signal: AbortSignal,
  observedPartialOutput: boolean,
): DomainError {
  const captured = isDomainError(value) ? parseDomainError(value) : null;
  if (
    captured !== null &&
    (captured.code === "provider_result_uncertain" ||
      captured.code === "attempt_result_uncertain")
  ) {
    return captured;
  }
  if (captured !== null && captured.code !== "provider_failed") {
    return captured;
  }
  if (signal.aborted) {
    return domainFailure("cancelled", "The Robin turn was cancelled.");
  }
  if (observedPartialOutput) {
    return createDomainError({
      code: "provider_result_uncertain",
      message: "The provider failed after Robin exposed partial output.",
      retry: "uncertain",
      details: {
        observedPartialOutput: true,
        originalCode: captured?.code ?? "unclassified_transport_failure",
      },
    });
  }
  return captured !== null
    ? captured
    : domainFailure(
        "provider_failed",
        "The selected provider failed before completing the turn.",
      );
}

function projectTurnFailure(error: DomainError): RobinTurnFailure {
  const safeMessage =
    Buffer.byteLength(error.message, "utf8") > 4_096 ||
    containsUnsafeDiagnosticText(error.message)
    ? "The Robin turn failed with an unsafe provider diagnostic removed."
    : error.message;
  const safeDetails =
    error.details === undefined || !isSafeFailureDetails(error.details)
      ? undefined
      : error.details;
  return Object.freeze({
    code: error.code,
    message: safeMessage,
    retry: error.retry,
    ...(safeDetails === undefined ? {} : { details: safeDetails }),
  });
}

function captureProvider(value: ModelProvider): ModelProvider {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.respond !== "function" ||
    typeof value.descriptor !== "object" ||
    value.descriptor === null
  ) {
    throw domainFailure("invalid_input", "A valid model provider is required.");
  }
  return value;
}

function captureClock(value: DirectModelSessionClock): DirectModelSessionClock {
  if (typeof value !== "object" || value === null || typeof value.now !== "function") {
    throw domainFailure("invalid_input", "A valid session clock is required.");
  }
  return Object.freeze({ now: value.now.bind(value) });
}

function captureIds(value: DirectModelSessionIdSource): DirectModelSessionIdSource {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.nextAttemptId !== "function"
  ) {
    throw domainFailure("invalid_input", "A valid session ID source is required.");
  }
  return Object.freeze({ nextAttemptId: value.nextAttemptId.bind(value) });
}

function captureLimits(
  value: Partial<DirectModelSessionLimits> | undefined,
): DirectModelSessionLimits {
  const merged = {
    ...DEFAULT_DIRECT_MODEL_SESSION_LIMITS,
    ...(value ?? {}),
  };
  for (const [name, limit] of Object.entries(merged)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw domainFailure("invalid_input", name + " must be a positive integer.");
    }
  }
  return Object.freeze(merged);
}

function captureInstructions(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw domainFailure("invalid_input", "Robin instructions must be a bounded array.");
  }
  const captured = Object.freeze(
    value.map((instruction) =>
      captureText(instruction, 16_384, "A Robin instruction"),
    ),
  );
  const totalBytes = captured.reduce(
    (total, instruction) => total + Buffer.byteLength(instruction, "utf8"),
    0,
  );
  if (totalBytes > 65_536) {
    throw domainFailure(
      "invalid_input",
      "Robin instructions exceed the aggregate byte limit.",
    );
  }
  return captured;
}

function captureText(value: string, maximumBytes: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\u0000") ||
    containsUnpairedSurrogate(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw domainFailure("invalid_input", label + " must be non-empty and bounded.");
  }
  return value;
}

function boundedIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)
  ) {
    throw domainFailure("invalid_input", label + " must be a bounded identifier.");
  }
  return value;
}

function captureTimestamp(value: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw domainFailure(
      "infrastructure_failed",
      "The Robin session clock returned an invalid timestamp.",
    );
  }
  return value;
}

function messageId(
  sessionId: string,
  turnNumber: number,
  role: "user" | "assistant",
): string {
  return [
    "message",
    sha256Hex(sessionId).slice(0, 16),
    String(turnNumber),
    role,
  ].join("-");
}

function conversationTextBytes(
  history: readonly RobinConversationMessage[],
): number {
  return history.reduce(
    (total, message) => total + Buffer.byteLength(message.text, "utf8"),
    0,
  );
}

function appendBounded(current: string, delta: string, maximumBytes: number): string {
  if (
    typeof delta !== "string" ||
    delta.length === 0 ||
    containsUnpairedSurrogate(delta) ||
    Buffer.byteLength(current, "utf8") + Buffer.byteLength(delta, "utf8") >
      maximumBytes
  ) {
    if (
      typeof delta !== "string" ||
      delta.length === 0 ||
      containsUnpairedSurrogate(delta)
    ) {
      throw domainFailure("provider_failed", "The provider emitted invalid text.");
    }
    throw domainFailure(
      "budget_exceeded",
      "The assistant output budget was exhausted.",
    );
  }
  return current + delta;
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

function containsUnsafeControlText(value: string): boolean {
  if (containsUnpairedSurrogate(value)) return true;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint >= 0x00 && codePoint <= 0x08) ||
      (codePoint >= 0x0b && codePoint <= 0x1f) ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f)
    ) {
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

function isSafeFailureDetails(root: JsonObject): boolean {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  let keys = 0;
  let textBytes = 0;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    nodes += 1;
    if (nodes > 256 || entry.depth > 8) return false;
    if (typeof entry.value === "string") {
      textBytes += Buffer.byteLength(entry.value, "utf8");
      if (textBytes > 8_192 || containsUnsafeControlText(entry.value)) {
        return false;
      }
      continue;
    }
    if (Array.isArray(entry.value)) {
      for (const item of entry.value) {
        stack.push({ value: item, depth: entry.depth + 1 });
      }
      continue;
    }
    if (typeof entry.value === "object" && entry.value !== null) {
      for (const [key, item] of Object.entries(entry.value)) {
        keys += 1;
        textBytes += Buffer.byteLength(key, "utf8");
        if (
          keys > 128 ||
          textBytes > 8_192 ||
          containsUnsafeControlText(key)
        ) {
          return false;
        }
        stack.push({ value: item, depth: entry.depth + 1 });
      }
    }
  }
  return true;
}

function captureUsage(
  value: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw domainFailure("provider_failed", "The provider emitted invalid usage.");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > 64 ||
    keys.some((key) => typeof key !== "string") ||
    keys.reduce(
      (total, key) =>
        total + (typeof key === "string" ? Buffer.byteLength(key, "utf8") : 0),
      0,
    ) > 4_096
  ) {
    throw domainFailure("provider_failed", "The provider emitted invalid usage.");
  }
  const captured: Record<string, number> = {};
  for (const key of keys) {
    const name = key as string;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    const count =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
    if (
      descriptor?.enumerable !== true ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(name) ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw domainFailure("provider_failed", "The provider emitted invalid usage.");
    }
    captured[name] = count;
  }
  return Object.freeze(captured);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw domainFailure("cancelled", "The Robin turn was cancelled.");
  }
}

function domainFailure(
  code: DomainError["code"],
  message: string,
): DomainError {
  return createDomainError({ code, message });
}
