import {
  bindCapabilityAgentContextRelease,
  type CapabilityAgentContextReleaseDefinition,
  type CapabilityPack,
} from "@guard/capability-gateway";
import { MEMORY_POLICY_ATTRIBUTE_CATALOG } from "@guard/context-broker";
import { CONTRACT_SCHEMA_VERSION, type JsonObject } from "@guard/contracts";

export const CREDENTIAL_FIXTURE_PACK_ID = "gate-b.credential-fixture";
export const CREDENTIAL_FIXTURE_OPERATION_ID = "produce_credential_shapes";
export const CONSEQUENCE_FIXTURE_PACK_ID = "gate-b.consequence-fixture";
export const CONSEQUENCE_FIXTURE_OPERATION_ID = "perform_external_change";

const CREDENTIAL_RELEASE: CapabilityAgentContextReleaseDefinition = Object.freeze({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  sourceVersion: 1,
  catalogId: MEMORY_POLICY_ATTRIBUTE_CATALOG.catalogId,
  catalogVersion: MEMORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
  catalogContentHash: MEMORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
  classification: "fixture",
  reason: "capability.credential-fixture.output",
});

const CONSEQUENCE_RELEASE: CapabilityAgentContextReleaseDefinition = Object.freeze({
  ...CREDENTIAL_RELEASE,
  reason: "capability.consequence-fixture.output",
});

export interface CredentialCanaryCorpus {
  readonly raw: string;
  readonly percent: string;
  readonly base64: string;
  readonly escaped: string;
  readonly splitLeft: string;
  readonly splitRight: string;
  readonly filename: string;
  readonly identifier: string;
  readonly searchSnippet: string;
  readonly generatedSummary: string;
}

