import { randomBytes } from "node:crypto";

import {
  PolicyVersionIdKind,
  createDomainError,
  type JsonObject,
  type JsonValue,
  type NormalizedAction,
} from "@guard/contracts";
import type {
  Expression,
  PolicyEffect,
  PolicyValue,
  SourceSpan,
} from "@guard/policy-language";

import {
  assertRecognizedCatalogSet,
  policyAttributesFromAction,
} from "./catalog.js";
import { matchAnchoredPathGlob } from "./glob.js";
import { assertCompiledPolicySnapshot } from "./compiler.js";
import type {
  CompiledPolicyRule,
  PinnedPolicyEvaluator,
  PolicyAttributeDefinition,
  PolicyAttributeEnvironment,
  PolicyAttributeValue,
  PolicyDecision,
  PolicyEvaluationOptions,
  PolicySnapshot,
  TruthValue,
} from "./types.js";
import { compareUtf8 } from "./stable-order.js";

interface ExpressionEvaluation {
  readonly value: TruthValue;
  readonly trace: JsonObject;
}

interface MatchingRule {
  readonly compiled: CompiledPolicyRule;
  readonly trace: JsonObject;
}

export function evaluatePolicySnapshot(
  snapshot: PolicySnapshot,
  action: NormalizedAction,
  options: PolicyEvaluationOptions,
): PolicyDecision {
  assertSnapshot(snapshot);
  const token = validateCorrelationToken(options);
  const environment = policyAttributesFromAction(action, snapshot.attributeCatalogs);
  if (!sameCatalogManifest(environment, snapshot)) {
    throw denied("The action attribute schema does not match the policy snapshot.");
  }

  const evaluations: JsonObject[] = [];
  const matches: MatchingRule[] = [];
  for (const compiled of snapshot.policies) {
    const evaluated = evaluateExpression(compiled, compiled.rule.condition, environment, token);
    const ruleTrace: JsonObject = Object.freeze({
      policyName: compiled.rule.name.value,
      priority: compiled.rule.priority.value,
      effect: compiled.rule.effect.value,
      reason: compiled.rule.reason.value,
      result: evaluated.value,
      condition: evaluated.trace,
    });
    evaluations.push(ruleTrace);
    // Security mutation target: a rule matches only on complete true.
    if (evaluated.value === "true") matches.push({ compiled, trace: ruleTrace });
  }

  const denies = sortMatches(
    matches.filter((entry) => entry.compiled.rule.effect.value === "deny"),
  );
  const approvals = sortMatches(
    matches.filter(
      (entry) => entry.compiled.rule.effect.value === "require_approval",
    ),
  );
  const allows = sortMatches(
    matches.filter((entry) => entry.compiled.rule.effect.value === "allow"),
  );
  // Security mutation targets: deny overrides approval, which overrides allow.
  const winning = denies[0] ?? approvals[0] ?? allows[0] ?? null;
  const effect: PolicyEffect =
    denies.length > 0
      ? "deny"
      : approvals.length > 0
        ? "require_approval"
        : allows.length > 0
          ? "allow"
          : snapshot.defaultEffect;
  const reason =
    winning === null
      ? "No policy matched; the immutable snapshot default effect applies."
      : winning.compiled.rule.reason.value;
  const orderedMatches = [...denies, ...approvals, ...allows];
  const matchedPolicyNames = Object.freeze(
    orderedMatches.map((entry) => entry.compiled.rule.name.value),
  );
  const trace: JsonObject = Object.freeze({
    languageVersion: snapshot.languageVersion,
    policyContentHash: snapshot.contentHash,
    attributeCatalogs: snapshot.attributeCatalogs.manifest,
    combiningAlgorithm: "deny_overrides",
    defaultEffect: snapshot.defaultEffect,
    result: effect,
    winningPolicyName: winning?.compiled.rule.name.value ?? null,
    evaluations: Object.freeze(evaluations),
    matchedPolicyNames,
  });
  return Object.freeze({
    policyVersionId: snapshot.policyVersionId,
    effect,
    winningPolicyName: winning?.compiled.rule.name.value ?? null,
    reason,
    matchedPolicyNames,
    trace,
  });
}

