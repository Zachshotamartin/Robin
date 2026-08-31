import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverVerificationSuggestions } from "./index.js";

test("discovers deterministic npm scripts without executing repository text", async (t) => {
  const root = await fixtureRoot(t);
  const canary = path.join(root, "must-not-exist");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: {
        test: `node -e "require('node:fs').writeFileSync('${canary}','bad')"`,
        lint: "eslint .",
        ignored: "echo ignored",
      },
    }),
  );
  await writeFile(path.join(root, "package-lock.json"), "{}\n");

  const suggestions = await discoverVerificationSuggestions(root);
  assert.deepEqual(
    suggestions.map((suggestion) => [suggestion.kind, suggestion.executable, suggestion.argv]),
    [
      ["test", "npm", ["run", "test", "--"]],
      ["lint", "npm", ["run", "lint", "--"]],
    ],
  );
  assert.equal(suggestions[0]?.executesRepositoryScript, true);
  await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(canary)));
});

test("discovers Cargo, Go, and explicit pytest metadata as direct argv", async (t) => {
  const root = await fixtureRoot(t);
  await writeFile(path.join(root, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
  await writeFile(path.join(root, "go.mod"), "module example.test/fixture\n");
  await writeFile(path.join(root, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts='-q'\n");
  const suggestions = await discoverVerificationSuggestions(root);
  assert.deepEqual(
    suggestions.map((suggestion) => [suggestion.executable, suggestion.argv]),
    [
      ["cargo", ["test"]],
      ["go", ["test", "./..."]],
      ["python3", ["-m", "pytest"]],
    ],
  );
  assert.ok(suggestions.every((suggestion) => suggestion.automatic === false));
});

test("bounds manifest bytes and rejects malformed package metadata safely", async (t) => {
  const root = await fixtureRoot(t);
  await writeFile(path.join(root, "package.json"), "{".repeat(300_000));
  await assert.rejects(
    discoverVerificationSuggestions(root, { maximumManifestBytes: 256 * 1024 }),
  );
});

async function fixtureRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "robin-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  return root;
}
