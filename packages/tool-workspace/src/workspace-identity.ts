import { canonicalSha256Hex, createDomainError } from "@guard/contracts";
import type { JsonObject } from "@guard/contracts";
import type { BigIntStats } from "node:fs";

export type WorkspaceOrigin =
  | "launch_directory"
  | "explicit_flag"
  | "resume_record";

export type PhysicalObjectKind =
  | "regular_file"
  | "directory"
  | "symlink"
  | "socket"
  | "fifo"
  | "block_device"
  | "character_device"
  | "unknown";

export interface FileIdentity extends JsonObject {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly kind: PhysicalObjectKind;
}

export interface FileBinding extends JsonObject {
  readonly identity: FileIdentity;
  readonly size: number;
  readonly links: number;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
}

export interface GitWorkspaceIdentity extends JsonObject {
  readonly worktreeRoot: string;
  readonly commonDirectory: string;
  readonly gitDirectory: string;
  readonly objectFormat: "sha1" | "sha256" | "unknown";
  readonly initialHead: string | null;
  readonly branch: string | null;
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly linked: boolean;
  readonly bare: boolean;
  readonly shallow: boolean;
  readonly sparse: boolean;
  readonly submodule: boolean;
  readonly operationState:
    | "none"
    | "merge"
    | "rebase"
    | "cherry_pick"
    | "revert"
    | "bisect"
    | "unknown";
  readonly initialStatusHash: string;
}

export interface MountCapabilities extends JsonObject {
  readonly containmentTier:
    | "descriptor_strong"
    | "verified_best_effort"
    | "unavailable";
  readonly noFollowOpen: boolean;
  readonly noAtimeRead: boolean;
  readonly directoryFsync: "supported" | "unsupported" | "unknown";
  readonly stableFileIdentity: boolean;
}

export interface WorkspaceIdentity extends JsonObject {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly bindingHash: string;
  readonly physicalRoot: string;
  readonly rootFileIdentity: FileIdentity;
  readonly caseSensitivity: "sensitive" | "insensitive" | "unknown";
  readonly unicodeNormalization: "nfc" | "platform";
  readonly git: GitWorkspaceIdentity | null;
  readonly mountCapabilities: MountCapabilities;
  readonly createdFrom: WorkspaceOrigin;
  readonly accessMode: "read_write" | "read_only";
}

export interface GitWorkspaceProbeResult {
  readonly worktreeRoot: string;
  readonly commonDirectory: string;
  readonly gitDirectory: string;
  readonly objectFormat: "sha1" | "sha256" | "unknown";
  readonly initialHead: string | null;
  readonly branch: string | null;
  readonly linked: boolean;
  readonly bare: boolean;
  readonly shallow: boolean;
  readonly sparse: boolean;
  readonly submodule: boolean;
  readonly operationState: GitWorkspaceIdentity["operationState"];
  readonly initialStatusHash: string;
}

export interface WorkspaceGitProbe {
  inspect(
    physicalStartDirectory: string,
    signal: AbortSignal,
  ): Promise<GitWorkspaceProbeResult | null>;
}

export function fileIdentityFromStats(stats: BigIntStats): FileIdentity {
  return Object.freeze({
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    mode: safeStatNumber(stats.mode, "mode"),
    kind: objectKind(stats),
  });
}

export function fileBindingFromStats(stats: BigIntStats): FileBinding {
  return Object.freeze({
    identity: fileIdentityFromStats(stats),
    size: safeStatNumber(stats.size, "size"),
    links: safeStatNumber(stats.nlink, "link count"),
    modifiedNanoseconds: stats.mtimeNs.toString(10),
    changedNanoseconds: stats.ctimeNs.toString(10),
  });
}

export function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.kind === right.kind
  );
}

export function sameFileBinding(
  left: FileBinding,
  right: FileBinding,
): boolean {
  return (
    sameFileIdentity(left.identity, right.identity) &&
    left.size === right.size &&
    left.links === right.links &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds
  );
}

export function createGitWorkspaceIdentity(
  value: GitWorkspaceProbeResult,
  physicalRoot: string,
): GitWorkspaceIdentity {
  const stableRepositoryFacts = {
    commonDirectory: value.commonDirectory,
    objectFormat: value.objectFormat,
  };
  const stableWorktreeFacts = {
    gitDirectory: value.gitDirectory,
    physicalRoot,
    worktreeRoot: value.worktreeRoot,
  };
  return Object.freeze({
    ...value,
    repositoryId: `repository:${canonicalSha256Hex(stableRepositoryFacts)}`,
    worktreeId: `worktree:${canonicalSha256Hex(stableWorktreeFacts)}`,
  });
}

export function createWorkspaceIdentity(input: {
  readonly physicalRoot: string;
  readonly rootFileIdentity: FileIdentity;
  readonly caseSensitivity: WorkspaceIdentity["caseSensitivity"];
  readonly unicodeNormalization: WorkspaceIdentity["unicodeNormalization"];
  readonly git: GitWorkspaceIdentity | null;
  readonly mountCapabilities: MountCapabilities;
  readonly createdFrom: WorkspaceOrigin;
  readonly accessMode: WorkspaceIdentity["accessMode"];
}): WorkspaceIdentity {
  const stableFacts = {
    physicalRoot: input.physicalRoot,
    rootFileIdentity: input.rootFileIdentity,
    gitRepositoryId: input.git?.repositoryId ?? null,
    gitWorktreeId: input.git?.worktreeId ?? null,
  };
  const workspaceId = `workspace:${canonicalSha256Hex(stableFacts)}`;
  const withoutBindingHash = {
    schemaVersion: 1 as const,
    workspaceId,
    physicalRoot: input.physicalRoot,
    rootFileIdentity: input.rootFileIdentity,
    caseSensitivity: input.caseSensitivity,
    unicodeNormalization: input.unicodeNormalization,
    git: input.git,
    mountCapabilities: input.mountCapabilities,
    createdFrom: input.createdFrom,
    accessMode: input.accessMode,
  };
  return Object.freeze({
    ...withoutBindingHash,
    bindingHash: canonicalSha256Hex(withoutBindingHash),
  });
}

function objectKind(stats: BigIntStats): PhysicalObjectKind {
  if (stats.isFile()) return "regular_file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isSocket()) return "socket";
  if (stats.isFIFO()) return "fifo";
  if (stats.isBlockDevice()) return "block_device";
  if (stats.isCharacterDevice()) return "character_device";
  return "unknown";
}

function safeStatNumber(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw createDomainError({
      code: "invalid_input",
      message: `Workspace ${label} is outside the supported range.`,
    });
  }
  return result;
}
