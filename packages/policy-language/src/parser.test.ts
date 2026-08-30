import assert from "node:assert/strict";
import test from "node:test";

import { GUARD_BINDING_POWERS, parseGuardDocument } from "./parser.js";
import type { Expression, PolicyValue, SourceSpan } from "./types.js";

const MINIMAL = `policy "read-source" priority 100 {
  when action.tool == "read_file"
  deny
  reason "Reads are denied in this fixture"
}`;

test("parser constructs a complete, source-spanned policy AST", () => {
  const result = parseGuardDocument(MINIMAL, { sourceId: "minimal.guard" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.document.languageVersion, "1");
  assert.equal(result.document.policies.length, 1);
  const rule = result.document.policies[0];
  assert.equal(rule?.name.value, "read-source");
  assert.equal(rule?.priority.value, 100);
  assert.equal(rule?.effect.value, "deny");
  assert.equal(rule?.reason.value, "Reads are denied in this fixture");
  assert.deepEqual(rule?.condition, {
    kind: "comparison",
    left: {
      kind: "attribute",
      path: ["action", "tool"],
      span: {
        sourceId: "minimal.guard",
        start: { byteOffset: 43, line: 2, column: 8 },
        end: { byteOffset: 54, line: 2, column: 19 },
      },
    },
    operator: "==",
    right: {
      kind: "string",
      value: "read_file",
      span: {
        sourceId: "minimal.guard",
        start: { byteOffset: 58, line: 2, column: 23 },
        end: { byteOffset: 69, line: 2, column: 34 },
      },
    },
    span: {
      sourceId: "minimal.guard",
      start: { byteOffset: 43, line: 2, column: 8 },
      end: { byteOffset: 69, line: 2, column: 34 },
    },
  });
  assert.equal(rule?.span.start.byteOffset, 0);
  assert.equal(rule?.span.end.byteOffset, Buffer.byteLength(MINIMAL));
});

test("Pratt parser applies the specified logical and prefix binding powers", () => {
  assert.deepEqual(GUARD_BINDING_POWERS, {
    or: { left: 10, right: 11 },
    and: { left: 20, right: 21 },
    comparison: { left: 30, right: 31 },
    not: { left: 0, right: 40 },
  });
  const result = parseGuardDocument(`policy "precedence" priority 1 {
    when action.tool == "a" or request.intent == "b" and not environment.sandboxed == true
    allow
    reason "binding powers"
  }`);

  assert.equal(result.ok, true);
  const expression = result.document.policies[0]?.condition;
  assert.equal(expression?.kind, "logical");
  if (expression?.kind !== "logical") return;
  assert.equal(expression.operator, "or");
  assert.equal(expression.left.kind, "comparison");
  assert.equal(expression.right.kind, "logical");
  if (expression.right.kind !== "logical") return;
  assert.equal(expression.right.operator, "and");
  assert.equal(expression.right.right.kind, "not");
  if (expression.right.right.kind !== "not") return;
  assert.equal(expression.right.right.operand.kind, "comparison");
});

test("parser represents groups, exists calls, and recursive literal lists", () => {
  const result = parseGuardDocument(`policy "values" priority 2 {
    when (exists(resource.path) or request.argv in ["test", 2, false, ["nested"]])
    require_approval
    reason "exercise every primary"
  }`);

  assert.equal(result.ok, true);
  const condition = result.document.policies[0]?.condition;
  assert.equal(condition?.kind, "group");
  if (condition?.kind !== "group" || condition.expression.kind !== "logical") return;
  assert.equal(condition.expression.left.kind, "exists");
  const comparison = condition.expression.right;
  assert.equal(comparison.kind, "comparison");
  if (comparison.kind !== "comparison") return;
  assert.equal(comparison.right.kind, "list");
  if (comparison.right.kind !== "list") return;
  assert.deepEqual(comparison.right.items.map((item) => item.kind), [
    "string", "integer", "boolean", "list",
  ]);
});

test("parser reports independent errors and resumes at the next policy", () => {
  const source = `policy "broken-a" priority nope {
    when action.tool ==
    deny
    reason "missing comparison value"
  }
  policy "valid" priority 8 {
    when exists(resource.path)
    allow
    reason "valid recovery target"
  }
  policy "broken-b" priority 9 {
    when action.tool == "read_file"
    allow
    reason
  }`;
  const result = parseGuardDocument(source, { sourceId: "recovery.guard" });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.length >= 3);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.span.start.line === 1));
  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.code === "GL2005_EXPECTED_VALUE"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.span.start.line === 15));
  assert.deepEqual(
    result.document.policies.map((policy) => policy.name.value),
    ["valid"],
  );
});

