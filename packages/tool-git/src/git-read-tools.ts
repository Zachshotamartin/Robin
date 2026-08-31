import { Buffer, isUtf8 } from "node:buffer";

import { GitToolError } from "./git-error.js";
import { ControlledGitRunner, renderGitBytesSafely } from "./git-runner.js";
import { parseStatusPorcelainV2 } from "./status-porcelain-v2.js";
import type { GitStatusSnapshot } from "./git-types.js";

export interface CaptureGitStatusOptions {
  readonly includeIgnored?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface GitCurrentBranch {
  readonly state: "attached" | "detached" | "unborn" | "unknown";
  readonly name: string | null;
  readonly oid: string | null;
}

export interface GitLogOptions {
  readonly maximumCommits: number;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal | undefined;
}

export interface GitLogEntry {
  readonly oid: string;
  readonly parentOids: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly subject: string;
}

export interface GitDiffRequest {
  readonly kind: "working" | "staged";
  readonly paths: readonly string[];
  readonly maximumFiles: number;
  readonly maximumRetainedBytes: number;
  readonly maximumAbsoluteBytes: number;
  readonly signal?: AbortSignal | undefined;
}

export interface GitDiffResult {
  readonly kind: GitDiffRequest["kind"];
  readonly paths: readonly string[];
  readonly text: string;
  readonly encoding: "utf8" | "escaped_binary";
  readonly totalBytes: number;
  readonly retainedBytes: number;
  readonly omittedBytes: number;
  readonly truncated: boolean;
  readonly sha256: string;
  readonly submoduleWorktreeEvidence: "not_collected_for_execution_safety";
}

export async function captureGitStatusSnapshot(
  runner: ControlledGitRunner,
  options: CaptureGitStatusOptions = {},
): Promise<GitStatusSnapshot> {
  const args = [
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
    "--no-renames",
  ];
  if (options.includeIgnored === true) args.push("--ignored=matching");
  const result = await runner.runRead("status", args, {
    signal: options.signal,
    maximumRetainedStdoutBytes: runner.maximumStdoutBytes,
    maximumAbsoluteStdoutBytes: runner.maximumStdoutBytes,
  });
  if (result.stdoutTruncated) {
    throw new GitToolError("invariant_violated", "A status snapshot was unexpectedly truncated.");
  }
  const parsed = parseStatusPorcelainV2(result.stdout, {
    maximumBytes: runner.maximumStdoutBytes,
    maximumRecords: 100_000,
    maximumPathBytes: 16_384,
  });
  return Object.freeze({
    ...parsed,
    capturedAt: new Date().toISOString(),
    statusSha256: result.stdoutSha256,
    submoduleWorktreeEvidence: "not_collected_for_execution_safety",
  });
}

export async function readCurrentBranch(
  runner: ControlledGitRunner,
  signal?: AbortSignal,
): Promise<GitCurrentBranch> {
  const status = await captureGitStatusSnapshot(runner, { signal });
  return Object.freeze({
    state: status.branch.state,
    name: status.branch.head,
    oid: status.branch.oid,
  });
}

export async function readGitLog(
  runner: ControlledGitRunner,
  options: GitLogOptions,
): Promise<readonly GitLogEntry[]> {
  const maximumCommits = bounded(options.maximumCommits, 1, 1_000, "maximumCommits");
  const maximumBytes = bounded(
    options.maximumBytes,
    1,
    runner.maximumStdoutBytes,
    "maximumBytes",
  );
  const result = await runner.runRead(
    "log",
    [
      "-z",
      `--max-count=${maximumCommits}`,
      "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s",
    ],
    {
      signal: options.signal,
      maximumRetainedStdoutBytes: maximumBytes,
      maximumAbsoluteStdoutBytes: maximumBytes,
    },
  );
  if (result.stdout.byteLength === 0) return Object.freeze([]);
  if (result.stdout.at(-1) !== 0) {
    throw new GitToolError("parse_failed", "NUL-delimited Git log has no final delimiter.");
  }
  const fields = result.stdout.subarray(0, -1).toString("utf8").split("\0");
  if (fields.length % 6 !== 0 || fields.length / 6 > maximumCommits) {
    throw new GitToolError("parse_failed", "Git log returned an invalid record shape.");
  }
  const entries: GitLogEntry[] = [];
  for (let offset = 0; offset < fields.length; offset += 6) {
    const oid = fields[offset] ?? "";
    const parents = fields[offset + 1] ?? "";
    const authorName = fields[offset + 2] ?? "";
    const authorEmail = fields[offset + 3] ?? "";
    const authoredAt = fields[offset + 4] ?? "";
    const subject = fields[offset + 5] ?? "";
    if (
      !validOid(oid) ||
      (parents.length > 0 && !parents.split(" ").every(validOid)) ||
      authorName.includes("\n") ||
      authorEmail.includes("\n") ||
      Number.isNaN(Date.parse(authoredAt)) ||
      subject.includes("\n")
    ) {
      throw new GitToolError("parse_failed", "Git log contains invalid commit metadata.");
    }
    entries.push(Object.freeze({
      oid,
      parentOids: Object.freeze(parents.length === 0 ? [] : parents.split(" ")),
      authorName: renderGitBytesSafely(Buffer.from(authorName)),
      authorEmail: renderGitBytesSafely(Buffer.from(authorEmail)),
      authoredAt,
      subject: renderGitBytesSafely(Buffer.from(subject)),
    }));
  }
  return Object.freeze(entries);
}

export async function readGitDiff(
  runner: ControlledGitRunner,
  request: GitDiffRequest,
): Promise<GitDiffResult> {
  if (request.kind !== "working" && request.kind !== "staged") invalidDiff();
  const maximumFiles = bounded(request.maximumFiles, 1, 10_000, "maximumFiles");
  const retained = bounded(
    request.maximumRetainedBytes,
    1,
    runner.maximumStdoutBytes,
    "maximumRetainedBytes",
  );
  const absolute = bounded(
    request.maximumAbsoluteBytes,
    retained,
    runner.maximumStdoutBytes,
    "maximumAbsoluteBytes",
  );
  const paths = Object.freeze(request.paths.map(normalizeModelPath));
  if (new Set(paths).size !== paths.length || paths.length > maximumFiles) invalidDiff();
  const baseArgs = request.kind === "staged" ? ["--cached"] : [];
  if (paths.length === 0) {
    const names = await runner.runRead(
      "diff",
      [...baseArgs, "--name-only", "-z", "--"],
      {
        signal: request.signal,
        maximumRetainedStdoutBytes: runner.maximumStdoutBytes,
        maximumAbsoluteStdoutBytes: runner.maximumStdoutBytes,
      },
    );
    if (names.stdoutTruncated || (names.stdout.byteLength > 0 && names.stdout.at(-1) !== 0)) {
      throw new GitToolError("parse_failed", "Git diff path enumeration was incomplete.");
    }
    const count = names.stdout.byteLength === 0
      ? 0
      : names.stdout.subarray(0, -1).toString("utf8").split("\0").length;
    if (count > maximumFiles) {
      throw new GitToolError("output_limit", "Git diff exceeds the approved file-count bound.", {
        maximumFiles,
        observedFiles: count,
      });
    }
  }
  const result = await runner.runRead("diff", [...baseArgs, "--", ...paths], {
    signal: request.signal,
    maximumRetainedStdoutBytes: retained,
    maximumAbsoluteStdoutBytes: absolute,
  });
  const utf8 = isUtf8(result.stdout);
  const text = utf8
    ? renderGitBytesSafely(result.stdout)
    : escapeBinary(result.stdout);
  return Object.freeze({
    kind: request.kind,
    paths,
    text,
    encoding: utf8 ? "utf8" : "escaped_binary",
    totalBytes: result.stdoutBytes,
    retainedBytes: result.stdout.byteLength,
    omittedBytes: Math.max(0, result.stdoutBytes - result.stdout.byteLength),
    truncated: result.stdoutTruncated,
    sha256: result.stdoutSha256,
    submoduleWorktreeEvidence: "not_collected_for_execution_safety",
  });
}

function normalizeModelPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    invalidDiff();
  }
  return value;
}

function escapeBinary(input: Uint8Array): string {
  let output = "";
  for (const byte of input) {
    output += byte >= 0x20 && byte <= 0x7e && byte !== 0x5c
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return output;
}

function validOid(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GitToolError("invalid_request", `${label} is outside its approved bound.`);
  }
  return value;
}

function invalidDiff(): never {
  throw new GitToolError("invalid_request", "The Git diff request is invalid.");
}
