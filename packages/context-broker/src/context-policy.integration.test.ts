import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PolicyVersionIdKind } from "@guard/contracts";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshot,
  composePolicyAttributeCatalogs,
  createPinnedPolicyEvaluator,
  evaluatePolicySnapshot,
  parsePolicyCaseCorpus,
  runPolicyCaseCorpus,
  simulatePolicyPage,
} from "@guard/policy-engine";

import {
  BrokerContextSourceRegistry,
  CONTEXT_POLICY_ATTRIBUTE_CATALOG,
  InMemoryBrokerSource,
  MEMORY_POLICY_ATTRIBUTE_CATALOG,
  canonicalizeResourceRef,
  createContextBrokerIntegrationFactory,
  createContextReleasePolicySnapshot,
  createPinnedContextPolicyAdapter,
  type BrokerContextSource,
  type ContextBudgetLimits,
} from "./index.js";

const POLICY_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000401",
);
const CANDIDATE_POLICY_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000402",
);
const EXPECTED_POLICY_CONTENT_HASH =
  "4d98dc2769e15f555a1bf18d620f51341112029d51d4332671f303b0a571981b";
const TOKEN = "context-policy-corpus-correlation-token-0001";
const MAXIMUM_REVIEWED_CASES = 12;
const DEFAULT_REASON =
  "No policy matched; the immutable snapshot default effect applies.";
const GENERIC_COMBINING_TEST =
  'policy-engine: "deny overrides higher-priority approval and allow; tie explanations are stable"';
const FAIL_CLOSED_ROLLOUT_BASELINE = `policy "baseline-no-installed-policy" priority 1 {
  when action.pack == "guard.baseline-no-installed-policy"
  deny
  reason "No reviewed policy was installed in the fail-closed baseline."
}
`;
const OPERATIONS_PLAN_POLICY_CATEGORIES = Object.freeze([
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
] as const);
const BUDGETS: ContextBudgetLimits = Object.freeze({
  maximumResourceBytes: 64 * 1024,
  maximumRequestBytes: 32 * 1024,
  maximumItemsPerTurn: 8,
  maximumBytesPerTurn: 64 * 1024,
  maximumItemsPerRun: 16,
  maximumBytesPerRun: 128 * 1024,
  maximumControlCharacterRatio: 0.05,
});

test("the shipped generic context policy passes its exact reviewed table", async () => {
  const source = await readFile(
    new URL("../../../policies/context.guard", import.meta.url),
    "utf8",
  );
  const compiled = compilePolicySnapshot(
    {
      policyVersionId: POLICY_ID,
      source,
      sourceId: "policies/context.guard",
      defaultEffect: "deny",
    },
    {},
    composePolicyAttributeCatalogs([
      BASE_POLICY_ATTRIBUTE_CATALOG,
      CONTEXT_POLICY_ATTRIBUTE_CATALOG,
      MEMORY_POLICY_ATTRIBUTE_CATALOG,
    ]),
  );
  assert.equal(
    compiled.ok,
    true,
    compiled.ok ? "" : JSON.stringify(compiled.diagnostics),
  );
  if (!compiled.ok) throw new Error("unreachable context-policy compile failure");
  assert.equal(compiled.snapshot.contentHash, EXPECTED_POLICY_CONTENT_HASH);

  const raw: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/context-policy-cases-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const corpus = parsePolicyCaseCorpus(raw, {
    maximumBytes: 128 * 1024,
    maximumCases: MAXIMUM_REVIEWED_CASES,
  });
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.policyContentHash, EXPECTED_POLICY_CONTENT_HASH);
  assert.equal(corpus.cases.length, MAXIMUM_REVIEWED_CASES);
  const run = runPolicyCaseCorpus(compiled.snapshot, corpus, TOKEN);
  assert.equal(
    run.failed,
    0,
    JSON.stringify(run.cases.filter((entry) => !entry.passed)),
  );
  assert.equal(run.passed, MAXIMUM_REVIEWED_CASES);

  const ruleNames = new Set(
    compiled.snapshot.policies.map((policy) => policy.rule.name.value),
  );
  const matchingWinners = new Set(
    corpus.cases
      .filter((entry) => entry.name.endsWith("-match"))
      .map((entry) => entry.expectedWinningPolicyName),
  );
  assert.deepEqual(matchingWinners, ruleNames);
  for (const ruleName of ruleNames) {
    assert.equal(
      corpus.cases.some((entry) => entry.name === `${ruleName}-near-miss`),
      true,
      `${ruleName} requires one explicit near miss`,
    );
  }
});

