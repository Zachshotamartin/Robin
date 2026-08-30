import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";

import {
  RunIdKind,
  canonicalSha256Hex,
  createDomainError,
  isDomainError,
} from "@guard/contracts";
import type { DomainError, JsonObject } from "@guard/contracts";

export interface GitRepositoryLimits {
  readonly maximumFiles: number;
  readonly maximumBlobBytes: number;
  readonly maximumTotalBytes: number;
  readonly maximumPathBytes: number;
  readonly maximumPathDepth: number;
  readonly maximumGitOutputBytes: number;
  readonly commandTimeoutMs: number;
}

export interface TrustedGitWorktreeManagerOptions {
  readonly gitExecutable: string;
  readonly dataRoot: string;
  readonly limits: GitRepositoryLimits;
}

export interface GitTreeEntry {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly objectId: string;
  readonly byteLength: number;
  readonly contentSha256: string;
}

export interface GitRepositoryDescriptor extends JsonObject {
  readonly schemaVersion: 1;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly branchRef: string | null;
  readonly fileCount: number;
  readonly totalBlobBytes: number;
  readonly treeManifestHash: string;
  readonly indexHash: string;
  readonly configurationHash: string;
  readonly originalCheckoutManifestHash: string;
}

export interface GitRepositoryInspection {
  /** Trusted internal path. It is intentionally absent from the descriptor. */
  readonly sourceRoot: string;
  readonly commonDirectory: string;
  readonly descriptor: GitRepositoryDescriptor;
  readonly entries: readonly GitTreeEntry[];
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

export interface WorkspaceDescriptor extends JsonObject {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly fileCount: number;
  readonly totalBlobBytes: number;
  readonly originalCheckoutManifestHash: string;
  readonly materializedTreeManifestHash: string;
}

export interface ManagedGitWorkspace {
  /** Trusted host-only path. Never persist or release it as an event payload. */
  readonly root: string;
  readonly descriptor: WorkspaceDescriptor;
  readonly inspection: GitRepositoryInspection;
  cleanup(signal: AbortSignal): Promise<void>;
}

interface CapturedOptions {
  readonly gitExecutable: string;
  readonly dataRoot: string;
  readonly limits: GitRepositoryLimits;
}

interface CommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
}

interface RunOwnershipMarker {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly nonce: string;
}

const CONFIG_KEY_DENYLIST = Object.freeze([
  /^core\.attributesfile$/u,
  /^core\.autocrlf$/u,
  /^core\.eol$/u,
  /^core\.fsmonitor$/u,
  /^core\.hookspath$/u,
  /^core\.sparsecheckout(?:cone)?$/u,
  /^diff\..+\.(?:command|textconv)$/u,
  /^filter\..+\.(?:clean|process|smudge)$/u,
  /^merge\..+\.driver$/u,
]);

const UNSUPPORTED_ATTRIBUTE = /(?:^|\s)(?:-?text|eol=|filter(?:=|\s)|diff(?:=|\s)|merge(?:=|\s)|working-tree-encoding=|ident(?:\s|$)|export-subst(?:\s|$))/u;
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1\n";
const OWNERSHIP_MARKER = ".guard-workspace-owner.json";
const MAXIMUM_CONFIGURATION_BYTES = 256 * 1024;
const MAXIMUM_ATTRIBUTE_BYTES = 256 * 1024;
const MAXIMUM_BRANCH_REF_BYTES = 4_096;

export class TrustedGitWorktreeManager {
  readonly #options: CapturedOptions;

  public constructor(options: TrustedGitWorktreeManagerOptions) {
    this.#options = captureOptions(options);
  }

  public async inspectRepository(
    sourceRootInput: unknown,
    signal: AbortSignal,
  ): Promise<GitRepositoryInspection> {
    throwIfAborted(signal);
    const sourceRoot = await canonicalDirectory(sourceRootInput, "repository root");
    await this.#validateExecutable();

    const topLevel = decodeTrimmed(
      (
        await this.#runGit(
          sourceRoot,
          ["rev-parse", "--path-format=absolute", "--show-toplevel"],
          signal,
        )
      ).stdout,
      "repository root",
      this.#options.limits.maximumPathBytes * 4,
    );
    const canonicalTopLevel = await canonicalDirectory(topLevel, "repository root");
    if (canonicalTopLevel !== sourceRoot) {
      throw invalidInput("The selected path must be the exact Git repository root.");
    }

    const localConfiguration = await this.#readLocalConfiguration(sourceRoot, signal);
    rejectUnsupportedConfiguration(localConfiguration);
    await this.#rejectInfoAttributes(sourceRoot, signal);

