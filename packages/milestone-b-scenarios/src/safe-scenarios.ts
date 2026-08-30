import type { AgentDriver, AgentDriverEvent } from "@guard/agent-driver";
import {
  VIRTUAL_REPOSITORY_REFERENCES,
  VirtualRepository,
  createVirtualRepositoryPack,
} from "@guard/capability-repository";
import {
  SYNTHETIC_TRANSFORM_REFERENCE,
  createSyntheticBrokerContextSource,
  createSyntheticTransformPack,
} from "@guard/capability-synthetic";
import {
  CONTRACT_SCHEMA_VERSION,
  type JsonObject,
  type ObjectiveEnvelope,
  type OutcomeEnvelope,
} from "@guard/contracts";
import type { RuntimeContextPlanner } from "@guard/runtime-host";

import {
  GATE_B_OCCURRED_AT,
  compileGateBPolicy,
  countBrokerContextSource,
  countCapabilityPack,
  createEvaluator,
  createProfile,
  createReleasePolicy,
  createRuntimeComposition,
  createUnifiedBrokerFactory,
  emptyCounters,
  fixedOutcomeId,
  fixedProposalId,
  immutable,
  runExactCalibratedScenario,
  type GateBScenarioResult,
} from "./scenario-support.js";

export const GENERIC_SAFE_NAMESPACE = 0x101;
export const CODING_SAFE_NAMESPACE = 0x102;

export const SAFE_GREETING_PATH = "src/greet.ts";
export const SAFE_SEARCH_PATH = "src/feature.ts";
export const SAFE_SEARCH_SNIPPET = "return featureFlag ? greet(name) : name;";

const GENERIC_ACTION_POLICY = `policy "allow-gate-b-transform" priority 500 {
  when action.pack == "synthetic.transform" and action.operation == "transform_text" and action.side_effect == "none"
  allow
  reason "Gate B permits the bounded deterministic transform fixture"
}
`;

export const CODING_ACTION_POLICY = `policy "deny-secret-repository-actions" priority 1000 {
  when action.pack == "coding.virtual-repository"
    and (repo.path matches "**/.env*" or repo.input_paths matches "**/.env*")
  deny
  reason "Secret-bearing repository paths cannot be operated on"
}

policy "allow-gate-b-repository-inspection" priority 500 {
  when action.pack == "coding.virtual-repository" and action.operation in ["list_files", "search_text", "read_file", "propose_patch", "inspect_diff"] and action.side_effect == "none"
  allow
  reason "Gate B permits bounded effect-free virtual repository inspection"
}
`;

const SOURCE_TEXT = "  Guarded agents transform bounded data.  ";
const NORMALIZED_TEXT = SOURCE_TEXT.normalize("NFC").trim();
const TRANSFORMED_TEXT = NORMALIZED_TEXT.toUpperCase();
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
export const SAFE_PROPOSED_PATCH = wholeFilePatch(
  SAFE_GREETING_PATH,
  ORIGINAL_GREETING,
  REPLACEMENT_GREETING,
);

const SAFE_FILES: Readonly<Record<string, string>> = Object.freeze({
  "README.md": "# Gate B coding fixture\n",
  [SAFE_GREETING_PATH]: ORIGINAL_GREETING,
  [SAFE_SEARCH_PATH]: [
    "import { greet } from \"./greet.js\";",
    "export function selected(name: string, featureFlag: boolean): string {",
    `  ${SAFE_SEARCH_SNIPPET}`,
    "}",
    "",
  ].join("\n"),
});

export interface GenericSafeArtifacts {
  readonly sourceText: string;
  readonly normalizedText: string;
  readonly transformedText: string;
}

export interface CodingSafeArtifacts {
  readonly fixtureBefore: JsonObject;
  readonly fixtureAfter: JsonObject;
  readonly selectedPath: string;
  readonly selectedSnippet: string;
  readonly patch: string;
}

export async function runGenericSafeScenario(): Promise<
  GateBScenarioResult<GenericSafeArtifacts>
