import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalize,
  type GenericEventEnvelope,
  type JsonObject,
  type Observation,
} from "@guard/contracts";

import {
  VIRTUAL_REPOSITORY_REFERENCES,
} from "@guard/capability-repository";
import {
  SYNTHETIC_TRANSFORM_REFERENCE,
} from "@guard/capability-synthetic";

import {
  runCodingVirtualRepositoryScenario,
  type CodingScenarioExecution,
} from "./coding-scenario.js";
import {
  runSyntheticTransformScenario,
  type SyntheticScenarioExecution,
} from "./synthetic-scenario.js";

const SYNTHETIC_EVENT_ORDER = [
  "RunCreated",
  "TaskProfilePinned",
  "RunStarted",
  "AgentDriverStarted",
  "AgentAttemptStarted",
  "ContextRequested",
  "ContextReleased",
  "ActionProposed",
  "AgentUsageRecorded",
  "ActionNormalized",
  "PolicyEvaluated",
  "ActionStarted",
  "ActionSucceeded",
  "ObservationReleased",
  "AgentAttemptStarted",
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
  "ActionProposed",
  "AgentUsageRecorded",
  "ActionNormalized",
  "PolicyEvaluated",
  "ActionStarted",
  "ActionSucceeded",
  "ObservationReleased",
  "AgentAttemptStarted",
  "ActionProposed",
  "AgentUsageRecorded",
  "ActionNormalized",
  "PolicyEvaluated",
  "ActionStarted",
  "ActionSucceeded",
  "ObservationReleased",
  "AgentAttemptStarted",
  "ActionProposed",
  "AgentUsageRecorded",
  "ActionNormalized",
  "PolicyEvaluated",
  "ActionStarted",
  "ActionSucceeded",
  "ObservationReleased",
  "AgentAttemptStarted",
  "OutcomeProposed",
  "AgentUsageRecorded",
  "OutcomeValidated",
  "RunCompleted",
] as const;

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

test("synthetic scenario completes through context, one exact action, and a schema-validated outcome", async () => {
  const result = await synthetic();
  assert.equal(result.execution.state.status, "completed");
  assert.equal(result.execution.state.result?.status, "completed");
  assert.deepEqual(eventTypes(result.execution.history), SYNTHETIC_EVENT_ORDER);
  assert.equal(result.expectedTranscript.length, 2);
  assert.equal(result.expectedTranscript[0]?.context.length, 1);
  assert.equal(result.expectedTranscript[0]?.observations.length, 0);
  assert.equal(result.expectedTranscript[1]?.context.length, 1);
  assert.equal(result.expectedTranscript[1]?.observations.length, 1);
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

test("coding scenario uses list/read/propose_patch without mutating its virtual fixture", async () => {
  const result = await coding();
  assert.equal(result.execution.state.status, "completed");
  assert.equal(result.execution.state.result?.status, "completed");
  assert.deepEqual(eventTypes(result.execution.history), CODING_EVENT_ORDER);
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

test("both checked-in histories are complete canonical golden JSON and never updated by tests", async () => {
  const [syntheticResult, codingResult, syntheticGolden, codingGolden] =
    await Promise.all([
      synthetic(),
      coding(),
      readGolden("synthetic-transform.history.json"),
      readGolden("coding-virtual-repository.history.json"),
    ]);
  assertCanonicalGolden(syntheticGolden);
  assertCanonicalGolden(codingGolden);
  assert.equal(canonicalize(syntheticResult.execution.history), syntheticGolden);
  assert.equal(canonicalize(codingResult.execution.history), codingGolden);
});

test("fresh scenario executions are byte-for-byte deterministic", async () => {
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

test("replay reconstructs exact terminal projections while fail-on-effect spies remain untouched", async () => {
  const [syntheticResult, codingResult] = await Promise.all([synthetic(), coding()]);
  for (const result of [syntheticResult, codingResult]) {
    assert.equal(result.replayEffectCalls, 0);
    assert.deepEqual(result.replay.history, result.execution.history);
    assert.deepEqual(result.replay.state, result.execution.state);
    assert.equal(result.replay.state.status, "completed");
  }
});

test("every proposed and normalized action retains the exact advertised pack and operation versions", async () => {
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
});

test("event history contains released views only, and agent observations remain deliberately narrow", async () => {
  const [syntheticResult, codingResult] = await Promise.all([synthetic(), coding()]);
  assertNoPropertyNamedRaw(syntheticResult.execution.history);
  assertNoPropertyNamedRaw(codingResult.execution.history);

  const syntheticObservations = observations(syntheticResult.execution.history);
  assert.equal(syntheticObservations.length, 1);
  assert.deepEqual(agentJson(syntheticObservations[0]!), {
    transformed: "GUARDED AGENTS TRANSFORM BOUNDED DATA.",
  });

  const codingObservations = observations(codingResult.execution.history);
  assert.equal(codingObservations.length, 3);
  assert.deepEqual(agentJson(codingObservations[0]!), {
    files: ["README.md", "src/greet.ts"],
    truncated: false,
  });
  assert.deepEqual(agentJson(codingObservations[1]!), {
    path: "src/greet.ts",
    content: "export function greet(name: string): string {\n  return `hello ${name}`;\n}",
    truncated: false,
  });
  const patchAgentView = agentJson(codingObservations[2]!);
  assert.deepEqual(Object.keys(patchAgentView).sort(), ["patch", "path"]);
  for (const observation of codingObservations) {
    const released = canonicalize(agentJson(observation));
    assert.doesNotMatch(
      released,
      /sourceSha256|preimageSha256|replacementSha256|matchedCount|releasedCount/u,
    );
  }
});

test("generic synthetic entrypoint stays coding-free and scenario implementations own no external-effect integration", async () => {
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

function eventTypes(history: readonly GenericEventEnvelope[]): readonly string[] {
  return history.map((event) => event.eventType);
}

function observations(history: readonly GenericEventEnvelope[]): Observation[] {
  return history.flatMap((event) =>
    event.eventType === "ObservationReleased" ? [event.payload.observation] : [],
  );
}

function agentJson(observation: Observation): JsonObject {
  assert.equal(observation.status, "succeeded");
  assert.equal(observation.error, null);
  assert.equal(observation.agent.length, 1);
  const content = observation.agent[0]!;
  assert.equal(content.modality, "json");
  if (content.modality !== "json" || Array.isArray(content.value)) {
    throw new Error("Expected exactly one JSON-object agent view.");
  }
  assert.equal(typeof content.value, "object");
  assert.notEqual(content.value, null);
  return content.value as JsonObject;
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
  return (await readFile(new URL(`../fixtures/${filename}`, import.meta.url), "utf8")).trim();
}

function assertCanonicalGolden(value: string): void {
  const parsed: unknown = JSON.parse(value);
  assert.equal(canonicalize(parsed), value);
}
