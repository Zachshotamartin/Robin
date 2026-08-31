import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { ProcessToolError } from "./process-error.js";

export interface ProcessEnvironmentProfile {
  readonly profileId: string;
  readonly inheritedKeys: readonly string[];
  readonly fixed: Readonly<Record<string, string>>;
}

export interface ProcessEnvironmentMetadata {
  readonly profileId: string;
  readonly inheritedKeys: readonly string[];
  readonly fixedKeys: readonly string[];
  readonly addedKeys: readonly string[];
  readonly keyCount: number;
  readonly utf8Bytes: number;
  readonly environmentSha256: string;
}

export interface PreparedProcessEnvironment {
  readonly values: Readonly<Record<string, string>>;
  readonly metadata: ProcessEnvironmentMetadata;
}

export interface BuildProcessEnvironmentInput {
  readonly profile: ProcessEnvironmentProfile;
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly additions: Readonly<Record<string, string>>;
  readonly maximumKeys?: number;
  readonly maximumUtf8Bytes?: number;
}

const DEFAULT_MAXIMUM_KEYS = 128;
const DEFAULT_MAXIMUM_BYTES = 512 * 1024;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SECRET_SHAPED_KEY =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIAL|AUTH)(?:$|_)/iu;
const FORBIDDEN_ADDITIONS: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "CDPATH",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "KUBECONFIG",
  "DOCKER_CONFIG",
]);

export function buildProcessEnvironment(
  input: BuildProcessEnvironmentInput,
): PreparedProcessEnvironment {
  const maximumKeys = boundedLimit(
    input.maximumKeys ?? DEFAULT_MAXIMUM_KEYS,
    "maximumKeys",
  );
  const maximumUtf8Bytes = boundedLimit(
    input.maximumUtf8Bytes ?? DEFAULT_MAXIMUM_BYTES,
    "maximumUtf8Bytes",
  );
  validateProfileId(input.profile.profileId);
  const values: Record<string, string> = {};
  const inheritedKeys: string[] = [];
  const fixedKeys: string[] = [];
  const addedKeys: string[] = [];

  for (const key of [...input.profile.inheritedKeys].sort()) {
    validateKey(key);
    if (isCredentialKey(key)) continue;
    const value = input.ambient[key];
    if (value === undefined) continue;
    validateValue(value);
    values[key] = value;
    inheritedKeys.push(key);
  }

  for (const key of Object.keys(input.profile.fixed).sort()) {
    validateKey(key);
    if (isCredentialKey(key)) {
      throw denied("A trusted environment profile contains a credential-shaped key.");
    }
    const value = input.profile.fixed[key];
    if (value === undefined) {
      throw denied("A trusted environment profile contains an invalid value.");
    }
    validateValue(value);
    values[key] = value;
    fixedKeys.push(key);
  }

  for (const key of Object.keys(input.additions).sort()) {
    validateKey(key);
    if (
      isCredentialKey(key) ||
      FORBIDDEN_ADDITIONS.has(key.toUpperCase()) ||
      key.toUpperCase().startsWith("GIT_") ||
      Object.hasOwn(values, key)
    ) {
      throw denied("A process environment addition is not eligible for delegation.");
    }
    const value = input.additions[key];
    if (value === undefined) {
      throw denied("A process environment addition is invalid.");
    }
    validateValue(value);
    values[key] = value;
    addedKeys.push(key);
  }

  const sorted: Record<string, string> = {};
  let utf8Bytes = 0;
  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    if (value === undefined) {
      throw new ProcessToolError(
        "invariant_violated",
        "The prepared environment lost a captured value.",
      );
    }
    utf8Bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    sorted[key] = value;
  }
  if (Object.keys(sorted).length > maximumKeys || utf8Bytes > maximumUtf8Bytes) {
    throw denied("The prepared process environment exceeds its installed bound.");
  }
  const frozenValues = Object.freeze(sorted);
  const metadata = Object.freeze({
    profileId: input.profile.profileId,
    inheritedKeys: Object.freeze(inheritedKeys),
    fixedKeys: Object.freeze(fixedKeys),
    addedKeys: Object.freeze(addedKeys),
    keyCount: Object.keys(sorted).length,
    utf8Bytes,
    environmentSha256: createHash("sha256")
      .update(JSON.stringify(sorted))
      .digest("hex"),
  });
  return Object.freeze({ values: frozenValues, metadata });
}

export function isCredentialEnvironmentKey(key: string): boolean {
  return isCredentialKey(key);
}

function validateProfileId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw denied("The process environment profile identity is invalid.");
  }
}

function validateKey(key: string): void {
  if (!ENVIRONMENT_KEY.test(key)) {
    throw denied("A process environment key is invalid.");
  }
}

function validateValue(value: string): void {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > 65_536
  ) {
    throw denied("A process environment value is invalid or oversized.");
  }
}

function isCredentialKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    SECRET_SHAPED_KEY.test(upper) ||
    upper === "SSH_AUTH_SOCK" ||
    upper === "AWS_PROFILE" ||
    upper.startsWith("AWS_") ||
    upper.startsWith("AZURE_") ||
    upper.startsWith("GOOGLE_") ||
    upper.startsWith("OPENAI_") ||
    upper.startsWith("ANTHROPIC_") ||
    upper.startsWith("GEMINI_") ||
    upper.startsWith("ROBIN_CREDENTIAL_")
  );
}

function boundedLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 16 * 1024 * 1024) {
    throw denied(`${label} is invalid.`);
  }
  return value;
}

function denied(message: string): ProcessToolError {
  return new ProcessToolError("environment_denied", message);
}
