import type {
  Expression,
  GuardDocument,
  PolicyRule,
  PolicyValue,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function formatGuardDocument(document: GuardDocument): string {
  assertRecord(document, "Guard document");
  if (document.kind !== "document" || document.languageVersion !== "1") {
    throw new TypeError('Guard formatter only supports document languageVersion "1".');
  }
  if (!Array.isArray(document.policies)) {
    throw new TypeError("Guard document policies must be an array.");
  }
  if (document.policies.length === 0) {
    return "";
  }
  return `${document.policies.map(formatPolicy).join("\n\n")}\n`;
}

function formatPolicy(policy: PolicyRule): string {
  assertRecord(policy, "Guard policy");
  if (policy.kind !== "policy") {
    throw new TypeError("Guard formatter received a non-policy rule.");
  }
  if (policy.name.kind !== "string" || typeof policy.name.value !== "string") {
    throw new TypeError("Guard policy name must be a string literal.");
  }
  if (
    policy.priority.kind !== "integer" ||
    !Number.isSafeInteger(policy.priority.value) ||
    policy.priority.value < 0
  ) {
    throw new TypeError("Guard policy priority must be a non-negative safe integer.");
  }
  if (
    policy.effect.kind !== "effect" ||
    (policy.effect.value !== "allow" &&
      policy.effect.value !== "deny" &&
      policy.effect.value !== "require_approval")
  ) {
    throw new TypeError("Guard policy effect is invalid.");
  }
  if (policy.reason.kind !== "string" || typeof policy.reason.value !== "string") {
    throw new TypeError("Guard policy reason must be a string literal.");
  }

  return [
    `policy ${formatString(policy.name.value)} priority ${policy.priority.value} {`,
    `  when ${formatExpression(policy.condition, 0, "root")}`,
    `  ${policy.effect.value}`,
    `  reason ${formatString(policy.reason.value)}`,
    "}",
  ].join("\n");
}

type ExpressionSide = "root" | "left" | "right" | "prefix";

function formatExpression(
  expression: Expression,
  parentPrecedence: number,
  side: ExpressionSide,
): string {
  assertRecord(expression, "Guard expression");
  switch (expression.kind) {
    case "comparison": {
      if (expression.left.kind !== "attribute") {
        throw new TypeError("Comparison left operand must be an attribute.");
      }
      const text = `${formatAttribute(expression.left.path)} ${formatOperator(expression.operator)} ${formatValue(expression.right)}`;
      // The grammar makes an entire comparison a primary for prefix `not`,
      // even though comparison operators occupy binding-power tier 30.
      return parenthesizeIfRequired(text, 50, parentPrecedence, side, expression.kind);
    }
    case "exists": {
      if (expression.attribute.kind !== "attribute") {
        throw new TypeError("exists operand must be an attribute.");
      }
      const text = `exists(${formatAttribute(expression.attribute.path)})`;
      return parenthesizeIfRequired(text, 50, parentPrecedence, side, expression.kind);
    }
    case "not": {
      const text = `not ${formatExpression(expression.operand, 40, "prefix")}`;
      return parenthesizeIfRequired(text, 40, parentPrecedence, side, expression.kind);
    }
    case "logical": {
      if (expression.operator !== "and" && expression.operator !== "or") {
        throw new TypeError("Guard logical operator is invalid.");
      }
      const precedence = expression.operator === "and" ? 20 : 10;
      const left = formatExpression(expression.left, precedence, "left");
      const right = formatExpression(expression.right, precedence, "right");
      const text = `${left} ${expression.operator} ${right}`;
      return parenthesizeIfRequired(text, precedence, parentPrecedence, side, expression.kind);
    }
    case "group":
      return `(${formatExpression(expression.expression, 0, "root")})`;
    default:
      throw new TypeError("Guard formatter received an unknown expression node.");
  }
}

function parenthesizeIfRequired(
  text: string,
  precedence: number,
  parentPrecedence: number,
  side: ExpressionSide,
  kind: Expression["kind"],
): string {
  const required = precedence < parentPrecedence ||
    (kind === "logical" && side === "right" && precedence === parentPrecedence);
  return required ? `(${text})` : text;
}

function formatAttribute(path: readonly string[]): string {
  if (!Array.isArray(path) || path.length === 0) {
    throw new TypeError("Guard attribute paths must contain at least one segment.");
  }
  for (const segment of path) {
    if (typeof segment !== "string" || !IDENTIFIER.test(segment)) {
      throw new TypeError(`Invalid Guard attribute segment ${JSON.stringify(segment)}.`);
    }
  }
  return path.join(".");
}

function formatOperator(operator: unknown): string {
  if (
    operator === "==" || operator === "!=" || operator === "in" ||
    operator === "matches" || operator === "starts_with"
  ) {
    return operator;
  }
  throw new TypeError("Guard comparison operator is invalid.");
}

function formatValue(value: PolicyValue): string {
  assertRecord(value, "Guard value");
  switch (value.kind) {
    case "string":
      if (typeof value.value !== "string") {
        throw new TypeError("Guard string literal value must be a string.");
      }
      return formatString(value.value);
    case "integer":
      if (!Number.isSafeInteger(value.value) || value.value < 0) {
        throw new TypeError("Guard integer literals must be non-negative safe integers.");
      }
      return String(value.value);
    case "boolean":
      if (typeof value.value !== "boolean") {
        throw new TypeError("Guard boolean literal value must be boolean.");
      }
      return value.value ? "true" : "false";
    case "list":
      if (!Array.isArray(value.items)) {
        throw new TypeError("Guard list literal items must be an array.");
      }
      return `[${value.items.map(formatValue).join(", ")}]`;
    default:
      throw new TypeError("Guard formatter received an unknown value node.");
  }
}

function formatString(value: string): string {
  let formatted = '"';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let codePoint = codeUnit;
    let character = value[index] ?? "";
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new TypeError("Guard strings cannot contain an unpaired high surrogate.");
      }
      codePoint = ((codeUnit - 0xd800) * 0x400) + (low - 0xdc00) + 0x10000;
      character = String.fromCodePoint(codePoint);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Guard strings cannot contain an unpaired low surrogate.");
    }

    switch (character) {
      case '"':
        formatted += '\\"';
        break;
      case "\\":
        formatted += "\\\\";
        break;
      case "\n":
        formatted += "\\n";
        break;
      case "\r":
        formatted += "\\r";
        break;
      case "\t":
        formatted += "\\t";
        break;
      default:
        formatted += isControlCodePoint(codePoint)
          ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
          : character;
    }
  }
  return `${formatted}"`;
}

function isControlCodePoint(codePoint: number): boolean {
  return (codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}
