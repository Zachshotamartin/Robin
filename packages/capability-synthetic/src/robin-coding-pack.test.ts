import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  isDomainError,
  type JsonObject,
} from "@guard/contracts";
import {
  CapabilityGateway,
  CapabilityPackRegistry,
} from "@guard/capability-gateway";
import { createPinnedPolicyEvaluator } from "@guard/policy-engine";

import {
  ROBIN_SYNTHETIC_CODING_POLICY_SNAPSHOT,
  ROBIN_SYNTHETIC_INSPECT_FILE_REFERENCE,
  ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_REFERENCE,
  createRobinSyntheticCodingPack,
} from "./robin-coding-pack.js";

const ACTION_IDS = [
  ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000091"),
  ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000092"),
];

function setup() {
  const registry = new CapabilityPackRegistry([
    createRobinSyntheticCodingPack(),
  ]);
  const advertisement = registry.createAdvertisement([
    ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_REFERENCE,
    ROBIN_SYNTHETIC_INSPECT_FILE_REFERENCE,
  ]);
  const gateway = new CapabilityGateway(
    registry,
    createPinnedPolicyEvaluator(ROBIN_SYNTHETIC_CODING_POLICY_SNAPSHOT, {
      secretCorrelationToken: "robin-r1-fixture-policy-token-0001",
    }),
  );
  let nextId = 0;
  return {
    advertisement,
    async execute(
      reference:
        | typeof ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_REFERENCE
        | typeof ROBIN_SYNTHETIC_INSPECT_FILE_REFERENCE,
      input: JsonObject,
    ) {
      const actionId = ACTION_IDS[nextId++];
      assert.notEqual(actionId, undefined);
      const prepared = await gateway.normalize(
        { schemaVersion: 1, ...reference, input },
        {
          actionId: actionId!,
          subject: { kind: "agent_driver", id: "robin.r1.synthetic" },
          environment: {
            profileId: "robin-r1",
            sandboxed: true,
            networkProfile: "disabled",
            trustLevel: "trusted_fixture",
          },
        },
        advertisement,
      );
      return gateway.execute(gateway.evaluate(prepared), {
        signal: new AbortController().signal,
      });
    },
  };
}

test("R1 workspace summary executes through validation, policy, and release", async () => {
  const fixture = setup();
  assert.deepEqual(
    fixture.advertisement.operations.map((operation) => operation.operationId),
    ["workspace_summary", "inspect_file"],
  );
  const result = await fixture.execute(
    ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_REFERENCE,
    {},
  );
  assert.deepEqual(result.agent, {
    candidateFile: "src/calculate.ts",
    primaryLanguage: "TypeScript",
    repositoryName: "robin-r1-fixture",
    testCommand: "npm test",
  });
  assert.equal(result.agentContextRelease.classification, "synthetic");
});

test("R1 inspect tool returns bounded fixture lines and a content hash", async () => {
  const fixture = setup();
  const result = await fixture.execute(
    ROBIN_SYNTHETIC_INSPECT_FILE_REFERENCE,
    { path: "src/calculate.ts" },
  );
  assert.equal(result.agent["path"], "src/calculate.ts");
  assert.equal((result.agent["lines"] as readonly string[]).length, 3);
  assert.match(String(result.agent["contentHash"]), /^sha256:[0-9a-f]{64}$/u);
});

test("R1 fixture rejects unknown paths before handler execution", async () => {
  const fixture = setup();
  await assert.rejects(
    fixture.execute(ROBIN_SYNTHETIC_INSPECT_FILE_REFERENCE, {
      path: "../../secrets",
    }),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
});

test("R1 fixture schemas reject hidden arguments", async () => {
  const fixture = setup();
  await assert.rejects(
    fixture.execute(ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_REFERENCE, {
      hidden: true,
    }),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
});
