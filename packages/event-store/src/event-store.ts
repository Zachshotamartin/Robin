import type {
  EventEnvelope,
  GenericEvent,
  NewEvent,
  RunId,
} from "@guard/contracts";

export type EnvelopeOf<
  TEvent extends NewEvent<string, unknown>
> = TEvent extends NewEvent<infer TType, infer TPayload>
  ? EventEnvelope<TType, TPayload>
  : never;

/**
 * A registered event family supplies both strict parsers. Parsers must reject
 * unknown fields and return detached, canonically identical values; the
 * adapter verifies those claims again at the framing boundary.
 */
export interface EventStoreParser<
  TEvent extends NewEvent<string, unknown>
> {
  readonly parseEvent: (value: unknown) => TEvent;
  readonly parseEnvelope: (value: unknown) => EnvelopeOf<TEvent>;
}

/**
 * The durable ordering boundary for one aggregate stream.
 *
 * A stream does not exist until its first non-empty append succeeds with an
 * expected version of zero. Implementations must compare and append atomically.
 */
export interface EventStore<
  TEvent extends NewEvent<string, unknown> = GenericEvent
> {
  append<TAppendEvent extends TEvent>(
    streamId: RunId,
    expectedVersion: number,
    events: readonly TAppendEvent[]
  ): Promise<readonly EnvelopeOf<TAppendEvent>[]>;

  /** Reads immutable envelopes whose versions are strictly after the cursor. */
  read(streamId: RunId, afterVersion?: number): AsyncIterable<EnvelopeOf<TEvent>>;
}
