import assert from "node:assert/strict";
import test from "node:test";

import { inputBufferText } from "./input-buffer.js";
import {
  MAXIMUM_QUEUED_MESSAGES,
  MAXIMUM_REPL_INPUT_UTF8_BYTES,
  createReplState,
  reduceRepl,
  type ReplEvent,
  type ReplState,
} from "./repl-reducer.js";
import { TerminalKeyDecoder } from "./key-decoder.js";

const encoder = new TextEncoder();

function apply(state: ReplState, ...events: ReplEvent[]): ReplState {
  return events.reduce((current, event) => reduceRepl(current, event).state, state);
}

test("pure reducer edits graphemes, submits, and traverses bounded history", () => {
  const initial = createReplState({ columns: 40, rows: 10 });
  const typed = apply(
    initial,
    { type: "key", key: { type: "text", text: "a👩🏽‍💻b" } },
    { type: "key", key: { type: "left" } },
    { type: "key", key: { type: "backspace" } },
    { type: "key", key: { type: "paste", text: "\nline" } },
  );
  assert.equal(inputBufferText(typed.input), "a\nlineb");
  assert.equal(inputBufferText(initial.input), "");

  const submitted = reduceRepl(typed, { type: "key", key: { type: "enter" } });
  assert.equal(submitted.state.status, "working");
  assert.deepEqual(submitted.effects, [
    { type: "submit_message", text: "a\nlineb", queued: false },
  ]);
  const completed = reduceRepl(submitted.state, {
    type: "turn_completed",
    text: "done",
  }).state;
  const history = reduceRepl(completed, { type: "key", key: { type: "up" } }).state;
  assert.equal(inputBufferText(history.input), "a\nlineb");
  assert.equal(Object.isFrozen(submitted.state), true);
});

test("working turns expose stream, tool, queue, and deterministic drain state", () => {
  let state = apply(
    createReplState(),
    { type: "key", key: { type: "text", text: "first" } },
  );
  state = reduceRepl(state, { type: "key", key: { type: "enter" } }).state;
  state = apply(
    state,
    { type: "assistant_delta", text: "checking " },
    { type: "assistant_delta", text: "now" },
    { type: "tool_started", callId: "call-1", name: "inspect" },
    { type: "tool_completed", callId: "call-1", summary: "ok" },
    { type: "usage_reported", inputTokens: 12, outputTokens: 34 },
    { type: "key", key: { type: "text", text: "second" } },
  );
  const queued = reduceRepl(state, { type: "key", key: { type: "enter" } });
  assert.deepEqual(queued.effects, [
    { type: "submit_message", text: "second", queued: true },
  ]);
  assert.equal(queued.state.assistantStream, "checking now");
  assert.equal(queued.state.tools[0]?.status, "completed");
  assert.deepEqual(queued.state.usage, { inputTokens: 12, outputTokens: 34 });
  assert.deepEqual(queued.state.queuedMessages, ["second"]);

  const settled = reduceRepl(queued.state, {
    type: "turn_completed",
    text: "first done",
  });
  assert.equal(settled.state.status, "working");
  assert.deepEqual(settled.state.queuedMessages, []);
  assert.deepEqual(settled.effects, []);
  assert.equal(
    [...queued.effects, ...settled.effects].filter(
      (effect) => effect.type === "submit_message" && effect.text === "second",
    ).length,
    1,
  );
});

test("usage is monotonic and failed tools remain visible until settlement", () => {
  const running = apply(
    createReplState(),
    { type: "turn_started" },
    { type: "tool_started", callId: "call-1", name: "inspect" },
    {
      type: "tool_failed",
      callId: "call-1",
      summary: "action_failed: missing fixture",
    },
    { type: "usage_reported", inputTokens: 8, outputTokens: 13 },
  );
  assert.equal(running.tools[0]?.status, "failed");
  assert.deepEqual(running.usage, { inputTokens: 8, outputTokens: 13 });
  const invalid = reduceRepl(running, {
    type: "usage_reported",
    inputTokens: 7,
    outputTokens: 13,
  }).state;
  assert.equal(
    invalid.diagnostics.find((item) => item.code === "invalid_usage")?.count,
    1,
  );
});

test("queue bounds, decoder diagnostics, cancellation escalation, and Ctrl-D are explicit", () => {
  let state = reduceRepl(
    apply(createReplState(), { type: "key", key: { type: "text", text: "active" } }),
    { type: "key", key: { type: "enter" } },
  ).state;
  for (let index = 0; index < MAXIMUM_QUEUED_MESSAGES + 1; index += 1) {
    state = apply(
      state,
      { type: "key", key: { type: "text", text: `q${index}` } },
      { type: "key", key: { type: "enter" } },
    );
  }
  assert.equal(state.queuedMessages.length, MAXIMUM_QUEUED_MESSAGES);
  assert.equal(state.diagnostics.find((item) => item.code === "queue_full")?.count, 1);

  const cancelling = reduceRepl(state, { type: "key", key: { type: "ctrl_c" } });
  assert.equal(cancelling.state.status, "cancelling");
  assert.deepEqual(cancelling.effects, [{ type: "request_cancel" }]);
  const repeated = reduceRepl(cancelling.state, { type: "key", key: { type: "ctrl_c" } });
  assert.equal(repeated.state, cancelling.state);
  assert.deepEqual(repeated.effects, []);

  const closed = reduceRepl(createReplState(), { type: "key", key: { type: "ctrl_d" } });
  assert.equal(closed.state.status, "closed");
  assert.deepEqual(closed.effects, [{ type: "close" }]);
});

