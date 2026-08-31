import {
  graphemeCellWidth,
  inputBufferText,
  segmentGraphemes,
} from "./input-buffer.js";
import type { ReplState, ReplTranscriptEntry } from "./repl-reducer.js";
import { MAXIMUM_REPL_INPUT_UTF8_BYTES } from "./repl-reducer.js";
import type { TerminalCapabilities } from "./terminal-capabilities.js";

const ESC = "\u001b";

export interface RenderCursor {
  readonly row: number;
  readonly column: number;
}

export interface TerminalFrame {
  readonly revision: number;
  readonly columns: number;
  readonly rows: readonly string[];
  readonly cursor: RenderCursor;
}

export interface FrameDiff {
  readonly bytes: string;
  readonly firstChangedRow: number | null;
  readonly lastChangedRow: number | null;
}

export interface TerminalFrameWriter {
  write(bytes: string): unknown;
}

export class StaleTerminalFrameError extends Error {
  public readonly previousRevision: number;
  public readonly nextRevision: number;

  public constructor(previousRevision: number, nextRevision: number) {
    super(
      `Cannot commit stale terminal frame revision ${nextRevision}; ` +
        `revision ${previousRevision} is already committed.`,
    );
    this.name = "StaleTerminalFrameError";
    this.previousRevision = previousRevision;
    this.nextRevision = nextRevision;
  }
}

export function buildTerminalFrame(
  state: ReplState,
  capabilities: TerminalCapabilities,
): TerminalFrame {
  const columns = Math.max(1, capabilities.columns);
  const availableRows = Math.max(1, capabilities.rows);
  const rows: string[] = [];

  rows.push(...wrapCells(statusHeader(state, capabilities), columns));
  for (const entry of state.transcript) {
    rows.push(...renderTranscriptEntry(entry, columns));
  }
  if (state.assistantStream.length > 0) {
    rows.push(...wrapCells(`Robin: ${sanitizeTerminalData(state.assistantStream)}`, columns));
  }
  for (const tool of state.tools) {
    rows.push(
      ...wrapCells(
        `Tool ${sanitizeTerminalData(tool.name)} [${tool.status}]${
          tool.summary === null ? "" : `: ${sanitizeTerminalData(tool.summary)}`
        }`,
        columns,
      ),
    );
  }
  if (state.usage.inputTokens > 0 || state.usage.outputTokens > 0) {
    rows.push(
      ...wrapCells(
        `Usage input=${state.usage.inputTokens} output=${state.usage.outputTokens}`,
        columns,
      ),
    );
  }
  state.queuedMessages.forEach((message, index) => {
    rows.push(
      ...wrapCells(
        `Queued ${index + 1}/${state.queuedMessages.length}: ${sanitizeTerminalData(message)}`,
        columns,
      ),
    );
  });
  if (state.status === "cancelling") rows.push("Cancelling...");

  const promptPrefix = "> ";
  const input = sanitizeTerminalData(inputBufferText(state.input));
  const promptRows = [...wrapCells(promptPrefix + input, columns)];
  const inputBeforeCursor = state.input.graphemes.slice(0, state.input.cursor).join("");
  const promptCursor = cursorAfterText(
    promptPrefix + sanitizeTerminalData(inputBeforeCursor),
    columns,
  );
  while (promptRows.length <= promptCursor.rowOffset) promptRows.push("");
  const promptStart = rows.length;
  rows.push(...promptRows);
  for (const diagnostic of state.diagnostics.slice(-3)) {
    rows.push(
      ...wrapCells(
        renderDiagnostic(diagnostic.code, diagnostic.count),
        columns,
      ),
    );
  }

  const cursorAbsoluteRow = promptStart + promptCursor.rowOffset;
  const cursorColumn = promptCursor.column;
  const removedRows = Math.max(0, rows.length - availableRows);
  const visibleRows = rows.slice(removedRows, removedRows + availableRows);
  const cursorRow = Math.min(
    visibleRows.length,
    Math.max(1, cursorAbsoluteRow - removedRows + 1),
  );

  return Object.freeze({
    revision: state.revision,
    columns,
    rows: Object.freeze(visibleRows),
    cursor: Object.freeze({ row: cursorRow, column: cursorColumn }),
  });
}

