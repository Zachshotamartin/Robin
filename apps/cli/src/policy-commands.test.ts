import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalize, parseNormalizedAction } from "@guard/contracts";

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
    readonly nextCursor: string | null;
  };
  assert.equal(firstPayload.entries[0]?.actionId, ACTION.actionId);
  assert.equal(firstPayload.entries[0]?.category, "newly_denied");
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
    readonly nextCursor: string | null;
  };
  assert.equal(secondPayload.entries[0]?.actionId, second.actionId);
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
  const directory = await mkdtemp(join(tmpdir(), "guard-policy-bound-"));
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
