const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

export interface InputBuffer {
  readonly graphemes: readonly string[];
  readonly cursor: number;
  readonly anchor: number;
}

export interface InputSelection {
  readonly start: number;
  readonly end: number;
}

export function createInputBuffer(
  text = "",
  cursor?: number,
  anchor?: number,
): InputBuffer {
  const graphemes = segmentGraphemes(text);
  const safeCursor = boundedIndex(cursor ?? graphemes.length, graphemes.length);
  const safeAnchor = boundedIndex(anchor ?? safeCursor, graphemes.length);
  return freezeBuffer(graphemes, safeCursor, safeAnchor);
}

export function inputBufferText(buffer: InputBuffer): string {
  return buffer.graphemes.join("");
}

export function inputSelection(buffer: InputBuffer): InputSelection {
  return Object.freeze({
    start: Math.min(buffer.cursor, buffer.anchor),
    end: Math.max(buffer.cursor, buffer.anchor),
  });
}

export function inputCellWidth(buffer: InputBuffer): number {
  return buffer.graphemes.reduce((total, grapheme) => total + graphemeCellWidth(grapheme), 0);
}

export function inputCursorCell(buffer: InputBuffer): number {
  return buffer.graphemes
    .slice(0, buffer.cursor)
    .reduce((total, grapheme) => total + graphemeCellWidth(grapheme), 0);
}

export function insertInputText(buffer: InputBuffer, text: string): InputBuffer {
  if (text.length === 0) return buffer;
  const inserted = segmentGraphemes(text);
  if (inserted.length === 0) return buffer;
  const selection = inputSelection(buffer);
  const graphemes = [
    ...buffer.graphemes.slice(0, selection.start),
    ...inserted,
    ...buffer.graphemes.slice(selection.end),
  ];
  const cursor = selection.start + inserted.length;
  return freezeBuffer(graphemes, cursor, cursor);
}

export function replaceInputRange(
  buffer: InputBuffer,
  start: number,
  end: number,
  text: string,
): InputBuffer {
  const safeStart = boundedIndex(Math.min(start, end), buffer.graphemes.length);
  const safeEnd = boundedIndex(Math.max(start, end), buffer.graphemes.length);
  const inserted = segmentGraphemes(text);
  const graphemes = [
    ...buffer.graphemes.slice(0, safeStart),
    ...inserted,
    ...buffer.graphemes.slice(safeEnd),
  ];
  const cursor = safeStart + inserted.length;
  return freezeBuffer(graphemes, cursor, cursor);
}

export function moveInputCursor(
  buffer: InputBuffer,
  cursor: number,
  extendSelection = false,
): InputBuffer {
  const nextCursor = boundedIndex(cursor, buffer.graphemes.length);
  return freezeBuffer(
    buffer.graphemes,
    nextCursor,
    extendSelection ? buffer.anchor : nextCursor,
  );
}

export function moveInputCursorBy(
  buffer: InputBuffer,
  delta: number,
  extendSelection = false,
): InputBuffer {
  return moveInputCursor(buffer, buffer.cursor + delta, extendSelection);
}

export function deleteInputBackward(buffer: InputBuffer): InputBuffer {
  const selection = inputSelection(buffer);
  if (selection.start !== selection.end) {
    return replaceInputRange(buffer, selection.start, selection.end, "");
  }
  if (buffer.cursor === 0) return buffer;
  return replaceInputRange(buffer, buffer.cursor - 1, buffer.cursor, "");
}

export function deleteInputForward(buffer: InputBuffer): InputBuffer {
  const selection = inputSelection(buffer);
  if (selection.start !== selection.end) {
    return replaceInputRange(buffer, selection.start, selection.end, "");
  }
  if (buffer.cursor >= buffer.graphemes.length) return buffer;
  return replaceInputRange(buffer, buffer.cursor, buffer.cursor + 1, "");
}

export function deleteInputBeforeCursor(buffer: InputBuffer): InputBuffer {
  return replaceInputRange(buffer, 0, buffer.cursor, "");
}

export function deleteInputAfterCursor(buffer: InputBuffer): InputBuffer {
  return replaceInputRange(buffer, buffer.cursor, buffer.graphemes.length, "");
}

export function deleteInputWordBackward(buffer: InputBuffer): InputBuffer {
  const selection = inputSelection(buffer);
  if (selection.start !== selection.end) {
    return replaceInputRange(buffer, selection.start, selection.end, "");
  }
  let start = buffer.cursor;
  while (start > 0 && isWhitespaceGrapheme(buffer.graphemes[start - 1]!)) start -= 1;
  while (start > 0 && !isWhitespaceGrapheme(buffer.graphemes[start - 1]!)) start -= 1;
  return replaceInputRange(buffer, start, buffer.cursor, "");
}

export function segmentGraphemes(text: string): readonly string[] {
  return Object.freeze(
    [...GRAPHEME_SEGMENTER.segment(text)].map((entry) => entry.segment),
  );
}

/**
 * A deliberately pinned, dependency-free width policy for Robin's supported
 * common terminal corpus. Complex grapheme clusters occupy at most two cells.
 */
export function graphemeCellWidth(grapheme: string): 0 | 1 | 2 {
  if (grapheme.length === 0 || grapheme === "\n" || grapheme === "\r") return 0;
  const codePoints = [...grapheme].map((character) => character.codePointAt(0)!);
  if (codePoints.every(isZeroWidthCodePoint)) return 0;
  if (
    codePoints.some(isEmojiCodePoint) ||
    codePoints.some(isRegionalIndicator) ||
    codePoints.some(isWideCodePoint) ||
    codePoints.includes(0xfe0f) ||
    codePoints.includes(0x20e3)
  ) {
    return 2;
  }
  return 1;
}

function freezeBuffer(
  graphemes: readonly string[],
  cursor: number,
  anchor: number,
): InputBuffer {
  return Object.freeze({
    graphemes: Object.freeze([...graphemes]),
    cursor,
    anchor,
  });
}

function boundedIndex(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

function isWhitespaceGrapheme(value: string): boolean {
  return /^\s+$/u.test(value);
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0x2060 ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isEmojiCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}
