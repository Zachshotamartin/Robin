import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { ProcessToolError } from "./process-error.js";

export type VerificationKind = "test" | "check" | "lint";

export interface VerificationSuggestion {
  readonly suggestionId: string;
  readonly kind: VerificationKind;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: ".";
  readonly source: string;
  readonly sourceSha256: string;
  readonly executesRepositoryScript: boolean;
  readonly automatic: false;
}

export interface VerificationDiscoveryOptions {
  readonly maximumManifestBytes?: number;
  readonly maximumSuggestions?: number;
}

const SCRIPT_NAMES: readonly VerificationKind[] = Object.freeze([
  "test",
  "check",
  "lint",
]);

export async function discoverVerificationSuggestions(
  workspaceRoot: string,
  options: VerificationDiscoveryOptions = {},
): Promise<readonly VerificationSuggestion[]> {
  const maximumManifestBytes = boundedLimit(
    options.maximumManifestBytes ?? 256 * 1024,
    1024 * 1024,
    "maximumManifestBytes",
  );
  const maximumSuggestions = boundedLimit(
    options.maximumSuggestions ?? 16,
    64,
    "maximumSuggestions",
  );
  const root = await realpath(workspaceRoot).catch(() => {
    throw invalid("The verification workspace cannot be resolved.");
  });
  const rootFacts = await lstat(root);
  if (!rootFacts.isDirectory() || rootFacts.isSymbolicLink()) {
    throw invalid("Verification discovery requires a physical directory.");
  }
  const suggestions: VerificationSuggestion[] = [];

  const packageJson = await readOptionalBoundedFile(
    root,
    "package.json",
    maximumManifestBytes,
  );
  if (packageJson !== null) {
    const packageManager = await detectPackageManager(root);
    const scripts = parsePackageScripts(packageJson.bytes);
    for (const kind of SCRIPT_NAMES) {
      const script = scripts[kind];
      if (script === undefined) continue;
      suggestions.push(
        suggestion({
          kind,
          executable: packageManager,
          argv: ["run", kind, "--"],
          source: `package.json#scripts.${kind}`,
          sourceSha256: createHash("sha256").update(script).digest("hex"),
          executesRepositoryScript: true,
        }),
      );
    }
  }

  const cargo = await readOptionalBoundedFile(root, "Cargo.toml", maximumManifestBytes);
  if (cargo !== null) {
    suggestions.push(
      suggestion({
        kind: "test",
        executable: "cargo",
        argv: ["test"],
        source: "Cargo.toml",
        sourceSha256: cargo.sha256,
        executesRepositoryScript: false,
      }),
    );
  }

  const goModule = await readOptionalBoundedFile(root, "go.mod", maximumManifestBytes);
  if (goModule !== null) {
    suggestions.push(
      suggestion({
        kind: "test",
        executable: "go",
        argv: ["test", "./..."],
        source: "go.mod",
        sourceSha256: goModule.sha256,
        executesRepositoryScript: false,
      }),
    );
  }

  const pyproject = await readOptionalBoundedFile(
    root,
    "pyproject.toml",
    maximumManifestBytes,
  );
  if (
    pyproject !== null &&
    /^\s*\[tool\.pytest(?:\.|\])+/mu.test(pyproject.bytes.toString("utf8"))
  ) {
    suggestions.push(
      suggestion({
        kind: "test",
        executable: "python3",
        argv: ["-m", "pytest"],
        source: "pyproject.toml#tool.pytest",
        sourceSha256: pyproject.sha256,
        executesRepositoryScript: false,
      }),
    );
  }

  if (suggestions.length > maximumSuggestions) {
    throw new ProcessToolError(
      "invalid_request",
      "Verification discovery exceeded the installed suggestion bound.",
    );
  }
  return Object.freeze(suggestions);
}

async function detectPackageManager(root: string): Promise<string> {
  for (const [manifest, executable] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    const facts = await lstat(path.join(root, manifest)).catch(() => null);
    if (facts?.isFile() === true && !facts.isSymbolicLink()) return executable;
  }
  return "npm";
}

function parsePackageScripts(bytes: Buffer): Readonly<Record<string, string>> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid("package.json contains malformed JSON.");
  }
  if (!isPlainRecord(value)) throw invalid("package.json must contain an object.");
  const scripts = value["scripts"];
  if (scripts === undefined) return Object.freeze({});
  if (!isPlainRecord(scripts)) {
    throw invalid("package.json scripts must contain an object.");
  }
  const output: Record<string, string> = {};
  for (const kind of SCRIPT_NAMES) {
    const script = scripts[kind];
    if (script === undefined) continue;
    if (
      typeof script !== "string" ||
      script.includes("\u0000") ||
      Buffer.byteLength(script, "utf8") > 65_536
    ) {
      throw invalid("A recognized package script is invalid or oversized.");
    }
    output[kind] = script;
  }
  return Object.freeze(output);
}

async function readOptionalBoundedFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
): Promise<{ readonly bytes: Buffer; readonly sha256: string } | null> {
  const absolutePath = path.join(root, relativePath);
  const facts = await lstat(absolutePath, { bigint: true }).catch(() => null);
  if (facts === null) return null;
  if (!facts.isFile() || facts.isSymbolicLink()) {
    throw invalid(`Verification metadata ${relativePath} is not a regular file.`);
  }
  if (facts.size > BigInt(maximumBytes)) {
    throw invalid(`Verification metadata ${relativePath} exceeds its byte bound.`);
  }
  const handle = await open(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== bytes.byteLength ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw invalid(`Verification metadata ${relativePath} changed during read.`);
    }
    return Object.freeze({
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

function suggestion(input: {
  readonly kind: VerificationKind;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly source: string;
  readonly sourceSha256: string;
  readonly executesRepositoryScript: boolean;
}): VerificationSuggestion {
  const identityBytes = JSON.stringify([
    input.kind,
    input.executable,
    input.argv,
    input.source,
    input.sourceSha256,
  ]);
  return Object.freeze({
    suggestionId: createHash("sha256").update(identityBytes).digest("hex"),
    kind: input.kind,
    executable: input.executable,
    argv: Object.freeze([...input.argv]),
    cwd: ".",
    source: input.source,
    sourceSha256: input.sourceSha256,
    executesRepositoryScript: input.executesRepositoryScript,
    automatic: false,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function boundedLimit(value: number, ceiling: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

function invalid(message: string): ProcessToolError {
  return new ProcessToolError("invalid_request", message);
}
