import { isProxy } from "node:util/types";

export const CLI_PROFILES = ["synthetic-demo", "coding-virtual"] as const;
export type CliProfile = (typeof CLI_PROFILES)[number];

export const OUTPUT_FORMATS = ["human", "jsonl", "quiet"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const POLICY_EFFECTS = ["allow", "deny", "require_approval"] as const;
export type PolicyDefaultEffect = (typeof POLICY_EFFECTS)[number];
export type PolicyOutputFormat = "human" | "json";

export const MAXIMUM_CLI_ARGUMENTS = 128;
export const MAXIMUM_CLI_ARGUMENT_BYTES = 1_048_576;
export const MAXIMUM_CLI_TOTAL_ARGUMENT_BYTES = 2_097_152;
export const MAXIMUM_CLI_PATH_BYTES = 4_096;
export const MAXIMUM_CLI_POLICY_CATALOGS = 16;

export type ObjectiveInput =
  | { readonly kind: "builtin" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "inline"; readonly json: string };

export type CliHelpCommand =
  | "root"
  | "run"
  | "policy"
  | "policy-check"
  | "policy-format"
  | "policy-test"
  | "policy-explain"
  | "policy-simulate";

interface PolicyCompileRequestOptions {
  readonly defaultEffect: PolicyDefaultEffect;
  readonly catalogPaths: readonly string[];
  readonly format: PolicyOutputFormat;
}

export type PolicyCliRequest =
  | ({
      readonly kind: "policy-check";
      readonly policyPath: string;
    } & PolicyCompileRequestOptions)
  | {
      readonly kind: "policy-format";
      readonly policyPath: string;
      readonly format: PolicyOutputFormat;
    }
  | ({
      readonly kind: "policy-test";
      readonly policyPath: string;
      readonly casePath: string;
    } & PolicyCompileRequestOptions)
  | ({
      readonly kind: "policy-explain";
      readonly policyPath: string;
      readonly actionPath: string;
    } & PolicyCompileRequestOptions)
  | {
      readonly kind: "policy-simulate";
      readonly fromPolicyPath: string;
      readonly toPolicyPath: string;
      readonly actionCorpusPath: string;
      readonly fromDefaultEffect: PolicyDefaultEffect;
      readonly toDefaultEffect: PolicyDefaultEffect;
      readonly catalogPaths: readonly string[];
      readonly fromCatalogPaths: readonly string[];
      readonly toCatalogPaths: readonly string[];
      readonly pageSize: number;
      readonly cursor: string | null;
      readonly format: PolicyOutputFormat;
    };

export type CliRequest =
  | { readonly kind: "help"; readonly command: CliHelpCommand }
  | { readonly kind: "version" }
  | {
      readonly kind: "run";
      readonly profile: CliProfile;
      readonly format: OutputFormat;
      readonly objective: ObjectiveInput;
    }
  | PolicyCliRequest;

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
const POLICY_SUBCOMMANDS = new Set([
  "check",
  "format",
  "test",
  "explain",
  "simulate",
]);

interface ParsedPolicyTokens {
  readonly positionals: readonly string[];
  readonly catalogs: readonly string[];
  readonly fromCatalogs: readonly string[];
  readonly toCatalogs: readonly string[];
  readonly json: boolean;
  readonly values: ReadonlyMap<string, string>;
}

/** Parses argv without reading files, environment variables, or process state. */
export function parseArgv(argv: readonly string[]): CliRequest {
  const args = captureArgv(argv);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return Object.freeze({ kind: "help", command: "root" });
  }
  if (args.length === 1 && args[0] === "--version") {
    return Object.freeze({ kind: "version" });
  }
  if (args.length === 0) {
    throw new CliUsageError("A command is required.");
  }
  if (args[0] === "policy") {
    return parsePolicyArgv(args.slice(1));
  }
  if (args[0] !== "run") {
    throw new CliUsageError(`Unknown command: ${safeToken(args[0])}.`);
  }
  if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
    return Object.freeze({ kind: "help", command: "run" });
  }

  let profile: CliProfile | undefined;
  let format: OutputFormat = "human";
  let objectiveFile: string | undefined;
  let objectiveJson: string | undefined;
  let delimiterObjective: string | undefined;
  const seen = new Set<string>();
  let explicitFormatOption: "--format" | "--jsonl" | "--quiet" | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") {
      const remaining = args.slice(index + 1);
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

    const value = args[index + 1];
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
        objectiveFile = validatePath(value, "--objective-file");
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

