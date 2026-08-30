import {
  PolicyVersionIdKind,
  canonicalSha256Hex,
  snapshotBoundaryJsonObject,
} from "@guard/contracts";
import type { JsonObject } from "@guard/contracts";
import {
  GUARD_LANGUAGE_VERSION,
  formatGuardDocument,
  parseGuardDocument,
} from "@guard/policy-language";
import type {
  ComparisonExpression,
  Expression,
  GuardDiagnostic,
  PolicyValue,
  SourceSpan,
} from "@guard/policy-language";

import {
  BASE_POLICY_ATTRIBUTE_CATALOG_SET,
  assertRecognizedCatalogSet,
  policyAttributeDefinition,
} from "./catalog.js";
import {
  DEFAULT_GLOB_LIMITS,
  GlobSyntaxError,
  compileAnchoredPathGlob,
} from "./glob.js";
import type {
  CompiledComparison,
  CompiledPolicyRule,
  PolicyAttributeDefinition,
  PolicyAttributeCatalogSet,
  PolicyAttributeType,
  PolicyCompileDiagnostic,
  PolicySnapshot,
  PolicySnapshotCompileInput,
  PolicySnapshotCompileOptions,
  PolicySnapshotCompileResult,
  PolicySnapshotSetCompileInput,
} from "./types.js";
import { compareUtf8 } from "./stable-order.js";

interface CompileLimits {
  readonly maximumSourceBytes: number;
  readonly maximumPolicies: number;
  readonly maximumSources: number;
  readonly maximumTotalSourceBytes: number;
  readonly maximumTotalPolicies: number;
  readonly maximumDiagnostics: number;
  readonly maximumGlobBytes: number;
  readonly maximumGlobSegments: number;
  readonly maximumGlobWildcards: number;
}

const DEFAULT_COMPILE_LIMITS: CompileLimits = Object.freeze({
  maximumSourceBytes: 1024 * 1024,
  maximumPolicies: 1024,
  maximumSources: 64,
  maximumTotalSourceBytes: 4 * 1024 * 1024,
  maximumTotalPolicies: 4096,
  maximumDiagnostics: 256,
  maximumGlobBytes: DEFAULT_GLOB_LIMITS.maximumBytes,
  maximumGlobSegments: DEFAULT_GLOB_LIMITS.maximumSegments,
  maximumGlobWildcards: DEFAULT_GLOB_LIMITS.maximumWildcards,
});

const COMPILED_SNAPSHOTS = new WeakSet<object>();

