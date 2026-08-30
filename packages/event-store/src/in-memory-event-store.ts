import { isProxy } from "node:util/types";

import {
  RunIdKind,
  canonicalBytes,
  canonicalize,
  createDomainError,
  parseEventEnvelope,
  parseGenericEvent,
  parseGenericEventEnvelope,
  parseNewEvent,
} from "@guard/contracts";
import type {
  DomainError,
  GenericEvent,
  NewEvent,
  RunId,
} from "@guard/contracts";

import type {
  EnvelopeOf,
  EventStore,
  EventStoreParser,
} from "./event-store.js";

type StorableEvent = NewEvent<string, unknown>;

export const DEFAULT_MAXIMUM_BATCH_EVENTS = 100;
export const DEFAULT_MAXIMUM_EVENT_BYTES = 1_048_576;

interface InMemoryEventStoreBaseOptions {
  /** Invoked exactly once after conflict and event validation succeed. */
  readonly now?: () => string;
  readonly maximumBatchEvents?: number;
  /** Maximum canonical UTF-8 bytes for one completed event envelope. */
  readonly maximumEventBytes?: number;
}

type IsExactlyGenericEvent<TEvent extends StorableEvent> =
  [TEvent] extends [GenericEvent]
    ? [GenericEvent] extends [TEvent]
      ? true
      : false
    : false;

/** Non-generic event families must explicitly supply their strict parsers. */
export type InMemoryEventStoreOptions<
  TEvent extends StorableEvent = GenericEvent
> = InMemoryEventStoreBaseOptions &
  (IsExactlyGenericEvent<TEvent> extends true
    ? { readonly parser?: EventStoreParser<TEvent> }
    : { readonly parser: EventStoreParser<TEvent> });

interface ParsedOptions<TEvent extends StorableEvent> {
  readonly now: () => unknown;
  readonly parser: EventStoreParser<TEvent> | null;
  readonly maximumBatchEvents: number;
  readonly maximumEventBytes: number;
}

const defaultNow = (): string => new Date().toISOString();

const GENERIC_EVENT_PARSER: EventStoreParser<GenericEvent> = Object.freeze({
  parseEvent: parseGenericEvent,
  parseEnvelope: parseGenericEventEnvelope,
});

const OPTION_KEYS = new Set([
  "now",
  "parser",
  "maximumBatchEvents",
  "maximumEventBytes",
]);
const PARSER_KEYS = new Set(["parseEvent", "parseEnvelope"]);

/**
 * Deterministic in-memory compare-and-swap adapter.
 *
 * Every caller value is inspected through descriptors or a configured strict
 * parser before enrichment. Publication remains the final synchronous step,
 * so a failed batch cannot create a stream, reserve an identifier, or expose a
 * prefix of the proposed events.
 */
export class InMemoryEventStore<
  TEvent extends StorableEvent = GenericEvent
