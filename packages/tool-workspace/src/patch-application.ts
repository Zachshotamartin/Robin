import { createDomainError } from "@guard/contracts";
import type { JsonObject } from "@guard/contracts";

import { atomicCreatePhysicalFile, atomicReplacePhysicalFile } from "./atomic-file.js";
import type { AtomicWriteHooks } from "./atomic-file.js";
import { createDiffArtifact } from "./diff-artifact.js";
import {
  EditLedger,
  type InitialGitPathState,
} from "./edit-ledger.js";
import { classifyTextBytes, classifyWorkspacePath } from "./file-classification.js";
import {
  closeStableFile,
  finishStableRead,
  openStableRegularFile,
  type WorkspaceRelativePath,
} from "./physical-path.js";
import type { WorkspaceHandle } from "./physical-workspace.js";
import {
  applyStructuredPatch,
  type ApplyPatchV1,
  type CreateFileV1,
  type StructuredPatchLimits,
} from "./structured-patch.js";

export interface EditExecutionAuthority {
  readonly actionId: string;
  readonly approvalId: string;
  readonly approvedActionHash: string;
  readonly occurredAt: string;
}

export interface WorkspaceEditLimits extends StructuredPatchLimits {
  readonly maximumFileBytes: number;
  readonly maximumFullDiffBytes: number;
  readonly maximumPreviewBytes: number;
}

export interface WorkspaceEditResult extends JsonObject {
  readonly path: string;
  readonly operation: "apply_patch" | "create_file";
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly changedLineCount: number;
  readonly diffSha256: string;
  readonly diffPreview: string;
  readonly diffPreviewTruncated: boolean;
  readonly ledgerSequence: number;
  readonly directoryFsync: "completed" | "unsupported";
}

export class WorkspaceEditService {
  readonly #workspace: WorkspaceHandle;
  readonly #limits: WorkspaceEditLimits;
  readonly #ledger: EditLedger;
  readonly #hooks: AtomicWriteHooks;

  public constructor(
    workspace: WorkspaceHandle,
    limits: WorkspaceEditLimits,
    options: { readonly ledger?: EditLedger; readonly hooks?: AtomicWriteHooks } = {},
  ) {
    this.#workspace = workspace;
    this.#limits = Object.freeze({ ...limits });
    this.#ledger = options.ledger ?? new EditLedger();
    this.#hooks = options.hooks ?? {};
  }

  public get ledger(): EditLedger {
    return this.#ledger;
  }

