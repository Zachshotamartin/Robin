import {
  createDomainError,
  type JsonObject,
  type JsonValue,
} from "@guard/contracts";
import {
  type ModelProvider,
  type ModelProviderDescriptor,
  type ModelProviderEvent,
  type SemanticConversationItem,
  type SemanticModelRequest,
  type SemanticOperationDefinition,
} from "@guard/model-provider";

const DESCRIPTOR: ModelProviderDescriptor = Object.freeze({
  adapterId: "robin.r2-synthetic-coding",
  adapterVersion: "1.0.0",
  capabilities: Object.freeze({
    streaming: true,
    structuredActions: true,
    exactUsage: true,
    cancellation: "confirmed",
  }),
});

interface ToolIdentity {
  readonly capabilityPackId: string;
  readonly capabilityPackVersion: 1;
  readonly operationId: string;
  readonly operationVersion: 1;
}

const TOOLS = Object.freeze({
  list: identity("robin.repo", "list_files"),
  search: identity("robin.repo", "search_text"),
  read: identity("robin.repo", "read_file"),
  apply: identity("robin.edit", "apply_patch"),
  create: identity("robin.edit", "create_file"),
  process: identity("robin.process", "run"),
  status: identity("robin.git", "status"),
  diff: identity("robin.git", "diff"),
});

const EXPECTED_TOOLS = Object.freeze([
  TOOLS.list,
  TOOLS.search,
  TOOLS.read,
  TOOLS.apply,
  TOOLS.create,
  TOOLS.process,
  TOOLS.status,
  TOOLS.diff,
]);

const PRIMARY_BUG = "total - value";
const PRIMARY_FIX = "total + value";
const FOLLOW_UP_BUG = "return label.toLowerCase();";
const FOLLOW_UP_FIX = "return label.toUpperCase();";
const MAXIMUM_SEARCH_PATHS = 256;
const MAXIMUM_ARGUMENT_CHUNK_BYTES = 96;

interface Observation {
  readonly callId: string;
  readonly value: JsonObject;
}

interface ReleasedRead {
  readonly path: string;
  readonly content: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
}

interface EditPreimage {
  readonly path: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly oldText: string;
  readonly newText: string;
  readonly expectedStartLine: number;
}

type ProcessOutcome = "success" | "nonzero" | "stopped";

/**
 * Credential-free R2 provider used to prove the real coding loop without a
 * hosted model. It is deliberately stateless: every next action is derived
 * from the provider-neutral semantic transcript and exact tool observations.
 */
export class R2SyntheticCodingProvider implements ModelProvider {
  public readonly descriptor = DESCRIPTOR;

