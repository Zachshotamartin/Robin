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
