import {
  AgentAttemptIdKind,
  CONTRACT_SCHEMA_VERSION,
  canonicalBytes,
  canonicalSha256Hex,
  createDomainError,
  parseContentBlock,
  sha256Hex,
  snapshotBoundaryJsonObject,
  type AgentAttemptId,
  type ContentBlock,
  type JsonObject,
} from "@guard/contracts";
import {
  MODEL_PROVIDER_SCHEMA_VERSION,
  type SemanticConversationItem,
  type SemanticModelRequest,
  type SemanticOperationDefinition,
} from "@guard/model-provider";

import { isValidProviderCallId } from "./provider-call-id.js";

export interface PromptCompilerOptions {
  readonly sessionId: string;
  readonly modelId: string;
  readonly instructions: readonly string[];
  readonly operations: readonly SemanticOperationDefinition[];
  readonly maximumOutputUnits: number;
}

export interface CompilePromptInput {
  readonly attemptId: AgentAttemptId;
  readonly turnNumber: number;
  readonly requestNumber: number;
  readonly conversation: readonly SemanticConversationItem[];
  readonly maximumOutputUnits?: number;
}

/** Minimal versioned semantic request compiler for the R1 in-memory loop. */
export class PromptCompiler {
  readonly #sessionId: string;
  readonly #modelId: string;
  readonly #instructions: readonly string[];
  readonly #operations: readonly SemanticOperationDefinition[];
  readonly #maximumOutputUnits: number;

  public constructor(options: PromptCompilerOptions) {
    this.#sessionId = boundedIdentifier(options.sessionId, "sessionId");
    this.#modelId = boundedIdentifier(options.modelId, "modelId");
    this.#instructions = captureInstructions(options.instructions);
    this.#operations = captureOperations(options.operations);
    if (
      !Number.isSafeInteger(options.maximumOutputUnits) ||
      options.maximumOutputUnits <= 0
    ) {
      throw createDomainError({
        code: "invalid_input",
        message: "maximumOutputUnits must be a positive safe integer.",
      });
    }
    this.#maximumOutputUnits = options.maximumOutputUnits;
  }

  public get operations(): readonly SemanticOperationDefinition[] {
    return this.#operations;
  }

