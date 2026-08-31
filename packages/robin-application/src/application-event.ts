import { createDomainError, type JsonObject } from "@guard/contracts";
import {
  MAXIMUM_APPLICATION_EVENT_UTF8_BYTES,
  createEmptyRobinSessionProjection,
  parseRobinApplicationEvent,
  reduceRobinSessionProjection,
  replayRobinSession,
  type RobinApplicationEvent,
  type RobinApplicationEventPayloadMap,
  type RobinApplicationEventType,
  type RobinSessionProjection,
} from "@guard/robin-session";

export interface ApplicationEventClock {
  now(): string;
}

export interface ApplicationEventIdSource {
  nextEventId(sequence: number): string;
}

export interface ApplicationEventJournalLimits {
  /** Maximum number of durable records retained by one ephemeral journal. */
  readonly maximumRecords: number;
  /** Maximum UTF-8 bytes of serialized event JSON retained by one journal. */
  readonly maximumBytes: number;
  /** Maximum number of live replay-follow subscribers retained by the journal. */
  readonly maximumSubscribers: number;
  /** Maximum number of unread events retained for one subscriber. */
  readonly maximumSubscriberBacklogEvents: number;
  /** Maximum UTF-8 event bytes retained for one subscriber. */
  readonly maximumSubscriberBacklogBytes: number;
}

export type RobinApplicationEventDraft = {
  readonly [TType in RobinApplicationEventType]: {
    readonly type: TType;
    readonly payload: RobinApplicationEventPayloadMap[TType];
  };
}[RobinApplicationEventType];

export const DEFAULT_APPLICATION_EVENT_JOURNAL_LIMITS: ApplicationEventJournalLimits =
  Object.freeze({
    maximumRecords: 131_072,
    maximumBytes: 134_217_728,
    maximumSubscribers: 32,
    maximumSubscriberBacklogEvents: 8_192,
    maximumSubscriberBacklogBytes: 16_777_216,
  });

/** Append-only, in-memory R1 event journal with parser enforcement on writes. */
export class ApplicationEventJournal {
  readonly #sessionId: string;
  readonly #clock: ApplicationEventClock;
  readonly #ids: ApplicationEventIdSource;
  readonly #limits: ApplicationEventJournalLimits;
  readonly #records: RobinApplicationEvent[] = [];
  readonly #subscribers = new Set<JournalEventStream<RobinApplicationEvent>>();
  #projection: RobinSessionProjection = createEmptyRobinSessionProjection();
  #recordBytes = 0;
  #closed = false;
  #failed = false;
  #failure: unknown;

