import { constants } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { CapabilityGatewayOptions } from "@guard/capability-gateway";
import {
  ControlledGitRunner,
  GitReadService,
  GitToolError,
  type GitRepositoryIdentity,
  type GitRunResult,
} from "@guard/tool-git";
import {
  ProcessController,
  type ExecutableResolutionPolicy,
  type ProcessEnvironmentProfile,
} from "@guard/tool-process";
import {
  discoverPhysicalWorkspace,
  type GitWorkspaceProbeResult,
  type WorkspaceGitProbe,
  type WorkspaceHandle,
  type WorkspaceOrigin,
} from "@guard/tool-workspace";
import {
  createRobinR2CapabilityRuntime,
  type RobinR2CapabilityRuntime,
} from "@guard/robin-tools";

import {
  R1RobinApplication,
  type R1RobinApplicationOptions,
} from "./session-service.js";
import {
  R2GatewayToolDispatcher,
  type R2GatewayActionIdSource,
} from "./r2-gateway-tool-dispatcher.js";
import type { RobinR2PermissionMode } from "./r2-policy.js";
import { R2SyntheticCodingProvider } from "./r2-synthetic-provider.js";

const DEFAULT_MODEL_ID = "synthetic-r2-v1";
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_GIT_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_GIT_STDERR_BYTES = 1024 * 1024;
const DISCOVERY_STDOUT_BYTES = 64 * 1024;
const MAXIMUM_SESSION_ID_BYTES = 256;
const MAXIMUM_START_DIRECTORY_BYTES = 4_096;

const PROCESS_INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  "COLORTERM",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
]);

export type R2RobinApplicationLifecycleOptions = Pick<
  R1RobinApplicationOptions,
  | "coordinator"
  | "eventIds"
  | "journalLimits"
  | "monotonicNow"
  | "now"
  | "shutdownDeadline"
  | "shutdownTimeoutMs"
>;

export interface R2RobinApplicationDispatcherOptions {
  readonly actionIds?: R2GatewayActionIdSource;
  readonly gateway?: CapabilityGatewayOptions;
  readonly secretCorrelationToken?: string;
}

/**
 * Trusted host configuration for the R2 physical-repository composition.
 * None of these values are delegated to the model. The explicit Git path is a
 * host review seam and is still canonicalized and checked as an executable
 * regular file before use.
 */
export interface R2RobinApplicationOptions {
  readonly sessionId: string;
  readonly startDirectory: string;
  readonly workspaceOrigin?: WorkspaceOrigin;
  readonly permissionMode?: RobinR2PermissionMode;
  readonly modelId?: string;
  readonly maximumTurns?: number;
  readonly gitExecutable?: string;
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly application?: R2RobinApplicationLifecycleOptions;
  readonly dispatcher?: R2RobinApplicationDispatcherOptions;
}

export interface R2RobinApplicationMetadata {
  readonly schemaVersion: 1;
  readonly milestone: "R2";
  readonly workspace: {
    readonly kind: "physical_git_worktree";
    readonly physicalRoot: string;
    readonly displayRoot: string;
    readonly workspaceId: string;
    readonly accessMode: "read_write";
    readonly containmentTier:
      | "descriptor_strong"
      | "verified_best_effort"
      | "unavailable";
  };
  readonly git: {
    readonly executable: string;
    readonly executableSelection: "installed_default" | "explicit_host_path";
    readonly repositoryId: string;
    readonly worktreeId: string;
    readonly objectFormat: "sha1" | "sha256";
    readonly readOperationsOnly: true;
  };
  readonly provider: {
    readonly kind: "credential_free_synthetic_fixture";
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly modelId: string;
    readonly hostedApiConfigured: false;
  };
  readonly session: {
    readonly persistence: "ephemeral";
    readonly permissionMode: RobinR2PermissionMode;
  };
  readonly execution: {
    readonly sandboxed: false;
    readonly filesystemIsolation: "none";
    readonly networkIsolation: "none";
    readonly workspaceExecutablesAllowed: false;
    readonly repositoryEdits: "manual_approval_required";
    readonly processRuns: "manual_approval_required";
    readonly environmentProfileId: string;
  };
  readonly notices: readonly string[];
}

