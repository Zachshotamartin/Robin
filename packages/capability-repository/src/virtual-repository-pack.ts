import { isProxy } from "node:util/types";

import {
  CONTRACT_SCHEMA_VERSION,
  createDomainError,
  sha256Hex,
} from "@guard/contracts";
import type { JsonObject, NormalizedAction } from "@guard/contracts";

import {
  bindCapabilityAgentContextRelease,
  type CapabilityAgentContextReleaseDefinition,
  type CapabilityOperation,
  type CapabilityOperationReference,
  type CapabilityPack,
} from "@guard/capability-gateway";

import { snapshotBoundaryObject } from "./boundary.js";
import { REPOSITORY_POLICY_ATTRIBUTE_CATALOG } from "./policy-catalog.js";
import { normalizeRepositoryPath } from "./repository-path.js";
import { VirtualRepository } from "./virtual-repository.js";

export const VIRTUAL_REPOSITORY_REFERENCES: Readonly<{
  list: CapabilityOperationReference;
  read: CapabilityOperationReference;
  patch: CapabilityOperationReference;
}> = Object.freeze({
  list: Object.freeze({
    packId: "coding.virtual-repository",
    packVersion: 1,
    operationId: "list_files",
    operationVersion: 1,
  }),
  read: Object.freeze({
    packId: "coding.virtual-repository",
    packVersion: 1,
    operationId: "read_file",
    operationVersion: 1,
  }),
  patch: Object.freeze({
    packId: "coding.virtual-repository",
    packVersion: 1,
    operationId: "propose_patch",
    operationVersion: 1,
  }),
});

export interface VirtualRepositoryPackLimits {
  readonly maximumListResults: number;
  readonly maximumReadBytes: number;
  readonly maximumPatchBytes: number;
}

const DEFAULT_LIMITS: VirtualRepositoryPackLimits = Object.freeze({
  maximumListResults: 256,
  maximumReadBytes: 64 * 1024,
  maximumPatchBytes: 256 * 1024,
});

function agentContextReleaseDefinition(
  reason: string,
): CapabilityAgentContextReleaseDefinition {
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceVersion: 1,
    catalogId: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
    catalogVersion: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
    catalogContentHash: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
    classification: "fixture",
    reason,
  });
}

const LIST_AGENT_CONTEXT_RELEASE = agentContextReleaseDefinition(
  "capability.list_files.output",
);
const READ_AGENT_CONTEXT_RELEASE = agentContextReleaseDefinition(
  "capability.read_file.output",
);
const PATCH_AGENT_CONTEXT_RELEASE = agentContextReleaseDefinition(
  "capability.propose_patch.output",
);

export function createVirtualRepositoryPack(
  repository: VirtualRepository,
  limits: VirtualRepositoryPackLimits = DEFAULT_LIMITS,
): CapabilityPack {
  if (!isTrustedVirtualRepository(repository)) {
    throw invalidInput("The virtual coding pack requires a VirtualRepository fixture.");
  }
  const detachedLimits = parseLimits(
    snapshotBoundaryObject(limits, "Virtual coding pack limits"),
  );
  return {
    packId: VIRTUAL_REPOSITORY_REFERENCES.list.packId,
    packVersion: VIRTUAL_REPOSITORY_REFERENCES.list.packVersion,
    operations: [
      listOperation(repository, detachedLimits),
      readOperation(repository, detachedLimits),
      patchOperation(repository, detachedLimits),
    ],
  };
}

