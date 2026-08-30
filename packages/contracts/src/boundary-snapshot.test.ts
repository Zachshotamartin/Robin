import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundarySnapshotError,
  DEFAULT_JSON_BOUNDARY_LIMITS,
  snapshotBoundaryJsonObject,
  type JsonBoundaryLimitOptions,
} from "./boundary-snapshot.js";

test("default JSON boundary limits are immutable finite positive ceilings", () => {
  assert.equal(Object.isFrozen(DEFAULT_JSON_BOUNDARY_LIMITS), true);
  for (const value of Object.values(DEFAULT_JSON_BOUNDARY_LIMITS)) {
    assert.equal(Number.isSafeInteger(value), true);
    assert.ok(value > 0);
  }
  assert.throws(() => {
    (DEFAULT_JSON_BOUNDARY_LIMITS as { maximumDepth: number }).maximumDepth = 1;
  }, TypeError);
});

test("snapshot is detached, deeply frozen, and preserves lossless JSON", () => {
  const source = {
    nested: { text: "héllo", nullable: null },
    ordered: [true, 1, "x"],
  };
  const snapshot = snapshotBoundaryJsonObject(source);

  assert.deepEqual(snapshot, source);
  assert.notEqual(snapshot, source);
  assert.notEqual(snapshot["nested"], source.nested);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot["nested"]), true);
  assert.equal(Object.isFrozen(snapshot["ordered"]), true);

  source.nested.text = "changed";
  source.ordered[0] = false;
  assert.equal(
    (snapshot["nested"] as Readonly<Record<string, unknown>>)["text"],
    "héllo"
  );
  assert.equal((snapshot["ordered"] as readonly unknown[])[0], true);
});

test("depth ceiling accepts at-limit input and rejects one level over", () => {
  const at = { level2: { level3: {} } };
  assert.deepEqual(
    snapshotBoundaryJsonObject(at, { maximumDepth: 3 }),
    at
  );
  assert.throws(
    () => snapshotBoundaryJsonObject(at, { maximumDepth: 2 }),
    BoundarySnapshotError
  );
});

test("node ceiling counts scalars and containers exactly", () => {
  const threeNodes = { left: null, right: true };
  assert.deepEqual(
    snapshotBoundaryJsonObject(threeNodes, { maximumNodes: 3 }),
    threeNodes
  );
  assert.throws(
    () => snapshotBoundaryJsonObject(threeNodes, { maximumNodes: 2 }),
    BoundarySnapshotError
  );
});

test("array and object width ceilings reject before copying children", () => {
  const arrayAt = { values: [1, 2] };
  assert.deepEqual(
    snapshotBoundaryJsonObject(arrayAt, { maximumArrayLength: 2 }),
    arrayAt
  );
  assert.throws(
    () => snapshotBoundaryJsonObject(arrayAt, { maximumArrayLength: 1 }),
    BoundarySnapshotError
  );

  const objectAt = { first: 1, second: 2 };
  assert.deepEqual(
    snapshotBoundaryJsonObject(objectAt, { maximumObjectProperties: 2 }),
    objectAt
  );
  assert.throws(
    () =>
      snapshotBoundaryJsonObject(objectAt, { maximumObjectProperties: 1 }),
    BoundarySnapshotError
  );
});

test("string ceiling is exact UTF-8 for keys and values", () => {
  assert.deepEqual(
    snapshotBoundaryJsonObject({ x: "a" }, { maximumStringUtf8Bytes: 2 }),
    { x: "a" }
  );
  assert.deepEqual(
    snapshotBoundaryJsonObject({ x: "é" }, { maximumStringUtf8Bytes: 2 }),
    { x: "é" }
  );
  assert.throws(
    () =>
      snapshotBoundaryJsonObject(
        { x: "€" },
        { maximumStringUtf8Bytes: 2 }
      ),
    BoundarySnapshotError
  );

  const hugeKey = "k".repeat(5);
  assert.throws(
    () =>
      snapshotBoundaryJsonObject(
        { [hugeKey]: true },
        { maximumStringUtf8Bytes: 4 }
      ),
    BoundarySnapshotError
  );
});

