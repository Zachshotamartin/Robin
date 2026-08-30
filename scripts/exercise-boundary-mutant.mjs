import assert from "node:assert/strict";

import {
  ActionIdKind,
  PolicyVersionIdKind,
  canonicalSha256Hex,
  isDomainError,
} from "@guard/contracts";

const exercise = process.argv[2];
const moduleUrl = process.argv[3];
assert.equal(typeof exercise, "string", "a boundary exercise name is required");
assert.equal(typeof moduleUrl, "string", "a mutant module URL is required");
assert.equal(
  process.env.GUARD_MUTATION_ENV_CANARY,
  undefined,
  "the mutation child inherited the seeded parent environment canary",
);
for (const name of Object.keys(process.env)) {
  assert.doesNotMatch(
    name,
    /(?:TOKEN|SECRET|CREDENTIAL|PASSWORD|AUTH|COOKIE|SESSION|AGENT|SOCKET|(?:^|_)KEY(?:_|$))/iu,
    `the mutation child inherited forbidden environment field ${name}`,
  );
}

function exerciseRepositoryPath(repositoryPath) {
  const normalize = repositoryPath.normalizeRepositoryPath;
  assert.equal(typeof normalize, "function");
  for (const value of [
    "src/./secret.txt",
    "src/../secret.txt",
    "src\\secret.txt",
    "%2e%2e/secret.txt",
    "src/CoN.txt",
  ]) {
    assert.throws(
      () => normalize(value, { allowRoot: false }),
      (error) => isDomainCode(error, "invalid_input"),
      `repository path boundary accepted ${JSON.stringify(value)}`,
    );
  }
  assert.equal(
    normalize("src/cafe\u0301.txt", { allowRoot: false }),
    "src/caf\u00e9.txt",
    "repository path boundary skipped NFC normalization",
  );
}

async function exerciseGatewayInput(gatewayModule) {
  const fixture = makeGatewayFixture(gatewayModule);
  await assert.rejects(
    fixture.gateway.normalize(
      proposal({ value: 7 }),
      normalizationContext(),
      fixture.advertisement,
    ),
    (error) => isDomainCode(error, "invalid_input"),
    "gateway accepted an input that violates the installed tool schema",
  );
}

async function exerciseGatewayOutput(gatewayModule) {
  const fixture = makeGatewayFixture(gatewayModule, { invalidOutput: true });
  const prepared = await fixture.gateway.normalize(
    proposal({ value: "alpha" }),
    normalizationContext(),
    fixture.advertisement,
  );
  const evaluated = fixture.gateway.evaluate(prepared);
  await assert.rejects(
    fixture.gateway.execute(evaluated, {
      signal: new AbortController().signal,
    }),
    (error) => isDomainCode(error, "invariant_violated"),
    "gateway released an output that violates the installed tool schema",
  );
  assert.equal(fixture.observed.releaseAction, null);
}

async function exerciseGatewayIdentity(gatewayModule) {
  const fixture = makeGatewayFixture(gatewayModule);
  const prepared = await fixture.gateway.normalize(
    proposal({ value: "alpha" }),
    normalizationContext(),
    fixture.advertisement,
  );
  assert.equal(
    prepared.actionHash,
    canonicalSha256Hex(prepared.action),
    "prepared receipt hash does not cover its exact canonical action",
  );
  assert.equal(Object.isFrozen(prepared.action), true);
  assert.equal(Object.isFrozen(prepared.action.normalizedInput), true);
  assert.equal(Object.isFrozen(prepared.action.request), true);

  const evaluated = fixture.gateway.evaluate(prepared);
  assert.equal(
    fixture.observed.policyAction,
    prepared.action,
    "policy did not receive the prepared normalized-action object",
  );
  assert.equal(Object.isFrozen(fixture.observed.policyAction), true);

  await fixture.gateway.execute(evaluated, {
    signal: new AbortController().signal,
  });
  assert.equal(
    fixture.observed.handlerAction,
    prepared.action,
    "handler did not receive the policy-evaluated normalized-action object",
  );
  assert.equal(
    fixture.observed.releaseAction,
    prepared.action,
    "release classifier did not receive the executed normalized-action object",
  );
}

async function exerciseRuntimeTransition(runtime, runtimeModuleUrl) {
  const { GOLDEN_HISTORY } = await import(
    new URL("./testdata/golden-history.js", runtimeModuleUrl)
  );
  const started = runtime.replay(GOLDEN_HISTORY.slice(0, 3));
  const paused = structuredClone(started);
  paused.status = "paused";
  paused.pausedFrom = "planning";
  paused.outstandingCommand = null;

  const repeatedStart = structuredClone(GOLDEN_HISTORY[2]);
  repeatedStart.eventId = "evt_018f0000-0000-7000-8000-000000000099";
  repeatedStart.streamVersion = 4;
  repeatedStart.occurredAt = "2026-08-30T10:00:04.000Z";
  repeatedStart.recordedAt = "2026-08-30T10:00:04.000Z";
  repeatedStart.causationId = started.lastEventId;

  assert.throws(
    () => runtime.evolve(paused, repeatedStart),
    (error) => isDomainCode(error, "invariant_violated"),
    "runtime reducer accepted RunStarted from paused",
  );
}

