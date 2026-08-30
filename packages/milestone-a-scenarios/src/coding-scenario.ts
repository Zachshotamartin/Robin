import {
  ScriptedAgentDriver,
  type AgentObservation,
  type AgentTurnRequest,
  type ScriptedAgentDriverScript,
} from "@guard/agent-driver";
import {
  CapabilityGateway,
  CapabilityPackRegistry,
  type CapabilityAdvertisement,
  type CapabilityExecutionResult,
  type CapabilityOperationReference,
} from "@guard/capability-gateway";
import {
  REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
  VIRTUAL_REPOSITORY_REFERENCES,
  VirtualRepository,
  createVirtualRepositoryPack,
} from "@guard/capability-repository";
import {
  BrokerContextSourceRegistry,
  CONTEXT_POLICY_ATTRIBUTE_CATALOG,
  createContextBrokerIntegrationFactory,
  createContextReleasePolicySnapshot,
  createPinnedContextPolicyAdapter,
  type ContextBrokerIntegration,
} from "@guard/context-broker";
import {
  CONTRACT_SCHEMA_VERSION,
  canonicalSha256Hex,
  sha256Hex,
  type JsonObject,
  type ObjectiveEnvelope,
  type Observation,
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
  type PinnedPolicyEvaluator,
  type PolicySnapshot,
} from "@guard/policy-engine";
import { InMemoryTaskProfileRegistry } from "@guard/profile-registry";
import { SynchronousRuntimeHost } from "@guard/runtime-host";

