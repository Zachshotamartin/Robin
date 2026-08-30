import {
  ScriptedAgentDriver,
  type AgentTurnRequest,
  type ScriptedAgentDriverScript,
} from "@guard/agent-driver";
import {
  CapabilityGateway,
  CapabilityPackRegistry,
  type CapabilityExecutionResult,
} from "@guard/capability-gateway";
import {
  SYNTHETIC_POLICY_SNAPSHOT,
  SYNTHETIC_TASK_PROFILE,
  SYNTHETIC_TRANSFORM_REFERENCE,
  createSyntheticBrokerContextSource,
  createSyntheticTransformPack,
} from "@guard/capability-synthetic";
import {
  BrokerContextSourceRegistry,
  CONTEXT_POLICY_ATTRIBUTE_CATALOG,
  MEMORY_POLICY_ATTRIBUTE_CATALOG,
  createContextBrokerIntegrationFactory,
  createContextReleasePolicySnapshot,
  createPinnedContextPolicyAdapter,
  type ContextBrokerConfigurationDescriptor,
  type ContextBrokerIntegration,
} from "@guard/context-broker";
import {
  CONTRACT_SCHEMA_VERSION,
  canonicalSha256Hex,
  type JsonObject,
  type ObjectiveEnvelope,
  type OutcomeEnvelope,
  type TaskProfile,
} from "@guard/contracts";
import { InMemoryEventStore } from "@guard/event-store";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshotSet,
  composePolicyAttributeCatalogs,
  createPinnedPolicyEvaluator,
  createPolicySnapshotManifest,
  type PolicySnapshot,
} from "@guard/policy-engine";
import { InMemoryTaskProfileRegistry } from "@guard/profile-registry";
import {
  SynchronousRuntimeHost,
  type RuntimeContextPlanner,
} from "@guard/runtime-host";

import {
  FixedRuntimeHostIdFactory,
  ROOT_CONTEXT_POLICY_SOURCE,
  SCENARIO_OCCURRED_AT,
  SCENARIO_RECORDED_AT,
  advertisedOperations,
  brokerJsonContentBlock,
  fixedActionId,
  fixedAttemptId,
  fixedObservationId,
  fixedOutcomeId,
  fixedPolicyVersionId,
  fixedProposalId,
  fixedRunId,
  immutable,
  replayWithFailOnEffectPorts,
  successfulBrokeredObservation,
  type ScenarioExecution,
} from "./scenario-support.js";

export const SYNTHETIC_SCENARIO_NAMESPACE = 1;

const SOURCE_TEXT = "  Guarded agents transform bounded data.  ";
const NORMALIZED_TEXT = SOURCE_TEXT.normalize("NFC").trim();
const TRANSFORMED_TEXT = NORMALIZED_TEXT.toUpperCase();
const SYNTHETIC_CONTEXT_POLICY_SNAPSHOT = compileSyntheticContextPolicy();
const SYNTHETIC_RELEASE_POLICY = createContextReleasePolicySnapshot({
  releasePolicyId: "milestone-a.synthetic-context",
  releasePolicyVersion: 1,
  secretDisposition: "deny",
  promptInjectionDisposition: "tag",
  truncatedDisposition: "deny",
});
const BROKER_BUDGETS = Object.freeze({
  maximumResourceBytes: 8_192,
  maximumRequestBytes: 8_192,
  maximumItemsPerTurn: 4,
  maximumBytesPerTurn: 8_192,
  maximumItemsPerRun: 8,
  maximumBytesPerRun: 16_384,
  maximumControlCharacterRatio: 0.05,
});

export interface SyntheticScenarioExecution extends ScenarioExecution {
  readonly objective: ObjectiveEnvelope;
  readonly outcome: OutcomeEnvelope;
  readonly profile: TaskProfile;
  readonly expectedObservationId: string;
  readonly expectedContextBlockId: string;
}

/**
 * Runs the domain-neutral slice through the broker-native source and release
 * paths. A separate preview broker constructs the exact expected driver
 * transcript; the live runtime owns a different broker instance with the same
 * immutable configuration pins.
 */
