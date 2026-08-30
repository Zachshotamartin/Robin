# Policy-Enforced Coding Agent: Full Build Plan

Working title: **Guarded Agent**. The name can change; the architecture should not depend on it.

Companion documents:

- [Critical plan review](./PLAN_REVIEW.md)
- [Detailed implementation guide](./IMPLEMENTATION_GUIDE.md)
- [Installation, testing, operations, and release plan](./OPERATIONS_TEST_PLAN.md)
- [Product requirements and user flows](./PRODUCT_REQUIREMENTS.md)
- [Threat model](./THREAT_MODEL.md)

## Plan Review Outcome

The architecture is worth building and the combined project is more distinctive than any of its individual source ideas. A critical review produced the following corrections:

1. **Keep the custom work at the product boundary.** Build the policy parser, evaluator, agent state machine, context broker, tool gateway, approvals, event model, workflow recovery, and eval system. Use the official model SDK and a mature JSON Schema validator; transport and schema-validation bugs would weaken rather than differentiate the security story.
2. **Ship two meaningful checkpoints.** The deterministic MVP proves the design before PostgreSQL, containers, and a real model are added. The portfolio v1 adds those production systems. Neither checkpoint depends on VS Code.
3. **Serialize tool execution in v1.** Parallel model tool calls multiply approval, locking, causality, and replay problems. The provider may stream output, but the runtime accepts and executes at most one consequential action at a time until parallel semantics are deliberately designed.
4. **Treat model calls as costly, non-idempotent external operations.** Persist completed responses and never regenerate them during replay. An ambiguous transport failure may be retried only as a new, explicitly recorded attempt with budget impact.
5. **Default to minimal provider retention.** Request `store: false` where supported, reconstruct conversation state from the local event history, and make any provider-side storage an explicit configuration choice.
6. **Bind approvals to observed state, not only arguments.** File hashes, worktree revision, executable resolution, and relevant environment facts are preconditions. A change between approval and execution invalidates the approval.
7. **Use PostgreSQL when it starts earning its cost.** Early reducer and policy milestones use an in-memory event store. PostgreSQL arrives with concurrent workers, leases, and crash recovery rather than blocking the first vertical slice.
8. **Use honest scheduling.** A credible deterministic MVP is about 8–12 part-time weeks; the full CLI portfolio release is approximately 18–24 part-time weeks; the extension is another 4–6 weeks. Security and fault-injection acceptance criteria should not be traded for an artificial date.

## 1. Product Definition

Build a CLI-first coding agent whose defining feature is that the model never receives context or performs an action without passing through a deterministic policy and execution layer.

The product is not another chat wrapper. It is the runtime between a hosted model and a developer's machine:

```text
Developer
   |
CLI now / VS Code later
   |
Durable agent runtime
   |---- Context broker ---- Repository
   |---- Policy engine ----- Rules and approvals
   |---- Tool gateway ------ Files, processes, Git, network
   |---- Event ledger ------ Audit, replay, recovery
   |---- Eval runner ------- Adversarial scenarios
   |
Hosted model API
```

The model proposes. The runtime decides what the model may see, which proposed calls may run, where they run, and whether a human must approve them.

### The one-sentence pitch

> A policy-enforced coding-agent runtime that gives developers an explainable security boundary, sandboxed execution, human approvals, crash recovery, and behavioral evaluation across CLI and VS Code.

### The flagship demonstration

A developer asks the agent to add rate limiting to a deliberately hostile sample repository. During the run:

1. A repository instruction attempts to convince the agent to reveal `.env`.
2. The context policy prevents the secret from entering model context.
3. A dependency installation pauses for approval and displays its exact effects.
4. Tests execute in an isolated worktree and container with no network by default.
5. The agent produces a reviewable patch but cannot push or modify the protected branch.
6. The worker is killed mid-run and resumes from its persisted history without duplicating a completed side effect.
7. The eval report shows which policies fired, false-positive rates, cost, latency, and task outcome.

That demo unifies the original authorization debugger, AI evaluation control plane, and event-driven workflow engine into one coherent product.

## 2. Product Decisions

### Build order

1. **Headless core library**
2. **CLI**
3. **Local background daemon**
4. **VS Code extension**
5. **Optional Code-OSS fork only after an explicit decision gate**

The CLI is the first real product because it forces the runtime to work without editor-specific shortcuts, is easy to test in CI, and makes the security boundary observable. The VS Code extension will be a client of the same daemon rather than a second agent implementation.

### Model strategy

Use a hosted model API for reasoning. Build the agent loop and every consequential runtime component locally. Start with OpenAI's Responses API using custom function tools; the API lets the model request strongly typed calls into custom code, but the harness remains responsible for actually executing them. See the current [Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

