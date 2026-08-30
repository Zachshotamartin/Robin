import assert from "node:assert/strict";
import test from "node:test";

import {
  renderHuman,
  renderJsonl,
  renderQuiet,
  type RenderableEvent,
} from "./render.js";

const RUN_ID = "run_018f0001-0000-7000-8000-010000000001";
const OUTCOME = Object.freeze({
  schemaVersion: 1,
  outcomeId: "out_fixture",
  profileId: "synthetic-transform",
  profileVersion: 1,
  outcomeType: "synthetic.transform.completed",
  outcomeTypeVersion: 1,
  payload: { transformed: "GUARDED" },
  evidence: [],
  proposedAt: "2026-01-02T03:04:05.000Z",
});

const HISTORY: readonly RenderableEvent[] = Object.freeze([
  event(1, "RunCreated", { objective: { profileId: "synthetic-transform" } }),
  event(2, "RunCompleted", {
    result: {
      schemaVersion: 1,
      runId: RUN_ID,
      status: "completed",
      finishedAt: "2026-01-02T03:04:05.000Z",
      outcome: OUTCOME,
    },
  }),
]);

test("JSONL contains exactly the public projection fields and round-trips", () => {
  const output = renderJsonl(HISTORY);
  assert.equal(output.endsWith("\n"), true);
  const lines = output.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(typeof line, "object");
    assert.deepEqual(Object.keys(line as object), [
      "schemaVersion",
      "cursor",
      "timestamp",
      "type",
      "runId",
      "payload",
    ]);
  }
  assert.deepEqual(lines[1], {
    schemaVersion: 1,
    cursor: 2,
    timestamp: "2026-01-02T03:04:06.000Z",
    type: "RunCompleted",
    runId: RUN_ID,
    payload: HISTORY[1]!.payload,
  });
});

test("human view is stable and includes a domain-event timeline plus final outcome", () => {
  assert.equal(
    renderHuman(HISTORY),
    [
      `Guarded Agent run ${RUN_ID}`,
      "001  2026-01-02T03:04:06.000Z  RunCreated",
      "002  2026-01-02T03:04:06.000Z  RunCompleted",
      "Status: completed",
      'Outcome (synthetic.transform.completed): {"transformed":"GUARDED"}',
      "",
    ].join("\n"),
  );
});

test("quiet view emits only the completed outcome envelope", () => {
  assert.deepEqual(JSON.parse(renderQuiet(HISTORY)) as unknown, OUTCOME);
  assert.equal(renderQuiet([event(1, "RunFailed", { result: { status: "failed" } })]), "");
  assert.equal(renderQuiet([]), "");
});

test("renderers do not inspect unselected event properties", () => {
  const candidate = { ...HISTORY[0]! } as RenderableEvent & { raw?: unknown };
  Object.defineProperty(candidate, "raw", {
    enumerable: true,
    get() {
      throw new Error("canary getter was reached");
    },
  });
  assert.doesNotThrow(() => renderJsonl([candidate]));
  assert.doesNotThrow(() => renderHuman([candidate]));
});

function event(
  streamVersion: number,
  eventType: string,
  payload: unknown,
): RenderableEvent {
  return Object.freeze({
    eventSchemaVersion: 1,
    streamVersion,
    recordedAt: "2026-01-02T03:04:06.000Z",
    eventType,
    streamId: RUN_ID,
    payload,
  });
}
