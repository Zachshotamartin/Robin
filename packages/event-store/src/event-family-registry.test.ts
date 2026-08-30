import assert from "node:assert/strict";
import test from "node:test";

import {
  EventIdKind,
  GENERIC_EVENT_TYPES,
  RunIdKind,
  createDomainError,
  isDomainError,
  parseEventEnvelope,
  parseGenericEvent,
  parseGenericEventEnvelope,
  parseNewEvent,
} from "@guard/contracts";
import type {
  EventEnvelope,
  GenericEvent,
  JsonObject,
  NewEvent,
} from "@guard/contracts";

import {
  EventFamilyRegistry,
  GENERIC_EVENT_FAMILY_ID,
  InMemoryEventStore,
} from "./index.js";
import type {
  EventFamilyRegistration,
  EventStoreParser,
  RegisteredEvent,
} from "./index.js";

const RECORDED_AT = "2026-08-30T12:00:01.000Z";

type PatchProduced = NewEvent<
  "coding.PatchProduced",
  { readonly patchId: string }
>;
type PatchProducedEnvelope = EventEnvelope<
  "coding.PatchProduced",
  { readonly patchId: string }
>;

function patchEvent(): PatchProduced {
  return {
    eventId: EventIdKind.generate(),
    eventType: "coding.PatchProduced",
    eventSchemaVersion: 1,
    occurredAt: "2026-08-30T12:00:00.000Z",
    actor: { kind: "runtime", id: "runtime:event-family-test" },
    correlationId: "correlation:event-family-test",
    causationId: null,
    payload: { patchId: "patch:one" },
  };
}

function genericEvent(): Extract<
  GenericEvent,
  { readonly eventType: "RunIntentAppended" }
> {
  return {
    eventId: EventIdKind.generate(),
    eventType: "RunIntentAppended",
    eventSchemaVersion: 1,
    occurredAt: "2026-08-30T12:00:00.000Z",
    actor: { kind: "runtime", id: "runtime:event-family-test" },
    correlationId: "correlation:event-family-test",
    causationId: null,
    payload: {
      intentType: "event-family.test",
      intentVersion: 1,
      payload: {},
      submittedBy: { kind: "user", id: "user:event-family-test" },
    },
  };
}

function assertPatchPayload(
  payload: unknown
): asserts payload is { readonly patchId: string } {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    Reflect.ownKeys(payload).length !== 1 ||
    typeof (payload as { readonly patchId?: unknown }).patchId !== "string"
  ) {
    throw createDomainError({
      code: "invalid_input",
      message: "Invalid coding.PatchProduced payload.",
    });
  }
}

const PATCH_PARSER: EventStoreParser<PatchProduced> = Object.freeze({
  parseEvent(value: unknown): PatchProduced {
    const parsed = parseNewEvent(value);
    if (parsed.eventType !== "coding.PatchProduced") {
      throw createDomainError({
        code: "invalid_input",
        message: "Expected coding.PatchProduced.",
      });
    }
    assertPatchPayload(parsed.payload);
    return parsed as PatchProduced;
  },
  parseEnvelope(value: unknown): PatchProducedEnvelope {
    const parsed = parseEventEnvelope(value);
    if (parsed.eventType !== "coding.PatchProduced") {
      throw createDomainError({
        code: "invalid_input",
        message: "Expected coding.PatchProduced envelope.",
      });
    }
    assertPatchPayload(parsed.payload);
    return parsed as PatchProducedEnvelope;
  },
});

function patchRegistration(
  overrides: Partial<EventFamilyRegistration<PatchProduced>> = {}
): EventFamilyRegistration<PatchProduced> {
  return {
    familyId: "coding",
    familyVersion: 1,
    eventSchemaVersion: 1,
    eventTypes: ["coding.PatchProduced"],
    parser: PATCH_PARSER,
    ...overrides,
  };
}

function envelope<TEvent extends NewEvent<string, unknown>>(
  event: TEvent,
  streamVersion = 1
): EventEnvelope<TEvent["eventType"], TEvent["payload"]> {
  return {
    ...event,
    streamId: RunIdKind.generate(),
    streamVersion,
    recordedAt: RECORDED_AT,
  };
}

function assertInvalidInput(error: unknown): boolean {
  return isDomainError(error) && error.code === "invalid_input";
}

function assertSafeInvalidInput(canary: string) {
  return (error: unknown): boolean => {
    assert.equal(assertInvalidInput(error), true);
    assert.equal(JSON.stringify(error).includes(canary), false);
    return true;
  };
}

