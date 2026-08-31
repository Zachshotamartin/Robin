import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  parseNormalizedAction,
  type SideEffectClass,
} from "@guard/contracts";

import {
  createRobinR2PolicyEvaluator,
  robinR2PolicySnapshot,
} from "./r2-policy.js";

const CASES = Object.freeze([
  ["robin.repo", "list_files", "none", "allow"],
  ["robin.repo", "search_text", "none", "allow"],
  ["robin.repo", "read_file", "none", "allow"],
  ["robin.git", "status", "none", "allow"],
  ["robin.git", "diff", "none", "allow"],
  ["robin.edit", "apply_patch", "local_reversible", "require_approval"],
  ["robin.edit", "create_file", "local_reversible", "require_approval"],
  ["robin.process", "run", "local_irreversible", "require_approval"],
] as const);

test("R2 ask policy allows bounded reads and approval-gates every installed effect", () => {
  const evaluator = createRobinR2PolicyEvaluator(
    "ask",
    "robin-r2-policy-test-correlation-token-0001",
  );
  for (const [packId, operationId, sideEffectClass, expected] of CASES) {
    assert.equal(
      evaluator.evaluate(action(packId, operationId, sideEffectClass)).effect,
      expected,
      `${packId}.${operationId}`,
    );
  }
  assert.equal(
    evaluator.evaluate(action("robin.process", "shell", "local_irreversible"))
      .effect,
    "deny",
  );
  assert.equal(robinR2PolicySnapshot("ask").defaultEffect, "deny");
});

test("R2 plan policy remains read-only and denies edit and process effects", () => {
  const evaluator = createRobinR2PolicyEvaluator(
    "plan",
    "robin-r2-policy-test-correlation-token-0002",
  );
  for (const [packId, operationId, sideEffectClass] of CASES) {
    const expected = sideEffectClass === "none" ? "allow" : "deny";
    assert.equal(
      evaluator.evaluate(action(packId, operationId, sideEffectClass)).effect,
      expected,
      `${packId}.${operationId}`,
    );
  }
});

function action(
  capabilityPackId: string,
  operationId: string,
  sideEffectClass: SideEffectClass,
) {
  return parseNormalizedAction({
    schemaVersion: 1,
    actionId: ActionIdKind.parse(
      "act_018f05a0-7b01-7000-8000-000000000211",
    ),
    capabilityPackId,
    capabilityPackVersion: 1,
    operationId,
    operationVersion: 1,
    subject: { kind: "agent_driver", driverId: "robin.test" },
    resource: {
      scheme: "workspace",
      sourceId: "fixture",
      classification: "repository",
      workspaceId: "fixture",
    },
    environment: {
      profileId: "robin-r2",
      sandboxed: false,
      networkProfile: "ambient_unsandboxed",
      trustLevel: "generated_fixture",
    },
    request: {},
    normalizedInput: {},
    sideEffectClass,
    preconditions: [],
  });
}
