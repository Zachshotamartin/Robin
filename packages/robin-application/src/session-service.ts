import { performance } from "node:perf_hooks";

import {
  createDomainError,
  isDomainError,
  type ErrorCode,
} from "@guard/contracts";
import {
  TurnCoordinator,
  type TurnCoordinatorEvent,
  type TurnCoordinatorOptions,
} from "@guard/robin-agent";
import {
  MAXIMUM_QUEUED_ROBIN_MESSAGES,
  type RobinApplicationEvent,
  type RobinApprovalDecision,
  type RobinBudgetDimension,
  type RobinPermissionMode,
} from "@guard/robin-session";
import type { ModelProvider } from "@guard/model-provider";

import {
  ApplicationEventJournal,
  type ApplicationEventIdSource,
  type ApplicationEventJournalLimits,
  type RobinApplicationEventPayloadMap,
} from "./application-event.js";
import {
  R1GatewayToolDispatcher,
  r1ToolDisplayName,
} from "./gateway-tool-dispatcher.js";
import { R1SyntheticCodingProvider } from "./r1-synthetic-provider.js";
import {
  captureApprovalDecision,
  type RobinApplicationToolDispatcherFactory,
  type RobinApplicationToolLifecycle,
  type RobinToolApprovalInvalidation,
  type RobinToolApprovalRequest,
  type RobinToolApprovalResolution,
  type RobinToolPermissionDecision,
} from "./tool-lifecycle.js";

export interface R1RobinApplicationSnapshot {
  readonly sessionId: string;
  readonly persistence: "ephemeral";
  readonly providerId: string;
  readonly modelId: string;
  readonly permissionMode: RobinPermissionMode;
  readonly activeTurn: boolean;
  readonly queueDepth: number;
  readonly turnsStarted: number;
  readonly closed: boolean;
  readonly events: readonly RobinApplicationEvent[];
}

export interface R1RobinApplicationOptions {
  readonly sessionId: string;
  readonly provider?: ModelProvider;
  readonly modelId?: string;
  readonly permissionMode?: RobinPermissionMode;
  readonly maximumTurns?: number;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
  readonly eventIds?: ApplicationEventIdSource;
  readonly journalLimits?: Partial<ApplicationEventJournalLimits>;
  /**
   * Total time granted to an active turn after close requests cancellation.
   * The R1 default is two seconds and the configured value cannot exceed the
   * exported thirty-second hard ceiling.
   */
  readonly shutdownTimeoutMs?: number;
  /** Explicit deadline owner used for deterministic tests or host schedulers. */
  readonly shutdownDeadline?: R1ShutdownDeadlineSource;
  readonly coordinator?: Omit<
    TurnCoordinatorOptions,
    "sessionId" | "provider" | "modelId" | "toolDispatcher" | "clock"
  >;
  /** Creates the trusted dispatcher after the application lifecycle port exists. */
  readonly toolDispatcherFactory?: RobinApplicationToolDispatcherFactory;
}

export interface R1ShutdownDeadlineLease {
  /** Resolves exactly when the configured shutdown wait has elapsed. */
  readonly elapsed: Promise<void>;
  /** Releases timer or scheduler resources when normal cancellation settles first. */
  cancel(): void;
}

export interface R1ShutdownDeadlineSource {
  start(maximumWaitMs: number): R1ShutdownDeadlineLease;
}

export const DEFAULT_R1_SHUTDOWN_TIMEOUT_MS = 2_000;
export const MAXIMUM_R1_SHUTDOWN_TIMEOUT_MS = 30_000;

interface PendingTurn {
  readonly messageId: string;
  readonly prompt: string;
  readonly turnId: string;
  readonly controller: AbortController;
  readonly stream: AsyncEventStream<RobinApplicationEvent>;
  readonly sourceSignal: AbortSignal;
  detachSignal: () => void;
  signalLinked: boolean;
  cancellationRequested: boolean;
  assistantText: string;
  activeTool: { readonly callId: string; readonly toolName: string } | null;
  terminalCommitted: boolean;
}

interface PendingApprovalResponse {
  readonly approvalId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (decision: RobinApprovalDecision) => void;
}

interface RequestUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

type CoordinatorTerminalEvent = Extract<
  TurnCoordinatorEvent,
  {
    readonly type: "turn_completed" | "turn_failed" | "turn_cancelled";
  }
>;

