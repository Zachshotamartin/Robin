import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RETRY_CLASS,
  ERROR_CODES,
  createDomainError,
  isDomainError,
} from "./errors.js";

test("every documented error code has a default retry class", () => {
  assert.equal(ERROR_CODES.length, 15);
  for (const code of ERROR_CODES) {
    const retry = DEFAULT_RETRY_CLASS[code];
    assert.ok(
      retry === "terminal" || retry === "retryable" || retry === "uncertain",
      `${code} has a retry class`
    );
  }
});

test("createDomainError applies defaults and generates an error id", () => {
  const error = createDomainError({
    code: "policy_denied",
    message: "Policy denied the requested operation.",
  });

  assert.equal(error.code, "policy_denied");
  assert.equal(error.retry, "terminal");
  assert.equal(error.message, "Policy denied the requested operation.");
  assert.equal(error.errorId.startsWith("err_"), true);
  assert.equal(Object.isFrozen(error), true);
});

test("uncertain attempt codes default to uncertain retry", () => {
  const error = createDomainError({
    code: "provider_result_uncertain",
    message: "The provider request may have been transmitted.",
  });
  assert.equal(error.retry, "uncertain");
});

test("an explicit retry class overrides the default", () => {
  const error = createDomainError({
    code: "action_failed",
    message: "The capability handler failed.",
    retry: "retryable",
  });
  assert.equal(error.retry, "retryable");
});

test("details are deep-frozen and preserved", () => {
  const error = createDomainError({
    code: "invalid_input",
    message: "The objective payload is invalid.",
    details: { field: "objective", problems: ["missing title"] },
  });

  assert.deepEqual(error.details, { field: "objective", problems: ["missing title"] });
  assert.equal(Object.isFrozen(error.details), true);
  assert.equal(Object.isFrozen(error.details?.["problems"]), true);
});

test("cause error id is preserved for causal chains", () => {
  const cause = createDomainError({
    code: "infrastructure_failed",
    message: "The database connection was lost.",
  });
  const error = createDomainError({
    code: "attempt_result_uncertain",
    message: "The driver attempt result is unknown.",
    causeErrorId: cause.errorId,
  });
  assert.equal(error.causeErrorId, cause.errorId);
});

test("domain errors serialize losslessly through JSON", () => {
  const error = createDomainError({
    code: "budget_exceeded",
    message: "The run exceeded its turn budget.",
    details: { budget: "maxTurns", limit: 20 },
  });
  const revived: unknown = JSON.parse(JSON.stringify(error));
  assert.deepEqual(revived, {
    errorId: error.errorId,
    code: "budget_exceeded",
    message: "The run exceeded its turn budget.",
    retry: "terminal",
    details: { budget: "maxTurns", limit: 20 },
  });
  assert.equal(isDomainError(revived), true);
});

test("unknown codes and empty messages are rejected", () => {
  assert.throws(() =>
    createDomainError({ code: "not_a_code" as never, message: "irrelevant" })
  );
  assert.throws(() => createDomainError({ code: "invalid_input", message: "" }));
  assert.throws(() => createDomainError({ code: "invalid_input", message: "   " }));
});

test("isDomainError distinguishes domain errors from other values", () => {
  assert.equal(isDomainError(new Error("plain")), false);
  assert.equal(isDomainError(null), false);
  assert.equal(isDomainError({ code: "invalid_input" }), false);
  assert.equal(
    isDomainError(
      createDomainError({ code: "cancelled", message: "The run was cancelled." })
    ),
    true
  );
});
