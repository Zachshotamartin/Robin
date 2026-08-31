import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalize, parseNormalizedAction } from "@guard/contracts";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG_SET,
  compilePolicySnapshot,
  evaluatePolicySnapshot,
  parsePolicyCaseCorpus,
  runPolicyCaseCorpus,
  simulatePolicyPage,
} from "@guard/policy-engine";

import {
  MAXIMUM_POLICY_SOURCE_BYTES,
  POLICY_COMMAND_EXIT_CODES,
  executePolicyCommand,
  type PolicyCommandDependencies,
} from "./policy-commands.js";

const POLICY = `policy "allow-pure" priority 50 {
  when action.side_effect == "none"
  allow
  reason "Pure actions are allowed."
}
`;

const DENY_POLICY = `policy "deny-pure" priority 100 {
  when action.side_effect == "none"
  deny
  reason "Pure actions are denied by the candidate policy."
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
const FAIL_CLOSED_ROLLOUT_BASELINE = `policy "baseline-no-installed-policy" priority 1 {
  when action.pack == "guard.baseline-no-installed-policy"
  deny
  reason "No reviewed policy was installed in the fail-closed baseline."
}
`;

const ACTION = parseNormalizedAction({
  schemaVersion: 1,
  actionId: "act_018f05a0-7b01-7000-8000-00000000b011",
  capabilityPackId: "fixture",
  capabilityPackVersion: 1,
  operationId: "read",
  operationVersion: 1,
  subject: { kind: "agent" },
  resource: {
    scheme: "memory",
    sourceId: "fixture.source",
    classification: "internal",
  },
  environment: {
    sandboxed: true,
    networkProfile: "disabled",
    trustLevel: "fixture",
  },
  request: { intent: "inspect" },
  normalizedInput: {},
  sideEffectClass: "none",
  preconditions: [],
});

test("check keeps content identity stable while assigning fresh snapshot IDs", async () => {
  const files = new Map<string, string>([["valid.guard", POLICY]]);
  const valid = await executePolicyCommand(
    {
      kind: "policy-check",
      policyPath: "valid.guard",
      defaultEffect: "deny",
      catalogPaths: [],
      format: "json",
    },
    dependencies(files),
  );
  assert.equal(valid.exitCode, POLICY_COMMAND_EXIT_CODES.success);
  assert.equal(valid.stderr, "");
  const payload = JSON.parse(valid.stdout) as Record<string, unknown>;
  assert.equal(payload["ok"], true);
  assert.equal(payload["policyCount"], 1);
  assert.match(
    (payload["policy"] as Record<string, unknown>)["policyContentHash"] as string,
    /^[0-9a-f]{64}$/u,
  );
  const repeated = await executePolicyCommand(
    {
      kind: "policy-check",
      policyPath: "valid.guard",
      defaultEffect: "deny",
      catalogPaths: [],
      format: "json",
    },
    dependencies(files),
  );
  const repeatedPayload = JSON.parse(repeated.stdout) as {
    readonly policy: {
      readonly policyVersionId: string;
      readonly policyContentHash: string;
    };
  };
  const firstPolicy = payload["policy"] as {
    readonly policyVersionId: string;
    readonly policyContentHash: string;
  };
  assert.notEqual(repeatedPayload.policy.policyVersionId, firstPolicy.policyVersionId);
  assert.equal(
    repeatedPayload.policy.policyContentHash,
    firstPolicy.policyContentHash,
  );

  files.set(
    "invalid.guard",
    `policy "one" priority 1 { when action.operation == allow reason "x" }
