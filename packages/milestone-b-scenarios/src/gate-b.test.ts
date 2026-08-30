import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { REPOSITORY_POLICY_ATTRIBUTE_CATALOG } from "@guard/capability-repository";
import {
  canonicalBytes,
  canonicalSha256Hex,
  canonicalize,
  sha256Hex,
  type GenericEventEnvelope,
  type JsonObject,
} from "@guard/contracts";

import {
  createCredentialCanaryCorpus,
} from "./adversarial-fixtures.js";
import {
  runBrokerInfrastructureFailureScenario,
  runConfigurationMismatchProbe,
  runCredentialCorpusScenario,
  runInjectionAuthorityScenario,
  runRepositoryOutputCanaryScenario,
  runRepositoryPathOutputScenario,
  runRepositoryPathPolicyScenario,
  runSafeInputSecretContentScenario,
  runSourceDenialScenario,
  runSplitSecretAssemblyScenario,
} from "./adversarial-scenarios.js";
import {
  mapAgentTurnToSemanticRequest,
  scanEvidenceSurfaces,
} from "./provider-boundary-probe.js";
import {
  REPOSITORY_CONTEXT_POLICY_SOURCE,
  ROOT_CONTEXT_POLICY_SOURCE,
  type GateBScenarioResult,
} from "./scenario-support.js";
import {
  SAFE_GREETING_PATH,
  SAFE_PROPOSED_PATCH,
  SAFE_SEARCH_PATH,
  SAFE_SEARCH_SNIPPET,
  runCodingSafeScenario,
  runGenericSafeScenario,
} from "./safe-scenarios.js";

let genericSafe: ReturnType<typeof runGenericSafeScenario> | undefined;
let codingSafe: ReturnType<typeof runCodingSafeScenario> | undefined;

function genericSafeRun() {
  genericSafe ??= runGenericSafeScenario();
  return genericSafe;
}

function codingSafeRun() {
  codingSafe ??= runCodingSafeScenario();
  return codingSafe;
}

test("Gate B: generic success crosses broker and exact synthetic provider boundaries", async () => {
  const result = await genericSafeRun();
  assert.equal(result.execution.state.status, "completed");
  assertExactProviderBoundary(result);
  assertBrokerManifestsReconcile(result);
  assertReplayPurity(result);
  assert.deepEqual(result.countersAtCompletion, {
    driverCalls: 2,
    providerCalls: 2,
    normalizations: 1,
    executions: 1,
    releases: 1,
    sourceNormalizations: 1,
    sourceMetadataReads: 1,
    sourceOpens: 1,
  });
  const providerSurface = decodedProviderRequests(result).join("\n");
  assert.match(providerSurface, /Guarded agents transform bounded data\./u);
  assert.match(providerSurface, /GUARDED AGENTS TRANSFORM BOUNDED DATA\./u);
  assert.doesNotMatch(providerSurface, /Transformed 38 bytes/u);
  assert.doesNotMatch(providerSurface, /"inputBytes"/u);
  assert.equal(
    readGolden("generic-safe.history.json"),
    canonicalize(result.execution.history),
  );
  assert.equal(
    readGolden("generic-safe.provider-requests.json"),
    canonicalize(decodedProviderRequests(result)),
  );
});

