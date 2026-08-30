import { createPolicyAttributeCatalog } from "@guard/policy-engine";

/**
 * Versioned coding-source vocabulary. Repository identifiers are classified
 * in evaluator traces because paths and branch names are themselves content.
 */
export const REPOSITORY_POLICY_ATTRIBUTE_CATALOG =
  createPolicyAttributeCatalog({
    catalogId: "guard.repo",
    schemaVersion: 3,
    attributes: [
      {
        name: "repo.path",
        type: "string",
        optional: true,
        secretClassification: "repository_path",
        matchKind: "canonical_path",
        source: {
          kind: "object_field",
          section: "resource",
          field: "path",
        },
      },
      {
        name: "repo.paths",
        type: "list<string>",
        optional: true,
        secretClassification: "repository_paths",
        matchKind: "canonical_path",
        source: {
          kind: "object_field",
          section: "resource",
          field: "outputPaths",
        },
      },
      {
        name: "repo.input_paths",
        type: "list<string>",
        optional: true,
        secretClassification: "repository_input_paths",
        matchKind: "canonical_path",
        source: {
          kind: "object_field",
          section: "resource",
          field: "paths",
        },
      },
      {
        name: "repo.branch",
        type: "string",
        optional: true,
        secretClassification: "repository_branch",
        matchKind: "none",
        source: {
          kind: "object_field",
          section: "resource",
          field: "branch",
        },
      },
    ],
  });
