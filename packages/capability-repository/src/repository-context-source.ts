import { constants, lstatSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  CONTRACT_SCHEMA_VERSION,
  canonicalize,
  createDomainError,
  isDomainError,
  sha256Hex,
} from "@guard/contracts";
import type { JsonObject, ResourceRef } from "@guard/contracts";
import {
  canonicalizeResourceRef,
  type BrokerContextSource,
  type ContextPolicyProjection,
  type ContextResourceMetadata,
  type ContextSourceDescriptor,
  type NormalizedResourceRequest,
  type OpenedContextResource,
  type SourceReadBudget,
} from "@guard/context-broker";

import { snapshotBoundaryObject } from "./boundary.js";
import { REPOSITORY_POLICY_ATTRIBUTE_CATALOG } from "./policy-catalog.js";
import { normalizeRepositoryPath } from "./repository-path.js";

const MAXIMUM_CONFIGURATION_BYTES = 1_073_741_824;
const MAXIMUM_LINE_NUMBER = 10_000_000;
const READ_SCRATCH_BYTES = 8 * 1024;
const READ_ONLY_NO_FOLLOW =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

export type RepositoryContextSelector =
  | { readonly kind: "whole" }
  | {
      readonly kind: "bytes";
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly kind: "lines";
      readonly startLine: number;
      readonly endLine: number;
    };

export interface RepositoryContextSourceOptions {
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly description: string;
  /** Trusted host configuration, never copied into a ResourceRef or manifest. */
  readonly repositoryRoot: string;
  readonly branch: string | null;
  readonly classification: string;
  readonly maximumFileBytes: number;
  readonly maximumByteSpan: number;
  readonly maximumLineSpan: number;
}

interface ParsedOptions {
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly description: string;
  readonly repositoryRoot: string;
  readonly branch: string | null;
  readonly classification: string;
  readonly maximumFileBytes: number;
  readonly maximumByteSpan: number;
  readonly maximumLineSpan: number;
}

interface ParsedRepositoryRequest {
  readonly repositoryPath: string;
  readonly selector: RepositoryContextSelector;
}

interface SelectedRead {
  readonly bytes: Uint8Array;
  readonly complete: boolean;
}

/**
 * Read-only real-filesystem coding source. It fails closed on every link,
 * multi-linked inode, sparse allocation, non-regular file, containment race,
 * and opened-object identity mismatch.
 */
export class RepositoryContextSource implements BrokerContextSource {
  readonly descriptor: ContextSourceDescriptor;
  readonly #root: string;
  readonly #rootBinding: JsonObject;
  readonly #branch: string | null;
  readonly #classification: string;
  readonly #maximumFileBytes: number;
  readonly #maximumByteSpan: number;
  readonly #maximumLineSpan: number;

  constructor(options: RepositoryContextSourceOptions) {
    const parsed = parseOptions(options);
    if (!path.isAbsolute(parsed.repositoryRoot)) {
      throw invalidInput("A repository root must be an absolute configured path.");
    }
    let canonicalRoot: string;
    let rootStats: BigIntStats;
    try {
      canonicalRoot = realpathSync.native(parsed.repositoryRoot);
      rootStats = lstatSync(canonicalRoot, { bigint: true });
    } catch {
      throw invalidInput("The configured repository root is unavailable.");
    }
    if (
      canonicalRoot === path.parse(canonicalRoot).root ||
      !rootStats.isDirectory() ||
      rootStats.isSymbolicLink()
    ) {
      throw invalidInput("The configured repository root must be a contained directory.");
    }

    this.descriptor = Object.freeze({
      sourceId: parsed.sourceId,
      sourceVersion: parsed.sourceVersion,
      scheme: "repo",
      description: parsed.description,
    });
    this.#root = canonicalRoot;
    this.#rootBinding = statIdentity(rootStats);
    this.#branch = parsed.branch;
    this.#classification = parsed.classification;
    this.#maximumFileBytes = parsed.maximumFileBytes;
    this.#maximumByteSpan = parsed.maximumByteSpan;
    this.#maximumLineSpan = parsed.maximumLineSpan;
    Object.freeze(this);
  }

