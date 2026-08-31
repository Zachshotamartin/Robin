import assert from "node:assert/strict";
import test from "node:test";

import { attributeGitStatus, type GitStatusSnapshot } from "./index.js";

test("separates pre-existing, exact Robin postimages, external divergence, and unknown facts", () => {
  const initial = snapshot([
    ["preexisting.txt", "M."],
    ["edited-dirty.txt", ".M"],
  ]);
  const current = snapshot([
    ["preexisting.txt", "M."],
    ["edited-dirty.txt", ".M"],
    ["created.txt", "??"],
    ["diverged.txt", ".M"],
    ["external.txt", "??"],
    ["uncertain.txt", ".M"],
  ]);
  const attributed = attributeGitStatus({
    initial,
    current,
    currentFileHashes: {
      "preexisting.txt": "1".repeat(64),
      "edited-dirty.txt": "3".repeat(64),
      "created.txt": "4".repeat(64),
      "diverged.txt": "9".repeat(64),
      "external.txt": "7".repeat(64),
    },
    editLedger: [
      {
        actionId: "action-dirty",
        path: "edited-dirty.txt",
        beforeSha256: "2".repeat(64),
        afterSha256: "3".repeat(64),
        outcome: "confirmed",
      },
      {
        actionId: "action-create",
        path: "created.txt",
        beforeSha256: null,
        afterSha256: "4".repeat(64),
        outcome: "confirmed",
      },
      {
        actionId: "action-diverged",
        path: "diverged.txt",
        beforeSha256: "5".repeat(64),
        afterSha256: "6".repeat(64),
        outcome: "confirmed",
      },
      {
        actionId: "action-uncertain",
        path: "uncertain.txt",
        beforeSha256: "8".repeat(64),
        afterSha256: "a".repeat(64),
        outcome: "uncertain",
      },
    ],
  });

  assert.deepEqual(
    Object.fromEntries(
      attributed.map((entry) => [entry.path, [entry.attribution, entry.initialState]]),
    ),
    {
      "created.txt": ["robin_owned", "clean"],
      "diverged.txt": ["mixed_or_external", "clean"],
      "edited-dirty.txt": ["robin_owned", "pre_existing"],
      "external.txt": ["mixed_or_external", "clean"],
      "preexisting.txt": ["pre_existing", "pre_existing"],
      "uncertain.txt": ["unknown", "clean"],
    },
  );
  assert.equal(
    attributed.find((entry) => entry.path === "edited-dirty.txt")?.initialState,
    "pre_existing",
  );
});

test("a broken Robin hash chain cannot claim ownership", () => {
  const attributed = attributeGitStatus({
    initial: snapshot([]),
    current: snapshot([["file.txt", ".M"]]),
    currentFileHashes: { "file.txt": "4".repeat(64) },
    editLedger: [
      {
        actionId: "one",
        path: "file.txt",
        beforeSha256: "1".repeat(64),
        afterSha256: "2".repeat(64),
        outcome: "confirmed",
      },
      {
        actionId: "two",
        path: "file.txt",
        beforeSha256: "3".repeat(64),
        afterSha256: "4".repeat(64),
        outcome: "confirmed",
      },
    ],
  });
  assert.equal(attributed[0]?.attribution, "unknown");
});

function snapshot(entries: readonly (readonly [string, string])[]): GitStatusSnapshot {
  return {
    capturedAt: "2026-08-30T00:00:00.000Z",
    statusSha256: "f".repeat(64),
    submoduleWorktreeEvidence: "not_collected_for_execution_safety",
    branch: {
      oid: "a".repeat(40),
      head: "main",
      upstream: null,
      ahead: null,
      behind: null,
      state: "attached",
    },
    entries: entries.map(([path, xy]) => ({
      kind: xy === "??" ? "untracked" : "ordinary",
      xy,
      submodule: null,
      path: {
        bytesBase64: Buffer.from(path).toString("base64"),
        utf8: path,
        display: path,
        safeForWorkspaceTools: true,
      },
      originalPath: null,
      modes: null,
      objectIds: null,
      renameOrCopyScore: null,
    })),
  };
}
