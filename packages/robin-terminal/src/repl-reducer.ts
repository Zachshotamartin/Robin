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
import {
  MAXIMUM_APPROVAL_INPUT_UTF8_BYTES,
  parseTerminalApprovalDecision,
  sameTerminalApprovalBinding,
  type TerminalApprovalDecision,
  type TerminalApprovalInvalidation,
  type TerminalApprovalRequest,
  type TerminalApprovalResolution,
} from "./approval.js";

export const MAXIMUM_QUEUED_MESSAGES = 8;
export const MAXIMUM_REPL_HISTORY = 100;
export const MAXIMUM_REPL_DIAGNOSTICS = 32;
export const MAXIMUM_REPL_INPUT_UTF8_BYTES = 65_536;
export const MAXIMUM_REPL_TOOL_OUTPUT_DELTAS = 256;
export const MAXIMUM_REPL_TOOL_OUTPUT_UTF8_BYTES = 256 * 1_024;
export const MAXIMUM_REPL_TOOL_OUTPUT_DELTA_UTF8_BYTES = 32 * 1_024;

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
  readonly outputSequence: number;
  readonly outputLimitExceeded: boolean;
}

export interface ReplToolOutputDelta {
  readonly byteLength: number;
  readonly callId: string;
  readonly channel: "stdout" | "stderr";
  readonly limitExceeded: boolean;
  readonly name: string;
  readonly safeText: string;
  readonly sequence: number;
  readonly textTruncated: boolean;
}

export interface ReplDiagnostic {
  readonly code: string;
  readonly count: number;
}

export interface ReplUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ReplApprovalState extends TerminalApprovalRequest {
  readonly input: InputBuffer;
  readonly phase:
    | "presenting"
    | "awaiting_input"
    | "response_submitted"
    | "cancelling";
  readonly submittedDecision: TerminalApprovalDecision | null;
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
  readonly toolOutput: readonly ReplToolOutputDelta[];
  readonly toolOutputOmittedDeltas: number;
  readonly toolOutputUtf8Bytes: number;
  readonly usage: ReplUsage;
  readonly columns: number;
  readonly rows: number;
  readonly diagnostics: readonly ReplDiagnostic[];
  readonly approval: ReplApprovalState | null;
}

export type ReplEvent =
  | { readonly type: "key"; readonly key: DecodedKeyEvent }
  | { readonly type: "decoder_diagnostic"; readonly diagnostic: KeyDecoderDiagnostic }
  | { readonly type: "turn_started" }
  | { readonly type: "assistant_delta"; readonly text: string }
  | { readonly type: "tool_started"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool_output";
      readonly byteLength: number;
      readonly callId: string;
      readonly channel: "stdout" | "stderr";
      readonly limitExceeded: boolean;
      readonly name: string;
      readonly safeText: string;
      readonly sequence: number;
      readonly textTruncated: boolean;
    }
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
  | { readonly type: "turn_cancellation_requested" }
  | {
      readonly type: "approval_requested";
      readonly request: TerminalApprovalRequest;
    }
  | { readonly type: "approval_presented"; readonly approvalId: string }
  | {
      readonly type: "approval_resolved";
      readonly resolution: TerminalApprovalResolution;
    }
  | {
      readonly type: "approval_invalidated";
      readonly invalidation: TerminalApprovalInvalidation;
    }
  | { readonly type: "approval_response_rejected"; readonly approvalId: string }
  | {
      readonly type: "local_command";
      readonly kind: "notice" | "error";
      readonly message: string;
    }
  | { readonly type: "fatal"; readonly message: string };

