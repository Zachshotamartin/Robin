import { isProxy } from "node:util/types";

import type {
  AdvertisedOperation,
  AgentObservation,
  AgentDriverEvent,
  AgentTurnRequest,
} from "@guard/agent-driver";
import { parseAgentObservation } from "@guard/agent-driver";
import type {
  CapabilityAdvertisement,
  CapabilityExecutionResult,
  EvaluatedCapabilityAction,
  PreparedCapabilityAction,
} from "@guard/capability-gateway";
import {
  captureContextBrokerIntegration,
  captureContextBrokerIntegrationFactory,
} from "@guard/context-broker";
import type {
  AgentContextAssembly,
  ContextBrokerIntegration,
  ContextBrokerIntegrationFactory,
  ContextReleaseResult,
  ContextSourceDescriptor,
  ContextManifestEntry,
  ReleasedContextItem,
} from "@guard/context-broker";
import {
  CONTRACT_SCHEMA_VERSION,
  ActionIdKind,
  AgentAttemptIdKind,
  ApprovalIdKind,
  DriverProposalIdKind,
  EventIdKind,
  PolicyVersionIdKind,
  RunIdKind,
  canonicalBytes,
  canonicalSha256Hex,
  canonicalize,
  createDomainError,
  isDomainError,
  parseContentBlock,
  parseDomainError,
  parseGenericEvent,
  parseGenericEventEnvelope,
  parseObservation,
  parseOutcomeEnvelope,
  parseResourceRef,
  snapshotBoundaryJsonObject,
} from "@guard/contracts";
import type {
  ActionId,
  ActorIdentity,
  AgentAttemptId,
  ContentBlock,
  DomainError,
  EventId,
  GenericEvent,
  GenericEventEnvelope,
  GenericEventPayloadMap,
  GenericEventType,
  JsonContentBlock,
  JsonObject,
  NormalizedAction,
  ObjectiveEnvelope,
  Observation,
  OutcomeEnvelope,
  OutcomeEvidenceRef,
  PolicyVersionId,
  ResourceRef,
  RunId,
  TaskProfile,
} from "@guard/contracts";
import { decide, evolve, planEffects, replay } from "@guard/runtime";
import type { RunIntent, RunState, RuntimeCommand } from "@guard/runtime";
import { createPolicySnapshotManifest } from "@guard/policy-engine";

import type {
  RuntimeContextPlanItem,
  RuntimeHostExecution,
  RuntimeHostReplay,
  SynchronousRuntimeHostOptions,
} from "./types.js";

interface HostLimits {
  readonly maximumContextPlanItems: number;
  readonly maximumContextItemsPerRequest: number;
  readonly maximumContextBytesPerRequest: number;
  readonly maximumDriverEventsPerTurn: number;
  readonly maximumDriverEventBytes: number;
  readonly maximumEvidenceReferences: number;
  readonly maximumDispatchedCommands: number;
}

interface PlannedContextRead {
  readonly requestId: string;
  readonly bindingId: string;
  readonly sourceDescriptor: ContextSourceDescriptor;
  readonly rawRequest: JsonObject;
  readonly safeResource: ResourceRef;
  readonly budget: RuntimeContextPlanItem["budget"];
  released: boolean;
}

interface EvaluatedActionOwnership {
  readonly prepared: PreparedCapabilityAction;
  readonly evaluated: EvaluatedCapabilityAction;
}

interface AgentObservationRecord {
  readonly observationId: string;
  readonly actionId: ActionId;
  readonly status: AgentObservation["status"];
  readonly error: AgentObservation["error"];
  readonly occurredAt: string;
  readonly itemIds: readonly string[];
}

/** Runtime-owned metadata used when a capability view did not cross the broker. */
interface CapabilityOutputDisposition extends JsonObject {
  readonly agentViewStatus: "denied" | "failed";
}

interface PreallocatedAgentAttempt {
  readonly turn: number;
  readonly attemptId: AgentAttemptId;
}

interface CapturedOptions {
  readonly eventStore: Pick<SynchronousRuntimeHostOptions["eventStore"], "append" | "read">;
  readonly profileRegistry: Pick<
    SynchronousRuntimeHostOptions["profileRegistry"],
    "resolve" | "validateObjective" | "validateOutcome"
  >;
  readonly installedDriver: {
    readonly componentId: string;
    readonly componentVersion: number;
    readonly driver: {
      readonly descriptor: JsonObject;
      readonly advance: SynchronousRuntimeHostOptions["installedDriver"]["driver"]["advance"];
    };
  };
  readonly contextBrokerFactory: ContextBrokerIntegrationFactory;
  readonly capabilityPacks: Pick<
    SynchronousRuntimeHostOptions["capabilityPacks"],
    "listPacks" | "createAdvertisement"
  >;
  readonly capabilityGateway: Pick<
    SynchronousRuntimeHostOptions["capabilityGateway"],
    "normalize" | "evaluate" | "execute"
  >;
  readonly contextPlanner: Pick<SynchronousRuntimeHostOptions["contextPlanner"], "plan">;
  readonly installedPolicy: {
    readonly componentId: string;
    readonly componentVersion: number;
    readonly policyVersionId: PolicyVersionId;
    readonly snapshotManifest: JsonObject;
  };
  readonly normalizationSubject: JsonObject;
  readonly normalizationEnvironment: JsonObject;
  readonly clock: Pick<SynchronousRuntimeHostOptions["clock"], "now">;
  readonly ids: RuntimeIds;
  readonly limits: SynchronousRuntimeHostOptions["limits"];
}

type RuntimeIds = {
  readonly [TKey in keyof SynchronousRuntimeHostOptions["ids"]]:
    SynchronousRuntimeHostOptions["ids"][TKey];
};

interface EvidenceEntry {
  readonly contentHash: string | null;
}

const DEFAULT_LIMITS: HostLimits = Object.freeze({
  maximumContextPlanItems: 32,
  maximumContextItemsPerRequest: 128,
  maximumContextBytesPerRequest: 1_048_576,
  maximumDriverEventsPerTurn: 256,
  maximumDriverEventBytes: 1_048_576,
  maximumEvidenceReferences: 256,
  maximumDispatchedCommands: 4_096,
});

const RUNTIME_ACTOR: ActorIdentity = Object.freeze({
  kind: "runtime",
  id: "guard.runtime-host",
});

const DENIED_CAPABILITY_OUTPUT_DISPOSITION: CapabilityOutputDisposition =
  Object.freeze({ agentViewStatus: "denied" });
const FAILED_CAPABILITY_OUTPUT_DISPOSITION: CapabilityOutputDisposition =
  Object.freeze({ agentViewStatus: "failed" });

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "orphaned"]);

/**
 * Phase-A application layer. The kernel remains pure: this host appends a fact,
 * asks the kernel for durable command data, evolves the projection, and only
 * then drains commands from an explicit FIFO. Commands enqueued while an agent
 * stream is being consumed cannot run until that stream has ended.
 */
export class SynchronousRuntimeHost {
  readonly #options: CapturedOptions;
  readonly #limits: HostLimits;
  readonly #subject: JsonObject;
  readonly #environment: JsonObject;

  #state: RunState = initialState();
  #runId: RunId | null = null;
  #profile: TaskProfile | null = null;
  #objective: ObjectiveEnvelope | null = null;
  #advertisement: CapabilityAdvertisement | null = null;
  #driverAdvertisement: readonly AdvertisedOperation[] = Object.freeze([]);
  #driverFingerprint: string | null = null;
  #contextBroker: ContextBrokerIntegration | null = null;
  #history: GenericEventEnvelope[] = [];
  #commands: RuntimeCommand[] = [];
  #plannedContext = new Map<string, PlannedContextRead>();
  #releasedSourceItemIds: string[] = [];
  #releasedItemsById = new Map<string, ReleasedContextItem>();
  #releasedItemCapturedAt = new Map<string, string>();
  #agentObservationRecords: AgentObservationRecord[] = [];
  #preallocatedAttempt: PreallocatedAgentAttempt | null = null;
  #evaluatedActions = new Map<ActionId, EvaluatedActionOwnership>();
  #evidence = new Map<string, EvidenceEntry>();
  #usedEventIds = new Set<EventId>();
  #usedContextRequestIds = new Set<string>();
  #usedContentBlockIds = new Set<string>();
  #usedObservationIds = new Set<string>();
  #usedAgentAttemptIds = new Set<AgentAttemptId>();
  #started = false;
  #draining = false;
  #activeAbortController: AbortController | null = null;

  public constructor(options: SynchronousRuntimeHostOptions) {
    const captured = captureOptions(options);
    this.#options = captured;
    this.#limits = normalizeLimits(captured.limits ?? {});
    this.#subject = captured.normalizationSubject;
    this.#environment = captured.normalizationEnvironment;
    validateInstalledIdentity(
      captured.installedDriver.componentId,
      captured.installedDriver.componentVersion,
      "installed driver",
    );
    validateInstalledIdentity(
      captured.installedPolicy.componentId,
      captured.installedPolicy.componentVersion,
      "installed policy",
    );
    if (!PolicyVersionIdKind.is(captured.installedPolicy.policyVersionId)) {
      throw invalidInput("The installed policy version identifier is invalid.");
    }
  }

  /** Executes exactly one run for this host instance. */
  public async run(objectiveInput: unknown): Promise<RuntimeHostExecution> {
    if (this.#started) {
      throw conflict("A synchronous runtime host instance can execute only one run.");
    }

    const objective = this.#options.profileRegistry.validateObjective(objectiveInput);
    const profile = this.#options.profileRegistry.resolve(
      objective.profileId,
      objective.profileVersion,
    );
    this.#validateComposition(profile);
    const runId = this.#options.ids.nextRunId();
    if (!RunIdKind.is(runId)) {
      throw invalidInput("The runtime ID factory returned an invalid run identifier.");
    }

    let contextBroker: ContextBrokerIntegration;
    try {
      contextBroker = captureContextBrokerIntegration(
        this.#options.contextBrokerFactory.createForRun({ runId }),
      );
    } catch {
      throw externalError(
        "infrastructure_failed",
        "The context-broker integration could not be created for this run.",
      );
    }
    this.#validateContextBrokerComposition(profile, runId, contextBroker);