> {
  const profileId = "gate-b.generic-safe";
  const outcome = outcomeEnvelope({
    namespace: GENERIC_SAFE_NAMESPACE,
    profileId,
    outcomeType: "gate-b.generic.completed",
    payload: { transformed: TRANSFORMED_TEXT },
  });
  const turnEvents: readonly (readonly AgentDriverEvent[])[] = immutable([
    [
      {
        type: "action_proposed",
        proposalId: fixedProposalId(GENERIC_SAFE_NAMESPACE, 1),
        capabilityPackId: SYNTHETIC_TRANSFORM_REFERENCE.packId,
        capabilityPackVersion: SYNTHETIC_TRANSFORM_REFERENCE.packVersion,
        operationId: SYNTHETIC_TRANSFORM_REFERENCE.operationId,
        operationVersion: SYNTHETIC_TRANSFORM_REFERENCE.operationVersion,
        input: { text: NORMALIZED_TEXT, mode: "uppercase" },
      },
      { type: "usage_reported", dimensions: { inputTokens: 12, outputTokens: 4 } },
      { type: "completed" },
    ],
    [
      { type: "outcome_proposed", outcome },
      { type: "usage_reported", dimensions: { inputTokens: 8, outputTokens: 3 } },
      { type: "completed" },
    ],
  ]);

  return runExactCalibratedScenario({
    scriptId: "gate-b.generic-safe",
    turnEvents,
    build: (driver) => buildGenericSafeComposition(driver, profileId),
  });
}

export async function runCodingSafeScenario(): Promise<
  GateBScenarioResult<CodingSafeArtifacts>
> {
  const profileId = "gate-b.coding-safe";
  const outcome = outcomeEnvelope({
    namespace: CODING_SAFE_NAMESPACE,
    profileId,
    outcomeType: "gate-b.coding.patch-inspected",
    payload: {
      path: SAFE_GREETING_PATH,
      selectedPath: SAFE_SEARCH_PATH,
      patch: SAFE_PROPOSED_PATCH,
      inspected: true,
    },
  });
  const actions: ReadonlyArray<
    readonly [
      (typeof VIRTUAL_REPOSITORY_REFERENCES)[keyof typeof VIRTUAL_REPOSITORY_REFERENCES],
      JsonObject,
    ]
  > = [
    [VIRTUAL_REPOSITORY_REFERENCES.list, { root: "src", maxResults: 16 }],
    [
      VIRTUAL_REPOSITORY_REFERENCES.search,
      {
        query: "return",
        paths: [SAFE_SEARCH_PATH],
        maxMatches: 4,
        maxSnippetBytes: 256,
        maxOutputBytes: 2_048,
      },
    ],
    [
      VIRTUAL_REPOSITORY_REFERENCES.read,
      { path: SAFE_GREETING_PATH, startLine: 1, endLine: 3, maxBytes: 2_048 },
    ],
    [
      VIRTUAL_REPOSITORY_REFERENCES.patch,
      { path: SAFE_GREETING_PATH, replacement: REPLACEMENT_GREETING },
    ],
    [VIRTUAL_REPOSITORY_REFERENCES.inspectDiff, { patch: SAFE_PROPOSED_PATCH }],
  ];
  const actionTurns = actions.map(([reference, input], index) =>
    actionTurn(CODING_SAFE_NAMESPACE, index + 1, reference, input),
  );
  const turnEvents: readonly (readonly AgentDriverEvent[])[] = immutable([
    ...actionTurns,
    [
      { type: "outcome_proposed", outcome },
      { type: "usage_reported", dimensions: { inputTokens: 20, outputTokens: 8 } },
      { type: "completed" },
    ],
  ]);

  return runExactCalibratedScenario({
    scriptId: "gate-b.coding-safe",
    turnEvents,
    build: (driver) => buildCodingSafeComposition(driver, profileId),
  });
}

