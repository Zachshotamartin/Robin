import {
  AgentAttemptIdKind,
  DriverProposalIdKind,
  RunIdKind,
  canonicalSha256Hex,
  canonicalize,
  createDomainError,
  isDomainError,
} from "@guard/contracts";

import {
  AGENT_DRIVER_SCHEMA_VERSION,
  type AgentDriver,
  type AgentDriverDescriptor,
  type AgentDriverEvent,
  type AgentPauseReason,
  type AgentTurnRequest,
} from "./agent-driver.js";
import {
  cloneAndFreeze,
  invalidInput,
  isRecord,
  nonEmptyString,
  nonNegativeInteger,
  positiveInteger,
  validatePlainData,
} from "./immutable.js";

export interface ScriptedAgentTurn {
  /** Exact turn input expected at this zero-based script position. */
  readonly expectedRequest: AgentTurnRequest;
  readonly events: readonly AgentDriverEvent[];
}

export interface ScriptedAgentDriverScript {
  readonly scriptId: string;
  readonly turns: readonly ScriptedAgentTurn[];
}

const SCRIPTED_DESCRIPTOR: AgentDriverDescriptor = Object.freeze({
  driverId: "guard.scripted-agent-driver",
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

const CONTENT_CHANNELS: ReadonlySet<string> = new Set(["analysis", "answer"]);
const PAUSE_REASONS: ReadonlySet<AgentPauseReason> = new Set([
  "awaiting_observation",
  "awaiting_approval",
  "budget_boundary",
  "external",
]);

/**
 * Deterministic executable fixture for kernel and driver conformance tests.
 * There is no background activity: cancellation before reservation leaves the
 * turn untouched, and cancellation after reservation is confirmed before the
 * next event is yielded.
 */
export class ScriptedAgentDriver implements AgentDriver {
  public readonly descriptor = SCRIPTED_DESCRIPTOR;

  readonly #script: ScriptedAgentDriverScript;
  #nextTurn = 0;

  public constructor(script: ScriptedAgentDriverScript) {
    validateScript(script);
    this.#script = cloneAndFreeze(script);
  }

  public get remainingTurns(): number {
    return this.#script.turns.length - this.#nextTurn;
  }

  public advance(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentDriverEvent> {
    return this.#advance(request, signal);
  }

  public assertExhausted(): void {
    if (this.remainingTurns !== 0) {
      throw createDomainError({
        code: "invariant_violated",
        message: `Scripted agent ended with ${this.remainingTurns} unconsumed turn(s).`,
        details: Object.freeze({
          scriptId: this.#script.scriptId,
          nextTurn: this.#nextTurn,
          remainingTurns: this.remainingTurns,
        }),
      });
    }
  }

  async *#advance(
    request: AgentTurnRequest,
    signal: AbortSignal,
  ): AsyncGenerator<AgentDriverEvent, void, undefined> {
    throwIfCancelled(signal);
    validateRequest(request, "request");

    const turn = this.#script.turns[this.#nextTurn];
    if (turn === undefined) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Scripted agent received a request after its final turn.",
        details: Object.freeze({
          scriptId: this.#script.scriptId,
          requestIndex: this.#nextTurn,
        }),
      });
    }

    if (canonicalize(request) !== canonicalize(turn.expectedRequest)) {
      throw createDomainError({
        code: "invariant_violated",
        message: `Scripted agent request diverged at turn ${this.#nextTurn}.`,
        details: Object.freeze({
          scriptId: this.#script.scriptId,
          requestIndex: this.#nextTurn,
          expectedRequestHash: canonicalSha256Hex(turn.expectedRequest),
          actualRequestHash: canonicalSha256Hex(request),
        }),
      });
    }

    this.#nextTurn += 1;
    for (const event of turn.events) {
      await Promise.resolve();
      throwIfCancelled(signal);
      yield event;
    }
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createDomainError({
      code: "cancelled",
      message: "Scripted agent turn was cancelled.",
    });
  }
}

function validateScript(script: ScriptedAgentDriverScript): void {
  validatePlainData(script);
  if (!isRecord(script)) {
    invalidInput("Scripted agent script must be a plain object.");
  }
  nonEmptyString(script.scriptId, "script.scriptId");
  if (!Array.isArray(script.turns) || script.turns.length === 0) {
    invalidInput("Scripted agent script must contain at least one turn.");
  }

  for (let index = 0; index < script.turns.length; index += 1) {
    const turn = script.turns[index];
    if (!isRecord(turn)) {
      invalidInput(`script.turns[${index}] must be a plain object.`);
    }
    validateRequest(
      turn.expectedRequest as AgentTurnRequest,
      `script.turns[${index}].expectedRequest`,
    );
    validateEvents(
      turn.events as readonly AgentDriverEvent[],
      index,
      (turn.expectedRequest as AgentTurnRequest).advertisedOperations,
    );
  }
}