import {
  FixedRuntimeHostIdFactory,
  REPOSITORY_CONTEXT_POLICY_SOURCE,
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

export const CODING_SCENARIO_NAMESPACE = 2;

const CODING_POLICY_SOURCE = `policy "allow-virtual-repository-operations" priority 100 {
  when action.pack == "coding.virtual-repository"
    and action.operation in ["list_files", "read_file", "propose_patch"]
    and action.side_effect == "none"
  allow
  reason "The virtual repository operations are bounded and effect-free."
}
`;

const CODING_VIRTUAL_POLICY_SNAPSHOT = compileCodingPolicy();
const CODING_RELEASE_POLICY = createContextReleasePolicySnapshot({
  releasePolicyId: "milestone-a.coding-context",
  releasePolicyVersion: 1,
  secretDisposition: "deny",
  promptInjectionDisposition: "tag",
  truncatedDisposition: "deny",
});
const CODING_BROKER_BUDGETS = Object.freeze({
  maximumResourceBytes: 16_384,
  maximumRequestBytes: 16_384,
  maximumItemsPerTurn: 4,
  maximumBytesPerTurn: 16_384,
  maximumItemsPerRun: 16,
  maximumBytesPerRun: 65_536,
  maximumControlCharacterRatio: 0.05,
});

const GREETING_PATH = "src/greet.ts";
const ORIGINAL_GREETING = [
  "export function greet(name: string): string {",
  "  return `hello ${name}`;",
  "}",
  "",
].join("\n");
const REPLACEMENT_GREETING = [
  "export function greet(name: string): string {",
  "  return `Hello, ${name}!`;",
  "}",
  "",
].join("\n");
const PROPOSED_PATCH = wholeFilePatch(
  GREETING_PATH,
  ORIGINAL_GREETING,
  REPLACEMENT_GREETING,
);

const VIRTUAL_FILES: Readonly<Record<string, string>> = Object.freeze({
  "README.md": "# Greeting fixture\n",
  [GREETING_PATH]: ORIGINAL_GREETING,
});

const CODING_PROFILE_BROKER_CONFIGURATION = createCodingBrokerFactory(
  createPinnedPolicyEvaluator(CODING_VIRTUAL_POLICY_SNAPSHOT, {
    secretCorrelationToken: "coding-profile-policy-token-0001",
  }),
).configurationDescriptor;

export const CODING_VIRTUAL_TASK_PROFILE: TaskProfile = immutable({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  profileId: "coding-virtual-fixture",
  profileVersion: 2,
  objectiveSchema: {
    schemaId: "coding.virtual.objective",
    schemaVersion: 1,
    document: {
      type: "object",
      additionalProperties: false,
      required: ["path", "instruction"],
      properties: {
        path: { type: "string", const: GREETING_PATH },
        instruction: { type: "string", minLength: 1 },
      },
    },
  },
  driverProfile: {
    componentId: "scripted",
    componentVersion: 1,
    configuration: { scriptId: "coding-virtual-broker-current" },
  },
  modelBindings: [],
  contextSources: [],
  capabilityPacks: [
    {
      bindingId: "virtual-repository",
      componentId: VIRTUAL_REPOSITORY_REFERENCES.list.packId,
      componentVersion: VIRTUAL_REPOSITORY_REFERENCES.list.packVersion,
      configuration: { fixture: "greeting" },
    },
  ],
  policyProfile: {
    componentId: "coding-fixture-safe-default",
    componentVersion: 2,
    configuration: createPolicySnapshotManifest(CODING_VIRTUAL_POLICY_SNAPSHOT),
  },
  outcomeSchema: {
    schemaId: "coding.virtual.outcome",
    schemaVersion: 1,
    document: {
      type: "object",
      additionalProperties: false,
      required: ["path", "patch", "replacementSha256"],
      properties: {
        path: { type: "string", const: GREETING_PATH },
        patch: { type: "string", minLength: 1 },
        replacementSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    },
  },
  budgetPolicy: {
    maxTurns: 4,
    maxActions: 3,
    maxElapsedMs: 5_000,
    maxInputBytes: 16_384,
    maxOutputBytes: 16_384,
    extensions: {
      contextBroker:
        CODING_PROFILE_BROKER_CONFIGURATION as unknown as JsonObject,
    },
  },
  evidenceMode: "ephemeral_metadata",
  evaluationProfile: null,
});

export interface CodingScenarioExecution extends ScenarioExecution {
  readonly objective: ObjectiveEnvelope;
  readonly outcome: OutcomeEnvelope;
  readonly profile: TaskProfile;
  readonly fixtureBefore: JsonObject;
  readonly fixtureAfter: JsonObject;
  readonly patchObservationId: string;
}

/**
 * Exercises list/read/propose_patch against an immutable virtual repository.
 * Every capability agent view crosses a preview and live context broker; the
 * ScriptedAgentDriver still validates the complete exact request on each turn.
 */
export async function runCodingVirtualRepositoryScenario(): Promise<CodingScenarioExecution> {
  const namespace = CODING_SCENARIO_NAMESPACE;
  const runId = fixedRunId(namespace);
  const repository = new VirtualRepository(VIRTUAL_FILES, {
    maximumFiles: 8,
    maximumFileBytes: 4_096,
  });
  const fixtureBefore = repositorySnapshot(repository);
  const packRegistry = new CapabilityPackRegistry([
    createVirtualRepositoryPack(repository, {
      maximumListResults: 16,
      maximumReadBytes: 4_096,
      maximumPatchBytes: 8_192,
    }),
  ]);
  const references = [
    VIRTUAL_REPOSITORY_REFERENCES.list,
    VIRTUAL_REPOSITORY_REFERENCES.read,
    VIRTUAL_REPOSITORY_REFERENCES.patch,
  ];
  const advertisedReferences = Object.values(VIRTUAL_REPOSITORY_REFERENCES);
  const advertised = advertisedOperations(packRegistry, advertisedReferences);
  const gatewayAdvertisement = packRegistry.createAdvertisement(
    advertisedReferences,
  );
  const evaluator = createPinnedPolicyEvaluator(CODING_VIRTUAL_POLICY_SNAPSHOT, {
    secretCorrelationToken: "coding-scenario-policy-token-0001",
  });
  const gateway = new CapabilityGateway(packRegistry, evaluator);
  const liveBrokerFactory = createCodingBrokerFactory(evaluator);
  const previewBroker = createCodingBrokerFactory(evaluator).createForRun({ runId });
  if (
    canonicalSha256Hex(liveBrokerFactory.configurationDescriptor) !==
    canonicalSha256Hex(CODING_PROFILE_BROKER_CONFIGURATION)
  ) {
    throw new Error("The coding profile and live broker configuration diverged.");
  }

  const objective: ObjectiveEnvelope = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    profileId: CODING_VIRTUAL_TASK_PROFILE.profileId,
    profileVersion: CODING_VIRTUAL_TASK_PROFILE.profileVersion,
    objectiveType: "coding.virtual.change",
    objectiveTypeVersion: 1,
    payload: {
      path: GREETING_PATH,
      instruction: "Capitalize the greeting and add conventional punctuation.",
    },
    submittedBy: { kind: "user", id: "milestone-a-fixture" },
    submittedAt: SCENARIO_OCCURRED_AT,
  });

  await previewBroker.assembleAgentContext({
    turnId: fixedAttemptId(namespace, 1),
    agentRequestId: fixedAttemptId(namespace, 1),
    orderedItemIds: [],
  });

  const actionInputs: readonly JsonObject[] = [
    { root: "src", maxResults: 10 },
    { path: GREETING_PATH, startLine: 1, endLine: 3, maxBytes: 1_024 },
    { path: GREETING_PATH, replacement: REPLACEMENT_GREETING },
  ];
  const preview = await previewCodingActions(
    gateway,
    gatewayAdvertisement,
    previewBroker,
    references,
    actionInputs,
  );
  const replacementSha256 = sha256Hex(REPLACEMENT_GREETING);
  const patchObservation = preview.eventObservations[2]!;
  const outcome: OutcomeEnvelope = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    outcomeId: fixedOutcomeId(namespace),
    profileId: CODING_VIRTUAL_TASK_PROFILE.profileId,
    profileVersion: CODING_VIRTUAL_TASK_PROFILE.profileVersion,
    outcomeType: "coding.virtual.patch-proposed",
    outcomeTypeVersion: 1,
    payload: {
      path: GREETING_PATH,
      patch: PROPOSED_PATCH,
      replacementSha256,
    },
    evidence: [
      {
        kind: "observation",
        referenceId: fixedObservationId(namespace, 3),
        contentHash: canonicalSha256Hex(patchObservation),
      },
    ],
    proposedAt: SCENARIO_OCCURRED_AT,
  });

  const expectedTranscript: readonly AgentTurnRequest[] = immutable([
    turnRequest(namespace, 1, objective, advertised, []),
    turnRequest(namespace, 2, objective, advertised, [
      preview.agentObservations[0]!,
    ]),
    turnRequest(namespace, 3, objective, advertised, [
      preview.agentObservations[0]!,
      preview.agentObservations[1]!,
    ]),
    turnRequest(namespace, 4, objective, advertised, [
      preview.agentObservations[0]!,
      preview.agentObservations[1]!,
      preview.agentObservations[2]!,
    ]),
  ]);
  const script: ScriptedAgentDriverScript = immutable({
    scriptId: "coding-virtual-broker-current",
    turns: [
      {
        expectedRequest: expectedTranscript[0]!,
        events: actionTurn(
          namespace,
          1,
          VIRTUAL_REPOSITORY_REFERENCES.list,
          actionInputs[0]!,
          { inputTokens: 10, outputTokens: 3 },
        ),
      },
      {
        expectedRequest: expectedTranscript[1]!,
        events: actionTurn(
          namespace,
          2,
          VIRTUAL_REPOSITORY_REFERENCES.read,
          actionInputs[1]!,
          { inputTokens: 14, outputTokens: 5 },
        ),
      },
      {
        expectedRequest: expectedTranscript[2]!,
        events: actionTurn(
          namespace,
          3,
          VIRTUAL_REPOSITORY_REFERENCES.patch,
          actionInputs[2]!,
          { inputTokens: 18, outputTokens: 9 },
        ),
      },
      {
        expectedRequest: expectedTranscript[3]!,
        events: [
          { type: "outcome_proposed", outcome },
          { type: "usage_reported", dimensions: { inputTokens: 12, outputTokens: 6 } },
          { type: "completed" },
        ],
      },
    ],
  });

  const driver = new ScriptedAgentDriver(script);
  const profileRegistry = new InMemoryTaskProfileRegistry();
  profileRegistry.register(CODING_VIRTUAL_TASK_PROFILE);
  const eventStore = new InMemoryEventStore({ now: () => SCENARIO_RECORDED_AT });
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
    contextPlanner: Object.freeze({ plan: () => [] }),
    installedPolicy: {
      componentId: "coding-fixture-safe-default",
      componentVersion: 2,
      snapshot: CODING_VIRTUAL_POLICY_SNAPSHOT,
    },
    normalizationSubject: {
      kind: "scripted",
      driverId: "driver:milestone-a-coding",
    },
    normalizationEnvironment: {
      profileId: CODING_VIRTUAL_TASK_PROFILE.profileId,
      sandboxed: true,
      networkProfile: "disabled",
      trustLevel: "trusted_fixture",
    },
    clock: Object.freeze({ now: () => SCENARIO_OCCURRED_AT }),
    ids: new FixedRuntimeHostIdFactory(namespace),
  });

  const execution = await host.run(objective);
  if (execution.state.status !== "completed") {
    throw new Error(
      `The coding broker-current scenario did not complete: ${JSON.stringify(
        execution.state.result,
      )}`,
    );
  }
  driver.assertExhausted();
  const fixtureAfter = repositorySnapshot(repository);
  const failClosedReplay = await replayWithFailOnEffectPorts(eventStore, runId);
  return Object.freeze({
    objective,
    outcome,
    profile: CODING_VIRTUAL_TASK_PROFILE,
    execution,
    replay: failClosedReplay.replay,
    expectedTranscript,
    replayEffectCalls: failClosedReplay.effectCalls,
    fixtureBefore,
    fixtureAfter,
    patchObservationId: fixedObservationId(namespace, 3),
  });
}

