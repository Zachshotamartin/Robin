import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProcessToolError,
  resolveExecutable,
  revalidateExecutable,
} from "./index.js";

test("resolves a bare executable only through a trusted absolute PATH", async () => {
  const root = await makeRoot();
  const bin = path.join(root, "trusted-bin");
  const workspace = path.join(root, "workspace");
  await mkdir(bin);
  await mkdir(workspace);
  const executable = path.join(bin, "fixture-tool");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);

  const resolved = await resolveExecutable("fixture-tool", {
    trustedPath: [bin],
    workspaceRoot: workspace,
    trustedExecutableRoots: [bin],
    allowWorkspaceExecutables: false,
  });
  assert.equal(resolved.physicalPath, await realpath(executable));
  assert.equal(resolved.source, "trusted_path");
  assert.equal(await revalidateExecutable(resolved), true);
});

test("rejects workspace PATH shadowing, relative PATH entries, missing and non-executable files", async () => {
  const root = await makeRoot();
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const shadow = path.join(workspace, "node");
  await writeFile(shadow, "not executable");

  for (const trustedPath of [[workspace], ["relative"]]) {
    await assert.rejects(
      resolveExecutable("node", {
        trustedPath,
        workspaceRoot: workspace,
        trustedExecutableRoots: [],
        allowWorkspaceExecutables: false,
      }),
      ProcessToolError,
    );
  }
  await assert.rejects(
    resolveExecutable("missing", {
      trustedPath: [workspace],
      workspaceRoot: workspace,
      trustedExecutableRoots: [workspace],
      allowWorkspaceExecutables: true,
    }),
    (error: unknown) =>
      error instanceof ProcessToolError && error.code === "executable_not_found",
  );
});

test("binds symlink target identity and detects replacement before spawn", async () => {
  const root = await makeRoot();
  const bin = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  await mkdir(bin);
  await mkdir(workspace);
  const target = path.join(bin, "target");
  const link = path.join(bin, "tool");
  await writeFile(target, "#!/bin/sh\nexit 0\n");
  await chmod(target, 0o755);
  await symlink(target, link);

  const resolved = await resolveExecutable("tool", {
    trustedPath: [bin],
    workspaceRoot: workspace,
    trustedExecutableRoots: [bin],
    allowWorkspaceExecutables: false,
  });
  await writeFile(target, "#!/bin/sh\nexit 1\n");
  assert.equal(await revalidateExecutable(resolved), false);
});

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "robin-process-"));
}
