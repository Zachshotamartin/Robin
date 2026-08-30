import { randomBytes } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  CONTRACT_SCHEMA_VERSION,
  PolicyVersionIdKind,
  canonicalBytes,
  canonicalSha256Hex,
  canonicalize,
  createDomainError,
  isDomainError,
  sha256Hex,
} from "@guard/contracts";
import type {
  DomainError,
  JsonObject,
  JsonValue,
  PolicyVersionId,
  ResourceRef,
} from "@guard/contracts";

import { BrokerContextSourceRegistry } from "./broker-source-registry.js";
import {
  classifyAndTransformJson,
  compileCustomSecretClassifiers,
  detectCrossValueSecrets,
  type CompiledCustomSecretClassifier,
  type CustomSecretClassifierInput,
} from "./classification.js";
import type {
  AgentContextAssembly,
  AgentContextAssemblyRequest,
  BrokerContextSource,
  CapabilityOutputReleaseRequest,
  ContextBudgetLimits,
  ContextBudgetUsage,
  ContextBrokerIntegrationDescriptor,
  ContextContentDecision,
  ContextContentPolicyInput,
  ContextManifest,
  ContextManifestEntry,
  ContextMetadataDecision,
  ContextMetadataPolicyInput,
  ContextPolicyHooks,
  ContextReleaseResult,
  ContextReleasePolicySnapshot,
  ContextResourceMetadata,
  NormalizedResourceRequest,
  OpenedContextResource,
  ReleasedContextItem,
  SecretCategoryCount,
  SourceContextReleaseRequest,
} from "./context-boundary.js";
import { snapshot, snapshotBoundaryObject } from "./immutable.js";
import {
  decodeConservativeUtf8,
  normalizeMediaType,
  preflightTextMediaType,
} from "./media.js";
import { canonicalizeResourceRef, resourceRefsEqual } from "./resource-ref.js";
import { capturePinnedContextPolicyAdapter } from "./policy-adapter.js";

export interface ContextBrokerOptions {
  readonly runId: string;
  readonly policySnapshotId: PolicyVersionId;
  readonly releasePolicy: ContextReleasePolicySnapshot;
  readonly sources: BrokerContextSourceRegistry;
  readonly policy: ContextPolicyHooks;
  readonly budgets: ContextBudgetLimits;
  readonly customSecretClassifiers?: readonly CustomSecretClassifierInput[];
  readonly additionalReviewedTextMediaTypes?: readonly string[];
}

interface TurnUsage {
  attempts: number;
  releasedItems: number;
  bytes: number;
}

interface UsageAllowance {
  readonly maximumBytes: number;
}

interface ParsedSourceRequest {
  readonly turnId: string;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly rawRequest: unknown;
  readonly maximumBytes: number;
  readonly reason: string;
  readonly signal: AbortSignal;
}

interface ParsedCapabilityReleaseRequest {
  readonly turnId: string;
  readonly sourceVersion: number;
  readonly rawResource: unknown;
  readonly rawPolicyProjection: unknown;
  readonly rawOutput: unknown;
  readonly classification: string;
  readonly reason: string;
}

interface EnvelopeReleaseInput {
  readonly turnId: string;
  readonly reason: string;
  readonly metadata: ContextResourceMetadata;
  readonly rawEnvelope: JsonObject;
  readonly sourceByteLength: number;
  readonly truncated: boolean;
  readonly allowance: UsageAllowance;
}

interface PolicyHandlers {
  readonly policySnapshotId: PolicyVersionId;
  readonly releasePolicy: ContextReleasePolicySnapshot;
  readonly metadata: ContextPolicyHooks["decideMetadata"];
  readonly content: ContextPolicyHooks["decideContent"];
}

const MAXIMUM_BROKER_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_BROKER_CUMULATIVE_BYTES = 1024 * 1024 * 1024;
const MAXIMUM_BROKER_ITEMS = 4_096;
const RECOGNIZED_CONTEXT_BROKERS = new WeakSet<object>();
const SOURCE_CONTROL_PLANE_LIMITS = Object.freeze({
  maximumDepth: 32,
  maximumNodes: 8_192,
  maximumArrayLength: 2_048,
  maximumObjectProperties: 2_048,
  maximumStringUtf8Bytes: 64 * 1024,
  maximumCanonicalUtf8Bytes: 128 * 1024,
});

/**
 * Per-run context security boundary. It owns the pinned policy ID, ordered
 * release history, and cumulative budget ledger; callers cannot reset any of
 * those values by constructing a new request.
 */
export class ContextBroker {
  readonly runId: string;
  readonly policySnapshotId: PolicyVersionId;
  readonly releasePolicy: ContextReleasePolicySnapshot;
  readonly descriptor: ContextBrokerIntegrationDescriptor;
  readonly #sources: BrokerContextSourceRegistry;
  readonly #policy: PolicyHandlers;
  readonly #budgets: ContextBudgetLimits;
  readonly #customClassifiers: readonly CompiledCustomSecretClassifier[];
  readonly #additionalTextMediaTypes: ReadonlySet<string>;
  readonly #runCorrelationId: string;
  readonly #turnUsage = new Map<string, TurnUsage>();
  readonly #manifestEntries: ContextManifestEntry[] = [];
  readonly #releasedItems = new Map<string, ReleasedContextItem>();
  readonly #deduplicatedItems = new Map<string, ReleasedContextItem>();
  readonly #assemblies = new Map<string, AgentContextAssembly>();
  readonly #turnAssemblyOwners = new Map<string, string>();
  readonly #sealedTurns = new Set<string>();
  #runAttempts = 0;
  #runReleasedItems = 0;
  #runBytes = 0;
  #ordinal = 0;
  #serialTail: Promise<void> = Promise.resolve();

