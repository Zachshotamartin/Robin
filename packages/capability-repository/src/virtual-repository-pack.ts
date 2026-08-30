import { isProxy } from "node:util/types";

import {
  CONTRACT_SCHEMA_VERSION,
  canonicalBytes,
  canonicalSha256Hex,
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
import {
  minimumLiteralSearchOutputBytes,
  runLiteralSearch,
} from "./literal-search.js";
import { REPOSITORY_POLICY_ATTRIBUTE_CATALOG } from "./policy-catalog.js";
import { normalizeRepositoryPath } from "./repository-path.js";
import { inspectUnifiedDiffProposal } from "./unified-diff-inspection.js";
import { VirtualRepository } from "./virtual-repository.js";

export const VIRTUAL_REPOSITORY_REFERENCES: Readonly<{
  list: CapabilityOperationReference;
  search: CapabilityOperationReference;
  read: CapabilityOperationReference;
  patch: CapabilityOperationReference;
  inspectDiff: CapabilityOperationReference;
}> = Object.freeze({
  list: Object.freeze({
    packId: "coding.virtual-repository",
    packVersion: 1,
    operationId: "list_files",
    operationVersion: 1,
  }),
  search: Object.freeze({
    packId: "coding.virtual-repository",
    packVersion: 1,
    operationId: "search_text",
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
  inspectDiff: Object.freeze({
    packId: "coding.virtual-repository",
    packVersion: 1,
    operationId: "inspect_diff",
    operationVersion: 1,
  }),
});

export interface VirtualRepositoryPackLimits {
  readonly maximumListResults: number;
  readonly maximumReadBytes: number;
  readonly maximumPatchBytes: number;
  readonly maximumSearchQueryBytes?: number;
  readonly maximumSearchPaths?: number;
  readonly maximumSearchMatches?: number;
  readonly maximumSearchSnippetBytes?: number;
  readonly maximumSearchOutputBytes?: number;
  readonly maximumDiffBytes?: number;
  readonly maximumDiffPaths?: number;
  readonly maximumDiffHunks?: number;
  readonly maximumDiffLines?: number;
  readonly maximumDiffOutputBytes?: number;
}

interface ResolvedVirtualRepositoryPackLimits {
  readonly maximumListResults: number;
  readonly maximumReadBytes: number;
  readonly maximumPatchBytes: number;
  readonly maximumSearchQueryBytes: number;
  readonly maximumSearchPaths: number;
  readonly maximumSearchMatches: number;
  readonly maximumSearchSnippetBytes: number;
  readonly maximumSearchOutputBytes: number;
  readonly maximumDiffBytes: number;
  readonly maximumDiffPaths: number;
  readonly maximumDiffHunks: number;
  readonly maximumDiffLines: number;
  readonly maximumDiffOutputBytes: number;
}

const DEFAULT_LIMITS: ResolvedVirtualRepositoryPackLimits = Object.freeze({
  maximumListResults: 256,
  maximumReadBytes: 64 * 1024,
  maximumPatchBytes: 256 * 1024,
  maximumSearchQueryBytes: 1024,
  maximumSearchPaths: 256,
  maximumSearchMatches: 512,
  maximumSearchSnippetBytes: 512,
  maximumSearchOutputBytes: 256 * 1024,
  maximumDiffBytes: 256 * 1024,
  maximumDiffPaths: 64,
  maximumDiffHunks: 256,
  maximumDiffLines: 10_000,
  maximumDiffOutputBytes: 512 * 1024,
});

const MAXIMUM_RELEASE_PATH_IDENTIFIERS = 1_024;
const MAXIMUM_RELEASE_PATH_BYTES = 64 * 1024;
/** Mirrors context-broker parsePolicyProjection's hard canonical-byte ceiling. */
const CONTEXT_BROKER_POLICY_PROJECTION_MAXIMUM_BYTES = 64 * 1024;

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
const SEARCH_AGENT_CONTEXT_RELEASE = agentContextReleaseDefinition(
  "capability.search_text.output",
);
const PATCH_AGENT_CONTEXT_RELEASE = agentContextReleaseDefinition(
  "capability.propose_patch.output",
);
const INSPECT_DIFF_AGENT_CONTEXT_RELEASE = agentContextReleaseDefinition(
  "capability.inspect_diff.output",
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
      searchOperation(repository, detachedLimits),
      readOperation(repository, detachedLimits),
      patchOperation(repository, detachedLimits),
      inspectDiffOperation(repository, detachedLimits),
    ],
  };
}

function searchOperation(
  repository: VirtualRepository,
  limits: ResolvedVirtualRepositoryPackLimits,
): CapabilityOperation {
  return {
    definition: {
      operationId: VIRTUAL_REPOSITORY_REFERENCES.search.operationId,
      operationVersion: VIRTUAL_REPOSITORY_REFERENCES.search.operationVersion,
      description:
        "Search selected virtual files for an exact bounded literal string.",
      inputSchema: {
        schemaId: "coding.virtual.search_text.input",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: [
            "query",
            "paths",
            "maxMatches",
            "maxSnippetBytes",
            "maxOutputBytes",
          ],
          properties: {
            query: { type: "string" },
            paths: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
            maxMatches: { type: "integer", minimum: 1 },
            maxSnippetBytes: { type: "integer", minimum: 1 },
            maxOutputBytes: { type: "integer", minimum: 1 },
          },
        },
      },
      outputSchema: {
        schemaId: "coding.virtual.search_text.output",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["matches", "matchedCount", "truncated"],
          properties: {
            matches: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "line", "column", "snippet"],
                properties: {
                  path: { type: "string" },
                  line: { type: "integer", minimum: 1 },
                  column: { type: "integer", minimum: 1 },
                  snippet: { type: "string" },
                },
              },
            },
            matchedCount: { type: "integer", minimum: 0 },
            truncated: { type: "boolean" },
          },
        },
      },
      sideEffectClass: "none",
    },
    agentContextRelease: SEARCH_AGENT_CONTEXT_RELEASE,
    normalize(input) {
      const query = normalizeLiteralQuery(
        input["query"] as string,
        limits.maximumSearchQueryBytes,
      );
      const rawPaths = input["paths"] as readonly string[];
      if (rawPaths.length > limits.maximumSearchPaths) {
        throw invalidInput("search_text exceeds the installed path-count bound.");
      }
      const paths = canonicalSelectedPaths(repository, rawPaths);
      const maximumMatches = requestedBound(
        input["maxMatches"],
        limits.maximumSearchMatches,
        "search_text maxMatches",
      );
      const maximumSnippetBytes = requestedBound(
        input["maxSnippetBytes"],
        limits.maximumSearchSnippetBytes,
        "search_text maxSnippetBytes",
      );
      const maximumOutputBytes = requestedBound(
        input["maxOutputBytes"],
        limits.maximumSearchOutputBytes,
        "search_text maxOutputBytes",
      );
      const queryBytes = Buffer.byteLength(query, "utf8");
      if (queryBytes > maximumSnippetBytes) {
        throw invalidInput("search_text query must fit in every released snippet.");
      }
      if (maximumOutputBytes < minimumLiteralSearchOutputBytes()) {
        throw invalidInput("search_text output bound cannot hold its result envelope.");
      }
      const path = commonRepositoryScope(paths);
      return {
        normalizedInput: {
          query,
          paths,
          maximumMatches,
          maximumSnippetBytes,
          maximumOutputBytes,
        },
        resource: {
          scheme: "repo",
          sourceId: "virtual-repository",
          path,
          paths,
          classification: "fixture",
        },
        request: {
          intent: "search_text",
          literal: true,
          queryBytes,
          querySha256: sha256Hex(query),
          selectedPaths: paths,
          maximumMatches,
          maximumSnippetBytes,
          maximumOutputBytes,
        },
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
      return runLiteralSearch(repository, {
        query: action.normalizedInput["query"] as string,
        paths: action.normalizedInput["paths"] as readonly string[],
        maximumMatches: action.normalizedInput["maximumMatches"] as number,
        maximumSnippetBytes:
          action.normalizedInput["maximumSnippetBytes"] as number,
        maximumOutputBytes:
          action.normalizedInput["maximumOutputBytes"] as number,
      });
    },
    release(raw, action) {
      const agent: JsonObject = {
        matches: raw["matches"]!,
        matchedCount: raw["matchedCount"]!,
        truncated: raw["truncated"]!,
      };
      const outputPaths = emittedSearchPaths(
        raw,
        agent,
        action,
        limits.maximumSearchMatches,
        limits.maximumSearchPaths,
      );
      return {
        audit: {
          querySha256: action.request["querySha256"]!,
          selectedPathCount: (
            action.normalizedInput["paths"] as readonly unknown[]
          ).length,
          matchedCount: raw["matchedCount"]!,
          releasedCount: Array.isArray(raw["matches"])
            ? raw["matches"].length
            : 0,
          truncated: raw["truncated"]!,
        },
        human: {
          summary: `Released ${String(
            Array.isArray(raw["matches"]) ? raw["matches"].length : 0,
          )} of ${String(raw["matchedCount"])} literal match(es).`,
        },
        agent,
        agentContextRelease: repositoryAgentContextRelease(
          SEARCH_AGENT_CONTEXT_RELEASE,
          action,
          raw,
          agent,
          outputPaths,
        ),
      };
    },
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
      const outputPaths = emittedListPaths(
        raw,
        agent,
        action,
        limits.maximumListResults,
      );
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
          outputPaths,
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
      assertScalarEmittedPath(raw, agent, action, "read_file");
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
  limits: ResolvedVirtualRepositoryPackLimits,
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
      assertScalarEmittedPath(raw, agent, action, "propose_patch");
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

function inspectDiffOperation(
  repository: VirtualRepository,
  limits: ResolvedVirtualRepositoryPackLimits,
): CapabilityOperation {
  return {
    definition: {
      operationId: VIRTUAL_REPOSITORY_REFERENCES.inspectDiff.operationId,
      operationVersion: VIRTUAL_REPOSITORY_REFERENCES.inspectDiff.operationVersion,
      description:
        "Inspect, but never apply, one canonical bounded unified diff proposal.",
      inputSchema: {
        schemaId: "coding.virtual.inspect_diff.input",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["patch"],
          properties: { patch: { type: "string" } },
        },
      },
      outputSchema: {
        schemaId: "coding.virtual.inspect_diff.output",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: [
            "paths",
            "hunkCount",
            "additions",
            "deletions",
            "lineCount",
            "byteLength",
            "patch",
          ],
          properties: {
            paths: { type: "array", items: { type: "string" } },
            hunkCount: { type: "integer", minimum: 1 },
            additions: { type: "integer", minimum: 0 },
            deletions: { type: "integer", minimum: 0 },
            lineCount: { type: "integer", minimum: 1 },
            byteLength: { type: "integer", minimum: 1 },
            patch: { type: "string" },
          },
        },
      },
      sideEffectClass: "none",
    },
    agentContextRelease: INSPECT_DIFF_AGENT_CONTEXT_RELEASE,
    normalize(input) {
      const inspection = inspectUnifiedDiffProposal(
        input["patch"] as string,
        repository,
        {
          maximumPatchBytes: limits.maximumDiffBytes,
          maximumPaths: limits.maximumDiffPaths,
          maximumHunks: limits.maximumDiffHunks,
          maximumLines: limits.maximumDiffLines,
          maximumOutputBytes: limits.maximumDiffOutputBytes,
        },
      );
      const path = commonRepositoryScope(inspection.paths);
      return {
        normalizedInput: inspection,
        resource: {
          scheme: "repo",
          sourceId: "virtual-repository",
          path,
          paths: inspection.paths,
          classification: "fixture",
        },
        request: {
          intent: "inspect_diff",
          affectedPaths: inspection.paths,
          patchBytes: inspection.byteLength,
          patchSha256: sha256Hex(inspection.patch),
          hunkCount: inspection.hunkCount,
          lineCount: inspection.lineCount,
        },
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
      return {
        paths: action.normalizedInput["paths"]!,
        hunkCount: action.normalizedInput["hunkCount"]!,
        additions: action.normalizedInput["additions"]!,
        deletions: action.normalizedInput["deletions"]!,
        lineCount: action.normalizedInput["lineCount"]!,
        byteLength: action.normalizedInput["byteLength"]!,
        patch: action.normalizedInput["patch"]!,
      };
    },
    release(raw, action) {
      const agent: JsonObject = {
        paths: raw["paths"]!,
        hunkCount: raw["hunkCount"]!,
        additions: raw["additions"]!,
        deletions: raw["deletions"]!,
        lineCount: raw["lineCount"]!,
        byteLength: raw["byteLength"]!,
        patch: raw["patch"]!,
      };
      const outputPaths = emittedInspectDiffPaths(
        raw,
        agent,
        action,
        limits.maximumDiffPaths,
      );
      return {
        audit: {
          paths: raw["paths"]!,
          hunkCount: raw["hunkCount"]!,
          additions: raw["additions"]!,
          deletions: raw["deletions"]!,
          lineCount: raw["lineCount"]!,
          byteLength: raw["byteLength"]!,
          patchSha256: action.request["patchSha256"]!,
          applied: false,
        },
        human: {
          summary: `Inspected ${String(raw["hunkCount"])} hunk(s) across ${String(
            Array.isArray(raw["paths"]) ? raw["paths"].length : 0,
          )} path(s); no repository content was changed.`,
          patch: raw["patch"]!,
        },
        agent,
        agentContextRelease: repositoryAgentContextRelease(
          INSPECT_DIFF_AGENT_CONTEXT_RELEASE,
          action,
          raw,
          agent,
          outputPaths,
        ),
      };
    },
  };
}

