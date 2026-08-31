# Robin Coding-Agent CLI: Exhaustive Build Plan

Document status: normative implementation plan for the Robin product pivot.

Last revised: 2026-08-30.

Companion specifications:

- [Product requirements and user flows](./PRODUCT_REQUIREMENTS.md)
- [Robin coding-agent product decision](./decisions/ADR-0007-robin-coding-agent-product-pivot.md)
- [Robin CLI architecture](./ROBIN_CLI_ARCHITECTURE.md)
- [Threat model](./THREAT_MODEL.md)
- [Provider and agent compatibility](./PROVIDER_AGENT_COMPATIBILITY.md)
- [Installation, testing, operations, and release](./OPERATIONS_TEST_PLAN.md)
- [Internal runtime architecture](./GENERAL_RUNTIME_ARCHITECTURE.md)
- [Implementation guide](./IMPLEMENTATION_GUIDE.md)

This plan replaces the runtime-first build order. Robin is a coding agent that a
developer uses from a terminal. Its policy engine, event kernel, context broker,
capability gateway, sandbox adapters, and future durable supervisor are internal
systems that support that product. They are not a substitute for the interactive
coding workflow and do not advance ahead of a user-visible slice unless that
slice depends on them.

## 1. How to Read and Enforce This Plan

### 1.1 Status vocabulary

Every deliverable has one of four statuses:

- **accepted**: implemented on the mainline baseline and backed by its named
  automated gate;
- **in progress**: present only on the Robin pivot branch and not a release
  claim until its phase gate passes;
- **planned**: specified here but not implemented;
- **deferred**: intentionally outside the named phase and forbidden from being
  used to claim that phase complete.

A package, type, command stub, or happy-path unit test is not completion. A phase
is accepted only when its user flow, failure behavior, persistence implications,
permission behavior, documentation, installation impact, and acceptance evidence
all pass together.

### 1.2 Product gates and release names

The phase labels are dependency gates, not marketing versions. Their names are
retained for trace stability; the dependency graph, not numeric sorting, is
authoritative. In particular, the post-1.0 decision makes R10 a prerequisite of
R9 even though the historical label is numerically lower:

| Gate | Product evidence unlocked |
| --- | --- |
| R0 | Repository and executable identify as Robin without breaking the accepted substrate. |
| R1 | A developer can converse with a deterministic coding-agent loop in a terminal. |
| R2 | The deterministic agent can inspect, edit, execute, verify, and review a real repository. |
| R3 | The same work survives exit and resume with bounded, inspectable context. |
| R4 | The first end-to-end hosted-provider alpha works through BYOK without changing tool semantics. |
| R5 | Permissions and a supported command sandbox protect real coding actions. |
| R6 | Robin supports the safe daily Git workflow through commit preparation and optional PR creation. |
| R7 | Multiple provider families and the stable headless automation contract pass one conformance gate. |
| R8 | Instructions, configuration, skills, hooks, and MCP complete the first supported developer-release bundle without bypassing trust boundaries. |
| R9 | After 1.0, subagents, isolated worktrees, and supervised background sessions become usable and recoverable. |
| R10 | Distribution, migrations, diagnostics, evals, and release operations satisfy the Robin 1.0 evidence gate. |
| R11 | A stable client protocol and measured editor prototype support an editor-client decision. |
| R12 | The selected editor client ships without a second engine; a Code-OSS fork remains evidence-gated. |

The raw/flat-terminal, ephemeral R1 implementation is **accepted** on `main` at
merge commit `fb64cf1`. The checked-in physical-workspace implementation on
`codex/robin-r2-real-tool-loop` is an **R2 candidate**, not an accepted R2 gate
or supported release. It uses only the deterministic `synthetic-r2-v1` fixture
model; approved host processes are explicitly unsandboxed. R4 is only the first
end-to-end hosted-provider alpha. R7 freezes the provider and automation
contracts, but neither that stable R7 contract nor a supported release exists
today. The first supported developer release is bundled only after R8; Robin
1.0 is R10. R9 is exclusively post-1.0 work, as are the R11 and R12 client
phases. No R9 command, background guarantee, subagent, or worktree feature may
enter the R8 bundle or the R10 1.0 claim.

### 1.3 Sequencing rules

1. Write the failing deterministic test before implementation for every parser,
   reducer, boundary, state transition, migration, and error category.
2. Complete the thinnest user-visible vertical slice before broadening an
   internal subsystem.
3. Keep one direct-model loop for interactive, print, JSON, editor, and future
   daemon clients.
4. Keep one tool registry, permission decision path, and normalized application
   event stream across every client.
5. Never use a real provider to prove deterministic behavior that a synthetic
   provider can prove.
6. Never treat a provider SDK object, MCP object, terminal escape sequence,
   repository byte sequence, hook result, or stored event as trusted without a
   bounded parser at the owning boundary.
7. Preserve the user's checkout and pre-existing changes. No implementation
   ticket authorizes a reset, clean, checkout-overwrite, force push, or history
   rewrite.
8. Keep release claims no stronger than the measured backend, model capability,
   credential strategy, and platform support.
9. Land schema and migration changes with old-version fixtures and downgrade or
   rollback behavior before deleting compatibility code.
10. Do not begin a Code-OSS fork while the CLI engine or local client protocol is
    unstable.

## 2. Current Baseline: What Is and Is Not Built

### 2.1 Accepted Milestone A substrate

Milestone A is accepted only as deterministic internal substrate. The accepted
mainline includes:

- `packages/contracts`: branded identifiers, canonical JSON, boundary parsers,
  content/action/event contracts, and stable domain-error categories;
- `packages/schema-validation`: trusted JSON Schema compilation and bounded
  boundary validation;
- `packages/profile-registry`: immutable profile validation and lookup;
- `packages/event-store`: an in-memory optimistic-concurrency event store;
- `packages/agent-driver`: an agent-driver contract and scripted driver;
- `packages/model-provider`: a provider-neutral contract and synthetic model;
- `packages/capability-gateway` and `packages/capability-synthetic`: operation
  registration, schema validation, normalization, policy handoff, dispatch, and
  deterministic fake effects;
- `packages/runtime` and `packages/runtime-host`: reducer-oriented run behavior
  and in-process composition;
- `packages/milestone-a-scenarios`: provider-free deterministic histories;
- `apps/cli`: a fixture-oriented command surface and renderer.

The evidence is the repository, contracts, Gate A, and replay test suites at the
mainline baseline. These components are useful foundations for Robin's loop and
tool boundary. They do **not** provide an interactive prompt editor, a real
repository edit loop, a process runner, persistent user sessions, BYOK, or a
real provider.

### 2.2 Accepted Milestone B substrate

Milestone B is accepted only for its tested policy and context boundaries. The
accepted mainline includes:

- `packages/policy-language`: lexer, parser, typed semantics, formatter, source
  spans, examples, and adversarial parser cases;
- `packages/policy-engine`: attribute catalogs, compilation, three-valued
  evaluation, deny/ask/allow precedence, explanation traces, simulation, and
  policy mutation tests;
- `packages/context-broker`: source registration, media/classification handling,
  bounded context release, provenance, and policy integration;
- `packages/capability-repository`: canonical virtual repository paths, virtual
  listing/search/read/diff inspection, and repository policy fixtures;
- `packages/milestone-b-scenarios`: deterministic safe and adversarial context
  histories plus provider-boundary probes;
- Gate B repository, policy, boundary-mutation, and deterministic-eval suites.

Milestone B proves that selected virtual content can pass through a deterministic
release boundary. It does **not** prove safe access to an arbitrary physical
repository, atomic file editing, live command isolation, interactive approvals,
or a production coding workflow.

### 2.3 Unaccepted work and branch hygiene

The earlier Milestone C prototype for artifacts, physical worktrees, and
capability execution is preserved on its own WIP branch. It is not part of the
Robin pivot baseline. Its audit findings must be converted into new failing
tests before any individual component is reused. The pivot branch must not
merge that branch wholesale, copy its unreviewed guarantees into documentation,
or count ignored build artifacts as source.

The initial product rename may leave private internal package names under the
historical `@guard/*` namespace. ADR-0007 deliberately preserves those names
while R0 changes the public repository, executable, package, help, and product
identity. Internal namespace migration is a separate compatibility ticket after
R4; it must not be mixed with the first coding-agent vertical slice.

### 2.4 Current product claim

The truthful active-branch claim is:

> Robin has an accepted deterministic terminal-agent foundation and an
> unaccepted R2 candidate that can inspect, edit, test, and review a physical
> Git worktree. R2 uses a narrow synthetic fixture model, keeps all state in
> memory, and runs approved processes on the host without filesystem or network
> isolation. It is not yet a supported release or a real-provider product.

The accepted R1 baseline contains this implementation:
`robin` and `robin "prompt"` use one ephemeral application service with a
raw-mode TTY editor or flat fallback, while `robin --print` uses the same
provider-neutral, multi-request structured tool loop with experimental text,
JSON, and streaming-JSON renderers. Versioned application events are persisted
to an in-memory journal, reduced and replayed through pure state transitions,
and exposed as a session-wide ordered replay/live stream. The deterministic
provider calls two gateway-mediated, non-consequential tools over an immutable
TypeScript fixture. Prompt queueing, first-/second-interrupt behavior, resize,
bracketed paste, bounded usage/budgets, terminal cleanup, and PTY error paths
have local automated coverage.

R1 itself still has no physical repository, process, Git, credential, network,
durable-session, or resume capability. R0 is accepted on `main` at `2c042ca`;
reviewed R1 head `9907287` passed all nine required hosted jobs, merged as
`fb64cf1`, and all nine merge-triggered `main` jobs passed again.

The active R2 candidate composes R1 with one bound physical Git worktree;
bounded list, explicit-path literal-search and classified read operations;
exact-preimage atomic patch/create operations; direct trusted executable-plus-
argv process runs; controlled read-only Git status/diff; initial dirty-state and
edit attribution; one-use approval events; and bounded ordered live tool-output
events. `ask` permits reads and asks separately for every edit/process action;
`plan` is read-only. The only R2 provider/model is the credential-free
`synthetic-r2-v1` fixture workflow, and accepted R1 remains available through
`--model synthetic-r1-v1`.

R2 sessions and grants are ephemeral. A reduced process environment, trusted
executable root, direct argv and output/process-group bounds do not constitute
a sandbox: approved processes have no filesystem isolation and no network
isolation. Hosted/local production providers, arbitrary model compatibility,
BYOK, durable continuation, persistent rules, shell/network tools, Git writes,
and supported distribution remain assigned to later gates.

The preview currently spells the ordinary ask-first permission label `ask` and
uses `--output-format` and `--no-save`. Those spellings are experimental. They
must migrate to target `default`, `--output`, and `--no-session` respectively.
The R1 acceptance gate is closed. The R2 acceptance gate remains open. The
stable R7 automation contract remains entirely planned, so accepting R1 does
not promote its experimental spellings.

`robin auth`, `robin models`, `robin doctor`, and `robin support` are currently
reserved/unimplemented preview commands. Their target names are fixed here so
prompt classification remains safe; R4 implements `robin auth`/`robin models`,
and R10 completes doctor plus `robin support bundle --dry-run`.

No README, package description, demo, release tag, or portfolio bullet may
promote the R2 branch candidate to an accepted release or describe its process
controls as filesystem/network isolation.

## 3. Target Product and Architecture

### 3.1 Product center

The primary path is deliberately short:

```text
developer input
    -> Robin terminal session
    -> session application service
    -> direct-model coding-agent loop
    -> provider adapter
    -> normalized text or tool request
    -> tool registry and permission decision
    -> repository, edit, process, Git, or extension adapter
    -> bounded observation returned to the same loop
    -> streamed result, persisted transcript, reviewable workspace state
```

The policy runtime sits inside the tool and context boundaries. It evaluates
normalized requests and produces explanations. It does not own conversation
UX, model selection, session continuity, task planning, repository discovery,
or Git workflow.

### 3.2 Trust and process boundaries

| Boundary | Trusted responsibility | Untrusted input |
| --- | --- | --- |
| CLI parser | Select a versioned application command without side effects. | argv, environment, stdin, terminal replies. |
| Terminal UI | Convert key/input events to intents and application events to pixels. | escape sequences from pasted text, provider text, tool output. |
| Application service | Serialize session commands and own cancellation scopes. | client requests and resumed state. |
| Agent loop | Advance one turn, enforce budgets, accept only normalized provider items. | provider streams and model tool arguments. |
| Prompt/context compiler | Select bounded, attributable provider input. | instructions, repository content, prior transcript. |
| Provider adapter | Authenticate to one origin and normalize its protocol. | network response, model identifiers, provider errors. |
| Tool registry | Validate versioned schemas and dispatch one exact operation. | model, user, hook, MCP, or subagent tool requests. |
| Permission engine | Decide allow, ask, or deny over immutable normalized facts. | project policy and repository-originated configuration. |
| Workspace adapters | Recheck containment and observed state immediately before effects. | paths, patches, Git output, file drift. |
| Process/sandbox adapter | Spawn a constrained process and terminate its process tree. | executable, argv, output bytes, child behavior. |
| Session store | Atomically append, validate, migrate, replay, and quarantine records. | disk contents, interrupted writes, old schemas. |
| Extension host | Bound, authenticate, and isolate an extension protocol. | hook output, skill content, MCP frames and annotations. |
| Client protocol | Authenticate local clients and preserve event ordering. | JSON-RPC frames, reconnect cursors, client retries. |

Provider text, tool output, Git metadata, repository instructions, MCP
annotations, and extension manifests remain data. None can change a permission
mode or declare itself trusted.

### 3.3 Target repository boundaries

The accepted packages stay in place and are extended through public exports.
New packages are introduced only when a boundary has independent tests or more
than one consumer.

```text
apps/
  cli/                         # executable, composition root, command wiring
  daemon/                      # R9 background supervisor; no second agent loop
  vscode/                      # R12 editor client; no tool execution
packages/
  contracts/                   # existing cross-boundary IDs and event schemas
  robin-application/           # session use cases, composition, app event stream
  robin-terminal/              # raw-mode input reducer and terminal renderer
  robin-session/               # session/turn/tool states, records, replay views
  robin-agent/                 # direct-model turn machine and prompt/tool loop
  robin-prompt/                # instructions, context, compaction, request assembly
  agent-driver/                # existing scripted/external driver contracts
  model-provider/              # temporary preview port, then canonical R4 adapter port
  provider-openai/             # R4 official-SDK transport adapter
  provider-anthropic/          # R7 direct adapter
  provider-openai-compatible/  # R7 explicit-origin compatible/local adapter
  robin-config/                # scoped configuration, trust, source tracing
  local-state/                 # event segments, snapshots, artifacts, migrations
  context-broker/              # existing release/provenance boundary
  capability-gateway/          # existing schema/normalize/permission dispatch
  capability-repository/       # existing virtual path and policy test substrate
  robin-tools/                 # Robin tool contracts, registry, result lifecycle
  tool-workspace/              # physical reads, patching, atomic writes, edit ledger
  tool-process/                # structured spawn, output, cancellation
  tool-git/                    # structured Git read/write and worktree operations
  policy-language/             # existing advanced policy syntax
  policy-engine/               # existing evaluator, embedded behind permissions
  robin-permissions/           # product modes, approvals, rule persistence
  robin-extensions/            # skills, hooks, MCP, subagents, lifecycle
  robin-platform/              # OS, credential, process, terminal, sandbox adapters
  robin-observability/         # redacted diagnostics, logs, local metrics
fixtures/
  repos/                       # generated safe, dirty, hostile, Git edge cases
  provider/                    # sanitized recorded streams and failures
  terminal/                    # byte-level input/output and resize transcripts
  sessions/                    # every supported storage/schema version
  extensions/                  # skills, hooks, MCP peers, subagent scenarios
docs/
  decisions/                   # accepted ADRs
  reference/                   # CLI/config/instruction/policy/MCP schemas
  operations/                  # install, update, uninstall, data, recovery
```

`apps/cli` is a composition root, not a domain package. It may import public
package exports, configure adapters, and translate process exit status. It may
not parse provider streams, touch repository files directly, make permission
decisions, or persist session records itself.

### 3.4 Core interfaces to establish and preserve

The exact TypeScript names can change only through an ADR and migration. The
semantic responsibilities may not collapse across boundaries.

```ts
export interface RobinApplication {
  execute(command: ApplicationCommand, signal: AbortSignal): AsyncIterable<ApplicationEvent>;
}

export interface TurnCoordinator {
  runTurn(input: RunTurnInput, signal: AbortSignal): AsyncIterable<TurnEvent>;
}

export interface ModelProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  probe(
    request: ProviderProbeRequest,
    credential: CredentialLease | null,
    signal: AbortSignal,
  ): Promise<ProviderProbeResult>;
  countInput(
    request: ProviderNeutralRequest,
    model: ModelDescriptor,
  ): Promise<TokenCountResult>;
  invoke(
    request: ProviderNeutralRequest,
    credentialRef: CredentialLeaseReference,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedProviderEvent>;
  classifyUnknownError(error: unknown): ProviderFailure;
  redactDiagnostic(input: unknown): SafeDiagnostic;
}

export interface ToolDefinition<TInput, TOutput> {
  readonly id: ToolDefinitionId;
  readonly version: ToolVersion;
  readonly inputSchema: TrustedJsonSchema;
  normalize(input: unknown, context: ToolNormalizationContext): Promise<NormalizedToolRequest>;
  execute(request: AuthorizedToolRequest, signal: AbortSignal): Promise<ToolResult<TOutput>>;
}

export interface PermissionEngine {
  decide(request: PermissionRequest, snapshot: PermissionSnapshot): Promise<PermissionDecision>;
}

export interface SessionStore {
  create(input: CreateSessionRecord): Promise<SessionHeader>;
  append(sessionId: SessionId, expectedSequence: number, records: readonly NewSessionRecord[]): Promise<readonly SessionRecord[]>;
  read(sessionId: SessionId, afterSequence?: number): AsyncIterable<SessionRecord>;
  acquireWriter(sessionId: SessionId, owner: ProcessIdentity): Promise<SessionWriterLease>;
}

export interface Workspace {
  readonly identity: WorkspaceIdentity;
  snapshot(): Promise<WorkspaceSnapshot>;
  reconcile(expected: WorkspaceSnapshot): Promise<WorkspaceDrift>;
}

export interface CredentialResolver {
  resolve(reference: CredentialReference, audience: ProviderOrigin, signal: AbortSignal): Promise<SecretLease>;
}
```

The `SecretLease` exposes secret bytes only to the provider transport call,
supports explicit zeroization where the runtime permits it, records no secret in
its diagnostic representation, and cannot be serialized. Tool, hook, MCP, and
child-process composition roots do not receive a `CredentialResolver`.

The `probe` / `countInput` / `invoke` / `classifyUnknownError` /
`redactDiagnostic` shape is the canonical production provider port introduced
and frozen in R4. The checked-in
`ModelProvider.respond(SemanticModelRequest, AbortSignal)` contract is an
explicitly temporary initial-R1 preview port. It remains only long enough to
adapt the deterministic synthetic fixtures during the R4 migration and is not a
second production adapter interface.

Provider-specific request compilation, stream normalization, and continuation
reconstruction are internal pipeline modules. Helpers such as
`compileSemanticRequest`, `normalizeProviderStream`, and
`reconstructContinuation` may be private package seams, but callers see only the
five canonical adapter operations above. SDK request, response, error, and
continuation objects never cross the adapter package boundary.

### 3.5 Three event layers and canonical application events

Robin deliberately separates three event layers:

1. **Live agent events** are bounded in-process observations from the agent,
   provider collector, tool pipeline, and process supervisor. They include text
   and output deltas plus transient interaction phases; delivery rules may
   coalesce only events declared coalescible.
2. **Application events** are the versioned provider-neutral contract consumed
   by terminal, text, JSON, daemon, and future editor surfaces. Renderers never
   consume provider callbacks or adapter objects directly.
3. **Canonical durable events** are validated, framed, hash-chained semantic
   records used for replay, recovery, and audit. Complete text/tool/output facts
   are sealed; original high-rate chunk cadence is not durable authority.

Only canonical durable events receive monotonic per-session sequence numbers.
An application event derived from a commit carries its durable sequence; a
live-only application event carries a separate live ordering key and no durable
sequence. The current `EphemeralRobinApplication` direct pass-through of
`RobinAgentEvent` is a temporary preview seam. R1 completion maps live agent
events to the application contract, and R3 adds canonical durability without
changing renderer semantics.

Terminal, print, JSON, daemon, and editor renderers consume one versioned event
union. The minimum union is:

```text
SessionCreated
SessionOpened
SessionResumed
SessionDriftDetected
UserMessageAccepted
TurnQueued
ContextCompilationStarted
ContextItemReleased
ContextItemWithheld
ContextCompilationCompleted
ProviderAttemptStarted
ProviderTextDelta
ProviderToolCallCompleted
ProviderUsageReported
ProviderAttemptFailed
ProviderAttemptUncertain
ToolRequestNormalized
PermissionDecided
ApprovalRequested
ApprovalResolved
ToolExecutionStarted
ToolOutputDelta
ToolExecutionCompleted
ToolExecutionFailed
EditRecorded
VerificationRecorded
BudgetWarning
BudgetExceeded
AssistantMessageCompleted
TurnCancelled
TurnFailed
TurnCompleted
SessionClosed
```

Events contain observable facts, not fabricated hidden reasoning. A renderer may
coalesce deltas but may not invent tool success, permission state, changed-file
attribution, verification status, usage, or cost.

The minimum cross-layer mapping is explicit:

| Live agent or subsystem observation | Application event(s) | Canonical durable event(s) |
| --- | --- | --- |
| preview `turn_started` | `TurnQueued`, then context progress | `UserSubmissionAccepted`, `TurnStarted` |
| `assistant_text_delta` / provider content delta | `ProviderTextDelta` | no per-delta frame; later `ProviderContentSealed` and `AssistantMessageSealed` |
| provider tool fragments | optional bounded progress | none until a complete call is sealed |
| completed normalized provider tool call | `ProviderToolCallCompleted`, `ToolRequestNormalized` | `ProviderToolCallSealed`, `ToolCallReceived`, `ToolCallNormalized` or `ToolCallRejected` |
| permission evaluation/response | `PermissionDecided`, `ApprovalRequested`, `ApprovalResolved` | `PermissionEvaluated`, `ApprovalRequested`, `ApprovalResponded` |
| tool lifecycle/output | `ToolExecutionStarted`, `ToolOutputDelta`, terminal tool event | `ToolExecutionPrepared`, `ToolExecutionStarted`, `ToolOutputSealed`, then exactly one of `ToolExecutionCompleted`, `ToolExecutionFailed`, or `ToolExecutionOutcomeUncertain` |
| provider usage | `ProviderUsageReported` | `ProviderUsageRecorded` |
| preview `turn_completed` | `AssistantMessageCompleted`, `TurnCompleted` | `AssistantMessageSealed`, `TurnCompleted` |
| turn failure/cancellation | `TurnFailed` or `TurnCancelled` | matching provider/tool failure plus `TurnFailed`, or `TurnCancellationRequested` then `TurnCancelled` |

Argument fragments and output deltas are never permission or replay authority.
Tests independently assert live ordering, application mapping, durable append
ordering, and application views reconstructed from replay.

### 3.6 Turn state machine

One turn advances through repeatable **interaction phases**:

```text
queued
  -> persisting_user_message
  -> compiling_context
  -> requesting_provider
  -> collecting_provider_items
  -> normalizing_tool_request
  -> evaluating_permission
  -> waiting_for_approval | executing_tool | returning_denial
  -> persisting_tool_result
  -> requesting_provider
  -> finalizing_assistant_message
```

`cancelling` may temporarily replace any active phase while owned operations
settle. Phase names drive coordinator legality and progress rendering, but they
are not persisted as turn status and replay does not reconstruct their cadence.

The durable projection derives only these statuses from committed semantic
events:

```ts
type PersistedTurnStatus =
  | "accepted"
  | "active"
  | "cancellation_requested"
  | "interrupted"
  | "cancelled"
  | "failed"
  | "provider_result_uncertain"
  | "recovery_required"
  | "completed";
```

`UserSubmissionAccepted` maps to `accepted`, `TurnStarted` to `active`, and
`TurnCancellationRequested` to `cancellation_requested`. Exactly one terminal
event maps to `interrupted`, `cancelled`, `failed`,
`provider_result_uncertain`, `recovery_required`, or `completed`. A crash while
the projection is nonterminal triggers recovery from prepared/started/settled
provider and effect evidence; it never persists the last visible interaction
phase as a fabricated status. Cancellation becomes terminal only after the
provider stream, active tool, process group, renderer, and pending store write
have settled or reached their bounded termination deadline. An unknown state or
transition is a domain error and fails closed.

### 3.7 Tool request lifecycle

Every model-originated tool call uses this sequence:

1. collect exactly one complete call identifier, name, and bounded argument byte
   sequence from normalized provider events;
2. reject duplicate identifiers, unknown names, unsupported versions, malformed
   JSON, excessive nesting, excessive items, and unknown schema properties;
3. schema-validate without effects;
4. semantically normalize paths, command shape, Git targets, and requested limits;
5. derive immutable permission facts and live-precondition requirements;
6. obtain allow, ask, or deny;
7. for ask, persist the request before rendering and persist the human response
   before action start;
8. immediately before an effect, recheck path containment, hashes, workspace
   identity, executable resolution, Git state, sandbox backend, and approval
   expiry;
9. execute with one cancellation scope and deterministic output limits;
10. persist raw-retained metadata, human representation, model observation,
    attribution, hashes, and outcome category;
11. return only the bounded model observation to the provider loop.

No tool may invoke another registered tool by calling its adapter directly. A
compound workflow returns to the coordinator between operations so permission,
budgets, events, and cancellation remain visible.

## 4. Cross-Phase Engineering Rules

### 4.1 Test-first workflow

Each ticket follows this merge order:

1. add a test or fixture that fails for the intended reason;
2. add or update the boundary schema and error category;
3. implement the smallest behavior that makes the unit test pass;
4. add integration coverage through public package exports;
5. add the user-visible CLI or protocol failure assertion;
6. add adversarial and interruption cases;
7. run package tests, repository architecture checks, the current phase gate,
   and all accepted earlier gates;
8. update current-versus-planned documentation in the same changeset.

Tests must not use wall-clock sleeps for correctness. Use injected clocks,
scripted schedulers, fake signals, controlled streams, and bounded polling with a
recorded deadline. Provider contract tests use sanitized recorded frames and a
local fake HTTP server; networked smoke tests are opt-in and never required for a
pull request from an untrusted fork.

### 4.2 Error taxonomy

Every boundary maps failures into a stable category with a safe user message,
diagnostic metadata, retry classification, exit-code mapping, and secret-safe
serialization. Required top-level categories are:

- `invalid_invocation`;
- `invalid_configuration`;
- `workspace_unavailable` and `workspace_drift`;
- `permission_denied`, `approval_required`, and `approval_stale`;
- `provider_authentication`, `provider_rate_limit`, `provider_transient`,
  `provider_invalid_response`, and `provider_result_uncertain`;
- `tool_invalid_request`, `tool_precondition_failed`, `tool_failed`, and
  `tool_result_uncertain`;
- `process_failed_to_start`, `process_nonzero`, `process_timeout`, and
  `process_cancelled`;
- `storage_locked`, `storage_corrupt`, `storage_migration_required`, and
  `storage_exhausted`;
- `budget_exceeded`, `cancelled`, `unsupported_capability`, and
  `internal_invariant`.

Unknown thrown values are converted once at the boundary, assigned a correlation
identifier, and rendered without a JavaScript stack unless debug mode is enabled.
Debug output still passes redaction.

### 4.3 Determinism and clocks

Identifiers, clocks, randomness, filesystem adapters, process spawning, provider
transports, terminal dimensions, and pricing catalogs are injected. Golden files
use fixed clocks and deterministic IDs. Production uses UUIDv7, monotonic elapsed
time, cryptographically strong random nonces for local authentication, and UTC
timestamps for persisted records.

### 4.4 Data and privacy defaults

- Provider egress is off until the user selects a provider and accepts the
  workspace/instruction trust decision.
- Telemetry is absent in early phases and opt-in only after a documented event
  schema and destination review.
- Raw credentials are never accepted as argv, JSON configuration, repository
  configuration, session records, transcripts, logs, artifacts, crash reports,
  hook input, MCP environment, process environment, or editor storage.
- Source content retained for resume is local, size-bounded, attributed, and
  separately purgeable from metadata.
- Diagnostic exports enumerate included files and fields before writing.
- Every artifact has an owner, media type, byte length, content hash, retention
  class, and reference count or explicit session reference.

### 4.5 Performance budgets

Initial budgets are gates to measure, not claims to publish before measurement.
The user-facing p95 SLO targets and the deliberately looser CI regression
ceilings are both fixed so a slow CI runner does not silently redefine product
performance:

| Interaction | p95 SLO target | CI hard ceiling |
| --- | ---: | ---: |
| warm `robin --help` / `robin --version` | 150 ms | 250 ms |
| cold start to first usable interactive frame | 500 ms | 750 ms |
| resume 10,000 events from a valid head snapshot | 250 ms | 500 ms |

Help/version paths must not load providers or repository services. In addition:

- input-to-local-echo latency: p95 under 16 ms during provider and process
  streaming;
- renderer frame work: p95 under 8 ms with at most 30 visual refreshes per
  second; machine mode emits every record without ANSI coalescing;
- repository discovery: no full-content read and no full-tree hashing at start;
- graceful first SIGINT acknowledgement: under 100 ms; process-tree termination
  target under 2 seconds after the configured grace interval;
- session append: acknowledgement only after the atomic record is durable to the
  documented level; p95 and fsync behavior are measured per platform;
- bounded memory: long transcripts, command output, and provider streams retain
  windows plus artifact references rather than all bytes in memory.

R10 records p50, p95, and p99 on the supported matrix and revises targets using
evidence rather than silently weakening a failing gate.

### 4.6 Review gates for dependencies

Robin builds its agent loop, application services, terminal state reducers,
tool semantics, permission modes, local session journal, provider normalization,
context compiler, edit ledger, Git adapters, extension lifecycle, and eval runner
in this repository. It may use:

- official provider SDKs as transport dependencies behind adapters;
- Ajv for JSON Schema correctness;
- Git, ripgrep when available, and operating-system process primitives through
  explicit adapters;
- Docker or Podman and reviewed platform sandbox tools rather than implementing
  a kernel boundary;
- standard hashes, OS credential stores, archive libraries, and Unicode data
  rather than inventing cryptography or character-width tables.

A new runtime dependency needs a recorded license, release cadence, transitive
dependency, native-binary, install-size, and security review. Agent frameworks,
workflow engines, general policy frameworks, ORMs, and a second terminal-agent
loop are excluded unless an ADR demonstrates that they do not replace Robin's
differentiating implementation.

## 5. R0 — Product Pivot, Repository Identity, and Clean Baseline

**Status:** accepted on `main` at merge commit `2c042ca`; the merge-triggered
Gate A/B workflow passed. Milestones A and B remain the accepted substrate.

**Effort range:** 3–5 focused days, including repository and package verification.

### 5.1 Why R0 exists

The repository, executable, package metadata, help, docs, and GitHub project must
agree that the product is Robin before new code establishes public names. This
phase also prevents two dangerous shortcuts: relabeling the deterministic fixture
CLI as a finished coding agent, and merging the unaccepted Milestone C branch to
make the pivot appear further along.

### 5.2 Prerequisites

- The Milestone A and B mainline commit is tagged or recorded by exact commit ID.
- The Milestone C WIP branch is pushed and its audit note is preserved.
- The GitHub repository rename and local directory rename are complete or are
  performed in one controlled operation with remote verification.
- ADR-0007 is accepted and states the coding-agent-first product hierarchy.

### 5.3 Owned files, interfaces, and state

R0 changes public identity in:

- root `package.json`, `package-lock.json`, README, license metadata, repository
  URL, issue URL, and package descriptions;
- `apps/cli/package.json`, `apps/cli/README.md`, binary map, shebang output,
  command help, version output, error prefixes, subprocess tests, and package
  tarball assertions;
- documentation titles, diagrams, links, examples, and status statements that
  describe the product rather than historical protocol names;
- GitHub repository name, local top-level folder name, `origin`, default branch
  protection, draft pull requests, and CI badges;
- the repository architecture check that rejects a public `guard` binary or
  `Guarded Agent` product label after R0.

R0 deliberately does not rename:

- private `@guard/*` workspace names;
- the `.guard` policy-language extension;
- serialized Milestone A/B type tags, fixtures, golden histories, or policy
  operation identifiers;
- historical ADR content that accurately describes decisions at the time.

The CLI parser returns a pure value before any repository discovery, provider
loading, state-directory creation, or terminal raw-mode change:

```ts
type ParsedInvocation =
  | { readonly kind: "interactive"; readonly initialPrompt?: string }
  | { readonly kind: "print"; readonly prompt?: string; readonly inputMode: "argument" | "stdin" | "combined" }
  | { readonly kind: "continue" }
  | { readonly kind: "resume"; readonly selector?: string }
  | { readonly kind: "command"; readonly command: ReservedCommand }
  | { readonly kind: "help" }
  | { readonly kind: "version" };
```

Unknown reserved command spellings never fall through as prompts. Duplicate
singleton flags, conflicting modes, invalid option values, unexpected positionals
after a reserved command, and ambiguous piped input are parse errors.

### 5.4 Implementation tickets and sequence

1. **R0.01 — Freeze baseline evidence.** Record the mainline commit, run Gate A
   and Gate B, store the command list and pass summary in the pivot pull request,
   and fail if source-controlled files differ before the pivot begins.
2. **R0.02 — Preserve unaccepted work.** Push the Milestone C WIP commit and
   branch, link its audit, close or retitle its draft pull request as superseded,
   and verify no WIP-only source is tracked on the pivot branch.
3. **R0.03 — Rename GitHub and local repository.** Rename the remote to `Robin`,
   rename the local directory to `Robin`, set `origin` to the renamed URL, fetch,
   and verify default-branch and pull-request links through read-only GitHub
   queries.
4. **R0.04 — Rename public package identity.** Set the root package name to
   `robin`; use the account-owned scoped CLI package name
   `@zachshotamartin/robin`; expose `robin` as the only public executable; keep
   the package private until R10's publication audit.
5. **R0.05 — Specify the new argv grammar.** Add reserved commands and
   interactive/print/continue/resume shapes without implementing their full
   behavior. Preserve policy-debugger commands under `robin policy`.
6. **R0.06 — Make help and version cold paths.** Ensure those paths do not import
   provider, repository, policy evaluator, session store, or terminal raw-mode
   modules. Version reads generated build metadata with a deterministic
   development fallback.
7. **R0.07 — Replace public strings.** Change help, README, package descriptions,
   examples, generated filenames, CLI prefixes, and test assertions. Retain
   historical and protocol identifiers listed in section 5.3.
8. **R0.08 — Add identity architecture checks.** Scan tracked public files rather
   than ignored `dist` output; allow a documented historical allowlist; fail on
   a `guard` executable mapping, stale remote URL, obsolete product heading, or
   public install command using the old name.
9. **R0.09 — Verify package contents.** Build the CLI, run `npm pack --dry-run`,
   inspect the tarball manifest, execute its installed `robin` binary from a
   temporary prefix, and assert no absolute development path is embedded in help.
10. **R0.10 — Rewrite normative product docs.** Make
    `PRODUCT_REQUIREMENTS.md`, this plan, ADR-0007, and README agree on the
    coding-agent-first scope, the implemented ephemeral preview, and every
    still-unaccepted R7/release claim.
11. **R0.11 — Re-run accepted gates.** Run typecheck, package unit tests, Gate A,
    Gate B, mutation tests, CLI subprocess tests, and repository checks after the
    rename. A golden update requires semantic review rather than blanket rewrite.
12. **R0.12 — Publish pivot evidence.** Push the `codex/robin-cli-pivot` branch,
    open a truthful draft pull request, include the preserved-WIP link, exact test
    commands, package tarball inventory, and the remaining R1 gate work.

### 5.5 Test-driven evidence matrix

| Test | First failing condition | Required passing assertion |
| --- | --- | --- |
| argv table test | `robin`, prompt, print, continue, resume, and reserved commands are ambiguous. | Every token sequence maps to one pure `ParsedInvocation` or one stable parse error. |
| side-effect sentinel | Help/version imports initialize state or repository services. | Help/version run with filesystem/provider sentinels that throw on access. |
| subprocess identity | Binary, help, stderr, or version says `guard`. | Installed tarball invokes `robin` and all public labels say Robin. |
| package inventory | Tarball omits bin, includes source secrets, or includes developer paths. | Expected executable, dist, README, license, and package metadata only. |
| architecture scan | Public tracked files preserve obsolete product identity. | Only explicit historical/internal allowlist matches remain. |
| baseline regression | Rename changes a serialized ID or accepted golden event. | Gate A/B histories remain byte-stable unless an ADR and migration say otherwise. |
| remote verification | Local `origin` or GitHub repository points to old name. | Fetch and read-only repository metadata resolve to `Robin`. |

### 5.6 Failure and security cases

- If the account-owned npm scope is unavailable, keep the package private and
  stop publication; never squat an unowned public scope.
- If GitHub rename redirects work but `origin` is stale, R0 still fails because
  redirects can hide future automation errors.
- If the old and new directories both exist, compare repository IDs and stop;
  do not recursively delete either directory.
- If `npm pack` contains `.env`, logs, session data, fixtures containing live
  credentials, `.git`, or absolute paths, block the branch.
- Help and version must not create `ROBIN_HOME`, touch a credential store, prompt
  for trust, or make a network request.
- Product string replacement must not rewrite signed hashes, schema tags,
  fixture payloads, or historical evidence without an explicit migration.

### 5.7 Migration, documentation, and installation work

There is no released user-data migration in R0 because Robin has not shipped.
Developer migration consists of the renamed folder and remote. The README must
show source installation for contributors, the synthetic ephemeral preview and
fixture-only tool limitations, the accepted substrate gates, and the intended
`robin` entry point. It must not show a global production install until R10.

R0 adds a temporary compatibility error if a developer invokes a checked-in old
development shim: the message points to `robin` but does not keep two product
binaries. Shell completions, man pages, state-directory migration, update
channels, and uninstall behavior are R10 work.

### 5.8 Acceptance evidence

R0 is accepted only when:

- the GitHub project, local folder, remote, root package, CLI package, binary,
  help, and normative docs identify as Robin;
- `robin --help`, `robin --version`, invalid argv, and the installed temporary
  tarball pass subprocess tests;
- every accepted Gate A and Gate B command remains green;
- the pivot pull request explicitly says the initial ephemeral conversation
  preview exists while the complete R1 coding-agent/terminal gate is still
  unaccepted;
- ignored Milestone C artifacts are absent from the tarball and tracked pivot
  diff;
- repository checks document every intentional remaining `guard` identifier.

### 5.9 Explicit deferrals

R0 acceptance takes no credit for the separately developed initial-R1 preview.
R0 itself does not complete a raw-mode REPL, production provider call, physical
repository tool, durable session store, credential store, sandbox, Git mutation,
daemon, editor, internal namespace migration, or production installation
channel.

### 5.10 Requirements traced

R0 begins `FR-CLI-001–006`, `FR-CLI-011–012`, `FR-AUTO-004`, `FR-OPS-001–003`,
`NFR-PERF-001`, `NFR-MAINT-004`, and the installation portions of sections 6.1
and 12.2 of the product requirements. It does not mark those multi-phase
requirements complete unless the requirement-to-evidence matrix in section 19
says R0 is the terminal owning gate.

## 6. R1 — Interactive Synthetic Coding-Agent Loop

**Status:** accepted on `main` at merge commit `fb64cf1`; reviewed head
`9907287` and the merge-triggered mainline workflow each passed all nine
required jobs.

**Effort range:** 2–4 part-time weeks.

### 6.1 Why R1 exists

R1 proves that Robin itself owns the interactive product: prompt input, streamed
assistant output, turn orchestration, normalized tool calls, cancellation, and a
follow-up turn. The provider and tool effects are deterministic so terminal and
loop defects cannot hide behind network or model variance.

### 6.2 Prerequisites

- R0 is accepted.
- Existing synthetic provider, scripted driver, event, schema-validation,
  capability-gateway, and runtime tests pass.
- Terminal support is scoped to interactive TTYs on macOS and Linux; redirected
  input uses print mode or returns an actionable error.

### 6.3 Packages, files, interfaces, and data

The accepted baseline contains the bounded R1 implementation:

- `packages/model-provider` exposes the temporary
  `ModelProvider.respond(SemanticModelRequest, AbortSignal)` port plus scripted,
  delayed, and deterministic R1 providers;
- `packages/robin-agent` owns bounded provider-event collection, prompt
  compilation, multi-request structured tool continuation, serialized dispatch,
  call-ID replay prevention, budgets, and single-owner turn coordination;
- `packages/robin-session` owns versioned application-event validation, legal
  turn transitions, pure reduction, and prefix replay;
- `packages/robin-application` owns the session journal, monotonic publication,
  queue promotion, cancellation and terminal ownership, gateway dispatch, error
  mapping, bounded replay/live event subscriptions, and fail-closed shutdown;
- `packages/robin-terminal` owns capability detection, grapheme input state,
  bounded key decoding, raw UI reduction, frame construction/diffing, flat
  rendering, and `finally`-based terminal restoration;
- `apps/cli` composes that application for raw TTY, flat interactive, text,
  experimental JSON, and experimental streaming-JSON modes; and
- `tests/pty` drives the built process through a real pseudo-terminal for launch,
  two turns, tool visibility, queueing, resize, paste, single/double interrupt,
  provider/tool failure, and exact terminal-mode restoration.

These pieces passed the clean package inventory, installed-tarball PTY/uninstall
smoke, documented terminal matrix, hosted Linux/macOS jobs, accepted R0
predecessor, exact-head review, and post-merge checks required by section 6.9.
R7, not R1, owns the stable public automation schemas and target flag
compatibility contract.

Create `packages/robin-application` with:

- `src/application-command.ts`: versioned `StartSession`, `SubmitMessage`,
  `CancelTurn`, `CloseSession`, and `SetPermissionMode` commands;
- `src/application-event.ts`: the canonical event union and safe parser;
- `src/robin-application.ts`: command serialization and event subscription;
- `src/session-service.ts`: in-memory R1 session lifecycle;
- `src/cancellation-tree.ts`: root/session/turn/tool abort scopes;
- tests for command legality, event ordering, cancellation, and error mapping.

Create `packages/robin-session` with `src/turn-state.ts`,
`src/turn-reducer.ts`, canonical application event records, and replay
projections. Create `packages/robin-agent` with:

- `src/turn-coordinator.ts`: command interpreter around provider and tool ports;
- `src/provider-item-collector.ts`: bounded text/tool-call assembly;
- `src/tool-loop.ts`: schema validation, serialized dispatch, observation return;
- `src/budgets.ts`: R1 turn, request, tool-call, output-byte, and wall-time
  counters using injected clocks;
- `src/prompt-compiler.ts`: a minimal versioned system/developer/user semantic
  request with no physical repository content;
- reducer, stream-fragmentation, duplicate-call, budget, and cancellation tests.

Create `packages/robin-terminal` with:

- `src/terminal-capabilities.ts`: TTY, color, Unicode, width, reduced-motion,
  hyperlink, and interactive-input detection;
- `src/input-buffer.ts`: immutable grapheme-aware buffer and selection state;
- `src/key-decoder.ts`: bounded parser for printable UTF-8, Enter, Backspace,
  Delete, arrows, Home, End, Ctrl-A/E/U/K/W, Ctrl-C, Ctrl-D, bracketed paste,
  and resize;
- `src/repl-reducer.ts`: pure UI state reducer;
- `src/renderer.ts`: escaped, diff-based terminal frames;
- `src/flat-renderer.ts`: line-oriented accessible fallback;
- `src/terminal-session.ts`: raw-mode setup and `finally` restoration;
- byte fixtures, reducer tests, renderer snapshots, and PTY integration tests.

Update `packages/model-provider` so `SyntheticModelProvider` accepts a
versioned script:

```ts
interface SyntheticTurnScript {
  readonly expectedUserText: string;
  readonly events: readonly SyntheticProviderStep[];
  readonly expectedObservations?: readonly ExpectedObservation[];
}

type SyntheticProviderStep =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_call"; readonly callId: string; readonly name: string; readonly argumentsJson: string }
  | { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: "finish"; readonly reason: "stop" | "tool_calls" };
```

The script is test data, not production prompt routing. It validates expected
conversation items and observations so a broken tool loop cannot pass by merely
emitting a canned final answer.

Update `apps/cli` with `src/composition.ts`, `src/interactive.ts`,
`src/signal-handler.ts`, and `src/exit-codes.ts`. The app wires adapters and maps
events to the terminal; no loop logic enters the app.

R1 session data is in-memory only and contains:

```ts
interface EphemeralSession {
  readonly sessionId: SessionId;
  readonly createdAt: Timestamp;
  readonly messages: readonly ConversationItem[];
  readonly activeTurn?: TurnId;
  readonly permissionMode: "ask" | "plan";
  readonly providerProfile: "synthetic";
}
```

The UI shows an `ephemeral` badge so exiting cannot be mistaken for durable
session support. Preview `ask` is the temporary spelling of target `default`;
it is not an additional production permission mode.

### 6.4 Algorithms and state behavior

#### Input and rendering

The input reducer stores grapheme clusters rather than indexing UTF-16 code
units. `Intl.Segmenter` provides segmentation; a pinned width helper or generated
Unicode width table computes cells. Cursor movement changes grapheme boundaries.
Bracketed paste is treated as text, never as keystrokes or an automatic submit,
and both a paste event and the complete composer are capped at 65,536 UTF-8
bytes. An insertion or paste that would exceed the cap is rejected atomically;
an oversized paste is discarded through its closing delimiter before the
decoder accepts ordinary input again. Unknown control sequences are discarded
and counted for diagnostics rather than echoed. Ordinary decoded text events
are capped at 4,096 bytes and control sequences at 64 bytes.

Rendering builds an abstract frame of rows, computes the longest common prefix
and suffix with the prior frame, updates only changed rows, and restores the
cursor in one write. Provider and tool text passes through control-character
escaping before frame construction. The flat renderer never enters raw mode and
prints typed event lines for assistive technology and debug capture.

#### Turn coordination

Only one foreground turn owns the session. Submitting while active queues the
message and displays its queue position; R1 permits a maximum of eight queued
messages. The coordinator persists to the in-memory store before emitting
`UserMessageAccepted`, builds the request, invokes the provider, validates event
order, assembles tool calls, and returns each allowed synthetic observation. A
provider `finish: tool_calls` without a complete call, a call after final stop,
or a second final event is invalid.

R1 registers two non-consequential deterministic tools:

- `robin.synthetic.workspace_summary@1`, returning a fixture repository name,
  language, and test command;
- `robin.synthetic.inspect_file@1`, returning bounded fixture lines and a
  content hash.

The first scripted scenario requires the model to request both tools before
answering a debugging question. The second turn asks a follow-up whose answer
depends on the first turn's observation. This proves conversation continuity
inside one process.

#### Cancellation and terminal restoration

The first SIGINT aborts the active turn and renders `Cancelling`; it does not
terminate the process while the cancellation deadline remains. A second SIGINT
within the 750 ms window forces bounded shutdown. Application close has a
2,000 ms default deadline, validates overrides in the range 1–30,000 ms, and
fences all provider output after forced terminal commitment. A provider that
ignores `AbortSignal` therefore cannot keep `/exit`, EOF, EPIPE, or terminal
cleanup pending indefinitely. At every exit path,
`TerminalSession.close()` disables bracketed paste, shows the cursor, resets
style, exits raw mode, unregisters signal listeners, and flushes the final line.
Errors during cleanup are aggregated behind the primary error.

The R1 journal is also bounded independently of provider budgets. Defaults are
131,072 records, 134,217,728 serialized UTF-8 bytes, 32 concurrent subscribers,
8,192 unread live events per subscriber, and 16,777,216 unread live bytes per
subscriber. Historical replay is a lazy indexed view rather than a copied
subscriber backlog. The journal reserves enough record/byte headroom for the
active and queued turns' terminal events, releases replay/backlog references on
iterator return, and fails the affected stream—or the whole application when
the authoritative journal itself cannot append—instead of dropping semantic
events. Permission-mode mutation occurs only after its event append commits.

### 6.5 Implementation tickets and sequence

1. **R1.01 — Freeze app event schema.** Add JSON fixtures and safe parsers for
   the R1 event subset; test unknown version/type, oversized payload, unsafe
   control text, and canonical serialization.
2. **R1.02 — Build the pure turn reducer.** Add the legal transition table,
   terminal states, illegal-transition errors, budget commands, and exhaustive
   state/event tests before adding I/O.
3. **R1.03 — Build provider item collection.** Test every fragmentation boundary
   in UTF-8 text and JSON arguments, duplicate IDs, invalid ordering, byte limits,
   provider abort, and uncertain completion.
4. **R1.04 — Adapt the synthetic provider.** Add script expectations, deterministic
   clocks/usage, tool observations, injected errors, and transcript goldens.
5. **R1.05 — Build the serialized tool loop.** Register the two R1 tools, route
   through the existing gateway, enforce schema and output limits, and return
   normalized observations.
6. **R1.06 — Build the application service.** Serialize commands per session,
   queue user messages, connect cancellation scopes, and expose one async event
   stream.
7. **R1.07 — Build terminal capability detection.** Cover TTY/non-TTY, TERM=dumb,
   NO_COLOR, CI, width/height absence, Unicode override, reduced motion, and
   machine mode.
8. **R1.08 — Build input decoder and reducer.** Add byte fixtures and pure tests
   before raw-mode integration; bound escape-sequence and paste buffers.
9. **R1.09 — Build renderers.** Add control-byte sanitization, frame diffs,
   streamed text/tool status, queue state, cancellation state, no-color symbols,
   and flat output.
10. **R1.10 — Wire the CLI.** Make `robin` and `robin "prompt"` start the same
    application; preserve `robin policy`; return a clear error for unsupported
    resume and real-provider selection.
11. **R1.11 — Add signal and cleanup tests.** Spawn the built binary in a PTY,
    submit prompts, resize, paste, send one and two SIGINTs, close stdin, and
    assert terminal restoration byte sequences and exit codes.
12. **R1.12 — Add end-to-end synthetic demo.** Run two turns, require two tool
    calls and their observations, show usage, cancel a separate scenario, and
    capture a deterministic flat transcript.
13. **R1.13 — Document preview behavior.** Explain synthetic mode, ephemeral
    sessions, keys, flat mode, interruption, unsupported features, and exact
    source-run commands.

### 6.6 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| turn reducer | Every legal edge, every terminal state, illegal re-entry, cancel in each active state, provider uncertainty, budget warning/exhaustion. |
| provider collector | One-byte fragmentation, split multibyte code points, split JSON escapes, unknown item, duplicate call/final, oversized text/args, abort before and after transmission. |
| input reducer | ASCII, composed/decomposed Unicode, emoji sequences, wide cells, combining marks, selection deletion, history boundaries, bracketed paste, control-byte rejection. |
| renderer | 40/80/160 columns, resize mid-stream, no color, flat mode, status updates, long tool output summary, escaped OSC/CSI payloads. |
| application | queued prompts, maximum queue, cancellation fan-out, provider failure, tool failure, cleanup error, event sequence monotonicity, lazy replay/live ordering, journal record/byte/subscriber/backlog/read caps, iterator return cleanup, terminal headroom, deadline/clock/ID append faults, non-cooperative providers, idempotent close, and late-provider quarantine. |
| PTY end to end | no-argument launch, initial prompt, two turns, Ctrl-C, Ctrl-D on empty input, non-TTY rejection, restored terminal, stable exit. |
| architecture | CLI imports composition interfaces only; terminal renderer cannot import permission/tool/provider adapters. |

### 6.7 Failure and security cases

- A provider or synthetic tool string containing ESC, BEL, carriage return,
  backspace, OSC 8, OSC 52, or title-control bytes is rendered as escaped data.
- Pasted newlines do not submit multiple hidden commands; the user sees pasted
  content before submission.
- Invalid UTF-8 becomes a bounded replacement/error event and cannot desynchronize
  the key decoder.
- Terminal output failure, EPIPE, raw-mode failure, missing dimensions, and
  stdin closure select the flat renderer or terminate with a stable category.
- Flat and raw turn-consumer rejections are observed immediately. `/exit`, EOF,
  and output failure use the same bounded application close; late consumer or
  renderer failures still produce infrastructure exit code `7` after terminal
  restoration, rather than becoming unhandled rejections or false success.
- Provider calls never start after parse failure or after turn cancellation.
- Tool calls execute serially. More than one call may be collected, but R1
  processes them in provider order and records each boundary; malformed calls
  prevent their own execution.
- A synthetic script mismatch fails the test/run instead of falling back to a
  canned response.
- R1 creates no credential record and makes no network call.

### 6.8 Migration, documentation, and installation work

R1 introduces no durable session migration. The source installation remains
`npm ci`, `npm run build`, and the workspace CLI invocation documented in the
README. The package tarball PTY test uses a temporary npm prefix to prove the
binary works outside the monorepo. Docs label the default provider as synthetic
and the repository tools as fixtures. R1 adds a terminal compatibility page with
known behavior for Terminal.app, iTerm2, common Linux terminals, `TERM=dumb`, CI,
and redirected streams; the matrix contains only actually tested environments.

### 6.9 Acceptance evidence

R1 is accepted only when a recorded PTY run proves all of the following:

- `robin` enters interactive mode without a subcommand;
- a developer submits a prompt, sees streamed text and two visible synthetic tool
  calls, receives a final answer, then asks a state-dependent follow-up;
- queued input, resize, no-color/flat mode, one-SIGINT cancellation, and
  two-SIGINT forced exit pass deterministic tests;
- terminal modes are restored after success, provider error, tool error,
  cancellation, and renderer failure;
- the same turn coordinator powers the implemented experimental `--print`
  transcript, while its output objects remain explicitly unstable and the
  target `--output`/`--no-session` automation contract remains open through R7;
- no real repository, provider, API key, durable resume, or sandbox claim appears
  in release notes.

Acceptance evidence is recorded at reviewed head `9907287` and merge commit
`fb64cf1`: local gates, the clean package artifact, hosted Linux/macOS matrix,
prerequisite merge, aggregate, and post-merge workflow all passed. These facts
do not widen R1 beyond its synthetic, credential-free scope.

### 6.10 Explicit deferrals

R1 defers physical repository access, file writes, live commands, Git, durable
sessions, context compaction, a real provider, credentials, persistent approval
rules, command sandboxing, headless public schemas, extensions, subagents,
background work, and editor clients.

### 6.11 Requirements traced

R1 owns the initial implementation of `FR-CLI-001–002`, `FR-CLI-005`,
`FR-CLI-007–010`, `FR-UI-001–012`, `FR-AGT-001–007`, `FR-AGT-009–012`,
`FR-BUD-001`, `FR-AUTO-004`, `NFR-REL-004`, `NFR-PERF-002`,
`NFR-A11Y-001–004`, and `NFR-MAINT-001–003`. Persistence-dependent clauses in
these requirements remain open through R3.

## 7. R2 — Real Repository, Editing, Process, Verification, and Git Review

**Status:** implementation in progress on `codex/robin-r2-real-tool-loop`.

**Effort range:** 5–8 part-time weeks.

**Candidate snapshot:** The branch currently implements and unit/integration
tests the physical workspace, path containment, list/search/read, structured
patch/create, atomic-write, edit-ledger, direct-process, controlled-Git,
eight-tool composition, one-use approval, deterministic two-step repair, and
bounded live-output layers. The CLI defaults to that composition, discovers the
launch worktree, shows root/branch/dirty/no-sandbox facts, and retains R1 through
`--model synthetic-r1-v1`. Complete raw-PTY acceptance, repository-safety
aggregation, reviewed package-inventory refresh, clean execution of the newly
configured package/hosted R2 gates, evidence capture, and reviewed-head/merge
acceptance remain open. Presence on this branch is not R2 acceptance.

### 7.1 Why R2 exists

R2 is the first complete coding workflow. A deterministic agent must diagnose a
real fixture repository, read the relevant code, apply a bounded edit, run a
targeted verification command, interpret a failure or success, and show the
cumulative Git diff. This phase prioritizes the daily developer loop over deeper
policy, database, or daemon work.

R2 edits a caller-selected live workspace because that is the expected terminal
coding-agent experience. It protects pre-existing changes through an initial Git
snapshot, per-file preimages, an edit ledger, exact path checks, and explicit
approval. Isolated worktrees arrive in R9 for parallel or higher-risk tasks; R2
must not imply that live-workspace editing has worktree isolation.

### 7.2 Prerequisites

- R1 is accepted and its PTY, reducer, cancellation, and terminal restoration
  suites remain green.
- Gate B canonical virtual-path and context-release cases are available as a
  reference corpus.
- Git is invoked as an executable with an argument vector, never through a shell
  string.
- R2 tests create repositories under unique temporary directories and never use
  the Robin source checkout as a mutation fixture.

### 7.3 Packages, files, interfaces, and records

Use the accepted `packages/capability-repository` corpus as test input, and
create `packages/tool-workspace` with:

- `src/physical-workspace.ts`: discover and bind one physical workspace;
- `src/workspace-identity.ts`: canonical root, filesystem identity where
  available, Git common directory, initial HEAD, branch, and repository ID;
- `src/physical-path.ts`: lexical normalization, canonical parent resolution,
  containment, symlink policy, and open-time checks;
- `src/file-walker.ts`: bounded ignored-file-aware traversal;
- `src/physical-list-files.ts`, `src/physical-search-text.ts`, and
  `src/physical-read-file.ts`: real read tools;
- `src/ignore-rules.ts`: Robin ignore, Git ignore, hard exclusions, and source
  attribution;
- `src/file-classification.ts`: regular/symlink/directory/device, encoding,
  binary, generated, secret-likely, size, and media classification;
- physical-path, race, symlink, ignore, Unicode, encoding, and resource-limit
  test corpora;
- `src/edit-schema.ts`: strict schemas for `apply_patch@1` and `create_file@1`;
  delete/move schema and registration remain later-gate work and are absent
  from the exact R2 tool catalog;
- `src/structured-patch.ts`: bounded parser and canonical representation;
- `src/patch-application.ts`: exact-preimage patch algorithm;
- `src/atomic-file.ts`: same-directory temporary file, metadata handling, fsync,
  rename, cleanup, and platform capability report;
- `src/edit-ledger.ts`: initial file facts and Robin-owned edit transitions;
- `src/diff-artifact.ts`: bounded human/model diff with full content hash;
- parser, stale-preimage, newline, mode, disk-full, partial-write, and race tests.

The R2 patch input is intentionally structured and one-file-per-call:

```ts
interface ApplyPatchV1 {
  readonly path: WorkspaceRelativePath;
  readonly expectedSha256: Sha256;
  readonly expectedSize: number;
  readonly hunks: readonly ExactReplacementHunk[];
}

interface ExactReplacementHunk {
  readonly oldText: string;
  readonly newText: string;
  readonly expectedOccurrences: 1;
  readonly expectedStartLine?: number;
}
```

Hunks apply in declaration order to an in-memory candidate. Each `oldText` must
occur exactly once in the current candidate; `expectedStartLine` is a bound
precondition and a mismatch fails rather than enabling fuzzy application. The
complete source preimage hash and byte length are checked immediately before
computation and again before rename. Empty `oldText`, overlapping hunks, unpaired surrogate
input, forbidden control bytes, excessive hunk count, excessive aggregate bytes,
and a result above the file limit are rejected. New files use a distinct
`create_file@1` request with an expected-absent precondition. Deletes and moves
are not registered in the R2 tool catalog.

Create `packages/tool-process` with:

- `src/process-schema.ts`: `executable`, `argv`, workspace-relative `cwd`,
  environment additions, timeout, output limit, and declared intent;
- `src/executable-resolution.ts`: explicit path or allowlisted PATH resolution;
- `src/environment-policy.ts`: minimal inherited environment and key filtering;
- `src/process-controller.ts`: spawn, process-group ownership, signal escalation,
  exit collection, and child cleanup;
- `src/output-multiplexer.ts`: ordered stdout/stderr chunks, UTF-8 safe display,
  raw hash, bounded head/tail retention, and truncation markers;
- `src/verification-discovery.ts`: read-only suggestions from known manifest
  scripts without automatically running repository text;
- spawn, timeout, output flood, child process, signal race, invalid cwd,
  executable-change, and environment-leak tests.

Create `packages/tool-git` with:

- `src/git-runner.ts`: controlled Git executable, fixed environment, limits, and
  error mapping;
- `src/repository-discovery.ts`: root, common directory, HEAD, branch, remotes,
  and worktree identity;
- `src/status-porcelain-v2.ts`: NUL-delimited porcelain v2 parser;
- `src/git-diff.ts`: no-external-diff, no-textconv bounded diff;
- `src/git-read-tools.ts`: controlled status/diff primitives plus bounded log
  support for internal conformance; the public R2 catalog exposes only
  `robin.git.status@1` and `robin.git.diff@1`, while branch facts come from
  bound startup/status metadata;
- byte fixtures for spaces, tabs, newlines, Unicode, invalid bytes, rename/copy,
  unmerged state, unborn branch, detached HEAD, submodule, and bare repository.

Add tool definitions to the existing gateway:

| Tool ID | R2 permission | Output returned to model |
| --- | --- | --- |
| `robin.repo.list_files@1` | allow inside bound root | bounded path metadata and omitted count |
| `robin.repo.search_text@1` | allow inside bound root | bounded path/line/match snippets and omitted count |
| `robin.repo.read_file@1` | allow unless classified/denied | bounded text window, encoding, file hash, line range |
| `robin.edit.apply_patch@1` | ask | result hash, changed-line summary, bounded diff |
| `robin.edit.create_file@1` | ask | new hash, size, bounded diff |
| `robin.process.run@1` | ask | exit/signal/duration, bounded stdout/stderr, truncation |
| `robin.git.status@1` | allow | structured status with initial/Robin/external attribution |
| `robin.git.diff@1` | allow | bounded diff and full diff hash |

Add `WorkspaceSessionState` to `packages/robin-session`:

```ts
interface WorkspaceSessionState {
  readonly identity: WorkspaceIdentity;
  readonly initialSnapshot: GitWorkspaceSnapshot;
  readonly editLedger: EditLedgerSnapshot;
  readonly activeProcess?: ProcessHandle;
  readonly discoveredVerification: readonly VerificationSuggestion[];
}
```

R2 keeps this state in memory. R3 defines its durable records.

### 7.4 Workspace discovery and containment algorithm

1. Resolve the requested start directory with `realpath` and require a directory.
2. Invoke `git rev-parse --path-format=absolute --show-toplevel` and
   `git rev-parse --path-format=absolute --git-common-dir` with a bounded timeout.
3. If the directory is not a Git worktree, fail with a bounded configuration
   error before starting the agent. An explicit non-Git/read-only workspace mode
   is not part of the R2 CLI surface.
4. Resolve the physical root and common directory, record filesystem device and
   inode when the platform exposes stable values, record HEAD/branch/status, and
   assign a workspace identity hash over canonical facts.
5. For every requested relative path, reject NUL, absolute forms, drive/UNC
   forms, empty segments, `.`/`..`, platform separator ambiguity, Unicode forms
   that cannot round-trip, and a path above component/byte limits.
6. Resolve the physical parent chain beneath the root. R2 lists symlinks as
   metadata but denies reading or writing through symlinks. A symlink encountered
   in any parent component is a precondition failure.
7. Open a read file with no-follow semantics where supported, `fstat` the open
   handle, require a regular file, enforce the byte limit before allocation,
   read the requested bounded range, and `fstat` again. A changed identity,
   size, or modification time is reported as drift.
8. Immediately before a write, repeat parent containment and target identity
   checks. Never rely only on facts obtained during normalization or approval.

Ignore precedence is: hard security exclusions, explicit user include for the
current call when legal, `.robinignore`, Git ignore, then default generated/cache
patterns. A user may inspect why a path was omitted. An include cannot override
secret, device, outside-root, unsupported media, or byte-limit denial.

### 7.5 Listing, search, and read algorithms

`list_files` walks lazily with a queue bounded by maximum depth, entries, total
path bytes, and wall time. Directory entries are sorted by raw stable comparison
within each directory for deterministic output. It does not read file contents.
It returns an omission summary by reason.

`search_text` uses literal UTF-8 search by default. The built-in implementation
streams regular files through a fixed-size byte buffer with overlap equal to the
query byte length minus one, tracks byte and line offsets, caps files/matches/
bytes/time, and rejects a query above the configured limit. When `rg` is present,
an optional adapter may use `rg --json --fixed-strings` with an explicit path
list; its JSON output passes a bounded parser and conformance suite against the
built-in implementation. Regex search is deferred.

`read_file` detects a UTF byte-order mark, validates UTF-8, distinguishes binary
using NUL/control-density heuristics, preserves reported newline style, and
returns line or byte windows with explicit truncation. It hashes the complete
file through a streaming SHA-256 pass only after size and classification permit
the read. Secret-likely files such as `.env`, private keys, credential files, and
high-confidence token patterns are withheld through the existing context broker;
the reason contains no secret substring.

### 7.6 Edit and attribution algorithm

Before Robin's first mutation, capture:

- HEAD and branch;
- porcelain v2 status;
- staged and unstaged path identities;
- hashes for files touched later, obtained lazily at first touch;
- untracked status for a path before Robin creates it.

For `apply_patch@1`:

1. validate and normalize without opening the target;
2. derive an ask decision containing path, expected hash, hunk count, estimated
   changed bytes, and current workspace identity;
3. after approval, re-resolve the parent and open the source with no-follow;
4. read and hash the complete bounded file; require expected hash and size;
5. apply exact replacements in memory and compute the candidate hash and diff;
6. create a random same-directory temporary file using exclusive creation and
   owner-only initial permissions;
7. write all bytes with short-write handling, apply the documented preserved
   mode bits, flush the file, and close it;
8. recheck the target identity and preimage by a new handle;
9. rename the temporary file over the target and flush the directory where the
   platform exposes a supported operation;
10. reopen and verify candidate hash;
11. append an edit-ledger entry containing before/after identity, hashes, bytes,
    approval, action ID, timestamp, initial-dirty classification, and diff hash;
12. if verification after rename cannot prove the postimage, mark the action
    uncertain and stop further mutation until reconciliation.

A write is attributed as Robin-owned only while the current file hash equals a
recorded Robin postimage connected to its observed initial preimage. If the user
or another process changes it, status becomes `mixed_or_external`. R2 never
reverts based only on a filename.

### 7.7 Process and verification algorithm

R2 accepts a structured executable plus argv. Explicit shell text is not exposed
as a model tool. The adapter resolves the executable immediately before approval
and execution, binds its canonical path and file identity where available,
constructs a minimal environment, and rejects variables matching credential or
secret patterns. Allowed inherited variables are limited to locale, terminal
capability where needed, safe temporary-directory selection, and a reviewed PATH;
Git/provider credentials and agent sockets are removed.

On POSIX, Robin spawns a new process group. It streams stdout and stderr through
separate readers into a sequence-numbered multiplexer. The human renderer may
coalesce, while persistence/model views retain channel and order metadata.
Memory stores a bounded head and tail plus byte count and full streaming hash.
When the timeout, user cancellation, or output hard limit fires, Robin sends
SIGTERM to the process group, waits the injected grace deadline, then sends
SIGKILL. It awaits pipe closure and child exit before reporting completion.

Verification suggestions come from recognized manifest fields, never prose:

- npm-family `scripts.test`, `scripts.check`, `scripts.lint`, and package manager
  lockfile identity;
- Cargo metadata commands and `cargo test` suggestion;
- Python project metadata and a discovered existing test command;
- Go module presence and `go test ./...` represented as executable plus argv.

Discovery displays a suggestion. Only a model request followed by permission or
an explicit user invocation runs it. Repository lifecycle scripts receive no
special trust.

### 7.8 Git read algorithm

Git reads run with `LC_ALL=C`, prompts disabled, optional locks disabled where
supported, no pager, no color, no external diff, and no text conversion. Robin
does not load or execute repository-defined diff drivers for the model view.
Status uses porcelain v2 with `-z` and preserves path bytes until the boundary
parser validates a displayable workspace-relative identity. Diff is limited by
bytes/files/time; truncation includes a full-output hash only if the full stream
was actually consumed within the raw artifact limit.

R2 exposes no Git mutation tool. It shows initial versus current status and
labels a path `pre_existing`, `robin_owned`, `mixed_or_external`, or `unknown`
using the initial snapshot and edit ledger. The UI does not claim authorship from
`git diff` alone.

### 7.9 Implementation tickets and sequence

1. **R2.01 — Generate repository fixture factory.** Programmatically create
   clean, dirty, untracked, detached, unborn, nested, symlink, Unicode, newline,
   merge-conflict, and malicious-name repositories under unique temp roots.
2. **R2.02 — Bind workspace identity.** Implement discovery, canonical root and
   common-dir facts, initial status, bounded non-repository failure, and drift
   snapshots.
3. **R2.03 — Close path containment.** Port the Gate B corpus to physical paths;
   add open-time parent/target checks, no-follow reads, symlink denial, platform
   path cases, and rename-race injection.
4. **R2.04 — Implement physical listing.** Add ignore reasons, deterministic
   ordering, entry/depth/path/time budgets, devices/sockets exclusion, and
   omission counts.
5. **R2.05 — Implement literal search.** Build the streaming matcher; test
   boundary-spanning matches, Unicode, long lines, cancellation, binary skip,
   and result limits. An optional ripgrep adapter is not required or claimed in
   R2.
6. **R2.06 — Implement bounded read.** Add encoding/binary/secret classification,
   windows, complete hash, before/after `fstat`, provenance, and withheld output.
7. **R2.07 — Define edit schemas and parser.** Add strict Ajv schemas and semantic
   limits; property-test hunk ambiguity, overlap, occurrence count, line-ending,
   and candidate-size behavior.
8. **R2.08 — Implement atomic edit path.** Add temporary creation, short-write
   loop, mode handling, flush/rename/reopen verification, cleanup, failure
   injection at every boundary, and uncertain-result classification.
9. **R2.09 — Implement edit ledger.** Capture lazy preimages, initial dirty state,
   actions, diff artifacts, attribution transitions, and external-change tests.
10. **R2.10 — Implement process runner.** Add structured spawn, executable
    resolution, environment filter, process group, stream multiplexer, timeout,
    output limits, cancellation, and orphan detection.
11. **R2.11 — Implement verification discovery.** Parse supported manifest fields
    with byte limits, show suggestions, and test malicious scripts as untrusted
    argv rather than automatic execution.
12. **R2.12 — Implement Git read tools.** Add controlled runner, porcelain parser,
    bounded public status/diff, startup branch facts, initial/current comparison,
    and malicious Git metadata fixtures.
13. **R2.13 — Register tools and manual permissions.** Route every operation
    through the gateway; register exactly the eight documented tools, allow
    bounded reads, ask for edit/process, omit delete/move/shell/network/Git
    mutations, and render exact request scope.
14. **R2.14 — Extend the synthetic scenario.** Require list, search, read, patch,
    test, a follow-up read or edit when the first test fails, final passing test,
    status, and diff before the final answer.
15. **R2.15 — Add PTY approval flow.** Test approve once, deny with observation,
    user cancel, stale file after display, process cancel, long output, and final
    diff summary.
16. **R2.16 — Add repository safety oracle.** Snapshot every path outside the
    fixture root and the fixture's initial Git object/index state; assert no
    outside change, no Git write, no hidden reset, and exact cleanup after each
    end-to-end case.
17. **R2.17 — Document real-workspace preview.** Explain live-workspace edits,
    permission defaults, unsupported symlinks/shell/Git writes, output limits,
    attribution labels, and a disposable-repository demo command.

#### 7.9.1 Candidate progress ledger

These statuses describe implementation on the active branch, not R2 acceptance.
“Implemented and focused-tested” means the named package/source boundary has
automated evidence; it does not waive the aggregate and hosted acceptance work
in section 7.13.

| Ticket | Candidate status | Current evidence boundary |
| --- | --- | --- |
| R2.01 | implemented and focused-tested | Generated real-Git fixtures cover clean, dirty, untracked, nested, symlink, odd-name, branch, and repository-safety cases under unique temporary roots. |
| R2.02 | implemented and focused-tested | Physical root, Git repository/worktree identity, HEAD/branch and initial status bind at bootstrap; startup metadata is presentation-only. |
| R2.03 | implemented and focused-tested | Lexical and physical containment, no-follow/symlink policy, parent/target identity, race and hostile-path tests exist in `tool-workspace`. |
| R2.04–R2.06 | implemented and focused-tested | Bounded deterministic list, explicit-path literal search, and classified whole/byte/line reads enforce resource and withholding limits. |
| R2.07–R2.09 | implemented and focused-tested | Strict patch/create schemas, exact-preimage application, atomic publication/reverification, bounded diffs, stale rejection and edit-ledger attribution are covered. |
| R2.10 | implemented and focused-tested | Direct spawn without shell, trusted executable revalidation, filtered environment, ordered bounded output, timeout/cancel escalation and process-tree reconciliation are covered. |
| R2.11 | implemented and focused-tested as a package boundary | Manifest-based verification suggestions exist; the current synthetic workflow deliberately requests only direct `npm test`. No arbitrary model workflow is claimed. |
| R2.12 | implemented and focused-tested | Controlled Git discovery, porcelain status and bounded diff are present; the public agent catalog remains read-only status/diff. |
| R2.13 | implemented and focused-tested | Exactly eight R2 tools use the capability gateway; reads allow, edits/process ask once, `plan` denies effects, and grants bind immutable action/request/precondition/policy facts. |
| R2.14 | implemented and application-tested | The synthetic provider performs list/search/read/edit/test, failure/re-read/second-edit/retest, status and diff against a generated physical repository. |
| R2.15 | in progress | Raw/flat approval and ordered live-output unit/integration coverage exists; the complete generated-repository PTY matrix and hosted evidence must still close. |
| R2.16 | in progress | Fixture safety oracles and application tests preserve pre-existing dirty/untracked content and assert unchanged HEAD/index; complete effect/failure aggregation remains open. |
| R2.17 | in progress | Current docs explain the live-workspace/manual-approval/ephemeral/unsandboxed fixture and provide a disposable demo; final package/evidence references wait for the frozen candidate. |

### 7.10 Test-driven evidence matrix

| Suite | Required cases |
| --- | --- |
| physical path | traversal variants, absolute/UNC/drive paths, repeated separators, NUL, Unicode normalization, symlink parents/targets, rename swap, hard links, device files, root replacement. |
| listing/search/read | ignore precedence, generated/binary/secret files, huge tree, huge file, long line, byte/line windows, encoding errors, cancellation, deterministic ordering, omission reasons. |
| patch parser | zero/many occurrences, overlap, stale hash/size, CRLF/LF, final newline, Unicode, excessive hunk/bytes, candidate overflow, malformed schema. |
| atomic file | short write, no space, permission error, temp collision, flush failure, rename failure, post-rename uncertainty, signal at each injected step, temp cleanup. |
| edit attribution | clean edit, pre-dirty edit, user changes before approval, user changes after Robin edit, untracked creation, ambiguous postimage, outside tool mutation. |
| process | missing/changed executable, hostile argv, no shell expansion, cwd escape, env canary, stdout/stderr flood, timeout, descendant survival, simultaneous signal/exit, output hash/truncation. |
| Git parser | porcelain record types, rename pairs, conflict stages, odd path bytes, detached/unborn/bare/submodule, pager/config attack, external diff/textconv disabled, output cap. |
| end to end | diagnose/fix/pass, diagnose/first test fails/fix/pass, denied edit, stale approval, cancelled test, dirty workspace preservation, final status/diff. |

Property generators must create path components, edit hunk locations, fragmented
process output, and NUL-delimited Git records from fixed seeds. Every discovered
escape or corruption bug receives a permanent minimal fixture and a short
incident note.

### 7.11 Failure and security cases

- A root or parent directory replaced after workspace discovery invalidates the
  operation. Robin does not silently bind to the new target.
- Symlinks are visible but unreadable/unwritable in R2. The model receives a
  denial observation without the outside target content.
- Hard links inside the workspace are reported in diagnostics; before/after
  identity and link-count changes are checked. R2 refuses edits to a multiply
  linked file on platforms where outside-link impact cannot be bounded.
- File reads and diffs containing terminal controls are escaped before rendering.
- A malicious filename beginning with `-` is passed after `--` or through
  NUL-delimited Git protocols and never parsed as an option.
- Process argv receives no shell interpolation. `$()`, backticks, redirects,
  glob characters, semicolons, and newlines are literal arguments.
- Commands receive no provider key, SSH agent, cloud token, Git credential helper
  secret, daemon token, or full parent environment.
- A child that forks, ignores SIGTERM, closes stdio, or floods output cannot make
  Robin report cancellation before process-group reconciliation.
- Git config, attributes, hooks, aliases, pager, external diff, and textconv do
  not become executable model-read paths. Unsupported safe suppression fails the
  relevant Git operation.
- Repository changes after approval produce `approval_stale`; the user must see
  the new request and diff.
- An edit that cannot be reconciled after rename stops all further mutation in
  the session and points to exact files for human inspection.

### 7.12 Migration, documentation, and installation work

R2 adds no durable user-data migration, but its tool schemas are versioned from
their first commit. The README gains a disposable sample repository flow and a
prominent warning that sessions are still ephemeral and commands are not
sandboxed. `robin doctor` remains unimplemented and reserved for a later gate;
R2 startup itself reports only the bound worktree/branch/dirty state and explicit
ephemeral/no-filesystem-isolation/no-network-isolation facts.

Contributor docs define fixture creation, temp-root safety, how to run the PTY
suite, and how to inspect a failed safety oracle. The source install test must
verify that Git absence or a non-worktree launch produces a bounded configuration
failure rather than a crash or an invented fallback. Packaging continues to be
development-only.

### 7.13 Acceptance evidence

R2 is accepted only when a deterministic PTY demonstration in a generated real
Git repository proves:

- Robin binds the expected repository and displays its branch and dirty state;
- the scripted agent lists, searches, reads, edits, runs verification, handles at
  least one failed verification in one scenario, then shows status and diff;
- edits and commands pause for exact approval while bounded reads are visible;
- denying an action returns a useful observation and does not terminate the
  session unless budgets are exhausted;
- the original fixture's pre-existing dirty and untracked content is unchanged
  except for the exact approved Robin paths;
- traversal, symlink, stale-preimage, secret-read, command injection, output
  flood, timeout, process-tree, and Git parser suites pass;
- no process remains and no temp file escapes cleanup after every test;
- docs say live-workspace/manual-permission/no-sandbox and make no durability or
  real-provider claim.

### 7.14 Explicit deferrals

R2 defers durable sessions, resume, context compaction, real model calls, BYOK,
persistent permission rules, strict sandbox enforcement, shell tool, network
tool, file deletion/move, Git stage/commit/branch/push/PR, edit rewind, concurrent
turns, worktrees, extensions, background runs, and editor clients.

### 7.15 Requirements traced

R2 owns `FR-REP-001–010`, begins `FR-EDIT-001–012`, owns the foreground subset
of `FR-PROC-001–006` and `FR-PROC-010`, begins `FR-GIT-001–003` and
`FR-GIT-008–009`, completes the real-tool portions of `FR-AGT-003–007`, and
advances `FR-CTX-003–006`, `FR-PERM-001–006`, `FR-UI-003–005`,
`NFR-SEC-001–005`, `NFR-REL-003–004`, `NFR-PERF-003`, and
`NFR-PORT-002–003`. Persistent edit, approval, and resume clauses remain open
through R3, R5, and R6.

## 8. R3 — Durable Sessions, Resume, Context Assembly, and Compaction

**Status:** planned.

**Effort range:** 5–8 part-time weeks.

### 8.1 Why R3 exists

A coding agent becomes a daily tool only when the developer can leave, return,
understand what will be sent to the model, and trust that Robin will not invent a
completed action after a crash. R3 makes the R2 loop durable locally before any
API credential or provider transcript is introduced. A synthetic provider keeps
recovery and context behavior deterministic.

### 8.2 Prerequisites

- R2 is accepted, including edit/process uncertainty categories and workspace
  safety oracles.
- The canonical application event union has schema versions and stable event IDs.
- `robin-platform` can resolve platform configuration, durable-data, cache, log,
  runtime-lock, and recoverable-trash directories without reading model input.
- R3 format design is reviewed before a user session is created; on-disk formats
  are never introduced as unversioned JSON files.

### 8.3 Packages, files, interfaces, and durable state

Create `packages/robin-session` modules:

- `src/session-record.ts`: versioned durable event union and parsers;
- `src/session-projection.ts`: pure replay reducer for header, conversation,
  invocations, tool executions, edits, approvals, workspace facts, budgets, and
  terminal status;
- `src/resume-plan.ts`: classify normal resume, safe drift, required fork,
  quarantine, and unfinished-effect recovery;
- `src/session-commands.ts`: create, open, submit, close, list, inspect, name,
  branch, export, archive, delete, and purge intents;
- `src/conversation-item.ts`: normalized user, assistant, tool-call, tool-result,
  summary, attachment, and omission items;
- `src/context-window.ts`: active item ranges and compaction boundaries;
- `src/migrations.ts`: pure old-record-to-new-record transformations and version
  support table.

Create `packages/local-state` modules:

- `src/platform-layout.ts`: typed state roots supplied by `robin-platform`;
- `src/event-log/header.ts`, `frame.ts`, `writer.ts`, `scanner.ts`, and
  `recovery.ts`: framed append log;
- `src/session-lock.ts`: exclusive writer record, heartbeat, liveness, and
  explicit takeover evidence;
- `src/session-store.ts`: `SessionStore` implementation and subscriptions;
- `src/snapshot-store.ts`: validated replay acceleration;
- `src/cas.ts`: session-scoped content-addressed blobs;
- `src/index-store.ts`: rebuildable session/project indexes;
- `src/artifact-view.ts`: typed authorization and bounded reads;
- `src/retention.ts`: mark, recoverable trash, grace, and purge;
- `src/migration-runner.ts`: copy-validate-switch migrations;
- `src/fault-filesystem.ts`: deterministic crash/short-write/flush/rename faults.

Create `packages/robin-prompt` modules:

- `src/prompt-package.ts`: provider-neutral system/developer/user/conversation/
  tool semantic items;
- `src/instruction-layer.ts`: built-in Robin behavior and R3 explicit user text;
- `src/context-selector.ts`: budgeted selection of conversation, workspace
  metadata, and released tool observations;
- `src/token-budget.ts`: provider tokenizer port plus conservative estimator;
- `src/context-manifest.ts`: item source, trust, bytes, tokens, hash,
  transformation, range, retention, and omission reason;
- `src/compaction-plan.ts`: choose a closed message range and required retained
  facts;
- `src/deterministic-summary.ts`: synthetic-test summary representation;
- `src/request-compiler.ts`: assemble immutable semantic request and request hash.

Extend `packages/robin-application` with durable start/continue/resume/session
administration use cases. Extend `packages/robin-terminal` with a session picker,
drift report, `/context`, `/compact`, `/clear`, `/status`, `/rename`, `/export`,
and `/exit`. Slash commands become application commands and are never inserted
into provider text unless a command contract explicitly produces a user message.

### 8.4 State locations and permissions

`robin-platform` resolves paths as follows unless a documented trusted launch
override is present:

| Purpose | macOS | Linux |
| --- | --- | --- |
| configuration | `~/Library/Application Support/Robin/config` | `$XDG_CONFIG_HOME/robin` or `~/.config/robin` |
| durable data | `~/Library/Application Support/Robin/data` | `$XDG_DATA_HOME/robin` or `~/.local/share/robin` |
| cache | `~/Library/Caches/Robin` | `$XDG_CACHE_HOME/robin` or `~/.cache/robin` |
| logs | `~/Library/Logs/Robin` | `$XDG_STATE_HOME/robin/log` or `~/.local/state/robin/log` |
| runtime locks | durable data | `$XDG_RUNTIME_DIR/robin` with durable identity mirrored in data |

R3 creates directories with owner-only ordinary permissions and verifies owner,
type, symlink status, and group/world writability before durable use. A symlinked
or insecure root disables secret-bearing future operations and fails session
creation unless the user selects ephemeral mode. Project repositories receive no
transcript, cache, or credential file by default.

The durable layout is:

```text
data/
  format.json
  installation-id
  sessions/
    index.json
    by-id/
      <session-id>/
        manifest.json
        events.rlog
        writer.lock
        snapshots/
        cas/sha256/<prefix>/<digest>.blob
        journals/edits/
        journals/git/
        recovery/
  projects/index.json
  migrations/
  trash/
```

Indexes and manifests contain safe discovery hints. `events.rlog` is semantic
authority. Missing indexes are rebuilt from validated logs; an index never
overrides replayed state.

### 8.5 Event log and append algorithm

The file header uses magic `RBNELOG1`, format version, bounded header length,
flags, binary session UUID, creation time, initial chain seed, and SHA-256 header
hash. Each committed frame uses magic `RBNFRM01`, bounded header length, flags,
contiguous unsigned sequence, payload length, CRC32C, zero reserved field,
previous-frame hash, payload SHA-256, canonical UTF-8 JSON payload, frame hash,
and commit marker `RBNCMT01`.

`frameHash` is SHA-256 over the domain `robin-session-frame-v1`, complete frame
header, and payload. A scanner never searches forward for a later magic value
after corruption because untrusted payloads can contain the same bytes.

Under an exclusive writer lock, append:

1. parses the event from `unknown`, canonicalizes it, and enforces session,
   schema, sequence, configuration snapshot, and payload limits;
2. computes checksum and hashes using streaming/spooled bytes when needed;
3. writes the complete frame with a short-write loop;
4. flushes semantic barriers: user acceptance, configuration pin, provider
   attempt start/settlement, approval response, tool prepared/start/settlement,
   edit/Git journal transition, turn terminal state, and session close;
5. advances the in-memory chain head only after the required flush succeeds;
6. atomically updates the manifest's last-sequence hint;
7. publishes the committed event to subscribers.

High-volume text and process deltas are live events, not individual durable
frames. The corresponding sealed text/output artifact is a durable event. If a
write or flush fails, the store becomes unhealthy, rejects later appends, and
requires reopen/recovery.

### 8.6 Lock and concurrency algorithm

A session permits one writer. Atomic exclusive creation writes schema version,
session/installation IDs, hostname digest, PID, process-start identity, random
nonce, Robin build, acquired time, and heartbeat time; the record is flushed
before ownership is assumed. The owner renews via atomic replace and verifies
the nonce before every append.

Heartbeat age alone does not prove a stale lock. `robin-platform` checks PID plus
process-start identity to prevent PID reuse. A proven-dead owner can be recovered
after moving its lock into session recovery evidence. Ambiguous liveness refuses
automatic takeover; `sessions recover --force-lock <id>` displays evidence and
requires exact confirmation. Clean close deletes only a lock with the same nonce.

Lock order is fixed: installation migration, trust/config, project index,
session index, session writer, session journal. No code waits for an earlier lock
while holding a later lock. In-process command serialization does not replace the
filesystem lock.

### 8.7 Scan, corruption, snapshot, and CAS algorithms

Open scans from the header, reads fixed-size frame headers, rejects lengths before
allocation, streams CRC/hash checks, verifies chain/sequence/commit marker, parses
the exact payload length, validates schema, and applies the pure reducer. EOF on
a frame boundary is clean.

An incomplete region beginning exactly at the expected next frame after a fully
valid history is a torn tail. Robin copies the tail and diagnostic hashes into
`recovery`, truncates to the last committed byte, flushes, then appends
`TailRepaired`. Any bad hash, sequence, schema, or transition within committed
history is middle corruption: open read-only to the last proven event, quarantine
the session, and never truncate through it.

A snapshot contains its schema/reducer version, session, included sequence and
frame hash, canonical projection, projection hash, referenced CAS manifest,
build, and migration provenance. It is written temp/flush/rename/verify. Open
selects the newest valid compatible snapshot and replays later frames. Invalid
snapshots fall back to full replay.

CAS blob creation streams bytes into a private temporary file while enforcing
size and SHA-256, flushes/closes, derives the final digest path, verifies any
existing object, installs without overwrite, flushes the directory where
supported, reopens, and verifies before returning a reference. The event
reference is appended after object verification. Model input cannot supply a CAS
path or use a hash as authorization. Missing referenced content required for
resume is a recovery error.

### 8.8 Durable event and projection model

R3 implements the canonical durable names from the architecture; it does not
invent a parallel `*Persisted`, `*Pinned`, or generic `*Settled` vocabulary.
The R3 session schemas and reducer cover these families as their associated
features become available:

```text
SessionCreated, SessionOpened, SessionRenamed, SessionClosed
WorkspaceBound, WorkspaceStateObserved, ConfigurationPinned, SessionForked
RecoveryStarted, TailRepaired, RecoveryCompleted, SessionQuarantined

UserSubmissionAccepted, UserAttachmentStored, SteeringQueued
TurnStarted, ContextAssemblyCompleted, TurnInterrupted
TurnCancellationRequested, TurnCancelled, TurnFailed, TurnCompleted
AssistantMessageSealed, TurnSummarySealed

ModelInvocationPrepared, ProviderRequestRecorded
ProviderAttemptStarted, ProviderResponseStarted
ProviderContentSealed, ProviderToolCallSealed, ProviderUsageRecorded
ProviderAttemptFailed, ModelInvocationCompleted
ModelInvocationOutcomeUncertain

ToolCallReceived, ToolCallRejected, ToolCallNormalized
PermissionEvaluated, ApprovalRequested, ApprovalResponded
ToolExecutionPrepared, ToolExecutionStarted, ToolOutputSealed
ToolExecutionCompleted, ToolExecutionFailed
ToolExecutionOutcomeUncertain, ChangedPathManifestRecorded

SnapshotWritten, CompactionRecorded, CasObjectReleased
```

`manifest.json`, `writer.lock`, edit/Git journals, CAS installs, archive moves,
and index hints remain local-store structures; names such as
`SessionWriterAcquired`, `EditJournalReferenced`, or `SessionArchived` are not
substitute canonical session events. Later gates extend the same union with
`TrustGranted`, `TrustRevoked`, `WorkspaceCheckpointRecorded`, hook/MCP, and
subagent events only when those features are implemented.

Provider attempts and tool effects have their exact prepared/started/terminal
facts; approvals use evaluated/requested/responded facts. Replay is side-effect
free. On resume, an unfinished read can be retried; an unfinished
edit/process/Git effect uses adapter-specific current-state reconciliation or
becomes uncertain. The projection never turns an absent terminal event into
success, and it derives only the persisted turn statuses defined in section
3.6 rather than serializing transient interaction phases.

Session names are normalized Unicode, bounded, stripped of controls, and unique
within the configured namespace. A branch copies no mutable log: it creates a new
session whose first event references an immutable parent session ID, parent
sequence, context manifest, workspace snapshot, and allowed CAS objects. Parent
deletion preserves referenced content until child retention is resolved.

### 8.9 Context compiler and compaction algorithm

Every provider request receives a `PromptPackage` in this order:

1. versioned Robin product instruction;
2. active permission/tool contract and provider capability facts;
3. trusted launch/user instruction text available in R3;
4. workspace identity, branch, dirty-state summary, and bounded file inventory
   metadata;
5. prior compacted summaries in chronological order;
6. un-compacted normalized conversation items;
7. current user message and explicitly attached stdin/resource content;
8. versioned tool definitions supported by the selected provider.

Repository content and tool output remain tagged with source, trust, hash,
range, transformation, and omission reason. They are never concatenated into the
system instruction role. Every request records a context manifest and immutable
semantic request hash before provider transmission.

Budget calculation reserves fixed system/tool overhead, configured output
tokens, provider continuation overhead, and a safety margin. It selects closed
conversation turns newest-first, then required tool-call/result pairs, then
optional older content. A tool result is never included without the tool call it
answers. A current user message is never silently truncated; oversize input
produces an explicit attachment/windowing flow.

Compaction chooses a closed sequence range ending before the active turn. Its
typed summary contains goals, user decisions, files and symbols examined, edit
hash transitions, verification commands/results, unresolved errors, permission
facts that remain descriptive rather than authorizing, provider/model boundary,
and covered event range/hash. R3 uses a deterministic synthetic summarizer for
tests. A later provider-generated summary must pass schema validation and be
checked against authoritative edit/tool facts. The original events remain local;
summary replacement changes prompt selection, not history.

`/context` displays totals and item categories without exposing withheld content.
`/compact` previews the candidate range and expected savings, then commits the
summary. `/clear` starts a new conversational branch bound to the same workspace;
it does not delete the old session.

### 8.10 Resume and drift algorithm

`--continue` filters sessions by canonical workspace identity and selects the
newest resumable session. `--resume` resolves an exact ID/name or interactive
picker; an ambiguous name is an error. Open acquires the writer lock, validates
the log, builds the projection, checks required CAS, and compares current
workspace root/common directory/HEAD/branch/status to the last snapshot.

Drift is classified:

- display-only: terminal size or harmless UI setting changed;
- safe configuration: a new non-executable user preference can be pinned;
- workspace changed: HEAD/branch/index/worktree differs but no unsettled effect;
- continuity-breaking: workspace identity differs, a Robin postimage was changed,
  provider representation cannot continue, or required context is missing;
- uncertain: an effect started without a reconcilable settlement;
- corrupt: committed history or required artifact fails validation.

Safe changes append a new snapshot and continue after display. Workspace changes
require a displayed accept-and-fork or return-to-workspace choice. Pending
approvals always expire on resume and are regenerated from live preconditions.
Uncertain and corrupt sessions cannot start another mutating turn.

### 8.11 Implementation tickets and sequence

1. **R3.01 — Freeze durable schemas.** Add byte fixtures for file header, event
   frames, session records, snapshots, CAS header, lock record, and index; test
   unknown versions/flags and every size bound.
2. **R3.02 — Build pure session replay.** Project all R1/R2 facts, assert every
   legal/illegal event order, keep effects out of reducers, and add old-schema
   migration fixtures.
3. **R3.03 — Implement platform layout.** Resolve macOS/Linux roots, trusted
   overrides, ownership/mode/symlink checks, private creation, and doctor output.
4. **R3.04 — Implement event-log scanner.** Validate header/frames/chains and
   classify clean EOF, torn tail, middle corruption, oversized field, unsupported
   version, and wrong session.
5. **R3.05 — Implement append writer.** Add expected sequence, short-write loop,
   durability classes, flush behavior, manifest hint update, subscriber publish
   barrier, unhealthy writer state, and injected failures.
6. **R3.06 — Implement session lock.** Add exclusive create, heartbeat, nonce,
   process-start liveness, PID reuse, lock loss, clean release, ambiguous stale
   state, and evidence-preserving force recovery.
7. **R3.07 — Implement CAS.** Add streaming limits/hash, no-replace install,
   existing-object verification, typed references, missing/corrupt handling, and
   unreferenced crash-object collection.
8. **R3.08 — Implement snapshots and indexes.** Add atomic writes, replay fallback,
   index rebuild, manifest disagreement resolution, and bounded scanning.
9. **R3.09 — Add fault-injection matrix.** Crash before/after every write, flush,
   close, rename, truncate, lock renewal, and directory flush; reopen raw bytes
   and assert an allowed documented projection.
10. **R3.10 — Persist application barriers.** Require
    `UserSubmissionAccepted` before provider work; exact model/provider and
    tool prepared/start/terminal records around external work;
    `ProviderContentSealed`, `AssistantMessageSealed`, and `ToolOutputSealed`
    for retained content; and one canonical turn terminal event before close.
11. **R3.11 — Implement session commands.** Create/list/inspect/name/branch/export/
    archive/delete-to-trash with exact selectors, locks, redacted outputs, and
    recoverable failure behavior.
12. **R3.12 — Implement prompt package and manifest.** Add role/trust separation,
    item hashes, tool-pair integrity, request hash, token estimator seam, output
    reserve, omission diagnostics, and deterministic snapshots.
13. **R3.13 — Implement compaction.** Select a closed range, produce/validate the
    typed synthetic summary, preserve authoritative facts, append prepared/
    committed events, and prove replay and prompt equivalence.
14. **R3.14 — Implement continue/resume.** Resolve by canonical workspace,
    reconcile drift, expire approvals, classify unfinished effects, and offer
    safe fork behavior.
15. **R3.15 — Add terminal session surfaces.** Implement picker, status/context/
    compact/clear/rename/export commands, ephemeral/durable indicator, recovery
    explanation, and inaccessible-session diagnostics.
16. **R3.16 — Add crash end-to-end tests.** Kill the CLI after user persistence,
    provider start, text seal, approval, edit prepare, edit rename, process start,
    process exit, and final response; resume and assert no fabricated or duplicate
    effect.
17. **R3.17 — Add lifecycle documentation.** Document exact data locations,
    locks, retention, export, delete-to-trash, purge limitations, crash recovery,
    and which content is required for exact resume.
18. **R3.18 — Gate the durable synthetic coding slice.** Run a two-process PTY scenario where
    process one edits and exits, process two continues, reconciles the workspace,
    completes verification, and exports a redacted transcript.

### 8.12 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| frame parser | every byte boundary, huge length, bad magic/version/flags/reserved, CRC/hash/chain/sequence/marker failure, invalid canonical JSON, wrong session. |
| append/reopen | short writes, flush failure, process death at each injected point, old/new committed projection only, no subscriber event before commit. |
| locks | two writers, PID reuse, delayed heartbeat, replaced nonce, owner crash, permission failure, ambiguous liveness, lock-order assertion. |
| CAS | zero/max/oversize, concurrent same digest, corrupt existing, missing referenced, incomplete compressed stream, invalid name/link count, interrupted collection. |
| replay/snapshot | empty/long session, every legal event, invalid transition, snapshot fallback, old reducer, index rebuild, manifest mismatch. |
| context | role separation, pair integrity, budgets, oversized current input, omission attribution, withheld secret, deterministic request hash, fake tokenizers. |
| compaction | only closed ranges, summary schema, facts preserved, no approval authority, provider/model boundary, repeated compaction, corrupt summary fallback. |
| resume | same workspace, branch/HEAD/index/file drift, missing provider, missing CAS, pending approval, active process, uncertain edit, corrupt middle, ambiguous name. |
| PTY crash | SIGKILL at semantic barriers, continue from new process, recovery explanation, stable workspace, no duplicate command/edit. |

### 8.13 Failure and security cases

- A group/world-writable, symlinked, wrong-owner, or non-directory state root is
  rejected before a transcript is written.
- Length fields are checked before allocation and arithmetic uses overflow-safe
  bounds. The scanner never trusts `seek` beyond verified file size.
- A torn tail after a valid frame may be archived and truncated; corruption
  inside committed history is quarantined, not repaired by skipping bytes.
- Lock heartbeat age never permits automatic theft from a process whose identity
  is live or ambiguous.
- Session selectors cannot contain paths and cannot escape `by-id`; directory
  names are derived only from validated opaque IDs.
- Export does not include credentials, withheld secret content, raw environment,
  internal lock nonce, or unrestricted tool artifacts. It labels omitted fields.
- Delete first moves the exact validated session directory to recoverable trash;
  purge is separate, reports targets, and cannot accept a broad root.
- A compacted summary cannot grant permission, certify that a command passed, or
  replace edit hashes. Authoritative records win on disagreement.
- An unfinished provider or effect is never replayed as if idempotent. Read-only
  retries are recorded; consequential uncertainty blocks mutation.

### 8.14 Migration, documentation, and installation work

R3 creates on-disk format version 1 and therefore must also ship:

- `robin sessions inspect`, `export`, `archive`, `delete`, and recovery-safe
  diagnostics;
- a format support table and a fixture generated by the oldest supported build;
- copy-validate-switch migration scaffolding even though the first migration has
  no source version;
- instructions for backing up `data` while Robin is closed, restoring without
  replacing credentials, and distinguishing cache from durable data;
- uninstall guidance that leaves data by default and exact separate commands for
  moving data to recoverable trash;
- `robin doctor` checks for permissions, free space, locks, format support, index
  consistency, and required artifacts without modifying them.

Source and temporary-prefix install tests must prove two processes resolve the
same state root and refuse simultaneous writers. No global production package is
claimed yet.

### 8.15 Acceptance evidence

R3 accepts the durable synthetic coding/session gate only when:

- a real-repository synthetic session persists messages, provider items, tool
  calls/results, approvals, edit facts, process results, context manifests,
  usage, and terminal state;
- `--continue` from a new process selects only the same physical workspace and
  resumes a follow-up turn;
- clean exit, SIGTERM, forced process death at every semantic barrier, and torn
  tail produce one documented recovery state with no duplicated effect;
- `/context` explains sent/withheld/compacted categories and `/compact` preserves
  required facts;
- session list/name/inspect/branch/export/archive/delete-to-trash work with exact
  selectors and redaction;
- two writers cannot own one session and ambiguous locks fail closed;
- replay, frame, CAS, lock, drift, migration-fixture, fault-injection, PTY, Gate
  A, and Gate B suites pass;
- docs state that providers remain synthetic and command isolation remains
  permission-only.

### 8.16 Explicit deferrals

R3 defers provider-generated summaries, a real provider, credentials, provider
fallback, persistent permission rules, strong command sandboxing, Git writes,
hooks, skills, MCP, subagents, concurrent sessions under a daemon, remote storage,
at-rest transcript encryption, editor clients, and telemetry.

### 8.17 Requirements traced

R3 owns `FR-SES-001–012`, `FR-CTX-001–010`, the persistence portions of
`FR-AGT-002`, `FR-AGT-007–011`, and the durability closure of `FR-EDIT-007`;
it carries the already-closed R2 attribution rule `FR-EDIT-008` into replay.
R3 also owns `FR-BUD-006`,
`FR-CLI-008–010`, and begins `FR-OPS-007–010`. It advances
`NFR-SEC-001`, `NFR-REL-001–005`, `NFR-PERF-003–004`,
`NFR-PRIV-001–004`, `NFR-PORT-001–003`, and `NFR-MAINT-004`.
Checkpoint grouping and rewind (`FR-EDIT-009–010`) remain exclusively owned by
R6; R3 supplies only the durable edit facts they later consume.

## 9. R4 — First Hosted-Provider Alpha, Model Selection, and BYOK

**Status:** planned.

**Effort range:** 4–7 part-time weeks.

### 9.1 Why R4 exists

R4 proves that Robin's own loop and tools work with a real cloud model. The
provider remains an inference adapter: it does not become the session manager,
tool executor, repository index, permission engine, or source of durable truth.
One carefully implemented provider is more valuable here than several shallow
adapters. This is the first end-to-end hosted-provider alpha, not the first
supported developer release; that bundle waits for every gate through R8.

The first production adapter targets the OpenAI Responses transport through the
official JavaScript SDK, with SDK retries disabled and Robin owning normalization,
retry classification, budgets, transcript items, and tool dispatch. R7 adds
Anthropic and bounded OpenAI-compatible/local endpoints. This choice is an
implementation order, not a product preference or universal-compatibility claim.

### 9.2 Prerequisites

- R3 is accepted with provider-attempt prepared/started/settled records and
  uncertain-result recovery.
- The selected official SDK version, license, transitive dependencies, default
  retry/telemetry/storage behavior, and supported Node range are pinned and
  reviewed in an ADR.
- The production model catalog names at least one exact tested model identifier
  and capabilities. Mutable aliases are labeled and never used for reproducible
  eval baselines.
- No live API key enters source, fixture, CI artifact, test snapshot, shell argv,
  GitHub Actions log, or pull request.

### 9.3 Packages, files, interfaces, and records

Extend `packages/model-provider` with:

- `src/provider-manifest.ts`: provider ID, adapter version, origins, auth
  strategies, streaming, tool-call, structured-output, image/input, continuation,
  token-usage, retention, and cancellation capabilities;
- `src/model-capability.ts`: exact model profile, tested date, mutable/pinned
  status, context/output limits, tool/parallel/structured/modal support;
- `src/semantic-request.ts`: provider-neutral instructions, messages, tool
  definitions, tool results, generation parameters, output contract, and
  continuation items;
- `src/normalized-provider-event.ts`: response start, text delta/seal, tool-call
  delta/seal, usage, stop, warning, and failure;
- `src/provider-error.ts`: stable auth/rate/transient/invalid/blocked/unsupported/
  uncertain classification;
- `src/provider-conformance.ts`: shared adapter contract driven by transport
  fixtures and synthetic semantic requests.

Create `packages/provider-openai` with:

- `src/openai-adapter.ts`: canonical `ModelProviderAdapter` implementation;
- `src/request-encoder.ts`: semantic request to SDK request without leaking
  provider objects outside the package;
- `src/event-decoder.ts`: bounded SDK/stream events to normalized events;
- `src/tool-codec.ts`: Robin tool schemas and tool-result continuation mapping;
- `src/error-classifier.ts`: HTTP, SDK, abort, parse, and transport mapping;
- `src/model-catalog.ts`: versioned tested model facts;
- `src/retention.ts`: explicit non-retention request fields when supported;
- `src/transport.ts`: injected SDK client/fetch seam with redirects disabled or
  origin checked;
- sanitized recorded fixtures for success, fragmented text/tools, refusal,
  length stop, content block, rate limit, server failure, invalid stream,
  disconnect, timeout, cancellation, and usage variants.

The request encoder, event decoder/normalizer, and continuation codec are
internal pipeline modules called by `invoke`; they are not public alternatives
to `probe`, `countInput`, `invoke`, `classifyUnknownError`, or
`redactDiagnostic`. R4 adapts the synthetic preview's temporary `respond` port
for conformance, moves product composition to `ModelProviderAdapter`, and then
retires the shim from production composition.

Create `packages/robin-config` with R4's minimal versioned configuration:

- `src/schema.ts`: provider profiles, model selection, credential reference,
  permission mode, budgets, state overrides, and unknown-field rejection;
- `src/sources.ts`: built-in defaults, trusted launch flags, user config, and R4
  read-only project candidate discovery;
- `src/merge.ts`: field-level precedence and source trace;
- `src/atomic-config.ts`: parse, validate, temp/flush/rename write;
- `src/explain.ts`: redacted effective value and source.

Extend `packages/robin-platform` with:

- `src/credentials/credential-record.ts`: secret-free identity and metadata;
- `src/credentials/resolver.ts`: exact source to origin-bound `SecretLease`;
- `src/credentials/environment.ts`: resolve one allowlisted variable name;
- `src/credentials/session-secret.ts`: hidden prompt held only for process life;
- `src/credentials/os-store.ts`: port for later persistent OS-keychain adapters;
- `src/hidden-input.ts`: TTY secret input that never echoes and always restores;
- `src/redaction.ts`: exact secret/canary replacement before any diagnostic sink.

R4 credential records contain:

```ts
interface CredentialRecordV1 {
  readonly id: CredentialId;
  readonly providerId: "openai";
  readonly authType: "bearer";
  readonly source:
    | { readonly kind: "environment"; readonly variable: "OPENAI_API_KEY" }
    | { readonly kind: "session_prompt" };
  readonly createdAt: Timestamp;
  readonly lastValidatedAt?: Timestamp;
  readonly redactedHint?: string;
}
```

The record never contains the secret value, a reversible encrypted copy, or an
arbitrary environment variable name. Persistent OS credential storage is an R7
requirement; R4 hidden input must be supplied again after process restart.

Add `robin auth add|list|inspect|validate|remove`, `robin models list|inspect`,
`--provider`, `--model`, and the first-run provider wizard to `apps/cli` through
`robin-application` use cases. `auth add` accepts hidden input or an exact
`--from-env OPENAI_API_KEY` reference; it never accepts a secret value as an
option or positional argument.

### 9.4 Provider request and streaming algorithm

1. Resolve the selected profile and exact model capability record before
   resolving secret bytes.
2. Compile the semantic request through `robin-prompt`; reject a requested tool,
   modality, structured output, or context size unsupported by the model record.
3. Persist `ModelInvocationPrepared` and `ProviderRequestRecorded` with semantic
   request hash, context manifest, provider/model/adapter versions, credential
   reference ID, budgets, retention request, and retry generation. No secret is
   included.
4. Resolve a `SecretLease` scoped to provider ID, exact HTTPS origin, auth type,
   invocation ID, and deadline.
5. Construct the official SDK client with automatic retries and provider-side
   logging disabled where configurable. Bind authorization only at the transport
   call; do not mutate global environment.
6. Set provider retention off when the adapter capability says the request field
   is supported. Record the requested behavior and do not claim enforcement the
   provider cannot attest.
7. Append `ProviderAttemptStarted` immediately before handing the request to
   transport and `ProviderResponseStarted` only after the response boundary is
   validated.
8. Decode streamed events with item-count, nesting, argument-byte, text-byte,
   duration, and total-event limits. Validate provider item identities and order.
9. Seal complete normalized text/tool items into durable session records. Live
   deltas are UI events only.
10. Route sealed tool calls through the existing R2 pipeline serially. Return
    normalized tool results using provider continuation semantics owned by the
    adapter.
11. On final stop, validate that all started content/tool items are sealed,
    append `ProviderUsageRecorded` and `ModelInvocationCompleted`, and store the
    raw stop category plus safe unknown metadata. Failure uses
    `ProviderAttemptFailed`; ambiguity uses `ModelInvocationOutcomeUncertain`.
12. Zeroize in-memory secret buffers where practical, release the lease, and
    remove references from transport objects. JavaScript garbage collection
    prevents a claim of guaranteed physical memory erasure.

Parallel tool calls are disabled in R4. If the provider emits a batch despite
the request, Robin records each sealed call but executes them serially in
provider order only when the adapter contract defines that observation order.
Otherwise it fails with `provider_invalid_response` before an effect.

### 9.5 Retry and uncertainty algorithm

Robin disables SDK automatic retries so every attempt is visible and budgeted.
It may automatically create a new attempt for a classified rate limit or
transient failure only when no response item or consequential external status is
ambiguous, the configured attempt limit remains, the server retry delay is
bounded, and the turn has not been cancelled.

DNS failure before connection, locally rejected TLS, and a server response that
clearly says no request was accepted may be safe retries according to adapter
tests. A disconnect after request bytes may have reached the provider and before
a complete response is recorded is `provider_result_uncertain`. Retrying creates
a new invocation attempt, consumes budget again, and is displayed; it is never
described as replaying an idempotent request. A sealed response is reused on
session replay and never regenerated silently.

The first SIGINT aborts the fetch/SDK stream through the turn signal. The adapter
continues bounded drain/settlement processing when required to distinguish local
cancel from an already completed response, then emits the final category.

### 9.6 Model capabilities, usage, and cost

The model catalog is a versioned data file with source URL/date in developer
metadata, but release behavior depends on recorded tested capabilities rather
than marketing names. Unknown model IDs can run an explicit experimental
text-only probe; they cannot receive code-edit tools until a capability profile
passes conformance.

Provider usage wins when complete. Local token estimates remain labeled and are
used for preflight and missing deltas. A versioned pricing table records currency,
input/output/cached categories, effective date, and source; cost is an estimate,
not billing authority. Unknown pricing produces usage without a monetary value.
Budgets cover input, output, requests, retries, tools, wall time, and estimated
cost. The UI warns before the next request that would cross a soft limit and
blocks before a hard limit.

### 9.7 First-run and BYOK flow

When no valid provider profile exists:

1. show that repository context will be sent to a third-party provider only as
   Robin selects it during the session;
2. ask for OpenAI, exact tested model, and credential source;
3. for environment source, accept only the literal supported variable name and
   store its name; for hidden input, enter raw secret mode without echo and keep
   the value in process memory only;
4. offer a validation request. Prefer an authenticated non-generative endpoint
   when it proves the required scope; if a model request is necessary, show its
   purpose and possible cost first;
5. classify missing/rejected/scope/rate/network/model errors separately;
6. write non-secret provider configuration atomically and append a redacted
   validation fact;
7. show where configuration lives, where the secret lives, whether resume will
   require re-entry, selected model capability, and provider egress boundary;
8. start the same R3 session flow.

`robin auth list` and `inspect` never resolve secrets. `validate` resolves one
lease for one origin and emits only redacted diagnostics. `remove` deletes the
record after showing profiles/sessions that will require another credential; it
does not mutate the user's environment.

### 9.8 Implementation tickets and sequence

1. **R4.01 — Freeze the production provider port.** Add the canonical
   `probe`/`countInput`/`invoke`/`classifyUnknownError`/`redactDiagnostic`
   contract plus semantic request, capability, normalized event, error, usage,
   retention, and continuation schemas with round-trip and adversarial tests;
   mark preview `respond` temporary.
2. **R4.02 — Build provider conformance harness.** Drive any adapter with a fake
   clock/transport and require text, tools, result continuation, usage,
   cancellation, limits, unknown fields, and error categories.
3. **R4.03 — Review and pin official SDK.** Record dependency and default behavior,
   disable SDK retries, inject transport, and add an architecture check that SDK
   types do not escape `provider-openai`.
4. **R4.04 — Encode requests.** Map role/content/tool/result/output/retention/
   generation fields, reject unsupported capabilities, disable parallel tools,
   and snapshot sanitized outgoing requests.
5. **R4.05 — Decode streams.** Normalize fragmented text and tool arguments,
   validate identity/order/limits/finish, preserve safe unknown stop metadata,
   and seal durable items.
6. **R4.06 — Classify failures and retries.** Add local fake HTTP/TLS behavior for
   auth, rate, 4xx, 5xx, disconnect timing, malformed stream, redirect, timeout,
   and abort; prove each retry/uncertainty decision.
7. **R4.07 — Add model catalog and capability gate.** Pin at least one tested
   exact model, label aliases, reject unknown tool mode, and expose model inspect.
8. **R4.08 — Build minimal configuration.** Add schema, precedence, atomic write,
   source explanation, unknown-field errors, and no-secret validation.
9. **R4.09 — Build credential records and environment resolver.** Store only exact
   reference metadata, bind provider/origin/deadline, reject arbitrary names, and
   prevent child inheritance.
10. **R4.10 — Build hidden input and session secret.** Test no echo, paste, Ctrl-C,
    EOF, terminal failure, restoration, redaction canaries, and restart re-prompt.
11. **R4.11 — Add auth/model commands.** Implement add/list/inspect/validate/remove
    and list/inspect with stable human/JSON output and no model session side
    effect except a labeled validation request.
12. **R4.12 — Integrate durable provider attempts.** Persist prepared/start/sealed/
    settled/uncertain events, request/context hashes, continuation items, usage,
    retries, and cancellation.
13. **R4.13 — Wire the first-run wizard.** Add provider/model/source choices,
    disclosure, validation, atomic config, and return to interactive session.
14. **R4.14 — Add leak-canary suite.** Place unique canaries in credential source
    and assert absence from argv, environment passed to tools, prompt, event log,
    CAS, snapshots, logs, terminal capture, errors, exports, diagnostics, and Git.
15. **R4.15 — Add provider fixture suite.** Store sanitized transport frames and
    exact normalized goldens; prevent fixture generation when a secret-shaped
    header/query/body value remains.
16. **R4.16 — Add opt-in live smoke test.** In a disposable repository, use a
    user-supplied CI/local secret, perform read/edit/test/diff, record provider/
    model/version/cost, and delete the temporary session according to the test
    retention setting.
17. **R4.17 — Document BYOK and support claim.** Explain exact supported provider,
    model catalog, environment/session-secret tradeoffs, egress, retention
    request, costs, retry uncertainty, credential removal, and unsupported keys.

### 9.9 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| request encoding | every semantic item, tool schema, result, stop/output setting, non-retention field, unknown capability, oversized context, deterministic request hash. |
| stream decoding | every chunk boundary, Unicode split, interleaved item IDs, fragmented args, duplicate/sealed item, unknown event, refusal/block, length stop, missing usage, malformed final. |
| transport | exact origin, TLS requirement, redirect credential stripping, timeout, abort, DNS/connect/write/read failures, 401/403/404/409/429/5xx classification. |
| retry | safe pre-transmission, rate delay, retry budget, cancel during backoff, post-transmission disconnect, partial response, new-attempt accounting. |
| credentials | exact env name, absent/empty value, hidden input, no argv/config/log serialization, origin mismatch, lease expiry, concurrent requests, redaction canary. |
| config/wizard | clean first run, invalid model, validation declined, auth rejected, atomic-write failure, corrupt config, session-secret restart, no TTY. |
| conformance | text-only, one tool, multiple serialized tools, denied tool result, process output, final response, cancellation, usage/cost, resume continuation. |
| live smoke | opt-in only, disposable workspace, bounded budget, supported exact model, final safety oracle, secret cleanup. |

### 9.10 Failure and security cases

- An arbitrary base URL cannot be configured for `provider-openai`; generic
  origins belong to R7's explicit compatible adapter.
- HTTPS certificate failure, redirect to another origin, proxy injection, or
  endpoint scheme downgrade stops credential transmission.
- Provider error bodies and headers pass byte limits and redaction before logs or
  terminal output. Request IDs are retained only if they are safe metadata.
- SDK debug logging, telemetry, automatic retries, and implicit environment-key
  discovery are disabled or wrapped so Robin owns disclosure and records.
- A provider asking for an unknown tool, malformed arguments, or parallel
  behavior does not bypass the normalizer or gateway.
- The model may mention permission changes in text but cannot invoke auth/config,
  select another credential, increase a budget, or approve its own request.
- Environment-source secrets stay in Robin's parent only long enough to construct
  transport authorization and are removed from all tool child environments.
- Hidden-input secrets are not durable; resume explains that re-entry is needed
  rather than silently failing or storing plaintext.
- Real-provider tests are never enabled for untrusted pull requests and never
  upload the Robin source repository by default.

### 9.11 Migration, documentation, and installation work

R4 adds user configuration and credential-record schema version 1. Config writes
create a backup only after parsing and redacting the source, then use
temp/flush/rename. Migration fixtures cover missing fields, unknown future
versions, corrupt files, and an older default profile. Secrets are never part of
config backup.

`robin doctor` gains offline configuration/model/catalog checks and optional,
explicit provider auth/network probes. It reports SDK/adapter version, exact
origin, credential source kind, model capability record, state permissions, and
non-retention request support without exposing a key. The installation guide
explains shell environment scope, process-list/history risks, hidden session
input, how to remove a reference, and how to revoke the key at the provider.

### 9.12 Acceptance evidence

R4 accepts the first end-to-end hosted-provider alpha gate only when:

- all provider conformance fixtures pass without a network;
- one opt-in live run on an exact supported model completes the real R2
  diagnose/edit/verify/diff workflow through Robin's loop;
- environment-reference and hidden-session-input BYOK flows work, fail safely,
  and never put the key in argv or durable data;
- restart prompts again for a session-only secret and resumes after validation;
- malformed streams, auth failure, rate limit, timeout, cancellation, redirect,
  and uncertain transport produce stable user-visible categories;
- provider requests contain only context-manifest-approved items and a leak
  canary appears in no forbidden surface;
- Gate A through R3, package, conformance, credential, PTY, and safety suites pass;
- public docs claim only the tested provider/models and explain `any model` as an
  adapter/capability contract rather than a literal universal promise; and
- every package imports only the canonical adapter port in production
  composition, while compiler/normalizer helpers and official SDK types remain
  internal to provider packages.

### 9.13 Explicit deferrals

R4 defers Anthropic, generic compatible/local endpoints, persistent OS keychain,
automatic provider fallback, multimodal input, parallel tools, persistent
permission rules, strict sandboxing, Git writes, project configuration trust,
skills, hooks, MCP, subagents, daemon, editor, and public distribution.

### 9.14 Requirements traced

R4 owns the first-adapter subset of `FR-PROV-001–012`, begins
`FR-CRED-001–010`, owns `FR-AGT-008`, `FR-BUD-002–005`, and advances
`FR-CTX-007`, `FR-CLI-003`, `FR-CONF-004`, `FR-CONF-007–008`,
`FR-OPS-002–004`, `NFR-SEC-003`, `NFR-PRIV-001`, `NFR-PERF-005`, and
`NFR-MAINT-002`.

## 10. R5 — Product Permissions, Approval Binding, and Command Sandbox

**Status:** planned.

**Effort range:** 5–8 part-time weeks.

### 10.1 Why R5 exists

R2's provisional ask decisions make actions visible, but they are not a complete
permission system or an isolation claim. R5 turns familiar product modes into deterministic
rules, binds approvals to exact observed state, and provides a supported strict
command sandbox path. The existing policy language remains an advanced engine
behind understandable defaults.

Permission and sandboxing are separate controls. Permission answers whether an
operation is authorized. A sandbox constrains what an authorized child process
can reach. Robin reports both decisions and never calls one the other.

### 10.2 Prerequisites

- R4 is accepted with durable tool prepare/start/settle barriers and secret-free
  child environments.
- The threat model names assets and attacks for repository reads/writes,
  processes, network, Git, credentials, state store, provider egress, and
  approval confusion.
- Sandbox support is gated by actual platform/backend probes. A backend name in
  code is not evidence that restrictions are enforced on a machine.

### 10.3 Packages, files, interfaces, and records

Create `packages/robin-permissions` with:

- `src/permission-action.ts`: normalized subject, tool/version, operation, side
  effect, concurrency class, canonical resources, request hash, provider/model,
  workspace, environment, sandbox facts, cost, and provenance;
- `src/modes.ts`: canonical `default`, `plan`, `accept-edits`, `locked`, and
  `bypass` values compiled to product rules;
- `src/headless-interaction.ts`: separate ask-to-deny overlay for `--print`, not
  a permission enum member;
- `src/rule.ts`, `src/rule-parser.ts`, and `src/rule-writer.ts`: versioned simple
  declarative rules and source scope;
- `src/policy-adapter.ts`: translate product facts to the accepted policy-engine
  catalog and map traces back to safe explanations;
- `src/decision.ts`: allow, ask, deny, dominant rule, trace digest, and safe
  alternatives;
- `src/preconditions.ts`: canonical hash over observed state;
- `src/approval.ts`: exact grant, expiry, one-use consumption, and persistence;
- `src/grant-scope.ts`: once, turn, session, project rule, user rule;
- `src/managed-floor.ts`: higher-precedence rules that lower sources cannot
  weaken;
- mode, precedence, trace, mutation, stale, persistence, and replay tests.

Extend `packages/robin-tools` with a complete one-use execution pipeline:

```ts
interface RobinTool<TInput, TNormalized, TRaw, TAgent> {
  readonly definition: RobinToolDefinition;
  parse(input: unknown): TInput;
  normalize(input: TInput, context: ToolNormalizationContext): Promise<TNormalized>;
  observe(normalized: TNormalized, context: ToolObservationContext): Promise<ToolPreconditions>;
  summarize(normalized: TNormalized, preconditions: ToolPreconditions): ApprovalSummary;
  execute(prepared: PreparedToolExecution<TNormalized>, context: ToolExecutionContext): Promise<TRaw>;
  release(raw: TRaw, prepared: PreparedToolExecution<TNormalized>): Promise<ReleasedToolResult<TAgent>>;
  reconcile(record: UnsettledToolRecord, context: ReconciliationContext): Promise<ReconciliationResult>;
}
```

The registry validates unique tool/version, closed schemas, bounded descriptions,
side-effect/concurrency classes, implementation fingerprint, release definitions,
and reconciliation strategy at startup. A `PreparedToolExecution` is opaque,
owned by the registry instance, bound to one approval and precondition digest,
and consumable once.

Extend `packages/robin-platform` with:

- `src/sandbox/sandbox-plan.ts`: read/write roots, network, spawn/syscall,
  environment, devices, temp/resource limits, and required enforcement tier;
- `src/sandbox/probe.ts`: backend binary/version/kernel/runtime/capability probes;
- `src/sandbox/seatbelt.ts`: optional macOS adapter with generated profile and
  measured enforcement facts;
- `src/sandbox/bubblewrap.ts`: Linux namespace/mount/process adapter and optional
  reviewed seccomp profile;
- `src/sandbox/container.ts`: Docker/Podman non-root, mounts, network, limits,
  image identity, and cleanup adapter;
- `src/sandbox/none.ts`: explicit unsandboxed receipt, never selected for strict;
- `src/sandbox/receipt.ts`: requested versus achieved restrictions and evidence.

Extend `packages/tool-process` with sandbox plan integration, explicit shell
operation, optional PTY operation, resource limits, and prompt detection. R5
still denies full-screen applications and arbitrary interactive credential or
confirmation prompts.

Persist the permission snapshot inside `ConfigurationPinned`, then use canonical
`PermissionEvaluated`, `ApprovalRequested`, `ApprovalResponded`,
`ToolExecutionPrepared`, `ToolExecutionStarted`, and exactly one terminal tool
event. Expiry, invalidation, scope, grant/denial, and consumption are typed
payload facts rather than competing durable event names. `SandboxReceiptRecorded`
extends the canonical union for the achieved sandbox facts.

### 10.4 Product modes and precedence

| Mode | bounded workspace reads | edits | processes | network/MCP | Git writes |
| --- | --- | --- | --- | --- | --- |
| `plan` | allow unless denied | deny | deny | deny | deny |
| `default` | allow unless denied | ask unless exact allow | ask | ask or deny by endpoint | ask |
| `accept-edits` | allow unless denied | allow within path/operation limits | ask | ask or deny | ask |
| `locked` | exact allow rules only | exact allow only | exact allow only | exact allow only | exact allow only |
| `bypass` | allow except immutable/managed safety denials | allow except immutable/managed safety denials | allow except immutable/managed safety denials | allow except immutable/managed safety denials | allow except immutable/managed safety denials |
| headless interaction overlay | exact allow rules only | exact allow only | exact allow only | exact allow only | exact allow only |

The canonical permission enum is exactly
`default | plan | accept-edits | locked | bypass`. Headless execution is a
`--print` surface and interaction overlay,
not a sixth permission mode. The overlay converts an unresolved `ask` to `deny`
unless an exact predeclared rule or framed permission callback resolves it.
Preview `ask` migrates to production `default` before the public snapshot.

`accept-edits` never implies recursive delete, symlink following, Git-internal
write, executable-mode change, preimage override, network, process, or Git
mutation. `plan` exposes no mutating or execution tool schema to the model when
provider capability permits tool-set filtering; a forged hidden call is denied.
`bypass` requires a trusted launch flag, explicit confirmation, persistent
warning, and absence of a managed prohibition; repository content can neither
enable nor self-approve it.

Decision precedence is managed deny, applicable deny, applicable ask, applicable
allow, then product default. An allow cannot override a deny. Higher priority
orders explanations inside the same winning effect only. Missing permission
facts evaluate unknown and do not satisfy a rule that needs them.

Source precedence is administrator/managed floor, trusted user rules, trusted
project rules, session rules, and one-time interactive grant. Lower sources can
make behavior stricter but cannot weaken a managed floor. Repository content can
propose a project rule only after workspace trust and cannot write user scope.

### 10.5 Approval algorithm

An approval grant binds:

```ts
interface ApprovalGrant {
  readonly decisionId: DecisionId;
  readonly normalizedRequestHash: Sha256;
  readonly preconditionHash: Sha256;
  readonly policySnapshotHash: Sha256;
  readonly scope: "once" | "turn" | "session" | "project_rule" | "user_rule";
  readonly expiresAt: Timestamp | null;
  readonly approvedBy: "interactive_user" | "trusted_rule" | "managed_floor";
  readonly displayedSummaryHash: Sha256;
}
```

The prompt shows tool/version, exact normalized paths/command/host/ref, working
directory, expected changed resources, side-effect/reversibility, observed state,
sandbox plan, network, timeout, cost where known, matching rule, alternatives,
and persistence scope. Text is built from normalized facts, not provider prose.

Flow:

1. normalize and observe live facts;
2. evaluate a pinned permission snapshot;
3. build the summary and persist the ask plus displayed-summary hash;
4. accept one unambiguous key choice; pasted or queued provider text cannot
   answer a prompt;
5. for persistence, generate the exact declarative rule and display its diff;
6. persist the human decision;
7. immediately re-observe preconditions and re-evaluate policy;
8. if any request, tool fingerprint, file, executable, Git, provider/model,
   policy, sandbox, or budget fact changed, invalidate and ask again;
9. consume a one-use grant transactionally with `ToolExecutionPrepared`;
10. dispatch the opaque prepared execution exactly once.

Persistent rules are eligible only when exact declarative scope can represent
them. Robin never converts a complex or unnormalizable command into `allow *`.
Project/user rule writes use temp/flush/rename and record the previous/new hash.

### 10.6 Tool pipeline and result release

The enforced stages are accumulate provider argument bytes, seal the call,
decode bounded JSON, validate closed schema, resolve exact registry entry,
semantic normalize, observe preconditions, evaluate permission, approve, prepare,
revalidate, start, execute, settle, release, and feed back. Tests inject probes at
each edge and assert malformed/denied/stale requests never reach the executor.

Raw tool output stays in the trusted handler/spool. Audit view contains hashes,
sizes, timings, status, truncation, classifications, and safe preconditions.
Human view contains escaped summaries/diffs/output. Model view contains only the
released bounded observation. Naming a CAS digest never grants raw access.

### 10.7 Sandbox selection and enforcement

`SandboxPlan` states required roots, network mode, process limits, environment,
devices, temp, and minimum tier. `SandboxProbe` returns `unavailable`,
`best_effort`, or `enforced` plus exact facts. Selection is deterministic:

1. filter configured backends by platform, installed version, and required
   features;
2. execute a non-destructive self-test for filesystem, network, process, and
   environment controls using synthetic canaries;
3. choose the highest configured backend meeting the required tier;
4. persist requested plan, selected backend/version, generated profile/image
   digest, self-test age, and achieved receipt;
5. if strict is required and no backend passes, deny the command;
6. if the user selected best effort, display the missing guarantees for every
   affected approval and record them in the result.

The macOS Seatbelt adapter is optional because the underlying interface may not
be a stable public product API. Support is claimed only on tested OS releases and
falls to unavailable when the probe fails. The Linux adapter uses bubblewrap/
namespaces and a reviewed syscall profile only where available. The container
adapter uses an exact image digest, non-root user, read-only root, controlled
workspace mounts, bounded temp, no host Docker socket, disabled network by
default, and resource limits. Container-runtime control remains on the trusted
host side and is never mounted into the child.

An unsandboxed host command remains possible only in a visibly named mode and
through permission. It never satisfies a strict requirement. The Robin parent,
credential resolver, state store, and provider transport do not run inside or
delegate handles to the command sandbox.

### 10.8 Explicit shell and PTY behavior

The existing structured process tool stays preferred. `run_shell@1` is a
separate higher-risk operation that displays the exact shell executable and
script, uses no interpolation by Robin, and requires ask unless an exact rule
matches. It is denied in plan mode and under the headless interaction overlay
unless an exact allow rule or framed callback covers it.

PTY execution is a separate capability for programs that require a terminal. It
has a typed input authority, resize events, transcript limits, timeout, and
cancellation. The model cannot answer an arbitrary password or confirmation
prompt. Prompt-like output pauses or terminates unless an approved deterministic
input script is part of the normalized request. Full-screen terminal programs
remain unsupported.

### 10.9 Implementation tickets and sequence

1. **R5.01 — Freeze permission facts.** Define action/resource/environment/
   request schemas, canonical hashes, optional attributes, and safe explanation
   fields; test every tool class and missing fact.
2. **R5.02 — Implement product modes.** Compile
   default/plan/accept-edits/locked/bypass into rules, apply the separate
   headless ask-to-deny interaction overlay, and test the complete
   tool-by-mode/surface matrix.
3. **R5.03 — Integrate the policy engine.** Add Robin attribute catalogs, pin
   policy snapshots, preserve deny/ask/allow precedence, and mutation-test every
   security-critical rule.
4. **R5.04 — Implement approval records.** Bind request/preconditions/policy/
   summary/expiry/scope/user, persist every transition, and enforce one-use.
5. **R5.05 — Build approval UI.** Add exact summary, diff/command expansion,
   rationale, alternatives, once/turn/session/persistent choices, no-color text,
   and cancellation.
6. **R5.06 — Implement persistent rule writer.** Generate representable exact
   rules, preview diff, enforce source scope, atomic write, and reject wildcard
   widening.
7. **R5.07 — Complete tool pipeline.** Add seal/observe/prepare/revalidate/start/
   settle/release stages, implementation fingerprints, opaque one-use handles,
   and crash barriers.
8. **R5.08 — Build sandbox plan/probe ports.** Specify achieved-tier evidence,
   canary self-tests, probe caching/expiry, strict failure, and best-effort
   disclosures.
9. **R5.09 — Implement container backend.** Use pinned image digest, non-root,
   read-only root, mounts, no network/socket/credentials, limits, signal cleanup,
   and orphan container collection.
10. **R5.10 — Implement Linux backend.** Add bubblewrap namespace/mount/network/
    process plan, optional syscall profile, version probe, canary suite, and
    explicit unsupported-kernel cases.
11. **R5.11 — Implement optional macOS backend.** Generate Seatbelt profile from
    canonical paths, run filesystem/network/process canaries on each supported OS,
    and fail unavailable when enforcement cannot be measured.
12. **R5.12 — Integrate process sandbox.** Bind executable/environment/cwd/roots/
    network/limits, persist receipt, reconcile cleanup, and return achieved facts
    to human/model views.
13. **R5.13 — Add explicit shell and PTY tools.** Keep separate schemas and risk
    classes, detect prompts, bound input, and retain cancellation guarantees.
14. **R5.14 — Add TOCTOU suite.** Mutate files, roots, executables, Git state,
    policy, provider/model, sandbox backend, and budget after prompt but before
    dispatch; require invalidation and no effect.
15. **R5.15 — Add sandbox escape suite.** Test outside-root reads/writes, symlinks,
    proc/dev access, network, DNS, environment canaries, fork bomb, PID/memory/
    file/output limits, child survival, socket access, and runtime daemon access.
16. **R5.16 — Add headless permission behavior.** Convert unmatched ask to deny,
    accept exact predeclared rules only, emit stable JSON errors, and never wait
    on non-TTY input.
17. **R5.17 — Document claims and recovery.** Publish permission modes, rule
    precedence, approval binding, sandbox backends/tiers, platform limitations,
    best-effort warning, shell/PTY limits, and cleanup diagnostics.

### 10.10 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| mode matrix | every built-in tool/version in every mode, interactive/headless, trusted/untrusted project, exact rule/no rule. |
| policy | deny precedence, unknown facts, source floor, priority explanation, simulator diff, mutation survival, secret-safe trace. |
| approval | once/turn/session/project/user, expiry, replay, changed summary/request/precondition/policy/tool fingerprint, concurrent response, crash before/after consume. |
| tool pipeline | malformed at each stage, executor spy remains untouched, prepared handle forgery/reuse, release-schema violation, cancellation and uncertain result. |
| sandbox probes | backend absent/old/broken, each canary, stale cache, strict denial, best-effort receipt, requested/achieved mismatch. |
| container | mounts, UID, root read-only, temp limit, network off, no socket/device/credential, CPU/memory/PID/output/time, cancellation/orphan cleanup. |
| platform native | supported OS/kernel matrix, root escaping, proc/dev, network/DNS, process tree, profile injection, unsupported feature. |
| shell/PTY | metacharacters, exact display hash, prompt detection, input authority, resize, timeout, password refusal, full-screen rejection. |

### 10.11 Failure and security cases

- Approval rendering failure denies the request; Robin never asks the user to
  approve text it could not display completely or hash.
- Queued user prompts, pasted provider output, hooks, and model text cannot
  produce an approval keystroke.
- Persistent rules cannot be written to user scope by project config, model,
  extension, or subagent.
- A changed executable with the same name, a changed script file, a changed
  workspace root, or a different sandbox backend invalidates approval.
- Sandbox profile strings are generated from escaped canonical facts and never
  concatenate provider or repository text into policy syntax.
- Backend absence or self-test failure cannot silently run on the host in strict
  mode. Best effort names missing controls before execution.
- The child receives no provider key, OS-store handle, SSH agent, cloud token,
  Robin state path, daemon socket, container socket, or unrelated project root.
- Resource-limit setup failure before spawn is a known non-effect. A failure
  after spawn triggers process-group/container termination and reconciliation.
- Existing policy debugger traces may use advanced attributes; ordinary users
  are never required to write `.guard` policy for the built-in modes.

### 10.12 Migration, documentation, and installation work

R5 introduces permission-rule schema version 1, policy snapshot hashes, approval
events, and sandbox receipts. Migration fixtures cover initial-preview sessions
whose permission label is `ask`, translating that spelling to non-persistent
`default` behavior; old approvals never migrate as usable grants. Config
migration requires an explicit sandbox mode and gives old sessions an
`unsandboxed` receipt plus canonical `default` permission behavior, visibly
weaker than strict.

Install docs list each optional backend and exact doctor probe. Robin does not
auto-install Docker, Podman, bubblewrap, or a macOS helper. `robin doctor` remains
read-only by default and prints commands the user may choose to run. Uninstall
includes orphan sandbox/container inspection but never deletes unrelated images,
containers, namespaces, or profiles.

### 10.13 Acceptance evidence

R5 is accepted only when:

- every R2 tool passes through the complete registered pipeline and product mode
  matrix;
- plan/default/accept-edits/locked/headless behavior is visible and deterministic;
- approval replay, mutation, expiry, changed preconditions, and rule-scope
  escalation fail before dispatch;
- at least one strict backend on each claimed supported platform passes the full
  escape/canary/resource/cancellation suite; unsupported machines fail strict
  execution clearly;
- sandbox receipts show requested and achieved restrictions and are present in
  transcript export;
- a child-process credential canary never escapes and no process/container
  remains after the suite;
- policy mutation, approval fault injection, PTY, real-provider, and all earlier
  gates pass;
- documentation distinguishes permission, sandbox, container/OS limitations,
  and whole-Robin-process trust.

### 10.14 Explicit deferrals

R5 defers Git write workflows, provider breadth, remote network tools, automatic
provider fallback, project instructions/extensions, MCP, subagents, background
daemon, remote workers, whole-parent-process sandboxing, formal verification,
editor clients, and enterprise identity.

### 10.15 Requirements traced

R5 owns `FR-PERM-001–012`, `FR-PROC-007–008`, the shell/PTY portion of
`FR-PROC-001–006`, `FR-AUTO-007`, `NFR-SEC-004–006`, and `NFR-PORT-003`.
It advances `FR-EDIT-004–006`, `FR-GIT-009`, `FR-CRED-010`,
`FR-OPS-001–004`, `NFR-REL-003–004`, and the security portions of
`FR-EXT-004–008` before those extension surfaces exist.

## 11. R6 — Daily Editing, Checkpoints, and Git Workflow

**Status:** planned.

**Effort range:** 4–6 part-time weeks.

### 11.1 Why R6 exists

R6 turns the safe edit/test/diff loop into daily repository work: multi-file
changes, file creation/deletion/move, checkpoints and rewind, exact staging,
branch/commit preparation, and an optional push/PR path. Git is a first-class
tool boundary, not an arbitrary shell command the model happens to know.

The user's existing index, worktree changes, hooks, signing configuration, and
remote credentials require explicit treatment. Robin never assumes a clean
repository, never resets unrelated paths, and never describes ambiguous bytes as
Robin-owned.

### 11.2 Prerequisites

- R5 is accepted with approval binding to workspace, HEAD, index, path, policy,
  executable, sandbox, and tool fingerprint.
- R3's CAS, edit journal, recovery, session branching, and trash behavior pass
  fault injection.
- Git read fixtures cover porcelain v2, odd filenames, merge/rebase state,
  detached/unborn branches, submodules, worktrees, and common-directory identity.
- Remote mutation is disabled until local branch/commit tests pass and a separate
  threat-model review covers credentials and external uncertainty.

### 11.3 Packages, files, interfaces, and records

Extend `packages/tool-workspace` with:

- `src/edit-batch.ts`: normalized create/update/delete/move batch and sorted
  per-path locks;
- `src/edit-journal.ts`: prepared, staged-temp, applied, rolled-back, uncertain,
  and settled transitions;
- `src/delete-file.ts` and `src/move-file.ts`: exact identity and destination
  preconditions;
- `src/checkpoint.ts`: group edit-ledger transitions at accepted turn boundaries;
- `src/rewind.ts`: preview and inverse operations from current hashes;
- `src/format-preservation.ts`: documented mode/newline/BOM behavior;
- batch overlap, lock order, partial-rename, external drift, rewind, and recovery
  tests.

Extend `packages/tool-git` with:

- `src/git-state.ts`: HEAD/ref, common/worktree, index checksum/stat, sequencer,
  merge/rebase/cherry-pick/bisect, sparse, shallow, and submodule facts;
- `src/pathspec.ts`: NUL-safe literal normalized path set;
- `src/stage-plan.ts`: exact selected path postimages and resulting index entries;
- `src/temporary-index.ts`: private index used for commit construction;
- `src/commit-plan.ts`: expected parent/tree/ref, identity, message, verification,
  and signing/hook facts;
- `src/commit-object.ts`: blob/tree/commit creation and compare-and-swap ref update;
- `src/branch.ts`: validate/create/switch with separate operations;
- `src/remote.ts`: canonical remote and refspec inspection;
- `src/push.ts`: explicitly authorized push process and uncertainty record;
- `src/pull-request.ts`: provider-neutral prepared title/body and optional reviewed
  host adapter;
- plumbing, index preservation, ref race, hook/filter, remote, and recovery tests.

Add these versioned tools to `packages/robin-tools`:

| Tool | Default mode behavior | Consequence |
| --- | --- | --- |
| `robin.edit.batch@1` | ask; allow under accept-edits limits | local reversible with journal |
| `robin.edit.delete_file@1` | ask even in accept-edits | local reversible only while preimage CAS retained |
| `robin.edit.move_file@1` | ask even in accept-edits | local reversible when both endpoints exact |
| `robin.edit.checkpoint@1` | allow | metadata/CAS references only |
| `robin.edit.rewind@1` | ask | local writes with external-drift denial |
| `robin.git.stage@1` | ask | index mutation |
| `robin.git.create_branch@1` | ask | ref creation |
| `robin.git.switch_branch@1` | ask | worktree/index/ref mutation |
| `robin.git.commit@1` | ask | object creation and compare-and-swap ref update |
| `robin.git.push@1` | ask, external effects enabled explicitly | remote mutation, outcome may be uncertain |
| `robin.git.prepare_pr@1` | allow | local title/body artifact |
| `robin.git.create_pr@1` | ask, host adapter required | remote mutation |

Persist `EditBatchPrepared`, `EditPathApplied`, `EditBatchSettled`,
`CheckpointCreated`, `RewindPrepared`, `RewindSettled`, `GitPlanPrepared`,
`GitIndexChanged`, `GitRefChanged`, `GitRemoteAttemptStarted`,
`GitRemoteAttemptSettled`, `GitRemoteResultUncertain`, and
`PullRequestPrepared/Created` records. Every record references exact plans,
pre/post hashes, approval, and recovery evidence.

### 11.4 Multi-file edit algorithm

A batch contains unique normalized paths and explicit operations. Robin rejects a
path that is both source and target except a validated move, directory-prefix
overlap, case-fold collision on insensitive filesystems, Unicode-equivalent
collision, Git-internal path, or total byte/file count above limits.

Application:

1. sort all source/destination path identities by canonical byte order and acquire
   path locks in that order;
2. observe every current source and destination, including absence, symlink,
   identity, link count, size, mode, hash, initial Git status, and edit ledger;
3. calculate every candidate and inverse operation in memory/CAS; validate the
   complete batch before any rename;
4. persist a journal and `EditBatchPrepared`, then write and flush all temporary
   postimages in their target directories;
5. re-observe every precondition and permission snapshot;
6. apply renames/deletes/moves in a deterministic order, flushing each affected
   directory and appending per-path journal progress;
7. verify every desired postimage and update attribution;
8. if an operation fails mid-batch, compare each path to exact preimage and
   desired hashes. Roll back only a Robin postimage whose original destination
   remains safe; never overwrite external drift;
9. settle `completed`, `rolled_back`, `known_partial`, or `uncertain`; only
   completed is returned as success;
10. remove temp files after proof and release locks in reverse order.

Atomicity across directories is not claimed. The journal makes partial local
effects recoverable where hashes prove ownership. A known partial or uncertain
batch blocks further mutation until the recovery view is resolved.

### 11.5 Checkpoint and rewind algorithm

A checkpoint is a session record, not a hidden Git commit. It contains the base
workspace snapshot, edit-ledger sequence range, touched paths, pre/post hashes,
CAS references needed for inverse operations, cumulative diff hash, verification
state, and current HEAD/index facts.

Robin creates automatic checkpoints after each completed mutating turn and before
a risky batch; the user can name one explicitly. Rewind previews exact paths and
changes, then for every path requires the current hash/absence to equal the
checkpoint chain's expected Robin postimage. A mixed/external path is refused.
Rewind itself is a new journaled edit and can be checkpointed; it does not erase
history. CAS retention pins inverse bytes until the checkpoint expiry or session
purge.

### 11.6 Exact staging algorithm

Robin shows selected paths, working/index/HEAD states, and the exact staged diff
before permission. It rejects unmerged paths, a changing index, unsupported
submodule transitions, or path attribution the user has not explicitly selected.

For each selected regular path Robin computes the blob hash through Git's
object-format-aware plumbing, validates file mode, writes the object, and updates
an exact index entry. Deletion removes only the exact path. The adapter passes
literal path identities through NUL-safe protocols or `--` and never lets a path
become an option. Clean/smudge filters are not silently executed; a repository
whose attributes require unsupported transformations receives a diagnostic and
an explicit alternate native-Git staging mode with its hook/filter risk shown.

The adapter checks the index checksum/stat before and after approval and writes a
backup journal reference before mutation. If Git reports a lock, Robin does not
delete it. An external index change invalidates the plan.

### 11.7 Commit construction algorithm

The default `safe_commit` operation preserves pre-existing staged content by
constructing the exact desired tree in a private temporary index:

1. require a named local branch or an explicit detached-HEAD strategy;
2. observe expected HEAD/ref, repository object format, current index, sequencer
   state, selected paths, verification summary, author/committer identity source,
   and signing/hook configuration;
3. create a private index from expected HEAD using `GIT_INDEX_FILE` and a private
   temp root outside the repository;
4. add only selected exact postimages/deletions through reviewed plumbing;
5. run `git write-tree` and compare the resulting tree/diff to the displayed
   commit plan;
6. validate the bounded UTF-8 commit message and write it through stdin to
   `git commit-tree` with explicit parent and controlled identity environment;
7. verify the created commit's parent, tree, author, committer, message, and
   object hash;
8. compare-and-swap the expected branch ref with `git update-ref <ref> <new>
   <expected-old>` and a Robin reflog message;
9. verify HEAD/ref and show resulting worktree/index state;
10. settle or reconcile from exact commit/ref evidence.

This path intentionally does not run repository hooks or signing. Robin displays
that fact. A later `native_commit` mode may run hooks/signing only through a
separate exact approval and process boundary, after preserving the user's index
and testing failure recovery. Robin never claims an unsigned plumbing commit is
signed or hook-verified.

### 11.8 Branch, push, and pull-request algorithm

Branch names are validated with `git check-ref-format --branch`, then constrained
against control characters, ambiguity, protected-pattern policy, and size. Branch
creation writes one new ref from expected HEAD and fails if it exists. Switching
is a separate operation that refuses dirty-overwrite and unresolved sequencer
state; it displays affected worktree/index paths.

Push normalization resolves a configured remote to displayed name and canonical
URL, one source object, one destination ref, force flag false, deletion false,
and expected local object. The permission summary identifies credential strategy,
network destination, and refspec. R6 disables force, mirror, prune, delete, tag
fan-out, arbitrary upload-pack, config override, and extra push options.

Git remote authentication is a separate credential boundary from model BYOK. By
default Robin inherits no provider secret. If the user chooses an existing Git
credential helper or SSH agent, the prompt states that the Git child receives
that authority and the execution receipt lowers the credential-isolation claim.
Robin records remote attempt start before dispatch. A dropped connection after
transmission may be uncertain; reconciliation fetches/read-checks the exact
remote ref only through an approved read path and never blindly repeats a push.

`prepare_pr` produces a local title/body/base/head/checklist artifact from
observable changes and verification. `create_pr` requires a reviewed host adapter
or explicit structured `gh` integration, exact repository/base/head, and separate
host credential authority. If unavailable, Robin stops at the prepared artifact
and prints the hosting URL pattern without claiming creation.

### 11.9 Verification and final-summary behavior

Each checkpoint carries commands run after its final edit, exit status, sandbox
receipt, relevant output hash, time, and whether files changed afterward. The
final summary separates:

- Robin-attributed changed paths;
- pre-existing or mixed paths;
- verification that passed against the current postimages;
- verification that failed, was skipped, was cancelled, or became stale;
- staged versus unstaged content;
- commit/branch/remote facts;
- unresolved recovery or user-review items.

The model may propose a commit message, but Robin constructs this summary from
event and Git facts. A persuasive final response cannot convert a failing test to
`passed`.

### 11.10 Implementation tickets and sequence

1. **R6.01 — Freeze batch/journal schemas.** Add operations, path-set validation,
   journal transitions, inverse plans, partial/uncertain states, and recovery
   fixtures.
2. **R6.02 — Implement path locks and batch planning.** Test deterministic lock
   order, overlap/collision, cross-directory plans, all-precondition validation,
   and cancellation before effects.
3. **R6.03 — Implement delete and move.** Require exact source/destination facts,
   retain inverse CAS, preserve supported metadata, and reject external links or
   directory recursion.
4. **R6.04 — Implement batch apply/recovery.** Inject failure/crash at every temp,
   flush, rename, journal, verification, rollback, and settlement point.
5. **R6.05 — Implement checkpoints.** Group turns, pin CAS, derive cumulative
   diff, attach verification, retention, names, and deterministic projections.
6. **R6.06 — Implement rewind.** Preview inverse diff, reject mixed drift, journal
   inverse writes, handle partial failure, and retain audit history.
7. **R6.07 — Complete Git state observer.** Add index checksum, sequencer/ref/
   common-dir facts, object format, sparse/shallow/submodule states, and drift
   digest.
8. **R6.08 — Implement exact staging.** Build object/index plan, display staged
   diff, handle paths/deletes/modes, preserve unrelated index entries, and test
   filter/attribute refusal.
9. **R6.09 — Implement safe commit.** Private index, tree creation, message via
   stdin, commit verification, compare-and-swap update-ref, reflog, and ref-race
   recovery.
10. **R6.10 — Add native commit experiment behind a flag.** Test hooks/signing,
    index backup/reconciliation, environment/credential exposure, and keep it out
    of the release claim until its gate passes.
11. **R6.11 — Implement branch operations.** Validate names, protect patterns,
    create exact ref, separate safe switch, and test detached/unborn/existing/
    dirty/sequencer cases.
12. **R6.12 — Implement push plan and adapter.** Normalize remote/refspec,
    segregate Git credentials, deny destructive flags, record start/uncertainty,
    and reconcile through a controlled local bare remote fixture.
13. **R6.13 — Implement PR preparation and optional adapter.** Generate local
    artifact, validate host/repo/base/head, support one reviewed integration, and
    degrade truthfully when unavailable.
14. **R6.14 — Build final factual summary.** Derive attribution, verification,
    stage/commit/branch/remote state and unresolved risks from durable records.
15. **R6.15 — Add hostile Git suite.** Test hooks, filters, attributes, aliases,
    config includes, pager, SSH command, credential helper, ref races, locks,
    submodules, alternates, replacement objects, and malicious remotes.
16. **R6.16 — Add daily-workflow PTY suite.** Multi-file feature, failed test,
    follow-up edit, checkpoint, rewind preview, restage, safe commit, optional
    bare-remote push, PR preparation, and resume.
17. **R6.17 — Document Git guarantees.** Explain attribution, live workspace,
    index preservation, safe versus native commit, hooks/signing, branch/push/PR
    approvals, credential authority, destructive denials, and recovery.

### 11.11 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| batch edit | create/update/delete/move, collisions, case/Unicode aliases, sorted locks, disk failure, partial rename, rollback conflict, crash/reopen, inverse CAS retention. |
| checkpoint/rewind | automatic/manual, repeated path edits, new/delete/move, external drift, expired CAS, partial rewind, branch session, cumulative diff. |
| Git state | ordinary/detached/unborn, staged/unstaged/untracked/conflict, merge/rebase/cherry-pick/bisect, sparse/shallow/submodule, linked worktree/common-dir. |
| stage | odd names, exact paths, deletion, executable mode, unrelated staged data, index race/lock, filter/attribute, object format, cancellation. |
| commit | selected tree only, message edge cases, identity absent, parent/ref race, commit-tree failure, update-ref failure, existing staged preservation, recovery exact match. |
| branch | invalid/protected/existing, detached, dirty overwrite, unresolved sequencer, ref race, linked worktree occupancy. |
| push | canonical URLs, destructive refspec denial, local bare remote success/rejection, credential canary, disconnect uncertainty, reconciliation, no blind retry. |
| PR | title/body limits, base/head, host mismatch, credential denial, duplicate request key, local fallback, returned URL validation. |

### 11.12 Failure and security cases

- No rollback or rewind overwrites a hash that differs from the exact Robin
  postimage it expects.
- A batch that spans directories cannot claim atomicity; partial state is visible
  and blocks later mutation until reconciled.
- Git lock files are never deleted automatically. Robin reports owning process
  evidence when available and leaves ambiguous locks to the user.
- Repository hooks, filters, aliases, external diff, textconv, pager, config
  includes, environment helpers, and SSH commands cannot run in read/plumbing
  paths unless a separately approved native mode explicitly enables them.
- Temporary index paths are private, outside repository-controlled paths, and
  removed only after verifying exact ownership.
- `update-ref` always supplies the expected old object; a concurrent ref move
  cannot be overwritten.
- Provider API keys never enter Git child processes. Git/host credential use is
  explicit and separately reported.
- Force push, branch/tag deletion, reset, clean, checkout overwrite, rebase,
  merge, cherry-pick, reflog expiry, garbage collection, and history rewrite are
  denied by shipped tools.
- Remote outcome uncertainty is not retried automatically and cannot be labeled
  success from local state alone.

### 11.13 Migration, documentation, and installation work

R6 adds edit-journal/checkpoint/Git schema versions and CAS retention references.
Migration from R5 creates a baseline checkpoint from replayed edit ledger facts;
it does not invent inverse bytes that were not retained. Such sessions display
`rewind unavailable before migration`. Approval grants do not migrate across new
Git tool fingerprints.

`robin doctor` gains Git version/object-format/worktree/config-risk checks, temp
index writability, host integration discovery, and read-only remote parsing. It
does not authenticate, push, create a branch, modify the index, or run hooks by
default. Docs include a recovery guide for partial batch, ref race, uncertain
push, missing Git identity, and host adapter failure.

### 11.14 Acceptance evidence

R6 is accepted only when:

- a dirty real fixture completes a multi-file edit/test/checkpoint/rewind/
  restage/safe-commit workflow without changing unrelated worktree or index data;
- exact commit tree/parent/message/ref and post-commit status match the displayed
  plan;
- a local bare remote proves non-force push success/rejection and uncertain
  reconciliation without blind retry;
- PR preparation always works locally and any claimed creation adapter returns a
  validated URL in its opt-in integration test;
- partial batch, external drift, index/ref race, malicious Git configuration,
  hook/filter, credential canary, and crash-recovery suites pass;
- destructive/history-rewriting commands are absent from the advertised tool set
  and denied when forged;
- all earlier gates remain green and docs accurately distinguish safe plumbing,
  native hooks/signing experiment, and remote authority.

### 11.15 Explicit deferrals

R6 defers merge/rebase/cherry-pick/conflict-resolution automation, signed commits
unless native mode earns its gate, force push, deployment, multiple provider
families, arbitrary Git hosts, arbitrary network tools, extensions, subagents,
parallel worktrees, daemon, and editor clients.

### 11.16 Requirements traced

R6 closes `FR-EDIT-002–004`, `FR-EDIT-006`, and `FR-EDIT-009–012`, owns
`FR-GIT-001–010`, and closes the Git portion of `FR-PERM-006–009`. It consumes
the already-owned R2/R3 evidence for `FR-EDIT-007–008` without moving their
terminal ownership. It advances `FR-UI-004–005`, `FR-SES-006–009`,
`FR-PROC-010`, `FR-OPS-007–010`, `NFR-REL-001–004`, and `NFR-SEC-002–006`.

## 12. R7 — Provider Breadth, Persistent Credentials, and Headless Automation

**Status:** planned.

**Effort range:** 6–9 part-time weeks.

### 12.1 Why R7 exists

Provider flexibility becomes credible only when materially different APIs drive
the same Robin loop and tool suite without conditional behavior in application
code. R7 adds Anthropic and a deliberately bounded OpenAI-compatible/local path,
persistent OS-backed credential references, model switching, and stable machine
interfaces. It is the internal beta/conformance gate, not a supported release;
the first supported developer bundle follows only after R8. The current initial-
R1 preview's machine formats are experimental and do not satisfy this gate.

Robin still does not promise that any string called an API key or any endpoint is
compatible. An adapter/model/auth combination is supported only for the capability
subset it declares and passes.

### 12.2 Prerequisites

- R6 is accepted on the OpenAI adapter and synthetic provider.
- Provider-neutral semantic items can represent tool-call/result continuation
  without OpenAI-specific identifiers leaking into sessions or tools.
- The threat model covers custom endpoint SSRF, redirects, local-network access,
  certificate validation, credential-origin binding, capability lies, provider
  fallback egress, and machine-output injection.
- Stable exit-code and JSON schema versions are reviewed before users automate
  against them.

### 12.3 Packages, files, interfaces, and records

Create `packages/provider-anthropic` with the same physical module boundaries as
`provider-openai`: adapter, request encoder, event decoder, tool/result codec,
error classifier, model catalog, retention behavior, injected transport, and
sanitized recorded fixtures. Use the official provider SDK only inside this
package with SDK retries disabled.

Create `packages/provider-openai-compatible` with:

- `src/profile.ts`: exact base URL, API path/version, auth strategy, required
  headers, model ID, timeout, TLS/local allowance, and claimed feature subset;
- `src/compatibility-level.ts`: `responses_subset`, `chat_completions_subset`,
  `local_tool_subset`, or `text_only` rather than vendor inference;
- `src/request-encoder.ts` and `src/event-decoder.ts`: only the documented tested
  subset for the selected level;
- `src/capability-probe.ts`: explicit, consented probes with budget/network
  disclosure;
- `src/origin-policy.ts`: URL canonicalization, DNS/IP class policy, redirects,
  TLS, proxy, and credential audience;
- `src/local-profile.ts`: no-key loopback/Unix-socket profiles for tested local
  servers;
- fixtures for conformant endpoints and common nonconformities.

Extend `packages/model-provider` conformance with suites for:

- text streaming;
- tool calling with serialized calls;
- structured final output;
- supported image input when declared;
- continuation after tool results and resume;
- cancellation and attempt uncertainty;
- usage present/absent/partial;
- unknown stop/event fields;
- context/output limits;
- provider storage/retention declarations;
- error taxonomy and retry safety.

Extend `packages/robin-platform` credential support with reviewed OS adapters:

- `src/credentials/macos-keychain.ts` using an approved Security framework or
  credential-store binding whose secret never appears in process argv;
- `src/credentials/linux-secret-service.ts` using a reviewed Secret Service
  binding and locked-session handling;
- `src/credentials/record-store.ts`: secret-free record metadata, usage links,
  rotation generation, and deletion state;
- `src/credentials/rotation.ts`: validate replacement before atomic reference
  switch;
- `src/credentials/export.ts`: metadata only;
- conformance tests shared by in-memory fake, environment, session, macOS, and
  Linux adapters.

Do not implement a homemade encrypted secret file as a silent fallback. When no
OS store exists, Robin offers environment reference or session-only hidden input
and states the resume tradeoff.

Extend `packages/robin-agent`, `robin-prompt`, `robin-session`, and
`robin-application` with provider/model boundary events, explicit model switch,
configured fallback plan, structured final-output validation, no-session mode,
and print/JSON/JSONL use cases.

### 12.4 Provider capability negotiation

A `ProviderManifest` and `ModelCapabilityProfile` produce an immutable negotiated
capability set pinned to each invocation:

```ts
interface NegotiatedModelCapabilities {
  readonly providerId: ProviderId;
  readonly adapterVersion: AdapterVersion;
  readonly modelId: string;
  readonly modelIdentity: "pinned" | "mutable_alias" | "unknown_experimental";
  readonly toolMode: "native" | "schema_envelope" | "none";
  readonly parallelTools: false;
  readonly structuredFinal: "native" | "validated_text" | "none";
  readonly imageInput: boolean;
  readonly contextLimit: number;
  readonly maxOutput: number;
  readonly usageMode: "provider" | "estimated";
  readonly continuationMode: string;
}
```

Negotiation intersects adapter support, tested model facts, user configuration,
selected workflow requirements, permission/tool availability, and provider
response. A capability is enabled only if every required layer supports it.
Unknown capability does not become true from a model's textual claim.

Native tool models receive closed tool schemas. A tested constrained-schema
model may emit a versioned proposal envelope that passes the same tool pipeline.
Text-only models can answer or plan but receive no consequential tool authority.
Robin displays the resulting mode before the first request.

### 12.5 OpenAI-compatible and local endpoint algorithm

Generic configuration never guesses from a brand name. The user selects a
compatibility level and either a known tested preset or a custom experimental
profile. URL parsing requires an absolute URL, supported scheme, no userinfo,
no fragment, bounded host/path, normalized port, and exact credential audience.

Hosted credential-bearing endpoints require HTTPS. Loopback HTTP is allowed only
for an explicit local profile and cannot carry a hosted provider credential.
DNS results are checked against configured public/private/loopback policy before
connect and after redirect. Redirects are off by default; an allowed same-origin
redirect is bounded and revalidated. A redirect never carries authorization to a
different origin.

Capability probes are separate commands. They show endpoint, authentication,
requests, token/cost possibility, and data sent. Probe success stores a dated
capability snapshot, not permanent truth. At runtime the adapter still validates
every frame and fails closed on protocol drift.

No-key local profiles pass a null credential lease, disable provider-cost claims,
record local endpoint/version when available, and retain the same context,
permission, tool, session, and output boundaries.

### 12.6 Model switching and fallback algorithm

`/model` and CLI flags resolve a target profile and show provider, exact/mutable
model identity, capabilities, context impact, credential source, and egress
change. Switching appends a boundary event and compiles the existing semantic
conversation into the target representation.

Robin refuses a switch when pending provider-native continuation items cannot be
represented, required modalities/tools disappear, context exceeds the new
limit without an accepted compaction, or a required credential is unavailable.
A successful switch pins a new configuration/context snapshot before requesting
the model.

Fallback is opt-in per profile. It lists ordered exact targets and allowed error
classes. It never occurs for authentication, permission, invalid response,
content policy, unknown outcome, or user cancellation. Before fallback, Robin
shows or has a preapproved rule for the new provider egress and budget. Each
fallback is a new provider attempt with its own credential lease and usage.

### 12.7 Headless contracts

The initial-R1 preview already runs `robin --print` through the shared ephemeral
text loop, but it currently accepts `--output-format` and `--no-save` and marks
its machine envelopes experimental. R7 performs the compatibility migration:
`--output-format` becomes target `--output`, `--no-save` becomes target
`--no-session`, parser/help/completion snapshots stop exposing the preview
spellings, and published schemas plus exit codes become stable. The preview
spellings are not promised as permanent aliases.

Supported forms are:

```text
robin --print "prompt"
input | robin --print "prompt"
robin --print --output json "prompt"
robin --print --output stream-json "prompt"
robin --print --result-schema schema.json "prompt"
robin --print --no-session --permission-mode locked "prompt"
```

`--output text` is the default and writes only the final assistant text to
stdout; progress/diagnostics go to stderr. Final JSON emits exactly one
`robin.result.v1` object. Streaming JSON
emits one UTF-8 JSON object per line with schema version, session/turn IDs,
monotonic sequence, timestamp, type, and typed payload. No ANSI, spinner,
carriage-return rewriting, prompts, or non-JSON prefixes enter machine stdout.

Piped stdin is captured under byte/time limits, classified as an untrusted user
attachment, hashed/persisted unless `--no-session`, and delimited from prompt
instructions. Conflicting stdin/prompt modes fail before provider initialization.

Headless is a surface, not a permission mode. Any `ask` result produced by the
selected canonical mode becomes deny unless an exact predeclared rule or
external framed permission callback covers the request. A callback uses length-prefixed
JSON on dedicated file descriptors with timeout, request hash, nonce, and closed
schema; stdout text can never approve.

`--result-schema` loads a bounded local trusted schema after path/trust checks,
requests native structured output only when negotiated, and always validates the
final semantic object locally. Validation failure has its own result status and
exit code.

`--no-session` keeps only the minimum in-memory turn state, writes no transcript
or CAS, and explicitly disables resume/background recovery. It does not disable
logs unless the selected log mode says so; docs identify all remaining metadata.

Stable exit categories map to numeric codes documented and snapshot-tested:

- success;
- invalid invocation/configuration;
- permission/approval unavailable;
- budget exhausted;
- task/verification incomplete when required;
- provider/infrastructure failure;
- cancellation;
- local state corruption/migration required.

Exact numeric assignments live in one exported schema and cannot be reused for a
different category in the same major version.

### 12.8 Credential persistence, rotation, and removal

OS-store adapters implement create/read/replace/delete through a conformance port
that accepts byte buffers and metadata, never command-line strings. Robin writes
the secret first, reads it through a scoped lease for validation, then writes the
secret-free credential record. A failed metadata write removes the newly created
unreferenced secret when exact identity proves ownership.

Rotation creates a new generation, validates it against the intended provider
origin, atomically switches referencing profiles after confirmation, then marks
the old generation removable. It never overwrites the only working secret before
validation. Removal shows dependent profiles/sessions, requires exact credential
ID, removes metadata and OS entry with separate outcomes, and reports any
externally held environment secret it cannot delete.

List/inspect/export/doctor do not resolve secret bytes. Debug mode, provider error
bodies, and JSON output remain redacted by exact lease canaries plus secret-shape
fallback filters.

### 12.9 Implementation tickets and sequence

1. **R7.01 — Expand conformance contract.** Freeze negotiated capabilities,
   adapter cases, semantic goldens, output/error/retention requirements, and
   compatibility-tier report.
2. **R7.02 — Implement Anthropic request encoder.** Map semantic roles, content,
   tools, results, generation and non-retention behavior without application
   conditionals.
3. **R7.03 — Implement Anthropic stream decoder.** Normalize fragmentation,
   blocks/tool inputs, usage/stop/errors, cancellation, and unknown fields with
   recorded fixtures.
4. **R7.04 — Complete Anthropic adapter.** Add official SDK boundary, model
   catalog, retry uncertainty, live opt-in smoke, and cross-provider transcript
   equivalence tests.
5. **R7.05 — Define compatibility profiles.** Add closed schema, exact origin,
   auth strategy, known presets, experimental label, capability subset, and no
   silent emulation.
6. **R7.06 — Implement compatible transport modes.** Support the selected
   Responses, chat-completions, local-tool, and text-only subsets with separate
   codecs and failure messages.
7. **R7.07 — Implement origin/network policy.** Test URL parser, DNS/IP classes,
   TLS, redirects, proxy behavior, origin-bound auth, rebinding, loopback, and
   Unix-socket permissions where supported.
8. **R7.08 — Implement local no-key preset.** Pass conformance against a local
   fake and one documented real local server in opt-in tests without changing the
   loop/tool/session code.
9. **R7.09 — Implement negotiation.** Intersect adapter/model/workflow/tool facts,
   disable unsupported surfaces, snapshot result, and test capability lies/drift.
10. **R7.10 — Implement model switch.** Add `/model`, CLI override, compatibility
    checks, required compaction, credential resolution, boundary events, and
    resumption.
11. **R7.11 — Implement opt-in fallback.** Restrict error classes/targets, obtain
    egress permission, create new attempts/budgets, and test no fallback on unsafe
    categories.
12. **R7.12 — Implement OS credential-store port.** Build fake conformance, then
    tested macOS and Linux adapters with no argv leakage and explicit unavailable/
    locked behavior.
13. **R7.13 — Implement rotation/removal.** Add generations, validate-before-
    switch, dependency display, partial external failure, and leak-canary tests.
14. **R7.14 — Freeze machine schemas and exit codes.** Publish JSON Schema and
    fixtures for final/stream records, output routing, errors, and exit mapping.
15. **R7.15 — Stabilize and migrate print modes.** Reuse the application/agent
    loop, migrate preview flags to `--output`/`--no-session`, add stdin
    attachment, stdout/stderr separation, no ANSI, cancellation, and durable
    no-session behavior.
16. **R7.16 — Implement structured results.** Load/validate bounded schemas,
    negotiate native mode, validate locally, and report a distinct failure.
17. **R7.17 — Implement headless permissions.** Add exact rules and framed
    callback, deny unmatched asks, nonce/hash/time bounds, and no stdout approval.
18. **R7.18 — Add cross-adapter E2E.** Run one synthetic repository script through
    synthetic, OpenAI recorded/live, Anthropic recorded/live, compatible fake,
    and local no-key without kernel/tool changes.
19. **R7.19 — Add machine consumer fixtures.** Drive JSON/JSONL through a separate
    parser process, inject diagnostics/tool controls, backpressure, EPIPE, and
    cancellation, and require valid output or one stable failure.
20. **R7.20 — Publish compatibility docs.** Generate matrix from manifests and
    conformance results; document supported auth/models/features, experimental
    profiles, local privacy boundary, switch/fallback, output schemas, and exits.

### 12.10 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| Anthropic | request roles/content/tools/results, every stream boundary, usage/stop/refusal, auth/rate/transient, timeout/cancel/uncertain, retained unknown metadata. |
| compatible endpoint | each declared subset, missing/renamed fields, non-SSE data, malformed JSON, unsupported tools, wrong usage/stop, redirect/TLS/DNS/rebinding. |
| negotiation | exact/mutable/unknown model, native/schema/text mode, image/structured support, context limits, parallel disabled, capability drift. |
| switching/fallback | representable/unrepresentable history, pending tool, compact needed, missing credential, egress change, allowed/forbidden failure, retry budget. |
| credential stores | create/read/replace/delete, unavailable/locked/denied, concurrent rotation, crash between secret/metadata, partial remove, no argv/log/config/export leak. |
| headless output | text/JSON/JSONL, stdout/stderr separation, schema validation, pipe backpressure/EPIPE, signal, no TTY, input limits, no ANSI/control injection. |
| headless permission | exact allow, unmatched ask deny, framed callback success/timeout/replay/hash mismatch/malformed response, no stdin/stdout spoof. |
| cross-adapter | same semantic transcript, tool request/result sequence, final factual summary, session replay, usage labels, and safety oracle across all claimed tiers. |

### 12.11 Failure and security cases

- A custom endpoint cannot receive an OpenAI or Anthropic credential unless the
  credential record is explicitly created for that exact origin and strategy.
- Loopback HTTP cannot carry a hosted key. Private/link-local/metadata networks
  are denied unless a separately managed policy explicitly allows the exact
  endpoint and threat review.
- Redirect, DNS rebinding, proxy, certificate, and hostname changes are checked at
  connect/reconnect boundaries; credentials are stripped on audience change.
- A compatible endpoint's self-reported capability does not enable a feature
  without passing the local conformance profile.
- Local inference means local model transport, not local-only execution: Robin
  tools and enabled extensions may still have egress and are reported separately.
- Provider fallback never silently sends repository context to another company
  or origin.
- OS-store unavailability never falls back to plaintext config or a homemade
  encryption key stored beside ciphertext.
- JSON/JSONL serializers escape control bytes and never mix stderr diagnostics
  into stdout. Backpressure cannot cause unbounded event retention.
- `--no-session` cannot advertise crash resume and leaves no session directory;
  temp spools are owner-private and deleted/reconciled.

### 12.12 Migration, documentation, and installation work

R7 migrates provider profiles from the single R4 OpenAI schema into a generic
provider record while preserving exact adapter/model/credential references. The
migration is copy-validate-switch, leaves the source for rollback, and does not
resolve secrets. Session events keep the original adapter semantics; migration
does not rewrite old provider items as another provider.

Credential-record migration can move an environment/session source to an OS
store only after hidden user confirmation and successful validation; it never
copies automatically. Machine schemas and exit codes receive a compatibility
policy and fixture directory. CLI migration changes preview
`--output-format`/`--no-save` to `--output`/`--no-session` and preview `ask` to
canonical `default`; help, completion, examples, and golden argv fixtures are
updated atomically. `robin doctor --json` uses the same output contract and
labels optional network probes.

Install docs add OS credential-store prerequisites, local endpoint setup, CA/
proxy policy, provider-specific key creation/revocation links, headless CI secret
handling, no-session tradeoffs, and output schema examples. Examples never place
secrets directly on a command line.

### 12.13 Acceptance evidence

R7 accepts its internal beta/provider-and-automation conformance gate only when:

- OpenAI, Anthropic, and generic compatible/local adapters pass every case in
  their declared conformance tier;
- opt-in live runs for two hosted provider families and one no-key local endpoint
  complete the same repository workflow with unchanged loop/tool code;
- provider/model switch and explicit safe fallback pass context, capability,
  egress, credential, budget, and resume tests;
- macOS and Linux OS-store adapters pass conformance on claimed versions, with
  environment/session fallback documented when unavailable;
- rotation/removal and leak-canary tests find no secret in forbidden surfaces;
- text, final JSON, stream JSON, structured-result, hermetic/headless permission,
  and no-session modes pass external consumer and PTY/subprocess tests;
- the generated support matrix identifies exact adapter/model/auth/capability/
  retention/usage tiers and unsupported behavior;
- all prior gates and the beta security/performance/migration suites pass.

### 12.14 Explicit deferrals

R7 defers Gemini and other provider families, arbitrary external agent binaries,
parallel tool execution, full multimodal editing, user/project instruction
hierarchy, skills, hooks, MCP, subagents, background daemon, remote SaaS,
Windows parity, editor clients, and Code-OSS.

### 12.15 Requirements traced

R7 completes `FR-PROV-001–012`, `FR-CRED-001–010`, `FR-AUTO-001–007`,
`FR-BUD-001–006`, and the provider portions of `FR-SES-003–004`,
`FR-CTX-007–008`, `FR-AGT-008–009`, and `FR-CONF-007`. It advances
`FR-CLI-003`, `FR-CLI-011–012`, `FR-OPS-002–006`, `NFR-SEC-003`,
`NFR-PERF-005`, `NFR-PRIV-001–004`, `NFR-PORT-001–003`, and
`NFR-MAINT-002–004`.

## 13. R8 — Configuration, Instructions, Skills, Hooks, and MCP

**Status:** planned.

**Effort range:** 8–12 part-time weeks.

### 13.1 Why R8 exists

Developers need repository conventions and reusable extensions, but project
content is untrusted and extensions are executable or networked authority. R8
adds these surfaces only after core tools, permissions, providers, persistence,
and headless behavior are stable. Instructions, skills, hooks, and MCP remain
distinct products with distinct trust and execution semantics. Once every R0–R8
gate is green, R8 produces the first supported developer-release bundle. Earlier
R1 preview, R4 alpha, and R7 conformance artifacts remain unsupported evidence
builds rather than releases.

The R8 bundle is a versioned, checksummed developer package with an exact
platform/Node/provider capability matrix, current-versus-planned manifest,
installation and removal instructions, published automation schemas, and links
to its gate evidence. It does not claim the stable distribution channels,
notarization/signing matrix, updater, long-horizon migrations, or Robin 1.0
operations that remain R10 work.

### 13.2 Prerequisites

- R7 provider/automation conformance gate is accepted with exact provider capabilities, headless schemas,
  persistent credentials, permission modes, and sandbox receipts.
- Configuration and extension threat models cover malicious project takeover,
  import escape/cycles, secret-shaped config, hook protocol injection, MCP tool
  annotation lies, server spoofing, transport redirects, credential delegation,
  extension update drift, and output floods.
- A workspace trust prompt can be displayed before parsing project-controlled
  executable settings or starting a project extension.

### 13.3 Packages, files, interfaces, and records

Expand `packages/robin-config` with:

- `src/scope.ts`: defaults, managed, user, project, local-project, environment,
  explicit-settings-file, CLI, and session override identities;
- `src/precedence.ts`: field-level effective value and managed-floor logic;
- `src/project-trust.ts`: physical workspace identity, source hashes, decision,
  expiry/revocation, and material-change check;
- `src/config-loader.ts`: bounded no-code JSON parser with schema versions and
  unknown security-field rejection;
- `src/config-writer.ts`: source-aware atomic edits that preserve unrelated
  supported fields and refuse newer schemas;
- `src/explain.ts`: effective redacted value, winner, overridden sources,
  managed constraints, and validation;
- `src/secret-shape.ts`: reject key/token/password/private-key content from
  non-secret settings and offer credential-record migration;
- complete field/source/managed/trust/migration tests.

Expand `packages/robin-prompt` with:

- `src/instruction-source.ts`: user `ROBIN.md`, project `ROBIN.md`, optional
  compatible `AGENTS.md`, imported files, path scopes, skill text, and MCP
  resources;
- `src/robin-markdown.ts`: bounded Markdown plus exact include directive parser;
- `src/instruction-imports.ts`: relative canonical resolution, root/depth/count/
  byte limits, cycle detection, and provenance;
- `src/path-scope.ts`: anchored canonical glob compilation and activation;
- `src/instruction-compiler.ts`: precedence, trust labeling, delimiters, hashes,
  and provider-neutral items;
- `src/instruction-inspector.ts`: source tree and active/withheld explanation.

Create `packages/robin-extensions` with:

- `src/extension-identity.ts`: kind, namespace, name, semantic version, source,
  integrity hash, trust scope, installed time, and enabled state;
- `src/discovery.ts`: bounded user/project directories and duplicate rules;
- `src/skill/manifest.ts`, `catalog.ts`, `loader.ts`, and `resource.ts`;
- `src/hook/manifest.ts`, `matcher.ts`, `scheduler.ts`, `protocol.ts`, and
  `result.ts`;
- `src/mcp/server-record.ts`, `transport.ts`, `client.ts`, `capability.ts`,
  `tool-mapper.ts`, `resource.ts`, and `prompt.ts`;
- `src/extension-sandbox.ts`: minimum environment/root/network/credential plan;
- `src/lifecycle.ts`: load, pin, invoke, fail, disable, update, and resume drift;
- extension conformance, isolation, corruption, update, and recovery suites.

Add application commands:

```text
robin config get|set|unset|list|validate|explain|sources
robin trust inspect|allow|deny|revoke
robin instructions inspect|validate
robin skills list|inspect|validate|enable|disable
robin hooks list|inspect|validate|enable|disable|run-test
robin mcp add|remove|list|inspect|trust|doctor|tools|resources|prompts
```

Every command has human and JSON output. Commands that mutate config/trust/
extensions show the exact target file/record and use application services rather
than editing files in `apps/cli`.

Persist configuration snapshots, trust decisions, instruction manifests, active
path scopes, skill selections, hook attempts/results, MCP server handshakes,
capability snapshots, tool mappings, resource releases, errors, and extension
version changes. Resume revalidates extension identity and invalidates pending
approval when it changes.

### 13.4 Configuration precedence and managed floor

For ordinary overridable values, increasing precedence is:

1. built-in defaults;
2. managed default values;
3. user configuration;
4. trusted project configuration;
5. local-project configuration excluded from Git by convention;
6. documented environment settings that are explicitly allowed for that field;
7. explicit settings file;
8. CLI flags;
9. in-session user changes where the field permits runtime change.

Managed restrictions form a separate floor, not merely a lower-precedence value.
No later source can enable a denied provider, endpoint, tool, extension,
credential strategy, bypass mode, sandbox downgrade, telemetry destination, or
budget above that floor. A stricter later value is allowed.

The loader parses each source independently from bounded bytes, validates its
declared schema before merge, records field provenance, rejects duplicate JSON
keys at the boundary parser, and treats an unknown security-relevant field as an
error. A project file is discovered and hashed before trust, but its semantic
values are not applied and its extension processes are not started until trust.

`robin config explain <key>` prints the effective redacted value, winning source,
overridden candidates, managed restriction, validation, and whether changing the
value requires restart/new turn/new session. Config writes target one explicit
scope, preserve supported unrelated fields, refuse newer schemas, and never copy
a secret-shaped value into a settings file.

### 13.5 Workspace trust algorithm

Trust binds physical workspace identity, Git common directory, repository remote
identity when available, relevant project configuration/instruction/extension
manifest hashes, granted categories, user identity, and decision time. Categories
are separate: instructions, non-executable settings, hooks, skills with scripts,
local MCP, remote MCP, and credential delegation.

On first discovery or material change:

1. load trusted user/managed settings only;
2. enumerate candidate project files by safe metadata and hashes without
   executing or importing content;
3. show repository identity, changed files, requested categories, executable/
   network implications, and safe choices;
4. persist the decision in Robin's data root, never in the repository;
5. parse/apply only granted categories through their boundaries;
6. pin exact hashes and extension identities to the session configuration;
7. on hash/identity change, stop affected extension use, invalidate related
   approvals, and request trust again.

Trusting instructions does not trust hooks or MCP. Trusting one server does not
trust updates, additional tools, or credentials. Repository content cannot grant
trust to itself or write the trust database.

### 13.6 Instruction format and compilation

Robin recognizes:

- managed and user `ROBIN.md`;
- root and ancestor project `ROBIN.md` within the bound workspace;
- optional compatible `AGENTS.md`, shown with its compatibility and precedence;
- `.robin/instructions.json` for path-scoped sources and ordered imports;
- an exact include directive in Robin Markdown: `@include "relative/path.md"`
  on its own line outside a fenced code block, where the quoted value uses JSON
  string escaping.

Includes resolve relative to the importing file, stay within the allowed user or
workspace instruction root, deny symlink traversal, enforce depth/file/byte/time
budgets, and detect cycles by physical identity plus canonical path. Included text
retains source provenance and trust; it never inherits a stronger source from the
importer.

`.robin/instructions.json` contains schema version and entries with source path,
anchored workspace-relative globs, priority within the same source scope, and
optional excludes. Globs compile at load time over canonical forward-slash paths.
Path-scoped instructions activate only when current context/tool paths match and
the context manifest records the activation. An empty or absent path set cannot
activate a scoped rule.

Compilation orders managed, user, compatible, project-root, nearer project, path
scope, and selected skill text according to documented precedence. It wraps each
source in provider-neutral untrusted/trusted instruction items with source/hash/
scope labels. Repository instructions cannot become Robin's product system role,
modify permission facts, or hide their provenance.

### 13.7 Skills lifecycle

A skill is a directory with closed `skill.json`, bounded `SKILL.md`, and declared
resource paths. The manifest includes schema version, namespace/name/version,
description, invocation aliases, supported task/tool capabilities, instruction
byte limit, resource allowlist, optional script references, trust requirement,
and integrity hashes.

Startup loads metadata only. Selection occurs through explicit `/skill`, a user
request that matches an alias and is shown, or a model proposal that still needs
the configured selection policy. On selection Robin verifies identity/hash/trust,
loads bounded instructions/resources, passes them through context policy, records
the context manifest, and pins the skill version for the turn.

Skill text cannot invoke tools directly. A declared script is a hook/tool process
with its own permission and sandbox. Resource paths cannot escape the skill root,
and a skill receives no credential merely because its instructions name one.
Updates are a new identity/hash requiring revalidation and, for project skills,
renewed trust when material.

### 13.8 Hooks lifecycle and protocol

Hook manifests declare exact event, matcher, execution type, executable plus argv
or built-in action, timeout, output limit, concurrency, permission mode, sandbox,
failure policy, and allowed response controls. Supported initial events are
session-open/close, user-message-accepted, before/after-provider, before/after-
tool, after-edit, after-verification, and turn-completed/failed.

Matchers compile from typed event fields and safe globs; no shell or dynamic code
runs during matching. Hook processes receive a length-prefixed canonical JSON
request on stdin and return one length-prefixed closed-schema response on stdout.
stderr is diagnostic only. The environment is minimal; provider keys, credential
handles, session-store paths, and unrelated repository roots are absent.

Allowed response controls are:

- `observe`: append a bounded human/diagnostic observation;
- `add_context`: propose bounded content that passes context release;
- `block`: make the current operation stricter with a safe reason when the hook
  event permits blocking;
- `request_user_input`: ask through the Robin application when interactive;
- `no_change`.

A hook cannot return allow, forge a tool result, consume an approval, modify a
normalized request, select credentials, increase a budget, weaken a sandbox, or
mark verification successful. Timeout/crash/malformed output follows the declared
fail-open/fail-closed policy, but security-sensitive before-tool hooks may not
fail open unless managed policy explicitly permits it. Recursive hook events are
bounded by a depth counter and an event-specific suppression table.

### 13.9 MCP client and guarded tool mapping

MCP server records identify namespace, exact transport, command/argv or HTTPS
origin, protocol version range, trust scope, environment/credential references,
sandbox/network plan, startup timeout, request limits, and pinned capability
snapshot. R8 supports local stdio and reviewed remote HTTP streaming transports.

Connection flow:

1. resolve the trusted server record without credentials;
2. obtain extension permission and sandbox/network plan;
3. start/connect with minimum environment and exact origin-bound credential when
   explicitly configured;
4. perform the protocol initialize handshake through bounded JSON-RPC framing;
5. validate server identity/version/capabilities and enumerate tools/resources/
   prompts under item/byte/time limits;
6. namespace every tool as `mcp.<server>.<tool>` and pin its schema plus capability
   hash;
7. map untrusted read-only/destructive/idempotent annotations into conservative
   Robin side-effect facts; annotations can make a tool stricter, never safer;
8. register dynamic tools in a separate registry with default ask or deny;
9. route every invocation through seal/schema/normalize/observe/permission/
   approval/start/settle/release;
10. validate result content, bound/store artifacts, and release separate human/
    model views;
11. on capability drift, unregister affected tools, invalidate approvals, and
    require inspection/trust before use.

MCP resources enter as external context sources with provenance and release
policy. MCP prompts are untrusted templates and never replace Robin's product
system instruction. Remote effects without a documented idempotency/reconciliation
protocol become uncertain after an ambiguous disconnect and are not blindly
retried.

### 13.10 Implementation tickets and sequence

1. **R8.01 — Freeze config scopes and schemas.** Add every source, field-level
   precedence, managed floor, restart semantics, duplicate/unknown-field handling,
   and old-version fixtures.
2. **R8.02 — Implement source loader and explain.** Parse bounded files without
   code, record provenance, merge deterministically, redact values, and expose
   get/list/validate/explain/sources.
3. **R8.03 — Implement atomic scoped writer.** Preserve supported fields, refuse
   newer schemas, reject secret shapes, show exact destination/diff, and recover
   interrupted writes.
4. **R8.04 — Implement workspace trust.** Bind physical/config identities,
   category grants, changes/revocation, application prompt, durable records, and
   no-self-trust tests.
5. **R8.05 — Parse Robin Markdown imports.** Add exact directive/fence behavior,
   JSON string paths, containment, symlink, cycle, depth/count/byte/time limits,
   and provenance.
6. **R8.06 — Implement path-scoped instructions.** Validate config, compile globs,
   activate from canonical paths, order sources, pin manifests, and inspect active/
   withheld rules.
7. **R8.07 — Add compatible AGENTS.md.** Define lower/equal precedence explicitly,
   show compatibility source, prevent conflicting hidden load, and test nested
   instruction behavior.
8. **R8.08 — Freeze extension identity/manifests.** Add closed schemas, namespaces,
   versions, integrity, trust, duplicate resolution, discovery bounds, update
   drift, and quarantine.
9. **R8.09 — Implement skills catalog.** Load metadata only, validate aliases,
   explicit/model-assisted selection, bounded instruction/resource loading,
   context release, scripts as separate effects, and version pinning.
10. **R8.10 — Freeze hook events/protocol.** Define framed request/response,
    controls, matchers, deadlines, concurrency, failure modes, recursion, and
    canonical fixtures.
11. **R8.11 — Implement hook scheduler.** Start sandboxed processes, filter env,
    apply response controls without authority widening, persist attempts/results,
    and isolate crash/output/cancel.
12. **R8.12 — Add hook administration.** list/inspect/validate/enable/disable/test,
    source/trust display, deterministic test payloads, and no production event
    mutation from `run-test`.
13. **R8.13 — Freeze MCP server/transport schemas.** Define stdio/HTTP, auth,
    sandbox/network, frame/message/capability limits, namespaces, and trust.
14. **R8.14 — Implement MCP framing and lifecycle.** Initialize, request IDs,
    cancellation, progress, timeout, server crash/restart, bounded notifications,
    and clean shutdown.
15. **R8.15 — Map MCP capabilities.** Validate/pin schemas, conservative side
    effects, dynamic registry, drift invalidation, context resources/prompts, and
    separate views.
16. **R8.16 — Route MCP tools through permissions.** Test approval binding,
    project self-approval denial, credential audience, ambiguous remote effect,
    result validation, artifact bounds, and model feedback.
17. **R8.17 — Add MCP administration.** add/remove/list/inspect/trust/doctor/tools/
    resources/prompts with human/JSON output and no secret resolution for reads.
18. **R8.18 — Add extension leak/escape suite.** Use secret, filesystem, network,
    permission, result-forgery, protocol, output, fork, and update-drift canaries
    across skills/hooks/MCP.
19. **R8.19 — Add resume/migration tests.** Change config/instruction/skill/hook/
    server versions between sessions, revoke trust, remove extension, and require
    new snapshots or safe degradation.
20. **R8.20 — Add end-to-end extension demo.** Use project instructions, one
    selected skill, an after-edit hook, and a local fixture MCP read tool while
    proving none bypass permission/context/session boundaries.
21. **R8.21 — Publish the supported developer bundle and references.** Build and
    verify the versioned checksummed package, generate its exact support/evidence
    manifest, and document every scope, trust category, instruction/import/path
    format, skill/hook/MCP schema, lifecycle, permission, credential, sandbox,
    automation, failure, migration, install, and uninstall effect without a 1.0
    distribution claim.

### 13.11 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| config | every source/field, managed floor, duplicate/unknown/new schema, secret shape, atomic failure, explain trace, material project change. |
| trust | same/different physical repo, remote change, file hash change, category isolation, revoke, malicious project write, ambiguous identity, resumed session. |
| instructions | source order, includes, fenced fake directive, escapes, symlink/root escape, cycle, depth/count/bytes, path globs, compatible file, context provenance. |
| skills | metadata-only startup, selection, aliases, resources, script separation, update hash, duplicate namespace, disabled/untrusted, context limits. |
| hooks | every event/control/failure mode, matcher, framing fragmentation, malformed/oversize output, timeout/cancel, recursion, env canary, forged allow/result, concurrent ordering. |
| MCP transport | handshake/version, fragmented frames, IDs, cancellation, notifications, timeout, crash/restart, HTTP redirect/TLS/auth, output flood, shutdown. |
| MCP mapping | invalid/changed schema, annotation lie, namespace collision, project self-approval, permission/precondition drift, result/artifact validation, uncertain remote effect. |
| extension E2E | trusted/untrusted project, headless restrictions, provider switch, resume drift, secret/escape canaries, extension failure leaves primary session coherent. |

### 13.12 Failure and security cases

- Project config is discovered but not semantically applied before trust; a parse
  bomb is still bounded by byte/time limits during safe inventory.
- Managed policy cannot be weakened by user, project, environment, settings file,
  CLI, session, hook, skill, MCP, provider, or model.
- Instruction includes cannot traverse roots, follow an outside symlink, cycle,
  or elevate project text to system/product authority.
- Secret-shaped settings are rejected and directed to a credential record; config
  backups and explain output remain redacted.
- Hook stdout cannot forge a permission or tool result. Hook stderr/control bytes
  are escaped and bounded.
- A fail-open hook cannot widen permission; at most its unavailable advisory
  observation is omitted where policy permits.
- Skill scripts and MCP servers get no ambient provider/Git/cloud credential,
  session-store path, daemon token, or broad workspace write.
- MCP annotations are untrusted. Unknown side effects default ask/deny, not read-
  only allow.
- Remote MCP redirects and auth obey exact origin policy; project servers cannot
  self-enable network or credential access.
- Extension update/drift unregisters tools and invalidates pending approvals
  before another invocation.

### 13.13 Migration, documentation, and installation work

R8 adds config schema supporting all scopes, trust database version 1,
instruction-manifest versions, extension records, hook protocol version, and MCP
server/capability versions. Each migration is copy-validate-switch with fixtures
from R7. The existing R7 user config is preserved as user scope; no project file
becomes trusted during migration.

Install/uninstall docs inventory user/project config, trust records, skills,
hooks, MCP server processes/config, credential references, caches, and logs.
Removing Robin does not delete project files. `doctor` checks extension manifests,
integrity, executable paths, sandbox/network ability, stale server processes,
capability drift, and trust without starting untrusted project extensions unless
the user requests a labeled active probe.

### 13.14 Acceptance evidence

R8 is accepted only when:

- every configuration scope and managed floor has deterministic explain/migration
  evidence;
- untrusted or materially changed project settings/extensions remain inactive
  until category-specific trust;
- instruction source/import/path-scope inspection exactly matches prompt context
  manifests across at least two providers;
- skills load progressively and scripts cannot bypass tools;
- hooks execute through framed, bounded, sandboxed lifecycle and cannot forge
  success/permission/tool results;
- local stdio and reviewed remote HTTP MCP servers pass conformance, permission,
  credential-origin, drift, result, uncertainty, and cleanup suites;
- the end-to-end extension demo completes while leak/escape canaries remain zero;
- config/trust/extension migrations and resume after change/revocation pass;
- all prior gates remain green and user/reference/security docs match shipped
  behavior; and
- the first supported developer-release bundle installs on every claimed matrix
  cell, exposes only target command/flag vocabulary, links its evidence, and
  makes no R9 or Robin 1.0 claim.

### 13.15 Explicit deferrals

R8 defers subagents, agent teams, parallel mutable work, automatic skill/plugin
marketplaces, arbitrary repository-supplied MCP trust, browser/computer-use,
background daemon, remote workers, organization identity, editor clients, and
Code-OSS.

### 13.16 Requirements traced

R8 owns `FR-CONF-001–010`, `FR-CTX-011–012`, `FR-EXT-001–008`, and the
shipped-extension portion of `FR-EXT-012`. It advances `FR-PERM-009–012`,
`FR-PROV-003`, `FR-CRED-005–010`,
`FR-AUTO-007`, `FR-OPS-002–004`, `NFR-SEC-001–006`,
`NFR-PRIV-001–004`, and `NFR-MAINT-001–004`.
Subagent requirements `FR-EXT-009–011` and the subagent portion of
`FR-EXT-012` remain exclusively post-1.0 R9 work.

## 14. R9 — Subagents, Isolated Worktrees, and Background Supervision

**Status:** planned exclusively after Robin 1.0. R9 code, commands, feature flags,
schemas that imply active support, and release claims are absent from the R8
supported developer bundle and R10 1.0 runtime composition.

**Effort range:** 8–12 part-time weeks.

### 14.1 Why R9 exists

Subagents and background work increase throughput but multiply workspace,
permission, budget, recovery, and causality risks. R9 introduces them only after
Robin 1.0 has proved the foreground product. Parallel mutable work uses isolated Git
worktrees and imports reviewed results; no child shares unrestricted writes with
the parent.

### 14.2 Prerequisites

- R10 is accepted as Robin 1.0, with R9 absent from its public runtime and
  command surface.
- R8 is accepted for extension identity/trust and R6 is accepted for Git common-
  directory, ref, edit journal, and exact patch import behavior.
- R3 local state passes one-writer, crash, tail, snapshot, CAS, migration, and
  garbage-collection fault suites.
- The earlier Milestone C worktree/artifact prototype is treated only as audit
  input. Every reused concept begins with a new failing test for its recorded
  issue; no WIP source is merged wholesale.
- The threat model covers confused deputy delegation, child prompt injection,
  fan-out/cost exhaustion, cross-worktree mutation, common-directory exposure,
  daemon socket impersonation, split brain, orphan processes/worktrees, and
  background approvals.

### 14.3 Packages, files, interfaces, and records

Expand `packages/robin-extensions` with:

- `src/subagent/manifest.ts`: child name, purpose, prompt template, model/profile,
  tools, permission ceiling, context sources, budgets, concurrency, workspace
  mode, skills/MCP, result schema, and timeout;
- `src/subagent/delegation.ts`: parent request normalization and effective child
  contract intersection;
- `src/subagent/scheduler.ts`: depth/fan-out/concurrency/resource limits and
  dependency states;
- `src/subagent/channel.ts`: parent-child messages and bounded result artifacts;
- `src/subagent/result.ts`: structured findings, citations, patch candidate,
  verification, unresolved state, and usage;
- `src/subagent/recovery.ts`: replay, cancel, orphan, and worktree reconciliation.

Expand the existing `packages/agent-driver` boundary with versioned backend
manifests for Robin's direct-model agent, deterministic scripted agent, a
protocol-mediated external agent, and a contained black-box CLI agent. The
direct-model path remains the product default; an external backend cannot replace
session, permissions, tools, context provenance, persistence, or UI.

Expand `packages/tool-git` with:

- `src/worktree/plan.ts`: repository/common-dir/base/tree/sparse/submodule facts,
  target root, ownership marker, and cleanup strategy;
- `src/worktree/create.ts`: detached isolated worktree creation through Git;
- `src/worktree/identity.ts`: common-dir/worktree/admin-dir linkage and liveness;
- `src/worktree/import.ts`: derive patch from pinned base/final tree and apply to
  parent only through normal edit/Git permission;
- `src/worktree/cleanup.ts`: exact owned root/admin metadata cleanup and orphan
  inventory;
- `src/worktree/recovery.ts`: current Git facts to created/active/completed/
  missing/foreign/uncertain state;
- cases for linked worktrees, sparse checkout, submodules, shallow repositories,
  alternates, includes, hooks/filters, path overlap, and lazy fetch.

Expand `packages/robin-session` with parent/child session IDs, delegation
records, causal edges, worktree lease, scheduler state, child budgets, background
ownership, detached/paused/waiting-approval states, and result import records.

Expand `packages/local-state` with:

- `src/command-queue.ts`: durable prepared/claimed/settled commands;
- `src/lease.ts`: owner, generation, deadline, heartbeat, and compare-and-swap;
- `src/supervisor-lock.ts`: one daemon per installation and split-brain defense;
- `src/runtime-registry.ts`: active processes/provider attempts/worktrees;
- `src/background-index.ts`: rebuildable status and pending-approval projections;
- `src/reconciliation.ts`: session/tool/subagent/worktree startup recovery.

Expand `packages/robin-application` with `src/supervisor/*` use cases for start,
attach, detach, status, wait, cancel, approve/deny, logs, recover, and cleanup.

Create `apps/daemon` as a local composition root. It owns active session writers,
provider credential resolution, child processes, worktree leases, queue claims,
and recovery. It imports the same `robin-application`, `robin-agent`,
`robin-tools`, and permission services as the foreground CLI. It contains no
second reducer or tool implementation.

R9 uses an explicitly provisional, versioned owner-only Unix-domain socket
protocol for CLI attachment; R11 stabilizes the public client protocol. The R9
protocol still has frame length, request ID, client nonce, peer identity when
available, capability version, idempotency key, cursor, backpressure, and limits.

### 14.4 Delegation contract and effective authority

Parent delegation includes:

```ts
interface SubagentDelegationV1 {
  readonly parentSessionId: SessionId;
  readonly parentTurnId: TurnId;
  readonly objective: string;
  readonly modelProfile: ProviderProfileId;
  readonly toolAllowlist: readonly ToolSelector[];
  readonly permissionCeiling: PermissionSnapshotHash;
  readonly contextManifest: ContextManifestRef;
  readonly budget: SubagentBudget;
  readonly workspaceMode: "read_only_shared" | "isolated_worktree";
  readonly resultSchema: TrustedJsonSchemaRef;
  readonly deadline: Timestamp;
}
```

The effective child configuration is the intersection of parent authority,
managed/user policy, child manifest, selected provider capability, available
sandbox, remaining parent budget, and workspace mode. An empty intersection is a
denied delegation, not a fallback to parent defaults. A child cannot select a new
credential, extension, model, tool, MCP server, network endpoint, or permission
outside this intersection.

Limits include maximum depth, children per parent, total descendants, concurrent
provider calls, concurrent processes, total tool calls, tokens, cost, wall time,
context bytes, output bytes, and worktree count. Parent and child usage charge to
both child and ancestor aggregate budgets. Cancellation propagates downward; a
child cannot delegate unless its effective contract includes a smaller explicit
delegation allowance.

Child results are data. A result may contain findings with source references,
questions, a patch candidate derived from its worktree, verification records, and
uncertainties. It cannot directly mutate the parent's live workspace or declare
its tests authoritative for a different tree.

### 14.5 Concurrency and scheduling algorithm

The scheduler models `created`, `ready`, `running`, `waiting_for_tool`,
`waiting_for_approval`, `waiting_for_dependency`, `cancelling`, `completed`,
`failed`, `cancelled`, `orphaned`, and `uncertain`. It selects ready children by
stable priority and creation sequence while enforcing global/parent/provider/
workspace/resource semaphores.

Read-only children may share a workspace snapshot while the parent holds no
mutation. A shared snapshot binds HEAD/index/worktree hashes and becomes stale on
change. Mutable children require distinct isolated worktrees. Two agents never
mutate the same worktree concurrently. Parent mutation and candidate import use a
workspace coordinator lease.

Scheduler state is event-derived. Queue claims use lease generation and
compare-and-swap; a stale generation cannot settle a command. Fairness limits
prevent one parent from consuming every provider/process slot. Cancellation
removes unstarted work and aborts running descendants; final parent settlement
waits for bounded child reconciliation.

### 14.6 Isolated worktree creation and ownership

Worktree roots live under Robin's private durable/cache-managed run root, never
under an unresolved user path or the source repository. Creation:

1. bind repository/common-dir/worktree and require a specific base commit/tree;
2. inspect shallow/sparse/submodule/alternates/config-include facts and decide
   support before creating anything;
3. allocate an owner-private exact directory and write a pre-creation ownership
   plan outside it;
4. invoke Git with controlled args to add a detached worktree at the exact base;
5. verify physical root, `.git` indirection, common directory, admin directory,
   HEAD/tree, branchlessness, case/Unicode behavior, and no overlap with another
   workspace root;
6. install a Robin ownership marker containing opaque worktree/session IDs,
   expected paths, repository identity, creation build/time, and random nonce;
7. pin configuration that disables repository hooks/external helpers for Robin
   Git plumbing; commands still receive their explicit sandbox plan;
8. append `WorktreeCreated` only after verification.

The authoritative child workspace is writable only through its Robin tools.
Untrusted commands run in a sandbox view according to R5 and cannot access the
parent live checkout, unrelated worktrees, Git credential stores, provider keys,
or container socket. If a tool needs Git objects, access to the common directory
is narrowed and read/write implications are part of its plan.

Sparse/submodule repositories are supported only after exact fixtures. Network
fetch is never implicit during creation. A missing object produces an actionable
need-fetch result; any fetch is a separate approved Git/network operation.

### 14.7 Candidate import and conflict handling

On child completion Robin identifies final worktree tree and diff relative to the
pinned base. It rejects Git-internal changes, outside links, oversized/binary
content not supported by the target tool, untracked ambiguity, and a worktree
whose current state cannot be attributed to child operations.

The parent receives a bounded patch artifact plus exact base/preimage/postimage
manifest and child verification facts. Import re-observes the parent's current
paths. Cleanly matching preimages can be previewed and applied through R6's
journal and permission. Conflicting or externally changed paths are listed; Robin
does not auto-merge model output over them. The user may ask the parent agent to
rebase the candidate conceptually through new reads/edits, but that is a new
normal tool flow.

Child tests are labeled as run on the child tree/sandbox. After import, Robin
marks them stale until relevant verification runs on the parent result.

### 14.8 Worktree cleanup and recovery

Cleanup resolves a typed worktree handle from durable state, verifies ownership
marker nonce, physical root, admin directory, common directory, and no live lease
or process. It uses Git's exact worktree removal where safe, then verifies admin
metadata. Direct recursive deletion is allowed only for an exact validated
Robin-owned root after Git removal/recovery and never uses a broad root, glob,
environment expansion, home, or repository root.

Dirty child worktrees are retained by default as recovery evidence until result
export or explicit discard. Cleanup never prunes foreign Git worktree metadata.
Orphan scan compares Robin records, exact roots, markers, Git worktree list, live
processes, and locks, then classifies recoverable-owned, active, foreign, missing,
or ambiguous. Ambiguous roots are reported and not removed.

### 14.9 Background daemon and local protocol

The daemon acquires an installation lock containing process-start identity and
nonce, then binds an owner-only socket under the platform runtime root. It
verifies socket type/owner/mode, refuses symlink paths, and uses peer credentials
where supported plus a short-lived installation-session nonce. The socket never
listens on TCP in R9.

Requests are bounded frames with protocol version, method, request ID, client
identity, idempotency key, canonical request hash, and optional event cursor.
Mutating request results are stored by caller/method/key/hash so reconnect cannot
duplicate an approval, cancellation, or submitted message. Hash mismatch for a
reused key is an error.

The daemon owns session writer locks and active resources. CLI clients subscribe
from a committed event cursor through bounded notifications; slow clients receive
a resync-required marker and reread durable events rather than consuming
unbounded memory. Detaching closes only the client. Closing the last client does
not cancel a background session.

On daemon startup:

1. validate installation lock/state format and bind the socket;
2. scan sessions marked active/background under bounds;
3. acquire eligible session locks and replay state;
4. reconcile provider/tool/process/edit/Git/worktree/subagent unfinished records;
5. reclaim only expired leases whose generation/owner liveness permits it;
6. restore ready queue and pending approvals;
7. publish recovery summaries before accepting new mutation.

Background approval waits with an expiry and visible status. No unavailable
terminal is simulated. A client attaches and resolves it, an exact external
permission callback handles it, or the action expires/denies. Managed maximum
unattended time and cost always apply.

### 14.10 External-agent compatibility tiers

Robin supports multiple agent backends through an explicit `AgentBackend` port:

```ts
interface AgentBackend {
  readonly manifest: AgentBackendManifest;
  advance(request: AgentAdvanceRequest, signal: AbortSignal): AsyncIterable<AgentBackendEvent>;
}
```

The manifest declares protocol/version, context input, tool mediation, model and
credential ownership, streaming, cancellation, resume, subagent support, and
containment tier. Normalized events can emit content, Robin tool proposals,
clarification requests, usage, candidate artifacts, outcome, and failure. They
cannot emit an already-authorized effect.

Compatibility tiers are:

- **Robin direct model:** Robin owns prompt, provider, tools, context, permissions,
  and transcript; full shipped guarantees apply.
- **Mediated external protocol:** a pinned external-agent protocol such as a
  reviewed ACP version receives context and can request only Robin-advertised
  tools through a framed bridge. Full tool mediation applies only when the agent
  has no undisclosed filesystem/process/network channel.
- **Contained black-box CLI:** Robin supplies a filtered isolated worktree and
  sandbox, disables ambient credentials/network unless explicitly granted, and
  imports a candidate result. Robin claims containment and import review, not
  exact internal context or per-action mediation.
- **Unsupported experiment:** manually configured development path with no
  release compatibility claim.

A mediated adapter performs handshake/capability negotiation, pins protocol and
agent versions, maps every file/terminal request into Robin tools, bounds all
frames, verifies cancellation, and passes the agent-backend conformance corpus.
If the external agent can open files or spawn processes outside the bridge, it is
reclassified as contained black-box.

A contained CLI receives a new isolated worktree or filtered snapshot, a minimal
environment, no provider/Git/cloud/Robin credential or socket, a sandbox plan,
explicit model credential only when the user deliberately delegates it to that
agent sandbox, network policy, time/output/process/cost bounds, and declared
candidate-output locations. Robin treats stdout/stderr as untrusted and imports
only validated patch/result artifacts. Delivering a credential to the agent is
recorded and lowers the credential-confinement claim for that run.

“Any agent” means an agent for which one of these explicit adapters and tiers
passes its contract. An arbitrary executable does not become fully mediated by
being launched from Robin.

### 14.11 Implementation tickets and sequence

1. **R9.01 — Freeze delegation schemas.** Define parent/child IDs, authority
   intersection, budgets, workspace modes, states, results, causal events, and
   migration fixtures.
2. **R9.02 — Implement authority intersection.** Test every tool/permission/
   provider/context/extension/budget combination and prove no child widening.
3. **R9.03 — Implement scheduler reducer.** Add dependencies, fairness,
   semaphores, depth/fan-out, aggregate budgets, deterministic selection,
   cancellation, and replay tests.
4. **R9.04 — Build read-only child path.** Share pinned snapshot, invalidate on
   mutation, return structured findings, and test parent cancellation/failure.
5. **R9.05 — Freeze worktree records.** Convert every prior WIP audit finding into
   a failing test for ownership, common-dir, overlap, include config, lazy fetch,
   process cancellation, quota, and cleanup.
6. **R9.06 — Implement worktree creation.** Add exact base/detached create,
   physical/admin/common-dir verification, marker, sparse/shallow/submodule
   support matrix, and no implicit fetch.
7. **R9.07 — Isolate child tools/processes.** Enforce one writer, parent-root
   denial, sandbox mounts, credential/socket exclusion, and process cleanup.
8. **R9.08 — Implement candidate export/import.** Derive base/final manifest,
   bounded patch, attribution, permissioned parent application, conflicts, and
   verification staleness.
9. **R9.09 — Implement worktree cleanup/recovery.** Verify handles/markers/leases,
   retain dirty evidence, exact Git removal, owned-root cleanup, orphan inventory,
   and foreign/ambiguous denial.
10. **R9.10 — Implement durable queue/leases.** Add prepared/claimed/settled
    commands, generation/heartbeat/CAS, owner liveness, replay, and split-brain
    tests.
11. **R9.11 — Implement daemon composition.** Reuse application/agent/tool/
    permission services, own writers/resources, and prohibit second engine
    imports through architecture tests.
12. **R9.12 — Implement provisional socket protocol.** Add private frame schema,
    socket/peer auth, nonce, idempotency, cursor subscription, backpressure,
    reconnect, and exact cleanup.
13. **R9.13 — Implement attach/detach/status/wait.** Preserve terminal renderer,
    replay from cursor, detach without cancel, foreground reattach, and machine
    output.
14. **R9.14 — Implement background approvals.** Add expiry, pending index,
    attach/callback resolution, stale precondition invalidation, and no fake TTY.
15. **R9.15 — Implement daemon startup recovery.** Reconcile every unfinished
    provider/tool/process/edit/Git/MCP/subagent/worktree class before queue work.
16. **R9.16 — Add fault/concurrency harness.** Kill clients/daemon/children at
    every barrier, pause clocks, reuse PIDs, replace sockets/locks/nonces, partition
    slow clients, and assert no duplicated effect or dual writer.
17. **R9.17 — Add multi-agent E2E.** Parent delegates one read-only research child
    and two mutable isolated children, cancels one, imports one candidate, reruns
    verification, backgrounds, restarts daemon, attaches, and completes.
18. **R9.18 — Add resource/quota/GC tests.** Enforce descendants, worktrees,
    sessions, CAS bytes/objects including zero-byte metadata, provider calls,
    processes, logs, and retention across multiple daemon instances.
19. **R9.19 — Add daemon/install operations.** `daemon start|stop|status|logs`,
    background session commands, read-only doctor, exact cleanup, launch-service
    experiment kept opt-in, and uninstall behavior.
20. **R9.20 — Document guarantees.** Publish delegation, authority, concurrency,
    worktree, import, background, socket, approval, recovery, resource, and
    cleanup semantics plus unsupported remote/distributed behavior.
21. **R9.21 — Freeze agent-backend contract.** Define manifests, normalized
    events, capability/credential/containment tiers, resume/cancel, and conformance
    fixtures without provider or tool objects leaking across the port.
22. **R9.22 — Implement one mediated protocol adapter.** Pin the selected protocol
    version, handshake, map all operations through Robin tools, bound frames,
    disable hidden channels, and pass mediation/escape/cancellation tests.
23. **R9.23 — Implement contained CLI adapter.** Create filtered worktree/sandbox,
    strip credentials/sockets/network by default, bound process/output, validate
    candidate artifacts, and label containment-only evidence.
24. **R9.24 — Publish agent compatibility matrix.** Generate direct/mediated/
    contained/experimental tier evidence, credential disclosure, residual hidden-
    channel limits, and cross-backend eval results.

### 14.12 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| delegation | allowlist intersection, managed floor, missing capability, budget ancestry, depth/fan-out, credential/extension/model widening, result schema. |
| scheduler | deterministic order, fairness, dependencies, semaphores, cancellation tree, crash replay, aggregate cost, starvation bounds. |
| worktree | linked/common-dir, detached/base, overlap, marker spoof, sparse/shallow/submodule, include config, missing object, no implicit fetch, parent-root denial. |
| candidate import | clean/conflicting paths, mixed attribution, binary/oversize, untracked, stale parent, partial apply, verification stale, approval change. |
| cleanup | active/dirty/clean/missing/foreign/ambiguous, marker/nonce mismatch, live process/lease, Git metadata failure, exact owned recursive cleanup. |
| queue/lease | two daemons, generation, delayed heartbeat, PID reuse, lock replacement, claim/settle races, crash each barrier, no double execution. |
| socket | owner/mode/symlink, peer identity, nonce, frame limits, idempotency mismatch, reconnect cursor, slow client, spoofed approval, daemon replacement. |
| recovery | every unfinished provider/tool/process/edit/Git/MCP/child/worktree state, uncertain effects block, recovery event before new mutation. |
| E2E | read-only and mutable children, separate worktrees, cancel, candidate import, background detach/restart/attach, pending approval, final factual summary. |
| external agents | manifest/protocol drift, mediated tool/context enforcement, hidden-channel reclassification, contained credential/network/root canaries, candidate import, cancel/resume, tier report. |

### 14.13 Failure and security cases

- Parent instructions, model text, skill, hook, or MCP cannot increase a child's
  effective authority beyond the computed intersection.
- A child never receives ambient provider, Git-host, cloud, SSH-agent, OS-store,
  daemon, or parent-session authority.
- Parallel mutation requires distinct verified worktrees; shared live-workspace
  mutation is serialized or denied.
- Worktree common-directory access is treated as repository-wide authority and
  minimized; a child cannot mutate refs or other worktrees through `.git` paths.
- Missing shallow objects do not trigger hidden network fetch.
- Candidate import never auto-merges over parent drift and never reuses child
  verification as current-parent verification.
- Cleanup resolves exact typed handles and markers, never a broad path or glob;
  foreign/ambiguous roots remain untouched.
- Socket path replacement, wrong owner/mode, peer mismatch, stale nonce, or dual
  daemon lock prevents service.
- Lease expiry alone does not permit concurrent execution when owner liveness or
  effect state is ambiguous.
- Background mode cannot wait forever for an invisible approval, exceed unattended
  budgets, or convert missing user input into allow.
- A daemon crash cannot cause provider/tool/Git/MCP external effects to be blindly
  repeated.
- An external agent's self-description cannot upgrade its tier. Any undisclosed
  direct filesystem/process/network channel removes the full-mediation claim.
- A black-box CLI receives no model credential unless the user explicitly grants
  the exact credential audience to its sandbox and accepts the lower guarantee.

### 14.14 Migration, documentation, and installation work

R9 adds child/session/queue/lease/worktree/background schemas and a provisional
protocol version. R8 sessions remain foreground; migration never marks them
background automatically. Worktree records from the old Milestone C branch are
not imported. Any developer test roots from that branch are inventory-only and
require explicit, exact cleanup.

The post-1.0 R9 package adds `robin daemon start --foreground`; automatic login
launch remains out of scope until a separate post-1.0 service-install decision
and gate. `doctor` reports daemon lock/
socket ownership, protocol/build, active sessions, pending approvals, worktrees,
processes, quotas, and orphan candidates without cleaning. Uninstall stops only
the exact Robin daemon after identity verification, preserves active/recovery
data by default, and lists retained worktrees.

### 14.15 Acceptance evidence

R9 is accepted only when:

- the delegation matrix proves child authority is never broader than parent,
  managed policy, manifest, provider capability, and remaining budget;
- read-only shared and mutable isolated child workflows pass with deterministic
  scheduling and factual results;
- every mutable child has a separate verified worktree and parent import uses
  normal permission/preimage/edit-journal paths;
- daemon detach/restart/attach resumes committed history, pending approvals, and
  recoverable work without dual writers or duplicate effects;
- socket/lease/split-brain/PID-reuse/slow-client/spoof tests pass;
- worktree creation/import/cleanup/orphan tests include sparse, shallow,
  submodule, common-dir, marker, overlap, missing-object, and hostile config cases;
- quota and CAS metadata accounting remain correct across more than one store/
  daemon instance;
- every process/socket/temp/worktree expected to be removed is gone and every
  retained recovery item is listed;
- the direct, mediated, and contained agent-backend tiers pass their distinct
  conformance/escape/import suites and the generated matrix makes no universal
  arbitrary-agent claim;
- all earlier gates pass and docs label the protocol provisional and service
  local-only.

### 14.16 Explicit deferrals

R9 defers remote workers, multi-machine consensus, shared team sessions, hosted
control plane, arbitrary agent binaries with hidden tools, autonomous deployment,
Kubernetes, TCP daemon exposure, stable external SDK protocol, editor clients,
and Code-OSS.

### 14.17 Requirements traced

R9 owns `FR-EXT-009–012`, `FR-PROC-009`, the worktree portion of
`FR-GIT-008`, and background extensions of `FR-SES-001–010`,
`FR-AGT-005–008`, `FR-PERM-006–010`, `FR-BUD-001–006`, and
`FR-OPS-002–010`. It advances `NFR-SEC-001–006`, `NFR-REL-001–005`,
`NFR-PERF-002–005`, `NFR-PRIV-001–004`, and `NFR-PORT-001–003`.
It also owns the direct/mediated/contained external-agent compatibility claims in
product requirements sections 2.4, 3.3, and 11.

## 15. R10 — Evals, Diagnostics, Packaging, Operations, and Robin 1.0

**Status:** planned.

**Effort range:** 7–11 part-time weeks after the R8 supported developer bundle; release
candidate observation time is additional elapsed time.

### 15.1 Why R10 exists

Robin 1.0 is not a tag placed on a development checkout. A new user must install
it, connect a supported provider, work in a real repository, recover from normal
failures, update or roll back, export or purge local data, and uninstall without
hidden steps. Deterministic safety, migration, performance, and compatibility
evidence must support every public claim.

### 15.2 Prerequisites

- R8 and its supported developer-release bundle are accepted.
- R9 has not begun and no subagent, isolated-worktree, daemon, or background
  surface is present in the 1.0 composition, help, package, migrations, or
  claims.
- Product requirements, architecture, threat model, operations plan, compatibility
  matrix, and this plan contain no unresolved critical contradiction.
- All durable schemas have oldest-supported fixtures and copy-validate-switch
  migrations.
- The public npm package name is owned and publication access uses protected,
  short-lived release credentials rather than a developer token in local config.

### 15.3 Packages, files, interfaces, and release records

Expand `packages/robin-observability` with:

- `src/log-event.ts`: closed structured log schema and severity/category;
- `src/redactor.ts`: exact secret/canary, credential metadata, path/privacy, and
  untrusted-error redaction;
- `src/log-store.ts`: private bounded files, rotation, retention, flush, and
  corruption behavior;
- `src/diagnostic-bundle.ts`: inventory, consent, collection, redaction,
  verification, and archive manifest;
- `src/metrics.ts`: local counters/histograms without repository content;
- `src/eval/scenario.ts`: versioned fixture, prompt, provider, tool, fault,
  expected invariant, and grader definitions;
- `src/eval/runner.ts`: isolated seeded execution and artifact capture;
- `src/eval/graders.ts`: invariant, task, test, patch, policy, recovery,
  performance, cost, and human-review graders;
- `src/eval/compare.ts`: baseline/candidate confidence and deterministic gates;
- `src/eval/report.ts`: JSON, Markdown, and static HTML report with provenance.

Expand `packages/robin-application` with doctor, support, cleanup, data inventory,
export, purge, eval-run/compare, update-check, and release-metadata use cases.

Expand `packages/robin-platform` with:

- `src/install/provenance.ts`: version, build commit, dependency lock hash,
  platform, channel, package integrity, and attestation metadata;
- `src/update/channel.ts`: stable/beta manifest fetch, signature/checksum
  validation, rollout, skip, and offline behavior;
- `src/archive.ts`: safe archive extraction with path/link/type/size limits;
- `src/support.ts`: platform/runtime/Git/sandbox/credential-store probes;
- `src/process-inventory.ts`: exact foreground Robin child-process and sandbox
  resource ownership checks.

Add repository release infrastructure:

```text
.github/workflows/ci.yml
.github/workflows/security.yml
.github/workflows/release.yml
.github/workflows/nightly-evals.yml
scripts/release/build-package.mjs
scripts/release/verify-package.mjs
scripts/release/generate-sbom.mjs
scripts/release/generate-checksums.mjs
scripts/release/verify-clean-install.mjs
scripts/release/verify-upgrade-rollback.mjs
scripts/release/verify-uninstall.mjs
packaging/homebrew/robin.rb
fixtures/releases/<supported-old-version>/
evals/deterministic/
evals/adversarial/
evals/repository-tasks/
evals/provider-conformance/
evals/recovery/
evals/performance/
docs/reference/
docs/operations/
```

The public package remains one scoped CLI package with one `robin` binary. Private
workspace packages are bundled and not published as separately supported SDKs.
Generated build metadata is immutable and included in `robin --version --json`.

### 15.4 Evaluation scenario and grader design

An eval scenario contains:

```ts
interface EvalScenarioV1 {
  readonly id: string;
  readonly version: number;
  readonly fixture: GeneratedFixtureRef;
  readonly initialPrompt: string;
  readonly provider: EvalProviderProfile;
  readonly permission: EvalPermissionProfile;
  readonly budgets: EvalBudgets;
  readonly injectedFaults: readonly ScheduledFault[];
  readonly invariants: readonly DeterministicInvariant[];
  readonly graders: readonly GraderConfig[];
  readonly retention: EvalRetention;
}
```

Fixtures are generated from source-controlled recipes into disposable roots and
record expected hashes. A test never mutates a developer checkout. Scenarios pin
Robin build, dependency lock, OS/runtime/Git/sandbox, provider adapter/model,
policy/config, random seed, pricing date, fixture version, and evaluator version.

Deterministic invariants gate release directly:

- denied context absent from provider requests, transcript, logs, model results,
  support bundle, and child environments;
- malformed/denied/stale tools never reach executor;
- outside-root and unrelated Git/index/worktree data unchanged;
- no raw credential or canary in forbidden surfaces;
- every effect has prepare/start/settle or documented recovery state;
- replay performs no side effect and crash recovery duplicates none;
- terminal/machine output remains syntactically safe;
- all owned foreground processes, sockets, temp files, and sandbox resources are
  cleaned or listed as retained evidence;
- usage/cost and verification claims derive from facts.

Task graders check tests, lint/typecheck when scenario-defined, expected behavior,
patch scope, diff quality, forbidden changes, and final factual summary. Policy,
recovery, latency, cost, context efficiency, permission interruption, and tool
loop graders use deterministic records. Model-judged quality is optional,
versioned, separated from safety, and cannot override a failed invariant.

Real-model comparisons use repeated runs, confidence intervals, practical effect
thresholds, and cost caps. A single stochastic failure may trigger review, but a
deterministic safety or migration regression fails immediately. Baselines are
immutable signed artifacts tied to scenario and adapter versions.

### 15.5 Required evaluation corpus

Before 1.0, source-controlled suites include at least:

- 60 policy/permission decisions across every product mode and tool class;
- 50 physical path/file cases covering traversal, links, races, encodings,
  devices, ignored/secret/generated content, and resource exhaustion;
- 40 patch/batch/checkpoint/rewind cases including partial failure and external
  drift;
- 35 process/sandbox cases covering injection, environment, network, resource,
  output, process-tree, PTY, prompt, and cancellation behavior;
- 35 Git cases covering dirty/index/ref/worktree/submodule/config/remote states;
- 30 provider fixtures per claimed adapter plus common conformance cases;
- 30 persistence/lock/migration/recovery fault schedules;
- 25 configuration/trust/instruction cases;
- 25 skill/hook/MCP extension isolation cases;
- 15 real repository tasks across bug fix, feature, refactor, tests, build failure,
  code explanation, and safe Git preparation;
- no R9 delegation, isolated-worktree, daemon, or background suite is part of
  the 1.0 artifact because those surfaces begin only after 1.0.

Counts are minimum unique semantic cases, not assertions or duplicated parameter
rows. The release report lists every case ID, result, duration, platform, and
artifact hash.

### 15.6 CI and release gates

Pull-request CI runs formatting, typecheck, architecture/import checks, package
unit tests, deterministic integration tests, PTY/subprocess tests, temp-repository
safety, provider fixture conformance, storage fault tests, migration tests, and
fast deterministic evals on macOS and Linux. It uses no live provider key for
untrusted code.

Nightly protected CI adds mutation/fuzz campaigns, all fault schedules, strict
sandbox/container matrix, performance benchmarks, package clean installs,
old-version upgrade/rollback, extension/MCP fixtures, optional live provider
smokes with minimum scopes/budgets, and leak-canary scans. Logs and artifacts pass
redaction before upload.

Release-candidate gates require:

- zero critical/high unresolved security findings; medium findings have explicit
  owner/decision and cannot contradict published guarantees;
- all deterministic evals green on every supported platform/runtime;
- provider conformance green for every claimed adapter/tier;
- clean install, first run, upgrade, rollback, and uninstall tests green in fresh
  machines/containers;
- migrations from every supported version produce equivalent terminal
  projections and retain rollback source;
- performance and resource budgets within accepted thresholds;
- dependency vulnerability/license/SBOM review complete;
- docs/link/command/schema examples executable and green;
- signed/checksummed artifacts reproduce from the release commit within the
  documented reproducibility boundary.

### 15.7 Packaging and provenance

Primary installation is:

```text
npm install --global @zachshotamartin/robin@<version>
```

The package declares supported Node versions, includes compiled production files,
README/license/notices, schemas, required runtime assets, and no source secrets,
tests with sensitive fixtures, state, absolute build paths, or workspace-only
dependencies. `npm pack` inventory is allowlisted and installed into an empty
temporary prefix for tests.

The release workflow checks out an exact protected tag, uses a pinned runtime and
lockfile with `npm ci`, runs full gates, builds once, verifies package contents,
generates CycloneDX or SPDX SBOM, computes SHA-256 checksums, signs/attests artifacts
through the approved GitHub/npm provenance mechanism, publishes with protected
environment approval, then independently downloads and verifies the package.

GitHub release assets contain the npm tarball, checksums, signatures/attestations,
SBOM, compatibility matrix, migration notes, and eval summary. A Homebrew formula
may install the verified npm artifact plus supported Node runtime into `libexec`;
its formula test runs version/help/doctor and an offline synthetic session. Robin
does not advertise a standalone native binary unless its Node/native dependencies,
signing, notarization, and clean-machine suite pass separately.

An installer script, if shipped, downloads a versioned manifest and artifact,
verifies signature/checksum before extraction, rejects archive traversal/links/
devices/oversize, displays destination and shell-path changes, and never pipes
unverified network bytes into a shell. Manual install remains documented.

### 15.8 Versioning, update, upgrade, and rollback

Robin uses semantic versioning for CLI behavior and independently versioned
durable/protocol/config/extension schemas. A compatibility table names read/write
ranges. A new build refuses write access to newer unsupported durable state.

Update checks are off in hermetic/CI mode, disclose network destination, send no
repository/session content, use a bounded signed channel manifest, cache only safe
metadata, and can be disabled. Stable and beta channels are explicit. Robin may
notify; self-update is shipped only for install channels where ownership and
atomic rollback are proven. npm installs normally direct users to their package
manager.

Upgrade tests install the oldest supported release, create real fixture sessions,
config/trust/credentials metadata/extensions, interrupt active work, install the
candidate, migrate copy-validate-switch, resume/export, then roll the executable
back and verify the preserved old state or documented forward-only boundary.
Migrations never rewrite the sole copy.

Rollback notes identify executable compatibility and state compatibility
separately. A failed migration leaves the old index pointer active and writes
diagnostic evidence without secret content.

### 15.9 Doctor, logs, support, cleanup, and data lifecycle

`robin doctor` is read-only by default. It checks executable provenance/version,
Node/platform/Git, package integrity, state/config/log permissions, formats/
migrations, free space, locks, credential-store availability, provider profile/
catalog, optional auth/network probes, sandbox backends, foreground process and
sandbox-resource inventory, local session-store health, extension integrity/MCP
status, update channel, and terminal support.
Each optional network or mutating probe requires an explicit flag.

Structured logs are private, bounded, rotated, and retention-limited. They contain
correlation IDs and safe categories, not prompts/source/tool output by default.
Debug content is opt-in and still redacted. Log failures do not crash a session
unless audit durability is required; failures are surfaced without recursive
logging loops.

`robin support bundle --dry-run` builds an inventory of exact files/fields,
redactions, sizes, hashes, and omissions. Creation requires confirmation, writes
an owner-private archive with safe paths, reopens/verifies it, and prints its
location. It excludes credentials, raw repository content, unapproved transcript/
tool artifacts, lock nonces, and tokens.

Data commands separate inventory, export, archive, delete-to-recoverable-trash,
and permanent purge. Project and global purge always have dry run, exact IDs/
roots, retention/dependency checks, and manifests of succeeded/failed/retained
items. They never accept an unresolved broad root. Cache purge does not delete
durable sessions. Credential removal uses its own command and identifies external
secrets Robin cannot revoke.

### 15.10 Install, first-run, uninstall, and clean-machine tests

For every claimed OS/architecture/runtime combination, a clean test performs:

1. install through the claimed channel;
2. run version/help/completion and read-only doctor before state exists;
3. start an offline synthetic session in a generated repository;
4. configure a fake/local provider without a secret and complete edit/test/diff;
5. configure a protected live-provider smoke where available without exposing
   the key;
6. exit/resume/export and test configuration/permission/instruction behavior;
7. run a strict sandbox probe/command when the matrix claims it;
8. upgrade from oldest supported state, verify, and exercise rollback;
9. uninstall executable/channel files without deleting user data by default;
10. reinstall and prove retained data is discoverable;
11. invoke exact data purge, verify remaining external credentials/project files,
    and remove only identified Robin-owned artifacts;
12. assert shell/profile/package-manager state matches documented outcomes.

Uninstall docs are channel-specific. npm uninstall does not imply data deletion.
Homebrew removal does not kill an unidentified foreground process or delete
repository content. Post-1.0 daemon/worktree cleanup is not claimed by R10.

### 15.11 Implementation tickets and sequence

1. **R10.01 — Freeze eval schema.** Define scenarios, fixtures, faults,
   invariants, graders, provenance, retention, results, and old-version parsing.
2. **R10.02 — Implement isolated eval runner.** Generate disposable roots, pin
   config/provider/seed, enforce budgets, capture safe artifacts, clean/reconcile,
   and never run in source checkout.
3. **R10.03 — Implement deterministic graders.** Add policy/path/patch/process/
   Git/provider/persistence/extension invariants and machine-readable failures.
4. **R10.04 — Implement task and stochastic comparison.** Add tests/behavior/
   patch scope, repeated runs, confidence/practical thresholds, versioned model
   grader, and strict separation from safety.
5. **R10.05 — Build required corpora.** Assign stable semantic IDs, generate
   fixtures, meet minimum counts, seed known regressions, and prove each gate
   catches its seed.
6. **R10.06 — Implement reports.** Produce JSON/Markdown/static HTML with exact
   provenance, case evidence, confidence, cost/latency, omissions, and hashes.
7. **R10.07 — Complete structured logs/redaction.** Add private rotation,
   retention, correlation, debug controls, canary scans, output/error/provider/
   extension paths, and failure behavior.
8. **R10.08 — Complete doctor.** Add every read-only probe, explicit active probe,
   human/JSON schemas, remediation, unsupported-platform truth, and no-fix default.
9. **R10.09 — Implement support bundle.** Dry-run inventory, consent, field/file
   redaction, safe archive, verification, retention, and no-secret corpus.
10. **R10.10 — Complete data lifecycle.** Inventory/export/archive/trash/purge,
    dry run, exact ownership, CAS/child dependencies, partial failure, manifests,
    and reinstall discovery.
11. **R10.11 — Freeze public package inventory.** Bundle private workspaces,
    eliminate dev paths/files, set engines/bin/files/exports, generate metadata,
    and install tarball in empty prefixes.
12. **R10.12 — Build CI matrix.** Separate untrusted PR, protected nightly, and
    release permissions; add cache integrity, timeouts, artifact redaction, and
    platform/runtime axes.
13. **R10.13 — Add fuzz/mutation/security workflows.** Parsers, paths, frames,
    streams, JSON-RPC, policy, approval, patch, Git, archive, and extension
    boundaries with stable seeds and minimized regression fixtures.
14. **R10.14 — Add performance harness.** Measure cold/warm CLI, input/render,
    repository discovery, context, provider/tool streams, append/replay, process
    cancellation, memory/disk, and the target-versus-CI percentile budgets.
15. **R10.15 — Implement release artifact pipeline.** Clean tag build, package,
    SBOM, checksums, signature/attestation, provenance, independent download/
    verify, and protected publication.
16. **R10.16 — Implement Homebrew channel.** Pin artifact/hash/runtime,
    owner-correct paths, formula test, upgrade/rollback/uninstall, and keep it
    unreleased until matrix green.
17. **R10.17 — Implement safe update checks.** Signed bounded manifest,
    stable/beta/off, no repository data, caching, offline behavior, install-channel
    guidance, and no unproven self-update.
18. **R10.18 — Build migration matrix.** Install each supported old fixture/build,
    create/interrupt state, upgrade copy-validate-switch, resume/export, rollback,
    and corrupt/space/permission/lock failures.
19. **R10.19 — Build clean-machine matrix.** Execute the twelve-step install/
    first-run/upgrade/uninstall/purge flow on every claimed platform/architecture.
20. **R10.20 — Perform threat-model closure.** Map every threat to prevention,
    detection, recovery, test, residual risk, and docs; resolve all critical/high
    findings.
21. **R10.21 — Audit dependencies and licenses.** Generate SBOM, review runtime
    tree/native binaries/postinstall scripts/licenses/advisories, pin exceptions,
    and verify reproducible lock install.
22. **R10.22 — Execute release candidate.** Freeze schemas, run full gates twice
    from clean commits, observe beta/RC, triage regressions, and never waive a
    deterministic security failure for schedule.
23. **R10.23 — Complete user and operator docs.** Install, first run, daily use,
    providers/auth, permissions/sandbox, Git, sessions/context, config/trust,
    extensions, automation, doctor/support/data/update/uninstall, troubleshooting,
    compatibility, privacy, and residual risks.
24. **R10.24 — Complete portfolio evidence.** Record two-minute demo, technical
    walkthrough, architecture/trust diagram, eval report, recovery timeline,
    performance report, one security postmortem, and measured resume bullets.
25. **R10.25 — Publish 1.0 and verify.** Tag/publish, independently install from
    public channels, verify provenance/checksums, run smoke, monitor documented
    support channels, and retain rollback artifacts.

### 15.12 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| eval engine | invalid schema, fixture escape, seed repeatability, fault timing, invariant seed caught, grader crash, artifact limit, cleanup, report hashes. |
| logging/support | every secret/path/control canary, rotation/crash/disk full, debug mode, archive traversal, dry-run equality, consent, redaction verification. |
| data lifecycle | session/project/global exact targets, CAS/child refs, active lock, partial failure, trash/grace/purge, reinstall, external credentials/project files retained. |
| package | pack allowlist, executable bit/shebang, empty prefix, no workspace link, no absolute path/secret, supported Node, offline synthetic flow. |
| release | clean tag, lock reproducibility, SBOM/checksum/signature, tampered artifact/manifest, protected credential, independent download, failed publish recovery. |
| migration | every old version, active/incomplete/corrupt/huge state, no space, permission, lock, crash each copy/switch step, rollback window, newer-version refusal. |
| update | stable/beta/off, offline, signed/tampered/oversize manifest, privacy, rollout, install-channel mismatch, rollback guidance. |
| clean machine | each OS/arch/runtime/channel, install/doctor/first-run/resume/upgrade/rollback/uninstall/reinstall/purge and exact leftover inventory. |
| performance | cold/warm, terminal load, large repo, long session, output flood, provider stream, replay, memory/disk percentiles with machine provenance. |
| release corpus | all minimum case counts, cross-platform deterministic equality where specified, provider-tier reports, zero critical invariant regressions. |

### 15.13 Failure and security cases

- Release jobs from untrusted code receive no npm, signing, provider, Git-host, or
  credential-store authority.
- Package lifecycle scripts are minimized and reviewed; install never executes
  repository content or mutates shell profiles silently.
- Archive extraction rejects absolute/traversal paths, symlinks/hard links,
  devices, duplicate/case-colliding paths, expansion bombs, and size/count limits.
- An update manifest cannot redirect credentials or artifacts to an unapproved
  origin and is verified before acting.
- Diagnostics/support/eval reports never upload automatically. Optional telemetry
  remains off until separate destination/schema/retention/consent evidence exists.
- A migration never modifies the only source copy; insufficient space or a crash
  leaves the old pointer usable.
- Purge never uses home, state root, repository root, globs, or unresolved
  variables as a recursive target. Ambiguous ownership is retained and reported.
- Security invariant failures cannot be averaged away by task success or model-
  judged quality.
- Public claims use measured supported matrices and do not describe containers,
  local models, encryption, compatibility, or sandboxing more strongly than
  evidence.

### 15.14 Documentation and support deliverables

The release documentation set includes:

- quickstart with one offline synthetic and one real-provider path;
- CLI and slash-command reference generated from command schemas;
- configuration source/precedence/schema and trust reference;
- provider/model/auth/retention/cost and compatibility matrix;
- repository/edit/process/sandbox/Git behavior and recovery guides;
- session/context/compaction/export/retention/data locations;
- instruction/skill/hook/MCP schemas and security boundaries;
- headless JSON/JSONL/result schemas and exit codes;
- install/update/rollback/uninstall per channel;
- doctor/support bundle/logging/privacy/telemetry policy;
- threat model, residual risks, architecture, contributor/testing/release guide;
- changelog and migration notes with current versus planned features.

All commands in docs run in CI against the packaged binary. Screenshots and demo
transcripts identify the exact build and use fixture repositories/keys.

### 15.15 Acceptance evidence

Robin 1.0 is accepted only when:

- a fresh user can install from every claimed channel and complete the flagship
  real-repository workflow with one supported hosted provider;
- OpenAI, Anthropic, generic compatible, and local no-key claims match generated
  conformance evidence;
- sessions, context, permissions, sandbox, editing, verification, Git, config,
  instructions, skills, hooks, MCP, headless output, diagnostics, and data
  lifecycle meet their phase gates;
- R9 surfaces are absent from runtime composition, help, package, migration, and
  release claims because all R9 work begins after 1.0;
- deterministic corpus minimums pass on every supported platform with zero
  critical invariant or secret-canary failure;
- all supported upgrades/rollbacks and corrupted/failing migration cases behave
  as documented;
- package provenance, SBOM, checksum/signature, clean install, update, uninstall,
  reinstall, and purge tests pass;
- no unresolved critical/high security finding remains;
- performance measurements and residual limitations are published;
- the public package downloaded after publication passes independent smoke and
  matches release hashes;
- portfolio claims use measured counts, rates, latency, cost, and recovery facts.

### 15.16 Explicit deferrals

R10 defers a public JavaScript SDK, remote SaaS control plane, multi-tenant teams,
remote workers, Kubernetes, Windows sandbox parity, mobile/web clients, model
training/hosting, browser/computer-use, autonomous deployment, Code-OSS fork, and
any provider/extension not in the generated support matrix.

### 15.17 Requirements traced

R10 completes `FR-CLI-004–006`, `FR-CLI-011–012`, `FR-OPS-001–010`, remaining
installation/data/update clauses in sections 6.1 and 12.5, and release evidence
for every implemented `FR-*` requirement. It owns all release measurements for
`NFR-SEC-001–006`, `NFR-REL-001–005`, `NFR-PERF-001–005`,
`NFR-PRIV-001–004`, `NFR-A11Y-001–004`, `NFR-PORT-001–003`, and
`NFR-MAINT-001–004`.

## 16. R11 — Stable Local Client Protocol and Editor Decision Gate

**Status:** planned after Robin 1.0.

**Effort range:** 4–6 part-time weeks for protocol hardening, prototype, and
decision evidence.

### 16.1 Why R11 exists

An editor must be a client of Robin, not another coding agent. R11 freezes the
local service contract, proves concurrent CLI/editor observation, and measures
whether a normal VS Code extension can deliver the required experience. It does
not assume a Code-OSS fork is justified.

### 16.2 Prerequisites

- R10 is accepted. If R9 was not shipped, its local supervisor/socket foundation
  needed for clients must pass the relevant lock/auth/recovery gate now.
- Session, permission, tool, provider, context, artifact, and event semantics are
  versioned and no longer moving with every CLI change.
- The editor prototype operates only on generated disposable workspaces and a
  development Robin service until the protocol security gate passes.

### 16.3 Packages, files, interfaces, and protocol state

Add `packages/robin-application/src/client-protocol` modules:

- `version.ts`: protocol major/minor, capability negotiation, deprecation, and
  minimum/maximum support;
- `frame.ts`: bounded local frame and JSON-RPC 2.0 envelope parser;
- `methods.ts`: closed request/response/error schemas;
- `notifications.ts`: versioned application event notifications and cursors;
- `idempotency.ts`: caller/method/key/hash/result retention;
- `artifact-transfer.ts`: authorized metadata plus bounded chunks and final hash;
- `authentication.ts`: socket/peer/install-session identity and nonce renewal;
- `backpressure.ts`: bounded per-client queue and resync behavior;
- `client.ts` and `server.ts`: transport-independent state machines;
- protocol fixtures, compatibility, fuzz, auth, reconnect, and slow-client tests.

Expand `apps/daemon` with the stable server composition and `apps/cli` with a
client adapter. Keep an in-process application adapter for unit tests and a
documented emergency foreground mode; both invoke the same public application
use cases.

Create an R11-only prototype under `apps/vscode` with no marketplace package:

- extension activation and Robin-service discovery;
- session tree and event timeline;
- start/attach/resume/cancel commands;
- selected-text/file attachment;
- approval prompt prototype;
- virtual diff preview;
- reconnect from cursor;
- development-only telemetry disabled.

### 16.4 Stable protocol methods

The initial stable surface is intentionally application-level:

```text
system.hello
system.capabilities
system.doctor
session.create
session.list
session.inspect
session.resume
session.branch
session.rename
session.archive
session.subscribe
session.unsubscribe
session.submitMessage
session.cancelTurn
session.close
permission.resolve
context.inspect
workspace.status
workspace.diff
artifact.stat
artifact.readChunk
model.list
model.select
```

The protocol does not expose raw provider requests, secret resolution, direct
filesystem paths outside typed workspace resources, arbitrary command execution,
policy bypass, unmediated tool dispatch, or database queries. Advanced admin
commands can remain CLI-local until a real client need and security review exist.

Every mutating request includes client ID, request ID, idempotency key, canonical
request hash, expected session sequence, and optional preconditions. Results and
domain errors are stable schemas. Reusing a key with a different hash fails.

### 16.5 Authentication, framing, and subscriptions

Transport is an owner-only Unix-domain socket on macOS/Linux. Server startup
validates parent path, type, owner, mode, no symlink, installation lock, and old
socket liveness. Peer credentials are checked where available; the client also
proves a short-lived installation-session nonce obtained from an owner-private
file/handshake. Nonces rotate and are never sent to tools, extensions, provider,
logs, or workspaces. TCP/WebSocket is not enabled.

Each frame has a fixed bounded length prefix and one UTF-8 JSON-RPC object. The
parser rejects huge lengths, invalid encoding, duplicate JSON keys, batches,
unknown required fields, excessive nesting/items, and responses to unknown IDs.
Notification sequence comes from committed application events, not socket order
alone.

Subscribe supplies session ID and last committed cursor. The server replays
committed events, then live events after a barrier that prevents gaps. Per-client
queues have count/byte limits. A slow client receives `resync_required` with the
last durable cursor and reconnects; the server never drops semantic events while
pretending continuity.

Artifacts transfer by typed authorized reference, declared total bytes/media/
hash, monotonically increasing byte cursor, per-chunk cap, cancellation, and final
hash verification. A raw file path or CAS hash is not enough to read an artifact.

### 16.6 CLI conversion and compatibility

Interactive and headless CLI renderers consume the same event schemas whether
the application is in-process or remote. Enforcement remains in the service.
The CLI never locally approves then asks the service to trust an unbound boolean;
it sends the selected approval response to `permission.resolve`, and the service
revalidates/consumes the grant.

Protocol major versions are incompatible; minor versions add optional negotiated
capabilities and fields. The hello handshake selects an overlap or returns an
upgrade message before session mutation. Server supports the prior released
minor window defined in the compatibility table. Golden fixtures from every
supported client/server pairing run in CI.

### 16.7 Editor prototype and decision metrics

The prototype tests whether a VS Code extension can provide:

- repository/session selection and status;
- chat input and streamed observable events;
- selected file/range attachments with exact workspace identity;
- native read-only diff and accepted-edit workflow;
- approval review with full normalized scope and no truncated hidden content;
- model/permission/context state;
- reconnect, background session, and terminal-independent continuation;
- keyboard accessibility and high-contrast behavior;
- safe installation/service discovery without credential duplication.

Measure activation time, event-to-render latency, diff size limits, approval
completeness, reconnect success, extension memory, service CPU, selected-context
correctness, workspace trust behavior, remote/SSH/container editor behavior, and
API limitations. Record each limitation with a reproducible test and whether it
is essential, inconvenient, or cosmetic.

### 16.8 Extension versus Code-OSS decision rule

The default decision is a normal extension. A Code-OSS fork proceeds only if all
of these are true:

1. at least two essential Robin workflows cannot be implemented safely through
   supported extension APIs, and each limitation has a minimal reproducible case;
2. no client-protocol, native diff, custom editor, terminal, language-server,
   virtual document, webview, or upstream extension proposal solves them;
3. the benefit is user-visible and central, not branding or tighter packaging;
4. the project can maintain upstream security updates, extension compatibility,
   licensing/notices, binary signing/notarization, update service, crash reporting,
   platform builds, and release cadence;
5. threat review shows the fork does not move secrets or enforcement into a
   larger less-testable renderer process;
6. a written ADR compares extension, upstream contribution, companion process,
   and fork total cost with measured evidence.

If any condition fails, R11 chooses the extension and closes fork work. The
decision can be revisited after shipped-user evidence, not by adding speculative
fork scaffolding.

### 16.9 Implementation tickets and sequence

1. **R11.01 — Freeze protocol threat model.** Enumerate clients, assets, socket/
   peer attacks, request replay, frame bombs, artifact confusion, cursor gaps,
   stale approvals, and version downgrade.
2. **R11.02 — Freeze hello/method/error schemas.** Add protocol/version/capability
   negotiation, closed schemas, canonical hashes, and compatibility fixtures.
3. **R11.03 — Implement frame parser.** Add length/UTF-8/JSON/depth/item limits,
   duplicate-key rejection, fragmentation/coalescing, cancellation, and fuzzing.
4. **R11.04 — Implement local authentication.** Verify path/owner/mode/symlink,
   peer identity, installation lock, short-lived nonce, rotation, stale socket,
   and no secret propagation.
5. **R11.05 — Implement server dispatch.** Route only application use cases,
   enforce method capability/version, idempotency, expected sequence, errors, and
   cancellation.
6. **R11.06 — Implement subscriptions.** Barriered replay/live transition,
   cursors, reconnect, bounded queues, resync marker, multi-client, and daemon
   restart.
7. **R11.07 — Implement artifact chunks.** Typed authorization, stat/chunk/final
   hash, byte cursors, media/size limits, cancellation, and reference revocation.
8. **R11.08 — Convert CLI adapter.** Run every interactive/headless/approval/
   session flow in both in-process and service mode and require semantic event/
   exit equivalence.
9. **R11.09 — Add protocol compatibility matrix.** Previous/current client/server
   minors, unknown major, missing capability, downgrade attempt, old fixtures,
   and deprecation messages.
10. **R11.10 — Build VS Code prototype.** Implement the measured session/chat/
    selection/diff/approval/reconnect surfaces without provider/tool duplication.
11. **R11.11 — Add editor integration tests.** Use VS Code extension test host,
    generated workspaces, fake service, real local service, restart, multi-root,
    remote-context simulation, accessibility, and malicious event text.
12. **R11.12 — Run measurements.** Capture capability, performance, UX, security,
    distribution, and maintenance findings with reproducible cases.
13. **R11.13 — Decide and record ADR.** Choose extension, upstream contribution,
    or evidence-qualified fork; list accepted limitations and R12 scope.
14. **R11.14 — Publish protocol docs.** Document local-only trust, methods/events/
    errors/cursors/idempotency/artifacts/versioning, client test kit, and no raw
    secret/tool access.

### 16.10 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| frames | one-byte fragments, multiple frames, huge/negative/overflow length, invalid UTF-8/JSON, duplicate keys, depth/items, batch, unknown response ID, fuzz seeds. |
| auth | wrong owner/mode/type, symlink, peer mismatch, stolen/stale/rotated nonce, socket replacement, dual daemon, no credential leakage. |
| requests | every method success/error, invalid params, expected-sequence drift, idempotency replay/hash mismatch, cancel, unknown capability/version. |
| subscriptions | initial replay, concurrent commit barrier, reconnect cursor, slow client/resync, two clients, daemon restart, archived/deleted session. |
| artifacts | unauthorized/stale ref, chunk order/range, changed total/hash, huge media, cancellation, concurrent clients, deletion/retention. |
| CLI parity | interactive, print text/JSON/JSONL, approval, cancel, resume, provider/tool errors, exit codes, terminal restore in in-process and service modes. |
| editor prototype | activation, multi-root/workspace trust, selection ranges, diff, approval scope, event control bytes, reconnect/background, accessibility, no secret storage. |

### 16.11 Failure and security cases

- A client cannot invoke a tool directly, resolve a secret, bypass permission, or
  supply a pre-approved grant object.
- Socket filesystem permissions are necessary but not the sole check when peer
  identity is available. TCP fallback is forbidden.
- Request replay with the same key/hash returns the recorded result; same key and
  different hash fails without effect.
- An editor closing or crashing does not cancel a durable run unless it sent an
  authenticated cancel request.
- Slow or malicious clients cannot exhaust daemon memory or create cursor gaps
  that look complete.
- Artifact paths/hashes are not capabilities; session/view authorization is
  rechecked for every chunk.
- The extension stores no provider/Git/MCP credential and contains no permission
  evaluator or tool executor.
- Workspace/editor remote contexts do not silently connect to a different Robin
  service or map selected paths across workspace identities.

### 16.12 Migration, documentation, and installation work

R11 introduces stable local protocol version 1 and client capability fixtures.
The provisional R9 protocol is not negotiated as stable; daemon and CLI are
upgraded together through a migration that preserves session state and rejects
old active clients before mutation. No session event is rewritten solely for
transport.

Install channels add service binary/entrypoint only when the stable server gate
passes. `doctor` checks server/client build/protocol/capabilities/socket identity.
Uninstall stops the exact service but preserves sessions. The prototype remains a
development package and is not listed in the marketplace.

### 16.13 Acceptance evidence

R11 is accepted only when:

- stable protocol methods, schemas, errors, authentication, idempotency, cursors,
  backpressure, artifacts, and compatibility fixtures pass security/fuzz tests;
- CLI behavior is semantically equivalent in direct and service modes;
- two clients observe one session, one can approve, reconnect resumes at the exact
  cursor, and closing either client does not corrupt/cancel the run;
- the editor prototype demonstrates session/chat/selection/diff/approval/reconnect
  without a second agent/tool/permission implementation;
- measured extension limitations and total-maintenance evidence produce an
  accepted ADR under section 16.8;
- no public editor or fork claim is made before R12.

### 16.14 Explicit deferrals

R11 defers public marketplace/editor distribution, full editor polish, web/mobile
clients, TCP/remote service, public SDK stability beyond the local protocol,
collaborative sessions, and any Code-OSS implementation not authorized by the
decision gate.

### 16.15 Requirements traced

R11 advances the post-1.0 editor gate in product requirements section 12.9,
completes the client-facing extension of `FR-AUTO-008`, and adds evidence for
`FR-CLI-011–012`, `FR-SES-001–010`, `FR-PERM-006–009`,
`FR-OPS-001–010`, `NFR-SEC-001–006`, `NFR-REL-001–005`,
`NFR-PERF-002–005`, `NFR-A11Y-001–004`, and `NFR-MAINT-001`.

## 17. R12 — Selected Editor Client and Evidence-Gated Fork Decision

**Status:** planned after R11 selects a client strategy.

**Effort range:** 6–10 part-time weeks for a production VS Code extension. A
Code-OSS fork, if separately authorized by evidence, is a multi-quarter product
and receives a new plan rather than being hidden inside this range.

### 17.1 Why R12 exists

R12 brings Robin's proven engine into the editor without weakening its terminal
product. The expected path is a VS Code extension. A fork is a later explicit
decision only if R11 proves supported extension APIs cannot satisfy essential
workflows.

### 17.2 Prerequisites

- R11 is accepted with a stable local protocol and an ADR selecting the client.
- Robin 1.0 remains installable and fully useful without an editor.
- The chosen editor's extension API/version, marketplace rules, workspace trust,
  remote development model, webview security, update/signing process, and test
  host are pinned in a client support matrix.

### 17.3 Production extension boundaries

For the expected extension path, `apps/vscode` contains:

```text
src/extension.ts                 # activation/deactivation only
src/service-discovery.ts         # exact local Robin service identity
src/protocol-client.ts           # generated schemas/client, no domain reimplementation
src/session-tree.ts              # sessions and state
src/chat-view.ts                 # input and normalized event rendering
src/selected-context.ts          # explicit file/range attachments
src/diff-content-provider.ts     # immutable before/after virtual documents
src/approval-controller.ts       # render response choices, server decides
src/status-bar.ts                # repo/model/mode/session facts
src/commands.ts                  # editor intents mapped to protocol methods
src/settings.ts                  # non-secret client preferences
src/workspace-trust.ts           # editor plus Robin trust coordination
src/accessibility.ts             # labels, focus, announcements, reduced motion
src/redaction.ts                 # defense-in-depth display sanitization
media/                           # local CSP-hashed assets only
test/                            # extension-host and protocol integration
```

The extension does not contain provider SDKs, credentials, repository mutation,
process spawn for tools, Git writes, policy engine, approval consumption, session
store, or agent loop. It may launch/discover the signed local Robin service under
an exact install policy, then communicates through R11.

### 17.4 Editor user flows

The production client implements:

1. activate lazily on a Robin command/view, not every editor startup;
2. discover exact service executable/protocol and show install/start remediation;
3. bind editor workspace folders to Robin physical workspace identities;
4. start, list, attach, continue, resume, branch, rename, archive, cancel, and
   close sessions;
5. submit chat text and explicit file/range/diagnostic/terminal-output attachments
   with source hashes and bounded content;
6. stream assistant and observable tool events with accessible status;
7. show tool approval scope, full diff/command/resource, policy rationale,
   sandbox/network, preconditions, expiry, and once/session/persistent choices;
8. open native immutable before/after diffs from authorized artifact chunks;
9. refresh Git/editor views after server-confirmed mutations without pretending
   editor buffers equal disk;
10. inspect context, usage/cost, model/provider, permission mode, changed files,
    verification, and recovery state;
11. reconnect from cursor after extension reload/editor restart;
12. leave background runs alive when the window closes and show explicit detach
    versus cancel.

Unsaved editor buffers are explicit attachments with editor document version and
hash; they are not silently written or confused with disk preimages. Robin tools
operate on disk unless a future buffer-edit protocol is separately designed. An
edit that conflicts with an unsaved buffer is shown and not auto-applied.

### 17.5 Diff, approval, and selected-context correctness

Selected context includes workspace identity, canonical relative path, document
URI scheme, editor version, selection ranges, language ID, bytes/hash, dirty
state, and trust. Unsupported/virtual/remote URIs require an adapter or are
rejected. Content passes context classification and budget before provider egress.

Diff virtual documents use immutable artifact references from one approval/edit
plan. The extension verifies total/chunk/final hashes and labels truncation. The
approval controller cannot reconstruct a smaller scope from display text; it
renders the server's signed/hash-bound summary and returns only the chosen response
plus request identity. If it cannot display required content, it disables allow.

After a disk edit, the extension asks the editor to refresh and compares document
version/disk state. It never calls save-all, discard, revert, or overwrite without
an explicit user action outside Robin's implicit flow.

### 17.6 Webview and extension-host security

Use native tree, diff, quick-pick, status, and notification APIs where practical.
Any chat webview has a restrictive CSP with per-render nonce, local extension
assets only, no remote scripts/styles/images by default, no `eval`, sanitized text
rendering, bounded message schema, and explicit allowed commands. Provider/tool
Markdown does not allow raw HTML/script, command URIs, arbitrary resource URIs,
or automatic external link navigation.

Extension settings contain only client presentation/service discovery. Secrets
stay in Robin's credential store. Logs use editor output channels with redacted
safe events and no raw prompts/code by default. Workspace-controlled extension
settings cannot select another service binary, socket, credential, or bypass
mode without trusted user confirmation.

### 17.7 Extension testing and distribution

Tests cover pure view reducers, protocol client fixtures, extension host, real
local service, generated repositories, multi-root, trusted/untrusted workspace,
unsaved buffers, large diffs, malicious Markdown/control text, approval failure,
service restart/upgrade, editor reload, remote-context behavior, accessibility,
and performance.

Build pins dependencies, bundles only expected assets, creates an allowlisted VSIX,
generates SBOM/checksum, scans secrets/licenses/vulnerabilities, signs/publishes
through protected marketplace credentials, downloads the published VSIX, and
runs smoke against supported editor versions. Marketplace release states required
Robin CLI/service versions and protocol compatibility.

### 17.8 Code-OSS fork branch, only if R11 authorized it

If R11 satisfies every fork condition, stop before coding and create a separate
ADR and exhaustive fork plan covering:

- upstream repository/version and trademark/licensing policy;
- automated upstream security merge cadence and maximum patch latency;
- extension marketplace compatibility and proprietary-service exclusions;
- platform build farm, native dependencies, signing/notarization, installers,
  auto-update, rollback, crash reporting, privacy, SBOM, and reproducibility;
- renderer/main/extension-host/service trust boundaries and IPC;
- Robin UI integration without moving enforcement or credentials into renderer;
- migration between standard Robin extension and fork;
- staffing/maintenance budget and an exit strategy back to upstream extension.

No fork source, branding, updater, or binary distribution begins until that plan
is approved. If R11 chooses an extension, these tasks remain prohibited scope.

### 17.9 Implementation tickets and sequence

1. **R12.01 — Freeze extension UX and threat model.** Map every flow, protocol
   method/event, trust boundary, unsaved-buffer state, webview input, and failure.
2. **R12.02 — Generate protocol client.** Build validators/types from R11 schemas,
   add version negotiation/auth/reconnect/backpressure, and forbid hand-copied
   divergent domain types.
3. **R12.03 — Implement lazy service discovery.** Resolve configured/default
   signed binary, protocol/build, socket identity, start policy, upgrade message,
   and no workspace-controlled executable override.
4. **R12.04 — Implement session tree/commands.** Add all lifecycle actions,
   background state, pending approvals, recovery, exact workspace mapping, and
   multi-root tests.
5. **R12.05 — Implement chat/event view.** Stream safe observable events, input,
   queued prompts, cancellation, usage, context, no hidden reasoning, control/
   Markdown sanitization, and accessibility.
6. **R12.06 — Implement selected context.** Bind physical workspace/document
   version/ranges/hash/dirty/URI, apply budgets/classification, and handle virtual/
   remote/unsupported sources.
7. **R12.07 — Implement immutable diff provider.** Fetch authorized chunks,
   verify hashes, label truncation, open native diffs, expire references, and
   handle service/session deletion.
8. **R12.08 — Implement approval controller.** Render complete server summary,
   expand diff/command/resource, disable on incomplete display, return exact
   response, and test stale/replayed/changed approvals.
9. **R12.09 — Coordinate editor buffers/Git refresh.** Detect unsaved conflict,
   avoid implicit save/revert, refresh after confirmed writes, and label disk
   versus buffer truth.
10. **R12.10 — Harden webview/extension.** CSP, local assets, message schemas,
    Markdown links, command/URI denial, output redaction, settings trust, resource
    limits, and dependency scan.
11. **R12.11 — Add accessibility/performance.** Keyboard/focus/screen-reader/
    high-contrast/reduced-motion flows, event render percentile, activation/memory,
    large transcript/diff, and backpressure.
12. **R12.12 — Build test matrix.** Unit, protocol, extension host, real service,
    editor versions, macOS/Linux, multi-root, remote simulation, restart/upgrade,
    malicious content, and end-to-end repository workflow.
13. **R12.13 — Package and publish VSIX.** Allowlist, SBOM/checksum/signature,
    protected marketplace release, independent download/smoke, compatibility
    metadata, update/rollback/uninstall.
14. **R12.14 — Document editor use.** Install/service discovery, workspace trust,
    context/unsaved buffers, diffs/approvals, background/reconnect, settings,
    privacy, troubleshooting, uninstall, and CLI equivalence.
15. **R12.15 — Re-evaluate fork evidence after shipped use.** Record user metrics
    and extension API limitations; open a fork plan only if every R11 condition is
    newly or still satisfied.

### 17.10 TDD and verification suites

| Suite | Required cases |
| --- | --- |
| protocol client | all schemas/errors, old/new versions, auth, reconnect/cursor, slow view, malformed/malicious server frame, artifact hash. |
| workspace/context | single/multi-root, physical mismatch, symlink, trusted/untrusted, saved/dirty/untitled/virtual/remote documents, selection version drift, budget/secret. |
| chat/events | text/tool/approval/process/diff/usage/recovery, queue/cancel, huge stream, control/Markdown/URI injection, no-color/high contrast. |
| approval/diff | complete/incomplete summary, chunk truncation/hash, stale/expired/replayed request, editor reload, artifact deletion, changed disk/buffer. |
| lifecycle | no service, wrong service/protocol, start/stop, editor reload/window close, background detach, daemon upgrade/restart, session archive/delete. |
| security | workspace setting binary/socket spoof, webview CSP/message forgery, command URI, remote asset, credential/log canary, extension dependency/package inventory. |
| accessibility/performance | all-keyboard, focus order, screen-reader announcements, reduced motion, activation, p95 event render, large transcript/diff, memory. |
| E2E | start in generated repo, attach context, provider turn, read/edit/approve/test/diff, unsaved conflict, resume after editor restart, final Git review. |

### 17.11 Failure and security cases

- A compromised or malicious workspace cannot choose a Robin executable/socket,
  provider credential, permission bypass, MCP server, or extension update.
- Selected text and virtual documents do not enter provider context until Robin's
  service validates identity, trust, classification, and budget.
- Provider/model/tool output cannot emit executable webview HTML, command URIs,
  terminal controls, or automatic external requests.
- The extension cannot approve when summary/diff/artifact is incomplete, changed,
  stale, or unverified.
- Editor buffers are not silently saved/discarded/overwritten. Disk/buffer drift
  blocks ambiguous edits.
- Closing/reloading the editor does not terminate background work unless the user
  chose cancel.
- Marketplace credentials and signing keys are unavailable to pull-request code;
  the published VSIX is independently downloaded and verified.
- A fork is not justified by branding, desire for fewer processes, or speculative
  UX; only the measured R11 gate authorizes its separate plan.

### 17.12 Migration, documentation, and installation work

The extension stores only non-secret client settings and safe UI caches with
versioned schemas. Session truth stays in Robin. Extension upgrade tests migrate
client settings, negotiate service versions, and can roll back within the support
window without modifying session logs. Uninstall removes the extension and its
safe caches but does not uninstall Robin or delete sessions/credentials.

CLI/service install docs remain primary. Editor docs state the minimum compatible
Robin version and how to use the CLI when the extension is unavailable. A Code-
OSS migration section is written only if a fork plan is accepted.

### 17.13 Acceptance evidence

R12 is accepted only when:

- the shipped editor client uses the stable protocol and contains no provider,
  tool, permission, credential, or session-engine duplicate;
- the full flagship workflow, selected context, immutable diff, complete approval,
  unsaved-buffer conflict, reconnect, and background detach pass end to end;
- workspace trust, malicious content/webview, service spoof, credential canary,
  accessibility, performance, package, update/rollback, and uninstall suites pass;
- CLI behavior and capability remain complete without the extension;
- the published VSIX downloaded from its channel passes compatibility smoke;
- docs and marketplace claims name exact supported editor/Robin versions and
  residual limits;
- no Code-OSS work starts unless the R11 evidence gate and separate fork plan are
  accepted.

### 17.14 Explicit deferrals

R12 defers web/mobile clients, collaborative multi-user editing, cloud-hosted
session service, remote TCP protocol, editor marketplace ecosystems beyond the
selected client, and a Code-OSS fork unless separately evidence-approved.

### 17.15 Requirements traced

R12 completes product requirements section 12.9 and provides an additional
client for `FR-UI-003–012`, `FR-SES-001–010`, `FR-CTX-005–010`,
`FR-PERM-006–009`, `FR-GIT-001–010`, and `FR-OPS-001–010` without changing
their engine ownership. It carries `NFR-SEC-001–006`, `NFR-REL-004`,
`NFR-PERF-002`, `NFR-PRIV-001–004`, `NFR-A11Y-001–004`, and
`NFR-MAINT-001` into the editor surface.

## 18. Consolidated Ticket Backlog and Dependency Graph

### 18.1 Backlog accounting

The phase sections define 230 implementation tickets:

| Phase | Ticket range | Count | Current status |
| --- | --- | ---: | --- |
| R0 | R0.01–R0.12 | 12 | accepted on `main` at `2c042ca` |
| R1 | R1.01–R1.13 | 13 | accepted on `main` at `fb64cf1`; reviewed and merge-triggered nine-job gates green |
| R2 | R2.01–R2.17 | 17 | implementation in progress; R2.01–R2.14 focused-tested, R2.15–R2.17 and aggregate acceptance open |
| R3 | R3.01–R3.18 | 18 | planned |
| R4 | R4.01–R4.17 | 17 | planned |
| R5 | R5.01–R5.17 | 17 | planned |
| R6 | R6.01–R6.17 | 17 | planned |
| R7 | R7.01–R7.20 | 20 | planned |
| R8 | R8.01–R8.21 | 21 | planned |
| R9 | R9.01–R9.24 | 24 | planned exclusively after 1.0 |
| R10 | R10.01–R10.25 | 25 | planned |
| R11 | R11.01–R11.14 | 14 | planned after 1.0 |
| R12 | R12.01–R12.15 | 15 | planned after R11 decision |

The ticket description in its phase is the authoritative output. The dependency
edges below are additional constraints. A ticket may start early to add failing
tests or research, but implementation cannot merge as accepted until every named
predecessor and applicable prior phase gate is green.

### 18.2 Phase-level dependency graph

```text
Accepted Milestones A/B
  -> R0 identity
  -> R1 interactive synthetic loop
  -> R2 real repository coding slice
  -> R3 durable sessions/context
  -> R4 first real provider/BYOK
  -> R5 permissions/sandbox
  -> R6 daily Git workflow
  -> R7 provider breadth/headless beta
  -> R8 configuration/extensions
  -> R10 Robin 1.0 release gate
  -> R11 stable client protocol/editor decision
  -> R12 selected editor client

R10 -> R9 post-1.0 subagents/worktrees/background
R9 -> R11 when the stable client protocol uses the background daemon
```

R10 accepts 1.0 only with R9 absent from public runtime composition, ordinary
help, packages, migrations, and claims. R9 implementation begins from the
accepted R10 baseline; an unsupported pre-1.0 feature flag is not an exception.

### 18.3 R0 dependency edges

- R0.01 precedes every pivot mutation so the accepted baseline is reproducible.
- R0.02 depends on R0.01 and precedes any old draft-PR closure or branch deletion.
- R0.03 depends on R0.01; it may run in parallel with R0.02 after commit identity
  is recorded.
- R0.04 depends on R0.03 so package repository metadata uses the final remote.
- R0.05 depends on ADR-0007 and may run with R0.04.
- R0.06 depends on R0.05's pure parse result.
- R0.07 depends on R0.03–R0.05 and preserves the historical allowlist.
- R0.08 depends on R0.07 so the scan encodes final intentional exceptions.
- R0.09 depends on R0.04 and R0.06–R0.07.
- R0.10 depends on ADR-0007 and feeds R0.08's normative-file scan.
- R0.11 depends on R0.04–R0.10.
- R0.12 depends on R0.02–R0.03 and accepted R0.11 evidence.

Parallel lane: remote/WIP preservation (R0.02–R0.03), CLI/package identity
(R0.04–R0.06/R0.09), and docs/checks (R0.07–R0.08/R0.10) converge at R0.11.

### 18.4 R1 dependency edges

- R1.01 precedes every producer/consumer of application events.
- R1.02 depends on R1.01 and precedes coordinator I/O.
- R1.03 depends on normalized provider events from R1.01 and may run with R1.02.
- R1.04 depends on R1.03's collection contract.
- R1.05 depends on R1.02–R1.04 and accepted gateway schemas.
- R1.06 depends on R1.02 and R1.05.
- R1.07 is independent after R0 and precedes raw-mode selection.
- R1.08 depends on terminal capability byte assumptions from R1.07.
- R1.09 depends on R1.01 and R1.07–R1.08.
- R1.10 depends on R1.06 and R1.09.
- R1.11 depends on R1.07–R1.10.
- R1.12 depends on R1.04–R1.06 and R1.09–R1.11.
- R1.13 depends on executable R1.12 evidence and documented terminal matrix.

Parallel lane: loop (R1.01–R1.06) and terminal (R1.07–R1.09) converge at R1.10.

### 18.5 R2 dependency edges

- R2.01 precedes every physical workspace/Git/process integration case.
- R2.02 depends on R2.01 and creates the trusted workspace handle.
- R2.03 depends on R2.02 and precedes every filesystem effect/read.
- R2.04–R2.06 depend on R2.03; listing, search, and read can develop in parallel
  against the same conformance fixtures.
- R2.07 depends on R2.03 and existing schema validation.
- R2.08 depends on R2.06–R2.07 because it needs real preimage classification.
- R2.09 depends on R2.08 and initial status from R2.02.
- R2.10 depends on R2.02–R2.03 and may run in parallel with edit work.
- R2.11 depends on R2.04/R2.06 and feeds R2.10 normalized requests.
- R2.12 depends on R2.01–R2.02 and can run alongside file/edit/process lanes.
- R2.13 depends on R2.04–R2.12.
- R2.14 depends on registered tools from R2.13.
- R2.15 depends on R2.13–R2.14 and R1 terminal approval events.
- R2.16 starts with R2.01 but cannot accept until R2.15 exercises all effects.
- R2.17 depends on R2.14–R2.16 evidence.

Parallel lanes: workspace reads (R2.02–R2.06), edits (R2.07–R2.09), processes
(R2.10–R2.11), and Git reads (R2.12) converge at R2.13.

### 18.6 R3 dependency edges

- R3.01 precedes every durable byte writer/parser.
- R3.02 depends on event schemas in R3.01 and may run before filesystem I/O.
- R3.03 precedes all real state-root writes.
- R3.04 depends on R3.01 and fault-filesystem test seams.
- R3.05 depends on R3.03–R3.04.
- R3.06 depends on R3.03 and precedes multi-process append tests.
- R3.07 depends on R3.03 and may run with log/lock work.
- R3.08 depends on R3.02 and R3.04–R3.07.
- R3.09 spans R3.04–R3.08 and must add failures before each implementation edge.
- R3.10 depends on R3.02/R3.05–R3.08 and R2 effect facts.
- R3.11 depends on R3.06/R3.08/R3.10.
- R3.12 depends on R3.02 and R3.07 for manifests/artifacts.
- R3.13 depends on R3.12 and durable append R3.05/R3.10.
- R3.14 depends on R3.02/R3.06–R3.13 and workspace drift from R2.
- R3.15 depends on R3.11–R3.14.
- R3.16 depends on R3.09/R3.10/R3.14–R3.15.
- R3.17 depends on all data/recovery behavior through R3.16.
- R3.18 depends on R3.16–R3.17 and all R3 package gates.

Parallel lanes: durable bytes/locks/CAS (R3.01–R3.09) and pure prompt/replay
(R3.02/R3.12–R3.13) converge at application persistence R3.10/R3.14.

### 18.7 R4 dependency edges

- R4.01 precedes provider adapter and persisted provider records.
- R4.02 depends on R4.01 and precedes adapter acceptance.
- R4.03 precedes any official SDK import.
- R4.04–R4.06 depend on R4.01–R4.03 and may develop as encoder/decoder/error lanes.
- R4.07 depends on R4.01 and feeds R4.04 capability validation.
- R4.08 may develop after R3 config state and precedes wizard integration.
- R4.09–R4.10 depend on the credential port and may develop in parallel.
- R4.11 depends on R4.07–R4.10.
- R4.12 depends on R4.04–R4.07, R4.09–R4.10, and R3 barriers.
- R4.13 depends on R4.08/R4.11–R4.12.
- R4.14 begins with R4.09 and gates every later credential/provider ticket.
- R4.15 depends on R4.04–R4.06 and the canary sanitizer in R4.14.
- R4.16 depends on R4.02/R4.12–R4.15 and protected credentials.
- R4.17 depends on conformance/live evidence and canary results.

### 18.8 R5 dependency edges

- R5.01 precedes modes, policies, approvals, and tool observation.
- R5.02–R5.03 depend on R5.01 and can develop together.
- R5.04 depends on R5.01/R5.03 and durable barriers.
- R5.05 depends on R5.04 and terminal UI.
- R5.06 depends on R5.03–R5.05 and config atomic writes.
- R5.07 depends on R5.01/R5.03–R5.04 and existing tools.
- R5.08 precedes every concrete sandbox backend.
- R5.09–R5.11 depend on R5.08 and run as independent backend lanes.
- R5.12 depends on R5.07–R5.11 and process control.
- R5.13 depends on R5.07/R5.12.
- R5.14 depends on R5.04–R5.07/R5.12 and gates all effect acceptance.
- R5.15 depends on each backend ticket and R5.12–R5.13.
- R5.16 depends on R5.02–R5.07 and R7 later finalizes public machine schemas.
- R5.17 depends on R5.14–R5.16 measured support.

Parallel lanes: permission/pipeline (R5.01–R5.07/R5.14) and sandbox backends
(R5.08–R5.13/R5.15) converge at acceptance and docs.

### 18.9 R6 dependency edges

- R6.01 precedes batch/checkpoint durable behavior.
- R6.02 depends on R6.01.
- R6.03 depends on R6.02 and R2 atomic file primitives.
- R6.04 depends on R6.02–R6.03.
- R6.05 depends on R6.01/R6.04 and CAS retention.
- R6.06 depends on R6.05.
- R6.07 precedes every Git mutation plan.
- R6.08 depends on R6.07 and edit attribution.
- R6.09 depends on R6.07–R6.08.
- R6.10 depends on safe R6.09 and remains experimental unless independently gated.
- R6.11 depends on R6.07 and permission approvals.
- R6.12 depends on R6.07/R6.09/R6.11 and credential separation.
- R6.13 depends on R6.09/R6.11–R6.12.
- R6.14 depends on R6.05–R6.13.
- R6.15 spans and gates R6.07–R6.13.
- R6.16 depends on R6.04–R6.15.
- R6.17 depends on R6.16 evidence.

Parallel lanes: edit/checkpoint (R6.01–R6.06) and Git state/local writes
(R6.07–R6.11) converge for remote/summary/E2E work.

### 18.10 R7 dependency edges

- R7.01 precedes every new provider and compatibility claim.
- R7.02–R7.03 depend on R7.01; R7.04 depends on both.
- R7.05 precedes compatible transport/origin/local work.
- R7.06–R7.07 depend on R7.05 and run together; R7.08 depends on both.
- R7.09 depends on R7.01/R7.04/R7.06–R7.08.
- R7.10 depends on R7.09 and R3 context/resume.
- R7.11 depends on R7.09–R7.10 and permission/egress policy.
- R7.12 precedes persistent rotation/removal R7.13.
- R7.14 precedes public print/machine behavior.
- R7.15–R7.17 depend on R7.14; structured output also depends on R7.09.
- R7.18 depends on R7.04/R7.08–R7.13 and loop/tool gates.
- R7.19 depends on R7.14–R7.17.
- R7.20 depends on R7.18–R7.19 generated evidence.

Parallel lanes: Anthropic, compatible/local, credentials, and machine-output work
converge at cross-adapter E2E and generated compatibility docs.

### 18.11 R8 dependency edges

- R8.01 precedes all config/trust/extension settings.
- R8.02–R8.03 depend on R8.01.
- R8.04 depends on R8.01–R8.03.
- R8.05–R8.07 depend on R8.04 and can develop as instruction lanes.
- R8.08 depends on R8.01/R8.04 and precedes every extension type.
- R8.09 depends on R8.05/R8.08.
- R8.10 precedes hook scheduler/administration R8.11–R8.12.
- R8.13 precedes MCP lifecycle R8.14, mapping R8.15, permissions R8.16, and
  administration R8.17.
- R8.11 and R8.14 depend on sandbox/process isolation.
- R8.16 depends on R8.15 plus the permission/tool pipeline.
- R8.18 spans R8.09/R8.11/R8.14–R8.17 and gates them.
- R8.19 depends on durable records from every extension lane.
- R8.20 depends on R8.05–R8.19.
- R8.21 depends on conformance and E2E evidence.

Parallel lanes: config/trust/instructions, skills, hooks, and MCP converge at
leak/escape, resume, and E2E gates.

### 18.12 R9 dependency edges

- R9.01 precedes delegation/scheduler/session records.
- R9.02–R9.03 depend on R9.01.
- R9.04 depends on R9.02–R9.03.
- R9.05 precedes all new worktree implementation.
- R9.06 depends on R9.05; R9.07 depends on R9.02/R9.06 and sandboxing.
- R9.08 depends on R9.06–R9.07 and R6 import mechanics.
- R9.09 depends on R9.06–R9.08.
- R9.10 precedes daemon ownership/recovery.
- R9.11 depends on R9.03/R9.10 and existing application composition.
- R9.12 depends on R9.10–R9.11.
- R9.13–R9.14 depend on R9.12 and durable subscriptions/approvals.
- R9.15 depends on R9.04/R9.08–R9.14.
- R9.16 spans and gates R9.10–R9.15.
- R9.17 depends on all child/worktree/daemon paths through R9.16.
- R9.18 begins with schema design and gates R9.17 resource correctness.
- R9.19 depends on stable daemon operations through R9.18.
- R9.20 depends on full evidence and support decisions.
- R9.21 depends on the existing agent-driver contract and R7 provider/tool
  semantics; it precedes both external adapters.
- R9.22 depends on R9.21 and the Robin tool/context/permission bridge.
- R9.23 depends on R9.05–R9.09/R9.21 and strict sandbox/process behavior.
- R9.24 depends on R9.22–R9.23 and generated conformance/eval evidence.

Parallel lanes: delegation/scheduler and worktrees converge at R9.17; durable
queue/daemon/socket work converges with them at recovery and E2E.

### 18.13 R10 dependency edges

- R10.01 precedes eval runner/graders/corpora.
- R10.02 depends on R10.01; R10.03–R10.04 depend on R10.02.
- R10.05 depends on R10.03–R10.04; R10.06 depends on executable corpus results.
- R10.07 precedes any uploaded support/eval/release artifact.
- R10.08–R10.10 depend on R10.07 and mature state/platform services.
- R10.11 precedes package CI/release/channel tests.
- R10.12 depends on existing phase commands and supports R10.13–R10.14.
- R10.13 depends on parsers/test seams from all prior phases.
- R10.14 depends on packaged representative flows and fixed machine provenance.
- R10.15 depends on R10.07/R10.11–R10.14.
- R10.16–R10.17 depend on R10.15 artifact/manifest integrity.
- R10.18 depends on every durable/config schema and packaged old candidates.
- R10.19 depends on R10.15–R10.18.
- R10.20 spans all product surfaces and precedes release candidate.
- R10.21 precedes final artifact publication.
- R10.22 depends on R10.05–R10.21.
- R10.23 can develop continuously but accepts only after R10.22 commands/claims.
- R10.24 depends on measured R10.06/R10.14/R10.22 evidence.
- R10.25 depends on R10.22–R10.24 and protected release approval.

Parallel lanes: evals, observability/operations, packaging/CI, and migrations/
clean-machine testing converge at threat closure and release candidate.

### 18.14 R11 dependency edges

- R11.01 precedes protocol code.
- R11.02 precedes frame/auth/server/client work.
- R11.03–R11.04 depend on R11.01–R11.02 and can run together.
- R11.05 depends on R11.03–R11.04.
- R11.06–R11.07 depend on R11.05.
- R11.08 depends on R11.05–R11.07.
- R11.09 depends on R11.02/R11.05–R11.08.
- R11.10 depends on a working protocol through R11.07.
- R11.11 depends on R11.08/R11.10.
- R11.12 depends on R11.11 and representative packaged builds.
- R11.13 depends on measured R11.12 evidence.
- R11.14 depends on stable schemas and accepted decision.

### 18.15 R12 dependency edges

- R12.01 and the R11 ADR precede production editor code.
- R12.02 depends on stable R11 schemas.
- R12.03–R12.04 depend on R12.02.
- R12.05 depends on R12.02/R12.04.
- R12.06 depends on R12.01/R12.04 and context contracts.
- R12.07–R12.08 depend on R12.02/R12.04 and artifact/approval protocol.
- R12.09 depends on R12.06–R12.08.
- R12.10 spans every renderer/settings/message surface through R12.09.
- R12.11 depends on functional views through R12.10.
- R12.12 depends on R12.03–R12.11.
- R12.13 depends on R12.12 and protected distribution credentials.
- R12.14 depends on public package behavior and compatibility evidence.
- R12.15 depends on shipped usage and never blocks the extension acceptance gate.

### 18.16 Critical-path and scope-cut rules

The shortest path to the hosted-provider alpha is R0 → R1 → R2 → R3 → R4. Do
not pull R8, R9, R11, or R12 work forward while that path is incomplete. The
path to the first supported developer bundle is R5 → R6 → R7 → R8, and the path
from that bundle to 1.0 is R10. R9 is forbidden before the accepted 1.0 baseline
and remains optional post-1.0 work.

If effort must be cut, remove in this order:

1. R12 editor delivery;
2. R11 editor prototype;
3. post-1.0 R9 subagents/background/worktrees;
4. native commit mode and live PR creation while preserving safe commit and local
   PR preparation;
5. optional macOS native sandbox where container enforcement remains supported
   and claims are narrowed;
6. provider presets beyond OpenAI, Anthropic, one generic subset, and one local
   no-key path;
7. remote MCP while preserving local stdio MCP.

Do not cut exact path/preimage checks, credential isolation, permission
revalidation, process-tree cancellation, durable resume/recovery, provider
conformance, machine-output schemas, migration tests, clean install/uninstall,
redaction, deterministic security evals, or truthful documentation.

## 19. Product Requirement Traceability Matrix

### 19.1 Traceability rules

Every row maps the normative IDs in `PRODUCT_REQUIREMENTS.md` to a terminal
owning gate, implementation boundary, ticket evidence, and automated proof. An ID
listed in an earlier phase's “requirements traced” section may be partially
implemented there; this matrix names the phase that must close the complete
requirement for the applicable release surface.

The `Terminal gate and tickets` cell has one mechanical interpretation; readers
must not infer closure from the first ticket listed:

1. Extract every `R<n>` phase number cited in the cell.
2. The **terminal gate is the highest numeric phase** cited. At least one ticket
   from that phase must close the complete normative requirement.
3. Every cited lower-numbered phase is **supporting/advancing work only**. It may
   establish a parser, port, fixture, or partial surface, but cannot close the
   requirement.
4. A later client or post-1.0 ticket belongs in the cell only when the normative
   requirement truly remains incomplete until that later surface. Mere
   carry-forward testing belongs in `Required evidence` and does not change the
   terminal gate.

For example, `FR-PROC-010` cites R2.11 and R6.14: R2 discovers manifest-derived
verification suggestions, while R6 is the terminal gate because its factual and
stale final-summary integration closes the requirement. `FR-EDIT-009` and
`FR-EDIT-010` cite only R6 checkpoint/rewind tickets, so neither can be read as an
R3-owned requirement. This numeric rule is normative for all 213 rows and is the
source from which operations/release matrices copy their terminal-gate column.

Test paths below are target ownership patterns, not permission to create empty
test shells. A test counts only when it drives the public boundary and
asserts the user-visible failure path.

### 19.2 CLI bootstrap and terminal lifecycle

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-CLI-001` | R1.10–R1.12 | `apps/cli`, `robin-application`, `robin-terminal` | PTY no-argument launch enters interactive session and synthetic turn. |
| `FR-CLI-002` | R1.10–R1.12 | CLI parser/application | PTY initial positional prompt starts the same interactive loop. |
| `FR-CLI-003` | R7.14–R7.16/R7.19 | CLI/headless application | Bounded stdin attachment, conflict/error, no raw instruction elevation, external consumer test. |
| `FR-CLI-004` | R0.05–R0.06, R10.23 | CLI parser | Exhaustive argv table for duplicate/conflicting/invalid options with no side effects. |
| `FR-CLI-005` | R0.05, R1.10 | CLI parser | Unknown reserved commands suggest and fail before provider/workspace initialization. |
| `FR-CLI-006` | R0.06/R0.09, R10.11/R10.23 | CLI/package | Help/version/completion/schema snapshots from installed package; cold path sentinels. |
| `FR-CLI-007` | R1.07/R1.11 | `robin-terminal` | Color/hyperlink/Unicode/width/reduced-motion/TTY capability matrix. |
| `FR-CLI-008` | R1.06/R1.11, R2.10/R2.15 | application/terminal/process | First graceful cancellation, second forced shutdown, provider/tool/process propagation. |
| `FR-CLI-009` | R1.11, R3.16 | application/local state | SIGTERM bounded shutdown and durable recovery with stable cancelled exit. |
| `FR-CLI-010` | R1.07–R1.11 | `robin-terminal` | Raw mode/cursor/style/paste restoration after every success/error/signal/EPIPE path. |
| `FR-CLI-011` | R7.14–R7.19 | CLI renderers | stdout/stderr separation and no ANSI/non-schema bytes in machine modes. |
| `FR-CLI-012` | R7.14/R7.19, R10.23 | CLI exit mapper | Stable numeric/category snapshots and subprocess cases for every terminal result. |

### 19.3 Interactive input and rendering

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-UI-001` | R1.08/R1.11 | `robin-terminal` | Pure grapheme editor reducer and PTY keyboard/history/editing cases. |
| `FR-UI-002` | R1.07–R1.09/R1.11 | terminal renderer | Resize plus wide/combining/emoji cursor and frame snapshots. |
| `FR-UI-003` | R1.01/R1.09/R1.12, R2.15 | terminal/application events | Incremental text and visible tool/process activity from normalized events. |
| `FR-UI-004` | R1.09, R2.10/R2.15 | terminal/process views | Bounded output summary/expand/artifact behavior under flood and small terminals. |
| `FR-UI-005` | R2.02/R2.13, R3.15, R4.13, R5.02 | session status view | Repository/branch/session/provider/model/mode/context/budget/change facts, no fabricated state. |
| `FR-UI-006` | R3.15, R8.05–R8.09 | terminal commands/prompt/extensions | `/` command dispatch and `@` resource/skill resolution with explicit provenance. |
| `FR-UI-007` | R1.06/R1.09/R1.12 | application/terminal | Visible bounded queued messages and deterministic submission order. |
| `FR-UI-008` | R1.06/R1.11, R2.10/R2.15 | cancellation tree | Tool/model/turn interruption and confirmed process settlement. |
| `FR-UI-009` | R1.07/R1.09/R1.11 | flat renderer | Screen-reader/no-cursor-addressed PTY and redirected-output flows. |
| `FR-UI-010` | R1.09/R1.11, R5.05 | renderer/approval UI | No-color symbols/text retain permission/error/diff distinctions. |
| `FR-UI-011` | R1.01/R1.09, R11.08 | event/renderer boundary | Import checks and semantic parity prove renderers contain no enforcement. |
| `FR-UI-012` | R4.14, R10.07 | redaction before event sink | Secret canary absent from every human/flat/machine/editor event surface. |

### 19.4 Sessions and conversation

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-SES-001` | R3.01–R3.02/R3.11 | `robin-session`, `local-state` | Opaque ID/name/workspace/config snapshots replay from durable log. |
| `FR-SES-002` | R3.05/R3.10/R3.16 | application/session store | Kill immediately after submit; no provider call precedes durable user event. |
| `FR-SES-003` | R3.02/R3.10/R3.18, R4.12 | session/provider/tool records | Normalized assistant/tool/approval/result/usage/config facts survive replay/export. |
| `FR-SES-004` | R3.11/R3.14/R3.18 | resume application | Continue filters by canonical workspace and selects newest eligible only. |
| `FR-SES-005` | R3.11 | session index | Normalized unique names, ambiguity errors, atomic rename, index rebuild. |
| `FR-SES-006` | R3.11/R3.13–R3.14, R6.05 | session branching | Immutable parent boundary/context/workspace reference and independent child log. |
| `FR-SES-007` | R3.11/R3.15 | session administration | List/inspect/rename/export/archive/delete exact selectors and human/JSON output. |
| `FR-SES-008` | R3.07/R3.11/R3.17, R10.10 | local state lifecycle | Exact recoverable trash, CAS dependency retention, dry run and no broad deletion. |
| `FR-SES-009` | R3.14/R3.16 | resume/workspace | Branch/HEAD/index/worktree/config/extension drift classification before provider/effect. |
| `FR-SES-010` | R3.04/R3.08/R3.14 | log scanner/replay | Torn-tail repair, middle quarantine, invalid snapshot fallback, actionable diagnostics. |
| `FR-SES-011` | R3.05–R3.09 | local state | Short-write/flush/rename/crash fault matrix yields only documented projections. |
| `FR-SES-012` | R3.11/R3.17, R10.09 | export/redaction | Human/machine transcript manifest labels omitted secret/raw/uncertain content. |

### 19.5 Agent loop

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-AGT-001` | R1.02/R1.05–R1.06, R7.18 | `robin-agent` | One coordinator drives synthetic and every real provider/client surface. |
| `FR-AGT-002` | R1.02, R3.02/R3.10 | `robin-session` turn reducer | Exhaustive legal state/terminal/replay table and illegal-transition failure. |
| `FR-AGT-003` | R1.03/R1.05, R5.07 | provider collector/tool registry | Only sealed, schema-valid exact-version calls reach permission pipeline. |
| `FR-AGT-004` | R1.03/R1.05, R4.05, R5.07 | collector/registry | Duplicate IDs, malformed args, unknown tool/version, schema bounds never execute. |
| `FR-AGT-005` | R1.05, R9.03 | tool loop/scheduler | Serial default; any later parallelism requires side-effect/workspace scheduler proof. |
| `FR-AGT-006` | R1.02/R1.06, R4.06–R4.07, R7.09 | budget service | Turns/requests/tools/time/tokens/cost/output/repetition hard-limit cases. |
| `FR-AGT-007` | R1.06/R1.11, R2.10, R4.06 | cancellation tree | Abort propagates provider/tool/process/persistence and records settlement. |
| `FR-AGT-008` | R4.06/R4.12, R7.03/R7.06 | provider adapter/agent | Classified retry only; uncertain attempts visible and never silent replay. |
| `FR-AGT-009` | R1.02/R1.12, R6.14 | session/factual summary | Assistant message stored separately from edit/test/task success facts. |
| `FR-AGT-010` | R1.04/R1.12, R2.14 | synthetic provider | Deterministic complete tool loop, failures, cancellations, resume, and E2E. |
| `FR-AGT-011` | R1.01, R3.02 | application/session events | Event schemas contain observable facts and no fabricated hidden reasoning. |
| `FR-AGT-012` | R1.02/R1.06, R7.18 | agent contract/conformance | Replaceable loop boundary/version fixture without client/tool semantic divergence. |

### 19.6 Prompt and context

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-CTX-001` | R3.12 | `robin-prompt` | Versioned roles/order and semantic request golden fixtures. |
| `FR-CTX-002` | R3.12, R8.05–R8.07 | prompt/instruction compiler | Trust/source tagging; repository/config text never becomes product system role. |
| `FR-CTX-003` | R2.04/R2.06, R3.12 | workspace/prompt | Startup uses bounded metadata and no whole-repo content read/hash. |
| `FR-CTX-004` | R2.06/R2.13, R3.12 | tool/context boundary | Content enters through explicit released tool/attachment records only. |
| `FR-CTX-005` | R2.06/R2.09, R3.12 | context manifest | Canonical identity/version/hash/range/transformation/provenance for every item. |
| `FR-CTX-006` | R2.04–R2.06 | `tool-workspace`, context broker | Binary/generated/ignored/oversize/secret cases withheld with safe reason. |
| `FR-CTX-007` | R3.12–R3.13, R4.07, R7.09 | token/capability budget | Provider-specific reserve/safety/context limit and oversized-input behavior. |
| `FR-CTX-008` | R3.13, R4.12/R7.18 | compaction/session | Typed covered range/hash/decisions/files/verification/unknowns and local validation. |
| `FR-CTX-009` | R3.13/R3.15 | context UI/application | Inspect/compact surfaces with category/token/omission evidence. |
| `FR-CTX-010` | R3.13 | compaction/permissions | Summary cannot authorize, certify effect, or replace exact preconditions. |
| `FR-CTX-011` | R8.01–R8.07 | config/instruction compiler | Documented source precedence and active provenance tests. |
| `FR-CTX-012` | R8.05–R8.07 | instructions | `ROBIN.md` plus explicitly labeled bounded `AGENTS.md` compatibility. |

### 19.7 Repository discovery and read tools

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-REP-001` | R2.02 | `tool-workspace`, `tool-git` | Physical root/common-dir/workspace identity snapshot and replacement drift. |
| `FR-REP-002` | R2.03 | physical path | Full traversal/absolute/UNC/drive/NUL/separator/Unicode physical corpus. |
| `FR-REP-003` | R2.03/R2.16 | physical path/policy | Operation-specific symlink denial and outside-content canary absence. |
| `FR-REP-004` | R2.04 | file walker | Depth/count/path/time/ignore/classification/omission/deterministic-order cases. |
| `FR-REP-005` | R2.05 | search | Literal default, query/match/file/time limits, built-in/ripgrep conformance. |
| `FR-REP-006` | R2.06 | read | Line/byte windows, encoding/binary/hash/change detection/truncation. |
| `FR-REP-007` | R2.12 | Git reads | Status/diff/log/branch structured odd-path and bounded parser fixtures. |
| `FR-REP-008` | R2.06 | platform/file read | Supported no-atime behavior measured; unsupported platform documented rather than claimed. |
| `FR-REP-009` | R2.04 | ignore rules | Git/Robin/provider/hard-exclusion provenance and override boundaries. |
| `FR-REP-010` | R2.04–R2.06/R2.12 | result release | Bounds before persistence/render/model; omission/truncation/hash tests. |

### 19.8 File editing and checkpoints

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-EDIT-001` | R2.07–R2.09 | `tool-workspace` structured patch | Exact preimage/hunks/parser/application and provider-tool E2E. |
| `FR-EDIT-002` | R6.01–R6.04 | workspace edit schemas | Distinct bounded full/create/batch operation with higher risk and limits. |
| `FR-EDIT-003` | R6.03–R6.04 | batch edit | Create/update/move/delete exact preconditions and journal recovery. |
| `FR-EDIT-004` | R2.07, R6.01 | patch/batch parser | Malformed/path disagreement/overlap/duplicate/collision/size rejection. |
| `FR-EDIT-005` | R2.08/R2.15, R5.14 | atomic file/tool pipeline | Immediate preimage recheck and stale approval no-effect tests. |
| `FR-EDIT-006` | R2.08, R6.03–R6.04 | atomic file/platform | Short-write/temp/flush/rename/mode/newline/BOM support and limits. |
| `FR-EDIT-007` | R2.08–R2.09, R3.07/R3.10 | edit ledger/CAS | Before/after hashes, bounded diff, full diff hash, durable action attribution. |
| `FR-EDIT-008` | R2.02/R2.09 | edit ledger/Git snapshot | Pre-existing dirty and mixed/external labels under outside changes. |
| `FR-EDIT-009` | R6.05 | checkpoint | Stable turn/risky-operation grouping with paths/hashes/CAS/verification. |
| `FR-EDIT-010` | R6.06 | rewind | Exact current postimage, preview, external drift denial, inverse journal. |
| `FR-EDIT-011` | R2.08, R6.04 | atomic/batch faults | Disk full/permission/rename/lock/signal/partial failure user and recovery states. |
| `FR-EDIT-012` | R2.09/R2.12, R6.14 | ledger plus current Git | Cumulative diff derived from current repository and attribution, not transcript claim. |

### 19.9 Process and shell tools

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-PROC-001` | R2.10 | `tool-process` | Executable/argv/cwd/env/time/output schema, no shell interpretation. |
| `FR-PROC-002` | R5.13 | explicit shell tool | Exact shell/script display/hash, distinct permission, metacharacter cases. |
| `FR-PROC-003` | R2.10, R5.12 | environment/sandbox | Allowlist, additions, credential canaries, sandbox receipt. |
| `FR-PROC-004` | R2.10/R2.15, R5.12 | process controller | Dedicated group, TERM/KILL escalation, descendant/orphan tests. |
| `FR-PROC-005` | R2.10 | output multiplexer | Channel/order metadata, bounded head/tail/hash, terminal/model views. |
| `FR-PROC-006` | R2.10, R5.09–R5.12 | process/sandbox | Time/output/PID/memory/CPU/file limits and setup-failure behavior. |
| `FR-PROC-007` | R5.08–R5.12 | `robin-platform` sandbox | Requested/achieved backend/roots/network/resource receipt. |
| `FR-PROC-008` | R5.08/R5.12/R5.15 | sandbox selection | Strict unavailable denies; best effort disclosed and recorded. |
| `FR-PROC-009` | R9.10–R9.17 | supervisor/daemon | Durable handle/log/status/input/cancel/cleanup/recovery for background process. |
| `FR-PROC-010` | R2.11, R6.14 | verification discovery/summary | Manifest-derived suggestions, explicit execution, factual/stale verification. |

### 19.10 Git tools

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-GIT-001` | R2.02/R2.12 | `tool-git` | Initial HEAD/branch/status/index snapshot before first mutation. |
| `FR-GIT-002` | R2.12 | porcelain parser | Spaces/tabs/newlines/Unicode/renames/conflicts/submodules NUL fixtures. |
| `FR-GIT-003` | R2.12, R6.07–R6.13 | Git tool registry | Separate read/stage/commit/branch/push/PR side-effect classes and modes. |
| `FR-GIT-004` | R6.07–R6.08 | stage plan | Exact paths/postimages/staged diff/index precondition and race cases. |
| `FR-GIT-005` | R6.09 | safe commit | Exact tree/parent/message/object/CAS ref update and factual result. |
| `FR-GIT-006` | R6.12–R6.13 | remote/PR | Canonical remote/refspec/credential/network display and receipt. |
| `FR-GIT-007` | R6.15 | permissions/tool set | Destructive/history-write tools absent and forged requests denied. |
| `FR-GIT-008` | R9.05–R9.09 when shipped | Git worktree | Common-dir/admin/root/base/marker/process/import/cleanup fixtures. |
| `FR-GIT-009` | R5.14, R6.07–R6.09 | precondition observer | HEAD/index/worktree/sequencer/path drift invalidates approval. |
| `FR-GIT-010` | R6.13 | PR adapter/fallback | Reviewed adapter URL or truthful local prepared title/body. |

### 19.11 Providers and models

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-PROV-001` | R4.01–R4.05 | `model-provider` | Semantic request/normalized async events; SDK types import-check confined. |
| `FR-PROV-002` | R4.01/R4.05, R7.01 | provider events | Text/tool/usage/stop/warning/failure fragmentation and schema corpus. |
| `FR-PROV-003` | R4.07, R7.05–R7.09 | adapter/profile/capability | Provider/model/origin/auth/capability validation and extension contribution boundary. |
| `FR-PROV-004` | R4.07, R7.09 | capability negotiation | Tool/parallel/structured/modal/context/usage manifest intersection. |
| `FR-PROV-005` | R4.04, R7.09–R7.10 | prompt/adapter | Only negotiated transformations; unsupported mode/switch rejection. |
| `FR-PROV-006` | R4.05, R7.03/R7.06 | decoders/session | Safe unknown stop/field preservation without control-flow trust. |
| `FR-PROV-007` | R4.06, R7.03/R7.06 | transport/retry | Method/transmission/result-certainty table and visible new attempts. |
| `FR-PROV-008` | R4.01/R4.06, R7.01 | provider errors | Stable category plus redacted provider status/request metadata. |
| `FR-PROV-009` | R7.05–R7.08 | compatible adapter | Explicit compatibility level/origin/capability probe; no silent emulation. |
| `FR-PROV-010` | R7.08/R7.18 | local profile | Same adapter contract, no-key path, explicit local transport/privacy facts. |
| `FR-PROV-011` | R4.07, R7.09–R7.10 | model catalog/session | Mutable alias label, pinned ID/version/capability in every invocation. |
| `FR-PROV-012` | R4.02/R4.15, R7.01/R7.18 | conformance | Recorded response, fake transport, cancellation/error/tool/resume suites per adapter. |

### 19.12 Credentials and authentication

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-CRED-001` | R4.09, R7.12–R7.13 | `robin-platform` records | Secret-free provider/auth/source/generation/validation metadata schema. |
| `FR-CRED-002` | R4.09–R4.10, R7.12 | credential adapters | OS store, exact env reference, hidden session input; no plaintext fallback. |
| `FR-CRED-003` | R0.05, R4.09–R4.11/R4.14 | CLI/credentials | Argv parser forbids raw secret; process-list/history/canary tests. |
| `FR-CRED-004` | R4.09/R4.14 | environment resolver | Exact named variable, value not copied to record, removed from child environments. |
| `FR-CRED-005` | R4.09/R4.12, R7.07 | secret lease/provider transport | Invocation/origin/auth/deadline-bound delivery only at transport. |
| `FR-CRED-006` | R4.06/R4.11/R4.13 | auth validation | Missing/rejected/scope/model/rate/network categories with safe remediation. |
| `FR-CRED-007` | R4.11/R4.14, R10.07–R10.09 | commands/redaction | List/inspect/export/log/support show metadata and redacted hints only. |
| `FR-CRED-008` | R4.11, R7.13 | record removal | Dependent profiles/sessions, exact confirmation, OS/external partial outcomes. |
| `FR-CRED-009` | R7.13 | rotation | New generation validated before atomic switch; old retained until confirmed removal. |
| `FR-CRED-010` | R2.10, R5.12, R8.09/R8.11/R8.14 | child environment | Process/hook/MCP/skill/plugin canaries prove no ambient provider secret. |

### 19.13 Configuration and instructions

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-CONF-001` | R8.01–R8.03 | `robin-config` | Every scope and field precedence permutation plus source trace. |
| `FR-CONF-002` | R5.03, R8.01–R8.02 | managed floor/policy | Every lower source fails to widen a managed provider/tool/sandbox/budget rule. |
| `FR-CONF-003` | R8.04 | project trust | Candidate inventory before semantic load, category grant, hash-change reapproval. |
| `FR-CONF-004` | R4.08, R8.01–R8.02 | config loader | Byte/version/duplicate/unknown/nesting/time bounds and no code execution. |
| `FR-CONF-005` | R8.02 | config explain | Redacted effective/winner/overridden/managed/validation snapshots. |
| `FR-CONF-006` | R8.03 | config writer | Atomic update, unrelated-field preservation, new-schema refusal, fault recovery. |
| `FR-CONF-007` | R8.01–R8.03 | config schema | Provider/model/permission/tool/budget/render/instruction/hook/skill/MCP/sandbox/retention/update fields. |
| `FR-CONF-008` | R8.03 | secret-shape/credentials | Reject and migrate safely; backups/explain/canary remain secret-free. |
| `FR-CONF-009` | R8.05 | instruction imports | Relative root/depth/count/byte/time/symlink/cycle/provenance corpus. |
| `FR-CONF-010` | R8.06 | path-scope compiler | Canonical anchored globs, matching/nonmatching/empty/changed paths and manifest. |

### 19.14 Permissions and policy

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-PERM-001` | R5.01/R5.07 | `robin-permissions`, `robin-tools` | Normalized action facts for every built-in/dynamic tool and missing attribute. |
| `FR-PERM-002` | R5.02–R5.03 | policy adapter | Deny over ask over allow; mutation and explanation tests. |
| `FR-PERM-003` | R5.02 | modes | Default matrix reads/edits/commands/high-risk cases. |
| `FR-PERM-004` | R5.02 | modes/tool advertisement | Plan mutation denial and accept-edits bounded allowance with forged-call tests. |
| `FR-PERM-005` | R5.16, R7.17 | headless permission | Ask-to-deny and exact framed callback behavior without TTY. |
| `FR-PERM-006` | R5.04–R5.05 | approval UI/records | Exact scope/preconditions/risk/effect/sandbox/once/session/rule display tests. |
| `FR-PERM-007` | R5.06 | rule writer | Generated exact rule and destination diff before atomic persistence. |
| `FR-PERM-008` | R5.04/R5.07 | approval/tool pipeline | Tool fingerprint/request/workspace/policy/expiry hash binding and one-use. |
| `FR-PERM-009` | R5.14, R8.19 | precondition observer | File/command/target/provider/model/policy/extension/repository drift invalidation. |
| `FR-PERM-010` | R5.02–R5.03, R8.04 | managed/trust boundary | Repository cannot bypass/self-approve/weaken user or managed deny. |
| `FR-PERM-011` | R5.02/R5.05/R8.01 | CLI/mode/managed floor | Explicit launch-only confirmation, persistent UI warning, managed-disable case. |
| `FR-PERM-012` | R5.01/R5.03, R10.07 | explanation/redaction | Safe attributes only; secret canary absent from traces and simulation. |

### 19.15 Usage, budgets, and cost

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-BUD-001` | R1.02/R1.06, R4.07, R9.03 | agent/scheduler budget | Turn/request/token/cost/tool/process/output/context/child hard and soft limits. |
| `FR-BUD-002` | R4.05/R4.07, R7.01 | usage normalization | Provider values preferred; estimates labeled and reconciled. |
| `FR-BUD-003` | R4.07, R10.06 | pricing/report | Version/source/effective-date/currency and unknown-price behavior. |
| `FR-BUD-004` | R4.07/R4.12 | application UI | Soft warning before next consequential request/action crossing threshold. |
| `FR-BUD-005` | R1.02, R4.07 | agent/tool pipeline | Hard limit blocks before next bounded operation and records category. |
| `FR-BUD-006` | R3.14, R9.03 | resume/session | Snapshot shows reset/continued/ancestor aggregate budgets on resume/delegation. |

### 19.16 Headless and SDK-facing contracts

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-AUTO-001` | R7.14–R7.15/R7.19 | text renderer | stdout final text only; diagnostics/progress stderr. |
| `FR-AUTO-002` | R7.14–R7.15/R7.19 | JSON renderers | One final envelope or typed sequenced JSON Lines with external parser. |
| `FR-AUTO-003` | R7.14/R7.19, R10.23 | schemas/docs | Published input/output/error fixtures and compatibility tests. |
| `FR-AUTO-004` | R0.06, R7.14–R7.15 | renderer | Machine modes contain no terminal control sequences. |
| `FR-AUTO-005` | R7.15 | application/local state | No-session creates no transcript/CAS and clearly disables resume. |
| `FR-AUTO-006` | R7.15 | CLI/application | Caller session IDs limited to validated namespace and collision checks. |
| `FR-AUTO-007` | R5.16/R7.17, R8.10/R8.14 | framed callbacks/extensions | Length/nonce/hash/schema/time/resource bounds and no stdout spoof. |
| `FR-AUTO-008` | R11.02–R11.09 | application/client protocol | Future SDK wraps versioned application methods and cannot bypass enforcement. |

### 19.17 Hooks, skills, MCP, and subagents

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-EXT-001` | R8.08–R8.17, R9.01 | `robin-extensions` | Distinct identity/manifest/lifecycle/tool/context/delegation contracts. |
| `FR-EXT-002` | R8.04/R8.08 | trust/extension identity | Project category trust and user source/version/integrity records. |
| `FR-EXT-003` | R8.09 | skills | Metadata-only startup and bounded selected instruction/resource load. |
| `FR-EXT-004` | R8.10–R8.11 | hooks | Event/matcher/type/timeout/concurrency/permission/failure schema and scheduler. |
| `FR-EXT-005` | R8.10–R8.11 | hook protocol | Forged result/allow denied; only closed control responses applied. |
| `FR-EXT-006` | R8.13–R8.17 | MCP record/trust | Exact stdio/HTTP transport/scope, project self-approval denial. |
| `FR-EXT-007` | R8.15–R8.16 | MCP tool mapper | Annotation-lie corpus and conservative side-effect mapping. |
| `FR-EXT-008` | R8.09/R8.11/R8.14/R8.18 | extension sandbox | Minimum env/root/network/credential leak/escape canaries. |
| `FR-EXT-009` | R9.01–R9.04/R9.21–R9.24 | subagent/backend manifest/scheduler | Explicit model/prompt/tools/permissions/context/budget/concurrency/worktree/result and compatibility tier. |
| `FR-EXT-010` | R9.02–R9.04/R9.17 | delegation/cancellation | Authority intersection, descendant ceiling, parent cancel, no widening/delegation. |
| `FR-EXT-011` | R9.05–R9.09 | scheduler/worktrees | Shared read snapshot only; distinct verified worktree for parallel mutation. |
| `FR-EXT-012` | R8.18–R8.20, R9.15–R9.17 | lifecycle/recovery | Extension/child failure isolated, recorded, cancel/recover without transcript corruption. |

### 19.18 Diagnostics, updates, and data lifecycle

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `FR-OPS-001` | R10.08 | doctor application | Read-only default and explicit labeled active/fix probes. |
| `FR-OPS-002` | R10.08 | doctor/platform | Install/version/state/Git/provider/model/credentials/sandbox/extensions/local-session-store matrix. |
| `FR-OPS-003` | R10.09 | support bundle | Dry-run file/field/size/hash/redaction inventory and verified safe archive. |
| `FR-OPS-004` | R10.07 | observability | Structured levels/limits/rotation/redaction/retention/failure behavior. |
| `FR-OPS-005` | R10.17 | update channel | Disclosed destination, disable/offline/hermetic, no repository content. |
| `FR-OPS-006` | R10.15–R10.17 | release/update | Signed/checksummed stable/beta manifest/artifact and tamper/rollback tests. |
| `FR-OPS-007` | R3.07/R3.17, R10.10 | retention | Separate transcript/artifact/log/cache/recovery classes and dependency retention. |
| `FR-OPS-008` | R10.10/R10.19 | data lifecycle | Project/global dry-run, exact targets, trash/purge manifests, broad-root denial. |
| `FR-OPS-009` | R3.01/R3.17, R10.18 | migration runner | Versioned restartable copy-validate-switch, backups/rollback, all old fixtures. |
| `FR-OPS-010` | R10.07–R10.09 | crash/support | Redacted crash report/bundle without raw credential/content by default. |

### 19.19 Non-functional requirements

| Requirement | Terminal gate and tickets | Owning boundary | Required evidence |
| --- | --- | --- | --- |
| `NFR-SEC-001` | R2.03–R2.12, R3.01, R4.05, R8.05/R8.10/R8.14, R11.03 | every parser/boundary | Byte/item/nesting/time limits, fuzz/property corpus, bounded allocations. |
| `NFR-SEC-002` | R2.03/R2.08, R5.14, R6.04 | workspace/tool preconditions | Immediate physical containment and type/hash recheck before every access/effect. |
| `NFR-SEC-003` | R4.09–R4.14, R7.12–R7.13, R10.07–R10.09 | credentials/redaction | Raw key absent from context/children/state/log/export/support/diagnostics. |
| `NFR-SEC-004` | R5.01/R5.04/R5.07/R5.14 | permissions/tool pipeline | Exact immutable normalized/precondition/policy request and one-use grant. |
| `NFR-SEC-005` | R5.03, R8.01/R8.04/R8.18 | managed/trust/extensions | Lower sources and project extensions cannot weaken higher controls. |
| `NFR-SEC-006` | R10.05/R10.13/R10.20 | release eval/security | Adversarial path/patch/command/stream/protocol/provider/extension/credential gates. |
| `NFR-REL-001` | R3.02/R3.09/R3.16, R9.15 | replay/recovery | Crash never fabricates completed turn/effect; every incomplete state classified. |
| `NFR-REL-002` | R3.02/R3.14 | session reducer | Replay executor spies untouched across every durable fixture. |
| `NFR-REL-003` | R3.10/R3.16, R4.06, R6.04/R6.12 | effect recovery | Idempotency/reconciliation/uncertain rules and no duplicate fault suites. |
| `NFR-REL-004` | R1.11, R2.08/R2.10, R3.06, R9.09/R9.16 | cleanup/resource ownership | Terminal/file/Git/session/process/socket/worktree cleanup or retained inventory. |
| `NFR-REL-005` | R3.01/R3.17, R7 migration, R10.18 | migrations | Oldest-supported fixtures, upgrade/rollback/corrupt/newer refusal matrix. |
| `NFR-PERF-001` | R0.06, R10.14 | CLI cold paths | Packaged warm help/version percentile without provider/repository imports. |
| `NFR-PERF-002` | R1.08–R1.09, R10.14, R12.11 | UI/event backpressure | p95 input/render under provider/process/tool load and bounded refresh. |
| `NFR-PERF-003` | R2.04–R2.06, R10.14 | workspace discovery | Lazy bounded walk; startup content/hash probes prove no full repo scan. |
| `NFR-PERF-004` | R3.07/R3.08/R3.12–R3.13 | session/context | Windowed memory, snapshots, CAS refs, incremental replay/compaction benchmarks. |
| `NFR-PERF-005` | R10.14/R10.22 | performance gate | p50/p95/p99 by platform/build with accepted threshold/provenance. |
| `NFR-PRIV-001` | R3.12, R4.12, R7.07 | context/provider/session | Egress attributable to request/context manifest/provider/origin. |
| `NFR-PRIV-002` | R10.07/R10.17/R10.20 | observability/config | Telemetry absent/off until schema/destination/retention/consent gate. |
| `NFR-PRIV-003` | R3.03/R3.17, R10.10/R10.23 | platform/docs/lifecycle | Exact per-platform locations, retention, export, delete, uninstall behavior. |
| `NFR-PRIV-004` | R8.13–R8.18 | extensions/MCP | Third-party egress shown as separate origin/credential/permission/context boundary. |
| `NFR-A11Y-001` | R1.08–R1.11, R12.11 | terminal/editor UI | Keyboard-only coverage for every interactive workflow. |
| `NFR-A11Y-002` | R1.07/R1.09, R12.11 | flat/no-color renderer | No-color/no-animation/flat output complete and tested. |
| `NFR-A11Y-003` | R1.07/R1.09, R12.11 | terminal/editor status | Reduced motion and bounded status announcements/update cadence. |
| `NFR-A11Y-004` | R5.05, R12.08/R12.11 | approval UI | Action/choice/risk expressed in text independent of color/symbol. |
| `NFR-PORT-001` | R10.14/R10.19/R10.23 | release support matrix | Exact macOS/Linux/Node/Git/sandbox/credential/editor versions; untested omitted. |
| `NFR-PORT-002` | R1.07/R1.11, R2.03/R2.10, R3.03/R3.06, R7.12 | platform ports | Path/signal/group/store/terminal differences through explicit tested adapters. |
| `NFR-PORT-003` | R5.08–R5.15, R10.08 | sandbox/doctor | Unsupported enforcement cannot satisfy strict mode and is diagnosed. |
| `NFR-MAINT-001` | R1.01–R1.10, R11.08, R12.03–R12.08 | package import boundaries | Architecture checks keep UI/application/agent/provider/tools/state separate. |
| `NFR-MAINT-002` | R4.03–R4.05, R7.02–R7.08 | provider adapters | Provider SDK/wire objects never cross adapter exports. |
| `NFR-MAINT-003` | R2.13, R5.07 | `robin-tools` | Tool schemas/version/fingerprint/normalizer/release/reconcile conformance. |
| `NFR-MAINT-004` | R0.10, every phase docs ticket, R10.23 | docs/release claims | Current/planned status checks and no unsupported package/help/demo claim. |

## 20. Gate Evidence, Test Commands, and Review Policy

### 20.1 Gate evidence manifest

Every phase produces a machine-readable evidence manifest from a clean commit:

```ts
interface GateEvidenceManifestV1 {
  readonly schemaVersion: 1;
  readonly gate: "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11" | "R12";
  readonly commit: string;
  readonly dirty: false;
  readonly robinVersion: string;
  readonly dependencyLockSha256: string;
  readonly environment: readonly EvidenceEnvironment[];
  readonly commands: readonly EvidenceCommandResult[];
  readonly requirements: readonly RequirementEvidence[];
  readonly fixtures: readonly EvidenceFixture[];
  readonly artifacts: readonly EvidenceArtifact[];
  readonly supportedClaims: readonly string[];
  readonly deferredClaims: readonly string[];
  readonly knownLimitations: readonly EvidenceLimitation[];
  readonly generatedAt: string;
}
```

The generator records exact commands, exit status, duration, result summary, and
artifact hashes. It rejects a dirty tree for acceptance, redacts environment, and
does not upload artifacts by itself. A phase pull request links the manifest and a
human summary. Generated evidence cannot mark a requirement complete unless the
test and owning ticket exist in the traceability matrix.

### 20.2 Standard test commands

The root package evolves toward these stable commands:

| Command | Scope |
| --- | --- |
| `npm run format:check` | deterministic source/docs/config formatting without mutation |
| `npm run typecheck` | strict project-reference typecheck for every workspace |
| `npm run test:architecture` | imports, package layering, public identity, no duplicate engine/enforcement |
| `npm run test:unit` | pure parser/reducer/algorithm/package tests |
| `npm run test:integration` | public package boundaries, temp files/repositories/processes/local servers |
| `npm run test:pty` | built packaged CLI terminal/input/render/signal flows |
| `npm run test:security` | path/patch/command/Git/provider/credential/extension/protocol adversarial cases |
| `npm run test:fault` | filesystem/process/provider/queue crash and reconciliation schedules |
| `npm run test:conformance` | provider, credential-store, sandbox, hook, MCP, agent-backend, and client contracts |
| `npm run test:migration` | oldest-supported durable/config/protocol/extension upgrade and rollback fixtures |
| `npm run test:package` | pack inventory, temporary-prefix/clean-machine install, provenance, uninstall |
| `npm run test:eval:deterministic` | release-blocking seeded scenarios and invariants |
| `npm run test:eval:live` | protected opt-in provider/local-model quality and compatibility runs |
| `npm run test:performance` | fixed-machine benchmark suite and thresholds |
| `npm run test:gate:rN` | the named phase plus every accepted prior deterministic gate |

`test:eval:live` never runs for an untrusted pull request and is not required to
prove deterministic safety. A released provider claim still requires its
protected live smoke and recorded adapter conformance before the gate manifest.

### 20.3 Test fixture and golden policy

- Fixtures are source-controlled recipes or sanitized bytes with stable semantic
  IDs and schema versions.
- Generated repositories live under unique temporary roots and include an owner
  marker; tests refuse the source checkout, home, filesystem root, or a non-empty
  unowned target.
- Goldens cover canonical semantic output. A bulk golden update is forbidden;
  reviewers inspect changed event/request/diff fields and migration impact.
- Provider fixtures contain no live authorization header, cookie, key, user
  repository content, personal identifier, or unrestricted endpoint.
- Security canaries are unique per test/run so a generic redaction string cannot
  create a false pass.
- Random/property/fuzz cases record seeds and minimize failures into permanent
  fixtures.
- Time uses injected clocks. Integration tests waiting on processes use bounded
  observed conditions and deadlines, not correctness sleeps.
- Platform-specific behavior is asserted only on the platform where it applies;
  unsupported behavior must have an explicit fail/diagnostic test.
- A flaky deterministic test blocks its gate. It is fixed or the nondeterminism
  is modeled; it is not retried until green and called reliable.

### 20.4 Pull-request review checklist

Every implementation pull request answers:

1. Which ticket and requirement IDs does it implement?
2. What user-visible journey or protection does it unlock?
3. Which boundary parses untrusted input, and what are its size/time limits?
4. Which state/event/schema versions change, and what migration/old fixture proves
   compatibility?
5. Which effects can occur, where is permission evaluated, and which live
   preconditions are rechecked?
6. What happens on cancellation, process death, short write, transport drop,
   daemon/editor disconnect, and recovery?
7. What secret, source, path, provider, extension, or remote data can cross a
   boundary, and what leak canary covers it?
8. What resources are created, who owns them, and how are cleanup and retained
   evidence reported?
9. Which human, flat, JSON, log, export, support, and editor views change?
10. Which install/update/uninstall/package behavior changes?
11. Which deterministic, adversarial, fault, PTY, conformance, migration, or
    performance tests were added first and now pass?
12. Which feature remains deferred, and do docs/help avoid claiming it?

Review rejects direct provider SDK use outside adapters, direct filesystem/tool
effects from UI/agent/extension code, raw environment reads outside the CLI/
platform boundary, broad destructive cleanup, ignored errors at durability
barriers, unbounded stream accumulation, secrets in serialized objects, and a
second agent or permission loop.

### 20.5 Acceptance procedure

1. Complete every phase ticket or record an explicit scope removal that also
   removes the corresponding claim/requirement from the release gate.
2. Run the phase command from a clean checkout and fresh dependency install.
3. Run supported-platform jobs and protected live checks required by that phase.
4. Generate evidence and compatibility/limitation manifests.
5. Inspect package/help/docs/current-versus-planned output.
6. Review threat-model and migration changes.
7. Merge only after all prior accepted gates remain green.
8. Update this plan's status and link the accepted commit/evidence; never set a
   phase accepted based on an in-progress preview.

## 21. Effort Model, Decision Points, and Risk Register

### 21.1 Effort ranges

Assuming one developer at roughly 15–20 focused hours per week, with test and
documentation time included:

| Outcome | Included gates | Incremental range | Cumulative range |
| --- | --- | ---: | ---: |
| identity baseline | R0 | under 1 week | under 1 week |
| interactive synthetic proof | R1 | 2–4 weeks | 3–5 weeks |
| real coding durable synthetic gate | R2–R3 | 10–16 weeks | 13–21 weeks |
| first hosted-provider alpha | R4 | 4–7 weeks | 17–28 weeks |
| permission/Git/provider automation gate | R5–R7 | 15–23 weeks | 32–51 weeks |
| first supported developer bundle | R8 | 8–12 weeks | 40–63 weeks |
| Robin 1.0 operations/release | R10 | 7–11 weeks | 47–74 weeks |
| optional post-1.0 advanced agents/background | R9 | 8–12 weeks | 55–86 weeks |
| protocol and editor extension | R11–R12 | 10–16 weeks | 65–102 weeks |

These are credible part-time effort bands, not delivery promises. Provider SDK
drift, platform sandboxing, OS credential adapters, filesystem fault work,
extension protocols, and signing/notarization can move elapsed time. Acceptance
evidence is not reduced to preserve a date.

### 21.2 Required decision records

Create or update ADRs before the associated irreversible choice:

- R1 terminal rendering/input dependency and Unicode width strategy;
- R2 live-workspace mutation, patch schema, and symlink/hard-link policy;
- R3 local framed event format, durability class, and platform flush claims;
- R4 first provider/SDK version, retry ownership, and credential-source support;
- R5 supported sandbox backends and claim tiers;
- R6 safe Git commit construction versus native hooks/signing;
- R7 compatible endpoint levels, OS keychain dependencies, and public machine
  schemas/exit codes;
- R8 config precedence, workspace trust categories, instruction/import format,
  hook protocol, and MCP version/transports;
- R9 scheduler/worktree ownership, daemon/provisional protocol, and external-agent
  guarantee tiers;
- R10 support matrix, package channels, signing/provenance, update and migration
  windows, telemetry decision;
- R11 stable local protocol and extension-versus-fork decision;
- R12 editor distribution/update/privacy policy, or a separate fork plan if the
  evidence gate authorizes it.

### 21.3 Risk register

| Risk | Earliest signal | Required response |
| --- | --- | --- |
| Runtime-first scope returns | Weeks spent on daemon/policy without an R1/R2 PTY workflow | Stop internal expansion; restore the critical path and require user-visible gate evidence. |
| Terminal UI consumes the project | Input/render bugs delay the agent loop | Keep pure reducer/flat renderer; ship accessible flat fallback before cosmetic richness. |
| Physical filesystem race or escape | Path corpus/fault tests find ambiguous containment | Deny unsupported link/filesystem cases, narrow platform claim, and add permanent regression fixture. |
| Local durability becomes a database project | Format work grows without resume E2E | Implement only semantic barriers/index rebuild needed for R3; postpone encryption/distributed storage. |
| Provider API drift | Recorded fixtures or live smoke diverge | Pin SDK/model profile, update adapter/conformance, preserve old session representation, narrow support until green. |
| “Any model/API key” overclaim | Unsupported key/model accepted then fails after egress | Require provider/auth/model capability profile before secret resolution or context send; label experimental mode. |
| Permission fatigue | Evals show repeated low-value prompts | Improve exact safe rules and session grants; never solve by broad hidden bypass. |
| Sandbox portability failure | Claimed backend cannot pass canaries on an OS update | Fail strict, show best-effort facts, use container backend, and remove unsupported matrix cell. |
| Dirty Git data loss | Attribution/rewind/index race fixture fails | Block mutation/commit, preserve recovery evidence, and fix exact precondition/journal before release. |
| Extension supply-chain authority | Project hook/skill/MCP reaches secrets or broad roots | Revoke trust, disable extension class, tighten sandbox/credential port, add incident fixture. |
| Subagent cost or write explosion | Aggregate budget/worktree quota or fairness test fails | Keep R9 feature-gated; lower depth/fan-out/concurrency and require isolated imports. |
| Daemon split brain | Two owners/leases can execute one command | Stop background release; fix lock/generation/liveness and rerun all crash schedules. |
| Package works only in monorepo | Temporary-prefix or clean-machine test fails | Block publication; correct bundled dependencies/assets/paths and repeat install matrix. |
| Migration destroys sole state | Fault test modifies source before target validation | Block release; restore copy-validate-switch and rollback fixtures. |
| Editor duplicates enforcement | Extension imports provider/tool/policy implementation | Fail architecture check; move behavior behind protocol and keep UI as client. |
| Fork maintenance trap | Fork proposed without measured extension limitation/security cadence | Apply R11 gate and refuse fork code until separate approved plan. |

### 21.4 Stop-and-review triggers

Pause the affected lane and write an ADR or security incident note when:

- an approved action can execute with changed request or preconditions;
- a denied/secret resource appears in provider, model, child, log, export, support,
  or editor output;
- replay or recovery duplicates or fabricates a side effect;
- cleanup needs a broad path, wildcard, or uncertain ownership;
- an SDK/framework requires bypassing Robin's loop/tool/permission/session
  boundary;
- a platform cannot provide a claimed sandbox, signal, credential, or durability
  primitive;
- a durable format requires in-place sole-copy mutation;
- provider/agent/extension protocol ambiguity makes an external effect outcome
  unknowable;
- user/editor/external-agent data would receive a stronger trust label than its
  provenance supports;
- a release claim cannot be mapped to an automated or explicitly human-reviewed
  evidence item.

## 22. Definitions of Done and Compatibility Truth

### 22.1 Durable synthetic coding gate done

The R3 gate is done when a packaged development build starts interactively in
a generated real repository, uses the synthetic provider to read/edit/test/diff,
persists exact session/tool/edit/process/context facts, exits, continues from a
new process, reconciles workspace state, and completes without outside changes,
duplicate effects, terminal damage, or unsupported provider/sandbox claim.

### 22.2 First hosted-provider alpha done

The R4 alpha adds one real hosted provider, supported exact model, BYOK environment
reference and hidden session input, provider streaming/tool continuation,
usage/cost labels, auth/retry/uncertainty behavior, first-run wizard, leak-canary
evidence, and an opt-in real-repository demo through the same loop. It is not a
supported developer release.

### 22.3 Provider and automation conformance gate done

The R7 internal beta/conformance gate adds exact permissions/approvals, a strict sandbox path, multi-file/
checkpoint/Git daily workflow, OpenAI/Anthropic/generic-compatible/local provider
tiers, OS-backed credentials where supported, model switching, and stable text/
JSON/JSONL/structured headless behavior. Every claim appears in a generated
compatibility matrix. It is still not the first supported developer release.

### 22.4 Supported developer bundle done

The R8 bundle is the first supported developer release only when every R0–R8
gate passes, its checksummed package installs on the claimed developer matrix,
target CLI vocabulary and automation schemas are stable, compatibility and
evidence manifests are generated, and configuration/instructions/skills/hooks/
MCP remain within their documented trust boundaries. It contains no R9 surface
and makes no 1.0 distribution claim.

### 22.5 Robin 1.0 done

Robin 1.0 is done when all R10 acceptance criteria pass and a fresh supported
machine can:

1. install a verified package;
2. inspect provenance and run doctor;
3. establish workspace trust;
4. configure a supported provider/model and secret source without a raw key in
   argv/config/logs;
5. run the flagship interactive read/edit/test/fix/diff/commit-preparation flow;
6. interrupt and resume safely;
7. use default/plan/accept-edits/locked/bypass modes, with bypass visibly
   launch-only and policy-bounded, and strict sandbox where claimed;
8. switch among claimed provider tiers and run headlessly through published
   schemas;
9. use instructions, skills, hooks, and MCP within their trust boundaries;
10. inspect/export/archive/delete data and create a redacted support bundle;
11. update/roll back within the supported window;
12. uninstall the executable while preserving data, reinstall, then explicitly
    purge exact Robin-owned data if desired.

The deterministic release corpus is green, no critical/high security finding is
open, package provenance/SBOM/checksums are public, migrations and rollback pass,
and limitations are published.

### 22.6 Flexible model, API key, and agent meaning

Robin is flexible by contract, not by accepting arbitrary strings:

- A **model** is supported when a direct provider adapter and exact capability
  profile can represent the selected workflow and pass conformance.
- An **API key** is supported when its provider/auth strategy and exact origin are
  implemented by a credential adapter. Robin can bind the user's own supported
  key without owning the account.
- A **local model** is supported when its endpoint passes a declared compatible
  subset; local inference does not silently enable unsupported tool semantics.
- A **Robin subagent** is a post-1.0 R9 capability that uses the same engine with
  a narrower explicit contract.
- A **mediated external agent** is supported only for the operations/context that
  traverse a reviewed protocol bridge with hidden channels disabled.
- A **black-box external agent CLI** can be contained in an isolated worktree and
  have candidate output imported, but Robin cannot claim visibility into its
  hidden reasoning/context/tools.

The direct-model path never requires Robin to host raw model weights or implement
an inference server. Cloud APIs, local servers, and future agents sit behind
ports; Robin owns the coding-agent product and enforcement.

### 22.7 Editor done

The editor is done only after R12: it uses the stable local protocol, contains no
second engine, supports selected context/diff/approval/reconnect/background
flows, preserves unsaved buffers, passes security/accessibility/performance and
marketplace package tests, and leaves the CLI fully capable. A Code-OSS fork is
not part of done unless its separate evidence gate and plan are accepted.

### 22.8 Repository-wide definition of done

At the end of any accepted phase:

- implementation matches this phase's package boundaries and state machines;
- every named ticket has code, test, failure UX, and docs evidence;
- every applicable requirement row has a passing proof and owner;
- accepted prior gates, architecture checks, mutation/fuzz seeds, and package
  tests remain green;
- no tracked secret, user session, local credential, temp root, absolute developer
  path, or ignored WIP source enters the release;
- no process, socket, lock, temp file, sandbox resource, worktree, or artifact is
  leaked without an explicit retained-evidence record;
- current/planned/deferred behavior is truthful in README/help/docs/package/demo;
- installation, migration, update, rollback, uninstall, and data behavior affected
  by the phase have been tested;
- threat model and residual risks are updated;
- a clean-commit gate evidence manifest records exact results and limitations.

## 23. Immediate Execution Order from the Accepted R1 Baseline

R0 and R1 are accepted. Experimental R1 `--print` formats remain narrower than
the stable R7 `--output`/`--no-session` automation contract. The current safe
sequence is:

1. implement R2 from disposable repository fixtures and an exact physical
   workspace safety oracle, never by pointing unfinished tools at the Robin
   checkout;
2. close path, read, edit, process, Git-read, and approval invariants before
   exposing their tools through the application;
3. require the complete synthetic diagnose/edit/verify/status/diff scenario and
   PTY approval matrix before accepting R2;
4. proceed to R3 durability only after R2 effects and attribution are accepted;
5. add the first hosted provider in R4 without moving tool authority into a
   provider adapter;
6. keep the archived Milestone C work as test/audit input and cherry-pick no
   component without fresh R2/R3/R9 review.

This ordering produces a Claude Code-style coding-agent experience as early as
possible while retaining Robin's policy/runtime work as internal, tested
infrastructure. The default product story remains: open a terminal in a
repository, run `robin`, collaborate on code, review exact actions and changes,
and resume the same work later with the provider/model the developer selected.