type TerminalDecision =
  | { readonly type: "completed" }
  | {
      readonly type: "failed";
      readonly code: ErrorCode;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "cancelled"; readonly reason: string };

interface BudgetExhaustion {
  readonly dimension: RobinBudgetDimension;
  readonly limit: number;
  readonly used: number;
}

class AuthoritativeJournalFailure {
  public constructor(public readonly failure: unknown) {
    Object.freeze(this);
  }
}

/**
 * R1's serialized in-memory application service. Accepted work is recorded
 * before provider use, one foreground turn runs at a time, and up to eight
 * later prompts wait in a visible FIFO queue.
 */
export class R1RobinApplication {
  readonly #sessionId: string;
  readonly #provider: ModelProvider;
  readonly #modelId: string;
  readonly #maximumTurns: number;
  readonly #journal: ApplicationEventJournal;
  readonly #coordinator: TurnCoordinator;
  readonly #shutdownTimeoutMs: number;
  readonly #shutdownDeadline: R1ShutdownDeadlineSource;
  readonly #queue: PendingTurn[] = [];
  readonly #idleWaiters: Array<() => void> = [];
  #permissionMode: RobinPermissionMode;
  #active: PendingTurn | null = null;
  #turnsStarted = 0;
  #nextTurn = 0;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #fatalFailureSet = false;
  #fatalFailure: unknown;
  #terminalPublicationGuard = false;
  #pendingApproval: PendingApprovalResponse | null = null;