> implements EventStore<TEvent> {
  readonly #streams = new Map<RunId, readonly EnvelopeOf<TEvent>[]>();
  readonly #eventIds = new Set<string>();
  readonly #now: () => unknown;
  readonly #parser: EventStoreParser<TEvent>;
  readonly #maximumBatchEvents: number;
  readonly #maximumEventBytes: number;

  constructor(
    ...args: IsExactlyGenericEvent<TEvent> extends true
      ? readonly [options?: InMemoryEventStoreOptions<TEvent>]
      : readonly [options: InMemoryEventStoreOptions<TEvent>]
  ) {
    const options: unknown = args[0] ?? {};
    const parsed = parseOptions<TEvent>(options);
    this.#now = parsed.now;
    this.#parser = parsed.parser ??
      (GENERIC_EVENT_PARSER as unknown as EventStoreParser<TEvent>);
    this.#maximumBatchEvents = parsed.maximumBatchEvents;
    this.#maximumEventBytes = parsed.maximumEventBytes;
  }

  async append<TAppendEvent extends TEvent>(
    streamId: RunId,
    expectedVersion: number,
    events: readonly TAppendEvent[]
  ): Promise<readonly EnvelopeOf<TAppendEvent>[]> {
    validateStreamId(streamId);
    validateVersion(expectedVersion, "expectedVersion");
    const proposedBatch = inspectBatch(events, this.#maximumBatchEvents);

    const current = this.#streams.get(streamId) ?? [];
    const actualVersion = current.length;
    if (expectedVersion !== actualVersion) {
      throw createDomainError({
        code: "conflict",
        message: "The event stream changed after it was read.",
        details: { streamId, expectedVersion, actualVersion },
      });
    }

    const parsedEvents: TAppendEvent[] = [];
    const candidateIds = new Set<string>();
    for (let index = 0; index < proposedBatch.length; index += 1) {
      const parsed = parseProposedEvent<TEvent, TAppendEvent>(
        this.#parser,
        proposedBatch[index],
        index
      );
      if (this.#eventIds.has(parsed.eventId) || candidateIds.has(parsed.eventId)) {
        throw createDomainError({
          code: "conflict",
          message: "An event identifier may be recorded only once.",
          details: { eventId: parsed.eventId },
        });
      }
      candidateIds.add(parsed.eventId);
      parsedEvents.push(parsed);
    }

    const recordedAt = readClock(this.#now);
    const candidates: EnvelopeOf<TAppendEvent>[] = [];
    for (let index = 0; index < parsedEvents.length; index += 1) {
      const parsed = parsedEvents[index];
      if (parsed === undefined) {
        throw invalidInput("The parsed event batch changed unexpectedly.");
      }
      const candidate = enrichEvent(
        parsed,
        streamId,
        expectedVersion + index + 1,
        recordedAt
      );
      const envelope = parseStrictEnvelope<TEvent, TAppendEvent>(
        this.#parser,
        candidate,
        index
      );
      enforceEventBytes(envelope, this.#maximumEventBytes, index);
      candidates.push(envelope);
    }

    const stored = Object.freeze([
      ...current,
      ...candidates,
    ]) as readonly EnvelopeOf<TEvent>[];
    this.#streams.set(streamId, stored);
    for (const eventId of candidateIds) {
      this.#eventIds.add(eventId);
    }

    return Object.freeze([...candidates]);
  }

  async *read(
    streamId: RunId,
    afterVersion = 0
  ): AsyncIterable<EnvelopeOf<TEvent>> {
    validateStreamId(streamId);
    validateVersion(afterVersion, "afterVersion");

    // Arrays are replaced, never extended, so this is a stable point-in-time
    // view even when an append begins between successive yields.
    const history = this.#streams.get(streamId) ?? [];
    for (const envelope of history) {
      if (envelope.streamVersion <= afterVersion) continue;
      yield parseStrictEnvelope<TEvent, TEvent>(this.#parser, envelope);
    }
  }
}

function parseOptions<TEvent extends StorableEvent>(
  value: unknown
): ParsedOptions<TEvent> {
  let options: Readonly<Record<string, unknown>>;
  try {
    options = inspectDataRecord(value, OPTION_KEYS);
  } catch {
    throw invalidInput("Invalid event-store options.");
  }

  const now = options["now"] ?? defaultNow;
  if (typeof now !== "function") {
    throw invalidInput("The event-store clock must be a function.");
  }
  const maximumBatchEvents = options["maximumBatchEvents"] ??
    DEFAULT_MAXIMUM_BATCH_EVENTS;
  const maximumEventBytes = options["maximumEventBytes"] ??
    DEFAULT_MAXIMUM_EVENT_BYTES;
  validatePositiveLimit(maximumBatchEvents, "maximumBatchEvents");
  validatePositiveLimit(maximumEventBytes, "maximumEventBytes");

  let parser: EventStoreParser<TEvent> | null = null;
  if (options["parser"] !== undefined) {
    try {
      const parserRecord = inspectDataRecord(options["parser"], PARSER_KEYS);
      const parseEvent = parserRecord["parseEvent"];
      const parseEnvelope = parserRecord["parseEnvelope"];
      if (typeof parseEvent !== "function" || typeof parseEnvelope !== "function") {
        throw new TypeError("invalid parser");
      }
      parser = Object.freeze({
        parseEvent: parseEvent as EventStoreParser<TEvent>["parseEvent"],
        parseEnvelope: parseEnvelope as EventStoreParser<TEvent>["parseEnvelope"],
      });
    } catch {
      throw invalidInput("The event-store parser must contain strict data functions.");
    }
  }

  return {
    now: now as () => unknown,
    parser,
    maximumBatchEvents,
    maximumEventBytes,
  };
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

  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new TypeError("invalid data record key");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError("invalid data record property");
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

function inspectBatch(value: unknown, maximum: number): readonly unknown[] {
  let batch: readonly unknown[];
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      throw new TypeError("invalid batch");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("invalid batch key");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable === true ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      keys.length !== lengthDescriptor.value + 1
    ) {
      throw new TypeError("invalid batch length");
    }
    const items: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("invalid batch item");
      }
      items.push(descriptor.value);
    }
    batch = Object.freeze(items);
  } catch {
    throw invalidInput("The event append batch must be a plain dense data array.");
  }

  if (batch.length === 0) {
    throw invalidInput("An event append requires at least one event.");
  }
  if (batch.length > maximum) {
    throw invalidInput("The event append exceeds maximumBatchEvents.", {
      maximumBatchEvents: maximum,
      actualBatchEvents: batch.length,
    });
  }
  return batch;
}

function parseProposedEvent<
  TParserEvent extends StorableEvent,
  TExpectedEvent extends TParserEvent
>(
  parser: EventStoreParser<TParserEvent>,
  value: unknown,
  eventIndex: number
): TExpectedEvent {
  try {
    const framedInput = parseNewEvent(value);
    const configured = parser.parseEvent(framedInput);
    const framedOutput = parseNewEvent(configured);
    if (canonicalize(framedInput) !== canonicalize(framedOutput)) {
      throw new TypeError("event parser transformed input");
    }
    return framedOutput as TExpectedEvent;
  } catch {
    throw invalidInput("The event append contains an invalid event.", {
      eventIndex,
    });
  }
}

function parseStrictEnvelope<
  TParserEvent extends StorableEvent,
  TExpectedEvent extends TParserEvent
>(
  parser: EventStoreParser<TParserEvent>,
  value: unknown,
  eventIndex?: number
): EnvelopeOf<TExpectedEvent> {
  try {
    const framedInput = parseEventEnvelope(value);
    const configured = parser.parseEnvelope(framedInput);
    const framedOutput = parseEventEnvelope(configured);
    if (canonicalize(framedInput) !== canonicalize(framedOutput)) {
      throw new TypeError("envelope parser transformed input");
    }
    return framedOutput as EnvelopeOf<TExpectedEvent>;
  } catch {
    throw invalidInput(
      "The event store encountered an invalid event envelope.",
      eventIndex === undefined ? undefined : { eventIndex }
    );
  }
}

function enrichEvent<TEvent extends StorableEvent>(
  event: TEvent,
  streamId: RunId,
  streamVersion: number,
  recordedAt: string
): EnvelopeOf<TEvent> {
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
    recordedAt,
  } as EnvelopeOf<TEvent>;
}

