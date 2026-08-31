import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type {
  R1RobinApplication,
  RobinApplicationEvent,
} from "@guard/robin-application";
import {
  FlatRenderer,
  TerminalKeyDecoder,
  TerminalSession,
  buildTerminalFrame,
  createReplState,
  detectTerminalCapabilities,
  inputBufferText,
  reduceRepl,
  writeTerminalFrame,
  type DecodedKeyEvent,
  type ReplEvent,
  type ReplState,
  type TerminalCapabilities,
  type TerminalFrame,
} from "@guard/robin-terminal";

import type { InteractiveCliRequest } from "./argv.js";
import { EXIT_CODES } from "./exit-codes.js";
import {
  InteractiveInterruptController,
  InterruptEscalator,
} from "./signal-handler.js";

export interface InteractiveInput extends Readable {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
}

export interface InteractiveOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): unknown;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

export interface InteractiveEnvironment {
  readonly TERM?: string;
  readonly NO_COLOR?: string;
  readonly CI?: string;
  readonly LANG?: string;
  readonly LC_ALL?: string;
  readonly LC_CTYPE?: string;
  readonly ROBIN_SCREEN_READER?: string;
  readonly ROBIN_REDUCED_MOTION?: string;
  readonly ROBIN_UNICODE?: string;
}

export interface InteractiveSessionRuntime {
  /** Aborted by the executable wrapper when terminal output becomes unusable. */
  readonly outputFailureSignal?: AbortSignal;
  /** Test seam for deterministic two-stage interrupt timing. */
  readonly interruptEscalator?: InterruptEscalator;
}

export async function executeInteractiveSession(
  request: InteractiveCliRequest,
  application: R1RobinApplication,
  input: InteractiveInput,
  stdout: InteractiveOutput,
  stderr: { write(chunk: string): unknown },
  environment: InteractiveEnvironment = process.env,
  runtime: InteractiveSessionRuntime = {},
): Promise<number> {
  if (abortSignalRaised(runtime.outputFailureSignal)) {
    await application.close("error");
    return EXIT_CODES.infrastructureFailed;
  }
  const capabilities = detectCapabilities(
    input,
    stdout,
    environment,
  );
  const exitCode = capabilities.rawMode
    ? await runRawSession(
        request,
        application,
        input,
        stdout,
        capabilities,
        runtime,
      )
    : await runFlatSession(request, application, input, stdout, runtime);
  if (abortSignalRaised(runtime.outputFailureSignal)) {
    return EXIT_CODES.infrastructureFailed;
  }
  stderr.write(
    "Robin session closed; the ephemeral conversation was not saved.\n",
  );
  return exitCode;
}

function detectCapabilities(
  input: InteractiveInput,
  output: InteractiveOutput,
  environment: InteractiveEnvironment,
): TerminalCapabilities {
  const locale =
    environment.LC_ALL ?? environment.LC_CTYPE ?? environment.LANG ?? null;
  return detectTerminalCapabilities({
    stdinIsTTY: input.isTTY === true,
    stdoutIsTTY: output.isTTY === true,
    term: environment.TERM ?? null,
    noColor: environment.NO_COLOR ?? null,
    ci: environment.CI ?? null,
    locale,
    columns: output.columns ?? null,
    rows: output.rows ?? null,
    screenReader: environment.ROBIN_SCREEN_READER === "1",
    reducedMotionOverride:
      environment.ROBIN_REDUCED_MOTION === undefined
        ? null
        : environment.ROBIN_REDUCED_MOTION === "1",
    unicodeOverride:
      environment.ROBIN_UNICODE === undefined
        ? null
        : environment.ROBIN_UNICODE === "1",
  });
}

