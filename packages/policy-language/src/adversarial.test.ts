import assert from "node:assert/strict";
import test from "node:test";

import { lexGuardSource } from "./lexer.js";
import { parseGuardDocument } from "./parser.js";

test("malformed list recovery reaches a policy boundary without looping", { timeout: 1_000 }, () => {
  const result = parseGuardDocument(`policy "bad-list" priority 1 {
    when request.argv in ["one" "two"
    deny
    reason "malformed"
  }
  policy "after" priority 2 {
    when action.operation == "read"
    allow
    reason "recovered"
  }`);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.document.policies.map((policy) => policy.name.value),
    ["after"],
  );
  assert.ok(result.diagnostics.some((item) => item.code === "GL2001_EXPECTED_TOKEN"));
});

test("a nesting bomb is consumed iteratively after the configured boundary", { timeout: 1_000 }, () => {
  const opening = "(".repeat(10_000);
  const closing = ")".repeat(10_000);
  const result = parseGuardDocument(`policy "bomb" priority 1 {
    when ${opening}action.operation == "read"${closing}
    deny
    reason "bounded"
  }`, { maxNesting: 8 });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "GL2010_NESTING_LIMIT"));
  assert.deepEqual(result.document.policies, []);
});

test("all major parser synchronization tokens preserve later declarations", () => {
  const corruptRules = [
    'policy "effect" priority 1 { when action.operation == allow reason "x" }',
    'policy "reason" priority 1 { when action.operation == "x" deny reason }',
    'policy "brace" priority 1 { when action.operation == "x" deny reason "x"',
  ];
  for (const corrupt of corruptRules) {
    const result = parseGuardDocument(`${corrupt}
policy "survivor" priority 2 {
  when action.operation == "read"
  deny
  reason "survives"
}`);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.document.policies.map((policy) => policy.name.value),
      ["survivor"],
      corrupt,
    );
  }
});

test("invalid grammar extensions are rejected rather than silently accepted", () => {
  const sources = [
    'policy "comment" priority 1 { when action.operation == "x" deny reason "x" } # no comments',
    'policy "chain" priority 1 { when action.operation == "x" == "y" deny reason "x" }',
    'policy "double-not" priority 1 { when not not action.operation == "x" deny reason "x" }',
    'policy "trailing" priority 1 { when request.argv in ["x",] deny reason "x" }',
    'policy "call" priority 1 { when custom(action.operation) deny reason "x" }',
  ];
  for (const source of sources) {
    const result = parseGuardDocument(source);
    assert.equal(result.ok, false, source);
  }
});

test("raw unpaired surrogates and C1 controls are diagnosed with advancing spans", () => {
  const source = `"before\ud800after" "c1\u0085control"`;
  const result = lexGuardSource(source);

  assert.deepEqual(
    result.diagnostics.map((item) => item.code),
    ["GL1009_INVALID_UNICODE_SCALAR", "GL1006_UNESCAPED_CONTROL_CHARACTER"],
  );
  for (const diagnostic of result.diagnostics) {
    assert.ok(diagnostic.span.end.byteOffset > diagnostic.span.start.byteOffset);
    assert.ok(diagnostic.span.end.column > diagnostic.span.start.column);
  }
});

test("token and diagnostic byte spans remain monotonic across mixed line endings", () => {
  const result = lexGuardSource('policy "é😀"\r\n@\npriority 2\rdeny');
  const spans = [
    ...result.tokens.map((token) => token.span),
    ...result.diagnostics.map((diagnostic) => diagnostic.span),
  ].sort((left, right) => left.start.byteOffset - right.start.byteOffset);

  let priorOffset = 0;
  for (const candidate of spans) {
    assert.ok(candidate.start.byteOffset >= priorOffset);
    assert.ok(candidate.end.byteOffset >= candidate.start.byteOffset);
    priorOffset = candidate.start.byteOffset;
  }
  assert.equal(result.tokens.at(-1)?.span.start.line, 4);
});

test("many independent invalid characters complete in linear progress", { timeout: 1_000 }, () => {
  const result = lexGuardSource("@".repeat(5_000));
  assert.equal(result.diagnostics.length, 5_000);
  assert.equal(result.tokens.length, 1);
  assert.equal(result.diagnostics.at(-1)?.span.end.byteOffset, 5_000);
});
