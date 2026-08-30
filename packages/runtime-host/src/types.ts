import type {
  ActionId,
  AgentAttemptId,
  ApprovalId,
  EventId,
  GenericEventEnvelope,
  JsonObject,
  ObjectiveEnvelope,
  RunId,
  TaskProfile,
} from "@guard/contracts";
import type { AgentDriver } from "@guard/agent-driver";
import type { CapabilityGateway, CapabilityPackRegistry } from "@guard/capability-gateway";
import type { ContextSourceRegistry } from "@guard/context-broker";
import type { EventStore } from "@guard/event-store";
import type { TaskProfileRegistry } from "@guard/profile-registry";
import type { RunState } from "@guard/runtime";
import type { PolicySnapshot } from "@guard/policy-engine";

export interface RuntimeHostClock {
  now(): string;
}

/**
 * All run-owned identities cross one injectable seam. Production callers can
 * use UUIDv7-backed implementations; deterministic tests can supply a finite
 * sequence and prove byte-for-byte history stability.
 */
export interface RuntimeHostIdFactory {
  nextRunId(): RunId;
  nextEventId(): EventId;
  nextAgentAttemptId(turn: number): AgentAttemptId;
  nextActionId(): ActionId;
  nextApprovalId(): ApprovalId;
  nextContextRequestId(): string;
  nextContentBlockId(): string;
  nextObservationId(): string;
}

export interface InstalledAgentDriver {
  readonly componentId: string;
  readonly componentVersion: number;
  readonly driver: AgentDriver;
}

export interface InstalledPolicy {
  readonly componentId: string;
  readonly componentVersion: number;
  readonly snapshot: PolicySnapshot;
}

/** A task-neutral request for one exactly pinned context-source binding. */
export interface RuntimeContextPlanItem {
  readonly bindingId: string;
  readonly input: JsonObject;
  readonly budget: {
    readonly maximumItems: number;
    readonly maximumBytes: number;
  };
}

export interface RuntimeContextPlanner {
  plan(input: {
    readonly objective: ObjectiveEnvelope;
    readonly taskProfile: TaskProfile;
  }): readonly RuntimeContextPlanItem[];
}

export interface RuntimeHostLimits {
  readonly maximumContextPlanItems?: number;
  readonly maximumContextItemsPerRequest?: number;
  readonly maximumContextBytesPerRequest?: number;
  readonly maximumDriverEventsPerTurn?: number;
  readonly maximumDriverEventBytes?: number;
  readonly maximumEvidenceReferences?: number;
  readonly maximumDispatchedCommands?: number;
}

export interface SynchronousRuntimeHostOptions {
  readonly eventStore: EventStore;
  readonly profileRegistry: TaskProfileRegistry;
  readonly installedDriver: InstalledAgentDriver;
  readonly contextSources: ContextSourceRegistry;
  readonly capabilityPacks: CapabilityPackRegistry;
  readonly capabilityGateway: CapabilityGateway;
  readonly contextPlanner: RuntimeContextPlanner;
  readonly installedPolicy: InstalledPolicy;
  readonly normalizationSubject: JsonObject;
  readonly normalizationEnvironment: JsonObject;
  readonly clock: RuntimeHostClock;
  readonly ids: RuntimeHostIdFactory;
  readonly limits?: RuntimeHostLimits;
}

export interface RuntimeHostExecution {
  readonly runId: RunId;
  readonly state: RunState;
  readonly history: readonly GenericEventEnvelope[];
}

export interface RuntimeHostReplay {
  readonly runId: RunId;
  readonly state: RunState;
  readonly history: readonly GenericEventEnvelope[];
}