  public async applyPatch(
    patch: ApplyPatchV1,
    authority: EditExecutionAuthority,
    initialGitState: InitialGitPathState,
  ): Promise<WorkspaceEditResult> {
    validateAuthority(authority);
    const opened = await openStableRegularFile(this.#workspace, patch.path, {
      maximumFileBytes: this.#limits.maximumFileBytes,
    });
    let before: Uint8Array;
    try {
      const pathClassification = classifyWorkspacePath(opened.path, opened.binding);
      if (
        pathClassification.secretLikely ||
        pathClassification.generated ||
        opened.binding.links !== 1
      ) {
        throw createDomainError({
          code: "policy_denied",
          message: "This workspace file is not eligible for R2 structural editing.",
        });
      }
      before = await readExact(opened);
      const text = classifyTextBytes(before, pathClassification.mediaType);
      if (!text.accepted) {
        throw createDomainError({
          code: "policy_denied",
          message: "This workspace file is not eligible for text editing.",
        });
      }
      await finishStableRead(this.#workspace, opened);
    } finally {
      await closeStableFile(opened);
    }
    const candidate = applyStructuredPatch(patch, before!, this.#limits);
    const diff = createDiffArtifact(patch.path, candidate.before, candidate.after, {
      maximumFullDiffBytes: this.#limits.maximumFullDiffBytes,
      maximumPreviewBytes: this.#limits.maximumPreviewBytes,
    });
    this.#ledger.observeInitial({
      path: patch.path,
      existed: true,
      sha256: candidate.beforeSha256,
      binding: opened.binding,
      gitState: initialGitState,
    });
    const written = await atomicReplacePhysicalFile(
      this.#workspace,
      {
        path: patch.path,
        expectedBinding: opened.binding,
        expectedSha256: candidate.beforeSha256,
        bytes: candidate.after,
        maximumFileBytes: this.#limits.maximumFileBytes,
      },
      this.#hooks,
    );
    const ledgerEntry = this.#ledger.append({
      path: patch.path,
      operation: "apply_patch",
      ...authority,
      beforeSha256: candidate.beforeSha256,
      afterSha256: candidate.afterSha256,
      beforeBytes: candidate.beforeSize,
      afterBytes: candidate.afterSize,
      beforeBinding: written.beforeBinding,
      afterBinding: written.afterBinding,
      diffSha256: diff.fullDiffSha256,
    });
    return Object.freeze({
      path: patch.path,
      operation: "apply_patch",
      beforeSha256: candidate.beforeSha256,
      afterSha256: candidate.afterSha256,
      beforeBytes: candidate.beforeSize,
      afterBytes: candidate.afterSize,
      changedLineCount: candidate.changedLineCount,
      diffSha256: diff.fullDiffSha256,
      diffPreview: diff.preview,
      diffPreviewTruncated: diff.previewTruncated,
      ledgerSequence: ledgerEntry.sequence,
      directoryFsync: written.directoryFsync,
    });
  }

  public async createFile(
    request: CreateFileV1,
    authority: EditExecutionAuthority,
    initialGitState: InitialGitPathState = "absent",
  ): Promise<WorkspaceEditResult> {
    validateAuthority(authority);
    const after = Buffer.from(request.content, "utf8");
    if (after.byteLength > this.#limits.maximumFileBytes) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "The create-file candidate exceeds its file byte limit.",
      });
    }
    const classification = classifyTextBytes(after, "text/plain");
    if (!classification.accepted) {
      throw createDomainError({
        code: "policy_denied",
        message: "The create-file content is not eligible for R2 text editing.",
      });
    }
    const diff = createDiffArtifact(request.path, new Uint8Array(), after, {
      maximumFullDiffBytes: this.#limits.maximumFullDiffBytes,
      maximumPreviewBytes: this.#limits.maximumPreviewBytes,
    });
    this.#ledger.observeInitial({
      path: request.path,
      existed: false,
      sha256: null,
      binding: null,
      gitState: initialGitState,
    });
    const written = await atomicCreatePhysicalFile(
      this.#workspace,
      {
        path: request.path,
        bytes: after,
        maximumFileBytes: this.#limits.maximumFileBytes,
      },
      this.#hooks,
    );
    const ledgerEntry = this.#ledger.append({
      path: request.path,
      operation: "create_file",
      ...authority,
      beforeSha256: null,
      afterSha256: written.afterSha256,
      beforeBytes: 0,
      afterBytes: after.byteLength,
      beforeBinding: null,
      afterBinding: written.afterBinding,
      diffSha256: diff.fullDiffSha256,
    });
    return Object.freeze({
      path: request.path,
      operation: "create_file",
      beforeSha256: null,
      afterSha256: written.afterSha256,
      beforeBytes: 0,
      afterBytes: after.byteLength,
      changedLineCount: request.content.length === 0 ? 0 : countLines(request.content),
      diffSha256: diff.fullDiffSha256,
      diffPreview: diff.preview,
      diffPreviewTruncated: diff.previewTruncated,
      ledgerSequence: ledgerEntry.sequence,
      directoryFsync: written.directoryFsync,
    });
  }
}

async function readExact(
  opened: Awaited<ReturnType<typeof openStableRegularFile>>,
): Promise<Uint8Array> {
  const output = Buffer.alloc(opened.binding.size);
  let offset = 0;
  while (offset < output.byteLength) {
    const result = await opened.handle.read(
      output,
      offset,
      output.byteLength - offset,
      offset,
    );
    if (result.bytesRead < 1) {
      throw createDomainError({
        code: "conflict",
        message: "The edit preimage became shorter during read.",
      });
    }
    offset += result.bytesRead;
  }
  return Uint8Array.from(output);
}

function validateAuthority(authority: EditExecutionAuthority): void {
  for (const [name, value] of Object.entries(authority)) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > 512
    ) {
      throw createDomainError({
        code: "approval_invalid",
        message: `Edit authority ${name} is missing or oversized.`,
      });
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(authority.approvedActionHash)) {
    throw createDomainError({
      code: "approval_invalid",
      message: "Edit authority must bind a canonical approved action hash.",
    });
  }
  if (!Number.isFinite(Date.parse(authority.occurredAt))) {
    throw createDomainError({
      code: "approval_invalid",
      message: "Edit authority must include a valid timestamp.",
    });
  }
}

function countLines(text: string): number {
  let lines = 1;
  for (const character of text) if (character === "\n") lines += 1;
  return text.endsWith("\n") ? lines - 1 : lines;
}
