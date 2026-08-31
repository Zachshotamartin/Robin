import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentAttemptIdKind,
  createDomainError,
  isDomainError,
  type AgentAttemptId,
} from "@guard/contracts";
import type {
  ModelProvider,
  ModelProviderEvent,
  SemanticModelRequest,
} from "@guard/model-provider";

import {
  DirectModelSession,
  PreviewModelProvider,
  type RobinAgentEvent,
} from "./index.js";

const ATTEMPT_IDS = [
  "att_018f05a0-7b01-7000-8000-000000000001",
  "att_018f05a0-7b01-7000-8000-000000000002",
].map((value) => AgentAttemptIdKind.parse(value));

function session(provider: ModelProvider = new PreviewModelProvider()): DirectModelSession {
  let next = 0;
  return new DirectModelSession({
    sessionId: "ephemeral-test",
    provider,
    modelId: "synthetic-preview-v1",
    clock: { now: () => "2026-08-30T00:00:00.000Z" },
    ids: {
      nextAttemptId(): AgentAttemptId {
        const value = ATTEMPT_IDS[next];
        assert.notEqual(value, undefined);
        next += 1;
        return value!;
      },
    },
  });
}

async function collect<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
  const captured: T[] = [];
  for await (const event of events) captured.push(event);
  return captured;
}

test("runs two streamed turns through one provider-neutral conversation", async () => {
  const subject = session();
  const first = await collect(
    subject.submit("Explain the project.", new AbortController().signal),
  );
  const second = await collect(
    subject.submit("Keep that context.", new AbortController().signal),
  );

  assert.equal(first[0]?.type, "turn_started");
  assert.ok(first.some((event) => event.type === "assistant_text_delta"));
  assert.equal(first.at(-1)?.type, "turn_completed");
  assert.equal(second[0]?.type, "turn_started");
  assert.equal(second.at(-1)?.type, "turn_completed");
  assert.deepEqual(
    subject.history.map(({ role, turnNumber }) => ({ role, turnNumber })),
    [
      { role: "user", turnNumber: 1 },
      { role: "assistant", turnNumber: 1 },
      { role: "user", turnNumber: 2 },
      { role: "assistant", turnNumber: 2 },
    ],
  );
  assert.match(subject.history[1]!.text, /no repository files were read or changed/u);
  assert.equal(Object.isFrozen(subject.history), true);
  assert.equal(Object.isFrozen(subject.history[0]), true);
});

test("streams output before the terminal turn event", async () => {
  const iterator = session()
    .submit("Stream this.", new AbortController().signal)
    [Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { schemaVersion: 1, type: "turn_started", turnNumber: 1 },
  });
  const next = await iterator.next();
  assert.equal(next.done, false);
  assert.equal((next.value as RobinAgentEvent).type, "assistant_text_delta");
});

test("rejects provider actions, incomplete streams, and empty responses", async () => {
  const actionProvider = providerFrom([
    {
      type: "action_started",
      callId: "call-1",
      capabilityPackId: "tool",
      capabilityPackVersion: 1,
      operationId: "read",
      operationVersion: 1,
    },
    { type: "response_completed", finishReason: "action_required" },
  ]);
  const actionSession = session(actionProvider);
  const actionEvents = await collect(
    actionSession.submit("Try a tool.", new AbortController().signal),
  );
  assert.equal(actionEvents.at(-1)?.type, "turn_failed");
  assert.deepEqual(actionSession.history, []);

  const incompleteSession = session(
    providerFrom([{ type: "text_delta", outputIndex: 0, delta: "partial" }]),
  );
  const incompleteEvents = await collect(
    incompleteSession.submit("End early.", new AbortController().signal),
  );
  assert.equal(incompleteEvents.at(-1)?.type, "turn_failed");
  assert.deepEqual(incompleteSession.history, []);

  const emptySession = session(
    providerFrom([{ type: "response_completed", finishReason: "stop" }]),
  );
  const emptyEvents = await collect(
    emptySession.submit("Do not accept empty output.", new AbortController().signal),
  );
  assert.equal(emptyEvents.at(-1)?.type, "turn_failed");
  assert.deepEqual(emptySession.history, []);
});