export async function runSyntheticTransformScenario(): Promise<SyntheticScenarioExecution> {
  const namespace = SYNTHETIC_SCENARIO_NAMESPACE;
  const runId = fixedRunId(namespace);
  const firstAttemptId = fixedAttemptId(namespace, 1);
  const secondAttemptId = fixedAttemptId(namespace, 2);
  const source = createSyntheticBrokerContextSource();
  const sourceRegistry = new BrokerContextSourceRegistry([source]);
  const evaluator = createPinnedPolicyEvaluator(
    SYNTHETIC_CONTEXT_POLICY_SNAPSHOT,
    { secretCorrelationToken: "synthetic-scenario-policy-token-0001" },
  );
  const policyAdapter = createPinnedContextPolicyAdapter({
    evaluator,
    releasePolicy: SYNTHETIC_RELEASE_POLICY,
  });
  const factoryOptions = {
    policySnapshotId: SYNTHETIC_CONTEXT_POLICY_SNAPSHOT.policyVersionId,
    releasePolicy: SYNTHETIC_RELEASE_POLICY,
    sources: sourceRegistry,
    policy: policyAdapter,
    budgets: BROKER_BUDGETS,
  } as const;
  const liveBrokerFactory = createContextBrokerIntegrationFactory(factoryOptions);
  const previewBroker = createContextBrokerIntegrationFactory(
    factoryOptions,
  ).createForRun({ runId });
  const profile = syntheticProfile(liveBrokerFactory.configurationDescriptor);

  const objective: ObjectiveEnvelope = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    objectiveType: "synthetic.transform",
    objectiveTypeVersion: 1,
    payload: { recordId: "greeting", mode: "uppercase" },
    submittedBy: { kind: "user", id: "milestone-a-fixture" },
    submittedAt: SCENARIO_OCCURRED_AT,
  });

  const packRegistry = new CapabilityPackRegistry([createSyntheticTransformPack()]);
  const gateway = new CapabilityGateway(packRegistry, evaluator);
  const advertised = advertisedOperations(packRegistry, [
    SYNTHETIC_TRANSFORM_REFERENCE,
  ]);
  const gatewayAdvertisement = packRegistry.createAdvertisement([
    SYNTHETIC_TRANSFORM_REFERENCE,
  ]);

  const sourceRelease = await previewBroker.releasePlannedSource({
    turnId: firstAttemptId,
    sourceId: source.descriptor.sourceId,
    sourceVersion: source.descriptor.sourceVersion,
    request: { recordId: "greeting" },
    maximumBytes: 2_048,
    reason: "runtime.context.planned",
    signal: new AbortController().signal,
  });
  if (sourceRelease.status !== "released") {
    throw new Error(
      `The synthetic preview source was denied unexpectedly: ${sourceRelease.manifest.reason}.`,
      { cause: sourceRelease.error },
    );
  }
  const sourceBlock = brokerJsonContentBlock(
    sourceRelease.item,
    sourceRelease.manifest,
  );
  await previewBroker.assembleAgentContext({
    turnId: firstAttemptId,
    agentRequestId: firstAttemptId,
    orderedItemIds: [sourceRelease.item.itemId],
  });

  const executionResult = await executePreviewTransform(
    gateway,
    gatewayAdvertisement,
  );
  const outputRelease = await releasePreviewCapabilityOutput(
    previewBroker,
    secondAttemptId,
    executionResult,
  );
  const outputBlock = brokerJsonContentBlock(
    outputRelease.item,
    outputRelease.manifest,
  );
  await previewBroker.assembleAgentContext({
    turnId: secondAttemptId,
    agentRequestId: secondAttemptId,
    orderedItemIds: [sourceRelease.item.itemId, outputRelease.item.itemId],
  });

  const expectedObservation = successfulBrokeredObservation({
    namespace,
    observationOrdinal: 1,
    actionOrdinal: 1,
    humanBlockOrdinal: 1,
    capabilityPackId: SYNTHETIC_TRANSFORM_REFERENCE.packId,
    audit: executionResult.audit,
    human: executionResult.human,
    agentContent: [outputBlock],
  });
  const outcome: OutcomeEnvelope = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    outcomeId: fixedOutcomeId(namespace),
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    outcomeType: "synthetic.transform.completed",
    outcomeTypeVersion: 1,
    payload: { transformed: TRANSFORMED_TEXT },
    evidence: [
      {
        kind: "observation",
        referenceId: fixedObservationId(namespace, 1),
        contentHash: canonicalSha256Hex(expectedObservation.eventObservation),
      },
    ],
    proposedAt: SCENARIO_OCCURRED_AT,
  });

  const expectedTranscript: readonly AgentTurnRequest[] = immutable([
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      runId,
      attemptId: firstAttemptId,
      turnNumber: 1,
      objective,
      advertisedOperations: advertised,
      context: [sourceBlock],
      observations: [],
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      runId,
      attemptId: secondAttemptId,
      turnNumber: 2,
      objective,
      advertisedOperations: advertised,
      context: [sourceBlock],
      observations: [expectedObservation.agentObservation],
    },
  ]);
  const script: ScriptedAgentDriverScript = immutable({
    scriptId: "synthetic-transform-broker-current",
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
  const profileRegistry = new InMemoryTaskProfileRegistry();
  profileRegistry.register(profile);
  const eventStore = new InMemoryEventStore({ now: () => SCENARIO_RECORDED_AT });
  const contextPlanner: RuntimeContextPlanner = Object.freeze({
    plan({ objective: plannedObjective }: {
      readonly objective: ObjectiveEnvelope;
      readonly taskProfile: TaskProfile;
    }) {
      return [
        {
          bindingId: "transform-input",
          input: { recordId: plannedObjective.payload["recordId"]! },
          budget: { maximumItems: 1, maximumBytes: 2_048 },
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
    contextBrokerFactory: liveBrokerFactory,
    capabilityPacks: packRegistry,
    capabilityGateway: gateway,
    contextPlanner,
    installedPolicy: {
      componentId: "synthetic-safe-default",
      componentVersion: 2,
      snapshot: SYNTHETIC_CONTEXT_POLICY_SNAPSHOT,
    },
    normalizationSubject: {
      kind: "scripted",
      driverId: "driver:milestone-a-synthetic",
    },
    normalizationEnvironment: {
      profileId: profile.profileId,
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
    profile,
    execution,
    replay: failClosedReplay.replay,
    expectedTranscript,
    replayEffectCalls: failClosedReplay.effectCalls,
    expectedObservationId: fixedObservationId(namespace, 1),
    expectedContextBlockId: sourceBlock.blockId,
  });
}

function syntheticProfile(
  contextBroker: ContextBrokerConfigurationDescriptor,
): TaskProfile {
  return immutable({
    ...SYNTHETIC_TASK_PROFILE,
    profileVersion: 2,
    driverProfile: {
      ...SYNTHETIC_TASK_PROFILE.driverProfile,
      configuration: { scriptId: "synthetic-transform-broker-current" },
    },
    contextSources: [
      {
        bindingId: "transform-input",
        componentId: "synthetic:transform-input",
        componentVersion: 2,
        configuration: { maximumBytes: 2_048 },
      },
    ],
    policyProfile: {
      componentId: "synthetic-safe-default",
      componentVersion: 2,
      configuration: createPolicySnapshotManifest(
        SYNTHETIC_CONTEXT_POLICY_SNAPSHOT,
      ),
    },
    budgetPolicy: {
      ...SYNTHETIC_TASK_PROFILE.budgetPolicy,
      maxInputBytes: 16_384,
      maxOutputBytes: 4_096,
      extensions: {
        contextBroker: contextBroker as unknown as JsonObject,
      },
    },
  });
}

async function executePreviewTransform(
  gateway: CapabilityGateway,
  advertisement: ReturnType<CapabilityPackRegistry["createAdvertisement"]>,
): Promise<CapabilityExecutionResult> {
  const prepared = await gateway.normalize(
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      ...SYNTHETIC_TRANSFORM_REFERENCE,
      input: { text: NORMALIZED_TEXT, mode: "uppercase" },
    },
    {
      actionId: fixedActionId(SYNTHETIC_SCENARIO_NAMESPACE, 1),
      subject: {
        kind: "scripted",
        driverId: "driver:milestone-a-synthetic",
      },
      environment: {
        profileId: SYNTHETIC_TASK_PROFILE.profileId,
        sandboxed: true,
        networkProfile: "disabled",
        trustLevel: "trusted_fixture",
      },
    },
    advertisement,
  );
  return gateway.execute(gateway.evaluate(prepared), {
    signal: new AbortController().signal,
  });
}

async function releasePreviewCapabilityOutput(
  broker: ContextBrokerIntegration,
  turnId: string,
  result: CapabilityExecutionResult,
) {
  const release = await broker.releaseCapabilityAgentView({
    turnId,
    sourceVersion: result.agentContextRelease.sourceVersion,
    resource: result.agentContextRelease.resource,
    policyProjection: result.agentContextRelease.policyProjection,
    output: result.agent,
    classification: result.agentContextRelease.classification,
    reason: result.agentContextRelease.reason,
  });
  if (release.status !== "released") {
    throw new Error("The synthetic preview capability output was denied unexpectedly.");
  }
  return release;
}

function compileSyntheticContextPolicy(): PolicySnapshot {
  const catalogs = composePolicyAttributeCatalogs([
    BASE_POLICY_ATTRIBUTE_CATALOG,
    CONTEXT_POLICY_ATTRIBUTE_CATALOG,
    MEMORY_POLICY_ATTRIBUTE_CATALOG,
  ]);
  const result = compilePolicySnapshotSet(
    {
      policyVersionId: fixedPolicyVersionId(0xb101),
      sources: [
        ...SYNTHETIC_POLICY_SNAPSHOT.sources.map((source) => ({
          sourceId: source.sourceId,
          source: source.canonicalText,
        })),
        {
          sourceId: "policies/context.guard",
          source: ROOT_CONTEXT_POLICY_SOURCE,
        },
      ],
      defaultEffect: "deny",
    },
    {},
    catalogs,
  );
  if (!result.ok) {
    throw new Error(
      `The synthetic broker policy did not compile: ${JSON.stringify(
        result.diagnostics,
      )}`,
    );
  }
  return result.snapshot;
}
