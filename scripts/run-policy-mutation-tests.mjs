import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ActionIdKind, parseNormalizedAction } from "@guard/contracts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageRoot = path.join(repositoryRoot, "packages", "policy-engine");
const distRoot = path.join(packageRoot, "dist");
const config = JSON.parse(
  await readFile(path.join(packageRoot, "mutation.config.json"), "utf8"),
);

const mutations = Object.freeze([
  mutation(
    "match-unknown-as-true",
    "evaluator.js",
    'if (evaluated.value === "true")',
    'if (evaluated.value !== "false")',
  ),
  mutation(
    "disable-deny-partition",
    "evaluator.js",
    'entry.compiled.rule.effect.value === "deny"',
    'entry.compiled.rule.effect.value === "allow"',
  ),
  mutation(
    "disable-approval-partition",
    "evaluator.js",
    'entry.compiled.rule.effect.value === "require_approval"',
    'entry.compiled.rule.effect.value === "deny"',
  ),
  mutation(
    "disable-allow-partition",
    "evaluator.js",
    'entry.compiled.rule.effect.value === "allow"',
    'entry.compiled.rule.effect.value === "require_approval"',
  ),
  mutation(
    "prefer-allow-winner",
    "evaluator.js",
    "const winning = denies[0] ?? approvals[0] ?? allows[0] ?? null;",
    "const winning = allows[0] ?? approvals[0] ?? denies[0] ?? null;",
  ),
  mutation(
    "skip-deny-effect",
    "evaluator.js",
    "const effect = denies.length > 0",
    "const effect = false",
  ),
  mutation(
    "skip-approval-effect",
    "evaluator.js",
    ": approvals.length > 0\n            ? \"require_approval\"",
    ": false\n            ? \"require_approval\"",
  ),
  mutation(
    "skip-allow-effect",
    "evaluator.js",
    ": allows.length > 0\n                ? \"allow\"",
    ": false\n                ? \"allow\"",
  ),
  mutation(
    "force-default-allow",
    "evaluator.js",
    ": snapshot.defaultEffect;",
    ': "allow";',
  ),
  mutation(
    "reverse-priority-order",
    "evaluator.js",
    "right.compiled.rule.priority.value - left.compiled.rule.priority.value",
    "left.compiled.rule.priority.value - right.compiled.rule.priority.value",
  ),
  mutation(
    "reverse-stable-id-order",
    "evaluator.js",
    "compareUtf8(left.compiled.rule.name.value, right.compiled.rule.name.value)",
    "compareUtf8(right.compiled.rule.name.value, left.compiled.rule.name.value)",
  ),
  mutation(
    "missing-comparison-is-false",
    "evaluator.js",
    'const result = actual === undefined\n                ? "unknown"',
    'const result = actual === undefined\n                ? "false"',
  ),
  mutation(
    "reverse-exists",
    "evaluator.js",
    'Object.hasOwn(environment.values, name) ? "true" : "false"',
    'Object.hasOwn(environment.values, name) ? "false" : "true"',
  ),
  mutation(
    "negated-unknown-is-false",
    "evaluator.js",
    'if (value === "unknown")\n        return "unknown";',
    'if (value === "unknown")\n        return "false";',
  ),
  mutation(
    "and-false-needs-both",
    "evaluator.js",
    'if (left === "false" || right === "false")',
    'if (left === "false" && right === "false")',
  ),
  mutation(
    "and-unknown-needs-both",
    "evaluator.js",
    'return "false";\n    if (left === "unknown" || right === "unknown")',
    'return "false";\n    if (left === "unknown" && right === "unknown")',
  ),
  mutation(
    "or-true-needs-both",
    "evaluator.js",
    'if (left === "true" || right === "true")',
    'if (left === "true" && right === "true")',
  ),
  mutation(
    "or-unknown-needs-both",
    "evaluator.js",
    'return "true";\n    if (left === "unknown" || right === "unknown")',
    'return "true";\n    if (left === "unknown" && right === "unknown")',
  ),
  mutation(
    "unanchor-glob",
    "glob.js",
    "result = pathIndex === pathSegments.length;",
    "result = true;",
  ),
  mutation(
    "recursive-glob-requires-both-paths",
    "glob.js",
    "visit(globIndex + 1, pathIndex) ||\n                    (pathIndex < pathSegments.length",
    "visit(globIndex + 1, pathIndex) &&\n                    (pathIndex < pathSegments.length",
  ),
  mutation(
    "star-requires-empty-and-consuming",
    "glob.js",
    "visit(atomIndex + 1, characterIndex) ||\n                    (characterIndex < characters.length",
    "visit(atomIndex + 1, characterIndex) &&\n                    (characterIndex < characters.length",
  ),
  mutation(
    "literal-character-inversion",
    "glob.js",
    "characters[characterIndex + offset] === character",
    "characters[characterIndex + offset] !== character",
  ),
  mutation(
    "path-list-any-to-all",
    "evaluator.js",
    "return actual.some((path) => matchAnchoredPathGlob(glob, path))",
    "return actual.every((path) => matchAnchoredPathGlob(glob, path))",
  ),
]);

