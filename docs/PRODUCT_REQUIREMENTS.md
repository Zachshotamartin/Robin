# Guarded Agent: Product Requirements and User Flows

## 1. Product Goal

Guarded Agent lets a user delegate bounded work to an interchangeable model or external agent while retaining deterministic control over context, capabilities, effects, network access, approvals, credentials, budgets, outcomes, and audit history. Coding is the flagship profile; local-corpus research is the second reference profile that proves the runtime kernel is general.

The product succeeds when a user can answer five questions for every run:

1. What did the agent and any underlying model see?
2. What did the agent propose?
3. Why was each request allowed, denied, or approval-gated?
4. What actually executed and where?
5. Can the result and recovery history be independently verified?

## 2. Primary Users

### 2.1 Individual developer

Wants a useful agent without granting unrestricted data, shell, repository, network, or account access. For coding, values a fast CLI, understandable approvals, reviewable patches, and confidence that the original checkout remains safe.

### 2.2 Security or platform engineer

Defines organizational policies, investigates decisions, simulates policy changes, examines audit evidence, and verifies that controls are enforced outside model prompts.

### 2.3 AI engineer or agent-platform integrator

Adds or compares provider, local-model, protocol-agent, or prompt behavior using conformance tests and deterministic/stochastic evals while holding policy, capabilities, context, and fixtures constant.

### 2.4 Code reviewer

Did not start the run but needs the objective, policy trace, exact patch, test evidence, approvals, costs, and limitations without reading raw internal events.

### 2.5 Knowledge worker or research reviewer

Runs a bounded task over an approved local corpus and needs a source manifest, stable citations, uncertainty, policy decisions, and evidence that unrelated documents or credentials were not released.

## 3. Product Principles

- Safe useful work is preferred to blanket refusal.
- The agent and any model it invokes are untrusted proposers, not principals with ambient authority.
- Read access is a security decision because disclosed context cannot be recovered.
- Human approval is specific, expiring, and state-bound.
- The original checkout is protected by construction.
- Recovery behavior is part of correctness.
- Deterministic evidence supports every deterministic claim.
- A UI explains enforcement but never replaces it.
- Defaults minimize access, network, retention, and spend.

## 4. Scope

### 4.1 Required core portfolio capabilities

- Compose a run from an immutable task profile: objective schema, agent driver, optional model, context sources, capability packs, policy, budgets, evidence mode, outcome schema, and eval profile
- Run exactly one active agent driver per run while allowing scripted, direct-model, local-model, and later protocol-agent implementations without changing the kernel
- Use a deterministic scripted driver and synthetic provider, one hosted real provider, and one local no-credential provider path
- Run the coding profile against one local Git repository
- List, search, and read allowed repository content; propose bounded text patches; and run configured tests/builds in a constrained container
- Run a local-corpus research profile that searches and reads approved documents and returns an answer with verified citations, without Git or process capabilities
- Evaluate every context release, action, observation release, and terminal outcome through versioned profile and policy contracts
- Pause for exact-action approval
- Deny forbidden context, actions, or output with deterministic explanation
- Persist an append-only run history in PostgreSQL
- Recover from worker and daemon interruption
- Export profile-specific outcome, audit, compatibility, and evaluation artifacts
- Operate fully through a CLI
- Later expose the same capabilities through a VS Code extension

### 4.2 Required broad compatibility capabilities

- Bring a credential for any installed hosted-provider adapter without placing secret bytes in configuration, logs, model context, sandboxes, or clients
- Select OpenAI, Anthropic, Gemini, conformant OpenAI-compatible, or local provider profiles per run
- Negotiate tool-calling, schema-output, text-only planning, and supported multimodal model capabilities without inventing missing safety features
- Run reviewed ACP agents, a run-scoped guarded MCP bridge, and a containment-only CLI agent under explicit guarantee tiers
- Add a provider or agent adapter through a versioned port and conformance suite without modifying policy, approval, runtime, event, context, capability, or eval kernels

### 4.3 Explicit non-goals for v1

- Shipping every conceivable domain capability pack
- Concurrent cooperating agents or implicit agent delegation
- Browser or desktop control
- Cloud-resource mutation
- Autonomous push, merge, deploy, or release
- Arbitrary network access
- Arbitrary or repository-supplied MCP servers
- Windows support
- Implementing model inference, training, or fine-tuning; reviewed local inference servers remain valid provider endpoints
- Perfect containment claim
- Enterprise identity, billing, or multi-tenancy
- Code-OSS fork

