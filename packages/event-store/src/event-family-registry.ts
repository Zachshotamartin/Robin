import { isProxy } from "node:util/types";

import {
  GENERIC_EVENT_TYPES,
  canonicalize,
  createDomainError,
  parseEventEnvelope,
  parseGenericEvent,
  parseGenericEventEnvelope,
  parseNewEvent,
} from "@guard/contracts";
import type {
  ContractSchemaVersion,
  DomainError,
  EventEnvelope,
  GenericEvent,
  NewEvent,
} from "@guard/contracts";

import type { EnvelopeOf, EventStoreParser } from "./event-store.js";

export const GENERIC_EVENT_FAMILY_ID = "generic" as const;

export type RegisteredEvent<
  TExtension extends NewEvent<string, unknown> = never
> = GenericEvent | TExtension;
export type RegisteredEventEnvelope<
  TExtension extends NewEvent<string, unknown> = never
> = EnvelopeOf<RegisteredEvent<TExtension>>;

/**
 * One immutable event-family installation. Every extension event type must be
 * an exact `${familyId}.UpperCamelName` and every parsed fact must carry the
 * installed schema version.
 */
export interface EventFamilyRegistration<
  TEvent extends NewEvent<string, unknown> = NewEvent<string, unknown>
> {
  readonly familyId: string;
  readonly familyVersion: number;
  readonly eventSchemaVersion: ContractSchemaVersion;
  readonly eventTypes: readonly TEvent["eventType"][];
  readonly parser: EventStoreParser<TEvent>;
}

export interface RegisteredEventFamilyDescriptor {
  readonly familyId: string;
  readonly familyVersion: number;
  readonly eventSchemaVersion: ContractSchemaVersion;
  readonly eventTypes: readonly string[];
}

interface InstalledFamily {
  readonly familyId: string;
  readonly familyVersion: number;
  readonly eventSchemaVersion: ContractSchemaVersion;
  readonly eventTypes: ReadonlySet<string>;
  readonly descriptor: RegisteredEventFamilyDescriptor;
  readonly parser: EventStoreParser<NewEvent<string, unknown>>;
}

const REGISTRATION_KEYS = new Set([
  "familyId",
  "familyVersion",
  "eventSchemaVersion",
  "eventTypes",
  "parser",
]);
const PARSER_KEYS = new Set(["parseEvent", "parseEnvelope"]);
const MAXIMUM_EXTENSION_FAMILIES = 100;
const MAXIMUM_EVENTS_PER_FAMILY = 1_000;
const FAMILY_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const EVENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/u;
const GENERIC_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  GENERIC_EVENT_TYPES
);

const GENERIC_FAMILY: InstalledFamily = Object.freeze({
  familyId: GENERIC_EVENT_FAMILY_ID,
  familyVersion: 1,
  eventSchemaVersion: 1,
  eventTypes: GENERIC_EVENT_TYPE_SET,
  descriptor: Object.freeze({
    familyId: GENERIC_EVENT_FAMILY_ID,
    familyVersion: 1,
    eventSchemaVersion: 1,
    eventTypes: Object.freeze([...GENERIC_EVENT_TYPES]),
  }),
  parser: Object.freeze({
    parseEvent: parseGenericEvent,
    parseEnvelope: parseGenericEventEnvelope,
  }),
});

/**
 * Strict dispatch for the one mandatory generic family plus explicitly
 * installed namespaced families. The registry is closed after construction;
 * unknown event types can never fall through to a permissive framing parser.
 */
export class EventFamilyRegistry<
  TExtension extends NewEvent<string, unknown> = never
