export type InterruptAction = "cancel" | "force_exit";
export type InteractiveInterruptState =
  | "ready"
  | "working"
  | "cancelling"
  | "closed"
  | "fatal";
export type InteractiveInterruptDecision =
  | "apply_key"
  | "request_cancel"
  | "force_exit";

/** Two-stage interrupt window shared by terminal bytes and OS SIGINT. */
export class InterruptEscalator {
  readonly #windowMs: number;
  readonly #now: () => number;
  #deadline = -1;

  public constructor(options: {
    readonly windowMs?: number;
    readonly now?: () => number;
  } = {}) {
    this.#windowMs = positiveWindow(options.windowMs ?? 750);
    this.#now = options.now ?? (() => Date.now());
  }

  public get armed(): boolean {
    return this.#deadline >= 0 && this.#now() <= this.#deadline;
  }

  public interrupt(): InterruptAction {
    const observed = this.#now();
    if (observed <= this.#deadline) {
      this.#deadline = -1;
      return "force_exit";
    }
    this.#deadline = observed + this.#windowMs;
    return "cancel";
  }

  public reset(): void {
    this.#deadline = -1;
  }
}

/**
 * Owns the mapping from one physical Ctrl-C to exactly one UI/application
 * action. In particular, the UI reducer must never independently turn an
 * expired second interrupt into a forced exit.
 */
export class InteractiveInterruptController {
  readonly #escalator: InterruptEscalator;

  public constructor(escalator = new InterruptEscalator()) {
    this.#escalator = escalator;
  }

  public interrupt(
    state: InteractiveInterruptState,
  ): InteractiveInterruptDecision {
    if (state !== "working" && state !== "cancelling") {
      this.#escalator.reset();
      return "apply_key";
    }
    const action = this.#escalator.interrupt();
    if (action === "force_exit") return "force_exit";
    return state === "working" ? "apply_key" : "request_cancel";
  }

  public reset(): void {
    this.#escalator.reset();
  }
}

function positiveWindow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError("Interrupt window must be a positive bounded integer.");
  }
  return value;
}
