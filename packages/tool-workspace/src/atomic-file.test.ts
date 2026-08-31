import assert from "node:assert/strict";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { sha256Hex } from "@guard/contracts";

import {
  atomicCreatePhysicalFile,
  atomicReplacePhysicalFile,
} from "./atomic-file.js";
import {
  normalizeWorkspaceRelativePath,
  observePhysicalPath,
} from "./physical-path.js";
import {
  createRepositoryFixture,
  isDomainCode,
} from "./repository-fixture.test-support.js";

test("atomic replacement and exclusive creation publish exact verified bytes", async (t) => {
  const fixture = await createRepositoryFixture(t, { "file.txt": "before\n" });
  const observed = await observePhysicalPath(fixture.workspace, "file.txt");
  const after = Buffer.from("after\n", "utf8");
  const replaced = await atomicReplacePhysicalFile(fixture.workspace, {
    path: observed.path,
    expectedBinding: observed.binding,
    expectedSha256: sha256Hex("before\n"),
    bytes: after,
    maximumFileBytes: 1_024,
  });
  assert.equal(await readFile(path.join(fixture.root, "file.txt"), "utf8"), "after\n");
  assert.equal(replaced.afterSha256, sha256Hex(after));

  const created = await atomicCreatePhysicalFile(fixture.workspace, {
    path: workspacePath("new.txt"),
    bytes: Buffer.from("new\n"),
    maximumFileBytes: 1_024,
  });
  assert.equal(await readFile(path.join(fixture.root, "new.txt"), "utf8"), "new\n");
  assert.equal(created.beforeBinding, null);
  assert.equal((await temporaryFiles(fixture.root)).length, 0);
});

