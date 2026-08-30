import {
  CONTRACT_SCHEMA_VERSION,
  canonicalSha256Hex,
  createDomainError,
  parseNormalizedAction,
  snapshotBoundaryJsonObject,
} from "@guard/contracts";
import type { NormalizedAction } from "@guard/contracts";

import type {
  PolicyAttributeCatalog,
  PolicyAttributeCatalogSet,
  PolicyAttributeDefinition,
  PolicyAttributeEnvironment,
  PolicyAttributeSource,
  PolicyAttributeType,
  PolicyAttributeValue,
} from "./types.js";
import { compareUtf8 } from "./stable-order.js";

export const BASE_POLICY_ATTRIBUTE_CATALOG_ID = "guard.base" as const;
export const BASE_POLICY_ATTRIBUTE_SCHEMA_VERSION = 1 as const;

const RECOGNIZED_CATALOGS = new WeakSet<object>();
const RECOGNIZED_CATALOG_SETS = new WeakSet<object>();
const CATALOG_HASHES_BY_VERSION = new Map<string, string>();

/** Domain-neutral catalog from GENERAL_RUNTIME_ARCHITECTURE section 9. */
export const BASE_POLICY_ATTRIBUTE_CATALOG = createPolicyAttributeCatalog({
  catalogId: BASE_POLICY_ATTRIBUTE_CATALOG_ID,
  schemaVersion: BASE_POLICY_ATTRIBUTE_SCHEMA_VERSION,
  attributes: [
    definition("subject.kind", "string", false, objectField("subject", "kind")),
    definition("subject.driver_id", "string", true, objectField("subject", "driverId")),
    definition(
      "subject.compatibility_tier",
      "string",
      true,
      objectField("subject", "compatibilityTier"),
    ),
    definition("action.pack", "string", false, intrinsic("capabilityPackId")),
    definition("action.operation", "string", false, intrinsic("operationId")),
    definition("action.side_effect", "string", false, intrinsic("sideEffectClass")),
    definition("resource.scheme", "string", false, objectField("resource", "scheme")),
    definition(
      "resource.source_id",
      "string",
      false,
      objectField("resource", "sourceId"),
    ),
    definition(
      "resource.classification",
      "string",
      false,
      objectField("resource", "classification"),
    ),
    definition("request.intent", "string", true, objectField("request", "intent")),
    definition(
      "request.estimated_cost",
      "integer",
      true,
      objectField("request", "estimatedCost"),
    ),
    definition(
      "request.provenance",
      "string",
      true,
      objectField("request", "provenance"),
    ),
    definition(
      "environment.profile_id",
      "string",
      true,
      objectField("environment", "profileId"),
    ),
    definition(
      "environment.sandboxed",
      "boolean",
      false,
      objectField("environment", "sandboxed"),
    ),
    definition(
      "environment.network_profile",
      "string",
      false,
      objectField("environment", "networkProfile"),
    ),
    definition(
      "environment.trust_level",
      "string",
      false,
      objectField("environment", "trustLevel"),
    ),
  ],
});

export const BASE_POLICY_ATTRIBUTE_CATALOG_SET = composePolicyAttributeCatalogs([
  BASE_POLICY_ATTRIBUTE_CATALOG,
]);

export function createPolicyAttributeCatalog(input: unknown): PolicyAttributeCatalog {
  const detached = snapshotBoundaryJsonObject(input);
  if (!hasExactKeys(detached, ["catalogId", "schemaVersion", "attributes"])) {
    throw new TypeError("A policy attribute catalog has unknown or missing fields.");
  }
  const catalogId = nonEmpty(detached["catalogId"], "catalogId");
  const schemaVersion = positive(detached["schemaVersion"], "schemaVersion");
  const rawAttributes = detached["attributes"];
  if (!Array.isArray(rawAttributes) || rawAttributes.length === 0) {
    throw new TypeError("A policy attribute catalog requires at least one attribute.");
  }
  const names = new Set<string>();
  const attributes = rawAttributes.map((candidate) => {
    const parsed = parseDefinition(candidate);
    if (names.has(parsed.name)) {
      throw new TypeError("A catalog contains a duplicate policy attribute.");
    }
    names.add(parsed.name);
    return parsed;
  });
  const catalog = Object.freeze({
    catalogId,
    schemaVersion,
    contentHash: canonicalSha256Hex({ catalogId, schemaVersion, attributes }),
    attributes: Object.freeze(attributes),
  });
  const versionKey = `${catalogId}\u0000${schemaVersion}`;
  const existingHash = CATALOG_HASHES_BY_VERSION.get(versionKey);
  if (existingHash !== undefined && existingHash !== catalog.contentHash) {
    throw new TypeError(
      "A policy attribute catalog ID and version cannot be rebound to different semantics.",
    );
  }
  CATALOG_HASHES_BY_VERSION.set(versionKey, catalog.contentHash);
  RECOGNIZED_CATALOGS.add(catalog);
  return catalog;
}

