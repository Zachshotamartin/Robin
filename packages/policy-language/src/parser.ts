import { deepFreeze } from "./immutable.js";
import { lexGuardSource } from "./lexer.js";
import { coveringSpan, position, span } from "./source.js";
import {
  GUARD_LANGUAGE_VERSION,
  type AttributeExpression,
  type ComparisonExpression,
  type ComparisonOperator,
  type Expression,
  type GuardDiagnostic,
  type GuardDocument,
  type GuardParseOptions,
  type GuardParseResult,
  type GuardToken,
  type GroupExpression,
  type IntegerLiteral,
  type ListLiteral,
  type PolicyEffectNode,
  type PolicyRule,
  type PolicyValue,
  type SourceSpan,
  type StringLiteral,
  type TokenKind,
} from "./types.js";

export const GUARD_BINDING_POWERS = deepFreeze({
  or: { left: 10, right: 11 },
  and: { left: 20, right: 21 },
  comparison: { left: 30, right: 31 },
  not: { left: 0, right: 40 },
});

export const DEFAULT_MAX_GUARD_NESTING = 128;
export const MAX_CONFIGURABLE_GUARD_NESTING = 1_024;

const EFFECT_KINDS = new Set<TokenKind>(["allow", "deny", "require_approval"]);
const COMPARISON_OPERATORS = new Map<TokenKind, ComparisonOperator>([
  ["equal_equal", "=="],
  ["bang_equal", "!="],
  ["in", "in"],
  ["matches", "matches"],
  ["starts_with", "starts_with"],
]);
const EXPRESSION_BOUNDARIES = new Set<TokenKind>([
  "allow",
  "deny",
  "require_approval",
  "reason",
  "right_brace",
  "policy",
  "eof",
]);
const POLICY_BOUNDARIES = new Set<TokenKind>(["policy", "eof"]);

interface ParsedOptions {
  readonly sourceId: string | undefined;
  readonly maxNesting: number;
}

class GuardParser {
  readonly #tokens: readonly GuardToken[];
  readonly #lexerDiagnostics: readonly GuardDiagnostic[];
  readonly #diagnostics: GuardDiagnostic[] = [];
  readonly #maxNesting: number;
  #current = 0;
  #nesting = 0;

  constructor(
    tokens: readonly GuardToken[],
    lexerDiagnostics: readonly GuardDiagnostic[],
    maxNesting: number,
  ) {
    this.#tokens = tokens;
    this.#lexerDiagnostics = lexerDiagnostics;
    this.#maxNesting = maxNesting;
  }

  parse(): GuardParseResult {
    const policies: PolicyRule[] = [];
    while (!this.#check("eof")) {
      if (this.#check("policy")) {
        const policy = this.#parsePolicy();
        if (policy !== null) {
          policies.push(policy);
        }
        continue;
      }
      this.#diagnose(
        "GL2002_UNEXPECTED_TOKEN",
        `Expected a policy declaration, but found ${describeToken(this.#peek())}.`,
        this.#peek().span,
      );
      this.#synchronize(POLICY_BOUNDARIES);
    }

    const eof = this.#peek();
    const sourceSpan = span(
      eof.span.sourceId,
      position(0, 1, 1),
      eof.span.end,
    );
    const document: GuardDocument = {
      kind: "document",
      languageVersion: GUARD_LANGUAGE_VERSION,
      policies,
      span: sourceSpan,
    };
    const diagnostics = [...this.#lexerDiagnostics, ...this.#diagnostics].sort(compareDiagnostics);
    return deepFreeze({
      ok: diagnostics.length === 0,
      document,
      tokens: this.#tokens,
      diagnostics,
    });
  }

