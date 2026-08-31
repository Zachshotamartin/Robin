import { createDomainError, sha256Hex } from "@guard/contracts";

import type { WorkspaceRelativePath } from "./physical-path.js";

export interface DiffArtifact {
  readonly path: WorkspaceRelativePath;
  readonly fullDiffSha256: string;
  readonly fullDiffBytes: number;
  readonly retainedFullDiff: string | null;
  readonly preview: string;
  readonly previewTruncated: boolean;
  readonly additions: number;
  readonly deletions: number;
}

export function createDiffArtifact(
  path: WorkspaceRelativePath,
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  options: {
    readonly maximumFullDiffBytes: number;
    readonly maximumPreviewBytes: number;
  },
): DiffArtifact {
  validateLimit(options.maximumFullDiffBytes, "full diff");
  validateLimit(options.maximumPreviewBytes, "diff preview");
  const before = decode(beforeBytes);
  const after = decode(afterBytes);
  const beforeLines = diffLines(before);
  const afterLines = diffLines(after);
  const beforePath = JSON.stringify(`a/${path}`);
  const afterPath = JSON.stringify(`b/${path}`);
  const fullDiff = [
    `diff --robin ${beforePath} ${afterPath}\n`,
    `--- ${beforePath}\n`,
    `+++ ${afterPath}\n`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("");
  const fullBytes = Buffer.byteLength(fullDiff, "utf8");
  const safeDisplay = escapeTerminalControls(fullDiff);
  const preview = truncateUtf8(safeDisplay, options.maximumPreviewBytes);
  return Object.freeze({
    path,
    fullDiffSha256: sha256Hex(fullDiff),
    fullDiffBytes: fullBytes,
    retainedFullDiff: fullBytes <= options.maximumFullDiffBytes ? fullDiff : null,
    preview: preview.text,
    previewTruncated: preview.truncated,
    additions: afterLines.length,
    deletions: beforeLines.length,
  });
}

function decode(bytes: Uint8Array): string {
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(hasBom ? 3 : 0),
    );
  } catch {
    throw createDomainError({
      code: "invalid_input",
      message: "Diff artifacts require valid UTF-8 source and result bytes.",
    });
  }
}

function diffLines(text: string): readonly string[] {
  if (text.length === 0) return [];
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x0a) continue;
    result.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) {
    result.push(`${text.slice(start)}\n\\ No newline at end of file\n`);
  }
  return result;
}

function escapeTerminalControls(value: string): string {
  let result = "";
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      (point < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x202a ||
      point === 0x202b ||
      point === 0x202d ||
      point === 0x202e ||
      point === 0x2066 ||
      point === 0x2067 ||
      point === 0x2068 ||
      point === 0x2069
    ) {
      result += `\\u{${point.toString(16)}}`;
    } else {
      result += character;
    }
  }
  return result;
}

function truncateUtf8(value: string, maximumBytes: number): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return { text: value, truncated: false };
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
        truncated: true,
      };
    } catch {
      continue;
    }
  }
  return { text: "", truncated: true };
}

function validateLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw createDomainError({
      code: "invalid_input",
      message: `The ${label} byte limit must be a positive safe integer.`,
    });
  }
}