export function compilePolicySnapshot(
  input: PolicySnapshotCompileInput,
  options: PolicySnapshotCompileOptions = {},
  catalogs: PolicyAttributeCatalogSet = BASE_POLICY_ATTRIBUTE_CATALOG_SET,
): PolicySnapshotCompileResult {
  assertRecognizedCatalogSet(catalogs);
  const detached = snapshotBoundaryJsonObject(input);
  const expectedKeys = ["policyVersionId", "source", "sourceId", "defaultEffect"];
  if (!hasExactKeys(detached, expectedKeys)) {
    throw new TypeError("Policy snapshot input has unknown or missing properties.");
  }
  const policyVersionIdValue = detached["policyVersionId"];
  const sourceValue = detached["source"];
  const sourceIdValue = detached["sourceId"];
  const defaultEffectValue = detached["defaultEffect"];
  if (
    typeof policyVersionIdValue !== "string" ||
    typeof sourceValue !== "string" ||
    typeof sourceIdValue !== "string" ||
    sourceIdValue.trim().length === 0 ||
    !isEffect(defaultEffectValue)
  ) {
    throw new TypeError("Policy snapshot input has an invalid field.");
  }
  const policyVersionId = PolicyVersionIdKind.parse(policyVersionIdValue);
  const limits = normalizeLimits(options);
  // Parse the original bytes so diagnostics point at the user's actual file.
  // Canonical formatting below performs the line-ending normalization used by
  // snapshot hashing.
  const source = sourceValue;
  if (new TextEncoder().encode(source).byteLength > limits.maximumSourceBytes) {
    const span = zeroSpan(sourceIdValue);
    return failure([
      diagnostic(
        "compile",
        "policy_source_too_large",
        "The policy source exceeds its configured byte limit.",
        span,
      ),
    ]);
  }

  const parsed = parseGuardDocument(source, { sourceId: sourceIdValue });
  const diagnostics: PolicyCompileDiagnostic[] = parsed.diagnostics.map(
    fromLanguageDiagnostic,
  );
  if (parsed.document.policies.length > limits.maximumPolicies) {
    diagnostics.push(
      diagnostic(
        "compile",
        "too_many_policies",
        "The policy document exceeds its configured rule limit.",
        parsed.document.span,
      ),
    );
  }

  const names = new Set<string>();
  const policies: CompiledPolicyRule[] = [];
  for (const rule of parsed.document.policies) {
    if (names.has(rule.name.value)) {
      diagnostics.push(
        diagnostic(
          "typecheck",
          "duplicate_policy_name",
          "A policy name may appear only once in a snapshot.",
          rule.name.span,
        ),
      );
    }
    names.add(rule.name.value);
    if (rule.name.value.trim().length === 0) {
      diagnostics.push(
        diagnostic(
          "typecheck",
          "empty_policy_name",
          "A policy name cannot be empty.",
          rule.name.span,
        ),
      );
    }
    if (rule.reason.value.trim().length === 0) {
      diagnostics.push(
        diagnostic(
          "typecheck",
          "empty_policy_reason",
          "Every policy effect requires a non-empty reason.",
          rule.reason.span,
        ),
      );
    }
    const comparisons: CompiledComparison[] = [];
    checkExpression(rule.condition, comparisons, diagnostics, limits, catalogs);
    policies.push(
      Object.freeze({
        rule,
        comparisons: Object.freeze(comparisons),
      }),
    );
  }

  if (diagnostics.length > 0 || !parsed.ok) {
    diagnostics.sort(compareDiagnostics);
    return failure(
      boundDiagnostics(diagnostics, limits.maximumDiagnostics, parsed.document.span),
    );
  }

  const canonicalText = formatGuardDocument(parsed.document);
  const canonicalSources = Object.freeze([
    Object.freeze({ sourceId: sourceIdValue, canonicalText }),
  ]);
  const contentHash = canonicalSha256Hex({
    languageVersion: GUARD_LANGUAGE_VERSION,
    attributeCatalogs: catalogs.manifest,
    defaultEffect: defaultEffectValue,
    sources: canonicalSources,
  });
  const snapshot: PolicySnapshot = Object.freeze({
    policyVersionId,
    languageVersion: GUARD_LANGUAGE_VERSION,
    attributeCatalogs: catalogs,
    sources: canonicalSources,
    canonicalText,
    contentHash,
    defaultEffect: defaultEffectValue,
    documents: Object.freeze([parsed.document]),
    policies: Object.freeze(policies),
  });
  COMPILED_SNAPSHOTS.add(snapshot);
  return Object.freeze({
    ok: true,
    snapshot,
    diagnostics: Object.freeze([]) as readonly [],
  });
}

/**
 * Compiles configured files in stable source-ID order. File boundaries and
 * their canonical text are bound into the snapshot hash, so reordering input
 * does not change a snapshot while renaming or editing a source does.
 */
