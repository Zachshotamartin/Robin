import {
  RobinSessionError,
  type RobinBudgetDimension,
} from "./application-event.js";

export interface RobinBudgetReading {
  readonly dimension: RobinBudgetDimension;
  readonly limit: number;
  readonly used: number;
  readonly warningThreshold: number;
}

export type RobinBudgetDecision =
  | {
      readonly kind: "within";
      readonly reading: RobinBudgetReading;
    }
  | {
      readonly kind: "warning";
      readonly reading: RobinBudgetReading;
    }
  | {
      readonly kind: "exhausted";
      readonly reading: RobinBudgetReading;
    };

/** Pure local budget classification performed before the next bounded effect. */
export function classifyRobinBudget(
  reading: RobinBudgetReading,
): RobinBudgetDecision {
  if (
    !Number.isSafeInteger(reading.used) ||
    reading.used < 0 ||
    !Number.isSafeInteger(reading.limit) ||
    reading.limit <= 0 ||
    !Number.isSafeInteger(reading.warningThreshold) ||
    reading.warningThreshold < 0 ||
    reading.warningThreshold >= reading.limit
  ) {
    throw new RobinSessionError(
      "budget_invalid",
      "Invalid Robin budget reading.",
    );
  }
  const snapshot = Object.freeze({ ...reading });
  if (reading.used >= reading.limit) {
    return Object.freeze({ kind: "exhausted", reading: snapshot });
  }
  if (reading.used >= reading.warningThreshold) {
    return Object.freeze({ kind: "warning", reading: snapshot });
  }
  return Object.freeze({ kind: "within", reading: snapshot });
}