export function composePolicyAttributeCatalogs(
  catalogs: readonly PolicyAttributeCatalog[],
): PolicyAttributeCatalogSet {
  if (!Array.isArray(catalogs) || catalogs.length === 0) {
    throw new TypeError("At least one recognized policy attribute catalog is required.");
  }
  const catalogIds = new Set<string>();
  const attributeNames = new Set<string>();
  const manifest: {
    readonly catalogId: string;
    readonly schemaVersion: number;
    readonly contentHash: string;
  }[] = [];
  const attributes: PolicyAttributeDefinition[] = [];
  for (const catalog of catalogs) {
    if (!RECOGNIZED_CATALOGS.has(catalog)) {
      throw new TypeError("An unrecognized policy attribute catalog was supplied.");
    }
    if (catalogIds.has(catalog.catalogId)) {
      throw new TypeError("A policy attribute catalog ID may be installed only once.");
    }
    catalogIds.add(catalog.catalogId);
    manifest.push(
      Object.freeze({
        catalogId: catalog.catalogId,
        schemaVersion: catalog.schemaVersion,
        contentHash: catalog.contentHash,
      }),
    );
    for (const attribute of catalog.attributes) {
      if (attributeNames.has(attribute.name)) {
        throw new TypeError("Installed catalogs contain a duplicate policy attribute.");
      }
      attributeNames.add(attribute.name);
      attributes.push(attribute);
    }
  }
  manifest.sort((left, right) => compareUtf8(left.catalogId, right.catalogId));
  attributes.sort((left, right) => compareUtf8(left.name, right.name));
  const set = Object.freeze({
    manifest: Object.freeze(manifest),
    attributes: Object.freeze(attributes),
  });
  RECOGNIZED_CATALOG_SETS.add(set);
  return set;
}

export function assertRecognizedCatalogSet(value: PolicyAttributeCatalogSet): void {
  if (!RECOGNIZED_CATALOG_SETS.has(value)) {
    throw new TypeError("A compiled policy requires a recognized catalog set.");
  }
}

export function policyAttributeDefinition(
  catalogs: PolicyAttributeCatalogSet,
  name: string,
): PolicyAttributeDefinition | undefined {
  assertRecognizedCatalogSet(catalogs);
  return catalogs.attributes.find((candidate) => candidate.name === name);
}

/** Constructs the only evaluator view from the exact normalized action. */
export function policyAttributesFromAction(
  input: NormalizedAction,
  catalogs: PolicyAttributeCatalogSet,
): PolicyAttributeEnvironment {
  assertRecognizedCatalogSet(catalogs);
  const action = parseNormalizedAction(input);
  if (action.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw evaluationError("The normalized action schema version is unsupported.");
  }
  const values: Record<string, PolicyAttributeValue> = Object.create(null) as Record<
    string,
    PolicyAttributeValue
  >;
  for (const attribute of catalogs.attributes) {
    const value = extract(action, attribute.source);
    if (value === undefined) {
      if (!attribute.optional) {
        throw evaluationError(`The required policy attribute ${attribute.name} is missing.`);
      }
      continue;
    }
    if (
      value === "" &&
      attribute.optional &&
      attribute.type === "string" &&
      attribute.matchKind === "canonical_path"
    ) {
      // Empty repository root is locator scope, not a canonical path target.
      continue;
    }
    values[attribute.name] = validateValue(value, attribute.name, attribute.type);
  }
  return Object.freeze({
    catalogManifest: catalogs.manifest,
    values: Object.freeze(values),
  });
}

function extract(action: NormalizedAction, source: PolicyAttributeSource): unknown {
  if (source.kind === "intrinsic") return action[source.field];
  const section = action[source.section];
  return Object.hasOwn(section, source.field) ? section[source.field] : undefined;
}

function definition(
  name: string,
  type: PolicyAttributeType,
  optional: boolean,
  source: PolicyAttributeSource,
  secretClassification: string | null = null,
  matchKind: "none" | "canonical_path" = "none",
): PolicyAttributeDefinition {
  return Object.freeze({
    name,
    type,
    optional,
    secretClassification,
    matchKind,
    source,
  });
}