  public compile(input: CompilePromptInput): SemanticModelRequest {
    if (!AgentAttemptIdKind.is(input.attemptId)) {
      throw createDomainError({
        code: "invalid_input",
        message: "A valid agent attempt identifier is required.",
      });
    }
    if (!Number.isSafeInteger(input.turnNumber) || input.turnNumber <= 0) {
      throw createDomainError({
        code: "invalid_input",
        message: "A positive turn number is required.",
      });
    }
    if (!Number.isSafeInteger(input.requestNumber) || input.requestNumber <= 0) {
      throw createDomainError({
        code: "invalid_input",
        message: "A positive request number is required.",
      });
    }
    if (!Array.isArray(input.conversation) || input.conversation.length === 0) {
      throw createDomainError({
        code: "invalid_input",
        message: "A semantic conversation is required.",
      });
    }
    const maximumOutputUnits = input.maximumOutputUnits ?? this.#maximumOutputUnits;
    if (
      !Number.isSafeInteger(maximumOutputUnits) ||
      maximumOutputUnits <= 0 ||
      maximumOutputUnits > this.#maximumOutputUnits
    ) {
      throw createDomainError({
        code: "invalid_input",
        message: "The request output limit must be positive and within the compiler bound.",
      });
    }
    return Object.freeze({
      schemaVersion: MODEL_PROVIDER_SCHEMA_VERSION,
      attemptId: input.attemptId,
      model: Object.freeze({ modelId: this.#modelId, settings: Object.freeze({}) }),
      instructions: this.#instructions,
      conversation: Object.freeze([...input.conversation]),
      operations: this.#operations,
      maximumOutputUnits,
      actionMode: this.#operations.length === 0 ? "none" : "structured",
      metadata: Object.freeze({
        sessionId: this.#sessionId,
        turnNumber: input.turnNumber,
        requestNumber: input.requestNumber,
      }) as JsonObject,
    });
  }
}

export function createUserConversationItem(input: {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly text: string;
  readonly capturedAt: string;
}): SemanticConversationItem {
  return textConversationItem("user", input);
}

export function createAssistantConversationItem(input: {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly requestNumber: number;
  readonly text: string;
  readonly capturedAt: string;
}): SemanticConversationItem {
  return textConversationItem("assistant", input);
}

export function createOperationObservationItem(input: {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly requestNumber: number;
  readonly callId: string;
  readonly observation: JsonObject;
  readonly capturedAt: string;
}): SemanticConversationItem {
  const callId = opaqueProviderCallId(input.callId);
  const observation = snapshotBoundaryJsonObject(input.observation);
  const canonical = canonicalBytes(observation);
  const block = parseContentBlock({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    blockId: stableBlockId([
      input.sessionId,
      input.turnNumber,
      input.requestNumber,
      "operation",
      callId,
    ]),
    modality: "json",
    mediaType: "application/json",
    byteLength: canonical.byteLength,
    contentHash: "sha256:" + canonicalSha256Hex(observation),
    classification: "internal",
    provenance: {
      source: null,
      producer: { kind: "capability_worker", id: "robin.tool-dispatcher" },
      capturedAt: captureTimestamp(input.capturedAt),
    },
    retentionClass: "session",
    transformation: null,
    value: observation,
    jsonSchema: null,
  });
  return Object.freeze({
    role: "operation",
    correlationId: callId,
    content: Object.freeze([block]),
  });
}

function textConversationItem(
  role: "user" | "assistant",
  input: {
    readonly sessionId: string;
    readonly turnNumber: number;
    readonly requestNumber?: number;
    readonly text: string;
    readonly capturedAt: string;
  },
): SemanticConversationItem {
  const text = captureText(input.text);
  const block: ContentBlock = parseContentBlock({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    blockId: stableBlockId([
      input.sessionId,
      input.turnNumber,
      input.requestNumber ?? 0,
      role,
    ]),
    modality: "text",
    mediaType: "text/plain",
    byteLength: Buffer.byteLength(text, "utf8"),
    contentHash: "sha256:" + sha256Hex(text),
    classification: "internal",
    provenance: {
      source: null,
      producer: {
        kind: role === "user" ? "user" : "agent_driver",
        id: role === "user" ? "robin.user" : "robin.turn-coordinator",
      },
      capturedAt: captureTimestamp(input.capturedAt),
    },
    retentionClass: "session",
    transformation: null,
    text,
    encoding: "utf-8",
    normalization: "none",
  });
  return Object.freeze({ role, content: Object.freeze([block]) });
}

function captureOperations(
  value: readonly SemanticOperationDefinition[],
): readonly SemanticOperationDefinition[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw createDomainError({
      code: "invalid_input",
      message: "Semantic operations must be a bounded array.",
    });
  }
  const seen = new Set<string>();
  return Object.freeze(
    value.map((operation) => {
      if (typeof operation !== "object" || operation === null) {
        throw createDomainError({
          code: "invalid_input",
          message: "A semantic operation definition is invalid.",
        });
      }
      const captured = Object.freeze({
        capabilityPackId: boundedIdentifier(
          operation.capabilityPackId,
          "capabilityPackId",
        ),
        capabilityPackVersion: positiveInteger(
          operation.capabilityPackVersion,
          "capabilityPackVersion",
        ),
        operationId: boundedIdentifier(operation.operationId, "operationId"),
        operationVersion: positiveInteger(
          operation.operationVersion,
          "operationVersion",
        ),
        description: captureText(operation.description),
        inputSchema: snapshotBoundaryJsonObject(operation.inputSchema),
      });
      const key = JSON.stringify([
        captured.capabilityPackId,
        captured.capabilityPackVersion,
        captured.operationId,
        captured.operationVersion,
      ]);
      if (seen.has(key)) {
        throw createDomainError({
          code: "conflict",
          message: "A semantic operation may be advertised only once.",
        });
      }
      seen.add(key);
      return captured;
    }),
  );
}

function captureInstructions(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw createDomainError({
      code: "invalid_input",
      message: "Prompt instructions must be a non-empty bounded array.",
    });
  }
  const instructions = Object.freeze(value.map(captureText));
  if (
    instructions.reduce(
      (total, instruction) => total + Buffer.byteLength(instruction, "utf8"),
      0,
    ) > 65_536
  ) {
    throw createDomainError({
      code: "invalid_input",
      message: "Prompt instructions exceed their aggregate byte bound.",
    });
  }
  return instructions;
}

function captureText(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\u0000") ||
    containsUnpairedSurrogate(value) ||
    Buffer.byteLength(value, "utf8") > 65_536
  ) {
    throw createDomainError({
      code: "invalid_input",
      message: "Prompt text must be non-empty and bounded.",
    });
  }
  return value;
}

function boundedIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)
  ) {
    throw createDomainError({
      code: "invalid_input",
      message: `${label} must be a bounded identifier.`,
    });
  }
  return value;
}

function opaqueProviderCallId(value: unknown): string {
  if (!isValidProviderCallId(value)) {
    throw createDomainError({
      code: "invalid_input",
      message: "callId must be a bounded opaque provider identifier.",
    });
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createDomainError({
      code: "invalid_input",
      message: `${label} must be a positive safe integer.`,
    });
  }
  return value;
}

function captureTimestamp(value: string): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw createDomainError({
      code: "infrastructure_failed",
      message: "The prompt timestamp source returned an invalid timestamp.",
    });
  }
  return value;
}

function stableBlockId(parts: readonly (string | number)[]): string {
  return "block-" + sha256Hex(JSON.stringify(parts)).slice(0, 32);
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