## 5. Functional Requirements

### 5.1 Profiles, agents, models, and credentials

- `FR-PRF-001`: Every run pins one installed task-profile version containing objective/outcome schemas, one active agent-driver profile, role-based model bindings, context sources, capability packs, policy, budgets, evidence mode, and evaluation profile. A direct-model driver has exactly one action-capable planner binding; auxiliary embedding/reranking/classifier/grader bindings cannot propose actions; scripted/external drivers may have no Guarded-owned model binding.
- `FR-PRF-002`: Repository or user configuration can select installed code and provide schema-validated values but cannot load executable adapters from the task input or analyzed source.
- `FR-PRF-003`: The generic reducer and event store contain no Git, patch, test, document-citation, provider-brand, or agent-protocol branching.
- `FR-DRV-001`: Every agent driver emits the normalized driver event union for content, action proposals, usage, outcome proposals, completion, and failure.
- `FR-DRV-002`: V1 permits one active agent driver per run; a driver cannot secretly spawn another agent with credentials or capabilities outside its profile.
- `FR-MOD-001`: A model profile pins adapter, endpoint origin, model identifier, capability manifest, decoding options, credential reference, pricing metadata, and retention controls.
- `FR-MOD-002`: Startup rejects a profile whose required modality, structured-action, continuation, storage, or action-serialization properties are not supported by its adapter manifest.
- `FR-MOD-003`: Tool-calling models may propose guarded actions; schema-output models may use a versioned action envelope; unconstrained text-only models are answer/planning-only.
- `FR-MOD-004`: Supported image, audio, document, and structured blocks retain media type, byte bounds, provenance, redaction classification, and provider-specific transformation evidence.
- `FR-CRED-001`: Credential secret bytes reside in an OS credential store; configuration and PostgreSQL retain only an opaque credential reference and safe metadata.
- `FR-CRED-002`: For a transport-owned credential, the trusted transport binds authentication to a reviewed strategy and exact allowed origin, rejects redirects, and injects no secret into domain code, agent/model context, child processes, artifacts, events, or clients.
- `FR-CRED-003`: Users can validate local metadata, rotate, rebind, and remove a credential; removal blocks new calls while preserving secret-free historical evidence.
- `FR-CRED-004`: If an external agent must own its model connection, its profile declares a reviewed broker-channel or constructed-environment delivery mode; the credential reaches only the pinned agent sandbox/origin, never argv or source files, and the UI/audit explicitly states that the agent and its children could read it and downgrades credential-confinement claims.
- `FR-COMP-001`: Every adapter reports primitive capabilities; the trusted profile validator computes compatibility Tier A, B, C, or D from those capabilities, enabled operations, OS/sandbox controls, credential ownership, and pinned conformance evidence, then exports the achieved tier and limitations with the run audit.
- `FR-COMP-002`: Provider and external-agent adapters pass versioned conformance suites before an installed profile may claim enforcement guarantees.

### 5.2 Run creation

- `FR-RUN-001`: The user can create a run with objective payload, task profile, agent profile override when allowed, model/provider profile when required, credential reference, and budget overrides bounded by policy.
- `FR-RUN-002`: The runtime records the fully resolved task profile, driver fingerprint, model/provider fingerprint when present, context-source manifests, capability manifests, policy snapshot, sandbox profile, and evidence mode before accepting work.
- `FR-RUN-003`: The coding profile additionally records repository root, base commit, dirty state, and Git capability evidence; dirty repositories are refused by default with safe manual remediation.
- `FR-RUN-004`: A run receives an opaque ID and an append-only event stream.
- `FR-RUN-005`: The original objective is immutable; follow-up intent is represented as a new event.
- `FR-RUN-006`: A run pins `durable_encrypted` or `ephemeral_metadata` evidence mode and displays the restart-resume consequence before work starts.
- `FR-RUN-007`: Lifecycle state includes cancellation requested, recovery, pause, ambiguous external driver/provider attempts, and orphaned-effect outcomes rather than collapsing them into generic failure.

### 5.3 Context access

- `FR-CTX-001`: An agent or underlying model receives source content only through the context broker and installed context-source adapters.
- `FR-CTX-002`: Every resource is canonicalized and evaluated before reading.
- `FR-CTX-003`: Secret path policy runs before content is opened.
- `FR-CTX-004`: Content detection may deny or redact before release.
- `FR-CTX-005`: Every released item records path, range, hash, policy version, and reason.
- `FR-CTX-006`: Denied content records metadata without the denied bytes.
- `FR-CTX-007`: Turn and run context budgets are enforced.
- `FR-CTX-008`: Capability output passes through the same release boundary before agent or model use.
- `FR-CTX-009`: The coding source and local-corpus research source use the same generic provenance, classification, budget, and release-policy contracts.

