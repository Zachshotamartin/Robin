export const CLI_PROFILES = ["synthetic-demo", "coding-virtual"] as const;
export type CliProfile = (typeof CLI_PROFILES)[number];

export const OUTPUT_FORMATS = ["human", "jsonl", "quiet"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type ObjectiveInput =
  | { readonly kind: "builtin" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "inline"; readonly json: string };

export type CliRequest =
  | { readonly kind: "help"; readonly command: "root" | "run" }
  | { readonly kind: "version" }
  | {
      readonly kind: "run";
      readonly profile: CliProfile;
      readonly format: OutputFormat;
      readonly objective: ObjectiveInput;
    };

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const VALUE_OPTIONS = new Set([
  "--profile",
  "--format",
  "--objective-file",
  "--objective-json",
]);
const FORMAT_ALIAS_OPTIONS = new Set(["--jsonl", "--quiet"]);

/** Parses argv without reading files, environment variables, or process state. */
export function parseArgv(argv: readonly string[]): CliRequest {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return Object.freeze({ kind: "help", command: "root" });
  }
  if (argv.length === 1 && argv[0] === "--version") {
    return Object.freeze({ kind: "version" });
  }
  if (argv.length === 0) {
    throw new CliUsageError("A command is required.");
  }
  if (argv[0] !== "run") {
    throw new CliUsageError(`Unknown command: ${safeToken(argv[0])}.`);
  }
  if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) {
    return Object.freeze({ kind: "help", command: "run" });
  }

  let profile: CliProfile | undefined;
  let format: OutputFormat = "human";
  let objectiveFile: string | undefined;
  let objectiveJson: string | undefined;
  let delimiterObjective: string | undefined;
  const seen = new Set<string>();
  let explicitFormatOption: "--format" | "--jsonl" | "--quiet" | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") {
      const remaining = argv.slice(index + 1);
      if (remaining.length !== 1) {
        throw new CliUsageError(
          "The -- delimiter must be followed by exactly one inline JSON objective.",
        );
      }
      delimiterObjective = remaining[0]!;
      break;
    }
    if (FORMAT_ALIAS_OPTIONS.has(token)) {
      if (seen.has(token)) {
        throw new CliUsageError(`Option ${token} may be specified only once.`);
      }
      seen.add(token);
      if (explicitFormatOption !== undefined) {
        throw new CliUsageError(
          "--format, --jsonl, and --quiet are mutually exclusive.",
        );
      }
      explicitFormatOption = token as "--jsonl" | "--quiet";
      format = token === "--jsonl" ? "jsonl" : "quiet";
      continue;
    }
    if (!VALUE_OPTIONS.has(token)) {
      if (token.startsWith("-")) {
        throw new CliUsageError(`Unknown option: ${safeToken(token)}.`);
      }
      throw new CliUsageError(
        "Positional arguments are not accepted before --; use an explicit option.",
      );
    }
    if (seen.has(token)) {
      throw new CliUsageError(`Option ${token} may be specified only once.`);
    }
    seen.add(token);

    const value = argv[index + 1];
    if (value === undefined || value === "--" || value.startsWith("--")) {
      throw new CliUsageError(`Option ${token} requires an explicit value.`);
    }
    index += 1;

    switch (token) {
      case "--profile":
        if (!isCliProfile(value)) {
          throw new CliUsageError(
            "--profile must be synthetic-demo or coding-virtual.",
          );
        }
        profile = value;
        break;
      case "--format":
        if (explicitFormatOption !== undefined) {
          throw new CliUsageError(
            "--format, --jsonl, and --quiet are mutually exclusive.",
          );
        }
        if (!isOutputFormat(value)) {
          throw new CliUsageError("--format must be human, jsonl, or quiet.");
        }
        explicitFormatOption = "--format";
        format = value;
        break;
      case "--objective-file":
        if (value.length === 0) {
          throw new CliUsageError("--objective-file requires a non-empty path.");
        }
        objectiveFile = value;
        break;
      case "--objective-json":
        if (value.length === 0) {
          throw new CliUsageError("--objective-json requires non-empty JSON.");
        }
        objectiveJson = value;
        break;
    }
  }

  if (profile === undefined) {
    throw new CliUsageError("--profile is required for guard run.");
  }
  const objectiveInputs = [objectiveFile, objectiveJson, delimiterObjective].filter(
    (candidate): candidate is string => candidate !== undefined,
  );
  if (objectiveInputs.length > 1) {
    throw new CliUsageError(
      "--objective-file, --objective-json, and the -- shorthand are mutually exclusive.",
    );
  }

  const objective: ObjectiveInput =
    objectiveFile !== undefined
      ? Object.freeze({ kind: "file", path: objectiveFile })
      : objectiveJson !== undefined
        ? Object.freeze({ kind: "inline", json: objectiveJson })
        : delimiterObjective !== undefined
          ? Object.freeze({ kind: "inline", json: delimiterObjective })
          : Object.freeze({ kind: "builtin" });

  return Object.freeze({ kind: "run", profile, format, objective });
}

function isCliProfile(value: string): value is CliProfile {
  return (CLI_PROFILES as readonly string[]).includes(value);
}

function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

function safeToken(value: string | undefined): string {
  if (value === undefined) return "<missing>";
  if (/^[a-zA-Z0-9._:/-]{1,80}$/u.test(value)) return value;
  return "<invalid token>";
}
