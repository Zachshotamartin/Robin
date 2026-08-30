import { ACTOR_KINDS } from "./actor.js";
import { canonicalBytes } from "./canonical-json.js";
import { isDomainError } from "./errors.js";
import {
  ActionIdKind,
  AgentAttemptIdKind,
  ApprovalIdKind,
  ArtifactIdKind,
  DriverProposalIdKind,
  PolicyVersionIdKind,
  RunIdKind,
} from "./ids.js";
import { isJsonObject, isJsonValue } from "./json-value.js";
import { isContractSchemaVersion, isPositiveVersion } from "./schema-version.js";

type RecordValue = Readonly<Record<string, unknown>>;

const ACTOR_KIND_SET: ReadonlySet<string> = new Set(ACTOR_KINDS);
const SIDE_EFFECTS: ReadonlySet<string> = new Set([
  "none",
  "local_reversible",
  "local_irreversible",
  "external",
]);
const OBSERVATION_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "uncertain",
  "denied",
]);
const EVIDENCE_KINDS: ReadonlySet<string> = new Set([
  "event",
  "artifact",
  "resource",
  "action",
  "observation",
]);

export function validateKnownEventPayload(
  eventType: string,
  value: unknown
): boolean {
  try {
    switch (eventType) {
      case "RunCreated": {
        const payload = exactRecord(value, ["objective"]);
        return payload !== null && validateObjective(payload["objective"]);
      }
      case "TaskProfilePinned": {
        const payload = exactRecord(value, ["taskProfile"]);
        return payload !== null && validateTaskProfile(payload["taskProfile"]);
      }
      case "RunStarted": {
        const payload = exactRecord(value, ["startedAt"]);
        return payload !== null && timestamp(payload["startedAt"]);
      }
      case "RunIntentAppended": {
        const payload = exactRecord(value, [
          "intentType",
          "intentVersion",
          "payload",
          "submittedBy",
        ]);
        return (
          payload !== null &&
          identifier(payload["intentType"]) &&
          positiveInteger(payload["intentVersion"]) &&
          isJsonObject(payload["payload"]) &&
          validateActor(payload["submittedBy"])
        );
      }
      case "RunPaused":
      case "CancellationRequested": {
        const payload = exactRecord(value, ["reason"]);
        return payload !== null && nullableString(payload["reason"]);
      }
      case "RunResumed": {
        const payload = exactRecord(value, ["resumedAt"]);
        return payload !== null && timestamp(payload["resumedAt"]);
      }
      case "RunCancelled": {
        const payload = exactRecord(value, ["result"]);
        return payload !== null && validateCancelledResult(payload["result"]);
      }
      case "RunFailed": {
        const payload = exactRecord(value, ["result"]);
        return payload !== null && validateFailedResult(payload["result"]);
      }
      case "RunCompleted": {
        const payload = exactRecord(value, ["result"]);
        return payload !== null && validateCompletedResult(payload["result"]);
      }
      case "RunOrphaned": {
        const payload = exactRecord(value, ["result"]);
        return payload !== null && validateOrphanedResult(payload["result"]);
      }
      case "AgentDriverStarted": {
        const payload = exactRecord(value, [
          "driverProfileId",
          "driverProfileVersion",
          "driverFingerprint",
        ]);
        return (
          payload !== null &&
          identifier(payload["driverProfileId"]) &&
          positiveInteger(payload["driverProfileVersion"]) &&
          nonEmptyString(payload["driverFingerprint"])
        );
      }
      case "AgentAttemptStarted": {
        const payload = exactRecord(value, ["attemptId", "turn"]);
        return (
          payload !== null &&
          AgentAttemptIdKind.is(payload["attemptId"]) &&
          positiveInteger(payload["turn"])
        );
      }
      case "AgentContentCompleted": {
        const payload = exactRecord(value, ["attemptId", "content"]);
        return (
          payload !== null &&
          AgentAttemptIdKind.is(payload["attemptId"]) &&
          validateContentArray(payload["content"])
        );
      }
      case "AgentUsageRecorded": {
        const payload = exactRecord(value, ["attemptId", "usage"]);
        return (
          payload !== null &&
          AgentAttemptIdKind.is(payload["attemptId"]) &&
          isJsonObject(payload["usage"])
        );
      }
      case "AgentAttemptUncertain":
      case "AgentAttemptFailed": {
        const payload = exactRecord(value, ["attemptId", "error"]);
        return (
          payload !== null &&
          AgentAttemptIdKind.is(payload["attemptId"]) &&
          isDomainError(payload["error"])
        );
      }
      case "ContextRequested": {
        const payload = exactRecord(value, ["requestId", "resource"]);
        return (
          payload !== null &&
          identifier(payload["requestId"]) &&
          validateResource(payload["resource"])
        );
      }
      case "ContextReleased": {
        const payload = exactRecord(value, ["requestId", "resource", "content"]);
        return (
          payload !== null &&
          identifier(payload["requestId"]) &&
          validateResource(payload["resource"]) &&
          validateContentArray(payload["content"])
        );
      }
      case "ContextDenied": {
        const payload = exactRecord(value, ["requestId", "error"]);
        return (
          payload !== null &&
          identifier(payload["requestId"]) &&
          isDomainError(payload["error"])
        );
      }
      case "ContextRedacted": {
        const payload = exactRecord(value, ["requestId", "transformationIds"]);
        return (
          payload !== null &&
          identifier(payload["requestId"]) &&
          stringArray(payload["transformationIds"])
        );
      }
      case "ActionProposed": {
        const payload = exactRecord(value, [
          "proposalId",
          "capabilityPackId",
          "capabilityPackVersion",
          "operationId",
          "operationVersion",
          "input",
        ]);
        return (
          payload !== null &&
          DriverProposalIdKind.is(payload["proposalId"]) &&
          identifier(payload["capabilityPackId"]) &&
          positiveInteger(payload["capabilityPackVersion"]) &&
          identifier(payload["operationId"]) &&
          positiveInteger(payload["operationVersion"]) &&
          isJsonObject(payload["input"])
        );
      }
      case "ActionNormalized": {
        const payload = exactRecord(value, ["action"]);
        return payload !== null && validateAction(payload["action"]);
      }
      case "PolicyEvaluated": {
        const payload = exactRecord(value, [
          "actionId",
          "policyVersionId",
          "decision",
          "trace",
        ]);
        return (
          payload !== null &&
          ActionIdKind.is(payload["actionId"]) &&
          PolicyVersionIdKind.is(payload["policyVersionId"]) &&
          oneOf(payload["decision"], ["allow", "deny", "require_approval"]) &&
          isJsonObject(payload["trace"])
        );
      }
      case "ActionDenied":
      case "ActionFailed": {
        const payload = exactRecord(value, ["actionId", "error"]);
        return (
          payload !== null &&
          ActionIdKind.is(payload["actionId"]) &&
          isDomainError(payload["error"])
        );
      }
      case "ActionStarted": {
        const payload = exactRecord(value, ["actionId", "startedAt"]);
        return (
          payload !== null &&
          ActionIdKind.is(payload["actionId"]) &&
          timestamp(payload["startedAt"])
        );
      }
      case "ActionSucceeded": {
        const payload = exactRecord(value, ["actionId", "completedAt"]);
        return (
          payload !== null &&
          ActionIdKind.is(payload["actionId"]) &&
          timestamp(payload["completedAt"])
        );
      }
      case "ActionReconciled": {
        const payload = exactRecord(value, ["actionId", "disposition", "evidence"]);
        return (
          payload !== null &&
          ActionIdKind.is(payload["actionId"]) &&
          oneOf(payload["disposition"], ["absent", "succeeded", "failed", "uncertain"]) &&
          isJsonObject(payload["evidence"])
        );
      }
      case "ObservationReleased": {
        const payload = exactRecord(value, ["observation"]);
        return payload !== null && validateObservation(payload["observation"]);
      }
      case "ApprovalRequested": {
        const payload = exactRecord(value, ["approvalId", "actionId", "preconditionHash"]);
        return (
          payload !== null &&
          ApprovalIdKind.is(payload["approvalId"]) &&
          ActionIdKind.is(payload["actionId"]) &&
          nonEmptyString(payload["preconditionHash"])
        );
      }
      case "ApprovalGranted": {
        const payload = exactRecord(value, ["approvalId", "grantedBy"]);
        return (
          payload !== null &&
          ApprovalIdKind.is(payload["approvalId"]) &&
          validateActor(payload["grantedBy"])
        );
      }
      case "ApprovalDenied": {
        const payload = exactRecord(value, ["approvalId", "deniedBy"]);
        return (
          payload !== null &&
          ApprovalIdKind.is(payload["approvalId"]) &&
          validateActor(payload["deniedBy"])
        );
      }
      case "ApprovalExpired": {
        const payload = exactRecord(value, ["approvalId"]);
        return payload !== null && ApprovalIdKind.is(payload["approvalId"]);
      }
      case "ApprovalInvalidated": {
        const payload = exactRecord(value, ["approvalId", "reason"]);
        return (
          payload !== null &&
          ApprovalIdKind.is(payload["approvalId"]) &&
          nonEmptyString(payload["reason"])
        );
      }
      case "ApprovalConsumed": {
        const payload = exactRecord(value, ["approvalId", "actionId"]);
        return (
          payload !== null &&
          ApprovalIdKind.is(payload["approvalId"]) &&
          ActionIdKind.is(payload["actionId"])
        );
      }
      case "OutcomeProposed": {
        const payload = exactRecord(value, ["outcome"]);
        return payload !== null && validateOutcome(payload["outcome"]);
      }
      case "OutcomeValidated": {
        const payload = exactRecord(value, ["outcomeId", "evidence", "validatedAt"]);
        return (
          payload !== null &&
          identifier(payload["outcomeId"]) &&
          validateEvidenceArray(payload["evidence"]) &&
          timestamp(payload["validatedAt"])
        );
      }
      case "ArtifactReferenced": {
        const payload = exactRecord(value, ["artifactId", "contentHash", "mediaType"]);
        return (
          payload !== null &&
          ArtifactIdKind.is(payload["artifactId"]) &&
          nonEmptyString(payload["contentHash"]) &&
          nonEmptyString(payload["mediaType"])
        );
      }
      case "RetryScheduled": {
        const payload = exactRecord(value, ["attemptType", "ordinal", "scheduledAt"]);
        return (
          payload !== null &&
          identifier(payload["attemptType"]) &&
          positiveInteger(payload["ordinal"]) &&
          timestamp(payload["scheduledAt"])
        );
      }
      case "BudgetExceeded": {
        const payload = exactRecord(value, ["budget", "consumed", "limit"]);
        return (
          payload !== null &&
          identifier(payload["budget"]) &&
          nonnegativeInteger(payload["consumed"]) &&
          nonnegativeInteger(payload["limit"])
        );
      }
      case "RecoveryStarted": {
        const payload = exactRecord(value, ["recoveryId", "startedAt"]);
        return (
          payload !== null &&
          identifier(payload["recoveryId"]) &&
          timestamp(payload["startedAt"])
        );
      }
      case "RecoveryCompleted": {
        const payload = exactRecord(value, ["recoveryId", "disposition"]);
        return (
          payload !== null &&
          identifier(payload["recoveryId"]) &&
          oneOf(payload["disposition"], ["recovered", "orphaned", "failed"])
        );
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export function validateActor(value: unknown): boolean {
  const actor = exactRecord(value, ["kind", "id"]);
  return (
    actor !== null &&
    typeof actor["kind"] === "string" &&
    ACTOR_KIND_SET.has(actor["kind"]) &&
    identifier(actor["id"])
  );
}

export function validateObjective(value: unknown): boolean {
  const objective = exactRecord(value, [
    "schemaVersion",
    "profileId",
    "profileVersion",
    "objectiveType",
    "objectiveTypeVersion",
    "payload",
    "submittedBy",
    "submittedAt",
  ]);
  return (
    objective !== null &&
    isContractSchemaVersion(objective["schemaVersion"]) &&
    identifier(objective["profileId"]) &&
    positiveInteger(objective["profileVersion"]) &&
    identifier(objective["objectiveType"]) &&
    positiveInteger(objective["objectiveTypeVersion"]) &&
    isJsonObject(objective["payload"]) &&
    validateActor(objective["submittedBy"]) &&
    timestamp(objective["submittedAt"])
  );
}

export function validateTaskProfile(value: unknown): boolean {
  const profile = exactRecord(value, [
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
  if (
    profile === null ||
    !isContractSchemaVersion(profile["schemaVersion"]) ||
    !identifier(profile["profileId"]) ||
    !positiveInteger(profile["profileVersion"]) ||
    !validateVersionedSchema(profile["objectiveSchema"]) ||
    !validateComponent(profile["driverProfile"], false) ||
    !validateModelBindings(profile["modelBindings"]) ||
    !validateNamedComponents(profile["contextSources"]) ||
    !validateNamedComponents(profile["capabilityPacks"]) ||
    !validateComponent(profile["policyProfile"], false) ||
    !validateVersionedSchema(profile["outcomeSchema"]) ||
    !validateBudget(profile["budgetPolicy"]) ||
    !oneOf(profile["evidenceMode"], ["durable_encrypted", "ephemeral_metadata"])
  ) {
    return false;
  }
  return (
    profile["evaluationProfile"] === null ||
    validateComponent(profile["evaluationProfile"], false)
  );
}

export function validateVersionedSchema(value: unknown): boolean {
  const schema = exactRecord(value, ["schemaId", "schemaVersion", "document"]);
  return (
    schema !== null &&
    identifier(schema["schemaId"]) &&
    positiveInteger(schema["schemaVersion"]) &&
    isJsonObject(schema["document"])
  );
}

function validateComponent(value: unknown, named: boolean): boolean {
  const keys = named
    ? ["bindingId", "componentId", "componentVersion", "configuration"]
    : ["componentId", "componentVersion", "configuration"];
  const component = exactRecord(value, keys);
  return (
    component !== null &&
    (!named || identifier(component["bindingId"])) &&
    identifier(component["componentId"]) &&
    positiveInteger(component["componentVersion"]) &&
    isJsonObject(component["configuration"])
  );
}

function validateNamedComponents(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const component of value) {
    if (!validateComponent(component, true)) return false;
    const record = component as RecordValue;
    const id = record["bindingId"] as string;
    if (ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

function validateModelBindings(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  let planners = 0;
  for (const item of value) {
    const binding = exactRecord(item, [
      "bindingId",
      "roleId",
      "authority",
      "modelProfileId",
      "modelProfileVersion",
      "mayProposeActions",
      "configuration",
    ]);
    if (
      binding === null ||
      !identifier(binding["bindingId"]) ||
      !identifier(binding["roleId"]) ||
      !identifier(binding["modelProfileId"]) ||
      !positiveInteger(binding["modelProfileVersion"]) ||
      typeof binding["mayProposeActions"] !== "boolean" ||
      !isJsonObject(binding["configuration"])
    ) {
      return false;
    }
    if (binding["authority"] === "planner") {
      planners += 1;
      if (binding["mayProposeActions"] !== true) return false;
    } else if (binding["authority"] === "auxiliary") {
      if (binding["mayProposeActions"] !== false) return false;
    } else {
      return false;
    }
    const id = binding["bindingId"] as string;
    if (ids.has(id)) return false;
    ids.add(id);
  }
  return planners <= 1;
}

function validateBudget(value: unknown): boolean {
  const budget = exactRecord(value, [
    "maxTurns",
    "maxActions",
    "maxElapsedMs",
    "maxInputBytes",
    "maxOutputBytes",
    "extensions",
  ]);
  return (
    budget !== null &&
    positiveInteger(budget["maxTurns"]) &&
    nonnegativeInteger(budget["maxActions"]) &&
    positiveInteger(budget["maxElapsedMs"]) &&
    positiveInteger(budget["maxInputBytes"]) &&
    positiveInteger(budget["maxOutputBytes"]) &&
    isJsonObject(budget["extensions"])
  );
}

export function validateResource(value: unknown): boolean {
  const resource = exactRecord(value, [
    "schemaVersion",
    "scheme",
    "sourceId",
    "locator",
    "mediaType",
    "classification",
  ]);
  return (
    resource !== null &&
    isContractSchemaVersion(resource["schemaVersion"]) &&
    identifier(resource["scheme"]) &&
    identifier(resource["sourceId"]) &&
    isJsonObject(resource["locator"]) &&
    (resource["mediaType"] === null || nonEmptyString(resource["mediaType"])) &&
    identifier(resource["classification"])
  );
}

function validateContentArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((block) => validateContentBlock(block));
}

export function validateContentBlock(value: unknown): boolean {
  const record = asRecord(value);
  if (record === null || typeof record["modality"] !== "string") return false;
  const common = [
    "schemaVersion",
    "blockId",
    "modality",
    "mediaType",
    "byteLength",
    "contentHash",
    "classification",
    "provenance",
    "retentionClass",
    "transformation",
  ];
  let specific: readonly string[];
  switch (record["modality"]) {
    case "text":
      specific = ["text", "encoding", "normalization"];
      break;
    case "json":
      specific = ["value", "jsonSchema"];
      break;
    case "image":
      specific = ["artifactId", "width", "height"];
      break;
    case "audio":
      specific = ["artifactId", "durationMs", "sampleRateHz", "channels"];
      break;
    case "document":
      specific = ["artifactId", "pageCount"];
      break;
    case "embedding":
      specific = ["vectorStoreId", "vectorId", "dimensions", "modelProfileId"];
      break;
    default:
      return false;
  }
  const block = exactRecord(record, [...common, ...specific]);
  if (
    block === null ||
    !isContractSchemaVersion(block["schemaVersion"]) ||
    !identifier(block["blockId"]) ||
    !nonEmptyString(block["mediaType"]) ||
    !nonnegativeInteger(block["byteLength"]) ||
    !nonEmptyString(block["contentHash"]) ||
    !identifier(block["classification"]) ||
    !validateProvenance(block["provenance"]) ||
    !identifier(block["retentionClass"]) ||
    !(block["transformation"] === null || validateTransformation(block["transformation"]))
  ) {
    return false;
  }
  switch (block["modality"]) {
    case "text":
      return (
        typeof block["text"] === "string" &&
        block["byteLength"] === Buffer.byteLength(block["text"], "utf8") &&
        block["encoding"] === "utf-8" &&
        oneOf(block["normalization"], ["none", "nfc", "nfkc"])
      );
    case "json":
      return (
        isJsonValue(block["value"]) &&
        block["byteLength"] === canonicalBytes(block["value"]).byteLength &&
        (block["jsonSchema"] === null || validateVersionedSchema(block["jsonSchema"]))
      );
    case "image":
      return (
        ArtifactIdKind.is(block["artifactId"]) &&
        positiveInteger(block["width"]) &&
        positiveInteger(block["height"])
      );
    case "audio":
      return (
        ArtifactIdKind.is(block["artifactId"]) &&
        nonnegativeInteger(block["durationMs"]) &&
        positiveInteger(block["sampleRateHz"]) &&
        positiveInteger(block["channels"])
      );
    case "document":
      return (
        ArtifactIdKind.is(block["artifactId"]) &&
        (block["pageCount"] === null || positiveInteger(block["pageCount"]))
      );
    case "embedding":
      return (
        identifier(block["vectorStoreId"]) &&
        identifier(block["vectorId"]) &&
        positiveInteger(block["dimensions"]) &&
        identifier(block["modelProfileId"])
      );
    default:
      return false;
  }
}

function validateProvenance(value: unknown): boolean {
  const provenance = exactRecord(value, ["source", "producer", "capturedAt"]);
  return (
    provenance !== null &&
    (provenance["source"] === null || validateResource(provenance["source"])) &&
    validateActor(provenance["producer"]) &&
    timestamp(provenance["capturedAt"])
  );
}

function validateTransformation(value: unknown): boolean {
  const transformation = exactRecord(value, [
    "schemaVersion",
    "transformationId",
    "transformationVersion",
    "inputContentHashes",
  ]);
  return (
    transformation !== null &&
    isContractSchemaVersion(transformation["schemaVersion"]) &&
    identifier(transformation["transformationId"]) &&
    positiveInteger(transformation["transformationVersion"]) &&
    stringArray(transformation["inputContentHashes"])
  );
}

export function validateAction(value: unknown): boolean {
  const action = exactRecord(value, [
    "schemaVersion",
    "actionId",
    "capabilityPackId",
    "capabilityPackVersion",
    "operationId",
    "operationVersion",
    "subject",
    "resource",
    "environment",
    "request",
    "normalizedInput",
    "sideEffectClass",
    "preconditions",
  ]);
  return (
    action !== null &&
    isContractSchemaVersion(action["schemaVersion"]) &&
    ActionIdKind.is(action["actionId"]) &&
    identifier(action["capabilityPackId"]) &&
    positiveInteger(action["capabilityPackVersion"]) &&
    identifier(action["operationId"]) &&
    positiveInteger(action["operationVersion"]) &&
    isJsonObject(action["subject"]) &&
    isJsonObject(action["resource"]) &&
    isJsonObject(action["environment"]) &&
    isJsonObject(action["request"]) &&
    isJsonObject(action["normalizedInput"]) &&
    typeof action["sideEffectClass"] === "string" &&
    SIDE_EFFECTS.has(action["sideEffectClass"]) &&
    Array.isArray(action["preconditions"]) &&
    action["preconditions"].every((item) => validatePrecondition(item))
  );
}

function validatePrecondition(value: unknown): boolean {
  const precondition = exactRecord(value, [
    "preconditionType",
    "preconditionVersion",
    "attributes",
  ]);
  return (
    precondition !== null &&
    identifier(precondition["preconditionType"]) &&
    positiveInteger(precondition["preconditionVersion"]) &&
    isJsonObject(precondition["attributes"])
  );
}

export function validateObservation(value: unknown): boolean {
  const observation = exactRecord(value, [
    "schemaVersion",
    "observationId",
    "actionId",
    "status",
    "audit",
    "human",
    "agent",
    "error",
    "occurredAt",
  ]);
  return (
    observation !== null &&
    isContractSchemaVersion(observation["schemaVersion"]) &&
    identifier(observation["observationId"]) &&
    ActionIdKind.is(observation["actionId"]) &&
    typeof observation["status"] === "string" &&
    OBSERVATION_STATUSES.has(observation["status"]) &&
    isJsonObject(observation["audit"]) &&
    validateContentArray(observation["human"]) &&
    validateContentArray(observation["agent"]) &&
    (observation["status"] === "succeeded"
      ? observation["error"] === null
      : isDomainError(observation["error"])) &&
    timestamp(observation["occurredAt"])
  );
}

export function validateOutcome(value: unknown): boolean {
  const outcome = exactRecord(value, [
    "schemaVersion",
    "outcomeId",
    "profileId",
    "profileVersion",
    "outcomeType",
    "outcomeTypeVersion",
    "payload",
    "evidence",
    "proposedAt",
  ]);
  return (
    outcome !== null &&
    isContractSchemaVersion(outcome["schemaVersion"]) &&
    identifier(outcome["outcomeId"]) &&
    identifier(outcome["profileId"]) &&
    positiveInteger(outcome["profileVersion"]) &&
    identifier(outcome["outcomeType"]) &&
    positiveInteger(outcome["outcomeTypeVersion"]) &&
    isJsonObject(outcome["payload"]) &&
    validateEvidenceArray(outcome["evidence"]) &&
    timestamp(outcome["proposedAt"])
  );
}

function validateEvidenceArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => validateEvidence(item));
}

function validateEvidence(value: unknown): boolean {
  const evidence = exactRecord(value, ["kind", "referenceId", "contentHash"]);
  return (
    evidence !== null &&
    typeof evidence["kind"] === "string" &&
    EVIDENCE_KINDS.has(evidence["kind"]) &&
    identifier(evidence["referenceId"]) &&
    (evidence["contentHash"] === null || nonEmptyString(evidence["contentHash"]))
  );
}

function validateCompletedResult(value: unknown): boolean {
  const result = terminalResult(value, ["outcome"]);
  return result !== null && result["status"] === "completed" && validateOutcome(result["outcome"]);
}

function validateFailedResult(value: unknown): boolean {
  const result = terminalResult(value, ["error"]);
  return result !== null && result["status"] === "failed" && isDomainError(result["error"]);
}

function validateOrphanedResult(value: unknown): boolean {
  const result = terminalResult(value, ["error"]);
  return result !== null && result["status"] === "orphaned" && isDomainError(result["error"]);
}

function validateCancelledResult(value: unknown): boolean {
  const result = terminalResult(value, ["reason"]);
  return result !== null && result["status"] === "cancelled" && nullableString(result["reason"]);
}

function terminalResult(value: unknown, specific: readonly string[]): RecordValue | null {
  const result = exactRecord(value, [
    "schemaVersion",
    "runId",
    "status",
    "finishedAt",
    ...specific,
  ]);
  if (
    result === null ||
    !isContractSchemaVersion(result["schemaVersion"]) ||
    !RunIdKind.is(result["runId"]) ||
    !timestamp(result["finishedAt"])
  ) {
    return null;
  }
  return result;
}

function exactRecord(value: unknown, expected: readonly string[]): RecordValue | null {
  const record = asRecord(value);
  if (record === null) return null;
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
    ? record
    : null;
}

function asRecord(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function positiveInteger(value: unknown): value is number {
  return isPositiveVersion(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value;
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => identifier(item));
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}
