import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalize } from "@guard/contracts";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshot,
  composePolicyAttributeCatalogs,
  evaluatePolicySnapshot,
  parsePolicyCaseCorpus,
  runPolicyCaseCorpus,
} from "@guard/policy-engine";

import { REPOSITORY_POLICY_ATTRIBUTE_CATALOG } from "./policy-catalog.js";
import { normalizeRepositoryPath } from "./repository-path.js";

const POLICY_VERSION_ID = "pol_018f05a0-7b01-7000-8000-0000000003a1";
const EXPECTED_POLICY_CONTENT_HASH =
  "4bd3d9c74ed673859c62551fe929f57d417939826f8aaf6719fb3764dfd5dfa3";
const EXPECTED_CONTEXT_POLICY_CONTENT_HASH =
  "df76cdaae6c1f43127c740ea183fc5267c14e3a99d8d3a879d24c0f53ad5869e";
const CORRELATION_TOKEN = "repository-default-policy-corpus-token-0001";
const DEFAULT_REASON =
  "No policy matched; the immutable snapshot default effect applies.";

test("production default policy is bound to guard.repo and its owned strict corpus", async () => {
  const source = await readFile(
    new URL("../../../policies/default.guard", import.meta.url),
    "utf8",
  );
  const catalogs = composePolicyAttributeCatalogs([
    BASE_POLICY_ATTRIBUTE_CATALOG,
    REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
  ]);
  const compiled = compilePolicySnapshot(
    {
      policyVersionId: POLICY_VERSION_ID,
      source,
      sourceId: "policies/default.guard",
      defaultEffect: "deny",
    },
    {},
    catalogs,
  );
  assert.equal(compiled.ok, true, canonicalize(compiled.diagnostics));
  if (!compiled.ok) return;

  assert.equal(compiled.snapshot.defaultEffect, "deny");
  assert.equal(compiled.snapshot.contentHash, EXPECTED_POLICY_CONTENT_HASH);
  assert.deepEqual(compiled.snapshot.attributeCatalogs.manifest, [
    {
      catalogId: "guard.base",
      schemaVersion: 1,
      contentHash: BASE_POLICY_ATTRIBUTE_CATALOG.contentHash,
    },
    {
      catalogId: "guard.repo",
      schemaVersion: 3,
      contentHash: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
    },
  ]);
  assert.deepEqual(
    compiled.snapshot.policies.map((policy) => policy.rule.name.value),
    [
      "deny-secret-repository-actions",
      "approve-dependency-installation",
      "allow-sandboxed-tests",
    ],
  );

  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/default-policy-cases-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const corpus = parsePolicyCaseCorpus(fixture, {
    maximumBytes: 128 * 1024,
    maximumCases: 10,
  });
  assert.equal(corpus.policyContentHash, EXPECTED_POLICY_CONTENT_HASH);
  assert.deepEqual(
    corpus.cases.map((entry) => entry.name),
    [
      "secret-repository-path-match",
      "secret-repository-path-near-miss",
      "secret-repository-input-path-match",
      "secret-repository-input-path-near-miss",
      "repository-path-attributes-missing-default",
      "dependency-install-match",
      "approval-over-allow-overlap",
      "dependency-install-near-miss",
      "sandboxed-tests-match",
      "sandboxed-tests-near-miss",
    ],
  );
  for (const policy of compiled.snapshot.policies) {
    const name = policy.rule.name.value;
    assert.equal(
      corpus.cases.filter(
        (entry) => entry.expectedWinningPolicyName === name,
      ).length,
      name === "deny-secret-repository-actions" ||
        name === "approve-dependency-installation"
        ? 2
        : 1,
      `${name} has the wrong matching-case count`,
    );
  }
  const nearMisses = corpus.cases.filter((entry) => entry.name.endsWith("near-miss"));
  assert.equal(nearMisses.length, compiled.snapshot.policies.length + 1);
  for (const nearMiss of nearMisses) {
    assert.equal(nearMiss.expectedEffect, "deny");
    assert.equal(nearMiss.expectedWinningPolicyName, null);
    assert.equal(nearMiss.expectedReason, DEFAULT_REASON);
  }

  const run = runPolicyCaseCorpus(
    compiled.snapshot,
    corpus,
    CORRELATION_TOKEN,
  );
  assert.equal(
    run.failed,
    0,
    JSON.stringify(run.cases.filter((entry) => !entry.passed)),
  );
  assert.equal(run.passed, 10);
});

