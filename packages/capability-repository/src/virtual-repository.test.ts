import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  PolicyVersionIdKind,
  canonicalBytes,
  isDomainError,
} from "@guard/contracts";
import type { JsonObject, NormalizedAction } from "@guard/contracts";
import { CapabilityGateway, CapabilityPackRegistry } from "@guard/capability-gateway";
import type { PinnedPolicyEvaluator, PolicyDecision } from "@guard/policy-engine";

import {
  VIRTUAL_REPOSITORY_REFERENCES,
  REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
  VirtualRepository,
  createVirtualRepositoryPack,
  type VirtualRepositoryLimits,
  type VirtualRepositoryPackLimits,
} from "./index.js";
import { runLiteralSearch } from "./literal-search.js";

const HOSTILE_CANARY = "repository-hostile-canary";
const POLICY_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000090",
);

const ACTION_IDS = {
  list: ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000091"),
  read: ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000092"),
  patch: ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000093"),
  search: ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000094"),
  inspectDiff: ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000095"),
} as const;

function isDomainCode(error: unknown, code: string): boolean {
  return isDomainError(error) && error.code === code;
}

function isSanitizedDomainCode(error: unknown, code: string): boolean {
  return (
    isDomainError(error) &&
    error.code === code &&
    !error.message.includes(HOSTILE_CANARY)
  );
}

function allowEvaluator(): PinnedPolicyEvaluator {
  return effectEvaluator("allow");
}

function denyEvaluator(): PinnedPolicyEvaluator {
  return effectEvaluator("deny");
}

function effectEvaluator(effect: "allow" | "deny"): PinnedPolicyEvaluator {
  return Object.freeze({
    policyVersionId: POLICY_ID,
    evaluate(_action: NormalizedAction): PolicyDecision {
      const winningPolicyName = `repository_fixture_${effect}`;
      const matchedPolicyNames = Object.freeze([winningPolicyName]);
      return Object.freeze({
        policyVersionId: POLICY_ID,
        effect,
        winningPolicyName,
        reason: `Repository fixture actions are ${effect}ed by a pinned evaluator.`,
        matchedPolicyNames,
        trace: Object.freeze({
          languageVersion: "1",
          policyContentHash: "a".repeat(64),
          attributeCatalogs: Object.freeze([]),
          combiningAlgorithm: "deny_overrides",
          defaultEffect: effect === "allow" ? "deny" : "allow",
          result: effect,
          winningPolicyName,
          evaluations: Object.freeze([]),
          matchedPolicyNames,
        }),
      });
    },
  });
}

function repository(): VirtualRepository {
  return new VirtualRepository(
    {
      "src/beta.ts": "export const beta = 2;\n",
      "README.md": "# Fixture\n",
      "src/alpha.ts": "one\ntwo\nthree\n",
    },
    { maximumFiles: 8, maximumFileBytes: 256 },
  );
}

const COUNTING_READS = new WeakMap<CountingVirtualRepository, number>();

class CountingVirtualRepository extends VirtualRepository {
  public constructor(files: Readonly<Record<string, string>>) {
    super(files, { maximumFiles: 8, maximumFileBytes: 256 });
    COUNTING_READS.set(this, 0);
  }

  public override read(path: string): string {
    COUNTING_READS.set(this, this.readCount + 1);
    return super.read(path);
  }

  public get readCount(): number {
    return COUNTING_READS.get(this) ?? 0;
  }

  public resetReads(): void {
    COUNTING_READS.set(this, 0);
  }
}

function harness(
  limits: Partial<VirtualRepositoryPackLimits> = {},
  source: VirtualRepository = repository(),
  evaluator: PinnedPolicyEvaluator = allowEvaluator(),
) {
  const registry = new CapabilityPackRegistry([
    createVirtualRepositoryPack(source, {
      maximumListResults: 8,
      maximumReadBytes: 128,
      maximumPatchBytes: 512,
      ...limits,
    }),
  ]);
  const gateway = new CapabilityGateway(registry, evaluator);
  const advertisement = registry.createAdvertisement(
    Object.values(VIRTUAL_REPOSITORY_REFERENCES),
  );
  return { source, registry, gateway, advertisement };
}

function context(actionId: (typeof ACTION_IDS)[keyof typeof ACTION_IDS]) {
  return {
    actionId,
    subject: { kind: "scripted", driverId: "driver:coding-fixture" },
    environment: { profileId: "coding-virtual", sandboxed: false },
  } as const;
}

async function invoke(
  operation: keyof typeof VIRTUAL_REPOSITORY_REFERENCES,
  input: unknown,
) {
  const { gateway, advertisement } = harness();
  const reference = VIRTUAL_REPOSITORY_REFERENCES[operation];
  const prepared = await gateway.normalize(
    { schemaVersion: 1, ...reference, input },
    context(ACTION_IDS[operation]),
    advertisement,
  );
  const result = await gateway.execute(gateway.evaluate(prepared), {
    signal: new AbortController().signal,
  });
  return { prepared, result };
}

