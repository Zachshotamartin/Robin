import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  AgentDriver,
  AgentDriverDescriptor,
  AgentDriverEvent,
  AgentTurnRequest,
} from "@guard/agent-driver";
import {
  bindCapabilityAgentContextRelease,
  CapabilityGateway,
  CapabilityPackRegistry,
} from "@guard/capability-gateway";
import type {
  CapabilityAgentContextReleaseDefinition,
  CapabilityPack,
} from "@guard/capability-gateway";
import {
  BrokerContextSourceRegistry,
  CONTEXT_POLICY_ATTRIBUTE_CATALOG,
  InMemoryBrokerSource,
  MEMORY_POLICY_ATTRIBUTE_CATALOG,
  createContextBrokerIntegrationFactory,
  createContextReleasePolicySnapshot,
  createPinnedContextPolicyAdapter,
} from "@guard/context-broker";
import type {
  BrokerContextSource,
  ContextBudgetLimits,
  ContextResourceMetadata,
  NormalizedResourceRequest,
  OpenedContextResource,
  SourceReadBudget,
} from "@guard/context-broker";
import {
  AgentAttemptIdKind,
  CONTRACT_SCHEMA_VERSION,
  canonicalSha256Hex,
  canonicalize,
  createDomainError,
  isDomainError,
} from "@guard/contracts";
import type {
  ActionId,
  AgentAttemptId,
  ApprovalId,
  EventId,
  GenericEventEnvelope,
  JsonObject,
  ObjectiveEnvelope,
  PolicyVersionId,
  RunId,
  TaskProfile,
} from "@guard/contracts";
import { InMemoryEventStore } from "@guard/event-store";
import { InMemoryTaskProfileRegistry } from "@guard/profile-registry";
import { replay } from "@guard/runtime";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshot,
  composePolicyAttributeCatalogs,
  createPinnedPolicyEvaluator,
  createPolicyAttributeCatalog,
  createPolicySnapshotManifest,
  type PolicySnapshot,
} from "@guard/policy-engine";

import { SynchronousRuntimeHost } from "./index.js";
import type {
  RuntimeHostIdFactory,
  SynchronousRuntimeHostOptions,
} from "./index.js";

const NOW = "2026-08-30T12:00:00.000Z";
const RAW_CANARY = "RAW_RESULT_MUST_NEVER_ENTER_THE_LEDGER";
const AUDIT_CANARY = "AUDIT_VIEW_MUST_NEVER_ENTER_THE_DRIVER";
const HUMAN_CANARY = "HUMAN_VIEW_MUST_NEVER_ENTER_THE_DRIVER";
const RAW_PLANNER_LOCATOR = "RAW_PLANNER_LOCATOR_MUST_NOT_BE_REQUESTED";
const PACK_ID = "fixture.transform";
const OPERATION_ID = "transform";
const DRIVER_COMPONENT_ID = "fixture.driver-binding";
const POLICY_COMPONENT_ID = "fixture.phase-a-pure-only";
const CONTEXT_COMPONENT_ID = "fixture.context";
const PROPOSAL_ID = id("dpr", 700);
const POLICY_VERSION_ID = id("pol", 800) as PolicyVersionId;
const POLICY_SOURCE = `policy "deny-local-effects" priority 100 {
  when action.side_effect != "none"
  deny
  reason "Fixture local effects are denied."
}

policy "allow-pure-effects" priority 50 {
  when action.side_effect == "none"
  allow
  reason "Fixture pure effects are allowed."
}
`;
const APPROVAL_POLICY_SOURCE = `policy "approve-local-effects" priority 100 {
  when action.side_effect != "none"
  require_approval
  reason "Fixture local effects require approval."
}

policy "allow-pure-effects" priority 50 {
  when action.side_effect == "none"
  allow
  reason "Fixture pure effects are allowed."
}
`;
const CONTEXT_DENY_POLICY_SOURCE = `policy "deny-context-release" priority 200 {
  when action.pack == "guard.context"
  deny
  reason "Fixture context release is denied."
}

`;
const CAPABILITY_CONTEXT_CATALOG = createPolicyAttributeCatalog({
  catalogId: "guard.fixture-capability",
  schemaVersion: 1,
  attributes: [
    {
      name: "fixture.capability_kind",
      type: "string",
      optional: true,
      secretClassification: null,
      matchKind: "none",
      source: {
        kind: "object_field",
        section: "resource",
        field: "fixtureKind",
      },
    },
  ],
});
const FIXTURE_POLICY_CATALOGS = composePolicyAttributeCatalogs([
  BASE_POLICY_ATTRIBUTE_CATALOG,
  CONTEXT_POLICY_ATTRIBUTE_CATALOG,
  MEMORY_POLICY_ATTRIBUTE_CATALOG,
  CAPABILITY_CONTEXT_CATALOG,
]);
const CAPABILITY_RELEASE_DEFINITION: CapabilityAgentContextReleaseDefinition =
  Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceVersion: 1,
    catalogId: CAPABILITY_CONTEXT_CATALOG.catalogId,
    catalogVersion: CAPABILITY_CONTEXT_CATALOG.schemaVersion,
    catalogContentHash: CAPABILITY_CONTEXT_CATALOG.contentHash,
    classification: "internal",
    reason: "capability.output",
  });

interface Counters {
  driverCalls: number;
  sourceNormalizations: number;
  sourceMetadataReads: number;
  sourceReads: number;
  normalizations: number;
  executions: number;
  releases: number;
  executionObservedInsideStream: number[];
}

type DriverProgram = (
  request: AgentTurnRequest,
  index: number,
  counters: Counters,
) => AsyncIterable<unknown>;

interface FixtureOptions {
  readonly withContext?: boolean;
  readonly sideEffectClass?: "none" | "local_reversible";
  readonly handlerFails?: boolean;
  readonly contextFails?: boolean;
  readonly denyContextPolicy?: boolean;
  readonly allowContextSecrets?: boolean;
  readonly preserveCapabilityValue?: boolean;
  readonly customSplitSecretClassifier?: boolean;
  readonly duplicateContextPlanItem?: boolean;
  readonly approvalRequired?: boolean;
  readonly program?: DriverProgram;
  readonly limits?: SynchronousRuntimeHostOptions["limits"];
  readonly ids?: RuntimeHostIdFactory;
  readonly wrapHostOptions?: (
    options: SynchronousRuntimeHostOptions,
  ) => SynchronousRuntimeHostOptions;
  readonly afterHostConstruction?: (
    options: SynchronousRuntimeHostOptions,
  ) => void;
  readonly contextBrokerConfigurationOverride?: JsonObject;
}