export type ReplEffect =
  | { readonly type: "submit_message"; readonly text: string; readonly queued: boolean }
  | { readonly type: "request_cancel" }
  | {
      readonly type: "resolve_approval";
      readonly approvalId: string;
      readonly decision: TerminalApprovalDecision;
    }
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
    toolOutput: [],
    toolOutputOmittedDeltas: 0,
    toolOutputUtf8Bytes: 0,
    usage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
    columns: validDimension(options.columns, 80),
    rows: validDimension(options.rows, 24),
    diagnostics: [],
    approval: null,
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
          toolOutput: [],
          toolOutputOmittedDeltas: 0,
          toolOutputUtf8Bytes: 0,
          usage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
          approval: null,
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
            outputSequence: 0,
            outputLimitExceeded: false,
          }),
        },
        [],
      );
    case "tool_output": {
      const existing = state.tools.find((tool) => tool.callId === event.callId);
      if (
        existing === undefined ||
        existing.name !== event.name ||
        existing.status !== "running" ||
        event.sequence !== existing.outputSequence + 1 ||
        !Number.isSafeInteger(event.byteLength) ||
        event.byteLength <= 0 ||
        Buffer.byteLength(event.safeText, "utf8") >
          MAXIMUM_REPL_TOOL_OUTPUT_DELTA_UTF8_BYTES ||
        (existing.outputLimitExceeded && !event.limitExceeded)
      ) {
        return changed(
          state,
          {
            diagnostics: addDiagnostic(
              state.diagnostics,
              "invalid_tool_output_delta",
            ),
          },
          [],
        );
      }
      const captured = Object.freeze({
        byteLength: event.byteLength,
        callId: event.callId,
        channel: event.channel,
        limitExceeded: event.limitExceeded,
        name: event.name,
        safeText: event.safeText,
        sequence: event.sequence,
        textTruncated: event.textTruncated,
      });
      const output = appendBoundedToolOutput(state, captured);
      return changed(
        state,
        {
          tools: upsertTool(state.tools, {
            ...existing,
            outputSequence: event.sequence,
            outputLimitExceeded: event.limitExceeded,
          }),
          ...output,
        },
        [],
      );
    }
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
    case "turn_cancellation_requested":
      if (state.status !== "working") return transition(state, []);
      return changed(
        state,
        {
          status: "cancelling",
          approval: state.approval === null
            ? null
            : updateApproval(state.approval, {
                input: createInputBuffer(),
                phase: "cancelling",
              }),
        },
        [],
      );
    case "approval_requested":
      if (state.approval !== null || state.status !== "working") {
        return changed(
          state,
          {
            diagnostics: addDiagnostic(
              state.diagnostics,
              "unexpected_approval_request",
            ),
          },
          [],
        );
      }
      return changed(
        state,
        {
          approval: createApprovalState(event.request),
        },
        [],
      );
    case "approval_presented":
      if (
        state.approval === null ||
        state.approval.approvalId !== event.approvalId ||
        state.approval.phase !== "presenting"
      ) {
        return changed(
          state,
          {
            diagnostics: addDiagnostic(
              state.diagnostics,
              "unknown_approval_presentation",
            ),
          },
          [],
        );
      }
      return changed(
        state,
        { approval: updateApproval(state.approval, { phase: "awaiting_input" }) },
        [],
      );
    case "approval_resolved":
      if (
        state.approval === null ||
        !sameTerminalApprovalBinding(state.approval, event.resolution)
      ) {
        return changed(
          state,
          {
            diagnostics: addDiagnostic(
              state.diagnostics,
              "unknown_approval_resolution",
            ),
          },
          [],
        );
      }
      return changed(
        state,
        {
          approval: null,
          transcript: appendTranscript(state.transcript, {
            kind: event.resolution.outcome === "granted" ? "notice" : "error",
            text: approvalResolutionNotice(event.resolution),
          }),
        },
        [],
      );
    case "approval_invalidated":
      return changed(
        state,
        {
          approval:
            state.approval !== null &&
            sameTerminalApprovalBinding(state.approval, event.invalidation)
              ? null
              : state.approval,
          transcript: appendTranscript(state.transcript, {
            kind: "error",
            text:
              `Approval ${event.invalidation.approvalId} for ` +
              `${event.invalidation.toolName} was invalidated ` +
              `(${event.invalidation.reason}); no execution authority remains.`,
          }),
        },
        [],
      );
    case "approval_response_rejected":
      if (
        state.approval === null ||
        state.approval.approvalId !== event.approvalId
      ) {
        return transition(state, []);
      }
      return changed(
        state,
        {
          approval: null,
          transcript: appendTranscript(state.transcript, {
            kind: "error",
            text:
              `Approval ${event.approvalId} is no longer active; ` +
              "no execution authority was granted.",
          }),
        },
        [],
      );
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
  if (state.approval !== null) return reduceApprovalKey(state, key);
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

function reduceApprovalKey(
  state: ReplState,
  key: DecodedKeyEvent,
): ReplTransition {
  const approval = state.approval!;
  if (key.type === "resize") {
    return changed(state, { columns: key.columns, rows: key.rows }, []);
  }
  if (key.type === "ctrl_c") {
    if (state.status !== "working") return transition(state, []);
    return changed(
      state,
      {
        status: "cancelling",
        approval: updateApproval(approval, {
          input: createInputBuffer(),
          phase: "cancelling",
        }),
      },
      [{ type: "request_cancel" }],
    );
  }
  if (key.type === "ctrl_d") return transition(state, []);
  if (approval.phase !== "awaiting_input") return transition(state, []);

  switch (key.type) {
    case "text":
      return insertApprovalText(state, key.text);
    case "paste":
      return changed(
        state,
        {
          diagnostics: addDiagnostic(
            state.diagnostics,
            "approval_paste_rejected",
          ),
        },
        [],
      );
    case "left":
      return changeApprovalInput(state, moveInputCursorBy(approval.input, -1));
    case "right":
      return changeApprovalInput(state, moveInputCursorBy(approval.input, 1));
    case "home":
    case "ctrl_a":
      return changeApprovalInput(state, moveInputCursor(approval.input, 0));
    case "end":
    case "ctrl_e":
      return changeApprovalInput(
        state,
        moveInputCursor(approval.input, approval.input.graphemes.length),
      );
    case "backspace":
      return changeApprovalInput(state, deleteInputBackward(approval.input));
    case "delete":
      return changeApprovalInput(state, deleteInputForward(approval.input));
    case "ctrl_u":
      return changeApprovalInput(state, deleteInputBeforeCursor(approval.input));
    case "ctrl_k":
      return changeApprovalInput(state, deleteInputAfterCursor(approval.input));
    case "ctrl_w":
      return changeApprovalInput(state, deleteInputWordBackward(approval.input));
    case "enter":
      return submitApprovalInput(state);
    case "up":
    case "down":
      return transition(state, []);
  }
}

