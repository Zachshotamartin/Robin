import {
  canonicalSha256Hex,
  cloneAndFreezeJsonObject,
  createDomainError,
  isContractSchemaVersion,
  isDomainError,
  type ComponentBinding,
  type JsonObject,
  type NamedComponentBinding,
  type TaskProfile,
  type VersionedSchema,
} from "@guard/contracts";

export interface PinnedTaskProfile {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly fingerprint: string;
  readonly profile: TaskProfile;
}

export interface TaskProfileListEntry {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly fingerprint: string;
}

export interface TaskProfileRegistry {
  register(profile: unknown): PinnedTaskProfile;
  resolve(profileId: unknown, profileVersion: unknown): TaskProfile;
  list(): readonly TaskProfileListEntry[];
  pin(profileId: unknown, profileVersion: unknown): PinnedTaskProfile;
}

interface StoredProfile {
  readonly pinned: PinnedTaskProfile;
  readonly listEntry: TaskProfileListEntry;
}

/**
 * Process-local registry of immutable, exact-version task-profile snapshots.
 * Registration is the only mutation; values returned from every read method
 * are frozen snapshots that cannot modify registry state.
 */
export class InMemoryTaskProfileRegistry implements TaskProfileRegistry {
  readonly #profiles = new Map<string, Map<number, StoredProfile>>();

  register(value: unknown): PinnedTaskProfile {
    const profile = snapshotAndValidate(value);
    const existingVersions = this.#profiles.get(profile.profileId);
    if (existingVersions?.has(profile.profileVersion) === true) {
      throw createDomainError({
        code: "conflict",
        message: "That task-profile version is already registered.",
        details: {
          profileId: profile.profileId,
          profileVersion: profile.profileVersion,
        },
      });
    }

    const fingerprint = canonicalSha256Hex(profile);
    const pinned: PinnedTaskProfile = Object.freeze({
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      fingerprint,
      profile,
    });
    const listEntry: TaskProfileListEntry = Object.freeze({
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      fingerprint,
    });
    const stored: StoredProfile = Object.freeze({ pinned, listEntry });
    const versions = existingVersions ?? new Map<number, StoredProfile>();
    versions.set(profile.profileVersion, stored);
    if (existingVersions === undefined) {
      this.#profiles.set(profile.profileId, versions);
    }
    return pinned;
  }

  resolve(profileId: unknown, profileVersion: unknown): TaskProfile {
    return this.lookup(profileId, profileVersion).pinned.profile;
  }

  pin(profileId: unknown, profileVersion: unknown): PinnedTaskProfile {
    return this.lookup(profileId, profileVersion).pinned;
  }

  list(): readonly TaskProfileListEntry[] {
    const entries: TaskProfileListEntry[] = [];
    for (const versions of this.#profiles.values()) {
      for (const stored of versions.values()) {
        entries.push(stored.listEntry);
      }
    }
    entries.sort((left, right) => {
      if (left.profileId < right.profileId) {
        return -1;
      }
      if (left.profileId > right.profileId) {
        return 1;
      }
      return left.profileVersion - right.profileVersion;
    });
    return Object.freeze(entries);
  }

  private lookup(profileId: unknown, profileVersion: unknown): StoredProfile {
    requireIdentifier(profileId, "profileId");
    requirePositiveSafeInteger(profileVersion, "profileVersion");
    const stored = this.#profiles.get(profileId)?.get(profileVersion);
    if (stored === undefined) {
      throw createDomainError({
        code: "invalid_input",
        message: "The requested task-profile version is not registered.",
        details: { profileId, profileVersion },
      });
    }
    return stored;
  }
}

function snapshotAndValidate(value: unknown): TaskProfile {
  let snapshot: JsonObject;
  try {
    snapshot = cloneAndFreezeJsonObject(
      value as Readonly<Record<string, unknown>>,
      "Task profile"
    );
  } catch {
    throw invalidProfile("$", "must be a lossless JSON object");
  }

  try {
    validateTaskProfile(snapshot);
  } catch (error: unknown) {
    if (isDomainError(error)) {
      throw error;
    }
    throw invalidProfile("$", "could not be validated safely");
  }
  return snapshot as unknown as TaskProfile;
}