function buildGenericSafeComposition(driver: AgentDriver, profileId: string) {
  const counters = emptyCounters();
  const snapshot = compileGateBPolicy({
    namespace: GENERIC_SAFE_NAMESPACE,
    kind: "generic",
    actionPolicySource: GENERIC_ACTION_POLICY,
  });
  const evaluator = createEvaluator(snapshot, GENERIC_SAFE_NAMESPACE);
  const releasePolicy = createReleasePolicy("gate-b.generic-release");
  const source = countBrokerContextSource(
    createSyntheticBrokerContextSource(),
    counters,
  );
  const brokerFactory = createUnifiedBrokerFactory({
    snapshot,
    evaluator,
    releasePolicy,
    sources: [source],
  });
  const pack = countCapabilityPack(createSyntheticTransformPack(), counters);
  const profile = createProfile({
    profileId,
    policyComponentId: "gate-b.generic-policy",
    policySnapshot: snapshot,
    brokerConfiguration: brokerFactory.configurationDescriptor,
    contextSources: [
      {
        bindingId: "transform-input",
        componentId: source.descriptor.sourceId,
        componentVersion: source.descriptor.sourceVersion,
        configuration: { record: "greeting", maximumBytes: 2_048 },
      },
    ],
    capabilityPacks: [
      {
        bindingId: "transform",
        componentId: pack.packId,
        componentVersion: pack.packVersion,
        configuration: { deterministic: true },
      },
    ],
    objectiveSchema: {
      schemaId: "gate-b.generic.objective",
      schemaVersion: 1,
      document: {
        type: "object",
        additionalProperties: false,
        required: ["recordId", "mode"],
        properties: {
          recordId: { type: "string", const: "greeting" },
          mode: { type: "string", const: "uppercase" },
        },
      },
    },
    outcomeSchema: {
      schemaId: "gate-b.generic.outcome",
      schemaVersion: 1,
      document: {
        type: "object",
        additionalProperties: false,
        required: ["transformed"],
        properties: { transformed: { type: "string", const: TRANSFORMED_TEXT } },
      },
    },
    maximumTurns: 2,
    maximumActions: 1,
  });
  const objective: ObjectiveEnvelope = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    profileId,
    profileVersion: profile.profileVersion,
    objectiveType: "gate-b.generic.transform",
    objectiveTypeVersion: 1,
    payload: { recordId: "greeting", mode: "uppercase" },
    submittedBy: { kind: "user", id: "gate-b-fixture" },
    submittedAt: GATE_B_OCCURRED_AT,
  });
  const planner: RuntimeContextPlanner = Object.freeze({
    plan(input: Parameters<RuntimeContextPlanner["plan"]>[0]) {
      return [
        {
          bindingId: "transform-input",
          input: { recordId: input.objective.payload["recordId"]! },
          budget: { maximumItems: 1, maximumBytes: 2_048 },
        },
      ];
    },
  });
  return createRuntimeComposition({
    namespace: GENERIC_SAFE_NAMESPACE,
    driver,
    profile,
    objective,
    snapshot,
    evaluator,
    brokerFactory,
    packs: [pack],
    planner,
    counters,
    artifacts: immutable({
      sourceText: SOURCE_TEXT,
      normalizedText: NORMALIZED_TEXT,
      transformedText: TRANSFORMED_TEXT,
    }),
  });
}

