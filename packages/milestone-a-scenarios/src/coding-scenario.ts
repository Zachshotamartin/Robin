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
  VIRTUAL_REPOSITORY_REFERENCES,
  VirtualRepository,
  createVirtualRepositoryPack,
} from "@guard/capability-repository";
import { ContextSourceRegistry } from "@guard/context-broker";
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
  compilePolicySnapshot,
  createPinnedPolicyEvaluator,
  createPolicySnapshotManifest,
  type PolicySnapshot,
} from "@guard/policy-engine";
import { InMemoryTaskProfileRegistry } from "@guard/profile-registry";
import { SynchronousRuntimeHost } from "@guard/runtime-host";

import {
  FixedRuntimeHostIdFactory,
  SCENARIO_OCCURRED_AT,
  SCENARIO_RECORDED_AT,
  advertisedOperations,
  fixedAttemptId,
  fixedObservationId,
  fixedOutcomeId,
  fixedPolicyVersionId,
  fixedProposalId,
  fixedRunId,
  immutable,
  replayWithFailOnEffectPorts,
  successfulObservation,
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
const RELEASED_ORIGINAL_GREETING = ORIGINAL_GREETING.slice(0, -1);
const PROPOSED_PATCH = wholeFilePatch(
  GREETING_PATH,
  ORIGINAL_GREETING,
  REPLACEMENT_GREETING,
);

const VIRTUAL_FILES: Readonly<Record<string, string>> = Object.freeze({
  "README.md": "# Greeting fixture\n",
  [GREETING_PATH]: ORIGINAL_GREETING,
});

export const CODING_VIRTUAL_TASK_PROFILE: TaskProfile = immutable({
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
    extensions: {},
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
 * Exercises the same host and reducer as the generic slice while every coding
 * operation targets an immutable in-memory fixture. list/read/propose_patch
 * cannot reach the host filesystem, Git, a subprocess, a network, or a model.
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
  const advertised = advertisedOperations(packRegistry, references);

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

  const listObservation = successfulObservation({
    namespace,
    observationOrdinal: 1,
    actionOrdinal: 1,
    firstBlockOrdinal: 1,
    capabilityPackId: VIRTUAL_REPOSITORY_REFERENCES.list.packId,
    audit: { root: "", matchedCount: 2, releasedCount: 2, truncated: false },
    human: { summary: "Released 2 virtual path(s)." },
    agent: { files: ["README.md", GREETING_PATH], truncated: false },
  });
  const sourceSha256 = sha256Hex(ORIGINAL_GREETING);
  const readBytes = Buffer.byteLength(RELEASED_ORIGINAL_GREETING, "utf8");
  const readObservation = successfulObservation({
    namespace,
    observationOrdinal: 2,
    actionOrdinal: 2,
    firstBlockOrdinal: 3,
    capabilityPackId: VIRTUAL_REPOSITORY_REFERENCES.read.packId,
    audit: {
      path: GREETING_PATH,
      byteLength: readBytes,
      sourceSha256,
      truncated: false,
    },
    human: {
      summary: `Released ${String(readBytes)} byte(s) from ${GREETING_PATH}.`,
    },
    agent: {
      path: GREETING_PATH,
      content: RELEASED_ORIGINAL_GREETING,
      truncated: false,
    },
  });
  const patchBytes = Buffer.byteLength(PROPOSED_PATCH, "utf8");
  const replacementSha256 = sha256Hex(REPLACEMENT_GREETING);
  const patchObservation = successfulObservation({
    namespace,
    observationOrdinal: 3,
    actionOrdinal: 3,
    firstBlockOrdinal: 5,
    capabilityPackId: VIRTUAL_REPOSITORY_REFERENCES.patch.packId,
    audit: {
      path: GREETING_PATH,
      byteLength: patchBytes,
      preimageSha256: sourceSha256,
      replacementSha256,
    },
    human: {
      summary: `Proposed a ${String(patchBytes)} byte patch for ${GREETING_PATH}; no fixture content was changed.`,
      patch: PROPOSED_PATCH,
    },
    agent: { path: GREETING_PATH, patch: PROPOSED_PATCH },
  });

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
    turnRequest(namespace, 2, objective, advertised, [listObservation]),
    turnRequest(namespace, 3, objective, advertised, [
      listObservation,
      readObservation,
    ]),
    turnRequest(namespace, 4, objective, advertised, [
      listObservation,
      readObservation,
      patchObservation,
    ]),
  ]);
  const script: ScriptedAgentDriverScript = immutable({
    scriptId: "coding-virtual-golden",
    turns: [
      {
        expectedRequest: expectedTranscript[0]!,
        events: actionTurn(
          namespace,
          1,
          VIRTUAL_REPOSITORY_REFERENCES.list,
          { root: "", maxResults: 10 },
          { inputTokens: 10, outputTokens: 3 },
        ),
      },
      {
        expectedRequest: expectedTranscript[1]!,
        events: actionTurn(
          namespace,
          2,
          VIRTUAL_REPOSITORY_REFERENCES.read,
          { path: GREETING_PATH, startLine: 1, endLine: 3, maxBytes: 1_024 },
          { inputTokens: 14, outputTokens: 5 },
        ),
      },
      {
        expectedRequest: expectedTranscript[2]!,
        events: actionTurn(
          namespace,
          3,
          VIRTUAL_REPOSITORY_REFERENCES.patch,
          { path: GREETING_PATH, replacement: REPLACEMENT_GREETING },
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
  const gateway = new CapabilityGateway(
    packRegistry,
    createPinnedPolicyEvaluator(CODING_VIRTUAL_POLICY_SNAPSHOT, {
      secretCorrelationToken: "coding-scenario-policy-token-0001",
    }),
  );
  const host = new SynchronousRuntimeHost({
    eventStore,
    profileRegistry,
    installedDriver: {
      componentId: "scripted",
      componentVersion: 1,
      driver,
    },
    contextSources: new ContextSourceRegistry([]),
    capabilityPacks: packRegistry,
    capabilityGateway: gateway,
    contextPlanner: Object.freeze({ plan: () => [] }),
    installedPolicy: {
      componentId: "coding-fixture-safe-default",
      componentVersion: 1,
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
  reference: (typeof VIRTUAL_REPOSITORY_REFERENCES)[keyof typeof VIRTUAL_REPOSITORY_REFERENCES],
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
  const result = compilePolicySnapshot({
    policyVersionId: fixedPolicyVersionId(CODING_SCENARIO_NAMESPACE),
    source: CODING_POLICY_SOURCE,
    sourceId: "coding-virtual-fixture.guard",
    defaultEffect: "deny",
  });
  if (!result.ok) {
    throw new Error(
      `The deterministic coding scenario policy did not compile: ${JSON.stringify(
        result.diagnostics,
      )}`,
    );
  }
  return result.snapshot;
}
