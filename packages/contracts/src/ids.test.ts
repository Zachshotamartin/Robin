import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  AgentAttemptIdKind,
  ApprovalIdKind,
  ArtifactIdKind,
  CommandIdKind,
  DriverProposalIdKind,
  EventIdKind,
  IdempotencyKeyKind,
  PolicyVersionIdKind,
  RunIdKind,
} from "./ids.js";
import { isDomainError } from "./errors.js";

const ALL_KINDS = [
  RunIdKind,
  EventIdKind,
  AgentAttemptIdKind,
  DriverProposalIdKind,
  ActionIdKind,
  ApprovalIdKind,
  CommandIdKind,
  PolicyVersionIdKind,
  ArtifactIdKind,
  IdempotencyKeyKind,
] as const;

test("every kind generates values that parse and round-trip", () => {
  for (const kind of ALL_KINDS) {
    const value = kind.generate();
    assert.equal(kind.is(value), true, `${kind.prefix} accepts its own value`);
    assert.equal(kind.parse(value), value);
    assert.equal(value.startsWith(`${kind.prefix}_`), true);
  }
});

test("prefixes are unique across kinds", () => {
  const prefixes = ALL_KINDS.map((kind) => kind.prefix);
  assert.equal(new Set(prefixes).size, prefixes.length);
});

test("generated values are unique", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 1000; index += 1) {
    seen.add(RunIdKind.generate());
  }
  assert.equal(seen.size, 1000);
});

test("parse rejects malformed input with an invalid_input domain error", () => {
  const malformed = [
    "",
    "run",
    "run_",
    "run_not-a-uuid",
    "run_C0FFEE00-0000-4000-8000-000000000000",
    " run_00000000-0000-4000-8000-000000000000",
    "run_00000000-0000-4000-8000-000000000000 ",
    "run__00000000-0000-4000-8000-000000000000",
  ];

  for (const value of malformed) {
    assert.throws(
      () => RunIdKind.parse(value),
      (error: unknown) => isDomainError(error) && error.code === "invalid_input",
      `expected rejection for ${JSON.stringify(value)}`
    );
    assert.equal(RunIdKind.is(value), false);
  }
});

test("kinds are not interchangeable", () => {
  const actionId = ActionIdKind.generate();
  assert.equal(RunIdKind.is(actionId), false);
  assert.throws(() => RunIdKind.parse(actionId), (error: unknown) => isDomainError(error));
});

test("is() rejects non-string input", () => {
  assert.equal(RunIdKind.is(42), false);
  assert.equal(RunIdKind.is(null), false);
  assert.equal(RunIdKind.is(undefined), false);
  assert.equal(RunIdKind.is({}), false);
});

test("kind objects are frozen", () => {
  for (const kind of ALL_KINDS) {
    assert.equal(Object.isFrozen(kind), true);
  }
});
