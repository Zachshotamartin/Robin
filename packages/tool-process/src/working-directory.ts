import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { ProcessToolError } from "./process-error.js";
import { parseWorkspaceRelativePath } from "./process-schema.js";

export interface WorkingDirectoryFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly modifiedNanoseconds: string;
}

export interface PreparedWorkingDirectory {
  readonly relativePath: string;
  readonly workspacePhysicalRoot: string;
  readonly physicalPath: string;
  readonly rootIdentity: WorkingDirectoryFileIdentity;
  readonly cwdIdentity: WorkingDirectoryFileIdentity;
  readonly containmentTier: "verified_best_effort";
}

export async function prepareWorkingDirectory(
  workspaceRoot: string,
  relativePath: string,
): Promise<PreparedWorkingDirectory> {
  const normalized = parseWorkspaceRelativePath(relativePath, true, "cwd");
  const workspacePhysicalRoot = await realpath(workspaceRoot).catch(() => {
    throw invalidCwd("The workspace root cannot be resolved.");
  });
  const rootFacts = await lstat(workspacePhysicalRoot, { bigint: true }).catch(() => {
    throw invalidCwd("The workspace root is unavailable.");
  });
  if (!rootFacts.isDirectory() || rootFacts.isSymbolicLink()) {
    throw invalidCwd("The workspace root must resolve to a physical directory.");
  }
  const physicalPath =
    normalized === "."
      ? workspacePhysicalRoot
      : path.join(workspacePhysicalRoot, ...normalized.split("/"));
  if (!isWithin(physicalPath, workspacePhysicalRoot)) {
    throw invalidCwd("The process working directory escapes the workspace.");
  }
  await assertNoSymlinkComponents(workspacePhysicalRoot, normalized);
  const cwdFacts = await lstat(physicalPath, { bigint: true }).catch(() => {
    throw invalidCwd("The process working directory is unavailable.");
  });
  if (!cwdFacts.isDirectory() || cwdFacts.isSymbolicLink()) {
    throw invalidCwd("The process working directory must be a physical directory.");
  }
  const resolvedCwd = await realpath(physicalPath).catch(() => {
    throw invalidCwd("The process working directory cannot be resolved.");
  });
  if (resolvedCwd !== physicalPath || !isWithin(resolvedCwd, workspacePhysicalRoot)) {
    throw invalidCwd("The process working directory changed during resolution.");
  }
  return Object.freeze({
    relativePath: normalized,
    workspacePhysicalRoot,
    physicalPath,
    rootIdentity: identity(rootFacts),
    cwdIdentity: identity(cwdFacts),
    containmentTier: "verified_best_effort",
  });
}

export async function revalidateWorkingDirectory(
  prepared: PreparedWorkingDirectory,
): Promise<boolean> {
  try {
    const rootFacts = await lstat(prepared.workspacePhysicalRoot, { bigint: true });
    if (
      !rootFacts.isDirectory() ||
      rootFacts.isSymbolicLink() ||
      !sameIdentity(identity(rootFacts), prepared.rootIdentity)
    ) {
      return false;
    }
    await assertNoSymlinkComponents(
      prepared.workspacePhysicalRoot,
      prepared.relativePath,
    );
    const cwdFacts = await lstat(prepared.physicalPath, { bigint: true });
    if (
      !cwdFacts.isDirectory() ||
      cwdFacts.isSymbolicLink() ||
      !sameIdentity(identity(cwdFacts), prepared.cwdIdentity)
    ) {
      return false;
    }
    return (
      (await realpath(prepared.workspacePhysicalRoot)) ===
        prepared.workspacePhysicalRoot &&
      (await realpath(prepared.physicalPath)) === prepared.physicalPath &&
      isWithin(prepared.physicalPath, prepared.workspacePhysicalRoot)
    );
  } catch {
    return false;
  }
}

async function assertNoSymlinkComponents(
  root: string,
  relativePath: string,
): Promise<void> {
  if (relativePath === ".") return;
  let current = root;
  for (const component of relativePath.split("/")) {
    current = path.join(current, component);
    const facts = await lstat(current, { bigint: true }).catch(() => {
      throw invalidCwd("A process working-directory component is unavailable.");
    });
    if (facts.isSymbolicLink()) {
      throw invalidCwd("Process working directories cannot traverse symlinks in R2.");
    }
  }
}

function identity(
  facts: BigIntStats,
): WorkingDirectoryFileIdentity {
  return Object.freeze({
    device: facts.dev.toString(),
    inode: facts.ino.toString(),
    mode: facts.mode.toString(),
    modifiedNanoseconds: facts.mtimeNs.toString(),
  });
}

function sameIdentity(
  left: WorkingDirectoryFileIdentity,
  right: WorkingDirectoryFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode
  );
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function invalidCwd(message: string): ProcessToolError {
  return new ProcessToolError("cwd_invalid", message);
}
