import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import deterministicTestReporter, {
  REPORTER_FORMAT,
  REPORTER_LIMITS,
  REPORTER_VERSION,
  REPOSITORY_ROOT,
  createDeterministicTestReporter,
} from "./deterministic-test-reporter.mjs";

const reporterPath = fileURLToPath(
  new URL("./deterministic-test-reporter.mjs", import.meta.url),
);

async function collect(reporter, events) {
  let output = "";
  for await (const chunk of reporter(events)) output += chunk;
  return output;
}

function passEvent(file, name, duration) {
  return {
    type: "test:pass",
    data: {
      file,
      line: 10,
      column: 3,
      nesting: 0,
      testNumber: 1,
      name,
      details: { type: "test", duration_ms: duration },
    },
  };
}

function fileSummaryEvent(file, duration) {
  return {
    type: "test:summary",
    data: {
      file,
      duration_ms: duration,
      success: true,
      counts: {
        tests: 1,
        failed: 0,
        passed: 1,
        cancelled: 0,
        skipped: 0,
        todo: 0,
        topLevel: 1,
        suites: 0,
      },
    },
  };
}

function globalSummaryEvent(duration, success = true) {
  return {
    type: "test:summary",
    data: {
      duration_ms: duration,
      success,
      counts: {
        tests: 2,
        failed: success ? 0 : 1,
        passed: success ? 2 : 1,
        cancelled: 0,
        skipped: 0,
        todo: 0,
        topLevel: 2,
        suites: 0,
      },
    },
  };
}

function makeAssertionFailure(file, internalFrame, reverseActualKeys = false) {
  const actual = reverseActualKeys ? { a: 1, b: 2 } : { b: 2, a: 1 };
  const cause = new Error("objects differ");
  cause.name = "AssertionError";
  cause.code = "ERR_ASSERTION";
  cause.actual = actual;
  cause.expected = { a: 1, b: 3 };
  cause.operator = "deepStrictEqual";
  cause.generatedMessage = true;
  cause.stack = [
    "AssertionError [ERR_ASSERTION]: objects differ",
    `    at TestContext.<anonymous> (${pathToFileURL(file).href}:10:3)`,
    internalFrame,
  ].join("\n");

  const wrapper = new Error("objects differ", { cause });
  wrapper.code = "ERR_TEST_FAILURE";
  wrapper.failureType = "testCodeFailure";
  wrapper.stack = [
    "Error [ERR_TEST_FAILURE]: objects differ",
    "    at Test.run (node:internal/test_runner/test:1000:1)",
  ].join("\n");
  return wrapper;
}

function failEvent(file, error, duration = 1) {
  return {
    type: "test:fail",
    data: {
      file,
      line: 10,
      column: 3,
      nesting: 0,
      testNumber: 1,
      name: "structured failure",
      details: { type: "test", duration_ms: duration, error },
    },
  };
}

test("exports fixed production limits and derives the repository root from its module", () => {
  assert.deepEqual(REPORTER_LIMITS, {
    maxEvents: 100_000,
    maxBufferedBytes: 64 * 1024 * 1024,
  });
  assert.equal(REPORTER_FORMAT, "robin-node-test-report");
  assert.equal(REPORTER_VERSION, 1);
  assert.equal(
    REPOSITORY_ROOT,
    path.resolve(fileURLToPath(new URL("../", import.meta.url))),
  );
});

