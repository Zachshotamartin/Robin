import {
  CliUsageError,
  parseArgv,
  type CliHelpCommand,
  type PolicyCliRequest,
  type SessionCliRequest,
} from "./argv.js";
import { EXIT_CODES, exitCodeForErrorCode } from "./exit-codes.js";
import { GENERATED_BUILD_METADATA } from "./generated-build-metadata.js";
import type { PolicyCommandResult } from "./policy-commands.js";
import type { RenderableEvent } from "./render.js";

export const CLI_BUILD_METADATA = GENERATED_BUILD_METADATA;
export type CliBuildMetadata = typeof CLI_BUILD_METADATA;
export const CLI_VERSION = CLI_BUILD_METADATA.version;
export { EXIT_CODES, exitCodeForErrorCode } from "./exit-codes.js";

export interface CliWriter {
  write(chunk: string): unknown;
}

export interface CliRuntimeContext {
  /** Aborted by the executable wrapper when stdout or stderr becomes unusable. */
  readonly outputFailureSignal?: AbortSignal;
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
  readonly executeSession?: (
    request: SessionCliRequest,
    stdout: CliWriter,
    stderr: CliWriter,
    runtime?: CliRuntimeContext,
  ) => Promise<number>;
}

export async function runCli(
  argv: readonly string[],
  stdout: CliWriter,
  stderr: CliWriter,
  dependencies?: CliDependencies,
  runtime: CliRuntimeContext = {},
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
    if (request.kind === "continue" || request.kind === "resume") {
      throw new CliUsageError(
        "Session persistence and resume are not implemented in this preview.",
      );
    }

    const { executeWarmCliRequest } = await import("./warm-cli.js");
    return await executeWarmCliRequest(
      request,
      stdout,
      stderr,
      dependencies,
      runtime,
    );
  } catch (error) {
    if (isCliUsageError(error)) {
      stderr.write(`robin: ${error.message}\nTry 'robin --help'.\n`);
      return EXIT_CODES.invalidConfiguration;
    }
    const code = domainErrorCode(error);
    const exitCode = exitCodeForErrorCode(code);
    stderr.write(
      code === null
        ? "robin: The run failed before a terminal result was recorded.\n"
        : `robin: The run failed (${code}).\n`,
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

export function terminalDiagnostic(result: unknown): string {
  const status = recordString(result, "status");
  if (status === "cancelled") return "robin: The run was cancelled.\n";
  if (status === "orphaned") return "robin: The run was orphaned.\n";
  const code = domainErrorCode(recordValue(result, "error"));
  return code === null
    ? "robin: The run did not complete successfully.\n"
    : `robin: The run failed (${code}).\n`;
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

const ROOT_HELP = `Usage: robin [options] [prompt]
       robin -p [options] <prompt>
       robin <command> [options]

Coding session modes:
  robin [prompt]       Start an interactive session, optionally with a first prompt
  robin -p <prompt>    Run one non-interactive turn and print the result

Session options:
  -p, --print                 Use non-interactive print mode
  --provider <id>             Model provider; synthetic is available in this preview
  --model <id>                Provider model identifier
  --permission-mode <mode>    ask (preview label for future default) or plan
  --output-format <format>    text, json, or stream-json; print mode only
  --maximum-turns <1..256>    Future agent-turn ceiling recorded in preview output
  --no-save                   Explicitly keep print mode ephemeral
  --continue                  Reserved for durable continuation; unavailable now
  --resume [selector]         Reserved for durable resume; unavailable now

Commands:
  run       Execute a retained deterministic compatibility scenario
  policy    Check, format, test, explain, or simulate a .guard policy

Global options:
  --help    Show this help
  --version Show the CLI version

The current coding-session loop is credential-free, synthetic, and ephemeral.
It demonstrates two policy-gated in-memory fixture tools; it does not access a
physical repository, run commands, use the network, or persist a session.

Run 'robin run --help' or 'robin policy --help' for compatibility command options.
`;

const RUN_HELP = `Usage: robin run --profile <name> [options]
       robin run --profile <name> -- <objective-json>

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

const POLICY_HELP = `Usage: robin policy <subcommand> [options]

Subcommands:
  check       Parse and type-check one policy snapshot
  format      Print the canonical policy representation
  test        Run a versioned table-case corpus
  explain     Evaluate one normalized action with a full safe trace
  simulate    Compare two policies over recorded normalized actions

Run 'robin policy <subcommand> --help' for exact arguments.
`;

const POLICY_CHECK_HELP = `Usage: robin policy check <policy.guard> [options]

Options:
  --catalog <catalog.json>  Add one versioned attribute catalog; repeatable
  --default-effect <effect> allow, deny (default), or require_approval
  --json                    Emit canonical JSON
  --help                    Show this help
`;

const POLICY_FORMAT_HELP = `Usage: robin policy format <policy.guard> [options]

Options:
  --json  Emit canonical JSON containing canonicalText
  --help  Show this help
`;

const POLICY_TEST_HELP = `Usage: robin policy test <policy.guard> --cases <cases.json> [options]

Options:
  --catalog <catalog.json>  Add one versioned attribute catalog; repeatable
  --default-effect <effect> allow, deny (default), or require_approval
  --json                    Emit canonical JSON
  --help                    Show this help
`;

const POLICY_EXPLAIN_HELP = `Usage: robin policy explain <policy.guard> --action <action.json> [options]

Options:
  --catalog <catalog.json>  Add one versioned attribute catalog; repeatable
  --default-effect <effect> allow, deny (default), or require_approval
  --json                    Emit canonical JSON with the evaluated trace
  --help                    Show this help

Secret-classified values are represented by category and count. Per-run
correlation tokens are redacted from portable command output.
`;

const POLICY_SIMULATE_HELP = `Usage: robin policy simulate --from <old.guard> --to <new.guard> --actions <actions.json> [options]

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
