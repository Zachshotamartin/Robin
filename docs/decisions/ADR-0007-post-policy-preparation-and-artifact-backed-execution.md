# ADR-0007: Post-Policy Preparation and Exact Artifact-Backed Execution

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: DA-003, DA-004, DA-008, DA-034,
  DA-051, DA-054, FR-RUN-007, FR-TOOL-003, FR-TOOL-004, FR-TOOL-007,
  FR-SBX-001, FR-SBX-002, FR-SBX-008, FR-SBX-009, FR-SBX-010,
  FR-APR-002, FR-DUR-012, ADR-0006

## Context

Milestone B deliberately splits capability handling at the policy boundary.
Normalization captures and freezes an agent proposal without opening a context
source. Policy and the allowed handler receive the same normalized-action
object. That ordering proves denial is byte-free, but a real Milestone C effect
needs facts that cannot safely or truthfully exist during normalization:

- the current authoritative checkpoint and tree;
- target existence, mode, and exact preimages;
- a content-addressed copy of the candidate patch;
- the tree Git predicts after applying those exact bytes;
- the selected process recipe, sandbox profile, image digest, and execution
  snapshot;
- reconciliation evidence after a crash or an ambiguous adapter result.

Adding those values to the normalized action would require source reads before
policy and would mutate or replace the exact object that policy evaluated.
Having the trusted adapter reconstruct a patch after policy would sever the
identity between reviewed bytes and executed bytes. Treating handler return as
fully committed before its events are atomically published would leave a third
ambiguity: an effect could succeed while its ledger append fails.

The current gateway has one-use evaluated receipts, but its handler returns a
completed result in one step. Milestone C needs a second one-use ownership
boundary for source-dependent preparation, reconciliation, pending effects,
ledger acknowledgement, and compensation. This boundary must remain generic:
Git, patches, worktrees, Docker, and process recipes belong to adapters and
capability packs, not to the runtime kernel.

ADR-0006 also established an exact, NUL-free, LF-only, newline-terminated
unified-diff subset. The Implementation Guide still said to normalize patch
line endings. Normalization would change the bytes whose hash, policy decision,
artifact, approval, Git input, and evidence must agree.

Milestone C remains single-process and local. Durable commands, transactional
artifact-reference rows, leases, crash recovery across process loss, and
precondition-bound human approval are Milestone E work. The C design must
provide compatible seams and honest reconciliation behavior without claiming
that later durability already exists.

## Decision

### Preserve one immutable normalized action

The normalized action remains the only policy input and is never enriched,
replaced, or reconstructed after evaluation. Its canonical hash binds the
proposal and the policy decision. Provider-independent structural facts such as
the complete canonical affected-path set, patch byte count, hunk count, and the
hash of exact agent-supplied bytes may be normalized before policy.

Normalization must not:

- resolve a repository or artifact-store path;
- test source existence or mode;
- open repository, Git, artifact, process, container, or credential state;
- compute a provider/source preimage or postimage;
- create a worktree or execution snapshot;
- select a mutable executable, image, or ambient environment.

Every source-dependent check occurs in the installed operation's
post-policy preparation method. Deny never calls preparation. A
`require_approval` decision may prepare bounded evidence so a later approval
can bind exact state, but it cannot execute in Milestone C.

### Add a gateway-owned preparation lifecycle

An installed consequential operation exposes the following logical lifecycle:

1. `prepare` receives the exact frozen normalized action and one live
   cancellation signal.
2. `reconcile` determines whether the prepared effect is absent, already
   succeeded, failed, or uncertain.
3. `execute` may run only after reconciliation proves the effect absent.
4. The gateway returns a pending result; it does not yet declare the effect
   acknowledged.
5. The host atomically publishes operation facts, artifact references, and the
   generic success fact.
6. Only a successful publication lets the gateway acknowledge and release the
   result.
7. Publication or post-effect validation failure invokes operation-specific
   compensation.
8. Compensation that cannot prove restoration returns `uncertain`; the host
   records an orphaned outcome and performs no automatic retry.

Pure Milestone A/B operations use an explicit inert lifecycle adapter:
preparation has no source facts, reconciliation returns `absent`, execution
delegates once to the existing handler, acknowledgement is immediate after the
existing event append, and compensation returns `not_required`. Their public
behavior and canonical histories do not change.

The gateway owns every public lifecycle handle. Operation-private receipt
objects never become events, policy attributes, CLI output, artifacts, or
agent-visible data. A handle is valid only for the gateway instance, run,
action, installed pack and operation versions, exact action object and hash,
exact policy decision and snapshot identity, preparation descriptor hash, and
current lifecycle state. Cross-gateway, cross-run, rebound, modified, forged,
reused, or out-of-order handles fail closed before adapter dispatch.