  public respond(
    request: SemanticModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelProviderEvent> {
    return this.#respond(request, signal);
  }

  async *#respond(
    request: SemanticModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelProviderEvent, void, undefined> {
    throwIfAborted(signal);
    validateRequest(request);
    const turnNumber = requestTurnNumber(request);
    const latestUserIndex = latestUserItemIndex(request.conversation);
    const prompt = textFromUserItem(request.conversation[latestUserIndex]!);

    if (prompt.includes("[scenario:provider-error]")) {
      yield Object.freeze({
        type: "response_failed",
        failure: Object.freeze({
          code: "synthetic_provider_error",
          message: "The deterministic R2 provider error scenario was requested.",
          retry: "terminal",
          resultCertainty: "no_result",
        }),
      });
      return;
    }

    if (prompt.includes("[scenario:slow]")) {
      for (let index = 0; index < 10_000; index += 1) {
        await yieldToEventLoop();
        throwIfAborted(signal);
        yield Object.freeze({
          type: "text_delta",
          outputIndex: 0,
          delta: index === 0 ? "Inspecting the R2 workspace…" : ".",
        });
      }
      yield usageFor(request, 10_001);
      yield Object.freeze({ type: "response_completed", finishReason: "stop" });
      return;
    }

    const observations = observationsAfter(
      request.conversation,
      latestUserIndex,
    );
    assertUniqueObservationIds(observations);
    const ids = callIdsForTurn(turnNumber);

    if (observations.length === 0) {
      yield* streamText(
        "I’ll inspect the repository, locate the deterministic defect, edit its exact preimage, run verification, and review Git evidence.\n",
        signal,
      );
      yield* emitToolCall(ids.list, TOOLS.list, { root: "." }, signal);
      yield usageFor(request, 46);
      yield actionRequired();
      return;
    }

    const refusal = firstRefusal(observations);
    if (refusal !== null) {
      yield* finalRefusal(refusal, observations, signal);
      yield usageFor(request, 54);
      yield stopped();
      return;
    }

    const last = observations.at(-1)!;
    if (last.callId === ids.list) {
      requireSequence(observations, [ids.list]);
      const paths = pathsFromList(last.value);
      if (paths.length === 0) {
        yield* finalNoMatch(
          "The bounded repository listing contained no eligible regular text files, so I made no changes.",
          signal,
        );
        yield usageFor(request, 33);
        yield stopped();
        return;
      }
      yield* emitToolCall(
        ids.search,
        TOOLS.search,
        { query: PRIMARY_BUG, paths },
        signal,
      );
      yield usageFor(request, 31);
      yield actionRequired();
      return;
    }

    if (last.callId === ids.search) {
      requireSequence(observations, [ids.list, ids.search]);
      const listedPaths = pathsFromList(observations[0]!.value);
      const matchedPath = pathFromSearch(last.value, listedPaths);
      if (matchedPath === null) {
        yield* finalNoMatch(
          `No listed file contained the exact diagnostic literal ${JSON.stringify(PRIMARY_BUG)}, so I made no changes.`,
          signal,
        );
        yield usageFor(request, 38);
        yield stopped();
        return;
      }
      yield* emitToolCall(
        ids.readInitial,
        TOOLS.read,
        { path: matchedPath, selector: { kind: "whole" } },
        signal,
      );
      yield usageFor(request, 29);
      yield actionRequired();
      return;
    }

    if (last.callId === ids.readInitial) {
      requireSequence(observations, [ids.list, ids.search, ids.readInitial]);
      const listedPaths = pathsFromList(observations[0]!.value);
      const matchedPath = pathFromSearch(observations[1]!.value, listedPaths);
      if (matchedPath === null) providerFailure("The earlier search result diverged.");
      const read = releasedRead(last.value, matchedPath);
      if (read === null) {
        yield* finalNoMatch(
          "The candidate file was withheld by the workspace boundary, so I made no changes.",
          signal,
        );
        yield usageFor(request, 35);
        yield stopped();
        return;
      }
      const edit = deriveEdit(read, PRIMARY_BUG, PRIMARY_FIX);
      if (edit === null) {
        yield* finalNoMatch(
          "The candidate changed between search and read or the defect was ambiguous, so I made no changes.",
          signal,
        );
        yield usageFor(request, 39);
        yield stopped();
        return;
      }
      yield* emitToolCall(ids.editPrimary, TOOLS.apply, editArguments(edit), signal);
      yield usageFor(request, 44);
      yield actionRequired();
      return;
    }

    if (last.callId === ids.editPrimary) {
      requireSequence(observations, [
        ids.list,
        ids.search,
        ids.readInitial,
        ids.editPrimary,
      ]);
      const read = replayInitialRead(observations, ids);
      assertEditResult(last.value, read, "apply_patch");
      yield* emitToolCall(ids.verifyPrimary, TOOLS.process, verificationRequest(), signal);
      yield usageFor(request, 34);
      yield actionRequired();
      return;
    }

    if (last.callId === ids.verifyPrimary) {
      requireSequence(observations, [
        ids.list,
        ids.search,
        ids.readInitial,
        ids.editPrimary,
        ids.verifyPrimary,
      ]);
      const outcome = processOutcome(last.value);
      if (outcome === "success") {
        yield* emitToolCall(ids.statusAfterPrimary, TOOLS.status, {}, signal);
        yield usageFor(request, 27);
        yield actionRequired();
        return;
      }
      if (outcome === "stopped") {
        yield* finalNoMatch(
          "The first verification did not complete as a normal test failure or success. I stopped without attempting another edit.",
          signal,
        );
        yield usageFor(request, 45);
        yield stopped();
        return;
      }
      const read = replayInitialRead(observations, ids);
      yield* emitToolCall(
        ids.readFollowUp,
        TOOLS.read,
        { path: read.path, selector: { kind: "whole" } },
        signal,
      );
      yield usageFor(request, 31);
      yield actionRequired();
      return;
    }

    if (last.callId === ids.readFollowUp) {
      requireSequence(observations, [
        ids.list,
        ids.search,
        ids.readInitial,
        ids.editPrimary,
        ids.verifyPrimary,
        ids.readFollowUp,
      ]);
      if (processOutcome(observations[4]!.value) !== "nonzero") {
        providerFailure("A follow-up read requires one ordinary nonzero verification.");
      }
      const initial = replayInitialRead(observations, ids);
      const read = releasedRead(last.value, initial.path);
      if (read === null) {
        yield* finalNoMatch(
          "Verification failed and the changed file could not be re-read safely. I stopped before another edit.",
          signal,
        );
        yield usageFor(request, 43);
        yield stopped();
        return;
      }
      const edit = deriveEdit(read, FOLLOW_UP_BUG, FOLLOW_UP_FIX);
      if (edit === null) {
        yield* finalNoMatch(
          "Verification failed, but the re-read contained no unique recognized follow-up defect. I stopped rather than guessing.",
          signal,
        );
        yield usageFor(request, 50);
        yield stopped();
        return;
      }
      yield* emitToolCall(ids.editFollowUp, TOOLS.apply, editArguments(edit), signal);
      yield usageFor(request, 45);
      yield actionRequired();
      return;
    }

    if (last.callId === ids.editFollowUp) {
      requireSequence(observations, [
        ids.list,
        ids.search,
        ids.readInitial,
        ids.editPrimary,
        ids.verifyPrimary,
        ids.readFollowUp,
        ids.editFollowUp,
      ]);
      const initial = replayInitialRead(observations, ids);
      const followUpRead = releasedRead(observations[5]!.value, initial.path);
      if (followUpRead === null) providerFailure("The follow-up read diverged.");
      assertEditResult(last.value, followUpRead, "apply_patch");
      yield* emitToolCall(ids.verifyFollowUp, TOOLS.process, verificationRequest(), signal);
      yield usageFor(request, 35);
      yield actionRequired();
      return;
    }

    if (last.callId === ids.verifyFollowUp) {
      requireSequence(observations, [
        ids.list,
        ids.search,
        ids.readInitial,
        ids.editPrimary,
        ids.verifyPrimary,
        ids.readFollowUp,
        ids.editFollowUp,
        ids.verifyFollowUp,
      ]);
      if (processOutcome(last.value) !== "success") {
        yield* finalNoMatch(
          "The follow-up verification still did not pass. I stopped after the bounded second attempt and did not claim success.",
          signal,
        );
        yield usageFor(request, 45);
        yield stopped();
        return;
      }
      yield* emitToolCall(ids.statusAfterFollowUp, TOOLS.status, {}, signal);
      yield usageFor(request, 27);
      yield actionRequired();
      return;
    }

    if (last.callId === ids.statusAfterPrimary) {
      requireSequence(observations, [
        ids.list,
        ids.search,
        ids.readInitial,
        ids.editPrimary,
        ids.verifyPrimary,
        ids.statusAfterPrimary,
      ]);
      if (processOutcome(observations[4]!.value) !== "success") {
        providerFailure("Primary-path Git review requires a passing verification.");
      }
      validateGitStatus(last.value);
      yield* emitToolCall(
        ids.diffAfterPrimary,
        TOOLS.diff,
        { scope: "working" },
        signal,
      );
      yield usageFor(request, 25);
      yield actionRequired();
      return;
    }

    if (last.callId === ids.diffAfterPrimary) {
      requireSequence(observations, [
        ids.list,
        ids.search,
        ids.readInitial,
        ids.editPrimary,
        ids.verifyPrimary,
        ids.statusAfterPrimary,
        ids.diffAfterPrimary,
      ]);
      const read = replayInitialRead(observations, ids);
      const status = validateGitStatus(observations[5]!.value);
      const diff = validateGitDiff(last.value);
      yield* streamText(finalSuccess(read.path, 1, status, diff), signal);
      yield usageFor(request, 77);
      yield stopped();
      return;
    }

    if (last.callId === ids.statusAfterFollowUp) {
      requireSequence(observations, [
        ids.list,
        ids.search,
        ids.readInitial,
        ids.editPrimary,
        ids.verifyPrimary,
        ids.readFollowUp,
        ids.editFollowUp,
        ids.verifyFollowUp,
        ids.statusAfterFollowUp,
      ]);
      if (processOutcome(observations[7]!.value) !== "success") {
        providerFailure("Follow-up Git review requires a passing verification.");
      }
      validateGitStatus(last.value);
      yield* emitToolCall(
        ids.diffAfterFollowUp,
        TOOLS.diff,
        { scope: "working" },
        signal,
      );
      yield usageFor(request, 25);
      yield actionRequired();
      return;
    }

    if (last.callId === ids.diffAfterFollowUp) {
      requireSequence(observations, [
        ids.list,
        ids.search,
        ids.readInitial,
        ids.editPrimary,
        ids.verifyPrimary,
        ids.readFollowUp,
        ids.editFollowUp,
        ids.verifyFollowUp,
        ids.statusAfterFollowUp,
        ids.diffAfterFollowUp,
      ]);
      const read = replayInitialRead(observations, ids);
      const status = validateGitStatus(observations[8]!.value);
      const diff = validateGitDiff(last.value);
      yield* streamText(finalSuccess(read.path, 2, status, diff), signal);
      yield usageFor(request, 84);
      yield stopped();
      return;
    }

    providerFailure("The R2 semantic transcript contains an unknown tool-call sequence.");
  }
}

function identity(capabilityPackId: string, operationId: string): ToolIdentity {
  return Object.freeze({
    capabilityPackId,
    capabilityPackVersion: 1,
    operationId,
    operationVersion: 1,
  });
}

function validateRequest(request: SemanticModelRequest): void {
  if (
    request.actionMode !== "structured" ||
    !Array.isArray(request.conversation) ||
    request.conversation.length === 0 ||
    !Array.isArray(request.operations) ||
    request.operations.length !== EXPECTED_TOOLS.length
  ) {
    providerFailure("The R2 provider received an invalid semantic request.");
  }
  const actual = request.operations.map(operationKey).sort();
  const expected = EXPECTED_TOOLS.map(toolKey).sort();
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index]) ||
    new Set(actual).size !== actual.length
  ) {
    providerFailure("The R2 provider requires the exact eight R2 coding tools.");
  }
}