export interface R2RobinApplicationBootstrap {
  readonly application: R1RobinApplication;
  readonly workspace: WorkspaceHandle;
  readonly git: GitReadService;
  readonly runtime: RobinR2CapabilityRuntime;
  readonly process: {
    readonly controller: ProcessController;
    readonly executablePolicy: ExecutableResolutionPolicy;
    readonly environmentProfile: ProcessEnvironmentProfile;
  };
  readonly metadata: R2RobinApplicationMetadata;
}

interface ReviewedGitExecutable {
  readonly physicalPath: string;
  readonly selection: R2RobinApplicationMetadata["git"]["executableSelection"];
}

/** Creates Robin's complete R2 physical-repository application composition. */
export async function createR2RobinApplication(
  options: R2RobinApplicationOptions,
): Promise<R2RobinApplicationBootstrap> {
  validateOptions(options);
  const signal = options.signal ?? new AbortController().signal;
  throwIfAborted(signal);

  const physicalStartDirectory = await canonicalDirectory(
    options.startDirectory,
    "The R2 workspace start directory is unavailable.",
  );
  throwIfAborted(signal);

  const reviewedGit = await resolveReviewedGitExecutable(
    options.gitExecutable,
  );
  throwIfAborted(signal);
  const gitEnvironment = captureGitEnvironment(
    options.ambientEnvironment ?? process.env,
    reviewedGit.physicalPath,
  );
  const discoveryRunner = createControlledGitRunner(
    reviewedGit.physicalPath,
    physicalStartDirectory,
    gitEnvironment,
  );
  const rootResult = await discoveryRunner.runRead(
    "rev-parse",
    ["--path-format=absolute", "--show-toplevel"],
    {
      signal,
      maximumRetainedStdoutBytes: DISCOVERY_STDOUT_BYTES,
      maximumAbsoluteStdoutBytes: DISCOVERY_STDOUT_BYTES,
    },
  );
  const reportedRoot = decodeSingleAbsoluteGitPath(rootResult);
  const physicalRepositoryRoot = await canonicalDirectory(
    reportedRoot,
    "The Git worktree root is unavailable.",
  );
  if (!isWithin(physicalStartDirectory, physicalRepositoryRoot)) {
    throw new GitToolError(
      "unsafe_repository",
      "Git reported a worktree that does not contain the workspace start directory.",
    );
  }
  throwIfAborted(signal);

  const gitRunner = createControlledGitRunner(
    reviewedGit.physicalPath,
    physicalRepositoryRoot,
    gitEnvironment,
  );
  const git = await GitReadService.open(gitRunner, signal);
  if (git.identity.workspaceRoot !== physicalRepositoryRoot) {
    throw new GitToolError(
      "unsafe_repository",
      "The opened Git identity diverged from the discovered physical worktree root.",
    );
  }

  const workspaceOrigin = options.workspaceOrigin ?? "launch_directory";
  const workspace = await discoverPhysicalWorkspace(
    {
      startDirectory: physicalStartDirectory,
      createdFrom: workspaceOrigin,
    },
    { gitProbe: createWorkspaceGitProbe(git) },
    signal,
  );
  if (
    workspace.identity.physicalRoot !== physicalRepositoryRoot ||
    workspace.identity.git === null ||
    workspace.identity.git.worktreeRoot !== git.identity.workspaceRoot
  ) {
    throw new GitToolError(
      "repository_changed",
      "The physical workspace and Git repository identities did not bind to the same worktree.",
    );
  }
  throwIfAborted(signal);

  const processComposition = await createProcessComposition(
    physicalRepositoryRoot,
    reviewedGit.physicalPath,
    options.ambientEnvironment ?? process.env,
  );
  const runtime = createRobinR2CapabilityRuntime({
    workspace,
    git,
    process: {
      controller: processComposition.controller,
      executablePolicy: processComposition.executablePolicy,
      environmentProfile: processComposition.environmentProfile,
      ambientEnvironment: processComposition.ambientEnvironment,
    },
  });
  const provider = new R2SyntheticCodingProvider();
  const permissionMode = options.permissionMode ?? "ask";
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const applicationOptions = options.application ?? {};
  const dispatcherOptions = options.dispatcher ?? {};
  const application = new R1RobinApplication({
    ...applicationOptions,
    sessionId: options.sessionId,
    provider,
    modelId,
    permissionMode,
    ...(options.maximumTurns === undefined
      ? {}
      : { maximumTurns: options.maximumTurns }),
    toolDispatcherFactory: (lifecycle) =>
      new R2GatewayToolDispatcher({
        runtime,
        lifecycle,
        permissionMode,
        ...dispatcherOptions,
      }),
  });
  const gitWorkspace = workspace.identity.git;
  if (gitWorkspace === null) {
    throw new GitToolError(
      "invariant_violated",
      "The R2 repository composition lost its Git workspace identity.",
    );
  }
  const metadata = createMetadata({
    workspace,
    git,
    reviewedGit,
    provider,
    modelId,
    permissionMode,
    environmentProfile: processComposition.environmentProfile,
  });

  return Object.freeze({
    application,
    workspace,
    git,
    runtime,
    process: Object.freeze({
      controller: processComposition.controller,
      executablePolicy: processComposition.executablePolicy,
      environmentProfile: processComposition.environmentProfile,
    }),
    metadata,
  });
}

