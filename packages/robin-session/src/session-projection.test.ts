import assert from "node:assert/strict";
import test from "node:test";

import { RobinSessionError } from "./application-event.js";
import {
  MAXIMUM_QUEUED_ROBIN_MESSAGES,
  createEmptyRobinSessionProjection,
  reduceRobinSessionProjection,
  replayRobinSession,
  type RobinSessionProjection,
} from "./session-projection.js";

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

function assertSessionError(
  callback: () => unknown,
  code: RobinSessionError["code"],
): void {
  assert.throws(
    callback,
    (error: unknown) => error instanceof RobinSessionError && error.code === code,
  );
}