function emittedListPaths(
  raw: JsonObject,
  agent: JsonObject,
  action: NormalizedAction,
  maximumPaths: number,
): readonly string[] {
  const rawPaths = capturePathArray(
    raw["files"],
    maximumPaths,
    false,
    "list_files raw paths",
  );
  const agentPaths = capturePathArray(
    agent["files"],
    maximumPaths,
    false,
    "list_files agent paths",
  );
  assertSamePathSequence(rawPaths, agentPaths, "list_files");
  const root = exactCanonicalPath(action.resource["path"], true, "list_files root");
  const prefix = root.length === 0 ? "" : `${root}/`;
  if (
    rawPaths.some(
      (path) => root.length > 0 && path !== root && !path.startsWith(prefix),
    )
  ) {
    throw invalidInput("list_files emitted a path outside its normalized root.");
  }
  return rawPaths;
}

function emittedSearchPaths(
  raw: JsonObject,
  agent: JsonObject,
  action: NormalizedAction,
  maximumMatches: number,
  maximumPaths: number,
): readonly string[] {
  const rawPaths = captureMatchPaths(
    raw["matches"],
    maximumMatches,
    "search_text raw matches",
  );
  const agentPaths = captureMatchPaths(
    agent["matches"],
    maximumMatches,
    "search_text agent matches",
  );
  assertSamePathSequence(rawPaths, agentPaths, "search_text");
  const outputPaths = canonicalUniquePathSet(
    rawPaths,
    maximumPaths,
    true,
    "search_text output paths",
  );
  const selectedPaths = capturePathArray(
    action.resource["paths"],
    maximumPaths,
    false,
    "search_text selected paths",
  );
  const selected = new Set(selectedPaths);
  if (outputPaths.some((path) => !selected.has(path))) {
    throw invalidInput("search_text emitted a path outside its normalized selection.");
  }
  return outputPaths;
}