  constructor(options: ContextBrokerOptions) {
    const fields = readOptionsDataProperties(options);
    validateSafeIdentifier(fields["runId"], "runId");
    if (typeof fields["policySnapshotId"] !== "string") {
      throw invalidInput("policySnapshotId must be a canonical policy identifier.");
    }
    const policySnapshotId = PolicyVersionIdKind.parse(fields["policySnapshotId"]);
    if (
      !(fields["sources"] instanceof BrokerContextSourceRegistry) ||
      isProxy(fields["sources"]) ||
      Object.getPrototypeOf(fields["sources"]) !== BrokerContextSourceRegistry.prototype
    ) {
      throw invalidInput("A context broker requires an immutable source registry.");
    }
    const releasePolicy = fields["releasePolicy"] as ContextReleasePolicySnapshot;
    const adapter = capturePinnedContextPolicyAdapter(
      fields["policy"],
      policySnapshotId,
      releasePolicy,
    );
    const handlers: PolicyHandlers = Object.freeze({
      policySnapshotId: adapter.policySnapshotId,
      releasePolicy: adapter.releasePolicy,
      metadata: adapter.decideMetadata.bind(adapter),
      content: adapter.decideContent.bind(adapter),
    });
    const budgets = parseBudgets(fields["budgets"]);
    const custom = compileCustomSecretClassifiers(
      (fields["customSecretClassifiers"] ?? []) as readonly CustomSecretClassifierInput[],
    );
    const additionalMedia = parseAdditionalMediaTypes(
      fields["additionalReviewedTextMediaTypes"] ?? [],
    );

    this.runId = fields["runId"];
    this.policySnapshotId = policySnapshotId;
    this.releasePolicy = adapter.releasePolicy;
    this.#sources = fields["sources"];
    this.#policy = handlers;
    this.#budgets = budgets;
    this.#customClassifiers = custom;
    this.#additionalTextMediaTypes = additionalMedia;
    this.#runCorrelationId = randomBytes(18).toString("base64url");
    const sourceDescriptors = snapshot(this.#sources.list());
    const additionalReviewedTextMediaTypes = Object.freeze(
      [...this.#additionalTextMediaTypes].sort(),
    );
    const classifierDescriptors = Object.freeze(
      this.#customClassifiers.map((classifier) =>
        Object.freeze({
          classifierId: classifier.classifierId,
          pattern: classifier.source,
          caseInsensitive: classifier.caseInsensitive,
        }),
      ),
    );
    const configurationContentHash = canonicalSha256Hex({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      policySnapshotId,
      releasePolicy: this.releasePolicy,
      sourceDescriptors,
      budgets,
      customSecretClassifiers: classifierDescriptors,
      additionalReviewedTextMediaTypes,
    });
    this.descriptor = snapshot({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      runId: this.runId,
      policySnapshotId: this.policySnapshotId,
      releasePolicyId: this.releasePolicy.releasePolicyId,
      releasePolicyVersion: this.releasePolicy.releasePolicyVersion,
      releasePolicyContentHash: this.releasePolicy.contentHash,
      sourceDescriptors,
      budgets,
      configurationContentHash,
    });
    RECOGNIZED_CONTEXT_BROKERS.add(this);
    Object.freeze(this);
  }

  releaseSource(request: SourceContextReleaseRequest): Promise<ContextReleaseResult> {
    let parsed: ParsedSourceRequest;
    try {
      parsed = parseSourceReleaseRequest(request);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    return this.#serialized(() => this.#releaseSource(parsed));
  }

  releaseCapabilityOutput(
    request: CapabilityOutputReleaseRequest,
  ): Promise<ContextReleaseResult> {
    let parsed: ParsedCapabilityReleaseRequest;
    try {
      parsed = parseCapabilityReleaseRequest(request);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    return this.#serialized(() => this.#releaseCapabilityOutput(parsed));
  }

  assembleAgentContext(
    request: AgentContextAssemblyRequest,
  ): Promise<AgentContextAssembly> {
    let parsed: AgentContextAssemblyRequest;
    try {
      parsed = parseAssemblyRequest(request, this.#budgets.maximumItemsPerTurn);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    return this.#serialized(() => this.#assembleAgentContext(parsed));
  }

  async #assembleAgentContext(
    parsed: AgentContextAssemblyRequest,
  ): Promise<AgentContextAssembly> {
    const priorAssembly = this.#assemblies.get(parsed.agentRequestId);
    if (priorAssembly !== undefined) {
      if (
        priorAssembly.manifest.turnId !== parsed.turnId ||
        canonicalize(priorAssembly.manifest.orderedItemIds) !==
          canonicalize(parsed.orderedItemIds)
      ) {
        throw createDomainError({
          code: "conflict",
          message: "An agent request ID is already bound to different context items.",
        });
      }
    }
    const turnOwner = this.#turnAssemblyOwners.get(parsed.turnId);
    if (turnOwner !== undefined && turnOwner !== parsed.agentRequestId) {
      throw createDomainError({
        code: "conflict",
        message: "A context turn is already sealed for another agent request.",
      });
    }
    const seen = new Set<string>();
    const items: ReleasedContextItem[] = [];
    for (const itemId of parsed.orderedItemIds) {
      if (seen.has(itemId)) {
        throw invalidInput("An assembled context item may appear only once.");
      }
      seen.add(itemId);
      const item = this.#releasedItems.get(itemId);
      if (item === undefined) {
        throw invalidInput("An assembled context item is unknown to this run broker.");
      }
      items.push(item);
    }
    const crossItemSecrets = detectCrossValueSecrets(
      items.map((item) => item.value),
      this.#customClassifiers,
    );
    if (crossItemSecrets.categories.length > 0) {
      throw createDomainError({
        code: "policy_denied",
        message: "Agent context assembly detected a secret split across released items.",
      });
    }
    const utf8ByteLength =
      items.reduce((total, item) => total + item.byteLength, 0) +
      Math.max(0, items.length - 1);
    if (utf8ByteLength > this.#budgets.maximumRequestBytes) {
      throw budgetExceeded(
        "The assembled provider context exceeds the per-request byte budget.",
      );
    }
    if (priorAssembly !== undefined) {
      return priorAssembly;
    }
    const serializedValues = Object.freeze(items.map((item) => item.serializedValue));
    const utf8Text = serializedValues.join("\n");
    const entries = Object.freeze(
      items.map((item) => {
        const entry = this.#manifestEntries.find(
          (candidate) => candidate.itemId === item.itemId,
        );
        if (entry === undefined) {
          throw createDomainError({
            code: "invariant_violated",
            message: "A released context item has no manifest entry.",
          });
        }
        return entry;
      }),
    );
    const manifest: ContextManifest = snapshot({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      runId: this.runId,
      turnId: parsed.turnId,
      agentRequestId: parsed.agentRequestId,
      policySnapshotId: this.policySnapshotId,
      releasePolicyId: this.releasePolicy.releasePolicyId,
      releasePolicyVersion: this.releasePolicy.releasePolicyVersion,
      releasePolicyContentHash: this.releasePolicy.contentHash,
      orderedItemIds: parsed.orderedItemIds,
      entries,
      totalBytes: utf8ByteLength,
      conservativeTokenEstimate: utf8ByteLength,
      tokenEstimator: "utf8-byte-upper-bound-v1" as const,
    });
    const assembly: AgentContextAssembly = Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      items: Object.freeze([...items]),
      serializedValues,
      utf8Text,
      utf8ByteLength,
      manifest,
    });
    this.#assemblies.set(parsed.agentRequestId, assembly);
    this.#turnAssemblyOwners.set(parsed.turnId, parsed.agentRequestId);
    this.#sealedTurns.add(parsed.turnId);
    return assembly;
  }

  listManifestEntries(): readonly ContextManifestEntry[] {
    return snapshot(this.#manifestEntries);
  }

  budgetUsage(): ContextBudgetUsage {
    return snapshot({
      runAttempts: this.#runAttempts,
      runReleasedItems: this.#runReleasedItems,
      runBytes: this.#runBytes,
      turns: [...this.#turnUsage.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([turnId, usage]) => ({ turnId, ...usage })),
    });
  }

  async #releaseSource(
    parsed: ParsedSourceRequest,
  ): Promise<ContextReleaseResult> {
    assertNotAborted(parsed.signal);
    this.#assertTurnOpen(parsed.turnId);
    let allowance: UsageAllowance;
    try {
      allowance = this.#preflightUsage(parsed.turnId, parsed.maximumBytes);
    } catch (error: unknown) {
      if (!isDomainError(error) || error.code !== "budget_exceeded") throw error;
      return this.#recordDenial({
        turnId: parsed.turnId,
        sourceId: parsed.sourceId,
        sourceVersion: parsed.sourceVersion,
        policyProjection: null,
        safeResourceCategory: "context_request",
        reason: "context.budget.preflight",
        redactions: [],
        promptInjectionTags: [],
        truncated: false,
        error,
      });
    }
    const source = this.#sources.resolve(parsed.sourceId, parsed.sourceVersion);
    const normalized = await callSource(() =>
      source.normalizeResourceRequest(parsed.rawRequest),
    );
    const request = validateNormalizedRequest(normalized, source, parsed);
    const rawMetadata = await callSource(() =>
      source.inspectMetadata(request, parsed.signal),
    );
    const metadata = validateMetadata(rawMetadata, source, request);
    if (metadata.byteLength > this.#budgets.maximumResourceBytes) {
      return this.#recordDenial({
        turnId: parsed.turnId,
        sourceId: metadata.sourceId,
        sourceVersion: metadata.sourceVersion,
        policyProjection: metadata.policyProjection,
        safeResourceCategory: "oversized_resource",
        reason: "context.budget.resource",
        redactions: [],
        promptInjectionTags: [],
        truncated: false,
        error: budgetExceeded("The context resource exceeds the per-resource byte budget."),
      });
    }

    const metadataDecision = await this.#decideMetadata(
      parsed.turnId,
      parsed.reason,
      metadata,
    );
    if (metadataDecision.effect === "deny") {
      return this.#recordDenial({
        turnId: parsed.turnId,
        sourceId: metadata.sourceId,
        sourceVersion: metadata.sourceVersion,
        policyProjection: metadata.policyProjection,
        safeResourceCategory: metadataDecision.safeResourceCategory,
        reason: metadataDecision.reason,
        redactions: [],
        promptInjectionTags: [],
        truncated: false,
        error: policyDenied("The pinned context metadata policy denied this resource."),
      });
    }

    const media = preflightTextMediaType(
      metadata.mediaType,
      this.#additionalTextMediaTypes,
    );
    if (!media.supported) {
      return this.#recordDenial({
        turnId: parsed.turnId,
        sourceId: metadata.sourceId,
        sourceVersion: metadata.sourceVersion,
        policyProjection: metadata.policyProjection,
        safeResourceCategory: metadataDecision.safeResourceCategory,
        reason: media.reason,
        redactions: [],
        promptInjectionTags: [],
        truncated: false,
        error: policyDenied("The context media type is not eligible for agent release."),
      });
    }

    assertNotAborted(parsed.signal);
    const openedRaw = await callSource(() =>
      source.openBounded(
        request,
        metadata,
        { maximumBytes: allowance.maximumBytes },
        parsed.signal,
      ),
    );
    const opened = validateOpenedResource(
      openedRaw,
      source,
      request,
      metadata,
      allowance.maximumBytes,
    );
    const decoded = decodeConservativeUtf8(
      opened.bytes,
      media.normalizedMediaType,
      this.#budgets.maximumControlCharacterRatio,
    );
    if (!decoded.accepted) {
      return this.#recordDenial({
        turnId: parsed.turnId,
        sourceId: metadata.sourceId,
        sourceVersion: metadata.sourceVersion,
        policyProjection: metadata.policyProjection,
        safeResourceCategory: metadataDecision.safeResourceCategory,
        reason: decoded.reason,
        redactions: [],
        promptInjectionTags: [],
        truncated: opened.truncated,
        error: policyDenied("The context bytes could not be decoded for agent release."),
      });
    }

    const envelope: JsonObject = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "source_context",
      untrusted: true,
      trustLabel: "untrusted_source_content",
      resource: snapshotBoundaryObject(opened.resource, "Opened resource"),
      selector: opened.selector,
      provenance: {
        sourceId: opened.sourceId,
        sourceVersion: opened.sourceVersion,
        classification: opened.classification,
        policyCatalogId: opened.policyProjection.catalogId,
        policyCatalogVersion: opened.policyProjection.catalogVersion,
        policyCatalogContentHash: opened.policyProjection.catalogContentHash,
      },
      content: decoded.text,
    };
    return this.#releaseEnvelope({
      turnId: parsed.turnId,
      reason: parsed.reason,
      metadata,
      rawEnvelope: envelope,
      sourceByteLength: opened.byteLength,
      truncated: opened.truncated,
      allowance,
    });
  }

  async #releaseCapabilityOutput(
    request: ParsedCapabilityReleaseRequest,
  ): Promise<ContextReleaseResult> {
    this.#assertTurnOpen(request.turnId);
    const resource = canonicalizeResourceRef(request.rawResource);
    const policyProjection = parsePolicyProjection(request.rawPolicyProjection);
    let allowance: UsageAllowance;
    try {
      allowance = this.#preflightUsage(
        request.turnId,
        this.#budgets.maximumRequestBytes,
      );
    } catch (error: unknown) {
      if (!isDomainError(error) || error.code !== "budget_exceeded") throw error;
      return this.#recordDenial({
        turnId: request.turnId,
        sourceId: resource.sourceId,
        sourceVersion: request.sourceVersion,
        policyProjection,
        safeResourceCategory: "capability_output",
        reason: "context.budget.preflight",
        redactions: [],
        promptInjectionTags: [],
        truncated: false,
        error,
      });
    }
    const snapshotCeiling = Math.min(
      this.#budgets.maximumResourceBytes,
      allowance.maximumBytes,
    );
    if (resource.classification !== request.classification) {
      throw invalidInput(
        "Capability output classification must match its resource reference.",
      );
    }
    const structuralCeiling = Math.max(1, Math.min(100_000, snapshotCeiling));
    let wrapped: JsonObject;
    try {
      wrapped = snapshotBoundaryObject(
        { value: request.rawOutput },
        "Capability agent output",
        {
          maximumDepth: 64,
          maximumNodes: structuralCeiling,
          maximumArrayLength: Math.min(10_000, structuralCeiling),
          maximumObjectProperties: Math.min(10_000, structuralCeiling),
          maximumStringUtf8Bytes: Math.min(1_048_576, snapshotCeiling),
          maximumCanonicalUtf8Bytes: snapshotCeiling,
        },
      );
    } catch (error: unknown) {
      if (!isDomainError(error) || error.code !== "budget_exceeded") throw error;
      return this.#recordDenial({
        turnId: request.turnId,
        sourceId: resource.sourceId,
        sourceVersion: request.sourceVersion,
        policyProjection,
        safeResourceCategory: "capability_output",
        reason: "context.budget.capability_output",
        redactions: [],
        promptInjectionTags: [],
        truncated: false,
        error,
      });
    }
    const output = wrapped["value"] as JsonValue;
    const rawEnvelope: JsonObject = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "capability_output",
      untrusted: true,
      trustLabel: "untrusted_capability_output",
      resource: snapshotBoundaryObject(resource, "Capability resource"),
      provenance: {
        sourceId: resource.sourceId,
        sourceVersion: request.sourceVersion,
        classification: request.classification,
        policyCatalogId: policyProjection.catalogId,
        policyCatalogVersion: policyProjection.catalogVersion,
        policyCatalogContentHash: policyProjection.catalogContentHash,
      },
      output,
    };
    const sourceBytes = canonicalBytes(rawEnvelope);
    if (
      sourceBytes.byteLength > this.#budgets.maximumResourceBytes ||
      sourceBytes.byteLength > allowance.maximumBytes
    ) {
      return this.#recordDenial({
        turnId: request.turnId,
        sourceId: resource.sourceId,
        sourceVersion: request.sourceVersion,
        policyProjection,
        safeResourceCategory: "capability_output",
        reason: "context.budget.capability_output",
        redactions: [],
        promptInjectionTags: [],
        truncated: false,
        error: budgetExceeded("The capability output exceeds its context byte budget."),
      });
    }
    const metadata = validateMetadata(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        sourceId: resource.sourceId,
        sourceVersion: request.sourceVersion,
        resource,
        selector: null,
        byteLength: sourceBytes.byteLength,
        selectedByteLength: sourceBytes.byteLength,
        mediaType: "application/json",
        classification: request.classification,
        kind: "capability_output",
        policyProjection,
        binding: { rawOutputHash: sha256Hex(sourceBytes) },
      },
      null,
      null,
    );
    const metadataDecision = await this.#decideMetadata(
      request.turnId,
      request.reason,
      metadata,
    );
    if (metadataDecision.effect === "deny") {
      return this.#recordDenial({
        turnId: request.turnId,
        sourceId: metadata.sourceId,
        sourceVersion: metadata.sourceVersion,
        policyProjection: metadata.policyProjection,
        safeResourceCategory: metadataDecision.safeResourceCategory,
        reason: metadataDecision.reason,
        redactions: [],
        promptInjectionTags: [],
        truncated: false,
        error: policyDenied("The pinned context metadata policy denied this output."),
      });
    }
    return this.#releaseEnvelope({
      turnId: request.turnId,
      reason: request.reason,
      metadata,
      rawEnvelope,
      sourceByteLength: sourceBytes.byteLength,
      truncated: false,
      allowance,
    });
  }

  async #releaseEnvelope(
    input: EnvelopeReleaseInput,
  ): Promise<ContextReleaseResult> {
    const classified = classifyAndTransformJson(
      input.rawEnvelope,
      "allow",
      this.#runCorrelationId,
      this.#customClassifiers,
    );
    const contentDecision = await this.#decideContent(
      input.turnId,
      input.reason,
      input.metadata,
      input.sourceByteLength,
      input.truncated,
      classified.categories,
      classified.promptInjectionTags,
    );
    if (contentDecision.effect === "deny") {
      return this.#recordDenial({
        turnId: input.turnId,
        sourceId: input.metadata.sourceId,
        sourceVersion: input.metadata.sourceVersion,
        policyProjection: input.metadata.policyProjection,
        safeResourceCategory: contentDecision.safeResourceCategory,
        reason: contentDecision.reason,
        redactions: classified.categories,
        promptInjectionTags: classified.promptInjectionTags,
        truncated: input.truncated,
        error: policyDenied("The pinned context content policy denied agent release."),
      });
    }

    const transformed =
      contentDecision.effect === "redact"
        ? classifyAndTransformJson(
            input.rawEnvelope,
            "redact",
            this.#runCorrelationId,
            this.#customClassifiers,
          )
        : classified;
    const serializedValue = canonicalize(transformed.value);
    const byteLength = Buffer.byteLength(serializedValue, "utf8");
    if (byteLength > input.allowance.maximumBytes) {
      return this.#recordDenial({
        turnId: input.turnId,
        sourceId: input.metadata.sourceId,
        sourceVersion: input.metadata.sourceVersion,
        policyProjection: input.metadata.policyProjection,
        safeResourceCategory: contentDecision.safeResourceCategory,
        reason: "context.budget.released_representation",
        redactions:
          contentDecision.effect === "redact" ? classified.categories : [],
        promptInjectionTags: classified.promptInjectionTags,
        truncated: input.truncated,
        error: budgetExceeded(
          "The released context representation exceeds its remaining byte budget.",
        ),
      });
    }
    if (!isPlainObject(transformed.value)) {
      throw createDomainError({
        code: "invariant_violated",
        message: "A context envelope did not remain an object after classification.",
      });
    }
    const resource = canonicalizeResourceRef(transformed.value["resource"]);
    const selector = parseNullableJsonObject(
      transformed.value["selector"] ?? null,
      "Released selector",
    );
    const contentHash = sha256Hex(serializedValue);
    const deduplicationKey = sha256Hex(
      canonicalize({
        turnId: input.turnId,
        policySnapshotId: this.policySnapshotId,
        releasePolicyId: this.releasePolicy.releasePolicyId,
        releasePolicyVersion: this.releasePolicy.releasePolicyVersion,
        releasePolicyContentHash: this.releasePolicy.contentHash,
        resource,
        selector,
        releasedContentHash: contentHash,
        mediaType: input.metadata.mediaType,
        classification: input.metadata.classification,
        truncated: input.truncated,
        transform: contentDecision.effect,
      }),
    );
    const existing = this.#deduplicatedItems.get(deduplicationKey);
    if (existing !== undefined) {
      const manifest: ContextManifestEntry = snapshot({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        ordinal: this.#nextOrdinal(),
        itemId: existing.itemId,
        runId: this.runId,
        turnId: input.turnId,
        sourceId: input.metadata.sourceId,
        sourceVersion: input.metadata.sourceVersion,
        resource,
        safeResourceCategory: contentDecision.safeResourceCategory,
        selector,
        status: "released" as const,
        deduplicated: true,
        releasedContentHash: contentHash,
        redactions:
          contentDecision.effect === "redact" ? classified.categories : [],
        byteLength: 0,
        conservativeTokenEstimate: 0,
        tokenEstimator: "utf8-byte-upper-bound-v1" as const,
        policySnapshotId: this.policySnapshotId,
        releasePolicyId: this.releasePolicy.releasePolicyId,
        releasePolicyVersion: this.releasePolicy.releasePolicyVersion,
        releasePolicyContentHash: this.releasePolicy.contentHash,
        policyCatalogId: input.metadata.policyProjection.catalogId,
        policyCatalogVersion: input.metadata.policyProjection.catalogVersion,
        policyCatalogContentHash:
          input.metadata.policyProjection.catalogContentHash,
        reason: contentDecision.reason,
        promptInjectionTags: classified.promptInjectionTags,
        truncated: input.truncated,
      });
      this.#manifestEntries.push(manifest);
      return Object.freeze({ status: "released", item: existing, manifest });
    }
    const ordinal = this.#nextOrdinal();
    const itemId = `ctx_${sha256Hex(
      `${this.runId}\u0000${String(ordinal)}\u0000${contentHash}`,
    ).slice(0, 40)}`;
    const item: ReleasedContextItem = snapshot({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      itemId,
      runId: this.runId,
      turnId: input.turnId,
      resource,
      selector,
      value: transformed.value,
      serializedValue,
      mediaType: input.metadata.mediaType,
      classification: input.metadata.classification,
      byteLength,
      contentHash,
      truncated: input.truncated,
      untrusted: true as const,
    });
    this.#commitUsage(input.turnId, byteLength);
    const manifest: ContextManifestEntry = snapshot({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      ordinal,
      itemId,
      runId: this.runId,
      turnId: input.turnId,
      sourceId: input.metadata.sourceId,
      sourceVersion: input.metadata.sourceVersion,
      resource,
      safeResourceCategory: contentDecision.safeResourceCategory,
      selector,
      status: "released" as const,
      deduplicated: false,
      releasedContentHash: contentHash,
      redactions:
        contentDecision.effect === "redact" ? classified.categories : [],
      byteLength,
      conservativeTokenEstimate: byteLength,
      tokenEstimator: "utf8-byte-upper-bound-v1" as const,
      policySnapshotId: this.policySnapshotId,
      releasePolicyId: this.releasePolicy.releasePolicyId,
      releasePolicyVersion: this.releasePolicy.releasePolicyVersion,
      releasePolicyContentHash: this.releasePolicy.contentHash,
      policyCatalogId: input.metadata.policyProjection.catalogId,
      policyCatalogVersion: input.metadata.policyProjection.catalogVersion,
      policyCatalogContentHash:
        input.metadata.policyProjection.catalogContentHash,
      reason: contentDecision.reason,
      promptInjectionTags: classified.promptInjectionTags,
      truncated: input.truncated,
    });
    this.#releasedItems.set(itemId, item);
    this.#deduplicatedItems.set(deduplicationKey, item);
    this.#manifestEntries.push(manifest);
    return Object.freeze({ status: "released", item, manifest });
  }

  async #decideMetadata(
    turnId: string,
    reason: string,
    metadata: ContextResourceMetadata,
  ): Promise<ContextMetadataDecision> {
    const policyMetadata: ContextMetadataPolicyInput["metadata"] = snapshot({
      schemaVersion: metadata.schemaVersion,
      sourceId: metadata.sourceId,
      sourceVersion: metadata.sourceVersion,
      resource: metadata.resource,
      selector: metadata.selector,
      byteLength: metadata.byteLength,
      selectedByteLength: metadata.selectedByteLength,
      mediaType: metadata.mediaType,
      classification: metadata.classification,
      kind: metadata.kind,
      policyProjection: metadata.policyProjection,
    });
    const input: ContextMetadataPolicyInput = snapshot({
      policySnapshotId: this.policySnapshotId,
      runId: this.runId,
      turnId,
      reason,
      metadata: policyMetadata,
    });
    let raw: unknown;
    try {
      raw = await this.#policy.metadata(input);
    } catch {
      throw createDomainError({
        code: "policy_denied",
        message: "Context metadata policy evaluation failed closed.",
      });
    }
    return parseMetadataDecision(raw, this.policySnapshotId);
  }

  async #decideContent(
    turnId: string,
    reason: string,
    metadata: ContextResourceMetadata,
    sourceByteLength: number,
    truncated: boolean,
    secretCategories: readonly SecretCategoryCount[],
    promptInjectionTags: ContextContentPolicyInput["promptInjectionTags"],
  ): Promise<ContextContentDecision> {
    const input: ContextContentPolicyInput = snapshot({
      policySnapshotId: this.policySnapshotId,
      runId: this.runId,
      turnId,
      reason,
      resource: metadata.resource,
      policyProjection: metadata.policyProjection,
      mediaType: metadata.mediaType,
      classification: metadata.classification,
      sourceByteLength,
      truncated,
      secretCategories,
      promptInjectionTags,
    });
    let raw: unknown;
    try {
      raw = await this.#policy.content(input);
    } catch {
      throw createDomainError({
        code: "policy_denied",
        message: "Context content policy evaluation failed closed.",
      });
    }
    return parseContentDecision(raw, this.policySnapshotId);
  }

  #preflightUsage(turnId: string, requestedMaximumBytes: number): UsageAllowance {
    validateSafeIdentifier(turnId, "turnId");
    validateNonNegativeSafeInteger(requestedMaximumBytes, "maximumBytes");
    if (requestedMaximumBytes > this.#budgets.maximumRequestBytes) {
      throw budgetExceeded("The context request exceeds the per-request byte budget.");
    }
    const turn = this.#turnUsage.get(turnId) ?? {
      attempts: 0,
      releasedItems: 0,
      bytes: 0,
    };
    if (
      turn.attempts >= this.#budgets.maximumItemsPerTurn ||
      this.#runAttempts >= this.#budgets.maximumItemsPerRun
    ) {
      throw budgetExceeded("The context item budget is exhausted.");
    }
    const maximumBytes = Math.min(
      requestedMaximumBytes,
      this.#budgets.maximumBytesPerTurn - turn.bytes,
      this.#budgets.maximumBytesPerRun - this.#runBytes,
    );
    if (maximumBytes <= 0) {
      throw budgetExceeded("The context byte budget is exhausted.");
    }
    this.#turnUsage.set(turnId, {
      ...turn,
      attempts: turn.attempts + 1,
    });
    this.#runAttempts += 1;
    return Object.freeze({ maximumBytes });
  }

  #commitUsage(turnId: string, bytes: number): void {
    const turn = this.#turnUsage.get(turnId);
    if (turn === undefined || turn.attempts < 1) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Context release committed without a matching attempt.",
      });
    }
    if (
      turn.bytes + bytes > this.#budgets.maximumBytesPerTurn ||
      this.#runBytes + bytes > this.#budgets.maximumBytesPerRun
    ) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Context budget changed after serialized preflight.",
      });
    }
    this.#turnUsage.set(turnId, {
      ...turn,
      releasedItems: turn.releasedItems + 1,
      bytes: turn.bytes + bytes,
    });
    this.#runReleasedItems += 1;
    this.#runBytes += bytes;
  }

  #recordDenial(input: {
    readonly turnId: string;
    readonly sourceId: string;
    readonly sourceVersion: number;
    readonly policyProjection: ContextResourceMetadata["policyProjection"] | null;
    readonly safeResourceCategory: string;
    readonly reason: string;
    readonly redactions: readonly SecretCategoryCount[];
    readonly promptInjectionTags: ContextManifestEntry["promptInjectionTags"];
    readonly truncated: boolean;
    readonly error: DomainError;
  }): ContextReleaseResult {
    validateSafeIdentifier(input.sourceId, "denial sourceId");
    validatePositiveSafeInteger(input.sourceVersion, "denial sourceVersion");
    validateSafeIdentifier(input.safeResourceCategory, "safeResourceCategory");
    validateSafeIdentifier(input.reason, "decision reason");
    const manifest: ContextManifestEntry = snapshot({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      ordinal: this.#nextOrdinal(),
      itemId: null,
      runId: this.runId,
      turnId: input.turnId,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      resource: null,
      safeResourceCategory: input.safeResourceCategory,
      selector: null,
      status: "denied" as const,
      deduplicated: false,
      releasedContentHash: null,
      redactions: input.redactions,
      byteLength: 0,
      conservativeTokenEstimate: 0,
      tokenEstimator: "utf8-byte-upper-bound-v1" as const,
      policySnapshotId: this.policySnapshotId,
      releasePolicyId: this.releasePolicy.releasePolicyId,
      releasePolicyVersion: this.releasePolicy.releasePolicyVersion,
      releasePolicyContentHash: this.releasePolicy.contentHash,
      policyCatalogId: input.policyProjection?.catalogId ?? null,
      policyCatalogVersion: input.policyProjection?.catalogVersion ?? null,
      policyCatalogContentHash: input.policyProjection?.catalogContentHash ?? null,
      reason: input.reason,
      promptInjectionTags: input.promptInjectionTags,
      truncated: input.truncated,
    });
    this.#manifestEntries.push(manifest);
    return Object.freeze({ status: "denied", error: input.error, manifest });
  }

  #assertTurnOpen(turnId: string): void {
    if (this.#sealedTurns.has(turnId)) {
      throw createDomainError({
        code: "conflict",
        message: "Context cannot be released after its target turn is sealed.",
      });
    }
  }

  #nextOrdinal(): number {
    this.#ordinal += 1;
    return this.#ordinal;
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#serialTail;
    let unlock!: () => void;
    this.#serialTail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }
}

