import { lstat } from "node:fs/promises";
import path from "node:path";

import { canonicalSha256Hex, createDomainError } from "@guard/contracts";

import { classifyWorkspacePath } from "./file-classification.js";
import type { WorkspaceIgnorePolicy, IgnoreSource } from "./ignore-rules.js";
import {
  normalizeWorkspaceRelativePath,
  closePinnedWorkspaceDirectory,
  openPinnedWorkspaceDirectory,
  observePhysicalPath,
  readPinnedWorkspaceDirectory,
  revalidatePinnedWorkspaceDirectory,
  type PhysicalPathRaceHooks,
  type PinnedWorkspaceDirectory,
  type WorkspaceRelativePath,
} from "./physical-path.js";
import {
  assertWorkspaceRootStable,
  workspaceHandleState,
  type WorkspaceHandle,
} from "./physical-workspace.js";
import {
  fileBindingFromStats,
  sameFileBinding,
  type FileBinding,
} from "./workspace-identity.js";

export interface FileWalkLimits {
  readonly maximumDepth: number;
  readonly maximumEntries: number;
  readonly maximumResults: number;
  readonly maximumPathBytes: number;
  readonly maximumDurationMs: number;
}

export interface FileWalkEntry {
  readonly path: WorkspaceRelativePath;
  readonly depth: number;
  readonly binding: FileBinding;
  readonly classification: ReturnType<typeof classifyWorkspacePath>;
}

export interface FileWalkOmission {
  readonly reason: IgnoreSource | "depth" | "entry_budget" | "path_budget" | "time" | "error";
  readonly count: number;
}

export interface FileWalkResult {
  readonly entries: readonly FileWalkEntry[];
  readonly omissions: readonly FileWalkOmission[];
  readonly truncated: boolean;
  readonly optionsHash: string;
}

export interface FileWalkDependencies {
  readonly monotonicNow?: () => number;
  readonly raceHooks?: PhysicalPathRaceHooks;
}

