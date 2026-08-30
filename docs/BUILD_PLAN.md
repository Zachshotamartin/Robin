# Policy-Enforced Agent Runtime: Full Build Plan

Working title: **Guarded Agent**. The name can change; the architecture should not depend on it.

Companion documents:

- [Critical plan review](./PLAN_REVIEW.md)
- [Deep plan audit and resolution register](./DEEP_AUDIT.md)
- [General multi-agent and multi-model runtime architecture](./GENERAL_RUNTIME_ARCHITECTURE.md)
- [Provider, credential, and external-agent compatibility plan](./PROVIDER_AGENT_COMPATIBILITY.md)
- [Detailed implementation guide](./IMPLEMENTATION_GUIDE.md)
- [Installation, testing, operations, and release plan](./OPERATIONS_TEST_PLAN.md)
- [Product requirements and user flows](./PRODUCT_REQUIREMENTS.md)
- [Threat model](./THREAT_MODEL.md)

## Plan Review Outcome

The architecture is worth building and the combined project is more distinctive than any of its individual source ideas. A critical review produced the following corrections:

1. **Keep the custom work at the product boundary.** Build the policy parser, evaluator, agent state machine, task-profile system, context broker, capability gateway, approvals, event model, workflow recovery, compatibility harness, credential boundary, and eval system. Use official provider SDKs and a mature JSON Schema validator; transport and schema-validation bugs would weaken rather than differentiate the security story.
2. **Ship two meaningful checkpoints.** The deterministic MVP proves the design before PostgreSQL, containers, and a real model are added. The portfolio v1 adds those production systems. Neither checkpoint depends on VS Code.
3. **Serialize consequential actions in v1.** Parallel proposals multiply approval, locking, causality, and replay problems. A provider/agent may stream output, but the runtime accepts and executes at most one consequential action at a time until parallel semantics are deliberately designed.
4. **Treat model calls as costly, non-idempotent external operations.** Persist completed responses and never regenerate them during replay. An ambiguous transport failure may be retried only as a new, explicitly recorded attempt with budget impact.
5. **Default to no provider-side retention while making local replay honest.** Request retention off where supported. A durable run stores its exact agent-visible semantic transcript and any required provider/protocol continuation items as encrypted local artifacts; a metadata-only run explicitly gives up restart resume rather than silently regenerating missing history.
6. **Bind approvals to observed state, not only arguments.** Every pack supplies resource and execution preconditions; coding examples include file hashes, worktree revision, executable resolution, and sandbox facts. A change between approval and execution invalidates the approval.
7. **Use PostgreSQL when it starts earning its cost.** Early reducer and policy milestones use an in-memory event store. PostgreSQL arrives with concurrent workers, leases, and crash recovery rather than blocking the first vertical slice.
8. **Use honest scheduling.** A credible deterministic MVP is about 10–14 part-time weeks. The full durable CLI portfolio release is approximately 24–36 part-time weeks including integration, fault injection, packaging, and contingency. Broad provider/external-agent compatibility adds 8–12 weeks, and the editor client adds another 5–8 weeks. These are effort ranges, not promises; milestone evidence cannot be traded for an artificial date.
9. **Keep one authoritative mutation path.** Trusted host-side Git adapters apply approved patch artifacts and create internal checkpoints. Untrusted tests and builds run in disposable execution snapshots and cannot mutate the authoritative run worktree.

## 1. Product Definition

Build a CLI-first general agent runtime whose defining feature is that a model or external agent never receives guarded context or performs a mediated action without passing through deterministic policy and execution layers. Coding is the first reference task profile and the flagship proof of the architecture.

The product is not another chat wrapper. It is the control plane between an agent, the context it may receive, and the capabilities it may request:

```text
Developer
   |
CLI now / VS Code later
   |
Durable agent runtime
   |---- Task profile ------ Objective, driver, sources, capabilities, outcome
   |---- Context broker ---- Repositories, documents, data, artifacts
   |---- Policy engine ----- Rules and approvals
   |---- Capability gateway  Files, processes, research, domain operations
   |---- Event ledger ------ Audit, replay, recovery
   |---- Eval runner ------- Adversarial scenarios
   |
Model API or external agent
```

The selected agent driver proposes. The runtime decides what the agent may see, which proposed actions may run, where they run, and whether a human must approve them. A direct-model driver is the first implementation, not a privileged special case in the kernel.

### The one-sentence pitch

> A general policy-enforced agent runtime that hosts interchangeable models, external agents, context sources, and capability packs behind explainable authorization, approvals, isolation, durable recovery, and behavioral evaluation.

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

### Agent and model strategy

The runtime hosts an `AgentDriver`; a direct-model driver is one implementation. Other implementations include the deterministic scripted driver, ACP agent driver, MCP-mediated agent bridge, hosted-agent adapter, and sandboxed black-box CLI adapter. Every driver produces the same generic content, action-proposal, usage, outcome, and failure events.