### 5.4 Policy

- `FR-POL-001`: Policies support allow, deny, and require-approval effects.
- `FR-POL-002`: Policies compile into immutable versioned snapshots.
- `FR-POL-003`: Unknown attributes or invalid types fail policy loading.
- `FR-POL-004`: A decision contains effect, matched rule, default behavior, and clause trace.
- `FR-POL-005`: Deny precedence is deterministic.
- `FR-POL-006`: Active runs remain pinned when files change.
- `FR-POL-007`: Users can check, test, explain, format, and simulate policies.
- `FR-POL-008`: Simulation has no tool side effects.
- `FR-POL-009`: Missing optional attributes use three-valued logic, explicit presence tests, and fail-closed matching.
- `FR-POL-010`: Deny overrides approval and allow regardless of priority; priority selects explanation only within the winning effect.

### 5.5 Capability action execution

- `FR-TOOL-001`: Only operations from registered, versioned capability packs can be advertised or executed.
- `FR-TOOL-002`: Raw arguments validate structurally and semantically.
- `FR-TOOL-003`: Policy and execution use the same immutable normalized action.
- `FR-TOOL-004`: Every requested action has a recorded policy decision before handler execution.
- `FR-TOOL-005`: Output is bounded, classified, validated, and split into raw-trusted, audit, human, and agent views.
- `FR-TOOL-006`: Large output becomes an artifact with safe preview.
- `FR-TOOL-007`: Each operation defines side-effect class, timeout, cancellation, idempotency, preconditions, execution, reconciliation, and release behavior.
- `FR-TOOL-008`: Consequential capability actions execute serially in v1.
- `FR-TOOL-009`: Recoverable denials become safe bounded observations and consume a repeated-denial budget; protocol or invariant denials terminate safely.
- `FR-TOOL-010`: ACP, MCP, direct-model, and client requests enter the same normalization, policy, approval, execution, reconciliation, and output-release pipeline; protocol annotations never authorize.

### 5.6 Outcome validation

- `FR-OUT-001`: Every task profile owns a versioned structural schema plus pure semantic completeness validator for its terminal outcome.
- `FR-OUT-002`: Every artifact, resource, citation, test, receipt, and evidence reference in an outcome resolves to a released or produced object in the same authorized run context.
- `FR-OUT-003`: Claimed operations, source use, tests, and completion facts reconcile against canonical events and artifact hashes rather than agent prose.
- `FR-OUT-004`: Candidate outcome content passes classification and output-release policy before human/client export.
- `FR-OUT-005`: `RunCompleted` may follow only a committed `OutcomeValidated` for the current candidate/profile version; schema-valid but semantically fabricated outcomes are rejected.
- `FR-OUT-006`: A recoverable invalid outcome becomes a bounded agent observation and consumes budget; otherwise the run fails while retaining the candidate as an explicitly untrusted artifact.

### 5.7 Coding workspace and sandbox

- `FR-SBX-001`: Each run uses a detached disposable Git worktree.
- `FR-SBX-002`: The original checkout is never a writable run target.
- `FR-SBX-003`: Process tools run in an approved image as non-root.
- `FR-SBX-004`: Network is disabled by default.
- `FR-SBX-005`: Host credentials, agent socket, and container-engine socket are absent.
- `FR-SBX-006`: CPU, memory, PID, time, and output limits are enforced.
- `FR-SBX-007`: Cancellation terminates the full contained process tree.
- `FR-SBX-008`: Final output is a reviewable patch artifact, not an automatic branch mutation.
- `FR-SBX-009`: Patch application is the only accepted source-mutation path and produces a trusted internal checkpoint after verification.
- `FR-SBX-010`: Test and build processes receive a disposable snapshot without writable live Git metadata and cannot change the authoritative run checkpoint.
- `FR-SBX-011`: Networked package resolution is denied in v1; an offline install requires approved, integrity-checked prepopulated inputs.

### 5.8 Approvals

- `FR-APR-001`: Approval requests explain exact normalized effects and policy reason.
- `FR-APR-002`: Approval binds run, action ID, normalized action hash, policy, task-profile version, capability version, relevant resource preconditions, and execution environment; coding actions additionally bind checkpoint, file hashes, executable, image, and network profile.
- `FR-APR-003`: Approval expires and is usable once.
- `FR-APR-004`: Changed preconditions invalidate approval.
- `FR-APR-005`: Approve and deny decisions record actor, time, and optional reason.
- `FR-APR-006`: A client cannot directly mark an action executable; the daemon revalidates.

