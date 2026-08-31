import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { createDomainError, isDomainError, sha256Hex } from "@guard/contracts";

import {
  assertContained,
  closePinnedWorkspaceDirectory,
  closeStableFile,
  finishStableRead,
  normalizeWorkspaceRelativePath,
  observePhysicalParentForCreate,
  openPinnedWorkspaceDirectory,
  openStableRegularFile,
  revalidatePinnedWorkspaceDirectory,
  type WorkspaceRelativePath,
} from "./physical-path.js";
import {
  assertWorkspaceRootStable,
  workspaceHandleState,
  type WorkspaceHandle,
} from "./physical-workspace.js";
import {
  fileBindingFromStats,
  sameFileIdentity,
  type FileBinding,
} from "./workspace-identity.js";

export type AtomicWritePhase =
  | "before_temp_create"
  | "after_temp_create"
  | "after_temp_write"
  | "after_temp_sync"
  | "before_precondition_recheck"
  | "before_publish"
  | "after_publish"
  | "before_postimage_verify";

export interface AtomicWriteHooks {
  atPhase?(phase: AtomicWritePhase): void | Promise<void>;
  nextTemporarySuffix?(): string;
}

export interface AtomicWriteResult {
  readonly path: WorkspaceRelativePath;
  readonly beforeBinding: FileBinding | null;
  readonly afterBinding: FileBinding;
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
  readonly bytesWritten: number;
  readonly directoryFsync: "completed" | "unsupported";
}

export async function atomicReplacePhysicalFile(
  workspace: WorkspaceHandle,
  input: {
    readonly path: WorkspaceRelativePath;
    readonly expectedBinding: FileBinding;
    readonly expectedSha256: string;
    readonly bytes: Uint8Array;
    readonly maximumFileBytes: number;
  },
  hooks: AtomicWriteHooks = {},
): Promise<AtomicWriteResult> {
  assertWritable(workspace);
  if (input.expectedBinding.links !== 1) {
    throw invalid("R2 refuses to edit multiply linked files.");
  }
  if (input.bytes.byteLength > positiveLimit(input.maximumFileBytes)) {
    throw budget("The atomic replacement exceeds its file byte limit.");
  }
  const observed = await openStableRegularFile(workspace, input.path, {
    maximumFileBytes: input.maximumFileBytes,
    expectedBinding: input.expectedBinding,
  });
  let source: Uint8Array;
  try {
    source = await readExact(observed);
    await finishStableRead(workspace, observed);
  } finally {
    await closeStableFile(observed);
  }
  if (sha256Hex(source) !== input.expectedSha256) {
    throw stale("The atomic replacement preimage hash changed.");
  }
  return publish(workspace, {
    kind: "replace",
    path: input.path,
    absolutePath: observed.absolutePath,
    parentAbsolutePath: path.dirname(observed.absolutePath),
    expectedParentBinding: fileBindingFromStats(
      await lstat(path.dirname(observed.absolutePath), { bigint: true }),
    ),
    beforeBinding: input.expectedBinding,
    beforeSha256: input.expectedSha256,
    bytes: input.bytes,
    mode: input.expectedBinding.identity.mode & 0o777,
    maximumFileBytes: input.maximumFileBytes,
  }, hooks);
}

export async function atomicCreatePhysicalFile(
  workspace: WorkspaceHandle,
  input: {
    readonly path: WorkspaceRelativePath;
    readonly bytes: Uint8Array;
    readonly maximumFileBytes: number;
    readonly mode?: number;
  },
  hooks: AtomicWriteHooks = {},
): Promise<AtomicWriteResult> {
  assertWritable(workspace);
  if (input.bytes.byteLength > positiveLimit(input.maximumFileBytes)) {
    throw budget("The atomic create exceeds its file byte limit.");
  }
  const parent = await observePhysicalParentForCreate(workspace, input.path);
  const mode = input.mode ?? 0o644;
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
    throw invalid("An atomic create mode must contain only ordinary permission bits.");
  }
  return publish(workspace, {
    kind: "create",
    path: parent.path,
    absolutePath: parent.absolutePath,
    parentAbsolutePath: parent.parentAbsolutePath,
    expectedParentBinding: parent.parentBinding,
    beforeBinding: null,
    beforeSha256: null,
    bytes: input.bytes,
    mode,
    maximumFileBytes: input.maximumFileBytes,
  }, hooks);
}

