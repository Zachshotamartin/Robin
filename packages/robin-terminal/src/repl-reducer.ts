import {
  createInputBuffer,
  deleteInputAfterCursor,
  deleteInputBackward,
  deleteInputBeforeCursor,
  deleteInputForward,
  deleteInputWordBackward,
  inputBufferText,
  inputSelection,
  insertInputText,
  moveInputCursor,
  moveInputCursorBy,
  type InputBuffer,
} from "./input-buffer.js";
import type { DecodedKeyEvent, KeyDecoderDiagnostic } from "./key-decoder.js";

export const MAXIMUM_QUEUED_MESSAGES = 8;
export const MAXIMUM_REPL_HISTORY = 100;
export const MAXIMUM_REPL_DIAGNOSTICS = 32;
export const MAXIMUM_REPL_INPUT_UTF8_BYTES = 65_536;

export type ReplStatus =
  | "ready"
  | "working"
  | "cancelling"
  | "closed"
  | "fatal";

export interface ReplTranscriptEntry {
  readonly kind: "user" | "assistant" | "tool" | "notice" | "error";
  readonly text: string;
}

export interface ReplToolStatus {
  readonly callId: string;
  readonly name: string;
  readonly status: "running" | "completed" | "failed";
  readonly summary: string | null;
}

export interface ReplDiagnostic {
  readonly code: string;
  readonly count: number;
}

export interface ReplUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ReplState {
  readonly revision: number;
  readonly status: ReplStatus;
  readonly input: InputBuffer;
  readonly history: readonly string[];
  readonly historyIndex: number | null;
  readonly queuedMessages: readonly string[];
  readonly transcript: readonly ReplTranscriptEntry[];
  readonly assistantStream: string;
  readonly tools: readonly ReplToolStatus[];
  readonly usage: ReplUsage;
  readonly columns: number;
  readonly rows: number;
  readonly diagnostics: readonly ReplDiagnostic[];
}