  #parsePolicy(): PolicyRule | null {
    const parserDiagnosticStart = this.#diagnostics.length;
    const policyToken = this.#advance();
    const nameToken = this.#expect(
      "string",
      "a double-quoted policy name",
      new Set(["priority", "left_brace", "when", ...EFFECT_KINDS, "reason", "right_brace", "policy", "eof"]),
    );
    const priorityKeyword = this.#expect(
      "priority",
      'the keyword "priority"',
      new Set(["integer", "left_brace", "when", ...EFFECT_KINDS, "reason", "right_brace", "policy", "eof"]),
    );
    const priorityToken = this.#expect(
      "integer",
      "a non-negative safe integer priority",
      new Set(["left_brace", "when", ...EFFECT_KINDS, "reason", "right_brace", "policy", "eof"]),
    );
    const leftBrace = this.#expect(
      "left_brace",
      'an opening "{"',
      new Set(["when", ...EFFECT_KINDS, "reason", "right_brace", "policy", "eof"]),
    );
    const whenKeyword = this.#expect(
      "when",
      'the keyword "when"',
      new Set([...EFFECT_KINDS, "reason", "right_brace", "policy", "eof"]),
    );

    const condition = whenKeyword === null ? null : this.#parseExpression(0);
    if (whenKeyword !== null && condition === null) {
      this.#synchronize(EXPRESSION_BOUNDARIES);
    }

    const effect = this.#parseEffect();
    const reasonKeyword = this.#expect(
      "reason",
      'the keyword "reason"',
      new Set(["string", "right_brace", "policy", "eof"]),
    );
    const reasonToken = this.#expect(
      "string",
      "a double-quoted reason",
      new Set(["right_brace", "policy", "eof"]),
    );
    const rightBrace = this.#expectClosingBrace();

    const endSpan = rightBrace?.span ?? this.#peek().span;
    const policySpan = span(
      policyToken.span.sourceId,
      policyToken.span.start,
      endSpan.end,
    );
    const hasParserError = this.#diagnostics.length !== parserDiagnosticStart;
    const hasLexerError = this.#lexerDiagnostics.some((diagnostic) =>
      overlaps(policySpan, diagnostic.span));

    if (
      hasParserError || hasLexerError || nameToken === null || priorityKeyword === null ||
      priorityToken === null || leftBrace === null || condition === null || effect === null ||
      reasonKeyword === null || reasonToken === null || rightBrace === null
    ) {
      return null;
    }

    const name = stringLiteral(nameToken);
    const priority = integerLiteral(priorityToken);
    const reason = stringLiteral(reasonToken);
    if (name === null || priority === null || reason === null) {
      this.#diagnose(
        "GL2006_INVALID_TOKEN_VALUE",
        "A lexed policy token contained an invalid decoded value.",
        policySpan,
      );
      return null;
    }
    return {
      kind: "policy",
      name,
      priority,
      condition,
      effect,
      reason,
      span: coveringSpan(policyToken.span, rightBrace.span),
    };
  }

  #parseExpression(minimumBindingPower: number): Expression | null {
    let left = this.#parsePrefixExpression();
    if (left === null) {
      return null;
    }

    while (true) {
      const current = this.#peek();
      const binding = current.kind === "or"
        ? GUARD_BINDING_POWERS.or
        : current.kind === "and"
          ? GUARD_BINDING_POWERS.and
          : null;
      if (binding === null || binding.left < minimumBindingPower) {
        break;
      }
      const operatorToken = this.#advance();
      const right = this.#parseExpression(binding.right);
      if (right === null) {
        this.#diagnose(
          "GL2003_EXPECTED_EXPRESSION",
          `Expected an expression after "${operatorToken.lexeme}".`,
          this.#peek().span,
        );
        return null;
      }
      left = {
        kind: "logical",
        operator: operatorToken.kind === "and" ? "and" : "or",
        left,
        right,
        span: coveringSpan(left.span, right.span),
      };
    }
    return left;
  }

  #parsePrefixExpression(): Expression | null {
    if (this.#match("not")) {
      const notToken = this.#previous();
      if (!this.#enterNesting(notToken.span)) {
        return null;
      }
      if (this.#check("not")) {
        this.#diagnose(
          "GL2007_REPEATED_NOT",
          'The v1 grammar permits one "not" before a primary expression.',
          this.#peek().span,
        );
        this.#leaveNesting();
        return null;
      }
      const operand = this.#parseExpression(GUARD_BINDING_POWERS.not.right);
      this.#leaveNesting();
      if (operand === null) {
        this.#diagnose(
          "GL2003_EXPECTED_EXPRESSION",
          'Expected a comparison, exists call, or parenthesized expression after "not".',
          this.#peek().span,
        );
        return null;
      }
      return {
        kind: "not",
        operand,
        span: coveringSpan(notToken.span, operand.span),
      };
    }
    return this.#parsePrimaryExpression();
  }

  #parsePrimaryExpression(): Expression | null {
    if (this.#match("left_paren")) {
      const opening = this.#previous();
      if (!this.#enterNesting(opening.span)) {
        this.#skipBalanced("left_paren", "right_paren");
        return null;
      }
      const expression = this.#parseExpression(0);
      const closing = this.#expect(
        "right_paren",
        'a closing ")"',
        EXPRESSION_BOUNDARIES,
      );
      this.#leaveNesting();
      if (expression === null) {
        return null;
      }
      const group: GroupExpression = {
        kind: "group",
        expression,
        span: closing === null
          ? coveringSpan(opening.span, expression.span)
          : coveringSpan(opening.span, closing.span),
      };
      return group;
    }
    if (this.#match("exists")) {
      const existsToken = this.#previous();
      const opening = this.#expect(
        "left_paren",
        'an opening "(" after "exists"',
        new Set(["identifier", "right_paren", ...EXPRESSION_BOUNDARIES]),
      );
      const attribute = this.#parseAttribute();
      const closing = this.#expect(
        "right_paren",
        'a closing ")" after the exists attribute',
        EXPRESSION_BOUNDARIES,
      );
      if (opening === null || attribute === null || closing === null) {
        return null;
      }
      return {
        kind: "exists",
        attribute,
        span: coveringSpan(existsToken.span, closing.span),
      };
    }
    return this.#parseComparison();
  }

  #parseComparison(): ComparisonExpression | null {
    const attribute = this.#parseAttribute();
    if (attribute === null) {
      this.#diagnose(
        "GL2003_EXPECTED_EXPRESSION",
        "Expected a comparison, exists call, or parenthesized expression.",
        this.#peek().span,
      );
      return null;
    }
    const operatorToken = this.#peek();
    const operator = COMPARISON_OPERATORS.get(operatorToken.kind);
    if (operator === undefined) {
      this.#diagnose(
        "GL2004_EXPECTED_COMPARISON_OPERATOR",
        'Expected one of "==", "!=", "in", "matches", or "starts_with" after the attribute.',
        operatorToken.span,
      );
      return null;
    }
    this.#advance();
    // Comparisons are grammar-level primaries, so the Pratt table governs their
    // relation to logical/prefix operators while the right operand stays a value.
    void GUARD_BINDING_POWERS.comparison.right;
    const right = this.#parseValue();
    if (right === null) {
      return null;
    }
    return {
      kind: "comparison",
      left: attribute,
      operator,
      right,
      span: coveringSpan(attribute.span, right.span),
    };
  }

  #parseAttribute(): AttributeExpression | null {
    const first = this.#expect(
      "identifier",
      "an attribute identifier",
      new Set([
        ...COMPARISON_OPERATORS.keys(),
        "right_paren", "comma", "right_bracket", "and", "or",
        ...EXPRESSION_BOUNDARIES,
      ]),
    );
    if (first === null || typeof first.value !== "string") {
      return null;
    }
    const path = [first.value];
    let last = first;
    while (this.#match("dot")) {
      const segment = this.#expect(
        "identifier",
        "an identifier after the dot in an attribute",
        new Set([
          ...COMPARISON_OPERATORS.keys(),
          "right_paren", "comma", "right_bracket", "and", "or",
          ...EXPRESSION_BOUNDARIES,
        ]),
      );
      if (segment === null || typeof segment.value !== "string") {
        return null;
      }
      path.push(segment.value);
      last = segment;
    }
    return {
      kind: "attribute",
      path,
      span: coveringSpan(first.span, last.span),
    };
  }

  #parseValue(): PolicyValue | null {
    const current = this.#peek();
    if (this.#match("string")) {
      return stringLiteral(current);
    }
    if (this.#match("integer")) {
      return integerLiteral(current);
    }
    if (this.#match("true") || this.#match("false")) {
      if (typeof current.value !== "boolean") {
        this.#diagnose(
          "GL2006_INVALID_TOKEN_VALUE",
          "A boolean token contained an invalid decoded value.",
          current.span,
        );
        return null;
      }
      return { kind: "boolean", value: current.value, span: current.span };
    }
    if (this.#match("left_bracket")) {
      return this.#parseList(this.#previous());
    }
    this.#diagnose(
      "GL2005_EXPECTED_VALUE",
      "Expected a string, integer, boolean, or list value.",
      current.span,
    );
    if (!isValueBoundary(current.kind)) {
      this.#advance();
    }
    return null;
  }

  #parseList(opening: GuardToken): ListLiteral | null {
    if (!this.#enterNesting(opening.span)) {
      this.#skipBalanced("left_bracket", "right_bracket");
      return null;
    }
    const items: PolicyValue[] = [];
    let invalid = false;
    if (!this.#check("right_bracket")) {
      while (
        !this.#check("right_bracket") && !this.#check("eof") &&
        !EXPRESSION_BOUNDARIES.has(this.#peek().kind)
      ) {
        const item = this.#parseValue();
        if (item === null) {
          invalid = true;
          this.#synchronize(new Set(["comma", "right_bracket", ...EXPRESSION_BOUNDARIES]));
        } else {
          items.push(item);
        }
        if (this.#match("comma")) {
          if (this.#check("right_bracket")) {
            this.#diagnose(
              "GL2008_TRAILING_COMMA",
              "List literals do not permit a trailing comma.",
              this.#peek().span,
            );
            invalid = true;
          }
          continue;
        }
        if (!this.#check("right_bracket")) {
          this.#diagnose(
            "GL2001_EXPECTED_TOKEN",
            'Expected a comma or closing "]" after the list item.',
            this.#peek().span,
          );
          invalid = true;
          this.#synchronize(new Set(["comma", "right_bracket", ...EXPRESSION_BOUNDARIES]));
          this.#match("comma");
        }
      }
    }
    const closing = this.#expect(
      "right_bracket",
      'a closing "]"',
      new Set(["right_paren", "and", "or", ...EXPRESSION_BOUNDARIES]),
    );
    this.#leaveNesting();
    if (closing === null || invalid) {
      return null;
    }
    return {
      kind: "list",
      items,
      span: coveringSpan(opening.span, closing.span),
    };
  }

  #parseEffect(): PolicyEffectNode | null {
    if (!EFFECT_KINDS.has(this.#peek().kind)) {
      this.#diagnose(
        "GL2001_EXPECTED_TOKEN",
        'Expected policy effect "allow", "deny", or "require_approval".',
        this.#peek().span,
      );
      this.#synchronize(new Set([...EFFECT_KINDS, "reason", "right_brace", "policy", "eof"]));
    }
    const token = this.#peek();
    if (!EFFECT_KINDS.has(token.kind)) {
      return null;
    }
    this.#advance();
    const value = token.kind === "allow"
      ? "allow"
      : token.kind === "deny"
        ? "deny"
        : "require_approval";
    return { kind: "effect", value, span: token.span };
  }

  #expectClosingBrace(): GuardToken | null {
    if (this.#check("right_brace")) {
      return this.#advance();
    }
    this.#diagnose(
      "GL2001_EXPECTED_TOKEN",
      'Expected a closing "}" after the policy reason.',
      this.#peek().span,
    );
    this.#synchronize(new Set(["right_brace", "policy", "eof"]));
    return this.#match("right_brace") ? this.#previous() : null;
  }

  #expect(kind: TokenKind, expected: string, stopKinds: ReadonlySet<TokenKind>): GuardToken | null {
    if (this.#check(kind)) {
      return this.#advance();
    }
    this.#diagnose(
      "GL2001_EXPECTED_TOKEN",
      `Expected ${expected}, but found ${describeToken(this.#peek())}.`,
      this.#peek().span,
    );
    if (!stopKinds.has(this.#peek().kind) && !this.#check("eof")) {
      this.#advance();
    }
    return null;
  }

  #enterNesting(at: SourceSpan): boolean {
    if (this.#nesting >= this.#maxNesting) {
      this.#diagnose(
        "GL2010_NESTING_LIMIT",
        `Policy nesting exceeds the configured limit of ${this.#maxNesting}.`,
        at,
      );
      return false;
    }
    this.#nesting += 1;
    return true;
  }

  #leaveNesting(): void {
    this.#nesting -= 1;
  }

  #skipBalanced(opening: TokenKind, closing: TokenKind): void {
    let depth = 1;
    while (!this.#check("eof") && depth > 0) {
      const token = this.#advance();
      if (token.kind === opening) {
        depth += 1;
      } else if (token.kind === closing) {
        depth -= 1;
      }
    }
  }

  #synchronize(stops: ReadonlySet<TokenKind>): void {
    while (!this.#check("eof") && !stops.has(this.#peek().kind)) {
      this.#advance();
    }
  }

  #diagnose(code: string, message: string, diagnosticSpan: SourceSpan): void {
    this.#diagnostics.push({
      severity: "error",
      phase: "parser",
      code,
      message,
      span: diagnosticSpan,
    });
  }

  #match(kind: TokenKind): boolean {
    if (!this.#check(kind)) {
      return false;
    }
    this.#advance();
    return true;
  }

  #check(kind: TokenKind): boolean {
    return this.#peek().kind === kind;
  }

  #advance(): GuardToken {
    const token = this.#peek();
    if (token.kind !== "eof") {
      this.#current += 1;
    }
    return token;
  }

  #peek(): GuardToken {
    const token = this.#tokens[this.#current];
    if (token === undefined) {
      throw new TypeError("The Guard token stream must end with an EOF token.");
    }
    return token;
  }

  #previous(): GuardToken {
    const token = this.#tokens[Math.max(0, this.#current - 1)];
    if (token === undefined) {
      throw new TypeError("The Guard token stream is empty.");
    }
    return token;
  }
}

