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

test("snapshots scripts before validation without invoking proxy get traps", async () => {
  const secret = "model-provider-proxy-get-canary";
  let getCalls = 0;
  const proxied = new Proxy(script(), {
    get() {
      getCalls += 1;
      throw new Error(secret);
    },
  });

  const provider = new SyntheticModelProvider(proxied);
  assert.equal(getCalls, 0);
  assert.deepEqual(
    await collect(provider.respond(request(), new AbortController().signal)),
    SUCCESS_EVENTS,
  );
  assert.equal(getCalls, 0);
});

test("requests are detached before validation and hostile proxies fail safely", async () => {
  const secret = "model-provider-hostile-request-canary";
  let getCalls = 0;
  const proxiedRequest = new Proxy(request(), {
    get() {
      getCalls += 1;
      throw new Error(secret);
    },
  });
  const provider = new SyntheticModelProvider(script());
  assert.deepEqual(
    await collect(provider.respond(proxiedRequest, new AbortController().signal)),
    SUCCESS_EVENTS,
  );
  assert.equal(getCalls, 0);

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

  assert.throws(
    () => provider.assertExhausted(),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.deepEqual(
    await collect(provider.respond(request(), new AbortController().signal)),
    SUCCESS_EVENTS,
  );
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

  const during = new AbortController();
  const provider = new SyntheticModelProvider(script());
  const iterator = provider.respond(request(), during.signal)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: SUCCESS_EVENTS[0] });
  during.abort();
  await assert.rejects(
    iterator.next(),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
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

test("can emit complete structured action calls and normalized failures", async () => {
  const actionEvents: readonly ModelProviderEvent[] = [
    {
      type: "action_started",
      callId: "call-1",
      operationId: "documents.search",
    },
    {
      type: "action_arguments_delta",
      callId: "call-1",
      delta: '{"query":"policy"}',
    },
    {
      type: "action_completed",
      callId: "call-1",
      operationId: "documents.search",
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