  normalizeResourceRequest(input: unknown): NormalizedResourceRequest {
    const parsed = parseRepositoryRequest(
      input,
      this.#maximumByteSpan,
      this.#maximumLineSpan,
    );
    const selector = selectorJson(parsed.selector);
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sourceId: this.descriptor.sourceId,
      sourceVersion: this.descriptor.sourceVersion,
      resource: this.#resource(parsed.repositoryPath),
      selector,
    });
  }

  async inspectMetadata(
    request: NormalizedResourceRequest,
    signal: AbortSignal,
  ): Promise<ContextResourceMetadata> {
    assertNotAborted(signal);
    const parsed = this.#parseNormalizedRequest(request);
    await this.#assertRootStable();
    const target = this.#target(parsed.repositoryPath);
    const stats = await inspectContainedRegularFile(this.#root, target);
    const size = safeStatNumber(stats.size, "file size");
    assertEligibleRegularFile(stats, this.#maximumFileBytes);
    const selectedByteLength = selectedSize(parsed.selector, size);
    const mediaType = mediaTypeForPath(parsed.repositoryPath);
    const resource = this.#resource(parsed.repositoryPath, mediaType);
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sourceId: this.descriptor.sourceId,
      sourceVersion: this.descriptor.sourceVersion,
      resource,
      selector: selectorJson(parsed.selector),
      byteLength: size,
      selectedByteLength,
      mediaType,
      classification: this.#classification,
      kind: "regular_file",
      policyProjection: this.#policyProjection(parsed.repositoryPath, parsed.selector),
      binding: statBinding(stats),
    });
  }

  async openBounded(
    request: NormalizedResourceRequest,
    expected: ContextResourceMetadata,
    budget: SourceReadBudget,
    signal: AbortSignal,
  ): Promise<OpenedContextResource> {
    assertNotAborted(signal);
    const maximumBytes = parseReadBudget(budget);
    const parsed = this.#parseNormalizedRequest(request);
    this.#assertExpectedMetadata(expected, request);
    await this.#assertRootStable();
    const target = this.#target(parsed.repositoryPath);
    await inspectContainedRegularFile(this.#root, target);

    let handle: FileHandle;
    try {
      handle = await open(target, READ_ONLY_NO_FOLLOW);
    } catch {
      throw conflict("The repository resource changed before it could be opened.");
    }
    try {
      const openedStats = await handle.stat({ bigint: true });
      assertEligibleRegularFile(openedStats, this.#maximumFileBytes);
      if (canonicalize(statBinding(openedStats)) !== canonicalize(expected.binding)) {
        throw conflict("The opened repository object does not match approved metadata.");
      }
      await assertPathStillBinds(this.#root, target, openedStats);
      assertNotAborted(signal);
      const selected = await readSelection(
        handle,
        parsed.selector,
        safeStatNumber(openedStats.size, "file size"),
        maximumBytes,
        signal,
      );
      const afterStats = await handle.stat({ bigint: true });
      if (canonicalize(statBinding(afterStats)) !== canonicalize(statBinding(openedStats))) {
        throw conflict("The repository object changed while it was being read.");
      }
      await assertPathStillBinds(this.#root, target, afterStats);
      const bytes = Uint8Array.from(selected.bytes);
      const mediaType = mediaTypeForPath(parsed.repositoryPath);
      return Object.freeze({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        sourceId: this.descriptor.sourceId,
        sourceVersion: this.descriptor.sourceVersion,
        resource: this.#resource(parsed.repositoryPath, mediaType),
        policyProjection: this.#policyProjection(
          parsed.repositoryPath,
          parsed.selector,
        ),
        selector: selectorJson(parsed.selector),
        mediaType,
        classification: this.#classification,
        binding: statBinding(afterStats),
        bytes,
        byteLength: bytes.byteLength,
        contentHash: sha256Hex(bytes),
        selectionComplete: selected.complete,
        truncated: !selected.complete,
      });
    } catch (error: unknown) {
      if (isDomainError(error)) throw error;
      throw conflict("The opened repository object could not be read safely.");
    } finally {
      try {
        await handle.close();
      } catch {
        throw conflict("The repository read handle could not be closed safely.");
      }
    }
  }

  #parseNormalizedRequest(
    request: NormalizedResourceRequest,
  ): ParsedRepositoryRequest {
    const detached = snapshotBoundaryObject(
      request,
      "Normalized repository context request",
    );
    if (
      !hasExactKeys(detached, [
        "schemaVersion",
        "sourceId",
        "sourceVersion",
        "resource",
        "selector",
      ]) ||
      detached["schemaVersion"] !== CONTRACT_SCHEMA_VERSION ||
      detached["sourceId"] !== this.descriptor.sourceId ||
      detached["sourceVersion"] !== this.descriptor.sourceVersion
    ) {
      throw invalidInput("A normalized repository request has a source mismatch.");
    }
    const resource = canonicalizeResourceRef(detached["resource"], {
      scheme: "repo",
      sourceId: this.descriptor.sourceId,
    });
    const locator = resource.locator;
    const locatorKeys = this.#branch === null ? ["path"] : ["branch", "path"];
    if (!hasExactKeys(locator, locatorKeys)) {
      throw invalidInput("A repository resource locator is malformed.");
    }
    const repositoryPath = normalizeRepositoryPath(locator["path"], {
      allowRoot: false,
    });
    if (
      (this.#branch === null && Object.hasOwn(locator, "branch")) ||
      (this.#branch !== null && locator["branch"] !== this.#branch) ||
      resource.classification !== this.#classification
    ) {
      throw invalidInput("A repository resource locator changed after normalization.");
    }
    const selector = parseSelector(
      detached["selector"],
      this.#maximumByteSpan,
      this.#maximumLineSpan,
    );
    if (
      resource.mediaType !== null &&
      resource.mediaType !== mediaTypeForPath(repositoryPath)
    ) {
      throw invalidInput("A repository resource media type is not canonical.");
    }
    return Object.freeze({ repositoryPath, selector });
  }

  #assertExpectedMetadata(
    expected: ContextResourceMetadata,
    request: NormalizedResourceRequest,
  ): void {
    if (
      expected.sourceId !== this.descriptor.sourceId ||
      expected.sourceVersion !== this.descriptor.sourceVersion ||
      canonicalize(expected.resource) !== canonicalize(request.resource) ||
      canonicalize(expected.selector) !== canonicalize(request.selector) ||
      expected.kind !== "regular_file" ||
      expected.classification !== this.#classification
    ) {
      throw conflict("Approved repository metadata does not match the request.");
    }
  }

  async #assertRootStable(): Promise<void> {
    let current: BigIntStats;
    try {
      current = await lstat(this.#root, { bigint: true });
    } catch {
      throw conflict("The repository root changed after source installation.");
    }
    if (
      !current.isDirectory() ||
      canonicalize(statIdentity(current)) !== canonicalize(this.#rootBinding)
    ) {
      throw conflict("The repository root changed after source installation.");
    }
  }

  #target(repositoryPath: string): string {
    const target = path.resolve(this.#root, ...repositoryPath.split("/"));
    assertContained(this.#root, target);
    return target;
  }

  #resource(
    repositoryPath: string,
    mediaType = mediaTypeForPath(repositoryPath),
  ): ResourceRef {
    const locator: JsonObject =
      this.#branch === null
        ? { path: repositoryPath }
        : { branch: this.#branch, path: repositoryPath };
    return canonicalizeResourceRef({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      scheme: "repo",
      sourceId: this.descriptor.sourceId,
      locator,
      mediaType,
      classification: this.#classification,
    });
  }

  #policyProjection(
    repositoryPath: string,
    selector: RepositoryContextSelector,
  ): ContextPolicyProjection {
    const resourceAttributes: JsonObject =
      this.#branch === null
        ? { path: repositoryPath }
        : { branch: this.#branch, path: repositoryPath };
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      catalogId: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
      catalogVersion: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
      catalogContentHash: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
      resourceAttributes: Object.freeze(resourceAttributes),
      requestAttributes: selectorJson(selector),
    });
  }
}

async function inspectContainedRegularFile(
  root: string,
  target: string,
): Promise<BigIntStats> {
  assertContained(root, target);
  const relative = path.relative(root, target);
  const segments = relative.split(path.sep);
  let current = root;
  let finalStats: BigIntStats | null = null;
  try {
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]!);
      const stats = await lstat(current, { bigint: true });
      if (stats.isSymbolicLink()) {
        throw invalidInput("Repository symlinks are denied by the v1 source policy.");
      }
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw invalidInput("A repository path component is not a directory.");
      }
      if (index === segments.length - 1) finalStats = stats;
    }
    const canonicalTarget = await realpath(target);
    assertContained(root, canonicalTarget);
    const stable = await lstat(target, { bigint: true });
    if (
      finalStats === null ||
      canonicalize(statIdentity(stable)) !== canonicalize(statIdentity(finalStats))
    ) {
      throw conflict("The repository resource changed during metadata inspection.");
    }
    assertEligibleRegularFile(stable, MAXIMUM_CONFIGURATION_BYTES);
    return stable;
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw invalidInput("The repository resource could not be inspected safely.");
  }
}

