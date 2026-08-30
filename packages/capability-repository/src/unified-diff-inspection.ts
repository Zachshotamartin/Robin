import { canonicalBytes, createDomainError } from "@guard/contracts";
import type { JsonObject } from "@guard/contracts";

import { normalizeRepositoryPath } from "./repository-path.js";
import { VirtualRepository } from "./virtual-repository.js";

export interface UnifiedDiffInspectionLimits {
  readonly maximumPatchBytes: number;
  readonly maximumPaths: number;
  readonly maximumHunks: number;
  readonly maximumLines: number;
  readonly maximumOutputBytes: number;
}

export interface UnifiedDiffInspection extends JsonObject {
  readonly paths: readonly string[];
  readonly hunkCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly lineCount: number;
  readonly byteLength: number;
  /** Exact canonical proposal inspected; this operation never applies it. */
  readonly patch: string;
}

interface ParsedHunkHeader {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

const HUNK_HEADER = /^@@ -(0|[1-9][0-9]*),(0|[1-9][0-9]*) \+(0|[1-9][0-9]*),(0|[1-9][0-9]*) @@$/u;

/**
 * Validates a deliberately narrow, inspection-only unified-diff subset.
 * Unsupported metadata, omitted counts, binary patches, renames, and fuzzy
 * syntax fail closed rather than being interpreted as a Milestone C patch.
 */
export function inspectUnifiedDiffProposal(
  patch: string,
  repository: VirtualRepository,
  limits: UnifiedDiffInspectionLimits,
): UnifiedDiffInspection {
  const byteLength = Buffer.byteLength(patch, "utf8");
  if (byteLength === 0 || byteLength > limits.maximumPatchBytes) {
    throw invalidInput("inspect_diff patch bytes are outside the installed bound.");
  }
  if (
    !isWellFormedUnicode(patch) ||
    patch.includes("\u0000") ||
    patch.includes("\r") ||
    !patch.endsWith("\n")
  ) {
    throw invalidInput("inspect_diff requires NUL-free, LF-only, newline-terminated text.");
  }
  const lines = patch.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.length > limits.maximumLines) {
    throw invalidInput("inspect_diff line count is outside the installed bound.");
  }

  const paths: string[] = [];
  let index = 0;
  let hunkCount = 0;
  let additions = 0;
  let deletions = 0;
  let previousPath: string | null = null;

  while (index < lines.length) {
    const oldPath = parseFileHeader(lines[index], "--- a/");
    index += 1;
    if (index >= lines.length) {
      throw invalidInput("inspect_diff is missing a matching new-file header.");
    }
    const newPath = parseFileHeader(lines[index], "+++ b/");
    index += 1;
    if (oldPath !== newPath) {
      throw invalidInput("inspect_diff old and new headers must name the same path.");
    }
    if (previousPath !== null && compareUtf8(previousPath, oldPath) >= 0) {
      throw invalidInput(
        "inspect_diff file sections must use unique strict UTF-8 path order.",
      );
    }
    previousPath = oldPath;
    paths.push(oldPath);
    if (paths.length > limits.maximumPaths) {
      throw invalidInput("inspect_diff exceeds the installed path-count bound.");
    }
    const sourceLines = logicalLines(repository.read(oldPath));
    let fileHunks = 0;
    let previousOldEnd = -1;
    let previousNewEnd = -1;
    let cumulativeLineDelta = 0;

    while (index < lines.length && lines[index]!.startsWith("@@")) {
      const header = parseHunkHeader(lines[index]!);
      index += 1;
      hunkCount += 1;
      fileHunks += 1;
      if (hunkCount > limits.maximumHunks) {
        throw invalidInput("inspect_diff exceeds the installed hunk-count bound.");
      }
      const oldPosition = hunkPosition(header.oldStart, header.oldCount);
      const newPosition = hunkPosition(header.newStart, header.newCount);
      validateHunkOrder(
        oldPosition,
        header.oldCount,
        newPosition,
        header.newCount,
        previousOldEnd,
        previousNewEnd,
      );
      if (newPosition !== oldPosition + cumulativeLineDelta) {
        throw invalidInput(
          "inspect_diff hunk coordinates must reflect prior line-count changes.",
        );
      }
      previousOldEnd = oldPosition + header.oldCount;
      previousNewEnd = newPosition + header.newCount;

      let oldConsumed = 0;
      let newConsumed = 0;
      let hunkChanges = 0;
      const sourceStart = oldPosition;
      if (sourceStart < 0 || sourceStart + header.oldCount > sourceLines.length) {
        throw invalidInput("inspect_diff hunk range is outside the current file.");
      }

      while (
        oldConsumed < header.oldCount ||
        newConsumed < header.newCount
      ) {
        const body = lines[index];
        if (body === undefined || body.length === 0) {
          throw invalidInput("inspect_diff hunk body ended before its declared counts.");
        }
        const prefix = body[0]!;
        const content = body.slice(1);
        switch (prefix) {
          case " ":
            assertSourceLine(sourceLines, sourceStart + oldConsumed, content);
            oldConsumed += 1;
            newConsumed += 1;
            break;
          case "-":
            assertSourceLine(sourceLines, sourceStart + oldConsumed, content);
            oldConsumed += 1;
            deletions += 1;
            hunkChanges += 1;
            break;
          case "+":
            newConsumed += 1;
            additions += 1;
            hunkChanges += 1;
            break;
          default:
            throw invalidInput("inspect_diff hunk lines require one exact diff prefix.");
        }
        if (
          oldConsumed > header.oldCount ||
          newConsumed > header.newCount
        ) {
          throw invalidInput("inspect_diff hunk body exceeds its declared counts.");
        }
        index += 1;
      }
      if (hunkChanges === 0) {
        throw invalidInput("inspect_diff hunks must contain an addition or deletion.");
      }
      cumulativeLineDelta += header.newCount - header.oldCount;
      const next = lines[index];
      if (
        next !== undefined &&
        !next.startsWith("@@") &&
        !next.startsWith("--- a/")
      ) {
        throw invalidInput("inspect_diff contains trailing or ambiguous hunk content.");
      }
    }
    if (fileHunks === 0) {
      throw invalidInput("inspect_diff file sections require at least one exact hunk.");
    }
    if (index < lines.length && !lines[index]!.startsWith("--- a/")) {
      throw invalidInput("inspect_diff contains unsupported section metadata.");
    }
  }

