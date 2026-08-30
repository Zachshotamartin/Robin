import {
  ScriptedAgentDriver,
  type AgentTurnRequest,
  type ScriptedAgentDriverScript,
} from "@guard/agent-driver";
import {
  CapabilityGateway,
  CapabilityPackRegistry,
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
} from "@guard/context-broker";
import {
  CONTRACT_SCHEMA_VERSION,
  canonicalSha256Hex,
  sha256Hex,
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
const RELEASED_ORIGINAL_GREETING = ORIGINAL_GREETING.slice(0, -1);
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

const REPOSITORY_EFFECT_CALLS = new WeakMap<
  VirtualRepository,
  ReturnType<typeof createScenarioLiveEffectCalls>
>();

class EffectCountedVirtualRepository extends VirtualRepository {
  public constructor(
    files: Readonly<Record<string, string>>,
    limits: ConstructorParameters<typeof VirtualRepository>[1],
    calls: ReturnType<typeof createScenarioLiveEffectCalls>,
  ) {
    super(files, limits);
    REPOSITORY_EFFECT_CALLS.set(this, calls);
  }

  public override list(root = ""): readonly string[] {
    repositoryEffectCalls(this).repositoryList += 1;
    return super.list(root);
  }

  public override read(path: string): string {
    repositoryEffectCalls(this).repositoryRead += 1;
    return super.read(path);
  }
}

const CODING_VIRTUAL_LEGACY_POLICY_MANIFEST: JsonObject = immutable({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  policyVersionId: "pol_018f0002-0000-7000-8000-090000000001",
  languageVersion: "1",
  defaultEffect: "deny",
  policyContentHash:
    "aaf6a2787034c5176426f546f1f0de8d01130ab7619d9ae3cd73131b09d9ccb3",
  sourceCount: 1,
  attributeCatalogs: [
    {
      catalogId: "guard.base",
      schemaVersion: 1,
      contentHash:
        "3cd39e76a6c94f0f842b4871b6cebc3c010236927dfcc0f8b0dde054bbb9bf48",
    },
  ],
});

const CODING_PROFILE_BROKER_CONFIGURATION = createCodingBrokerFactory(
  createPinnedPolicyEvaluator(CODING_VIRTUAL_POLICY_SNAPSHOT, {
    secretCorrelationToken: "coding-profile-policy-token-0001",
  }),
).configurationDescriptor;

export const CODING_VIRTUAL_TASK_PROFILE_V1: TaskProfile = immutable({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  profileId: "coding-virtual-fixture",
  profileVersion: 1,
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
    configuration: { scriptId: "coding-virtual-golden" },
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
    componentVersion: 1,
    configuration: CODING_VIRTUAL_LEGACY_POLICY_MANIFEST,
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
    extensions: {},
  },
  evidenceMode: "ephemeral_metadata",
  evaluationProfile: null,
});