function insertApprovalText(state: ReplState, text: string): ReplTransition {
  const approval = state.approval!;
  if (
    text.length === 0 ||
    Buffer.byteLength(inputBufferText(approval.input) + text, "utf8") >
      MAXIMUM_APPROVAL_INPUT_UTF8_BYTES
  ) {
    return text.length === 0
      ? transition(state, [])
      : changed(
          state,
          {
            diagnostics: addDiagnostic(
              state.diagnostics,
              "approval_input_rejected",
            ),
          },
          [],
        );
  }
  return changeApprovalInput(state, insertInputText(approval.input, text));
}

function changeApprovalInput(
  state: ReplState,
  input: InputBuffer,
): ReplTransition {
  return changed(
    state,
    { approval: updateApproval(state.approval!, { input }) },
    [],
  );
}

function submitApprovalInput(state: ReplState): ReplTransition {
  const approval = state.approval!;
  const decision = parseTerminalApprovalDecision(inputBufferText(approval.input));
  if (decision === null) {
    return changed(
      state,
      {
        approval: updateApproval(approval, { input: createInputBuffer() }),
        diagnostics: addDiagnostic(
          state.diagnostics,
          "approval_decision_required",
        ),
      },
      [],
    );
  }
  return changed(
    state,
    {
      approval: updateApproval(approval, {
        input: createInputBuffer(),
        phase: "response_submitted",
        submittedDecision: decision,
      }),
    },
    [{ type: "resolve_approval", approvalId: approval.approvalId, decision }],
  );
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
        toolOutput: [],
        toolOutputOmittedDeltas: 0,
        toolOutputUtf8Bytes: 0,
        approval: null,
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
        approval: null,
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
      approval: null,
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
    toolOutput: Object.freeze(
      state.toolOutput.map((delta) => Object.freeze({ ...delta })),
    ),
    usage: Object.freeze({ ...state.usage }),
    diagnostics: Object.freeze(
      state.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
    ),
    approval: state.approval,
  });
}

function appendBoundedToolOutput(
  state: ReplState,
  delta: ReplToolOutputDelta,
): Pick<
  ReplState,
  "toolOutput" | "toolOutputOmittedDeltas" | "toolOutputUtf8Bytes"
> {
  const retained = [...state.toolOutput, delta];
  let retainedBytes =
    state.toolOutputUtf8Bytes + Buffer.byteLength(delta.safeText, "utf8");
  let omitted = state.toolOutputOmittedDeltas;
  while (
    retained.length > MAXIMUM_REPL_TOOL_OUTPUT_DELTAS ||
    retainedBytes > MAXIMUM_REPL_TOOL_OUTPUT_UTF8_BYTES
  ) {
    const removed = retained.shift();
    if (removed === undefined) break;
    retainedBytes -= Buffer.byteLength(removed.safeText, "utf8");
    omitted += 1;
  }
  return Object.freeze({
    toolOutput: Object.freeze(retained),
    toolOutputOmittedDeltas: omitted,
    toolOutputUtf8Bytes: retainedBytes,
  });
}

function createApprovalState(
  request: TerminalApprovalRequest,
): ReplApprovalState {
  return Object.freeze({
    ...request,
    input: createInputBuffer(),
    phase: "presenting",
    submittedDecision: null,
  });
}

function updateApproval(
  approval: ReplApprovalState,
  patch: Partial<
    Pick<ReplApprovalState, "input" | "phase" | "submittedDecision">
  >,
): ReplApprovalState {
  return Object.freeze({ ...approval, ...patch });
}

function approvalResolutionNotice(
  resolution: TerminalApprovalResolution,
): string {
  if (resolution.outcome === "granted") {
    return (
      `Approval ${resolution.approvalId} granted once for ` +
      `${resolution.toolName}; the one-use response was submitted.`
    );
  }
  if (resolution.outcome === "stale") {
    return (
      `Approval ${resolution.approvalId} for ${resolution.toolName} became ` +
      "stale; no execution authority was granted."
    );
  }
  return (
    `Approval ${resolution.approvalId} for ${resolution.toolName} was denied; ` +
    "no execution authority was granted."
  );
}

function validDimension(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= 10_000
    ? value!
    : fallback;
}
