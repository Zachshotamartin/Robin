import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const dependencyFields = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

export async function readWorkspaceManifests(repositoryRoot) {
  const manifests = [];

  for (const workspaceDirectory of ["apps", "packages"]) {
    const absoluteDirectory = path.join(repositoryRoot, workspaceDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const relativeDirectory = path.join(workspaceDirectory, entry.name);
      const manifestPath = path.join(
        repositoryRoot,
        relativeDirectory,
        "package.json",
      );

      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }

      manifests.push(
        Object.freeze({
          directory: relativeDirectory,
          manifest,
        }),
      );
    }
  }

  return manifests;
}

export function orderWorkspaceManifests(workspaces) {
  const workspacesByName = new Map();

  for (const workspace of workspaces) {
    const name = workspace.manifest?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        `Workspace ${workspace.directory ?? "<unknown>"} has no package name`,
      );
    }
    if (workspacesByName.has(name)) {
      throw new Error(`Duplicate workspace package name: ${name}`);
    }
    workspacesByName.set(name, workspace);
  }

  const dependenciesByName = new Map();
  const dependentsByName = new Map(
    [...workspacesByName.keys()].map((name) => [name, new Set()]),
  );

  for (const [name, workspace] of workspacesByName) {
    const dependencies = new Set();
    for (const field of dependencyFields) {
      const entries = workspace.manifest[field];
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        continue;
      }
      for (const dependencyName of Object.keys(entries)) {
        if (!workspacesByName.has(dependencyName)) continue;
        dependencies.add(dependencyName);
      }
    }
    dependenciesByName.set(name, dependencies);
    for (const dependencyName of dependencies) {
      dependentsByName.get(dependencyName).add(name);
    }
  }

  const remainingDependencyCounts = new Map(
    [...dependenciesByName].map(([name, dependencies]) => [
      name,
      dependencies.size,
    ]),
  );
  const ready = [...remainingDependencyCounts]
    .filter(([, count]) => count === 0)
    .map(([name]) => name)
    .sort();
  const orderedNames = [];

  while (ready.length > 0) {
    const name = ready.shift();
    orderedNames.push(name);

    for (const dependentName of [...dependentsByName.get(name)].sort()) {
      const nextCount = remainingDependencyCounts.get(dependentName) - 1;
      remainingDependencyCounts.set(dependentName, nextCount);
      if (nextCount === 0) {
        ready.push(dependentName);
        ready.sort();
      }
    }
  }

  if (orderedNames.length !== workspacesByName.size) {
    const cyclicNames = [...remainingDependencyCounts]
      .filter(([, count]) => count > 0)
      .map(([name]) => name)
      .sort();
    throw new Error(
      `Workspace dependency cycle detected: ${cyclicNames.join(", ")}`,
    );
  }

  return orderedNames.map((name) => workspacesByName.get(name));
}