export const CODING_VIRTUAL_BROKER_TASK_PROFILE_V2: TaskProfile = immutable({
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

/** Historical compatibility name. New broker-current runs pin the v2 export. */
export const CODING_VIRTUAL_TASK_PROFILE = CODING_VIRTUAL_TASK_PROFILE_V1;

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
 * The expected transcript is derived without touching the live repository,
 * capability handlers, source ports, or broker. ScriptedAgentDriver compares
 * it exactly with the bytes produced inside the event-ledger run.
 */
export async function runCodingVirtualRepositoryScenario(): Promise<CodingScenarioExecution> {
  const namespace = CODING_SCENARIO_NAMESPACE;
  const runId = fixedRunId(namespace);
  const liveEffectCalls = createScenarioLiveEffectCalls();
  const repository = new EffectCountedVirtualRepository(
    VIRTUAL_FILES,
    { maximumFiles: 8, maximumFileBytes: 4_096 },
    liveEffectCalls,
  );
  const fixtureBefore = immutable({
    snapshotHash: repository.snapshotHash,
    files: VIRTUAL_FILES,
  });
  const packRegistry = new CapabilityPackRegistry([
    countCapabilityPackEffects(
      createVirtualRepositoryPack(repository, {
        maximumListResults: 16,
        maximumReadBytes: 4_096,
        maximumPatchBytes: 8_192,
      }),
      liveEffectCalls,
    ),
  ]);
  const advertisedReferences = Object.values(VIRTUAL_REPOSITORY_REFERENCES);
  const advertised = advertisedOperations(packRegistry, advertisedReferences);
  const evaluator = createPinnedPolicyEvaluator(CODING_VIRTUAL_POLICY_SNAPSHOT, {
    secretCorrelationToken: "coding-scenario-policy-token-0001",
  });
  const gateway = new CapabilityGateway(packRegistry, evaluator);
  const liveBrokerFactory = createCodingBrokerFactory(evaluator);
  if (
    canonicalSha256Hex(liveBrokerFactory.configurationDescriptor) !==
    canonicalSha256Hex(CODING_PROFILE_BROKER_CONFIGURATION)
  ) {
    throw new Error("The coding profile and live broker configuration diverged.");
  }

  const objective: ObjectiveEnvelope = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    profileId: CODING_VIRTUAL_BROKER_TASK_PROFILE_V2.profileId,
    profileVersion: CODING_VIRTUAL_BROKER_TASK_PROFILE_V2.profileVersion,
    objectiveType: "coding.virtual.change",
    objectiveTypeVersion: 1,
    payload: {
      path: GREETING_PATH,
      instruction: "Capitalize the greeting and add conventional punctuation.",
    },
    submittedBy: { kind: "user", id: "milestone-a-fixture" },
    submittedAt: SCENARIO_OCCURRED_AT,
  });

  const actionInputs: readonly JsonObject[] = [
    { root: "src", maxResults: 10 },
    { path: GREETING_PATH, startLine: 1, endLine: 3, maxBytes: 1_024 },
    { path: GREETING_PATH, replacement: REPLACEMENT_GREETING },
  ];
  const oracle = codingTranscriptOracle(runId);
  const replacementSha256 = sha256Hex(REPLACEMENT_GREETING);
  const patchObservation = oracle[2]!.eventObservation;
  const outcome: OutcomeEnvelope = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    outcomeId: fixedOutcomeId(namespace),
    profileId: CODING_VIRTUAL_BROKER_TASK_PROFILE_V2.profileId,
    profileVersion: CODING_VIRTUAL_BROKER_TASK_PROFILE_V2.profileVersion,
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
      oracle[0]!.agentObservation,
    ]),
    turnRequest(namespace, 3, objective, advertised, [
      oracle[0]!.agentObservation,
      oracle[1]!.agentObservation,
    ]),
    turnRequest(namespace, 4, objective, advertised, [
      oracle[0]!.agentObservation,
      oracle[1]!.agentObservation,
      oracle[2]!.agentObservation,
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
  profileRegistry.register(CODING_VIRTUAL_BROKER_TASK_PROFILE_V2);
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
      profileId: CODING_VIRTUAL_BROKER_TASK_PROFILE_V2.profileId,
      sandboxed: true,
      networkProfile: "disabled",
      trustLevel: "trusted_fixture",
    },
    clock: Object.freeze({ now: () => SCENARIO_OCCURRED_AT }),
    ids: new FixedRuntimeHostIdFactory(namespace),
  });

  assertNoLiveEffects(liveEffectCalls);
  const execution = await host.run(objective);
  if (execution.state.status !== "completed") {
    throw new Error(
      `The coding broker-current scenario did not complete: ${JSON.stringify(
        execution.state.result,
      )}`,
    );
  }
  driver.assertExhausted();
  assertLiveEffects(liveEffectCalls, {
    sourceNormalize: 0,
    sourceInspect: 0,
    sourceOpen: 0,
    capabilityNormalize: 3,
    capabilityExecute: 3,
    capabilityRelease: 3,
    repositoryList: 1,
    repositoryRead: 2,
  });
  const fixtureAfter = immutable({
    snapshotHash: repository.snapshotHash,
    files: VIRTUAL_FILES,
  });
  const failClosedReplay = await replayWithFailOnEffectPorts(eventStore, runId);
  return Object.freeze({
    objective,
    outcome,
    profile: CODING_VIRTUAL_BROKER_TASK_PROFILE_V2,
    execution,
    replay: failClosedReplay.replay,
    expectedTranscript,
    liveEffectCalls: immutable(liveEffectCalls),
    replayEffectCalls: failClosedReplay.effectCalls,
    fixtureBefore,
    fixtureAfter,
    patchObservationId: fixedObservationId(namespace, 3),
  });
}