Model APIs sit behind a separate modality-aware provider interface. Start with a fake transport and OpenAI Responses adapter, then prove the boundary with Anthropic, Gemini, a conformant OpenAI-compatible endpoint, and a local no-credential adapter. Tool-calling models receive the strongest action integration. Constrained-schema models may emit a versioned proposal envelope. Unconstrained text-only models are answer/planning-only and cannot trigger consequential actions.

For the first provider, use the official OpenAI JavaScript SDK as a transport dependency while keeping request construction, normalization, budgets, policy enforcement, and the agent loop inside this repository. Set provider storage off by default and disable parallel tool calls in v1. The [general runtime architecture](./GENERAL_RUNTIME_ARCHITECTURE.md) defines model types; the [compatibility plan](./PROVIDER_AGENT_COMPATIBILITY.md) defines adapters and bring-your-own credentials.

### Initial platform scope

- macOS and Linux
- General task profiles with versioned objectives, outcomes, context sources, and capability packs
- Coding reference profile for Git repositories
- Local-corpus research reference profile proving the kernel does not depend on Git
- Docker or Podman available locally
- One developer and one machine
- TypeScript repositories in the polished demo, while keeping file and process tools language-agnostic
- Multiple interchangeable single-agent drivers; no concurrent multi-agent coordination in v1
- No autonomous Git push, deployment, email, or cloud mutation in v1

## 3. What “From Scratch” Means

The goal is to write the differentiating systems yourself without reimplementing infrastructure whose correctness is both security-critical and unrelated to the product thesis.

### Build yourself

- Agent loop and explicit state machine
- Generic task-profile, agent-driver, model-capability, context-source, capability-pack, content-block, and outcome contracts
- Provider-neutral and modality-aware model protocol
- Streaming response and structured-action normalization above provider SDKs and agent protocols
- Policy-language lexer, parser, typed AST, evaluator, precedence rules, and explanation traces
- Context broker and provenance tracking
- Capability-pack registry, schemas, action validation, and generic capability model
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

- Hosted foundation models and existing local inference servers rather than training one
- Git rather than implementing version control
- Docker/Podman and the operating system rather than implementing process isolation
- PostgreSQL and its driver rather than implementing a database
- Standard cryptographic hash functions rather than inventing cryptography
- Node's HTTP, filesystem, process, test, and assertion libraries
- Official provider SDKs as narrow transport dependencies for in-tree adapters
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
| Task-profile registry | Pin objective, driver, model, sources, packs, budgets, outcome, and eval contract | Trusted configuration |
| Agent runtime | Advance the generic run state machine and invoke the selected driver | Trusted control logic |
| Agent driver | Return content, action proposals, and outcome proposals | Untrusted proposer |
| Model provider | Translate model-specific content and structured calls for a direct-model driver | Untrusted external service |
| Context broker and source adapters | Select, bound, transform, redact, and record agent context | Trusted data boundary |
| Policy engine | Return allow, deny, or approval with a trace | Trusted decision point |
| Capability gateway and packs | Validate and dispatch every installed operation | Trusted enforcement point |
| Sandbox manager | Isolate processes and workspaces | Trusted orchestrator |
| Event store | Persist the canonical history | Trusted record |
| Eval runner | Execute scenarios and calculate release metrics | Trusted verifier |
| Source content | Repositories, documents, datasets, pages, outputs, and possible attacks | Untrusted input |

### Non-negotiable invariants

1. An agent driver cannot call a guarded capability adapter directly.
2. A capability handler cannot run until its normalized action has a recorded policy decision.
3. Approval is bound to the exact operation, normalized input, policy version, request hash, and live preconditions.
4. A denied resource cannot be smuggled through another operation's output.
5. Profile-specific authoritative resources are not directly writable by an untrusted agent process.
6. Every externally visible state transition is represented by an append-only event.
7. Replaying events never repeats side effects.
8. Capability output is bounded before it is persisted or sent to an agent or model.
9. Source instructions are treated as data, not as trusted system instructions.
10. A completed run has an outcome matching the pinned task profile plus an audit trace.

## 5. Technology Choices