> implements EventStoreParser<RegisteredEvent<TExtension>> {
  readonly #families: ReadonlyMap<string, InstalledFamily>;
  readonly #events: ReadonlyMap<string, InstalledFamily>;

  public constructor(
    registrations: readonly EventFamilyRegistration<TExtension>[] = []
  ) {
    const proposed = inspectDenseArray(
      registrations,
      MAXIMUM_EXTENSION_FAMILIES,
      "event-family registrations"
    );
    const families = new Map<string, InstalledFamily>([
      [GENERIC_EVENT_FAMILY_ID, GENERIC_FAMILY],
    ]);
    const events = new Map<string, InstalledFamily>(
      GENERIC_EVENT_TYPES.map((eventType) => [eventType, GENERIC_FAMILY])
    );

    for (const value of proposed) {
      const installed = parseRegistration(value);
      if (families.has(installed.familyId)) {
        throw invalidInput("An event family identifier may be registered only once.");
      }
      for (const eventType of installed.eventTypes) {
        if (events.has(eventType)) {
          throw invalidInput("An event type may be registered only once.");
        }
      }
      families.set(installed.familyId, installed);
      for (const eventType of installed.eventTypes) {
        events.set(eventType, installed);
      }
    }

    this.#families = families;
    this.#events = events;
    Object.freeze(this);
  }

  /** Arrow fields remain safe when supplied structurally as store parsers. */
  public readonly parseEvent = (value: unknown): RegisteredEvent<TExtension> =>
    this.#parse(value, false) as RegisteredEvent<TExtension>;

  public readonly parseEnvelope = (
    value: unknown
  ): RegisteredEventEnvelope<TExtension> =>
    this.#parse(value, true) as RegisteredEventEnvelope<TExtension>;

  public hasFamily(familyId: unknown): boolean {
    return typeof familyId === "string" && this.#families.has(familyId);
  }

  public hasEventType(eventType: unknown): boolean {
    return typeof eventType === "string" && this.#events.has(eventType);
  }

  public familyFor(eventType: unknown): RegisteredEventFamilyDescriptor {
    if (typeof eventType !== "string") {
      throw invalidInput("An event-family lookup requires an exact event type.");
    }
    const family = this.#events.get(eventType);
    if (family === undefined) {
      throw invalidInput("The event type is not registered.");
    }
    return family.descriptor;
  }

  #parse(
    value: unknown,
    envelope: boolean
  ): NewEvent<string, unknown> | EventEnvelope<string, unknown> {
    try {
      const framedInput = envelope
        ? parseEventEnvelope(value)
        : parseNewEvent(value);
      const family = this.#events.get(framedInput.eventType);
      if (
        family === undefined ||
        framedInput.eventSchemaVersion !== family.eventSchemaVersion
      ) {
        throw new TypeError("unregistered event framing");
      }

      const configured = envelope
        ? family.parser.parseEnvelope(framedInput)
        : family.parser.parseEvent(framedInput);
      const framedOutput = envelope
        ? parseEventEnvelope(configured)
        : parseNewEvent(configured);
      if (
        sharesObjectIdentity(framedInput, configured) ||
        framedOutput.eventType !== framedInput.eventType ||
        framedOutput.eventSchemaVersion !== family.eventSchemaVersion ||
        canonicalize(framedOutput) !== canonicalize(framedInput)
      ) {
        throw new TypeError("event parser changed framing");
      }
      return framedOutput;
    } catch {
      throw invalidInput(
        envelope
          ? "The event family registry rejected an event envelope."
          : "The event family registry rejected a new event."
      );
    }
  }
}

function sharesObjectIdentity(left: unknown, right: unknown): boolean {
  try {
    const leftObjects = collectDataObjects(left);
    const pending: unknown[] = [right];
    const visited = new WeakSet<object>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current !== "object" || current === null) continue;
      if (isProxy(current) || leftObjects.has(current)) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const key of Reflect.ownKeys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError("non-data parser result");
        }
        pending.push(descriptor.value);
      }
    }
    return false;
  } catch {
    return true;
  }
}

function collectDataObjects(value: unknown): WeakSet<object> {
  const result = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) continue;
    if (isProxy(current) || result.has(current)) {
      throw new TypeError("hostile parser input");
    }
    result.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("non-data parser input");
      }
      pending.push(descriptor.value);
    }
  }
  return result;
}