export function compilePolicySnapshotSet(
  input: PolicySnapshotSetCompileInput,
  options: PolicySnapshotCompileOptions = {},
  catalogs: PolicyAttributeCatalogSet = BASE_POLICY_ATTRIBUTE_CATALOG_SET,
): PolicySnapshotCompileResult {
  assertRecognizedCatalogSet(catalogs);
  const detached = snapshotBoundaryJsonObject(input);
  if (!hasExactKeys(detached, ["policyVersionId", "sources", "defaultEffect"])) {
    throw new TypeError("Policy snapshot-set input has unknown or missing properties.");
  }
  const policyVersionIdValue = detached["policyVersionId"];
  const defaultEffectValue = detached["defaultEffect"];
  const rawSources = detached["sources"];
  if (
    typeof policyVersionIdValue !== "string" ||
    !isEffect(defaultEffectValue) ||
    !Array.isArray(rawSources) ||
    rawSources.length === 0
  ) {
    throw new TypeError("Policy snapshot-set input has an invalid field.");
  }
  const limits = normalizeLimits(options);
  if (rawSources.length > limits.maximumSources) {
    return failure([
      diagnostic(
        "compile",
        "too_many_policy_sources",
        "The configured policy source count exceeds its limit.",
        zeroSpan("<policy-set>"),
      ),
    ]);
  }
  const policyVersionId = PolicyVersionIdKind.parse(policyVersionIdValue);
  let totalSourceBytes = 0;
  const sources = rawSources.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      !hasExactKeys(candidate, ["sourceId", "source"])
    ) {
      throw new TypeError("A configured policy source is invalid.");
    }
    const sourceId = candidate["sourceId"];
    const source = candidate["source"];
    if (
      typeof sourceId !== "string" ||
      sourceId.trim().length === 0 ||
      typeof source !== "string"
    ) {
      throw new TypeError("A configured policy source is invalid.");
    }
    totalSourceBytes = safeAdd(
      totalSourceBytes,
      new TextEncoder().encode(source).byteLength,
      "aggregate policy source bytes",
    );
    return Object.freeze({ sourceId, source });
  });
  if (totalSourceBytes > limits.maximumTotalSourceBytes) {
    return failure([
      diagnostic(
        "compile",
        "policy_sources_too_large",
        "The aggregate policy source bytes exceed their configured limit.",
        zeroSpan("<policy-set>"),
      ),
    ]);
  }
  sources.sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
  for (let index = 1; index < sources.length; index += 1) {
    if (sources[index - 1]?.sourceId === sources[index]?.sourceId) {
      throw new TypeError("A policy source ID may appear only once.");
    }
  }

  const diagnostics: PolicyCompileDiagnostic[] = [];
  const snapshots: PolicySnapshot[] = [];
  for (const source of sources) {
    const result = compilePolicySnapshot(
      {
        policyVersionId,
        source: source.source,
        sourceId: source.sourceId,
        defaultEffect: defaultEffectValue,
      },
      options,
      catalogs,
    );
    if (!result.ok) diagnostics.push(...result.diagnostics);
    else snapshots.push(result.snapshot);
  }
  if (diagnostics.length > 0) {
    diagnostics.sort(compareDiagnostics);
    return failure(
      boundDiagnostics(
        diagnostics,
        limits.maximumDiagnostics,
        zeroSpan("<policy-set>"),
      ),
    );
  }
  const totalPolicies = snapshots.reduce(
    (total, snapshot) => safeAdd(total, snapshot.policies.length, "aggregate policy count"),
    0,
  );
  if (totalPolicies > limits.maximumTotalPolicies) {
    return failure([
      diagnostic(
        "compile",
        "too_many_total_policies",
        "The aggregate policy rule count exceeds its configured limit.",
        snapshots[0]?.documents[0]?.span ?? zeroSpan("<policy-set>"),
      ),
    ]);
  }

  const names = new Set<string>();
  for (const snapshot of snapshots) {
    for (const compiled of snapshot.policies) {
      if (names.has(compiled.rule.name.value)) {
        diagnostics.push(
          diagnostic(
            "typecheck",
            "duplicate_policy_name",
            "A policy name may appear only once across configured sources.",
            compiled.rule.name.span,
          ),
        );
      }
      names.add(compiled.rule.name.value);
    }
  }
  if (diagnostics.length > 0) {
    return failure(
      boundDiagnostics(
        diagnostics,
        limits.maximumDiagnostics,
        zeroSpan("<policy-set>"),
      ),
    );
  }

  const canonicalSources = Object.freeze(
    snapshots.flatMap((snapshot) => snapshot.sources),
  );
  const canonicalText = canonicalSources
    .map((source) => source.canonicalText)
    .join("\n");
  const contentHash = canonicalSha256Hex({
    languageVersion: GUARD_LANGUAGE_VERSION,
    attributeCatalogs: catalogs.manifest,
    defaultEffect: defaultEffectValue,
    sources: canonicalSources,
  });
  const snapshot: PolicySnapshot = Object.freeze({
    policyVersionId,
    languageVersion: GUARD_LANGUAGE_VERSION,
    attributeCatalogs: catalogs,
    sources: canonicalSources,
    canonicalText,
    contentHash,
    defaultEffect: defaultEffectValue,
    documents: Object.freeze(snapshots.flatMap((entry) => entry.documents)),
    policies: Object.freeze(snapshots.flatMap((entry) => entry.policies)),
  });
  COMPILED_SNAPSHOTS.add(snapshot);
  return Object.freeze({
    ok: true,
    snapshot,
    diagnostics: Object.freeze([]) as readonly [],
  });
}

export function assertCompiledPolicySnapshot(snapshot: PolicySnapshot): void {
  if (!COMPILED_SNAPSHOTS.has(snapshot)) {
    throw new TypeError("An immutable snapshot produced by this compiler is required.");
  }
}

/**
 * Safe replay/profile projection of a compiler-owned snapshot. Canonical
 * policy text and ASTs remain in the snapshot store; the manifest binds the
 * complete semantics needed to prove which immutable policy a run selected.
 */
export function createPolicySnapshotManifest(
  snapshot: PolicySnapshot,
): JsonObject {
  assertCompiledPolicySnapshot(snapshot);
  return Object.freeze({
    schemaVersion: 1,
    policyVersionId: snapshot.policyVersionId,
    languageVersion: snapshot.languageVersion,
    policyContentHash: snapshot.contentHash,
    defaultEffect: snapshot.defaultEffect,
    attributeCatalogs: snapshot.attributeCatalogs.manifest,
    sourceCount: snapshot.sources.length,
  });
}

