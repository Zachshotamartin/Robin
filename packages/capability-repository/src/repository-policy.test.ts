import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalize } from "@guard/contracts";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshot,
  composePolicyAttributeCatalogs,
  parsePolicyCaseCorpus,
  runPolicyCaseCorpus,
} from "@guard/policy-engine";

import { REPOSITORY_POLICY_ATTRIBUTE_CATALOG } from "./policy-catalog.js";

const POLICY_VERSION_ID = "pol_018f05a0-7b01-7000-8000-0000000003a1";
const EXPECTED_POLICY_CONTENT_HASH =
  "c24c9b084464a66862dd83a0676b1b0b20677d4a423be65d5f814c658a14d4ba";
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
      schemaVersion: 1,
      contentHash: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
    },
  ]);
  assert.deepEqual(
    compiled.snapshot.policies.map((policy) => policy.rule.name.value),
    [
      "deny-secret-repository-reads",
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
    maximumCases: 6,
  });
  assert.equal(corpus.policyContentHash, EXPECTED_POLICY_CONTENT_HASH);
  assert.deepEqual(
    corpus.cases.map((entry) => entry.name),
    [
      "secret-repository-path-match",
      "secret-repository-path-near-miss",
      "dependency-install-match",
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
      1,
      `${name} requires exactly one matching case`,
    );
  }
  const nearMisses = corpus.cases.filter((entry) => entry.name.endsWith("near-miss"));
  assert.equal(nearMisses.length, compiled.snapshot.policies.length);
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
  assert.equal(run.passed, 6);
});