function buildCodingSafeComposition(driver: AgentDriver, profileId: string) {
  const counters = emptyCounters();
  const snapshot = compileGateBPolicy({
    namespace: CODING_SAFE_NAMESPACE,
    kind: "coding",
    actionPolicySource: CODING_ACTION_POLICY,
  });
  const evaluator = createEvaluator(snapshot, CODING_SAFE_NAMESPACE);
  const releasePolicy = createReleasePolicy("gate-b.coding-release");
  const brokerFactory = createUnifiedBrokerFactory({
    snapshot,
    evaluator,
    releasePolicy,
    sources: [],
  });
  const repository = new VirtualRepository(SAFE_FILES, {
    maximumFiles: 16,
    maximumFileBytes: 8_192,
  });
  const fixtureBefore = repositorySnapshot(repository);
  const pack = countCapabilityPack(
    createVirtualRepositoryPack(repository, {
      maximumListResults: 32,
      maximumReadBytes: 8_192,
      maximumPatchBytes: 16_384,
      maximumSearchQueryBytes: 256,
      maximumSearchPaths: 8,
      maximumSearchMatches: 16,
      maximumSearchSnippetBytes: 512,
      maximumSearchOutputBytes: 8_192,
      maximumDiffBytes: 16_384,
      maximumDiffPaths: 8,
      maximumDiffHunks: 16,
      maximumDiffLines: 256,
      maximumDiffOutputBytes: 32_768,
    }),
    counters,
  );
  const profile = createProfile({
    profileId,
    policyComponentId: "gate-b.coding-policy",
    policySnapshot: snapshot,
    brokerConfiguration: brokerFactory.configurationDescriptor,
    contextSources: [],
    capabilityPacks: [
      {
        bindingId: "virtual-repository",
        componentId: pack.packId,
        componentVersion: pack.packVersion,
        configuration: { fixture: "gate-b-safe" },
      },
    ],
    objectiveSchema: {
      schemaId: "gate-b.coding.objective",
      schemaVersion: 1,
      document: {
        type: "object",
        additionalProperties: false,
        required: ["path", "instruction"],
        properties: {
          path: { type: "string", const: SAFE_GREETING_PATH },
          instruction: { type: "string", minLength: 1 },
        },
      },
    },
    outcomeSchema: {
      schemaId: "gate-b.coding.outcome",
      schemaVersion: 1,
      document: {
        type: "object",
        additionalProperties: false,
        required: ["path", "selectedPath", "patch", "inspected"],
        properties: {
          path: { type: "string", const: SAFE_GREETING_PATH },
          selectedPath: { type: "string", const: SAFE_SEARCH_PATH },
          patch: { type: "string", minLength: 1 },
          inspected: { type: "boolean", const: true },
        },
      },
    },
    maximumTurns: 6,
    maximumActions: 5,
  });
  const objective: ObjectiveEnvelope = immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    profileId,
    profileVersion: profile.profileVersion,
    objectiveType: "gate-b.coding.inspect-change",
    objectiveTypeVersion: 1,
    payload: {
      path: SAFE_GREETING_PATH,
      instruction: "Find the greeting call, propose capitalization, and inspect the diff.",
    },
    submittedBy: { kind: "user", id: "gate-b-fixture" },
    submittedAt: GATE_B_OCCURRED_AT,
  });
  return createRuntimeComposition({
    namespace: CODING_SAFE_NAMESPACE,
    driver,
    profile,
    objective,
    snapshot,
    evaluator,
    brokerFactory,
    packs: [pack],
    planner: Object.freeze({ plan: () => [] }),
    counters,
    artifacts: {
      fixtureBefore,
      get fixtureAfter() {
        return repositorySnapshot(repository);
      },
      selectedPath: SAFE_SEARCH_PATH,
      selectedSnippet: SAFE_SEARCH_SNIPPET,
      patch: SAFE_PROPOSED_PATCH,
    },
  });
}

function actionTurn(
  namespace: number,
  ordinal: number,
  reference: (typeof VIRTUAL_REPOSITORY_REFERENCES)[keyof typeof VIRTUAL_REPOSITORY_REFERENCES],
  input: JsonObject,
): readonly AgentDriverEvent[] {
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
    {
      type: "usage_reported",
      dimensions: { inputTokens: 10 + ordinal, outputTokens: 2 + ordinal },
    },
    { type: "completed" },
  ];
}

function outcomeEnvelope(input: {
  readonly namespace: number;
  readonly profileId: string;
  readonly outcomeType: string;
  readonly payload: JsonObject;
}): OutcomeEnvelope {
  return immutable({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    outcomeId: fixedOutcomeId(input.namespace),
    profileId: input.profileId,
    profileVersion: 1,
    outcomeType: input.outcomeType,
    outcomeTypeVersion: 1,
    payload: input.payload,
    evidence: [],
    proposedAt: GATE_B_OCCURRED_AT,
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
  return `${[
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${String(beforeLines.length)} +1,${String(afterLines.length)} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n")}\n`;
}

function logicalLines(content: string): string[] {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}
