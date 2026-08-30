import assert from "node:assert/strict";
import test from "node:test";

import {
  EventIdKind,
  RunIdKind,
  isDomainError,
  isGenericEventType,
  parseEventEnvelope,
  parseGenericEventEnvelope,
} from "@guard/contracts";
import type { EventEnvelope, JsonObject } from "@guard/contracts";

import {
  createInitialRunState,
  evolve,
  evolveRegistered,
  planEffects,
  planRegisteredEffects,
  replay,
  replayRegistered,
} from "./index.js";
import type {
  RegisteredEventEnvelopeFramer,
  RunState,
} from "./index.js";
import {
  GOLDEN_ACTOR,
  GOLDEN_HISTORY,
  GOLDEN_RUN_ID,
} from "./testdata/golden-history.js";

type PatchProducedEnvelope = EventEnvelope<
  "coding.PatchProduced",
  { readonly patchId: string }
>;

function extensionEnvelope(
  streamVersion = 4,
  overrides: Partial<PatchProducedEnvelope> = {}
): PatchProducedEnvelope {
  return {
    eventId: EventIdKind.generate(),
    eventType: "coding.PatchProduced",
    eventSchemaVersion: 1,
    occurredAt: "2026-08-30T10:00:04.000Z",
    actor: GOLDEN_ACTOR,
    correlationId: "correlation:registered-event-test",
    causationId: GOLDEN_HISTORY[2]?.eventId ?? null,
    payload: { patchId: "patch:one" },
    streamId: GOLDEN_RUN_ID,
    streamVersion,
    recordedAt: "2026-08-30T10:00:04.000Z",
    ...overrides,
  };
}

function strictRegisteredFramer(): RegisteredEventEnvelopeFramer {
  return Object.freeze({
    parseEnvelope(value: unknown): EventEnvelope<string, unknown> {
      const parsed = parseEventEnvelope(value);
      if (isGenericEventType(parsed.eventType)) {
        return parseGenericEventEnvelope(parsed);
      }
      if (
        parsed.eventType !== "coding.PatchProduced" ||
        parsed.eventSchemaVersion !== 1 ||
        !isExactPatchPayload(parsed.payload)
      ) {
        throw new TypeError("unregistered or malformed extension event");
      }
      return parseEventEnvelope(parsed);
    },
  });
}

function isExactPatchPayload(
  value: unknown
): value is { readonly patchId: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1
  ) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "patchId");
  return descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.enumerable === true &&
    typeof descriptor.value === "string";
}

function initializedState(): RunState {
  return replay(GOLDEN_HISTORY.slice(0, 3));
}

function assertInvalidInput(error: unknown): boolean {
  return isDomainError(error) && error.code === "invalid_input";
}

function assertInvariantViolation(error: unknown): boolean {
  return isDomainError(error) && error.code === "invariant_violated";
}

function assertSafeInvalidInput(canary: string) {
  return (error: unknown): boolean => {
    assert.equal(assertInvalidInput(error), true);
    assert.equal(JSON.stringify(error).includes(canary), false);
    return true;
  };
}

test("registered generic envelopes preserve the existing reducer and planner", () => {
  const framer = strictRegisteredFramer();
  const initial = createInitialRunState();
  const created = GOLDEN_HISTORY[0] ?? assert.fail("missing created event");

  assert.deepEqual(
    evolveRegistered(initial, created, framer),
    evolve(initial, created)
  );
  assert.deepEqual(
    planRegisteredEffects(initial, created, framer),
    planEffects(initial, created)
  );
  assert.deepEqual(
    replayRegistered(GOLDEN_HISTORY.slice(0, 3), framer),
    replay(GOLDEN_HISTORY.slice(0, 3))
  );
});

test("a parser-confirmed extension advances only the generic stream cursor", () => {
  const framer = strictRegisteredFramer();
  const before = initializedState();
  const extension = extensionEnvelope();

  assert.deepEqual(planRegisteredEffects(before, extension, framer), []);
  const after = evolveRegistered(before, extension, framer);

  assert.equal(after.runId, extension.streamId);
  assert.equal(after.streamVersion, 4);
  assert.equal(after.lastEventId, extension.eventId);
  assert.equal(after.lastRecordedAt, extension.recordedAt);
  assert.equal(after.budget.elapsedMs, 1_000);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.objective, before.objective);
  assert.deepEqual(after.taskProfile, before.taskProfile);
  assert.deepEqual(after.outstandingCommand, before.outstandingCommand);
  assert.equal(Object.isFrozen(after), true);
  assert.equal(Object.isFrozen(after.budget), true);
});

test("registered replay includes informational extension facts without effects", () => {
  const framer = strictRegisteredFramer();
  const history = [...GOLDEN_HISTORY.slice(0, 3), extensionEnvelope()];
  const state = replayRegistered(history, framer);
  assert.equal(state.status, "planning");
  assert.equal(state.streamVersion, 4);
  assert.equal(state.lastEventId, history[3]?.eventId);
});