test("the immutable registry always contains the strict generic family", () => {
  const registry = new EventFamilyRegistry();
  const proposed = genericEvent();
  const recorded = envelope(proposed);

  assert.equal(registry.hasFamily(GENERIC_EVENT_FAMILY_ID), true);
  assert.equal(registry.hasEventType("RunCreated"), true);
  assert.deepEqual(registry.familyFor("RunCreated"), {
    familyId: "generic",
    familyVersion: 1,
    eventSchemaVersion: 1,
    eventTypes: GENERIC_EVENT_TYPES,
  });
  assert.deepEqual(registry.parseEvent(proposed), parseGenericEvent(proposed));
  assert.deepEqual(
    registry.parseEnvelope(recorded),
    parseGenericEventEnvelope(recorded)
  );
  assert.equal(Object.isFrozen(registry.parseEnvelope(recorded)), true);
  assert.equal(
    Object.isFrozen(registry.parseEnvelope(recorded).payload),
    true
  );
});

test("a registered namespaced family parses and stores exact extension facts", async () => {
  const registry = new EventFamilyRegistry([patchRegistration()]);
  const proposed = patchEvent();
  const parsed = registry.parseEvent(proposed);
  assert.deepEqual(parsed, proposed);
  assert.notStrictEqual(parsed, proposed);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.payload), true);

  const store = new InMemoryEventStore<RegisteredEvent<PatchProduced>>({
    now: () => RECORDED_AT,
    parser: registry,
  });
  const streamId = RunIdKind.generate();
  const appended = await store.append(streamId, 0, [proposed]);
  assert.equal(appended[0]?.eventType, "coding.PatchProduced");
  assert.deepEqual(appended[0]?.payload, { patchId: "patch:one" });
});

test("unknown, malformed, and wrong-version extension events fail closed", () => {
  const registry = new EventFamilyRegistry([patchRegistration()]);
  const unknown = { ...patchEvent(), eventType: "coding.UnknownFact" };
  const wrongVersion = { ...patchEvent(), eventSchemaVersion: 2 };
  const malformed = { ...patchEvent(), payload: { patchId: 9 } };

  assert.throws(() => registry.parseEvent(unknown), assertInvalidInput);
  assert.throws(() => registry.parseEvent(wrongVersion), assertInvalidInput);
  assert.throws(() => registry.parseEvent(malformed), assertInvalidInput);
  assert.throws(
    () => registry.parseEnvelope(envelope(unknown)),
    assertInvalidInput
  );
});

test("registrations reject duplicate families, duplicate event names, and generic shadowing", () => {
  assert.throws(
    () => new EventFamilyRegistry([patchRegistration(), patchRegistration()]),
    assertInvalidInput
  );
  assert.throws(
    () => new EventFamilyRegistry([patchRegistration({
      eventTypes: ["coding.PatchProduced", "coding.PatchProduced"],
    })]),
    assertInvalidInput
  );
  assert.throws(
    () => new EventFamilyRegistry([patchRegistration({
      familyId: "generic",
      eventTypes: ["generic.CustomFact"] as never,
    })]),
    assertInvalidInput
  );
  assert.throws(
    () => new EventFamilyRegistry([patchRegistration({
      eventTypes: [GENERIC_EVENT_TYPES[0]] as never,
    })]),
    assertInvalidInput
  );
  assert.throws(
    () => new EventFamilyRegistry([patchRegistration({
      eventTypes: ["other.PatchProduced"] as never,
    })]),
    assertInvalidInput
  );
  assert.throws(
    () => new EventFamilyRegistry([patchRegistration({
      eventTypes: ["coding.Zeta", "coding.Alpha"] as never,
    })]),
    assertInvalidInput
  );
  assert.throws(
    () => new EventFamilyRegistry().familyFor("coding.Unknown"),
    assertInvalidInput
  );
});

test("registrations reject malformed schemas and decorated records", () => {
  assert.throws(
    () => new EventFamilyRegistry([patchRegistration({
      eventSchemaVersion: 2 as 1,
    })]),
    assertInvalidInput
  );
  assert.throws(
    () => new EventFamilyRegistry([patchRegistration({
      familyVersion: 0,
    })]),
    assertInvalidInput
  );
  assert.throws(
    () => new EventFamilyRegistry([patchRegistration({
      familyId: "Coding",
    })]),
    assertInvalidInput
  );
  const decorated = patchRegistration() as EventFamilyRegistration<PatchProduced> & {
    unexpected?: boolean;
  };
  decorated.unexpected = true;
  assert.throws(
    () => new EventFamilyRegistry([decorated]),
    assertInvalidInput
  );
});

