import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  ControlledGitRunner,
  captureGitStatusSnapshot,
  discoverGitRepository,
  readCurrentBranch,
  readGitDiff,
  readGitLog,
  revalidateGitRepository,
} from "./index.js";

const execFileAsync = promisify(execFile);

test("discovers canonical repository identity and status without changing the index", async (t) => {
  const fixture = await createRepository(t);
  await writeFile(path.join(fixture.root, "tracked.txt"), "changed\n");
  await writeFile(path.join(fixture.root, "line\nbreak.txt"), "untracked\n");
  const runner = runnerFor(fixture);
  const indexPath = path.join(fixture.root, ".git", "index");
  const beforeIndex = sha256(await readFile(indexPath));

  const identity = await discoverGitRepository(runner);
  assert.equal(identity.workspaceRoot, await realpath(fixture.root));
  assert.equal(identity.branch.state, "attached");
  assert.equal(identity.branch.head, "main");
  assert.equal(identity.bare, false);
  assert.equal(identity.objectFormat, "sha1");
  assert.equal(identity.index.sha256, beforeIndex);
  assert.equal(await revalidateGitRepository(runner, identity), true);

  const status = await captureGitStatusSnapshot(runner);
  assert.ok(status.entries.some((entry) => entry.path.utf8 === "tracked.txt"));
  assert.ok(status.entries.some((entry) => entry.path.utf8 === "line\nbreak.txt"));
  assert.equal(sha256(await readFile(indexPath)), beforeIndex);
  assert.equal(status.submoduleWorktreeEvidence, "not_collected_for_execution_safety");
});

