import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliUsageError } from "./argv.js";
import {
  MAXIMUM_OBJECTIVE_BYTES,
  fixtureObjective,
  parseObjectiveJson,
  readObjectiveFile,
  validateFixtureObjective,
} from "./objectives.js";

test("accepts only the selected fixture envelope or exact payload shorthand", () => {
  const full = fixtureObjective("synthetic-demo");
  validateFixtureObjective("synthetic-demo", full);
  validateFixtureObjective("synthetic-demo", full["payload"]);

  assert.throws(
    () => validateFixtureObjective("coding-virtual", full),
    /does not match/u,
  );
  assert.throws(
    () =>
      validateFixtureObjective("synthetic-demo", {
        recordId: "greeting",
        mode: "uppercase",
        apiKey: "must-not-be-accepted",
      }),
    /exactly match/u,
  );
  assert.throws(
    () => validateFixtureObjective("synthetic-demo", []),
    /JSON object/u,
  );
});

test("bounded parser rejects invalid, scalar, oversized, and deeply nested JSON", () => {
  assert.throws(() => parseObjectiveJson("{"), /valid JSON/u);
  assert.throws(() => parseObjectiveJson("null"), /JSON object/u);
  assert.throws(() => parseObjectiveJson("[]"), /JSON object/u);
  assert.throws(
    () => parseObjectiveJson(`{"value":"${"x".repeat(MAXIMUM_OBJECTIVE_BYTES)}"}`),
    /exceeds/u,
  );
  const deep = `${"{\"x\":".repeat(34)}null${"}".repeat(34)}`;
  assert.throws(() => parseObjectiveJson(deep), /nested too deeply/u);
});

test("parsed objectives are descriptor-only and deeply frozen", () => {
  const parsed = parseObjectiveJson(
    '{"recordId":"greeting","mode":"uppercase","nested":{"items":[1,true,null]}}',
  );
  assert.equal(Object.isFrozen(parsed), true);
  const nested = parsed["nested"] as Record<string, unknown>;
  assert.equal(Object.isFrozen(nested), true);
  assert.equal(Object.isFrozen(nested["items"]), true);
  const descriptors = Object.getOwnPropertyDescriptors(parsed);
  assert.equal(Object.values(descriptors).every((descriptor) => "value" in descriptor), true);
});

test("file reader accepts a regular bounded UTF-8 JSON file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "robin-cli-objective-"));
  const file = join(directory, "objective.json");
  await writeFile(file, '{"recordId":"greeting","mode":"uppercase"}', "utf8");
  const parsed = await readObjectiveFile(file);
  validateFixtureObjective("synthetic-demo", parsed);
});

test("file reader rejects directories and bytes beyond the hard limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "robin-cli-objective-"));
  const nestedDirectory = join(directory, "not-a-file");
  await mkdir(nestedDirectory);
  await assert.rejects(() => readObjectiveFile(nestedDirectory), /regular file/u);

  const oversized = join(directory, "oversized.json");
  await writeFile(oversized, "x".repeat(MAXIMUM_OBJECTIVE_BYTES + 1), "utf8");
  await assert.rejects(() => readObjectiveFile(oversized), /exceeds/u);
});

test("fixture validation fails closed on a hostile proxy", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.throws(
    () => validateFixtureObjective("synthetic-demo", revoked.proxy),
    CliUsageError,
  );
});