async function assertPathStillBinds(
  root: string,
  target: string,
  openedStats: BigIntStats,
): Promise<void> {
  try {
    const canonicalTarget = await realpath(target);
    assertContained(root, canonicalTarget);
    const pathStats = await lstat(target, { bigint: true });
    if (
      pathStats.isSymbolicLink() ||
      canonicalize(statIdentity(pathStats)) !== canonicalize(statIdentity(openedStats))
    ) {
      throw conflict("The repository path no longer names the opened object.");
    }
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw conflict("The repository path changed while its object was open.");
  }
}

function assertEligibleRegularFile(stats: BigIntStats, maximumBytes: number): void {
  if (!stats.isFile()) {
    throw invalidInput("Only regular repository files can enter context.");
  }
  if (stats.nlink !== 1n) {
    throw invalidInput("Multi-linked repository files are denied.");
  }
  if (stats.size > BigInt(maximumBytes)) {
    throw budgetExceeded("The repository file exceeds its configured size ceiling.");
  }
  if (stats.size > 0n && stats.blocks * 512n < stats.size) {
    throw invalidInput("Sparse repository files are denied.");
  }
}

async function readSelection(
  handle: FileHandle,
  selector: RepositoryContextSelector,
  fileSize: number,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<SelectedRead> {
  if (selector.kind === "lines") {
    return readLines(handle, selector, maximumBytes, signal);
  }
  const offset = selector.kind === "bytes" ? selector.offset : 0;
  const available = Math.max(0, fileSize - offset);
  const selectedLength =
    selector.kind === "bytes" ? Math.min(selector.length, available) : available;
  const outputLength = Math.min(selectedLength, maximumBytes);
  const output = Buffer.alloc(outputLength);
  let readLength = 0;
  while (readLength < outputLength) {
    assertNotAborted(signal);
    const result = await handle.read(
      output,
      readLength,
      outputLength - readLength,
      offset + readLength,
    );
    if (result.bytesRead === 0) {
      throw conflict("The repository file became shorter while being read.");
    }
    readLength += result.bytesRead;
  }
  return Object.freeze({
    bytes: Uint8Array.from(output),
    complete: outputLength === selectedLength,
  });
}

async function readLines(
  handle: FileHandle,
  selector: Extract<RepositoryContextSelector, { readonly kind: "lines" }>,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<SelectedRead> {
  const output = Buffer.alloc(maximumBytes);
  const scratch = Buffer.alloc(Math.min(READ_SCRATCH_BYTES, maximumBytes));
  let outputLength = 0;
  let position = 0;
  let line = 1;
  let complete = false;
  let truncated = false;
  while (!complete && !truncated) {
    assertNotAborted(signal);
    const result = await handle.read(scratch, 0, scratch.byteLength, position);
    if (result.bytesRead === 0) {
      complete = true;
      break;
    }
    position += result.bytesRead;
    for (let index = 0; index < result.bytesRead; index += 1) {
      const byte = scratch[index]!;
      if (line < selector.startLine) {
        if (byte === 0x0a) line += 1;
        continue;
      }
      if (line > selector.endLine) {
        complete = true;
        break;
      }
      if (byte === 0x0a) {
        if (line === selector.endLine) {
          complete = true;
          break;
        }
        if (outputLength >= maximumBytes) {
          truncated = true;
          break;
        }
        output[outputLength] = byte;
        outputLength += 1;
        line += 1;
        continue;
      }
      if (outputLength >= maximumBytes) {
        truncated = true;
        break;
      }
      output[outputLength] = byte;
      outputLength += 1;
    }
  }
  return Object.freeze({
    bytes: Uint8Array.from(output.subarray(0, outputLength)),
    complete: complete && !truncated,
  });
}

function parseOptions(input: unknown): ParsedOptions {
  const value = snapshotBoundaryObject(input, "Repository context source options");
  if (
    !hasExactKeys(value, [
      "sourceId",
      "sourceVersion",
      "description",
      "repositoryRoot",
      "branch",
      "classification",
      "maximumFileBytes",
      "maximumByteSpan",
      "maximumLineSpan",
    ])
  ) {
    throw invalidInput("Repository context source options are incomplete or unknown.");
  }
  const sourceId = safeIdentifier(value["sourceId"], "sourceId");
  const sourceVersion = positiveInteger(value["sourceVersion"], "sourceVersion");
  const description = boundedText(value["description"], "description", 512);
  const repositoryRoot = boundedText(
    value["repositoryRoot"],
    "repositoryRoot",
    4_096,
  );
  if (/\u0000/u.test(repositoryRoot)) {
    throw invalidInput("A repository root contains a NUL byte.");
  }
  const branch =
    value["branch"] === null
      ? null
      : boundedText(value["branch"], "branch", 512).normalize("NFC");
  if (branch !== null && /[\u0000-\u001f\u007f]/u.test(branch)) {
    throw invalidInput("A repository branch contains control characters.");
  }
  const classification = safeIdentifier(
    value["classification"],
    "classification",
  );
  const maximumFileBytes = boundedPositiveInteger(
    value["maximumFileBytes"],
    "maximumFileBytes",
    MAXIMUM_CONFIGURATION_BYTES,
  );
  const maximumByteSpan = boundedPositiveInteger(
    value["maximumByteSpan"],
    "maximumByteSpan",
    maximumFileBytes,
  );
  const maximumLineSpan = boundedPositiveInteger(
    value["maximumLineSpan"],
    "maximumLineSpan",
    MAXIMUM_LINE_NUMBER,
  );
  return Object.freeze({
    sourceId,
    sourceVersion,
    description,
    repositoryRoot,
    branch,
    classification,
    maximumFileBytes,
    maximumByteSpan,
    maximumLineSpan,
  });
}

function parseRepositoryRequest(
  input: unknown,
  maximumByteSpan: number,
  maximumLineSpan: number,
): ParsedRepositoryRequest {
  const value = snapshotBoundaryObject(input, "Repository context request");
  if (!hasExactKeys(value, ["path", "selector"])) {
    throw invalidInput("A repository context request is malformed.");
  }
  return Object.freeze({
    repositoryPath: normalizeRepositoryPath(value["path"], { allowRoot: false }),
    selector: parseSelector(value["selector"], maximumByteSpan, maximumLineSpan),
  });
}

function parseSelector(
  input: unknown,
  maximumByteSpan: number,
  maximumLineSpan: number,
): RepositoryContextSelector {
  const value = snapshotBoundaryObject(input, "Repository context selector");
  if (value["kind"] === "whole" && hasExactKeys(value, ["kind"])) {
    return Object.freeze({ kind: "whole" });
  }
  if (value["kind"] === "bytes" && hasExactKeys(value, ["kind", "offset", "length"])) {
    const offset = nonNegativeInteger(value["offset"], "selector offset");
    const length = boundedPositiveInteger(
      value["length"],
      "selector length",
      maximumByteSpan,
    );
    return Object.freeze({ kind: "bytes", offset, length });
  }
  if (
    value["kind"] === "lines" &&
    hasExactKeys(value, ["kind", "startLine", "endLine"])
  ) {
    const startLine = boundedPositiveInteger(
      value["startLine"],
      "selector startLine",
      MAXIMUM_LINE_NUMBER,
    );
    const endLine = boundedPositiveInteger(
      value["endLine"],
      "selector endLine",
      MAXIMUM_LINE_NUMBER,
    );
    if (endLine < startLine || endLine - startLine + 1 > maximumLineSpan) {
      throw budgetExceeded("The requested line selector exceeds its configured span.");
    }
    return Object.freeze({ kind: "lines", startLine, endLine });
  }
  throw invalidInput("A repository context selector is malformed or unsupported.");
}

function selectorJson(selector: RepositoryContextSelector): JsonObject {
  return Object.freeze({ ...selector });
}

function selectedSize(
  selector: RepositoryContextSelector,
  fileSize: number,
): number | null {
  if (selector.kind === "lines") return null;
  if (selector.kind === "whole") return fileSize;
  if (selector.offset > fileSize) {
    throw invalidInput("A byte selector offset exceeds the repository file size.");
  }
  return Math.min(selector.length, fileSize - selector.offset);
}

function parseReadBudget(input: unknown): number {
  const value = snapshotBoundaryObject(input, "Repository source read budget");
  if (!hasExactKeys(value, ["maximumBytes"])) {
    throw invalidInput("A repository source read budget is malformed.");
  }
  return boundedPositiveInteger(
    value["maximumBytes"],
    "maximumBytes",
    MAXIMUM_CONFIGURATION_BYTES,
  );
}

function statIdentity(stats: BigIntStats): JsonObject {
  return Object.freeze({
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    mode: Number(stats.mode),
  });
}

function statBinding(stats: BigIntStats): JsonObject {
  return Object.freeze({
    ...statIdentity(stats),
    size: safeStatNumber(stats.size, "file size"),
    links: safeStatNumber(stats.nlink, "link count"),
    blocks: safeStatNumber(stats.blocks, "allocated block count"),
    modifiedNanoseconds: stats.mtimeNs.toString(10),
    changedNanoseconds: stats.ctimeNs.toString(10),
  });
}

function safeStatNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw invalidInput(`Repository ${label} is outside the supported range.`);
  }
  return number;
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw invalidInput("A repository path is outside its configured root.");
  }
}

