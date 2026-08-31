#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const gates = new Set([
  "R0",
  "R1",
  "R2",
  "R3",
  "R4",
  "R5",
  "R6",
  "R7",
  "R8",
  "R9",
  "R10",
  "R11",
  "R12",
]);
const allowedEnvironmentNames = Object.freeze([
  "platform",
  "arch",
  "node",
  "npm",
  "git",
  "commandIsolation",
]);
const durationReplayFactor = 4;
const durationReplaySlackMs = 1_000;
const hashPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const requirementPattern = /^(?:FR|NFR)-[A-Z0-9]+-\d{3}$/u;
const ticketPattern = /^R(?:[0-9]|1[0-2])\.\d{2}$/u;
const testIdPattern = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3}$/u;
const maximumTrackedAuditFileBytes = 64 * 1024 * 1024;
const maximumTrackedAuditAggregateBytes = 1024 * 1024 * 1024;
const maximumEvidenceControlFileBytes = 4 * 1024 * 1024;
const maximumEvidenceManifestFileBytes = 8 * 1024 * 1024;
const maximumCommandStreamBytesLimit = 64 * 1024 * 1024;
const maximumCommands = 100;
const maximumEvidenceItems = 1_000;
const controllerGitOperationTimeoutMs = 120_000;
const controllerToolVersionTimeoutMs = 30_000;
const exactManifestKeys = Object.freeze([
  "schemaVersion",
  "gate",
  "commit",
  "dirty",
  "robinVersion",
  "dependencyLockSha256",
  "environment",
  "commands",
  "requirements",
  "fixtures",
  "artifacts",
  "supportedClaims",
  "deferredClaims",
  "knownLimitations",
  "generatedAt",
]);
const exactConfigKeys = Object.freeze([
  "schemaVersion",
  "gate",
  "versionManifest",
  "cliVersionManifest",
  "dependencyLock",
  "traceability",
  "commands",
  "requirements",
  "fixtures",
  "artifacts",
  "supportedClaims",
  "deferredClaims",
  "knownLimitations",
]);

function evidenceError(message) {
  return new Error(`Gate evidence: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertCondition(condition, message) {
  if (!condition) throw evidenceError(message);
}

function assertExactKeys(value, expectedKeys, location) {
  assertCondition(isRecord(value), `${location} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  assertCondition(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${location} keys must be exactly ${expected.join(", ")}; received ${actual.join(", ")}`,
  );
}

function assertNonEmptyString(value, location, maximumLength = 2_000) {
  assertCondition(typeof value === "string", `${location} must be a string`);
  assertCondition(value.trim() === value, `${location} must not have surrounding whitespace`);
  assertCondition(value.length > 0, `${location} must not be empty`);
  assertCondition(
    value.length <= maximumLength,
    `${location} exceeds ${maximumLength} characters`,
  );
  assertCondition(!value.includes("\0"), `${location} must not contain NUL`);
}

function assertStringArray(
  value,
  location,
  { nonEmpty = false, unique = true, maximumItems = maximumEvidenceItems } = {},
) {
  assertCondition(Array.isArray(value), `${location} must be an array`);
  assertCondition(
    value.length <= maximumItems,
    `${location} exceeds ${maximumItems} items`,
  );
  if (nonEmpty) {
    assertCondition(value.length > 0, `${location} must not be empty`);
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    assertNonEmptyString(item, `${location}[${index}]`);
    if (unique) {
      assertCondition(!seen.has(item), `${location} contains duplicate value ${item}`);
    }
    seen.add(item);
  }
}

function assertArgumentArray(value, location) {
  assertCondition(Array.isArray(value), `${location} must be an array`);
  assertCondition(
    value.length <= maximumEvidenceItems,
    `${location} exceeds ${maximumEvidenceItems} arguments`,
  );
  for (const [index, argument] of value.entries()) {
    assertCondition(typeof argument === "string", `${location}[${index}] must be a string`);
    assertCondition(
      argument.length <= 8_192,
      `${location}[${index}] exceeds 8192 characters`,
    );
    assertCondition(!argument.includes("\0"), `${location}[${index}] must not contain NUL`);
  }
}

function assertIdentifier(value, location) {
  assertNonEmptyString(value, location, 100);
  assertCondition(idPattern.test(value), `${location} must be a lowercase kebab-case identifier`);
}

function assertGate(value, location) {
  assertCondition(gates.has(value), `${location} must be R0 through R12`);
}

function assertRelativePath(value, location) {
  assertNonEmptyString(value, location, 512);
  assertCondition(!path.posix.isAbsolute(value), `${location} must be repository-relative`);
  assertCondition(!value.includes("\\"), `${location} must use forward slashes`);
  assertCondition(
    path.posix.normalize(value) === value && value !== "." && !value.startsWith("../"),
    `${location} must be a normalized contained path`,
  );
}

function resolveContainedPath(repositoryRoot, relativePath, location) {
  assertRelativePath(relativePath, location);
  const resolved = path.resolve(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, resolved);
  assertCondition(
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `${location} escapes the repository`,
  );
  return resolved;
}

function validateRequirementEvidence(requirement, location, commandIds) {
  assertExactKeys(
    requirement,
    [
      "requirementId",
      "terminalGate",
      "status",
      "ticketIds",
      "testIds",
      "commandIds",
      "note",
    ],
    location,
  );
  assertCondition(
    requirementPattern.test(requirement.requirementId),
    `${location}.requirementId is not a normative requirement ID`,
  );
  assertGate(requirement.terminalGate, `${location}.terminalGate`);
  assertCondition(
    requirement.status === "partial" || requirement.status === "complete",
    `${location}.status must be partial or complete`,
  );
  assertCondition(
    requirement.status === "partial",
    `${location}.status complete is unsupported by evidence schema v1 until implemented-test registry proof is available`,
  );
  assertStringArray(requirement.ticketIds, `${location}.ticketIds`, { nonEmpty: true });
  for (const ticketId of requirement.ticketIds) {
    assertCondition(ticketPattern.test(ticketId), `${location} has invalid ticket ID ${ticketId}`);
  }
  assertStringArray(requirement.testIds, `${location}.testIds`, { nonEmpty: true });
  for (const testId of requirement.testIds) {
    assertCondition(testIdPattern.test(testId), `${location} has invalid test ID ${testId}`);
  }
  assertStringArray(requirement.commandIds, `${location}.commandIds`, { nonEmpty: true });
  for (const commandId of requirement.commandIds) {
    assertCondition(
      commandIds.has(commandId),
      `${location} references unknown command ${commandId}`,
    );
  }
  assertNonEmptyString(requirement.note, `${location}.note`);
}

function validateFileDescriptor(
  descriptor,
  location,
  { captured = false, fixture = false } = {},
) {
  const keys = fixture
    ? ["id", "path", "schemaVersion", ...(captured ? ["bytes", "sha256"] : [])]
    : ["id", "path", "mediaType", ...(captured ? ["bytes", "sha256"] : [])];
  assertExactKeys(descriptor, keys, location);
  assertIdentifier(descriptor.id, `${location}.id`);
  assertRelativePath(descriptor.path, `${location}.path`);
  if (fixture) {
    assertCondition(
      Number.isSafeInteger(descriptor.schemaVersion) && descriptor.schemaVersion >= 1,
      `${location}.schemaVersion must be a positive safe integer`,
    );
  } else {
    assertNonEmptyString(descriptor.mediaType, `${location}.mediaType`, 200);
    assertCondition(
      /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(descriptor.mediaType),
      `${location}.mediaType must be a lowercase media type`,
    );
  }
  if (captured) {
    assertCondition(
      Number.isSafeInteger(descriptor.bytes) && descriptor.bytes >= 0,
      `${location}.bytes must be a non-negative safe integer`,
    );
    assertCondition(
      descriptor.bytes <= maximumTrackedAuditFileBytes,
      `${location}.bytes exceeds the ${maximumTrackedAuditFileBytes}-byte artifact limit`,
    );
    assertCondition(hashPattern.test(descriptor.sha256), `${location}.sha256 must be SHA-256`);
  }
}

function validateLimitations(limitations, location) {
  assertCondition(Array.isArray(limitations), `${location} must be an array`);
  assertCondition(
    limitations.length <= maximumEvidenceItems,
    `${location} exceeds ${maximumEvidenceItems} items`,
  );
  const ids = new Set();
  for (const [index, limitation] of limitations.entries()) {
    const itemLocation = `${location}[${index}]`;
    assertExactKeys(limitation, ["id", "summary", "impact"], itemLocation);
    assertIdentifier(limitation.id, `${itemLocation}.id`);
    assertCondition(!ids.has(limitation.id), `${location} contains duplicate ID ${limitation.id}`);
    ids.add(limitation.id);
    assertNonEmptyString(limitation.summary, `${itemLocation}.summary`);
    assertNonEmptyString(limitation.impact, `${itemLocation}.impact`);
  }
}

function markdownTraceRow(document, requirementId, documentName) {
  const rows = document
    .split("\n")
    .filter((line) => line.startsWith("|") && line.includes(`\`${requirementId}\``));
  assertCondition(
    rows.length === 1,
    `${documentName} must contain exactly one traceability row for ${requirementId}; found ${rows.length}`,
  );
  return rows[0];
}

