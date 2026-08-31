import {
  CONTRACT_SCHEMA_VERSION,
  canonicalize,
  createDomainError,
  sha256Hex,
  type JsonObject,
  type NormalizedAction,
} from "@guard/contracts";
import {
  bindCapabilityAgentContextRelease,
  type CapabilityAgentContextReleaseDefinition,
  type CapabilityOperationReference,
  type CapabilityPack,
} from "@guard/capability-gateway";
import { MEMORY_POLICY_ATTRIBUTE_CATALOG } from "@guard/context-broker";
import {
  compilePolicySnapshot,
  type PolicySnapshot,
} from "@guard/policy-engine";

export const ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_REFERENCE:
  CapabilityOperationReference = Object.freeze({
    packId: "robin.synthetic",
    packVersion: 1,
    operationId: "workspace_summary",
    operationVersion: 1,
  });

export const ROBIN_SYNTHETIC_INSPECT_FILE_REFERENCE:
  CapabilityOperationReference = Object.freeze({
    packId: "robin.synthetic",
    packVersion: 1,
    operationId: "inspect_file",
    operationVersion: 1,
  });

export const ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_TOOL =
  "robin.synthetic.workspace_summary@1";
export const ROBIN_SYNTHETIC_INSPECT_FILE_TOOL =
  "robin.synthetic.inspect_file@1";

const FIXTURE_PATH = "src/calculate.ts";
const FIXTURE_LINES = Object.freeze([
  "export function calculateTotal(values: readonly number[]): number {",
  "  return values.reduce((total, value) => total - value, 0);",
  "}",
]);
const FIXTURE_CONTENT = FIXTURE_LINES.join("\n") + "\n";

const RELEASE_DEFINITION: CapabilityAgentContextReleaseDefinition =
  Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceVersion: 1,
    catalogId: MEMORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
    catalogVersion: MEMORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
    catalogContentHash: MEMORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
    classification: "synthetic",
    reason: "robin.synthetic.coding_fixture.output",
  });

const POLICY_SOURCE = `policy "allow-robin-synthetic-workspace-summary" priority 100 {
  when action.pack == "robin.synthetic" and action.operation == "workspace_summary" and action.side_effect == "none"
  allow
  reason "The workspace summary reads a deterministic in-memory fixture."
}

policy "allow-robin-synthetic-inspect-file" priority 100 {
  when action.pack == "robin.synthetic" and action.operation == "inspect_file" and action.side_effect == "none"
  allow
  reason "The file inspection reads a deterministic in-memory fixture."
}
`;

export const ROBIN_SYNTHETIC_CODING_POLICY_SNAPSHOT: PolicySnapshot =
  compileCodingPolicy();

/**
 * R1 coding tools operate only on immutable in-memory fixtures. They prove the
 * structured-call/gateway/observation loop without implying repository access.
 */
export function createRobinSyntheticCodingPack(): CapabilityPack {
  return {
    packId: "robin.synthetic",
    packVersion: 1,
    operations: [workspaceSummaryOperation(), inspectFileOperation()],
  };
}

function workspaceSummaryOperation(): CapabilityPack["operations"][number] {
  return {
    definition: {
      operationId: ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_REFERENCE.operationId,
      operationVersion:
        ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_REFERENCE.operationVersion,
      description:
        "Return a bounded summary of Robin's deterministic fixture workspace.",
      inputSchema: {
        schemaId: "robin.synthetic.workspace_summary.input",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      outputSchema: {
        schemaId: "robin.synthetic.workspace_summary.output",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: [
            "repositoryName",
            "primaryLanguage",
            "testCommand",
            "candidateFile",
          ],
          properties: {
            repositoryName: { type: "string" },
            primaryLanguage: { type: "string" },
            testCommand: { type: "string" },
            candidateFile: { type: "string" },
          },
        },
      },
      sideEffectClass: "none",
    },
    agentContextRelease: RELEASE_DEFINITION,
    normalize() {
      return {
        normalizedInput: {},
        resource: {
          scheme: "memory",
          sourceId: "robin:r1-fixture-workspace",
          classification: "synthetic",
        },
        request: { intent: "summarize_fixture_workspace" },
        preconditions: [],
      };
    },
    execute(): JsonObject {
      return {
        repositoryName: "robin-r1-fixture",
        primaryLanguage: "TypeScript",
        testCommand: "npm test",
        candidateFile: FIXTURE_PATH,
      };
    },
    release(raw, action) {
      const agent = frozenJson(raw);
      return releaseViews(
        action,
        raw,
        agent,
        "Returned the deterministic fixture workspace summary.",
        "workspace-summary",
      );
    },
  };
}