test("Gate B: coding success releases all five virtual operations and exact bytes", async () => {
  const result = await codingSafeRun();
  assert.equal(result.execution.state.status, "completed");
  assertExactProviderBoundary(result);
  assertBrokerManifestsReconcile(result);
  assertReplayPurity(result);
  assert.equal(result.transcript.requests.length, 6);
  assert.deepEqual(result.countersAtCompletion, {
    driverCalls: 6,
    providerCalls: 6,
    normalizations: 5,
    executions: 5,
    releases: 5,
    sourceNormalizations: 0,
    sourceMetadataReads: 0,
    sourceOpens: 0,
  });
  const releases = releaseManifests(result.execution.history).filter(
    (manifest) => manifest["status"] === "released",
  );
  assert.equal(releases.length, 5);
  const providerSurface = decodedProviderRequests(result).join("\n");
  for (const expected of [
    SAFE_GREETING_PATH,
    SAFE_SEARCH_PATH,
    SAFE_SEARCH_SNIPPET,
  ]) {
    assert.equal(providerSurface.includes(expected), true, expected);
  }
  assert.equal(
    providerSurface.includes(canonicalize(SAFE_PROPOSED_PATCH)),
    true,
    "the exact JSON-encoded proposal/diff must reach the provider boundary",
  );
  assert.doesNotMatch(providerSurface, /no repository content was changed/u);
  assert.doesNotMatch(providerSurface, /"applied"/u);
  assert.doesNotMatch(providerSurface, /errorId/u);
  assert.deepEqual(result.artifacts.fixtureAfter, result.artifacts.fixtureBefore);
  assert.equal(
    readGolden("coding-safe.history.json"),
    canonicalize(result.execution.history),
  );
  assert.equal(
    readGolden("coding-safe.provider-requests.json"),
    canonicalize(decodedProviderRequests(result)),
  );
});

test("Gate B: checked-in safe evidence is fully deterministic", async () => {
  const [genericFirst, codingFirst, genericSecond, codingSecond] = await Promise.all([
    genericSafeRun(),
    codingSafeRun(),
    runGenericSafeScenario(),
    runCodingSafeScenario(),
  ]);
  assert.equal(
    canonicalize(genericSecond.execution.history),
    canonicalize(genericFirst.execution.history),
  );
  assert.equal(
    canonicalize(codingSecond.execution.history),
    canonicalize(codingFirst.execution.history),
  );
  assert.deepEqual(
    decodedProviderRequests(genericSecond),
    decodedProviderRequests(genericFirst),
  );
  assert.deepEqual(
    decodedProviderRequests(codingSecond),
    decodedProviderRequests(codingFirst),
  );
});

test("Gate B: credential-shaped raw, encoded, split, filename, identifier, search, and summary forms never surface", async () => {
  const result = await runCredentialCorpusScenario();
  const corpus = createCredentialCanaryCorpus();
  const forbidden = Object.values(corpus);
  assert.equal(result.execution.state.status, "completed");
  assert.equal(result.transcript.providerCallCount, 2);
  assert.equal(result.countersAtCompletion.executions, 1);
  assert.equal(result.countersAtCompletion.releases, 1);
  assert.equal(eventCount(result.execution.history, "ActionSucceeded"), 1);
  const denied = releaseManifests(result.execution.history).find(
    (manifest) => manifest["status"] === "denied",
  );
  assert.equal(denied?.["reason"], "context.release.secret_denied");
  const second = result.transcript.requests[1]!;
  assert.equal(second.observations.length, 1);
  assert.equal(second.observations[0]!.status, "denied");
  assert.deepEqual(second.observations[0]!.content, []);
  assert.equal(second.observations[0]!.error?.code, "policy_denied");
  const eventObservation = observationPayloads(result.execution.history)[0]!;
  assert.equal(eventObservation["status"], "succeeded");
  assert.deepEqual(eventObservation["agent"], []);
  assert.equal(
    scanResult(result, forbidden).length,
    0,
    "a credential canary reached a provider, driver, ledger, manifest, or artifact",
  );
  const providerSurface = decodedProviderRequests(result).join("\n");
  assert.doesNotMatch(providerSurface, /classificationAttempted/u);
  assert.doesNotMatch(providerSurface, /internal classification fixture completed/u);
  assertReplayPurity(result);
});