function operationKey(operation: SemanticOperationDefinition): string {
  return JSON.stringify([
    operation.capabilityPackId,
    operation.capabilityPackVersion,
    operation.operationId,
    operation.operationVersion,
  ]);
}

function toolKey(tool: ToolIdentity): string {
  return JSON.stringify([
    tool.capabilityPackId,
    tool.capabilityPackVersion,
    tool.operationId,
    tool.operationVersion,
  ]);
}

function requestTurnNumber(request: SemanticModelRequest): number {
  const value = request.metadata["turnNumber"];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    providerFailure("The R2 provider received an invalid turn number.");
  }
  return value as number;
}

function latestUserItemIndex(items: readonly SemanticConversationItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "user") return index;
  }
  providerFailure("The R2 provider requires a user prompt.");
}

function textFromUserItem(item: SemanticConversationItem): string {
  if (item.role !== "user" || item.content.length === 0) {
    providerFailure("The latest R2 user item is malformed.");
  }
  const parts: string[] = [];
  for (const block of item.content) {
    if (block.modality !== "text") {
      providerFailure("The latest R2 user item must contain only text.");
    }
    parts.push(block.text);
  }
  return parts.join("\n");
}

function observationsAfter(
  items: readonly SemanticConversationItem[],
  latestUserIndex: number,
): readonly Observation[] {
  const observations: Observation[] = [];
  for (const item of items.slice(latestUserIndex + 1)) {
    if (item.role !== "operation") continue;
    if (
      typeof item.correlationId !== "string" ||
      item.content.length !== 1 ||
      item.content[0]?.modality !== "json"
    ) {
      providerFailure("An R2 tool observation item is malformed.");
    }
    observations.push(Object.freeze({
      callId: item.correlationId,
      value: record(item.content[0].value, "An R2 tool observation must be an object."),
    }));
  }
  return Object.freeze(observations);
}

