# ADR-0005: Existential Canonical-Path List Matching

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: BUILD_PLAN invariant 4 and Phase 3, DEEP_AUDIT Gate B, IMPLEMENTATION_GUIDE sections 5.4–5.5, THREAT_MODEL source-boundary guarantees

## Context

Repository capability results can contain more than one path. `list_files`
emits filenames, `search_text` emits a path on every match, and `inspect_diff`
emits every reviewed patch path. The original branch-internal `guard.repo` v1
catalog exposed only the optional scalar `repo.path`. A multi-path operation
used that scalar for its common input root while keeping individual paths in
other result fields. A context policy such as `repo.path matches "**/.env*"`
could therefore approve an allowed root even when the released result named a
denied `.env` path. Content classification is not a substitute: a repository
identifier is policy input even when the referenced content contains no secret
token.

The generic capability gateway binds release metadata to normalized action
metadata. For `search_text`, normalized `resource.paths` is the selected input
set, which can be larger than the set of paths that actually produced released
matches. Reusing that field would be conservative but not exact, and changing
the normalized action or generic gateway binding would expand the compatibility
surface unnecessarily.

Gate B has not shipped. `guard.repo` v1 existed only on this development branch:
there is no released policy snapshot, persisted run, public package, or daemon
schema that requires replay under v1.

## Decision

Add optional `repo.paths: list<string>` to `guard.repo` schema version 2. Its
catalog source is the context-release resource field `outputPaths` and its trace
classification is `repository_paths`. `outputPaths` is internal broker policy
metadata. It is not a capability input and is not added to the agent-visible
result.

`matches` accepts catalogued canonical-path attributes of type `string` or
`list<string>`:

- scalar matching remains unchanged;
- a present list returns `true` when any member matches the compiled glob;
- a present list returns `false` when no member matches, including an empty list;
- an absent optional list returns `unknown` through the existing missing-value rule;
- a wrong runtime type or invalid compiled comparison fails closed.

Existential semantics are security-oriented: a deny rule protecting a path
class must match when any released identifier belongs to that class. Universal
matching would let one safe sibling suppress denial of a sensitive path.

Each virtual repository operation owns its release projection:

- `list_files` derives identifiers from `raw.files`;
- `search_text` derives identifiers from every emitted match path and collapses
  repeated matches for the same path;
- `read_file` and `propose_patch` bind their one emitted scalar path;
- `inspect_diff` derives identifiers from its validated `raw.paths`.

Multi-path identifiers are required to be exact canonical repository paths,
deduplicated, ordered by UTF-8 bytes, count-bounded, and aggregate-byte-bounded.
The pack first caps the identifier count and aggregate path bytes to control
allocation, then constructs the exact policy projection and requires its
canonical JSON representation to be at most 64 KiB. That named limit mirrors
the context broker's projection parser contract; a boundary test admits exactly
64 KiB and rejects 64 KiB plus one byte so the two packages cannot drift
silently.
The pack compares raw and agent path sets, verifies search results are a subset
of normalized selections, verifies diff paths equal the normalized inspection,
and binds the resulting set into both the resource locator and policy
projection. Duplicate list/diff identifiers, redirected scalar paths,
noncanonical paths, incomplete diff sets, out-of-selection search paths, and
oversized projections fail closed. Repeated search matches are allowed but
produce one `outputPaths` member.

The empty repository root remains valid locator scope but is not itself a
canonical-path match target. When a multi-path release has an empty common root,
the projection omits scalar `path` and relies on the exact `outputPaths` set.

The repository context policy denies when either scalar or list vocabulary
matches:

```guard
when action.pack == "guard.context"
  and (repo.path matches "**/.env*" or repo.paths matches "**/.env*")
```

`guard.repo` v2 has canonical catalog content hash
`8fc8e73ec11aa524659588abcf360cf86f0ac34dbf3f2922fffeef590d8bb24e`.

## Migration

Replace the branch-internal v1 catalog and recompile all Gate B policy
snapshots, case corpora, tests, and deterministic evidence against v2. This is a
pre-Gate-B correction, not a released-snapshot migration. No claim is made that
persisted v1 snapshots can be loaded or replayed, because none were released.
After Gate B, future catalog changes require retaining or explicitly migrating
released versions under the compatibility rules in ADR-0004.

## Alternatives Considered

- Evaluate only the common scalar root: rejected because it permits denied
  identifiers to be smuggled through aggregate output.
- Project selected input paths for search: rejected because it is not set-equal
  to emitted identifiers and can deny outputs that contain no selected path.
- Use universal list matching: rejected because a safe sibling would suppress a
  sensitive-path deny rule.
- Add one release item per path: rejected for Gate B because it requires a
  larger gateway/runtime contract change and fragments one atomic capability
  view.
- Hard-code a `containsSecretPath` boolean in the pack: rejected because it
  duplicates policy semantics and cannot represent tenant-defined path rules.
- Rebind `guard.repo` v1: rejected because catalog ID/version pairs are immutable
  semantic identities.

## Consequences

Policies can now express one reviewable rule for scalar repository reads and
aggregate repository output. Existing scalar policies retain their behavior.
Policy snapshots and corpora using `guard.repo` receive new hashes because the
catalog manifest changes. Traces expose only the configured classification,
member count, and random run-scoped correlation token, never raw paths or
deterministic path hashes.

The evaluator and mutation suite must retain first-, middle-, last-, none-,
empty-, missing-, wrong-type-, and any-versus-every coverage. Repository tests
must retain exact descriptor, set-completeness, UTF-8 ordering, bound,
redirection, and real broker-policy denial coverage for list, search, and diff
outputs.
