import type {
  SideEffectClass,
  VersionedSchema,
} from "@guard/contracts";
import type {
  CapabilityOperationDefinition,
  CapabilityOperationReference,
} from "@guard/capability-gateway";
import {
  APPLY_PATCH_V1_SCHEMA,
  CREATE_FILE_V1_SCHEMA,
} from "@guard/tool-workspace";
import { ROBIN_PROCESS_RUN_INPUT_SCHEMA } from "@guard/tool-process";

export const ROBIN_REPO_PACK_ID = "robin.repo" as const;
export const ROBIN_EDIT_PACK_ID = "robin.edit" as const;
export const ROBIN_PROCESS_PACK_ID = "robin.process" as const;
export const ROBIN_GIT_PACK_ID = "robin.git" as const;
export const ROBIN_R2_PACK_VERSION = 1 as const;

export type RobinR2ToolId =
  | "robin.repo.list_files@1"
  | "robin.repo.search_text@1"
  | "robin.repo.read_file@1"
  | "robin.edit.apply_patch@1"
  | "robin.edit.create_file@1"
  | "robin.process.run@1"
  | "robin.git.status@1"
  | "robin.git.diff@1";

export interface RobinR2ToolDefinition {
  readonly toolId: RobinR2ToolId;
  readonly reference: CapabilityOperationReference;
  readonly definition: CapabilityOperationDefinition;
  readonly permission: "allow" | "ask";
}

const EMPTY_INPUT = versionedSchema("robin.empty.input", {
  type: "object",
  additionalProperties: false,
  properties: {},
});

const LIST_FILES_INPUT = versionedSchema("robin.repo.list-files.input", {
  type: "object",
  additionalProperties: false,
  required: ["root"],
  properties: {
    root: { type: "string", maxLength: 4096 },
  },
});

const SEARCH_TEXT_INPUT = versionedSchema("robin.repo.search-text.input", {
  type: "object",
  additionalProperties: false,
  required: ["query", "paths"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: 4096 },
    paths: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 4096 },
    },
  },
});

const READ_FILE_INPUT = versionedSchema("robin.repo.read-file.input", {
  type: "object",
  additionalProperties: false,
  required: ["path", "selector"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
    selector: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "whole" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "offset", "length"],
          properties: {
            kind: { const: "bytes" },
            offset: { type: "integer", minimum: 0 },
            length: { type: "integer", minimum: 1, maximum: 262144 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "startLine", "endLine"],
          properties: {
            kind: { const: "lines" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
          },
        },
      ],
    },
  },
});

const GIT_DIFF_INPUT = versionedSchema("robin.git.diff.input", {
  type: "object",
  additionalProperties: false,
  required: ["scope"],
  properties: {
    scope: { enum: ["working", "staged"] },
  },
});

