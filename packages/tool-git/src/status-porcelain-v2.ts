import { Buffer, isUtf8 } from "node:buffer";

import { GitToolError } from "./git-error.js";
import type {
  GitBranchStatus,
  GitPathIdentity,
  GitStatusEntry,
  ParsedGitStatus,
} from "./git-types.js";

export interface StatusPorcelainV2Limits {
  readonly maximumBytes: number;
  readonly maximumRecords: number;
  readonly maximumPathBytes: number;
}

const DEFAULT_LIMITS: StatusPorcelainV2Limits = Object.freeze({
  maximumBytes: 4 * 1024 * 1024,
  maximumRecords: 100_000,
  maximumPathBytes: 16_384,
});

export function parseStatusPorcelainV2(
  input: Uint8Array,
  limits: StatusPorcelainV2Limits = DEFAULT_LIMITS,
): ParsedGitStatus {
  validateLimits(limits);
  const bytes = Buffer.from(input);
  if (bytes.byteLength > limits.maximumBytes) {
    parseFailure("Git status exceeds the parser byte bound.");
  }
  if (bytes.byteLength > 0 && bytes.at(-1) !== 0) {
    parseFailure("NUL-delimited Git status is missing its final delimiter.");
  }
  const records = splitNul(bytes);
  if (records.length > limits.maximumRecords) {
    parseFailure("Git status exceeds the parser record bound.");
  }
  const headers = new Map<string, string>();
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.byteLength === 0) {
      parseFailure("Git status contains an empty record.");
    }
    if (record[0] === 0x23) {
      parseHeader(record, headers);
      continue;
    }
    const marker = record[0];
    if (record[1] !== 0x20) parseFailure("A Git status record has an invalid marker.");
    if (marker === 0x31) {
      entries.push(parseOrdinary(record.subarray(2), limits));
    } else if (marker === 0x32) {
      const original = records[index + 1];
      if (original === undefined || original.byteLength === 0) {
        parseFailure("A rename/copy status record is missing its original path.");
      }
      entries.push(parseRename(record.subarray(2), original, limits));
      index += 1;
    } else if (marker === 0x75) {
      entries.push(parseUnmerged(record.subarray(2), limits));
    } else if (marker === 0x3f) {
      entries.push(simpleEntry("untracked", "??", record.subarray(2), limits));
    } else if (marker === 0x21) {
      entries.push(simpleEntry("ignored", "!!", record.subarray(2), limits));
    } else {
      parseFailure("Git status contains an unsupported record type.");
    }
  }
  return Object.freeze({
    branch: parseBranch(headers),
    entries: Object.freeze(entries),
  });
}

export function gitPathIdentity(
  input: Uint8Array,
  maximumPathBytes = DEFAULT_LIMITS.maximumPathBytes,
): GitPathIdentity {
  const bytes = Buffer.from(input);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumPathBytes ||
    bytes.includes(0)
  ) {
    parseFailure("A Git path is empty, oversized, or contains NUL.");
  }
  const utf8 = isUtf8(bytes) ? bytes.toString("utf8") : null;
  const display = safePathDisplay(bytes, utf8);
  return Object.freeze({
    bytesBase64: bytes.toString("base64"),
    utf8,
    display,
    safeForWorkspaceTools: utf8 === null ? false : workspaceSafePath(utf8),
  });
}

function parseOrdinary(
  record: Buffer,
  limits: StatusPorcelainV2Limits,
): GitStatusEntry {
  const parsed = fixedFields(record, 7);
  const xy = field(parsed.fields, 0);
  const submodule = field(parsed.fields, 1);
  const headMode = field(parsed.fields, 2);
  const indexMode = field(parsed.fields, 3);
  const worktreeMode = field(parsed.fields, 4);
  const headOid = field(parsed.fields, 5);
  const indexOid = field(parsed.fields, 6);
  validateXy(xy);
  validateSubmodule(submodule);
  for (const mode of [headMode, indexMode, worktreeMode]) validateMode(mode);
  for (const oid of [headOid, indexOid]) validateOid(oid);
  return Object.freeze({
    kind: "ordinary",
    xy,
    submodule,
    path: gitPathIdentity(parsed.remainder, limits.maximumPathBytes),
    originalPath: null,
    modes: Object.freeze({
      head: headMode,
      index: indexMode,
      worktree: worktreeMode,
    }),
    objectIds: Object.freeze({ head: headOid, index: indexOid }),
    renameOrCopyScore: null,
  });
}

