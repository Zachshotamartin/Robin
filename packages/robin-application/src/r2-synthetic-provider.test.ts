import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentAttemptIdKind,
  isDomainError,
  type ContentBlock,
  type JsonObject,
} from "@guard/contracts";
import type {
  ModelProviderEvent,
  SemanticConversationItem,
  SemanticModelRequest,
  SemanticOperationDefinition,
} from "@guard/model-provider";

import { R2SyntheticCodingProvider } from "./r2-synthetic-provider.js";

const ATTEMPT_ID = AgentAttemptIdKind.parse(
  "att_01910103-0000-7000-8000-230000000001",
);
const PATH = "src/calculate.ts";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const DIFF_HASH = "d".repeat(64);
const INITIAL_CONTENT = [
  "export function calculate(values: number[]): number {",
  "  return values.reduce((total, value) => total - value, 0);",
  "}",
  "",
  "export function normalizeLabel(label: string): string {",
  "  return label.toLowerCase();",
  "}",
  "",
].join("\n");
const PRIMARY_CONTENT = INITIAL_CONTENT.replace("total - value", "total + value");
const FINAL_CONTENT = PRIMARY_CONTENT.replace(
  "return label.toLowerCase();",
  "return label.toUpperCase();",
);

const TOOL_IDENTITIES = Object.freeze([
  ["robin.repo", "list_files"],
  ["robin.repo", "search_text"],
  ["robin.repo", "read_file"],
  ["robin.edit", "apply_patch"],
  ["robin.edit", "create_file"],
  ["robin.process", "run"],
  ["robin.git", "status"],
  ["robin.git", "diff"],
] as const);

interface CompletedCall {
  readonly callId: string;
  readonly packId: string;
  readonly operationId: string;
  readonly args: JsonObject;
  readonly events: readonly ModelProviderEvent[];
}

function operations(): readonly SemanticOperationDefinition[] {
  return Object.freeze(
    TOOL_IDENTITIES.map(([capabilityPackId, operationId]) =>
      Object.freeze({
        capabilityPackId,
        capabilityPackVersion: 1,
        operationId,
        operationVersion: 1,
        description: `${capabilityPackId}.${operationId}`,
        inputSchema: Object.freeze({ type: "object" }),
      }),
    ),
  );
}

function textBlock(id: string, text: string): ContentBlock {
  return Object.freeze({
    schemaVersion: 1,
    blockId: id,
    modality: "text",
    mediaType: "text/plain",
    byteLength: Buffer.byteLength(text, "utf8"),
    contentHash: `sha256:${"1".repeat(64)}`,
    classification: "internal",
    provenance: Object.freeze({
      source: null,
      producer: Object.freeze({ kind: "user", id: "r2-provider-test" }),
      capturedAt: "2026-08-30T00:00:00.000Z",
    }),
    retentionClass: "session",
    transformation: null,
    text,
    encoding: "utf-8",
    normalization: "none",
  });
}

function jsonBlock(id: string, value: JsonObject): ContentBlock {
  return Object.freeze({
    schemaVersion: 1,
    blockId: id,
    modality: "json",
    mediaType: "application/json",
    byteLength: Buffer.byteLength(JSON.stringify(value), "utf8"),
    contentHash: `sha256:${"2".repeat(64)}`,
    classification: "internal",
    provenance: Object.freeze({
      source: null,
      producer: Object.freeze({ kind: "capability_worker", id: "r2-provider-test" }),
      capturedAt: "2026-08-30T00:00:00.000Z",
    }),
    retentionClass: "session",
    transformation: null,
    value,
    jsonSchema: null,
  });
}

function baseConversation(prompt = "Diagnose and fix the deterministic fixture."):
  SemanticConversationItem[] {
  return [
    Object.freeze({
      role: "user" as const,
      content: Object.freeze([textBlock("r2-user", prompt)]),
    }),
  ];
}

function observation(callId: string, value: JsonObject): SemanticConversationItem {
  return Object.freeze({
    role: "operation",
    correlationId: callId,
    content: Object.freeze([jsonBlock(`r2-observation-${callId}`, value)]),
  });
}

function request(
  conversation: readonly SemanticConversationItem[],
  operationDefinitions: readonly SemanticOperationDefinition[] = operations(),
): SemanticModelRequest {
  return Object.freeze({
    schemaVersion: 1,
    attemptId: ATTEMPT_ID,
    model: Object.freeze({ modelId: "synthetic-r2-v1", settings: Object.freeze({}) }),
    instructions: Object.freeze(["Use only advertised tools."]),
    conversation: Object.freeze([...conversation]),
    operations: Object.freeze([...operationDefinitions]),
    maximumOutputUnits: 262_144,
    actionMode: "structured",
    metadata: Object.freeze({ turnNumber: 1, requestNumber: conversation.length }),
  });
}

