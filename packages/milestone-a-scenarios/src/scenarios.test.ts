import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  type AgentObservation,
  type AgentTurnRequest,
} from "@guard/agent-driver";
import {
  VIRTUAL_REPOSITORY_REFERENCES,
} from "@guard/capability-repository";
import {
  SYNTHETIC_POLICY_SNAPSHOT,
  SYNTHETIC_TASK_PROFILE,
  SYNTHETIC_TRANSFORM_REFERENCE,
} from "@guard/capability-synthetic";
import {
  canonicalBytes,
  canonicalSha256Hex,
  canonicalize,
  parseGenericEvent,
  parseGenericEventEnvelope,
  sha256Hex,
  type ContentBlock,
  type GenericEventEnvelope,
  type JsonObject,
  type Observation,
} from "@guard/contracts";
import { InMemoryEventStore } from "@guard/event-store";

import {
  CODING_VIRTUAL_TASK_PROFILE,
  runCodingVirtualRepositoryScenario,
  type CodingScenarioExecution,
} from "./coding-scenario.js";
import {
  runSyntheticTransformScenario,
  type SyntheticScenarioExecution,
} from "./synthetic-scenario.js";
import {
  FixedRuntimeHostIdFactory,
  REPOSITORY_CONTEXT_POLICY_SOURCE,
  ROOT_CONTEXT_POLICY_SOURCE,
  replayWithFailOnEffectPorts,
} from "./scenario-support.js";

const SYNTHETIC_EVENT_ORDER = [
  "RunCreated",
  "TaskProfilePinned",
  "RunStarted",
  "AgentDriverStarted",
  "AgentAttemptStarted",
  "ContextRequested",
  "ContextManifestRecorded",
  "ContextReleased",
  "ContextManifestRecorded",
  "ActionProposed",
  "AgentUsageRecorded",
  "ActionNormalized",
  "PolicyEvaluated",
  "ActionStarted",
  "ContextManifestRecorded",
  "ActionSucceeded",
  "ObservationReleased",
  "AgentAttemptStarted",
  "ContextManifestRecorded",
  "OutcomeProposed",
  "AgentUsageRecorded",
  "OutcomeValidated",
  "RunCompleted",
] as const;

const CODING_EVENT_ORDER = [
  "RunCreated",
  "TaskProfilePinned",
  "RunStarted",
  "AgentDriverStarted",
  "AgentAttemptStarted",
  "ContextManifestRecorded",
  "ActionProposed",
  "AgentUsageRecorded",
  "ActionNormalized",
  "PolicyEvaluated",
  "ActionStarted",
  "ContextManifestRecorded",
  "ActionSucceeded",
  "ObservationReleased",
  "AgentAttemptStarted",
  "ContextManifestRecorded",
  "ActionProposed",
  "AgentUsageRecorded",
  "ActionNormalized",
  "PolicyEvaluated",
  "ActionStarted",
  "ContextManifestRecorded",
  "ActionSucceeded",
  "ObservationReleased",
  "AgentAttemptStarted",
  "ContextManifestRecorded",
  "ActionProposed",
  "AgentUsageRecorded",
  "ActionNormalized",
  "PolicyEvaluated",
  "ActionStarted",
  "ContextManifestRecorded",
  "ActionSucceeded",
  "ObservationReleased",
  "AgentAttemptStarted",
  "ContextManifestRecorded",
  "OutcomeProposed",
  "AgentUsageRecorded",
  "OutcomeValidated",
  "RunCompleted",
] as const;

const LEGACY_SYNTHETIC_SHA256 =
  "064f5146ee0e7d5458b6a996e491ea64d31d85b3b827505c820d4489b6738808";
const LEGACY_CODING_SHA256 =
  "230324e2ab0d31f847e371814527be346c66df2d900a7486254ea9e23c1ea77c";

let syntheticRun: Promise<SyntheticScenarioExecution> | undefined;
let codingRun: Promise<CodingScenarioExecution> | undefined;