test("context policy table rejects old versions and snapshot drift", async () => {
  const raw = JSON.parse(
    await readFile(
      new URL("../testdata/context-policy-cases-v1.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const limits = {
    maximumBytes: 128 * 1024,
    maximumCases: MAXIMUM_REVIEWED_CASES,
  } as const;
  assert.throws(() => parsePolicyCaseCorpus({ ...raw, schemaVersion: 0 }, limits));
  const wrongHash = parsePolicyCaseCorpus(
    { ...raw, policyContentHash: "0".repeat(64) },
    limits,
  );
  const snapshot = await compileContextPolicy();
  assert.throws(() => runPolicyCaseCorpus(snapshot, wrongHash, TOKEN));
  assert.throws(() =>
    parsePolicyCaseCorpus({
      ...raw,
      unknown: true,
    }, limits),
  );
});

test("the generic context policy has a reviewed Operations Plan section 8.7 matrix", async () => {
  const source = await readFile(
    new URL("../../../policies/context.guard", import.meta.url),
    "utf8",
  );
  const snapshot = await compileContextPolicy();
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/context-policy-cases-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const corpus = parsePolicyCaseCorpus(fixture, {
    maximumBytes: 128 * 1024,
    maximumCases: MAXIMUM_REVIEWED_CASES,
  });
  assert.deepEqual(
    snapshot.policies.map((policy) => ({
      name: policy.rule.name.value,
      priority: policy.rule.priority.value,
      effect: policy.rule.effect.value,
    })),
    [
      { name: "deny-restricted-context", priority: 1000, effect: "deny" },
      {
        name: "deny-networked-context-boundary",
        priority: 900,
        effect: "deny",
      },
      {
        name: "allow-reviewed-context-reads",
        priority: 600,
        effect: "allow",
      },
      {
        name: "allow-reviewed-context-releases",
        priority: 600,
        effect: "allow",
      },
    ],
  );
  const comparisonSignatures = snapshot.policies.map((policy) => ({
    name: policy.rule.name.value,
    logicalOperators: collectLogicalOperators(policy.rule.condition),
    comparisons: policy.comparisons.map((comparison) => ({
      attribute: comparison.attribute.name,
      operator: comparison.expression.operator,
      expected:
        comparison.expression.right.kind === "list"
          ? comparison.expression.right.items.map((item) =>
              item.kind === "list" ? "nested-list" : item.value,
            )
          : comparison.expression.right.value,
    })),
  }));
  assert.deepEqual(comparisonSignatures, [
    {
      name: "deny-restricted-context",
      logicalOperators: ["and"],
      comparisons: [
        { attribute: "action.pack", operator: "==", expected: "guard.context" },
        {
          attribute: "resource.classification",
          operator: "in",
          expected: ["restricted", "secret"],
        },
      ],
    },
    {
      name: "deny-networked-context-boundary",
      logicalOperators: ["and"],
      comparisons: [
        { attribute: "action.pack", operator: "==", expected: "guard.context" },
        {
          attribute: "environment.network_profile",
          operator: "!=",
          expected: "disabled",
        },
      ],
    },
    {
      name: "allow-reviewed-context-reads",
      logicalOperators: ["and", "and", "and", "and", "and"],
      comparisons: [
        { attribute: "action.pack", operator: "==", expected: "guard.context" },
        {
          attribute: "action.operation",
          operator: "==",
          expected: "context.read",
        },
        { attribute: "action.side_effect", operator: "==", expected: "none" },
        {
          attribute: "environment.sandboxed",
          operator: "==",
          expected: true,
        },
        {
          attribute: "environment.network_profile",
          operator: "==",
          expected: "disabled",
        },
        {
          attribute: "resource.classification",
          operator: "in",
          expected: ["public", "internal", "synthetic", "fixture"],
        },
      ],
    },
    {
      name: "allow-reviewed-context-releases",
      logicalOperators: ["and", "and", "and", "and", "and", "and"],
      comparisons: [
        { attribute: "action.pack", operator: "==", expected: "guard.context" },
        {
          attribute: "action.operation",
          operator: "==",
          expected: "context.release",
        },
        { attribute: "action.side_effect", operator: "==", expected: "none" },
        {
          attribute: "environment.sandboxed",
          operator: "==",
          expected: true,
        },
        {
          attribute: "environment.network_profile",
          operator: "==",
          expected: "disabled",
        },
        {
          attribute: "resource.classification",
          operator: "in",
          expected: ["public", "internal", "synthetic", "fixture"],
        },
        { attribute: "context.truncated", operator: "==", expected: false },
      ],
    },
  ]);

  for (const policy of snapshot.policies) {
    const ruleName = policy.rule.name.value;
    const matching = corpus.cases.find(
      (entry) => entry.name === `${ruleName}-match`,
    );
    const nearMiss = corpus.cases.find(
      (entry) => entry.name === `${ruleName}-near-miss`,
    );
    assert.ok(matching, `${ruleName} requires its named matching case`);
    assert.ok(nearMiss, `${ruleName} requires its named near miss`);
    assert.equal(
      evaluatePolicySnapshot(snapshot, matching.action, {
        secretCorrelationToken: TOKEN,
      }).matchedPolicyNames.includes(ruleName),
      true,
    );
    const nearMissDecision = evaluatePolicySnapshot(snapshot, nearMiss.action, {
      secretCorrelationToken: TOKEN,
    });
    const evaluations = nearMissDecision.trace["evaluations"] as readonly Readonly<
      Record<string, unknown>
    >[];
    assert.equal(
      evaluations.find((entry) => entry["policyName"] === ruleName)?.["result"],
      "false",
      `${ruleName} near miss must make that exact rule false`,
    );
  }

  const restrictedRead = corpus.cases.find(
    (entry) => entry.name === "restricted-read-deny",
  );
  assert.ok(restrictedRead);
  const denyDecision = evaluatePolicySnapshot(snapshot, restrictedRead.action, {
    secretCorrelationToken: TOKEN,
  });
  assert.equal(denyDecision.effect, "deny");
  assert.deepEqual(denyDecision.matchedPolicyNames, ["deny-restricted-context"]);

  // The exact comparison and all-conjunction signatures above prove each deny
  // predicate is disjoint from both allows: classified deny values are outside
  // the allow list, while networked denies require != disabled and allows
  // require == disabled. A future overlap invalidates this structural exception.
  assert.equal(
    corpus.cases.some((entry) => {
      const matched = evaluatePolicySnapshot(snapshot, entry.action, {
        secretCorrelationToken: TOKEN,
      }).matchedPolicyNames;
      return matched.some((name) => name.startsWith("deny-")) &&
        matched.some((name) => name.startsWith("allow-"));
    }),
    false,
  );

  // There is no approval rule in this exact four-rule snapshot. A future
  // approval effect invalidates the reviewed structural exception; the generic
  // combining-algorithm behavior remains owned by GENERIC_COMBINING_TEST.
  assert.equal(
    snapshot.policies.some(
      (policy) => policy.rule.effect.value === "require_approval",
    ),
    false,
  );

  const noMatch = corpus.cases.find(
    (entry) => entry.name === "wrong-pack-default-deny",
  );
  assert.ok(noMatch);
  const noMatchDecision = evaluatePolicySnapshot(snapshot, noMatch.action, {
    secretCorrelationToken: TOKEN,
  });
  assert.equal(noMatchDecision.effect, "deny");
  assert.equal(noMatchDecision.winningPolicyName, null);
  assert.equal(noMatchDecision.reason, DEFAULT_REASON);

  // The production file deliberately has two priority-600 rules. This
  // independent UTF-8 identity oracle fixes the reviewed order that would apply
  // if their currently disjoint read/release predicates ever became able to
  // overlap. Evaluator tie selection remains exercised by GENERIC_COMBINING_TEST.
  const tiedPolicies = snapshot.policies.filter(
    (policy) => policy.rule.priority.value === 600,
  );
  assert.equal(tiedPolicies.length, 2);
  assert.deepEqual(
    [...tiedPolicies]
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.rule.name.value, "utf8"),
          Buffer.from(right.rule.name.value, "utf8"),
        ),
      )
      .map((policy) => policy.rule.name.value),
    ["allow-reviewed-context-reads", "allow-reviewed-context-releases"],
  );
  assert.deepEqual(
    tiedPolicies.map((policy) =>
      policy.comparisons
        .filter((comparison) => comparison.attribute.name === "action.operation")
        .map((comparison) =>
          comparison.expression.right.kind === "string"
            ? comparison.expression.right.value
            : null,
        ),
    ),
    [["context.read"], ["context.release"]],
  );

  const missingOptional = corpus.cases.find(
    (entry) => entry.name === "missing-truncated-default-deny",
  );
  assert.ok(missingOptional);
  const truncatedComparison = snapshot.policies
    .flatMap((policy) => policy.comparisons)
    .find((comparison) => comparison.attribute.name === "context.truncated");
  assert.ok(truncatedComparison);
  assert.equal(truncatedComparison.attribute.optional, true);
  assert.equal(
    evaluatePolicySnapshot(snapshot, missingOptional.action, {
      secretCorrelationToken: TOKEN,
    }).winningPolicyName,
    null,
  );

  // This policy/catalog composition has no canonical-path or command
  // predicate. Canonical path enforcement is concretely covered by the
  // policy-engine tests "anchored path globs are case-sensitive and separator-
  // independent" and "canonical-path list matches are existential, bounded by
  // presence, and secret-safe"; command equivalence is structurally irrelevant.
  assert.equal(
    snapshot.policies
      .flatMap((policy) => policy.comparisons)
      .some((comparison) => comparison.attribute.matchKind === "canonical_path"),
    false,
  );
  assert.equal(source.includes("repo."), false);
  assert.equal(source.includes("process."), false);

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.policies), true);
  for (const policy of snapshot.policies) {
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.rule), true);
    assert.equal(Object.isFrozen(policy.comparisons), true);
  }
  assert.equal(
    Reflect.set(
      snapshot as unknown as Record<string, unknown>,
      "defaultEffect",
      "allow",
    ),
    false,
  );
  assert.equal(snapshot.defaultEffect, "deny");

  const legacyFixture = structuredClone(fixture) as {
    cases: Array<{ action: Record<string, unknown> }>;
  };
  assert.ok(legacyFixture.cases[0]);
  legacyFixture.cases[0].action["schemaVersion"] = 0;
  assert.throws(() =>
    parsePolicyCaseCorpus(legacyFixture, {
      maximumBytes: 128 * 1024,
      maximumCases: MAXIMUM_REVIEWED_CASES,
    }),
  );

  const reviewedCoverage = [
    ["matching example per rule", "covered", "four named corpus matches"],
    ["near miss per rule", "covered", "four named false-rule traces"],
    [
      "deny precedence over allow",
      "structurally inapplicable",
      `disjoint classification/network predicates; ${GENERIC_COMBINING_TEST}`,
    ],
    [
      "approval precedence over allow",
      "structurally inapplicable",
      `no approval rule; ${GENERIC_COMBINING_TEST}`,
    ],
    ["no-match default", "covered", "wrong-pack-default-deny"],
    [
      "equal-priority deterministic order",
      "structurally inapplicable",
      `disjoint read/release predicates with a stable priority-600 identity oracle; ${GENERIC_COMBINING_TEST}`,
    ],
    [
      "missing optional attributes",
      "covered",
      "missing-truncated-default-deny",
    ],
    [
      "canonically equivalent paths and commands",
      "structurally inapplicable",
      "no canonical-path/process predicate; named policy-engine path tests",
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
    OPERATIONS_PLAN_POLICY_CATEGORIES,
  );
});