test("proxy and accessor registrations fail without invoking caller code", () => {
  const canary = "REGISTRY-CONSTRUCTION-CANARY";
  let calls = 0;
  const traps = {
    ownKeys(): never {
      calls += 1;
      throw new Error(canary);
    },
    get(): never {
      calls += 1;
      throw new Error(canary);
    },
  };
  const proxied = new Proxy(patchRegistration(), traps);
  assert.throws(
    () => new EventFamilyRegistry([proxied]),
    assertSafeInvalidInput(canary)
  );
  assert.equal(calls, 0);

  const accessor = { ...patchRegistration() };
  Object.defineProperty(accessor, "eventTypes", {
    enumerable: true,
    get(): readonly string[] {
      calls += 1;
      throw new Error(canary);
    },
  });
  assert.throws(
    () => new EventFamilyRegistry([accessor]),
    assertSafeInvalidInput(canary)
  );
  assert.equal(calls, 0);
});

test("proxy and accessor envelopes fail before traps or registered parsers run", () => {
  let parserCalls = 0;
  const registry = new EventFamilyRegistry([patchRegistration({
    parser: {
      parseEvent(value: unknown): PatchProduced {
        parserCalls += 1;
        return PATCH_PARSER.parseEvent(value);
      },
      parseEnvelope(value: unknown): PatchProducedEnvelope {
        parserCalls += 1;
        return PATCH_PARSER.parseEnvelope(value);
      },
    },
  })]);
  const canary = "REGISTRY-INPUT-CANARY";
  let calls = 0;
  const proxy = new Proxy(envelope(patchEvent()), {
    ownKeys(): never {
      calls += 1;
      throw new Error(canary);
    },
    get(): never {
      calls += 1;
      throw new Error(canary);
    },
  });
  assert.throws(
    () => registry.parseEnvelope(proxy),
    assertSafeInvalidInput(canary)
  );
  assert.equal(calls, 0);
  assert.equal(parserCalls, 0);

  const accessor = { ...envelope(patchEvent()) };
  Object.defineProperty(accessor, "payload", {
    enumerable: true,
    get(): JsonObject {
      calls += 1;
      throw new Error(canary);
    },
  });
  assert.throws(
    () => registry.parseEnvelope(accessor),
    assertSafeInvalidInput(canary)
  );
  assert.equal(calls, 0);
  assert.equal(parserCalls, 0);
});

test("registered parsers cannot transform exact event or envelope content", () => {
  const transformed: EventStoreParser<PatchProduced> = {
    parseEvent(value: unknown): PatchProduced {
      const parsed = PATCH_PARSER.parseEvent(value);
      return { ...parsed, payload: { patchId: "patch:other" } };
    },
    parseEnvelope(value: unknown): PatchProducedEnvelope {
      const parsed = PATCH_PARSER.parseEnvelope(value);
      return { ...parsed, payload: { patchId: "patch:other" } };
    },
  };
  const registry = new EventFamilyRegistry([patchRegistration({
    parser: transformed,
  })]);
  assert.throws(() => registry.parseEvent(patchEvent()), assertInvalidInput);
  assert.throws(
    () => registry.parseEnvelope(envelope(patchEvent())),
    assertInvalidInput
  );
});

test("registered parsers must detach while registry outputs are deeply frozen", () => {
  const aliasing: EventStoreParser<PatchProduced> = {
    parseEvent(value: unknown): PatchProduced {
      return value as PatchProduced;
    },
    parseEnvelope(value: unknown): PatchProducedEnvelope {
      return value as PatchProducedEnvelope;
    },
  };
  const aliasingRegistry = new EventFamilyRegistry([patchRegistration({
    parser: aliasing,
  })]);
  assert.throws(
    () => aliasingRegistry.parseEvent(patchEvent()),
    assertInvalidInput
  );
  assert.throws(
    () => aliasingRegistry.parseEnvelope(envelope(patchEvent())),
    assertInvalidInput
  );

  const detachedMutable: EventStoreParser<PatchProduced> = {
    parseEvent(value: unknown): PatchProduced {
      return JSON.parse(JSON.stringify(value)) as PatchProduced;
    },
    parseEnvelope(value: unknown): PatchProducedEnvelope {
      return JSON.parse(JSON.stringify(value)) as PatchProducedEnvelope;
    },
  };
  const detachedRegistry = new EventFamilyRegistry([patchRegistration({
    parser: detachedMutable,
  })]);
  const parsed = detachedRegistry.parseEnvelope(envelope(patchEvent()));
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.actor), true);
  assert.equal(Object.isFrozen(parsed.payload), true);
});
