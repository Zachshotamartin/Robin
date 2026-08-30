import {
  canonicalBytes,
  parseNormalizedAction,
  snapshotBoundaryJsonObject,
} from "@guard/contracts";

import type {
  PolicyCaseCorpus,
  PolicyEffect,
  PolicySnapshot,
  PolicyTestCase,
  PolicyTestRun,
} from "./types.js";
import { runPolicyTestCases } from "./simulation.js";

export interface PolicyCaseCorpusLimits {
  readonly maximumBytes?: number;
  readonly maximumCases?: number;
}

export function parsePolicyCaseCorpus(
  input: unknown,
  limits: PolicyCaseCorpusLimits = {},
): PolicyCaseCorpus {
  const detachedLimits = snapshotBoundaryJsonObject(limits);
  if (
    Object.keys(detachedLimits).some(
      (key) => key !== "maximumBytes" && key !== "maximumCases",
    )
  ) {
    throw new TypeError("Policy case corpus limits contain an unknown property.");
  }
  const maximumBytes = positive(detachedLimits["maximumBytes"], 4 * 1024 * 1024);
  const maximumCases = positive(detachedLimits["maximumCases"], 1000);
  const detached = snapshotBoundaryJsonObject(input);
  if (canonicalBytes(detached).byteLength > maximumBytes) {
    throw new TypeError("The policy case corpus exceeds its byte bound.");
  }
  if (!hasExactKeys(detached, ["schemaVersion", "policyContentHash", "cases"])) {
    throw new TypeError("A policy case corpus has unknown or missing properties.");
  }
  if (detached["schemaVersion"] !== 1 || !isSha256(detached["policyContentHash"])) {
    throw new TypeError("A policy case corpus has an unsupported version or hash.");
  }
  const rawCases = detached["cases"];
  if (!Array.isArray(rawCases) || rawCases.length === 0 || rawCases.length > maximumCases) {
    throw new TypeError("A policy case corpus has an invalid case count.");
  }
  const ids = new Set<string>();
  const cases: PolicyTestCase[] = rawCases.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new TypeError("A policy case must be an object.");
    }
    const value = candidate as Readonly<Record<string, unknown>>;
    const allowed = new Set([
      "schemaVersion",
      "caseId",
      "action",
      "expectedEffect",
      "expectedWinningPolicyName",
      "expectedReason",
      "expectedTraceHash",
    ]);
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      value["schemaVersion"] !== 1 ||
      typeof value["caseId"] !== "string" ||
      value["caseId"].trim().length === 0 ||
      ids.has(value["caseId"]) ||
      !isEffect(value["expectedEffect"])
    ) {
      throw new TypeError("A policy case has an invalid field or duplicate ID.");
    }
    const winner = value["expectedWinningPolicyName"];
    const reason = value["expectedReason"];
    const traceHash = value["expectedTraceHash"];
    if (
      !(winner === undefined || winner === null || typeof winner === "string") ||
      !(reason === undefined || (typeof reason === "string" && reason.length > 0)) ||
      !(traceHash === undefined || isSha256(traceHash))
    ) {
      throw new TypeError("A policy case expectation is invalid.");
    }
    ids.add(value["caseId"]);
    return Object.freeze({
      name: value["caseId"],
      action: parseNormalizedAction(value["action"]),
      expectedEffect: value["expectedEffect"],
      ...(winner === undefined ? {} : { expectedWinningPolicyName: winner }),
      ...(reason === undefined ? {} : { expectedReason: reason }),
      ...(traceHash === undefined ? {} : { expectedTraceHash: traceHash }),
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    policyContentHash: detached["policyContentHash"],
    cases: Object.freeze(cases),
  });
}

export function runPolicyCaseCorpus(
  snapshot: PolicySnapshot,
  corpus: PolicyCaseCorpus,
  secretCorrelationToken: string,
): PolicyTestRun {
  if (corpus.policyContentHash !== snapshot.contentHash) {
    throw new TypeError("The policy case corpus targets a different snapshot hash.");
  }
  return runPolicyTestCases(snapshot, corpus.cases, secretCorrelationToken);
}

function positive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("Policy case corpus limits must be positive safe integers.");
  }
  return value as number;
}

function isEffect(value: unknown): value is PolicyEffect {
  return value === "allow" || value === "deny" || value === "require_approval";
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

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
