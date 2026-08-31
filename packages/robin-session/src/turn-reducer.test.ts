import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256Hex } from "@guard/contracts";

import {
  RobinSessionError,
  parseRobinApplicationEvent,
  type RobinTurnApplicationEvent,
} from "./application-event.js";
import { classifyRobinBudget } from "./budgets.js";
import { reduceRobinTurn } from "./turn-reducer.js";
import type { RobinTurnState } from "./turn-state.js";

const ACTION_ID = "act_018f05a0-7b01-7000-8000-000000000081";
const APPROVAL_ID = "apr_018f05a0-7b01-7000-8000-000000000082";
const POLICY_VERSION_ID = "pol_018f05a0-7b01-7000-8000-000000000083";
const OTHER_ACTION_ID = "act_018f05a0-7b01-7000-8000-000000000084";
const OTHER_APPROVAL_ID = "apr_018f05a0-7b01-7000-8000-000000000085";
const DISPLAYED_SUMMARY = Object.freeze({
  schemaVersion: 1,
  operation: "Apply exact patch to src/index.ts",
});

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
  state = apply(state, "PermissionDecided", permissionDecisionPayload({
    callId: "call-1",
    effect: "allow",
    toolName: "robin.synthetic.inspect_file@1",
    winningPolicyName: null,
  }));
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

test("approval request and allow-once resolution bind the exact active tool", () => {
  let state = apply(activeTurn(), "ToolCallStarted", {
    callId: "call-1",
    toolName: "robin.edit.apply_patch@1",
    turnId: "turn-1",
  });
  state = apply(state, "PermissionDecided", permissionDecisionPayload());
  state = apply(state, "ApprovalRequested", approvalRequestPayload());
  assert.deepEqual(state.toolCalls[0]?.approval, {
    ...approvalRequestPayload(),
    status: "pending",
  });
  assert.equal(Object.isFrozen(state.toolCalls[0]?.approval), true);

  state = apply(state, "ApprovalResolved", approvalResolutionPayload());
  assert.deepEqual(state.toolCalls[0]?.approval, {
    ...approvalRequestPayload(),
    decision: "allow_once",
    outcome: "granted",
    resolvedAt: "2026-08-30T12:00:30.000Z",
    status: "granted",
  });
  state = apply(state, "ToolCallCompleted", {
    callId: "call-1",
    observation: { changed: true },
    toolName: "robin.edit.apply_patch@1",
    turnId: "turn-1",
  });
  assert.equal(state.toolCalls[0]?.status, "completed");
  assert.equal(state.toolCalls[0]?.approval?.status, "granted");
});

test("approval denial and staleness are terminal one-use decisions", () => {
  for (const resolution of [
    { decision: "deny", outcome: "denied", resolvedAt: "2026-08-30T12:00:30.000Z" },
    { decision: "allow_once", outcome: "stale", resolvedAt: "2026-08-30T12:05:00.000Z" },
  ] as const) {
    let state = apply(activeTurn(), "ToolCallStarted", {
      callId: "call-1",
      toolName: "robin.edit.apply_patch@1",
      turnId: "turn-1",
    });
    state = apply(state, "PermissionDecided", permissionDecisionPayload());
    state = apply(state, "ApprovalRequested", approvalRequestPayload());
    state = apply(
      state,
      "ApprovalResolved",
      approvalResolutionPayload(resolution),
    );
    assert.equal(state.toolCalls[0]?.approval?.status, resolution.outcome);
    assertIllegal(() =>
      apply(
        state,
        "ApprovalResolved",
        approvalResolutionPayload(resolution),
      ),
    );
    assertIllegal(() =>
      apply(state, "ApprovalRequested", approvalRequestPayload()),
    );
    state = apply(state, "ToolCallCompleted", {
      callId: "call-1",
      observation: {
        effectOccurred: false,
        reason: resolution.outcome,
      },
      toolName: "robin.edit.apply_patch@1",
      turnId: "turn-1",
    });
    assert.equal(state.toolCalls[0]?.status, "completed");
  }
});