  public constructor(options: R1RobinApplicationOptions) {
    this.#sessionId = options.sessionId;
    this.#provider = options.provider ?? new R1SyntheticCodingProvider();
    this.#modelId = options.modelId ?? "synthetic-r1-v1";
    this.#permissionMode = options.permissionMode ?? "ask";
    this.#maximumTurns = boundedMaximumTurns(options.maximumTurns ?? 16);
    this.#shutdownTimeoutMs = boundedShutdownTimeout(
      options.shutdownTimeoutMs ?? DEFAULT_R1_SHUTDOWN_TIMEOUT_MS,
    );
    this.#shutdownDeadline = captureShutdownDeadline(
      options.shutdownDeadline ?? SYSTEM_SHUTDOWN_DEADLINE,
    );
    const now = options.now ?? (() => new Date().toISOString());
    this.#journal = new ApplicationEventJournal({
      sessionId: this.#sessionId,
      clock: { now },
      ...(options.eventIds === undefined ? {} : { ids: options.eventIds }),
      ...(options.journalLimits === undefined
        ? {}
        : { limits: options.journalLimits }),
    });
    const lifecycle = this.#captureToolLifecycle();
    const toolDispatcher =
      options.toolDispatcherFactory?.(lifecycle) ??
      new R1GatewayToolDispatcher(undefined, lifecycle);
    this.#coordinator = new TurnCoordinator({
      sessionId: this.#sessionId,
      provider: this.#provider,
      modelId: this.#modelId,
      toolDispatcher,
      clock: {
        now: options.monotonicNow ?? (() => Math.floor(performance.now())),
      },
      timestamp: { now },
      limits: {
        maximumModelRequests: 16,
        maximumToolCalls: 64,
        maximumOutputBytes: 262_144,
        maximumProviderEvents: 4_096,
        maximumWallTimeMs: 300_000,
        ...options.coordinator?.limits,
      },
      ...(options.coordinator?.ids === undefined
        ? {}
        : { ids: options.coordinator.ids }),
      ...(options.coordinator?.timestamp === undefined
        ? {}
        : { timestamp: options.coordinator.timestamp }),
      ...(options.coordinator?.instructions === undefined
        ? {}
        : { instructions: options.coordinator.instructions }),
      ...(options.coordinator?.maximumToolArgumentBytes === undefined
        ? {}
        : {
            maximumToolArgumentBytes:
              options.coordinator.maximumToolArgumentBytes,
          }),
      ...(options.coordinator?.maximumToolObservationBytes === undefined
        ? {}
        : {
            maximumToolObservationBytes:
              options.coordinator.maximumToolObservationBytes,
          }),
    });
    this.#journal.append("SessionStarted", {
      permissionMode: this.#permissionMode,
      persistence: "ephemeral",
      providerProfile: "synthetic",
    });
  }

  public get snapshot(): R1RobinApplicationSnapshot {
    return Object.freeze({
      sessionId: this.#sessionId,
      persistence: "ephemeral",
      providerId: this.#provider.descriptor.adapterId,
      modelId: this.#modelId,
      permissionMode: this.#permissionMode,
      activeTurn: this.#active !== null,
      queueDepth: this.#queue.length,
      turnsStarted: this.#turnsStarted,
      closed: this.#closed,
      events: this.#journal.records,
    });
  }

  /** Replays and follows the one canonical session-wide application stream. */
  public events(afterSequence = 0): AsyncIterable<RobinApplicationEvent> {
    return this.#journal.subscribe(afterSequence);
  }

  public submit(
    prompt: string,
    signal: AbortSignal,
  ): AsyncIterable<RobinApplicationEvent> {
    if (this.#closed) conflict("The Robin session is closed.");
    if (this.#turnsStarted + this.#queue.length >= this.#maximumTurns) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "The Robin session turn budget is exhausted.",
      });
    }
    if (this.#active !== null && this.#queue.length >= MAXIMUM_QUEUED_ROBIN_MESSAGES) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "The Robin prompt queue is full.",
      });
    }
    const text = capturePrompt(prompt);
    const nextTurn = this.#nextTurn + 1;
    const pending: PendingTurn = {
      messageId: `message:${nextTurn}`,
      turnId: `turn:${nextTurn}`,
      prompt: text,
      controller: new AbortController(),
      stream: new AsyncEventStream<RobinApplicationEvent>(),
      sourceSignal: signal,
      detachSignal: () => {},
      signalLinked: false,
      cancellationRequested: false,
      assistantText: "",
      activeTool: null,
      terminalCommitted: false,
    };

    if (this.#active === null) {
      if (signal.aborted) this.#acceptCancelledWithoutStarting(pending);
      else this.#activate(pending);
    } else {
      const queued = this.#journal.append("UserMessageQueued", {
        messageId: pending.messageId,
        position: this.#queue.length + 1,
        text: pending.prompt,
        turnId: pending.turnId,
      });
      this.#queue.push(pending);
      pending.stream.push(queued);
      this.#linkPendingSignal(pending);
    }
    this.#nextTurn = nextTurn;
    return pending.stream;
  }

  public cancelActiveTurn(
    reason = "user_interrupt",
  ): boolean {
    if (this.#active === null || this.#terminalPublicationGuard) return false;
    try {
      this.#cancelPending(this.#active, reason);
    } catch (error) {
      this.#failApplication(error);
      throw error;
    }
    return true;
  }

  /**
   * Answers only the currently displayed approval. The gateway still decides
   * whether this response is current and can mint one-use execution authority.
   */
  public resolveApproval(
    approvalId: string,
    decision: RobinApprovalDecision,
  ): boolean {
    const capturedDecision = captureApprovalDecision(decision);
    const pending = this.#pendingApproval;
    if (pending === null || pending.approvalId !== approvalId) return false;
    this.#pendingApproval = null;
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(capturedDecision);
    return true;
  }

  public setPermissionMode(permissionMode: RobinPermissionMode): void {
    if (this.#closed) conflict("The Robin session is closed.");
    if (permissionMode !== "ask" && permissionMode !== "plan") {
      throw createDomainError({
        code: "invalid_input",
        message: "Permission mode must be ask or plan.",
      });
    }
    if (permissionMode === this.#permissionMode) return;
    const record = this.#journal.append("PermissionModeChanged", {
      permissionMode,
    });
    this.#permissionMode = record.payload.permissionMode;
  }

  public close(
    reason: "user" | "eof" | "shutdown" | "error" = "user",
  ): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closePromise = this.#performClose(reason);
    return this.#closePromise;
  }

  async #performClose(
    reason: "user" | "eof" | "shutdown" | "error",
  ): Promise<void> {
    if (this.#fatalFailureSet) throw this.#fatalFailure;
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (this.#active !== null) {
        this.#cancelPending(this.#active, "session_close");
      }
      while (this.#queue.length > 0) {
        const pending = this.#queue[0];
        if (pending === undefined) break;
        this.#recordCancellation(pending, "session_close");
        this.#queue.shift();
        pending.detachSignal();
        pending.stream.end();
      }
    } catch (error) {
      this.#failApplication(error);
      throw error;
    }
    if (this.#active !== null) {
      let deadlineElapsed = false;
      try {
        const lease = captureShutdownLease(
          this.#shutdownDeadline.start(this.#shutdownTimeoutMs),
        );
        try {
          deadlineElapsed = await Promise.race([
            this.#whenIdle().then(() => false),
            lease.elapsed.then(() => true),
          ]);
        } finally {
          lease.cancel();
        }
      } catch (error) {
        this.#failApplication(error);
        throw error;
      }
      if (deadlineElapsed && this.#active !== null) {
        this.#publishTerminal(this.#active, {
          type: "cancelled",
          reason: "The active provider exceeded the R1 shutdown deadline.",
        });
      }
    }
    await this.#whenIdle();
    if (this.#fatalFailureSet) throw this.#fatalFailure;
    try {
      this.#journal.append("SessionClosed", { reason });
    } catch (error) {
      this.#failApplication(error);
      throw error;
    }
  }

  #activate(pending: PendingTurn): void {
    const records = this.#journal.appendBatch([
      {
        type: "UserMessageAccepted",
        payload: {
          messageId: pending.messageId,
          text: pending.prompt,
          turnId: pending.turnId,
        },
      },
      {
        type: "TurnStarted",
        payload: {
          messageId: pending.messageId,
          turnId: pending.turnId,
        },
      },
    ]);
    const accepted = records[0];
    const started = records[1];
    if (
      accepted?.type !== "UserMessageAccepted" ||
      started?.type !== "TurnStarted"
    ) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Foreground admission produced an invalid event batch.",
      });
    }
    const queuedIndex = this.#queue.indexOf(pending);
    if (queuedIndex >= 0) {
      if (queuedIndex !== 0) {
        throw createDomainError({
          code: "invariant_violated",
          message: "Only the first queued turn may be promoted.",
        });
      }
      this.#queue.shift();
    }
    this.#active = pending;
    this.#turnsStarted += 1;
    pending.stream.push(accepted);
    pending.stream.push(started);
    this.#linkPendingSignal(pending);
    void this.#runActive(pending);
  }

  #acceptCancelledWithoutStarting(pending: PendingTurn): void {
    const records = this.#journal.appendBatch([
      {
        type: "UserMessageAccepted",
        payload: {
          messageId: pending.messageId,
          text: pending.prompt,
          turnId: pending.turnId,
        },
      },
      {
        type: "TurnCancellationRequested",
        payload: { reason: "user_interrupt", turnId: pending.turnId },
      },
      {
        type: "TurnCancelled",
        payload: { reason: "user_interrupt", turnId: pending.turnId },
      },
    ]);
    this.#turnsStarted += 1;
    pending.cancellationRequested = true;
    pending.terminalCommitted = true;
    for (const record of records) pending.stream.push(record);
    pending.stream.end();
  }

  #linkPendingSignal(pending: PendingTurn): void {
    if (pending.signalLinked) return;
    pending.signalLinked = true;
    pending.detachSignal = linkSubmissionSignal(pending.sourceSignal, () => {
      try {
        this.#cancelPending(pending, "user_interrupt");
      } catch (error) {
        // AbortSignal dispatch cannot report an application persistence fault
        // to its caller. Fail every observable stream instead.
        this.#failApplication(error);
      }
    });
  }

  async #runActive(pending: PendingTurn): Promise<void> {
    let terminal: CoordinatorTerminalEvent | null = null;
    let terminalDecision: TerminalDecision;
    const usageByRequest = new Map<number, RequestUsage>();
    try {
      for await (const event of this.#coordinator.submit(
        pending.prompt,
        pending.controller.signal,
      )) {
        // A shutdown deadline can settle this turn while a non-cooperative
        // provider still owns a pending `next()`. Its eventual output is stale.
        if (pending.terminalCommitted) return;
        if (isCoordinatorTerminalEvent(event)) {
          if (terminal !== null) {
            throw createDomainError({
              code: "invariant_violated",
              message: "The turn coordinator emitted more than one terminal event.",
            });
          }
          terminal = event;
          continue;
        }
        if (terminal !== null) {
          throw createDomainError({
            code: "invariant_violated",
            message: "The turn coordinator emitted an event after terminal completion.",
          });
        }
        const mapped = this.#mapCoordinatorEvent(pending, event, usageByRequest);
        if (mapped !== null) pending.stream.push(mapped);
      }
      if (pending.terminalCommitted) return;
      terminalDecision = pending.cancellationRequested
        ? {
            type: "cancelled",
            reason: "The turn was cancelled before terminal publication.",
          }
        : terminal === null
          ? {
              type: "failed",
              code: "invariant_violated",
              message: "The turn coordinator ended without a terminal event.",
            }
          : terminalDecisionFromCoordinator(terminal);
    } catch (error) {
      if (pending.terminalCommitted) return;
      if (error instanceof AuthoritativeJournalFailure) {
        this.#failApplication(error.failure);
        return;
      }
      if (
        pending.controller.signal.aborted ||
        (isDomainError(error) && error.code === "cancelled")
      ) {
        terminalDecision = {
          type: "cancelled",
          reason: "The turn was cancelled before coordinator completion.",
        };
      } else {
        terminalDecision = {
          type: "failed",
          code: isDomainError(error) ? error.code : "infrastructure_failed",
          message: isDomainError(error)
            ? error.message
            : "The application failed while coordinating the turn.",
          ...(isDomainError(error) && error.details !== undefined
            ? { details: error.details }
            : {}),
        };
      }
    }
    if (pending.terminalCommitted) return;
    this.#publishTerminal(pending, terminalDecision);
  }

  #mapCoordinatorEvent(
    pending: PendingTurn,
    event: Exclude<TurnCoordinatorEvent, CoordinatorTerminalEvent>,
    usageByRequest: Map<number, RequestUsage>,
  ): RobinApplicationEvent | null {
    switch (event.type) {
      case "turn_started":
        return null;
      case "assistant_text_delta": {
        const record = this.#appendNonterminal("AssistantTextDelta", {
          text: event.delta,
          turnId: pending.turnId,
        });
        pending.assistantText += record.payload.text;
        return record;
      }
      case "tool_started": {
        const toolName = r1ToolDisplayName(event.call);
        if (pending.activeTool !== null) {
          throw createDomainError({
            code: "invariant_violated",
            message: "Robin received overlapping serialized tool calls.",
          });
        }
        const record = this.#appendNonterminal("ToolCallStarted", {
          callId: event.call.callId,
          toolName,
          turnId: pending.turnId,
        });
        pending.activeTool = Object.freeze({
          callId: event.call.callId,
          toolName,
        });
        return record;
      }
      case "tool_completed": {
        const activeTool = pending.activeTool;
        if (activeTool === null || activeTool.callId !== event.callId) {
          throw createDomainError({
            code: "invariant_violated",
            message: "Robin received a completion for a non-active tool call.",
          });
        }
        const record = this.#appendNonterminal("ToolCallCompleted", {
          callId: event.callId,
          observation: event.observation,
          toolName: activeTool.toolName,
          turnId: pending.turnId,
        });
        pending.activeTool = null;
        return record;
      }
      case "usage_reported": {
        const previous = usageByRequest.get(event.requestNumber) ?? {
          inputTokens: 0,
          outputTokens: 0,
        };
        usageByRequest.set(
          event.requestNumber,
          Object.freeze({
            inputTokens: Math.max(
              previous.inputTokens,
              event.dimensions["input_tokens"] ?? previous.inputTokens,
            ),
            outputTokens: Math.max(
              previous.outputTokens,
              event.dimensions["output_tokens"] ?? previous.outputTokens,
            ),
          }),
        );
        const usage = [...usageByRequest.values()].reduce(
          (total, request) => ({
            inputTokens: total.inputTokens + request.inputTokens,
            outputTokens: total.outputTokens + request.outputTokens,
          }),
          { inputTokens: 0, outputTokens: 0 },
        );
        return this.#appendNonterminal("UsageReported", {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          turnId: pending.turnId,
        });
      }
    }
  }

  #appendNonterminal<TType extends
    | "AssistantTextDelta"
    | "ToolCallStarted"
    | "ToolCallCompleted"
    | "UsageReported">(
    type: TType,
    payload: RobinApplicationEventPayloadMap[TType],
  ): Extract<RobinApplicationEvent, { readonly type: TType }> {
    try {
      return this.#journal.append(type, payload);
    } catch (error) {
      throw new AuthoritativeJournalFailure(error);
    }
  }

  #publishTerminal(pending: PendingTurn, decision: TerminalDecision): void {
    if (pending.terminalCommitted) return;
    this.#terminalPublicationGuard = true;
    pending.detachSignal();
    let terminalRecord: RobinApplicationEvent;
    try {
      terminalRecord = this.#appendTerminalDecision(pending, decision);
      pending.terminalCommitted = true;
    } catch (error) {
      this.#failApplication(error);
      queueMicrotask(() => {
        this.#terminalPublicationGuard = false;
      });
      return;
    }

    if (this.#active === pending) this.#active = null;
    pending.stream.push(terminalRecord);
    pending.stream.end();
    if (!this.#closed) {
      const next = this.#queue[0];
      if (next !== undefined) {
        try {
          this.#activate(next);
        } catch (error) {
          // Queued work was already durably admitted. A promotion write fault
          // therefore invalidates the application rather than rejecting a new
          // caller synchronously.
          this.#failApplication(error);
        }
      }
    }
    this.#resolveIdleWaiters();
    queueMicrotask(() => {
      this.#terminalPublicationGuard = false;
    });
  }

  #recordFatalFailure(error: unknown): void {
    if (!this.#fatalFailureSet) {
      this.#fatalFailureSet = true;
      this.#fatalFailure = error;
    }
    this.#closed = true;
    this.#journal.fail(this.#fatalFailure);
  }

  #failApplication(error: unknown): void {
    this.#recordFatalFailure(error);
    const active = this.#active;
    if (active !== null) {
      active.terminalCommitted = true;
      active.controller.abort("application_failure");
      active.detachSignal();
      active.stream.fail(this.#fatalFailure);
      this.#active = null;
    }
    for (const queued of this.#queue.splice(0)) {
      queued.terminalCommitted = true;
      queued.controller.abort("application_failure");
      queued.detachSignal();
      queued.stream.fail(this.#fatalFailure);
    }
    this.#resolveIdleWaiters();
  }

  #captureToolLifecycle(): RobinApplicationToolLifecycle {
    return Object.freeze({
      permissionDecided: (decision: RobinToolPermissionDecision) => {
        this.#appendToolLifecycle("PermissionDecided", decision);
      },
      requestApproval: (
        request: RobinToolApprovalRequest,
        signal: AbortSignal,
      ) => this.#requestToolApproval(request, signal),
      approvalResolved: (resolution: RobinToolApprovalResolution) => {
        this.#appendToolLifecycle("ApprovalResolved", resolution);
      },
      approvalInvalidated: (invalidation: RobinToolApprovalInvalidation) => {
        this.#appendToolLifecycle("ApprovalInvalidated", invalidation);
      },
    });
  }

  #appendToolLifecycle<TType extends
    | "PermissionDecided"
    | "ApprovalResolved"
    | "ApprovalInvalidated">(
    type: TType,
    payload: Omit<RobinApplicationEventPayloadMap[TType], "turnId">,
  ): Extract<RobinApplicationEvent, { readonly type: TType }> {
    const pending = this.#requireActiveLifecycleCall(
      payload.callId,
      payload.toolName,
    );
    try {
      const record = this.#journal.append(type, {
        ...payload,
        turnId: pending.turnId,
      } as RobinApplicationEventPayloadMap[TType]);
      pending.stream.push(record);
      return record;
    } catch (error) {
      this.#failApplication(error);
      throw error;
    }
  }

  #requestToolApproval(
    request: RobinToolApprovalRequest,
    signal: AbortSignal,
  ): Promise<RobinApprovalDecision> {
    const pending = this.#requireActiveLifecycleCall(
      request.callId,
      request.toolName,
    );
    if (this.#pendingApproval !== null) {
      throw createDomainError({
        code: "invariant_violated",
        message: "Robin can wait for only one serialized approval response.",
      });
    }
    if (signal.aborted) return Promise.reject(cancelledApproval());
    try {
      const record = this.#journal.append("ApprovalRequested", {
        ...request,
        turnId: pending.turnId,
      });
      pending.stream.push(record);
    } catch (error) {
      this.#failApplication(error);
      return Promise.reject(error);
    }
    return new Promise<RobinApprovalDecision>((resolve, reject) => {
      const onAbort = (): void => {
        const current = this.#pendingApproval;
        if (current?.approvalId !== request.approvalId) return;
        this.#pendingApproval = null;
        signal.removeEventListener("abort", onAbort);
        reject(cancelledApproval());
      };
      this.#pendingApproval = Object.freeze({
        approvalId: request.approvalId,
        callId: request.callId,
        signal,
        onAbort,
        resolve,
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  #requireActiveLifecycleCall(callId: string, toolName: string): PendingTurn {
    const pending = this.#active;
    const activeTool = pending?.activeTool ?? null;
    if (
      pending === null ||
      pending.terminalCommitted ||
      activeTool === null ||
      activeTool.callId !== callId ||
      activeTool.toolName !== toolName
    ) {
      throw createDomainError({
        code: "invariant_violated",
        message: "A tool lifecycle fact did not match the active serialized call.",
      });
    }
    return pending;
  }

  #appendTerminalDecision(
    pending: PendingTurn,
    decision: TerminalDecision,
  ): RobinApplicationEvent {
    if (decision.type === "completed") {
      if (pending.activeTool !== null) {
        this.#failActiveTool(
          pending,
          "invariant_violated",
          "The coordinator completed while a tool call was still active.",
        );
        return this.#journal.append("TurnFailed", {
          code: "invariant_violated",
          message: "The coordinator completed while a tool call was still active.",
          turnId: pending.turnId,
        });
      }
      return this.#journal.append("TurnCompleted", {
        text: pending.assistantText,
        turnId: pending.turnId,
      });
    }

    if (decision.type === "cancelled") {
      if (!pending.cancellationRequested) {
        this.#requestCancellation(pending, decision.reason);
      }
      this.#failActiveTool(pending, "cancelled", decision.reason);
      return this.#journal.append("TurnCancelled", {
        reason: decision.reason,
        turnId: pending.turnId,
      });
    }

    this.#failActiveTool(pending, decision.code, decision.message);
    const exhausted =
      pending.cancellationRequested || decision.code !== "budget_exceeded"
        ? null
        : budgetExhaustionFromFailure(decision.message, decision.details);
    if (exhausted !== null) {
      return this.#journal.append("BudgetExhausted", {
        ...exhausted,
        turnId: pending.turnId,
      });
    }
    return this.#journal.append("TurnFailed", {
      code: decision.code,
      message: decision.message,
      turnId: pending.turnId,
    });
  }

  #failActiveTool(
    pending: PendingTurn,
    code: ErrorCode,
    message: string,
  ): void {
    const activeTool = pending.activeTool;
    if (activeTool === null) return;
    pending.stream.push(
      this.#journal.append("ToolCallFailed", {
        callId: activeTool.callId,
        code,
        message,
        toolName: activeTool.toolName,
        turnId: pending.turnId,
      }),
    );
    pending.activeTool = null;
  }

  #cancelPending(pending: PendingTurn, reason: string): void {
    if (pending.terminalCommitted) return;
    if (this.#active === pending) {
      this.#requestCancellation(pending, reason);
      pending.controller.abort(reason);
      return;
    }
    const index = this.#queue.indexOf(pending);
    if (index < 0) return;
    this.#recordCancellation(pending, reason);
    this.#queue.splice(index, 1);
    pending.detachSignal();
    pending.stream.end();
  }

  #recordCancellation(pending: PendingTurn, reason: string): void {
    this.#requestCancellation(pending, reason);
    pending.stream.push(
      this.#journal.append("TurnCancelled", {
        reason,
        turnId: pending.turnId,
      }),
    );
    pending.terminalCommitted = true;
  }

  #requestCancellation(pending: PendingTurn, reason: string): void {
    if (pending.cancellationRequested) return;
    pending.cancellationRequested = true;
    pending.stream.push(
      this.#journal.append("TurnCancellationRequested", {
        reason,
        turnId: pending.turnId,
      }),
    );
  }

  #whenIdle(): Promise<void> {
    if (this.#active === null && this.#queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #resolveIdleWaiters(): void {
    if (this.#active !== null || this.#queue.length !== 0) return;
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
}

export function createR1RobinApplication(
  sessionId: string,
  modelId = "synthetic-r1-v1",
  maximumTurns = 16,
  permissionMode: RobinPermissionMode = "ask",
): R1RobinApplication {
  return new R1RobinApplication({
    sessionId,
    modelId,
    maximumTurns,
    permissionMode,
  });
}

class AsyncEventStream<T> implements AsyncIterableIterator<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(reason: unknown): void;
  }> = [];
  #ended = false;
  #failed = false;
  #failure: unknown = undefined;

  public [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  public next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#ended) {
      return this.#failed
        ? Promise.reject(this.#failure)
        : Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) =>
      this.#waiters.push({ resolve, reject }),
    );
  }

  public return(): Promise<IteratorResult<T>> {
    const wasEnded = this.#ended;
    this.#values.splice(0);
    this.#failed = false;
    this.#failure = undefined;
    this.#ended = true;
    if (!wasEnded) {
      for (const waiter of this.#waiters.splice(0)) {
        waiter.resolve({ done: true, value: undefined });
      }
    }
    return Promise.resolve({ done: true, value: undefined });
  }

  public push(value: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter.resolve({ done: false, value });
  }

  public end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  public fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#failed = true;
    this.#failure = error;
    this.#values.splice(0);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