function codingTranscriptOracle(runId: ReturnType<typeof fixedRunId>) {
  const listOutput: JsonObject = {
    files: [GREETING_PATH],
    truncated: false,
  };
  const list = successfulBrokeredObservation({
    namespace: CODING_SCENARIO_NAMESPACE,
    observationOrdinal: 1,
    actionOrdinal: 1,
    humanBlockOrdinal: 1,
    capabilityPackId: VIRTUAL_REPOSITORY_REFERENCES.list.packId,
    audit: {
      matchedCount: 1,
      releasedCount: 1,
      truncated: false,
    },
    human: { summary: "Released 1 virtual path(s)." },
    agentContent: [
      repositoryCapabilityOutputBlock({
        runId,
        releaseOrdinal: 1,
        path: "src",
        outputPaths: [GREETING_PATH],
        output: listOutput,
      }),
    ],
  });

  const sourceSha256 = sha256Hex(ORIGINAL_GREETING);
  const readBytes = Buffer.byteLength(RELEASED_ORIGINAL_GREETING, "utf8");
  const readOutput: JsonObject = {
    path: GREETING_PATH,
    content: RELEASED_ORIGINAL_GREETING,
    truncated: false,
  };
  const read = successfulBrokeredObservation({
    namespace: CODING_SCENARIO_NAMESPACE,
    observationOrdinal: 2,
    actionOrdinal: 2,
    humanBlockOrdinal: 2,
    capabilityPackId: VIRTUAL_REPOSITORY_REFERENCES.read.packId,
    audit: {
      byteLength: readBytes,
      sourceSha256,
      truncated: false,
    },
    human: {
      summary: `Released ${String(
        readBytes,
      )} byte(s) from one reviewed repository path.`,
    },
    agentContent: [
      repositoryCapabilityOutputBlock({
        runId,
        releaseOrdinal: 2,
        path: GREETING_PATH,
        output: readOutput,
      }),
    ],
  });

  const patchBytes = Buffer.byteLength(PROPOSED_PATCH, "utf8");
  const replacementSha256 = sha256Hex(REPLACEMENT_GREETING);
  const patchOutput: JsonObject = {
    path: GREETING_PATH,
    patch: PROPOSED_PATCH,
  };
  const patch = successfulBrokeredObservation({
    namespace: CODING_SCENARIO_NAMESPACE,
    observationOrdinal: 3,
    actionOrdinal: 3,
    humanBlockOrdinal: 3,
    capabilityPackId: VIRTUAL_REPOSITORY_REFERENCES.patch.packId,
    audit: {
      byteLength: patchBytes,
      preimageSha256: sourceSha256,
      replacementSha256,
    },
    human: {
      summary: `Proposed a ${String(
        patchBytes,
      )} byte patch for one reviewed repository path; no fixture content was changed.`,
    },
    agentContent: [
      repositoryCapabilityOutputBlock({
        runId,
        releaseOrdinal: 3,
        path: GREETING_PATH,
        output: patchOutput,
      }),
    ],
  });
  return Object.freeze([list, read, patch] as const);
}

function repositoryCapabilityOutputBlock(input: {
  readonly runId: ReturnType<typeof fixedRunId>;
  readonly releaseOrdinal: number;
  readonly path: string;
  readonly outputPaths?: readonly string[];
  readonly output: JsonObject;
}) {
  const locator = input.outputPaths === undefined
    ? { path: input.path }
    : { path: input.path, outputPaths: input.outputPaths };
  const resource = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scheme: "repo",
    sourceId: "virtual-repository",
    locator,
    mediaType: "application/json",
    classification: "fixture",
  });
  return deterministicBrokerJsonContentBlock({
    runId: input.runId,
    releaseOrdinal: input.releaseOrdinal,
    resource,
    mediaType: "application/json",
    classification: "fixture",
    producerKind: "capability_worker",
    value: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "capability_output",
      untrusted: true,
      trustLabel: "untrusted_capability_output",
      resource,
      provenance: {
        sourceId: "virtual-repository",
        sourceVersion: 1,
        classification: "fixture",
        policyCatalogId: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
        policyCatalogVersion: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
        policyCatalogContentHash: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
      },
      output: input.output,
    },
  });
}

function assertNoLiveEffects(calls: ReturnType<typeof createScenarioLiveEffectCalls>): void {
  if (Object.values(calls).some((count) => count !== 0)) {
    throw new Error("Coding live effects occurred before the recorded host run.");
  }
}

function assertLiveEffects(
  calls: ReturnType<typeof createScenarioLiveEffectCalls>,
  expected: ReturnType<typeof createScenarioLiveEffectCalls>,
): void {
  if (canonicalSha256Hex(calls) !== canonicalSha256Hex(expected)) {
    throw new Error("Coding live effect counts diverged from the event-ledger flow.");
  }
}

function repositoryEffectCalls(
  repository: VirtualRepository,
): ReturnType<typeof createScenarioLiveEffectCalls> {
  const calls = REPOSITORY_EFFECT_CALLS.get(repository);
  if (calls === undefined) {
    throw new Error("The coding scenario repository effect counter is missing.");
  }
  return calls;
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