/** Naming alias for hosts that describe R2 composition as a bootstrap phase. */
export function bootstrapR2RobinApplication(
  options: R2RobinApplicationOptions,
): Promise<R2RobinApplicationBootstrap> {
  return createR2RobinApplication(options);
}

function createControlledGitRunner(
  gitExecutable: string,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
): ControlledGitRunner {
  return new ControlledGitRunner({
    gitExecutable,
    cwd,
    environment,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    maximumStdoutBytes: DEFAULT_GIT_STDOUT_BYTES,
    maximumStderrBytes: DEFAULT_GIT_STDERR_BYTES,
  });
}

function createWorkspaceGitProbe(git: GitReadService): WorkspaceGitProbe {
  return Object.freeze({
    inspect: async (
      physicalStartDirectory: string,
      signal: AbortSignal,
    ): Promise<GitWorkspaceProbeResult> => {
      throwIfAborted(signal);
      if (!isWithin(physicalStartDirectory, git.identity.workspaceRoot)) {
        throw new GitToolError(
          "unsafe_repository",
          "The Git probe was asked to bind a directory outside its worktree.",
        );
      }
      if (!(await git.revalidate(signal))) {
        throw new GitToolError(
          "repository_changed",
          "The Git repository identity changed during workspace discovery.",
        );
      }
      throwIfAborted(signal);
      const identity = git.identity;
      const initialStatus = git.initialStatus;
      return Object.freeze({
        worktreeRoot: identity.workspaceRoot,
        commonDirectory: identity.commonDirectory,
        gitDirectory: identity.gitDirectory,
        objectFormat: identity.objectFormat,
        initialHead: initialStatus.branch.oid,
        branch: initialStatus.branch.head,
        linked: identity.linkedWorktree,
        bare: identity.bare,
        shallow: identity.shallow,
        sparse: identity.sparse,
        submodule: identity.submodule,
        operationState: workspaceOperationState(identity),
        initialStatusHash: initialStatus.statusSha256,
      });
    },
  });
}

function workspaceOperationState(
  identity: GitRepositoryIdentity,
): GitWorkspaceProbeResult["operationState"] {
  if (identity.operationState.length === 0) return "none";
  if (identity.operationState.length === 1) {
    return identity.operationState[0] ?? "unknown";
  }
  return "unknown";
}