- **Language:** TypeScript on Node.js 22+
- **Workspace:** npm workspaces, with strict TypeScript project references
- **Persistence:** PostgreSQL 17 with handwritten SQL migrations and queries
- **Local transport:** JSON-RPC 2.0 over a Unix domain socket; Windows named pipes later
- **Agent drivers:** direct-model, scripted, ACP, MCP-mediated, hosted-agent, and contained CLI ports
- **Model transport:** official provider SDKs behind the modality-aware provider interface
- **Boundary validation:** JSON Schema with Ajv in strict mode; schemas remain owned and versioned here
- **Isolation:** Docker first, Podman adapter second
- **Reference capabilities:** Git and process adapters for coding; local document source for research
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
    contracts/          # generic IDs, content, actions, outcomes, schemas
    event-store/        # append, subscribe, projections, migrations
    artifact-store/     # content-addressed objects, references, retention
    runtime/            # run state machine and orchestration
    profile-registry/   # immutable task-profile validation and loading
    agent-driver/       # generic planning-driver interface and events
    driver-scripted/    # deterministic scripted agent
    model-provider/     # modality-aware provider interface
    adapter-openai/     # Responses API adapter
    adapter-anthropic/  # Messages API adapter
    adapter-gemini/     # Gemini adapter
    credentials/        # key references, OS store, origin-bound injection
    policy-language/    # lexer, parser, AST, formatter
    policy-engine/      # evaluator, trace, impact simulation
    context-broker/     # source registry, budgets, redaction, provenance
    capability-gateway/ # pack registry, validation, dispatch, idempotency
    capability-repository/ # coding reads, search, patch, Git checkpoint
    capability-process/ # contained process recipes
    capability-research/# local document corpus and citations
    sandbox/            # container profiles and lifecycle
    worktree/           # disposable Git worktree management
    approvals/          # approval tokens and expiry
    eval-engine/        # cases, graders, metrics, regression gates
    json-rpc/           # daemon/client protocol
    adapter-acp/        # external ACP agent driver
    bridge-mcp/         # run-scoped guarded MCP tools
  policies/
    default.guard
    strict.guard
  fixtures/
    safe-repo/
    hostile-repo/
    crash-recovery-repo/
    research-corpus/
  migrations/
  docs/
    BUILD_PLAN.md and companion planning documents   # already present
    policy-language.md  # user reference, written with Phase 2
    event-model.md      # user reference, written with Phase 1
    demo-script.md      # written with Phase 8
    decisions/          # architecture decision records
  package.json
  tsconfig.base.json
```

Keep package boundaries real: each package exposes a narrow public API and cannot import another package's internals.

## 7. Core Contracts

The first implementation should establish small stable interfaces before any real model calls are made.

```ts
interface AgentDriver {
  advance(request: AgentTurnRequest): AsyncIterable<AgentDriverEvent>;
}

interface ModelProvider {
  respond(request: SemanticModelRequest): AsyncIterable<NormalizedProviderEvent>;
}

interface PolicyEngine {
  evaluate(request: ActionRequest, snapshot: PolicySnapshot): PolicyDecision;
}

interface CapabilityOperation<TInput, TOutput> {
  definition: CapabilityOperationDefinition<TInput>;
  normalize(input: unknown, context: NormalizationContext): NormalizedAction;
  execute(context: CapabilityContext, action: NormalizedAction): Promise<CapabilityResult<TOutput>>;
}

interface EventStore {
  append(streamId: string, expectedVersion: number, events: NewEvent[]): Promise<EventEnvelope[]>;
  read(streamId: string, afterVersion?: number): AsyncIterable<EventEnvelope>;
}
```

Important IDs should be distinct types rather than interchangeable strings: `RunId`, `AgentAttemptId`, `ActionId`, `ApprovalId`, `PolicyVersion`, `ArtifactId`, and `IdempotencyKey`. Coding packs may additionally define `CheckpointId` and Git-specific IDs without leaking them into the kernel.

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
  when action.pack == "repository"
    and action.operation == "read_file"
    and repo.path matches "**/.env*"
  deny
  reason "Secret files cannot enter model context"
}

policy "approve-dependencies" priority 70 {
  when action.pack == "process"
    and process.executable in ["npm", "pnpm", "yarn"]
    and request.intent == "install_dependency"
  require_approval
  reason "Dependency installation can execute third-party lifecycle scripts"
}

policy "tests-in-sandbox" priority 50 {
  when action.pack == "process"
    and action.operation == "run_tests"
    and environment.sandboxed == true
  allow
  reason "Pinned test recipes may run inside the selected sandbox profile"
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

- Every clause evaluates to `true`, `false`, or `unknown`. Missing optional attributes produce `unknown`; negating `unknown` remains `unknown`; only a complete `true` expression matches.
- Use `exists(attribute)` to test presence. Do not infer presence with negated comparisons.
- `matches` means an anchored path glob compiled at policy-load time over canonical forward-slash paths. It accepts catalogued canonical-path `string` and `list<string>` targets. Lists use existential any-match semantics; empty is false and an absent optional list is unknown. Runtime regular expressions are not part of v1.
- Any matching `deny` wins, regardless of priority.
- Otherwise, any matching `require_approval` wins.
- Otherwise, a matching `allow` permits the action.
- Priority selects the dominant explanation and trace ordering within the winning effect; it never lets an allow override a deny.
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
  -> waiting_for_agent
  -> evaluating_action
  -> waiting_for_approval
  -> executing_action
  -> recording_observation
  -> waiting_for_agent
  -> completed

Any active state may enter cancellation_requested, then cancelled after active work stops.
Recoverable process loss enters recovering.
An ambiguous external driver/provider attempt enters attempt_result_uncertain with the attempt kind and transmission evidence.
An operator or resumability boundary may enter paused.
An effect that cannot yet be reconciled enters orphaned and requires inspection.
failed, cancelled, completed, and orphaned are terminal for automatic execution.
```