async function collect(
  provider: R2SyntheticCodingProvider,
  conversation: readonly SemanticConversationItem[],
  signal = new AbortController().signal,
): Promise<readonly ModelProviderEvent[]> {
  const events: ModelProviderEvent[] = [];
  for await (const event of provider.respond(request(conversation), signal)) {
    events.push(event);
  }
  return Object.freeze(events);
}

async function nextCall(
  provider: R2SyntheticCodingProvider,
  conversation: SemanticConversationItem[],
  expectedPackId: string,
  expectedOperationId: string,
): Promise<CompletedCall> {
  const events = await collect(provider, conversation);
  const started = events.filter(
    (event): event is Extract<ModelProviderEvent, { type: "action_started" }> =>
      event.type === "action_started",
  );
  const completed = events.filter(
    (event): event is Extract<ModelProviderEvent, { type: "action_completed" }> =>
      event.type === "action_completed",
  );
  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(started[0]!.callId, completed[0]!.callId);
  assert.equal(completed[0]!.capabilityPackId, expectedPackId);
  assert.equal(completed[0]!.operationId, expectedOperationId);
  assert.equal(completed[0]!.capabilityPackVersion, 1);
  assert.equal(completed[0]!.operationVersion, 1);
  assert.equal(events.at(-1)?.type, "response_completed");
  assert.equal(
    (events.at(-1) as Extract<ModelProviderEvent, { type: "response_completed" }>).finishReason,
    "action_required",
  );

  const argumentDeltas = events.filter(
    (event): event is Extract<ModelProviderEvent, { type: "action_arguments_delta" }> =>
      event.type === "action_arguments_delta",
  );
  assert.ok(argumentDeltas.length >= 1);
  assert.ok(
    argumentDeltas.every(
      (event) => Buffer.byteLength(event.delta, "utf8") <= 96,
    ),
    "every provider argument fragment is independently bounded",
  );
  assert.equal(
    argumentDeltas.map((event) => event.delta).join(""),
    JSON.stringify(completed[0]!.arguments),
  );
  return Object.freeze({
    callId: completed[0]!.callId,
    packId: completed[0]!.capabilityPackId,
    operationId: completed[0]!.operationId,
    args: completed[0]!.arguments,
    events,
  });
}

function addObservation(
  conversation: SemanticConversationItem[],
  call: CompletedCall,
  value: JsonObject,
): void {
  conversation.push(observation(call.callId, value));
}

function listResult(): JsonObject {
  return Object.freeze({
    files: Object.freeze([
      Object.freeze({
        path: "package.json",
        kind: "regular_file",
        size: 120,
        links: 1,
        generated: false,
        hidden: false,
        mediaType: "application/json",
      }),
      Object.freeze({
        path: PATH,
        kind: "regular_file",
        size: Buffer.byteLength(INITIAL_CONTENT, "utf8"),
        links: 1,
        generated: false,
        hidden: false,
        mediaType: "text/typescript",
      }),
      Object.freeze({
        path: "dist/calculate.js",
        kind: "regular_file",
        size: 20,
        links: 1,
        generated: true,
        hidden: false,
        mediaType: "text/javascript",
      }),
    ]),
    omissions: Object.freeze([]),
    truncated: false,
    optionsHash: "3".repeat(64),
  });
}

function searchResult(): JsonObject {
  return Object.freeze({
    matches: Object.freeze([
      Object.freeze({
        path: PATH,
        line: 2,
        column: 48,
        snippet: "total - value, 0);",
      }),
    ]),
    matchedCount: 1,
    searchedFiles: 2,
    searchedBytes: 300,
    skipped: Object.freeze([]),
    truncated: false,
  });
}

function readResult(content: string, sourceSha256: string): JsonObject {
  const bytes = Buffer.byteLength(content, "utf8");
  return Object.freeze({
    status: "released",
    path: PATH,
    content,
    sourceSha256,
    sourceBytes: bytes,
    selectedBytes: bytes,
    encoding: "utf8",
    newlineStyle: "lf",
    startLine: 1,
    endLine: 7,
    leadingPartialLine: false,
    trailingPartialLine: false,
    truncated: false,
    atimePreserved: true,
    fileIdentity: Object.freeze({ kind: "regular_file" }),
    promptInjectionTags: Object.freeze([]),
  });
}

