import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalBytes,
  canonicalSha256Hex,
  canonicalize,
  sha256Hex,
} from "./canonical-json.js";
import { createDomainError, isDomainError } from "./errors.js";

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
      /property:0.*property:0/.test(error.message)
  );
  assert.throws(
    () => canonicalize({ outer: array }),
    (error: unknown) =>
      isDomainError(error) &&
      error.code === "invalid_input" &&
      /property:0.*\[0\]/.test(error.message)
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
    [{ outer: hostileOwnKeys }, /property:0/],
    [{ outer: hostileDescriptor }, /property:0/],
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

test("hostile proxy traps cannot smuggle a forged domain error across the boundary", () => {
  const secret = "canary-forged-domain-error-secret";
  const forged = createDomainError({
    code: "invariant_violated",
    message: secret,
    details: { secret },
  });
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw forged;
      },
    }
  );

  try {
    canonicalize(hostile);
    assert.fail("expected hostile input rejection");
  } catch (error: unknown) {
    assert.equal(isDomainError(error), true);
    assert.equal((error as { code: string }).code, "invalid_input");
    assert.notEqual((error as { errorId: string }).errorId, forged.errorId);
    assert.doesNotMatch((error as { message: string }).message, new RegExp(secret));
    assert.equal(JSON.stringify(error).includes(secret), false);
  }
});

test("rejection messages name the structural path without exposing keys", () => {
  try {
    canonicalize({ outer: { inner: [1, Number.NaN] } });
    assert.fail("expected rejection");
  } catch (error: unknown) {
    assert.equal(isDomainError(error), true);
    assert.match(
      (error as { message: string }).message,
      /property:0.*property:0.*\[1\]/
    );
    assert.doesNotMatch((error as { message: string }).message, /outer|inner/);
  }
});

