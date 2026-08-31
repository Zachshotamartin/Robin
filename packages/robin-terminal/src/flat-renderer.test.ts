import assert from "node:assert/strict";
import test from "node:test";

import { FlatRenderer, renderFlatEvent } from "./flat-renderer.js";

test("flat renderer emits append-only semantic lines without ANSI redraws", () => {
  const writes: string[] = [];
  const renderer = new FlatRenderer({ write: (bytes) => writes.push(bytes) });
  renderer.append({ type: "session_started", label: "synthetic ephemeral" });
  renderer.append({ type: "user_message", text: "hello\nworld" });
  renderer.append({
    type: "tool_status",
    name: "inspect\u001b[31m",
    status: "completed",
    summary: "ok\u0007",
  });
  renderer.append({ type: "cancelling" });

  assert.deepEqual(writes, [
    "[session] synthetic ephemeral\n",
    "[you] hello\nworld\n",
    "[tool:completed] inspect\\u{1b}[31m — ok\\u{07}\n",
    "[status] Cancelling\n",
  ]);
  assert.equal(renderer.linesWritten, 5);
  assert.equal(writes.join("").includes("\u001b"), false);
  assert.equal(writes.join("").includes("\r"), false);
});

test("flat event variants preserve textual state independently of color", () => {
  assert.equal(
    renderFlatEvent({ type: "queued", position: 2, text: "later" }),
    "[queued:2] later\n",
  );
  assert.equal(
    renderFlatEvent({ type: "error", message: "failed" }),
    "[error] failed\n",
  );
  assert.equal(
    renderFlatEvent({ type: "usage", inputTokens: 12, outputTokens: 34 }),
    "[usage] input=12 output=34\n",
  );
  assert.equal(
    renderFlatEvent({ type: "diagnostic", code: "bad", message: "ignored" }),
    "[diagnostic:bad] ignored\n",
  );
});

test("flat approval output includes exact scope, complete summary, and safe outcomes", () => {
  const request = {
    actionHash: "1".repeat(64),
    actionId: "act-1",
    approvalId: "apr-1",
    callId: "call-1",
    displayedSummaryHash: "2".repeat(64),
    expiresAt: "2026-08-30T02:05:00.000Z",
    normalizedRequestHash: "3".repeat(64),
    policySnapshotHash: "4".repeat(64),
    preconditionHash: "5".repeat(64),
    requestedAt: "2026-08-30T02:00:01.000Z",
    toolName: "robin.process.run@1\u001b[31m",
    turnId: "turn-1",
    canonicalSummary: '{"argv":["npm","test"],"sandboxed":false}',
  } as const;
  const required = renderFlatEvent({ type: "approval_required", request });
  assert.equal(required.includes("\u001b"), false);
  assert.match(required, /Approval ID: apr-1/u);
  assert.match(required, /Canonical summary: \{"argv"/u);
  assert.match(required, /allow-once/u);
  assert.equal(required.split("\n").filter(Boolean).length, 15);

  const resolved = renderFlatEvent({
    type: "approval_resolved",
    resolution: {
      ...request,
      decision: "deny",
      outcome: "denied",
      resolvedAt: "2026-08-30T02:00:02.000Z",
    },
  });
  assert.match(resolved, /decision=deny outcome=denied/u);
});
