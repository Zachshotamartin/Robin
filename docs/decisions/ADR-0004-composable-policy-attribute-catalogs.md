# ADR-0004: Composable Policy Attribute Catalogs

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: GENERAL_RUNTIME_ARCHITECTURE section 9, IMPLEMENTATION_GUIDE section 5.4, FR-POL-002, FR-POL-003

## Context

The original Implementation Guide section 5.4 listed one flat attribute catalog containing coding-specific names such as `resource.path`, `resource.branch`, `request.executable`, and `environment.repo_trust`. The later General Runtime Architecture section 9 made the kernel domain-neutral and assigned attributes such as `repo.path`, `http.origin`, and `database.table` to their capability or context-source packs. Both schemas cannot be authoritative: accepting both would create aliases whose projection, optionality, secret handling, and version evolution could diverge, while accepting only the flat schema would make every non-coding profile depend on coding vocabulary.

Milestone B is the first policy release. No persisted policy snapshot, compatibility corpus, public package, or released daemon schema depends on the flat names. This is therefore a source-plan contradiction to resolve before compatibility obligations exist, rather than a migration that needs aliases.

## Decision

Use a closed domain-neutral `guard.base` catalog for subject, action, generic resource, request, and environment facts. Capability packs and context-source adapters contribute separate versioned catalogs under owned namespaces such as `repo.*` and `process.*`. Do not implement aliases for the superseded flat coding-specific names.

Each attribute definition binds its dotted name, scalar or list type, optionality, safe trace classification, match kind, and exact normalized-action projection. Each catalog binds a stable catalog ID and positive schema version to a canonical content hash. A catalog ID/version pair cannot later be rebound to different content. Policy snapshots contain an ordered manifest of catalog ID, schema version, and content hash; their content hash also binds the Guard language version, canonical source IDs and text, and configured default effect.

The compiler rejects an unknown attribute, duplicate attribute across composed catalogs, incompatible operator or value type, and `matches` on a non-canonical-path attribute. Runtime evaluation derives attributes only from the exact immutable normalized action validated at the gateway. The catalog used to compile a snapshot must be the same recognized catalog set used to evaluate it. Sensitive fields such as repository paths, branches, and process arguments are represented in traces only by classification, count, and a random run-scoped correlation token—not by raw values or deterministic hashes.

## Alternatives Considered

- Retain the original flat catalog: rejected because it leaks coding concepts into every profile, conflicts with the generic architecture, and cannot express independent pack evolution cleanly.
- Support both flat and namespaced aliases: rejected because there is no compatibility consumer, aliases create two policy spellings for one fact, and future projection or classification changes could make their meaning diverge.
- Let policies read arbitrary normalized JSON paths: rejected because unknown fields would become implicitly trusted, type checking and bounded evaluation would weaken, and sensitive trace handling could not be declared before evaluation.
- Let each policy file declare its own attributes: rejected because untrusted policy text would define its authorization inputs and because a file could reinterpret a field without changing the owning pack version.
- Put pack fields in an unversioned global registry: rejected because snapshot replay could silently change when a pack is upgraded.

## Consequences

The generic in-memory profile can compile against `guard.base` alone, while the coding profile composes only the catalogs for installed repository, process, and later coding packs. A policy referring to an unavailable pack attribute fails at load time instead of evaluating it as missing. Catalog semantic changes require a new schema version and a newly reviewed policy snapshot; active runs remain pinned to their original snapshot.

The implementation must maintain locale-independent ordering, canonical catalog hashing, collision tests, old-version rejection tests, and pack-owned projection tests. Adding a new pack requires catalog review alongside its action normalization and secret-trace classification. If a released policy later needs a renamed attribute, that is an explicit versioned migration with a compatibility corpus; this ADR does not pre-authorize aliases.