interface Fixture {
  readonly host: SynchronousRuntimeHost;
  readonly objective: ObjectiveEnvelope;
  readonly counters: Counters;
  readonly driver: ProgrammedDriver;
  readonly eventStore: InMemoryEventStore;
  readonly brokerBudgets: ContextBudgetLimits;
}

class ProgrammedDriver implements AgentDriver {
  public readonly descriptor: AgentDriverDescriptor = Object.freeze({
    driverId: "guard.fixture-programmed-driver",
    driverVersion: "1.0.0",
    capabilities: Object.freeze({
      driverKind: "scripted",
      contextDelivery: "mediated_items",
      actionDelivery: "structured",
      transcriptVisibility: "exact",
      credentialOwnership: "none",
      resume: "lossless",
      cancellation: "confirmed",
      canSpawnUndeclaredAgents: false,
    }),
  });

  public readonly requests: AgentTurnRequest[] = [];
  readonly #program: DriverProgram;
  readonly #counters: Counters;

  public constructor(program: DriverProgram, counters: Counters) {
    this.#program = program;
    this.#counters = counters;
  }

  public advance(
    request: AgentTurnRequest,
    _signal: AbortSignal,
  ): AsyncIterable<AgentDriverEvent> {
    const index = this.requests.length;
    this.requests.push(request);
    this.#counters.driverCalls += 1;
    return this.#program(request, index, this.#counters) as AsyncIterable<AgentDriverEvent>;
  }
}

class CountingBrokerContextSource implements BrokerContextSource {
  public readonly descriptor;
  readonly #delegate: InMemoryBrokerSource;
  readonly #counters: Counters;
  readonly #fails: boolean;

  public constructor(
    delegate: InMemoryBrokerSource,
    counters: Counters,
    fails = false,
  ) {
    this.#delegate = delegate;
    this.#counters = counters;
    this.#fails = fails;
    this.descriptor = delegate.descriptor;
  }

  public normalizeResourceRequest(input: unknown): NormalizedResourceRequest {
    this.#counters.sourceNormalizations += 1;
    return this.#delegate.normalizeResourceRequest(input);
  }

  public async inspectMetadata(
    request: NormalizedResourceRequest,
    signal: AbortSignal,
  ): Promise<ContextResourceMetadata> {
    this.#counters.sourceMetadataReads += 1;
    if (this.#fails) {
      throw createDomainError({
        code: "infrastructure_failed",
        message: "context source private failure canary",
        details: { private: "context source private details canary" },
      });
    }
    return this.#delegate.inspectMetadata(request, signal);
  }

  public async openBounded(
    request: NormalizedResourceRequest,
    expected: ContextResourceMetadata,
    budget: SourceReadBudget,
    signal: AbortSignal,
  ): Promise<OpenedContextResource> {
    this.#counters.sourceReads += 1;
    return this.#delegate.openBounded(request, expected, budget, signal);
  }
}

class DeterministicIds implements RuntimeHostIdFactory {
  #event = 100;
  #action = 300;
  #context = 0;
  #content = 0;
  #observation = 0;
  #approval = 400;

  public nextRunId(): RunId {
    return id("run", 1) as RunId;
  }

