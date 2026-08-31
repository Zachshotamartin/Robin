import type { ProcessRunResult, PreparedProcessExecution } from "./process-controller.js";

export const ROBIN_PROCESS_PACK_ID = "robin.process" as const;
export const ROBIN_PROCESS_PACK_VERSION = 1 as const;
export const ROBIN_PROCESS_RUN_OPERATION_ID = "run" as const;
export const ROBIN_PROCESS_RUN_OPERATION_VERSION = 1 as const;
export const ROBIN_PROCESS_RUN_TOOL_ID = "robin.process.run@1" as const;

export const ROBIN_PROCESS_RUN_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
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
  ],
  properties: {
    schemaVersion: { const: 1 },
    executable: { type: "string", minLength: 1, maxLength: 4096 },
    argv: {
      type: "array",
      maxItems: 256,
      items: { type: "string", maxLength: 65536 },
    },
    cwd: { type: "string", minLength: 1, maxLength: 4096 },
    environment: {
      type: "object",
      maxProperties: 64,
      additionalProperties: { type: "string", maxLength: 65536 },
    },
    timeoutMs: { type: "integer", minimum: 1, maximum: 1800000 },
    terminationGraceMs: { type: "integer", minimum: 0, maximum: 10000 },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["retainedHeadBytes", "retainedTailBytes", "absoluteBytes"],
      properties: {
        retainedHeadBytes: { type: "integer", minimum: 0, maximum: 4194304 },
        retainedTailBytes: { type: "integer", minimum: 0, maximum: 4194304 },
        absoluteBytes: { type: "integer", minimum: 1, maximum: 67108864 },
      },
    },
    stdin: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "closed" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text"],
          properties: {
            kind: { const: "inline_utf8" },
            text: { type: "string", maxLength: 1048576 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "path", "expectedSha256", "maximumBytes"],
          properties: {
            kind: { const: "workspace_file" },
            path: { type: "string", minLength: 1, maxLength: 4096 },
            expectedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            maximumBytes: { type: "integer", minimum: 1, maximum: 1048576 },
          },
        },
      ],
    },
    intent: {
      enum: ["verification", "test", "lint", "build", "format", "other"],
    },
  },
} as const);

export interface ProcessApprovalSummary {
  readonly toolId: typeof ROBIN_PROCESS_RUN_TOOL_ID;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environmentProfile: string;
  readonly environmentAddedKeys: readonly string[];
  readonly timeoutMs: number;
  readonly absoluteOutputBytes: number;
  readonly stdinBytes: number;
  readonly preparedHash: string;
  readonly sandboxed: false;
  readonly filesystemIsolation: "none";
  readonly networkIsolation: "none";
}

export function summarizeProcessApproval(
  prepared: PreparedProcessExecution,
): ProcessApprovalSummary {
  return Object.freeze({
    toolId: ROBIN_PROCESS_RUN_TOOL_ID,
    executable: prepared.executable.physicalPath,
    argv: Object.freeze([...prepared.request.argv]),
    cwd: prepared.cwd.physicalPath,
    environmentProfile: prepared.environment.metadata.profileId,
    environmentAddedKeys: prepared.environment.metadata.addedKeys,
    timeoutMs: prepared.request.timeoutMs,
    absoluteOutputBytes: prepared.request.output.absoluteBytes,
    stdinBytes: prepared.stdin.byteLength,
    preparedHash: prepared.preparedHash,
    sandboxed: false,
    filesystemIsolation: "none",
    networkIsolation: "none",
  });
}

export interface ProcessAgentObservation {
  readonly classification: ProcessRunResult["classification"];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: {
    readonly head: string;
    readonly tail: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly truncated: boolean;
    readonly omittedBytes: number;
    readonly encoding: "utf8" | "binary_or_invalid_utf8";
  };
  readonly stderr: {
    readonly head: string;
    readonly tail: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly truncated: boolean;
    readonly omittedBytes: number;
    readonly encoding: "utf8" | "binary_or_invalid_utf8";
  };
  readonly outputLimitExceeded: boolean;
  readonly processGroupReaped: boolean;
  readonly sandboxed: false;
  readonly filesystemIsolation: "none";
  readonly networkIsolation: "none";
}

export function releaseProcessAgentObservation(
  result: ProcessRunResult,
): ProcessAgentObservation {
  return Object.freeze({
    classification: result.classification,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    stdout: releasedChannel(result.output.stdout),
    stderr: releasedChannel(result.output.stderr),
    outputLimitExceeded: result.output.limitExceeded,
    processGroupReaped: result.termination.groupReaped,
    sandboxed: false,
    filesystemIsolation: "none",
    networkIsolation: "none",
  });
}

function releasedChannel(
  channel: ProcessRunResult["output"]["stdout"],
): ProcessAgentObservation["stdout"] {
  return Object.freeze({
    head: channel.headText,
    tail: channel.tailText,
    byteLength: channel.byteLength,
    sha256: channel.sha256,
    truncated: channel.truncated,
    omittedBytes: channel.omittedBytes,
    encoding: channel.encoding,
  });
}
