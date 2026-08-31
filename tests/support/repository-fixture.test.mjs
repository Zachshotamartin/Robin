import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertGitStorageUnchanged,
  assertRepositoryDelta,
  createRepositoryFixture,
  diffGitStorageSnapshots,
  diffRepositorySnapshots,
  snapshotRepository,
} from "./repository-fixture.mjs";

test("clean fixture records stable workspace and Git identity", async (context) => {
  const fixture = await createRepositoryFixture({ variant: "clean" });
  context.after(() => fixture.cleanup());

  assert.equal(fixture.variant, "clean");
  assert.equal(fixture.initialSnapshot.git.isRepository, true);
  assert.equal(fixture.initialSnapshot.git.branch, "main");
  assert.equal(fixture.initialSnapshot.git.detached, false);
  assert.equal(fixture.initialSnapshot.git.unborn, false);
  assert.equal(fixture.initialSnapshot.git.porcelainV2ZBase64, "");
  assert.match(
    await readFile(path.join(fixture.workspaceRoot, "src", "answer.txt"), "utf8"),
    /^41\n$/u,
  );

  const again = await snapshotRepository(fixture.workspaceRoot);
  assert.deepEqual(diffRepositorySnapshots(fixture.initialSnapshot, again), {
    workspace: { added: [], changed: [], removed: [] },
    git: { changed: false },
  });
});

test("dirty fixture contains staged, unstaged, and untracked state", async (context) => {
  const fixture = await createRepositoryFixture({ variant: "dirty" });
  context.after(() => fixture.cleanup());

  const status = Buffer.from(
    fixture.initialSnapshot.git.porcelainV2ZBase64,
    "base64",
  ).toString("utf8");
  assert.match(status, /1 M\. N\.\.\. 100644 100644 100644 /u);
  assert.match(status, /1 \.M N\.\.\. 100644 100644 100644 /u);
  assert.match(status, /\? untracked\.txt\0/u);
});

test("coding fixture preserves user changes around a deterministic two-edit repair", async (context) => {
  const fixture = await createRepositoryFixture({ variant: "coding" });
  context.after(() => fixture.cleanup());

  const source = await readFile(
    path.join(fixture.workspaceRoot, "src", "calculate.ts"),
    "utf8",
  );
  assert.match(source, /total - value/u);
  assert.match(source, /return label\.toLowerCase\(\);/u);
  const status = Buffer.from(
    fixture.initialSnapshot.git.porcelainV2ZBase64,
    "base64",
  ).toString("utf8");
  assert.match(status, /notes\/user-notes\.txt/u);
  assert.match(status, /\? scratch-user\.txt\0/u);

  const firstVerification = await runFixtureNpmTest(fixture.workspaceRoot);
  assert.notEqual(firstVerification.code, 0);
  assert.match(
    `${firstVerification.stdout}\n${firstVerification.stderr}`,
    /reducer must add each value/u,
  );

  const afterFirstEdit = source.replace("total - value", "total + value");
  await writeFile(
    path.join(fixture.workspaceRoot, "src", "calculate.ts"),
    afterFirstEdit,
  );
  const secondVerification = await runFixtureNpmTest(fixture.workspaceRoot);
  assert.notEqual(secondVerification.code, 0);
  assert.match(
    `${secondVerification.stdout}\n${secondVerification.stderr}`,
    /labels must be uppercase/u,
  );

  await writeFile(
    path.join(fixture.workspaceRoot, "src", "calculate.ts"),
    afterFirstEdit.replace(
      "return label.toLowerCase();",
      "return label.toUpperCase();",
    ),
  );
  const finalVerification = await runFixtureNpmTest(fixture.workspaceRoot);
  assert.equal(finalVerification.code, 0);
  assert.equal(
    await readFile(
      path.join(fixture.workspaceRoot, "notes", "user-notes.txt"),
      "utf8",
    ),
    "keep this user-authored baseline\npre-existing uncommitted note\n",
  );
  assert.equal(
    await readFile(path.join(fixture.workspaceRoot, "scratch-user.txt"), "utf8"),
    "pre-existing untracked user content\n",
  );
  const finalSnapshot = await fixture.snapshot();
  assert.doesNotThrow(() =>
    assertRepositoryDelta(fixture.initialSnapshot, finalSnapshot, {
      added: [],
      changed: ["src/calculate.ts"],
      removed: [],
      gitChanged: true,
    }),
  );
  assert.doesNotThrow(() =>
    assertGitStorageUnchanged(fixture.initialSnapshot, finalSnapshot),
  );
});

