import type {
  DomainError,
  JsonObject,
  JsonValue,
  PolicyVersionId,
  ResourceRef,
} from "@guard/contracts";

import type { ContextSourceDescriptor } from "./context-source.js";

export interface NormalizedResourceRequest {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly resource: ResourceRef;
  readonly selector: JsonObject | null;
}

export type ContextResourceKind =
  | "regular_file"
  | "record"
  | "capability_output";

/** Source-owned, versioned policy projection; the broker never interprets keys. */
export interface ContextPolicyProjection {
  readonly schemaVersion: 1;
  readonly catalogId: string;
  readonly catalogVersion: number;
  readonly catalogContentHash: string;
  readonly resourceAttributes: JsonObject;
  readonly requestAttributes: JsonObject;
}

/** Safe pre-open facts. The binding is source-owned and compared after open. */
export interface ContextResourceMetadata {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly resource: ResourceRef;
  readonly selector: JsonObject | null;
  readonly byteLength: number;
  /** Exact selected bytes when knowable without opening content; otherwise null. */
  readonly selectedByteLength: number | null;
  readonly mediaType: string;
  readonly classification: string;
  readonly kind: ContextResourceKind;
  readonly policyProjection: ContextPolicyProjection;
  readonly binding: JsonObject;
}

/** The only read budget visible to a source adapter. */
export interface SourceReadBudget {
  readonly maximumBytes: number;
}

/**
 * A source returns bytes copied from the object it opened, plus the binding
 * observed from that open handle. The broker revalidates every field.
 */
export interface OpenedContextResource {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly resource: ResourceRef;
  readonly policyProjection: ContextPolicyProjection;
  readonly selector: JsonObject | null;
  readonly mediaType: string;
  readonly classification: string;
  readonly binding: JsonObject;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly selectionComplete: boolean;
  readonly truncated: boolean;
}

/** Strict two-stage source port: normalization/metadata never opens content. */
export interface BrokerContextSource {
  readonly descriptor: ContextSourceDescriptor;
  normalizeResourceRequest(input: unknown): NormalizedResourceRequest;
  inspectMetadata(
    request: NormalizedResourceRequest,
    signal: AbortSignal,
  ): Promise<ContextResourceMetadata>;
  openBounded(
    request: NormalizedResourceRequest,
    expected: ContextResourceMetadata,
    budget: SourceReadBudget,
    signal: AbortSignal,
  ): Promise<OpenedContextResource>;
}

export interface ContextBudgetLimits {
  readonly maximumResourceBytes: number;
  readonly maximumRequestBytes: number;
  /** Total release attempts, including denied attempts, allowed in one turn. */
  readonly maximumItemsPerTurn: number;
  readonly maximumBytesPerTurn: number;
  /** Total release attempts, including denied attempts, allowed in one run. */
  readonly maximumItemsPerRun: number;
  readonly maximumBytesPerRun: number;
  readonly maximumControlCharacterRatio: number;
}

export type SecretCategory =
  | "api_token"
  | "private_key"
  | "high_entropy_token"
  | "assigned_secret"
  | "custom";

