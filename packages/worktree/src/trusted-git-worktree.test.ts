import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { isDomainError } from "@guard/contracts";

import {
  TrustedGitWorktreeManager,
  type GitRepositoryLimits,
} from "./trusted-git-worktree.js";

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = process.env["GUARD_TEST_GIT"] ?? "/usr/bin/git";
const FIXED_ENV = Object.freeze({
  ...process.env,
  GIT_AUTHOR_NAME: "Guard Fixture",
  GIT_AUTHOR_EMAIL: "guard-fixture@example.invalid",
  GIT_COMMITTER_NAME: "Guard Fixture",
  GIT_COMMITTER_EMAIL: "guard-fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
});

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly dataRoot: string;
}

const DEFAULT_LIMITS: GitRepositoryLimits = Object.freeze({
  maximumFiles: 64,
  maximumBlobBytes: 64 * 1024,
  maximumTotalBytes: 512 * 1024,
  maximumPathBytes: 512,
  maximumPathDepth: 16,
  maximumGitOutputBytes: 2 * 1024 * 1024,
  commandTimeoutMs: 10_000,
});

test("manager options require absolute narrow roots and passive exact data", async () => {
  const fixture = await createFixture();
  assert.throws(
    () =>
      new TrustedGitWorktreeManager({
        gitExecutable: "git",
        dataRoot: fixture.dataRoot,
        limits: DEFAULT_LIMITS,
      }),
    isInvalidInput,
  );
  assert.throws(
    () =>
      new TrustedGitWorktreeManager({
        gitExecutable: GIT_EXECUTABLE,
        dataRoot: path.parse(fixture.dataRoot).root,
        limits: DEFAULT_LIMITS,
      }),
    isInvalidInput,
  );

  let getterCalls = 0;
  const hostile = Object.defineProperty({}, "gitExecutable", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return GIT_EXECUTABLE;
    },
  });
  assert.throws(() => new TrustedGitWorktreeManager(hostile as never), isInvalidInput);
  assert.equal(getterCalls, 0);
  assert.throws(
    () => new TrustedGitWorktreeManager(new Proxy({}, { get: () => GIT_EXECUTABLE }) as never),
    isInvalidInput,
  );
});

test("clean inspection is deterministic, bounded, and contains no host path", async () => {
  const fixture = await createFixture({
    files: {
      "src/hello world-Ω.txt": "alpha\nbeta\n",
      "bin/tool.sh": "#!/bin/sh\nexit 0\n",
    },
    executable: ["bin/tool.sh"],
  });
  const manager = createManager(fixture);
  const first = await manager.inspectRepository(fixture.repository, new AbortController().signal);
  const second = await manager.inspectRepository(fixture.repository, new AbortController().signal);

  assert.deepEqual(second.descriptor, first.descriptor);
  assert.deepEqual(second.entries, first.entries);
  assert.equal(first.descriptor.baseCommit.length, 40);
  assert.equal(first.descriptor.baseTree.length, 40);
  assert.equal(first.descriptor.objectFormat, "sha1");
  assert.equal(first.descriptor.fileCount, 2);
  assert.equal(first.entries[0]?.path, "bin/tool.sh");
  assert.equal(first.entries[0]?.mode, "100755");
  assert.equal(first.entries[1]?.path, "src/hello world-Ω.txt");
  assert.equal(first.descriptor.originalCheckoutManifestHash.length, 64);
  assert.equal(JSON.stringify(first.descriptor).includes(fixture.root), false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.descriptor), true);
  assert.equal(Object.isFrozen(first.entries), true);
});