function editResult(
  beforeContent: string,
  beforeSha256: string,
  afterContent: string,
  afterSha256: string,
  ledgerSequence: number,
): JsonObject {
  return Object.freeze({
    path: PATH,
    operation: "apply_patch",
    beforeSha256,
    afterSha256,
    beforeBytes: Buffer.byteLength(beforeContent, "utf8"),
    afterBytes: Buffer.byteLength(afterContent, "utf8"),
    changedLineCount: 1,
    diffSha256: DIFF_HASH,
    diffPreview: "bounded preview",
    diffPreviewTruncated: false,
    ledgerSequence,
    directoryFsync: "completed",
    postGit: Object.freeze({ status: "released" }),
  });
}

function processResult(classification: "success" | "nonzero_exit"): JsonObject {
  return Object.freeze({
    classification,
    exitCode: classification === "success" ? 0 : 1,
    signal: null,
    durationMs: 20,
    stdout: Object.freeze({
      head: classification === "success" ? "ok" : "not ok",
      tail: "",
      byteLength: classification === "success" ? 2 : 6,
      sha256: "4".repeat(64),
      truncated: false,
      omittedBytes: 0,
      encoding: "utf8",
    }),
    stderr: Object.freeze({
      head: "",
      tail: "",
      byteLength: 0,
      sha256: "5".repeat(64),
      truncated: false,
      omittedBytes: 0,
      encoding: "utf8",
    }),
    outputLimitExceeded: false,
    processGroupReaped: true,
    sandboxed: false,
    filesystemIsolation: "none",
    networkIsolation: "none",
    preparedHash: "6".repeat(64),
    postGit: Object.freeze({ status: "released" }),
  });
}

function statusResult(): JsonObject {
  return Object.freeze({
    status: "released",
    capturedAt: "2026-08-30T00:00:01.000Z",
    statusSha256: "7".repeat(64),
    branch: Object.freeze({ state: "attached", name: "main" }),
    entries: Object.freeze([
      Object.freeze({
        kind: "ordinary",
        xy: ".M",
        path: PATH,
        originalPath: null,
        submodule: null,
        attribution: "robin_owned",
        currentSha256: HASH_C,
        lastRobinPostimageSha256: HASH_C,
        editActionIds: Object.freeze(["action-1", "action-2"]),
      }),
    ]),
    totalEntries: 1,
    truncated: false,
    submoduleWorktreeEvidence: "not_collected_for_execution_safety",
  });
}

function diffResult(): JsonObject {
  const text = "diff --git a/src/calculate.ts b/src/calculate.ts\n";
  const bytes = Buffer.byteLength(text, "utf8");
  return Object.freeze({
    kind: "working",
    paths: Object.freeze([]),
    text,
    encoding: "utf8",
    totalBytes: bytes,
    retainedBytes: bytes,
    omittedBytes: 0,
    truncated: false,
    sha256: DIFF_HASH,
    submoduleWorktreeEvidence: "not_collected_for_execution_safety",
  });
}

function finalText(events: readonly ModelProviderEvent[]): string {
  return events
    .filter(
      (event): event is Extract<ModelProviderEvent, { type: "text_delta" }> =>
        event.type === "text_delta",
    )
    .map((event) => event.delta)
    .join("");
}

test("requires the exact eight R2 tools and starts with a bounded repository list", async () => {
  const provider = new R2SyntheticCodingProvider();
  const conversation = baseConversation();
  const call = await nextCall(provider, conversation, "robin.repo", "list_files");

  assert.deepEqual(call.args, { root: "." });
  assert.equal(call.callId, "r2-turn-1-01-list");
  assert.equal(provider.descriptor.adapterId, "robin.r2-synthetic-coding");
  assert.equal(provider.descriptor.capabilities.cancellation, "confirmed");

  await assert.rejects(
    async () => {
      for await (const _event of provider.respond(
        request(conversation, operations().slice(0, -1)),
        new AbortController().signal,
      )) {
        // The validation failure occurs before event delivery.
      }
    },
    (error: unknown) => isDomainError(error) && error.code === "provider_failed",
  );
});

