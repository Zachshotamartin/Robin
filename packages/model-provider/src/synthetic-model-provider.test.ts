import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentAttemptIdKind,
  canonicalize,
  createDomainError,
  isDomainError,
} from "@guard/contracts";
import type { ContentBlock } from "@guard/contracts";

import {
  SyntheticModelProvider,
  type ModelProviderEvent,
  type SemanticModelRequest,
  type SyntheticModelScript,
} from "./index.js";

const ATTEMPT_ID = AgentAttemptIdKind.parse(
  "att_018f05a0-7b01-7000-8000-000000000001",
);

const RESOURCE = {
  schemaVersion: 1,
  scheme: "fixture",
  sourceId: "source:provider-test",
  locator: { record: "alpha" },
  mediaType: "text/plain",
  classification: "internal",
} as const;

function textBlock(id: string, text: string): ContentBlock {
  return {
    schemaVersion: 1,
    blockId: id,
    modality: "text",
    mediaType: "text/plain",
    byteLength: Buffer.byteLength(text),
    contentHash: `sha256:${id}`,
    classification: "internal",
    provenance: {
      source: RESOURCE,
      producer: { kind: "context_source", id: "source:provider-test" },
      capturedAt: "2026-08-30T00:00:00.000Z",
    },
    retentionClass: "run",
    transformation: null,
    text,
    encoding: "utf-8",
    normalization: "none",
  };
}

function request(overrides: Partial<SemanticModelRequest> = {}): SemanticModelRequest {
  return {
    schemaVersion: 1,
    attemptId: ATTEMPT_ID,
    model: {
      modelId: "synthetic/planner-v1",
      settings: { temperature: 0 },
    },
    instructions: ["Return a bounded, evidence-backed answer."],
    conversation: [
      {
        role: "user",
        content: [textBlock("objective", "Find the relevant document.")],
      },
    ],
    operations: [
      {
        capabilityPackId: "capability.documents",
        capabilityPackVersion: 1,
        operationId: "documents.search",
        operationVersion: 1,
        description: "Search the released document corpus.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: { query: { type: "string" } },
        },
      },
    ],
    maximumOutputUnits: 256,
    actionMode: "structured",
    metadata: { scenario: "provider-golden" },
    ...overrides,
  };
}

const SUCCESS_EVENTS: readonly ModelProviderEvent[] = [
  { type: "text_delta", outputIndex: 0, delta: "Found " },
  {
    type: "content_completed",
    outputIndex: 0,
    content: textBlock("answer", "Found one document."),
  },
  {
    type: "usage_reported",
    dimensions: { input_tokens: 31, output_tokens: 4 },
  },
  { type: "response_completed", finishReason: "stop" },
];

