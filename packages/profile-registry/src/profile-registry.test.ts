import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalBytes,
  canonicalSha256Hex,
  isDomainError,
  type DomainError,
  type ObjectiveEnvelope,
  type OutcomeEnvelope,
  type TaskProfile,
} from "@guard/contracts";

import { InMemoryTaskProfileRegistry } from "./index.js";

const BASE_PROFILE: TaskProfile = {
  schemaVersion: 1,
  profileId: "profile:synthetic",
  profileVersion: 1,
  objectiveSchema: {
    schemaId: "schema:synthetic-objective",
    schemaVersion: 1,
    document: {
      type: "object",
      additionalProperties: false,
      required: ["input"],
      properties: {
        input: { type: "string" },
        tag: { type: "string", default: "default-tag" },
      },
    },
  },
  driverProfile: {
    componentId: "driver:scripted",
    componentVersion: 1,
    configuration: { strict: true },
  },
  modelBindings: [],
  contextSources: [
    {
      bindingId: "source:fixture",
      componentId: "context:memory",
      componentVersion: 1,
      configuration: { namespace: "alpha" },
    },
  ],
  capabilityPacks: [
    {
      bindingId: "capability:fixture",
      componentId: "capability:memory",
      componentVersion: 1,
      configuration: { operations: ["read", "transform"] },
    },
  ],
  policyProfile: {
    componentId: "policy:deny-by-default",
    componentVersion: 1,
    configuration: {},
  },
  outcomeSchema: {
    schemaId: "schema:synthetic-outcome",
    schemaVersion: 1,
    document: {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string" } },
    },
  },
  budgetPolicy: {
    maxTurns: 5,
    maxActions: 0,
    maxElapsedMs: 60_000,
    maxInputBytes: 1_000_000,
    maxOutputBytes: 1_000_000,
    extensions: { maxProviderRequests: 0 },
  },
  evidenceMode: "ephemeral_metadata",
  evaluationProfile: null,
};

const BASE_OBJECTIVE: ObjectiveEnvelope = {
  schemaVersion: 1,
  profileId: BASE_PROFILE.profileId,
  profileVersion: BASE_PROFILE.profileVersion,
  objectiveType: "synthetic.transform",
  objectiveTypeVersion: 1,
  payload: { input: "alpha" },
  submittedBy: { kind: "user", id: "user:test" },
  submittedAt: "2026-08-30T12:00:00.000Z",
};

const BASE_OUTCOME: OutcomeEnvelope = {
  schemaVersion: 1,
  outcomeId: "outcome:synthetic",
  profileId: BASE_PROFILE.profileId,
  profileVersion: BASE_PROFILE.profileVersion,
  outcomeType: "synthetic.result",
  outcomeTypeVersion: 1,
  payload: { answer: "alpha" },
  evidence: [],
  proposedAt: "2026-08-30T12:00:01.000Z",
};

function mutableProfile(): Record<string, unknown> {
  return structuredClone(BASE_PROFILE) as unknown as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.equal(Array.isArray(value), true);
  return value as unknown[];
}

function assertDomainFailure(
  operation: () => unknown,
  code: "invalid_input" | "conflict"
): void {
  assert.throws(
    operation,
    (error: unknown) => isDomainError(error) && error.code === code
  );
}

function captureDomainFailure(
  operation: () => unknown,
  code: "invalid_input" | "conflict" = "invalid_input",
): DomainError {
  let captured: DomainError | undefined;
  assert.throws(operation, (error: unknown) => {
    if (isDomainError(error) && error.code === code) {
      captured = error;
      return true;
    }
    return false;
  });
  if (captured === undefined) {
    assert.fail("Expected a DomainError to be captured.");
  }
  return captured;
}

