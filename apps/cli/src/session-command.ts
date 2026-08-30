import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  createPreviewRobinApplication,
  type EphemeralRobinApplication,
  type RobinAgentEvent,
} from "@guard/robin-application";

import {
  CliUsageError,
  type InteractiveCliRequest,
  type PrintCliRequest,
  type SessionCliRequest,
} from "./argv.js";
import { exitCodeForErrorCode } from "./exit-codes.js";

export interface SessionWriter {
  write(chunk: string): unknown;
}

export interface SessionCommandDependencies {
  readonly input: Readable;
  readonly createApplication: (
    sessionId: string,
    modelId?: string,
  ) => EphemeralRobinApplication;
  readonly nextSessionId?: () => string;
}

export const DEFAULT_SESSION_COMMAND_DEPENDENCIES: SessionCommandDependencies =
  Object.freeze({
    input: process.stdin,
    createApplication: createPreviewRobinApplication,
    nextSessionId: () => `ephemeral-${randomUUID()}`,
  });

export async function executeSessionCommand(
  request: SessionCliRequest,
  stdout: SessionWriter,
  stderr: SessionWriter,
  dependencies: SessionCommandDependencies =
    DEFAULT_SESSION_COMMAND_DEPENDENCIES,
): Promise<number> {
  if (request.provider !== "synthetic") {
    throw new CliUsageError(
      "Only the credential-free synthetic provider is available in this preview.",
    );
  }
  const modelId = request.model ?? "synthetic-preview-v1";
  if (modelId !== "synthetic-preview-v1") {
    throw new CliUsageError(
      "The synthetic preview supports only model synthetic-preview-v1.",
    );
  }
  const application = dependencies.createApplication(
    dependencies.nextSessionId?.() ?? `ephemeral-${randomUUID()}`,
    modelId,
  );
  return request.kind === "interactive"
    ? executeInteractive(request, application, dependencies.input, stdout, stderr)
    : executePrint(request, application, stdout, stderr);
}

async function executeInteractive(
  request: InteractiveCliRequest,
  application: EphemeralRobinApplication,
  input: Readable,
  stdout: SessionWriter,
  stderr: SessionWriter,
): Promise<number> {
  stdout.write(
    "Robin · synthetic preview · ephemeral · " +
      request.permissionMode +
      " mode\n" +
      "No repository, process, network, credential, or persistence tools are enabled.\n" +
      "Type /help for local commands or /exit to close.\n\n",
  );

  if (request.prompt !== null) {
    await renderInteractiveTurn(application, request.prompt, stdout);
  }

  const terminal = isTerminalInput(input) && isTerminalOutput(stdout);
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
    ...(terminal
      ? { output: stdout as Writable, terminal: true }
      : { terminal: false }),
  });
  try {
    stdout.write("> ");
    for await (const line of lines) {
      const command = line.trim();
      if (command === "/exit" || command === "/quit") {
        break;
      }
      if (command === "/help") {
        stdout.write(
          "Local commands: /help, /exit. Prompts run through the credential-free synthetic preview.\n",
        );
      } else if (command.startsWith("/")) {
        stdout.write("Unknown local command. Type /help for available commands.\n");
      } else if (command.length > 0) {
        await renderInteractiveTurn(application, line, stdout);
      }
      stdout.write("> ");
    }
  } finally {
    lines.close();
  }
  stderr.write("Robin preview session closed; ephemeral conversation was not saved.\n");
  return 0;
}

async function renderInteractiveTurn(
  application: EphemeralRobinApplication,
  prompt: string,
  stdout: SessionWriter,
): Promise<void> {
  const controller = new AbortController();
  let wroteText = false;
  let terminalFailure: Extract<
    RobinAgentEvent,
    { readonly type: "turn_failed" | "turn_cancelled" }
  > | null = null;
  let didCatch = false;
  let caughtError: unknown;
  try {
    for await (const event of application.submit(prompt, controller.signal)) {
      if (event.type === "assistant_text_delta") {
        stdout.write(sanitizeTerminalText(event.delta));
        wroteText = true;
      } else if (
        event.type === "turn_failed" ||
        event.type === "turn_cancelled"
      ) {
        terminalFailure = event;
      }
    }
  } catch (error) {
    didCatch = true;
    caughtError = error;
  }
  if (terminalFailure === null) {
    if (didCatch) throw caughtError;
    if (wroteText) stdout.write("\n\n");
    return;
  }
  if (wroteText) stdout.write("\n");
  stdout.write(
      `Robin turn ${terminalFailure.type === "turn_cancelled" ? "cancelled" : "failed"} ` +
      `(${terminalFailure.error.code}): ` +
      `${sanitizeTerminalDiagnostic(terminalFailure.error.message)}\n\n`,
  );
}

