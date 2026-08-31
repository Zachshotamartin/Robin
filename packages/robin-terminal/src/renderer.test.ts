import assert from "node:assert/strict";
import test from "node:test";

import { createReplState, reduceRepl, type ReplState } from "./repl-reducer.js";
import {
  buildTerminalFrame,
  diffTerminalFrames,
  sanitizeTerminalData,
  StaleTerminalFrameError,
  wrapCells,
  writeTerminalFrame,
  renderApprovalRequestBlock,
  renderToolOutputLines,
} from "./renderer.js";
import type { TerminalApprovalRequest } from "./approval.js";
import { detectTerminalCapabilities } from "./terminal-capabilities.js";

function capability(columns: number, rows = 24) {
  return detectTerminalCapabilities({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    term: "xterm-256color",
    locale: "en_US.UTF-8",
    columns,
    rows,
  });
}

function populatedState(): ReplState {
  let state = createReplState({ columns: 80, rows: 24 });
  state = reduceRepl(state, {
    type: "key",
    key: { type: "text", text: "debug 界" },
  }).state;
  state = reduceRepl(state, { type: "key", key: { type: "enter" } }).state;
  state = reduceRepl(state, { type: "assistant_delta", text: "Inspecting\u001b]52;x\u0007" }).state;
  state = reduceRepl(state, {
    type: "tool_started",
    callId: "call-1",
    name: "inspect_file",
  }).state;
  state = reduceRepl(state, {
    type: "key",
    key: { type: "text", text: "follow-up" },
  }).state;
  return reduceRepl(state, { type: "key", key: { type: "enter" } }).state;
}

test("sanitization makes OSC, CSI, BEL, CR, backspace, and tabs inert", () => {
  const hostile = "safe\u001b]52;secret\u0007\rnext\b\t\u001b[31mred";
  const safe = sanitizeTerminalData(hostile);
  assert.equal(safe.includes("\u001b"), false);
  assert.equal(safe.includes("\u0007"), false);
  assert.equal(safe.includes("\r"), false);
  assert.equal(safe.includes("\b"), false);
  assert.equal(safe.includes("\t"), false);
  assert.equal(safe, "safe\\u{1b}]52;secret\\u{07}\\u{0d}next\\u{08}\\u{09}\\u{1b}[31mred");
  assert.deepEqual(wrapCells("abcd", 4), ["abcd"]);
});

test("40, 80, and 160 column frames have deterministic snapshots", () => {
  const state = populatedState();
  const snapshots = [40, 80, 160].map((columns) => {
    const frame = buildTerminalFrame(state, capability(columns));
    return {
      columns,
      rows: frame.rows,
      cursor: frame.cursor,
    };
  });
  assert.deepEqual(snapshots, [
    {
      columns: 40,
      rows: [
        "Robin · working · 40x24 · queue 1",
        "You: debug 界",
        "You: follow-up",
        "Robin: Inspecting\\u{1b}]52;x\\u{07}",
        "Tool inspect_file [running]",
        "Queued 1/1: follow-up",
        "> ",
      ],
      cursor: { row: 7, column: 3 },
    },
    {
      columns: 80,
      rows: [
        "Robin · working · 80x24 · queue 1",
        "You: debug 界",
        "You: follow-up",
        "Robin: Inspecting\\u{1b}]52;x\\u{07}",
        "Tool inspect_file [running]",
        "Queued 1/1: follow-up",
        "> ",
      ],
      cursor: { row: 7, column: 3 },
    },
    {
      columns: 160,
      rows: [
        "Robin · working · 160x24 · queue 1",
        "You: debug 界",
        "You: follow-up",
        "Robin: Inspecting\\u{1b}]52;x\\u{07}",
        "Tool inspect_file [running]",
        "Queued 1/1: follow-up",
        "> ",
      ],
      cursor: { row: 7, column: 3 },
    },
  ]);
});

