import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repositoryRoot, "packages");

const kernelPackages = new Set([
  "contracts",
  "event-store",
  "runtime",
  "runtime-host",
  "profile-registry",
  "schema-validation",
  "agent-driver",
  "model-provider",
  "policy-language",
  "policy-engine",
  "context-broker",
  "capability-gateway",
  "artifact-store",
  "approvals",
  "eval-engine",
  "json-rpc",
]);

const forbiddenKernelDependency =
  /^@guard\/(?:adapter-|bridge-|driver-(?!scripted$)|capability-(?!gateway$)|model-provider$|provider-|external-agent|worktree$|sandbox$|credentials$)/;

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

async function collectFiles(directory, predicate) {
  if (!(await pathExists(directory))) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath, predicate)));
    } else if (entry.isFile() && predicate(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

function importedSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) {
        specifiers.push(match[1]);
      }
    }
  }
  return specifiers;
}

test("every workspace package exposes only an explicit public entry point", async () => {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packageDirectories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(packageDirectories.length >= 1, "expected at least one package");

  for (const packageDirectory of packageDirectories) {
    const manifestPath = path.join(packagesRoot, packageDirectory, "package.json");
    if (!(await pathExists(manifestPath))) {
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(typeof manifest.name, "string", `${packageDirectory} needs a package name`);
    assert.equal(
      typeof manifest.exports,
      "object",
      `${manifest.name} must define an explicit exports map`
    );
    assert.deepEqual(
      Object.keys(manifest.exports),
      ["."],
      `${manifest.name} must not expose package internals`
    );
  }
});

test("source imports never reach into another package's src directory", async () => {
  const sourceFiles = await collectFiles(packagesRoot, (name) => name.endsWith(".ts"));
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    for (const specifier of importedSpecifiers(source)) {
      assert.equal(
        /(?:^|\/)src(?:\/|$)/.test(specifier),
        false,
        `${path.relative(repositoryRoot, sourceFile)} imports internal path ${specifier}`
      );
    }
  }
});

test("Ajv remains isolated behind the shared schema-validation boundary", async () => {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "schema-validation") {
      continue;
    }
    const manifestPath = path.join(packagesRoot, entry.name, "package.json");
    if (await pathExists(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        assert.equal(
          Object.hasOwn(manifest[field] ?? {}, "ajv"),
          false,
          `${manifest.name} must depend on @guard/schema-validation instead of Ajv`
        );
      }
    }

    const sourceFiles = await collectFiles(
      path.join(packagesRoot, entry.name, "src"),
      (name) => name.endsWith(".ts")
    );
    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");
      assert.equal(
        importedSpecifiers(source).includes("ajv"),
        false,
        `${path.relative(repositoryRoot, sourceFile)} bypasses @guard/schema-validation`
      );
    }
  }
});

test("kernel dependency closures cannot reach capability packs or effect adapters", async () => {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const manifestsByName = new Map();
  const namesByDirectory = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(packagesRoot, entry.name, "package.json");
    if (!(await pathExists(manifestPath))) {
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifestsByName.set(manifest.name, manifest);
    namesByDirectory.set(entry.name, manifest.name);
  }

  for (const packageDirectory of kernelPackages) {
    const rootName = namesByDirectory.get(packageDirectory);
    if (rootName === undefined) {
      continue;
    }
    const queue = [{ name: rootName, chain: [rootName] }];
    const visited = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current.name)) {
        continue;
      }
      visited.add(current.name);
      const manifest = manifestsByName.get(current.name);
      if (manifest === undefined) {
        continue;
      }
      const dependencyNames = Object.keys({
        ...(manifest.dependencies ?? {}),
        ...(manifest.devDependencies ?? {}),
        ...(manifest.optionalDependencies ?? {}),
      });
      for (const dependencyName of dependencyNames) {
        const chain = [...current.chain, dependencyName];
        assert.equal(
          forbiddenKernelDependency.test(dependencyName),
          false,
          `${rootName} reaches forbidden adapter through ${chain.join(" -> ")}`
        );
        if (packageDirectory === "runtime") {
          assert.notEqual(
            dependencyName,
            "@guard/model-provider",
            `the runtime must call AgentDriver, but reaches a model provider through ${chain.join(" -> ")}`
          );
        }
        if (manifestsByName.has(dependencyName)) {
          queue.push({ name: dependencyName, chain });
        }
      }
    }
  }
});

test("generic runtime source contains no task, provider, protocol, or operation brands", async () => {
  const sourceFiles = (
    await Promise.all(
      ["runtime", "runtime-host"].map((directory) =>
        collectFiles(
          path.join(packagesRoot, directory, "src"),
          (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
        )
      )
    )
  ).flat().sort();
  for (const sourceFile of sourceFiles) {
    if (sourceFile.includes(`${path.sep}testdata${path.sep}`)) {
      continue;
    }
    const source = await readFile(sourceFile, "utf8");
    const imports = importedSpecifiers(source);
    for (const specifier of imports) {
      assert.equal(
        /^@guard\/(?:capability-(?!gateway$)|adapter-|bridge-|model-provider|worktree|sandbox)/.test(specifier),
        false,
        `${path.relative(repositoryRoot, sourceFile)} violates the generic runtime boundary`
      );
    }
    const brandedTerm = source.match(
      /\b(?:openai|anthropic|gemini|ollama|acp|mcp|git|github|repository|worktree|patch|diff|citation|vscode|cursor)\b/iu
    );
    assert.equal(
      brandedTerm,
      null,
      `${path.relative(repositoryRoot, sourceFile)} contains task or adapter brand ${brandedTerm?.[0] ?? "unknown"}`
    );
    assert.doesNotMatch(
      source,
      /(?:repo:|["'`](?:synthetic|coding|documents|repository)\.)/u,
      `${path.relative(repositoryRoot, sourceFile)} switches on a scheme or operation identifier`
    );
  }
});

test("the generic context broker contains no coding-source vocabulary or dependencies", async () => {
  const sourceFiles = await collectFiles(
    path.join(packagesRoot, "context-broker", "src"),
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
  );
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    for (const specifier of importedSpecifiers(source)) {
      assert.doesNotMatch(
        specifier,
        /^@guard\/capability-/,
        `${path.relative(repositoryRoot, sourceFile)} imports a coding capability package`
      );
    }
    assert.doesNotMatch(
      source,
      /\b(?:repo|repository|git|worktree|branch|path|patch|diff)\b/iu,
      `${path.relative(repositoryRoot, sourceFile)} contains coding-source vocabulary`
    );
  }
});

test("the CLI remains an event client rather than an enforcement boundary", async () => {
  const cliSourceRoot = path.join(repositoryRoot, "apps", "cli", "src");
  const sourceFiles = await collectFiles(
    cliSourceRoot,
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
  );
  if (sourceFiles.length === 0) {
    return;
  }

  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    for (const specifier of importedSpecifiers(source)) {
      assert.doesNotMatch(
        specifier,
        /^@guard\/(?:runtime(?:-host)?|context-broker|capability-)/,
        `${path.relative(repositoryRoot, sourceFile)} imports enforcement package ${specifier}`
      );
    }
  }
});