function emittedInspectDiffPaths(
  raw: JsonObject,
  agent: JsonObject,
  action: NormalizedAction,
  maximumPaths: number,
): readonly string[] {
  const rawPaths = capturePathArray(
    raw["paths"],
    maximumPaths,
    false,
    "inspect_diff raw paths",
  );
  const agentPaths = capturePathArray(
    agent["paths"],
    maximumPaths,
    false,
    "inspect_diff agent paths",
  );
  assertSamePathSequence(rawPaths, agentPaths, "inspect_diff");
  const normalizedPaths = capturePathArray(
    action.resource["paths"],
    maximumPaths,
    false,
    "inspect_diff normalized paths",
  );
  if (canonicalSha256Hex(rawPaths) !== canonicalSha256Hex(normalizedPaths)) {
    throw invalidInput(
      "inspect_diff emitted paths do not exactly match its normalized inspection.",
    );
  }
  return rawPaths;
}

function assertScalarEmittedPath(
  raw: JsonObject,
  agent: JsonObject,
  action: NormalizedAction,
  operation: "read_file" | "propose_patch",
): void {
  const normalized = exactCanonicalPath(
    action.resource["path"],
    false,
    `${operation} normalized path`,
  );
  const rawPath = exactCanonicalPath(raw["path"], false, `${operation} raw path`);
  const agentPath = exactCanonicalPath(
    agent["path"],
    false,
    `${operation} agent path`,
  );
  if (rawPath !== normalized || agentPath !== normalized) {
    throw invalidInput(`${operation} emitted a path other than its normalized path.`);
  }
}

