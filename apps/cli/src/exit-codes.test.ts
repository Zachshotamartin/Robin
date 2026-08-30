import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES, type ErrorCode } from "@guard/contracts";

import { EXIT_CODES, exitCodeForErrorCode } from "./exit-codes.js";

test("every domain error uses one stable CLI exit-code table", () => {
  const expected: Readonly<Record<ErrorCode, number>> = Object.freeze({
    invalid_input: EXIT_CODES.invalidConfiguration,
    policy_denied: EXIT_CODES.policyDenied,
    approval_required: EXIT_CODES.approvalPending,
    approval_invalid: EXIT_CODES.policyDenied,
    budget_exceeded: EXIT_CODES.budgetExceeded,
    action_failed: EXIT_CODES.taskFailed,
    driver_failed: EXIT_CODES.taskFailed,
    attempt_result_uncertain: EXIT_CODES.taskFailed,
    provider_failed: EXIT_CODES.infrastructureFailed,
    provider_result_uncertain: EXIT_CODES.infrastructureFailed,
    sandbox_failed: EXIT_CODES.infrastructureFailed,
    conflict: EXIT_CODES.taskFailed,
    cancelled: EXIT_CODES.cancelled,
    infrastructure_failed: EXIT_CODES.infrastructureFailed,
    invariant_violated: EXIT_CODES.infrastructureFailed,
  });

  assert.deepEqual(new Set(Object.keys(expected)), new Set(ERROR_CODES));
  for (const code of ERROR_CODES) {
    assert.equal(exitCodeForErrorCode(code), expected[code], code);
  }
  assert.equal(exitCodeForErrorCode(null), EXIT_CODES.infrastructureFailed);
  assert.equal(
    exitCodeForErrorCode("unknown_future_code"),
    EXIT_CODES.infrastructureFailed,
  );
});
