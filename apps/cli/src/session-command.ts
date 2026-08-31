import { randomUUID } from "node:crypto";

import {
  type R1RobinApplication,
  type RobinApplicationEvent,
} from "@guard/robin-application";

import {
  DEFAULT_MAXIMUM_SESSION_TURNS,
  CliUsageError,
  type PrintCliRequest,
  type SessionCliRequest,
  type SessionPermissionMode,
} from "./argv.js";
import { createCliSessionApplication } from "./composition.js";
import { EXIT_CODES, exitCodeForErrorCode } from "./exit-codes.js";
import {
  executeInteractiveSession,
  type InteractiveEnvironment,
  type InteractiveInput,
  type InteractiveOutput,
} from "./interactive.js";
import type { CliRuntimeContext } from "./main.js";
import type { InterruptEscalator } from "./signal-handler.js";

export interface SessionWriter {
  write(chunk: string): unknown;
}

export interface SessionCommandDependencies {
  readonly input: InteractiveInput;
  readonly environment?: InteractiveEnvironment;
  readonly createApplication: (
    sessionId: string,
    modelId: string,
    maximumTurns: number,
    permissionMode: SessionPermissionMode,
  ) => R1RobinApplication;
  readonly nextSessionId?: () => string;
}

export interface SessionCommandRuntime extends CliRuntimeContext {
  /** Test seam for deterministic two-stage interrupt timing. */
  readonly interruptEscalator?: InterruptEscalator;
}

export const DEFAULT_SESSION_COMMAND_DEPENDENCIES: SessionCommandDependencies =
  Object.freeze({
    input: process.stdin,
    environment: process.env,
    createApplication: createCliSessionApplication,
    nextSessionId: () => `ephemeral-${randomUUID()}`,
  });

export async function executeSessionCommand(
  request: SessionCliRequest,
  stdout: SessionWriter,
  stderr: SessionWriter,
  dependencies: SessionCommandDependencies =
    DEFAULT_SESSION_COMMAND_DEPENDENCIES,
  runtime: SessionCommandRuntime = {},
): Promise<number> {
  if (request.provider !== "synthetic") {
    throw new CliUsageError(
      "R1 supports only the credential-free synthetic provider; hosted providers arrive in a later gate.",
    );
  }
  const modelId = request.model ?? "synthetic-r1-v1";
  if (modelId !== "synthetic-r1-v1") {
    throw new CliUsageError(
      "The R1 synthetic provider supports only model synthetic-r1-v1.",
    );
  }
  const maximumTurns =
    request.kind === "print"
      ? request.maximumTurns
      : DEFAULT_MAXIMUM_SESSION_TURNS;
  const application = dependencies.createApplication(
    dependencies.nextSessionId?.() ?? `ephemeral-${randomUUID()}`,
    modelId,
    maximumTurns,
    request.permissionMode,
  );
  return request.kind === "interactive"
    ? executeInteractiveSession(
        request,
        application,
        dependencies.input,
        stdout as InteractiveOutput,
        stderr,
        dependencies.environment ?? process.env,
        runtime,
      )
    : executePrint(request, application, stdout, stderr, runtime);
}