function assertUniqueObservationIds(observations: readonly Observation[]): void {
  if (new Set(observations.map((item) => item.callId)).size !== observations.length) {
    providerFailure("The R2 semantic transcript reused a tool-call identifier.");
  }
}

function requireSequence(
  observations: readonly Observation[],
  expected: readonly string[],
): void {
  if (
    observations.length !== expected.length ||
    observations.some((item, index) => item.callId !== expected[index])
  ) {
    providerFailure("The R2 semantic transcript has a divergent action sequence.");
  }
}

function firstRefusal(
  observations: readonly Observation[],
): { readonly status: "denied" | "stale"; readonly reason: string } | null {
  for (const observation of observations) {
    const status = observation.value["status"];
    if (status !== "denied" && status !== "stale") continue;
    if (
      observation.value["effectOccurred"] !== false ||
      typeof observation.value["reason"] !== "string"
    ) {
      providerFailure("A gateway refusal observation is malformed.");
    }
    return Object.freeze({ status, reason: refusalReason(observation.value["reason"]) });
  }
  return null;
}

function refusalReason(reason: string): string {
  switch (reason) {
    case "policy_denied":
      return "policy denied the action";
    case "user_denied":
      return "the user denied the action";
    case "approval_expired":
      return "the approval expired";
    case "preconditions_changed":
      return "the approved preconditions changed";
    default:
      return "the action was refused without a recognized safe reason";
  }
}

