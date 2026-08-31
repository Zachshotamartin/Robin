import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";

import { ProcessToolError } from "./process-error.js";

export const PROCESS_REQUEST_SCHEMA_VERSION = 1 as const;
export const MAXIMUM_PROCESS_ARGUMENTS = 256;
export const MAXIMUM_PROCESS_ARGUMENT_UTF8_BYTES = 65_536;
export const MAXIMUM_PROCESS_ARGUMENTS_UTF8_BYTES = 262_144;
export const MAXIMUM_PROCESS_ENVIRONMENT_KEYS = 64;
export const MAXIMUM_PROCESS_ENVIRONMENT_VALUE_UTF8_BYTES = 65_536;
export const MAXIMUM_PROCESS_ENVIRONMENT_UTF8_BYTES = 262_144;
export const MAXIMUM_PROCESS_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAXIMUM_PROCESS_TERMINATION_GRACE_MS = 10_000;
export const MAXIMUM_PROCESS_RETAINED_BYTES_PER_CHANNEL = 4 * 1024 * 1024;
export const MAXIMUM_PROCESS_ABSOLUTE_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAXIMUM_PROCESS_STDIN_BYTES = 1024 * 1024;

export type ProcessIntent =
  | "verification"
  | "test"
  | "lint"
  | "build"
  | "format"
  | "other";

export interface ProcessOutputLimits {
  readonly retainedHeadBytes: number;
  readonly retainedTailBytes: number;
  readonly absoluteBytes: number;
}

export type ProcessStdin =
  | { readonly kind: "closed" }
  | { readonly kind: "inline_utf8"; readonly text: string }
  | {
      readonly kind: "workspace_file";
      readonly path: string;
      readonly expectedSha256: string;
      readonly maximumBytes: number;
    };

export interface ProcessRequestV1 {
  readonly schemaVersion: typeof PROCESS_REQUEST_SCHEMA_VERSION;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly output: ProcessOutputLimits;
  readonly stdin: ProcessStdin;
  readonly intent: ProcessIntent;
}

const PROCESS_INTENTS: ReadonlySet<string> = new Set([
  "verification",
  "test",
  "lint",
  "build",
  "format",
  "other",
]);

export function parseProcessRequestV1(input: unknown): ProcessRequestV1 {
  const record = plainRecord(input, "A process request must be a plain object.");
  exactKeys(record, [
    "schemaVersion",
    "executable",
    "argv",
    "cwd",
    "environment",
    "timeoutMs",
    "terminationGraceMs",
    "output",
    "stdin",
    "intent",
  ]);
  if (record["schemaVersion"] !== PROCESS_REQUEST_SCHEMA_VERSION) {
    invalid("The process request schema version is unsupported.");
  }
  const executable = boundedString(
    record["executable"],
    "The executable must be a non-empty bounded string.",
    4_096,
    false,
  );
  const argv = parseArgv(record["argv"]);
  const cwd = parseWorkspaceRelativePath(record["cwd"], true, "cwd");
  const environment = parseEnvironment(record["environment"]);
  const timeoutMs = positiveIntegerAtMost(
    record["timeoutMs"],
    MAXIMUM_PROCESS_TIMEOUT_MS,
    "timeoutMs",
  );
  const terminationGraceMs = nonnegativeIntegerAtMost(
    record["terminationGraceMs"],
    MAXIMUM_PROCESS_TERMINATION_GRACE_MS,
    "terminationGraceMs",
  );
  const output = parseOutputLimits(record["output"]);
  const stdin = parseStdin(record["stdin"]);
  const intent = record["intent"];
  if (typeof intent !== "string" || !PROCESS_INTENTS.has(intent)) {
    invalid("The process intent is unsupported.");
  }
  return Object.freeze({
    schemaVersion: PROCESS_REQUEST_SCHEMA_VERSION,
    executable,
    argv,
    cwd,
    environment,
    timeoutMs,
    terminationGraceMs,
    output,
    stdin,
    intent: intent as ProcessIntent,
  });
}

export function parseWorkspaceRelativePath(
  input: unknown,
  allowRoot: boolean,
  label = "path",
): string {
  const value = boundedString(
    input,
    `The ${label} must be a bounded string.`,
    4_096,
    true,
  );
  if (allowRoot && value === ".") return value;
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("//") ||
    value.includes("\u0000") ||
    value.includes("://")
  ) {
    invalid(`The ${label} is not a canonical workspace-relative path.`);
  }
  const components = value.split("/");
  if (
    components.some(
      (component) =>
        component.length === 0 || component === "." || component === "..",
    )
  ) {
    invalid(`The ${label} contains a forbidden path component.`);
  }
  const normalized = value.normalize("NFC");
  if (normalized !== value || containsUnpairedSurrogate(value)) {
    invalid(`The ${label} does not use the canonical Unicode form.`);
  }
  return value;
}

function parseArgv(input: unknown): readonly string[] {
  if (!Array.isArray(input) || !isDenseDataArray(input)) {
    invalid("argv must be a dense array of strings.");
  }
  if (input.length > MAXIMUM_PROCESS_ARGUMENTS) {
    invalid("argv exceeds the argument-count ceiling.");
  }
  let totalBytes = 0;
  const values = input.map((value) => {
    const argument = boundedString(
      value,
      "Every argv item must be a bounded string.",
      MAXIMUM_PROCESS_ARGUMENT_UTF8_BYTES,
      true,
    );
    totalBytes += Buffer.byteLength(argument, "utf8");
    if (totalBytes > MAXIMUM_PROCESS_ARGUMENTS_UTF8_BYTES) {
      invalid("argv exceeds the aggregate byte ceiling.");
    }
    return argument;
  });
  return Object.freeze(values);
}

