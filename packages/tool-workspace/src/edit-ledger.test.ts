import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { sha256Hex } from "@guard/contracts";

import { createDiffArtifact } from "./diff-artifact.js";
import { normalizeWorkspaceRelativePath } from "./physical-path.js";
import { WorkspaceEditService } from "./patch-application.js";
import { parseApplyPatchV1, parseCreateFileV1 } from "./structured-patch.js";
import {
  createRepositoryFixture,
  isDomainCode,
} from "./repository-fixture.test-support.js";

const LIMITS = Object.freeze({
  maximumHunks: 16,
  maximumAggregateTextBytes: 64 * 1024,
  maximumResultBytes: 128 * 1024,
  maximumFileBytes: 128 * 1024,
  maximumFullDiffBytes: 128 * 1024,
  maximumPreviewBytes: 16 * 1024,
});

const AUTHORITY = Object.freeze({
  actionId: "action:1",
  approvalId: "approval:1",
  approvedActionHash: "a".repeat(64),
  occurredAt: "2026-08-30T12:00:00.000Z",
});

test("workspace edit service applies exact patches and records an immutable ledger chain", async (t) => {
  const fixture = await createRepositoryFixture(t, { "src/file.ts": "const value = 1;\n" });
  const source = Buffer.from("const value = 1;\n");
  const patch = parseApplyPatchV1(
    {
      path: "src/file.ts",
      expectedSha256: sha256Hex(source),
      expectedSize: source.byteLength,
      hunks: [
        {
          oldText: "value = 1",
          newText: "value = 2",
          expectedOccurrences: 1,
          expectedStartLine: 1,
        },
      ],
    },
    LIMITS,
  );
  const service = new WorkspaceEditService(fixture.workspace, LIMITS);
  const result = await service.applyPatch(patch, AUTHORITY, "clean_tracked");
  assert.equal(await readFile(path.join(fixture.root, "src/file.ts"), "utf8"), "const value = 2;\n");
  assert.equal(result.operation, "apply_patch");
  assert.equal(result.ledgerSequence, 1);
  assert.equal(service.ledger.snapshot.entries.length, 1);
  assert.equal(service.ledger.attribution(patch.path, result.afterSha256), "robin_owned");

  await writeFile(path.join(fixture.root, "src/file.ts"), "external\n", "utf8");
  assert.equal(
    service.ledger.attribution(patch.path, sha256Hex("external\n")),
    "mixed_or_external",
  );
});

test("pre-existing dirty content is never attributed as Robin-created", async (t) => {
  const fixture = await createRepositoryFixture(t, { "dirty.txt": "user\n" });
  const source = Buffer.from("user\n");
  const patch = parseApplyPatchV1(
    {
      path: "dirty.txt",
      expectedSha256: sha256Hex(source),
      expectedSize: source.byteLength,
      hunks: [{ oldText: "user", newText: "user + robin", expectedOccurrences: 1 }],
    },
    LIMITS,
  );
  const service = new WorkspaceEditService(fixture.workspace, LIMITS);
  const result = await service.applyPatch(patch, AUTHORITY, "unstaged");
  assert.equal(
    service.ledger.attribution(patch.path, result.afterSha256),
    "mixed_or_external",
  );
});

test("create_file is exclusive, bounded, and attributed only from proven absence", async (t) => {
  const fixture = await createRepositoryFixture(t);
  const service = new WorkspaceEditService(fixture.workspace, LIMITS);
  const request = parseCreateFileV1(
    { path: "new.txt", expectedAbsent: true, content: "new\n" },
    LIMITS.maximumFileBytes,
  );
  const result = await service.createFile(request, AUTHORITY);
  assert.equal(await readFile(path.join(fixture.root, "new.txt"), "utf8"), "new\n");
  assert.equal(service.ledger.attribution(request.path, result.afterSha256), "robin_owned");
  await assert.rejects(
    service.createFile(request, { ...AUTHORITY, actionId: "action:2" }),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
});

test("edit service denies secret, generated, multi-linked, and invalid authority inputs", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    ".env": "SAFE_NAME=value\n",
    "node_modules/file.js": "old\n",
    "plain.txt": "old\n",
  });
  const service = new WorkspaceEditService(fixture.workspace, LIMITS);
  for (const file of [".env", "node_modules/file.js"]) {
    const source = Buffer.from(file === ".env" ? "SAFE_NAME=value\n" : "old\n");
    const patch = parseApplyPatchV1(
      {
        path: file,
        expectedSha256: sha256Hex(source),
        expectedSize: source.byteLength,
        hunks: [{ oldText: "value", newText: "changed", expectedOccurrences: 1 }],
      },
      LIMITS,
    );
    await assert.rejects(
      service.applyPatch(patch, AUTHORITY, "clean_tracked"),
      (error: unknown) => isDomainCode(error, "policy_denied"),
    );
  }
  const plain = Buffer.from("old\n");
  const plainPatch = parseApplyPatchV1(
    {
      path: "plain.txt",
      expectedSha256: sha256Hex(plain),
      expectedSize: plain.byteLength,
      hunks: [{ oldText: "old", newText: "new", expectedOccurrences: 1 }],
    },
    LIMITS,
  );
  await assert.rejects(
    service.applyPatch(
      plainPatch,
      { ...AUTHORITY, approvedActionHash: "bad" },
      "clean_tracked",
    ),
    (error: unknown) => isDomainCode(error, "approval_invalid"),
  );
});

test("diff artifacts bind full output while previews escape controls and stay bounded", () => {
  const artifact = createDiffArtifact(
    normalizeWorkspaceRelativePath("line\nbreak.txt", { allowRoot: false }),
    Buffer.from("before\n"),
    Buffer.from("after\u001b[31m\n"),
    { maximumFullDiffBytes: 32, maximumPreviewBytes: 160 },
  );
  assert.match(artifact.fullDiffSha256, /^[a-f0-9]{64}$/u);
  assert.equal(artifact.retainedFullDiff, null);
  assert.equal(artifact.preview.includes("\u001b"), false);
  assert.equal(artifact.preview.includes("\\u{1b}"), true);
  assert.equal(Buffer.byteLength(artifact.preview, "utf8") <= 160, true);
  assert.equal(artifact.preview.includes("line\nbreak.txt"), false);
});
