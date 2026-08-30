import { captureOptionalDataRecord } from "./boundary.js";
import { deepFreeze } from "./immutable.js";
import { DEFAULT_SOURCE_ID, position, span } from "./source.js";
import type {
  GuardDiagnostic,
  GuardLexOptions,
  GuardLexResult,
  GuardToken,
  SourcePosition,
  TokenKind,
  TokenValue,
} from "./types.js";

const KEYWORDS = new Map<string, TokenKind>([
  ["policy", "policy"],
  ["priority", "priority"],
  ["when", "when"],
  ["allow", "allow"],
  ["deny", "deny"],
  ["require_approval", "require_approval"],
  ["reason", "reason"],
  ["or", "or"],
  ["and", "and"],
  ["not", "not"],
  ["exists", "exists"],
  ["in", "in"],
  ["matches", "matches"],
  ["starts_with", "starts_with"],
  ["true", "true"],
  ["false", "false"],
]);

const SINGLE_CHARACTER_TOKENS = new Map<string, TokenKind>([
  ["{", "left_brace"],
  ["}", "right_brace"],
  ["(", "left_paren"],
  [")", "right_paren"],
  ["[", "left_bracket"],
  ["]", "right_bracket"],
  [",", "comma"],
  [".", "dot"],
]);

interface ScannerPosition extends SourcePosition {
  readonly codeUnitOffset: number;
}

interface CodePointView {
  readonly text: string;
  readonly codePoint: number;
  readonly codeUnits: number;
  readonly validScalar: boolean;
}

class Scanner {
  readonly #source: string;
  #codeUnitOffset = 0;
  #byteOffset = 0;
  #line = 1;
  #column = 1;

  constructor(source: string) {
    this.#source = source;
  }

  get done(): boolean {
    return this.#codeUnitOffset >= this.#source.length;
  }

  mark(): ScannerPosition {
    return Object.freeze({
      codeUnitOffset: this.#codeUnitOffset,
      byteOffset: this.#byteOffset,
      line: this.#line,
      column: this.#column,
    });
  }

  peek(codeUnitLookahead = 0): string | undefined {
    return this.#source[this.#codeUnitOffset + codeUnitLookahead];
  }

  peekCodePoint(): CodePointView | undefined {
    if (this.done) {
      return undefined;
    }
    const first = this.#source.charCodeAt(this.#codeUnitOffset);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = this.#source.charCodeAt(this.#codeUnitOffset + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        const codePoint = ((first - 0xd800) * 0x400) + (second - 0xdc00) + 0x10000;
        return Object.freeze({
          text: String.fromCodePoint(codePoint),
          codePoint,
          codeUnits: 2,
          validScalar: true,
        });
      }
      return Object.freeze({
        text: this.#source[this.#codeUnitOffset] ?? "",
        codePoint: first,
        codeUnits: 1,
        validScalar: false,
      });
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      return Object.freeze({
        text: this.#source[this.#codeUnitOffset] ?? "",
        codePoint: first,
        codeUnits: 1,
        validScalar: false,
      });
    }
    return Object.freeze({
      text: this.#source[this.#codeUnitOffset] ?? "",
      codePoint: first,
      codeUnits: 1,
      validScalar: true,
    });
  }

  advanceCodePoint(): CodePointView {
    const viewed = this.peekCodePoint();
    if (viewed === undefined) {
      throw new RangeError("Cannot advance beyond the end of Guard source.");
    }
    if (viewed.text === "\r" || viewed.text === "\n") {
      throw new TypeError("Physical line breaks must be consumed with advanceLineBreak().");
    }
    this.#codeUnitOffset += viewed.codeUnits;
    this.#byteOffset += Buffer.byteLength(viewed.text, "utf8");
    this.#column += 1;
    return viewed;
  }

  advanceLineBreak(): void {
    const first = this.peek();
    if (first !== "\r" && first !== "\n") {
      throw new TypeError("advanceLineBreak() requires CR or LF.");
    }
    if (first === "\r" && this.peek(1) === "\n") {
      this.#codeUnitOffset += 2;
      this.#byteOffset += 2;
    } else {
      this.#codeUnitOffset += 1;
      this.#byteOffset += 1;
    }
    this.#line += 1;
    this.#column = 1;
  }

  slice(start: ScannerPosition, end: ScannerPosition): string {
    return this.#source.slice(start.codeUnitOffset, end.codeUnitOffset);
  }
}