function captureMatchPaths(
  value: unknown,
  maximumMatches: number,
  label: string,
): readonly string[] {
  const captured = snapshotBoundaryObject({ matches: value }, label)["matches"];
  const maximum = boundedReleasePathCount(maximumMatches);
  if (!Array.isArray(captured) || captured.length > maximum) {
    throw invalidInput(`${label} exceeds its hard match-count bound.`);
  }
  const paths: string[] = [];
  for (const candidate of captured) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw invalidInput(`${label} contains a malformed match.`);
    }
    const path = exactCanonicalPath(
      (candidate as Readonly<Record<string, unknown>>)["path"],
      false,
      `${label} path`,
    );
    paths.push(path);
  }
  return Object.freeze(paths);
}

function capturePathArray(
  value: unknown,
  maximumPaths: number,
  allowRepeated: boolean,
  label: string,
): readonly string[] {
  const captured = snapshotBoundaryObject({ paths: value }, label)["paths"];
  if (!Array.isArray(captured)) {
    throw invalidInput(`${label} must be an array.`);
  }
  return canonicalUniquePathSet(captured, maximumPaths, allowRepeated, label);
}

function canonicalUniquePathSet(
  values: readonly unknown[],
  maximumPaths: number,
  allowRepeated: boolean,
  label: string,
): readonly string[] {
  const maximum = boundedReleasePathCount(maximumPaths);
  if (!allowRepeated && values.length > maximum) {
    throw invalidInput(`${label} exceeds its hard path-count bound.`);
  }
  const unique = new Set<string>();
  let aggregateBytes = 0;
  for (const value of values) {
    const path = exactCanonicalPath(value, false, label);
    if (unique.has(path)) {
      if (!allowRepeated) {
        throw invalidInput(`${label} contains a duplicate path.`);
      }
      continue;
    }
    unique.add(path);
    if (unique.size > maximum) {
      throw invalidInput(`${label} exceeds its hard unique-path bound.`);
    }
    aggregateBytes += Buffer.byteLength(path, "utf8");
    if (aggregateBytes > MAXIMUM_RELEASE_PATH_BYTES) {
      throw invalidInput(`${label} exceeds its hard aggregate byte bound.`);
    }
  }
  return Object.freeze([...unique].sort(compareUtf8));
}