export interface SecretRange {
  readonly category: SecretCategory;
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export interface SecretCategoryCount {
  readonly category: SecretCategory;
  readonly count: number;
}

export type PromptInjectionTag =
  | "authority_impersonation"
  | "instruction_override"
  | "secret_exfiltration"
  | "tool_coercion";

export interface ContextMetadataPolicyInput {
  readonly policySnapshotId: PolicyVersionId;
  readonly runId: string;
  readonly turnId: string;
  readonly reason: string;
  /** Source binding is deliberately excluded: it can contain a raw content hash. */
  readonly metadata: Omit<ContextResourceMetadata, "binding">;
}

export interface ContextMetadataDecision {
  readonly policySnapshotId: PolicyVersionId;
  readonly effect: "allow" | "deny";
  readonly reason: string;
  /** Identifier-free category retained when resource identity is unsafe. */
  readonly safeResourceCategory: string;
}

export interface ContextContentPolicyInput {
  readonly policySnapshotId: PolicyVersionId;
  readonly runId: string;
  readonly turnId: string;
  readonly reason: string;
  readonly resource: ResourceRef;
  readonly policyProjection: ContextPolicyProjection;
  readonly mediaType: string;
  readonly classification: string;
  readonly sourceByteLength: number;
  readonly truncated: boolean;
  readonly secretCategories: readonly SecretCategoryCount[];
  readonly promptInjectionTags: readonly PromptInjectionTag[];
}

export interface ContextContentDecision {
  readonly policySnapshotId: PolicyVersionId;
  readonly effect: "allow" | "deny" | "redact";
  readonly reason: string;
  readonly safeResourceCategory: string;
}

export interface ContextReleasePolicySnapshot {
  readonly schemaVersion: 1;
  readonly releasePolicyId: string;
  readonly releasePolicyVersion: number;
  readonly contentHash: string;
  readonly secretDisposition: "allow" | "deny" | "redact";
  readonly promptInjectionDisposition: "tag" | "deny";
  readonly truncatedDisposition: "allow" | "deny";
}

export interface ContextPolicyHooks {
  /** Exact immutable snapshot owned by these captured hooks. */
  readonly policySnapshotId: PolicyVersionId;
  readonly releasePolicy: ContextReleasePolicySnapshot;
  decideMetadata(
    input: ContextMetadataPolicyInput,
  ): ContextMetadataDecision | Promise<ContextMetadataDecision>;
  decideContent(
    input: ContextContentPolicyInput,
  ): ContextContentDecision | Promise<ContextContentDecision>;
}

export interface ReleasedContextItem {
  readonly schemaVersion: 1;
  readonly itemId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly resource: ResourceRef;
  readonly selector: JsonObject | null;
  readonly value: JsonValue;
  /** Exact UTF-8 semantic value supplied to a driver/provider encoder. */
  readonly serializedValue: string;
  readonly mediaType: string;
  readonly classification: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly truncated: boolean;
  readonly untrusted: true;
}

export interface ContextManifestEntry {
  readonly schemaVersion: 1;
  readonly ordinal: number;
  readonly itemId: string | null;
  readonly runId: string;
  readonly turnId: string;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly resource: ResourceRef | null;
  readonly safeResourceCategory: string;
  readonly selector: JsonObject | null;
  readonly status: "released" | "denied";
  readonly deduplicated: boolean;
  readonly releasedContentHash: string | null;
  readonly redactions: readonly SecretCategoryCount[];
  readonly byteLength: number;
  readonly conservativeTokenEstimate: number;
  readonly tokenEstimator: "utf8-byte-upper-bound-v1";
  readonly policySnapshotId: PolicyVersionId;
  readonly releasePolicyId: string;
  readonly releasePolicyVersion: number;
  readonly releasePolicyContentHash: string;
  /** Null only when a safe denial occurs before source policy metadata exists. */
  readonly policyCatalogId: string | null;
  readonly policyCatalogVersion: number | null;
  readonly policyCatalogContentHash: string | null;
  readonly reason: string;
  readonly promptInjectionTags: readonly PromptInjectionTag[];
  readonly truncated: boolean;
}

export interface ReleasedContextResult {
  readonly status: "released";
  readonly item: ReleasedContextItem;
  readonly manifest: ContextManifestEntry;
}

export interface DeniedContextResult {
  readonly status: "denied";
  readonly error: DomainError;
  readonly manifest: ContextManifestEntry;
}

export type ContextReleaseResult = ReleasedContextResult | DeniedContextResult;

export interface SourceContextReleaseRequest {
  readonly turnId: string;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly request: unknown;
  readonly maximumBytes: number;
  readonly reason: string;
  readonly signal: AbortSignal;
}

export interface CapabilityOutputReleaseRequest {
  readonly turnId: string;
  readonly sourceVersion: number;
  readonly resource: ResourceRef;
  readonly policyProjection: ContextPolicyProjection;
  readonly output: unknown;
  readonly classification: string;
  readonly reason: string;
}

export interface AgentContextAssemblyRequest {
  readonly turnId: string;
  /** Globally unique downstream agent request identity, normally an attempt ID. */
  readonly agentRequestId: string;
  readonly orderedItemIds: readonly string[];
}

export interface ContextManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly turnId: string;
  readonly agentRequestId: string;
  readonly policySnapshotId: PolicyVersionId;
  readonly releasePolicyId: string;
  readonly releasePolicyVersion: number;
  readonly releasePolicyContentHash: string;
  readonly orderedItemIds: readonly string[];
  readonly entries: readonly ContextManifestEntry[];
  readonly totalBytes: number;
  readonly conservativeTokenEstimate: number;
  readonly tokenEstimator: "utf8-byte-upper-bound-v1";
}

export interface AgentContextAssembly {
  readonly schemaVersion: 1;
  /** Exact broker-owned values that passed the final aggregate checks. */
  readonly items: readonly ReleasedContextItem[];
  readonly serializedValues: readonly string[];
  /** Newline-delimited exact serializedValues; every value is canonical JSON. */
  readonly utf8Text: string;
  readonly utf8ByteLength: number;
  readonly manifest: ContextManifest;
}

/** Immutable facts a runtime uses to validate one run-owned broker boundary. */
export interface ContextBrokerIntegrationDescriptor {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly policySnapshotId: PolicyVersionId;
  readonly releasePolicyId: string;
  readonly releasePolicyVersion: number;
  readonly releasePolicyContentHash: string;
  readonly sourceDescriptors: readonly ContextSourceDescriptor[];
  readonly budgets: ContextBudgetLimits;
  /** Hash of every enforcement-relevant captured factory option. */
  readonly configurationContentHash: string;
}

/** Run-independent pins exposed by a recognized integration factory. */
export type ContextBrokerConfigurationDescriptor = Omit<
  ContextBrokerIntegrationDescriptor,
  "runId"
>;

export interface ContextBudgetUsage {
  readonly runAttempts: number;
  readonly runReleasedItems: number;
  readonly runBytes: number;
  readonly turns: readonly {
    readonly turnId: string;
    readonly attempts: number;
    readonly releasedItems: number;
    readonly bytes: number;
  }[];
}