async function publish(
  workspace: WorkspaceHandle,
  input: {
    readonly kind: "replace" | "create";
    readonly path: WorkspaceRelativePath;
    readonly absolutePath: string;
    readonly parentAbsolutePath: string;
    readonly expectedParentBinding: FileBinding;
    readonly beforeBinding: FileBinding | null;
    readonly beforeSha256: string | null;
    readonly bytes: Uint8Array;
    readonly mode: number;
    readonly maximumFileBytes: number;
  },
  hooks: AtomicWriteHooks,
): Promise<AtomicWriteResult> {
  const state = workspaceHandleState(workspace);
  assertContained(state.physicalRoot, input.absolutePath);
  if (input.expectedParentBinding.identity.kind !== "directory") {
    throw invalid("An atomic write requires a captured physical parent directory.");
  }
  const suffix = hooks.nextTemporarySuffix?.() ?? randomBytes(16).toString("hex");
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(suffix)) {
    throw invalid("The atomic temporary suffix is invalid.");
  }
  const temporaryPath = path.join(
    input.parentAbsolutePath,
    `.${path.basename(input.absolutePath)}.robin-${suffix}.tmp`,
  );
  assertContained(state.physicalRoot, temporaryPath);
  let published = false;
  let temporaryExists = false;
  let tempHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await hooks.atPhase?.("before_temp_create");
    await revalidatePublishPreconditions(workspace, input);
    tempHandle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    temporaryExists = true;
    await hooks.atPhase?.("after_temp_create");
    let offset = 0;
    while (offset < input.bytes.byteLength) {
      const result = await tempHandle.write(
        input.bytes,
        offset,
        input.bytes.byteLength - offset,
        offset,
      );
      if (result.bytesWritten < 1) {
        throw actionFailed("The atomic temporary file made no write progress.");
      }
      offset += result.bytesWritten;
    }
    await hooks.atPhase?.("after_temp_write");
    await tempHandle.chmod(input.mode & 0o777);
    await tempHandle.sync();
    await hooks.atPhase?.("after_temp_sync");
    await tempHandle.close();
    tempHandle = null;

    await hooks.atPhase?.("before_precondition_recheck");
    await revalidatePublishPreconditions(workspace, input);

    await hooks.atPhase?.("before_publish");
    // The injected hook models the otherwise tiny check-to-publish race. Node
    // does not expose compare-and-rename/openat2 on every Tier 1 host, so R2
    // repeats every available fact here and reports verified_best_effort.
    await revalidatePublishPreconditions(workspace, input);
    if (input.kind === "replace") {
      await rename(temporaryPath, input.absolutePath);
      temporaryExists = false;
      published = true;
    } else {
      await link(temporaryPath, input.absolutePath);
      published = true;
      await unlink(temporaryPath);
      temporaryExists = false;
    }
    await hooks.atPhase?.("after_publish");
    await hooks.atPhase?.("before_postimage_verify");

    const verified = await openStableRegularFile(workspace, input.path, {
      maximumFileBytes: input.maximumFileBytes,
    });
    let afterBytes: Uint8Array;
    try {
      afterBytes = await readExact(verified);
      await finishStableRead(workspace, verified);
    } finally {
      await closeStableFile(verified);
    }
    const expectedAfterHash = sha256Hex(input.bytes);
    if (sha256Hex(afterBytes) !== expectedAfterHash) {
      throw uncertain("The atomic write postimage could not be verified.");
    }
    const directoryFsync = await syncDirectory(input.parentAbsolutePath);
    return Object.freeze({
      path: input.path,
      beforeBinding: input.beforeBinding,
      afterBinding: verified.binding,
      beforeSha256: input.beforeSha256,
      afterSha256: expectedAfterHash,
      bytesWritten: input.bytes.byteLength,
      directoryFsync,
    });
  } catch (error: unknown) {
    if (published && (!isDomainError(error) || error.code !== "attempt_result_uncertain")) {
      throw uncertain("The atomic write failed after publish and requires reconciliation.");
    }
    throw error;
  } finally {
    if (tempHandle !== null) await tempHandle.close().catch(() => undefined);
    if (temporaryExists) {
      await cleanupOwnedTemporary(workspace, input, temporaryPath);
    }
  }
}

async function cleanupOwnedTemporary(
  workspace: WorkspaceHandle,
  input: {
    readonly parentAbsolutePath: string;
    readonly expectedParentBinding: FileBinding;
  },
  temporaryPath: string,
): Promise<void> {
  try {
    await assertWorkspaceRootStable(workspace);
    const currentParent = fileBindingFromStats(
      await lstat(input.parentAbsolutePath, { bigint: true }),
    );
    if (
      currentParent.identity.kind !== "directory" ||
      !sameFileIdentity(
        currentParent.identity,
        input.expectedParentBinding.identity,
      )
    ) {
      // The owned temporary remains in the formerly observed directory. Node
      // has no portable unlinkat(dirfd, name), so following this stale path in
      // an attempt to clean it could unlink an attacker-selected outside file.
      return;
    }
    // This is the narrowest portable cleanup available. A hostile parent swap
    // between this identity check and unlink remains part of the package's
    // verified_best_effort containment tier, just like publish itself.
    await unlink(temporaryPath).catch(() => undefined);
  } catch {
    // Cleanup never expands the effect surface after a failed publish. If the
    // physical binding cannot be proved, retain the private temporary instead.
  }
}

