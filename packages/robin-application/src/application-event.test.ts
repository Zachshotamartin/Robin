import assert from "node:assert/strict";
import test from "node:test";

import { isDomainError } from "@guard/contracts";
import {
  MAXIMUM_APPLICATION_EVENT_UTF8_BYTES,
  RobinSessionError,
} from "@guard/robin-session";

import { ApplicationEventJournal } from "./application-event.js";

function appendStarted(journal: ApplicationEventJournal): void {
  journal.append("SessionStarted", {
    permissionMode: "ask",
    persistence: "ephemeral",
    providerProfile: "synthetic",
  });
}

test("application journal appends parsed contiguous events and replays state", () => {
  let tick = 0;
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-test",
    clock: {
      now: () => `2026-08-30T00:00:0${tick++}.000Z`,
    },
  });
  appendStarted(journal);
  journal.append("UserMessageAccepted", {
    messageId: "message:1",
    text: "Inspect the fixture.",
    turnId: "turn:1",
  });
  journal.append("TurnStarted", {
    messageId: "message:1",
    turnId: "turn:1",
  });
  journal.append("AssistantTextDelta", {
    text: "Found it.",
    turnId: "turn:1",
  });
  journal.append("TurnCompleted", {
    text: "Found it.",
    turnId: "turn:1",
  });
  assert.deepEqual(
    journal.records.map((record) => record.sequence),
    [1, 2, 3, 4, 5],
  );
  assert.equal(journal.projection.status, "open");
  assert.equal(journal.projection.turns[0]?.status, "completed");
  assert.equal(journal.projection.turns[0]?.assistantText, "Found it.");
});

test("journal boundary escapes hostile text before storing or replaying it", () => {
  let tick = 0;
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-safe",
    clock: { now: () => `2026-08-30T00:01:0${tick++}.000Z` },
  });
  appendStarted(journal);
  const accepted = journal.append("UserMessageAccepted", {
    messageId: "message:1",
    text: "visible\u001b]52;secret\u0007",
    turnId: "turn:1",
  });
  assert.equal(accepted.payload.text.includes("\u001b"), false);
  assert.equal(accepted.payload.text, "visible\\u{1b}]52;secret\\u{07}");
});

test("transition-invalid append is rejected without mutating journal state", () => {
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-atomic",
    clock: { now: () => "2026-08-30T00:02:00.000Z" },
  });
  appendStarted(journal);
  assert.throws(
    () =>
      journal.append("TurnCompleted", {
        text: "Impossible.",
        turnId: "turn:missing",
      }),
    (error: unknown) =>
      error instanceof RobinSessionError && error.code === "illegal_transition",
  );
  assert.equal(journal.records.length, 1);
  assert.equal(journal.projection.lastSequence, 1);
});

test("session-wide subscriptions replay a prefix, follow live order, and close", async () => {
  let tick = 0;
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-subscription",
    clock: { now: () => `2026-08-30T00:03:0${tick++}.000Z` },
  });
  appendStarted(journal);
  const source = journal.subscribe(1);
  const collected = (async () => {
    const records = [];
    for await (const record of source) records.push(record);
    return records;
  })();
  journal.append("PermissionModeChanged", { permissionMode: "plan" });
  journal.append("SessionClosed", { reason: "user" });
  const records = await collected;
  assert.deepEqual(
    records.map((record) => [record.sequence, record.type]),
    [
      [2, "PermissionModeChanged"],
      [3, "SessionClosed"],
    ],
  );

  const replayed = [];
  for await (const record of journal.subscribe(0)) replayed.push(record.type);
  assert.deepEqual(replayed, [
    "SessionStarted",
    "PermissionModeChanged",
    "SessionClosed",
  ]);
});

test("historical replay is lazy beyond live backlog caps and remains replay-then-live", async () => {
  let tick = 0;
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-lazy-replay",
    clock: { now: () => `2026-08-30T00:04:${String(tick++).padStart(2, "0")}.000Z` },
    limits: {
      maximumSubscriberBacklogEvents: 1,
      maximumSubscriberBacklogBytes: 1_048_576,
    },
  });
  appendStarted(journal);
  for (let index = 0; index < 12; index += 1) {
    journal.append("PermissionModeChanged", {
      permissionMode: index % 2 === 0 ? "plan" : "ask",
    });
  }

  const iterator = journal.subscribe(0)[Symbol.asyncIterator]();
  const replaySequences: number[] = [];
  for (let index = 0; index < 13; index += 1) {
    const result = await iterator.next();
    assert.equal(result.done, false);
    if (!result.done) replaySequences.push(result.value.sequence);
  }
  assert.deepEqual(
    replaySequences,
    Array.from({ length: 13 }, (_, index) => index + 1),
  );

  journal.append("PermissionModeChanged", { permissionMode: "plan" });
  assert.equal((await iterator.next()).value?.sequence, 14);
  journal.append("SessionClosed", { reason: "user" });
  assert.equal((await iterator.next()).value?.sequence, 15);
  assert.equal((await iterator.next()).done, true);
});

