import { constants } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { createDomainError } from "@guard/contracts";

import {
  createGitWorkspaceIdentity,
  createWorkspaceIdentity,
  fileIdentityFromStats,
  sameFileIdentity,
  type WorkspaceGitProbe,
  type WorkspaceIdentity,
  type WorkspaceOrigin,
} from "./workspace-identity.js";

declare const workspaceHandleBrand: unique symbol;

export interface WorkspaceHandle {
  readonly identity: WorkspaceIdentity;
  readonly displayRoot: string;
  readonly [workspaceHandleBrand]: true;
}

interface WorkspaceHandleState {
  readonly identity: WorkspaceIdentity;
  readonly displayRoot: string;
  readonly physicalRoot: string;
}

const HANDLE_STATES = new WeakMap<object, WorkspaceHandleState>();

export interface DiscoverPhysicalWorkspaceRequest {
  readonly startDirectory: string;
  readonly createdFrom: WorkspaceOrigin;
}

export interface DiscoverPhysicalWorkspaceDependencies {
  readonly gitProbe?: WorkspaceGitProbe;
  readonly caseSensitivity?: WorkspaceIdentity["caseSensitivity"];
  readonly unicodeNormalization?: WorkspaceIdentity["unicodeNormalization"];
}

export async function discoverPhysicalWorkspace(
  request: DiscoverPhysicalWorkspaceRequest,
  dependencies: DiscoverPhysicalWorkspaceDependencies = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<WorkspaceHandle> {
  assertSignal(signal);
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.startDirectory !== "string" ||
    request.startDirectory.length === 0 ||
    !isWorkspaceOrigin(request.createdFrom) ||
    request.startDirectory.includes("\u0000")
  ) {
    throw invalid("Workspace discovery requires a valid start directory and origin.");
  }

  let physicalStart: string;
  try {
    physicalStart = await realpath(request.startDirectory);
    const startStats = await lstat(physicalStart, { bigint: true });
    if (!startStats.isDirectory() || startStats.isSymbolicLink()) {
      throw invalid("The requested workspace start must resolve to a directory.");
    }
  } catch (error: unknown) {
    if (isWorkspaceError(error)) throw error;
    throw unavailable("The requested workspace directory is unavailable.");
  }
  assertSignal(signal);

  const gitFacts = dependencies.gitProbe === undefined
    ? null
    : await dependencies.gitProbe.inspect(physicalStart, signal);
  assertSignal(signal);
  if (gitFacts === null && request.createdFrom !== "explicit_flag") {
    throw unavailable(
      "A non-repository workspace requires an explicit workspace selection.",
    );
  }

  let physicalRoot = physicalStart;
  if (gitFacts !== null && !gitFacts.bare) {
    try {
      const discoveredRoot = await realpath(gitFacts.worktreeRoot);
      const relative = path.relative(discoveredRoot, physicalStart);
      if (
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      ) {
        throw unavailable("Git reported a worktree that does not contain the start directory.");
      }
      physicalRoot = discoveredRoot;
    } catch (error: unknown) {
      if (isWorkspaceError(error)) throw error;
      throw unavailable("The discovered Git worktree root is unavailable.");
    }
  }
  if (gitFacts?.bare === true) {
    throw unavailable("Bare Git repositories are not writable Robin workspaces in R2.");
  }

  const rootStats = await lstat(physicalRoot, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw unavailable("The physical workspace root is not a stable directory.");
  }
  const rootFileIdentity = fileIdentityFromStats(rootStats);
  const caseSensitivity =
    dependencies.caseSensitivity ?? defaultCaseSensitivity();
  const unicodeNormalization =
    dependencies.unicodeNormalization ??
    (process.platform === "darwin" ? "platform" : "nfc");
  const mountCapabilities = Object.freeze({
    containmentTier:
      typeof constants.O_NOFOLLOW === "number"
        ? ("verified_best_effort" as const)
        : ("unavailable" as const),
    noFollowOpen: typeof constants.O_NOFOLLOW === "number",
    noAtimeRead: typeof constants.O_NOATIME === "number",
    directoryFsync: "unknown" as const,
    stableFileIdentity:
      rootFileIdentity.device !== "0" && rootFileIdentity.inode !== "0",
  });
  const git = gitFacts === null
    ? null
    : createGitWorkspaceIdentity(gitFacts, physicalRoot);
  const identity = createWorkspaceIdentity({
    physicalRoot,
    rootFileIdentity,
    caseSensitivity,
    unicodeNormalization,
    git,
    mountCapabilities,
    createdFrom: request.createdFrom,
    accessMode: git === null ? "read_only" : "read_write",
  });
  const handle = Object.freeze({
    identity,
    displayRoot: path.resolve(request.startDirectory),
  }) as WorkspaceHandle;
  HANDLE_STATES.set(handle, Object.freeze({
    identity,
    displayRoot: handle.displayRoot,
    physicalRoot,
  }));
  return handle;
}

export function workspaceHandleState(handle: WorkspaceHandle): WorkspaceHandleState {
  const state = HANDLE_STATES.get(handle as object);
  if (state === undefined || handle.identity !== state.identity) {
    throw createDomainError({
      code: "invariant_violated",
      message: "A physical workspace operation requires a trusted workspace handle.",
    });
  }
  return state;
}

export async function assertWorkspaceRootStable(
  handle: WorkspaceHandle,
): Promise<void> {
  const state = workspaceHandleState(handle);
  try {
    const current = await lstat(state.physicalRoot, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameFileIdentity(
        fileIdentityFromStats(current),
        state.identity.rootFileIdentity,
      )
    ) {
      throw drift();
    }
  } catch (error: unknown) {
    if (isWorkspaceError(error)) throw error;
    throw drift();
  }
}

function defaultCaseSensitivity(): WorkspaceIdentity["caseSensitivity"] {
  if (process.platform === "win32") return "insensitive";
  return "unknown";
}

function isWorkspaceOrigin(value: unknown): value is WorkspaceOrigin {
  return (
    value === "launch_directory" ||
    value === "explicit_flag" ||
    value === "resume_record"
  );
}

function assertSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) {
    throw invalid("Workspace discovery requires an AbortSignal.");
  }
  if (signal.aborted) {
    throw createDomainError({
      code: "cancelled",
      message: "Workspace discovery was cancelled.",
    });
  }
}

function isWorkspaceError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly code?: unknown }).code === "string" &&
    "errorId" in value
  );
}

function invalid(message: string) {
  return createDomainError({ code: "invalid_input", message });
}

function unavailable(message: string) {
  return createDomainError({ code: "infrastructure_failed", message });
}

function drift() {
  return createDomainError({
    code: "conflict",
    message: "The physical workspace root changed after discovery.",
    details: { reason: "workspace_drift" },
  });
}
