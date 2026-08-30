import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";

import {
  PolicyVersionIdKind,
  canonicalize,
  parseNormalizedAction,
  type JsonObject,
  type NormalizedAction,
} from "@guard/contracts";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshot,
  composePolicyAttributeCatalogs,
  createPolicyAttributeCatalog,
  createPolicySnapshotManifest,
  evaluatePolicySnapshot,
  parsePolicyCaseCorpus,
  runPolicyCaseCorpus,
  simulatePolicyPage,
  type PolicyAttributeCatalogSet,
  type PolicyCompileDiagnostic,
  type PolicyEffect,
  type PolicySnapshot,
} from "@guard/policy-engine";
import {
  formatGuardDocument,
  parseGuardDocument,
  type GuardDiagnostic,
} from "@guard/policy-language";

import type { PolicyCliRequest, PolicyOutputFormat } from "./argv.js";

export const POLICY_COMMAND_EXIT_CODES = Object.freeze({
  success: 0,
  invalidConfiguration: 2,
  testFailed: 6,
} as const);

export const MAXIMUM_POLICY_SOURCE_BYTES = 1_048_576;
export const MAXIMUM_POLICY_CATALOG_BYTES = 1_048_576;
export const MAXIMUM_POLICY_CORPUS_BYTES = 16_777_216;
export const MAXIMUM_POLICY_CATALOGS = 16;
export const MAXIMUM_SIMULATION_ACTIONS = 10_000;
export const MAXIMUM_POLICY_OUTPUT_BYTES = 16_777_216;

const PRIMARY_SOURCE_ID = "<cli-policy>";

