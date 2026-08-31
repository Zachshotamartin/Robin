import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  ApprovalIdKind,
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
  type CapabilityOperationReference,
  type CapabilityPack,
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
const APPROVAL_ID = ApprovalIdKind.parse(
  "apr_018f05a0-7b01-7000-8000-000000000076",
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
      (error: unknown) =>
        isDomainCode(
          error,
          effect === "deny" ? "invariant_violated" : "approval_required",
        ),
    );
  }
});

test("approval challenge binds the displayed summary and exact authorization facts", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  let now = "2026-08-30T12:00:00.000Z";
  const gateway = new CapabilityGateway(
    registry,
    policyEvaluator({ effect: "require_approval" }),
    {
      approvalClock: { now: () => now },
      approvalIdSource: { nextApprovalId: () => APPROVAL_ID },
      defaultApprovalLifetimeMs: 60_000,
      maximumApprovalLifetimeMs: 300_000,
    },
  );
  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    registry.createAdvertisement([REFERENCE]),
  );
  const evaluated = gateway.evaluate(prepared);
  const authorization = gateway.authorize(evaluated);
  assert.deepEqual(authorization, { status: "approval_required" });

  const sourceSummary = {
    schemaVersion: 1,
    operation: "fixture.counter.increment@1",
    effect: "Increment counter alpha from 4 to 5.",
  };
  const challenge = gateway.createApprovalChallenge(evaluated, {
    displayedSummary: sourceSummary,
    lifetimeMs: 120_000,
  });
  sourceSummary.effect = "mutated after challenge";

  assert.equal(challenge.approvalId, APPROVAL_ID);
  assert.equal(challenge.actionId, ACTION_ID);
  assert.equal(challenge.requestedAt, "2026-08-30T12:00:00.000Z");
  assert.equal(challenge.expiresAt, "2026-08-30T12:02:00.000Z");
  assert.equal(challenge.displayedSummary["effect"], "Increment counter alpha from 4 to 5.");
  assert.match(challenge.actionHash, /^[a-f0-9]{64}$/u);
  assert.match(challenge.normalizedRequestHash, /^[a-f0-9]{64}$/u);
  assert.match(challenge.preconditionHash, /^[a-f0-9]{64}$/u);
  assert.match(challenge.policySnapshotHash, /^[a-f0-9]{64}$/u);
  assert.match(challenge.displayedSummaryHash, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(challenge), true);
  assert.equal(Object.isFrozen(challenge.displayedSummary), true);

  now = "2026-08-30T12:00:30.000Z";
  const resolution = gateway.resolveApproval(
    challenge,
    approvalResponse(challenge, "allow_once"),
  );
  assert.equal(resolution.status, "granted");
  if (resolution.status !== "granted") throw new Error("expected approval grant");
  const approved = gateway.authorize(resolution.grant);
  assert.equal(approved.status, "authorized");
  if (approved.status !== "authorized") throw new Error("expected authorization");

  let revalidationCalls = 0;
  const execution = await gateway.executeAuthorized(approved.authorization, {
    signal: new AbortController().signal,
    async revalidate(action) {
      revalidationCalls += 1;
      assert.equal(action, prepared.action);
      return action.preconditions;
    },
  });
  assert.equal(execution.status, "executed");
  if (execution.status !== "executed") throw new Error("expected execution");
  assert.equal(execution.result.agent["next"], 5);
  assert.equal(revalidationCalls, 1);
  assert.equal(calls.executeCalls, 1);
  assert.equal(calls.releaseCalls, 1);
});

