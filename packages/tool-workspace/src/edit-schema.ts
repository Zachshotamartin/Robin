import type { VersionedSchema } from "@guard/contracts";

export const APPLY_PATCH_V1_SCHEMA: VersionedSchema = Object.freeze({
  schemaId: "robin.edit.apply_patch.input",
  schemaVersion: 1,
  document: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["path", "expectedSha256", "expectedSize", "hunks"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096 },
      expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      expectedSize: { type: "integer", minimum: 0 },
      hunks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["oldText", "newText", "expectedOccurrences"],
          properties: {
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
            expectedOccurrences: { const: 1 },
            expectedStartLine: { type: "integer", minimum: 1 },
          },
        },
      },
    },
  }),
});

export const CREATE_FILE_V1_SCHEMA: VersionedSchema = Object.freeze({
  schemaId: "robin.edit.create_file.input",
  schemaVersion: 1,
  document: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["path", "expectedAbsent", "content"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096 },
      expectedAbsent: { const: true },
      content: { type: "string" },
    },
  }),
});

export const DELETE_FILE_V1_SCHEMA: VersionedSchema = Object.freeze({
  schemaId: "robin.edit.delete_file.input",
  schemaVersion: 1,
  document: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["path", "expectedSha256"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096 },
      expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
  }),
});

export const MOVE_FILE_V1_SCHEMA: VersionedSchema = Object.freeze({
  schemaId: "robin.edit.move_file.input",
  schemaVersion: 1,
  document: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["source", "destination", "expectedSha256"],
    properties: {
      source: { type: "string", minLength: 1, maxLength: 4_096 },
      destination: { type: "string", minLength: 1, maxLength: 4_096 },
      expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
  }),
});