export interface PolicyCommandResult {
  readonly exitCode: 0 | 2 | 6;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PolicyCommandDependencies {
  readonly readBoundedUtf8File: (path: string, maximumBytes: number) => Promise<string>;
  readonly createSecretCorrelationToken: () => string;
}

export const DEFAULT_POLICY_COMMAND_DEPENDENCIES: PolicyCommandDependencies =
  Object.freeze({
    readBoundedUtf8File,
    createSecretCorrelationToken: () =>
      `sec_${randomBytes(24).toString("base64url")}`,
  });

export async function executePolicyCommand(
  request: PolicyCliRequest,
  dependencies: PolicyCommandDependencies = DEFAULT_POLICY_COMMAND_DEPENDENCIES,
): Promise<PolicyCommandResult> {
  try {
    switch (request.kind) {
      case "policy-check":
        return await checkPolicy(request, dependencies);
      case "policy-format":
        return await formatPolicy(request, dependencies);
      case "policy-test":
        return await testPolicy(request, dependencies);
      case "policy-explain":
        return await explainPolicy(request, dependencies);
      case "policy-simulate":
        return await simulatePolicy(request, dependencies);
    }
  } catch (error: unknown) {
    return invalidResult(safeFailureMessage(error));
  }
}

async function checkPolicy(
  request: Extract<PolicyCliRequest, { readonly kind: "policy-check" }>,
  dependencies: PolicyCommandDependencies,
): Promise<PolicyCommandResult> {
  const catalogs = await loadCatalogs(request.catalogPaths, dependencies);
  const compiled = await compileFromFile(
    request.policyPath,
    PRIMARY_SOURCE_ID,
    request.defaultEffect,
    catalogs,
    dependencies,
  );
  if (!compiled.ok) {
    return compileFailure(compiled.diagnostics, request.format);
  }
  const payload = {
    schemaVersion: 1,
    ok: true,
    policy: createPolicySnapshotManifest(compiled.snapshot),
    policyCount: compiled.snapshot.policies.length,
  } as const;
  const output = request.format === "json"
    ? renderJson(payload)
    : boundedOutput(
        [
          "Policy is valid.",
          `Policy version: ${compiled.snapshot.policyVersionId}`,
          `Content hash: ${compiled.snapshot.contentHash}`,
          `Rules: ${String(compiled.snapshot.policies.length)}`,
          `Catalogs: ${String(compiled.snapshot.attributeCatalogs.manifest.length)}`,
          "",
        ].join("\n"),
      );
  return successResult(output);
}

async function formatPolicy(
  request: Extract<PolicyCliRequest, { readonly kind: "policy-format" }>,
  dependencies: PolicyCommandDependencies,
): Promise<PolicyCommandResult> {
  const source = await readInput(
    dependencies,
    request.policyPath,
    MAXIMUM_POLICY_SOURCE_BYTES,
  );
  const parsed = parseGuardDocument(source, { sourceId: PRIMARY_SOURCE_ID });
  if (!parsed.ok) {
    return languageFailure(parsed.diagnostics, request.format);
  }
  const canonicalText = formatGuardDocument(parsed.document);
  return successResult(
    request.format === "json"
      ? renderJson({ schemaVersion: 1, ok: true, canonicalText })
      : boundedOutput(canonicalText),
  );
}

async function testPolicy(
  request: Extract<PolicyCliRequest, { readonly kind: "policy-test" }>,
  dependencies: PolicyCommandDependencies,
): Promise<PolicyCommandResult> {
  const catalogs = await loadCatalogs(request.catalogPaths, dependencies);
  const compiled = await compileFromFile(
    request.policyPath,
    PRIMARY_SOURCE_ID,
    request.defaultEffect,
    catalogs,
    dependencies,
  );
  if (!compiled.ok) {
    return compileFailure(compiled.diagnostics, request.format);
  }
  const corpusText = await readInput(
    dependencies,
    request.casePath,
    MAXIMUM_POLICY_CORPUS_BYTES,
  );
  const corpus = parsePolicyCaseCorpus(parseJson(corpusText, "policy case corpus"), {
    maximumBytes: MAXIMUM_POLICY_CORPUS_BYTES,
    maximumCases: MAXIMUM_SIMULATION_ACTIONS,
  });
  const run = runPolicyCaseCorpus(
    compiled.snapshot,
    corpus,
    correlationToken(dependencies),
  );
  const payload = {
    schemaVersion: 1,
    ok: run.failed === 0,
    policyContentHash: compiled.snapshot.contentHash,
    passed: run.passed,
    failed: run.failed,
    cases: run.cases,
  } as const;
  const output = request.format === "json"
    ? renderJson(payload)
    : renderPolicyTestHuman(compiled.snapshot.contentHash, run);
  return Object.freeze({
    exitCode:
      run.failed === 0
        ? POLICY_COMMAND_EXIT_CODES.success
        : POLICY_COMMAND_EXIT_CODES.testFailed,
    stdout: output,
    stderr: "",
  });
}

async function explainPolicy(
  request: Extract<PolicyCliRequest, { readonly kind: "policy-explain" }>,
  dependencies: PolicyCommandDependencies,
): Promise<PolicyCommandResult> {
  const catalogs = await loadCatalogs(request.catalogPaths, dependencies);
  const compiled = await compileFromFile(
    request.policyPath,
    PRIMARY_SOURCE_ID,
    request.defaultEffect,
    catalogs,
    dependencies,
  );
  if (!compiled.ok) {
    return compileFailure(compiled.diagnostics, request.format);
  }
  const actionText = await readInput(
    dependencies,
    request.actionPath,
    MAXIMUM_POLICY_CORPUS_BYTES,
  );
  const action = parseNormalizedAction(parseJson(actionText, "normalized action"));
  const decision = evaluatePolicySnapshot(compiled.snapshot, action, {
    secretCorrelationToken: correlationToken(dependencies),
  });
  const safeTrace = redactCorrelationTokens(decision.trace);
  const payload = {
    schemaVersion: 1,
    policyVersionId: decision.policyVersionId,
    policyContentHash: compiled.snapshot.contentHash,
    actionId: action.actionId,
    effect: decision.effect,
    winningPolicyName: decision.winningPolicyName,
    reason: decision.reason,
    matchedPolicyNames: decision.matchedPolicyNames,
    trace: safeTrace,
  } as const;
  const output = request.format === "json"
    ? renderJson(payload)
    : boundedOutput(
        [
          `Action: ${action.actionId}`,
          `Effect: ${decision.effect}`,
          `Winner: ${decision.winningPolicyName ?? "<snapshot default>"}`,
          `Reason: ${decision.reason}`,
          "Trace:",
          JSON.stringify(safeTrace, null, 2),
          "",
        ].join("\n"),
      );
  return successResult(output);
}

async function simulatePolicy(
  request: Extract<PolicyCliRequest, { readonly kind: "policy-simulate" }>,
  dependencies: PolicyCommandDependencies,
): Promise<PolicyCommandResult> {
  const [fromCatalogs, toCatalogs] = await Promise.all([
    loadCatalogs(
      [...request.catalogPaths, ...request.fromCatalogPaths],
      dependencies,
    ),
    loadCatalogs(
      [...request.catalogPaths, ...request.toCatalogPaths],
      dependencies,
    ),
  ]);
  const [from, to, corpusText] = await Promise.all([
    compileFromFile(
      request.fromPolicyPath,
      PRIMARY_SOURCE_ID,
      request.fromDefaultEffect,
      fromCatalogs,
      dependencies,
    ),
    compileFromFile(
      request.toPolicyPath,
      PRIMARY_SOURCE_ID,
      request.toDefaultEffect,
      toCatalogs,
      dependencies,
    ),
    readInput(
      dependencies,
      request.actionCorpusPath,
      MAXIMUM_POLICY_CORPUS_BYTES,
    ),
  ]);
  if (!from.ok || !to.ok) {
    const diagnostics = [
      ...(from.ok ? [] : from.diagnostics),
      ...(to.ok ? [] : to.diagnostics),
    ];
    return compileFailure(diagnostics, request.format);
  }
  const actions = parseActionCorpus(parseJson(corpusText, "simulation action corpus"));
  const page = simulatePolicyPage({
    from: from.snapshot,
    to: to.snapshot,
    actions,
    secretCorrelationToken: correlationToken(dependencies),
    cursor: request.cursor,
    pageSize: request.pageSize,
  });
  const payload = {
    schemaVersion: 1,
    fromPolicyContentHash: from.snapshot.contentHash,
    toPolicyContentHash: to.snapshot.contentHash,
    ...page,
  } as const;
  const output = request.format === "json"
    ? renderJson(payload)
    : renderSimulationHuman(payload);
  return successResult(output);
}

async function loadCatalogs(
  paths: readonly string[],
  dependencies: PolicyCommandDependencies,
): Promise<PolicyAttributeCatalogSet> {
  if (paths.length > MAXIMUM_POLICY_CATALOGS) {
    throw new PolicyCommandInputError("Too many policy attribute catalogs were supplied.");
  }
  const texts = await Promise.all(
    paths.map((path) =>
      readInput(dependencies, path, MAXIMUM_POLICY_CATALOG_BYTES),
    ),
  );
  const catalogs = texts.map((text) =>
    createPolicyAttributeCatalog(parseJson(text, "policy attribute catalog")),
  );
  return composePolicyAttributeCatalogs([
    BASE_POLICY_ATTRIBUTE_CATALOG,
    ...catalogs,
  ]);
}

async function compileFromFile(
  path: string,
  sourceId: string,
  defaultEffect: PolicyEffect,
  catalogs: PolicyAttributeCatalogSet,
  dependencies: PolicyCommandDependencies,
) {
  const source = await readInput(
    dependencies,
    path,
    MAXIMUM_POLICY_SOURCE_BYTES,
  );
  return compilePolicySnapshot(
    {
      policyVersionId: PolicyVersionIdKind.generate(),
      source,
      sourceId,
      defaultEffect,
    },
    {},
    catalogs,
  );
}

function parseActionCorpus(value: unknown): readonly NormalizedAction[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2
  ) {
    throw new PolicyCommandInputError(
      "A simulation action corpus must be one versioned object.",
    );
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    candidate["schemaVersion"] !== 1 ||
    !Array.isArray(candidate["actions"]) ||
    candidate["actions"].length === 0 ||
    candidate["actions"].length > MAXIMUM_SIMULATION_ACTIONS ||
    Object.keys(candidate).some(
      (key) => key !== "schemaVersion" && key !== "actions",
    )
  ) {
    throw new PolicyCommandInputError(
      "A simulation action corpus has an invalid schema or action count.",
    );
  }
  return Object.freeze(candidate["actions"].map((action) => parseNormalizedAction(action)));
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PolicyCommandInputError(`The ${label} is not valid JSON.`);
  }
}