    const advertisement = this.#createAdvertisement(profile);
    const plannedContext = this.#createContextPlan(
      objective,
      profile,
      contextBroker,
    );
    const driverFingerprint = this.#createDriverFingerprint(profile);

    this.#started = true;
    this.#runId = runId;
    this.#profile = profile;
    this.#objective = objective;
    this.#advertisement = advertisement.gateway;
    this.#driverAdvertisement = advertisement.driver;
    this.#driverFingerprint = driverFingerprint;
    this.#contextBroker = contextBroker;
    this.#plannedContext = plannedContext;

    await this.#appendIntent("create_run", "RunCreated", { objective });
    await this.#appendIntent("pin_task_profile", "TaskProfilePinned", {
      taskProfile: profile,
    });
    const startedAt = this.#now();
    await this.#appendIntent("start_run", "RunStarted", { startedAt });
    await this.#drainCommands();

    if (
      !TERMINAL_STATUSES.has(this.#state.status) &&
      this.#state.status !== "waiting_for_approval"
    ) {
      if (this.#state.outstandingCommand !== null) {
        throw invariant("The dispatcher stopped with consequential work outstanding.");
      }
      await this.#failRun(
        invariant("The dispatcher reached quiescence before a terminal run result."),
      );
      await this.#drainCommands();
    }

    return Object.freeze({
      runId,
      state: this.#state,
      history: Object.freeze([...this.#history]),
    });
  }

  /**
   * Rebuilds a projection using event-store reads plus the pure reducer only.
   * It neither changes this host's dispatcher state nor calls any effect port.
   */
  public async replayRun(runIdInput: unknown): Promise<RuntimeHostReplay> {
    if (!RunIdKind.is(runIdInput)) {
      throw invalidInput("Replay requires a valid run identifier.");
    }
    const history: GenericEventEnvelope[] = [];
    for await (const candidate of this.#options.eventStore.read(runIdInput, 0)) {
      history.push(parseGenericEventEnvelope(candidate));
    }
    const state = replay(history);
    return Object.freeze({
      runId: runIdInput,
      state,
      history: Object.freeze(history),
    });
  }

  #validateComposition(profile: TaskProfile): void {
    const installedDriver = this.#options.installedDriver;
    if (
      profile.driverProfile.componentId !== installedDriver.componentId ||
      profile.driverProfile.componentVersion !== installedDriver.componentVersion
    ) {
      throw invalidInput("The installed driver does not match the exact pinned profile identity.");
    }
    const policy = this.#options.installedPolicy;
    if (
      profile.policyProfile.componentId !== policy.componentId ||
      profile.policyProfile.componentVersion !== policy.componentVersion
    ) {
      throw invalidInput("The installed policy does not match the pinned profile identity.");
    }
    if (
      canonicalize(profile.policyProfile.configuration) !==
      canonicalize(policy.snapshotManifest)
    ) {
      throw invalidInput(
        "The pinned policy profile does not match the compiler-owned snapshot manifest.",
      );
    }

    assertNoDuplicateComponentIdentities(profile.contextSources, "context source");
    assertNoDuplicateComponentIdentities(profile.capabilityPacks, "capability pack");

    const installedPacks = this.#options.capabilityPacks.listPacks();
    for (const binding of profile.capabilityPacks) {
      const matches = installedPacks.filter(
        (pack) =>
          pack.packId === binding.componentId &&
          pack.packVersion === binding.componentVersion,
      );
      if (matches.length !== 1) {
        throw invalidInput(
          "A pinned capability pack must resolve to exactly one installed version.",
        );
      }
    }
  }

  #validateContextBrokerComposition(
    profile: TaskProfile,
    runId: RunId,
    integration: ContextBrokerIntegration,
  ): void {
    const descriptor = integration.descriptor;
    const configurationDescriptor =
      this.#options.contextBrokerFactory.configurationDescriptor;
    const configured = profile.budgetPolicy.extensions["contextBroker"];
    if (!isJsonRecord(configured)) {
      throw invalidInput(
        "The task profile must pin an exact context-broker configuration descriptor.",
      );
    }
    if (
      descriptor.runId !== runId ||
      descriptor.policySnapshotId !== this.#options.installedPolicy.policyVersionId
    ) {
      throw invalidInput(
        "The run context broker does not match the run or installed policy identity.",
      );
    }
    const runConfiguration = {
      schemaVersion: descriptor.schemaVersion,
      policySnapshotId: descriptor.policySnapshotId,
      releasePolicyId: descriptor.releasePolicyId,
      releasePolicyVersion: descriptor.releasePolicyVersion,
      releasePolicyContentHash: descriptor.releasePolicyContentHash,
      sourceDescriptors: descriptor.sourceDescriptors,
      budgets: descriptor.budgets,
      configurationContentHash: descriptor.configurationContentHash,
    } as const;
    if (
      canonicalize(configured) !== canonicalize(configurationDescriptor) ||
      canonicalize(runConfiguration) !== canonicalize(configurationDescriptor)
    ) {
      throw invalidInput(
        "The context-broker factory, run integration, and pinned profile configuration differ.",
      );
    }

    const pinnedSources = profile.contextSources
      .map((binding) => ({
        sourceId: binding.componentId,
        sourceVersion: binding.componentVersion,
      }))
      .sort(compareSourceIdentity);
    const installedSources = descriptor.sourceDescriptors
      .map((source) => ({
        sourceId: source.sourceId,
        sourceVersion: source.sourceVersion,
      }))
      .sort(compareSourceIdentity);
    if (canonicalize(pinnedSources) !== canonicalize(installedSources)) {
      throw invalidInput(
        "The task profile context bindings do not exactly match broker source descriptors.",
      );
    }
  }

  #createAdvertisement(profile: TaskProfile): {
    readonly gateway: CapabilityAdvertisement;
    readonly driver: readonly AdvertisedOperation[];
  } {
    const installedPacks = this.#options.capabilityPacks.listPacks();
    const references = profile.capabilityPacks.flatMap((binding) => {
      const pack = installedPacks.find(
        (candidate) =>
          candidate.packId === binding.componentId &&
          candidate.packVersion === binding.componentVersion,
      );
      if (pack === undefined) {
        throw invalidInput("A pinned capability pack is not installed.");
      }
      return pack.operations.map((operation) => ({
        packId: pack.packId,
        packVersion: pack.packVersion,
        operationId: operation.operationId,
        operationVersion: operation.operationVersion,
      }));
    });
    references.sort(compareOperationReference);
    const gateway = this.#options.capabilityPacks.createAdvertisement(references);
    const driver = Object.freeze(
      gateway.operations.map((operation) =>
        Object.freeze({
          capabilityPackId: operation.packId,
          capabilityPackVersion: operation.packVersion,
          operationId: operation.operationId,
          operationVersion: operation.operationVersion,
          description: operation.description,
          inputSchema: operation.inputSchema.document,
        }),
      ),
    );
    return Object.freeze({ gateway, driver });
  }

  #createDriverFingerprint(profile: TaskProfile): string {
    let descriptor: JsonObject;
    try {
      descriptor = snapshotBoundaryJsonObject(
        this.#options.installedDriver.driver.descriptor as unknown as JsonObject,
      );
      if (typeof this.#options.installedDriver.driver.advance !== "function") {
        throw new TypeError("missing advance function");
      }
    } catch {
      throw invalidInput("The installed agent driver has no safe immutable descriptor.");
    }
    return canonicalSha256Hex({
      componentId: profile.driverProfile.componentId,
      componentVersion: profile.driverProfile.componentVersion,
      configuration: profile.driverProfile.configuration,
      descriptor,
    });
  }

  #createContextPlan(
    objective: ObjectiveEnvelope,
    profile: TaskProfile,
    contextBroker: ContextBrokerIntegration,
  ): Map<string, PlannedContextRead> {
    let plannedUnknown: unknown;
    try {
      plannedUnknown = this.#options.contextPlanner.plan(
        Object.freeze({ objective, taskProfile: profile }),
      );
    } catch {
      throw externalError("invalid_input", "The context planner failed safely.");
    }
    const wrapper = snapshotBoundaryJsonObject({ items: plannedUnknown });
    const items = wrapper["items"];
    if (!Array.isArray(items)) {
      throw invalidInput("The context planner must return an array.");
    }
    if (items.length > this.#limits.maximumContextPlanItems) {
      throw budgetExceeded("The context plan exceeds its item bound.", {
        maximumContextPlanItems: this.#limits.maximumContextPlanItems,
      });
    }

    const plan = new Map<string, PlannedContextRead>();
    let plannedBytes = 0;
    for (const candidate of items) {
      const item = parseContextPlanItem(candidate);
      if (
        item.budget.maximumItems > this.#limits.maximumContextItemsPerRequest ||
        item.budget.maximumBytes > this.#limits.maximumContextBytesPerRequest
      ) {
        throw budgetExceeded("A planned context read exceeds the host boundary.", {
          maximumContextItemsPerRequest: this.#limits.maximumContextItemsPerRequest,
          maximumContextBytesPerRequest: this.#limits.maximumContextBytesPerRequest,
        });
      }
      if (item.budget.maximumItems !== 1) {
        throw invalidInput(
          "A planned broker source release must reserve exactly one context item.",
        );
      }
      plannedBytes = safeAdd(plannedBytes, item.budget.maximumBytes, "planned context bytes");
      if (plannedBytes > profile.budgetPolicy.maxInputBytes) {
        throw budgetExceeded("The context plan exceeds the task input-byte budget.", {
          maximumInputBytes: profile.budgetPolicy.maxInputBytes,
        });
      }

      const binding = profile.contextSources.find(
        (candidateBinding) => candidateBinding.bindingId === item.bindingId,
      );
      if (binding === undefined) {
        throw invalidInput("The context planner requested an unpinned binding.");
      }
      const sourceDescriptor = contextBroker.descriptor.sourceDescriptors.find(
        (source) =>
          source.sourceId === binding.componentId &&
          source.sourceVersion === binding.componentVersion,
      );
      if (sourceDescriptor === undefined) {
        throw invalidInput(
          "The context planner binding has no exact broker source descriptor.",
        );
      }
      const safeResource = parseResourceRef({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        scheme: sourceDescriptor.scheme,
        sourceId: sourceDescriptor.sourceId,
        locator: { bindingId: binding.bindingId },
        mediaType: null,
        classification: "unreviewed",
      });
      const requestId = this.#options.ids.nextContextRequestId();
      requireNonEmpty(requestId, "context request ID");
      if (plan.has(requestId) || this.#usedContextRequestIds.has(requestId)) {
        throw conflict("The runtime ID factory reused a context request identifier.");
      }
      this.#usedContextRequestIds.add(requestId);
      plan.set(requestId, {
        requestId,
        bindingId: item.bindingId,
        sourceDescriptor,
        rawRequest: item.input,
        safeResource,
        budget: item.budget,
        released: false,
      });
    }
    return plan;
  }

  async #appendIntent<
    TIntent extends RunIntent["intentType"],
    TEventType extends GenericEventType,
  >(
    intentType: TIntent,
    eventType: TEventType,
    payload: GenericEventPayloadMap[TEventType],
    causationId?: EventId,
  ): Promise<void> {
    const event = this.#makeEvent(eventType, payload, RUNTIME_ACTOR, causationId);
    const intent = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      intentType,
      event,
    } as RunIntent;
    const decided = decide(this.#state, intent);
    if (decided.length !== 1 || decided[0] === undefined) {
      throw invariant("A lifecycle intent did not decide exactly one event.");
    }
    await this.#append(decided[0]);
  }

  async #append<TType extends GenericEventType>(
    event: Extract<GenericEvent, { readonly eventType: TType }> | GenericEvent,
  ): Promise<void> {
    const runId = this.#requireRunId();
    const previous = this.#state;
    const appended = await this.#options.eventStore.append(
      runId,
      previous.streamVersion,
      [event],
    );
    if (!Array.isArray(appended) || appended.length !== 1 || appended[0] === undefined) {
      throw invariant("The event store did not return the single committed event.");
    }
    const envelope = parseGenericEventEnvelope(appended[0]);
    const commands = planEffects(previous, envelope);
    const next = evolve(previous, envelope);
    this.#state = next;
    this.#history.push(envelope);
    this.#recordEvidence(envelope);
    this.#commands.push(...commands);
  }

  #makeEvent<TType extends GenericEventType>(
    eventType: TType,
    payload: GenericEventPayloadMap[TType],
    actor: ActorIdentity,
    causationId: EventId | undefined = this.#state.lastEventId ?? undefined,
  ): Extract<GenericEvent, { readonly eventType: TType }> {
    const eventId = this.#options.ids.nextEventId();
    if (!EventIdKind.is(eventId)) {
      throw invalidInput("The runtime ID factory returned an invalid event identifier.");
    }
    if (this.#usedEventIds.has(eventId)) {
      throw conflict("The runtime ID factory reused an event identifier.");
    }
    this.#usedEventIds.add(eventId);
    const event = parseGenericEvent({
      eventId,
      eventType,
      eventSchemaVersion: CONTRACT_SCHEMA_VERSION,
      occurredAt: this.#now(),
      actor,
      correlationId: this.#requireRunId(),
      causationId: causationId ?? null,
      payload,
    });
    return event as Extract<GenericEvent, { readonly eventType: TType }>;
  }

  async #drainCommands(): Promise<void> {
    if (this.#draining) {
      throw invariant("Nested command draining is forbidden.");
    }
    this.#draining = true;
    let dispatched = 0;
    try {
      while (this.#commands.length > 0) {
        dispatched += 1;
        if (dispatched > this.#limits.maximumDispatchedCommands) {
          const error = budgetExceeded("The run exceeded the command-dispatch bound.", {
            maximumDispatchedCommands: this.#limits.maximumDispatchedCommands,
          });
          const command = this.#commands.shift();
          if (command === undefined) throw error;
          await this.#settleCommandFailure(command, error);
          this.#commands.length = 0;
          return;
        }
        const command = this.#commands.shift();
        if (command === undefined) {
          throw invariant("The command queue changed unexpectedly.");
        }
        await this.#dispatch(command);
      }
    } finally {
      this.#draining = false;
    }
  }

  async #dispatch(command: RuntimeCommand): Promise<void> {
    if (command.streamId !== this.#requireRunId()) {
      throw invariant("A queued command is bound to a different run.");
    }
    switch (command.commandType) {
      case "AdvanceAgentDriver":
        await this.#advanceAgent(command);
        return;
      case "FetchContextResource":
        await this.#fetchContext(command);
        return;
      case "EvaluateCapabilityAction":
        await this.#evaluateAction(command);
        return;
      case "ExecuteCapabilityAction":
        await this.#executeAction(command);
        return;
      case "ValidateOutcome":
        await this.#validateOutcome(command);
        return;
      case "FinalizeRun":
        await this.#finalize(command);
        return;
      case "CreateApprovalRequest":
        await this.#createApprovalRequest(command);
        return;
      case "CancelCapabilityAction":
        throw invariant(
          "The synchronous dispatcher received an unsupported cancellation command.",
        );
      default:
        return assertNever(command.commandType);
    }
  }

  async #settleCommandFailure(
    command: RuntimeCommand,
    error: DomainError,
  ): Promise<void> {
    switch (command.commandType) {
      case "AdvanceAgentDriver":
      case "FetchContextResource": {
        const attempt = this.#state.currentAttempt;
        if (attempt === null || attempt.status !== "active") throw error;
        await this.#append(
          this.#makeEvent(
            "AgentAttemptFailed",
            { attemptId: attempt.attemptId, error },
            RUNTIME_ACTOR,
            command.causedByEventId,
          ),
        );
        break;
      }
      case "ExecuteCapabilityAction": {
        const actionId = this.#state.currentAction?.normalizedAction?.actionId;
        if (!ActionIdKind.is(actionId)) {
          throw error;
        }
        if (this.#state.status === "evaluating_action") {
          await this.#append(
            this.#makeEvent(
              "ActionStarted",
              { actionId, startedAt: this.#now() },
              RUNTIME_ACTOR,
              command.causedByEventId,
            ),
          );
        }
        if (this.#state.status !== "executing_action") throw error;
        await this.#append(
          this.#makeEvent(
            "ActionFailed",
            { actionId, error },
            RUNTIME_ACTOR,
            command.causedByEventId,
          ),
        );
        break;
      }
      case "EvaluateCapabilityAction":
      case "ValidateOutcome":
      case "FinalizeRun":
      case "CreateApprovalRequest":
      case "CancelCapabilityAction":
        break;
      default:
        assertNever(command.commandType);
    }
    if (this.#state.outstandingCommand !== null) throw error;
    await this.#failRun(error);
  }

  async #advanceAgent(command: RuntimeCommand): Promise<void> {
    let firstCausation: EventId | undefined = command.causedByEventId;
    const takeCausation = (): EventId | undefined => {
      const value = firstCausation;
      firstCausation = undefined;
      return value;
    };
    if (this.#state.driver === null) {
      if (this.#driverFingerprint === null) {
        throw invariant("The installed driver fingerprint was not pinned.");
      }
      await this.#append(
        this.#makeEvent(
          "AgentDriverStarted",
          {
            driverProfileId: this.#options.installedDriver.componentId,
            driverProfileVersion: this.#options.installedDriver.componentVersion,
            driverFingerprint: this.#driverFingerprint,
          },
          RUNTIME_ACTOR,
          takeCausation(),
        ),
      );
    }

    let attempt = this.#state.currentAttempt;
    if (attempt === null || attempt.status !== "active") {
      const turn = this.#state.budget.turnsStarted + 1;
      const attemptId = this.#takeAgentAttemptId(turn);
      await this.#append(
        this.#makeEvent(
          "AgentAttemptStarted",
          { attemptId, turn },
          agentActor(this.#options.installedDriver.componentId),
          takeCausation(),
        ),
      );
      attempt = this.#state.currentAttempt;
    }
    if (attempt === null || attempt.status !== "active") {
      throw invariant("Advancing the agent did not establish an active attempt.");
    }

    const pendingContext = [...this.#plannedContext.values()].find(
      (planned) => !planned.released,
    );
    if (pendingContext !== undefined) {
      await this.#append(
        this.#makeEvent(
          "ContextRequested",
          {
            requestId: pendingContext.requestId,
            resource: pendingContext.safeResource,
          },
          RUNTIME_ACTOR,
          takeCausation(),
        ),
      );
      return;
    }

    let request: AgentTurnRequest;
    let assembly: AgentContextAssembly;
    try {
      assembly = await this.#requireContextBroker().assembleAgentContext({
        turnId: attempt.attemptId,
        agentRequestId: attempt.attemptId,
        orderedItemIds: this.#orderedReleasedItemIds(),
      });
      request = this.#agentTurnRequest(attempt, assembly);
    } catch (error: unknown) {
      await this.#settleDriverFailure(
        attempt.attemptId,
        safeError(
          error,
          "infrastructure_failed",
          "The context broker failed to assemble the exact agent input.",
        ),
      );
      return;
    }
    const requestHash = canonicalSha256Hex(request);
    await this.#append(
      this.#makeEvent(
        "ContextManifestRecorded",
        {
          manifestKind: "agent_input",
          referenceId: attempt.attemptId,
          manifest: snapshotBoundaryJsonObject({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            assemblyManifest: assembly.manifest,
            agentTurnRequestHash: requestHash,
          }),
        },
        RUNTIME_ACTOR,
        takeCausation(),
      ),
    );

    const controller = new AbortController();
    this.#activeAbortController = controller;
    let parsedEvents: AgentDriverEvent[] = [];
    let streamError: DomainError | null = null;
    try {
      const stream = this.#options.installedDriver.driver.advance(request, controller.signal);
      for await (const candidate of stream) {
        if (parsedEvents.length >= this.#limits.maximumDriverEventsPerTurn) {
          throw budgetExceeded("The driver turn exceeded its event-count bound.", {
            maximumDriverEventsPerTurn: this.#limits.maximumDriverEventsPerTurn,
          });
        }
        parsedEvents.push(
          parseDriverEvent(
            candidate,
            this.#driverAdvertisement,
            this.#limits.maximumDriverEventBytes,
          ),
        );
      }
    } catch {
      parsedEvents = [];
      streamError = externalError(
        "driver_failed",
        "The agent driver failed while producing a turn.",
      );
    } finally {
      this.#activeAbortController = null;
    }

    if (streamError !== null) {
      await this.#settleDriverFailure(attempt.attemptId, streamError);
      return;
    }

    let events: readonly AgentDriverEvent[];
    try {
      events = validateDriverTurn(parsedEvents);
    } catch (error: unknown) {
      await this.#settleDriverFailure(
        attempt.attemptId,
        safeError(error, "driver_failed", "The agent driver returned a malformed turn."),
      );
      return;
    }

    let terminalFailure: DomainError | null = null;
    for (const event of events) {
      switch (event.type) {
        case "content_delta":
          break;
        case "content_completed":
          await this.#append(
            this.#makeEvent(
              "AgentContentCompleted",
              { attemptId: attempt.attemptId, content: [event.content] },
              agentActor(this.#options.installedDriver.componentId),
              takeCausation(),
            ),
          );
          break;
        case "usage_reported":
          await this.#append(
            this.#makeEvent(
              "AgentUsageRecorded",
              { attemptId: attempt.attemptId, usage: event.dimensions },
              agentActor(this.#options.installedDriver.componentId),
              takeCausation(),
            ),
          );
          break;
        case "action_proposed":
          await this.#append(
            this.#makeEvent(
              "ActionProposed",
              {
                proposalId: event.proposalId,
                capabilityPackId: event.capabilityPackId,
                capabilityPackVersion: event.capabilityPackVersion,
                operationId: event.operationId,
                operationVersion: event.operationVersion,
                input: event.input,
              },
              agentActor(this.#options.installedDriver.componentId),
              takeCausation(),
            ),
          );
          break;
        case "outcome_proposed":
          await this.#append(
            this.#makeEvent(
              "OutcomeProposed",
              { outcome: event.outcome },
              agentActor(this.#options.installedDriver.componentId),
              takeCausation(),
            ),
          );
          break;
        case "failed":
          terminalFailure = event.error;
          await this.#append(
            this.#makeEvent(
              "AgentAttemptFailed",
              { attemptId: attempt.attemptId, error: event.error },
              agentActor(this.#options.installedDriver.componentId),
              takeCausation(),
            ),
          );
          break;
        case "paused":
          terminalFailure = createDomainError({
            code: "driver_failed",
            message: "Agent pause events are not supported by the Phase-A dispatcher.",
            details: { reason: event.reason },
          });
          await this.#append(
            this.#makeEvent(
              "AgentAttemptFailed",
              { attemptId: attempt.attemptId, error: terminalFailure },
              agentActor(this.#options.installedDriver.componentId),
              takeCausation(),
            ),
          );
          break;
        case "completed":
          break;
        default:
          assertNever(event);
      }
    }
    if (terminalFailure !== null) {
      await this.#failRun(terminalFailure);
    }
  }

  async #settleDriverFailure(
    attemptId: AgentAttemptId,
    error: DomainError,
  ): Promise<void> {
    await this.#append(
      this.#makeEvent(
        "AgentAttemptFailed",
        { attemptId, error },
        agentActor(this.#options.installedDriver.componentId),
      ),
    );
    await this.#failRun(error);
  }

  #takeAgentAttemptId(turn: number): AgentAttemptId {
    const preallocated = this.#preallocatedAttempt;
    if (preallocated !== null) {
      if (preallocated.turn !== turn) {
        throw invariant(
          "A preallocated agent-attempt identifier is bound to another turn.",
        );
      }
      this.#preallocatedAttempt = null;
      return preallocated.attemptId;
    }
    return this.#allocateAgentAttemptId(turn);
  }

  #preallocateNextAgentAttemptId(): AgentAttemptId {
    const turn = this.#state.budget.turnsStarted + 1;
    const existing = this.#preallocatedAttempt;
    if (existing !== null) {
      if (existing.turn !== turn) {
        throw invariant(
          "The cached agent-attempt identifier is bound to an unexpected turn.",
        );
      }
      return existing.attemptId;
    }
    const attemptId = this.#allocateAgentAttemptId(turn);
    this.#preallocatedAttempt = Object.freeze({ turn, attemptId });
    return attemptId;
  }

  #allocateAgentAttemptId(turn: number): AgentAttemptId {
    const attemptId = this.#options.ids.nextAgentAttemptId(turn);
    if (!AgentAttemptIdKind.is(attemptId)) {
      throw invalidInput(
        "The runtime ID factory returned an invalid agent-attempt identifier.",
      );
    }
    if (this.#usedAgentAttemptIds.has(attemptId)) {
      throw conflict("The runtime ID factory reused an agent-attempt identifier.");
    }
    this.#usedAgentAttemptIds.add(attemptId);
    return attemptId;
  }

  #agentTurnRequest(
    attempt: { readonly attemptId: AgentAttemptId; readonly turn: number },
    assembly: AgentContextAssembly,
  ): AgentTurnRequest {
    const orderedItemIds = this.#orderedReleasedItemIds();
    const brokerDescriptor = this.#requireContextBroker().descriptor;
    const serializedValues = assembly.items.map((item) => item.serializedValue);
    const utf8Text = serializedValues.join("\n");
    const utf8ByteLength = Buffer.byteLength(utf8Text, "utf8");
    if (
      assembly.schemaVersion !== CONTRACT_SCHEMA_VERSION ||
      assembly.manifest.runId !== this.#requireRunId() ||
      assembly.manifest.turnId !== attempt.attemptId ||
      assembly.manifest.agentRequestId !== attempt.attemptId ||
      assembly.manifest.policySnapshotId !== brokerDescriptor.policySnapshotId ||
      assembly.manifest.releasePolicyId !== brokerDescriptor.releasePolicyId ||
      assembly.manifest.releasePolicyVersion !==
        brokerDescriptor.releasePolicyVersion ||
      assembly.manifest.releasePolicyContentHash !==
        brokerDescriptor.releasePolicyContentHash ||
      canonicalize(assembly.manifest.orderedItemIds) !==
        canonicalize(orderedItemIds) ||
      canonicalize(assembly.items.map((item) => item.itemId)) !==
        canonicalize(orderedItemIds) ||
      canonicalize(assembly.manifest.entries.map((entry) => entry.itemId)) !==
        canonicalize(orderedItemIds) ||
      canonicalize(assembly.serializedValues) !==
        canonicalize(serializedValues) ||
      assembly.utf8Text !== utf8Text ||
      assembly.utf8ByteLength !== utf8ByteLength ||
      assembly.manifest.totalBytes !== utf8ByteLength ||
      assembly.manifest.conservativeTokenEstimate !== utf8ByteLength ||
      assembly.manifest.tokenEstimator !== "utf8-byte-upper-bound-v1"
    ) {
      throw invariant(
        "The context broker returned an assembly that differs from the requested item order.",
      );
    }
    const itemById = new Map(
      assembly.items.map((item) => [item.itemId, item] as const),
    );
    const entryById = new Map(
      assembly.manifest.entries.map((entry) => [entry.itemId, entry] as const),
    );
    const blockFor = (itemId: string): JsonContentBlock => {
      const item = itemById.get(itemId);
      const entry = entryById.get(itemId);
      if (item === undefined || entry === undefined) {
        throw invariant("An assembled context item has no exact manifest entry.");
      }
      return this.#brokerContentBlock(item, entry);
    };
    const context = Object.freeze(
      this.#releasedSourceItemIds.map((itemId) => blockFor(itemId)),
    );
    const observations = Object.freeze(
      this.#agentObservationRecords.map((record) =>
        parseAgentObservation({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          observationId: record.observationId,
          actionId: record.actionId,
          status: record.status,
          content: record.itemIds.map((itemId) => blockFor(itemId)),
          error: record.error,
          occurredAt: record.occurredAt,
        }),
      ),
    );
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      runId: this.#requireRunId(),
      attemptId: attempt.attemptId,
      turnNumber: attempt.turn,
      objective: this.#requireObjective(),
      advertisedOperations: this.#driverAdvertisement,
      context,
      observations,
    });
  }

  #orderedReleasedItemIds(): readonly string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const itemId of [
      ...this.#releasedSourceItemIds,
      ...this.#agentObservationRecords.flatMap((record) => record.itemIds),
    ]) {
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      ordered.push(itemId);
    }
    return Object.freeze(ordered);
  }

  #brokerContentBlock(
    item: ReleasedContextItem,
    entry: ContextManifestEntry,
  ): JsonContentBlock {
    const capturedAt = this.#releasedItemCapturedAt.get(item.itemId);
    if (
      capturedAt === undefined ||
      entry.status !== "released" ||
      entry.itemId !== item.itemId ||
      entry.releasedContentHash !== item.contentHash ||
      entry.runId !== item.runId ||
      entry.turnId !== item.turnId ||
      entry.sourceId !== item.resource.sourceId ||
      canonicalize(entry.resource) !== canonicalize(item.resource) ||
      entry.policySnapshotId !==
        this.#requireContextBroker().descriptor.policySnapshotId ||
      entry.releasePolicyId !==
        this.#requireContextBroker().descriptor.releasePolicyId ||
      entry.releasePolicyVersion !==
        this.#requireContextBroker().descriptor.releasePolicyVersion ||
      entry.releasePolicyContentHash !==
        this.#requireContextBroker().descriptor.releasePolicyContentHash ||
      item.runId !== this.#requireRunId() ||
      item.serializedValue !== canonicalize(item.value) ||
      Buffer.byteLength(item.serializedValue, "utf8") !== item.byteLength ||
      canonicalBytes(item.value).byteLength !== item.byteLength ||
      canonicalSha256Hex(item.value) !== item.contentHash
    ) {
      throw invariant(
        "A broker context item does not match its immutable integrity manifest.",
      );
    }
    const capabilityOutput =
      isJsonRecord(item.value) && item.value["kind"] === "capability_output";
    const block = parseContentBlock({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      blockId: item.itemId,
      modality: "json",
      mediaType: item.mediaType,
      byteLength: item.byteLength,
      contentHash: item.contentHash,
      classification: item.classification,
      provenance: {
        source: item.resource,
        producer: capabilityOutput
          ? capabilityActor(item.resource.sourceId)
          : contextActor(item.resource.sourceId),
        capturedAt,
      },
      retentionClass: "run",
      transformation:
        entry.redactions.length === 0
          ? null
          : {
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              transformationId: "context-broker.redaction",
              transformationVersion: 1,
              inputContentHashes: [],
            },
      value: item.value,
      jsonSchema: null,
    });
    if (block.modality !== "json") {
      throw invariant("A broker JSON item changed modality at the driver boundary.");
    }
    return block;
  }

  #recordBrokerItemRelease(
    item: ReleasedContextItem,
    manifest: ContextManifestEntry,
  ): boolean {
    const existing = this.#releasedItemsById.get(item.itemId);
    if (existing !== undefined) {
      if (
        manifest.deduplicated !== true ||
        canonicalize(existing) !== canonicalize(item)
      ) {
        throw conflict(
          "A broker item identifier was rebound without an exact deduplication receipt.",
        );
      }
      if (!this.#releasedItemCapturedAt.has(item.itemId)) {
        throw invariant("A deduplicated broker item lost its stable release timestamp.");
      }
      return false;
    }
    if (manifest.deduplicated === true) {
      throw invariant(
        "A broker deduplication receipt references an item the host never released.",
      );
    }
    this.#releasedItemsById.set(item.itemId, item);
    this.#releasedItemCapturedAt.set(item.itemId, this.#now());
    return true;
  }

  async #fetchContext(command: RuntimeCommand): Promise<void> {
    const requestId = command.payload["requestId"];
    if (typeof requestId !== "string") {
      throw invariant("A context command has no request identifier.");
    }
    const planned = this.#plannedContext.get(requestId);
    if (planned === undefined || planned.released) {
      throw invariant("A context command does not match a pending planned read.");
    }
    const attempt = this.#state.currentAttempt;
    if (attempt === null || attempt.status !== "active") {
      throw invariant("A broker source release requires an active agent attempt.");
    }

    const controller = new AbortController();
    this.#activeAbortController = controller;
    let result: ContextReleaseResult;
    try {
      result = await this.#requireContextBroker().releasePlannedSource({
        turnId: attempt.attemptId,
        sourceId: planned.sourceDescriptor.sourceId,
        sourceVersion: planned.sourceDescriptor.sourceVersion,
        request: planned.rawRequest,
        maximumBytes: planned.budget.maximumBytes,
        reason: "runtime.context.planned",
        signal: controller.signal,
      });
    } catch {
      const safe = externalError(
        "infrastructure_failed",
        "The context broker failed to release a planned source.",
      );
      await this.#append(
        this.#makeEvent(
          "ContextDenied",
          { requestId, error: safe },
          contextActor(planned.sourceDescriptor.sourceId),
          command.causedByEventId,
        ),
      );
      planned.released = true;
      return;
    } finally {
      this.#activeAbortController = null;
    }

    await this.#append(
      this.#makeEvent(
        "ContextManifestRecorded",
        {
          manifestKind: "release",
          referenceId: requestId,
          manifest: snapshotBoundaryJsonObject(result.manifest),
        },
        contextActor(planned.sourceDescriptor.sourceId),
        command.causedByEventId,
      ),
    );
    if (result.status === "denied") {
      await this.#append(
        this.#makeEvent(
          "ContextDenied",
          { requestId, error: result.error },
          contextActor(planned.sourceDescriptor.sourceId),
          command.causedByEventId,
        ),
      );
      planned.released = true;
      return;
    }
    const firstRelease = this.#recordBrokerItemRelease(result.item, result.manifest);
    const content = this.#brokerContentBlock(result.item, result.manifest);
    await this.#append(
      this.#makeEvent(
        "ContextReleased",
        { requestId, resource: result.item.resource, content: [content] },
        contextActor(planned.sourceDescriptor.sourceId),
        command.causedByEventId,
      ),
    );
    if (firstRelease) {
      this.#releasedSourceItemIds.push(result.item.itemId);
    } else if (!this.#releasedSourceItemIds.includes(result.item.itemId)) {
      throw invariant(
        "A deduplicated source item was not owned by an earlier source release.",
      );
    }
    planned.released = true;
  }

  async #evaluateAction(command: RuntimeCommand): Promise<void> {
    const current = this.#state.currentAction;
    const advertisement = this.#advertisement;
    if (current === null || current.phase !== "proposed" || advertisement === null) {
      throw invariant("Capability evaluation requires the current proposed action.");
    }
    const actionId = this.#options.ids.nextActionId();
    if (!ActionIdKind.is(actionId)) {
      await this.#failRun(
        invalidInput("The runtime ID factory returned an invalid action identifier."),
      );
      return;
    }
    if (this.#evaluatedActions.has(actionId)) {
      await this.#failRun(conflict("The runtime ID factory reused an action identifier."));
      return;
    }

    let prepared: PreparedCapabilityAction;
    try {
      prepared = await this.#options.capabilityGateway.normalize(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          packId: current.capabilityPackId,
          packVersion: current.capabilityPackVersion,
          operationId: current.operationId,
          operationVersion: current.operationVersion,
          input: current.input,
        },
        {
          actionId,
          subject: this.#subject,
          environment: this.#environment,
        },
        advertisement,
      );
    } catch {
      await this.#failRun(
        externalError("action_failed", "Capability action normalization failed."),
      );
      return;
    }

    if (prepared.actionHash !== canonicalSha256Hex(prepared.action)) {
      await this.#failRun(invariant("The capability gateway returned a mismatched action hash."));
      return;
    }
    await this.#append(
      this.#makeEvent(
        "ActionNormalized",
        { action: prepared.action },
        RUNTIME_ACTOR,
        command.causedByEventId,
      ),
    );

    let evaluated: EvaluatedCapabilityAction;
    try {
      evaluated = this.#options.capabilityGateway.evaluate(prepared);
      assertPolicyDecisionMatchesManifest(
        evaluated,
        this.#options.installedPolicy,
      );
    } catch {
      await this.#failRun(
        externalError("policy_denied", "Pinned policy evaluation failed closed."),
      );
      return;
    }
    this.#evaluatedActions.set(actionId, Object.freeze({ prepared, evaluated }));
    await this.#append(
      this.#makeEvent(
        "PolicyEvaluated",
        {
          actionId,
          policyVersionId: evaluated.decision.policyVersionId,
          decision: evaluated.decision.effect,
          trace: evaluated.decision.trace,
        },
        RUNTIME_ACTOR,
      ),
    );

    if (evaluated.decision.effect === "deny") {
      const error = createDomainError({
        code: "policy_denied",
        message: "The pinned policy snapshot denied this capability action.",
        details: {
          actionId,
          policyVersionId: evaluated.decision.policyVersionId,
          winningPolicyName: evaluated.decision.winningPolicyName,
        },
      });
      await this.#append(
        this.#makeEvent("ActionDenied", { actionId, error }, RUNTIME_ACTOR),
      );
      await this.#releaseFailureObservation(prepared.action, "denied", error);
    }
  }

  async #createApprovalRequest(command: RuntimeCommand): Promise<void> {
    const actionId = command.payload["actionId"];
    const current = this.#state.currentAction;
    const ownership = ActionIdKind.is(actionId)
      ? this.#evaluatedActions.get(actionId)
      : undefined;
    if (
      !ActionIdKind.is(actionId) ||
      current === null ||
      current.phase !== "approval_required" ||
      current.normalizedAction?.actionId !== actionId ||
      ownership === undefined ||
      ownership.evaluated.decision.effect !== "require_approval"
    ) {
      throw invariant("An approval request requires the exact approval-gated action.");
    }
    const approvalId = this.#options.ids.nextApprovalId();
    if (!ApprovalIdKind.is(approvalId)) {
      throw invalidInput("The runtime ID factory returned an invalid approval identifier.");
    }
    const preconditionHash = canonicalSha256Hex({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      action: ownership.prepared.action,
      policyVersionId: ownership.evaluated.decision.policyVersionId,
      policyContentHash: this.#options.installedPolicy.snapshotManifest[
        "policyContentHash"
      ]!,
      preconditions: ownership.prepared.action.preconditions,
    });
    await this.#append(
      this.#makeEvent(
        "ApprovalRequested",
        { approvalId, actionId, preconditionHash },
        RUNTIME_ACTOR,
        command.causedByEventId,
      ),
    );
  }

  async #executeAction(command: RuntimeCommand): Promise<void> {
    const actionId = command.payload["actionId"];
    if (!ActionIdKind.is(actionId)) {
      throw invariant("A capability execution command has an invalid action ID.");
    }
    const ownership = this.#evaluatedActions.get(actionId);
    if (
      ownership === undefined ||
      this.#state.currentAction?.phase !== "allowed" ||
      ownership.evaluated.decision.effect !== "allow"
    ) {
      throw invariant("Capability execution requires the exact evaluated allowed action.");
    }
    const { prepared, evaluated } = ownership;

    const startedAt = this.#now();
    await this.#append(
      this.#makeEvent(
        "ActionStarted",
        { actionId, startedAt },
        RUNTIME_ACTOR,
        command.causedByEventId,
      ),
    );
    const controller = new AbortController();
    this.#activeAbortController = controller;
    let executionResult: CapabilityExecutionResult;
    try {
      executionResult = await this.#options.capabilityGateway.execute(evaluated, {
        signal: controller.signal,
      });
    } catch {
      const safe = externalError(
        "action_failed",
        "The capability action failed.",
      );
      await this.#append(
        this.#makeEvent("ActionFailed", { actionId, error: safe }, RUNTIME_ACTOR),
      );
      await this.#releaseFailureObservation(prepared.action, "failed", safe);
      return;
    } finally {
      this.#activeAbortController = null;
    }

    const releaseTargetAttemptId = this.#preallocateNextAgentAttemptId();
    let releasedItem: ReleasedContextItem | null = null;
    let releasedManifest: ContextManifestEntry | null = null;
    let agentDisposition:
      | { readonly status: "succeeded"; readonly error: null }
      | {
          readonly status: "failed" | "denied";
          readonly error: AgentObservation["error"];
        };
    try {
      const release = await this.#requireContextBroker().releaseCapabilityAgentView({
        turnId: releaseTargetAttemptId,
        sourceVersion: executionResult.agentContextRelease.sourceVersion,
        resource: executionResult.agentContextRelease.resource,
        policyProjection: executionResult.agentContextRelease.policyProjection,
        output: executionResult.agent,
        classification: executionResult.agentContextRelease.classification,
        reason: executionResult.agentContextRelease.reason,
      });
      await this.#append(
        this.#makeEvent(
          "ContextManifestRecorded",
          {
            manifestKind: "release",
            referenceId: actionId,
            manifest: snapshotBoundaryJsonObject(release.manifest),
          },
          capabilityActor(prepared.action.capabilityPackId),
        ),
      );
      if (release.status === "released") {
        this.#recordBrokerItemRelease(release.item, release.manifest);
        releasedItem = release.item;
        releasedManifest = release.manifest;
        agentDisposition = Object.freeze({ status: "succeeded", error: null });
      } else {
        agentDisposition = Object.freeze({
          status: "denied",
          error: agentErrorProjection(release.error),
        });
      }
    } catch {
      const safe = externalError(
        "infrastructure_failed",
        "The context broker failed to release the capability agent view.",
      );
      agentDisposition = Object.freeze({
        status: "failed",
        error: agentErrorProjection(safe),
      });
    }

    let observationAndRecord: {
      readonly observation: Observation;
      readonly record: AgentObservationRecord;
    };
    try {
      const agentContent =
        releasedItem === null || releasedManifest === null
          ? Object.freeze([])
          : Object.freeze([
              this.#brokerContentBlock(releasedItem, releasedManifest),
            ]);
      observationAndRecord = this.#successObservation(
        prepared.action,
        executionResult,
        agentContent,
        releasedItem === null ? [] : [releasedItem.itemId],
        agentDisposition,
      );
    } catch (error: unknown) {
      const safe = safeError(
        error,
        "infrastructure_failed",
        "The capability result could not be represented safely.",
      );
      await this.#append(
        this.#makeEvent("ActionFailed", { actionId, error: safe }, RUNTIME_ACTOR),
      );
      await this.#failRun(safe);
      return;
    }
    const completedAt = this.#now();
    await this.#append(
      this.#makeEvent("ActionSucceeded", { actionId, completedAt }, RUNTIME_ACTOR),
    );
    await this.#append(
      this.#makeEvent(
        "ObservationReleased",
        { observation: observationAndRecord.observation },
        RUNTIME_ACTOR,
      ),
    );
    this.#agentObservationRecords.push(observationAndRecord.record);
  }

  #successObservation(
    action: NormalizedAction,
    result: CapabilityExecutionResult,
    agentContent: readonly ContentBlock[],
    itemIds: readonly string[],
    disposition:
      | { readonly status: "succeeded"; readonly error: null }
      | {
          readonly status: "failed" | "denied";
          readonly error: AgentObservation["error"];
        },
  ): {
    readonly observation: Observation;
    readonly record: AgentObservationRecord;
  } {
    const observationId = this.#nextObservationId();
    const occurredAt = this.#now();
    const safeDisposition =
      disposition.status === "succeeded"
        ? null
        : capabilityOutputDisposition(disposition.status);
    const observation = parseObservation({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      observationId,
      actionId: action.actionId,
      status: "succeeded",
      audit: safeDisposition ?? result.audit,
      human: [
        this.#jsonContentBlock(
          safeDisposition ?? result.human,
          null,
          safeDisposition === null
            ? capabilityActor(action.capabilityPackId)
            : RUNTIME_ACTOR,
          "internal",
        ),
      ],
      agent: agentContent,
      error: null,
      occurredAt,
    });
    const record: AgentObservationRecord = Object.freeze({
      observationId,
      actionId: action.actionId,
      status: disposition.status,
      error: disposition.error,
      occurredAt,
      itemIds: Object.freeze([...itemIds]),
    });
    return Object.freeze({ observation, record });
  }

  async #releaseFailureObservation(
    action: NormalizedAction,
    status: "failed" | "denied",
    error: DomainError,
  ): Promise<void> {
    let observation: Observation;
    let record: AgentObservationRecord;
    try {
      const safeView: JsonObject = {
        errorId: error.errorId,
        code: error.code,
        message: error.message,
        retry: error.retry,
      };
      const observationId = this.#nextObservationId();
      const occurredAt = this.#now();
      observation = parseObservation({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        observationId,
        actionId: action.actionId,
        status,
        audit: { errorId: error.errorId, code: error.code },
        human: [
          this.#jsonContentBlock(
            safeView,
            null,
            capabilityActor(action.capabilityPackId),
            "internal",
          ),
        ],
        agent: [],
        error,
        occurredAt,
      });
      record = Object.freeze({
        observationId,
        actionId: action.actionId,
        status,
        error: agentErrorProjection(error),
        occurredAt,
        itemIds: Object.freeze([]),
      });
    } catch (representationError: unknown) {
      await this.#failRun(
        safeError(
          representationError,
          "infrastructure_failed",
          "The action failure could not be represented safely.",
        ),
      );
      return;
    }
    await this.#append(
      this.#makeEvent("ObservationReleased", { observation }, RUNTIME_ACTOR),
    );
    this.#agentObservationRecords.push(record);
  }

  async #validateOutcome(command: RuntimeCommand): Promise<void> {
    const proposed = this.#state.proposedOutcome;
    if (proposed === null) {
      throw invariant("Outcome validation requires a proposed outcome.");
    }
    let validated: OutcomeEnvelope;
    try {
      validated = this.#options.profileRegistry.validateOutcome(proposed);
      if (canonicalize(validated) !== canonicalize(proposed)) {
        throw invariant("Outcome validation changed the proposed envelope.");
      }
      this.#validateEvidence(validated.evidence);
    } catch (error: unknown) {
      await this.#failRun(
        safeError(error, "invalid_input", "The proposed outcome failed validation."),
      );
      return;
    }
    await this.#append(
      this.#makeEvent(
        "OutcomeValidated",
        {
          outcomeId: validated.outcomeId,
          evidence: validated.evidence,
          validatedAt: this.#now(),
        },
        RUNTIME_ACTOR,
        command.causedByEventId,
      ),
    );
  }

  #validateEvidence(evidence: readonly OutcomeEvidenceRef[]): void {
    if (evidence.length > this.#limits.maximumEvidenceReferences) {
      throw budgetExceeded("Outcome evidence exceeds the reference-count bound.", {
        maximumEvidenceReferences: this.#limits.maximumEvidenceReferences,
      });
    }
    const seen = new Set<string>();
    for (const reference of evidence) {
      const key = evidenceKey(reference.kind, reference.referenceId);
      if (seen.has(key)) {
        throw invalidInput("An outcome cannot repeat the same evidence reference.");
      }
      seen.add(key);
      const recorded = this.#evidence.get(key);
      if (recorded === undefined) {
        throw invalidInput("Outcome evidence does not resolve in the run ledger.");
      }
      if (
        reference.contentHash !== null &&
        reference.contentHash !== recorded.contentHash
      ) {
        throw invalidInput("Outcome evidence content hash does not match the run ledger.");
      }
    }
  }

  async #finalize(command: RuntimeCommand): Promise<void> {
    const terminalStatus = command.payload["terminalStatus"];
    if (terminalStatus === "completed") {
      const outcome = this.#state.validatedOutcome;
      if (outcome === null) {
        throw invariant("A completed run requires an exact validated outcome.");
      }
      await this.#appendIntent("complete_run", "RunCompleted", {
        result: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          runId: this.#requireRunId(),
          status: "completed",
          outcome,
          finishedAt: this.#now(),
        },
      }, command.causedByEventId);
      return;
    }
    if (terminalStatus === "cancelled") {
      await this.#appendIntent("cancel_run", "RunCancelled", {
        result: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          runId: this.#requireRunId(),
          status: "cancelled",
          reason: this.#state.cancellation?.reason ?? null,
          finishedAt: this.#now(),
        },
      }, command.causedByEventId);
      return;
    }
    throw invariant("The dispatcher received an unsupported finalization status.");
  }

  async #failRun(error: DomainError): Promise<void> {
    if (TERMINAL_STATUSES.has(this.#state.status)) return;
    if (this.#state.outstandingCommand !== null) {
      throw invariant("A run cannot fail before consequential work is settled.");
    }
    await this.#appendIntent("fail_run", "RunFailed", {
      result: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        runId: this.#requireRunId(),
        status: "failed",
        error,
        finishedAt: this.#now(),
      },
    });
  }

  #jsonContentBlock(
    value: JsonObject,
    source: ResourceRef | null,
    producer: ActorIdentity,
    classification: string,
  ): JsonContentBlock {
    const snapshot = snapshotBoundaryJsonObject(value);
    const block = parseContentBlock({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      blockId: this.#nextContentBlockId(),
      modality: "json",
      mediaType: "application/json",
      byteLength: canonicalBytes(snapshot).byteLength,
      contentHash: canonicalSha256Hex(snapshot),
      classification,
      provenance: {
        source,
        producer,
        capturedAt: this.#now(),
      },
      retentionClass: "run",
      transformation: null,
      value: snapshot,
      jsonSchema: null,
    });
    if (block.modality !== "json") {
      throw invariant("The JSON content-block parser changed modality.");
    }
    return block;
  }

  #recordEvidence(envelope: GenericEventEnvelope): void {
    this.#evidence.set(evidenceKey("event", envelope.eventId), {
      contentHash: canonicalSha256Hex(envelope),
    });
    switch (envelope.eventType) {
      case "ActionNormalized":
        this.#evidence.set(evidenceKey("action", envelope.payload.action.actionId), {
          contentHash: canonicalSha256Hex(envelope.payload.action),
        });
        break;
      case "ObservationReleased":
        this.#evidence.set(
          evidenceKey("observation", envelope.payload.observation.observationId),
          { contentHash: canonicalSha256Hex(envelope.payload.observation) },
        );
        break;
      case "ContextReleased":
        for (const block of envelope.payload.content) {
          const source = block.provenance.source;
          if (source !== null) {
            this.#evidence.set(
              evidenceKey("resource", canonicalSha256Hex(source)),
              { contentHash: block.contentHash },
            );
          }
        }
        break;
      case "ArtifactReferenced":
        this.#evidence.set(evidenceKey("artifact", envelope.payload.artifactId), {
          contentHash: envelope.payload.contentHash,
        });
        break;
      default:
        break;
    }
  }

  #nextObservationId(): string {
    const value = this.#options.ids.nextObservationId();
    requireNonEmpty(value, "observation ID");
    if (this.#usedObservationIds.has(value)) {
      throw conflict("The runtime ID factory reused an observation identifier.");
    }
    this.#usedObservationIds.add(value);
    return value;
  }

  #nextContentBlockId(): string {
    const value = this.#options.ids.nextContentBlockId();
    requireNonEmpty(value, "content-block ID");
    if (this.#usedContentBlockIds.has(value)) {
      throw conflict("The runtime ID factory reused a content-block identifier.");
    }
    this.#usedContentBlockIds.add(value);
    return value;
  }

  #now(): string {
    let value: unknown;
    try {
      value = this.#options.clock.now();
    } catch {
      throw invariant("The runtime clock failed.");
    }
    if (typeof value !== "string" || !isCanonicalTimestamp(value)) {
      throw invariant("The runtime clock must return a canonical ISO timestamp.");
    }
    return value;
  }

  #requireRunId(): RunId {
    if (this.#runId === null) throw invariant("The runtime has no active run identifier.");
    return this.#runId;
  }

  #requireContextBroker(): ContextBrokerIntegration {
    if (this.#contextBroker === null) {
      throw invariant("The runtime has no active run-owned context broker.");
    }
    return this.#contextBroker;
  }

  #requireProfile(): TaskProfile {
    if (this.#profile === null) throw invariant("The runtime has no pinned task profile.");
    return this.#profile;
  }

  #requireObjective(): ObjectiveEnvelope {
    if (this.#objective === null) throw invariant("The runtime has no objective.");
    return this.#objective;
  }
}

