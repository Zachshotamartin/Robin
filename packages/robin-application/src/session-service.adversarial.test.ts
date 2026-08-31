import assert from "node:assert/strict";
import test from "node:test";

import { isDomainError } from "@guard/contracts";
import type {
  ModelProvider,
  ModelProviderEvent,
} from "@guard/model-provider";
import type { RobinApplicationEvent } from "@guard/robin-session";

import {
  R1RobinApplication,
  replayRobinSession,
  type R1ShutdownDeadlineLease,
  type R1ShutdownDeadlineSource,
} from "./index.js";

let nextSession = 0;

function application(): R1RobinApplication {
  let timestamp = 0;
  let monotonic = 0;
  nextSession += 1;
  return new R1RobinApplication({
    sessionId: `session:r1-adversarial-${nextSession}`,
    now: () =>
      new Date(Date.UTC(2026, 7, 30, 1, 0, timestamp++)).toISOString(),
    monotonicNow: () => monotonic++,
  });
}

async function collect(
  source: AsyncIterable<RobinApplicationEvent>,
  observe: (event: RobinApplicationEvent) => void = () => {},
): Promise<readonly RobinApplicationEvent[]> {
  const events: RobinApplicationEvent[] = [];
  for await (const event of source) {
    events.push(event);
    observe(event);
  }
  return events;
}

class ManualShutdownDeadline implements R1ShutdownDeadlineSource {
  readonly starts: number[] = [];
  cancellations = 0;
  #resolve: (() => void) | null = null;

  public start(maximumWaitMs: number): R1ShutdownDeadlineLease {
    this.starts.push(maximumWaitMs);
    const elapsed = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
    return {
      elapsed,
      cancel: () => {
        this.cancellations += 1;
      },
    };
  }