function correlationToken(dependencies: PolicyCommandDependencies): string {
  const token = dependencies.createSecretCorrelationToken();
  if (
    typeof token !== "string" ||
    token.length < 16 ||
    token.length > 256
  ) {
    throw new PolicyCommandInputError(
      "The policy correlation-token source returned an invalid value.",
    );
  }
  return token;
}

function redactCorrelationTokens(trace: JsonObject): JsonObject {
  const serialized = JSON.stringify(trace, (key, value: unknown) =>
    key === "correlationToken" ? "<redacted-per-run-token>" : value,
  );
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PolicyCommandInputError("The policy trace could not be rendered safely.");
  }
  return parsed as JsonObject;
}

function compileFailure(
  diagnostics: readonly PolicyCompileDiagnostic[],
  format: PolicyOutputFormat,
): PolicyCommandResult {
  const output = format === "json"
    ? renderJson({ schemaVersion: 1, ok: false, diagnostics })
    : renderDiagnosticsHuman(diagnostics);
  return Object.freeze({
    exitCode: POLICY_COMMAND_EXIT_CODES.invalidConfiguration,
    stdout: "",
    stderr: output,
  });
}

function languageFailure(
  diagnostics: readonly GuardDiagnostic[],
  format: PolicyOutputFormat,
): PolicyCommandResult {
  const output = format === "json"
    ? renderJson({ schemaVersion: 1, ok: false, diagnostics })
    : renderDiagnosticsHuman(diagnostics);
  return Object.freeze({
    exitCode: POLICY_COMMAND_EXIT_CODES.invalidConfiguration,
    stdout: "",
    stderr: output,
  });
}

