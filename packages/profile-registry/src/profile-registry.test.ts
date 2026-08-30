import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSha256Hex,
  isDomainError,
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
      properties: { input: { type: "string" } },
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
    document: { type: "object", required: ["answer"] },
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
