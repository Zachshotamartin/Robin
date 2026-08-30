import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GENERATED_BUILD_METADATA } from "./generated-build-metadata.js";

const execFile = promisify(execFileCallback);
const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));
const GENERATED_SOURCE = fileURLToPath(
  new URL("../src/generated-build-metadata.ts", import.meta.url),
);
const GENERATOR = fileURLToPath(
  new URL("../scripts/generate-build-metadata.mjs", import.meta.url),
);

test("generated build metadata is immutable and matches the CLI package version", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as {
    readonly version: string;
  };

  assert.deepEqual(GENERATED_BUILD_METADATA, {
    schemaVersion: 1,
    version: manifest.version,
    buildId: "development",
    channel: "development",
  });
  assert.equal(Object.isFrozen(GENERATED_BUILD_METADATA), true);
});

test("development build metadata generation is deterministic and current", async () => {
  const options = {
    cwd: APP_ROOT,
    encoding: "utf8" as const,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  };
  const [first, second] = await Promise.all([
    execFile(process.execPath, [GENERATOR, "--print"], options),
    execFile(process.execPath, [GENERATOR, "--print"], options),
  ]);
  const generatedSource = await readFile(GENERATED_SOURCE, "utf8");

  assert.equal(first.stderr, "");
  assert.equal(second.stderr, "");
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout, generatedSource);

  const checked = await execFile(process.execPath, [GENERATOR, "--check"], options);
  assert.equal(checked.stdout, "");
  assert.equal(checked.stderr, "");
});
