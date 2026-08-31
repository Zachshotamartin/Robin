import { createDomainError, type JsonObject } from "@guard/contracts";
import {
  type ModelProvider,
  type ModelProviderDescriptor,
  type ModelProviderEvent,
  type SemanticConversationItem,
  type SemanticModelRequest,
} from "@guard/model-provider";

const WORKSPACE_SUMMARY = Object.freeze({
  capabilityPackId: "robin.synthetic",
  capabilityPackVersion: 1,
  operationId: "workspace_summary",
  operationVersion: 1,
});
const INSPECT_FILE = Object.freeze({
  capabilityPackId: "robin.synthetic",
  capabilityPackVersion: 1,
  operationId: "inspect_file",
  operationVersion: 1,
});

interface SyntheticToolIdentity {
  readonly capabilityPackId: string;
  readonly capabilityPackVersion: number;
  readonly operationId: string;
  readonly operationVersion: number;
}

interface SyntheticCallIds {
  readonly workspaceSummary: string;
  readonly inspectFile: string;
}

const DESCRIPTOR: ModelProviderDescriptor = Object.freeze({
  adapterId: "robin.r1-synthetic-coding",
  adapterVersion: "1.0.0",
  capabilities: Object.freeze({
    streaming: true,
    structuredActions: true,
    exactUsage: true,
    cancellation: "confirmed",
  }),
});

/**
 * Deterministic, credential-free R1 provider. It derives every response from
 * the semantic conversation, verifies returned tool observations, and never
 * touches the network or a physical workspace.
 */
export class R1SyntheticCodingProvider implements ModelProvider {
  public readonly descriptor = DESCRIPTOR;

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
    validateRequest(request);
    const turnNumber = requestTurnNumber(request);
    const callIds = callIdsForTurn(turnNumber);
    const userIndexes = request.conversation
      .map((item, index) => (item.role === "user" ? index : -1))
      .filter((index) => index >= 0);
    const latestUserIndex = userIndexes.at(-1);
    if (latestUserIndex === undefined) providerInputFailure("Missing user input.");
    const prompt = textFromItem(request.conversation[latestUserIndex]!);

    if (prompt.includes("[scenario:provider-error]")) {
      yield Object.freeze({
        type: "response_failed",
        failure: Object.freeze({
          code: "synthetic_provider_error",
          message: "The deterministic provider error scenario was requested.",
          retry: "terminal",
          resultCertainty: "no_result",
        }),
      });
      return;
    }

    if (prompt.includes("[scenario:slow]")) {
      for (let index = 0; index < 10_000; index += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throwIfAborted(signal);
        yield Object.freeze({
          type: "text_delta",
          outputIndex: 0,
          delta: index === 0 ? "Working on the synthetic fixture…" : ".",
        });
      }
      yield Object.freeze({ type: "response_completed", finishReason: "stop" });
      return;
    }

    const afterLatestUser = request.conversation.slice(latestUserIndex + 1);
    const observations = afterLatestUser.filter(
      (item) => item.role === "operation",
    );
    if (userIndexes.length > 1) {
      const historicalObservations = request.conversation.filter(
        (item) => item.role === "operation",
      );
      assertHistoricalExpectedObservations(historicalObservations);
      yield* streamText(
        "The earlier evidence still points to src/calculate.ts: reduce subtracts each value from zero, so the fixture computes a negative total. Replace subtraction with addition, then run npm test.",
        signal,
      );
      yield usage(prompt, 171);
      yield Object.freeze({ type: "response_completed", finishReason: "stop" });
      return;
    }

    if (observations.length === 0) {
      yield* streamText(
        "I’ll inspect the deterministic workspace summary and the candidate file before answering.\n",
        signal,
      );
      yield* toolCall(callIds.workspaceSummary, WORKSPACE_SUMMARY, {});
      const inspectArguments = prompt.includes("[scenario:tool-error]")
        ? { path: "src/missing.ts" }
        : { path: "src/calculate.ts" };
      yield* toolCall(callIds.inspectFile, INSPECT_FILE, inspectArguments);
      if (prompt.includes("[scenario:malformed-call]")) return;
      yield usage(prompt, 86);
      yield Object.freeze({
        type: "response_completed",
        finishReason: "action_required",
      });
      return;
    }

    assertExpectedObservations(observations, callIds);
    yield* streamText(
      "The synthetic TypeScript fixture has a bug in src/calculate.ts: its reducer subtracts each value from zero. Change `total - value` to `total + value`, then verify with `npm test`. No physical repository was read or changed.",
      signal,
    );
    yield usage(prompt, 208);
    yield Object.freeze({ type: "response_completed", finishReason: "stop" });
  }
}

