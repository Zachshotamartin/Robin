import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";

import {
  CapabilityPackRegistry,
  bindCapabilityAgentContextRelease,
  type AuthorizedCapabilityAction,
  type CapabilityAgentContextReleaseDefinition,
  type CapabilityAuthorizedExecutionResult,
  type CapabilityExecutionContext,
  type CapabilityGateway,
  type CapabilityNormalizationContext,
  type CapabilityOperation,
  type CapabilityPack,
  type PreparedCapabilityAction,
} from "@guard/capability-gateway";
import { MEMORY_POLICY_ATTRIBUTE_CATALOG } from "@guard/context-broker";
import {
  CONTRACT_SCHEMA_VERSION,
  canonicalBytes,
  canonicalSha256Hex,
  createDomainError,
  sha256Hex,
  snapshotBoundaryJsonObject,
  type ActionPrecondition,
  type JsonObject,
  type NormalizedAction,
} from "@guard/contracts";
import type {
  GitAttributedStatus,
  GitEditLedgerEntry,
  GitPathAttribution,
  GitRepositoryIdentity,
  GitStatusEntry,
} from "@guard/tool-git";
import {
  parseProcessRequestV1,
  prepareProcessExecution,
  releaseProcessAgentObservation,
  summarizeProcessApproval,
  type PreparedProcessExecution,
  type ProcessLifecycleEvent,
  type ProcessRequestV1,
  type ProcessWorkspaceFileReader,
} from "@guard/tool-process";
import {
  WorkspaceEditService,
  applyStructuredPatch,
  assertWorkspaceRootStable,
  classifyTextBytes,
  classifyWorkspacePath,
  closeStableFile,
  createDiffArtifact,
  finishStableRead,
  listPhysicalFiles,
  normalizeWorkspaceRelativePath,
  observePhysicalParentForCreate,
  openStableRegularFile,
  parseApplyPatchV1,
  parseCreateFileV1,
  readPhysicalFile,
  searchPhysicalText,
  type ApplyPatchV1,
  type CreateFileV1,
  type FileBinding,
  type InitialGitPathState,
  type WorkspaceRelativePath,
} from "@guard/tool-workspace";

import {
  ROBIN_EDIT_PACK_ID,
  ROBIN_GIT_PACK_ID,
  ROBIN_PROCESS_PACK_ID,
  ROBIN_R2_PACK_VERSION,
  ROBIN_R2_TOOL_DEFINITIONS,
  ROBIN_R2_TOOL_REFERENCES,
  ROBIN_REPO_PACK_ID,
} from "./tool-definitions.js";
import type {
  RobinR2CapabilityRuntime,
  RobinR2ExecuteAuthorizedOptions,
  RobinR2InstalledLimits,
  RobinR2LifecycleSink,
  RobinR2RuntimeOptions,
  RobinR2SafeProcessLifecycleEvent,
} from "./runtime-types.js";

const RELEASE_DEFINITION: CapabilityAgentContextReleaseDefinition = Object.freeze({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  sourceVersion: 1,
  catalogId: MEMORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
  catalogVersion: MEMORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
  catalogContentHash: MEMORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
  classification: "internal",
  reason: "robin.r2.tool.output",
});

export const DEFAULT_ROBIN_R2_INSTALLED_LIMITS: RobinR2InstalledLimits =
  deepFreeze({
    list: {
      maximumDepth: 16,
      maximumEntries: 10_000,
      maximumResults: 2_000,
      maximumPathBytes: 256 * 1024,
      maximumDurationMs: 5_000,
    },
    search: {
      maximumQueryBytes: 4_096,
      maximumFiles: 256,
      maximumFileBytes: 1024 * 1024,
      maximumTotalBytes: 16 * 1024 * 1024,
      maximumMatches: 512,
      maximumSnippetBytes: 1_024,
      maximumOutputBytes: 512 * 1024,
      maximumDurationMs: 10_000,
    },
    read: {
      maximumFileBytes: 4 * 1024 * 1024,
      maximumOutputBytes: 512 * 1024,
      maximumLineSpan: 4_096,
    },
    edit: {
      maximumHunks: 128,
      maximumAggregateTextBytes: 512 * 1024,
      maximumResultBytes: 4 * 1024 * 1024,
      maximumFileBytes: 4 * 1024 * 1024,
      maximumFullDiffBytes: 1024 * 1024,
      maximumPreviewBytes: 64 * 1024,
    },
    git: {
      maximumFiles: 2_000,
      maximumRetainedBytes: 512 * 1024,
      maximumAbsoluteBytes: 4 * 1024 * 1024,
      maximumStatusEntries: 2_000,
    },
    approval: {
      maximumSummaryBytes: 192 * 1024,
      maximumTextPreviewBytes: 8 * 1024,
    },
    lifecycle: {
      maximumEventTextBytes: 32 * 1024,
      maximumPendingEvents: 128,
      maximumPendingBytes: 256 * 1024,
    },
  });

interface ExecutionScope {
  readonly runtime: RobinR2Runtime;
  readonly authorization: AuthorizedCapabilityAction;
  readonly sink: BoundedLifecycleQueue | null;
  action: NormalizedAction | null;
  preparedProcess: PreparedProcessExecution | null;
  armed: boolean;
  consumed: boolean;
}

interface EligibleFileObservation {
  readonly path: WorkspaceRelativePath;
  readonly binding: FileBinding;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

const EXECUTION_SCOPE = new AsyncLocalStorage<ExecutionScope>();

/**
 * Composes the real R2 tool packages behind one exact registry. The model sees
 * only operation schemas; opaque workspace, process, Git, limits, and effect
 * authority remain captured in these closures.
 */
class RobinR2Runtime implements RobinR2CapabilityRuntime {
  readonly packs: readonly CapabilityPack[];
  readonly registry: CapabilityPackRegistry;
  readonly advertisement;
  readonly #options: RobinR2RuntimeOptions;
  readonly #limits: RobinR2InstalledLimits;
  readonly #stdinReader: ProcessWorkspaceFileReader;
  readonly #confirmedEdits: GitEditLedgerEntry[] = [];

