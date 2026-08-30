# Robin: Glossary

Canonical definitions for the controlled vocabulary used across the planning documents. When another document appears to conflict with a definition here, fix the conflict rather than redefining the term locally.

## Runtime and Composition

- **Task profile** — the immutable composition root pinned to a run: objective and outcome schemas, one agent-driver profile, role-based model bindings, context sources, capability packs, policy, budgets, evidence mode, and evaluation profile.
- **Objective envelope** — the versioned structured payload describing what the run should accomplish. Immutable once the run starts; follow-up intent is appended as a separate event.
- **Agent driver** — the planning source hosted by the runtime. It proposes content, actions, and outcomes but executes nothing. Kinds: scripted, direct-model, protocol (ACP), MCP-mediated, hosted, contained CLI, and a future coordinator.
- **Direct-model driver** — the driver that owns a model loop through a `ModelProviderAdapter`. It has exactly one action-capable planner binding.
- **Scripted driver** — a deterministic driver used for tests and evals; it validates every runtime request against its script and fails the eval on divergence.
- **Model provider adapter** — the translation layer for one model API dialect. It compiles unsigned requests and normalizes streams; it never owns authorization, credentials, or execution.
- **Planner binding / auxiliary binding** — role-based model bindings in a profile. Only the single planner may propose actions; embedding, reranking, classifier, and grader bindings are non-authorizing.
- **Reducer** — the pure `evolve(state, event)` function that derives run state from history. Replay calls only the reducer, never an effect adapter.
- **Command** — a durable instruction planned from committed events and executed by a worker under a lease. Results return as new events.

## Context and Capabilities

- **Context broker** — the read side of the security boundary. Every resource Robin delivers to an agent or model passes canonicalization, policy, classification, redaction, budgets, and provenance recording here first. Lower-tier external agents may have separately disclosed context outside Robin's visibility.
- **Context-source adapter** — installed trusted code that resolves one scheme of `ResourceRef` (repository, document corpus, artifact) into bounded content for the broker.
- **Capability pack** — installed versioned trusted code defining guarded operations: schemas, normalizers, approval displays, executors, reconcilers, and output classifiers. Coding and local research are the reference packs.
- **Normalized action** — the single immutable canonical representation of a proposed operation. Policy evaluates it, approval binds its hash, and the handler executes that exact object.
- **Observation** — the result of an executed action, split into four views: raw trusted (never released), audit, human, and agent (policy-released).
- **Outcome** — the profile-typed terminal result. `RunCompleted` may follow only a committed `OutcomeValidated` whose references reconcile against run evidence.

## Policy and Approval

- **Policy snapshot** — the compiled, hashed, immutable form of the policy files pinned to a run. File edits never change an active run.
- **Three-valued logic** — expression evaluation over true, false, and unknown; missing optional attributes yield unknown, and only a fully true expression matches.
- **Deny-overrides** — the combining rule: any matching deny wins, then require-approval, then allow. Priority selects explanation order only, never the winning effect.
- **Decision trace** — the evaluator-produced record of matched and failed clauses used for explanation; it is generated from evaluated AST nodes, never authored by a model.
- **Approval preconditions** — the canonical hashed document binding an approval to the normalized action, policy version, checkpoint, file hashes, executable identity, image digest, and network profile. Any change invalidates the approval.

## Workspace and Isolation

- **Authoritative run worktree** — the detached Git worktree owned by trusted host-side adapters. The only accepted source mutation is a validated, approved patch artifact.
- **Internal checkpoint** — the no-hook commit created after each accepted patch. Rollback restores only the pre-action checkpoint, preserving earlier accepted work.
- **Disposable execution snapshot** — the per-process copy of the latest checkpoint mounted into the sandbox. Its source mutations are discarded; only declared artifacts return through the gateway.
- **Sandbox profile** — the pinned container configuration: image digest, non-root user, read-only root, resource limits, and network disabled by default.

## Durability and Evidence

- **Event envelope** — the stable metadata wrapper on every event: stream identity, version, type, schema version, actor, causation, correlation, and payload, hashed into a tamper-evident chain.
- **Lease / lease generation** — database-time-bounded ownership of a command by one worker; the generation token prevents a stale worker from completing work after losing the lease.
- **Reconciliation** — the operation-specific proof of whether a side effect already occurred before retrying it. Unprovable state becomes `orphaned`, which stops automatic retry.
- **Evidence mode** — the per-run retention choice: `durable_encrypted` stores the exact ordered agent-visible transcript and required opaque provider items under local authenticated encryption; after the durability milestone it supports restart resume only when the selected driver has a lossless resume contract. `ephemeral_metadata` stores hashes and safe metadata only and is non-resumable after process loss.
- **Artifact object / artifact reference** — immutable content-addressed bytes versus the per-run pointer to them. Deduplicated objects survive as long as any live reference exists.
- **Attempt-result-uncertain** — the recorded state of an external driver or provider request that may have been transmitted without a durable terminal result. Retries are new, budgeted attempts, never silent replays.

## Compatibility and Credentials

- **Compatibility tier** — the evidence-computed guarantee level of an integration: A (direct model, fully mediated), B (protocol-controlled external agent), C (sandboxed black-box CLI, containment only), D (observe-only). Adapters report primitive capabilities; the trusted validator computes the tier.
- **Conformance suite / dialect** — the versioned test corpus an adapter or endpoint must pass before its profile may claim a tier; a compatibility label is never accepted from self-description.
- **Credential reference** — the opaque identifier stored in configuration and PostgreSQL; secret bytes live only in the OS credential store. Robin-owned provider credentials are injected by the trusted transport against an exact origin. Reviewed agent-owned delivery modes disclose that the pinned agent and its children can read the selected credential and receive a weaker confinement claim.
- **Canary** — a seeded high-entropy synthetic secret used to prove leak absence across serialized requests, events, logs, artifacts, child environments, and protocol surfaces.
- **Guarded MCP bridge** — the run-scoped stdio MCP server exposing only installed operations; its annotations are untrusted hints and never authorization.
