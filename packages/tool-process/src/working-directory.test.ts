import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareWorkingDirectory,
  revalidateWorkingDirectory,
} from "./index.js";

test("binds root and cwd identities and rejects symlink traversal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "robin-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "packages", "app"), { recursive: true });
  await symlink(path.join(root, "packages"), path.join(root, "linked"));

  const prepared = await prepareWorkingDirectory(root, "packages/app");
  assert.equal(prepared.relativePath, "packages/app");
  assert.equal(await revalidateWorkingDirectory(prepared), true);
  await assert.rejects(prepareWorkingDirectory(root, "linked/app"));
});

test("detects root and cwd replacement after observation", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "robin-cwd-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  await mkdir(path.join(root, "nested"), { recursive: true });
  const prepared = await prepareWorkingDirectory(root, "nested");
  await rename(path.join(root, "nested"), path.join(root, "old-nested"));
  await mkdir(path.join(root, "nested"));
  assert.equal(await revalidateWorkingDirectory(prepared), false);
});