function parseEnvironment(input: unknown): Readonly<Record<string, string>> {
  const record = plainRecord(
    input,
    "Process environment additions must be a plain object.",
  );
  const keys = Object.keys(record).sort();
  if (keys.length > MAXIMUM_PROCESS_ENVIRONMENT_KEYS) {
    invalid("Process environment additions exceed the key-count ceiling.");
  }
  let totalBytes = 0;
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      invalid("A process environment key is invalid.");
    }
    const value = boundedString(
      record[key],
      "A process environment value is invalid.",
      MAXIMUM_PROCESS_ENVIRONMENT_VALUE_UTF8_BYTES,
      true,
    );
    totalBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > MAXIMUM_PROCESS_ENVIRONMENT_UTF8_BYTES) {
      invalid("Process environment additions exceed the aggregate byte ceiling.");
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function parseOutputLimits(input: unknown): ProcessOutputLimits {
  const record = plainRecord(input, "Process output limits must be a plain object.");
  exactKeys(record, [
    "retainedHeadBytes",
    "retainedTailBytes",
    "absoluteBytes",
  ]);
  const retainedHeadBytes = nonnegativeIntegerAtMost(
    record["retainedHeadBytes"],
    MAXIMUM_PROCESS_RETAINED_BYTES_PER_CHANNEL,
    "retainedHeadBytes",
  );
  const retainedTailBytes = nonnegativeIntegerAtMost(
    record["retainedTailBytes"],
    MAXIMUM_PROCESS_RETAINED_BYTES_PER_CHANNEL,
    "retainedTailBytes",
  );
  if (
    retainedHeadBytes + retainedTailBytes >
    MAXIMUM_PROCESS_RETAINED_BYTES_PER_CHANNEL
  ) {
    invalid("Retained process output exceeds the per-channel ceiling.");
  }
  const absoluteBytes = positiveIntegerAtMost(
    record["absoluteBytes"],
    MAXIMUM_PROCESS_ABSOLUTE_OUTPUT_BYTES,
    "absoluteBytes",
  );
  if (absoluteBytes < retainedHeadBytes + retainedTailBytes) {
    invalid("The absolute output bound cannot be smaller than retained output.");
  }
  return Object.freeze({ retainedHeadBytes, retainedTailBytes, absoluteBytes });
}

function parseStdin(input: unknown): ProcessStdin {
  const record = plainRecord(input, "Process stdin must be a plain object.");
  if (record["kind"] === "closed") {
    exactKeys(record, ["kind"]);
    return Object.freeze({ kind: "closed" });
  }
  if (record["kind"] === "inline_utf8") {
    exactKeys(record, ["kind", "text"]);
    const text = boundedString(
      record["text"],
      "Inline stdin must be bounded UTF-8 text.",
      MAXIMUM_PROCESS_STDIN_BYTES,
      true,
    );
    return Object.freeze({ kind: "inline_utf8", text });
  }
  if (record["kind"] === "workspace_file") {
    exactKeys(record, ["kind", "path", "expectedSha256", "maximumBytes"]);
    const path = parseWorkspaceRelativePath(record["path"], false, "stdin path");
    const expectedSha256 = record["expectedSha256"];
    if (
      typeof expectedSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(expectedSha256)
    ) {
      invalid("Workspace-file stdin requires a lowercase SHA-256 precondition.");
    }
    const maximumBytes = positiveIntegerAtMost(
      record["maximumBytes"],
      MAXIMUM_PROCESS_STDIN_BYTES,
      "stdin maximumBytes",
    );
    return Object.freeze({
      kind: "workspace_file",
      path,
      expectedSha256,
      maximumBytes,
    });
  }
  invalid("The process stdin kind is unsupported.");
}

function plainRecord(
  input: unknown,
  message: string,
): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    isProxy(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    invalid(message);
  }
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") invalid(message);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      invalid(message);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactKeys(
  input: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(input);
  const allowed = new Set(expected);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    invalid("The process request contains unknown or missing fields.");
  }
}

function isDenseDataArray(input: readonly unknown[]): boolean {
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== input.length + 1 ||
    !keys.includes("length")
  ) {
    return false;
  }
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return false;
    }
  }
  return true;
}

function boundedString(
  input: unknown,
  message: string,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof input !== "string" ||
    (!allowEmpty && input.length === 0) ||
    input.includes("\u0000") ||
    containsUnpairedSurrogate(input) ||
    Buffer.byteLength(input, "utf8") > maximumBytes
  ) {
    invalid(message);
  }
  return input;
}

function positiveIntegerAtMost(
  input: unknown,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(input) || (input as number) <= 0 || (input as number) > maximum) {
    invalid(`${label} must be a positive bounded integer.`);
  }
  return input as number;
}

function nonnegativeIntegerAtMost(
  input: unknown,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0 || (input as number) > maximum) {
    invalid(`${label} must be a non-negative bounded integer.`);
  }
  return input as number;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function invalid(message: string): never {
  throw new ProcessToolError("invalid_request", message);
}
