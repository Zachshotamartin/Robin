import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  ArtifactIdKind,
  DEFAULT_JSON_BOUNDARY_LIMITS,
  PolicyVersionIdKind,
  canonicalBytes,
  canonicalize,
  createDomainError,
  isDomainError,
} from "@guard/contracts";
import type { JsonObject, NormalizedAction } from "@guard/contracts";
import {
  compilePolicySnapshot,
  createPinnedPolicyEvaluator,
} from "@guard/policy-engine";
import type {
  PinnedPolicyEvaluator,
  PolicyDecision,
  PolicyEffect,
} from "@guard/policy-engine";
import type { CompiledJsonObjectSchema } from "@guard/schema-validation";

import {
  bindCapabilityAgentContextRelease,
  CapabilityGateway,
  CapabilityPackRegistry,
  DEFAULT_MAXIMUM_OPERATION_SCHEMA_BYTES,
  type CapabilityOperation,
  type CapabilityOperationLifecycle,
  type CapabilityOperationReference,
  type CapabilityPack,
  type CapabilityPreparationDescriptor,
  type CapabilityReleasedViews,
  type CapabilitySemanticNormalization,
} from "./index.js";
import { runCompiledValidation } from "./capability-pack-registry.js";

const ACTION_ID = ActionIdKind.parse(
  "act_018f05a0-7b01-7000-8000-000000000071",
);
const POLICY_VERSION_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000072",
);
const DENY_POLICY_VERSION_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000075",
);

const REFERENCE: CapabilityOperationReference = {
  packId: "fixture.counter",
  packVersion: 1,
  operationId: "increment",
  operationVersion: 1,
};

function isDomainCode(error: unknown, code: string): boolean {
  return isDomainError(error) && error.code === code;
}

function isSanitizedDomainCode(
  error: unknown,
  code: string,
  secret: string,
): boolean {
  return (
    isDomainError(error) &&
    error.code === code &&
    !error.message.includes(secret)
  );
}

interface OperationSpies {
  normalizeCalls: number;
  executeCalls: number;
  releaseCalls: number;
  executedAction: NormalizedAction | null;
}

interface PolicySpies {
  evaluateCalls: number;
  evaluatedAction: NormalizedAction | null;
}

function policySpies(): PolicySpies {
  return { evaluateCalls: 0, evaluatedAction: null };
}

function policyDecision(
  effect: PolicyEffect = "allow",
  overrides: Partial<PolicyDecision> = {},
): PolicyDecision {
  const resolvedEffect = overrides.effect ?? effect;
  const winningPolicyName = overrides.winningPolicyName ?? null;
  const matchedPolicyNames = overrides.matchedPolicyNames ??
    (winningPolicyName === null ? [] : [winningPolicyName]);
  const trace = overrides.trace ?? {
    languageVersion: "1",
    policyContentHash: "a".repeat(64),
    attributeCatalogs: [],
    combiningAlgorithm: "deny_overrides",
    defaultEffect: winningPolicyName === null ? resolvedEffect : "deny",
    result: resolvedEffect,
    winningPolicyName,
    evaluations: [],
    matchedPolicyNames,
  };
  return Object.freeze({
    policyVersionId: overrides.policyVersionId ?? POLICY_VERSION_ID,
    effect: resolvedEffect,
    winningPolicyName,
    reason: overrides.reason ?? `Fixture policy returned ${resolvedEffect}.`,
    matchedPolicyNames: Object.freeze([...matchedPolicyNames]),
    trace: Object.freeze(trace),
  });
}

function policyEvaluator(
  options: {
    readonly effect?: PolicyEffect;
    readonly spies?: PolicySpies;
    readonly decide?: (action: NormalizedAction) => PolicyDecision;
  } = {},
): PinnedPolicyEvaluator {
  const observed = options.spies;
  return Object.freeze({
    policyVersionId: POLICY_VERSION_ID,
    evaluate(action: NormalizedAction): PolicyDecision {
      if (observed !== undefined) {
        observed.evaluateCalls += 1;
        observed.evaluatedAction = action;
      }
      return options.decide?.(action) ?? policyDecision(options.effect ?? "allow");
    },
  });
}

function compiledPolicyEvaluator(
  effect: "allow" | "deny",
  policyVersionId: string,
): PinnedPolicyEvaluator {
  const result = compilePolicySnapshot({
    policyVersionId,
    sourceId: `gateway-${effect}.guard`,
    source: `policy "${effect}-counter" priority 10 {
  when action.operation == "increment"
  ${effect}
  reason "The compiled fixture policy returned ${effect}."
}
`,
    defaultEffect: effect === "allow" ? "deny" : "allow",
  });
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : JSON.stringify(result.diagnostics),
  );
  if (!result.ok) throw new Error("unreachable fixture policy compile failure");
  return createPinnedPolicyEvaluator(result.snapshot, {
    secretCorrelationToken: "gateway-real-engine-fixture-token",
  });
}

function counterOperation(
  spies: OperationSpies,
  options: {
    operationId?: string;
    operationVersion?: number;
    invalidOutput?: boolean;
    rawPadding?: string;
    releasedPadding?: string;
  } = {},
): CapabilityOperation {
  const operationId = options.operationId ?? "increment";
  const operationVersion = options.operationVersion ?? 1;
  return {
    definition: {
      operationId,
      operationVersion,
      description: "Increment a positive fixture counter.",
      inputSchema: {
        schemaId: `fixture.counter.${operationId}.input`,
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["value", "label"],
          properties: {
            value: { type: "integer" },
            label: { type: "string" },
          },
        },
      },
      outputSchema: {
        schemaId: `fixture.counter.${operationId}.output`,
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["next"],
          properties: {
            next: { type: "integer" },
            padding: { type: "string" },
          },
        },
      },
      sideEffectClass: "none",
    },
    agentContextRelease: {
      schemaVersion: 1,
      sourceVersion: operationVersion,
      catalogId: "fixture.counter",
      catalogVersion: 1,
      catalogContentHash: "b".repeat(64),
      classification: "internal",
      reason: "capability.counter.output",
    },
    normalize(input): CapabilitySemanticNormalization {
      spies.normalizeCalls += 1;
      const value = input["value"] as number;
      const label = (input["label"] as string).trim();
      if (value <= 0 || label.length === 0) {
        throw createDomainError({
          code: "invalid_input",
          message: "Counter value and label must be semantically positive.",
        });
      }
      return {
        normalizedInput: { label, value },
        resource: {
          scheme: "fixture",
          sourceId: "fixture.counter",
          classification: "internal",
          counter: label,
        },
        request: { intent: "increment", amount: 1 },
        preconditions: [
          {
            preconditionType: "fixture.counter.value",
            preconditionVersion: 1,
            attributes: { value },
          },
        ],
      };
    },
    async execute(action): Promise<JsonObject> {
      spies.executeCalls += 1;
      spies.executedAction = action;
      const next = (action.normalizedInput["value"] as number) + 1;
      if (options.invalidOutput === true) return { next, extra: true };
      return {
        next,
        ...(options.rawPadding === undefined
          ? {}
          : { padding: options.rawPadding }),
      };
    },
    release(raw, action) {
      spies.releaseCalls += 1;
      const agent: JsonObject = {
        next: raw["next"]!,
        ...(options.releasedPadding === undefined
          ? {}
          : { padding: options.releasedPadding }),
      };
      return {
        audit: {
          actionId: action.actionId,
          outputKeys: Object.keys(raw).sort(),
        },
        human: { summary: `Counter is ${String(raw["next"])}` },
        agent,
        agentContextRelease: bindCapabilityAgentContextRelease(
          {
            schemaVersion: 1,
            sourceVersion: operationVersion,
            resource: {
              schemaVersion: 1,
              scheme: "fixture",
              sourceId: "fixture.counter",
              locator: { counter: action.resource["counter"]! },
              mediaType: "application/json",
              classification: "internal",
            },
            policyProjection: {
              schemaVersion: 1,
              catalogId: "fixture.counter",
              catalogVersion: 1,
              catalogContentHash: "b".repeat(64),
              resourceAttributes: { counter: action.resource["counter"]! },
              requestAttributes: {},
            },
            classification: "internal",
            reason: "capability.counter.output",
          },
          action,
          raw,
          agent,
        ),
      };
    },
  };
}

function counterOperationWithReleaseMutation(
  operationSpies: OperationSpies,
  mutate: (
    released: CapabilityReleasedViews,
    raw: JsonObject,
    action: NormalizedAction,
  ) => unknown,
): CapabilityOperation {
  const operation = counterOperation(operationSpies);
  return {
    ...operation,
    async release(raw, action) {
      const released = await operation.release(raw, action);
      return mutate(released, raw, action) as CapabilityReleasedViews;
    },
  };
}

function spies(): OperationSpies {
  return {
    normalizeCalls: 0,
    executeCalls: 0,
    releaseCalls: 0,
    executedAction: null,
  };
}

function pack(
  operation: CapabilityOperation,
  overrides: Partial<Pick<CapabilityPack, "packId" | "packVersion">> = {},
): CapabilityPack {
  return {
    packId: overrides.packId ?? REFERENCE.packId,
    packVersion: overrides.packVersion ?? REFERENCE.packVersion,
    operations: [operation],
  };
}

function normalizationContext() {
  return {
    actionId: ACTION_ID,
    subject: { kind: "scripted", driverId: "driver:fixture" },
    environment: {
      profileId: "synthetic",
      sandboxed: false,
      networkProfile: "deny",
      trustLevel: "trusted",
    },
  } as const;
}

function proposal(input: unknown = { value: 4, label: " alpha " }) {
  return {
    schemaVersion: 1 as const,
    ...REFERENCE,
    input,
  };
}