  constructor(options: RobinR2RuntimeOptions) {
    validateOptions(options);
    this.#options = captureOptions(options);
    this.#limits = captureLimits(options.limits ?? DEFAULT_ROBIN_R2_INSTALLED_LIMITS);
    if (this.#limits.git.maximumAbsoluteBytes > options.git.runner.maximumStdoutBytes) {
      throw invalid("The installed Git output bound exceeds the controlled runner bound.");
    }
    this.#stdinReader = Object.freeze({
      read: (path: string, maximumBytes: number, signal: AbortSignal) =>
        this.#readProcessStdin(path, maximumBytes, signal),
    });
    this.packs = Object.freeze([
      this.#createPack(ROBIN_REPO_PACK_ID),
      this.#createPack(ROBIN_EDIT_PACK_ID),
      this.#createPack(ROBIN_PROCESS_PACK_ID),
      this.#createPack(ROBIN_GIT_PACK_ID),
    ]);
    this.registry = new CapabilityPackRegistry(this.packs);
    this.advertisement = this.registry.createAdvertisement(
      ROBIN_R2_TOOL_REFERENCES,
    );
  }

  approvalSummary(prepared: PreparedCapabilityAction): JsonObject {
    if (
      prepared === null ||
      typeof prepared !== "object" ||
      canonicalSha256Hex(prepared.action) !== prepared.actionHash ||
      prepared.action.sideEffectClass === "none"
    ) {
      throw invalid("Approval summaries require an exact effectful prepared action.");
    }
    const summary = prepared.action.request["approvalSummary"];
    const captured = json(summary);
    if (canonicalBytes(captured).byteLength > this.#limits.approval.maximumSummaryBytes) {
      throw budget("The approval summary exceeds its installed byte bound.");
    }
    return captured;
  }

  async executeAuthorized(
    gateway: CapabilityGateway,
    authorization: AuthorizedCapabilityAction,
    options: RobinR2ExecuteAuthorizedOptions,
  ): Promise<CapabilityAuthorizedExecutionResult> {
    if (options.signal.aborted) throw abortError();
    const sink = options.lifecycleSink === undefined
      ? null
      : new BoundedLifecycleQueue(options.lifecycleSink, this.#limits.lifecycle);
    const scope: ExecutionScope = {
      runtime: this,
      authorization,
      sink,
      action: null,
      preparedProcess: null,
      armed: false,
      consumed: false,
    };
    try {
      return await EXECUTION_SCOPE.run(scope, () =>
        gateway.executeAuthorized(authorization, {
          signal: options.signal,
          revalidate: async (action, context) => {
            if (
              action.actionId !== authorization.actionId ||
              canonicalSha256Hex(action) !== authorization.actionHash
            ) {
              throw approvalInvalid("The live action does not match its execution authority.");
            }
            scope.action = action;
            const current = await this.#revalidate(action, context.signal, scope);
            scope.armed = true;
            return current;
          },
        }),
      );
    } finally {
      scope.armed = false;
      scope.preparedProcess = null;
      await sink?.flush();
    }
  }

  #createPack(packId: string): CapabilityPack {
    const definitions = ROBIN_R2_TOOL_DEFINITIONS.filter(
      (entry) => entry.reference.packId === packId,
    );
    return Object.freeze({
      packId,
      packVersion: ROBIN_R2_PACK_VERSION,
      operations: Object.freeze(
        definitions.map((entry) => this.#operation(entry.reference.operationId)),
      ),
    });
  }

  #operation(operationId: string): CapabilityOperation {
    const entry = ROBIN_R2_TOOL_DEFINITIONS.find(
      (candidate) => candidate.reference.operationId === operationId,
    );
    if (entry === undefined) throw invalid("The R2 operation is not installed.");
    return Object.freeze({
      definition: entry.definition,
      agentContextRelease: RELEASE_DEFINITION,
      normalize: (input: JsonObject, context: CapabilityNormalizationContext) =>
        this.#normalize(operationId, input, context),
      execute: (action: NormalizedAction, context: CapabilityExecutionContext) =>
        this.#execute(operationId, action, context.signal),
      release: (raw: JsonObject, action: NormalizedAction) =>
        releaseViews(raw, action),
    });
  }

  async #normalize(
    operationId: string,
    input: JsonObject,
    context: { readonly actionId: string },
  ) {
    const workspace = this.#options.workspace;
    const workspacePrecondition = this.#workspacePrecondition();
    switch (operationId) {
      case "list_files": {
        const root = normalizeWorkspaceRelativePath(input["root"], { allowRoot: true });
        return semantics(
          { root },
          workspaceResource(workspace.identity.workspaceId, root),
          { intent: "list_workspace_files", root, limitsHash: canonicalSha256Hex(this.#limits.list) },
          [workspacePrecondition],
        );
      }
      case "search_text": {
        const query = requiredString(input["query"], "search query");
        if (Buffer.byteLength(query, "utf8") > this.#limits.search.maximumQueryBytes) {
          throw budget("The search query exceeds its installed byte bound.");
        }
        const paths = canonicalPaths(input["paths"], this.#limits.search.maximumFiles);
        const observations = await Promise.all(
          paths.map((path) => this.#readEligibleFile(path, this.#limits.search.maximumFileBytes)),
        );
        return semantics(
          { query, paths },
          workspaceResource(workspace.identity.workspaceId, ""),
          {
            intent: "search_workspace_text",
            querySha256: sha256Hex(query),
            pathCount: paths.length,
            limitsHash: canonicalSha256Hex(this.#limits.search),
          },
          [workspacePrecondition, ...observations.map(filePrecondition)],
        );
      }
      case "read_file": {
        const path = normalizeWorkspaceRelativePath(input["path"], { allowRoot: false });
        const selector = normalizeSelector(input["selector"], this.#limits.read.maximumLineSpan);
        const observed = await this.#readEligibleFile(path, this.#limits.read.maximumFileBytes);
        return semantics(
          { path, selector },
          workspaceResource(workspace.identity.workspaceId, path),
          {
            intent: "read_workspace_file",
            path,
            sourceSha256: observed.sha256,
            sourceBytes: observed.bytes.byteLength,
            limitsHash: canonicalSha256Hex(this.#limits.read),
          },
          [workspacePrecondition, filePrecondition(observed)],
        );
      }
      case "apply_patch": {
        const patch = parseApplyPatchV1(input, this.#limits.edit);
        const observed = await this.#readEligibleFile(
          patch.path,
          this.#limits.edit.maximumFileBytes,
        );
        const candidate = applyStructuredPatch(patch, observed.bytes, this.#limits.edit);
        const diff = createDiffArtifact(patch.path, candidate.before, candidate.after, {
          maximumFullDiffBytes: this.#limits.edit.maximumFullDiffBytes,
          maximumPreviewBytes: this.#limits.edit.maximumPreviewBytes,
        });
        const gitStatus = await this.#observeGitStatus(new AbortController().signal);
        const initialGitState = initialGitPathState(
          gitStatus.snapshot.entries,
          patch.path,
          true,
        );
        const summary = this.#patchApprovalSummary(patch, observed, diff);
        return semantics(
          { patch: json(patch), initialGitState },
          workspaceResource(workspace.identity.workspaceId, patch.path),
          {
            intent: "apply_exact_patch",
            path: patch.path,
            preimageSha256: observed.sha256,
            preimageBytes: observed.bytes.byteLength,
            candidateSha256: candidate.afterSha256,
            approvalSummary: summary,
          },
          [
            workspacePrecondition,
            filePrecondition(observed),
            this.#gitPrecondition(),
            gitStatusPrecondition(gitStatus),
          ],
        );
      }
      case "create_file": {
        const request = parseCreateFileV1(input, this.#limits.edit.maximumFileBytes);
        const parent = await observePhysicalParentForCreate(workspace, request.path);
        assertProspectiveEditPath(request.path, parent.parentBinding, request.content);
        const after = Buffer.from(request.content, "utf8");
        const diff = createDiffArtifact(request.path, new Uint8Array(), after, {
          maximumFullDiffBytes: this.#limits.edit.maximumFullDiffBytes,
          maximumPreviewBytes: this.#limits.edit.maximumPreviewBytes,
        });
        const gitStatus = await this.#observeGitStatus(new AbortController().signal);
        const initialGitState = initialGitPathState(
          gitStatus.snapshot.entries,
          request.path,
          false,
        );
        const summary = this.#createApprovalSummary(request, parent.parentBinding, diff);
        return semantics(
          { request: json(request), initialGitState },
          workspaceResource(workspace.identity.workspaceId, request.path),
          {
            intent: "create_absent_file",
            path: request.path,
            expectedAbsent: true,
            contentSha256: sha256Hex(after),
            contentBytes: after.byteLength,
            approvalSummary: summary,
          },
          [
            workspacePrecondition,
            parentPrecondition(request.path, parent.parentBinding),
            absencePrecondition(request.path),
            this.#gitPrecondition(),
            gitStatusPrecondition(gitStatus),
          ],
        );
      }
      case "run": {
        const request = parseProcessRequestV1(input);
        const prepared = await this.#prepareProcess(request, new AbortController().signal);
        const summary = this.#processApprovalSummary(prepared);
        return semantics(
          { processRequest: json(request) },
          workspaceResource(workspace.identity.workspaceId, request.cwd),
          {
            intent: request.intent,
            preparedHash: prepared.preparedHash,
            approvalSummary: summary,
          },
          [workspacePrecondition, ...processPreconditions(prepared), this.#gitPrecondition()],
        );
      }
      case "status":
        return semantics(
          {},
          gitResource(this.#options.git.identity.repositoryId),
          { intent: "read_git_status" },
          [workspacePrecondition, this.#gitPrecondition()],
        );
      case "diff": {
        const scope = input["scope"];
        if (scope !== "working" && scope !== "staged") {
          throw invalid("The Git diff scope is unsupported.");
        }
        return semantics(
          { scope },
          gitResource(this.#options.git.identity.repositoryId),
          {
            intent: "read_git_diff",
            scope,
            limitsHash: canonicalSha256Hex(this.#limits.git),
          },
          [workspacePrecondition, this.#gitPrecondition()],
        );
      }
      default:
        throw invalid("The R2 operation is not installed.");
    }
  }

  async #execute(
    operationId: string,
    action: NormalizedAction,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    const scope = this.#consumeScope(action, operationId);
    switch (operationId) {
      case "list_files":
        return listPhysicalFiles(
          this.#options.workspace,
          {
            root: requiredString(action.normalizedInput["root"], "list root", true),
            includeHidden: false,
            includeGenerated: false,
            limits: this.#limits.list,
          },
          signal,
        );
      case "search_text": {
        const paths = jsonStringArray(action.normalizedInput["paths"]);
        const result = await searchPhysicalText(
          this.#options.workspace,
          {
            query: requiredString(action.normalizedInput["query"], "search query"),
            paths,
            ...this.#limits.search,
            includeGenerated: false,
          },
          signal,
        );
        await this.#assertFilePreconditionsStillHold(action, paths);
        return result;
      }
      case "read_file": {
        const path = requiredString(action.normalizedInput["path"], "read path");
        const result = await readPhysicalFile(
          this.#options.workspace,
          {
            path,
            selector: normalizeSelector(
              action.normalizedInput["selector"],
              this.#limits.read.maximumLineSpan,
            ),
            ...this.#limits.read,
            preserveAtime: true,
            allowGenerated: false,
          },
          signal,
        );
        const expected = action.request["sourceSha256"];
        if (result.status !== "released" || result.sourceSha256 !== expected) {
          throw conflict("The file changed after authorization and was not released.");
        }
        return result;
      }
      case "apply_patch": {
        this.#requireApproval(scope);
        const patch = parseApplyPatchV1(
          exactObject(action.normalizedInput["patch"]),
          this.#limits.edit,
        );
        const service = new WorkspaceEditService(this.#options.workspace, this.#limits.edit);
        const result = await service.applyPatch(
          patch,
          this.#editAuthority(scope, action),
          initialGitStateValue(action.normalizedInput["initialGitState"]),
        );
        const ledgerSequence = this.#recordConfirmedEdit(action, result);
        return json({ ...result, ledgerSequence, postGit: await this.#postGit(signal) });
      }
      case "create_file": {
        this.#requireApproval(scope);
        const request = parseCreateFileV1(
          exactObject(action.normalizedInput["request"]),
          this.#limits.edit.maximumFileBytes,
        );
        const service = new WorkspaceEditService(this.#options.workspace, this.#limits.edit);
        const result = await service.createFile(
          request,
          this.#editAuthority(scope, action),
          initialGitStateValue(action.normalizedInput["initialGitState"]),
        );
        const ledgerSequence = this.#recordConfirmedEdit(action, result);
        return json({ ...result, ledgerSequence, postGit: await this.#postGit(signal) });
      }
      case "run": {
        this.#requireApproval(scope);
        const prepared = scope.preparedProcess;
        if (prepared === null) {
          throw approvalInvalid("The prepared process is not bound to live authorization.");
        }
        const result = await this.#options.process.controller.run(prepared, {
          signal,
          ...(scope.sink === null
            ? {}
            : { onEvent: (event: ProcessLifecycleEvent) => scope.sink!.accept(event) }),
        });
        await scope.sink?.flush();
        return json({
          ...releaseProcessAgentObservation(result),
          preparedHash: result.preparedHash,
          postGit: await this.#postGit(signal),
        });
      }
      case "status":
        return this.#postGit(signal);
      case "diff": {
        const scopeValue = action.normalizedInput["scope"];
        if (scopeValue !== "working" && scopeValue !== "staged") {
          throw invalid("The normalized Git diff scope is invalid.");
        }
        return json(await this.#options.git.diff({
          kind: scopeValue,
          paths: [],
          maximumFiles: this.#limits.git.maximumFiles,
          maximumRetainedBytes: this.#limits.git.maximumRetainedBytes,
          maximumAbsoluteBytes: this.#limits.git.maximumAbsoluteBytes,
          signal,
        }));
      }
      default:
        throw invalid("The R2 operation is not installed.");
    }
  }

  async #revalidate(
    action: NormalizedAction,
    signal: AbortSignal,
    scope: ExecutionScope,
  ): Promise<readonly ActionPrecondition[]> {
    try {
      await assertWorkspaceRootStable(this.#options.workspace);
      if (signal.aborted) throw abortError();
      const workspace = this.#workspacePrecondition();
      switch (action.operationId) {
        case "list_files":
          return [workspace];
        case "search_text": {
          const paths = jsonStringArray(action.normalizedInput["paths"]);
          const observations = await Promise.all(
            paths.map((path) => this.#readEligibleFile(path, this.#limits.search.maximumFileBytes)),
          );
          return [workspace, ...observations.map(filePrecondition)];
        }
        case "read_file": {
          const observed = await this.#readEligibleFile(
            action.normalizedInput["path"],
            this.#limits.read.maximumFileBytes,
          );
          return [workspace, filePrecondition(observed)];
        }
        case "apply_patch": {
          const patch = parseApplyPatchV1(
            exactObject(action.normalizedInput["patch"]),
            this.#limits.edit,
          );
          const observed = await this.#readEligibleFile(
            patch.path,
            this.#limits.edit.maximumFileBytes,
          );
          applyStructuredPatch(patch, observed.bytes, this.#limits.edit);
          if (!(await this.#options.git.revalidate(signal))) return changedPreconditions(action);
          const gitStatus = await this.#observeGitStatus(signal);
          return [
            workspace,
            filePrecondition(observed),
            this.#gitPrecondition(),
            gitStatusPrecondition(gitStatus),
          ];
        }
        case "create_file": {
          const request = parseCreateFileV1(
            exactObject(action.normalizedInput["request"]),
            this.#limits.edit.maximumFileBytes,
          );
          const parent = await observePhysicalParentForCreate(this.#options.workspace, request.path);
          assertProspectiveEditPath(request.path, parent.parentBinding, request.content);
          if (!(await this.#options.git.revalidate(signal))) return changedPreconditions(action);
          const gitStatus = await this.#observeGitStatus(signal);
          return [
            workspace,
            parentPrecondition(request.path, parent.parentBinding),
            absencePrecondition(request.path),
            this.#gitPrecondition(),
            gitStatusPrecondition(gitStatus),
          ];
        }
        case "run": {
          const request = parseProcessRequestV1(
            exactObject(action.normalizedInput["processRequest"]),
          );
          const prepared = await this.#prepareProcess(request, signal);
          scope.preparedProcess = prepared;
          if (!(await this.#options.git.revalidate(signal))) return changedPreconditions(action);
          return [workspace, ...processPreconditions(prepared), this.#gitPrecondition()];
        }
        case "status":
        case "diff":
          return (await this.#options.git.revalidate(signal))
            ? [workspace, this.#gitPrecondition()]
            : changedPreconditions(action);
        default:
          return changedPreconditions(action);
      }
    } catch (error: unknown) {
      if (isAbort(error) || signal.aborted) throw error;
      scope.preparedProcess = null;
      return changedPreconditions(action);
    }
  }

  #consumeScope(action: NormalizedAction, operationId: string): ExecutionScope {
    const scope = EXECUTION_SCOPE.getStore();
    if (
      scope === undefined ||
      scope.runtime !== this ||
      !scope.armed ||
      scope.consumed ||
      scope.action !== action ||
      scope.authorization.actionId !== action.actionId ||
      scope.authorization.actionHash !== canonicalSha256Hex(action) ||
      action.operationId !== operationId
    ) {
      throw approvalInvalid("Tool execution requires exact live gateway authority.");
    }
    scope.consumed = true;
    return scope;
  }

  #requireApproval(scope: ExecutionScope): void {
    if (
      scope.authorization.source !== "approval" ||
      scope.authorization.approvalId === null
    ) {
      throw approvalInvalid("This effect requires an exact one-use user approval.");
    }
  }

  #editAuthority(scope: ExecutionScope, action: NormalizedAction) {
    const occurredAt = this.#options.clock?.now() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(occurredAt))) {
      throw approvalInvalid("The trusted edit clock returned an invalid timestamp.");
    }
    return {
      actionId: action.actionId,
      approvalId: scope.authorization.approvalId!,
      approvedActionHash: scope.authorization.actionHash,
      occurredAt,
    };
  }

  #workspacePrecondition(): ActionPrecondition {
    const identity = this.#options.workspace.identity;
    return precondition("robin.workspace.binding", {
      workspaceId: identity.workspaceId,
      bindingHash: identity.bindingHash,
      physicalRoot: identity.physicalRoot,
      rootFileIdentity: identity.rootFileIdentity,
    });
  }

  #gitPrecondition(): ActionPrecondition {
    const identity = this.#options.git.identity;
    return precondition("robin.git.repository.binding", stableGitIdentity(identity));
  }

  async #prepareProcess(
    request: ProcessRequestV1,
    signal: AbortSignal,
  ): Promise<PreparedProcessExecution> {
    return prepareProcessExecution({
      request,
      workspaceRoot: this.#options.workspace.identity.physicalRoot,
      executablePolicy: this.#options.process.executablePolicy,
      environmentProfile: this.#options.process.environmentProfile,
      ambientEnvironment: this.#options.process.ambientEnvironment,
      signal,
      workspaceFileReader: this.#stdinReader,
    });
  }

  async #readProcessStdin(
    path: string,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal.aborted) throw abortError();
    const observed = await this.#readEligibleFile(path, Math.min(maximumBytes, this.#limits.read.maximumFileBytes));
    if (observed.bytes.byteLength > maximumBytes) {
      throw budget("The process stdin file exceeds its requested bound.");
    }
    return observed.bytes;
  }

  async #readEligibleFile(
    path: unknown,
    maximumBytes: number,
  ): Promise<EligibleFileObservation> {
    const opened = await openStableRegularFile(this.#options.workspace, path, {
      maximumFileBytes: maximumBytes,
      preserveAtime: true,
    });
    let primary: unknown;
    try {
      const pathClass = classifyWorkspacePath(opened.path, opened.binding);
      if (
        pathClass.secretLikely ||
        pathClass.generated ||
        opened.binding.links !== 1
      ) {
        throw policyDenied("The requested workspace file is not eligible for this tool.");
      }
      const bytes = await readOpenedBytes(opened);
      const text = classifyTextBytes(bytes, pathClass.mediaType);
      if (!text.accepted) {
        throw policyDenied("The requested workspace file is not eligible for text release.");
      }
      await finishStableRead(this.#options.workspace, opened);
      return Object.freeze({
        path: opened.path,
        binding: opened.binding,
        bytes,
        sha256: sha256Hex(bytes),
      });
    } catch (error: unknown) {
      primary = error;
      throw error;
    } finally {
      try {
        await closeStableFile(opened);
      } catch (error: unknown) {
        if (primary === undefined) throw error;
      }
    }
  }

  async #assertFilePreconditionsStillHold(
    action: NormalizedAction,
    paths: readonly string[],
  ): Promise<void> {
    const current = await Promise.all(
      paths.map((path) => this.#readEligibleFile(path, this.#limits.search.maximumFileBytes)),
    );
    const expected = action.preconditions.filter(
      (item) => item.preconditionType === "robin.workspace.file.binding",
    );
    if (canonicalSha256Hex(current.map(filePrecondition)) !== canonicalSha256Hex(expected)) {
      throw conflict("Search sources changed after authorization and were not released.");
    }
  }

  #patchApprovalSummary(
    patch: ApplyPatchV1,
    observed: EligibleFileObservation,
    diff: ReturnType<typeof createDiffArtifact>,
  ): JsonObject {
    return boundedSummary({
      toolId: "robin.edit.apply_patch@1",
      path: safeFact(patch.path, this.#limits.approval.maximumTextPreviewBytes),
      preimage: {
        sha256: observed.sha256,
        bytes: observed.bytes.byteLength,
        binding: observed.binding,
      },
      hunks: patch.hunks.map((hunk) => ({
        expectedOccurrences: 1,
        expectedStartLine: hunk.expectedStartLine ?? null,
        oldText: textFact(hunk.oldText, this.#limits.approval.maximumTextPreviewBytes),
        newText: textFact(hunk.newText, this.#limits.approval.maximumTextPreviewBytes),
      })),
      resultSha256: sha256Hex(applyStructuredPatch(patch, observed.bytes, this.#limits.edit).after),
      diff: diffFact(diff),
    }, this.#limits.approval.maximumSummaryBytes);
  }

  #createApprovalSummary(
    request: CreateFileV1,
    parentBinding: FileBinding,
    diff: ReturnType<typeof createDiffArtifact>,
  ): JsonObject {
    return boundedSummary({
      toolId: "robin.edit.create_file@1",
      path: safeFact(request.path, this.#limits.approval.maximumTextPreviewBytes),
      expectedAbsent: true,
      parentBinding,
      content: textFact(request.content, this.#limits.approval.maximumTextPreviewBytes),
      diff: diffFact(diff),
    }, this.#limits.approval.maximumSummaryBytes);
  }

  #processApprovalSummary(prepared: PreparedProcessExecution): JsonObject {
    const base = summarizeProcessApproval(prepared);
    return boundedSummary({
      toolId: base.toolId,
      executable: safeFact(base.executable, this.#limits.approval.maximumTextPreviewBytes),
      argv: prepared.request.argv.map((value) =>
        textFact(value, this.#limits.approval.maximumTextPreviewBytes),
      ),
      argvSha256: canonicalSha256Hex(prepared.request.argv),
      cwd: safeFact(base.cwd, this.#limits.approval.maximumTextPreviewBytes),
      environmentProfile: safeFact(base.environmentProfile, 1_024),
      environmentAddedKeys: base.environmentAddedKeys.map((value) => safeFact(value, 1_024)),
      timeoutMs: base.timeoutMs,
      output: {
        retainedHeadBytes: prepared.request.output.retainedHeadBytes,
        retainedTailBytes: prepared.request.output.retainedTailBytes,
        absoluteBytes: base.absoluteOutputBytes,
      },
      stdin: { kind: prepared.stdin.kind, bytes: base.stdinBytes, sha256: prepared.stdin.sha256 },
      preparedHash: base.preparedHash,
      sandboxed: false,
      filesystemIsolation: "none",
      networkIsolation: "none",
      warning: "This direct process is not sandboxed and has no filesystem or network isolation.",
    }, this.#limits.approval.maximumSummaryBytes);
  }

  async #postGit(signal: AbortSignal): Promise<JsonObject> {
    try {
      const status = await this.#options.git.status({
        currentFileHashes: await this.#currentLedgerHashes(),
        editLedger: this.#gitLedger(),
        signal,
      });
      return projectGitStatus(status, this.#limits.git.maximumStatusEntries);
    } catch (error: unknown) {
      if (signal.aborted || isAbort(error)) throw error;
      return json({
        status: "unavailable",
        reason: "git_rescan_failed",
        attribution: "not_collected",
        submoduleWorktreeEvidence: "not_collected_for_execution_safety",
      });
    }
  }

  #observeGitStatus(signal: AbortSignal): Promise<GitAttributedStatus> {
    return this.#options.git.status({
      currentFileHashes: this.#currentLedgerHashesSync(),
      editLedger: this.#gitLedger(),
      signal,
    });
  }

  #gitLedger(): readonly GitEditLedgerEntry[] {
    return Object.freeze([...this.#confirmedEdits]);
  }

  async #currentLedgerHashes(): Promise<Readonly<Record<string, string>>> {
    const result: Record<string, string> = {};
    const paths = [...new Set(this.#confirmedEdits.map((entry) => entry.path))];
    for (const path of paths) {
      try {
        const observed = await this.#readEligibleFile(path, this.#limits.edit.maximumFileBytes);
        result[path] = observed.sha256;
      } catch {
        // Missing, externally replaced, restricted, or oversized paths remain unknown.
      }
    }
    return Object.freeze(result);
  }

  #currentLedgerHashesSync(): Readonly<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of this.#confirmedEdits) result[entry.path] = entry.afterSha256;
    return Object.freeze(result);
  }

  #recordConfirmedEdit(
    action: NormalizedAction,
    result: {
      readonly path: string;
      readonly beforeSha256: string | null;
      readonly afterSha256: string;
    },
  ): number {
    this.#confirmedEdits.push(Object.freeze({
      actionId: action.actionId,
      path: result.path,
      beforeSha256: result.beforeSha256,
      afterSha256: result.afterSha256,
      outcome: "confirmed" as const,
    }));
    return this.#confirmedEdits.length;
  }
}

export function createRobinR2CapabilityRuntime(
  options: RobinR2RuntimeOptions,
): RobinR2CapabilityRuntime {
  return new RobinR2Runtime(options);
}

function semantics(
  normalizedInput: JsonObject,
  resource: JsonObject,
  request: JsonObject,
  preconditions: readonly ActionPrecondition[],
) {
  return { normalizedInput, resource, request, preconditions };
}

function workspaceResource(workspaceId: string, path: string): JsonObject {
  return json({
    scheme: "workspace",
    sourceId: workspaceId,
    locator: { path },
    classification: "internal",
  });
}

function gitResource(repositoryId: string): JsonObject {
  return json({
    scheme: "git",
    sourceId: repositoryId,
    locator: {},
    classification: "internal",
  });
}

function precondition(type: string, attributes: JsonObject): ActionPrecondition {
  return Object.freeze({
    preconditionType: type,
    preconditionVersion: 1,
    attributes: json(attributes),
  });
}

function filePrecondition(observed: EligibleFileObservation): ActionPrecondition {
  return precondition("robin.workspace.file.binding", {
    path: observed.path,
    binding: observed.binding,
    sha256: observed.sha256,
    bytes: observed.bytes.byteLength,
  });
}

function parentPrecondition(path: string, binding: FileBinding): ActionPrecondition {
  return precondition("robin.workspace.parent.binding", { path, binding });
}

function absencePrecondition(path: string): ActionPrecondition {
  return precondition("robin.workspace.path.absence", { path, absent: true });
}

function processPreconditions(prepared: PreparedProcessExecution): readonly ActionPrecondition[] {
  return [
    precondition("robin.process.executable.binding", {
      requested: prepared.executable.requested,
      physicalPath: prepared.executable.physicalPath,
      candidatePath: prepared.executable.candidatePath,
      identity: json(prepared.executable.identity),
      containment: prepared.executable.containment,
    }),
    precondition("robin.process.cwd.binding", {
      relativePath: prepared.cwd.relativePath,
      physicalPath: prepared.cwd.physicalPath,
      rootIdentity: json(prepared.cwd.rootIdentity),
      cwdIdentity: json(prepared.cwd.cwdIdentity),
    }),
    precondition("robin.process.stdin.binding", {
      kind: prepared.stdin.kind,
      byteLength: prepared.stdin.byteLength,
      sha256: prepared.stdin.sha256,
    }),
    precondition("robin.process.environment.binding", {
      profileId: prepared.environment.metadata.profileId,
      inheritedKeys: prepared.environment.metadata.inheritedKeys,
      fixedKeys: prepared.environment.metadata.fixedKeys,
      addedKeys: prepared.environment.metadata.addedKeys,
      environmentSha256: prepared.environment.metadata.environmentSha256,
      preparedHash: prepared.preparedHash,
      sandboxed: false,
      filesystemIsolation: "none",
      networkIsolation: "none",
    }),
  ];
}

function stableGitIdentity(identity: GitRepositoryIdentity): JsonObject {
  return json({
    repositoryId: identity.repositoryId,
    workspaceRoot: identity.workspaceRoot,
    workspaceRootIdentity: identity.workspaceRootIdentity,
    gitDirectory: identity.gitDirectory,
    gitDirectoryIdentity: identity.gitDirectoryIdentity,
    commonDirectory: identity.commonDirectory,
    commonDirectoryIdentity: identity.commonDirectoryIdentity,
    objectFormat: identity.objectFormat,
  });
}

function gitStatusPrecondition(status: GitAttributedStatus): ActionPrecondition {
  return precondition("robin.git.status.binding", {
    statusSha256: status.snapshot.statusSha256,
    branch: json(status.snapshot.branch),
    submoduleWorktreeEvidence: status.snapshot.submoduleWorktreeEvidence,
  });
}

function changedPreconditions(action: NormalizedAction): readonly ActionPrecondition[] {
  return [precondition("robin.live.binding.changed", {
    actionId: action.actionId,
    operationId: action.operationId,
    state: "changed_or_unavailable",
  })];
}

function releaseViews(
  raw: JsonObject,
  action: NormalizedAction,
) {
  const agent = json(raw);
  const recordId = `${action.operationId}:${action.actionId}`;
  const descriptor = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceVersion: RELEASE_DEFINITION.sourceVersion,
    resource: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      scheme: String(action.resource["scheme"]),
      sourceId: String(action.resource["sourceId"]),
      locator: { recordId },
      mediaType: "application/json",
      classification: RELEASE_DEFINITION.classification,
    },
    policyProjection: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      catalogId: RELEASE_DEFINITION.catalogId,
      catalogVersion: RELEASE_DEFINITION.catalogVersion,
      catalogContentHash: RELEASE_DEFINITION.catalogContentHash,
      resourceAttributes: { recordId },
      requestAttributes: {},
    },
    classification: RELEASE_DEFINITION.classification,
    reason: RELEASE_DEFINITION.reason,
  } as const;
  return {
    audit: json({
      operationId: action.operationId,
      actionId: action.actionId,
      rawSha256: canonicalSha256Hex(raw),
    }),
    human: json({
      summary: `Robin completed ${escapeTerminal(action.operationId)}.`,
    }),
    agent,
    agentContextRelease: bindCapabilityAgentContextRelease(
      descriptor,
      action,
      raw,
      agent,
    ),
  };
}

function projectGitStatus(
  status: GitAttributedStatus,
  maximumEntries: number,
): JsonObject {
  const byPath = new Map(status.attribution.map((item) => [item.path, item]));
  const entries = status.snapshot.entries.slice(0, maximumEntries).map((entry) =>
    projectGitEntry(entry, byPath.get(entry.path.utf8 ?? entry.path.display)),
  );
  return json({
    status: "released",
    capturedAt: status.snapshot.capturedAt,
    statusSha256: status.snapshot.statusSha256,
    branch: status.snapshot.branch,
    entries,
    totalEntries: status.snapshot.entries.length,
    truncated: entries.length < status.snapshot.entries.length,
    submoduleWorktreeEvidence: status.snapshot.submoduleWorktreeEvidence,
  });
}

function projectGitEntry(
  entry: GitStatusEntry,
  attribution: GitPathAttribution | undefined,
): JsonObject {
  return json({
    kind: entry.kind,
    xy: entry.xy,
    path: entry.path.display,
    originalPath: entry.originalPath?.display ?? null,
    submodule: entry.submodule,
    attribution: attribution?.attribution ?? "unknown",
    currentSha256: attribution?.currentSha256 ?? null,
    lastRobinPostimageSha256: attribution?.lastRobinPostimageSha256 ?? null,
    editActionIds: attribution?.editActionIds ?? [],
  });
}

class BoundedLifecycleQueue {
  readonly #sink: RobinR2LifecycleSink;
  readonly #limits: RobinR2InstalledLimits["lifecycle"];
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown;
  #pendingEvents = 0;
  #pendingBytes = 0;

  constructor(
    sink: RobinR2LifecycleSink,
    limits: RobinR2InstalledLimits["lifecycle"],
  ) {
    if (sink === null || typeof sink !== "object" || typeof sink.publish !== "function") {
      throw invalid("A lifecycle sink must expose publish(event).");
    }
    this.#sink = sink;
    this.#limits = limits;
  }

  accept(event: ProcessLifecycleEvent): void {
    if (this.#failure !== undefined) throw this.#failure;
    const safe = safeLifecycleEvent(event, this.#limits.maximumEventTextBytes);
    const bytes = canonicalBytes(json(safe)).byteLength;
    if (
      this.#pendingEvents + 1 > this.#limits.maximumPendingEvents ||
      this.#pendingBytes + bytes > this.#limits.maximumPendingBytes
    ) {
      throw budget("The process lifecycle presentation sink exceeded its backpressure bound.");
    }
    this.#pendingEvents += 1;
    this.#pendingBytes += bytes;
    this.#tail = this.#tail
      .then(() => this.#sink.publish(safe))
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#failure = error;
      })
      .finally(() => {
        this.#pendingEvents -= 1;
        this.#pendingBytes -= bytes;
      });
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#failure !== undefined) {
      throw createDomainError({
        code: "infrastructure_failed",
        message: "The process lifecycle presentation sink failed.",
      });
    }
  }
}

function safeLifecycleEvent(
  event: ProcessLifecycleEvent,
  maximumTextBytes: number,
): RobinR2SafeProcessLifecycleEvent {
  if (event.type !== "output") return Object.freeze({ ...event });
  const text = truncateUtf8(event.chunk.safeText, maximumTextBytes);
  return Object.freeze({
    type: "output",
    sequence: event.chunk.sequence,
    channel: event.chunk.channel,
    channelOffset: event.chunk.channelOffset,
    byteLength: event.chunk.byteLength,
    safeText: text.value,
    textTruncated: text.truncated,
    limitExceeded: event.chunk.limitExceeded,
  });
}

function normalizeSelector(value: unknown, maximumLineSpan: number) {
  const selector = exactObject(value);
  if (selector["kind"] === "whole") return Object.freeze({ kind: "whole" as const });
  if (selector["kind"] === "bytes") {
    const offset = safeInteger(selector["offset"], 0, Number.MAX_SAFE_INTEGER, "byte offset");
    const length = safeInteger(selector["length"], 1, 262_144, "byte length");
    return Object.freeze({ kind: "bytes" as const, offset, length });
  }
  if (selector["kind"] === "lines") {
    const startLine = safeInteger(selector["startLine"], 1, Number.MAX_SAFE_INTEGER, "start line");
    const endLine = safeInteger(selector["endLine"], startLine, Number.MAX_SAFE_INTEGER, "end line");
    if (endLine - startLine + 1 > maximumLineSpan) {
      throw budget("The requested line window exceeds its installed span bound.");
    }
    return Object.freeze({ kind: "lines" as const, startLine, endLine });
  }
  throw invalid("The read selector is unsupported.");
}

function canonicalPaths(value: unknown, maximum: number): readonly WorkspaceRelativePath[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw invalid("Search paths must be a bounded non-empty array.");
  }
  const paths = value.map((path) =>
    normalizeWorkspaceRelativePath(path, { allowRoot: false }),
  );
  const unique = [...new Set(paths)];
  if (unique.length !== paths.length) throw invalid("Search paths must be unique.");
  unique.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return Object.freeze(unique);
}

function assertProspectiveEditPath(
  path: WorkspaceRelativePath,
  parentBinding: FileBinding,
  content: string,
): void {
  const fakeBinding: FileBinding = {
    ...parentBinding,
    identity: { ...parentBinding.identity, kind: "regular_file" },
    size: Buffer.byteLength(content, "utf8"),
    links: 1,
  };
  const classified = classifyWorkspacePath(path, fakeBinding);
  const text = classifyTextBytes(Buffer.from(content, "utf8"), classified.mediaType);
  if (classified.secretLikely || classified.generated || !text.accepted) {
    throw policyDenied("The requested create-file target is not eligible for editing.");
  }
}

function initialGitPathState(
  entries: readonly GitStatusEntry[],
  path: string,
  exists: boolean,
): InitialGitPathState {
  const entry = entries.find((candidate) => candidate.path.utf8 === path);
  if (entry === undefined) return exists ? "clean_tracked" : "absent";
  if (entry.kind === "untracked") return "untracked";
  if (entry.kind === "ignored") return "ignored";
  const staged = entry.xy[0] !== "." && entry.xy[0] !== " ";
  const unstaged = entry.xy[1] !== "." && entry.xy[1] !== " ";
  if (staged && unstaged) return "staged_and_unstaged";
  if (staged) return "staged";
  if (unstaged) return "unstaged";
  return "unknown";
}

function initialGitStateValue(value: unknown): InitialGitPathState {
  const allowed: readonly InitialGitPathState[] = [
    "clean_tracked", "staged", "unstaged", "staged_and_unstaged", "untracked",
    "ignored", "absent", "unknown",
  ];
  if (typeof value !== "string" || !allowed.includes(value as InitialGitPathState)) {
    throw invalid("The captured initial Git path state is invalid.");
  }
  return value as InitialGitPathState;
}

function diffFact(diff: ReturnType<typeof createDiffArtifact>): JsonObject {
  return json({
    sha256: diff.fullDiffSha256,
    bytes: diff.fullDiffBytes,
    additions: diff.additions,
    deletions: diff.deletions,
    escapedPreview: diff.preview,
    previewTruncated: diff.previewTruncated,
  });
}

function textFact(value: string, maximumPreviewBytes: number): JsonObject {
  const escaped = escapeTerminal(value);
  const preview = truncateUtf8(escaped, maximumPreviewBytes);
  return json({
    sha256: sha256Hex(value),
    bytes: Buffer.byteLength(value, "utf8"),
    escapedPreview: preview.value,
    previewTruncated: preview.truncated,
  });
}

function safeFact(value: string, maximumPreviewBytes: number): JsonObject {
  return textFact(value, maximumPreviewBytes);
}

function boundedSummary(value: unknown, maximumBytes: number): JsonObject {
  const captured = json(value);
  if (canonicalBytes(captured).byteLength > maximumBytes) {
    throw budget("The terminal-safe approval summary exceeds its installed byte bound.");
  }
  return captured;
}

function escapeTerminal(value: string): string {
  let result = "";
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      (point < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") ||
      (point >= 0x7f && point <= 0x9f) ||
      [0x202a, 0x202b, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].includes(point)
    ) {
      result += `\\u{${point.toString(16)}}`;
    } else {
      result += character;
    }
  }
  return result;
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return { value, truncated: false };
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return {
        value: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
        truncated: true,
      };
    } catch {
      // Try the preceding UTF-8 boundary.
    }
  }
  return { value: "", truncated: true };
}

async function readOpenedBytes(
  opened: Awaited<ReturnType<typeof openStableRegularFile>>,
): Promise<Uint8Array> {
  const bytes = Buffer.alloc(opened.binding.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await opened.handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead < 1) throw conflict("The workspace file changed while it was read.");
    offset += result.bytesRead;
  }
  return Uint8Array.from(bytes);
}

function validateOptions(options: RobinR2RuntimeOptions): void {
  if (
    options === null ||
    typeof options !== "object" ||
    options.workspace === undefined ||
    options.git === undefined ||
    options.process === undefined ||
    options.process.controller === undefined
  ) {
    throw invalid("The R2 runtime requires trusted workspace, Git, and process services.");
  }
  if (options.git.identity.workspaceRoot !== options.workspace.identity.physicalRoot) {
    throw invalid("The workspace and Git service must bind the same physical root.");
  }
  if (
    options.process.executablePolicy.workspaceRoot !== options.workspace.identity.physicalRoot
  ) {
    throw invalid("The process policy and workspace must bind the same physical root.");
  }
}

function captureOptions(options: RobinR2RuntimeOptions): RobinR2RuntimeOptions {
  const executablePolicy = options.process.executablePolicy;
  const environmentProfile = options.process.environmentProfile;
  const clockNow = options.clock?.now.bind(options.clock);
  return Object.freeze({
    workspace: options.workspace,
    git: options.git,
    process: Object.freeze({
      controller: options.process.controller,
      executablePolicy: Object.freeze({
        trustedPath: Object.freeze([...executablePolicy.trustedPath]),
        workspaceRoot: executablePolicy.workspaceRoot,
        trustedExecutableRoots: Object.freeze([
          ...executablePolicy.trustedExecutableRoots,
        ]),
        allowWorkspaceExecutables: executablePolicy.allowWorkspaceExecutables,
      }),
      environmentProfile: Object.freeze({
        profileId: environmentProfile.profileId,
        inheritedKeys: Object.freeze([...environmentProfile.inheritedKeys]),
        fixed: Object.freeze({ ...environmentProfile.fixed }),
      }),
      ambientEnvironment: Object.freeze({
        ...options.process.ambientEnvironment,
      }),
    }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(clockNow === undefined
      ? {}
      : { clock: Object.freeze({ now: () => clockNow() }) }),
  });
}

function captureLimits(limits: RobinR2InstalledLimits): RobinR2InstalledLimits {
  const captured = json(limits) as unknown as RobinR2InstalledLimits;
  for (const section of Object.values(captured)) {
    for (const value of Object.values(section)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw invalid("Every installed R2 limit must be a positive safe integer.");
      }
    }
  }
  if (captured.git.maximumAbsoluteBytes < captured.git.maximumRetainedBytes) {
    throw invalid("The Git absolute byte bound must cover the retained byte bound.");
  }
  return captured;
}

function json(value: unknown): JsonObject {
  return snapshotBoundaryJsonObject(value);
}

function exactObject(value: unknown): JsonObject {
  return json(value);
}

function jsonStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalid("The normalized path list is invalid.");
  }
  return Object.freeze([...value]);
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.includes("\0")
  ) {
    throw invalid(`The ${label} is invalid.`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(`The ${label} is invalid.`);
  }
  return value as number;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  return new DOMException("The R2 tool operation was cancelled.", "AbortError");
}

function invalid(message: string): ReturnType<typeof createDomainError> {
  return createDomainError({ code: "invalid_input", message });
}

function budget(message: string): ReturnType<typeof createDomainError> {
  return createDomainError({ code: "budget_exceeded", message });
}

function conflict(message: string): ReturnType<typeof createDomainError> {
  return createDomainError({ code: "conflict", message });
}

function policyDenied(message: string): ReturnType<typeof createDomainError> {
  return createDomainError({ code: "policy_denied", message });
}

function approvalInvalid(message: string): ReturnType<typeof createDomainError> {
  return createDomainError({ code: "approval_invalid", message });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