test("derives the full fail, re-read, follow-up edit, pass, status, and diff workflow", async () => {
  const provider = new R2SyntheticCodingProvider();
  const conversation = baseConversation();
  const seenCallIds = new Set<string>();

  const list = await nextCall(provider, conversation, "robin.repo", "list_files");
  seenCallIds.add(list.callId);
  addObservation(conversation, list, listResult());

  const search = await nextCall(provider, conversation, "robin.repo", "search_text");
  seenCallIds.add(search.callId);
  assert.equal(search.args["query"], "total - value");
  assert.deepEqual(search.args["paths"], ["package.json", PATH]);
  addObservation(conversation, search, searchResult());

  const read = await nextCall(provider, conversation, "robin.repo", "read_file");
  seenCallIds.add(read.callId);
  assert.deepEqual(read.args, { path: PATH, selector: { kind: "whole" } });
  addObservation(conversation, read, readResult(INITIAL_CONTENT, HASH_A));

  const primaryEdit = await nextCall(provider, conversation, "robin.edit", "apply_patch");
  seenCallIds.add(primaryEdit.callId);
  assert.equal(primaryEdit.args["path"], PATH);
  assert.equal(primaryEdit.args["expectedSha256"], HASH_A);
  assert.equal(primaryEdit.args["expectedSize"], Buffer.byteLength(INITIAL_CONTENT));
  assert.deepEqual(primaryEdit.args["hunks"], [
    {
      oldText: "total - value",
      newText: "total + value",
      expectedOccurrences: 1,
      expectedStartLine: 2,
    },
  ]);
  addObservation(
    conversation,
    primaryEdit,
    editResult(INITIAL_CONTENT, HASH_A, PRIMARY_CONTENT, HASH_B, 1),
  );

  const primaryVerify = await nextCall(
    provider,
    conversation,
    "robin.process",
    "run",
  );
  seenCallIds.add(primaryVerify.callId);
  assert.equal(primaryVerify.args["executable"], "npm");
  assert.deepEqual(primaryVerify.args["argv"], ["test"]);
  assert.equal(primaryVerify.args["cwd"], ".");
  assert.equal(primaryVerify.args["intent"], "test");
  addObservation(conversation, primaryVerify, processResult("nonzero_exit"));

  const followUpRead = await nextCall(provider, conversation, "robin.repo", "read_file");
  seenCallIds.add(followUpRead.callId);
  assert.equal(followUpRead.args["path"], PATH);
  addObservation(conversation, followUpRead, readResult(PRIMARY_CONTENT, HASH_B));

  const followUpEdit = await nextCall(
    provider,
    conversation,
    "robin.edit",
    "apply_patch",
  );
  seenCallIds.add(followUpEdit.callId);
  assert.equal(followUpEdit.args["expectedSha256"], HASH_B);
  assert.equal(followUpEdit.args["expectedSize"], Buffer.byteLength(PRIMARY_CONTENT));
  assert.deepEqual(followUpEdit.args["hunks"], [
    {
      oldText: "return label.toLowerCase();",
      newText: "return label.toUpperCase();",
      expectedOccurrences: 1,
      expectedStartLine: 6,
    },
  ]);
  addObservation(
    conversation,
    followUpEdit,
    editResult(PRIMARY_CONTENT, HASH_B, FINAL_CONTENT, HASH_C, 2),
  );

  const followUpVerify = await nextCall(
    provider,
    conversation,
    "robin.process",
    "run",
  );
  seenCallIds.add(followUpVerify.callId);
  addObservation(conversation, followUpVerify, processResult("success"));

  const status = await nextCall(provider, conversation, "robin.git", "status");
  seenCallIds.add(status.callId);
  assert.deepEqual(status.args, {});
  addObservation(conversation, status, statusResult());

  const diff = await nextCall(provider, conversation, "robin.git", "diff");
  seenCallIds.add(diff.callId);
  assert.deepEqual(diff.args, { scope: "working" });
  addObservation(conversation, diff, diffResult());

  const final = await collect(provider, conversation);
  assert.equal(seenCallIds.size, 10, "every emitted tool call has a unique identifier");
  assert.equal(final.some((event) => event.type === "action_started"), false);
  assert.equal(
    (final.at(-1) as Extract<ModelProviderEvent, { type: "response_completed" }>).finishReason,
    "stop",
  );
  const text = finalText(final);
  assert.match(text, /Fixed src\/calculate\.ts with 2 approved structural edits\./u);
  assert.match(text, /passed after 2 attempts/u);
  assert.match(text, /sha256 d{64}/u);
  assert.match(text, /was not sandboxed/u);
  assert.equal(text.includes(diffResult()["text"] as string), false);
});

