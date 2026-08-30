import {
  AgentAttemptIdKind,
  ArtifactIdKind,
  EventIdKind,
  RunIdKind,
} from "@guard/contracts";
import type {
  ActorIdentity,
  CompletedRunResult,
  GenericEventEnvelope,
  GenericEventPayloadMap,
  GenericEventType,
  ObjectiveEnvelope,
  OutcomeEnvelope,
  TaskProfile,
} from "@guard/contracts";

export const GOLDEN_RUN_ID = RunIdKind.parse(
  "run_018f0000-0000-7000-8000-000000000001"
);

export const GOLDEN_ACTOR: ActorIdentity = Object.freeze({
  kind: "runtime",
  id: "runtime:golden",
});

export const GOLDEN_OBJECTIVE: ObjectiveEnvelope = Object.freeze({
  schemaVersion: 1,
  profileId: "profile:golden",
  profileVersion: 1,
  objectiveType: "synthetic.transform",
  objectiveTypeVersion: 1,
  payload: Object.freeze({ input: "alpha" }),
  submittedBy: Object.freeze({ kind: "user", id: "user:golden" }),
  submittedAt: "2026-08-30T10:00:00.000Z",
});

export const GOLDEN_PROFILE: TaskProfile = Object.freeze({
  schemaVersion: 1,
  profileId: "profile:golden",
  profileVersion: 1,
  objectiveSchema: Object.freeze({
    schemaId: "schema:objective",
    schemaVersion: 1,
    document: Object.freeze({ type: "object" }),
  }),
  driverProfile: Object.freeze({
    componentId: "driver:scripted",
    componentVersion: 1,
    configuration: Object.freeze({}),
  }),
  modelBindings: Object.freeze([]),
  contextSources: Object.freeze([]),
  capabilityPacks: Object.freeze([Object.freeze({
    bindingId: "transform",
    componentId: "synthetic.transform",
    componentVersion: 1,
    configuration: Object.freeze({}),
  })]),
  policyProfile: Object.freeze({
    componentId: "policy:synthetic",
    componentVersion: 1,
    configuration: Object.freeze({}),
  }),
  outcomeSchema: Object.freeze({
    schemaId: "schema:outcome",
    schemaVersion: 1,
    document: Object.freeze({ type: "object" }),
  }),
  budgetPolicy: Object.freeze({
    maxTurns: 3,
    maxActions: 2,
    maxElapsedMs: 60_000,
    maxInputBytes: 10_000,
    maxOutputBytes: 10_000,
    extensions: Object.freeze({}),
  }),
  evidenceMode: "ephemeral_metadata",
  evaluationProfile: null,
});

export const GOLDEN_OUTCOME: OutcomeEnvelope = Object.freeze({
  schemaVersion: 1,
  outcomeId: "outcome:golden",
  profileId: GOLDEN_PROFILE.profileId,
  profileVersion: GOLDEN_PROFILE.profileVersion,
  outcomeType: "synthetic.result",
  outcomeTypeVersion: 1,
  payload: Object.freeze({ answer: "alpha transformed" }),
  evidence: Object.freeze([]),
  proposedAt: "2026-08-30T10:00:07.000Z",
});

export const GOLDEN_RESULT: CompletedRunResult = Object.freeze({
  schemaVersion: 1,
  runId: GOLDEN_RUN_ID,
  status: "completed",
  finishedAt: "2026-08-30T10:00:10.000Z",
  outcome: GOLDEN_OUTCOME,
});

function event<TType extends GenericEventType>(
  streamVersion: number,
  eventType: TType,
  payload: GenericEventPayloadMap[TType]
): GenericEventEnvelope {
  const suffix = streamVersion.toString(16).padStart(12, "0");
  const instant = new Date(Date.UTC(2026, 7, 30, 10, 0, streamVersion));
  return {
    eventId: EventIdKind.parse(`evt_018f0000-0000-7000-8000-${suffix}`),
    streamId: GOLDEN_RUN_ID,
    streamVersion,
    eventType,
    eventSchemaVersion: 1,
    occurredAt: instant.toISOString(),
    recordedAt: instant.toISOString(),
    actor: GOLDEN_ACTOR,
    correlationId: "correlation:golden",
    causationId: null,
    payload,
  } as GenericEventEnvelope;
}

export const GOLDEN_HISTORY: readonly GenericEventEnvelope[] = Object.freeze([
  event(1, "RunCreated", { objective: GOLDEN_OBJECTIVE }),
  event(2, "TaskProfilePinned", { taskProfile: GOLDEN_PROFILE }),
  event(3, "RunStarted", { startedAt: "2026-08-30T10:00:03.000Z" }),
  event(4, "AgentDriverStarted", {
    driverProfileId: "driver:scripted",
    driverProfileVersion: 1,
    driverFingerprint: "sha256:golden-driver",
  }),
  event(5, "AgentAttemptStarted", {
    attemptId: AgentAttemptIdKind.parse(
      "att_018f0000-0000-7000-8000-000000000101"
    ),
    turn: 1,
  }),
  event(6, "AgentUsageRecorded", {
    attemptId: AgentAttemptIdKind.parse(
      "att_018f0000-0000-7000-8000-000000000101"
    ),
    usage: { inputBytes: 120, outputBytes: 48, inputTokens: 30, outputTokens: 12 },
  }),
  event(7, "OutcomeProposed", { outcome: GOLDEN_OUTCOME }),
  event(8, "OutcomeValidated", {
    outcomeId: GOLDEN_OUTCOME.outcomeId,
    evidence: GOLDEN_OUTCOME.evidence,
    validatedAt: "2026-08-30T10:00:08.000Z",
  }),
  event(9, "ArtifactReferenced", {
    artifactId: ArtifactIdKind.parse(
      "art_018f0000-0000-7000-8000-000000000201"
    ),
    contentHash: "sha256:golden-outcome",
    mediaType: "application/json",
  }),
  event(10, "RunCompleted", { result: GOLDEN_RESULT }),
]);