async function runFlatSession(
  request: InteractiveCliRequest,
  application: R1RobinApplication,
  input: InteractiveInput,
  stdout: InteractiveOutput,
  runtime: InteractiveSessionRuntime,
): Promise<number> {
  const renderer = new FlatRenderer(stdout);
  const pending = new Set<Promise<void>>();
  let lines: ReturnType<typeof createInterface> | null = null;
  let primaryFailure: unknown;
  let primaryFailureSet = false;
  let cleanupFailure: unknown;
  let outputFailed = abortSignalRaised(runtime.outputFailureSignal);
  let closePromise: Promise<void> | null = null;

  const rememberFailure = (error: unknown): void => {
    if (!primaryFailureSet) {
      primaryFailureSet = true;
      primaryFailure = error;
    }
  };
  const closeApplication = (
    reason: "user" | "eof" | "error",
  ): Promise<void> => {
    if (closePromise !== null) return closePromise;
    try {
      closePromise = application.close(reason).catch((error: unknown) => {
        cleanupFailure ??= error;
      });
    } catch (error) {
      cleanupFailure ??= error;
      closePromise = Promise.resolve();
    }
    return closePromise;
  };
  const closeInput = (): void => {
    try {
      lines?.close();
    } catch (error) {
      rememberFailure(error);
    }
  };
  const fail = (error: unknown): void => {
    rememberFailure(error);
    closeInput();
    void closeApplication("error");
  };
  const handleOutputFailure = (): void => {
    outputFailed = true;
    closeInput();
    void closeApplication("error");
  };
  const detachOutputFailure = linkAbortSignal(
    runtime.outputFailureSignal,
    handleOutputFailure,
  );

  const launch = (prompt: string): "continue" | "exit" => {
    const command = prompt.trim();
    if (command === "/exit" || command === "/quit") {
      closeInput();
      void closeApplication("user");
      return "exit";
    }
    if (command === "/help") {
      renderer.append({
        type: "diagnostic",
        code: "help",
        message: "Enter a prompt; /exit closes; Ctrl-C cancels; Ctrl-D closes when idle.",
      });
      return "continue";
    }
    if (command.startsWith("/")) {
      renderer.append({
        type: "diagnostic",
        code: "unknown_local_command",
        message: "Unknown local command. Type /help for available commands.",
      });
      return "continue";
    }
    renderer.append({ type: "user_message", text: prompt });
    let running!: Promise<void>;
    running = consumeFlatTurn(
      application.submit(prompt, new AbortController().signal),
      renderer,
      runtime.outputFailureSignal,
    )
      .then(undefined, fail)
      .finally(() => pending.delete(running));
    pending.add(running);
    return "continue";
  };

  try {
    if (!outputFailed) {
      renderer.append({
        type: "session_started",
        label: `Robin · synthetic coding loop · ephemeral · ${request.permissionMode} mode`,
      });
      const initialResult =
        request.prompt === null ? "continue" : launch(request.prompt);
      if (initialResult !== "exit" && !outputFailed && !primaryFailureSet) {
        lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
        for await (const line of lines) {
          if (outputFailed || primaryFailureSet) break;
          if (line.trim().length > 0 && launch(line) === "exit") break;
        }
      }
      // Flat input is commonly a finite pipe. Let already-submitted work finish
      // naturally on EOF, but explicit exit/failure starts bounded close above.
      if (
        closePromise === null &&
        !outputFailed &&
        !primaryFailureSet
      ) {
        await settleConsumers(pending);
      }
    }
  } catch (error) {
    fail(error);
  } finally {
    closeInput();
  }

  await closeApplication(
    primaryFailureSet || outputFailed ? "error" : "eof",
  );
  await settleConsumers(pending);
  detachOutputFailure();
  if (primaryFailureSet && cleanupFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      "The flat session and application cleanup both failed.",
      { cause: primaryFailure },
    );
  }
  if (primaryFailureSet) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (outputFailed) return EXIT_CODES.infrastructureFailed;
  return EXIT_CODES.success;
}

