import assert from "node:assert/strict";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertWorkspaceRootStable,
  discoverPhysicalWorkspace,
} from "./physical-workspace.js";
import {
  createRepositoryFixture,
  isDomainCode,
} from "./repository-fixture.test-support.js";

test("workspace discovery binds stable physical facts but separates mutable Git state", async (t) => {
  const fixture = await createRepositoryFixture(t);
  const changed = await discoverPhysicalWorkspace(
    { startDirectory: fixture.root, createdFrom: "launch_directory" },
    {
      gitProbe: {
        async inspect() {
          return {
            worktreeRoot: fixture.root,
            commonDirectory: path.join(fixture.root, ".git"),
            gitDirectory: path.join(fixture.root, ".git"),
            objectFormat: "sha1",
            initialHead: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
            branch: "feature",
            linked: false,
            bare: false,
            shallow: false,
            sparse: false,
            submodule: false,
            operationState: "none",
            initialStatusHash: "f".repeat(64),
          };
        },
      },
      caseSensitivity: "sensitive",
      unicodeNormalization: "nfc",
    },
  );

  assert.equal(fixture.workspace.identity.workspaceId, changed.identity.workspaceId);
  assert.notEqual(fixture.workspace.identity.bindingHash, changed.identity.bindingHash);
  assert.equal(fixture.workspace.identity.accessMode, "read_write");
  assert.equal(fixture.workspace.identity.git?.branch, "main");
  assert.match(fixture.workspace.identity.workspaceId, /^workspace:[a-f0-9]{64}$/u);
});

test("non-repository discovery requires an explicit workspace and stays read-only", async (t) => {
  const fixture = await createRepositoryFixture(t);
  await assert.rejects(
    discoverPhysicalWorkspace({
      startDirectory: fixture.root,
      createdFrom: "launch_directory",
    }),
    (error: unknown) => isDomainCode(error, "infrastructure_failed"),
  );
  const explicit = await discoverPhysicalWorkspace({
    startDirectory: fixture.root,
    createdFrom: "explicit_flag",
  });
  assert.equal(explicit.identity.git, null);
  assert.equal(explicit.identity.accessMode, "read_only");
});

test("root replacement invalidates every retained workspace handle", async (t) => {
  const fixture = await createRepositoryFixture(t);
  const moved = path.join(fixture.parent, "original");
  await rename(fixture.root, moved);
  await mkdir(fixture.root);
  await assert.rejects(
    assertWorkspaceRootStable(fixture.workspace),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
});