async function executePrint(
  request: PrintCliRequest,
  application: R1RobinApplication,
  stdout: SessionWriter,
  stderr: SessionWriter,
  runtime: SessionCommandRuntime,
): Promise<number> {
  const events: RobinApplicationEvent[] = [];
  const submission = new AbortController();
  let closePromise: Promise<void> | null = null;
  const closeApplication = (
    reason: "eof" | "error",
  ): Promise<void> => {
    closePromise ??= application.close(reason);
    return closePromise;
  };
  if (abortSignalRaised(runtime.outputFailureSignal)) {
    await closeApplication("error");
    return EXIT_CODES.infrastructureFailed;
  }
  const detachOutputFailure = linkAbortSignal(
    runtime.outputFailureSignal,
    () => {
      submission.abort("output_failure");
      void closeApplication("error").catch(() => {});
    },
  );
  let finalText = "";
  let terminalFailure:
    | Extract<
        RobinApplicationEvent,
        {
          readonly type:
            | "TurnFailed"
            | "TurnCancelled"
            | "BudgetExhausted";
        }
      >
    | null = null;
  try {
    for await (const event of application.submit(
      request.prompt,
      submission.signal,
    )) {
      if (abortSignalRaised(runtime.outputFailureSignal)) break;
      events.push(event);
      if (request.outputFormat === "stream-json") {
        stdout.write(
          serializeMachineJson({
            schemaVersion: 1,
            stability: "experimental",
            sessionId: application.snapshot.sessionId,
            persistence: "ephemeral",
            permissionMode: request.permissionMode,
            permissions: "synthetic-fixture-tools",
            maximumAgentTurns: request.maximumTurns,
            sequence: event.sequence,
            event,
          }) + "\n",
        );
      }
      if (event.type === "TurnCompleted") finalText = event.payload.text;
      if (
        event.type === "TurnFailed" ||
        event.type === "TurnCancelled" ||
        event.type === "BudgetExhausted"
      ) {
        terminalFailure = event;
      }
    }
  } finally {
    try {
      await closeApplication(
        abortSignalRaised(runtime.outputFailureSignal) ? "error" : "eof",
      );
    } finally {
      detachOutputFailure();
    }
  }

  if (abortSignalRaised(runtime.outputFailureSignal)) {
    return EXIT_CODES.infrastructureFailed;
  }

  if (terminalFailure !== null) {
    const code =
      terminalFailure.type === "TurnCancelled"
        ? "cancelled"
        : terminalFailure.type === "BudgetExhausted"
          ? "budget_exceeded"
          : terminalFailure.payload.code;
    const message =
      terminalFailure.type === "TurnCancelled"
        ? terminalFailure.payload.reason
        : terminalFailure.type === "BudgetExhausted"
          ? `${terminalFailure.payload.dimension} budget exhausted ` +
            `(${terminalFailure.payload.used}/${terminalFailure.payload.limit})`
          : terminalFailure.payload.message;
    if (request.outputFormat === "text") {
      stderr.write(
        `robin: Turn ${terminalFailure.type === "TurnCancelled" ? "cancelled" : "failed"} ` +
          `(${code}): ${sanitizeTerminalDiagnostic(message)}\n`,
      );
    } else if (request.outputFormat === "json") {
      stdout.write(
        serializeMachineJson({
          ...previewResultMetadata(request, application),
          status:
            terminalFailure.type === "TurnCancelled" ? "cancelled" : "failed",
          result: null,
          error: { code, message },
          events,
        }) + "\n",
      );
    }
    return exitCodeForErrorCode(code);
  }

  if (request.outputFormat === "text") {
    stdout.write(sanitizeTerminalText(finalText) + "\n");
  } else if (request.outputFormat === "json") {
    stdout.write(
      serializeMachineJson({
        ...previewResultMetadata(request, application),
        status: "completed",
        result: finalText,
        events,
      }) + "\n",
    );
  }
  return 0;
}

function previewResultMetadata(
  request: PrintCliRequest,
  application: R1RobinApplication,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    stability: "experimental",
    sessionId: application.snapshot.sessionId,
    persistence: "ephemeral",
    saved: false,
    permissionMode: request.permissionMode,
    permissions: "synthetic-fixture-tools",
    maximumAgentTurns: request.maximumTurns,
    usedAgentTurns: application.snapshot.turnsStarted,
  });
}

export function sanitizeTerminalText(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      (codePoint >= 0x20 &&
        codePoint !== 0x7f &&
        (codePoint < 0x80 || codePoint > 0x9f) &&
        (codePoint < 0xd800 || codePoint > 0xdfff) &&
        codePoint !== 0x2028 &&
        codePoint !== 0x2029)
    ) {
      safe += character;
    } else {
      safe += "\\u{" + codePoint.toString(16).padStart(2, "0") + "}";
    }
  }
  return safe;
}

export function sanitizeTerminalDiagnostic(value: string): string {
  return sanitizeTerminalText(value).replaceAll("\n", "\\n");
}

function serializeMachineJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/gu,
    (character) =>
      "\\u" + character.codePointAt(0)!.toString(16).padStart(4, "0"),
  );
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
