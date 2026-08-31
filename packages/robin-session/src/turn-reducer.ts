import { Buffer } from "node:buffer";

import {
  MAXIMUM_APPLICATION_TEXT_UTF8_BYTES,
  RobinSessionError,
  type RobinApprovalBinding,
  type RobinTurnApplicationEvent,
} from "./application-event.js";
import {
  isTerminalTurnStatus,
  type RobinToolApprovalState,
  type RobinToolCallState,
  type RobinTurnState,
} from "./turn-state.js";

/**
 * Pure exhaustive reducer for one turn. It performs no I/O and returns a new
 * deeply immutable state for every accepted event.
 */
export function reduceRobinTurn(
  state: RobinTurnState | undefined,
  event: RobinTurnApplicationEvent,
): RobinTurnState {
  if (state === undefined) return createTurn(event);
  if (event.payload.turnId !== state.turnId || isTerminalTurnStatus(state.status)) {
    return illegalTransition();
  }

  switch (event.type) {
    case "UserMessageQueued":
      return illegalTransition();
    case "UserMessageAccepted":
      if (
        state.status !== "queued" ||
        event.payload.messageId !== state.messageId ||
        event.payload.text !== state.userText
      ) {
        return illegalTransition();
      }
      return freezeTurn({ ...state, status: "accepted" });
    case "TurnStarted":
      if (
        state.status !== "accepted" ||
        event.payload.messageId !== state.messageId
      ) {
        return illegalTransition();
      }
      return freezeTurn({ ...state, status: "active" });
    case "AssistantTextDelta":
      requireActive(state);
      return freezeTurn({
        ...state,
        assistantText: appendAssistantText(
          state.assistantText,
          event.payload.text,
        ),
      });
    case "ToolCallStarted":
      requireActive(state);
      if (
        state.toolCalls.some((call) => call.callId === event.payload.callId) ||
        state.toolCalls.some((call) => call.status === "active")
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        toolCalls: Object.freeze([
          ...state.toolCalls,
          Object.freeze({
            callId: event.payload.callId,
            status: "active" as const,
            toolName: event.payload.toolName,
          }),
        ]),
      });
    case "PermissionDecided":
      requireActive(state);
      return decidePermission(state, event);
    case "ApprovalRequested":
      requireActive(state);
      return requestApproval(state, event);
    case "ApprovalResolved":
      requireActive(state);
      return resolveApproval(state, event);
    case "ApprovalInvalidated":
      requireActive(state);
      return invalidateApproval(state, event);
    case "ToolCallCompleted":
      if (
        state.status !== "active" &&
        state.status !== "cancellation_requested"
      ) {
        return illegalTransition();
      }
      return completeToolCall(state, event);
    case "ToolCallFailed":
      if (
        state.status !== "active" &&
        state.status !== "cancellation_requested"
      ) {
        return illegalTransition();
      }
      return failToolCall(state, event);
    case "UsageReported":
      if (
        state.status !== "active" &&
        state.status !== "cancellation_requested"
      ) {
        return illegalTransition();
      }
      if (
        event.payload.inputTokens < state.usage.inputTokens ||
        event.payload.outputTokens < state.usage.outputTokens
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        usage: Object.freeze({
          inputTokens: event.payload.inputTokens,
          outputTokens: event.payload.outputTokens,
        }),
      });
    case "BudgetWarning":
      requireActive(state);
      return freezeTurn({
        ...state,
        budgetWarnings: Object.freeze([
          ...state.budgetWarnings,
          Object.freeze({
            dimension: event.payload.dimension,
            limit: event.payload.limit,
            used: event.payload.used,
          }),
        ]),
      });
    case "BudgetExhausted":
      requireActive(state);
      if (state.toolCalls.some((call) => call.status === "active")) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        status: "budget_exhausted",
        terminalResult: Object.freeze({
          status: "budget_exhausted",
          dimension: event.payload.dimension,
          limit: event.payload.limit,
          used: event.payload.used,
        }),
      });
    case "TurnCancellationRequested":
      if (
        state.status !== "queued" &&
        state.status !== "accepted" &&
        state.status !== "active"
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...settlePendingApproval(state, "cancelled", event.occurredAt),
        status: "cancellation_requested",
      });
    case "TurnCancelled":
      if (
        state.status !== "cancellation_requested" ||
        state.toolCalls.some((call) => call.status === "active")
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        status: "cancelled",
        terminalResult: Object.freeze({
          status: "cancelled",
          reason: event.payload.reason,
        }),
      });
    case "TurnFailed":
      if (
        state.status !== "active" &&
        state.status !== "cancellation_requested"
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...settlePendingApproval(state, "invalidated", event.occurredAt),
        status: "failed",
        terminalResult: Object.freeze({
          status: "failed",
          code: event.payload.code,
          message: event.payload.message,
        }),
      });
    case "TurnCompleted":
      requireActive(state);
      if (
        state.toolCalls.some((call) => call.status === "active") ||
        event.payload.text !== state.assistantText
      ) {
        return illegalTransition();
      }
      return freezeTurn({
        ...state,
        status: "completed",
        terminalResult: Object.freeze({
          status: "completed",
          text: event.payload.text,
        }),
      });
  }
}