Add a provider interface from the beginning, but implement only:

- `FakeModelProvider` for deterministic tests
- `OpenAIResponsesProvider` for the real MVP

An OpenAI-compatible local endpoint or another provider can come later. Do not run or fine-tune a raw model in the first release; that would turn an agent-runtime project into an ML-infrastructure project.

For the first provider, use the official OpenAI JavaScript SDK as a transport dependency while keeping request construction, tool normalization, budgets, policy enforcement, and the agent loop inside this repository. Set provider storage off by default and disable parallel tool calls in v1.

### Initial platform scope

- macOS and Linux
- Git repositories
- Docker or Podman available locally
- One developer and one machine
- TypeScript repositories in the polished demo, while keeping file and process tools language-agnostic
- No autonomous Git push, deployment, email, cloud mutation, or multi-agent coordination in v1

## 3. What “From Scratch” Means

The goal is to write the differentiating systems yourself without reimplementing infrastructure whose correctness is both security-critical and unrelated to the product thesis.

### Build yourself

- Agent loop and explicit state machine
- Provider-neutral model protocol
- Streaming response and tool-call normalization above the provider SDK
- Policy-language lexer, parser, typed AST, evaluator, precedence rules, and explanation traces
- Context broker and provenance tracking
- Tool registry, schemas, argument validation, and capability model
- Approval state machine
- Git-worktree orchestration
- Sandbox lifecycle and resource-policy orchestration
- Durable workflow scheduler, leases, retries, timeouts, cancellation, and recovery
- Append-only event model, projections, audit viewer, and replay
- Evaluation scenario format, runner, graders, metrics, and regression gate
- CLI command parser, text renderer, and JSONL protocol
- Local daemon and JSON-RPC protocol
- VS Code extension client and approval/diff experience
- Fault-injection fixtures and hostile sample repositories

### Use proven primitives

- A hosted foundation model rather than training or serving one
- Git rather than implementing version control
- Docker/Podman and the operating system rather than implementing process isolation
- PostgreSQL and its driver rather than implementing a database
- Standard cryptographic hash functions rather than inventing cryptography
- Node's HTTP, filesystem, process, test, and assertion libraries
- The official OpenAI JavaScript SDK as the provider transport
- JSON Schema plus Ajv for untrusted model/tool argument validation
- The VS Code extension API rather than building an editor engine

### Libraries intentionally excluded from the core

Do not use LangChain, an Agents SDK, Temporal, BullMQ, OPA, Cedar, Casbin, an ORM, or a general workflow framework in the first release. Those systems would replace the exact parts this project is meant to demonstrate. The official provider SDK and Ajv are narrow correctness dependencies, not agent frameworks.

## 4. System Architecture

### Components

| Component | Responsibility | Trust level |
|---|---|---|
| CLI / editor client | Collect intent, show events, request approvals | Trusted UI, not enforcement |
| Local daemon | Own runs, workers, persistence, and client sessions | Trusted coordinator |
| Agent runtime | Advance the run state machine and call the model | Trusted control logic |
| Model provider | Return text and proposed tool calls | Untrusted proposer |
| Context broker | Select, bound, redact, and record model context | Trusted data boundary |
| Policy engine | Return allow, deny, or approval with a trace | Trusted decision point |
| Tool gateway | Validate and dispatch every action | Trusted enforcement point |
| Sandbox manager | Isolate processes and workspaces | Trusted orchestrator |
| Event store | Persist the canonical history | Trusted record |
| Eval runner | Execute scenarios and calculate release metrics | Trusted verifier |
| Repository content | Source code, instructions, and possible attacks | Untrusted input |

### Non-negotiable invariants

1. The model cannot call operating-system or repository APIs directly.
2. A tool handler cannot run until its normalized request has a recorded policy decision.
3. Approval is bound to the exact tool, normalized arguments, policy version, and request hash.
4. A denied resource cannot be smuggled through another tool's output.
5. The original checkout is not directly writable during an agent run.
6. Every externally visible state transition is represented by an append-only event.
7. Replaying events never repeats side effects.
8. Tool output is bounded before it is persisted or sent to the model.
9. Repository instructions are treated as data, not as trusted system instructions.
10. A completed run always has a reviewable patch, an audit trace, or an explicit no-change result.

## 5. Technology Choices