function initialState(): RunState {
  // A function keeps construction independent for every host instance.
  return replay([]);
}

function parseContextPlanItem(value: unknown): RuntimeContextPlanItem {
  if (!isJsonRecord(value) || !hasExactKeys(value, ["bindingId", "input", "budget"])) {
    throw invalidInput("A context-plan item has unknown or missing fields.");
  }
  requireNonEmpty(value["bindingId"], "context binding ID");
  if (!isJsonRecord(value["input"])) {
    throw invalidInput("A context-plan input must be a JSON object.");
  }
  if (
    !isJsonRecord(value["budget"]) ||
    !hasExactKeys(value["budget"], ["maximumItems", "maximumBytes"])
  ) {
    throw invalidInput("A context-plan budget has unknown or missing fields.");
  }
  const maximumItems = value["budget"]["maximumItems"];
  const maximumBytes = value["budget"]["maximumBytes"];
  requireNonNegativeSafeInteger(maximumItems, "maximumItems");
  requireNonNegativeSafeInteger(maximumBytes, "maximumBytes");
  return Object.freeze({
    bindingId: value["bindingId"],
    input: value["input"],
    budget: Object.freeze({ maximumItems, maximumBytes }),
  });
}

function validateDriverTurn(
  parsed: readonly AgentDriverEvent[],
): readonly AgentDriverEvent[] {
  let decisionSeen = false;
  let terminalSeen = false;
  let failedSeen = false;
  for (const event of parsed) {
    if (terminalSeen) {
      throw invalidInput("An agent driver emitted data after a terminal event.");
    }
    if (
      decisionSeen &&
      event.type !== "usage_reported" &&
      event.type !== "completed"
    ) {
      throw invalidInput("An agent driver emitted non-usage data after its turn decision.");
    }
    switch (event.type) {
      case "action_proposed":
      case "outcome_proposed":
        if (decisionSeen) {
          throw invalidInput("An agent turn may contain only one action or outcome decision.");
        }
        decisionSeen = true;
        break;
      case "paused":
      case "failed":
        terminalSeen = true;
        failedSeen = true;
        break;
      case "completed":
        terminalSeen = true;
        if (!decisionSeen) {
          throw invalidInput("A completed agent turn must propose an action or outcome.");
        }
        break;
      default:
        break;
    }
  }
  if (!decisionSeen && !failedSeen) {
    throw invalidInput("An agent turn ended without an action, outcome, or failure.");
  }
  return Object.freeze([...parsed]);
}

