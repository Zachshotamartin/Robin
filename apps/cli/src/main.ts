import {
  runCodingVirtualRepositoryScenario,
  runSyntheticTransformScenario,
} from "@guard/milestone-a-scenarios";

import {
  CliUsageError,
  parseArgv,
  type CliProfile,
} from "./argv.js";
import {
  parseObjectiveJson,
  readObjectiveFile,
  validateFixtureObjective,
} from "./objectives.js";
import { renderRun, type RenderableEvent } from "./render.js";

export const CLI_VERSION = "0.0.0";

export const EXIT_CODES = Object.freeze({
  success: 0,
  invalidConfiguration: 2,
  policyDenied: 3,
  approvalPending: 4,
  budgetExceeded: 5,
  taskFailed: 6,
  infrastructureFailed: 7,
  cancelled: 8,
});

export interface CliWriter {
  write(chunk: string): unknown;
}

interface ScenarioExecutionView {
  readonly execution: {
    readonly history: readonly RenderableEvent[];
    readonly state: {
      readonly result: unknown;
    };
  };
}

export interface CliDependencies {
  readonly readObjectiveFile: (path: string) => Promise<unknown>;
  readonly runSynthetic: () => Promise<ScenarioExecutionView>;
  readonly runCoding: () => Promise<ScenarioExecutionView>;
}

const DEFAULT_DEPENDENCIES: CliDependencies = Object.freeze({
  readObjectiveFile,
  runSynthetic: runSyntheticTransformScenario,
  runCoding: runCodingVirtualRepositoryScenario,
});

export async function runCli(
  argv: readonly string[],
  stdout: CliWriter,
  stderr: CliWriter,
  dependencies: CliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  try {
    const request = parseArgv(argv);
    if (request.kind === "help") {
      stdout.write(request.command === "run" ? RUN_HELP : ROOT_HELP);
      return EXIT_CODES.success;
    }
    if (request.kind === "version") {
      stdout.write(`${CLI_VERSION}\n`);
      return EXIT_CODES.success;
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
  } catch (error) {
    if (isCliUsageError(error)) {
      stderr.write(`guard: ${error.message}\nTry 'guard run --help'.\n`);
      return EXIT_CODES.invalidConfiguration;
    }
    const code = domainErrorCode(error);
    const exitCode = exitCodeForErrorCode(code);
    stderr.write(
      code === null
        ? "guard: The run failed before a terminal result was recorded.\n"
        : `guard: The run failed (${code}).\n`,
    );
    return exitCode;
  }
}

function isCliUsageError(value: unknown): value is CliUsageError {
  try {
    return value instanceof CliUsageError;
  } catch {
    return false;
  }
}

export function exitCodeForResult(result: unknown): number {
  const status = recordString(result, "status");
  if (status === "completed") return EXIT_CODES.success;
  if (status === "cancelled") return EXIT_CODES.cancelled;
  if (status === "orphaned") return EXIT_CODES.infrastructureFailed;
  if (status !== "failed") return EXIT_CODES.infrastructureFailed;
  return exitCodeForErrorCode(domainErrorCode(recordValue(result, "error")));
}

async function runSelectedScenario(
  profile: CliProfile,
  dependencies: CliDependencies,
): Promise<ScenarioExecutionView> {
  return profile === "synthetic-demo"
    ? dependencies.runSynthetic()
    : dependencies.runCoding();
}

function exitCodeForErrorCode(code: string | null): number {
  switch (code) {
    case "policy_denied":
    case "approval_invalid":
      return EXIT_CODES.policyDenied;
    case "approval_required":
      return EXIT_CODES.approvalPending;
    case "budget_exceeded":
      return EXIT_CODES.budgetExceeded;
    case "cancelled":
      return EXIT_CODES.cancelled;
    case "infrastructure_failed":
    case "provider_failed":
    case "provider_result_uncertain":
    case "sandbox_failed":
    case "invariant_violated":
      return EXIT_CODES.infrastructureFailed;
    case "invalid_input":
    case "action_failed":
    case "driver_failed":
    case "attempt_result_uncertain":
    case "conflict":
      return EXIT_CODES.taskFailed;
    default:
      return EXIT_CODES.infrastructureFailed;
  }
}

function terminalDiagnostic(result: unknown): string {
  const status = recordString(result, "status");
  if (status === "cancelled") return "guard: The run was cancelled.\n";
  if (status === "orphaned") return "guard: The run was orphaned.\n";
  const code = domainErrorCode(recordValue(result, "error"));
  return code === null
    ? "guard: The run did not complete successfully.\n"
    : `guard: The run failed (${code}).\n`;
}

function domainErrorCode(error: unknown): string | null {
  return recordString(error, "code");
}

function recordString(value: unknown, key: string): string | null {
  const property = recordValue(value, key);
  return typeof property === "string" ? property : null;
}

function recordValue(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

const ROOT_HELP = `Usage: guard <command> [options]

Commands:
  run       Execute a deterministic Milestone A scenario

Global options:
  --help    Show this help
  --version Show the CLI version

Run 'guard run --help' for run options.
`;

const RUN_HELP = `Usage: guard run --profile <name> [options]
       guard run --profile <name> -- <objective-json>

Required:
  --profile <name>          synthetic-demo or coding-virtual

Options:
  --format <format>         human (default), jsonl, or quiet
  --jsonl                   Alias for --format jsonl
  --quiet                   Alias for --format quiet
  --objective-file <path>  Bounded JSON fixture envelope or payload shorthand
  --objective-json <json>  Inline JSON fixture envelope or payload shorthand
  --help                    Show this help (when used alone after run)

Milestone A accepts only its exact deterministic fixture objectives. Provider,
agent, API-key, credential, network, and repository configuration flags are not
accepted. Output is buffered until completion. SIGINT does not yet create a
durable cancellation event in this in-process slice.

Exit codes: 0 success, 2 invalid input/configuration, 3 policy denial,
4 approval pending, 5 budget exhaustion, 6 task failure,
7 infrastructure failure, 8 cancellation.
`;
