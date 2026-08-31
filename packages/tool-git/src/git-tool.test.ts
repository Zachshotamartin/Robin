import assert from "node:assert/strict";
import test from "node:test";

import {
  ROBIN_GIT_DIFF_TOOL_ID,
  ROBIN_GIT_STATUS_TOOL_ID,
  ROBIN_GIT_TOOL_DEFINITIONS,
} from "./index.js";

test("publishes read-only status and diff tool definitions only", () => {
  assert.equal(ROBIN_GIT_STATUS_TOOL_ID, "robin.git.status@1");
  assert.equal(ROBIN_GIT_DIFF_TOOL_ID, "robin.git.diff@1");
  assert.deepEqual(
    ROBIN_GIT_TOOL_DEFINITIONS.map((definition) => definition.toolId),
    [ROBIN_GIT_STATUS_TOOL_ID, ROBIN_GIT_DIFF_TOOL_ID],
  );
  assert.ok(ROBIN_GIT_TOOL_DEFINITIONS.every((definition) => definition.sideEffectClass === "none"));
  assert.equal(
    ROBIN_GIT_TOOL_DEFINITIONS.some((definition) => /commit|stage|push|reset|clean/u.test(definition.operationId)),
    false,
  );
});
