import { canonicalBytes, createDomainError } from "@guard/contracts";
import type { JsonObject } from "@guard/contracts";

import { normalizeWorkspaceRelativePath } from "./physical-path.js";
import { readPhysicalFile } from "./physical-read-file.js";
import type { WorkspaceHandle } from "./physical-workspace.js";

export interface PhysicalSearchTextRequest {
  readonly query: string;
  readonly paths: readonly string[];
  readonly maximumQueryBytes: number;
  readonly maximumFiles: number;
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
  readonly maximumMatches: number;
  readonly maximumSnippetBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumDurationMs: number;
  readonly includeGenerated: boolean;
}

export interface PhysicalSearchTextResult extends JsonObject {
  readonly matches: readonly JsonObject[];
  readonly matchedCount: number;
  readonly searchedFiles: number;
  readonly searchedBytes: number;
  readonly skipped: readonly JsonObject[];
  readonly truncated: boolean;
}

export interface PhysicalSearchDependencies {
  readonly monotonicNow?: () => number;
}

export async function searchPhysicalText(
  workspace: WorkspaceHandle,
  request: PhysicalSearchTextRequest,
  signal: AbortSignal,
  dependencies: PhysicalSearchDependencies = {},
): Promise<PhysicalSearchTextResult> {
  validateRequest(request);
  const paths = canonicalPaths(request.paths, request.maximumFiles);
  const now = dependencies.monotonicNow ?? (() => performance.now());
  const startedAt = now();
  const matches: JsonObject[] = [];
  const skipped = new Map<string, number>();
  let matchedCount = 0;
  let searchedFiles = 0;
  let searchedBytes = 0;
  let truncated = false;

  for (const path of paths) {
    assertSignal(signal);
    if (now() - startedAt > request.maximumDurationMs) {
      increment(skipped, "time_budget");
      truncated = true;
      break;
    }
    const remaining = request.maximumTotalBytes - searchedBytes;
    if (remaining <= 0) {
      increment(skipped, "byte_budget");
      truncated = true;
      break;
    }
    const read = await readPhysicalFile(
      workspace,
      {
        path,
        selector: { kind: "whole" },
        maximumFileBytes: Math.min(request.maximumFileBytes, remaining),
        maximumOutputBytes: Math.min(request.maximumFileBytes, remaining),
        maximumLineSpan: 1,
        preserveAtime: true,
        allowGenerated: request.includeGenerated,
      },
      signal,
    ).catch((error: unknown) => {
      if (isBudgetError(error)) return null;
      throw error;
    });
    if (read === null) {
      increment(skipped, "oversized");
      continue;
    }
    if (read.status === "withheld") {
      increment(skipped, read.reason);
      continue;
    }
    searchedFiles += 1;
    searchedBytes += read.sourceBytes;
    const lines = logicalLines(read.content);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      let from = 0;
      while (from <= line.length) {
        const matchIndex = line.indexOf(request.query, from);
        if (matchIndex < 0) break;
        matchedCount += 1;
        if (matches.length < request.maximumMatches) {
          const candidate = Object.freeze({
            path,
            line: lineIndex + 1,
            column: Array.from(line.slice(0, matchIndex)).length + 1,
            snippet: boundedSnippet(line, matchIndex, request.maximumSnippetBytes),
          });
          const prospective = {
            matches: [...matches, candidate],
            matchedCount: Number.MAX_SAFE_INTEGER,
            searchedFiles: Number.MAX_SAFE_INTEGER,
            searchedBytes: Number.MAX_SAFE_INTEGER,
            skipped: [],
            truncated: true,
          };
          if (canonicalBytes(prospective).byteLength <= request.maximumOutputBytes) {
            matches.push(candidate);
          } else {
            truncated = true;
          }
        } else {
          truncated = true;
        }
        from = matchIndex + request.query.length;
      }
    }
  }

  const result = Object.freeze({
    matches: Object.freeze(matches),
    matchedCount,
    searchedFiles,
    searchedBytes,
    skipped: Object.freeze(
      [...skipped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => Object.freeze({ reason, count })),
    ),
    truncated: truncated || matches.length < matchedCount,
  });
  if (canonicalBytes(result).byteLength > request.maximumOutputBytes) {
    throw createDomainError({
      code: "budget_exceeded",
      message: "The physical search result envelope exceeds its output byte limit.",
    });
  }
  return result;
}

function canonicalPaths(
  values: readonly string[],
  maximumFiles: number,
): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximumFiles) {
    throw createDomainError({
      code: "invalid_input",
      message: "Physical search requires a bounded non-empty path selection.",
    });
  }
  const set = new Set(
    values.map((value) =>
      normalizeWorkspaceRelativePath(value, { allowRoot: false }),
    ),
  );
  if (set.size !== values.length) {
    throw createDomainError({
      code: "invalid_input",
      message: "Physical search paths must be unique after normalization.",
    });
  }
  return Object.freeze(
    [...set].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    ),
  );
}

function logicalLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n").map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line,
  );
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function boundedSnippet(line: string, matchIndex: number, maximumBytes: number): string {
  const candidate = line.slice(matchIndex);
  const bytes = Buffer.from(candidate, "utf8");
  if (bytes.byteLength <= maximumBytes) return candidate;
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      continue;
    }
  }
  return "";
}

function validateRequest(request: PhysicalSearchTextRequest): void {
  if (
    typeof request.query !== "string" ||
    request.query.length === 0 ||
    request.query.includes("\u0000") ||
    /[\r\n]/u.test(request.query) ||
    Buffer.byteLength(request.query, "utf8") > request.maximumQueryBytes
  ) {
    throw createDomainError({
      code: "invalid_input",
      message: "Physical search requires a bounded single-line literal query.",
    });
  }
  for (const [name, value] of Object.entries({
    maximumQueryBytes: request.maximumQueryBytes,
    maximumFiles: request.maximumFiles,
    maximumFileBytes: request.maximumFileBytes,
    maximumTotalBytes: request.maximumTotalBytes,
    maximumMatches: request.maximumMatches,
    maximumSnippetBytes: request.maximumSnippetBytes,
    maximumOutputBytes: request.maximumOutputBytes,
    maximumDurationMs: request.maximumDurationMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw createDomainError({
        code: "invalid_input",
        message: `${name} must be a positive safe integer.`,
      });
    }
  }
  if (Buffer.byteLength(request.query, "utf8") > request.maximumSnippetBytes) {
    throw createDomainError({
      code: "invalid_input",
      message: "The literal query must fit inside each released snippet.",
    });
  }
}

function assertSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) {
    throw createDomainError({
      code: "invalid_input",
      message: "Physical search requires an AbortSignal.",
    });
  }
  if (signal.aborted) {
    throw createDomainError({
      code: "cancelled",
      message: "Physical search was cancelled.",
    });
  }
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function isBudgetError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly code?: unknown }).code === "budget_exceeded"
  );
}