export const ROBIN_R2_TOOL_DEFINITIONS: readonly RobinR2ToolDefinition[] =
  Object.freeze([
    tool("robin.repo.list_files@1", ROBIN_REPO_PACK_ID, "list_files", {
      description:
        "List bounded metadata for files inside the bound physical workspace without following symlinks.",
      inputSchema: LIST_FILES_INPUT,
      outputSchema: objectOutput("robin.repo.list-files.output", [
        "files", "omissions", "truncated", "optionsHash",
      ]),
      sideEffectClass: "none",
      permission: "allow",
    }),
    tool("robin.repo.search_text@1", ROBIN_REPO_PACK_ID, "search_text", {
      description:
        "Search a bounded explicit set of released workspace text files for one literal string.",
      inputSchema: SEARCH_TEXT_INPUT,
      outputSchema: objectOutput("robin.repo.search-text.output", [
        "matches", "matchedCount", "searchedFiles", "searchedBytes", "skipped", "truncated",
      ]),
      sideEffectClass: "none",
      permission: "allow",
    }),
    tool("robin.repo.read_file@1", ROBIN_REPO_PACK_ID, "read_file", {
      description:
        "Read a bounded whole, byte, or line window from one eligible physical workspace file.",
      inputSchema: READ_FILE_INPUT,
      outputSchema: objectOutput("robin.repo.read-file.output", [
        "status", "path", "content", "sourceSha256", "sourceBytes", "selectedBytes",
        "encoding", "newlineStyle", "startLine", "endLine", "leadingPartialLine",
        "trailingPartialLine", "truncated", "atimePreserved", "fileIdentity",
        "promptInjectionTags",
      ]),
      sideEffectClass: "none",
      permission: "allow",
    }),
    tool("robin.edit.apply_patch@1", ROBIN_EDIT_PACK_ID, "apply_patch", {
      description:
        "Apply exact one-file replacement hunks against a complete expected preimage after approval.",
      inputSchema: APPLY_PATCH_V1_SCHEMA,
      outputSchema: editOutput("robin.edit.apply-patch.output"),
      sideEffectClass: "local_reversible",
      permission: "ask",
    }),
    tool("robin.edit.create_file@1", ROBIN_EDIT_PACK_ID, "create_file", {
      description:
        "Create one absent bounded text file atomically inside the bound workspace after approval.",
      inputSchema: CREATE_FILE_V1_SCHEMA,
      outputSchema: editOutput("robin.edit.create-file.output"),
      sideEffectClass: "local_reversible",
      permission: "ask",
    }),
    tool("robin.process.run@1", ROBIN_PROCESS_PACK_ID, "run", {
      description:
        "Run one direct executable and argv in the workspace with bounded I/O; this is not sandboxed.",
      inputSchema: versionedSchema(
        "robin.process.run.input",
        ROBIN_PROCESS_RUN_INPUT_SCHEMA,
      ),
      outputSchema: objectOutput("robin.process.run.output", [
        "classification", "exitCode", "signal", "durationMs", "stdout", "stderr",
        "outputLimitExceeded", "processGroupReaped", "sandboxed", "filesystemIsolation",
        "networkIsolation", "preparedHash", "postGit",
      ]),
      sideEffectClass: "local_irreversible",
      permission: "ask",
    }),
    tool("robin.git.status@1", ROBIN_GIT_PACK_ID, "status", {
      description:
        "Inspect bounded NUL-delimited Git status and Robin attribution without changing Git state.",
      inputSchema: EMPTY_INPUT,
      outputSchema: flexibleObjectOutput(
        "robin.git.status.output",
        ["status", "submoduleWorktreeEvidence"],
        [
          "status", "capturedAt", "statusSha256", "branch", "entries", "totalEntries",
          "truncated", "submoduleWorktreeEvidence", "reason", "attribution",
        ],
      ),
      sideEffectClass: "none",
      permission: "allow",
    }),
    tool("robin.git.diff@1", ROBIN_GIT_PACK_ID, "diff", {
      description:
        "Inspect a bounded working-tree or staged Git diff with helpers, pagers, and text conversion disabled.",
      inputSchema: GIT_DIFF_INPUT,
      outputSchema: objectOutput("robin.git.diff.output", [
        "kind", "paths", "text", "encoding", "totalBytes", "retainedBytes",
        "omittedBytes", "truncated", "sha256", "submoduleWorktreeEvidence",
      ]),
      sideEffectClass: "none",
      permission: "allow",
    }),
  ]);

export const ROBIN_R2_TOOL_REFERENCES: readonly CapabilityOperationReference[] =
  Object.freeze(ROBIN_R2_TOOL_DEFINITIONS.map((entry) => entry.reference));

export function robinR2ToolDefinition(
  reference: CapabilityOperationReference,
): RobinR2ToolDefinition {
  const matched = ROBIN_R2_TOOL_DEFINITIONS.find(
    (candidate) =>
      candidate.reference.packId === reference.packId &&
      candidate.reference.packVersion === reference.packVersion &&
      candidate.reference.operationId === reference.operationId &&
      candidate.reference.operationVersion === reference.operationVersion,
  );
  if (matched === undefined) {
    throw new Error("The requested Robin tool definition is not installed in R2.");
  }
  return matched;
}

function tool(
  toolId: RobinR2ToolId,
  packId: string,
  operationId: string,
  input: {
    readonly description: string;
    readonly inputSchema: VersionedSchema;
    readonly outputSchema: VersionedSchema;
    readonly sideEffectClass: SideEffectClass;
    readonly permission: RobinR2ToolDefinition["permission"];
  },
): RobinR2ToolDefinition {
  return Object.freeze({
    toolId,
    reference: Object.freeze({
      packId,
      packVersion: ROBIN_R2_PACK_VERSION,
      operationId,
      operationVersion: 1,
    }),
    definition: Object.freeze({
      operationId,
      operationVersion: 1,
      description: input.description,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      sideEffectClass: input.sideEffectClass,
    }),
    permission: input.permission,
  });
}

function editOutput(schemaId: string): VersionedSchema {
  return objectOutput(schemaId, [
    "path", "operation", "beforeSha256", "afterSha256", "beforeBytes", "afterBytes",
    "changedLineCount", "diffSha256", "diffPreview", "diffPreviewTruncated",
    "ledgerSequence", "directoryFsync", "postGit",
  ]);
}

function objectOutput(schemaId: string, required: readonly string[]): VersionedSchema {
  return flexibleObjectOutput(schemaId, required, required);
}

function flexibleObjectOutput(
  schemaId: string,
  required: readonly string[],
  properties: readonly string[],
): VersionedSchema {
  return versionedSchema(schemaId, {
    type: "object",
    additionalProperties: false,
    required: [...required],
    properties: Object.fromEntries(properties.map((name) => [name, {}])),
  });
}

function versionedSchema(
  schemaId: string,
  document: VersionedSchema["document"],
): VersionedSchema {
  return Object.freeze({ schemaId, schemaVersion: 1, document });
}