function parseRegistration(value: unknown): InstalledFamily {
  try {
    const registration = inspectDataRecord(value, REGISTRATION_KEYS);
    const familyId = registration["familyId"];
    const familyVersion = registration["familyVersion"];
    const eventSchemaVersion = registration["eventSchemaVersion"];
    const parserValue = registration["parser"];
    if (
      typeof familyId !== "string" ||
      familyId.length > 128 ||
      !FAMILY_ID_PATTERN.test(familyId) ||
      familyId === GENERIC_EVENT_FAMILY_ID ||
      typeof familyVersion !== "number" ||
      !Number.isSafeInteger(familyVersion) ||
      familyVersion <= 0 ||
      eventSchemaVersion !== 1
    ) {
      throw new TypeError("invalid family identity");
    }

    const eventValues = inspectDenseArray(
      registration["eventTypes"],
      MAXIMUM_EVENTS_PER_FAMILY,
      "event types"
    );
    if (eventValues.length === 0) {
      throw new TypeError("empty family");
    }
    const eventTypes = new Set<string>();
    let previousEventType: string | null = null;
    for (const eventType of eventValues) {
      if (
        typeof eventType !== "string" ||
        eventType.length > 256 ||
        GENERIC_EVENT_TYPE_SET.has(eventType) ||
        !eventType.startsWith(`${familyId}.`) ||
        !EVENT_NAME_PATTERN.test(eventType.slice(familyId.length + 1)) ||
        eventTypes.has(eventType)
      ) {
        throw new TypeError("invalid extension event type");
      }
      if (
        previousEventType !== null &&
        compareUtf8(previousEventType, eventType) >= 0
      ) {
        throw new TypeError("extension event types are not strictly ordered");
      }
      previousEventType = eventType;
      eventTypes.add(eventType);
    }
    const descriptor: RegisteredEventFamilyDescriptor = Object.freeze({
      familyId,
      familyVersion,
      eventSchemaVersion,
      eventTypes: Object.freeze([...eventTypes]),
    });

    const parserRecord = inspectDataRecord(parserValue, PARSER_KEYS);
    const parseEvent = parserRecord["parseEvent"];
    const parseEnvelope = parserRecord["parseEnvelope"];
    if (
      typeof parseEvent !== "function" ||
      typeof parseEnvelope !== "function" ||
      isProxy(parseEvent) ||
      isProxy(parseEnvelope)
    ) {
      throw new TypeError("invalid family parser");
    }

    return Object.freeze({
      familyId,
      familyVersion,
      eventSchemaVersion,
      eventTypes,
      descriptor,
      parser: Object.freeze({
        parseEvent: parseEvent as EventStoreParser<
          NewEvent<string, unknown>
        >["parseEvent"],
        parseEnvelope: parseEnvelope as EventStoreParser<
          NewEvent<string, unknown>
        >["parseEnvelope"],
      }),
    });
  } catch {
    throw invalidInput("Invalid event-family registration.");
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function inspectDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value)
  ) {
    throw new TypeError("invalid data record");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("invalid data record prototype");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== allowedKeys.size ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))
  ) {
    throw new TypeError("invalid data record keys");
  }

  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new TypeError("invalid data record key");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError("invalid data property");
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(result);
}

function inspectDenseArray(
  value: unknown,
  maximumLength: number,
  label: string
): readonly unknown[] {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      throw new TypeError("invalid array");
    }
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      length === undefined ||
      !("value" in length) ||
      typeof length.value !== "number" ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > maximumLength
    ) {
      throw new TypeError("invalid array length");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length.value + 1 ||
      keys.some((key) => typeof key !== "string")
    ) {
      throw new TypeError("invalid dense array keys");
    }
    const result: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("invalid array item");
      }
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    throw invalidInput(`Invalid ${label}.`);
  }
}

function invalidInput(message: string): DomainError {
  return createDomainError({ code: "invalid_input", message });
}