export function validateCaptureConfig(config, { buildPlan, operationsTestPlan }) {
  assertExactKeys(config, exactConfigKeys, "capture config");
  assertCondition(config.schemaVersion === 1, "capture config schemaVersion must be 1");
  assertGate(config.gate, "capture config gate");
  assertRelativePath(config.versionManifest, "capture config versionManifest");
  assertRelativePath(config.cliVersionManifest, "capture config cliVersionManifest");
  assertRelativePath(config.dependencyLock, "capture config dependencyLock");
  assertExactKeys(
    config.traceability,
    ["buildPlan", "operationsTestPlan"],
    "capture config traceability",
  );
  assertRelativePath(config.traceability.buildPlan, "capture config traceability.buildPlan");
  assertRelativePath(
    config.traceability.operationsTestPlan,
    "capture config traceability.operationsTestPlan",
  );
  assertCondition(typeof buildPlan === "string", "buildPlan traceability text is required");
  assertCondition(
    typeof operationsTestPlan === "string",
    "operationsTestPlan traceability text is required",
  );

  assertCondition(Array.isArray(config.commands), "capture config commands must be an array");
  assertCondition(config.commands.length > 0, "capture config commands must not be empty");
  assertCondition(
    config.commands.length <= maximumCommands,
    `capture config commands exceeds ${maximumCommands} items`,
  );
  const commandIds = new Set();
  for (const [index, command] of config.commands.entries()) {
    const location = `capture config commands[${index}]`;
    assertExactKeys(command, ["id", "executable", "args", "timeoutMs"], location);
    assertIdentifier(command.id, `${location}.id`);
    assertCondition(!commandIds.has(command.id), `capture config has duplicate command ${command.id}`);
    commandIds.add(command.id);
    assertNonEmptyString(command.executable, `${location}.executable`, 200);
    assertCondition(
      !command.executable.includes("/") && !command.executable.includes("\\"),
      `${location}.executable must resolve through PATH without embedding a host path`,
    );
    assertArgumentArray(command.args, `${location}.args`);
    assertCondition(
      Number.isSafeInteger(command.timeoutMs) &&
        command.timeoutMs >= 1_000 &&
        command.timeoutMs <= 3_600_000,
      `${location}.timeoutMs must be between 1000 and 3600000`,
    );
  }

  assertCondition(Array.isArray(config.requirements), "capture config requirements must be an array");
  assertCondition(
    config.requirements.length <= maximumEvidenceItems,
    `capture config requirements exceeds ${maximumEvidenceItems} items`,
  );
  const requirementIds = new Set();
  for (const [index, requirement] of config.requirements.entries()) {
    const location = `capture config requirements[${index}]`;
    validateRequirementEvidence(requirement, location, commandIds);
    assertCondition(
      !requirementIds.has(requirement.requirementId),
      `capture config has duplicate requirement ${requirement.requirementId}`,
    );
    requirementIds.add(requirement.requirementId);
    const buildRow = markdownTraceRow(buildPlan, requirement.requirementId, "BUILD_PLAN.md");
    const operationsRow = markdownTraceRow(
      operationsTestPlan,
      requirement.requirementId,
      "OPERATIONS_TEST_PLAN.md",
    );
    for (const ticketId of requirement.ticketIds) {
      assertCondition(
        buildRow.includes(ticketId),
        `${requirement.requirementId} ticket ${ticketId} is absent from its BUILD_PLAN.md traceability row`,
      );
    }
    assertCondition(
      operationsRow.includes(`| ${requirement.terminalGate} |`),
      `${requirement.requirementId} terminal gate ${requirement.terminalGate} is absent from its OPERATIONS_TEST_PLAN.md traceability row`,
    );
    for (const testId of requirement.testIds) {
      assertCondition(
        operationsRow.includes(testId),
        `${requirement.requirementId} test ${testId} is absent from its OPERATIONS_TEST_PLAN.md traceability row`,
      );
    }
    for (const commandId of requirement.commandIds) {
      assertCondition(
        operationsRow.includes(`\`${commandId}\``),
        `${requirement.requirementId} command ${commandId} is absent from its OPERATIONS_TEST_PLAN.md traceability row`,
      );
    }
    if (requirement.status === "complete") {
      assertCondition(
        config.gate === requirement.terminalGate,
        `${requirement.requirementId} cannot be complete at ${config.gate}; its terminal gate is ${requirement.terminalGate}`,
      );
    }
  }

  const descriptorPaths = new Set();
  for (const [field, fixture] of [
    ["fixtures", true],
    ["artifacts", false],
  ]) {
    assertCondition(Array.isArray(config[field]), `capture config ${field} must be an array`);
    assertCondition(
      config[field].length <= maximumEvidenceItems,
      `capture config ${field} exceeds ${maximumEvidenceItems} items`,
    );
    const ids = new Set();
    const paths = new Set();
    for (const [index, descriptor] of config[field].entries()) {
      validateFileDescriptor(descriptor, `capture config ${field}[${index}]`, {
        fixture,
      });
      assertCondition(!ids.has(descriptor.id), `capture config ${field} has duplicate ID ${descriptor.id}`);
      assertCondition(
        !paths.has(descriptor.path),
        `capture config ${field} has duplicate path ${descriptor.path}`,
      );
      assertCondition(
        !descriptorPaths.has(descriptor.path),
        `capture config descriptors repeat path ${descriptor.path} across fixture/artifact categories`,
      );
      ids.add(descriptor.id);
      paths.add(descriptor.path);
      descriptorPaths.add(descriptor.path);
    }
  }
  assertStringArray(config.supportedClaims, "capture config supportedClaims");
  assertStringArray(config.deferredClaims, "capture config deferredClaims", { nonEmpty: true });
  for (const claim of config.supportedClaims) {
    assertCondition(
      !config.deferredClaims.includes(claim),
      `capture config cannot both support and defer claim: ${claim}`,
    );
  }
  validateLimitations(config.knownLimitations, "capture config knownLimitations");
  return config;
}

function validateCommandResult(command, location) {
  assertExactKeys(
    command,
    [
      "id",
      "executable",
      "args",
      "display",
      "timeoutMs",
      "exitCode",
      "signal",
      "status",
      "observedDurationMs",
      "durationVerification",
      "stdout",
      "stderr",
      "summary",
    ],
    location,
  );
  assertIdentifier(command.id, `${location}.id`);
  assertNonEmptyString(command.executable, `${location}.executable`, 200);
  assertCondition(
    !command.executable.includes("/") && !command.executable.includes("\\"),
    `${location}.executable must resolve through PATH without embedding a host path`,
  );
  assertArgumentArray(command.args, `${location}.args`);
  assertCondition(
    command.display === JSON.stringify([command.executable, ...command.args]),
    `${location}.display must exactly encode executable and args`,
  );
  assertCondition(
    Number.isSafeInteger(command.timeoutMs) &&
      command.timeoutMs >= 1_000 &&
      command.timeoutMs <= 3_600_000,
    `${location}.timeoutMs must be between 1000 and 3600000`,
  );
  assertCondition(command.exitCode === 0, `${location}.exitCode must be 0 in acceptance evidence`);
  assertCondition(command.signal === null, `${location}.signal must be null in acceptance evidence`);
  assertCondition(command.status === "passed", `${location}.status must be passed`);
  assertCondition(
    Number.isSafeInteger(command.observedDurationMs) &&
      command.observedDurationMs >= 0 &&
      command.observedDurationMs <= command.timeoutMs,
    `${location}.observedDurationMs must be a non-negative safe integer no greater than timeoutMs`,
  );
  assertJsonEqual(
    command.durationVerification,
    {
      mode: "replay-envelope-v1",
      factor: durationReplayFactor,
      slackMs: durationReplaySlackMs,
    },
    `${location}.durationVerification must use the schema v1 replay envelope`,
  );
  for (const streamName of ["stdout", "stderr"]) {
    const stream = command[streamName];
    assertExactKeys(
      stream,
      ["observed", "replay"],
      `${location}.${streamName}`,
    );
    assertExactKeys(
      stream.observed,
      ["bytes", "sha256"],
      `${location}.${streamName}.observed`,
    );
    assertCondition(
      Number.isSafeInteger(stream.observed.bytes) &&
        stream.observed.bytes >= 0 &&
        stream.observed.bytes <= maximumCommandStreamBytesLimit,
      `${location}.${streamName}.observed.bytes must be between 0 and ${maximumCommandStreamBytesLimit}`,
    );
    assertCondition(
      hashPattern.test(stream.observed.sha256),
      `${location}.${streamName}.observed.sha256 must be SHA-256`,
    );
    assertExactKeys(
      stream.replay,
      ["normalization", "bytes", "sha256"],
      `${location}.${streamName}.replay`,
    );
    assertCondition(
      stream.replay.normalization === "ascii-digit-runs-v1",
      `${location}.${streamName}.replay.normalization must be ascii-digit-runs-v1`,
    );
    assertCondition(
      Number.isSafeInteger(stream.replay.bytes) &&
        stream.replay.bytes >= 0 &&
        stream.replay.bytes <= stream.observed.bytes,
      `${location}.${streamName}.replay.bytes must be between 0 and observed bytes`,
    );
    assertCondition(
      hashPattern.test(stream.replay.sha256),
      `${location}.${streamName}.replay.sha256 must be SHA-256`,
    );
  }
  const expectedSummary = `passed; observed duration=${command.observedDurationMs}ms; stdout=${command.stdout.observed.bytes} bytes; stderr=${command.stderr.observed.bytes} bytes`;
  assertCondition(command.summary === expectedSummary, `${location}.summary must be derived from the result`);
}