/** Internal identity check used by the integration boundary; not structural. */
export function isRecognizedContextBroker(
  value: unknown,
): value is ContextBroker {
  return (
    typeof value === "object" &&
    value !== null &&
    !isProxy(value) &&
    RECOGNIZED_CONTEXT_BROKERS.has(value)
  );
}

function validateNormalizedRequest(
  value: unknown,
  source: BrokerContextSource,
  parsed: ParsedSourceRequest,
): NormalizedResourceRequest {
  const detached = snapshotBoundaryObject(
    value,
    "Normalized context request",
    SOURCE_CONTROL_PLANE_LIMITS,
  );
  if (
    !hasExactKeys(detached, [
      "schemaVersion",
      "sourceId",
      "sourceVersion",
      "resource",
      "selector",
    ]) ||
    detached["schemaVersion"] !== CONTRACT_SCHEMA_VERSION ||
    detached["sourceId"] !== parsed.sourceId ||
    detached["sourceVersion"] !== parsed.sourceVersion
  ) {
    throw invalidInput("A source returned an inexact normalized context request.");
  }
  const resource = canonicalizeResourceRef(detached["resource"], {
    scheme: source.descriptor.scheme,
    sourceId: source.descriptor.sourceId,
  });
  return snapshot({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceId: parsed.sourceId,
    sourceVersion: parsed.sourceVersion,
    resource,
    selector: parseNullableJsonObject(detached["selector"], "Context selector"),
  });
}

