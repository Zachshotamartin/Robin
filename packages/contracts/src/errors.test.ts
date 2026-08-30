import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RETRY_CLASS,
  ERROR_CODES,
  createDomainError,
  generateErrorId,
  isDomainError,
} from "./errors.js";

const PREFIXED_UUID_V7 =
  /^err_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  assert.match(error.errorId, PREFIXED_UUID_V7);
  assert.equal(Object.isFrozen(error), true);
});

test("error ids use the same sortable UUIDv7 format as all domain ids", () => {
  const generated = Array.from({ length: 100 }, () => generateErrorId());
  for (const errorId of generated) {
    assert.match(errorId, PREFIXED_UUID_V7);
  }
  assert.deepEqual(generated, [...generated].sort());
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

test("details accept the complete JSON value domain", () => {
  const error = createDomainError({
    code: "invalid_input",
    message: "The structured input is invalid.",
    details: {
      nullValue: null,
      booleanValue: true,
      numberValue: 42.5,
      stringValue: "safe",
      arrayValue: [null, false, 0, "nested", { ok: true }],
    },
  });

  assert.doesNotThrow(() => JSON.stringify(error));
  assert.equal(Object.isFrozen(error.details), true);
  const arrayValue = error.details?.["arrayValue"];
  assert.equal(Object.isFrozen(arrayValue), true);
  if (!Array.isArray(arrayValue)) {
    assert.fail("arrayValue must remain an array");
  }
  assert.equal(Object.isFrozen(arrayValue[4]), true);
});

test("details reject non-JSON values instead of silently changing them", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const sparse: unknown[] = [];
  sparse[1] = "present";
  const invalidDetails: readonly Readonly<Record<string, unknown>>[] = [
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: 1n },
    { value: Symbol("not-json") },
    { value: () => "not-json" },
    { value: new Date("2026-01-01T00:00:00.000Z") },
    { value: new Map([["key", "value"]]) },
    { value: sparse },
    cyclic,
  ];

  for (const details of invalidDetails) {
    assert.throws(
      () => createDomainError({
        code: "invalid_input",
        message: "Invalid details must fail closed.",
        details,
      }),
      TypeError
    );
  }
});

test("cyclic details fail deterministically without overflowing the stack", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.throws(
    () => createDomainError({
      code: "invalid_input",
      message: "Cyclic details are invalid.",
      details: cyclic,
    }),
    (error: unknown) => error instanceof TypeError && /cyclic/i.test(error.message)
  );
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

test("isDomainError fails closed for forged or malformed lookalikes", () => {
  const valid = JSON.parse(JSON.stringify(createDomainError({
    code: "invalid_input",
    message: "A valid serialized error.",
    details: { field: "objective" },
  }))) as Readonly<Record<string, unknown>>;

  assert.equal(isDomainError(valid), true);
  const invalid: readonly unknown[] = [
    { ...valid, errorId: "err_00000000-0000-4000-8000-000000000000" },
    { ...valid, errorId: "err_0195f4f8-5b31-7000-7000-000000000000" },
    { ...valid, errorId: String(valid["errorId"]).toUpperCase() },
    { ...valid, message: "   " },
    { ...valid, retry: "sometimes" },
    { ...valid, details: { value: undefined } },
    { ...valid, details: [] },
    { ...valid, causeErrorId: "err_00000000-0000-4000-8000-000000000000" },
    { ...valid, unexpected: true },
  ];
  for (const value of invalid) {
    assert.equal(isDomainError(value), false);
  }
});

test("isDomainError never throws while examining hostile boundary input", () => {
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("hostile proxy");
      },
      ownKeys() {
        throw new Error("hostile proxy");
      },
    }
  );

  assert.doesNotThrow(() => isDomainError(hostile));
  assert.equal(isDomainError(hostile), false);
});