async function* finalRefusal(
  refusal: { readonly status: "denied" | "stale"; readonly reason: string },
  observations: readonly Observation[],
  signal: AbortSignal,
): AsyncGenerator<ModelProviderEvent, void, undefined> {
  const priorEffects = observations.some((item) => {
    const operation = item.value["operation"];
    return operation === "apply_patch" || operation === "create_file";
  });
  const effectNote = priorEffects
    ? "An earlier approved edit may already be present; inspect Git status before deciding what to do next."
    : "No effect occurred for the refused action.";
  yield* streamText(
    `I stopped safely because ${refusal.reason} (${refusal.status}). ${effectNote}`,
    signal,
  );
}

function pathsFromList(observation: JsonObject): readonly string[] {
  const output = releasedOutput(observation, "files");
  if (!Array.isArray(output["files"])) {
    providerFailure("The R2 list observation has no bounded file array.");
  }
  const candidates: string[] = [];
  for (const value of output["files"]) {
    const entry = record(value, "An R2 list entry is malformed.");
    const path = entry["path"];
    const kind = entry["kind"];
    if (typeof path !== "string" || typeof kind !== "string") {
      providerFailure("An R2 list entry is missing path metadata.");
    }
    if (
      kind === "regular_file" &&
      entry["generated"] === false &&
      safeWorkspacePath(path)
    ) {
      candidates.push(path);
    }
  }
  const unique = [...new Set(candidates)].sort(compareUtf8);
  return Object.freeze(unique.slice(0, MAXIMUM_SEARCH_PATHS));
}

function pathFromSearch(
  observation: JsonObject,
  listedPaths: readonly string[],
): string | null {
  const output = releasedOutput(observation, "matches");
  if (!Array.isArray(output["matches"])) {
    providerFailure("The R2 search observation has no bounded match array.");
  }
  if (!Number.isSafeInteger(output["matchedCount"])) {
    providerFailure("The R2 search observation has an invalid match count.");
  }
  if (
    output["truncated"] === true ||
    output["matchedCount"] !== output["matches"].length
  ) {
    return null;
  }
  if (output["truncated"] !== false) {
    providerFailure("The R2 search observation has an invalid truncation fact.");
  }
  if (output["matches"].length === 0) return null;
  const listed = new Set(listedPaths);
  const matchingPaths = new Set<string>();
  for (const value of output["matches"]) {
    const match = record(value, "An R2 search match is malformed.");
    const path = match["path"];
    if (
      typeof path !== "string" ||
      !safeWorkspacePath(path) ||
      !listed.has(path) ||
      !Number.isSafeInteger(match["line"]) ||
      !Number.isSafeInteger(match["column"]) ||
      typeof match["snippet"] !== "string"
    ) {
      providerFailure("An R2 search match diverges from the released listing.");
    }
    matchingPaths.add(path);
  }
  if (matchingPaths.size !== 1) {
    providerFailure("The deterministic defect must resolve to exactly one listed file.");
  }
  return [...matchingPaths][0]!;
}

