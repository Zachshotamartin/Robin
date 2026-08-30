import assert from "node:assert/strict";
import test from "node:test";

import {
  EventIdKind,
  RunIdKind,
  canonicalBytes,
  createDomainError,
  isDomainError,
  parseEventEnvelope,
  parseNewEvent,
} from "@guard/contracts";
import type {
  EventEnvelope,
  GenericEvent,
  GenericEventEnvelope,
  JsonObject,
  NewEvent,
  RunId,
} from "@guard/contracts";

import { InMemoryEventStore } from "./index.js";
import type { EnvelopeOf, EventStore } from "./index.js";

const FIRST_RECORDED_AT = "2026-08-30T08:00:00.000Z";
const SECOND_RECORDED_AT = "2026-08-30T08:00:01.000Z";

function makeEvent<TPayload extends JsonObject>(
  payload: TPayload
): Extract<GenericEvent, { readonly eventType: "RunIntentAppended" }> {
  return {
    eventId: EventIdKind.generate(),
    eventType: "RunIntentAppended",
    eventSchemaVersion: 1,
    occurredAt: "2026-08-30T07:59:59.000Z",
    actor: { kind: "runtime", id: "runtime:test" },
    correlationId: "correlation:test",
    causationId: null,
    payload: {
      intentType: "event-store.test",
      intentVersion: 1,
      payload,
      submittedBy: { kind: "user", id: "user:test" },
    },
  };
}

function makeStartedEvent(): Extract<
  GenericEvent,
  { readonly eventType: "RunStarted" }
> {
  return {
    eventId: EventIdKind.generate(),
    eventType: "RunStarted",
    eventSchemaVersion: 1,
    occurredAt: "2026-08-30T07:59:59.000Z",
    actor: { kind: "runtime", id: "runtime:test" },
    correlationId: "correlation:test",
    causationId: null,
    payload: { startedAt: "2026-08-30T07:59:59.000Z" },
  };
}

function makePausedEvent(): Extract<
  GenericEvent,
  { readonly eventType: "RunPaused" }
> {
  return {
    eventId: EventIdKind.generate(),
    eventType: "RunPaused",
    eventSchemaVersion: 1,
    occurredAt: "2026-08-30T07:59:59.000Z",
    actor: { kind: "runtime", id: "runtime:test" },
    correlationId: "correlation:test",
    causationId: null,
    payload: { reason: "test pause" },
  };
}

async function collect<TEvent>(
  events: AsyncIterable<TEvent>
): Promise<readonly TEvent[]> {
  const collected: TEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function assertDomainErrorCode(code: "conflict" | "invalid_input") {
  return (error: unknown): boolean =>
    isDomainError(error) && error.code === code;
}

type PatchProducedEvent = NewEvent<
  "coding.PatchProduced",
  { readonly patchId: string }
>;
type PatchProducedEnvelope = EventEnvelope<
  "coding.PatchProduced",
  { readonly patchId: string }
>;

function makePatchEvent(): PatchProducedEvent {
  return {
    eventId: EventIdKind.generate(),
    eventType: "coding.PatchProduced",
    eventSchemaVersion: 1,
    occurredAt: "2026-08-30T07:59:59.000Z",
    actor: { kind: "runtime", id: "runtime:test" },
    correlationId: "correlation:test",
    causationId: null,
    payload: { patchId: "patch:one" },
  };
}

function assertPatchPayload(value: unknown): asserts value is { readonly patchId: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as { readonly patchId?: unknown }).patchId !== "string"
  ) {
    throw createDomainError({
      code: "invalid_input",
      message: "Invalid coding.PatchProduced payload.",
    });
  }
}

function parsePatchEvent(value: unknown): PatchProducedEvent {
  const parsed = parseNewEvent(value);
  if (parsed.eventType !== "coding.PatchProduced") {
    throw createDomainError({
      code: "invalid_input",
      message: "Expected coding.PatchProduced.",
    });
  }
  assertPatchPayload(parsed.payload);
  return parsed as PatchProducedEvent;
}

