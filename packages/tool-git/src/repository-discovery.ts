import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { GitToolError } from "./git-error.js";
import { captureGitStatusSnapshot } from "./git-read-tools.js";
import type { ControlledGitRunner } from "./git-runner.js";
import type {
  GitFilesystemIdentity,
  GitIndexIdentity,
  GitRemoteIdentity,
  GitRepositoryIdentity,
} from "./git-types.js";

const MAXIMUM_INDEX_BYTES = 64 * 1024 * 1024;

export async function discoverGitRepository(
  runner: ControlledGitRunner,
  signal?: AbortSignal,
): Promise<GitRepositoryIdentity> {
  const bare = parseBoolean(await singleLine(runner, ["--is-bare-repository"], signal));
  if (bare) {
    throw new GitToolError("unsafe_repository", "Robin does not treat a bare repository as a coding workspace.");
  }
  const workspaceRoot = await canonicalGitPath(
    runner,
    ["--path-format=absolute", "--show-toplevel"],
    signal,
  );
  if (workspaceRoot !== await realpath(runner.cwd)) {
    throw new GitToolError(
      "unsafe_repository",
      "The controlled Git working directory must be the repository top level.",
    );
  }
  const gitDirectory = await canonicalGitPath(
    runner,
    ["--path-format=absolute", "--git-dir"],
    signal,
  );
  const commonDirectory = await canonicalGitPath(
    runner,
    ["--path-format=absolute", "--git-common-dir"],
    signal,
  );
  const indexPath = await absoluteGitPath(
    runner,
    ["--path-format=absolute", "--git-path", "index"],
    signal,
  );
  if (!containedBy(indexPath, gitDirectory) && !containedBy(indexPath, commonDirectory)) {
    throw new GitToolError("unsafe_repository", "The Git index resolves outside repository storage.");
  }
  const objectFormatValue = await singleLine(runner, ["--show-object-format"], signal);
  if (objectFormatValue !== "sha1" && objectFormatValue !== "sha256") {
    throw new GitToolError("parse_failed", "Git reported an unsupported object format.");
  }
  const shallow = parseBoolean(
    await singleLine(runner, ["--is-shallow-repository"], signal),
  );
  const superproject = await singleLine(
    runner,
    ["--show-superproject-working-tree"],
    signal,
  );
  const sparseResult = await runner.runRead(
    "config",
    ["--local", "--no-includes", "--bool", "--get", "core.sparseCheckout"],
    {
      signal,
      allowedExitCodes: [0, 1],
      maximumRetainedStdoutBytes: 32,
      maximumAbsoluteStdoutBytes: 32,
    },
  );
  const sparse = sparseResult.exitCode === 0
    ? parseBoolean(stripFinalLineEnding(sparseResult.stdout))
    : false;
  const [workspaceRootIdentity, gitDirectoryIdentity, commonDirectoryIdentity] =
    await Promise.all([
      filesystemIdentity(workspaceRoot),
      filesystemIdentity(gitDirectory),
      filesystemIdentity(commonDirectory),
    ]);
  const index = await readIndexIdentity(indexPath);
  const [status, remotes, operationState] = await Promise.all([
    captureGitStatusSnapshot(runner, { signal }),
    readRemoteIdentities(runner, signal),
    detectOperationState(gitDirectory),
  ]);
  const stableFacts = {
    workspaceRoot,
    workspaceRootIdentity,
    gitDirectory,
    gitDirectoryIdentity,
    commonDirectory,
    commonDirectoryIdentity,
    objectFormat: objectFormatValue,
  };
  return Object.freeze({
    repositoryId: createHash("sha256").update(canonicalJson(stableFacts)).digest("hex"),
    workspaceRoot,
    workspaceRootIdentity,
    gitDirectory,
    gitDirectoryIdentity,
    commonDirectory,
    commonDirectoryIdentity,
    objectFormat: objectFormatValue,
    branch: status.branch,
    index,
    remotes,
    bare,
    shallow,
    sparse,
    linkedWorktree: gitDirectory !== commonDirectory,
    submodule: superproject.length > 0,
    operationState,
  });
}

