import type {
  ActionId,
  ActionPrecondition,
  ArtifactId,
  JsonObject,
  NormalizedAction,
  ResourceRef,
  SideEffectClass,
  VersionedSchema,
} from "@guard/contracts";
import type { PolicyDecision } from "@guard/policy-engine";

declare const evaluatedCapabilityActionBrand: unique symbol;
declare const capabilityPreparationReceiptBrand: unique symbol;
declare const capabilityReconciliationReceiptBrand: unique symbol;
declare const pendingCapabilityExecutionBrand: unique symbol;

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
  /** Bound applied independently to every lifecycle descriptor or fact envelope. */
  readonly maximumLifecycleEvidenceBytes?: number;
  /** Maximum artifact references allowed in one lifecycle envelope. */
  readonly maximumLifecycleArtifactReferences?: number;
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
  /**
   * Optional crash-aware effect lifecycle. Operations installed before the
   * lifecycle contract remain valid and receive a gateway-owned inert
   * lifecycle when callers opt into the new API.
   */
  readonly lifecycle?: CapabilityOperationLifecycle;
}

/** A bounded durable-artifact fact safe to publish with a lifecycle event. */
export interface CapabilityLifecycleArtifactReference {
  readonly schemaVersion: 1;
  readonly artifactId: ArtifactId;
  readonly contentHash: string;
  readonly mediaType: string;
}

/**
 * Safe event material returned by trusted lifecycle handlers. The gateway
 * detaches, freezes, counts, and byte-bounds this envelope before exposing it.
 */
export interface CapabilityLifecycleEvidence {
  readonly schemaVersion: 1;
  readonly eventFacts: JsonObject;
  readonly artifactReferences: readonly CapabilityLifecycleArtifactReference[];
}

export interface CapabilityPreparationDescriptor
  extends CapabilityLifecycleEvidence {
  readonly preparationKind: string;
  readonly operationVersion: number;
}

export interface CapabilityLifecyclePolicyContext {
  readonly signal: AbortSignal;
  readonly decision: PolicyDecision;
  readonly actionHash: string;
  readonly decisionHash: string;
}

export interface CapabilityPreparedLifecycleContext
  extends CapabilityLifecyclePolicyContext {
  readonly preparationDescriptorHash: string;
}

export interface CapabilityOperationPreparation {
  readonly descriptor: CapabilityPreparationDescriptor;
  /**
   * Trusted operation-private state. It never leaves the gateway and the same
   * object identity is supplied to each later lifecycle method.
   */
  readonly privateReceipt: object;
}

export type CapabilityReconciliationStatus =
  | "absent"
  | "succeeded"
  | "failed"
  | "uncertain";

export interface CapabilityOperationReconciliation
  extends CapabilityLifecycleEvidence {
  readonly status: CapabilityReconciliationStatus;
  /** Present only for `succeeded`; all other dispositions use null. */
  readonly raw: JsonObject | null;
}

export type CapabilityCompensationDisposition =
  | "restored"
  | "not_required"
  | "uncertain";

/**
 * A compensation callback must say whether it proved restoration, proved that
 * restoration was unnecessary, or could not prove either. Unknown restoration
 * is a host-visible orphan condition, never an ordinary action failure.
 */
export interface CapabilityCompensationResult
  extends CapabilityLifecycleEvidence {
  readonly disposition: CapabilityCompensationDisposition;
}

export interface CapabilityPreparedExecutionOutput
  extends CapabilityLifecycleEvidence {
  readonly raw: JsonObject;
}

/**
 * Optional installed-operation lifecycle. All callbacks are captured as
 * descriptor-safe trusted functions at registry construction. The gateway
 * supplies the same immutable action, detached decision, private receipt, and
 * AbortSignal to every phase.
 */
export interface CapabilityOperationLifecycle {
  prepare(
    action: NormalizedAction,
    context: CapabilityLifecyclePolicyContext,
  ): CapabilityOperationPreparation | Promise<CapabilityOperationPreparation>;
  reconcile(
    action: NormalizedAction,
    privateReceipt: object,
    context: CapabilityPreparedLifecycleContext,
  ): CapabilityOperationReconciliation | Promise<CapabilityOperationReconciliation>;
  executePrepared(
    action: NormalizedAction,
    privateReceipt: object,
    context: CapabilityPreparedLifecycleContext,
  ): CapabilityPreparedExecutionOutput | Promise<CapabilityPreparedExecutionOutput>;
  acknowledge(
    action: NormalizedAction,
    privateReceipt: object,
    raw: JsonObject,
    context: CapabilityPreparedLifecycleContext,
  ): CapabilityLifecycleEvidence | Promise<CapabilityLifecycleEvidence>;
  compensate(
    action: NormalizedAction,
    privateReceipt: object,
    raw: JsonObject | null,
    context: CapabilityPreparedLifecycleContext,
  ): CapabilityCompensationResult | Promise<CapabilityCompensationResult>;
  discardPreparation(
    action: NormalizedAction,
    privateReceipt: object,
    context: CapabilityPreparedLifecycleContext,
  ): CapabilityLifecycleEvidence | Promise<CapabilityLifecycleEvidence>;
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

/**
 * Public, immutable half of a one-use post-policy preparation. Runtime
 * ownership is enforced by the issuing gateway; the operation-private receipt
 * is deliberately absent.
 */
export interface CapabilityPreparationReceipt {
  readonly action: NormalizedAction;
  readonly actionHash: string;
  readonly decision: PolicyDecision;
  readonly decisionHash: string;
  readonly operation: CapabilityOperationReference;
  readonly descriptor: CapabilityPreparationDescriptor;
  readonly descriptorHash: string;
  readonly [capabilityPreparationReceiptBrand]: true;
}

export interface CapabilityReconciliationReceipt
  extends CapabilityLifecycleEvidence {
  readonly preparation: CapabilityPreparationReceipt;
  readonly status: CapabilityReconciliationStatus;
  readonly reconciliationHash: string;
  readonly [capabilityReconciliationReceiptBrand]: true;
}

/**
 * Safe host-publication seam. The trusted raw result remains gateway-private
 * until acknowledgement; a caller may instead compensate this exact pending
 * effect once.
 */
export interface PendingCapabilityExecution
  extends CapabilityLifecycleEvidence {
  readonly preparation: CapabilityPreparationReceipt;
  readonly reconciliation: CapabilityReconciliationReceipt;
  readonly rawResultHash: string;
  readonly resultHash: string;
  readonly [pendingCapabilityExecutionBrand]: true;
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