function listOperation(
  repository: VirtualRepository,
  limits: VirtualRepositoryPackLimits,
): CapabilityOperation {
  return {
    definition: {
      operationId: VIRTUAL_REPOSITORY_REFERENCES.list.operationId,
      operationVersion: VIRTUAL_REPOSITORY_REFERENCES.list.operationVersion,
      description: "List a bounded set of virtual repository-relative paths.",
      inputSchema: {
        schemaId: "coding.virtual.list_files.input",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["root", "maxResults"],
          properties: {
            root: { type: "string" },
            maxResults: { type: "integer", minimum: 1 },
          },
        },
      },
      outputSchema: {
        schemaId: "coding.virtual.list_files.output",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["files", "matchedCount", "truncated"],
          properties: {
            files: { type: "array", items: { type: "string" } },
            matchedCount: { type: "integer", minimum: 0 },
            truncated: { type: "boolean" },
          },
        },
      },
      sideEffectClass: "none",
    },
    agentContextRelease: LIST_AGENT_CONTEXT_RELEASE,
    normalize(input) {
      const root = normalizeRepositoryPath(input["root"], { allowRoot: true });
      const maxResults = input["maxResults"] as number;
      if (maxResults > limits.maximumListResults) {
        throw invalidInput("list_files exceeds the installed result bound.");
      }
      return {
        normalizedInput: { maxResults, root },
        resource: {
          scheme: "repo",
          sourceId: "virtual-repository",
          path: root,
          classification: "fixture",
        },
        request: { intent: "list_files", maximumResults: maxResults },
        preconditions: [
          {
            preconditionType: "virtual.repository.snapshot",
            preconditionVersion: 1,
            attributes: { sha256: repository.snapshotHash },
          },
        ],
      };
    },
    execute(action): JsonObject {
      const root = action.normalizedInput["root"] as string;
      const maxResults = action.normalizedInput["maxResults"] as number;
      const matched = repository.list(root);
      const files = matched.slice(0, maxResults);
      return {
        files,
        matchedCount: matched.length,
        truncated: matched.length > files.length,
      };
    },
    release(raw, action) {
      const files = raw["files"]!;
      const truncated = raw["truncated"]!;
      const agent: JsonObject = { files, truncated };
      return {
        audit: {
          root: action.normalizedInput["root"]!,
          matchedCount: raw["matchedCount"]!,
          releasedCount: Array.isArray(files) ? files.length : 0,
          truncated,
        },
        human: {
          summary: `Released ${String(
            Array.isArray(files) ? files.length : 0,
          )} virtual path(s).`,
        },
        agent,
        agentContextRelease: repositoryAgentContextRelease(
          LIST_AGENT_CONTEXT_RELEASE,
          action,
          raw,
          agent,
        ),
      };
    },
  };
}

