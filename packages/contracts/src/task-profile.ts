import type { ActorIdentity } from "./actor.js";
import type { JsonObject } from "./json-value.js";
import type { VersionedContract } from "./schema-version.js";

export interface VersionedSchema {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly document: JsonObject;
}

export interface ComponentBinding {
  readonly componentId: string;
  readonly componentVersion: number;
  readonly configuration: JsonObject;
}

export interface NamedComponentBinding extends ComponentBinding {
  readonly bindingId: string;
}

export type ModelAuthority = "planner" | "auxiliary";

export interface ModelProfileBinding {
  readonly bindingId: string;
  readonly roleId: string;
  readonly authority: ModelAuthority;
  readonly modelProfileId: string;
  readonly modelProfileVersion: number;
  readonly mayProposeActions: boolean;
  readonly configuration: JsonObject;
}

export interface BudgetPolicy {
  readonly maxTurns: number;
  readonly maxActions: number;
  readonly maxElapsedMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly extensions: JsonObject;
}

export type EvidenceMode = "durable_encrypted" | "ephemeral_metadata";

/** Immutable composition root pinned to a run. */
export interface TaskProfile extends VersionedContract {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly objectiveSchema: VersionedSchema;
  readonly driverProfile: ComponentBinding;
  readonly modelBindings: readonly ModelProfileBinding[];
  readonly contextSources: readonly NamedComponentBinding[];
  readonly capabilityPacks: readonly NamedComponentBinding[];
  readonly policyProfile: ComponentBinding;
  readonly outcomeSchema: VersionedSchema;
  readonly budgetPolicy: BudgetPolicy;
  readonly evidenceMode: EvidenceMode;
  readonly evaluationProfile: ComponentBinding | null;
}

/** Original structured run intent; follow-up intent is represented by events. */
export interface ObjectiveEnvelope extends VersionedContract {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly objectiveType: string;
  readonly objectiveTypeVersion: number;
  readonly payload: JsonObject;
  readonly submittedBy: ActorIdentity;
  readonly submittedAt: string;
}