function parsePatchEnvelope(value: unknown): PatchProducedEnvelope {
  const parsed = parseEventEnvelope(value);
  if (parsed.eventType !== "coding.PatchProduced") {
    throw createDomainError({
      code: "invalid_input",
      message: "Expected coding.PatchProduced envelope.",
    });
  }
  assertPatchPayload(parsed.payload);
  return parsed as PatchProducedEnvelope;
}

function assertSafeInvalidInput(canary: string) {
  return (error: unknown): boolean => {
    assert.equal(isDomainError(error), true);
    if (!isDomainError(error)) return false;
    assert.equal(error.code, "invalid_input");
    assert.equal(JSON.stringify(error).includes(canary), false);
    return true;
  };
}

function sizeEnvelope(
  streamId: RunId,
  event: Extract<GenericEvent, { readonly eventType: "RunIntentAppended" }>,
  streamVersion = 1
): GenericEventEnvelope {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    eventSchemaVersion: event.eventSchemaVersion,
    occurredAt: event.occurredAt,
    actor: event.actor,
    correlationId: event.correlationId,
    causationId: event.causationId,
    payload: event.payload,
    streamId,
    streamVersion,
    recordedAt: FIRST_RECORDED_AT,
  };
}

test("the first expected-version-zero append creates a stream at version one", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  const proposed = makeEvent({ objective: "exercise the event store" });

  const appended = await store.append(streamId, 0, [proposed]);

  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0], {
    ...proposed,
    streamId,
    streamVersion: 1,
    recordedAt: FIRST_RECORDED_AT,
  });
  assert.deepEqual(await collect(store.read(streamId)), appended);
});

test("a missing stream conflicts when its expected version is nonzero", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });

  await assert.rejects(
    store.append(streamId, 1, [makeEvent({ sequence: 1 })]),
    (error: unknown) => {
      assert.equal(assertDomainErrorCode("conflict")(error), true);
      if (!isDomainError(error)) return false;
      assert.deepEqual(error.details, {
        streamId,
        expectedVersion: 1,
        actualVersion: 0,
      });
      return true;
    }
  );
  assert.deepEqual(await collect(store.read(streamId)), []);
});

test("successful batches are gap-free and receive one stable recordedAt", async () => {
  const streamId = RunIdKind.generate();
  let clockCalls = 0;
  const store = new InMemoryEventStore({
    now: () => {
      clockCalls += 1;
      return FIRST_RECORDED_AT;
    },
  });

  const appended = await store.append(streamId, 0, [
    makeEvent({ sequence: 1 }),
    makeEvent({ sequence: 2 }),
    makeEvent({ sequence: 3 }),
  ]);

  assert.deepEqual(
    appended.map(({ streamVersion }) => streamVersion),
    [1, 2, 3]
  );
  assert.deepEqual(
    appended.map(({ recordedAt }) => recordedAt),
    [FIRST_RECORDED_AT, FIRST_RECORDED_AT, FIRST_RECORDED_AT]
  );
  assert.equal(clockCalls, 1);
});

test("later appends continue at the exact expected version", async () => {
  const streamId = RunIdKind.generate();
  const recordedAt = [FIRST_RECORDED_AT, SECOND_RECORDED_AT];
  const store = new InMemoryEventStore({
    now: () => recordedAt.shift() ?? assert.fail("clock called too often"),
  });

  await store.append(streamId, 0, [
    makeEvent({ sequence: 1 }),
    makeEvent({ sequence: 2 }),
  ]);
  const appended = await store.append(streamId, 2, [
    makeEvent({ sequence: 3 }),
    makeEvent({ sequence: 4 }),
  ]);

  assert.deepEqual(
    appended.map(({ streamVersion }) => streamVersion),
    [3, 4]
  );
  assert.deepEqual(
    (await collect(store.read(streamId))).map(({ streamVersion }) => streamVersion),
    [1, 2, 3, 4]
  );
});

