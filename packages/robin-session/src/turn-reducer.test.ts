import assert from "node:assert/strict";
import test from "node:test";

import {
  RobinSessionError,
  parseRobinApplicationEvent,
  type RobinTurnApplicationEvent,
} from "./application-event.js";
import { classifyRobinBudget } from "./budgets.js";
import { reduceRobinTurn } from "./turn-reducer.js";
import type { RobinTurnState } from "./turn-state.js";

test("reduces the complete legal synthetic-tool turn and seals terminal state", () => {
  let state = apply(undefined, "UserMessageAccepted", {
    messageId: "message-1",
    text: "debug this",
    turnId: "turn-1",
  });
  state = apply(state, "TurnStarted", {
    messageId: "message-1",
    turnId: "turn-1",
  });
  state = apply(state, "AssistantTextDelta", {
    text: "Inspecting ",
    turnId: "turn-1",
  });
  state = apply(state, "ToolCallStarted", {
    callId: "call-1",
    toolName: "robin.synthetic.inspect_file@1",
    turnId: "turn-1",
  });
  state = apply(state, "ToolCallCompleted", {
    callId: "call-1",
    observation: { hash: "abc" },
    toolName: "robin.synthetic.inspect_file@1",
    turnId: "turn-1",
  });
  state = apply(state, "UsageReported", {
    inputTokens: 20,
    outputTokens: 5,
    turnId: "turn-1",
  });
  state = apply(state, "BudgetWarning", {
    dimension: "output_tokens",
    limit: 10,
    turnId: "turn-1",
    used: 8,
  });
  state = apply(state, "AssistantTextDelta", {
    text: "done",
    turnId: "turn-1",
  });
  state = apply(state, "TurnCompleted", {
    text: "Inspecting done",
    turnId: "turn-1",
  });

  assert.equal(state.status, "completed");
  assert.equal(state.assistantText, "Inspecting done");
  assert.deepEqual(state.usage, { inputTokens: 20, outputTokens: 5 });
  assert.deepEqual(state.toolCalls[0]?.observation, { hash: "abc" });
  assert.equal(state.budgetWarnings.length, 1);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.toolCalls));
  assertIllegal(() =>
    apply(state, "AssistantTextDelta", { text: "late", turnId: "turn-1" }),
  );
});

test("queued input must be accepted unchanged before starting", () => {
  let state = apply(undefined, "UserMessageQueued", {
    messageId: "message-1",
    position: 1,
    text: "queued",
    turnId: "turn-1",
  });
  assert.equal(state.status, "queued");
  assertIllegal(() =>
    apply(state, "UserMessageAccepted", {
      messageId: "message-1",
      text: "mutated",
      turnId: "turn-1",
    }),
  );
  state = apply(state, "UserMessageAccepted", {
    messageId: "message-1",
    text: "queued",
    turnId: "turn-1",
  });
  assert.equal(state.status, "accepted");
});

test("cancellation is legal from queued, accepted, and active states", () => {
  const startingStates = [
    apply(undefined, "UserMessageQueued", {
      messageId: "message-1",
      position: 1,
      text: "q",
      turnId: "turn-1",
    }),
    apply(undefined, "UserMessageAccepted", {
      messageId: "message-1",
      text: "q",
      turnId: "turn-1",
    }),
    apply(
      apply(undefined, "UserMessageAccepted", {
        messageId: "message-1",
        text: "q",
        turnId: "turn-1",
      }),
      "TurnStarted",
      { messageId: "message-1", turnId: "turn-1" },
    ),
  ];
  for (const starting of startingStates) {
    let state = apply(starting, "TurnCancellationRequested", {
      reason: "user",
      turnId: "turn-1",
    });
    assert.equal(state.status, "cancellation_requested");
    state = apply(state, "TurnCancelled", {
      reason: "settled",
      turnId: "turn-1",
    });
    assert.equal(state.status, "cancelled");
  }
});

test("tool calls are unique, paired, and serialized", () => {
  const active = activeTurn();
  const withTool = apply(active, "ToolCallStarted", {
    callId: "call-1",
    toolName: "tool@1",
    turnId: "turn-1",
  });
  assertIllegal(() =>
    apply(withTool, "ToolCallStarted", {
      callId: "call-2",
      toolName: "tool@1",
      turnId: "turn-1",
    }),
  );
  assertIllegal(() =>
    apply(withTool, "ToolCallCompleted", {
      callId: "call-1",
      observation: {},
      toolName: "different@1",
      turnId: "turn-1",
    }),
  );
  assertIllegal(() =>
    apply(withTool, "ToolCallFailed", {
      callId: "call-1",
      code: "action_failed",
      message: "failed",
      toolName: "different@1",
      turnId: "turn-1",
    }),
  );
  assertIllegal(() =>
    apply(withTool, "TurnCompleted", { text: "too early", turnId: "turn-1" }),
  );
  const failedTool = apply(withTool, "ToolCallFailed", {
    callId: "call-1",
    code: "action_failed",
    message: "classified tool failure",
    toolName: "tool@1",
    turnId: "turn-1",
  });
  assert.equal(failedTool.status, "active");
  assert.equal(failedTool.toolCalls[0]?.status, "failed");
  const withNextTool = apply(failedTool, "ToolCallStarted", {
    callId: "call-2",
    toolName: "tool@1",
    turnId: "turn-1",
  });
  assert.equal(withNextTool.toolCalls[1]?.status, "active");
});

