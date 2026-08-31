export const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
export const HIDE_CURSOR = "\u001b[?25l";
export const SHOW_CURSOR = "\u001b[?25h";
export const RESET_STYLE = "\u001b[0m";
export const TERMINAL_OPEN_BYTES = ENABLE_BRACKETED_PASTE + HIDE_CURSOR;
export const TERMINAL_CLEANUP_BYTES =
  DISABLE_BRACKETED_PASTE + SHOW_CURSOR + RESET_STYLE + "\r\n";

export interface RawModeInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
}

export interface TerminalOutput {
  write(bytes: string): unknown;
}

export interface SignalRegistrar {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface TerminalSessionOptions {
  readonly input: RawModeInput;
  readonly output: TerminalOutput;
  readonly signals?: SignalRegistrar;
  readonly handledSignals?: readonly NodeJS.Signals[];
  readonly onSignal?: (signal: NodeJS.Signals) => void;
  readonly rawMode?: boolean;
  readonly bracketedPaste?: boolean;
  readonly hideCursor?: boolean;
}

export class TerminalSession {
  readonly #input: RawModeInput;
  readonly #output: TerminalOutput;
  readonly #signals: SignalRegistrar | undefined;
  readonly #handledSignals: readonly NodeJS.Signals[];
  readonly #onSignal: ((signal: NodeJS.Signals) => void) | undefined;
  readonly #rawMode: boolean;
  readonly #bracketedPaste: boolean;
  readonly #hideCursor: boolean;
  readonly #listeners = new Map<NodeJS.Signals, () => void>();
  #initialRaw = false;
  #opened = false;
  #closed = false;

  public constructor(options: TerminalSessionOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#signals = options.signals;
    this.#handledSignals = Object.freeze([
      ...(options.handledSignals ?? ["SIGINT", "SIGTERM"]),
    ]);
    this.#onSignal = options.onSignal;
    this.#rawMode = options.rawMode ?? true;
    this.#bracketedPaste = options.bracketedPaste ?? true;
    this.#hideCursor = options.hideCursor ?? true;
  }

  public get opened(): boolean {
    return this.#opened;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public open(): void {
    if (this.#opened) return;
    if (this.#closed) throw new Error("A closed terminal session cannot be reopened.");
    this.#initialRaw = this.#input.isRaw === true;
    const failures: unknown[] = [];
    try {
      if (this.#rawMode && this.#input.isTTY === true) {
        if (typeof this.#input.setRawMode !== "function") {
          throw new Error("Raw terminal mode is unavailable for this input.");
        }
        this.#input.setRawMode(true);
      }
      const openBytes =
        (this.#bracketedPaste ? ENABLE_BRACKETED_PASTE : "") +
        (this.#hideCursor ? HIDE_CURSOR : "");
      if (openBytes.length > 0) this.#output.write(openBytes);
      this.#registerListeners();
      this.#opened = true;
    } catch (error) {
      failures.push(error);
      failures.push(...this.#cleanupSteps());
      this.#closed = true;
      throw aggregateFailures("Terminal setup and restoration failed.", failures);
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#opened) return;
    const failures = this.#cleanupSteps();
    if (failures.length > 0) {
      throw aggregateFailures("Terminal restoration failed.", failures);
    }
  }

  public async run<T>(operation: () => Promise<T> | T): Promise<T> {
    let primaryFailure: unknown;
    let failed = false;
    try {
      this.open();
      return await operation();
    } catch (error) {
      failed = true;
      primaryFailure = error;
      throw error;
    } finally {
      try {
        this.close();
      } catch (cleanupFailure) {
        if (!failed) throw cleanupFailure;
        throw aggregateFailures(
          "Terminal operation failed and cleanup also failed.",
          [primaryFailure, ...flattenFailures(cleanupFailure)],
          primaryFailure,
        );
      }
    }
  }

  #registerListeners(): void {
    if (this.#signals === undefined || this.#onSignal === undefined) return;
    for (const signal of this.#handledSignals) {
      if (this.#listeners.has(signal)) continue;
      const listener = () => this.#onSignal?.(signal);
      this.#signals.on(signal, listener);
      this.#listeners.set(signal, listener);
    }
  }

  #cleanupSteps(): unknown[] {
    const failures: unknown[] = [];
    for (const [signal, listener] of this.#listeners) {
      try {
        this.#signals?.off(signal, listener);
      } catch (error) {
        failures.push(error);
      }
    }
    this.#listeners.clear();
    try {
      this.#output.write(TERMINAL_CLEANUP_BYTES);
    } catch (error) {
      failures.push(error);
    }
    if (
      this.#rawMode &&
      this.#input.isTTY === true &&
      typeof this.#input.setRawMode === "function"
    ) {
      try {
        this.#input.setRawMode(this.#initialRaw);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}

function flattenFailures(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
}

function aggregateFailures(
  message: string,
  failures: readonly unknown[],
  cause?: unknown,
): AggregateError {
  return cause === undefined
    ? new AggregateError(failures, message)
    : new AggregateError(failures, message, { cause });
}