function parseDriverEvent(
  value: unknown,
  advertisement: readonly AdvertisedOperation[],
  maximumEventBytes: number,
): AgentDriverEvent {
  const candidate = snapshotBoundaryJsonObject(value);
  if (canonicalBytes(candidate).byteLength > maximumEventBytes) {
    throw budgetExceeded("A driver event exceeds the byte bound.", {
      maximumDriverEventBytes: maximumEventBytes,
    });
  }
  const type = candidate["type"];
  if (typeof type !== "string") {
    throw invalidInput("A driver event requires a type.");
  }
  switch (type) {
    case "content_delta": {
      requireExact(candidate, ["type", "channel", "delta"], "content delta");
      const channel = parseChannel(candidate["channel"]);
      requireNonEmpty(candidate["delta"], "content delta");
      return Object.freeze({ type, channel, delta: candidate["delta"] });
    }
    case "content_completed": {
      requireExact(candidate, ["type", "channel", "content"], "completed content");
      return Object.freeze({
        type,
        channel: parseChannel(candidate["channel"]),
        content: parseContentBlock(candidate["content"]),
      });
    }
    case "action_proposed": {
      requireExact(
        candidate,
        [
          "type",
          "proposalId",
          "capabilityPackId",
          "capabilityPackVersion",
          "operationId",
          "operationVersion",
          "input",
        ],
        "action proposal",
      );
      const proposalId = candidate["proposalId"];
      const capabilityPackId = candidate["capabilityPackId"];
      const capabilityPackVersion = candidate["capabilityPackVersion"];
      const operationId = candidate["operationId"];
      const operationVersion = candidate["operationVersion"];
      if (
        !DriverProposalIdKind.is(proposalId) ||
        typeof capabilityPackId !== "string" ||
        capabilityPackId.trim().length === 0 ||
        !isPositiveSafeInteger(capabilityPackVersion) ||
        typeof operationId !== "string" ||
        operationId.trim().length === 0 ||
        !isPositiveSafeInteger(operationVersion) ||
        !isJsonRecord(candidate["input"])
      ) {
        throw invalidInput("A driver action proposal is malformed.");
      }
      if (
        !advertisement.some(
          (operation) =>
            operation.capabilityPackId === capabilityPackId &&
            operation.capabilityPackVersion === capabilityPackVersion &&
            operation.operationId === operationId &&
            operation.operationVersion === operationVersion,
        )
      ) {
        throw invalidInput("A driver proposed an operation that was not exactly advertised.");
      }
      return Object.freeze({
        type,
        proposalId,
        capabilityPackId,
        capabilityPackVersion,
        operationId,
        operationVersion,
        input: candidate["input"],
      });
    }
    case "outcome_proposed":
      requireExact(candidate, ["type", "outcome"], "outcome proposal");
      return Object.freeze({ type, outcome: parseOutcomeEnvelope(candidate["outcome"]) });
    case "usage_reported": {
      requireExact(candidate, ["type", "dimensions"], "usage record");
      if (!isJsonRecord(candidate["dimensions"])) {
        throw invalidInput("Driver usage dimensions must be an object.");
      }
      for (const [name, amount] of Object.entries(candidate["dimensions"])) {
        requireNonEmpty(name, "usage dimension name");
        requireNonNegativeSafeInteger(amount, `usage dimension ${name}`);
      }
      return Object.freeze({ type, dimensions: candidate["dimensions"] as Record<string, number> });
    }
    case "paused": {
      requireExact(candidate, ["type", "reason"], "pause event");
      const reason = candidate["reason"];
      if (
        reason !== "awaiting_observation" &&
        reason !== "awaiting_approval" &&
        reason !== "budget_boundary" &&
        reason !== "external"
      ) {
        throw invalidInput("A driver pause reason is invalid.");
      }
      return Object.freeze({ type, reason });
    }
    case "completed":
      requireExact(candidate, ["type"], "completion event");
      return Object.freeze({ type });
    case "failed":
      requireExact(candidate, ["type", "error"], "failure event");
      return Object.freeze({ type, error: parseDomainError(candidate["error"]) });
    default:
      throw invalidInput("The agent driver emitted an unknown event type.");
  }
}