async function createProcessComposition(
  workspaceRoot: string,
  gitExecutable: string,
  ambientSource: Readonly<Record<string, string | undefined>>,
): Promise<{
  readonly controller: ProcessController;
  readonly executablePolicy: ExecutableResolutionPolicy;
  readonly environmentProfile: ProcessEnvironmentProfile;
  readonly ambientEnvironment: Readonly<Record<string, string | undefined>>;
}> {
  const processExecutable = await realpath(process.execPath).catch(() => {
    throw new GitToolError(
      "executable_not_found",
      "Robin could not canonicalize the host Node.js executable.",
    );
  });
  const executableDirectoryCandidates = [
    path.dirname(processExecutable),
    path.dirname(gitExecutable),
    "/usr/bin",
    "/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    ...(process.platform === "win32"
      ? windowsExecutableDirectoryCandidates(ambientSource)
      : []),
  ];
  const trustedPath = await existingPhysicalDirectories(
    executableDirectoryCandidates,
  );
  const trustedRootCandidates = [
    path.dirname(path.dirname(processExecutable)),
    path.dirname(path.dirname(gitExecutable)),
    "/usr",
    "/bin",
    "/usr/local",
    "/opt/homebrew",
    ...(process.platform === "win32"
      ? windowsExecutableRootCandidates(ambientSource)
      : []),
  ];
  const discoveredRoots = await existingPhysicalDirectories(
    trustedRootCandidates,
  );
  const trustedExecutableRoots = Object.freeze(
    discoveredRoots.filter((candidate) => !isWithin(workspaceRoot, candidate)),
  );
  if (trustedPath.length === 0 || trustedExecutableRoots.length === 0) {
    throw new GitToolError(
      "executable_not_found",
      "Robin could not establish a reviewed host executable policy.",
    );
  }
  const executablePolicy: ExecutableResolutionPolicy = Object.freeze({
    trustedPath,
    workspaceRoot,
    trustedExecutableRoots,
    allowWorkspaceExecutables: false,
  });
  const environmentProfile: ProcessEnvironmentProfile = Object.freeze({
    profileId: "robin-r2-local-verification-v1",
    inheritedKeys: PROCESS_INHERITED_ENVIRONMENT_KEYS,
    fixed: Object.freeze({
      CI: "1",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
      PATH: trustedPath.join(path.delimiter),
    }),
  });
  const ambientEnvironment = captureAmbientEnvironment(ambientSource);
  return Object.freeze({
    controller: new ProcessController({
      forceWaitMs: 2_000,
      pollIntervalMs: 10,
    }),
    executablePolicy,
    environmentProfile,
    ambientEnvironment,
  });
}

async function resolveReviewedGitExecutable(
  explicitPath: string | undefined,
): Promise<ReviewedGitExecutable> {
  if (explicitPath !== undefined) {
    if (
      typeof explicitPath !== "string" ||
      !path.isAbsolute(explicitPath) ||
      explicitPath.includes("\u0000") ||
      Buffer.byteLength(explicitPath, "utf8") > 16_384
    ) {
      throw new GitToolError(
        "invalid_request",
        "An explicit Git executable must be a bounded absolute path.",
      );
    }
    const physicalPath = await executableRegularFile(explicitPath);
    if (physicalPath === null) {
      throw new GitToolError(
        "executable_not_found",
        "The explicit Git executable is unavailable or ineligible.",
      );
    }
    return Object.freeze({
      physicalPath,
      selection: "explicit_host_path" as const,
    });
  }

  for (const candidate of defaultGitExecutableCandidates()) {
    const physicalPath = await executableRegularFile(candidate);
    if (physicalPath !== null) {
      return Object.freeze({
        physicalPath,
        selection: "installed_default" as const,
      });
    }
  }
  throw new GitToolError(
    "executable_not_found",
    "Robin could not find Git at a reviewed installed path. Supply an explicit absolute Git executable.",
  );
}

function defaultGitExecutableCandidates(): readonly string[] {
  if (process.platform === "win32") {
    return Object.freeze([
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    ]);
  }
  return Object.freeze([
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    "/bin/git",
  ]);
}