test("Gate B: restricted, opaque-media, and real .env repository sources deny before bytes", async (context) => {
  const corpus = createCredentialCanaryCorpus();
  for (const fixture of [
    {
      kind: "restricted" as const,
      reason: "context.policy.metadata_denied",
      scheme: "memory",
    },
    { kind: "opaque-media" as const, reason: "unsupported_media", scheme: "memory" },
    {
      kind: "repository-env" as const,
      reason: "context.policy.metadata_denied",
      scheme: "repo",
    },
  ]) {
    await context.test(fixture.kind, async () => {
      const result = await runSourceDenialScenario(fixture.kind);
      assert.equal(result.execution.state.status, "completed");
      assert.equal(result.countersAtCompletion.sourceNormalizations, 1);
      assert.equal(result.countersAtCompletion.sourceMetadataReads, 1);
      assert.equal(result.countersAtCompletion.sourceOpens, 0);
      assert.equal(result.transcript.providerCallCount, 1);
      const denied = releaseManifests(result.execution.history).find(
        (manifest) => manifest["status"] === "denied",
      );
      assert.equal(denied?.["reason"], fixture.reason);
      const requested = payloads(result.execution.history, "ContextRequested")[0]!;
      const resource = objectField(requested, "resource");
      assert.equal(resource["scheme"], fixture.scheme);
      assert.equal(resource["classification"], "unreviewed");
      assert.deepEqual(resource["locator"], { bindingId: "subject" });
      const forbidden = [
        corpus.raw,
        corpus.percent,
        corpus.base64,
        corpus.escaped,
        [".env", ".", corpus.raw].join(""),
      ];
      assert.equal(scanResult(result, forbidden).length, 0);
      assertEmptyAssemblyRecorded(result.execution.history);
      assertReplayPurity(result);
    });
  }
});

test("Gate B: tagged prompt injection cannot authorize a consequential operation", async () => {
  const result = await runInjectionAuthorityScenario();
  assert.equal(result.execution.state.status, "completed");
  assert.equal(result.transcript.providerCallCount, 3);
  assert.equal(result.countersAtCompletion.normalizations, 2);
  assert.equal(result.countersAtCompletion.executions, 1);
  assert.equal(result.artifacts.executeSpy, 0);
  assert.equal(eventCount(result.execution.history, "ActionProposed"), 2);
  assert.equal(eventCount(result.execution.history, "ActionStarted"), 1);
  const released = releaseManifests(result.execution.history).find(
    (manifest) => manifest["status"] === "released",
  )!;
  assert.deepEqual(released["promptInjectionTags"], [
    "instruction_override",
    "secret_exfiltration",
    "tool_coercion",
  ]);
  const providerSurface = decodedProviderRequests(result).join("\n");
  assert.equal(providerSurface.includes(result.artifacts.claim), true);
  assert.doesNotMatch(providerSurface, /Released 1 of 1 literal match/u);
  assert.doesNotMatch(providerSurface, /querySha256/u);
  const finalRequest = result.transcript.requests[2]!;
  assert.equal(finalRequest.observations[1]!.status, "denied");
  assert.deepEqual(finalRequest.observations[1]!.content, []);
  assertReplayPurity(result);
});

test("Gate B: mixed safe and .env search/inspect inputs are denied before repository reads or handlers", async () => {
  for (const kind of ["search", "inspect"] as const) {
    const result = await runRepositoryPathOutputScenario(kind);
    assert.equal(result.execution.state.status, "completed");
    assert.deepEqual(result.countersAtCompletion, {
      driverCalls: 2,
      providerCalls: 2,
      normalizations: 1,
      executions: 0,
      releases: 0,
      sourceNormalizations: 0,
      sourceMetadataReads: 0,
      sourceOpens: 0,
    });
    assert.equal(result.artifacts.executeSpy, 0);
    assert.equal(result.artifacts.repositoryReads, 0);
    assert.equal(eventCount(result.execution.history, "ActionProposed"), 1);
    assert.equal(eventCount(result.execution.history, "ActionDenied"), 1);
    assert.equal(eventCount(result.execution.history, "ActionStarted"), 0);
    assert.equal(eventCount(result.execution.history, "ActionSucceeded"), 0);
    assert.equal(releaseManifests(result.execution.history).length, 0);
    assert.equal(result.transcript.requests[1]!.observations[0]!.status, "denied");
    assert.deepEqual(result.transcript.requests[1]!.observations[0]!.content, []);
    assert.equal(result.transcript.requests[1]!.observations[0]!.error?.code, "policy_denied");
    assertReplayPurity(result);
  }
});