async function revalidatePublishPreconditions(
  workspace: WorkspaceHandle,
  input: {
    readonly kind: "replace" | "create";
    readonly path: WorkspaceRelativePath;
    readonly absolutePath: string;
    readonly parentAbsolutePath: string;
    readonly expectedParentBinding: FileBinding;
    readonly beforeBinding: FileBinding | null;
    readonly beforeSha256: string | null;
    readonly maximumFileBytes: number;
  },
): Promise<void> {
  await assertWorkspaceRootStable(workspace);
  const separator = input.path.lastIndexOf("/");
  const parentPath = normalizeWorkspaceRelativePath(
    separator < 0 ? "" : input.path.slice(0, separator),
    { allowRoot: true },
  );
  const pinnedParent = await openPinnedWorkspaceDirectory(
    workspace,
    parentPath,
    input.parentAbsolutePath,
  );
  let primaryFailure: unknown;
  try {
    const parentBinding = pinnedParent.binding;
    if (
      parentBinding.identity.kind !== "directory" ||
      !sameFileIdentity(
        parentBinding.identity,
        input.expectedParentBinding.identity,
      )
    ) {
      throw stale("The atomic write parent directory changed before publish.");
    }
    if (input.kind === "replace") {
      const current = await openStableRegularFile(workspace, input.path, {
        maximumFileBytes: input.maximumFileBytes,
        expectedBinding: input.beforeBinding!,
      });
      try {
        const bytes = await readExact(current);
        await finishStableRead(workspace, current);
        if (sha256Hex(bytes) !== input.beforeSha256) {
          throw stale("The atomic write target content changed before publish.");
        }
      } finally {
        await closeStableFile(current);
      }
    } else {
      try {
        await lstat(input.absolutePath, { bigint: true });
        throw stale("The atomic create target appeared before publish.");
      } catch (error: unknown) {
        if (isDomainError(error)) throw error;
        if (!isNodeErrorCode(error, "ENOENT")) {
          throw actionFailed("The atomic create target could not be rechecked.");
        }
      }
    }
    await revalidatePinnedWorkspaceDirectory(workspace, pinnedParent);
  } catch (error: unknown) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await closePinnedWorkspaceDirectory(pinnedParent);
    } catch (error: unknown) {
      if (primaryFailure === undefined) throw error;
    }
  }
}

async function readExact(
  opened: Awaited<ReturnType<typeof openStableRegularFile>>,
): Promise<Uint8Array> {
  const result = Buffer.alloc(opened.binding.size);
  let offset = 0;
  while (offset < result.byteLength) {
    const read = await opened.handle.read(
      result,
      offset,
      result.byteLength - offset,
      offset,
    );
    if (read.bytesRead < 1) throw stale("A file became shorter during atomic verification.");
    offset += read.bytesRead;
  }
  return Uint8Array.from(result);
}

async function syncDirectory(
  directory: string,
): Promise<"completed" | "unsupported"> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
    return "completed";
  } catch (error: unknown) {
    if (
      isNodeErrorCode(error, "EINVAL") ||
      isNodeErrorCode(error, "ENOTSUP") ||
      isNodeErrorCode(error, "EISDIR") ||
      isNodeErrorCode(error, "EPERM")
    ) {
      return "unsupported";
    }
    throw uncertain("The containing directory could not be flushed after publish.");
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

function assertWritable(workspace: WorkspaceHandle): void {
  if (
    workspace.identity.accessMode !== "read_write" ||
    workspace.identity.mountCapabilities.containmentTier === "unavailable"
  ) {
    throw createDomainError({
      code: "policy_denied",
      message: "This workspace does not support R2 mutation.",
    });
  }
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid("The atomic file byte limit must be a positive safe integer.");
  }
  return value;
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

function budget(message: string) {
  return createDomainError({ code: "budget_exceeded", message });
}

function stale(message: string) {
  return createDomainError({
    code: "conflict",
    message,
    details: { reason: "stale_preimage" },
  });
}

function actionFailed(message: string) {
  return createDomainError({ code: "action_failed", message });
}

function uncertain(message: string) {
  return createDomainError({
    code: "attempt_result_uncertain",
    message,
    retry: "uncertain",
  });
}
