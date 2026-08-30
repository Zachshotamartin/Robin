import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256Hex, canonicalize, sha256Hex } from "./canonical-json.js";
import { isDomainError } from "./errors.js";

test("golden canonical form sorts object keys and preserves array order", () => {
  const value = { b: 1, a: { d: null, c: [1, "x", true] } };
  assert.equal(canonicalize(value), '{"a":{"c":[1,"x",true],"d":null},"b":1}');
});

test("insertion order does not change canonical bytes or hash", () => {
  const first = { alpha: 1, beta: { gamma: [1, 2], delta: "d" } };
  const second = { beta: { delta: "d", gamma: [1, 2] }, alpha: 1 };
  assert.equal(canonicalize(first), canonicalize(second));
  assert.equal(canonicalSha256Hex(first), canonicalSha256Hex(second));
});

test("absent and null are distinct", () => {
  assert.notEqual(canonicalize({ a: null }), canonicalize({}));
});

test("negative zero canonicalizes to zero", () => {
  assert.equal(canonicalize(-0), "0");
});

test("scalars and unicode strings canonicalize deterministically", () => {
  assert.equal(canonicalize("héllo\n"), JSON.stringify("héllo\n"));
  assert.equal(canonicalize(true), "true");
  assert.equal(canonicalize(null), "null");
  assert.equal(canonicalize(12.5), "12.5");
});

test("rejected values raise invalid_input domain errors", () => {
  const rejected: readonly unknown[] = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    10n,
    Symbol("s"),
    () => "function",
    new Date(0),
    new Map(),
    new Set(),
  ];

  for (const value of rejected) {
    assert.throws(
      () => canonicalize(value),
      (error: unknown) => isDomainError(error) && error.code === "invalid_input",
      `expected rejection for ${String(value)}`
    );
  }

  assert.throws(() => canonicalize({ a: undefined }), (error: unknown) =>
    isDomainError(error)
  );
  assert.throws(() => canonicalize([1, undefined]), (error: unknown) =>
    isDomainError(error)
  );
});

test("cycles are rejected instead of overflowing", () => {
  const value: Record<string, unknown> = {};
  value["self"] = value;
  assert.throws(() => canonicalize(value), (error: unknown) => isDomainError(error));
});

test("rejection messages name the offending path", () => {
  try {
    canonicalize({ outer: { inner: [1, Number.NaN] } });
    assert.fail("expected rejection");
  } catch (error: unknown) {
    assert.equal(isDomainError(error), true);
    assert.match((error as { message: string }).message, /outer\.inner\[1\]/);
  }
});

test("sha256Hex matches published test vectors", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("canonical hashing is stable across calls", () => {
  const value = { steady: [1, 2, 3], flag: false };
  assert.equal(canonicalSha256Hex(value), canonicalSha256Hex(value));
});