test("lists virtual fixture paths in stable order with a hard result bound", async () => {
  const { prepared, result } = await invoke("list", {
    root: "src",
    maxResults: 1,
  });

  assert.deepEqual(prepared.action.normalizedInput, {
    maxResults: 1,
    root: "src",
  });
  assert.deepEqual(result.raw, {
    files: ["src/alpha.ts"],
    matchedCount: 2,
    truncated: true,
  });
  assert.deepEqual(result.audit, {
    matchedCount: 2,
    releasedCount: 1,
    root: "src",
    truncated: true,
  });
  assert.deepEqual(result.agent, {
    files: ["src/alpha.ts"],
    truncated: true,
  });
  assertRepositoryAgentContextRelease(
    result.agentContextRelease,
    "src",
    "capability.list_files.output",
  );
});

test("searches exact literals over deduplicated paths in stable order", async () => {
  const source = new VirtualRepository(
    {
      "src/beta.txt": "before needle after\n",
      "src/alpha.txt": "needle needle\n",
      "src/unused.txt": "needle\n",
    },
    { maximumFiles: 4, maximumFileBytes: 64 },
  );
  const { gateway, advertisement } = harness({}, source);
  const prepared = await gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.search,
      input: {
        query: "needle",
        paths: ["src/beta.txt", "src/alpha.txt", "src/alpha.txt"],
        maxMatches: 8,
        maxSnippetBytes: 24,
        maxOutputBytes: 2_048,
      },
    },
    context(ACTION_IDS.search),
    advertisement,
  );
  assert.deepEqual(prepared.action.normalizedInput["paths"], [
    "src/alpha.txt",
    "src/beta.txt",
  ]);
  assert.deepEqual(prepared.action.resource, {
    scheme: "repo",
    sourceId: "virtual-repository",
    path: "src",
    paths: ["src/alpha.txt", "src/beta.txt"],
    classification: "fixture",
  });
  const result = await gateway.execute(gateway.evaluate(prepared), {
    signal: new AbortController().signal,
  });
  assert.deepEqual(result.raw, {
    matches: [
      { path: "src/alpha.txt", line: 1, column: 1, snippet: "needle needle" },
      { path: "src/alpha.txt", line: 1, column: 8, snippet: "needle" },
      { path: "src/beta.txt", line: 1, column: 8, snippet: "needle after" },
    ],
    matchedCount: 3,
    truncated: false,
  });
  assert.deepEqual(result.agent, result.raw);
  assertRepositoryAgentContextRelease(
    result.agentContextRelease,
    "src",
    "capability.search_text.output",
    ["src/alpha.txt", "src/beta.txt"],
  );
});

test("direct literal-search helper fails closed on an empty query", () => {
  assert.throws(
    () =>
      runLiteralSearch(repository(), {
        query: "",
        paths: ["README.md"],
        maximumMatches: 1,
        maximumSnippetBytes: 1,
        maximumOutputBytes: 128,
      }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("defines literal, NFC, Unicode-column, and UTF-8 snippet semantics", async () => {
  const privateUsePath = "\ue000.txt";
  const supplementaryPath = "\u{10000}.txt";
  const source = new VirtualRepository(
    {
      [supplementaryPath]: "🙂a🙂 .*\n",
      [privateUsePath]: "🙂a🙂 .*\n",
      "composed.txt": "café\n",
    },
    { maximumFiles: 4, maximumFileBytes: 64 },
  );
  const { gateway, advertisement } = harness({}, source);
  const unicodePrepared = await gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.search,
      input: {
        query: "🙂",
        paths: [supplementaryPath, privateUsePath],
        maxMatches: 8,
        maxSnippetBytes: 5,
        maxOutputBytes: 2_048,
      },
    },
    context(ACTION_IDS.search),
    advertisement,
  );
  const unicode = await gateway.execute(gateway.evaluate(unicodePrepared), {
    signal: new AbortController().signal,
  });
  assert.deepEqual(unicode.raw["matches"], [
    { path: privateUsePath, line: 1, column: 1, snippet: "🙂a" },
    { path: privateUsePath, line: 1, column: 3, snippet: "🙂 " },
    { path: supplementaryPath, line: 1, column: 1, snippet: "🙂a" },
    { path: supplementaryPath, line: 1, column: 3, snippet: "🙂 " },
  ]);
  for (const match of unicode.raw["matches"] as readonly JsonObject[]) {
    assert.equal(Buffer.byteLength(match["snippet"] as string, "utf8") <= 5, true);
  }

  const nfcPrepared = await gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.search,
      input: {
        query: "e\u0301",
        paths: ["composed.txt"],
        maxMatches: 2,
        maxSnippetBytes: 8,
        maxOutputBytes: 512,
      },
    },
    context(ACTION_IDS.search),
    advertisement,
  );
  assert.equal(nfcPrepared.action.normalizedInput["query"], "é");
  const nfc = await gateway.execute(gateway.evaluate(nfcPrepared), {
    signal: new AbortController().signal,
  });
  assert.deepEqual(nfc.raw["matches"], [
    { path: "composed.txt", line: 1, column: 4, snippet: "é" },
  ]);

  const literalPrepared = await gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.search,
      input: {
        query: ".*",
        paths: [privateUsePath],
        maxMatches: 2,
        maxSnippetBytes: 8,
        maxOutputBytes: 512,
      },
    },
    context(ACTION_IDS.search),
    advertisement,
  );
  const literal = await gateway.execute(gateway.evaluate(literalPrepared), {
    signal: new AbortController().signal,
  });
  assert.deepEqual(literal.raw["matches"], [
    { path: privateUsePath, line: 1, column: 5, snippet: ".*" },
  ]);
});