    const statusOutput = (
      await this.#runGit(
        sourceRoot,
        ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        signal,
      )
    ).stdout;
    if (statusOutput.byteLength !== 0) {
      throw invalidInput("The source repository must be completely clean.");
    }

    const [baseCommit, baseTree, objectFormat, branchRef, commonDirectory, indexHash] =
      await Promise.all([
        this.#readObjectId(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"], signal),
        this.#readObjectId(sourceRoot, ["rev-parse", "--verify", "HEAD^{tree}"], signal),
        this.#readObjectFormat(sourceRoot, signal),
        this.#readBranchRef(sourceRoot, signal),
        this.#readCommonDirectory(sourceRoot, signal),
        this.#readIndexHash(sourceRoot, signal),
      ]);

    const tree = await this.#readTree(sourceRoot, baseTree, objectFormat, signal);
    rejectUnsupportedRepositoryTree(tree.entries, tree.blobs);

    const configurationHash = sha256(localConfiguration);
    const treeManifestHash = canonicalSha256Hex(
      tree.entries.map(({ path: entryPath, mode, objectId, byteLength, contentSha256 }) => ({
        path: entryPath,
        mode,
        objectId,
        byteLength,
        contentSha256,
      })),
    );
    const originalCheckoutManifestHash = canonicalSha256Hex({
      schemaVersion: 1,
      baseCommit,
      baseTree,
      objectFormat,
      branchRef,
      treeManifestHash,
      indexHash,
      configurationHash,
      cleanStatusSha256: sha256(statusOutput),
    });
    const descriptor: GitRepositoryDescriptor = deepFreeze({
      schemaVersion: 1,
      baseCommit,
      baseTree,
      objectFormat,
      branchRef,
      fileCount: tree.entries.length,
      totalBlobBytes: tree.totalBlobBytes,
      treeManifestHash,
      indexHash,
      configurationHash,
      originalCheckoutManifestHash,
    });
    return Object.freeze({
      sourceRoot,
      commonDirectory,
      descriptor,
      entries: tree.entries,
      blobs: tree.blobs,
    });
  }

  public async createWorkspace(
    requestInput: unknown,
    signal: AbortSignal,
  ): Promise<ManagedGitWorkspace> {
    throwIfAborted(signal);
    const request = captureWorkspaceRequest(requestInput);
    const inspection = await this.inspectRepository(request.sourceRoot, signal);
    throwIfAborted(signal);

    const dataRoot = await this.#ensureDataRoot();
    const runsRoot = path.join(dataRoot, "runs");
    await ensureOwnedDirectory(runsRoot, true);
    const runRoot = path.join(runsRoot, request.runId);
    const workspaceRoot = path.join(runRoot, "worktree");
    const configRoot = path.join(runRoot, "config");
    const hooksRoot = path.join(runRoot, "empty-hooks");
    const nonce = randomUUID();
    let worktreeAdded = false;
    let marker: RunOwnershipMarker | null = null;

    try {
      await mkdir(runRoot, { mode: 0o700 });
      await mkdir(configRoot, { mode: 0o700 });
      await mkdir(hooksRoot, { mode: 0o700 });
      marker = Object.freeze({ schemaVersion: 1, runId: request.runId, nonce });
      await writeExclusiveFile(
        path.join(runRoot, OWNERSHIP_MARKER),
        Buffer.from(JSON.stringify(marker), "utf8"),
        0o600,
      );
      throwIfAborted(signal);
      await this.#runGit(
        inspection.sourceRoot,
        [
          "worktree",
          "add",
          "--detach",
          "--no-checkout",
          workspaceRoot,
          inspection.descriptor.baseCommit,
        ],
        signal,
        { configRoot, hooksRoot },
      );
      worktreeAdded = true;
      await this.#runGit(
        workspaceRoot,
        ["read-tree", inspection.descriptor.baseCommit],
        signal,
        { configRoot, hooksRoot },
      );
      await this.#materializeTree(workspaceRoot, inspection, signal);
      await this.#verifyWorkspace(workspaceRoot, inspection, signal, {
        configRoot,
        hooksRoot,
      });
      const after = await this.inspectRepository(inspection.sourceRoot, signal);
      if (
        after.descriptor.originalCheckoutManifestHash !==
        inspection.descriptor.originalCheckoutManifestHash
      ) {
        throw invariant("Creating a disposable worktree changed the original checkout.");
      }

      const workspaceId = sha256(
        Buffer.from(
          `${request.runId}\u0000${inspection.descriptor.baseCommit}\u0000${nonce}`,
          "utf8",
        ),
      );
      const descriptor: WorkspaceDescriptor = deepFreeze({
        schemaVersion: 1,
        workspaceId,
        baseCommit: inspection.descriptor.baseCommit,
        baseTree: inspection.descriptor.baseTree,
        objectFormat: inspection.descriptor.objectFormat,
        fileCount: inspection.descriptor.fileCount,
        totalBlobBytes: inspection.descriptor.totalBlobBytes,
        originalCheckoutManifestHash:
          inspection.descriptor.originalCheckoutManifestHash,
        materializedTreeManifestHash: inspection.descriptor.treeManifestHash,
      });
      let cleaned = false;
      const cleanup = async (cleanupSignal: AbortSignal): Promise<void> => {
        if (cleaned) return;
        throwIfAborted(cleanupSignal);
        await verifyOwnershipMarker(runRoot, marker!);
        if (await pathExists(workspaceRoot)) {
          await this.#runGit(
            inspection.sourceRoot,
            ["worktree", "remove", "--force", workspaceRoot],
            cleanupSignal,
            { configRoot, hooksRoot },
          );
        }
        await verifyOwnershipMarker(runRoot, marker!);
        await removeOwnedTree(runRoot);
        cleaned = true;
      };
      return Object.freeze({
        root: workspaceRoot,
        descriptor,
        inspection,
        cleanup,
      });
    } catch (error: unknown) {
      const cleanupController = new AbortController();
      if (worktreeAdded) {
        try {
          await this.#runGit(
            inspection.sourceRoot,
            ["worktree", "remove", "--force", workspaceRoot],
            cleanupController.signal,
            { configRoot, hooksRoot },
          );
        } catch {
          // The owned directory remains for explicit inspection rather than
          // broad deletion when Git cannot prove the worktree was detached.
        }
      }
      if (marker !== null) {
        try {
          await verifyOwnershipMarker(runRoot, marker);
          if (!(await pathExists(workspaceRoot))) {
            await removeOwnedTree(runRoot);
          }
        } catch {
          // Preserve an unverified directory for quarantine.
        }
      }
      throw safeError(error, "The disposable Git workspace could not be created.");
    }
  }

  async #validateExecutable(): Promise<void> {
    let metadata;
    try {
      metadata = await stat(this.#options.gitExecutable);
    } catch {
      throw invalidInput("The configured Git executable is unavailable.");
    }
    if (!metadata.isFile()) {
      throw invalidInput("The configured Git executable must be a regular file.");
    }
  }

  async #ensureDataRoot(): Promise<string> {
    const configured = this.#options.dataRoot;
    if (!(await pathExists(configured))) {
      await mkdir(configured, { mode: 0o700 });
    }
    await assertOwnedDirectory(configured);
    return await realpath(configured);
  }

  async #readLocalConfiguration(
    sourceRoot: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const result = await this.#runGit(
      sourceRoot,
      ["config", "--local", "--null", "--list"],
      signal,
      undefined,
      MAXIMUM_CONFIGURATION_BYTES,
    );
    return result.stdout;
  }

  async #rejectInfoAttributes(
    sourceRoot: string,
    signal: AbortSignal,
  ): Promise<void> {
    const gitPath = decodeTrimmed(
      (
        await this.#runGit(
          sourceRoot,
          ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"],
          signal,
        )
      ).stdout,
      "Git attributes path",
      this.#options.limits.maximumPathBytes * 4,
    );
    if (!(await pathExists(gitPath))) return;
    const metadata = await lstat(gitPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw invalidInput("Repository info attributes must not redirect reads.");
    }
    if (metadata.size > MAXIMUM_ATTRIBUTE_BYTES) {
      throw budgetExceeded("Repository info attributes exceed the configured bound.");
    }
    const bytes = await readFile(gitPath);
    if (bytes.byteLength !== 0) {
      throw invalidInput("Repository-local info attributes are unsupported.");
    }
  }

  async #readObjectId(
    sourceRoot: string,
    argv: readonly string[],
    signal: AbortSignal,
  ): Promise<string> {
    const value = decodeTrimmed(
      (await this.#runGit(sourceRoot, argv, signal)).stdout,
      "Git object identifier",
      128,
    );
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
      throw invalidInput("Git returned an invalid object identifier.");
    }
    return value;
  }

  async #readObjectFormat(
    sourceRoot: string,
    signal: AbortSignal,
  ): Promise<"sha1" | "sha256"> {
    const value = decodeTrimmed(
      (
        await this.#runGit(
          sourceRoot,
          ["rev-parse", "--show-object-format"],
          signal,
        )
      ).stdout,
      "Git object format",
      32,
    );
    if (value !== "sha1" && value !== "sha256") {
      throw invalidInput("The repository uses an unsupported Git object format.");
    }
    return value;
  }

  async #readBranchRef(
    sourceRoot: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const result = await this.#runGitAllowFailure(
      sourceRoot,
      ["symbolic-ref", "-q", "HEAD"],
      signal,
      undefined,
      MAXIMUM_BRANCH_REF_BYTES,
    );
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) {
      throw infrastructureFailure("Git could not inspect the current reference.");
    }
    const value = decodeTrimmed(result.stdout, "Git reference", MAXIMUM_BRANCH_REF_BYTES);
    if (!value.startsWith("refs/") || value.includes("\u0000") || value.includes("\n")) {
      throw invalidInput("Git returned an invalid current reference.");
    }
    return value;
  }

  async #readCommonDirectory(
    sourceRoot: string,
    signal: AbortSignal,
  ): Promise<string> {
    const value = decodeTrimmed(
      (
        await this.#runGit(
          sourceRoot,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          signal,
        )
      ).stdout,
      "Git common directory",
      this.#options.limits.maximumPathBytes * 4,
    );
    return canonicalDirectory(value, "Git common directory");
  }

  async #readIndexHash(sourceRoot: string, signal: AbortSignal): Promise<string> {
    const indexPath = decodeTrimmed(
      (
        await this.#runGit(
          sourceRoot,
          ["rev-parse", "--path-format=absolute", "--git-path", "index"],
          signal,
        )
      ).stdout,
      "Git index path",
      this.#options.limits.maximumPathBytes * 4,
    );
    const metadata = await lstat(indexPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw invalidInput("The repository index is not a regular file.");
    }
    if (metadata.size > this.#options.limits.maximumGitOutputBytes) {
      throw budgetExceeded("The repository index exceeds the configured bound.");
    }
    return sha256(await readFile(indexPath));
  }

  async #readTree(
    sourceRoot: string,
    treeId: string,
    objectFormat: "sha1" | "sha256",
    signal: AbortSignal,
  ): Promise<{
    readonly entries: readonly GitTreeEntry[];
    readonly blobs: ReadonlyMap<string, Uint8Array>;
    readonly totalBlobBytes: number;
  }> {
    const listing = (
      await this.#runGit(
        sourceRoot,
        ["ls-tree", "-rz", "--full-tree", "-l", treeId],
        signal,
      )
    ).stdout;
    const records = splitNul(listing);
    if (records.length > this.#options.limits.maximumFiles) {
      throw budgetExceeded("The repository exceeds the configured file-count bound.");
    }
    const entries: GitTreeEntry[] = [];
    const blobs = new Map<string, Uint8Array>();
    let totalBlobBytes = 0;
    let priorPath: string | null = null;
    const caseFolded = new Set<string>();
    for (const record of records) {
      throwIfAborted(signal);
      const tab = record.indexOf(0x09);
      if (tab <= 0) {
        throw invalidInput("Git returned a malformed tree record.");
      }
      const header = decodeUtf8(record.subarray(0, tab), "Git tree header");
      const entryPath = decodeUtf8(record.subarray(tab + 1), "Git tree path");
      validateRepositoryPath(entryPath, this.#options.limits);
      if (priorPath !== null && compareUtf8(priorPath, entryPath) >= 0) {
        throw invalidInput("Git tree paths are not in strict canonical order.");
      }
      priorPath = entryPath;
      const folded = entryPath.normalize("NFC").toLocaleLowerCase("en-US");
      if (caseFolded.has(folded)) {
        throw invalidInput("The Git tree contains a portable path collision.");
      }
      caseFolded.add(folded);

      const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\s+(\d+|-)$/u.exec(header);
      if (match === null) {
        throw invalidInput("Git returned a malformed tree entry.");
      }
      const [, mode, type, objectId, sizeText] = match;
      const expectedLength = objectFormat === "sha1" ? 40 : 64;
      if (
        type !== "blob" ||
        objectId === undefined ||
        objectId.length !== expectedLength ||
        !/^[0-9a-f]+$/u.test(objectId) ||
        sizeText === undefined ||
        sizeText === "-"
      ) {
        throw invalidInput("The repository contains an unsupported tree object.");
      }
      if (mode !== "100644" && mode !== "100755") {
        throw invalidInput("The repository contains an unsupported file mode.");
      }
      const byteLength = Number(sizeText);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw invalidInput("Git returned an invalid blob size.");
      }
      if (byteLength > this.#options.limits.maximumBlobBytes) {
        throw budgetExceeded("A repository blob exceeds the configured byte bound.");
      }
      totalBlobBytes += byteLength;
      if (
        !Number.isSafeInteger(totalBlobBytes) ||
        totalBlobBytes > this.#options.limits.maximumTotalBytes
      ) {
        throw budgetExceeded("Repository blobs exceed the configured aggregate bound.");
      }
      const blob = (
        await this.#runGit(
          sourceRoot,
          ["cat-file", "blob", objectId],
          signal,
          undefined,
          Math.max(byteLength, 1),
        )
      ).stdout;
      if (blob.byteLength !== byteLength) {
        throw invariant("A Git blob disagrees with its declared size.");
      }
      const bytes = Uint8Array.from(blob);
      blobs.set(entryPath, bytes);
      entries.push(
        Object.freeze({
          path: entryPath,
          mode,
          objectId,
          byteLength,
          contentSha256: sha256(blob),
        }),
      );
    }
    return Object.freeze({
      entries: Object.freeze(entries),
      blobs: readonlyMap(blobs),
      totalBlobBytes,
    });
  }

  async #materializeTree(
    workspaceRoot: string,
    inspection: GitRepositoryInspection,
    signal: AbortSignal,
  ): Promise<void> {
    for (const entry of inspection.entries) {
      throwIfAborted(signal);
      const bytes = inspection.blobs.get(entry.path);
      if (bytes === undefined || bytes.byteLength !== entry.byteLength) {
        throw invariant("The inspected Git tree is missing an exact blob.");
      }
      const target = path.join(workspaceRoot, ...entry.path.split("/"));
      await ensureContainedParent(workspaceRoot, path.dirname(target));
      await writeExclusiveFile(
        target,
        Buffer.from(bytes),
        entry.mode === "100755" ? 0o700 : 0o600,
      );
      const written = await readRegularNoFollow(target, entry.byteLength);
      if (sha256(written) !== entry.contentSha256) {
        throw invariant("A materialized worktree file failed exact hash verification.");
      }
    }
  }

  async #verifyWorkspace(
    workspaceRoot: string,
    inspection: GitRepositoryInspection,
    signal: AbortSignal,
    paths: { readonly configRoot: string; readonly hooksRoot: string },
  ): Promise<void> {
    const statusOutput = (
      await this.#runGit(
        workspaceRoot,
        ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        signal,
        paths,
      )
    ).stdout;
    if (statusOutput.byteLength !== 0) {
      throw invariant("The raw-materialized worktree is not clean.");
    }
    const [head, tree, common] = await Promise.all([
      this.#readObjectId(
        workspaceRoot,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        signal,
      ),
      this.#readObjectId(workspaceRoot, ["write-tree"], signal),
      this.#readCommonDirectory(workspaceRoot, signal),
    ]);
    if (
      head !== inspection.descriptor.baseCommit ||
      tree !== inspection.descriptor.baseTree ||
      common !== inspection.commonDirectory
    ) {
      throw invariant("The disposable worktree does not match its pinned repository.");
    }
    const adminFile = path.join(workspaceRoot, ".git");
    const metadata = await lstat(adminFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024) {
      throw invariant("The disposable worktree has invalid Git administration metadata.");
    }
    const adminText = decodeUtf8(await readFile(adminFile), "worktree administration");
    if (!adminText.startsWith("gitdir: ") || !adminText.endsWith("\n")) {
      throw invariant("The disposable worktree Git pointer is malformed.");
    }
    const adminTarget = await realpath(adminText.slice(8, -1));
    const expectedPrefix = `${inspection.commonDirectory}${path.sep}worktrees${path.sep}`;
    if (!adminTarget.startsWith(expectedPrefix)) {
      throw invariant("The disposable worktree Git pointer escaped the expected repository.");
    }
  }

  async #runGit(
    cwd: string,
    argv: readonly string[],
    signal: AbortSignal,
    ownedPaths?: { readonly configRoot: string; readonly hooksRoot: string },
    maximumOutputBytes = this.#options.limits.maximumGitOutputBytes,
  ): Promise<CommandResult> {
    const result = await this.#runGitAllowFailure(
      cwd,
      argv,
      signal,
      ownedPaths,
      maximumOutputBytes,
    );
    if (result.exitCode !== 0) {
      throw infrastructureFailure("A trusted Git operation failed.");
    }
    return result;
  }

  async #runGitAllowFailure(
    cwd: string,
    argv: readonly string[],
    signal: AbortSignal,
    ownedPaths?: { readonly configRoot: string; readonly hooksRoot: string },
    maximumOutputBytes = this.#options.limits.maximumGitOutputBytes,
  ): Promise<CommandResult> {
    throwIfAborted(signal);
    validateArgv(argv);
    const configRoot = ownedPaths?.configRoot ?? path.join(this.#options.dataRoot, "config");
    const hooksRoot = ownedPaths?.hooksRoot ?? path.join(this.#options.dataRoot, "empty-hooks");
    const trustedArgv = [
      "-c",
      `core.hooksPath=${hooksRoot}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "commit.gpgSign=false",
      ...argv,
    ];
    const environment: NodeJS.ProcessEnv = {
      HOME: configRoot,
      XDG_CONFIG_HOME: configRoot,
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_EXTERNAL_DIFF: "",
      GIT_OPTIONAL_LOCKS: "0",
    };
    return runArgv({
      executable: this.#options.gitExecutable,
      argv: trustedArgv,
      cwd,
      environment,
      signal,
      maximumOutputBytes,
      timeoutMs: this.#options.limits.commandTimeoutMs,
    });
  }
}

async function runArgv(input: {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly maximumOutputBytes: number;
  readonly timeoutMs: number;
}): Promise<CommandResult> {
  throwIfAborted(input.signal);
  return new Promise<CommandResult>((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(input.executable, input.argv, {
      cwd: input.cwd,
      env: input.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);
      operation();
    };
    const stop = (): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // A process that already exited needs no further termination.
      }
    };
    const onAbort = (): void => {
      stop();
      finish(() => reject(cancelled()));
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > input.maximumOutputBytes) {
        stop();
        finish(() =>
          reject(budgetExceeded("A trusted Git command exceeded its output bound.")),
        );
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", () =>
      finish(() => reject(infrastructureFailure("A trusted Git process could not start."))),
    );
    child.on("close", (code) =>
      finish(() =>
        resolve(
          Object.freeze({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            exitCode: code ?? -1,
          }),
        ),
      ),
    );
    const timeout = setTimeout(() => {
      stop();
      finish(() => reject(infrastructureFailure("A trusted Git command timed out.")));
    }, input.timeoutMs);
    timeout.unref();
    input.signal.addEventListener("abort", onAbort, { once: true });
    // Close the check-to-listener race: cancellation between the pre-spawn
    // check and registration must still terminate the whole process group.
    if (input.signal.aborted) onAbort();
  });
}

function captureOptions(value: unknown): CapturedOptions {
  const fields = inspectExactData(value, ["gitExecutable", "dataRoot", "limits"], "manager options");
  const gitExecutable = fields["gitExecutable"];
  const dataRoot = fields["dataRoot"];
  if (
    typeof gitExecutable !== "string" ||
    !path.isAbsolute(gitExecutable) ||
    isFilesystemRoot(gitExecutable)
  ) {
    throw invalidInput("The Git executable must be an absolute non-root path.");
  }
  if (
    typeof dataRoot !== "string" ||
    !path.isAbsolute(dataRoot) ||
    isFilesystemRoot(dataRoot)
  ) {
    throw invalidInput("The worktree data root must be an absolute non-root path.");
  }
  const limitsFields = inspectExactData(
    fields["limits"],
    [
      "maximumFiles",
      "maximumBlobBytes",
      "maximumTotalBytes",
      "maximumPathBytes",
      "maximumPathDepth",
      "maximumGitOutputBytes",
      "commandTimeoutMs",
    ],
    "repository limits",
  );
  const limits: GitRepositoryLimits = Object.freeze({
    maximumFiles: positiveInteger(limitsFields["maximumFiles"], "maximumFiles"),
    maximumBlobBytes: positiveInteger(
      limitsFields["maximumBlobBytes"],
      "maximumBlobBytes",
    ),
    maximumTotalBytes: positiveInteger(
      limitsFields["maximumTotalBytes"],
      "maximumTotalBytes",
    ),
    maximumPathBytes: positiveInteger(
      limitsFields["maximumPathBytes"],
      "maximumPathBytes",
    ),
    maximumPathDepth: positiveInteger(
      limitsFields["maximumPathDepth"],
      "maximumPathDepth",
    ),
    maximumGitOutputBytes: positiveInteger(
      limitsFields["maximumGitOutputBytes"],
      "maximumGitOutputBytes",
    ),
    commandTimeoutMs: positiveInteger(
      limitsFields["commandTimeoutMs"],
      "commandTimeoutMs",
    ),
  });
  if (limits.maximumTotalBytes < limits.maximumBlobBytes) {
    throw invalidInput("The aggregate repository limit cannot be smaller than one blob.");
  }
  return Object.freeze({ gitExecutable, dataRoot, limits });
}

function captureWorkspaceRequest(value: unknown): {
  readonly runId: string;
  readonly sourceRoot: string;
} {
  const fields = inspectExactData(value, ["runId", "sourceRoot"], "workspace request");
  if (!RunIdKind.is(fields["runId"])) {
    throw invalidInput("A workspace request requires a valid run identifier.");
  }
  if (
    typeof fields["sourceRoot"] !== "string" ||
    !path.isAbsolute(fields["sourceRoot"]) ||
    isFilesystemRoot(fields["sourceRoot"])
  ) {
    throw invalidInput("A workspace request requires an absolute non-root source path.");
  }
  return Object.freeze({
    runId: fields["runId"],
    sourceRoot: fields["sourceRoot"],
  });
}

function inspectExactData(
  value: unknown,
  required: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidInput(`The ${label} must be a passive plain object.`);
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw invalidInput(`The ${label} could not be inspected safely.`);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== required.length ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    throw invalidInput(`The ${label} has missing or unknown fields.`);
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const key of required) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw invalidInput(`The ${label} must use enumerable data properties.`);
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function rejectUnsupportedConfiguration(bytes: Buffer): void {
  const fields = splitNul(bytes);
  for (const field of fields) {
    const value = decodeUtf8(field, "Git configuration");
    const separator = value.indexOf("\n");
    const key = (separator === -1 ? value : value.slice(0, separator)).toLowerCase();
    if (CONFIG_KEY_DENYLIST.some((pattern) => pattern.test(key))) {
      throw invalidInput("The repository configures an unsupported Git helper or transformation.");
    }
  }
}

function rejectUnsupportedRepositoryTree(
  entries: readonly GitTreeEntry[],
  blobs: ReadonlyMap<string, Uint8Array>,
): void {
  if (entries.some((entry) => entry.path === ".gitmodules")) {
    throw invalidInput("Git submodules are unsupported.");
  }
  for (const entry of entries) {
    const bytes = blobs.get(entry.path);
    if (bytes === undefined) throw invariant("A tree entry has no inspected blob.");
    if (
      entry.path === ".gitattributes" ||
      entry.path.endsWith("/.gitattributes")
    ) {
      if (bytes.byteLength > MAXIMUM_ATTRIBUTE_BYTES) {
        throw budgetExceeded("Repository attributes exceed the configured bound.");
      }
      const text = decodeUtf8(Buffer.from(bytes), "Git attributes");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        if (UNSUPPORTED_ATTRIBUTE.test(trimmed)) {
          throw invalidInput("The repository declares an unsupported Git attribute.");
        }
      }
    }
    const prefix = Buffer.from(bytes.subarray(0, Buffer.byteLength(LFS_POINTER_PREFIX)));
    if (prefix.toString("utf8") === LFS_POINTER_PREFIX) {
      throw invalidInput("Git LFS pointer files are unsupported.");
    }
  }
}

function validateRepositoryPath(value: string, limits: GitRepositoryLimits): void {
  if (
    value === "" ||
    !isWellFormedUnicode(value) ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    /[<>:"|?*%\\]/u.test(value) ||
    /^[a-zA-Z]:/u.test(value) ||
    Buffer.byteLength(value, "utf8") > limits.maximumPathBytes
  ) {
    throw invalidInput("The repository contains a noncanonical path.");
  }
  const segments = value.split("/");
  if (segments.length > limits.maximumPathDepth) {
    throw budgetExceeded("A repository path exceeds the configured depth bound.");
  }
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      Buffer.byteLength(segment, "utf8") > 255 ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
    ) {
      throw invalidInput("The repository contains a nonportable path segment.");
    }
  }
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

async function canonicalDirectory(value: unknown, label: string): Promise<string> {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    isFilesystemRoot(value)
  ) {
    throw invalidInput(`The ${label} must be an absolute non-root path.`);
  }
  let resolved: string;
  let metadata;
  try {
    resolved = await realpath(value);
    metadata = await lstat(resolved);
  } catch {
    throw invalidInput(`The ${label} is unavailable.`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw invalidInput(`The ${label} must be a real directory.`);
  }
  return resolved;
}

async function ensureOwnedDirectory(target: string, create: boolean): Promise<void> {
  if (create && !(await pathExists(target))) {
    await mkdir(target, { mode: 0o700 });
  }
  await assertOwnedDirectory(target);
}

async function assertOwnedDirectory(target: string): Promise<void> {
  const metadata = await lstat(target);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw invalidInput("A Guard-owned data directory has unsafe ownership or permissions.");
  }
}

async function ensureContainedParent(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (relative === "") return;
    throw invariant("A materialized path escaped the owned worktree.");
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!(await pathExists(current))) {
      await mkdir(current, { mode: 0o700 });
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw invariant("A worktree path component is not an owned directory.");
    }
  }
}

async function writeExclusiveFile(
  target: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const handle = await open(
    target,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readRegularNoFollow(target: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw invariant("A materialized path is not the expected regular file.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function verifyOwnershipMarker(
  runRoot: string,
  expected: RunOwnershipMarker,
): Promise<void> {
  const bytes = await readRegularNoFollow(
    path.join(runRoot, OWNERSHIP_MARKER),
    4_096,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes, "workspace ownership marker"));
  } catch {
    throw invariant("The workspace ownership marker is invalid.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { readonly schemaVersion?: unknown }).schemaVersion !== 1 ||
    (parsed as { readonly runId?: unknown }).runId !== expected.runId ||
    (parsed as { readonly nonce?: unknown }).nonce !== expected.nonce ||
    Reflect.ownKeys(parsed).length !== 3
  ) {
    throw invariant("The workspace ownership marker does not match this run.");
  }
}

async function removeOwnedTree(root: string): Promise<void> {
  const directory = await opendir(root);
  try {
    for await (const entry of directory) {
      const target = path.join(root, entry.name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) {
        await unlink(target);
      } else if (metadata.isDirectory()) {
        await removeOwnedTree(target);
      } else if (metadata.isFile()) {
        await unlink(target);
      } else {
        throw invariant("Owned cleanup encountered an unsupported filesystem entry.");
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  await rmdir(root);
}

function readonlyMap<TKey, TValue>(source: Map<TKey, TValue>): ReadonlyMap<TKey, TValue> {
  const snapshot = new Map(source);
  return Object.freeze({
    get size() {
      return snapshot.size;
    },
    get(key: TKey) {
      return snapshot.get(key);
    },
    has(key: TKey) {
      return snapshot.has(key);
    },
    entries() {
      return snapshot.entries();
    },
    keys() {
      return snapshot.keys();
    },
    values() {
      return snapshot.values();
    },
    forEach(
      callbackfn: (value: TValue, key: TKey, map: ReadonlyMap<TKey, TValue>) => void,
      thisArg?: unknown,
    ) {
      for (const [key, value] of snapshot) {
        callbackfn.call(thisArg, value, key, this);
      }
    },
    [Symbol.iterator]() {
      return snapshot[Symbol.iterator]();
    },
  } satisfies ReadonlyMap<TKey, TValue>);
}

function splitNul(bytes: Buffer): readonly Buffer[] {
  if (bytes.byteLength === 0) return Object.freeze([]);
  const output: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    output.push(Buffer.from(bytes.subarray(start, index)));
    start = index + 1;
  }
  if (start !== bytes.byteLength) {
    throw invalidInput("Git returned a nonterminated NUL-delimited record.");
  }
  return Object.freeze(output);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidInput(`The ${label} is not valid UTF-8.`);
  }
}

function decodeTrimmed(bytes: Uint8Array, label: string, maximumBytes: number): string {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw invalidInput(`The ${label} is outside its configured bound.`);
  }
  const value = decodeUtf8(bytes, label);
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n")) {
    throw invalidInput(`The ${label} has an invalid record shape.`);
  }
  return value.slice(0, -1);
}

function validateArgv(argv: readonly string[]): void {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.length > 128 ||
    argv.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item.includes("\u0000") ||
        Buffer.byteLength(item, "utf8") > 16 * 1024,
    )
  ) {
    throw invariant("A trusted Git command has invalid argument data.");
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function positiveInteger(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw invalidInput(`The ${name} limit must be a positive safe integer.`);
  }
  return value;
}

function isFilesystemRoot(value: string): boolean {
  const parsed = path.parse(path.resolve(value));
  return path.resolve(value) === parsed.root;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) {
    throw invalidInput("A trusted Git operation requires an AbortSignal.");
  }
  if (signal.aborted) throw cancelled();
}

function safeError(error: unknown, fallback: string): DomainError {
  if (isDomainError(error)) return error;
  return infrastructureFailure(fallback);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function invalidInput(message: string): DomainError {
  return createDomainError({ code: "invalid_input", message });
}

function budgetExceeded(message: string): DomainError {
  return createDomainError({ code: "budget_exceeded", message });
}

function cancelled(): DomainError {
  return createDomainError({ code: "cancelled", message: "The trusted Git operation was cancelled." });
}

function invariant(message: string): DomainError {
  return createDomainError({ code: "invariant_violated", message });
}

function infrastructureFailure(message: string): DomainError {
  return createDomainError({ code: "infrastructure_failed", message });
}