export function validateGateEvidenceManifest(manifest, { manifestPath } = {}) {
  assertExactKeys(manifest, exactManifestKeys, "manifest");
  assertCondition(manifest.schemaVersion === 1, "manifest schemaVersion must be 1");
  assertGate(manifest.gate, "manifest gate");
  assertCondition(commitPattern.test(manifest.commit), "manifest commit must be a Git object ID");
  assertCondition(manifest.dirty === false, "manifest dirty must be false");
  if (manifestPath !== undefined) {
    const normalizedManifestPath = manifestPath.replaceAll(path.sep, "/");
    assertCondition(
      normalizedManifestPath ===
        `evidence/manifests/${String(manifest.gate).toLowerCase()}.json`,
      `manifest path must be evidence/manifests/${String(manifest.gate).toLowerCase()}.json`,
    );
  }
  assertCondition(semverPattern.test(manifest.robinVersion), "manifest robinVersion must be SemVer");
  assertCondition(
    hashPattern.test(manifest.dependencyLockSha256),
    "manifest dependencyLockSha256 must be SHA-256",
  );

  assertCondition(Array.isArray(manifest.environment), "manifest environment must be an array");
  const environmentNames = new Set();
  for (const [index, entry] of manifest.environment.entries()) {
    const location = `manifest environment[${index}]`;
    assertExactKeys(entry, ["name", "value"], location);
    assertCondition(
      allowedEnvironmentNames.includes(entry.name),
      `environment name ${entry.name} is not in the redacted allowlist`,
    );
    assertCondition(!environmentNames.has(entry.name), `manifest environment repeats ${entry.name}`);
    environmentNames.add(entry.name);
    assertNonEmptyString(entry.value, `${location}.value`, 200);
  }
  assertCondition(
    allowedEnvironmentNames.every((name) => environmentNames.has(name)),
    `manifest environment must contain ${allowedEnvironmentNames.join(", ")}`,
  );
  const environmentByName = new Map(
    manifest.environment.map(({ name, value }) => [name, value]),
  );
  assertCondition(
    environmentByName.get("commandIsolation") ===
      commandIsolationModeForPlatform(environmentByName.get("platform")),
    "manifest commandIsolation is inconsistent with its platform",
  );

  assertCondition(Array.isArray(manifest.commands), "manifest commands must be an array");
  assertCondition(manifest.commands.length > 0, "manifest commands must not be empty");
  assertCondition(
    manifest.commands.length <= maximumCommands,
    `manifest commands exceeds ${maximumCommands} items`,
  );
  const commandIds = new Set();
  for (const [index, command] of manifest.commands.entries()) {
    validateCommandResult(command, `manifest commands[${index}]`);
    assertCondition(!commandIds.has(command.id), `manifest has duplicate command ${command.id}`);
    commandIds.add(command.id);
  }
  assertCondition(Array.isArray(manifest.requirements), "manifest requirements must be an array");
  assertCondition(
    manifest.requirements.length <= maximumEvidenceItems,
    `manifest requirements exceeds ${maximumEvidenceItems} items`,
  );
  const requirementIds = new Set();
  for (const [index, requirement] of manifest.requirements.entries()) {
    validateRequirementEvidence(requirement, `manifest requirements[${index}]`, commandIds);
    assertCondition(
      !requirementIds.has(requirement.requirementId),
      `manifest has duplicate requirement ${requirement.requirementId}`,
    );
    requirementIds.add(requirement.requirementId);
    if (requirement.status === "complete") {
      assertCondition(
        manifest.gate === requirement.terminalGate,
        `${requirement.requirementId} cannot be complete at ${manifest.gate}; its terminal gate is ${requirement.terminalGate}`,
      );
    }
  }

  const descriptorPaths = new Set();
  for (const [field, fixture] of [
    ["fixtures", true],
    ["artifacts", false],
  ]) {
    assertCondition(Array.isArray(manifest[field]), `manifest ${field} must be an array`);
    assertCondition(
      manifest[field].length <= maximumEvidenceItems,
      `manifest ${field} exceeds ${maximumEvidenceItems} items`,
    );
    const ids = new Set();
    const paths = new Set();
    for (const [index, descriptor] of manifest[field].entries()) {
      validateFileDescriptor(descriptor, `manifest ${field}[${index}]`, {
        captured: true,
        fixture,
      });
      assertCondition(!ids.has(descriptor.id), `manifest ${field} has duplicate ID ${descriptor.id}`);
      assertCondition(!paths.has(descriptor.path), `manifest ${field} has duplicate path ${descriptor.path}`);
      assertCondition(
        !descriptorPaths.has(descriptor.path),
        `manifest descriptors repeat path ${descriptor.path} across fixture/artifact categories`,
      );
      if (manifestPath !== undefined) {
        const normalizedManifestPath = manifestPath.replaceAll(path.sep, "/");
        assertCondition(
          descriptor.path !== normalizedManifestPath,
          `manifest ${field}[${index}] must not hash itself`,
        );
      }
      ids.add(descriptor.id);
      paths.add(descriptor.path);
      descriptorPaths.add(descriptor.path);
    }
  }
  assertStringArray(manifest.supportedClaims, "manifest supportedClaims");
  assertStringArray(manifest.deferredClaims, "manifest deferredClaims", { nonEmpty: true });
  for (const claim of manifest.supportedClaims) {
    assertCondition(
      !manifest.deferredClaims.includes(claim),
      `manifest cannot both support and defer claim: ${claim}`,
    );
  }
  validateLimitations(manifest.knownLimitations, "manifest knownLimitations");
  assertNonEmptyString(manifest.generatedAt, "manifest generatedAt", 100);
  const parsedGeneratedAt = new Date(manifest.generatedAt);
  assertCondition(
    !Number.isNaN(parsedGeneratedAt.valueOf()) &&
      parsedGeneratedAt.toISOString() === manifest.generatedAt,
    "manifest generatedAt must be a canonical UTC ISO timestamp",
  );
  return manifest;
}

function parseJson(text, location) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw evidenceError(`${location} is not valid JSON: ${error.message}`);
  }
  return parsed;
}

function hasErrorCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function inspectContainedComponents(
  repositoryRoot,
  relativePath,
  location,
) {
  const absolutePath = resolveContainedPath(repositoryRoot, relativePath, location);
  const relative = path.relative(repositoryRoot, absolutePath);
  const components = relative.split(path.sep).filter(Boolean);
  let currentPath = repositoryRoot;
  let metadata = await lstat(repositoryRoot);

  for (const [index, component] of components.entries()) {
    currentPath = path.join(currentPath, component);
    try {
      metadata = await lstat(currentPath);
    } catch (error) {
      throw evidenceError(`${location} is not readable: ${error.message}`);
    }
    assertCondition(
      !metadata.isSymbolicLink(),
      `${location} must not contain a symbolic-link path component`,
    );
    if (index < components.length - 1) {
      assertCondition(
        metadata.isDirectory(),
        `${location} has a non-directory parent component`,
      );
    }
  }
  return { absolutePath: currentPath, metadata };
}