function checkExpression(
  expression: Expression,
  comparisons: CompiledComparison[],
  diagnostics: PolicyCompileDiagnostic[],
  limits: CompileLimits,
  catalogs: PolicyAttributeCatalogSet,
): void {
  switch (expression.kind) {
    case "group":
      checkExpression(expression.expression, comparisons, diagnostics, limits, catalogs);
      return;
    case "not":
      checkExpression(expression.operand, comparisons, diagnostics, limits, catalogs);
      return;
    case "logical":
      checkExpression(expression.left, comparisons, diagnostics, limits, catalogs);
      checkExpression(expression.right, comparisons, diagnostics, limits, catalogs);
      return;
    case "exists": {
      const name = expression.attribute.path.join(".");
      if (policyAttributeDefinition(catalogs, name) === undefined) {
        diagnostics.push(
          diagnostic(
            "typecheck",
            "unknown_attribute",
            `Unknown policy attribute ${name}.`,
            expression.attribute.span,
          ),
        );
      }
      return;
    }
    case "comparison":
      checkComparison(expression, comparisons, diagnostics, limits, catalogs);
      return;
  }
}

function checkComparison(
  expression: ComparisonExpression,
  comparisons: CompiledComparison[],
  diagnostics: PolicyCompileDiagnostic[],
  limits: CompileLimits,
  catalogs: PolicyAttributeCatalogSet,
): void {
  const name = expression.left.path.join(".");
  const definition = policyAttributeDefinition(catalogs, name);
  if (definition === undefined) {
    diagnostics.push(
      diagnostic(
        "typecheck",
        "unknown_attribute",
        `Unknown policy attribute ${name}.`,
        expression.left.span,
      ),
    );
    return;
  }
  const rightType = valueType(expression.right, diagnostics);
  let compatible = false;
  if (expression.operator === "==" || expression.operator === "!=") {
    compatible = rightType === definition.type;
  } else if (expression.operator === "in") {
    compatible = listElementType(rightType) === definition.type;
  } else if (expression.operator === "starts_with") {
    compatible = definition.type === "string" && rightType === "string";
  } else {
    compatible =
      (definition.type === "string" || definition.type === "list<string>") &&
      rightType === "string";
  }
  if (!compatible) {
    diagnostics.push(
      diagnostic(
        "typecheck",
        "incompatible_comparison",
        `Operator ${expression.operator} is incompatible with ${definition.type}.`,
        expression.span,
      ),
    );
    return;
  }

  let glob = null;
  if (expression.operator === "matches") {
    if (definition.matchKind !== "canonical_path") {
      diagnostics.push(
        diagnostic(
          "typecheck",
          "matches_requires_canonical_path_attribute",
          "The matches operator accepts only a catalogued canonical-path attribute.",
          expression.left.span,
        ),
      );
      return;
    }
    if (expression.right.kind !== "string") {
      diagnostics.push(
        diagnostic(
          "typecheck",
          "glob_requires_string",
          "The matches operator requires a string glob.",
          expression.right.span,
        ),
      );
      return;
    }
    try {
      glob = compileAnchoredPathGlob(expression.right.value, {
        maximumBytes: limits.maximumGlobBytes,
        maximumSegments: limits.maximumGlobSegments,
        maximumWildcards: limits.maximumGlobWildcards,
      });
    } catch (error: unknown) {
      const code = error instanceof GlobSyntaxError ? error.code : "invalid_glob";
      diagnostics.push(
        diagnostic(
          "typecheck",
          code,
          "The matches operand is not a valid bounded v1 path glob.",
          expression.right.span,
        ),
      );
      return;
    }
  }
  comparisons.push(Object.freeze({ expression, attribute: definition, glob }));
}

function valueType(
  value: PolicyValue,
  diagnostics: PolicyCompileDiagnostic[],
): PolicyAttributeType | "list<boolean>" | "list<integer>" | "invalid" {
  if (value.kind !== "list") return value.kind;
  if (value.items.length === 0) {
    diagnostics.push(
      diagnostic(
        "typecheck",
        "empty_list_has_no_type",
        "An empty policy list has no inferable element type.",
        value.span,
      ),
    );
    return "invalid";
  }
  const itemTypes = value.items.map((item) => valueType(item, diagnostics));
  if (itemTypes.some((type) => type === "invalid" || type.startsWith("list<"))) {
    diagnostics.push(
      diagnostic(
        "typecheck",
        "nested_list_not_supported",
        "Nested policy lists are not supported in v1.",
        value.span,
      ),
    );
    return "invalid";
  }
  const first = itemTypes[0];
  if (first === undefined || itemTypes.some((type) => type !== first)) {
    diagnostics.push(
      diagnostic(
        "typecheck",
        "heterogeneous_list",
        "A policy list must contain one scalar type.",
        value.span,
      ),
    );
    return "invalid";
  }
  return `list<${first}>` as "list<string>" | "list<boolean>" | "list<integer>";
}

