# Guarded Agent: Product Requirements and User Flows

## 1. Product Goal

Guarded Agent lets a developer delegate bounded coding work to a model while retaining deterministic control over repository context, file changes, processes, network access, approvals, budgets, and audit history.

The product succeeds when a developer can answer five questions for every run:

1. What did the model see?
2. What did the model request?
3. Why was each request allowed, denied, or approval-gated?
4. What actually executed and where?
5. Can the result and recovery history be independently verified?

## 2. Primary Users

### 2.1 Individual developer

Wants a useful coding agent without granting unrestricted shell and repository access. Values a fast CLI, understandable approvals, reviewable patches, and confidence that the original checkout remains safe.

### 2.2 Security or platform engineer

Defines organizational policies, investigates decisions, simulates policy changes, examines audit evidence, and verifies that controls are enforced outside model prompts.

### 2.3 AI engineer

Compares provider or prompt behavior using deterministic and stochastic evals while holding policy, tools, context, and fixtures constant.

### 2.4 Code reviewer

Did not start the run but needs the objective, policy trace, exact patch, test evidence, approvals, costs, and limitations without reading raw internal events.

## 3. Product Principles

- Safe useful work is preferred to blanket refusal.
- The model is an untrusted planner, not a principal with ambient authority.
- Read access is a security decision because disclosed context cannot be recovered.
- Human approval is specific, expiring, and state-bound.
- The original checkout is protected by construction.
- Recovery behavior is part of correctness.
- Deterministic evidence supports every deterministic claim.
- A UI explains enforcement but never replaces it.
- Defaults minimize access, network, retention, and spend.

## 4. Scope

### 4.1 Required v1 capabilities

- Run a single coding task against one local Git repository
- Use a deterministic fake provider and one hosted real provider
- List, search, and read allowed repository content
- Propose and apply bounded text patches in a disposable worktree
- Run configured tests or builds in a constrained container
- Evaluate each action through a versioned custom policy
- Pause for exact-action approval
- Deny forbidden context or actions with deterministic explanation
- Persist an append-only run history in PostgreSQL
- Recover from worker and daemon interruption
- Export patch, audit, and evaluation artifacts
- Operate fully through a CLI
- Later expose the same capabilities through a VS Code extension

### 4.2 Explicit non-goals for v1

- General-purpose autonomous assistant
- Multiple cooperating agents
- Browser or desktop control
- Cloud-resource mutation
- Autonomous push, merge, deploy, or release
- Arbitrary network access
- Arbitrary MCP servers
- Windows support
- Self-hosted model inference
- Training or fine-tuning models
- Perfect containment claim
- Enterprise identity, billing, or multi-tenancy
- Code-OSS fork

## 5. Functional Requirements

### 5.1 Run creation

- `FR-RUN-001`: The user can create a run with objective, repository, policy profile, provider profile, and budgets.
- `FR-RUN-002`: The runtime records repository root, base commit, dirty state, policy snapshot, provider fingerprint, and sandbox profile before accepting work.
- `FR-RUN-003`: Dirty repositories are refused by default with safe options to commit, stash manually, or choose a future explicit snapshot mode.
- `FR-RUN-004`: A run receives an opaque ID and an append-only event stream.
- `FR-RUN-005`: The original objective is immutable; follow-up intent is represented as a new event.

### 5.2 Context access

- `FR-CTX-001`: The model receives repository content only through context tools.
- `FR-CTX-002`: Every resource is canonicalized and evaluated before reading.
- `FR-CTX-003`: Secret path policy runs before content is opened.
- `FR-CTX-004`: Content detection may deny or redact before release.
- `FR-CTX-005`: Every released item records path, range, hash, policy version, and reason.
- `FR-CTX-006`: Denied content records metadata without the denied bytes.
- `FR-CTX-007`: Turn and run context budgets are enforced.
- `FR-CTX-008`: Tool output passes through the same release boundary before model use.

### 5.3 Policy

- `FR-POL-001`: Policies support allow, deny, and require-approval effects.
- `FR-POL-002`: Policies compile into immutable versioned snapshots.
- `FR-POL-003`: Unknown attributes or invalid types fail policy loading.
- `FR-POL-004`: A decision contains effect, matched rule, default behavior, and clause trace.
- `FR-POL-005`: Deny precedence is deterministic.
- `FR-POL-006`: Active runs remain pinned when files change.
- `FR-POL-007`: Users can check, test, explain, format, and simulate policies.
- `FR-POL-008`: Simulation has no tool side effects.

### 5.4 Tool execution

- `FR-TOOL-001`: Only registered versioned tools can be advertised or executed.
- `FR-TOOL-002`: Raw arguments validate structurally and semantically.
- `FR-TOOL-003`: Policy and execution use the same immutable normalized action.
- `FR-TOOL-004`: Every requested action has a recorded policy decision before handler execution.
- `FR-TOOL-005`: Output is bounded, classified, validated, and split into audit/human/model views.
- `FR-TOOL-006`: Large output becomes an artifact with safe preview.
- `FR-TOOL-007`: Each tool defines timeout, cancellation, idempotency, and reconciliation.
- `FR-TOOL-008`: Consequential tools execute serially in v1.