test("production default policy has a reviewed Operations Plan section 8.7 matrix", async () => {
  const source = await readFile(
    new URL("../../../policies/default.guard", import.meta.url),
    "utf8",
  );
  const compiled = compilePolicySnapshot(
    {
      policyVersionId: POLICY_VERSION_ID,
      source,
      sourceId: "policies/default.guard",
      defaultEffect: "deny",
    },
    {},
    composePolicyAttributeCatalogs([
      BASE_POLICY_ATTRIBUTE_CATALOG,
      REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
    ]),
  );
  assert.equal(compiled.ok, true, canonicalize(compiled.diagnostics));
  if (!compiled.ok) return;

  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/default-policy-cases-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const corpus = parsePolicyCaseCorpus(fixture, {
    maximumBytes: 128 * 1024,
    maximumCases: 10,
  });

  const overlap = corpus.cases.find(
    (entry) => entry.name === "approval-over-allow-overlap",
  );
  assert.ok(overlap);
  const overlapDecision = evaluatePolicySnapshot(
    compiled.snapshot,
    overlap.action,
    { secretCorrelationToken: CORRELATION_TOKEN },
  );
  assert.equal(overlapDecision.effect, "require_approval");
  assert.equal(
    overlapDecision.winningPolicyName,
    "approve-dependency-installation",
  );
  assert.deepEqual(overlapDecision.matchedPolicyNames, [
    "approve-dependency-installation",
    "allow-sandboxed-tests",
  ]);

  // The file cannot exercise deny-over-allow because its deny and allow rules
  // intentionally require disjoint capability-pack identities. Keep this
  // structural assertion beside the reviewed exception so a future overlap
  // makes the exception fail instead of silently going stale. The generic
  // combining-algorithm evidence is the policy-engine test named
  // "deny overrides higher-priority approval and allow; tie explanations are stable".
  assert.match(
    source,
    /policy "deny-secret-repository-actions"[\s\S]*?action\.pack == "coding\.virtual-repository"/u,
  );
  assert.match(
    source,
    /policy "allow-sandboxed-tests"[\s\S]*?action\.pack == "process"/u,
  );
  const repositoryDeny = corpus.cases.find(
    (entry) => entry.name === "secret-repository-path-match",
  );
  const processAllow = corpus.cases.find(
    (entry) => entry.name === "sandboxed-tests-match",
  );
  assert.ok(repositoryDeny);
  assert.ok(processAllow);
  assert.deepEqual(
    evaluatePolicySnapshot(compiled.snapshot, repositoryDeny.action, {
      secretCorrelationToken: CORRELATION_TOKEN,
    }).matchedPolicyNames,
    ["deny-secret-repository-actions"],
  );
  assert.deepEqual(
    evaluatePolicySnapshot(compiled.snapshot, processAllow.action, {
      secretCorrelationToken: CORRELATION_TOKEN,
    }).matchedPolicyNames,
    ["allow-sandboxed-tests"],
  );

  // This file has no equal priorities. If one is introduced, the reviewed
  // exception must be replaced by a file-owned tie case. Generic deterministic
  // UTF-8 tie ordering is covered by the policy-engine test cited above.
  const priorities = compiled.snapshot.policies.map(
    (policy) => policy.rule.priority.value,
  );
  assert.deepEqual(priorities, [1000, 700, 500]);
  assert.equal(new Set(priorities).size, compiled.snapshot.policies.length);

  const missing = corpus.cases.find(
    (entry) => entry.name === "repository-path-attributes-missing-default",
  );
  assert.ok(missing);
  const missingDecision = evaluatePolicySnapshot(
    compiled.snapshot,
    missing.action,
    { secretCorrelationToken: CORRELATION_TOKEN },
  );
  assert.equal(missingDecision.effect, "deny");
  assert.equal(missingDecision.winningPolicyName, null);

  // Actions reach policy only after repository-path canonicalization. The
  // independent-oracle corpus in repository-path-corpus.test.ts owns the full
  // separator, dot-segment, Unicode, traversal, and portability matrix. This
  // direct equivalence assertion links that boundary to this policy review.
  assert.equal(
    normalizeRepositoryPath("src/cafe\u0301.ts", { allowRoot: false }),
    normalizeRepositoryPath("src/caf\u00e9.ts", { allowRoot: false }),
  );
  assert.throws(() =>
    normalizeRepositoryPath("src/./caf\u00e9.ts", { allowRoot: false }),
  );
  // No rule in this file consumes a command/argv attribute, so command
  // equivalence is structurally inapplicable here rather than waived.
  assert.equal(source.includes("process.argv"), false);

  assert.equal(Object.isFrozen(compiled.snapshot), true);
  assert.equal(Object.isFrozen(compiled.snapshot.policies), true);
  for (const policy of compiled.snapshot.policies) {
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.rule), true);
  }
  assert.equal(
    Reflect.set(
      compiled.snapshot as unknown as Record<string, unknown>,
      "defaultEffect",
      "allow",
    ),
    false,
  );
  assert.equal(compiled.snapshot.defaultEffect, "deny");

  const legacyFixture = structuredClone(fixture) as {
    cases: Array<{ action: Record<string, unknown> }>;
  };
  assert.ok(legacyFixture.cases[0]);
  legacyFixture.cases[0].action["schemaVersion"] = 0;
  assert.throws(() =>
    parsePolicyCaseCorpus(legacyFixture, {
      maximumBytes: 128 * 1024,
      maximumCases: 10,
    }),
  );

  const reviewedCoverage = [
    ["matching example per rule", "covered", "default-policy-cases-v1.json"],
    ["near miss per rule", "covered", "default-policy-cases-v1.json"],
    [
      "deny precedence over allow",
      "structurally inapplicable",
      "disjoint coding.virtual-repository/process pack predicates; generic engine precedence test",
    ],
    [
      "approval precedence over allow",
      "covered",
      "approval-over-allow-overlap",
    ],
    ["no-match default", "covered", "near-miss and missing-attribute cases"],
    [
      "equal-priority deterministic order",
      "structurally inapplicable",
      "unique [1000,700,500] priorities; generic engine tie-order test",
    ],
    [
      "missing optional attributes",
      "covered",
      "repository-path-attributes-missing-default",
    ],
    [
      "canonically equivalent paths and commands",
      "boundary-owned/command inapplicable",
      "repository-path-corpus.test.ts; no argv predicate in this file",
    ],
    ["policy snapshot immutability", "covered", "direct deep-freeze assertions"],
    [
      "old action schema compatibility or explicit failure",
      "covered",
      "schemaVersion 0 corpus action rejected",
    ],
  ] as const;
  assert.deepEqual(
    reviewedCoverage.map(([category]) => category),
    [
      "matching example per rule",
      "near miss per rule",
      "deny precedence over allow",
      "approval precedence over allow",
      "no-match default",
      "equal-priority deterministic order",
      "missing optional attributes",
      "canonically equivalent paths and commands",
      "policy snapshot immutability",
      "old action schema compatibility or explicit failure",
    ],
  );
});

