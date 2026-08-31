import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const FIXTURE_PREFIX = "robin-r2-fixture-";
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const VALID_VARIANTS = new Set([
  "bare",
  "clean",
  "coding",
  "detached",
  "dirty",
  "linked-worktree",
  "malicious-name",
  "merge-conflict",
  "nested",
  "newline",
  "submodule",
  "symlink",
  "unicode",
  "unborn",
  "untracked",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function gitEnvironment(extra = {}) {
  return {
    ...process.env,
    GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
    GIT_AUTHOR_EMAIL: "robin-fixture@example.invalid",
    GIT_AUTHOR_NAME: "Robin Fixture",
    GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
    GIT_COMMITTER_EMAIL: "robin-fixture@example.invalid",
    GIT_COMMITTER_NAME: "Robin Fixture",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

async function runProcess(executable, args, options = {}) {
  const {
    allowFailure = false,
    cwd,
    env = process.env,
    maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
  } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;

    const collect = (chunks, count, chunk) => {
      const nextCount = count + chunk.length;
      if (nextCount > maxOutputBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return nextCount;
      }
      chunks.push(chunk);
      return nextCount;
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(stdout, stdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(stderr, stderrBytes, chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = {
        code,
        signal,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      };
      if (overflow) {
        reject(new Error(`${executable} exceeded the fixture output limit`));
        return;
      }
      if (code !== 0 && !allowFailure) {
        const diagnostic = result.stderr.toString("utf8").trim();
        reject(
          new Error(
            `${executable} ${args.join(" ")} exited ${String(code)}${
              diagnostic.length === 0 ? "" : `: ${diagnostic}`
            }`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

async function runGit(cwd, args, options = {}) {
  return await runProcess("git", args, {
    ...options,
    cwd,
    env: gitEnvironment(options.env),
  });
}

async function gitText(cwd, args, options = {}) {
  const result = await runGit(cwd, args, options);
  return result.stdout.toString("utf8").trimEnd();
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

async function snapshotTree(root, options = {}) {
  const { excludeGitEntries = false } = options;
  const entries = [];

  async function visit(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    );
    for (const child of children) {
      if (excludeGitEntries && child.name === ".git") {
        continue;
      }
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.join(relativeDirectory, child.name);
      const displayPath = normalizeRelativePath(relativePath);
      const stats = await lstat(absolutePath);
      const common = {
        dev: String(stats.dev),
        ino: String(stats.ino),
        mode: stats.mode & 0o7777,
        nlink: stats.nlink,
        path: displayPath,
      };

      if (stats.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        entries.push({
          ...common,
          kind: "symlink",
          target,
          targetHash: sha256(Buffer.from(target)),
        });
        continue;
      }
      if (stats.isDirectory()) {
        entries.push({ ...common, kind: "directory" });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (stats.isFile()) {
        const content = await readFile(absolutePath);
        entries.push({
          ...common,
          kind: "file",
          sha256: sha256(content),
          size: stats.size,
        });
        continue;
      }
      entries.push({
        ...common,
        kind: stats.isBlockDevice()
          ? "block-device"
          : stats.isCharacterDevice()
            ? "character-device"
            : stats.isFIFO()
              ? "fifo"
              : stats.isSocket()
                ? "socket"
                : "other",
      });
    }
  }

  await visit(root, "");
  const hash = sha256(Buffer.from(stableJson(entries)));
  return { entries, hash };
}

async function resolveGitFacts(workspaceRoot) {
  const probe = await runGit(
    workspaceRoot,
    ["rev-parse", "--is-bare-repository"],
    { allowFailure: true },
  );
  if (probe.code !== 0) {
    return {
      bare: false,
      branch: null,
      commonDir: null,
      detached: false,
      gitDir: null,
      head: null,
      isRepository: false,
      linkedWorktree: false,
      porcelainV2ZBase64: "",
      porcelainV2ZHash: sha256(Buffer.alloc(0)),
      unborn: false,
    };
  }

  const bare = probe.stdout.toString("utf8").trim() === "true";
  const gitDirText = await gitText(workspaceRoot, [
    "rev-parse",
    "--absolute-git-dir",
  ]);
  const commonDirText = await gitText(workspaceRoot, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const gitDir = path.resolve(workspaceRoot, gitDirText);
  const commonDir = path.resolve(workspaceRoot, commonDirText);
  const headResult = await runGit(
    workspaceRoot,
    ["rev-parse", "--verify", "HEAD"],
    { allowFailure: true },
  );
  const head =
    headResult.code === 0 ? headResult.stdout.toString("utf8").trim() : null;
  const branchResult = await runGit(
    workspaceRoot,
    ["symbolic-ref", "--short", "-q", "HEAD"],
    { allowFailure: true },
  );
  const branch =
    branchResult.code === 0
      ? branchResult.stdout.toString("utf8").trim()
      : null;
  const unborn = head === null && branch !== null;
  const detached = head !== null && branch === null;
  let porcelain = Buffer.alloc(0);
  if (!bare) {
    const status = await runGit(workspaceRoot, [
      "-c",
      "core.quotepath=false",
      "-c",
      "status.renames=false",
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]);
    porcelain = status.stdout;
  }

  return {
    bare,
    branch,
    commonDir,
    detached,
    gitDir,
    head,
    isRepository: true,
    linkedWorktree: commonDir !== gitDir,
    porcelainV2ZBase64: porcelain.toString("base64"),
    porcelainV2ZHash: sha256(porcelain),
    unborn,
  };
}

export async function snapshotRepository(root, options = {}) {
  const { includeGit = true } = options;
  const physicalRoot = await realpath(root);
  const workspace = await snapshotTree(physicalRoot, {
    excludeGitEntries: includeGit,
  });
  const git = includeGit
    ? await resolveGitFacts(physicalRoot)
    : {
        bare: false,
        branch: null,
        commonDir: null,
        detached: false,
        gitDir: null,
        head: null,
        isRepository: false,
        linkedWorktree: false,
        porcelainV2ZBase64: "",
        porcelainV2ZHash: sha256(Buffer.alloc(0)),
        unborn: false,
      };
  let gitStorage = null;
  if (git.isRepository && git.commonDir !== null) {
    gitStorage = await snapshotTree(git.commonDir);
  }
  return {
    git,
    gitStorage,
    physicalRoot,
    workspace,
  };
}

function entriesByPath(snapshot) {
  return new Map(snapshot.workspace.entries.map((entry) => [entry.path, entry]));
}

function treeEntriesByPath(tree) {
  return new Map((tree?.entries ?? []).map((entry) => [entry.path, entry]));
}

function comparableEntry(entry) {
  const { path: _path, ...rest } = entry;
  return rest;
}

export function diffRepositorySnapshots(before, after) {
  const beforeEntries = entriesByPath(before);
  const afterEntries = entriesByPath(after);
  const added = [];
  const changed = [];
  const removed = [];

  for (const [entryPath, afterEntry] of afterEntries) {
    const beforeEntry = beforeEntries.get(entryPath);
    if (beforeEntry === undefined) {
      added.push(entryPath);
    } else if (
      !isDeepStrictEqual(comparableEntry(beforeEntry), comparableEntry(afterEntry))
    ) {
      changed.push(entryPath);
    }
  }
  for (const entryPath of beforeEntries.keys()) {
    if (!afterEntries.has(entryPath)) {
      removed.push(entryPath);
    }
  }

  const gitChanged = !isDeepStrictEqual(
    {
      bare: before.git.bare,
      branch: before.git.branch,
      commonDir: before.git.commonDir,
      detached: before.git.detached,
      gitDir: before.git.gitDir,
      head: before.git.head,
      isRepository: before.git.isRepository,
      porcelainV2ZHash: before.git.porcelainV2ZHash,
      unborn: before.git.unborn,
    },
    {
      bare: after.git.bare,
      branch: after.git.branch,
      commonDir: after.git.commonDir,
      detached: after.git.detached,
      gitDir: after.git.gitDir,
      head: after.git.head,
      isRepository: after.git.isRepository,
      porcelainV2ZHash: after.git.porcelainV2ZHash,
      unborn: after.git.unborn,
    },
  );

  return {
    workspace: {
      added: added.sort(),
      changed: changed.sort(),
      removed: removed.sort(),
    },
    git: { changed: gitChanged },
  };
}

export function diffGitStorageSnapshots(before, after) {
  const beforeEntries = treeEntriesByPath(before.gitStorage);
  const afterEntries = treeEntriesByPath(after.gitStorage);
  const added = [];
  const changed = [];
  const removed = [];

  for (const [entryPath, afterEntry] of afterEntries) {
    const beforeEntry = beforeEntries.get(entryPath);
    if (beforeEntry === undefined) {
      added.push(entryPath);
    } else if (
      !isDeepStrictEqual(comparableEntry(beforeEntry), comparableEntry(afterEntry))
    ) {
      changed.push(entryPath);
    }
  }
  for (const entryPath of beforeEntries.keys()) {
    if (!afterEntries.has(entryPath)) {
      removed.push(entryPath);
    }
  }
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
  };
}

export function assertGitStorageUnchanged(before, after) {
  const delta = diffGitStorageSnapshots(before, after);
  if (
    delta.added.length !== 0 ||
    delta.changed.length !== 0 ||
    delta.removed.length !== 0
  ) {
    throw new Error(`Git storage changed: ${stableJson(delta)}`);
  }
}

export function assertRepositoryDelta(before, after, expected) {
  const actual = diffRepositorySnapshots(before, after);
  const normalizedExpected = {
    workspace: {
      added: [...expected.added].sort(),
      changed: [...expected.changed].sort(),
      removed: [...expected.removed].sort(),
    },
    git: { changed: expected.gitChanged },
  };
  if (!isDeepStrictEqual(actual, normalizedExpected)) {
    throw new Error(
      `unexpected repository delta: expected ${stableJson(
        normalizedExpected,
      )}, received ${stableJson(actual)}`,
    );
  }
}

async function initializeRepository(workspaceRoot) {
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await runGit(workspaceRoot, ["init", "--initial-branch=main"]);
  await writeFile(
    path.join(workspaceRoot, "README.md"),
    "# Robin repository fixture\n",
  );
  await writeFile(path.join(workspaceRoot, "src", "answer.txt"), "41\n");
  await writeFile(
    path.join(workspaceRoot, "conflict.txt"),
    "shared baseline\n",
  );
  await writeFile(
    path.join(workspaceRoot, ".gitignore"),
    "ignored/\n*.generated\n",
  );
  await writeFile(
    path.join(workspaceRoot, ".gitattributes"),
    "*.txt text\n*.bin binary\n",
  );
  await writeFile(
    path.join(workspaceRoot, "verify-fixture.sh"),
    "#!/bin/sh\nexit 0\n",
  );
  await chmod(path.join(workspaceRoot, "verify-fixture.sh"), 0o755);
  await runGit(workspaceRoot, ["add", "--all"]);
  await runGit(workspaceRoot, ["commit", "-m", "fixture baseline"]);
}

async function addCodingScenario(workspaceRoot) {
  await Promise.all([
    mkdir(path.join(workspaceRoot, "notes"), { recursive: true }),
    mkdir(path.join(workspaceRoot, "test"), { recursive: true }),
  ]);
  await writeFile(
    path.join(workspaceRoot, "src", "calculate.ts"),
    [
      "export function calculateTotal(values: readonly number[]): number {",
      "  return values.reduce((total, value) => total - value, 0);",
      "}",
      "",
      "export function formatLabel(label: string): string {",
      "  return label.toLowerCase();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(workspaceRoot, "test", "calculate.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import test from "node:test";',
      "",
      'test("calculation and label regressions are fixed", async () => {',
      '  const source = await readFile(new URL("../src/calculate.ts", import.meta.url), "utf8");',
      '  assert.match(source, /total \\+ value/u, "the reducer must add each value");',
      '  assert.match(source, /return label\\.toUpperCase\\(\\);/u, "labels must be uppercase");',
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "robin-r2-coding-fixture",
        private: true,
        scripts: { test: "node --test test/calculate.test.mjs" },
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(workspaceRoot, "notes", "user-notes.txt"),
    "keep this user-authored baseline\n",
  );
  await runGit(workspaceRoot, ["add", "--all"]);
  await runGit(workspaceRoot, ["commit", "-m", "add deterministic coding scenario"]);
  await writeFile(
    path.join(workspaceRoot, "notes", "user-notes.txt"),
    "keep this user-authored baseline\npre-existing uncommitted note\n",
  );
  await writeFile(
    path.join(workspaceRoot, "scratch-user.txt"),
    "pre-existing untracked user content\n",
  );
}

async function applyVariant(fixture) {
  const { tempRoot, variant } = fixture;
  let { workspaceRoot } = fixture;
  const metadata = {
    hasConflict: false,
    hasSubmodule: false,
  };

  if (variant === "bare") {
    workspaceRoot = path.join(tempRoot, "bare.git");
    await mkdir(workspaceRoot, { recursive: true });
    await runGit(workspaceRoot, ["init", "--bare", "--initial-branch=main"]);
    return { metadata, workingDirectory: workspaceRoot, workspaceRoot };
  }

  if (variant === "linked-worktree") {
    const primaryRoot = path.join(tempRoot, "primary");
    await mkdir(primaryRoot, { recursive: true });
    await initializeRepository(primaryRoot);
    workspaceRoot = path.join(tempRoot, "linked");
    await runGit(primaryRoot, [
      "worktree",
      "add",
      "-b",
      "linked-fixture",
      workspaceRoot,
    ]);
    return { metadata, workingDirectory: workspaceRoot, workspaceRoot };
  }

  if (variant === "submodule") {
    const submoduleSource = path.join(tempRoot, "submodule-source");
    await mkdir(submoduleSource, { recursive: true });
    await initializeRepository(submoduleSource);
    await initializeRepository(workspaceRoot);
    await runGit(workspaceRoot, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleSource,
      "vendor/submodule",
    ]);
    await runGit(workspaceRoot, ["commit", "-m", "add local submodule"]);
    metadata.hasSubmodule = true;
    return { metadata, workingDirectory: workspaceRoot, workspaceRoot };
  }

  await runGit(workspaceRoot, ["init", "--initial-branch=main"]);
  if (variant === "unborn") {
    await writeFile(path.join(workspaceRoot, "unborn.txt"), "not committed\n");
    return { metadata, workingDirectory: workspaceRoot, workspaceRoot };
  }

  await rm(path.join(workspaceRoot, ".git"), { recursive: true, force: true });
  await initializeRepository(workspaceRoot);

  if (variant === "coding") {
    await addCodingScenario(workspaceRoot);
  } else if (variant === "dirty") {
    await writeFile(path.join(workspaceRoot, "src", "answer.txt"), "42\n");
    await runGit(workspaceRoot, ["add", "--", "src/answer.txt"]);
    await writeFile(
      path.join(workspaceRoot, "README.md"),
      "# Robin repository fixture\n\nunstaged change\n",
    );
    await writeFile(path.join(workspaceRoot, "untracked.txt"), "untracked\n");
  } else if (variant === "untracked") {
    await writeFile(path.join(workspaceRoot, "untracked.txt"), "untracked\n");
  } else if (variant === "detached") {
    await runGit(workspaceRoot, ["checkout", "--detach", "HEAD"]);
  } else if (variant === "nested") {
    const nested = path.join(workspaceRoot, "nested", "deep");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "fixture.txt"), "nested\n");
    await runGit(workspaceRoot, ["add", "--all"]);
    await runGit(workspaceRoot, ["commit", "-m", "add nested fixture"]);
    return { metadata, workingDirectory: nested, workspaceRoot };
  } else if (variant === "merge-conflict") {
    await runGit(workspaceRoot, ["switch", "-c", "fixture-conflict"]);
    await writeFile(path.join(workspaceRoot, "conflict.txt"), "branch side\n");
    await runGit(workspaceRoot, ["add", "--", "conflict.txt"]);
    await runGit(workspaceRoot, ["commit", "-m", "branch conflict"]);
    await runGit(workspaceRoot, ["switch", "main"]);
    await writeFile(path.join(workspaceRoot, "conflict.txt"), "main side\n");
    await runGit(workspaceRoot, ["add", "--", "conflict.txt"]);
    await runGit(workspaceRoot, ["commit", "-m", "main conflict"]);
    const merge = await runGit(
      workspaceRoot,
      ["merge", "--no-edit", "fixture-conflict"],
      { allowFailure: true },
    );
    if (merge.code === 0) {
      throw new Error("merge-conflict fixture unexpectedly merged cleanly");
    }
    metadata.hasConflict = true;
  } else if (variant === "malicious-name") {
    await Promise.all([
      writeFile(path.join(workspaceRoot, "-leading-dash.txt"), "dash\n"),
      writeFile(
        path.join(workspaceRoot, "dollar-$(not-executed).txt"),
        "literal shell syntax\n",
      ),
      writeFile(path.join(workspaceRoot, "semi;colon.txt"), "semicolon\n"),
      writeFile(path.join(workspaceRoot, "bracket-[abc].txt"), "glob\n"),
    ]);
  } else if (variant === "unicode") {
    await Promise.all([
      writeFile(path.join(workspaceRoot, "emoji-🦉.txt"), "owl\n"),
      writeFile(path.join(workspaceRoot, "café.txt"), "composed\n"),
      writeFile(path.join(workspaceRoot, "東京.txt"), "unicode\n"),
    ]);
  } else if (variant === "newline") {
    await Promise.all([
      writeFile(path.join(workspaceRoot, "line\nbreak.txt"), "newline path\n"),
      writeFile(path.join(workspaceRoot, "tab\tname.txt"), "tab path\n"),
    ]);
  } else if (variant === "symlink") {
    await writeFile(path.join(fixture.outsideRoot, "outside.txt"), "outside\n");
    await symlink("src/answer.txt", path.join(workspaceRoot, "link-inside.txt"));
    await symlink(
      path.join(fixture.outsideRoot, "outside.txt"),
      path.join(workspaceRoot, "link-outside.txt"),
    );
    await symlink("link-loop-b", path.join(workspaceRoot, "link-loop-a"));
    await symlink("link-loop-a", path.join(workspaceRoot, "link-loop-b"));
  }

  return { metadata, workingDirectory: workspaceRoot, workspaceRoot };
}

export async function createRepositoryFixture(options = {}) {
  const { variant = "clean" } = options;
  if (!VALID_VARIANTS.has(variant)) {
    throw new TypeError(`unsupported repository fixture variant: ${variant}`);
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), FIXTURE_PREFIX));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const outsideRoot = path.join(tempRoot, "outside");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    const parent = path.dirname(tempRoot);
    const basename = path.basename(tempRoot);
    if (parent !== os.tmpdir() || !basename.startsWith(FIXTURE_PREFIX)) {
      throw new Error(`refusing to remove unsafe fixture path: ${tempRoot}`);
    }
    cleaned = true;
    await rm(tempRoot, { recursive: true, force: true });
  };

  try {
    const configured = await applyVariant({
      outsideRoot,
      tempRoot,
      variant,
      workspaceRoot,
    });
    const initialSnapshot = await snapshotRepository(configured.workspaceRoot);
    return {
      cleanup,
      initialSnapshot,
      metadata: configured.metadata,
      outsideRoot,
      runGit: async (args, runOptions = {}) =>
        await runGit(configured.workspaceRoot, args, runOptions),
      snapshot: async () => await snapshotRepository(configured.workspaceRoot),
      tempRoot,
      variant,
      workingDirectory: configured.workingDirectory,
      workspaceRoot: configured.workspaceRoot,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function assertPathAbsent(candidate) {
  if (await pathExists(candidate)) {
    throw new Error(`expected path to remain absent: ${candidate}`);
  }
}
