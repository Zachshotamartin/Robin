import { lstat } from "node:fs/promises";
import path from "node:path";

import { createDomainError } from "@guard/contracts";

import {
  closeStableFile,
  finishStableRead,
  normalizeWorkspaceRelativePath,
  openStableRegularFile,
  type WorkspaceRelativePath,
} from "./physical-path.js";
import {
  assertWorkspaceRootStable,
  workspaceHandleState,
  type WorkspaceHandle,
} from "./physical-workspace.js";
import type { PathClassification } from "./file-classification.js";
import { fileBindingFromStats } from "./workspace-identity.js";

export type IgnoreSource =
  | "hard_security"
  | "explicit_include"
  | "robin_ignore"
  | "git_ignore"
  | "default_generated"
  | "hidden_policy"
  | "none";

export interface IgnoreDecision {
  readonly ignored: boolean;
  readonly source: IgnoreSource;
  readonly reason: string;
}

export interface GitIgnoreProbe {
  ignoredPaths(
    paths: readonly WorkspaceRelativePath[],
    signal: AbortSignal,
  ): Promise<ReadonlySet<string>>;
}

export interface IgnorePolicyOptions {
  readonly includeHidden: boolean;
  readonly includeGenerated: boolean;
  readonly explicitIncludes?: readonly string[];
  readonly gitIgnoreProbe?: GitIgnoreProbe;
  readonly maximumRobinIgnoreBytes?: number;
}

interface CompiledIgnoreRule {
  readonly negate: boolean;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
  readonly segments: readonly string[];
}

export class WorkspaceIgnorePolicy {
  readonly #explicitIncludes: ReadonlySet<string>;
  readonly #robinRules: readonly CompiledIgnoreRule[];
  readonly #includeHidden: boolean;
  readonly #includeGenerated: boolean;
  readonly #gitProbe: GitIgnoreProbe | undefined;

  public constructor(input: {
    readonly explicitIncludes: ReadonlySet<string>;
    readonly robinRules: readonly CompiledIgnoreRule[];
    readonly includeHidden: boolean;
    readonly includeGenerated: boolean;
    readonly gitProbe?: GitIgnoreProbe;
  }) {
    this.#explicitIncludes = input.explicitIncludes;
    this.#robinRules = input.robinRules;
    this.#includeHidden = input.includeHidden;
    this.#includeGenerated = input.includeGenerated;
    this.#gitProbe = input.gitProbe;
  }

  public async decide(
    workspacePath: WorkspaceRelativePath,
    classification: PathClassification,
    signal: AbortSignal,
  ): Promise<IgnoreDecision> {
    if (workspacePath === ".git" || workspacePath.startsWith(".git/")) {
      return decision(true, "hard_security", "git_administration");
    }
    if (classification.kind !== "regular_file" && classification.kind !== "directory") {
      if (classification.kind === "symlink") return decision(false, "none", "visible_link");
      return decision(true, "hard_security", "unsupported_file_type");
    }
    if (classification.secretLikely) {
      return decision(true, "hard_security", "secret_likely_path");
    }
    const explicitlyIncluded = this.#explicitIncludes.has(workspacePath);
    if (explicitlyIncluded) {
      return decision(false, "explicit_include", "legal_explicit_include");
    }
    const robinIgnored = evaluateRules(this.#robinRules, workspacePath);
    if (robinIgnored) return decision(true, "robin_ignore", "robin_ignore_rule");
    if (this.#gitProbe !== undefined) {
      const ignored = await this.#gitProbe.ignoredPaths([workspacePath], signal);
      if (ignored.has(workspacePath)) {
        return decision(true, "git_ignore", "git_ignore_rule");
      }
    }
    if (classification.generated && !this.#includeGenerated) {
      return decision(true, "default_generated", "generated_or_dependency_path");
    }
    if (classification.hidden && !this.#includeHidden) {
      return decision(true, "hidden_policy", "hidden_path");
    }
    return decision(false, "none", "included");
  }
}

export async function createWorkspaceIgnorePolicy(
  workspace: WorkspaceHandle,
  options: IgnorePolicyOptions,
): Promise<WorkspaceIgnorePolicy> {
  const maximumBytes = options.maximumRobinIgnoreBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw invalid("The .robinignore byte limit must be a positive safe integer.");
  }
  const includes = new Set<string>();
  for (const candidate of options.explicitIncludes ?? []) {
    includes.add(
      normalizeWorkspaceRelativePath(candidate, { allowRoot: false }),
    );
  }
  const state = workspaceHandleState(workspace);
  const ignorePath = path.join(state.physicalRoot, ".robinignore");
  let source = "";
  try {
    await assertWorkspaceRootStable(workspace);
    const metadata = await lstat(ignorePath, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw invalid("The .robinignore path must be a physical regular file.");
    }
    const opened = await openStableRegularFile(workspace, ".robinignore", {
      maximumFileBytes: maximumBytes,
      expectedBinding: fileBindingFromStats(metadata),
    });
    try {
      const bytes = Buffer.alloc(opened.binding.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await opened.handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (result.bytesRead < 1) {
          throw createDomainError({
            code: "conflict",
            message: "The .robinignore file changed while it was read.",
          });
        }
        offset += result.bytesRead;
      }
      await finishStableRead(workspace, opened);
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      await closeStableFile(opened);
    }
  } catch (error: unknown) {
    if (isNodeErrorCode(error, "ENOENT")) source = "";
    else if (isDomainErrorLike(error)) throw error;
    else throw invalid("The .robinignore file is not valid bounded UTF-8 text.");
  }
  return new WorkspaceIgnorePolicy({
    explicitIncludes: includes,
    robinRules: compileIgnoreRules(source),
    includeHidden: options.includeHidden,
    includeGenerated: options.includeGenerated,
    ...(options.gitIgnoreProbe === undefined
      ? {}
      : { gitProbe: options.gitIgnoreProbe }),
  });
}

