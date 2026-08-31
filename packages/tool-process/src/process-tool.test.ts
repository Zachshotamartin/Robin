import assert from "node:assert/strict";
import test from "node:test";

import {
  ROBIN_PROCESS_RUN_INPUT_SCHEMA,
  ROBIN_PROCESS_RUN_TOOL_ID,
} from "./index.js";

test("publishes a closed direct-exec schema without shell command text", () => {
  assert.equal(ROBIN_PROCESS_RUN_TOOL_ID, "robin.process.run@1");
  assert.equal(ROBIN_PROCESS_RUN_INPUT_SCHEMA.additionalProperties, false);
  assert.equal(
    Object.hasOwn(ROBIN_PROCESS_RUN_INPUT_SCHEMA.properties, "shell"),
    false,
  );
  assert.equal(
    Object.hasOwn(ROBIN_PROCESS_RUN_INPUT_SCHEMA.properties, "command"),
    false,
  );
  assert.ok(Object.hasOwn(ROBIN_PROCESS_RUN_INPUT_SCHEMA.properties, "argv"));
});
