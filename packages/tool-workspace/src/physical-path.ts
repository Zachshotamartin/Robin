import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { createDomainError, isDomainError } from "@guard/contracts";

import {
  assertWorkspaceRootStable,
  workspaceHandleState,
  type WorkspaceHandle,
} from "./physical-workspace.js";
import {
  fileBindingFromStats,
  sameFileBinding,
  sameFileIdentity,
  type FileBinding,
  type PhysicalObjectKind,
} from "./workspace-identity.js";

export type WorkspaceRelativePath = string & {
  readonly __workspaceRelativePath: unique symbol;
};

export const MAXIMUM_WORKSPACE_PATH_BYTES = 4_096;
export const MAXIMUM_WORKSPACE_COMPONENT_BYTES = 255;
export const MAXIMUM_WORKSPACE_COMPONENTS = 256;

export interface PhysicalPathObservation {
  readonly path: WorkspaceRelativePath;
  readonly absolutePath: string;
  readonly binding: FileBinding;
}

export interface StableOpenFile {
  readonly path: WorkspaceRelativePath;
  readonly absolutePath: string;
  readonly handle: FileHandle;
  readonly binding: FileBinding;
  readonly atimePreserved: boolean;
}

export interface PhysicalPathRaceHooks {
  beforeDirectoryRead?(path: WorkspaceRelativePath): void | Promise<void>;
  afterDirectoryRead?(path: WorkspaceRelativePath): void | Promise<void>;
  afterParentWalk?(path: WorkspaceRelativePath): void | Promise<void>;
  afterOpen?(path: WorkspaceRelativePath): void | Promise<void>;
  beforeFinalRevalidation?(path: WorkspaceRelativePath): void | Promise<void>;
}

export interface PinnedWorkspaceDirectory {
  readonly path: WorkspaceRelativePath;
  readonly absolutePath: string;
  readonly handle: FileHandle;
  readonly binding: FileBinding;
}

export function normalizeWorkspaceRelativePath(
  value: unknown,
  options: { readonly allowRoot: boolean },
): WorkspaceRelativePath {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) {
    throw invalid("Workspace paths must be well-formed Unicode strings.");
  }
  if (value.includes("\u0000")) {
    throw invalid("Workspace paths must not contain NUL bytes.");
  }
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_WORKSPACE_PATH_BYTES) {
    throw invalid("Workspace path exceeds the configured byte bound.");
  }
  if (value.length === 0) {
    if (options.allowRoot) return "" as WorkspaceRelativePath;
    throw invalid("A workspace file path must not be empty.");
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.startsWith("//") ||
    /^[A-Za-z]:/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) ||
    value.includes("\\")
  ) {
    throw invalid("Workspace path uses an absolute or ambiguous separator form.");
  }
  if (/%(?:2e|2f|5c)/iu.test(value)) {
    throw invalid("Workspace path uses an encoded separator or traversal form.");
  }
  const segments = value.split("/");
  if (
    segments.length > MAXIMUM_WORKSPACE_COMPONENTS ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > MAXIMUM_WORKSPACE_COMPONENT_BYTES,
    )
  ) {
    throw invalid("Workspace path contains an empty, dot, traversal, or oversized component.");
  }
  const normalized = segments.map((segment) => segment.normalize("NFC")).join("/");
  if (Buffer.byteLength(normalized, "utf8") > MAXIMUM_WORKSPACE_PATH_BYTES) {
    throw invalid("Canonical workspace path exceeds the configured byte bound.");
  }
  return normalized as WorkspaceRelativePath;
}

export function isGitAdministrativePath(value: WorkspaceRelativePath): boolean {
  const first = value.split("/", 1)[0];
  return first?.toLocaleLowerCase("en-US") === ".git";
}