test("Gate B: permissive list/search/inspect actions execute once but output paths are independently broker-denied", async () => {
  const expectedReads = { list: 0, search: 2, inspect: 2 } as const;
  for (const kind of ["list", "search", "inspect"] as const) {
    const result = await runRepositoryOutputCanaryScenario(kind);
    const deniedPath = `fixtures/.env.gate-b-${kind}-output-marker`;
    assert.equal(result.execution.state.status, "completed");
    assert.deepEqual(result.countersAtCompletion, {
      driverCalls: 2,
      providerCalls: 2,
      normalizations: 1,
      executions: 1,
      releases: 1,
      sourceNormalizations: 0,
      sourceMetadataReads: 0,
      sourceOpens: 0,
    });
    assert.equal(result.artifacts.executeSpy, 1);
    assert.equal(result.artifacts.repositoryReads, expectedReads[kind]);
    assert.equal(eventCount(result.execution.history, "ActionStarted"), 1);
    assert.equal(eventCount(result.execution.history, "ActionSucceeded"), 1);
    const denied = releaseManifests(result.execution.history).filter(
      (manifest) => manifest["status"] === "denied",
    );
    assert.equal(denied.length, 1);
    assert.equal(denied[0]!["reason"], "context.policy.metadata_denied");
    const observation = result.transcript.requests[1]!.observations[0]!;
    assert.equal(observation.status, "denied");
    assert.deepEqual(observation.content, []);
    assert.equal(observation.error?.code, "policy_denied");
    assertRuntimeDeniedDisposition(result.execution.history);
    assert.equal(decodedProviderRequests(result).join("\n").includes(deniedPath), false);
    if (kind === "list") {
      assert.equal(
        scanResult(result, [deniedPath]).length,
        0,
        "a list-only output path survived broker denial",
      );
    }
    assertReplayPurity(result);
  }
});

test("Gate B: safe-path read/propose secret content and its raw hash survive on no evidence surface", async () => {
  const secret = createCredentialCanaryCorpus().raw;
  const secretHash = sha256Hex(secret);
  for (const kind of ["read", "propose"] as const) {
    const result = await runSafeInputSecretContentScenario(kind);
    assert.equal(result.execution.state.status, "completed");
    assert.deepEqual(result.countersAtCompletion, {
      driverCalls: 2,
      providerCalls: 2,
      normalizations: 1,
      executions: 1,
      releases: 1,
      sourceNormalizations: 0,
      sourceMetadataReads: 0,
      sourceOpens: 0,
    });
    assert.equal(result.artifacts.executeSpy, 1);
    assert.equal(result.artifacts.repositoryReads, 1);
    assert.equal(eventCount(result.execution.history, "ActionStarted"), 1);
    assert.equal(eventCount(result.execution.history, "ActionSucceeded"), 1);
    const denied = releaseManifests(result.execution.history).filter(
      (manifest) => manifest["status"] === "denied",
    );
    assert.equal(denied.length, 1);
    assert.equal(denied[0]!["reason"], "context.release.secret_denied");
    const observation = result.transcript.requests[1]!.observations[0]!;
    assert.equal(observation.status, "denied");
    assert.deepEqual(observation.content, []);
    assert.equal(observation.error?.code, "policy_denied");
    assertRuntimeDeniedDisposition(result.execution.history);
    assert.equal(
      scanResult(result, [secret, secretHash]).length,
      0,
      `${kind} persisted raw secret content or sha256(secret) after broker denial`,
    );
    assertReplayPurity(result);
  }
});