export async function revalidateGitRepository(
  runner: ControlledGitRunner,
  expected: GitRepositoryIdentity,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const [workspaceRoot, gitDirectory, commonDirectory, objectFormat] = await Promise.all([
      canonicalGitPath(runner, ["--path-format=absolute", "--show-toplevel"], signal),
      canonicalGitPath(runner, ["--path-format=absolute", "--git-dir"], signal),
      canonicalGitPath(runner, ["--path-format=absolute", "--git-common-dir"], signal),
      singleLine(runner, ["--show-object-format"], signal),
    ]);
    if (
      workspaceRoot !== expected.workspaceRoot ||
      gitDirectory !== expected.gitDirectory ||
      commonDirectory !== expected.commonDirectory ||
      objectFormat !== expected.objectFormat
    ) return false;
    const [rootIdentity, gitIdentity, commonIdentity] = await Promise.all([
      filesystemIdentity(workspaceRoot),
      filesystemIdentity(gitDirectory),
      filesystemIdentity(commonDirectory),
    ]);
    return (
      sameFilesystemIdentity(rootIdentity, expected.workspaceRootIdentity) &&
      sameFilesystemIdentity(gitIdentity, expected.gitDirectoryIdentity) &&
      sameFilesystemIdentity(commonIdentity, expected.commonDirectoryIdentity)
    );
  } catch {
    return false;
  }
}

async function singleLine(
  runner: ControlledGitRunner,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await runner.runRead("rev-parse", args, {
    signal,
    maximumRetainedStdoutBytes: 64 * 1024,
    maximumAbsoluteStdoutBytes: 64 * 1024,
  });
  return stripFinalLineEnding(result.stdout);
}

async function canonicalGitPath(
  runner: ControlledGitRunner,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return realpath(await absoluteGitPath(runner, args, signal));
}

async function absoluteGitPath(
  runner: ControlledGitRunner,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const value = await singleLine(runner, args, signal);
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new GitToolError("parse_failed", "Git did not return an absolute repository path.");
  }
  return path.normalize(value);
}

async function filesystemIdentity(value: string): Promise<GitFilesystemIdentity> {
  const facts = await stat(value, { bigint: true });
  return Object.freeze({
    device: facts.dev.toString(),
    inode: facts.ino.toString(),
    mode: facts.mode.toString(8),
  });
}