function createTurn(event: RobinTurnApplicationEvent): RobinTurnState {
  if (
    event.type !== "UserMessageQueued" &&
    event.type !== "UserMessageAccepted"
  ) {
    return illegalTransition();
  }
  return freezeTurn({
    assistantText: "",
    budgetWarnings: Object.freeze([]),
    messageId: event.payload.messageId,
    status: event.type === "UserMessageQueued" ? "queued" : "accepted",
    toolCalls: Object.freeze([]),
    turnId: event.payload.turnId,
    usage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
    userText: event.payload.text,
  });
}

function decidePermission(
  state: RobinTurnState,
  event: Extract<RobinTurnApplicationEvent, { readonly type: "PermissionDecided" }>,
): RobinTurnState {
  const activeCalls = state.toolCalls.filter((call) => call.status === "active");
  if (
    activeCalls.length !== 1 ||
    activeCalls[0]?.callId !== event.payload.callId ||
    activeCalls[0].toolName !== event.payload.toolName ||
    activeCalls[0].permission !== undefined ||
    state.toolCalls.some(
      (call) =>
        call.permission?.actionId === event.payload.actionId ||
        call.permission?.actionHash === event.payload.actionHash,
    )
  ) {
    return illegalTransition();
  }
  const calls = state.toolCalls.map((call): RobinToolCallState =>
    call.callId === event.payload.callId
      ? Object.freeze({ ...call, permission: event.payload })
      : call
  );
  return freezeTurn({ ...state, toolCalls: Object.freeze(calls) });
}

function requestApproval(
  state: RobinTurnState,
  event: Extract<RobinTurnApplicationEvent, { readonly type: "ApprovalRequested" }>,
): RobinTurnState {
  const activeCalls = state.toolCalls.filter((call) => call.status === "active");
  const active = activeCalls[0];
  if (
    activeCalls.length !== 1 ||
    active === undefined ||
    active.callId !== event.payload.callId ||
    active.toolName !== event.payload.toolName ||
    active.permission?.effect !== "require_approval" ||
    active.permission.actionId !== event.payload.actionId ||
    active.permission.actionHash !== event.payload.actionHash ||
    active.permission.policySnapshotHash !== event.payload.policySnapshotHash ||
    active.approval !== undefined ||
    state.toolCalls.some(
      (call) =>
        call.approval?.approvalId === event.payload.approvalId ||
        (call.callId !== event.payload.callId &&
          call.approval?.actionId === event.payload.actionId),
    )
  ) {
    return illegalTransition();
  }
  const approval = Object.freeze({
    ...event.payload,
    status: "pending" as const,
  });
  const calls = state.toolCalls.map((call): RobinToolCallState =>
    call.callId === event.payload.callId
      ? Object.freeze({ ...call, approval })
      : call
  );
  return freezeTurn({ ...state, toolCalls: Object.freeze(calls) });
}

