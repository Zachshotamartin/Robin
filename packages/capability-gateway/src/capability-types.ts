import type {
  ActionId,
  ActionPrecondition,
  JsonObject,
  NormalizedAction,
  ResourceRef,
  SideEffectClass,
  VersionedSchema,
} from "@guard/contracts";
import type { PolicyDecision } from "@guard/policy-engine";

declare const evaluatedCapabilityActionBrand: unique symbol;

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
  /** Independent bound applied to each view and the context-release descriptor. */
  readonly maximumReleasedViewBytes?: number;
  /** Aggregate bound applied to all three views plus the release descriptor. */
  readonly maximumCombinedReleasedViewBytes?: number;
}

/**
 * Immutable installation-time policy identity for one operation's agent view.
 * The gateway captures this separately from the dynamic release callback so a
 * callback cannot redirect an output to another catalog or classification.
 */
export interface CapabilityAgentContextReleaseDefinition {
  readonly schemaVersion: 1;
  readonly sourceVersion: number;
  readonly catalogId: string;
  readonly catalogVersion: number;
  readonly catalogContentHash: string;
  readonly classification: string;
  readonly reason: string;
}

/** Structural twin of the broker's source-owned context policy projection. */
export interface CapabilityContextPolicyProjection {
  readonly schemaVersion: 1;
  readonly catalogId: string;
  readonly catalogVersion: number;
  readonly catalogContentHash: string;
  readonly resourceAttributes: JsonObject;
  readonly requestAttributes: JsonObject;
}

/**
 * Everything needed to release `CapabilityExecutionResult.agent` through the
 * context broker except the runtime-owned turn ID and the agent value itself.
 */
export interface CapabilityAgentContextReleaseDescriptor {
  readonly schemaVersion: 1;
  readonly sourceVersion: number;
  readonly resource: ResourceRef;
  readonly policyProjection: CapabilityContextPolicyProjection;
  readonly classification: string;
  readonly reason: string;
}

/** Operation claim tying a descriptor to the exact action, raw result, and view. */
export interface CapabilityAgentContextReleaseClaim {
  readonly descriptor: CapabilityAgentContextReleaseDescriptor;
  readonly binding: {
    readonly schemaVersion: 1;
    readonly normalizedActionHash: string;
    readonly rawResultHash: string;
    readonly agentViewHash: string;
    readonly descriptorHash: string;
  };
}

export interface CapabilityReleasedViews {
  readonly audit: JsonObject;
  readonly human: JsonObject;
  readonly agent: JsonObject;
  readonly agentContextRelease: CapabilityAgentContextReleaseClaim;
}

export interface CapabilityOperation {
  readonly definition: CapabilityOperationDefinition;
  readonly agentContextRelease: CapabilityAgentContextReleaseDefinition;
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

/**
 * Gateway-owned receipt for one completed evaluation. The private type brand
 * prevents structural construction in TypeScript; runtime ownership is
 * enforced independently by the issuing gateway's WeakMap.
 */
export interface EvaluatedCapabilityAction {
  readonly prepared: PreparedCapabilityAction;
  readonly decision: PolicyDecision;
  readonly [evaluatedCapabilityActionBrand]: true;
}

export interface CapabilityExecutionResult {
  readonly raw: JsonObject;
  readonly audit: JsonObject;
  readonly human: JsonObject;
  readonly agent: JsonObject;
  readonly agentContextRelease: CapabilityAgentContextReleaseDescriptor;
}

export interface RegisteredOperationDescriptor
  extends CapabilityOperationReference {
  readonly description: string;
  readonly inputSchema: VersionedSchema;
  readonly sideEffectClass: SideEffectClass;
  readonly agentContextRelease: CapabilityAgentContextReleaseDefinition;
}

export interface RegisteredPackDescriptor {
  readonly packId: string;
  readonly packVersion: number;
  readonly operations: readonly RegisteredOperationDescriptor[];
}