test("a stale expected version returns a typed conflict without appending", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  await store.append(streamId, 0, [makeEvent({ sequence: 1 })]);

  await assert.rejects(
    store.append(streamId, 0, [makeEvent({ sequence: 2 })]),
    (error: unknown) => {
      assert.equal(assertDomainErrorCode("conflict")(error), true);
      if (!isDomainError(error)) return false;
      assert.deepEqual(error.details, {
        streamId,
        expectedVersion: 0,
        actualVersion: 1,
      });
      return true;
    }
  );
  assert.deepEqual(
    (await collect(store.read(streamId))).map(({ payload }) =>
      (payload as { readonly payload: JsonObject }).payload
    ),
    [{ sequence: 1 }]
  );
});

test("two concurrent appends at one expected version cannot both win", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });

  const results = await Promise.allSettled([
    store.append(streamId, 0, [makeEvent({ contender: "first" })]),
    store.append(streamId, 0, [makeEvent({ contender: "second" })]),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.equal(assertDomainErrorCode("conflict")(rejected.reason), true);
  const history = await collect(store.read(streamId));
  assert.equal(history.length, 1);
  assert.equal(history[0]?.streamVersion, 1);
});

test("read returns only events strictly after afterVersion", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  await store.append(streamId, 0, [
    makeEvent({ sequence: 1 }),
    makeEvent({ sequence: 2 }),
    makeEvent({ sequence: 3 }),
  ]);

  assert.deepEqual(
    (await collect(store.read(streamId, 1))).map(({ streamVersion }) => streamVersion),
    [2, 3]
  );
  assert.deepEqual(await collect(store.read(streamId, 3)), []);
  assert.deepEqual(await collect(store.read(RunIdKind.generate(), 0)), []);
});

test("an in-progress read retains its point-in-time history", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  await store.append(streamId, 0, [
    makeEvent({ sequence: 1 }),
    makeEvent({ sequence: 2 }),
  ]);

  const iterator = store.read(streamId)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.streamVersion, 1);
  await store.append(streamId, 2, [makeEvent({ sequence: 3 })]);

  const retained: number[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    retained.push(next.value.streamVersion);
  }
  assert.deepEqual(retained, [2]);
  assert.deepEqual(
    (await collect(store.read(streamId))).map(({ streamVersion }) => streamVersion),
    [1, 2, 3]
  );
});

test("streams retain independent versions and histories", async () => {
  const firstStreamId = RunIdKind.generate();
  const secondStreamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });

  await store.append(firstStreamId, 0, [
    makeEvent({ stream: "first", sequence: 1 }),
    makeEvent({ stream: "first", sequence: 2 }),
  ]);
  await store.append(secondStreamId, 0, [
    makeEvent({ stream: "second", sequence: 1 }),
  ]);

  assert.deepEqual(
    (await collect(store.read(firstStreamId))).map(({ streamVersion }) =>
      streamVersion
    ),
    [1, 2]
  );
  assert.deepEqual(
    (await collect(store.read(secondStreamId))).map(({ streamVersion }) =>
      streamVersion
    ),
    [1]
  );
});

test("append snapshots caller values and returns deeply immutable envelopes", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  const mutablePayload = {
    nested: { count: 1 },
    labels: ["original"],
  };
  const proposed = makeEvent(mutablePayload);

  const appended = await store.append(streamId, 0, [proposed]);
  mutablePayload.nested.count = 99;
  mutablePayload.labels.push("mutated");

  const envelope = appended[0];
  assert.ok(envelope);
  const storedPayload = envelope.payload.payload as {
    readonly nested: { count: number };
    readonly labels: readonly string[];
  };
  assert.deepEqual(storedPayload, {
    labels: ["original"],
    nested: { count: 1 },
  });
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.actor), true);
  assert.equal(Object.isFrozen(envelope.payload), true);
  assert.equal(Object.isFrozen(storedPayload), true);
  assert.equal(
    Object.isFrozen(storedPayload.nested),
    true
  );
  assert.equal(
    Object.isFrozen(storedPayload.labels),
    true
  );
  assert.throws(() => {
    storedPayload.nested.count = 5;
  }, TypeError);

  const reread = (await collect(store.read(streamId)))[0];
  assert.ok(reread);
  assert.deepEqual(reread.payload, envelope.payload);
  assert.notStrictEqual(reread, envelope);
  assert.notStrictEqual(reread.payload, envelope.payload);
});