  const result: UnifiedDiffInspection = Object.freeze({
    paths: Object.freeze(paths),
    hunkCount,
    additions,
    deletions,
    lineCount: lines.length,
    byteLength,
    patch,
  });
  if (canonicalBytes(result).byteLength > limits.maximumOutputBytes) {
    throw invalidInput("inspect_diff inspection exceeds the installed output bound.");
  }
  return result;
}

function parseFileHeader(value: string | undefined, prefix: "--- a/" | "+++ b/"): string {
  if (value === undefined || !value.startsWith(prefix)) {
    throw invalidInput(`inspect_diff requires an exact ${prefix} header.`);
  }
  const rawPath = value.slice(prefix.length);
  const path = normalizeRepositoryPath(rawPath, { allowRoot: false });
  if (path !== rawPath) {
    throw invalidInput("inspect_diff header paths must already be canonical NFC paths.");
  }
  return path;
}

function parseHunkHeader(value: string): ParsedHunkHeader {
  const match = HUNK_HEADER.exec(value);
  if (match === null) {
    throw invalidInput("inspect_diff requires explicit canonical hunk counts.");
  }
  const parsed = match.slice(1).map((item) => Number(item));
  if (
    parsed.some((item) => !Number.isSafeInteger(item))
  ) {
    throw invalidInput("inspect_diff hunk coordinates exceed safe integer bounds.");
  }
  const [oldStart, oldCount, newStart, newCount] = parsed as [
    number,
    number,
    number,
    number,
  ];
  if (
    (oldCount > 0 && oldStart < 1) ||
    (newCount > 0 && newStart < 1)
  ) {
    throw invalidInput("inspect_diff non-empty hunk ranges require one-based starts.");
  }
  return Object.freeze({ oldStart, oldCount, newStart, newCount });
}

function validateHunkOrder(
  oldPosition: number,
  oldCount: number,
  newPosition: number,
  newCount: number,
  previousOldEnd: number,
  previousNewEnd: number,
): void {
  if (
    oldPosition < previousOldEnd ||
    newPosition < previousNewEnd
  ) {
    throw invalidInput("inspect_diff hunks must be nonoverlapping and ordered.");
  }
  if (
    !Number.isSafeInteger(oldPosition + oldCount) ||
    !Number.isSafeInteger(newPosition + newCount)
  ) {
    throw invalidInput("inspect_diff hunk ranges exceed safe integer bounds.");
  }
}

/** Unified diff uses the preceding line number when a range count is zero. */
function hunkPosition(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

function assertSourceLine(
  sourceLines: readonly string[],
  index: number,
  expected: string,
): void {
  if (sourceLines[index] !== expected) {
    throw invalidInput(
      "inspect_diff context and deletion lines must match the current repository.",
    );
  }
}

function logicalLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
