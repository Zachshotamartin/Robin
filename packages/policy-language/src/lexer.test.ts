import assert from "node:assert/strict";
import test from "node:test";

import { lexGuardSource } from "./lexer.js";

test("lexer emits the complete v1 vocabulary and decoded values", () => {
  const source = [
    "policy priority when allow deny require_approval reason or and not exists",
    "in matches starts_with true false identifier _x x9",
    "{}()[],. == != 0 42 \"line\\n\\t\\r\\\"\\/\\\\\"",
  ].join("\n");
  const result = lexGuardSource(source, { sourceId: "vocabulary.guard" });

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [
      "policy", "priority", "when", "allow", "deny", "require_approval",
      "reason", "or", "and", "not", "exists", "in", "matches", "starts_with",
      "true", "false", "identifier", "identifier", "identifier", "left_brace",
      "right_brace", "left_paren", "right_paren", "left_bracket", "right_bracket",
      "comma", "dot", "equal_equal", "bang_equal", "integer", "integer", "string",
      "eof",
    ],
  );
  assert.equal(result.tokens.at(-2)?.value, "line\n\t\r\"/\\");
  assert.equal(result.tokens.at(-1)?.span.sourceId, "vocabulary.guard");
});

test("lexer positions are UTF-8 bytes and Unicode-code-point columns", () => {
  const result = lexGuardSource('policy "é😀"\r\npriority', { sourceId: "unicode.guard" });

  assert.deepEqual(result.diagnostics, []);
  const stringToken = result.tokens[1];
  const priorityToken = result.tokens[2];
  assert.equal(stringToken?.kind, "string");
  assert.deepEqual(stringToken?.span, {
    sourceId: "unicode.guard",
    start: { byteOffset: 7, line: 1, column: 8 },
    end: { byteOffset: 15, line: 1, column: 12 },
  });
  assert.deepEqual(priorityToken?.span.start, { byteOffset: 17, line: 2, column: 1 });
});

test("lexer decodes paired surrogate escapes and rejects every unpaired form", () => {
  const result = lexGuardSource(
    '"\\uD83D\\uDE00" "\\uD83D" "\\uDE00" "\\uD83D\\u0041"',
  );

  assert.equal(result.tokens[0]?.value, "😀");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    [
      "GL1005_UNPAIRED_SURROGATE",
      "GL1005_UNPAIRED_SURROGATE",
      "GL1005_UNPAIRED_SURROGATE",
    ],
  );
});

test("lexer rejects invalid escapes, raw controls, malformed numbers, and lone operators", () => {
  const source = '"bad\\q" "bad\\u12G4" "bad\u0001" 01 9007199254740992 = !';
  const result = lexGuardSource(source);

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    [
      "GL1003_INVALID_ESCAPE",
      "GL1004_INVALID_UNICODE_ESCAPE",
      "GL1006_UNESCAPED_CONTROL_CHARACTER",
      "GL1007_INTEGER_LEADING_ZERO",
      "GL1008_INTEGER_OUT_OF_RANGE",
      "GL1001_INVALID_CHARACTER",
      "GL1001_INVALID_CHARACTER",
    ],
  );
});

test("invalid characters advance by one code point and produce independent diagnostics", () => {
  const result = lexGuardSource("💣 @ #");

  assert.equal(result.tokens.length, 1);
  assert.equal(result.tokens[0]?.kind, "eof");
  assert.equal(result.diagnostics.length, 3);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.span.start.column),
    [1, 3, 5],
  );
  assert.deepEqual(result.diagnostics[0]?.span, {
    sourceId: "<memory>",
    start: { byteOffset: 0, line: 1, column: 1 },
    end: { byteOffset: 4, line: 1, column: 2 },
  });
});

test("unterminated strings recover at physical line breaks", () => {
  const result = lexGuardSource('"first\n"second"');

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["GL1002_UNTERMINATED_STRING"],
  );
  assert.deepEqual(
    result.tokens.map((token) => [token.kind, token.value]),
    [
      ["string", "first"],
      ["string", "second"],
      ["eof", null],
    ],
  );
});

test("all lexer output is deeply frozen and invalid runtime inputs fail closed", () => {
  const result = lexGuardSource('policy "frozen"');

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.tokens), true);
  assert.equal(Object.isFrozen(result.tokens[0]), true);
  assert.equal(Object.isFrozen(result.tokens[0]?.span.start), true);
  assert.throws(() => lexGuardSource(42 as unknown as string), TypeError);
  assert.throws(() => lexGuardSource("", { sourceId: "" }), TypeError);
});
