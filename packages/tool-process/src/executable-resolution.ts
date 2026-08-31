import { constants } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { ProcessToolError } from "./process-error.js";

export interface ExecutableFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly modifiedNanoseconds: string;
  readonly mode: string;
}

export interface ExecutableResolutionPolicy {
  readonly trustedPath: readonly string[];
  readonly workspaceRoot: string;
  readonly trustedExecutableRoots: readonly string[];
  readonly allowWorkspaceExecutables: boolean;
}

export interface ResolvedExecutable {
  readonly requested: string;
  readonly candidatePath: string;
  readonly physicalPath: string;
  readonly source: "trusted_path" | "trusted_absolute" | "workspace_relative";
  readonly identity: ExecutableFileIdentity;
  readonly containment: "trusted_root" | "workspace";
}

export async function resolveExecutable(
  requested: string,
  policy: ExecutableResolutionPolicy,
): Promise<ResolvedExecutable> {
  validateRequestedExecutable(requested);
  const workspaceRoot = await realpath(policy.workspaceRoot).catch(() => {
    throw new ProcessToolError(
      "invalid_request",
      "The process workspace root cannot be resolved.",
    );
  });
  const trustedRoots = await Promise.all(
    policy.trustedExecutableRoots.map(async (root) => {
      if (!path.isAbsolute(root)) {
        throw new ProcessToolError(
          "invalid_request",
          "Trusted executable roots must be absolute paths.",
        );
      }
      return realpath(root).catch(() => {
        throw new ProcessToolError(
          "invalid_request",
          "A trusted executable root cannot be resolved.",
        );
      });
    }),
  );

  const hasSeparator = requested.includes("/") || requested.includes("\\");
  if (!hasSeparator && !path.isAbsolute(requested)) {
    for (const entry of policy.trustedPath) {
      if (!path.isAbsolute(entry)) {
        throw new ProcessToolError(
          "invalid_request",
          "The trusted executable PATH contains a relative entry.",
        );
      }
      const physicalEntry = await realpath(entry).catch(() => null);
      if (physicalEntry === null) continue;
      const entryContainment = containment(
        physicalEntry,
        workspaceRoot,
        trustedRoots,
        policy.allowWorkspaceExecutables,
      );
      if (entryContainment === null) continue;
      const candidate = path.join(physicalEntry, requested);
      const resolved = await inspectCandidate(
        requested,
        candidate,
        "trusted_path",
        workspaceRoot,
        trustedRoots,
        policy.allowWorkspaceExecutables,
      );
      if (resolved !== null) return resolved;
    }
    throw new ProcessToolError(
      "executable_not_found",
      "The executable was not found on the reviewed PATH.",
    );
  }

  if (path.isAbsolute(requested)) {
    const resolved = await inspectCandidate(
      requested,
      requested,
      "trusted_absolute",
      workspaceRoot,
      trustedRoots,
      policy.allowWorkspaceExecutables,
    );
    if (resolved !== null) return resolved;
    throw new ProcessToolError(
      "executable_not_found",
      "The absolute executable is missing, ineligible, or not executable.",
    );
  }

  if (
    !policy.allowWorkspaceExecutables ||
    requested.includes("\\") ||
    requested.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new ProcessToolError(
      "invalid_request",
      "A workspace-relative executable is not permitted by this profile.",
    );
  }
  const candidate = path.resolve(workspaceRoot, requested);
  if (!isWithin(candidate, workspaceRoot)) {
    throw new ProcessToolError(
      "invalid_request",
      "The workspace-relative executable escapes the workspace.",
    );
  }
  const resolved = await inspectCandidate(
    requested,
    candidate,
    "workspace_relative",
    workspaceRoot,
    trustedRoots,
    true,
  );
  if (resolved !== null) return resolved;
  throw new ProcessToolError(
    "executable_not_found",
    "The workspace-relative executable is missing or not executable.",
  );
}

export async function revalidateExecutable(
  executable: ResolvedExecutable,
): Promise<boolean> {
  try {
    const physical = await realpath(executable.candidatePath);
    if (physical !== executable.physicalPath) return false;
    const identity = await executableIdentity(physical);
    return sameIdentity(identity, executable.identity);
  } catch {
    return false;
  }
}

async function inspectCandidate(
  requested: string,
  candidatePath: string,
  source: ResolvedExecutable["source"],
  workspaceRoot: string,
  trustedRoots: readonly string[],
  allowWorkspaceExecutables: boolean,
): Promise<ResolvedExecutable | null> {
  try {
    const physicalPath = await realpath(candidatePath);
    const capturedContainment = containment(
      physicalPath,
      workspaceRoot,
      trustedRoots,
      allowWorkspaceExecutables,
    );
    if (capturedContainment === null) return null;
    const identity = await executableIdentity(physicalPath);
    return Object.freeze({
      requested,
      candidatePath,
      physicalPath,
      source,
      identity,
      containment: capturedContainment,
    });
  } catch {
    return null;
  }
}

async function executableIdentity(
  physicalPath: string,
): Promise<ExecutableFileIdentity> {
  const facts = await stat(physicalPath, { bigint: true });
  if (!facts.isFile() || (facts.mode & BigInt(constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH)) === 0n) {
    throw new ProcessToolError(
      "executable_not_found",
      "The resolved executable is not an executable regular file.",
    );
  }
  return Object.freeze({
    device: facts.dev.toString(),
    inode: facts.ino.toString(),
    size: facts.size.toString(),
    modifiedNanoseconds: facts.mtimeNs.toString(),
    mode: facts.mode.toString(),
  });
}

function containment(
  candidate: string,
  workspaceRoot: string,
  trustedRoots: readonly string[],
  allowWorkspaceExecutables: boolean,
): ResolvedExecutable["containment"] | null {
  if (trustedRoots.some((root) => isWithin(candidate, root))) return "trusted_root";
  if (allowWorkspaceExecutables && isWithin(candidate, workspaceRoot)) return "workspace";
  return null;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sameIdentity(
  left: ExecutableFileIdentity,
  right: ExecutableFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.mode === right.mode
  );
}

function validateRequestedExecutable(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > 4_096
  ) {
    throw new ProcessToolError(
      "invalid_request",
      "The executable request is invalid.",
    );
  }
}
