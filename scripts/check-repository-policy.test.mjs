import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const reviewedExternalDependencies = new Set([
  "@types/node",
  "ajv",
  "typescript",
  "uuid",
]);

const secretDetectors = [
  ["private-key material", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ["AWS access-key identifier", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["Stripe secret key", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
];

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function trackedFiles() {
  const { stdout } = await execFile("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean).sort();
}

async function workspaceManifestPaths() {
  const manifests = ["package.json"];
  for (const workspaceRoot of ["apps", "packages"]) {
    const absoluteRoot = path.join(repositoryRoot, workspaceRoot);
    if (!(await pathExists(absoluteRoot))) {
      continue;
    }
    const entries = await readdir(absoluteRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const relativeManifest = path.join(workspaceRoot, entry.name, "package.json");
      if (await pathExists(path.join(repositoryRoot, relativeManifest))) {
        manifests.push(relativeManifest);
      }
    }
  }
  return manifests.sort();
}

function isExactRegistryVersion(specifier) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
    specifier
  );
}

test("tracked files exclude local secrets and generated state", async () => {
  const files = await trackedFiles();
  assert.ok(files.length >= 20, "repository file inventory is unexpectedly small");

  const violations = files.filter((file) => {
    const basename = path.basename(file);
    if (basename === ".env.example") {
      return false;
    }
    return (
      /(?:^|\/)(?:node_modules|dist|coverage|artifacts|runs|postgres-data)(?:\/|$)/.test(file) ||
      basename === ".DS_Store" ||
      basename.endsWith(".tsbuildinfo") ||
      /^\.env(?:\.|$)/.test(basename) ||
      /\.(?:key|pem|p12|pfx)$/i.test(basename) ||
      /^(?:id_rsa|id_ed25519)$/i.test(basename)
    );
  });

  assert.deepEqual(violations, [], `forbidden tracked files: ${violations.join(", ")}`);
});

test("tracked text contains no high-confidence credential signatures", async () => {
  const files = await trackedFiles();
  const findings = [];

  for (const file of files) {
    const absolutePath = path.join(repositoryRoot, file);
    const metadata = await stat(absolutePath);
    if (metadata.size > 2 * 1024 * 1024) {
      continue;
    }
    const contents = await readFile(absolutePath);
    if (contents.includes(0)) {
      continue;
    }
    const textContents = contents.toString("utf8");
    for (const [name, detector] of secretDetectors) {
      if (detector.test(textContents)) {
        findings.push(`${file}: ${name}`);
      }
    }
  }

  assert.deepEqual(findings, [], `possible credentials detected:\n${findings.join("\n")}`);
});

test("tracked text files use stable line endings and whitespace", async () => {
  const files = await trackedFiles();
  const violations = [];
  for (const file of files) {
    const absolutePath = path.join(repositoryRoot, file);
    const metadata = await stat(absolutePath);
    if (metadata.size === 0 || metadata.size > 2 * 1024 * 1024) {
      continue;
    }
    const contents = await readFile(absolutePath);
    if (contents.includes(0)) {
      continue;
    }
    const textContents = contents.toString("utf8");
    if (textContents.includes("\r")) {
      violations.push(`${file}: CRLF or bare carriage return`);
    }
    if (/[ \t]+$/mu.test(textContents)) {
      violations.push(`${file}: trailing whitespace`);
    }
    if (!textContents.endsWith("\n")) {
      violations.push(`${file}: missing final newline`);
    }
  }
  assert.deepEqual(violations, [], `text-format violations:\n${violations.join("\n")}`);
});

test("workspace manifests use the repository license and exact dependency versions", async () => {
  const manifestPaths = await workspaceManifestPaths();
  const lockfile = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));

  assert.equal(lockfile.lockfileVersion, 3, "package-lock.json must use lockfile version 3");
  assert.equal(lockfile.name, "guarded-agent");

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, manifestPath), "utf8"));
    assert.equal(manifest.license, "MIT", `${manifestPath} must declare the MIT license`);
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${manifestPath} needs SemVer`);
    assert.equal(typeof manifest.exports === "object" || manifestPath === "package.json", true);

    for (const dependencyField of dependencyFields) {
      for (const [dependencyName, specifier] of Object.entries(manifest[dependencyField] ?? {})) {
        assert.equal(
          isExactRegistryVersion(specifier),
          true,
          `${manifestPath} ${dependencyField}.${dependencyName} must use an exact registry version`
        );
      }
    }

    const lockKey = manifestPath === "package.json" ? "" : path.dirname(manifestPath);
    const lockEntry = lockfile.packages?.[lockKey];
    assert.ok(lockEntry, `${manifestPath} is missing from package-lock.json`);
    for (const dependencyField of dependencyFields) {
      assert.deepEqual(
        lockEntry[dependencyField] ?? {},
        manifest[dependencyField] ?? {},
        `${manifestPath} and package-lock.json disagree for ${dependencyField}`
      );
    }
  }
});

test("direct dependencies stay inside the reviewed narrow allowlist", async () => {
  const manifestPaths = await workspaceManifestPaths();
  const violations = [];

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, manifestPath), "utf8")
    );
    for (const dependencyField of dependencyFields) {
      for (const dependencyName of Object.keys(manifest[dependencyField] ?? {})) {
        if (
          !dependencyName.startsWith("@guard/") &&
          !reviewedExternalDependencies.has(dependencyName)
        ) {
          violations.push(`${manifestPath} ${dependencyField}.${dependencyName}`);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `unreviewed direct dependencies:\n${violations.join("\n")}`
  );
});

test("continuous integration uses pinned actions and read-only default permissions", async () => {
  const workflowPath = path.join(repositoryRoot, ".github/workflows/ci.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.doesNotMatch(workflow, /\bpull_request_target\s*:/, "CI must not execute pull-request code with target privileges");
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /^\s+[A-Za-z-]+: write\s*$/m);

  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(uses.length >= 2, "CI should pin checkout and runtime setup actions");
  for (const action of uses) {
    if (action.startsWith("./")) {
      continue;
    }
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/, `workflow action must use a full commit SHA: ${action}`);
  }
});
