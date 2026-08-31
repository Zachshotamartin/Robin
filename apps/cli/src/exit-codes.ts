export const EXIT_CODES = Object.freeze({
  success: 0,
  invalidConfiguration: 2,
  policyDenied: 3,
  approvalPending: 4,
  budgetExceeded: 5,
  taskFailed: 6,
  infrastructureFailed: 7,
  cancelled: 8,
});

/** One canonical mapping shared by compatibility runs and coding sessions. */
export function exitCodeForErrorCode(code: string | null): number {
  switch (code) {
    case "policy_denied":
    case "approval_invalid":
      return EXIT_CODES.policyDenied;
    case "approval_required":
      return EXIT_CODES.approvalPending;
    case "budget_exceeded":
      return EXIT_CODES.budgetExceeded;
    case "cancelled":
      return EXIT_CODES.cancelled;
    case "invalid_input":
      return EXIT_CODES.invalidConfiguration;
    case "infrastructure_failed":
    case "provider_failed":
    case "provider_result_uncertain":
    case "sandbox_failed":
    case "invariant_violated":
      return EXIT_CODES.infrastructureFailed;
    case "action_failed":
    case "driver_failed":
    case "attempt_result_uncertain":
    case "conflict":
      return EXIT_CODES.taskFailed;
    default:
      return EXIT_CODES.infrastructureFailed;
  }
}
