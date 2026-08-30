import type {
  AgentAttemptId,
  ContentBlock,
  JsonObject,
} from "@guard/contracts";

export const MODEL_PROVIDER_SCHEMA_VERSION = 1 as const;

export type ModelProviderSchemaVersion = typeof MODEL_PROVIDER_SCHEMA_VERSION;

export interface ModelSelection {
  readonly modelId: string;
  readonly settings: JsonObject;
}

export type SemanticConversationRole =
  | "developer"
  | "user"
  | "assistant"
  | "operation";

export interface SemanticConversationItem {
  readonly role: SemanticConversationRole;
  readonly content: readonly ContentBlock[];
  /** Associates an operation result with an earlier structured call, when present. */
  readonly correlationId?: string;
}

/**
 * A provider-independent operation advertisement. Provider adapters compile
 * this semantic shape to their own function/tool dialect.
 */
export interface SemanticOperationDefinition {
  readonly operationId: string;
  readonly operationVersion: number;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export type ModelActionMode = "structured" | "none";

/**
 * Complete semantic input to a model. It contains no URL, SDK object, API key,
 * HTTP header, or provider-owned event item.
 */
export interface SemanticModelRequest {
  readonly schemaVersion: ModelProviderSchemaVersion;
  readonly attemptId: AgentAttemptId;
  readonly model: ModelSelection;
  readonly instructions: readonly string[];
  readonly conversation: readonly SemanticConversationItem[];
  readonly operations: readonly SemanticOperationDefinition[];
  readonly maximumOutputUnits: number;
  readonly actionMode: ModelActionMode;
  readonly metadata: JsonObject;
}

export interface ModelUsageEvent {
  readonly type: "usage_reported";
  /** Adapter-normalized, non-negative counters with stable documented names. */
  readonly dimensions: Readonly<Record<string, number>>;
}

export type ModelFinishReason =
  | "stop"
  | "action_required"
  | "length"
  | "content_filter"
  | "other";

export type ModelFailureRetry = "terminal" | "retryable" | "uncertain";
export type ModelResultCertainty = "no_result" | "partial_result" | "uncertain";

export interface ModelFailure {
  readonly code: string;
  /** Safe text only. Adapters must remove credentials and raw upstream bodies. */
  readonly message: string;
  readonly retry: ModelFailureRetry;
  readonly resultCertainty: ModelResultCertainty;
}

export type ModelProviderEvent =
  | {
      readonly type: "text_delta";
      readonly outputIndex: number;
      readonly delta: string;
    }
  | {
      readonly type: "content_completed";
      readonly outputIndex: number;
      readonly content: ContentBlock;
    }
  | {
      readonly type: "action_started";
      readonly callId: string;
      readonly operationId: string;
    }
  | {
      readonly type: "action_arguments_delta";
      readonly callId: string;
      readonly delta: string;
    }
  | {
      readonly type: "action_completed";
      readonly callId: string;
      readonly operationId: string;
      readonly arguments: JsonObject;
    }
  | ModelUsageEvent
  | {
      readonly type: "response_completed";
      readonly finishReason: ModelFinishReason;
    }
  | {
      readonly type: "response_failed";
      readonly failure: ModelFailure;
    };

export interface ModelProviderCapabilities {
  readonly streaming: boolean;
  readonly structuredActions: boolean;
  readonly exactUsage: boolean;
  readonly cancellation: "confirmed" | "best_effort" | "unsupported";
}

export interface ModelProviderDescriptor {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly capabilities: ModelProviderCapabilities;
}

/**
 * Provider-neutral port. Authentication and transport are deliberately not
 * part of this interface; a real adapter receives a reviewed transport at its
 * composition boundary, never credential bytes in a semantic request.
 */
export interface ModelProvider {
  readonly descriptor: ModelProviderDescriptor;
  respond(
    request: SemanticModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelProviderEvent>;
}