test("an invalid event rejects the whole batch and creates no phantom stream", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  const invalidEvent = {
    ...makeEvent({ sequence: 2 }),
    payload: { forbidden: undefined },
  } as unknown as GenericEvent;

  await assert.rejects(
    store.append(streamId, 0, [makeEvent({ sequence: 1 }), invalidEvent]),
    assertDomainErrorCode("invalid_input")
  );
  assert.deepEqual(await collect(store.read(streamId)), []);

  const next = await store.append(streamId, 0, [makeEvent({ sequence: 1 })]);
  assert.equal(next[0]?.streamVersion, 1);
});

test("invalid envelope identity is rejected before any event becomes visible", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  const invalidEvent = {
    ...makeEvent({ sequence: 1 }),
    eventId: "evt_not-a-uuid",
  } as unknown as GenericEvent;

  await assert.rejects(
    store.append(streamId, 0, [invalidEvent]),
    assertDomainErrorCode("invalid_input")
  );
  assert.deepEqual(await collect(store.read(streamId)), []);
});

test("an invalid batch timestamp rejects atomically", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => "not-a-timestamp" });

  await assert.rejects(
    store.append(streamId, 0, [
      makeEvent({ sequence: 1 }),
      makeEvent({ sequence: 2 }),
    ]),
    assertDomainErrorCode("invalid_input")
  );
  assert.deepEqual(await collect(store.read(streamId)), []);
});

test("empty appends and invalid version cursors fail closed", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });

  await assert.rejects(
    store.append(streamId, 0, []),
    assertDomainErrorCode("invalid_input")
  );
  await assert.rejects(
    store.append(streamId, -1, [makeEvent({ sequence: 1 })]),
    assertDomainErrorCode("invalid_input")
  );
  await assert.rejects(
    store.append(streamId, 0.5, [makeEvent({ sequence: 1 })]),
    assertDomainErrorCode("invalid_input")
  );
  await assert.rejects(
    collect(store.read(streamId, -1)),
    assertDomainErrorCode("invalid_input")
  );
  await assert.rejects(
    collect(store.read(streamId, Number.MAX_SAFE_INTEGER + 1)),
    assertDomainErrorCode("invalid_input")
  );
  assert.deepEqual(await collect(store.read(streamId)), []);
});

test("unbranded invalid stream identifiers fail at the public boundary", async () => {
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  const invalidStreamId = "run_not-a-uuid" as RunId;

  await assert.rejects(
    store.append(invalidStreamId, 0, [makeEvent({ sequence: 1 })]),
    assertDomainErrorCode("invalid_input")
  );
  await assert.rejects(
    collect(store.read(invalidStreamId)),
    assertDomainErrorCode("invalid_input")
  );
});

test("a heterogeneous event union preserves eventType-to-payload narrowing", async () => {
  type LifecycleEvent =
    | ReturnType<typeof makeStartedEvent>
    | ReturnType<typeof makePausedEvent>;

  const streamId = RunIdKind.generate();
  const store: EventStore<GenericEvent> =
    new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  const appended = await store.append(streamId, 0, [
    makeStartedEvent(),
    makePausedEvent(),
  ]);

  const compileTimeEnvelope: EnvelopeOf<LifecycleEvent> = appended[0] ??
    assert.fail("missing heterogeneous envelope");
  if (compileTimeEnvelope.eventType === "RunStarted") {
    assert.equal(compileTimeEnvelope.payload.startedAt.endsWith("Z"), true);
    // @ts-expect-error RunStarted payloads do not contain a pause reason.
    void compileTimeEnvelope.payload.reason;
  } else {
    assert.equal(compileTimeEnvelope.payload.reason, "test pause");
    // @ts-expect-error RunPaused payloads do not contain a start timestamp.
    void compileTimeEnvelope.payload.startedAt;
  }

  const reread = await collect(store.read(streamId));
  assert.deepEqual(reread.map(({ eventType }) => eventType), [
    "RunStarted",
    "RunPaused",
  ]);
});