function assertPolicyDecisionMatchesManifest(
  evaluated: EvaluatedCapabilityAction,
  installed: CapturedOptions["installedPolicy"],
): void {
  const decision = evaluated.decision;
  const manifest = installed.snapshotManifest;
  let actual: JsonObject;
  let expected: JsonObject;
  try {
    actual = snapshotBoundaryJsonObject({
      schemaVersion: 1,
      policyVersionId: decision.policyVersionId,
      languageVersion: decision.trace["languageVersion"],
      policyContentHash: decision.trace["policyContentHash"],
      defaultEffect: decision.trace["defaultEffect"],
      attributeCatalogs: decision.trace["attributeCatalogs"],
    });
    expected = snapshotBoundaryJsonObject({
      schemaVersion: manifest["schemaVersion"],
      policyVersionId: manifest["policyVersionId"],
      languageVersion: manifest["languageVersion"],
      policyContentHash: manifest["policyContentHash"],
      defaultEffect: manifest["defaultEffect"],
      attributeCatalogs: manifest["attributeCatalogs"],
    });
  } catch {
    throw invariant("The gateway policy decision has no valid snapshot manifest.");
  }
  if (
    decision.policyVersionId !== installed.policyVersionId ||
    canonicalize(actual) !== canonicalize(expected)
  ) {
    throw invariant(
      "The gateway policy decision does not match the run-pinned snapshot manifest.",
    );
  }
}