test("a granted approval can be invalidated exactly once before execution", () => {
  let state = apply(activeTurn(), "ToolCallStarted", {
    callId: "call-1",
    toolName: "robin.edit.apply_patch@1",
    turnId: "turn-1",
  });
  assertIllegal(() =>
    apply(state, "ApprovalInvalidated", approvalInvalidationPayload()),
  );
  state = apply(state, "PermissionDecided", permissionDecisionPayload());
  state = apply(state, "ApprovalRequested", approvalRequestPayload());
  assertIllegal(() =>
    apply(state, "ApprovalInvalidated", approvalInvalidationPayload()),
  );
  state = apply(state, "ApprovalResolved", approvalResolutionPayload());
  for (const mutation of approvalBindingMutations()) {
    assertIllegal(() =>
      apply(
        state,
        "ApprovalInvalidated",
        approvalInvalidationPayload(mutation),
      ),
    );
  }
  state = apply(state, "ApprovalInvalidated", approvalInvalidationPayload());
  assert.deepEqual(state.toolCalls[0]?.approval, {
    ...approvalRequestPayload(),
    decision: "allow_once",
    invalidatedAt: "2026-08-30T12:01:00.000Z",
    invalidationReason: "preconditions_changed",
    observedPreconditionHash: "e".repeat(64),
    outcome: "stale",
    resolvedAt: "2026-08-30T12:00:30.000Z",
    status: "stale",
  });
  assertIllegal(() =>
    apply(state, "ApprovalInvalidated", approvalInvalidationPayload()),
  );
  assertIllegal(() =>
    apply(state, "ToolCallCompleted", {
      callId: "call-1",
      observation: { effectOccurred: true },
      toolName: "robin.edit.apply_patch@1",
      turnId: "turn-1",
    }),
  );
  state = apply(state, "ToolCallCompleted", {
    callId: "call-1",
    observation: {
      effectOccurred: false,
      reason: "preconditions_changed",
    },
    toolName: "robin.edit.apply_patch@1",
    turnId: "turn-1",
  });
  assert.equal(state.toolCalls[0]?.status, "completed");
  assert.equal(state.toolCalls[0]?.approval?.status, "stale");
});

test("approval sequencing rejects unmatched, duplicate, and rebound decisions", () => {
  const active = activeTurn();
  assertIllegal(() =>
    apply(active, "ApprovalRequested", approvalRequestPayload()),
  );
  let state = apply(active, "ToolCallStarted", {
    callId: "call-1",
    toolName: "robin.edit.apply_patch@1",
    turnId: "turn-1",
  });
  assertIllegal(() =>
    apply(state, "ApprovalRequested", approvalRequestPayload()),
  );
  state = apply(state, "PermissionDecided", permissionDecisionPayload());
  assertIllegal(() =>
    apply(state, "PermissionDecided", permissionDecisionPayload()),
  );
  assertIllegal(() =>
    apply(
      state,
      "ApprovalRequested",
      approvalRequestPayload({ callId: "call-other" }),
    ),
  );
  assertIllegal(() =>
    apply(state, "ApprovalResolved", approvalResolutionPayload()),
  );
  state = apply(state, "ApprovalRequested", approvalRequestPayload());
  assertIllegal(() =>
    apply(state, "ApprovalRequested", approvalRequestPayload()),
  );
  for (const mutation of approvalBindingMutations()) {
    assertIllegal(() =>
      apply(
        state,
        "ApprovalResolved",
        approvalResolutionPayload(mutation),
      ),
    );
  }
  assertIllegal(() =>
    apply(state, "ToolCallCompleted", {
      callId: "call-1",
      observation: {},
      toolName: "robin.edit.apply_patch@1",
      turnId: "turn-1",
    }),
  );
});