export type ReplEvent =
  | { readonly type: "key"; readonly key: DecodedKeyEvent }
  | { readonly type: "decoder_diagnostic"; readonly diagnostic: KeyDecoderDiagnostic }
  | { readonly type: "turn_started" }
  | { readonly type: "assistant_delta"; readonly text: string }
  | { readonly type: "tool_started"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool_completed" | "tool_failed";
      readonly callId: string;
      readonly summary: string;
    }
  | {
      readonly type: "usage_reported";
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | { readonly type: "turn_completed"; readonly text: string }
  | { readonly type: "turn_failed"; readonly message: string }
  | { readonly type: "turn_cancelled"; readonly message: string }
  | {
      readonly type: "local_command";
      readonly kind: "notice" | "error";
      readonly message: string;
    }
  | { readonly type: "fatal"; readonly message: string };

export type ReplEffect =
  | { readonly type: "submit_message"; readonly text: string; readonly queued: boolean }
  | { readonly type: "request_cancel" }
  | { readonly type: "force_exit" }
  | { readonly type: "close" };

export interface ReplTransition {
  readonly state: ReplState;
  readonly effects: readonly ReplEffect[];
}

export function createReplState(
  options: { readonly columns?: number; readonly rows?: number } = {},
): ReplState {
  return freezeState({
    revision: 0,
    status: "ready",
    input: createInputBuffer(),
    history: [],
    historyIndex: null,
    queuedMessages: [],
    transcript: [],
    assistantStream: "",
    tools: [],
    usage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
    columns: validDimension(options.columns, 80),
    rows: validDimension(options.rows, 24),
    diagnostics: [],
  });
}

export function reduceRepl(state: ReplState, event: ReplEvent): ReplTransition {
  if (state.status === "closed" || state.status === "fatal") {
    return transition(state, []);
  }
  if (event.type === "key") return reduceKey(state, event.key);
  if (event.type === "decoder_diagnostic") {
    return changed(
      state,
      { diagnostics: addDiagnostic(state.diagnostics, event.diagnostic.code) },
      [],
    );
  }
  switch (event.type) {
    case "turn_started":
      return changed(
        state,
        {
          status: "working",
          assistantStream: "",
          tools: [],
          usage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
        },
        [],
      );
    case "assistant_delta":
      return changed(
        state,
        { assistantStream: state.assistantStream + event.text },
        [],
      );
    case "tool_started":
      return changed(
        state,
        {
          tools: upsertTool(state.tools, {
            callId: event.callId,
            name: event.name,
            status: "running",
            summary: null,
          }),
        },
        [],
      );
    case "tool_completed":
    case "tool_failed": {
      const existing = state.tools.find((tool) => tool.callId === event.callId);
      if (existing === undefined) {
        return changed(
          state,
          { diagnostics: addDiagnostic(state.diagnostics, "unknown_tool_result") },
          [],
        );
      }
      return changed(
        state,
        {
          tools: upsertTool(state.tools, {
            ...existing,
            status: event.type === "tool_completed" ? "completed" : "failed",
            summary: event.summary,
          }),
          transcript: appendTranscript(state.transcript, {
            kind: "tool",
            text: `${existing.name}: ${event.summary}`,
          }),
        },
        [],
      );
    }
    case "usage_reported":
      if (
        !Number.isSafeInteger(event.inputTokens) ||
        event.inputTokens < state.usage.inputTokens ||
        !Number.isSafeInteger(event.outputTokens) ||
        event.outputTokens < state.usage.outputTokens
      ) {
        return changed(
          state,
          { diagnostics: addDiagnostic(state.diagnostics, "invalid_usage") },
          [],
        );
      }
      return changed(
        state,
        {
          usage: Object.freeze({
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          }),
        },
        [],
      );
    case "turn_completed":
      return settleTurn(state, "assistant", event.text);
    case "turn_failed":
      return settleTurn(state, "error", event.message);
    case "turn_cancelled":
      return settleTurn(state, "notice", event.message);
    case "local_command":
      return completeLocalCommand(state, event.kind, event.message);
    case "fatal":
      return changed(
        state,
        {
          status: "fatal",
          transcript: appendTranscript(state.transcript, {
            kind: "error",
            text: event.message,
          }),
        },
        [],
      );
  }
}

function reduceKey(state: ReplState, key: DecodedKeyEvent): ReplTransition {
  switch (key.type) {
    case "text":
    case "paste":
      return insertComposerText(state, key.text);
    case "left":
      return changed(state, { input: moveInputCursorBy(state.input, -1) }, []);
    case "right":
      return changed(state, { input: moveInputCursorBy(state.input, 1) }, []);
    case "home":
    case "ctrl_a":
      return changed(state, { input: moveInputCursor(state.input, 0) }, []);
    case "end":
    case "ctrl_e":
      return changed(
        state,
        { input: moveInputCursor(state.input, state.input.graphemes.length) },
        [],
      );
    case "backspace":
      return changed(state, { input: deleteInputBackward(state.input) }, []);
    case "delete":
      return changed(state, { input: deleteInputForward(state.input) }, []);
    case "ctrl_u":
      return changed(state, { input: deleteInputBeforeCursor(state.input) }, []);
    case "ctrl_k":
      return changed(state, { input: deleteInputAfterCursor(state.input) }, []);
    case "ctrl_w":
      return changed(state, { input: deleteInputWordBackward(state.input) }, []);
    case "up":
      return traverseHistory(state, -1);
    case "down":
      return traverseHistory(state, 1);
    case "resize":
      return changed(state, { columns: key.columns, rows: key.rows }, []);
    case "enter":
      return submitInput(state);
    case "ctrl_c":
      return interrupt(state);
    case "ctrl_d":
      if (state.status === "ready" && inputBufferText(state.input).length === 0) {
        return changed(state, { status: "closed" }, [{ type: "close" }]);
      }
      return transition(state, []);
  }
}

function submitInput(state: ReplState): ReplTransition {
  const text = inputBufferText(state.input);
  if (text.trim().length === 0) return transition(state, []);
  const history = appendHistory(state.history, text);
  const transcript = appendTranscript(state.transcript, { kind: "user", text });
  if (state.status === "ready") {
    return changed(
      state,
      {
        status: "working",
        input: createInputBuffer(),
        history,
        historyIndex: null,
        transcript,
        assistantStream: "",
        tools: [],
      },
      [{ type: "submit_message", text, queued: false }],
    );
  }
  if (state.status === "working" || state.status === "cancelling") {
    if (state.queuedMessages.length >= MAXIMUM_QUEUED_MESSAGES) {
      return changed(
        state,
        { diagnostics: addDiagnostic(state.diagnostics, "queue_full") },
        [],
      );
    }
    return changed(
      state,
      {
        input: createInputBuffer(),
        history,
        historyIndex: null,
        queuedMessages: [...state.queuedMessages, text],
        transcript,
      },
      [{ type: "submit_message", text, queued: true }],
    );
  }
  return transition(state, []);
}

function interrupt(state: ReplState): ReplTransition {
  if (state.status === "ready") {
    if (inputBufferText(state.input).length > 0) {
      return changed(state, { input: createInputBuffer() }, []);
    }
    return changed(state, { status: "closed" }, [{ type: "close" }]);
  }
  if (state.status === "working") {
    return changed(state, { status: "cancelling" }, [{ type: "request_cancel" }]);
  }
  return transition(state, []);
}

function insertComposerText(state: ReplState, text: string): ReplTransition {
  if (text.length === 0) return transition(state, []);
  const selection = inputSelection(state.input);
  const currentBytes = Buffer.byteLength(inputBufferText(state.input), "utf8");
  const selectedBytes = Buffer.byteLength(
    state.input.graphemes.slice(selection.start, selection.end).join(""),
    "utf8",
  );
  const insertedBytes = Buffer.byteLength(text, "utf8");
  if (
    currentBytes - selectedBytes + insertedBytes >
    MAXIMUM_REPL_INPUT_UTF8_BYTES
  ) {
    return changed(
      state,
      { diagnostics: addDiagnostic(state.diagnostics, "input_limit_exceeded") },
      [],
    );
  }
  return changed(
    state,
    { input: insertInputText(state.input, text), historyIndex: null },
    [],
  );
}

function completeLocalCommand(
  state: ReplState,
  kind: "notice" | "error",
  message: string,
): ReplTransition {
  const command = inputBufferText(state.input);
  if (command.trim().length === 0) return transition(state, []);
  return changed(
    state,
    {
      input: createInputBuffer(),
      history: appendHistory(state.history, command),
      historyIndex: null,
      transcript: appendTranscript(
        appendTranscript(state.transcript, { kind: "user", text: command }),
        { kind, text: message },
      ),
    },
    [],
  );
}

function settleTurn(
  state: ReplState,
  kind: ReplTranscriptEntry["kind"],
  text: string,
): ReplTransition {
  const transcript = appendTranscript(state.transcript, { kind, text });
  const [next, ...remaining] = state.queuedMessages;
  if (next === undefined) {
    return changed(
      state,
      {
        status: "ready",
        transcript,
        assistantStream: "",
        tools: [],
      },
      [],
    );
  }
  return changed(
    state,
    {
      status: "working",
      queuedMessages: remaining,
      transcript,
      assistantStream: "",
      tools: [],
    },
    [],
  );
}

function traverseHistory(state: ReplState, direction: -1 | 1): ReplTransition {
  if (state.history.length === 0) return transition(state, []);
  let index = state.historyIndex;
  if (direction === -1) {
    index = index === null ? state.history.length - 1 : Math.max(0, index - 1);
  } else if (index === null) {
    return transition(state, []);
  } else if (index >= state.history.length - 1) {
    return changed(state, { historyIndex: null, input: createInputBuffer() }, []);
  } else {
    index += 1;
  }
  return changed(
    state,
    { historyIndex: index, input: createInputBuffer(state.history[index]!) },
    [],
  );
}

function upsertTool(
  tools: readonly ReplToolStatus[],
  next: ReplToolStatus,
): readonly ReplToolStatus[] {
  const index = tools.findIndex((tool) => tool.callId === next.callId);
  if (index === -1) return [...tools, next];
  return tools.map((tool, toolIndex) => (toolIndex === index ? next : tool));
}

function appendHistory(history: readonly string[], text: string): readonly string[] {
  const withoutDuplicateTail = history.at(-1) === text ? history : [...history, text];
  return withoutDuplicateTail.slice(-MAXIMUM_REPL_HISTORY);
}

function appendTranscript(
  transcript: readonly ReplTranscriptEntry[],
  entry: ReplTranscriptEntry,
): readonly ReplTranscriptEntry[] {
  return [...transcript, entry];
}

function addDiagnostic(
  diagnostics: readonly ReplDiagnostic[],
  code: string,
): readonly ReplDiagnostic[] {
  const existing = diagnostics.find((diagnostic) => diagnostic.code === code);
  const next = [
    ...diagnostics.filter((diagnostic) => diagnostic.code !== code),
    { code, count: existing === undefined ? 1 : existing.count + 1 },
  ];
  return next.slice(-MAXIMUM_REPL_DIAGNOSTICS);
}

function changed(
  state: ReplState,
  patch: Partial<Omit<ReplState, "revision">>,
  effects: readonly ReplEffect[],
): ReplTransition {
  return transition(
    freezeState({ ...state, ...patch, revision: state.revision + 1 }),
    effects,
  );
}

function transition(
  state: ReplState,
  effects: readonly ReplEffect[],
): ReplTransition {
  return Object.freeze({
    state,
    effects: Object.freeze(effects.map((effect) => Object.freeze({ ...effect }))),
  });
}

function freezeState(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    history: Object.freeze([...state.history]),
    queuedMessages: Object.freeze([...state.queuedMessages]),
    transcript: Object.freeze(
      state.transcript.map((entry) => Object.freeze({ ...entry })),
    ),
    tools: Object.freeze(state.tools.map((tool) => Object.freeze({ ...tool }))),
    usage: Object.freeze({ ...state.usage }),
    diagnostics: Object.freeze(
      state.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
    ),
  });
}

function validDimension(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= 10_000
    ? value!
    : fallback;
}
