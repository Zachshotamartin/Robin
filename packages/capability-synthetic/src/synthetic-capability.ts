import {
  CONTRACT_SCHEMA_VERSION,
  canonicalize,
  createDomainError,
  sha256Hex,
} from "@guard/contracts";
import type { JsonObject, TaskProfile } from "@guard/contracts";

import { InMemoryContextSource } from "@guard/context-broker";
import type { CapabilityOperationReference, CapabilityPack } from "@guard/capability-gateway";

export const SYNTHETIC_TRANSFORM_REFERENCE: CapabilityOperationReference =
  Object.freeze({
    packId: "synthetic.transform",
    packVersion: 1,
    operationId: "transform_text",
    operationVersion: 1,
  });

const MAXIMUM_TRANSFORM_BYTES = 256;

export function createSyntheticContextSource(): InMemoryContextSource {
  return new InMemoryContextSource({
    descriptor: {
      sourceId: "synthetic:transform-input",
      sourceVersion: 1,
      scheme: "memory",
      description: "Bounded synthetic input for a domain-neutral transform.",
    },
    records: [
      {
        recordId: "greeting",
        value: { text: "  Guarded agents transform bounded data.  " },
        mediaType: "application/json",
        classification: "synthetic",
      },
    ],
    limits: { maximumRecords: 2, maximumRecordBytes: 256 },
  });
}

export function createSyntheticTransformPack(): CapabilityPack {
  return {
    packId: SYNTHETIC_TRANSFORM_REFERENCE.packId,
    packVersion: SYNTHETIC_TRANSFORM_REFERENCE.packVersion,
    operations: [
      {
        definition: {
          operationId: SYNTHETIC_TRANSFORM_REFERENCE.operationId,
          operationVersion: SYNTHETIC_TRANSFORM_REFERENCE.operationVersion,
          description: "Normalize and transform one bounded text value.",
          inputSchema: {
            schemaId: "synthetic.transform_text.input",
            schemaVersion: 1,
            document: {
              type: "object",
              additionalProperties: false,
              required: ["text", "mode"],
              properties: {
                text: { type: "string" },
                mode: { type: "string", enum: ["uppercase", "lowercase"] },
              },
            },
          },
          outputSchema: {
            schemaId: "synthetic.transform_text.output",
            schemaVersion: 1,
            document: {
              type: "object",
              additionalProperties: false,
              required: ["transformed", "inputBytes", "outputBytes"],
              properties: {
                transformed: { type: "string" },
                inputBytes: { type: "integer", minimum: 0 },
                outputBytes: { type: "integer", minimum: 0 },
              },
            },
          },
          sideEffectClass: "none",
        },
        normalize(input) {
          const text = (input["text"] as string).normalize("NFC").trim();
          const mode = input["mode"] as "uppercase" | "lowercase";
          const inputBytes = Buffer.byteLength(text, "utf8");
          if (text.length === 0) {
            throw invalidInput("Synthetic transform text must not be blank.");
          }
          if (inputBytes > MAXIMUM_TRANSFORM_BYTES) {
            throw invalidInput("Synthetic transform text exceeds its semantic byte bound.");
          }
          const transformed = transformText(text, mode);
          const outputBytes = Buffer.byteLength(transformed, "utf8");
          if (outputBytes > MAXIMUM_TRANSFORM_BYTES) {
            throw invalidInput(
              "Synthetic transformed text exceeds its semantic byte bound.",
            );
          }
          return {
            normalizedInput: { mode, text },
            resource: {
              scheme: "memory",
              sourceId: "synthetic:transform-input",
              classification: "synthetic",
            },
            request: {
              intent: "transform_text",
              mode,
              inputBytes,
              inputSha256: sha256Hex(text),
            },
            preconditions: [
              {
                preconditionType: "synthetic.input.sha256",
                preconditionVersion: 1,
                attributes: { sha256: sha256Hex(text) },
              },
            ],
          };
        },
        execute(action): JsonObject {
          const text = action.normalizedInput["text"] as string;
          const mode = action.normalizedInput["mode"] as
            | "uppercase"
            | "lowercase";
          const transformed = transformText(text, mode);
          return {
            transformed,
            inputBytes: Buffer.byteLength(text, "utf8"),
            outputBytes: Buffer.byteLength(transformed, "utf8"),
          };
        },
        release(raw, action) {
          const inputBytes = raw["inputBytes"]!;
          const outputBytes = raw["outputBytes"]!;
          return {
            audit: {
              inputBytes,
              mode: action.normalizedInput["mode"]!,
              outputBytes,
            },
            human: {
              summary: `Transformed ${String(inputBytes)} bytes into ${String(
                outputBytes,
              )} bytes.`,
            },
            agent: { transformed: raw["transformed"]! },
          };
        },
      },
    ],
  };
}

function transformText(
  text: string,
  mode: "uppercase" | "lowercase",
): string {
  return mode === "uppercase" ? text.toUpperCase() : text.toLowerCase();
}

export const SYNTHETIC_TASK_PROFILE: TaskProfile = immutableProfile({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  profileId: "synthetic-transform",
  profileVersion: 1,
  objectiveSchema: {
    schemaId: "synthetic.transform.objective",
    schemaVersion: 1,
    document: {
      type: "object",
      additionalProperties: false,
      required: ["recordId", "mode"],
      properties: {
        recordId: { type: "string" },
        mode: { type: "string", enum: ["uppercase", "lowercase"] },
      },
    },
  },
  driverProfile: {
    componentId: "scripted",
    componentVersion: 1,
    configuration: { scriptId: "synthetic-transform-golden" },
  },
  modelBindings: [],
  contextSources: [
    {
      bindingId: "transform-input",
      componentId: "synthetic:transform-input",
      componentVersion: 1,
      configuration: { maximumBytes: 256 },
    },
  ],
  capabilityPacks: [
    {
      bindingId: "transform",
      componentId: SYNTHETIC_TRANSFORM_REFERENCE.packId,
      componentVersion: SYNTHETIC_TRANSFORM_REFERENCE.packVersion,
      configuration: { maximumInputBytes: MAXIMUM_TRANSFORM_BYTES },
    },
  ],
  policyProfile: {
    componentId: "synthetic-safe-default",
    componentVersion: 1,
    configuration: {},
  },
  outcomeSchema: {
    schemaId: "synthetic.transform.outcome",
    schemaVersion: 1,
    document: {
      type: "object",
      additionalProperties: false,
      required: ["transformed"],
      properties: { transformed: { type: "string" } },
    },
  },
  budgetPolicy: {
    maxTurns: 2,
    maxActions: 1,
    maxElapsedMs: 5_000,
    maxInputBytes: 256,
    maxOutputBytes: 256,
    extensions: {},
  },
  evidenceMode: "ephemeral_metadata",
  evaluationProfile: null,
});

function immutableProfile(value: TaskProfile): TaskProfile {
  const detached = JSON.parse(canonicalize(value)) as TaskProfile;
  return deepFreeze(detached);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