test("cancellation before submission records no conversation item", async () => {
  const controller = new AbortController();
  controller.abort();
  const subject = session();
  await assert.rejects(
    collect(subject.submit("Cancel.", controller.signal)),
    (error: unknown) => isDomainError(error) && error.code === "cancelled",
  );
  assert.deepEqual(subject.history, []);
});

test("synthetic streaming never splits a Unicode scalar across deltas", async () => {
  const events = await collect(
    session().submit("1234567😀", new AbortController().signal),
  );
  const deltas = events
    .filter((event) => event.type === "assistant_text_delta")
    .map((event) => event.delta);
  assert.equal(deltas.some(containsUnpairedSurrogate), false);
  assert.match(deltas.join(""), /1234567😀/u);
});

test("failed turns consume a monotonic turn number without polluting model history", async () => {
  let requests = 0;
  const provider: ModelProvider = {
    descriptor: {
      adapterId: "test.fail-then-succeed",
      adapterVersion: "1.0.0",
      capabilities: {
        streaming: true,
        structuredActions: false,
        exactUsage: false,
        cancellation: "confirmed",
      },
    },
    async *respond(): AsyncIterable<ModelProviderEvent> {
      requests += 1;
      if (requests === 1) {
        yield { type: "text_delta", outputIndex: 0, delta: "partial" };
        return;
      }
      yield { type: "text_delta", outputIndex: 0, delta: "complete" };
      yield { type: "response_completed", finishReason: "stop" };
    },
  };
  const subject = session(provider);
  const failed = await collect(
    subject.submit("Fail once.", new AbortController().signal),
  );
  assert.equal(failed.at(-1)?.type, "turn_failed");
  const recovered = await collect(
    subject.submit("Try again.", new AbortController().signal),
  );
  assert.deepEqual(recovered[0], {
    schemaVersion: 1,
    type: "turn_started",
    turnNumber: 2,
  });
  assert.deepEqual(
    subject.history.map(({ role, turnNumber }) => ({ role, turnNumber })),
    [
      { role: "user", turnNumber: 2 },
      { role: "assistant", turnNumber: 2 },
    ],
  );
});

test("accepts the exact public prompt boundary without exhausting provider events", async () => {
  const prompt = "a".repeat(65_536);
  const events = await collect(
    session().submit(prompt, new AbortController().signal),
  );
  assert.equal(events.at(-1)?.type, "turn_completed");
  assert.equal(
    events.filter((event) => event.type === "assistant_text_delta").length < 4_096,
    true,
  );

  await assert.rejects(
    collect(
      session().submit(prompt + "a", new AbortController().signal),
    ),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
});

test("preserves stable message IDs and provenance across provider requests", async () => {
  const requests: SemanticModelRequest[] = [];
  const provider: ModelProvider = {
    descriptor: {
      adapterId: "test.recording",
      adapterVersion: "1.0.0",
      capabilities: {
        streaming: true,
        structuredActions: false,
        exactUsage: false,
        cancellation: "confirmed",
      },
    },
    async *respond(request): AsyncIterable<ModelProviderEvent> {
      requests.push(request);
      yield {
        type: "text_delta",
        outputIndex: 0,
        delta: requests.length === 1 ? "first answer" : "second answer",
      };
      yield { type: "response_completed", finishReason: "stop" };
    },
  };
  const timestamps = [
    "2026-08-30T00:00:00.000Z",
    "2026-08-30T00:00:01.000Z",
    "2026-08-30T00:00:02.000Z",
    "2026-08-30T00:00:03.000Z",
  ];
  let attempt = 0;
  const subject = new DirectModelSession({
    sessionId: "stable-provenance",
    provider,
    modelId: "recording-v1",
    clock: {
      now: () => {
        const value = timestamps.shift();
        assert.notEqual(value, undefined);
        return value!;
      },
    },
    ids: { nextAttemptId: () => ATTEMPT_IDS[attempt++]! },
  });

  await collect(subject.submit("first prompt", new AbortController().signal));
  await collect(subject.submit("second prompt", new AbortController().signal));

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1]!.conversation.map((item) => item.role),
    ["user", "assistant", "user"],
  );
  assert.deepEqual(requests[1]!.conversation[0], requests[0]!.conversation[0]);
  assert.equal(
    requests[1]!.conversation[0]!.content[0]!.provenance.capturedAt,
    "2026-08-30T00:00:00.000Z",
  );
  assert.equal(
    requests[1]!.conversation[1]!.content[0]!.provenance.capturedAt,
    "2026-08-30T00:00:01.000Z",
  );
  assert.equal(
    subject.history[0]!.messageId,
    requests[1]!.conversation[0]!.content[0]!.blockId,
  );
  assert.equal(subject.history[2]!.capturedAt, "2026-08-30T00:00:02.000Z");
});