test("the context policy rollout has exact change counts from the fail-closed baseline", async () => {
  const baseline = compileContextPolicySource(
    FAIL_CLOSED_ROLLOUT_BASELINE,
    POLICY_ID,
  );
  const candidate = await compileContextPolicy(CANDIDATE_POLICY_ID);
  assert.equal(candidate.contentHash, EXPECTED_POLICY_CONTENT_HASH);
  assert.deepEqual(
    baseline.policies.map((policy) => ({
      name: policy.rule.name.value,
      priority: policy.rule.priority.value,
      effect: policy.rule.effect.value,
      comparisons: policy.comparisons.map((comparison) => ({
        attribute: comparison.attribute.name,
        operator: comparison.expression.operator,
        expected:
          comparison.expression.right.kind === "string"
            ? comparison.expression.right.value
            : null,
      })),
    })),
    [
      {
        name: "baseline-no-installed-policy",
        priority: 1,
        effect: "deny",
        comparisons: [
          {
            attribute: "action.pack",
            operator: "==",
            expected: "guard.baseline-no-installed-policy",
          },
        ],
      },
    ],
  );
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/context-policy-cases-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const corpus = parsePolicyCaseCorpus(fixture, {
    maximumBytes: 128 * 1024,
    maximumCases: MAXIMUM_REVIEWED_CASES,
  });
  for (const entry of corpus.cases) {
    const baselineDecision = evaluatePolicySnapshot(baseline, entry.action, {
      secretCorrelationToken: "context-policy-baseline-token-0001",
    });
    assert.equal(baselineDecision.effect, "deny");
    assert.equal(baselineDecision.winningPolicyName, null);
    assert.deepEqual(baselineDecision.matchedPolicyNames, []);
  }
  const simulation = simulatePolicyPage({
    from: baseline,
    to: candidate,
    actions: corpus.cases.map((entry) => entry.action),
    secretCorrelationToken: "context-policy-simulation-token-0001",
    pageSize: 1000,
  });
  assert.deepEqual(simulation.counts, {
    newly_allowed: 4,
    newly_denied: 0,
    newly_approval_gated: 0,
    approval_removed: 0,
    same_effect_different_explanation: 8,
    unchanged: 0,
    evaluation_error: 0,
  });
  assert.equal(simulation.entries.length, MAXIMUM_REVIEWED_CASES);
  assert.equal(simulation.nextCursor, null);
  const newlyAllowed = simulation.entries.filter(
    (entry) => entry.category === "newly_allowed",
  );
  assert.equal(newlyAllowed.length, 4);
  for (const entry of newlyAllowed) {
    assert.equal(
      corpus.cases.find(
        (candidate) => candidate.action.actionId === entry.actionId,
      )?.action.sideEffectClass,
      "none",
    );
  }
});