export function createPinnedPolicyEvaluator(
  snapshot: PolicySnapshot,
  options?: PolicyEvaluationOptions,
): PinnedPolicyEvaluator {
  assertSnapshot(snapshot);
  const secretCorrelationToken =
    options === undefined
      ? `sec_${randomBytes(24).toString("base64url")}`
      : validateCorrelationToken(options);
  const policyVersionId = snapshot.policyVersionId;
  return Object.freeze({
    policyVersionId,
    evaluate(action: NormalizedAction): PolicyDecision {
      return evaluatePolicySnapshot(snapshot, action, { secretCorrelationToken });
    },
  });
}

function evaluateExpression(
  compiled: CompiledPolicyRule,
  expression: Expression,
  environment: PolicyAttributeEnvironment,
  token: string,
): ExpressionEvaluation {
  switch (expression.kind) {
    case "group": {
      const child = evaluateExpression(compiled, expression.expression, environment, token);
      return evaluated(child.value, {
        kind: "group",
        result: child.value,
        span: traceSpan(expression.span),
        expression: child.trace,
      });
    }
    case "not": {
      const child = evaluateExpression(compiled, expression.operand, environment, token);
      const value = negate(child.value);
      return evaluated(value, {
        kind: "not",
        result: value,
        span: traceSpan(expression.span),
        operand: child.trace,
      });
    }
    case "logical": {
      // Both clauses are always evaluated so the trace covers every AST node.
      const left = evaluateExpression(compiled, expression.left, environment, token);
      const right = evaluateExpression(compiled, expression.right, environment, token);
      const value = expression.operator === "and"
        ? conjunction(left.value, right.value)
        : disjunction(left.value, right.value);
      return evaluated(value, {
        kind: "logical",
        operator: expression.operator,
        result: value,
        span: traceSpan(expression.span),
        left: left.trace,
        right: right.trace,
      });
    }
    case "exists": {
      const name = expression.attribute.path.join(".");
      const value = Object.hasOwn(environment.values, name) ? "true" : "false";
      return evaluated(value, {
        kind: "exists",
        attribute: name,
        result: value,
        span: traceSpan(expression.span),
      });
    }
    case "comparison": {
      const comparison = compiled.comparisons.find(
        (candidate) => candidate.expression === expression,
      );
      if (comparison === undefined) {
        throw denied("A policy comparison was not compiled by this snapshot.");
      }
      const name = comparison.attribute.name;
      const actual = environment.values[name];
      const expected = literalValue(expression.right);
      const result = actual === undefined
        ? "unknown"
        : compare(
            expression.operator,
            actual,
            expected,
            comparison.glob,
          );
      return evaluated(result, {
        kind: "comparison",
        attribute: name,
        operator: expression.operator,
        result,
        span: traceSpan(expression.span),
        actual: traceValue(comparison.attribute, actual, token),
        expected: traceValue(comparison.attribute, expected, token),
      });
    }
  }
}

function compare(
  operator: "==" | "!=" | "in" | "matches" | "starts_with",
  actual: PolicyAttributeValue,
  expected: PolicyAttributeValue | readonly (string | boolean | number)[],
  glob: CompiledPolicyRule["comparisons"][number]["glob"],
): TruthValue {
  switch (operator) {
    case "==":
      return equalValues(actual, expected) ? "true" : "false";
    case "!=":
      return equalValues(actual, expected) ? "false" : "true";
    case "in":
      return Array.isArray(expected) && expected.some((value) => equalValues(actual, value))
        ? "true"
        : "false";
    case "starts_with":
      return typeof actual === "string" &&
        typeof expected === "string" &&
        actual.startsWith(expected)
        ? "true"
        : "false";
    case "matches":
      if (glob === null || typeof expected !== "string") {
        throw denied("A compiled path-glob comparison is invalid.");
      }
      if (typeof actual === "string") {
        return matchAnchoredPathGlob(glob, actual) ? "true" : "false";
      }
      if (Array.isArray(actual)) {
        return actual.some((path) => matchAnchoredPathGlob(glob, path))
          ? "true"
          : "false";
      }
      throw denied("A compiled path-glob comparison has an invalid target.");
  }
}