test("the default parser rejects namespaced events unless a strict parser is injected", async () => {
  const defaultStreamId = RunIdKind.generate();
  const defaultStore = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  await assert.rejects(
    defaultStore.append(defaultStreamId, 0, [makePatchEvent() as never]),
    assertDomainErrorCode("invalid_input")
  );
  assert.deepEqual(await collect(defaultStore.read(defaultStreamId)), []);

  let eventParses = 0;
  let envelopeParses = 0;
  const extensionStore = new InMemoryEventStore<PatchProducedEvent>({
    now: () => FIRST_RECORDED_AT,
    parser: {
      parseEvent(value: unknown): PatchProducedEvent {
        eventParses += 1;
        return parsePatchEvent(value);
      },
      parseEnvelope(value: unknown): PatchProducedEnvelope {
        envelopeParses += 1;
        return parsePatchEnvelope(value);
      },
    },
  });
  const extensionStreamId = RunIdKind.generate();
  const appended = await extensionStore.append(extensionStreamId, 0, [
    makePatchEvent(),
  ]);
  assert.equal(appended[0]?.payload.patchId, "patch:one");
  assert.equal(eventParses, 1);
  assert.equal(envelopeParses, 1);
  await collect(extensionStore.read(extensionStreamId));
  assert.equal(envelopeParses, 2);
});

test("reads are revalidated by the configured strict envelope parser", async () => {
  const canary = "READ-PARSER-CANARY";
  let rejectEnvelope = false;
  const store = new InMemoryEventStore<PatchProducedEvent>({
    now: () => FIRST_RECORDED_AT,
    parser: {
      parseEvent: parsePatchEvent,
      parseEnvelope(value: unknown): PatchProducedEnvelope {
        if (rejectEnvelope) throw new Error(canary);
        return parsePatchEnvelope(value);
      },
    },
  });
  const streamId = RunIdKind.generate();
  await store.append(streamId, 0, [makePatchEvent()]);
  rejectEnvelope = true;

  await assert.rejects(
    collect(store.read(streamId)),
    assertSafeInvalidInput(canary)
  );
});

test("envelope-only fields are rejected before enrichment and append remains atomic", async () => {
  const streamId = RunIdKind.generate();
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  const proposed = makeEvent({ sequence: 1 });
  const forgedEnvelopeInput = {
    ...proposed,
    streamId: RunIdKind.generate(),
    streamVersion: 999,
    recordedAt: SECOND_RECORDED_AT,
  } as unknown as GenericEvent;

  await assert.rejects(
    store.append(streamId, 0, [forgedEnvelopeInput]),
    assertDomainErrorCode("invalid_input")
  );
  assert.deepEqual(await collect(store.read(streamId)), []);

  const unknownFieldInput = {
    ...makeEvent({ sequence: 2 }),
    unexpected: "must not enter the audit log",
  } as unknown as GenericEvent;
  await assert.rejects(
    store.append(streamId, 0, [unknownFieldInput]),
    assertDomainErrorCode("invalid_input")
  );
  assert.deepEqual(await collect(store.read(streamId)), []);

  const appended = await store.append(streamId, 0, [makeEvent({ sequence: 2 })]);
  assert.equal(appended[0]?.streamVersion, 1);
});