function validateMetadata(
  value: unknown,
  source: BrokerContextSource | null,
  request: NormalizedResourceRequest | null,
): ContextResourceMetadata {
  const detached = snapshotBoundaryObject(
    value,
    "Context resource metadata",
    SOURCE_CONTROL_PLANE_LIMITS,
  );
  if (
    !hasExactKeys(detached, [
      "schemaVersion",
      "sourceId",
      "sourceVersion",
      "resource",
      "selector",
      "byteLength",
      "selectedByteLength",
      "mediaType",
      "classification",
      "kind",
      "policyProjection",
      "binding",
    ]) ||
    detached["schemaVersion"] !== CONTRACT_SCHEMA_VERSION
  ) {
    throw invalidInput("A source returned malformed resource metadata.");
  }
  const sourceId = detached["sourceId"];
  const sourceVersion = detached["sourceVersion"];
  const byteLength = detached["byteLength"];
  const selectedByteLength = detached["selectedByteLength"];
  const mediaType = detached["mediaType"];
  const classification = detached["classification"];
  const kind = detached["kind"];
  const policyProjection = parsePolicyProjection(detached["policyProjection"]);
  validateSafeIdentifier(sourceId, "metadata sourceId");
  validatePositiveSafeInteger(sourceVersion, "metadata sourceVersion");
  validateNonNegativeSafeInteger(byteLength, "metadata byteLength");
  if (selectedByteLength !== null) {
    validateNonNegativeSafeInteger(selectedByteLength, "metadata selectedByteLength");
    if (selectedByteLength > byteLength) {
      throw invalidInput("Selected resource bytes exceed the resource size.");
    }
  }
  validateSafeIdentifier(classification, "metadata classification");
  if (
    typeof kind !== "string" ||
    !["regular_file", "record", "capability_output"].includes(kind)
  ) {
    throw invalidInput("A resource metadata kind is unsupported.");
  }
  const normalizedMediaType = normalizeMediaType(String(mediaType));
  if (mediaType !== normalizedMediaType) {
    throw invalidInput("A source must return a normalized media type.");
  }
  const resource = canonicalizeResourceRef(detached["resource"], {
    ...(source === null ? {} : { scheme: source.descriptor.scheme }),
    sourceId,
  });
  const selector = parseNullableJsonObject(detached["selector"], "Metadata selector");
  const binding = parseNullableJsonObject(detached["binding"], "Metadata binding");
  if (binding === null) {
    throw invalidInput("Resource metadata requires a source binding.");
  }
  if (
    resource.mediaType !== null &&
    normalizeMediaType(resource.mediaType) !== normalizedMediaType
  ) {
    throw invalidInput("Resource and metadata media types disagree.");
  }
  if (resource.classification !== classification) {
    throw invalidInput("Resource and metadata classifications disagree.");
  }
  if (
    source !== null &&
    (sourceId !== source.descriptor.sourceId ||
      sourceVersion !== source.descriptor.sourceVersion)
  ) {
    throw invalidInput("Resource metadata does not match the pinned source.");
  }
  if (
    request !== null &&
    (!resourceRefsEqual(resource, request.resource) ||
      canonicalize(selector) !== canonicalize(request.selector))
  ) {
    throw invalidInput("Resource metadata does not match the normalized request.");
  }
  return snapshot({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceId,
    sourceVersion,
    resource,
    selector,
    byteLength,
    selectedByteLength,
    mediaType: normalizedMediaType,
    classification,
    kind,
    policyProjection,
    binding,
  }) as ContextResourceMetadata;
}

