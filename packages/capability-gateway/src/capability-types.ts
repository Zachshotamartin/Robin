import type {
  ActionId,
  ActionPrecondition,
  ApprovalId,
  JsonObject,
  NormalizedAction,
  ResourceRef,
  SideEffectClass,
  VersionedSchema,
} from "@guard/contracts";
import type { PolicyDecision } from "@guard/policy-engine";

declare const evaluatedCapabilityActionBrand: unique symbol;
declare const capabilityApprovalChallengeBrand: unique symbol;
declare const capabilityApprovalGrantBrand: unique symbol;
declare const capabilityAuthorizationBrand: unique symbol;

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
  /** Trusted wall-clock port used only for approval request/expiry decisions. */
  readonly approvalClock?: CapabilityApprovalClock;
  /** Trusted identifier port used to create non-rebindable approval requests. */
  readonly approvalIdSource?: CapabilityApprovalIdSource;
  /** Default interactive approval lifetime; bounded by the configured maximum. */
  readonly defaultApprovalLifetimeMs?: number;
  /** Hard upper bound for a caller-selected approval lifetime. */
  readonly maximumApprovalLifetimeMs?: number;
}

export interface CapabilityApprovalClock {
  now(): string;
}

export interface CapabilityApprovalIdSource {
  nextApprovalId(): ApprovalId;
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

export interface CapabilityApprovalChallengeInput {
  readonly displayedSummary: JsonObject;
  readonly lifetimeMs?: number;
}

/**
 * Serializable approval record plus an in-memory ownership brand. The public
 * hashes are echoed by the UI response; the issuing gateway independently
 * checks the exact object and its private provenance before accepting it.
 */
export interface CapabilityApprovalChallenge {
  readonly schemaVersion: 1;
  readonly approvalId: ApprovalId;
  readonly actionId: ActionId;
  readonly actionHash: string;
  readonly normalizedRequestHash: string;
  readonly preconditionHash: string;
  readonly policySnapshotHash: string;
  readonly displayedSummary: JsonObject;
  readonly displayedSummaryHash: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly [capabilityApprovalChallengeBrand]: true;
}

export type CapabilityApprovalResponseDecision = "allow_once" | "deny";

export interface CapabilityApprovalResponse {
  readonly schemaVersion: 1;
  readonly approvalId: ApprovalId;
  readonly decision: CapabilityApprovalResponseDecision;
  readonly normalizedRequestHash: string;
  readonly preconditionHash: string;
  readonly policySnapshotHash: string;
  readonly displayedSummaryHash: string;
}

/** Opaque, gateway-owned result of one valid allow-once response. */
export interface CapabilityApprovalGrant {
  readonly schemaVersion: 1;
  readonly approvalId: ApprovalId;
  readonly actionId: ActionId;
  readonly actionHash: string;
  readonly normalizedRequestHash: string;
  readonly preconditionHash: string;
  readonly policySnapshotHash: string;
  readonly displayedSummaryHash: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly [capabilityApprovalGrantBrand]: true;
}

/** Opaque, one-use authority for the gateway's exact evaluated action. */
export interface AuthorizedCapabilityAction {
  readonly schemaVersion: 1;
  readonly actionId: ActionId;
  readonly actionHash: string;
  readonly source: "policy" | "approval";
  readonly approvalId: ApprovalId | null;
  readonly [capabilityAuthorizationBrand]: true;
}

export type CapabilityAuthorizationResult =
  | {
      readonly status: "authorized";
      readonly authorization: AuthorizedCapabilityAction;
    }
  | {
      readonly status: "approval_required";
    }
  | {
      readonly status: "denied";
      readonly observation: JsonObject;
    }
  | {
      readonly status: "stale";
      readonly observation: JsonObject;
    };

export type CapabilityApprovalResolution =
  | {
      readonly status: "granted";
      readonly grant: CapabilityApprovalGrant;
    }
  | {
      readonly status: "denied" | "stale";
      readonly observation: JsonObject;
    };

export interface CapabilityAuthorizedExecutionContext {
  readonly signal: AbortSignal;
  /**
   * Trusted live observer called by the gateway immediately before handler
   * dispatch. It must return the current operation-specific preconditions.
   */
  revalidate(
    action: NormalizedAction,
    context: CapabilityExecutionContext,
  ): readonly ActionPrecondition[] | Promise<readonly ActionPrecondition[]>;
}

export type CapabilityAuthorizedExecutionResult =
  | {
      readonly status: "executed";
      readonly result: CapabilityExecutionResult;
    }
  | {
      readonly status: "stale";
      readonly observation: JsonObject;
    };

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