test("canonical-byte ceiling accepts just under and at, then rejects over", () => {
  const options = { maximumCanonicalUtf8Bytes: 10 } as const;
  assert.deepEqual(snapshotBoundaryJsonObject({ x: "a" }, options), { x: "a" });
  assert.deepEqual(snapshotBoundaryJsonObject({ x: "ab" }, options), { x: "ab" });
  assert.throws(
    () => snapshotBoundaryJsonObject({ x: "abc" }, options),
    BoundarySnapshotError
  );

  const escaped = { x: "\ud800\né" };
  const exact = Buffer.byteLength(JSON.stringify(escaped), "utf8");
  assert.deepEqual(
    snapshotBoundaryJsonObject(escaped, {
      maximumCanonicalUtf8Bytes: exact,
    }),
    escaped
  );
  assert.throws(
    () =>
      snapshotBoundaryJsonObject(escaped, {
        maximumCanonicalUtf8Bytes: exact - 1,
      }),
    BoundarySnapshotError
  );
});

test("very deep hostile input is rejected without recursive stack overflow", () => {
  let value: Record<string, unknown> = {};
  for (let index = 0; index < 5_000; index += 1) {
    value = { next: value };
  }
  assert.throws(
    () => snapshotBoundaryJsonObject(value),
    (error: unknown) =>
      error instanceof BoundarySnapshotError && !(error instanceof RangeError)
  );
});

test("cycles fail while shared acyclic references are copied by value", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.throws(
    () => snapshotBoundaryJsonObject(cyclic),
    BoundarySnapshotError
  );

  const shared = { stable: true };
  const snapshot = snapshotBoundaryJsonObject({ left: shared, right: shared });
  assert.deepEqual(snapshot, { left: { stable: true }, right: { stable: true } });
  assert.notEqual(snapshot["left"], snapshot["right"]);
});

test("proxies and accessors are rejected without executing attacker code", () => {
  let getterCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-be-read";
    },
  });

  let proxyTrapCalls = 0;
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("secret proxy canary");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("secret proxy canary");
      },
    }
  );

  for (const value of [{ nested: accessor }, { nested: proxy }]) {
    assert.throws(
      () => snapshotBoundaryJsonObject(value),
      (error: unknown) =>
        error instanceof BoundarySnapshotError &&
        !error.message.includes("secret proxy canary")
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyTrapCalls, 0);
});

test("limit options are descriptor-only, exact, and safely validated", () => {
  const invalid: readonly JsonBoundaryLimitOptions[] = [
    { maximumDepth: 0 },
    { maximumNodes: Number.POSITIVE_INFINITY },
    { maximumArrayLength: 1.5 },
    { unknown: 1 } as JsonBoundaryLimitOptions,
  ];
  for (const options of invalid) {
    assert.throws(
      () => snapshotBoundaryJsonObject({}, options),
      BoundarySnapshotError
    );
  }

  let getterCalls = 0;
  const accessorOptions = {} as JsonBoundaryLimitOptions;
  Object.defineProperty(accessorOptions, "maximumDepth", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  assert.throws(
    () => snapshotBoundaryJsonObject({}, accessorOptions),
    BoundarySnapshotError
  );

  let proxyTrapCalls = 0;
  const proxyOptions = new Proxy(
    {},
    {
      ownKeys() {
        proxyTrapCalls += 1;
        return [];
      },
    }
  );
  assert.throws(
    () => snapshotBoundaryJsonObject({}, proxyOptions),
    BoundarySnapshotError
  );
  assert.equal(getterCalls, 0);
  assert.equal(proxyTrapCalls, 0);
});

test("root arrays and non-plain objects remain outside the object boundary", () => {
  assert.throws(
    () => snapshotBoundaryJsonObject([1, 2]),
    BoundarySnapshotError
  );
  assert.throws(
    () => snapshotBoundaryJsonObject(new Date(0)),
    BoundarySnapshotError
  );

  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype["safe"] = true;
  assert.deepEqual(snapshotBoundaryJsonObject(nullPrototype), { safe: true });
});