function resolveApproval(
  state: RobinTurnState,
  event: Extract<RobinTurnApplicationEvent, { readonly type: "ApprovalResolved" }>,
): RobinTurnState {
  const activeCalls = state.toolCalls.filter((call) => call.status === "active");
  const active = activeCalls[0];
  if (
    activeCalls.length !== 1 ||
    active === undefined ||
    active.callId !== event.payload.callId ||
    active.toolName !== event.payload.toolName ||
    active.approval?.status !== "pending" ||
    !approvalResolutionMatches(active.approval, event.payload)
  ) {
    return illegalTransition();
  }
  const approval = Object.freeze({
    ...active.approval,
    decision: event.payload.decision,
    outcome: event.payload.outcome,
    resolvedAt: event.payload.resolvedAt,
    status: event.payload.outcome,
  }) as RobinToolApprovalState;
  const calls = state.toolCalls.map((call): RobinToolCallState =>
    call.callId === event.payload.callId
      ? Object.freeze({ ...call, approval })
      : call
  );
  return freezeTurn({ ...state, toolCalls: Object.freeze(calls) });
}

function invalidateApproval(
  state: RobinTurnState,
  event: Extract<RobinTurnApplicationEvent, { readonly type: "ApprovalInvalidated" }>,
): RobinTurnState {
  const activeCalls = state.toolCalls.filter((call) => call.status === "active");
  const active = activeCalls[0];
  if (
    activeCalls.length !== 1 ||
    active === undefined ||
    active.callId !== event.payload.callId ||
    active.toolName !== event.payload.toolName ||
    active.approval?.status !== "granted" ||
    Date.parse(event.payload.invalidatedAt) < Date.parse(active.approval.resolvedAt) ||
    !approvalResolutionMatches(active.approval, event.payload)
  ) {
    return illegalTransition();
  }
  const approval = Object.freeze({
    ...active.approval,
    invalidatedAt: event.payload.invalidatedAt,
    invalidationReason: event.payload.reason,
    observedPreconditionHash: event.payload.observedPreconditionHash,
    outcome: "stale" as const,
    status: "stale" as const,
  });
  const calls = state.toolCalls.map((call): RobinToolCallState =>
    call.callId === event.payload.callId
      ? Object.freeze({ ...call, approval })
      : call
  );
  return freezeTurn({ ...state, toolCalls: Object.freeze(calls) });
}

function approvalResolutionMatches(
  requested: RobinApprovalBinding,
  resolved: Extract<
    RobinTurnApplicationEvent,
    { readonly type: "ApprovalResolved" | "ApprovalInvalidated" }
  >["payload"],
): boolean {
  return (
    requested.actionHash === resolved.actionHash &&
    requested.actionId === resolved.actionId &&
    requested.approvalId === resolved.approvalId &&
    requested.callId === resolved.callId &&
    requested.displayedSummaryHash === resolved.displayedSummaryHash &&
    requested.expiresAt === resolved.expiresAt &&
    requested.normalizedRequestHash === resolved.normalizedRequestHash &&
    requested.policySnapshotHash === resolved.policySnapshotHash &&
    requested.preconditionHash === resolved.preconditionHash &&
    requested.requestedAt === resolved.requestedAt &&
    requested.toolName === resolved.toolName &&
    requested.turnId === resolved.turnId
  );
}

function settlePendingApproval(
  state: RobinTurnState,
  status: "cancelled" | "invalidated",
  resolvedAt: string,
): RobinTurnState {
  let settled = 0;
  const calls = state.toolCalls.map((call): RobinToolCallState => {
    if (call.approval?.status !== "pending") return call;
    settled += 1;
    if (settled > 1) return illegalTransition();
    return Object.freeze({
      ...call,
      approval: Object.freeze({ ...call.approval, resolvedAt, status }),
    });
  });
  return settled === 0
    ? state
    : freezeTurn({ ...state, toolCalls: Object.freeze(calls) });
}