test("truncates search deterministically at match and aggregate-output bounds", async () => {
  const source = new VirtualRepository(
    { "many.txt": "x x x x\n" },
    { maximumFiles: 2, maximumFileBytes: 32 },
  );
  const first = harness({}, source);
  const prepared = await first.gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.search,
      input: {
        query: "x",
        paths: ["many.txt"],
        maxMatches: 2,
        maxSnippetBytes: 8,
        maxOutputBytes: 1_024,
      },
    },
    context(ACTION_IDS.search),
    first.advertisement,
  );
  const bounded = await first.gateway.execute(first.gateway.evaluate(prepared), {
    signal: new AbortController().signal,
  });
  assert.equal(bounded.raw["matchedCount"], 4);
  assert.equal((bounded.raw["matches"] as readonly unknown[]).length, 2);
  assert.equal(bounded.raw["truncated"], true);

  const fullHarness = harness({}, source);
  const fullPrepared = await fullHarness.gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.search,
      input: {
        query: "x",
        paths: ["many.txt"],
        maxMatches: 8,
        maxSnippetBytes: 8,
        maxOutputBytes: 1_024,
      },
    },
    context(ACTION_IDS.search),
    fullHarness.advertisement,
  );
  const full = await fullHarness.gateway.execute(
    fullHarness.gateway.evaluate(fullPrepared),
    { signal: new AbortController().signal },
  );
  const exactOutputBytes = canonicalBytes({
    matches: full.raw["matches"]!,
    matchedCount: Number.MAX_SAFE_INTEGER,
    truncated: false,
  }).byteLength;
  const exactHarness = harness(
    { maximumSearchOutputBytes: exactOutputBytes },
    source,
  );
  const exactPrepared = await exactHarness.gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.search,
      input: {
        query: "x",
        paths: ["many.txt"],
        maxMatches: 8,
        maxSnippetBytes: 8,
        maxOutputBytes: exactOutputBytes,
      },
    },
    context(ACTION_IDS.search),
    exactHarness.advertisement,
  );
  const exact = await exactHarness.gateway.execute(
    exactHarness.gateway.evaluate(exactPrepared),
    { signal: new AbortController().signal },
  );
  assert.equal(canonicalBytes(exact.raw).byteLength <= exactOutputBytes, true);
  assert.equal((exact.raw["matches"] as readonly unknown[]).length, 4);

  const shortHarness = harness(
    { maximumSearchOutputBytes: exactOutputBytes - 1 },
    source,
  );
  const shortPrepared = await shortHarness.gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.search,
      input: {
        query: "x",
        paths: ["many.txt"],
        maxMatches: 8,
        maxSnippetBytes: 8,
        maxOutputBytes: exactOutputBytes - 1,
      },
    },
    context(ACTION_IDS.search),
    shortHarness.advertisement,
  );
  const short = await shortHarness.gateway.execute(
    shortHarness.gateway.evaluate(shortPrepared),
    { signal: new AbortController().signal },
  );
  assert.equal(canonicalBytes(short.raw).byteLength <= exactOutputBytes - 1, true);
  assert.equal(short.raw["truncated"], true);
});

