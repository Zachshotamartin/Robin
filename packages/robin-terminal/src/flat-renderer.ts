import { sanitizeTerminalData } from "./renderer.js";

export type FlatRenderEvent =
  | { readonly type: "session_started"; readonly label: string }
  | { readonly type: "user_message"; readonly text: string }
  | { readonly type: "assistant_text"; readonly text: string }
  | {
      readonly type: "tool_status";
      readonly name: string;
      readonly status: "started" | "completed" | "failed";
      readonly summary?: string;
    }
  | { readonly type: "queued"; readonly position: number; readonly text: string }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | { readonly type: "cancelling" }
  | { readonly type: "completed"; readonly text: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "diagnostic"; readonly code: string; readonly message: string };

export interface FlatWriter {
  write(bytes: string): unknown;
}

export function renderFlatEvent(event: FlatRenderEvent): string {
  switch (event.type) {
    case "session_started":
      return `[session] ${safeLine(event.label)}\n`;
    case "user_message":
      return `[you] ${safeMultiline(event.text)}\n`;
    case "assistant_text":
      return `[assistant] ${safeMultiline(event.text)}\n`;
    case "tool_status":
      return `[tool:${event.status}] ${safeLine(event.name)}${
        event.summary === undefined ? "" : ` — ${safeMultiline(event.summary)}`
      }\n`;
    case "queued":
      return `[queued:${event.position}] ${safeMultiline(event.text)}\n`;
    case "usage":
      return `[usage] input=${event.inputTokens} output=${event.outputTokens}\n`;
    case "cancelling":
      return "[status] Cancelling\n";
    case "completed":
      return `[completed] ${safeMultiline(event.text)}\n`;
    case "error":
      return `[error] ${safeMultiline(event.message)}\n`;
    case "diagnostic":
      return `[diagnostic:${safeLine(event.code)}] ${safeMultiline(event.message)}\n`;
  }
}

export class FlatRenderer {
  readonly #writer: FlatWriter;
  #linesWritten = 0;

  public constructor(writer: FlatWriter) {
    this.#writer = writer;
  }

  public get linesWritten(): number {
    return this.#linesWritten;
  }

  public append(event: FlatRenderEvent): void {
    const bytes = renderFlatEvent(event);
    this.#writer.write(bytes);
    this.#linesWritten += bytes.split("\n").length - 1;
  }
}

function safeLine(value: string): string {
  return safeMultiline(value).replaceAll("\n", "\\n");
}

function safeMultiline(value: string): string {
  return sanitizeTerminalData(value);
}