async function previewCodingActions(
  gateway: CapabilityGateway,
  advertisement: CapabilityAdvertisement,
  broker: ContextBrokerIntegration,
  references: readonly CapabilityOperationReference[],
  inputs: readonly JsonObject[],
): Promise<{
  readonly eventObservations: readonly Observation[];
  readonly agentObservations: readonly AgentObservation[];
}> {
  const eventObservations: Observation[] = [];
  const agentObservations: AgentObservation[] = [];
  const releasedItemIds: string[] = [];
  for (let index = 0; index < references.length; index += 1) {
    const ordinal = index + 1;
    const reference = references[index]!;
    const input = inputs[index]!;
    const prepared = await gateway.normalize(
      { schemaVersion: CONTRACT_SCHEMA_VERSION, ...reference, input },
      {
        actionId: fixedActionId(CODING_SCENARIO_NAMESPACE, ordinal),
        subject: {
          kind: "scripted",
          driverId: "driver:milestone-a-coding",
        },
        environment: {
          profileId: CODING_VIRTUAL_TASK_PROFILE.profileId,
          sandboxed: true,
          networkProfile: "disabled",
          trustLevel: "trusted_fixture",
        },
      },
      advertisement,
    );
    let evaluated: ReturnType<CapabilityGateway["evaluate"]>;
    try {
      evaluated = gateway.evaluate(prepared);
    } catch (error: unknown) {
      throw new Error(`Coding preview gateway evaluation failed at action ${String(ordinal)}.`, {
        cause: error,
      });
    }
    const result = await gateway.execute(evaluated, {
      signal: new AbortController().signal,
    });
    const nextAttemptId = fixedAttemptId(
      CODING_SCENARIO_NAMESPACE,
      ordinal + 1,
    );
    const release = await releasePreviewCapabilityOutput(
      broker,
      nextAttemptId,
      result,
    );
    releasedItemIds.push(release.item.itemId);
    const outputBlock = brokerJsonContentBlock(release.item, release.manifest);
    const expected = successfulBrokeredObservation({
      namespace: CODING_SCENARIO_NAMESPACE,
      observationOrdinal: ordinal,
      actionOrdinal: ordinal,
      humanBlockOrdinal: ordinal,
      capabilityPackId: reference.packId,
      audit: result.audit,
      human: result.human,
      agentContent: [outputBlock],
    });
    eventObservations.push(expected.eventObservation);
    agentObservations.push(expected.agentObservation);
    await broker.assembleAgentContext({
      turnId: nextAttemptId,
      agentRequestId: nextAttemptId,
      orderedItemIds: [...releasedItemIds],
    });
  }
  return Object.freeze({
    eventObservations: Object.freeze(eventObservations),
    agentObservations: Object.freeze(agentObservations),
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
    throw new Error("A coding preview capability output was denied unexpectedly.");
  }
  return release;
}

function turnRequest(
  namespace: number,
  turn: number,
  objective: ObjectiveEnvelope,
  advertisedOperations: AgentTurnRequest["advertisedOperations"],
  observations: AgentTurnRequest["observations"],
): AgentTurnRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    runId: fixedRunId(namespace),
    attemptId: fixedAttemptId(namespace, turn),
    turnNumber: turn,
    objective,
    advertisedOperations,
    context: [],
    observations,
  };
}

