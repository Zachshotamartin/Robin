import assert from "node:assert/strict";
import test from "node:test";

import {
  GitToolError,
  parseStatusPorcelainV2,
} from "./index.js";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_C = "c".repeat(40);

test("parses every porcelain-v2 record family and branch headers", () => {
  const bytes = Buffer.from(
    [
      `# branch.oid ${OID_A}`,
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      `1 M. N... 100644 100644 100644 ${OID_A} ${OID_B} src/space name.ts`,
      `2 R. N... 100644 100644 100644 ${OID_A} ${OID_B} R100 src/new name.ts`,
      "src/old name.ts",
      `u UU N... 100644 100644 100644 100644 ${OID_A} ${OID_B} ${OID_C} conflict.txt`,
      "? line\nbreak.txt",
      "! ignored.cache",
      "",
    ].join("\u0000"),
  );
  const status = parseStatusPorcelainV2(bytes);

  assert.deepEqual(status.branch, {
    oid: OID_A,
    head: "main",
    upstream: "origin/main",
    ahead: 2,
    behind: 3,
    state: "attached",
  });
  assert.equal(status.entries.length, 5);
  assert.equal(status.entries[0]?.kind, "ordinary");
  assert.equal(status.entries[0]?.path.utf8, "src/space name.ts");
  assert.equal(status.entries[1]?.kind, "rename_or_copy");
  assert.equal(status.entries[1]?.path.utf8, "src/new name.ts");
  assert.equal(status.entries[1]?.originalPath?.utf8, "src/old name.ts");
  assert.equal(status.entries[2]?.kind, "unmerged");
  assert.equal(status.entries[3]?.path.utf8, "line\nbreak.txt");
  assert.equal(status.entries[4]?.kind, "ignored");
  assert.ok(Object.isFrozen(status));
  assert.ok(Object.isFrozen(status.entries));
});

test("preserves invalid path bytes through base64 and a safe escaped display", () => {
  const status = parseStatusPorcelainV2(
    Buffer.concat([Buffer.from("? bad-"), Buffer.from([0xff]), Buffer.from("\u0000")]),
  );
  const identity = status.entries[0]?.path;
  assert.equal(identity?.utf8, null);
  assert.equal(identity?.display, "bad-\\xff");
  assert.notEqual(
    identity?.bytesBase64,
    Buffer.from("bad-\ufffd").toString("base64"),
  );
  assert.equal(
    identity?.bytesBase64,
    Buffer.concat([Buffer.from("bad-"), Buffer.from([0xff])]).toString("base64"),
  );
});

test("represents unborn and detached branch state without guessing", () => {
  const unborn = parseStatusPorcelainV2(
    Buffer.from("# branch.oid (initial)\u0000# branch.head main\u0000"),
  );
  assert.equal(unborn.branch.state, "unborn");
  assert.equal(unborn.branch.oid, null);

  const detached = parseStatusPorcelainV2(
    Buffer.from(`# branch.oid ${OID_A}\u0000# branch.head (detached)\u0000`),
  );
  assert.equal(detached.branch.state, "detached");
  assert.equal(detached.branch.head, null);
});

test("rejects malformed, incomplete, duplicate-header, and over-budget streams", () => {
  for (const bytes of [
    Buffer.from("1 M. N... incomplete\u0000"),
    Buffer.from("2 R. N... 100644 100644 100644 " + OID_A + " " + OID_B + " R100 path\u0000"),
    Buffer.from("# branch.head main\u0000# branch.head other\u0000"),
    Buffer.from("x unknown\u0000"),
  ]) {
    assert.throws(
      () => parseStatusPorcelainV2(bytes),
      (error: unknown) =>
        error instanceof GitToolError && error.code === "parse_failed",
    );
  }
  assert.throws(
    () =>
      parseStatusPorcelainV2(Buffer.from("? a\u0000? b\u0000"), {
        maximumBytes: 1024,
        maximumRecords: 1,
        maximumPathBytes: 128,
      }),
    GitToolError,
  );
});