function readOperation(
  repository: VirtualRepository,
  limits: VirtualRepositoryPackLimits,
): CapabilityOperation {
  return {
    definition: {
      operationId: VIRTUAL_REPOSITORY_REFERENCES.read.operationId,
      operationVersion: VIRTUAL_REPOSITORY_REFERENCES.read.operationVersion,
      description: "Read a bounded line range from a virtual repository fixture.",
      inputSchema: {
        schemaId: "coding.virtual.read_file.input",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["path", "startLine", "endLine", "maxBytes"],
          properties: {
            path: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
            maxBytes: { type: "integer", minimum: 1 },
          },
        },
      },
      outputSchema: {
        schemaId: "coding.virtual.read_file.output",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content", "byteLength", "sourceSha256", "truncated"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            byteLength: { type: "integer", minimum: 0 },
            sourceSha256: { type: "string" },
            truncated: { type: "boolean" },
          },
        },
      },
      sideEffectClass: "none",
    },
    agentContextRelease: READ_AGENT_CONTEXT_RELEASE,
    normalize(input) {
      const path = normalizeRepositoryPath(input["path"], { allowRoot: false });
      const startLine = input["startLine"] as number;
      const endLine = input["endLine"] as number;
      const maxBytes = input["maxBytes"] as number;
      if (startLine > endLine) {
        throw invalidInput("read_file startLine must not exceed endLine.");
      }
      if (maxBytes > limits.maximumReadBytes) {
        throw invalidInput("read_file exceeds the installed byte bound.");
      }
      const content = repository.read(path);
      const lines = logicalLines(content);
      if (startLine > Math.max(lines.length, 1)) {
        throw invalidInput("read_file startLine is beyond the virtual file.");
      }
      const sourceSha256 = sha256Hex(content);
      return {
        normalizedInput: { endLine, maxBytes, path, startLine },
        resource: {
          scheme: "repo",
          sourceId: "virtual-repository",
          path,
          classification: "fixture",
        },
        request: {
          intent: "read_file",
          startLine,
          endLine,
          maximumBytes: maxBytes,
        },
        preconditions: [
          {
            preconditionType: "virtual.file.sha256",
            preconditionVersion: 1,
            attributes: { path, sha256: sourceSha256 },
          },
        ],
      };
    },
    execute(action): JsonObject {
      const path = action.normalizedInput["path"] as string;
      const startLine = action.normalizedInput["startLine"] as number;
      const endLine = action.normalizedInput["endLine"] as number;
      const maxBytes = action.normalizedInput["maxBytes"] as number;
      const source = repository.read(path);
      const selected = logicalLines(source)
        .slice(startLine - 1, endLine)
        .join("\n");
      const bounded = truncateUtf8(selected, maxBytes);
      return {
        path,
        content: bounded.text,
        byteLength: Buffer.byteLength(bounded.text, "utf8"),
        sourceSha256: sha256Hex(source),
        truncated: bounded.truncated,
      };
    },
    release(raw, action) {
      const agent: JsonObject = {
        path: raw["path"]!,
        content: raw["content"]!,
        truncated: raw["truncated"]!,
      };
      return {
        audit: {
          path: raw["path"]!,
          byteLength: raw["byteLength"]!,
          sourceSha256: raw["sourceSha256"]!,
          truncated: raw["truncated"]!,
        },
        human: {
          summary: `Released ${String(raw["byteLength"])} byte(s) from ${String(
            raw["path"],
          )}.`,
        },
        agent,
        agentContextRelease: repositoryAgentContextRelease(
          READ_AGENT_CONTEXT_RELEASE,
          action,
          raw,
          agent,
        ),
      };
    },
  };
}

function patchOperation(
  repository: VirtualRepository,
  limits: VirtualRepositoryPackLimits,
): CapabilityOperation {
  return {
    definition: {
      operationId: VIRTUAL_REPOSITORY_REFERENCES.patch.operationId,
      operationVersion: VIRTUAL_REPOSITORY_REFERENCES.patch.operationVersion,
      description: "Propose, but do not apply, a bounded virtual text patch.",
      inputSchema: {
        schemaId: "coding.virtual.propose_patch.input",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["path", "replacement"],
          properties: {
            path: { type: "string" },
            replacement: { type: "string" },
          },
        },
      },
      outputSchema: {
        schemaId: "coding.virtual.propose_patch.output",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: [
            "path",
            "patch",
            "byteLength",
            "preimageSha256",
            "replacementSha256",
          ],
          properties: {
            path: { type: "string" },
            patch: { type: "string" },
            byteLength: { type: "integer", minimum: 0 },
            preimageSha256: { type: "string" },
            replacementSha256: { type: "string" },
          },
        },
      },
      sideEffectClass: "none",
    },
    agentContextRelease: PATCH_AGENT_CONTEXT_RELEASE,
    normalize(input) {
      const path = normalizeRepositoryPath(input["path"], { allowRoot: false });
      const replacement = (input["replacement"] as string).replace(/\r\n?/gu, "\n");
      const preimage = repository.read(path);
      const patch = wholeFilePatch(path, preimage, replacement);
      const patchBytes = Buffer.byteLength(patch, "utf8");
      if (patchBytes > limits.maximumPatchBytes) {
        throw invalidInput("propose_patch exceeds the installed patch byte bound.");
      }
      const preimageSha256 = sha256Hex(preimage);
      const replacementSha256 = sha256Hex(replacement);
      return {
        normalizedInput: {
          byteLength: patchBytes,
          patch,
          path,
          preimageSha256,
          replacementSha256,
        },
        resource: {
          scheme: "repo",
          sourceId: "virtual-repository",
          path,
          classification: "fixture",
        },
        request: {
          intent: "propose_patch",
          affectedPaths: [path],
          patchBytes,
          replacementSha256,
        },
        preconditions: [
          {
            preconditionType: "virtual.file.sha256",
            preconditionVersion: 1,
            attributes: { path, sha256: preimageSha256 },
          },
        ],
      };
    },
    execute(action): JsonObject {
      return {
        path: action.normalizedInput["path"]!,
        patch: action.normalizedInput["patch"]!,
        byteLength: action.normalizedInput["byteLength"]!,
        preimageSha256: action.normalizedInput["preimageSha256"]!,
        replacementSha256: action.normalizedInput["replacementSha256"]!,
      };
    },
    release(raw, action) {
      const agent: JsonObject = { path: raw["path"]!, patch: raw["patch"]! };
      return {
        audit: {
          path: raw["path"]!,
          byteLength: raw["byteLength"]!,
          preimageSha256: raw["preimageSha256"]!,
          replacementSha256: raw["replacementSha256"]!,
        },
        human: {
          summary: `Proposed a ${String(raw["byteLength"])} byte patch for ${String(
            raw["path"],
          )}; no fixture content was changed.`,
          patch: raw["patch"]!,
        },
        agent,
        agentContextRelease: repositoryAgentContextRelease(
          PATCH_AGENT_CONTEXT_RELEASE,
          action,
          raw,
          agent,
        ),
      };
    },
  };
}

