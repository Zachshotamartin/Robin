export { formatGuardDocument } from "./formatter.js";
export { lexGuardSource } from "./lexer.js";
export {
  DEFAULT_MAX_GUARD_NESTING,
  GUARD_BINDING_POWERS,
  MAX_CONFIGURABLE_GUARD_NESTING,
  parseGuardDocument,
} from "./parser.js";
export { projectGuardDocumentSemantics } from "./semantics.js";
export type { GuardSemanticProjection } from "./semantics.js";
export {
  GUARD_LANGUAGE_VERSION,
  TOKEN_KINDS,
} from "./types.js";
export type {
  AttributeExpression,
  BooleanLiteral,
  ComparisonExpression,
  ComparisonOperator,
  ExistsExpression,
  Expression,
  GroupExpression,
  GuardDiagnostic,
  GuardDiagnosticPhase,
  GuardDocument,
  GuardLexOptions,
  GuardLexResult,
  GuardParseOptions,
  GuardParseResult,
  GuardToken,
  IntegerLiteral,
  ListLiteral,
  LogicalExpression,
  LogicalOperator,
  NotExpression,
  PolicyEffect,
  PolicyEffectNode,
  PolicyRule,
  PolicyValue,
  ScalarLiteral,
  SourcePosition,
  SourceSpan,
  StringLiteral,
  TokenKind,
  TokenValue,
} from "./types.js";
