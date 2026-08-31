import assert from "node:assert/strict";
import test from "node:test";

import {
  ProcessToolError,
  buildProcessEnvironment,
  type ProcessEnvironmentProfile,
} from "./index.js";

const profile: ProcessEnvironmentProfile = Object.freeze({
  profileId: "r2-test",
  inheritedKeys: Object.freeze(["LANG", "LC_ALL"]),
  fixed: Object.freeze({
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/robin-empty-home",
    TMPDIR: "/tmp/robin-tmp",
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  }),
});

test("builds a fresh minimal environment without ambient credentials", () => {
  const result = buildProcessEnvironment({
    profile,
    ambient: {
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      OPENAI_API_KEY: "must-not-leak",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      UNREVIEWED: "absent",
    },
    additions: { PROJECT_MODE: "test" },
  });

  assert.deepEqual(result.values, {
    CI: "1",
    GCM_INTERACTIVE: "never",
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/tmp/robin-empty-home",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: "/usr/bin:/bin",
    PROJECT_MODE: "test",
    TERM: "dumb",
    TMPDIR: "/tmp/robin-tmp",
  });
  assert.equal("OPENAI_API_KEY" in result.values, false);
  assert.equal("SSH_AUTH_SOCK" in result.values, false);
  assert.equal(JSON.stringify(result.metadata).includes("must-not-leak"), false);
  assert.deepEqual(result.metadata.addedKeys, ["PROJECT_MODE"]);
  assert.ok(Object.isFrozen(result.values));
  assert.ok(Object.isFrozen(result.metadata));
});

test("rejects secret-shaped, loader, path, Git, and shell-initialization additions", () => {
  for (const key of [
    "OPENAI_API_KEY",
    "SERVICE_TOKEN",
    "DATABASE_PASSWORD",
    "SSH_AUTH_SOCK",
    "NODE_OPTIONS",
    "PATH",
    "HOME",
    "BASH_ENV",
    "GIT_CONFIG_GLOBAL",
  ]) {
    assert.throws(
      () =>
        buildProcessEnvironment({
          profile,
          ambient: {},
          additions: { [key]: "value" },
        }),
      (error: unknown) =>
        error instanceof ProcessToolError && error.code === "environment_denied",
    );
  }
});

test("rejects invalid names, NUL values, collisions, and oversized additions", () => {
  for (const additions of [
    { "BAD-NAME": "x" },
    { PROJECT_MODE: "a\u0000b" },
    { CI: "0" },
    { PROJECT_MODE: "x".repeat(65_537) },
  ]) {
    assert.throws(
      () => buildProcessEnvironment({ profile, ambient: {}, additions }),
      ProcessToolError,
    );
  }
});