async function assertMutatedReleaseRejected(
  mutate: Parameters<typeof counterOperationWithReleaseMutation>[1],
): Promise<void> {
  const calls = spies();
  const registry = new CapabilityPackRegistry([
    pack(counterOperationWithReleaseMutation(calls, mutate)),
  ]);
  const gateway = new CapabilityGateway(registry, policyEvaluator());
  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    registry.createAdvertisement([REFERENCE]),
  );
  await assert.rejects(
    gateway.execute(gateway.evaluate(prepared), {
      signal: new AbortController().signal,
    }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(calls.executeCalls, 1);
  assert.equal(calls.releaseCalls, 1);
}

test("compiles strict versioned schemas at registry startup", () => {
  const validSpies = spies();
  const valid = new CapabilityPackRegistry([pack(counterOperation(validSpies))]);
  assert.deepEqual(valid.listPacks(), [
    {
      packId: "fixture.counter",
      packVersion: 1,
      operations: [
        {
          packId: "fixture.counter",
          packVersion: 1,
          operationId: "increment",
          operationVersion: 1,
          description: "Increment a positive fixture counter.",
          inputSchema: {
            schemaId: "fixture.counter.increment.input",
            schemaVersion: 1,
            document: {
              type: "object",
              additionalProperties: false,
              required: ["value", "label"],
              properties: {
                value: { type: "integer" },
                label: { type: "string" },
              },
            },
          },
          sideEffectClass: "none",
          agentContextRelease: {
            schemaVersion: 1,
            sourceVersion: 1,
            catalogId: "fixture.counter",
            catalogVersion: 1,
            catalogContentHash: "b".repeat(64),
            classification: "internal",
            reason: "capability.counter.output",
          },
        },
      ],
    },
  ]);
  assert.equal(Object.isFrozen(valid.listPacks()), true);
  assert.equal(Object.isFrozen(valid.listPacks()[0]!.operations), true);

  const invalidSchemaOperation = counterOperation(spies());
  const invalidSchemaPack: CapabilityPack = {
    ...pack(invalidSchemaOperation),
    operations: [
      {
        ...invalidSchemaOperation,
        definition: {
          ...invalidSchemaOperation.definition,
          inputSchema: {
            schemaId: "invalid.strict.input",
            schemaVersion: 1,
            document: {
              type: "object",
              additionalProperties: false,
              madeUpKeyword: true,
            },
          },
        },
      },
    ],
  };
  assert.throws(
    () => new CapabilityPackRegistry([invalidSchemaPack]),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const permissiveRootOperation = counterOperation(spies());
  const permissiveRootPack: CapabilityPack = {
    ...pack(permissiveRootOperation),
    operations: [
      {
        ...permissiveRootOperation,
        definition: {
          ...permissiveRootOperation.definition,
          inputSchema: {
            schemaId: "invalid.permissive.input",
            schemaVersion: 1,
            document: {
              type: "object",
              properties: { value: { type: "integer" } },
            },
          },
        },
      },
    ],
  };
  assert.throws(
    () => new CapabilityPackRegistry([permissiveRootPack]),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const asyncSchemaOperation = counterOperation(spies());
  const asyncSchemaPack: CapabilityPack = {
    ...pack(asyncSchemaOperation),
    operations: [
      {
        ...asyncSchemaOperation,
        definition: {
          ...asyncSchemaOperation.definition,
          inputSchema: {
            schemaId: "invalid.async.input",
            schemaVersion: 1,
            document: {
              $async: true,
              type: "object",
              additionalProperties: false,
              properties: {},
            },
          },
        },
      },
    ],
  };
  assert.throws(
    () => new CapabilityPackRegistry([asyncSchemaPack]),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("bounds installed operation schemas before shared compiler traversal", () => {
  assert.equal(
    DEFAULT_MAXIMUM_OPERATION_SCHEMA_BYTES <
      DEFAULT_JSON_BOUNDARY_LIMITS.maximumCanonicalUtf8Bytes,
    true,
  );
  const operation = counterOperation(spies());
  const exact = Math.max(
    canonicalBytes(operation.definition.inputSchema).byteLength,
    canonicalBytes(operation.definition.outputSchema).byteLength,
  );
  assert.doesNotThrow(
    () => new CapabilityPackRegistry([pack(operation)], {
      maximumSchemaBytes: exact,
    }),
  );
  assert.throws(
    () => new CapabilityPackRegistry([pack(operation)], {
      maximumSchemaBytes: exact - 1,
    }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const canary = "REGISTRY_SCHEMA_LIMIT_CANARY";
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "maximumSchemaBytes", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(canary);
    },
  });
  assert.throws(
    () => new CapabilityPackRegistry([pack(operation)], accessor),
    (error: unknown) =>
      isDomainError(error) && !JSON.stringify(error).includes(canary),
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () => new CapabilityPackRegistry([pack(operation)], {
      maximumSchemaBytes:
        DEFAULT_JSON_BOUNDARY_LIMITS.maximumCanonicalUtf8Bytes + 1,
    }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("sanitizes unexpected compiled-validator failures", () => {
  const throwingValidator: CompiledJsonObjectSchema = Object.freeze({
    schemaId: "fixture.throwing.input",
    schemaVersion: 1,
    maxValueBytes: 1_024,
    validate() {
      throw new Error("validator-internal-secret");
    },
  });

  assert.throws(
    () => runCompiledValidation(throwingValidator, {}, "input"),
    (error: unknown) =>
      isSanitizedDomainCode(
        error,
        "invariant_violated",
        "validator-internal-secret",
      ),
  );
});

test("inspects trusted executable pack installations without invoking accessors", () => {
  const installationCanary = "pack-installation-canary";
  let packGetterCalls = 0;
  const accessorPack: Record<string, unknown> = {
    packVersion: 1,
    operations: [counterOperation(spies())],
  };
  Object.defineProperty(accessorPack, "packId", {
    enumerable: true,
    get() {
      packGetterCalls += 1;
      throw new Error(installationCanary);
    },
  });
  assert.throws(
    () => new CapabilityPackRegistry([accessorPack as unknown as CapabilityPack]),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invalid_input", installationCanary),
  );
  assert.equal(packGetterCalls, 0, "pack getter must never run");

  let definitionGetterCalls = 0;
  const baseOperation = counterOperation(spies());
  const accessorOperation: Record<string, unknown> = {
    agentContextRelease: baseOperation.agentContextRelease,
    normalize: baseOperation.normalize,
    execute: baseOperation.execute,
    release: baseOperation.release,
  };
  Object.defineProperty(accessorOperation, "definition", {
    enumerable: true,
    get() {
      definitionGetterCalls += 1;
      throw new Error(installationCanary);
    },
  });
  assert.throws(
    () =>
      new CapabilityPackRegistry([
        {
          packId: REFERENCE.packId,
          packVersion: REFERENCE.packVersion,
          operations: [accessorOperation as unknown as CapabilityOperation],
        },
      ]),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invalid_input", installationCanary),
  );
  assert.equal(definitionGetterCalls, 0, "definition getter must never run");

  let releaseDefinitionGetterCalls = 0;
  const accessorReleaseDefinitionOperation = {
    ...baseOperation,
  } as Record<string, unknown>;
  Object.defineProperty(
    accessorReleaseDefinitionOperation,
    "agentContextRelease",
    {
      enumerable: true,
      get() {
        releaseDefinitionGetterCalls += 1;
        throw new Error(installationCanary);
      },
    },
  );
  assert.throws(
    () =>
      new CapabilityPackRegistry([
        pack(accessorReleaseDefinitionOperation as unknown as CapabilityOperation),
      ]),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invalid_input", installationCanary),
  );
  assert.equal(
    releaseDefinitionGetterCalls,
    0,
    "release-definition getter must never run",
  );

  let releaseDefinitionProxyCalls = 0;
  const proxiedReleaseDefinition = new Proxy(baseOperation.agentContextRelease, {
    get() {
      releaseDefinitionProxyCalls += 1;
      throw new Error(installationCanary);
    },
  });
  assert.throws(
    () =>
      new CapabilityPackRegistry([
        pack({
          ...baseOperation,
          agentContextRelease: proxiedReleaseDefinition,
        }),
      ]),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invalid_input", installationCanary),
  );
  assert.equal(releaseDefinitionProxyCalls, 0, "release-definition proxy stays inert");

  assert.throws(
    () =>
      new CapabilityPackRegistry([
        pack({
          ...baseOperation,
          agentContextRelease: {
            ...baseOperation.agentContextRelease,
            unexpected: true,
          } as unknown as CapabilityOperation["agentContextRelease"],
        }),
      ]),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  let proxyGetCalls = 0;
  const proxiedPack = new Proxy(pack(counterOperation(spies())), {
    get() {
      proxyGetCalls += 1;
      throw new Error(installationCanary);
    },
  });
  assert.throws(
    () => new CapabilityPackRegistry([proxiedPack]),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invalid_input", installationCanary),
  );
  assert.equal(proxyGetCalls, 0, "pack get trap must never run");

  const revoked = Proxy.revocable(pack(counterOperation(spies())), {});
  revoked.revoke();
  assert.throws(
    () => new CapabilityPackRegistry([revoked.proxy]),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invalid_input", installationCanary),
  );

  const inexactPack = {
    ...pack(counterOperation(spies())),
    unexpected: true,
  } as unknown as CapabilityPack;
  assert.throws(
    () => new CapabilityPackRegistry([inexactPack]),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  const operation = counterOperation(spies());
  const inexactOperation = {
    ...operation,
    unexpected: true,
  } as unknown as CapabilityOperation;
  assert.throws(
    () => new CapabilityPackRegistry([pack(inexactOperation)]),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  // Handler functions remain trusted installed code. Registration only
  // inspects their data descriptors and detached JSON definitions.
  const trusted = new CapabilityPackRegistry([
    pack(counterOperation(spies())),
  ]);
  assert.equal(trusted.listPacks()[0]!.packId, REFERENCE.packId);
});

test("rejects duplicate pack and operation versions while allowing explicit new versions", () => {
  const first = pack(counterOperation(spies()));
  assert.throws(
    () => new CapabilityPackRegistry([first, first]),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
  assert.throws(
    () =>
      new CapabilityPackRegistry([
        {
          ...first,
          operations: [counterOperation(spies()), counterOperation(spies())],
        },
      ]),
    (error: unknown) => isDomainCode(error, "conflict"),
  );

  const registry = new CapabilityPackRegistry([
    first,
    pack(counterOperation(spies()), { packVersion: 2 }),
  ]);
  assert.equal(registry.listPacks().length, 2);
});

test("advertises only known exact operation versions and pins an immutable advertisement", () => {
  const registry = new CapabilityPackRegistry([pack(counterOperation(spies()))]);
  const advertisement = registry.createAdvertisement([REFERENCE]);

  assert.deepEqual(advertisement.operations.map((entry) => ({
    packId: entry.packId,
    packVersion: entry.packVersion,
    operationId: entry.operationId,
    operationVersion: entry.operationVersion,
  })), [REFERENCE]);
  assert.equal(Object.isFrozen(advertisement), true);
  assert.equal(Object.isFrozen(advertisement.operations), true);
  assert.equal(Object.isFrozen(advertisement.operations[0]!.inputSchema.document), true);

  assert.throws(
    () =>
      registry.createAdvertisement([
        { ...REFERENCE, operationId: "unknown" },
      ]),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  assert.throws(
    () => registry.createAdvertisement([REFERENCE, REFERENCE]),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
});

test("keeps structural schema validation separate from semantic normalization", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(registry, policyEvaluator());
  const advertisement = registry.createAdvertisement([REFERENCE]);

  const structurallyInvalid: readonly unknown[] = [
    { value: 4, label: "alpha", extra: true },
    { value: "4", label: "alpha" },
    { value: 4 },
    null,
  ];
  for (const input of structurallyInvalid) {
    await assert.rejects(
      gateway.normalize(proposal(input), normalizationContext(), advertisement),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
  const attackerCanary = "attacker-controlled-property-canary";
  await assert.rejects(
    gateway.normalize(
      proposal({ value: 4, label: "alpha", [attackerCanary]: attackerCanary }),
      normalizationContext(),
      advertisement,
    ),
    (error: unknown) => {
      assert.equal(isDomainError(error), true);
      if (!isDomainError(error)) return false;
      assert.equal(error.code, "invalid_input");
      assert.equal(JSON.stringify(error).includes(attackerCanary), false);
      assert.deepEqual(error.details, {
        violations: [{ keyword: "additionalProperties" }],
      });
      return true;
    },
  );
  assert.equal(
    calls.normalizeCalls,
    0,
    "structural validation rejects before handwritten semantics",
  );
  assert.equal(calls.executeCalls, 0);

  await assert.rejects(
    gateway.normalize(
      proposal({ value: 0, label: " " }),
      normalizationContext(),
      advertisement,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  assert.equal(calls.normalizeCalls, 1, "schema-valid input reaches semantics");
  assert.equal(calls.executeCalls, 0);
});

test("bounds canonical input bytes before trusted schema traversal", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(
    registry,
    policyEvaluator(),
    { maximumInputBytes: 16 },
  );
  const advertisement = registry.createAdvertisement([REFERENCE]);

  await assert.rejects(
    gateway.normalize(
      proposal({ value: 4, label: "a label too large" }),
      normalizationContext(),
      advertisement,
    ),
    (error: unknown) => isDomainCode(error, "budget_exceeded"),
  );
  assert.equal(calls.normalizeCalls, 0);
  assert.equal(calls.executeCalls, 0);
});

test("bounds raw output plus each and combined released view before return", async () => {
  const rawCalls = spies();
  const rawRegistry = new CapabilityPackRegistry([
    pack(counterOperation(rawCalls, { rawPadding: "x".repeat(128) })),
  ]);
  const rawGateway = new CapabilityGateway(rawRegistry, policyEvaluator(), {
    maximumInputBytes: 1_024,
    maximumRawOutputBytes: 64,
    maximumReleasedViewBytes: 1_024,
    maximumCombinedReleasedViewBytes: 2_048,
  });
  const rawAdvertisement = rawRegistry.createAdvertisement([REFERENCE]);
  const rawPrepared = await rawGateway.normalize(
    proposal(),
    normalizationContext(),
    rawAdvertisement,
  );
  const rawEvaluated = rawGateway.evaluate(rawPrepared);
  await assert.rejects(
    rawGateway.execute(rawEvaluated, {
      signal: new AbortController().signal,
    }),
    (error: unknown) => isDomainCode(error, "budget_exceeded"),
  );
  assert.equal(rawCalls.executeCalls, 1);
  assert.equal(rawCalls.releaseCalls, 0, "oversize raw data is never classified");

  const viewCalls = spies();
  const viewRegistry = new CapabilityPackRegistry([
    pack(counterOperation(viewCalls, { releasedPadding: "x".repeat(128) })),
  ]);
  const viewGateway = new CapabilityGateway(viewRegistry, policyEvaluator(), {
    maximumInputBytes: 1_024,
    maximumRawOutputBytes: 1_024,
    maximumReleasedViewBytes: 64,
    maximumCombinedReleasedViewBytes: 2_048,
  });
  const viewAdvertisement = viewRegistry.createAdvertisement([REFERENCE]);
  const viewPrepared = await viewGateway.normalize(
    proposal(),
    normalizationContext(),
    viewAdvertisement,
  );
  const viewEvaluated = viewGateway.evaluate(viewPrepared);
  await assert.rejects(
    viewGateway.execute(viewEvaluated, {
      signal: new AbortController().signal,
    }),
    (error: unknown) => isDomainCode(error, "budget_exceeded"),
  );
  assert.equal(viewCalls.releaseCalls, 1);

  const combinedCalls = spies();
  const combinedRegistry = new CapabilityPackRegistry([
    pack(counterOperation(combinedCalls)),
  ]);
  const combinedGateway = new CapabilityGateway(combinedRegistry, policyEvaluator(), {
    maximumInputBytes: 1_024,
    maximumRawOutputBytes: 1_024,
    maximumReleasedViewBytes: 1_024,
    maximumCombinedReleasedViewBytes: 32,
  });
  const combinedAdvertisement = combinedRegistry.createAdvertisement([REFERENCE]);
  const combinedPrepared = await combinedGateway.normalize(
    proposal(),
    normalizationContext(),
    combinedAdvertisement,
  );
  const combinedEvaluated = combinedGateway.evaluate(combinedPrepared);
  await assert.rejects(
    combinedGateway.execute(combinedEvaluated, {
      signal: new AbortController().signal,
    }),
    (error: unknown) => isDomainCode(error, "budget_exceeded"),
  );

  assert.throws(
    () =>
      new CapabilityGateway(combinedRegistry, policyEvaluator(), {
        maximumRawOutputBytes: 0,
      }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("strictly captures agent-context release claims without invoking hostile values", async () => {
  await assertMutatedReleaseRejected((released) => ({
    ...released,
    unexpected: true,
  }));
  await assertMutatedReleaseRejected((released) => ({
    ...released,
    agentContextRelease: {
      ...released.agentContextRelease,
      descriptor: {
        ...released.agentContextRelease.descriptor,
        unexpected: true,
      },
    },
  }));

  const canary = "release-descriptor-access-canary";
  let proxyCalls = 0;
  await assertMutatedReleaseRejected((released) => ({
    ...released,
    agentContextRelease: {
      ...released.agentContextRelease,
      descriptor: new Proxy(released.agentContextRelease.descriptor, {
        get() {
          proxyCalls += 1;
          throw new Error(canary);
        },
      }),
    },
  }));
  assert.equal(proxyCalls, 0, "a descriptor proxy is rejected without property access");

  let getterCalls = 0;
  await assertMutatedReleaseRejected((released) => {
    const descriptor = { ...released.agentContextRelease.descriptor } as Record<
      string,
      unknown
    >;
    Object.defineProperty(descriptor, "reason", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(canary);
      },
    });
    return {
      ...released,
      agentContextRelease: {
        ...released.agentContextRelease,
        descriptor,
      },
    };
  });
  assert.equal(getterCalls, 0, "a descriptor accessor is rejected without invocation");
});

test("rejects catalog, resource, action, raw-result, and agent-view release forgeries", async () => {
  await assertMutatedReleaseRejected((released, raw, action) => {
    const descriptor = {
      ...released.agentContextRelease.descriptor,
      policyProjection: {
        ...released.agentContextRelease.descriptor.policyProjection,
        catalogId: "fixture.redirected",
      },
    };
    return {
      ...released,
      agentContextRelease: bindCapabilityAgentContextRelease(
        descriptor,
        action,
        raw,
        released.agent,
      ),
    };
  });

  await assertMutatedReleaseRejected((released, raw, action) => {
    const descriptor = {
      ...released.agentContextRelease.descriptor,
      resource: {
        ...released.agentContextRelease.descriptor.resource,
        locator: { counter: "redirected" },
      },
      policyProjection: {
        ...released.agentContextRelease.descriptor.policyProjection,
        resourceAttributes: { counter: "redirected" },
      },
    };
    return {
      ...released,
      agentContextRelease: bindCapabilityAgentContextRelease(
        descriptor,
        action,
        raw,
        released.agent,
      ),
    };
  });

  for (const field of [
    "normalizedActionHash",
    "rawResultHash",
    "agentViewHash",
    "descriptorHash",
  ] as const) {
    await assertMutatedReleaseRejected((released) => ({
      ...released,
      agentContextRelease: {
        ...released.agentContextRelease,
        binding: {
          ...released.agentContextRelease.binding,
          [field]: "0".repeat(64),
        },
      },
    }));
  }
});

test("snapshots hostile proposal and normalization context before field reads", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(registry, policyEvaluator());
  const advertisement = registry.createAdvertisement([REFERENCE]);

  let proposalGetterCalls = 0;
  const accessorProposal: Record<string, unknown> = {
    schemaVersion: 1,
    ...REFERENCE,
  };
  Object.defineProperty(accessorProposal, "input", {
    enumerable: true,
    get() {
      proposalGetterCalls += 1;
      throw new Error("proposal-accessor-secret");
    },
  });
  await assert.rejects(
    gateway.normalize(
      accessorProposal as unknown as ReturnType<typeof proposal>,
      normalizationContext(),
      advertisement,
    ),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invalid_input", "proposal-accessor-secret"),
  );
  assert.equal(proposalGetterCalls, 0, "proposal getter must never run");

  let proxyGetCalls = 0;
  const hostileProposal = new Proxy(proposal(), {
    get() {
      proxyGetCalls += 1;
      throw new Error("proposal-proxy-secret");
    },
    ownKeys() {
      throw new Error("proposal-proxy-secret");
    },
  });
  await assert.rejects(
    gateway.normalize(hostileProposal, normalizationContext(), advertisement),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invalid_input", "proposal-proxy-secret"),
  );
  assert.equal(proxyGetCalls, 0, "proposal get trap must never run");

  let contextGetterCalls = 0;
  const accessorContext: Record<string, unknown> = {
    actionId: ACTION_ID,
    subject: { kind: "scripted" },
  };
  Object.defineProperty(accessorContext, "environment", {
    enumerable: true,
    get() {
      contextGetterCalls += 1;
      throw new Error("context-accessor-secret");
    },
  });
  await assert.rejects(
    gateway.normalize(
      proposal(),
      accessorContext as unknown as ReturnType<typeof normalizationContext>,
      advertisement,
    ),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invalid_input", "context-accessor-secret"),
  );
  assert.equal(contextGetterCalls, 0, "context getter must never run");
  assert.equal(calls.normalizeCalls, 0);

  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    advertisement,
  );
  const evaluated = gateway.evaluate(prepared);
  let signalGetterCalls = 0;
  const accessorExecutionContext: Record<string, unknown> = {};
  Object.defineProperty(accessorExecutionContext, "signal", {
    enumerable: true,
    get() {
      signalGetterCalls += 1;
      throw new Error("execution-context-accessor-secret");
    },
  });
  await assert.rejects(
    gateway.execute(
      evaluated,
      accessorExecutionContext as unknown as {
        readonly signal: AbortSignal;
      },
    ),
    (error: unknown) =>
      isSanitizedDomainCode(
        error,
        "invalid_input",
        "execution-context-accessor-secret",
      ),
  );
  assert.equal(signalGetterCalls, 0, "execution-context getter must never run");
  assert.equal(calls.executeCalls, 0);
});

test("normalizes once into a canonical immutable action and stable hash", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(registry, policyEvaluator());
  const advertisement = registry.createAdvertisement([REFERENCE]);
  const mutableInput = { label: " alpha ", value: 4 };

  const prepared = await gateway.normalize(
    proposal(mutableInput),
    normalizationContext(),
    advertisement,
  );
  mutableInput.label = "tampered";
  mutableInput.value = 999;
  const equivalent = await gateway.normalize(
    proposal({ value: 4, label: "alpha" }),
    normalizationContext(),
    advertisement,
  );

  assert.deepEqual(prepared.action.normalizedInput, { label: "alpha", value: 4 });
  assert.equal(prepared.action.capabilityPackId, REFERENCE.packId);
  assert.equal(prepared.action.capabilityPackVersion, REFERENCE.packVersion);
  assert.equal(prepared.action.operationId, REFERENCE.operationId);
  assert.equal(prepared.action.operationVersion, REFERENCE.operationVersion);
  assert.match(prepared.actionHash, /^[a-f0-9]{64}$/u);
  assert.equal(prepared.actionHash, equivalent.actionHash);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.action), true);
  assert.equal(Object.isFrozen(prepared.action.normalizedInput), true);
  assert.equal(Object.isFrozen(prepared.action.preconditions), true);
  assert.equal(Object.isFrozen(prepared.action.preconditions[0]!.attributes), true);
  assert.throws(() => {
    (prepared.action.normalizedInput as { value: number }).value = 10;
  }, TypeError);
  assert.equal(canonicalize(prepared.action), canonicalize(equivalent.action));
});

test("requires the operation to belong to the exact recognized advertisement", async () => {
  const secondOperation = counterOperation(spies(), { operationId: "decrement" });
  const registry = new CapabilityPackRegistry([
    {
      packId: REFERENCE.packId,
      packVersion: REFERENCE.packVersion,
      operations: [counterOperation(spies()), secondOperation],
    },
  ]);
  const gateway = new CapabilityGateway(registry, policyEvaluator());
  const advertisement = registry.createAdvertisement([REFERENCE]);

  await assert.rejects(
    gateway.normalize(
      {
        ...proposal(),
        operationId: "decrement",
      },
      normalizationContext(),
      advertisement,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const otherRegistry = new CapabilityPackRegistry([
    pack(counterOperation(spies())),
  ]);
  const foreignAdvertisement = otherRegistry.createAdvertisement([REFERENCE]);
  await assert.rejects(
    gateway.normalize(proposal(), normalizationContext(), foreignAdvertisement),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("an allowed evaluated receipt dispatches the exact normalized action once", async () => {
  const calls = spies();
  const policyCalls = policySpies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(
    registry,
    policyEvaluator({ spies: policyCalls }),
  );
  const advertisement = registry.createAdvertisement([REFERENCE]);
  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    advertisement,
  );
  const evaluated = gateway.evaluate(prepared);

  assert.equal(policyCalls.evaluateCalls, 1);
  assert.equal(
    policyCalls.evaluatedAction,
    prepared.action,
    "policy receives the exact normalized action identity",
  );
  assert.equal(evaluated.prepared, prepared);
  assert.equal(evaluated.decision.effect, "allow");
  assert.equal(Object.isFrozen(evaluated), true);
  assert.equal(Object.isFrozen(evaluated.decision), true);
  assert.equal(Object.isFrozen(evaluated.decision.trace), true);

  await assert.rejects(
    gateway.execute(
      prepared as unknown as typeof evaluated,
      { signal: new AbortController().signal },
    ),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );

  const forged = structuredClone(evaluated);
  await assert.rejects(
    gateway.execute(forged, { signal: new AbortController().signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(calls.executeCalls, 0, "forged data never reaches the handler");

  const execution = gateway.execute(evaluated, {
    signal: new AbortController().signal,
  });
  await assert.rejects(
    gateway.execute(evaluated, { signal: new AbortController().signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  const result = await execution;
  assert.equal(calls.executeCalls, 1);
  assert.equal(calls.releaseCalls, 1);
  assert.equal(calls.executedAction, prepared.action, "dispatch receives exact identity");
  assert.deepEqual(result, {
    raw: { next: 5 },
    audit: {
      actionId: ACTION_ID,
      outputKeys: ["next"],
    },
    human: { summary: "Counter is 5" },
    agent: { next: 5 },
    agentContextRelease: {
      schemaVersion: 1,
      sourceVersion: 1,
      resource: {
        schemaVersion: 1,
        scheme: "fixture",
        sourceId: "fixture.counter",
        locator: { counter: "alpha" },
        mediaType: "application/json",
        classification: "internal",
      },
      policyProjection: {
        schemaVersion: 1,
        catalogId: "fixture.counter",
        catalogVersion: 1,
        catalogContentHash: "b".repeat(64),
        resourceAttributes: { counter: "alpha" },
        requestAttributes: {},
      },
      classification: "internal",
      reason: "capability.counter.output",
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.raw), true);
  assert.equal(Object.isFrozen(result.audit), true);
  assert.equal(Object.isFrozen(result.human), true);
  assert.equal(Object.isFrozen(result.agent), true);
  assert.equal(Object.isFrozen(result.agentContextRelease), true);
  assert.equal(Object.isFrozen(result.agentContextRelease.resource), true);
  assert.equal(Object.isFrozen(result.agentContextRelease.policyProjection), true);

  await assert.rejects(
    gateway.execute(evaluated, { signal: new AbortController().signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(calls.executeCalls, 1, "receipt replay never redispatches");
  assert.equal(calls.releaseCalls, 1);
});

test("accepts real compiled-engine decisions and enforces their effects", async () => {
  for (const [effect, policyVersionId] of [
    ["allow", POLICY_VERSION_ID],
    ["deny", DENY_POLICY_VERSION_ID],
  ] as const) {
    const calls = spies();
    const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
    const gateway = new CapabilityGateway(
      registry,
      compiledPolicyEvaluator(effect, policyVersionId),
    );
    const prepared = await gateway.normalize(
      proposal(),
      normalizationContext(),
      registry.createAdvertisement([REFERENCE]),
    );
    const evaluated = gateway.evaluate(prepared);
    assert.equal(evaluated.decision.effect, effect);
    assert.equal(evaluated.decision.winningPolicyName, `${effect}-counter`);
    const policyContentHash = evaluated.decision.trace["policyContentHash"];
    assert.equal(typeof policyContentHash, "string");
    assert.match(policyContentHash as string, /^[a-f0-9]{64}$/u);
    assert.equal(evaluated.decision.trace["result"], effect);
    assert.equal(
      (evaluated.decision.trace["attributeCatalogs"] as readonly unknown[]).length,
      1,
    );

    if (effect === "allow") {
      await gateway.execute(evaluated, {
        signal: new AbortController().signal,
      });
      assert.equal(calls.executeCalls, 1);
      assert.equal(calls.releaseCalls, 1);
    } else {
      await assert.rejects(
        gateway.execute(evaluated, {
          signal: new AbortController().signal,
        }),
        (error: unknown) => isDomainCode(error, "policy_denied"),
      );
      assert.equal(calls.executeCalls, 0);
      assert.equal(calls.releaseCalls, 0);
    }
  }
});

test("validates trusted output structurally before any release view is built", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([
    pack(counterOperation(calls, { invalidOutput: true })),
  ]);
  const gateway = new CapabilityGateway(registry, policyEvaluator());
  const advertisement = registry.createAdvertisement([REFERENCE]);
  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    advertisement,
  );
  const evaluated = gateway.evaluate(prepared);

  await assert.rejects(
    gateway.execute(evaluated, { signal: new AbortController().signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(calls.executeCalls, 1);
  assert.equal(calls.releaseCalls, 0);
});

test("honors cancellation before handler dispatch", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(registry, policyEvaluator());
  const advertisement = registry.createAdvertisement([REFERENCE]);
  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    advertisement,
  );
  const evaluated = gateway.evaluate(prepared);
  const aborted = new AbortController();
  aborted.abort("cancelled by fixture");

  await assert.rejects(
    gateway.execute(evaluated, { signal: aborted.signal }),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
  assert.equal(calls.executeCalls, 0);
});

test("constructor captures one exact passive pinned evaluator", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  let getterCalls = 0;
  const accessorEvaluator: Record<string, unknown> = {
    policyVersionId: POLICY_VERSION_ID,
  };
  Object.defineProperty(accessorEvaluator, "evaluate", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("policy evaluator getter canary");
    },
  });
  let proxyTrapCalls = 0;
  const proxyEvaluator = new Proxy(
    {},
    {
      get() {
        proxyTrapCalls += 1;
        throw new Error("policy evaluator proxy canary");
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("policy evaluator proxy canary");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("policy evaluator proxy canary");
      },
    },
  );
  const symbolEvaluator = {
    policyVersionId: POLICY_VERSION_ID,
    evaluate: () => policyDecision(),
    [Symbol("canary")]: true,
  };
  let functionProxyTrapCalls = 0;
  const proxiedEvaluate = new Proxy(
    (_action: NormalizedAction) => policyDecision(),
    {
      apply() {
        functionProxyTrapCalls += 1;
        throw new Error("policy evaluator function proxy canary");
      },
    },
  );

  for (const candidate of [
    accessorEvaluator,
    proxyEvaluator,
    symbolEvaluator,
    { policyVersionId: POLICY_VERSION_ID, evaluate: proxiedEvaluate },
    { policyVersionId: "invalid", evaluate: () => policyDecision() },
  ]) {
    assert.throws(
      () => new CapabilityGateway(
        registry,
        candidate as unknown as PinnedPolicyEvaluator,
      ),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyTrapCalls, 0);
  assert.equal(functionProxyTrapCalls, 0);

  let originalCalls = 0;
  let replacementCalls = 0;
  const mutableEvaluator = {
    policyVersionId: POLICY_VERSION_ID,
    evaluate(this: PinnedPolicyEvaluator, _action: NormalizedAction): PolicyDecision {
      originalCalls += 1;
      return policyDecision("allow", {
        policyVersionId: this.policyVersionId,
      });
    },
  };
  const gateway = new CapabilityGateway(registry, mutableEvaluator);
  mutableEvaluator.policyVersionId = PolicyVersionIdKind.parse(
    "pol_018f05a0-7b01-7000-8000-000000000073",
  );
  mutableEvaluator.evaluate = (_action: NormalizedAction): PolicyDecision => {
    replacementCalls += 1;
    return policyDecision("deny");
  };
  const advertisement = registry.createAdvertisement([REFERENCE]);
  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    advertisement,
  );
  const evaluated = gateway.evaluate(prepared);
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
  assert.equal(evaluated.decision.policyVersionId, POLICY_VERSION_ID);
  assert.equal(evaluated.decision.effect, "allow");
});

test("evaluation ownership is consumed before the evaluator can reenter", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  let gateway: CapabilityGateway;
  let prepared: Awaited<ReturnType<CapabilityGateway["normalize"]>>;
  let evaluatorCalls = 0;
  const evaluator: PinnedPolicyEvaluator = Object.freeze({
    policyVersionId: POLICY_VERSION_ID,
    evaluate(action: NormalizedAction): PolicyDecision {
      evaluatorCalls += 1;
      assert.equal(action, prepared.action);
      assert.throws(
        () => gateway.evaluate(prepared),
        (error: unknown) => isDomainCode(error, "invariant_violated"),
      );
      return policyDecision();
    },
  });
  gateway = new CapabilityGateway(registry, evaluator);
  prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    registry.createAdvertisement([REFERENCE]),
  );

  const evaluated = gateway.evaluate(prepared);
  assert.equal(evaluatorCalls, 1);
  await gateway.execute(evaluated, { signal: new AbortController().signal });
  assert.equal(calls.executeCalls, 1);
});

test("deny and approval decisions cannot reach handler or release", async () => {
  for (const [effect, expectedCode] of [
    ["deny", "policy_denied"],
    ["require_approval", "approval_required"],
  ] as const) {
    const calls = spies();
    const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
    const gateway = new CapabilityGateway(
      registry,
      policyEvaluator({ effect }),
    );
    const prepared = await gateway.normalize(
      proposal(),
      normalizationContext(),
      registry.createAdvertisement([REFERENCE]),
    );
    const evaluated = gateway.evaluate(prepared);
    assert.equal(evaluated.decision.effect, effect);

    await assert.rejects(
      gateway.execute(evaluated, { signal: new AbortController().signal }),
      (error: unknown) => isDomainCode(error, expectedCode),
    );
    assert.equal(calls.executeCalls, 0, `${effect} cannot reach handler`);
    assert.equal(calls.releaseCalls, 0, `${effect} cannot reach release`);
    await assert.rejects(
      gateway.execute(evaluated, { signal: new AbortController().signal }),
      (error: unknown) => isDomainCode(error, "invariant_violated"),
    );
  }
});

test("policy evaluator failure is sanitized, terminal, and side-effect free", async () => {
  const calls = spies();
  const policyCalls = policySpies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(
    registry,
    policyEvaluator({
      spies: policyCalls,
      decide() {
        throw new Error("evaluator failure secret canary");
      },
    }),
  );
  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    registry.createAdvertisement([REFERENCE]),
  );

  assert.throws(
    () => gateway.evaluate(prepared),
    (error: unknown) => {
      assert.equal(
        isSanitizedDomainCode(
          error,
          "policy_denied",
          "evaluator failure secret canary",
        ),
        true,
      );
      if (!isDomainError(error)) return false;
      assert.deepEqual(error.details, { reason: "policy_evaluation_error" });
      return true;
    },
  );
  assert.equal(policyCalls.evaluateCalls, 1);
  assert.equal(policyCalls.evaluatedAction, prepared.action);
  assert.equal(calls.executeCalls, 0);
  assert.equal(calls.releaseCalls, 0);
  assert.throws(
    () => gateway.evaluate(prepared),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
});

test("prepared and evaluated ownership defeats identity, hash, and foreign-gateway attacks", async () => {
  const calls = spies();
  const firstPolicyCalls = policySpies();
  const secondPolicyCalls = policySpies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const first = new CapabilityGateway(
    registry,
    policyEvaluator({ spies: firstPolicyCalls }),
  );
  const second = new CapabilityGateway(
    registry,
    policyEvaluator({ spies: secondPolicyCalls }),
  );
  const advertisement = registry.createAdvertisement([REFERENCE]);
  const firstPrepared = await first.normalize(
    proposal(), normalizationContext(), advertisement,
  );
  const secondPrepared = await second.normalize(
    proposal(), normalizationContext(), advertisement,
  );

  const reconstructedPrepared = {
    action: firstPrepared.action,
    actionHash: firstPrepared.actionHash,
  };
  const wrongHash = {
    action: firstPrepared.action,
    actionHash: "0".repeat(64),
  };
  for (const candidate of [
    structuredClone(firstPrepared),
    reconstructedPrepared,
    wrongHash,
    secondPrepared,
  ]) {
    assert.throws(
      () => first.evaluate(candidate),
      (error: unknown) => isDomainCode(error, "invariant_violated"),
    );
  }
  let preparedProxyTrapCalls = 0;
  const preparedProxy = new Proxy(firstPrepared, {
    get() {
      preparedProxyTrapCalls += 1;
      throw new Error("prepared proxy canary");
    },
  });
  assert.throws(
    () => first.evaluate(preparedProxy),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invariant_violated", "prepared proxy canary"),
  );
  assert.equal(preparedProxyTrapCalls, 0);
  assert.equal(firstPolicyCalls.evaluateCalls, 0);

  const firstEvaluated = first.evaluate(firstPrepared);
  const secondEvaluated = second.evaluate(secondPrepared);
  const reconstructedReceipt = {
    prepared: firstEvaluated.prepared,
    decision: firstEvaluated.decision,
  } as unknown as ReturnType<CapabilityGateway["evaluate"]>;
  await assert.rejects(
    first.execute(reconstructedReceipt, { signal: new AbortController().signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  await assert.rejects(
    first.execute(secondEvaluated, { signal: new AbortController().signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  let receiptProxyTrapCalls = 0;
  const receiptProxy = new Proxy(firstEvaluated, {
    get() {
      receiptProxyTrapCalls += 1;
      throw new Error("receipt proxy canary");
    },
  });
  await assert.rejects(
    first.execute(receiptProxy, { signal: new AbortController().signal }),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invariant_violated", "receipt proxy canary"),
  );
  assert.equal(receiptProxyTrapCalls, 0);
  assert.equal(calls.executeCalls, 0);
  assert.throws(() => {
    (firstPrepared as { actionHash: string }).actionHash = "f".repeat(64);
  }, TypeError);
  assert.throws(() => {
    (firstEvaluated.decision as { effect: PolicyEffect }).effect = "deny";
  }, TypeError);

  await first.execute(firstEvaluated, { signal: new AbortController().signal });
  assert.equal(calls.executeCalls, 1);
  assert.equal(calls.releaseCalls, 1);
});

test("policy decisions are detached once and bound to version, effect, and trace", async () => {
  const calls = spies();
  const mutableDecision = structuredClone(policyDecision("allow"));
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(
    registry,
    policyEvaluator({ decide: () => mutableDecision }),
  );
  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    registry.createAdvertisement([REFERENCE]),
  );
  const evaluated = gateway.evaluate(prepared);
  assert.notEqual(evaluated.decision, mutableDecision);
  (mutableDecision as { effect: PolicyEffect }).effect = "deny";
  (mutableDecision.trace as { result: PolicyEffect }).result = "deny";
  assert.equal(evaluated.decision.effect, "allow");
  assert.equal(evaluated.decision.trace["result"], "allow");
  await gateway.execute(evaluated, { signal: new AbortController().signal });
  assert.equal(calls.executeCalls, 1);
  assert.equal(calls.executedAction, prepared.action);
});

test("malformed policy decisions fail closed before handler and release", async () => {
  const otherPolicyVersionId = PolicyVersionIdKind.parse(
    "pol_018f05a0-7b01-7000-8000-000000000074",
  );
  const valid = policyDecision("allow");
  let decisionGetterCalls = 0;
  const accessorDecision = { ...valid } as Record<string, unknown>;
  Object.defineProperty(accessorDecision, "effect", {
    enumerable: true,
    get() {
      decisionGetterCalls += 1;
      throw new Error("decision getter canary");
    },
  });
  let decisionProxyTrapCalls = 0;
  const proxyDecision = new Proxy(
    valid,
    {
      get() {
        decisionProxyTrapCalls += 1;
        throw new Error("decision proxy canary");
      },
      ownKeys() {
        decisionProxyTrapCalls += 1;
        throw new Error("decision proxy canary");
      },
    },
  );
  const invalidDecisions: readonly unknown[] = [
    { ...valid, policyVersionId: otherPolicyVersionId },
    { ...valid, effect: "unknown" },
    {
      ...valid,
      matchedPolicyNames: ["orphan-match"],
      trace: {
        ...valid.trace,
        matchedPolicyNames: ["orphan-match"],
      },
    },
    {
      ...valid,
      winningPolicyName: "second-match",
      matchedPolicyNames: ["first-match", "second-match"],
      trace: {
        ...valid.trace,
        winningPolicyName: "second-match",
        matchedPolicyNames: ["first-match", "second-match"],
      },
    },
    { ...valid, trace: { ...valid.trace, defaultEffect: "deny" } },
    { ...valid, trace: { ...valid.trace, result: "deny" } },
    { ...valid, trace: { ...valid.trace, policyContentHash: "short" } },
    { ...valid, extra: true },
    accessorDecision,
    proxyDecision,
    Promise.resolve(valid),
  ];

  for (const candidate of invalidDecisions) {
    const calls = spies();
    const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
    const gateway = new CapabilityGateway(
      registry,
      policyEvaluator({
        decide: () => candidate as PolicyDecision,
      }),
    );
    const prepared = await gateway.normalize(
      proposal(),
      normalizationContext(),
      registry.createAdvertisement([REFERENCE]),
    );
    assert.throws(
      () => gateway.evaluate(prepared),
      (error: unknown) =>
        isSanitizedDomainCode(error, "policy_denied", "canary"),
    );
    assert.equal(calls.executeCalls, 0);
    assert.equal(calls.releaseCalls, 0);
  }
  assert.equal(decisionGetterCalls, 0);
  assert.equal(decisionProxyTrapCalls, 0);
});

interface LifecycleSpies {
  prepareCalls: number;
  reconcileCalls: number;
  executePreparedCalls: number;
  acknowledgeCalls: number;
  compensateCalls: number;
  discardCalls: number;
  signals: AbortSignal[];
  privateReceipt: object | null;
  observedDecision: PolicyDecision | null;
  observedAction: NormalizedAction | null;
  effectApplied: boolean;
  compensationRaw: JsonObject | null | undefined;
}

function lifecycleSpies(): LifecycleSpies {
  return {
    prepareCalls: 0,
    reconcileCalls: 0,
    executePreparedCalls: 0,
    acknowledgeCalls: 0,
    compensateCalls: 0,
    discardCalls: 0,
    signals: [],
    privateReceipt: null,
    observedDecision: null,
    observedAction: null,
    effectApplied: false,
    compensationRaw: undefined,
  };
}

const LIFECYCLE_ARTIFACT_ID = ArtifactIdKind.parse(
  "art_018f05a0-7b01-7000-8000-000000000076",
);

function lifecycleEvidence(phase: string) {
  return {
    schemaVersion: 1 as const,
    eventFacts: { phase },
    artifactReferences: [
      {
        schemaVersion: 1 as const,
        artifactId: LIFECYCLE_ARTIFACT_ID,
        contentHash: "c".repeat(64),
        mediaType: "application/vnd.guard.fixture+json",
      },
    ],
  };
}

function lifecycleOperation(
  operationSpies: OperationSpies,
  lifecycleCalls: LifecycleSpies,
  options: {
    readonly reconciliationStatus?:
      | "absent"
      | "succeeded"
      | "failed"
      | "uncertain";
    readonly preparationDescriptor?: CapabilityPreparationDescriptor;
    readonly executeFailure?: "throw_after_effect" | "invalid_raw_after_effect";
    readonly releaseFailure?: boolean;
    readonly compensationDisposition?: "restored" | "not_required" | "uncertain";
    readonly acknowledgeFailure?: boolean;
  } = {},
): CapabilityOperation {
  const base = counterOperation(operationSpies);
  const privateReceipt = Object.freeze({ handle: "private-fixture-handle" });
  const lifecycle: CapabilityOperationLifecycle = {
    prepare(action, context) {
      lifecycleCalls.prepareCalls += 1;
      lifecycleCalls.signals.push(context.signal);
      lifecycleCalls.privateReceipt = privateReceipt;
      lifecycleCalls.observedDecision = context.decision;
      lifecycleCalls.observedAction = action;
      return {
        descriptor: options.preparationDescriptor ?? {
          preparationKind: "fixture.counter.increment",
          operationVersion: 1,
          ...lifecycleEvidence("prepared"),
        },
        privateReceipt,
      };
    },
    reconcile(action, receipt, context) {
      lifecycleCalls.reconcileCalls += 1;
      lifecycleCalls.signals.push(context.signal);
      assert.equal(action, lifecycleCalls.observedAction);
      assert.equal(receipt, privateReceipt);
      assert.equal(context.decision, lifecycleCalls.observedDecision);
      const status = options.reconciliationStatus ?? "absent";
      return {
        ...lifecycleEvidence("reconciled"),
        status,
        raw: status === "succeeded" ? { next: 5 } : null,
      };
    },
    executePrepared(action, receipt, context) {
      lifecycleCalls.executePreparedCalls += 1;
      lifecycleCalls.signals.push(context.signal);
      assert.equal(action, lifecycleCalls.observedAction);
      assert.equal(receipt, privateReceipt);
      lifecycleCalls.effectApplied = true;
      if (options.executeFailure === "throw_after_effect") {
        throw new Error("simulated post-effect execution failure");
      }
      return {
        ...lifecycleEvidence("executed"),
        raw: options.executeFailure === "invalid_raw_after_effect"
          ? { invalid: true }
          : { next: 5 },
      };
    },
    acknowledge(action, receipt, raw, context) {
      lifecycleCalls.acknowledgeCalls += 1;
      lifecycleCalls.signals.push(context.signal);
      assert.equal(action, lifecycleCalls.observedAction);
      assert.equal(receipt, privateReceipt);
      assert.deepEqual(raw, { next: 5 });
      if (options.acknowledgeFailure === true) {
        throw new Error("simulated acknowledgement failure");
      }
      return lifecycleEvidence("acknowledged");
    },
    compensate(action, receipt, raw, context) {
      lifecycleCalls.compensateCalls += 1;
      lifecycleCalls.signals.push(context.signal);
      assert.equal(action, lifecycleCalls.observedAction);
      assert.equal(receipt, privateReceipt);
      lifecycleCalls.compensationRaw = raw;
      const disposition = options.compensationDisposition ?? "restored";
      if (disposition === "restored") lifecycleCalls.effectApplied = false;
      return { ...lifecycleEvidence("compensated"), disposition };
    },
    discardPreparation(action, receipt, context) {
      lifecycleCalls.discardCalls += 1;
      lifecycleCalls.signals.push(context.signal);
      assert.equal(action, lifecycleCalls.observedAction);
      assert.equal(receipt, privateReceipt);
      return lifecycleEvidence("discarded");
    },
  };
  return {
    ...base,
    ...(options.releaseFailure === true
      ? {
        release(): never {
          operationSpies.releaseCalls += 1;
          throw new Error("simulated post-effect release failure");
        },
      }
      : {}),
    lifecycle,
  };
}

async function lifecycleInvocation(
  effect: PolicyEffect = "allow",
  options: Parameters<typeof lifecycleOperation>[2] = {},
) {
  const operationCalls = spies();
  const lifecycleCalls = lifecycleSpies();
  const registry = new CapabilityPackRegistry([
    pack(lifecycleOperation(operationCalls, lifecycleCalls, options)),
  ]);
  const gateway = new CapabilityGateway(
    registry,
    policyEvaluator({ effect }),
  );
  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    registry.createAdvertisement([REFERENCE]),
  );
  const evaluated = gateway.evaluate(prepared);
  return { gateway, lifecycleCalls, operationCalls, evaluated };
}

test("post-policy lifecycle binds exact action, decision, descriptor, and private receipt", async () => {
  const { gateway, lifecycleCalls, operationCalls, evaluated } =
    await lifecycleInvocation();
  const signal = new AbortController().signal;
  const preparation = await gateway.prepare(evaluated, { signal });

  assert.equal(preparation.action, evaluated.prepared.action);
  assert.equal(preparation.actionHash, evaluated.prepared.actionHash);
  assert.equal(preparation.decision, evaluated.decision);
  assert.match(preparation.decisionHash, /^[a-f0-9]{64}$/u);
  assert.match(preparation.descriptorHash, /^[a-f0-9]{64}$/u);
  assert.equal(preparation.operation.operationVersion, 1);
  assert.equal(Object.isFrozen(preparation), true);
  assert.equal(Object.isFrozen(preparation.descriptor.eventFacts), true);
  assert.equal("privateReceipt" in preparation, false);

  const reconciled = await gateway.reconcile(preparation, { signal });
  assert.equal(reconciled.status, "absent");
  assert.equal(reconciled.preparation, preparation);
  const pending = await gateway.executePrepared(reconciled, { signal });
  assert.equal(pending.preparation, preparation);
  assert.equal(pending.reconciliation, reconciled);
  assert.equal(pending.eventFacts["phase"], "executed");
  assert.equal("raw" in pending, false);
  assert.equal("result" in pending, false);

  const result = await gateway.acknowledge(pending, { signal });
  assert.equal(result.raw["next"], 5);
  assert.equal(result.agent["next"], 5);
  assert.equal(lifecycleCalls.prepareCalls, 1);
  assert.equal(lifecycleCalls.reconcileCalls, 1);
  assert.equal(lifecycleCalls.executePreparedCalls, 1);
  assert.equal(lifecycleCalls.acknowledgeCalls, 1);
  assert.equal(operationCalls.executeCalls, 0);
  assert.equal(operationCalls.releaseCalls, 1);
  assert.deepEqual(lifecycleCalls.signals, [signal, signal, signal, signal]);

  await assert.rejects(
    gateway.acknowledge(pending, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  await assert.rejects(
    gateway.executePrepared(reconciled, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  await assert.rejects(
    gateway.reconcile(preparation, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
});

test("deny invokes no lifecycle hook while approval can prepare but cannot execute", async () => {
  const denied = await lifecycleInvocation("deny");
  const signal = new AbortController().signal;
  await assert.rejects(
    denied.gateway.prepare(denied.evaluated, { signal }),
    (error: unknown) => isDomainCode(error, "policy_denied"),
  );
  assert.deepEqual(denied.lifecycleCalls, {
    ...lifecycleSpies(),
    signals: [],
  });

  const approval = await lifecycleInvocation("require_approval");
  const preparation = await approval.gateway.prepare(approval.evaluated, {
    signal,
  });
  const reconciled = await approval.gateway.reconcile(preparation, { signal });
  await assert.rejects(
    approval.gateway.executePrepared(reconciled, { signal }),
    (error: unknown) => isDomainCode(error, "approval_required"),
  );
  assert.equal(approval.lifecycleCalls.prepareCalls, 1);
  assert.equal(approval.lifecycleCalls.reconcileCalls, 1);
  assert.equal(approval.lifecycleCalls.executePreparedCalls, 0);
  const discarded = await approval.gateway.discardPreparation(preparation, {
    signal,
  });
  assert.equal(discarded.eventFacts["phase"], "discarded");
  assert.equal(approval.lifecycleCalls.discardCalls, 1);
  await assert.rejects(
    approval.gateway.discardPreparation(preparation, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
});

test("reconciliation is mandatory, uncertain is terminal, and recovered effects are not repeated", async () => {
  const absent = await lifecycleInvocation();
  const signal = new AbortController().signal;
  const preparation = await absent.gateway.prepare(absent.evaluated, { signal });
  await assert.rejects(
    absent.gateway.executePrepared(preparation as never, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(absent.lifecycleCalls.executePreparedCalls, 0);

  const uncertain = await lifecycleInvocation("allow", {
    reconciliationStatus: "uncertain",
  });
  const uncertainPreparation = await uncertain.gateway.prepare(
    uncertain.evaluated,
    { signal },
  );
  const uncertainReceipt = await uncertain.gateway.reconcile(
    uncertainPreparation,
    { signal },
  );
  await assert.rejects(
    uncertain.gateway.executePrepared(uncertainReceipt, { signal }),
    (error: unknown) => isDomainCode(error, "attempt_result_uncertain"),
  );
  assert.equal(uncertain.lifecycleCalls.executePreparedCalls, 0);
  await assert.rejects(
    uncertain.gateway.executePrepared(uncertainReceipt, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );

  const recovered = await lifecycleInvocation("allow", {
    reconciliationStatus: "succeeded",
  });
  const recoveredPreparation = await recovered.gateway.prepare(
    recovered.evaluated,
    { signal },
  );
  const recoveredReceipt = await recovered.gateway.reconcile(
    recoveredPreparation,
    { signal },
  );
  const pending = await recovered.gateway.executePrepared(recoveredReceipt, {
    signal,
  });
  assert.equal(recovered.lifecycleCalls.executePreparedCalls, 0);
  const compensation = await recovered.gateway.compensate(pending, { signal });
  assert.equal(compensation.eventFacts["phase"], "compensated");
  assert.equal(compensation.disposition, "restored");
  assert.equal(recovered.lifecycleCalls.compensateCalls, 1);
  await assert.rejects(
    recovered.gateway.acknowledge(pending, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
});

test("post-dispatch execution failures compensate exactly once before returning failure", async () => {
  const signal = new AbortController().signal;
  const thrown = await lifecycleInvocation("allow", {
    executeFailure: "throw_after_effect",
    compensationDisposition: "restored",
  });
  const thrownPreparation = await thrown.gateway.prepare(thrown.evaluated, {
    signal,
  });
  const thrownReconciliation = await thrown.gateway.reconcile(
    thrownPreparation,
    { signal },
  );
  await assert.rejects(
    thrown.gateway.executePrepared(thrownReconciliation, { signal }),
    (error: unknown) => {
      assert.equal(isDomainCode(error, "action_failed"), true);
      assert.equal(
        isDomainError(error) && error.details?.["compensationDisposition"],
        "restored",
      );
      return true;
    },
  );
  assert.equal(thrown.lifecycleCalls.executePreparedCalls, 1);
  assert.equal(thrown.lifecycleCalls.compensateCalls, 1);
  assert.equal(thrown.lifecycleCalls.compensationRaw, null);
  assert.equal(thrown.lifecycleCalls.effectApplied, false);
  assert.equal(thrown.operationCalls.releaseCalls, 0);
  await assert.rejects(
    thrown.gateway.executePrepared(thrownReconciliation, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
});

test("invalid raw output and release failure compensate post-dispatch effects without release", async () => {
  const signal = new AbortController().signal;
  const invalidRaw = await lifecycleInvocation("allow", {
    executeFailure: "invalid_raw_after_effect",
  });
  const invalidPreparation = await invalidRaw.gateway.prepare(
    invalidRaw.evaluated,
    { signal },
  );
  const invalidReconciliation = await invalidRaw.gateway.reconcile(
    invalidPreparation,
    { signal },
  );
  await assert.rejects(
    invalidRaw.gateway.executePrepared(invalidReconciliation, { signal }),
    (error: unknown) => isDomainCode(error, "action_failed"),
  );
  assert.deepEqual(invalidRaw.lifecycleCalls.compensationRaw, { invalid: true });
  assert.equal(invalidRaw.lifecycleCalls.compensateCalls, 1);
  assert.equal(invalidRaw.lifecycleCalls.effectApplied, false);
  assert.equal(invalidRaw.operationCalls.releaseCalls, 0);

  const releaseFailure = await lifecycleInvocation("allow", {
    releaseFailure: true,
  });
  const releasePreparation = await releaseFailure.gateway.prepare(
    releaseFailure.evaluated,
    { signal },
  );
  const releaseReconciliation = await releaseFailure.gateway.reconcile(
    releasePreparation,
    { signal },
  );
  await assert.rejects(
    releaseFailure.gateway.executePrepared(releaseReconciliation, { signal }),
    (error: unknown) => isDomainCode(error, "action_failed"),
  );
  assert.deepEqual(releaseFailure.lifecycleCalls.compensationRaw, { next: 5 });
  assert.equal(releaseFailure.lifecycleCalls.compensateCalls, 1);
  assert.equal(releaseFailure.lifecycleCalls.effectApplied, false);
  assert.equal(releaseFailure.operationCalls.releaseCalls, 1);
});

test("uncertain automatic compensation becomes an orphan-visible uncertain error", async () => {
  const signal = new AbortController().signal;
  const uncertain = await lifecycleInvocation("allow", {
    executeFailure: "throw_after_effect",
    compensationDisposition: "uncertain",
  });
  const preparation = await uncertain.gateway.prepare(uncertain.evaluated, {
    signal,
  });
  const reconciliation = await uncertain.gateway.reconcile(preparation, {
    signal,
  });
  await assert.rejects(
    uncertain.gateway.executePrepared(reconciliation, { signal }),
    (error: unknown) => {
      assert.equal(isDomainCode(error, "attempt_result_uncertain"), true);
      assert.equal(isDomainError(error) && error.retry, "uncertain");
      assert.equal(
        isDomainError(error) && error.details?.["compensationDisposition"],
        "uncertain",
      );
      return true;
    },
  );
  assert.equal(uncertain.lifecycleCalls.compensateCalls, 1);
  assert.equal(uncertain.lifecycleCalls.effectApplied, true);
  await assert.rejects(
    uncertain.gateway.executePrepared(reconciliation, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  await assert.rejects(
    uncertain.gateway.discardPreparation(preparation, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
});

test("acknowledgement failure after host publication orphans instead of compensating", async () => {
  const signal = new AbortController().signal;
  const invocation = await lifecycleInvocation("allow", {
    acknowledgeFailure: true,
  });
  const preparation = await invocation.gateway.prepare(invocation.evaluated, {
    signal,
  });
  const reconciliation = await invocation.gateway.reconcile(preparation, {
    signal,
  });
  const pending = await invocation.gateway.executePrepared(reconciliation, {
    signal,
  });
  await assert.rejects(
    invocation.gateway.acknowledge(pending, { signal }),
    (error: unknown) => isDomainCode(error, "attempt_result_uncertain"),
  );
  assert.equal(invocation.lifecycleCalls.acknowledgeCalls, 1);
  assert.equal(invocation.lifecycleCalls.compensateCalls, 0);
  assert.equal(invocation.lifecycleCalls.effectApplied, true);
  await assert.rejects(
    invocation.gateway.compensate(pending, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  await assert.rejects(
    invocation.gateway.acknowledge(pending, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
});

test("malformed compensation evidence is treated as uncertain and cannot be reused", async () => {
  const operationCalls = spies();
  const lifecycleCalls = lifecycleSpies();
  const installed = lifecycleOperation(operationCalls, lifecycleCalls, {
    executeFailure: "throw_after_effect",
  });
  const originalLifecycle = installed.lifecycle!;
  const malformed: CapabilityOperation = {
    ...installed,
    lifecycle: {
      ...originalLifecycle,
      async compensate(action, receipt, raw, context) {
        const valid = await originalLifecycle.compensate(
          action,
          receipt,
          raw,
          context,
        );
        return { ...valid, disposition: "invented" } as never;
      },
    },
  };
  const registry = new CapabilityPackRegistry([pack(malformed)]);
  const gateway = new CapabilityGateway(registry, policyEvaluator());
  const normalized = await gateway.normalize(
    proposal(),
    normalizationContext(),
    registry.createAdvertisement([REFERENCE]),
  );
  const signal = new AbortController().signal;
  const preparation = await gateway.prepare(gateway.evaluate(normalized), {
    signal,
  });
  const reconciliation = await gateway.reconcile(preparation, { signal });
  await assert.rejects(
    gateway.executePrepared(reconciliation, { signal }),
    (error: unknown) => isDomainCode(error, "attempt_result_uncertain"),
  );
  assert.equal(lifecycleCalls.compensateCalls, 1);
  await assert.rejects(
    gateway.executePrepared(reconciliation, { signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
});

test("lifecycle receipts reject forgery, foreign gateways, rebinding, mutation, and signal replacement", async () => {
  const first = await lifecycleInvocation();
  const second = await lifecycleInvocation();
  const controller = new AbortController();
  const preparation = await first.gateway.prepare(first.evaluated, {
    signal: controller.signal,
  });
  const forged = {
    ...preparation,
    actionHash: "0".repeat(64),
  };
  await assert.rejects(
    first.gateway.reconcile(forged as never, { signal: controller.signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  await assert.rejects(
    second.gateway.reconcile(preparation, { signal: controller.signal }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  await assert.rejects(
    first.gateway.reconcile(preparation, {
      signal: new AbortController().signal,
    }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  assert.throws(() => {
    (preparation.descriptor.eventFacts as { phase: string }).phase = "mutated";
  }, TypeError);
  const reconciled = await first.gateway.reconcile(preparation, {
    signal: controller.signal,
  });
  assert.equal(reconciled.status, "absent");
});

test("lifecycle evidence is detached and bounded before advancing", async () => {
  const mutableFacts = { phase: "prepared" };
  const mutableReference = {
    schemaVersion: 1 as const,
    artifactId: LIFECYCLE_ARTIFACT_ID,
    contentHash: "c".repeat(64),
    mediaType: "application/vnd.guard.fixture+json",
  };
  const mutableDescriptor: CapabilityPreparationDescriptor = {
    schemaVersion: 1,
    preparationKind: "fixture.counter.increment",
    operationVersion: 1,
    eventFacts: mutableFacts,
    artifactReferences: [mutableReference],
  };
  const detached = await lifecycleInvocation("allow", {
    preparationDescriptor: mutableDescriptor,
  });
  const detachedPreparation = await detached.gateway.prepare(
    detached.evaluated,
    { signal: new AbortController().signal },
  );
  mutableFacts.phase = "changed-after-return";
  mutableReference.contentHash = "d".repeat(64);
  assert.equal(detachedPreparation.descriptor.eventFacts["phase"], "prepared");
  assert.equal(
    detachedPreparation.descriptor.artifactReferences[0]!.contentHash,
    "c".repeat(64),
  );
  assert.equal(
    Object.isFrozen(detachedPreparation.descriptor.artifactReferences),
    true,
  );

  const oversizedFacts = { phase: "prepared", padding: "x".repeat(1_024) };
  const descriptor: CapabilityPreparationDescriptor = {
    schemaVersion: 1,
    preparationKind: "fixture.counter.increment",
    operationVersion: 1,
    eventFacts: oversizedFacts,
    artifactReferences: [],
  };
  const operationCalls = spies();
  const lifecycleCalls = lifecycleSpies();
  const registry = new CapabilityPackRegistry([
    pack(lifecycleOperation(operationCalls, lifecycleCalls, {
      preparationDescriptor: descriptor,
    })),
  ]);
  const gateway = new CapabilityGateway(registry, policyEvaluator(), {
    maximumLifecycleEvidenceBytes: 256,
  });
  const normalized = await gateway.normalize(
    proposal(),
    normalizationContext(),
    registry.createAdvertisement([REFERENCE]),
  );
  await assert.rejects(
    gateway.prepare(gateway.evaluate(normalized), {
      signal: new AbortController().signal,
    }),
    (error: unknown) => isDomainCode(error, "budget_exceeded"),
  );
  assert.equal(lifecycleCalls.prepareCalls, 1);
  assert.equal(lifecycleCalls.reconcileCalls, 0);
  oversizedFacts.phase = "changed-after-return";
});

test("registry captures lifecycle methods without invoking hostile accessors", async () => {
  const operationCalls = spies();
  const lifecycleCalls = lifecycleSpies();
  const installed = lifecycleOperation(operationCalls, lifecycleCalls);
  let accessorCalls = 0;
  const hostileLifecycle = { ...installed.lifecycle } as Record<string, unknown>;
  Object.defineProperty(hostileLifecycle, "prepare", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      throw new Error("lifecycle accessor canary");
    },
  });
  assert.throws(
    () => new CapabilityPackRegistry([
      pack({ ...installed, lifecycle: hostileLifecycle as never }),
    ]),
    (error: unknown) =>
      isSanitizedDomainCode(error, "invalid_input", "canary"),
  );
  assert.equal(accessorCalls, 0);

  const registry = new CapabilityPackRegistry([pack(installed)]);
  const gateway = new CapabilityGateway(registry, policyEvaluator());
  const normalized = await gateway.normalize(
    proposal(),
    normalizationContext(),
    registry.createAdvertisement([REFERENCE]),
  );
  await assert.rejects(
    gateway.execute(gateway.evaluate(normalized), {
      signal: new AbortController().signal,
    }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(operationCalls.executeCalls, 0);
  assert.equal(lifecycleCalls.prepareCalls, 0);
});

test("legacy operations support an inert lifecycle without changing direct execution", async () => {
  const operationCalls = spies();
  const registry = new CapabilityPackRegistry([
    pack(counterOperation(operationCalls)),
  ]);
  const gateway = new CapabilityGateway(registry, policyEvaluator());
  const advertisement = registry.createAdvertisement([REFERENCE]);
  const signal = new AbortController().signal;
  const first = await gateway.normalize(
    proposal(),
    normalizationContext(),
    advertisement,
  );
  const direct = await gateway.execute(gateway.evaluate(first), { signal });
  assert.equal(direct.raw["next"], 5);

  const second = await gateway.normalize(
    proposal(),
    normalizationContext(),
    advertisement,
  );
  const preparation = await gateway.prepare(gateway.evaluate(second), { signal });
  assert.equal(preparation.descriptor.preparationKind, "gateway.inert");
  const reconciled = await gateway.reconcile(preparation, { signal });
  const pending = await gateway.executePrepared(reconciled, { signal });
  const lifecycleResult = await gateway.acknowledge(pending, { signal });
  assert.equal(lifecycleResult.raw["next"], 5);
  assert.equal(operationCalls.executeCalls, 2);
  assert.equal(operationCalls.releaseCalls, 2);
});
