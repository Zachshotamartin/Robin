import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ActionIdKind,
  RunIdKind,
  canonicalSha256Hex,
  isDomainError,
  parseNormalizedAction,
  type NormalizedAction,
} from "@guard/contracts";

import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  BASE_POLICY_ATTRIBUTE_CATALOG_SET,
  InMemoryPolicySnapshotStore,
  compileAnchoredPathGlob,
  compilePolicySnapshot,
  compilePolicySnapshotSet,
  composePolicyAttributeCatalogs,
  conjunction,
  createPolicySnapshotManifest,
  createPinnedPolicyEvaluator,
  createPolicyAttributeCatalog,
  disjunction,
  evaluatePolicySnapshot,
  matchAnchoredPathGlob,
  parsePolicyCaseCorpus,
  runPolicyCaseCorpus,
  runPolicyTestCases,
  simulatePolicyPage,
  type PolicySnapshot,
  type TruthValue,
} from "./index.js";

const POLICY_ID = "pol_018f05a0-7b01-7000-8000-000000000091";
const POLICY_ID_2 = "pol_018f05a0-7b01-7000-8000-000000000092";
const RUN_ID = RunIdKind.parse("run_018f05a0-7b01-7000-8000-000000000093");
const TOKEN = "test-run-correlation-token-0001";

const PACK_CATALOG = createPolicyAttributeCatalog({
  catalogId: "fixture.coding",
  schemaVersion: 1,
  attributes: [
    {
      name: "repo.path",
      type: "string",
      optional: true,
      secretClassification: "repository_path",
      matchKind: "canonical_path",
      source: { kind: "object_field", section: "resource", field: "path" },
    },
    {
      name: "repo.branch",
      type: "string",
      optional: true,
      secretClassification: "repository_branch",
      matchKind: "none",
      source: { kind: "object_field", section: "resource", field: "branch" },
    },
    {
      name: "process.executable",
      type: "string",
      optional: true,
      secretClassification: null,
      matchKind: "none",
      source: { kind: "object_field", section: "request", field: "executable" },
    },
    {
      name: "process.argv",
      type: "list<string>",
      optional: true,
      secretClassification: "process_arguments",
      matchKind: "none",
      source: { kind: "object_field", section: "request", field: "argv" },
    },
  ],
});

const CATALOGS = composePolicyAttributeCatalogs([
  BASE_POLICY_ATTRIBUTE_CATALOG,
  PACK_CATALOG,
]);

const SECURITY_POLICY = `policy "deny-external" priority 100 {
  when action.side_effect == "external"
  deny
  reason "External effects are denied."
}

policy "deny-secret-resource" priority 95 {
  when resource.classification == "secret"
  deny
  reason "Secret resources are not released."
}

policy "deny-environment-files" priority 90 {
  when exists(repo.path) and repo.path matches "**/.env*"
  deny
  reason "Environment files cannot enter agent context."
}

policy "approve-installs" priority 80 {
  when action.operation == "run_process"
    and process.executable in ["npm", "pnpm", "yarn"]
    and request.intent == "install_dependency"
  require_approval
  reason "Dependency installation requires review."
}

policy "approve-reversible" priority 70 {
  when action.side_effect == "local_reversible"
  require_approval
  reason "Local reversible effects require review."
}

policy "allow-bounded-reads" priority 50 {
  when action.operation in ["read_file", "list_files", "search_text"]
    and action.side_effect == "none"
  allow
  reason "Bounded read operations are allowed."
}

policy "allow-pure" priority 40 {
  when action.side_effect == "none"
  allow
  reason "Pure operations are allowed."
}
`;

test("compiles a canonical immutable snapshot bound to catalogs and default", () => {
  const snapshot = compile(SECURITY_POLICY);
  assert.equal(snapshot.policies.length, 7);
  assert.equal(snapshot.attributeCatalogs.manifest.length, 2);
  assert.equal(snapshot.defaultEffect, "deny");
  assert.match(snapshot.contentHash, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.policies), true);
  assert.deepEqual(createPolicySnapshotManifest(snapshot), {
    schemaVersion: 1,
    policyVersionId: POLICY_ID,
    languageVersion: "1",
    policyContentHash: snapshot.contentHash,
    defaultEffect: "deny",
    attributeCatalogs: snapshot.attributeCatalogs.manifest,
    sourceCount: 1,
  });
  assert.throws(() =>
    createPolicySnapshotManifest(structuredClone(snapshot)),
  );

  const crlf = compile(SECURITY_POLICY.replaceAll("\n", "\r\n"), POLICY_ID_2);
  assert.equal(crlf.contentHash, snapshot.contentHash);
  const approvalDefault = compile(SECURITY_POLICY, POLICY_ID_2, "require_approval");
  assert.notEqual(approvalDefault.contentHash, snapshot.contentHash);
});

