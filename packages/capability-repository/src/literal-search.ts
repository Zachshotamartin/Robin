import { canonicalBytes, createDomainError } from "@guard/contracts";
import type { JsonObject } from "@guard/contracts";

import { VirtualRepository } from "./virtual-repository.js";

export interface LiteralSearchRequest {
  readonly query: string;
  readonly paths: readonly string[];
  readonly maximumMatches: number;
  readonly maximumSnippetBytes: number;
  readonly maximumOutputBytes: number;
}

interface LiteralSearchMatch extends JsonObject {
  readonly path: string;
  /** One-based logical line number. */
  readonly line: number;
  /** One-based Unicode-code-point column in the original logical line. */
  readonly column: number;
  /** UTF-8-safe prefix beginning at the exact literal match. */
  readonly snippet: string;
}

export interface LiteralSearchResult extends JsonObject {
  readonly matches: readonly LiteralSearchMatch[];
  /** Exact occurrence count across every selected file, including omitted matches. */
  readonly matchedCount: number;
  readonly truncated: boolean;
}

/** Exact, case-sensitive, non-overlapping literal search over normalized paths. */
export function runLiteralSearch(
  repository: VirtualRepository,
  request: LiteralSearchRequest,
): LiteralSearchResult {
  if (typeof request.query !== "string" || request.query.length === 0) {
    throw invalidInput("Literal search requires a non-empty query.");
  }
  const matches: LiteralSearchMatch[] = [];
  let matchedCount = 0;
  let outputExhausted = false;

  for (const path of request.paths) {
    const lines = logicalLines(repository.read(path));
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      let fromIndex = 0;
      while (fromIndex <= line.length) {
        const matchIndex = line.indexOf(request.query, fromIndex);
        if (matchIndex < 0) break;
        if (matchedCount === Number.MAX_SAFE_INTEGER) {
          throw invariant("Literal search occurrence accounting overflowed.");
        }
        matchedCount += 1;
        if (
          !outputExhausted &&
          matches.length < request.maximumMatches
        ) {
          const candidate: LiteralSearchMatch = Object.freeze({
            path,
            line: lineIndex + 1,
            column: unicodeColumn(line, matchIndex),
            snippet: truncateUtf8(
              line.slice(matchIndex),
              request.maximumSnippetBytes,
            ),
          });
          const next = [...matches, candidate];
          if (
            boundedSearchOutputBytes(next) <= request.maximumOutputBytes
          ) {
            matches.push(candidate);
          } else {
            outputExhausted = true;
          }
        }
        fromIndex = matchIndex + request.query.length;
      }
    }
  }

  const result: LiteralSearchResult = Object.freeze({
    matches: Object.freeze(matches),
    matchedCount,
    truncated: matches.length < matchedCount,
  });
  if (canonicalBytes(result).byteLength > request.maximumOutputBytes) {
    throw invariant("Literal search output exceeded its normalized aggregate bound.");
  }
  return result;
}

/** Reserves worst-case count width and the longer boolean encoding per candidate. */
function boundedSearchOutputBytes(matches: readonly LiteralSearchMatch[]): number {
  return canonicalBytes({
    matches,
    matchedCount: Number.MAX_SAFE_INTEGER,
    truncated: false,
  }).byteLength;
}

export function minimumLiteralSearchOutputBytes(): number {
  return boundedSearchOutputBytes([]);
}

function logicalLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function unicodeColumn(line: string, utf16Index: number): number {
  return Array.from(line.slice(0, utf16Index)).length + 1;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // At most three trailing bytes can belong to an incomplete UTF-8 scalar.
    }
  }
  throw invariant("A literal search snippet could not be bounded at a UTF-8 boundary.");
}

function invariant(message: string) {
  return createDomainError({ code: "invariant_violated", message });
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