The gateway captures preparation descriptors, reconciliation results, pending
results, compensation evidence, event facts, and artifact references into
bounded detached immutable data. It rejects unknown fields, unsupported
versions, unregistered event types, malformed references, over-limit evidence,
and accessor/proxy inputs. The same `AbortSignal` lineage reaches preparation,
reconciliation, execution, and compensation; abort never converts an
uncertain effect into a known failure.

### Bind preparation to exact artifacts and live preconditions

A consequential preparation descriptor binds at least:

- schema version, run ID, action ID, normalized-action hash, and the same action
  object retained privately by the gateway;
- policy snapshot/version/content hash, decision effect, and safe decision
  identity;
- capability-pack ID/version and operation ID/version;
- exact candidate artifact ID, SHA-256, media type, byte length, and run
  reference;
- pre-action checkpoint commit/tree and affected-path-set hash;
- bounded preimage manifest and predicted post-tree;
- declared side-effect class and operation reconciliation strategy;
- when applicable, recipe/configuration hash, execution-snapshot manifest,
  sandbox profile, immutable image digest, network profile, executable identity,
  timeout, and output bounds.

Adapters may place additional private native handles in their opaque receipt,
but execution rederives all security-relevant facts from trusted live state and
the public descriptor. A private object alone is never authority.

The local artifact store records exact candidate bytes before patch execution.
Immediately before application the adapter:

1. resolves the run-owned artifact reference;
2. opens it through the no-follow bounded artifact reader;
3. streams and rehashes the full object;
4. requires the recorded byte count and SHA-256;
5. reparses the exact LF-only diff;
6. set-compares its structural paths and counts to the normalized action and
   preparation descriptor;
7. rechecks the checkpoint, index, worktree, preimages, and supported
   repository state;
8. feeds those same bytes to Git through standard input.

The adapter must not format, regenerate, apply a semantically equivalent diff,
or accept a second model response.

### Make patch preparation predictive and application verifiable

Patch preparation uses a temporary owned index based on the current accepted
checkpoint. With helpers, hooks, filters, text conversion, and signing disabled,
the trusted Git adapter runs `git apply --cached --check --whitespace=error`,
applies the candidate to only that temporary index, and runs `git write-tree`.
The resulting predicted tree, exact changed paths, modes, preimages, and
postimages enter the preparation descriptor.

Execution reasserts the pre-action checkpoint and applies the exact artifact to
the authoritative disposable worktree with `git apply --index
--whitespace=error`. It verifies the cached diff, changed path/mode set,
preimages, postimages, and final tree against preparation. It then creates an
internal detached checkpoint with `git commit-tree`, a controlled identity,
an explicit parent, no signing, and no hooks.

The checkpoint is pending until its mixed-family ledger batch is accepted. If
that publication fails, compensation restores only the recorded pre-action
checkpoint and removes only paths proven to have been created by this action.
It never resets to the run's base commit and never operates on the original
checkout. Therefore two accepted patches followed by a failed third patch
preserve the second checkpoint exactly.

Reconciliation has three security-relevant outcomes:

- current state equals the pre-action tree and manifest: `absent`;
- current state equals the predicted post-tree and a valid checkpoint with the
  required parent and manifest: `succeeded`;
- neither statement is provable: `uncertain`.

An uncertain result cannot execute, compensate speculatively, or retry
automatically. Milestone C records it as orphaned in the current process.
Milestone E will persist commands and use the same evidence after restart.

### Keep execution state separate from authoritative state

Untrusted tests and builds never receive the authoritative worktree, its
`.git` indirection, or the shared Git common directory. A process operation
prepares a fresh owner-only execution snapshot by materializing the latest
checkpoint from raw Git blobs without checkout transformations or hard links.
The descriptor binds its manifest, recipe, immutable image digest, network
profile, and limits.

Source writes inside that snapshot are discarded. Only declared bounded output
artifacts may return through classification and the artifact gateway. Before
acknowledgement, the adapter proves the authoritative checkpoint is unchanged.
Timeout or cancellation stops the entire owned container/process tree, waits
for termination, and disposes or quarantines the snapshot.

### Register adapter facts without coupling the kernel

Capability packs may declare a strict namespaced informational event family.
The run's event-family registry parses each extension event and envelope before
append or replay. Registration rejects generic-event shadowing, duplicate
family/type identities, malformed versions, and unknown payload fields.

The generic reducer treats only registry-confirmed extension facts as
informational: it validates the same run, gap-free stream version, event ID,
causation, and nondecreasing record time, advances the generic cursor, and
plans no effect. Unknown namespaced events still fail closed. Adapter-specific
checkpoint continuity and snapshot invariants live in the owning projection,
not in generic runtime branching.

A successful consequential publication is one atomic event-store append
containing, in order:

1. strict operation-produced namespaced facts;
2. generic artifact-reference facts derived by the trusted host; and
3. the generic action-success fact.

Replay reads and reduces those facts only. It never opens an artifact, Git
repository, worktree, process, or container and never invokes reconciliation
or compensation.

### Scope the local artifact contract honestly

Milestone C's local content-addressed store uses immutable SHA-256 objects and
separate owner-only run-reference records. Writes are bounded, streamed through
an owner-only same-filesystem temporary file, fsynced, atomically renamed, and
reopened/verified on reads. Deduplicated objects may have references from more
than one run; authorization is against the exact run reference, never the
object hash alone.

Reservations, run quotas, reference counts, and garbage-collection decisions
are process-local in C. A failed reference publication may leave an unreferenced
immutable object for a later owned-object sweep. C does not claim
transactionality between filesystem references and the in-memory event store.
Milestone E must add durable quota reservations, transactional reference rows,
tombstones, retention, and reference-safe garbage collection.

### Preserve exact LF-only proposal bytes

Unified-diff proposal input is NUL-free, well-formed Unicode, LF-only, and
newline-terminated. Any carriage return fails structural normalization. Guarded
Agent does not normalize patch line endings. The proposal hash, stored object,
preparation parser input, Git standard input, approval evidence, and exported
audit hash all cover the same original UTF-8 byte sequence.

Policy source files remain a separate contract: the policy compiler may
canonicalize accepted source before calculating compiled policy identity, as
documented in the policy-language specification. This ADR changes only patch
artifact semantics.

### Defer durable approval without bypassing policy

The Gate C deterministic scenario uses a reviewed fixture policy that allows
its exact `local_reversible` patch action and network-disabled test recipe.
It does not synthesize a human approval or treat a protocol permission prompt
as approval. Production policies may continue returning
`require_approval`; such actions prepare bounded review evidence and stop
before execution until Milestone E supplies the durable approval service,
expiry, consumption, and live precondition revalidation.

## Alternatives Considered

- Enrich the normalized action after policy: rejected because policy and
  execution would no longer use the same immutable object and denial would
  require source access.
- Put checkpoint and preimage data into pre-policy normalization: rejected
  because existence and provider-byte facts would cross the source boundary
  before authorization.
- Let each adapter own an untyped continuation closure: rejected because a
  closure is forgeable authority with no bounded, replayable descriptor and no
  common lifecycle ordering.
- Execute directly from the agent string after checking only its hash:
  rejected because the artifact reference, full bytes, structural paths, and
  live preconditions must all be reverified at the last responsible moment.
- Treat handler success as final before ledger publication: rejected because an
  append fault would create an unrecorded accepted mutation.
- Roll back to the base commit: rejected because it destroys earlier accepted
  checkpoints and violates DA-003.
- Mount the authoritative worktree into the process sandbox: rejected because
  untrusted code could mutate accepted source outside the patch gateway.
- Use Git checkout or archive to populate workspaces: rejected because
  repository-controlled filters and text conversions could execute or change
  bytes.
- Normalize CRLF patch input to LF: rejected because the executed bytes would
  differ from the proposal and its original hash.
- Store only an object hash with no run reference: rejected because
  content-addressed deduplication is not authorization and cross-run access
  would become ambiguous.
- Claim restart-safe compensation in Milestone C: rejected because the event
  store and reference ledger are still in memory; durable recovery belongs to
  Milestone E.

## Consequences

Milestone C gains one auditable mutation path: policy evaluates the exact
proposal, preparation binds exact live state and immutable artifact bytes, the
trusted adapter applies and verifies those bytes, and acknowledgement occurs
only after atomic event publication. Later-write rollback preserves earlier
checkpoints, and ambiguous restoration becomes visible orphaning rather than an
unsafe retry.

The gateway and runtime-host APIs become multi-phase. Every consequential
operation must define preparation, reconciliation, execution, compensation,
cancellation, artifact, and event-fact bounds. Tests must cover forged and
reused receipts, every lifecycle ordering error, cancellation at each phase,
append failure after effect, compensation uncertainty, mixed-family replay,
artifact tampering, exact-byte application, and two-success/one-failure
checkpoint preservation.

Adapters must retain private in-process state between preparation and
acknowledgement, and local orphan/reference cleanup is less convenient than a
single handler call. That complexity is intentional and becomes the seam used
by the durable Milestone E command/lease implementation.

Gate C may claim real host Git/worktree isolation and host-side snapshot
evidence after its mandatory filesystem suites pass. Container isolation
claims remain explicitly environment-gated when the required Docker daemon,
pinned image, or isolated hostile-test runner is unavailable. No part of this
ADR advances provider credentials, arbitrary agents/models, durable approvals,
PostgreSQL recovery, a daemon, or editor integration into Milestone C.