test("repeated bracketed paste cannot grow the composer beyond its UTF-8 byte bound", () => {
  const decoder = new TerminalKeyDecoder();
  const maximumPaste = "x".repeat(MAXIMUM_REPL_INPUT_UTF8_BYTES);
  const encodedPaste = encoder.encode(`\u001b[200~${maximumPaste}\u001b[201~`);
  const first = decoder.push(encodedPaste);
  assert.deepEqual(first.diagnostics, []);
  assert.equal(first.events.length, 1);

  let state = createReplState();
  for (const key of first.events) state = reduceRepl(state, { type: "key", key }).state;
  assert.equal(
    Buffer.byteLength(inputBufferText(state.input), "utf8"),
    MAXIMUM_REPL_INPUT_UTF8_BYTES,
  );

  const committedInput = state.input;
  const second = decoder.push(encodedPaste);
  assert.deepEqual(second.diagnostics, []);
  for (const key of second.events) state = reduceRepl(state, { type: "key", key }).state;
  assert.equal(state.input, committedInput);
  assert.equal(
    state.diagnostics.find((item) => item.code === "input_limit_exceeded")?.count,
    1,
  );

  state = reduceRepl(state, { type: "key", key: { type: "ctrl_u" } }).state;
  state = reduceRepl(state, {
    type: "key",
    key: { type: "text", text: "still usable" },
  }).state;
  const submitted = reduceRepl(state, { type: "key", key: { type: "enter" } });
  assert.deepEqual(submitted.effects, [
    { type: "submit_message", text: "still usable", queued: false },
  ]);
});

test("the composer accepts an exact multibyte boundary and rejects one byte more", () => {
  const exact = "é".repeat(MAXIMUM_REPL_INPUT_UTF8_BYTES / 2);
  let state = reduceRepl(createReplState(), {
    type: "key",
    key: { type: "paste", text: exact },
  }).state;
  assert.equal(
    Buffer.byteLength(inputBufferText(state.input), "utf8"),
    MAXIMUM_REPL_INPUT_UTF8_BYTES,
  );

  const committedInput = state.input;
  state = reduceRepl(state, {
    type: "key",
    key: { type: "text", text: "a" },
  }).state;
  assert.equal(state.input, committedInput);
  assert.equal(
    state.diagnostics.find((item) => item.code === "input_limit_exceeded")
      ?.count,
    1,
  );
});

test("local command results never settle or dequeue an active turn", () => {
  let state = apply(
    createReplState(),
    { type: "key", key: { type: "text", text: "active" } },
    { type: "key", key: { type: "enter" } },
    { type: "assistant_delta", text: "streaming" },
    { type: "tool_started", callId: "call-1", name: "inspect" },
    { type: "usage_reported", inputTokens: 2, outputTokens: 3 },
    { type: "key", key: { type: "text", text: "real queue" } },
    { type: "key", key: { type: "enter" } },
    { type: "key", key: { type: "text", text: "/help" } },
  );
  const activeQueue = state.queuedMessages;
  const activeTools = state.tools;
  const activeUsage = state.usage;

  const help = reduceRepl(state, {
    type: "local_command",
    kind: "notice",
    message: "Local help text",
  });
  state = help.state;
  assert.deepEqual(help.effects, []);
  assert.equal(state.status, "working");
  assert.equal(state.assistantStream, "streaming");
  assert.deepEqual(state.queuedMessages, activeQueue);
  assert.deepEqual(state.tools, activeTools);
  assert.deepEqual(state.usage, activeUsage);
  assert.equal(inputBufferText(state.input), "");
  assert.deepEqual(state.transcript.slice(-2), [
    { kind: "user", text: "/help" },
    { kind: "notice", text: "Local help text" },
  ]);

  state = apply(state, { type: "key", key: { type: "text", text: "/unknown" } });
  const unknown = reduceRepl(state, {
    type: "local_command",
    kind: "error",
    message: "Unknown local command",
  });
  assert.equal(unknown.state.status, "working");
  assert.deepEqual(unknown.state.queuedMessages, activeQueue);
  assert.deepEqual(unknown.effects, []);
  assert.deepEqual(unknown.state.transcript.slice(-2), [
    { kind: "user", text: "/unknown" },
    { kind: "error", text: "Unknown local command" },
  ]);
});