The runtime should be a reducer: current state plus event produces next state and commands. Commands cause side effects; results return as new events. This separation makes recovery and unit testing possible.

The implementation guide owns the legal-transition table. An unknown state or transition fails closed. A recoverable policy denial becomes a bounded agent observation so the driver may propose a safer action; repeated denials consume a configured denial budget. Protocol violations, invariant failures, and denial-budget exhaustion terminate the run.

### Per-turn loop

1. Load run history and projection.
2. Ask the context broker for an allowed, budgeted context package.
3. Record the exact context manifest and hashes.
4. Advance the selected driver with the objective, released context, prior agent-visible observations, and currently advertised operation definitions.
5. Normalize streamed content, structured action proposals, usage, and outcome proposals.
6. Reject malformed, unsupported, or unknown proposals before policy evaluation.
7. Evaluate the action against a pinned policy snapshot.
8. Deny, request approval, or execute it.
9. Record and release a bounded capability result as an observation.
10. Repeat until the driver proposes a schema-valid outcome or a hard budget is reached.

Set parallel model tool calls off in v1. If a provider still returns more than one proposed call, record the protocol violation and fail closed rather than inventing an execution order.

### Hard budgets

- Maximum turns
- Maximum proposed and executed capability actions
- Maximum wall-clock time
- Maximum input/output tokens
- Maximum estimated agent/provider cost
- Maximum process runtime
- Maximum bytes per capability output and per run
- Maximum consecutive identical or equivalent actions

Budget exhaustion is a first-class terminal event, not an uncaught exception.

## 10. Context Broker

The context broker is the read side of the security boundary. It should prevent “the agent/model saw it, so the damage was already done.”

### Responsibilities

- Resolve each generic `ResourceRef` through its installed source adapter; coding adapters canonicalize paths and resolve symlinks
- Enforce source/profile include, exclusion, classification, and secret policies before reading
- Refuse unsupported media and oversized resources by default
- Detect likely secrets and redact or deny according to policy
- Track byte and token estimates
- Attach provenance: source, resource locator, range/selector, content hash, requesting action, transformation, and policy version
- Delimit all source content as untrusted data
- Deduplicate unchanged context
- Apply a per-turn and per-run context budget
- Record what was withheld and why without logging the secret itself

### Initial coding context operations

- `list_files(root, glob, max_results)`
- `search_text(query, paths, max_matches)`
- `read_file(path, start_line, end_line)`
- `read_symbols(path)` after a simple TypeScript symbol extractor exists
- `inspect_manifest()` for recognized dependency manifests

Do not upload the entire repository or use unrestricted hosted file search in v1. Context enters the model only through these controlled paths.

## 11. Capability Gateway and Coding Operations

### Initial coding operation set

| Operation | Default effect | Notes |
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

### Operation contract rules

- Strict input schema with unknown properties rejected
- Normalized arguments are the only arguments policy evaluates or execution receives
- Semantic normalization is provider-byte-free: it may validate canonical
  locators, strict structure, and bounds, but provider existence, ranges,
  source hashes, and preimages are checked only by an authorized handler
- Coding paths are repository-relative in model/agent protocols and canonical internally; other packs own equally strict resource normalization
- Processes use `executable` plus `argv`; avoid `sh -c`
- Every call receives a deterministic idempotency key
- Output has separate raw-trusted, human, agent, and audit representations
- Stdout and stderr are truncated with hashes and artifact references
- Operations declare pack/version, side-effect class, required authority, timeout, cancellation, idempotency, reconciliation, output release, and compensability
- No operation can invoke another operation without returning through the gateway

## 12. Sandbox and Git Isolation

### Run workspace

1. Verify a clean or explicitly acknowledged repository state.
2. Create a detached Git worktree in a run-specific owner-only directory; do not create an ordinary branch.
3. Treat the worktree as an authoritative workspace reachable only by trusted Git and patch adapters.
4. After each accepted write, create an internal no-hook checkpoint commit with a controlled identity and record its tree and manifest.
5. Give untrusted tests and builds a disposable copy or overlay of the latest checkpoint, not a writable mount of the authoritative worktree.
6. Discard process-created source mutations and import only declared, bounded, policy-checked artifacts.
7. Preserve the user's original checkout untouched.
8. Export the final diff from the pinned base commit to the final checkpoint; applying it to the user's branch is a separate human action.

### Container profile

- Non-root UID/GID
- Read-only root filesystem
- Writable disposable execution snapshot plus bounded `tmpfs`; authoritative worktree is not mounted
- Network disabled by default
- CPU, memory, PID, file-size, and wall-time limits
- No host Docker socket
- No SSH agent, cloud/provider/external-agent credentials, credential-store handle, or auth token inside the container
- Minimal environment-variable allowlist
- Process-group termination on timeout or cancellation
- Captured and bounded stdout/stderr
- No writable live Git common directory, repository-controlled hooks, filters, text conversion, or external diff helper

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