function captureOptions(value: unknown): CapturedOptions {
  const fields = inspectExactDataFields(
    value,
    [
      "eventStore",
      "profileRegistry",
      "installedDriver",
      "contextBrokerFactory",
      "capabilityPacks",
      "capabilityGateway",
      "contextPlanner",
      "installedPolicy",
      "normalizationSubject",
      "normalizationEnvironment",
      "clock",
      "ids",
    ],
    ["limits"],
    "Runtime-host options",
  );
  const eventStore = requireObjectPort(fields["eventStore"], "event store");
  const profileRegistry = requireObjectPort(
    fields["profileRegistry"],
    "profile registry",
  );
  const contextBrokerFactory = captureContextBrokerIntegrationFactory(
    fields["contextBrokerFactory"],
  );
  const capabilityPacks = requireObjectPort(
    fields["capabilityPacks"],
    "capability-pack registry",
  );
  const capabilityGateway = requireObjectPort(
    fields["capabilityGateway"],
    "capability gateway",
  );
  const contextPlanner = requireObjectPort(
    fields["contextPlanner"],
    "context planner",
  );
  const clock = requireObjectPort(fields["clock"], "runtime clock");
  const ids = requireObjectPort(fields["ids"], "runtime ID factory");

  const installed = inspectExactDataFields(
    fields["installedDriver"],
    ["componentId", "componentVersion", "driver"],
    [],
    "Installed-driver binding",
  );
  const driver = requireObjectPort(installed["driver"], "installed agent driver");
  const descriptor = safeSnapshot(
    readDataProperty(driver, "descriptor", "installed agent driver"),
    "The installed agent-driver descriptor is invalid.",
  );

  const policy = inspectExactDataFields(
    fields["installedPolicy"],
    ["componentId", "componentVersion", "snapshot"],
    [],
    "Installed policy binding",
  );
  let manifest: JsonObject;
  try {
    manifest = createPolicySnapshotManifest(
      policy["snapshot"] as SynchronousRuntimeHostOptions["installedPolicy"]["snapshot"],
    );
  } catch {
    throw invalidInput("The installed policy snapshot was not produced by the compiler.");
  }
  const policySnapshot = safeSnapshot(
    {
      componentId: policy["componentId"],
      componentVersion: policy["componentVersion"],
      policyVersionId: manifest["policyVersionId"],
      snapshotManifest: manifest,
    },
    "The installed policy binding is invalid.",
  );

  const captured: CapturedOptions = {
    eventStore: Object.freeze({
      append: bindMethod<SynchronousRuntimeHostOptions["eventStore"]["append"]>(
        eventStore,
        "append",
        "event store",
      ),
      read: bindMethod<SynchronousRuntimeHostOptions["eventStore"]["read"]>(
        eventStore,
        "read",
        "event store",
      ),
    }),
    profileRegistry: Object.freeze({
      resolve: bindMethod<
        SynchronousRuntimeHostOptions["profileRegistry"]["resolve"]
      >(profileRegistry, "resolve", "profile registry"),
      validateObjective: bindMethod<
        SynchronousRuntimeHostOptions["profileRegistry"]["validateObjective"]
      >(
        profileRegistry,
        "validateObjective",
        "profile registry",
      ),
      validateOutcome: bindMethod<
        SynchronousRuntimeHostOptions["profileRegistry"]["validateOutcome"]
      >(
        profileRegistry,
        "validateOutcome",
        "profile registry",
      ),
    }),
    installedDriver: Object.freeze({
      componentId: installed["componentId"] as string,
      componentVersion: installed["componentVersion"] as number,
      driver: Object.freeze({
        descriptor,
        advance: bindMethod<
          SynchronousRuntimeHostOptions["installedDriver"]["driver"]["advance"]
        >(driver, "advance", "installed agent driver"),
      }),
    }),
    contextBrokerFactory,
    capabilityPacks: Object.freeze({
      listPacks: bindMethod<
        SynchronousRuntimeHostOptions["capabilityPacks"]["listPacks"]
      >(capabilityPacks, "listPacks", "capability-pack registry"),
      createAdvertisement: bindMethod<
        SynchronousRuntimeHostOptions["capabilityPacks"]["createAdvertisement"]
      >(
        capabilityPacks,
        "createAdvertisement",
        "capability-pack registry",
      ),
    }),
    capabilityGateway: Object.freeze({
      normalize: bindMethod<
        SynchronousRuntimeHostOptions["capabilityGateway"]["normalize"]
      >(capabilityGateway, "normalize", "capability gateway"),
      evaluate: bindMethod<
        SynchronousRuntimeHostOptions["capabilityGateway"]["evaluate"]
      >(capabilityGateway, "evaluate", "capability gateway"),
      execute: bindMethod<
        SynchronousRuntimeHostOptions["capabilityGateway"]["execute"]
      >(capabilityGateway, "execute", "capability gateway"),
    }),
    contextPlanner: Object.freeze({
      plan: bindMethod<SynchronousRuntimeHostOptions["contextPlanner"]["plan"]>(
        contextPlanner,
        "plan",
        "context planner",
      ),
    }),
    installedPolicy: Object.freeze({
      componentId: policySnapshot["componentId"] as string,
      componentVersion: policySnapshot["componentVersion"] as number,
      policyVersionId: policySnapshot["policyVersionId"] as PolicyVersionId,
      snapshotManifest: policySnapshot["snapshotManifest"] as JsonObject,
    }),
    normalizationSubject: safeSnapshot(
      fields["normalizationSubject"],
      "The normalization subject is invalid.",
    ),
    normalizationEnvironment: safeSnapshot(
      fields["normalizationEnvironment"],
      "The normalization environment is invalid.",
    ),
    clock: Object.freeze({
      now: bindMethod<SynchronousRuntimeHostOptions["clock"]["now"]>(
        clock,
        "now",
        "runtime clock",
      ),
    }),
    ids: Object.freeze({
      nextRunId: bindMethod<SynchronousRuntimeHostOptions["ids"]["nextRunId"]>(
        ids,
        "nextRunId",
        "runtime ID factory",
      ),
      nextEventId: bindMethod<SynchronousRuntimeHostOptions["ids"]["nextEventId"]>(
        ids,
        "nextEventId",
        "runtime ID factory",
      ),
      nextAgentAttemptId: bindMethod<
        SynchronousRuntimeHostOptions["ids"]["nextAgentAttemptId"]
      >(
        ids,
        "nextAgentAttemptId",
        "runtime ID factory",
      ),
      nextActionId: bindMethod<
        SynchronousRuntimeHostOptions["ids"]["nextActionId"]
      >(ids, "nextActionId", "runtime ID factory"),
      nextApprovalId: bindMethod<
        SynchronousRuntimeHostOptions["ids"]["nextApprovalId"]
      >(ids, "nextApprovalId", "runtime ID factory"),
      nextContextRequestId: bindMethod<
        SynchronousRuntimeHostOptions["ids"]["nextContextRequestId"]
      >(
        ids,
        "nextContextRequestId",
        "runtime ID factory",
      ),
      nextContentBlockId: bindMethod<
        SynchronousRuntimeHostOptions["ids"]["nextContentBlockId"]
      >(
        ids,
        "nextContentBlockId",
        "runtime ID factory",
      ),
      nextObservationId: bindMethod<
        SynchronousRuntimeHostOptions["ids"]["nextObservationId"]
      >(
        ids,
        "nextObservationId",
        "runtime ID factory",
      ),
    }),
    limits:
      fields["limits"] === undefined
        ? undefined
        : (safeSnapshot(fields["limits"], "Runtime-host limits are invalid.") as
            SynchronousRuntimeHostOptions["limits"]),
  };
  return Object.freeze(captured);
}

function inspectExactDataFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    const object = requireObjectPort(value, label);
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(object);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))
    ) {
      throw new TypeError("unknown or missing fields");
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("symbol field");
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("accessor or hidden field");
      }
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw invalidInput(`${label} must contain exact enumerable data properties.`);
  }
}

function requireObjectPort(value: unknown, label: string): object {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    isProxy(value)
  ) {
    throw invalidInput(`${label} must be a non-proxy trusted object.`);
  }
  return value;
}

function readDataProperty(value: object, key: string, label: string): unknown {
  let current: object | null = value;
  try {
    while (current !== null) {
      if (isProxy(current)) throw new TypeError("proxy prototype");
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        if (!("value" in descriptor)) throw new TypeError("accessor property");
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    throw invalidInput(`${label}.${key} must be a data property.`);
  }
  throw invalidInput(`${label}.${key} is missing.`);
}

function bindMethod<TFunction>(
  value: object,
  key: string,
  label: string,
): TFunction {
  const method = readDataProperty(value, key, label);
  if (typeof method !== "function" || isProxy(method)) {
    throw invalidInput(`${label}.${key} must be a trusted function.`);
  }
  return ((...args: unknown[]) => Reflect.apply(method, value, args)) as TFunction;
}

function safeSnapshot(value: unknown, message: string): JsonObject {
  try {
    return snapshotBoundaryJsonObject(value);
  } catch {
    throw invalidInput(message);
  }
}

function normalizeLimits(value: SynchronousRuntimeHostOptions["limits"]): HostLimits {
  const candidate = snapshotBoundaryJsonObject(value ?? {});
  const allowed = new Set([
    "maximumContextPlanItems",
    "maximumContextItemsPerRequest",
    "maximumContextBytesPerRequest",
    "maximumDriverEventsPerTurn",
    "maximumDriverEventBytes",
    "maximumEvidenceReferences",
    "maximumDispatchedCommands",
  ]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw invalidInput("Runtime-host limits contain an unknown field.");
  }
  return Object.freeze({
    maximumContextPlanItems: positiveOption(
      candidate,
      "maximumContextPlanItems",
      DEFAULT_LIMITS.maximumContextPlanItems,
    ),
    maximumContextItemsPerRequest: positiveOption(
      candidate,
      "maximumContextItemsPerRequest",
      DEFAULT_LIMITS.maximumContextItemsPerRequest,
    ),
    maximumContextBytesPerRequest: positiveOption(
      candidate,
      "maximumContextBytesPerRequest",
      DEFAULT_LIMITS.maximumContextBytesPerRequest,
    ),
    maximumDriverEventsPerTurn: positiveOption(
      candidate,
      "maximumDriverEventsPerTurn",
      DEFAULT_LIMITS.maximumDriverEventsPerTurn,
    ),
    maximumDriverEventBytes: positiveOption(
      candidate,
      "maximumDriverEventBytes",
      DEFAULT_LIMITS.maximumDriverEventBytes,
    ),
    maximumEvidenceReferences: positiveOption(
      candidate,
      "maximumEvidenceReferences",
      DEFAULT_LIMITS.maximumEvidenceReferences,
    ),
    maximumDispatchedCommands: positiveOption(
      candidate,
      "maximumDispatchedCommands",
      DEFAULT_LIMITS.maximumDispatchedCommands,
    ),
  });
}

function positiveOption(
  value: JsonObject,
  field: keyof HostLimits,
  fallback: number,
): number {
  if (!Object.hasOwn(value, field)) return fallback;
  const option = value[field];
  if (!isPositiveSafeInteger(option)) {
    throw invalidInput(`${field} must be a positive safe integer.`);
  }
  return option;
}

function assertNoDuplicateComponentIdentities(
  bindings: readonly {
    readonly componentId: string;
    readonly componentVersion: number;
  }[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.componentId}\u0000${String(binding.componentVersion)}`;
    if (seen.has(key)) {
      throw invalidInput(`A ${label} identity may be pinned only once.`);
    }
    seen.add(key);
  }
}

function validateInstalledIdentity(
  id: unknown,
  version: unknown,
  label: string,
): void {
  requireNonEmpty(id, `${label} component ID`);
  if (!isPositiveSafeInteger(version)) {
    throw invalidInput(`The ${label} component version is invalid.`);
  }
}

function compareOperationReference(
  left: {
    readonly packId: string;
    readonly packVersion: number;
    readonly operationId: string;
    readonly operationVersion: number;
  },
  right: {
    readonly packId: string;
    readonly packVersion: number;
    readonly operationId: string;
    readonly operationVersion: number;
  },
): number {
  return (
    left.packId.localeCompare(right.packId) ||
    left.packVersion - right.packVersion ||
    left.operationId.localeCompare(right.operationId) ||
    left.operationVersion - right.operationVersion
  );
}

function compareSourceIdentity(
  left: { readonly sourceId: string; readonly sourceVersion: number },
  right: { readonly sourceId: string; readonly sourceVersion: number },
): number {
  return (
    left.sourceId.localeCompare(right.sourceId) ||
    left.sourceVersion - right.sourceVersion
  );
}

function parseChannel(value: unknown): "analysis" | "answer" {
  if (value !== "analysis" && value !== "answer") {
    throw invalidInput("A driver content channel is invalid.");
  }
  return value;
}

function requireExact(value: JsonObject, keys: readonly string[], label: string): void {
  if (!hasExactKeys(value, keys)) {
    throw invalidInput(`A driver ${label} has unknown or missing fields.`);
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isJsonRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requireNonNegativeSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${label} must be a non-negative safe integer.`);
  }
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput(`${label} must be a non-empty string.`);
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw budgetExceeded(`${label} overflowed.`);
  }
  return value;
}

