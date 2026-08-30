import { isProxy } from "node:util/types";

import {
  ActionIdKind,
  CONTRACT_SCHEMA_VERSION,
  PolicyVersionIdKind,
  canonicalSha256Hex,
  canonicalize,
  createDomainError,
  sha256Hex,
} from "@guard/contracts";
import type {
  JsonObject,
  NormalizedAction,
  PolicyVersionId,
  ResourceRef,
} from "@guard/contracts";
import type { PinnedPolicyEvaluator, PolicyDecision } from "@guard/policy-engine";

import type {
  ContextContentDecision,
  ContextContentPolicyInput,
  ContextMetadataDecision,
  ContextMetadataPolicyInput,
  ContextPolicyProjection,
  ContextPolicyHooks,
  ContextReleasePolicySnapshot,
} from "./context-boundary.js";
import { snapshot, snapshotBoundaryObject } from "./immutable.js";
import { CONTEXT_POLICY_ATTRIBUTE_CATALOG } from "./policy-catalog.js";

export interface ContextReleasePolicyInput {
  readonly releasePolicyId: string;
  readonly releasePolicyVersion: number;
  readonly secretDisposition: "allow" | "deny" | "redact";
  readonly promptInjectionDisposition: "tag" | "deny";
  readonly truncatedDisposition: "allow" | "deny";
}

export interface PinnedContextPolicyAdapterOptions {
  readonly evaluator: PinnedPolicyEvaluator;
  readonly releasePolicy: ContextReleasePolicySnapshot;
}

const RECOGNIZED_RELEASE_POLICIES = new WeakSet<object>();
const RECOGNIZED_CONTEXT_POLICIES = new WeakSet<object>();

export function createContextReleasePolicySnapshot(
  input: ContextReleasePolicyInput,
): ContextReleasePolicySnapshot {
  const detached = snapshotBoundaryObject(input, "Context release policy");
  if (
    !hasExactKeys(detached, [
      "releasePolicyId",
      "releasePolicyVersion",
      "secretDisposition",
      "promptInjectionDisposition",
      "truncatedDisposition",
    ])
  ) {
    throw invalidInput("A context release policy contains unknown or missing fields.");
  }
  const releasePolicyId = safeIdentifier(
    detached["releasePolicyId"],
    "releasePolicyId",
  );
  const releasePolicyVersion = positiveInteger(
    detached["releasePolicyVersion"],
    "releasePolicyVersion",
  );
  const secretDisposition = detached["secretDisposition"];
  const promptInjectionDisposition = detached["promptInjectionDisposition"];
  const truncatedDisposition = detached["truncatedDisposition"];
  if (!isSecretDisposition(secretDisposition)) {
    throw invalidInput("A release policy secret disposition is unsupported.");
  }
  if (
    promptInjectionDisposition !== "tag" &&
    promptInjectionDisposition !== "deny"
  ) {
    throw invalidInput("A release policy prompt-injection disposition is unsupported.");
  }
  if (truncatedDisposition !== "allow" && truncatedDisposition !== "deny") {
    throw invalidInput("A release policy truncated-content disposition is unsupported.");
  }
  const canonical = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    releasePolicyId,
    releasePolicyVersion,
    secretDisposition,
    promptInjectionDisposition,
    truncatedDisposition,
  } as const;
  const snapshot: ContextReleasePolicySnapshot = Object.freeze({
    ...canonical,
    contentHash: canonicalSha256Hex(canonical),
  });
  RECOGNIZED_RELEASE_POLICIES.add(snapshot);
  return snapshot;
}

/**
 * Adapts the generic immutable policy evaluator to two context decisions.
 * Redaction is applied only after `.guard` returns allow; it is governed by a
 * separately versioned immutable release-policy snapshot.
 */