function actionTurn(
  namespace: number,
  ordinal: number,
  reference: CapabilityOperationReference,
  input: JsonObject,
  dimensions: Readonly<Record<string, number>>,
): ScriptedAgentDriverScript["turns"][number]["events"] {
  return [
    {
      type: "action_proposed",
      proposalId: fixedProposalId(namespace, ordinal),
      capabilityPackId: reference.packId,
      capabilityPackVersion: reference.packVersion,
      operationId: reference.operationId,
      operationVersion: reference.operationVersion,
      input,
    },
    { type: "usage_reported", dimensions },
    { type: "completed" },
  ];
}

function createCodingBrokerFactory(evaluator: PinnedPolicyEvaluator) {
  return createContextBrokerIntegrationFactory({
    policySnapshotId: CODING_VIRTUAL_POLICY_SNAPSHOT.policyVersionId,
    releasePolicy: CODING_RELEASE_POLICY,
    sources: new BrokerContextSourceRegistry([]),
    policy: createPinnedContextPolicyAdapter({
      evaluator,
      releasePolicy: CODING_RELEASE_POLICY,
    }),
    budgets: CODING_BROKER_BUDGETS,
  });
}

function repositorySnapshot(repository: VirtualRepository): JsonObject {
  const files: Record<string, string> = {};
  for (const path of repository.list()) files[path] = repository.read(path);
  return immutable({ snapshotHash: repository.snapshotHash, files });
}