function releasedRead(observation: JsonObject, expectedPath: string): ReleasedRead | null {
  const output = releasedOutput(observation, "status");
  if (output["status"] === "withheld") return null;
  if (output["status"] !== "released") {
    providerFailure("The R2 read observation has an invalid release status.");
  }
  const path = output["path"];
  const content = output["content"];
  const sourceSha256 = output["sourceSha256"];
  const sourceBytes = output["sourceBytes"];
  if (
    path !== expectedPath ||
    typeof content !== "string" ||
    !sha256(sourceSha256) ||
    !nonnegativeInteger(sourceBytes) ||
    !nonnegativeInteger(output["selectedBytes"]) ||
    typeof output["truncated"] !== "boolean"
  ) {
    providerFailure("The R2 read observation is incomplete or internally inconsistent.");
  }
  if (
    output["truncated"] ||
    output["selectedBytes"] !== sourceBytes ||
    Buffer.byteLength(content, "utf8") !== sourceBytes
  ) {
    return null;
  }
  return Object.freeze({ path, content, sourceSha256, sourceBytes });
}

function deriveEdit(
  read: ReleasedRead,
  oldText: string,
  newText: string,
): EditPreimage | null {
  const first = read.content.indexOf(oldText);
  if (first < 0 || read.content.indexOf(oldText, first + oldText.length) >= 0) {
    return null;
  }
  return Object.freeze({
    path: read.path,
    sourceSha256: read.sourceSha256,
    sourceBytes: read.sourceBytes,
    oldText,
    newText,
    expectedStartLine: lineNumberAt(read.content, first),
  });
}

function editArguments(edit: EditPreimage): JsonObject {
  return Object.freeze({
    path: edit.path,
    expectedSha256: edit.sourceSha256,
    expectedSize: edit.sourceBytes,
    hunks: Object.freeze([
      Object.freeze({
        oldText: edit.oldText,
        newText: edit.newText,
        expectedOccurrences: 1,
        expectedStartLine: edit.expectedStartLine,
      }),
    ]),
  });
}

function assertEditResult(
  observation: JsonObject,
  preimage: ReleasedRead,
  expectedOperation: "apply_patch" | "create_file",
): void {
  const output = releasedOutput(observation, "operation");
  if (
    output["operation"] !== expectedOperation ||
    output["path"] !== preimage.path ||
    output["beforeSha256"] !== preimage.sourceSha256 ||
    output["beforeBytes"] !== preimage.sourceBytes ||
    !sha256(output["afterSha256"]) ||
    !nonnegativeInteger(output["afterBytes"]) ||
    output["afterSha256"] === preimage.sourceSha256 ||
    !positiveInteger(output["ledgerSequence"])
  ) {
    providerFailure("The R2 edit observation does not prove the requested edit.");
  }
}

function verificationRequest(): JsonObject {
  return Object.freeze({
    schemaVersion: 1,
    executable: "npm",
    argv: Object.freeze(["test"]),
    cwd: ".",
    environment: Object.freeze({}),
    timeoutMs: 120_000,
    terminationGraceMs: 1_000,
    output: Object.freeze({
      retainedHeadBytes: 32_768,
      retainedTailBytes: 32_768,
      absoluteBytes: 1_048_576,
    }),
    stdin: Object.freeze({ kind: "closed" }),
    intent: "test",
  });
}

function processOutcome(observation: JsonObject): ProcessOutcome {
  const output = releasedOutput(observation, "classification");
  const classification = output["classification"];
  const exitCode = output["exitCode"];
  if (
    output["sandboxed"] !== false ||
    output["filesystemIsolation"] !== "none" ||
    output["networkIsolation"] !== "none" ||
    typeof output["processGroupReaped"] !== "boolean"
  ) {
    providerFailure("The R2 process observation has invalid isolation facts.");
  }
  if (
    classification === "success" &&
    exitCode === 0 &&
    output["processGroupReaped"] === true
  ) {
    return "success";
  }
  if (
    classification === "nonzero_exit" &&
    Number.isSafeInteger(exitCode) &&
    (exitCode as number) !== 0
  ) {
    return "nonzero";
  }
  if (
    classification === "signal_exit" ||
    classification === "spawn_failed" ||
    classification === "cancelled" ||
    classification === "timed_out" ||
    classification === "output_limit_exceeded" ||
    classification === "controller_failed" ||
    classification === "termination_incomplete"
  ) {
    return "stopped";
  }
  providerFailure("The R2 process observation has an inconsistent result.");
}