### Canonical generic events

```text
RunCreated
RunStarted
RunIntentAppended
TaskProfilePinned
AgentDriverStarted
AgentAttemptStarted
AgentAttemptUncertain
ContextRequested
ContextReleased
ContextDenied
ContextRedacted
AgentContentCompleted
AgentUsageRecorded
ActionProposed
ActionNormalized
PolicyEvaluated
ActionDenied
ApprovalRequested
ApprovalGranted
ApprovalDenied
ActionStarted
ActionSucceeded
ActionFailed
ActionReconciled
ObservationReleased
RetryScheduled
BudgetExceeded
OutcomeProposed
OutcomeValidated
ArtifactReferenced
RunCancelled
RunFailed
RunOrphaned
RunCompleted
```

The authoritative event union also includes `CancellationRequested`, `RunPaused`, `RunResumed`, `RecoveryStarted`, `RecoveryCompleted`, `AgentAttemptFailed`, `ApprovalExpired`, `ApprovalInvalidated`, and `ApprovalConsumed`. Driver- or capability-specific facts use namespaced typed payloads, such as `provider.ModelRequestStarted`, `provider.ModelResponseCompleted`, `provider.ModelRequestUncertain`, `coding.WorkspaceCheckpointCreated`, and `coding.PatchProduced`. They may extend the ledger but cannot replace the generic facts required by the reducer. Lease claims and heartbeats remain command-table mechanics and operational telemetry unless they change business-visible run state.

Each event includes stream ID, sequence number, event ID, timestamp, causation ID, correlation ID, actor, schema version, and payload.

### Storage tables

- `event_streams`
- `events`
- `commands`, including lease, generation, and reconciliation fields
- `task_profile_versions`
- `credential_references`, containing metadata and OS-store references but never secret bytes
- `policy_versions`
- `approval_requests`
- `artifact_objects`
- `artifact_references`
- `driver_transcript_items`, with optional namespaced provider/protocol fields
- `client_requests`
- `eval_suites`
- `eval_cases`
- `eval_results`

The `events` table is canonical. Read models such as run status, pending approvals, tool counts, and cost are projections that can be rebuilt.

### Delivery semantics

Claim jobs transactionally with leases and heartbeats. Promise at-least-once command delivery, not exactly once. Prevent duplicated effects with idempotency records and tool-specific reconciliation.

Example: if the worker crashes after applying a patch but before recording success, recovery compares the expected pre-action checkpoint, exact patch artifact, changed-path manifest, and resulting tree. It either records recovered success for the existing postimage, safely reapplies from the unchanged preimage, or enters `orphaned` when neither state is provable.

Model requests require different recovery behavior. Once a completed provider response has been recorded, replay reuses it. If the connection fails after the request may have reached the provider but before a response is recorded, mark the attempt uncertain. A retry creates a new attempt event, consumes budget again, and is never described as an idempotent replay.

### Tamper evidence

Optionally hash-chain event envelopes with a standard hash function. Describe this as tamper-evident, not tamper-proof; an attacker controlling the database and the signing/hashing environment can replace the whole chain.

## 14. Approvals

An approval is an authorization artifact, not a chat message.

It must bind:

- Capability pack/operation version and normalized action hash
- Run and action IDs
- Policy version and matched rule
- Workspace and Git revision
- Relevant input-file hashes, resolved executable, and sandbox profile
- Human identity
- Creation and expiry times
- One-time use state