function boundedReleasePathCount(installedMaximum: number): number {
  if (
    !Number.isSafeInteger(installedMaximum) ||
    installedMaximum < 1
  ) {
    throw invalidInput("A release path-count bound is invalid.");
  }
  return Math.min(installedMaximum, MAXIMUM_RELEASE_PATH_IDENTIFIERS);
}

function exactCanonicalPath(
  value: unknown,
  allowRoot: boolean,
  label: string,
): string {
  const canonical = normalizeRepositoryPath(value, { allowRoot });
  if (value !== canonical) {
    throw invalidInput(`${label} is not in exact canonical form.`);
  }
  return canonical;
}

function assertSamePathSequence(
  left: readonly string[],
  right: readonly string[],
  operation: string,
): void {
  if (canonicalSha256Hex(left) !== canonicalSha256Hex(right)) {
    throw invalidInput(`${operation} raw and agent path identifiers disagree.`);
  }
}

function repositoryAgentContextRelease(
  definition: CapabilityAgentContextReleaseDefinition,
  action: NormalizedAction,
  raw: JsonObject,
  agent: JsonObject,
  outputPaths?: readonly string[],
) {
  const path = exactCanonicalPath(action.resource["path"], true, "release scope");
  const locator: JsonObject = outputPaths === undefined
    ? { path }
    : { path, outputPaths };
  const resourceAttributes: JsonObject = outputPaths === undefined
    ? { path }
    : path.length === 0
      ? { outputPaths }
      : { path, outputPaths };
  const policyProjection = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    catalogId: definition.catalogId,
    catalogVersion: definition.catalogVersion,
    catalogContentHash: definition.catalogContentHash,
    resourceAttributes,
    requestAttributes: {},
  } as const;
  if (
    canonicalBytes(policyProjection).byteLength >
    CONTEXT_BROKER_POLICY_PROJECTION_MAXIMUM_BYTES
  ) {
    throw invalidInput(
      "Repository release policy projection exceeds the broker canonical-byte bound.",
    );
  }
  return bindCapabilityAgentContextRelease(
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sourceVersion: definition.sourceVersion,
      resource: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        scheme: "repo",
        sourceId: "virtual-repository",
        locator,
        mediaType: "application/json",
        classification: definition.classification,
      },
      policyProjection,
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

