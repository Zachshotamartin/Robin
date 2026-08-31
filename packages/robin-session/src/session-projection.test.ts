import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256Hex } from "@guard/contracts";

import { RobinSessionError } from "./application-event.js";
import {
  MAXIMUM_QUEUED_ROBIN_MESSAGES,
  createEmptyRobinSessionProjection,
  reduceRobinSessionProjection,
  replayRobinSession,
  type RobinSessionProjection,
} from "./session-projection.js";

const ACTION_ID = "act_018f05a0-7b01-7000-8000-000000000081";
const SECOND_ACTION_ID = "act_018f05a0-7b01-7000-8000-000000000084";
const APPROVAL_ID = "apr_018f05a0-7b01-7000-8000-000000000082";
const POLICY_VERSION_ID = "pol_018f05a0-7b01-7000-8000-000000000083";
const DISPLAYED_SUMMARY = Object.freeze({
  schemaVersion: 1,
  operation: "Apply exact patch to src/index.ts",
});

test("replays one complete ephemeral synthetic session without effects", () => {
  const state = replayRobinSession([
    event(1, "SessionStarted", {
      permissionMode: "ask",
      persistence: "ephemeral",
      providerProfile: "synthetic",
    }),
    event(2, "UserMessageAccepted", {
      messageId: "message-1",
      text: "hello",
      turnId: "turn-1",
    }),
    event(3, "TurnStarted", {
      messageId: "message-1",
      turnId: "turn-1",
    }),
    event(4, "AssistantTextDelta", { text: "hi", turnId: "turn-1" }),
    event(5, "TurnCompleted", { text: "hi", turnId: "turn-1" }),
    event(6, "PermissionModeChanged", { permissionMode: "plan" }),
    event(7, "SessionClosed", { reason: "user" }),
  ]);

  assert.equal(state.status, "closed");
  assert.equal(state.permissionMode, "plan");
  assert.equal(state.lastSequence, 7);
  assert.equal(state.turns[0]?.status, "completed");
  assert.equal(state.activeTurnId, null);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.turns));
});

test("requires SessionStarted first and exact contiguous sequence", () => {
  assertSessionError(
    () => replayRobinSession([event(1, "SessionClosed", { reason: "user" })]),
    "illegal_transition",
  );
  assertSessionError(
    () =>
      replayRobinSession([
        event(1, "SessionStarted", startPayload()),
        event(3, "PermissionModeChanged", { permissionMode: "plan" }),
      ]),
    "sequence_conflict",
  );
  assertSessionError(
    () =>
      replayRobinSession([
        event(1, "SessionStarted", startPayload()),
        event(1, "PermissionModeChanged", { permissionMode: "plan" }),
      ]),
    "sequence_conflict",
  );
});

test("rejects cross-session events and all events after close", () => {
  let state = reduceRobinSessionProjection(
    createEmptyRobinSessionProjection(),
    event(1, "SessionStarted", startPayload()),
  );
  assertSessionError(
    () =>
      reduceRobinSessionProjection(
        state,
        { ...event(2, "PermissionModeChanged", { permissionMode: "plan" }), sessionId: "other" },
      ),
    "illegal_transition",
  );
  state = reduceRobinSessionProjection(
    state,
    event(2, "SessionClosed", { reason: "user" }),
  );
  assertSessionError(
    () =>
      reduceRobinSessionProjection(
        state,
        event(3, "PermissionModeChanged", { permissionMode: "plan" }),
      ),
    "illegal_transition",
  );
});

test("enforces one active turn, an eight-message queue, and FIFO acceptance", () => {
  let state = openWithActiveTurn();
  for (let index = 1; index <= MAXIMUM_QUEUED_ROBIN_MESSAGES; index += 1) {
    state = reduceRobinSessionProjection(
      state,
      event(3 + index, "UserMessageQueued", {
        messageId: `message-${index + 1}`,
        position: index,
        text: `queued-${index}`,
        turnId: `turn-${index + 1}`,
      }),
    );
  }
  assert.equal(state.queuedTurnIds.length, 8);
  assertSessionError(
    () =>
      reduceRobinSessionProjection(
        state,
        event(12, "UserMessageQueued", {
          messageId: "message-10",
          position: 9,
          text: "overflow",
          turnId: "turn-10",
        }),
      ),
    "illegal_transition",
  );

  state = reduceRobinSessionProjection(
    state,
    event(12, "TurnCompleted", { text: "", turnId: "turn-1" }),
  );
  assertSessionError(
    () =>
      reduceRobinSessionProjection(
        state,
        event(13, "UserMessageAccepted", {
          messageId: "message-3",
          text: "queued-2",
          turnId: "turn-3",
        }),
      ),
    "illegal_transition",
  );
  state = reduceRobinSessionProjection(
    state,
    event(13, "UserMessageAccepted", {
      messageId: "message-2",
      text: "queued-1",
      turnId: "turn-2",
    }),
  );
  assert.equal(state.turns.find((turn) => turn.turnId === "turn-2")?.status, "accepted");
  assert.equal(state.queuedTurnIds[0], "turn-3");
});

