import { createDomainError, sha256Hex } from "@guard/contracts";
import type { JsonObject } from "@guard/contracts";

import {
  classifyTextBytes,
  classifyWorkspacePath,
  type NewlineStyle,
  type TextEncoding,
} from "./file-classification.js";
import {
  closeStableFile,
  finishStableRead,
  openStableRegularFile,
  type PhysicalPathRaceHooks,
} from "./physical-path.js";
import type { WorkspaceHandle } from "./physical-workspace.js";

export type PhysicalReadSelector =
  | { readonly kind: "whole" }
  | { readonly kind: "bytes"; readonly offset: number; readonly length: number }
  | { readonly kind: "lines"; readonly startLine: number; readonly endLine: number };

export interface PhysicalReadFileRequest {
  readonly path: string;
  readonly selector: PhysicalReadSelector;
  readonly maximumFileBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumLineSpan: number;
  readonly preserveAtime: boolean;
  readonly allowGenerated: boolean;
}

export type PhysicalReadFileResult =
  | (JsonObject & {
      readonly status: "released";
      readonly path: string;
      readonly content: string;
      readonly sourceSha256: string;
      readonly sourceBytes: number;
      readonly selectedBytes: number;
      readonly encoding: TextEncoding;
      readonly newlineStyle: NewlineStyle;
      readonly startLine: number | null;
      readonly endLine: number | null;
      readonly leadingPartialLine: boolean;
      readonly trailingPartialLine: boolean;
      readonly truncated: boolean;
      readonly atimePreserved: boolean;
      readonly fileIdentity: JsonObject;
      readonly promptInjectionTags: readonly string[];
    })
  | (JsonObject & {
      readonly status: "withheld";
      readonly path: string;
      readonly reason:
        | "restricted_path"
        | "generated_file"
        | "binary"
        | "invalid_encoding"
        | "restricted_content";
      readonly sourceBytes: number;
      readonly encoding: TextEncoding | null;
      readonly newlineStyle: NewlineStyle | null;
      readonly categories: readonly JsonObject[];
    });

export interface PhysicalReadDependencies {
  readonly hooks?: PhysicalPathRaceHooks;
}

export async function readPhysicalFile(
  workspace: WorkspaceHandle,
  request: PhysicalReadFileRequest,
  signal: AbortSignal,
  dependencies: PhysicalReadDependencies = {},
): Promise<PhysicalReadFileResult> {
  validateReadRequest(request);
  assertSignal(signal);
  const opened = await openStableRegularFile(workspace, request.path, {
    maximumFileBytes: request.maximumFileBytes,
    preserveAtime: request.preserveAtime,
    ...(dependencies.hooks === undefined ? {} : { hooks: dependencies.hooks }),
  });
  let primaryFailure: unknown;
  try {
    const pathClassification = classifyWorkspacePath(opened.path, opened.binding);
    if (pathClassification.secretLikely) {
      await finishStableRead(workspace, opened, dependencies.hooks);
      return withheld(opened.path, "restricted_path", opened.binding.size, null, null, []);
    }
    if (pathClassification.generated && !request.allowGenerated) {
      await finishStableRead(workspace, opened, dependencies.hooks);
      return withheld(opened.path, "generated_file", opened.binding.size, null, null, []);
    }
    const bytes = await readExactBytes(opened, signal);
    const classification = classifyTextBytes(bytes, pathClassification.mediaType);
    await finishStableRead(workspace, opened, dependencies.hooks);
    if (!classification.accepted || classification.text === null) {
      const reason = classification.withheldReason === "secret_content"
        ? "restricted_content"
        : classification.withheldReason === "invalid_encoding"
          ? "invalid_encoding"
          : "binary";
      return withheld(
        opened.path,
        reason,
        opened.binding.size,
        classification.encoding,
        classification.newlineStyle,
        classification.secretCategories.map((category) =>
          Object.freeze({ category: category.category, count: category.count }),
        ),
      );
    }
    const selected = selectText(
      bytes,
      classification.text,
      classification.encoding,
      request.selector,
      request.maximumOutputBytes,
    );
    return Object.freeze({
      status: "released",
      path: opened.path,
      content: selected.content,
      sourceSha256: sha256Hex(bytes),
      sourceBytes: bytes.byteLength,
      selectedBytes: Buffer.byteLength(selected.content, "utf8"),
      encoding: classification.encoding,
      newlineStyle: classification.newlineStyle,
      startLine: selected.startLine,
      endLine: selected.endLine,
      leadingPartialLine: selected.leadingPartialLine,
      trailingPartialLine: selected.trailingPartialLine,
      truncated: selected.truncated,
      atimePreserved: opened.atimePreserved,
      fileIdentity: opened.binding.identity,
      promptInjectionTags: classification.promptInjectionTags,
    });
  } catch (error: unknown) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await closeStableFile(opened);
    } catch (closeError: unknown) {
      if (primaryFailure === undefined) throw closeError;
    }
  }
}

async function readExactBytes(
  opened: Awaited<ReturnType<typeof openStableRegularFile>>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const output = Buffer.alloc(opened.binding.size);
  let offset = 0;
  while (offset < output.byteLength) {
    assertSignal(signal);
    const result = await opened.handle.read(
      output,
      offset,
      Math.min(64 * 1024, output.byteLength - offset),
      offset,
    );
    if (result.bytesRead === 0) {
      throw createDomainError({
        code: "conflict",
        message: "The workspace file became shorter while it was read.",
      });
    }
    offset += result.bytesRead;
  }
  return Uint8Array.from(output);
}

