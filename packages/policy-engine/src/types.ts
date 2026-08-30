import type {
  JsonObject,
  NormalizedAction,
  PolicyVersionId,
} from "@guard/contracts";
import type {
  Expression,
  GuardDocument,
  PolicyEffect,
  PolicyRule,
  SourceSpan,
} from "@guard/policy-language";

export type { PolicyEffect } from "@guard/policy-language";

export type TruthValue = "true" | "false" | "unknown";
export type PolicyAttributeType =
  | "string"
  | "boolean"
  | "integer"
  | "list<string>";

export interface PolicyAttributeDefinition {
  readonly name: string;
  readonly type: PolicyAttributeType;
  readonly optional: boolean;
  readonly secretClassification: string | null;
  readonly matchKind: "none" | "canonical_path";
  readonly source: PolicyAttributeSource;
}

export type PolicyAttributeSource =
  | {
      readonly kind: "intrinsic";
      readonly field: "capabilityPackId" | "operationId" | "sideEffectClass";
    }
  | {
      readonly kind: "object_field";
      readonly section: "subject" | "resource" | "request" | "environment";
      readonly field: string;
    };

export interface PolicyAttributeCatalog {
  readonly catalogId: string;
  readonly schemaVersion: number;
  readonly contentHash: string;
  readonly attributes: readonly PolicyAttributeDefinition[];
}

export interface PolicyAttributeCatalogSet {
  readonly manifest: readonly {
    readonly catalogId: string;
    readonly schemaVersion: number;
    readonly contentHash: string;
  }[];
  readonly attributes: readonly PolicyAttributeDefinition[];
}

export interface PolicyCompileDiagnostic {
  readonly severity: "error";
  readonly phase: "lexer" | "parser" | "typecheck" | "compile";
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

export interface PolicySnapshotCompileInput {
  readonly policyVersionId: string;
  readonly source: string;
  readonly sourceId: string;
  readonly defaultEffect: PolicyEffect;
}

export interface PolicySourceFile {
  readonly sourceId: string;
  readonly source: string;
}

export interface PolicySnapshotSetCompileInput {
  readonly policyVersionId: string;
  readonly sources: readonly PolicySourceFile[];
  readonly defaultEffect: PolicyEffect;
}

export interface PolicySnapshotCompileOptions {
  readonly maximumSourceBytes?: number;
  readonly maximumPolicies?: number;
  readonly maximumSources?: number;
  readonly maximumTotalSourceBytes?: number;
  readonly maximumTotalPolicies?: number;
  readonly maximumDiagnostics?: number;
  readonly maximumGlobBytes?: number;
  readonly maximumGlobSegments?: number;
  readonly maximumGlobWildcards?: number;
}

export interface CompiledGlob {
  readonly source: string;
  readonly segments: readonly CompiledGlobSegment[];
}

export interface CompiledGlobSegment {
  readonly recursive: boolean;
  readonly atoms: readonly CompiledGlobAtom[];
}

export type CompiledGlobAtom =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "star" }
  | { readonly kind: "single" };

export interface CompiledComparison {
  readonly expression: Extract<Expression, { readonly kind: "comparison" }>;
  readonly attribute: PolicyAttributeDefinition;
  readonly glob: CompiledGlob | null;
}

export interface CompiledPolicyRule {
  readonly rule: PolicyRule;
  readonly comparisons: readonly CompiledComparison[];
}

export interface PolicySnapshot {
  readonly policyVersionId: PolicyVersionId;
  readonly languageVersion: "1";
  readonly attributeCatalogs: PolicyAttributeCatalogSet;
  readonly sources: readonly {
    readonly sourceId: string;
    readonly canonicalText: string;
  }[];
  readonly canonicalText: string;
  readonly contentHash: string;
  readonly defaultEffect: PolicyEffect;
  readonly documents: readonly GuardDocument[];
  readonly policies: readonly CompiledPolicyRule[];
}

export type PolicySnapshotCompileResult =
  | {
      readonly ok: true;
      readonly snapshot: PolicySnapshot;
      readonly diagnostics: readonly [];
    }
  | {
      readonly ok: false;
      readonly snapshot: null;
      readonly diagnostics: readonly PolicyCompileDiagnostic[];
    };

export type PolicyAttributeValue = string | boolean | number | readonly string[];

export interface PolicyAttributeEnvironment {
  readonly catalogManifest: PolicyAttributeCatalogSet["manifest"];
  readonly values: Readonly<Record<string, PolicyAttributeValue>>;
}

export interface PolicyEvaluationOptions {
  /** Random, unguessable, and scoped to one run. */
  readonly secretCorrelationToken: string;
}

export interface PolicyDecision {
  readonly policyVersionId: PolicyVersionId;
  readonly effect: PolicyEffect;
  readonly winningPolicyName: string | null;
  readonly reason: string;
  readonly matchedPolicyNames: readonly string[];
  readonly trace: JsonObject;
}

export interface PinnedPolicyEvaluator {
  readonly policyVersionId: PolicyVersionId;
  evaluate(action: NormalizedAction): PolicyDecision;
}

export interface PolicyTestCase {
  readonly name: string;
  readonly action: NormalizedAction;
  readonly expectedEffect: PolicyEffect;
  readonly expectedWinningPolicyName?: string | null;
  readonly expectedReason?: string;
  readonly expectedTraceHash?: string;
}

export interface PolicyTestCaseResult {
  readonly name: string;
  readonly passed: boolean;
  readonly expectedEffect: PolicyEffect;
  readonly actualEffect: PolicyEffect | null;
  readonly expectedWinningPolicyName: string | null | undefined;
  readonly actualWinningPolicyName: string | null;
  readonly errorCode: string | null;
}

export interface PolicyCaseCorpus {
  readonly schemaVersion: 1;
  readonly policyContentHash: string;
  readonly cases: readonly PolicyTestCase[];
}

export interface PolicyTestRun {
  readonly passed: number;
  readonly failed: number;
  readonly cases: readonly PolicyTestCaseResult[];
}

export type PolicySimulationCategory =
  | "newly_allowed"
  | "newly_denied"
  | "newly_approval_gated"
  | "approval_removed"
  | "same_effect_different_explanation"
  | "unchanged"
  | "evaluation_error";

export interface PolicySimulationEntry {
  readonly actionId: string;
  readonly category: PolicySimulationCategory;
  readonly fromEffect: PolicyEffect | null;
  readonly toEffect: PolicyEffect | null;
  readonly fromWinningPolicyName: string | null;
  readonly toWinningPolicyName: string | null;
  readonly errorCode: string | null;
}

export interface PolicySimulationPage {
  readonly entries: readonly PolicySimulationEntry[];
  readonly counts: Readonly<Record<PolicySimulationCategory, number>>;
  readonly nextCursor: string | null;
}

export interface PolicySnapshotStore {
  install(snapshot: PolicySnapshot): void;
  get(policyVersionId: string): PolicySnapshot;
  pinRun(runId: string, policyVersionId: string): PolicySnapshot;
  resolveRun(runId: string): PolicySnapshot;
  migrateRun(runId: string, policyVersionId: string): PolicySnapshot;
}