function renderDiagnosticsHuman(
  diagnostics: readonly (PolicyCompileDiagnostic | GuardDiagnostic)[],
): string {
  const lines = diagnostics.map(
    (diagnostic) =>
      `${diagnostic.span.sourceId}:${String(diagnostic.span.start.line)}:${String(
        diagnostic.span.start.column,
      )} [${diagnostic.phase}/${diagnostic.code}] ${diagnostic.message}`,
  );
  return boundedOutput(
    `Policy is invalid (${String(diagnostics.length)} diagnostic${
      diagnostics.length === 1 ? "" : "s"
    }).\n${lines.join("\n")}\n`,
  );
}

function renderPolicyTestHuman(
  policyContentHash: string,
  run: ReturnType<typeof runPolicyCaseCorpus>,
): string {
  const failures = run.cases
    .filter((entry) => !entry.passed)
    .map(
      (entry) =>
        `FAIL ${entry.name}: expected ${entry.expectedEffect}/${
          entry.expectedWinningPolicyName ?? "<unspecified>"
        }, received ${entry.actualEffect ?? "<error>"}/${
          entry.actualWinningPolicyName ?? "<none>"
        }${entry.errorCode === null ? "" : ` (${entry.errorCode})`}`,
    );
  return boundedOutput(
    [
      `Policy content hash: ${policyContentHash}`,
      `Cases: ${String(run.passed + run.failed)}`,
      `Passed: ${String(run.passed)}`,
      `Failed: ${String(run.failed)}`,
      ...failures,
      "",
    ].join("\n"),
  );
}