function parsePolicyArgv(argv: readonly string[]): CliRequest {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return Object.freeze({ kind: "help", command: "policy" });
  }
  const command = argv[0];
  if (command === undefined) {
    throw new CliUsageError("A policy subcommand is required.");
  }
  if (!POLICY_SUBCOMMANDS.has(command)) {
    throw new CliUsageError(`Unknown policy subcommand: ${safeToken(command)}.`);
  }
  if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) {
    return Object.freeze({
      kind: "help",
      command: `policy-${command}` as CliHelpCommand,
    });
  }
  const tokens = argv.slice(1);
  switch (command) {
    case "check":
      return parseCheckRequest(tokens);
    case "format":
      return parseFormatRequest(tokens);
    case "test":
      return parseTestRequest(tokens);
    case "explain":
      return parseExplainRequest(tokens);
    case "simulate":
      return parseSimulateRequest(tokens);
    default:
      throw new CliUsageError("The policy subcommand is unsupported.");
  }
}

function parseCheckRequest(tokens: readonly string[]): PolicyCliRequest {
  const parsed = parsePolicyTokens(
    tokens,
    new Set(["--default-effect"]),
    new Set(["--catalog"]),
  );
  return Object.freeze({
    kind: "policy-check",
    policyPath: onePolicyPath(parsed.positionals, "check"),
    defaultEffect: policyEffectOption(parsed.values, "--default-effect", "deny"),
    catalogPaths: parsed.catalogs,
    format: parsed.json ? "json" : "human",
  });
}

function parseFormatRequest(tokens: readonly string[]): PolicyCliRequest {
  const parsed = parsePolicyTokens(tokens, new Set(), new Set());
  return Object.freeze({
    kind: "policy-format",
    policyPath: onePolicyPath(parsed.positionals, "format"),
    format: parsed.json ? "json" : "human",
  });
}

function parseTestRequest(tokens: readonly string[]): PolicyCliRequest {
  const parsed = parsePolicyTokens(
    tokens,
    new Set(["--cases", "--default-effect"]),
    new Set(["--catalog"]),
  );
  return Object.freeze({
    kind: "policy-test",
    policyPath: onePolicyPath(parsed.positionals, "test"),
    casePath: requiredPathOption(parsed.values, "--cases"),
    defaultEffect: policyEffectOption(parsed.values, "--default-effect", "deny"),
    catalogPaths: parsed.catalogs,
    format: parsed.json ? "json" : "human",
  });
}

function parseExplainRequest(tokens: readonly string[]): PolicyCliRequest {
  const parsed = parsePolicyTokens(
    tokens,
    new Set(["--action", "--default-effect"]),
    new Set(["--catalog"]),
  );
  return Object.freeze({
    kind: "policy-explain",
    policyPath: onePolicyPath(parsed.positionals, "explain"),
    actionPath: requiredPathOption(parsed.values, "--action"),
    defaultEffect: policyEffectOption(parsed.values, "--default-effect", "deny"),
    catalogPaths: parsed.catalogs,
    format: parsed.json ? "json" : "human",
  });
}

function parseSimulateRequest(tokens: readonly string[]): PolicyCliRequest {
  const parsed = parsePolicyTokens(
    tokens,
    new Set([
      "--from",
      "--to",
      "--actions",
      "--from-default-effect",
      "--to-default-effect",
      "--page-size",
      "--cursor",
    ]),
    new Set(["--catalog", "--from-catalog", "--to-catalog"]),
  );
  if (parsed.positionals.length !== 0) {
    throw new CliUsageError("guard policy simulate accepts no positional arguments.");
  }
  const rawCursor = parsed.values.get("--cursor") ?? null;
  if (
    rawCursor !== null &&
    (rawCursor.length === 0 || Buffer.byteLength(rawCursor, "utf8") > 2_048)
  ) {
    throw new CliUsageError("--cursor must be a non-empty bounded token.");
  }
  return Object.freeze({
    kind: "policy-simulate",
    fromPolicyPath: requiredPathOption(parsed.values, "--from"),
    toPolicyPath: requiredPathOption(parsed.values, "--to"),
    actionCorpusPath: requiredPathOption(parsed.values, "--actions"),
    fromDefaultEffect: policyEffectOption(
      parsed.values,
      "--from-default-effect",
      "deny",
    ),
    toDefaultEffect: policyEffectOption(
      parsed.values,
      "--to-default-effect",
      "deny",
    ),
    catalogPaths: parsed.catalogs,
    fromCatalogPaths: parsed.fromCatalogs,
    toCatalogPaths: parsed.toCatalogs,
    pageSize: pageSizeOption(parsed.values.get("--page-size")),
    cursor: rawCursor,
    format: parsed.json ? "json" : "human",
  });
}