test("a real compiled policy governs generic source and capability releases", async () => {
  const snapshot = await compileContextPolicy();
  const evaluator = createPinnedPolicyEvaluator(snapshot, {
    secretCorrelationToken: TOKEN,
  });
  const releasePolicy = createContextReleasePolicySnapshot({
    releasePolicyId: "context.reviewed-default",
    releasePolicyVersion: 1,
    secretDisposition: "redact",
    promptInjectionDisposition: "tag",
    truncatedDisposition: "deny",
  });
  const source = memorySource("internal");
  const factory = createContextBrokerIntegrationFactory({
    policySnapshotId: snapshot.policyVersionId,
    releasePolicy,
    sources: new BrokerContextSourceRegistry([source]),
    policy: createPinnedContextPolicyAdapter({ evaluator, releasePolicy }),
    budgets: BUDGETS,
  });
  const integration = factory.createForRun({ runId: "run.real-context-policy" });
  const controller = new AbortController();
  const sourceRelease = await integration.releasePlannedSource({
    turnId: "turn.real-context-policy",
    sourceId: source.descriptor.sourceId,
    sourceVersion: source.descriptor.sourceVersion,
    request: { recordId: "reviewed" },
    maximumBytes: 8 * 1024,
    reason: "task.context",
    signal: controller.signal,
  });
  assert.equal(sourceRelease.status, "released");

  const capabilityRelease = await integration.releaseCapabilityAgentView({
    turnId: "turn.real-context-policy",
    sourceVersion: 1,
    resource: canonicalizeResourceRef({
      schemaVersion: 1,
      scheme: "memory",
      sourceId: "fixture.capability",
      locator: { recordId: "capability-output" },
      mediaType: "application/json",
      classification: "internal",
    }),
    policyProjection: {
      schemaVersion: 1,
      catalogId: MEMORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
      catalogVersion: MEMORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
      catalogContentHash: MEMORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
      resourceAttributes: { recordId: "capability-output" },
      requestAttributes: {},
    },
    output: { summary: "reviewed capability output" },
    classification: "internal",
    reason: "capability.output",
  });
  assert.equal(capabilityRelease.status, "released");
  if (sourceRelease.status !== "released" || capabilityRelease.status !== "released") {
    throw new Error("unreachable real-policy release denial");
  }
  const assembly = await integration.assembleAgentContext({
    turnId: "turn.real-context-policy",
    agentRequestId: "agent.real-context-policy",
    orderedItemIds: [sourceRelease.item.itemId, capabilityRelease.item.itemId],
  });
  assert.equal(assembly.items.length, 2);
  assert.equal(assembly.manifest.policySnapshotId, snapshot.policyVersionId);
  assert.equal(assembly.manifest.releasePolicyContentHash, releasePolicy.contentHash);
});

