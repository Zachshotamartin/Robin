import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GitToolError } from "@guard/tool-git";

import {
  bootstrapR2RobinApplication,
  createR2RobinApplication,
} from "./r2-application.js";

const execFileAsync = promisify(execFile);

test("bootstraps one R2 application from a nested physical Git worktree", async (t) => {
  const gitExecutable = await installedGitExecutable();
  const fixture = await createRepositoryFixture(gitExecutable);
  t.after(async () => rm(fixture.temporaryRoot, { recursive: true, force: true }));

  const result = await createR2RobinApplication({
    sessionId: "r2-nested-bootstrap",
    startDirectory: fixture.nestedDirectory,
    gitExecutable,
    ambientEnvironment: Object.freeze({
      LANG: "C.UTF-8",
      ROBIN_CREDENTIAL_TEST_TOKEN: "must-not-be-inherited",
    }),
    application: {
      now: () => "2026-08-30T00:00:00.000Z",
      monotonicNow: () => 1,
    },
  });

  assert.equal(result.workspace.identity.physicalRoot, fixture.repositoryRoot);
  assert.equal(result.workspace.displayRoot, fixture.nestedDirectory);
  assert.equal(result.workspace.identity.createdFrom, "launch_directory");
  assert.equal(result.workspace.identity.accessMode, "read_write");
  assert.equal(result.git.runner.cwd, fixture.repositoryRoot);
  assert.equal(result.git.identity.workspaceRoot, fixture.repositoryRoot);
  assert.equal(result.workspace.identity.git?.repositoryId.startsWith("repository:"), true);
  assert.equal(result.runtime.advertisement.operations.length, 8);
  assert.deepEqual(
    result.runtime.advertisement.operations.map(
      (operation) => `${operation.packId}.${operation.operationId}`,
    ),
    [
      "robin.repo.list_files",
      "robin.repo.search_text",
      "robin.repo.read_file",
      "robin.edit.apply_patch",
      "robin.edit.create_file",
      "robin.process.run",
      "robin.git.status",
      "robin.git.diff",
    ],
  );
  assert.equal(result.process.executablePolicy.allowWorkspaceExecutables, false);
  assert.equal(
    result.process.executablePolicy.workspaceRoot,
    fixture.repositoryRoot,
  );
  assert.equal(result.process.environmentProfile.fixed.CI, "1");
  assert.equal(
    result.process.environmentProfile.inheritedKeys.includes(
      "ROBIN_CREDENTIAL_TEST_TOKEN",
    ),
    false,
  );

  assert.equal(result.metadata.schemaVersion, 1);
  assert.equal(result.metadata.milestone, "R2");
  assert.equal(result.metadata.workspace.kind, "physical_git_worktree");
  assert.equal(result.metadata.workspace.physicalRoot, fixture.repositoryRoot);
  assert.equal(result.metadata.git.readOperationsOnly, true);
  assert.equal(result.metadata.git.executableSelection, "explicit_host_path");
  assert.equal(result.metadata.git.branchState, "attached");
  assert.equal(result.metadata.git.initialDirty, false);
  assert.equal(result.metadata.git.initialStatusEntries, 0);
  assert.equal(result.metadata.provider.kind, "credential_free_synthetic_fixture");
  assert.equal(result.metadata.provider.hostedApiConfigured, false);
  assert.equal(result.metadata.session.persistence, "ephemeral");
  assert.equal(result.metadata.execution.sandboxed, false);
  assert.equal(result.metadata.execution.filesystemIsolation, "none");
  assert.equal(result.metadata.execution.networkIsolation, "none");
  assert.equal(result.metadata.execution.workspaceExecutablesAllowed, false);
  assert.match(result.metadata.notices.join("\n"), /without filesystem or network isolation/u);

  assert.equal(result.application.snapshot.providerId, "robin.r2-synthetic-coding");
  assert.equal(result.application.snapshot.modelId, "synthetic-r2-v1");
  assert.equal(result.application.snapshot.permissionMode, "ask");
  assert.equal(result.application.snapshot.persistence, "ephemeral");
  assert.equal(
    result.application.snapshot.events[0]?.occurredAt,
    "2026-08-30T00:00:00.000Z",
  );
  await result.application.close("shutdown");
});

