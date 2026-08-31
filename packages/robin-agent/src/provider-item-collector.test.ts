import assert from "node:assert/strict";
import test from "node:test";

import { isDomainError, sha256Hex, type ContentBlock } from "@guard/contracts";
import type { ModelProviderEvent } from "@guard/model-provider";

import { ProviderItemCollector } from "./index.js";

function textBlock(text: string): ContentBlock {
  return {
    schemaVersion: 1,
    blockId: "provider-answer",
    modality: "text",
    mediaType: "text/plain",
    byteLength: Buffer.byteLength(text, "utf8"),
    contentHash: `sha256:${sha256Hex(text)}`,
    classification: "internal",
    provenance: {
      source: null,
      producer: { kind: "provider", id: "test.provider" },
      capturedAt: "2026-08-30T00:00:00.000Z",
    },
    retentionClass: "session",
    transformation: null,
    text,
    encoding: "utf-8",
    normalization: "none",
  };
}

const ACTION_IDENTITY = Object.freeze({
  capabilityPackId: "robin.coding",
  capabilityPackVersion: 1,
  operationId: "workspace.read_text",
  operationVersion: 1,
});

function domainCode(code: string): (error: unknown) => boolean {
  return (error) => isDomainError(error) && error.code === code;
}

test("collects streamed and completed text with monotonic usage", () => {
  const collector = new ProviderItemCollector();
  assert.deepEqual(
    collector.accept({ type: "text_delta", outputIndex: 0, delta: "hel" }),
    { type: "assistant_text_delta", delta: "hel" },
  );
  assert.deepEqual(
    collector.accept({ type: "text_delta", outputIndex: 0, delta: "lo" }),
    { type: "assistant_text_delta", delta: "lo" },
  );
  assert.equal(
    collector.accept({
      type: "content_completed",
      outputIndex: 0,
      content: textBlock("hello"),
    }),
    null,
  );
  assert.deepEqual(
    collector.accept({
      type: "usage_reported",
      dimensions: { input_tokens: 4, output_tokens: 2 },
    }),
    {
      type: "usage_reported",
      dimensions: { input_tokens: 4, output_tokens: 2 },
    },
  );
  collector.accept({ type: "response_completed", finishReason: "stop" });

  assert.deepEqual(collector.finish(), {
    text: "hello",
    toolCalls: [],
    usage: { input_tokens: 4, output_tokens: 2 },
    finishReason: "stop",
  });
});

test("synthesizes one live delta from non-streamed completed text", () => {
  const collector = new ProviderItemCollector();
  assert.deepEqual(
    collector.accept({
      type: "content_completed",
      outputIndex: 0,
      content: textBlock("whole"),
    }),
    { type: "assistant_text_delta", delta: "whole" },
  );
  collector.accept({ type: "response_completed", finishReason: "stop" });
  assert.equal(collector.finish().text, "whole");
});

test("releases complete calls only after exact fragment agreement and action_required", () => {
  const collector = new ProviderItemCollector();
  collector.accept({ type: "action_started", callId: "call-1", ...ACTION_IDENTITY });
  collector.accept({
    type: "action_arguments_delta",
    callId: "call-1",
    delta: '{"path":',
  });
  collector.accept({
    type: "action_arguments_delta",
    callId: "call-1",
    delta: '"README.md"}',
  });
  collector.accept({
    type: "action_completed",
    callId: "call-1",
    ...ACTION_IDENTITY,
    arguments: { path: "README.md" },
  });
  collector.accept({
    type: "response_completed",
    finishReason: "action_required",
  });

  const response = collector.finish();
  assert.equal(response.finishReason, "action_required");
  assert.deepEqual(response.toolCalls, [
    {
      callId: "call-1",
      ...ACTION_IDENTITY,
      argumentsJson: '{"path":"README.md"}',
      arguments: { path: "README.md" },
    },
  ]);
  assert.equal(Object.isFrozen(response.toolCalls), true);
  assert.equal(Object.isFrozen(response.toolCalls[0]?.arguments), true);
});

