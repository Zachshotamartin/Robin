import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PolicyVersionIdKind } from "@guard/contracts";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshot,
  composePolicyAttributeCatalogs,
  parsePolicyCaseCorpus,
  runPolicyCaseCorpus,
} from "@guard/policy-engine";

import {
  CONTEXT_POLICY_ATTRIBUTE_CATALOG,
  MEMORY_POLICY_ATTRIBUTE_CATALOG,
} from "./index.js";

const POLICY_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000401",
);
const TOKEN = "context-policy-corpus-correlation-token-0001";

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

  const raw: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/context-policy-cases-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const corpus = parsePolicyCaseCorpus(raw);
  const run = runPolicyCaseCorpus(compiled.snapshot, corpus, TOKEN);
  assert.equal(
    run.failed,
    0,
    JSON.stringify(run.cases.filter((entry) => !entry.passed)),
  );
  assert.equal(run.passed, 12);

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
  assert.throws(() => parsePolicyCaseCorpus({ ...raw, schemaVersion: 0 }));
  assert.throws(() =>
    parsePolicyCaseCorpus({
      ...raw,
      policyContentHash: "0".repeat(64),
      unknown: true,
    }),
  );
});
