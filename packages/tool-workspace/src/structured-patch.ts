import {
  createDomainError,
  sha256Hex,
  snapshotBoundaryJsonObject,
} from "@guard/contracts";

import {
  normalizeWorkspaceRelativePath,
  type WorkspaceRelativePath,
} from "./physical-path.js";

export interface ExactReplacementHunk {
  readonly oldText: string;
  readonly newText: string;
  readonly expectedOccurrences: 1;
  readonly expectedStartLine?: number;
}

export interface ApplyPatchV1 {
  readonly path: WorkspaceRelativePath;
  readonly expectedSha256: string;
  readonly expectedSize: number;
  readonly hunks: readonly ExactReplacementHunk[];
}

export interface CreateFileV1 {
  readonly path: WorkspaceRelativePath;
  readonly expectedAbsent: true;
  readonly content: string;
}

export interface StructuredPatchLimits {
  readonly maximumHunks: number;
  readonly maximumAggregateTextBytes: number;
  readonly maximumResultBytes: number;
}

export interface StructuredPatchCandidate {
  readonly path: WorkspaceRelativePath;
  readonly before: Uint8Array;
  readonly after: Uint8Array;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly beforeSize: number;
  readonly afterSize: number;
  readonly changedLineCount: number;
  readonly hunkCount: number;
}

interface LocatedHunk {
  readonly hunk: ExactReplacementHunk;
  readonly originalStart: number;
  readonly originalEnd: number;
}

export function parseApplyPatchV1(
  value: unknown,
  limits: StructuredPatchLimits,
): ApplyPatchV1 {
  validateLimits(limits);
  const input = snapshotBoundaryJsonObject(value);
  exactKeys(input, ["path", "expectedSha256", "expectedSize", "hunks"]);
  const path = normalizeWorkspaceRelativePath(input["path"], { allowRoot: false });
  const expectedSha256 = input["expectedSha256"];
  const expectedSize = input["expectedSize"];
  const rawHunks = input["hunks"];
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw invalid("A structured patch requires a canonical SHA-256 preimage.");
  }
  if (!Number.isSafeInteger(expectedSize) || (expectedSize as number) < 0) {
    throw invalid("A structured patch expectedSize must be a non-negative safe integer.");
  }
  if (!Array.isArray(rawHunks) || rawHunks.length < 1 || rawHunks.length > limits.maximumHunks) {
    throw invalid("A structured patch requires a bounded non-empty hunk array.");
  }
  let aggregateBytes = 0;
  const hunks = rawHunks.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw invalid("A structured patch hunk must be an object.");
    }
    const hunk = candidate as Readonly<Record<string, unknown>>;
    const allowed = Object.hasOwn(hunk, "expectedStartLine")
      ? ["oldText", "newText", "expectedOccurrences", "expectedStartLine"]
      : ["oldText", "newText", "expectedOccurrences"];
    exactKeys(hunk, allowed);
    if (
      typeof hunk["oldText"] !== "string" ||
      hunk["oldText"].length === 0 ||
      typeof hunk["newText"] !== "string" ||
      hunk["expectedOccurrences"] !== 1 ||
      !isSafePatchText(hunk["oldText"]) ||
      !isSafePatchText(hunk["newText"])
    ) {
      throw invalid("A structured patch hunk contains invalid replacement text.");
    }
    const expectedStartLine = hunk["expectedStartLine"];
    if (
      expectedStartLine !== undefined &&
      (!Number.isSafeInteger(expectedStartLine) || (expectedStartLine as number) < 1)
    ) {
      throw invalid("A structured patch expectedStartLine must be a positive integer.");
    }
    aggregateBytes +=
      Buffer.byteLength(hunk["oldText"], "utf8") +
      Buffer.byteLength(hunk["newText"], "utf8");
    if (aggregateBytes > limits.maximumAggregateTextBytes) {
      throw budget("A structured patch exceeds its aggregate text byte limit.");
    }
    return Object.freeze({
      oldText: hunk["oldText"],
      newText: hunk["newText"],
      expectedOccurrences: 1 as const,
      ...(expectedStartLine === undefined
        ? {}
        : { expectedStartLine: expectedStartLine as number }),
    });
  });
  return Object.freeze({
    path,
    expectedSha256,
    expectedSize: expectedSize as number,
    hunks: Object.freeze(hunks),
  });
}

export function parseCreateFileV1(
  value: unknown,
  maximumContentBytes: number,
): CreateFileV1 {
  if (!Number.isSafeInteger(maximumContentBytes) || maximumContentBytes < 0) {
    throw invalid("The create-file content limit must be a non-negative safe integer.");
  }
  const input = snapshotBoundaryJsonObject(value);
  exactKeys(input, ["path", "expectedAbsent", "content"]);
  if (
    input["expectedAbsent"] !== true ||
    typeof input["content"] !== "string" ||
    !isSafePatchText(input["content"])
  ) {
    throw invalid("A create-file request requires safe text and expectedAbsent true.");
  }
  if (Buffer.byteLength(input["content"], "utf8") > maximumContentBytes) {
    throw budget("The create-file content exceeds its byte limit.");
  }
  return Object.freeze({
    path: normalizeWorkspaceRelativePath(input["path"], { allowRoot: false }),
    expectedAbsent: true,
    content: input["content"],
  });
}