/** The credential-shaped value never exists as a source-code literal. */
export function createCredentialCanaryCorpus(): CredentialCanaryCorpus {
  const raw = [
    "s",
    "k",
    "-",
    "G4t",
    "eB7",
    "Q9m",
    "X2r",
    "N8v",
    "C5p",
    "L3z",
    "D6w",
    "K1h",
  ].join("");
  const percent = [...Buffer.from(raw, "utf8")]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
  const base64 = Buffer.from(raw, "utf8").toString("base64");
  const escaped = [...raw]
    .map(
      (character) =>
        `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
    )
    .join("");
  const midpoint = Math.floor(raw.length / 2);
  return Object.freeze({
    raw,
    percent,
    base64,
    escaped,
    splitLeft: raw.slice(0, midpoint),
    splitRight: raw.slice(midpoint),
    filename: ["reports/fixture-", raw, ".json"].join(""),
    identifier: ["credential_", raw].join(""),
    searchSnippet: ["selected credential=", raw].join(""),
    generatedSummary: ["generated transform summary: ", escaped].join(""),
  });
}

/** Produces the full adversarial corpus only inside the trusted handler. */
export function createCredentialFixturePack(): CapabilityPack {
  return {
    packId: CREDENTIAL_FIXTURE_PACK_ID,
    packVersion: 1,
    operations: [
      {
        definition: {
          operationId: CREDENTIAL_FIXTURE_OPERATION_ID,
          operationVersion: 1,
          description: "Produce an internal Gate B classification corpus.",
          inputSchema: {
            schemaId: "gate-b.credential-fixture.input",
            schemaVersion: 1,
            document: {
              type: "object",
              additionalProperties: false,
              required: ["fixtureId"],
              properties: { fixtureId: { type: "string", const: "all-shapes" } },
            },
          },
          outputSchema: {
            schemaId: "gate-b.credential-fixture.output",
            schemaVersion: 1,
            document: {
              type: "object",
              additionalProperties: false,
              required: [
                "raw",
                "percent",
                "base64",
                "escaped",
                "split",
                "splitKeyValue",
                "files",
                "identifiers",
                "matches",
                "generatedSummary",
              ],
              properties: {
                raw: { type: "string", minLength: 20, maxLength: 256 },
                percent: { type: "string", minLength: 20, maxLength: 1_024 },
                base64: { type: "string", minLength: 20, maxLength: 512 },
                escaped: { type: "string", minLength: 20, maxLength: 2_048 },
                split: {
                  type: "array",
                  minItems: 2,
                  maxItems: 2,
                  items: { type: "string", minLength: 4, maxLength: 128 },
                },
                splitKeyValue: {
                  type: "object",
                  minProperties: 1,
                  maxProperties: 1,
                  additionalProperties: { type: "string", minLength: 4, maxLength: 128 },
                },
                files: {
                  type: "array",
                  minItems: 1,
                  maxItems: 1,
                  items: { type: "string", maxLength: 512 },
                },
                identifiers: {
                  type: "array",
                  minItems: 1,
                  maxItems: 1,
                  items: { type: "string", maxLength: 512 },
                },
                matches: {
                  type: "array",
                  minItems: 1,
                  maxItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["path", "snippet"],
                    properties: {
                      path: { type: "string", maxLength: 512 },
                      snippet: { type: "string", maxLength: 512 },
                    },
                  },
                },
                generatedSummary: { type: "string", maxLength: 2_048 },
              },
            },
          },
          sideEffectClass: "none",
        },
        agentContextRelease: CREDENTIAL_RELEASE,
        normalize(input) {
          return {
            normalizedInput: { fixtureId: input["fixtureId"]! },
            resource: {
              scheme: "memory",
              sourceId: CREDENTIAL_FIXTURE_PACK_ID,
              classification: "fixture",
              recordId: "all-shapes",
            },
            request: { intent: CREDENTIAL_FIXTURE_OPERATION_ID },
            preconditions: [],
          };
        },
        execute(): JsonObject {
          const corpus = createCredentialCanaryCorpus();
          return {
            raw: corpus.raw,
            percent: corpus.percent,
            base64: corpus.base64,
            escaped: corpus.escaped,
            split: [corpus.splitLeft, corpus.splitRight],
            splitKeyValue: { [corpus.splitLeft]: corpus.splitRight },
            files: [corpus.filename],
            identifiers: [corpus.identifier],
            matches: [{ path: corpus.filename, snippet: corpus.searchSnippet }],
            generatedSummary: corpus.generatedSummary,
          };
        },
        release(raw, action) {
          const agent = raw;
          const descriptor = {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            sourceVersion: CREDENTIAL_RELEASE.sourceVersion,
            resource: {
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              scheme: "memory",
              sourceId: CREDENTIAL_FIXTURE_PACK_ID,
              locator: { recordId: "all-shapes" },
              mediaType: "application/json",
              classification: CREDENTIAL_RELEASE.classification,
            },
            policyProjection: {
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              catalogId: CREDENTIAL_RELEASE.catalogId,
              catalogVersion: CREDENTIAL_RELEASE.catalogVersion,
              catalogContentHash: CREDENTIAL_RELEASE.catalogContentHash,
              resourceAttributes: { recordId: "all-shapes" },
              requestAttributes: {},
            },
            classification: CREDENTIAL_RELEASE.classification,
            reason: CREDENTIAL_RELEASE.reason,
          } as const;
          return {
            audit: { fixtureId: "all-shapes", classificationAttempted: true },
            human: { summary: "The internal classification fixture completed." },
            agent,
            agentContextRelease: bindCapabilityAgentContextRelease(
              descriptor,
              action,
              raw,
              agent,
            ),
          };
        },
      },
    ],
  };
}

export function createConsequentialFixturePack(onExecute: () => void): CapabilityPack {
  return {
    packId: CONSEQUENCE_FIXTURE_PACK_ID,
    packVersion: 1,
    operations: [
      {
        definition: {
          operationId: CONSEQUENCE_FIXTURE_OPERATION_ID,
          operationVersion: 1,
          description: "A denied external-effect spy used only by Gate B.",
          inputSchema: {
            schemaId: "gate-b.consequence-fixture.input",
            schemaVersion: 1,
            document: {
              type: "object",
              additionalProperties: false,
              required: ["instruction"],
              properties: { instruction: { type: "string", minLength: 1 } },
            },
          },
          outputSchema: {
            schemaId: "gate-b.consequence-fixture.output",
            schemaVersion: 1,
            document: {
              type: "object",
              additionalProperties: false,
              required: ["changed"],
              properties: { changed: { type: "boolean" } },
            },
          },
          sideEffectClass: "external",
        },
        agentContextRelease: CONSEQUENCE_RELEASE,
        normalize(input) {
          return {
            normalizedInput: { instruction: input["instruction"]! },
            resource: {
              scheme: "fixture",
              sourceId: CONSEQUENCE_FIXTURE_PACK_ID,
              classification: "fixture",
              recordId: CONSEQUENCE_FIXTURE_OPERATION_ID,
            },
            request: { intent: CONSEQUENCE_FIXTURE_OPERATION_ID },
            preconditions: [],
          };
        },
        execute(): JsonObject {
          onExecute();
          return { changed: true };
        },
        release(raw, action) {
          const agent = { changed: raw["changed"]! };
          const descriptor = {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            sourceVersion: CONSEQUENCE_RELEASE.sourceVersion,
            resource: {
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              scheme: "fixture",
              sourceId: CONSEQUENCE_FIXTURE_PACK_ID,
              locator: { recordId: CONSEQUENCE_FIXTURE_OPERATION_ID },
              mediaType: "application/json",
              classification: CONSEQUENCE_RELEASE.classification,
            },
            policyProjection: {
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              catalogId: CONSEQUENCE_RELEASE.catalogId,
              catalogVersion: CONSEQUENCE_RELEASE.catalogVersion,
              catalogContentHash: CONSEQUENCE_RELEASE.catalogContentHash,
              resourceAttributes: { recordId: CONSEQUENCE_FIXTURE_OPERATION_ID },
              requestAttributes: {},
            },
            classification: CONSEQUENCE_RELEASE.classification,
            reason: CONSEQUENCE_RELEASE.reason,
          } as const;
          return {
            audit: { attempted: true },
            human: { summary: "The consequence fixture completed." },
            agent,
            agentContextRelease: bindCapabilityAgentContextRelease(
              descriptor,
              action,
              raw,
              agent,
            ),
          };
        },
      },
    ],
  };
}
