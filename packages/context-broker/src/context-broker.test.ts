import assert from "node:assert/strict";
import test from "node:test";

import { isDomainError } from "@guard/contracts";

import {
  ContextSourceRegistry,
  InMemoryContextSource,
  type ContextSource,
  type InMemoryContextSourceOptions,
} from "./index.js";

const HOSTILE_CANARY = "context-hostile-canary";

function isDomainCode(error: unknown, code: string): boolean {
  return isDomainError(error) && error.code === code;
}

function isSanitizedDomainCode(error: unknown, code: string): boolean {
  return (
    isDomainError(error) &&
    error.code === code &&
    !error.message.includes(HOSTILE_CANARY)
  );
}

function memoryOptions(): InMemoryContextSourceOptions {
  return {
    descriptor: {
      sourceId: "memory:notes",
      sourceVersion: 1,
      scheme: "memory",
      description: "Synthetic non-coding notes.",
    },
    records: [
      {
        recordId: "alpha",
        value: { title: "Alpha", tags: ["safe", "bounded"] },
      },
    ],
    limits: { maximumRecords: 4, maximumRecordBytes: 256 },
  };
}

function memorySource(
  records: Array<{
    recordId: string;
    value: Readonly<Record<string, unknown>>;
    mediaType?: string;
    classification?: string;
  }> = [
    {
      recordId: "alpha",
      value: { title: "Alpha", tags: ["safe", "bounded"] },
    },
  ],
): InMemoryContextSource {
  return new InMemoryContextSource({ ...memoryOptions(), records });
}