### 5.5 Workspace and sandbox

- `FR-SBX-001`: Each run uses a detached disposable Git worktree.
- `FR-SBX-002`: The original checkout is never a writable run target.
- `FR-SBX-003`: Process tools run in an approved image as non-root.
- `FR-SBX-004`: Network is disabled by default.
- `FR-SBX-005`: Host credentials, agent socket, and container-engine socket are absent.
- `FR-SBX-006`: CPU, memory, PID, time, and output limits are enforced.
- `FR-SBX-007`: Cancellation terminates the full contained process tree.
- `FR-SBX-008`: Final output is a reviewable patch artifact, not an automatic branch mutation.

### 5.6 Approvals

- `FR-APR-001`: Approval requests explain exact normalized effects and policy reason.
- `FR-APR-002`: Approval binds run, tool call, action hash, policy, worktree revision, relevant file hashes, executable, image, and network profile.
- `FR-APR-003`: Approval expires and is usable once.
- `FR-APR-004`: Changed preconditions invalidate approval.
- `FR-APR-005`: Approve and deny decisions record actor, time, and optional reason.
- `FR-APR-006`: A client cannot directly mark an action executable; the daemon revalidates.

### 5.7 Durability

- `FR-DUR-001`: Externally meaningful state transitions are events.
- `FR-DUR-002`: Stream versions are gap-free and append uses optimistic concurrency.
- `FR-DUR-003`: Commands are inserted transactionally from committed events.
- `FR-DUR-004`: Workers use database leases and heartbeats.
- `FR-DUR-005`: Expired work is reconciled before retry.
- `FR-DUR-006`: Replay performs no external effects.
- `FR-DUR-007`: Completed provider responses are reused during replay.
- `FR-DUR-008`: Ambiguous provider attempts remain visible and consume budget.
- `FR-DUR-009`: Cancellation and budget exhaustion are durable states.

### 5.8 Evaluation

- `FR-EVAL-001`: Eval cases version fixture, objective, provider, policy, faults, budgets, and assertions.
- `FR-EVAL-002`: Fake-provider scripts validate runtime requests before emitting output.
- `FR-EVAL-003`: Deterministic safety cases run without credentials.
- `FR-EVAL-004`: Fault injection targets named effect boundaries.
- `FR-EVAL-005`: Results record environment fingerprint.
- `FR-EVAL-006`: Baseline comparison separates deterministic from stochastic metrics.
- `FR-EVAL-007`: CI fails on deterministic policy or durability regressions.
- `FR-EVAL-008`: Real-model suites enforce spend and concurrency limits.

### 5.9 CLI and daemon

- `FR-CLI-001`: CLI offers human, JSONL, and quiet output modes.
- `FR-CLI-002`: JSONL stdout contains no unstructured progress text.
- `FR-CLI-003`: Exit codes distinguish input, denial, approval, budget, task, infrastructure, and cancellation outcomes.
- `FR-CLI-004`: First interrupt requests cancellation; client detachment does not corrupt durable runs.
- `FR-RPC-001`: Daemon uses a versioned framed JSON-RPC protocol over an owner-only local socket.
- `FR-RPC-002`: Mutating requests are idempotent by client request ID.
- `FR-RPC-003`: Subscriptions resume from durable cursors.
- `FR-RPC-004`: Slow clients cannot cause unbounded buffering.

### 5.10 VS Code

- `FR-VSC-001`: Extension checks workspace trust.
- `FR-VSC-002`: Extension starts and observes runs through the daemon only.
- `FR-VSC-003`: Extension displays run tree, timeline, approvals, context manifest, and native diff.
- `FR-VSC-004`: Extension stores no provider key.
- `FR-VSC-005`: Webviews use strict CSP and validate messages.
- `FR-VSC-006`: Closing the editor does not terminate durable work.

## 6. Core User Flows

### 6.1 First deterministic demo

1. User clones Guarded Agent and runs repository checks.
2. User runs the bundled fake-provider demo.
3. Runtime copies a synthetic fixture into a temporary Git repository.
4. Runtime pins the strict policy.
5. Fake provider requests allowed source files.
6. Context broker releases bounded content and records manifests.
7. Fake provider proposes a patch.
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
4. Runtime asks model for the next response.
5. Model requests a read tool.
6. Context broker and policy release or deny it.
7. Model proposes a write or process.
8. Runtime shows approval when required.
9. Approved action executes in worktree/container.
10. Model receives bounded result.
11. Runtime stops on completion, denial the model cannot recover from, cancellation, failure, or budget exhaustion.
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
5. New worker inspects worktree and expected action hash.
6. Reconciliation recognizes completed effect.
7. Runtime records recovered success without applying again.
8. Run resumes at the next model turn.

Success: one visible effect and an audit trail explaining recovery.

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
- No provider secret in child tools or clients
- Owner-only local state and socket permissions
- Bounded untrusted input and output
- Versioned boundary schemas
- Dependency and image provenance recorded
- Explicit residual-risk documentation

### 8.2 Reliability

- Durable state survives daemon restart
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
