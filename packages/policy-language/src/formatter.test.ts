import assert from "node:assert/strict";
import test from "node:test";

import { formatGuardDocument } from "./formatter.js";
import { parseGuardDocument } from "./parser.js";
import { projectGuardDocumentSemantics } from "./semantics.js";

const UNFORMATTED = ` policy   "protect-secrets"   priority 100{
 when action.operation=="source.read" and repo.path matches "**/.env*"
 deny reason "Secret files cannot enter model context"}

policy "approval" priority 70 { when request.executable in ["npm","pnpm","yarn"] require_approval reason "Install requires approval" }`;

const FORMATTED = `policy "protect-secrets" priority 100 {
  when action.operation == "source.read" and repo.path matches "**/.env*"
  deny
  reason "Secret files cannot enter model context"
}

policy "approval" priority 70 {
  when request.executable in ["npm", "pnpm", "yarn"]
  require_approval
  reason "Install requires approval"
}
`;

test("formatter emits one canonical representation and is idempotent", () => {
  const parsed = parseGuardDocument(UNFORMATTED);
  assert.equal(parsed.ok, true);

  const once = formatGuardDocument(parsed.document);
  assert.equal(once, FORMATTED);
  const reparsed = parseGuardDocument(once);
  assert.equal(reparsed.ok, true);
  const twice = formatGuardDocument(reparsed.document);
  assert.equal(twice, once);
  assert.deepEqual(
    projectGuardDocumentSemantics(reparsed.document),
    projectGuardDocumentSemantics(parsed.document),
  );
});

test("formatter preserves explicit grouping and operator semantics", () => {
  const source = `policy "groups" priority 9 {
    when (action.operation == "a" or action.operation == "b") and not (subject.kind == "client" or environment.sandboxed == false)
    allow
    reason "grouped"
  }`;
  const first = parseGuardDocument(source);
  assert.equal(first.ok, true);
  const formatted = formatGuardDocument(first.document);
  const second = parseGuardDocument(formatted);
  assert.equal(second.ok, true);
  assert.deepEqual(
    projectGuardDocumentSemantics(second.document),
    projectGuardDocumentSemantics(first.document),
  );
});

test("formatter uses only supported escapes and round-trips Unicode", () => {
  const source = `policy "quotes\\\"-and-😀" priority 1 {
    when action.operation == "line\\ncarriage\\rtab\\tbackslash\\\\slash\\/control\\u0001"
    deny
    reason "é😀"
  }`;
  const first = parseGuardDocument(source);
  assert.equal(first.ok, true);
  const formatted = formatGuardDocument(first.document);
  assert.match(formatted, /"quotes\\"-and-😀"/);
  assert.match(formatted, /line\\ncarriage\\rtab\\tbackslash\\\\slash\/control\\u0001/);
  const second = parseGuardDocument(formatted);
  assert.equal(second.ok, true);
  assert.deepEqual(
    projectGuardDocumentSemantics(second.document),
    projectGuardDocumentSemantics(first.document),
  );
});

test("empty documents format to empty text", () => {
  const parsed = parseGuardDocument("");
  assert.equal(parsed.ok, true);
  assert.equal(formatGuardDocument(parsed.document), "");
});

test("formatter rejects corrupted runtime AST values", () => {
  const valid = parseGuardDocument(`policy "valid" priority 1 {
    when action.operation == "read"
    deny
    reason "valid"
  }`);
  assert.equal(valid.ok, true);
  const rule = valid.document.policies[0];
  assert.ok(rule);

  assert.throws(
    () => formatGuardDocument({ ...valid.document, languageVersion: "2" as "1" }),
    TypeError,
  );
  assert.throws(
    () => formatGuardDocument({
      ...valid.document,
      policies: [{ ...rule, priority: { ...rule.priority, value: -1 } }],
    }),
    TypeError,
  );
  assert.throws(
    () => formatGuardDocument({
      ...valid.document,
      policies: [{
        ...rule,
        reason: { ...rule.reason, value: "bad\ud800" },
      }],
    }),
    TypeError,
  );
});
