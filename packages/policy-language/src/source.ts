import type { SourcePosition, SourceSpan } from "./types.js";

export const DEFAULT_SOURCE_ID = "<memory>";

export function position(
  byteOffset: number,
  line: number,
  column: number,
): SourcePosition {
  return Object.freeze({ byteOffset, line, column });
}

export function span(
  sourceId: string,
  start: SourcePosition,
  end: SourcePosition,
): SourceSpan {
  return Object.freeze({ sourceId, start, end });
}

export function coveringSpan(first: SourceSpan, last: SourceSpan): SourceSpan {
  if (first.sourceId !== last.sourceId) {
    throw new TypeError("Cannot combine source spans from different sources.");
  }
  return span(first.sourceId, first.start, last.end);
}