class GuardLexer {
  readonly #scanner: Scanner;
  readonly #sourceId: string;
  readonly #tokens: GuardToken[] = [];
  readonly #diagnostics: GuardDiagnostic[] = [];

  constructor(source: string, sourceId: string) {
    this.#scanner = new Scanner(source);
    this.#sourceId = sourceId;
  }

  scan(): GuardLexResult {
    while (!this.#scanner.done) {
      const current = this.#scanner.peekCodePoint();
      if (current === undefined) {
        break;
      }
      if (current.text === " " || current.text === "\t") {
        this.#scanner.advanceCodePoint();
        continue;
      }
      if (current.text === "\r" || current.text === "\n") {
        this.#scanner.advanceLineBreak();
        continue;
      }
      if (current.text === '"') {
        this.#scanString();
        continue;
      }
      if (isIdentifierStart(current.text)) {
        this.#scanIdentifier();
        continue;
      }
      if (isDigit(current.text)) {
        this.#scanInteger();
        continue;
      }
      const singleKind = SINGLE_CHARACTER_TOKENS.get(current.text);
      if (singleKind !== undefined) {
        const start = this.#scanner.mark();
        this.#scanner.advanceCodePoint();
        this.#emit(singleKind, start, null);
        continue;
      }
      if (current.text === "=" || current.text === "!") {
        this.#scanEqualityOperator();
        continue;
      }
      const start = this.#scanner.mark();
      this.#scanner.advanceCodePoint();
      this.#diagnose(
        current.validScalar ? "GL1001_INVALID_CHARACTER" : "GL1009_INVALID_UNICODE_SCALAR",
        current.validScalar
          ? `Invalid character ${quotedCodePoint(current.text)}.`
          : "Source contains an unpaired UTF-16 surrogate.",
        start,
      );
    }