function validateRequest(request: AgentTurnRequest, path: string): void {
  validatePlainData(request);
  if (!isRecord(request)) {
    invalidInput(`${path} must be a plain object.`);
  }
  if (request.schemaVersion !== AGENT_DRIVER_SCHEMA_VERSION) {
    invalidInput(`${path}.schemaVersion must be ${AGENT_DRIVER_SCHEMA_VERSION}.`);
  }
  if (!RunIdKind.is(request.runId)) {
    invalidInput(`${path}.runId must be a valid RunId.`);
  }
  if (!AgentAttemptIdKind.is(request.attemptId)) {
    invalidInput(`${path}.attemptId must be a valid AgentAttemptId.`);
  }
  positiveInteger(request.turnNumber, `${path}.turnNumber`);
  if (!isRecord(request.objective)) {
    invalidInput(`${path}.objective must be an objective envelope.`);
  }
  if (!Array.isArray(request.advertisedOperations)) {
    invalidInput(`${path}.advertisedOperations must be an array.`);
  }
  const operationKeys = new Set<string>();
  for (let index = 0; index < request.advertisedOperations.length; index += 1) {
    const operation = request.advertisedOperations[index];
    if (!isRecord(operation)) {
      invalidInput(`${path}.advertisedOperations[${index}] must be a plain object.`);
    }
    nonEmptyString(
      operation.capabilityPackId,
      `${path}.advertisedOperations[${index}].capabilityPackId`,
    );
    positiveInteger(
      operation.capabilityPackVersion,
      `${path}.advertisedOperations[${index}].capabilityPackVersion`,
    );
    nonEmptyString(
      operation.operationId,
      `${path}.advertisedOperations[${index}].operationId`,
    );
    positiveInteger(
      operation.operationVersion,
      `${path}.advertisedOperations[${index}].operationVersion`,
    );
    nonEmptyString(
      operation.description,
      `${path}.advertisedOperations[${index}].description`,
    );
    if (!isRecord(operation.inputSchema)) {
      invalidInput(`${path}.advertisedOperations[${index}].inputSchema must be JSON.`);
    }
    const key = canonicalize([
      operation.capabilityPackId,
      operation.capabilityPackVersion,
      operation.operationId,
      operation.operationVersion,
    ]);
    if (operationKeys.has(key)) {
      invalidInput(
        `${path}.advertisedOperations contains a duplicate exact operation identity.`,
      );
    }
    operationKeys.add(key);
  }
  if (!Array.isArray(request.context)) {
    invalidInput(`${path}.context must be an array.`);
  }
  if (!Array.isArray(request.observations)) {
    invalidInput(`${path}.observations must be an array.`);
  }
}

function validateEvents(
  events: readonly AgentDriverEvent[],
  turnIndex: number,
  advertisedOperations: AgentTurnRequest["advertisedOperations"],
): void {
  if (!Array.isArray(events) || events.length === 0) {
    invalidInput(`script.turns[${turnIndex}].events must not be empty.`);
  }

  const proposalIds = new Set<string>();
  let terminalCount = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const path = `script.turns[${turnIndex}].events[${index}]`;
    if (!isRecord(event) || typeof event.type !== "string") {
      invalidInput(`${path} must be a discriminated event object.`);
    }

    switch (event.type) {
      case "content_delta":
        validateChannel(event.channel, `${path}.channel`);
        nonEmptyString(event.delta, `${path}.delta`);
        break;
      case "content_completed":
        validateChannel(event.channel, `${path}.channel`);
        if (!isRecord(event.content)) {
          invalidInput(`${path}.content must be a content block.`);
        }
        break;
      case "action_proposed":
        if (!DriverProposalIdKind.is(event.proposalId)) {
          invalidInput(`${path}.proposalId must be a valid DriverProposalId.`);
        }
        if (proposalIds.has(event.proposalId)) {
          invalidInput(`${path}.proposalId duplicates an earlier proposal.`);
        }
        proposalIds.add(event.proposalId);
        nonEmptyString(event.capabilityPackId, `${path}.capabilityPackId`);
        positiveInteger(event.capabilityPackVersion, `${path}.capabilityPackVersion`);
        nonEmptyString(event.operationId, `${path}.operationId`);
        positiveInteger(event.operationVersion, `${path}.operationVersion`);
        if (!isRecord(event.input)) {
          invalidInput(`${path}.input must be a JSON object.`);
        }
        if (
          !advertisedOperations.some(
            (operation) =>
              operation.capabilityPackId === event.capabilityPackId &&
              operation.capabilityPackVersion === event.capabilityPackVersion &&
              operation.operationId === event.operationId &&
              operation.operationVersion === event.operationVersion,
          )
        ) {
          invalidInput(`${path} does not match an exactly advertised operation.`);
        }
        break;
      case "outcome_proposed":
        if (!isRecord(event.outcome)) {
          invalidInput(`${path}.outcome must be an outcome envelope.`);
        }
        break;
      case "usage_reported":
        validateDimensions(event.dimensions, `${path}.dimensions`);
        break;
      case "paused":
        if (typeof event.reason !== "string" || !PAUSE_REASONS.has(event.reason as AgentPauseReason)) {
          invalidInput(`${path}.reason is not supported.`);
        }
        terminalCount += 1;
        validateTerminalPosition(index, events.length, path);
        break;
      case "completed":
        terminalCount += 1;
        validateTerminalPosition(index, events.length, path);
        break;
      case "failed":
        if (!isDomainError(event.error)) {
          invalidInput(`${path}.error must be a DomainError.`);
        }
        terminalCount += 1;
        validateTerminalPosition(index, events.length, path);
        break;
      default:
        invalidInput(`${path}.type is unknown.`);
    }
  }

  if (terminalCount > 1) {
    invalidInput(`script.turns[${turnIndex}].events has multiple terminal events.`);
  }
}

function validateChannel(value: unknown, path: string): void {
  if (typeof value !== "string" || !CONTENT_CHANNELS.has(value)) {
    invalidInput(`${path} is not a supported content channel.`);
  }
}

function validateTerminalPosition(index: number, length: number, path: string): void {
  if (index !== length - 1) {
    invalidInput(`${path} is terminal and must be the final event.`);
  }
}

function validateDimensions(value: unknown, path: string): void {
  if (!isRecord(value)) {
    invalidInput(`${path} must be a JSON object.`);
  }
  for (const [name, count] of Object.entries(value)) {
    nonEmptyString(name, `${path} key`);
    nonNegativeInteger(count, `${path}.${name}`);
  }
}