test("the real policy denies restricted metadata before the source opens", async () => {
  const snapshot = await compileContextPolicy();
  const releasePolicy = createContextReleasePolicySnapshot({
    releasePolicyId: "context.reviewed-default",
    releasePolicyVersion: 1,
    secretDisposition: "deny",
    promptInjectionDisposition: "deny",
    truncatedDisposition: "deny",
  });
  const delegate = memorySource("restricted");
  let opens = 0;
  const counted: BrokerContextSource = Object.freeze({
    descriptor: delegate.descriptor,
    normalizeResourceRequest: delegate.normalizeResourceRequest.bind(delegate),
    inspectMetadata: delegate.inspectMetadata.bind(delegate),
    async openBounded(
      ...args: Parameters<BrokerContextSource["openBounded"]>
    ) {
      opens += 1;
      return delegate.openBounded(...args);
    },
  });
  const factory = createContextBrokerIntegrationFactory({
    policySnapshotId: snapshot.policyVersionId,
    releasePolicy,
    sources: new BrokerContextSourceRegistry([counted]),
    policy: createPinnedContextPolicyAdapter({
      evaluator: createPinnedPolicyEvaluator(snapshot, {
        secretCorrelationToken: TOKEN,
      }),
      releasePolicy,
    }),
    budgets: BUDGETS,
  });
  const result = await factory
    .createForRun({ runId: "run.real-context-denial" })
    .releasePlannedSource({
      turnId: "turn.real-context-denial",
      sourceId: counted.descriptor.sourceId,
      sourceVersion: counted.descriptor.sourceVersion,
      request: { recordId: "reviewed" },
      maximumBytes: 8 * 1024,
      reason: "task.context",
      signal: new AbortController().signal,
    });
  assert.equal(result.status, "denied");
  assert.equal(result.manifest.reason, "context.policy.metadata_denied");
  assert.equal(opens, 0);
});