function stringLiteral(token: GuardToken): StringLiteral | null {
  return typeof token.value === "string"
    ? { kind: "string", value: token.value, span: token.span }
    : null;
}

function integerLiteral(token: GuardToken): IntegerLiteral | null {
  return typeof token.value === "number" && Number.isSafeInteger(token.value)
    ? { kind: "integer", value: token.value, span: token.span }
    : null;
}

function isValueBoundary(kind: TokenKind): boolean {
  return kind === "comma" || kind === "right_bracket" || kind === "right_paren" ||
    kind === "and" || kind === "or" || EXPRESSION_BOUNDARIES.has(kind);
}

function overlaps(left: SourceSpan, right: SourceSpan): boolean {
  return left.sourceId === right.sourceId &&
    left.start.byteOffset < right.end.byteOffset &&
    right.start.byteOffset < left.end.byteOffset;
}

function describeToken(token: GuardToken): string {
  return token.kind === "eof" ? "end of file" : JSON.stringify(token.lexeme);
}

function compareDiagnostics(left: GuardDiagnostic, right: GuardDiagnostic): number {
  const byOffset = left.span.start.byteOffset - right.span.start.byteOffset;
  if (byOffset !== 0) {
    return byOffset;
  }
  if (left.phase !== right.phase) {
    return left.phase === "lexer" ? -1 : 1;
  }
  return left.code.localeCompare(right.code);
}

