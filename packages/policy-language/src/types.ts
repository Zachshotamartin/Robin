export const GUARD_LANGUAGE_VERSION = "1" as const;

export interface SourcePosition {
  /** Zero-based byte offset in the UTF-8 encoding of the source. */
  readonly byteOffset: number;
  /** One-based physical line. CRLF is one line break. */
  readonly line: number;
  /** One-based Unicode-code-point column. */
  readonly column: number;
}

export interface SourceSpan {
  readonly sourceId: string;
  /** Inclusive start position. */
  readonly start: SourcePosition;
  /** Exclusive end position. */
  readonly end: SourcePosition;
}

export type GuardDiagnosticPhase = "lexer" | "parser";

export interface GuardDiagnostic {
  readonly severity: "error";
  readonly phase: GuardDiagnosticPhase;
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

export const TOKEN_KINDS = Object.freeze([
  "identifier",
  "string",
  "integer",
  "policy",
  "priority",
  "when",
  "allow",
  "deny",
  "require_approval",
  "reason",
  "or",
  "and",
  "not",
  "exists",
  "in",
  "matches",
  "starts_with",
  "true",
  "false",
  "left_brace",
  "right_brace",
  "left_paren",
  "right_paren",
  "left_bracket",
  "right_bracket",
  "comma",
  "dot",
  "equal_equal",
  "bang_equal",
  "eof",
] as const);

export type TokenKind = (typeof TOKEN_KINDS)[number];
export type TokenValue = string | number | boolean | null;

export interface GuardToken {
  readonly kind: TokenKind;
  /** Exact source text; strings include their double quotes. */
  readonly lexeme: string;
  /** Decoded strings, safe integers, booleans, or null for structural tokens. */
  readonly value: TokenValue;
  readonly span: SourceSpan;
}

export interface GuardLexOptions {
  readonly sourceId?: string;
}

export interface GuardParseOptions extends GuardLexOptions {
  /** Maximum nested parentheses, `not` expressions, and lists. */
  readonly maxNesting?: number;
}

export interface GuardLexResult {
  readonly tokens: readonly GuardToken[];
  readonly diagnostics: readonly GuardDiagnostic[];
}

export type PolicyEffect = "allow" | "deny" | "require_approval";
export type ComparisonOperator =
  | "=="
  | "!="
  | "in"
  | "matches"
  | "starts_with";
export type LogicalOperator = "and" | "or";

export interface StringLiteral {
  readonly kind: "string";
  readonly value: string;
  readonly span: SourceSpan;
}

export interface IntegerLiteral {
  readonly kind: "integer";
  readonly value: number;
  readonly span: SourceSpan;
}

export interface BooleanLiteral {
  readonly kind: "boolean";
  readonly value: boolean;
  readonly span: SourceSpan;
}

export interface ListLiteral {
  readonly kind: "list";
  readonly items: readonly PolicyValue[];
  readonly span: SourceSpan;
}

export type ScalarLiteral = StringLiteral | IntegerLiteral | BooleanLiteral;
export type PolicyValue = ScalarLiteral | ListLiteral;

export interface AttributeExpression {
  readonly kind: "attribute";
  readonly path: readonly string[];
  readonly span: SourceSpan;
}

export interface ComparisonExpression {
  readonly kind: "comparison";
  readonly left: AttributeExpression;
  readonly operator: ComparisonOperator;
  readonly right: PolicyValue;
  readonly span: SourceSpan;
}

export interface ExistsExpression {
  readonly kind: "exists";
  readonly attribute: AttributeExpression;
  readonly span: SourceSpan;
}

export interface NotExpression {
  readonly kind: "not";
  readonly operand: Expression;
  readonly span: SourceSpan;
}

export interface LogicalExpression {
  readonly kind: "logical";
  readonly operator: LogicalOperator;
  readonly left: Expression;
  readonly right: Expression;
  readonly span: SourceSpan;
}

export interface GroupExpression {
  readonly kind: "group";
  readonly expression: Expression;
  readonly span: SourceSpan;
}

export type Expression =
  | ComparisonExpression
  | ExistsExpression
  | NotExpression
  | LogicalExpression
  | GroupExpression;

export interface PolicyEffectNode {
  readonly kind: "effect";
  readonly value: PolicyEffect;
  readonly span: SourceSpan;
}

export interface PolicyRule {
  readonly kind: "policy";
  readonly name: StringLiteral;
  readonly priority: IntegerLiteral;
  readonly condition: Expression;
  readonly effect: PolicyEffectNode;
  readonly reason: StringLiteral;
  readonly span: SourceSpan;
}

export interface GuardDocument {
  readonly kind: "document";
  readonly languageVersion: typeof GUARD_LANGUAGE_VERSION;
  readonly policies: readonly PolicyRule[];
  readonly span: SourceSpan;
}

export interface GuardParseResult {
  /** True only when both lexing and parsing produced no diagnostics. */
  readonly ok: boolean;
  /** Contains every completely parsed rule; incomplete rules are omitted. */
  readonly document: GuardDocument;
  readonly tokens: readonly GuardToken[];
  readonly diagnostics: readonly GuardDiagnostic[];
}