function listElementType(
  type: PolicyAttributeType | "list<boolean>" | "list<integer>" | "invalid",
): PolicyAttributeType | "invalid" {
  if (type === "list<string>") return "string";
  if (type === "list<boolean>") return "boolean";
  if (type === "list<integer>") return "integer";
  return "invalid";
}

function normalizeLimits(options: PolicySnapshotCompileOptions): CompileLimits {
  const raw = snapshotBoundaryJsonObject(options);
  const allowed = new Set([
    "maximumSourceBytes",
    "maximumPolicies",
    "maximumSources",
    "maximumTotalSourceBytes",
    "maximumTotalPolicies",
    "maximumDiagnostics",
    "maximumGlobBytes",
    "maximumGlobSegments",
    "maximumGlobWildcards",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new TypeError("Policy compile options contain an unknown property.");
  }
  return Object.freeze({
    maximumSourceBytes: positive(raw["maximumSourceBytes"], DEFAULT_COMPILE_LIMITS.maximumSourceBytes),
    maximumPolicies: positive(raw["maximumPolicies"], DEFAULT_COMPILE_LIMITS.maximumPolicies),
    maximumSources: positive(raw["maximumSources"], DEFAULT_COMPILE_LIMITS.maximumSources),
    maximumTotalSourceBytes: positive(
      raw["maximumTotalSourceBytes"],
      DEFAULT_COMPILE_LIMITS.maximumTotalSourceBytes,
    ),
    maximumTotalPolicies: positive(
      raw["maximumTotalPolicies"],
      DEFAULT_COMPILE_LIMITS.maximumTotalPolicies,
    ),
    maximumDiagnostics: positive(
      raw["maximumDiagnostics"],
      DEFAULT_COMPILE_LIMITS.maximumDiagnostics,
    ),
    maximumGlobBytes: positive(raw["maximumGlobBytes"], DEFAULT_COMPILE_LIMITS.maximumGlobBytes),
    maximumGlobSegments: positive(
      raw["maximumGlobSegments"],
      DEFAULT_COMPILE_LIMITS.maximumGlobSegments,
    ),
    maximumGlobWildcards: positive(
      raw["maximumGlobWildcards"],
      DEFAULT_COMPILE_LIMITS.maximumGlobWildcards,
    ),
  });
}

function positive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("Policy compiler limits must be positive safe integers.");
  }
  return value as number;
}

function fromLanguageDiagnostic(value: GuardDiagnostic): PolicyCompileDiagnostic {
  return diagnostic(value.phase, value.code, value.message, value.span);
}

function diagnostic(
  phase: PolicyCompileDiagnostic["phase"],
  code: string,
  message: string,
  span: SourceSpan,
): PolicyCompileDiagnostic {
  return Object.freeze({ severity: "error", phase, code, message, span });
}

function failure(
  diagnostics: readonly PolicyCompileDiagnostic[],
): PolicySnapshotCompileResult {
  return Object.freeze({
    ok: false,
    snapshot: null,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function compareDiagnostics(
  left: PolicyCompileDiagnostic,
  right: PolicyCompileDiagnostic,
): number {
  return (
    left.span.start.byteOffset - right.span.start.byteOffset ||
    compareUtf8(left.code, right.code)
  );
}

function zeroSpan(sourceId: string): SourceSpan {
  const point = Object.freeze({ byteOffset: 0, line: 1, column: 1 });
  return Object.freeze({ sourceId, start: point, end: point });
}

function isEffect(value: unknown): value is "allow" | "deny" | "require_approval" {
  return value === "allow" || value === "deny" || value === "require_approval";
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function safeAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`${field} exceeds the safe-integer range.`);
  }
  return result;
}

function boundDiagnostics(
  diagnostics: readonly PolicyCompileDiagnostic[],
  maximum: number,
  span: SourceSpan,
): readonly PolicyCompileDiagnostic[] {
  if (diagnostics.length <= maximum) return diagnostics;
  const retained = diagnostics.slice(0, Math.max(0, maximum - 1));
  retained.push(
    diagnostic(
      "compile",
      "too_many_diagnostics",
      "Policy checking stopped after the configured diagnostic limit.",
      span,
    ),
  );
  return retained;
}