const REFERENCE = Object.freeze({
  packId: "fixture.boundary",
  packVersion: 1,
  operationId: "inspect",
  operationVersion: 1,
});
const ACTION_ID = ActionIdKind.parse(
  "act_018f05a0-7b01-7000-8000-000000000091",
);
const POLICY_VERSION_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000092",
);
const CATALOG_HASH = "b".repeat(64);

function makeGatewayFixture(gatewayModule, options = {}) {
  const observed = {
    policyAction: null,
    handlerAction: null,
    releaseAction: null,
  };
  const operation = {
    definition: {
      operationId: REFERENCE.operationId,
      operationVersion: REFERENCE.operationVersion,
      description: "Exercise a bounded gateway contract.",
      inputSchema: {
        schemaId: "fixture.boundary.input",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "string" } },
        },
      },
      outputSchema: {
        schemaId: "fixture.boundary.output",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["result"],
          properties: { result: { type: "string" } },
        },
      },
      sideEffectClass: "none",
    },
    agentContextRelease: {
      schemaVersion: 1,
      sourceVersion: 1,
      catalogId: "fixture.boundary",
      catalogVersion: 1,
      catalogContentHash: CATALOG_HASH,
      classification: "internal",
      reason: "fixture.boundary.output",
    },
    normalize() {
      return {
        normalizedInput: { value: "alpha" },
        resource: {
          scheme: "fixture",
          sourceId: "fixture.boundary",
          classification: "internal",
          key: "alpha",
        },
        request: { intent: "inspect", key: "alpha" },
        preconditions: [],
      };
    },
    async execute(action) {
      observed.handlerAction = action;
      return options.invalidOutput === true
        ? { unexpected: "schema violation" }
        : { result: "ok" };
    },
    release(raw, action) {
      observed.releaseAction = action;
      const agent = { result: "released" };
      const descriptor = {
        schemaVersion: 1,
        sourceVersion: 1,
        resource: {
          schemaVersion: 1,
          scheme: "fixture",
          sourceId: "fixture.boundary",
          locator: { key: action.resource.key },
          mediaType: "application/json",
          classification: "internal",
        },
        policyProjection: {
          schemaVersion: 1,
          catalogId: "fixture.boundary",
          catalogVersion: 1,
          catalogContentHash: CATALOG_HASH,
          resourceAttributes: { key: action.resource.key },
          requestAttributes: { key: action.request.key },
        },
        classification: "internal",
        reason: "fixture.boundary.output",
      };
      return {
        audit: { outcome: "fixture" },
        human: { summary: "Fixture boundary completed." },
        agent,
        agentContextRelease: gatewayModule.bindCapabilityAgentContextRelease(
          descriptor,
          action,
          raw,
          agent,
        ),
      };
    },
  };
  const registry = new gatewayModule.CapabilityPackRegistry([
    {
      packId: REFERENCE.packId,
      packVersion: REFERENCE.packVersion,
      operations: [operation],
    },
  ]);
  const gateway = new gatewayModule.CapabilityGateway(
    registry,
    policyEvaluator(observed),
  );
  return {
    gateway,
    observed,
    advertisement: registry.createAdvertisement([REFERENCE]),
  };
}

function policyEvaluator(observed) {
  return Object.freeze({
    policyVersionId: POLICY_VERSION_ID,
    evaluate(action) {
      observed.policyAction = action;
      return {
        policyVersionId: POLICY_VERSION_ID,
        effect: "allow",
        winningPolicyName: null,
        reason: "The boundary fixture allows this action.",
        matchedPolicyNames: [],
        trace: {
          languageVersion: "1",
          policyContentHash: "a".repeat(64),
          attributeCatalogs: [],
          combiningAlgorithm: "deny_overrides",
          defaultEffect: "allow",
          result: "allow",
          winningPolicyName: null,
          evaluations: [],
          matchedPolicyNames: [],
        },
      };
    },
  });
}

function proposal(input) {
  return {
    schemaVersion: 1,
    ...REFERENCE,
    input,
  };
}

function normalizationContext() {
  return {
    actionId: ACTION_ID,
    subject: { kind: "scripted", driverId: "driver:boundary" },
    environment: {
      profileId: "fixture:boundary",
      sandboxed: true,
      networkProfile: "deny",
      trustLevel: "trusted",
    },
  };
}

function isDomainCode(error, code) {
  return isDomainError(error) && error.code === code;
}

try {
  await runSelectedExercise();
} catch (error) {
  if (error instanceof assert.AssertionError) {
    process.stderr.write(
      `GUARD_BOUNDARY_MUTATION_KILLED: ${error.message.split("\n", 1)[0]}\n`,
    );
    process.exitCode = 86;
  } else {
    throw error;
  }
}

async function runSelectedExercise() {
  const target = await import(moduleUrl);
  switch (exercise) {
    case "repository-path":
      exerciseRepositoryPath(target);
      return;
    case "gateway-input":
      await exerciseGatewayInput(target);
      return;
    case "gateway-output":
      await exerciseGatewayOutput(target);
      return;
    case "gateway-identity":
      await exerciseGatewayIdentity(target);
      return;
    case "runtime-transition":
      await exerciseRuntimeTransition(target, moduleUrl);
      return;
    default:
      throw new Error(`unknown boundary exercise ${String(exercise)}`);
  }
}