test("production repository context policy owns an exact guard.repo v3 corpus", async () => {
  const source = await readFile(
    new URL("../policies/context.guard", import.meta.url),
    "utf8",
  );
  const catalogs = composePolicyAttributeCatalogs([
    BASE_POLICY_ATTRIBUTE_CATALOG,
    REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
  ]);
  const compiled = compilePolicySnapshot(
    {
      policyVersionId: "pol_018f05a0-7b01-7000-8000-0000000003a2",
      source,
      sourceId: "packages/capability-repository/policies/context.guard",
      defaultEffect: "allow",
    },
    {},
    catalogs,
  );
  assert.equal(compiled.ok, true, canonicalize(compiled.diagnostics));
  if (!compiled.ok) return;
  assert.equal(compiled.snapshot.contentHash, EXPECTED_CONTEXT_POLICY_CONTENT_HASH);
  assert.deepEqual(compiled.snapshot.attributeCatalogs.manifest.at(-1), {
    catalogId: "guard.repo",
    schemaVersion: 3,
    contentHash: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
  });

  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/context-policy-cases-v3.json", import.meta.url),
      "utf8",
    ),
  );
  const corpus = parsePolicyCaseCorpus(fixture, {
    maximumBytes: 128 * 1024,
    maximumCases: 8,
  });
  assert.equal(corpus.policyContentHash, EXPECTED_CONTEXT_POLICY_CONTENT_HASH);
  assert.deepEqual(
    corpus.cases.map((entry) => entry.name),
    [
      "secret-scalar-path-match",
      "secret-scalar-path-near-miss",
      "secret-output-path-first-match",
      "secret-output-path-middle-match",
      "secret-output-path-last-match",
      "safe-output-paths-near-miss",
      "empty-output-paths-near-miss",
      "missing-output-paths-near-miss",
    ],
  );
  assert.equal(
    corpus.cases.filter(
      (entry) =>
        entry.expectedWinningPolicyName ===
        "deny-secret-repository-context-paths",
    ).length,
    4,
  );
  assert.equal(
    corpus.cases.filter((entry) => entry.expectedWinningPolicyName === null).length,
    4,
  );
  const run = runPolicyCaseCorpus(
    compiled.snapshot,
    corpus,
    "repository-context-policy-corpus-token-0001",
  );
  assert.equal(
    run.failed,
    0,
    JSON.stringify(run.cases.filter((entry) => !entry.passed)),
  );
  assert.equal(run.passed, 8);
});

