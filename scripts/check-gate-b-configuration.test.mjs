import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const requiredContractPackages = Object.freeze([
  "@guard/contracts",
  "@guard/schema-validation",
  "@guard/profile-registry",
  "@guard/event-store",
  "@guard/agent-driver",
  "@guard/model-provider",
  "@guard/policy-language",
  "@guard/policy-engine",
  "@guard/context-broker",
  "@guard/capability-gateway",
  "@guard/capability-synthetic",
  "@guard/capability-repository",
  "@guard/runtime",
  "@guard/runtime-host",
  "@guard/milestone-a-scenarios",
  "@guard/robin-agent",
  "@guard/robin-application",
  "@zachshotamartin/robin",
]);

const requiredBoundaryMutationIds = Object.freeze([
  "repository-allow-dot-segment",
  "repository-allow-traversal-segment",
  "repository-allow-backslash-separator",
  "repository-allow-percent-encoding",
  "repository-skip-unicode-nfc",
  "repository-allow-windows-reserved",
  "gateway-skip-input-schema",
  "gateway-skip-output-schema",
  "gateway-wrong-action-hash",
  "gateway-policy-action-clone",
  "gateway-handler-action-clone",
  "gateway-release-action-clone",
  "gateway-skip-prepared-identity-guard",
  "runtime-skip-event-transition-guard",
]);

async function rootManifest() {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
}

async function workspaceManifests() {
  const manifests = new Map();
  for (const workspaceDirectory of ["apps", "packages"]) {
    const absoluteDirectory = path.join(repositoryRoot, workspaceDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(absoluteDirectory, entry.name, "package.json");
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      manifests.set(manifest.name, manifest);
    }
  }
  return manifests;
}