test("enforces exact search query, path, match, snippet, and request-output bounds", async () => {
  const source = new VirtualRepository(
    { "unicode.txt": "🙂🙂🙂\n" },
    { maximumFiles: 2, maximumFileBytes: 32 },
  );
  const limits = {
    maximumSearchQueryBytes: 4,
    maximumSearchPaths: 2,
    maximumSearchMatches: 2,
    maximumSearchSnippetBytes: 5,
    maximumSearchOutputBytes: 512,
  };
  const exactHarness = harness(limits, source);
  const exactPrepared = await exactHarness.gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.search,
      input: {
        query: "🙂",
        paths: ["unicode.txt", "unicode.txt"],
        maxMatches: 2,
        maxSnippetBytes: 5,
        maxOutputBytes: 512,
      },
    },
    context(ACTION_IDS.search),
    exactHarness.advertisement,
  );
  const exact = await exactHarness.gateway.execute(
    exactHarness.gateway.evaluate(exactPrepared),
    { signal: new AbortController().signal },
  );
  assert.equal(exact.raw["matchedCount"], 3);
  assert.equal((exact.raw["matches"] as readonly unknown[]).length, 2);
  assert.equal(exact.raw["truncated"], true);

  const invalidInputs = [
    {
      query: "🙂a",
      paths: ["unicode.txt"],
      maxMatches: 2,
      maxSnippetBytes: 5,
      maxOutputBytes: 512,
    },
    {
      query: "🙂",
      paths: ["unicode.txt", "unicode.txt", "unicode.txt"],
      maxMatches: 2,
      maxSnippetBytes: 5,
      maxOutputBytes: 512,
    },
    {
      query: "🙂",
      paths: ["unicode.txt"],
      maxMatches: 3,
      maxSnippetBytes: 5,
      maxOutputBytes: 512,
    },
    {
      query: "🙂",
      paths: ["unicode.txt"],
      maxMatches: 2,
      maxSnippetBytes: 6,
      maxOutputBytes: 512,
    },
    {
      query: "🙂",
      paths: ["unicode.txt"],
      maxMatches: 2,
      maxSnippetBytes: 5,
      maxOutputBytes: 513,
    },
    {
      query: "🙂",
      paths: ["unicode.txt"],
      maxMatches: 2,
      maxSnippetBytes: 5,
      maxOutputBytes: 1,
    },
    {
      query: "bad\nquery",
      paths: ["unicode.txt"],
      maxMatches: 2,
      maxSnippetBytes: 5,
      maxOutputBytes: 512,
    },
    {
      query: "🙂",
      paths: ["../unicode.txt"],
      maxMatches: 2,
      maxSnippetBytes: 5,
      maxOutputBytes: 512,
    },
  ];
  for (const input of invalidInputs) {
    const { gateway, advertisement } = harness(limits, source);
    await assert.rejects(
      gateway.normalize(
        {
          schemaVersion: 1,
          ...VIRTUAL_REPOSITORY_REFERENCES.search,
          input,
        },
        context(ACTION_IDS.search),
        advertisement,
      ),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
});

test("policy denial prevents search handler reads and release", async () => {
  const source = new CountingVirtualRepository({ "safe.txt": "needle\n" });
  const { gateway, advertisement } = harness({}, source, denyEvaluator());
  const prepared = await gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.search,
      input: {
        query: "needle",
        paths: ["safe.txt"],
        maxMatches: 2,
        maxSnippetBytes: 16,
        maxOutputBytes: 512,
      },
    },
    context(ACTION_IDS.search),
    advertisement,
  );
  assert.equal(source.readCount, 1, "normalization validates the selected file once");
  source.resetReads();
  await assert.rejects(
    gateway.execute(gateway.evaluate(prepared), {
      signal: new AbortController().signal,
    }),
    (error: unknown) => isDomainCode(error, "policy_denied"),
  );
  assert.equal(source.readCount, 0, "denial never dispatches the search handler");
});

test("reads only a bounded line range and truncates at a valid UTF-8 boundary", async () => {
  const full = await invoke("read", {
    path: "src/alpha.ts",
    startLine: 2,
    endLine: 3,
    maxBytes: 64,
  });
  assert.deepEqual(full.result.raw, {
    path: "src/alpha.ts",
    content: "two\nthree",
    byteLength: 9,
    sourceSha256: full.prepared.action.preconditions[0]!.attributes["sha256"],
    truncated: false,
  });
  assert.deepEqual(full.result.agent, {
    path: "src/alpha.ts",
    content: "two\nthree",
    truncated: false,
  });
  assertRepositoryAgentContextRelease(
    full.result.agentContextRelease,
    "src/alpha.ts",
    "capability.read_file.output",
  );

  const unicodeRepository = new VirtualRepository(
    { "unicode.txt": "ééé" },
    { maximumFiles: 2, maximumFileBytes: 32 },
  );
  const registry = new CapabilityPackRegistry([
    createVirtualRepositoryPack(unicodeRepository, {
      maximumListResults: 2,
      maximumReadBytes: 8,
      maximumPatchBytes: 128,
    }),
  ]);
  const gateway = new CapabilityGateway(registry, allowEvaluator());
  const advertisement = registry.createAdvertisement([
    VIRTUAL_REPOSITORY_REFERENCES.read,
  ]);
  const prepared = await gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.read,
      input: { path: "unicode.txt", startLine: 1, endLine: 1, maxBytes: 5 },
    },
    context(ACTION_IDS.read),
    advertisement,
  );
  const bounded = await gateway.execute(gateway.evaluate(prepared), {
    signal: new AbortController().signal,
  });
  assert.equal(bounded.raw["content"], "éé");
  assert.equal(bounded.raw["byteLength"], 4);
  assert.equal(bounded.raw["truncated"], true);
});