test("a target swap in before_publish is revalidated and never overwritten", async (t) => {
  const fixture = await createRepositoryFixture(t, { "file.txt": "before" });
  const observed = await observePhysicalPath(fixture.workspace, "file.txt");
  let swapped = false;
  await assert.rejects(
    atomicReplacePhysicalFile(
      fixture.workspace,
      {
        path: observed.path,
        expectedBinding: observed.binding,
        expectedSha256: sha256Hex("before"),
        bytes: Buffer.from("robin"),
        maximumFileBytes: 1_024,
      },
      {
        nextTemporarySuffix: () => "targetswap0001",
        async atPhase(phase) {
          if (phase === "before_publish" && !swapped) {
            swapped = true;
            await writeFile(path.join(fixture.root, "file.txt"), "external", "utf8");
          }
        },
      },
    ),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
  assert.equal(await readFile(path.join(fixture.root, "file.txt"), "utf8"), "external");
  assert.deepEqual(await temporaryFiles(fixture.root), []);
});

test("a create collision in before_publish is revalidated and never replaced", async (t) => {
  const fixture = await createRepositoryFixture(t);
  await assert.rejects(
    atomicCreatePhysicalFile(
      fixture.workspace,
      {
        path: workspacePath("new.txt"),
        bytes: Buffer.from("robin"),
        maximumFileBytes: 1_024,
      },
      {
        nextTemporarySuffix: () => "createswap0001",
        async atPhase(phase) {
          if (phase === "before_publish") {
            await writeFile(path.join(fixture.root, "new.txt"), "external", "utf8");
          }
        },
      },
    ),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
  assert.equal(await readFile(path.join(fixture.root, "new.txt"), "utf8"), "external");
  assert.deepEqual(await temporaryFiles(fixture.root), []);
});

test("a parent swap before temp creation produces zero outside-tree delta", async (t) => {
  const fixture = await createRepositoryFixture(t, { "dir/keep.txt": "keep" });
  const outside = path.join(fixture.parent, "outside-pre-temp");
  await mkdir(outside);
  await writeFile(path.join(outside, "canary.txt"), "outside-canary", "utf8");
  const before = await readdir(outside);

  await assert.rejects(
    atomicCreatePhysicalFile(
      fixture.workspace,
      {
        path: workspacePath("dir/new.txt"),
        bytes: Buffer.from("robin"),
        maximumFileBytes: 1_024,
      },
      {
        nextTemporarySuffix: () => "pretempswap01",
        async atPhase(phase) {
          if (phase !== "before_temp_create") return;
          await rename(
            path.join(fixture.root, "dir"),
            path.join(fixture.root, "dir-original"),
          );
          await symlink(outside, path.join(fixture.root, "dir"), "dir");
        },
      },
    ),
    (error: unknown) => isDomainCode(error, "conflict"),
  );

  assert.deepEqual(await readdir(outside), before);
  assert.equal(await readFile(path.join(outside, "canary.txt"), "utf8"), "outside-canary");
});

test("a parent swap retains the private temporary instead of unlinking outside", async (t) => {
  const fixture = await createRepositoryFixture(t, { "dir/keep.txt": "keep" });
  const outside = path.join(path.dirname(fixture.root), `${path.basename(fixture.root)}-outside`);
  await mkdir(outside);
  t.after(async () => {
    await rm(outside, { recursive: true, force: true });
  });
  const suffix = "parentswap0001";
  const outsideCanary = path.join(outside, `.new.txt.robin-${suffix}.tmp`);
  await writeFile(outsideCanary, "outside-canary", "utf8");

  await assert.rejects(
    atomicCreatePhysicalFile(
      fixture.workspace,
      {
        path: workspacePath("dir/new.txt"),
        bytes: Buffer.from("robin"),
        maximumFileBytes: 1_024,
      },
      {
        nextTemporarySuffix: () => suffix,
        async atPhase(phase) {
          if (phase !== "before_publish") return;
          await rename(
            path.join(fixture.root, "dir"),
            path.join(fixture.root, "dir-retained"),
          );
          await symlink(outside, path.join(fixture.root, "dir"), "dir");
        },
      },
    ),
    (error: unknown) => isDomainCode(error, "conflict"),
  );

  assert.equal(await readFile(outsideCanary, "utf8"), "outside-canary");
  assert.equal(
    await readFile(
      path.join(fixture.root, "dir-retained", `.new.txt.robin-${suffix}.tmp`),
      "utf8",
    ),
    "robin",
  );
});

test("post-publish failure is uncertain while pre-publish failure preserves the source", async (t) => {
  const fixture = await createRepositoryFixture(t, { "file.txt": "before" });
  const first = await observePhysicalPath(fixture.workspace, "file.txt");
  await assert.rejects(
    atomicReplacePhysicalFile(
      fixture.workspace,
      {
        path: first.path,
        expectedBinding: first.binding,
        expectedSha256: sha256Hex("before"),
        bytes: Buffer.from("candidate"),
        maximumFileBytes: 1_024,
      },
      {
        nextTemporarySuffix: () => "prepublish0001",
        atPhase(phase) {
          if (phase === "before_publish") throw new Error("injected");
        },
      },
    ),
    /injected/u,
  );
  assert.equal(await readFile(path.join(fixture.root, "file.txt"), "utf8"), "before");
  assert.deepEqual(await temporaryFiles(fixture.root), []);

  const second = await observePhysicalPath(fixture.workspace, "file.txt");
  await assert.rejects(
    atomicReplacePhysicalFile(
      fixture.workspace,
      {
        path: second.path,
        expectedBinding: second.binding,
        expectedSha256: sha256Hex("before"),
        bytes: Buffer.from("published"),
        maximumFileBytes: 1_024,
      },
      {
        nextTemporarySuffix: () => "postpublish001",
        atPhase(phase) {
          if (phase === "after_publish") throw new Error("injected");
        },
      },
    ),
    (error: unknown) => isDomainCode(error, "attempt_result_uncertain"),
  );
  assert.equal(await readFile(path.join(fixture.root, "file.txt"), "utf8"), "published");
});

async function temporaryFiles(root: string): Promise<readonly string[]> {
  return (await readdir(root)).filter((name) => name.includes(".robin-")).sort();
}

function workspacePath(value: string) {
  return normalizeWorkspaceRelativePath(value, { allowRoot: false });
}
