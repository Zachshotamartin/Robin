import assert from "node:assert/strict";
import test from "node:test";

import {
  ROBIN_R2_TOOL_DEFINITIONS,
  ROBIN_R2_TOOL_REFERENCES,
  robinR2ToolDefinition,
} from "./tool-definitions.js";

test("R2 publishes the exact bounded daily coding tool set", () => {
  assert.deepEqual(
    ROBIN_R2_TOOL_DEFINITIONS.map((entry) => entry.toolId),
    [
      "robin.repo.list_files@1",
      "robin.repo.search_text@1",
      "robin.repo.read_file@1",
      "robin.edit.apply_patch@1",
      "robin.edit.create_file@1",
      "robin.process.run@1",
      "robin.git.status@1",
      "robin.git.diff@1",
    ],
  );
  assert.deepEqual(
    ROBIN_R2_TOOL_DEFINITIONS.map((entry) => entry.permission),
    ["allow", "allow", "allow", "ask", "ask", "ask", "allow", "allow"],
  );
});

test("R2 has no delete, move, shell, network, or Git mutation operation", () => {
  const installed = ROBIN_R2_TOOL_DEFINITIONS.map((entry) => entry.toolId).join("\n");
  for (const forbidden of [
    "delete",
    "move",
    "replace_file",
    "batch",
    "shell",
    "network",
    "stage",
    "commit",
    "checkout",
    "reset",
    "clean",
    "push",
  ]) {
    assert.equal(installed.includes(forbidden), false, forbidden);
  }
});

test("tool references are exact-version, unique, frozen, and resolvable", () => {
  const keys = ROBIN_R2_TOOL_REFERENCES.map((reference) => JSON.stringify(reference));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(Object.isFrozen(ROBIN_R2_TOOL_DEFINITIONS));
  assert.ok(Object.isFrozen(ROBIN_R2_TOOL_REFERENCES));
  for (const definition of ROBIN_R2_TOOL_DEFINITIONS) {
    assert.equal(robinR2ToolDefinition(definition.reference), definition);
    assert.equal(definition.reference.packVersion, 1);
    assert.equal(definition.reference.operationVersion, 1);
    assert.equal(definition.definition.inputSchema.schemaVersion, 1);
    assert.equal(definition.definition.outputSchema.schemaVersion, 1);
  }
});