async function resolveContainedRegularFile(repositoryRoot, relativePath, location) {
  const { absolutePath, metadata } = await inspectContainedComponents(
    repositoryRoot,
    relativePath,
    location,
  );
  assertCondition(metadata.isFile(), `${location} must name a regular file`);
  const physicalPath = await realpath(absolutePath);
  const relativePhysical = path.relative(repositoryRoot, physicalPath);
  assertCondition(
    relativePhysical !== ".." &&
      !relativePhysical.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePhysical),
    `${location} resolves outside the repository`,
  );
  return physicalPath;
}

async function ensureContainedDirectory(repositoryRoot, relativePath, location) {
  assertRelativePath(relativePath, location);
  const absolutePath = resolveContainedPath(repositoryRoot, relativePath, location);
  const relative = path.relative(repositoryRoot, absolutePath);
  const components = relative.split(path.sep).filter(Boolean);
  let currentPath = repositoryRoot;

  for (const component of components) {
    currentPath = path.join(currentPath, component);
    let metadata;
    try {
      metadata = await lstat(currentPath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw evidenceError(`${location} is not writable: ${error.message}`);
      }
      try {
        await mkdir(currentPath, { mode: 0o700 });
      } catch (mkdirError) {
        if (!hasErrorCode(mkdirError, "EEXIST")) throw mkdirError;
      }
      metadata = await lstat(currentPath);
    }
    assertCondition(
      !metadata.isSymbolicLink(),
      `${location} must not contain a symbolic-link path component`,
    );
    assertCondition(metadata.isDirectory(), `${location} must contain only directories`);
  }

  const physicalPath = await realpath(currentPath);
  const relativePhysical = path.relative(repositoryRoot, physicalPath);
  assertCondition(
    relativePhysical !== ".." &&
      !relativePhysical.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePhysical),
    `${location} resolves outside the repository`,
  );
  return physicalPath;
}

async function resolveContainedOutputFile(repositoryRoot, outputPath) {
  const relativeOutput = path
    .relative(repositoryRoot, outputPath)
    .replaceAll(path.sep, "/");
  const containedOutput = resolveContainedPath(
    repositoryRoot,
    relativeOutput,
    "output path",
  );
  const relativeParent = path
    .relative(repositoryRoot, path.dirname(containedOutput))
    .replaceAll(path.sep, "/");
  const physicalParent =
    relativeParent === ""
      ? repositoryRoot
      : await ensureContainedDirectory(
          repositoryRoot,
          relativeParent,
          "output parent",
        );
  const physicalOutput = path.join(physicalParent, path.basename(containedOutput));
  try {
    const metadata = await lstat(physicalOutput);
    assertCondition(
      !metadata.isSymbolicLink(),
      "output path must not be a symbolic link",
    );
    assertCondition(metadata.isFile(), "output path must name a regular file");
    return realpath(physicalOutput);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    return physicalOutput;
  }
}

async function readContainedText(
  repositoryRoot,
  relativePath,
  location,
  maximumBytes = maximumEvidenceControlFileBytes,
) {
  const physicalPath = await resolveContainedRegularFile(
    repositoryRoot,
    relativePath,
    location,
  );
  return (await readBoundedRegularFile(
    physicalPath,
    maximumBytes,
    location,
  )).toString("utf8");
}

async function readBoundedRegularFile(physicalPath, maximumBytes, location) {
  const pathMetadata = await lstat(physicalPath);
  assertCondition(
    pathMetadata.isFile() && !pathMetadata.isSymbolicLink(),
    `${location} must remain a non-symlink regular file before open`,
  );
  const handle = await open(
    physicalPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    assertCondition(before.isFile(), `${location} must remain a regular file`);
    assertCondition(
      before.dev === pathMetadata.dev && before.ino === pathMetadata.ino,
      `${location} changed identity while being opened`,
    );
    assertCondition(
      before.size <= maximumBytes,
      `${location} exceeds the ${maximumBytes}-byte read limit`,
    );
    const contents = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        contents.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assertCondition(
      offset === contents.length,
      `${location} changed size while being read`,
    );
    const overflowProbe = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(
      overflowProbe,
      0,
      1,
      null,
    );
    assertCondition(overflowBytes === 0, `${location} grew while being read`);
    const after = await handle.stat();
    assertCondition(
      after.dev === before.dev && after.ino === before.ino,
      `${location} changed identity while being read`,
    );
    assertCondition(
      after.size === before.size && after.mtimeMs === before.mtimeMs,
      `${location} changed while being read`,
    );
    return contents;
  } finally {
    await handle.close();
  }
}

async function readContainedJson(
  repositoryRoot,
  relativePath,
  location,
  maximumBytes = maximumEvidenceControlFileBytes,
) {
  return parseJson(
    await readContainedText(repositoryRoot, relativePath, location, maximumBytes),
    location,
  );
}

async function readAndValidateConfig(repositoryRoot, configPath) {
  const relativeConfig = path.relative(repositoryRoot, configPath).replaceAll(path.sep, "/");
  const config = await readContainedJson(
    repositoryRoot,
    relativeConfig,
    "capture config",
  );
  const [buildPlan, operationsTestPlan] = await Promise.all([
    readContainedText(
      repositoryRoot,
      config.traceability?.buildPlan,
      "capture config traceability.buildPlan",
    ),
    readContainedText(
      repositoryRoot,
      config.traceability?.operationsTestPlan,
      "capture config traceability.operationsTestPlan",
    ),
  ]);
  return validateCaptureConfig(config, { buildPlan, operationsTestPlan });
}

function createNormalizedStreamProof() {
  const hash = createHash("sha256");
  let insideAsciiDigits = false;
  let bytes = 0;
  return Object.freeze({
    update(chunk) {
      const normalized = Buffer.allocUnsafe(chunk.length);
      let length = 0;
      for (const byte of chunk) {
        if (byte >= 0x30 && byte <= 0x39) {
          if (!insideAsciiDigits) {
            normalized[length] = 0x23;
            length += 1;
            insideAsciiDigits = true;
          }
        } else {
          normalized[length] = byte;
          length += 1;
          insideAsciiDigits = false;
        }
      }
      const normalizedChunk = normalized.subarray(0, length);
      bytes += normalizedChunk.length;
      hash.update(normalizedChunk);
    },
    result() {
      return Object.freeze({
        normalization: "ascii-digit-runs-v1",
        bytes,
        sha256: hash.digest("hex"),
      });
    },
  });
}

function commandIsolationModeForPlatform(platform) {
  if (platform === "darwin") {
    return "macos-sandbox-exec-source-deny";
  }
  if (platform === "win32") {
    return "windows-direct-child-source-audit-unsupported";
  }
  return "posix-process-group-source-audit";
}

function commandIsolationMode() {
  return commandIsolationModeForPlatform(process.platform);
}

function assertEvidenceExecutionPlatform() {
  assertCondition(
    process.platform !== "win32",
    "evidence capture and replay are unsupported on Windows until descendant process-tree containment is implemented",
  );
}

export function evidenceTemporaryBaseForPlatform(platform, fallback) {
  return platform === "darwin" ? "/tmp" : fallback;
}

async function createEvidenceTemporaryRoot(prefix) {
  const base = evidenceTemporaryBaseForPlatform(process.platform, os.tmpdir());
  return realpath(await mkdtemp(path.join(base, prefix)));
}