  public nextEventId(): EventId {
    this.#event += 1;
    return id("evt", this.#event) as EventId;
  }

  public nextAgentAttemptId(turn: number): AgentAttemptId {
    return AgentAttemptIdKind.parse(id("att", 200 + turn));
  }

  public nextActionId(): ActionId {
    this.#action += 1;
    return id("act", this.#action) as ActionId;
  }

  public nextApprovalId(): ApprovalId {
    this.#approval += 1;
    return id("apr", this.#approval) as ApprovalId;
  }

  public nextContextRequestId(): string {
    this.#context += 1;
    return `context-request-${String(this.#context)}`;
  }

  public nextContentBlockId(): string {
    this.#content += 1;
    return `content-block-${String(this.#content)}`;
  }

  public nextObservationId(): string {
    this.#observation += 1;
    return `observation-${String(this.#observation)}`;
  }
}

class DuplicateContentIds extends DeterministicIds {
  public override nextContentBlockId(): string {
    return "duplicate-content-block";
  }
}

class IncrementingRunIds extends DeterministicIds {
  #run = 0;

  public override nextRunId(): RunId {
    this.#run += 1;
    return id("run", this.#run) as RunId;
  }
}

test("provider-free context/action/outcome run is exact, command-barriered, and replay-pure", async () => {
  const fixture = createFixture({ withContext: true });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "completed");
  assert.equal(execution.state.result?.status, "completed");
  assert.deepEqual(eventTypes(execution.history), [
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
    "OutcomeValidated",
    "RunCompleted",
  ]);
  assert.deepEqual(fixture.counters.executionObservedInsideStream, [0]);
  assert.equal(fixture.counters.executions, 1);
  assert.equal(fixture.counters.sourceReads, 1);
  assert.equal(fixture.driver.requests.length, 2);
  assert.equal(fixture.driver.requests[0]?.context.length, 1);
  assert.equal(fixture.driver.requests[0]?.observations.length, 0);
  assert.equal(fixture.driver.requests[1]?.context.length, 1);
  assert.equal(fixture.driver.requests[1]?.observations.length, 1);
  assert.equal(fixture.driver.requests[0]?.turnNumber, 1);
  assert.equal(fixture.driver.requests[1]?.turnNumber, 2);
  const agentInputManifests = eventsOfType(
    execution.history,
    "ContextManifestRecorded",
  ).filter((event) => event.payload.manifestKind === "agent_input");
  assert.equal(agentInputManifests.length, 2);
  for (const [index, event] of agentInputManifests.entries()) {
    const request = fixture.driver.requests[index]!;
    assert.equal(event.payload.referenceId, request.attemptId);
    assert.equal(
      event.payload.manifest["agentTurnRequestHash"],
      canonicalSha256Hex(request),
    );
  }
  const firstAssembly = agentInputManifests[0]!.payload.manifest[
    "assemblyManifest"
  ] as JsonObject;
  const orderedItemIds = firstAssembly["orderedItemIds"] as readonly string[];
  const firstContextBlock = fixture.driver.requests[0]!.context[0]!;
  assert.equal(firstContextBlock.blockId, orderedItemIds[0]);
  assert.equal(
    firstContextBlock.contentHash,
    canonicalSha256Hex(
      firstContextBlock.modality === "json" ? firstContextBlock.value : null,
    ),
  );
  assert.equal(
    firstContextBlock.byteLength,
    firstContextBlock.modality === "json"
      ? Buffer.byteLength(canonicalize(firstContextBlock.value), "utf8")
      : -1,
  );
  assert.deepEqual(
    fixture.driver.requests[1]!.context[0],
    fixture.driver.requests[0]!.context[0],
  );
  const driverRequests = canonicalize(fixture.driver.requests);
  assert.equal(driverRequests.includes(AUDIT_CANARY), false);
  assert.equal(driverRequests.includes(HUMAN_CANARY), false);
  assert.equal(driverRequests.includes(RAW_CANARY), false);
  const requested = findEvent(execution.history, "ContextRequested");
  assert.equal(canonicalize(requested).includes(RAW_PLANNER_LOCATOR), false);
  assert.equal(requested.payload.resource.classification, "unreviewed");
  const releasedContext = findEvent(execution.history, "ContextReleased");
  assert.equal(releasedContext.causationId, requested.eventId);

  const normalized = findEvent(execution.history, "ActionNormalized");
  assert.equal(normalized.payload.action.capabilityPackId, PACK_ID);
  assert.equal(normalized.payload.action.capabilityPackVersion, 1);
  assert.equal(normalized.payload.action.operationId, OPERATION_ID);
  assert.equal(normalized.payload.action.operationVersion, 1);
  const proposal = findEvent(execution.history, "ActionProposed");
  assert.equal(normalized.causationId, proposal.eventId);
  const capabilityReleaseManifest = eventsOfType(
    execution.history,
    "ContextManifestRecorded",
  ).find(
    (event) =>
      event.payload.manifestKind === "release" &&
      event.payload.referenceId === normalized.payload.action.actionId,
  );
  assert.notEqual(capabilityReleaseManifest, undefined);
  assert.equal(
    capabilityReleaseManifest?.payload.manifest["turnId"],
    fixture.driver.requests[1]!.attemptId,
  );
  assert.equal(
    capabilityReleaseManifest?.payload.manifest["policyCatalogId"],
    CAPABILITY_RELEASE_DEFINITION.catalogId,
  );
  assert.equal(
    capabilityReleaseManifest?.payload.manifest["policyCatalogContentHash"],
    CAPABILITY_RELEASE_DEFINITION.catalogContentHash,
  );
  assert.equal(
    (capabilityReleaseManifest?.payload.manifest["resource"] as JsonObject)[
      "classification"
    ],
    CAPABILITY_RELEASE_DEFINITION.classification,
  );
  const started = findEvent(execution.history, "AgentDriverStarted");
  assert.match(started.payload.driverFingerprint, /^[0-9a-f]{64}$/u);
  const pinned = findEvent(execution.history, "TaskProfilePinned");
  assert.equal(
    pinned.payload.taskProfile.policyProfile.configuration["policyVersionId"],
    POLICY_VERSION_ID,
  );
  assert.match(
    String(
      pinned.payload.taskProfile.policyProfile.configuration["policyContentHash"],
    ),
    /^[0-9a-f]{64}$/u,
  );

  const serialized = canonicalize(execution.history);
  assert.equal(serialized.includes(RAW_CANARY), false);
  assert.equal(serialized.includes(AUDIT_CANARY), true);
  assert.equal(serialized.includes(HUMAN_CANARY), true);
  const golden = JSON.parse(
    readFileSync(new URL("../testdata/broker-current-golden.json", import.meta.url), "utf8"),
  ) as readonly GenericEventEnvelope[];
  assert.equal(serialized, canonicalize(golden));
  assert.equal(canonicalize(replay(golden)), canonicalize(execution.state));

  const beforeReplay = canonicalize(fixture.counters);
  const replayed = await fixture.host.replayRun(execution.runId);
  assert.equal(canonicalize(replayed.history), canonicalize(execution.history));
  assert.equal(canonicalize(replayed.state), canonicalize(execution.state));
  assert.equal(canonicalize(fixture.counters), beforeReplay);
});

test("a zero-context outcome completes through the same reducer without source calls", async () => {
  const fixture = createFixture({ withContext: false, program: outcomeOnlyProgram });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "completed");
  assert.equal(fixture.counters.sourceReads, 0);
  assert.equal(fixture.counters.executions, 0);
  assert.equal(fixture.driver.requests.length, 1);
  assert.deepEqual(fixture.driver.requests[0]?.context, []);
  assert.equal(eventTypes(execution.history).includes("ContextRequested"), false);
  assert.equal(eventTypes(execution.history).includes("ActionProposed"), false);
  const manifest = findEvent(execution.history, "ContextManifestRecorded");
  assert.equal(manifest.payload.manifestKind, "agent_input");
  const assembly = manifest.payload.manifest["assemblyManifest"] as JsonObject;
  assert.deepEqual(assembly["orderedItemIds"], []);
  assert.deepEqual(assembly["entries"], []);
  assert.equal(
    manifest.payload.manifest["agentTurnRequestHash"],
    canonicalSha256Hex(fixture.driver.requests[0]!),
  );
});

test("pinned policy denial never dispatches the handler and releases an exact denial", async () => {
  const fixture = createFixture({
    withContext: false,
    sideEffectClass: "local_reversible",
  });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "completed");
  assert.equal(fixture.counters.normalizations, 1);
  assert.equal(fixture.counters.executions, 0);
  assert.equal(fixture.counters.releases, 0);
  assert.equal(eventTypes(execution.history).includes("ActionStarted"), false);
  const policy = findEvent(execution.history, "PolicyEvaluated");
  assert.equal(policy.payload.decision, "deny");
  assert.equal(policy.payload.policyVersionId, POLICY_VERSION_ID);
  const denied = findEvent(execution.history, "ActionDenied");
  const observation = findEvent(execution.history, "ObservationReleased");
  assert.equal(observation.payload.observation.status, "denied");
  assert.equal(observation.payload.observation.error?.errorId, denied.payload.error.errorId);
  assert.deepEqual(fixture.driver.requests[1]!.observations[0]!.content, []);
  assert.equal(
    fixture.driver.requests[1]!.observations[0]!.error?.errorId,
    denied.payload.error.errorId,
  );
});

test("approval policy routes to a replay-visible pending request without execution", async () => {
  const fixture = createFixture({
    withContext: false,
    sideEffectClass: "local_reversible",
    approvalRequired: true,
  });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "waiting_for_approval");
  assert.equal(execution.state.pendingApproval?.status, "requested");
  assert.equal(fixture.counters.normalizations, 1);
  assert.equal(fixture.counters.executions, 0);
  assert.equal(fixture.counters.releases, 0);
  assert.equal(eventTypes(execution.history).includes("ActionStarted"), false);
  assert.equal(eventTypes(execution.history).includes("ObservationReleased"), false);
  const policy = findEvent(execution.history, "PolicyEvaluated");
  assert.equal(policy.payload.decision, "require_approval");
  const requested = findEvent(execution.history, "ApprovalRequested");
  assert.equal(requested.payload.actionId, policy.payload.actionId);
  assert.match(requested.payload.preconditionHash, /^[0-9a-f]{64}$/u);
  const replayed = await fixture.host.replayRun(execution.runId);
  assert.equal(canonicalize(replayed.state), canonicalize(execution.state));
});

