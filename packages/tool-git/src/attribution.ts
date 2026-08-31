import { GitToolError } from "./git-error.js";
import type { GitStatusSnapshot } from "./git-types.js";

export type GitEditOutcome = "confirmed" | "uncertain";

export interface GitEditLedgerEntry {
  readonly actionId: string;
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
  readonly outcome?: GitEditOutcome | undefined;
}

export interface GitAttributionInput {
  readonly initial: GitStatusSnapshot;
  readonly current: GitStatusSnapshot;
  readonly currentFileHashes: Readonly<Record<string, string>>;
  readonly editLedger: readonly GitEditLedgerEntry[];
}

export type GitChangeAttribution =
  | "pre_existing"
  | "robin_owned"
  | "mixed_or_external"
  | "unknown";

export interface GitPathAttribution {
  readonly path: string;
  readonly xy: string;
  readonly attribution: GitChangeAttribution;
  readonly initialState: "pre_existing" | "clean";
  readonly currentSha256: string | null;
  readonly lastRobinPostimageSha256: string | null;
  readonly editActionIds: readonly string[];
}

export function attributeGitStatus(
  input: GitAttributionInput,
): readonly GitPathAttribution[] {
  const initialPaths = new Set(
    input.initial.entries
      .map((entry) => entry.path.utf8)
      .filter((value): value is string => value !== null),
  );
  const ledgerByPath = new Map<string, GitEditLedgerEntry[]>();
  for (const entry of input.editLedger) {
    validateLedgerEntry(entry);
    const entries = ledgerByPath.get(entry.path) ?? [];
    entries.push(entry);
    ledgerByPath.set(entry.path, entries);
  }
  const result = input.current.entries.map((entry): GitPathAttribution => {
    const path = entry.path.utf8;
    if (path === null || !entry.path.safeForWorkspaceTools) {
      return Object.freeze({
        path: entry.path.display,
        xy: entry.xy,
        attribution: "unknown",
        initialState: "clean",
        currentSha256: null,
        lastRobinPostimageSha256: null,
        editActionIds: Object.freeze([]),
      });
    }
    const initialState = initialPaths.has(path) ? "pre_existing" : "clean";
    const ledger = ledgerByPath.get(path) ?? [];
    const currentSha256 = input.currentFileHashes[path] ?? null;
    if (currentSha256 !== null) validateHash(currentSha256, "current file hash");
    const actionIds = Object.freeze(ledger.map((item) => item.actionId));
    const lastPostimage = ledger.at(-1)?.afterSha256 ?? null;
    let attribution: GitChangeAttribution;
    if (ledger.length === 0) {
      attribution = initialState === "pre_existing" ? "pre_existing" : "mixed_or_external";
    } else if (
      currentSha256 === null ||
      ledger.some((item) => item.outcome === "uncertain") ||
      !hasContinuousHashChain(ledger)
    ) {
      attribution = "unknown";
    } else {
      attribution = currentSha256 === lastPostimage ? "robin_owned" : "mixed_or_external";
    }
    return Object.freeze({
      path,
      xy: entry.xy,
      attribution,
      initialState,
      currentSha256,
      lastRobinPostimageSha256: lastPostimage,
      editActionIds: actionIds,
    });
  });
  result.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return Object.freeze(result);
}

function hasContinuousHashChain(entries: readonly GitEditLedgerEntry[]): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index]?.beforeSha256 !== entries[index - 1]?.afterSha256) return false;
  }
  return true;
}

function validateLedgerEntry(entry: GitEditLedgerEntry): void {
  if (
    entry.actionId.length === 0 ||
    entry.actionId.length > 256 ||
    entry.path.length === 0 ||
    entry.path.length > 16_384 ||
    entry.path.includes("\0") ||
    (entry.outcome !== undefined &&
      entry.outcome !== "confirmed" &&
      entry.outcome !== "uncertain")
  ) {
    throw new GitToolError("invalid_request", "A Git edit-ledger entry is invalid.");
  }
  if (entry.beforeSha256 !== null) validateHash(entry.beforeSha256, "edit preimage");
  validateHash(entry.afterSha256, "edit postimage");
}

function validateHash(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new GitToolError("invalid_request", `The ${label} is not a SHA-256 digest.`);
  }
}
