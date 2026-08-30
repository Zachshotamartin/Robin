import { createPolicyAttributeCatalog } from "@guard/policy-engine";

/** Generic broker-owned policy vocabulary; source vocabularies compose beside it. */
export const CONTEXT_POLICY_ATTRIBUTE_CATALOG = createPolicyAttributeCatalog({
  catalogId: "guard.context",
  schemaVersion: 1,
  attributes: [
    definition("context.resource_kind", "string", true, "resource", "kind"),
    definition("context.media_type", "string", true, "resource", "mediaType"),
    definition("context.reason", "string", true, "request", "reason"),
    definition(
      "context.turn_id",
      "string",
      true,
      "request",
      "turnId",
      "runtime_identifier",
    ),
    definition(
      "context.resource_bytes",
      "integer",
      true,
      "request",
      "resourceBytes",
    ),
    definition(
      "context.selected_bytes",
      "integer",
      true,
      "request",
      "selectedBytes",
    ),
    definition(
      "context.source_bytes",
      "integer",
      true,
      "request",
      "sourceBytes",
    ),
    definition("context.truncated", "boolean", true, "request", "truncated"),
    definition(
      "context.secret_categories",
      "list<string>",
      true,
      "request",
      "secretCategories",
    ),
    definition(
      "context.prompt_injection_tags",
      "list<string>",
      true,
      "request",
      "promptInjectionTags",
    ),
  ],
});

/** Versioned vocabulary for the bundled non-filesystem source fixture. */
export const MEMORY_POLICY_ATTRIBUTE_CATALOG = createPolicyAttributeCatalog({
  catalogId: "guard.memory",
  schemaVersion: 1,
  attributes: [
    definition(
      "memory.record_id",
      "string",
      true,
      "resource",
      "recordId",
      "resource_identifier",
    ),
  ],
});

function definition(
  name: string,
  type: "string" | "boolean" | "integer" | "list<string>",
  optional: boolean,
  section: "resource" | "request",
  field: string,
  secretClassification: string | null = null,
) {
  return Object.freeze({
    name,
    type,
    optional,
    secretClassification,
    matchKind: "none" as const,
    source: Object.freeze({ kind: "object_field" as const, section, field }),
  });
}