interface PreviewEventRecord {
  readonly sequence: number;
  readonly event: RobinAgentEvent;
}

async function executePrint(
  request: PrintCliRequest,
  application: EphemeralRobinApplication,
  stdout: SessionWriter,
  stderr: SessionWriter,
): Promise<number> {
  const events: PreviewEventRecord[] = [];
  let finalText = "";
  let terminalFailure: Extract<
    RobinAgentEvent,
    { readonly type: "turn_failed" | "turn_cancelled" }
  > | null = null;
  let didCatch = false;
  let caughtError: unknown;
  try {
    for await (const event of application.submit(
      request.prompt,
      new AbortController().signal,
    )) {
      const portableEvent = event;
      const record = Object.freeze({
        sequence: events.length + 1,
        event: portableEvent,
      });
      events.push(record);
      if (request.outputFormat === "stream-json") {
        stdout.write(
          serializeMachineJson({
            schemaVersion: 1,
            stability: "experimental",
            sessionId: application.snapshot.sessionId,
            persistence: "ephemeral",
            permissionMode: request.permissionMode,
            permissions: "inactive-no-tools",
            maximumAgentTurns: request.maximumTurns,
            sequence: record.sequence,
            event: portableEvent,
          }) + "\n",
        );
      }
      if (portableEvent.type === "turn_completed") finalText = portableEvent.text;
      if (
        portableEvent.type === "turn_failed" ||
        portableEvent.type === "turn_cancelled"
      ) {
        terminalFailure = portableEvent;
      }
    }
  } catch (error) {
    didCatch = true;
    caughtError = error;
  }

  if (didCatch && terminalFailure === null) {
    throw caughtError;
  }
  if (terminalFailure !== null) {
    const status =
      terminalFailure.type === "turn_cancelled" ? "cancelled" : "failed";
    if (request.outputFormat === "text") {
      stderr.write(
        `robin: Turn ${status} (${terminalFailure.error.code}): ` +
          `${sanitizeTerminalDiagnostic(terminalFailure.error.message)}\n`,
      );
    } else if (request.outputFormat === "json") {
      stdout.write(
        serializeMachineJson({
          ...previewResultMetadata(request, application),
          status,
          result: null,
          error: terminalFailure.error,
          events,
        }) + "\n",
      );
    }
    return exitCodeForErrorCode(terminalFailure.error.code);
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
  application: EphemeralRobinApplication,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    stability: "experimental",
    sessionId: application.snapshot.sessionId,
    persistence: "ephemeral",
    saved: false,
    permissionMode: request.permissionMode,
    permissions: "inactive-no-tools",
    maximumAgentTurns: request.maximumTurns,
    usedAgentTurns: 1,
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
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint >= 0x20 &&
      codePoint !== 0x7f &&
      (codePoint < 0x80 || codePoint > 0x9f) &&
      (codePoint < 0xd800 || codePoint > 0xdfff) &&
      codePoint !== 0x2028 &&
      codePoint !== 0x2029
    ) {
      safe += character;
    } else {
      safe += "\\u{" + codePoint.toString(16).padStart(2, "0") + "}";
    }
  }
  return safe;
}

function serializeMachineJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/gu, (character) =>
    "\\u" + character.codePointAt(0)!.toString(16).padStart(4, "0"),
  );
}

function isTerminalInput(input: Readable): boolean {
  return (input as Readable & { readonly isTTY?: boolean }).isTTY === true;
}

function isTerminalOutput(output: SessionWriter): output is SessionWriter & Writable {
  return (output as SessionWriter & { readonly isTTY?: boolean }).isTTY === true;
}