export function compileIgnoreRules(source: string): readonly CompiledIgnoreRule[] {
  const rules: CompiledIgnoreRule[] = [];
  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine.length === 0 || rawLine.startsWith("#")) continue;
    let line = rawLine;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (
      line.length === 0 ||
      line.includes("\u0000") ||
      line.includes("\\") ||
      Buffer.byteLength(line, "utf8") > 4_096
    ) {
      throw invalid("A .robinignore rule is empty, ambiguous, or oversized.");
    }
    const segments = line.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw invalid("A .robinignore rule contains an unsupported path component.");
    }
    rules.push(Object.freeze({
      negate,
      directoryOnly,
      anchored,
      segments: Object.freeze(segments.map((segment) => segment.normalize("NFC"))),
    }));
    if (rules.length > 4_096) {
      throw invalid("The .robinignore file contains too many rules.");
    }
  }
  return Object.freeze(rules);
}

function evaluateRules(
  rules: readonly CompiledIgnoreRule[],
  workspacePath: WorkspaceRelativePath,
): boolean {
  const pathSegments = workspacePath.split("/");
  let ignored = false;
  for (const rule of rules) {
    if (matchesRule(rule, pathSegments)) ignored = !rule.negate;
  }
  return ignored;
}

function matchesRule(
  rule: CompiledIgnoreRule,
  pathSegments: readonly string[],
): boolean {
  const starts = rule.anchored
    ? [0]
    : Array.from({ length: pathSegments.length }, (_, index) => index);
  return starts.some((start) => matchSegments(rule.segments, 0, pathSegments, start));
}

function matchSegments(
  pattern: readonly string[],
  patternIndex: number,
  value: readonly string[],
  valueIndex: number,
): boolean {
  if (patternIndex === pattern.length) return valueIndex === value.length;
  const current = pattern[patternIndex]!;
  if (current === "**") {
    for (let next = valueIndex; next <= value.length; next += 1) {
      if (matchSegments(pattern, patternIndex + 1, value, next)) return true;
    }
    return false;
  }
  if (valueIndex >= value.length || !matchComponent(current, value[valueIndex]!)) {
    return false;
  }
  return matchSegments(pattern, patternIndex + 1, value, valueIndex + 1);
}

function matchComponent(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let star = -1;
  let checkpoint = -1;
  while (valueIndex < value.length) {
    if (
      patternIndex < pattern.length &&
      (pattern[patternIndex] === "?" || pattern[patternIndex] === value[valueIndex])
    ) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (pattern[patternIndex] === "*") {
      star = patternIndex;
      checkpoint = valueIndex;
      patternIndex += 1;
    } else if (star >= 0) {
      patternIndex = star + 1;
      checkpoint += 1;
      valueIndex = checkpoint;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function decision(
  ignored: boolean,
  source: IgnoreSource,
  reason: string,
): IgnoreDecision {
  return Object.freeze({ ignored, source, reason });
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly code?: unknown }).code === code
  );
}

function isDomainErrorLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && "errorId" in value;
}

function invalid(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
