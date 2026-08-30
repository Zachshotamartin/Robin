import assert from "node:assert/strict";
import test from "node:test";

import { CliUsageError, parseArgv } from "./argv.js";

test("starts an interactive Robin session when no command is supplied", () => {
  assert.deepEqual(parseArgv([]), {
    kind: "interactive",
    prompt: null,
    provider: "synthetic",
    model: null,
    permissionMode: "ask",
  });
});

test("starts an interactive session with one initial prompt", () => {
  assert.deepEqual(parseArgv(["explain the retry loop"]), {
    kind: "interactive",
    prompt: "explain the retry loop",
    provider: "synthetic",
    model: null,
    permissionMode: "ask",
  });
  assert.deepEqual(
    parseArgv([
      "--provider",
      "synthetic",
      "--model",
      "fixture-v1",
      "--permission-mode",
      "plan",
      "inspect the project",
    ]),
    {
      kind: "interactive",
      prompt: "inspect the project",
      provider: "synthetic",
      model: "fixture-v1",
      permissionMode: "plan",
    },
  );
});

test("parses headless print mode with stable output and budget options", () => {
  assert.deepEqual(parseArgv(["-p", "summarize this repository"]), {
    kind: "print",
    prompt: "summarize this repository",
    provider: "synthetic",
    model: null,
    permissionMode: "ask",
    outputFormat: "text",
    save: false,
    maximumTurns: 16,
  });
  assert.deepEqual(
    parseArgv([
      "--print",
      "--output-format",
      "stream-json",
      "--no-save",
      "--maximum-turns",
      "4",
      "inspect the project",
    ]),
    {
      kind: "print",
      prompt: "inspect the project",
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
      outputFormat: "stream-json",
      save: false,
      maximumTurns: 4,
    },
  );
});

test("reserves continue, resume, and future product commands", () => {
  assert.deepEqual(parseArgv(["--continue"]), { kind: "continue" });
  assert.deepEqual(parseArgv(["--resume"]), { kind: "resume", selector: null });
  assert.deepEqual(parseArgv(["--resume", "session-1"]), {
    kind: "resume",
    selector: "session-1",
  });
  assert.throws(() => parseArgv(["--continue", "extra"]), CliUsageError);
  assert.throws(
    () => parseArgv(["--resume", "one", "two"]),
    CliUsageError,
  );
  for (const command of ["sessions", "auth", "models", "config", "doctor"]) {
    assert.throws(() => parseArgv([command]), /reserved but not implemented/u);
  }
  assert.deepEqual(parseArgv(["continue"]), {
    kind: "interactive",
    prompt: "continue",
    provider: "synthetic",
    model: null,
    permissionMode: "ask",
  });
});

test("session prompt limit accepts its exact UTF-8 boundary and rejects one byte more", () => {
  const atLimit = "a".repeat(65_536);
  assert.equal(parseArgv([atLimit]).kind, "interactive");
  assert.throws(() => parseArgv([atLimit + "a"]), /non-empty and bounded/u);
});

test("session parsing rejects unpaired UTF-16 surrogates", () => {
  assert.throws(() => parseArgv(["broken\ud800prompt"]), CliUsageError);
  assert.throws(() => parseArgv(["broken\udc00prompt"]), CliUsageError);
  assert.equal(parseArgv(["valid 😀 prompt"]).kind, "interactive");
});

test("session parsing rejects missing prompts, raw credentials, and ambiguous input", () => {
  for (const argv of [
    ["--print"],
    ["-p"],
    ["one prompt", "second prompt"],
    ["--output-format", "json", "interactive cannot select output"],
    ["--no-save", "interactive cannot disable persistence"],
    ["--maximum-turns", "0", "prompt"],
    ["--maximum-turns", "257", "prompt"],
    ["--permission-mode", "bypass", "prompt"],
    ["--api-key", "canary-secret", "prompt"],
  ]) {
    assert.throws(() => parseArgv(argv), CliUsageError);
  }
});

test("parses a minimal run and applies the human default", () => {
  assert.deepEqual(parseArgv(["run", "--profile", "synthetic-demo"]), {
    kind: "run",
    profile: "synthetic-demo",
    format: "human",
    objective: { kind: "builtin" },
  });
});

test("parses every explicit run option independent of option order", () => {
  assert.deepEqual(
    parseArgv([
      "run",
      "--format",
      "jsonl",
      "--objective-file",
      "objective.json",
      "--profile",
      "coding-virtual",
    ]),
    {
      kind: "run",
      profile: "coding-virtual",
      format: "jsonl",
      objective: { kind: "file", path: "objective.json" },
    },
  );
});

