import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  orderWorkspaceManifests,
  readWorkspaceManifests,
} from "./workspace-graph.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Workspace command terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const [scriptName, ...unexpectedArguments] = process.argv.slice(2);
  if (!scriptName || unexpectedArguments.length > 0) {
    throw new Error(
      "Usage: node scripts/run-workspace-script.mjs <script-name>",
    );
  }

  const workspaces = orderWorkspaceManifests(
    await readWorkspaceManifests(repositoryRoot),
  );
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

  for (const workspace of workspaces) {
    if (typeof workspace.manifest.scripts?.[scriptName] !== "string") {
      continue;
    }

    process.stdout.write(
      `\n[workspace-order] ${workspace.manifest.name}: ${scriptName}\n`,
    );
    const exitCode = await run(npmExecutable, [
      "run",
      scriptName,
      "--workspace",
      workspace.manifest.name,
    ]);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      return;
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[workspace-order] ${message}\n`);
  process.exitCode = 1;
});