const TASK_PROFILE_KEYS = new Set([
  "schemaVersion",
  "profileId",
  "profileVersion",
  "objectiveSchema",
  "driverProfile",
  "modelBindings",
  "contextSources",
  "capabilityPacks",
  "policyProfile",
  "outcomeSchema",
  "budgetPolicy",
  "evidenceMode",
  "evaluationProfile",
]);

function validateTaskProfile(profile: JsonObject): void {
  requireExactKeys(profile, TASK_PROFILE_KEYS, "$", "task profile");
  if (!isContractSchemaVersion(profile["schemaVersion"])) {
    throw invalidProfile("$.schemaVersion", "must be the current contract version");
  }
  requireIdentifier(profile["profileId"], "$.profileId");
  requirePositiveSafeInteger(profile["profileVersion"], "$.profileVersion");
  validateSchema(profile["objectiveSchema"], "$.objectiveSchema");
  validateComponent(profile["driverProfile"], "$.driverProfile", false);
  validateModelBindings(profile["modelBindings"]);
  validateNamedComponents(profile["contextSources"], "$.contextSources");
  validateNamedComponents(profile["capabilityPacks"], "$.capabilityPacks");
  validateComponent(profile["policyProfile"], "$.policyProfile", false);
  validateSchema(profile["outcomeSchema"], "$.outcomeSchema");
  validateBudget(profile["budgetPolicy"]);
  if (
    profile["evidenceMode"] !== "durable_encrypted" &&
    profile["evidenceMode"] !== "ephemeral_metadata"
  ) {
    throw invalidProfile("$.evidenceMode", "must be a supported evidence mode");
  }
  if (profile["evaluationProfile"] !== null) {
    validateComponent(profile["evaluationProfile"], "$.evaluationProfile", false);
  }
}

const SCHEMA_KEYS = new Set(["schemaId", "schemaVersion", "document"]);

function validateSchema(value: unknown, path: string): asserts value is VersionedSchema {
  const schema = requireObject(value, path);
  requireExactKeys(schema, SCHEMA_KEYS, path, "schema");
  requireIdentifier(schema["schemaId"], `${path}.schemaId`);
  requirePositiveSafeInteger(schema["schemaVersion"], `${path}.schemaVersion`);
  requireObject(schema["document"], `${path}.document`);
}

const COMPONENT_KEYS = new Set([
  "componentId",
  "componentVersion",
  "configuration",
]);
const NAMED_COMPONENT_KEYS = new Set([...COMPONENT_KEYS, "bindingId"]);

function validateComponent(
  value: unknown,
  path: string,
  named: false
): asserts value is ComponentBinding;
function validateComponent(
  value: unknown,
  path: string,
  named: true
): asserts value is NamedComponentBinding;
function validateComponent(value: unknown, path: string, named: boolean): void {
  const component = requireObject(value, path);
  requireExactKeys(
    component,
    named ? NAMED_COMPONENT_KEYS : COMPONENT_KEYS,
    path,
    named ? "named component binding" : "component binding"
  );
  if (named) {
    requireIdentifier(component["bindingId"], `${path}.bindingId`);
  }
  requireIdentifier(component["componentId"], `${path}.componentId`);
  requirePositiveSafeInteger(
    component["componentVersion"],
    `${path}.componentVersion`
  );
  requireObject(component["configuration"], `${path}.configuration`);
}

function validateNamedComponents(value: unknown, path: string): void {
  const bindings = requireArray(value, path);
  const seen = new Set<string>();
  for (let index = 0; index < bindings.length; index += 1) {
    const bindingPath = `${path}[${index}]`;
    const binding = bindings[index];
    validateComponent(binding, bindingPath, true);
    if (seen.has(binding.bindingId)) {
      throw invalidProfile(`${bindingPath}.bindingId`, "must be unique in its category");
    }
    seen.add(binding.bindingId);
  }
}