test("registers exact source versions and rejects duplicate or unknown sources", () => {
  const source = memorySource();
  const versionTwo = new InMemoryContextSource({
    descriptor: {
      sourceId: "memory:notes",
      sourceVersion: 2,
      scheme: "memory",
      description: "A separately pinned fixture version.",
    },
    records: [{ recordId: "beta", value: { title: "Beta" } }],
    limits: { maximumRecords: 2, maximumRecordBytes: 128 },
  });
  const registry = new ContextSourceRegistry([source, versionTwo]);

  assert.equal(registry.resolve("memory:notes", 1), source);
  assert.equal(registry.resolve("memory:notes", 2), versionTwo);
  assert.deepEqual(
    registry.list().map(({ sourceId, sourceVersion }) => [sourceId, sourceVersion]),
    [
      ["memory:notes", 1],
      ["memory:notes", 2],
    ],
  );
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.equal(Object.isFrozen(registry.list()[0]), true);

  assert.throws(
    () => new ContextSourceRegistry([source, source]),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
  assert.throws(
    () => registry.resolve("memory:missing", 1),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  assert.throws(
    () => registry.resolve("memory:notes", 3),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("snapshots fixture input and returns immutable, content-addressed bounded items", async () => {
  const mutableValue = { title: "Alpha", nested: { allowed: true } };
  const mutableRecords: Array<{
    recordId: string;
    value: Readonly<Record<string, unknown>>;
  }> = [{ recordId: "alpha", value: mutableValue }];
  const source = memorySource(mutableRecords);

  mutableValue.title = "tampered";
  mutableValue.nested.allowed = false;
  mutableRecords.push({ recordId: "injected", value: { title: "Injected" } });

  const request = source.normalizeRequest({ recordId: "alpha" });
  const result = await source.readBounded(
    request,
    { maximumItems: 1, maximumBytes: 256 },
    new AbortController().signal,
  );

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0]!.value, {
    nested: { allowed: true },
    title: "Alpha",
  });
  assert.equal(result.items[0]!.resource.sourceId, "memory:notes");
  assert.match(result.items[0]!.contentHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.totalBytes, result.items[0]!.byteLength);
  assert.equal(result.truncated, false);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.resource.locator), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.items), true);
  assert.equal(Object.isFrozen(result.items[0]!.value), true);
  assert.equal(Object.isFrozen(result.items[0]!.value["nested"]), true);
  assert.throws(() => {
    (result.items[0]!.value as { title: string }).title = "changed";
  }, TypeError);
  assert.throws(
    () => source.normalizeRequest({ recordId: "injected" }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("snapshots in-memory options once and rejects hostile or inexact configuration", async () => {
  let getterCalls = 0;
  const accessorOptions: Record<string, unknown> = {
    descriptor: memoryOptions().descriptor,
    limits: memoryOptions().limits,
  };
  Object.defineProperty(accessorOptions, "records", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(HOSTILE_CANARY);
    },
  });
  assert.throws(
    () =>
      new InMemoryContextSource(
        accessorOptions as unknown as InMemoryContextSourceOptions,
      ),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(getterCalls, 0, "options getter must never run");

  let proxyGetCalls = 0;
  const hostileOptions = new Proxy(memoryOptions(), {
    get() {
      proxyGetCalls += 1;
      throw new Error(HOSTILE_CANARY);
    },
    ownKeys() {
      throw new Error(HOSTILE_CANARY);
    },
  });
  assert.throws(
    () => new InMemoryContextSource(hostileOptions),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(proxyGetCalls, 0, "options get trap must never run");

  const revoked = Proxy.revocable(memoryOptions(), {});
  revoked.revoke();
  assert.throws(
    () => new InMemoryContextSource(revoked.proxy),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );

  assert.throws(
    () =>
      new InMemoryContextSource({
        ...memoryOptions(),
        unexpected: true,
      } as InMemoryContextSourceOptions),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  assert.throws(
    () =>
      new InMemoryContextSource({
        ...memoryOptions(),
        limits: {
          ...memoryOptions().limits,
          unexpected: 1,
        },
      } as InMemoryContextSourceOptions),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  assert.throws(
    () =>
      new InMemoryContextSource({
        ...memoryOptions(),
        records: [
          {
            recordId: "alpha",
            value: { title: "Alpha" },
            unexpected: true,
          },
        ] as unknown as InMemoryContextSourceOptions["records"],
      } as InMemoryContextSourceOptions),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const mutableFiles = { title: "Original" };
  const mutableLimits = { maximumRecords: 1, maximumRecordBytes: 64 };
  const source = new InMemoryContextSource({
    ...memoryOptions(),
    records: [{ recordId: "stable", value: mutableFiles }],
    limits: mutableLimits,
  });
  mutableFiles.title = "Changed";
  mutableLimits.maximumRecordBytes = 1;
  const request = source.normalizeRequest({ recordId: "stable" });
  const result = await source.readBounded(
    request,
    { maximumItems: 1, maximumBytes: 64 },
    new AbortController().signal,
  );
  assert.deepEqual(result.items[0]!.value, { title: "Original" });
});

test("snapshots requests and budgets before semantic reads", async () => {
  const source = memorySource();
  let requestGetterCalls = 0;
  const accessorRequest: Record<string, unknown> = {};
  Object.defineProperty(accessorRequest, "recordId", {
    enumerable: true,
    get() {
      requestGetterCalls += 1;
      throw new Error(HOSTILE_CANARY);
    },
  });
  assert.throws(
    () => source.normalizeRequest(accessorRequest),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(requestGetterCalls, 0, "request getter must never run");

  let requestProxyGets = 0;
  const requestProxy = new Proxy({ recordId: "alpha" }, {
    get() {
      requestProxyGets += 1;
      throw new Error(HOSTILE_CANARY);
    },
  });
  assert.throws(
    () => source.normalizeRequest(requestProxy),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(requestProxyGets, 0, "request get trap must never run");

  const request = source.normalizeRequest({ recordId: "alpha" });
  let budgetGetterCalls = 0;
  const accessorBudget: Record<string, unknown> = { maximumItems: 1 };
  Object.defineProperty(accessorBudget, "maximumBytes", {
    enumerable: true,
    get() {
      budgetGetterCalls += 1;
      throw new Error(HOSTILE_CANARY);
    },
  });
  await assert.rejects(
    source.readBounded(
      request,
      accessorBudget as unknown as { maximumItems: number; maximumBytes: number },
      new AbortController().signal,
    ),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(budgetGetterCalls, 0, "budget getter must never run");

  await assert.rejects(
    source.readBounded(
      request,
      { maximumItems: 1, maximumBytes: 256, unexpected: 1 } as {
        maximumItems: number;
        maximumBytes: number;
      },
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("inspects trusted executable context-source installations without invoking accessors", () => {
  let descriptorGetterCalls = 0;
  const hostileSource: Record<string, unknown> = {
    normalizeRequest() {
      return {};
    },
    async readBounded() {
      return { items: [], totalBytes: 0, truncated: false };
    },
  };
  Object.defineProperty(hostileSource, "descriptor", {
    enumerable: true,
    get() {
      descriptorGetterCalls += 1;
      throw new Error(HOSTILE_CANARY);
    },
  });
  assert.throws(
    () => new ContextSourceRegistry([hostileSource as unknown as ContextSource]),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(descriptorGetterCalls, 0, "installed descriptor getter must never run");

  let sourceProxyGets = 0;
  const sourceProxy = new Proxy(memorySource(), {
    get() {
      sourceProxyGets += 1;
      throw new Error(HOSTILE_CANARY);
    },
  });
  assert.throws(
    () => new ContextSourceRegistry([sourceProxy]),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(sourceProxyGets, 0, "installed-source get trap must never run");

  // Functions remain installed trusted code; only their data descriptors and
  // detached JSON descriptor are inspected during registration.
  const trusted = memorySource();
  const registry = new ContextSourceRegistry([trusted]);
  assert.equal(registry.resolve("memory:notes", 1), trusted);
});

test("fails closed before release for malformed requests, oversize data, budgets, and cancellation", async () => {
  assert.throws(
    () =>
      memorySource([
        { recordId: "huge", value: { text: "x".repeat(300) } },
      ]),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const source = memorySource();
  const malformed: readonly unknown[] = [
    null,
    {},
    { recordId: "" },
    { recordId: "alpha", extra: true },
    { recordId: "missing" },
  ];
  for (const raw of malformed) {
    assert.throws(
      () => source.normalizeRequest(raw),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }

  const request = source.normalizeRequest({ recordId: "alpha" });
  await assert.rejects(
    source.readBounded(
      request,
      { maximumItems: 0, maximumBytes: 256 },
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "budget_exceeded"),
  );
  await assert.rejects(
    source.readBounded(
      request,
      { maximumItems: 1, maximumBytes: 0 },
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "budget_exceeded"),
  );
  await assert.rejects(
    source.readBounded(
      request,
      { maximumItems: 1, maximumBytes: 1 },
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "budget_exceeded"),
  );
  await assert.rejects(
    source.readBounded(
      { ...request, sourceVersion: 2 },
      { maximumItems: 1, maximumBytes: 256 },
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  await assert.rejects(
    source.readBounded(
      {
        ...request,
        resource: { ...request.resource, schemaVersion: 2 },
      } as unknown as typeof request,
      { maximumItems: 1, maximumBytes: 256 },
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  await assert.rejects(
    source.readBounded(
      {
        ...request,
        resource: { ...request.resource, untrusted: true },
      } as typeof request,
      { maximumItems: 1, maximumBytes: 256 },
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const aborted = new AbortController();
  aborted.abort("test cancellation");
  await assert.rejects(
    source.readBounded(
      request,
      { maximumItems: 1, maximumBytes: 256 },
      aborted.signal,
    ),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
});

test("the registry accepts any structurally conforming generic source port", async () => {
  const source = memorySource();
  const port: ContextSource = source;
  const registry = new ContextSourceRegistry([port]);
  const resolved: ContextSource = registry.resolve("memory:notes", 1);
  const request = resolved.normalizeRequest({ recordId: "alpha" });
  const result = await resolved.readBounded(
    request,
    { maximumItems: 1, maximumBytes: 256 },
    new AbortController().signal,
  );

  assert.equal(result.items[0]!.resource.scheme, "memory");
});
