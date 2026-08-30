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

test("shared acyclic references remain valid and serialize by value", () => {
  const shared = { z: 1, a: "same" };
  assert.equal(
    canonicalize({ right: shared, left: shared }),
    '{"left":{"a":"same","z":1},"right":{"a":"same","z":1}}'
  );
});

test("object and array accessors are rejected without being invoked", () => {
  let objectGetterCalls = 0;
  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, "secret", {
    enumerable: true,
    get() {
      objectGetterCalls += 1;
      return "must-not-be-read";
    },
  });

  let arrayGetterCalls = 0;
  const array = ["placeholder"];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get() {
      arrayGetterCalls += 1;
      return "must-not-be-read";
    },
  });

  assert.throws(
    () => canonicalize({ outer: nested }),
    (error: unknown) =>
      isDomainError(error) &&
      error.code === "invalid_input" &&
      /outer\.secret/.test(error.message)
  );
  assert.throws(
    () => canonicalize({ outer: array }),
    (error: unknown) =>
      isDomainError(error) &&
      error.code === "invalid_input" &&
      /outer\[0\]/.test(error.message)
  );
  assert.equal(objectGetterCalls, 0);
  assert.equal(arrayGetterCalls, 0);
});

test("symbol and hidden object keys fail instead of disappearing", () => {
  const symbolKey = Symbol("secret-symbol-description");
  const withSymbol: Record<PropertyKey, unknown> = { visible: true };
  withSymbol[symbolKey] = "must-not-disappear";

  const withHidden = { visible: true };
  Object.defineProperty(withHidden, "hidden", {
    value: "must-not-disappear",
    enumerable: false,
  });

  for (const value of [withSymbol, withHidden]) {
    assert.throws(
      () => canonicalize(value),
      (error: unknown) => isDomainError(error) && error.code === "invalid_input"
    );
  }
});

test("sparse, decorated, symbol-keyed, and hidden-index arrays fail closed", () => {
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = "present";

  const decorated = [1];
  Object.defineProperty(decorated, "extra", {
    value: true,
    enumerable: true,
  });

  const symbolDecorated = [1] as unknown[] & Record<PropertyKey, unknown>;
  symbolDecorated[Symbol("decoration")] = true;

  const hiddenIndex = [1];
  Object.defineProperty(hiddenIndex, "0", {
    value: 1,
    enumerable: false,
  });

  for (const value of [sparse, decorated, symbolDecorated, hiddenIndex]) {
    assert.throws(
      () => canonicalize(value),
      (error: unknown) => isDomainError(error) && error.code === "invalid_input"
    );
  }
});

test("non-plain prototypes fail while null-prototype objects remain valid", () => {
  const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
  inherited["own"] = true;
  assert.throws(
    () => canonicalize(inherited),
    (error: unknown) => isDomainError(error) && error.code === "invalid_input"
  );

  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype["b"] = 2;
  nullPrototype["a"] = 1;
  assert.equal(canonicalize(nullPrototype), '{"a":1,"b":2}');
});

test("hostile proxy traps become safe domain errors at deterministic paths", () => {
  const secret = "raw-super-secret-trap-message";
  const hostileOwnKeys = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error(secret);
      },
    }
  );
  const hostileDescriptor = new Proxy(
    { value: 1 },
    {
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
    }
  );
  const hostilePrototype = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(secret);
      },
    }
  );
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();

  const cases: readonly [unknown, RegExp][] = [
    [{ outer: hostileOwnKeys }, /outer/],
    [{ outer: hostileDescriptor }, /outer/],
    [hostilePrototype, /\$/],
    [revocable.proxy, /\$/],
  ];
  for (const [value, expectedPath] of cases) {
    try {
      canonicalize(value);
      assert.fail("expected hostile input rejection");
    } catch (error: unknown) {
      assert.equal(isDomainError(error), true);
      assert.equal((error as { code: string }).code, "invalid_input");
      assert.match((error as { message: string }).message, expectedPath);
      assert.doesNotMatch((error as { message: string }).message, new RegExp(secret));
    }
  }
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
