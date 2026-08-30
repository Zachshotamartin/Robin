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
  "@guard/cli",
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
    scripts["test:gate:b"],
    "npm run test:repository && npm run test:gate:b:contracts && npm run test:mutation:policy",
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
});

test("CI makes policy mutation a bounded Gate B job after all prerequisite jobs", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const gateJob = workflowJob(workflow, "gate-b");

  assert.match(gateJob, /^    needs: \[static, unit, contracts\]$/mu);
  assert.match(gateJob, /^    timeout-minutes: (?:[1-9]|[1-5]\d|60)$/mu);
  assert.match(gateJob, /^      - run: npm ci --ignore-scripts$/mu);
  assert.match(gateJob, /^      - run: npm run test:mutation:policy$/mu);
  assert.doesNotMatch(gateJob, /npm run (?:check|test:unit|test:contracts|test:gate:b)\b/u);

  for (const prerequisite of ["static", "unit", "contracts"]) {
    assert.ok(
      workflow.indexOf(`\n  ${prerequisite}:\n`) <
        workflow.indexOf("\n  gate-b:\n"),
      `${prerequisite} must be declared before the Gate B merge job`,
    );
  }

  const actions = [...gateJob.matchAll(/^      - uses: ([^\s#]+)/gmu)]
    .map((match) => match[1]);
  assert.equal(actions.length, 2);
  for (const action of actions) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/u);
  }
});