test("attacker-controlled property names never leak through failures", () => {
  const secretKey = "canary-secret-property-name-7f4929";
  try {
    canonicalize({ [secretKey]: Number.NaN });
    assert.fail("expected rejection");
  } catch (error: unknown) {
    assert.equal(isDomainError(error), true);
    assert.match((error as { message: string }).message, /property:0/);
    assert.doesNotMatch(
      JSON.stringify(error),
      new RegExp(secretKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
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

test("canonical operations enforce exact depth and node ceilings", () => {
  const depthThree = { second: { third: {} } };
  assert.equal(
    canonicalize(depthThree, { maximumDepth: 3 }),
    '{"second":{"third":{}}}'
  );
  assert.throws(
    () => canonicalize(depthThree, { maximumDepth: 2 }),
    (error: unknown) =>
      isDomainError(error) && /maximum container depth/.test(error.message)
  );

  const threeNodes = { first: null, second: true };
  assert.equal(
    canonicalize(threeNodes, { maximumNodes: 3 }),
    '{"first":null,"second":true}'
  );
  assert.throws(
    () => canonicalize(threeNodes, { maximumNodes: 2 }),
    (error: unknown) =>
      isDomainError(error) && /maximum JSON node count/.test(error.message)
  );
});

test("canonical operations enforce array and object width before traversal", () => {
  assert.equal(
    canonicalize([1, 2], { maximumArrayLength: 2 }),
    "[1,2]"
  );
  assert.throws(
    () => canonicalize([1, 2], { maximumArrayLength: 1 }),
    (error: unknown) =>
      isDomainError(error) && /maximum array length/.test(error.message)
  );

  assert.equal(
    canonicalize({ a: 1, b: 2 }, { maximumObjectProperties: 2 }),
    '{"a":1,"b":2}'
  );
  assert.throws(
    () =>
      canonicalize({ a: 1, b: 2 }, { maximumObjectProperties: 1 }),
    (error: unknown) =>
      isDomainError(error) && /maximum object property count/.test(error.message)
  );
});

test("canonical string ceiling measures UTF-8 values and property names", () => {
  assert.equal(
    canonicalize("a", { maximumStringUtf8Bytes: 2 }),
    '"a"'
  );
  assert.equal(
    canonicalize("é", { maximumStringUtf8Bytes: 2 }),
    '"é"'
  );
  assert.throws(
    () => canonicalize("€", { maximumStringUtf8Bytes: 2 }),
    (error: unknown) =>
      isDomainError(error) && /maximum string UTF-8/.test(error.message)
  );
  assert.throws(
    () =>
      canonicalize(
        { ["k".repeat(5)]: true },
        { maximumStringUtf8Bytes: 4 }
      ),
    (error: unknown) =>
      isDomainError(error) && /maximum string UTF-8/.test(error.message)
  );
});

test("canonical byte ceiling accepts just under and at, then rejects over", () => {
  const options = { maximumCanonicalUtf8Bytes: 10 } as const;
  assert.equal(canonicalize({ x: "a" }, options), '{"x":"a"}');
  assert.equal(canonicalize({ x: "ab" }, options), '{"x":"ab"}');
  assert.throws(
    () => canonicalize({ x: "abc" }, options),
    (error: unknown) =>
      isDomainError(error) && /maximum canonical UTF-8/.test(error.message)
  );

  const escaped = { x: "\ud800\né" };
  const exact = Buffer.byteLength(JSON.stringify(escaped), "utf8");
  assert.equal(
    canonicalize(escaped, { maximumCanonicalUtf8Bytes: exact }),
    JSON.stringify(escaped)
  );
  assert.throws(
    () =>
      canonicalize(escaped, { maximumCanonicalUtf8Bytes: exact - 1 }),
    (error: unknown) => isDomainError(error)
  );
});

test("bytes and canonical hash share one bounded serialization contract", () => {
  const value = { stable: ["é", 1, false] };
  const exact = Buffer.byteLength(JSON.stringify(value), "utf8");
  const options = { maximumCanonicalUtf8Bytes: exact } as const;
  assert.deepEqual(canonicalBytes(value, options), Buffer.from(JSON.stringify(value)));
  assert.equal(
    canonicalSha256Hex(value, options),
    sha256Hex(Buffer.from(JSON.stringify(value)))
  );
  assert.throws(
    () => canonicalBytes(value, { maximumCanonicalUtf8Bytes: exact - 1 }),
    (error: unknown) => isDomainError(error)
  );
  assert.throws(
    () => canonicalSha256Hex(value, { maximumCanonicalUtf8Bytes: exact - 1 }),
    (error: unknown) => isDomainError(error)
  );
});

test("very deep canonical input rejects without recursive stack overflow", () => {
  let value: Record<string, unknown> = {};
  for (let index = 0; index < 5_000; index += 1) {
    value = { next: value };
  }
  assert.throws(
    () => canonicalize(value),
    (error: unknown) => isDomainError(error) && !(error instanceof RangeError)
  );
});

test("proxy and option traps are never invoked by bounded canonicalization", () => {
  let valueTrapCalls = 0;
  const value = new Proxy(
    {},
    {
      getPrototypeOf() {
        valueTrapCalls += 1;
        throw new Error("value trap secret");
      },
      ownKeys() {
        valueTrapCalls += 1;
        throw new Error("value trap secret");
      },
    }
  );
  assert.throws(
    () => canonicalize({ nested: value }),
    (error: unknown) =>
      isDomainError(error) && !error.message.includes("value trap secret")
  );

  let optionGetterCalls = 0;
  const options = {};
  Object.defineProperty(options, "maximumDepth", {
    enumerable: true,
    get() {
      optionGetterCalls += 1;
      return 1;
    },
  });
  assert.throws(
    () => canonicalize({}, options),
    (error: unknown) => isDomainError(error)
  );

  let optionTrapCalls = 0;
  const proxyOptions = new Proxy(
    {},
    {
      ownKeys() {
        optionTrapCalls += 1;
        throw new Error("option trap secret");
      },
    }
  );
  assert.throws(
    () => canonicalize({}, proxyOptions),
    (error: unknown) =>
      isDomainError(error) && !error.message.includes("option trap secret")
  );
  assert.equal(valueTrapCalls, 0);
  assert.equal(optionGetterCalls, 0);
  assert.equal(optionTrapCalls, 0);
});

test("invalid resource options fail as sanitized invalid_input errors", () => {
  const options = [
    { maximumDepth: 0 },
    { maximumNodes: -1 },
    { maximumArrayLength: 1.5 },
    { maximumObjectProperties: Number.POSITIVE_INFINITY },
    { maximumStringUtf8Bytes: Number.NaN },
    { maximumCanonicalUtf8Bytes: 0 },
    { unexpected: 1 },
  ];
  for (const option of options) {
    assert.throws(
      () => canonicalize({}, option),
      (error: unknown) =>
        isDomainError(error) &&
        error.code === "invalid_input" &&
        !JSON.stringify(error).includes("unexpected")
    );
  }
});
