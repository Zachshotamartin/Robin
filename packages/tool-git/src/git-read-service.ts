import {
  attributeGitStatus,
  type GitEditLedgerEntry,
  type GitPathAttribution,
} from "./attribution.js";
import {
  captureGitStatusSnapshot,
  readCurrentBranch,
  readGitDiff,
  readGitLog,
  type GitCurrentBranch,
  type GitDiffRequest,
  type GitDiffResult,
  type GitLogEntry,
  type GitLogOptions,
} from "./git-read-tools.js";
import type { ControlledGitRunner } from "./git-runner.js";
import {
  discoverGitRepository,
  revalidateGitRepository,
} from "./repository-discovery.js";
import type { GitRepositoryIdentity, GitStatusSnapshot } from "./git-types.js";

export interface GitReadServiceSnapshot {
  readonly identity: GitRepositoryIdentity;
  readonly initialStatus: GitStatusSnapshot;
}

export interface GitAttributedStatus {
  readonly snapshot: GitStatusSnapshot;
  readonly attribution: readonly GitPathAttribution[];
}

export class GitReadService {
  public readonly runner: ControlledGitRunner;
  public readonly identity: GitRepositoryIdentity;
  public readonly initialStatus: GitStatusSnapshot;

  private constructor(
    runner: ControlledGitRunner,
    identity: GitRepositoryIdentity,
    initialStatus: GitStatusSnapshot,
  ) {
    this.runner = runner;
    this.identity = identity;
    this.initialStatus = initialStatus;
    Object.freeze(this);
  }

  public static async open(
    runner: ControlledGitRunner,
    signal?: AbortSignal,
  ): Promise<GitReadService> {
    const identity = await discoverGitRepository(runner, signal);
    const initialStatus = await captureGitStatusSnapshot(runner, { signal });
    return new GitReadService(runner, identity, initialStatus);
  }

  public snapshot(): GitReadServiceSnapshot {
    return Object.freeze({ identity: this.identity, initialStatus: this.initialStatus });
  }

  public revalidate(signal?: AbortSignal): Promise<boolean> {
    return revalidateGitRepository(this.runner, this.identity, signal);
  }

  public async status(input: {
    readonly currentFileHashes: Readonly<Record<string, string>>;
    readonly editLedger: readonly GitEditLedgerEntry[];
    readonly includeIgnored?: boolean | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<GitAttributedStatus> {
    const snapshot = await captureGitStatusSnapshot(this.runner, {
      includeIgnored: input.includeIgnored,
      signal: input.signal,
    });
    return Object.freeze({
      snapshot,
      attribution: attributeGitStatus({
        initial: this.initialStatus,
        current: snapshot,
        currentFileHashes: input.currentFileHashes,
        editLedger: input.editLedger,
      }),
    });
  }

  public diff(request: GitDiffRequest): Promise<GitDiffResult> {
    return readGitDiff(this.runner, request);
  }

  public log(options: GitLogOptions): Promise<readonly GitLogEntry[]> {
    return readGitLog(this.runner, options);
  }

  public branch(signal?: AbortSignal): Promise<GitCurrentBranch> {
    return readCurrentBranch(this.runner, signal);
  }
}