test("cross-file scheduling and timing changes produce exact replay output", async () => {
  const firstFile = path.join(REPOSITORY_ROOT, "scripts", "a-fixture.test.mjs");
  const secondFile = path.join(REPOSITORY_ROOT, "scripts", "z-fixture.test.mjs");
  const firstRun = [
    passEvent(secondFile, "second file", 1.25),
    passEvent(firstFile, "first file", 8.5),
    {
      type: "test:stdout",
      data: { file: secondFile, message: "second file output\n" },
    },
    {
      type: "test:diagnostic",
      data: {
        file: firstFile,
        line: 10,
        column: 3,
        nesting: 0,
        level: "info",
        message: "first file diagnostic",
      },
    },
    fileSummaryEvent(firstFile, 12.25),
    fileSummaryEvent(secondFile, 3.75),
    {
      type: "test:diagnostic",
      data: { nesting: 0, level: "info", message: "duration_ms 19.125" },
    },
    globalSummaryEvent(19.125),
  ];
  const secondRun = [
    passEvent(firstFile, "first file", 90.75),
    {
      type: "test:diagnostic",
      data: {
        file: firstFile,
        line: 10,
        column: 3,
        nesting: 0,
        level: "info",
        message: "first file diagnostic",
      },
    },
    passEvent(secondFile, "second file", 0.125),
    {
      type: "test:stdout",
      data: { file: secondFile, message: "second file output\n" },
    },
    fileSummaryEvent(secondFile, 0.5),
    fileSummaryEvent(firstFile, 100.25),
    {
      type: "test:diagnostic",
      data: { nesting: 0, level: "info", message: "duration_ms 101.875" },
    },
    globalSummaryEvent(101.875),
  ];

  const firstOutput = await collect(deterministicTestReporter, firstRun);
  const secondOutput = await collect(deterministicTestReporter, secondRun);
  assert.equal(firstOutput, secondOutput);
  assert.match(firstOutput, /"name":"first file"/u);
  assert.match(firstOutput, /"name":"second file"/u);
  assert.match(firstOutput, /"message":"second file output\\n"/u);
  assert.match(firstOutput, /duration_ms <nondeterministic>/u);
  assert.doesNotMatch(firstOutput, /"duration_ms":/u);
  assert.ok(
    firstOutput.indexOf('"file":"scripts/a-fixture.test.mjs"') <
      firstOutput.indexOf('"file":"scripts/z-fixture.test.mjs"'),
  );
});

