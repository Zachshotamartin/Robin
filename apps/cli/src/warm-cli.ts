import {
  runCodingVirtualRepositoryScenario,
  runSyntheticTransformScenario,
} from "@guard/milestone-a-scenarios";

import {
  type CliProfile,
  type CliRequest,
  type PolicyCliRequest,
} from "./argv.js";
import { EXIT_CODES } from "./exit-codes.js";
import {
  exitCodeForResult,
  terminalDiagnostic,
  type CliDependencies,
  type CliWriter,
} from "./main.js";
import {
  parseObjectiveJson,
  readObjectiveFile,
  validateFixtureObjective,
} from "./objectives.js";
import { executePolicyCommand } from "./policy-commands.js";
import { renderRun } from "./render.js";
import { executeSessionCommand } from "./session-command.js";

type WarmCliRequest = Exclude<
  CliRequest,
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "continue" }
  | { readonly kind: "resume" }
>;

const DEFAULT_DEPENDENCIES: CliDependencies = Object.freeze({
  readObjectiveFile,
  runSynthetic: runSyntheticTransformScenario,
  runCoding: runCodingVirtualRepositoryScenario,
  executePolicy: executePolicyCommand,
  executeSession: executeSessionCommand,
});

export async function executeWarmCliRequest(
  request: WarmCliRequest,
  stdout: CliWriter,
  stderr: CliWriter,
  dependencies: CliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  if (isPolicyRequest(request)) {
    const result = await dependencies.executePolicy(request);
    if (result.stdout.length > 0) stdout.write(result.stdout);
    if (result.stderr.length > 0) stderr.write(result.stderr);
    return result.exitCode;
  }

  if (request.kind === "interactive" || request.kind === "print") {
    return await (dependencies.executeSession ?? executeSessionCommand)(
      request,
      stdout,
      stderr,
    );
  }

  if (request.objective.kind !== "builtin") {
    const candidate =
      request.objective.kind === "file"
        ? await dependencies.readObjectiveFile(request.objective.path)
        : parseObjectiveJson(request.objective.json);
    validateFixtureObjective(request.profile, candidate);
  }

  const scenario = await runSelectedScenario(request.profile, dependencies);
  const output = renderRun(scenario.execution.history, request.format);
  const exitCode = exitCodeForResult(scenario.execution.state.result);
  if (output.length > 0) stdout.write(output);
  if (exitCode !== EXIT_CODES.success) {
    stderr.write(terminalDiagnostic(scenario.execution.state.result));
  }
  return exitCode;
}

function isPolicyRequest(request: WarmCliRequest): request is PolicyCliRequest {
  return (
    request.kind === "policy-check" ||
    request.kind === "policy-format" ||
    request.kind === "policy-test" ||
    request.kind === "policy-explain" ||
    request.kind === "policy-simulate"
  );
}

async function runSelectedScenario(
  profile: CliProfile,
  dependencies: CliDependencies,
) {
  return profile === "synthetic-demo"
    ? dependencies.runSynthetic()
    : dependencies.runCoding();
}
