export const ROBIN_GIT_STATUS_TOOL_ID = "robin.git.status@1" as const;
export const ROBIN_GIT_DIFF_TOOL_ID = "robin.git.diff@1" as const;

export interface RobinGitToolDefinition {
  readonly toolId: typeof ROBIN_GIT_STATUS_TOOL_ID | typeof ROBIN_GIT_DIFF_TOOL_ID;
  readonly operationId: "git_status_read" | "git_diff_read";
  readonly description: string;
  readonly sideEffectClass: "none";
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const STATUS_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    includeIgnored: Object.freeze({ type: "boolean" }),
  }),
});

const DIFF_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "kind",
    "paths",
    "maximumFiles",
    "maximumRetainedBytes",
    "maximumAbsoluteBytes",
  ]),
  properties: Object.freeze({
    kind: Object.freeze({ type: "string", enum: Object.freeze(["working", "staged"]) }),
    paths: Object.freeze({
      type: "array",
      maxItems: 10_000,
      items: Object.freeze({ type: "string", minLength: 1, maxLength: 16_384 }),
    }),
    maximumFiles: Object.freeze({ type: "integer", minimum: 1, maximum: 10_000 }),
    maximumRetainedBytes: Object.freeze({
      type: "integer",
      minimum: 1,
      maximum: 64 * 1024 * 1024,
    }),
    maximumAbsoluteBytes: Object.freeze({
      type: "integer",
      minimum: 1,
      maximum: 64 * 1024 * 1024,
    }),
  }),
});

export const ROBIN_GIT_TOOL_DEFINITIONS: readonly RobinGitToolDefinition[] =
  Object.freeze([
    Object.freeze({
      toolId: ROBIN_GIT_STATUS_TOOL_ID,
      operationId: "git_status_read",
      description: "Read a bounded, NUL-delimited porcelain-v2 repository snapshot.",
      sideEffectClass: "none",
      inputSchema: STATUS_INPUT_SCHEMA,
    }),
    Object.freeze({
      toolId: ROBIN_GIT_DIFF_TOOL_ID,
      operationId: "git_diff_read",
      description: "Read a bounded working-tree or index diff without external helpers.",
      sideEffectClass: "none",
      inputSchema: DIFF_INPUT_SCHEMA,
    }),
  ]);
