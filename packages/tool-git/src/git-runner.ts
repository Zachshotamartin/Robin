import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { devNull } from "node:os";
import { performance } from "node:perf_hooks";

import { GitToolError } from "./git-error.js";

export type GitReadCommand =
  | "config"
  | "diff"
  | "log"
  | "rev-parse"
  | "status"
  | "symbolic-ref";

export interface ControlledGitRunnerOptions {
  readonly gitExecutable: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly maximumStdoutBytes: number;
  readonly maximumStderrBytes: number;
  readonly terminationGraceMs?: number;
  readonly forceWaitMs?: number;
}

export interface GitRunOptions {
  readonly signal?: AbortSignal | undefined;
  readonly allowedExitCodes?: readonly number[];
  readonly maximumRetainedStdoutBytes?: number;
  readonly maximumAbsoluteStdoutBytes?: number;
}

export interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly stdoutTruncated: boolean;
  readonly durationMs: number;
}

type StopReason = "cancelled" | "timeout" | "output_limit";

const SAFE_ENVIRONMENT_KEYS = new Set([
  "ComSpec",
  "HOME",
  "PATH",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

const FIXED_CONFIG = Object.freeze([
  "color.ui=false",
  "core.askPass=",
  "core.attributesFile=" + devNull,
  "core.excludesFile=" + devNull,
  "core.fsmonitor=false",
  "core.pager=cat",
  "credential.helper=",
  "credential.interactive=false",
  "diff.external=",
  "interactive.singleKey=false",
  "pager.diff=false",
  "pager.log=false",
  "pager.status=false",
]);

export class ControlledGitRunner {
  public readonly gitExecutable: string;
  public readonly cwd: string;
  public readonly timeoutMs: number;
  public readonly maximumStdoutBytes: number;
  public readonly maximumStderrBytes: number;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #terminationGraceMs: number;
  readonly #forceWaitMs: number;
  #filterOverrides: Promise<readonly string[]> | null = null;

  public constructor(options: ControlledGitRunnerOptions) {
    if (!isAbsolute(options.gitExecutable) || !isAbsolute(options.cwd)) {
      throw new GitToolError(
        "invalid_request",
        "The Git executable and repository working directory must be absolute.",
      );
    }
    this.gitExecutable = options.gitExecutable;
    this.cwd = options.cwd;
    this.timeoutMs = boundedInteger(options.timeoutMs, 1, 600_000, "timeoutMs");
    this.maximumStdoutBytes = boundedInteger(
      options.maximumStdoutBytes,
      1,
      64 * 1024 * 1024,
      "maximumStdoutBytes",
    );
    this.maximumStderrBytes = boundedInteger(
      options.maximumStderrBytes,
      1,
      16 * 1024 * 1024,
      "maximumStderrBytes",
    );
    this.#terminationGraceMs = boundedInteger(
      options.terminationGraceMs ?? 100,
      1,
      10_000,
      "terminationGraceMs",
    );
    this.#forceWaitMs = boundedInteger(
      options.forceWaitMs ?? 2_000,
      1,
      30_000,
      "forceWaitMs",
    );
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.environment)) {
      if (value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key)) environment[key] = value;
    }
    Object.assign(environment, {
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: devNull,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      PAGER: "cat",
      SSH_ASKPASS: devNull,
      SSH_ASKPASS_REQUIRE: "never",
    });
    this.#environment = Object.freeze(environment);
    Object.freeze(this);
  }

  public async runRead(
    command: GitReadCommand,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitRunResult> {
    validateReadArguments(command, args);
    const filterOverrides =
      command === "config" ? Object.freeze([]) : await this.#executionFilterOverrides();
    return this.#run(command, args, options, filterOverrides);
  }

  async #executionFilterOverrides(): Promise<readonly string[]> {
    this.#filterOverrides ??= this.#loadExecutionFilterOverrides();
    return this.#filterOverrides;
  }

  async #loadExecutionFilterOverrides(): Promise<readonly string[]> {
    const result = await this.#run(
      "config",
      [
        "--includes",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process|required)$",
      ],
      {
        allowedExitCodes: [0, 1],
        maximumRetainedStdoutBytes: Math.min(this.maximumStdoutBytes, 512 * 1024),
        maximumAbsoluteStdoutBytes: Math.min(this.maximumStdoutBytes, 512 * 1024),
      },
      Object.freeze([]),
    );
    const names = result.stdout.byteLength === 0
      ? []
      : result.stdout.subarray(0, result.stdout.at(-1) === 0 ? -1 : undefined).toString("utf8").split("\0");
    const drivers = new Set<string>();
    for (const name of names) {
      const match = /^filter\.([A-Za-z0-9_-]{1,128})\.(?:clean|smudge|process|required)$/u.exec(name);
      if (match?.[1] === undefined) {
        throw new GitToolError(
          "unsafe_repository",
          "The repository config contains a filter key Robin cannot neutralize safely.",
        );
      }
      drivers.add(match[1]);
    }
    const overrides: string[] = [];
    for (const driver of [...drivers].sort()) {
      overrides.push(
        `filter.${driver}.clean=`,
        `filter.${driver}.process=`,
        `filter.${driver}.required=false`,
        `filter.${driver}.smudge=`,
      );
    }
    return Object.freeze(overrides);
  }

  async #run(
    command: GitReadCommand,
    args: readonly string[],
    options: GitRunOptions,
    filterOverrides: readonly string[],
  ): Promise<GitRunResult> {
    const retainedLimit = boundedInteger(
      options.maximumRetainedStdoutBytes ?? this.maximumStdoutBytes,
      1,
      this.maximumStdoutBytes,
      "maximumRetainedStdoutBytes",
    );
    const absoluteLimit = boundedInteger(
      options.maximumAbsoluteStdoutBytes ?? this.maximumStdoutBytes,
      retainedLimit,
      this.maximumStdoutBytes,
      "maximumAbsoluteStdoutBytes",
    );
    const allowedExitCodes = new Set(options.allowedExitCodes ?? [0]);
    if (
      allowedExitCodes.size === 0 ||
      [...allowedExitCodes].some((value) => !Number.isSafeInteger(value) || value < 0 || value > 255)
    ) {
      throw new GitToolError("invalid_request", "Allowed Git exit codes are invalid.");
    }
    if (options.signal?.aborted === true) {
      throw new GitToolError("cancelled", "Git read was cancelled before spawn.");
    }
    const gitArgs = ["--no-pager"];
    for (const setting of [...FIXED_CONFIG, ...filterOverrides]) gitArgs.push("-c", setting);
    if (command === "status") gitArgs.push(command, "--ignore-submodules=all", ...args);
    else if (command === "diff") {
      gitArgs.push(command, "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all", ...args);
    } else if (command === "log") gitArgs.push(command, "--no-show-signature", "--no-color", ...args);
    else gitArgs.push(command, ...args);

    const startedAt = performance.now();
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    const stdoutParts: Buffer[] = [];
    const stderrParts: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutRetained = 0;
    let stderrRetained = 0;
    let stopReason: StopReason | null = null;
    let spawned = false;
    let closeObserved = false;
    let exitCode: number | null = null;
    let child: ChildProcessWithoutNullStreams;
    let gracefulTimer: NodeJS.Timeout | null = null;
    let forceTimer: NodeJS.Timeout | null = null;
    let forceSettle: (() => void) | null = null;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!spawned || child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error: unknown) {
        if (!hasCode(error, "ESRCH")) return;
      }
    };
    const requestStop = (reason: StopReason): void => {
      if (closeObserved || stopReason !== null) return;
      stopReason = reason;
      signalGroup("SIGTERM");
      gracefulTimer = setTimeout(() => signalGroup("SIGKILL"), this.#terminationGraceMs);
      forceTimer = setTimeout(() => forceSettle?.(), this.#terminationGraceMs + this.#forceWaitMs);
    };
    const onAbort = (): void => requestStop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const completion = new Promise<"close" | "spawn_error" | "deadline">((resolve) => {
      forceSettle = () => resolve("deadline");
      try {
        child = spawn(this.gitExecutable, gitArgs, {
          cwd: this.cwd,
          env: { ...this.#environment },
          shell: false,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        resolve("spawn_error");
        return;
      }
      child.once("spawn", () => {
        spawned = true;
        if (stopReason !== null) signalGroup("SIGTERM");
      });
      child.once("error", () => {
        if (!spawned) resolve("spawn_error");
        else requestStop("output_limit");
      });
      child.once("exit", (code) => {
        exitCode = code;
      });
      child.once("close", (code) => {
        closeObserved = true;
        exitCode ??= code;
        resolve("close");
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutHash.update(chunk);
        stdoutBytes += chunk.byteLength;
        if (stdoutRetained < retainedLimit) {
          const retained = Buffer.from(chunk.subarray(0, retainedLimit - stdoutRetained));
          stdoutParts.push(retained);
          stdoutRetained += retained.byteLength;
        }
        if (stdoutBytes > absoluteLimit) requestStop("output_limit");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrHash.update(chunk);
        stderrBytes += chunk.byteLength;
        if (stderrRetained < this.maximumStderrBytes) {
          const retained = Buffer.from(chunk.subarray(0, this.maximumStderrBytes - stderrRetained));
          stderrParts.push(retained);
          stderrRetained += retained.byteLength;
        }
        if (stderrBytes > this.maximumStderrBytes) requestStop("output_limit");
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end();
    });
    const timeout = setTimeout(() => requestStop("timeout"), this.timeoutMs);
    const completed = await completion;
    clearTimeout(timeout);
    if (gracefulTimer !== null) clearTimeout(gracefulTimer);
    if (forceTimer !== null) clearTimeout(forceTimer);
    options.signal?.removeEventListener("abort", onAbort);
    if (completed === "deadline") {
      child!.stdout.removeAllListeners("data");
      child!.stderr.removeAllListeners("data");
      child!.stdout.destroy();
      child!.stderr.destroy();
      child!.stdin.destroy();
    }
    if (completed === "spawn_error") {
      throw new GitToolError("executable_not_found", "Robin could not spawn the Git executable.");
    }
    if (
      completed === "close" &&
      child!.pid !== undefined &&
      await processGroupExists(child!.pid)
    ) {
      signalOwnedGroup(child!, "SIGTERM");
      if (!(await waitForGroupAbsence(child!.pid, this.#terminationGraceMs))) {
        signalOwnedGroup(child!, "SIGKILL");
      }
      if (!(await waitForGroupAbsence(child!.pid, this.#forceWaitMs))) {
        throw new GitToolError(
          "git_failed",
          "A Git-owned process group remained alive after the read settled.",
        );
      }
    }
    const result = Object.freeze({
      exitCode: exitCode ?? -1,
      stdout: Buffer.concat(stdoutParts),
      stderr: Buffer.concat(stderrParts),
      stdoutBytes,
      stderrBytes,
      stdoutSha256: stdoutHash.digest("hex"),
      stderrSha256: stderrHash.digest("hex"),
      stdoutTruncated: stdoutBytes > stdoutRetained,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
    if (completed === "deadline") {
      throw new GitToolError("git_failed", "Git supervision did not settle after forced termination.");
    }
    if (stopReason === "cancelled") throw new GitToolError("cancelled", "Git read was cancelled.");
    if (stopReason === "timeout") throw new GitToolError("timeout", "Git read exceeded its time bound.");
    if (stopReason === "output_limit") {
      throw new GitToolError("output_limit", "Git output exceeded its absolute byte bound.", {
        stdoutBytes,
        stderrBytes,
      });
    }
    if (!allowedExitCodes.has(result.exitCode)) {
      const stderr = renderGitBytesSafely(result.stderr);
      if (/detected dubious ownership/u.test(stderr)) {
        throw new GitToolError("unsafe_repository", "Git rejected the repository ownership boundary.");
      }
      if (/not a git repository/u.test(stderr)) {
        throw new GitToolError("not_repository", "The working directory is not a Git repository.");
      }
      throw new GitToolError("git_failed", "A controlled Git read failed.", {
        exitCode: result.exitCode,
        stderr: stderr.slice(0, 2_048),
      });
    }
    return result;
  }
}

export function renderGitBytesSafely(input: Uint8Array): string {
  let output = "";
  for (const character of Buffer.from(input).toString("utf8")) {
    const point = character.codePointAt(0);
    if (point === undefined) continue;
    if (point === 0x0a || point === 0x0d || point === 0x09) output += character;
    else if (
      point < 0x20 ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    ) {
      output += point <= 0xff
        ? `\\x${point.toString(16).padStart(2, "0")}`
        : `\\u${point.toString(16).padStart(4, "0")}`;
    } else output += character;
  }
  return output;
}

function validateReadArguments(command: GitReadCommand, args: readonly string[]): void {
  if (args.length > 1_024) invalidArguments();
  for (const argument of args) {
    if (typeof argument !== "string" || argument.includes("\0") || Buffer.byteLength(argument) > 16_384) {
      invalidArguments();
    }
  }
  if (command === "symbolic-ref") validateExact(args, ["-q", "--short", "HEAD"]);
  else if (command === "config") validateReadOnlyConfigArguments(args);
  else if (command === "rev-parse") validateRevParseArguments(args);
  else if (command === "status") validateStatusArguments(args);
  else if (command === "diff") validateDiffArguments(args);
  else validateLogArguments(args);
}

function validateReadOnlyConfigArguments(args: readonly string[]): void {
  const signature = args.join("\0");
  if (
    signature === [
      "--includes",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ].join("\0") ||
    signature === ["--local", "--no-includes", "--bool", "--get", "core.sparseCheckout"].join("\0") ||
    signature === [
      "--local",
      "--no-includes",
      "--null",
      "--name-only",
      "--get-regexp",
      "^remote\\..*\\.url$",
    ].join("\0")
  ) return;
  if (
    args.length === 6 &&
    args[0] === "--local" &&
    args[1] === "--no-includes" &&
    args[2] === "--null" &&
    args[3] === "--get-all" &&
    typeof args[4] === "string"
  ) invalidArguments();
  if (
    args.length === 5 &&
    args[0] === "--local" &&
    args[1] === "--no-includes" &&
    args[2] === "--null" &&
    args[3] === "--get-all" &&
    /^remote\.[A-Za-z0-9_-][A-Za-z0-9._-]{0,255}\.url$/u.test(args[4] ?? "")
  ) return;
  invalidArguments();
}

function validateRevParseArguments(args: readonly string[]): void {
  const allowed = new Set([
    ["--is-bare-repository"].join("\0"),
    ["--is-shallow-repository"].join("\0"),
    ["--path-format=absolute", "--git-common-dir"].join("\0"),
    ["--path-format=absolute", "--git-dir"].join("\0"),
    ["--path-format=absolute", "--git-path", "index"].join("\0"),
    ["--path-format=absolute", "--show-toplevel"].join("\0"),
    ["--show-object-format"].join("\0"),
    ["--show-superproject-working-tree"].join("\0"),
  ]);
  if (!allowed.has(args.join("\0"))) invalidArguments();
}

function validateStatusArguments(args: readonly string[]): void {
  const base = [
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
    "--no-renames",
  ];
  const signature = args.join("\0");
  if (
    signature !== base.join("\0") &&
    signature !== [...base, "--ignored=matching"].join("\0")
  ) invalidArguments();
}

function validateDiffArguments(args: readonly string[]): void {
  let offset = args[0] === "--cached" ? 1 : 0;
  if (args[offset] === "--name-only") {
    if (args[offset + 1] !== "-z" || args[offset + 2] !== "--" || args.length !== offset + 3) {
      invalidArguments();
    }
    return;
  }
  if (args[offset] !== "--") invalidArguments();
  offset += 1;
  for (; offset < args.length; offset += 1) validateWorkspacePath(args[offset] ?? "");
}

function validateLogArguments(args: readonly string[]): void {
  if (
    args.length !== 3 ||
    args[0] !== "-z" ||
    !/^--max-count=(?:[1-9][0-9]{0,2}|1000)$/u.test(args[1] ?? "") ||
    args[2] !== "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s"
  ) invalidArguments();
}

function validateWorkspacePath(value: string): void {
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) invalidArguments();
}

function validateExact(actual: readonly string[], expected: readonly string[]): void {
  if (actual.join("\0") !== expected.join("\0")) invalidArguments();
}

function invalidArguments(): never {
  throw new GitToolError("invalid_request", "The requested Git invocation is not a controlled read.");
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GitToolError("invalid_request", `${label} is outside its allowed bound.`);
  }
  return value;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function signalOwnedGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): boolean {
  if (child.pid === undefined) return false;
  try {
    if (process.platform === "win32") return child.kill(signal);
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function processGroupExists(pid: number): Promise<boolean> {
  try {
    if (process.platform === "win32") process.kill(pid, 0);
    else process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return !hasCode(error, "ESRCH");
  }
}

async function waitForGroupAbsence(pid: number, maximumWaitMs: number): Promise<boolean> {
  const deadline = performance.now() + maximumWaitMs;
  do {
    if (!(await processGroupExists(pid))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  return !(await processGroupExists(pid));
}