function script(
  expectedRequest: SemanticModelRequest = request(),
  events: readonly ModelProviderEvent[] = SUCCESS_EVENTS,
): SyntheticModelScript {
  return {
    scriptId: "provider-golden-v1",
    steps: [{ expectedRequest, events }],
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function isDomainCode(error: unknown, code: string): boolean {
  return isDomainError(error) && error.code === code;
}

function mutableRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

test("replays an exact request as a deterministic immutable event sequence", async () => {
  const mutableEvents = structuredClone(SUCCESS_EVENTS) as ModelProviderEvent[];
  const mutableScript = script(request(), mutableEvents);
  const provider = new SyntheticModelProvider(mutableScript);
  const requestValue = request();
  const before = canonicalize(requestValue);

  mutableEvents[0] = { type: "text_delta", outputIndex: 0, delta: "tampered" };
  (
    mutableScript.steps[0]!.expectedRequest as {
      maximumOutputUnits: number;
    }
  ).maximumOutputUnits = 1;

  const actual = await collect(provider.respond(requestValue, new AbortController().signal));
  const replay = await collect(
    new SyntheticModelProvider(script()).respond(request(), new AbortController().signal),
  );

  assert.deepEqual(actual, SUCCESS_EVENTS);
  assert.deepEqual(replay, actual);
  assert.equal(canonicalize(requestValue), before, "the caller's request was not mutated");
  assert.equal(Object.isFrozen(actual[1]), true);
  assert.equal(Object.isFrozen((actual[1] as { content: ContentBlock }).content), true);
  assert.throws(() => {
    (actual[0] as { delta: string }).delta = "changed";
  }, TypeError);
  assert.equal(Object.isFrozen(provider.descriptor), true);
  assert.equal(Object.isFrozen(provider.descriptor.capabilities), true);
  provider.assertExhausted();
});

test("captures exact final UTF-8 request bytes through defensive copies", async () => {
  const requestValue = request();
  const provider = new SyntheticModelProvider(script(requestValue));
  assert.deepEqual(provider.capturedRequestBytes, []);

  await collect(provider.respond(requestValue, new AbortController().signal));
  const captured = provider.capturedRequestBytes;
  assert.equal(captured.length, 1);
  assert.equal(Object.isFrozen(captured), true);
  assert.deepEqual(
    captured[0],
    new TextEncoder().encode(canonicalize(requestValue)),
  );

  const capturedAgain = provider.capturedRequestBytes;
  assert.notEqual(
    capturedAgain[0],
    captured[0],
    "each access receives a new byte array",
  );
  assert.deepEqual(capturedAgain, captured);
});

test("rejects constructor proxies without invoking traps or leaking canaries", () => {
  const secret = "model-provider-proxy-get-canary";
  let trapCalls = 0;
  const proxied = new Proxy(script(), {
    get() {
      trapCalls += 1;
      throw new Error(secret);
    },
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      throw new Error(secret);
    },
    ownKeys() {
      trapCalls += 1;
      throw new Error(secret);
    },
  });

  assert.throws(
    () => new SyntheticModelProvider(proxied),
    (error: unknown) => {
      assert.equal(isDomainCode(error, "invalid_input"), true);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
  assert.equal(trapCalls, 0);
});

test("rejects request proxies safely without consuming the scripted step", async () => {
  const secret = "model-provider-hostile-request-canary";
  let trapCalls = 0;
  const proxiedRequest = new Proxy(request(), {
    get() {
      trapCalls += 1;
      throw new Error(secret);
    },
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      throw new Error(secret);
    },
    ownKeys() {
      trapCalls += 1;
      throw new Error(secret);
    },
  });
  const provider = new SyntheticModelProvider(script());

  await assert.rejects(
    collect(provider.respond(proxiedRequest, new AbortController().signal)),
    (error: unknown) => {
      assert.equal(isDomainCode(error, "invalid_input"), true);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
  assert.equal(trapCalls, 0);
  assert.equal(provider.remainingSteps, 1);

  assert.deepEqual(
    await collect(provider.respond(request(), new AbortController().signal)),
    SUCCESS_EVENTS,
  );
  provider.assertExhausted();

  const revocable = Proxy.revocable(script(), {});
  revocable.revoke();
  assert.throws(
    () => new SyntheticModelProvider(revocable.proxy),
    (error: unknown) => {
      assert.equal(isDomainCode(error, "invalid_input"), true);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );

  const hostile = new Proxy(script(), {
    ownKeys() {
      throw createDomainError({ code: "provider_failed", message: secret });
    },
  });
  assert.throws(
    () => new SyntheticModelProvider(hostile),
    (error: unknown) => {
      assert.equal(isDomainCode(error, "invalid_input"), true);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
});

test("fails closed on exact-request divergence without consuming the step", async () => {
  const provider = new SyntheticModelProvider(script());
  const divergent = request({ maximumOutputUnits: 255 });

  await assert.rejects(
    collect(provider.respond(divergent, new AbortController().signal)),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(provider.capturedRequestBytes.length, 0);

  assert.throws(
    () => provider.assertExhausted(),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.deepEqual(
    await collect(provider.respond(request(), new AbortController().signal)),
    SUCCESS_EVENTS,
  );
  assert.equal(provider.capturedRequestBytes.length, 1);
});

test("detects an exhausted or incomplete script", async () => {
  const provider = new SyntheticModelProvider(script());

  assert.throws(
    () => provider.assertExhausted(),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  await collect(provider.respond(request(), new AbortController().signal));
  provider.assertExhausted();

  await assert.rejects(
    collect(provider.respond(request(), new AbortController().signal)),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
});

test("honors cancellation before and during event delivery", async () => {
  const beforeStart = new AbortController();
  beforeStart.abort("caller stopped");
  const untouched = new SyntheticModelProvider(script());

  await assert.rejects(
    collect(untouched.respond(request(), beforeStart.signal)),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
  assert.equal(untouched.remainingSteps, 1);
  assert.equal(untouched.capturedRequestBytes.length, 0);

  const during = new AbortController();
  const provider = new SyntheticModelProvider(script());
  const iterator = provider.respond(request(), during.signal)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: SUCCESS_EVENTS[0] });
  assert.equal(provider.capturedRequestBytes.length, 1);
  during.abort();
  await assert.rejects(
    iterator.next(),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
});

test("applies per-event delays through an injected deterministic scheduler", async () => {
  const delays = SUCCESS_EVENTS.map((_, index) => index * 7);
  const observed: number[] = [];
  const provider = new SyntheticModelProvider(
    {
      scriptId: "provider-delays-v1",
      steps: [
        {
          expectedRequest: request(),
          events: SUCCESS_EVENTS,
          delaysBeforeEventsMs: delays,
        },
      ],
    },
    {
      delay(milliseconds, signal) {
        assert.equal(signal.aborted, false);
        observed.push(milliseconds);
      },
    },
  );

  assert.deepEqual(
    await collect(provider.respond(request(), new AbortController().signal)),
    SUCCESS_EVENTS,
  );
  assert.deepEqual(observed, delays);
  provider.assertExhausted();
});

test("validates deterministic delay scripts and confirms cancellation after a scheduler boundary", async () => {
  assert.throws(
    () =>
      new SyntheticModelProvider({
        scriptId: "provider-bad-delays-v1",
        steps: [
          {
            expectedRequest: request(),
            events: SUCCESS_EVENTS,
            delaysBeforeEventsMs: [1],
          },
        ],
      }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const controller = new AbortController();
  const provider = new SyntheticModelProvider(
    {
      scriptId: "provider-cancelled-delay-v1",
      steps: [
        {
          expectedRequest: request(),
          events: SUCCESS_EVENTS,
          delaysBeforeEventsMs: SUCCESS_EVENTS.map(() => 1),
        },
      ],
    },
    {
      delay() {
        controller.abort();
      },
    },
  );
  await assert.rejects(
    collect(provider.respond(request(), controller.signal)),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
  assert.equal(provider.remainingSteps, 0);
});

test("rejects malformed scripts and normalized event sequences at construction", () => {
  const invalidScripts: readonly unknown[] = [
    { scriptId: "", steps: [] },
    { scriptId: "bad", steps: [] },
    script(request({ maximumOutputUnits: 0 })),
    script(request(), [{ type: "unknown" } as never]),
    script(request(), [
      { type: "response_completed", finishReason: "stop" },
      { type: "text_delta", outputIndex: 0, delta: "late" },
    ]),
    script(request(), [
      { type: "action_arguments_delta", callId: "call-1", delta: "{}" },
      { type: "response_completed", finishReason: "action_required" },
    ]),
    script(request(), [
      { type: "usage_reported", dimensions: { input_tokens: -1 } },
      { type: "response_completed", finishReason: "stop" },
    ]),
  ];

  for (const invalid of invalidScripts) {
    assert.throws(
      () => new SyntheticModelProvider(invalid as SyntheticModelScript),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
});

test("rejects malformed nested contracts and provider-branded extra fields", () => {
  const candidates: unknown[] = [];
  const add = (mutate: (script: Record<string, unknown>) => void): void => {
    const candidate = structuredClone(script()) as unknown as Record<string, unknown>;
    mutate(candidate);
    candidates.push(candidate);
  };
  const firstStep = (candidate: Record<string, unknown>): Record<string, unknown> =>
    mutableRecord((candidate["steps"] as unknown[])[0]);
  const expectedRequest = (
    candidate: Record<string, unknown>,
  ): Record<string, unknown> => mutableRecord(firstStep(candidate)["expectedRequest"]);
  const events = (candidate: Record<string, unknown>): unknown[] =>
    firstStep(candidate)["events"] as unknown[];

  add((candidate) => { candidate["providerRequestId"] = "provider-secret"; });
  add((candidate) => { firstStep(candidate)["providerRequestId"] = "provider-secret"; });
  add((candidate) => { expectedRequest(candidate)["providerRequestId"] = "provider-secret"; });
  add((candidate) => {
    mutableRecord(expectedRequest(candidate)["model"])["providerRegion"] = "vendor";
  });
  add((candidate) => {
    mutableRecord((expectedRequest(candidate)["conversation"] as unknown[])[0])[
      "providerItemId"
    ] = "vendor";
  });
  add((candidate) => {
    mutableRecord((expectedRequest(candidate)["conversation"] as unknown[])[0])[
      "content"
    ] = [{}];
  });
  add((candidate) => {
    mutableRecord((expectedRequest(candidate)["operations"] as unknown[])[0])[
      "providerDialect"
    ] = "vendor";
  });
  add((candidate) => { mutableRecord(events(candidate)[0])["providerEventId"] = "vendor"; });
  add((candidate) => { mutableRecord(events(candidate)[1])["content"] = {}; });

  for (const candidate of candidates) {
    assert.throws(
      () => new SyntheticModelProvider(candidate as SyntheticModelScript),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
});

test("rejects actions when disabled and operations that were not exactly advertised", () => {
  const eventsFor = (operationId: string): readonly ModelProviderEvent[] => [
    {
      type: "action_started",
      callId: "call-1",
      capabilityPackId: "capability.documents",
      capabilityPackVersion: 1,
      operationId,
      operationVersion: 1,
    },
    {
      type: "action_completed",
      callId: "call-1",
      capabilityPackId: "capability.documents",
      capabilityPackVersion: 1,
      operationId,
      operationVersion: 1,
      arguments: { query: "policy" },
    },
    { type: "response_completed", finishReason: "action_required" },
  ];

  assert.throws(
    () =>
      new SyntheticModelProvider(
        script(
          request({ actionMode: "none", operations: [] }),
          eventsFor("documents.search"),
        ),
      ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  assert.throws(
    () =>
      new SyntheticModelProvider(
        script(request(), eventsFor("documents.unadvertised")),
      ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("preserves exact pack-qualified operation identity in both directions", () => {
  const baseRequest = request();
  const firstOperation = baseRequest.operations[0];
  assert.notEqual(firstOperation, undefined);
  const archiveIdentity = {
    capabilityPackId: "capability.archive-documents",
    capabilityPackVersion: 3,
    operationId: firstOperation!.operationId,
    operationVersion: firstOperation!.operationVersion,
  };
  const archiveOperation = {
    ...firstOperation!,
    ...archiveIdentity,
  };
  const multiPackRequest = request({
    operations: [firstOperation!, archiveOperation],
  });
  const eventsFor = (
    identity: Pick<
      typeof archiveOperation,
      | "capabilityPackId"
      | "capabilityPackVersion"
      | "operationId"
      | "operationVersion"
    >,
  ): readonly ModelProviderEvent[] => [
    { type: "action_started", callId: "call-1", ...identity },
    {
      type: "action_completed",
      callId: "call-1",
      ...identity,
      arguments: { query: "policy" },
    },
    { type: "response_completed", finishReason: "action_required" },
  ];

  assert.doesNotThrow(
    () =>
      new SyntheticModelProvider(
        script(multiPackRequest, eventsFor(archiveIdentity)),
      ),
  );

  for (const invalidIdentity of [
    { ...archiveIdentity, capabilityPackId: "capability.unadvertised" },
    { ...archiveIdentity, capabilityPackVersion: 0 },
    { ...archiveIdentity, operationVersion: 0 },
  ]) {
    assert.throws(
      () =>
        new SyntheticModelProvider(
          script(multiPackRequest, eventsFor(invalidIdentity)),
        ),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }

  const missingIdentity = structuredClone(
    eventsFor(archiveIdentity),
  ) as unknown as Array<Record<string, unknown>>;
  delete missingIdentity[0]?.["capabilityPackId"];
  assert.throws(
    () =>
      new SyntheticModelProvider(
        script(
          multiPackRequest,
          missingIdentity as unknown as readonly ModelProviderEvent[],
        ),
      ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("can emit complete structured action calls and normalized failures", async () => {
  const actionEvents: readonly ModelProviderEvent[] = [
    {
      type: "action_started",
      callId: "call-1",
      capabilityPackId: "capability.documents",
      capabilityPackVersion: 1,
      operationId: "documents.search",
      operationVersion: 1,
    },
    {
      type: "action_arguments_delta",
      callId: "call-1",
      delta: '{"query":"policy"}',
    },
    {
      type: "action_completed",
      callId: "call-1",
      capabilityPackId: "capability.documents",
      capabilityPackVersion: 1,
      operationId: "documents.search",
      operationVersion: 1,
      arguments: { query: "policy" },
    },
    { type: "response_completed", finishReason: "action_required" },
  ];
  const failureEvents: readonly ModelProviderEvent[] = [
    {
      type: "response_failed",
      failure: {
        code: "upstream_unavailable",
        message: "Synthetic upstream unavailable.",
        retry: "retryable",
        resultCertainty: "no_result",
      },
    },
  ];

  assert.deepEqual(
    await collect(
      new SyntheticModelProvider(script(request(), actionEvents)).respond(
        request(),
        new AbortController().signal,
      ),
    ),
    actionEvents,
  );
  assert.deepEqual(
    await collect(
      new SyntheticModelProvider(script(request(), failureEvents)).respond(
        request(),
        new AbortController().signal,
      ),
    ),
    failureEvents,
  );
});