test("approval challenge rejects an explicit null lifetime without consuming the action", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = approvalGateway(registry);
  const evaluated = gateway.evaluate(
    await gateway.normalize(
      proposal(),
      normalizationContext(),
      registry.createAdvertisement([REFERENCE]),
    ),
  );

  assert.throws(
    () => gateway.createApprovalChallenge(evaluated, {
      displayedSummary: { operation: "increment alpha" },
      lifetimeMs: null as never,
    }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  const challenge = gateway.createApprovalChallenge(evaluated, {
    displayedSummary: { operation: "increment alpha" },
  });
  assert.equal(challenge.approvalId, APPROVAL_ID);
  assert.equal(calls.executeCalls, 0);
  assert.equal(calls.releaseCalls, 0);
});

test("approval response hash, identity, and policy bindings fail closed", async () => {
  const mutations = [
    (response: ReturnType<typeof approvalResponse>) => ({
      ...response,
      approvalId: ApprovalIdKind.parse(
        "apr_018f05a0-7b01-7000-8000-000000000077",
      ),
    }),
    (response: ReturnType<typeof approvalResponse>) => ({
      ...response,
      normalizedRequestHash: "1".repeat(64),
    }),
    (response: ReturnType<typeof approvalResponse>) => ({
      ...response,
      preconditionHash: "2".repeat(64),
    }),
    (response: ReturnType<typeof approvalResponse>) => ({
      ...response,
      policySnapshotHash: "3".repeat(64),
    }),
    (response: ReturnType<typeof approvalResponse>) => ({
      ...response,
      displayedSummaryHash: "4".repeat(64),
    }),
  ] as const;

  for (const mutate of mutations) {
    const calls = spies();
    const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
    const gateway = approvalGateway(registry);
    const evaluated = gateway.evaluate(
      await gateway.normalize(
        proposal(),
        normalizationContext(),
        registry.createAdvertisement([REFERENCE]),
      ),
    );
    const challenge = gateway.createApprovalChallenge(evaluated, {
      displayedSummary: { operation: "increment alpha" },
    });
    assert.throws(
      () => gateway.resolveApproval(
        challenge,
        mutate(approvalResponse(challenge, "allow_once")),
      ),
      (error: unknown) => isDomainCode(error, "approval_invalid"),
    );
    assert.throws(
      () => gateway.resolveApproval(
        challenge,
        approvalResponse(challenge, "allow_once"),
      ),
      (error: unknown) => isDomainCode(error, "invariant_violated"),
    );
    assert.equal(calls.executeCalls, 0);
    assert.equal(calls.releaseCalls, 0);
  }
});

test("malformed approval responses consume the challenge and map to approval invalid", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = approvalGateway(registry);
  const evaluated = gateway.evaluate(
    await gateway.normalize(
      proposal(),
      normalizationContext(),
      registry.createAdvertisement([REFERENCE]),
    ),
  );
  const challenge = gateway.createApprovalChallenge(evaluated, {
    displayedSummary: { operation: "increment alpha" },
  });

  assert.throws(
    () => gateway.resolveApproval(challenge, null as never),
    (error: unknown) => isDomainCode(error, "approval_invalid"),
  );
  assert.throws(
    () => gateway.resolveApproval(
      challenge,
      approvalResponse(challenge, "allow_once"),
    ),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(calls.executeCalls, 0);
  assert.equal(calls.releaseCalls, 0);
});

test("approval grants and authorized executions are gateway-owned and one-use", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const first = approvalGateway(registry);
  const second = approvalGateway(registry);
  const evaluated = first.evaluate(
    await first.normalize(
      proposal(),
      normalizationContext(),
      registry.createAdvertisement([REFERENCE]),
    ),
  );
  const challenge = first.createApprovalChallenge(evaluated, {
    displayedSummary: { operation: "increment alpha" },
  });
  assert.throws(
    () => second.resolveApproval(
      challenge,
      approvalResponse(challenge, "allow_once"),
    ),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.throws(
    () => first.createApprovalChallenge(evaluated, {
      displayedSummary: { operation: "increment alpha" },
    }),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  const resolution = first.resolveApproval(
    challenge,
    approvalResponse(challenge, "allow_once"),
  );
  assert.equal(resolution.status, "granted");
  if (resolution.status !== "granted") throw new Error("expected approval grant");
  assert.throws(
    () => second.authorize(resolution.grant),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  const authorization = first.authorize(resolution.grant);
  assert.equal(authorization.status, "authorized");
  if (authorization.status !== "authorized") throw new Error("expected authorization");
  assert.throws(
    () => first.authorize(resolution.grant),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );

  const context = {
    signal: new AbortController().signal,
    revalidate: async (action: NormalizedAction) => action.preconditions,
  };
  const executed = await first.executeAuthorized(
    authorization.authorization,
    context,
  );
  assert.equal(executed.status, "executed");
  await assert.rejects(
    first.executeAuthorized(authorization.authorization, context),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  await assert.rejects(
    second.executeAuthorized(authorization.authorization, context),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(calls.executeCalls, 1);
});

test("approval expiry and changed preconditions return bounded no-effect observations", async () => {
  const expiryCalls = spies();
  const expiryRegistry = new CapabilityPackRegistry([
    pack(counterOperation(expiryCalls)),
  ]);
  let expiryNow = "2026-08-30T12:00:00.000Z";
  const expiryGateway = approvalGateway(expiryRegistry, () => expiryNow);
  const expiryEvaluated = expiryGateway.evaluate(
    await expiryGateway.normalize(
      proposal(),
      normalizationContext(),
      expiryRegistry.createAdvertisement([REFERENCE]),
    ),
  );
  const expiryChallenge = expiryGateway.createApprovalChallenge(
    expiryEvaluated,
    {
      displayedSummary: { operation: "increment alpha" },
      lifetimeMs: 1_000,
    },
  );
  expiryNow = "2026-08-30T12:00:01.000Z";
  const expired = expiryGateway.resolveApproval(
    expiryChallenge,
    approvalResponse(expiryChallenge, "allow_once"),
  );
  assert.deepEqual(expired, {
    status: "stale",
    observation: {
      schemaVersion: 1,
      status: "stale",
      code: "approval_invalid",
      reason: "approval_expired",
      effectOccurred: false,
      actionId: ACTION_ID,
      capabilityPackId: REFERENCE.packId,
      capabilityPackVersion: REFERENCE.packVersion,
      operationId: REFERENCE.operationId,
      operationVersion: REFERENCE.operationVersion,
      nextAction: "request_fresh_approval",
    },
  });
  assert.equal(expiryCalls.executeCalls, 0);

  const staleCalls = spies();
  const staleRegistry = new CapabilityPackRegistry([
    pack(counterOperation(staleCalls)),
  ]);
  const staleGateway = approvalGateway(staleRegistry);
  const stalePrepared = await staleGateway.normalize(
    proposal(),
    normalizationContext(),
    staleRegistry.createAdvertisement([REFERENCE]),
  );
  const staleEvaluated = staleGateway.evaluate(stalePrepared);
  const staleChallenge = staleGateway.createApprovalChallenge(staleEvaluated, {
    displayedSummary: { operation: "increment alpha" },
  });
  const staleResolution = staleGateway.resolveApproval(
    staleChallenge,
    approvalResponse(staleChallenge, "allow_once"),
  );
  assert.equal(staleResolution.status, "granted");
  if (staleResolution.status !== "granted") throw new Error("expected grant");
  const staleAuthorization = staleGateway.authorize(staleResolution.grant);
  assert.equal(staleAuthorization.status, "authorized");
  if (staleAuthorization.status !== "authorized") {
    throw new Error("expected authorization");
  }
  const staleExecution = await staleGateway.executeAuthorized(
    staleAuthorization.authorization,
    {
      signal: new AbortController().signal,
      async revalidate() {
        return [{
          preconditionType: "fixture.counter.value",
          preconditionVersion: 1,
          attributes: { value: 9 },
        }];
      },
    },
  );
  assert.equal(staleExecution.status, "stale");
  if (staleExecution.status !== "stale") throw new Error("expected stale result");
  assert.equal(staleExecution.observation["reason"], "preconditions_changed");
  assert.equal(staleExecution.observation["effectOccurred"], false);
  assert.equal(staleExecution.observation["nextAction"], "reobserve_and_retry");
  assert.match(String(staleExecution.observation["expectedPreconditionHash"]), /^[a-f0-9]{64}$/u);
  assert.match(String(staleExecution.observation["observedPreconditionHash"]), /^[a-f0-9]{64}$/u);
  assert.equal(staleCalls.executeCalls, 0);
  assert.equal(staleCalls.releaseCalls, 0);
});

test("approval expiry before or during revalidation prevents execution", async () => {
  for (const expiryPoint of ["before_revalidation", "after_revalidation"] as const) {
    const calls = spies();
    const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
    let now = "2026-08-30T12:00:00.000Z";
    const gateway = approvalGateway(registry, () => now);
    const prepared = await gateway.normalize(
      proposal(),
      normalizationContext(),
      registry.createAdvertisement([REFERENCE]),
    );
    const challenge = gateway.createApprovalChallenge(
      gateway.evaluate(prepared),
      {
        displayedSummary: { operation: "increment alpha" },
        lifetimeMs: 1_000,
      },
    );
    const resolution = gateway.resolveApproval(
      challenge,
      approvalResponse(challenge, "allow_once"),
    );
    assert.equal(resolution.status, "granted");
    if (resolution.status !== "granted") throw new Error("expected grant");
    const authorization = gateway.authorize(resolution.grant);
    assert.equal(authorization.status, "authorized");
    if (authorization.status !== "authorized") {
      throw new Error("expected authorization");
    }

    let revalidationCalls = 0;
    if (expiryPoint === "before_revalidation") {
      now = "2026-08-30T12:00:01.000Z";
    }
    const result = await gateway.executeAuthorized(
      authorization.authorization,
      {
        signal: new AbortController().signal,
        async revalidate(action) {
          revalidationCalls += 1;
          if (expiryPoint === "after_revalidation") {
            now = "2026-08-30T12:00:01.000Z";
          }
          return action.preconditions;
        },
      },
    );
    assert.equal(result.status, "stale");
    if (result.status !== "stale") throw new Error("expected stale result");
    assert.equal(result.observation["reason"], "approval_expired");
    assert.equal(result.observation["effectOccurred"], false);
    assert.equal(
      revalidationCalls,
      expiryPoint === "before_revalidation" ? 0 : 1,
    );
    assert.equal(calls.executeCalls, 0);
    assert.equal(calls.releaseCalls, 0);
    await assert.rejects(
      gateway.executeAuthorized(authorization.authorization, {
        signal: new AbortController().signal,
        revalidate: async (action) => action.preconditions,
      }),
      (error: unknown) => isDomainCode(error, "invariant_violated"),
    );
  }
});

test("an approval grant that expires before authorization is stale and one-use", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  let now = "2026-08-30T12:00:00.000Z";
  const gateway = approvalGateway(registry, () => now);
  const challenge = gateway.createApprovalChallenge(
    gateway.evaluate(
      await gateway.normalize(
        proposal(),
        normalizationContext(),
        registry.createAdvertisement([REFERENCE]),
      ),
    ),
    {
      displayedSummary: { operation: "increment alpha" },
      lifetimeMs: 1_000,
    },
  );
  const resolution = gateway.resolveApproval(
    challenge,
    approvalResponse(challenge, "allow_once"),
  );
  assert.equal(resolution.status, "granted");
  if (resolution.status !== "granted") throw new Error("expected grant");
  now = "2026-08-30T12:00:01.000Z";

  const stale = gateway.authorize(resolution.grant);
  assert.equal(stale.status, "stale");
  if (stale.status !== "stale") throw new Error("expected stale authorization");
  assert.equal(stale.observation["reason"], "approval_expired");
  assert.equal(stale.observation["effectOccurred"], false);
  assert.throws(
    () => gateway.authorize(resolution.grant),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(calls.executeCalls, 0);
  assert.equal(calls.releaseCalls, 0);
});

test("policy authorization revalidates without consulting the approval clock", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(
    registry,
    policyEvaluator({ effect: "allow" }),
    {
      approvalClock: {
        now(): string {
          throw new Error("approval clock must be inactive for policy allow");
        },
      },
    },
  );
  const prepared = await gateway.normalize(
    proposal(),
    normalizationContext(),
    registry.createAdvertisement([REFERENCE]),
  );
  const authorized = gateway.authorize(gateway.evaluate(prepared));
  assert.equal(authorized.status, "authorized");
  if (authorized.status !== "authorized") throw new Error("expected authorization");

  const result = await gateway.executeAuthorized(authorized.authorization, {
    signal: new AbortController().signal,
    revalidate: async (action) => action.preconditions,
  });
  assert.equal(result.status, "executed");
  assert.equal(calls.executeCalls, 1);
  assert.equal(calls.releaseCalls, 1);
});

test("a revalidation failure consumes authorization without executing", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(
    registry,
    policyEvaluator({ effect: "allow" }),
  );
  const authorized = gateway.authorize(
    gateway.evaluate(
      await gateway.normalize(
        proposal(),
        normalizationContext(),
        registry.createAdvertisement([REFERENCE]),
      ),
    ),
  );
  assert.equal(authorized.status, "authorized");
  if (authorized.status !== "authorized") throw new Error("expected authorization");

  const context = {
    signal: new AbortController().signal,
    async revalidate(): Promise<never> {
      throw new Error("fixture observer failed");
    },
  };
  await assert.rejects(
    gateway.executeAuthorized(authorized.authorization, context),
    (error: unknown) => isDomainCode(error, "action_failed"),
  );
  await assert.rejects(
    gateway.executeAuthorized(authorized.authorization, context),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
  assert.equal(calls.executeCalls, 0);
  assert.equal(calls.releaseCalls, 0);
});

test("cancellation during revalidation wins over observer failure and prevents execution", async () => {
  const calls = spies();
  const registry = new CapabilityPackRegistry([pack(counterOperation(calls))]);
  const gateway = new CapabilityGateway(
    registry,
    policyEvaluator({ effect: "allow" }),
  );
  const authorized = gateway.authorize(
    gateway.evaluate(
      await gateway.normalize(
        proposal(),
        normalizationContext(),
        registry.createAdvertisement([REFERENCE]),
      ),
    ),
  );
  assert.equal(authorized.status, "authorized");
  if (authorized.status !== "authorized") throw new Error("expected authorization");
  const controller = new AbortController();

  await assert.rejects(
    gateway.executeAuthorized(authorized.authorization, {
      signal: controller.signal,
      async revalidate(): Promise<never> {
        controller.abort();
        throw new Error("observer noticed cancellation");
      },
    }),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
  assert.equal(calls.executeCalls, 0);
  assert.equal(calls.releaseCalls, 0);
});

test("policy and user denials are safe model observations and never execute", async () => {
  const policyCalls = spies();
  const policyRegistry = new CapabilityPackRegistry([
    pack(counterOperation(policyCalls)),
  ]);
  const deniedGateway = new CapabilityGateway(
    policyRegistry,
    policyEvaluator({ effect: "deny" }),
  );
  const denied = deniedGateway.authorize(
    deniedGateway.evaluate(
      await deniedGateway.normalize(
        proposal(),
        normalizationContext(),
        policyRegistry.createAdvertisement([REFERENCE]),
      ),
    ),
  );
  assert.equal(denied.status, "denied");
  if (denied.status !== "denied") throw new Error("expected denial");
  assert.deepEqual(denied.observation, {
    schemaVersion: 1,
    status: "denied",
    code: "policy_denied",
    reason: "policy_denied",
    effectOccurred: false,
    actionId: ACTION_ID,
    capabilityPackId: REFERENCE.packId,
    capabilityPackVersion: REFERENCE.packVersion,
    operationId: REFERENCE.operationId,
    operationVersion: REFERENCE.operationVersion,
    nextAction: "choose_alternative",
  });
  assert.equal(policyCalls.executeCalls, 0);

  const userCalls = spies();
  const userRegistry = new CapabilityPackRegistry([pack(counterOperation(userCalls))]);
  const userGateway = approvalGateway(userRegistry);
  const userEvaluated = userGateway.evaluate(
    await userGateway.normalize(
      proposal(),
      normalizationContext(),
      userRegistry.createAdvertisement([REFERENCE]),
    ),
  );
  const userChallenge = userGateway.createApprovalChallenge(userEvaluated, {
    displayedSummary: { operation: "increment alpha" },
  });
  const userDenied = userGateway.resolveApproval(
    userChallenge,
    approvalResponse(userChallenge, "deny"),
  );
  assert.equal(userDenied.status, "denied");
  if (userDenied.status !== "denied") throw new Error("expected user denial");
  assert.equal(userDenied.observation["reason"], "user_denied");
  assert.equal(userDenied.observation["effectOccurred"], false);
  assert.equal(userCalls.executeCalls, 0);
});

function approvalGateway(
  registry: CapabilityPackRegistry,
  now: () => string = () => "2026-08-30T12:00:00.000Z",
): CapabilityGateway {
  return new CapabilityGateway(
    registry,
    policyEvaluator({ effect: "require_approval" }),
    {
      approvalClock: { now },
      approvalIdSource: { nextApprovalId: () => APPROVAL_ID },
      defaultApprovalLifetimeMs: 60_000,
      maximumApprovalLifetimeMs: 300_000,
    },
  );
}

function approvalResponse(
  challenge: {
    readonly approvalId: ReturnType<typeof ApprovalIdKind.parse>;
    readonly normalizedRequestHash: string;
    readonly preconditionHash: string;
    readonly policySnapshotHash: string;
    readonly displayedSummaryHash: string;
  },
  decision: "allow_once" | "deny",
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    approvalId: challenge.approvalId,
    decision,
    normalizedRequestHash: challenge.normalizedRequestHash,
    preconditionHash: challenge.preconditionHash,
    policySnapshotHash: challenge.policySnapshotHash,
    displayedSummaryHash: challenge.displayedSummaryHash,
  });
}

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