function completeToolCall(
  state: RobinTurnState,
  event: Extract<RobinTurnApplicationEvent, { readonly type: "ToolCallCompleted" }>,
): RobinTurnState {
  let found = false;
  const calls = state.toolCalls.map((call): RobinToolCallState => {
    if (call.callId !== event.payload.callId) return call;
    if (
      found ||
      call.status !== "active" ||
      call.toolName !== event.payload.toolName ||
      !toolCompletionIsAuthorized(call, event.payload.observation)
    ) {
      return illegalTransition();
    }
    found = true;
    return Object.freeze({
      ...(call.approval === undefined ? {} : { approval: call.approval }),
      callId: call.callId,
      observation: event.payload.observation,
      permission: call.permission!,
      status: "completed",
      toolName: call.toolName,
    });
  });
  if (!found) return illegalTransition();
  return freezeTurn({ ...state, toolCalls: Object.freeze(calls) });
}

function toolCompletionIsAuthorized(
  call: RobinToolCallState,
  observation: Readonly<Record<string, unknown>>,
): boolean {
  if (call.permission === undefined) return false;
  if (call.permission.effect === "allow") {
    return call.approval === undefined;
  }
  if (call.permission.effect === "deny") {
    return call.approval === undefined && observation["effectOccurred"] === false;
  }
  if (call.approval === undefined || call.approval.status === "pending") {
    return false;
  }
  if (call.approval.status === "granted") return true;
  if (
    call.approval.status === "denied" ||
    call.approval.status === "stale"
  ) {
    return observation["effectOccurred"] === false;
  }
  return false;
}

function failToolCall(
  state: RobinTurnState,
  event: Extract<RobinTurnApplicationEvent, { readonly type: "ToolCallFailed" }>,
): RobinTurnState {
  const activeCalls = state.toolCalls.filter((call) => call.status === "active");
  if (
    activeCalls.length !== 1 ||
    activeCalls[0]?.callId !== event.payload.callId ||
    activeCalls[0].toolName !== event.payload.toolName
  ) {
    return illegalTransition();
  }
  let found = false;
  const calls = state.toolCalls.map((call): RobinToolCallState => {
    if (call.callId !== event.payload.callId) return call;
    if (
      found ||
      call.status !== "active" ||
      call.toolName !== event.payload.toolName
    ) {
      return illegalTransition();
    }
    found = true;
    const approval = call.approval?.status === "pending"
      ? Object.freeze({
          ...call.approval,
          resolvedAt: event.occurredAt,
          status: "invalidated" as const,
        })
      : call.approval;
    return Object.freeze({
      ...(approval === undefined ? {} : { approval }),
      callId: call.callId,
      failure: Object.freeze({
        code: event.payload.code,
        message: event.payload.message,
      }),
      ...(call.permission === undefined ? {} : { permission: call.permission }),
      status: "failed",
      toolName: call.toolName,
    });
  });
  if (!found) return illegalTransition();
  return freezeTurn({ ...state, toolCalls: Object.freeze(calls) });
}

function appendAssistantText(current: string, delta: string): string {
  const next = current + delta;
  if (Buffer.byteLength(next, "utf8") > MAXIMUM_APPLICATION_TEXT_UTF8_BYTES) {
    return illegalTransition();
  }
  return next;
}

function requireActive(state: RobinTurnState): void {
  if (state.status !== "active") illegalTransition();
}

function freezeTurn(state: RobinTurnState): RobinTurnState {
  return Object.freeze(state);
}

function illegalTransition(): never {
  throw new RobinSessionError(
    "illegal_transition",
    "Illegal Robin turn transition.",
  );
}