async function executableRegularFile(candidate: string): Promise<string | null> {
  try {
    const physicalPath = await realpath(candidate);
    const facts = await stat(physicalPath);
    const executableBits =
      constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH;
    if (
      !facts.isFile() ||
      (process.platform !== "win32" && (facts.mode & executableBits) === 0)
    ) {
      return null;
    }
    return physicalPath;
  } catch {
    return null;
  }
}

async function existingPhysicalDirectories(
  candidates: readonly string[],
): Promise<readonly string[]> {
  const directories = new Set<string>();
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || candidate.includes("\u0000")) continue;
    try {
      const physicalPath = await realpath(candidate);
      const facts = await lstat(physicalPath);
      if (facts.isDirectory() && !facts.isSymbolicLink()) {
        directories.add(physicalPath);
      }
    } catch {
      // An absent optional installed directory is not part of the policy.
    }
  }
  return Object.freeze([...directories]);
}

function captureGitEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  gitExecutable: string,
): Readonly<Record<string, string | undefined>> {
  const captured = captureAmbientEnvironment(source);
  const gitPath = Object.freeze([
    path.dirname(gitExecutable),
    "/usr/bin",
    "/bin",
  ]).join(path.delimiter);
  return Object.freeze({ ...captured, PATH: gitPath });
}

function captureAmbientEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const captured: Record<string, string> = {};
  try {
    for (const key of PROCESS_INHERITED_ENVIRONMENT_KEYS) {
      const value = source[key];
      if (typeof value === "string" && !value.includes("\u0000")) {
        captured[key] = value;
      }
    }
  } catch {
    throw new GitToolError(
      "invalid_request",
      "The host environment could not be captured safely.",
    );
  }
  return Object.freeze(captured);
}

function decodeSingleAbsoluteGitPath(result: GitRunResult): string {
  if (
    result.stdoutTruncated ||
    result.stdoutBytes !== result.stdout.byteLength ||
    result.stdout.byteLength === 0
  ) {
    throw new GitToolError(
      "parse_failed",
      "Git returned a missing or truncated worktree root.",
    );
  }
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new GitToolError(
      "parse_failed",
      "Git returned a worktree root that is not valid UTF-8.",
    );
  }
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n") ||
    !path.isAbsolute(value)
  ) {
    throw new GitToolError(
      "parse_failed",
      "Git returned an invalid absolute worktree root.",
    );
  }
  return path.normalize(value);
}

async function canonicalDirectory(
  candidate: string,
  unavailableMessage: string,
): Promise<string> {
  try {
    const physicalPath = await realpath(candidate);
    const facts = await lstat(physicalPath);
    if (!facts.isDirectory() || facts.isSymbolicLink()) {
      throw new Error("not a physical directory");
    }
    return physicalPath;
  } catch {
    throw new GitToolError("invalid_request", unavailableMessage);
  }
}