export function createPinnedContextPolicyAdapter(
  options: PinnedContextPolicyAdapterOptions,
): ContextPolicyHooks {
  const fields = readExactDataProperties(options, ["evaluator", "releasePolicy"]);
  const evaluator = captureEvaluator(fields["evaluator"]);
  const releasePolicy = fields["releasePolicy"];
  if (
    typeof releasePolicy !== "object" ||
    releasePolicy === null ||
    !RECOGNIZED_RELEASE_POLICIES.has(releasePolicy)
  ) {
    throw invalidInput("A pinned context adapter requires a recognized release policy.");
  }
  const pinnedReleasePolicy = releasePolicy as ContextReleasePolicySnapshot;
  const policySnapshotId = evaluator.policyVersionId;

  const adapter: ContextPolicyHooks = Object.freeze({
    policySnapshotId,
    releasePolicy: pinnedReleasePolicy,
    decideMetadata(input: ContextMetadataPolicyInput): ContextMetadataDecision {
      assertPolicyInput(input.policySnapshotId, policySnapshotId);
      const decision = evaluateExact(
        evaluator,
        metadataAction(input, pinnedReleasePolicy),
      );
      const effect = decision.effect === "allow" ? "allow" : "deny";
      return snapshot({
        policySnapshotId,
        effect,
        reason: decisionReason("metadata", decision.effect),
        safeResourceCategory: "context_resource",
      });
    },
    decideContent(input: ContextContentPolicyInput): ContextContentDecision {
      assertPolicyInput(input.policySnapshotId, policySnapshotId);
      const decision = evaluateExact(
        evaluator,
        contentAction(input, pinnedReleasePolicy),
      );
      if (decision.effect !== "allow") {
        return snapshot({
          policySnapshotId,
          effect: "deny" as const,
          reason: decisionReason("content", decision.effect),
          safeResourceCategory: "context_resource",
        });
      }
      if (
        input.promptInjectionTags.length > 0 &&
        pinnedReleasePolicy.promptInjectionDisposition === "deny"
      ) {
        return snapshot({
          policySnapshotId,
          effect: "deny" as const,
          reason: "context.release.injection_denied",
          safeResourceCategory: "context_resource",
        });
      }
      if (input.truncated && pinnedReleasePolicy.truncatedDisposition === "deny") {
        return snapshot({
          policySnapshotId,
          effect: "deny" as const,
          reason: "context.release.truncated_denied",
          safeResourceCategory: "context_resource",
        });
      }
      const hasSecrets = input.secretCategories.length > 0;
      const effect: ContextContentDecision["effect"] = hasSecrets
        ? pinnedReleasePolicy.secretDisposition
        : "allow";
      return snapshot({
        policySnapshotId,
        effect,
        reason:
          effect === "redact"
            ? "context.release.secret_redacted"
            : effect === "deny"
              ? "context.release.secret_denied"
              : "context.release.allowed",
        safeResourceCategory: "context_resource",
      });
    },
  });
  RECOGNIZED_CONTEXT_POLICIES.add(adapter);
  return adapter;
}

/** Captures only a recognized factory-created adapter and checks both pins. */
export function capturePinnedContextPolicyAdapter(
  value: unknown,
  expectedPolicyVersionId: PolicyVersionId,
  expectedReleasePolicy: ContextReleasePolicySnapshot,
): ContextPolicyHooks {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    !RECOGNIZED_CONTEXT_POLICIES.has(value) ||
    !RECOGNIZED_RELEASE_POLICIES.has(expectedReleasePolicy)
  ) {
    throw invalidInput("Context policy must be a recognized pinned adapter.");
  }
  const adapter = value as ContextPolicyHooks;
  if (
    adapter.policySnapshotId !== expectedPolicyVersionId ||
    adapter.releasePolicy !== expectedReleasePolicy ||
    adapter.releasePolicy.releasePolicyId !== expectedReleasePolicy.releasePolicyId ||
    adapter.releasePolicy.releasePolicyVersion !==
      expectedReleasePolicy.releasePolicyVersion ||
    adapter.releasePolicy.contentHash !== expectedReleasePolicy.contentHash
  ) {
    throw createDomainError({
      code: "policy_denied",
      message: "Context policy or release-policy pin does not match the task profile.",
    });
  }
  return adapter;
}

function metadataAction(
  input: ContextMetadataPolicyInput,
  releasePolicy: ContextReleasePolicySnapshot,
): NormalizedAction {
  const resource = policyResource(input.metadata.resource, {
    kind: input.metadata.kind,
    mediaType: input.metadata.mediaType,
  }, input.metadata.policyProjection);
  const request = mergeProjectedAttributes({
    intent: "context.read",
    reason: input.reason,
    turnId: input.turnId,
    resourceBytes: input.metadata.byteLength,
    selectedBytes: input.metadata.selectedByteLength,
  }, input.metadata.policyProjection.requestAttributes, "request");
  return policyAction(
    "context.read",
    input.runId,
    resource,
    request,
    releasePolicy,
    input.metadata.policyProjection,
  );
}

function contentAction(
  input: ContextContentPolicyInput,
  releasePolicy: ContextReleasePolicySnapshot,
): NormalizedAction {
  const resource = policyResource(input.resource, {
    kind: "content",
    mediaType: input.mediaType,
  }, input.policyProjection);
  const request = mergeProjectedAttributes({
    intent: "context.release",
    reason: input.reason,
    turnId: input.turnId,
    sourceBytes: input.sourceByteLength,
    truncated: input.truncated,
    secretCategories: input.secretCategories.map((item) => item.category),
    promptInjectionTags: input.promptInjectionTags,
  }, input.policyProjection.requestAttributes, "request");
  return policyAction(
    "context.release",
    input.runId,
    resource,
    request,
    releasePolicy,
    input.policyProjection,
  );
}