function mediaTypeForPath(repositoryPath: string): string {
  const extension = path.posix.extname(repositoryPath).toLowerCase();
  const mediaTypes: Readonly<Record<string, string>> = Object.freeze({
    ".c": "text/plain",
    ".cc": "text/plain",
    ".conf": "text/plain",
    ".cpp": "text/plain",
    ".css": "text/css",
    ".csv": "text/csv",
    ".go": "text/plain",
    ".h": "text/plain",
    ".hpp": "text/plain",
    ".html": "text/html",
    ".java": "text/plain",
    ".js": "text/javascript",
    ".json": "application/json",
    ".jsx": "text/javascript",
    ".md": "text/markdown",
    ".mjs": "text/javascript",
    ".py": "text/x-python",
    ".rb": "text/plain",
    ".rs": "text/plain",
    ".sh": "text/x-shellscript",
    ".sql": "text/plain",
    ".toml": "text/plain",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".txt": "text/plain",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  });
  return mediaTypes[extension] ?? "application/octet-stream";
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function safeIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw invalidInput(`Repository ${label} is not a canonical identifier.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw invalidInput(`Repository ${label} is missing or exceeds its byte bound.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidInput(`Repository ${label} must be a positive safe integer.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidInput(`Repository ${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function boundedPositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  const parsed = positiveInteger(value, label);
  if (parsed > maximum) {
    throw budgetExceeded(`Repository ${label} exceeds its configured ceiling.`);
  }
  return parsed;
}

function assertNotAborted(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw createDomainError({
      code: signal instanceof AbortSignal ? "cancelled" : "invalid_input",
      message:
        signal instanceof AbortSignal
          ? "The repository context read was cancelled."
          : "A repository context read requires an AbortSignal.",
    });
  }
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}

function conflict(message: string) {
  return createDomainError({ code: "conflict", message });
}

function budgetExceeded(message: string) {
  return createDomainError({ code: "budget_exceeded", message });
}