test("cancellation waits for an active tool to settle", () => {
  let state = apply(activeTurn(), "ToolCallStarted", {
    callId: "call-1",
    toolName: "tool@1",
    turnId: "turn-1",
  });
  state = apply(state, "TurnCancellationRequested", {
    reason: "user",
    turnId: "turn-1",
  });
  assertIllegal(() =>
    apply(state, "TurnCancelled", { reason: "early", turnId: "turn-1" }),
  );
  state = apply(state, "ToolCallCompleted", {
    callId: "call-1",
    observation: { settled: true },
    toolName: "tool@1",
    turnId: "turn-1",
  });
  state = apply(state, "UsageReported", {
    inputTokens: 1,
    outputTokens: 1,
    turnId: "turn-1",
  });
  state = apply(state, "TurnCancelled", {
    reason: "settled",
    turnId: "turn-1",
  });
  assert.equal(state.status, "cancelled");
});

test("a classified tool failure settles cancellation truthfully", () => {
  let state = apply(activeTurn(), "ToolCallStarted", {
    callId: "call-1",
    toolName: "tool@1",
    turnId: "turn-1",
  });
  state = apply(state, "TurnCancellationRequested", {
    reason: "user",
    turnId: "turn-1",
  });
  assertIllegal(() =>
    apply(state, "ToolCallFailed", {
      callId: "call-other",
      code: "cancelled",
      message: "cancelled",
      toolName: "tool@1",
      turnId: "turn-1",
    }),
  );
  state = apply(state, "ToolCallFailed", {
    callId: "call-1",
    code: "cancelled",
    message: "tool cancellation confirmed",
    toolName: "tool@1",
    turnId: "turn-1",
  });
  assert.deepEqual(state.toolCalls[0], {
    callId: "call-1",
    failure: {
      code: "cancelled",
      message: "tool cancellation confirmed",
    },
    status: "failed",
    toolName: "tool@1",
  });
  assert.ok(Object.isFrozen(state.toolCalls[0]?.failure));
  assertIllegal(() =>
    apply(state, "ToolCallFailed", {
      callId: "call-1",
      code: "cancelled",
      message: "duplicate",
      toolName: "tool@1",
      turnId: "turn-1",
    }),
  );
  state = apply(state, "TurnCancelled", {
    reason: "settled",
    turnId: "turn-1",
  });
  assert.equal(state.status, "cancelled");
});

test("completion text must equal accumulated deltas and active turns may fail", () => {
  let state = apply(activeTurn(), "AssistantTextDelta", {
    text: "exact",
    turnId: "turn-1",
  });
  assertIllegal(() =>
    apply(state, "TurnCompleted", { text: "different", turnId: "turn-1" }),
  );
  state = apply(state, "TurnFailed", {
    code: "provider_failed",
    message: "classified",
    turnId: "turn-1",
  });
  assert.equal(state.status, "failed");
  assert.deepEqual(state.terminalResult, {
    status: "failed",
    code: "provider_failed",
    message: "classified",
  });
});

test("usage is monotonic and budget exhaustion is terminal", () => {
  let state = apply(activeTurn(), "UsageReported", {
    inputTokens: 10,
    outputTokens: 5,
    turnId: "turn-1",
  });
  assertIllegal(() =>
    apply(state, "UsageReported", {
      inputTokens: 9,
      outputTokens: 5,
      turnId: "turn-1",
    }),
  );
  state = apply(state, "BudgetExhausted", {
    dimension: "tool_calls",
    limit: 2,
    turnId: "turn-1",
    used: 2,
  });
  assert.equal(state.status, "budget_exhausted");
  assert.deepEqual(state.terminalResult, {
    status: "budget_exhausted",
    dimension: "tool_calls",
    limit: 2,
    used: 2,
  });
});

test("classifies within, warning, and exhausted budgets at exact boundaries", () => {
  const base = {
    dimension: "tool_calls" as const,
    limit: 10,
    warningThreshold: 8,
  };
  assert.equal(classifyRobinBudget({ ...base, used: 7 }).kind, "within");
  assert.equal(classifyRobinBudget({ ...base, used: 8 }).kind, "warning");
  assert.equal(classifyRobinBudget({ ...base, used: 10 }).kind, "exhausted");
  assert.throws(
    () => classifyRobinBudget({ ...base, warningThreshold: 10, used: 1 }),
    (error: unknown) =>
      error instanceof RobinSessionError && error.code === "budget_invalid",
  );
});