function policyAction(
  operationId: "context.read" | "context.release",
  runId: string,
  resource: JsonObject,
  request: JsonObject,
  releasePolicy: ContextReleasePolicySnapshot,
  projection: ContextPolicyProjection,
): NormalizedAction {
  const normalizedInput: JsonObject = { resource, request };
  const fingerprint = canonicalize({ operationId, runId, resource, request });
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    actionId: deterministicActionId(fingerprint),
    capabilityPackId: "guard.context",
    capabilityPackVersion: 1,
    operationId,
    operationVersion: 1,
    subject: { kind: "runtime", driverId: "context-broker" },
    resource,
    environment: {
      profileId: "guard.context",
      sandboxed: true,
      networkProfile: "disabled",
      trustLevel: "untrusted",
    },
    request,
    normalizedInput,
    sideEffectClass: "none",
    preconditions: Object.freeze([
      Object.freeze({
        preconditionType: "context.release-policy",
        preconditionVersion: 1,
        attributes: {
          releasePolicyId: releasePolicy.releasePolicyId,
          releasePolicyVersion: releasePolicy.releasePolicyVersion,
          contentHash: releasePolicy.contentHash,
        },
      }),
      Object.freeze({
        preconditionType: "context.policy-catalog",
        preconditionVersion: 1,
        attributes: {
          catalogId: projection.catalogId,
          catalogVersion: projection.catalogVersion,
          contentHash: projection.catalogContentHash,
        },
      }),
    ]),
  });
}

function policyResource(
  resource: ResourceRef,
  extra: { readonly kind: string; readonly mediaType: string },
  projection: ContextPolicyProjection,
): JsonObject {
  return mergeProjectedAttributes({
    scheme: resource.scheme,
    sourceId: resource.sourceId,
    classification: resource.classification,
    mediaType: extra.mediaType,
    kind: extra.kind,
  }, projection.resourceAttributes, "resource");
}