export async function observePhysicalPath(
  workspace: WorkspaceHandle,
  requestedPath: unknown,
  options: {
    readonly allowLeafSymlink?: boolean;
    readonly allowDirectory?: boolean;
    readonly allowGitAdministrativePath?: boolean;
    readonly hooks?: PhysicalPathRaceHooks;
  } = {},
): Promise<PhysicalPathObservation> {
  const canonical = normalizeWorkspaceRelativePath(requestedPath, {
    allowRoot: false,
  });
  if (!options.allowGitAdministrativePath && isGitAdministrativePath(canonical)) {
    throw invalid("Git administrative paths are not available to workspace tools.");
  }
  const state = workspaceHandleState(workspace);
  await assertWorkspaceRootStable(workspace);
  const segments = canonical.split("/");
  let current = state.physicalRoot;
  let currentRelative = "" as WorkspaceRelativePath;
  let leafStats: BigIntStats | null = null;
  const pinned: PinnedWorkspaceDirectory[] = [];
  let primaryFailure: unknown;
  try {
    let currentDirectory = await openPinnedWorkspaceDirectory(
      workspace,
      currentRelative,
      current,
    );
    pinned.push(currentDirectory);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const names = await readPinnedWorkspaceDirectory(
        workspace,
        currentDirectory,
        options.hooks,
      );
      const physicalSegment = selectCanonicalDirectoryEntry(
        names,
        segment,
        workspace.identity.caseSensitivity,
      );
      const childAbsolute = path.join(current, physicalSegment);
      let stats: BigIntStats;
      try {
        stats = await lstat(childAbsolute, { bigint: true });
      } catch {
        throw missing("The requested workspace path does not exist.", canonical);
      }
      await revalidatePinnedWorkspaceDirectory(workspace, currentDirectory);
      const leaf = index === segments.length - 1;
      if (stats.isSymbolicLink() && (!leaf || !options.allowLeafSymlink)) {
        throw invalid("Workspace tools do not follow symbolic links in R2.");
      }
      if (!leaf && !stats.isDirectory()) {
        throw invalid("A workspace path parent is not a directory.");
      }
      current = childAbsolute;
      currentRelative = segments.slice(0, index + 1).join("/") as WorkspaceRelativePath;
      if (leaf) {
        leafStats = stats;
      } else {
        currentDirectory = await openPinnedWorkspaceDirectory(
          workspace,
          currentRelative,
          current,
          fileBindingFromStats(stats),
        );
        pinned.push(currentDirectory);
      }
    }
    await options.hooks?.afterParentWalk?.(canonical);
    for (const directory of pinned) {
      await revalidatePinnedWorkspaceDirectory(workspace, directory);
    }
    assertContained(state.physicalRoot, current);
    if (leafStats === null) {
      throw createDomainError({
        code: "invariant_violated",
        message: "A physical path observation did not produce target metadata.",
      });
    }
    if (leafStats.isDirectory() && !options.allowDirectory) {
      throw invalid("The requested workspace path is a directory.");
    }
    await assertFinalPhysicalBinding(
      workspace,
      current,
      fileBindingFromStats(leafStats),
      leafStats.isSymbolicLink() && options.allowLeafSymlink === true,
    );
    for (const directory of pinned) {
      await revalidatePinnedWorkspaceDirectory(workspace, directory);
    }
    return Object.freeze({
      path: canonical,
      absolutePath: current,
      binding: fileBindingFromStats(leafStats),
    });
  } catch (error: unknown) {
    primaryFailure = error;
    throw error;
  } finally {
    await closePinnedDirectories(pinned, primaryFailure === undefined);
  }
}

