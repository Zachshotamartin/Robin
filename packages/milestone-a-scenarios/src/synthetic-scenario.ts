import {
  ScriptedAgentDriver,
  type AgentTurnRequest,
  type ScriptedAgentDriverScript,
} from "@guard/agent-driver";
import {
  CapabilityGateway,
  CapabilityPackRegistry,
} from "@guard/capability-gateway";
import {
  SYNTHETIC_POLICY_SNAPSHOT,
  SYNTHETIC_TASK_PROFILE,
  SYNTHETIC_TRANSFORM_REFERENCE,
  createSyntheticContextSource,
  createSyntheticTransformPack,
} from "@guard/capability-synthetic";
import { ContextSourceRegistry } from "@guard/context-broker";
import {
  CONTRACT_SCHEMA_VERSION,
  canonicalSha256Hex,
  type ObjectiveEnvelope,
  type OutcomeEnvelope,
  type ResourceRef,
  type TaskProfile,
} from "@guard/contracts";
import { InMemoryEventStore } from "@guard/event-store";
import { createPinnedPolicyEvaluator } from "@guard/policy-engine";
import { InMemoryTaskProfileRegistry } from "@guard/profile-registry";
import {
  SynchronousRuntimeHost,
  type RuntimeContextPlanner,
} from "@guard/runtime-host";

import {
  FixedRuntimeHostIdFactory,
  SCENARIO_OCCURRED_AT,
  SCENARIO_RECORDED_AT,
  advertisedOperations,
  fixedActionId,
  fixedAttemptId,
  fixedContentBlockId,
  fixedObservationId,
  fixedOutcomeId,
  fixedProposalId,
  fixedRunId,
  immutable,
  jsonContentBlock,
  replayWithFailOnEffectPorts,
  successfulObservation,
  type ScenarioExecution,
} from "./scenario-support.js";

export const SYNTHETIC_SCENARIO_NAMESPACE = 1;

const SOURCE_TEXT = "  Guarded agents transform bounded data.  ";
const NORMALIZED_TEXT = SOURCE_TEXT.normalize("NFC").trim();
const TRANSFORMED_TEXT = NORMALIZED_TEXT.toUpperCase();

export interface SyntheticScenarioExecution extends ScenarioExecution {
  readonly objective: ObjectiveEnvelope;
  readonly outcome: OutcomeEnvelope;
  readonly expectedObservationId: string;
  readonly expectedContextBlockId: string;
}

/**
 * Runs the domain-neutral Milestone A slice without a model adapter, API key,
 * provider SDK, filesystem, or network. The scripted driver accepts only the
 * exact requests assembled below, so any transcript drift fails the run.
 */