test("type checker rejects unknown attributes, bad types, empty reasons, and globs", () => {
  const cases = [
    ["unknown_attribute", 'unknown.value == "x"', '"reason"'],
    ["incompatible_comparison", 'environment.sandboxed == "true"', '"reason"'],
    ["incompatible_comparison", 'action.operation in [1, 2]', '"reason"'],
    ["heterogeneous_list", 'action.operation in ["read", 2]', '"reason"'],
    ["nested_list_not_supported", 'action.operation in [["read"]]', '"reason"'],
    ["empty_list_has_no_type", "action.operation in []", '"reason"'],
    ["empty_policy_reason", 'action.operation == "read"', '""'],
    ["glob_invalid_recursive_wildcard", 'repo.path matches "src/**x/file"', '"reason"'],
    ["glob_unsupported_syntax", 'repo.path matches "src/[ab].ts"', '"reason"'],
    [
      "matches_requires_canonical_path_attribute",
      'action.operation matches "read*"',
      '"reason"',
    ],
  ] as const;
  for (const [code, condition, reason] of cases) {
    const result = compilePolicySnapshot(
      {
        policyVersionId: POLICY_ID,
        sourceId: `${code}.guard`,
        source: `policy "fixture" priority 1 { when ${condition} deny reason ${reason} }`,
        defaultEffect: "deny",
      },
      {},
      CATALOGS,
    );
    assert.equal(result.ok, false, code);
    if (!result.ok) {
      assert.ok(result.diagnostics.some((entry) => entry.code === code), code);
    }
  }
});

test("anchored path globs are case-sensitive and separator-independent", () => {
  const recursive = compileAnchoredPathGlob("src/**/test?.ts");
  assert.equal(matchAnchoredPathGlob(recursive, "src/test1.ts"), true);
  assert.equal(matchAnchoredPathGlob(recursive, "src/unit/testA.ts"), true);
  assert.equal(matchAnchoredPathGlob(recursive, "prefix/src/unit/testA.ts"), false);
  assert.equal(matchAnchoredPathGlob(recursive, "src/unit/TestA.ts"), false);
  assert.throws(() => matchAnchoredPathGlob(recursive, "src\\unit\\testA.ts"));
  assert.throws(() => compileAnchoredPathGlob("src/**x/file"));
  assert.throws(() => compileAnchoredPathGlob("café/*.ts"));
  assert.throws(() =>
    compileAnchoredPathGlob("*".repeat(65), {
      maximumBytes: 512,
      maximumSegments: 64,
      maximumWildcards: 64,
    }),
  );
});

test("catalog ID/version semantics cannot be rebound", () => {
  const first = createPolicyAttributeCatalog({
    catalogId: "fixture.collision",
    schemaVersion: 1,
    attributes: [
      {
        name: "fixture.value",
        type: "string",
        optional: true,
        secretClassification: null,
        matchKind: "none",
        source: { kind: "object_field", section: "request", field: "value" },
      },
    ],
  });
  assert.match(first.contentHash, /^[0-9a-f]{64}$/u);
  assert.throws(() =>
    createPolicyAttributeCatalog({
      catalogId: "fixture.collision",
      schemaVersion: 1,
      attributes: [
        {
          name: "fixture.value",
          type: "string",
          optional: false,
          secretClassification: null,
          matchKind: "none",
          source: { kind: "object_field", section: "request", field: "value" },
        },
      ],
    }),
  );
});

