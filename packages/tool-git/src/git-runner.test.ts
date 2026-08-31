import assert from "node:assert/strict";
import test from "node:test";

import { ControlledGitRunner } from "./index.js";

test("rejects every uninstalled command shape before executable spawn", async () => {
  const runner = new ControlledGitRunner({
    gitExecutable: "/definitely/not/a/git-executable",
    cwd: "/",
    environment: {},
    timeoutMs: 1_000,
    maximumStdoutBytes: 1_024,
    maximumStderrBytes: 1_024,
  });
  const attempts = [
    () => runner.runRead("status", [
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
      "--no-renames",
      "--ignore-submodules=none",
    ]),
    () => runner.runRead("diff", ["--output=/tmp/runner-canary", "--"]),
    () => runner.runRead("diff", ["--", "../outside"]),
    () => runner.runRead("config", ["--local", "--add", "core.pager", "evil"]),
    () => runner.runRead("log", ["--all"]),
    () => runner.runRead("symbolic-ref", ["HEAD", "refs/heads/changed"]),
  ];
  for (const attempt of attempts) {
    await assert.rejects(
      attempt(),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "invalid_request",
    );
  }
});