test("cancellation and terminal failure deterministically invalidate pending approval", () => {
  let cancelling = apply(activeTurn(), "ToolCallStarted", {
    callId: "call-1",
    toolName: "robin.edit.apply_patch@1",
    turnId: "turn-1",
  });
  cancelling = apply(
    cancelling,
    "PermissionDecided",
    permissionDecisionPayload(),
  );
  cancelling = apply(
    cancelling,
    "ApprovalRequested",
    approvalRequestPayload(),
  );
  cancelling = apply(cancelling, "TurnCancellationRequested", {
    reason: "user",
    turnId: "turn-1",
  });
  assert.equal(cancelling.toolCalls[0]?.approval?.status, "cancelled");
  assert.equal(
    cancelling.toolCalls[0]?.approval?.resolvedAt,
    "2026-08-30T00:00:00.000Z",
  );
  assertIllegal(() =>
    apply(
      cancelling,
      "ApprovalResolved",
      approvalResolutionPayload(),
    ),
  );
  cancelling = apply(cancelling, "ToolCallFailed", {
    callId: "call-1",
    code: "cancelled",
    message: "approval wait cancelled",
    toolName: "robin.edit.apply_patch@1",
    turnId: "turn-1",
  });
  cancelling = apply(cancelling, "TurnCancelled", {
    reason: "settled",
    turnId: "turn-1",
  });
  assert.equal(cancelling.status, "cancelled");

  let failed = apply(activeTurn(), "ToolCallStarted", {
    callId: "call-1",
    toolName: "robin.edit.apply_patch@1",
    turnId: "turn-1",
  });
  failed = apply(failed, "PermissionDecided", permissionDecisionPayload());
  failed = apply(failed, "ApprovalRequested", approvalRequestPayload());
  failed = apply(failed, "TurnFailed", {
    code: "infrastructure_failed",
    message: "approval broker failed",
    turnId: "turn-1",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.toolCalls[0]?.approval?.status, "invalidated");
});

test("cancellation waits for an active tool to settle", () => {
  let state = apply(activeTurn(), "ToolCallStarted", {
    callId: "call-1",
    toolName: "tool@1",
    turnId: "turn-1",
  });
  state = apply(state, "PermissionDecided", permissionDecisionPayload({
    effect: "allow",
    toolName: "tool@1",
    winningPolicyName: null,
  }));
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

test("permission is exactly once and controls direct completion semantics", () => {
  for (const effect of ["allow", "deny"] as const) {
    let state = apply(activeTurn(), "ToolCallStarted", {
      callId: "call-1",
      toolName: "tool@1",
      turnId: "turn-1",
    });
    assertIllegal(() =>
      apply(state, "ToolCallCompleted", {
        callId: "call-1",
        observation: {},
        toolName: "tool@1",
        turnId: "turn-1",
      }),
    );
    state = apply(state, "PermissionDecided", permissionDecisionPayload({
      effect,
      toolName: "tool@1",
      winningPolicyName: effect === "allow" ? null : "r2.plan.deny",
    }));
    assert.equal(state.toolCalls[0]?.permission?.effect, effect);
    assertIllegal(() =>
      apply(state, "PermissionDecided", permissionDecisionPayload({
        effect,
        toolName: "tool@1",
      })),
    );
    assertIllegal(() =>
      apply(state, "ApprovalRequested", approvalRequestPayload({
        toolName: "tool@1",
      })),
    );
    if (effect === "deny") {
      assertIllegal(() =>
        apply(state, "ToolCallCompleted", {
          callId: "call-1",
          observation: { effectOccurred: true },
          toolName: "tool@1",
          turnId: "turn-1",
        }),
      );
    }
    state = apply(state, "ToolCallCompleted", {
      callId: "call-1",
      observation: effect === "deny" ? { effectOccurred: false } : { ok: true },
      toolName: "tool@1",
      turnId: "turn-1",
    });
    assert.equal(state.toolCalls[0]?.status, "completed");
  }
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
    ["PermissionDecided", permissionDecisionPayload()],
    ["ApprovalRequested", approvalRequestPayload()],
    ["ApprovalResolved", approvalResolutionPayload()],
    ["ApprovalInvalidated", approvalInvalidationPayload()],
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
    ["PermissionDecided", permissionDecisionPayload()],
    ["ApprovalRequested", approvalRequestPayload()],
    ["ApprovalResolved", approvalResolutionPayload()],
    ["ApprovalInvalidated", approvalInvalidationPayload()],
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

function approvalRequestPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    actionHash: "a".repeat(64),
    actionId: ACTION_ID,
    approvalId: APPROVAL_ID,
    callId: "call-1",
    displayedSummary: DISPLAYED_SUMMARY,
    displayedSummaryHash: canonicalSha256Hex(DISPLAYED_SUMMARY),
    expiresAt: "2026-08-30T12:05:00.000Z",
    normalizedRequestHash: "b".repeat(64),
    policySnapshotHash: "d".repeat(64),
    preconditionHash: "c".repeat(64),
    requestedAt: "2026-08-30T12:00:00.000Z",
    toolName: "robin.edit.apply_patch@1",
    turnId: "turn-1",
    ...overrides,
  });
}

function permissionDecisionPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    actionHash: "a".repeat(64),
    actionId: ACTION_ID,
    callId: "call-1",
    effect: "require_approval",
    policySnapshotHash: "d".repeat(64),
    policyVersionId: POLICY_VERSION_ID,
    toolName: "robin.edit.apply_patch@1",
    turnId: "turn-1",
    winningPolicyName: "r2.default.edit.ask",
    ...overrides,
  });
}

function approvalResolutionPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const requested = approvalRequestPayload();
  const { displayedSummary: _displayedSummary, ...binding } = requested;
  return Object.freeze({
    ...binding,
    decision: "allow_once",
    outcome: "granted",
    resolvedAt: "2026-08-30T12:00:30.000Z",
    ...overrides,
  });
}

function approvalInvalidationPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const requested = approvalRequestPayload();
  const { displayedSummary: _displayedSummary, ...binding } = requested;
  return Object.freeze({
    ...binding,
    invalidatedAt: "2026-08-30T12:01:00.000Z",
    observedPreconditionHash: "e".repeat(64),
    reason: "preconditions_changed",
    ...overrides,
  });
}

function approvalBindingMutations(): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze([
    Object.freeze({ actionHash: "f".repeat(64) }),
    Object.freeze({ actionId: OTHER_ACTION_ID }),
    Object.freeze({ approvalId: OTHER_APPROVAL_ID }),
    Object.freeze({ callId: "call-other" }),
    Object.freeze({ displayedSummaryHash: "f".repeat(64) }),
    Object.freeze({ expiresAt: "2026-08-30T12:06:00.000Z" }),
    Object.freeze({ normalizedRequestHash: "f".repeat(64) }),
    Object.freeze({ policySnapshotHash: "f".repeat(64) }),
    Object.freeze({ preconditionHash: "f".repeat(64) }),
    Object.freeze({ requestedAt: "2026-08-30T11:59:00.000Z" }),
    Object.freeze({ toolName: "robin.process.run@1" }),
    Object.freeze({ turnId: "turn-other" }),
  ]);
}

function assertIllegal(callback: () => unknown): void {
  assert.throws(
    callback,
    (error: unknown) =>
      error instanceof RobinSessionError && error.code === "illegal_transition",
  );
}