function synthetic(): Promise<SyntheticScenarioExecution> {
  syntheticRun ??= runSyntheticTransformScenario();
  return syntheticRun;
}

function coding(): Promise<CodingScenarioExecution> {
  codingRun ??= runCodingVirtualRepositoryScenario();
  return codingRun;
}

test("synthetic broker-current scenario completes through one exact source and capability release", async () => {
  const result = await synthetic();
  assert.equal(result.execution.state.status, "completed");
  assert.equal(result.execution.state.result?.status, "completed");
  assert.deepEqual(eventTypes(result.execution.history), SYNTHETIC_EVENT_ORDER);
  assert.equal(result.profile.profileVersion, 2);
  assert.equal(result.expectedTranscript.length, 2);
  assert.deepEqual(
    result.expectedTranscript.map((request) => [
      request.context.length,
      request.observations.length,
    ]),
    [[1, 0], [1, 1]],
  );
  assert.equal(
    result.expectedTranscript[0]?.context[0]?.blockId,
    result.expectedContextBlockId,
  );
  assert.equal(
    result.expectedTranscript[1]?.observations[0]?.observationId,
    result.expectedObservationId,
  );
  assert.deepEqual(result.execution.state.validatedOutcome, result.outcome);
});

test("coding broker-current scenario uses list/read/propose_patch without mutating its fixture", async () => {
  const result = await coding();
  assert.equal(result.execution.state.status, "completed");
  assert.equal(result.execution.state.result?.status, "completed");
  assert.deepEqual(eventTypes(result.execution.history), CODING_EVENT_ORDER);
  assert.equal(result.profile.profileVersion, 2);
  assert.equal(result.expectedTranscript.length, 4);
  assert.deepEqual(
    result.expectedTranscript.map((request) => request.observations.length),
    [0, 1, 2, 3],
  );
  assert.deepEqual(result.fixtureAfter, result.fixtureBefore);
  assert.equal(
    (result.fixtureAfter["files"] as JsonObject)["src/greet.ts"],
    "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
  );
  assert.deepEqual(result.execution.state.validatedOutcome, result.outcome);
});

test("legacy v1 histories remain byte-identical while v2 live histories use separate broker-current goldens", async () => {
  const [
    syntheticResult,
    codingResult,
    legacySyntheticBytes,
    legacyCodingBytes,
    currentSynthetic,
    currentCoding,
  ] = await Promise.all([
    synthetic(),
    coding(),
    readFixtureBytes("synthetic-transform.history.json"),
    readFixtureBytes("coding-virtual-repository.history.json"),
    readGolden("synthetic-transform.broker-current.history.json"),
    readGolden("coding-virtual-repository.broker-current.history.json"),
  ]);
  assert.equal(sha256Hex(legacySyntheticBytes), LEGACY_SYNTHETIC_SHA256);
  assert.equal(sha256Hex(legacyCodingBytes), LEGACY_CODING_SHA256);
  assertCanonicalGolden(new TextDecoder().decode(legacySyntheticBytes).trim());
  assertCanonicalGolden(new TextDecoder().decode(legacyCodingBytes).trim());
  assertCanonicalGolden(currentSynthetic);
  assertCanonicalGolden(currentCoding);
  assert.equal(canonicalize(syntheticResult.execution.history), currentSynthetic);
  assert.equal(canonicalize(codingResult.execution.history), currentCoding);

  const legacySynthetic = parseHistoryBytes(legacySyntheticBytes);
  const legacyCoding = parseHistoryBytes(legacyCodingBytes);
  assert.equal(pinnedProfile(legacySynthetic).profileVersion, 1);
  assert.equal(pinnedProfile(legacyCoding).profileVersion, 1);
  assert.equal(syntheticResult.profile.profileVersion, 2);
  assert.equal(codingResult.profile.profileVersion, 2);
});