function validateOpenedResource(
  value: unknown,
  source: BrokerContextSource,
  request: NormalizedResourceRequest,
  metadata: ContextResourceMetadata,
  maximumBytes: number,
): OpenedContextResource {
  const fields = readExactDataProperties(value, [
    "schemaVersion",
    "sourceId",
    "sourceVersion",
    "resource",
    "policyProjection",
    "selector",
    "mediaType",
    "classification",
    "binding",
    "bytes",
    "byteLength",
    "contentHash",
    "selectionComplete",
    "truncated",
  ]);
  if (
    fields["schemaVersion"] !== CONTRACT_SCHEMA_VERSION ||
    fields["sourceId"] !== source.descriptor.sourceId ||
    fields["sourceVersion"] !== source.descriptor.sourceVersion
  ) {
    throw invalidInput("An opened resource does not match the pinned source.");
  }
  const resource = canonicalizeResourceRef(fields["resource"], {
    scheme: source.descriptor.scheme,
    sourceId: source.descriptor.sourceId,
  });
  const policyProjection = parsePolicyProjection(fields["policyProjection"]);
  const selector = parseNullableJsonObject(fields["selector"], "Opened selector");
  const binding = parseNullableJsonObject(fields["binding"], "Opened binding");
  if (binding === null) throw invalidInput("An opened resource requires a binding.");
  const mediaType = normalizeMediaType(String(fields["mediaType"]));
  const classification = fields["classification"];
  const byteLength = fields["byteLength"];
  const contentHash = fields["contentHash"];
  const selectionComplete = fields["selectionComplete"];
  const truncated = fields["truncated"];
  validateSafeIdentifier(classification, "opened classification");
  validateNonNegativeSafeInteger(byteLength, "opened byteLength");
  if (
    typeof contentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(contentHash) ||
    typeof selectionComplete !== "boolean" ||
    typeof truncated !== "boolean" ||
    truncated === selectionComplete
  ) {
    throw invalidInput("An opened resource has malformed hash or truncation evidence.");
  }
  const bytes = copyBoundedBytes(fields["bytes"], maximumBytes);
  if (bytes.byteLength !== byteLength || sha256Hex(bytes) !== contentHash) {
    throw invalidInput("Opened resource bytes do not match their declared evidence.");
  }
  if (
    bytes.byteLength > metadata.byteLength ||
    (metadata.selectedByteLength !== null &&
      (bytes.byteLength > metadata.selectedByteLength ||
        truncated !== (bytes.byteLength < metadata.selectedByteLength)))
  ) {
    throw invalidInput("Opened bytes contradict pre-open size and completeness metadata.");
  }
  if (
    !resourceRefsEqual(resource, request.resource) ||
    !resourceRefsEqual(resource, metadata.resource) ||
    canonicalize(selector) !== canonicalize(request.selector) ||
    canonicalize(selector) !== canonicalize(metadata.selector) ||
    mediaType !== metadata.mediaType ||
    classification !== metadata.classification ||
    canonicalize(binding) !== canonicalize(metadata.binding) ||
    canonicalize(policyProjection) !== canonicalize(metadata.policyProjection)
  ) {
    throw createDomainError({
      code: "conflict",
      message: "The opened resource changed after its metadata decision.",
    });
  }
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceId: source.descriptor.sourceId,
    sourceVersion: source.descriptor.sourceVersion,
    resource,
    policyProjection,
    selector,
    mediaType,
    classification,
    binding,
    bytes,
    byteLength,
    contentHash,
    selectionComplete,
    truncated,
  });
}