test("Gate B: scalar .env proposal and inspection paths remain action-policy denied", async () => {
  const pathDenied = await runRepositoryPathPolicyScenario();
  assert.equal(pathDenied.execution.state.status, "completed");
  assert.deepEqual(pathDenied.countersAtCompletion, {
    driverCalls: 3,
    providerCalls: 3,
    normalizations: 2,
    executions: 0,
    releases: 0,
    sourceNormalizations: 0,
    sourceMetadataReads: 0,
    sourceOpens: 0,
  });
  assert.equal(eventCount(pathDenied.execution.history, "ActionStarted"), 0);
  assert.equal(
    decodedProviderRequests(pathDenied).join("\n").includes(pathDenied.artifacts.claim),
    false,
  );
  assertReplayPurity(pathDenied);
});

test("Gate B: split secrets and broker infrastructure failures fail closed at their actual boundaries", async () => {
  const split = await runSplitSecretAssemblyScenario();
  assert.equal(split.execution.state.status, "failed");
  assert.equal(split.execution.state.result?.status, "failed");
  assert.equal(split.execution.state.result?.status === "failed" ? split.execution.state.result.error.code : null, "policy_denied");
  assert.equal(split.transcript.driverCallCount, 0);
  assert.equal(split.transcript.providerCallCount, 0);
  assert.equal(split.countersAtCompletion.sourceOpens, 2);
  assert.equal(
    canonicalize(split.execution.history).includes(createCredentialCanaryCorpus().raw),
    false,
  );
  assertReplayPurity(split);

  const infrastructure = await runBrokerInfrastructureFailureScenario();
  assert.equal(infrastructure.execution.state.status, "completed");
  assert.equal(infrastructure.countersAtCompletion.sourceMetadataReads, 1);
  assert.equal(infrastructure.countersAtCompletion.sourceOpens, 0);
  assert.equal(infrastructure.transcript.providerCallCount, 1);
  const denied = payloads(infrastructure.execution.history, "ContextDenied")[0]!;
  assert.equal(objectField(denied, "error")["code"], "infrastructure_failed");
  assert.equal(
    canonicalize(infrastructure.execution.history).includes(
      "private source adapter failure detail",
    ),
    false,
  );
  assertEmptyAssemblyRecorded(infrastructure.execution.history);
  assertReplayPurity(infrastructure);
});

test("Gate B: broker configuration mismatch and attempted mutation stop before ledger and provider effects", async () => {
  const result = await runConfigurationMismatchProbe();
  assert.equal(result.errorCode, "invalid_input");
  assert.equal(result.historyLength, 0);
  assert.equal(result.transcript.driverCallCount, 0);
  assert.equal(result.transcript.providerCallCount, 0);
  assert.equal(result.transcript.capturedRequestBytes.length, 0);
  assert.equal(result.descriptorFrozen, true);
  assert.equal(result.mutationAccepted, false);
});

test("Gate B: installed root and repository context policies remain byte-exact", () => {
  assert.equal(
    readFileSync(new URL("../../../policies/context.guard", import.meta.url), "utf8"),
    ROOT_CONTEXT_POLICY_SOURCE,
  );
  assert.equal(
    readFileSync(
      new URL("../../capability-repository/policies/context.guard", import.meta.url),
      "utf8",
    ),
    REPOSITORY_CONTEXT_POLICY_SOURCE,
  );
  assert.equal(REPOSITORY_POLICY_ATTRIBUTE_CATALOG.catalogId, "guard.repo");
  assert.equal(REPOSITORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion, 3);
  assert.match(REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash, /^[a-f0-9]{64}$/u);
});

