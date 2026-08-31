import assert from "node:assert/strict";
import test from "node:test";

import {
  ProcessToolError,
  parseProcessRequestV1,
} from "./index.js";

function validRequest(): unknown {
  return {
    schemaVersion: 1,
    executable: "node",
    argv: ["-e", "process.stdout.write(process.argv[1])", "$(literal);*.ts"],
    cwd: ".",
    environment: { PROJECT_MODE: "test" },
    timeoutMs: 30_000,
    terminationGraceMs: 500,
    output: {
      retainedHeadBytes: 4_096,
      retainedTailBytes: 4_096,
      absoluteBytes: 65_536,
    },
    stdin: { kind: "closed" },
    intent: "verification",
  };
}

test("parses and deeply freezes an exact direct-process request", () => {
  const parsed = parseProcessRequestV1(validRequest());
  assert.equal(parsed.executable, "node");
  assert.deepEqual(parsed.argv, [
    "-e",
    "process.stdout.write(process.argv[1])",
    "$(literal);*.ts",
  ]);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.argv));
  assert.ok(Object.isFrozen(parsed.environment));
  assert.ok(Object.isFrozen(parsed.output));
  assert.ok(Object.isFrozen(parsed.stdin));
});

test("metacharacters remain literal argv and no shell field is accepted", () => {
  const request = validRequest() as Record<string, unknown>;
  request["shell"] = true;
  assertProcessError(() => parseProcessRequestV1(request), "invalid_request");

  const parsed = parseProcessRequestV1(validRequest());
  assert.equal(parsed.argv[2], "$(literal);*.ts");
});

test("rejects traversal, absolute, drive, UNC, separator-ambiguous, and NUL cwd", () => {
  for (const cwd of [
    "../outside",
    "/tmp",
    "C:/repo",
    "C:\\repo",
    "\\\\server\\share",
    "src\\nested",
    "src//nested",
    "src/./nested",
    "src/../nested",
    "src\u0000nested",
  ]) {
    const request = validRequest() as Record<string, unknown>;
    request["cwd"] = cwd;
    assertProcessError(() => parseProcessRequestV1(request), "invalid_request");
  }
});

test("rejects unknown fields, accessors, sparse argv, and unpaired surrogates", () => {
  const unknown = validRequest() as Record<string, unknown>;
  unknown["unknown"] = true;
  assertProcessError(() => parseProcessRequestV1(unknown), "invalid_request");

  const accessor = validRequest() as Record<string, unknown>;
  Object.defineProperty(accessor, "executable", {
    enumerable: true,
    get: () => "node",
  });
  assertProcessError(() => parseProcessRequestV1(accessor), "invalid_request");

  const sparse = validRequest() as Record<string, unknown>;
  sparse["argv"] = new Array(1);
  assertProcessError(() => parseProcessRequestV1(sparse), "invalid_request");

  const surrogate = validRequest() as Record<string, unknown>;
  surrogate["argv"] = ["\ud800"];
  assertProcessError(() => parseProcessRequestV1(surrogate), "invalid_request");
});

test("supports bounded inline and workspace-file stdin descriptors", () => {
  const inline = validRequest() as Record<string, unknown>;
  inline["stdin"] = { kind: "inline_utf8", text: "hello\n" };
  assert.deepEqual(parseProcessRequestV1(inline).stdin, {
    kind: "inline_utf8",
    text: "hello\n",
  });

  const file = validRequest() as Record<string, unknown>;
  file["stdin"] = {
    kind: "workspace_file",
    path: "fixtures/input.txt",
    expectedSha256: "a".repeat(64),
    maximumBytes: 1024,
  };
  assert.deepEqual(parseProcessRequestV1(file).stdin, {
    kind: "workspace_file",
    path: "fixtures/input.txt",
    expectedSha256: "a".repeat(64),
    maximumBytes: 1024,
  });
});

test("enforces argv, environment, timeout, stdin, and output hard ceilings", () => {
  const tooManyArgs = validRequest() as Record<string, unknown>;
  tooManyArgs["argv"] = Array.from({ length: 257 }, () => "x");
  assertProcessError(() => parseProcessRequestV1(tooManyArgs), "invalid_request");

  const timeout = validRequest() as Record<string, unknown>;
  timeout["timeoutMs"] = 1_800_001;
  assertProcessError(() => parseProcessRequestV1(timeout), "invalid_request");

  const output = validRequest() as Record<string, unknown>;
  output["output"] = {
    retainedHeadBytes: 4 * 1024 * 1024,
    retainedTailBytes: 1,
    absoluteBytes: 64 * 1024 * 1024,
  };
  assertProcessError(() => parseProcessRequestV1(output), "invalid_request");

  const stdin = validRequest() as Record<string, unknown>;
  stdin["stdin"] = { kind: "inline_utf8", text: "x".repeat(1024 * 1024 + 1) };
  assertProcessError(() => parseProcessRequestV1(stdin), "invalid_request");
});

function assertProcessError(
  run: () => unknown,
  code: ProcessToolError["code"],
): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ProcessToolError);
    assert.equal(error.code, code);
    return true;
  });
}
