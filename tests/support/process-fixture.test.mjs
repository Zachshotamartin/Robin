import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixturePath = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "process-fixture.mjs",
);

async function runFixture(args, options = {}) {
  const { input, ...execOptions } = options;
  return await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [fixturePath, ...args], {
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
      ...execOptions,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        Object.assign(error, { stdout, stderr });
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    child.stdin.end(input);
  });
}

test("process fixture preserves hostile arguments without shell parsing", async () => {
  const values = ["", "space value", "$(literal)", "`literal`", ";", "🦉"];
  const result = await runFixture(["argv", ...values]);
  assert.deepEqual(JSON.parse(result.stdout.toString("utf8")), values);
  assert.equal(result.stderr.length, 0);
});

test("process fixture emits deterministic stdout, stderr, binary, and partial data", async () => {
  const streams = await runFixture(["streams", "3"]);
  assert.equal(streams.stdout.toString("utf8"), "stdout:0\nstdout:1\nstdout:2\n");
  assert.equal(streams.stderr.toString("utf8"), "stderr:0\nstderr:1\nstderr:2\n");

  const binary = await runFixture(["binary"]);
  assert.deepEqual(binary.stdout, Buffer.from([0, 1, 2, 127, 128, 254, 255]));

  const partial = await runFixture(["partial-line", "without-newline"]);
  assert.equal(partial.stdout.toString("utf8"), "without-newline");
});

test("process fixture reports cwd, selected environment, stdin, and TTY facts", async () => {
  const cwdResult = await runFixture(["cwd"]);
  assert.equal(JSON.parse(cwdResult.stdout.toString("utf8")), repositoryRoot);

  const envResult = await runFixture(["environment", "ROBIN_FIXTURE_VISIBLE", "ROBIN_FIXTURE_MISSING"], {
    cwd: repositoryRoot,
    env: { ...process.env, ROBIN_FIXTURE_VISIBLE: "visible" },
  });
  assert.deepEqual(JSON.parse(envResult.stdout.toString("utf8")), {
    ROBIN_FIXTURE_MISSING: null,
    ROBIN_FIXTURE_VISIBLE: "visible",
  });

  const stdinResult = await runFixture(["stdin-sha256"], {
    input: Buffer.from("fixture input\n"),
  });
  assert.deepEqual(JSON.parse(stdinResult.stdout.toString("utf8")), {
    bytes: 14,
    sha256: "dc3d4277c40a080b5f5f2cad371625fbb56d4eca7c0c31c587bc1185e75842ba",
  });

  const ttyResult = await runFixture(["tty"]);
  assert.deepEqual(JSON.parse(ttyResult.stdout.toString("utf8")), {
    stderr: false,
    stdin: false,
    stdout: false,
  });
});

test("process fixture supports exact flood and exit-code modes", async () => {
  const flood = await runFixture(["flood", "65537", "4096"]);
  assert.equal(flood.stdout.length, 65_537);
  assert.equal(flood.stdout.every((byte) => byte === 0x78), true);

  await assert.rejects(
    runFixture(["exit", "23"]),
    (error) => error && typeof error === "object" && error.code === 23,
  );
});