export async function observePhysicalParentForCreate(
  workspace: WorkspaceHandle,
  requestedPath: unknown,
  options: { readonly hooks?: PhysicalPathRaceHooks } = {},
): Promise<{
  readonly path: WorkspaceRelativePath;
  readonly absolutePath: string;
  readonly parentAbsolutePath: string;
  readonly parentBinding: FileBinding;
}> {
  const canonical = normalizeWorkspaceRelativePath(requestedPath, {
    allowRoot: false,
  });
  if (isGitAdministrativePath(canonical)) {
    throw invalid("Git administrative paths cannot be created by workspace tools.");
  }
  const segments = canonical.split("/");
  const leaf = segments.pop()!;
  const state = workspaceHandleState(workspace);
  await assertWorkspaceRootStable(workspace);
  let current = state.physicalRoot;
  let currentRelative = "" as WorkspaceRelativePath;
  const pinned: PinnedWorkspaceDirectory[] = [];
  let primaryFailure: unknown;
  try {
    let currentDirectory = await openPinnedWorkspaceDirectory(
      workspace,
      currentRelative,
      current,
    );
    pinned.push(currentDirectory);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const names = await readPinnedWorkspaceDirectory(
        workspace,
        currentDirectory,
        options.hooks,
      );
      const physicalSegment = selectCanonicalDirectoryEntry(
        names,
        segment,
        workspace.identity.caseSensitivity,
      );
      const child = path.join(current, physicalSegment);
      const stats = await lstat(child, { bigint: true });
      await revalidatePinnedWorkspaceDirectory(workspace, currentDirectory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw invalid("A create-file parent is not a stable physical directory.");
      }
      current = child;
      currentRelative = segments.slice(0, index + 1).join("/") as WorkspaceRelativePath;
      currentDirectory = await openPinnedWorkspaceDirectory(
        workspace,
        currentRelative,
        current,
        fileBindingFromStats(stats),
      );
      pinned.push(currentDirectory);
    }
    await options.hooks?.afterParentWalk?.(canonical);
    for (const directory of pinned) {
      await revalidatePinnedWorkspaceDirectory(workspace, directory);
    }
    assertContained(state.physicalRoot, current);
    const target = path.join(current, leaf);
    try {
      await lstat(target, { bigint: true });
      throw createDomainError({
        code: "conflict",
        message: "The create-file target already exists.",
        details: { path: canonical },
      });
    } catch (error: unknown) {
      if (isDomainError(error)) throw error;
      if (!isNodeErrorCode(error, "ENOENT")) {
        throw createDomainError({
          code: "action_failed",
          message: "The create-file target could not be inspected safely.",
        });
      }
    }
    for (const directory of pinned) {
      await revalidatePinnedWorkspaceDirectory(workspace, directory);
    }
    return Object.freeze({
      path: canonical,
      absolutePath: target,
      parentAbsolutePath: current,
      parentBinding: currentDirectory.binding,
    });
  } catch (error: unknown) {
    primaryFailure = error;
    throw error;
  } finally {
    await closePinnedDirectories(pinned, primaryFailure === undefined);
  }
}

