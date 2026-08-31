import assert from "node:assert/strict";
import test from "node:test";

import { createDomainError, isDomainError, type JsonObject } from "@guard/contracts";
import type { SemanticOperationDefinition } from "@guard/model-provider";

import {
  SerializedToolLoop,
  type CompletedProviderToolCall,
  type ToolDispatcher,
} from "./index.js";

function operation(): SemanticOperationDefinition {
  return {
    capabilityPackId: "robin.coding",
    capabilityPackVersion: 1,
    operationId: "workspace.read_text",
    operationVersion: 1,
    description: "Read bounded UTF-8 workspace text.",
    inputSchema: { type: "object" },
  };
}

function call(
  callId: string,
  overrides: Partial<CompletedProviderToolCall> = {},
): CompletedProviderToolCall {
  return {
    callId,
    capabilityPackId: "robin.coding",
    capabilityPackVersion: 1,
    operationId: "workspace.read_text",
    operationVersion: 1,
    argumentsJson: '{"path":"README.md"}',
    arguments: { path: "README.md" },
    ...overrides,
  };
}

function domainCode(code: string): (error: unknown) => boolean {
  return (error) => isDomainError(error) && error.code === code;
}

test("dispatches only exactly advertised calls and snapshots observations", async () => {
  const advertised = operation();
  const seen: CompletedProviderToolCall[] = [];
  const dispatcher: ToolDispatcher = {
    advertisedOperations: [advertised],
    async dispatch(value) {
      seen.push(value);
      return { path: value.arguments["path"] ?? null, text: "hello" };
    },
  };
  const loop = new SerializedToolLoop(dispatcher);
  (advertised.inputSchema as { type: string }).type = "tampered";

  const result = await loop.dispatch(call("call-1"), new AbortController().signal);
  assert.equal(seen.length, 1);
  assert.deepEqual(result.observation, { path: "README.md", text: "hello" });
  assert.equal(Object.isFrozen(result.observation), true);
  assert.deepEqual(loop.advertisedOperations[0]?.inputSchema, { type: "object" });

  await assert.rejects(
    loop.dispatch(
      call("call-2", { operationVersion: 2 }),
      new AbortController().signal,
    ),
    domainCode("invalid_input"),
  );
});

test("serializes concurrent complete calls in submission order", async () => {
  const started: string[] = [];
  const releases: Array<() => void> = [];
  let active = 0;
  let maximumActive = 0;
  const loop = new SerializedToolLoop({
    advertisedOperations: [operation()],
    async dispatch(value) {
      started.push(value.callId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { callId: value.callId };
    },
  });
  const signal = new AbortController().signal;
  const first = loop.dispatch(call("call-1"), signal);
  const second = loop.dispatch(call("call-2"), signal);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, ["call-1"]);
  releases.shift()?.();
  await first;
  await Promise.resolve();
  assert.deepEqual(started, ["call-1", "call-2"]);
  releases.shift()?.();
  await second;
  assert.equal(maximumActive, 1);
});

test("rejects duplicate call IDs, cancellation, and invalid observations", async () => {
  const loop = new SerializedToolLoop({
    advertisedOperations: [operation()],
    async dispatch() {
      return { ok: true };
    },
  });
  await loop.dispatch(call("call-1"), new AbortController().signal);
  await assert.rejects(
    loop.dispatch(call("call-1"), new AbortController().signal),
    domainCode("conflict"),
  );

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    loop.dispatch(call("call-cancelled"), aborted.signal),
    domainCode("cancelled"),
  );

  const oversized = new SerializedToolLoop(
    {
      advertisedOperations: [operation()],
      async dispatch(): Promise<JsonObject> {
        return { a: "x" };
      },
    },
    { maximumObservationBytes: 4 },
  );
  await assert.rejects(
    oversized.dispatch(call("call-large"), new AbortController().signal),
    domainCode("budget_exceeded"),
  );
});

test("preserves classified dispatcher failures and sanitizes unknown failures", async () => {
  const classified = new SerializedToolLoop({
    advertisedOperations: [operation()],
    async dispatch() {
      throw createDomainError({
        code: "action_failed",
        message: "The operation failed safely.",
      });
    },
  });
  await assert.rejects(
    classified.dispatch(call("call-1"), new AbortController().signal),
    domainCode("action_failed"),
  );

  const unknown = new SerializedToolLoop({
    advertisedOperations: [operation()],
    async dispatch() {
      throw new Error("secret upstream diagnostic");
    },
  });
  await assert.rejects(
    unknown.dispatch(call("call-2"), new AbortController().signal),
    (error: unknown) => {
      assert.equal(domainCode("action_failed")(error), true);
      assert.equal(JSON.stringify(error).includes("secret upstream diagnostic"), false);
      return true;
    },
  );
});

test("snapshots prepared and queued calls before caller mutation", async () => {
  const received: CompletedProviderToolCall[] = [];
  const releases: Array<() => void> = [];
  const loop = new SerializedToolLoop({
    advertisedOperations: [operation()],
    async dispatch(value) {
      received.push(value);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { path: value.arguments["path"] ?? null };
    },
  });
  const firstCall = call("call-first");
  const first = loop.dispatch(firstCall, new AbortController().signal);

  const mutable = call("call-mutable") as {
    -readonly [Key in keyof CompletedProviderToolCall]: CompletedProviderToolCall[Key];
  };
  const mutableArguments = mutable.arguments as Record<string, unknown>;
  const second = loop.dispatch(mutable, new AbortController().signal);
  mutable.operationId = "workspace.unadvertised";
  mutable.argumentsJson = '{"path":"tampered"}';
  mutableArguments["path"] = "tampered";

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(received.length, 1);
  releases.shift()?.();
  await first;
  await Promise.resolve();
  assert.equal(received.length, 2);
  assert.equal(received[1]?.operationId, "workspace.read_text");
  assert.deepEqual(received[1]?.arguments, { path: "README.md" });
  assert.equal(received[1]?.argumentsJson, '{"path":"README.md"}');
  releases.shift()?.();
  await second;
});
