import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  assertGitStorageUnchanged,
  assertRepositoryDelta,
  createRepositoryFixture,
  snapshotRepository,
} from "../support/repository-fixture.mjs";

const execFile = promisify(execFileCallback);
const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_ROOT, "../..");
const DRIVER = join(TEST_ROOT, "robin_pty_driver.py");
const BINARY = join(REPOSITORY_ROOT, "apps", "cli", "dist", "bin.js");
const PYTHON = process.env.ROBIN_TEST_PYTHON ?? "/usr/bin/python3";

const R2_APPROVAL_TOOLS = Object.freeze([
  "robin.edit.apply_patch@1",
  "robin.process.run@1",
  "robin.edit.apply_patch@1",
  "robin.process.run@1",
]);

const INITIAL_CODING_SOURCE = [
  "export function calculateTotal(values: readonly number[]): number {",
  "  return values.reduce((total, value) => total - value, 0);",
  "}",
  "",
  "export function formatLabel(label: string): string {",
  "  return label.toLowerCase();",
  "}",
  "",
].join("\n");

const REPAIRED_CODING_SOURCE = INITIAL_CODING_SOURCE
  .replace("total - value", "total + value")
  .replace("return label.toLowerCase();", "return label.toUpperCase();");

async function runPtyScenario(
  scenario,
  { cwd = REPOSITORY_ROOT, timeout = 20_000 } = {},
) {
  const { stdout, stderr } = await execFile(
    PYTHON,
    [
      DRIVER,
      "--scenario",
      scenario,
      "--cwd",
      cwd,
      "--node",
      process.execPath,
      "--binary",
      BINARY,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  const transcript = Buffer.from(result.transcriptBase64, "base64").toString("utf8");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.scenario, scenario);
  assert.equal(
    result.modelId,
    scenario.startsWith("r2_") ? "synthetic-r2-v1" : "synthetic-r1-v1",
  );
  assert.equal(result.termiosRestored, true, result.normalizedTranscript);
  assert.match(transcript, /\u001b\[\?2004h/u);
  assert.match(transcript, /\u001b\[\?2004l/u);
  assert.match(transcript, /\u001b\[\?25h/u);
  // A PTY with ONLCR may translate the explicit CRLF cleanup to CRCRLF.
  assert.match(transcript, /\u001b\[0m\r+\n/u);
  return result;
}

test("PTY no-argument and positional-prompt sessions complete two coding turns", async () => {
  for (const scenario of ["happy", "initial"]) {
    const result = await runPtyScenario(scenario);
    assert.equal(result.exitCode, 0);
    assert.match(result.normalizedTranscript, /workspace_summary@1/u);
    assert.match(result.normalizedTranscript, /inspect_file@1/u);
    assert.match(result.normalizedTranscript, /Usage input=/u);
    assert.match(result.normalizedTranscript, /negative total/u);
  }
});

test("PTY queued input survives cancellation and is promoted in FIFO order", async () => {
  const result = await runPtyScenario("queue");
  assert.equal(result.exitCode, 0);
  assert.match(result.normalizedTranscript, /Queued 1\/1/u);
  assert.match(result.normalizedTranscript, /Cancelling/u);
  assert.match(result.normalizedTranscript, /No physical repository was read or changed/u);
});

test("PTY one interrupt cancels while a second interrupt forces bounded exit", async () => {
  const cancelled = await runPtyScenario("cancel");
  assert.equal(cancelled.exitCode, 0);
  assert.match(cancelled.normalizedTranscript, /Cancelling/u);
  assert.match(cancelled.normalizedTranscript, /cancelled/u);

  const forced = await runPtyScenario("double_interrupt");
  assert.equal(forced.exitCode, 8);
  assert.match(forced.normalizedTranscript, /Cancelling/u);
});

test("PTY resize and bracketed paste remain explicit terminal input events", async () => {
  const resized = await runPtyScenario("resize");
  assert.equal(resized.exitCode, 0);
  assert.match(resized.normalizedTranscript, /40x12/u);

  const pasted = await runPtyScenario("paste");
  assert.equal(pasted.exitCode, 0);
  assert.match(pasted.normalizedTranscript, /\/exit/u);
  assert.match(pasted.normalizedTranscript, /No physical repository was read or changed/u);
});

test("PTY provider and tool failures restore the terminal", async () => {
  const providerFailure = await runPtyScenario("provider_error");
  assert.equal(providerFailure.exitCode, 0);
  assert.match(providerFailure.normalizedTranscript, /provider_failed|provider_result_uncertain/u);

  const toolFailure = await runPtyScenario("tool_error");
  assert.equal(toolFailure.exitCode, 0);
  assert.match(toolFailure.normalizedTranscript, /Tool .*\[failed\]/u);
});

test("non-TTY TERM=dumb uses append-only no-color output", async () => {
  const child = spawn(
    process.execPath,
    [BINARY, "--model", "synthetic-r1-v1"],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        TERM: "dumb",
        NO_COLOR: "1",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  // Flat EOF drains work already submitted; an explicit /exit intentionally
  // cancels an active turn through the bounded-close path.
  child.stdin.end("Why does the fixture total fail?\n");
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 0);
  assert.equal(stdout.includes("\u001b"), false);
  assert.match(stdout, /^\[session\]/u);
  assert.match(stdout, /\[tool:started\] robin\.synthetic\.workspace_summary@1/u);
  assert.match(stdout, /\[usage\] input=/u);
  assert.match(stderr, /ephemeral conversation was not saved/u);
});

test("R2 PTY approves exactly two edits and two test runs through fail, re-read, pass, status, and diff", async (context) => {
  const fixture = await createRepositoryFixture({ variant: "coding" });
  context.after(() => fixture.cleanup());
  const outsideBefore = await snapshotRepository(fixture.outsideRoot, {
    includeGit: false,
  });
  const initialHead = fixture.initialSnapshot.git.head;
  const initialIndex = gitStorageEntry(fixture.initialSnapshot, "index");

  const result = await runPtyScenario("r2_approve", {
    cwd: fixture.workingDirectory,
    timeout: 60_000,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.approvalTools, R2_APPROVAL_TOOLS);
  assert.deepEqual(result.approvalDecisions, [
    "allow-once",
    "allow-once",
    "allow-once",
    "allow-once",
  ]);
  assert.match(result.normalizedTranscript, /robin\.repo\.list_files@1/u);
  assert.match(result.normalizedTranscript, /robin\.repo\.search_text@1/u);
  assert.match(result.normalizedTranscript, /robin\.repo\.read_file@1/u);
  assert.match(result.normalizedTranscript, /robin\.edit\.apply_patch@1/u);
  assert.match(result.normalizedTranscript, /robin\.process\.run@1/u);
  assert.match(result.normalizedTranscript, /robin\.git\.status@1/u);
  assert.match(result.normalizedTranscript, /robin\.git\.diff@1/u);
  assert.match(
    result.normalizedTranscript,
    /Tool output robin\.process\.run@1 \[stdout #[1-9][0-9]*\]/u,
    "bounded npm output must be visible before the process tool completes",
  );
  assert.match(result.normalizedTranscript, /labels must be uppercase/u);
  assert.match(
    result.normalizedTranscript,
    /Fixed src\/calculate\.ts with 2 approved structural edits/u,
  );
  assert.match(
    result.normalizedTranscript,
    /direct npm test verification passed after 2 attempts/u,
  );
  assert.match(
    result.normalizedTranscript,
    /no filesystem or network isolation|not sandboxed/u,
  );

  assert.equal(
    await readFile(join(fixture.workspaceRoot, "src", "calculate.ts"), "utf8"),
    REPAIRED_CODING_SOURCE,
  );
  await assertUserFilesPreserved(fixture.workspaceRoot);
  const finalSnapshot = await fixture.snapshot();
  assert.doesNotThrow(() =>
    assertRepositoryDelta(fixture.initialSnapshot, finalSnapshot, {
      added: [],
      changed: ["src/calculate.ts"],
      removed: [],
      gitChanged: true,
    }),
  );
  assert.doesNotThrow(() =>
    assertGitStorageUnchanged(fixture.initialSnapshot, finalSnapshot),
  );
  assert.equal(finalSnapshot.git.head, initialHead, "R2 must not move Git HEAD");
  assert.deepEqual(
    gitStorageEntry(finalSnapshot, "index"),
    initialIndex,
    "R2 read/status/diff and workspace edits must not mutate the Git index",
  );
  const status = Buffer.from(
    finalSnapshot.git.porcelainV2ZBase64,
    "base64",
  ).toString("utf8");
  assert.match(status, /src\/calculate\.ts/u);
  assert.match(status, /notes\/user-notes\.txt/u);
  assert.match(status, /\? scratch-user\.txt\0/u);
  await assertOutsideRootUnchanged(fixture.outsideRoot, outsideBefore);
});

test("R2 PTY denial is a no-effect observation and restores the terminal", async (context) => {
  const fixture = await createRepositoryFixture({ variant: "coding" });
  context.after(() => fixture.cleanup());
  const outsideBefore = await snapshotRepository(fixture.outsideRoot, {
    includeGit: false,
  });

  const result = await runPtyScenario("r2_deny", {
    cwd: fixture.workingDirectory,
    timeout: 45_000,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.approvalTools, ["robin.edit.apply_patch@1"]);
  assert.deepEqual(result.approvalDecisions, ["deny"]);
  assert.match(result.normalizedTranscript, /decision=deny|was denied/u);
  assert.match(result.normalizedTranscript, /No effect occurred for the refused action/u);
  assert.equal(
    await readFile(join(fixture.workspaceRoot, "src", "calculate.ts"), "utf8"),
    INITIAL_CODING_SOURCE,
  );
  await assertUserFilesPreserved(fixture.workspaceRoot);
  const finalSnapshot = await fixture.snapshot();
  assert.doesNotThrow(() =>
    assertRepositoryDelta(fixture.initialSnapshot, finalSnapshot, {
      added: [],
      changed: [],
      removed: [],
      gitChanged: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertGitStorageUnchanged(fixture.initialSnapshot, finalSnapshot),
  );
  await assertOutsideRootUnchanged(fixture.outsideRoot, outsideBefore);
});

test("R2 PTY cancellation at approval grants no authority and restores the terminal", async (context) => {
  const fixture = await createRepositoryFixture({ variant: "coding" });
  context.after(() => fixture.cleanup());
  const outsideBefore = await snapshotRepository(fixture.outsideRoot, {
    includeGit: false,
  });

  const result = await runPtyScenario("r2_cancel_approval", {
    cwd: fixture.workingDirectory,
    timeout: 45_000,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.approvalTools, ["robin.edit.apply_patch@1"]);
  assert.deepEqual(result.approvalDecisions, []);
  assert.match(result.normalizedTranscript, /Cancelling|cancelled/u);
  assert.doesNotMatch(result.normalizedTranscript, /granted once for/u);
  assert.equal(
    await readFile(join(fixture.workspaceRoot, "src", "calculate.ts"), "utf8"),
    INITIAL_CODING_SOURCE,
  );
  await assertUserFilesPreserved(fixture.workspaceRoot);
  const finalSnapshot = await fixture.snapshot();
  assert.doesNotThrow(() =>
    assertRepositoryDelta(fixture.initialSnapshot, finalSnapshot, {
      added: [],
      changed: [],
      removed: [],
      gitChanged: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertGitStorageUnchanged(fixture.initialSnapshot, finalSnapshot),
  );
  await assertOutsideRootUnchanged(fixture.outsideRoot, outsideBefore);
});

async function assertOutsideRootUnchanged(outsideRoot, before) {
  const after = await snapshotRepository(outsideRoot, { includeGit: false });
  assert.doesNotThrow(() =>
    assertRepositoryDelta(before, after, {
      added: [],
      changed: [],
      removed: [],
      gitChanged: false,
    }),
  );
}

async function assertUserFilesPreserved(workspaceRoot) {
  assert.equal(
    await readFile(join(workspaceRoot, "notes", "user-notes.txt"), "utf8"),
    "keep this user-authored baseline\npre-existing uncommitted note\n",
  );
  assert.equal(
    await readFile(join(workspaceRoot, "scratch-user.txt"), "utf8"),
    "pre-existing untracked user content\n",
  );
}

function gitStorageEntry(snapshot, entryPath) {
  const entry = snapshot.gitStorage?.entries.find(
    (candidate) => candidate.path === entryPath,
  );
  assert.ok(entry, `expected Git storage entry ${entryPath}`);
  return entry;
}