export function applyStructuredPatch(
  patch: ApplyPatchV1,
  sourceBytes: Uint8Array,
  limits: StructuredPatchLimits,
): StructuredPatchCandidate {
  validateLimits(limits);
  if (
    sourceBytes.byteLength !== patch.expectedSize ||
    sha256Hex(sourceBytes) !== patch.expectedSha256
  ) {
    throw conflict("The structured patch preimage hash or size is stale.");
  }
  const hasBom =
    sourceBytes[0] === 0xef && sourceBytes[1] === 0xbb && sourceBytes[2] === 0xbf;
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      sourceBytes.subarray(hasBom ? 3 : 0),
    );
  } catch {
    throw invalid("Structured patches support only valid UTF-8 text files.");
  }
  const located = patch.hunks.map((hunk) => locateHunk(source, hunk));
  assertNonOverlapping(located);
  let candidate = source;
  const applied: LocatedHunk[] = [];
  for (const item of located) {
    const delta = applied.reduce(
      (sum, prior) =>
        prior.originalStart < item.originalStart
          ? sum + prior.hunk.newText.length - prior.hunk.oldText.length
          : sum,
      0,
    );
    const currentStart = item.originalStart + delta;
    if (
      candidate.slice(currentStart, currentStart + item.hunk.oldText.length) !==
      item.hunk.oldText
    ) {
      throw conflict("A structured patch hunk became stale during ordered application.");
    }
    candidate =
      candidate.slice(0, currentStart) +
      item.hunk.newText +
      candidate.slice(currentStart + item.hunk.oldText.length);
    applied.push(item);
  }
  const body = Buffer.from(candidate, "utf8");
  const after = hasBom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
    : body;
  if (after.byteLength > limits.maximumResultBytes) {
    throw budget("The structured patch candidate exceeds its result byte limit.");
  }
  return Object.freeze({
    path: patch.path,
    before: Uint8Array.from(sourceBytes),
    after: Uint8Array.from(after),
    beforeSha256: sha256Hex(sourceBytes),
    afterSha256: sha256Hex(after),
    beforeSize: sourceBytes.byteLength,
    afterSize: after.byteLength,
    changedLineCount: changedLineCount(located),
    hunkCount: patch.hunks.length,
  });
}

function locateHunk(source: string, hunk: ExactReplacementHunk): LocatedHunk {
  const first = source.indexOf(hunk.oldText);
  const second = first < 0 ? -1 : source.indexOf(hunk.oldText, first + 1);
  if (first < 0 || second >= 0) {
    throw conflict("A structured patch hunk must match exactly once.");
  }
  if (hunk.expectedStartLine !== undefined) {
    const line = 1 + countOccurrences(source.slice(0, first), "\n");
    if (line !== hunk.expectedStartLine) {
      throw conflict("A structured patch hunk did not begin on its expected line.");
    }
  }
  return Object.freeze({
    hunk,
    originalStart: first,
    originalEnd: first + hunk.oldText.length,
  });
}

function assertNonOverlapping(located: readonly LocatedHunk[]): void {
  const sorted = [...located].sort(
    (left, right) => left.originalStart - right.originalStart,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.originalStart < sorted[index - 1]!.originalEnd) {
      throw conflict("Structured patch hunks must not overlap.");
    }
  }
}

function changedLineCount(located: readonly LocatedHunk[]): number {
  return located.reduce(
    (count, item) =>
      count +
      Math.max(
        Math.max(1, countOccurrences(item.hunk.oldText, "\n") + 1),
        Math.max(1, countOccurrences(item.hunk.newText, "\n") + 1),
      ),
    0,
  );
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length) {
    const found = value.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function validateLimits(limits: StructuredPatchLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalid(`Structured patch ${name} must be a positive safe integer.`);
    }
  }
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalid("A structured edit value has unknown or missing properties.");
  }
}

function isSafePatchText(value: string): boolean {
  if (!isWellFormedUnicode(value)) return false;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      point === 0 ||
      ((point < 0x20 || (point >= 0x7f && point <= 0x9f)) &&
        character !== "\n" &&
        character !== "\r" &&
        character !== "\t")
    ) {
      return false;
    }
  }
  return true;
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

function invalid(message: string) {
  return createDomainError({ code: "invalid_input", message });
}

function budget(message: string) {
  return createDomainError({ code: "budget_exceeded", message });
}

function conflict(message: string) {
  return createDomainError({
    code: "conflict",
    message,
    details: { reason: "stale_preimage" },
  });
}