function parseRename(
  record: Buffer,
  originalPath: Buffer,
  limits: StatusPorcelainV2Limits,
): GitStatusEntry {
  const parsed = fixedFields(record, 8);
  const xy = field(parsed.fields, 0);
  const submodule = field(parsed.fields, 1);
  const headMode = field(parsed.fields, 2);
  const indexMode = field(parsed.fields, 3);
  const worktreeMode = field(parsed.fields, 4);
  const headOid = field(parsed.fields, 5);
  const indexOid = field(parsed.fields, 6);
  const score = field(parsed.fields, 7);
  validateXy(xy);
  validateSubmodule(submodule);
  for (const mode of [headMode, indexMode, worktreeMode]) validateMode(mode);
  for (const oid of [headOid, indexOid]) validateOid(oid);
  if (!/^[RC](?:100|[0-9]{1,2})$/u.test(score)) {
    parseFailure("A Git rename/copy score is invalid.");
  }
  return Object.freeze({
    kind: "rename_or_copy",
    xy,
    submodule,
    path: gitPathIdentity(parsed.remainder, limits.maximumPathBytes),
    originalPath: gitPathIdentity(originalPath, limits.maximumPathBytes),
    modes: Object.freeze({
      head: headMode,
      index: indexMode,
      worktree: worktreeMode,
    }),
    objectIds: Object.freeze({ head: headOid, index: indexOid }),
    renameOrCopyScore: score,
  });
}

function parseUnmerged(
  record: Buffer,
  limits: StatusPorcelainV2Limits,
): GitStatusEntry {
  const parsed = fixedFields(record, 9);
  const xy = field(parsed.fields, 0);
  const submodule = field(parsed.fields, 1);
  const stage1Mode = field(parsed.fields, 2);
  const stage2Mode = field(parsed.fields, 3);
  const stage3Mode = field(parsed.fields, 4);
  const worktreeMode = field(parsed.fields, 5);
  const stage1Oid = field(parsed.fields, 6);
  const stage2Oid = field(parsed.fields, 7);
  const stage3Oid = field(parsed.fields, 8);
  validateXy(xy);
  validateSubmodule(submodule);
  for (const mode of [stage1Mode, stage2Mode, stage3Mode, worktreeMode]) {
    validateMode(mode);
  }
  for (const oid of [stage1Oid, stage2Oid, stage3Oid]) validateOid(oid);
  return Object.freeze({
    kind: "unmerged",
    xy,
    submodule,
    path: gitPathIdentity(parsed.remainder, limits.maximumPathBytes),
    originalPath: null,
    modes: Object.freeze({
      stage1: stage1Mode,
      stage2: stage2Mode,
      stage3: stage3Mode,
      worktree: worktreeMode,
    }),
    objectIds: Object.freeze({
      stage1: stage1Oid,
      stage2: stage2Oid,
      stage3: stage3Oid,
    }),
    renameOrCopyScore: null,
  });
}

function simpleEntry(
  kind: "untracked" | "ignored",
  xy: "??" | "!!",
  path: Buffer,
  limits: StatusPorcelainV2Limits,
): GitStatusEntry {
  return Object.freeze({
    kind,
    xy,
    submodule: null,
    path: gitPathIdentity(path, limits.maximumPathBytes),
    originalPath: null,
    modes: null,
    objectIds: null,
    renameOrCopyScore: null,
  });
}

function parseHeader(record: Buffer, headers: Map<string, string>): void {
  if (record[1] !== 0x20) parseFailure("A Git status header is malformed.");
  const separator = record.indexOf(0x20, 2);
  if (separator < 0) parseFailure("A Git status header has no value.");
  const keyBytes = record.subarray(2, separator);
  const valueBytes = record.subarray(separator + 1);
  if (!isAscii(keyBytes) || !isUtf8(valueBytes)) {
    parseFailure("A Git status header contains invalid encoding.");
  }
  const key = keyBytes.toString("ascii");
  const value = valueBytes.toString("utf8");
  if (headers.has(key)) parseFailure("A Git status header is duplicated.");
  headers.set(key, value);
}