test("fresh broker-current executions are byte-for-byte deterministic", async () => {
  const [firstSynthetic, firstCoding, secondSynthetic, secondCoding] =
    await Promise.all([
      synthetic(),
      coding(),
      runSyntheticTransformScenario(),
      runCodingVirtualRepositoryScenario(),
    ]);
  assert.equal(
    canonicalize(firstSynthetic.execution.history),
    canonicalize(secondSynthetic.execution.history),
  );
  assert.equal(
    canonicalize(firstCoding.execution.history),
    canonicalize(secondCoding.execution.history),
  );
  assert.deepEqual(firstSynthetic.execution.state, secondSynthetic.execution.state);
  assert.deepEqual(firstCoding.execution.state, secondCoding.execution.state);
});

test("current replay reconstructs exact projections while every effect spy remains untouched", async () => {
  const [syntheticResult, codingResult] = await Promise.all([synthetic(), coding()]);
  for (const result of [syntheticResult, codingResult]) {
    assert.equal(result.replayEffectCalls, 0);
    assert.deepEqual(result.replay.history, result.execution.history);
    assert.deepEqual(result.replay.state, result.execution.state);
    assert.equal(result.replay.state.status, "completed");
  }
});

test("legacy v1 fixtures replay through the current pure reducer with zero live-port calls", async () => {
  for (const filename of [
    "synthetic-transform.history.json",
    "coding-virtual-repository.history.json",
  ]) {
    const history = parseHistoryBytes(await readFixtureBytes(filename));
    const eventStore = new InMemoryEventStore({
      now: () => history[0]!.recordedAt,
    });
    const runId = history[0]!.streamId;
    const events = history.map((envelope) => {
      const candidate = { ...envelope } as Record<string, unknown>;
      delete candidate["streamId"];
      delete candidate["streamVersion"];
      delete candidate["recordedAt"];
      return parseGenericEvent(candidate);
    });
    const recorded = await eventStore.append(runId, 0, events);
    assert.deepEqual(recorded, history);
    const replayed = await replayWithFailOnEffectPorts(eventStore, runId);
    assert.equal(replayed.effectCalls, 0);
    assert.deepEqual(replayed.replay.history, history);
    assert.equal(replayed.replay.state.status, "completed");
  }
});

test("every proposed and normalized action retains exact advertised versions", async () => {
  const [syntheticResult, codingResult] = await Promise.all([synthetic(), coding()]);
  assert.deepEqual(actionIdentities(syntheticResult.execution.history), [
    exactReference(SYNTHETIC_TRANSFORM_REFERENCE, "proposed"),
    exactReference(SYNTHETIC_TRANSFORM_REFERENCE, "normalized"),
  ]);
  assert.deepEqual(actionIdentities(codingResult.execution.history), [
    exactReference(VIRTUAL_REPOSITORY_REFERENCES.list, "proposed"),
    exactReference(VIRTUAL_REPOSITORY_REFERENCES.list, "normalized"),
    exactReference(VIRTUAL_REPOSITORY_REFERENCES.read, "proposed"),
    exactReference(VIRTUAL_REPOSITORY_REFERENCES.read, "normalized"),
    exactReference(VIRTUAL_REPOSITORY_REFERENCES.patch, "proposed"),
    exactReference(VIRTUAL_REPOSITORY_REFERENCES.patch, "normalized"),
  ]);
  assert.equal(codingResult.expectedTranscript[0]!.advertisedOperations.length, 5);
});

