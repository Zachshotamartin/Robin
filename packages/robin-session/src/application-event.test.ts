import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256Hex } from "@guard/contracts";

import {
  MAXIMUM_APPLICATION_EVENT_UTF8_BYTES,
  MAXIMUM_TOOL_OUTPUT_DELTAS_PER_CALL,
  MAXIMUM_TOOL_OUTPUT_DELTA_TEXT_UTF8_BYTES,
  MAXIMUM_TOOL_OUTPUT_SOURCE_BYTES_PER_CALL,
  ROBIN_APPLICATION_EVENT_TYPES,
  RobinSessionError,
  parseRobinApplicationEvent,
  parseRobinApplicationEventJson,
  serializeRobinApplicationEvent,
} from "./application-event.js";

const ACTION_ID = "act_018f05a0-7b01-7000-8000-000000000081";
const APPROVAL_ID = "apr_018f05a0-7b01-7000-8000-000000000082";
const POLICY_VERSION_ID = "pol_018f05a0-7b01-7000-8000-000000000083";
const DISPLAYED_SUMMARY = Object.freeze({
  schemaVersion: 1,
  operation: "Apply exact patch to src/index.ts",
});

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
    ToolOutputDelta: Object.freeze({
      byteLength: 6,
      callId: "call-1",
      channel: "stdout",
      limitExceeded: false,
      safeText: "output",
      sequence: 1,
      textTruncated: false,
      toolName: "robin.process.run@1",
      turnId: "turn-1",
    }),
    PermissionDecided: permissionDecisionPayload(),
    ApprovalRequested: approvalRequestPayload(),
    ApprovalResolved: approvalResolutionPayload(),
    ApprovalInvalidated: approvalInvalidationPayload(),
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

test("parses and deeply freezes every versioned application event type", () => {
  assert.equal(ROBIN_APPLICATION_EVENT_TYPES.length, 22);
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
  assertInvalidEvent(
    rawEvent(1, "ApprovalRequested", approvalRequestPayload({
      displayedSummary: { detail: "x".repeat(65_537) },
      displayedSummaryHash: canonicalSha256Hex({ detail: "x".repeat(65_537) }),
    })),
  );
});

test("approval events validate exact IDs, hashes, summaries, times, and decisions", () => {
  const requested = parseRobinApplicationEvent(
    rawEvent(1, "ApprovalRequested", approvalRequestPayload()),
  );
  assert.equal(requested.type, "ApprovalRequested");
  if (requested.type === "ApprovalRequested") {
    assert.deepEqual(requested.payload.displayedSummary, DISPLAYED_SUMMARY);
    assert.equal(Object.isFrozen(requested.payload.displayedSummary), true);
    assert.equal(
      requested.payload.displayedSummaryHash,
      canonicalSha256Hex(DISPLAYED_SUMMARY),
    );
  }

  for (const payload of [
    approvalRequestPayload({ approvalId: "approval-not-branded" }),
    approvalRequestPayload({ actionId: "action-not-branded" }),
    approvalRequestPayload({ actionHash: "A".repeat(64) }),
    approvalRequestPayload({ normalizedRequestHash: "a".repeat(63) }),
    approvalRequestPayload({ preconditionHash: "z".repeat(64) }),
    approvalRequestPayload({ displayedSummaryHash: "f".repeat(64) }),
    approvalRequestPayload({ expiresAt: "2026-08-30T12:00:00.000Z" }),
    approvalRequestPayload({ displayedSummary: { operation: "unsafe\u001b]52" } }),
    approvalRequestPayload({ extra: true }),
  ]) {
    assertInvalidEvent(rawEvent(1, "ApprovalRequested", payload));
  }

  for (const payload of [
    approvalResolutionPayload({ outcome: "unknown" }),
    approvalResolutionPayload({ decision: "allow_turn" }),
    approvalResolutionPayload({
      decision: "deny",
      outcome: "granted",
    }),
    approvalResolutionPayload({
      decision: "allow_once",
      outcome: "denied",
    }),
    approvalResolutionPayload({
      outcome: "granted",
      resolvedAt: "2026-08-30T12:05:00.000Z",
    }),
    approvalResolutionPayload({
      outcome: "stale",
      resolvedAt: "2026-08-30T12:00:01.000Z",
    }),
    approvalResolutionPayload({ extra: true }),
  ]) {
    assertInvalidEvent(rawEvent(1, "ApprovalResolved", payload));
  }

  const invalidated = parseRobinApplicationEvent(
    rawEvent(1, "ApprovalInvalidated", approvalInvalidationPayload()),
  );
  assert.equal(invalidated.type, "ApprovalInvalidated");
  if (invalidated.type === "ApprovalInvalidated") {
    assert.equal(invalidated.payload.reason, "preconditions_changed");
    assert.equal(invalidated.payload.observedPreconditionHash, "e".repeat(64));
  }

  for (const payload of [
    approvalInvalidationPayload({ reason: "unknown" }),
    approvalInvalidationPayload({ invalidatedAt: "invalid" }),
    approvalInvalidationPayload({ observedPreconditionHash: null }),
    approvalInvalidationPayload({ observedPreconditionHash: "c".repeat(64) }),
    approvalInvalidationPayload({ observedPreconditionHash: "E".repeat(64) }),
    approvalInvalidationPayload({
      invalidatedAt: "2026-08-30T12:04:59.999Z",
      observedPreconditionHash: null,
      reason: "approval_expired",
    }),
    approvalInvalidationPayload({
      observedPreconditionHash: "e".repeat(64),
      reason: "approval_expired",
    }),
    approvalInvalidationPayload({ extra: true }),
  ]) {
    assertInvalidEvent(rawEvent(1, "ApprovalInvalidated", payload));
  }
});