function workflowJob(workflow, jobId) {
  const marker = `\n  ${jobId}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `CI is missing the ${jobId} job`);
  const bodyStart = start + marker.length;
  const nextJob = workflow.slice(bodyStart).search(/\n  [a-z0-9-]+:\n/u);
  return nextJob === -1
    ? workflow.slice(bodyStart)
    : workflow.slice(bodyStart, bodyStart + nextJob);
}

test("Gate B aggregation runs each bounded suite once and finishes with mutation", async () => {
  const manifest = await rootManifest();
  const scripts = manifest.scripts ?? {};
  assert.equal(scripts["test:contracts"], "npm run test:gate:b:contracts");
  assert.equal(
    scripts["test:mutation:boundaries"],
    "node scripts/run-boundary-mutation-tests.mjs",
  );
  assert.equal(
    scripts["test:mutation:gate:b"],
    "npm run test:mutation:boundaries && npm run test:mutation:policy",
  );
  assert.equal(
    scripts["test:gate:b"],
    "npm run test:repository && npm run test:gate:b:contracts && npm run test:eval:deterministic && npm run test:mutation:gate:b",
  );
  assert.equal(
    scripts["test:eval:deterministic"],
    "npm run test --workspace @guard/milestone-b-scenarios",
  );
  assert.equal(
    (scripts["test:mutation:gate:b"].match(/npm run test:mutation:boundaries/gu) ?? []).length,
    1,
  );
  assert.equal(
    (scripts["test:mutation:gate:b"].match(/npm run test:mutation:policy/gu) ?? []).length,
    1,
  );

  const contractCommand = scripts["test:gate:b:contracts"];
  assert.equal(typeof contractCommand, "string");
  assert.doesNotMatch(contractCommand, /\s--workspaces(?:\s|$)/u);
  assert.doesNotMatch(contractCommand, /npm run (?:check|test:unit|test:gate:[ab])\b/u);
  const selectedPackages = [...contractCommand.matchAll(/--workspace\s+([^\s]+)/gu)]
    .map((match) => match[1]);
  assert.deepEqual(selectedPackages, requiredContractPackages);

  const manifests = await workspaceManifests();
  for (const packageName of requiredContractPackages) {
    const workspace = manifests.get(packageName);
    assert.ok(workspace, `Gate B references missing workspace ${packageName}`);
    assert.match(
      workspace.scripts?.test ?? "",
      /^npm run build && /u,
      `${packageName} tests must build their exact package dependency graph first`,
    );
  }
  const evalWorkspace = manifests.get("@guard/milestone-b-scenarios");
  assert.ok(evalWorkspace, "Gate B references its missing deterministic-eval workspace");
  assert.match(
    evalWorkspace.scripts?.test ?? "",
    /^npm run build && /u,
    "deterministic evals must build their exact dependency graph first",
  );
});

test("boundary mutation configuration pins critical scope and argv-only isolation", async () => {
  const config = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "scripts", "boundary-mutation.config.json"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(config).sort(), [
    "buildTimeoutMs",
    "equivalentMutants",
    "minimumScorePercent",
    "perExerciseTimeoutMs",
    "requireZeroCriticalSurvivors",
    "requiredCriticalMutationIds",
    "schemaVersion",
    "scope",
  ]);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.minimumScorePercent, 100);
  assert.equal(config.requireZeroCriticalSurvivors, true);
  assert.deepEqual(config.equivalentMutants, []);
  assert.ok(Number.isSafeInteger(config.buildTimeoutMs));
  assert.ok(config.buildTimeoutMs > 0 && config.buildTimeoutMs <= 300_000);
  assert.ok(Number.isSafeInteger(config.perExerciseTimeoutMs));
  assert.ok(config.perExerciseTimeoutMs > 0 && config.perExerciseTimeoutMs <= 30_000);
  assert.deepEqual(config.requiredCriticalMutationIds, requiredBoundaryMutationIds);
  assert.deepEqual(config.scope, [
    "packages/capability-repository/dist/repository-path.js",
    "packages/capability-gateway/dist/capability-gateway.js",
    "packages/runtime/dist/kernel.js",
  ]);

  const runner = await readFile(
    path.join(repositoryRoot, "scripts", "run-boundary-mutation-tests.mjs"),
    "utf8",
  );
  assert.match(runner, /spawn\(/u);
  assert.match(runner, /shell:\s*false/u);
  assert.doesNotMatch(runner, /\bexec(?:File|Sync)?\s*\(/u);
  assert.doesNotMatch(runner, /env:\s*\{\s*\.\.\.process\.env/u);
  assert.match(runner, /const inheritedAllowlist = \[/u);
  assert.match(runner, /"typescript", "bin", "tsc"/u);
  assert.match(runner, /GUARD_MUTATION_ENV_CANARY/u);
  assert.match(runner, /process\.kill\(-child\.pid, "SIGKILL"\)/u);
  assert.match(runner, /mkdtemp\(/u);
  assert.match(runner, /await rm\(temporaryRoot, \{ recursive: true, force: true \}\)/u);
  for (const mutationId of requiredBoundaryMutationIds) {
    assert.match(runner, new RegExp(`\\b${mutationId}\\b`, "u"));
  }

  const probe = await readFile(
    path.join(repositoryRoot, "scripts", "exercise-boundary-mutant.mjs"),
    "utf8",
  );
  assert.match(probe, /process\.env\.GUARD_MUTATION_ENV_CANARY/u);
  assert.match(probe, /inherited forbidden environment field/u);
  assert.match(probe, /GUARD_BOUNDARY_MUTATION_KILLED/u);
  assert.match(runner, /failed outside its assertion oracle/u);
});

test("CI runs deterministic evals explicitly before the bounded Gate B mutation job", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const evalJob = workflowJob(workflow, "eval-deterministic");
  const gateJob = workflowJob(workflow, "gate-b");

  assert.match(evalJob, /^    needs: \[static, unit, contracts\]$/mu);
  assert.match(evalJob, /^    timeout-minutes: (?:[1-9]|[1-5]\d|60)$/mu);
  assert.match(evalJob, /^      - run: npm ci --ignore-scripts$/mu);
  assert.match(evalJob, /^      - run: npm run test:eval:deterministic$/mu);
  assert.doesNotMatch(evalJob, /npm run (?:check|test:unit|test:contracts|test:gate:b)\b/u);

  assert.match(gateJob, /^    needs: \[static, unit, contracts, eval-deterministic\]$/mu);
  assert.match(gateJob, /^    timeout-minutes: (?:[1-9]|[1-5]\d|60)$/mu);
  assert.match(gateJob, /^      - run: npm ci --ignore-scripts$/mu);
  assert.match(gateJob, /^      - run: npm run test:mutation:gate:b$/mu);
  assert.doesNotMatch(gateJob, /npm run test:mutation:(?:boundaries|policy)\b/u);
  assert.doesNotMatch(gateJob, /npm run (?:check|test:unit|test:contracts|test:gate:b)\b/u);

  for (const prerequisite of ["static", "unit", "contracts", "eval-deterministic"]) {
    assert.ok(
      workflow.indexOf(`\n  ${prerequisite}:\n`) <
        workflow.indexOf("\n  gate-b:\n"),
      `${prerequisite} must be declared before the Gate B merge job`,
    );
  }

  for (const [name, job] of [
    ["eval-deterministic", evalJob],
    ["gate-b", gateJob],
  ]) {
    const actions = [...job.matchAll(/^      - uses: ([^\s#]+)/gmu)]
      .map((match) => match[1]);
    assert.equal(actions.length, 2, `${name} must use exactly two pinned actions`);
    for (const action of actions) {
      assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/u);
    }
  }
});