function repositoryAgentContextRelease(
  definition: CapabilityAgentContextReleaseDefinition,
  action: NormalizedAction,
  raw: JsonObject,
  agent: JsonObject,
) {
  const path = action.resource["path"] as string;
  return bindCapabilityAgentContextRelease(
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sourceVersion: definition.sourceVersion,
      resource: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        scheme: "repo",
        sourceId: "virtual-repository",
        locator: { path },
        mediaType: "application/json",
        classification: definition.classification,
      },
      policyProjection: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        catalogId: definition.catalogId,
        catalogVersion: definition.catalogVersion,
        catalogContentHash: definition.catalogContentHash,
        resourceAttributes: { path },
        requestAttributes: {},
      },
      classification: definition.classification,
      reason: definition.reason,
    },
    action,
    raw,
    agent,
  );
}

function logicalLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function wholeFilePatch(path: string, before: string, after: string): string {
  const beforeLines = logicalLines(before);
  const afterLines = logicalLines(after);
  const oldStart = beforeLines.length === 0 ? 0 : 1;
  const newStart = afterLines.length === 0 ? 0 : 1;
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${beforeLines.length} +${newStart},${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];
  return `${lines.join("\n")}\n`;
}

function truncateUtf8(value: string, maximumBytes: number): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return { text: value, truncated: false };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maximumBytes; end >= 0; end -= 1) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      // Continue until the prefix ends at a complete UTF-8 code point.
    }
  }
  return { text: "", truncated: true };
}

function parseLimits(
  limits: Readonly<Record<string, unknown>>,
): VirtualRepositoryPackLimits {
  const expected = [
    "maximumListResults",
    "maximumReadBytes",
    "maximumPatchBytes",
  ];
  const keys = Object.keys(limits);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(limits, key))
  ) {
    throw invalidInput("Virtual coding pack limits contain unknown or missing fields.");
  }
  for (const [field, value] of Object.entries(limits)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw invalidInput(`${field} must be a positive safe integer.`);
    }
  }
  return Object.freeze({
    maximumListResults: limits["maximumListResults"] as number,
    maximumReadBytes: limits["maximumReadBytes"] as number,
    maximumPatchBytes: limits["maximumPatchBytes"] as number,
  });
}

function isTrustedVirtualRepository(value: unknown): value is VirtualRepository {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      !isProxy(value) &&
      value instanceof VirtualRepository
    );
  } catch {
    return false;
  }
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
