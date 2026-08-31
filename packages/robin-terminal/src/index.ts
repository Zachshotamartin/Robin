export {
  DEFAULT_TERMINAL_COLUMNS,
  DEFAULT_TERMINAL_ROWS,
  MAXIMUM_TERMINAL_DIMENSION,
  detectTerminalCapabilities,
} from "./terminal-capabilities.js";
export type {
  TerminalCapabilities,
  TerminalCapabilityProbe,
} from "./terminal-capabilities.js";

export {
  createInputBuffer,
  deleteInputAfterCursor,
  deleteInputBackward,
  deleteInputBeforeCursor,
  deleteInputForward,
  deleteInputWordBackward,
  graphemeCellWidth,
  inputBufferText,
  inputCellWidth,
  inputCursorCell,
  inputSelection,
  insertInputText,
  moveInputCursor,
  moveInputCursorBy,
  replaceInputRange,
  segmentGraphemes,
} from "./input-buffer.js";
export type { InputBuffer, InputSelection } from "./input-buffer.js";

export {
  DEFAULT_KEY_DECODER_LIMITS,
  TerminalKeyDecoder,
} from "./key-decoder.js";
export type {
  DecodedKeyEvent,
  KeyDecodeBatch,
  KeyDecoderDiagnostic,
  KeyDecoderLimits,
} from "./key-decoder.js";

export {
  MAXIMUM_QUEUED_MESSAGES,
  MAXIMUM_REPL_DIAGNOSTICS,
  MAXIMUM_REPL_HISTORY,
  MAXIMUM_REPL_INPUT_UTF8_BYTES,
  createReplState,
  reduceRepl,
} from "./repl-reducer.js";
export type {
  ReplDiagnostic,
  ReplEffect,
  ReplEvent,
  ReplState,
  ReplStatus,
  ReplToolStatus,
  ReplTranscriptEntry,
  ReplTransition,
} from "./repl-reducer.js";

export {
  buildTerminalFrame,
  diffTerminalFrames,
  sanitizeTerminalData,
  wrapCells,
  writeTerminalFrame,
  StaleTerminalFrameError,
} from "./renderer.js";
export type {
  FrameDiff,
  RenderCursor,
  TerminalFrame,
  TerminalFrameWriter,
} from "./renderer.js";

export { FlatRenderer, renderFlatEvent } from "./flat-renderer.js";
export type { FlatRenderEvent, FlatWriter } from "./flat-renderer.js";

export {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  HIDE_CURSOR,
  RESET_STYLE,
  SHOW_CURSOR,
  TERMINAL_CLEANUP_BYTES,
  TERMINAL_OPEN_BYTES,
  TerminalSession,
} from "./terminal-session.js";
export type {
  RawModeInput,
  SignalRegistrar,
  TerminalOutput,
  TerminalSessionOptions,
} from "./terminal-session.js";
