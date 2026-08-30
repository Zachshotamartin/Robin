import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const probePath = path.join(
  repositoryRoot,
  "scripts",
  "exercise-boundary-mutant.mjs",
);
const config = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "scripts", "boundary-mutation.config.json"),
    "utf8",
  ),
);
const ENVIRONMENT_CANARY_NAME = "GUARD_MUTATION_ENV_CANARY";
const FORBIDDEN_CHILD_ENVIRONMENT_NAME =
  /(?:TOKEN|SECRET|CREDENTIAL|PASSWORD|AUTH|COOKIE|SESSION|AGENT|SOCKET|(?:^|_)KEY(?:_|$))/iu;
const childEnvironment = createChildEnvironment(process.env);

const mutations = Object.freeze([
  mutation(
    "repository-allow-dot-segment",
    "packages/capability-repository",
    "repository-path.js",
    'const segments = value.split("/");',
    'const segments = value.split("/").filter((segment) => segment !== ".");',
    "repository-path",
    "repository-path.js",
  ),
  mutation(
    "repository-allow-traversal-segment",
    "packages/capability-repository",
    "repository-path.js",
    'const segments = value.split("/");',
    'const segments = value.split("/").map((segment) => segment === ".." ? "__parent__" : segment);',
    "repository-path",
    "repository-path.js",
  ),
  mutation(
    "repository-allow-backslash-separator",
    "packages/capability-repository",
    "repository-path.js",
    '/[<>:"|?*%\\\\]/u.test(value)',
    '/[<>:"|?*%]/u.test(value)',
    "repository-path",
    "repository-path.js",
  ),
  mutation(
    "repository-allow-percent-encoding",
    "packages/capability-repository",
    "repository-path.js",
    '/[<>:"|?*%\\\\]/u.test(value)',
    '/[<>:"|?*\\\\]/u.test(value)',
    "repository-path",
    "repository-path.js",
  ),
  mutation(
    "repository-skip-unicode-nfc",
    "packages/capability-repository",
    "repository-path.js",
    'segments.map((segment) => segment.normalize("NFC"))',
    "segments.map((segment) => segment)",
    "repository-path",
    "repository-path.js",
  ),
  mutation(
    "repository-allow-windows-reserved",
    "packages/capability-repository",
    "repository-path.js",
    "WINDOWS_RESERVED_SEGMENT.test(segment)",
    "false",
    "repository-path",
    "repository-path.js",
  ),
  mutation(
    "gateway-skip-input-schema",
    "packages/capability-gateway",
    "capability-gateway.js",
    'const structurallyValidInput = runCompiledValidation(operation.validateInput, input, "input");',
    "const structurallyValidInput = input;",
    "gateway-input",
  ),
  mutation(
    "gateway-skip-output-schema",
    "packages/capability-gateway",
    "capability-gateway.js",
    'const structurallyValidRaw = runCompiledValidation(provenance.operation.validateOutput, raw, "output");',
    "const structurallyValidRaw = raw;",
    "gateway-output",
  ),
  mutation(
    "gateway-wrong-action-hash",
    "packages/capability-gateway",
    "capability-gateway.js",
    "const actionHash = canonicalSha256Hex(action);",
    "const actionHash = canonicalSha256Hex(action.normalizedInput);",
    "gateway-identity",
  ),
  mutation(
    "gateway-policy-action-clone",
    "packages/capability-gateway",
    "capability-gateway.js",
    "untrustedDecision = this.#policyEvaluator.evaluate(provenance.action);",
    "untrustedDecision = this.#policyEvaluator.evaluate({ ...provenance.action });",
    "gateway-identity",
  ),
  mutation(
    "gateway-handler-action-clone",
    "packages/capability-gateway",
    "capability-gateway.js",
    "rawUnknown = await provenance.operation.execute(provenance.action, Object.freeze({ signal }));",
    "rawUnknown = await provenance.operation.execute({ ...provenance.action }, Object.freeze({ signal }));",
    "gateway-identity",
  ),
  mutation(
    "gateway-release-action-clone",
    "packages/capability-gateway",
    "capability-gateway.js",
    "released = await provenance.operation.release(structurallyValidRaw, provenance.action);",
    "released = await provenance.operation.release(structurallyValidRaw, { ...provenance.action });",
    "gateway-identity",
  ),
  mutation(
    "gateway-skip-prepared-identity-guard",
    "packages/capability-gateway",
    "capability-gateway.js",
    `    #preparedProvenance(prepared) {
        const provenance = this.#prepared.get(prepared);
        if (provenance === undefined ||
            prepared.action !== provenance.action ||
            prepared.actionHash !== provenance.actionHash ||
            canonicalSha256Hex(provenance.action) !== provenance.actionHash) {
            throw invariant("Policy evaluation requires this gateway's exact prepared action object.");
        }
        return provenance;
    }`,
    `    #preparedProvenance(prepared) {
        const provenance = this.#prepared.get(prepared);
        if (provenance === undefined) {
            throw invariant("Policy evaluation requires this gateway's exact prepared action object.");
        }
        return { ...provenance, action: { ...provenance.action } };
    }`,
    "gateway-identity",
  ),
  mutation(
    "runtime-skip-event-transition-guard",
    "packages/runtime",
    "kernel.js",
    `    const legalStates = EVENT_LEGAL_STATES[event.eventType];
    if (!legalStates.includes(state.status)) {`,
    `    const legalStates = EVENT_LEGAL_STATES[event.eventType];
    if (false && !legalStates.includes(state.status)) {`,
    "runtime-transition",
  ),
]);