function mergeProjectedAttributes(
  generic: JsonObject,
  projected: JsonObject,
  section: string,
): JsonObject {
  const result: Record<string, JsonObject[string]> = { ...generic };
  for (const [key, value] of Object.entries(projected)) {
    if (Object.hasOwn(result, key)) {
      throw createDomainError({
        code: "policy_denied",
        message: `A source policy projection conflicts with a generic ${section} attribute.`,
      });
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function captureEvaluator(value: unknown): {
  readonly policyVersionId: PolicyVersionId;
  readonly evaluate: PinnedPolicyEvaluator["evaluate"];
} {
  const fields = readExactDataProperties(value, ["policyVersionId", "evaluate"]);
  if (typeof fields["policyVersionId"] !== "string") {
    throw invalidInput("A pinned evaluator policy ID is malformed.");
  }
  const policyVersionId = PolicyVersionIdKind.parse(fields["policyVersionId"]);
  if (typeof fields["evaluate"] !== "function" || isProxy(fields["evaluate"])) {
    throw invalidInput("A pinned evaluator requires a direct evaluate function.");
  }
  return Object.freeze({
    policyVersionId,
    evaluate: (fields["evaluate"] as PinnedPolicyEvaluator["evaluate"]).bind(value),
  });
}

function evaluateExact(
  evaluator: ReturnType<typeof captureEvaluator>,
  action: NormalizedAction,
): PolicyDecision {
  const decision = parsePolicyDecision(evaluator.evaluate(action));
  if (decision.policyVersionId !== evaluator.policyVersionId) {
    throw createDomainError({
      code: "policy_denied",
      message: "The pinned policy evaluator returned a stale decision.",
    });
  }
  assertCatalogEvidence(action, decision.trace);
  return decision;
}

function parsePolicyDecision(input: unknown): PolicyDecision {
  const value = snapshotBoundaryObject(input, "Context policy decision");
  if (
    !hasExactKeys(value, [
      "policyVersionId",
      "effect",
      "winningPolicyName",
      "reason",
      "matchedPolicyNames",
      "trace",
    ]) ||
    typeof value["policyVersionId"] !== "string" ||
    !PolicyVersionIdKind.is(value["policyVersionId"]) ||
    !["allow", "deny", "require_approval"].includes(String(value["effect"])) ||
    !(
      value["winningPolicyName"] === null ||
      (typeof value["winningPolicyName"] === "string" &&
        value["winningPolicyName"].trim().length > 0)
    ) ||
    typeof value["reason"] !== "string" ||
    value["reason"].trim().length === 0 ||
    !Array.isArray(value["matchedPolicyNames"]) ||
    !value["matchedPolicyNames"].every(
      (item) => typeof item === "string" && item.trim().length > 0,
    ) ||
    new Set(value["matchedPolicyNames"]).size !==
      value["matchedPolicyNames"].length ||
    !isJsonObject(value["trace"])
  ) {
    throw createDomainError({
      code: "policy_denied",
      message: "The pinned policy evaluator returned a malformed decision.",
    });
  }
  const matchedPolicyNames = value["matchedPolicyNames"];
  if (
    (value["winningPolicyName"] === null) !==
      (matchedPolicyNames.length === 0) ||
    (value["winningPolicyName"] !== null &&
      matchedPolicyNames[0] !== value["winningPolicyName"])
  ) {
    throw createDomainError({
      code: "policy_denied",
      message: "The pinned policy evaluator returned inconsistent policy evidence.",
    });
  }
  return Object.freeze({
    policyVersionId: value["policyVersionId"],
    effect: value["effect"],
    winningPolicyName: value["winningPolicyName"],
    reason: value["reason"],
    matchedPolicyNames: Object.freeze([...matchedPolicyNames]),
    trace: value["trace"],
  }) as PolicyDecision;
}

function assertCatalogEvidence(action: NormalizedAction, trace: JsonObject): void {
  const projectionPrecondition = action.preconditions.find(
    (item) => item.preconditionType === "context.policy-catalog",
  );
  const rawManifest = trace["attributeCatalogs"];
  if (
    projectionPrecondition === undefined ||
    !Array.isArray(rawManifest) ||
    !rawManifest.every(isCatalogManifestEntry)
  ) {
    throw createDomainError({
      code: "policy_denied",
      message: "The pinned policy decision lacks catalog evidence.",
    });
  }
  const expectedSource = {
    catalogId: projectionPrecondition.attributes["catalogId"],
    schemaVersion: projectionPrecondition.attributes["catalogVersion"],
    contentHash: projectionPrecondition.attributes["contentHash"],
  };
  const expectedContext = {
    catalogId: CONTEXT_POLICY_ATTRIBUTE_CATALOG.catalogId,
    schemaVersion: CONTEXT_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
    contentHash: CONTEXT_POLICY_ATTRIBUTE_CATALOG.contentHash,
  };
  for (const expected of [expectedContext, expectedSource]) {
    if (
      rawManifest.filter(
        (entry) => canonicalize(entry) === canonicalize(expected),
      ).length !== 1
    ) {
      throw createDomainError({
        code: "policy_denied",
        message: "The pinned policy snapshot does not contain the required catalog.",
      });
    }
  }
}

function isCatalogManifestEntry(value: unknown): value is JsonObject {
  return (
    isJsonObject(value) &&
    hasExactKeys(value, ["catalogId", "schemaVersion", "contentHash"]) &&
    typeof value["catalogId"] === "string" &&
    Number.isSafeInteger(value["schemaVersion"]) &&
    (value["schemaVersion"] as number) > 0 &&
    typeof value["contentHash"] === "string" &&
    /^[a-f0-9]{64}$/u.test(value["contentHash"])
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deterministicActionId(fingerprint: string) {
  const hex = sha256Hex(fingerprint).slice(0, 32).split("");
  hex[12] = "7";
  hex[16] = "8";
  const value = `${hex.slice(0, 8).join("")}-${hex
    .slice(8, 12)
    .join("")}-${hex.slice(12, 16).join("")}-${hex
    .slice(16, 20)
    .join("")}-${hex.slice(20, 32).join("")}`;
  return ActionIdKind.parse(`act_${value}`);
}

function decisionReason(
  stage: "metadata" | "content",
  effect: PolicyDecision["effect"],
): string {
  if (effect === "allow") return `context.policy.${stage}_allowed`;
  if (effect === "require_approval") {
    return `context.policy.${stage}_approval_required`;
  }
  return `context.policy.${stage}_denied`;
}

function assertPolicyInput(
  actual: PolicyVersionId,
  expected: PolicyVersionId,
): void {
  if (actual !== expected) {
    throw createDomainError({
      code: "policy_denied",
      message: "A context decision requested a stale policy snapshot.",
    });
  }
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
      throw new TypeError("not an object");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string" || !expected.includes(key))
    ) {
      throw new TypeError("unknown or missing field");
    }
    const result: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("accessor or hidden field");
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw invalidInput("A pinned context-policy boundary object is malformed.");
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function safeIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw invalidInput(`${field} must be a canonical safe identifier.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidInput(`${field} must be a positive safe integer.`);
  }
  return value;
}

function isSecretDisposition(
  value: unknown,
): value is ContextReleasePolicySnapshot["secretDisposition"] {
  return value === "allow" || value === "deny" || value === "redact";
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