test("slow subscribers fail and detach when unread live event backlog overflows", async () => {
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-slow-events",
    clock: { now: () => "2026-08-30T00:05:00.000Z" },
    limits: {
      maximumSubscribers: 1,
      maximumSubscriberBacklogEvents: 1,
      maximumSubscriberBacklogBytes: 1_048_576,
    },
  });
  appendStarted(journal);
  const slow = journal.subscribe(1)[Symbol.asyncIterator]();
  journal.append("PermissionModeChanged", { permissionMode: "plan" });
  journal.append("PermissionModeChanged", { permissionMode: "ask" });

  await assert.rejects(
    slow.next(),
    (error: unknown) =>
      isDomainError(error) &&
      error.code === "budget_exceeded" &&
      error.details?.["dimension"] === "subscriber_events",
  );
  const replacement = journal.subscribe(3)[Symbol.asyncIterator]();
  await replacement.return?.();
});

test("subscriber byte backlog has an independent fail-closed bound", async () => {
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-slow-bytes",
    clock: { now: () => "2026-08-30T00:06:00.000Z" },
    limits: {
      maximumSubscriberBacklogEvents: 8,
      maximumSubscriberBacklogBytes: 1,
    },
  });
  appendStarted(journal);
  const slow = journal.subscribe(1)[Symbol.asyncIterator]();
  journal.append("PermissionModeChanged", { permissionMode: "plan" });
  await assert.rejects(
    slow.next(),
    (error: unknown) =>
      isDomainError(error) &&
      error.details?.["dimension"] === "subscriber_bytes",
  );
});

test("subscriber pending reads are bounded and all waiters reject on overflow", async () => {
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-pending-reads",
    clock: { now: () => "2026-08-30T00:06:30.000Z" },
    limits: { maximumSubscriberBacklogEvents: 1 },
  });
  appendStarted(journal);
  const iterator = journal.subscribe(1)[Symbol.asyncIterator]();
  const first = iterator.next().then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  const second = iterator.next().then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );

  for (const outcome of [await first, await second]) {
    assert.equal(isDomainError(outcome.error), true);
    if (isDomainError(outcome.error)) {
      assert.equal(outcome.error.details?.["dimension"], "subscriber_reads");
    }
  }
});

test("subscriber count is bounded and return discards replay and detaches", async () => {
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-return",
    clock: { now: () => "2026-08-30T00:07:00.000Z" },
    limits: { maximumSubscribers: 1 },
  });
  appendStarted(journal);
  const first = journal.subscribe(0)[Symbol.asyncIterator]();
  assert.throws(
    () => journal.subscribe(0),
    (error: unknown) =>
      isDomainError(error) &&
      error.details?.["dimension"] === "subscribers",
  );

  assert.deepEqual(await first.return?.(), { done: true, value: undefined });
  assert.deepEqual(await first.next(), { done: true, value: undefined });
  const replacement = journal.subscribe(0)[Symbol.asyncIterator]();
  await replacement.return?.();
});

test("record exhaustion rejects nonterminal growth while preserving SessionClosed headroom", () => {
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-record-headroom",
    clock: { now: () => "2026-08-30T00:08:00.000Z" },
    limits: { maximumRecords: 3 },
  });
  appendStarted(journal);
  journal.append("PermissionModeChanged", { permissionMode: "plan" });
  assert.throws(
    () => journal.append("PermissionModeChanged", { permissionMode: "ask" }),
    (error: unknown) =>
      isDomainError(error) && error.code === "budget_exceeded",
  );
  assert.equal(journal.records.length, 2);
  assert.equal(journal.projection.permissionMode, "plan");
  journal.append("SessionClosed", { reason: "shutdown" });
  assert.equal(journal.projection.status, "closed");
});

test("byte exhaustion preserves worst-case SessionClosed headroom", () => {
  const probe = new ApplicationEventJournal({
    sessionId: "session:r1-byte-headroom",
    clock: { now: () => "2026-08-30T00:09:00.000Z" },
  });
  appendStarted(probe);
  const startedBytes = Buffer.byteLength(
    JSON.stringify(probe.records[0]),
    "utf8",
  );
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-byte-headroom",
    clock: { now: () => "2026-08-30T00:09:00.000Z" },
    limits: {
      maximumBytes: startedBytes + MAXIMUM_APPLICATION_EVENT_UTF8_BYTES,
    },
  });
  appendStarted(journal);
  assert.throws(
    () => journal.append("PermissionModeChanged", { permissionMode: "plan" }),
    (error: unknown) =>
      isDomainError(error) && error.code === "budget_exceeded",
  );
  journal.append("SessionClosed", { reason: "user" });
  assert.equal(journal.projection.status, "closed");
});

test("faulted journals reject immediately without replay and return becomes done", async () => {
  const journal = new ApplicationEventJournal({
    sessionId: "session:r1-fail-closed",
    clock: { now: () => "2026-08-30T00:10:00.000Z" },
  });
  appendStarted(journal);
  const marker = new Error("terminal append failed");
  const existing = journal.subscribe(0)[Symbol.asyncIterator]();
  journal.fail(marker);

  await assert.rejects(existing.next(), (error: unknown) => error === marker);
  await existing.return?.();
  assert.deepEqual(await existing.next(), { done: true, value: undefined });
  const future = journal.subscribe(0)[Symbol.asyncIterator]();
  await assert.rejects(future.next(), (error: unknown) => error === marker);
});