- **Language:** TypeScript on Node.js 22+
- **Workspace:** npm workspaces, with strict TypeScript project references
- **Persistence:** PostgreSQL 17 with handwritten SQL migrations and queries
- **Local transport:** JSON-RPC 2.0 over a Unix domain socket; Windows named pipes later
- **Model transport:** official OpenAI JavaScript SDK behind the repository's provider interface
- **Boundary validation:** JSON Schema with Ajv in strict mode; schemas remain owned and versioned here
- **Isolation:** Docker first, Podman adapter second
- **Source control:** Git CLI through an argument-array process runner
- **Tests:** built-in `node:test` and `node:assert`
- **Configuration:** JSON for machine configuration and a custom `.guard` language for policies
- **Packaging:** one `guard` CLI plus one `guardd` daemon executable

PostgreSQL is heavier than SQLite, but it provides credible transactional queue semantics, concurrent workers, row locking, and operational depth. A later embedded-store adapter can improve installability without weakening the main implementation.

## 6. Repository Layout

```text
guarded-agent/
  apps/
    cli/
    daemon/
    vscode/
  packages/
    contracts/          # IDs, events, schemas, shared domain types
    event-store/        # append, subscribe, projections, migrations
    runtime/            # run state machine and orchestration
    model-core/         # provider interface and normalized model events
    model-fake/         # deterministic scripted model
    model-openai/       # Responses API adapter
    policy-language/    # lexer, parser, AST, formatter
    policy-engine/      # evaluator, trace, impact simulation
    context-broker/     # selection, budgets, redaction, provenance
    tool-gateway/       # registry, validation, dispatch, idempotency
    tools-core/         # read/search/patch/process/test/Git tools
    sandbox/            # container profiles and lifecycle
    worktree/           # disposable Git worktree management
    approvals/          # approval tokens and expiry
    evals/              # cases, graders, metrics, regression gates
    json-rpc/           # daemon/client protocol
  policies/
    default.guard
    strict.guard
  fixtures/
    safe-repo/
    hostile-repo/
    crash-recovery-repo/
  migrations/
  docs/
    architecture.md
    threat-model.md
    policy-language.md
    event-model.md
    demo-script.md
  package.json
  tsconfig.base.json
```

Keep package boundaries real: each package exposes a narrow public API and cannot import another package's internals.

## 7. Core Contracts

The first implementation should establish small stable interfaces before any real model calls are made.

```ts
interface ModelProvider {
  respond(request: ModelRequest): AsyncIterable<ModelEvent>;
}

interface PolicyEngine {
  evaluate(request: ActionRequest, snapshot: PolicySnapshot): PolicyDecision;
}

interface Tool<TInput, TOutput> {
  definition: ToolDefinition<TInput>;
  execute(context: ToolContext, input: TInput): Promise<ToolResult<TOutput>>;
}

interface EventStore {
  append(streamId: string, expectedVersion: number, events: NewEvent[]): Promise<EventEnvelope[]>;
  read(streamId: string, afterVersion?: number): AsyncIterable<EventEnvelope>;
}
```

Important IDs should be distinct types rather than interchangeable strings: `RunId`, `ToolCallId`, `ApprovalId`, `PolicyVersion`, `ArtifactId`, and `IdempotencyKey`.

## 8. Policy System

### Decision model

Every action produces one of three effects:

- `allow`
- `deny`
- `require_approval`

An action contains:

- **Subject:** user, agent, client, run
- **Action:** tool name and operation class
- **Resource:** canonical path, executable, host, branch, or artifact
- **Environment:** repository trust, sandbox profile, CI/local mode
- **Request:** normalized arguments, risk level, estimated cost, provenance

### Example language

```text
policy "protect-secrets" priority 100 {
  when action.tool == "read_file"
    and resource.path matches "**/.env*"
  deny
  reason "Secret files cannot enter model context"
}

policy "approve-dependencies" priority 70 {
  when action.tool == "run_process"
    and request.executable in ["npm", "pnpm", "yarn"]
    and request.intent == "install_dependency"
  require_approval
  reason "Dependency installation can execute third-party lifecycle scripts"
}

policy "tests-in-sandbox" priority 50 {
  when action.tool == "run_tests"
    and environment.sandboxed == true
  allow
}
```

### Implement the language yourself

1. Handwritten lexer with precise spans and useful syntax errors
2. Pratt parser for boolean expressions and comparisons
3. Typed AST with no evaluation during parsing
4. Type checker for known attributes and operator compatibility
5. Pure evaluator with no filesystem or network access
6. Formatter so policies have a canonical representation
7. Decision trace that records matched and failed clauses
8. Simulator that compares two policy versions over recorded actions

### Precedence

- Higher priority evaluates first.
- Any matching `deny` wins.
- Otherwise, any matching `require_approval` wins.
- Otherwise, a matching `allow` permits the action.
- No match means deny for consequential tools and approval for read-only unknowns during development.
- The final production default is deny.