async function consumeFlatTurn(
  events: AsyncIterable<RobinApplicationEvent>,
  renderer: FlatRenderer,
  outputFailureSignal: AbortSignal | undefined,
): Promise<void> {
  for await (const event of events) {
    if (abortSignalRaised(outputFailureSignal)) break;
    switch (event.type) {
      case "UserMessageQueued":
        renderer.append({
          type: "queued",
          position: event.payload.position,
          text: event.payload.text,
        });
        break;
      case "AssistantTextDelta":
        renderer.append({ type: "assistant_text", text: event.payload.text });
        break;
      case "ToolCallStarted":
        renderer.append({
          type: "tool_status",
          name: event.payload.toolName,
          status: "started",
        });
        break;
      case "ToolCallCompleted":
        renderer.append({
          type: "tool_status",
          name: event.payload.toolName,
          status: "completed",
          summary: summarizeObservation(event.payload.observation),
        });
        break;
      case "ToolCallFailed":
        renderer.append({
          type: "tool_status",
          name: event.payload.toolName,
          status: "failed",
          summary: `${event.payload.code}: ${event.payload.message}`,
        });
        break;
      case "UsageReported":
        renderer.append({
          type: "usage",
          inputTokens: event.payload.inputTokens,
          outputTokens: event.payload.outputTokens,
        });
        break;
      case "TurnCancellationRequested":
        renderer.append({ type: "cancelling" });
        break;
      case "TurnCancelled":
        renderer.append({ type: "error", message: event.payload.reason });
        break;
      case "TurnFailed":
        renderer.append({
          type: "error",
          message: `${event.payload.code}: ${event.payload.message}`,
        });
        break;
      case "BudgetExhausted":
        renderer.append({
          type: "error",
          message:
            `budget_exceeded: ${event.payload.dimension} ` +
            `${event.payload.used}/${event.payload.limit}`,
        });
        break;
      case "TurnCompleted":
        renderer.append({ type: "completed", text: event.payload.text });
        break;
      case "SessionStarted":
      case "PermissionModeChanged":
      case "UserMessageAccepted":
      case "TurnStarted":
      case "BudgetWarning":
      case "SessionClosed":
        break;
    }
  }
}