test("handler failure is recorded, safely observed, and can be followed by a valid outcome", async () => {
  const fixture = createFixture({ withContext: false, handlerFails: true });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "completed");
  assert.equal(fixture.counters.executions, 1);
  assert.equal(fixture.counters.releases, 0);
  assert.equal(eventTypes(execution.history).includes("ActionSucceeded"), false);
  const failed = findEvent(execution.history, "ActionFailed");
  const observation = findEvent(execution.history, "ObservationReleased");
  assert.equal(observation.payload.observation.status, "failed");
  assert.equal(observation.payload.observation.error?.errorId, failed.payload.error.errorId);
  assert.equal(canonicalize(execution.history).includes("fixture handler exploded"), false);
  assert.deepEqual(fixture.driver.requests[1]!.observations[0]!.content, []);
  assert.equal(
    canonicalize(fixture.driver.requests).includes("fixture handler exploded"),
    false,
  );
});

test("context-source failure is denied safely and the same active attempt resumes", async () => {
  const fixture = createFixture({ withContext: true, contextFails: true });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "completed");
  assert.equal(fixture.counters.sourceMetadataReads, 1);
  assert.equal(fixture.counters.sourceReads, 0);
  assert.equal(fixture.driver.requests[0]?.turnNumber, 1);
  assert.deepEqual(fixture.driver.requests[0]?.context, []);
  assert.equal(eventTypes(execution.history).includes("ContextReleased"), false);
  assert.equal(eventTypes(execution.history).includes("ContextDenied"), true);
  const requested = findEvent(execution.history, "ContextRequested");
  const denied = findEvent(execution.history, "ContextDenied");
  assert.equal(denied.causationId, requested.eventId);
  assert.equal(
    execution.history.some(
      (event) =>
        event.eventType === "ContextManifestRecorded" &&
        event.payload.manifestKind === "release" &&
        event.payload.referenceId === requested.payload.requestId,
    ),
    false,
  );
  assert.equal(
    canonicalize(execution.history).includes("context source private failure canary"),
    false,
  );
});

test("metadata denial records a broker manifest, opens no content, and assembles empty input", async () => {
  const fixture = createFixture({
    withContext: true,
    denyContextPolicy: true,
    program: outcomeOnlyProgram,
  });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "completed");
  assert.equal(fixture.counters.sourceNormalizations, 1);
  assert.equal(fixture.counters.sourceMetadataReads, 1);
  assert.equal(fixture.counters.sourceReads, 0);
  const requested = findEvent(execution.history, "ContextRequested");
  const releaseManifest = eventsOfType(
    execution.history,
    "ContextManifestRecorded",
  ).find(
    (event) =>
      event.payload.manifestKind === "release" &&
      event.payload.referenceId === requested.payload.requestId,
  );
  assert.notEqual(releaseManifest, undefined);
  assert.equal(releaseManifest?.payload.manifest["status"], "denied");
  const denied = findEvent(execution.history, "ContextDenied");
  assert.equal(denied.payload.error.code, "policy_denied");
  assert.equal(denied.causationId, requested.eventId);
  assert.deepEqual(fixture.driver.requests[0]!.context, []);
  assert.equal(canonicalize(requested).includes(RAW_PLANNER_LOCATOR), false);
  assert.equal(requested.payload.resource.classification, "unreviewed");
});

test("genuine broker deduplication preserves one stable item in assembled input", async () => {
  const fixture = createFixture({
    withContext: true,
    duplicateContextPlanItem: true,
    program: outcomeOnlyProgram,
  });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "completed");
  assert.equal(fixture.counters.sourceReads, 2);
  const releaseManifests = eventsOfType(
    execution.history,
    "ContextManifestRecorded",
  ).filter((event) => event.payload.manifestKind === "release");
  assert.equal(releaseManifests.length, 2);
  assert.equal(releaseManifests[0]!.payload.manifest["deduplicated"], false);
  assert.equal(releaseManifests[1]!.payload.manifest["deduplicated"], true);
  assert.equal(
    releaseManifests[1]!.payload.manifest["itemId"],
    releaseManifests[0]!.payload.manifest["itemId"],
  );
  const releases = eventsOfType(execution.history, "ContextReleased");
  assert.equal(releases.length, 2);
  assert.deepEqual(releases[1]!.payload.content, releases[0]!.payload.content);
  assert.equal(fixture.driver.requests[0]!.context.length, 1);
  assert.deepEqual(
    fixture.driver.requests[0]!.context,
    releases[0]!.payload.content,
  );
  const inputManifest = eventsOfType(
    execution.history,
    "ContextManifestRecorded",
  ).find((event) => event.payload.manifestKind === "agent_input");
  const assembly = inputManifest?.payload.manifest["assemblyManifest"] as
    | JsonObject
    | undefined;
  assert.deepEqual(assembly?.["orderedItemIds"], [
    releaseManifests[0]!.payload.manifest["itemId"],
  ]);
});

test("capability output denial preserves action success and gives the driver a denied empty projection", async () => {
  const fixture = createFixture({ denyContextPolicy: true });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "completed");
  assert.equal(eventTypes(execution.history).includes("ActionSucceeded"), true);
  assert.equal(eventTypes(execution.history).includes("ActionFailed"), false);
  const ledgerObservation = findEvent(execution.history, "ObservationReleased");
  assert.equal(ledgerObservation.payload.observation.status, "succeeded");
  assert.deepEqual(ledgerObservation.payload.observation.agent, []);
  const driverObservation = fixture.driver.requests[1]!.observations[0]!;
  assert.equal(driverObservation.status, "denied");
  assert.deepEqual(driverObservation.content, []);
  assert.equal(driverObservation.error?.code, "policy_denied");
  const releaseManifest = eventsOfType(
    execution.history,
    "ContextManifestRecorded",
  ).find((event) => event.payload.manifestKind === "release");
  assert.equal(releaseManifest?.payload.manifest["status"], "denied");
});

