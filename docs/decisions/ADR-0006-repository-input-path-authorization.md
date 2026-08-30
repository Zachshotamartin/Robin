# ADR-0006: Repository Input-Path Authorization and Byte-Free Normalization

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-CTX-002, FR-CTX-003, FR-TOOL-003,
  BUILD_PLAN Phase 3, THREAT_MODEL 7.1, ADR-0004, ADR-0005

## Context

ADR-0005 made aggregate repository *output* policy-complete by binding the
exact emitted path set to `repo.paths`, sourced from the internal release field
`resource.outputPaths`. That vocabulary cannot authorize an operation's input:
it exists only after successful handler execution. `search_text` can select
many files while emitting matches from only some of them, and `inspect_diff`
can contain many file sections. Evaluating only their empty common scalar root
would allow a mixed safe and `.env*` selection to open the secret file before
the broker later denied the result.

The virtual repository pack also used provider reads during semantic
normalization to check existence, ranges, source hashes, or diff preimages.
That inverted FR-CTX-002/003: the gateway had not yet evaluated path policy.
Content-derived snapshot preconditions in the normalized action additionally
persisted a dictionary-verifiable signal even when authorization denied the
action.

Gate B has not shipped. `guard.repo` v1 and v2 were branch-internal catalog
identities with no released snapshot or compatibility obligation.

## Decision

### Separate input and output path vocabularies

`guard.repo` schema version 3 retains:

- optional scalar `repo.path`, sourced from normalized `resource.path`;
- optional output list `repo.paths`, sourced from broker-release
  `resource.outputPaths`; and
- optional `repo.branch`.

It adds optional `repo.input_paths: list<string>`, sourced from normalized
`resource.paths`, with canonical-path matching and secret trace classification
`repository_input_paths`. `resource.paths` is the exact bounded, unique,
canonical input set established before policy. `resource.outputPaths` remains
the exact bounded, unique, UTF-8-ordered emitted set established after handler
execution. Neither projection field is a new agent-visible contract.

The production repository action policy denies a secret scalar or any secret
member of the input set:

```guard
when action.pack == "coding.virtual-repository"
  and (repo.path matches "**/.env*" or repo.input_paths matches "**/.env*")
```

The context-release policy remains output-oriented and denies `repo.path` or
`repo.paths`. Rebinding `repo.paths` to inputs is forbidden because it would
make release metadata inexact; reusing `repo.input_paths` for outputs is
forbidden because selected-but-unemitted files are not released identifiers.

Multi-path action locators retain `resource.path: ""` as their gateway-bound
common root. For an optional scalar `canonical_path` catalog attribute only,
exact empty string is extracted as absent: `exists(repo.path)` is false and a
`matches` comparison is unknown. Empty string remains invalid as a file path,
and glob matching is not broadened to accept it. Wrong non-string values still
fail closed. This narrow extraction rule lets `repo.input_paths` carry exact
authorization while preserving gateway locator binding.

`guard.repo` v3 has canonical catalog content hash
`885645ba63117122b4d1d62a95e366ebfa5cb43db9a6f8bd67b7f70eeba68096`.
The compiled production `policies/default.guard` snapshot has content hash
`4bd3d9c74ed673859c62551fe929f57d417939826f8aaf6719fb3764dfd5dfa3`.
The repository context policy compiled against v3 has content hash
`df76cdaae6c1f43127c740ea183fc5267c14e3a99d8d3a879d24c0f53ad5869e`.

### Make normalization byte-free

Virtual repository normalization may validate only untrusted request structure
and provider-independent semantics: canonical paths, input deduplication and
ordering, scalar/range/byte limits, well-formed replacement bytes and their
agent-supplied hash, literal-search bounds, and a strict structural unified-diff
AST. It must not call the repository provider to test existence, read a line,
compute a source hash, or validate a preimage.

The structural diff phase parses every exact file header, hunk header, and hunk
body, rejects ambiguous or unsupported syntax, and exposes every file-section
path in `resource.paths`; a trailing or otherwise hidden second section cannot
escape policy. After allow, execution revalidates that frozen structural value,
opens repository bytes, and performs existence, selected-file, range, and
preimage checks. A missing file, out-of-range read, or preimage mismatch fails
without constructing release metadata.

All five virtual operations use `preconditions: []` during Gate B normalization.
No provider-content snapshot or file hash enters a denied normalized action.
Agent-supplied query, replacement, and patch hashes may remain because they bind
the proposal rather than disclose provider content. Post-execution source and
preimage hashes remain valid successful-output evidence.

Policy evaluation and execution receive the same deeply frozen normalized
action object. Tests use a counting provider to prove zero reads through
normalize and deny for read, search, propose, and inspect, and provider reads
only after allow.

### Keep persisted non-agent views metadata-only

The repository pack's audit and human views contain counts, booleans, byte
lengths, and allowed evidence hashes, but no provider filenames, roots, paths,
search snippets, source text, replacement text, or patch bytes. Repository
identifiers and contents reach an agent only through the broker-controlled
agent view and its exact bound release descriptor. Runtime output disposition
also suppresses pack audit/human payloads when broker release is denied or
fails, so post-execution hashes are not retained for an unreleased result.

## Migration

Replace the branch-internal v2 catalog and context corpus with v3, recompile
both production policy files, and regenerate deterministic Gate B evidence.
No v1/v2 snapshot migration or replay support is claimed because neither
identity shipped. After Gate B, changing any source field or attribute semantic
requires a new catalog version and the compatibility process in ADR-0004.

## Alternatives Considered

- Authorize only the common scalar root: rejected because empty root says
  nothing about a mixed multi-path selection.
- Reuse `repo.paths` for input and output: rejected because one attribute would
  have two lifecycle-dependent meanings and output release would cease to be
  exact.
- Read provider metadata but defer file contents: rejected because existence,
  ranges, and source hashes still cross the source boundary before path policy.
- Put a secret-path boolean in normalized input: rejected because it duplicates
  tenant policy and cannot express arbitrary canonical path rules.
- Preserve content snapshot preconditions for pure reads: rejected because they
  require a pre-policy read and leak content-derived information on denial.

## Consequences

Repository authorization is complete over every exact input path before the
provider is opened, while context release remains complete over every exact
emitted path. Missing files and stale preimages are now post-policy execution
errors, which is intentionally less revealing to denied callers. Normalized
action goldens, policy manifests, corpus filenames/hashes, and repository view
goldens change before Gate B. Tests must retain mixed safe/secret zero-read
denials, hidden-section path completeness, same-object identity, successful
post-allow reads, and raw-identifier/content canaries across audit and human
views.