function parsePolicyTokens(
  tokens: readonly string[],
  valueOptions: ReadonlySet<string>,
  catalogOptions: ReadonlySet<string>,
): ParsedPolicyTokens {
  const positionals: string[] = [];
  const catalogs: string[] = [];
  const fromCatalogs: string[] = [];
  const toCatalogs: string[] = [];
  const values = new Map<string, string>();
  const seen = new Set<string>();
  let json = false;
  let positionalOnly = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--" && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !token.startsWith("-")) {
      positionals.push(validatePath(token, "policy source"));
      continue;
    }
    if (token === "--json") {
      if (json) {
        throw new CliUsageError("Option --json may be specified only once.");
      }
      json = true;
      continue;
    }
    const catalog = catalogOptions.has(token);
    if (!catalog && !valueOptions.has(token)) {
      throw new CliUsageError(`Unknown policy option: ${safeToken(token)}.`);
    }
    if (!catalog && seen.has(token)) {
      throw new CliUsageError(`Option ${token} may be specified only once.`);
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new CliUsageError(`Option ${token} requires an explicit value.`);
    }
    index += 1;
    if (catalog) {
      const path = validatePath(value, "--catalog");
      if (
        catalogs.includes(path) ||
        fromCatalogs.includes(path) ||
        toCatalogs.includes(path)
      ) {
        throw new CliUsageError("The same --catalog path may not be repeated.");
      }
      if (
        catalogs.length + fromCatalogs.length + toCatalogs.length >=
        MAXIMUM_CLI_POLICY_CATALOGS
      ) {
        throw new CliUsageError("At most 16 catalog options may be supplied.");
      }
      if (token === "--from-catalog") fromCatalogs.push(path);
      else if (token === "--to-catalog") toCatalogs.push(path);
      else catalogs.push(path);
    } else {
      seen.add(token);
      values.set(token, value);
    }
  }
  return Object.freeze({
    positionals: Object.freeze(positionals),
    catalogs: Object.freeze(catalogs),
    fromCatalogs: Object.freeze(fromCatalogs),
    toCatalogs: Object.freeze(toCatalogs),
    json,
    values,
  });
}

function onePolicyPath(positionals: readonly string[], command: string): string {
  if (positionals.length !== 1) {
    throw new CliUsageError(
      `guard policy ${command} requires exactly one policy source path.`,
    );
  }
  return positionals[0]!;
}

function requiredPathOption(values: ReadonlyMap<string, string>, option: string): string {
  const value = values.get(option);
  if (value === undefined) {
    throw new CliUsageError(`${option} is required.`);
  }
  return validatePath(value, option);
}

function policyEffectOption(
  values: ReadonlyMap<string, string>,
  option: string,
  fallback: PolicyDefaultEffect,
): PolicyDefaultEffect {
  const value = values.get(option);
  if (value === undefined) return fallback;
  if (!isPolicyEffect(value)) {
    throw new CliUsageError(
      `${option} must be allow, deny, or require_approval.`,
    );
  }
  return value;
}

function pageSizeOption(value: string | undefined): number {
  if (value === undefined) return 100;
  if (!/^(?:[1-9][0-9]{0,3})$/u.test(value)) {
    throw new CliUsageError("--page-size must be an integer from 1 through 1000.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new CliUsageError("--page-size must be an integer from 1 through 1000.");
  }
  return parsed;
}

function validatePath(value: string, option: string): string {
  if (
    value.length === 0 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_CLI_PATH_BYTES
  ) {
    throw new CliUsageError(`${option} requires a non-empty bounded file path.`);
  }
  return value;
}

function isCliProfile(value: string): value is CliProfile {
  return (CLI_PROFILES as readonly string[]).includes(value);
}

function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

function isPolicyEffect(value: string): value is PolicyDefaultEffect {
  return (POLICY_EFFECTS as readonly string[]).includes(value);
}

function captureArgv(value: readonly string[]): readonly string[] {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      throw new TypeError();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAXIMUM_CLI_ARGUMENTS ||
      lengthDescriptor.enumerable === true
    ) {
      throw new TypeError();
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1 ||
      keys.some((key) =>
        typeof key !== "string" ||
        (key !== "length" &&
          (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)))
    ) {
      throw new TypeError();
    }
    const captured: string[] = [];
    let totalBytes = 0;
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true ||
        typeof descriptor.value !== "string"
      ) {
        throw new TypeError();
      }
      const bytes = Buffer.byteLength(descriptor.value, "utf8");
      totalBytes += bytes;
      if (
        bytes > MAXIMUM_CLI_ARGUMENT_BYTES ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > MAXIMUM_CLI_TOTAL_ARGUMENT_BYTES
      ) {
        throw new TypeError();
      }
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    throw new CliUsageError("CLI arguments must be one bounded dense string array.");
  }
}

function safeToken(value: string | undefined): string {
  if (value === undefined) return "<missing>";
  if (/^[a-zA-Z0-9._:/-]{1,80}$/u.test(value)) return value;
  return "<invalid token>";
}