test("every AST node owns a well-ordered span", () => {
  const result = parseGuardDocument(`policy "spans" priority 3 {
    when not (exists(resource.path) and action.tool starts_with "read")
    deny
    reason "all nodes"
  }`, { sourceId: "spans.guard" });
  assert.equal(result.ok, true);

  const spans: SourceSpan[] = [result.document.span];
  for (const rule of result.document.policies) {
    spans.push(rule.span, rule.name.span, rule.priority.span, rule.effect.span, rule.reason.span);
    collectExpressionSpans(rule.condition, spans);
  }
  assert.ok(spans.length >= 12);
  for (const candidate of spans) {
    assert.equal(candidate.sourceId, "spans.guard");
    assert.ok(candidate.start.byteOffset <= candidate.end.byteOffset);
    assert.ok(candidate.start.line >= 1 && candidate.start.column >= 1);
    assert.ok(candidate.end.line >= candidate.start.line);
  }
});

test("nesting limits fail safely without recursion overflow", () => {
  const result = parseGuardDocument(`policy "deep" priority 1 {
    when (((((action.tool == "read")))))
    deny
    reason "deep"
  }`, { maxNesting: 3 });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.code === "GL2010_NESTING_LIMIT"));
  assert.deepEqual(result.document.policies, []);
});

test("parser output is deeply frozen and malformed runtime options fail closed", () => {
  const result = parseGuardDocument(MINIMAL);
  const rule = result.document.policies[0];
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.document), true);
  assert.equal(Object.isFrozen(rule), true);
  assert.equal(Object.isFrozen(rule?.condition), true);
  assert.throws(
    () => parseGuardDocument(MINIMAL, { maxNesting: 0 }),
    TypeError,
  );
  assert.throws(
    () => parseGuardDocument(MINIMAL, { maxNesting: 1.5 }),
    TypeError,
  );
});

test("parser options are captured from passive exact data properties", () => {
  let getterCalls = 0;
  const accessor = {} as { readonly maxNesting?: number };
  Object.defineProperty(accessor, "maxNesting", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("parser getter canary");
    },
  });
  let proxyTrapCalls = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        proxyTrapCalls += 1;
        throw new Error("parser proxy canary");
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("parser proxy canary");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("parser proxy canary");
      },
    },
  );
  const symbolOptions = { maxNesting: 8 } as Record<PropertyKey, unknown>;
  symbolOptions[Symbol("canary")] = true;

  for (const options of [
    accessor,
    proxy,
    { maxNesting: 8, unexpected: true },
    symbolOptions,
  ]) {
    assert.throws(
      () => parseGuardDocument(MINIMAL, options as { readonly maxNesting?: number }),
      (error: unknown) =>
        error instanceof TypeError && !error.message.includes("canary"),
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyTrapCalls, 0);

  const mutable = { sourceId: "captured.guard", maxNesting: 8 };
  const result = parseGuardDocument(MINIMAL, mutable);
  mutable.sourceId = "mutated.guard";
  mutable.maxNesting = 1;
  assert.equal(result.document.span.sourceId, "captured.guard");
  assert.equal(result.ok, true);
});

test("equal-offset diagnostic ordering is independent of host locale", () => {
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function localeCompareCanary(): number {
    throw new Error("host locale comparator must not run");
  };
  try {
    const result = parseGuardDocument(`policy "diagnostics" priority 1 {
      when action.operation == "read" and deny
      deny
      reason "invalid"
    }`);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.length >= 2);
  } finally {
    String.prototype.localeCompare = original;
  }
});

function collectExpressionSpans(expression: Expression, output: SourceSpan[]): void {
  output.push(expression.span);
  switch (expression.kind) {
    case "comparison":
      output.push(expression.left.span);
      collectValueSpans(expression.right, output);
      return;
    case "exists":
      output.push(expression.attribute.span);
      return;
    case "not":
      collectExpressionSpans(expression.operand, output);
      return;
    case "logical":
      collectExpressionSpans(expression.left, output);
      collectExpressionSpans(expression.right, output);
      return;
    case "group":
      collectExpressionSpans(expression.expression, output);
      return;
  }
}

function collectValueSpans(value: PolicyValue, output: SourceSpan[]): void {
  output.push(value.span);
  if (value.kind === "list") {
    for (const item of value.items) {
      collectValueSpans(item, output);
    }
  }
}
