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
} from "@guard/context-broker";
import {
  CONTRACT_SCHEMA_VERSION,
  canonicalSha256Hex,
  canonicalize,
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
  countBrokerSourceEffects,
  countCapabilityPackEffects,
  createScenarioLiveEffectCalls,
  deterministicBrokerJsonContentBlock,
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
 * paths. An effect-free oracle constructs the exact expected serialized
 * transcript; only the event-ledger host run may invoke live ports.
 */
export async function runSyntheticTransformScenario(): Promise<SyntheticScenarioExecution> {
  const namespace = SYNTHETIC_SCENARIO_NAMESPACE;
  const runId = fixedRunId(namespace);
  const firstAttemptId = fixedAttemptId(namespace, 1);
  const secondAttemptId = fixedAttemptId(namespace, 2);
  const liveEffectCalls = createScenarioLiveEffectCalls();
  const source = countBrokerSourceEffects(
    createSyntheticBrokerContextSource(),
    liveEffectCalls,
  );
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

  const packRegistry = new CapabilityPackRegistry([
    countCapabilityPackEffects(createSyntheticTransformPack(), liveEffectCalls),
  ]);
  const gateway = new CapabilityGateway(packRegistry, evaluator);
  const advertised = advertisedOperations(packRegistry, [
    SYNTHETIC_TRANSFORM_REFERENCE,
  ]);

  // This oracle is intentionally pure: it derives the exact serialized broker
  // contract without invoking the live source, gateway, pack, or broker.
  const sourceResource = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scheme: "memory",
    sourceId: "synthetic:transform-input",
    locator: { recordId: "greeting" },
    mediaType: "application/json",
    classification: "synthetic",
  });
  const sourceBlock = deterministicBrokerJsonContentBlock({
    runId,
    releaseOrdinal: 1,
    resource: sourceResource,
    mediaType: "application/json",
    classification: "synthetic",
    producerKind: "context_source",
    value: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "source_context",
      untrusted: true,
      trustLabel: "untrusted_source_content",
      resource: sourceResource,
      selector: null,
      provenance: {
        sourceId: "synthetic:transform-input",
        sourceVersion: 2,
        classification: "synthetic",
        policyCatalogId: MEMORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
        policyCatalogVersion: MEMORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
        policyCatalogContentHash: MEMORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
      },
      content: canonicalize({ text: SOURCE_TEXT }),
    },
  });
  const outputRecordId = `transform:${fixedActionId(namespace, 1)}`;
  const outputResource = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scheme: "memory",
    sourceId: "synthetic:transform-input",
    locator: { recordId: outputRecordId },
    mediaType: "application/json",
    classification: "synthetic",
  });
  const outputBlock = deterministicBrokerJsonContentBlock({
    runId,
    releaseOrdinal: 2,
    resource: outputResource,
    mediaType: "application/json",
    classification: "synthetic",
    producerKind: "capability_worker",
    value: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "capability_output",
      untrusted: true,
      trustLabel: "untrusted_capability_output",
      resource: outputResource,
      provenance: {
        sourceId: "synthetic:transform-input",
        sourceVersion: SYNTHETIC_TRANSFORM_REFERENCE.operationVersion,
        classification: "synthetic",
        policyCatalogId: MEMORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
        policyCatalogVersion: MEMORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
        policyCatalogContentHash: MEMORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
      },
      output: { transformed: TRANSFORMED_TEXT },
    },
  });
  const inputBytes = Buffer.byteLength(NORMALIZED_TEXT, "utf8");
  const outputBytes = Buffer.byteLength(TRANSFORMED_TEXT, "utf8");

  const expectedObservation = successfulBrokeredObservation({
    namespace,
    observationOrdinal: 1,
    actionOrdinal: 1,
    humanBlockOrdinal: 1,
    capabilityPackId: SYNTHETIC_TRANSFORM_REFERENCE.packId,
    audit: { inputBytes, mode: "uppercase", outputBytes },
    human: {
      summary: `Transformed ${String(inputBytes)} bytes into ${String(
        outputBytes,
      )} bytes.`,
    },
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

  assertNoLiveEffects(liveEffectCalls);
  const execution = await host.run(objective);
  driver.assertExhausted();
  assertLiveEffects(liveEffectCalls, {
    sourceNormalize: 1,
    sourceInspect: 1,
    sourceOpen: 1,
    capabilityNormalize: 1,
    capabilityExecute: 1,
    capabilityRelease: 1,
    repositoryList: 0,
    repositoryRead: 0,
  });
  const failClosedReplay = await replayWithFailOnEffectPorts(eventStore, runId);

  return Object.freeze({
    objective,
    outcome,
    profile,
    execution,
    replay: failClosedReplay.replay,
    expectedTranscript,
    liveEffectCalls: immutable(liveEffectCalls),
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

function assertNoLiveEffects(calls: ReturnType<typeof createScenarioLiveEffectCalls>): void {
  if (Object.values(calls).some((count) => count !== 0)) {
    throw new Error("Synthetic live effects occurred before the recorded host run.");
  }
}

function assertLiveEffects(
  calls: ReturnType<typeof createScenarioLiveEffectCalls>,
  expected: ReturnType<typeof createScenarioLiveEffectCalls>,
): void {
  if (canonicalSha256Hex(calls) !== canonicalSha256Hex(expected)) {
    throw new Error("Synthetic live effect counts diverged from the event-ledger flow.");
  }
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
