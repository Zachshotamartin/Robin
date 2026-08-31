import assert from "node:assert/strict";
import test from "node:test";

import { isDomainError } from "@guard/contracts";
import type { RobinApplicationEvent } from "@guard/robin-session";

import { R1RobinApplication } from "./session-service.js";

async function collect<T>(source: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

function application(maximumTurns = 16): R1RobinApplication {
  let timestamp = 0;
  let monotonic = 0;
  return new R1RobinApplication({
    sessionId: "session:r1-application-test",
    maximumTurns,
    now: () =>
      new Date(Date.UTC(2026, 7, 30, 0, 0, timestamp++)).toISOString(),
    monotonicNow: () => monotonic++,
  });
}

test("R1 application completes two tools and a state-dependent follow-up", async () => {
  const app = application();
  const first = await collect(
    app.submit("Why does the fixture total fail?", new AbortController().signal),
  );
  assert.deepEqual(
    first
      .filter((event) => event.type === "ToolCallStarted")
      .map((event) => event.payload.toolName),
    [
      "robin.synthetic.workspace_summary@1",
      "robin.synthetic.inspect_file@1",
    ],
  );
  assert.deepEqual(
    first
      .filter((event) => event.type === "ToolCallCompleted")
      .map((event) => event.payload.callId),
    ["r1-turn-1-workspace-summary", "r1-turn-1-inspect-file"],
  );
  const firstResult = first.find((event) => event.type === "TurnCompleted");
  assert.match(firstResult?.payload.text ?? "", /total - value/u);

  const followUp = await collect(
    app.submit("What exact change should I make?", new AbortController().signal),
  );
  assert.equal(
    followUp.some((event) => event.type === "ToolCallStarted"),
    false,
  );
  const followUpResult = followUp.find(
    (event) => event.type === "TurnCompleted",
  );
  assert.match(followUpResult?.payload.text ?? "", /Replace subtraction with addition/u);
  assert.equal(app.snapshot.turnsStarted, 2);
  assert.equal(app.snapshot.events.length > first.length + followUp.length, true);
  assert.deepEqual(
    app.snapshot.events.map((event) => event.sequence),
    app.snapshot.events.map((_, index) => index + 1),
  );
});

test("application maps provider and gateway failures to one terminal event", async () => {
  for (const scenario of [
    "[scenario:provider-error]",
    "[scenario:tool-error]",
  ]) {
    const app = application();
    const events = await collect(
      app.submit(scenario, new AbortController().signal),
    );
    assert.equal(
      events.filter(
        (event) =>
          event.type === "TurnCompleted" ||
          event.type === "TurnFailed" ||
          event.type === "TurnCancelled",
      ).length,
      1,
    );
    assert.equal(events.at(-1)?.type, "TurnFailed");
    assert.equal(app.snapshot.activeTurn, false);
  }
});

test("submission abort records cancellation request before cancellation", async () => {
  const app = application();
  const controller = new AbortController();
  const observed: RobinApplicationEvent[] = [];
  for await (const event of app.submit("[scenario:slow]", controller.signal)) {
    observed.push(event);
    if (event.type === "AssistantTextDelta") controller.abort();
  }
  assert.deepEqual(
    observed
      .filter(
        (event) =>
          event.type === "TurnCancellationRequested" ||
          event.type === "TurnCancelled",
      )
      .map((event) => event.type),
    ["TurnCancellationRequested", "TurnCancelled"],
  );
  assert.equal(app.snapshot.activeTurn, false);
});

test("concurrent prompts wait in FIFO order and become accepted", async () => {
  const app = application();
  const firstController = new AbortController();
  const firstPromise = (async () => {
    const events: RobinApplicationEvent[] = [];
    for await (const event of app.submit(
      "[scenario:slow]",
      firstController.signal,
    )) {
      events.push(event);
      if (event.type === "AssistantTextDelta") firstController.abort();
    }
    return events;
  })();
  const secondPromise = collect(
    app.submit("Run after cancellation.", new AbortController().signal),
  );
  const thirdPromise = collect(
    app.submit("Run third.", new AbortController().signal),
  );

  const [, second, third] = await Promise.all([
    firstPromise,
    secondPromise,
    thirdPromise,
  ]);
  assert.equal(second[0]?.type, "UserMessageQueued");
  assert.equal(
    second.find((event) => event.type === "UserMessageAccepted")?.payload
      .messageId,
    "message:2",
  );
  assert.equal(third[0]?.type, "UserMessageQueued");
  assert.equal(
    third.find((event) => event.type === "UserMessageAccepted")?.payload
      .messageId,
    "message:3",
  );
  assert.equal(app.snapshot.queueDepth, 0);
});

test("queue is bounded at eight and close cancels queued work", async () => {
  const app = application(16);
  const active = app.submit("[scenario:slow]", new AbortController().signal);
  const queued = Array.from({ length: 8 }, (_, index) =>
    app.submit(`queued ${index + 1}`, new AbortController().signal),
  );
  assert.throws(
    () => app.submit("overflow", new AbortController().signal),
    (error: unknown) => isDomainError(error) && error.code === "budget_exceeded",
  );
  assert.equal(app.snapshot.queueDepth, 8);
  await app.close("shutdown");
  assert.equal(app.snapshot.closed, true);
  assert.equal(app.snapshot.queueDepth, 0);
  assert.equal(app.snapshot.events.at(-1)?.type, "SessionClosed");
  await collect(active);
  await Promise.all(queued.map(collect));
});

test("permission mode changes are replayable and closed sessions reject work", async () => {
  const app = application();
  app.setPermissionMode("plan");
  assert.equal(app.snapshot.permissionMode, "plan");
  await app.close("user");
  assert.throws(
    () => app.setPermissionMode("ask"),
    (error: unknown) => isDomainError(error) && error.code === "conflict",
  );
  assert.throws(
    () => app.submit("too late", new AbortController().signal),
    (error: unknown) => isDomainError(error) && error.code === "conflict",
  );
});