  public constructor(options: {
    readonly sessionId: string;
    readonly clock: ApplicationEventClock;
    readonly ids?: ApplicationEventIdSource;
    readonly limits?: Partial<ApplicationEventJournalLimits>;
  }) {
    this.#sessionId = options.sessionId;
    this.#clock = Object.freeze({ now: options.clock.now.bind(options.clock) });
    const ids =
      options.ids ??
      Object.freeze({ nextEventId: (sequence: number) => `event:${sequence}` });
    this.#ids = Object.freeze({
      nextEventId: ids.nextEventId.bind(ids),
    });
    this.#limits = captureJournalLimits(options.limits);
  }

  public get records(): readonly RobinApplicationEvent[] {
    return Object.freeze([...this.#records]);
  }

  public get projection(): RobinSessionProjection {
    return this.#projection;
  }

  /**
   * Replays records after an acknowledged sequence, then follows the same
   * append order live until SessionClosed. Historical replay is an indexed view
   * over the journal rather than a copied backlog; the per-subscriber caps apply
   * to unread live growth that arrives behind that replay. A faulted journal is
   * fail-closed: subscribers reject immediately instead of replaying a prefix
   * that has no valid terminal record.
   */
  public subscribe(
    afterSequence = 0,
  ): AsyncIterable<RobinApplicationEvent> {
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      afterSequence > this.#records.length
    ) {
      throw createDomainError({
        code: "invalid_input",
        message: "afterSequence must identify an existing journal prefix.",
      });
    }
    if (
      !this.#closed &&
      this.#subscribers.size >= this.#limits.maximumSubscribers
    ) {
      throw journalBudgetExceeded(
        "The application event subscriber limit is exhausted.",
        "subscribers",
        this.#limits.maximumSubscribers,
        this.#subscribers.size + 1,
      );
    }
    let stream!: JournalEventStream<RobinApplicationEvent>;
    stream = new JournalEventStream({
      replay: this.#records,
      replayStart: afterSequence,
      replayEnd: this.#records.length,
      maximumBacklogEvents: this.#limits.maximumSubscriberBacklogEvents,
      maximumBacklogBytes: this.#limits.maximumSubscriberBacklogBytes,
      measure: eventByteLength,
      onClose: () => this.#subscribers.delete(stream),
    });
    if (this.#failed) {
      stream.fail(this.#failure);
      return stream;
    }
    if (this.#closed) stream.end();
    else this.#subscribers.add(stream);
    return stream;
  }

  public append<TType extends RobinApplicationEventType>(
    type: TType,
    payload: RobinApplicationEventPayloadMap[TType],
  ): Extract<RobinApplicationEvent, { readonly type: TType }> {
    const event = this.appendBatch([
      { type, payload } as RobinApplicationEventDraft,
    ])[0];
    if (event === undefined) {
      throw createDomainError({
        code: "invariant_violated",
        message: "A non-empty application event batch produced no record.",
      });
    }
    return event as Extract<RobinApplicationEvent, { readonly type: TType }>;
  }

  /**
   * Stages parsing, reduction, and budget checks for every draft before making
   * any record visible. A rejected batch never advances records, projection,
   * retained bytes, or subscribers.
   */
  public appendBatch(
    drafts: readonly RobinApplicationEventDraft[],
  ): readonly RobinApplicationEvent[] {
    if (this.#failed) throw this.#failure;
    if (this.#closed) {
      throw createDomainError({
        code: "conflict",
        message: "The application event journal is closed.",
      });
    }
    if (!Array.isArray(drafts) || drafts.length < 1 || drafts.length > 32) {
      throw createDomainError({
        code: "invalid_input",
        message: "An application event batch must contain 1 through 32 drafts.",
      });
    }

    const staged: RobinApplicationEvent[] = [];
    let projection = this.#projection;
    let stagedBytes = 0;
    for (const draft of drafts) {
      const sequence = this.#records.length + staged.length + 1;
      const candidate = {
        schemaVersion: 1,
        sequence,
        sessionId: this.#sessionId,
        eventId: this.#ids.nextEventId(sequence),
        occurredAt: this.#clock.now(),
        type: draft.type,
        payload: draft.payload as unknown as JsonObject,
      };
      const event = parseRobinApplicationEvent(candidate);
      projection = reduceRobinSessionProjection(projection, event);
      stagedBytes += eventByteLength(event);
      staged.push(event);
    }

    const finalSequence = this.#records.length + staged.length;
    const terminalHeadroomRecords = requiredTerminalHeadroomRecords(projection);
    const terminalHeadroomBytes =
      terminalHeadroomRecords * MAXIMUM_APPLICATION_EVENT_UTF8_BYTES;
    if (finalSequence + terminalHeadroomRecords > this.#limits.maximumRecords) {
      throw journalBudgetExceeded(
        "The application event record limit cannot preserve terminal headroom.",
        "records",
        this.#limits.maximumRecords,
        finalSequence + terminalHeadroomRecords,
      );
    }
    if (
      this.#recordBytes + stagedBytes + terminalHeadroomBytes >
      this.#limits.maximumBytes
    ) {
      throw journalBudgetExceeded(
        "The application event byte limit cannot preserve terminal headroom.",
        "bytes",
        this.#limits.maximumBytes,
        this.#recordBytes + stagedBytes + terminalHeadroomBytes,
      );
    }

    this.#records.push(...staged);
    this.#recordBytes += stagedBytes;
    this.#projection = projection;
    for (const event of staged) {
      for (const subscriber of this.#subscribers) subscriber.push(event);
    }
    if (staged.at(-1)?.type === "SessionClosed") {
      this.#closed = true;
      for (const subscriber of this.#subscribers) subscriber.end();
      this.#subscribers.clear();
    }
    return Object.freeze([...staged]);
  }

  /**
   * Irrecoverably faults the journal and rejects every current or future read.
   * This is used when an application terminal record cannot be constructed or
   * committed, because pretending that the still-open projection is complete
   * would be a false success.
   */
  public fail(error: unknown): void {
    if (this.#closed) return;
    this.#failed = true;
    this.#failure = error;
    this.#closed = true;
    for (const subscriber of this.#subscribers) subscriber.fail(error);
    this.#subscribers.clear();
  }
}

class JournalEventStream<T> implements AsyncIterableIterator<T> {
  #replay: readonly T[] | null;
  readonly #replayEnd: number;
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(reason: unknown): void;
  }> = [];
  readonly #maximumBacklogEvents: number;
  readonly #maximumBacklogBytes: number;
  readonly #measure: (value: T) => number;
  readonly #onClose: () => void;
  #backlogBytes = 0;
  #replayIndex: number;
  #ended = false;
  #failed = false;
  #failure: unknown;

  public constructor(options: {
    readonly replay: readonly T[];
    readonly replayStart: number;
    readonly replayEnd: number;
    readonly maximumBacklogEvents: number;
    readonly maximumBacklogBytes: number;
    readonly measure: (value: T) => number;
    readonly onClose: () => void;
  }) {
    this.#replay =
      options.replayStart < options.replayEnd ? options.replay : null;
    this.#replayIndex = options.replayStart;
    this.#replayEnd = options.replayEnd;
    this.#maximumBacklogEvents = options.maximumBacklogEvents;
    this.#maximumBacklogBytes = options.maximumBacklogBytes;
    this.#measure = options.measure;
    this.#onClose = options.onClose;
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  public next(): Promise<IteratorResult<T>> {
    if (this.#failed) return Promise.reject(this.#failure);
    if (this.#replayIndex < this.#replayEnd) {
      const value = this.#replay?.[this.#replayIndex];
      this.#replayIndex += 1;
      if (this.#replayIndex === this.#replayEnd) this.#replay = null;
      if (value === undefined) {
        return Promise.reject(
          createDomainError({
            code: "invariant_violated",
            message: "The application event replay index is unavailable.",
          }),
        );
      }
      return Promise.resolve({ done: false, value });
    }
    const value = this.#values.shift();
    if (value !== undefined) {
      this.#backlogBytes -= this.#measure(value);
      return Promise.resolve({ done: false, value });
    }
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    if (this.#waiters.length >= this.#maximumBacklogEvents) {
      const error = journalBudgetExceeded(
        "An application event subscriber exceeded its pending read limit.",
        "subscriber_reads",
        this.#maximumBacklogEvents,
        this.#waiters.length + 1,
      );
      this.fail(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) =>
      this.#waiters.push({ resolve, reject }),
    );
  }

  public return(): Promise<IteratorResult<T>> {
    this.#discardAndEnd();
    return Promise.resolve({ done: true, value: undefined });
  }

  public push(value: T): boolean {
    if (this.#ended) return false;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return true;
    }
    const bytes = this.#measure(value);
    if (
      this.#values.length + 1 > this.#maximumBacklogEvents ||
      this.#backlogBytes + bytes > this.#maximumBacklogBytes
    ) {
      const dimension =
        this.#values.length + 1 > this.#maximumBacklogEvents
          ? "subscriber_events"
          : "subscriber_bytes";
      const limit =
        dimension === "subscriber_events"
          ? this.#maximumBacklogEvents
          : this.#maximumBacklogBytes;
      const used =
        dimension === "subscriber_events"
          ? this.#values.length + 1
          : this.#backlogBytes + bytes;
      this.fail(
        journalBudgetExceeded(
          "An application event subscriber exceeded its unread backlog limit.",
          dimension,
          limit,
          used,
        ),
      );
      return false;
    }
    this.#values.push(value);
    this.#backlogBytes += bytes;
    return true;
  }

  public end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#onClose();
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  public fail(error: unknown): void {
    if (this.#ended) return;
    this.#failed = true;
    this.#failure = error;
    this.#replay = null;
    this.#replayIndex = this.#replayEnd;
    this.#values.splice(0);
    this.#backlogBytes = 0;
    this.#ended = true;
    this.#onClose();
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  #discardAndEnd(): void {
    const wasEnded = this.#ended;
    this.#replay = null;
    this.#replayIndex = this.#replayEnd;
    this.#values.splice(0);
    this.#backlogBytes = 0;
    this.#failed = false;
    this.#failure = undefined;
    this.#ended = true;
    if (!wasEnded) this.#onClose();
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}

function captureJournalLimits(
  value: Partial<ApplicationEventJournalLimits> | undefined,
): ApplicationEventJournalLimits {
  return Object.freeze({
    maximumRecords: boundedLimit(
      value?.maximumRecords ??
        DEFAULT_APPLICATION_EVENT_JOURNAL_LIMITS.maximumRecords,
      "maximumRecords",
      1_000_000,
    ),
    maximumBytes: boundedLimit(
      value?.maximumBytes ??
        DEFAULT_APPLICATION_EVENT_JOURNAL_LIMITS.maximumBytes,
      "maximumBytes",
      1_073_741_824,
    ),
    maximumSubscribers: boundedLimit(
      value?.maximumSubscribers ??
        DEFAULT_APPLICATION_EVENT_JOURNAL_LIMITS.maximumSubscribers,
      "maximumSubscribers",
      1_024,
    ),
    maximumSubscriberBacklogEvents: boundedLimit(
      value?.maximumSubscriberBacklogEvents ??
        DEFAULT_APPLICATION_EVENT_JOURNAL_LIMITS.maximumSubscriberBacklogEvents,
      "maximumSubscriberBacklogEvents",
      131_072,
    ),
    maximumSubscriberBacklogBytes: boundedLimit(
      value?.maximumSubscriberBacklogBytes ??
        DEFAULT_APPLICATION_EVENT_JOURNAL_LIMITS.maximumSubscriberBacklogBytes,
      "maximumSubscriberBacklogBytes",
      134_217_728,
    ),
  });
}

function boundedLimit(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw createDomainError({
      code: "invalid_input",
      message: `${name} must be an integer from 1 through ${maximum}.`,
    });
  }
  return value;
}

function eventByteLength(event: RobinApplicationEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function requiredTerminalHeadroomRecords(
  projection: RobinSessionProjection,
): number {
  if (projection.status === "closed") return 0;
  let records = 1; // SessionClosed
  for (const turn of projection.turns) {
    const activeTool = turn.toolCalls.some((call) => call.status === "active");
    switch (turn.status) {
      case "queued":
        // Promotion must be able to commit UserMessageAccepted and TurnStarted
        // before the active-turn cancellation terminal path.
        records += 4 + (activeTool ? 1 : 0);
        break;
      case "accepted":
        // Accepted work still needs TurnStarted before the active-turn path.
        records += 3 + (activeTool ? 1 : 0);
        break;
      case "active":
        records += 2 + (activeTool ? 1 : 0);
        break;
      case "cancellation_requested":
        records += 1 + (activeTool ? 1 : 0);
        break;
      case "cancelled":
      case "failed":
      case "budget_exhausted":
      case "completed":
        break;
    }
  }
  return records;
}

function journalBudgetExceeded(
  message: string,
  dimension: string,
  limit: number,
  used: number,
): ReturnType<typeof createDomainError> {
  return createDomainError({
    code: "budget_exceeded",
    message,
    details: { dimension, limit, used },
  });
}

export {
  parseRobinApplicationEvent,
  replayRobinSession,
  serializeRobinApplicationEvent,
} from "@guard/robin-session";
export type {
  RobinApplicationEvent,
  RobinApplicationEventPayloadMap,
  RobinApplicationEventType,
  RobinSessionProjection,
} from "@guard/robin-session";
