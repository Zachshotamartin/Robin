import type { ContentBlock } from "./content.js";
import type { DomainError } from "./errors.js";
import type { ActionId, RunId } from "./ids.js";
import type { JsonObject } from "./json-value.js";
import type { VersionedContract } from "./schema-version.js";

export type ObservationStatus = "succeeded" | "failed" | "uncertain" | "denied";

/** Policy-released views; raw adapter output is intentionally absent. */
export interface Observation extends VersionedContract {
  readonly observationId: string;
  readonly actionId: ActionId;
  readonly status: ObservationStatus;
  readonly audit: JsonObject;
  readonly human: readonly ContentBlock[];
  readonly agent: readonly ContentBlock[];
  readonly error: DomainError | null;
  readonly occurredAt: string;
}

export type EvidenceKind =
  | "event"
  | "artifact"
  | "resource"
  | "action"
  | "observation";

export interface OutcomeEvidenceRef {
  readonly kind: EvidenceKind;
  readonly referenceId: string;
  readonly contentHash: string | null;
}

export interface OutcomeEnvelope extends VersionedContract {
  readonly outcomeId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly outcomeType: string;
  readonly outcomeTypeVersion: number;
  readonly payload: JsonObject;
  readonly evidence: readonly OutcomeEvidenceRef[];
  readonly proposedAt: string;
}

interface RunResultBase extends VersionedContract {
  readonly runId: RunId;
  readonly finishedAt: string;
}

export interface CompletedRunResult extends RunResultBase {
  readonly status: "completed";
  readonly outcome: OutcomeEnvelope;
}

export interface FailedRunResult extends RunResultBase {
  readonly status: "failed";
  readonly error: DomainError;
}

export interface OrphanedRunResult extends RunResultBase {
  readonly status: "orphaned";
  readonly error: DomainError;
}

export interface CancelledRunResult extends RunResultBase {
  readonly status: "cancelled";
  readonly reason: string | null;
}

export type RunResult =
  | CompletedRunResult
  | FailedRunResult
  | OrphanedRunResult
  | CancelledRunResult;