function assertExactProviderBoundary(result: GateBScenarioResult<unknown>): void {
  assert.equal(result.transcript.driverCallCount, result.expectedRequests.length);
  assert.equal(result.transcript.requests.length, result.expectedRequests.length);
  assertProviderByteOracle(result);
  for (let index = 0; index < result.expectedRequests.length; index += 1) {
    assert.equal(
      canonicalize(result.transcript.requests[index]!),
      canonicalize(result.expectedRequests[index]!),
    );
  }
}

function assertProviderByteOracle(result: GateBScenarioResult<unknown>): void {
  assert.equal(result.transcript.providerCallCount, result.expectedRequests.length);
  assert.equal(
    result.transcript.capturedRequestBytes.length,
    result.expectedRequests.length,
  );
  const decoder = new TextDecoder("utf8", { fatal: true });
  for (let index = 0; index < result.expectedRequests.length; index += 1) {
    const calibratedRequest = result.expectedRequests[index]!;
    const expectedSemanticRequest = mapAgentTurnToSemanticRequest(calibratedRequest);
    const captured = result.transcript.capturedRequestBytes[index]!;
    assert.equal(
      canonicalize(result.transcript.semanticRequests[index]!),
      canonicalize(expectedSemanticRequest),
    );
    assert.deepEqual(
      captured,
      Uint8Array.from(canonicalBytes(expectedSemanticRequest)),
    );
    assert.equal(decoder.decode(captured), canonicalize(expectedSemanticRequest));
  }
}

function assertBrokerManifestsReconcile(
  result: GateBScenarioResult<unknown>,
): void {
  const releaseByItem = new Map<string, JsonObject>();
  for (const manifest of releaseManifests(result.execution.history)) {
    if (manifest["status"] === "released") {
      releaseByItem.set(manifest["itemId"] as string, manifest);
    }
  }
  const agentInputs = payloads(
    result.execution.history,
    "ContextManifestRecorded",
  ).filter((payload) => payload["manifestKind"] === "agent_input");
  assert.equal(agentInputs.length, result.transcript.requests.length);

  for (const [index, request] of result.transcript.requests.entries()) {
    const payload = agentInputs[index]!;
    assert.equal(payload["referenceId"], request.attemptId);
    const manifest = objectField(payload, "manifest");
    assert.equal(manifest["agentTurnRequestHash"], canonicalSha256Hex(request));
    const assembly = objectField(manifest, "assemblyManifest");
    const blocks = [
      ...request.context,
      ...request.observations.flatMap((observation) => observation.content),
    ];
    const orderedItemIds = blocks.map((block) => block.blockId);
    assert.deepEqual(assembly["orderedItemIds"], orderedItemIds);
    const entries = assembly["entries"] as readonly JsonObject[];
    assert.deepEqual(
      entries.map((entry) => entry["itemId"]),
      orderedItemIds,
    );
    for (const block of blocks) {
      assert.equal(block.modality, "json");
      if (block.modality !== "json") assert.fail("broker block was not JSON");
      assert.equal(block.contentHash, canonicalSha256Hex(block.value));
      assert.equal(block.byteLength, canonicalBytes(block.value).byteLength);
      const release = releaseByItem.get(block.blockId)!;
      assert.equal(release["releasedContentHash"], block.contentHash);
      assert.equal(release["byteLength"], block.byteLength);
      assert.equal(release["classification"], undefined);
      assert.equal(
        canonicalize(release["resource"]),
        canonicalize(block.provenance.source),
      );
    }
  }

  for (const request of result.transcript.requests) {
    const attemptIndex = result.execution.history.findIndex(
      (event) =>
        event.eventType === "ContextManifestRecorded" &&
        event.payload["manifestKind"] === "agent_input" &&
        event.payload["referenceId"] === request.attemptId,
    );
    assert.notEqual(attemptIndex, -1);
    const next = result.execution.history[attemptIndex + 1];
    assert.equal(
      next === undefined ||
        ["ActionProposed", "OutcomeProposed", "AgentUsageRecorded"].includes(
          next.eventType,
        ),
      true,
    );
  }
}