test("supports explicit inline JSON and the post-delimiter shorthand", () => {
  assert.deepEqual(
    parseArgv([
      "run",
      "--profile",
      "synthetic-demo",
      "--objective-json",
      '{"recordId":"greeting","mode":"uppercase"}',
    ]),
    {
      kind: "run",
      profile: "synthetic-demo",
      format: "human",
      objective: {
        kind: "inline",
        json: '{"recordId":"greeting","mode":"uppercase"}',
      },
    },
  );
  assert.deepEqual(
    parseArgv([
      "run",
      "--profile",
      "synthetic-demo",
      "--",
      '{"recordId":"greeting","mode":"uppercase"}',
    ]),
    {
      kind: "run",
      profile: "synthetic-demo",
      format: "human",
      objective: {
        kind: "inline",
        json: '{"recordId":"greeting","mode":"uppercase"}',
      },
    },
  );
});

test("supports JSONL and quiet aliases", () => {
  assert.deepEqual(
    parseArgv(["run", "--profile", "synthetic-demo", "--jsonl"]),
    {
      kind: "run",
      profile: "synthetic-demo",
      format: "jsonl",
      objective: { kind: "builtin" },
    },
  );
  assert.deepEqual(
    parseArgv(["run", "--profile", "coding-virtual", "--quiet"]),
    {
      kind: "run",
      profile: "coding-virtual",
      format: "quiet",
      objective: { kind: "builtin" },
    },
  );
});

test("supports root and run help plus root version", () => {
  assert.deepEqual(parseArgv(["--help"]), { kind: "help", command: "root" });
  assert.deepEqual(parseArgv(["-h"]), { kind: "help", command: "root" });
  assert.deepEqual(parseArgv(["run", "--help"]), {
    kind: "help",
    command: "run",
  });
  assert.deepEqual(parseArgv(["--version"]), { kind: "version" });
});

for (const argv of [
  ["run"],
  ["run", "--profile"],
  ["run", "--profile", "unknown"],
  ["run", "--profile", "synthetic-demo", "--format", "yaml"],
  ["run", "--profile=synthetic-demo"],
  ["run", "--profile", "synthetic-demo", "positional"],
  ["run", "--profile", "synthetic-demo", "--"],
  ["run", "--profile", "synthetic-demo", "--", "{}", "extra"],
]) {
  test(`rejects invalid argv: ${JSON.stringify(argv)}`, () => {
    assert.throws(() => parseArgv(argv), CliUsageError);
  });
}

test("rejects duplicate and mutually exclusive objective sources", () => {
  assert.throws(
    () =>
      parseArgv([
        "run",
        "--profile",
        "synthetic-demo",
        "--format",
        "human",
        "--format",
        "human",
      ]),
    /only once/u,
  );
  assert.throws(
    () =>
      parseArgv([
        "run",
        "--profile",
        "synthetic-demo",
        "--objective-file",
        "one.json",
        "--objective-json",
        "{}",
      ]),
    /mutually exclusive/u,
  );
  assert.throws(
    () =>
      parseArgv([
        "run",
        "--profile",
        "synthetic-demo",
        "--objective-file",
        "one.json",
        "--",
        "{}",
      ]),
    /mutually exclusive/u,
  );
});

test("rejects repeated or mutually exclusive format selectors", () => {
  for (const argv of [
    ["run", "--profile", "synthetic-demo", "--jsonl", "--jsonl"],
    ["run", "--profile", "synthetic-demo", "--quiet", "--quiet"],
    ["run", "--profile", "synthetic-demo", "--jsonl", "--quiet"],
    ["run", "--profile", "synthetic-demo", "--format", "human", "--jsonl"],
    ["run", "--profile", "synthetic-demo", "--quiet", "--format", "human"],
  ]) {
    assert.throws(() => parseArgv(argv), /only once|mutually exclusive/u);
  }
});

test("rejects agent, provider, credential, and API-key flags", () => {
  for (const forbidden of [
    "--agent",
    "--model",
    "--provider",
    "--api-key",
    "--credential",
    "--repository",
    "--network",
  ]) {
    assert.throws(
      () => parseArgv(["run", "--profile", "synthetic-demo", forbidden, "secret"]),
      (error: unknown) =>
        error instanceof CliUsageError &&
        error.message === `Unknown option: ${forbidden}.`,
    );
  }
});

test("does not echo an option value in usage errors", () => {
  const secret = "canary-secret-value";
  assert.throws(
    () => parseArgv(["run", "--profile", "synthetic-demo", "--api-key", secret]),
    (error: unknown) =>
      error instanceof CliUsageError && !error.message.includes(secret),
  );
});

test("parses every policy help surface", () => {
  assert.deepEqual(parseArgv(["policy", "--help"]), {
    kind: "help",
    command: "policy",
  });
  for (const command of ["check", "format", "test", "explain", "simulate"] as const) {
    assert.deepEqual(parseArgv(["policy", command, "--help"]), {
      kind: "help",
      command: `policy-${command}`,
    });
  }
});

