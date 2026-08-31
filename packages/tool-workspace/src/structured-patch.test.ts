import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "@guard/contracts";

import {
  applyStructuredPatch,
  parseApplyPatchV1,
  parseCreateFileV1,
} from "./structured-patch.js";
import { isDomainCode } from "./repository-fixture.test-support.js";

const LIMITS = Object.freeze({
  maximumHunks: 16,
  maximumAggregateTextBytes: 64 * 1024,
  maximumResultBytes: 128 * 1024,
});

test("structured patch parser captures exact bounded immutable input", () => {
  const parsed = parseApplyPatchV1(
    {
      path: "src/file.ts",
      expectedSha256: "a".repeat(64),
      expectedSize: 10,
      hunks: [
        {
          oldText: "old",
          newText: "new",
          expectedOccurrences: 1,
          expectedStartLine: 2,
        },
      ],
    },
    LIMITS,
  );
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.hunks), true);
  assert.deepEqual(parsed.hunks[0], {
    oldText: "old",
    newText: "new",
    expectedOccurrences: 1,
    expectedStartLine: 2,
  });

  const created = parseCreateFileV1(
    { path: "src/new.ts", expectedAbsent: true, content: "export {};\n" },
    1_024,
  );
  assert.equal(created.expectedAbsent, true);
});

test("structured patch application supports out-of-order non-overlapping hunks and BOM", () => {
  const raw = Buffer.from("first\nmiddle\nlast\n", "utf8");
  const patch = parseApplyPatchV1(
    {
      path: "file.txt",
      expectedSha256: sha256Hex(raw),
      expectedSize: raw.byteLength,
      hunks: [
        { oldText: "last", newText: "tail", expectedOccurrences: 1, expectedStartLine: 3 },
        { oldText: "first", newText: "head", expectedOccurrences: 1, expectedStartLine: 1 },
      ],
    },
    LIMITS,
  );
  const result = applyStructuredPatch(patch, raw, LIMITS);
  assert.equal(Buffer.from(result.after).toString("utf8"), "head\nmiddle\ntail\n");
  assert.equal(result.hunkCount, 2);
  assert.notEqual(result.beforeSha256, result.afterSha256);

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old\r\n")]);
  const bomPatch = parseApplyPatchV1(
    {
      path: "bom.txt",
      expectedSha256: sha256Hex(bom),
      expectedSize: bom.byteLength,
      hunks: [{ oldText: "old", newText: "new", expectedOccurrences: 1 }],
    },
    LIMITS,
  );
  const bomResult = applyStructuredPatch(bomPatch, bom, LIMITS);
  assert.deepEqual([...bomResult.after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(Buffer.from(bomResult.after.subarray(3)).toString("utf8"), "new\r\n");
});

test("stale, zero/many, overlap, line mismatch, and candidate overflow fail before effect", () => {
  const source = Buffer.from("abcd abc\n", "utf8");
  const base = {
    path: "file.txt",
    expectedSha256: sha256Hex(source),
    expectedSize: source.byteLength,
  };
  for (const hunks of [
    [{ oldText: "missing", newText: "x", expectedOccurrences: 1 }],
    [{ oldText: "abc", newText: "x", expectedOccurrences: 1 }],
    [
      { oldText: "abc", newText: "x", expectedOccurrences: 1 },
      { oldText: "bcd", newText: "y", expectedOccurrences: 1 },
    ],
    [{ oldText: "abcd", newText: "x", expectedOccurrences: 1, expectedStartLine: 2 }],
  ]) {
    const patch = parseApplyPatchV1({ ...base, hunks }, LIMITS);
    assert.throws(
      () => applyStructuredPatch(patch, source, LIMITS),
      (error: unknown) => isDomainCode(error, "conflict"),
    );
  }
  const stale = parseApplyPatchV1(
    {
      ...base,
      expectedSha256: "0".repeat(64),
      hunks: [{ oldText: "abcd", newText: "x", expectedOccurrences: 1 }],
    },
    LIMITS,
  );
  assert.throws(
    () => applyStructuredPatch(stale, source, LIMITS),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
  const overflow = parseApplyPatchV1(
    {
      ...base,
      hunks: [{ oldText: "abcd", newText: "x".repeat(100), expectedOccurrences: 1 }],
    },
    LIMITS,
  );
  assert.throws(
    () => applyStructuredPatch(overflow, source, { ...LIMITS, maximumResultBytes: 16 }),
    (error: unknown) => isDomainCode(error, "budget_exceeded"),
  );
});

test("malformed schemas, unsafe text, excessive counts, and unknown fields are rejected", () => {
  const valid = {
    path: "file.txt",
    expectedSha256: "a".repeat(64),
    expectedSize: 1,
    hunks: [{ oldText: "a", newText: "b", expectedOccurrences: 1 }],
  };
  for (const candidate of [
    { ...valid, unknown: true },
    { ...valid, expectedSha256: "not-a-hash" },
    { ...valid, hunks: [] },
    { ...valid, hunks: [{ oldText: "", newText: "b", expectedOccurrences: 1 }] },
    { ...valid, hunks: [{ oldText: "a", newText: "\u0000", expectedOccurrences: 1 }] },
    { ...valid, hunks: [{ oldText: "a", newText: "b", expectedOccurrences: 2 }] },
  ]) {
    assert.throws(
      () => parseApplyPatchV1(candidate, LIMITS),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
  assert.throws(
    () => parseApplyPatchV1(valid, { ...LIMITS, maximumHunks: 0 }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  assert.throws(
    () => parseCreateFileV1({ path: "x", expectedAbsent: false, content: "x" }, 10),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});