test("coverage file and detail set ordering produces exact replay output", async () => {
  const firstFile = path.join(REPOSITORY_ROOT, "scripts", "coverage-a.mjs");
  const secondFile = path.join(REPOSITORY_ROOT, "scripts", "coverage-z.mjs");
  const coverageFile = (file, reverse) => {
    const functions = [
      { name: "alpha", line: 1, count: 1 },
      { name: "zeta", line: 9, count: 0 },
    ];
    const branches = [
      { line: 2, branch: 0, count: 1 },
      { line: 2, branch: 1, count: 0 },
    ];
    const lines = [
      { line: 1, count: 1 },
      { line: 9, count: 0 },
    ];
    return {
      path: file,
      functions: reverse ? functions.reverse() : functions,
      branches: reverse ? branches.reverse() : branches,
      lines: reverse ? lines.reverse() : lines,
    };
  };
  const event = (reverse) => {
    const files = [
      coverageFile(firstFile, reverse),
      coverageFile(secondFile, reverse),
    ];
    return {
      type: "test:coverage",
      data: {
        summary: {
          files: reverse ? files.reverse() : files,
          totals: { coveredLineCount: 2, totalLineCount: 4 },
        },
      },
    };
  };

  const first = await collect(deterministicTestReporter, [event(false)]);
  const second = await collect(deterministicTestReporter, [event(true)]);
  assert.equal(first, second);
  assert.match(first, /"type":"coverage"/u);
  assert.doesNotMatch(first, new RegExp(REPOSITORY_ROOT.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("per-file stream ordering remains observable", async () => {
  const file = path.join(REPOSITORY_ROOT, "scripts", "stream-fixture.test.mjs");
  const ordered = [
    { type: "test:stdout", data: { file, message: "first\n" } },
    { type: "test:stdout", data: { file, message: "second\n" } },
  ];
  const reversed = [
    { type: "test:stdout", data: { file, message: "second\n" } },
    { type: "test:stdout", data: { file, message: "first\n" } },
  ];
  assert.notEqual(
    await collect(deterministicTestReporter, ordered),
    await collect(deterministicTestReporter, reversed),
  );
});

test("semantic CR, LF, and CRLF differences remain observable", async () => {
  const file = path.join(REPOSITORY_ROOT, "scripts", "line-ending-fixture.test.mjs");
  const crlfStream = await collect(deterministicTestReporter, [
    { type: "test:stdout", data: { file, message: "alpha\r\nbeta\r" } },
  ]);
  const lfStream = await collect(deterministicTestReporter, [
    { type: "test:stdout", data: { file, message: "alpha\nbeta\n" } },
  ]);
  assert.notEqual(crlfStream, lfStream);
  assert.match(crlfStream, /alpha\\r\\nbeta\\r/u);
  assert.match(lfStream, /alpha\\nbeta\\n/u);

  const firstError = makeAssertionFailure(
    file,
    "    at Test.run (node:internal/test_runner/test:1000:1)",
  );
  firstError.cause.actual = "alpha\r\nbeta";
  firstError.cause.expected = "alpha\nbeta";
  const secondError = makeAssertionFailure(
    file,
    "    at Test.run (node:internal/test_runner/test:1000:1)",
  );
  secondError.cause.actual = "alpha\nbeta";
  secondError.cause.expected = "alpha\r\nbeta";
  assert.notEqual(
    await collect(deterministicTestReporter, [failEvent(file, firstError)]),
    await collect(deterministicTestReporter, [failEvent(file, secondError)]),
  );
});

test("repository identities normalize anywhere without hiding optional test IDs", async () => {
  const file = path.join(REPOSITORY_ROOT, "scripts", "identity-fixture.test.mjs");
  const event = passEvent(file, "identity", 1);
  event.data.testId = 2;
  event.data.parentId = 1;
  const output = await collect(deterministicTestReporter, [
    event,
    {
      type: "test:diagnostic",
      data: {
        nesting: 0,
        message: `repository root is ${REPOSITORY_ROOT}.`,
      },
    },
  ]);
  assert.match(output, /"testId":2/u);
  assert.match(output, /"parentId":1/u);
  assert.match(output, /repository root is <repo>\./u);
  assert.equal(output.includes(REPOSITORY_ROOT), false);
});

test("ambiguous checkout-identity prefixes fail closed instead of collapsing semantic text", async () => {
  await assert.rejects(
    collect(deterministicTestReporter, [
      {
        type: "test:diagnostic",
        data: {
          nesting: 0,
          message: `semantic token ${REPOSITORY_ROOT}-variant`,
        },
      },
    ]),
    (error) => {
      assert.equal(error.code, "ERR_ROBIN_TEST_REPORTER_AMBIGUOUS_PATH");
      return true;
    },
  );
});

test("external absolute stack-frame paths fail closed without leaking the path", async () => {
  const file = path.join(REPOSITORY_ROOT, "scripts", "external-stack.test.mjs");
  const error = makeAssertionFailure(
    file,
    "    at Test.run (node:internal/test_runner/test:1000:1)",
  );
  error.cause.stack = [
    "AssertionError [ERR_ASSERTION]: objects differ",
    "    at generated (/private/tmp/robin-secret-123/generated.mjs:1:2)",
  ].join("\n");
  await assert.rejects(
    collect(deterministicTestReporter, [failEvent(file, error)]),
    (failure) => {
      assert.equal(failure.code, "ERR_ROBIN_TEST_REPORTER_EXTERNAL_PATH");
      assert.doesNotMatch(failure.message, /robin-secret-123/u);
      return true;
    },
  );
});

test("failure diagnostics are structured and ignore variable Node internal frames", async () => {
  const file = path.join(
    REPOSITORY_ROOT,
    "scripts",
    "failure-fixture.test.mjs",
  );
  const firstError = makeAssertionFailure(
    file,
    "    at node:internal/test_runner/test:1000:1",
    false,
  );
  const secondError = makeAssertionFailure(
    file,
    "    at async Test.processPendingSubtests (node:internal/test_runner/test:700:7)",
    true,
  );

  const firstOutput = await collect(deterministicTestReporter, [
    failEvent(file, firstError, 1.125),
  ]);
  const secondOutput = await collect(deterministicTestReporter, [
    failEvent(file, secondError, 900.875),
  ]);

  assert.equal(firstOutput, secondOutput);
  assert.match(firstOutput, /"status":"fail"/u);
  assert.match(firstOutput, /"code":"ERR_TEST_FAILURE"/u);
  assert.match(firstOutput, /"code":"ERR_ASSERTION"/u);
  assert.match(firstOutput, /"operator":"deepStrictEqual"/u);
  assert.match(
    firstOutput,
    /"actual":\{"\$type":"Object","\$id":\d+,"properties":\{"a":1,"b":2\}\}/u,
  );
  assert.match(
    firstOutput,
    /"expected":\{"\$type":"Object","\$id":\d+,"properties":\{"a":1,"b":3\}\}/u,
  );
  assert.match(
    firstOutput,
    /file:\/\/<repo>\/scripts\/failure-fixture\.test\.mjs:10:3/u,
  );
  assert.match(firstOutput, /node-internal-frames-omitted-v1/u);
  assert.doesNotMatch(firstOutput, /node:internal/u);
  assert.doesNotMatch(firstOutput, /processTicksAndRejections/u);
  assert.doesNotMatch(firstOutput, /"duration_ms":/u);
});

test("structured serialization distinguishes tags, negative zero, and array holes", async () => {
  const file = path.join(REPOSITORY_ROOT, "scripts", "collision-fixture.test.mjs");
  const outputFor = async (actual) => {
    const error = makeAssertionFailure(
      file,
      "    at Test.run (node:internal/test_runner/test:1000:1)",
    );
    error.cause.actual = actual;
    return collect(deterministicTestReporter, [failEvent(file, error)]);
  };

  assert.notEqual(await outputFor(undefined), await outputFor({ $type: "undefined" }));
  assert.notEqual(await outputFor(-0), await outputFor(0));
  assert.notEqual(await outputFor([, "value"]), await outputFor([null, "value"]));
  const shared = Symbol("same-description");
  assert.notEqual(
    await outputFor([shared, shared]),
    await outputFor([Symbol("same-description"), Symbol("same-description")]),
  );
  const firstKey = Symbol("duplicate-description");
  const secondKey = Symbol("duplicate-description");
  await assert.rejects(
    outputFor({ [firstKey]: 1, [secondKey]: 2 }),
    (failure) => {
      assert.equal(failure.code, "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE");
      return true;
    },
  );
  const arrayWithExtra = [1];
  arrayWithExtra.extra = "semantic-extra";
  await assert.rejects(outputFor(arrayWithExtra), (failure) => {
    assert.equal(failure.code, "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE");
    return true;
  });
});

test("Error and Function accessors fail closed without invoking user callbacks", async () => {
  const file = path.join(REPOSITORY_ROOT, "scripts", "accessor-fixture.test.mjs");
  for (const key of ["name", "message", "stack", "cause"]) {
    const error = makeAssertionFailure(
      file,
      "    at Test.run (node:internal/test_runner/test:1000:1)",
    );
    let calls = 0;
    Object.defineProperty(error.cause, key, {
      configurable: true,
      get() {
        calls += 1;
        return "callback result";
      },
    });
    await assert.rejects(
      collect(deterministicTestReporter, [failEvent(file, error)]),
      (failure) => {
        assert.equal(failure.code, "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE");
        return true;
      },
    );
    assert.equal(calls, 0, `${key} getter was invoked`);
  }

  const coerciveError = makeAssertionFailure(
    file,
    "    at Test.run (node:internal/test_runner/test:1000:1)",
  );
  let coercions = 0;
  coerciveError.cause.message = {
    toString() {
      coercions += 1;
      return "callback result";
    },
  };
  await assert.rejects(
    collect(deterministicTestReporter, [failEvent(file, coerciveError)]),
    (failure) => {
      assert.equal(failure.code, "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE");
      return true;
    },
  );
  assert.equal(coercions, 0);

  const functionError = makeAssertionFailure(
    file,
    "    at Test.run (node:internal/test_runner/test:1000:1)",
  );
  let functionNameReads = 0;
  const callback = function namedCallback() {};
  Object.defineProperty(callback, "name", {
    configurable: true,
    get() {
      functionNameReads += 1;
      return "callback result";
    },
  });
  functionError.cause.actual = callback;
  await assert.rejects(
    collect(deterministicTestReporter, [failEvent(file, functionError)]),
    (failure) => {
      assert.equal(failure.code, "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE");
      return true;
    },
  );
  assert.equal(functionNameReads, 0);
});

test("RegExp lastIndex remains bounded, normalized, and type-stable", async () => {
  const file = path.join(REPOSITORY_ROOT, "scripts", "regexp-fixture.test.mjs");
  const outputFor = async (actual) => {
    const error = makeAssertionFailure(
      file,
      "    at Test.run (node:internal/test_runner/test:1000:1)",
    );
    error.cause.actual = actual;
    return collect(deterministicTestReporter, [failEvent(file, error)]);
  };

  const positiveZero = /x/g;
  positiveZero.lastIndex = 0;
  const negativeZero = /x/g;
  negativeZero.lastIndex = -0;
  assert.notEqual(await outputFor(positiveZero), await outputFor(negativeZero));

  const bigintIndex = /x/g;
  bigintIndex.lastIndex = 1n;
  assert.match(await outputFor(bigintIndex), /"lastIndex":\{"\$type":"bigint","value":"1"\}/u);

  const pathIndex = /x/g;
  pathIndex.lastIndex = { checkout: REPOSITORY_ROOT };
  const normalized = await outputFor(pathIndex);
  assert.match(normalized, /"checkout":"<repo>"/u);
  assert.equal(normalized.includes(REPOSITORY_ROOT), false);

  const cyclicIndex = /x/g;
  cyclicIndex.lastIndex = cyclicIndex;
  assert.match(await outputFor(cyclicIndex), /"lastIndex":\{"\$ref":\d+\}/u);
});

test("symbol payloads normalize checkout identities and encoded regex paths fail closed", async () => {
  const file = path.join(REPOSITORY_ROOT, "scripts", "text-payload.test.mjs");
  const symbolError = makeAssertionFailure(
    file,
    "    at Test.run (node:internal/test_runner/test:1000:1)",
  );
  symbolError.cause.actual = Symbol(REPOSITORY_ROOT);
  const symbolOutput = await collect(deterministicTestReporter, [
    failEvent(file, symbolError),
  ]);
  assert.match(
    symbolOutput,
    /"\$type":"symbol","\$id":\d+,"value":"<repo>"/u,
  );
  assert.equal(symbolOutput.includes(REPOSITORY_ROOT), false);

  const regexError = makeAssertionFailure(
    file,
    "    at Test.run (node:internal/test_runner/test:1000:1)",
  );
  regexError.cause.actual = new RegExp(REPOSITORY_ROOT, "u");
  await assert.rejects(
    collect(deterministicTestReporter, [failEvent(file, regexError)]),
    (failure) => {
      assert.equal(failure.code, "ERR_ROBIN_TEST_REPORTER_AMBIGUOUS_PATH");
      assert.doesNotMatch(failure.message, new RegExp(REPOSITORY_ROOT.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      return true;
    },
  );
});

test("a failed top-level file completion retains its failure", async () => {
  const file = path.join(REPOSITORY_ROOT, "scripts", "invalid-file.test.mjs");
  const error = new SyntaxError("Unexpected token");
  error.code = "ERR_TEST_FAILURE";
  error.stack = [
    "SyntaxError: Unexpected token",
    `    at ${pathToFileURL(file).href}:1:1`,
    "    at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:100:18)",
  ].join("\n");
  const output = await collect(deterministicTestReporter, [
    {
      type: "test:complete",
      data: {
        file,
        name: file,
        line: 1,
        column: 1,
        nesting: 0,
        testNumber: 1,
        details: {
          passed: false,
          type: "test",
          duration_ms: 15.75,
          error,
        },
      },
    },
  ]);

  assert.match(output, /"type":"file-failure"/u);
  assert.match(output, /"name":"<repo>\/scripts\/invalid-file\.test\.mjs"/u);
  assert.match(output, /Unexpected token/u);
  assert.match(output, /file:\/\/<repo>\/scripts\/invalid-file\.test\.mjs:1:1/u);
  assert.doesNotMatch(output, /node:internal/u);
});

test("a semantic test failure suppresses the duplicate file-wrapper failure", async () => {
  const file = path.join(REPOSITORY_ROOT, "scripts", "failed-test.test.mjs");
  const error = makeAssertionFailure(
    file,
    "    at Test.run (node:internal/test_runner/test:1000:1)",
  );
  const output = await collect(deterministicTestReporter, [
    failEvent(file, error),
    {
      type: "test:complete",
      data: {
        file,
        name: file,
        line: 1,
        column: 1,
        nesting: 0,
        testNumber: 1,
        details: {
          passed: false,
          type: "test",
          duration_ms: 20,
          error: new Error("test failed"),
        },
      },
    },
  ]);

  assert.match(output, /"type":"test","status":"fail"/u);
  assert.doesNotMatch(output, /"type":"file-failure"/u);
});

test("unknown event types fail closed", async () => {
  await assert.rejects(
    collect(deterministicTestReporter, [
      { type: "test:new-runtime-event", data: {} },
    ]),
    (error) => {
      assert.equal(
        error.code,
        "ERR_ROBIN_TEST_REPORTER_UNSUPPORTED_EVENT",
      );
      assert.match(error.message, /test:new-runtime-event/u);
      return true;
    },
  );
});

test("the event limit counts ignored lifecycle events and fails closed", async () => {
  const reporter = createDeterministicTestReporter({ maxEvents: 3 });
  const lifecycleEvent = {
    type: "test:start",
    data: { name: "fixture", nesting: 0 },
  };
  await assert.rejects(
    collect(reporter, [
      lifecycleEvent,
      lifecycleEvent,
      lifecycleEvent,
      lifecycleEvent,
    ]),
    (error) => {
      assert.equal(error.code, "ERR_ROBIN_TEST_REPORTER_EVENT_LIMIT");
      assert.match(error.message, /exceeds 3 input events/u);
      return true;
    },
  );
});

test("the byte limit fails closed before emitting a partial report", async () => {
  const reporter = createDeterministicTestReporter({ maxBufferedBytes: 256 });
  await assert.rejects(
    collect(reporter, [
      {
        type: "test:diagnostic",
        data: {
          nesting: 0,
          level: "info",
          message: "x".repeat(512),
        },
      },
    ]),
    (error) => {
      assert.equal(error.code, "ERR_ROBIN_TEST_REPORTER_BYTE_LIMIT");
      assert.match(error.message, /exceeds 256 buffered bytes/u);
      return true;
    },
  );
});

test("the byte preflight rejects typed arrays before base64 expansion", async () => {
  const reporter = createDeterministicTestReporter({ maxBufferedBytes: 512 });
  const file = path.join(REPOSITORY_ROOT, "scripts", "binary-failure.test.mjs");
  const error = makeAssertionFailure(
    file,
    "    at Test.run (node:internal/test_runner/test:1000:1)",
  );
  error.cause.actual = new Uint8Array(512);
  await assert.rejects(
    collect(reporter, [failEvent(file, error)]),
    (failure) => {
      assert.equal(failure.code, "ERR_ROBIN_TEST_REPORTER_BYTE_LIMIT");
      assert.match(failure.message, /exceeds 512 buffered bytes/u);
      return true;
    },
  );
});

test("the byte preflight rejects huge sparse arrays and textual special values", async () => {
  const reporter = createDeterministicTestReporter({ maxBufferedBytes: 512 });
  const file = path.join(REPOSITORY_ROOT, "scripts", "preflight-failure.test.mjs");
  const outputFor = (actual) => {
    const error = makeAssertionFailure(
      file,
      "    at Test.run (node:internal/test_runner/test:1000:1)",
    );
    error.cause.actual = actual;
    return collect(reporter, [failEvent(file, error)]);
  };
  for (const actual of [
    new Array(100_000_000),
    new RegExp(`prefix-${"x".repeat(512)}`, "u"),
    new URL(`https://example.invalid/?value=${"x".repeat(512)}`),
  ]) {
    await assert.rejects(outputFor(actual), (failure) => {
      assert.ok(
        failure.code === "ERR_ROBIN_TEST_REPORTER_BYTE_LIMIT" ||
          failure.code === "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
      );
      return true;
    });
  }
});

test("the real Node test runner replays an asynchronous failure exactly", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "robin-reporter-integration-"),
  );
  const fixture = path.join(temporaryRoot, "integration.test.mjs");
  const fixtureSource = [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    "",
    'test("passing diagnostic", (t) => {',
    '  t.diagnostic("fixture diagnostic");',
    "  t.diagnostic(process.env.ROBIN_REPORTER_LEXICAL_ROOT);",
    '  console.log("fixture stdout");',
    "});",
    "",
    'test("asynchronous failure", async () => {',
    "  await new Promise((resolve) => setImmediate(resolve));",
    '  assert.equal("actual", "expected");',
    "});",
    "",
  ].join("\n");
  await writeFile(fixture, fixtureSource, "utf8");

  try {
    const environment = {
      ...process.env,
      NO_COLOR: "1",
      ROBIN_REPORTER_LEXICAL_ROOT: temporaryRoot,
    };
    delete environment.FORCE_COLOR;
    delete environment.NODE_TEST_CONTEXT;
    const run = () =>
      spawnSync(
        process.execPath,
        ["--test", `--test-reporter=${reporterPath}`, fixture],
        {
          cwd: temporaryRoot,
          encoding: "utf8",
          env: environment,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    const first = run();
    const second = run();

    assert.equal(first.error, undefined);
    assert.equal(second.error, undefined);
    assert.equal(first.status, 1);
    assert.equal(second.status, 1);
    assert.equal(first.signal, null);
    assert.equal(second.signal, null);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.stderr, second.stderr);
    assert.match(first.stdout, /"name":"passing diagnostic"/u);
    assert.match(first.stdout, /"name":"asynchronous failure"/u);
    assert.match(first.stdout, /"status":"fail"/u);
    assert.match(first.stdout, /"message":"fixture diagnostic"/u);
    assert.match(first.stdout, /"message":"<cwd>"/u);
    assert.match(first.stdout, /"message":"fixture stdout\\n"/u);
    assert.match(first.stdout, /"code":"ERR_ASSERTION"/u);
    assert.match(first.stdout, /"file":"<cwd>\/integration\.test\.mjs"/u);
    assert.equal(first.stdout.includes(temporaryRoot), false);
    assert.doesNotMatch(first.stdout, /"duration_ms":/u);
    assert.doesNotMatch(first.stdout, /node:internal/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