test("split secrets across prior broker observations stop assembly before a third driver call", async () => {
  const fixture = createFixture({
    allowContextSecrets: true,
    preserveCapabilityValue: true,
    customSplitSecretClassifier: true,
    program: splitSecretTwoActionProgram,
  });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "failed");
  assert.equal(fixture.counters.driverCalls, 2);
  assert.equal(fixture.counters.executions, 2);
  assert.deepEqual(eventTypes(execution.history).slice(-2), [
    "AgentAttemptFailed",
    "RunFailed",
  ]);
  const failure = findEvent(execution.history, "AgentAttemptFailed");
  assert.equal(failure.payload.error.code, "policy_denied");
  assert.equal(
    eventsOfType(execution.history, "ContextManifestRecorded").filter(
      (event) => event.payload.manifestKind === "agent_input",
    ).length,
    2,
  );
});

test("broker configuration mismatch rejects before the first event", async () => {
  const fixture = createFixture({
    ids: new IncrementingRunIds(),
    contextBrokerConfigurationOverride: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      configurationContentHash: "0".repeat(64),
    },
  });
  await assert.rejects(
    fixture.host.run(fixture.objective),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
  await assert.rejects(
    fixture.host.run(fixture.objective),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
  assert.deepEqual(
    await storedHistory(fixture.eventStore, id("run", 1) as RunId),
    [],
  );
  assert.deepEqual(
    await storedHistory(fixture.eventStore, id("run", 2) as RunId),
    [],
  );
  assert.equal(fixture.counters.driverCalls, 0);
  assert.equal(fixture.counters.normalizations, 0);
});

test("factory-captured broker configuration ignores mutation of the original budget object", async () => {
  const fixture = createFixture({ withContext: true });
  (fixture.brokerBudgets as { maximumItemsPerRun: number }).maximumItemsPerRun = 1;
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "completed");
  const pinned = findEvent(execution.history, "TaskProfilePinned");
  const configuration = pinned.payload.taskProfile.budgetPolicy.extensions[
    "contextBroker"
  ] as JsonObject;
  const budgets = configuration["budgets"] as JsonObject;
  assert.equal(budgets["maximumItemsPerRun"], 32);
  assert.equal(fixture.driver.requests[1]!.observations[0]!.status, "succeeded");
});

test("constructor rejects structurally forged and proxied broker factories", () => {
  assert.throws(
    () =>
      createFixture({
        wrapHostOptions(options) {
          return {
            ...options,
            contextBrokerFactory: {
              ...options.contextBrokerFactory,
            } as SynchronousRuntimeHostOptions["contextBrokerFactory"],
          };
        },
      }),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
  assert.throws(
    () =>
      createFixture({
        wrapHostOptions(options) {
          return {
            ...options,
            contextBrokerFactory: new Proxy(options.contextBrokerFactory, {}),
          };
        },
      }),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
});

test("the legacy provider-free golden remains deterministic replay evidence", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL("../testdata/provider-free-golden.json", import.meta.url),
      "utf8",
    ),
  ) as readonly GenericEventEnvelope[];
  const state = replay(golden);
  assert.equal(state.status, "completed");
  assert.equal(canonicalize(replay(golden)), canonicalize(state));
});

for (const [name, program] of [
  ["schema-invalid payload", invalidOutcomeProgram],
  ["unresolved evidence", unresolvedEvidenceProgram],
] as const) {
  test(`outcome validation failure (${name}) appends a terminal RunFailed`, async () => {
    const fixture = createFixture({ withContext: false, program });
    const execution = await fixture.host.run(fixture.objective);

    assert.equal(execution.state.status, "failed");
    assert.deepEqual(eventTypes(execution.history).slice(-2), [
      "OutcomeProposed",
      "RunFailed",
    ]);
    assert.equal(eventTypes(execution.history).includes("OutcomeValidated"), false);
    assert.equal(execution.state.outstandingCommand, null);
  });
}

test("reused content IDs are detected and settle execution to RunFailed", async () => {
  const fixture = createFixture({
    withContext: false,
    ids: new DuplicateContentIds(),
    program: twoActionThenOutcomeProgram,
  });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "failed");
  assert.deepEqual(eventTypes(execution.history).slice(-2), ["ActionFailed", "RunFailed"]);
  assert.equal(execution.state.outstandingCommand, null);
});

for (const [name, program] of [
  ["completed without a decision", completedOnlyProgram],
  ["multiple action/outcome decisions", multipleDecisionProgram],
  ["post-terminal data", postTerminalProgram],
  ["an unadvertised exact version", unadvertisedProgram],
  ["a hostile proxy event", proxyEventProgram],
] as const) {
  test(`malformed driver stream (${name}) settles AgentAttemptFailed then RunFailed`, async () => {
    const fixture = createFixture({ withContext: false, program });
    const execution = await fixture.host.run(fixture.objective);

    assert.equal(execution.state.status, "failed");
    assert.deepEqual(eventTypes(execution.history).slice(-2), [
      "AgentAttemptFailed",
      "RunFailed",
    ]);
    assert.equal(eventTypes(execution.history).includes("ActionProposed"), false);
    assert.equal(execution.state.outstandingCommand, null);
    assert.equal(fixture.counters.executions, 0);
  });
}

test("a throwing driver discards its buffered partial turn and fails terminally", async () => {
  const fixture = createFixture({ withContext: false, program: throwingProgram });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "failed");
  assert.equal(eventTypes(execution.history).includes("AgentUsageRecorded"), false);
  assert.deepEqual(eventTypes(execution.history).slice(-2), [
    "AgentAttemptFailed",
    "RunFailed",
  ]);
  assert.equal(canonicalize(execution.history).includes("hostile throw canary"), false);
});

test("command budget failure settles an active attempt and returns a terminal ledger", async () => {
  const fixture = createFixture({
    withContext: true,
    limits: { maximumDispatchedCommands: 1 },
  });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "failed");
  assert.deepEqual(eventTypes(execution.history).slice(-2), [
    "AgentAttemptFailed",
    "RunFailed",
  ]);
  assert.equal(execution.state.outstandingCommand, null);
  assert.equal(fixture.counters.sourceReads, 0);
});

test("host failures remain typed domain errors at preflight boundaries", async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.host.run({ profileId: "hostile" }),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
});