test("frame diff updates changed rows and restores the cursor in one write", () => {
  const initialState = createReplState({ columns: 40, rows: 8 });
  const initialFrame = buildTerminalFrame(initialState, capability(40, 8));
  const nextState = reduceRepl(initialState, {
    type: "key",
    key: { type: "text", text: "hello" },
  }).state;
  const nextFrame = buildTerminalFrame(nextState, capability(40, 8));
  const diff = diffTerminalFrames(initialFrame, nextFrame);
  assert.equal(diff.firstChangedRow, 1);
  assert.equal(diff.lastChangedRow, 1);
  assert.match(diff.bytes, /\u001b\[2;8H$/u);

  const writes: string[] = [];
  writeTerminalFrame({ write: (bytes) => writes.push(bytes) }, initialFrame, nextFrame);
  assert.deepEqual(writes, [diff.bytes]);

  const stale = diffTerminalFrames(nextFrame, initialFrame);
  assert.equal(stale.firstChangedRow, null);
  assert.equal(stale.lastChangedRow, null);
  assert.equal(stale.bytes, "");

  const staleWrites: string[] = [];
  assert.throws(
    () =>
      writeTerminalFrame(
        { write: (bytes) => staleWrites.push(bytes) },
        nextFrame,
        initialFrame,
      ),
    (error: unknown) =>
      error instanceof StaleTerminalFrameError &&
      error.previousRevision === nextFrame.revision &&
      error.nextRevision === initialFrame.revision,
  );
  assert.equal(staleWrites.length, 0);

  const laterState = reduceRepl(nextState, {
    type: "key",
    key: { type: "text", text: "!" },
  }).state;
  const laterFrame = buildTerminalFrame(laterState, capability(40, 8));
  writeTerminalFrame(
    { write: (bytes) => staleWrites.push(bytes) },
    nextFrame,
    laterFrame,
  );
  assert.equal(staleWrites.length, 1);
  assert.match(staleWrites[0]!, /\u001b\[2;9H$/u);

  const insertedRow = diffTerminalFrames(
    { revision: 1, columns: 10, rows: ["a", "b"], cursor: { row: 2, column: 2 } },
    { revision: 2, columns: 10, rows: ["x", "a", "b"], cursor: { row: 3, column: 2 } },
  );
  assert.equal(insertedRow.firstChangedRow, 0);
  assert.equal(insertedRow.lastChangedRow, 2);
  assert.equal(insertedRow.bytes.includes("\u001b[2;1H\u001b[2Ka"), true);
  assert.equal(insertedRow.bytes.includes("\u001b[3;1H\u001b[2Kb"), true);
});

test("coalesced input rejection diagnostics are visible and actionable", () => {
  let state = createReplState({ columns: 80, rows: 8 });
  state = reduceRepl(state, {
    type: "decoder_diagnostic",
    diagnostic: { code: "oversized_paste", discardedBytes: 1 },
  }).state;
  state = reduceRepl(state, {
    type: "decoder_diagnostic",
    diagnostic: { code: "oversized_paste", discardedBytes: 2 },
  }).state;

  const oversizedFrame = buildTerminalFrame(state, capability(80, 8));
  const oversizedText = oversizedFrame.rows.join("");
  assert.equal(
    oversizedText.includes("oversized_paste") &&
      oversizedText.includes("rejected") &&
      oversizedText.includes("x2"),
    true,
  );

  state = reduceRepl(state, {
    type: "key",
    key: { type: "paste", text: "x".repeat(65_536) },
  }).state;
  state = reduceRepl(state, {
    type: "key",
    key: { type: "text", text: "y" },
  }).state;
  const boundedFrame = buildTerminalFrame(state, capability(80, 8));
  const boundedText = boundedFrame.rows.join("");
  assert.equal(
    boundedText.includes("input_limit_exceeded") && boundedText.includes("65536"),
    true,
  );
  assert.equal(boundedFrame.cursor.row < boundedFrame.rows.length, true);
});

test("ASCII fallback headers and multiline prompt cursors are deterministic", () => {
  const asciiCapability = detectTerminalCapabilities({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    term: "dumb",
    locale: "C",
    columns: 40,
    rows: 8,
  });
  const asciiFrame = buildTerminalFrame(createReplState(), asciiCapability);
  assert.match(asciiFrame.rows[0]!, /^[\x20-\x7e]+$/u);

  const multiline = reduceRepl(createReplState(), {
    type: "key",
    key: { type: "paste", text: "one\ntwo" },
  }).state;
  const multilineFrame = buildTerminalFrame(multiline, capability(40, 8));
  assert.deepEqual(multilineFrame.rows.slice(-2), ["> one", "two"]);
  assert.deepEqual(multilineFrame.cursor, { row: 3, column: 4 });
});

test("approval rendering is complete, deterministic, and control-injection safe", () => {
  const request: TerminalApprovalRequest = Object.freeze({
    actionHash: "1".repeat(64),
    actionId: "act-safe\u001b[2J",
    approvalId: "apr-safe\u0007",
    callId: "call-safe\rspoof",
    displayedSummaryHash: "2".repeat(64),
    expiresAt: "2026-08-30T02:05:00.000Z",
    normalizedRequestHash: "3".repeat(64),
    policySnapshotHash: "4".repeat(64),
    preconditionHash: "5".repeat(64),
    requestedAt: "2026-08-30T02:00:01.000Z",
    toolName: "robin.edit.apply@1\tspoof",
    turnId: "turn-safe",
    canonicalSummary:
      '{"command":"printf \\"complete summary\\"","sandboxed":false}',
  });
  const block = renderApprovalRequestBlock(request);
  assert.equal(block.includes("\u001b"), false);
  assert.equal(block.includes("\u0007"), false);
  assert.equal(block.includes("\r"), false);
  assert.equal(block.includes("\t"), false);
  assert.match(block, /act-safe\\u\{1b\}\[2J/u);
  assert.match(block, /apr-safe\\u\{07\}/u);
  assert.match(block, /Canonical summary: \{"command"/u);
  assert.match(block, /there is no default decision/u);
  for (const label of [
    "Tool:",
    "Approval ID:",
    "Action ID:",
    "Call ID:",
    "Turn ID:",
    "Action hash:",
    "Normalized request hash:",
    "Precondition hash:",
    "Policy snapshot hash:",
    "Displayed summary hash:",
  ]) {
    assert.equal(block.includes(label), true, label);
  }

  let state = applyApproval(createReplState({ columns: 160, rows: 80 }), request);
  const frame = buildTerminalFrame(state, capability(160, 80));
  assert.equal(frame.rows.some((row) => row.startsWith("approval> ")), true);
  assert.equal(frame.rows.join("\n").includes("complete summary"), true);
  const identity = state.approval;
  state = reduceRepl(state, {
    type: "key",
    key: { type: "resize", columns: 100, rows: 50 },
  }).state;
  assert.equal(state.approval, identity);
});

test("tool output labels every stdout and stderr line without interpreting controls", () => {
  const lines = renderToolOutputLines({
    byteLength: 19,
    callId: "call-output\u001b]52;bad\u0007",
    channel: "stderr",
    limitExceeded: true,
    name: "robin.process.run@1\u001b[31m",
    safeText: "first\u001b[2J\nsecond\rline",
    sequence: 7,
    textTruncated: true,
  });
  assert.equal(lines.length, 2);
  assert.equal(lines.every((line) => line.includes("[stderr #7]")), true);
  assert.equal(lines.every((line) => line.includes("text_truncated=true")), true);
  assert.equal(lines.every((line) => line.includes("limit_exceeded=true")), true);
  assert.equal(lines.join("\n").includes("\u001b"), false);
  assert.equal(lines.join("\n").includes("\u0007"), false);
  assert.equal(lines.join("\n").includes("\r"), false);
  assert.match(lines[0]!, /first\\u\{1b\}\[2J/u);
  assert.match(lines[1]!, /second\\u\{0d\}line/u);
});

function applyApproval(
  initial: ReplState,
  request: TerminalApprovalRequest,
): ReplState {
  let state = reduceRepl(initial, { type: "turn_started" }).state;
  state = reduceRepl(state, { type: "approval_requested", request }).state;
  return reduceRepl(state, {
    type: "approval_presented",
    approvalId: request.approvalId,
  }).state;
}