function isolatedCommandInvocation(
  executable,
  args,
  sourceRepositoryRoot,
  executionRepositoryRoot,
) {
  if (process.platform !== "darwin") return { executable, args };
  assertCondition(
    typeof sourceRepositoryRoot === "string" && sourceRepositoryRoot.length > 0,
    "macOS command isolation requires the physical source repository root",
  );
  assertCondition(
    typeof executionRepositoryRoot === "string" &&
      executionRepositoryRoot.length > 0,
    "macOS command isolation requires the disposable repository root",
  );
  const profile = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath ${JSON.stringify(sourceRepositoryRoot)}))`,
    `(deny file-write* (subpath ${JSON.stringify(path.join(executionRepositoryRoot, ".git"))}))`,
  ].join("\n");
  return {
    executable: "/usr/bin/sandbox-exec",
    args: ["-p", profile, executable, ...args],
  };
}

async function runProcess(executable, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 30_000,
    sourceRepositoryRoot,
    maximumStreamBytes = maximumCommandStreamBytesLimit,
  } = options;
  assertCondition(
    Number.isSafeInteger(maximumStreamBytes) &&
      maximumStreamBytes > 0 &&
      maximumStreamBytes <= maximumCommandStreamBytesLimit,
    `command stream limit must be between 1 and ${maximumCommandStreamBytesLimit} bytes`,
  );
  const invocation = isolatedCommandInvocation(
    executable,
    args,
    sourceRepositoryRoot,
    cwd,
  );
  const started = process.hrtime.bigint();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  const stdoutProof = createNormalizedStreamProof();
  const stderrProof = createNormalizedStreamProof();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let didTimeout = false;
  let exceededStream = null;
  let childProcessId;
  let detachedProcessGroup = false;

  const result = await new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    detachedProcessGroup = detached;
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env,
      detached,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    childProcessId = child.pid;
    let forceKillTimer;
    let hardSettlementTimer;
    let settled = false;
    let outputTerminationRequested = false;
    function clearProcessTimers() {
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (hardSettlementTimer !== undefined) clearTimeout(hardSettlementTimer);
    }
    function settleResolve(value) {
      if (settled) return;
      settled = true;
      clearProcessTimers();
      resolve(value);
    }
    function settleReject(error) {
      if (settled) return;
      settled = true;
      clearProcessTimers();
      reject(error);
    }
    function scheduleHardSettlement(fallbackSignal, delayMs) {
      if (hardSettlementTimer !== undefined) return;
      hardSettlementTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settleResolve({
          exitCode: child.exitCode,
          signal: child.signalCode ?? fallbackSignal,
        });
      }, delayMs);
      hardSettlementTimer.unref();
    }
    function terminateForOutputLimit() {
      if (outputTerminationRequested) return;
      outputTerminationRequested = true;
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") settleReject(error);
        }
      } else {
        child.kill("SIGKILL");
      }
      scheduleHardSettlement("SIGKILL", 250);
    }
    function consumeStream(streamName, chunk, hash, proof, currentBytes) {
      if (exceededStream !== null) return currentBytes;
      if (chunk.length > maximumStreamBytes - currentBytes) {
        exceededStream = streamName;
        terminateForOutputLimit();
        return currentBytes + chunk.length;
      }
      hash.update(chunk);
      proof.update(chunk);
      return currentBytes + chunk.length;
    }
    const timeout = setTimeout(() => {
      didTimeout = true;
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (error?.code !== "ESRCH") settleReject(error);
        }
      } else {
        child.kill("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        if (detached && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error?.code !== "ESRCH") settleReject(error);
          }
        } else {
          child.kill("SIGKILL");
        }
      }, 2_000);
      forceKillTimer.unref();
      scheduleHardSettlement("SIGKILL", 2_250);
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk) => {
      stdoutBytes = consumeStream(
        "stdout",
        chunk,
        stdoutHash,
        stdoutProof,
        stdoutBytes,
      );
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = consumeStream(
        "stderr",
        chunk,
        stderrHash,
        stderrProof,
        stderrBytes,
      );
    });
    child.once("error", (error) => {
      settleReject(error);
    });
    child.once("close", (exitCode, signal) => {
      settleResolve({ exitCode, signal });
    });
  });

  const hadLingeringDescendants = await terminateLingeringProcessGroup(
    childProcessId,
    detachedProcessGroup,
  );

  const observedDurationMs = Number(
    (process.hrtime.bigint() - started) / 1_000_000n,
  );
  return {
    ...result,
    didTimeout,
    exceededStream,
    hadLingeringDescendants,
    observedDurationMs,
    stdout: {
      observed: {
        bytes: stdoutBytes,
        sha256: stdoutHash.digest("hex"),
      },
      replay: stdoutProof.result(),
    },
    stderr: {
      observed: {
        bytes: stderrBytes,
        sha256: stderrHash.digest("hex"),
      },
      replay: stderrProof.result(),
    },
  };
}

async function terminateLingeringProcessGroup(processId, detached) {
  if (!detached || processId === undefined) return false;
  if (!processGroupExists(processId)) return false;
  try {
    process.kill(-processId, "SIGTERM");
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (processGroupExists(processId)) {
    try {
      process.kill(-processId, "SIGKILL");
    } catch (error) {
      if (!hasErrorCode(error, "ESRCH")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function processGroupExists(processId) {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return false;
    if (hasErrorCode(error, "EPERM")) return true;
    throw error;
  }
}

async function gitOutput(repositoryRoot, args, env) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env,
        maxBuffer: 16 * 1024 * 1024,
        timeout: controllerGitOperationTimeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function prepareChildEnvironment(isolationRoot) {
  const configRoot = path.join(isolationRoot, "config");
  const cacheRoot = path.join(isolationRoot, "cache");
  const dataRoot = path.join(isolationRoot, "data");
  const stateRoot = path.join(isolationRoot, "state");
  const runtimeRoot = path.join(isolationRoot, "runtime");
  const temporaryRoot = path.join(isolationRoot, "tmp");
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cacheRoot, { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
    mkdir(temporaryRoot, { recursive: true }),
  ]);
  const npmUserConfig = path.join(configRoot, "npmrc");
  const gitGlobalConfig = path.join(configRoot, "gitconfig");
  await Promise.all([
    writeFile(npmUserConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 }),
    writeFile(gitGlobalConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 }),
  ]);
  const env = {
    CI: "1",
    GIT_CONFIG_GLOBAL: gitGlobalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    ROBIN_EVIDENCE_CAPTURE: "1",
    ROBIN_EVIDENCE_HOME: isolationRoot,
    TZ: "UTC",
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    XDG_CACHE_HOME: cacheRoot,
    XDG_CONFIG_HOME: configRoot,
    XDG_DATA_HOME: dataRoot,
    XDG_RUNTIME_DIR: runtimeRoot,
    XDG_STATE_HOME: stateRoot,
    npm_config_cache: path.join(cacheRoot, "npm"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: npmUserConfig,
  };
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

async function assertCleanGitWorktree(repositoryRoot, phase, childEnvironment) {
  const status = await gitOutput(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ], childEnvironment);
  assertCondition(
    status === "",
    phase === "before"
      ? "acceptance capture requires a clean Git worktree before commands"
      : "a gate command changed the tested worktree; acceptance evidence was not written",
  );
}

async function trackedCommitInventory(
  repositoryRoot,
  commit,
  childEnvironment,
) {
  const [listing, objectFormat] = await Promise.all([
    gitOutput(
      repositoryRoot,
      ["ls-tree", "-r", "-z", "--full-tree", commit],
      childEnvironment,
    ),
    gitOutput(
      repositoryRoot,
      ["rev-parse", "--show-object-format"],
      childEnvironment,
    ),
  ]);
  const algorithm = objectFormat.trim();
  assertCondition(
    algorithm === "sha1" || algorithm === "sha256",
    `unsupported Git object format ${algorithm}`,
  );
  const entries = listing
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(
        line,
      );
      assertCondition(
        match !== null,
        "tested commit must contain only regular tracked files",
      );
      const [, mode, objectId, relativePath] = match;
      assertRelativePath(relativePath, `tracked tree path ${relativePath}`);
      return Object.freeze({ mode, objectId, relativePath });
    });
  assertCondition(entries.length > 0, "tested commit contains no tracked files");
  return Object.freeze({ algorithm, entries: Object.freeze(entries) });
}

async function assertTrackedTreeMatchesCommit(repositoryRoot, inventory, phase) {
  let aggregateBytes = 0;
  for (const entry of inventory.entries) {
    const { absolutePath, metadata } = await inspectContainedComponents(
      repositoryRoot,
      entry.relativePath,
      `tracked tree audit ${entry.relativePath}`,
    );
    assertCondition(
      metadata.isFile(),
      `tracked tree audit ${entry.relativePath} must remain a regular file after ${phase}`,
    );
    assertCondition(
      metadata.size <= maximumTrackedAuditFileBytes,
      `tracked tree audit ${entry.relativePath} exceeds the per-file bound after ${phase}`,
    );
    aggregateBytes += metadata.size;
    assertCondition(
      aggregateBytes <= maximumTrackedAuditAggregateBytes,
      `tracked tree audit exceeds the aggregate bound after ${phase}`,
    );
    if (process.platform !== "win32") {
      const actualMode = (metadata.mode & 0o111) === 0 ? "100644" : "100755";
      assertCondition(
        actualMode === entry.mode,
        `tracked tree audit ${entry.relativePath} mode changed after ${phase}`,
      );
    }
    const contents = await readBoundedRegularFile(
      absolutePath,
      maximumTrackedAuditFileBytes,
      `tracked tree audit ${entry.relativePath}`,
    );
    assertCondition(
      contents.length === metadata.size,
      `tracked tree audit ${entry.relativePath} changed while reading after ${phase}`,
    );
    const header = Buffer.from(`blob ${contents.length}\0`, "utf8");
    const objectId = createHash(inventory.algorithm)
      .update(header)
      .update(contents)
      .digest("hex");
    assertCondition(
      objectId === entry.objectId,
      `tracked tree audit ${entry.relativePath} differs from ${phase}`,
    );
  }
}

async function assertInputsTrackedAtCommit(
  repositoryRoot,
  commit,
  inputPaths,
  childEnvironment,
) {
  for (const inputPath of [...new Set(inputPaths)]) {
    assertRelativePath(inputPath, `tracked input ${inputPath}`);
    const listing = await gitOutput(
      repositoryRoot,
      ["ls-tree", "-r", "--name-only", commit, "--", inputPath],
      childEnvironment,
    );
    assertCondition(
      listing.trim() === inputPath,
      `${inputPath} must be tracked at tested commit ${commit}`,
    );
  }
}

async function createExecutionCheckout(
  sourceRepositoryRoot,
  captureRoot,
  commit,
  childEnvironment,
) {
  const executionRoot = path.join(captureRoot, "checkout");
  await gitOutput(
    captureRoot,
    [
      "clone",
      "--quiet",
      "--local",
      "--no-hardlinks",
      "--no-checkout",
      sourceRepositoryRoot,
      executionRoot,
    ],
    childEnvironment,
  );
  await gitOutput(
    executionRoot,
    ["remote", "remove", "origin"],
    childEnvironment,
  );
  await gitOutput(
    executionRoot,
    ["config", "core.logAllRefUpdates", "false"],
    childEnvironment,
  );
  await gitOutput(
    executionRoot,
    ["checkout", "--quiet", "--detach", commit],
    childEnvironment,
  );
  await gitOutput(
    executionRoot,
    ["reflog", "expire", "--expire=now", "--all"],
    childEnvironment,
  );
  await rm(path.join(executionRoot, ".git", "logs"), {
    recursive: true,
    force: true,
  });
  const checkoutCommit = (
    await gitOutput(executionRoot, ["rev-parse", "HEAD"], childEnvironment)
  ).trim();
  assertCondition(
    checkoutCommit === commit,
    `disposable evidence checkout resolved ${checkoutCommit} instead of ${commit}`,
  );
  await assertCleanGitWorktree(executionRoot, "before", childEnvironment);
  return executionRoot;
}

async function hashContainedFile(repositoryRoot, descriptor, location) {
  const physicalPath = await resolveContainedRegularFile(
    repositoryRoot,
    descriptor.path,
    `${location}.path`,
  );
  const contents = await readBoundedRegularFile(
    physicalPath,
    maximumTrackedAuditFileBytes,
    location,
  );
  return {
    ...descriptor,
    bytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function hashEvidenceDescriptors(repositoryRoot, config) {
  const captured = { fixtures: [], artifacts: [] };
  let aggregateBytes = 0;
  for (const field of ["fixtures", "artifacts"]) {
    for (const [index, descriptor] of config[field].entries()) {
      const result = await hashContainedFile(
        repositoryRoot,
        descriptor,
        `${field}[${index}]`,
      );
      aggregateBytes += result.bytes;
      assertCondition(
        aggregateBytes <= maximumTrackedAuditAggregateBytes,
        `fixture/artifact aggregate exceeds the ${maximumTrackedAuditAggregateBytes}-byte evidence limit`,
      );
      captured[field].push(result);
    }
  }
  return captured;
}

function assertJsonEqual(actual, expected, message) {
  assertCondition(JSON.stringify(actual) === JSON.stringify(expected), message);
}

async function verifyManifestAgainstCheckout(
  repositoryRoot,
  config,
  manifest,
) {
  assertCondition(
    manifest.gate === config.gate,
    `manifest gate ${manifest.gate} differs from capture config gate ${config.gate}`,
  );
  const robinVersion = await readRobinVersion(repositoryRoot, config);
  assertCondition(
    manifest.robinVersion === robinVersion,
    "manifest Robin version differs from the tested commit",
  );
  const dependencyLock = await hashContainedFile(
    repositoryRoot,
    {
      id: "dependency-lock",
      path: config.dependencyLock,
      mediaType: "application/json",
    },
    "dependencyLock",
  );
  assertCondition(
    manifest.dependencyLockSha256 === dependencyLock.sha256,
    "manifest dependency lock hash differs from the tested commit",
  );

  const commandConfiguration = manifest.commands.map(
    ({ id, executable, args, timeoutMs }) => ({
      id,
      executable,
      args,
      timeoutMs,
    }),
  );
  assertJsonEqual(
    commandConfiguration,
    config.commands,
    "manifest commands differ from the tracked capture config",
  );
  assertJsonEqual(
    manifest.requirements,
    config.requirements,
    "manifest requirements differ from the tracked capture config",
  );
  assertJsonEqual(
    manifest.supportedClaims,
    config.supportedClaims,
    "manifest supported claims differ from the tracked capture config",
  );
  assertJsonEqual(
    manifest.deferredClaims,
    config.deferredClaims,
    "manifest deferred claims differ from the tracked capture config",
  );
  assertJsonEqual(
    manifest.knownLimitations,
    config.knownLimitations,
    "manifest known limitations differ from the tracked capture config",
  );

  const { fixtures, artifacts } = await hashEvidenceDescriptors(
    repositoryRoot,
    config,
  );
  assertJsonEqual(
    manifest.fixtures,
    fixtures,
    "manifest fixture descriptors or hashes differ from the tested commit",
  );
  assertJsonEqual(
    manifest.artifacts,
    artifacts,
    "manifest artifact descriptors or hashes differ from the tested commit",
  );
}

async function reexecuteManifestCommands(
  executionRoot,
  sourceRepositoryRoot,
  config,
  manifest,
  childEnvironment,
) {
  const environment = await captureEnvironment(executionRoot, childEnvironment);
  assertJsonEqual(
    manifest.environment,
    environment,
    "manifest environment differs from the verification environment",
  );
  const trackedInventory = await trackedCommitInventory(
    executionRoot,
    manifest.commit,
    childEnvironment,
  );
  await assertTrackedTreeMatchesCommit(
    executionRoot,
    trackedInventory,
    `tested commit before verification commands`,
  );
  for (const [index, command] of config.commands.entries()) {
    const result = await runProcess(command.executable, command.args, {
      cwd: executionRoot,
      env: childEnvironment,
      timeoutMs: command.timeoutMs,
      sourceRepositoryRoot,
    });
    assertCondition(
      !result.didTimeout,
      `verification command ${command.id} exceeded its ${command.timeoutMs}ms timeout`,
    );
    assertCondition(
      result.exceededStream === null,
      `verification command ${command.id} ${result.exceededStream ?? "output"} exceeded the ${maximumCommandStreamBytesLimit}-byte stream limit`,
    );
    assertCondition(
      !result.hadLingeringDescendants,
      `verification command ${command.id} left a descendant in its process group`,
    );
    assertCondition(
      result.exitCode === 0 && result.signal === null,
      `verification command ${command.id} did not pass`,
    );
    await assertTrackedTreeMatchesCommit(
      executionRoot,
      trackedInventory,
      `tested commit after verification command ${command.id}`,
    );
    await assertCleanGitWorktree(
      executionRoot,
      `after verification command ${command.id}`,
      childEnvironment,
    );
    const recorded = manifest.commands[index];
    const shorterDuration = Math.min(
      recorded.observedDurationMs,
      result.observedDurationMs,
    );
    const longerDuration = Math.max(
      recorded.observedDurationMs,
      result.observedDurationMs,
    );
    assertCondition(
      longerDuration <=
        shorterDuration * durationReplayFactor + durationReplaySlackMs,
      `manifest ${command.id} duration lies outside the v1 replay envelope`,
    );
    for (const streamName of ["stdout", "stderr"]) {
      assertJsonEqual(
        recorded[streamName],
        result[streamName],
        `manifest ${command.id} ${streamName} evidence differs from re-execution`,
      );
    }
  }
}

export async function verifyGateEvidenceManifest({
  repositoryRoot,
  manifest,
  manifestPath,
  configPath,
}) {
  assertEvidenceExecutionPlatform();
  const lexicalRoot = path.resolve(repositoryRoot);
  const resolvedRoot = await realpath(lexicalRoot);
  const relativeManifestPath = path
    .relative(lexicalRoot, path.resolve(manifestPath))
    .replaceAll(path.sep, "/");
  const relativeConfigPath = path
    .relative(lexicalRoot, path.resolve(configPath))
    .replaceAll(path.sep, "/");
  const persistedManifest = await readContainedJson(
    resolvedRoot,
    relativeManifestPath,
    "gate evidence manifest",
    maximumEvidenceManifestFileBytes,
  );
  assertJsonEqual(
    manifest,
    persistedManifest,
    "manifest value differs from the file being verified",
  );
  validateGateEvidenceManifest(manifest, {
    manifestPath: relativeManifestPath,
  });

  const verificationRoot = await createEvidenceTemporaryRoot(
    "robin-evidence-verify-",
  );
  try {
    const childEnvironment = await prepareChildEnvironment(verificationRoot);
    await assertInputsTrackedAtCommit(
      resolvedRoot,
      manifest.commit,
      [relativeConfigPath],
      childEnvironment,
    );
    const executionRoot = await createExecutionCheckout(
      resolvedRoot,
      verificationRoot,
      manifest.commit,
      childEnvironment,
    );
    const config = await readAndValidateConfig(
      executionRoot,
      resolveContainedPath(
        executionRoot,
        relativeConfigPath,
        "tracked capture config",
      ),
    );
    await assertInputsTrackedAtCommit(
      executionRoot,
      manifest.commit,
      [
        relativeConfigPath,
        config.versionManifest,
        config.cliVersionManifest,
        config.dependencyLock,
        config.traceability.buildPlan,
        config.traceability.operationsTestPlan,
        ...config.fixtures.map(({ path: fixturePath }) => fixturePath),
        ...config.artifacts.map(({ path: artifactPath }) => artifactPath),
      ],
      childEnvironment,
    );
    await verifyManifestAgainstCheckout(executionRoot, config, manifest);
    await reexecuteManifestCommands(
      executionRoot,
      resolvedRoot,
      config,
      manifest,
      childEnvironment,
    );
    await assertCleanGitWorktree(executionRoot, "after", childEnvironment);
    return manifest;
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
}

async function readRobinVersion(repositoryRoot, config) {
  const rootManifest = await readContainedJson(
    repositoryRoot,
    config.versionManifest,
    "Robin version manifest",
  );
  const cliManifest = await readContainedJson(
    repositoryRoot,
    config.cliVersionManifest,
    "Robin CLI version manifest",
  );
  assertCondition(
    semverPattern.test(rootManifest.version),
    `${config.versionManifest} version must be SemVer`,
  );
  assertCondition(
    rootManifest.version === cliManifest.version,
    `${config.versionManifest} and ${config.cliVersionManifest} versions must match`,
  );
  return rootManifest.version;
}

async function captureEnvironment(repositoryRoot, childEnvironment) {
  const [resolvedNodeRuntime, npmVersion, gitVersion] = await Promise.all([
    gitOrToolVersion(
      "node",
      [
        "--print",
        "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})",
      ],
      repositoryRoot,
      childEnvironment,
    ).then((value) => validateResolvedNodeRuntime(parseJson(value, "resolved PATH node runtime"))),
    gitOrToolVersion("npm", ["--version"], repositoryRoot, childEnvironment),
    gitOrToolVersion("git", ["--version"], repositoryRoot, childEnvironment),
  ]);
  return [
    { name: "platform", value: resolvedNodeRuntime.platform },
    { name: "arch", value: resolvedNodeRuntime.arch },
    { name: "node", value: resolvedNodeRuntime.version },
    { name: "npm", value: npmVersion },
    { name: "git", value: gitVersion },
    { name: "commandIsolation", value: commandIsolationMode() },
  ];
}

export function validateResolvedNodeRuntime(runtime) {
  assertExactKeys(runtime, ["version", "platform", "arch"], "resolved PATH node runtime");
  assertNonEmptyString(runtime.version, "resolved PATH node runtime.version", 100);
  assertNonEmptyString(runtime.platform, "resolved PATH node runtime.platform", 100);
  assertNonEmptyString(runtime.arch, "resolved PATH node runtime.arch", 100);
  assertCondition(
    runtime.version === process.version,
    `resolved PATH node version ${runtime.version} differs from evidence controller ${process.version}`,
  );
  assertCondition(
    runtime.platform === process.platform,
    `resolved PATH node platform ${runtime.platform} differs from evidence controller ${process.platform}`,
  );
  assertCondition(
    runtime.arch === process.arch,
    `resolved PATH node architecture ${runtime.arch} differs from evidence controller ${process.arch}`,
  );
  return runtime;
}

async function gitOrToolVersion(executable, args, repositoryRoot, env) {
  const { execFile } = await import("node:child_process");
  const output = await new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env,
        maxBuffer: 64 * 1024,
        timeout: controllerToolVersionTimeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
  const value = output.trim();
  assertNonEmptyString(value, `${executable} version`, 200);
  return value;
}

async function writeJsonAtomically(repositoryRoot, outputPath, manifest) {
  const containedOutput = await resolveContainedOutputFile(
    repositoryRoot,
    outputPath,
  );
  const physicalParent = path.dirname(containedOutput);
  const temporaryPath = path.join(
    physicalParent,
    `.${path.basename(containedOutput)}.${process.pid}.${Date.now()}.tmp`,
  );
  const serialized = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assertCondition(
    serialized.length <= maximumEvidenceManifestFileBytes,
    `generated manifest exceeds the ${maximumEvidenceManifestFileBytes}-byte manifest limit`,
  );
  try {
    await writeFile(temporaryPath, serialized, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, containedOutput);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function captureGateEvidence({
  repositoryRoot,
  configPath,
  outputPath,
  now = () => new Date(),
  maximumCommandStreamBytes = maximumCommandStreamBytesLimit,
}) {
  assertEvidenceExecutionPlatform();
  assertCondition(
    Number.isSafeInteger(maximumCommandStreamBytes) &&
      maximumCommandStreamBytes > 0 &&
      maximumCommandStreamBytes <= maximumCommandStreamBytesLimit,
    `maximumCommandStreamBytes must be between 1 and ${maximumCommandStreamBytesLimit}`,
  );
  const lexicalRoot = path.resolve(repositoryRoot);
  const resolvedRoot = await realpath(lexicalRoot);
  const configRelativePath = path
    .relative(lexicalRoot, path.resolve(configPath))
    .replaceAll(path.sep, "/");
  const outputRelativePath = path
    .relative(lexicalRoot, path.resolve(outputPath))
    .replaceAll(path.sep, "/");
  const resolvedConfigPath = resolveContainedPath(
    resolvedRoot,
    configRelativePath,
    "config path",
  );
  const resolvedOutputPath = resolveContainedPath(
    resolvedRoot,
    outputRelativePath,
    "output path",
  );
  const config = await readAndValidateConfig(resolvedRoot, resolvedConfigPath);
  const canonicalOutputRelativePath =
    `evidence/manifests/${config.gate.toLowerCase()}.json`;
  assertCondition(
    outputRelativePath === canonicalOutputRelativePath,
    `output path must be ${canonicalOutputRelativePath}`,
  );
  const physicalOutputPath = await resolveContainedOutputFile(
    resolvedRoot,
    resolvedOutputPath,
  );
  for (const [index, descriptor] of config.artifacts.entries()) {
    assertCondition(
      descriptor.path !== outputRelativePath,
      `capture config artifacts[${index}] must not hash the output manifest itself`,
    );
  }
  for (const [index, descriptor] of config.fixtures.entries()) {
    assertCondition(
      descriptor.path !== outputRelativePath,
      `capture config fixtures[${index}] must not hash the output manifest itself`,
    );
  }

  const captureRoot = await createEvidenceTemporaryRoot(
    "robin-evidence-capture-",
  );

  try {
    const childEnvironment = await prepareChildEnvironment(captureRoot);
    await assertCleanGitWorktree(resolvedRoot, "before", childEnvironment);
    const commit = (
      await gitOutput(resolvedRoot, ["rev-parse", "HEAD"], childEnvironment)
    ).trim();
    assertCondition(commitPattern.test(commit), "HEAD did not resolve to a Git object ID");
    const sourceTrackedInventory = await trackedCommitInventory(
      resolvedRoot,
      commit,
      childEnvironment,
    );
    await assertTrackedTreeMatchesCommit(
      resolvedRoot,
      sourceTrackedInventory,
      "source checkout before capture commands",
    );
    await assertInputsTrackedAtCommit(
      resolvedRoot,
      commit,
      [
        configRelativePath,
        config.versionManifest,
        config.cliVersionManifest,
        config.dependencyLock,
        config.traceability.buildPlan,
        config.traceability.operationsTestPlan,
        ...config.fixtures.map(({ path: fixturePath }) => fixturePath),
        ...config.artifacts.map(({ path: artifactPath }) => artifactPath),
      ],
      childEnvironment,
    );
    for (const [field, descriptors] of [
      ["fixtures", config.fixtures],
      ["artifacts", config.artifacts],
    ]) {
      for (const [index, descriptor] of descriptors.entries()) {
        const physicalDescriptor = await resolveContainedRegularFile(
          resolvedRoot,
          descriptor.path,
          `capture config ${field}[${index}].path`,
        );
        assertCondition(
          physicalDescriptor !== physicalOutputPath,
          `capture config ${field}[${index}] must not alias the output manifest`,
        );
      }
    }
    const executionRoot = await createExecutionCheckout(
      resolvedRoot,
      captureRoot,
      commit,
      childEnvironment,
    );
    const trackedInventory = await trackedCommitInventory(
      executionRoot,
      commit,
      childEnvironment,
    );
    await assertTrackedTreeMatchesCommit(
      executionRoot,
      trackedInventory,
      "tested commit before capture commands",
    );
    const executionConfigPath = resolveContainedPath(
      executionRoot,
      configRelativePath,
      "disposable capture config path",
    );
    const executionConfig = await readAndValidateConfig(
      executionRoot,
      executionConfigPath,
    );
    assertCondition(
      JSON.stringify(executionConfig) === JSON.stringify(config),
      "disposable checkout capture config differs from the tracked source config",
    );
    const robinVersion = await readRobinVersion(executionRoot, executionConfig);
    const dependencyLock = await hashContainedFile(
      executionRoot,
      {
        id: "dependency-lock",
        path: executionConfig.dependencyLock,
        mediaType: "application/json",
      },
      "dependencyLock",
    );
    const environment = await captureEnvironment(executionRoot, childEnvironment);
    const commands = [];
    for (const command of executionConfig.commands) {
      const result = await runProcess(command.executable, command.args, {
        cwd: executionRoot,
        env: childEnvironment,
        timeoutMs: command.timeoutMs,
        sourceRepositoryRoot: resolvedRoot,
        maximumStreamBytes: maximumCommandStreamBytes,
      });
      if (result.didTimeout) {
        throw evidenceError(`${command.id} exceeded its ${command.timeoutMs}ms timeout`);
      }
      if (result.exceededStream !== null) {
        throw evidenceError(
          `${command.id} ${result.exceededStream} exceeded the ${maximumCommandStreamBytes}-byte stream limit`,
        );
      }
      if (result.hadLingeringDescendants) {
        throw evidenceError(
          `${command.id} left a descendant in its process group after exit`,
        );
      }
      if (result.exitCode !== 0 || result.signal !== null) {
        throw evidenceError(
          `${command.id} exited with status ${result.exitCode ?? result.signal}`,
        );
      }
      await assertTrackedTreeMatchesCommit(
        executionRoot,
        trackedInventory,
        `tested commit after capture command ${command.id}`,
      );
      await assertCleanGitWorktree(
        executionRoot,
        `after capture command ${command.id}`,
        childEnvironment,
      );
      commands.push({
        id: command.id,
        executable: command.executable,
        args: command.args,
        display: JSON.stringify([command.executable, ...command.args]),
        timeoutMs: command.timeoutMs,
        exitCode: result.exitCode,
        signal: result.signal,
        status: "passed",
        observedDurationMs: result.observedDurationMs,
        durationVerification: {
          mode: "replay-envelope-v1",
          factor: durationReplayFactor,
          slackMs: durationReplaySlackMs,
        },
        stdout: result.stdout,
        stderr: result.stderr,
        summary: `passed; observed duration=${result.observedDurationMs}ms; stdout=${result.stdout.observed.bytes} bytes; stderr=${result.stderr.observed.bytes} bytes`,
      });
    }
    const endingCommit = (
      await gitOutput(executionRoot, ["rev-parse", "HEAD"], childEnvironment)
    ).trim();
    assertCondition(endingCommit === commit, "a gate command changed HEAD during capture");
    await assertCleanGitWorktree(executionRoot, "after", childEnvironment);
    const sourceEndingCommit = (
      await gitOutput(resolvedRoot, ["rev-parse", "HEAD"], childEnvironment)
    ).trim();
    assertCondition(
      sourceEndingCommit === commit,
      "the source checkout HEAD changed during capture",
    );
    await assertTrackedTreeMatchesCommit(
      resolvedRoot,
      sourceTrackedInventory,
      "source checkout after capture commands",
    );
    await assertCleanGitWorktree(resolvedRoot, "after", childEnvironment);

    const { fixtures, artifacts } = await hashEvidenceDescriptors(
      executionRoot,
      executionConfig,
    );
    const generatedAt = now().toISOString();
    const manifest = {
      schemaVersion: 1,
      gate: config.gate,
      commit,
      dirty: false,
      robinVersion,
      dependencyLockSha256: dependencyLock.sha256,
      environment,
      commands,
      requirements: executionConfig.requirements,
      fixtures,
      artifacts,
      supportedClaims: executionConfig.supportedClaims,
      deferredClaims: executionConfig.deferredClaims,
      knownLimitations: executionConfig.knownLimitations,
      generatedAt,
    };
    validateGateEvidenceManifest(manifest, {
      manifestPath: outputRelativePath,
    });
    await verifyManifestAgainstCheckout(
      executionRoot,
      executionConfig,
      manifest,
    );
    const sourcePrewriteCommit = (
      await gitOutput(resolvedRoot, ["rev-parse", "HEAD"], childEnvironment)
    ).trim();
    assertCondition(
      sourcePrewriteCommit === commit,
      "the source checkout HEAD changed before evidence write",
    );
    await assertTrackedTreeMatchesCommit(
      resolvedRoot,
      sourceTrackedInventory,
      "source checkout before evidence write",
    );
    await assertCleanGitWorktree(resolvedRoot, "after", childEnvironment);
    await writeJsonAtomically(resolvedRoot, resolvedOutputPath, manifest);
    return manifest;
  } finally {
    await rm(captureRoot, { recursive: true, force: true });
  }
}

function parseCliOptions(argv, requiredNames) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assertCondition(flag?.startsWith("--"), `expected an option at argument ${index + 1}`);
    assertCondition(value !== undefined, `${flag} requires a value`);
    const name = flag.slice(2);
    assertCondition(requiredNames.includes(name), `unknown option ${flag}`);
    assertCondition(result[name] === undefined, `duplicate option ${flag}`);
    result[name] = value;
  }
  for (const name of requiredNames) {
    assertCondition(result[name] !== undefined, `--${name} is required`);
  }
  return result;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "help" || command === undefined) {
    process.stdout.write(
      [
        "Robin gate evidence",
        "",
        "Usage:",
        "  node scripts/gate-evidence.mjs validate-config --config <path>",
        "  node scripts/gate-evidence.mjs capture --config <path> --output <path>",
        "  node scripts/gate-evidence.mjs validate --manifest <path>",
        "",
      ].join("\n"),
    );
    return;
  }
  if (command === "validate-config") {
    const options = parseCliOptions(rest, ["config"]);
    const configPath = path.resolve(defaultRepositoryRoot, options.config);
    const config = await readAndValidateConfig(defaultRepositoryRoot, configPath);
    process.stdout.write(`valid ${config.gate} capture config: ${options.config}\n`);
    return;
  }
  if (command === "capture") {
    const options = parseCliOptions(rest, ["config", "output"]);
    const manifest = await captureGateEvidence({
      repositoryRoot: defaultRepositoryRoot,
      configPath: path.resolve(defaultRepositoryRoot, options.config),
      outputPath: path.resolve(defaultRepositoryRoot, options.output),
    });
    process.stdout.write(
      `captured ${manifest.gate} evidence for ${manifest.commit} at ${options.output}\n`,
    );
    return;
  }
  if (command === "validate") {
    const options = parseCliOptions(rest, ["manifest"]);
    const manifestPath = path.resolve(defaultRepositoryRoot, options.manifest);
    const relativeManifestPath = path
      .relative(defaultRepositoryRoot, manifestPath)
      .replaceAll(path.sep, "/");
    resolveContainedPath(defaultRepositoryRoot, relativeManifestPath, "manifest path");
    const manifest = await readContainedJson(
      defaultRepositoryRoot,
      relativeManifestPath,
      "gate evidence manifest",
      maximumEvidenceManifestFileBytes,
    );
    await verifyGateEvidenceManifest({
      repositoryRoot: defaultRepositoryRoot,
      manifest,
      manifestPath,
      configPath: path.join(
        defaultRepositoryRoot,
        "evidence",
        "config",
        `${String(manifest.gate).toLowerCase()}.json`,
      ),
    });
    process.stdout.write(`valid ${manifest.gate} evidence manifest: ${options.manifest}\n`);
    return;
  }
  throw evidenceError(`unknown command ${command}`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