const MODEL_BINDING_KEYS = new Set([
  "bindingId",
  "roleId",
  "authority",
  "modelProfileId",
  "modelProfileVersion",
  "mayProposeActions",
  "configuration",
]);

function validateModelBindings(value: unknown): void {
  const bindings = requireArray(value, "$.modelBindings");
  const seen = new Set<string>();
  let plannerCount = 0;
  for (let index = 0; index < bindings.length; index += 1) {
    const path = `$.modelBindings[${index}]`;
    const binding = requireObject(bindings[index], path);
    requireExactKeys(binding, MODEL_BINDING_KEYS, path, "model binding");
    requireIdentifier(binding["bindingId"], `${path}.bindingId`);
    requireIdentifier(binding["roleId"], `${path}.roleId`);
    requireIdentifier(binding["modelProfileId"], `${path}.modelProfileId`);
    requirePositiveSafeInteger(
      binding["modelProfileVersion"],
      `${path}.modelProfileVersion`
    );
    requireObject(binding["configuration"], `${path}.configuration`);
    if (typeof binding["mayProposeActions"] !== "boolean") {
      throw invalidProfile(`${path}.mayProposeActions`, "must be a boolean");
    }
    if (binding["authority"] === "planner") {
      plannerCount += 1;
      if (binding["mayProposeActions"] !== true) {
        throw invalidProfile(path, "a planner must be action-capable");
      }
    } else if (binding["authority"] === "auxiliary") {
      if (binding["mayProposeActions"] !== false) {
        throw invalidProfile(path, "an auxiliary binding cannot propose actions");
      }
    } else {
      throw invalidProfile(`${path}.authority`, "must be planner or auxiliary");
    }
    const bindingId = binding["bindingId"] as string;
    if (seen.has(bindingId)) {
      throw invalidProfile(`${path}.bindingId`, "must be unique in its category");
    }
    seen.add(bindingId);
  }
  if (plannerCount > 1) {
    throw invalidProfile("$.modelBindings", "must contain no more than one planner");
  }
}

const BUDGET_KEYS = new Set([
  "maxTurns",
  "maxActions",
  "maxElapsedMs",
  "maxInputBytes",
  "maxOutputBytes",
  "extensions",
]);

function validateBudget(value: unknown): void {
  const budget = requireObject(value, "$.budgetPolicy");
  requireExactKeys(budget, BUDGET_KEYS, "$.budgetPolicy", "budget policy");
  requirePositiveSafeInteger(budget["maxTurns"], "$.budgetPolicy.maxTurns");
  requireNonnegativeSafeInteger(budget["maxActions"], "$.budgetPolicy.maxActions");
  requirePositiveSafeInteger(
    budget["maxElapsedMs"],
    "$.budgetPolicy.maxElapsedMs"
  );
  requirePositiveSafeInteger(
    budget["maxInputBytes"],
    "$.budgetPolicy.maxInputBytes"
  );
  requirePositiveSafeInteger(
    budget["maxOutputBytes"],
    "$.budgetPolicy.maxOutputBytes"
  );
  requireObject(budget["extensions"], "$.budgetPolicy.extensions");
}

function requireObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidProfile(path, "must be an object");
  }
  return value as JsonObject;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalidProfile(path, "must be an array");
  }
  return value;
}

function requireExactKeys(
  value: JsonObject,
  expected: ReadonlySet<string>,
  path: string,
  label: string
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.size ||
    keys.some((key) => !expected.has(key))
  ) {
    throw invalidProfile(path, `${label} fields must match the current contract exactly`);
  }
}

function requireIdentifier(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw invalidProfile(path, "must be a nonempty identifier without edge whitespace");
  }
}

function requirePositiveSafeInteger(
  value: unknown,
  path: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidProfile(path, "must be a positive safe integer");
  }
}

function requireNonnegativeSafeInteger(
  value: unknown,
  path: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidProfile(path, "must be a nonnegative safe integer");
  }
}

function invalidProfile(path: string, reason: string) {
  return createDomainError({
    code: "invalid_input",
    message: "The task profile is malformed or semantically invalid.",
    details: { path, reason },
  });
}
