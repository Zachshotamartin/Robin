import {
  ActionIdKind,
  canonicalSha256Hex,
  canonicalize,
  createDomainError,
  isDomainError,
  parseNormalizedAction,
  type NormalizedAction,
} from "@guard/contracts";

import { evaluatePolicySnapshot } from "./evaluator.js";
import type {
  PolicyDecision,
  PolicyEffect,
  PolicySimulationCategory,
  PolicySimulationEntry,
  PolicySimulationPage,
  PolicySnapshot,
  PolicyTestCase,
  PolicyTestCaseResult,
  PolicyTestRun,
} from "./types.js";
import { compareUtf8 } from "./stable-order.js";

const CATEGORIES: readonly PolicySimulationCategory[] = Object.freeze([
  "newly_allowed",
  "newly_denied",
  "newly_approval_gated",
  "approval_removed",
  "same_effect_different_explanation",
  "unchanged",
  "evaluation_error",
]);

export function runPolicyTestCases(
  snapshot: PolicySnapshot,
  cases: readonly PolicyTestCase[],
  secretCorrelationToken: string,
): PolicyTestRun {
  if (!Array.isArray(cases)) throw new TypeError("Policy test cases must be an array.");
  const names = new Set<string>();
  const results: PolicyTestCaseResult[] = cases.map((testCase) => {
    if (
      typeof testCase.name !== "string" ||
      testCase.name.trim().length === 0 ||
      names.has(testCase.name)
    ) {
      throw new TypeError("Policy test case names must be unique and non-empty.");
    }
    names.add(testCase.name);
    let decision: PolicyDecision | null = null;
    let errorCode: string | null = null;
    try {
      decision = evaluatePolicySnapshot(snapshot, testCase.action, {
        secretCorrelationToken,
      });
    } catch (error: unknown) {
      errorCode = isDomainError(error) ? error.code : "unexpected_error";
    }
    const expectedWinner = testCase.expectedWinningPolicyName;
    const passed =
      decision !== null &&
      decision.effect === testCase.expectedEffect &&
      (expectedWinner === undefined || decision.winningPolicyName === expectedWinner) &&
      (testCase.expectedReason === undefined || decision.reason === testCase.expectedReason) &&
      (testCase.expectedTraceHash === undefined ||
        canonicalSha256Hex(decision.trace) === testCase.expectedTraceHash);
    return Object.freeze({
      name: testCase.name,
      passed,
      expectedEffect: testCase.expectedEffect,
      actualEffect: decision?.effect ?? null,
      expectedWinningPolicyName: expectedWinner,
      actualWinningPolicyName: decision?.winningPolicyName ?? null,
      errorCode,
    });
  });
  const passed = results.filter((result) => result.passed).length;
  return Object.freeze({
    passed,
    failed: results.length - passed,
    cases: Object.freeze(results),
  });
}

export function simulatePolicyPage(input: {
  readonly from: PolicySnapshot;
  readonly to: PolicySnapshot;
  readonly actions: readonly NormalizedAction[];
  readonly secretCorrelationToken: string;
  readonly cursor?: string | null;
  readonly pageSize?: number;
}): PolicySimulationPage {
  if (!Array.isArray(input.actions)) {
    throw new TypeError("Policy simulation actions must be an array.");
  }
  const pageSize = input.pageSize ?? 100;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new TypeError("Policy simulation page size must be between 1 and 1000.");
  }
  const actions = input.actions.map((action) => parseNormalizedAction(action)).sort((left, right) =>
    compareUtf8(left.actionId, right.actionId),
  );
  for (let index = 1; index < actions.length; index += 1) {
    if (actions[index - 1]?.actionId === actions[index]?.actionId) {
      throw new TypeError("A normalized action ID may appear only once in simulation.");
    }
  }
  const corpusHash = canonicalSha256Hex(actions);
  let normalizedStart = 0;
  if (input.cursor !== undefined && input.cursor !== null) {
    const cursor = parseCursor(input.cursor);
    if (
      cursor.fromContentHash !== input.from.contentHash ||
      cursor.toContentHash !== input.to.contentHash ||
      cursor.corpusHash !== corpusHash
    ) {
      throw invalidCursor("The simulation cursor does not match these snapshots and actions.");
    }
    const previousIndex = actions.findIndex(
      (action) => action.actionId === cursor.lastActionId,
    );
    if (previousIndex < 0) {
      throw invalidCursor("The simulation cursor action is absent from the corpus.");
    }
    normalizedStart = previousIndex + 1;
  }
  const selected = actions.slice(normalizedStart, normalizedStart + pageSize);
  const entries = selected.map((action) =>
    simulateAction(
      input.from,
      input.to,
      action,
      input.secretCorrelationToken,
    ),
  );
  const counts = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      entries.filter((entry) => entry.category === category).length,
    ]),
  ) as Record<PolicySimulationCategory, number>;
  const last = selected.at(-1);
  const more = normalizedStart + selected.length < actions.length;
  return Object.freeze({
    entries: Object.freeze(entries),
    counts: Object.freeze(counts),
    nextCursor: more && last !== undefined
      ? encodeCursor({
          schemaVersion: 1,
          fromContentHash: input.from.contentHash,
          toContentHash: input.to.contentHash,
          corpusHash,
          lastActionId: last.actionId,
        })
      : null,
  });
}