function validateRequest(request: SemanticModelRequest): void {
  if (
    request.actionMode !== "structured" ||
    request.conversation.length === 0 ||
    request.operations.length !== 2
  ) {
    providerInputFailure("The R1 provider received an invalid semantic request.");
  }
  for (const expected of [WORKSPACE_SUMMARY, INSPECT_FILE]) {
    if (
      !request.operations.some(
        (operation) =>
          operation.capabilityPackId === expected.capabilityPackId &&
          operation.capabilityPackVersion === expected.capabilityPackVersion &&
          operation.operationId === expected.operationId &&
          operation.operationVersion === expected.operationVersion,
      )
    ) {
      providerInputFailure("The R1 provider is missing an expected tool definition.");
    }
  }
}

function assertExpectedObservations(
  items: readonly SemanticConversationItem[],
  callIds: SyntheticCallIds,
): void {
  const byCallId = new Map(
    items.map((item) => [item.correlationId, jsonFromItem(item)] as const),
  );
  const summary = byCallId.get(callIds.workspaceSummary);
  const inspected = byCallId.get(callIds.inspectFile);
  if (
    summary?.["repositoryName"] !== "robin-r1-fixture" ||
    summary["candidateFile"] !== "src/calculate.ts" ||
    inspected?.["path"] !== "src/calculate.ts" ||
    !Array.isArray(inspected["lines"]) ||
    typeof inspected["contentHash"] !== "string"
  ) {
    providerInputFailure(
      "The R1 provider received missing or divergent synthetic observations.",
    );
  }
}

function assertHistoricalExpectedObservations(
  items: readonly SemanticConversationItem[],
): void {
  const correlations = new Set(
    items
      .map((item) => item.correlationId)
      .filter((value): value is string => typeof value === "string"),
  );
  const turns = [...correlations]
    .map((callId) => /^r1-turn-(\d+)-workspace-summary$/u.exec(callId))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((left, right) => right - left);
  const turnNumber = turns.find((value) => {
    const callIds = callIdsForTurn(value);
    return (
      correlations.has(callIds.workspaceSummary) &&
      correlations.has(callIds.inspectFile)
    );
  });
  if (turnNumber === undefined) {
    providerInputFailure(
      "The R1 provider received no complete historical observation pair.",
    );
  }
  assertExpectedObservations(items, callIdsForTurn(turnNumber));
}

function requestTurnNumber(request: SemanticModelRequest): number {
  const value = request.metadata["turnNumber"];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    providerInputFailure("The R1 provider received an invalid turn number.");
  }
  return value as number;
}

function callIdsForTurn(turnNumber: number): SyntheticCallIds {
  return Object.freeze({
    workspaceSummary: `r1-turn-${turnNumber}-workspace-summary`,
    inspectFile: `r1-turn-${turnNumber}-inspect-file`,
  });
}

function textFromItem(item: SemanticConversationItem): string {
  const parts: string[] = [];
  for (const block of item.content) {
    if (block.modality !== "text") {
      providerInputFailure("A user conversation item must contain only text.");
    }
    parts.push(block.text);
  }
  return parts.join("\n");
}

function jsonFromItem(item: SemanticConversationItem): JsonObject {
  if (
    item.content.length !== 1 ||
    item.content[0]?.modality !== "json" ||
    typeof item.correlationId !== "string"
  ) {
    providerInputFailure("A tool observation item is malformed.");
  }
  const value = item.content[0].value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    providerInputFailure("A tool observation must be a JSON object.");
  }
  return value as JsonObject;
}

async function* streamText(
  text: string,
  signal: AbortSignal,
): AsyncGenerator<ModelProviderEvent, void, undefined> {
  const scalars = [...text];
  for (let index = 0; index < scalars.length; index += 24) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfAborted(signal);
    yield Object.freeze({
      type: "text_delta",
      outputIndex: 0,
      delta: scalars.slice(index, index + 24).join(""),
    });
  }
}

function* toolCall(
  callId: string,
  identity: SyntheticToolIdentity,
  args: JsonObject,
): Generator<ModelProviderEvent, void, undefined> {
  const argumentsJson = JSON.stringify(args);
  yield Object.freeze({ type: "action_started", callId, ...identity });
  const midpoint = Math.max(1, Math.floor(argumentsJson.length / 2));
  for (const delta of [
    argumentsJson.slice(0, midpoint),
    argumentsJson.slice(midpoint),
  ]) {
    if (delta.length > 0) {
      yield Object.freeze({ type: "action_arguments_delta", callId, delta });
    }
  }
  yield Object.freeze({
    type: "action_completed",
    callId,
    ...identity,
    arguments: args,
  });
}

function usage(prompt: string, outputTokens: number): ModelProviderEvent {
  return Object.freeze({
    type: "usage_reported",
    dimensions: Object.freeze({
      input_tokens: Math.max(1, Math.ceil([...prompt].length / 4)),
      output_tokens: outputTokens,
    }),
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createDomainError({
      code: "cancelled",
      message: "The R1 synthetic provider response was cancelled.",
    });
  }
}

function providerInputFailure(message: string): never {
  throw createDomainError({ code: "provider_failed", message });
}
