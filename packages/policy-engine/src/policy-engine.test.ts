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
  InMemoryPolicySnapshotStore,
  compileAnchoredPathGlob,
  compilePolicySnapshot,
  compilePolicySnapshotSet,
  composePolicyAttributeCatalogs,
  conjunction,
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
});

test("checked-in policy-v1 security table contains and passes at least 25 cases", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../testdata/policy-cases-v1.json", import.meta.url), "utf8"),
  ) as {
    readonly schemaVersion: number;
    readonly policyFile: string;
    readonly defaultEffect: "deny";
    readonly baseAction: {
      readonly operationId: string;
      readonly sideEffectClass: "none";
      readonly classification: string;
      readonly sandboxed: boolean;
      readonly networkProfile: string;
    };
    readonly cases: readonly {
      readonly caseId: string;
      readonly overrides: Readonly<Record<string, unknown>>;
      readonly expectedEffect: "allow" | "deny" | "require_approval";
      readonly expectedWinner: string | null;
    }[];
  };
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.policyFile, "policies/strict.guard");
  assert.ok(fixture.cases.length >= 25);
  assert.equal(new Set(fixture.cases.map((entry) => entry.caseId)).size, fixture.cases.length);
  const strictSource = await readFile(
    new URL("../../../policies/strict.guard", import.meta.url),
    "utf8",
  );
  const snapshot = compile(strictSource);
  const cases = fixture.cases.map((entry, index) => {
    const allowed = new Set([
      "operationId",
      "sideEffectClass",
      "classification",
      "sandboxed",
      "networkProfile",
    ]);
    assert.deepEqual(
      Object.keys(entry.overrides).filter((key) => !allowed.has(key)),
      [],
      entry.caseId,
    );
    const merged = { ...fixture.baseAction, ...entry.overrides } as {
      readonly operationId: string;
      readonly sideEffectClass: "none" | "local_reversible" | "local_irreversible" | "external";
      readonly classification: string;
      readonly sandboxed: boolean;
      readonly networkProfile: string;
    };
    return {
      name: entry.caseId,
      action: action({
        actionOrdinal: index + 1,
        operationId: merged.operationId,
        sideEffectClass: merged.sideEffectClass,
        classification: merged.classification,
        sandboxed: merged.sandboxed,
        networkProfile: merged.networkProfile,
      }),
      expectedEffect: entry.expectedEffect,
      expectedWinningPolicyName: entry.expectedWinner,
    };
  });
  const run = runPolicyTestCases(snapshot, cases, TOKEN);
  assert.equal(run.failed, 0, JSON.stringify(run.cases.filter((entry) => !entry.passed)));
  assert.equal(run.passed, fixture.cases.length);
});

test("every rule in the shipped default policy has a match and near miss", async () => {
  const source = await readFile(
    new URL("../../../policies/default.guard", import.meta.url),
    "utf8",
  );
  const snapshot = compile(source);
  const run = runPolicyTestCases(
    snapshot,
    [
      {
        name: "secret repository path match",
        action: action({
          capabilityPackId: "repository",
          operationId: "read_file",
          path: "service/.env.local",
        }),
        expectedEffect: "deny",
        expectedWinningPolicyName: "deny-secret-repository-reads",
      },
      {
        name: "secret repository path near miss",
        action: action({
          capabilityPackId: "repository",
          operationId: "read_file",
          path: "service/config.env",
        }),
        expectedEffect: "deny",
        expectedWinningPolicyName: null,
      },
      {
        name: "dependency install match",
        action: action({
          capabilityPackId: "process",
          operationId: "run_process",
          intent: "install_dependency",
        }),
        expectedEffect: "require_approval",
        expectedWinningPolicyName: "approve-dependency-installation",
      },
      {
        name: "dependency install near miss",
        action: action({
          capabilityPackId: "process",
          operationId: "run_process",
          intent: "run_build",
        }),
        expectedEffect: "deny",
        expectedWinningPolicyName: null,
      },
      {
        name: "sandboxed tests match",
        action: action({
          capabilityPackId: "process",
          operationId: "run_tests",
        }),
        expectedEffect: "allow",
        expectedWinningPolicyName: "allow-sandboxed-tests",
      },
      {
        name: "sandboxed tests near miss",
        action: action({
          capabilityPackId: "process",
          operationId: "run_tests",
          sandboxed: false,
        }),
        expectedEffect: "deny",
        expectedWinningPolicyName: null,
      },
    ],
    TOKEN,
  );
  assert.equal(run.failed, 0, JSON.stringify(run.cases.filter((entry) => !entry.passed)));
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
  const request: Record<string, unknown> = {
    intent: options.intent ?? options.operationId,
  };
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
