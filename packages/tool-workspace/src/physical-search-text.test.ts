import assert from "node:assert/strict";
import test from "node:test";

import { searchPhysicalText } from "./physical-search-text.js";
import {
  createRepositoryFixture,
  isDomainCode,
} from "./repository-fixture.test-support.js";

const SEARCH = Object.freeze({
  maximumQueryBytes: 256,
  maximumFiles: 32,
  maximumFileBytes: 128 * 1024,
  maximumTotalBytes: 512 * 1024,
  maximumMatches: 32,
  maximumSnippetBytes: 128,
  maximumOutputBytes: 64 * 1024,
  maximumDurationMs: 10_000,
  includeGenerated: false,
});

test("literal search is exact, Unicode-aware, stable, and non-regex", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    "b.txt": "a+b and aab\nemoji 😀 a+b\n",
    "a.txt": "a+b first\n",
  });
  const result = await searchPhysicalText(
    fixture.workspace,
    { ...SEARCH, query: "a+b", paths: ["b.txt", "a.txt"] },
    new AbortController().signal,
  );
  assert.equal(result.matchedCount, 3);
  assert.deepEqual(
    result.matches.map((match) => [match["path"], match["line"], match["column"]]),
    [
      ["a.txt", 1, 1],
      ["b.txt", 1, 1],
      ["b.txt", 2, 9],
    ],
  );
  assert.equal(result.truncated, false);
});

test("search skips restricted, binary, generated, and oversized files with reasons", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    ".env": "needle=secret",
    "binary.bin": Buffer.from([0x6e, 0x00, 0x65]),
    "node_modules/pkg.js": "needle",
    "large.txt": "needle".repeat(10_000),
    "safe.txt": "needle",
  });
  const result = await searchPhysicalText(
    fixture.workspace,
    {
      ...SEARCH,
      query: "needle",
      paths: [".env", "binary.bin", "node_modules/pkg.js", "large.txt", "safe.txt"],
      maximumFileBytes: 1_024,
    },
    new AbortController().signal,
  );
  assert.deepEqual(result.matches.map((match) => match["path"]), ["safe.txt"]);
  const reasons = new Set(result.skipped.map((entry) => entry["reason"]));
  assert.equal(reasons.has("restricted_path"), true);
  assert.equal(reasons.has("binary"), true);
  assert.equal(reasons.has("generated_file"), true);
  assert.equal(reasons.has("oversized"), true);
});

test("match, output, time, argument, and cancellation limits fail or truncate safely", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    "many.txt": "x x x x x x x x\n",
    "other.txt": "x\n",
  });
  const limited = await searchPhysicalText(
    fixture.workspace,
    {
      ...SEARCH,
      query: "x",
      paths: ["many.txt"],
      maximumMatches: 2,
    },
    new AbortController().signal,
  );
  assert.equal(limited.matches.length, 2);
  assert.equal(limited.matchedCount, 8);
  assert.equal(limited.truncated, true);

  let tick = 0;
  const timed = await searchPhysicalText(
    fixture.workspace,
    {
      ...SEARCH,
      query: "x",
      paths: ["many.txt", "other.txt"],
      maximumDurationMs: 1,
    },
    new AbortController().signal,
    { monotonicNow: () => tick++ },
  );
  assert.equal(timed.truncated, true);
  assert.equal(timed.skipped.some((entry) => entry["reason"] === "time_budget"), true);

  await assert.rejects(
    searchPhysicalText(
      fixture.workspace,
      { ...SEARCH, query: "", paths: ["many.txt"] },
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  await assert.rejects(
    searchPhysicalText(
      fixture.workspace,
      { ...SEARCH, query: "x", paths: ["many.txt", "many.txt"] },
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    searchPhysicalText(
      fixture.workspace,
      { ...SEARCH, query: "x", paths: ["many.txt"] },
      cancelled.signal,
    ),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
});