function selectText(
  sourceBytes: Uint8Array,
  decodedText: string,
  encoding: TextEncoding,
  selector: PhysicalReadSelector,
  maximumOutputBytes: number,
): {
  readonly content: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly leadingPartialLine: boolean;
  readonly trailingPartialLine: boolean;
  readonly truncated: boolean;
} {
  if (selector.kind === "lines") {
    const lines = splitLinesPreservingTerminators(decodedText);
    if (selector.startLine > Math.max(lines.length, 1)) {
      throw createDomainError({
        code: "invalid_input",
        message: "The requested start line is beyond the workspace file.",
      });
    }
    const selected = lines
      .slice(selector.startLine - 1, selector.endLine)
      .join("");
    const bounded = truncateUtf8(selected, maximumOutputBytes);
    return Object.freeze({
      content: bounded.text,
      startLine: selector.startLine,
      endLine: Math.min(selector.endLine, Math.max(lines.length, 1)),
      leadingPartialLine: false,
      trailingPartialLine: bounded.truncated,
      truncated: bounded.truncated || selector.endLine < lines.length,
    });
  }
  if (selector.kind === "whole") {
    const bounded = truncateUtf8(decodedText, maximumOutputBytes);
    return Object.freeze({
      content: bounded.text,
      startLine: decodedText.length === 0 ? null : 1,
      endLine: decodedText.length === 0 ? null : countLogicalLines(decodedText),
      leadingPartialLine: false,
      trailingPartialLine: bounded.truncated,
      truncated: bounded.truncated,
    });
  }

  const bomBytes = encoding === "utf8_bom" ? 3 : 0;
  const body = sourceBytes.subarray(bomBytes);
  if (selector.offset > body.byteLength) {
    throw createDomainError({
      code: "invalid_input",
      message: "The requested byte offset is beyond the workspace file.",
    });
  }
  const end = Math.min(body.byteLength, selector.offset + selector.length);
  const selected = body.subarray(selector.offset, end);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(selected);
  } catch {
    throw createDomainError({
      code: "invalid_input",
      message: "The requested byte window splits a UTF-8 scalar.",
    });
  }
  const bounded = truncateUtf8(text, maximumOutputBytes);
  const leadingPartialLine = selector.offset > 0 && body[selector.offset - 1] !== 0x0a;
  const trailingPartialLine = end < body.byteLength && selected.at(-1) !== 0x0a;
  return Object.freeze({
    content: bounded.text,
    startLine: null,
    endLine: null,
    leadingPartialLine,
    trailingPartialLine: trailingPartialLine || bounded.truncated,
    truncated: bounded.truncated || end < body.byteLength,
  });
}

function splitLinesPreservingTerminators(text: string): readonly string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x0a) continue;
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return Object.freeze(lines);
}

function countLogicalLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (const character of text) if (character === "\n") count += 1;
  return text.endsWith("\n") ? count - 1 : count;
}

function truncateUtf8(value: string, maximumBytes: number): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return Object.freeze({ text: value, truncated: false });
  }
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return Object.freeze({
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
        truncated: true,
      });
    } catch {
      continue;
    }
  }
  throw createDomainError({
    code: "invariant_violated",
    message: "A bounded read could not find a UTF-8 boundary.",
  });
}

function validateReadRequest(request: PhysicalReadFileRequest): void {
  for (const [name, value] of [
    ["maximumFileBytes", request.maximumFileBytes],
    ["maximumOutputBytes", request.maximumOutputBytes],
    ["maximumLineSpan", request.maximumLineSpan],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw createDomainError({
        code: "invalid_input",
        message: `${name} must be a positive safe integer.`,
      });
    }
  }
  const selector = request.selector;
  if (selector.kind === "bytes") {
    if (
      !Number.isSafeInteger(selector.offset) ||
      selector.offset < 0 ||
      !Number.isSafeInteger(selector.length) ||
      selector.length < 1 ||
      selector.length > request.maximumOutputBytes
    ) {
      throw createDomainError({
        code: "invalid_input",
        message: "The byte selector is invalid or exceeds the output limit.",
      });
    }
  } else if (selector.kind === "lines") {
    if (
      !Number.isSafeInteger(selector.startLine) ||
      selector.startLine < 1 ||
      !Number.isSafeInteger(selector.endLine) ||
      selector.endLine < selector.startLine ||
      selector.endLine - selector.startLine + 1 > request.maximumLineSpan
    ) {
      throw createDomainError({
        code: "invalid_input",
        message: "The line selector is invalid or exceeds the line-span limit.",
      });
    }
  } else if (selector.kind !== "whole") {
    throw createDomainError({
      code: "invalid_input",
      message: "The physical read selector is unsupported.",
    });
  }
}

function withheld(
  path: string,
  reason: Extract<PhysicalReadFileResult, { status: "withheld" }>["reason"],
  sourceBytes: number,
  encoding: TextEncoding | null,
  newlineStyle: NewlineStyle | null,
  categories: readonly JsonObject[],
): Extract<PhysicalReadFileResult, { status: "withheld" }> {
  return Object.freeze({
    status: "withheld",
    path,
    reason,
    sourceBytes,
    encoding,
    newlineStyle,
    categories: Object.freeze([...categories]),
  });
}

function assertSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) {
    throw createDomainError({
      code: "invalid_input",
      message: "A physical read requires an AbortSignal.",
    });
  }
  if (signal.aborted) {
    throw createDomainError({
      code: "cancelled",
      message: "The physical read was cancelled.",
    });
  }
}