function simulateAction(
  from: PolicySnapshot,
  to: PolicySnapshot,
  action: NormalizedAction,
  token: string,
): PolicySimulationEntry {
  let oldDecision: PolicyDecision | null = null;
  let newDecision: PolicyDecision | null = null;
  let errorCode: string | null = null;
  try {
    oldDecision = evaluatePolicySnapshot(from, action, {
      secretCorrelationToken: token,
    });
    newDecision = evaluatePolicySnapshot(to, action, {
      secretCorrelationToken: token,
    });
  } catch (error: unknown) {
    errorCode = isDomainError(error) ? error.code : "unexpected_error";
  }
  const category = oldDecision === null || newDecision === null
    ? "evaluation_error"
    : classify(oldDecision, newDecision);
  return Object.freeze({
    actionId: action.actionId,
    category,
    fromEffect: oldDecision?.effect ?? null,
    toEffect: newDecision?.effect ?? null,
    fromWinningPolicyName: oldDecision?.winningPolicyName ?? null,
    toWinningPolicyName: newDecision?.winningPolicyName ?? null,
    errorCode,
  });
}

function classify(
  from: PolicyDecision,
  to: PolicyDecision,
): PolicySimulationCategory {
  if (from.effect === "require_approval" && to.effect === "allow") {
    return "approval_removed";
  }
  if (to.effect === "deny" && from.effect !== "deny") return "newly_denied";
  if (to.effect === "allow" && from.effect !== "allow") return "newly_allowed";
  if (to.effect === "require_approval" && from.effect !== "require_approval") {
    return "newly_approval_gated";
  }
  if (
    from.effect === to.effect &&
    (from.winningPolicyName !== to.winningPolicyName ||
      canonicalSha256Hex(from.trace) !== canonicalSha256Hex(to.trace))
  ) {
    return "same_effect_different_explanation";
  }
  return "unchanged";
}

export function policyEffectOrder(effect: PolicyEffect): number {
  return effect === "deny" ? 0 : effect === "require_approval" ? 1 : 2;
}

interface SimulationCursorPayload {
  readonly schemaVersion: 1;
  readonly fromContentHash: string;
  readonly toContentHash: string;
  readonly corpusHash: string;
  readonly lastActionId: string;
}

function encodeCursor(payload: SimulationCursorPayload): string {
  return Buffer.from(canonicalize(payload), "utf8").toString("base64url");
}

function parseCursor(value: string): SimulationCursorPayload {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw invalidCursor("A simulation cursor is empty or exceeds its byte bound.");
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      throw new TypeError("non-canonical encoding");
    }
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidCursor("A simulation cursor is not canonical base64url JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor("A simulation cursor payload is invalid.");
  }
  const cursor = parsed as Readonly<Record<string, unknown>>;
  const expected = [
    "schemaVersion",
    "fromContentHash",
    "toContentHash",
    "corpusHash",
    "lastActionId",
  ];
  if (
    Object.keys(cursor).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(cursor, key)) ||
    cursor["schemaVersion"] !== 1 ||
    !isSha256(cursor["fromContentHash"]) ||
    !isSha256(cursor["toContentHash"]) ||
    !isSha256(cursor["corpusHash"]) ||
    !ActionIdKind.is(cursor["lastActionId"])
  ) {
    throw invalidCursor("A simulation cursor payload has unknown or invalid fields.");
  }
  return Object.freeze({
    schemaVersion: 1,
    fromContentHash: cursor["fromContentHash"],
    toContentHash: cursor["toContentHash"],
    corpusHash: cursor["corpusHash"],
    lastActionId: cursor["lastActionId"],
  });
}

function isSha256(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 64 &&
    [...value].every(
      (character) =>
        (character >= "0" && character <= "9") ||
        (character >= "a" && character <= "f"),
    )
  );
}

function invalidCursor(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