function intrinsic(
  field: Extract<PolicyAttributeSource, { readonly kind: "intrinsic" }>["field"],
): PolicyAttributeSource {
  return Object.freeze({ kind: "intrinsic", field });
}

function objectField(
  section: Extract<PolicyAttributeSource, { readonly kind: "object_field" }>["section"],
  field: string,
): PolicyAttributeSource {
  return Object.freeze({ kind: "object_field", section, field });
}

function parseDefinition(input: unknown): PolicyAttributeDefinition {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("A policy attribute definition must be an object.");
  }
  const value = input as Readonly<Record<string, unknown>>;
  if (
    !hasExactKeys(value, [
      "name",
      "type",
      "optional",
      "secretClassification",
      "matchKind",
      "source",
    ])
  ) {
    throw new TypeError("A policy attribute definition has unknown or missing fields.");
  }
  const name = nonEmpty(value["name"], "attribute name");
  if (!isAttributeName(name)) {
    throw new TypeError("A policy attribute name is not a dotted identifier.");
  }
  const type = value["type"];
  if (!isAttributeType(type) || typeof value["optional"] !== "boolean") {
    throw new TypeError("A policy attribute definition has an invalid type or optional flag.");
  }
  const secret = value["secretClassification"];
  const matchKind = value["matchKind"];
  if (!(secret === null || (typeof secret === "string" && secret.trim().length > 0))) {
    throw new TypeError("A secret classification must be null or non-empty.");
  }
  if (!(matchKind === "none" || matchKind === "canonical_path")) {
    throw new TypeError("A policy attribute match kind is invalid.");
  }
  if (
    matchKind === "canonical_path" &&
    !(type === "string" || type === "list<string>")
  ) {
    throw new TypeError(
      "Only string or list<string> attributes can be canonical path match targets.",
    );
  }
  return Object.freeze({
    name,
    type,
    optional: value["optional"],
    secretClassification: secret,
    matchKind,
    source: parseSource(value["source"]),
  });
}

function parseSource(input: unknown): PolicyAttributeSource {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("A policy attribute source must be an object.");
  }
  const value = input as Readonly<Record<string, unknown>>;
  if (value["kind"] === "intrinsic" && hasExactKeys(value, ["kind", "field"])) {
    const field = value["field"];
    if (
      field === "capabilityPackId" ||
      field === "operationId" ||
      field === "sideEffectClass"
    ) {
      return Object.freeze({ kind: "intrinsic", field });
    }
  }
  if (
    value["kind"] === "object_field" &&
    hasExactKeys(value, ["kind", "section", "field"])
  ) {
    const section = value["section"];
    const field = value["field"];
    if (
      (section === "subject" ||
        section === "resource" ||
        section === "request" ||
        section === "environment") &&
      typeof field === "string" &&
      field.trim().length > 0
    ) {
      return Object.freeze({ kind: "object_field", section, field });
    }
  }
  throw new TypeError("A policy attribute source is invalid.");
}

function validateValue(
  value: unknown,
  attributeName: string,
  type: PolicyAttributeType,
): PolicyAttributeValue {
  if (type === "string" && typeof value === "string") return value;
  if (type === "boolean" && typeof value === "boolean") return value;
  if (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (
    type === "list<string>" &&
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  ) {
    return Object.freeze([...value]);
  }
  throw evaluationError(`The policy attribute ${attributeName} has the wrong type.`);
}

function isAttributeName(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length >= 2 &&
    parts.every((part) => {
      const characters = [...part];
      const first = characters[0];
      return (
        first !== undefined &&
        isAsciiIdentifierStart(first) &&
        characters.slice(1).every(isAsciiIdentifierContinue)
      );
    })
  );
}

function isAsciiIdentifierStart(value: string): boolean {
  return (
    (value >= "a" && value <= "z") ||
    (value >= "A" && value <= "Z") ||
    value === "_"
  );
}

function isAsciiIdentifierContinue(value: string): boolean {
  return isAsciiIdentifierStart(value) || (value >= "0" && value <= "9");
}

function isAttributeType(value: unknown): value is PolicyAttributeType {
  return (
    value === "string" ||
    value === "boolean" ||
    value === "integer" ||
    value === "list<string>"
  );
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value as number;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function evaluationError(message: string) {
  return createDomainError({
    code: "policy_denied",
    message,
    details: { reason: "policy_attribute_schema_mismatch" },
  });
}