test("resolves an explicit Git symlink once and retains the physical executable", async (t) => {
  const installedGit = await installedGitExecutable();
  const fixture = await createRepositoryFixture(installedGit);
  t.after(async () => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const gitLink = path.join(fixture.temporaryRoot, "reviewed-git");
  await symlink(installedGit, gitLink);

  const result = await bootstrapR2RobinApplication({
    sessionId: "r2-explicit-git-symlink",
    startDirectory: fixture.repositoryRoot,
    workspaceOrigin: "explicit_flag",
    permissionMode: "plan",
    gitExecutable: gitLink,
  });

  assert.equal(result.metadata.git.executable, await realpath(installedGit));
  assert.equal(result.git.runner.gitExecutable, await realpath(installedGit));
  assert.equal(result.workspace.identity.createdFrom, "explicit_flag");
  assert.equal(result.application.snapshot.permissionMode, "plan");
  await result.application.close("shutdown");
});

test("fails closed when the start directory is not a Git repository", async (t) => {
  const gitExecutable = await installedGitExecutable();
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "robin-r2-nonrepo-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  await writeFile(path.join(temporaryRoot, "ordinary.txt"), "not a repository\n");

  await assert.rejects(
    createR2RobinApplication({
      sessionId: "r2-nonrepository",
      startDirectory: temporaryRoot,
      workspaceOrigin: "explicit_flag",
      gitExecutable,
    }),
    (error: unknown) =>
      error instanceof GitToolError && error.code === "not_repository",
  );
});

test("rejects a relative Git executable before repository discovery", async () => {
  await assert.rejects(
    createR2RobinApplication({
      sessionId: "r2-relative-git",
      startDirectory: process.cwd(),
      gitExecutable: "git",
    }),
    (error: unknown) =>
      error instanceof GitToolError && error.code === "invalid_request",
  );
});

test("rejects unsupported synthetic model identities before filesystem work", async () => {
  await assert.rejects(
    createR2RobinApplication({
      sessionId: "r2-unsupported-model",
      startDirectory: "/path/that/need/not/exist",
      modelId: "hosted-model-not-available-in-r2",
    }),
    (error: unknown) =>
      error instanceof GitToolError && error.code === "invalid_request",
  );
});

test("bounds session and workspace identifiers at the bootstrap boundary", async () => {
  await assert.rejects(
    createR2RobinApplication({
      sessionId: "x".repeat(257),
      startDirectory: process.cwd(),
    }),
    (error: unknown) =>
      error instanceof GitToolError && error.code === "invalid_request",
  );
  await assert.rejects(
    createR2RobinApplication({
      sessionId: "r2-oversized-workspace",
      startDirectory: `/${"x".repeat(4_096)}`,
    }),
    (error: unknown) =>
      error instanceof GitToolError && error.code === "invalid_request",
  );
});

test("honors an already-aborted bootstrap signal before filesystem work", async () => {
  const controller = new AbortController();
  controller.abort("test cancellation");
  await assert.rejects(
    createR2RobinApplication({
      sessionId: "r2-cancelled-bootstrap",
      startDirectory: "/path/that/need/not/exist",
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof GitToolError && error.code === "cancelled",
  );
});

test("runs the complete policy-synchronized two-edit coding loop with live output", async (t) => {
  const gitExecutable = await installedGitExecutable();
  const fixture = await createCodingRepositoryFixture(gitExecutable);
  t.after(async () => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const initialIndexHash = sha256(await readFile(path.join(fixture.repositoryRoot, ".git", "index")));
  const initialHead = await gitText(gitExecutable, fixture.repositoryRoot, ["rev-parse", "HEAD"]);
  const originalNotes = await readFile(
    path.join(fixture.repositoryRoot, "notes", "user-notes.txt"),
    "utf8",
  );
  const originalScratch = await readFile(
    path.join(fixture.repositoryRoot, "scratch-user.txt"),
    "utf8",
  );

  const result = await createR2RobinApplication({
    sessionId: "r2-complete-coding-loop",
    startDirectory: fixture.repositoryRoot,
    gitExecutable,
    permissionMode: "plan",
  });
  t.after(async () => result.application.close("shutdown"));

  const planEvents = [];
  for await (const event of result.application.submit(
    "Fix and verify the deterministic defects.",
    new AbortController().signal,
  )) {
    planEvents.push(event);
  }
  assert.equal(
    planEvents.some(
      (event) =>
        event.type === "PermissionDecided" &&
        event.payload.toolName === "robin.edit.apply_patch@1" &&
        event.payload.effect === "deny",
    ),
    true,
    JSON.stringify(
      planEvents.map((event) => ({
        type: event.type,
        payload: event.type === "ToolCallCompleted" ||
          event.type === "ToolCallFailed" ||
          event.type === "TurnCompleted" ||
          event.type === "TurnFailed"
          ? event.payload
          : undefined,
      })),
    ),
  );
  assert.equal(
    (await readFile(path.join(fixture.repositoryRoot, "src", "calculate.ts"), "utf8"))
      .includes("total - value"),
    true,
  );

  result.application.setPermissionMode("ask");
  const events = [];
  for await (const event of result.application.submit(
    "Fix and verify the deterministic defects.",
    new AbortController().signal,
  )) {
    events.push(event);
    if (event.type === "ApprovalRequested") {
      assert.equal(
        result.application.resolveApproval(event.payload.approvalId, "allow_once"),
        true,
      );
    }
  }

  assert.equal(events.at(-1)?.type, "TurnCompleted");
  assert.equal(
    events.filter((event) => event.type === "ApprovalRequested").length,
    4,
  );
  assert.equal(
    events.filter((event) => event.type === "ApprovalResolved").every(
      (event) => event.payload.outcome === "granted",
    ),
    true,
  );
  const outputs = events.filter((event) => event.type === "ToolOutputDelta");
  assert.equal(outputs.length > 0, true);
  assert.deepEqual(
    outputs.map((event) => event.payload.sequence),
    outputs.map((event, index, all) =>
      index === 0 || event.payload.callId !== all[index - 1]?.payload.callId
        ? 1
        : (all[index - 1]?.payload.sequence ?? 0) + 1,
    ),
  );
  assert.equal(outputs.every((event) => !event.payload.safeText.includes("\u001b")), true);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "ToolCallCompleted" &&
        event.payload.toolName === "robin.process.run@1",
    ).length,
    2,
  );

  const fixed = await readFile(
    path.join(fixture.repositoryRoot, "src", "calculate.ts"),
    "utf8",
  );
  assert.match(fixed, /total \+ value/u);
  assert.match(fixed, /return label\.toUpperCase\(\);/u);
  assert.equal(
    await readFile(path.join(fixture.repositoryRoot, "notes", "user-notes.txt"), "utf8"),
    originalNotes,
  );
  assert.equal(
    await readFile(path.join(fixture.repositoryRoot, "scratch-user.txt"), "utf8"),
    originalScratch,
  );
  assert.equal(
    sha256(await readFile(path.join(fixture.repositoryRoot, ".git", "index"))),
    initialIndexHash,
  );
  assert.equal(
    await gitText(gitExecutable, fixture.repositoryRoot, ["rev-parse", "HEAD"]),
    initialHead,
  );
  const status = await gitText(gitExecutable, fixture.repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  assert.match(status, / M notes\/user-notes\.txt/u);
  assert.match(status, / M src\/calculate\.ts/u);
  assert.match(status, /\?\? scratch-user\.txt/u);
});

async function createRepositoryFixture(gitExecutable: string): Promise<{
  readonly temporaryRoot: string;
  readonly repositoryRoot: string;
  readonly nestedDirectory: string;
}> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "robin-r2-bootstrap-"));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const nestedDirectory = path.join(repositoryRoot, "src", "nested");
  await mkdir(nestedDirectory, { recursive: true });
  await writeFile(
    path.join(repositoryRoot, "package.json"),
    `${JSON.stringify({ name: "r2-bootstrap-fixture", private: true }, null, 2)}\n`,
  );
  await writeFile(
    path.join(repositoryRoot, "src", "calculate.ts"),
    "export const calculate = (left: number, right: number): number => left - right;\n",
  );
  await runGit(gitExecutable, ["init", "--quiet", repositoryRoot]);
  await runGit(gitExecutable, ["-C", repositoryRoot, "add", "--", "package.json", "src/calculate.ts"]);
  await runGit(gitExecutable, [
    "-C",
    repositoryRoot,
    "-c",
    "user.name=Robin R2 Test",
    "-c",
    "user.email=robin-r2@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return Object.freeze({
    temporaryRoot,
    repositoryRoot: await realpath(repositoryRoot),
    nestedDirectory: await realpath(nestedDirectory),
  });
}