### 5.9 Durability

- `FR-DUR-001`: Externally meaningful state transitions are events.
- `FR-DUR-002`: Stream versions are gap-free and append uses optimistic concurrency.
- `FR-DUR-003`: Commands are inserted transactionally from committed events.
- `FR-DUR-004`: Workers use database leases and heartbeats.
- `FR-DUR-005`: Expired work is reconciled before retry.
- `FR-DUR-006`: Replay performs no external effects.
- `FR-DUR-007`: Completed driver turns and, when present, provider responses are reused during replay rather than regenerated.
- `FR-DUR-008`: Ambiguous external driver/provider attempts remain visible and consume budget.
- `FR-DUR-009`: Cancellation and budget exhaustion are durable states.
- `FR-DUR-010`: Durable mode persists the exact ordered agent-visible transcript and, for direct-model drivers, required opaque provider items under local authenticated encryption.
- `FR-DUR-011`: Metadata-only mode becomes explicitly non-resumable after owning-process loss and never regenerates a missing provider response during replay.
- `FR-DUR-012`: Reconciliation that cannot prove preimage or postimage enters orphaned state and stops automatic retry.

### 5.10 Evaluation

- `FR-EVAL-001`: Eval cases version task profile, fixture/source manifest, objective, agent, optional provider, policy, faults, budgets, and assertions.
- `FR-EVAL-002`: Scripted-driver and synthetic-provider scripts validate runtime requests before emitting output.
- `FR-EVAL-003`: Deterministic safety cases run without credentials.
- `FR-EVAL-004`: Fault injection targets named effect boundaries.
- `FR-EVAL-005`: Results record environment fingerprint.
- `FR-EVAL-006`: Baseline comparison separates deterministic from stochastic metrics.
- `FR-EVAL-007`: CI fails on deterministic policy or durability regressions.
- `FR-EVAL-008`: Real-model suites enforce spend and concurrency limits.
- `FR-EVAL-009`: Conformance suites cover each provider, driver, protocol bridge, modality, credential strategy, and claimed compatibility tier.
- `FR-EVAL-010`: At least one non-coding profile must pass kernel, policy, durability, and outcome tests without loading coding packages.

### 5.11 CLI and daemon

- `FR-CLI-001`: CLI offers human, JSONL, and quiet output modes.
- `FR-CLI-002`: JSONL stdout contains no unstructured progress text.
- `FR-CLI-003`: Exit codes distinguish input, denial, approval, budget, task, infrastructure, and cancellation outcomes.
- `FR-CLI-004`: First interrupt requests cancellation; client detachment does not corrupt durable runs.
- `FR-CLI-005`: `guard run message <run-id> <intent>` appends follow-up intent without modifying the original objective.
- `FR-RPC-001`: Daemon uses a versioned framed JSON-RPC protocol over an owner-only local socket.
- `FR-RPC-002`: Mutating requests are idempotent by client request ID.
- `FR-RPC-003`: Subscriptions resume from durable cursors.
- `FR-RPC-004`: Slow clients cannot cause unbounded buffering.
- `FR-RPC-005`: Local peer identity is verified in addition to owner-only socket permissions.
- `FR-RPC-006`: Artifact transfer uses authorized bounded chunks with byte cursors and whole-object hash verification.
- `FR-RPC-007`: Reusing a client request ID with different caller, method, or canonical bytes is rejected.

### 5.12 VS Code

- `FR-VSC-001`: Extension checks workspace trust.
- `FR-VSC-002`: Extension starts and observes runs through the daemon only.
- `FR-VSC-003`: Extension displays run tree, timeline, approvals, context manifest, and native diff.
- `FR-VSC-004`: Extension stores no provider or external-agent credential bytes.
- `FR-VSC-005`: Webviews use strict CSP and validate messages.
- `FR-VSC-006`: Closing the editor does not terminate durable work.

## 6. Core User Flows

### 6.1 First deterministic demo