test("cannot accept a second foreground turn or close with unsettled work", () => {
  const state = openWithActiveTurn();
  assertSessionError(
    () =>
      reduceRobinSessionProjection(
        state,
        event(4, "UserMessageAccepted", {
          messageId: "message-2",
          text: "second",
          turnId: "turn-2",
        }),
      ),
    "illegal_transition",
  );
  assertSessionError(
    () =>
      reduceRobinSessionProjection(
        state,
        event(4, "SessionClosed", { reason: "shutdown" }),
      ),
    "illegal_transition",
  );
});

test("queues a concurrent submit between acceptance and TurnStarted", () => {
  let state = replayRobinSession([
    event(1, "SessionStarted", startPayload()),
    event(2, "UserMessageAccepted", {
      messageId: "message-1",
      text: "first",
      turnId: "turn-1",
    }),
  ]);
  state = reduceRobinSessionProjection(
    state,
    event(3, "UserMessageQueued", {
      messageId: "message-2",
      position: 1,
      text: "concurrent",
      turnId: "turn-2",
    }),
  );
  assert.equal(state.activeTurnId, null);
  assert.deepEqual(state.queuedTurnIds, ["turn-2"]);
  state = reduceRobinSessionProjection(
    state,
    event(4, "TurnStarted", {
      messageId: "message-1",
      turnId: "turn-1",
    }),
  );
  assert.equal(state.activeTurnId, "turn-1");
  assert.deepEqual(state.queuedTurnIds, ["turn-2"]);
});

test("queued cancellation settles independently of the active turn", () => {
  let state = openWithActiveTurn();
  state = reduceRobinSessionProjection(
    state,
    event(4, "UserMessageQueued", {
      messageId: "message-2",
      position: 1,
      text: "queued",
      turnId: "turn-2",
    }),
  );
  state = reduceRobinSessionProjection(
    state,
    event(5, "TurnCancellationRequested", {
      reason: "remove queued",
      turnId: "turn-2",
    }),
  );
  state = reduceRobinSessionProjection(
    state,
    event(6, "TurnCancelled", { reason: "removed", turnId: "turn-2" }),
  );
  assert.equal(state.activeTurnId, "turn-1");
  assert.deepEqual(state.queuedTurnIds, []);
  assert.equal(state.turns.find((turn) => turn.turnId === "turn-2")?.status, "cancelled");
});

test("replays tool failure settlement before turn cancellation and close", () => {
  const state = replayRobinSession([
    event(1, "SessionStarted", startPayload()),
    event(2, "UserMessageAccepted", {
      messageId: "message-1",
      text: "first",
      turnId: "turn-1",
    }),
    event(3, "TurnStarted", {
      messageId: "message-1",
      turnId: "turn-1",
    }),
    event(4, "ToolCallStarted", {
      callId: "call-1",
      toolName: "tool@1",
      turnId: "turn-1",
    }),
    event(5, "TurnCancellationRequested", {
      reason: "user",
      turnId: "turn-1",
    }),
    event(6, "ToolCallFailed", {
      callId: "call-1",
      code: "cancelled",
      message: "tool cancellation confirmed",
      toolName: "tool@1",
      turnId: "turn-1",
    }),
    event(7, "TurnCancelled", {
      reason: "settled",
      turnId: "turn-1",
    }),
    event(8, "SessionClosed", { reason: "shutdown" }),
  ]);
  assert.equal(state.status, "closed");
  assert.equal(state.turns[0]?.status, "cancelled");
  assert.deepEqual(state.turns[0]?.toolCalls[0]?.failure, {
    code: "cancelled",
    message: "tool cancellation confirmed",
  });
});