test("decorated and accessor batches or events fail without invoking caller code", async () => {
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  const accessorCanary = "ACCESSOR-CANARY";
  let accessorCalls = 0;

  const accessorBatch = new Array<GenericEvent>(1);
  Object.defineProperty(accessorBatch, "0", {
    enumerable: true,
    configurable: true,
    get(): GenericEvent {
      accessorCalls += 1;
      throw new Error(accessorCanary);
    },
  });
  await assert.rejects(
    store.append(RunIdKind.generate(), 0, accessorBatch),
    assertSafeInvalidInput(accessorCanary)
  );
  assert.equal(accessorCalls, 0);

  const accessorEvent = { ...makeEvent({ sequence: 1 }) };
  Object.defineProperty(accessorEvent, "payload", {
    enumerable: true,
    configurable: true,
    get(): never {
      accessorCalls += 1;
      throw new Error(accessorCanary);
    },
  });
  await assert.rejects(
    store.append(RunIdKind.generate(), 0, [accessorEvent as never]),
    assertSafeInvalidInput(accessorCanary)
  );
  assert.equal(accessorCalls, 0);

  const decoratedBatch = [makeEvent({ sequence: 1 })];
  Object.defineProperty(decoratedBatch, "unexpected", {
    value: true,
    enumerable: true,
  });
  await assert.rejects(
    store.append(RunIdKind.generate(), 0, decoratedBatch),
    assertDomainErrorCode("invalid_input")
  );

  const decoratedEvent = { ...makeEvent({ sequence: 1 }) };
  Object.defineProperty(decoratedEvent, "unexpected", {
    value: "hidden audit input",
    enumerable: false,
  });
  await assert.rejects(
    store.append(RunIdKind.generate(), 0, [decoratedEvent]),
    assertDomainErrorCode("invalid_input")
  );
});

test("proxy and revoked batches or events fail without traps or canary leakage", async () => {
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  const canary = "PROXY-TRAP-CANARY";
  let trapCalls = 0;
  const traps = {
    ownKeys(): never {
      trapCalls += 1;
      throw new Error(canary);
    },
    get(): never {
      trapCalls += 1;
      throw new Error(canary);
    },
  };

  const proxyBatch = new Proxy([makeEvent({ sequence: 1 })], traps);
  await assert.rejects(
    store.append(RunIdKind.generate(), 0, proxyBatch),
    assertSafeInvalidInput(canary)
  );
  assert.equal(trapCalls, 0);

  const proxyEvent = new Proxy(makeEvent({ sequence: 1 }), traps);
  await assert.rejects(
    store.append(RunIdKind.generate(), 0, [proxyEvent]),
    assertSafeInvalidInput(canary)
  );
  assert.equal(trapCalls, 0);

  const revokedBatch = Proxy.revocable([makeEvent({ sequence: 1 })], {});
  revokedBatch.revoke();
  await assert.rejects(
    store.append(RunIdKind.generate(), 0, revokedBatch.proxy),
    assertSafeInvalidInput(canary)
  );

  const revokedEvent = Proxy.revocable(makeEvent({ sequence: 1 }), {});
  revokedEvent.revoke();
  await assert.rejects(
    store.append(RunIdKind.generate(), 0, [revokedEvent.proxy]),
    assertSafeInvalidInput(canary)
  );
});

test("hostile expected versions and read cursors map to safe invalid-input errors", async () => {
  const store = new InMemoryEventStore({ now: () => FIRST_RECORDED_AT });
  const streamId = RunIdKind.generate();
  const canary = "VERSION-CANARY";
  let trapCalls = 0;
  const hostile = new Proxy({}, {
    getPrototypeOf(): never {
      trapCalls += 1;
      throw new Error(canary);
    },
    ownKeys(): never {
      trapCalls += 1;
      throw new Error(canary);
    },
  });
  const invalidValues: readonly unknown[] = [1n, Symbol(canary), hostile];

  for (const value of invalidValues) {
    await assert.rejects(
      store.append(streamId, value as number, [makeEvent({ sequence: 1 })]),
      assertSafeInvalidInput(canary)
    );
    await assert.rejects(
      collect(store.read(streamId, value as number)),
      assertSafeInvalidInput(canary)
    );
  }
  assert.equal(trapCalls, 0);
  assert.deepEqual(await collect(store.read(streamId)), []);
});

