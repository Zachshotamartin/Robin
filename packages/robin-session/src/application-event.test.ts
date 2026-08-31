import assert from "node:assert/strict";
import test from "node:test";

import {
  MAXIMUM_APPLICATION_EVENT_UTF8_BYTES,
  ROBIN_APPLICATION_EVENT_TYPES,
  RobinSessionError,
  parseRobinApplicationEvent,
  parseRobinApplicationEventJson,
  serializeRobinApplicationEvent,
} from "./application-event.js";

const PAYLOADS: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
  Object.freeze({
    SessionStarted: Object.freeze({
      permissionMode: "ask",
      persistence: "ephemeral",
      providerProfile: "synthetic",
    }),
    PermissionModeChanged: Object.freeze({ permissionMode: "plan" }),
    UserMessageQueued: Object.freeze({
      messageId: "message-1",
      position: 1,
      text: "queued",
      turnId: "turn-1",
    }),
    UserMessageAccepted: Object.freeze({
      messageId: "message-1",
      text: "accepted",
      turnId: "turn-1",
    }),
    TurnStarted: Object.freeze({ messageId: "message-1", turnId: "turn-1" }),
    AssistantTextDelta: Object.freeze({ text: "delta", turnId: "turn-1" }),
    ToolCallStarted: Object.freeze({
      callId: "call-1",
      toolName: "robin.synthetic.inspect_file@1",
      turnId: "turn-1",
    }),
    ToolCallCompleted: Object.freeze({
      callId: "call-1",
      observation: Object.freeze({ hash: "abc", lines: Object.freeze(["one"]) }),
      toolName: "robin.synthetic.inspect_file@1",
      turnId: "turn-1",
    }),
    ToolCallFailed: Object.freeze({
      callId: "call-1",
      code: "action_failed",
      message: "tool execution failed safely",
      toolName: "robin.synthetic.inspect_file@1",
      turnId: "turn-1",
    }),
    UsageReported: Object.freeze({
      inputTokens: 10,
      outputTokens: 4,
      turnId: "turn-1",
    }),
    BudgetWarning: Object.freeze({
      dimension: "output_tokens",
      limit: 10,
      turnId: "turn-1",
      used: 8,
    }),
    BudgetExhausted: Object.freeze({
      dimension: "tool_calls",
      limit: 2,
      turnId: "turn-1",
      used: 2,
    }),
    TurnCancellationRequested: Object.freeze({
      reason: "user",
      turnId: "turn-1",
    }),
    TurnCancelled: Object.freeze({ reason: "user", turnId: "turn-1" }),
    TurnFailed: Object.freeze({
      code: "provider_failed",
      message: "safe failure",
      turnId: "turn-1",
    }),
    TurnCompleted: Object.freeze({ text: "done", turnId: "turn-1" }),
    SessionClosed: Object.freeze({ reason: "user" }),
  });

test("parses and deeply freezes every R1 application event type", () => {
  assert.equal(ROBIN_APPLICATION_EVENT_TYPES.length, 17);
  for (const [index, type] of ROBIN_APPLICATION_EVENT_TYPES.entries()) {
    const parsed = parseRobinApplicationEvent(rawEvent(index + 1, type, PAYLOADS[type]!));
    assert.equal(parsed.type, type);
    assert.equal(parsed.sequence, index + 1);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.payload));
    assert.equal(
      parseRobinApplicationEventJson(serializeRobinApplicationEvent(parsed)).type,
      type,
    );
  }
});