function parseSourceReleaseRequest(value: unknown): ParsedSourceRequest {
  const fields = readExactDataProperties(value, [
    "turnId",
    "sourceId",
    "sourceVersion",
    "request",
    "maximumBytes",
    "reason",
    "signal",
  ]);
  validateSafeIdentifier(fields["turnId"], "turnId");
  validateSafeIdentifier(fields["sourceId"], "sourceId");
  validatePositiveSafeInteger(fields["sourceVersion"], "sourceVersion");
  validateNonNegativeSafeInteger(fields["maximumBytes"], "maximumBytes");
  validateSafeIdentifier(fields["reason"], "reason");
  if (!(fields["signal"] instanceof AbortSignal) || isProxy(fields["signal"])) {
    throw invalidInput("A context source release requires a real AbortSignal.");
  }
  return Object.freeze({
    turnId: fields["turnId"],
    sourceId: fields["sourceId"],
    sourceVersion: fields["sourceVersion"],
    rawRequest: fields["request"],
    maximumBytes: fields["maximumBytes"],
    reason: fields["reason"],
    signal: fields["signal"],
  });
}

function parseCapabilityReleaseRequest(
  value: unknown,
): ParsedCapabilityReleaseRequest {
  const fields = readExactDataProperties(value, [
    "turnId",
    "sourceVersion",
    "resource",
    "policyProjection",
    "output",
    "classification",
    "reason",
  ]);
  validateSafeIdentifier(fields["turnId"], "turnId");
  validatePositiveSafeInteger(fields["sourceVersion"], "sourceVersion");
  validateSafeIdentifier(fields["classification"], "classification");
  validateSafeIdentifier(fields["reason"], "reason");
  return Object.freeze({
    turnId: fields["turnId"],
    sourceVersion: fields["sourceVersion"],
    rawResource: fields["resource"],
    rawPolicyProjection: fields["policyProjection"],
    rawOutput: fields["output"],
    classification: fields["classification"],
    reason: fields["reason"],
  });
}

