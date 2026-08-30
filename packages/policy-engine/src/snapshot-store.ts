import {
  PolicyVersionIdKind,
  RunIdKind,
  createDomainError,
} from "@guard/contracts";

import type { PolicySnapshot, PolicySnapshotStore } from "./types.js";
import { assertCompiledPolicySnapshot } from "./compiler.js";

/** In-memory Milestone-B store with explicit immutable run pinning. */
export class InMemoryPolicySnapshotStore implements PolicySnapshotStore {
  readonly #snapshots = new Map<string, PolicySnapshot>();
  readonly #pins = new Map<string, string>();

  install(snapshot: PolicySnapshot): void {
    assertSnapshot(snapshot);
    const existing = this.#snapshots.get(snapshot.policyVersionId);
    if (existing !== undefined && existing.contentHash !== snapshot.contentHash) {
      throw conflict("A policy version ID cannot be rebound to different content.");
    }
    if (existing === undefined) this.#snapshots.set(snapshot.policyVersionId, snapshot);
  }

  get(policyVersionId: string): PolicySnapshot {
    const parsed = PolicyVersionIdKind.parse(policyVersionId);
    const snapshot = this.#snapshots.get(parsed);
    if (snapshot === undefined) throw missing("The policy snapshot is not installed.");
    return snapshot;
  }

  pinRun(runId: string, policyVersionId: string): PolicySnapshot {
    const parsedRunId = RunIdKind.parse(runId);
    const snapshot = this.get(policyVersionId);
    const existing = this.#pins.get(parsedRunId);
    if (existing !== undefined && existing !== snapshot.policyVersionId) {
      throw conflict("An active run policy pin cannot change implicitly.");
    }
    this.#pins.set(parsedRunId, snapshot.policyVersionId);
    return snapshot;
  }

  resolveRun(runId: string): PolicySnapshot {
    const parsedRunId = RunIdKind.parse(runId);
    const policyVersionId = this.#pins.get(parsedRunId);
    if (policyVersionId === undefined) throw missing("The run has no policy snapshot pin.");
    return this.get(policyVersionId);
  }

  /** Explicit migration is separate from install/edit and is never implicit. */
  migrateRun(runId: string, policyVersionId: string): PolicySnapshot {
    const parsedRunId = RunIdKind.parse(runId);
    if (!this.#pins.has(parsedRunId)) {
      throw missing("Only an already pinned run can be explicitly migrated.");
    }
    const snapshot = this.get(policyVersionId);
    this.#pins.set(parsedRunId, snapshot.policyVersionId);
    return snapshot;
  }
}

function assertSnapshot(value: PolicySnapshot): void {
  assertCompiledPolicySnapshot(value);
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.isFrozen(value) ||
    !PolicyVersionIdKind.is(value.policyVersionId) ||
    typeof value.contentHash !== "string" ||
    value.contentHash.length !== 64
  ) {
    throw new TypeError("The snapshot store accepts immutable compiled snapshots only.");
  }
}

function conflict(message: string) {
  return createDomainError({ code: "conflict", message });
}

function missing(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
