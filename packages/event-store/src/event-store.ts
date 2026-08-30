import type {
  EventEnvelope,
  JsonObject,
  NewEvent,
  RunId,
} from "@guard/contracts";

/**
 * The durable ordering boundary for one aggregate stream.
 *
 * A stream does not exist until its first non-empty append succeeds with an
 * expected version of zero. Implementations must compare and append atomically.
 */
export interface EventStore {
  append<TType extends string, TPayload extends JsonObject>(
    streamId: RunId,
    expectedVersion: number,
    events: readonly NewEvent<TType, TPayload>[]
  ): Promise<readonly EventEnvelope<TType, TPayload>[]>;

  /** Reads immutable envelopes whose versions are strictly after the cursor. */
  read(streamId: RunId, afterVersion?: number): AsyncIterable<EventEnvelope>;
}