export async function walkPhysicalWorkspace(
  workspace: WorkspaceHandle,
  root: unknown,
  ignorePolicy: WorkspaceIgnorePolicy,
  limits: FileWalkLimits,
  signal: AbortSignal,
  dependencies: FileWalkDependencies = {},
): Promise<FileWalkResult> {
  validateLimits(limits);
  assertSignal(signal);
  const canonicalRoot = normalizeWorkspaceRelativePath(root, { allowRoot: true });
  const state = workspaceHandleState(workspace);
  const start = dependencies.monotonicNow ?? (() => performance.now());
  const startedAt = start();
  await assertWorkspaceRootStable(workspace);
  const rootObservation = canonicalRoot.length === 0
    ? null
    : await observePhysicalPath(workspace, canonicalRoot, {
        allowDirectory: true,
        ...(dependencies.raceHooks === undefined
          ? {}
          : { hooks: dependencies.raceHooks }),
      });
  const rootAbsolute = rootObservation?.absolutePath ?? state.physicalRoot;
  const rootBinding = rootObservation?.binding ?? fileBindingFromStats(
    await lstat(state.physicalRoot, { bigint: true }),
  );
  if (rootBinding.identity.kind !== "directory") {
    throw createDomainError({
      code: "invalid_input",
      message: "The list root is not a physical workspace directory.",
    });
  }

  const entries: FileWalkEntry[] = [];
  const omissions = new Map<FileWalkOmission["reason"], number>();
  let visited = 0;
  let pathBytes = 0;
  let truncated = false;

  const visit = async (
    absoluteDirectory: string,
    relativeDirectory: WorkspaceRelativePath,
    depth: number,
    expectedBinding: FileBinding,
  ): Promise<void> => {
    if (truncated) return;
    assertSignal(signal);
    if (start() - startedAt > limits.maximumDurationMs) {
      omit(omissions, "time");
      truncated = true;
      return;
    }
    let directory: PinnedWorkspaceDirectory;
    try {
      directory = await openPinnedWorkspaceDirectory(
        workspace,
        relativeDirectory,
        absoluteDirectory,
        expectedBinding,
      );
    } catch (error: unknown) {
      if (isDomainErrorLike(error)) throw error;
      omit(omissions, "error");
      return;
    }
    let primaryFailure: unknown;
    try {
      const childNames = [...await readPinnedWorkspaceDirectory(
        workspace,
        directory,
        dependencies.raceHooks,
      )].sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      );
      for (const childName of childNames) {
        assertSignal(signal);
        await revalidatePinnedWorkspaceDirectory(workspace, directory);
        visited += 1;
        if (visited > limits.maximumEntries) {
          omit(omissions, "entry_budget");
          truncated = true;
          return;
        }
        const candidateText = relativeDirectory.length === 0
          ? childName
          : `${relativeDirectory}/${childName}`;
        let candidate: WorkspaceRelativePath;
        try {
          candidate = normalizeWorkspaceRelativePath(candidateText, { allowRoot: false });
        } catch {
          omit(omissions, "error");
          continue;
        }
        if (candidate === ".git" || candidate.startsWith(".git/")) {
          omit(omissions, "hard_security");
          continue;
        }
        pathBytes += Buffer.byteLength(candidate, "utf8");
        if (pathBytes > limits.maximumPathBytes) {
          omit(omissions, "path_budget");
          truncated = true;
          return;
        }
        const absolute = path.join(absoluteDirectory, childName);
        let binding: FileBinding;
        try {
          binding = fileBindingFromStats(await lstat(absolute, { bigint: true }));
          await revalidatePinnedWorkspaceDirectory(workspace, directory);
        } catch (error: unknown) {
          if (isDomainErrorLike(error)) throw error;
          omit(omissions, "error");
          continue;
        }
        const classification = classifyWorkspacePath(candidate, binding);
        const ignore = await ignorePolicy.decide(candidate, classification, signal);
        await revalidatePinnedWorkspaceDirectory(workspace, directory);
        let currentBinding: FileBinding;
        try {
          currentBinding = fileBindingFromStats(
            await lstat(absolute, { bigint: true }),
          );
        } catch {
          throw directoryDrift();
        }
        if (!sameFileBinding(currentBinding, binding)) throw directoryDrift();
        if (ignore.ignored) {
          omit(omissions, ignore.source);
          continue;
        }
        if (entries.length < limits.maximumResults) {
          entries.push(Object.freeze({ path: candidate, depth, binding, classification }));
        } else {
          omit(omissions, "entry_budget");
          truncated = true;
          return;
        }
        if (binding.identity.kind === "directory") {
          if (depth >= limits.maximumDepth) {
            omit(omissions, "depth");
          } else {
            await visit(absolute, candidate, depth + 1, binding);
            if (truncated) return;
          }
        }
      }
    } catch (error: unknown) {
      primaryFailure = error;
      throw error;
    } finally {
      try {
        await closePinnedWorkspaceDirectory(directory);
      } catch (error: unknown) {
        if (primaryFailure === undefined) throw error;
      }
    }
  };

  await visit(rootAbsolute, canonicalRoot, 1, rootBinding);
  await assertWorkspaceRootStable(workspace);
  const optionsHash = canonicalSha256Hex({
    root: canonicalRoot,
    limits,
    workspaceId: workspace.identity.workspaceId,
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    omissions: Object.freeze(
      [...omissions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => Object.freeze({ reason, count })),
    ),
    truncated,
    optionsHash,
  });
}

function directoryDrift() {
  return createDomainError({
    code: "conflict",
    message: "A workspace directory changed while it was being enumerated.",
    details: { reason: "workspace_drift" },
  });
}

function isDomainErrorLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && "errorId" in value;
}

function validateLimits(limits: FileWalkLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw createDomainError({
        code: "invalid_input",
        message: `File-walk ${name} must be a positive safe integer.`,
      });
    }
  }
  if (limits.maximumResults > limits.maximumEntries) {
    throw createDomainError({
      code: "invalid_input",
      message: "File-walk maximumResults cannot exceed maximumEntries.",
    });
  }
}

function omit(
  map: Map<FileWalkOmission["reason"], number>,
  reason: FileWalkOmission["reason"],
): void {
  map.set(reason, (map.get(reason) ?? 0) + 1);
}

function assertSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) {
    throw createDomainError({
      code: "invalid_input",
      message: "A physical file walk requires an AbortSignal.",
    });
  }
  if (signal.aborted) {
    throw createDomainError({
      code: "cancelled",
      message: "The physical file walk was cancelled.",
    });
  }
}