test("workspace is detached, raw-blob materialized, clean, and original bytes stay unchanged", async () => {
  const fixture = await createFixture({
    files: {
      "src/hello world-Ω.txt": "alpha\nbeta\n",
      "bin/tool.sh": "#!/bin/sh\nexit 0\n",
    },
    executable: ["bin/tool.sh"],
  });
  const manager = createManager(fixture);
  const beforeStatus = await git(fixture.repository, ["status", "--porcelain=v2", "-z"]);
  const beforeHead = await git(fixture.repository, ["rev-parse", "HEAD"]);
  const originalFile = path.join(fixture.repository, "src/hello world-Ω.txt");
  const originalBytes = await readFile(originalFile);

  const workspace = await manager.createWorkspace(
    {
      runId: "run_018f05a0-7b01-7000-8000-00000000c001",
      sourceRoot: fixture.repository,
    },
    new AbortController().signal,
  );

  assert.equal(workspace.descriptor.baseCommit, beforeHead.trim());
  assert.equal(workspace.descriptor.materializedTreeManifestHash.length, 64);
  assert.equal(workspace.descriptor.originalCheckoutManifestHash.length, 64);
  assert.equal(JSON.stringify(workspace.descriptor).includes(fixture.root), false);
  assert.equal((await lstat(path.join(workspace.root, ".git"))).isFile(), true);
  assert.equal(
    await readFile(path.join(workspace.root, "src/hello world-Ω.txt"), "utf8"),
    "alpha\nbeta\n",
  );
  assert.equal((await lstat(path.join(workspace.root, "bin/tool.sh"))).mode & 0o111, 0o100);
  assert.equal(await git(workspace.root, ["status", "--porcelain=v2", "-z"]), "");
  assert.equal((await git(workspace.root, ["rev-parse", "HEAD"])).trim(), beforeHead.trim());

  await writeFile(path.join(workspace.root, "src/hello world-Ω.txt"), "mutated\n", "utf8");
  assert.deepEqual(await readFile(originalFile), originalBytes);
  assert.equal(await git(fixture.repository, ["status", "--porcelain=v2", "-z"]), beforeStatus);

  await workspace.cleanup(new AbortController().signal);
  await workspace.cleanup(new AbortController().signal);
  assert.equal(await git(fixture.repository, ["status", "--porcelain=v2", "-z"]), beforeStatus);
  assert.equal((await git(fixture.repository, ["rev-parse", "HEAD"])).trim(), beforeHead.trim());
  await assert.rejects(lstat(workspace.root), (error: unknown) => isNodeCode(error, "ENOENT"));
});

test("dirty tracked and untracked repositories fail before a run directory is created", async (t) => {
  for (const change of ["tracked", "untracked"] as const) {
    await t.test(change, async () => {
      const fixture = await createFixture();
      if (change === "tracked") {
        await writeFile(path.join(fixture.repository, "README.md"), "dirty\n", "utf8");
      } else {
        await writeFile(path.join(fixture.repository, "untracked.txt"), "dirty\n", "utf8");
      }
      const manager = createManager(fixture);
      await assert.rejects(
        manager.createWorkspace(
          {
            runId: `run_018f05a0-7b01-7000-8000-00000000c00${change === "tracked" ? "2" : "3"}`,
            sourceRoot: fixture.repository,
          },
          new AbortController().signal,
        ),
        isInvalidInput,
      );
      await assert.rejects(
        lstat(path.join(fixture.dataRoot, "runs")),
        (error: unknown) => isNodeCode(error, "ENOENT"),
      );
    });
  }
});

test("hooks, filters, text conversion, sparse state, submodules, LFS, and unsupported modes fail closed", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly arrange: (fixture: Fixture) => Promise<void>;
  }[] = [
    {
      name: "configured hook path",
      async arrange(fixture) {
        await git(fixture.repository, ["config", "core.hooksPath", "hostile-hooks"]);
      },
    },
    {
      name: "filter command",
      async arrange(fixture) {
        await git(fixture.repository, ["config", "filter.guard.clean", "/definitely/not/executed"]);
      },
    },
    {
      name: "textconv command",
      async arrange(fixture) {
        await git(fixture.repository, ["config", "diff.guard.textconv", "/definitely/not/executed"]);
      },
    },
    {
      name: "merge driver",
      async arrange(fixture) {
        await git(fixture.repository, ["config", "merge.guard.driver", "/definitely/not/executed"]);
      },
    },
    {
      name: "filesystem monitor",
      async arrange(fixture) {
        await git(fixture.repository, ["config", "core.fsmonitor", "/definitely/not/executed"]);
      },
    },
    {
      name: "sparse checkout",
      async arrange(fixture) {
        await git(fixture.repository, ["config", "core.sparseCheckout", "true"]);
        const gitDir = (await git(fixture.repository, ["rev-parse", "--git-dir"])).trim();
        const absoluteGitDir = path.resolve(fixture.repository, gitDir);
        await mkdir(path.join(absoluteGitDir, "info"), { recursive: true });
        await writeFile(path.join(absoluteGitDir, "info", "sparse-checkout"), "/*\n", "utf8");
      },
    },
    {
      name: "transforming attributes",
      async arrange(fixture) {
        await writeFile(
          path.join(fixture.repository, ".gitattributes"),
          "*.txt filter=guard diff=guard text eol=crlf\n",
          "utf8",
        );
        await commitAll(fixture.repository, "attributes");
      },
    },
    {
      name: "gitmodules marker",
      async arrange(fixture) {
        await writeFile(
          path.join(fixture.repository, ".gitmodules"),
          "[submodule \"outside\"]\n\tpath = outside\n\turl = ../outside\n",
          "utf8",
        );
        await commitAll(fixture.repository, "gitmodules");
      },
    },
    {
      name: "LFS pointer",
      async arrange(fixture) {
        await writeFile(
          path.join(fixture.repository, "large.bin"),
          "version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 1\n",
          "utf8",
        );
        await commitAll(fixture.repository, "lfs pointer");
      },
    },
    {
      name: "tracked symbolic link",
      async arrange(fixture) {
        await symlink("README.md", path.join(fixture.repository, "link"));
        await commitAll(fixture.repository, "symlink");
      },
    },
    {
      name: "nonportable encoded path",
      async arrange(fixture) {
        await writeFile(
          path.join(fixture.repository, "encoded%2fpath.txt"),
          "not portable\n",
          "utf8",
        );
        await commitAll(fixture.repository, "nonportable path");
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = await createFixture();
      await item.arrange(fixture);
      const manager = createManager(fixture);
      await assert.rejects(
        manager.inspectRepository(fixture.repository, new AbortController().signal),
        isInvalidInput,
      );
    });
  }
});

