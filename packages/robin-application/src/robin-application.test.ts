import assert from "node:assert/strict";
import test from "node:test";

import { AgentAttemptIdKind, isDomainError } from "@guard/contracts";
import { PreviewModelProvider } from "@guard/robin-agent";

import { EphemeralRobinApplication } from "./index.js";

async function collect<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

test("one application preserves a multi-turn ephemeral session", async () => {
  const attempts = [
    AgentAttemptIdKind.parse(
      "att_018f05a0-7b01-7000-8000-000000000001",
    ),
    AgentAttemptIdKind.parse(
      "att_018f05a0-7b01-7000-8000-000000000002",
    ),
  ];
  const application = new EphemeralRobinApplication({
    sessionId: "ephemeral-app-test",
    provider: new PreviewModelProvider(),
    modelId: "synthetic-preview-v1",
    now: () => "2026-08-30T00:00:00.000Z",
    nextAttemptId: () => {
      const value = attempts.shift();
      assert.notEqual(value, undefined);
      return value!;
    },
  });

  assert.deepEqual(application.snapshot.messages, []);
  await collect(application.submit("First turn.", new AbortController().signal));
  await collect(application.submit("Second turn.", new AbortController().signal));

  assert.equal(application.snapshot.persistence, "ephemeral");
  assert.equal(application.snapshot.messages.length, 4);
  assert.equal(application.snapshot.activeTurn, false);
  assert.equal(Object.isFrozen(application.snapshot), true);
});

test("application rejects concurrent foreground turns with a domain conflict", async () => {
  const application = new EphemeralRobinApplication({
    sessionId: "ephemeral-concurrency-test",
    provider: new PreviewModelProvider(),
    modelId: "synthetic-preview-v1",
  });
  const first = application
    .submit("First turn.", new AbortController().signal)
    [Symbol.asyncIterator]();
  assert.equal((await first.next()).value?.type, "turn_started");
  await assert.rejects(
    collect(application.submit("Concurrent turn.", new AbortController().signal)),
    (error: unknown) => isDomainError(error) && error.code === "conflict",
  );
  await first.return?.();
  assert.equal(application.snapshot.activeTurn, false);
});