test("compares streamed JSON semantically without treating compact numeric syntax as a byte limit", () => {
  const collector = new ProviderItemCollector({ maximumArgumentBytes: 64 });
  collector.accept({ type: "action_started", callId: "call-number", ...ACTION_IDENTITY });
  collector.accept({
    type: "action_arguments_delta",
    callId: "call-number",
    delta: '{"value":1e20}',
  });
  collector.accept({
    type: "action_completed",
    callId: "call-number",
    ...ACTION_IDENTITY,
    arguments: { value: 100000000000000000000 },
  });
  collector.accept({ type: "response_completed", finishReason: "action_required" });
  assert.equal(collector.finish().toolCalls[0]?.argumentsJson, '{"value":1e20}');
});

test("accepts exact-bound JSON when an astral scalar is split across argument fragments", () => {
  const argumentsJson = JSON.stringify({ value: "😀" });
  const split = argumentsJson.indexOf("\ud83d") + 1;
  assert.equal(Buffer.byteLength(argumentsJson, "utf8"), 16);
  const collector = new ProviderItemCollector({ maximumArgumentBytes: 16 });
  collector.accept({ type: "action_started", callId: "call-unicode", ...ACTION_IDENTITY });
  collector.accept({
    type: "action_arguments_delta",
    callId: "call-unicode",
    delta: argumentsJson.slice(0, split),
  });
  collector.accept({
    type: "action_arguments_delta",
    callId: "call-unicode",
    delta: argumentsJson.slice(split),
  });
  collector.accept({
    type: "action_completed",
    callId: "call-unicode",
    ...ACTION_IDENTITY,
    arguments: { value: "😀" },
  });
  collector.accept({ type: "response_completed", finishReason: "action_required" });
  assert.equal(collector.finish().toolCalls[0]?.argumentsJson, argumentsJson);
});

test("rejects invalid call lifecycle, changed identity, duplicate IDs, and JSON disagreement", () => {
  const invalidSequences: readonly (readonly ModelProviderEvent[])[] = [
    [
      { type: "action_arguments_delta", callId: "missing", delta: "{}" },
    ],
    [
      { type: "action_started", callId: "call-1", ...ACTION_IDENTITY },
      { type: "action_started", callId: "call-1", ...ACTION_IDENTITY },
    ],
    [
      { type: "action_started", callId: "call-1", ...ACTION_IDENTITY },
      {
        type: "action_completed",
        callId: "call-1",
        ...ACTION_IDENTITY,
        operationVersion: 2,
        arguments: {},
      },
    ],
    [
      { type: "action_started", callId: "call-1", ...ACTION_IDENTITY },
      {
        type: "action_arguments_delta",
        callId: "call-1",
        delta: '{"path":"one"}',
      },
      {
        type: "action_completed",
        callId: "call-1",
        ...ACTION_IDENTITY,
        arguments: { path: "two" },
      },
    ],
  ];

  for (const sequence of invalidSequences) {
    const collector = new ProviderItemCollector();
    assert.throws(() => {
      for (const event of sequence) collector.accept(event);
    }, domainCode("provider_failed"));
  }
});

test("rejects post-terminal data, duplicate final events, and incompatible finishes", () => {
  for (const late of [
    { type: "response_completed", finishReason: "stop" },
    { type: "text_delta", outputIndex: 0, delta: "late" },
  ] as const) {
    const collector = new ProviderItemCollector();
    collector.accept({ type: "response_completed", finishReason: "stop" });
    assert.throws(
      () => collector.accept(late as ModelProviderEvent),
      domainCode("provider_failed"),
    );
  }

  const noCall = new ProviderItemCollector();
  noCall.accept({ type: "response_completed", finishReason: "action_required" });
  assert.throws(() => noCall.finish(), domainCode("provider_failed"));

  const stoppedWithCall = new ProviderItemCollector();
  stoppedWithCall.accept({
    type: "action_started",
    callId: "call-1",
    ...ACTION_IDENTITY,
  });
  stoppedWithCall.accept({
    type: "action_completed",
    callId: "call-1",
    ...ACTION_IDENTITY,
    arguments: {},
  });
  stoppedWithCall.accept({ type: "response_completed", finishReason: "stop" });
  assert.throws(() => stoppedWithCall.finish(), domainCode("provider_failed"));
});