function literalValue(
  value: PolicyValue,
): PolicyAttributeValue | readonly (string | boolean | number)[] {
  if (value.kind !== "list") return value.value;
  return Object.freeze(
    value.items.map((item) => {
      if (item.kind === "list") {
        throw denied("Nested policy values cannot reach evaluation.");
      }
      return item.value;
    }),
  );
}

function traceValue(
  definition: PolicyAttributeDefinition,
  value: PolicyAttributeValue | readonly (string | boolean | number)[] | undefined,
  token: string,
): JsonValue {
  if (value === undefined) return null;
  if (definition.secretClassification === null) return value as JsonValue;
  return Object.freeze({
    classification: definition.secretClassification,
    count: Array.isArray(value) ? value.length : 1,
    correlationToken: token,
  });
}

function equalValues(
  left: PolicyAttributeValue | string | boolean | number,
  right: PolicyAttributeValue | readonly (string | boolean | number)[] | string | boolean | number,
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return left === right;
}

function negate(value: TruthValue): TruthValue {
  if (value === "unknown") return "unknown";
  return value === "true" ? "false" : "true";
}

export function conjunction(left: TruthValue, right: TruthValue): TruthValue {
  if (left === "false" || right === "false") return "false";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "true";
}

export function disjunction(left: TruthValue, right: TruthValue): TruthValue {
  if (left === "true" || right === "true") return "true";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "false";
}

function sortMatches(entries: readonly MatchingRule[]): readonly MatchingRule[] {
  return Object.freeze(
    [...entries].sort(
      (left, right) =>
        right.compiled.rule.priority.value - left.compiled.rule.priority.value ||
        compareUtf8(left.compiled.rule.name.value, right.compiled.rule.name.value),
    ),
  );
}

function traceSpan(span: SourceSpan): JsonObject {
  return Object.freeze({
    sourceId: span.sourceId,
    start: Object.freeze({
      byteOffset: span.start.byteOffset,
      line: span.start.line,
      column: span.start.column,
    }),
    end: Object.freeze({
      byteOffset: span.end.byteOffset,
      line: span.end.line,
      column: span.end.column,
    }),
  });
}

function evaluated(value: TruthValue, trace: JsonObject): ExpressionEvaluation {
  return Object.freeze({ value, trace: Object.freeze(trace) });
}

function sameCatalogManifest(
  environment: PolicyAttributeEnvironment,
  snapshot: PolicySnapshot,
): boolean {
  return (
    environment.catalogManifest === snapshot.attributeCatalogs.manifest &&
    environment.catalogManifest.every(
      (entry, index) =>
        entry.catalogId === snapshot.attributeCatalogs.manifest[index]?.catalogId &&
        entry.schemaVersion === snapshot.attributeCatalogs.manifest[index]?.schemaVersion &&
        entry.contentHash === snapshot.attributeCatalogs.manifest[index]?.contentHash,
    )
  );
}

function validateCorrelationToken(options: PolicyEvaluationOptions): string {
  if (
    typeof options !== "object" ||
    options === null ||
    Reflect.ownKeys(options).length !== 1 ||
    typeof options.secretCorrelationToken !== "string" ||
    options.secretCorrelationToken.length < 16 ||
    options.secretCorrelationToken.length > 256
  ) {
    throw new TypeError("Policy evaluation requires one bounded run correlation token.");
  }
  return options.secretCorrelationToken;
}

function assertSnapshot(snapshot: PolicySnapshot): void {
  assertCompiledPolicySnapshot(snapshot);
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    !Object.isFrozen(snapshot) ||
    !PolicyVersionIdKind.is(snapshot.policyVersionId) ||
    snapshot.languageVersion !== "1" ||
    !Array.isArray(snapshot.policies) ||
    !Object.isFrozen(snapshot.policies)
  ) {
    throw new TypeError("Policy evaluation requires an immutable compiled snapshot.");
  }
  assertRecognizedCatalogSet(snapshot.attributeCatalogs);
}

function denied(message: string) {
  return createDomainError({
    code: "policy_denied",
    message,
    details: { reason: "policy_evaluation_error" },
  });
}