1. User clones Guarded Agent and runs repository checks.
2. User runs the bundled scripted-driver and synthetic-provider demo without credentials.
3. Runtime copies a synthetic fixture into a temporary Git repository.
4. Runtime pins the strict policy.
5. Scripted driver requests allowed source files.
6. Context broker releases bounded content and records manifests.
7. Scripted driver proposes a patch.
8. Gateway validates and policy evaluates it.
9. User approves exact patch if configured.
10. Patch applies inside disposable worktree.
11. Tests execute in sandbox.
12. Runtime emits final patch and audit report.
13. Test verifies original fixture checkout remains unchanged.

Success: reproducible without provider key, PostgreSQL optional until durability milestone, no hidden network access.

### 6.2 Real coding run

1. User runs `guard doctor`.
2. User runs `guard run "objective"` in a clean Git repository.
3. CLI shows run ID, base commit, policy, provider, sandbox, budgets, and storage choice.
4. Runtime asks the direct-model driver for the next response through the pinned provider adapter.
5. Model proposes a read capability action.
6. Context broker and policy release or deny it.
7. Model proposes a write or process action.
8. Runtime shows approval when required.
9. Approved action executes in worktree/container.
10. Driver receives the bounded agent view of the result.
11. Runtime stops on a schema-valid outcome, denial the driver cannot recover from, cancellation, failure, or budget exhaustion.
12. CLI shows summary and artifact paths.

Success: user can inspect every decision and no result is silently applied to the original branch.

### 6.3 Approval invalidation

1. Runtime requests approval for a patch or dependency command.
2. User or another permitted local process changes a bound input before approval is consumed.
3. User approves the visible request.
4. Runtime recalculates preconditions.
5. Hash mismatch invalidates approval.
6. Runtime records reason and produces a fresh request only if the updated action still passes policy.

Success: stale approval never executes changed work.

### 6.4 Crash recovery

1. Worker claims tool command and records start.
2. Fault kills worker after side effect but before success event.
3. Lease expires.
4. Reaper makes command eligible for reconciliation.
5. New worker inspects the pre-action checkpoint, exact patch hash, affected paths, and expected postimage tree.
6. Reconciliation recognizes the completed effect.
7. Runtime records recovered success without applying again.
8. Durable mode reconstructs the exact ordered agent/provider-visible transcript required by the driver and resumes at the next turn.

Success: one visible effect and an audit trail explaining recovery.

If neither preimage nor postimage matches, the run enters `orphaned`, exposes inspection and export, and performs no automatic retry. If transcript evidence mode is `ephemeral_metadata` and the owning process was lost, the run terminates as non-resumable even when the patch itself reconciles.

### 6.5 Policy simulation

1. Security engineer edits a candidate policy.
2. `guard policy check` parses and type-checks.
3. `guard policy test` runs table cases.
4. `guard policy simulate` evaluates recorded normalized actions with old and new snapshots.
5. Report groups changed effects and explanations.
6. Engineer reviews newly allowed consequential actions.
7. Candidate becomes a new immutable version only after acceptance.

Success: no tool executes and active runs remain pinned.

### 6.6 Cancellation

1. User requests cancellation.
2. Runtime records `CancellationRequested`.
3. Pending model stream is cancelled or marked uncertain according to observed state.
4. Active container/process group receives graceful stop then forced termination after deadline.
5. Worker records final process status and cleanup result.
6. Runtime enters `cancelled` terminal state.
7. Patch and audit artifacts remain available according to retention policy.

Success: no orphan process, no false completed status, inspectable partial result.

### 6.7 Apply result to developer branch

Initial v1 does not mutate the branch automatically. The product supplies:

- Patch artifact path and hash
- Base commit
- Changed-path manifest
- Test results
- Documented manual `git apply --check` and apply flow

A later explicit `guard result apply` command requires clean target state, matching base or successful three-way preflight, clear diff display, confirmation, and a separate audit event. It is not required for the first portfolio release.

### 6.8 Local-corpus research run

1. User installs or selects the `local-research` task profile and supplies a structured question plus an approved corpus root.
2. Runtime validates the profile without loading coding packages, records a corpus manifest, and refuses symlink or path escapes.
3. Selected agent driver proposes document search/read actions through the generic capability gateway.
4. Context policy filters resource identifiers, snippets, document bytes, and operation output before agent release.
5. Driver proposes a research outcome containing answer claims, citation references, and uncertainty.
6. Outcome validator proves each citation names a released source and allowed location, rejects invented citations, and emits the source manifest.
7. Run completes without Git, worktree, patch, or process capability state.

Success: the same reducer, event store, policy, approvals, evidence, budgets, and eval runner work for a useful non-coding task.

### 6.9 Bring-your-own provider credential

