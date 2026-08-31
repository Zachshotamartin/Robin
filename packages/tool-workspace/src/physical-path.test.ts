import assert from "node:assert/strict";
import { link, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  closeStableFile,
  finishStableRead,
  normalizeWorkspaceRelativePath,
  observePhysicalPath,
  openStableRegularFile,
} from "./physical-path.js";
import {
  createRepositoryFixture,
  isDomainCode,
} from "./repository-fixture.test-support.js";

test("physical path normalization accepts literal filenames and rejects escape forms", () => {
  for (const accepted of [
    "src/space name.ts",
    "src/tab\tname.ts",
    "src/newline\nname.ts",
    "src/$()[];*.ts",
    "src/percent%20name.ts",
    "unicodé/😀.ts",
  ]) {
    assert.equal(normalizeWorkspaceRelativePath(accepted, { allowRoot: false }), accepted.normalize("NFC"));
  }
  for (const rejected of [
    "",
    ".",
    "..",
    "src/../secret",
    "src//file",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "\\\\server\\share",
    "src\\file",
    "src/%2e%2e/secret",
    "src/\u0000file",
    "src/\ud800",
  ]) {
    assert.throws(
      () => normalizeWorkspaceRelativePath(rejected, { allowRoot: false }),
      (error: unknown) => isDomainCode(error, "invalid_input"),
      JSON.stringify(rejected),
    );
  }
  assert.equal(normalizeWorkspaceRelativePath("", { allowRoot: true }), "");
});

test("path observation denies link traversal while listing can inspect a leaf link", async (t) => {
  const fixture = await createRepositoryFixture(t, { "safe/file.txt": "safe\n" });
  const outside = path.join(fixture.parent, "outside.txt");
  await writeFile(outside, "outside-canary", "utf8");
  await symlink(outside, path.join(fixture.root, "leaf-link"));
  await symlink(path.join(fixture.parent), path.join(fixture.root, "parent-link"));

  await assert.rejects(
    observePhysicalPath(fixture.workspace, "leaf-link"),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  const leaf = await observePhysicalPath(fixture.workspace, "leaf-link", {
    allowLeafSymlink: true,
  });
  assert.equal(leaf.binding.identity.kind, "symlink");
  await assert.rejects(
    observePhysicalPath(fixture.workspace, "parent-link/outside.txt"),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("Unicode normalization resolves one physical entry and rejects case aliases", async (t) => {
  const fixture = await createRepositoryFixture(t);
  const nfd = "café".normalize("NFD");
  await writeFile(path.join(fixture.root, nfd), "unicode", "utf8");
  const observed = await observePhysicalPath(
    fixture.workspace,
    "café".normalize("NFC"),
  );
  assert.equal(observed.path, "café");

  const insensitive = await import("./physical-workspace.js").then(({ discoverPhysicalWorkspace }) =>
    discoverPhysicalWorkspace(
      { startDirectory: fixture.root, createdFrom: "launch_directory" },
      {
        gitProbe: fixture.gitProbe,
        caseSensitivity: "insensitive",
        unicodeNormalization: "nfc",
      },
    ),
  );
  await writeFile(path.join(fixture.root, "Case.txt"), "case", "utf8");
  await assert.rejects(
    observePhysicalPath(insensitive, "case.txt"),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
});

test("stable open detects a path swap and reports drift", async (t) => {
  const fixture = await createRepositoryFixture(t, { "source.txt": "before" });
  const opened = await openStableRegularFile(fixture.workspace, "source.txt", {
    maximumFileBytes: 1_024,
  });
  const original = path.join(fixture.root, "source-original.txt");
  await rename(path.join(fixture.root, "source.txt"), original);
  await writeFile(path.join(fixture.root, "source.txt"), "after", "utf8");
  try {
    await assert.rejects(
      finishStableRead(fixture.workspace, opened),
      (error: unknown) => isDomainCode(error, "conflict"),
    );
  } finally {
    await closeStableFile(opened);
  }
});

test("component observation rejects an intermediate directory swapped before enumeration", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    "inside/expected.txt": "inside",
  });
  const outside = path.join(fixture.parent, "outside-component");
  await mkdir(outside);
  await writeFile(path.join(outside, "expected.txt"), "outside-canary", "utf8");
  let swapped = false;

  await assert.rejects(
    observePhysicalPath(fixture.workspace, "inside/expected.txt", {
      hooks: {
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
    }),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
});

test("hard-linked regular files remain readable metadata but expose their link count", async (t) => {
  const fixture = await createRepositoryFixture(t, { "one.txt": "shared" });
  await link(path.join(fixture.root, "one.txt"), path.join(fixture.parent, "outside-link"));
  const observed = await observePhysicalPath(fixture.workspace, "one.txt");
  assert.equal(observed.binding.links, 2);
});

test("directory and Git administrative reads are denied by default", async (t) => {
  const fixture = await createRepositoryFixture(t);
  await mkdir(path.join(fixture.root, "directory"));
  await assert.rejects(
    observePhysicalPath(fixture.workspace, "directory"),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  await assert.rejects(
    observePhysicalPath(fixture.workspace, ".git"),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});