async function compileContextPolicy(policyVersionId: string = POLICY_ID) {
  const source = await readFile(
    new URL("../../../policies/context.guard", import.meta.url),
    "utf8",
  );
  return compileContextPolicySource(source, policyVersionId);
}

function compileContextPolicySource(source: string, policyVersionId: string) {
  const compiled = compilePolicySnapshot(
    {
      policyVersionId,
      source,
      sourceId: "policies/context.guard",
      defaultEffect: "deny",
    },
    {},
    composePolicyAttributeCatalogs([
      BASE_POLICY_ATTRIBUTE_CATALOG,
      CONTEXT_POLICY_ATTRIBUTE_CATALOG,
      MEMORY_POLICY_ATTRIBUTE_CATALOG,
    ]),
  );
  assert.equal(
    compiled.ok,
    true,
    compiled.ok ? "" : JSON.stringify(compiled.diagnostics),
  );
  if (!compiled.ok) throw new Error("unreachable context-policy compile failure");
  return compiled.snapshot;
}

function collectLogicalOperators(input: unknown): readonly ("and" | "or")[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return [];
  }
  const expression = input as Readonly<Record<string, unknown>>;
  if (
    expression["kind"] === "logical" &&
    (expression["operator"] === "and" || expression["operator"] === "or")
  ) {
    return Object.freeze([
      expression["operator"],
      ...collectLogicalOperators(expression["left"]),
      ...collectLogicalOperators(expression["right"]),
    ]);
  }
  if (expression["kind"] === "group") {
    return collectLogicalOperators(expression["expression"]);
  }
  if (expression["kind"] === "not") {
    return collectLogicalOperators(expression["operand"]);
  }
  return [];
}

function memorySource(classification: string): InMemoryBrokerSource {
  return new InMemoryBrokerSource({
    descriptor: {
      sourceId: "memory.reviewed",
      sourceVersion: 1,
      scheme: "memory",
      description: "Real-policy generic source fixture.",
    },
    records: [
      {
        recordId: "reviewed",
        content: "bounded reviewed context",
        mediaType: "text/plain",
        classification,
      },
    ],
    maximumRecords: 1,
    maximumRecordBytes: 1_024,
  });
}