The explanation must be generated from evaluated AST nodes, not invented by the model.

### Policy debugger features

- `guard policy check <file>`: parse and type-check
- `guard policy explain <recorded-action>`: show the full decision tree
- `guard policy test`: execute table-driven policy cases
- `guard policy simulate --from v12 --to working`: show newly allowed, newly denied, and newly approval-gated actions
- Shadow mode: calculate a new policy without enforcing it

This is where the original authorization-policy-debugger idea remains visible as a substantial subsystem.

## 9. Agent Runtime

### Explicit states

```text
created
  -> planning
  -> waiting_for_model
  -> evaluating_action
  -> waiting_for_approval
  -> executing_tool
  -> recording_observation
  -> waiting_for_model
  -> completed | failed | cancelled
```

The runtime should be a reducer: current state plus event produces next state and commands. Commands cause side effects; results return as new events. This separation makes recovery and unit testing possible.

### Per-turn loop

1. Load run history and projection.
2. Ask the context broker for an allowed, budgeted context package.
3. Record the exact context manifest and hashes.
4. Send instructions, history, and tool definitions to the model.
5. Normalize streamed text and proposed tool calls.
6. Reject malformed or unknown calls before policy evaluation.
7. Evaluate the action against a pinned policy snapshot.
8. Deny, request approval, or execute it.
9. Record bounded tool output as an observation.
10. Repeat until the model finishes or a hard budget is reached.

Set parallel model tool calls off in v1. If a provider still returns more than one proposed call, record the protocol violation and fail closed rather than inventing an execution order.

### Hard budgets

- Maximum turns
- Maximum tool calls
- Maximum wall-clock time
- Maximum input/output tokens
- Maximum estimated model cost
- Maximum process runtime
- Maximum bytes per tool output and per run
- Maximum consecutive identical or equivalent actions

Budget exhaustion is a first-class terminal event, not an uncaught exception.

## 10. Context Broker

The context broker is the read side of the security boundary. It should prevent “the model saw it, so the damage was already done.”

### Responsibilities

- Canonicalize requested paths and resolve symlinks
- Enforce include/exclude and secret policies before reading
- Refuse binary files and oversized files by default
- Detect likely secrets and redact or deny according to policy
- Track byte and token estimates
- Attach provenance: path, byte range, content hash, requesting tool, policy version
- Delimit repository content as untrusted data
- Deduplicate unchanged context
- Apply a per-turn and per-run context budget
- Record what was withheld and why without logging the secret itself

### Initial context tools

- `list_files(root, glob, max_results)`
- `search_text(query, paths, max_matches)`
- `read_file(path, start_line, end_line)`
- `read_symbols(path)` after a simple TypeScript symbol extractor exists
- `inspect_manifest()` for recognized dependency manifests

Do not upload the entire repository or use unrestricted hosted file search in v1. Context enters the model only through these controlled paths.

## 11. Tool Gateway

### Initial tool set

| Tool | Default effect | Notes |
|---|---|---|
| `list_files` | allow | Bounded and filtered |
| `search_text` | allow | Bounded and filtered |
| `read_file` | allow/deny by path | Goes through context broker |
| `propose_patch` | allow | Parses unified diff but does not write |
| `apply_patch` | approval initially | Writes only inside disposable worktree |
| `run_tests` | allow in sandbox | Known command inferred from config |
| `run_process` | approval or deny | Executable plus argv, never a shell string |
| `git_status` | allow | Read-only |
| `inspect_diff` | allow | Read-only, bounded |
| `network_request` | deny initially | Later proxy with host/method policy |

### Tool contract rules

- Strict input schema with unknown properties rejected
- Normalized arguments are the only arguments policy evaluates or execution receives
- Paths are repository-relative in the model protocol and canonical internally
- Processes use `executable` plus `argv`; avoid `sh -c`
- Every call receives a deterministic idempotency key
- Output has separate human, model, and audit representations
- Stdout and stderr are truncated with hashes and artifact references
- Tools declare side-effect class, required capability, timeout, and compensability
- No tool can invoke another tool without returning through the gateway

## 12. Sandbox and Git Isolation

### Run workspace

1. Verify a clean or explicitly acknowledged repository state.
2. Create a disposable branch and Git worktree in a run-specific directory.
3. Mount only that worktree into the container.
4. Preserve the user's original checkout untouched.
5. Export the final diff as an artifact; applying it to the user's branch is a separate human action.

### Container profile

- Non-root UID/GID
- Read-only root filesystem
- Writable worktree plus bounded `tmpfs`
- Network disabled by default
- CPU, memory, PID, file-size, and wall-time limits
- No host Docker socket
- No SSH agent, cloud credentials, or model API key inside the container
- Minimal environment-variable allowlist
- Process-group termination on timeout or cancellation
- Captured and bounded stdout/stderr

