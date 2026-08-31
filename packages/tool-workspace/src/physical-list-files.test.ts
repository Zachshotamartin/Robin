import assert from "node:assert/strict";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createWorkspaceIgnorePolicy } from "./ignore-rules.js";
import { walkPhysicalWorkspace } from "./file-walker.js";
import { listPhysicalFiles } from "./physical-list-files.js";
import {
  createRepositoryFixture,
  isDomainCode,
} from "./repository-fixture.test-support.js";

const LIMITS = Object.freeze({
  maximumDepth: 8,
  maximumEntries: 256,
  maximumResults: 128,
  maximumPathBytes: 32 * 1024,
  maximumDurationMs: 10_000,
});

test("listing is deterministic, bounded, and reports each omission source", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    ".hidden.txt": "hidden",
    ".env": "SHOULD_NOT_APPEAR=canary",
    ".robinignore": "ignored/**\n",
    "ignored/file.txt": "ignored",
    "node_modules/pkg/index.js": "generated",
    "src/zeta.ts": "z",
    "src/alpha.ts": "a",
  });
  await symlink(path.join(fixture.parent, "outside"), path.join(fixture.root, "visible-link"));
  const result = await listPhysicalFiles(
    fixture.workspace,
    {
      root: "",
      includeHidden: false,
      includeGenerated: false,
      limits: LIMITS,
    },
    new AbortController().signal,
  );
  const paths = result.files.map((entry) => entry["path"]);
  assert.deepEqual(paths, ["src", "src/alpha.ts", "src/zeta.ts", "visible-link"]);
  assert.equal(paths.includes(".git"), false);
  assert.equal(JSON.stringify(result).includes("SHOULD_NOT_APPEAR"), false);
  const reasons = new Set(result.omissions.map((entry) => entry["reason"]));
  assert.equal(reasons.has("hard_security"), true);
  assert.equal(reasons.has("hidden_policy"), true);
  assert.equal(reasons.has("robin_ignore"), true);
  assert.equal(reasons.has("default_generated"), true);
});

test("Git administration is excluded even with an otherwise empty ignore policy", async (t) => {
  const fixture = await createRepositoryFixture(t, { ".git/config": "secret-ish" });
  const policy = await createWorkspaceIgnorePolicy(fixture.workspace, {
    includeHidden: true,
    includeGenerated: true,
  });
  const result = await walkPhysicalWorkspace(
    fixture.workspace,
    "",
    policy,
    LIMITS,
    new AbortController().signal,
  );
  assert.equal(result.entries.some((entry) => entry.path.startsWith(".git")), false);
  assert.equal(
    result.omissions.some((entry) => entry.reason === "hard_security"),
    true,
  );
});