test("v2 profiles pin new unified policy identities, exact catalogs, and broker descriptors", async () => {
  const [syntheticResult, codingResult, legacySynthetic, legacyCoding] =
    await Promise.all([
      synthetic(),
      coding(),
      readHistory("synthetic-transform.history.json"),
      readHistory("coding-virtual-repository.history.json"),
    ]);
  const expectations = [
    {
      result: syntheticResult,
      legacy: pinnedProfile(legacySynthetic),
      legacyPolicyId: SYNTHETIC_POLICY_SNAPSHOT.policyVersionId,
      catalogs: ["guard.base", "guard.context", "guard.memory"],
      winner: "allow-synthetic-transform",
      decisionCount: 1,
      sourceVersion: 2,
    },
    {
      result: codingResult,
      legacy: pinnedProfile(legacyCoding),
      legacyPolicyId: pinnedPolicyManifest(legacyCoding)["policyVersionId"],
      catalogs: ["guard.base", "guard.context", "guard.repo"],
      winner: "allow-virtual-repository-operations",
      decisionCount: 3,
      sourceVersion: null,
    },
  ] as const;

  for (const expectation of expectations) {
    const { result } = expectation;
    const profile = result.profile;
    const manifest = profile.policyProfile.configuration;
    assert.equal(expectation.legacy.profileVersion, 1);
    assert.equal(profile.profileVersion, 2);
    assert.equal(profile.driverProfile.componentVersion, 1);
    assert.match(
      profile.driverProfile.configuration["scriptId"] as string,
      /broker-current/u,
    );
    assert.equal(profile.policyProfile.componentVersion, 2);
    assert.notEqual(manifest["policyVersionId"], expectation.legacyPolicyId);
    assert.notEqual(
      manifest["policyContentHash"],
      expectation.legacy.policyProfile.configuration["policyContentHash"],
    );
    assert.deepEqual(
      (manifest["attributeCatalogs"] as readonly JsonObject[]).map(
        (entry) => entry["catalogId"],
      ),
      expectation.catalogs,
    );
    const brokerDescriptor = profile.budgetPolicy.extensions["contextBroker"];
    assert.equal(typeof brokerDescriptor, "object");
    assert.equal(
      (brokerDescriptor as JsonObject)["policySnapshotId"],
      manifest["policyVersionId"],
    );
    assert.deepEqual(
      profile.contextSources.map((binding) => ({
        sourceId: binding.componentId,
        sourceVersion: binding.componentVersion,
      })),
      ((brokerDescriptor as JsonObject)["sourceDescriptors"] as readonly JsonObject[])
        .map((descriptor) => ({
          sourceId: descriptor["sourceId"],
          sourceVersion: descriptor["sourceVersion"],
        })),
    );
    if (expectation.sourceVersion !== null) {
      assert.equal(profile.contextSources[0]?.componentVersion, 2);
      assert.equal(expectation.sourceVersion, 2);
    }

    const decisions = result.execution.history.filter(
      (event) => event.eventType === "PolicyEvaluated",
    );
    assert.equal(decisions.length, expectation.decisionCount);
    for (const decision of decisions) {
      if (decision.eventType !== "PolicyEvaluated") continue;
      assert.equal(decision.payload.decision, "allow");
      assert.equal(decision.payload.policyVersionId, manifest["policyVersionId"]);
      assert.equal(decision.payload.trace["result"], "allow");
      assert.equal(
        decision.payload.trace["winningPolicyName"],
        expectation.winner,
      );
      assert.deepEqual(
        decision.payload.trace["attributeCatalogs"],
        manifest["attributeCatalogs"],
      );
    }
  }

  assert.equal(SYNTHETIC_TASK_PROFILE.profileVersion, 1);
  assert.equal(SYNTHETIC_TASK_PROFILE.contextSources[0]?.componentVersion, 1);
  assert.equal(SYNTHETIC_TASK_PROFILE.policyProfile.componentVersion, 1);
  assert.equal(CODING_VIRTUAL_TASK_PROFILE.profileVersion, 2);
});

test("release and agent-input manifests reconcile every broker block and exact request hash", async () => {
  const [syntheticResult, codingResult] = await Promise.all([synthetic(), coding()]);
  for (const result of [syntheticResult, codingResult]) {
    assertManifestEvidence(result.execution.history, result.expectedTranscript);
  }
});