policy "two" priority 2 { when missing.attribute == 1 deny reason "y" }
`,
  );
  const invalid = await executePolicyCommand(
    {
      kind: "policy-check",
      policyPath: "invalid.guard",
      defaultEffect: "deny",
      catalogPaths: [],
      format: "json",
    },
    dependencies(files),
  );
  assert.equal(invalid.exitCode, POLICY_COMMAND_EXIT_CODES.invalidConfiguration);
  assert.equal(invalid.stdout, "");
  const invalidPayload = JSON.parse(invalid.stderr) as {
    readonly ok: boolean;
    readonly diagnostics: readonly unknown[];
  };
  assert.equal(invalidPayload.ok, false);
  assert.ok(invalidPayload.diagnostics.length >= 2);
});

test("format returns canonical source and rejects invalid syntax", async () => {
  const files = new Map<string, string>([
    [
      "messy.guard",
      'policy "allow-pure" priority 50 { when action.side_effect=="none" allow reason "Pure actions are allowed." }',
    ],
  ]);
  const result = await executePolicyCommand(
    { kind: "policy-format", policyPath: "messy.guard", format: "human" },
    dependencies(files),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, POLICY);

  files.set("broken.guard", 'policy "broken" priority {');
  const broken = await executePolicyCommand(
    { kind: "policy-format", policyPath: "broken.guard", format: "human" },
    dependencies(files),
  );
  assert.equal(broken.exitCode, 2);
  assert.match(broken.stderr, /Policy is invalid/u);
});

test("table tests bind the exact snapshot hash and return a failing exit code", async () => {
  const files = new Map<string, string>([["policy.guard", POLICY]]);
  const check = await executePolicyCommand(
    {
      kind: "policy-check",
      policyPath: "policy.guard",
      defaultEffect: "deny",
      catalogPaths: [],
      format: "json",
    },
    dependencies(files),
  );
  const checkPayload = JSON.parse(check.stdout) as {
    readonly policy: { readonly policyContentHash: string };
  };
  files.set(
    "cases.json",
    canonicalize({
      schemaVersion: 1,
      policyContentHash: checkPayload.policy.policyContentHash,
      cases: [
        {
          schemaVersion: 1,
          caseId: "expected-mismatch",
          action: ACTION,
          expectedEffect: "deny",
          expectedWinningPolicyName: null,
        },
      ],
    }),
  );
  const result = await executePolicyCommand(
    {
      kind: "policy-test",
      policyPath: "policy.guard",
      casePath: "cases.json",
      defaultEffect: "deny",
      catalogPaths: [],
      format: "json",
    },
    dependencies(files),
  );
  assert.equal(result.exitCode, POLICY_COMMAND_EXIT_CODES.testFailed);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout) as {
    readonly passed: number;
    readonly failed: number;
  };
  assert.deepEqual(payload, { ...payload, passed: 0, failed: 1 });
});

test("each shipped pure policy owns a reviewed section 8.7 matrix and rollout simulation", async () => {
  const reviews = [
    {
      fileName: "allow-pure.guard",
      corpusName: "allow-pure-policy-cases-v1.json",
      source: POLICY,
      contentHash:
        "cc26b15a29b9331e789db47a2350ddebf7c5c2fd59d4679cd2919f7aeb353869",
      ruleName: "allow-pure",
      priority: 50,
      effect: "allow",
    },
    {
      fileName: "deny-pure.guard",
      corpusName: "deny-pure-policy-cases-v1.json",
      source: DENY_POLICY,
      contentHash:
        "c54cb84fa50f25477af4ecc4ea4a80fbaf101ac90b04f6186653c0600f65face",
      ruleName: "deny-pure",
      priority: 100,
      effect: "deny",
    },
  ] as const;

  for (const review of reviews) {
    const source = await readFile(
      new URL(`../testdata/${review.fileName}`, import.meta.url),
      "utf8",
    );
    assert.equal(source, review.source);
    const compiled = compilePolicySnapshot(
      {
        policyVersionId: "pol_018f05a0-7b01-7000-8000-00000000b051",
        source,
        sourceId: "<cli-policy>",
        defaultEffect: "deny",
      },
      {},
      BASE_POLICY_ATTRIBUTE_CATALOG_SET,
    );
    assert.equal(
      compiled.ok,
      true,
      compiled.ok ? "" : JSON.stringify(compiled.diagnostics),
    );
    if (!compiled.ok) throw new Error("unreachable pure-policy compile failure");
    const snapshot = compiled.snapshot;
    assert.equal(snapshot.contentHash, review.contentHash);
    assert.deepEqual(
      snapshot.policies.map((policy) => ({
        name: policy.rule.name.value,
        priority: policy.rule.priority.value,
        effect: policy.rule.effect.value,
      })),
      [
        {
          name: review.ruleName,
          priority: review.priority,
          effect: review.effect,
        },
      ],
    );
    const onlyRule = snapshot.policies[0];
    assert.ok(onlyRule);
    assert.equal(onlyRule.rule.condition.kind, "comparison");
    assert.deepEqual(
      onlyRule.comparisons.map((comparison) => ({
        attribute: comparison.attribute.name,
        optional: comparison.attribute.optional,
        matchKind: comparison.attribute.matchKind,
        operator: comparison.expression.operator,
        expected:
          comparison.expression.right.kind === "string"
            ? comparison.expression.right.value
            : null,
      })),
      [
        {
          attribute: "action.side_effect",
          optional: false,
          matchKind: "none",
          operator: "==",
          expected: "none",
        },
      ],
    );

    const fixture: unknown = JSON.parse(
      await readFile(
        new URL(`../testdata/${review.corpusName}`, import.meta.url),
        "utf8",
      ),
    );
    const corpus = parsePolicyCaseCorpus(fixture, {
      maximumBytes: 32 * 1024,
      maximumCases: 2,
    });
    assert.equal(corpus.schemaVersion, 1);
    assert.equal(corpus.policyContentHash, review.contentHash);
    assert.deepEqual(
      corpus.cases.map((entry) => entry.name),
      [
        `${review.ruleName}-match`,
        `${review.ruleName}-near-miss-default-deny`,
      ],
    );
    const run = runPolicyCaseCorpus(
      snapshot,
      corpus,
      "pure-policy-corpus-correlation-token-0001",
    );
    assert.equal(
      run.failed,
      0,
      JSON.stringify(run.cases.filter((entry) => !entry.passed)),
    );
    assert.equal(run.passed, 2);

    const matching = corpus.cases[0];
    const nearMiss = corpus.cases[1];
    assert.ok(matching);
    assert.ok(nearMiss);
    assert.deepEqual(
      evaluatePolicySnapshot(snapshot, matching.action, {
        secretCorrelationToken: "pure-policy-matrix-token-0001",
      }).matchedPolicyNames,
      [review.ruleName],
    );
    const noMatchDecision = evaluatePolicySnapshot(snapshot, nearMiss.action, {
      secretCorrelationToken: "pure-policy-matrix-token-0001",
    });
    assert.equal(noMatchDecision.effect, "deny");
    assert.equal(noMatchDecision.winningPolicyName, null);
    assert.equal(
      noMatchDecision.reason,
      "No policy matched; the immutable snapshot default effect applies.",
    );
    assert.deepEqual(noMatchDecision.matchedPolicyNames, []);
    const evaluations = noMatchDecision.trace["evaluations"] as readonly Readonly<
      Record<string, unknown>
    >[];
    assert.equal(evaluations[0]?.["policyName"], review.ruleName);
    assert.equal(evaluations[0]?.["result"], "false");
    // The exact single-rule/single-effect shape makes all combining and tie
    // categories structurally inapplicable. Its only predicate consumes the
    // required side-effect attribute, so optional/canonical cases are likewise
    // structurally irrelevant. Any new predicate invalidates these assertions.
    assert.equal(snapshot.policies.length, 1);
    assert.equal(
      snapshot.policies.some(
        (policy) => policy.rule.effect.value === "require_approval",
      ),
      false,
    );
    assert.equal(source.includes("repo."), false);
    assert.equal(source.includes("process."), false);

    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.policies), true);
    assert.equal(Object.isFrozen(onlyRule), true);
    assert.equal(Object.isFrozen(onlyRule.rule), true);
    assert.equal(Object.isFrozen(onlyRule.comparisons), true);
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
        maximumBytes: 32 * 1024,
        maximumCases: 2,
      }),
    );

    const baseline = compilePolicySnapshot(
      {
        policyVersionId: "pol_018f05a0-7b01-7000-8000-00000000b052",
        source: FAIL_CLOSED_ROLLOUT_BASELINE,
        sourceId: "<cli-policy>",
        defaultEffect: "deny",
      },
      {},
      BASE_POLICY_ATTRIBUTE_CATALOG_SET,
    );
    assert.equal(
      baseline.ok,
      true,
      baseline.ok ? "" : JSON.stringify(baseline.diagnostics),
    );
    if (!baseline.ok) throw new Error("unreachable pure-policy baseline failure");
    assert.deepEqual(
      baseline.snapshot.policies.map((policy) => ({
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
    for (const entry of corpus.cases) {
      const baselineDecision = evaluatePolicySnapshot(
        baseline.snapshot,
        entry.action,
        { secretCorrelationToken: "pure-policy-baseline-token-0001" },
      );
      assert.equal(baselineDecision.effect, "deny");
      assert.equal(baselineDecision.winningPolicyName, null);
      assert.deepEqual(baselineDecision.matchedPolicyNames, []);
    }
    const simulation = simulatePolicyPage({
      from: baseline.snapshot,
      to: snapshot,
      actions: corpus.cases.map((entry) => entry.action),
      secretCorrelationToken: "pure-policy-simulation-token-0001",
      pageSize: 1000,
    });
    assert.deepEqual(simulation.counts, {
      newly_allowed: review.effect === "allow" ? 1 : 0,
      newly_denied: 0,
      newly_approval_gated: 0,
      approval_removed: 0,
      same_effect_different_explanation: review.effect === "allow" ? 1 : 2,
      unchanged: 0,
      evaluation_error: 0,
    });
    assert.equal(simulation.nextCursor, null);
    const newlyAllowed = simulation.entries.filter(
      (entry) => entry.category === "newly_allowed",
    );
    assert.equal(newlyAllowed.length, review.effect === "allow" ? 1 : 0);
    for (const entry of newlyAllowed) {
      assert.equal(
        corpus.cases.find(
          (candidate) => candidate.action.actionId === entry.actionId,
        )?.action.sideEffectClass,
        "none",
      );
    }

    const reviewedCoverage = [
      ["matching example per rule", "covered", `${review.ruleName}-match`],
      [
        "near miss per rule",
        "covered",
        `${review.ruleName}-near-miss-default-deny`,
      ],
      [
        "deny precedence over allow",
        "structurally inapplicable",
        "one rule and one effect; generic policy-engine combining test",
      ],
      [
        "approval precedence over allow",
        "structurally inapplicable",
        "one rule and no approval effect; generic policy-engine combining test",
      ],
      [
        "no-match default",
        "covered",
        `${review.ruleName}-near-miss-default-deny`,
      ],
      [
        "equal-priority deterministic order",
        "structurally inapplicable",
        "one rule; generic policy-engine UTF-8 tie-order test",
      ],
      [
        "missing optional attributes",
        "structurally inapplicable",
        "only required action.side_effect predicate",
      ],
      [
        "canonically equivalent paths and commands",
        "structurally inapplicable",
        "only required action.side_effect predicate",
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
  }
});

test("the shipped strict fixture is byte- and corpus-bound to the reviewed production policy", async () => {
  const [fixtureSource, productionSource, fixtureRaw, productionRaw] =
    await Promise.all([
      readFile(new URL("../testdata/strict.guard", import.meta.url), "utf8"),
      readFile(new URL("../../../policies/strict.guard", import.meta.url), "utf8"),
      readFile(new URL("../testdata/policy-cases-v1.json", import.meta.url), "utf8"),
      readFile(
        new URL("../../../packages/policy-engine/testdata/policy-cases-v1.json", import.meta.url),
        "utf8",
      ),
    ]);
  assert.equal(fixtureSource, productionSource);
  const fixture = JSON.parse(fixtureRaw) as {
    readonly schemaVersion: number;
    readonly policyContentHash: string;
    readonly cases: readonly unknown[];
  };
  const production = JSON.parse(productionRaw) as {
    readonly schemaVersion: number;
    readonly policyContentHash: string;
    readonly cases: readonly unknown[];
  };
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(production.schemaVersion, 1);
  assert.equal(
    fixture.policyContentHash,
    "e7f43be0fec5502f6005a801395e6f5cd2d6893cd70e4f3bad4f70b3abad7572",
  );
  assert.equal(
    production.policyContentHash,
    "0166089a357eb392aa21c1229472e7568313a47b471f8887dbcfee09536304b2",
  );
  assert.equal(fixture.cases.length, 31);
  assert.deepEqual(fixture.cases, production.cases);
  const compiled = compilePolicySnapshot(
    {
      policyVersionId: "pol_018f05a0-7b01-7000-8000-00000000b053",
      source: fixtureSource,
      sourceId: "<cli-policy>",
      defaultEffect: "deny",
    },
    {},
    BASE_POLICY_ATTRIBUTE_CATALOG_SET,
  );
  assert.equal(
    compiled.ok,
    true,
    compiled.ok ? "" : JSON.stringify(compiled.diagnostics),
  );
  if (!compiled.ok) throw new Error("unreachable strict fixture compile failure");
  assert.equal(compiled.snapshot.contentHash, fixture.policyContentHash);
  const corpus = parsePolicyCaseCorpus(fixture, {
    maximumBytes: 128 * 1024,
    maximumCases: 31,
  });
  const run = runPolicyCaseCorpus(
    compiled.snapshot,
    corpus,
    "strict-cli-copy-corpus-token-0001",
  );
  assert.equal(
    run.failed,
    0,
    JSON.stringify(run.cases.filter((entry) => !entry.passed)),
  );
  assert.equal(run.passed, 31);
});

test("explain uses composed catalogs without exposing secrets or run tokens", async () => {
  const secret = "fixture-secret-value-that-must-not-render";
  const token = "fixture-correlation-token-that-must-not-render";
  const files = new Map<string, string>([
    [
      "secret.guard",
      `policy "deny-secret" priority 100 {
  when fixture.secret == "${secret}"
  deny
  reason "Secret input is denied."
}
`,
    ],
    [
      "catalog.json",
      canonicalize({
        catalogId: "fixture.secret",
        schemaVersion: 1,
        attributes: [
          {
            name: "fixture.secret",
            type: "string",
            optional: true,
            secretClassification: "fixture_secret",
            matchKind: "none",
            source: {
              kind: "object_field",
              section: "request",
              field: "secret",
            },
          },
        ],
      }),
    ],
    ["action.json", canonicalize({ ...ACTION, request: { intent: "inspect", secret } })],
  ]);
  const result = await executePolicyCommand(
    {
      kind: "policy-explain",
      policyPath: "secret.guard",
      actionPath: "action.json",
      defaultEffect: "deny",
      catalogPaths: ["catalog.json"],
      format: "json",
    },
    dependencies(files, token),
  );
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, new RegExp(secret, "u"));
  assert.doesNotMatch(result.stdout, new RegExp(token, "u"));
  assert.match(result.stdout, /fixture_secret/u);
  assert.match(result.stdout, /<redacted-per-run-token>/u);
});

test("simulation classifies changes and emits a resumable bound cursor", async () => {
  const second = Object.freeze({
    ...ACTION,
    actionId: "act_018f05a0-7b01-7000-8000-00000000b012",
  });
  const files = new Map<string, string>([
    ["old.guard", POLICY],
    ["new.guard", DENY_POLICY],
    [
      "actions.json",
      canonicalize({ schemaVersion: 1, actions: [second, ACTION] }),
    ],
  ]);
  const first = await executePolicyCommand(
    {
      kind: "policy-simulate",
      fromPolicyPath: "old.guard",
      toPolicyPath: "new.guard",
      actionCorpusPath: "actions.json",
      fromDefaultEffect: "deny",
      toDefaultEffect: "deny",
      catalogPaths: [],
      fromCatalogPaths: [],
      toCatalogPaths: [],
      pageSize: 1,
      cursor: null,
      format: "json",
    },
    dependencies(files),
  );
  assert.equal(first.exitCode, 0);
  const firstPayload = JSON.parse(first.stdout) as {
    readonly entries: readonly { readonly actionId: string; readonly category: string }[];
    readonly counts: Readonly<Record<string, number>>;
    readonly pageCounts: Readonly<Record<string, number>>;
    readonly totalActions: number;
    readonly nextCursor: string | null;
  };
  assert.equal(firstPayload.entries[0]?.actionId, ACTION.actionId);
  assert.equal(firstPayload.entries[0]?.category, "newly_denied");
  assert.equal(firstPayload.pageCounts["newly_denied"], 1);
  assert.equal(firstPayload.counts["newly_denied"], 2);
  assert.equal(firstPayload.totalActions, 2);
  assert.notEqual(firstPayload.nextCursor, null);

  const secondPage = await executePolicyCommand(
    {
      kind: "policy-simulate",
      fromPolicyPath: "old.guard",
      toPolicyPath: "new.guard",
      actionCorpusPath: "actions.json",
      fromDefaultEffect: "deny",
      toDefaultEffect: "deny",
      catalogPaths: [],
      fromCatalogPaths: [],
      toCatalogPaths: [],
      pageSize: 1,
      cursor: firstPayload.nextCursor,
      format: "json",
    },
    dependencies(files),
  );
  const secondPayload = JSON.parse(secondPage.stdout) as {
    readonly entries: readonly { readonly actionId: string }[];
    readonly counts: Readonly<Record<string, number>>;
    readonly pageCounts: Readonly<Record<string, number>>;
    readonly totalActions: number;
    readonly nextCursor: string | null;
  };
  assert.equal(secondPayload.entries[0]?.actionId, second.actionId);
  assert.equal(secondPayload.pageCounts["newly_denied"], 1);
  assert.equal(secondPayload.counts["newly_denied"], 2);
  assert.equal(secondPayload.totalActions, 2);
  assert.equal(secondPayload.nextCursor, null);
});

test("simulation composes snapshot-specific catalogs independently", async () => {
  const toPolicy = `policy "deny-risk" priority 100 {
  when fixture.risk == "high"
  deny
  reason "Candidate-specific risk is denied."
}
`;
  const catalog = canonicalize({
    catalogId: "fixture.to-only",
    schemaVersion: 1,
    attributes: [
      {
        name: "fixture.risk",
        type: "string",
        optional: true,
        secretClassification: null,
        matchKind: "none",
        source: {
          kind: "object_field",
          section: "request",
          field: "risk",
        },
      },
    ],
  });
  const action = { ...ACTION, request: { intent: "inspect", risk: "high" } };
  const files = new Map<string, string>([
    ["old.guard", POLICY],
    ["new.guard", toPolicy],
    ["to-catalog.json", catalog],
    ["actions.json", canonicalize({ schemaVersion: 1, actions: [action] })],
  ]);
  const result = await executePolicyCommand(
    {
      kind: "policy-simulate",
      fromPolicyPath: "old.guard",
      toPolicyPath: "new.guard",
      actionCorpusPath: "actions.json",
      fromDefaultEffect: "deny",
      toDefaultEffect: "deny",
      catalogPaths: [],
      fromCatalogPaths: [],
      toCatalogPaths: ["to-catalog.json"],
      pageSize: 100,
      cursor: null,
      format: "json",
    },
    dependencies(files),
  );
  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as {
    readonly entries: readonly { readonly category: string }[];
  };
  assert.equal(payload.entries[0]?.category, "newly_denied");
});

test("simulation treats identical snapshots as unchanged", async () => {
  const files = new Map<string, string>([
    ["old.guard", POLICY],
    ["new.guard", POLICY],
    ["actions.json", canonicalize({ schemaVersion: 1, actions: [ACTION] })],
  ]);
  const result = await executePolicyCommand(
    {
      kind: "policy-simulate",
      fromPolicyPath: "old.guard",
      toPolicyPath: "new.guard",
      actionCorpusPath: "actions.json",
      fromDefaultEffect: "deny",
      toDefaultEffect: "deny",
      catalogPaths: [],
      fromCatalogPaths: [],
      toCatalogPaths: [],
      pageSize: 100,
      cursor: null,
      format: "json",
    },
    dependencies(files),
  );
  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as {
    readonly fromPolicyContentHash: string;
    readonly toPolicyContentHash: string;
    readonly entries: readonly { readonly category: string }[];
  };
  assert.equal(payload.fromPolicyContentHash, payload.toPolicyContentHash);
  assert.equal(payload.entries[0]?.category, "unchanged");
});

test("default file reader accepts the exact source limit and rejects one byte more", async () => {
  const directory = await mkdtemp(join(tmpdir(), "robin-policy-bound-"));
  const exactPath = join(directory, "exact.guard");
  const oversizedPath = join(directory, "oversized.guard");
  await writeFile(exactPath, Buffer.alloc(MAXIMUM_POLICY_SOURCE_BYTES, 0x20));
  await writeFile(
    oversizedPath,
    Buffer.alloc(MAXIMUM_POLICY_SOURCE_BYTES + 1, 0x20),
  );
  const exact = await executePolicyCommand({
    kind: "policy-format",
    policyPath: exactPath,
    format: "human",
  });
  assert.equal(exact.exitCode, 0);
  assert.equal(exact.stdout, "");

  const oversized = await executePolicyCommand({
    kind: "policy-format",
    policyPath: oversizedPath,
    format: "human",
  });
  assert.equal(oversized.exitCode, 2);
  assert.match(oversized.stderr, /bounded regular file/u);
});

test("default file reader rejects invalid UTF-8 and symbolic-link inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "robin-policy-file-kind-"));
  const invalidUtf8Path = join(directory, "invalid.guard");
  const policyPath = join(directory, "policy.guard");
  const symbolicPath = join(directory, "policy-link.guard");
  await writeFile(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
  await writeFile(policyPath, POLICY, "utf8");
  await symlink(policyPath, symbolicPath);

  const invalidUtf8 = await executePolicyCommand({
    kind: "policy-format",
    policyPath: invalidUtf8Path,
    format: "human",
  });
  assert.equal(invalidUtf8.exitCode, 2);
  assert.match(invalidUtf8.stderr, /valid UTF-8/u);

  const symbolic = await executePolicyCommand({
    kind: "policy-format",
    policyPath: symbolicPath,
    format: "human",
  });
  assert.equal(symbolic.exitCode, 2);
  assert.match(symbolic.stderr, /could not be read/u);
});

test("all JSON-mode input failures use a versioned machine-readable envelope", async () => {
  const secret = "hostile-reader-message-that-must-not-render";
  const result = await executePolicyCommand(
    {
      kind: "policy-check",
      policyPath: "missing.guard",
      defaultEffect: "deny",
      catalogPaths: [],
      format: "json",
    },
    Object.freeze({
      readBoundedUtf8File: async () => {
        throw new Error(secret);
      },
      createSecretCorrelationToken: () => "valid-correlation-token-0001",
    }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  const payload = JSON.parse(result.stderr) as {
    readonly schemaVersion: number;
    readonly ok: boolean;
    readonly error: { readonly code: string; readonly message: string };
  };
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "invalid_configuration");
  assert.doesNotMatch(payload.error.message, new RegExp(secret, "u"));
});

test("file and correlation boundaries fail without echoing hostile input", async () => {
  const secret = "hostile-file-error-secret";
  const missing: PolicyCommandDependencies = Object.freeze({
    readBoundedUtf8File: async () => {
      throw new Error(secret);
    },
    createSecretCorrelationToken: () => "valid-correlation-token-0001",
  });
  const result = await executePolicyCommand(
    {
      kind: "policy-check",
      policyPath: "missing.guard",
      defaultEffect: "deny",
      catalogPaths: [],
      format: "human",
    },
    missing,
  );
  assert.equal(result.exitCode, 2);
  assert.doesNotMatch(result.stderr, new RegExp(secret, "u"));

  const files = new Map<string, string>([["policy.guard", POLICY]]);
  const tooLarge = dependencies(files);
  const guarded: PolicyCommandDependencies = Object.freeze({
    ...tooLarge,
    readBoundedUtf8File: async (path: string, maximumBytes: number) => {
      assert.equal(maximumBytes, MAXIMUM_POLICY_SOURCE_BYTES);
      return tooLarge.readBoundedUtf8File(path, maximumBytes);
    },
  });
  const checked = await executePolicyCommand(
    {
      kind: "policy-check",
      policyPath: "policy.guard",
      defaultEffect: "deny",
      catalogPaths: [],
      format: "human",
    },
    guarded,
  );
  assert.equal(checked.exitCode, 0);
});

function dependencies(
  files: ReadonlyMap<string, string>,
  token = "deterministic-correlation-token-0001",
): PolicyCommandDependencies {
  return Object.freeze({
    readBoundedUtf8File: async (path: string, maximumBytes: number) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing fixture");
      if (Buffer.byteLength(value, "utf8") > maximumBytes) {
        throw new Error("oversized fixture");
      }
      return value;
    },
    createSecretCorrelationToken: () => token,
  });
}
