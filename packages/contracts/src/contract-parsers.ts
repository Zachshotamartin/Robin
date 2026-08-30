import { snapshotBoundaryJsonObject } from "./boundary-snapshot.js";
import { createDomainError } from "./errors.js";
import {
  validateAction,
  validateActor,
  validateContentBlock,
  validateObjective,
  validateObservation,
  validateOutcome,
  validateResource,
  validateTaskProfile,
  validateVersionedSchema,
} from "./known-event-validation.js";
import type { ActorIdentity } from "./actor.js";
import type { ContentBlock } from "./content.js";
import type { NormalizedAction } from "./action.js";
import type { ResourceRef } from "./resource.js";
import type { Observation, OutcomeEnvelope } from "./result.js";
import type {
  ObjectiveEnvelope,
  TaskProfile,
  VersionedSchema,
} from "./task-profile.js";

/** Parse APIs are the security boundary; each returns the exact validated snapshot. */
export function parseActorIdentity(value: unknown): ActorIdentity {
  return parseContract(value, validateActor, "actor identity");
}

export function parseObjectiveEnvelope(value: unknown): ObjectiveEnvelope {
  return parseContract(value, validateObjective, "objective envelope");
}

export function parseTaskProfile(value: unknown): TaskProfile {
  return parseContract(value, validateTaskProfile, "task profile");
}

export function parseResourceRef(value: unknown): ResourceRef {
  return parseContract(value, validateResource, "resource reference");
}

export function parseContentBlock(value: unknown): ContentBlock {
  return parseContract(value, validateContentBlock, "content block");
}

export function parseNormalizedAction(value: unknown): NormalizedAction {
  return parseContract(value, validateAction, "normalized action");
}

export function parseObservation(value: unknown): Observation {
  return parseContract(value, validateObservation, "observation");
}

export function parseOutcomeEnvelope(value: unknown): OutcomeEnvelope {
  return parseContract(value, validateOutcome, "outcome envelope");
}

export function parseVersionedSchema(value: unknown): VersionedSchema {
  return parseContract(value, validateVersionedSchema, "versioned schema");
}

function parseContract<T>(
  value: unknown,
  validate: (candidate: unknown) => boolean,
  label: string
): T {
  try {
    const snapshot = snapshotBoundaryJsonObject(value);
    if (validate(snapshot)) {
      return snapshot as unknown as T;
    }
  } catch {
    // Deliberately discard hostile values and exceptions.
  }
  throw createDomainError({
    code: "invalid_input",
    message: `Invalid ${label}.`,
  });
}