test("composition is captured once and ignores post-construction mutation or accessors", async () => {
  const fixture = createFixture({
    withContext: false,
    program: outcomeOnlyProgram,
    afterHostConstruction(options) {
      (options.installedDriver as { componentId: string }).componentId = "mutated.driver";
      (options.installedPolicy as { componentId: string }).componentId = "mutated.policy";
      (options.normalizationSubject as { principal: string }).principal = "mutated-user";
      Object.defineProperty(options.clock, "now", {
        configurable: true,
        get() {
          throw new Error("post-construction clock accessor canary");
        },
      });
      Object.defineProperty(options.contextPlanner, "plan", {
        configurable: true,
        get() {
          throw new Error("post-construction planner accessor canary");
        },
      });
      Object.defineProperty(options.ids, "nextEventId", {
        configurable: true,
        value: () => "invalid-event-id",
      });
    },
  });
  const execution = await fixture.host.run(fixture.objective);

  assert.equal(execution.state.status, "completed");
  const driverStarted = findEvent(execution.history, "AgentDriverStarted");
  assert.equal(driverStarted.payload.driverProfileId, DRIVER_COMPONENT_ID);
  assert.equal(execution.history.every((event) => event.occurredAt === NOW), true);
});

test("constructor rejects accessor-bearing and proxy composition without invoking canaries", () => {
  let accessorCalls = 0;
  assert.throws(
    () =>
      createFixture({
        wrapHostOptions(options) {
          const wrapped = { ...options };
          Object.defineProperty(wrapped, "clock", {
            enumerable: true,
            get() {
              accessorCalls += 1;
              throw new Error("constructor accessor canary");
            },
          });
          return wrapped;
        },
      }),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
  assert.equal(accessorCalls, 0);

  assert.throws(
    () =>
      createFixture({
        wrapHostOptions(options) {
          return new Proxy(options, {
            ownKeys() {
              throw new Error("constructor proxy canary");
            },
          });
        },
      }),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input",
  );
});

function createFixture(options: FixtureOptions = {}): Fixture {
  const counters: Counters = {
    driverCalls: 0,
    sourceNormalizations: 0,
    sourceMetadataReads: 0,
    sourceReads: 0,
    normalizations: 0,
    executions: 0,
    releases: 0,
    executionObservedInsideStream: [],
  };
  const withContext = options.withContext ?? false;
  const policySnapshot = compileFixturePolicy(
    `${options.denyContextPolicy === true ? CONTEXT_DENY_POLICY_SOURCE : ""}${
      options.approvalRequired === true
        ? APPROVAL_POLICY_SOURCE
        : POLICY_SOURCE
    }`,
  );
  const source = new CountingBrokerContextSource(
    new InMemoryBrokerSource({
      descriptor: {
        sourceId: CONTEXT_COMPONENT_ID,
        sourceVersion: 1,
        scheme: "memory",
        description: "One bounded generic fixture item.",
      },
      records: [
        {
          recordId: RAW_PLANNER_LOCATOR,
          content: canonicalize({ value: "alpha" }),
          mediaType: "application/json",
          classification: "fixture",
        },
      ],
      maximumRecords: 1,
      maximumRecordBytes: 1_024,
    }),
    counters,
    options.contextFails ?? false,
  );
  const brokerBudgets: ContextBudgetLimits = {
    maximumResourceBytes: 64 * 1024,
    maximumRequestBytes: 32 * 1024,
    maximumItemsPerTurn: 16,
    maximumBytesPerTurn: 64 * 1024,
    maximumItemsPerRun: 32,
    maximumBytesPerRun: 128 * 1024,
    maximumControlCharacterRatio: 0.05,
  };
  const releasePolicy = createContextReleasePolicySnapshot({
    releasePolicyId: "runtime-host.fixture",
    releasePolicyVersion: 1,
    secretDisposition: options.allowContextSecrets === true ? "allow" : "redact",
    promptInjectionDisposition: "tag",
    truncatedDisposition: "deny",
  });
  const contextBrokerFactory = createContextBrokerIntegrationFactory({
    policySnapshotId: POLICY_VERSION_ID,
    releasePolicy,
    sources: new BrokerContextSourceRegistry(withContext ? [source] : []),
    policy: createPinnedContextPolicyAdapter({
      evaluator: createPinnedPolicyEvaluator(policySnapshot, {
        secretCorrelationToken: "runtime-host-context-policy-token-0001",
      }),
      releasePolicy,
    }),
    budgets: brokerBudgets,
    ...(options.customSplitSecretClassifier === true
      ? {
          customSecretClassifiers: [
            {
              classifierId: "runtime-host.split-secret",
              pattern: "runtimehostfragmentalpharuntimehostfragmentbravo",
            },
          ],
        }
      : {}),
  });
  const profile = profileFixture(
    withContext,
    createPolicySnapshotManifest(policySnapshot),
    options.contextBrokerConfigurationOverride ??
      (contextBrokerFactory.configurationDescriptor as unknown as JsonObject),
  );
  const objective = objectiveFixture(profile);
  const profileRegistry = new InMemoryTaskProfileRegistry();
  profileRegistry.register(profile);
  const capabilityPacks = new CapabilityPackRegistry([
    capabilityPackFixture(counters, options),
  ]);
  const gateway = new CapabilityGateway(
    capabilityPacks,
    createPinnedPolicyEvaluator(policySnapshot, {
      secretCorrelationToken: "runtime-host-fixture-policy-token-0001",
    }),
  );
  const driver = new ProgrammedDriver(options.program ?? actionThenOutcomeProgram, counters);
  const eventStore = new InMemoryEventStore({ now: () => NOW });

  const hostOptions: SynchronousRuntimeHostOptions = {
    eventStore,
    profileRegistry,
    installedDriver: {
      componentId: DRIVER_COMPONENT_ID,
      componentVersion: 1,
      driver,
    },
    contextBrokerFactory,
    capabilityPacks,
    capabilityGateway: gateway,
    contextPlanner: {
      plan({ objective: plannedObjective }) {
        if (!withContext) return [];
        const item = {
          bindingId: "fixture-input",
          input: {
            recordId:
              plannedObjective.payload["input"] === "fixture"
                ? RAW_PLANNER_LOCATOR
                : plannedObjective.payload["input"]!,
          },
          budget: { maximumItems: 1, maximumBytes: 1_024 },
        } as const;
        return options.duplicateContextPlanItem === true ? [item, item] : [item];
      },
    },
    installedPolicy: {
      componentId: POLICY_COMPONENT_ID,
      componentVersion: 1,
      snapshot: policySnapshot,
    },
    normalizationSubject: {
      kind: "user",
      principal: "fixture-user",
    },
    normalizationEnvironment: {
      profileId: "fixture",
      sandboxed: true,
      networkProfile: "disabled",
      trustLevel: "trusted_fixture",
    },
    clock: { now: () => NOW },
    ids: options.ids ?? new DeterministicIds(),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
  const host = new SynchronousRuntimeHost(
    options.wrapHostOptions?.(hostOptions) ?? hostOptions,
  );
  options.afterHostConstruction?.(hostOptions);
  return {
    host,
    objective,
    counters,
    driver,
    eventStore,
    brokerBudgets,
  };
}

function capabilityPackFixture(
  counters: Counters,
  options: FixtureOptions,
): CapabilityPack {
  return {
    packId: PACK_ID,
    packVersion: 1,
    operations: [
      {
        definition: {
          operationId: OPERATION_ID,
          operationVersion: 1,
          description: "Transform one generic fixture value.",
          inputSchema: {
            schemaId: "fixture.transform.input",
            schemaVersion: 1,
            document: {
              type: "object",
              additionalProperties: false,
              required: ["value"],
              properties: { value: { type: "string" } },
            },
          },
          outputSchema: {
            schemaId: "fixture.transform.output",
            schemaVersion: 1,
            document: {
              type: "object",
              additionalProperties: false,
              required: ["value", "internal"],
              properties: {
                value: { type: "string" },
                internal: { type: "string" },
              },
            },
          },
          sideEffectClass: options.sideEffectClass ?? "none",
        },
        agentContextRelease: CAPABILITY_RELEASE_DEFINITION,
        normalize(input) {
          counters.normalizations += 1;
          return {
            normalizedInput: input,
            resource: {
              scheme: "memory",
              sourceId: CONTEXT_COMPONENT_ID,
              classification: "internal",
              kind: "fixture",
              fixtureKind: "transform",
            },
            request: { operation: OPERATION_ID, intent: OPERATION_ID },
            preconditions: [],
          };
        },
        execute(action): JsonObject {
          counters.executions += 1;
          if (options.handlerFails === true) {
            throw createDomainError({
              code: "action_failed",
              message: "fixture handler exploded with private details",
              details: { private: "fixture handler private DomainError details" },
            });
          }
          return {
            value:
              options.preserveCapabilityValue === true
                ? String(action.normalizedInput["value"])
                : String(action.normalizedInput["value"]).toUpperCase(),
            internal: RAW_CANARY,
          };
        },
        release(raw, action) {
          counters.releases += 1;
          const agent: JsonObject = { value: raw["value"]! };
          const descriptor = {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            sourceVersion: CAPABILITY_RELEASE_DEFINITION.sourceVersion,
            resource: {
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              scheme: "memory",
              sourceId: CONTEXT_COMPONENT_ID,
              locator: { fixtureKind: action.resource["fixtureKind"]! },
              mediaType: "application/json",
              classification: CAPABILITY_RELEASE_DEFINITION.classification,
            },
            policyProjection: {
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              catalogId: CAPABILITY_RELEASE_DEFINITION.catalogId,
              catalogVersion: CAPABILITY_RELEASE_DEFINITION.catalogVersion,
              catalogContentHash:
                CAPABILITY_RELEASE_DEFINITION.catalogContentHash,
              resourceAttributes: {
                fixtureKind: action.resource["fixtureKind"]!,
              },
              requestAttributes: {
                operation: action.request["operation"]!,
              },
            },
            classification: CAPABILITY_RELEASE_DEFINITION.classification,
            reason: CAPABILITY_RELEASE_DEFINITION.reason,
          } as const;
          return {
            audit: { released: true, privateAudit: AUDIT_CANARY },
            human: { summary: HUMAN_CANARY },
            agent,
            agentContextRelease: bindCapabilityAgentContextRelease(
              descriptor,
              action,
              raw,
              agent,
            ),
          };
        },
      },
    ],
  };
}

function compileFixturePolicy(source: string): PolicySnapshot {
  const result = compilePolicySnapshot({
    policyVersionId: POLICY_VERSION_ID,
    source,
    sourceId: "runtime-host-fixture.guard",
    defaultEffect: "deny",
  }, {}, FIXTURE_POLICY_CATALOGS);
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error("unreachable fixture policy compile failure");
  return result.snapshot;
}

function profileFixture(
  withContext: boolean,
  policyManifest: JsonObject,
  contextBrokerConfiguration: JsonObject,
): TaskProfile {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    profileId: "fixture.generic-task",
    profileVersion: 1,
    objectiveSchema: {
      schemaId: "fixture.objective",
      schemaVersion: 1,
      document: {
        type: "object",
        additionalProperties: false,
        required: ["input"],
        properties: { input: { type: "string" } },
      },
    },
    driverProfile: {
      componentId: DRIVER_COMPONENT_ID,
      componentVersion: 1,
      configuration: { program: "fixture" },
    },
    modelBindings: [],
    contextSources: withContext
      ? [
          {
            bindingId: "fixture-input",
            componentId: CONTEXT_COMPONENT_ID,
            componentVersion: 1,
            configuration: {},
          },
        ]
      : [],
    capabilityPacks: [
      {
        bindingId: "fixture-transform",
        componentId: PACK_ID,
        componentVersion: 1,
        configuration: {},
      },
    ],
    policyProfile: {
      componentId: POLICY_COMPONENT_ID,
      componentVersion: 1,
      configuration: policyManifest,
    },
    outcomeSchema: {
      schemaId: "fixture.outcome",
      schemaVersion: 1,
      document: {
        type: "object",
        additionalProperties: false,
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
    },
    budgetPolicy: {
      maxTurns: 3,
      maxActions: 2,
      maxElapsedMs: 10_000,
      maxInputBytes: 64 * 1024,
      maxOutputBytes: 4_096,
      extensions: { contextBroker: contextBrokerConfiguration },
    },
    evidenceMode: "ephemeral_metadata",
    evaluationProfile: null,
  };
}

function objectiveFixture(profile: TaskProfile): ObjectiveEnvelope {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    objectiveType: "fixture.execute",
    objectiveTypeVersion: 1,
    payload: { input: "fixture" },
    submittedBy: { kind: "user", id: "fixture-user" },
    submittedAt: NOW,
  };
}

function outcomeFor(request: AgentTurnRequest): JsonObject {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    outcomeId: `outcome-${String(request.turnNumber)}`,
    profileId: request.objective.profileId,
    profileVersion: request.objective.profileVersion,
    outcomeType: "fixture.result",
    outcomeTypeVersion: 1,
    payload: { answer: "complete" },
    evidence:
      request.observations.length === 0
        ? []
        : [
            {
              kind: "observation",
              referenceId: request.observations[0]!.observationId,
              contentHash: null,
            },
          ],
    proposedAt: NOW,
  };
}