test("register snapshots, fingerprints, and deeply freezes a valid profile", () => {
  const source = mutableProfile();
  const registry = new InMemoryTaskProfileRegistry();
  const pinned = registry.register(source);

  assert.equal(pinned.profileId, "profile:synthetic");
  assert.equal(pinned.profileVersion, 1);
  assert.match(pinned.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(pinned.fingerprint, canonicalSha256Hex(pinned.profile));
  assert.equal(Object.isFrozen(pinned), true);
  assert.equal(Object.isFrozen(pinned.profile), true);
  assert.equal(Object.isFrozen(pinned.profile.contextSources), true);
  assert.equal(Object.isFrozen(pinned.profile.contextSources[0]), true);
  assert.equal(
    Object.isFrozen(pinned.profile.contextSources[0]?.configuration),
    true
  );
  assert.equal(Object.isFrozen(pinned.profile.objectiveSchema.document), true);

  asRecord(source["driverProfile"])["componentId"] = "driver:mutated";
  asRecord(asArray(source["contextSources"])[0])["bindingId"] = "source:mutated";
  assert.equal(pinned.profile.driverProfile.componentId, "driver:scripted");
  assert.equal(pinned.profile.contextSources[0]?.bindingId, "source:fixture");
});

test("canonical fingerprints ignore object insertion order", () => {
  const original = mutableProfile();
  const reordered = Object.fromEntries(Object.entries(mutableProfile()).reverse());
  const first = new InMemoryTaskProfileRegistry().register(original);
  const second = new InMemoryTaskProfileRegistry().register(reordered);

  assert.equal(first.fingerprint, second.fingerprint);
});

test("duplicate profile versions conflict without replacing the first snapshot", () => {
  const registry = new InMemoryTaskProfileRegistry();
  const first = registry.register(mutableProfile());
  const duplicate = mutableProfile();
  asRecord(duplicate["driverProfile"])["componentId"] = "driver:different";

  assertDomainFailure(() => registry.register(duplicate), "conflict");
  assert.equal(
    registry.resolve("profile:synthetic", 1).driverProfile.componentId,
    first.profile.driverProfile.componentId
  );
});

test("resolve, pin, and list are deterministic immutable exact-version views", () => {
  const registry = new InMemoryTaskProfileRegistry();
  const versionTwo = mutableProfile();
  versionTwo["profileVersion"] = 2;
  const other = mutableProfile();
  other["profileId"] = "profile:alpha";
  other["profileVersion"] = 3;
  registry.register(versionTwo);
  registry.register(other);
  const versionOne = registry.register(mutableProfile());

  assert.equal(registry.resolve("profile:synthetic", 1), versionOne.profile);
  assert.equal(registry.pin("profile:synthetic", 1), versionOne);
  const listed = registry.list();
  assert.deepEqual(
    listed.map((entry) => [entry.profileId, entry.profileVersion]),
    [
      ["profile:alpha", 3],
      ["profile:synthetic", 1],
      ["profile:synthetic", 2],
    ]
  );
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(listed.every(Object.isFrozen), true);
  assertDomainFailure(() => registry.resolve("profile:missing", 1), "invalid_input");
  assertDomainFailure(() => registry.pin("profile:synthetic", 99), "invalid_input");
});

test("profiles with no model bindings and zero allowed actions remain valid", () => {
  const pinned = new InMemoryTaskProfileRegistry().register(mutableProfile());
  assert.deepEqual(pinned.profile.modelBindings, []);
  assert.equal(pinned.profile.budgetPolicy.maxActions, 0);
});

test("one action-capable planner is valid", () => {
  const profile = mutableProfile();
  profile["modelBindings"] = [
    {
      bindingId: "model:planner",
      roleId: "planner",
      authority: "planner",
      modelProfileId: "model:synthetic",
      modelProfileVersion: 1,
      mayProposeActions: true,
      configuration: {},
    },
    {
      bindingId: "model:grader",
      roleId: "grader",
      authority: "auxiliary",
      modelProfileId: "model:grader",
      modelProfileVersion: 1,
      mayProposeActions: false,
      configuration: {},
    },
  ];

  const pinned = new InMemoryTaskProfileRegistry().register(profile);
  assert.equal(pinned.profile.modelBindings.length, 2);
});

test("planner authority and action-proposal authority fail closed", () => {
  const planner = {
    bindingId: "model:planner",
    roleId: "planner",
    authority: "planner",
    modelProfileId: "model:synthetic",
    modelProfileVersion: 1,
    mayProposeActions: true,
    configuration: {},
  };
  const invalidBindingSets: readonly unknown[][] = [
    [planner, { ...planner, bindingId: "model:planner-2" }],
    [{ ...planner, mayProposeActions: false }],
    [{ ...planner, authority: "auxiliary" }],
    [{ ...planner, authority: "observer" }],
  ];

  for (const modelBindings of invalidBindingSets) {
    const profile = mutableProfile();
    profile["modelBindings"] = modelBindings;
    assertDomainFailure(
      () => new InMemoryTaskProfileRegistry().register(profile),
      "invalid_input"
    );
  }
});

test("binding ids must be unique within each category", () => {
  for (const category of [
    "modelBindings",
    "contextSources",
    "capabilityPacks",
  ] as const) {
    const profile = mutableProfile();
    if (category === "modelBindings") {
      profile[category] = [{
        bindingId: "model:grader",
        roleId: "grader",
        authority: "auxiliary",
        modelProfileId: "model:synthetic-grader",
        modelProfileVersion: 1,
        mayProposeActions: false,
        configuration: {},
      }];
    }
    const existing = asArray(profile[category])[0];
    profile[category] = [existing, structuredClone(existing)];
    assertDomainFailure(
      () => new InMemoryTaskProfileRegistry().register(profile),
      "invalid_input"
    );
  }

  const sameAcrossCategories = mutableProfile();
  asRecord(asArray(sameAcrossCategories["contextSources"])[0])["bindingId"] =
    "shared:binding";
  asRecord(asArray(sameAcrossCategories["capabilityPacks"])[0])["bindingId"] =
    "shared:binding";
  assert.doesNotThrow(() =>
    new InMemoryTaskProfileRegistry().register(sameAcrossCategories)
  );
});

test("all version, identifier, evidence, and budget fields are validated", () => {
  const mutations: readonly ((profile: Record<string, unknown>) => void)[] = [
    (profile) => { profile["schemaVersion"] = 2; },
    (profile) => { profile["profileId"] = "   "; },
    (profile) => { profile["profileVersion"] = 0; },
    (profile) => { profile["profileVersion"] = 1.5; },
    (profile) => { asRecord(profile["objectiveSchema"])["schemaId"] = ""; },
    (profile) => { asRecord(profile["objectiveSchema"])["schemaVersion"] = 0; },
    (profile) => { asRecord(profile["driverProfile"])["componentId"] = ""; },
    (profile) => { asRecord(profile["driverProfile"])["componentVersion"] = 0; },
    (profile) => {
      asRecord(asArray(profile["contextSources"])[0])["bindingId"] = "";
    },
    (profile) => {
      asRecord(asArray(profile["capabilityPacks"])[0])["componentVersion"] = 0;
    },
    (profile) => { asRecord(profile["policyProfile"])["componentVersion"] = 1.2; },
    (profile) => { profile["evidenceMode"] = "plaintext"; },
    (profile) => { asRecord(profile["budgetPolicy"])["maxTurns"] = 0; },
    (profile) => { asRecord(profile["budgetPolicy"])["maxActions"] = -1; },
    (profile) => { asRecord(profile["budgetPolicy"])["maxElapsedMs"] = 0; },
    (profile) => { asRecord(profile["budgetPolicy"])["maxInputBytes"] = 0; },
    (profile) => { asRecord(profile["budgetPolicy"])["maxOutputBytes"] = 0; },
    (profile) => {
      asRecord(profile["budgetPolicy"])["maxTurns"] = Number.MAX_SAFE_INTEGER + 1;
    },
  ];

  for (const mutate of mutations) {
    const profile = mutableProfile();
    mutate(profile);
    assertDomainFailure(
      () => new InMemoryTaskProfileRegistry().register(profile),
      "invalid_input"
    );
  }
});

test("every model-binding field and optional evaluation profile is validated", () => {
  const auxiliary = {
    bindingId: "model:grader",
    roleId: "grader",
    authority: "auxiliary",
    modelProfileId: "model:synthetic-grader",
    modelProfileVersion: 1,
    mayProposeActions: false,
    configuration: {},
  };
  const modelMutations: readonly ((binding: Record<string, unknown>) => void)[] = [
    (binding) => { binding["bindingId"] = ""; },
    (binding) => { binding["roleId"] = ""; },
    (binding) => { binding["modelProfileId"] = ""; },
    (binding) => { binding["modelProfileVersion"] = 0; },
    (binding) => { binding["mayProposeActions"] = "false"; },
    (binding) => { binding["configuration"] = []; },
    (binding) => { binding["unknown"] = true; },
  ];
  for (const mutate of modelMutations) {
    const profile = mutableProfile();
    const binding = structuredClone(auxiliary) as Record<string, unknown>;
    mutate(binding);
    profile["modelBindings"] = [binding];
    assertDomainFailure(
      () => new InMemoryTaskProfileRegistry().register(profile),
      "invalid_input"
    );
  }

  const durable = mutableProfile();
  durable["evidenceMode"] = "durable_encrypted";
  durable["evaluationProfile"] = {
    componentId: "evaluation:synthetic",
    componentVersion: 1,
    configuration: {},
  };
  assert.doesNotThrow(() => new InMemoryTaskProfileRegistry().register(durable));

  const invalidEvaluation = mutableProfile();
  invalidEvaluation["evaluationProfile"] = {
    componentId: "evaluation:synthetic",
    componentVersion: 0,
    configuration: {},
  };
  assertDomainFailure(
    () => new InMemoryTaskProfileRegistry().register(invalidEvaluation),
    "invalid_input"
  );
});

test("schemas, configurations, arrays, and nested fields reject malformed data", () => {
  const mutations: readonly ((profile: Record<string, unknown>) => void)[] = [
    (profile) => { profile["unknown"] = true; },
    (profile) => { delete profile["outcomeSchema"]; },
    (profile) => { asRecord(profile["objectiveSchema"])["unknown"] = true; },
    (profile) => { asRecord(profile["driverProfile"])["configuration"] = new Date(); },
    (profile) => { asRecord(profile["policyProfile"])["configuration"] = undefined; },
    (profile) => { asRecord(profile["budgetPolicy"])["extensions"] = new Map(); },
    (profile) => { profile["modelBindings"] = {}; },
    (profile) => { profile["contextSources"] = [null]; },
    (profile) => {
      asRecord(asArray(profile["capabilityPacks"])[0])["configuration"] = {
        invalid: () => undefined,
      };
    },
  ];

  for (const mutate of mutations) {
    const profile = mutableProfile();
    mutate(profile);
    assertDomainFailure(
      () => new InMemoryTaskProfileRegistry().register(profile),
      "invalid_input"
    );
  }
});

test("hostile objects and cycles become safe invalid_input domain errors", () => {
  const hostileRoot = new Proxy(
    {},
    { ownKeys() { throw new Error("hostile root"); } }
  );
  const hostileNested = new Proxy(
    { poison: true },
    { getOwnPropertyDescriptor() { throw new Error("hostile nested"); } }
  );
  const getterProfile = mutableProfile();
  Object.defineProperty(getterProfile, "profileId", {
    enumerable: true,
    get() { throw new Error("hostile getter"); },
  });
  const nestedProfile = mutableProfile();
  asRecord(nestedProfile["driverProfile"])["configuration"] = hostileNested;
  const cyclicProfile = mutableProfile();
  const cycle: Record<string, unknown> = {};
  cycle["self"] = cycle;
  asRecord(cyclicProfile["driverProfile"])["configuration"] = cycle;

  for (const value of [hostileRoot, getterProfile, nestedProfile, cyclicProfile]) {
    assertDomainFailure(
      () => new InMemoryTaskProfileRegistry().register(value),
      "invalid_input"
    );
  }
});

test("resolve and pin validate their own untrusted lookup inputs", () => {
  const registry = new InMemoryTaskProfileRegistry();
  registry.register(mutableProfile());
  for (const profileId of ["", "   ", " profile:synthetic", 1, null]) {
    assertDomainFailure(
      () => registry.resolve(profileId as never, 1),
      "invalid_input"
    );
  }
  for (const profileVersion of [0, -1, 1.5, Number.NaN, "1", null]) {
    assertDomainFailure(
      () => registry.pin("profile:synthetic", profileVersion as never),
      "invalid_input"
    );
  }
});

test("registration eagerly rejects invalid and asynchronous payload schemas", () => {
  const invalidObjective = mutableProfile();
  asRecord(asRecord(invalidObjective["objectiveSchema"])["document"])[
    "unreviewedKeyword"
  ] = true;
  const asyncOutcome = mutableProfile();
  asRecord(asRecord(asyncOutcome["outcomeSchema"])["document"])["$async"] = true;

  for (const profile of [invalidObjective, asyncOutcome]) {
    const registry = new InMemoryTaskProfileRegistry();
    const error = captureDomainFailure(() => registry.register(profile));
    assert.equal(error.details?.["reason"], "invalid_schema");
    assert.deepEqual(registry.list(), []);
  }
});

test("validateObjective and validateOutcome return detached frozen envelopes", () => {
  const registry = new InMemoryTaskProfileRegistry();
  registry.register(mutableProfile());

  const objective = structuredClone(BASE_OBJECTIVE);
  const validatedObjective = registry.validateObjective(objective);
  assert.deepEqual(validatedObjective, objective);
  assert.notStrictEqual(validatedObjective, objective);
  assert.notStrictEqual(validatedObjective.payload, objective.payload);
  assert.equal(Object.isFrozen(validatedObjective), true);
  assert.equal(Object.isFrozen(validatedObjective.payload), true);

  const outcome = structuredClone(BASE_OUTCOME);
  const validatedOutcome = registry.validateOutcome(outcome);
  assert.deepEqual(validatedOutcome, outcome);
  assert.notStrictEqual(validatedOutcome, outcome);
  assert.notStrictEqual(validatedOutcome.payload, outcome.payload);
  assert.equal(Object.isFrozen(validatedOutcome), true);
  assert.equal(Object.isFrozen(validatedOutcome.payload), true);

  (objective.payload as Record<string, unknown>)["input"] = "mutated";
  (outcome.payload as Record<string, unknown>)["answer"] = "mutated";
  assert.equal(validatedObjective.payload["input"], "alpha");
  assert.equal(validatedOutcome.payload["answer"], "alpha");
});

test("complete envelope parsing and exact profile-version routing fail closed", () => {
  const registry = new InMemoryTaskProfileRegistry();
  registry.register(mutableProfile());

  const malformedObjective = {
    ...structuredClone(BASE_OBJECTIVE),
    providerRequestId: "must-not-cross",
  };
  const malformedOutcome = structuredClone(BASE_OUTCOME) as unknown as Record<
    string,
    unknown
  >;
  delete malformedOutcome["outcomeTypeVersion"];
  const wrongObjectiveProfile = {
    ...structuredClone(BASE_OBJECTIVE),
    profileId: "profile:missing",
  };
  const wrongOutcomeVersion = {
    ...structuredClone(BASE_OUTCOME),
    profileVersion: 2,
  };

  for (const operation of [
    () => registry.validateObjective(malformedObjective),
    () => registry.validateOutcome(malformedOutcome),
    () => registry.validateObjective(wrongObjectiveProfile),
    () => registry.validateOutcome(wrongOutcomeVersion),
  ]) {
    assertDomainFailure(operation, "invalid_input");
  }
});

test("profile payload schemas reject invalid and extra fields without mutation", () => {
  const registry = new InMemoryTaskProfileRegistry();
  registry.register(mutableProfile());

  const missingDefault = structuredClone(BASE_OBJECTIVE);
  const validated = registry.validateObjective(missingDefault);
  assert.equal("tag" in missingDefault.payload, false);
  assert.equal("tag" in validated.payload, false);

  const wrongType = structuredClone(BASE_OBJECTIVE) as unknown as {
    payload: Record<string, unknown>;
  };
  wrongType.payload["input"] = 7;
  assertDomainFailure(() => registry.validateObjective(wrongType), "invalid_input");
  assert.equal(wrongType.payload["input"], 7);

  const extra = structuredClone(BASE_OBJECTIVE) as unknown as {
    payload: Record<string, unknown>;
  };
  extra.payload["extra"] = true;
  assertDomainFailure(() => registry.validateObjective(extra), "invalid_input");
  assert.equal(extra.payload["extra"], true);

  const missingOutcome = structuredClone(BASE_OUTCOME) as unknown as {
    payload: Record<string, unknown>;
  };
  delete missingOutcome.payload["answer"];
  assertDomainFailure(
    () => registry.validateOutcome(missingOutcome),
    "invalid_input",
  );
});

test("objective and outcome validation reject traps without canary leakage", () => {
  const registry = new InMemoryTaskProfileRegistry();
  registry.register(mutableProfile());
  const canary = "SECRET_PROFILE_PAYLOAD_CANARY_1a0e";
  let proxyGets = 0;
  const objectiveProxy = new Proxy(structuredClone(BASE_OBJECTIVE), {
    get(target, key, receiver) {
      proxyGets += 1;
      if (key === "payload") throw new Error(canary);
      return Reflect.get(target, key, receiver);
    },
  });
  const proxyError = captureDomainFailure(() =>
    registry.validateObjective(objectiveProxy),
  );
  assert.equal(proxyGets, 0);
  assert.equal(JSON.stringify(proxyError).includes(canary), false);

  let accessorGets = 0;
  const outcomeAccessor = structuredClone(BASE_OUTCOME) as unknown as Record<
    string,
    unknown
  >;
  Object.defineProperty(outcomeAccessor, "payload", {
    enumerable: true,
    get() {
      accessorGets += 1;
      throw new Error(canary);
    },
  });
  const accessorError = captureDomainFailure(() =>
    registry.validateOutcome(outcomeAccessor),
  );
  assert.equal(accessorGets, 0);
  assert.equal(JSON.stringify(accessorError).includes(canary), false);
});

test("profile budget byte limits accept exact payload bytes and reject one byte over", () => {
  const profile = mutableProfile();
  const exactObjectivePayload = { input: "é" };
  const exactOutcomePayload = { answer: "é" };
  asRecord(profile["budgetPolicy"])["maxInputBytes"] =
    canonicalBytes(exactObjectivePayload).byteLength;
  asRecord(profile["budgetPolicy"])["maxOutputBytes"] =
    canonicalBytes(exactOutcomePayload).byteLength;

  const registry = new InMemoryTaskProfileRegistry();
  registry.register(profile);
  assert.doesNotThrow(() =>
    registry.validateObjective({
      ...BASE_OBJECTIVE,
      payload: exactObjectivePayload,
    }),
  );
  assert.doesNotThrow(() =>
    registry.validateOutcome({ ...BASE_OUTCOME, payload: exactOutcomePayload }),
  );
  assertDomainFailure(
    () =>
      registry.validateObjective({
        ...BASE_OBJECTIVE,
        payload: { input: "éx" },
      }),
    "invalid_input",
  );
  assertDomainFailure(
    () =>
      registry.validateOutcome({
        ...BASE_OUTCOME,
        payload: { answer: "éx" },
      }),
    "invalid_input",
  );
});

test("registry schema-byte configuration is positive and enforced at registration", () => {
  const profile = mutableProfile() as unknown as TaskProfile;
  const exact = Math.max(
    canonicalBytes(profile.objectiveSchema).byteLength,
    canonicalBytes(profile.outcomeSchema).byteLength,
  );
  assert.doesNotThrow(() =>
    new InMemoryTaskProfileRegistry({ maxSchemaBytes: exact }).register(profile),
  );
  assertDomainFailure(
    () =>
      new InMemoryTaskProfileRegistry({ maxSchemaBytes: exact - 1 }).register(
        profile,
      ),
    "invalid_input",
  );
  assertDomainFailure(
    () => new InMemoryTaskProfileRegistry({ maxSchemaBytes: 0 }),
    "invalid_input",
  );
});