function assertReplayPurity(result: GateBScenarioResult<unknown>): void {
  assertProviderByteOracle(result);
  assert.equal(
    canonicalize(result.replay.history),
    canonicalize(result.execution.history),
  );
  assert.equal(canonicalize(result.replay.state), canonicalize(result.execution.state));
  assert.equal(
    canonicalize(result.pureReplayState),
    canonicalize(result.execution.state),
  );
  assert.equal(
    canonicalize(result.countersAfterReplay),
    canonicalize(result.countersAtCompletion),
  );
}

function assertEmptyAssemblyRecorded(history: readonly GenericEventEnvelope[]): void {
  const inputs = payloads(history, "ContextManifestRecorded").filter(
    (payload) => payload["manifestKind"] === "agent_input",
  );
  assert.equal(inputs.length >= 1, true);
  const assembly = objectField(objectField(inputs[0]!, "manifest"), "assemblyManifest");
  assert.deepEqual(assembly["orderedItemIds"], []);
  assert.deepEqual(assembly["entries"], []);
  assert.equal(assembly["totalBytes"], 0);
}

function scanResult(
  result: GateBScenarioResult<unknown>,
  forbidden: readonly string[],
) {
  return scanEvidenceSurfaces(
    {
      providerRequestBytes: result.transcript.capturedRequestBytes,
      driverRequests: result.transcript.requests,
      histories: [result.execution.history],
      renderableArtifacts: [result.artifacts],
    },
    forbidden,
  );
}

function decodedProviderRequests(result: GateBScenarioResult<unknown>): string[] {
  const decoder = new TextDecoder("utf8", { fatal: true });
  return result.transcript.capturedRequestBytes.map((bytes) => decoder.decode(bytes));
}

function releaseManifests(history: readonly GenericEventEnvelope[]): JsonObject[] {
  return payloads(history, "ContextManifestRecorded")
    .filter((payload) => payload["manifestKind"] === "release")
    .map((payload) => objectField(payload, "manifest"));
}

function observationPayloads(history: readonly GenericEventEnvelope[]): JsonObject[] {
  return payloads(history, "ObservationReleased").map((payload) =>
    objectField(payload, "observation"),
  );
}

function assertRuntimeDeniedDisposition(
  history: readonly GenericEventEnvelope[],
): void {
  const observations = observationPayloads(history);
  assert.equal(observations.length, 1);
  const observation = observations[0]!;
  assert.equal(observation["status"], "succeeded");
  assert.deepEqual(observation["agent"], []);
  assert.deepEqual(observation["audit"], { agentViewStatus: "denied" });
  const human = observation["human"];
  assert.equal(Array.isArray(human), true);
  const blocks = human as readonly JsonObject[];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!["modality"], "json");
  assert.deepEqual(blocks[0]!["value"], { agentViewStatus: "denied" });
}

function payloads(
  history: readonly GenericEventEnvelope[],
  eventType: string,
): JsonObject[] {
  return history
    .filter((event) => event.eventType === eventType)
    .map((event) => event.payload as unknown as JsonObject);
}

function eventCount(
  history: readonly GenericEventEnvelope[],
  eventType: string,
): number {
  return history.filter((event) => event.eventType === eventType).length;
}

function objectField(value: JsonObject, key: string): JsonObject {
  const candidate = value[key];
  assert.equal(typeof candidate, "object");
  assert.notEqual(candidate, null);
  assert.equal(Array.isArray(candidate), false);
  return candidate as JsonObject;
}

function readGolden(filename: string): string {
  const contents = readFileSync(
    new URL(`../fixtures/${filename}`, import.meta.url),
    "utf8",
  );
  assert.equal(contents.includes("\r"), false, `${filename} must be LF-only`);
  assert.equal(contents.endsWith("\n"), true, `${filename} needs a final newline`);
  return contents.slice(0, -1);
}