test("replay deterministically reconstructs ordered tool output without effects", () => {
  const events = [
    event(1, "SessionStarted", startPayload()),
    event(2, "UserMessageAccepted", {
      messageId: "message-1",
      text: "run tests",
      turnId: "turn-1",
    }),
    event(3, "TurnStarted", {
      messageId: "message-1",
      turnId: "turn-1",
    }),
    event(4, "ToolCallStarted", {
      callId: "call-1",
      toolName: "robin.process.run@1",
      turnId: "turn-1",
    }),
    event(5, "PermissionDecided", permissionDecisionPayload({
      effect: "allow",
      toolName: "robin.process.run@1",
      winningPolicyName: null,
    })),
    event(6, "ToolOutputDelta", toolOutputPayload({
      safeText: "not ok\u001b[31m",
    })),
    event(7, "ToolOutputDelta", toolOutputPayload({
      byteLength: 2,
      safeText: "ok",
      sequence: 2,
    })),
    event(8, "ToolCallCompleted", {
      callId: "call-1",
      observation: { classification: "success" },
      toolName: "robin.process.run@1",
      turnId: "turn-1",
    }),
    event(9, "TurnCompleted", { text: "", turnId: "turn-1" }),
    event(10, "SessionClosed", { reason: "user" }),
  ];

  const first = replayRobinSession(events);
  const second = replayRobinSession(
    events.map((value) => structuredClone(value)),
  );
  assert.deepEqual(first, second);
  assert.equal(first.status, "closed");
  assert.deepEqual(first.turns[0]?.toolCalls[0]?.outputDeltas, [
    {
      byteLength: 5,
      callId: "call-1",
      channel: "stdout",
      limitExceeded: false,
      safeText: "not ok\\u{1b}[31m",
      sequence: 1,
      textTruncated: false,
      toolName: "robin.process.run@1",
      turnId: "turn-1",
    },
    {
      byteLength: 2,
      callId: "call-1",
      channel: "stdout",
      limitExceeded: false,
      safeText: "ok",
      sequence: 2,
      textTruncated: false,
      toolName: "robin.process.run@1",
      turnId: "turn-1",
    },
  ]);
  assert.equal(
    first.turns[0]?.toolCalls[0]?.permission?.effect,
    "allow",
  );
  assert.equal(Object.isFrozen(first.turns[0]?.toolCalls[0]?.outputDeltas), true);
});

test("replay reconstructs the exact immutable pending approval without effects", () => {
  const events = [
    event(1, "SessionStarted", startPayload()),
    event(2, "UserMessageAccepted", {
      messageId: "message-1",
      text: "edit",
      turnId: "turn-1",
    }),
    event(3, "TurnStarted", {
      messageId: "message-1",
      turnId: "turn-1",
    }),
    event(4, "ToolCallStarted", {
      callId: "call-1",
      toolName: "robin.edit.apply_patch@1",
      turnId: "turn-1",
    }),
    event(5, "PermissionDecided", permissionDecisionPayload()),
    event(6, "ApprovalRequested", approvalRequestPayload()),
  ];

  const first = replayRobinSession(events);
  const second = replayRobinSession(events.map((value) => ({ ...value })));
  assert.deepEqual(first, second);
  assert.deepEqual(first.pendingApproval, {
    ...approvalRequestPayload(),
    status: "pending",
  });
  assert.equal(Object.isFrozen(first.pendingApproval), true);
  assert.equal(
    first.turns[0]?.toolCalls[0]?.approval,
    first.pendingApproval,
  );

  const cancelled = reduceRobinSessionProjection(
    first,
    event(7, "TurnCancellationRequested", {
      reason: "user",
      turnId: "turn-1",
    }),
  );
  assert.equal(cancelled.pendingApproval, null);
  assert.equal(
    cancelled.turns[0]?.toolCalls[0]?.approval?.status,
    "cancelled",
  );
});