async function readIndexIdentity(indexPath: string): Promise<GitIndexIdentity> {
  try {
    const pathFacts = await lstat(indexPath, { bigint: true });
    if (pathFacts.isSymbolicLink() || !pathFacts.isFile() || pathFacts.size > BigInt(MAXIMUM_INDEX_BYTES)) {
      throw new GitToolError("unsafe_repository", "The Git index is not a bounded regular file.");
    }
    const handle = await open(indexPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let handleFacts;
    let afterHandleFacts;
    let bytes: Buffer;
    try {
      handleFacts = await handle.stat({ bigint: true });
      if (
        !handleFacts.isFile() ||
        !sameStatIdentity(pathFacts, handleFacts) ||
        handleFacts.size > BigInt(MAXIMUM_INDEX_BYTES)
      ) {
        throw new GitToolError("repository_changed", "The Git index changed before Robin opened it.");
      }
      bytes = Buffer.alloc(Number(handleFacts.size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      if (offset !== bytes.byteLength) {
        throw new GitToolError("repository_changed", "The Git index changed while Robin read it.");
      }
      afterHandleFacts = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    const afterPathFacts = await lstat(indexPath, { bigint: true });
    if (
      afterPathFacts.isSymbolicLink() ||
      !sameStatIdentity(handleFacts, afterHandleFacts) ||
      !sameStatIdentity(afterHandleFacts, afterPathFacts) ||
      afterHandleFacts.size !== handleFacts.size ||
      afterHandleFacts.mtimeNs !== handleFacts.mtimeNs ||
      afterPathFacts.mtimeNs !== handleFacts.mtimeNs
    ) {
      throw new GitToolError("repository_changed", "The Git index changed while Robin hashed it.");
    }
    return Object.freeze({
      path: indexPath,
      exists: true,
      fileIdentity: Object.freeze({
        device: handleFacts.dev.toString(),
        inode: handleFacts.ino.toString(),
        mode: handleFacts.mode.toString(8),
      }),
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) throw error;
    return Object.freeze({
      path: indexPath,
      exists: false,
      fileIdentity: null,
      byteLength: null,
      sha256: null,
    });
  }
}

async function readRemoteIdentities(
  runner: ControlledGitRunner,
  signal?: AbortSignal,
): Promise<readonly GitRemoteIdentity[]> {
  const namesResult = await runner.runRead(
    "config",
    [
      "--local",
      "--no-includes",
      "--null",
      "--name-only",
      "--get-regexp",
      "^remote\\..*\\.url$",
    ],
    {
      signal,
      allowedExitCodes: [0, 1],
      maximumRetainedStdoutBytes: 256 * 1024,
      maximumAbsoluteStdoutBytes: 256 * 1024,
    },
  );
  if (namesResult.exitCode === 1 || namesResult.stdout.byteLength === 0) return Object.freeze([]);
  const keys = nulValues(namesResult.stdout);
  const remotes = new Map<string, Set<string>>();
  for (const key of keys) {
    const match = /^remote\.([^\0.]{1,256})\.url$/u.exec(key);
    if (match?.[1] === undefined) {
      throw new GitToolError("parse_failed", "Git returned an invalid remote URL key.");
    }
    const values = await runner.runRead(
      "config",
      ["--local", "--no-includes", "--null", "--get-all", key],
      {
        signal,
        allowedExitCodes: [0, 1],
        maximumRetainedStdoutBytes: 256 * 1024,
        maximumAbsoluteStdoutBytes: 256 * 1024,
      },
    );
    const urls = remotes.get(match[1]) ?? new Set<string>();
    for (const value of nulValues(values.stdout)) urls.add(sanitizeRemoteUrl(value));
    remotes.set(match[1], urls);
  }
  return Object.freeze(
    [...remotes]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([name, urls]) => Object.freeze({
        name,
        fetchUrls: Object.freeze([...urls].sort()),
      })),
  );
}

async function detectOperationState(
  gitDirectory: string,
): Promise<GitRepositoryIdentity["operationState"]> {
  const checks: readonly (readonly [GitRepositoryIdentity["operationState"][number], readonly string[]])[] = [
    ["merge", ["MERGE_HEAD"]],
    ["rebase", ["rebase-apply", "rebase-merge"]],
    ["cherry_pick", ["CHERRY_PICK_HEAD"]],
    ["revert", ["REVERT_HEAD"]],
    ["bisect", ["BISECT_LOG"]],
  ];
  const active: GitRepositoryIdentity["operationState"][number][] = [];
  for (const [state, names] of checks) {
    if (await anyExists(names.map((name) => path.join(gitDirectory, name)))) active.push(state);
  }
  return Object.freeze(active);
}

async function anyExists(paths: readonly string[]): Promise<boolean> {
  for (const candidate of paths) {
    try {
      await lstat(candidate);
      return true;
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  return false;
}

function nulValues(bytes: Uint8Array): readonly string[] {
  if (bytes.byteLength === 0) return Object.freeze([]);
  const buffer = Buffer.from(bytes);
  if (buffer.at(-1) !== 0) throw new GitToolError("parse_failed", "Git config output is not NUL-delimited.");
  return Object.freeze(buffer.subarray(0, -1).toString("utf8").split("\0"));
}

function sanitizeRemoteUrl(value: string): string {
  if (
    value.length === 0 ||
    value.length > 8_192 ||
    [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 0x20 || (point >= 0x7f && point <= 0x9f);
    })
  ) {
    throw new GitToolError("parse_failed", "A Git remote URL is invalid.");
  }
  try {
    const url = new URL(value);
    if (!/^(?:file|git|https?|ssh):$/u.test(url.protocol)) throw new Error("unsupported URL scheme");
    if (url.protocol === "file:") {
      return `file:sha256:${createHash("sha256").update(url.pathname).digest("hex")}`;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const scp = /^(?:[^@]+@)?(\[[^\]]+\]|[^/:@\s]+):(.+)$/u.exec(value);
    if (scp?.[1] !== undefined && scp[2] !== undefined) {
      const repositoryPath = scp[2]
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      return `ssh://${scp[1]}/${repositoryPath}`;
    }
    return `local:sha256:${createHash("sha256").update(value).digest("hex")}`;
  }
}

function sameStatIdentity(
  left: { readonly dev: bigint; readonly ino: bigint; readonly mode: bigint },
  right: { readonly dev: bigint; readonly ino: bigint; readonly mode: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function stripFinalLineEnding(input: Uint8Array): string {
  const buffer = Buffer.from(input);
  let end = buffer.byteLength;
  if (end > 0 && buffer[end - 1] === 0x0a) end -= 1;
  if (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
  const value = buffer.subarray(0, end).toString("utf8");
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new GitToolError("parse_failed", "Git returned more than one output line.");
  }
  return value;
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new GitToolError("parse_failed", "Git returned an invalid boolean.");
}

function sameFilesystemIdentity(
  left: GitFilesystemIdentity,
  right: GitFilesystemIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
}

function containedBy(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