test("unknown, wrong-version, and malformed extensions fail closed", () => {
  const state = initializedState();
  const framer = strictRegisteredFramer();
  const unknown = extensionEnvelope(4, { eventType: "coding.Unknown" as never });
  const wrongVersion = extensionEnvelope(4, { eventSchemaVersion: 2 as 1 });
  const malformed = extensionEnvelope(4, {
    payload: { patchId: 42 } as unknown as { readonly patchId: string },
  });

  for (const event of [unknown, wrongVersion, malformed]) {
    assert.throws(
      () => evolveRegistered(state, event, framer),
      assertInvalidInput
    );
    assert.throws(
      () => planRegisteredEffects(state, event, framer),
      assertInvalidInput
    );
  }
});

test("registered extensions cannot initialize or continue a terminal stream", () => {
  const framer = strictRegisteredFramer();
  assert.throws(
    () => evolveRegistered(createInitialRunState(), extensionEnvelope(1), framer),
    assertInvariantViolation
  );

  const terminal = replay(GOLDEN_HISTORY);
  assert.throws(
    () => evolveRegistered(
      terminal,
      extensionEnvelope(11, {
        causationId: terminal.lastEventId,
        occurredAt: "2026-08-30T10:00:11.000Z",
        recordedAt: "2026-08-30T10:00:11.000Z",
      }),
      framer
    ),
    assertInvariantViolation
  );
});

test("extension cursor checks remain gap-free, single-stream, and monotonic", () => {
  const state = initializedState();
  const framer = strictRegisteredFramer();
  assert.throws(
    () => evolveRegistered(state, extensionEnvelope(5), framer),
    assertInvariantViolation
  );
  assert.throws(
    () => evolveRegistered(state, extensionEnvelope(4, {
      streamId: RunIdKind.generate(),
    }), framer),
    assertInvariantViolation
  );
  assert.throws(
    () => evolveRegistered(state, extensionEnvelope(4, {
      recordedAt: "2026-08-30T09:59:59.000Z",
    }), framer),
    assertInvariantViolation
  );
});

test("runtime rejects permissive, non-detached, mutable, proxy, and accessor framers", () => {
  const state = initializedState();
  const event = extensionEnvelope();
  const canary = "REGISTERED-FRAMER-CANARY";
  let calls = 0;

  const nonDetached: RegisteredEventEnvelopeFramer = {
    parseEnvelope(value: unknown): EventEnvelope<string, unknown> {
      return value as EventEnvelope<string, unknown>;
    },
  };
  assert.throws(
    () => evolveRegistered(state, event, nonDetached),
    assertInvalidInput
  );

  const mutable: RegisteredEventEnvelopeFramer = {
    parseEnvelope(value: unknown): EventEnvelope<string, unknown> {
      const parsed = parseEventEnvelope(value);
      return { ...parsed, payload: { ...(parsed.payload as JsonObject) } };
    },
  };
  assert.throws(
    () => evolveRegistered(state, event, mutable),
    assertInvalidInput
  );

  const proxy = new Proxy(strictRegisteredFramer(), {
    get(): never {
      calls += 1;
      throw new Error(canary);
    },
    ownKeys(): never {
      calls += 1;
      throw new Error(canary);
    },
  });
  assert.throws(
    () => evolveRegistered(state, event, proxy),
    assertSafeInvalidInput(canary)
  );
  assert.equal(calls, 0);

  const accessor = {} as RegisteredEventEnvelopeFramer;
  Object.defineProperty(accessor, "parseEnvelope", {
    enumerable: true,
    get(): RegisteredEventEnvelopeFramer["parseEnvelope"] {
      calls += 1;
      throw new Error(canary);
    },
  });
  assert.throws(
    () => evolveRegistered(state, event, accessor),
    assertSafeInvalidInput(canary)
  );
  assert.equal(calls, 0);
});

test("framer exceptions and hostile event inputs map to safe invalid input", () => {
  const state = initializedState();
  const canary = "REGISTERED-EVENT-CANARY";
  let calls = 0;
  const throwing: RegisteredEventEnvelopeFramer = Object.freeze({
    parseEnvelope(): never {
      throw new Error(canary);
    },
  });
  assert.throws(
    () => evolveRegistered(state, extensionEnvelope(), throwing),
    assertSafeInvalidInput(canary)
  );

  const proxy = new Proxy(extensionEnvelope(), {
    get(): never {
      calls += 1;
      throw new Error(canary);
    },
    ownKeys(): never {
      calls += 1;
      throw new Error(canary);
    },
  });
  assert.throws(
    () => evolveRegistered(state, proxy, strictRegisteredFramer()),
    assertSafeInvalidInput(canary)
  );
  assert.equal(calls, 0);

  const accessor = { ...extensionEnvelope() };
  Object.defineProperty(accessor, "payload", {
    enumerable: true,
    get(): JsonObject {
      calls += 1;
      throw new Error(canary);
    },
  });
  assert.throws(
    () => evolveRegistered(state, accessor, strictRegisteredFramer()),
    assertSafeInvalidInput(canary)
  );
  assert.equal(calls, 0);
});
