import {
  AgentAttemptIdKind,
  createDomainError,
  type AgentAttemptId,
} from "@guard/contracts";
import type { ModelProvider } from "@guard/model-provider";
import {
  DirectModelSession,
  PreviewModelProvider,
  type RobinAgentEvent,
  type RobinConversationMessage,
} from "@guard/robin-agent";

export interface RobinApplicationSnapshot {
  readonly sessionId: string;
  readonly persistence: "ephemeral";
  readonly providerId: string;
  readonly modelId: string;
  readonly messages: readonly RobinConversationMessage[];
  readonly activeTurn: boolean;
}

export interface EphemeralRobinApplicationOptions {
  readonly sessionId: string;
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly maximumTurns?: number;
  readonly now?: () => string;
  readonly nextAttemptId?: () => AgentAttemptId;
}

/**
 * Initial R1 preview boundary shared by interactive and print surfaces. It
 * owns session use-case serialization; the complete command, event, and
 * cancellation boundary remains part of the R1 acceptance gate.
 */
export class EphemeralRobinApplication {
  readonly #sessionId: string;
  readonly #providerId: string;
  readonly #modelId: string;
  readonly #session: DirectModelSession;
  #activeTurn = false;

  public constructor(options: EphemeralRobinApplicationOptions) {
    this.#sessionId = options.sessionId;
    this.#providerId = options.provider.descriptor.adapterId;
    this.#modelId = options.modelId;
    this.#session = new DirectModelSession({
      sessionId: options.sessionId,
      provider: options.provider,
      modelId: options.modelId,
      clock: { now: options.now ?? (() => new Date().toISOString()) },
      ids: {
        nextAttemptId:
          options.nextAttemptId ?? (() => AgentAttemptIdKind.generate()),
      },
      ...(options.maximumTurns === undefined
        ? {}
        : { limits: { maximumTurns: options.maximumTurns } }),
    });
  }

  public get snapshot(): RobinApplicationSnapshot {
    return Object.freeze({
      sessionId: this.#sessionId,
      persistence: "ephemeral",
      providerId: this.#providerId,
      modelId: this.#modelId,
      messages: this.#session.history,
      activeTurn: this.#activeTurn,
    });
  }

  public submit(
    prompt: string,
    signal: AbortSignal,
  ): AsyncIterable<RobinAgentEvent> {
    return this.#submit(prompt, signal);
  }

  async *#submit(
    prompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<RobinAgentEvent, void, undefined> {
    if (this.#activeTurn) {
      throw createDomainError({
        code: "conflict",
        message: "The Robin application already has an active turn.",
      });
    }
    this.#activeTurn = true;
    try {
      yield* this.#session.submit(prompt, signal);
    } finally {
      this.#activeTurn = false;
    }
  }
}

export function createPreviewRobinApplication(
  sessionId: string,
  modelId = "synthetic-preview-v1",
  maximumTurns?: number,
): EphemeralRobinApplication {
  return new EphemeralRobinApplication({
    sessionId,
    provider: new PreviewModelProvider(),
    modelId,
    ...(maximumTurns === undefined ? {} : { maximumTurns }),
  });
}
