import {
  canonicalSha256Hex,
  createDomainError,
  isDomainError,
  parseObjectiveEnvelope,
  parseOutcomeEnvelope,
  parseTaskProfile,
  snapshotBoundaryJsonObject,
  type JsonObject,
  type ObjectiveEnvelope,
  type OutcomeEnvelope,
  type TaskProfile,
} from "@guard/contracts";
import {
  compileTrustedJsonObjectSchema,
  type CompiledJsonObjectSchema,
} from "@guard/schema-validation";

export const DEFAULT_MAX_PROFILE_SCHEMA_BYTES = 256 * 1_024;

export interface TaskProfileRegistryOptions {
  readonly maxSchemaBytes: number;
}

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
  validateObjective(value: unknown): ObjectiveEnvelope;
  validateOutcome(value: unknown): OutcomeEnvelope;
}

interface StoredProfile {
  readonly pinned: PinnedTaskProfile;
  readonly listEntry: TaskProfileListEntry;
  readonly objectiveValidator: CompiledJsonObjectSchema;
  readonly outcomeValidator: CompiledJsonObjectSchema;
}

/**
 * Process-local registry of immutable, exact-version task-profile snapshots.
 * Registration is the only mutation; values returned from every read method
 * are frozen snapshots that cannot modify registry state.
 */
export class InMemoryTaskProfileRegistry implements TaskProfileRegistry {
  readonly #profiles = new Map<string, Map<number, StoredProfile>>();
  readonly #maxSchemaBytes: number;

  constructor(
    options: TaskProfileRegistryOptions = {
      maxSchemaBytes: DEFAULT_MAX_PROFILE_SCHEMA_BYTES,
    },
  ) {
    this.#maxSchemaBytes = parseRegistryOptions(options).maxSchemaBytes;
  }

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

    const objectiveValidator = compileTrustedJsonObjectSchema(
      profile.objectiveSchema,
      {
        maxSchemaBytes: this.#maxSchemaBytes,
        maxValueBytes: profile.budgetPolicy.maxInputBytes,
      },
    );
    const outcomeValidator = compileTrustedJsonObjectSchema(profile.outcomeSchema, {
      maxSchemaBytes: this.#maxSchemaBytes,
      maxValueBytes: profile.budgetPolicy.maxOutputBytes,
    });

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
    const stored: StoredProfile = Object.freeze({
      pinned,
      listEntry,
      objectiveValidator,
      outcomeValidator,
    });
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

  validateObjective(value: unknown): ObjectiveEnvelope {
    const objective = parseObjectiveEnvelope(value);
    const stored = this.lookup(objective.profileId, objective.profileVersion);
    stored.objectiveValidator.validate(objective.payload);
    return objective;
  }

  validateOutcome(value: unknown): OutcomeEnvelope {
    const outcome = parseOutcomeEnvelope(value);
    const stored = this.lookup(outcome.profileId, outcome.profileVersion);
    stored.outcomeValidator.validate(outcome.payload);
    return outcome;
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
  try {
    return parseTaskProfile(value);
  } catch (error: unknown) {
    if (isDomainError(error)) {
      throw error;
    }
    throw createDomainError({
      code: "invalid_input",
      message: "The task profile could not be validated safely.",
    });
  }
}

function parseRegistryOptions(value: unknown): TaskProfileRegistryOptions {
  let snapshot: JsonObject;
  try {
    snapshot = snapshotBoundaryJsonObject(value);
  } catch {
    throw invalidRegistryOptions();
  }
  const keys = Object.keys(snapshot);
  if (
    keys.length !== 1 ||
    keys[0] !== "maxSchemaBytes" ||
    typeof snapshot["maxSchemaBytes"] !== "number" ||
    !Number.isSafeInteger(snapshot["maxSchemaBytes"]) ||
    snapshot["maxSchemaBytes"] < 1
  ) {
    throw invalidRegistryOptions();
  }
  return snapshot as unknown as TaskProfileRegistryOptions;
}

function invalidRegistryOptions() {
  return createDomainError({
    code: "invalid_input",
    message: "Task-profile registry options are malformed.",
    details: { reason: "invalid_limits" },
  });
}

function requireIdentifier(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw invalidLookup(path, "must be a nonempty identifier without edge whitespace");
  }
}

function requirePositiveSafeInteger(
  value: unknown,
  path: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidLookup(path, "must be a positive safe integer");
  }
}

function invalidLookup(path: string, reason: string) {
  return createDomainError({
    code: "invalid_input",
    message: "The task-profile lookup is malformed.",
    details: { path, reason },
  });
}
