import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PolicyVersionIdKind } from "@guard/contracts";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshot,
  composePolicyAttributeCatalogs,
  createPinnedPolicyEvaluator,
  parsePolicyCaseCorpus,
  runPolicyCaseCorpus,
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
const TOKEN = "context-policy-corpus-correlation-token-0001";
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

async function compileContextPolicy() {
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
  return compiled.snapshot;
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