function linkSubmissionSignal(
  signal: AbortSignal,
  cancel: () => void,
): () => void {
  if (signal.aborted) {
    cancel();
    return () => {};
  }
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

function capturePrompt(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 65_536
  ) {
    throw createDomainError({
      code: "invalid_input",
      message: "The submitted prompt is empty or exceeds its byte bound.",
    });
  }
  return value;
}

function cancelledApproval() {
  return createDomainError({
    code: "cancelled",
    message: "The pending Robin approval was cancelled.",
  });
}

function boundedMaximumTurns(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) {
    throw createDomainError({
      code: "invalid_input",
      message: "maximumTurns must be an integer from 1 through 256.",
    });
  }
  return value;
}

function boundedShutdownTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAXIMUM_R1_SHUTDOWN_TIMEOUT_MS
  ) {
    throw createDomainError({
      code: "invalid_input",
      message: `shutdownTimeoutMs must be an integer from 1 through ${MAXIMUM_R1_SHUTDOWN_TIMEOUT_MS}.`,
    });
  }
  return value;
}

function captureShutdownDeadline(
  source: R1ShutdownDeadlineSource,
): R1ShutdownDeadlineSource {
  if (typeof source?.start !== "function") {
    throw createDomainError({
      code: "invalid_input",
      message: "shutdownDeadline must provide a start function.",
    });
  }
  return Object.freeze({ start: source.start.bind(source) });
}