test("takes the simpler status and diff path when the first verification passes", async () => {
  const provider = new R2SyntheticCodingProvider();
  const conversation = baseConversation("[scenario:r2-pass] Fix the fixture.");

  const list = await nextCall(provider, conversation, "robin.repo", "list_files");
  addObservation(conversation, list, listResult());
  const search = await nextCall(provider, conversation, "robin.repo", "search_text");
  addObservation(conversation, search, searchResult());
  const read = await nextCall(provider, conversation, "robin.repo", "read_file");
  addObservation(conversation, read, readResult(INITIAL_CONTENT, HASH_A));
  const edit = await nextCall(provider, conversation, "robin.edit", "apply_patch");
  addObservation(
    conversation,
    edit,
    editResult(INITIAL_CONTENT, HASH_A, PRIMARY_CONTENT, HASH_B, 1),
  );
  const verify = await nextCall(provider, conversation, "robin.process", "run");
  addObservation(conversation, verify, processResult("success"));
  const status = await nextCall(provider, conversation, "robin.git", "status");
  assert.equal(status.callId, "r2-turn-1-06-status");
  addObservation(conversation, status, statusResult());
  const diff = await nextCall(provider, conversation, "robin.git", "diff");
  assert.equal(diff.callId, "r2-turn-1-07-diff");
  addObservation(conversation, diff, diffResult());

  const final = await collect(provider, conversation);
  assert.match(finalText(final), /1 approved structural edit\./u);
  assert.match(finalText(final), /passed after 1 attempt\./u);
});

test("turns denied and stale approval observations into safe final reports", async () => {
  for (const refusal of [
    Object.freeze({
      status: "denied",
      code: "policy_denied",
      reason: "user_denied",
      nextAction: "choose_alternative",
    }),
    Object.freeze({
      status: "stale",
      code: "approval_invalid",
      reason: "preconditions_changed",
      nextAction: "reobserve_and_retry",
    }),
  ] as const) {
    const provider = new R2SyntheticCodingProvider();
    const conversation = baseConversation();
    const list = await nextCall(provider, conversation, "robin.repo", "list_files");
    addObservation(conversation, list, listResult());
    const search = await nextCall(provider, conversation, "robin.repo", "search_text");
    addObservation(conversation, search, searchResult());
    const read = await nextCall(provider, conversation, "robin.repo", "read_file");
    addObservation(conversation, read, readResult(INITIAL_CONTENT, HASH_A));
    const edit = await nextCall(provider, conversation, "robin.edit", "apply_patch");
    addObservation(conversation, edit, Object.freeze({
      schemaVersion: 1,
      ...refusal,
      effectOccurred: false,
      actionId: "action-refused",
      capabilityPackId: "robin.edit",
      capabilityPackVersion: 1,
      operationId: "apply_patch",
      operationVersion: 1,
    }));

    const final = await collect(provider, conversation);
    assert.equal(final.some((event) => event.type === "action_started"), false);
    assert.match(finalText(final), refusal.status === "denied" ? /user denied/u : /preconditions changed/u);
    assert.match(finalText(final), /No effect occurred/u);
  }
});

test("fails closed on divergent observations without echoing untrusted content", async () => {
  const provider = new R2SyntheticCodingProvider();
  const conversation = baseConversation();
  const list = await nextCall(provider, conversation, "robin.repo", "list_files");
  addObservation(conversation, list, listResult());
  const search = await nextCall(provider, conversation, "robin.repo", "search_text");
  addObservation(conversation, search, Object.freeze({
    ...searchResult(),
    matches: Object.freeze([
      Object.freeze({
        path: "outside/not-listed.ts",
        line: 1,
        column: 1,
        snippet: "malicious-untrusted-canary",
      }),
    ]),
  }));

  await assert.rejects(
    collect(provider, conversation),
    (error: unknown) => {
      assert.equal(isDomainError(error), true);
      if (!isDomainError(error)) return false;
      assert.equal(error.code, "provider_failed");
      assert.equal(JSON.stringify(error).includes("malicious-untrusted-canary"), false);
      return true;
    },
  );
});

test("honors cancellation during streamed response delivery", async () => {
  const provider = new R2SyntheticCodingProvider();
  const controller = new AbortController();
  const iterator = provider.respond(request(baseConversation()), controller.signal)[
    Symbol.asyncIterator
  ]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.type, "text_delta");
  controller.abort("test cancellation");
  await assert.rejects(
    iterator.next(),
    (error: unknown) => isDomainError(error) && error.code === "cancelled",
  );
});