export async function runSyntheticTransformScenario(): Promise<SyntheticScenarioExecution> {
  const namespace = SYNTHETIC_SCENARIO_NAMESPACE;
  const runId = fixedRunId(namespace);
  const actionId = fixedActionId(namespace, 1);
  const observationId = fixedObservationId(namespace, 1);
  const contextBlockId = fixedContentBlockId(namespace, 1);

  const objective: ObjectiveEnvelope = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    profileId: SYNTHETIC_TASK_PROFILE.profileId,
    profileVersion: SYNTHETIC_TASK_PROFILE.profileVersion,
    objectiveType: "synthetic.transform",
    objectiveTypeVersion: 1,
    payload: { recordId: "greeting", mode: "uppercase" },
    submittedBy: { kind: "user", id: "milestone-a-fixture" },
    submittedAt: SCENARIO_OCCURRED_AT,
  });

  const sourceResource: ResourceRef = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scheme: "memory",
    sourceId: "synthetic:transform-input",
    locator: { recordId: "greeting" },
    mediaType: "application/json",
    classification: "synthetic",
  });
  const expectedContext = jsonContentBlock({
    namespace,
    ordinal: 1,
    value: { text: SOURCE_TEXT },
    source: sourceResource,
    producerKind: "context_source",
    producerId: "synthetic:transform-input",
    classification: "synthetic",
  });
  if (expectedContext.blockId !== contextBlockId) {
    throw new Error("Synthetic fixture context-block identity drifted.");
  }

  const inputBytes = Buffer.byteLength(NORMALIZED_TEXT, "utf8");
  const outputBytes = Buffer.byteLength(TRANSFORMED_TEXT, "utf8");
  const expectedObservation = successfulObservation({
    namespace,
    observationOrdinal: 1,
    actionOrdinal: 1,
    firstBlockOrdinal: 2,
    capabilityPackId: SYNTHETIC_TRANSFORM_REFERENCE.packId,
    audit: { inputBytes, mode: "uppercase", outputBytes },
    human: {
      summary: `Transformed ${String(inputBytes)} bytes into ${String(outputBytes)} bytes.`,
    },
    agent: { transformed: TRANSFORMED_TEXT },
  });

  const outcome: OutcomeEnvelope = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    outcomeId: fixedOutcomeId(namespace),
    profileId: SYNTHETIC_TASK_PROFILE.profileId,
    profileVersion: SYNTHETIC_TASK_PROFILE.profileVersion,
    outcomeType: "synthetic.transform.completed",
    outcomeTypeVersion: 1,
    payload: { transformed: TRANSFORMED_TEXT },
    evidence: [
      {
        kind: "observation",
        referenceId: observationId,
        contentHash: canonicalSha256Hex(expectedObservation),
      },
    ],
    proposedAt: SCENARIO_OCCURRED_AT,
  });

  const packRegistry = new CapabilityPackRegistry([createSyntheticTransformPack()]);
  const advertised = advertisedOperations(packRegistry, [
    SYNTHETIC_TRANSFORM_REFERENCE,
  ]);
  const expectedTranscript: readonly AgentTurnRequest[] = immutable([
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      runId,
      attemptId: fixedAttemptId(namespace, 1),
      turnNumber: 1,
      objective,
      advertisedOperations: advertised,
      context: [expectedContext],
      observations: [],
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      runId,
      attemptId: fixedAttemptId(namespace, 2),
      turnNumber: 2,
      objective,
      advertisedOperations: advertised,
      context: [expectedContext],
      observations: [expectedObservation],
    },
  ]);

  const script: ScriptedAgentDriverScript = immutable({
    scriptId: "synthetic-transform-golden",
    turns: [
      {
        expectedRequest: expectedTranscript[0]!,
        events: [
          {
            type: "action_proposed",
            proposalId: fixedProposalId(namespace, 1),
            capabilityPackId: SYNTHETIC_TRANSFORM_REFERENCE.packId,
            capabilityPackVersion: SYNTHETIC_TRANSFORM_REFERENCE.packVersion,
            operationId: SYNTHETIC_TRANSFORM_REFERENCE.operationId,
            operationVersion: SYNTHETIC_TRANSFORM_REFERENCE.operationVersion,
            input: { text: NORMALIZED_TEXT, mode: "uppercase" },
          },
          { type: "usage_reported", dimensions: { inputTokens: 12, outputTokens: 4 } },
          { type: "completed" },
        ],
      },
      {
        expectedRequest: expectedTranscript[1]!,
        events: [
          { type: "outcome_proposed", outcome },
          { type: "usage_reported", dimensions: { inputTokens: 8, outputTokens: 3 } },
          { type: "completed" },
        ],
      },
    ],
  });
  const driver = new ScriptedAgentDriver(script);
  const source = createSyntheticContextSource();
  const profileRegistry = new InMemoryTaskProfileRegistry();
  profileRegistry.register(SYNTHETIC_TASK_PROFILE);
  const eventStore = new InMemoryEventStore({ now: () => SCENARIO_RECORDED_AT });
  const gateway = new CapabilityGateway(
    packRegistry,
    createPinnedPolicyEvaluator(SYNTHETIC_POLICY_SNAPSHOT, {
      secretCorrelationToken: "synthetic-scenario-policy-token-0001",
    }),
  );
  const contextPlanner: RuntimeContextPlanner = Object.freeze({
    plan({ objective: plannedObjective }: {
      readonly objective: ObjectiveEnvelope;
      readonly taskProfile: TaskProfile;
    }) {
      return [
        {
          bindingId: "transform-input",
          input: { recordId: plannedObjective.payload["recordId"]! },
          budget: { maximumItems: 1, maximumBytes: 256 },
        },
      ];
    },
  });
  const host = new SynchronousRuntimeHost({
    eventStore,
    profileRegistry,
    installedDriver: {
      componentId: "scripted",
      componentVersion: 1,
      driver,
    },
    contextSources: new ContextSourceRegistry([source]),
    capabilityPacks: packRegistry,
    capabilityGateway: gateway,
    contextPlanner,
    installedPolicy: {
      componentId: "synthetic-safe-default",
      componentVersion: 1,
      snapshot: SYNTHETIC_POLICY_SNAPSHOT,
    },
    normalizationSubject: {
      kind: "scripted",
      driverId: "driver:milestone-a-synthetic",
    },
    normalizationEnvironment: {
      profileId: SYNTHETIC_TASK_PROFILE.profileId,
      sandboxed: true,
      networkProfile: "disabled",
      trustLevel: "trusted_fixture",
    },
    clock: Object.freeze({ now: () => SCENARIO_OCCURRED_AT }),
    ids: new FixedRuntimeHostIdFactory(namespace),
  });

  const execution = await host.run(objective);
  driver.assertExhausted();
  const failClosedReplay = await replayWithFailOnEffectPorts(eventStore, runId);

  return Object.freeze({
    objective,
    outcome,
    execution,
    replay: failClosedReplay.replay,
    expectedTranscript,
    replayEffectCalls: failClosedReplay.effectCalls,
    expectedObservationId: observationId,
    expectedContextBlockId: contextBlockId,
  });
}