test("replay preserves a post-grant stale approval and no pending authority", () => {
  const events = [
    event(1, "SessionStarted", startPayload()),
    event(2, "UserMessageAccepted", {
      messageId: "message-1",
      text: "edit",
      turnId: "turn-1",
    }),
    event(3, "TurnStarted", {
      messageId: "message-1",
      turnId: "turn-1",
    }),
    event(4, "ToolCallStarted", {
      callId: "call-1",
      toolName: "robin.edit.apply_patch@1",
      turnId: "turn-1",
    }),
    event(5, "PermissionDecided", permissionDecisionPayload()),
    event(6, "ApprovalRequested", approvalRequestPayload()),
    event(7, "ApprovalResolved", approvalResolutionPayload()),
    event(8, "ApprovalInvalidated", approvalInvalidationPayload()),
  ];

  const first = replayRobinSession(events);
  const second = replayRobinSession(events.map((value) => ({ ...value })));
  assert.deepEqual(first, second);
  assert.equal(first.pendingApproval, null);
  assert.deepEqual(first.turns[0]?.toolCalls[0]?.approval, {
    ...approvalRequestPayload(),
    decision: "allow_once",
    invalidatedAt: "2026-08-30T12:01:00.000Z",
    invalidationReason: "preconditions_changed",
    observedPreconditionHash: "e".repeat(64),
    outcome: "stale",
    resolvedAt: "2026-08-30T12:00:30.000Z",
    status: "stale",
  });
});

test("session replay rejects approval identifier reuse across turns", () => {
  const firstResolution = approvalResolutionPayload({
    decision: "deny",
    outcome: "denied",
  });
  const state = replayRobinSession([
    event(1, "SessionStarted", startPayload()),
    event(2, "UserMessageAccepted", {
      messageId: "message-1",
      text: "first",
      turnId: "turn-1",
    }),
    event(3, "TurnStarted", {
      messageId: "message-1",
      turnId: "turn-1",
    }),
    event(4, "ToolCallStarted", {
      callId: "call-1",
      toolName: "robin.edit.apply_patch@1",
      turnId: "turn-1",
    }),
    event(5, "PermissionDecided", permissionDecisionPayload()),
    event(6, "ApprovalRequested", approvalRequestPayload()),
    event(7, "ApprovalResolved", firstResolution),
    event(8, "ToolCallCompleted", {
      callId: "call-1",
      observation: { effectOccurred: false, reason: "user_denied" },
      toolName: "robin.edit.apply_patch@1",
      turnId: "turn-1",
    }),
    event(9, "TurnCompleted", { text: "", turnId: "turn-1" }),
    event(10, "UserMessageAccepted", {
      messageId: "message-2",
      text: "second",
      turnId: "turn-2",
    }),
    event(11, "TurnStarted", {
      messageId: "message-2",
      turnId: "turn-2",
    }),
    event(12, "ToolCallStarted", {
      callId: "call-2",
      toolName: "robin.edit.apply_patch@1",
      turnId: "turn-2",
    }),
    event(13, "PermissionDecided", permissionDecisionPayload({
      actionHash: "e".repeat(64),
      actionId: SECOND_ACTION_ID,
      callId: "call-2",
      turnId: "turn-2",
    })),
  ]);

  assertSessionError(
    () =>
      reduceRobinSessionProjection(
        state,
        event(14, "ApprovalRequested", approvalRequestPayload({
          actionHash: "e".repeat(64),
          actionId: SECOND_ACTION_ID,
          callId: "call-2",
          turnId: "turn-2",
        })),
      ),
    "illegal_transition",
  );
});

function openWithActiveTurn(): RobinSessionProjection {
  return replayRobinSession([
    event(1, "SessionStarted", startPayload()),
    event(2, "UserMessageAccepted", {
      messageId: "message-1",
      text: "first",
      turnId: "turn-1",
    }),
    event(3, "TurnStarted", { messageId: "message-1", turnId: "turn-1" }),
  ]);
}

function startPayload(): Readonly<Record<string, unknown>> {
  return {
    permissionMode: "ask",
    persistence: "ephemeral",
    providerProfile: "synthetic",
  };
}

function event(
  sequence: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    eventId: `event-${sequence}`,
    occurredAt: "2026-08-30T00:00:00.000Z",
    payload,
    schemaVersion: 1,
    sequence,
    sessionId: "session-1",
    type,
  };
}

function toolOutputPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    byteLength: 5,
    callId: "call-1",
    channel: "stdout",
    limitExceeded: false,
    safeText: "first",
    sequence: 1,
    textTruncated: false,
    toolName: "robin.process.run@1",
    turnId: "turn-1",
    ...overrides,
  });
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

function assertSessionError(
  callback: () => unknown,
  code: RobinSessionError["code"],
): void {
  assert.throws(
    callback,
    (error: unknown) => error instanceof RobinSessionError && error.code === code,
  );
}
