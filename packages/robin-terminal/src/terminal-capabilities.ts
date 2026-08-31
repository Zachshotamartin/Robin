export interface TerminalCapabilityProbe {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY?: boolean;
  readonly term?: string | null;
  readonly noColor?: string | null;
  readonly ci?: string | null;
  readonly locale?: string | null;
  readonly columns?: number | null;
  readonly rows?: number | null;
  readonly machineMode?: boolean;
  readonly screenReader?: boolean;
  readonly colorOverride?: boolean | null;
  readonly unicodeOverride?: boolean | null;
  readonly reducedMotionOverride?: boolean | null;
  readonly hyperlinkOverride?: boolean | null;
}

export interface TerminalCapabilities {
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  readonly interactive: boolean;
  readonly machineMode: boolean;
  readonly flat: boolean;
  readonly rawMode: boolean;
  readonly cursorAddressing: boolean;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly reducedMotion: boolean;
  readonly hyperlinks: boolean;
  readonly screenReader: boolean;
  readonly dimensionsKnown: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly reason:
    | "interactive"
    | "machine"
    | "non-tty"
    | "term-dumb"
    | "screen-reader";
}

export const DEFAULT_TERMINAL_COLUMNS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;
export const MAXIMUM_TERMINAL_DIMENSION = 10_000;

/**
 * Pure capability detection. Environment and stream inspection belongs to the
 * CLI/platform adapter; tests and callers provide the captured probe values.
 */
export function detectTerminalCapabilities(
  probe: TerminalCapabilityProbe,
): TerminalCapabilities {
  const machineMode = probe.machineMode === true;
  const screenReader = probe.screenReader === true;
  const termDumb = normalizeEnvironmentValue(probe.term)?.toLowerCase() === "dumb";
  const inputIsTTY = probe.stdinIsTTY === true;
  const outputIsTTY = probe.stdoutIsTTY === true;
  const interactive = inputIsTTY && outputIsTTY && !machineMode;
  const flat = machineMode || !interactive || termDumb || screenReader;
  const ci = hasEnabledEnvironmentValue(probe.ci);
  const noColor = hasEnabledEnvironmentValue(probe.noColor);
  const dimensionsKnown =
    validDimension(probe.columns) !== null && validDimension(probe.rows) !== null;
  const columns = validDimension(probe.columns) ?? DEFAULT_TERMINAL_COLUMNS;
  const rows = validDimension(probe.rows) ?? DEFAULT_TERMINAL_ROWS;
  const unicodeDefault = localeSupportsUnicode(probe.locale);
  const unicode = probe.unicodeOverride ?? unicodeDefault;
  const reducedMotion =
    probe.reducedMotionOverride ?? (screenReader || ci || machineMode);
  const color = machineMode
    ? false
    : probe.colorOverride ?? (interactive && !flat && !noColor && !ci);
  const hyperlinks = machineMode
    ? false
    : probe.hyperlinkOverride ?? (interactive && !flat && !ci);

  return Object.freeze({
    inputIsTTY,
    outputIsTTY,
    interactive,
    machineMode,
    flat,
    rawMode: interactive && !flat,
    cursorAddressing: interactive && !flat,
    color,
    unicode,
    reducedMotion,
    hyperlinks,
    screenReader,
    dimensionsKnown,
    columns,
    rows,
    reason: machineMode
      ? "machine"
      : !interactive
        ? "non-tty"
        : termDumb
          ? "term-dumb"
          : screenReader
            ? "screen-reader"
            : "interactive",
  });
}

function normalizeEnvironmentValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.trim();
}

function hasEnabledEnvironmentValue(value: string | null | undefined): boolean {
  const normalized = normalizeEnvironmentValue(value);
  return normalized !== null && normalized !== "" && normalized !== "0" && normalized !== "false";
}

function localeSupportsUnicode(value: string | null | undefined): boolean {
  const normalized = normalizeEnvironmentValue(value);
  if (normalized === null || normalized === "") return true;
  return /(?:utf-?8|utf8)/iu.test(normalized);
}

function validDimension(value: number | null | undefined): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAXIMUM_TERMINAL_DIMENSION
    ? value
    : null;
}