test("permission decisions validate exact active-action policy facts", () => {
  const parsed = parseRobinApplicationEvent(
    rawEvent(1, "PermissionDecided", permissionDecisionPayload()),
  );
  assert.equal(parsed.type, "PermissionDecided");
  if (parsed.type === "PermissionDecided") {
    assert.equal(parsed.payload.effect, "require_approval");
    assert.equal(parsed.payload.winningPolicyName, "r2.default.edit.ask");
  }

  for (const payload of [
    permissionDecisionPayload({ actionId: "not-an-action-id" }),
    permissionDecisionPayload({ actionHash: "a".repeat(63) }),
    permissionDecisionPayload({ effect: "prompt" }),
    permissionDecisionPayload({ policySnapshotHash: "D".repeat(64) }),
    permissionDecisionPayload({ policyVersionId: "not-a-policy-id" }),
    permissionDecisionPayload({ winningPolicyName: "unsafe\u001b]52" }),
    permissionDecisionPayload({ winningPolicyName: "" }),
  ]) {
    assertInvalidEvent(rawEvent(1, "PermissionDecided", payload));
  }
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

test("parses only bounded, terminal-inert tool output presentation facts", () => {
  const output = parseRobinApplicationEvent(
    rawEvent(1, "ToolOutputDelta", {
      byteLength: 5,
      callId: "call-1",
      channel: "stderr",
      limitExceeded: true,
      safeText: "bad\u001b]52;clipboard\u0007",
      sequence: 2,
      textTruncated: true,
      toolName: "robin.process.run@1",
      turnId: "turn-1",
    }),
  );
  assert.equal(output.type, "ToolOutputDelta");
  if (output.type === "ToolOutputDelta") {
    assert.deepEqual(output.payload, {
      byteLength: 5,
      callId: "call-1",
      channel: "stderr",
      limitExceeded: true,
      safeText: "bad\\u{1b}]52;clipboard\\u{07}",
      sequence: 2,
      textTruncated: true,
      toolName: "robin.process.run@1",
      turnId: "turn-1",
    });
    assert.equal(Object.isFrozen(output.payload), true);
  }

  const base = PAYLOADS["ToolOutputDelta"]!;
  for (const invalid of [
    { ...base, channel: "combined" },
    { ...base, sequence: 0 },
    { ...base, sequence: MAXIMUM_TOOL_OUTPUT_DELTAS_PER_CALL + 1 },
    { ...base, byteLength: 0 },
    { ...base, byteLength: MAXIMUM_TOOL_OUTPUT_SOURCE_BYTES_PER_CALL + 1 },
    { ...base, limitExceeded: 0 },
    { ...base, textTruncated: "false" },
    { ...base, extra: true },
    (() => {
      const { toolName: _toolName, ...missing } = base;
      return missing;
    })(),
  ]) {
    assertInvalidEvent(rawEvent(1, "ToolOutputDelta", invalid));
  }

  const exactTextBound = "x".repeat(
    MAXIMUM_TOOL_OUTPUT_DELTA_TEXT_UTF8_BYTES,
  );
  const exact = parseRobinApplicationEvent(
    rawEvent(1, "ToolOutputDelta", { ...base, safeText: exactTextBound }),
  );
  assert.equal(
    exact.type === "ToolOutputDelta"
      ? Buffer.byteLength(exact.payload.safeText, "utf8")
      : 0,
    MAXIMUM_TOOL_OUTPUT_DELTA_TEXT_UTF8_BYTES,
  );
  assertInvalidEvent(
    rawEvent(1, "ToolOutputDelta", {
      ...base,
      safeText: exactTextBound + "x",
    }),
  );
  assertInvalidEvent(
    rawEvent(1, "ToolOutputDelta", {
      ...base,
      // Escaping expands each control to six printable bytes and is checked
      // against the same released-text ceiling after transformation.
      safeText: "\u001b".repeat(
        Math.floor(MAXIMUM_TOOL_OUTPUT_DELTA_TEXT_UTF8_BYTES / 6) + 1,
      ),
    }),
  );
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
