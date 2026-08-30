import type {
  ActionId,
  ActionPrecondition,
  JsonObject,
  NormalizedAction,
  SideEffectClass,
  VersionedSchema,
} from "@guard/contracts";

export interface CapabilityOperationReference {
  readonly packId: string;
  readonly packVersion: number;
  readonly operationId: string;
  readonly operationVersion: number;
}

export interface CapabilityOperationDefinition {
  readonly operationId: string;
  readonly operationVersion: number;
  readonly description: string;
  readonly inputSchema: VersionedSchema;
  readonly outputSchema: VersionedSchema;
  readonly sideEffectClass: SideEffectClass;
}

export interface CapabilityNormalizationContext {
  readonly actionId: ActionId;
  readonly subject: JsonObject;
  readonly environment: JsonObject;
}

export interface CapabilitySemanticNormalization {
  readonly normalizedInput: JsonObject;
  readonly resource: JsonObject;
  readonly request: JsonObject;
  readonly preconditions: readonly ActionPrecondition[];
}

export interface CapabilityExecutionContext {
  readonly signal: AbortSignal;
}

export interface CapabilityGatewayOptions {
  /** Bound checked before the trusted validator evaluates an operation input. */
  readonly maximumInputBytes?: number;
  /** Bound checked before the trusted validator evaluates a handler result. */
  readonly maximumRawOutputBytes?: number;
  /** Independent bound applied to each audit, human, and agent view. */
  readonly maximumReleasedViewBytes?: number;
  /** Aggregate bound applied to the three released views together. */
  readonly maximumCombinedReleasedViewBytes?: number;
}

export interface CapabilityReleasedViews {
  readonly audit: JsonObject;
  readonly human: JsonObject;
  readonly agent: JsonObject;
}

export interface CapabilityOperation {
  readonly definition: CapabilityOperationDefinition;
  normalize(
    input: JsonObject,
    context: CapabilityNormalizationContext,
  ): CapabilitySemanticNormalization | Promise<CapabilitySemanticNormalization>;
  execute(
    action: NormalizedAction,
    context: CapabilityExecutionContext,
  ): unknown | Promise<unknown>;
  release(
    raw: JsonObject,
    action: NormalizedAction,
  ): CapabilityReleasedViews | Promise<CapabilityReleasedViews>;
}

export interface CapabilityPack {
  readonly packId: string;
  readonly packVersion: number;
  readonly operations: readonly CapabilityOperation[];
}

export interface AdvertisedCapabilityOperation
  extends CapabilityOperationReference {
  readonly description: string;
  readonly inputSchema: VersionedSchema;
  readonly sideEffectClass: SideEffectClass;
}

export interface CapabilityAdvertisement {
  readonly operations: readonly AdvertisedCapabilityOperation[];
}

export interface CapabilityActionProposal extends CapabilityOperationReference {
  readonly schemaVersion: 1;
  readonly input: unknown;
}

export interface PreparedCapabilityAction {
  readonly action: NormalizedAction;
  readonly actionHash: string;
}

export interface CapabilityExecutionResult {
  readonly raw: JsonObject;
  readonly audit: JsonObject;
  readonly human: JsonObject;
  readonly agent: JsonObject;
}

export interface RegisteredOperationDescriptor
  extends CapabilityOperationReference {
  readonly description: string;
  readonly inputSchema: VersionedSchema;
  readonly sideEffectClass: SideEffectClass;
}

export interface RegisteredPackDescriptor {
  readonly packId: string;
  readonly packVersion: number;
  readonly operations: readonly RegisteredOperationDescriptor[];
}