test("reads without executing ambient or repository-configured helpers or writing Git storage", async (t) => {
  const fixture = await createRepository(t);
  const canary = path.join(fixture.root, "helper-ran");
  const helper = path.join(fixture.root, "malicious-helper.sh");
  await writeFile(helper, `#!/bin/sh\ntouch '${canary}'\nexit 1\n`);
  await chmod(helper, 0o755);
  await git(fixture, ["config", "core.pager", helper]);
  await git(fixture, ["config", "diff.external", helper]);
  await git(fixture, ["config", "diff.fixture.textconv", helper]);
  await git(fixture, ["config", "core.fsmonitor", helper]);
  await git(fixture, ["config", "alias.status", `!${helper}`]);
  await git(fixture, ["config", "credential.helper", helper]);
  await git(fixture, ["config", "filter.fixture.clean", helper]);
  await git(fixture, ["config", "filter.fixture.smudge", helper]);
  await git(fixture, ["config", "filter.fixture.process", helper]);
  await writeFile(
    path.join(fixture.ambientHome, ".gitconfig"),
    `[core]\n\tpager = ${helper}\n\tfsmonitor = ${helper}\n[alias]\n\tstatus = !${helper}\n[credential]\n\thelper = ${helper}\n[diff]\n\texternal = ${helper}\n`,
  );
  await writeFile(
    path.join(fixture.root, ".gitattributes"),
    "*.txt diff=fixture filter=fixture\n",
  );
  await writeFile(path.join(fixture.root, "tracked.txt"), "changed\u001b[31m\u202e\n");
  const runner = runnerFor(fixture);
  const gitStorageBefore = await snapshotTree(path.join(fixture.root, ".git"));

  const diff = await readGitDiff(runner, {
    kind: "working",
    paths: ["tracked.txt"],
    maximumFiles: 8,
    maximumRetainedBytes: 4096,
    maximumAbsoluteBytes: 64 * 1024,
  });
  assert.match(diff.text, /changed\\x1b\[31m\\u202e/u);
  assert.equal(diff.truncated, false);
  assert.equal(diff.sha256.length, 64);
  assert.equal(diff.submoduleWorktreeEvidence, "not_collected_for_execution_safety");
  await assert.rejects(access(canary));

  const log = await readGitLog(runner, { maximumCommits: 5, maximumBytes: 64 * 1024 });
  assert.equal(log.length, 1);
  assert.equal(log[0]?.subject, "initial fixture");
  const branch = await readCurrentBranch(runner);
  assert.deepEqual(branch, { state: "attached", name: "main", oid: log[0]?.oid ?? null });
  assert.deepEqual(await snapshotTree(path.join(fixture.root, ".git")), gitStorageBefore);
  await assert.rejects(access(canary));
});

test("marks diff truncation with full consumed hash and rejects an absolute drain overflow", async (t) => {
  const fixture = await createRepository(t);
  await writeFile(path.join(fixture.root, "tracked.txt"), "x".repeat(16_000) + "\n");
  const runner = runnerFor(fixture);
  const diff = await readGitDiff(runner, {
    kind: "working",
    paths: ["tracked.txt"],
    maximumFiles: 8,
    maximumRetainedBytes: 256,
    maximumAbsoluteBytes: 64 * 1024,
  });
  assert.equal(diff.truncated, true);
  assert.equal(diff.sha256.length, 64);
  assert.ok(diff.totalBytes > Buffer.byteLength(diff.text));

  await assert.rejects(
    readGitDiff(runner, {
      kind: "working",
      paths: ["tracked.txt"],
      maximumFiles: 8,
      maximumRetainedBytes: 128,
      maximumAbsoluteBytes: 256,
    }),
  );
});

test("treats model diff paths as literal workspace paths after the option terminator", async (t) => {
  const fixture = await createRepository(t);
  await writeFile(path.join(fixture.root, "literal[ab].txt"), "initial bracket\n");
  await writeFile(path.join(fixture.root, "literala.txt"), "initial plain\n");
  await git(fixture, ["add", "--", "literal[ab].txt", "literala.txt"]);
  await git(fixture, ["commit", "-q", "-m", "literal path fixture"]);
  await writeFile(path.join(fixture.root, "literal[ab].txt"), "changed bracket\n");
  await writeFile(path.join(fixture.root, "literala.txt"), "changed plain\n");

  const diff = await readGitDiff(runnerFor(fixture), {
    kind: "working",
    paths: ["literal[ab].txt"],
    maximumFiles: 1,
    maximumRetainedBytes: 16 * 1024,
    maximumAbsoluteBytes: 64 * 1024,
  });
  assert.match(diff.text, /changed bracket/u);
  assert.doesNotMatch(diff.text, /changed plain/u);
});

test("rejects a symlinked index without releasing outside bytes", async (t) => {
  const fixture = await createRepository(t);
  const outsideCanary = "OUTSIDE_INDEX_CREDENTIAL_CANARY_7c2f";
  const outsideIndex = path.join(fixture.ambientHome, "outside-index");
  await writeFile(outsideIndex, outsideCanary);
  await unlink(path.join(fixture.root, ".git", "index"));
  await symlink(outsideIndex, path.join(fixture.root, ".git", "index"));

  let observed: unknown;
  try {
    await discoverGitRepository(runnerFor(fixture));
  } catch (error: unknown) {
    observed = error;
  }
  assert.equal(
    typeof observed === "object" && observed !== null && "code" in observed
      ? observed.code
      : null,
    "unsafe_repository",
  );
  assert.equal(JSON.stringify(observed).includes(outsideCanary), false);
  assert.equal(String(observed).includes(outsideCanary), false);
});

test("redacts URL and scp-like remote credentials from repository identity", async (t) => {
  const fixture = await createRepository(t);
  const firstSecret = "REMOTE_PASSWORD_CANARY_19d0";
  const secondSecret = "REMOTE_TOKEN_CANARY_834a";
  await git(fixture, [
    "config",
    "remote.origin.url",
    `https://user:${firstSecret}@example.invalid/team/repo.git?access=${firstSecret}#${firstSecret}`,
  ]);
  await git(fixture, [
    "config",
    "--add",
    "remote.origin.url",
    `token:${secondSecret}@git.example.invalid:team/repo.git`,
  ]);

  const identity = await discoverGitRepository(runnerFor(fixture));
  const released = JSON.stringify(identity);
  assert.equal(released.includes(firstSecret), false);
  assert.equal(released.includes(secondSecret), false);
  assert.match(released, /example\.invalid/u);
});

async function createRepository(t: test.TestContext): Promise<{
  readonly root: string;
  readonly gitExecutable: string;
  readonly ambientHome: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "robin-git-"));
  const ambientHome = await mkdtemp(path.join(os.tmpdir(), "robin-git-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(ambientHome, { recursive: true, force: true }));
  const gitExecutable = await findGit();
  const fixture = { root, gitExecutable, ambientHome };
  await git(fixture, ["init", "-q", "-b", "main"]);
  await git(fixture, ["config", "user.name", "Robin Test"]);
  await git(fixture, ["config", "user.email", "robin@example.invalid"]);
  await writeFile(path.join(root, "tracked.txt"), "initial\n");
  await git(fixture, ["add", "--", "tracked.txt"]);
  await git(fixture, ["commit", "-q", "-m", "initial fixture"]);
  return fixture;
}

function runnerFor(fixture: {
  readonly root: string;
  readonly gitExecutable: string;
  readonly ambientHome: string;
}): ControlledGitRunner {
  return new ControlledGitRunner({
    gitExecutable: fixture.gitExecutable,
    cwd: fixture.root,
    environment: {
      PATH: path.dirname(fixture.gitExecutable),
      HOME: fixture.ambientHome,
      TMPDIR: os.tmpdir(),
    },
    timeoutMs: 5_000,
    maximumStdoutBytes: 4 * 1024 * 1024,
    maximumStderrBytes: 256 * 1024,
  });
}

async function git(
  fixture: {
    readonly root: string;
    readonly gitExecutable: string;
    readonly ambientHome: string;
  },
  args: readonly string[],
): Promise<void> {
  await execFileAsync(fixture.gitExecutable, ["-C", fixture.root, ...args], {
    env: { PATH: path.dirname(fixture.gitExecutable), HOME: fixture.ambientHome },
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function findGit(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "git");
    try {
      await access(candidate);
      return realpath(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("Git is required for the tool-git integration suite.");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  await visit(root, "");
  return Object.freeze(result);

  async function visit(directory: string, relative: string): Promise<void> {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolute = path.join(directory, name);
      const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
      const facts = await lstat(absolute);
      if (facts.isDirectory()) {
        result[`${childRelative}/`] = `directory:${facts.mode.toString(8)}`;
        await visit(absolute, childRelative);
      } else if (facts.isFile()) {
        result[childRelative] =
          `file:${facts.mode.toString(8)}:${facts.size}:${sha256(await readFile(absolute))}`;
      } else if (facts.isSymbolicLink()) {
        result[childRelative] = "symbolic-link";
      } else {
        result[childRelative] = `other:${facts.mode.toString(8)}`;
      }
    }
  }
}