export function diffTerminalFrames(
  previous: TerminalFrame | null,
  next: TerminalFrame,
): FrameDiff {
  if (previous !== null && previous.revision > next.revision) {
    return Object.freeze({
      bytes: "",
      firstChangedRow: null,
      lastChangedRow: null,
    });
  }
  const before = previous?.rows ?? [];
  const after = next.rows;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  if (before.length === after.length) {
    while (
      suffix < before.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
      suffix += 1;
    }
  }
  const last = Math.max(before.length, after.length) - suffix - 1;
  let bytes = "";
  if (last >= prefix) {
    for (let index = prefix; index <= last; index += 1) {
      bytes += cursorMove(index + 1, 1) + `${ESC}[2K` + (after[index] ?? "");
    }
  }
  bytes += cursorMove(next.cursor.row, next.cursor.column);
  return Object.freeze({
    bytes,
    firstChangedRow: last >= prefix ? prefix : null,
    lastChangedRow: last >= prefix ? last : null,
  });
}

export function writeTerminalFrame(
  writer: TerminalFrameWriter,
  previous: TerminalFrame | null,
  next: TerminalFrame,
): FrameDiff {
  if (previous !== null && previous.revision > next.revision) {
    throw new StaleTerminalFrameError(previous.revision, next.revision);
  }
  const diff = diffTerminalFrames(previous, next);
  writer.write(diff.bytes);
  return diff;
}

export function sanitizeTerminalData(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
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
      safe += `\\u{${codePoint.toString(16).padStart(2, "0")}}`;
    }
  }
  return safe;
}

export function wrapCells(value: string, columns: number): readonly string[] {
  const width = Math.max(1, Math.trunc(columns));
  const rows: string[] = [""];
  let cells = 0;
  for (const grapheme of segmentGraphemes(value)) {
    if (grapheme === "\n") {
      rows.push("");
      cells = 0;
      continue;
    }
    const graphemeWidth = graphemeCellWidth(grapheme);
    if (cells > 0 && cells + graphemeWidth > width) {
      rows.push("");
      cells = 0;
    }
    rows[rows.length - 1] += grapheme;
    cells += graphemeWidth;
  }
  return Object.freeze(rows);
}

function statusHeader(
  state: ReplState,
  capabilities: TerminalCapabilities,
): string {
  const separator = capabilities.unicode ? "·" : "-";
  return `Robin ${separator} ${state.status} ${separator} ${capabilities.columns}x${capabilities.rows} ${separator} queue ${state.queuedMessages.length}`;
}

function renderTranscriptEntry(
  entry: ReplTranscriptEntry,
  columns: number,
): readonly string[] {
  const label = entry.kind === "user"
    ? "You"
    : entry.kind === "assistant"
      ? "Robin"
      : entry.kind === "tool"
        ? "Tool"
        : entry.kind === "error"
          ? "Error"
          : "Notice";
  return wrapCells(`${label}: ${sanitizeTerminalData(entry.text)}`, columns);
}

function renderDiagnostic(code: string, count: number): string {
  const occurrence = count > 1 ? ` (x${count})` : "";
  switch (code) {
    case "input_limit_exceeded":
      return (
        `Notice [${code}] Input is limited to ${MAXIMUM_REPL_INPUT_UTF8_BYTES} ` +
        `UTF-8 bytes; edit or submit before adding more.${occurrence}`
      );
    case "oversized_paste":
      return (
        `Notice [${code}] Paste exceeded the terminal input limit and was ` +
        `rejected; paste a smaller selection.${occurrence}`
      );
    default:
      return `Notice [${sanitizeTerminalData(code)}] Terminal input was rejected.${occurrence}`;
  }
}

function cursorMove(row: number, column: number): string {
  return `${ESC}[${Math.max(1, row)};${Math.max(1, column)}H`;
}

function cursorAfterText(
  value: string,
  columns: number,
): { readonly rowOffset: number; readonly column: number } {
  let rowOffset = 0;
  let cells = 0;
  for (const grapheme of segmentGraphemes(value)) {
    if (grapheme === "\n") {
      rowOffset += 1;
      cells = 0;
      continue;
    }
    const width = graphemeCellWidth(grapheme);
    if (cells > 0 && cells + width > columns) {
      rowOffset += 1;
      cells = 0;
    }
    cells += width;
  }
  return cells >= columns
    ? { rowOffset: rowOffset + 1, column: 1 }
    : { rowOffset, column: cells + 1 };
}