function normalizeLiteralQuery(value: string, maximumBytes: number): string {
  if (
    value.length === 0 ||
    !isWellFormedUnicode(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidInput(
      "search_text query must be non-empty, well-formed single-line text.",
    );
  }
  const normalized = value.normalize("NFC");
  if (
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    Buffer.byteLength(normalized, "utf8") > maximumBytes
  ) {
    throw invalidInput("search_text query exceeds the installed byte bound.");
  }
  return normalized;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requestedBound(value: unknown, installed: number, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > installed
  ) {
    throw invalidInput(`${label} exceeds its installed positive bound.`);
  }
  return value;
}

function canonicalSelectedPaths(
  repository: VirtualRepository,
  rawPaths: readonly string[],
): readonly string[] {
  const selected = new Set<string>();
  for (const rawPath of rawPaths) {
    const path = normalizeRepositoryPath(rawPath, { allowRoot: false });
    repository.read(path);
    selected.add(path);
  }
  const paths = [...selected].sort(compareUtf8);
  if (paths.length === 0) {
    throw invalidInput("search_text requires at least one selected file.");
  }
  return Object.freeze(paths);
}

function commonRepositoryScope(paths: readonly string[]): string {
  if (paths.length === 1) return paths[0]!;
  const split = paths.map((path) => path.split("/"));
  const first = split[0]!;
  let commonLength = first.length - 1;
  for (const segments of split.slice(1)) {
    commonLength = Math.min(commonLength, segments.length - 1);
    let index = 0;
    while (index < commonLength && segments[index] === first[index]) {
      index += 1;
    }
    commonLength = index;
  }
  return first.slice(0, commonLength).join("/");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function parseLimits(
  limits: Readonly<Record<string, unknown>>,
): ResolvedVirtualRepositoryPackLimits {
  const required = [
    "maximumListResults",
    "maximumReadBytes",
    "maximumPatchBytes",
  ];
  const optional = [
    "maximumSearchQueryBytes",
    "maximumSearchPaths",
    "maximumSearchMatches",
    "maximumSearchSnippetBytes",
    "maximumSearchOutputBytes",
    "maximumDiffBytes",
    "maximumDiffPaths",
    "maximumDiffHunks",
    "maximumDiffLines",
    "maximumDiffOutputBytes",
  ];
  const keys = Object.keys(limits);
  if (
    required.some((key) => !Object.hasOwn(limits, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
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
    maximumSearchQueryBytes: optionalLimit(
      limits,
      "maximumSearchQueryBytes",
    ),
    maximumSearchPaths: optionalLimit(limits, "maximumSearchPaths"),
    maximumSearchMatches: optionalLimit(limits, "maximumSearchMatches"),
    maximumSearchSnippetBytes: optionalLimit(
      limits,
      "maximumSearchSnippetBytes",
    ),
    maximumSearchOutputBytes: optionalLimit(
      limits,
      "maximumSearchOutputBytes",
    ),
    maximumDiffBytes: optionalLimit(limits, "maximumDiffBytes"),
    maximumDiffPaths: optionalLimit(limits, "maximumDiffPaths"),
    maximumDiffHunks: optionalLimit(limits, "maximumDiffHunks"),
    maximumDiffLines: optionalLimit(limits, "maximumDiffLines"),
    maximumDiffOutputBytes: optionalLimit(limits, "maximumDiffOutputBytes"),
  });
}

function optionalLimit(
  limits: Readonly<Record<string, unknown>>,
  field: keyof ResolvedVirtualRepositoryPackLimits,
): number {
  return (limits[field] ?? DEFAULT_LIMITS[field]) as number;
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