function captureShutdownLease(
  lease: R1ShutdownDeadlineLease,
): R1ShutdownDeadlineLease {
  if (
    typeof lease?.elapsed?.then !== "function" ||
    typeof lease?.cancel !== "function"
  ) {
    throw createDomainError({
      code: "infrastructure_failed",
      message: "The shutdown deadline source returned an invalid lease.",
    });
  }
  return Object.freeze({
    elapsed: Promise.resolve(lease.elapsed),
    cancel: lease.cancel.bind(lease),
  });
}

const SYSTEM_SHUTDOWN_DEADLINE: R1ShutdownDeadlineSource = Object.freeze({
  start(maximumWaitMs: number): R1ShutdownDeadlineLease {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maximumWaitMs);
    });
    return Object.freeze({
      elapsed,
      cancel(): void {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      },
    });
  },
});

function conflict(message: string): never {
  throw createDomainError({ code: "conflict", message });
}

function isCoordinatorTerminalEvent(
  event: TurnCoordinatorEvent,
): event is CoordinatorTerminalEvent {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_cancelled"
  );
}

function terminalDecisionFromCoordinator(
  event: CoordinatorTerminalEvent,
): TerminalDecision {
  switch (event.type) {
    case "turn_completed":
      return Object.freeze({ type: "completed" });
    case "turn_failed":
      return Object.freeze({
        type: "failed",
        code: event.error.code,
        message: event.error.message,
        ...(event.error.details === undefined
          ? {}
          : { details: event.error.details }),
      });
    case "turn_cancelled":
      return Object.freeze({
        type: "cancelled",
        reason: event.error.message,
      });
  }
}

function budgetExhaustionFromFailure(
  message: string,
  details: Readonly<Record<string, unknown>> | undefined,
): BudgetExhaustion | null {
  if (details === undefined) return null;
  const elapsedMs = nonNegativeSafeInteger(details["elapsedMs"]);
  const maximumWallTimeMs = positiveSafeInteger(details["maximumWallTimeMs"]);
  if (elapsedMs !== null && maximumWallTimeMs !== null) {
    return Object.freeze({
      dimension: "wall_time_ms",
      limit: maximumWallTimeMs,
      used: Math.max(elapsedMs, maximumWallTimeMs),
    });
  }

  const current = nonNegativeSafeInteger(details["current"]);
  const increment = positiveSafeInteger(details["increment"]);
  const maximum = positiveSafeInteger(details["maximum"]);
  if (current === null || increment === null || maximum === null) return null;
  const dimension: RobinBudgetDimension | null = message.includes("model request")
    ? "model_requests"
    : message.includes("tool call")
      ? "tool_calls"
      : message.includes("output byte")
        ? "output_bytes"
        : null;
  if (dimension === null) return null;
  return Object.freeze({
    dimension,
    limit: maximum,
    used: Math.max(maximum, current + increment),
  });
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}