function renderSimulationHuman(payload: {
  readonly fromPolicyContentHash: string;
  readonly toPolicyContentHash: string;
  readonly entries: readonly {
    readonly actionId: string;
    readonly category: string;
    readonly fromEffect: string | null;
    readonly toEffect: string | null;
    readonly fromWinningPolicyName: string | null;
    readonly toWinningPolicyName: string | null;
    readonly errorCode: string | null;
  }[];
  readonly counts: Readonly<Record<string, number>>;
  readonly nextCursor: string | null;
}): string {
  const counts = Object.entries(payload.counts)
    .map(([category, count]) => `${category}: ${String(count)}`)
    .join("\n");
  const entries = payload.entries.map(
    (entry) =>
      `${entry.actionId} ${entry.category}: ${entry.fromEffect ?? "<error>"} -> ${
        entry.toEffect ?? "<error>"
      } (${entry.fromWinningPolicyName ?? "<default>"} -> ${
        entry.toWinningPolicyName ?? "<default>"
      })${entry.errorCode === null ? "" : ` [${entry.errorCode}]`}`,
  );
  return boundedOutput(
    [
      `From: ${payload.fromPolicyContentHash}`,
      `To: ${payload.toPolicyContentHash}`,
      counts,
      ...entries,
      `Next cursor: ${payload.nextCursor ?? "<end>"}`,
      "",
    ].join("\n"),
  );
}

function renderJson(value: unknown): string {
  return boundedOutput(`${canonicalize(value)}\n`);
}

function boundedOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") > MAXIMUM_POLICY_OUTPUT_BYTES) {
    throw new PolicyCommandInputError(
      "The policy command output exceeds its configured byte limit.",
    );
  }
  return output;
}

function successResult(stdout: string): PolicyCommandResult {
  return Object.freeze({
    exitCode: POLICY_COMMAND_EXIT_CODES.success,
    stdout,
    stderr: "",
  });
}

function invalidResult(message: string): PolicyCommandResult {
  return Object.freeze({
    exitCode: POLICY_COMMAND_EXIT_CODES.invalidConfiguration,
    stdout: "",
    stderr: boundedOutput(`guard policy: ${message}\n`),
  });
}

async function readInput(
  dependencies: PolicyCommandDependencies,
  path: string,
  maximumBytes: number,
): Promise<string> {
  try {
    return await dependencies.readBoundedUtf8File(path, maximumBytes);
  } catch (error: unknown) {
    if (error instanceof PolicyCommandInputError) throw error;
    throw new PolicyCommandInputError("A required policy input file could not be read.");
  }
}

async function readBoundedUtf8File(
  path: string,
  maximumBytes: number,
): Promise<string> {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1
  ) {
    throw new PolicyCommandInputError("A policy input path or byte limit is invalid.");
  }
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size > BigInt(maximumBytes)) {
      throw new PolicyCommandInputError(
        "A policy input must be a bounded regular file.",
      );
    }
    const expectedBytes = Number(metadata.size);
    const bytes = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const result = await handle.read(bytes, offset, expectedBytes - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    const growth = await handle.read(extra, 0, 1, null);
    if (growth.bytesRead !== 0) {
      throw new PolicyCommandInputError(
        "A policy input changed while it was being read.",
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      throw new PolicyCommandInputError("A policy input is not valid UTF-8 text.");
    }
  } finally {
    await handle.close();
  }
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof PolicyCommandInputError || error instanceof TypeError) {
    const message = error.message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    if (message.length > 0 && Buffer.byteLength(message, "utf8") <= 1_024) {
      return message;
    }
  }
  return "The policy command failed before producing a validated result.";
}

class PolicyCommandInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PolicyCommandInputError";
  }
}
