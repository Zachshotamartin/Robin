export interface GitPathIdentity {
  readonly bytesBase64: string;
  readonly utf8: string | null;
  readonly display: string;
  readonly safeForWorkspaceTools: boolean;
}

export type GitBranchState = "attached" | "detached" | "unborn" | "unknown";

export interface GitBranchStatus {
  readonly oid: string | null;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly state: GitBranchState;
}

export type GitStatusEntryKind =
  | "ordinary"
  | "rename_or_copy"
  | "unmerged"
  | "untracked"
  | "ignored";

export interface GitStatusEntry {
  readonly kind: GitStatusEntryKind;
  readonly xy: string;
  readonly submodule: string | null;
  readonly path: GitPathIdentity;
  readonly originalPath: GitPathIdentity | null;
  readonly modes: Readonly<Record<string, string>> | null;
  readonly objectIds: Readonly<Record<string, string>> | null;
  readonly renameOrCopyScore: string | null;
}

export interface ParsedGitStatus {
  readonly branch: GitBranchStatus;
  readonly entries: readonly GitStatusEntry[];
}

export interface GitStatusSnapshot extends ParsedGitStatus {
  readonly capturedAt: string;
  readonly statusSha256: string;
  readonly submoduleWorktreeEvidence: "not_collected_for_execution_safety";
}

export interface GitFilesystemIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
}

export interface GitIndexIdentity {
  readonly path: string;
  readonly exists: boolean;
  readonly fileIdentity: GitFilesystemIdentity | null;
  readonly byteLength: number | null;
  readonly sha256: string | null;
}

export interface GitRemoteIdentity {
  readonly name: string;
  readonly fetchUrls: readonly string[];
}

export interface GitRepositoryIdentity {
  readonly repositoryId: string;
  readonly workspaceRoot: string;
  readonly workspaceRootIdentity: GitFilesystemIdentity;
  readonly gitDirectory: string;
  readonly gitDirectoryIdentity: GitFilesystemIdentity;
  readonly commonDirectory: string;
  readonly commonDirectoryIdentity: GitFilesystemIdentity;
  readonly objectFormat: "sha1" | "sha256";
  readonly branch: GitBranchStatus;
  readonly index: GitIndexIdentity;
  readonly remotes: readonly GitRemoteIdentity[];
  readonly bare: boolean;
  readonly shallow: boolean;
  readonly sparse: boolean;
  readonly linkedWorktree: boolean;
  readonly submodule: boolean;
  readonly operationState: readonly (
    | "merge"
    | "rebase"
    | "cherry_pick"
    | "revert"
    | "bisect"
  )[];
}
