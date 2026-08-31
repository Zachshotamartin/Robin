import { createDomainError } from "@guard/contracts";

export interface MonotonicClock {
  now(): number;
}

export interface TurnBudgetLimits {
  readonly maximumModelRequests: number;
  readonly maximumToolCalls: number;
  readonly maximumOutputBytes: number;
  readonly maximumProviderEvents: number;
  readonly maximumWallTimeMs: number;
}

export const DEFAULT_TURN_BUDGET_LIMITS: TurnBudgetLimits = Object.freeze({
  maximumModelRequests: 16,
  maximumToolCalls: 64,
  maximumOutputBytes: 1_048_576,
  maximumProviderEvents: 4_096,
  maximumWallTimeMs: 300_000,
});

export interface TurnBudgetSnapshot {
  readonly modelRequests: number;
  readonly toolCalls: number;
  readonly outputBytes: number;
  readonly providerEvents: number;
  readonly elapsedMs: number;
  readonly limits: TurnBudgetLimits;
}

/** Overflow-safe, locally enforced counters for one coordinator turn. */
export class TurnBudgets {
  readonly #clock: MonotonicClock;
  readonly #limits: TurnBudgetLimits;
  readonly #startedAt: number;
  #lastObservedAt: number;
  #modelRequests = 0;
  #toolCalls = 0;
  #outputBytes = 0;
  #providerEvents = 0;

  public constructor(
    clock: MonotonicClock,
    limits: Partial<TurnBudgetLimits> = {},
  ) {
    if (typeof clock !== "object" || clock === null || typeof clock.now !== "function") {
      throw createDomainError({
        code: "invalid_input",
        message: "A monotonic turn-budget clock is required.",
      });
    }
    this.#clock = Object.freeze({ now: clock.now.bind(clock) });
    this.#limits = captureLimits(limits);
    this.#startedAt = observeTime(this.#clock);
    this.#lastObservedAt = this.#startedAt;
  }

  public reserveModelRequest(): void {
    this.checkWallTime();
    this.#modelRequests = incrementBounded(
      this.#modelRequests,
      1,
      this.#limits.maximumModelRequests,
      "model request",
    );
  }

  public reserveToolCall(): void {
    this.checkWallTime();
    this.#toolCalls = incrementBounded(
      this.#toolCalls,
      1,
      this.#limits.maximumToolCalls,
      "tool call",
    );
  }

  public recordProviderEvent(): void {
    this.checkWallTime();
    this.#providerEvents = incrementBounded(
      this.#providerEvents,
      1,
      this.#limits.maximumProviderEvents,
      "provider event",
    );
  }

  public recordOutputBytes(byteCount: number): void {
    this.checkWallTime();
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Turn output accounting requires a non-negative safe byte count.",
      });
    }
    this.#outputBytes = incrementBounded(
      this.#outputBytes,
      byteCount,
      this.#limits.maximumOutputBytes,
      "output byte",
    );
  }

  public get remainingOutputBytes(): number {
    this.checkWallTime();
    return this.#limits.maximumOutputBytes - this.#outputBytes;
  }

  public requireOutputCapacity(minimumBytes: number): void {
    this.checkWallTime();
    if (!Number.isSafeInteger(minimumBytes) || minimumBytes <= 0) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Turn output capacity requires a positive safe byte count.",
      });
    }
    if (minimumBytes > this.#limits.maximumOutputBytes - this.#outputBytes) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "The turn output byte budget was exhausted.",
        details: {
          current: this.#outputBytes,
          minimumBytes,
          maximum: this.#limits.maximumOutputBytes,
        },
      });
    }
  }

  public checkWallTime(): number {
    const observed = observeTime(this.#clock);
    if (observed < this.#lastObservedAt) {
      throw createDomainError({
        code: "infrastructure_failed",
        message: "The monotonic turn-budget clock moved backwards.",
      });
    }
    this.#lastObservedAt = observed;
    const elapsed = observed - this.#startedAt;
    if (elapsed > this.#limits.maximumWallTimeMs) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "The turn wall-time budget was exhausted.",
        details: {
          elapsedMs: elapsed,
          maximumWallTimeMs: this.#limits.maximumWallTimeMs,
        },
      });
    }
    return elapsed;
  }

  public snapshot(): TurnBudgetSnapshot {
    const elapsedMs = this.checkWallTime();
    return Object.freeze({
      modelRequests: this.#modelRequests,
      toolCalls: this.#toolCalls,
      outputBytes: this.#outputBytes,
      providerEvents: this.#providerEvents,
      elapsedMs,
      limits: this.#limits,
    });
  }
}

function captureLimits(value: Partial<TurnBudgetLimits>): TurnBudgetLimits {
  const captured = { ...DEFAULT_TURN_BUDGET_LIMITS, ...value };
  for (const [name, limit] of Object.entries(captured)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw createDomainError({
        code: "invalid_input",
        message: `${name} must be a positive safe integer.`,
      });
    }
  }
  return Object.freeze(captured);
}

function captureTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createDomainError({
      code: "infrastructure_failed",
      message: "The monotonic turn-budget clock returned an invalid value.",
    });
  }
  return value;
}

function observeTime(clock: MonotonicClock): number {
  let value: number;
  try {
    value = clock.now();
  } catch {
    throw createDomainError({
      code: "infrastructure_failed",
      message: "The monotonic turn-budget clock failed.",
    });
  }
  return captureTime(value);
}

function incrementBounded(
  current: number,
  increment: number,
  maximum: number,
  label: string,
): number {
  if (increment > maximum - current) {
    throw createDomainError({
      code: "budget_exceeded",
      message: `The turn ${label} budget was exhausted.`,
      details: { current, increment, maximum },
    });
  }
  return current + increment;
}