async function runRawSession(
  request: InteractiveCliRequest,
  application: R1RobinApplication,
  input: InteractiveInput,
  stdout: InteractiveOutput,
  initialCapabilities: TerminalCapabilities,
  runtime: InteractiveSessionRuntime,
): Promise<number> {
  const decoder = new TerminalKeyDecoder();
  const interrupts = new InteractiveInterruptController(
    runtime.interruptEscalator ?? new InterruptEscalator(),
  );
  let state = createReplState({
    columns: initialCapabilities.columns,
    rows: initialCapabilities.rows,
  });
  let previousFrame: TerminalFrame | null = null;
  let resolving = false;
  let lifecycleFailureSet = false;
  let cleanupFailure: unknown;
  let outputFailed = abortSignalRaised(runtime.outputFailureSignal);
  let closePromise: Promise<void> | null = null;
  const consumers = new Set<Promise<void>>();
  let resolveDone!: (exitCode: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const rememberFailure = (error: unknown): void => {
    if (!lifecycleFailureSet) {
      lifecycleFailureSet = true;
    }
  };
  const closeApplication = (
    reason: "user" | "eof" | "shutdown" | "error",
  ): Promise<void> => {
    if (closePromise !== null) return closePromise;
    try {
      closePromise = application.close(reason).catch((error: unknown) => {
        cleanupFailure ??= error;
      });
    } catch (error) {
      cleanupFailure ??= error;
      closePromise = Promise.resolve();
    }
    return closePromise;
  };
  const render = (): void => {
    if (abortSignalRaised(runtime.outputFailureSignal)) return;
    const capabilities = Object.freeze({
      ...initialCapabilities,
      columns: state.columns,
      rows: state.rows,
    });
    const next = buildTerminalFrame(state, capabilities);
    writeTerminalFrame(stdout, previousFrame, next);
    previousFrame = next;
  };

  const finish = (
    exitCode: number,
    reason: "user" | "eof" | "shutdown" | "error",
  ): void => {
    if (resolving) return;
    resolving = true;
    const settlement = (async (): Promise<void> => {
      await closeApplication(reason);
      await settleConsumers(consumers);
      resolveDone(
        lifecycleFailureSet ||
          cleanupFailure !== undefined ||
          outputFailed
          ? EXIT_CODES.infrastructureFailed
          : exitCode,
      );
    })();
    void settlement.catch((error: unknown) => {
      rememberFailure(error);
      resolveDone(EXIT_CODES.infrastructureFailed);
    });
  };

  const fail = (error: unknown): void => {
    rememberFailure(error);
    finish(EXIT_CODES.infrastructureFailed, "error");
  };

  const handleEffects = (effects: ReturnType<typeof reduceRepl>["effects"]): void => {
    for (const effect of effects) {
      switch (effect.type) {
        case "submit_message": {
          const controller = new AbortController();
          let running!: Promise<void>;
          running = consumeRawTurn(
            application.submit(effect.text, controller.signal),
            applyApplicationEvent,
          )
            .then(undefined, (error: unknown) => {
              rememberFailure(error);
              if (!resolving && !outputFailed) {
                try {
                  apply({
                    type: "fatal",
                    message:
                      error instanceof Error
                        ? error.message
                        : "The application event stream failed.",
                  });
                } catch (renderError) {
                  rememberFailure(renderError);
                }
              }
              finish(EXIT_CODES.infrastructureFailed, "error");
            })
            .finally(() => consumers.delete(running));
          consumers.add(running);
          break;
        }
        case "request_cancel":
          application.cancelActiveTurn("user_interrupt");
          break;
        case "force_exit":
          finish(EXIT_CODES.cancelled, "shutdown");
          break;
        case "close":
          finish(EXIT_CODES.success, "user");
          break;
      }
    }
  };

  const apply = (event: ReplEvent): void => {
    const transition = reduceRepl(state, event);
    state = transition.state;
    render();
    handleEffects(transition.effects);
  };

  const applyApplicationEvent = (event: RobinApplicationEvent): void => {
    switch (event.type) {
      case "TurnStarted":
        apply({ type: "turn_started" });
        break;
      case "AssistantTextDelta":
        apply({ type: "assistant_delta", text: event.payload.text });
        break;
      case "ToolCallStarted":
        apply({
          type: "tool_started",
          callId: event.payload.callId,
          name: event.payload.toolName,
        });
        break;
      case "ToolCallCompleted":
        apply({
          type: "tool_completed",
          callId: event.payload.callId,
          summary: summarizeObservation(event.payload.observation),
        });
        break;
      case "ToolCallFailed":
        apply({
          type: "tool_failed",
          callId: event.payload.callId,
          summary: `${event.payload.code}: ${event.payload.message}`,
        });
        break;
      case "UsageReported":
        apply({
          type: "usage_reported",
          inputTokens: event.payload.inputTokens,
          outputTokens: event.payload.outputTokens,
        });
        break;
      case "TurnCompleted":
        interrupts.reset();
        apply({ type: "turn_completed", text: event.payload.text });
        break;
      case "TurnFailed":
        interrupts.reset();
        apply({
          type: "turn_failed",
          message: `${event.payload.code}: ${event.payload.message}`,
        });
        break;
      case "BudgetExhausted":
        interrupts.reset();
        apply({
          type: "turn_failed",
          message:
            `budget_exceeded: ${event.payload.dimension} ` +
            `${event.payload.used}/${event.payload.limit}`,
        });
        break;
      case "TurnCancelled":
        interrupts.reset();
        apply({ type: "turn_cancelled", message: event.payload.reason });
        break;
      case "SessionStarted":
      case "PermissionModeChanged":
      case "UserMessageQueued":
      case "UserMessageAccepted":
      case "BudgetWarning":
      case "TurnCancellationRequested":
      case "SessionClosed":
        break;
    }
  };

  const applyLocalCommand = (): boolean => {
    const command = inputBufferText(state.input).trim();
    if (command === "/exit" || command === "/quit") {
      finish(EXIT_CODES.success, "user");
      return true;
    }
    if (command === "/help") {
      apply({
        type: "local_command",
        kind: "notice",
        message:
          "Enter a prompt; /exit closes; Ctrl-C cancels; Ctrl-D closes when idle.",
      });
      return true;
    }
    if (command.startsWith("/")) {
      apply({
        type: "local_command",
        kind: "error",
        message: "Unknown local command. Type /help for available commands.",
      });
      return true;
    }
    return false;
  };

  const applyKey = (key: DecodedKeyEvent): void => {
    if (resolving) return;
    if (key.type === "ctrl_c") {
      const decision = interrupts.interrupt(state.status);
      if (decision === "force_exit") {
        finish(EXIT_CODES.cancelled, "shutdown");
        return;
      }
      if (decision === "request_cancel") {
        application.cancelActiveTurn("user_interrupt");
        return;
      }
    }
    if (key.type === "enter" && applyLocalCommand()) return;
    apply({ type: "key", key });
  };

  const onData = (chunk: Buffer | string): void => {
    if (resolving) return;
    try {
      const batch = decoder.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
      for (const diagnostic of batch.diagnostics) {
        apply({ type: "decoder_diagnostic", diagnostic });
      }
      for (const event of batch.events) applyKey(event);
    } catch (error) {
      fail(error);
    }
  };
  const onEnd = (): void => {
    if (resolving) return;
    try {
      const batch = decoder.end();
      for (const diagnostic of batch.diagnostics) {
        apply({ type: "decoder_diagnostic", diagnostic });
      }
      for (const event of batch.events) applyKey(event);
      finish(EXIT_CODES.success, "eof");
    } catch (error) {
      fail(error);
    }
  };
  const onResize = (): void => {
    if (resolving) return;
    try {
      const batch = decoder.resize(stdout.columns ?? 80, stdout.rows ?? 24);
      for (const event of batch.events) applyKey(event);
    } catch (error) {
      fail(error);
    }
  };
  const handleOutputFailure = (): void => {
    outputFailed = true;
    fail(new Error("Terminal output became unavailable."));
  };
  const detachOutputFailure = linkAbortSignal(
    runtime.outputFailureSignal,
    handleOutputFailure,
  );

  const terminal = new TerminalSession({
    input,
    output: stdout,
    signals: process,
    onSignal: (signal) => {
      try {
        if (signal === "SIGINT") applyKey({ type: "ctrl_c" });
        else finish(EXIT_CODES.cancelled, "shutdown");
      } catch (error) {
        fail(error);
      }
    },
  });

  try {
    const exitCode = await terminal.run(async () => {
      render();
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onEnd);
      stdout.on?.("resize", onResize);
      input.resume();
      if (request.prompt !== null) {
        applyKey({ type: "text", text: request.prompt });
        applyKey({ type: "enter" });
      }
      try {
        return await done;
      } finally {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("close", onEnd);
        input.pause();
        stdout.off?.("resize", onResize);
      }
    });
    return lifecycleFailureSet || cleanupFailure !== undefined || outputFailed
      ? EXIT_CODES.infrastructureFailed
      : exitCode;
  } catch (error) {
    rememberFailure(error);
    await closeApplication("error");
    await settleConsumers(consumers);
    if (cleanupFailure !== undefined && cleanupFailure !== error) {
      throw new AggregateError(
        [error, cleanupFailure],
        "The terminal and application cleanup both failed.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    detachOutputFailure();
  }
}

async function consumeRawTurn(
  events: AsyncIterable<RobinApplicationEvent>,
  apply: (event: RobinApplicationEvent) => void,
): Promise<void> {
  for await (const event of events) apply(event);
}

async function settleConsumers(consumers: ReadonlySet<Promise<void>>): Promise<void> {
  while (consumers.size > 0) {
    await Promise.allSettled([...consumers]);
  }
}

function linkAbortSignal(
  signal: AbortSignal | undefined,
  abort: () => void,
): () => void {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function abortSignalRaised(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function summarizeObservation(observation: object): string {
  const serialized = JSON.stringify(observation);
  return [...serialized].slice(0, 160).join("") +
    ([...serialized].length > 160 ? "…" : "");
}