function createMetadata(input: {
  readonly workspace: WorkspaceHandle;
  readonly git: GitReadService;
  readonly reviewedGit: ReviewedGitExecutable;
  readonly provider: R2SyntheticCodingProvider;
  readonly modelId: string;
  readonly permissionMode: RobinR2PermissionMode;
  readonly environmentProfile: ProcessEnvironmentProfile;
}): R2RobinApplicationMetadata {
  const gitWorkspace = input.workspace.identity.git;
  if (gitWorkspace === null) {
    throw new GitToolError(
      "invariant_violated",
      "R2 metadata requires a physical Git worktree identity.",
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    milestone: "R2" as const,
    workspace: Object.freeze({
      kind: "physical_git_worktree" as const,
      physicalRoot: input.workspace.identity.physicalRoot,
      displayRoot: input.workspace.displayRoot,
      workspaceId: input.workspace.identity.workspaceId,
      accessMode: "read_write" as const,
      containmentTier:
        input.workspace.identity.mountCapabilities.containmentTier,
    }),
    git: Object.freeze({
      executable: input.reviewedGit.physicalPath,
      executableSelection: input.reviewedGit.selection,
      repositoryId: input.git.identity.repositoryId,
      worktreeId: gitWorkspace.worktreeId,
      objectFormat: input.git.identity.objectFormat,
      readOperationsOnly: true as const,
    }),
    provider: Object.freeze({
      kind: "credential_free_synthetic_fixture" as const,
      adapterId: input.provider.descriptor.adapterId,
      adapterVersion: input.provider.descriptor.adapterVersion,
      modelId: input.modelId,
      hostedApiConfigured: false as const,
    }),
    session: Object.freeze({
      persistence: "ephemeral" as const,
      permissionMode: input.permissionMode,
    }),
    execution: Object.freeze({
      sandboxed: false as const,
      filesystemIsolation: "none" as const,
      networkIsolation: "none" as const,
      workspaceExecutablesAllowed: false as const,
      repositoryEdits: "manual_approval_required" as const,
      processRuns: "manual_approval_required" as const,
      environmentProfileId: input.environmentProfile.profileId,
    }),
    notices: Object.freeze([
      "R2 sessions and approval state are ephemeral and are not resumable.",
      "Approved processes run directly on the host without filesystem or network isolation.",
      "R2 uses a deterministic credential-free provider; hosted providers and BYOK arrive in a later milestone.",
    ]),
  });
}

function windowsExecutableDirectoryCandidates(
  source: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const systemRoot = safeAbsoluteEnvironmentPath(source, "SystemRoot");
  return Object.freeze([
    ...(systemRoot === null ? [] : [path.join(systemRoot, "System32")]),
  ]);
}

function windowsExecutableRootCandidates(
  source: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const systemRoot = safeAbsoluteEnvironmentPath(source, "SystemRoot");
  return Object.freeze(systemRoot === null ? [] : [systemRoot]);
}

function safeAbsoluteEnvironmentPath(
  source: Readonly<Record<string, string | undefined>>,
  key: string,
): string | null {
  try {
    const value = source[key];
    return typeof value === "string" &&
      path.isAbsolute(value) &&
      !value.includes("\u0000")
      ? value
      : null;
  } catch {
    return null;
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function validateOptions(options: R2RobinApplicationOptions): void {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.sessionId !== "string" ||
    options.sessionId.length === 0 ||
    options.sessionId.trim() !== options.sessionId ||
    containsIdentifierControlCodePoint(options.sessionId) ||
    Buffer.byteLength(options.sessionId, "utf8") > MAXIMUM_SESSION_ID_BYTES ||
    typeof options.startDirectory !== "string" ||
    options.startDirectory.length === 0 ||
    options.startDirectory.includes("\u0000") ||
    Buffer.byteLength(options.startDirectory, "utf8") >
      MAXIMUM_START_DIRECTORY_BYTES
  ) {
    throw new GitToolError(
      "invalid_request",
      "R2 bootstrap requires a session identity and workspace start directory.",
    );
  }
  if (
    options.workspaceOrigin !== undefined &&
    options.workspaceOrigin !== "launch_directory" &&
    options.workspaceOrigin !== "explicit_flag"
  ) {
    throw new GitToolError(
      "invalid_request",
      "Ephemeral R2 bootstrap supports launch-directory or explicit workspace origins only.",
    );
  }
  if (
    options.permissionMode !== undefined &&
    options.permissionMode !== "ask" &&
    options.permissionMode !== "plan"
  ) {
    throw new GitToolError("invalid_request", "The R2 permission mode is invalid.");
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new GitToolError("invalid_request", "R2 bootstrap requires an AbortSignal.");
  }
  if (options.modelId !== undefined && options.modelId !== DEFAULT_MODEL_ID) {
    throw new GitToolError(
      "invalid_request",
      `The R2 synthetic provider requires model ${DEFAULT_MODEL_ID}.`,
    );
  }
}

function containsIdentifierControlCodePoint(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (
      point <= 0x1f ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new GitToolError("cancelled", "R2 application bootstrap was cancelled.");
  }
}