test("canonical serialization is independent of insertion order", () => {
  const first = rawEvent(1, "SessionStarted", PAYLOADS["SessionStarted"]!);
  const second = {
    type: first.type,
    sessionId: first.sessionId,
    sequence: first.sequence,
    schemaVersion: first.schemaVersion,
    payload: first.payload,
    occurredAt: first.occurredAt,
    eventId: first.eventId,
  };
  assert.equal(
    serializeRobinApplicationEvent(first),
    serializeRobinApplicationEvent(second),
  );
  assert.match(serializeRobinApplicationEvent(first), /^\{"eventId":/);
});

test("rejects unknown versions, types, missing and extra keys", () => {
  const valid = rawEvent(1, "SessionStarted", PAYLOADS["SessionStarted"]!);
  for (const candidate of [
    { ...valid, schemaVersion: 2 },
    { ...valid, type: "FutureEvent" },
    { ...valid, extra: true },
    {
      ...valid,
      payload: { ...PAYLOADS["SessionStarted"]!, extra: true },
    },
    (() => {
      const { eventId: _eventId, ...missing } = valid;
      return missing;
    })(),
  ]) {
    assertInvalidEvent(candidate);
  }
});

test("bounds UTF-8 JSON, strings, invalid encodings, and numeric fields", () => {
  assertInvalidEventJson(
    new Uint8Array(MAXIMUM_APPLICATION_EVENT_UTF8_BYTES + 1),
  );
  assertInvalidEventJson(Uint8Array.from([0xc3, 0x28]));
  assertInvalidEventJson("{");
  assertInvalidEvent(
    rawEvent(1, "AssistantTextDelta", {
      text: "a".repeat(262_145),
      turnId: "turn-1",
    }),
  );
  assertInvalidEvent({
    ...rawEvent(1, "UsageReported", PAYLOADS["UsageReported"]!),
    sequence: 0,
  });
  assertInvalidEvent(
    rawEvent(1, "BudgetWarning", {
      dimension: "output_tokens",
      limit: 10,
      turnId: "turn-1",
      used: 10,
    }),
  );
});

test("escapes unsafe terminal controls in text and nested observations", () => {
  const delta = parseRobinApplicationEvent(
    rawEvent(1, "AssistantTextDelta", {
      text: "safe\u001b]52;clipboard\u0007\r",
      turnId: "turn-1",
    }),
  );
  assert.equal(
    delta.type === "AssistantTextDelta" ? delta.payload.text : "",
    "safe\\u{1b}]52;clipboard\\u{07}\\u{0d}",
  );

  const tool = parseRobinApplicationEvent(
    rawEvent(1, "ToolCallCompleted", {
      callId: "call-1",
      observation: { nested: ["x\u001by"] },
      toolName: "tool@1",
      turnId: "turn-1",
    }),
  );
  assert.deepEqual(
    tool.type === "ToolCallCompleted" ? tool.payload.observation : {},
    { nested: ["x\\u{1b}y"] },
  );
  assertInvalidEvent({ ...rawEvent(1, "SessionClosed", { reason: "user" }), sessionId: "bad\u001b" });
  assertInvalidEvent({
    ...rawEvent(1, "SessionClosed", { reason: "user" }),
    eventId: "bad\nidentifier",
  });
});

test("validates and escapes classified tool failures", () => {
  const failed = parseRobinApplicationEvent(
    rawEvent(1, "ToolCallFailed", {
      callId: "call-1",
      code: "cancelled",
      message: "cancelled\u001b]52;unsafe\u0007",
      toolName: "tool@1",
      turnId: "turn-1",
    }),
  );
  assert.equal(failed.type, "ToolCallFailed");
  if (failed.type === "ToolCallFailed") {
    assert.equal(failed.payload.code, "cancelled");
    assert.equal(
      failed.payload.message,
      "cancelled\\u{1b}]52;unsafe\\u{07}",
    );
  }
  assertInvalidEvent(
    rawEvent(1, "ToolCallFailed", {
      ...PAYLOADS["ToolCallFailed"],
      code: "not_a_domain_code",
    }),
  );
  assertInvalidEvent(
    rawEvent(1, "ToolCallFailed", {
      ...PAYLOADS["ToolCallFailed"],
      extra: true,
    }),
  );
});

test("does not invoke accessors or accept proxies at the boundary", () => {
  let invoked = false;
  const event = rawEvent(1, "SessionStarted", PAYLOADS["SessionStarted"]!);
  Object.defineProperty(event, "type", {
    enumerable: true,
    get() {
      invoked = true;
      return "SessionStarted";
    },
  });
  assertInvalidEvent(event);
  assert.equal(invoked, false);
  assertInvalidEvent(new Proxy(rawEvent(1, "SessionStarted", PAYLOADS["SessionStarted"]!), {}));
});

test("takes an immutable detached snapshot of caller-owned payloads", () => {
  const payload = { text: "before", turnId: "turn-1" };
  const parsed = parseRobinApplicationEvent(rawEvent(1, "AssistantTextDelta", payload));
  payload.text = "after";
  assert.equal(
    parsed.type === "AssistantTextDelta" ? parsed.payload.text : "",
    "before",
  );
});

function rawEvent(
  sequence: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
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

function assertInvalidEvent(value: unknown): void {
  assert.throws(
    () => parseRobinApplicationEvent(value),
    (error: unknown) =>
      error instanceof RobinSessionError && error.code === "invalid_event",
  );
}

function assertInvalidEventJson(value: string | Uint8Array): void {
  assert.throws(
    () => parseRobinApplicationEventJson(value),
    (error: unknown) =>
      error instanceof RobinSessionError && error.code === "invalid_event",
  );
}