test("three-valued conjunction and disjunction exhaust every pair", () => {
  const values: readonly TruthValue[] = ["true", "false", "unknown"];
  const andExpected: Readonly<Record<string, TruthValue>> = {
    "true:true": "true",
    "true:false": "false",
    "true:unknown": "unknown",
    "false:true": "false",
    "false:false": "false",
    "false:unknown": "false",
    "unknown:true": "unknown",
    "unknown:false": "false",
    "unknown:unknown": "unknown",
  };
  const orExpected: Readonly<Record<string, TruthValue>> = {
    "true:true": "true",
    "true:false": "true",
    "true:unknown": "true",
    "false:true": "true",
    "false:false": "false",
    "false:unknown": "unknown",
    "unknown:true": "true",
    "unknown:false": "unknown",
    "unknown:unknown": "unknown",
  };
  for (const left of values) {
    for (const right of values) {
      assert.equal(conjunction(left, right), andExpected[`${left}:${right}`]);
      assert.equal(disjunction(left, right), orExpected[`${left}:${right}`]);
    }
  }
});

test("missing comparisons remain unknown, negation stays unknown, and exists is explicit", () => {
  const source = `policy "negated-missing" priority 30 {
  when not repo.path == "README.md"
  allow
  reason "A negated missing comparison must not match."
}
policy "missing-and-false" priority 20 {
  when repo.path == "README.md" and action.side_effect == "external"
  allow
  reason "Unknown and false is false."
}
policy "missing-or-true" priority 10 {
  when repo.path == "README.md" or action.side_effect == "none"
  allow
  reason "Unknown or true is true."
}
policy "exists-path" priority 40 {
  when exists(repo.path)
  deny
  reason "Presence is explicit."
}`;
  const snapshot = compile(source);
  const missing = evaluatePolicySnapshot(snapshot, action({ operationId: "transform" }), {
    secretCorrelationToken: TOKEN,
  });
  assert.equal(missing.effect, "allow");
  assert.equal(missing.winningPolicyName, "missing-or-true");
  const present = evaluatePolicySnapshot(
    snapshot,
    action({ operationId: "transform", path: "README.md" }),
    { secretCorrelationToken: TOKEN },
  );
  assert.equal(present.effect, "deny");
  assert.equal(present.winningPolicyName, "exists-path");
});

test("deny overrides higher-priority approval and allow; tie explanations are stable", () => {
  const source = `policy "z-allow" priority 999 {
  when action.side_effect == "external"
  allow
  reason "This allow cannot override a deny."
}
policy "approval" priority 1000 {
  when action.side_effect == "external"
  require_approval
  reason "This approval cannot override a deny."
}
policy "z-deny" priority 1 {
  when action.side_effect == "external"
  deny
  reason "Deny overrides."
}
policy "a-deny" priority 1 {
  when action.side_effect == "external"
  deny
  reason "Stable ID wins a tie."
}`;
  const decision = evaluatePolicySnapshot(
    compile(source),
    action({ operationId: "publish", sideEffectClass: "external" }),
    { secretCorrelationToken: TOKEN },
  );
  assert.equal(decision.effect, "deny");
  assert.equal(decision.winningPolicyName, "a-deny");
  assert.deepEqual(decision.matchedPolicyNames, [
    "a-deny",
    "z-deny",
    "approval",
    "z-allow",
  ]);
  assert.equal((decision.trace["evaluations"] as readonly unknown[]).length, 4);
});

test("secret attributes never enter traces and correlation tokens are per evaluator", () => {
  const canary = "tiny-secret-canary";
  const source = `policy "deny-secret-argv" priority 1 {
  when process.argv == ["--token", "${canary}"]
  deny
  reason "Sensitive process arguments are denied."
}`;
  const snapshot = compile(source);
  const candidate = action({
    operationId: "run_process",
    executable: "fixture",
    argv: ["--token", canary],
  });
  const first = createPinnedPolicyEvaluator(snapshot);
  const second = createPinnedPolicyEvaluator(snapshot);
  const firstTrace = JSON.stringify(first.evaluate(candidate).trace);
  const secondTrace = JSON.stringify(second.evaluate(candidate).trace);
  assert.equal(firstTrace.includes(canary), false);
  assert.equal(firstTrace.includes(canonicalSha256Hex(canary)), false);
  assert.match(firstTrace, /process_arguments/u);
  assert.notEqual(firstTrace, secondTrace);
});