async function createCodingRepositoryFixture(gitExecutable: string): Promise<{
  readonly temporaryRoot: string;
  readonly repositoryRoot: string;
  readonly nestedDirectory: string;
}> {
  const fixture = await createRepositoryFixture(gitExecutable);
  await mkdir(path.join(fixture.repositoryRoot, "test"), { recursive: true });
  await mkdir(path.join(fixture.repositoryRoot, "notes"), { recursive: true });
  await writeFile(
    path.join(fixture.repositoryRoot, "package.json"),
    `${JSON.stringify({
      name: "robin-r2-coding-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(fixture.repositoryRoot, "src", "calculate.ts"),
    [
      "export function calculate(values: readonly number[]): number {",
      "  let total = 0;",
      "  for (const value of values) total = total - value;",
      "  return total;",
      "}",
      "",
      "export function normalizeLabel(label: string): string {",
      "  return label.toLowerCase();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(fixture.repositoryRoot, "test", "calculate.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import test from "node:test";',
      "",
      'test("both deterministic fixes are present", async () => {',
      '  const source = await readFile(new URL("../src/calculate.ts", import.meta.url), "utf8");',
      '  assert.match(source, /total = total \\+ value/u);',
      '  assert.match(source, /return label\\.toUpperCase\\(\\);/u);',
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(fixture.repositoryRoot, "notes", "user-notes.txt"),
    "keep this user-authored baseline\n",
  );
  await runGit(gitExecutable, [
    "-C",
    fixture.repositoryRoot,
    "add",
    "--",
    "package.json",
    "src/calculate.ts",
    "test/calculate.test.js",
    "notes/user-notes.txt",
  ]);
  await runGit(gitExecutable, [
    "-C",
    fixture.repositoryRoot,
    "-c",
    "user.name=Robin R2 Test",
    "-c",
    "user.email=robin-r2@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "add coding scenario",
  ]);
  await writeFile(
    path.join(fixture.repositoryRoot, "notes", "user-notes.txt"),
    "keep this user-authored baseline\npre-existing uncommitted note\n",
  );
  await writeFile(
    path.join(fixture.repositoryRoot, "scratch-user.txt"),
    "pre-existing untracked user content\n",
  );
  return fixture;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function gitText(
  gitExecutable: string,
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync(
    gitExecutable,
    ["-C", repositoryRoot, ...args],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
        LC_ALL: "C",
        PATH: [path.dirname(gitExecutable), "/usr/bin", "/bin"].join(path.delimiter),
      },
    },
  );
  return result.stdout.trimEnd();
}

async function installedGitExecutable(): Promise<string> {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files\\Git\\bin\\git.exe",
      ]
    : [
        "/usr/bin/git",
        "/usr/local/bin/git",
        "/opt/homebrew/bin/git",
        "/bin/git",
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the same reviewed installed paths as production.
    }
  }
  throw new Error("The R2 bootstrap test requires Git at a reviewed installed path.");
}

async function runGit(
  gitExecutable: string,
  args: readonly string[],
): Promise<void> {
  await execFileAsync(gitExecutable, [...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: {
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
      PATH: [path.dirname(gitExecutable), "/usr/bin", "/bin"].join(path.delimiter),
    },
  });
}