test("throwing and invalid clocks map to safe typed errors without publication", async () => {
  const canary = "CLOCK-CANARY";
  const clocks: readonly (() => unknown)[] = [
    () => {
      throw new Error(canary);
    },
    () => 1n,
    () => Symbol(canary),
    () => "not-a-timestamp",
    new Proxy(() => FIRST_RECORDED_AT, {
      apply(): never {
        throw new Error(canary);
      },
    }),
  ];

  for (const clock of clocks) {
    const store = new InMemoryEventStore({ now: clock as () => string });
    const streamId = RunIdKind.generate();
    await assert.rejects(
      store.append(streamId, 0, [makeEvent({ sequence: 1 })]),
      assertSafeInvalidInput(canary)
    );
    assert.deepEqual(await collect(store.read(streamId)), []);
  }
});

test("maximumBatchEvents is positive and enforces just-under, at, and over atomically", async () => {
  for (const invalid of [0, -1, 1.5, 1n] as const) {
    assert.throws(
      () => new InMemoryEventStore({ maximumBatchEvents: invalid as number }),
      assertDomainErrorCode("invalid_input")
    );
  }

  const store = new InMemoryEventStore({
    now: () => FIRST_RECORDED_AT,
    maximumBatchEvents: 2,
  });
  const belowStream = RunIdKind.generate();
  const atStream = RunIdKind.generate();
  const overStream = RunIdKind.generate();
  assert.equal((await store.append(belowStream, 0, [makeEvent({ n: 1 })])).length, 1);
  assert.equal((await store.append(atStream, 0, [
    makeEvent({ n: 1 }),
    makeEvent({ n: 2 }),
  ])).length, 2);
  await assert.rejects(
    store.append(overStream, 0, [
      makeEvent({ n: 1 }),
      makeEvent({ n: 2 }),
      makeEvent({ n: 3 }),
    ]),
    assertDomainErrorCode("invalid_input")
  );
  assert.deepEqual(await collect(store.read(overStream)), []);
});

test("maximumEventBytes enforces canonical envelope bytes at just-under, at, and over", async () => {
  for (const invalid of [0, -1, 1.5, 1n] as const) {
    assert.throws(
      () => new InMemoryEventStore({ maximumEventBytes: invalid as number }),
      assertDomainErrorCode("invalid_input")
    );
  }

  const sizingStream = RunIdKind.generate();
  const below = makeEvent({ padding: "x".repeat(9) });
  const at = makeEvent({ padding: "x".repeat(10) });
  const over = makeEvent({ padding: "x".repeat(11) });
  const limit = canonicalBytes(sizeEnvelope(sizingStream, at)).byteLength;
  assert.equal(canonicalBytes(sizeEnvelope(sizingStream, below)).byteLength, limit - 1);
  assert.equal(canonicalBytes(sizeEnvelope(sizingStream, over)).byteLength, limit + 1);

  const store = new InMemoryEventStore({
    now: () => FIRST_RECORDED_AT,
    maximumEventBytes: limit,
  });
  await store.append(sizingStream, 0, [below]);
  await store.append(RunIdKind.generate(), 0, [at]);

  const atomicStream = RunIdKind.generate();
  const atomicAt = makeEvent({ padding: "x".repeat(10) });
  const atomicOver = makeEvent({ padding: "x".repeat(11) });
  await assert.rejects(
    store.append(atomicStream, 0, [atomicAt, atomicOver]),
    assertDomainErrorCode("invalid_input")
  );
  assert.deepEqual(await collect(store.read(atomicStream)), []);
  const retried = await store.append(atomicStream, 0, [atomicAt]);
  assert.equal(retried[0]?.streamVersion, 1);
});
