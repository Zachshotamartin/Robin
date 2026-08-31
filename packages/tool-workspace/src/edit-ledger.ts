import { canonicalSha256Hex, createDomainError } from "@guard/contracts";

import type { WorkspaceRelativePath } from "./physical-path.js";
import type { FileBinding } from "./workspace-identity.js";

export type InitialGitPathState =
  | "clean_tracked"
  | "staged"
  | "unstaged"
  | "staged_and_unstaged"
  | "untracked"
  | "ignored"
  | "absent"
  | "unknown";

export type EditAttribution =
  | "pre_existing"
  | "robin_owned"
  | "mixed_or_external"
  | "unknown";

export interface InitialFileFact {
  readonly path: WorkspaceRelativePath;
  readonly existed: boolean;
  readonly sha256: string | null;
  readonly binding: FileBinding | null;
  readonly gitState: InitialGitPathState;
}

export interface EditLedgerEntry {
  readonly sequence: number;
  readonly path: WorkspaceRelativePath;
  readonly operation: "apply_patch" | "create_file";
  readonly actionId: string;
  readonly approvalId: string;
  readonly approvedActionHash: string;
  readonly occurredAt: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly beforeBinding: FileBinding | null;
  readonly afterBinding: FileBinding;
  readonly diffSha256: string;
}

export interface EditLedgerSnapshot {
  readonly schemaVersion: 1;
  readonly initialFacts: readonly InitialFileFact[];
  readonly entries: readonly EditLedgerEntry[];
  readonly snapshotHash: string;
}

export class EditLedger {
  readonly #initial = new Map<WorkspaceRelativePath, InitialFileFact>();
  readonly #entries: EditLedgerEntry[] = [];

  public observeInitial(fact: InitialFileFact): void {
    const existing = this.#initial.get(fact.path);
    if (existing !== undefined) {
      if (canonicalSha256Hex(existing) !== canonicalSha256Hex(fact)) {
        throw createDomainError({
          code: "conflict",
          message: "A workspace path cannot acquire two different initial edit facts.",
        });
      }
      return;
    }
    this.#initial.set(fact.path, freezeInitialFact(fact));
  }

  public append(
    entry: Omit<EditLedgerEntry, "sequence">,
  ): EditLedgerEntry {
    const initial = this.#initial.get(entry.path);
    if (initial === undefined) {
      throw createDomainError({
        code: "invariant_violated",
        message: "An edit ledger entry requires a captured initial file fact.",
      });
    }
    const prior = [...this.#entries].reverse().find((item) => item.path === entry.path);
    const expectedBefore = prior?.afterSha256 ?? initial.sha256;
    if (entry.beforeSha256 !== expectedBefore) {
      throw createDomainError({
        code: "conflict",
        message: "An edit ledger entry does not continue the observed path chain.",
      });
    }
    const captured = Object.freeze({
      ...entry,
      sequence: this.#entries.length + 1,
    });
    this.#entries.push(captured);
    return captured;
  }

  public attribution(
    path: WorkspaceRelativePath,
    currentSha256: string | null,
  ): EditAttribution {
    const initial = this.#initial.get(path);
    if (initial === undefined) return "unknown";
    const entries = this.#entries.filter((entry) => entry.path === path);
    if (entries.length === 0) {
      return initial.gitState === "clean_tracked" || initial.gitState === "absent"
        ? "unknown"
        : "pre_existing";
    }
    const latest = entries.at(-1)!;
    if (currentSha256 !== latest.afterSha256) return "mixed_or_external";
    return initial.gitState === "clean_tracked" || initial.gitState === "absent"
      ? "robin_owned"
      : "mixed_or_external";
  }

  public get snapshot(): EditLedgerSnapshot {
    const initialFacts = Object.freeze(
      [...this.#initial.values()].sort(comparePath),
    );
    const entries = Object.freeze([...this.#entries]);
    return Object.freeze({
      schemaVersion: 1,
      initialFacts,
      entries,
      snapshotHash: canonicalSha256Hex({
        schemaVersion: 1,
        initialFacts,
        entries,
      }),
    });
  }
}

function freezeInitialFact(fact: InitialFileFact): InitialFileFact {
  return Object.freeze({ ...fact });
}

function comparePath(left: InitialFileFact, right: InitialFileFact): number {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}