test("proposes an exact bounded patch without mutating the virtual fixture", async () => {
  const { source, gateway, advertisement } = harness();
  const prepared = await gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.patch,
      input: { path: "src/alpha.ts", replacement: "one\nTWO\nthree\n" },
    },
    context(ACTION_IDS.patch),
    advertisement,
  );
  const before = source.read("src/alpha.ts");
  const result = await gateway.execute(gateway.evaluate(prepared), {
    signal: new AbortController().signal,
  });
  const after = source.read("src/alpha.ts");

  assert.equal(before, "one\ntwo\nthree\n");
  assert.equal(after, before, "proposal cannot mutate fixture state");
  assert.equal(result.raw["path"], "src/alpha.ts");
  assert.equal(
    result.raw["preimageSha256"],
    prepared.action.preconditions[0]!.attributes["sha256"],
  );
  assert.equal(result.raw["replacementSha256"], prepared.action.request["replacementSha256"]);
  assert.match(
    result.raw["patch"] as string,
    /^--- a\/src\/alpha\.ts\n\+\+\+ b\/src\/alpha\.ts\n@@ -1,3 \+1,3 @@\n/u,
  );
  assert.match(result.raw["patch"] as string, /-two\n/u);
  assert.match(result.raw["patch"] as string, /\+TWO\n/u);
  assert.equal(result.agent["path"], "src/alpha.ts");
  assert.equal(result.agent["patch"], result.raw["patch"]);
  assertRepositoryAgentContextRelease(
    result.agentContextRelease,
    "src/alpha.ts",
    "capability.propose_patch.output",
  );
});

test("inspects a canonical unified diff without applying it", async () => {
  const source = repository();
  const before = source.read("src/alpha.ts");
  const patch = [
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "",
  ].join("\n");
  const { gateway, advertisement } = harness({}, source);
  const prepared = await gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
      input: { patch },
    },
    context(ACTION_IDS.inspectDiff),
    advertisement,
  );
  assert.deepEqual(prepared.action.resource, {
    scheme: "repo",
    sourceId: "virtual-repository",
    path: "src/alpha.ts",
    paths: ["src/alpha.ts"],
    classification: "fixture",
  });
  const result = await gateway.execute(gateway.evaluate(prepared), {
    signal: new AbortController().signal,
  });
  assert.equal(source.read("src/alpha.ts"), before, "inspection never applies a diff");
  assert.deepEqual(result.raw, {
    paths: ["src/alpha.ts"],
    hunkCount: 1,
    additions: 1,
    deletions: 1,
    lineCount: 7,
    byteLength: Buffer.byteLength(patch, "utf8"),
    patch,
  });
  assert.deepEqual(result.agent, result.raw);
  assert.equal(result.audit["applied"], false);
  assertRepositoryAgentContextRelease(
    result.agentContextRelease,
    "src/alpha.ts",
    "capability.inspect_diff.output",
    ["src/alpha.ts"],
  );
});

test("policy denial prevents inspect-diff handler reads and release", async () => {
  const source = new CountingVirtualRepository({ "safe.txt": "before\n" });
  const patch = [
    "--- a/safe.txt",
    "+++ b/safe.txt",
    "@@ -1,1 +1,1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");
  const { gateway, advertisement } = harness({}, source, denyEvaluator());
  const prepared = await gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
      input: { patch },
    },
    context(ACTION_IDS.inspectDiff),
    advertisement,
  );
  assert.equal(source.readCount, 1, "normalization validates the current preimage");
  source.resetReads();
  await assert.rejects(
    gateway.execute(gateway.evaluate(prepared), {
      signal: new AbortController().signal,
    }),
    (error: unknown) => isDomainCode(error, "policy_denied"),
  );
  assert.equal(source.readCount, 0, "denial never dispatches the inspection handler");
});

test("requires unique UTF-8 ordered diff sections and exact current preimages", async () => {
  const source = repository();
  const stablePatch = [
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,1 @@",
    "-# Fixture",
    "+# Reviewed fixture",
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -1,1 +1,1 @@",
    "-one",
    "+ONE",
    "",
  ].join("\n");
  const stableHarness = harness({}, source);
  const stablePrepared = await stableHarness.gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
      input: { patch: stablePatch },
    },
    context(ACTION_IDS.inspectDiff),
    stableHarness.advertisement,
  );
  const stable = await stableHarness.gateway.execute(
    stableHarness.gateway.evaluate(stablePrepared),
    { signal: new AbortController().signal },
  );
  assert.deepEqual(stable.raw["paths"], ["README.md", "src/alpha.ts"]);
  assert.equal(stable.raw["hunkCount"], 2);
  assert.equal(stable.raw["additions"], 2);
  assert.equal(stable.raw["deletions"], 2);

  const reversed = [
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -1,1 +1,1 @@",
    "-one",
    "+ONE",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,1 @@",
    "-# Fixture",
    "+# Reviewed fixture",
    "",
  ].join("\n");
  const invalid = [
    reversed,
    stablePatch.replace("-one", "-not-current-content"),
    stablePatch.replace("+++ b/README.md", "+++ b/src/alpha.ts"),
  ];
  for (const patch of invalid) {
    const { gateway, advertisement } = harness({}, source);
    await assert.rejects(
      gateway.normalize(
        {
          schemaVersion: 1,
          ...VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
          input: { patch },
        },
        context(ACTION_IDS.inspectDiff),
        advertisement,
      ),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
});