test("snapshot sets have stable ordering and active run pins never follow edits", () => {
  const sourceA = `policy "a" priority 1 { when action.side_effect == "none" allow reason "a" }`;
  const sourceB = `policy "b" priority 1 { when action.side_effect == "external" deny reason "b" }`;
  const first = compileSet([
    { sourceId: "z.guard", source: sourceB },
    { sourceId: "a.guard", source: sourceA },
  ]);
  const reordered = compileSet(
    [
      { sourceId: "a.guard", source: sourceA },
      { sourceId: "z.guard", source: sourceB },
    ],
    POLICY_ID_2,
  );
  assert.equal(first.contentHash, reordered.contentHash);
  assert.deepEqual(first.sources.map((source) => source.sourceId), ["a.guard", "z.guard"]);

  const edited = compileSet(
    [{ sourceId: "a.guard", source: sourceA.replace('reason "a"', 'reason "edited"') }],
    POLICY_ID_2,
  );
  const store = new InMemoryPolicySnapshotStore();
  store.install(first);
  store.install(edited);
  store.pinRun(RUN_ID, first.policyVersionId);
  assert.equal(store.resolveRun(RUN_ID).contentHash, first.contentHash);
  assert.throws(
    () => store.pinRun(RUN_ID, edited.policyVersionId),
    (error: unknown) => isDomainError(error) && error.code === "conflict",
  );
  assert.equal(store.migrateRun(RUN_ID, edited.policyVersionId), edited);
});

test("snapshot-set aggregate bounds fail before unbounded compilation", () => {
  const source = `policy "one" priority 1 { when action.side_effect == "none" allow reason "one" }`;
  const tooManySources = compilePolicySnapshotSet(
    {
      policyVersionId: POLICY_ID,
      sources: [
        { sourceId: "a.guard", source },
        { sourceId: "b.guard", source: source.replace('"one"', '"two"') },
      ],
      defaultEffect: "deny",
    },
    { maximumSources: 1 },
    CATALOGS,
  );
  assert.equal(tooManySources.ok, false);
  if (!tooManySources.ok) {
    assert.equal(tooManySources.diagnostics[0]?.code, "too_many_policy_sources");
  }
  const tooManyBytes = compilePolicySnapshotSet(
    {
      policyVersionId: POLICY_ID,
      sources: [{ sourceId: "a.guard", source }],
      defaultEffect: "deny",
    },
    { maximumTotalSourceBytes: 1 },
    CATALOGS,
  );
  assert.equal(tooManyBytes.ok, false);
  if (!tooManyBytes.ok) {
    assert.equal(tooManyBytes.diagnostics[0]?.code, "policy_sources_too_large");
  }
  const unicodeOrder = compileSet([
    { sourceId: "é.guard", source },
    { sourceId: "é.guard", source: source.replace('"one"', '"two"') },
  ]);
  assert.deepEqual(unicodeOrder.sources.map((entry) => entry.sourceId), [
    "é.guard",
    "é.guard",
  ]);
});

