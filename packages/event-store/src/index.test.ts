import assert from "node:assert/strict";
import test from "node:test";

import {
  EventIdKind,
  RunIdKind,
  isDomainError,
} from "@guard/contracts";
import type {
  EventEnvelope,
  JsonObject,
  NewEvent,
  RunId,
} from "@guard/contracts";

import { InMemoryEventStore } from "./index.js";

const FIRST_RECORDED_AT = "2026-08-30T08:00:00.000Z";
const SECOND_RECORDED_AT = "2026-08-30T08:00:01.000Z";

function makeEvent<TPayload extends JsonObject>(
  payload: TPayload,
  eventType = "TestEvent"
): NewEvent<string, TPayload> {
  return {
    eventId: EventIdKind.generate(),
    eventType,
    eventSchemaVersion: 1,
    occurredAt: "2026-08-30T07:59:59.000Z",
    actor: { kind: "runtime", id: "runtime:test" },
    correlationId: "correlation:test",
    causationId: null,
    payload,
  };
}

async function collect(
  events: AsyncIterable<EventEnvelope>
): Promise<readonly EventEnvelope[]> {
  const collected: EventEnvelope[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function assertDomainErrorCode(code: "conflict" | "invalid_input") {
  return (error: unknown): boolean =>
    isDomainError(error) && error.code === code;
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
    (await collect(store.read(streamId))).map(({ payload }) => payload),
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
  assert.deepEqual(envelope.payload, {
    labels: ["original"],
    nested: { count: 1 },
  });
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.actor), true);
  assert.equal(Object.isFrozen(envelope.payload), true);
  assert.equal(
    Object.isFrozen((envelope.payload as { nested: object }).nested),
    true
  );
  assert.equal(
    Object.isFrozen((envelope.payload as { labels: readonly string[] }).labels),
    true
  );
  assert.throws(() => {
    (envelope.payload as { nested: { count: number } }).nested.count = 5;
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
  } as unknown as NewEvent;

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
  } as unknown as NewEvent;

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