test("maps provider certainty and observed partial output conservatively", async () => {
  const cases = [
    {
      events: [providerFailure("terminal", "no_result")],
      code: "provider_failed",
      retry: "terminal",
      observedPartialOutput: false,
    },
    {
      events: [providerFailure("uncertain", "uncertain")],
      code: "provider_result_uncertain",
      retry: "uncertain",
      observedPartialOutput: false,
    },
    {
      events: [
        { type: "text_delta", outputIndex: 0, delta: "partial" } as const,
        providerFailure("retryable", "no_result"),
      ],
      code: "provider_result_uncertain",
      retry: "uncertain",
      observedPartialOutput: true,
    },
  ] as const;

  for (const testCase of cases) {
    const observed = await observeFailure(
      session(providerFrom(testCase.events)).submit(
        "Classify failure.",
        new AbortController().signal,
      ),
    );
    const terminal = observed.events.at(-1);
    assert.equal(terminal?.type, "turn_failed");
    if (terminal?.type === "turn_failed") {
      assert.equal(terminal.error.code, testCase.code);
      assert.equal(terminal.error.retry, testCase.retry);
      assert.equal(
        terminal.error.details?.["observedPartialOutput"],
        testCase.observedPartialOutput,
      );
    }
  }
});

test("normalizes AbortError as cancellation while uncertainty wins an abort race", async () => {
  const abortingProvider: ModelProvider = {
    descriptor: providerFrom([]).descriptor,
    async *respond(_request, signal): AsyncIterable<ModelProviderEvent> {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      throw new DOMException("aborted", "AbortError");
    },
  };
  const controller = new AbortController();
  const iterator = session(abortingProvider)
    .submit("Cancel this.", controller.signal)
    [Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "turn_started");
  controller.abort();
  const cancelled = await iterator.next();
  assert.equal(cancelled.value?.type, "turn_cancelled");
  assert.equal((await iterator.next()).done, true);

  const partialAbortProvider: ModelProvider = {
    descriptor: providerFrom([]).descriptor,
    async *respond(_request, signal): AsyncIterable<ModelProviderEvent> {
      yield { type: "text_delta", outputIndex: 0, delta: "partial" };
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      throw new DOMException("aborted", "AbortError");
    },
  };
  const partialController = new AbortController();
  const partialIterator = session(partialAbortProvider)
    .submit("Cancel after text.", partialController.signal)
    [Symbol.asyncIterator]();
  await partialIterator.next();
  assert.equal((await partialIterator.next()).value?.type, "assistant_text_delta");
  partialController.abort();
  assert.equal((await partialIterator.next()).value?.type, "turn_cancelled");

  const uncertainProvider: ModelProvider = {
    descriptor: providerFrom([]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      throw createDomainError({
        code: "provider_result_uncertain",
        message: "The provider may have produced a result.",
      });
    },
  };
  const uncertainController = new AbortController();
  const uncertainIterator = session(uncertainProvider)
    .submit("Race this.", uncertainController.signal)
    [Symbol.asyncIterator]();
  await uncertainIterator.next();
  uncertainController.abort();
  const uncertain = await uncertainIterator.next();
  assert.equal(uncertain.value?.type, "turn_failed");
  if (uncertain.value?.type === "turn_failed") {
    assert.equal(uncertain.value.error.code, "provider_result_uncertain");
  }
});

test("preserves a classified local failure when cancellation races its throw", async () => {
  const controller = new AbortController();
  const provider: ModelProvider = {
    descriptor: providerFrom([]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      controller.abort();
      throw createDomainError({
        code: "budget_exceeded",
        message: "The classified local budget was exhausted.",
      });
    },
  };
  const events = await collect(
    session(provider).submit("Race a local failure.", controller.signal),
  );
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "turn_failed");
  if (terminal?.type === "turn_failed") {
    assert.equal(terminal.error.code, "budget_exceeded");
  }
});