function enforceEventBytes(
  envelope: unknown,
  maximumEventBytes: number,
  eventIndex: number
): void {
  let actualEventBytes: number;
  try {
    actualEventBytes = canonicalBytes(envelope).byteLength;
  } catch {
    throw invalidInput("The event envelope could not be sized safely.", {
      eventIndex,
    });
  }
  if (actualEventBytes > maximumEventBytes) {
    throw invalidInput("The event envelope exceeds maximumEventBytes.", {
      eventIndex,
      maximumEventBytes,
      actualEventBytes,
    });
  }
}

function readClock(now: () => unknown): string {
  let value: unknown;
  try {
    value = now();
  } catch {
    throw invalidInput("The event-store clock failed.");
  }
  if (typeof value !== "string" || !isCanonicalTimestamp(value)) {
    throw invalidInput("The event-store clock must return a canonical ISO timestamp.");
  }
  return value;
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    const instant = new Date(value);
    return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value;
  } catch {
    return false;
  }
}

function validateStreamId(streamId: unknown): asserts streamId is RunId {
  if (!RunIdKind.is(streamId)) {
    throw invalidInput("The event stream identifier is invalid.");
  }
}

function validateVersion(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${field} must be a non-negative safe integer.`, {
      field,
    });
  }
}

function validatePositiveLimit(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidInput(`${field} must be a positive safe integer.`, { field });
  }
}

function invalidInput(
  message: string,
  details?: Readonly<Record<string, unknown>>
): DomainError {
  return createDomainError({
    code: "invalid_input",
    message,
    ...(details === undefined ? {} : { details }),
  });
}
