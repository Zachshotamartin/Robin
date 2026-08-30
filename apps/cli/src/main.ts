import {
  runCodingVirtualRepositoryScenario,
  runSyntheticTransformScenario,
} from "@guard/milestone-a-scenarios";

import {
  CliUsageError,
  parseArgv,
  type CliHelpCommand,
  type CliProfile,
  type CliRequest,
  type PolicyCliRequest,
} from "./argv.js";
import {
  parseObjectiveJson,
  readObjectiveFile,
  validateFixtureObjective,
} from "./objectives.js";
import { renderRun, type RenderableEvent } from "./render.js";
import {
  executePolicyCommand,
  type PolicyCommandResult,
} from "./policy-commands.js";

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
  readonly executePolicy: (request: PolicyCliRequest) => Promise<PolicyCommandResult>;
}

const DEFAULT_DEPENDENCIES: CliDependencies = Object.freeze({
  readObjectiveFile,
  runSynthetic: runSyntheticTransformScenario,
  runCoding: runCodingVirtualRepositoryScenario,
  executePolicy: executePolicyCommand,
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
      stdout.write(helpFor(request.command));
      return EXIT_CODES.success;
    }
    if (request.kind === "version") {
      stdout.write(`${CLI_VERSION}\n`);
      return EXIT_CODES.success;
    }

    if (isPolicyRequest(request)) {
      const result = await dependencies.executePolicy(request);
      if (result.stdout.length > 0) stdout.write(result.stdout);
      if (result.stderr.length > 0) stderr.write(result.stderr);
      return result.exitCode;
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
      stderr.write(`guard: ${error.message}\nTry 'guard --help'.\n`);
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

function isPolicyRequest(request: CliRequest): request is PolicyCliRequest {
  return (
    request.kind === "policy-check" ||
    request.kind === "policy-format" ||
    request.kind === "policy-test" ||
    request.kind === "policy-explain" ||
    request.kind === "policy-simulate"
  );
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
  run       Execute a deterministic scenario
  policy    Check, format, test, explain, or simulate .guard policy

Global options:
  --help    Show this help
  --version Show the CLI version

Run 'guard run --help' or 'guard policy --help' for command options.
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

const POLICY_HELP = `Usage: guard policy <subcommand> [options]

Subcommands:
  check       Parse and type-check one policy snapshot
  format      Print the canonical policy representation
  test        Run a versioned table-case corpus
  explain     Evaluate one normalized action with a full safe trace
  simulate    Compare two policies over recorded normalized actions

Run 'guard policy <subcommand> --help' for exact arguments.
`;

const POLICY_CHECK_HELP = `Usage: guard policy check <policy.guard> [options]

Options:
  --catalog <catalog.json>  Add one versioned attribute catalog; repeatable
  --default-effect <effect> allow, deny (default), or require_approval
  --json                    Emit canonical JSON
  --help                    Show this help
`;

const POLICY_FORMAT_HELP = `Usage: guard policy format <policy.guard> [options]

Options:
  --json  Emit canonical JSON containing canonicalText
  --help  Show this help
`;

const POLICY_TEST_HELP = `Usage: guard policy test <policy.guard> --cases <cases.json> [options]

Options:
  --catalog <catalog.json>  Add one versioned attribute catalog; repeatable
  --default-effect <effect> allow, deny (default), or require_approval
  --json                    Emit canonical JSON
  --help                    Show this help
`;

const POLICY_EXPLAIN_HELP = `Usage: guard policy explain <policy.guard> --action <action.json> [options]

Options:
  --catalog <catalog.json>  Add one versioned attribute catalog; repeatable
  --default-effect <effect> allow, deny (default), or require_approval
  --json                    Emit canonical JSON with the evaluated trace
  --help                    Show this help

Secret-classified values are represented by category and count. Per-run
correlation tokens are redacted from portable command output.
`;

const POLICY_SIMULATE_HELP = `Usage: guard policy simulate --from <old.guard> --to <new.guard> --actions <actions.json> [options]

Options:
  --catalog <catalog.json>       Add one versioned attribute catalog; repeatable
  --from-catalog <catalog.json> Add a catalog only to the old snapshot
  --to-catalog <catalog.json>   Add a catalog only to the candidate snapshot
  --from-default-effect <effect> Old snapshot default; deny when omitted
  --to-default-effect <effect>   New snapshot default; deny when omitted
  --page-size <1..1000>          Stable action page size; default 100
  --cursor <token>               Resume a matching prior simulation page
  --json                         Emit canonical JSON
  --help                         Show this help
`;

function helpFor(command: CliHelpCommand): string {
  switch (command) {
    case "root":
      return ROOT_HELP;
    case "run":
      return RUN_HELP;
    case "policy":
      return POLICY_HELP;
    case "policy-check":
      return POLICY_CHECK_HELP;
    case "policy-format":
      return POLICY_FORMAT_HELP;
    case "policy-test":
      return POLICY_TEST_HELP;
    case "policy-explain":
      return POLICY_EXPLAIN_HELP;
    case "policy-simulate":
      return POLICY_SIMULATE_HELP;
    default:
      return ROOT_HELP;
  }
}
