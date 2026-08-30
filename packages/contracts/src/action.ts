import type { ActionId } from "./ids.js";
import type { JsonObject } from "./json-value.js";
import type { VersionedContract } from "./schema-version.js";

export type SideEffectClass =
  | "none"
  | "local_reversible"
  | "local_irreversible"
  | "external";

export interface ActionPrecondition {
  readonly preconditionType: string;
  readonly preconditionVersion: number;
  readonly attributes: JsonObject;
}

/** The one canonical value evaluated, approved, and passed to execution. */
export interface NormalizedAction extends VersionedContract {
  readonly actionId: ActionId;
  readonly capabilityPackId: string;
  /** Exact installed pack version bound into policy, approval, and action hashes. */
  readonly capabilityPackVersion: number;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly subject: JsonObject;
  readonly resource: JsonObject;
  readonly environment: JsonObject;
  readonly request: JsonObject;
  readonly normalizedInput: JsonObject;
  readonly sideEffectClass: SideEffectClass;
  readonly preconditions: readonly ActionPrecondition[];
}