  public expire(): void {
    assert.notEqual(this.#resolve, null, "shutdown deadline was not armed");
    this.#resolve!();
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function nonCooperativeProvider(options: {
  readonly started: Deferred;
  readonly release: Deferred;
  readonly onSignal?: (signal: AbortSignal) => void;
}): ModelProvider {
  return {
    descriptor: Object.freeze({
      adapterId: "non-cooperative-test",
      adapterVersion: "1.0.0",
      capabilities: Object.freeze({
        streaming: true,
        structuredActions: false,
        exactUsage: false,
        cancellation: "unsupported" as const,
      }),
    }),
    async *respond(
      _request,
      signal,
    ): AsyncIterable<ModelProviderEvent> {
      options.onSignal?.(signal);
      options.started.resolve();
      await options.release.promise;
      yield { type: "text_delta", outputIndex: 0, delta: "late success" };
      yield { type: "response_completed", finishReason: "stop" };
    },
  };
}

function immediateProvider(): ModelProvider {
  return {
    descriptor: Object.freeze({
      adapterId: "immediate-test",
      adapterVersion: "1.0.0",
      capabilities: Object.freeze({
        streaming: true,
        structuredActions: false,
        exactUsage: false,
        cancellation: "confirmed" as const,
      }),
    }),
    async *respond(): AsyncIterable<ModelProviderEvent> {
      yield { type: "text_delta", outputIndex: 0, delta: "complete" };
      yield { type: "response_completed", finishReason: "stop" };
    },
  };
}

function countingImmediateProvider(onRespond: () => void): ModelProvider {
  const provider = immediateProvider();
  return {
    descriptor: provider.descriptor,
    async *respond(request, signal): AsyncIterable<ModelProviderEvent> {
      onRespond();
      yield* provider.respond(request, signal);
    },
  };
}

async function flushAsyncGenerators(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function assertEveryPrefixReplays(app: R1RobinApplication): void {
  const events = app.snapshot.events;
  assert.ok(events.length > 0);
  for (let length = 1; length <= events.length; length += 1) {
    const projection = replayRobinSession(events.slice(0, length));
    assert.equal(
      projection.lastSequence,
      length,
      `replay stopped at event prefix ${length}`,
    );
    assert.equal(projection.sessionId, app.snapshot.sessionId);
  }
}

test("every happy-path prefix replays and completion equals all streamed text", async () => {
  const app = application();
  const events = await collect(
    app.submit(
      "Why does the deterministic fixture total fail?",
      new AbortController().signal,
    ),
  );
  const streamed = events
    .filter((event) => event.type === "AssistantTextDelta")
    .map((event) => event.payload.text)
    .join("");
  const completed = events.find((event) => event.type === "TurnCompleted");

  assert.ok(completed?.type === "TurnCompleted");
  assert.equal(completed.payload.text, streamed);
  const projection = replayRobinSession(app.snapshot.events);
  assert.equal(projection.turns[0]?.assistantText, streamed);
  assert.equal(projection.turns[0]?.terminalResult?.status, "completed");
  assertEveryPrefixReplays(app);
});

test("a pre-aborted foreground submission never starts provider work", async () => {
  const app = application();
  const controller = new AbortController();
  controller.abort("already cancelled");

  const events = await collect(app.submit("Do not start.", controller.signal));
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "UserMessageAccepted",
      "TurnCancellationRequested",
      "TurnCancelled",
    ],
  );
  assert.equal(app.snapshot.activeTurn, false);
  assert.equal(app.snapshot.turnsStarted, 1);
  assertEveryPrefixReplays(app);
});

test("an aborted queued submission settles without becoming foreground", async () => {
  const app = application();
  const activeController = new AbortController();
  const active = collect(
    app.submit("[scenario:slow]", activeController.signal),
    (event) => {
      if (event.type === "AssistantTextDelta") activeController.abort();
    },
  );
  const queuedController = new AbortController();
  const queuedStream = app.submit("Never promote this.", queuedController.signal);
  queuedController.abort();

  const queued = await collect(queuedStream);
  await active;
  assert.deepEqual(
    queued.map((event) => event.type),
    [
      "UserMessageQueued",
      "TurnCancellationRequested",
      "TurnCancelled",
    ],
  );
  assert.equal(
    queued.some(
      (event) =>
        event.type === "UserMessageAccepted" || event.type === "TurnStarted",
    ),
    false,
  );
  assert.equal(app.snapshot.queueDepth, 0);
  assertEveryPrefixReplays(app);
});

test("tool cancellation records failure settlement before turn cancellation", async () => {
  const app = application();
  const controller = new AbortController();
  const events = await collect(
    app.submit("Inspect the fixture, then cancel.", controller.signal),
    (event) => {
      if (event.type === "ToolCallStarted") controller.abort();
    },
  );
  const lifecycle = events.filter(
    (event) =>
      event.type === "ToolCallStarted" ||
      event.type === "TurnCancellationRequested" ||
      event.type === "ToolCallFailed" ||
      event.type === "TurnCancelled",
  );

  assert.deepEqual(
    lifecycle.map((event) => event.type),
    [
      "ToolCallStarted",
      "TurnCancellationRequested",
      "ToolCallFailed",
      "TurnCancelled",
    ],
  );
  const started = lifecycle[0];
  const failed = lifecycle[2];
  assert.ok(started?.type === "ToolCallStarted");
  assert.ok(failed?.type === "ToolCallFailed");
  assert.equal(failed.payload.callId, started.payload.callId);
  assert.equal(failed.payload.toolName, started.payload.toolName);
  assert.equal(failed.payload.code, "cancelled");
  const projection = replayRobinSession(app.snapshot.events);
  assert.equal(projection.turns[0]?.toolCalls[0]?.status, "failed");
  assert.equal(projection.turns[0]?.status, "cancelled");
  assertEveryPrefixReplays(app);
});

test("terminal callback cannot cancel the next promoted turn", async () => {
  const app = application();
  const firstController = new AbortController();
  let nextStream: AsyncIterable<RobinApplicationEvent> | undefined;
  let lateCancellationResult: boolean | undefined;
  const first = await collect(
    app.submit("Why does the fixture fail?", firstController.signal),
    (event) => {
      if (event.type === "TurnStarted") {
        nextStream = app.submit(
          "What exact change should I make?",
          new AbortController().signal,
        );
      }
      if (event.type === "TurnCompleted") {
        lateCancellationResult = app.cancelActiveTurn("late terminal callback");
      }
    },
  );

  assert.equal(first.at(-1)?.type, "TurnCompleted");
  assert.equal(lateCancellationResult, false);
  assert.notEqual(nextStream, undefined);
  const next = await collect(nextStream!);
  assert.equal(next.at(-1)?.type, "TurnCompleted");
  assert.equal(
    next.some(
      (event) =>
        event.type === "TurnCancellationRequested" ||
        event.type === "TurnCancelled",
    ),
    false,
  );
  assertEveryPrefixReplays(app);
});

test("tool failure can retry with fresh call identifiers and complete", async () => {
  const app = application();
  const failed = await collect(
    app.submit("[scenario:tool-error]", new AbortController().signal),
  );
  const retried = await collect(
    app.submit("Retry the fixture inspection.", new AbortController().signal),
  );
  const firstCallIds = failed
    .filter((event) => event.type === "ToolCallStarted")
    .map((event) => event.payload.callId);
  const retryCallIds = retried
    .filter((event) => event.type === "ToolCallStarted")
    .map((event) => event.payload.callId);

  assert.equal(failed.at(-1)?.type, "TurnFailed");
  assert.equal(
    failed.some((event) => event.type === "ToolCallFailed"),
    true,
  );
  assert.equal(retried.at(-1)?.type, "TurnCompleted");
  assert.deepEqual(firstCallIds, [
    "r1-turn-1-workspace-summary",
    "r1-turn-1-inspect-file",
  ]);
  assert.deepEqual(retryCallIds, [
    "r1-turn-2-workspace-summary",
    "r1-turn-2-inspect-file",
  ]);
  assert.equal(
    retryCallIds.some((callId) => firstCallIds.includes(callId)),
    false,
  );
  assertEveryPrefixReplays(app);
});

test("usage reports accumulate request-local counters across a tool turn", async () => {
  const app = application();
  const events = await collect(
    app.submit("Count usage across requests.", new AbortController().signal),
  );
  const usage = events.filter((event) => event.type === "UsageReported");

  assert.equal(usage.length, 2);
  assert.ok(usage[0]?.type === "UsageReported");
  assert.ok(usage[1]?.type === "UsageReported");
  assert.deepEqual(usage[0].payload, {
    inputTokens: 7,
    outputTokens: 86,
    turnId: "turn:1",
  });
  assert.deepEqual(usage[1].payload, {
    inputTokens: 14,
    outputTokens: 294,
    turnId: "turn:1",
  });
  assertEveryPrefixReplays(app);
});

test("close settles active and queued cancellation before SessionClosed", async () => {
  const app = application();
  const activeStream = app.submit(
    "[scenario:slow]",
    new AbortController().signal,
  );
  const queuedStream = app.submit(
    "Queued during shutdown.",
    new AbortController().signal,
  );

  await app.close("shutdown");
  const [active, queued] = await Promise.all([
    collect(activeStream),
    collect(queuedStream),
  ]);
  assert.deepEqual(
    active
      .filter(
        (event) =>
          event.type === "TurnCancellationRequested" ||
          event.type === "TurnCancelled",
      )
      .map((event) => event.type),
    ["TurnCancellationRequested", "TurnCancelled"],
  );
  assert.deepEqual(
    queued.map((event) => event.type),
    [
      "UserMessageQueued",
      "TurnCancellationRequested",
      "TurnCancelled",
    ],
  );
  assert.equal(app.snapshot.events.at(-1)?.type, "SessionClosed");
  const projection = replayRobinSession(app.snapshot.events);
  assert.equal(projection.status, "closed");
  assert.deepEqual(
    projection.turns.map((turn) => turn.status),
    ["cancelled", "cancelled"],
  );
  assertEveryPrefixReplays(app);
});

test("shutdown deadline fences a provider that ignores abort and repeated close shares one result", async () => {
  const started = deferred();
  const release = deferred();
  const deadline = new ManualShutdownDeadline();
  let providerSignal: AbortSignal | undefined;
  let timestamp = 0;
  const app = new R1RobinApplication({
    sessionId: "session:r1-shutdown-fence",
    provider: nonCooperativeProvider({
      started,
      release,
      onSignal: (signal) => {
        providerSignal = signal;
      },
    }),
    shutdownTimeoutMs: 37,
    shutdownDeadline: deadline,
    now: () =>
      new Date(Date.UTC(2026, 7, 30, 2, 0, timestamp++)).toISOString(),
    monotonicNow: () => 0,
  });
  const turn = app.submit("Wait forever.", new AbortController().signal);
  await started.promise;

  const firstClose = app.close("shutdown");
  const repeatedClose = app.close("user");
  assert.strictEqual(repeatedClose, firstClose);
  assert.deepEqual(deadline.starts, [37]);
  assert.equal(providerSignal?.aborted, true);
  deadline.expire();
  await firstClose;

  const turnEvents = await collect(turn);
  assert.deepEqual(
    turnEvents
      .filter(
        (event) =>
          event.type === "TurnCancellationRequested" ||
          event.type === "TurnCancelled" ||
          event.type === "TurnCompleted",
      )
      .map((event) => event.type),
    ["TurnCancellationRequested", "TurnCancelled"],
  );
  assert.equal(app.snapshot.events.at(-1)?.type, "SessionClosed");
  assert.equal(deadline.cancellations, 1);
  const frozenEvents = app.snapshot.events;

  release.resolve();
  await flushAsyncGenerators();
  assert.deepEqual(app.snapshot.events, frozenEvents);
  assert.equal(
    app.snapshot.events.some((event) => event.type === "TurnCompleted"),
    false,
  );
});

test("a throwing shutdown deadline fails closed and quarantines late provider output", async () => {
  const started = deferred();
  const release = deferred();
  const marker = new Error("deadline scheduler unavailable");
  const app = new R1RobinApplication({
    sessionId: "session:r1-deadline-failure",
    provider: nonCooperativeProvider({ started, release }),
    shutdownDeadline: {
      start(): R1ShutdownDeadlineLease {
        throw marker;
      },
    },
    now: () => "2026-08-30T02:01:00.000Z",
    monotonicNow: () => 0,
  });
  const sessionIterator = app.events(0)[Symbol.asyncIterator]();
  const turnIterator = app
    .submit("The scheduler will fail.", new AbortController().signal)
    [Symbol.asyncIterator]();
  await started.promise;

  const firstClose = app.close("error");
  const repeatedClose = app.close("shutdown");
  assert.strictEqual(repeatedClose, firstClose);
  await assert.rejects(firstClose, (error: unknown) => error === marker);
  await assert.rejects(turnIterator.next(), (error: unknown) => error === marker);
  await assert.rejects(
    sessionIterator.next(),
    (error: unknown) => error === marker,
  );
  const frozenEvents = app.snapshot.events;

  release.resolve();
  await flushAsyncGenerators();
  assert.deepEqual(app.snapshot.events, frozenEvents);
  assert.equal(app.snapshot.events.at(-1)?.type === "SessionClosed", false);
});

test("shutdown cancellation-record failure fails all streams before provider quarantine", async () => {
  const started = deferred();
  const release = deferred();
  const marker = new Error("cancellation event id failed");
  const app = new R1RobinApplication({
    sessionId: "session:r1-cancellation-write-failure",
    provider: nonCooperativeProvider({ started, release }),
    eventIds: {
      nextEventId(sequence): string {
        if (sequence === 4) throw marker;
        return `event:${sequence}`;
      },
    },
    now: () => "2026-08-30T02:01:30.000Z",
    monotonicNow: () => 0,
  });
  const sessionResult = collect(app.events(0)).then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  const turnResult = collect(
    app.submit("Fail the shutdown write.", new AbortController().signal),
  ).then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  await started.promise;

  const firstClose = app.close("shutdown");
  assert.strictEqual(app.close("error"), firstClose);
  await assert.rejects(firstClose, (error: unknown) => error === marker);
  assert.equal((await turnResult).error, marker);
  assert.equal((await sessionResult).error, marker);
  const frozenEvents = app.snapshot.events;

  release.resolve();
  await flushAsyncGenerators();
  assert.deepEqual(app.snapshot.events, frozenEvents);
  assert.equal(app.snapshot.events.at(-1)?.type, "TurnStarted");
});

test("queued shutdown write failure retains and rejects every unsettled stream", async () => {
  const started = deferred();
  const release = deferred();
  const marker = new Error("queued cancellation event id failed");
  const app = new R1RobinApplication({
    sessionId: "session:r1-queued-write-failure",
    provider: nonCooperativeProvider({ started, release }),
    eventIds: {
      nextEventId(sequence): string {
        if (sequence === 7) throw marker;
        return `event:${sequence}`;
      },
    },
    now: () => "2026-08-30T02:01:45.000Z",
    monotonicNow: () => 0,
  });
  const results = [
    app.submit("Hold active.", new AbortController().signal),
    app.submit("Hold queued one.", new AbortController().signal),
    app.submit("Hold queued two.", new AbortController().signal),
  ].map((source) =>
    collect(source).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    ),
  );
  await started.promise;

  await assert.rejects(
    app.close("shutdown"),
    (error: unknown) => error === marker,
  );
  for (const result of await Promise.all(results)) {
    assert.equal(result.error, marker);
  }
  assert.equal(app.snapshot.activeTurn, false);
  assert.equal(app.snapshot.queueDepth, 0);
  release.resolve();
  await flushAsyncGenerators();
});

for (const terminalFailureSource of ["clock", "event id"] as const) {
  test(`terminal ${terminalFailureSource} failure rejects all streams and is shared by close`, async () => {
    const marker = new Error(`${terminalFailureSource} failed`);
    let eventClockCalls = 0;
    const app = new R1RobinApplication({
      sessionId: `session:r1-terminal-${terminalFailureSource.replace(" ", "-")}`,
      provider: immediateProvider(),
      now: () => {
        eventClockCalls += 1;
        if (terminalFailureSource === "clock" && eventClockCalls === 5) {
          throw marker;
        }
        return "2026-08-30T02:02:00.000Z";
      },
      eventIds: {
        nextEventId(sequence): string {
          if (terminalFailureSource === "event id" && sequence === 5) {
            throw marker;
          }
          return `event:${sequence}`;
        },
      },
      coordinator: {
        timestamp: { now: () => "2026-08-30T02:02:00.000Z" },
      },
      monotonicNow: () => 0,
    });
    const sessionResult = collect(app.events(0)).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const turnResult = collect(
      app.submit("Complete, then fail terminal persistence.", new AbortController().signal),
    ).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    assert.equal((await turnResult).error, marker);
    assert.equal((await sessionResult).error, marker);
    assert.equal(app.snapshot.closed, true);
    assert.equal(app.snapshot.events.at(-1)?.type, "AssistantTextDelta");
    assert.equal(
      app.snapshot.events.some(
        (event) =>
          event.type === "TurnCompleted" ||
          event.type === "TurnFailed" ||
          event.type === "SessionClosed",
      ),
      false,
    );
    const firstClose = app.close("error");
    const repeatedClose = app.close("shutdown");
    assert.strictEqual(repeatedClose, firstClose);
    await assert.rejects(firstClose, (error: unknown) => error === marker);
  });
}

test("per-turn iterator return discards buffered events and remains done", async () => {
  const app = application();
  const controller = new AbortController();
  controller.abort("not started");
  const iterator = app.submit("Cancel before start.", controller.signal)[
    Symbol.asyncIterator
  ]();

  assert.deepEqual(await iterator.return?.(), {
    done: true,
    value: undefined,
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  await app.close("user");
});

test("record-cap rejection is atomic and reserved active shutdown records still commit", async () => {
  const started = deferred();
  const release = deferred();
  const deadline = new ManualShutdownDeadline();
  const app = new R1RobinApplication({
    sessionId: "session:r1-active-headroom",
    provider: nonCooperativeProvider({ started, release }),
    journalLimits: { maximumRecords: 7 },
    shutdownDeadline: deadline,
    now: () => "2026-08-30T02:03:00.000Z",
    monotonicNow: () => 0,
  });
  const turn = app.submit("Hold the provider.", new AbortController().signal);
  await started.promise;
  app.setPermissionMode("plan");
  assert.throws(
    () => app.setPermissionMode("ask"),
    (error: unknown) =>
      isDomainError(error) && error.code === "budget_exceeded",
  );
  assert.equal(app.snapshot.permissionMode, "plan");

  const closing = app.close("shutdown");
  deadline.expire();
  await closing;
  await collect(turn);
  assert.equal(app.snapshot.events.length, 7);
  assert.deepEqual(
    app.snapshot.events.slice(-3).map((event) => event.type),
    ["TurnCancellationRequested", "TurnCancelled", "SessionClosed"],
  );
  assert.equal(app.snapshot.events.at(-1)?.type, "SessionClosed");
  release.resolve();
});

test("foreground record-cap rejection leaves admission idle and never invokes provider", async () => {
  let providerCalls = 0;
  const app = new R1RobinApplication({
    sessionId: "session:r1-foreground-admission-cap",
    provider: countingImmediateProvider(() => {
      providerCalls += 1;
    }),
    journalLimits: { maximumRecords: 5 },
    now: () => "2026-08-30T02:04:00.000Z",
    monotonicNow: () => 0,
  });

  assert.throws(
    () => app.submit("Cannot fit.", new AbortController().signal),
    (error: unknown) =>
      isDomainError(error) && error.code === "budget_exceeded",
  );
  assert.equal(providerCalls, 0);
  assert.equal(app.snapshot.activeTurn, false);
  assert.equal(app.snapshot.queueDepth, 0);
  assert.equal(app.snapshot.turnsStarted, 0);
  assert.deepEqual(
    app.snapshot.events.map((event) => event.type),
    ["SessionStarted"],
  );

  await app.close("error");
  assert.deepEqual(
    app.snapshot.events.map((event) => event.type),
    ["SessionStarted", "SessionClosed"],
  );
});

for (const source of ["clock", "event id", "invalid event id"] as const) {
  test(`foreground ${source} rejection rolls back the complete admission batch`, async () => {
    const marker = new Error(`${source} admission failed`);
    let clockCalls = 0;
    let failed = false;
    let providerCalls = 0;
    const app = new R1RobinApplication({
      sessionId: `session:r1-foreground-${source.replaceAll(" ", "-")}`,
      provider: countingImmediateProvider(() => {
        providerCalls += 1;
      }),
      now: () => {
        clockCalls += 1;
        if (source === "clock" && clockCalls === 3 && !failed) {
          failed = true;
          throw marker;
        }
        return "2026-08-30T02:04:30.000Z";
      },
      eventIds: {
        nextEventId(sequence): string {
          if (sequence === 3 && !failed && source !== "clock") {
            failed = true;
            if (source === "event id") throw marker;
            if (source === "invalid event id") return "invalid\nevent";
          }
          return `event:${sequence}`;
        },
      },
      monotonicNow: () => 0,
    });

    if (source === "invalid event id") {
      assert.throws(() =>
        app.submit("Reject atomically.", new AbortController().signal),
      );
    } else {
      assert.throws(
        () => app.submit("Reject atomically.", new AbortController().signal),
        (error: unknown) => error === marker,
      );
    }
    assert.equal(providerCalls, 0);
    assert.equal(app.snapshot.activeTurn, false);
    assert.equal(app.snapshot.queueDepth, 0);
    assert.equal(app.snapshot.turnsStarted, 0);
    assert.deepEqual(
      app.snapshot.events.map((event) => event.type),
      ["SessionStarted"],
    );
    await app.close("error");
    assert.equal(app.snapshot.events.at(-1)?.type, "SessionClosed");
  });
}

test("queued record-cap rejection leaves no inaccessible queued turn", async () => {
  const started = deferred();
  const release = deferred();
  const deadline = new ManualShutdownDeadline();
  const app = new R1RobinApplication({
    sessionId: "session:r1-queued-admission-cap",
    provider: nonCooperativeProvider({ started, release }),
    journalLimits: { maximumRecords: 6 },
    shutdownDeadline: deadline,
    now: () => "2026-08-30T02:05:00.000Z",
    monotonicNow: () => 0,
  });
  const active = app.submit("Hold active.", new AbortController().signal);
  assert.throws(
    () => app.submit("Cannot queue.", new AbortController().signal),
    (error: unknown) =>
      isDomainError(error) && error.code === "budget_exceeded",
  );
  assert.equal(app.snapshot.queueDepth, 0);
  assert.equal(
    app.snapshot.events.some((event) => event.type === "UserMessageQueued"),
    false,
  );
  await started.promise;

  const closing = app.close("error");
  deadline.expire();
  await closing;
  await collect(active);
  assert.equal(app.snapshot.events.at(-1)?.type, "SessionClosed");
  release.resolve();
  await flushAsyncGenerators();
});

test("queued event-id rejection leaves the admitted foreground turn intact", async () => {
  const started = deferred();
  const release = deferred();
  const deadline = new ManualShutdownDeadline();
  const marker = new Error("queued admission id failed");
  let failed = false;
  const app = new R1RobinApplication({
    sessionId: "session:r1-queued-admission-id",
    provider: nonCooperativeProvider({ started, release }),
    eventIds: {
      nextEventId(sequence): string {
        if (sequence === 4 && !failed) {
          failed = true;
          throw marker;
        }
        return `event:${sequence}`;
      },
    },
    shutdownDeadline: deadline,
    now: () => "2026-08-30T02:05:30.000Z",
    monotonicNow: () => 0,
  });
  const active = app.submit("Hold active.", new AbortController().signal);
  assert.throws(
    () => app.submit("Reject this queue write.", new AbortController().signal),
    (error: unknown) => error === marker,
  );
  assert.equal(app.snapshot.activeTurn, true);
  assert.equal(app.snapshot.queueDepth, 0);
  assert.equal(app.snapshot.turnsStarted, 1);
  await started.promise;

  const closing = app.close("error");
  deadline.expire();
  await closing;
  await collect(active);
  release.resolve();
  await flushAsyncGenerators();
});

for (const promotionFailureSource of ["clock", "event id"] as const) {
  test(`queued promotion ${promotionFailureSource} fault fails the unsettled application without partial admission`, async () => {
    const marker = new Error(`${promotionFailureSource} promotion failed`);
    let eventClockCalls = 0;
    const app = new R1RobinApplication({
      sessionId: `session:r1-promotion-${promotionFailureSource.replace(" ", "-")}`,
      provider: immediateProvider(),
      now: () => {
        eventClockCalls += 1;
        if (promotionFailureSource === "clock" && eventClockCalls === 8) {
          throw marker;
        }
        return "2026-08-30T02:06:00.000Z";
      },
      eventIds: {
        nextEventId(sequence): string {
          if (promotionFailureSource === "event id" && sequence === 8) {
            throw marker;
          }
          return `event:${sequence}`;
        },
      },
      coordinator: {
        timestamp: { now: () => "2026-08-30T02:06:00.000Z" },
      },
      monotonicNow: () => 0,
    });
    const sessionResult = collect(app.events(0)).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const firstResult = collect(
      app.submit("Complete first.", new AbortController().signal),
    );
    const queuedResult = collect(
      app.submit("Promote second.", new AbortController().signal),
    ).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    assert.equal((await firstResult).at(-1)?.type, "TurnCompleted");
    assert.equal((await queuedResult).error, marker);
    assert.equal((await sessionResult).error, marker);
    assert.equal(app.snapshot.activeTurn, false);
    assert.equal(app.snapshot.queueDepth, 0);
    assert.equal(app.snapshot.turnsStarted, 1);
    assert.equal(
      app.snapshot.events.filter(
        (event) =>
          event.type === "UserMessageAccepted" &&
          event.payload.turnId === "turn:2",
      ).length,
      0,
    );
    const firstClose = app.close("error");
    assert.strictEqual(app.close("shutdown"), firstClose);
    await assert.rejects(firstClose, (error: unknown) => error === marker);
  });
}

for (const deltaFailureSource of ["clock", "event id"] as const) {
  test(`AssistantTextDelta ${deltaFailureSource} fault preserves its original failure and faults the journal`, async () => {
    const marker = new Error(`${deltaFailureSource} delta failed`);
    let eventClockCalls = 0;
    const app = new R1RobinApplication({
      sessionId: `session:r1-delta-${deltaFailureSource.replace(" ", "-")}`,
      provider: immediateProvider(),
      now: () => {
        eventClockCalls += 1;
        if (deltaFailureSource === "clock" && eventClockCalls === 4) {
          throw marker;
        }
        return "2026-08-30T02:07:00.000Z";
      },
      eventIds: {
        nextEventId(sequence): string {
          if (deltaFailureSource === "event id" && sequence === 4) {
            throw marker;
          }
          return `event:${sequence}`;
        },
      },
      coordinator: {
        timestamp: { now: () => "2026-08-30T02:07:00.000Z" },
      },
      monotonicNow: () => 0,
    });
    const sessionResult = collect(app.events(0)).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const turnResult = collect(
      app.submit("Fail the delta append.", new AbortController().signal),
    ).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    assert.equal((await turnResult).error, marker);
    assert.equal((await sessionResult).error, marker);
    assert.equal(app.snapshot.closed, true);
    assert.deepEqual(
      app.snapshot.events.map((event) => event.type),
      ["SessionStarted", "UserMessageAccepted", "TurnStarted"],
    );
    assert.equal(
      app.snapshot.events.some((event) => event.type === "TurnFailed"),
      false,
    );
    const firstClose = app.close("error");
    assert.strictEqual(app.close("shutdown"), firstClose);
    await assert.rejects(firstClose, (error: unknown) => error === marker);
  });
}