function parseAssemblyRequest(
  value: unknown,
  maximumItems: number,
): AgentContextAssemblyRequest {
  const detached = snapshotBoundaryObject(
    value,
    "Agent context assembly request",
    {
      maximumDepth: 3,
      maximumNodes: maximumItems + 5,
      maximumArrayLength: maximumItems,
      maximumObjectProperties: 3,
      maximumStringUtf8Bytes: 256,
      maximumCanonicalUtf8Bytes: maximumItems * 64 + 1_024,
    },
  );
  if (
    !hasExactKeys(detached, ["turnId", "agentRequestId", "orderedItemIds"])
  ) {
    throw invalidInput("An agent context assembly request is malformed.");
  }
  validateSafeIdentifier(detached["turnId"], "turnId");
  validateSafeIdentifier(detached["agentRequestId"], "agentRequestId");
  if (
    !Array.isArray(detached["orderedItemIds"]) ||
    !detached["orderedItemIds"].every(
      (item) => typeof item === "string" && /^ctx_[a-f0-9]{40}$/u.test(item),
    )
  ) {
    throw invalidInput("Agent context item IDs are malformed.");
  }
  return snapshot({
    turnId: detached["turnId"],
    agentRequestId: detached["agentRequestId"],
    orderedItemIds: detached["orderedItemIds"],
  });
}

function parseMetadataDecision(
  value: unknown,
  policySnapshotId: string,
): ContextMetadataDecision {
  const detached = snapshotBoundaryObject(value, "Context metadata policy decision");
  if (
    !hasExactKeys(detached, [
      "policySnapshotId",
      "effect",
      "reason",
      "safeResourceCategory",
    ]) ||
    detached["policySnapshotId"] !== policySnapshotId ||
    (detached["effect"] !== "allow" && detached["effect"] !== "deny")
  ) {
    throw createDomainError({
      code: "policy_denied",
      message: "Context metadata policy returned an invalid or stale decision.",
    });
  }
  validateSafeIdentifier(detached["reason"], "decision reason");
  validateSafeIdentifier(detached["safeResourceCategory"], "safeResourceCategory");
  return snapshot(detached) as unknown as ContextMetadataDecision;
}

function parseContentDecision(
  value: unknown,
  policySnapshotId: string,
): ContextContentDecision {
  const detached = snapshotBoundaryObject(value, "Context content policy decision");
  if (
    !hasExactKeys(detached, [
      "policySnapshotId",
      "effect",
      "reason",
      "safeResourceCategory",
    ]) ||
    detached["policySnapshotId"] !== policySnapshotId ||
    !["allow", "deny", "redact"].includes(String(detached["effect"]))
  ) {
    throw createDomainError({
      code: "policy_denied",
      message: "Context content policy returned an invalid or stale decision.",
    });
  }
  validateSafeIdentifier(detached["reason"], "decision reason");
  validateSafeIdentifier(detached["safeResourceCategory"], "safeResourceCategory");
  return snapshot(detached) as unknown as ContextContentDecision;
}