test("rejects forbidden __proto__ fields without prototype pollution", () => {
  const event = {
    type: "response_completed",
    finishReason: "stop",
  } as Record<string, unknown>;
  Object.defineProperty(event, "__proto__", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: { polluted: true },
  });
  const collector = new ProviderItemCollector();
  assert.throws(
    () => collector.accept(event as unknown as ModelProviderEvent),
    domainCode("provider_failed"),
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("classifies incomplete or partially emitted terminal failures as uncertain", () => {
  const incomplete = new ProviderItemCollector();
  incomplete.accept({ type: "action_started", callId: "call-1", ...ACTION_IDENTITY });
  incomplete.accept({
    type: "response_completed",
    finishReason: "action_required",
  });
  assert.throws(
    () => incomplete.finish(),
    domainCode("provider_result_uncertain"),
  );

  const ended = new ProviderItemCollector();
  ended.accept({ type: "text_delta", outputIndex: 0, delta: "partial" });
  assert.throws(() => ended.finish(), domainCode("provider_result_uncertain"));

  const failed = new ProviderItemCollector();
  failed.accept({ type: "text_delta", outputIndex: 0, delta: "partial" });
  failed.accept({
    type: "response_failed",
    failure: {
      code: "upstream_reset",
      message: "The upstream reset safely.",
      retry: "retryable",
      resultCertainty: "no_result",
    },
  });
  assert.throws(() => failed.finish(), domainCode("provider_result_uncertain"));

  const noOutput = new ProviderItemCollector();
  assert.throws(() => noOutput.finish(), domainCode("provider_failed"));
});

test("enforces text, argument, call-count, and usage bounds", () => {
  assert.throws(
    () => new ProviderItemCollector({ maximumCallIdBytes: 257 }),
    domainCode("invalid_input"),
  );

  const text = new ProviderItemCollector({ maximumTextBytes: 2 });
  text.accept({ type: "text_delta", outputIndex: 0, delta: "ok" });
  assert.throws(
    () => text.accept({ type: "text_delta", outputIndex: 0, delta: "!" }),
    domainCode("budget_exceeded"),
  );

  const args = new ProviderItemCollector({ maximumArgumentBytes: 2 });
  args.accept({ type: "action_started", callId: "call-1", ...ACTION_IDENTITY });
  assert.throws(
    () =>
      args.accept({
        type: "action_arguments_delta",
        callId: "call-1",
        delta: "{}x",
      }),
    domainCode("budget_exceeded"),
  );

  const calls = new ProviderItemCollector({ maximumCalls: 1 });
  calls.accept({ type: "action_started", callId: "call-1", ...ACTION_IDENTITY });
  assert.throws(
    () =>
      calls.accept({
        type: "action_started",
        callId: "call-2",
        ...ACTION_IDENTITY,
      }),
    domainCode("budget_exceeded"),
  );

  const usage = new ProviderItemCollector();
  usage.accept({
    type: "usage_reported",
    dimensions: { input_tokens: 2, output_tokens: 2 },
  });
  assert.throws(
    () =>
      usage.accept({
        type: "usage_reported",
        dimensions: { input_tokens: 3, output_tokens: 1 },
      }),
    domainCode("provider_failed"),
  );
  usage.accept({ type: "response_completed", finishReason: "stop" });
  assert.deepEqual(usage.finish().usage, {
    input_tokens: 2,
    output_tokens: 2,
  });

  for (const event of [
    {
      type: "action_started",
      callId: "12345",
      ...ACTION_IDENTITY,
    },
    {
      type: "action_arguments_delta",
      callId: "12345",
      delta: "{}",
    },
    {
      type: "action_completed",
      callId: "12345",
      ...ACTION_IDENTITY,
      arguments: {},
    },
  ] as const) {
    const boundedCallIds = new ProviderItemCollector({ maximumCallIdBytes: 4 });
    assert.throws(
      () => boundedCallIds.accept(event),
      domainCode("provider_failed"),
    );
  }
});