test("a non-empty list root cannot traverse an intermediate symlink", async (t) => {
  const fixture = await createRepositoryFixture(t);
  const outside = path.join(fixture.parent, "outside-root");
  await mkdir(outside);
  await writeFile(path.join(outside, "canary.txt"), "outside-canary", "utf8");
  await symlink(outside, path.join(fixture.root, "link"));
  const policy = await createWorkspaceIgnorePolicy(fixture.workspace, {
    includeHidden: true,
    includeGenerated: true,
  });
  await assert.rejects(
    walkPhysicalWorkspace(
      fixture.workspace,
      "link/subdir",
      policy,
      LIMITS,
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("a directory swapped to an outside symlink before recursion fails the whole walk", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    "inside/file.txt": "inside",
  });
  const outside = path.join(fixture.parent, "outside-tree");
  await mkdir(outside);
  await writeFile(path.join(outside, "canary.txt"), "outside-canary", "utf8");
  let swapped = false;
  const policy = await createWorkspaceIgnorePolicy(fixture.workspace, {
    includeHidden: true,
    includeGenerated: true,
    gitIgnoreProbe: {
      async ignoredPaths(paths) {
        if (!swapped && paths.some((candidate) => candidate === "inside")) {
          swapped = true;
          await rename(path.join(fixture.root, "inside"), path.join(fixture.root, "inside-original"));
          await symlink(outside, path.join(fixture.root, "inside"));
        }
        return new Set<string>();
      },
    },
  });
  await assert.rejects(
    walkPhysicalWorkspace(
      fixture.workspace,
      "",
      policy,
      LIMITS,
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
});

test("pinned enumeration consumes no outside names after a pre-read directory swap", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    "inside/local.txt": "inside",
  });
  const outside = path.join(fixture.parent, "outside-enumeration");
  await mkdir(outside);
  await writeFile(path.join(outside, "outside-canary.txt"), "outside-canary", "utf8");
  const probed: string[] = [];
  let swapped = false;
  const policy = await createWorkspaceIgnorePolicy(fixture.workspace, {
    includeHidden: true,
    includeGenerated: true,
    gitIgnoreProbe: {
      async ignoredPaths(paths) {
        probed.push(...paths);
        return new Set<string>();
      },
    },
  });

  await assert.rejects(
    walkPhysicalWorkspace(
      fixture.workspace,
      "",
      policy,
      LIMITS,
      new AbortController().signal,
      {
        raceHooks: {
          async beforeDirectoryRead(directoryPath) {
            if (directoryPath !== "inside" || swapped) return;
            swapped = true;
            await rename(
              path.join(fixture.root, "inside"),
              path.join(fixture.root, "inside-original"),
            );
            await symlink(outside, path.join(fixture.root, "inside"), "dir");
          },
        },
      },
    ),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
  assert.equal(probed.some((candidate) => candidate.includes("outside-canary")), false);
});

test("non-empty root observation releases no outside entry after an intermediate swap", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    "inside/nested/local.txt": "inside",
  });
  const outside = path.join(fixture.parent, "outside-root-race");
  await mkdir(path.join(outside, "nested"), { recursive: true });
  await writeFile(
    path.join(outside, "nested", "outside-canary.txt"),
    "outside-canary",
    "utf8",
  );
  const policy = await createWorkspaceIgnorePolicy(fixture.workspace, {
    includeHidden: true,
    includeGenerated: true,
  });
  let swapped = false;

  await assert.rejects(
    walkPhysicalWorkspace(
      fixture.workspace,
      "inside/nested",
      policy,
      LIMITS,
      new AbortController().signal,
      {
        raceHooks: {
          async beforeDirectoryRead(directoryPath) {
            if (directoryPath !== "inside" || swapped) return;
            swapped = true;
            await rename(
              path.join(fixture.root, "inside"),
              path.join(fixture.root, "inside-original"),
            );
            await symlink(outside, path.join(fixture.root, "inside"), "dir");
          },
        },
      },
    ),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
});

test("a symlinked .robinignore cannot import outside traversal policy", async (t) => {
  const fixture = await createRepositoryFixture(t, { "safe.txt": "safe" });
  const outside = path.join(fixture.parent, "outside-ignore");
  await writeFile(outside, "safe.txt\n", "utf8");
  await symlink(outside, path.join(fixture.root, ".robinignore"));
  await assert.rejects(
    createWorkspaceIgnorePolicy(fixture.workspace, {
      includeHidden: true,
      includeGenerated: true,
    }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("entry, depth, time, and cancellation budgets terminate deterministically", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    "a/one.txt": "1",
    "a/deep/two.txt": "2",
    "b/three.txt": "3",
  });
  const policy = await createWorkspaceIgnorePolicy(fixture.workspace, {
    includeHidden: true,
    includeGenerated: true,
  });
  const shallow = await walkPhysicalWorkspace(
    fixture.workspace,
    "",
    policy,
    { ...LIMITS, maximumDepth: 1 },
    new AbortController().signal,
  );
  assert.equal(shallow.omissions.some((entry) => entry.reason === "depth"), true);

  let tick = 0;
  const timed = await walkPhysicalWorkspace(
    fixture.workspace,
    "",
    policy,
    { ...LIMITS, maximumDurationMs: 1 },
    new AbortController().signal,
    { monotonicNow: () => tick++ },
  );
  assert.equal(timed.truncated, true);
  assert.equal(timed.omissions.some((entry) => entry.reason === "time"), true);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    walkPhysicalWorkspace(fixture.workspace, "", policy, LIMITS, controller.signal),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
});