test("bounds usage dimensions without invoking provider-owned accessors", async () => {
  const oversized = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`metric_${index}`, index]),
  );
  const oversizedResult = await observeFailure(
    session(
      providerFrom([{ type: "usage_reported", dimensions: oversized }]),
    ).submit("Usage.", new AbortController().signal),
  );
  assert.equal(oversizedResult.events.at(-1)?.type, "turn_failed");

  let accessed = false;
  const accessorUsage: Record<string, number> = {};
  Object.defineProperty(accessorUsage, "input_tokens", {
    enumerable: true,
    get() {
      accessed = true;
      return 1;
    },
  });
  const accessorResult = await observeFailure(
    session(
      providerFrom([
        { type: "usage_reported", dimensions: accessorUsage },
      ]),
    ).submit("Usage accessor.", new AbortController().signal),
  );
  assert.equal(accessed, false);
  assert.equal(accessorResult.events.at(-1)?.type, "turn_failed");
});

test("removes unsafe thrown-domain diagnostics from terminal events", async () => {
  const provider: ModelProvider = {
    descriptor: providerFrom([]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      throw createDomainError({
        code: "provider_failed",
        message: "unsafe\u009dmessage",
        details: { nested: "\u001b]52;secret" },
      });
    },
  };
  const observed = await observeFailure(
    session(provider).submit("Sanitize failure.", new AbortController().signal),
  );
  const terminal = observed.events.at(-1);
  assert.equal(terminal?.type, "turn_failed");
  if (terminal?.type === "turn_failed") {
    assert.doesNotMatch(terminal.error.message, /\u009d/u);
    assert.equal(terminal.error.details, undefined);
  }
});

test("caps oversized and multiline thrown-domain diagnostics", async () => {
  for (const error of [
    createDomainError({
      code: "provider_failed",
      message: "x".repeat(5_000),
      details: { oversized: "y".repeat(9_000) },
    }),
    createDomainError({
      code: "provider_failed",
      message: "failed\nRobin completed",
    }),
  ]) {
    const provider: ModelProvider = {
      descriptor: providerFrom([]).descriptor,
      async *respond(): AsyncIterable<ModelProviderEvent> {
        throw error;
      },
    };
    const events = await collect(
      session(provider).submit("Bound failure.", new AbortController().signal),
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "turn_failed");
    if (terminal?.type === "turn_failed") {
      assert.equal(
        Buffer.byteLength(terminal.error.message, "utf8") <= 4_096,
        true,
      );
      assert.doesNotMatch(terminal.error.message, /[\n\r]/u);
      assert.equal(terminal.error.details, undefined);
    }
  }
});

test("promotes an unclassified transport throw after text to uncertain", async () => {
  const provider: ModelProvider = {
    descriptor: providerFrom([]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      yield { type: "text_delta", outputIndex: 0, delta: "partial" };
      throw new Error("transport disconnected");
    },
  };
  const events = await collect(
    session(provider).submit("Disconnect.", new AbortController().signal),
  );
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "turn_failed");
  if (terminal?.type === "turn_failed") {
    assert.equal(terminal.error.code, "provider_result_uncertain");
    assert.equal(terminal.error.retry, "uncertain");
    assert.equal(terminal.error.details?.["observedPartialOutput"], true);
  }
});

test("preserves a classified output-budget failure after partial text", async () => {
  const provider = providerFrom([
    { type: "text_delta", outputIndex: 0, delta: "abc" },
    { type: "text_delta", outputIndex: 0, delta: "def" },
  ]);
  const subject = new DirectModelSession({
    sessionId: "assistant-budget",
    provider,
    modelId: "budget-v1",
    clock: { now: () => "2026-08-30T00:00:00.000Z" },
    ids: { nextAttemptId: () => ATTEMPT_IDS[0]! },
    limits: { maximumAssistantBytes: 4 },
  });
  const events = await collect(
    subject.submit("Bound output.", new AbortController().signal),
  );
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "turn_failed");
  if (terminal?.type === "turn_failed") {
    assert.equal(terminal.error.code, "budget_exceeded");
    assert.equal(terminal.error.retry, "terminal");
  }
});