test("broker context is reused stably and every exact request remains within its pinned input budget", async () => {
  const [syntheticResult, codingResult] = await Promise.all([synthetic(), coding()]);
  assert.equal(
    canonicalize(syntheticResult.expectedTranscript[0]!.context[0]),
    canonicalize(syntheticResult.expectedTranscript[1]!.context[0]),
  );
  for (let turn = 1; turn < codingResult.expectedTranscript.length; turn += 1) {
    const current = codingResult.expectedTranscript[turn]!;
    const previous = codingResult.expectedTranscript[turn - 1]!;
    assert.deepEqual(
      current.observations.slice(0, previous.observations.length),
      previous.observations,
    );
  }
  for (const result of [syntheticResult, codingResult]) {
    for (const request of result.expectedTranscript) {
      assert.ok(
        canonicalBytes(request).byteLength <= result.profile.budgetPolicy.maxInputBytes,
        `turn ${String(request.turnNumber)} exceeds the pinned input budget`,
      );
    }
  }
});

test("event observations retain audit/human views while driver observations expose only broker content", async () => {
  const [syntheticResult, codingResult] = await Promise.all([synthetic(), coding()]);
  assertNoPropertyNamedRaw(syntheticResult.execution.history);
  assertNoPropertyNamedRaw(codingResult.execution.history);

  const syntheticObservations = observations(syntheticResult.execution.history);
  assert.equal(syntheticObservations.length, 1);
  assert.deepEqual(agentOutput(syntheticObservations[0]!), {
    transformed: "GUARDED AGENTS TRANSFORM BOUNDED DATA.",
  });

  const codingObservations = observations(codingResult.execution.history);
  assert.equal(codingObservations.length, 3);
  assert.deepEqual(agentOutput(codingObservations[0]!), {
    files: ["src/greet.ts"],
    truncated: false,
  });
  assert.deepEqual(agentOutput(codingObservations[1]!), {
    path: "src/greet.ts",
    content: "export function greet(name: string): string {\n  return `hello ${name}`;\n}",
    truncated: false,
  });
  assert.deepEqual(Object.keys(agentOutput(codingObservations[2]!)).sort(), [
    "patch",
    "path",
  ]);

  for (const result of [syntheticResult, codingResult]) {
    for (const request of result.expectedTranscript) {
      for (const observation of request.observations) {
        assertStrictAgentObservation(observation);
      }
    }
    for (const eventObservation of observations(result.execution.history)) {
      assert.ok(Object.keys(eventObservation.audit).length > 0);
      assert.equal(eventObservation.human.length, 1);
      assert.equal(eventObservation.agent.length, 1);
    }
  }
});

