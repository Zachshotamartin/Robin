import { deepFreeze } from "./immutable.js";
import type { Expression, GuardDocument, PolicyValue } from "./types.js";

export type GuardSemanticProjection =
  | null
  | boolean
  | number
  | string
  | readonly GuardSemanticProjection[]
  | { readonly [key: string]: GuardSemanticProjection };

/**
 * Return a frozen AST projection without source identity or positions. This is
 * suitable for structural parse/format/parse comparisons, never evaluation.
 */
export function projectGuardDocumentSemantics(
  document: GuardDocument,
): GuardSemanticProjection {
  return deepFreeze({
    kind: document.kind,
    languageVersion: document.languageVersion,
    policies: document.policies.map((policy) => ({
      kind: policy.kind,
      name: policy.name.value,
      priority: policy.priority.value,
      condition: projectExpression(policy.condition),
      effect: policy.effect.value,
      reason: policy.reason.value,
    })),
  });
}

function projectExpression(expression: Expression): GuardSemanticProjection {
  switch (expression.kind) {
    case "comparison":
      return {
        kind: expression.kind,
        left: [...expression.left.path],
        operator: expression.operator,
        right: projectValue(expression.right),
      };
    case "exists":
      return { kind: expression.kind, attribute: [...expression.attribute.path] };
    case "not":
      return { kind: expression.kind, operand: projectExpression(expression.operand) };
    case "logical":
      return {
        kind: expression.kind,
        operator: expression.operator,
        left: projectExpression(expression.left),
        right: projectExpression(expression.right),
      };
    case "group":
      return { kind: expression.kind, expression: projectExpression(expression.expression) };
  }
}

function projectValue(value: PolicyValue): GuardSemanticProjection {
  switch (value.kind) {
    case "string":
    case "integer":
    case "boolean":
      return { kind: value.kind, value: value.value };
    case "list":
      return { kind: value.kind, items: value.items.map(projectValue) };
  }
}