test("repository and blob bounds fail at the exact enforcement layer", async () => {
  const fixture = await createFixture({
    files: { "README.md": "12345", "SECOND.md": "67890" },
  });
  const atLimit = createManager(fixture, {
    ...DEFAULT_LIMITS,
    maximumBlobBytes: 5,
    maximumTotalBytes: 10,
  });
  const accepted = await atLimit.inspectRepository(
    fixture.repository,
    new AbortController().signal,
  );
  assert.equal(accepted.descriptor.totalBlobBytes, 10);

  const overBlob = createManager(fixture, {
    ...DEFAULT_LIMITS,
    maximumBlobBytes: 4,
    maximumTotalBytes: 10,
  });
  await assert.rejects(
    overBlob.inspectRepository(fixture.repository, new AbortController().signal),
    isBudgetExceeded,
  );

  const overTotal = createManager(fixture, {
    ...DEFAULT_LIMITS,
    maximumBlobBytes: 5,
    maximumTotalBytes: 9,
  });
  await assert.rejects(
    overTotal.inspectRepository(fixture.repository, new AbortController().signal),
    isBudgetExceeded,
  );
});

test("pre-aborted inspection and creation perform no Git or filesystem work", async () => {
  const fixture = await createFixture();
  const manager = createManager(fixture);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    manager.inspectRepository(fixture.repository, controller.signal),
    isCancelled,
  );
  await assert.rejects(
    manager.createWorkspace(
      {
        runId: "run_018f05a0-7b01-7000-8000-00000000c004",
        sourceRoot: fixture.repository,
      },
      controller.signal,
    ),
    isCancelled,
  );
  await assert.rejects(
    lstat(path.join(fixture.dataRoot, "runs")),
    (error: unknown) => isNodeCode(error, "ENOENT"),
  );
});

function createManager(
  fixture: Fixture,
  limits: GitRepositoryLimits = DEFAULT_LIMITS,
): TrustedGitWorktreeManager {
  return new TrustedGitWorktreeManager({
    gitExecutable: GIT_EXECUTABLE,
    dataRoot: fixture.dataRoot,
    limits,
  });
}

async function createFixture(options: {
  readonly files?: Readonly<Record<string, string>>;
  readonly executable?: readonly string[];
} = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "guard-worktree-test-"));
  const repository = path.join(root, "source repository Ω");
  const dataRoot = path.join(root, "guard data");
  await mkdir(repository, { recursive: true, mode: 0o700 });
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.name", "Guard Fixture"]);
  await git(repository, ["config", "user.email", "guard-fixture@example.invalid"]);
  const files = options.files ?? { "README.md": "safe\n" };
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(repository, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  for (const relative of options.executable ?? []) {
    await chmod(path.join(repository, relative), 0o755);
  }
  await commitAll(repository, "base");
  return Object.freeze({ root, repository, dataRoot });
}

async function commitAll(repository: string, message: string): Promise<void> {
  await git(repository, ["add", "--all"]);
  await git(repository, ["commit", "--quiet", "-m", message]);
}

async function git(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, argv, {
    cwd,
    env: FIXED_ENV,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

function isInvalidInput(error: unknown): boolean {
  return isDomainError(error) && error.code === "invalid_input";
}

function isBudgetExceeded(error: unknown): boolean {
  return isDomainError(error) && error.code === "budget_exceeded";
}

function isCancelled(error: unknown): boolean {
  return isDomainError(error) && error.code === "cancelled";
}

function isNodeCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
