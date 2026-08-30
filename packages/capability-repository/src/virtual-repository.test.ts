import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  PolicyVersionIdKind,
  isDomainError,
} from "@guard/contracts";
import type { NormalizedAction } from "@guard/contracts";
import { CapabilityGateway, CapabilityPackRegistry } from "@guard/capability-gateway";
import type { PinnedPolicyEvaluator, PolicyDecision } from "@guard/policy-engine";

import {
  VIRTUAL_REPOSITORY_REFERENCES,
  VirtualRepository,
  createVirtualRepositoryPack,
  type VirtualRepositoryLimits,
  type VirtualRepositoryPackLimits,
} from "./index.js";

const HOSTILE_CANARY = "repository-hostile-canary";
const POLICY_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000090",
);

const ACTION_IDS = {
  list: ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000091"),
  read: ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000092"),
  patch: ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000093"),
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
  return Object.freeze({
    policyVersionId: POLICY_ID,
    evaluate(_action: NormalizedAction): PolicyDecision {
      const winningPolicyName = "repository_fixture_allow";
      const matchedPolicyNames = Object.freeze([winningPolicyName]);
      return Object.freeze({
        policyVersionId: POLICY_ID,
        effect: "allow",
        winningPolicyName,
        reason: "Repository fixture actions are allowed by a pinned evaluator.",
        matchedPolicyNames,
        trace: Object.freeze({
          languageVersion: "1",
          policyContentHash: "a".repeat(64),
          attributeCatalogs: Object.freeze([]),
          combiningAlgorithm: "deny_overrides",
          defaultEffect: "deny",
          result: "allow",
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

function harness(limits = {}) {
  const source = repository();
  const registry = new CapabilityPackRegistry([
    createVirtualRepositoryPack(source, {
      maximumListResults: 8,
      maximumReadBytes: 128,
      maximumPatchBytes: 512,
      ...limits,
    }),
  ]);
  const gateway = new CapabilityGateway(registry, allowEvaluator());
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
});

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
  await assert.rejects(
    gateway.normalize(
      {
        schemaVersion: 1,
        ...VIRTUAL_REPOSITORY_REFERENCES.read,
        input: {
          path: "README.md",
          startLine: 1,
          endLine: 1,
          maxBytes: 16,
          rawHostPath: "/tmp/escape",
        },
      },
      context(ACTION_IDS.read),
      advertisement,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});