async function* actionThenOutcomeProgram(
  request: AgentTurnRequest,
  index: number,
  counters: Counters,
): AsyncGenerator<unknown> {
  if (index === 0) {
    yield {
      type: "action_proposed",
      proposalId: PROPOSAL_ID,
      capabilityPackId: PACK_ID,
      capabilityPackVersion: 1,
      operationId: OPERATION_ID,
      operationVersion: 1,
      input: { value: "alpha" },
    };
    await Promise.resolve();
    counters.executionObservedInsideStream.push(counters.executions);
    yield { type: "usage_reported", dimensions: { inputBytes: 5, outputBytes: 4 } };
    yield { type: "completed" };
    return;
  }
  assert.equal(request.observations.length, 1);
  yield { type: "outcome_proposed", outcome: outcomeFor(request) };
  yield { type: "completed" };
}

async function* twoActionThenOutcomeProgram(
  request: AgentTurnRequest,
  index: number,
): AsyncGenerator<unknown> {
  if (index < 2) {
    yield {
      type: "action_proposed",
      proposalId: id("dpr", 700 + index),
      capabilityPackId: PACK_ID,
      capabilityPackVersion: 1,
      operationId: OPERATION_ID,
      operationVersion: 1,
      input: { value: index === 0 ? "alpha" : "bravo" },
    };
    yield { type: "completed" };
    return;
  }
  yield { type: "outcome_proposed", outcome: outcomeFor(request) };
  yield { type: "completed" };
}