test("rejects every event that cannot create a turn and wrong-turn events", () => {
  for (const [type, payload] of [
    ["TurnStarted", { messageId: "message-1", turnId: "turn-1" }],
    ["AssistantTextDelta", { text: "x", turnId: "turn-1" }],
    ["ToolCallStarted", { callId: "call-1", toolName: "tool@1", turnId: "turn-1" }],
    ["ToolCallCompleted", { callId: "call-1", observation: {}, toolName: "tool@1", turnId: "turn-1" }],
    ["ToolCallFailed", { callId: "call-1", code: "action_failed", message: "failed", toolName: "tool@1", turnId: "turn-1" }],
    ["UsageReported", { inputTokens: 1, outputTokens: 1, turnId: "turn-1" }],
    ["TurnCompleted", { text: "x", turnId: "turn-1" }],
  ] as const) {
    assertIllegal(() => apply(undefined, type, payload));
  }
  assertIllegal(() =>
    apply(activeTurn(), "AssistantTextDelta", {
      text: "wrong",
      turnId: "turn-other",
    }),
  );
});

test("all terminal turn states reject every later turn event", () => {
  const completed = apply(activeTurn(), "TurnCompleted", {
    text: "",
    turnId: "turn-1",
  });
  const failed = apply(activeTurn(), "TurnFailed", {
    code: "provider_failed",
    message: "failed",
    turnId: "turn-1",
  });
  const exhausted = apply(activeTurn(), "BudgetExhausted", {
    dimension: "tool_calls",
    limit: 1,
    turnId: "turn-1",
    used: 1,
  });
  const cancellationRequested = apply(
    activeTurn(),
    "TurnCancellationRequested",
    { reason: "user", turnId: "turn-1" },
  );
  const cancelled = apply(cancellationRequested, "TurnCancelled", {
    reason: "settled",
    turnId: "turn-1",
  });

  const laterEvents = [
    ["UserMessageQueued", { messageId: "message-1", position: 1, text: "x", turnId: "turn-1" }],
    ["UserMessageAccepted", { messageId: "message-1", text: "q", turnId: "turn-1" }],
    ["TurnStarted", { messageId: "message-1", turnId: "turn-1" }],
    ["AssistantTextDelta", { text: "x", turnId: "turn-1" }],
    ["ToolCallStarted", { callId: "call-1", toolName: "tool@1", turnId: "turn-1" }],
    ["ToolCallCompleted", { callId: "call-1", observation: {}, toolName: "tool@1", turnId: "turn-1" }],
    ["ToolCallFailed", { callId: "call-1", code: "action_failed", message: "failed", toolName: "tool@1", turnId: "turn-1" }],
    ["UsageReported", { inputTokens: 1, outputTokens: 1, turnId: "turn-1" }],
    ["BudgetWarning", { dimension: "tool_calls", limit: 2, turnId: "turn-1", used: 1 }],
    ["BudgetExhausted", { dimension: "tool_calls", limit: 1, turnId: "turn-1", used: 1 }],
    ["TurnCancellationRequested", { reason: "user", turnId: "turn-1" }],
    ["TurnCancelled", { reason: "settled", turnId: "turn-1" }],
    ["TurnFailed", { code: "provider_failed", message: "failed", turnId: "turn-1" }],
    ["TurnCompleted", { text: "", turnId: "turn-1" }],
  ] as const;

  for (const terminal of [completed, failed, exhausted, cancelled]) {
    for (const [type, payload] of laterEvents) {
      assertIllegal(() => apply(terminal, type, payload));
    }
  }
});

function activeTurn(): RobinTurnState {
  return apply(
    apply(undefined, "UserMessageAccepted", {
      messageId: "message-1",
      text: "q",
      turnId: "turn-1",
    }),
    "TurnStarted",
    { messageId: "message-1", turnId: "turn-1" },
  );
}

function apply(
  state: RobinTurnState | undefined,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): RobinTurnState {
  const event = parseRobinApplicationEvent({
    eventId: "event-1",
    occurredAt: "2026-08-30T00:00:00.000Z",
    payload,
    schemaVersion: 1,
    sequence: 1,
    sessionId: "session-1",
    type,
  }) as RobinTurnApplicationEvent;
  return reduceRobinTurn(state, event);
}

function assertIllegal(callback: () => unknown): void {
  assert.throws(
    callback,
    (error: unknown) =>
      error instanceof RobinSessionError && error.code === "illegal_transition",
  );
}
