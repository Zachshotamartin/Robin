import type { OutputFormat } from "./argv.js";

export interface RenderableEvent {
  readonly eventSchemaVersion: number;
  readonly streamVersion: number;
  readonly recordedAt: string;
  readonly eventType: string;
  readonly streamId: string;
  readonly payload: unknown;
}

export function renderRun(
  history: readonly RenderableEvent[],
  format: OutputFormat,
): string {
  switch (format) {
    case "human":
      return renderHuman(history);
    case "jsonl":
      return renderJsonl(history);
    case "quiet":
      return renderQuiet(history);
  }
}

export function renderJsonl(history: readonly RenderableEvent[]): string {
  if (history.length === 0) return "";
  const lines = history.map((event) =>
    JSON.stringify({
      schemaVersion: event.eventSchemaVersion,
      cursor: event.streamVersion,
      timestamp: event.recordedAt,
      type: event.eventType,
      runId: event.streamId,
      payload: event.payload,
    }),
  );
  return `${lines.join("\n")}\n`;
}

export function renderHuman(history: readonly RenderableEvent[]): string {
  if (history.length === 0) return "No domain events were recorded.\n";
  const first = history[0]!;
  const lines = [`Robin run ${first.streamId}`];
  for (const event of history) {
    lines.push(
      `${String(event.streamVersion).padStart(3, "0")}  ${event.recordedAt}  ${event.eventType}`,
    );
  }

  const terminal = findTerminalEvent(history);
  const result = terminalResult(terminal?.payload);
  if (result !== null) {
    const status = stringProperty(result, "status") ?? "unknown";
    lines.push(`Status: ${status}`);
    const outcome = recordProperty(result, "outcome");
    if (outcome !== null) {
      const outcomeType = stringProperty(outcome, "outcomeType") ?? "unknown";
      const payload = propertyValue(outcome, "payload");
      lines.push(`Outcome (${outcomeType}): ${JSON.stringify(payload)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Emits the completed outcome envelope and nothing else. */
export function renderQuiet(history: readonly RenderableEvent[]): string {
  const terminal = findTerminalEvent(history);
  if (terminal?.eventType !== "RunCompleted") return "";
  const result = terminalResult(terminal.payload);
  const outcome = result === null ? null : recordProperty(result, "outcome");
  return outcome === null ? "" : `${JSON.stringify(outcome)}\n`;
}

function findTerminalEvent(
  history: readonly RenderableEvent[],
): RenderableEvent | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index]!;
    if (
      event.eventType === "RunCompleted" ||
      event.eventType === "RunFailed" ||
      event.eventType === "RunCancelled" ||
      event.eventType === "RunOrphaned"
    ) {
      return event;
    }
  }
  return undefined;
}

function terminalResult(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  return recordProperty(payload, "result");
}

function recordProperty(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = propertyValue(record, key);
  return isRecord(value) ? value : null;
}

function stringProperty(record: Record<string, unknown>, key: string): string | null {
  const value = propertyValue(record, key);
  return typeof value === "string" ? value : null;
}

function propertyValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