function validateGitStatus(observation: JsonObject): {
  readonly availability: "released" | "unavailable";
  readonly totalEntries: number | null;
} {
  const output = releasedOutput(observation, "status");
  if (output["status"] === "unavailable") {
    if (
      output["reason"] !== "git_rescan_failed" ||
      output["attribution"] !== "not_collected"
    ) {
      providerFailure("The R2 unavailable Git status observation is malformed.");
    }
    return Object.freeze({ availability: "unavailable", totalEntries: null });
  }
  if (
    output["status"] !== "released" ||
    !Array.isArray(output["entries"]) ||
    !nonnegativeInteger(output["totalEntries"]) ||
    !sha256(output["statusSha256"]) ||
    typeof output["truncated"] !== "boolean"
  ) {
    providerFailure("The R2 Git status observation is malformed.");
  }
  return Object.freeze({
    availability: "released",
    totalEntries: output["totalEntries"],
  });
}

function validateGitDiff(observation: JsonObject): {
  readonly sha256: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
} {
  const output = releasedOutput(observation, "kind");
  if (
    output["kind"] !== "working" ||
    !Array.isArray(output["paths"]) ||
    typeof output["text"] !== "string" ||
    !sha256(output["sha256"]) ||
    !nonnegativeInteger(output["totalBytes"]) ||
    !nonnegativeInteger(output["retainedBytes"]) ||
    !nonnegativeInteger(output["omittedBytes"]) ||
    typeof output["truncated"] !== "boolean" ||
    (output["retainedBytes"] as number) + (output["omittedBytes"] as number) !==
      output["totalBytes"]
  ) {
    providerFailure("The R2 Git diff observation is malformed.");
  }
  return Object.freeze({
    sha256: output["sha256"],
    totalBytes: output["totalBytes"],
    truncated: output["truncated"],
  });
}

function replayInitialRead(
  observations: readonly Observation[],
  ids: ReturnType<typeof callIdsForTurn>,
): ReleasedRead {
  const listed = pathsFromList(observations[0]!.value);
  const matched = pathFromSearch(observations[1]!.value, listed);
  if (matched === null || observations[2]!.callId !== ids.readInitial) {
    providerFailure("The R2 initial diagnosis cannot be replayed.");
  }
  const read = releasedRead(observations[2]!.value, matched);
  if (read === null) providerFailure("The R2 initial read cannot be replayed.");
  return read;
}

function releasedOutput(observation: JsonObject, expectedKey: string): JsonObject {
  if (expectedKey in observation) return observation;
  const nested = observation["output"];
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    const output = nested as JsonObject;
    if (expectedKey in output) return output;
  }
  return observation;
}

function record(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    providerFailure(message);
  }
  return value as JsonObject;
}

function safeWorkspacePath(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    containsUnpairedSurrogate(value) ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return false;
  }
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      point < 0x20 ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x2028 ||
      point === 0x2029 ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    ) {
      return false;
    }
  }
  return true;
}

function sha256(value: JsonValue | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonnegativeInteger(value: JsonValue | undefined): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: JsonValue | undefined): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        following < 0xdc00 ||
        following > 0xdfff
      ) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (content.charCodeAt(offset) === 0x0a) line += 1;
  }
  return line;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function finalSuccess(
  path: string,
  editCount: number,
  status: ReturnType<typeof validateGitStatus>,
  diff: ReturnType<typeof validateGitDiff>,
): string {
  const statusText = status.availability === "released"
    ? `${status.totalEntries} current Git status entr${status.totalEntries === 1 ? "y" : "ies"}`
    : "Git attribution was unavailable after a nonfatal rescan failure";
  return [
    `Fixed ${path} with ${editCount} approved structural edit${editCount === 1 ? "" : "s"}.`,
    `The direct npm test verification passed after ${editCount} attempt${editCount === 1 ? "" : "s"}.`,
    `${statusText}.`,
    `Reviewed the working-tree diff (${diff.totalBytes} bytes, sha256 ${diff.sha256}${diff.truncated ? ", truncated view" : ""}).`,
    "The verification process reported no filesystem or network isolation; this workflow was not sandboxed.",
  ].join(" ");
}