test("accepts canonical nonzero zero-count insertion and deletion coordinates", async () => {
  const insertion = [
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -1,0 +2,1 @@",
    "+inserted",
    "",
  ].join("\n");
  const deletion = [
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -2,1 +1,0 @@",
    "-two",
    "",
  ].join("\n");

  for (const [patch, additions, deletions] of [
    [insertion, 1, 0],
    [deletion, 0, 1],
  ] as const) {
    const { gateway, advertisement } = harness();
    const prepared = await gateway.normalize(
      {
        schemaVersion: 1,
        ...VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
        input: { patch },
      },
      context(ACTION_IDS.inspectDiff),
      advertisement,
    );
    const result = await gateway.execute(gateway.evaluate(prepared), {
      signal: new AbortController().signal,
    });
    assert.equal(result.raw["additions"], additions);
    assert.equal(result.raw["deletions"], deletions);
  }
});

test("rejects traversal, ambiguous headers, and malformed unified-diff hunks", async () => {
  const valid = [
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -1,1 +1,1 @@",
    "-one",
    "+ONE",
    "",
  ].join("\n");
  const malformed = [
    valid.replace("src/alpha.ts", "../secret"),
    valid.replace("+++ b/src/alpha.ts", "+++ b/src/beta.ts"),
    valid.replace("@@ -1,1 +1,1 @@", "@@ -1 +1 @@"),
    valid.replace("@@ -1,1 +1,1 @@", "@@ -1,2 +1,1 @@"),
    valid.replace("@@ -1,1 +1,1 @@", "@@ -1,1 +2,1 @@"),
    valid.replace("-one\n+ONE", " one"),
    `diff --git a/src/alpha.ts b/src/alpha.ts\n${valid}`,
    valid.replace(/\n/gu, "\r\n"),
    valid.slice(0, -1),
    valid.replace("+ONE", "+ONE\u0000"),
    valid.replace("+ONE", "+ONE\ud800"),
    valid.replace("src/alpha.ts", "src//alpha.ts"),
  ];
  for (const patch of malformed) {
    const { gateway, advertisement } = harness();
    await assert.rejects(
      gateway.normalize(
        {
          schemaVersion: 1,
          ...VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
          input: { patch },
        },
        context(ACTION_IDS.inspectDiff),
        advertisement,
      ),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
});

test("enforces exact diff byte, path, hunk, line, and output bounds", async () => {
  const oneHunk = [
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -1,1 +1,1 @@",
    "-one",
    "+ONE",
    "",
  ].join("\n");
  const twoHunks = [
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -1,1 +1,1 @@",
    "-one",
    "+ONE",
    "@@ -2,1 +2,1 @@",
    "-two",
    "+TWO",
    "",
  ].join("\n");
  const patchBytes = Buffer.byteLength(oneHunk, "utf8");
  const lineCount = oneHunk.slice(0, -1).split("\n").length;
  const exactHarness = harness({
    maximumDiffBytes: patchBytes,
    maximumDiffPaths: 1,
    maximumDiffHunks: 1,
    maximumDiffLines: lineCount,
  });
  const exactPrepared = await exactHarness.gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
      input: { patch: oneHunk },
    },
    context(ACTION_IDS.inspectDiff),
    exactHarness.advertisement,
  );
  const exact = await exactHarness.gateway.execute(
    exactHarness.gateway.evaluate(exactPrepared),
    { signal: new AbortController().signal },
  );
  const outputBytes = canonicalBytes(exact.raw).byteLength;
  assert.equal(exact.raw["byteLength"], patchBytes);
  assert.equal(exact.raw["lineCount"], lineCount);

  const exactOutputHarness = harness({ maximumDiffOutputBytes: outputBytes });
  const exactOutputPrepared = await exactOutputHarness.gateway.normalize(
    {
      schemaVersion: 1,
      ...VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
      input: { patch: oneHunk },
    },
    context(ACTION_IDS.inspectDiff),
    exactOutputHarness.advertisement,
  );
  const exactOutput = await exactOutputHarness.gateway.execute(
    exactOutputHarness.gateway.evaluate(exactOutputPrepared),
    { signal: new AbortController().signal },
  );
  assert.equal(canonicalBytes(exactOutput.raw).byteLength, outputBytes);

  const overCases: readonly [Partial<VirtualRepositoryPackLimits>, string][] = [
    [{ maximumDiffBytes: patchBytes - 1 }, oneHunk],
    [{ maximumDiffHunks: 1 }, twoHunks],
    [{ maximumDiffLines: lineCount - 1 }, oneHunk],
    [{ maximumDiffOutputBytes: outputBytes - 1 }, oneHunk],
  ];
  for (const [limits, patch] of overCases) {
    const { gateway, advertisement } = harness(limits);
    await assert.rejects(
      gateway.normalize(
        {
          schemaVersion: 1,
          ...VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
          input: { patch },
        },
        context(ACTION_IDS.inspectDiff),
        advertisement,
      ),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }

  const twoPaths = [
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,1 @@",
    "-# Fixture",
    "+# Updated",
    oneHunk.slice(0, -1),
    "",
  ].join("\n");
  const pathHarness = harness({ maximumDiffPaths: 1 });
  await assert.rejects(
    pathHarness.gateway.normalize(
      {
        schemaVersion: 1,
        ...VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
        input: { patch: twoPaths },
      },
      context(ACTION_IDS.inspectDiff),
      pathHarness.advertisement,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

function assertRepositoryAgentContextRelease(
  descriptor: Awaited<ReturnType<CapabilityGateway["execute"]>>["agentContextRelease"],
  path: string,
  reason: string,
  paths?: readonly string[],
): void {
  const locator = paths === undefined ? { path } : { path, paths };
  assert.deepEqual(descriptor, {
    schemaVersion: 1,
    sourceVersion: 1,
    resource: {
      schemaVersion: 1,
      scheme: "repo",
      sourceId: "virtual-repository",
      locator,
      mediaType: "application/json",
      classification: "fixture",
    },
    policyProjection: {
      schemaVersion: 1,
      catalogId: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
      catalogVersion: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
      catalogContentHash: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
      resourceAttributes: { path },
      requestAttributes: {},
    },
    classification: "fixture",
    reason,
  });
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.policyProjection), true);
  assert.equal(Object.isFrozen(descriptor.policyProjection.resourceAttributes), true);
}

test("rejects traversal, absolute, drive, UNC, encoded, and ambiguous paths before execution", async () => {
  const invalidPaths = [
    "../secret",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "\\\\server\\share\\file",
    "src/../secret",
    "src\\alpha.ts",
    "src//alpha.ts",
    ".",
    "%2e%2e/secret",
    "\u0000hidden",
    "\ud800.txt",
  ];

  for (const path of invalidPaths) {
    const { gateway, advertisement } = harness();
    for (const [kind, input] of [
      ["read", { path, startLine: 1, endLine: 1, maxBytes: 32 }],
      ["patch", { path, replacement: "safe\n" }],
    ] as const) {
      const operation = kind === "read" ? "read" : "patch";
      await assert.rejects(
        gateway.normalize(
          {
            schemaVersion: 1,
            ...VIRTUAL_REPOSITORY_REFERENCES[operation],
            input,
          },
          context(ACTION_IDS[operation]),
          advertisement,
        ),
        (error: unknown) => isDomainCode(error, "invalid_input"),
        `${kind} should reject ${JSON.stringify(path)}`,
      );
    }
  }

  const { gateway, advertisement } = harness();
  await assert.rejects(
    gateway.normalize(
      {
        schemaVersion: 1,
        ...VIRTUAL_REPOSITORY_REFERENCES.list,
        input: { root: "../", maxResults: 2 },
      },
      context(ACTION_IDS.list),
      advertisement,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("snapshots virtual files and limits before reads and rejects hostile inputs", () => {
  assert.throws(
    () =>
      new VirtualRepository(
        { "invalid-unicode.txt": "\ud800" },
        { maximumFiles: 2, maximumFileBytes: 64 },
      ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  let fileGetterCalls = 0;
  const accessorFiles: Record<string, unknown> = {};
  Object.defineProperty(accessorFiles, "README.md", {
    enumerable: true,
    get() {
      fileGetterCalls += 1;
      throw new Error(HOSTILE_CANARY);
    },
  });
  assert.throws(
    () =>
      new VirtualRepository(
        accessorFiles as Readonly<Record<string, string>>,
        { maximumFiles: 2, maximumFileBytes: 64 },
      ),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(fileGetterCalls, 0, "file getter must never run");

  let limitGetterCalls = 0;
  const accessorLimits: Record<string, unknown> = { maximumFiles: 2 };
  Object.defineProperty(accessorLimits, "maximumFileBytes", {
    enumerable: true,
    get() {
      limitGetterCalls += 1;
      throw new Error(HOSTILE_CANARY);
    },
  });
  assert.throws(
    () =>
      new VirtualRepository(
        { "README.md": "safe\n" },
        accessorLimits as unknown as VirtualRepositoryLimits,
      ),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(limitGetterCalls, 0, "limit getter must never run");

  let proxyGetCalls = 0;
  const hostileFiles = new Proxy({ "README.md": "safe\n" }, {
    get() {
      proxyGetCalls += 1;
      throw new Error(HOSTILE_CANARY);
    },
    ownKeys() {
      throw new Error(HOSTILE_CANARY);
    },
  });
  assert.throws(
    () =>
      new VirtualRepository(hostileFiles, {
        maximumFiles: 2,
        maximumFileBytes: 64,
      }),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(proxyGetCalls, 0, "file get trap must never run");

  const revoked = Proxy.revocable({ "README.md": "safe\n" }, {});
  revoked.revoke();
  assert.throws(
    () =>
      new VirtualRepository(revoked.proxy, {
        maximumFiles: 2,
        maximumFileBytes: 64,
      }),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );

  assert.throws(
    () =>
      new VirtualRepository(
        { "README.md": "safe\n" },
        {
          maximumFiles: 2,
          maximumFileBytes: 64,
          unexpected: 1,
        } as VirtualRepositoryLimits,
      ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const mutableFiles = { "README.md": "original\n" };
  const mutableLimits = { maximumFiles: 2, maximumFileBytes: 64 };
  const stable = new VirtualRepository(mutableFiles, mutableLimits);
  mutableFiles["README.md"] = "changed\n";
  mutableLimits.maximumFileBytes = 1;
  assert.equal(stable.read("README.md"), "original\n");
});

test("snapshots virtual pack limits and rejects hostile or inexact limits", () => {
  const source = repository();
  const backwardCompatible = new CapabilityPackRegistry([
    createVirtualRepositoryPack(source, {
      maximumListResults: 8,
      maximumReadBytes: 128,
      maximumPatchBytes: 512,
    }),
  ]);
  assert.deepEqual(
    backwardCompatible.listPacks()[0]!.operations.map(
      (operation) => operation.operationId,
    ),
    ["inspect_diff", "list_files", "propose_patch", "read_file", "search_text"],
  );
  let getterCalls = 0;
  const accessorLimits: Record<string, unknown> = {
    maximumListResults: 8,
    maximumReadBytes: 128,
  };
  Object.defineProperty(accessorLimits, "maximumPatchBytes", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(HOSTILE_CANARY);
    },
  });
  assert.throws(
    () =>
      createVirtualRepositoryPack(
        source,
        accessorLimits as unknown as VirtualRepositoryPackLimits,
      ),
    (error: unknown) => isSanitizedDomainCode(error, "invalid_input"),
  );
  assert.equal(getterCalls, 0, "pack-limit getter must never run");

  assert.throws(
    () =>
      createVirtualRepositoryPack(source, {
        maximumListResults: 8,
        maximumReadBytes: 128,
        maximumPatchBytes: 512,
        unexpected: 1,
      } as VirtualRepositoryPackLimits),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  assert.throws(
    () =>
      createVirtualRepositoryPack(source, {
        maximumListResults: 8,
        maximumReadBytes: 128,
        maximumPatchBytes: 512,
        maximumSearchMatches: 0,
      }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("enforces fixture, listing, read, and patch bounds semantically", async () => {
  assert.throws(
    () =>
      new VirtualRepository(
        { "large.txt": "x".repeat(33) },
        { maximumFiles: 1, maximumFileBytes: 32 },
      ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const { gateway, advertisement } = harness({
    maximumListResults: 2,
    maximumReadBytes: 8,
    maximumPatchBytes: 32,
  });
  const invalid = [
    {
      reference: VIRTUAL_REPOSITORY_REFERENCES.list,
      actionId: ACTION_IDS.list,
      input: { root: "", maxResults: 3 },
    },
    {
      reference: VIRTUAL_REPOSITORY_REFERENCES.read,
      actionId: ACTION_IDS.read,
      input: { path: "README.md", startLine: 2, endLine: 1, maxBytes: 8 },
    },
    {
      reference: VIRTUAL_REPOSITORY_REFERENCES.read,
      actionId: ACTION_IDS.read,
      input: { path: "README.md", startLine: 1, endLine: 1, maxBytes: 9 },
    },
    {
      reference: VIRTUAL_REPOSITORY_REFERENCES.patch,
      actionId: ACTION_IDS.patch,
      input: { path: "README.md", replacement: "x".repeat(40) },
    },
  ];
  for (const item of invalid) {
    await assert.rejects(
      gateway.normalize(
        { schemaVersion: 1, ...item.reference, input: item.input },
        context(item.actionId),
        advertisement,
      ),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
});

test("strict operation schemas reject unknown properties", async () => {
  const { gateway, advertisement } = harness();
  const invalid = [
    {
      reference: VIRTUAL_REPOSITORY_REFERENCES.read,
      actionId: ACTION_IDS.read,
      input: {
        path: "README.md",
        startLine: 1,
        endLine: 1,
        maxBytes: 16,
        rawHostPath: "/tmp/escape",
      },
    },
    {
      reference: VIRTUAL_REPOSITORY_REFERENCES.search,
      actionId: ACTION_IDS.search,
      input: {
        query: "Fixture",
        paths: ["README.md"],
        maxMatches: 2,
        maxSnippetBytes: 16,
        maxOutputBytes: 512,
        regex: true,
      },
    },
    {
      reference: VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
      actionId: ACTION_IDS.inspectDiff,
      input: {
        patch: "--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-# Fixture\n+# Safe\n",
        apply: true,
      },
    },
    {
      reference: VIRTUAL_REPOSITORY_REFERENCES.search,
      actionId: ACTION_IDS.search,
      input: {
        query: "Fixture",
        paths: "README.md",
        maxMatches: 2,
        maxSnippetBytes: 16,
        maxOutputBytes: 512,
      },
    },
    {
      reference: VIRTUAL_REPOSITORY_REFERENCES.inspectDiff,
      actionId: ACTION_IDS.inspectDiff,
      input: { patch: 1 },
    },
  ];
  for (const item of invalid) {
    await assert.rejects(
      gateway.normalize(
        { schemaVersion: 1, ...item.reference, input: item.input },
        context(item.actionId),
        advertisement,
      ),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
});