If any bound value or execution precondition changes, request approval again. Approvals expire, cannot be replayed across runs, and are consumed transactionally with the action-start event.

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
guard profiles list
guard profiles inspect <profile-id>
guard profiles validate <profile-id>
guard credentials add|list|inspect|validate|rotate|remove ...
guard providers add|list|doctor ...
guard agents register|list|doctor ...
guard run --profile coding-local --provider <provider-profile> --objective-file <file>
guard run --profile research-local-corpus --provider <provider-profile> --objective-file <file>
guard run --profile <profile> --agent <agent-profile> --objective-file <file>
guard run --profile synthetic-demo --objective-file <file>
guard run message <run-id> "<follow-up intent>"
guard daemon start --foreground
guard status <run-id>
guard inspect <run-id>
guard approve <approval-id>
guard deny <approval-id> --reason "..."
guard diff <run-id>
guard replay <run-id>
guard cancel <run-id>
guard policy check policies/default.guard
guard policy test
guard policy explain <action-id>
guard policy simulate --from <version> --to <file>
guard eval run evals/security.json
guard eval compare <baseline> <candidate>
```

The profile decides whether `--provider`, `--agent`, or neither is legal. `guard run "<objective text>"` is accepted shorthand for an inline objective payload validated against the selected profile's objective schema; `--objective-file` remains the canonical form for structured objectives. `guard daemon start` arrives with the Phase 6 minimal daemon, and `guard run message` implements `FR-CLI-005`. Secret bytes are accepted only by credential commands through hidden input, stdin, or a deliberate one-time environment import; they are never accepted by `guard run`, profile files, provider files, or agent registration arguments.

### Output modes

- Human-readable streaming terminal output
- `--jsonl` stable event stream for automation
- `--quiet` final result only
- Predictable exit codes for success, invalid input, policy denial, approval required, budget exceeded, task failure, infrastructure failure, and cancellation

The CLI renderer consumes domain events. It must not contain enforcement logic.

## 16. Local Daemon

The daemon becomes the single owner of workers, database connections, sandboxes, and active runs. A minimal headless daemon is introduced with PostgreSQL durability in Phase 6 so restart recovery can be tested honestly; Phase 10 hardens the multi-client protocol and adds VS Code.

- JSON-RPC 2.0 over a permission-restricted Unix socket
- OS advisory lock held for daemon lifetime and peer-credential verification where supported
- Explicit protocol version and capability negotiation
- Clients subscribe from an event cursor through bounded server notifications and can reconnect without losing committed events
- Mutating requests carry client-generated idempotency keys stored with caller, method, canonical request hash, result, and expiry
- Artifacts transfer through bounded chunks with byte cursors and final hash checks, never an undefined raw stream inside JSON framing
- Local authentication uses socket permissions first; add a short-lived session token if TCP transport is ever introduced
- The API supports CLI and VS Code without exposing provider secrets to either client

Start with an in-process runtime for early milestones. Extract the minimal `guardd` when PostgreSQL commands and leases arrive; retain in-process adapters for deterministic tests.

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

- No provider or external-agent credential stored in extension state
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

Use `ScriptedAgentDriver` and a `SyntheticModelProvider` to force exact adversarial behavior at both abstraction layers:

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
- Provider/external-agent credentials and spend budget
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

The schedule assumes roughly 15–20 focused hours per week. Expect 10–14 weeks for the deterministic MVP through Phase 3 and approximately 24–36 weeks for the strong durable CLI portfolio release through Phase 8. Broad provider and external-agent compatibility in Phase 9 adds roughly 8–12 weeks; the editor client in Phase 10 adds another 5–8 weeks. The full plan is therefore approximately 37–56 part-time weeks before optional expansion. The ranges include integration and hardening but not a major redesign after implementation evidence. Full-time work can compress elapsed time, but the acceptance criteria should not be compressed.

### Phase 0 — Specification and threat model (1 week)

Build:

- Product brief and non-goals
- Architecture decision records
- Trust-boundary diagram
- Initial threat model
- Generic task-profile, event, action, observation, and outcome vocabulary
- Three hand-written end-to-end scenarios

Exit criteria:

- Every side effect has an identified enforcement point.
- The demo can be described without mentioning a UI.
- v1 scope excludes concurrent multi-agent coordination, remote deployment, and Code-OSS fork work.

### Phase 1 — Core contracts and deterministic vertical slice (2–3 weeks)

Build:

- Monorepo and strict TypeScript configuration
- Generic task-profile, objective, resource, content-block, action, observation, outcome, event, error, and result types
- In-memory event store
- Reducer-based run state machine
- Scripted agent driver plus synthetic model provider
- Generic capability registry plus three fake operations
- Minimal `guard run` CLI

Exit criteria:

- A deterministic scripted agent uses a synthetic profile, proposes an action and typed outcome, and completes without Git- or model-specific kernel code.
- The full run is represented by events.
- Unit tests replay the history to the same terminal state.

### Phase 2 — Policy language and debugger (3–4 weeks)

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

### Phase 3 — Generic context broker and coding capability pack (4–5 weeks)

Build:

- Context-source and capability-pack registries
- Generic resource, provenance, release-policy, and context-budget pipeline
- Coding source adapter with canonical repository paths and include/exclude/secret filtering
- Coding operations for file listing, search, bounded reading, patch proposal, and diff inspection
- Exact bounded authorization metadata for every canonical multi-path input
  before the repository provider opens, evaluated through `guard.repo` v3
  `repo.input_paths`; and exact bounded release metadata for every canonical
  path identifier actually emitted, unique, UTF-8 ordered, set-equal to the
  emitted identifiers, and evaluated through output-only `repo.paths`
- Byte-free repository semantic normalization; existence, range, source-hash,
  and diff-preimage validation occurs only in the authorized handler
- Strict operation schemas, semantic normalizers, and output classifiers

Exit criteria:

- `.env`, traversal, symlink, binary, and oversized-file cases are handled correctly.
- No capability operation bypasses policy dispatch.
- Every released context item has a source and content hash.
- A non-repository in-memory source passes the same generic release pipeline.

### Phase 4 — Worktrees and process sandbox (3–4 weeks)

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

### Phase 5 — Direct-model driver, credentials, and first real provider (3–4 weeks)

Build:

- Direct-model `AgentDriver` using the generic driver protocol
- Credential metadata store, OS credential-store references, origin-bound transport, and redacted diagnostics
- `guard credentials add|list|inspect|validate|rotate|remove` commands with hidden-input and `add --from-env` one-time environment import
- Official SDK-backed OpenAI Responses provider adapter
- Local no-credential provider adapter behind the same provider port, satisfying the portfolio-release local no-key path
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
- Credential bytes never appear in logs, events, sandboxes, agent/model context, clients, or extension state.
- The same scripted run works against the synthetic provider, the local no-credential adapter, and the real provider without changing runtime code.

### Phase 6 — PostgreSQL, minimal daemon, approvals, and recovery (5–7 weeks)

Build:

- Handwritten migrations and PostgreSQL event store
- Minimal foreground `guardd` owning database connections and workers
- Transactional queue, leases, and heartbeats
- Projection rebuilds
- Approval records and one-time consumption
- Crash reconciliation and idempotency handling
- Cancellation and retry policies
- Encrypted durable transcript storage and metadata-only non-resumable behavior

Exit criteria:

- Two workers cannot own the same valid lease.
- All injected crash windows recover without duplicated visible effects.
- Approval mutation or replay is rejected.
- A durable-encrypted run resumes after daemon restart from its exact recorded transcript and last accepted checkpoint.
- A metadata-only run that lost its owning process terminates with an explicit non-resumable result.

### Phase 7 — Evaluation system, research profile, and release gates (3–4 weeks)

Build:

- Eval file format and runner
- Deterministic, invariant, test, patch, policy, cost, and latency graders
- Baseline/candidate comparison
- Fault scheduler
- Machine-readable and HTML/Markdown reports
- CI regression command
- Local-corpus research source, search/read operations, citation outcome, and research eval fixtures

Exit criteria:

- At least 40 deterministic adversarial cases pass.
- A seeded policy regression fails CI with an understandable explanation.
- A seeded crash produces a correct recovery result.
- Real-model reports separate stochastic quality from deterministic safety.
- The research profile completes without a repository, Git worktree, patch, or process capability and proves the kernel is not coding-specific.

### Phase 8 — CLI hardening and portfolio release (2–3 weeks)

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
- The demo works without a real model using the scripted driver and synthetic provider.

### Phase 9 — Multi-provider and external-agent compatibility (8–12 weeks)

Build:

- Completed management surfaces for `guard providers`, `guard agents`, and `guard profiles`, extending the `guard credentials` commands shipped in Phase 5
- Anthropic, Gemini, and conformant OpenAI-compatible provider adapters, plus full conformance coverage for the Phase 5 local no-credential path
- Tool-calling, constrained-schema, text-only planning, and supported multimodal content paths
- Provider conformance corpus, golden transcript fixtures, capability negotiation, cost metadata, and failure classification
- ACP agent driver with every filesystem and terminal operation mapped through guarded capabilities
- Run-scoped stdio MCP bridge whose annotations are treated as untrusted hints
- Containment-only CLI agent adapter with filtered snapshot, disabled credentials, and candidate-output import
- Compatibility-tier display, audit evidence, BYOK rotation/removal, and adapter SDK documentation

Exit criteria:

- The same policy and scripted action scenario passes against every direct provider adapter without kernel changes.
- At least one hosted provider, one different hosted provider family, and one local no-key endpoint complete the conformance suite.
- Tool-calling, schema-only, and text-only models receive only the operations their manifest safely supports.
- ACP and MCP-mediated actions cannot bypass context, policy, approval, capability, sandbox, or output-release boundaries.
- Black-box CLI runs are labeled containment-only and never claim exact context or per-action mediation.
- Credential references are selectable per run; secret bytes are strategy/origin-bound, absent from agent/model context and child processes, rotatable, removable, and covered by leak canaries.
- The compatibility matrix and residual limitations are exported with each run.

### Phase 10 — Multi-client daemon hardening and VS Code extension (5–8 weeks)

Build:

- Peer-authenticated JSON-RPC protocol, bounded notifications, artifact chunks, and cursor subscriptions
- CLI converted into a daemon client
- VS Code run explorer, approval panel, event trace, and native diff flow
- Extension security hardening and packaging

Exit criteria:

- CLI and extension can observe the same run concurrently.
- Client reconnect resumes from the last event cursor.
- Closing VS Code does not kill a durable run.
- The extension cannot bypass daemon policy enforcement.

### Phase 11 — Optional expansion, one track only

Choose based on the roles being targeted:

- **Enterprise/security:** team identities, signed policy bundles, policy review workflow, PostgreSQL row-level security
- **AI platform:** hosted fleet management, richer eval datasets, prompt/model rollout gates
- **Distributed systems:** remote workers, artifact storage, partition/failure simulation
- **Developer tools:** additional reviewed agent protocols or a narrowly justified Code-OSS fork

Do not start more than one expansion track before the core portfolio release is complete.

## 22. First 20 Implementation Tickets

1. Keep `docs/PRODUCT_REQUIREMENTS.md` current with v1 non-goals (initial version complete; revisit at each phase boundary).
2. Keep `docs/THREAT_MODEL.md` current, including data flows and trust boundaries (initial version complete; review on its stated cadence).
3. Define branded ID types and canonical error categories.
4. Define versioned event envelopes and the initial event union.
5. Implement the in-memory optimistic-concurrency event store.
6. Implement run-state reducer and illegal-transition tests.
7. Implement a scripted `AgentDriver`, synthetic `ModelProvider`, and normalized driver/provider events.
8. Implement an in-memory capability-pack registry with versioned JSON Schemas compiled by Ajv strict mode and separate handwritten semantic normalizers.
9. Implement one synthetic non-coding operation plus coding `list_files`, `read_file`, and `propose_patch` against virtual fixture sources.
10. Implement the smallest `guard run` and event renderer.
11. Define the `.guard` grammar in EBNF.
12. Implement the policy lexer with source spans.
13. Implement parser and formatter round-trip tests.
14. Implement type checking and pure evaluation.
15. Implement decision traces and precedence tests.
16. Add the first ten malicious-action policy fixtures across generic, coding, and context-release attributes.
17. Implement canonical repository paths and symlink checks.
18. Implement context manifests, hashes, and byte budgets.
19. Add a real-filesystem source/capability adapter behind the same generic interfaces.
20. Run the first full scripted-driver scenario from the CLI without a provider credential.

Do not call a real model or external agent before ticket 20 works. Otherwise nondeterminism and protocol behavior will hide flaws in the runtime.

## 23. Scope Control

### Required for the portfolio release

- Generic task-profile, agent-driver, model-provider, context-source, capability-pack, content-block, and outcome contracts
- Custom policy language and explainable decisions
- Generic controlled context release plus coding and local-corpus research reference profiles
- Guarded file, patch, process, test, Git, document-search, document-read, and citation operations
- Worktree plus container isolation
- Approvals bound to exact actions
- Durable PostgreSQL workflow and crash recovery
- Scripted driver, synthetic provider, BYOK credential broker, OpenAI provider, and local no-key provider path
- Adversarial eval suite and regression gate
- Production-quality CLI and documented demo

### Required for the broad compatibility release

- Anthropic, Gemini, and conformant OpenAI-compatible provider adapters
- Capability negotiation for tool-calling, schema-output, text-only, and supported multimodal models
- ACP-mediated external agent, run-scoped MCP bridge, and containment-only CLI agent
- Conformance corpus, compatibility tiers, credential rotation/removal, and cross-adapter evals

### Explicitly deferred

- Concurrent multi-agent coordination and delegation
- Browser/computer-use automation
- Remote SaaS control plane
- Kubernetes
- Autonomous Git push or deployment
- Arbitrary or repository-supplied MCP server trust
- Windows support
- Mobile/web clients
- Training, fine-tuning, or implementing a model server; reviewed local inference endpoints remain supported adapters
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

> Built a policy-enforced agent runtime in TypeScript and PostgreSQL with interchangeable hosted/local model and external-agent adapters, generic capability packs, a custom policy parser, sandboxed execution, event-sourced recovery, and adversarial evaluation; demonstrated coding and research profiles while blocking measured secret/path/network attacks and recovering injected crashes without duplicate side effects.

Replace the final claims with actual measured counts and rates before publishing.

## 25. Definition of Done

The v1 project is done when all of the following are true:

- A fresh user can install it and complete the flagship demo.
- The scripted driver and synthetic provider make every safety and durability test deterministic without an API key.
- At least 40 adversarial cases run in CI.
- The coding profile and local-corpus research profile both complete through the same generic kernel.
- At least one real hosted provider and one local no-key provider complete curated suites with recorded cost and latency where applicable.
- Denied context never appears in agent/model requests, logs, or artifacts.
- Approval replay and argument mutation are rejected.
- Profile-owned authoritative resources remain protected; original repositories remain untouched until the user explicitly applies a patch.
- Injected crashes do not duplicate completed effects.
- Every action can be explained from a pinned policy and event history.
- The README states guarantees and limitations without overstating sandbox security.
- The broad compatibility release passes the provider/agent conformance matrix and truthfully labels guarantee tiers.
- Transport-owned credentials are origin-bound, never enter agent context or capability sandboxes, and pass leak-canary, rotation, and removal tests; any credential intentionally delivered to an external agent is confined to that pinned agent sandbox, explicitly disclosed, and lowers the applicable credential-confinement claim.
- The CLI stands on its own; the editor extension is an additional client.

At that point, this is no longer “an AI wrapper.” It is a compact developer-infrastructure product demonstrating security engineering, distributed systems, backend persistence, applied AI, evaluation, and developer-tool UX in one defensible project.