test("parses check and format policy requests", () => {
  assert.deepEqual(
    parseArgv([
      "policy",
      "check",
      "default.guard",
      "--catalog",
      "repository.json",
      "--catalog",
      "process.json",
      "--default-effect",
      "require_approval",
      "--json",
    ]),
    {
      kind: "policy-check",
      policyPath: "default.guard",
      defaultEffect: "require_approval",
      catalogPaths: ["repository.json", "process.json"],
      format: "json",
    },
  );
  assert.deepEqual(parseArgv(["policy", "format", "default.guard"]), {
    kind: "policy-format",
    policyPath: "default.guard",
    format: "human",
  });
});

test("parses test and explain policy requests", () => {
  assert.deepEqual(
    parseArgv([
      "policy",
      "test",
      "strict.guard",
      "--cases",
      "cases.json",
    ]),
    {
      kind: "policy-test",
      policyPath: "strict.guard",
      casePath: "cases.json",
      defaultEffect: "deny",
      catalogPaths: [],
      format: "human",
    },
  );
  assert.deepEqual(
    parseArgv([
      "policy",
      "explain",
      "strict.guard",
      "--action",
      "action.json",
      "--json",
    ]),
    {
      kind: "policy-explain",
      policyPath: "strict.guard",
      actionPath: "action.json",
      defaultEffect: "deny",
      catalogPaths: [],
      format: "json",
    },
  );
});

test("parses a resumable policy simulation request", () => {
  assert.deepEqual(
    parseArgv([
      "policy",
      "simulate",
      "--from",
      "old.guard",
      "--to",
      "new.guard",
      "--actions",
      "actions.json",
      "--from-default-effect",
      "allow",
      "--to-default-effect",
      "deny",
      "--from-catalog",
      "from-catalog.json",
      "--to-catalog",
      "to-catalog.json",
      "--page-size",
      "250",
      "--cursor",
      "cursor-token",
      "--json",
    ]),
    {
      kind: "policy-simulate",
      fromPolicyPath: "old.guard",
      toPolicyPath: "new.guard",
      actionCorpusPath: "actions.json",
      fromDefaultEffect: "allow",
      toDefaultEffect: "deny",
      catalogPaths: [],
      fromCatalogPaths: ["from-catalog.json"],
      toCatalogPaths: ["to-catalog.json"],
      pageSize: 250,
      cursor: "cursor-token",
      format: "json",
    },
  );
});

test("rejects malformed, ambiguous, and unbounded policy argv", () => {
  const invalid = [
    ["policy"],
    ["policy", "unknown"],
    ["policy", "check"],
    ["policy", "check", "one.guard", "two.guard"],
    ["policy", "format", "one.guard", "--catalog", "catalog.json"],
    ["policy", "test", "one.guard"],
    ["policy", "test", "one.guard", "--cases", "one.json", "--cases", "two.json"],
    ["policy", "explain", "one.guard", "--action"],
    ["policy", "simulate", "--from", "one.guard", "--to", "two.guard"],
    [
      "policy",
      "simulate",
      "--from",
      "one.guard",
      "--to",
      "two.guard",
      "--actions",
      "actions.json",
      "--page-size",
      "0",
    ],
    ["policy", "check", "line\nbreak.guard"],
  ];
  for (const argv of invalid) {
    assert.throws(() => parseArgv(argv), CliUsageError);
  }
  const catalogs = Array.from({ length: 17 }, (_, index) => [
    "--catalog",
    `catalog-${String(index)}.json`,
  ]).flat();
  assert.throws(
    () => parseArgv(["policy", "check", "one.guard", ...catalogs]),
    /At most 16 catalog/u,
  );
});

test("policy parsing honors the end-of-options terminator", () => {
  assert.deepEqual(parseArgv(["policy", "check", "--", "-policy.guard"]), {
    kind: "policy-check",
    policyPath: "-policy.guard",
    defaultEffect: "deny",
    catalogPaths: [],
    format: "human",
  });
  assert.throws(
    () => parseArgv(["policy", "simulate", "--", "unexpected"]),
    /accepts no positional/u,
  );
});

test("rejects proxy, sparse, accessor, and oversized argv before parsing", () => {
  const proxied = new Proxy(["--help"], {
    ownKeys() {
      throw new Error("argv proxy trap must not run");
    },
  });
  assert.throws(() => parseArgv(proxied), CliUsageError);

  const sparse = new Array<string>(2);
  sparse[0] = "--help";
  assert.throws(() => parseArgv(sparse), CliUsageError);

  const accessor = ["--help"];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      throw new Error("argv getter must not run");
    },
  });
  assert.throws(() => parseArgv(accessor), CliUsageError);

  assert.throws(
    () => parseArgv(["policy", "check", "x".repeat(4_097)]),
    CliUsageError,
  );
  assert.equal(
    (parseArgv(["policy", "check", "x".repeat(4_096)]) as { policyPath: string })
      .policyPath.length,
    4_096,
  );
});