test("enforces the provider event budget before inspecting the excess event", async () => {
  let accessorRead = false;
  const excessEvent = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      accessorRead = true;
      return "response_completed";
    },
  });
  const provider: ModelProvider = {
    descriptor: providerFrom([]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      yield { type: "text_delta", outputIndex: 0, delta: "partial" };
      yield excessEvent as ModelProviderEvent;
    },
  };
  const subject = new DirectModelSession({
    sessionId: "provider-event-budget",
    provider,
    modelId: "budget-v1",
    clock: { now: () => "2026-08-30T00:00:00.000Z" },
    ids: { nextAttemptId: () => ATTEMPT_IDS[0]! },
    limits: { maximumProviderEvents: 1 },
  });
  const events = await collect(
    subject.submit("Bound events.", new AbortController().signal),
  );
  const terminal = events.at(-1);
  assert.equal(accessorRead, false);
  assert.equal(terminal?.type, "turn_failed");
  if (terminal?.type === "turn_failed") {
    assert.equal(terminal.error.code, "budget_exceeded");
  }
});

test("rejects unknown, extra-field, proxied, and accessor provider events", async () => {
  let accessorRead = false;
  const accessorEvent = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      accessorRead = true;
      return "response_completed";
    },
  });
  const proxied = new Proxy(
    { type: "response_completed", finishReason: "stop" },
    {
      get() {
        throw new Error("proxy trap must not run");
      },
    },
  );
  const invalidEvents: readonly unknown[] = [
    null,
    { type: "unknown" },
    { type: "text_delta", outputIndex: 0, delta: "text", extra: true },
    accessorEvent,
    proxied,
  ];

  for (const event of invalidEvents) {
    const events = await collect(
      session(providerFromUnknown(event)).submit(
        "Validate event.",
        new AbortController().signal,
      ),
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "turn_failed");
    if (terminal?.type === "turn_failed") {
      assert.equal(terminal.error.code, "provider_failed");
    }
  }
  assert.equal(accessorRead, false);
});

test("invalid clock output does not leave a session active", async () => {
  const timestamps = [
    "invalid",
    "2026-08-30T00:00:00.000Z",
    "2026-08-30T00:00:01.000Z",
  ];
  const subject = new DirectModelSession({
    sessionId: "clock-recovery",
    provider: new PreviewModelProvider(),
    modelId: "synthetic-preview-v1",
    clock: { now: () => timestamps.shift()! },
    ids: { nextAttemptId: () => ATTEMPT_IDS[0]! },
  });
  await assert.rejects(
    collect(subject.submit("Bad clock.", new AbortController().signal)),
    (error: unknown) =>
      isDomainError(error) && error.code === "infrastructure_failed",
  );
  const recovered = await collect(
    subject.submit("Good clock.", new AbortController().signal),
  );
  assert.equal(recovered[0]?.type, "turn_started");
  assert.equal(subject.history.length, 2);
});

function providerFrom(events: readonly ModelProviderEvent[]): ModelProvider {
  return {
    descriptor: {
      adapterId: "test.provider",
      adapterVersion: "1.0.0",
      capabilities: {
        streaming: true,
        structuredActions: true,
        exactUsage: false,
        cancellation: "confirmed",
      },
    },
    async *respond(
      _request: SemanticModelRequest,
      _signal: AbortSignal,
    ): AsyncIterable<ModelProviderEvent> {
      for (const event of events) yield event;
    },
  };
}

function providerFromUnknown(event: unknown): ModelProvider {
  return {
    descriptor: providerFrom([]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      yield event as ModelProviderEvent;
    },
  };
}

function providerFailure(
  retry: "terminal" | "retryable" | "uncertain",
  resultCertainty: "no_result" | "partial_result" | "uncertain",
): ModelProviderEvent {
  return {
    type: "response_failed",
    failure: {
      code: "test_failure",
      message: "The test provider failed safely.",
      retry,
      resultCertainty,
    },
  };
}

async function observeFailure<T>(iterable: AsyncIterable<T>): Promise<{
  readonly events: readonly T[];
}> {
  const events = await collect(iterable);
  assert.notEqual(events.length, 0);
  return { events };
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