1. User runs `guard credentials add <name> --strategy <reviewed-strategy>` and enters the secret through hidden terminal input or OS credential-store UI.
2. CLI stores secret bytes only in the OS credential store and records an opaque reference plus safe origin/account metadata.
3. User creates a provider profile that pins adapter, exact endpoint origin, model, capability manifest, retention, and credential reference.
4. `guard providers validate` performs offline schema/capability checks; an optional confirmed network probe discloses possible cost and sends no source content.
5. A run resolves the credential inside the trusted transport immediately before the request, rejects redirects, and scrubs authentication from all diagnostics.
6. Rotation atomically changes the secret behind the reference for future attempts; removal prevents new attempts without altering historical secret-free evidence.

Success: selecting a different installed provider/profile requires no kernel or policy change, and a canary copy of the secret is absent from every exported surface and child environment.

### 6.10 External agent run

1. User selects an installed ACP, guarded-MCP, or contained-CLI agent profile.
2. CLI displays the adapter's evidence-backed guarantee tier and limitations before starting.
3. For Tier B, filesystem reads, writes, and terminal requests map to context or capability intents; the protocol's permission request is display metadata, never authorization.
4. For Tier C, the black-box process receives only a filtered disposable snapshot, bounded resources, the configured network profile, and no host/model credentials; its final output is an untrusted candidate artifact.
5. Runtime imports a candidate patch or outcome only after schema, policy, precondition, and output-release checks.
6. Audit export includes operations Guarded observed, operations it could not observe, the exact adapter version, and the achieved tier.

Success: an external agent cannot gain a stronger claim merely by identifying as ACP/MCP-compatible, and unsupported behavior fails closed or is labeled containment-only.

## 7. Failure UX Requirements

Every failure shown to a user includes:

- Stable error code
- One-sentence outcome
- What remains safe or unchanged
- Whether retry is safe
- Run ID and inspection command
- Remediation that does not expose secrets

Examples:

- Policy denial names rule and normalized resource without hidden content.
- Provider auth failure confirms no tool executed for that turn.
- Sandbox startup failure confirms original checkout is unchanged.
- Budget exhaustion reports consumed and configured limits.
- Ambiguous provider failure says a retry may incur additional cost.
- Approval invalidation names changed precondition category, not secret content.

## 8. Non-Functional Requirements

### 8.1 Security

- Default deny for consequential unknown actions
- No shell-string execution
- No provider/external-agent credential in capability processes, containers, protocol messages, or clients
- Owner-only local state and socket permissions
- Bounded untrusted input and output
- Versioned boundary schemas
- Dependency and image provenance recorded
- Explicit residual-risk documentation

### 8.2 Reliability

- Durable-encrypted runs survive minimal-daemon restart after the durability milestone
- Metadata-only runs state their non-resumable process-loss boundary
- At-least-once command delivery with reconciliation
- No replayed side effects
- Deterministic projection rebuild
- Safe cleanup of owned resources
- Backups verifiably restore database/artifact consistency after durability release

### 8.3 Performance

- Policy evaluation does not dominate provider latency
- CLI remains responsive while work runs
- Slow subscribers are bounded and resumable
- Large output streams to artifacts instead of memory
- Replay and projection rebuild have measured throughput

Concrete budgets are established with the first representative fixtures rather than invented before implementation measurements exist.

### 8.4 Privacy

- Provider storage disabled by default
- Only selected context transmitted
- Denied secrets never persisted
- Diagnostic exports redacted and tested
- Data classes and retention documented
- Local deletion path available

### 8.5 Usability and accessibility

- Terminal output remains understandable without color
- Color obeys `NO_COLOR` convention when renderer support is added
- Approvals use explicit verbs and do not rely on icon/color alone
- JSONL provides automation parity
- VS Code views use native accessibility labels and keyboard navigation
- Long-running steps expose state and cancellation

### 8.6 Maintainability

- One-way package dependencies
- No framework replacing core thesis
- Versioned events, tools, policies, evals, config, and RPC
- ADR for significant reversals
- Permanent bypass regressions
- Public docs distinguish implementation from design

## 9. Acceptance Hierarchy

A requirement is accepted only when:

1. Its implementation is merged.
2. Enforcement point is identified.
3. Expected events and outputs exist.
4. Normal and failure tests pass.
5. Security-relevant behavior has an adversarial case.
6. Installation and upgrade impact is documented.
7. User documentation describes real behavior.
8. Residual risk is stated.

Milestone acceptance does not imply later requirements are implemented. README status and release notes must name the highest completed milestone.