function parseBranch(headers: ReadonlyMap<string, string>): GitBranchStatus {
  const oidValue = headers.get("branch.oid") ?? null;
  const headValue = headers.get("branch.head") ?? null;
  let oid: string | null = null;
  if (oidValue !== null && oidValue !== "(initial)") {
    validateOid(oidValue);
    oid = oidValue;
  }
  const head = headValue === "(detached)" ? null : headValue;
  let state: GitBranchStatus["state"] = "unknown";
  if (oidValue === "(initial)") state = "unborn";
  else if (headValue === "(detached)") state = "detached";
  else if (headValue !== null && oid !== null) state = "attached";
  let ahead: number | null = null;
  let behind: number | null = null;
  const ab = headers.get("branch.ab");
  if (ab !== undefined) {
    const match = /^\+([0-9]+) -([0-9]+)$/u.exec(ab);
    if (match === null) parseFailure("Git branch ahead/behind metadata is invalid.");
    ahead = safeCount(match[1]);
    behind = safeCount(match[2]);
  }
  return Object.freeze({
    oid,
    head,
    upstream: headers.get("branch.upstream") ?? null,
    ahead,
    behind,
    state,
  });
}

function fixedFields(
  record: Buffer,
  fieldCount: number,
): { readonly fields: readonly string[]; readonly remainder: Buffer } {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(0x20, offset);
    if (separator < 0 || separator === offset) {
      parseFailure("A Git status record has missing fields.");
    }
    const field = record.subarray(offset, separator);
    if (!isAscii(field)) parseFailure("A Git status field is not ASCII.");
    fields.push(field.toString("ascii"));
    offset = separator + 1;
  }
  const remainder = record.subarray(offset);
  if (remainder.byteLength === 0) parseFailure("A Git status record has no path.");
  return { fields: Object.freeze(fields), remainder };
}

function field(fields: readonly string[], index: number): string {
  const value = fields[index];
  if (value === undefined) parseFailure("A Git status field is missing.");
  return value;
}

function splitNul(bytes: Buffer): Buffer[] {
  if (bytes.byteLength === 0) return [];
  const records: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const delimiter = bytes.indexOf(0, offset);
    if (delimiter < 0) parseFailure("Git status is not NUL-delimited.");
    records.push(Buffer.from(bytes.subarray(offset, delimiter)));
    offset = delimiter + 1;
  }
  return records;
}

function validateXy(value: string): void {
  if (!/^[.MADRCUT?!]{2}$/u.test(value)) {
    parseFailure("A Git status XY field is invalid.");
  }
}

function validateSubmodule(value: string): void {
  if (!/^(?:N\.\.\.|S[.C][.M][.U])$/u.test(value)) {
    parseFailure("A Git status submodule field is invalid.");
  }
}

function validateMode(value: string): void {
  if (!/^[0-7]{6}$/u.test(value)) parseFailure("A Git status mode is invalid.");
}

function validateOid(value: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    parseFailure("A Git object identifier is invalid.");
  }
}

function safePathDisplay(bytes: Buffer, utf8: string | null): string {
  if (utf8 === null) {
    let output = "";
    for (const byte of bytes) {
      if (byte >= 0x20 && byte <= 0x7e && byte !== 0x5c) {
        output += String.fromCharCode(byte);
      } else {
        output += `\\x${byte.toString(16).padStart(2, "0")}`;
      }
    }
    return output;
  }
  let output = "";
  for (const character of utf8) {
    const point = character.codePointAt(0);
    if (point === undefined) continue;
    if (
      point < 0x20 ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    ) {
      output +=
        point <= 0xff
          ? `\\x${point.toString(16).padStart(2, "0")}`
          : `\\u${point.toString(16).padStart(4, "0")}`;
    } else {
      output += character;
    }
  }
  return output;
}

function workspaceSafePath(value: string): boolean {
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("\u0000")
  ) {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isAscii(bytes: Buffer): boolean {
  return bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
}

function safeCount(value: string | undefined): number {
  if (value === undefined) parseFailure("Git branch count metadata is missing.");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    parseFailure("Git branch count metadata exceeds a safe integer.");
  }
  return count;
}

function validateLimits(limits: StatusPorcelainV2Limits): void {
  for (const value of [
    limits.maximumBytes,
    limits.maximumRecords,
    limits.maximumPathBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new GitToolError("invalid_request", "Git status parser limits are invalid.");
    }
  }
}

function parseFailure(message: string): never {
  throw new GitToolError("parse_failed", message);
}