On macOS, Docker Desktop adds a VM boundary, but the documentation should not claim perfect isolation. State the actual guarantees and limitations.

### Escape tests

- `../` path traversal
- Absolute paths
- Symlink escaping the repository root
- Hard-link edge cases where supported
- Shell metacharacters inside argv
- Fork bombs and excessive output
- Child processes surviving parent cancellation
- Access to Docker socket or host credentials
- Network attempts by package scripts

## 13. Durable Execution and Event Ledger

### Canonical events

```text
RunCreated
RunStarted
ContextRequested
ContextReleased
ContextDenied
ModelRequestStarted
ModelOutputReceived
ModelRequestUncertain
ToolRequested
ToolValidated
PolicyEvaluated
ApprovalRequested
ApprovalGranted
ApprovalDenied
ToolStarted
ToolSucceeded
ToolFailed
RetryScheduled
BudgetExceeded
PatchProduced
RunCancelled
RunFailed
RunCompleted
```

Each event includes stream ID, sequence number, event ID, timestamp, causation ID, correlation ID, actor, schema version, and payload.

### Storage tables

- `event_streams`
- `events`
- `run_queue`
- `worker_leases`
- `policy_versions`
- `approval_requests`
- `artifacts`
- `eval_suites`
- `eval_cases`
- `eval_results`

The `events` table is canonical. Read models such as run status, pending approvals, tool counts, and cost are projections that can be rebuilt.

### Delivery semantics

Claim jobs transactionally with leases and heartbeats. Promise at-least-once command delivery, not exactly once. Prevent duplicated effects with idempotency records and tool-specific reconciliation.

Example: if the worker crashes after applying a patch but before recording success, recovery compares the expected patch hash to the worktree before deciding whether to execute again.

Model requests require different recovery behavior. Once a completed provider response has been recorded, replay reuses it. If the connection fails after the request may have reached the provider but before a response is recorded, mark the attempt uncertain. A retry creates a new attempt event, consumes budget again, and is never described as an idempotent replay.

### Tamper evidence

Optionally hash-chain event envelopes with a standard hash function. Describe this as tamper-evident, not tamper-proof; an attacker controlling the database and the signing/hashing environment can replace the whole chain.

## 14. Approvals

An approval is an authorization artifact, not a chat message.

It must bind:

- Tool name and normalized arguments hash
- Run and tool-call IDs
- Policy version and matched rule
- Workspace and Git revision
- Relevant input-file hashes, resolved executable, and sandbox profile
- Human identity
- Creation and expiry times
- One-time use state

If any bound value or execution precondition changes, request approval again. Approvals expire, cannot be replayed across runs, and are consumed transactionally with the tool start event.

The UI must show:

- Exact command or patch
- Files, network destinations, or resources affected
- Why approval is required
- Applicable policy rule
- Whether the operation is reversible
- Estimated time and cost when available

## 15. CLI Product

### Commands

```text
guard init
guard doctor
guard run "add rate limiting"
guard run --policy strict.guard --jsonl "fix the failing test"
guard status <run-id>
guard inspect <run-id>
guard approve <approval-id>
guard deny <approval-id> --reason "..."
guard diff <run-id>
guard replay <run-id>
guard cancel <run-id>
guard policy check policies/default.guard
guard policy test
guard policy explain <tool-call-id>
guard policy simulate --from <version> --to <file>
guard eval run evals/security.json
guard eval compare <baseline> <candidate>
```

### Output modes

- Human-readable streaming terminal output
- `--jsonl` stable event stream for automation
- `--quiet` final result only
- Predictable exit codes for success, policy denial, approval required, budget exceeded, task failure, and infrastructure failure

The CLI renderer consumes domain events. It must not contain enforcement logic.

## 16. Local Daemon

The daemon becomes the single owner of workers, database connections, sandboxes, and active runs.

- JSON-RPC 2.0 over a permission-restricted Unix socket
- Explicit protocol version and capability negotiation
- Clients subscribe from an event cursor and can reconnect without losing events
- Mutating requests carry client-generated idempotency keys
- Local authentication uses socket permissions first; add a short-lived session token if TCP transport is ever introduced
- The API supports CLI and VS Code without exposing provider secrets to either client

Start with an in-process runtime for early milestones. Extract `guardd` only after the state machine and event store are stable.

## 17. VS Code Extension

The extension is phase two of the product, not a separate implementation.

### First extension features