test("embedded policy inputs are byte-identical to their repository sources", async () => {
  const [rootPolicy, repositoryPolicy] = await Promise.all([
    readFile(new URL("../../../policies/context.guard", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../../capability-repository/policies/context.guard",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.equal(ROOT_CONTEXT_POLICY_SOURCE, rootPolicy);
  assert.equal(REPOSITORY_CONTEXT_POLICY_SOURCE, repositoryPolicy);
  assert.equal(sha256Hex(ROOT_CONTEXT_POLICY_SOURCE), sha256Hex(rootPolicy));
  assert.equal(
    sha256Hex(REPOSITORY_CONTEXT_POLICY_SOURCE),
    sha256Hex(repositoryPolicy),
  );
});

test("the deterministic ID source owns a distinct approval sequence", () => {
  const ids = new FixedRuntimeHostIdFactory(1);
  assert.equal(
    ids.nextApprovalId(),
    "apr_018f0001-0000-7000-8000-0b0000000001",
  );
  assert.equal(
    ids.nextApprovalId(),
    "apr_018f0001-0000-7000-8000-0b0000000002",
  );
});

test("generic synthetic entrypoint stays coding-free and live scenarios own no external-effect integration", async () => {
  const [syntheticSource, codingSource, supportSource] = await Promise.all([
    readFile(new URL("./synthetic-scenario.js", import.meta.url), "utf8"),
    readFile(new URL("./coding-scenario.js", import.meta.url), "utf8"),
    readFile(new URL("./scenario-support.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(syntheticSource, /capability-repository|VirtualRepository/u);
  assert.match(codingSource, /@guard\/capability-repository/u);
  assert.doesNotMatch(supportSource, /\bProxy\b/u);
  for (const source of [syntheticSource, codingSource, supportSource]) {
    assert.doesNotMatch(
      source,
      /@guard\/model-provider|node:child_process|node:fs|node:net|node:http|node:https|process\./u,
    );
  }
});

function assertManifestEvidence(
  history: readonly GenericEventEnvelope[],
  transcript: readonly AgentTurnRequest[],
): void {
  const releaseEvents = history.filter(
    (event) =>
      event.eventType === "ContextManifestRecorded" &&
      event.payload.manifestKind === "release",
  );
  const inputEvents = history.filter(
    (event) =>
      event.eventType === "ContextManifestRecorded" &&
      event.payload.manifestKind === "agent_input",
  );
  assert.ok(releaseEvents.length > 0);
  assert.equal(inputEvents.length, transcript.length);

  const blocks = new Map<string, ContentBlock>();
  for (const request of transcript) {
    for (const block of [
      ...request.context,
      ...request.observations.flatMap((observation) => observation.content),
    ]) {
      blocks.set(block.blockId, block);
    }
  }
  for (const event of releaseEvents) {
    if (event.eventType !== "ContextManifestRecorded") continue;
    const manifest = event.payload.manifest;
    assert.equal(manifest["status"], "released");
    const itemId = manifest["itemId"];
    assert.equal(typeof itemId, "string");
    const block = blocks.get(itemId as string);
    assert.notEqual(block, undefined);
    if (block?.modality !== "json") {
      throw new Error("A released broker block must use JSON modality.");
    }
    assert.equal(manifest["releasedContentHash"], block?.contentHash);
    assert.equal(manifest["byteLength"], block?.byteLength);
    assert.equal(canonicalSha256Hex(block.value), block.contentHash);
    assert.equal(canonicalBytes(block.value).byteLength, block.byteLength);
  }

  const requests = new Map(
    transcript.map((request) => [request.attemptId, request] as const),
  );
  for (const event of inputEvents) {
    if (event.eventType !== "ContextManifestRecorded") continue;
    const request = requests.get(event.payload.referenceId as AgentTurnRequest["attemptId"]);
    assert.notEqual(request, undefined);
    const wrapper = event.payload.manifest;
    assert.equal(wrapper["schemaVersion"], 1);
    assert.equal(wrapper["agentTurnRequestHash"], canonicalSha256Hex(request));
    const assembly = wrapper["assemblyManifest"] as JsonObject;
    const expectedIds = [
      ...(request?.context ?? []),
      ...(request?.observations ?? []).flatMap(
        (observation) => observation.content,
      ),
    ].map((block) => block.blockId);
    assert.deepEqual(assembly["orderedItemIds"], expectedIds);
    assert.deepEqual(
      (assembly["entries"] as readonly JsonObject[]).map(
        (entry) => entry["itemId"],
      ),
      expectedIds,
    );
    const totalBytes = expectedIds.reduce(
      (total, itemId) => total + blocks.get(itemId)!.byteLength,
      Math.max(0, expectedIds.length - 1),
    );
    assert.equal(assembly["totalBytes"], totalBytes);
  }
}

function assertStrictAgentObservation(observation: AgentObservation): void {
  assert.deepEqual(Object.keys(observation).sort(), [
    "actionId",
    "content",
    "error",
    "observationId",
    "occurredAt",
    "schemaVersion",
    "status",
  ]);
  assert.equal(Object.hasOwn(observation, "audit"), false);
  assert.equal(Object.hasOwn(observation, "human"), false);
  assert.equal(Object.hasOwn(observation, "agent"), false);
  assert.equal(observation.status, "succeeded");
  assert.equal(observation.error, null);
  assert.equal(observation.content.length, 1);
  const block = observation.content[0]!;
  assert.equal(block.modality, "json");
  if (block.modality !== "json") return;
  assert.equal((block.value as JsonObject)["kind"], "capability_output");
  assert.equal((block.value as JsonObject)["untrusted"], true);
}

function eventTypes(history: readonly GenericEventEnvelope[]): readonly string[] {
  return history.map((event) => event.eventType);
}

function observations(history: readonly GenericEventEnvelope[]): Observation[] {
  return history.flatMap((event) =>
    event.eventType === "ObservationReleased" ? [event.payload.observation] : [],
  );
}

function agentOutput(observation: Observation): JsonObject {
  assert.equal(observation.status, "succeeded");
  assert.equal(observation.error, null);
  assert.equal(observation.agent.length, 1);
  const content = observation.agent[0]!;
  assert.equal(content.modality, "json");
  if (content.modality !== "json" || Array.isArray(content.value)) {
    throw new Error("Expected exactly one broker JSON-object agent view.");
  }
  const envelope = content.value as JsonObject;
  assert.equal(envelope["kind"], "capability_output");
  assert.equal(envelope["untrusted"], true);
  const output = envelope["output"];
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new Error("Expected one capability-output object.");
  }
  return output as JsonObject;
}

function actionIdentities(history: readonly GenericEventEnvelope[]): JsonObject[] {
  return history.flatMap((event) => {
    if (event.eventType === "ActionProposed") {
      return [
        {
          phase: "proposed",
          packId: event.payload.capabilityPackId,
          packVersion: event.payload.capabilityPackVersion,
          operationId: event.payload.operationId,
          operationVersion: event.payload.operationVersion,
        },
      ];
    }
    if (event.eventType === "ActionNormalized") {
      return [
        {
          phase: "normalized",
          packId: event.payload.action.capabilityPackId,
          packVersion: event.payload.action.capabilityPackVersion,
          operationId: event.payload.action.operationId,
          operationVersion: event.payload.action.operationVersion,
        },
      ];
    }
    return [];
  });
}

function exactReference(
  reference: {
    readonly packId: string;
    readonly packVersion: number;
    readonly operationId: string;
    readonly operationVersion: number;
  },
  phase: "proposed" | "normalized",
): JsonObject {
  return { phase, ...reference };
}

function assertNoPropertyNamedRaw(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoPropertyNamedRaw);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  assert.equal(Object.hasOwn(value, "raw"), false, "raw adapter output entered history");
  Object.values(value).forEach(assertNoPropertyNamedRaw);
}

async function readGolden(filename: string): Promise<string> {
  return new TextDecoder().decode(await readFixtureBytes(filename)).trim();
}

async function readHistory(filename: string): Promise<GenericEventEnvelope[]> {
  return parseHistoryBytes(await readFixtureBytes(filename));
}

async function readFixtureBytes(filename: string): Promise<Uint8Array> {
  return readFile(new URL(`../fixtures/${filename}`, import.meta.url));
}

function parseHistoryBytes(bytes: Uint8Array): GenericEventEnvelope[] {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(parsed)) throw new Error("A history fixture must be an array.");
  return parsed.map((event) => parseGenericEventEnvelope(event));
}

function pinnedProfile(history: readonly GenericEventEnvelope[]) {
  const event = history.find((candidate) => candidate.eventType === "TaskProfilePinned");
  if (event?.eventType !== "TaskProfilePinned") {
    throw new Error("History has no pinned task profile.");
  }
  return event.payload.taskProfile;
}

function pinnedPolicyManifest(history: readonly GenericEventEnvelope[]): JsonObject {
  return pinnedProfile(history).policyProfile.configuration;
}

function assertCanonicalGolden(value: string): void {
  const parsed: unknown = JSON.parse(value);
  assert.equal(canonicalize(parsed), value);
}