validateConfig(config, mutations);

const temporaryRoot = await mkdtemp(path.join(packageRoot, ".mutation-"));
const results = [];
try {
  const baselineRoot = path.join(temporaryRoot, "baseline");
  await cp(distRoot, baselineRoot, { recursive: true });
  const baseline = await import(pathToFileURL(path.join(baselineRoot, "index.js")));
  await exercise(baseline);

  for (const candidate of mutations) {
    const mutantRoot = path.join(temporaryRoot, candidate.id);
    await cp(distRoot, mutantRoot, { recursive: true });
    const target = path.join(mutantRoot, candidate.target);
    const source = await readFile(target, "utf8");
    const occurrences = countOccurrences(source, candidate.find);
    assert.equal(
      occurrences,
      1,
      `mutation ${candidate.id} expected one target, found ${occurrences}`,
    );
    await writeFile(target, source.replace(candidate.find, candidate.replace), "utf8");
    let killed = false;
    let failure = null;
    try {
      const module = await import(pathToFileURL(path.join(mutantRoot, "index.js")));
      await exercise(module);
    } catch (error) {
      killed = true;
      failure = error instanceof Error ? error.message : "non-error failure";
    }
    results.push({
      id: candidate.id,
      target: candidate.target,
      critical: candidate.critical,
      killed,
      failure,
    });
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

const killed = results.filter((result) => result.killed).length;
const scorePercent = results.length === 0 ? 0 : (killed * 100) / results.length;
const criticalSurvivors = results.filter(
  (result) => result.critical && !result.killed,
);
const report = {
  schemaVersion: 1,
  thresholdPercent: config.minimumScorePercent,
  scorePercent,
  killed,
  total: results.length,
  criticalSurvivors: criticalSurvivors.map((result) => result.id),
  equivalentMutants: config.equivalentMutants,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (
  scorePercent < config.minimumScorePercent ||
  (config.requireZeroCriticalSurvivors && criticalSurvivors.length > 0)
) {
  process.exitCode = 1;
}

function mutation(id, target, find, replace) {
  return Object.freeze({ id, target, find, replace, critical: true });
}

function validateConfig(value, candidates) {
  assert.deepEqual(Object.keys(value).sort(), [
    "equivalentMutants",
    "minimumScorePercent",
    "requireZeroCriticalSurvivors",
    "schemaVersion",
    "scope",
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.minimumScorePercent, 100);
  assert.equal(value.requireZeroCriticalSurvivors, true);
  assert.deepEqual(value.equivalentMutants, []);
  assert.deepEqual(
    [...new Set(candidates.map((candidate) => `dist/${candidate.target}`))].sort(),
    [...value.scope].sort(),
  );
  assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, candidates.length);
}

function countOccurrences(source, target) {
  if (target.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = source.indexOf(target, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + target.length;
  }
}

async function exercise(module) {
  const token = "mutation-correlation-token-0001";
  const combine = compile(
    module,
    `policy "deny" priority 1 { when action.operation == "combo" deny reason "deny" }
policy "approve" priority 100 { when action.operation == "combo" require_approval reason "approve" }
policy "allow" priority 1000 { when action.operation == "combo" allow reason "allow" }`,
    "pol_018f05a0-7b01-7000-8000-0000000000a1",
  );
  expectDecision(module, combine, action("combo", "none", 1), token, "deny", "deny");

  const effects = compile(
    module,
    `policy "approve" priority 1 { when action.side_effect == "local_reversible" require_approval reason "approve" }
policy "allow" priority 1 { when action.side_effect == "none" allow reason "allow" }`,
    "pol_018f05a0-7b01-7000-8000-0000000000a2",
  );
  expectDecision(module, effects, action("write", "local_reversible", 2), token, "require_approval", "approve");
  expectDecision(module, effects, action("read", "none", 3), token, "allow", "allow");
  expectDecision(module, effects, action("delete", "local_irreversible", 4), token, "deny", null);

  const priority = compile(
    module,
    `policy "low" priority 1 { when action.operation == "rank" deny reason "low" }
policy "high" priority 2 { when action.operation == "rank" deny reason "high" }`,
    "pol_018f05a0-7b01-7000-8000-0000000000a3",
  );
  expectDecision(module, priority, action("rank", "none", 5), token, "deny", "high");
  const tie = compile(
    module,
    `policy "z" priority 1 { when action.operation == "tie" deny reason "z" }
policy "a" priority 1 { when action.operation == "tie" deny reason "a" }`,
    "pol_018f05a0-7b01-7000-8000-0000000000a4",
  );
  expectDecision(module, tie, action("tie", "none", 6), token, "deny", "a");

  const missing = compile(
    module,
    `policy "double-not" priority 1 { when not (not request.intent == "x") allow reason "present only" }
policy "exists" priority 2 { when exists(request.intent) allow reason "exists" }`,
    "pol_018f05a0-7b01-7000-8000-0000000000a5",
  );
  expectDecision(module, missing, action("missing", "none", 7), token, "deny", null, false);
  expectDecision(module, missing, action("present", "none", 8), token, "allow", "exists", true);
  const negatedMissing = compile(
    module,
    `policy "negated-missing" priority 1 { when not request.intent == "x" allow reason "must remain unknown" }`,
    "pol_018f05a0-7b01-7000-8000-0000000000a6",
  );
  expectDecision(
    module,
    negatedMissing,
    action("negated-missing", "none", 9),
    token,
    "deny",
    null,
    false,
  );

  const values = ["true", "false", "unknown"];
  const expectedAnd = {
    "true:true": "true", "true:false": "false", "true:unknown": "unknown",
    "false:true": "false", "false:false": "false", "false:unknown": "false",
    "unknown:true": "unknown", "unknown:false": "false", "unknown:unknown": "unknown",
  };
  const expectedOr = {
    "true:true": "true", "true:false": "true", "true:unknown": "true",
    "false:true": "true", "false:false": "false", "false:unknown": "unknown",
    "unknown:true": "true", "unknown:false": "unknown", "unknown:unknown": "unknown",
  };
  for (const left of values) {
    for (const right of values) {
      assert.equal(module.conjunction(left, right), expectedAnd[`${left}:${right}`]);
      assert.equal(module.disjunction(left, right), expectedOr[`${left}:${right}`]);
    }
  }

  const glob = module.compileAnchoredPathGlob("src/**/test?.ts");
  assert.equal(module.matchAnchoredPathGlob(glob, "src/test1.ts"), true);
  assert.equal(module.matchAnchoredPathGlob(glob, "src/unit/testA.ts"), true);
  assert.equal(module.matchAnchoredPathGlob(glob, "src/unit/test.ts"), false);
  assert.equal(module.matchAnchoredPathGlob(glob, "prefix/src/unit/testA.ts"), false);
  assert.equal(module.matchAnchoredPathGlob(glob, "src/unit/testA.ts/trailing"), false);
  const star = module.compileAnchoredPathGlob("src/*.ts");
  assert.equal(module.matchAnchoredPathGlob(star, "src/a.ts"), true);
  assert.equal(module.matchAnchoredPathGlob(star, "src/a.js"), false);

  const pathList = compileWithPathListCatalog(
    module,
    `policy "deny-environment-output" priority 10 { when repo.paths matches "**/.env*" deny reason "deny" }
policy "allow-safe-output" priority 1 { when action.side_effect == "none" allow reason "allow" }`,
    "pol_018f05a0-7b01-7000-8000-0000000000a7",
  );
  for (const [ordinal, outputPaths] of [
    [10, ["service/.env", "src/a.ts", "src/z.ts"]],
    [11, ["src/a.ts", "service/.env.local", "src/z.ts"]],
    [12, ["src/a.ts", "src/z.ts", "service/.env.test"]],
  ]) {
    expectDecision(
      module,
      pathList,
      action("context.release", "none", ordinal, outputPaths),
      token,
      "deny",
      "deny-environment-output",
    );
  }
  for (const [ordinal, outputPaths] of [
    [13, ["src/a.ts", "service/config.env"]],
    [14, []],
  ]) {
    expectDecision(
      module,
      pathList,
      action("context.release", "none", ordinal, outputPaths),
      token,
      "allow",
      "allow-safe-output",
    );
  }
}

function compile(module, source, policyVersionId) {
  const result = module.compilePolicySnapshot({
    policyVersionId,
    source,
    sourceId: "mutation.guard",
    defaultEffect: "deny",
  });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  return result.snapshot;
}

function compileWithPathListCatalog(module, source, policyVersionId) {
  const pathCatalog = module.createPolicyAttributeCatalog({
    catalogId: "mutation.repository",
    schemaVersion: 1,
    attributes: [
      {
        name: "repo.paths",
        type: "list<string>",
        optional: true,
        secretClassification: "repository_paths",
        matchKind: "canonical_path",
        source: {
          kind: "object_field",
          section: "resource",
          field: "outputPaths",
        },
      },
    ],
  });
  const catalogs = module.composePolicyAttributeCatalogs([
    module.BASE_POLICY_ATTRIBUTE_CATALOG,
    pathCatalog,
  ]);
  const result = module.compilePolicySnapshot(
    {
      policyVersionId,
      source,
      sourceId: "mutation-path-list.guard",
      defaultEffect: "deny",
    },
    {},
    catalogs,
  );
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  return result.snapshot;
}

function expectDecision(
  module,
  snapshot,
  candidate,
  token,
  expectedEffect,
  expectedWinner,
  includeIntent = true,
) {
  const normalized = includeIntent
    ? candidate
    : parseNormalizedAction({ ...candidate, request: {} });
  const decision = module.evaluatePolicySnapshot(snapshot, normalized, {
    secretCorrelationToken: token,
  });
  assert.equal(decision.effect, expectedEffect);
  assert.equal(decision.winningPolicyName, expectedWinner);
}

function action(operationId, sideEffectClass, ordinal, outputPaths) {
  return parseNormalizedAction({
    schemaVersion: 1,
    actionId: ActionIdKind.parse(
      `act_018f05a0-7b01-7000-8000-${ordinal.toString(16).padStart(12, "0")}`,
    ),
    capabilityPackId: "fixture",
    capabilityPackVersion: 1,
    operationId,
    operationVersion: 1,
    subject: { kind: "agent" },
    resource: {
      scheme: "memory",
      sourceId: "fixture",
      classification: "public",
      ...(outputPaths === undefined ? {} : { outputPaths }),
    },
    environment: {
      sandboxed: true,
      networkProfile: "disabled",
      trustLevel: "fixture",
    },
    request: { intent: operationId },
    normalizedInput: {},
    sideEffectClass,
    preconditions: [],
  });
}
