import {
  RunIdKind,
  assertEventEnvelope,
  canonicalize,
  createDomainError,
} from "@guard/contracts";
import type {
  EventEnvelope,
  JsonObject,
  NewEvent,
  RunId,
} from "@guard/contracts";

import type { EventStore } from "./event-store.js";

export interface InMemoryEventStoreOptions {
  /**
   * Supplies the authoritative record time. It is invoked exactly once for a
   * batch that has passed expected-version checks.
   */
  readonly now?: () => string;
}

const defaultNow = (): string => new Date().toISOString();

/**
 * Deterministic adapter used by reducers and early vertical slices.
 *
 * The adapter deliberately replaces stream arrays instead of mutating them.
 * Since an async function runs synchronously until its first suspension and
 * `append` has no suspension point, compare-and-swap remains atomic within one
 * JavaScript isolate, including when callers start competing appends together.
 */
export class InMemoryEventStore implements EventStore {
  readonly #streams = new Map<RunId, readonly EventEnvelope[]>();
  readonly #eventIds = new Set<string>();
  readonly #now: () => string;

  constructor(options: InMemoryEventStoreOptions = {}) {
    if (options.now !== undefined && typeof options.now !== "function") {
      throw invalidInput("The event-store clock must be a function.");
    }
    this.#now = options.now ?? defaultNow;
  }

  async append<TType extends string, TPayload extends JsonObject>(
    streamId: RunId,
    expectedVersion: number,
    events: readonly NewEvent<TType, TPayload>[]
  ): Promise<readonly EventEnvelope<TType, TPayload>[]> {
    validateStreamId(streamId);
    validateVersion(expectedVersion, "expectedVersion");
    if (!Array.isArray(events) || events.length === 0) {
      throw invalidInput("An event append requires at least one event.", {
        streamId,
      });
    }

    const current = this.#streams.get(streamId) ?? [];
    const actualVersion = current.length;
    if (expectedVersion !== actualVersion) {
      throw createDomainError({
        code: "conflict",
        message: "The event stream changed after it was read.",
        details: { streamId, expectedVersion, actualVersion },
      });
    }

    // Read the authoritative record time only after inexpensive conflict
    // checks, and exactly once so all envelopes in the transaction agree.
    const recordedAt = this.#now();
    const candidateIds = new Set<string>();
    const candidates: EventEnvelope<TType, TPayload>[] = [];

    for (const [index, proposed] of events.entries()) {
      const envelope: EventEnvelope<TType, TPayload> = {
        ...proposed,
        streamId,
        streamVersion: expectedVersion + index + 1,
        recordedAt,
      };

      // The contracts package is the single runtime validation boundary. This
      // validates identifiers, timestamps, actor/envelope fields, schema
      // version, and JSON payload before anything becomes visible.
      assertEventEnvelope(envelope);

      if (this.#eventIds.has(envelope.eventId) || candidateIds.has(envelope.eventId)) {
        throw createDomainError({
          code: "conflict",
          message: "An event identifier may be recorded only once.",
          details: { eventId: envelope.eventId },
        });
      }
      candidateIds.add(envelope.eventId);
      candidates.push(snapshot(envelope));
    }

    // Publish only after every candidate has passed validation and cloning.
    // There is no mutation before this point, so every failure is all-or-none.
    const stored = Object.freeze([...current, ...candidates]);
    this.#streams.set(streamId, stored);
    for (const eventId of candidateIds) {
      this.#eventIds.add(eventId);
    }

    return Object.freeze(
      candidates.map((event) => snapshot(event))
    ) as readonly EventEnvelope<TType, TPayload>[];
  }

  async *read(
    streamId: RunId,
    afterVersion = 0
  ): AsyncIterable<EventEnvelope> {
    validateStreamId(streamId);
    validateVersion(afterVersion, "afterVersion");

    // Stream arrays are immutable and replaced on append, so this is a stable
    // point-in-time snapshot even if another append starts between yields.
    const history = this.#streams.get(streamId) ?? [];
    for (const envelope of history) {
      if (envelope.streamVersion <= afterVersion) continue;

      // Validate reads as well as writes: a durable adapter must not trust data
      // merely because it came from its own backing store.
      assertEventEnvelope(envelope);
      yield snapshot(envelope);
    }
  }
}

function validateStreamId(streamId: RunId): void {
  RunIdKind.parse(streamId);
}

function validateVersion(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${field} must be a non-negative safe integer.`, {
      field,
      value,
    });
  }
}

function invalidInput(
  message: string,
  details?: Readonly<Record<string, unknown>>
) {
  return createDomainError({
    code: "invalid_input",
    message,
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * Canonical serialization simultaneously rejects non-JSON values and removes
 * caller aliases. The parsed tree is then recursively frozen before crossing
 * either side of the adapter boundary.
 */
function snapshot<T>(value: T): T {
  const detached = JSON.parse(canonicalize(value)) as T;
  return deepFreeze(detached);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
