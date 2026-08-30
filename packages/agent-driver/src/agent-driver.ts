import type {
  AgentAttemptId,
  ContentBlock,
  DomainError,
  DriverProposalId,
  JsonObject,
  ObjectiveEnvelope,
  Observation,
  OutcomeEnvelope,
  RunId,
} from "@guard/contracts";

export const AGENT_DRIVER_SCHEMA_VERSION = 1 as const;

export type AgentDriverSchemaVersion = typeof AGENT_DRIVER_SCHEMA_VERSION;

export interface AdvertisedOperation {
  readonly operationId: string;
  readonly operationVersion: number;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

/**
 * The complete, immutable input to one planning turn. Exact observations are
 * released agent views; raw capability results never cross this boundary.
 */
export interface AgentTurnRequest {
  readonly schemaVersion: AgentDriverSchemaVersion;
  readonly runId: RunId;
  readonly attemptId: AgentAttemptId;
  readonly turnNumber: number;
  readonly objective: ObjectiveEnvelope;
  readonly advertisedOperations: readonly AdvertisedOperation[];
  readonly context: readonly ContentBlock[];
  readonly observations: readonly Observation[];
}

export type AgentContentChannel = "analysis" | "answer";
export type AgentPauseReason =
  | "awaiting_observation"
  | "awaiting_approval"
  | "budget_boundary"
  | "external";

/**
 * Normalized driver output. This vocabulary deliberately contains no model,
 * SDK, provider, token-protocol, or transport-specific fields.
 */
export type AgentDriverEvent =
  | {
      readonly type: "content_delta";
      readonly channel: AgentContentChannel;
      readonly delta: string;
    }
  | {
      readonly type: "content_completed";
      readonly channel: AgentContentChannel;
      readonly content: ContentBlock;
    }
  | {
      readonly type: "action_proposed";
      readonly proposalId: DriverProposalId;
      readonly operationId: string;
      readonly operationVersion: number;
      readonly input: JsonObject;
    }
  | {
      readonly type: "outcome_proposed";
      readonly outcome: OutcomeEnvelope;
    }
  | {
      readonly type: "usage_reported";
      readonly dimensions: Readonly<Record<string, number>>;
    }
  | {
      readonly type: "paused";
      readonly reason: AgentPauseReason;
    }
  | {
      readonly type: "completed";
    }
  | {
      readonly type: "failed";
      readonly error: DomainError;
    };

export interface AgentDriverCapabilities {
  readonly driverKind:
    | "scripted"
    | "direct_model"
    | "protocol"
    | "hosted"
    | "contained_cli"
    | "coordinator";
  readonly contextDelivery:
    | "mediated_items"
    | "filtered_snapshot"
    | "remote_package"
    | "opaque";
  readonly actionDelivery:
    | "structured"
    | "protocol_mapped"
    | "candidate_outcome"
    | "none";
  readonly transcriptVisibility: "exact" | "protocol_only" | "opaque";
  readonly credentialOwnership: "guard_transport" | "agent_process" | "none";
  readonly resume: "lossless" | "best_effort" | "unsupported";
  readonly cancellation: "confirmed" | "best_effort" | "unsupported";
  readonly canSpawnUndeclaredAgents: false;
}

export interface AgentDriverDescriptor {
  readonly driverId: string;
  readonly driverVersion: string;
  readonly capabilities: AgentDriverCapabilities;
}

export interface AgentDriver {
  readonly descriptor: AgentDriverDescriptor;
  advance(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentDriverEvent>;
}
