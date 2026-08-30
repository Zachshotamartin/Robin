import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  orderWorkspaceManifests,
  readWorkspaceManifests,
} from "./workspace-graph.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function workspace(name, dependencies = {}) {
  return {
    directory: `packages/${name}`,
    manifest: { name, dependencies },
  };
}

test("repository workspaces are ordered after every internal dependency", async () => {
  const workspaces = await readWorkspaceManifests(repositoryRoot);
  const ordered = orderWorkspaceManifests(workspaces);
  const indexes = new Map(
    ordered.map((entry, index) => [entry.manifest.name, index]),
  );

  assert.equal(ordered.length, workspaces.length);
  for (const entry of ordered) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const dependencyName of Object.keys(entry.manifest[field] ?? {})) {
        if (!indexes.has(dependencyName)) continue;
        assert.ok(
          indexes.get(dependencyName) < indexes.get(entry.manifest.name),
          `${dependencyName} must run before ${entry.manifest.name}`,
        );
      }
    }
  }
});

test("TypeScript project references mirror internal production dependencies", async () => {
  const workspaces = await readWorkspaceManifests(repositoryRoot);
  const internalNames = new Set(
    workspaces.map((entry) => entry.manifest.name),
  );

  for (const entry of workspaces) {
    const tsconfigPath = path.join(
      repositoryRoot,
      entry.directory,
      "tsconfig.json",
    );
    const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8"));
    const referencedNames = [];
    for (const reference of tsconfig.references ?? []) {
      const referencedManifest = JSON.parse(
        await readFile(
          path.resolve(
            path.dirname(tsconfigPath),
            reference.path,
            "package.json",
          ),
          "utf8",
        ),
      );
      referencedNames.push(referencedManifest.name);
    }

    const dependencyNames = Object.keys(entry.manifest.dependencies ?? {})
      .filter((name) => internalNames.has(name))
      .sort();
    assert.deepEqual(
      referencedNames.sort(),
      dependencyNames,
      `${entry.manifest.name} project references must match internal dependencies`,
    );
  }
});

test("workspace ordering is deterministic when packages are independent", () => {
  const ordered = orderWorkspaceManifests([
    workspace("charlie"),
    workspace("alpha"),
    workspace("bravo"),
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.manifest.name),
    ["alpha", "bravo", "charlie"],
  );
});

test("workspace ordering rejects dependency cycles", () => {
  assert.throws(
    () =>
      orderWorkspaceManifests([
        workspace("alpha", { bravo: "0.0.0" }),
        workspace("bravo", { alpha: "0.0.0" }),
      ]),
    /Workspace dependency cycle detected: alpha, bravo/u,
  );
});

test("workspace ordering rejects duplicate package names", () => {
  assert.throws(
    () =>
      orderWorkspaceManifests([
        workspace("duplicate"),
        workspace("duplicate"),
      ]),
    /Duplicate workspace package name: duplicate/u,
  );
});