test("simulation is stable, paged, and never invokes an effect port", () => {
  const oldSnapshot = compile(
    `policy "allow-pure" priority 1 { when action.side_effect == "none" allow reason "old" }`,
  );
  const newSnapshot = compile(
    `policy "approve-read" priority 2 { when action.operation == "read_file" require_approval reason "new" }
policy "allow-pure" priority 1 { when action.side_effect == "none" allow reason "old" }`,
    POLICY_ID_2,
  );
  const actions = [
    action({ actionOrdinal: 3, operationId: "transform" }),
    action({ actionOrdinal: 1, operationId: "read_file" }),
    action({ actionOrdinal: 2, operationId: "list_files" }),
  ];
  const first = simulatePolicyPage({
    from: oldSnapshot,
    to: newSnapshot,
    actions,
    secretCorrelationToken: TOKEN,
    pageSize: 2,
  });
  assert.deepEqual(first.entries.map((entry) => entry.actionId), [
    actions[1]?.actionId,
    actions[2]?.actionId,
  ]);
  assert.equal(first.entries[0]?.category, "newly_approval_gated");
  assert.notEqual(first.nextCursor, null);
  const second = simulatePolicyPage({
    from: oldSnapshot,
    to: newSnapshot,
    actions,
    secretCorrelationToken: TOKEN,
    cursor: first.nextCursor,
    pageSize: 2,
  });
  assert.equal(second.entries.length, 1);
  assert.equal(second.nextCursor, null);
  assert.throws(
    () =>
      simulatePolicyPage({
        from: oldSnapshot,
        to: oldSnapshot,
        actions,
        secretCorrelationToken: TOKEN,
        cursor: first.nextCursor,
      }),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
});

test("simulation emits the explicit approval-removed category", () => {
  const oldSnapshot = compile(
    `policy "approve" priority 1 { when action.operation == "read_file" require_approval reason "review" }`,
  );
  const newSnapshot = compile(
    `policy "allow" priority 1 { when action.operation == "read_file" allow reason "safe" }`,
    POLICY_ID_2,
  );
  const page = simulatePolicyPage({
    from: oldSnapshot,
    to: newSnapshot,
    actions: [action({ operationId: "read_file" })],
    secretCorrelationToken: TOKEN,
  });
  assert.equal(page.entries[0]?.category, "approval_removed");
  assert.equal(page.counts.approval_removed, 1);
});

test("table runner reports exact effects and winners", () => {
  const snapshot = compile(SECURITY_POLICY);
  const run = runPolicyTestCases(
    snapshot,
    [
      {
        name: "safe read",
        action: action({ operationId: "read_file", path: "src/index.ts" }),
        expectedEffect: "allow",
        expectedWinningPolicyName: "allow-bounded-reads",
      },
      {
        name: "environment file",
        action: action({ operationId: "read_file", path: ".env.local" }),
        expectedEffect: "deny",
        expectedWinningPolicyName: "deny-environment-files",
      },
      {
        name: "reversible write",
        action: action({ operationId: "write", sideEffectClass: "local_reversible" }),
        expectedEffect: "require_approval",
        expectedWinningPolicyName: "approve-reversible",
      },
    ],
    TOKEN,
  );
  assert.equal(run.passed, 3);
  assert.equal(run.failed, 0);
});

test("strict versioned case corpus parser binds actions and snapshot hash", () => {
  const snapshot = compile(SECURITY_POLICY);
  const corpus = parsePolicyCaseCorpus({
    schemaVersion: 1,
    policyContentHash: snapshot.contentHash,
    cases: [
      {
        schemaVersion: 1,
        caseId: "safe-read",
        action: action({ operationId: "read_file", path: "src/index.ts" }),
        expectedEffect: "allow",
        expectedWinningPolicyName: "allow-bounded-reads",
        expectedReason: "Bounded read operations are allowed.",
      },
      {
        schemaVersion: 1,
        caseId: "secret-read",
        action: action({ operationId: "read_file", classification: "secret" }),
        expectedEffect: "deny",
        expectedWinningPolicyName: "deny-secret-resource",
      },
    ],
  });
  const run = runPolicyCaseCorpus(snapshot, corpus, TOKEN);
  assert.equal(run.passed, 2);
  assert.throws(() =>
    parsePolicyCaseCorpus({
      schemaVersion: 1,
      policyContentHash: snapshot.contentHash,
      cases: [
        {
          schemaVersion: 1,
          caseId: "duplicate",
          action: action({ operationId: "read_file" }),
          expectedEffect: "allow",
        },
        {
          schemaVersion: 1,
          caseId: "duplicate",
          action: action({ operationId: "read_file", actionOrdinal: 2 }),
          expectedEffect: "allow",
        },
      ],
    }),
  );
  assert.throws(() =>
    parsePolicyCaseCorpus({
      schemaVersion: 0,
      policyContentHash: snapshot.contentHash,
      cases: [],
    }),
  );
  assert.throws(() =>
    parsePolicyCaseCorpus({
      schemaVersion: 1,
      policyFile: "legacy.guard",
      defaultEffect: "deny",
      baseAction: {},
      cases: [],
    }),
  );
  assert.throws(() =>
    runPolicyCaseCorpus(
      snapshot,
      Object.freeze({
        ...corpus,
        policyContentHash: "0".repeat(64),
      }),
      TOKEN,
    ),
  );
});

test("checked-in policy-v1 security table contains and passes at least 25 cases", async () => {
  const fixture: unknown = JSON.parse(
    await readFile(new URL("../testdata/policy-cases-v1.json", import.meta.url), "utf8"),
  );
  const corpus = parsePolicyCaseCorpus(fixture);
  assert.ok(corpus.cases.length >= 25);
  const strictSource = await readFile(
    new URL("../../../policies/strict.guard", import.meta.url),
    "utf8",
  );
  const result = compilePolicySnapshot(
    {
      policyVersionId: POLICY_ID,
      source: strictSource,
      sourceId: "policies/strict.guard",
      defaultEffect: "deny",
    },
    {},
    BASE_POLICY_ATTRIBUTE_CATALOG_SET,
  );
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error("unreachable strict policy compile failure");
  const run = runPolicyCaseCorpus(result.snapshot, corpus, TOKEN);
  assert.equal(run.failed, 0, JSON.stringify(run.cases.filter((entry) => !entry.passed)));
  assert.equal(run.passed, corpus.cases.length);
});

test("every rule in the shipped default policy has a match and near miss", async () => {
  const source = await readFile(
    new URL("../../../policies/default.guard", import.meta.url),
    "utf8",
  );
  const result = compilePolicySnapshot(
    {
      policyVersionId: POLICY_ID_2,
      source,
      sourceId: "policies/default.guard",
      defaultEffect: "deny",
    },
    {},
    CATALOGS,
  );
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error("unreachable default policy compile failure");
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/default-policy-cases-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const corpus = parsePolicyCaseCorpus(fixture);
  const run = runPolicyCaseCorpus(result.snapshot, corpus, TOKEN);
  assert.equal(run.failed, 0, JSON.stringify(run.cases.filter((entry) => !entry.passed)));
  assert.equal(run.passed, 6);
});

test("seeded generated decisions match an independent three-valued reference", async () => {
  const raw: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/policy-generator-seeds-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(typeof raw, "object");
  assert.notEqual(raw, null);
  assert.equal(Array.isArray(raw), false);
  const configuration = raw as Readonly<Record<string, unknown>>;
  assert.deepEqual(Object.keys(configuration).sort(), [
    "actionsPerSeed",
    "rulesPerSeed",
    "schemaVersion",
    "seeds",
  ]);
  assert.equal(configuration["schemaVersion"], 1);
  assert.ok(Array.isArray(configuration["seeds"]));
  const seeds = configuration["seeds"] as readonly unknown[];
  assert.ok(seeds.length > 0 && seeds.length <= 16);
  assert.ok(seeds.every((seed) => Number.isSafeInteger(seed) && (seed as number) > 0));
  const rulesPerSeed = configuration["rulesPerSeed"];
  const actionsPerSeed = configuration["actionsPerSeed"];
  assert.ok(Number.isSafeInteger(rulesPerSeed) && (rulesPerSeed as number) >= 8);
  assert.ok(Number.isSafeInteger(actionsPerSeed) && (actionsPerSeed as number) >= 125);

  let evaluatedCases = 0;
  for (const [seedIndex, seedValue] of seeds.entries()) {
    const random = xorshift32(seedValue as number);
    const rules = Array.from(
      { length: rulesPerSeed as number },
      (_, ruleIndex) => generatedRule(random, seedIndex, ruleIndex),
    );
    const snapshot = compile(
      `${rules.map((rule) => rule.source).join("\n\n")}\n`,
    );
    for (let index = 0; index < (actionsPerSeed as number); index += 1) {
      const operationId = choose(random, [
        "read_file",
        "list_files",
        "run_tests",
        "publish",
      ] as const);
      const sideEffectClass = choose(random, [
        "none",
        "local_reversible",
        "external",
      ] as const);
      const omitIntent = random() % 4 === 0;
      const intent = omitIntent
        ? undefined
        : choose(random, ["inspect", "install_dependency", operationId] as const);
      const candidate = action({
        actionOrdinal: seedIndex * (actionsPerSeed as number) + index + 1,
        operationId,
        sideEffectClass,
        sandboxed: random() % 2 === 0,
        omitIntent,
        ...(intent === undefined ? {} : { intent }),
      });
      const actual = evaluatePolicySnapshot(snapshot, candidate, {
        secretCorrelationToken: TOKEN,
      });
      const expected = referenceDecision(rules, candidate);
      assert.equal(actual.effect, expected.effect);
      assert.equal(actual.winningPolicyName, expected.winningPolicyName);
      assert.deepEqual(actual.matchedPolicyNames, expected.matchedPolicyNames);
      evaluatedCases += 1;
    }
  }
  assert.ok(evaluatedCases >= 500);
});

function compile(
  source: string,
  policyVersionId = POLICY_ID,
  defaultEffect: "allow" | "deny" | "require_approval" = "deny",
): PolicySnapshot {
  const result = compilePolicySnapshot(
    { policyVersionId, source, sourceId: "fixture.guard", defaultEffect },
    {},
    CATALOGS,
  );
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error("unreachable compile failure");
  return result.snapshot;
}

function compileSet(
  sources: readonly { readonly sourceId: string; readonly source: string }[],
  policyVersionId = POLICY_ID,
): PolicySnapshot {
  const result = compilePolicySnapshotSet(
    { policyVersionId, sources, defaultEffect: "deny" },
    {},
    CATALOGS,
  );
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error("unreachable compile failure");
  return result.snapshot;
}

function action(options: {
  readonly actionOrdinal?: number;
  readonly operationId: string;
  readonly capabilityPackId?: string;
  readonly sideEffectClass?: "none" | "local_reversible" | "local_irreversible" | "external";
  readonly classification?: string;
  readonly path?: string;
  readonly executable?: string;
  readonly argv?: readonly string[];
  readonly intent?: string;
  readonly omitIntent?: boolean;
  readonly sandboxed?: boolean;
  readonly networkProfile?: string;
}): NormalizedAction {
  const ordinal = options.actionOrdinal ?? 1;
  const suffix = ordinal.toString(16).padStart(12, "0");
  const resource: Record<string, unknown> = {
    scheme: "memory",
    sourceId: "fixture.source",
    classification: options.classification ?? "internal",
  };
  if (options.path !== undefined) resource["path"] = options.path;
  const request: Record<string, unknown> = {};
  if (options.omitIntent !== true) {
    request["intent"] = options.intent ?? options.operationId;
  }
  if (options.executable !== undefined) request["executable"] = options.executable;
  if (options.argv !== undefined) request["argv"] = [...options.argv];
  return parseNormalizedAction({
    schemaVersion: 1,
    actionId: ActionIdKind.parse(`act_018f05a0-7b01-7000-8000-${suffix}`),
    capabilityPackId: options.capabilityPackId ?? "fixture.coding",
    capabilityPackVersion: 1,
    operationId: options.operationId,
    operationVersion: 1,
    subject: {
      kind: "agent",
      driverId: "scripted",
      compatibilityTier: "A",
    },
    resource,
    environment: {
      profileId: "fixture",
      sandboxed: options.sandboxed ?? true,
      networkProfile: options.networkProfile ?? "disabled",
      trustLevel: "trusted_fixture",
    },
    request,
    normalizedInput: {},
    sideEffectClass: options.sideEffectClass ?? "none",
    preconditions: [],
  });
}

type GeneratedEffect = "allow" | "deny" | "require_approval";

interface GeneratedPredicate {
  readonly source: string;
  evaluate(action: NormalizedAction): TruthValue;
}

interface GeneratedRule {
  readonly name: string;
  readonly priority: number;
  readonly effect: GeneratedEffect;
  readonly source: string;
  readonly predicate: GeneratedPredicate;
}

function generatedRule(
  random: () => number,
  seedIndex: number,
  ruleIndex: number,
): GeneratedRule {
  const name = `generated-${String(seedIndex)}-${String(ruleIndex).padStart(2, "0")}`;
  const priority = random() % 5;
  const effect = choose(random, ["allow", "deny", "require_approval"] as const);
  const left = generatedAtom(random);
  const right = generatedAtom(random);
  const form = random() % 4;
  const predicate: GeneratedPredicate = form === 0
    ? left
    : form === 1
      ? {
          source: `not (${left.source})`,
          evaluate: (candidate) => referenceNot(left.evaluate(candidate)),
        }
      : form === 2
        ? {
            source: `(${left.source}) and (${right.source})`,
            evaluate: (candidate) =>
              referenceAnd(left.evaluate(candidate), right.evaluate(candidate)),
          }
        : {
            source: `(${left.source}) or (${right.source})`,
            evaluate: (candidate) =>
              referenceOr(left.evaluate(candidate), right.evaluate(candidate)),
          };
  return Object.freeze({
    name,
    priority,
    effect,
    predicate,
    source: `policy "${name}" priority ${String(priority)} {\n  when ${predicate.source}\n  ${effect}\n  reason "Generated reference rule ${String(seedIndex)}:${String(ruleIndex)}."\n}`,
  });
}

function generatedAtom(random: () => number): GeneratedPredicate {
  const operation = choose(random, ["read_file", "run_tests", "publish"] as const);
  const intent = choose(random, ["inspect", "install_dependency"] as const);
  const sideEffect = choose(random, ["none", "external"] as const);
  const sandboxed = random() % 2 === 0;
  switch (random() % 8) {
    case 0:
      return comparisonAtom(
        `action.operation == "${operation}"`,
        (candidate) => candidate.operationId === operation,
      );
    case 1:
      return comparisonAtom(
        `action.operation != "${operation}"`,
        (candidate) => candidate.operationId !== operation,
      );
    case 2:
      return optionalStringAtom(
        `request.intent == "${intent}"`,
        intent,
        false,
      );
    case 3:
      return optionalStringAtom(
        `request.intent != "${intent}"`,
        intent,
        true,
      );
    case 4:
      return {
        source: "exists(request.intent)",
        evaluate: (candidate) =>
          Object.hasOwn(candidate.request, "intent") ? "true" : "false",
      };
    case 5:
      return comparisonAtom(
        `environment.sandboxed == ${String(sandboxed)}`,
        (candidate) => candidate.environment["sandboxed"] === sandboxed,
      );
    case 6:
      return comparisonAtom(
        `action.side_effect in ["${sideEffect}", "local_reversible"]`,
        (candidate) =>
          candidate.sideEffectClass === sideEffect ||
          candidate.sideEffectClass === "local_reversible",
      );
    default:
      return comparisonAtom(
        'action.operation starts_with "r"',
        (candidate) => candidate.operationId.startsWith("r"),
      );
  }
}

function comparisonAtom(
  source: string,
  predicate: (action: NormalizedAction) => boolean,
): GeneratedPredicate {
  return Object.freeze({
    source,
    evaluate: (candidate: NormalizedAction) =>
      predicate(candidate) ? "true" : "false",
  });
}

function optionalStringAtom(
  source: string,
  expected: string,
  inequality: boolean,
): GeneratedPredicate {
  return Object.freeze({
    source,
    evaluate(candidate: NormalizedAction) {
      const actual = candidate.request["intent"];
      if (actual === undefined) return "unknown";
      const equal = actual === expected;
      return (inequality ? !equal : equal) ? "true" : "false";
    },
  });
}

function referenceDecision(
  rules: readonly GeneratedRule[],
  candidate: NormalizedAction,
): {
  readonly effect: GeneratedEffect;
  readonly winningPolicyName: string | null;
  readonly matchedPolicyNames: readonly string[];
} {
  const matched = rules.filter((rule) => rule.predicate.evaluate(candidate) === "true");
  const ordered = (effect: GeneratedEffect): GeneratedRule[] =>
    matched
      .filter((rule) => rule.effect === effect)
      .sort(
        (left, right) =>
          right.priority - left.priority || compareReferenceUtf8(left.name, right.name),
      );
  const denies = ordered("deny");
  const approvals = ordered("require_approval");
  const allows = ordered("allow");
  const winner = denies[0] ?? approvals[0] ?? allows[0] ?? null;
  return Object.freeze({
    effect: denies.length > 0
      ? "deny"
      : approvals.length > 0
        ? "require_approval"
        : allows.length > 0
          ? "allow"
          : "deny",
    winningPolicyName: winner?.name ?? null,
    matchedPolicyNames: Object.freeze(
      [...denies, ...approvals, ...allows].map((rule) => rule.name),
    ),
  });
}

function referenceNot(value: TruthValue): TruthValue {
  return value === "unknown" ? "unknown" : value === "true" ? "false" : "true";
}

function referenceAnd(left: TruthValue, right: TruthValue): TruthValue {
  if (left === "false" || right === "false") return "false";
  return left === "unknown" || right === "unknown" ? "unknown" : "true";
}

function referenceOr(left: TruthValue, right: TruthValue): TruthValue {
  if (left === "true" || right === "true") return "true";
  return left === "unknown" || right === "unknown" ? "unknown" : "false";
}

function compareReferenceUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function choose<T>(random: () => number, values: readonly T[]): T {
  const selected = values[random() % values.length];
  if (selected === undefined) throw new Error("generated choice set was empty");
  return selected;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}