export async function openStableRegularFile(
  workspace: WorkspaceHandle,
  requestedPath: unknown,
  options: {
    readonly maximumFileBytes: number;
    readonly preserveAtime?: boolean;
    readonly expectedBinding?: FileBinding;
    readonly hooks?: PhysicalPathRaceHooks;
  },
): Promise<StableOpenFile> {
  const observed = await observePhysicalPath(workspace, requestedPath, {
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  if (observed.binding.identity.kind !== "regular_file") {
    throw invalid("Only regular workspace files can be opened.");
  }
  if (observed.binding.size > positiveLimit(options.maximumFileBytes, "file byte")) {
    throw budget("The workspace file exceeds the configured byte limit.");
  }
  if (
    options.expectedBinding !== undefined &&
    !sameFileBinding(observed.binding, options.expectedBinding)
  ) {
    throw stale("The workspace file changed after it was observed.");
  }
  const noFollow =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const noAtime =
    options.preserveAtime === true && typeof constants.O_NOATIME === "number"
      ? constants.O_NOATIME
      : 0;
  let handle: FileHandle;
  let atimePreserved = noAtime !== 0;
  try {
    handle = await open(observed.absolutePath, constants.O_RDONLY | noFollow | noAtime);
  } catch (error: unknown) {
    if (noAtime !== 0 && (isNodeErrorCode(error, "EPERM") || isNodeErrorCode(error, "EINVAL"))) {
      atimePreserved = false;
      handle = await open(observed.absolutePath, constants.O_RDONLY | noFollow);
    } else {
      throw stale("The workspace file changed before it could be opened.");
    }
  }
  try {
    const stats = await handle.stat({ bigint: true });
    const binding = fileBindingFromStats(stats);
    if (
      binding.identity.kind !== "regular_file" ||
      binding.size > options.maximumFileBytes ||
      !sameFileBinding(binding, observed.binding)
    ) {
      throw stale("The opened workspace object no longer matches its path metadata.");
    }
    await options.hooks?.afterOpen?.(observed.path);
    await assertPathStillBinds(workspace, observed, binding);
    return Object.freeze({
      path: observed.path,
      absolutePath: observed.absolutePath,
      handle,
      binding,
      atimePreserved,
    });
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function finishStableRead(
  workspace: WorkspaceHandle,
  opened: StableOpenFile,
  hooks?: PhysicalPathRaceHooks,
): Promise<FileBinding> {
  await hooks?.beforeFinalRevalidation?.(opened.path);
  const after = fileBindingFromStats(await opened.handle.stat({ bigint: true }));
  if (!sameFileBinding(after, opened.binding)) {
    throw stale("The workspace file changed while it was being read.");
  }
  await assertPathStillBinds(
    workspace,
    {
      path: opened.path,
      absolutePath: opened.absolutePath,
      binding: opened.binding,
    },
    after,
  );
  return after;
}

export async function closeStableFile(opened: StableOpenFile): Promise<void> {
  try {
    await opened.handle.close();
  } catch {
    throw createDomainError({
      code: "action_failed",
      message: "A workspace file handle could not be closed safely.",
    });
  }
}

export function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw invalid("A physical workspace path escaped its bound root.");
  }
}

async function assertPathStillBinds(
  workspace: WorkspaceHandle,
  observed: PhysicalPathObservation,
  openedBinding: FileBinding,
): Promise<void> {
  await assertWorkspaceRootStable(workspace);
  try {
    const canonical = await realpath(observed.absolutePath);
    const state = workspaceHandleState(workspace);
    assertContained(state.physicalRoot, canonical);
    const pathStats = await lstat(observed.absolutePath, { bigint: true });
    if (
      pathStats.isSymbolicLink() ||
      !sameFileIdentity(
        fileBindingFromStats(pathStats).identity,
        openedBinding.identity,
      )
    ) {
      throw stale("The workspace path no longer names the opened object.");
    }
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw stale("The workspace path changed while its object was open.");
  }
}

export async function openPinnedWorkspaceDirectory(
  workspace: WorkspaceHandle,
  workspacePath: WorkspaceRelativePath,
  absolutePath: string,
  expectedBinding?: FileBinding,
): Promise<PinnedWorkspaceDirectory> {
  const state = workspaceHandleState(workspace);
  assertContained(state.physicalRoot, absolutePath);
  await assertWorkspaceRootStable(workspace);
  let before: FileBinding;
  try {
    const stats = await lstat(absolutePath, { bigint: true });
    before = fileBindingFromStats(stats);
  } catch {
    throw stale("A workspace directory disappeared before it could be pinned.");
  }
  if (
    before.identity.kind !== "directory" ||
    (expectedBinding !== undefined && !sameFileBinding(before, expectedBinding))
  ) {
    throw stale("A workspace directory changed before it could be pinned.");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryOnly =
    typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | noFollow | directoryOnly);
  } catch {
    throw stale("A workspace directory changed before it could be opened.");
  }
  try {
    const opened = fileBindingFromStats(await handle.stat({ bigint: true }));
    if (
      opened.identity.kind !== "directory" ||
      !sameFileBinding(opened, before)
    ) {
      throw stale("An opened workspace directory did not match its path binding.");
    }
    const pinned = Object.freeze({
      path: workspacePath,
      absolutePath,
      handle,
      binding: opened,
    });
    await revalidatePinnedWorkspaceDirectory(workspace, pinned);
    return pinned;
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function readPinnedWorkspaceDirectory(
  workspace: WorkspaceHandle,
  directory: PinnedWorkspaceDirectory,
  hooks?: PhysicalPathRaceHooks,
): Promise<readonly string[]> {
  await hooks?.beforeDirectoryRead?.(directory.path);
  await revalidatePinnedWorkspaceDirectory(workspace, directory);
  let names: string[];
  try {
    // Node has no portable readdir(dirfd). Keep the no-follow directory handle
    // pinned, stage pathname enumeration, and expose no name until both the
    // descriptor and pathname have revalidated against the captured binding.
    names = await readdir(directory.absolutePath, { encoding: "utf8" });
  } catch {
    throw stale("A pinned workspace directory could not be enumerated safely.");
  }
  await hooks?.afterDirectoryRead?.(directory.path);
  await revalidatePinnedWorkspaceDirectory(workspace, directory);
  return Object.freeze([...names]);
}

export async function revalidatePinnedWorkspaceDirectory(
  workspace: WorkspaceHandle,
  directory: PinnedWorkspaceDirectory,
): Promise<void> {
  await assertWorkspaceRootStable(workspace);
  try {
    const descriptorBinding = fileBindingFromStats(
      await directory.handle.stat({ bigint: true }),
    );
    const pathStats = await lstat(directory.absolutePath, { bigint: true });
    const pathBinding = fileBindingFromStats(pathStats);
    const resolved = await realpath(directory.absolutePath);
    const state = workspaceHandleState(workspace);
    if (
      pathStats.isSymbolicLink() ||
      descriptorBinding.identity.kind !== "directory" ||
      pathBinding.identity.kind !== "directory" ||
      !sameFileBinding(descriptorBinding, directory.binding) ||
      !sameFileBinding(pathBinding, directory.binding) ||
      !isContained(state.physicalRoot, resolved)
    ) {
      throw stale("A pinned workspace directory no longer binds its physical path.");
    }
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw stale("A pinned workspace directory changed during traversal.");
  }
}

export async function closePinnedWorkspaceDirectory(
  directory: PinnedWorkspaceDirectory,
): Promise<void> {
  try {
    await directory.handle.close();
  } catch {
    throw createDomainError({
      code: "action_failed",
      message: "A pinned workspace directory handle could not be closed safely.",
    });
  }
}

function selectCanonicalDirectoryEntry(
  names: readonly string[],
  requested: string,
  caseSensitivity: WorkspaceHandle["identity"]["caseSensitivity"],
): string {
  const normalizedRequested = requested.normalize("NFC");
  const candidates = names.filter((name) => {
    const canonical = name.normalize("NFC");
    return caseSensitivity === "insensitive"
      ? canonical.toLocaleLowerCase("en-US") ===
          normalizedRequested.toLocaleLowerCase("en-US")
      : canonical === normalizedRequested;
  });
  if (candidates.length === 0) {
    throw missing("The requested workspace path does not exist.", requested);
  }
  if (
    candidates.length !== 1 ||
    candidates[0]!.normalize("NFC") !== normalizedRequested
  ) {
    throw createDomainError({
      code: "conflict",
      message: "The requested path has a case or Unicode alias collision.",
      details: { reason: "path_alias_collision" },
    });
  }
  return candidates[0]!;
}

async function assertFinalPhysicalBinding(
  workspace: WorkspaceHandle,
  absolutePath: string,
  expectedBinding: FileBinding,
  leafIsVisibleSymlink: boolean,
): Promise<void> {
  try {
    const state = workspaceHandleState(workspace);
    const resolved = await realpath(
      leafIsVisibleSymlink ? path.dirname(absolutePath) : absolutePath,
    );
    const current = fileBindingFromStats(
      await lstat(absolutePath, { bigint: true }),
    );
    if (
      !isContained(state.physicalRoot, resolved) ||
      !sameFileBinding(current, expectedBinding)
    ) {
      throw stale("The final workspace object changed during physical resolution.");
    }
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw stale("The final workspace object could not be physically revalidated.");
  }
}

async function closePinnedDirectories(
  directories: readonly PinnedWorkspaceDirectory[],
  reportFailure: boolean,
): Promise<void> {
  let closeFailure: unknown;
  for (const directory of [...directories].reverse()) {
    try {
      await closePinnedWorkspaceDirectory(directory);
    } catch (error: unknown) {
      closeFailure ??= error;
    }
  }
  if (reportFailure && closeFailure !== undefined) throw closeFailure;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !(
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  );
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`Workspace ${label} limit must be a positive safe integer.`);
  }
  return value;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly code?: unknown }).code === code
  );
}

function invalid(message: string) {
  return createDomainError({ code: "invalid_input", message });
}

function missing(message: string, requestedPath: string) {
  return createDomainError({
    code: "invalid_input",
    message,
    details: { path: requestedPath },
  });
}

function stale(message: string) {
  return createDomainError({
    code: "conflict",
    message,
    details: { reason: "workspace_drift" },
  });
}

function budget(message: string) {
  return createDomainError({ code: "budget_exceeded", message });
}

export function physicalObjectKind(binding: FileBinding): PhysicalObjectKind {
  return binding.identity.kind;
}