function parseBudgets(value: unknown): ContextBudgetLimits {
  const detached = snapshotBoundaryObject(value, "Context budget limits");
  const expected = [
    "maximumResourceBytes",
    "maximumRequestBytes",
    "maximumItemsPerTurn",
    "maximumBytesPerTurn",
    "maximumItemsPerRun",
    "maximumBytesPerRun",
    "maximumControlCharacterRatio",
  ];
  if (!hasExactKeys(detached, expected)) {
    throw invalidInput("Context budget limits contain unknown or missing fields.");
  }
  for (const field of expected.slice(0, 6)) {
    validatePositiveSafeInteger(detached[field], field);
  }
  const ratio = detached["maximumControlCharacterRatio"];
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw invalidInput("maximumControlCharacterRatio must be between zero and one.");
  }
  if (
    (detached["maximumResourceBytes"] as number) >
      MAXIMUM_BROKER_RESOURCE_BYTES ||
    (detached["maximumRequestBytes"] as number) >
      MAXIMUM_BROKER_RESOURCE_BYTES ||
    (detached["maximumBytesPerTurn"] as number) >
      MAXIMUM_BROKER_CUMULATIVE_BYTES ||
    (detached["maximumBytesPerRun"] as number) >
      MAXIMUM_BROKER_CUMULATIVE_BYTES ||
    (detached["maximumItemsPerTurn"] as number) > MAXIMUM_BROKER_ITEMS ||
    (detached["maximumItemsPerRun"] as number) > MAXIMUM_BROKER_ITEMS
  ) {
    throw invalidInput("Context budget limits exceed broker hard ceilings.");
  }
  if (
    (detached["maximumRequestBytes"] as number) >
      (detached["maximumResourceBytes"] as number) ||
    (detached["maximumBytesPerTurn"] as number) >
      (detached["maximumBytesPerRun"] as number) ||
    (detached["maximumItemsPerTurn"] as number) >
      (detached["maximumItemsPerRun"] as number)
  ) {
    throw invalidInput("Context budget hierarchy is inconsistent.");
  }
  return snapshot(detached) as unknown as ContextBudgetLimits;
}

function parseAdditionalMediaTypes(value: unknown): ReadonlySet<string> {
  const detached = snapshotBoundaryObject(
    { value },
    "Reviewed text media types",
  )["value"];
  if (!Array.isArray(detached) || detached.length > 64) {
    throw invalidInput("Reviewed text media types must be a bounded array.");
  }
  const normalized = new Set<string>();
  for (const candidate of detached) {
    if (typeof candidate !== "string") {
      throw invalidInput("A reviewed text media type must be a string.");
    }
    const mediaType = normalizeMediaType(candidate);
    if (normalized.has(mediaType)) {
      throw invalidInput("Reviewed text media types must be unique.");
    }
    normalized.add(mediaType);
  }
  return normalized;
}

function readExactDataProperties(
  value: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value)
    ) {
      throw new TypeError("not a plain record");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string" || !expected.includes(key))
    ) {
      throw new TypeError("unknown or missing property");
    }
    const result: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("accessor or hidden property");
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw invalidInput("A context boundary object is malformed.");
  }
}

function readOptionsDataProperties(
  value: unknown,
): Readonly<{
  runId: string;
  policySnapshotId: string;
  releasePolicy: unknown;
  sources: BrokerContextSourceRegistry;
  policy: unknown;
  budgets: unknown;
  customSecretClassifiers?: unknown;
  additionalReviewedTextMediaTypes?: unknown;
}> {
  const required = [
    "runId",
    "policySnapshotId",
    "releasePolicy",
    "sources",
    "policy",
    "budgets",
  ];
  const optional = [
    "customSecretClassifiers",
    "additionalReviewedTextMediaTypes",
  ];
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new TypeError("not plain options");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (!required.includes(key) && !optional.includes(key)),
      ) ||
      required.some((key) => !keys.includes(key))
    ) {
      throw new TypeError("unknown or missing option");
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("option accessor or hidden property");
      }
      result[key] = descriptor.value;
    }
    return result as unknown as Readonly<{
      runId: string;
      policySnapshotId: string;
      releasePolicy: unknown;
      sources: BrokerContextSourceRegistry;
      policy: unknown;
      budgets: unknown;
      customSecretClassifiers?: unknown;
      additionalReviewedTextMediaTypes?: unknown;
    }>;
  } catch {
    throw invalidInput(
      "Context broker options contain unknown, missing, accessor, or unsafe properties.",
    );
  }
}

function copyBoundedBytes(value: unknown, maximumBytes: number): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || isProxy(value)) {
      throw new TypeError("not bytes");
    }
    if (value.byteLength > maximumBytes) {
      throw budgetExceeded("A source returned more bytes than its read budget.");
    }
    return Uint8Array.from(value);
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw invalidInput("A source returned malformed context bytes.");
  }
}

function parseNullableJsonObject(value: unknown, label: string): JsonObject | null {
  if (value === null) return null;
  return snapshotBoundaryObject(value, label);
}

function parsePolicyProjection(value: unknown, maximumBytes = 64 * 1024) {
  const boundedMaximum = Math.max(1, Math.min(64 * 1024, maximumBytes));
  const detached = snapshotBoundaryObject(value, "Context policy projection", {
    maximumDepth: 16,
    maximumNodes: Math.min(4_096, boundedMaximum),
    maximumArrayLength: Math.min(1_024, boundedMaximum),
    maximumObjectProperties: Math.min(1_024, boundedMaximum),
    maximumStringUtf8Bytes: boundedMaximum,
    maximumCanonicalUtf8Bytes: boundedMaximum,
  });
  if (
    !hasExactKeys(detached, [
      "schemaVersion",
      "catalogId",
      "catalogVersion",
      "catalogContentHash",
      "resourceAttributes",
      "requestAttributes",
    ]) ||
    detached["schemaVersion"] !== CONTRACT_SCHEMA_VERSION
  ) {
    throw invalidInput("A context policy projection is malformed.");
  }
  validateSafeIdentifier(detached["catalogId"], "policy projection catalogId");
  if (
    detached["catalogId"] === "guard.base" ||
    detached["catalogId"] === "guard.context"
  ) {
    throw invalidInput("A source cannot claim a broker-owned policy catalog.");
  }
  validatePositiveSafeInteger(
    detached["catalogVersion"],
    "policy projection catalogVersion",
  );
  const contentHash = detached["catalogContentHash"];
  if (typeof contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw invalidInput("A context policy projection content hash is malformed.");
  }
  const resourceAttributes = parseNullableJsonObject(
    detached["resourceAttributes"],
    "Context policy resource attributes",
  );
  const requestAttributes = parseNullableJsonObject(
    detached["requestAttributes"],
    "Context policy request attributes",
  );
  if (resourceAttributes === null || requestAttributes === null) {
    throw invalidInput("Context policy projection attributes must be objects.");
  }
  return snapshot({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    catalogId: detached["catalogId"],
    catalogVersion: detached["catalogVersion"],
    catalogContentHash: contentHash,
    resourceAttributes,
    requestAttributes,
  });
}

function parseCapabilityReleaseRequestValue(value: unknown): JsonValue {
  return snapshotBoundaryObject({ value }, "Capability output wrapper")["value"]!;
}

function parseAssemblyId(value: unknown, label: string): string {
  validateSafeIdentifier(value, label);
  return value;
}

async function callSource<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw createDomainError({
      code: "infrastructure_failed",
      message: "A context source failed without exposing unsafe details.",
    });
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createDomainError({ code: "cancelled", message: "The context read was cancelled." });
  }
}

function validateSafeIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw invalidInput(`${field} must be a canonical safe identifier.`);
  }
}

function validatePositiveSafeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidInput(`${field} must be a positive safe integer.`);
  }
}

function validateNonNegativeSafeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${field} must be a non-negative safe integer.`);
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isPlainObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function budgetExceeded(message: string) {
  return createDomainError({ code: "budget_exceeded", message });
}

function policyDenied(message: string) {
  return createDomainError({ code: "policy_denied", message });
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