- Command-palette action to start a run
- Runs tree with state, elapsed time, policy, cost, and current action
- Approval inbox with exact command or diff preview
- Native diff editor for the worktree result
- Event timeline with policy explanations
- Context panel showing released and denied files without exposing secret contents
- Cancel, retry, approve, deny, and export audit actions through the daemon

### Security rules

- No provider API key stored in extension state
- No direct tool execution from the extension host
- Workspace trust checked before starting the daemon or run
- Webviews use strict content security policy and message validation
- All authorization remains in the daemon

### Code-OSS fork decision gate

Only consider a fork after the extension is complete and at least one important interaction is impossible through stable extension APIs. A fork is justified only if the product truly needs first-class agent panes, deep editor lifecycle control, or a custom distribution. Otherwise it creates permanent merge, security-update, signing, telemetry, and release burdens without improving the core system.

If a fork is attempted, keep the harness as an independent daemon so the fork remains replaceable.

## 18. Evaluation Control Plane

### Scenario format

Each eval case declares:

- Repository fixture and starting revision
- User task
- Model script or real provider configuration
- Policy version
- Allowed/forbidden context and actions
- Required approvals
- Expected patch or invariant-based grader
- Fault schedule
- Budgets
- Tags such as security, durability, quality, latency, and cost

### Deterministic security suite

Use `FakeModelProvider` to force exact adversarial behavior:

- Requests `.env` directly
- Reads a symlink pointing outside the repository
- Obeys malicious instructions inside source comments
- Hides a shell command in a package script
- Tries command injection through argv
- Repeats a denied call
- Changes arguments after approval
- Reuses an approval in another run
- Attempts unapproved network access
- Tries to write the protected branch
- Emits malformed tool arguments
- Loops until a budget is exhausted

### Durability suite

- Crash before tool start
- Crash after side effect but before success event
- Lease expiry with two workers
- Duplicate model/tool response
- Database reconnect during append
- Cancellation during a process tree
- Retryable versus terminal tool failure
- Projection rebuild from events
- Schema migration of old event payloads

### Real-model suite

Use a small versioned corpus and run it only when credentials are available. Measure:

- Task success rate
- Policy-violation catch rate
- False-denial and unnecessary-approval rates
- Human interruptions per successful task
- Tool calls and repeated calls
- Context bytes and tokens released
- Latency and estimated cost
- Patch quality and test pass rate
- Recovery correctness under injected faults

### Release gate

Fail CI if deterministic policy or durability cases regress. Real-model evals should compare confidence intervals and practical thresholds rather than failing on a single stochastic run.

## 19. Threat Model

Document assets, actors, boundaries, threats, mitigations, and residual risks before connecting the real model.

### Primary assets

- Source code and unreleased intellectual property
- Local secrets and credentials
- Developer machine and network
- Git history and protected branches
- Model API key and spend budget
- Audit integrity and approval identity

### Main threats

- Prompt injection from repository contents
- Secret exfiltration through context or tool output
- Path traversal and symlink escape
- Command injection
- Malicious dependency lifecycle scripts
- Network exfiltration
- Confused-deputy approval flows
- Approval replay or time-of-check/time-of-use changes
- Sandbox escape
- Denial of service and cost exhaustion
- Event tampering or incomplete audit trails
- Duplicate side effects after crash recovery

The project should be candid about residual risk: a local container runtime is a strong boundary for a portfolio system, not a formal proof of containment.

## 20. Test Strategy

### Unit tests

- Lexer/parser spans and error recovery
- Policy type checking, precedence, and traces
- Path normalization and redaction
- Tool input validation
- Reducers and state-transition guards
- Budget calculations
- Approval binding and expiration
- Stream decoding and provider normalization

### Generative tests

Write small generators yourself for:

- Random policy expressions compared against a simple reference evaluator
- Path traversal and Unicode path variants
- Event sequences asserting state-machine invariants
- Tool-call duplication and reordering

### Integration tests

- PostgreSQL append with optimistic concurrency
- Worker claims, leases, and recovery
- Worktree creation and cleanup
- Container resource/network restrictions
- CLI-to-daemon reconnect and cursor resume
- End-to-end fake-model runs

### Security regression tests

Every discovered bypass gets a minimal permanent fixture and an incident note explaining root cause and defense.

## 21. Phased Implementation Roadmap

The schedule assumes roughly 15–20 focused hours per week. Expect 8–12 weeks for the deterministic MVP through Phase 3, approximately 18–24 weeks for the strong CLI portfolio release through Phase 8, and another 4–6 weeks for the editor extension. Full-time work can compress elapsed time, but the acceptance criteria should not be compressed.

### Phase 0 — Specification and threat model (3–4 days)

Build:

- Product brief and non-goals
- Architecture decision records
- Trust-boundary diagram
- Initial threat model
- Event and tool vocabulary
- Three hand-written end-to-end scenarios

Exit criteria:

- Every side effect has an identified enforcement point.
- The demo can be described without mentioning a UI.
- v1 scope excludes multi-agent, remote deployment, and Code-OSS fork work.

### Phase 1 — Core contracts and deterministic vertical slice (1 week)

Build:

- Monorepo and strict TypeScript configuration
- Domain IDs, events, errors, and result types
- In-memory event store
- Reducer-based run state machine
- Scripted fake model
- Three fake tools
- Minimal `guard run` CLI

Exit criteria:

- A deterministic scripted agent reads a fixture, proposes a patch, and completes.
- The full run is represented by events.
- Unit tests replay the history to the same terminal state.

### Phase 2 — Policy language and debugger (1.5–2 weeks)

Build:

- Lexer, parser, AST, type checker, evaluator, formatter
- Allow/deny/approval precedence
- Explanation trace
- Policy test-case format
- `check`, `test`, `explain`, and `simulate` commands

Exit criteria:

- Syntax errors include exact source spans.
- Recorded actions can be reevaluated against two policy versions.
- A deny rule cannot be bypassed by a lower-priority allow.
- The deterministic security suite covers at least 25 policy cases.

### Phase 3 — Context broker and guarded tools (1.5–2 weeks)

Build:

- Canonical path model
- Include/exclude/secret filtering
- Provenance and context budgets
- File listing, search, bounded reading, patch proposal, and diff inspection
- Strict tool registry and input validators

Exit criteria:

- `.env`, traversal, symlink, binary, and oversized-file cases are handled correctly.
- No tool bypasses policy dispatch.
- Every released context item has a source and content hash.

### Phase 4 — Worktrees and process sandbox (2 weeks)

Build:

- Git worktree manager
- Argument-array process runner
- Docker sandbox lifecycle
- Resource, output, network, and timeout limits
- Test-command discovery with policy override
- Cleanup and orphan detection

Exit criteria:

- The original checkout is unchanged after success, failure, and cancellation.
- Network-disabled and process-tree-kill tests pass.
- Deliberate path and symlink escapes fail closed.
- A final patch can be exported and reviewed.

### Phase 5 — Real model adapter and complete agent loop (1 week)

Build:

- Official SDK-backed Responses API provider
- Streaming event normalization and request/response recording
- Custom function-tool translation
- Conversation/context reconstruction
- Token, cost, timeout, and loop budgets
- Provider error classification and retries
- Explicit `store: false` and serialized-tool defaults

Exit criteria:

- The same end-to-end case passes with fake and real providers.
- The provider never receives a denied context item.
- Malformed or unsupported tool calls fail safely.
- Ambiguous model-call failures become recorded new attempts rather than invisible retries.
- API keys never appear in logs, events, sandboxes, or extension state.

### Phase 6 — PostgreSQL, workers, approvals, and recovery (2 weeks)

Build:

- Handwritten migrations and PostgreSQL event store
- Transactional queue, leases, and heartbeats
- Projection rebuilds
- Approval records and one-time consumption
- Crash reconciliation and idempotency handling
- Cancellation and retry policies

Exit criteria:

- Two workers cannot own the same valid lease.
- All injected crash windows recover without duplicated visible effects.
- Approval mutation or replay is rejected.
- A run resumes after daemon restart from its last durable event.

### Phase 7 — Evaluation system and release gates (1.5–2 weeks)

Build:

- Eval file format and runner
- Deterministic, invariant, test, patch, policy, cost, and latency graders
- Baseline/candidate comparison
- Fault scheduler
- Machine-readable and HTML/Markdown reports
- CI regression command

Exit criteria:

- At least 40 deterministic adversarial cases pass.
- A seeded policy regression fails CI with an understandable explanation.
- A seeded crash produces a correct recovery result.
- Real-model reports separate stochastic quality from deterministic safety.

### Phase 8 — CLI hardening and portfolio release (1–1.5 weeks)

Build:

- Complete commands, help, JSONL output, exit codes
- `guard doctor`, cleanup, and export flows
- Sample hostile repository
- Architecture, threat-model, policy, and event documentation
- Installation script/package
- Demo recording and benchmark report

Exit criteria:

- A new user can run the flagship demo from a clean machine using the README.
- Failure messages explain remediation.
- No manual database edits or hidden setup steps are required.
- The demo works without a real model using the fake provider.

### Phase 9 — Local daemon and VS Code extension (4–6 weeks)

Build:

- JSON-RPC daemon protocol and cursor subscriptions
- CLI converted into a daemon client
- VS Code run explorer, approval panel, event trace, and native diff flow
- Extension security hardening and packaging

Exit criteria:

- CLI and extension can observe the same run concurrently.
- Client reconnect resumes from the last event cursor.
- Closing VS Code does not kill a durable run.
- The extension cannot bypass daemon policy enforcement.

### Phase 10 — Optional expansion, one track only

Choose based on the roles being targeted:

- **Enterprise/security:** team identities, signed policy bundles, policy review workflow, PostgreSQL row-level security
- **AI platform:** multiple providers, richer eval datasets, prompt/model rollout gates
- **Distributed systems:** remote workers, artifact storage, partition/failure simulation
- **Developer tools:** MCP adapter, Cursor Agent Client Protocol adapter if still useful, or a narrowly justified Code-OSS fork

Do not start more than one expansion track before the core portfolio release is complete.

## 22. First 20 Implementation Tickets

1. Write `docs/product.md` with v1 non-goals.
2. Write `docs/threat-model.md` with a data-flow diagram.
3. Define branded ID types and canonical error categories.
4. Define versioned event envelopes and the initial event union.
5. Implement the in-memory optimistic-concurrency event store.
6. Implement run-state reducer and illegal-transition tests.
7. Implement scripted fake model and normalized model events.
8. Implement an in-memory tool registry with strict hand-written validators.
9. Implement `list_files`, `read_file`, and `propose_patch` against a virtual fixture filesystem.
10. Implement the smallest `guard run` and event renderer.
11. Define the `.guard` grammar in EBNF.
12. Implement the policy lexer with source spans.
13. Implement parser and formatter round-trip tests.
14. Implement type checking and pure evaluation.
15. Implement decision traces and precedence tests.
16. Add the first ten malicious-action policy fixtures.
17. Implement canonical repository paths and symlink checks.
18. Implement context manifests, hashes, and byte budgets.
19. Add a real-filesystem adapter behind the same tool interfaces.
20. Run the first full fake-model scenario from the CLI.

Do not call the real model before ticket 20 works. Otherwise nondeterminism will hide flaws in the runtime.

## 23. Scope Control

### Required for the portfolio release

- Custom policy language and explainable decisions
- Controlled repository context
- Guarded file, patch, process, test, and Git tools
- Worktree plus container isolation
- Approvals bound to exact actions
- Durable PostgreSQL workflow and crash recovery
- Fake and real model providers
- Adversarial eval suite and regression gate
- Production-quality CLI and documented demo

### Explicitly deferred

- Multi-agent planning
- Browser/computer-use automation
- Remote SaaS control plane
- Kubernetes
- Autonomous Git push or deployment
- Arbitrary MCP server trust
- Windows support
- Mobile/web clients
- Fine-tuning or self-hosted inference
- Code-OSS fork

If schedule pressure appears, cut the VS Code extension before cutting policy explanations, durability, sandbox tests, or evals. Those four systems are the project's differentiator.

## 24. Portfolio Deliverables

Ship more than a repository:

- A two-minute hostile-repository demo
- A seven-to-ten-minute technical walkthrough
- An architecture diagram with trust boundaries
- A concise threat model and residual-risk section
- A policy-language reference with examples
- A crash-recovery animation or timeline
- An eval report comparing permissive and strict policy versions
- A benchmark covering run overhead, context reduction, and recovery time
- One short postmortem for a bypass discovered during development
- Resume bullets grounded in measured results

Possible resume bullet structure:

> Built a policy-enforced coding-agent runtime in TypeScript and PostgreSQL with a custom policy parser, sandboxed tool gateway, event-sourced recovery, and adversarial evaluation suite; blocked secret/path/network attacks and recovered injected worker crashes without duplicate side effects.

Replace the final claims with actual measured counts and rates before publishing.

## 25. Definition of Done

The v1 project is done when all of the following are true:

- A fresh user can install it and complete the flagship demo.
- The fake provider makes every safety and durability test deterministic.
- At least 40 adversarial cases run in CI.
- The real provider completes a curated coding-task suite with recorded cost and latency.
- Denied context never appears in model requests, logs, or artifacts.
- Approval replay and argument mutation are rejected.
- Original repositories remain untouched until the user explicitly applies a patch.
- Injected crashes do not duplicate completed effects.
- Every action can be explained from a pinned policy and event history.
- The README states guarantees and limitations without overstating sandbox security.
- The CLI stands on its own; the editor extension is an additional client.

At that point, this is no longer “an AI wrapper.” It is a compact developer-infrastructure product demonstrating security engineering, distributed systems, backend persistence, applied AI, evaluation, and developer-tool UX in one defensible project.
