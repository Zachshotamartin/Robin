import assert from "node:assert/strict";
import test from "node:test";

import { CliUsageError, parseArgv } from "./argv.js";

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
  [] as string[],
  ["inspect"],
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