function isCanonicalTimestamp(value: string): boolean {
  const instant = new Date(value);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value;
}

function evidenceKey(kind: OutcomeEvidenceRef["kind"], referenceId: string): string {
  return `${kind}\u0000${referenceId}`;
}

function agentActor(id: string): ActorIdentity {
  return Object.freeze({ kind: "agent_driver", id });
}

function contextActor(id: string): ActorIdentity {
  return Object.freeze({ kind: "context_source", id });
}

function capabilityActor(id: string): ActorIdentity {
  return Object.freeze({ kind: "capability_worker", id });
}

function safeError(
  error: unknown,
  code:
    | "invalid_input"
    | "action_failed"
    | "driver_failed"
    | "infrastructure_failed"
    | "policy_denied",
  message: string,
): DomainError {
  try {
    if (isDomainError(error)) return parseDomainError(error);
  } catch {
    // A hostile thrown value is replaced by a bounded host-created error.
  }
  return createDomainError({ code, message });
}

function externalError(
  code:
    | "invalid_input"
    | "action_failed"
    | "driver_failed"
    | "infrastructure_failed"
    | "policy_denied",
  message: string,
): DomainError {
  return createDomainError({ code, message });
}

function agentErrorProjection(
  error: DomainError,
): NonNullable<AgentObservation["error"]> {
  return Object.freeze({
    errorId: error.errorId,
    code: error.code,
    message: error.message,
    retry: error.retry,
  });
}

function capabilityOutputDisposition(
  status: CapabilityOutputDisposition["agentViewStatus"],
): CapabilityOutputDisposition {
  return status === "denied"
    ? DENIED_CAPABILITY_OUTPUT_DISPOSITION
    : FAILED_CAPABILITY_OUTPUT_DISPOSITION;
}

function invalidInput(message: string): DomainError {
  return createDomainError({ code: "invalid_input", message });
}

function invariant(message: string): DomainError {
  return createDomainError({ code: "invariant_violated", message });
}

function conflict(message: string): DomainError {
  return createDomainError({ code: "conflict", message });
}

function budgetExceeded(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): DomainError {
  return createDomainError({
    code: "budget_exceeded",
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function assertNever(value: never): never {
  throw invariant(`Unhandled dispatcher value: ${String(value)}`);
}