test("unborn, detached, nested, conflict, and hostile-name variants are explicit", async (context) => {
  const fixtures = [];
  context.after(async () => {
    await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
  });

  for (const variant of [
    "unborn",
    "detached",
    "nested",
    "merge-conflict",
    "malicious-name",
    "unicode",
    "newline",
    "symlink",
  ]) {
    fixtures.push(await createRepositoryFixture({ variant }));
  }

  const byVariant = new Map(fixtures.map((fixture) => [fixture.variant, fixture]));
  assert.equal(byVariant.get("unborn").initialSnapshot.git.unborn, true);
  assert.equal(byVariant.get("detached").initialSnapshot.git.detached, true);
  assert.notEqual(
    byVariant.get("nested").workingDirectory,
    byVariant.get("nested").workspaceRoot,
  );
  assert.equal(byVariant.get("merge-conflict").metadata.hasConflict, true);

  for (const relativePath of [
    "-leading-dash.txt",
    "dollar-$(not-executed).txt",
    "semi;colon.txt",
  ]) {
    await access(path.join(byVariant.get("malicious-name").workspaceRoot, relativePath));
  }
  await access(path.join(byVariant.get("unicode").workspaceRoot, "emoji-🦉.txt"));
  await access(path.join(byVariant.get("newline").workspaceRoot, "line\nbreak.txt"));

  const symlinkRecord = byVariant
    .get("symlink")
    .initialSnapshot.workspace.entries.find(
      (entry) => entry.path === "link-outside.txt",
    );
  assert.equal(symlinkRecord?.kind, "symlink");
});

test("linked worktree, local submodule, and bare variants expose their layout", async (context) => {
  const fixtures = [];
  context.after(async () => {
    await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
  });

  for (const variant of ["linked-worktree", "submodule", "bare"]) {
    fixtures.push(await createRepositoryFixture({ variant }));
  }
  const byVariant = new Map(fixtures.map((fixture) => [fixture.variant, fixture]));

  assert.equal(byVariant.get("linked-worktree").initialSnapshot.git.linkedWorktree, true);
  assert.notEqual(
    byVariant.get("linked-worktree").initialSnapshot.git.commonDir,
    byVariant.get("linked-worktree").initialSnapshot.git.gitDir,
  );
  assert.equal(byVariant.get("submodule").metadata.hasSubmodule, true);
  assert.equal(byVariant.get("bare").initialSnapshot.git.bare, true);
});

test("delta oracle identifies exact file and Git changes", async (context) => {
  const fixture = await createRepositoryFixture({ variant: "clean" });
  context.after(() => fixture.cleanup());
  const before = fixture.initialSnapshot;

  await writeFile(path.join(fixture.workspaceRoot, "src", "answer.txt"), "42\n");
  await writeFile(path.join(fixture.workspaceRoot, "created.txt"), "created\n");
  const after = await snapshotRepository(fixture.workspaceRoot);
  const delta = diffRepositorySnapshots(before, after);

  assert.deepEqual(delta.workspace.added, ["created.txt"]);
  assert.deepEqual(delta.workspace.removed, []);
  assert.deepEqual(delta.workspace.changed, ["src/answer.txt"]);
  assert.equal(delta.git.changed, true);
  assert.deepEqual(diffGitStorageSnapshots(before, after), {
    added: [],
    changed: [],
    removed: [],
  });
  assert.doesNotThrow(() => assertGitStorageUnchanged(before, after));
  assert.doesNotThrow(() =>
    assertRepositoryDelta(before, after, {
      added: ["created.txt"],
      changed: ["src/answer.txt"],
      removed: [],
      gitChanged: true,
    }),
  );
  assert.throws(
    () =>
      assertRepositoryDelta(before, after, {
        added: [],
        changed: ["src/answer.txt"],
        removed: [],
        gitChanged: true,
      }),
    /unexpected repository delta/u,
  );
});

test("Git-storage oracle distinguishes worktree edits from prohibited index writes", async (context) => {
  const fixture = await createRepositoryFixture({ variant: "clean" });
  context.after(() => fixture.cleanup());
  const before = fixture.initialSnapshot;

  await writeFile(path.join(fixture.workspaceRoot, "src", "answer.txt"), "42\n");
  const worktreeOnly = await snapshotRepository(fixture.workspaceRoot);
  assert.doesNotThrow(() => assertGitStorageUnchanged(before, worktreeOnly));

  await fixture.runGit(["add", "--", "src/answer.txt"]);
  const indexChanged = await snapshotRepository(fixture.workspaceRoot);
  assert.match(
    diffGitStorageSnapshots(worktreeOnly, indexChanged).changed.join("\n"),
    /index/u,
  );
  assert.throws(
    () => assertGitStorageUnchanged(worktreeOnly, indexChanged),
    /Git storage changed/u,
  );
});

test("outside-root safety snapshot detects a change without following symlinks", async (context) => {
  const fixture = await createRepositoryFixture({ variant: "symlink" });
  context.after(() => fixture.cleanup());
  const before = await snapshotRepository(fixture.outsideRoot, {
    includeGit: false,
  });

  await writeFile(path.join(fixture.outsideRoot, "outside.txt"), "changed\n");
  const after = await snapshotRepository(fixture.outsideRoot, {
    includeGit: false,
  });

  assert.deepEqual(diffRepositorySnapshots(before, after).workspace, {
    added: [],
    changed: ["outside.txt"],
    removed: [],
  });
});

async function runFixtureNpmTest(cwd) {
  const { spawn } = await import("node:child_process");
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...environment } = process.env;
  return await new Promise((resolve, reject) => {
    const child = spawn("npm", ["test", "--silent"], {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}