async function* splitSecretTwoActionProgram(
  _request: AgentTurnRequest,
  index: number,
): AsyncGenerator<unknown> {
  const fragments = ["runtimehostfragmentalpha", "runtimehostfragmentbravo"];
  if (index >= fragments.length) {
    assert.fail("split-secret assembly should stop the third driver call");
  }
  yield {
    type: "action_proposed",
    proposalId: id("dpr", 720 + index),
    capabilityPackId: PACK_ID,
    capabilityPackVersion: 1,
    operationId: OPERATION_ID,
    operationVersion: 1,
    input: { value: fragments[index]! },
  };
  yield { type: "completed" };
}

async function* outcomeOnlyProgram(request: AgentTurnRequest): AsyncGenerator<unknown> {
  yield { type: "outcome_proposed", outcome: outcomeFor(request) };
  yield { type: "completed" };
}

async function* invalidOutcomeProgram(request: AgentTurnRequest): AsyncGenerator<unknown> {
  const outcome = outcomeFor(request);
  const payload = outcome["payload"] as JsonObject;
  yield {
    type: "outcome_proposed",
    outcome: { ...outcome, payload: { ...payload, answer: 42 } },
  };
  yield { type: "completed" };
}

async function* unresolvedEvidenceProgram(
  request: AgentTurnRequest,
): AsyncGenerator<unknown> {
  yield {
    type: "outcome_proposed",
    outcome: {
      ...outcomeFor(request),
      evidence: [
        {
          kind: "observation",
          referenceId: "observation-that-never-existed",
          contentHash: null,
        },
      ],
    },
  };
  yield { type: "completed" };
}

async function* completedOnlyProgram(): AsyncGenerator<unknown> {
  yield { type: "completed" };
}

async function* multipleDecisionProgram(request: AgentTurnRequest): AsyncGenerator<unknown> {
  yield {
    type: "action_proposed",
    proposalId: PROPOSAL_ID,
    capabilityPackId: PACK_ID,
    capabilityPackVersion: 1,
    operationId: OPERATION_ID,
    operationVersion: 1,
    input: { value: "alpha" },
  };
  yield { type: "outcome_proposed", outcome: outcomeFor(request) };
}

async function* postTerminalProgram(): AsyncGenerator<unknown> {
  yield { type: "completed" };
  yield { type: "usage_reported", dimensions: { outputBytes: 1 } };
}

async function* unadvertisedProgram(): AsyncGenerator<unknown> {
  yield {
    type: "action_proposed",
    proposalId: PROPOSAL_ID,
    capabilityPackId: PACK_ID,
    capabilityPackVersion: 2,
    operationId: OPERATION_ID,
    operationVersion: 1,
    input: { value: "alpha" },
  };
}

async function* proxyEventProgram(): AsyncGenerator<unknown> {
  yield new Proxy(
    { type: "completed" },
    {
      ownKeys: () => {
        throw new Error("proxy canary");
      },
    },
  );
}

async function* throwingProgram(): AsyncGenerator<unknown> {
  yield { type: "usage_reported", dimensions: { outputBytes: 1 } };
  throw new Error("hostile throw canary");
}

function eventTypes(history: readonly GenericEventEnvelope[]): string[] {
  return history.map((event) => event.eventType);
}

function findEvent<TType extends GenericEventEnvelope["eventType"]>(
  history: readonly GenericEventEnvelope[],
  eventType: TType,
): Extract<GenericEventEnvelope, { readonly eventType: TType }> {
  const event = history.find(
    (candidate): candidate is Extract<
      GenericEventEnvelope,
      { readonly eventType: TType }
    > => candidate.eventType === eventType,
  );
  if (event === undefined) {
    assert.fail(`missing ${eventType}`);
  }
  return event;
}

function eventsOfType<TType extends GenericEventEnvelope["eventType"]>(
  history: readonly GenericEventEnvelope[],
  eventType: TType,
): Extract<GenericEventEnvelope, { readonly eventType: TType }>[] {
  return history.filter(
    (candidate): candidate is Extract<
      GenericEventEnvelope,
      { readonly eventType: TType }
    > => candidate.eventType === eventType,
  );
}

async function storedHistory(
  eventStore: InMemoryEventStore,
  runId: RunId,
): Promise<readonly GenericEventEnvelope[]> {
  const history: GenericEventEnvelope[] = [];
  for await (const event of eventStore.read(runId, 0)) {
    history.push(event);
  }
  return history;
}

function id(prefix: string, ordinal: number): string {
  return `${prefix}_018f0000-0000-7000-8000-${ordinal
    .toString(16)
    .padStart(12, "0")}`;
}