test("repository context policy has a reviewed Operations Plan section 8.7 matrix", async () => {
  const source = await readFile(
    new URL("../policies/context.guard", import.meta.url),
    "utf8",
  );
  const compiled = compilePolicySnapshot(
    {
      policyVersionId: "pol_018f05a0-7b01-7000-8000-0000000003a3",
      source,
      sourceId: "packages/capability-repository/policies/context.guard",
      defaultEffect: "allow",
    },
    {},
    composePolicyAttributeCatalogs([
      BASE_POLICY_ATTRIBUTE_CATALOG,
      REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
    ]),
  );
  assert.equal(compiled.ok, true, canonicalize(compiled.diagnostics));
  if (!compiled.ok) return;

  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/context-policy-cases-v3.json", import.meta.url),
      "utf8",
    ),
  );
  const corpus = parsePolicyCaseCorpus(fixture, {
    maximumBytes: 128 * 1024,
    maximumCases: 8,
  });

  // A single deny-only rule cannot overlap an allow or approval and cannot tie.
  // Lock that reviewed exception to the exact current structure. If another
  // rule/effect/priority appears, these assertions force a file-owned corpus
  // case instead of leaving a stale waiver. Generic combining and tie ordering
  // remain covered by the policy-engine test named "deny overrides higher-
  // priority approval and allow; tie explanations are stable".
  assert.equal(compiled.snapshot.policies.length, 1);
  const onlyPolicy = compiled.snapshot.policies[0];
  assert.ok(onlyPolicy);
  assert.equal(onlyPolicy.rule.name.value, "deny-secret-repository-context-paths");
  assert.equal(onlyPolicy.rule.effect.value, "deny");
  assert.equal(onlyPolicy.rule.priority.value, 950);
  assert.equal(source.includes("require_approval"), false);
  assert.equal(/\n\s*allow\s*\n/u.test(source), false);

  const match = corpus.cases.find(
    (entry) => entry.name === "secret-output-path-middle-match",
  );
  const missing = corpus.cases.find(
    (entry) => entry.name === "missing-output-paths-near-miss",
  );
  assert.ok(match);
  assert.ok(missing);
  const matchDecision = evaluatePolicySnapshot(compiled.snapshot, match.action, {
    secretCorrelationToken: CORRELATION_TOKEN,
  });
  assert.equal(matchDecision.effect, "deny");
  assert.deepEqual(matchDecision.matchedPolicyNames, [
    "deny-secret-repository-context-paths",
  ]);
  const missingDecision = evaluatePolicySnapshot(
    compiled.snapshot,
    missing.action,
    { secretCorrelationToken: CORRELATION_TOKEN },
  );
  assert.equal(missingDecision.effect, "allow");
  assert.equal(missingDecision.winningPolicyName, null);
  assert.equal(missingDecision.reason, DEFAULT_REASON);

  assert.equal(
    normalizeRepositoryPath("src/cafe\u0301.ts", { allowRoot: false }),
    normalizeRepositoryPath("src/caf\u00e9.ts", { allowRoot: false }),
  );
  assert.throws(() =>
    normalizeRepositoryPath("src/../.env", { allowRoot: false }),
  );
  assert.equal(source.includes("process.argv"), false);

  assert.equal(Object.isFrozen(compiled.snapshot), true);
  assert.equal(Object.isFrozen(compiled.snapshot.policies), true);
  assert.equal(Object.isFrozen(onlyPolicy), true);
  assert.equal(Object.isFrozen(onlyPolicy.rule), true);
  assert.equal(
    Reflect.set(
      compiled.snapshot as unknown as Record<string, unknown>,
      "defaultEffect",
      "deny",
    ),
    false,
  );
  assert.equal(compiled.snapshot.defaultEffect, "allow");

  const legacyFixture = structuredClone(fixture) as {
    cases: Array<{ action: Record<string, unknown> }>;
  };
  assert.ok(legacyFixture.cases[0]);
  legacyFixture.cases[0].action["schemaVersion"] = 0;
  assert.throws(() =>
    parsePolicyCaseCorpus(legacyFixture, {
      maximumBytes: 128 * 1024,
      maximumCases: 8,
    }),
  );

  const reviewedCoverage = [
    ["matching example per rule", "covered", "four scalar/list positions"],
    ["near miss per rule", "covered", "four safe/empty/missing cases"],
    [
      "deny precedence over allow",
      "structurally inapplicable",
      "single deny-only rule; generic engine precedence test",
    ],
    [
      "approval precedence over allow",
      "structurally inapplicable",
      "no approval or allow rule; generic engine precedence test",
    ],
    ["no-match default", "covered", "safe/empty/missing default-allow cases"],
    [
      "equal-priority deterministic order",
      "structurally inapplicable",
      "one priority-950 rule; generic engine tie-order test",
    ],
    [
      "missing optional attributes",
      "covered",
      "missing-output-paths-near-miss",
    ],
    [
      "canonically equivalent paths and commands",
      "boundary-owned/command inapplicable",
      "repository-path-corpus.test.ts; no argv predicate",
    ],
    ["policy snapshot immutability", "covered", "direct deep-freeze assertions"],
    [
      "old action schema compatibility or explicit failure",
      "covered",
      "schemaVersion 0 corpus action rejected",
    ],
  ] as const;
  assert.deepEqual(
    reviewedCoverage.map(([category]) => category),
    [
      "matching example per rule",
      "near miss per rule",
      "deny precedence over allow",
      "approval precedence over allow",
      "no-match default",
      "equal-priority deterministic order",
      "missing optional attributes",
      "canonically equivalent paths and commands",
      "policy snapshot immutability",
      "old action schema compatibility or explicit failure",
    ],
  );
});
