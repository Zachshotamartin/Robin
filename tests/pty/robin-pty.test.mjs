import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_ROOT, "../..");
const DRIVER = join(TEST_ROOT, "robin_pty_driver.py");
const BINARY = join(REPOSITORY_ROOT, "apps", "cli", "dist", "bin.js");
const PYTHON = process.env.ROBIN_TEST_PYTHON ?? "/usr/bin/python3";

async function runPtyScenario(scenario) {
  const { stdout, stderr } = await execFile(
    PYTHON,
    [
      DRIVER,
      "--scenario",
      scenario,
      "--cwd",
      REPOSITORY_ROOT,
      "--node",
      process.execPath,
      "--binary",
      BINARY,
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  const transcript = Buffer.from(result.transcriptBase64, "base64").toString("utf8");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.scenario, scenario);
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
    [BINARY],
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