function parseOptions(options: GuardParseOptions | undefined): ParsedOptions {
  if (options === undefined) {
    return { sourceId: undefined, maxNesting: DEFAULT_MAX_GUARD_NESTING };
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Guard parser options must be an object.");
  }
  for (const key of Object.keys(options)) {
    if (key !== "sourceId" && key !== "maxNesting") {
      throw new TypeError(`Unknown Guard parser option ${JSON.stringify(key)}.`);
    }
  }
  const sourceId = options.sourceId;
  if (sourceId !== undefined && (typeof sourceId !== "string" || sourceId.length === 0)) {
    throw new TypeError("Guard sourceId must be a non-empty string.");
  }
  const maxNesting = options.maxNesting ?? DEFAULT_MAX_GUARD_NESTING;
  if (
    !Number.isSafeInteger(maxNesting) || maxNesting < 1 ||
    maxNesting > MAX_CONFIGURABLE_GUARD_NESTING
  ) {
    throw new TypeError(
      `Guard maxNesting must be a safe integer from 1 through ${MAX_CONFIGURABLE_GUARD_NESTING}.`,
    );
  }
  return { sourceId, maxNesting };
}

export function parseGuardDocument(
  source: string,
  options?: GuardParseOptions,
): GuardParseResult {
  if (typeof source !== "string") {
    throw new TypeError("Guard source must be a primitive string.");
  }
  const parsedOptions = parseOptions(options);
  const lexed = parsedOptions.sourceId === undefined
    ? lexGuardSource(source)
    : lexGuardSource(source, { sourceId: parsedOptions.sourceId });
  return new GuardParser(
    lexed.tokens,
    lexed.diagnostics,
    parsedOptions.maxNesting,
  ).parse();
}