validateConfig(config, mutations);

const buildStartedAt = performance.now();
const build = await runChild(
  process.execPath,
  [
    path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    "--build",
    "--force",
    "packages/capability-repository/tsconfig.json",
    "packages/capability-gateway/tsconfig.json",
    "packages/runtime/tsconfig.json",
  ],
  config.buildTimeoutMs,
);
if (build.timedOut || build.exitCode !== 0) {
  throw new Error(
    `boundary mutation prerequisite build failed${build.timedOut ? " by timeout" : ""}:\n${boundedOutput(build)}`,
  );
}
const buildDurationMs = Math.round(performance.now() - buildStartedAt);

const temporaryRoot = await mkdtemp(
  path.join(repositoryRoot, ".boundary-mutation-"),
);
assert.equal(path.dirname(temporaryRoot), repositoryRoot);
assert.match(path.basename(temporaryRoot), /^\.boundary-mutation-/u);

const results = [];
const baselineResults = [];
const suiteStartedAt = performance.now();
try {
  const baselines = new Map();
  for (const candidate of mutations) {
    const key = [candidate.packagePath, candidate.entrypoint, candidate.exercise].join("\0");
    baselines.set(key, candidate);
  }
  for (const candidate of baselines.values()) {
    const moduleUrl = pathToFileURL(
      path.join(
        repositoryRoot,
        candidate.packagePath,
        "dist",
        candidate.entrypoint,
      ),
    ).href;
    const baseline = await runExercise(candidate.exercise, moduleUrl);
    if (baseline.timedOut || baseline.exitCode !== 0) {
      throw new Error(
        `baseline exercise ${candidate.exercise} failed${baseline.timedOut ? " by timeout" : ""}:\n${boundedOutput(baseline)}`,
      );
    }
    baselineResults.push({
      exercise: candidate.exercise,
      durationMs: baseline.durationMs,
    });
  }

  for (const candidate of mutations) {
    const mutantRoot = path.join(temporaryRoot, candidate.id);
    const distRoot = path.join(
      repositoryRoot,
      candidate.packagePath,
      "dist",
    );
    await cp(distRoot, mutantRoot, { recursive: true });
    const target = path.join(mutantRoot, candidate.target);
    const source = await readFile(target, "utf8");
    const occurrences = countOccurrences(source, candidate.find);
    assert.equal(
      occurrences,
      1,
      `mutation ${candidate.id} expected one target, found ${occurrences}`,
    );
    await writeFile(
      target,
      source.replace(candidate.find, candidate.replace),
      "utf8",
    );

    const exercised = await runExercise(
      candidate.exercise,
      pathToFileURL(path.join(mutantRoot, candidate.entrypoint)).href,
    );
    const assertionKilled =
      exercised.exitCode === 86 &&
      `${exercised.stderr}\n${exercised.stdout}`.includes(
        "GUARD_BOUNDARY_MUTATION_KILLED:",
      );
    if (
      !exercised.timedOut &&
      exercised.exitCode !== 0 &&
      !assertionKilled
    ) {
      throw new Error(
        `mutation exercise ${candidate.id} failed outside its assertion oracle:\n${boundedOutput(exercised)}`,
      );
    }
    const killed = exercised.timedOut || assertionKilled;
    results.push({
      id: candidate.id,
      target: `${candidate.packagePath}/dist/${candidate.target}`,
      exercise: candidate.exercise,
      critical: candidate.critical,
      killed,
      timedOut: exercised.timedOut,
      durationMs: exercised.durationMs,
      failure: killed ? boundedOutput(exercised) : null,
    });
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

const killed = results.filter((result) => result.killed).length;
const scorePercent = results.length === 0 ? 0 : (killed * 100) / results.length;
const criticalSurvivors = results.filter(
  (result) => result.critical && !result.killed,
);
const report = {
  schemaVersion: 1,
  thresholdPercent: config.minimumScorePercent,
  scorePercent,
  killed,
  total: results.length,
  criticalSurvivors: criticalSurvivors.map((result) => result.id),
  equivalentMutants: config.equivalentMutants,
  timeoutTerminationScope:
    process.platform === "win32" ? "direct-child" : "process-group",
  buildDurationMs,
  mutationDurationMs: Math.round(performance.now() - suiteStartedAt),
  baselineResults,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (
  scorePercent < config.minimumScorePercent ||
  (config.requireZeroCriticalSurvivors && criticalSurvivors.length > 0)
) {
  process.exitCode = 1;
}

function mutation(
  id,
  packagePath,
  target,
  find,
  replace,
  exercise,
  entrypoint = "index.js",
) {
  return Object.freeze({
    id,
    packagePath,
    target,
    find,
    replace,
    exercise,
    entrypoint,
    critical: true,
  });
}

function validateConfig(value, candidates) {
  assert.deepEqual(Object.keys(value).sort(), [
    "buildTimeoutMs",
    "equivalentMutants",
    "minimumScorePercent",
    "perExerciseTimeoutMs",
    "requireZeroCriticalSurvivors",
    "requiredCriticalMutationIds",
    "schemaVersion",
    "scope",
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.minimumScorePercent, 100);
  assert.equal(value.requireZeroCriticalSurvivors, true);
  assert.deepEqual(value.equivalentMutants, []);
  assert.ok(
    Number.isSafeInteger(value.buildTimeoutMs) &&
      value.buildTimeoutMs > 0 &&
      value.buildTimeoutMs <= 300_000,
  );
  assert.ok(
    Number.isSafeInteger(value.perExerciseTimeoutMs) &&
      value.perExerciseTimeoutMs > 0 &&
      value.perExerciseTimeoutMs <= 30_000,
  );
  assert.deepEqual(
    value.requiredCriticalMutationIds,
    candidates.map((candidate) => candidate.id),
  );
  assert.equal(
    new Set(candidates.map((candidate) => candidate.id)).size,
    candidates.length,
  );
  assert.deepEqual(
    value.scope,
    [...new Set(candidates.map(
      (candidate) => `${candidate.packagePath}/dist/${candidate.target}`,
    ))],
  );
  for (const candidate of candidates) {
    assert.equal(candidate.critical, true);
    assert.match(candidate.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.ok(candidate.find.length > 0);
    assert.notEqual(candidate.find, candidate.replace);
    assert.equal(path.isAbsolute(candidate.packagePath), false);
    assert.equal(path.isAbsolute(candidate.target), false);
    assert.equal(path.isAbsolute(candidate.entrypoint), false);
    assert.equal(candidate.packagePath.split("/").includes(".."), false);
    assert.equal(candidate.target.split("/").includes(".."), false);
    assert.equal(candidate.entrypoint.split("/").includes(".."), false);
  }
}

function countOccurrences(source, target) {
  if (target.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = source.indexOf(target, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + target.length;
  }
}

function runExercise(exercise, moduleUrl) {
  return runChild(
    process.execPath,
    [probePath, exercise, moduleUrl],
    config.perExerciseTimeoutMs,
  );
}

function runChild(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const supportsProcessGroupTermination = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      detached: supportsProcessGroupTermination,
      env: childEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTimedOutChild(child, supportsProcessGroupTermination);
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  });
}

function createChildEnvironment(sourceEnvironment) {
  const seededSource = new Map(Object.entries(sourceEnvironment));
  seededSource.set(ENVIRONMENT_CANARY_NAME, "parent-only-secret-canary");
  const inheritedAllowlist = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "WINDIR",
  ];
  const environment = Object.create(null);
  for (const name of inheritedAllowlist) {
    const value = process.platform === "win32"
      ? [...seededSource].find(
        ([candidate]) => candidate.toUpperCase() === name.toUpperCase(),
      )?.[1]
      : seededSource.get(name);
    if (typeof value === "string") environment[name] = value;
  }
  Object.assign(environment, {
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    TZ: "UTC",
  });
  assert.equal(environment[ENVIRONMENT_CANARY_NAME], undefined);
  for (const name of Object.keys(environment)) {
    assert.doesNotMatch(name, FORBIDDEN_CHILD_ENVIRONMENT_NAME);
  }
  return Object.freeze(environment);
}

function terminateTimedOutChild(child, supportsProcessGroupTermination) {
  if (supportsProcessGroupTermination && child.pid !== undefined) {
    try {
      // A detached POSIX child leads a new process group, so its descendants
      // receive the same timeout signal. Node has no equivalent portable
      // Windows tree-kill API; Windows truthfully falls back to the direct child.
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process may have exited between the timeout and signal delivery.
    }
  }
  child.kill("SIGKILL");
}

function appendBounded(current, chunk) {
  const maximumCharacters = 64 * 1024;
  const combined = current + chunk;
  return combined.length <= maximumCharacters
    ? combined
    : combined.slice(combined.length - maximumCharacters);
}

function boundedOutput(result) {
  const lines = [];
  if (result.timedOut) lines.push("exercise exceeded its configured timeout");
  if (result.signal !== null) lines.push(`signal: ${result.signal}`);
  if (result.stderr.trim().length > 0) lines.push(result.stderr.trim());
  if (result.stdout.trim().length > 0) lines.push(result.stdout.trim());
  return lines.join("\n") || `exit code ${String(result.exitCode)}`;
}
