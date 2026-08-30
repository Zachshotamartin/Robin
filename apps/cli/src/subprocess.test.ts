import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFile = promisify(execFileCallback);
const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));
const SYNTHETIC_OBJECTIVE = fileURLToPath(
  new URL("../testdata/synthetic-payload.json", import.meta.url),
);
const CODING_OBJECTIVE = fileURLToPath(
  new URL("../testdata/coding-objective.json", import.meta.url),
);

test("source-installed bin runs the synthetic human profile", async () => {
  const result = await execute([
    "run",
    "--profile",
    "synthetic-demo",
    "--format",
    "human",
    "--objective-file",
    SYNTHETIC_OBJECTIVE,
  ]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Guarded Agent run run_/u);
  assert.match(result.stdout, /RunCompleted/u);
  assert.match(result.stdout, /Status: completed/u);
  assert.match(result.stdout, /GUARDED AGENTS TRANSFORM BOUNDED DATA\./u);
  assert.equal(result.stderr, "");
});

test("source-installed bin runs the coding profile as clean JSONL", async () => {
  const result = await execute([
    "run",
    "--profile",
    "coding-virtual",
    "--jsonl",
    "--objective-file",
    CODING_OBJECTIVE,
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length > 20, true);
  const decoded = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const item of decoded) {
    assert.deepEqual(Object.keys(item), [
      "schemaVersion",
      "cursor",
      "timestamp",
      "type",
      "runId",
      "payload",
    ]);
  }
  assert.equal(decoded.at(-1)?.["type"], "RunCompleted");
  assert.equal(decoded.at(-1)?.["cursor"], 33);
});

test("source-installed bin runs quiet shorthand without progress contamination", async () => {
  const result = await execute([
    "run",
    "--profile",
    "synthetic-demo",
    "--quiet",
    "--",
    '{"recordId":"greeting","mode":"uppercase"}',
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output["outcomeType"], "synthetic.transform.completed");
  assert.equal(result.stdout.trimEnd().split("\n").length, 1);
});

test("source-installed bin rejects API-key flags without leaking the value", async () => {
  const secret = "subprocess-secret-canary";
  const result = await execute([
    "run",
    "--profile",
    "synthetic-demo",
    "--api-key",
    secret,
  ]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown option: --api-key/u);
  assert.doesNotMatch(result.stderr, new RegExp(secret, "u"));
});

async function execute(argv: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const result = await execFile(process.execPath, [BIN, ...argv], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!isExecFileError(error)) throw error;
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
    };
  }
}

function isExecFileError(value: unknown): value is {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
} {
  return typeof value === "object" && value !== null;
}