    const eof = this.#scanner.mark();
    this.#tokens.push(
      Object.freeze({
        kind: "eof",
        lexeme: "",
        value: null,
        span: this.#sourceSpan(eof, eof),
      }),
    );
    return deepFreeze({
      tokens: this.#tokens,
      diagnostics: this.#diagnostics,
    });
  }

  #scanIdentifier(): void {
    const start = this.#scanner.mark();
    while (true) {
      const current = this.#scanner.peekCodePoint();
      if (current === undefined || !isIdentifierContinue(current.text)) {
        break;
      }
      this.#scanner.advanceCodePoint();
    }
    const end = this.#scanner.mark();
    const lexeme = this.#scanner.slice(start, end);
    const kind = KEYWORDS.get(lexeme) ?? "identifier";
    let value: TokenValue = kind === "identifier" ? lexeme : null;
    if (kind === "true") {
      value = true;
    } else if (kind === "false") {
      value = false;
    }
    this.#tokens.push(
      Object.freeze({ kind, lexeme, value, span: this.#sourceSpan(start, end) }),
    );
  }

  #scanInteger(): void {
    const start = this.#scanner.mark();
    while (true) {
      const current = this.#scanner.peekCodePoint();
      if (current === undefined || !isDigit(current.text)) {
        break;
      }
      this.#scanner.advanceCodePoint();
    }
    const end = this.#scanner.mark();
    const lexeme = this.#scanner.slice(start, end);
    if (lexeme.length > 1 && lexeme.startsWith("0")) {
      this.#diagnose(
        "GL1007_INTEGER_LEADING_ZERO",
        "Integer literals must not contain leading zeroes.",
        start,
        end,
      );
    }
    const value = Number(lexeme);
    if (!Number.isSafeInteger(value)) {
      this.#diagnose(
        "GL1008_INTEGER_OUT_OF_RANGE",
        "Integer literal exceeds the JavaScript safe-integer range.",
        start,
        end,
      );
    }
    this.#tokens.push(
      Object.freeze({
        kind: "integer",
        lexeme,
        value,
        span: this.#sourceSpan(start, end),
      }),
    );
  }

  #scanEqualityOperator(): void {
    const start = this.#scanner.mark();
    const first = this.#scanner.advanceCodePoint().text;
    if (this.#scanner.peek() === "=") {
      this.#scanner.advanceCodePoint();
      this.#emit(first === "=" ? "equal_equal" : "bang_equal", start, null);
      return;
    }
    this.#diagnose(
      "GL1001_INVALID_CHARACTER",
      `${quotedCodePoint(first)} is not an operator; use ${first === "=" ? '"=="' : '"!="'}.`,
      start,
    );
  }

  #scanString(): void {
    const start = this.#scanner.mark();
    this.#scanner.advanceCodePoint();
    let decoded = "";
    let terminated = false;

    while (!this.#scanner.done) {
      const current = this.#scanner.peekCodePoint();
      if (current === undefined) {
        break;
      }
      if (current.text === '"') {
        this.#scanner.advanceCodePoint();
        terminated = true;
        break;
      }
      if (current.text === "\r" || current.text === "\n") {
        break;
      }
      if (current.text === "\\") {
        decoded += this.#scanEscape();
        continue;
      }
      const characterStart = this.#scanner.mark();
      this.#scanner.advanceCodePoint();
      if (!current.validScalar) {
        this.#diagnose(
          "GL1009_INVALID_UNICODE_SCALAR",
          "String contains an unpaired UTF-16 surrogate.",
          characterStart,
        );
        decoded += "�";
        continue;
      }
      if (isControlCodePoint(current.codePoint)) {
        this.#diagnose(
          "GL1006_UNESCAPED_CONTROL_CHARACTER",
          "Control characters in strings must use an escape sequence.",
          characterStart,
        );
        continue;
      }
      decoded += current.text;
    }

    if (!terminated) {
      this.#diagnose(
        "GL1002_UNTERMINATED_STRING",
        "String literal is missing a closing double quote before the line ends.",
        start,
      );
    }
    this.#emit("string", start, decoded);
  }

  #scanEscape(): string {
    const start = this.#scanner.mark();
    this.#scanner.advanceCodePoint();
    const escaped = this.#scanner.peekCodePoint();
    if (escaped === undefined || escaped.text === "\r" || escaped.text === "\n") {
      this.#diagnose(
        "GL1003_INVALID_ESCAPE",
        "A backslash at the end of a string must introduce a supported escape.",
        start,
      );
      return "";
    }

    const simpleEscapes: Readonly<Record<string, string>> = Object.freeze({
      '"': '"',
      "/": "/",
      "\\": "\\",
      n: "\n",
      r: "\r",
      t: "\t",
    });
    const simple = simpleEscapes[escaped.text];
    if (simple !== undefined) {
      this.#scanner.advanceCodePoint();
      return simple;
    }
    if (escaped.text !== "u") {
      this.#scanner.advanceCodePoint();
      this.#diagnose(
        "GL1003_INVALID_ESCAPE",
        `Unsupported escape sequence "\\${escaped.text}".`,
        start,
      );
      return escaped.validScalar ? escaped.text : "�";
    }

    this.#scanner.advanceCodePoint();
    const firstDigits = this.#consumeFourHexDigits();
    if (firstDigits === null) {
      this.#diagnose(
        "GL1004_INVALID_UNICODE_ESCAPE",
        "Unicode escapes require exactly four hexadecimal digits.",
        start,
      );
      return "�";
    }
    const first = Number.parseInt(firstDigits, 16);
    if (first >= 0xd800 && first <= 0xdbff) {
      const secondEscapeStart = this.#scanner.mark();
      if (this.#scanner.peek() === "\\" && this.#scanner.peek(1) === "u") {
        this.#scanner.advanceCodePoint();
        this.#scanner.advanceCodePoint();
        const secondDigits = this.#consumeFourHexDigits();
        if (secondDigits !== null) {
          const second = Number.parseInt(secondDigits, 16);
          if (second >= 0xdc00 && second <= 0xdfff) {
            return String.fromCodePoint(
              ((first - 0xd800) * 0x400) + (second - 0xdc00) + 0x10000,
            );
          }
        }
        this.#diagnose(
          "GL1005_UNPAIRED_SURROGATE",
          "A high-surrogate escape must be followed by a low-surrogate escape.",
          start,
        );
        return "�";
      }
      this.#diagnose(
        "GL1005_UNPAIRED_SURROGATE",
        "A high-surrogate escape must be followed by a low-surrogate escape.",
        start,
        secondEscapeStart,
      );
      return "�";
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      this.#diagnose(
        "GL1005_UNPAIRED_SURROGATE",
        "A low-surrogate escape cannot appear without a preceding high surrogate.",
        start,
      );
      return "�";
    }
    return String.fromCodePoint(first);
  }

  #consumeFourHexDigits(): string | null {
    let digits = "";
    for (let index = 0; index < 4; index += 1) {
      const current = this.#scanner.peekCodePoint();
      if (current === undefined || !isHexDigit(current.text)) {
        return null;
      }
      digits += this.#scanner.advanceCodePoint().text;
    }
    return digits;
  }

  #emit(kind: TokenKind, start: ScannerPosition, value: TokenValue): void {
    const end = this.#scanner.mark();
    this.#tokens.push(
      Object.freeze({
        kind,
        lexeme: this.#scanner.slice(start, end),
        value,
        span: this.#sourceSpan(start, end),
      }),
    );
  }

  #diagnose(
    code: string,
    message: string,
    start: ScannerPosition,
    explicitEnd?: ScannerPosition,
  ): void {
    const current = this.#scanner.mark();
    const end = explicitEnd ??
      (current.codeUnitOffset === start.codeUnitOffset ? current : current);
    this.#diagnostics.push(
      Object.freeze({
        severity: "error",
        phase: "lexer",
        code,
        message,
        span: this.#sourceSpan(start, end),
      }),
    );
  }

  #sourceSpan(start: ScannerPosition, end: ScannerPosition) {
    return span(
      this.#sourceId,
      position(start.byteOffset, start.line, start.column),
      position(end.byteOffset, end.line, end.column),
    );
  }
}

