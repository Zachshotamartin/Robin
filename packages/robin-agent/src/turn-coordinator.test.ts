import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentAttemptIdKind,
  createDomainError,
  isDomainError,
  type AgentAttemptId,
  type JsonObject,
} from "@guard/contracts";
import type {
  ModelProvider,
  ModelProviderEvent,
  SemanticModelRequest,
  SemanticOperationDefinition,
} from "@guard/model-provider";

import {
  TurnCoordinator,
  type CompletedProviderToolCall,
  type ToolDispatcher,
  type TurnCoordinatorEvent,
} from "./index.js";

const ATTEMPT_IDS = [
  "att_018f05a0-7b01-7000-8000-000000000001",
  "att_018f05a0-7b01-7000-8000-000000000002",
  "att_018f05a0-7b01-7000-8000-000000000003",
  "att_018f05a0-7b01-7000-8000-000000000004",
  "att_018f05a0-7b01-7000-8000-000000000005",
].map((value) => AgentAttemptIdKind.parse(value));
const TIMESTAMP = "2026-08-30T00:00:00.000Z";

function operation(): SemanticOperationDefinition {
  return {
    capabilityPackId: "robin.coding",
    capabilityPackVersion: 1,
    operationId: "workspace.read_text",
    operationVersion: 1,
    description: "Read bounded UTF-8 workspace text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" } },
    },
  };
}

function actionEvents(
  callId: string,
  path: string,
): readonly ModelProviderEvent[] {
  const identity = operation();
  return [
    {
      type: "action_started",
      callId,
      capabilityPackId: identity.capabilityPackId,
      capabilityPackVersion: identity.capabilityPackVersion,
      operationId: identity.operationId,
      operationVersion: identity.operationVersion,
    },
    {
      type: "action_arguments_delta",
      callId,
      delta: JSON.stringify({ path }),
    },
    {
      type: "action_completed",
      callId,
      capabilityPackId: identity.capabilityPackId,
      capabilityPackVersion: identity.capabilityPackVersion,
      operationId: identity.operationId,
      operationVersion: identity.operationVersion,
      arguments: { path },
    },
  ];
}

function providerFromSteps(
  steps: readonly ((request: SemanticModelRequest) => readonly ModelProviderEvent[])[],
): ModelProvider {
  let next = 0;
  return {
    descriptor: {
      adapterId: "test.turn-provider",
      adapterVersion: "1.0.0",
      capabilities: {
        streaming: true,
        structuredActions: true,
        exactUsage: true,
        cancellation: "confirmed",
      },
    },
    async *respond(request): AsyncIterable<ModelProviderEvent> {
      const step = steps[next];
      assert.notEqual(step, undefined, "unexpected model request");
      next += 1;
      for (const event of step!(request)) yield event;
    },
  };
}

function idSource(): { nextAttemptId(): AgentAttemptId } {
  let next = 0;
  return {
    nextAttemptId() {
      const value = ATTEMPT_IDS[next];
      assert.notEqual(value, undefined, "attempt ID fixture exhausted");
      next += 1;
      return value!;
    },
  };
}

function dispatcher(
  seen: CompletedProviderToolCall[] = [],
): ToolDispatcher {
  return {
    advertisedOperations: [operation()],
    async dispatch(call) {
      seen.push(call);
      return {
        path: call.arguments["path"] ?? null,
        text: `contents:${String(call.arguments["path"])}`,
      };
    },
  };
}