function wholeFilePatch(path: string, before: string, after: string): string {
  const beforeLines = logicalLines(before);
  const afterLines = logicalLines(after);
  const oldStart = beforeLines.length === 0 ? 0 : 1;
  const newStart = afterLines.length === 0 ? 0 : 1;
  return `${[
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${beforeLines.length} +${newStart},${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n")}\n`;
}

function logicalLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function compileCodingPolicy(): PolicySnapshot {
  const catalogs = composePolicyAttributeCatalogs([
    BASE_POLICY_ATTRIBUTE_CATALOG,
    CONTEXT_POLICY_ATTRIBUTE_CATALOG,
    REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
  ]);
  const result = compilePolicySnapshotSet(
    {
      policyVersionId: fixedPolicyVersionId(0xb102),
      sources: [
        {
          sourceId: "coding-virtual-fixture.guard",
          source: CODING_POLICY_SOURCE,
        },
        {
          sourceId: "policies/context.guard",
          source: ROOT_CONTEXT_POLICY_SOURCE,
        },
        {
          sourceId: "packages/capability-repository/policies/context.guard",
          source: REPOSITORY_CONTEXT_POLICY_SOURCE,
        },
      ],
      defaultEffect: "deny",
    },
    {},
    catalogs,
  );
  if (!result.ok) {
    throw new Error(
      `The deterministic coding scenario policy did not compile: ${JSON.stringify(
        result.diagnostics,
      )}`,
    );
  }
  return result.snapshot;
}