async function* finalNoMatch(
  text: string,
  signal: AbortSignal,
): AsyncGenerator<ModelProviderEvent, void, undefined> {
  yield* streamText(text, signal);
}

async function* streamText(
  value: string,
  signal: AbortSignal,
): AsyncGenerator<ModelProviderEvent, void, undefined> {
  const scalars = [...value];
  for (let index = 0; index < scalars.length; index += 24) {
    await yieldToEventLoop();
    throwIfAborted(signal);
    yield Object.freeze({
      type: "text_delta",
      outputIndex: 0,
      delta: scalars.slice(index, index + 24).join(""),
    });
  }
}

async function* emitToolCall(
  callId: string,
  tool: ToolIdentity,
  args: JsonObject,
  signal: AbortSignal,
): AsyncGenerator<ModelProviderEvent, void, undefined> {
  await yieldToEventLoop();
  throwIfAborted(signal);
  yield Object.freeze({ type: "action_started", callId, ...tool });
  const argumentsJson = JSON.stringify(args);
  for (const chunk of utf8Chunks(argumentsJson, MAXIMUM_ARGUMENT_CHUNK_BYTES)) {
    await yieldToEventLoop();
    throwIfAborted(signal);
    yield Object.freeze({ type: "action_arguments_delta", callId, delta: chunk });
  }
  await yieldToEventLoop();
  throwIfAborted(signal);
  yield Object.freeze({
    type: "action_completed",
    callId,
    ...tool,
    arguments: args,
  });
}

function utf8Chunks(value: string, maximumBytes: number): readonly string[] {
  const output: string[] = [];
  let current = "";
  for (const scalar of value) {
    if (
      current.length > 0 &&
      Buffer.byteLength(current + scalar, "utf8") > maximumBytes
    ) {
      output.push(current);
      current = scalar;
    } else {
      current += scalar;
    }
  }
  if (current.length > 0) output.push(current);
  return Object.freeze(output);
}

function usageFor(
  request: SemanticModelRequest,
  outputTokens: number,
): ModelProviderEvent {
  const inputBytes = Buffer.byteLength(JSON.stringify({
    instructions: request.instructions,
    conversation: request.conversation,
    operations: request.operations.map(operationKey),
  }), "utf8");
  return Object.freeze({
    type: "usage_reported",
    dimensions: Object.freeze({
      input_tokens: Math.max(1, Math.ceil(inputBytes / 4)),
      output_tokens: outputTokens,
    }),
  });
}

function actionRequired(): ModelProviderEvent {
  return Object.freeze({ type: "response_completed", finishReason: "action_required" });
}

function stopped(): ModelProviderEvent {
  return Object.freeze({ type: "response_completed", finishReason: "stop" });
}

function callIdsForTurn(turnNumber: number) {
  const prefix = `r2-turn-${turnNumber}`;
  return Object.freeze({
    list: `${prefix}-01-list`,
    search: `${prefix}-02-search`,
    readInitial: `${prefix}-03-read-initial`,
    editPrimary: `${prefix}-04-edit-primary`,
    verifyPrimary: `${prefix}-05-verify-primary`,
    readFollowUp: `${prefix}-06-read-follow-up`,
    editFollowUp: `${prefix}-07-edit-follow-up`,
    verifyFollowUp: `${prefix}-08-verify-follow-up`,
    statusAfterPrimary: `${prefix}-06-status`,
    diffAfterPrimary: `${prefix}-07-diff`,
    statusAfterFollowUp: `${prefix}-09-status`,
    diffAfterFollowUp: `${prefix}-10-diff`,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw createDomainError({
      code: "cancelled",
      message: "The R2 synthetic provider response was cancelled.",
    });
  }
}

function providerFailure(message: string): never {
  throw createDomainError({ code: "provider_failed", message });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
