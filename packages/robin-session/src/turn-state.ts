import type { ErrorCode, JsonObject } from "@guard/contracts";

import type {
  RobinBudgetDimension,
  RobinTurnApplicationEvent,
} from "./application-event.js";

export type RobinTurnStatus =
  | "queued"
  | "accepted"
  | "active"
  | "cancellation_requested"
  | "cancelled"
  | "failed"
  | "budget_exhausted"
  | "completed";

export const ROBIN_TURN_STATUSES: readonly RobinTurnStatus[] = Object.freeze([
  "queued",
  "accepted",
  "active",
  "cancellation_requested",
  "cancelled",
  "failed",
  "budget_exhausted",
  "completed",
]);
export type RobinTerminalTurnStatus = Extract<
  RobinTurnStatus,
  "cancelled" | "failed" | "budget_exhausted" | "completed"
>;

export interface RobinToolCallFailureState {
  readonly code: ErrorCode;
  readonly message: string;
}

export interface RobinToolCallState {
  readonly callId: string;
  readonly failure?: RobinToolCallFailureState;
  readonly observation?: JsonObject;
  readonly status: "active" | "completed" | "failed";
  readonly toolName: string;
}

export interface RobinUsageState {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface RobinBudgetWarningState {
  readonly dimension: RobinBudgetDimension;
  readonly limit: number;
  readonly used: number;
}

export type RobinTurnTerminalResult =
  | {
      readonly status: "cancelled";
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly code: ErrorCode;
      readonly message: string;
    }
  | {
      readonly status: "budget_exhausted";
      readonly dimension: RobinBudgetDimension;
      readonly limit: number;
      readonly used: number;
    }
  | {
      readonly status: "completed";
      readonly text: string;
    };

export interface RobinTurnState {
  readonly assistantText: string;
  readonly budgetWarnings: readonly RobinBudgetWarningState[];
  readonly messageId: string;
  readonly status: RobinTurnStatus;
  readonly terminalResult?: RobinTurnTerminalResult;
  readonly toolCalls: readonly RobinToolCallState[];
  readonly turnId: string;
  readonly usage: RobinUsageState;
  readonly userText: string;
}

export function isTerminalTurnStatus(
  status: RobinTurnStatus,
): status is RobinTerminalTurnStatus {
  return (
    status === "cancelled" ||
    status === "failed" ||
    status === "budget_exhausted" ||
    status === "completed"
  );
}

export function turnIdFromEvent(event: RobinTurnApplicationEvent): string {
  return event.payload.turnId;
}
