import assert from "node:assert/strict";
import test from "node:test";

import {
  GUARD_BINDING_POWERS,
  GUARD_LANGUAGE_VERSION,
  TOKEN_KINDS,
  formatGuardDocument,
  lexGuardSource,
  parseGuardDocument,
  projectGuardDocumentSemantics,
} from "./index.js";

test("the explicit public entry point exposes the complete language pipeline", () => {
  const source = `policy "public-api" priority 1 {
  when action.operation == "read"
  deny
  reason "public"
}
`;
  const lexed = lexGuardSource(source);
  const parsed = parseGuardDocument(source);

  assert.deepEqual(lexed.diagnostics, []);
  assert.equal(parsed.ok, true);
  assert.equal(formatGuardDocument(parsed.document), source);
  assert.equal(projectGuardDocumentSemantics(parsed.document) !== null, true);
  assert.equal(GUARD_LANGUAGE_VERSION, "1");
  assert.equal(GUARD_BINDING_POWERS.and.left, 20);
  assert.ok(TOKEN_KINDS.includes("require_approval"));
  assert.equal(Object.isFrozen(TOKEN_KINDS), true);
});
