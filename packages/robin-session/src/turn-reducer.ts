import { Buffer } from "node:buffer";

import {
  MAXIMUM_APPLICATION_TEXT_UTF8_BYTES,
  RobinSessionError,
  type RobinTurnApplicationEvent,
} from "./application-event.js";
import {
  isTerminalTurnStatus,
  type RobinToolCallState,
  type RobinTurnState,
} from "./turn-state.js";

/**
 * Pure exhaustive reducer for one turn. It performs no I/O and returns a new
 * deeply immutable state for every accepted event.
 */
export function reduceRobinTurn(
  state: RobinTurnState | undefined,
  event: RobinTurnApplicationEvent,
): RobinTurnState {
  if (state === undefined) return createTurn(event);
  if (event.payload.turnId !== state.turnId || isTerminalTurnStatus(state.status)) {
    return illegalTransition();
  }

  switch (event.type) {
    case "UserMessageQueued":
      return illegalTransition();
    case "UserMessageAccepted":
      if (
        state.status !== "queued" ||
        event.payload.messageId !== state.messageId ||
        event.payload.text !== state.userText
      ) {
        return illegalTransition();
      }
      return freezeTurn({ ...state, status: "accepted" });
    case "TurnStarted":
      if (
        state.status !== "accepted" ||
        event.payload.messageId !== state.messageId
      ) {
        return illegalTransition();
      }
      return freezeTurn({ ...state, status: "active" });
    case "AssistantTextDelta":
      requireActive(state);
      return freezeTurn({
        ...state,
        assistantText: appendAssistantText(
          state.assistantText,
          event.payload.text,
        ),
      });
    case "ToolCallStarted":
      requireActive(state);
      if (
        state.toolCalls.some((call) => call.callId === event.payload.callId) ||
        state.toolCalls.some((call) => call.status === "active")
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        toolCalls: Object.freeze([
          ...state.toolCalls,
          Object.freeze({
            callId: event.payload.callId,
            status: "active" as const,
            toolName: event.payload.toolName,
          }),
        ]),
      });
    case "ToolCallCompleted":
      if (
        state.status !== "active" &&
        state.status !== "cancellation_requested"
      ) {
        return illegalTransition();
      }
      return completeToolCall(state, event);
    case "ToolCallFailed":
      if (
        state.status !== "active" &&
        state.status !== "cancellation_requested"
      ) {
        return illegalTransition();
      }
      return failToolCall(state, event);
    case "UsageReported":
      if (
        state.status !== "active" &&
        state.status !== "cancellation_requested"
      ) {
        return illegalTransition();
      }
      if (
        event.payload.inputTokens < state.usage.inputTokens ||
        event.payload.outputTokens < state.usage.outputTokens
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        usage: Object.freeze({
          inputTokens: event.payload.inputTokens,
          outputTokens: event.payload.outputTokens,
        }),
      });
    case "BudgetWarning":
      requireActive(state);
      return freezeTurn({
        ...state,
        budgetWarnings: Object.freeze([
          ...state.budgetWarnings,
          Object.freeze({
            dimension: event.payload.dimension,
            limit: event.payload.limit,
            used: event.payload.used,
          }),
        ]),
      });
    case "BudgetExhausted":
      requireActive(state);
      if (state.toolCalls.some((call) => call.status === "active")) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        status: "budget_exhausted",
        terminalResult: Object.freeze({
          status: "budget_exhausted",
          dimension: event.payload.dimension,
          limit: event.payload.limit,
          used: event.payload.used,
        }),
      });
    case "TurnCancellationRequested":
      if (
        state.status !== "queued" &&
        state.status !== "accepted" &&
        state.status !== "active"
      ) {
        return illegalTransition();
      }
      return freezeTurn({ ...state, status: "cancellation_requested" });
    case "TurnCancelled":
      if (
        state.status !== "cancellation_requested" ||
        state.toolCalls.some((call) => call.status === "active")
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        status: "cancelled",
        terminalResult: Object.freeze({
          status: "cancelled",
          reason: event.payload.reason,
        }),
      });
    case "TurnFailed":
      if (
        state.status !== "active" &&
        state.status !== "cancellation_requested"
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        status: "failed",
        terminalResult: Object.freeze({
          status: "failed",
          code: event.payload.code,
          message: event.payload.message,
        }),
      });
    case "TurnCompleted":
      requireActive(state);
      if (
        state.toolCalls.some((call) => call.status === "active") ||
        event.payload.text !== state.assistantText
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        status: "completed",
        terminalResult: Object.freeze({
          status: "completed",
          text: event.payload.text,
        }),
      });
  }
}

function createTurn(event: RobinTurnApplicationEvent): RobinTurnState {
  if (
    event.type !== "UserMessageQueued" &&
    event.type !== "UserMessageAccepted"
  ) {
    return illegalTransition();
  }
  return freezeTurn({
    assistantText: "",
    budgetWarnings: Object.freeze([]),
    messageId: event.payload.messageId,
    status: event.type === "UserMessageQueued" ? "queued" : "accepted",
    toolCalls: Object.freeze([]),
    turnId: event.payload.turnId,
    usage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
    userText: event.payload.text,
  });
}

function completeToolCall(
  state: RobinTurnState,
  event: Extract<RobinTurnApplicationEvent, { readonly type: "ToolCallCompleted" }>,
): RobinTurnState {
  let found = false;
  const calls = state.toolCalls.map((call): RobinToolCallState => {
    if (call.callId !== event.payload.callId) return call;
    if (
      found ||
      call.status !== "active" ||
      call.toolName !== event.payload.toolName
    ) {
      return illegalTransition();
    }
    found = true;
    return Object.freeze({
      callId: call.callId,
      observation: event.payload.observation,
      status: "completed",
      toolName: call.toolName,
    });
  });
  if (!found) return illegalTransition();
  return freezeTurn({ ...state, toolCalls: Object.freeze(calls) });
}

function failToolCall(
  state: RobinTurnState,
  event: Extract<RobinTurnApplicationEvent, { readonly type: "ToolCallFailed" }>,
): RobinTurnState {
  const activeCalls = state.toolCalls.filter((call) => call.status === "active");
  if (
    activeCalls.length !== 1 ||
    activeCalls[0]?.callId !== event.payload.callId ||
    activeCalls[0].toolName !== event.payload.toolName
  ) {
    return illegalTransition();
  }
  let found = false;
  const calls = state.toolCalls.map((call): RobinToolCallState => {
    if (call.callId !== event.payload.callId) return call;
    if (
      found ||
      call.status !== "active" ||
      call.toolName !== event.payload.toolName
    ) {
      return illegalTransition();
    }
    found = true;
    return Object.freeze({
      callId: call.callId,
      failure: Object.freeze({
        code: event.payload.code,
        message: event.payload.message,
      }),
      status: "failed",
      toolName: call.toolName,
    });
  });
  if (!found) return illegalTransition();
  return freezeTurn({ ...state, toolCalls: Object.freeze(calls) });
}

function appendAssistantText(current: string, delta: string): string {
  const next = current + delta;
  if (Buffer.byteLength(next, "utf8") > MAXIMUM_APPLICATION_TEXT_UTF8_BYTES) {
    return illegalTransition();
  }
  return next;
}

function requireActive(state: RobinTurnState): void {
  if (state.status !== "active") illegalTransition();
}

function freezeTurn(state: RobinTurnState): RobinTurnState {
  return Object.freeze(state);
}

function illegalTransition(): never {
  throw new RobinSessionError(
    "illegal_transition",
    "Illegal Robin turn transition.",
  );
}