function inspectFileOperation(): CapabilityPack["operations"][number] {
  return {
    definition: {
      operationId: ROBIN_SYNTHETIC_INSPECT_FILE_REFERENCE.operationId,
      operationVersion: ROBIN_SYNTHETIC_INSPECT_FILE_REFERENCE.operationVersion,
      description:
        "Inspect bounded lines from one file in Robin's deterministic fixture workspace.",
      inputSchema: {
        schemaId: "robin.synthetic.inspect_file.input",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string", minLength: 1, maxLength: 256 } },
        },
      },
      outputSchema: {
        schemaId: "robin.synthetic.inspect_file.output",
        schemaVersion: 1,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["path", "lines", "contentHash"],
          properties: {
            path: { type: "string" },
            lines: {
              type: "array",
              maxItems: 32,
              items: { type: "string", maxLength: 512 },
            },
            contentHash: { type: "string" },
          },
        },
      },
      sideEffectClass: "none",
    },
    agentContextRelease: RELEASE_DEFINITION,
    normalize(input) {
      const path = String(input["path"] ?? "").normalize("NFC");
      if (path !== FIXTURE_PATH) {
        throw createDomainError({
          code: "invalid_input",
          message: "The R1 fixture exposes only src/calculate.ts.",
        });
      }
      return {
        normalizedInput: { path },
        resource: {
          scheme: "memory",
          sourceId: "robin:r1-fixture-workspace",
          locator: { path },
          mediaType: "text/typescript",
          classification: "synthetic",
        },
        request: {
          intent: "inspect_fixture_file",
          path,
          expectedContentHash: "sha256:" + sha256Hex(FIXTURE_CONTENT),
        },
        preconditions: [
          {
            preconditionType: "synthetic.fixture.sha256",
            preconditionVersion: 1,
            attributes: { sha256: sha256Hex(FIXTURE_CONTENT) },
          },
        ],
      };
    },
    execute(action): JsonObject {
      return {
        path: action.normalizedInput["path"]!,
        lines: FIXTURE_LINES,
        contentHash: "sha256:" + sha256Hex(FIXTURE_CONTENT),
      };
    },
    release(raw, action) {
      const agent = frozenJson(raw);
      return releaseViews(
        action,
        raw,
        agent,
        `Inspected ${FIXTURE_PATH} from the deterministic fixture workspace.`,
        "inspect-file",
      );
    },
  };
}

function releaseViews(
  action: NormalizedAction,
  raw: JsonObject,
  agent: JsonObject,
  summary: string,
  recordId: string,
) {
  const descriptor = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceVersion: RELEASE_DEFINITION.sourceVersion,
    resource: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      scheme: "memory",
      sourceId: "robin:r1-fixture-workspace",
      locator: { recordId },
      mediaType: "application/json",
      classification: RELEASE_DEFINITION.classification,
    },
    policyProjection: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      catalogId: RELEASE_DEFINITION.catalogId,
      catalogVersion: RELEASE_DEFINITION.catalogVersion,
      catalogContentHash: RELEASE_DEFINITION.catalogContentHash,
      resourceAttributes: { recordId },
      requestAttributes: {},
    },
    classification: RELEASE_DEFINITION.classification,
    reason: RELEASE_DEFINITION.reason,
  } as const;
  return {
    audit: { fixture: recordId },
    human: { summary },
    agent,
    agentContextRelease: bindCapabilityAgentContextRelease(
      descriptor,
      action,
      raw,
      agent,
    ),
  };
}

function frozenJson(value: JsonObject): JsonObject {
  return deepFreeze(JSON.parse(canonicalize(value)) as JsonObject);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function compileCodingPolicy(): PolicySnapshot {
  const result = compilePolicySnapshot({
    policyVersionId: "pol_018f05a0-7b01-7000-8000-000000000091",
    source: POLICY_SOURCE,
    sourceId: "robin-r1-synthetic-coding.guard",
    defaultEffect: "deny",
  });
  if (!result.ok) {
    throw createDomainError({
      code: "invariant_violated",
      message: "The built-in Robin R1 synthetic coding policy did not compile.",
    });
  }
  return result.snapshot;
}