function coordinator(options: {
  readonly provider: ModelProvider;
  readonly toolDispatcher?: ToolDispatcher;
  readonly clock?: { now(): number };
  readonly limits?: ConstructorParameters<typeof TurnCoordinator>[0]["limits"];
  readonly ids?: ConstructorParameters<typeof TurnCoordinator>[0]["ids"];
  readonly timestamp?: ConstructorParameters<typeof TurnCoordinator>[0]["timestamp"];
}): TurnCoordinator {
  return new TurnCoordinator({
    sessionId: "session-1",
    provider: options.provider,
    modelId: "synthetic-coding-v1",
    toolDispatcher: options.toolDispatcher ?? dispatcher(),
    clock: options.clock ?? { now: () => 0 },
    ids: options.ids ?? idSource(),
    timestamp: options.timestamp ?? { now: () => TIMESTAMP },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function drain<T>(iterator: AsyncIterator<T>): Promise<readonly T[]> {
  const values: T[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return values;
    values.push(next.value);
  }
}

function terminalFailure(events: readonly TurnCoordinatorEvent[]): TurnCoordinatorEvent & {
  readonly type: "turn_failed" | "turn_cancelled";
} {
  const event = events.at(-1);
  assert.ok(event?.type === "turn_failed" || event?.type === "turn_cancelled");
  return event;
}

function domainCode(code: string): (error: unknown) => boolean {
  return (error) => isDomainError(error) && error.code === code;
}

test("runs multiple model requests, serializes calls, correlates observations, and preserves turns", async () => {
  const calls: CompletedProviderToolCall[] = [];
  const requests: SemanticModelRequest[] = [];
  const provider = providerFromSteps([
    (request) => {
      requests.push(request);
      assert.deepEqual(request.conversation.map((item) => item.role), ["user"]);
      assert.equal(request.metadata["requestNumber"], 1);
      return [
        { type: "text_delta", outputIndex: 0, delta: "I will read both. " },
        ...actionEvents("call-1", "README.md"),
        ...actionEvents("call-2", "package.json"),
        { type: "response_completed", finishReason: "action_required" },
      ];
    },
    (request) => {
      requests.push(request);
      assert.deepEqual(request.conversation.map((item) => item.role), [
        "user",
        "assistant",
        "operation",
        "operation",
      ]);
      assert.deepEqual(
        request.conversation.slice(2).map((item) => item.correlationId),
        ["call-1", "call-2"],
      );
      const observations = request.conversation.slice(2).map((item) => {
        const block = item.content[0];
        assert.equal(block?.modality, "json");
        return block!.modality === "json" ? block!.value : null;
      });
      assert.deepEqual(observations, [
        { path: "README.md", text: "contents:README.md" },
        { path: "package.json", text: "contents:package.json" },
      ]);
      assert.equal(request.metadata["requestNumber"], 2);
      return [
        { type: "text_delta", outputIndex: 0, delta: "Both files are present." },
        { type: "usage_reported", dimensions: { input_tokens: 20, output_tokens: 5 } },
        { type: "response_completed", finishReason: "stop" },
      ];
    },
    (request) => {
      requests.push(request);
      assert.deepEqual(request.conversation.map((item) => item.role), [
        "user",
        "assistant",
        "operation",
        "operation",
        "assistant",
        "user",
      ]);
      assert.equal(request.metadata["turnNumber"], 2);
      return [
        { type: "text_delta", outputIndex: 0, delta: "Context retained." },
        { type: "response_completed", finishReason: "stop" },
      ];
    },
  ]);
  const subject = coordinator({
    provider,
    toolDispatcher: dispatcher(calls),
  });

  const first = await collect(
    subject.submit("Inspect both files.", new AbortController().signal),
  );
  assert.deepEqual(first.map((event) => event.type), [
    "turn_started",
    "assistant_text_delta",
    "tool_started",
    "tool_completed",
    "tool_started",
    "tool_completed",
    "assistant_text_delta",
    "usage_reported",
    "turn_completed",
  ]);
  assert.deepEqual(calls.map((call) => call.callId), ["call-1", "call-2"]);
  const completed = first.at(-1);
  assert.equal(completed?.type, "turn_completed");
  if (completed?.type === "turn_completed") {
    assert.equal(completed.text, "Both files are present.");
    assert.equal(completed.budget.modelRequests, 2);
    assert.equal(completed.budget.toolCalls, 2);
    assert.equal(completed.budget.providerEvents, 11);
  }

  const second = await collect(
    subject.submit("Do you retain that context?", new AbortController().signal),
  );
  assert.equal(second.at(-1)?.type, "turn_completed");
  assert.equal(requests.length, 3);
  assert.deepEqual(subject.conversation.map((item) => item.role), [
    "user",
    "assistant",
    "operation",
    "operation",
    "assistant",
    "user",
    "assistant",
  ]);
  assert.equal(Object.isFrozen(subject.conversation), true);
});

test("preserves legal opaque provider call IDs through dispatch and observation correlation", async () => {
  const callId = "调用 1 / read";
  let dispatches = 0;
  const subject = coordinator({
    provider: providerFromSteps([
      () => [
        ...actionEvents(callId, "README.md"),
        { type: "response_completed", finishReason: "action_required" },
      ],
      (request) => {
        const observation = request.conversation.at(-1);
        assert.equal(observation?.role, "operation");
        assert.equal(observation?.correlationId, callId);
        return [
          { type: "text_delta", outputIndex: 0, delta: "Opaque ID retained." },
          { type: "response_completed", finishReason: "stop" },
        ];
      },
    ]),
    toolDispatcher: {
      advertisedOperations: [operation()],
      async dispatch(call) {
        dispatches += 1;
        assert.equal(call.callId, callId);
        return { ok: true };
      },
    },
  });

  const events = await collect(
    subject.submit("Use an opaque call ID.", new AbortController().signal),
  );
  assert.equal(dispatches, 1);
  assert.equal(events.at(-1)?.type, "turn_completed");
  assert.equal(
    subject.conversation.find((item) => item.role === "operation")?.correlationId,
    callId,
  );
});

test("rolls back partial failed turns while keeping monotonic turn numbers", async () => {
  const provider = providerFromSteps([
    () => [{ type: "text_delta", outputIndex: 0, delta: "partial" }],
    (request) => {
      assert.equal(request.metadata["turnNumber"], 2);
      assert.deepEqual(request.conversation.map((item) => item.role), ["user"]);
      return [
        { type: "text_delta", outputIndex: 0, delta: "recovered" },
        { type: "response_completed", finishReason: "stop" },
      ];
    },
  ]);
  const subject = coordinator({ provider });
  const failed = await collect(
    subject.submit("Fail once.", new AbortController().signal),
  );
  assert.equal(terminalFailure(failed).error.code, "provider_result_uncertain");
  assert.deepEqual(subject.conversation, []);

  const recovered = await collect(
    subject.submit("Recover.", new AbortController().signal),
  );
  assert.deepEqual(recovered[0], {
    schemaVersion: 1,
    type: "turn_started",
    turnNumber: 2,
  });
  assert.equal(recovered.at(-1)?.type, "turn_completed");
});

test("enforces model-request, tool-call, output, and provider-event budgets", async () => {
  const requestBudget = coordinator({
    provider: providerFromSteps([
      () => [
        ...actionEvents("call-request", "README.md"),
        { type: "response_completed", finishReason: "action_required" },
      ],
    ]),
    limits: { maximumModelRequests: 1 },
  });
  assert.equal(
    terminalFailure(
      await collect(
        requestBudget.submit("Request budget.", new AbortController().signal),
      ),
    ).error.code,
    "budget_exceeded",
  );

  const toolBudget = coordinator({
    provider: providerFromSteps([
      () => [
        ...actionEvents("call-tool-1", "one"),
        ...actionEvents("call-tool-2", "two"),
        { type: "response_completed", finishReason: "action_required" },
      ],
    ]),
    limits: { maximumToolCalls: 1 },
  });
  assert.equal(
    terminalFailure(
      await collect(toolBudget.submit("Tool budget.", new AbortController().signal)),
    ).error.code,
    "budget_exceeded",
  );

  const outputBudget = coordinator({
    provider: providerFromSteps([
      () => [
        { type: "text_delta", outputIndex: 0, delta: "12345" },
        { type: "response_completed", finishReason: "stop" },
      ],
    ]),
    limits: { maximumOutputBytes: 4 },
  });
  assert.equal(
    terminalFailure(
      await collect(
        outputBudget.submit("Output budget.", new AbortController().signal),
      ),
    ).error.code,
    "budget_exceeded",
  );

  const eventBudget = coordinator({
    provider: providerFromSteps([
      () => [
        { type: "text_delta", outputIndex: 0, delta: "ok" },
        { type: "response_completed", finishReason: "stop" },
      ],
    ]),
    limits: { maximumProviderEvents: 1 },
  });
  assert.equal(
    terminalFailure(
      await collect(eventBudget.submit("Event budget.", new AbortController().signal)),
    ).error.code,
    "budget_exceeded",
  );
});

test("does not cross an exhausted output budget into a tool or another model request", async () => {
  let dispatches = 0;
  const noTool = coordinator({
    provider: providerFromSteps([
      () => [
        { type: "text_delta", outputIndex: 0, delta: "full" },
        ...actionEvents("call-after-full", "README.md"),
        { type: "response_completed", finishReason: "action_required" },
      ],
    ]),
    toolDispatcher: {
      advertisedOperations: [operation()],
      async dispatch() {
        dispatches += 1;
        return {};
      },
    },
    limits: { maximumOutputBytes: 4 },
  });
  const fullEvents = await collect(
    noTool.submit("Fill output.", new AbortController().signal),
  );
  assert.equal(dispatches, 0);
  assert.equal(fullEvents.some((event) => event.type === "tool_started"), false);
  assert.equal(terminalFailure(fullEvents).error.code, "budget_exceeded");

  let modelRequests = 0;
  const noContinuation = coordinator({
    provider: {
      descriptor: providerFromSteps([() => []]).descriptor,
      async *respond(): AsyncIterable<ModelProviderEvent> {
        modelRequests += 1;
        yield* actionEvents("call-fills-budget", "README.md");
        yield { type: "response_completed", finishReason: "action_required" };
      },
    },
    toolDispatcher: {
      advertisedOperations: [operation()],
      async dispatch() {
        return {};
      },
    },
    limits: { maximumOutputBytes: 2 },
  });
  const continuationEvents = await collect(
    noContinuation.submit("No continuation.", new AbortController().signal),
  );
  assert.equal(modelRequests, 1);
  assert.equal(terminalFailure(continuationEvents).error.code, "budget_exceeded");
});

test("enforces injected monotonic wall time at provider and tool boundaries", async () => {
  let now = 0;
  const provider: ModelProvider = {
    descriptor: providerFromSteps([() => []]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      now = 11;
      yield { type: "text_delta", outputIndex: 0, delta: "late" };
    },
  };
  const subject = coordinator({
    provider,
    clock: { now: () => now },
    limits: { maximumWallTimeMs: 10 },
  });
  const events = await collect(
    subject.submit("Time out.", new AbortController().signal),
  );
  assert.equal(terminalFailure(events).error.code, "budget_exceeded");
  assert.deepEqual(subject.conversation, []);
});

test("emits cancellation after start, rejects pre-cancellation, and rolls back", async () => {
  const preCancelled = new AbortController();
  preCancelled.abort();
  const untouched = coordinator({
    provider: providerFromSteps([() => []]),
  });
  await assert.rejects(
    collect(untouched.submit("Never start.", preCancelled.signal)),
    domainCode("cancelled"),
  );
  assert.deepEqual(untouched.conversation, []);

  const during = new AbortController();
  const subject = coordinator({
    provider: providerFromSteps([
      () => [
        ...actionEvents("call-cancel", "README.md"),
        { type: "response_completed", finishReason: "action_required" },
      ],
    ]),
    toolDispatcher: {
      advertisedOperations: [operation()],
      async dispatch(): Promise<JsonObject> {
        during.abort();
        return { ignored: true };
      },
    },
  });
  const events = await collect(subject.submit("Cancel during tool.", during.signal));
  assert.equal(terminalFailure(events).type, "turn_cancelled");
  assert.equal(terminalFailure(events).error.code, "cancelled");
  assert.deepEqual(subject.conversation, []);
});

test("rejects concurrent foreground turns and releases ownership when iteration closes", async () => {
  const subject = coordinator({
    provider: providerFromSteps([
      () => [
        { type: "text_delta", outputIndex: 0, delta: "done" },
        { type: "response_completed", finishReason: "stop" },
      ],
      () => [
        { type: "text_delta", outputIndex: 0, delta: "next" },
        { type: "response_completed", finishReason: "stop" },
      ],
    ]),
  });
  const first = subject
    .submit("First.", new AbortController().signal)
    [Symbol.asyncIterator]();
  assert.equal((await first.next()).value?.type, "turn_started");
  await assert.rejects(
    collect(subject.submit("Concurrent.", new AbortController().signal)),
    domainCode("conflict"),
  );
  await first.return?.();
  assert.deepEqual(subject.conversation, []);

  const next = await collect(
    subject.submit("After close.", new AbortController().signal),
  );
  assert.equal(next.at(-1)?.type, "turn_completed");
});

test("a failing budget clock does not leave the coordinator active or consume a turn", async () => {
  let broken = true;
  const subject = coordinator({
    provider: providerFromSteps([
      (request) => {
        assert.equal(request.metadata["turnNumber"], 1);
        return [
          { type: "text_delta", outputIndex: 0, delta: "recovered" },
          { type: "response_completed", finishReason: "stop" },
        ];
      },
    ]),
    clock: {
      now() {
        if (broken) throw new Error("clock secret");
        return 0;
      },
    },
  });
  await assert.rejects(
    collect(subject.submit("Clock fails.", new AbortController().signal)),
    domainCode("infrastructure_failed"),
  );
  broken = false;
  const recovered = await collect(
    subject.submit("Clock recovered.", new AbortController().signal),
  );
  assert.equal(recovered.at(-1)?.type, "turn_completed");
});

test("commits and token-releases ownership before yielding terminal completion", async () => {
  const subject = coordinator({
    provider: providerFromSteps([
      () => [
        { type: "text_delta", outputIndex: 0, delta: "committed" },
        { type: "response_completed", finishReason: "stop" },
      ],
      () => [
        { type: "text_delta", outputIndex: 0, delta: "second committed" },
        { type: "response_completed", finishReason: "stop" },
      ],
    ]),
  });
  const iterator = subject
    .submit("Commit before terminal.", new AbortController().signal)
    [Symbol.asyncIterator]();
  let terminal: TurnCoordinatorEvent | undefined;
  while (terminal?.type !== "turn_completed") {
    const next = await iterator.next();
    assert.equal(next.done, false);
    terminal = next.value;
  }
  assert.deepEqual(subject.conversation.map((item) => item.role), [
    "user",
    "assistant",
  ]);

  const second = subject
    .submit("Start before draining the old terminal.", new AbortController().signal)
    [Symbol.asyncIterator]();
  assert.equal((await second.next()).value?.type, "turn_started");
  assert.deepEqual(subject.conversation.map((item) => item.role), [
    "user",
    "assistant",
    "user",
  ]);

  // Cleanup of the old iterator must neither release nor roll back the newer
  // turn that now owns the foreground slot.
  await iterator.return?.();
  assert.deepEqual(subject.conversation.map((item) => item.role), [
    "user",
    "assistant",
    "user",
  ]);
  await assert.rejects(
    collect(subject.submit("Still concurrent.", new AbortController().signal)),
    domainCode("conflict"),
  );

  const remaining = await drain(second);
  assert.equal(remaining.at(-1)?.type, "turn_completed");
  assert.deepEqual(subject.conversation.map((item) => item.role), [
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
});

test("rolls back and token-releases ownership before yielding terminal failure", async () => {
  const subject = coordinator({
    provider: providerFromSteps([
      () => [
        {
          type: "response_failed",
          failure: {
            code: "upstream_rejected",
            message: "The provider rejected the request.",
            retry: "terminal",
            resultCertainty: "no_result",
          },
        },
      ],
      () => [
        { type: "text_delta", outputIndex: 0, delta: "recovered" },
        { type: "response_completed", finishReason: "stop" },
      ],
    ]),
  });
  const failed = subject
    .submit("Fail terminally.", new AbortController().signal)
    [Symbol.asyncIterator]();
  assert.equal((await failed.next()).value?.type, "turn_started");
  assert.equal((await failed.next()).value?.type, "turn_failed");
  assert.equal(subject.conversation.length, 0);

  const recovered = subject
    .submit("Recover before draining failure.", new AbortController().signal)
    [Symbol.asyncIterator]();
  assert.equal((await recovered.next()).value?.type, "turn_started");
  await failed.return?.();
  assert.deepEqual(subject.conversation.map((item) => item.role), ["user"]);
  await assert.rejects(
    collect(subject.submit("Still concurrent.", new AbortController().signal)),
    domainCode("conflict"),
  );
  assert.equal((await drain(recovered)).at(-1)?.type, "turn_completed");
  assert.deepEqual(subject.conversation.map((item) => item.role), [
    "user",
    "assistant",
  ]);
});

test("token-releases ownership before yielding terminal cancellation", async () => {
  const firstSignal = new AbortController();
  let requestNumber = 0;
  const provider: ModelProvider = {
    descriptor: providerFromSteps([() => []]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      requestNumber += 1;
      if (requestNumber === 1) {
        firstSignal.abort();
        yield { type: "response_completed", finishReason: "stop" };
        return;
      }
      yield { type: "text_delta", outputIndex: 0, delta: "after cancellation" };
      yield { type: "response_completed", finishReason: "stop" };
    },
  };
  const subject = coordinator({ provider });
  const cancelled = subject
    .submit("Cancel.", firstSignal.signal)
    [Symbol.asyncIterator]();
  assert.equal((await cancelled.next()).value?.type, "turn_started");
  assert.equal((await cancelled.next()).value?.type, "turn_cancelled");

  const recovered = subject
    .submit("Recover before draining cancellation.", new AbortController().signal)
    [Symbol.asyncIterator]();
  assert.equal((await recovered.next()).value?.type, "turn_started");
  await cancelled.return?.();
  assert.deepEqual(subject.conversation.map((item) => item.role), ["user"]);
  await assert.rejects(
    collect(subject.submit("Still concurrent.", new AbortController().signal)),
    domainCode("conflict"),
  );
  assert.equal((await drain(recovered)).at(-1)?.type, "turn_completed");
});

test("sanitizes unsafe classified failures before emitting them", async () => {
  const provider: ModelProvider = {
    descriptor: providerFromSteps([() => []]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      throw createDomainError({
        code: "action_failed",
        message: "unsafe\nterminal diagnostic",
        details: { diagnostic: "unsafe\u0007detail" },
      });
    },
  };
  const events = await collect(
    coordinator({ provider }).submit(
      "Sanitize failure.",
      new AbortController().signal,
    ),
  );
  const failure = terminalFailure(events);
  assert.equal(failure.error.code, "action_failed");
  assert.equal(failure.error.message.includes("unsafe"), true);
  assert.equal(failure.error.message.includes("\n"), false);
  assert.equal(failure.error.details, undefined);
});

test("promotes classified provider transport failure after partial output to uncertain", async () => {
  const provider: ModelProvider = {
    descriptor: providerFromSteps([() => []]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      yield { type: "text_delta", outputIndex: 0, delta: "partial" };
      throw createDomainError({
        code: "infrastructure_failed",
        message: "The provider transport failed safely.",
      });
    },
  };
  const events = await collect(
    coordinator({ provider }).submit(
      "Classify provider transport.",
      new AbortController().signal,
    ),
  );
  const failure = terminalFailure(events);
  assert.equal(failure.error.code, "provider_result_uncertain");
  assert.equal(failure.error.retry, "uncertain");
});

test("rejects an unadvertised call before emitting tool_started or invoking dispatcher", async () => {
  let dispatches = 0;
  const subject = coordinator({
    provider: providerFromSteps([
      () => [
        {
          type: "action_started",
          callId: "call-unadvertised",
          capabilityPackId: "robin.coding",
          capabilityPackVersion: 1,
          operationId: "workspace.delete_everything",
          operationVersion: 1,
        },
        {
          type: "action_completed",
          callId: "call-unadvertised",
          capabilityPackId: "robin.coding",
          capabilityPackVersion: 1,
          operationId: "workspace.delete_everything",
          operationVersion: 1,
          arguments: {},
        },
        { type: "response_completed", finishReason: "action_required" },
      ],
    ]),
    toolDispatcher: {
      advertisedOperations: [operation()],
      async dispatch() {
        dispatches += 1;
        return { unexpected: true };
      },
    },
  });
  const events = await collect(
    subject.submit("Reject the call.", new AbortController().signal),
  );
  assert.equal(events.some((event) => event.type === "tool_started"), false);
  assert.equal(dispatches, 0);
  assert.equal(terminalFailure(events).error.code, "invalid_input");
});

test("keeps unsupported explicit terminal finish reasons deterministic", async () => {
  for (const finishReason of ["length", "content_filter", "other"] as const) {
    const events = await collect(
      coordinator({
        provider: providerFromSteps([
          () => [
            { type: "text_delta", outputIndex: 0, delta: "known partial" },
            { type: "response_completed", finishReason },
          ],
        ]),
      }).submit("Reject unsupported terminal.", new AbortController().signal),
    );
    assert.equal(terminalFailure(events).error.code, "provider_failed");
  }
});

test("timestamp preflight failures do not consume a turn or leak diagnostics", async () => {
  let broken = true;
  const subject = coordinator({
    provider: providerFromSteps([
      (request) => {
        assert.equal(request.metadata["turnNumber"], 1);
        return [
          { type: "text_delta", outputIndex: 0, delta: "recovered" },
          { type: "response_completed", finishReason: "stop" },
        ];
      },
    ]),
    timestamp: {
      now() {
        if (broken) throw new Error("timestamp secret");
        return TIMESTAMP;
      },
    },
  });
  await assert.rejects(
    collect(subject.submit("Bad timestamp.", new AbortController().signal)),
    (error: unknown) => {
      assert.equal(domainCode("infrastructure_failed")(error), true);
      assert.equal(JSON.stringify(error).includes("timestamp secret"), false);
      return true;
    },
  );
  broken = false;
  const events = await collect(
    subject.submit("Recovered timestamp.", new AbortController().signal),
  );
  assert.equal(events[0]?.turnNumber, 1);
  assert.equal(events.at(-1)?.type, "turn_completed");
});

test("rejects an invalid injected attempt ID before provider invocation", async () => {
  let invocations = 0;
  const provider: ModelProvider = {
    descriptor: providerFromSteps([() => []]).descriptor,
    async *respond(): AsyncIterable<ModelProviderEvent> {
      invocations += 1;
      yield { type: "response_completed", finishReason: "stop" };
    },
  };
  const subject = coordinator({
    provider,
    ids: {
      nextAttemptId: () => "not-an-attempt-id" as AgentAttemptId,
    },
  });
  const events = await collect(
    subject.submit("Reject ID.", new AbortController().signal),
  );
  assert.equal(terminalFailure(events).error.code, "infrastructure_failed");
  assert.equal(invocations, 0);
  assert.deepEqual(subject.conversation, []);
});