function isIdentifierStart(character: string): boolean {
  return /^[A-Za-z_]$/.test(character);
}

function isIdentifierContinue(character: string): boolean {
  return /^[A-Za-z0-9_]$/.test(character);
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isHexDigit(character: string): boolean {
  return /^[0-9A-Fa-f]$/.test(character);
}

function isControlCodePoint(codePoint: number): boolean {
  return (codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function quotedCodePoint(character: string): string {
  const codePoint = character.codePointAt(0);
  const label = codePoint === undefined
    ? "unknown"
    : `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  return `${JSON.stringify(character)} (${label})`;
}

function parseOptions(options: GuardLexOptions | undefined): string {
  if (options === undefined) {
    return DEFAULT_SOURCE_ID;
  }
  const captured = captureOptionalDataRecord(
    options,
    ["sourceId"],
    "Guard lexer options",
  );
  const sourceId = captured["sourceId"] ?? DEFAULT_SOURCE_ID;
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw new TypeError("Guard sourceId must be a non-empty string.");
  }
  return sourceId;
}

export function lexGuardSource(
  source: string,
  options?: GuardLexOptions,
): GuardLexResult {
  if (typeof source !== "string") {
    throw new TypeError("Guard source must be a primitive string.");
  }
  return new GuardLexer(source, parseOptions(options)).scan();
}
