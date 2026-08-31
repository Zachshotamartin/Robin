# Robin Coding-Agent CLI Architecture

Document status: normative target architecture for the Robin product pivot.

Implementation status: target design, not an implementation-complete claim. The
repository contains the accepted deterministic event/policy/context substrate
from Milestones A and B and an unaccepted R1 candidate. The R1 composition uses
a versioned in-memory application journal, pure reducer/replay projection, and
replay-then-live subscriber stream over a provider-neutral, multi-request
structured loop. Its credential-free synthetic provider invokes two pinned
fixture tools. The CLI has raw TTY and append-only flat modes, queued input,
cancellation, resize, inert bracketed paste, terminal restoration, and
experimental headless formats.

Local macOS PTY and isolated package install/execute/uninstall runs are candidate
evidence only. The R0 prerequisite and required hosted Linux/macOS and aggregate
evidence remain pending, so R1 is not accepted. Real provider adapters, physical
workspace tools, API-key/credential handling, a resumable local session store,
and the extension system remain planned until their named acceptance tests pass.
Each section below states how the implemented substrate is retained or replaced.

This document defines how Robin becomes a coding agent in the terminal. The
policy-aware runtime remains an internal enforcement subsystem. It is not the
primary product surface, the unit of navigation, or the concept a developer
must understand before asking Robin to fix code.

## 1. Architectural outcomes and invariants

Robin must make the following user journey coherent before adding a daemon,
editor fork, hosted control plane, or general-purpose agent profile:

1. A developer runs `robin` inside a repository.
2. Robin identifies the workspace, branch, instructions, provider, model,
   permission mode, and resumable session.
3. The developer describes coding work in ordinary language.
4. A direct-model agent reads and searches the repository, proposes and applies
   bounded edits, runs verification, interprets failures, and iterates.
5. Every model request, tool request, permission decision, effect, result,
   changed path, and verification command has a visible and durable record.
6. The developer can interrupt, redirect, continue, resume, inspect the diff,
   and decide whether Robin may perform Git writes.
7. The same engine serves the interactive terminal and headless surfaces.

The architecture is governed by these invariants:

- **Session is the product boundary.** A session is a durable conversation bound
  to a workspace. Internal runtime runs are subordinate execution records.
- **Robin owns the agent loop.** A provider supplies inference and protocol
  primitives; it does not own repository context, tool execution, permissions,
  session history, or recovery.
- **One canonical event stream feeds every surface.** Interactive rendering,
  JSON Lines output, session replay, diagnostics, and a future editor client
  consume normalized Robin events rather than provider-specific callbacks.
- **Complete structured calls are inert until accepted.** Streamed tool-name and
  argument fragments cannot trigger an effect. Validation, normalization,
  permissions, precondition capture, and execution occur in that order.
- **Consequential effects are serialized initially.** Robin may stream text and
  process output, but it executes no more than one mutating, process, network,
  or Git action at a time within a session.
- **Durability precedes external effect.** User input, normalized provider
  requests, permission decisions, and prepared effect records are persisted at
  the points defined in this document before the corresponding external work.
- **Workspace identity is physical, not textual.** Path authorization uses a
  resolved workspace root, component-by-component containment checks, and
  operation-time preconditions. A string beginning with the root path is not
  sufficient proof of containment.
- **Existing work is never silently destroyed.** Robin neither resets, cleans,
  overwrites conflicting edits, nor rewrites Git history to recover its own
  state.
- **Credentials are capabilities, not content.** Secret bytes are resolved only
  at the provider transport boundary and never enter prompts, events, normal
  logs, project files, command arguments, or crash reports.
- **Security claims are capability-specific.** Permission checks, process
  sandboxing, network restriction, credential isolation, and whole-process
  containment are described separately and fail visibly when unavailable.
- **Compatibility is earned by conformance.** A provider or model is supported
  only when its adapter reports capabilities and passes the matching contract
  suite. Entering an arbitrary endpoint and key does not create compatibility.
- **Recovery does not regenerate history.** Robin replays completed provider and
  tool observations. It never repeats a model call or an external effect merely
  to rebuild a projection.

## 2. System context and trust boundaries

```text
Developer and terminal
        |
        v
Robin CLI parser and terminal UI
        |
        v
Robin application service
  session coordinator | command handlers | event subscription
        |
        +----------------------+-----------------------+
        |                      |                       |
        v                      v                       v
Direct-model agent loop   Local session store    Extension manager
prompt compiler           framed event log       instructions/skills
provider port             snapshots and CAS      hooks/MCP/subagents
        |                      |                       |
        +-----------+----------+-----------+-----------+
                    |                      |
                    v                      v
          Tool and permission pipeline   Configuration/trust/credentials
          workspace/process/Git          platform credential adapter
                    |
                    v
          Existing @guard enforcement substrate
          contracts | policy | context | capability | runtime facts
                    |
          +---------+---------+
          |                   |
          v                   v
   Local OS and Git      Model provider API
```

The trusted computing base is deliberately smaller than the complete process:

- trusted code: CLI bootstrap, application coordinator, event validation,
  session storage, prompt compiler, provider adapters, tool registry,
  permission engine, path boundary, process supervisor, Git adapter,
  credential resolver, and selected platform adapters;
- untrusted content: repository files, repository instructions, model output,
  tool output, compiler and test output, Git metadata containing user-controlled
  text, skill bodies, MCP responses, hook output, and remote error bodies;
- conditionally trusted executable extensions: locally installed hooks, MCP
  servers, and provider plugins only after explicit installation and trust;
- external principals: model providers, remote MCP servers, package registries,
  Git remotes, proxies, telemetry endpoints, and any process contacted by an
  allowed command.

Untrusted content may influence a model proposal. It cannot directly invoke a
tool, change permission policy, select credentials, weaken a sandbox, alter a
provider endpoint, or modify durable session records.

## 3. Layering and package boundaries

### 3.1 Dependency rule

Dependencies point inward toward contracts and pure domain logic. Adapters may
depend on ports; ports never depend on adapters. The terminal renderer never
imports a provider SDK. A provider adapter never imports workspace execution.
Tool handlers never write UI output. Persistence never asks a model to repair
corrupt state.

The allowed dependency direction is:

```text
apps/cli
  -> robin-application, robin-terminal
     -> robin-session, robin-agent
        -> robin-prompt, model-provider, robin-tools, robin-permissions
           -> local-state, robin-config, robin-platform
              -> selected @guard contracts/enforcement packages
```

Cross-cutting observability is injected through a narrow sink interface. It
does not become a global singleton imported from every package.

### 3.2 Target package map

The following are target physical package boundaries. New package names remain
private workspace implementation details until a public SDK is deliberately
versioned. Existing `@guard/*` package names stay in place during the pivot to
avoid mixing product work with a fixture-breaking namespace migration.

| Physical package | Responsibility | Must not own |
| --- | --- | --- |
| `apps/cli` | Executable bootstrap, argument parsing, stdio/TTY detection, signal wiring, top-level exit mapping | Agent decisions, provider SDK calls, filesystem mutation |
| `packages/robin-application` | Use cases such as start, submit, resume, cancel, inspect, export, and close; dependency composition; canonical event subscription | Terminal escape sequences, provider wire formats, direct OS calls |
| `packages/robin-terminal` | Pure UI reducer, input editor integration, render model, ANSI renderer, plain renderer, approval and picker interactions | Durable truth, tool authorization, session storage |
| `packages/robin-session` | Session/turn/invocation/tool state machines, normalized event schemas, replay projection, compatibility migrations | Concrete files, provider transport, terminal behavior |
| `packages/robin-agent` | Direct-model loop, prompt scheduling, tool-result feedback, turn budgets, completion semantics | Provider-specific JSON, shell execution, UI prompts |
| `packages/robin-prompt` | Instruction resolution, context selection, token budgeting, transcript compaction, provider-neutral request assembly | Credential resolution, tool execution, terminal rendering |
| `packages/model-provider` | Provider-neutral port, normalized streaming events, capability manifests, synthetic adapter, conformance harness | Session policy, repository access, UI output |
| `packages/provider-openai` | OpenAI transport, authentication binding, request/event translation, error classification | Agent loop and permissions |
| `packages/provider-anthropic` | Anthropic transport, authentication binding, request/event translation, error classification | Agent loop and permissions |
| `packages/provider-openai-compatible` | Explicitly bounded compatibility profile for endpoints that implement the tested subset | Guessing unsupported semantics or silently emulating required features |
| `packages/robin-tools` | Tool definition contract, registry, schema validation, semantic normalization, result normalization, dispatch pipeline | Concrete repository/process/Git semantics |
| `packages/tool-workspace` | Real workspace discovery, file metadata, bounded list/search/read, structural patching, edit journal | General shell commands, Git history writes |
| `packages/tool-process` | Process spawning, environment construction, output capture, PTY option, cancellation, sandbox adapter integration | Parsing model prose into commands |
| `packages/tool-git` | Repository/worktree identity, porcelain status, diff, log, commit preparation and approved Git writes | General filesystem recovery or hidden reset/clean behavior |
| `packages/robin-permissions` | User permission modes, normalized approval scopes, rule matching, decision explanations, session grants | Terminal prompting, raw provider calls, direct effect execution |
| `packages/local-state` | Framed event log, snapshots, content-addressed blobs, locks, atomic indexes, migrations, recovery, garbage collection | Business decisions, provider retries, prompt assembly |
| `packages/robin-config` | Typed configuration schema, source precedence, project trust, instruction discovery, safe diagnostics | Secret bytes, OS-specific keychain calls |
| `packages/robin-extensions` | Hook, skill, MCP, and subagent manifests; lifecycle coordination; namespace and trust validation | Unmediated process execution or automatic credential delegation |
| `packages/robin-platform` | Filesystem paths, credential store port, process/signal primitives, sandbox probes, terminal capabilities, OS adapters | Product policy or model behavior |
| `packages/robin-observability` | Structured diagnostic events, redaction, local logs, metrics aggregation, opt-in telemetry export | Durable session authority or secrets |

### 3.3 Existing package disposition

| Existing package | Robin use | Required change before production use |
| --- | --- | --- |
| `@guard/contracts` | Canonical JSON, branded identifiers, errors, event envelope foundations | Add Robin session identifiers and schemas without renaming the package |
| `@guard/event-store` | In-memory test adapter and event-store port concepts | Local framed store uses Robin-specific append, recovery, and lock semantics |
| `@guard/model-provider` | Provider-neutral request/event foundation and synthetic provider | Expand for streaming tool calls, continuation data, cancellation, error taxonomy, and conformance |
| `@guard/agent-driver` | Scripted test driver and normalized agent observation concepts | Direct-model loop moves into Robin agent package; external drivers remain optional adapters |
| `@guard/policy-language` and `@guard/policy-engine` | Advanced policy evaluation and explainability | Add a simple product permission layer that compiles common modes into normalized decisions |
| `@guard/context-broker` | Classification and context-release enforcement | Integrate behind prompt/context assembly; do not require users to configure it for ordinary workspace reads |
| `@guard/capability-gateway` | Structural validation, semantic normalization, policy decision, one-use dispatch, released views | Adapt tool definitions and async execution lifecycle to real coding operations |
| `@guard/capability-repository` | Deterministic virtual repository fixtures and path-policy test corpus | Retain for tests; real workspace behavior belongs in `tool-workspace` |
| `@guard/runtime` and `@guard/runtime-host` | Pure reducer patterns, normalized execution facts, deterministic scenario evidence | Do not model an entire interactive session as one legacy run; reuse facts around bounded agent/tool executions |
| `@guard/profile-registry` | Pinned component and schema validation concepts | Replace fixture profile selection in the default CLI with provider/model/tool/session configuration |
| milestone scenario packages | Regression evidence for the substrate | Keep out of the default user journey and product demonstration |

The `@guard` namespace is not shown in Robin onboarding, ordinary help, status
lines, or session terminology. It may appear in developer documentation and
stack traces until an independently reviewed namespace migration is justified.

### 3.4 Import and construction constraints

- `apps/cli` constructs adapters in a composition root and passes interfaces to
  application services.
- Domain packages receive `Clock`, `IdSource`, `ByteSizer`, and `DiagnosticSink`
  dependencies rather than calling global time, randomness, encoding, or logs.
- Provider packages receive an injected HTTP transport so contract tests do not
  require network access.
- Tool packages receive a `WorkspaceHandle` created by trusted discovery; a
  model-provided path can never instantiate one.
- The local store receives an injected filesystem and lock backend for
  crash-injection tests.
- No package reads `process.env` except the CLI composition root and the
  platform credential/environment adapter.
- No package writes `stdout` or `stderr` except a selected renderer owned by the
  CLI surface.
- All boundary values are parsed from `unknown`, reject unknown fields unless a
  versioned schema explicitly permits them, and are captured as immutable
  values before asynchronous work begins.

## 4. Entry modes and application use cases

### 4.1 Command classification

Argument parsing happens before workspace discovery or provider initialization.
The parser produces one of these typed requests:

```ts
type RobinCliRequest =
  | { kind: "interactive"; initialPrompt: string | null; options: SessionOptions }
  | { kind: "print"; prompt: string; stdin: Uint8Array | null; options: PrintOptions }
  | { kind: "continue"; options: ResumeOptions }
  | { kind: "resume"; selector: string | null; options: ResumeOptions }
  | { kind: "sessions"; command: SessionAdminCommand }
  | { kind: "auth"; command: AuthCommand }
  | { kind: "models"; command: ModelCommand }
  | { kind: "config"; command: ConfigCommand }
  | { kind: "doctor"; command: DoctorCommand }
  | { kind: "support"; command: SupportCommand }
  | { kind: "policy"; command: PolicyCommand }
  | { kind: "mcp"; command: McpCommand }
  | { kind: "help"; commandPath: readonly string[] }
  | { kind: "version"; format: "human" | "json" };
```

The target public vocabulary is fixed independently of temporary candidate
spelling:

```ts
type PermissionMode = "default" | "plan" | "accept-edits" | "locked" | "bypass";
type HeadlessOutput = "text" | "json" | "stream-json";
```

`headless` is a surface selected by `--print`; it is not a permission mode.
The target flags are `--output <text|json|stream-json>` and `--no-session`.
The R1 candidate currently accepts `ask`, `--output-format`, and `--no-save`;
these are implementation-candidate shims, not stable aliases.
Before the public command snapshot, `ask` maps to `default`,
`--output-format` becomes `--output`, and `--no-save` becomes `--no-session`.
Help, parser snapshots, completion data, and examples must expose only the
target spellings once that migration lands.

Reserved command names are matched before treating positional text as a
prompt. A close miss such as `robin sesions` produces an unknown-command
diagnostic with a suggestion; it is not sent to the model. The delimiter `--`
ends Robin option parsing when prompt text begins with a hyphen.

### 4.2 Interactive entry

`robin` and `robin "prompt"` call `startInteractiveSession`. The use case:

1. probes terminal capabilities without changing terminal mode;
2. discovers and validates the workspace;
3. loads trusted user configuration;
4. discovers project configuration and instructions as untrusted candidates;
5. resolves or asks for project trust before applying project-controlled
   executable settings;
6. resolves provider/model metadata without resolving secret bytes;
7. creates or opens the durable session under an exclusive writer lock;
8. persists `SessionOpened` and the pinned effective configuration;
9. starts the terminal controller and event subscription;
10. submits an initial prompt only after the UI can display provider and tool
    activity.

Interactive mode requires a TTY for cursor-addressed rendering. When stdin or
stdout is redirected, Robin chooses the plain streaming renderer and requires
an explicit prompt or resumes a session without enabling raw input mode.

### 4.3 Headless print surface

`robin --print "prompt"` invokes the same `submitTurn` service and direct-model
loop. Headless execution is a presentation and input surface, not an alternate
agent, session, or permission mode. It differs only in interaction policy and
rendering:

- no permission prompt may block on unavailable input;
- ask decisions become deterministic denials unless a predeclared allow rule
  covers the exact normalized scope;
- stdout carries only the selected output contract;
- diagnostics and progress go to stderr unless JSON Lines mode explicitly
  carries them as typed records;
- structured output is validated before exit when a schema is supplied;
- stable exit codes distinguish usage/configuration, permission denial, budget,
  task, provider/infrastructure, cancellation, and corrupt local state.

`--output text` emits only the final assistant result on stdout,
`--output json` emits one versioned final envelope, and
`--output stream-json` emits versioned JSON Lines application events.
`--no-session` disables durable conversation creation and therefore disables
continue, resume, and crash recovery for that invocation. It does not suppress
minimum operational evidence that an applicable managed policy requires; when
that requirement conflicts with no-session operation, Robin refuses to start
and explains the conflict.

Piped stdin is captured with a configured byte and time bound, persisted as an
untrusted user attachment, and delimited separately from the user's prompt. It
never becomes a system instruction.

### 4.4 Resume and continue

`--continue` resolves the newest resumable session whose physical workspace
identity matches the current workspace. `--resume` resolves an exact ID, exact
name, or interactive picker selection. Resolution never falls back to a session
from a different workspace without a displayed `--workspace` override.

Resume performs these checks before accepting new input:

- event log integrity and supported schema versions;
- exclusive writer lock acquisition;
- workspace physical identity, current Git common directory, and worktree;
- current branch/HEAD and dirty-state comparison with the last checkpoint;
- effective configuration changes and whether the prior provider/model remains
  available;
- credential reference availability without reading secret bytes into the
  projection;
- unfinished model or tool operations and their recovery classification;
- extension manifest changes, revoked trust, and missing skills or MCP servers.

Safe changes are reported and adopted through a new configuration snapshot.
Changes that invalidate continuity require an explicit fork. Corrupt middle
frames, uncertain consequential effects, or a workspace identity mismatch do
not auto-resume.

### 4.5 Administrative entry modes

Administrative commands do not start a model session unless their contract
explicitly performs a labeled provider validation request:

- `robin sessions` reads indexes and session metadata under shared/read locks;
  delete moves a session to recoverable trash before later garbage collection;
- `robin auth` operates through credential references and redacts provider
  responses;
- `robin models` reads declared/discovered capability manifests and cached probe
  data;
- `robin config` parses, explains precedence, validates, and atomically edits
  non-secret settings;
- `robin doctor` performs read-only probes by default and labels every optional
  network or mutation probe before running it;
- `robin support bundle --dry-run` computes the exact local bundle inventory,
  exclusions, redactions, and byte totals without creating an archive or
  uploading anything; `robin support bundle` creates the reviewed local
  artifact but never uploads it automatically;
- `robin policy` remains the advanced policy debugger;
- `robin mcp` manages server records, trust, capability snapshots, and
  diagnostics.

## 5. Session, turn, invocation, and tool model

### 5.1 Identity hierarchy

Robin uses distinct identifiers for distinct recovery and UX units:

```text
SessionId
  TurnId
    ModelInvocationId
      ProviderAttemptId
    ToolCallId
      PermissionDecisionId
      ToolExecutionId
```

- A **session** is the durable developer conversation associated with one
  workspace identity and a sequence of pinned configuration snapshots.
- A **turn** begins with one accepted developer submission and ends with one
  assistant final result, failure, interruption, or cancellation.
- A **model invocation** is one request/stream exchange. A turn commonly has
  several invocations because tool results are returned to the model.
- A **provider attempt** is one network attempt for an invocation. It exists so
  transport retry evidence is not confused with a new model decision.
- A **tool call** is one complete normalized proposal emitted by the model.
- A **permission decision** binds a rule or user approval to an exact normalized
  request and preconditions.
- A **tool execution** is one dispatch attempt. A new execution ID is mandatory
  for an explicit retry.

Legacy `RunId` values from `@guard/runtime` may be attached to a tool workflow
or bounded internal agent execution. They do not replace `SessionId` or
`TurnId` in the product model.

### 5.2 Session state

The durable session reducer has these states:

```text
new -> opening -> ready <-> turn_active -> closing -> closed
                   |             |
                   |             +-> recovery_required
                   +----------------> recovery_required
recovery_required -> ready | forked | quarantined
```

`ready` means the session can accept a user submission. `turn_active` means one
foreground turn owns mutation authority. A session may retain completed turns
while a background read-only subagent exists in a later milestone, but only the
foreground coordinator may accept user input and authorize workspace mutation.

`closed` is a clean application-level closure, not deletion. `quarantined`
means integrity cannot be established. `forked` is terminal for that writer;
the new session records the parent session and fork point.

### 5.3 Turn state

Robin does not persist every interaction phase as a turn status. Interaction
phases are transient coordinator/UI facts that may recur within one turn:

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

`cancelling` may temporarily replace any active interaction phase while child
operations settle. These phase names drive status text, progress, scheduling,
and legal coordinator transitions. They are emitted as application progress
facts when useful, but replay does not require the original phase cadence.

The durable projection exposes a smaller `PersistedTurnStatus` derived only
from committed semantic events:

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

`UserSubmissionAccepted` projects `accepted`; `TurnStarted` projects `active`;
`TurnCancellationRequested` projects `cancellation_requested`; and exactly one
terminal event projects `interrupted`, `cancelled`, `failed`,
`provider_result_uncertain`, `recovery_required`, or `completed`. A crash while
the last committed status is nonterminal does not fabricate the transient phase
that was visible before the crash. Recovery inspects prepared/started/settled
provider and effect records, then appends the event that yields a safe status.

`interrupted` means user-directed pause with a resumable transcript and no
active external operation. `cancelled` means an active operation received
cancellation and reached a classified outcome. `failed` means no unresolved
effect remains. `provider_result_uncertain` means provider acceptance or result
cannot be proved. `recovery_required` means Robin cannot safely infer whether a
consequential effect or durable append completed. Interaction phases may change
many times while persisted status remains `active`; the two vocabularies must
never be serialized into each other's fields.

Only one foreground turn is active per session in the initial architecture.
A follow-up typed while the agent is working becomes either a queued steering
message or an explicit interrupt-and-submit action; the UI never silently
injects it into a provider request already in flight.

### 5.4 Configuration pinning across a session

A session contains immutable `ConfigurationSnapshot` records. Each turn pins
one snapshot containing safe hashes and identifiers for provider, exact model,
tool registry, permission policy, trusted project configuration, instructions,
skills, hooks, MCP servers, sandbox capability, context budget, and Robin build.

A setting changed between turns produces a new snapshot. R4 does not switch
providers automatically. R7 permits an explicit provider/model switch only
after the current turn is terminal and no effect is unsettled. The switch pins
a new snapshot and either preserves the semantic transcript, creates an
inspectable compaction boundary, or forks the session when continuation data
cannot be translated safely.

## 6. Canonical events and normalized streaming

### 6.1 Three event planes and UI input

Robin separates three event planes instead of treating a provider chunk, an
application notification, and a durable fact as interchangeable:

1. **Live agent events** are bounded, in-process observations from the agent
   loop, provider collector, tool pipeline, and process supervisor. They include
   deltas and transient phases. They may be coalesced or dropped only according
   to their declared delivery class.
2. **Application events** are the versioned, provider-neutral contract consumed
   by terminal, text, JSON, daemon, and future editor surfaces. The application
   maps live observations and committed facts into this contract; a renderer
   cannot consume an adapter callback directly.
3. **Canonical durable events** are validated, framed, hash-chained semantic
   records used for replay, recovery, and audit. High-rate chunk timing is not
   durable authority. Complete semantic content is sealed into CAS-backed
   durable events.

UI input events such as keystrokes, resize, focus, animation ticks, and local
picker movement form a separate reducer input vocabulary. They are neither
application facts nor session authority.

The R1 application journal assigns a positive monotonic in-memory `sequence` to
validate append and replay order. It is erased at process exit and is not a
durable `SessionSequence`. In the target durable model, only canonical durable
events receive monotonic per-session sequence numbers from the store.
Application events that report a committed fact carry that durable sequence;
live-only application events carry an explicit live ordering key and no durable
sequence. Wall-clock timestamps are informative. Durable order comes from
sequence and causation, and live order comes from the bounded producer stream.

### 6.2 Durable envelope

```ts
interface SessionEventEnvelope<TType extends string, TPayload> {
  readonly schemaVersion: 1;
  readonly sessionId: SessionId;
  readonly sequence: SessionSequence;
  readonly eventId: EventId;
  readonly eventType: TType;
  readonly recordedAt: string;
  readonly turnId: TurnId | null;
  readonly causationId: EventId | null;
  readonly correlationId: string;
  readonly configurationSnapshotId: string;
  readonly payload: Readonly<TPayload>;
}
```

`SessionSequence` is an unsigned 64-bit domain value represented as a canonical
decimal string in JSON and as an unsigned 64-bit integer in the binary frame.
It is never serialized as a JavaScript `number` or `bigint` JSON value.

The store computes frame integrity independently of the JSON envelope. Payloads
contain content hashes and CAS references for large content. Unknown event
types or schema versions do not enter the reducer until a registered migration
or forward-compatible projection explicitly handles them.

### 6.3 Required durable event families

Session and configuration:

- `SessionCreated`, `SessionOpened`, `SessionRenamed`, `SessionClosed`;
- `WorkspaceBound`, `WorkspaceStateObserved`, `ConfigurationPinned`;
- `TrustGranted`, `TrustRevoked`, `SessionForked`;
- `RecoveryStarted`, `TailRepaired`, `RecoveryCompleted`, `SessionQuarantined`.

User and turn:

- `UserSubmissionAccepted`, `UserAttachmentStored`, `SteeringQueued`;
- `TurnStarted`, `ContextAssemblyCompleted`, `TurnInterrupted`;
- `TurnCancellationRequested`, `TurnCancelled`, `TurnFailed`, `TurnCompleted`;
- `AssistantMessageSealed`, `TurnSummarySealed`.

Provider:

- `ModelInvocationPrepared`, `ProviderRequestRecorded`;
- `ProviderAttemptStarted`, `ProviderResponseStarted`;
- `ProviderContentSealed`, `ProviderToolCallSealed`, `ProviderUsageRecorded`;
- `ProviderAttemptFailed`, `ModelInvocationCompleted`,
  `ModelInvocationOutcomeUncertain`.

Tool and permission:

- `ToolCallReceived`, `ToolCallRejected`, `ToolCallNormalized`;
- `PermissionEvaluated`, `ApprovalRequested`, `ApprovalResponded`;
- `ToolExecutionPrepared`, `ToolExecutionStarted`, `ToolOutputSealed`;
- `ToolExecutionCompleted`, `ToolExecutionFailed`,
  `ToolExecutionOutcomeUncertain`;
- `WorkspaceCheckpointRecorded`, `ChangedPathManifestRecorded`.

Extension and maintenance:

- `HookPrepared`, `HookCompleted`, `HookFailed`;
- `McpCapabilitySnapshotPinned`, `SubagentStarted`, `SubagentCompleted`;
- `SnapshotWritten`, `CompactionRecorded`, `CasObjectReleased`.

An event name is not sufficient evidence that its feature is implemented.
Acceptance requires schema, parser, reducer transition, persistence/replay test,
and at least one integration test for the behavior it represents.

### 6.4 Live event vocabulary

```ts
type RobinLiveEvent =
  | { type: "assistant_text_delta"; invocationId: string; text: string }
  | { type: "provider_status"; invocationId: string; phase: ProviderPhase }
  | { type: "tool_call_delta"; invocationId: string; callId: string; bytes: Uint8Array }
  | { type: "tool_status"; callId: string; phase: ToolPhase; label: string }
  | { type: "process_stdout"; executionId: string; chunk: Uint8Array }
  | { type: "process_stderr"; executionId: string; chunk: Uint8Array }
  | { type: "permission_waiting"; decisionId: string; summary: ApprovalSummary }
  | { type: "usage_update"; invocationId: string; usage: PartialUsage }
  | { type: "backpressure"; source: string; queuedBytes: number }
  | { type: "diagnostic"; diagnostic: SafeDiagnostic };
```

Live tool argument bytes are not parsed into executable input until the
provider emits a completed tool-call boundary. The accumulator enforces a byte
limit and rejects duplicate completion, invalid UTF-8 where JSON is required,
and conflicting call IDs.

### 6.5 Agent-to-application-to-durable mapping

The application owns every cross-plane mapping. A mapping may be one-to-one,
many-to-one after sealing, or live-only. It is never inferred by a renderer.
The minimum mapping is:

| Live agent or subsystem observation | Application event(s) | Canonical durable event(s) | Mapping rule |
| --- | --- | --- | --- |
| accepted user/turn-start observation | `TurnQueued`, then progress events for context compilation | `UserSubmissionAccepted`, `TurnStarted` | The application emits start only after user acceptance is committed. |
| `assistant_text_delta` / provider `content_delta` | `ProviderTextDelta` | none per delta; later `ProviderContentSealed` and `AssistantMessageSealed` | Deltas are bounded live data. Completion or classified interruption seals exact available bytes and hashes before terminal turn state. |
| provider tool-name/argument fragments | optional bounded tool-progress event | none per fragment | Fragments remain inert and cannot enter permission or execution. |
| completed normalized provider tool call | `ProviderToolCallCompleted`, then `ToolRequestNormalized` | `ProviderToolCallSealed`, `ToolCallReceived`, then `ToolCallNormalized` | IDs and complete bytes are sealed before normalization; schema or semantic failure maps to `ToolCallRejected`. |
| permission evaluation or user response | `PermissionDecided`, `ApprovalRequested`, `ApprovalResolved` | `PermissionEvaluated`, `ApprovalRequested`, `ApprovalResponded` | An approval UI event is emitted from the committed request, and execution cannot start until the committed response is bound to current preconditions. |
| `tool_status` / execution lifecycle | `ToolExecutionStarted`, `ToolOutputDelta`, `ToolExecutionCompleted` or `ToolExecutionFailed` | `ToolExecutionPrepared`, `ToolExecutionStarted`, `ToolOutputSealed`, then one settled event | Output deltas are live; hashes, retention facts, exit/effect facts, and the released observation are durable. |
| `process_stdout` / `process_stderr` | `ToolOutputDelta` | none per chunk; later `ToolOutputSealed` | Machine and terminal renderers receive escaped bounded chunks; replay reads the sealed artifact rather than reconstructing chunk timing. |
| `usage_reported` / provider `usage` | `ProviderUsageReported` | `ProviderUsageRecorded` | Cumulative values must be monotonic; deltas are normalized before the durable total or explicitly partial snapshot is appended. |
| turn-completed observation | `AssistantMessageCompleted`, `TurnCompleted` | `AssistantMessageSealed`, `TurnCompleted` | The final application event cannot precede assistant sealing and the terminal durable append. |
| `turn_failed` | `TurnFailed` | `TurnFailed` plus the relevant provider/tool failure event | Safe category and diagnostic are mapped; raw thrown objects never cross the application boundary. |
| `turn_cancelled` | `TurnCancelled` | `TurnCancellationRequested`, then `TurnCancelled` | Cancellation becomes terminal only after owned operations settle or reach a classified bounded outcome. |
| `backpressure` or transient provider/tool phase | progress/diagnostic application event | none unless it changes semantic outcome | A surface may coalesce these; a terminal consequence such as truncation or budget failure is persisted separately. |

The current CLI uses `R1RobinApplication`, not the retained
`EphemeralRobinApplication` / `RobinAgentEvent` direct-live seam. Its
schema-version-1 journal records `SessionStarted`, accepted/queued messages,
turn and assistant deltas, tool start/completion/failure, usage/budget,
cancellation, terminal turn, and session-close events. Each append is parsed and
reduced before publication; a subscriber first receives any requested journal
suffix and then follows live appends. Prefix-replay tests keep the projection and
live view equivalent. Historical replay is an indexed cursor rather than a
copied backlog. The implemented defaults bound one journal to 131,072 records
and 134,217,728 serialized UTF-8 bytes, plus 32 subscribers with 8,192 unread
live events and 16,777,216 unread live bytes each. Iterator return releases both
replay and live references. Terminal headroom is reserved before admitting
nonterminal events so accepted active and queued turns can still receive a
terminal event. Foreground admission stages `UserMessageAccepted` and
`TurnStarted` as one batch before mutating in-memory active state; failed new
admission leaves no active/queued work. Once work is admitted, an authoritative
append failure faults the application and all streams rather than publishing an
unrecorded state change. The legacy direct-live class remains only for
compatibility coverage.

The table above remains the target mapping for the fuller durable vocabulary.
R3 adds that durable side without changing renderer semantics. Tests must
independently assert coordinator ordering, application mapping, durable append
ordering, and replayed application views so an accidental direct pass-through
cannot return.

### 6.6 Stream sealing and replay

Assistant text deltas are rendered immediately and accumulated in a bounded
spool. On provider completion or classified interruption, Robin stores the
exact available bytes in CAS and appends `ProviderContentSealed` with the hash,
length, modality, completion status, and provider item identity. Replay emits a
synthetic sealed-content view rather than reproducing original chunk timing.

Process output follows the same pattern. The renderer receives live bounded
chunks; the session log receives hashes, byte counts, truncation facts, exit
facts, and references to retained output according to the configured retention
policy. A crashed renderer therefore cannot erase evidence, and replay does not
need every original terminal chunk.

## 7. Interactive terminal architecture

### 7.1 Controller, reducer, and renderer

The terminal surface follows an Elm-style boundary:

```text
terminal bytes / application events / timer / resize
                      |
                      v
                decode UiEvent
                      |
                      v
       reduce(UiState, UiEvent) -> UiState + UiEffect[]
                      |                       |
                      v                       v
               derive RenderModel      effect interpreter
                      |                submit/cancel/approve
                      v
        ANSI renderer or plain renderer
```

`reduce` is pure. It neither writes terminal bytes nor calls application
services. `UiEffect` values are interpreted by a controller that returns
application events to the reducer. This makes input, rendering, approval, and
race behavior deterministic under tests.

### 7.2 UI state

```ts
interface UiState {
  readonly mode: "booting" | "ready" | "working" | "approval" | "picker" | "closing" | "fatal";
  readonly terminal: TerminalCapabilities;
  readonly viewport: { readonly columns: number; readonly rows: number };
  readonly input: InputEditorState;
  readonly transcript: readonly TranscriptRow[];
  readonly activeTurn: ActiveTurnView | null;
  readonly approval: ApprovalView | null;
  readonly overlay: OverlayView | null;
  readonly status: StatusLineView;
  readonly queuedSteering: readonly SteeringView[];
  readonly notices: readonly NoticeView[];
  readonly renderRevision: number;
}
```

The transcript stores bounded render rows and references older sealed messages
through the session query service. It does not duplicate the full durable
session in memory. The input editor owns grapheme-aware cursor movement,
multiline editing, bracketed paste, history search, and optional Vim bindings.
Secret entry uses a separate state that never enters history or transcript.

### 7.3 UI events and effects

Input events include printable text, grapheme deletion, cursor movement,
submit, newline, bracketed paste, history traversal, command-menu selection,
escape, interrupt, end-of-input, and resize. Application events include sealed
user input, assistant deltas, tool phases, permission requests, process output,
turn terminal state, safe diagnostics, and session closure.

The reducer may emit only these effect categories:

- submit a user message;
- queue or remove steering;
- request cancellation;
- answer an approval with an exact scope and persistence choice;
- execute a local UI command such as opening help or selecting a session;
- request older transcript rows;
- copy displayed non-secret content after explicit user input;
- close the surface cleanly.

The UI cannot emit a raw tool execution effect.

### 7.4 Rendering behavior

The ANSI renderer uses a retained render model and computes minimal line-level
updates. It enables raw mode, bracketed paste, and cursor hiding only inside a
`try/finally` lifecycle. Cleanup restores terminal modes on normal exit,
uncaught application failure, and handled signals. A final emergency restore
sequence is registered at bootstrap, but it does not attempt asynchronous
session writes.

The plain renderer emits append-only UTF-8 lines and never relies on cursor
movement. JSON Lines mode emits versioned objects and no ANSI bytes. Human
progress goes to stderr on the headless surface so stdout remains pipe-safe.

Rendering is throttled independently from event ingestion. Assistant and
process deltas may be coalesced for at most one render frame; permission
requests, errors, and terminal transitions bypass throttling. Coalescing never
changes sealed durable content.

### 7.5 Approval interaction

An approval view displays:

- normalized tool and operation;
- exact paths, command, working directory, hosts, or Git mutation involved;
- observed preconditions such as file hashes and HEAD;
- side-effect class and sandbox/network facts;
- why the current rule requires approval;
- choices for deny, allow once, allow for the exact turn scope, or add an
  eligible persistent rule;
- the location and precedence of any persistent rule before it is written.

Keys are inactive until the complete approval record has rendered. Resize or
incoming process output cannot change the `PermissionDecisionId` bound to a
choice. The controller submits the displayed decision ID and normalized request
hash; the permission service rejects a stale or mismatched response.

### 7.6 Interrupt semantics

The first `Ctrl-C` while input is idle clears a non-empty composer or requests
a clean session close when it is already empty. During a turn it requests
structured cancellation and changes the UI to `cancelling`. A second `Ctrl-C`
within the configured escalation window requests forceful child-process
termination but still attempts to seal available output. A third signal exits
the UI after synchronous terminal restoration and leaves recovery evidence for
the next open.

`Ctrl-D` submits end-of-input only when the composer is empty. It never approves
a pending action. Terminal suspension and resume are platform-adapter features;
on resume Robin reprobes dimensions and redraws from the retained render model.

### 7.7 Local commands, shell shortcut, and attachments

An input beginning with an unescaped slash is parsed by the local command
router before submission. Initial commands include help, status, model,
permissions, plan, context, usage, compact, diff, sessions, rename, clear-screen,
and exit. Commands call typed application use cases; their text is not sent to
the provider as a user message. An unknown slash command shows suggestions and
requires explicit escape/send to become prompt text.

An interactive shell shortcut beginning with `!` is syntactic sugar for a
normal `shell` tool request attributed to the user. It still passes workspace
normalization, permission rules, process supervision, sandbox reporting,
durable execution events, and cancellation. User attribution may change which
permission rule applies, but it does not bypass the process boundary.

An `@path` attachment token opens a picker/resolver through the workspace read
tool. The UI shows resolved paths and byte/token estimates before submit.
Attachment content is hashed, durably referenced, delimited as untrusted user
context, and revalidated if the file changes before provider serialization.
Pasted text that happens to contain slash, bang, or at-sign prefixes is ordinary
text unless the input editor records an explicit command/attachment action.

### 7.8 Accessibility and transcript integrity

Status is conveyed by text and symbols, never color alone. Motion can be
disabled. Screen-reader/plain mode uses append-only semantic announcements and
does not redraw prior lines. Approval choices include full textual scope and
single-key alternatives with confirmation where ambiguity exists.

Terminal escape and control bytes from model, process, Git, hook, or MCP output
are escaped before rendering. Hyperlinks are emitted only for locally generated
safe targets. Copy actions use the sealed semantic content, not terminal control
sequences.

## 8. Direct-model agent loop

### 8.1 Responsibilities

The direct-model loop is the core coding-agent engine. It owns turn scheduling,
prompt assembly requests, provider invocations, normalized stream consumption,
tool-call sequencing, tool-result feedback, budget accounting, and final
completion. It does not own terminal prompts, provider wire formats, concrete
tool effects, or local storage format.

### 8.2 State machine

```text
IDLE
  -> ACCEPTING_USER_INPUT
  -> ASSEMBLING_PROMPT
  -> PREPARING_INVOCATION
  -> STREAMING_PROVIDER
       -> SEALING_ASSISTANT_CONTENT
       -> VALIDATING_TOOL_CALL
       -> WAITING_FOR_PERMISSION
       -> EXECUTING_TOOL
       -> SEALING_TOOL_RESULT
       -> ASSEMBLING_PROMPT
  -> FINALIZING_TURN
  -> IDLE

Every active state can enter CANCELLING.
CANCELLING enters IDLE only after a classified terminal turn event.
An uncertain provider or tool outcome enters RECOVERY_REQUIRED.
```

Provider text and one or more tool calls may appear in a response. Robin seals
the text in provider order. In the initial release it rejects or queues multiple
consequential tool calls and executes them one at a time in provider order.
Read-only calls may still be serialized so transcript and permission semantics
remain unambiguous. Parallel read execution is a later capability flag with
separate tests.

### 8.3 Loop pseudocode

```ts
async function runTurn(input: RunTurnInput): Promise<TurnTerminalResult> {
  const turn = await input.sessions.acceptUserSubmission(input.submission);
  const budget = input.budgets.createTurnBudget(turn.configurationSnapshot);
  let transcriptCursor = turn.initialTranscriptCursor;

  try {
    while (true) {
      input.cancellation.throwIfRequested();
      budget.assertInvocationAvailable();

      const promptPlan = await input.prompts.assemble({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        transcriptCursor,
        configurationSnapshot: turn.configurationSnapshot,
        remainingBudget: budget.remaining(),
        signal: input.cancellation.signal,
      });

      const invocation = await input.sessions.prepareModelInvocation({
        turnId: turn.turnId,
        promptPlan,
        providerProfile: turn.providerProfile,
        modelProfile: turn.modelProfile,
      });

      const providerStream = input.provider.invoke(
        invocation.request,
        input.credentials.reference(turn.providerProfile.credentialRef),
        input.cancellation.signal,
      );

      const response = await consumeProviderStream({
        invocation,
        providerStream,
        sessions: input.sessions,
        liveEvents: input.liveEvents,
        limits: turn.configurationSnapshot.streamLimits,
        budget,
        signal: input.cancellation.signal,
      });

      await input.sessions.completeModelInvocation(response.completion);
      budget.recordUsage(response.usage);
      transcriptCursor = response.transcriptCursor;

      if (response.toolCalls.length === 0) {
        const finalMessage = response.requireFinalAssistantMessage();
        return await input.sessions.completeTurn({
          turnId: turn.turnId,
          finalMessage,
          usage: budget.snapshot(),
          changedPaths: await input.tools.changedPathManifest(turn.turnId),
          verification: await input.tools.verificationManifest(turn.turnId),
        });
      }

      for (const sealedCall of response.toolCalls) {
        input.cancellation.throwIfRequested();
        budget.assertToolCallAvailable();

        const normalized = await input.tools.validateAndNormalize({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          sealedCall,
          workspace: turn.workspace,
          signal: input.cancellation.signal,
        });

        const decision = await input.permissions.evaluate({
          normalizedCall: normalized,
          permissionSnapshot: turn.permissionSnapshot,
          observedWorkspaceState: await input.tools.observePreconditions(normalized),
          interaction: input.interaction,
          signal: input.cancellation.signal,
        });

        if (decision.effect === "deny") {
          const denied = await input.tools.recordDenial(normalized, decision);
          transcriptCursor = denied.transcriptCursor;
          continue;
        }

        const prepared = await input.tools.prepareExecution(normalized, decision);
        const result = await input.tools.executePrepared(
          prepared,
          input.cancellation.signal,
        );
        budget.recordToolResult(result.accounting);
        transcriptCursor = result.transcriptCursor;
      }
    }
  } catch (error) {
    const classified = input.failures.classify(error);
    if (classified.outcome === "cancelled") {
      return await input.sessions.cancelTurn(turn.turnId, classified);
    }
    if (classified.outcome === "recovery_required") {
      return await input.sessions.requireRecovery(turn.turnId, classified);
    }
    return await input.sessions.failTurn(turn.turnId, classified);
  }
}
```

`consumeProviderStream` validates ordering, IDs, byte limits, and completion.
It seals text and tool calls before returning. It never calls a tool from inside
a provider callback. An assistant response that contains malformed tool input
becomes a bounded tool error observation when safe; repeated malformed calls
consume budget and eventually fail the turn.

### 8.4 Completion semantics

A turn is complete only when:

- the provider has emitted a valid terminal response without unresolved tool
  calls;
- all model and tool stream content needed for resume has been sealed;
- no prepared or started effect remains unsettled;
- usage and truncation facts are recorded;
- the changed-path and verification manifests are computed from observed
  evidence rather than model assertions;
- the final assistant message is durable.

A provider stop reason such as maximum output tokens is not automatically a
successful final response. The loop may continue with a bounded continuation
when the adapter declares exact continuation support; otherwise it seals the
partial response and fails with an actionable limit classification.

### 8.5 Steering and clarification

A user steering message arriving between invocations is appended and included
in the next prompt plan. A message arriving during a provider stream is queued
until the stream reaches a safe boundary unless the user explicitly interrupts.
Provider-native side-channel steering is not used until it has deterministic
ordering and conformance tests.

Model questions to the user are ordinary assistant messages by default. A
future structured `ask_user` tool pauses the turn without side effects and
records answer options, free-form allowance, and timeout behavior. The headless
surface returns a typed `input_required` result rather than waiting indefinitely.

### 8.6 Agent-backend compatibility boundary

The shipped primary backend is `direct_model`, which uses the loop in this
section. `robin-agent` also defines a normalized backend port so a future hosted
agent or protocol adapter can participate without changing CLI/session events:

```ts
interface CodingAgentBackend {
  readonly descriptor: AgentBackendDescriptor;
  runTurn(
    request: AgentBackendTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent>;
  reconcile(
    record: UnsettledAgentBackendRecord,
    signal: AbortSignal,
  ): Promise<AgentBackendReconciliation>;
}
```

A structured protocol backend may emit assistant content and tool proposals,
but Robin retains prompt/context release, permission, tool execution, session,
and recovery ownership. A contained third-party coding CLI that executes its
own tools is a different compatibility tier: it runs under process/sandbox
controls, exposes only the transcript/effects Robin can observe, and cannot
claim direct-model audit or permission guarantees.

Backend capabilities declare transcript visibility, context delivery, tool
proposal structure, credential owner, continuation, cancellation,
reconciliation, and whether undeclared child agents can exist. Robin computes
the achieved compatibility tier from these facts and enforcement probes. An
adapter cannot self-assert equivalence with the direct-model backend.

## 9. Prompt and context assembly

### 9.1 Compiler boundary

The prompt compiler accepts typed, released inputs and produces a provider-
neutral `PromptPlan`. It does not scan the filesystem on its own, read secrets,
execute hooks, or call a provider. Every repository byte included in a request
must have a source reference, content hash, classification, byte count, and
selection reason.

```ts
interface PromptPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly providerProfileId: string;
  readonly modelId: string;
  readonly instructions: readonly PromptItem[];
  readonly conversation: readonly PromptItem[];
  readonly context: readonly PromptItem[];
  readonly toolDefinitions: readonly ProviderNeutralToolDefinition[];
  readonly responseContract: ResponseContract;
  readonly continuation: ContinuationInput | null;
  readonly budget: PromptBudgetReceipt;
  readonly selectedItemManifest: readonly SelectedPromptItem[];
  readonly omittedItemManifest: readonly OmittedPromptItem[];
  readonly canonicalHash: string;
}
```

The manifest is durable, while large selected content remains in CAS. The
provider adapter receives resolved bytes through a one-request read handle. It
cannot use the handle after request serialization completes.

### 9.2 Instruction layers and authority

Instruction order is explicit and provenance-aware:

1. Robin's versioned coding-agent system contract;
2. user-level Robin instructions from trusted user configuration;
3. trusted project instructions selected for the workspace and current paths;
4. active skill instructions selected by name or deterministic routing;
5. accepted plan and current permission-mode description;
6. current developer submission;
7. delimited untrusted attachments, repository content, and tool observations.

Later text does not gain higher authorization merely by saying it overrides an
earlier layer. Repository instructions can guide build commands, style, and
architecture, but cannot select a credential, change provider endpoints,
disable logging, grant tool permissions, or auto-trust hooks. The compiler
labels the authority and source of every instruction item. Provider adapters
map these roles into the closest supported wire roles without changing Robin's
internal precedence.

Path-scoped instructions are selected only when a turn has an explicit target
path or when a tool result introduces that path. The selector is deterministic:
physical workspace-relative path, normalized separators, anchored glob,
longest-specific match first, then stable source order. A newly discovered
instruction file is not retroactively applied to already completed model
invocations.

### 9.3 Conversation assembly

The conversation is reconstructed from sealed semantic items, not terminal
rendering:

- developer messages and separately delimited attachments;
- assistant messages with provider item identity when required for continuity;
- normalized tool requests;
- tool results released for model consumption;
- accepted clarification answers and steering messages;
- compaction summaries with source ranges and hashes.

Permission prompts, local UI notices, internal diagnostics, raw credentials,
audit-only result fields, ANSI control bytes, and provider HTTP error bodies are
excluded. Denied tool calls return a bounded model-visible observation naming
the denial category and safe reason; they do not include confidential policy
rules unless configured for disclosure.

### 9.4 Repository context selection

Robin starts with a small deterministic workspace synopsis:

- physical workspace label without exposing unrelated parent paths;
- Git branch, abbreviated HEAD, worktree status summary, and submodule facts;
- top-level bounded file manifest and recognized build manifests;
- selected trusted instructions;
- verification commands explicitly configured or safely inferred from known
  package manifests;
- changed-path manifest for Robin's current turn.

The model obtains additional source through tools. Robin does not embed the
entire repository, recursively concatenate files, or automatically send every
dirty diff. Context selection may use lexical search, symbol indexes, or an
embedding service later, but selected bytes still pass the same path, size,
classification, and provenance boundary.

Binary, generated, vendor, secret-pattern, and oversized files are represented
by bounded metadata unless a dedicated decoder and policy release their
content. Ignore files inform discovery but do not act as the security boundary;
path authorization and classification are applied independently.

### 9.5 Token and byte budgeting

The provider capability manifest supplies a tested context-window limit. Robin
reserves budgets in this order:

1. required system and safety contract;
2. tool schemas needed for the current permission mode;
3. minimum provider output allowance;
4. current developer submission;
5. most recent uncompacted semantic transcript;
6. accepted plan and active changed-file context;
7. older transcript summary;
8. optional repository context ranked by deterministic relevance.

Every item is measured using the provider adapter's tokenizer when available.
If exact tokenization is unavailable, Robin uses a conservative byte-derived
upper bound declared by the adapter and marks accounting as estimated. The
compiler refuses a request if required items cannot fit. It does not silently
truncate tool schemas, JSON, patches, or the current developer message.

`PromptBudgetReceipt` records capacity, reserved output, exact versus estimated
counts, per-category consumption, omitted items, and the safety margin. The
provider's later usage record is compared with the estimate for diagnostics.

### 9.6 Compaction

Compaction is an explicit session operation. It chooses a closed range of
semantic transcript items, creates a structured summary candidate through a
model invocation or deterministic projection, validates required facts, and
appends `CompactionRecorded` with:

- source sequence range and event hashes;
- summary bytes and content hash;
- changed paths and unresolved task state;
- tool calls, approvals, commands, test outcomes, and provider/model identity;
- facts that must remain exact, including user constraints and error codes;
- compactor model and usage when a model produced the summary.

Original events and CAS objects remain until retention policy permits garbage
collection. A summary never authorizes a tool and never replaces exact
workspace preconditions. Users can inspect the summary and the source range.
If compaction fails validation, Robin retains the original context and either
asks the user to start a new session or fails the next oversized request with a
clear budget report.

### 9.7 Tool definitions in the prompt

Only tools available under the current platform, workspace, trust, and
permission mode are advertised. Each provider-neutral definition includes a
stable tool ID and version, description, closed JSON Schema, side-effect class,
and safe usage constraints. Provider adapters map definitions to native tool
formats and reject mappings that lose required schema constraints.

Plan mode excludes mutation, process, network, MCP-effect, and Git-write tools
rather than advertising them and relying only on denial after selection.
Excluding a tool is an optimization and UX boundary; execution still requires
registry lookup and permission evaluation in case a provider emits an unknown
or stale call.

### 9.8 Context assembly failures

| Failure | Behavior | Recovery |
| --- | --- | --- |
| Selected file changed after read | Reject the stale item before request serialization | Re-read through the tool boundary and assemble a new invocation |
| Required instructions are invalid UTF-8 or oversized | Record a safe diagnostic and omit only when the source is optional | Fail configuration when the instruction source is required |
| Context exceeds the tested model limit | Do not send the request | Compact, omit optional items deterministically, choose another configured model, or ask the user |
| Provider tokenizer fails | Switch only to the adapter's declared conservative estimator | Mark estimated accounting and retain a safety margin |
| CAS item is missing or hash-mismatched | Enter recovery-required state | Restore from retained source if exact identity can be proven; otherwise fork without claiming continuity |
| Instruction trust is revoked | Stop using the source at the next invocation | Pin a new configuration snapshot and display the change |
| Prompt serialization differs from canonical plan | Abort before transport | Treat as adapter invariant failure and preserve the plan for diagnosis |

### 9.9 Prompt test seams

The compiler is tested with fake tokenizers, fixed clocks and IDs, immutable
transcript fixtures, workspace context fixtures, and provider capability
manifests. Golden tests assert selected-item order and hashes. Property tests
vary budgets, Unicode, path scopes, and item sizes. Adversarial tests place
authority-changing text in repository content and confirm it remains delimited
untrusted content. No prompt test requires a live provider.

## 10. Provider architecture

### 10.1 Separation of model and agent

A model provider adapter performs authentication-bound inference transport. It
does not decide which repository files to read, how tools execute, whether a
tool is permitted, when a session resumes, or what constitutes a successful
coding task. Robin's direct-model loop makes those decisions.

An optional external coding-agent adapter is a different driver kind. It has a
weaker security and transcript compatibility tier because it may own its own
loop. It cannot masquerade as a direct model adapter.

### 10.2 Provider port

```ts
interface ModelProviderAdapter {
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
```

This `probe` / `countInput` / `invoke` / `classifyUnknownError` /
`redactDiagnostic` interface is the canonical production provider port frozen
for R4. The R1 candidate currently depends on
`ModelProvider.respond(SemanticModelRequest, AbortSignal)` from the existing
`@guard/model-provider` package. `respond` is a temporary candidate shim used to
prove provider-neutral multi-request structured streaming; it is not a second
production extension point. During the R4 migration, an internal wrapper adapts that shim
to `invoke` for synthetic fixtures, call sites move to this interface, and the
shim is retired from product composition after its compatibility tests pass.

Provider packages may implement request compilation, stream normalization, and
continuation reconstruction as internal pipeline helpers. Concretely, a package
may use functions such as `compileSemanticRequest`, `normalizeProviderStream`,
and `reconstructContinuation`, but those functions are not an alternate public
port: `probe` negotiates facts, `countInput` performs preflight accounting,
`invoke` orchestrates compilation/transport/normalization/reconstruction, and
the two error methods are the only unknown-error and diagnostic escape paths.
SDK request, response, error, and continuation objects remain inside the
provider package.

The adapter receives a lease reference rather than secret bytes at the public
port. Its transport requests a short-lived `CredentialLease` immediately
before building authenticated headers. The lease exposes only the exact
authentication operation required by the provider profile and clears owned
buffers when released.

The first hosted production adapter is `packages/provider-openai`. R4 uses the
OpenAI Responses API through the reviewed, pinned official JavaScript SDK with
SDK retries and debug logging disabled. The SDK is an implementation detail
behind the adapter and injected transport seams; no SDK type crosses this port.
Anthropic and the bounded OpenAI-compatible/local adapters enter in R7 after
the OpenAI adapter and shared conformance suite establish the boundary.

### 10.3 Provider and model descriptors

```ts
interface ProviderDescriptor {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly protocolFamily: "anthropic" | "openai" | "openai_compatible" | "local" | "synthetic";
  readonly endpointPolicy: EndpointPolicy;
  readonly authenticationStrategies: readonly AuthenticationStrategyDescriptor[];
  readonly transportFeatures: ProviderTransportFeatures;
  readonly conformanceVersion: number;
}

interface ModelDescriptor {
  readonly providerProfileId: string;
  readonly modelId: string;
  readonly modelRevision: string | null;
  readonly inputModalities: readonly ("text" | "image" | "document")[];
  readonly outputModalities: readonly ("text" | "json")[];
  readonly toolCalling: "native" | "schema_envelope" | "none";
  readonly supportsParallelToolCalls: boolean;
  readonly streaming: boolean;
  readonly continuation: "semantic_transcript" | "opaque_items" | "provider_state" | "none";
  readonly cancellation: "confirmed" | "transport_abort" | "unsupported";
  readonly usage: readonly UsageDimension[];
  readonly inputLimitTokens: number;
  readonly maximumOutputTokens: number;
  readonly exactTokenizer: boolean;
  readonly schemaLimitations: readonly SchemaLimitation[];
  readonly retentionControls: RetentionCapability;
}
```

Capabilities are the intersection of adapter-tested behavior, provider probe,
configured endpoint profile, and exact model declaration. A remote model list
cannot assert a stronger capability than the installed adapter has tested.
Capability cache entries have an endpoint, adapter, model, and probe-version
key plus an expiration time.

### 10.4 Provider-neutral request

```ts
interface ProviderNeutralRequest {
  readonly schemaVersion: 1;
  readonly invocationId: string;
  readonly model: ModelDescriptor;
  readonly systemItems: readonly ProviderContentItem[];
  readonly conversationItems: readonly ProviderConversationItem[];
  readonly tools: readonly ProviderNeutralToolDefinition[];
  readonly toolChoice: "auto" | "none" | { readonly requiredToolId: string };
  readonly output: ProviderOutputContract;
  readonly sampling: SamplingParameters;
  readonly limits: InvocationLimits;
  readonly retention: RetentionRequest;
  readonly continuation: ContinuationInput | null;
  readonly metadata: SafeProviderMetadata;
}
```

The sampling contract names only portable concepts. Provider-specific options
must live in a validated namespaced profile and be included in the pinned
configuration hash. Unknown options fail configuration rather than passing
through unchecked.

### 10.5 Normalized provider stream

```ts
type NormalizedProviderEvent =
  | { type: "response_started"; providerResponseId: string | null }
  | { type: "content_started"; itemId: string; modality: "text" | "json" }
  | { type: "content_delta"; itemId: string; bytes: Uint8Array }
  | { type: "content_completed"; itemId: string; finish: ContentFinish }
  | { type: "tool_call_started"; itemId: string; providerCallId: string; toolId: string }
  | { type: "tool_arguments_delta"; itemId: string; bytes: Uint8Array }
  | { type: "tool_call_completed"; itemId: string }
  | { type: "continuation_item"; item: OpaqueContinuationItem }
  | { type: "usage"; usage: NormalizedUsage; cumulative: boolean }
  | { type: "response_completed"; stopReason: ProviderStopReason }
  | { type: "response_failed"; failure: ProviderFailure };
```

The stream validator enforces one start, unique item IDs, legal item
transitions, monotonic cumulative usage, declared modalities, bounded chunks,
one terminal response event, and no events after termination. Provider-native
reasoning or hidden chain-of-thought is not exposed as a Robin transcript. An
adapter may normalize provider-supplied concise reasoning summaries only when
the provider explicitly exposes them for users and the content follows normal
retention and rendering policy.

### 10.6 Tool-call normalization

Native provider call IDs are evidence, not Robin authority. Robin allocates its
own `ToolCallId` and records the provider ID as an optional mapping. The adapter
must preserve tool name and complete argument bytes exactly enough for Robin's
trusted JSON decoder to validate them. It must not repair malformed JSON,
coerce types, invent missing fields, or parse executable commands from prose.

A model with reliable schema-constrained output but no native tool calling may
use a versioned single-proposal envelope. Text-only models operate in question,
planning, or answer-only mode and are not advertised mutation tools.

### 10.7 Authentication and endpoint handling

Provider profiles identify an authentication strategy and credential reference.
Adapters construct authorization headers after URL validation and immediately
before transport. Redirects are disabled by default for authenticated requests;
an allowlisted same-provider redirect policy must strip credentials before any
cross-origin request. Proxy use is explicit in effective configuration and
doctor output.

Generic OpenAI-compatible endpoints require an explicit base URL and tested
feature profile. Robin records that compatibility applies to a protocol subset,
not to every behavior of OpenAI's service. TLS verification is never disabled
by a repository setting. Custom certificate authorities come only from trusted
user or administrator configuration and are shown by `doctor`.

### 10.8 Error taxonomy

```ts
type ProviderFailureCode =
  | "authentication_failed"
  | "authorization_failed"
  | "model_not_found"
  | "unsupported_capability"
  | "invalid_request"
  | "context_limit_exceeded"
  | "rate_limited"
  | "quota_exhausted"
  | "provider_overloaded"
  | "transport_unreachable"
  | "transport_interrupted"
  | "response_protocol_invalid"
  | "response_too_large"
  | "content_blocked"
  | "retention_control_rejected"
  | "cancelled"
  | "outcome_uncertain";
```

Each failure includes retryability, safe user message, provider request ID when
safe, retry-after duration, whether any response bytes arrived, whether billing
may have occurred, and whether repeating the invocation can produce a second
model decision.

### 10.9 Retry and uncertainty

Model generation is treated as non-idempotent even when an HTTP request uses an
idempotency key. Robin may retry a transport attempt automatically only when
the adapter proves the request was not accepted, no response began, the
provider documents the idempotency behavior being used, the turn budget permits
it, and backoff is cancellable. Every retry is a new `ProviderAttemptId` under
the same invocation.

When acceptance or completion is ambiguous, Robin appends
`ModelInvocationOutcomeUncertain`, stops the turn, and offers a new explicit
invocation that consumes budget and may produce a different answer. It does not
replay the request silently. A completed response stored locally is reused on
session replay and never regenerated.

Rate-limit retry uses provider `Retry-After` when bounded by user-configured
maximum wait. Exponential backoff uses injected deterministic jitter in tests.
Authentication, invalid request, unsupported capability, content-policy, and
context-limit failures are not retried unchanged.

### 10.10 Provider conformance suite

Every production adapter must pass fixtures for:

- exact request mapping and secret-free diagnostics;
- streamed UTF-8 split across arbitrary byte boundaries;
- text, JSON, and native tool-call lifecycle ordering;
- malformed JSON, duplicate IDs, missing completion, and events after terminal;
- usage snapshots and deltas;
- abort before request, during connection, during text, and during tool input;
- HTTP and provider error classification;
- redirect and endpoint credential containment;
- context and output limit reporting;
- retention-control mapping;
- opaque continuation round trip when declared;
- one end-to-end opt-in live smoke test behind an environment gate.

The synthetic provider implements the same port and supports scripted streams,
chunk boundaries, delays, errors, and cancellation checkpoints. Unit and
end-to-end tests use it by default.

## 11. Tool, permission, and execution pipeline

### 11.1 Tool definition contract

```ts
interface RobinToolDefinition<TInput, TNormalized, TRaw, TAgent> {
  readonly identity: {
    readonly toolId: string;
    readonly toolVersion: number;
    readonly implementationVersion: string;
  };
  readonly description: string;
  readonly inputSchema: ClosedJsonSchema;
  readonly resultSchema: ClosedJsonSchema;
  readonly sideEffectClass: "none" | "local_reversible" | "local_irreversible" | "external";
  readonly concurrencyClass: "session_read" | "workspace_write" | "process" | "git_write" | "network";
  parse(input: unknown): TInput;
  normalize(input: TInput, context: ToolNormalizationContext): Promise<TNormalized>;
  observe(normalized: TNormalized, context: ToolObservationContext): Promise<ToolPreconditions>;
  summarize(normalized: TNormalized, preconditions: ToolPreconditions): ApprovalSummary;
  execute(prepared: PreparedToolExecution<TNormalized>, context: ToolExecutionContext): Promise<TRaw>;
  release(raw: TRaw, prepared: PreparedToolExecution<TNormalized>): Promise<ReleasedToolResult<TAgent>>;
  reconcile(record: UnsettledToolRecord, context: ReconciliationContext): Promise<ReconciliationResult>;
}
```

The registry validates unique `(toolId, toolVersion)` pairs, schema closure,
bounded descriptions, declared concurrency and side-effect classes, result
release definitions, and adapter fingerprints at application startup. Dynamic
MCP tools enter a separate namespaced registry with a pinned capability
snapshot.

### 11.2 Pipeline stages

Every tool call passes these stages without shortcuts:

1. **Accumulate:** collect provider argument bytes under a per-call limit.
2. **Seal:** persist exact bytes and completed provider-call mapping.
3. **Decode:** require one JSON value, valid encoding, bounded depth, keys, and
   scalar sizes.
4. **Schema validate:** reject unknown or ill-typed fields.
5. **Registry resolve:** require the exact advertised tool/version and current
   implementation fingerprint.
6. **Semantic normalize:** resolve workspace-relative paths, command form,
   hosts, ranges, encodings, and defaults into one immutable request.
7. **Observe:** capture file hashes, symlink facts, HEAD, executable identity,
   sandbox capability, and other operation-specific preconditions.
8. **Policy evaluate:** compute allow, ask, or deny with a safe explanation.
9. **Approve:** when needed, bind the user's response to normalized request hash,
   precondition hash, policy snapshot, and expiry.
10. **Prepare:** persist the exact planned effect and allocate execution ID.
11. **Revalidate:** immediately before dispatch, compare observed preconditions
    and re-evaluate when anything changed.
12. **Start:** append effect-start evidence before or at the adapter-specific
    point defined by its uncertainty protocol.
13. **Execute:** invoke once with cancellation, output, time, and resource bounds.
14. **Settle:** persist completed, failed, cancelled, or uncertain outcome.
15. **Release:** produce separate audit, human, and model views with hashes.
16. **Feed back:** append the model-visible tool result to semantic transcript.

Structural or policy failures do not invoke `execute`. A prepared execution is
owned by the registry instance that issued it, consumed once, and cannot be
constructed structurally by an extension.

### 11.3 Permission modes

The product layer offers understandable modes compiled into normalized rules:

| Mode | Reads | File edits | Processes | Network/MCP effects | Git writes |
| --- | --- | --- | --- | --- | --- |
| `plan` | Workspace-bounded allow | deny | deny | deny | deny |
| `default` | Workspace-bounded allow | ask unless exact rule | ask | ask/deny by endpoint | ask |
| `accept-edits` | Workspace-bounded allow | allow within workspace and limits | ask | ask/deny | ask |
| `locked` | Exact allow rules only | exact allow rules only | exact allow rules only | exact allow rules only | exact allow rules only |
| `bypass` | allow unless managed denial | allow unless managed denial | allow unless managed denial | allow unless managed denial | allow unless managed denial |

`accept-edits` does not allow deleting arbitrary trees, following symlinks out
of the workspace, modifying Git internals, changing executable permissions, or
overwriting a preimage mismatch. Those remain separate operation or risk
classes.

`bypass` bypasses ordinary ask/allow rules only. It never bypasses schema
validation, path containment, exact-preimage checks, effect journaling,
cancellation, managed denials, or a required sandbox. It requires the explicit
launch confirmation and persistent warning defined by the product requirements.
Headless is a `--print` surface, not a sixth permission mode: the selected mode
remains one of the five rows above, and any resulting ask becomes deny unless an
exact predeclared rule or framed permission callback resolves it. The current R1
candidate value `ask` migrates to `default`.

### 11.4 Approval scope

An approval grant contains:

```ts
interface ApprovalGrant {
  readonly decisionId: string;
  readonly normalizedRequestHash: string;
  readonly preconditionHash: string;
  readonly policySnapshotHash: string;
  readonly scope: "once" | "turn" | "session" | "project_rule" | "user_rule";
  readonly expiresAt: string | null;
  readonly approvedBy: "interactive_user" | "trusted_rule" | "administrator_floor";
  readonly displayedSummaryHash: string;
}
```

Persistent approval is eligible only when a safe declarative rule can represent
the scope. Robin will not persist a blanket wildcard merely because a command
cannot be normalized precisely. Project rules are written atomically and shown
as a diff; repository content cannot persist a user-level grant.

### 11.5 Revalidation and time-of-check/time-of-use

Approval binds observed state, but validation still occurs immediately before
effect dispatch. File tools compare physical identity, type, size, modification
facts, and content hash as appropriate. Process tools re-resolve executable and
sandbox capabilities. Git tools compare common directory, worktree, HEAD,
index identity, merge/rebase state, and relevant path status.

If a precondition changes, the prepared effect is abandoned. Robin normalizes
and evaluates the current request again. It never reuses the old approval by
changing only the displayed text.

### 11.6 Result views

- The **raw view** exists only inside the trusted handler and bounded spool.
- The **audit view** contains identifiers, hashes, sizes, timings, exit facts,
  truncation, classifications, and safe preconditions.
- The **human view** contains concise paths, diffs, output previews, and
  actionable errors.
- The **model view** contains only context released for the next invocation.

Large output is stored once in CAS. Views reference the same object with
different authorized ranges or derived redactions. A model cannot request the
raw view by naming an internal CAS hash.

### 11.7 Tool failure and recovery classes

| Class | Example | Turn behavior |
| --- | --- | --- |
| Rejected proposal | Unknown tool, malformed input, escaped path | Return bounded tool error when safe; count against malformed-call budget |
| Denied action | Policy deny or user deny | Return denial observation; continue unless the user cancels |
| Stale precondition | File or HEAD changed before dispatch | Do not execute; report conflict and let the model re-read |
| Known non-effect failure | Executable not found before spawn | Record failed execution; return bounded error |
| Known partial local effect | Multi-file edit stopped after one atomic rename | Enter recovery routine using edit journal; do not call the batch successful |
| Cancelled with confirmed termination | Process group exited after cancellation | Record cancelled result and allow user to continue in a new turn |
| External result uncertain | Connection dropped after a remote effect request | Stop with recovery-required state; require reconciliation or user decision |
| Adapter invariant failure | Result violates declared schema | Quarantine raw result, fail the turn, and retain safe diagnostic evidence |

### 11.8 Tool test seams

Registry and pipeline tests inject schema validators, permission evaluators,
precondition observers, clocks, IDs, executor probes, and persistence barriers.
Tests assert that denied and malformed calls never reach execution, approvals
cannot be replayed against changed inputs, prepared handles are one-use, and
crashes at every durability barrier recover to the documented state. Real
workspace/process/Git adapter tests run in dedicated temporary repositories,
never in the source checkout under test.

## 12. Real coding tools and effect mechanics

### 12.1 Workspace handle and identity

Robin discovers a workspace from an explicit `--workspace` path or the launch
directory. Discovery returns a trusted handle rather than a path string:

```ts
interface WorkspaceHandle {
  readonly workspaceId: string;
  readonly displayRoot: string;
  readonly physicalRoot: string;
  readonly rootFileIdentity: FileIdentity;
  readonly caseSensitivity: "sensitive" | "insensitive" | "unknown";
  readonly unicodeNormalization: "nfc" | "platform";
  readonly git: GitWorkspaceIdentity | null;
  readonly mountCapabilities: MountCapabilities;
  readonly createdFrom: "launch_directory" | "explicit_flag" | "resume_record";
}
```

`displayRoot` is for UX. Authorization uses `physicalRoot`, root file identity,
and operation-time component checks. A Git workspace identity includes worktree
root, common Git directory, Git directory, object format, initial HEAD, and
whether the worktree is linked, bare, shallow, sparse, in a submodule, or in a
merge/rebase/cherry-pick operation.

The handle is created before untrusted project settings are applied. A resumed
session compares the recorded root identity with the current physical object.
Moving an unchanged workspace can be accepted through an explicit rebind that
records old and new identities; automatic text-path substitution is forbidden.

### 12.2 Path normalization and containment

A tool input accepts only a workspace-relative path unless a separately scoped
tool explicitly supports another root. Normalization:

1. rejects NUL, invalid encoding, empty required paths, absolute paths, drive
   prefixes, device namespaces, and URL-like values;
2. normalizes separators to an internal slash without resolving case;
3. rejects `.` and `..` components after decoding;
4. applies platform Unicode normalization rules consistently;
5. rejects reserved Git administrative paths such as `.git` and the resolved
   Git directory for mutation operations;
6. joins against the physical root using the platform path adapter;
7. walks existing components with `lstat`, recording symlink and file identity;
8. resolves the nearest existing ancestor and confirms physical containment;
9. opens the target with no-follow behavior where the platform exposes it;
10. compares handle identity and containment again after open or before rename.

Symlinks are visible as metadata but are not followed for read or mutation by
default. An in-workspace symlink whose target is also in the workspace still
requires an explicit symlink-follow policy because its target can change
between checks. Directory junctions, mount points, hard links, case aliases,
and macOS normalization aliases are covered by the platform path corpus.

Node's cross-platform filesystem API cannot provide Linux `openat2` semantics
on every supported host. Robin reports the achieved containment tier:

- `descriptor_strong`: native helper or platform primitive provides rooted,
  no-symlink descriptor traversal;
- `verified_best_effort`: pre/post identity and physical containment checks
  narrow races but cannot claim descriptor-rooted confinement;
- `unavailable`: mutations are disabled because required checks cannot run.

The permission UI and `doctor` expose the tier. A best-effort tier is not
documented as a security sandbox.

### 12.3 Workspace discovery, listing, search, and read

The initial workspace tool set is:

- `workspace_metadata`: repository, branch, status summary, manifests, and
  instruction-source facts;
- `list_files`: bounded directory or recursive listing with type, size, and
  workspace-relative path;
- `search_text`: literal or explicitly selected regular-expression search with
  bounded matches, lines, files, time, and output bytes;
- `read_file`: bounded byte or line-range read with encoding, hash, newline
  style, truncation, and file identity;
- `read_many`: a bounded collection of exact read requests, accounted per file
  and in aggregate;
- `inspect_diff`: an exact current diff or a Robin edit proposal without
  applying it.

Listing has stable bytewise path ordering after platform normalization. It does
not traverse symlinks. It applies configured discovery ignores for relevance,
but explicit reads still pass classification and permission checks. Generated
and dependency directories have separate configurable budgets rather than an
unbounded hidden exclusion.

`search_text` prefers an installed, validated `rg` executable for performance.
The process request uses an argument vector, fixed flags, no shell, bounded
working directory, and a parsed machine-oriented output format. When `rg` is
unavailable, a Robin implementation walks files under the same path and byte
limits. The two implementations share conformance fixtures for match semantics,
binary detection, ignores, Unicode, cancellation, and stable result ordering.

`read_file` opens and stats a file through the path boundary, reads no more than
the requested and global maximum, verifies post-read identity, and computes the
hash over exact bytes. UTF-8 text is decoded strictly; other encodings require a
declared decoder. Binary detection returns safe metadata and a bounded encoded
preview only when policy allows it. A range response always states whether a
leading or trailing partial line was excluded.

### 12.4 Edit request model

The model edits through structural operations, not shell redirection. The core
operation supports:

- create a new file with complete content and exclusive-create precondition;
- replace an exact byte or line range bound to a preimage hash;
- apply a strictly parsed unified patch bound to per-file preimage hashes;
- delete a regular file through recoverable session trash;
- rename one regular file within the workspace with source and destination
  preconditions;
- create a directory with bounded mode inherited from trusted configuration.

Recursive deletion, device files, sockets, FIFOs, ownership change, ACL change,
setuid/setgid change, and mutation of Git administrative data are not ordinary
edit operations.

An edit proposal contains exact workspace-relative paths, operation kind,
expected identity, expected content hash or absence, desired bytes hash, newline
policy, mode policy, and a human diff. The provider cannot supply a host
temporary path, backup path, or final file mode.

### 12.5 Unified patch parsing

Robin's patch parser accepts a documented UTF-8 unified-diff subset. It:

- requires bounded total bytes, files, hunks, context lines, and line length;
- rejects absolute paths, traversal, quoted escape ambiguity, duplicate target
  paths, combined diffs, binary patches, Git submodule entries, and unsupported
  mode headers;
- recognizes create, modify, delete, and rename only when their explicit
  operation contract allows them;
- requires every context and deletion line to match the selected preimage;
- validates hunk counts and non-overlap;
- preserves or deliberately changes final newline state;
- produces desired bytes in memory or a bounded spool before any target write;
- computes a deterministic proposal hash from normalized operations and exact
  preimage/desired hashes.

Fuzzy hunk application is disabled for model edits. A context mismatch produces
a conflict observation that asks the model to re-read and regenerate the patch.
It never applies a nearby guess.

### 12.6 Single-file atomic replacement

For a create or replacement, the adapter executes this protocol:

1. acquire the workspace mutation coordinator and path-level lock;
2. re-resolve the parent and target through the path boundary;
3. recheck expected absence or preimage identity and hash;
4. record the preimage in CAS when one exists and retention permits;
5. create a random, owner-only sibling temporary file with exclusive create;
6. write desired bytes with an explicit loop and configured maximum;
7. flush the file when durable edit mode is enabled;
8. apply the allowed ordinary permission bits without copying special bits;
9. close, reopen or stat, and verify desired size and hash;
10. append the edit-journal prepared record;
11. atomically rename the temporary file over the target where platform
    semantics support it;
12. flush the containing directory when supported;
13. reopen and verify target identity, size, hash, mode, and containment;
14. append the settled record and changed-path manifest;
15. release locks and remove unused temporary artifacts.

If rename-over-existing is not atomic on a supported platform, the platform
adapter advertises that limitation and Robin uses a versioned fallback with a
recoverable backup rename. The UI labels the weaker guarantee. It never quietly
uses truncate-and-write as though it were atomic.

### 12.7 Multi-file edit journal

A multi-file patch is a recoverable batch, not a filesystem transaction. Robin
sorts path locks by normalized path to avoid deadlock, verifies all preimages,
materializes every desired file, and persists this journal before the first
target rename:

```ts
interface EditBatchJournal {
  readonly batchId: string;
  readonly workspaceId: string;
  readonly proposalHash: string;
  readonly phase: "prepared" | "applying" | "settled" | "recovery_required";
  readonly operations: readonly {
    readonly path: string;
    readonly kind: "create" | "replace" | "delete" | "rename";
    readonly preimageHash: string | null;
    readonly desiredHash: string | null;
    readonly applied: boolean;
    readonly verified: boolean;
  }[];
}
```

After each atomic path operation, Robin durably records progress. If a later
operation fails, rollback is attempted only for paths whose current identity
and hash still match Robin's applied output. A path changed by the user or
another process is never overwritten during rollback. Such a batch enters
`recovery_required`, displays exact applied and unapplied paths, and offers
non-destructive choices.

Recovery completes the pending operation only when all original preconditions
still hold and the user explicitly selects completion. Otherwise it restores
eligible preimages, retains conflicting files, and produces a recovery report.

### 12.8 Delete and rename behavior

Delete first renames the exact verified regular file into a session-owned trash
directory on the same filesystem when possible. The trash record stores source
identity, hash, mode, destination, and expiry. If same-filesystem recoverable
rename is unavailable, delete requires the irreversible side-effect class and a
stronger approval.

Rename requires source preimage identity and destination absence. Case-only
renames on insensitive filesystems use a verified two-step temporary name under
one journal. Cross-device rename is not silently converted into copy-delete; it
requires an explicit operation whose partial-effect recovery is separately
modeled.

### 12.9 Preserving user changes and attributing Robin edits

At turn start Robin records Git status plus hashes for files it reads or edits.
It can edit an already dirty file when the user permits it and the exact read
preimage still matches. Its changed-path manifest records before and after
hashes for each own operation.

If another process later changes the same file, Robin can prove that it made an
earlier transition but cannot claim ownership of the final lines. The manifest
marks attribution as `diverged`. Review and rewind operate only on exact
Robin-generated transitions whose current postimage still matches.

Rewind applies inverse structural operations with the same conflict checks.
It never runs `git checkout`, `git reset`, or a blind backup copy to restore a
file.

### 12.10 Process tool request

Robin separates direct executable invocation from shell-language invocation:

```ts
type ProcessRequest =
  | {
      readonly kind: "exec";
      readonly executable: string;
      readonly arguments: readonly string[];
      readonly cwd: string;
      readonly environmentProfile: string;
      readonly stdin: ProcessStdin;
      readonly limits: ProcessLimits;
    }
  | {
      readonly kind: "shell";
      readonly shellProfile: string;
      readonly command: string;
      readonly cwd: string;
      readonly environmentProfile: string;
      readonly stdin: ProcessStdin;
      readonly limits: ProcessLimits;
    };
```

Known verification and Git operations use `exec`. A shell request is preserved
as one exact command string, displayed as shell syntax, and evaluated under a
distinct permission class. Robin does not attempt to authorize a shell command
by splitting on spaces or regular expressions. Policy can match conservative
facts such as selected shell profile, cwd, command hash, declared network mode,
and exact configured command templates.

### 12.11 Process environment and executable resolution

The process adapter builds a fresh environment from a trusted profile. It may
include a bounded set of development variables such as `PATH`, locale, compiler
cache settings, and tool-specific homes. It removes provider keys, session
tokens, credential-store handles, telemetry credentials, SSH agent variables,
cloud credentials, and Robin internal state paths unless an exact tool profile
deliberately delegates them.

For direct execution, Robin resolves the executable using the captured trusted
`PATH`, records physical path and file identity, rejects a workspace-controlled
executable when the rule expected a system tool, and rechecks identity before
spawn when the platform permits it. For shell execution, the selected shell is
resolved from trusted user configuration rather than `$SHELL` inherited from
untrusted process state.

Working directory is a verified directory within the workspace or an explicitly
granted additional root. Stdin is closed by default. Inline bytes, file-derived
stdin, and interactive PTY attachment have separate limits and approval facts.

### 12.12 Process supervision

The supervisor:

1. reserves a concurrency and resource-budget slot;
2. persists `ToolExecutionPrepared`;
3. creates output spools and the configured sandbox plan;
4. spawns the child in a new process group/session where supported;
5. records child identity and `ToolExecutionStarted` immediately after a
   successful spawn;
6. drains stdout and stderr concurrently into bounded spools;
7. emits coalesced live chunks without blocking pipe drainage;
8. observes timeout, cancellation, output, CPU, memory, and descendant limits;
9. on cancellation, sends the configured graceful signal to the process group,
   waits a bounded grace period, then sends forceful termination;
10. waits for pipe closure and child reaping;
11. seals output, exit status, signal, duration, sandbox report, and truncation;
12. rescans relevant workspace and Git state for externally produced changes;
13. releases the resource slot.

Output limits distinguish retained bytes from drain limits. Robin continues to
drain and discard after the retained limit so a noisy child cannot deadlock on
a full pipe. It terminates the process when the absolute drain limit is reached.
UTF-8 decoding occurs after byte capture with explicit replacement diagnostics;
binary output is not injected into the prompt as terminal text.

### 12.13 PTY processes

Ordinary tests and builds run through pipes for deterministic capture. PTY mode
is an explicit process capability for tools that require a terminal. It has a
separate transcript, resize handling, input authority, and cancellation path.
Robin does not allow the model to answer arbitrary interactive credential or
confirmation prompts. Detected prompts cause a pause or termination unless an
approved deterministic input script was supplied.

Full-screen terminal applications are not supported in the first release. The
capability manifest and permission UI state this rather than attempting to
scrape their screen state.

### 12.14 Command sandbox integration

The process supervisor requests a sandbox plan from `robin-platform`:

- readable roots and writable roots;
- network mode and allowed endpoints where enforceable;
- process-spawn and syscall profile;
- environment and device access;
- temporary directory and resource limits;
- achieved enforcement tier and evidence.

On macOS, a Seatbelt adapter may provide filesystem and network restrictions.
On Linux, a bubblewrap/namespaces/seccomp adapter may provide them. These are
separate from permission decisions. If the selected mode requires a sandbox
and none is available, the command does not run. An opt-in best-effort mode is
displayed for every affected command and recorded in its execution receipt.

The Robin parent process and provider credential resolver do not run inside the
same child sandbox. Child processes receive no ambient handle to the session
store or credential service.

### 12.15 Git read operations

`tool-git` discovers Git with a trusted executable profile and uses argument
vectors. It sets non-interactive environment, disables terminal prompts and
external diff/text-conversion helpers for model-visible inspection, and passes
explicit configuration to disable repository-controlled hooks for read
operations. It never invokes aliases.

Machine parsing uses stable forms:

- `git status --porcelain=v2 -z` for index/worktree state;
- `git diff --no-ext-diff --no-textconv` with explicit pathspecs and size limits;
- `git diff --cached` for staged state;
- `git log` with a record and field separator format chosen by Robin;
- `git rev-parse` and `git symbolic-ref` for exact identity;
- `git ls-files -z` for tracked path manifests.

All paths use literal pathspecs. Output is parsed as bytes with NUL delimiters
where Git supports them. Human-oriented, localized output is not used for
authorization or recovery.

### 12.16 Git state safety

Before a Git write Robin records:

- common directory and worktree identity;
- HEAD object and symbolic branch target;
- index path, identity, checksum, and split-index facts;
- tracked/untracked/staged status for affected paths;
- merge, rebase, cherry-pick, revert, bisect, and lock-file state;
- submodule and sparse-checkout state;
- operation-specific hooks and signing settings.

Robin refuses ordinary commit/branch operations during an unresolved Git
operation unless a dedicated workflow supports it. It never deletes a Git lock
file merely because it appears stale. It reports the owner evidence Git makes
available and asks the user to resolve ambiguous locks.

### 12.17 Git staging and commit

The first production commit workflow is deliberately constrained:

1. select an exact set of changed paths from Robin's manifest;
2. require no pre-existing staged changes, unless the user explicitly chooses
   a separately reviewed include-existing workflow;
3. verify every selected current hash and review the exact diff;
4. capture index bytes or an index recovery artifact and its hash;
5. persist a prepared Git effect bound to HEAD, index hash, paths, diff hash,
   message hash, signing mode, and hook mode;
6. revalidate HEAD, index, and selected files;
7. stage only literal selected paths;
8. verify the staged tree contains the approved diff and no additional paths;
9. create the commit using the configured identity, signing, and hook behavior;
10. verify new HEAD parent, tree, message, author/committer facts, and remaining
    workspace status;
11. settle the effect and show the commit ID.

Hooks are disabled by default for agent-initiated commits because they are
repository-controlled executables. Enabling them is an explicit executable
extension decision and their effects are supervised. Commit signing is used
only when a trusted user configuration selects a signing adapter that will not
open an unmediated secret prompt.

If staging fails before commit and the current index still matches Robin's
post-stage hash, Robin restores the captured index atomically and verifies it.
If the user or another process changed the index, Robin does not overwrite it;
the operation enters recovery-required state. If the commit may have succeeded,
Robin reconciles by checking HEAD, reflog, parent, tree, and message hash before
offering any retry.

### 12.18 Git operations excluded from ordinary authority

The default coding tool set does not expose `reset --hard`, `clean`, forced
checkout, history rewrite, force push, branch deletion, remote deletion, stash
drop, reflog expiry, garbage collection, or arbitrary Git configuration writes.
Dedicated future workflows require stronger approval, explicit preconditions,
recoverability analysis, and separate tests.

Push and pull-request creation are external effects. They require remote URL and
ref normalization, credential separation, exact commit/ref preconditions, and
interactive approval. A successful local commit never implies push authority.

### 12.19 External workspace mutations

Commands, editors, file watchers, build tools, Git hooks, and users can change
the workspace outside the file tool. After every process and Git write, Robin
refreshes status and invalidates cached file observations for affected or
unknown paths. File-watch events are hints for invalidation, not authoritative
proof that no change occurred.

Before any later edit, current identity and content hash are rechecked. When a
command produces expected generated files, they are recorded as observed
command effects, not claimed as precise model edits unless a before/after path
manifest proves the transition.

### 12.20 Real-tool acceptance tests

The tool adapters require integration suites for:

- path traversal, prefixes, symlink swaps, hard links, case aliases, Unicode,
  junctions/mounts where supported, and `.git` indirection;
- files changing before read, after read, before approval, and before rename;
- create/replace/delete/rename crash points and multi-file partial application;
- CRLF, final newline, empty files, executable bits, large and binary files;
- process stdout/stderr interleaving, output floods, descendants, timeouts,
  signals, failed spawn, PTY cancellation, and terminal restoration;
- sandbox unavailable, partial enforcement, denied network, and denied roots;
- Git porcelain parsing with unusual filenames and all staged/unstaged states;
- commit conflict, index race, hook behavior, signing failure, ambiguous process
  exit, and exact recovery;
- preservation of unrelated dirty and untracked files in every workflow.

Fixtures run on each supported operating system and filesystem behavior tier.
Tests that require a missing platform primitive are reported as capability-
specific skips, while the product test confirms Robin disables the unsupported
feature instead of claiming it.

## 13. Local persistence, locking, and recovery

### 13.1 Durability goals

The local session store must survive a Robin crash, terminal loss, operating-
system termination, and a torn final write without inventing or repeating work.
It must distinguish:

- durable semantic history from reconstructible indexes and UI state;
- a cleanly completed effect from a known non-effect and an uncertain effect;
- an incomplete final frame from corruption in already committed history;
- unavailable optional content from missing content required for exact resume;
- a stale lock from a live writer.

The store is not a distributed database. One local writer owns a session. A
future daemon may centralize that ownership, but it must preserve the same
append and reconciliation semantics.

### 13.2 Platform state directories

`robin-platform` supplies separate roots for configuration, durable data,
cache, logs, runtime locks, and recoverable trash. Typical mappings are:

| Purpose | macOS | Linux |
| --- | --- | --- |
| Configuration | `~/Library/Application Support/Robin/config` | `$XDG_CONFIG_HOME/robin` or `~/.config/robin` |
| Durable data | `~/Library/Application Support/Robin/data` | `$XDG_DATA_HOME/robin` or `~/.local/share/robin` |
| Cache | `~/Library/Caches/Robin` | `$XDG_CACHE_HOME/robin` or `~/.cache/robin` |
| Logs | `~/Library/Logs/Robin` | `$XDG_STATE_HOME/robin/log` or `~/.local/state/robin/log` |
| Runtime locks | durable data on macOS | `$XDG_RUNTIME_DIR/robin` with durable lock identity mirrored in data |

Environment overrides are accepted only from the documented trusted launch
environment and shown by `doctor`. Robin creates private directories with the
most restrictive ordinary permissions supported by the platform and refuses
secret-bearing operations when state is group/world writable.

Project repositories contain no session transcript or API key by default.
Committed `.robin` files are limited to non-secret configuration,
instructions, declarative permissions, skills, and extension manifests that
still pass project trust.

### 13.3 Session layout

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
          <sequence>-<projection-hash>.snapshot
        cas/
          sha256/
            <first-two-hex>/
              <remaining-hex>.blob
        journals/
          edits/
          git/
          extensions/
        recovery/
        trash/
  projects/
    index.json
  trust/
    projects.json
  migrations/
  trash/
```

`manifest.json` contains safe session metadata, current event format, creation
version, workspace identity digest, display name, and last committed sequence.
It is an optimization and discovery record; `events.rlog` remains semantic
authority. Indexes are rebuildable by scanning manifests and logs.

### 13.4 Event-log file header

The binary event log begins with a fixed, checksummed file header:

| Field | Encoding | Purpose |
| --- | --- | --- |
| Magic | 8 bytes, `RBNELOG1` | Reject unrelated files |
| Format version | unsigned 16-bit little endian | Select frame decoder |
| Header length | unsigned 16-bit little endian | Permit additive header fields |
| Flags | unsigned 32-bit little endian | Declare supported frame transforms; encryption values remain reserved until their separate gate |
| Session identity | 16 UUID bytes | Bind file to directory/session |
| Created time | signed 64-bit Unix milliseconds | Diagnostic fact |
| Initial chain seed | 32 bytes | Domain-separated first-frame predecessor |
| Header hash | 32-byte SHA-256 | Detect header corruption |

All integer bounds are checked before allocation. Reserved flags and nonzero
reserved bytes fail closed for a decoder that does not understand them.

### 13.5 Committed frame format

Each durable event is canonical UTF-8 JSON inside this frame:

| Field | Encoding | Purpose |
| --- | --- | --- |
| Frame magic | 8 bytes, `RBNFRM01` | Find the expected next frame boundary |
| Header length | unsigned 32-bit little endian | Bound and version the header |
| Flags | unsigned 32-bit little endian | Per-frame encoding facts |
| Sequence | unsigned 64-bit little endian | Enforce contiguous event order |
| Payload length | unsigned 64-bit little endian | Bound streaming read |
| Payload CRC32C | unsigned 32-bit little endian | Detect common torn/corrupt bytes quickly |
| Reserved | unsigned 32-bit zero | Reject unknown interpretation |
| Previous frame hash | 32 bytes | Detect deletion, insertion, and reordering |
| Payload SHA-256 | 32 bytes | Verify exact canonical event bytes |
| Payload | declared byte length | Canonical event envelope |
| Frame hash | 32 bytes | Hash domain, header, and payload |
| Commit marker | 8 bytes, `RBNCMT01` | Identify a fully written frame |

`frameHash` is SHA-256 over the domain string `robin-session-frame-v1`, the
fixed and extension header bytes excluding no fields, and the payload. The next
frame names this hash. Sequence begins at one and increases by exactly one.

The hash chain detects torn writes, accidental corruption, and uncoordinated
insertion/deletion/reordering. It is not authentication against a malicious
same-user process that can rewrite the complete log and recompute every hash.
Robin's protection against that actor is limited by local OS permissions until
an independently keyed checkpoint or signature design is implemented and
qualified.

A frame is committed only when the complete marker, both hashes, CRC, sequence,
and previous hash validate. A scanner never searches forward for a plausible
magic value after a committed-region error because untrusted payload bytes can
contain that value.

### 13.6 Append protocol

Under the exclusive session writer lock, append performs:

1. validate and canonicalize the event envelope;
2. enforce the expected session ID, next sequence, configuration snapshot, and
   payload byte limit;
3. compute payload checksum and hashes in bounded memory or through a spool;
4. write the complete frame with an explicit short-write loop;
5. flush according to the event's durability class;
6. update the in-memory chain head only after successful flush;
7. atomically update the manifest's last-sequence hint;
8. publish the event to live subscribers.

Publishing happens after commit. A UI crash cannot cause an uncommitted event
to appear as durable. If a write or flush fails, the store stops accepting
events, marks the writer unhealthy, and requires reopen/recovery.

Semantic barriers always request durable flush: user-submission acceptance,
configuration pin, provider request/attempt start, complete provider content,
approval response, prepared/started/settled tool effect, turn terminal state,
edit/Git journal progress, and session close. High-volume live deltas are not
individual frames; their sealed content event is the durability barrier.

### 13.7 Content-addressed storage

Session-local CAS stores exact large bytes once per session. Its logical key is
`sha256:<lowercase-hex>` over the uncompressed plaintext content. A blob file
contains a versioned header with media type category, plaintext length, storage
encoding, and checksum followed by payload bytes. Compression, when enabled,
is deterministic storage encoding and does not change the logical key.

Blob creation:

1. stream input into a private temporary file while hashing and enforcing size;
2. flush and close the temporary file;
3. derive the final path from the complete digest;
4. if an object exists, stream-verify its decoded length and hash, then discard
   the temporary file;
5. otherwise install without overwriting an existing object using the strongest
   atomic no-replace primitive available;
6. flush the containing directories when supported;
7. reopen and verify before returning a CAS reference.

The session event referencing a blob is appended only after blob verification.
An unreferenced blob from a crash is harmless and later collected. A referenced
missing or corrupt blob is a recovery error.

CAS paths are never accepted from model or extension input. Reads require a
typed reference already authorized for the current session and view. A hash is
not itself an authorization token.

### 13.8 Retention and encryption

The first release protects local data with private filesystem permissions,
strict secret exclusion, bounded retention, and documented purge. Optional
transcript-at-rest encryption is not claimed until key creation, recovery,
rotation, crash consistency, and cross-platform credential-store integration
pass their release gate.

When encryption is implemented, the storage key is held by the OS credential
store, each object uses authenticated encryption with a unique nonce, headers
bind session ID and logical content hash as associated data, and plaintext is
verified after decryption. Losing the key makes encrypted transcript content
unrecoverable; Robin must state that before enabling the mode. API credentials
remain separate credential records and are never encrypted into session CAS.

Retention classes include `session_required`, `recovery_required`,
`user_attachment`, `tool_output`, `diagnostic`, and `cache`. A session cannot
delete objects required for exact resume or unsettled-effect recovery. Export
and purge produce manifests listing retained, deleted, failed, and externally
held data.

### 13.9 Session writer lock

Only one process may append to a session. Lock acquisition uses an atomic
exclusive-create primitive and writes:

```ts
interface SessionWriterLockRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly installationId: string;
  readonly hostnameDigest: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly nonce: string;
  readonly robinBuild: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}
```

The lock file is flushed before ownership is assumed. The owner periodically
renews heartbeat through atomic replace, retaining nonce and process identity.
Heartbeat age alone never proves staleness. The platform adapter checks PID and
process-start identity to defend against PID reuse. If liveness cannot be
established, Robin refuses automatic takeover and offers a diagnosed, explicit
force-unlock that first moves the record into recovery evidence.

The owner rechecks nonce before every append. Lock loss makes the writer fail
closed. On clean close it removes the lock only after verifying the same nonce.

Within a process, an async mutex serializes appends and tool journal updates.
Short-lived global/index locks follow a fixed order: installation migration,
trust/config, project index, session index, session writer, session journal.
Code never waits for a higher-order lock while holding a lower-order lock.

### 13.10 Snapshots and projections

Event replay is authoritative. A snapshot is a validated acceleration artifact
containing:

- snapshot schema and reducer version;
- session ID;
- last included sequence and frame hash;
- canonical serialized session projection;
- projection hash and referenced CAS manifest;
- Robin build and migration provenance.

Robin writes a snapshot to a private temporary file, flushes it, atomically
installs it, verifies it, and appends `SnapshotWritten`. On open, it selects the
newest snapshot whose schema is supported, file hash is correct, and included
frame hash matches the event log. It replays every later event. A missing or
invalid snapshot falls back to full replay without changing semantic state.

Derived indexes, search databases, provider capability caches, token estimates,
and UI transcript row caches are rebuildable and never override event truth.

### 13.11 Open and tail recovery

Opening a session under the writer lock performs a streaming scan:

1. validate file header and session identity;
2. read each frame header within a small fixed allocation;
3. reject oversized payload lengths before allocating or seeking;
4. stream-check payload CRC and SHA-256;
5. verify frame hash, commit marker, sequence, and chain;
6. parse canonical JSON from the exact payload length;
7. validate event schema and reducer transition;
8. record the last fully committed byte offset and semantic projection.

EOF at a frame boundary is clean. EOF or invalid bytes after the last committed
frame are a torn tail only when every earlier frame is valid and the invalid
region begins exactly where the next frame should begin. Robin copies the tail
bytes plus diagnostic hashes into `recovery/`, truncates to the last committed
offset, flushes the log, then appends `TailRepaired` as the next valid event.

An invalid committed marker, hash, sequence, schema, or reducer transition
inside committed history is middle corruption. Robin does not truncate through
it. The session becomes quarantined and opens read-only up to the last proven
event. Recovery may restore from an independently verified backup; otherwise a
fork explicitly records that semantic continuity was lost.

### 13.12 Recovery of unfinished operations

After replay, the coordinator enumerates prepared or started records without a
terminal settlement and applies operation-specific reconciliation:

| Unfinished record | Reconciliation |
| --- | --- |
| Invocation prepared, no provider attempt started | Mark abandoned safely; request was not handed to transport |
| Provider attempt started, no response terminal | Ask adapter for documented request-status reconciliation when available; otherwise classify outcome uncertain |
| Provider content sealed, invocation completion event missing | Validate sealed items and append a recovered completion only when stop reason and usage contract are fully present |
| Approval requested, no response | Expire the prompt and ask again against newly observed preconditions |
| Tool prepared, no start | Revalidate workspace and mark abandoned; no adapter dispatch occurred |
| Process started, no terminal | Match PID plus process-start identity; supervise or terminate a live owned group, then seal result; if identity is ambiguous, require recovery |
| Edit batch applying | Inspect journal and exact current/preimage/desired hashes; complete or roll back only non-conflicting paths |
| Git write started | Inspect HEAD, reflog, index, refs, tree, and message hashes; settle only an exact match |
| Hook process started | Treat like process execution and distrust unsealed output |
| Remote MCP effect started | Use server operation ID/status only when the protocol and tool declare reconciliation; otherwise outcome uncertain |
| Subagent active | Replay child events and workspace lease; unresolved child effects block parent mutation |

Recovery never fabricates the original event time or provider usage. Recovered
facts identify reconciliation time and evidence. The UI shows every recovery
decision before accepting a new mutating turn.

### 13.13 Session index consistency

The session index contains safe discovery fields: ID, display name, workspace
digest and label, created/updated time, terminal status, provider/model label,
and last event sequence. Index updates use write-temp, flush, atomic replace,
and directory flush where supported.

If the index is missing, malformed, or refers to an absent session, Robin scans
session manifests under bounds and rebuilds it. A manifest/log disagreement is
resolved from the validated log. Index rebuild never opens a session for write
or resolves credentials.

### 13.14 CAS garbage collection

Garbage collection requires the session writer lock or a verified closed
session. It marks references from the event log, accepted snapshots, journals,
recovery evidence within retention, and pending export. It then moves unmarked
objects to session trash with a timestamp. Permanent deletion occurs after a
grace period and another mark pass.

An object with an invalid name, unexpected hard-link count, ownership mismatch,
or hash failure is quarantined rather than deleted automatically. Session
deletion first moves the entire directory to global recoverable trash; purge is
an explicit separate action.

### 13.15 Schema migration and downgrade

Durable formats are versioned independently from application version. A
migration:

1. acquires the installation and session locks;
2. validates the complete source without mutation;
3. writes a new session directory or log alongside the old one;
4. records a source-to-destination event and CAS manifest;
5. validates full replay and terminal projection in the target format;
6. atomically changes the session index pointer;
7. retains the source in migration trash for the documented rollback window.

In-place rewriting of the sole event log is forbidden. A Robin version that
cannot read a newer format refuses write access and provides export/upgrade
instructions. It does not guess at unknown event semantics.

### 13.16 Persistence test seams

The store depends on injectable filesystem, flush, rename, lock, clock, ID,
checksum, and process-liveness ports. A fault-injection filesystem fails or
crashes before and after every write, short write, flush, close, rename, lock
renewal, and directory flush. Tests reopen from raw bytes and assert one of the
documented projections: prior commit, new commit, recoverable torn tail, or
quarantine. No test accepts a duplicated event or silently lost settled effect.

Property tests generate frames, payload sizes, Unicode events, chain breaks,
CRC/hash collisions represented by injected fake hashers, and unsupported
versions. Lock tests cover PID reuse, delayed heartbeat, nonce replacement,
permission errors, and two simultaneous writers. CAS tests cover concurrent
same-content writes, corrupt existing objects, missing references, partial
compression streams, and garbage-collection races.

## 14. Configuration, project trust, and credentials

### 14.1 Configuration sources and precedence

Configuration is assembled field by field in this order, from lowest to
highest precedence:

1. compiled safe defaults;
2. managed policy, including its non-weakenable floor, when installed;
3. user configuration;
4. trusted project configuration;
5. trusted local-project configuration that is never committed;
6. allowlisted launch-environment values;
7. an explicit settings file selected at launch;
8. explicit CLI flags.

Named profiles are records inside each eligible configuration scope; selecting
a profile does not create a ninth precedence scope. Profile fields participate
at the precedence of the source that defines them, and a higher-precedence
selection can choose only a profile visible through the resolved source set.
Interactive picker or slash-command choices are nonpersisted session/turn
overrides layered over the resolved result. They are recorded in the applicable
configuration snapshot for audit and replay but are not written back to a
configuration file and cannot weaken the managed floor.

The managed floor is restrictive: no later source or ephemeral override can
weaken it. A project or local-project source cannot set credential material,
arbitrary credential-resolver commands, global state paths, telemetry
destination, custom CA,
provider adapter executable, or project trust itself. Each schema field declares
allowed sources, merge strategy, secrecy, restart requirement, and whether a
change can apply between turns.

The effective configuration report includes each safe value, winning source,
shadowed sources, validation status, and redaction. Unknown fields fail with
source location and suggestions. Arrays use declared replace or keyed-merge
semantics; implicit concatenation is forbidden.

### 14.2 Configuration schemas and atomic writes

User and project files use a documented, versioned format with strict schemas.
The parser limits bytes, nesting, entries, scalar sizes, duplicate keys, and
aliases/features of the selected syntax. Environment interpolation does not
occur inside project files. Relative paths are resolved against the declaring
file only for fields whose schema permits them.

`robin config set` reads, parses, changes one typed field, serializes canonical
format, writes a private sibling temporary file, flushes, atomically renames,
and verifies. It refuses to rewrite a source that changed since read. Human
comments are preserved only when the chosen parser has a tested concrete-syntax
tree; otherwise the command displays a proposed full-file diff before replace.

### 14.3 Project trust identity

Project configuration and executable extensions are untrusted until the user
grants trust. A trust record binds:

- physical workspace root identity;
- Git common-directory identity when present;
- remote-origin digest as informative evidence, not sole identity;
- project configuration manifest hash;
- separately selected trust capabilities;
- granting user/installation, time, Robin version, and optional expiry.

Trust capabilities are granular:

- read project instructions;
- apply non-executable project settings;
- load declarative project permission rules subject to higher floors;
- load skills;
- execute hooks;
- start local MCP servers;
- use remote MCP endpoints;
- use project-declared provider endpoints;
- use project-declared sandbox or command profiles.

A changed manifest does not silently inherit executable trust. Robin shows the
diff of trust-relevant files and asks again for affected capabilities. Moving or
cloning a repository produces a new physical identity and requires trust. A
workspace controlled by another user or writable by an unexpected group is
flagged and may be ineligible for executable trust.

### 14.4 Instructions versus configuration

Instructions guide model behavior and remain untrusted prompt content even
after the user allows Robin to load them. Configuration controls program
behavior and is schema-limited. A sentence in an instruction file can never act
as configuration. A model request to change permission mode, provider, trust,
or credentials becomes an ordinary suggestion requiring a user/application
action outside the tool loop.

### 14.5 Credential record model

Non-secret configuration references a credential record:

```ts
interface CredentialRecord {
  readonly recordId: string;
  readonly providerProfileId: string;
  readonly strategyId: string;
  readonly backend: "os_keychain" | "environment" | "interactive_session";
  readonly locator: SafeCredentialLocator;
  readonly createdAt: string;
  readonly lastValidatedAt: string | null;
  readonly metadata: SafeCredentialMetadata;
}
```

The record never contains the secret. `os_keychain` is preferred when a
supported platform backend exists. `environment` names an exact variable but
does not copy its value to disk. `interactive_session` holds secret bytes only
in process memory and cannot resume provider work after exit. R4 supports the
exact environment reference and hidden session-input forms; persistent OS-store
backends arrive in R7. A plaintext or homemade encrypted credential-file
reference is not part of the Product Requirements or Build Plan and cannot be
introduced as a fallback without a separately reviewed product and threat-model
change.

Command-line flags carrying raw API keys are rejected because they leak through
shell history and process listings. Project files cannot name arbitrary secret
files or environment variables.

### 14.6 Credential lease boundary

The credential service issues a short-lived, provider-bound lease after
checking provider profile, endpoint origin, authentication strategy, calling
adapter identity, and session authorization. The transport may use the lease to
construct one authenticated request. It cannot enumerate other records or
return secret bytes through diagnostics.

Secret input disables echo, history, completion, clipboard integration, and
transcript events. Owned buffers are overwritten where the runtime permits, but
documentation does not claim perfect memory erasure in a garbage-collected
process. Crash handlers, HTTP debug logging, and tracing apply redaction before
serialization.

Child tools, hooks, skills, MCP servers, subagents, and repository code receive
no provider credential by default. Delegation requires a separate named
credential capability with endpoint and operation scope.

### 14.7 Provider onboarding

First-run onboarding:

1. selects an installed provider adapter;
2. validates endpoint policy before accepting a credential;
3. selects authentication strategy and credential backend;
4. captures secret input through the credential service;
5. stores the secret or ephemeral reference before writing non-secret profile;
6. performs the narrowest available authentication/model probe;
7. labels a potentially billed generation probe and asks before using it;
8. stores tested capability results and safe provider request ID;
9. displays exact model ID, context limit, tool compatibility, retention facts,
   and any degraded features.

Failed validation removes a newly created keychain record unless the user
chooses to retain it. Provider error bodies pass redaction and size bounds
before display.

### 14.8 Configuration and credential failures

| Failure | Behavior |
| --- | --- |
| Malformed user config | Refuse affected command, show source location, permit `doctor` and explicit repair |
| Malformed untrusted project config | Ignore executable effect, show trust/config diagnostic, continue with safe user settings when possible |
| Unsupported newer schema | Open read-only where safe and require upgrade; never rewrite |
| Project trust hash changed | Disable changed trust capabilities until re-approved |
| Keychain unavailable | Offer environment or ephemeral session backend with limitations; never fall back to plaintext project storage |
| Credential missing on resume | Open transcript read-only and ask for a compatible credential before a new provider invocation |
| Credential rejected | Stop retries, revoke cached validation, and direct the user to `robin auth` |
| Endpoint origin changed | Require profile revalidation and a new credential lease binding |
| Secret detected in a would-be event/log field | Reject serialization, emit only a redaction diagnostic, and fail the unsafe operation if it cannot continue |

### 14.9 Configuration test seams

Tests inject every source, schema version, platform path, credential backend,
secret scanner, and trust identity probe. A precedence matrix covers every
field category. Property tests vary duplicate keys, Unicode keys, case aliases,
oversized structures, and source changes during atomic edit. Credential tests
use sentinel secrets and assert they do not appear in prompts, events, logs,
argv, environment passed to child tools, exported sessions, or thrown error
serialization.

## 15. Extensions: hooks, skills, MCP, and subagents

### 15.1 Common extension rules

Extensions are additional untrusted or conditionally trusted principals. They
do not run inside the Robin core simply because a repository contains a file.
Every installed extension has a manifest with:

- extension kind, ID, semantic version, and manifest schema version;
- source location and content manifest hash;
- publisher or local-install provenance when available;
- required Robin protocol range;
- declared tools, lifecycle events, processes, endpoints, roots, and credentials;
- platform requirements and resource limits;
- configuration schema;
- trust and signature status;
- enabled scope: user, project, local-project, or session, with any selected
  named profile resolved inside that configuration scope;
- update policy and pinned artifact digest.

Discovery never equals activation. User extensions are enabled by trusted user
configuration. Project extensions require project trust for their specific
kind and changed manifest. Registry/package metadata is not trusted as runtime
code until installed bytes are hashed and reviewed according to policy.

Extension IDs use namespaces. A dynamic extension cannot shadow a built-in
tool, provider, slash command, or another installed extension. Conflicts fail
configuration with both sources identified.

### 15.2 Hook lifecycle

Hooks observe or gate named lifecycle boundaries:

- `session.opened` and `session.closing`;
- `turn.accepted`, `prompt.before_assembly`, and `prompt.after_assembly`;
- `tool.before_permission`, `tool.after_permission`,
  `tool.before_execution`, and `tool.after_execution`;
- `turn.completed`, `turn.failed`, and `turn.cancelled`;
- `git.before_commit` and `git.after_commit`;
- `compaction.before` and `compaction.after`.

A hook declares one of three roles:

- `observer`: receives a safe event view and returns no decision;
- `validator`: returns allow or deny plus bounded diagnostics but can never turn
  a Robin or administrator deny into allow;
- `transformer`: returns a typed replacement only for fields whose lifecycle
  schema explicitly permits transformation, such as adding a prompt context
  item or formatting a commit-message candidate.

Hooks cannot mutate core objects in process. Local executable hooks run as
supervised processes with exact argv, JSON on stdin, bounded JSON on stdout,
closed stdin after delivery, restricted environment, timeout, output limit, and
read-only workspace by default. A hook requiring filesystem or network effects
must declare and receive those capabilities separately; its process effects
are recorded even when its JSON response is invalid.

Each hook phase declares failure policy. Security validators fail closed.
Informational observers may fail open with a visible warning. A repository
cannot choose fail-open for an administrator-required validator. Timeouts are
cancellable and never leave a turn waiting indefinitely.

Hook input contains safe IDs and released views, not provider credentials, raw
CAS paths, or internal object references. Hook output is parsed from `unknown`,
rejects unknown fields, and remains untrusted content unless the lifecycle
validator specifically accepts its typed decision.

### 15.3 Hook ordering and recursion

Hooks execute in stable order: administrator, user, trusted project, active
skill, then session-ephemeral; within a source they use declared priority and
manifest order. Validators in one phase see the original normalized object and
prior typed transformer outputs, each with provenance.

Hook-triggered diagnostics do not recursively invoke diagnostic hooks. A hook
cannot install, enable, or rewrite another hook during its own execution.
Changes discovered while a turn is active apply only after a configuration
snapshot boundary.

### 15.4 Skills

A skill is a progressively loaded instruction and resource bundle, not an
executable privilege. Its manifest includes ID/version, short routing
description, body location, applicable task/path tags, optional supporting
resources, compatible tools, and content hashes.

At session start Robin loads only validated metadata under a byte/count budget.
A skill body is loaded when the user names it, a trusted configuration pins it,
or the deterministic router selects it. Selection is recorded before prompt
assembly. A model may request a visible skill by ID, but Robin resolves and
loads the installed version; it never follows a model-provided filesystem path.

Skill instructions enter their own prompt layer with source labels. They cannot
grant tools or credentials. Referenced files are resolved inside the immutable
skill bundle, bounded, hashed, and classified. Executable scripts in a skill are
ordinary hook or tool extensions and require separate manifest declarations and
trust.

Skill name/version conflicts fail closed. User, project, and bundled skills do
not silently override one another. An update changes the manifest hash and
applies at a new configuration snapshot.

### 15.5 MCP client boundary

Robin supports MCP through a client adapter after the core tool loop is stable.
Each server record pins:

- server ID and trust scope;
- transport: local stdio or supported remote HTTP transport;
- executable/arguments or exact HTTPS origin;
- environment profile and credential references specifically delegated to the
  server;
- negotiated protocol version;
- roots, resource, prompt, tool, logging, and sampling capabilities;
- capability snapshot hash and server identity evidence;
- timeout, output, concurrency, network, and retry limits.

Local stdio servers run through the process supervisor with a dedicated framed
protocol channel. Their stderr is bounded diagnostic output and never parsed as
protocol. Remote servers pass endpoint, TLS, redirect, and egress policy before
connection. Neither transport receives Robin's model-provider credential.

### 15.6 MCP capability normalization

MCP tools enter the registry as `mcp.<server-id>.<tool-name>` plus a version
derived from the pinned server capability snapshot. Robin validates server
schemas under its own depth, size, and supported-keyword limits before
advertising them. A schema change during a session produces a new snapshot and
cannot reinterpret an already approved call.

MCP tool calls follow the normal structural validation, permission, approval,
prepare, execute, settle, and release pipeline. The approval view names the
server process or origin and declares that Robin may not be able to observe or
undo the server's external side effects.

Resources and prompts returned by a server are untrusted content. Resource
subscription notifications invalidate cached items but do not alter the prompt
until a new assembly. Server log messages are diagnostics, not assistant text.

### 15.7 MCP sampling and elicitation

An MCP server request for model sampling is denied by default. When enabled, it
becomes a nested, budgeted provider request through Robin's direct-model port
with an explicit model/profile allowlist and no inherited conversation or
credential beyond the approved request. The returned model content is
untrusted server input and cannot authorize tools.

Server elicitation of user input uses a typed Robin UI request. Secret fields
require a credential-specific flow and are not returned through ordinary
elicitation. The headless surface returns input-required unless values were
declared through an approved non-secret input source.

### 15.8 MCP failure and recovery

Protocol parse failures, oversized messages, ID reuse, response mismatches, and
events after close terminate the server connection. Robin fails only the
affected call unless the server was required by the turn. Local server process
death is reconciled through process evidence.

A remote MCP read may be retried under its declared idempotency policy. An
effectful call whose response is lost is outcome-uncertain unless the server
declares and implements an operation-status lookup bound to a stable operation
ID. Reconnecting does not automatically resend it.

### 15.9 Subagent model

Subagents are a later extension of Robin's coordinator, not an assumption in
the first direct-model release. A subagent has:

```ts
interface SubagentSpecification {
  readonly subagentId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly objective: StructuredObjective;
  readonly providerProfile: string;
  readonly modelProfile: string;
  readonly instructionManifest: readonly string[];
  readonly toolAllowlist: readonly string[];
  readonly permissionCeiling: PermissionCeiling;
  readonly contextManifest: readonly ReleasedContextReference[];
  readonly budget: SubagentBudget;
  readonly workspaceLease: WorkspaceLease;
  readonly resultSchema: ClosedJsonSchema;
}
```

The child receives only explicitly released context and tool capabilities. It
does not inherit the full parent transcript, session-level approvals,
credentials, MCP servers, or hooks by default. Its permission ceiling can only
narrow the parent and administrator rules.

### 15.10 Subagent workspace and mutation

Read-only subagents may share a workspace read lease while the coordinator
tracks invalidation. A mutating subagent requires an isolated Git worktree or a
serialized exclusive workspace lease. The preferred design creates a detached
or branch-bound worktree through the reviewed Git worktree adapter, records
base commit and dirty-state requirements, and merges results as a patch through
the parent's ordinary edit/permission pipeline.

Two subagents never mutate the same physical worktree concurrently. Robin's
lease coordinates Robin processes but cannot prevent external editors; all
preconditions still apply.

### 15.11 Subagent result and lifecycle

The coordinator persists `SubagentStarted` before child work. Child events live
in a linked child stream with parent correlation IDs. The child returns a
schema-validated result containing summary, evidence references, changed-path
manifest, verification, usage, and unresolved effects. Parent context receives
the released summary, not the entire child transcript unless requested under
budget.

Cancellation propagates parent to child, then child invocation/tools/processes.
A child with an uncertain effect prevents the parent from claiming success.
Recursive spawning is disabled by default and requires an explicit maximum
depth, total-agent limit, aggregate budget, and permission ceiling.

### 15.12 Extension tests

Extension tests cover manifest limits and hashes, trust changes, namespace
conflicts, hook ordering, hook timeout and invalid output, secret-free
environments, skill routing and progressive load, MCP framing and protocol
adversaries, capability-schema changes, remote uncertain effects, and subagent
permission/context isolation. Fake hook processes, MCP servers, and child
coordinators expose deterministic pause points for cancellation and crash
tests.

## 16. Cancellation, backpressure, and concurrency

### 16.1 Structured cancellation tree

Cancellation is a tree of owned scopes:

```text
application lifetime
  session lifetime
    foreground turn
      prompt assembly
      model invocation
        provider transport attempt
      tool call
        permission wait
        process / workspace / Git / MCP execution
      hook invocation
    subagent coordinator
      child turn and child effects
```

Each scope has an `AbortSignal`, typed reason, request time, deadline, and parent
scope. Child cancellation cannot cancel its parent. Parent cancellation reaches
every child. Libraries that ignore `AbortSignal` are wrapped by an adapter that
can close their underlying transport or process; otherwise the capability
manifest declares cancellation unsupported.

### 16.2 Cancellation durability

User cancellation first appends `TurnCancellationRequested`. The coordinator
then aborts active scopes. It appends the terminal `TurnCancelled` only after
every started operation has a completed, failed, cancelled, or uncertain
settlement. A terminal UI exit does not falsely imply the provider or process
stopped.

Cancellation while waiting for permission resolves that wait as cancelled,
invalidates the approval ID, and executes nothing. Cancellation during prompt
assembly closes opened context streams. Cancellation after a tool has settled
does not undo it automatically; Robin records the effect and cancels subsequent
work.

### 16.3 Timeouts

Timeouts are typed cancellation reasons, not generic race failures. Separate
budgets apply to provider connect, first byte, idle stream, total invocation,
permission wait, hook, MCP request, process wall time, graceful process
termination, lock acquisition, and local store I/O.

Every timer uses an injected monotonic clock. Timers are cleared at settlement.
A timeout cannot turn a known completed response into failure merely because a
callback ran late; the state machine checks terminal ownership atomically.

### 16.4 Stream backpressure

Every producer/consumer boundary has a bounded queue measured in events and
bytes:

- provider transport to stream validator;
- stream validator to CAS spool and live event hub;
- child stdout/stderr to spool and renderer;
- application events to each renderer/client;
- MCP transport to message parser;
- session replay to query consumer.

The durable spool is the primary consumer for semantic bytes. Rendering is a
loss-tolerant secondary view: if it falls behind, text/process deltas coalesce
and the renderer receives a refresh from sealed content. Approval, error, and
terminal events are lossless and use a reserved control lane.

When a source supports pause, Robin pauses reads at the high-water mark and
resumes below the low-water mark. When it does not, Robin continues bounded
spooling up to an absolute limit, then aborts the operation with
`response_too_large` or `output_limit_exceeded`. It never accumulates an
unbounded array of chunks.

### 16.5 Event hub semantics

The live event hub assigns an in-process order after durable sequence or source
sequence. Subscribers declare a queue budget and whether they are critical.
The session store and effect coordinator are not event-hub subscribers; they
are called directly at semantic barriers, so a dropped UI subscription cannot
lose durability.

A future editor client reconnects with the last durable sequence and receives a
projection plus current live state. It does not request replay of transient
chunk timing.

### 16.6 Concurrency policy

Initial concurrency is intentionally narrow:

- one writer process per session;
- one foreground turn per session;
- one provider invocation active in that turn;
- one consequential tool execution at a time;
- concurrent drain of stdout and stderr for one process;
- bounded background indexing only through read leases and cancellable budget;
- independent sessions may run concurrently when workspace leases permit.

The tool scheduler uses concurrency classes. `workspace_write`, `process`,
`git_write`, and `network` serialize initially. Pure `session_read` operations
may later run in parallel only when the provider emits independent calls, the
tool declares snapshot-safe reads, results retain provider order, and the
parallel path passes race tests.

### 16.7 Workspace leases

A Robin workspace coordinator records read and write leases keyed by physical
workspace identity. A write lease prevents another Robin session from starting
a mutating tool in the same worktree. A read lease may coexist until a write is
prepared, at which point the writer waits or asks the user to cancel conflicting
Robin work.

Leases do not claim control over non-Robin processes. File and Git preconditions
remain mandatory. Separate Git worktrees receive separate mutation leases but
share a common-directory Git-ref coordinator for ref writes.

### 16.8 Fairness and starvation

The scheduler uses FIFO within a session and bounded round-robin across
background tasks. UI control events and cancellation bypass data queues. A
large search, process output stream, index build, or session export cannot
starve permission responses or terminal restoration.

### 16.9 Race tests

Deterministic schedulers pause before and after every state transition,
append, approval, precondition check, spawn, rename, and terminal callback.
Tests enumerate cancellation at each pause, double completion, late provider
events, simultaneous resize/output, approval response after cancellation, lock
loss, and competing workspace sessions. The invariant is exactly one terminal
settlement for each invocation and execution, with no effect after denial or
cancel-before-dispatch.

## 17. Security architecture and claims

### 17.1 Threat actors and protected assets

Robin assumes repository content, model output, tool output, and extensions may
be malicious. It also accounts for a curious provider, compromised dependency,
another local process running as the same user, accidental user approval, and
corrupt local storage.

Protected assets include:

- provider and extension credentials;
- source code and private repository content;
- files outside approved roots;
- Git history, index, refs, and pre-existing changes;
- session transcript and attachments;
- command authority and network reachability;
- approval and trust records;
- integrity of displayed tool scope and execution evidence;
- provider budget and paid usage.

Robin does not claim to protect against an administrator/root compromise, a
fully compromised same-user process on platforms without isolation, malicious
firmware, or a provider that violates its own service guarantees.

### 17.2 Enforcement boundary matrix

| Risk | Primary enforcement | Secondary evidence/mitigation |
| --- | --- | --- |
| Prompt injection invokes a tool | Complete structured call plus tool pipeline | Instruction provenance and tool allowlist |
| Path escapes workspace | Physical path boundary and operation preconditions | Sandbox writable-root restriction |
| Model runs an unapproved command | Permission decision bound to normalized request | Process sandbox and exact execution receipt |
| Command reads API key | Credential excluded from child environment | Child sandbox and secret scanning |
| Provider receives unrelated files | Prompt selected-item manifest and context release | Provider request audit hashes and egress UI |
| MCP server performs external effect | Server-scoped permission and approval | Operation ID reconciliation when supported |
| Repository installs executable behavior | Project trust capabilities | Manifest hashes and sandboxed hooks |
| User approval is swapped | Decision/request/precondition/display hashes | Pure UI reducer and stale-response rejection |
| Crash repeats an effect | Prepare/start/settle protocol and replay | Adapter reconciliation |
| Session file is torn or edited | Frame commit marker, checksum, hash chain | Private permissions and quarantine |
| Dependency/update is replaced | Lockfile, checksums/signatures, build provenance | Reproducible release and update verification |

### 17.3 Prompt injection posture

Robin cannot guarantee a model will ignore malicious instructions in code,
issues, test output, or MCP resources. Its security boundary therefore does not
depend on model obedience. Untrusted content can cause a model to propose a bad
tool call, but the call still faces schema, normalization, permission,
preconditions, sandbox, and user display.

Robin labels untrusted context and minimizes authority-bearing prose. It never
parses free-form model text into a shell command or implicit approval. Sensitive
operations expose precise structural tools where possible. Tool results are
released with bounded content so malicious output cannot directly rewrite
system instructions.

### 17.4 Data egress

Provider inference is an explicit egress path. Before first use of a provider
profile, Robin shows endpoint origin, credential strategy, configured retention
request, and whether a proxy is active. Each request has a selected-context
manifest available for inspection. Network tools and remote MCP servers are
separate egress principals and permissions.

Network sandboxing of child commands is enforced only where the platform
adapter reports it. Permission rules alone cannot prove a general shell command
will avoid network access. Robin labels this distinction.

### 17.5 Credential containment

Secrets stay in platform credential storage or a bounded in-memory lease. The
parent does not put them in global environment variables. Provider adapters
redact request headers before diagnostics. HTTP libraries are configured not to
trace authorization headers or full bodies through generic debug logging.

Secret scanning at serialization boundaries is defense in depth, not the only
control. It uses exact active-secret fingerprints and known credential shapes
without writing matched values into diagnostics. A match rejects the unsafe
event or log record.

### 17.6 Filesystem and process boundaries

Path checks constrain Robin file tools. A shell process can attempt broader OS
access, so its actual boundary is the command sandbox plus operating-system user
permissions. When sandboxing is unavailable, approval explicitly states that
the command has the user's ambient filesystem authority minus stripped
environment credentials.

Workspace files may be executable, compilers may execute build scripts, and
tests run repository code. Verification commands are therefore consequential
process actions even when their source text appears harmless.

### 17.7 Supply-chain security

Release inputs use a committed lockfile, exact toolchain versions, dependency
review, vulnerability scanning, license inventory, and build provenance.
Published artifacts are checksummed and signed through the release channel's
supported mechanism. `robin --version --json` exposes build and channel IDs;
`doctor` verifies installed artifact provenance when metadata is available.

Provider adapters and executable extensions declare their dependency and
network surface. Automatic updates never activate changed executable bytes
inside an open session. A rollback keeps state-format compatibility checks.

### 17.8 Security failure behavior

Security-sensitive parser, policy, trust, credential, path, sandbox, and
integrity errors fail closed for the affected capability. Robin may continue in
a narrower read-only mode when doing so cannot hide the failure. It shows which
capability was disabled and why.

No catch-all handler converts an unknown security error into allow. Error
messages avoid raw provider bodies, file content, environment values, and
credentials. Detailed local diagnostics contain safe hashes and correlation
IDs.

### 17.9 Claim verification

Every security claim maps to a test and a runtime capability report. Release
documentation distinguishes:

- deterministic client permission enforcement;
- best-effort or descriptor-strong path containment;
- per-command sandbox availability by OS;
- local data permissions versus optional encryption;
- provider retention requests versus provider-controlled behavior;
- Robin process coordination versus external-process races.

Features whose enforcement test is missing or skipped on a platform are not
advertised as enforced on that platform.

## 18. Platform adapters and support tiers

### 18.1 Platform port

```ts
interface RobinPlatform {
  readonly descriptor: PlatformDescriptor;
  readonly paths: PlatformPathService;
  readonly filesystem: PlatformFilesystem;
  readonly locks: PlatformLockService;
  readonly processes: PlatformProcessService;
  readonly signals: PlatformSignalService;
  readonly terminal: PlatformTerminalService;
  readonly credentials: PlatformCredentialService;
  readonly sandbox: PlatformSandboxService;
  readonly keyIdentity: PlatformFileIdentityService;
}
```

The descriptor reports OS, architecture, filesystem behavior probes, terminal
features, available credential backend, path containment tier, process-group
support, sandbox enforcement, directory-flush behavior, atomic rename behavior,
and tested Robin version. Feature code branches on capabilities rather than OS
name alone.

### 18.2 macOS adapter

The macOS target uses Application Support/Caches/Logs directory conventions,
Keychain for stored credentials, process groups for child supervision, and a
Seatbelt sandbox adapter when present and tested. Filesystem probes cover APFS
case-sensitive and case-insensitive volumes, Unicode normalization, clones,
symlinks, and directory flush limitations.

Signing and notarization are release concerns. A signed binary's identity is
included in doctor output. Keychain prompts are initiated only by explicit auth
or provider actions, not background rendering.

### 18.3 Linux adapter

The Linux target follows XDG directories, supports Secret Service when a usable
session backend exists, and otherwise offers documented environment/ephemeral
credential modes. Process supervision uses a new process group and, where
available, pidfds or process-start identity from `/proc` to avoid PID reuse.

The stronger sandbox profile uses user/mount/network namespaces through a
tested bubblewrap adapter plus resource controls and optional seccomp. Robin
probes unprivileged namespace availability rather than assuming a Linux kernel
enables it.

Filesystem tests cover ext4 and at least one copy-on-write filesystem in CI or
release qualification, plus case sensitivity, bind mounts, symlinks, hard
links, and network-filesystem degradation where supported.

### 18.4 Windows and WSL

Native Windows is not declared equivalent until path containment, job-object
process trees, atomic replace, file sharing, console input, credential manager,
Git path behavior, and sandbox claims pass dedicated suites. Early Windows
users may run the Linux build under WSL with the workspace inside the WSL
filesystem for documented semantics.

Robin detects Windows-mounted filesystems under WSL and reports degraded rename,
permission, case, and performance behavior. It does not silently claim Linux
filesystem guarantees for `/mnt` paths.

### 18.5 Terminal capability tiers

Terminal probing identifies TTY presence, color depth, Unicode, hyperlinks,
bracketed paste, cursor-addressed rendering, alternate screen preference,
keyboard protocol support, and width behavior. The product works at three
tiers:

- rich interactive renderer;
- basic ANSI interactive renderer;
- plain append-only renderer.

Color and animation obey environment and user accessibility preferences. Core
actions remain available without color, mouse, or cursor-addressing support.

### 18.6 Packaging boundary

The distributed executable includes or pins the JavaScript runtime strategy,
Robin code, schemas, migrations, and required native helpers. Optional tools
such as Git, `rg`, sandbox backends, and credential services are probed with
version and identity. Robin never downloads or executes a missing helper during
an ordinary coding turn without a separate installation workflow and approval.

Install, upgrade, and uninstall preserve a strict separation between executable,
configuration, durable sessions, credentials, cache, logs, and recoverable
worktrees. Uninstalling the binary does not imply deleting user data or
credentials.

### 18.7 Platform conformance

Each supported target runs the shared contract suite plus platform-specific
path, locking, signal, process tree, terminal, keychain, sandbox, and atomic-I/O
tests. `doctor` uses the same capability probes as runtime construction so its
report cannot diverge from actual feature gating.

## 19. Observability, privacy, and diagnostics

### 19.1 Observable facts

Robin records facts needed to understand coding work without storing fabricated
hidden reasoning:

- session, turn, invocation, provider attempt, tool call, permission, execution,
  hook, MCP, and subagent correlation IDs;
- state transitions and durations;
- provider/model/adapter identifiers and tested capabilities;
- prompt item hashes, categories, byte/token counts, and omission reasons;
- tool IDs, normalized safe summaries, decision effects, and precondition hashes;
- process executable/cwd label, exit facts, output counts, and sandbox tier;
- changed paths with before/after hashes and attribution state;
- Git HEAD/index/status evidence;
- usage, estimated cost under a versioned price table, and budget remaining;
- errors, retry decisions, cancellation reasons, recovery actions, and truncation.

Robin does not present or persist private chain-of-thought. User-visible progress
summaries derive from observable actions and provider-visible assistant content.

### 19.2 Diagnostic sink

```ts
interface DiagnosticSink {
  emit(event: SafeDiagnosticEvent): void;
  flush(signal: AbortSignal): Promise<void>;
}

interface SafeDiagnosticEvent {
  readonly schemaVersion: 1;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly component: string;
  readonly code: string;
  readonly message: string;
  readonly correlation: SafeCorrelation;
  readonly attributes: Readonly<Record<string, SafeDiagnosticScalar>>;
  readonly recordedAt: string;
}
```

Attributes reject arbitrary nested objects, bytes, headers, prompts, and file
content. Components register allowed keys and redaction classifications. An
unknown object is summarized by type and safe error code rather than stringified.

### 19.3 Local logs

Local diagnostic logs are disabled or minimal by default according to release
policy. When enabled, they use rotating size/time bounds, private permissions,
versioned JSON Lines, and a retention limit. Session semantic events remain in
the session store; logs do not duplicate full prompts, source files, diffs, or
process output.

Crash reports contain Robin build, platform capability report, safe stack
frames, state names, and correlation IDs. They exclude environment dumps,
request bodies, terminal history, credentials, and raw repository paths unless
the user explicitly creates a local diagnostic bundle with reviewed contents.

### 19.4 Metrics and usage

In-process metrics include counters and histograms for startup, first render,
prompt assembly, provider latency, stream throughput, tool latency, approval
wait, process output, event append/flush, snapshot/replay, errors, retries, and
cancellation. Labels use bounded enumerations and coarse component IDs; session
IDs, paths, prompts, model output, and credential references are not metric
labels.

Usage accounting stores provider-reported dimensions and Robin estimates
separately. Cost uses a price-catalog ID, effective date, currency, and formula.
Unknown pricing is displayed as unknown, never zero.

### 19.5 Telemetry

Remote telemetry is opt-in and disabled until an explicit product decision,
privacy review, endpoint policy, payload schema, deletion process, and tests
exist. Enabling telemetry requires trusted user configuration; a project cannot
enable or redirect it. The preview command shows a representative payload and
current destination.

Telemetry transport uses its own credential and egress principal. Failure never
blocks the coding turn, and queued payloads obey disk bounds and retention.

### 19.6 Doctor and diagnostic bundles

`robin doctor` reports install provenance, directories and permissions,
configuration sources, project trust, Git and `rg`, terminal tier, provider
profile validity, credential-backend availability, sandbox/path capability,
session-store health, extension status, and relevant limits. Network probes are
off by default or individually labeled.

A diagnostic bundle is created locally, lists every included file/category,
applies secret and path redaction, and requires user review before upload. Robin
does not implement an automatic support upload as part of failure handling.

## 20. Performance and resource architecture

### 20.1 Qualification budgets

These are release-qualification budgets, not claims about the current fixture
CLI. They are measured on documented reference hardware, with warm and cold
filesystem results reported separately and network time excluded where stated.
For the three startup/reopen gates below, the reference target is the product
objective on named reference hardware and the CI ceiling is the hard regression
limit on the controlled CI runner; a release records and satisfies both.

| Interaction | Reference target at p95 | CI ceiling at p95 | Measurement boundary |
| --- | --- | --- | --- |
| Warm `robin --help` / `--version` | 150 ms | 250 ms | process start to complete stdout; no provider, repository, credential, or session construction |
| Cold interactive prompt, configured user | 500 ms | 750 ms | process start to usable composer, excluding keychain prompt and provider contact |
| Resume 10,000 events with a valid head snapshot | 250 ms | 500 ms | process start to exact transcript/status projection without full CAS content load |

Additional local release targets use one p95 gate until reference/CI pairs are
calibrated on the supported matrix:

| Interaction | Target at p95 | Measurement boundary |
| --- | --- | --- |
| Keystroke update | 16 ms | decoded key to completed render write |
| Provider delta display | 50 ms | normalized delta received to render write under nominal load |
| Cancellation acknowledgement | 100 ms | key event to visible `cancelling` state |
| Replay 10,000 small events without snapshot | 2 s | validated scan plus reducer projection |
| Permission prompt display | 100 ms | durable approval request to complete rendered prompt |
| Search first results | 500 ms | dispatch to first bounded result on a medium repository |
| Local event append without forced flush | 10 ms | append call to committed in-process publication |
| Semantic barrier append with flush | reported, no hidden target | platform-dependent durable flush measured separately |

Performance tests run with terminal rendering captured by a PTY sink and with a
slow renderer to exercise backpressure. Provider latency never counts as Robin
startup time or local prompt assembly.

### 20.2 Default resource limits

Defaults are conservative and configurable within hard implementation ceilings.
Every terminal result reports a limit that caused truncation or failure.

| Resource | Initial default design budget |
| --- | --- |
| Piped stdin | 1 MiB and 30 seconds to EOF |
| One instruction file | 256 KiB |
| All instruction metadata/body in one invocation | 1 MiB |
| One ordinary source read returned to model | 1 MiB |
| Aggregate `read_many` result | 4 MiB |
| Search matches | 1,000 matches, 2 MiB released bytes, 30 seconds |
| Tool argument bytes | 1 MiB per call |
| Unified patch proposal | 2 MiB, 100 files, 1,000 hunks |
| Provider content item | 8 MiB sealed bytes |
| Provider response aggregate | 32 MiB before forced abort |
| Process output retained | 4 MiB per stream |
| Process output absolute drain | 64 MiB aggregate before termination |
| Ordinary command wall time | 30 minutes unless exact profile overrides |
| Durable JSON event payload | 1 MiB; larger content moves to CAS |
| One session CAS object | 128 MiB unless a typed artifact profile allows more |
| Live queue | per-source byte and control-event limits, never item-count only |
| Session snapshot interval | event and byte thresholds, never during active effect |

Hard ceilings exist to prevent a project file from configuring unbounded
allocation. Increasing a model context limit does not automatically increase
file, process, CAS, event, or tool-input limits.

### 20.3 Startup strategy

Help and version paths load no provider SDK, project configuration, schema
catalog, Git state, or session index. Interactive startup renders a boot frame
after minimal terminal probing, then loads configuration, workspace, and
session metadata concurrently where dependencies permit.

Provider adapters, tool schemas, skills, MCP clients, search indexes, and old
transcript rows load lazily. Lazy loading is deterministic: the configuration
snapshot records installed component identities before a turn starts, and a
load failure disables the component before it is advertised.

### 20.4 Memory behavior

All file, provider, process, MCP, export, and replay content is streamed through
bounded buffers. Large assistant text and output are spooled to CAS; UI state
keeps bounded recent render rows. Prompt assembly uses references and streams
bytes into the provider serializer rather than duplicating the complete context
through multiple strings.

The application exposes current queue sizes, spool bytes, transcript projection
size, and context assembly allocations in debug metrics. A sustained bound
violation aborts the source with a classified failure rather than relying on
the JavaScript heap limit.

### 20.5 Repository indexing

The first usable release can operate through deterministic list/search/read
without a persistent semantic index. Optional indexing is incremental,
cancellable, lower priority than the foreground turn, and keyed by workspace
identity plus file content hashes. Index databases are caches and can be
deleted or rebuilt.

Indexing respects discovery ignores, classification, file-size limits, symlink
rules, and project trust. An embedding index requires a separately configured
local or remote embedding provider; remote indexing is explicit data egress and
never starts automatically because a provider supports embeddings.

### 20.6 Provider request efficiency

Prompt item hashes enable provider-native cache controls only when the adapter
declares tested semantics. Cache controls never cause Robin to omit semantic
history from the local request plan. Repeated tool schemas and trusted
instructions have stable canonical serialization so provider caching can be
effective.

Context is acquired on demand through tools. Robin favors targeted reads and
diffs over repeated full files, but it never sends a stale cached file under a
current-path label. Usage and cost budgets can stop before the next invocation;
they cannot revoke a provider request already accepted.

### 20.7 Performance regression tests

Benchmarks use fixed repository corpora, event logs, provider streams, output
floods, and terminal dimensions. CI records distributions and compares against
a reviewed baseline with noise tolerance. A regression that crosses a release
budget blocks release or requires a documented budget change; deleting work or
weakening validation is not an accepted optimization.

## 21. Integration of the existing `@guard` substrate

### 21.1 Product hierarchy

The existing runtime work remains valuable because it provides deterministic
contracts, policy evaluation, context release, capability dispatch, and replay
patterns. Robin integrates those primitives behind the coding workflow. A user
starts a session and asks for a code change; the user does not construct a task
profile, select a deterministic scenario, or reason about a generic run kernel.

The architecture avoids two opposite errors:

- discarding tested substrate and rebuilding every boundary without evidence;
- forcing an interactive coding conversation into abstractions designed for a
  fixture-oriented general runtime.

### 21.2 Canonical ownership

Robin session events are the canonical product history. The pure Robin session
reducer owns session, turn, invocation, permission wait, tool execution,
configuration snapshot, and recovery state. It is not a thin projection of a
legacy `RunState`.

The existing runtime kernel may execute a bounded internal workflow and emit
validated runtime facts. Those facts are adapted into a Robin event payload or
linked evidence stream with session/turn correlation. There is one externally
visible terminal state for the Robin turn. Two reducers never independently
decide that the same effect completed.

### 21.3 Reuse adapters

| Robin boundary | Existing substrate | Integration |
| --- | --- | --- |
| IDs, canonical serialization, errors | `@guard/contracts` | Extend with Robin-branded IDs and safe error codes; retain canonical JSON/hash behavior |
| Boundary JSON validation | `@guard/schema-validation` | Compile closed schemas for events, tools, config, extensions, and provider payloads |
| Synthetic provider and provider port | `@guard/model-provider` | Evolve the port to the normalized streaming contract and retain deterministic provider fixtures |
| Scripted planning fixtures | `@guard/agent-driver` | Keep scripted driver for agent-loop tests; direct-model orchestration lives in `robin-agent` |
| Tool normalization and one-use execution | `@guard/capability-gateway` | Wrap Robin tool definitions through an adapter; add async lifecycle and precondition/settlement evidence |
| Permission policy | `@guard/policy-engine` and `@guard/policy-language` | Compile product modes and declarative rules to normalized decisions; keep advanced `.guard` debugger |
| Context classification/release | `@guard/context-broker` | Mediate source and tool-result items selected by `robin-prompt` |
| Pure transition patterns | `@guard/runtime` | Reuse reducer discipline and legal-state testing; do not reuse its session-incompatible aggregate blindly |
| In-memory persistence tests | `@guard/event-store` | Retain fast deterministic adapter; `local-state` owns file framing/locking/recovery |
| Component pinning | `@guard/profile-registry` | Use internally when validating installed component versions in a configuration snapshot |
| Repository adversarial corpus | `@guard/capability-repository` | Test real tool semantics against virtual/path fixtures; do not route real file writes to the virtual pack |
| Milestone scenarios | milestone packages | Preserve as regression gates for substrate invariants, not default CLI commands |

### 21.4 Capability-gateway bridge

`robin-tools` adapts each built-in tool into the existing capability concepts:

```text
sealed provider tool call
  -> Robin schema parser and registry
  -> capability semantic normalization
  -> Robin workspace precondition observer
  -> normalized policy attributes
  -> @guard policy evaluation
  -> Robin interactive approval when required
  -> one-use prepared execution ownership
  -> concrete Robin tool adapter
  -> audit/human/agent released views
  -> context-broker release for next prompt
```

The bridge must not execute inside `normalize` or `release`. A dynamic callback
cannot redirect an agent view to another classification/catalog. Robin adds
session durability around prepare/start/settle because one-use in-memory
ownership alone is insufficient after a crash.

### 21.5 Permission UX over policy internals

Common permission modes are product concepts. `robin-permissions` converts them
and any trusted declarative rules into the attribute catalog expected by the
policy engine. The user sees exact tool/path/command scope and a plain-language
reason. Advanced users can inspect the underlying decision with `robin policy`
or session diagnostics.

Unknown attributes and unavailable preconditions produce deny or ask according
to the explicit safe rule; they never default to allow. Administrator floors
are evaluated separately and cannot be weakened by a session approval.

### 21.6 Context-broker placement

The prompt compiler chooses candidate semantic items. The context broker
enforces source ownership, classification, release policy, media/byte bounds,
and provenance before selected bytes reach the provider request. Tool output
returns through the same release path.

This is internal plumbing. Ordinary users do not configure source catalogs to
read their repository. Built-in workspace source definitions and safe defaults
are installed with Robin; configuration becomes visible only when a policy or
classification changes behavior.

### 21.7 Runtime facts without runtime-centric UX

The existing runtime's event and command discipline informs Robin's execution
coordinator: persist a fact, reduce state, derive commands, execute through an
adapter, then persist observations. Robin adds a longer-lived session aggregate,
interactive waits, streamed content sealing, and local crash recovery.

`RunCompleted` from a bounded internal workflow cannot complete a Robin turn
unless the Robin agent loop also verifies no unresolved tools, seals final
content, and records the changed/verification manifests.

### 21.8 Namespace and migration policy

The public executable, package description, help, documentation, data-directory
label, and product events use Robin terminology. Existing private `@guard/*`
package names and `.guard` policy extension remain until a dedicated migration
can update imports, fixtures, schemas, persisted type IDs, package lock, and
documentation in one reviewed change.

New Robin packages use the canonical physical names in section 3.2. Their npm
scope remains private build metadata until publication policy is decided. No
runtime behavior depends on a future public npm scope.

Unfinished runtime, artifact, filesystem, or worktree prototypes from the
pre-pivot branch are reference material. A component is reused only through a
focused change with current interfaces, threat review, tests, and a truthful
implementation-status update.

### 21.9 Integration acceptance

The substrate is considered successfully integrated when:

- the default `robin` command starts a coding session rather than a fixture;
- one direct provider and the synthetic provider use the same agent loop;
- real workspace/process/Git calls pass the capability/permission pipeline;
- product permission modes produce explainable policy decisions;
- tool results pass context release before provider feedback;
- session replay recovers provider/tool evidence without rerunning either;
- existing deterministic gates still pass or are deliberately versioned with
  reviewed golden changes;
- no default user journey exposes generic runtime configuration as a prerequisite.

## 22. End-to-end data flows

### 22.1 First interactive run with an existing credential

1. `apps/cli` parses `robin` into an interactive request and probes TTY.
2. `robin-application` asks `robin-platform` to discover the physical workspace.
3. `robin-config` resolves defaults, managed, user, trusted project,
   local-project, allowlisted environment, explicit settings-file, and CLI
   sources in canonical order; named profiles remain inside their defining
   scopes and it returns a safe effective-configuration explanation.
4. `model-provider` resolves the installed adapter and cached tested model
   capabilities; the credential service retains only a record reference.
5. `local-state` creates the session directory, writer lock, file header, and
   first committed session/config/workspace events.
6. `robin-terminal` renders repository label, branch, model, permission mode,
   sandbox/path tier, and composer.
7. The developer's submitted bytes are normalized as text, stored, and committed
   in `UserSubmissionAccepted` before provider transport.
8. `robin-agent` starts the turn and asks `robin-prompt` for a plan.
9. Context sources release selected instructions, workspace synopsis, and
   transcript items. The prompt plan and request hash are committed.
10. The provider transport leases the credential for the configured endpoint,
    sends the request, and emits normalized stream events.
11. Assistant deltas render live; the complete content is sealed to CAS and the
    durable event log.
12. A response without tool calls is finalized with usage and manifests; the UI
    returns to ready.

### 22.2 Read, edit, and test turn

1. The provider seals `search_text` arguments.
2. `robin-tools` validates schema, normalizes workspace scope, captures search
   limits, and resolves the advertised version.
3. The permission engine allows the bounded read. Prepared/start evidence is
   committed and the workspace search executes.
4. Matches are bounded, sealed, released through the context broker, and
   included in the next provider invocation.
5. The provider requests exact source reads. Each response includes content
   hash and identity.
6. The provider emits an `apply_patch` call bound to the observed preimage.
7. The edit pipeline parses the patch, materializes desired bytes, observes
   current state, and asks permission under default mode.
8. The UI displays exact diff and request hash. The user's allow-once response
   is committed and bound to current preconditions.
9. The edit adapter revalidates, journals, atomically replaces, verifies, and
   records the changed path.
10. The released result returns to the provider; it requests a targeted test
    through direct exec or an explicitly shown shell command.
11. The process pipeline shows cwd, environment/sandbox facts, and command. On
    approval it spawns, streams bounded output, reaps the group, and records exit
    evidence plus workspace changes.
12. A failing test observation is returned. The model may re-read and make
    another conflict-checked edit.
13. The final assistant message summarizes observable changes and verification.
    Robin independently renders the actual changed-path and test manifests.

### 22.3 Denied process with continued reasoning

1. The normalized process request receives an ask decision.
2. The developer denies it without cancelling the turn.
3. Robin commits the denial and sends a bounded observation naming the denied
   operation and safe reason.
4. The model may propose a read-only alternative or finish with an unverified
   result. It cannot resubmit an equivalent command indefinitely because the
   turn has denial and malformed/repetition budgets.
5. The final manifest says verification was not run and why.

### 22.4 Crash after an edit rename

1. The edit batch journal and `ToolExecutionStarted` are durable.
2. The target rename succeeds, then the process crashes before settlement.
3. On resume, `local-state` repairs only an incomplete event-log tail and replays
   the valid started execution.
4. Reconciliation reads the edit journal and compares current target hash with
   desired and preimage hashes.
5. An exact desired hash proves the local effect completed; Robin appends a
   recovered settlement with reconciliation evidence.
6. A preimage hash proves no effect; Robin records known failure/abandonment.
7. Any third hash indicates external conflict. The session enters recovery-
   required state and mutation stays disabled until reviewed.

### 22.5 Crash during a provider stream

1. Provider attempt start is durable and some assistant bytes may have been
   sealed as partial content.
2. After restart Robin cannot assume the remote generation stopped or completed.
3. If the adapter has a documented response retrieval/status mechanism and the
   provider response ID is durable, it reconciles without resending.
4. Otherwise the invocation is outcome-uncertain. Robin displays the partial
   content and offers a new explicitly billed invocation using the semantic
   transcript.
5. It never silently repeats the original request as replay.

### 22.6 Headless JSON Lines run

1. The CLI parses prompt, bounded stdin, schema, permission mode, and output
   format without enabling terminal raw mode.
2. A normal local session is created or selected so durability matches
   interactive mode.
3. Canonical live and terminal events are mapped to versioned JSON Lines.
4. An ask permission result becomes denial unless an exact preconfigured rule
   allows it; no read from `/dev/tty` occurs.
5. The final result is schema-validated, written to stdout, and followed by no
   human prose. Diagnostics remain typed JSON or stderr according to the chosen
   contract.
6. Exit code derives from the durable turn terminal state.

### 22.7 Resume after workspace changed externally

1. The session log validates and the writer lock is acquired.
2. Workspace identity matches, but HEAD, branch, dirty state, or observed file
   hashes differ from the last checkpoint.
3. Robin records a fresh workspace observation and invalidates stale context,
   approvals, edit inverses, and provider prompt caches.
4. It shows the changes before accepting mutation. The conversation remains
   readable.
5. A new turn includes the current workspace synopsis. Every subsequent edit
   requires a fresh read/preimage.

### 22.8 Switch provider between turns

1. The current turn is terminal and no effect is unsettled.
2. Robin validates the new adapter, endpoint, credential record, exact model,
   tool capabilities, and context limit.
3. The prompt compiler checks that semantic transcript can be represented
   without provider-private continuation items. If not, it creates an
   inspectable compaction/fork boundary.
4. A new configuration snapshot records the switch and continuity mode.
5. The next provider receives Robin's semantic transcript, not the old API key
   or opaque state it cannot interpret.

### 22.9 Trusted MCP tool call

1. Session configuration pins the server manifest and capability snapshot.
2. Prompt assembly advertises the namespaced, schema-validated tool.
3. A model call enters the normal registry and permission pipeline.
4. The approval identifies local server executable or remote origin and the
   declared effect class.
5. Robin sends one protocol request, bounds response, settles outcome, and
   releases model/human views.
6. Lost response to an effectful call invokes MCP reconciliation or stops as
   uncertain; reconnection alone never resends it.

### 22.10 Subagent in an isolated worktree

1. The parent proposes a structured child objective and bounded budget.
2. The user approves worktree creation and the child's permission ceiling.
3. Git adapter creates and verifies the isolated worktree at exact base commit.
4. The child receives released context and runs its own event-linked turn.
5. Its changes and tests produce a result manifest.
6. Parent imports the proposed diff through its normal patch, permission, and
   conflict pipeline. Child mutation authority does not transfer automatically.
7. Cleanup removes the worktree only when Git and filesystem reconciliation
   prove no unexported changes remain; otherwise it is retained and reported.

## 23. Cross-system failure and recovery matrix

The specific subsystem sections remain normative. This matrix defines the
top-level product outcome when failures cross boundaries.

| Failure point | Durable evidence | Automatic action | User-visible recovery |
| --- | --- | --- | --- |
| CLI usage invalid | none required | do not open session | show exact usage and stable exit code |
| Terminal raw-mode setup fails | safe diagnostic | select plain renderer | continue without cursor UI or exit if input impossible |
| Terminal disappears mid-turn | committed session/turn events | continue headless only when configured; otherwise cancel | resume the durable session |
| Workspace absent | configuration diagnostic | no mutation | select another workspace or question-only mode |
| Workspace physical identity changed | old and current identity digests | disable mutation | explicit rebind or fork |
| Git executable missing | capability report | disable Git tools | continue file/process work or install Git separately |
| User config malformed | source diagnostic | no model request | repair with config command/editor |
| Project config malformed | trust/config diagnostic | ignore project executable settings | continue with user settings after warning |
| Project trust changed | prior/new manifest hashes | revoke affected capabilities | review and re-grant specific trust |
| Credential backend locked | record reference only | no secret fallback | unlock backend or choose ephemeral/environment source |
| Credential rejected | provider failure/request ID | stop unchanged retries | replace or validate credential |
| Provider endpoint DNS/connect fails before acceptance | provider attempt | bounded retry if contract proves safe | retry later or switch provider |
| Provider rate limited | attempt and retry-after | cancellable bounded backoff | wait, stop, or change provider/model |
| Provider stream drops after response begins | partial sealed content | reconcile when supported | explicit new invocation; original remains uncertain |
| Provider violates stream protocol | exact safe protocol diagnostic | abort transport | adapter/provider update or switch |
| Context required item missing | CAS/source error | no request sent | restore data, re-read, or fork without continuity claim |
| Prompt exceeds context | budget receipt | compact/omit only optional items | select model or start/fork session |
| Unknown model tool | sealed call bytes/hash | never execute | return bounded tool error and continue within budget |
| Tool JSON malformed | sealed bytes and parser code | never execute | model may correct; repetition limit applies |
| Path escapes workspace | normalized rejection evidence | deny | choose an explicit allowed workspace/root |
| File changes before approval | old/new precondition hashes | invalidate request | model re-reads and proposes current patch |
| File changes after approval | revalidation conflict | do not dispatch | repeat review against new content |
| Disk full before event flush | prior committed sequence | stop writer/effects | free space and recover torn tail |
| Disk full after temp edit write | edit prepared state | remove uninstalled temp when safe | retry after space is available |
| Crash after one batch path applied | edit journal progress | hash-based reconcile | complete, rollback eligible paths, or preserve conflict |
| Process fails before spawn | prepared record | settle known non-effect | correct executable/configuration |
| Process times out | started record/output | terminate group and reap | inspect sealed output and rerun explicitly |
| Process descendant survives termination | process identity/sandbox evidence | mark cancellation incomplete | recovery-required; user kills verified process or restarts environment |
| Sandbox required but unavailable | capability probe | do not run command | install/enable sandbox or deliberately choose weaker mode |
| Process changes unexpected files | before/after Git status | invalidate observations | review changed paths; no automatic revert |
| Git HEAD changes before commit | prepared Git preconditions | abandon commit | regenerate review on new HEAD |
| Git index changes during staging | before/after index hashes | do not overwrite external index | inspect/reconcile manually or retry from clean state |
| Commit process response lost | Git effect start | inspect HEAD/reflog/tree/message | settle exact commit or stop uncertain |
| Git hook fails | hook/process output and Git state | reconcile index/HEAD | review hook result and resulting state |
| Session lock held by live process | lock identity | refuse second writer | connect to existing task or wait |
| Session lock liveness unknown | lock and probe diagnostic | refuse automatic steal | explicit force-unlock after inspection |
| Event log torn tail | valid chain plus tail bytes | quarantine tail and truncate last incomplete frame | continue after `TailRepaired` report |
| Event log middle corruption | valid prefix and corrupt offset | quarantine session | restore backup or fork from proven prefix |
| CAS object corrupt | reference and hash mismatch | quarantine object | restore exact object or lose affected resume capability visibly |
| Snapshot corrupt | event log remains authoritative | discard snapshot and replay | no semantic loss; rebuild snapshot |
| Hook observer fails | hook execution result | continue only if declared fail-open | warning and hook diagnostics |
| Hook security validator fails | hook failure | fail closed | repair/disable subject to policy floor |
| MCP server fails to start | process/protocol diagnostic | disable server | continue without its tools or fix configuration |
| MCP effect response lost | call/start record | reconcile only with supported operation ID | stop uncertain and inspect external system |
| Subagent fails read-only | child terminal result | parent may continue | use partial released evidence or retry explicitly |
| Subagent mutation uncertain | child/worktree evidence | block parent success/mutation merge | inspect isolated worktree and reconcile |
| User cancels permission wait | cancellation and invalidated decision | execute nothing | continue or end turn |
| User force-exits during cancellation | request and unsettled records | synchronous terminal restore only | next open runs reconciliation |
| Observability sink fails | safe in-memory diagnostic when possible | disable noncritical sink | coding continues; durable session events remain authority |
| Telemetry fails | bounded telemetry queue only | drop/retain by policy | no impact on coding turn |
| Unsupported newer state format | format header | open no writer | upgrade Robin or export with compatible version |

## 24. Testing architecture and evidence

### 24.1 Test principles

- Probabilistic model behavior is replaced by scripted provider events in
  deterministic tests.
- Every consequential boundary exposes a fake and a real adapter contract.
- Tests assert durable events, reducer state, observable output, and real side
  effects separately.
- Default test commands require no network, real API key, user keychain, or
  mutation of the developer's repository.
- Time, IDs, jitter, scheduling, terminal dimensions, filesystem failures, and
  provider chunking are injected.
- A skipped enforcement test means the capability is disabled or unclaimed on
  that target; it is not counted as passing evidence.

### 24.2 Test layers

| Layer | Scope | Representative evidence |
| --- | --- | --- |
| Pure unit | parsers, reducers, normalizers, budget math, render model | exact inputs/outputs and illegal-transition rejection |
| Property | paths, event sequences, frame bytes, config precedence, patch hunks | invariants over generated adversarial cases |
| Fuzz | CLI args, JSON/schema, provider streams, MCP frames, event logs, diffs | no crash, hang, excessive allocation, or boundary bypass |
| Contract | provider, tool, platform, credential, store, hook, MCP ports | every adapter satisfies shared behavior |
| Integration | temporary workspaces/repositories, process trees, local HTTP/MCP fakes | real filesystem/Git/process effects and cleanup |
| PTY | interactive input, resize, approvals, interrupts, terminal restore | byte-level terminal transcript plus reducer state |
| Crash/recovery | fault-injected append, rename, process/Git/edit pause points | exact reopened state and no duplicate effect |
| End-to-end synthetic | installed `robin` executable with scripted provider | complete user journeys and stable exit/output contracts |
| Live smoke | opt-in provider credentials and disposable repository | minimal compatibility check, never default CI |
| Performance | fixed corpora and reference hardware | distributions against section 20 budgets |
| Release | packed artifact/install/upgrade/uninstall/provenance | behavior from shipped bytes, not source workspace |

### 24.3 Deterministic seams

| Concern | Injected port |
| --- | --- |
| Time and deadlines | wall and monotonic `Clock` |
| IDs and nonces | cryptographic production `IdSource`, deterministic test source |
| Provider network | `HttpTransport` and scripted async event source |
| Token count | exact/estimated `Tokenizer` |
| Filesystem | `PlatformFilesystem` plus fault-injection implementation |
| File identity/containment | `PlatformFileIdentityService` |
| Process tree | `PlatformProcessService` and deterministic fake supervisor |
| Git | real disposable repository plus invocation-capturing fake |
| Keychain | in-memory sentinel credential backend |
| Terminal | virtual terminal byte source/sink and PTY harness |
| Locks/liveness | lock backend and process identity probe |
| Scheduler | deterministic task scheduler with named pause points |
| Checksums/hashes | production cryptography plus test collision/error injection |
| Diagnostics | capturing safe diagnostic sink |
| Sandbox | capability-reporting fake and platform integration adapter |

### 24.4 Reducer and event tests

Session and UI reducers have exhaustive transition tables. Tests cover every
legal state/event pair and confirm illegal pairs return typed invariant errors
without partial mutation. Event round trips validate canonical serialization,
unknown fields, version rejection, immutable capture, hash stability, and
replay equivalence with and without snapshots.

Model-based tests generate sequences of user input, provider events, tool calls,
approvals, cancellation, crashes, and resume. Invariants include one foreground
turn, one terminal invocation outcome, no tool start without prepared and
allowed evidence, no completion with unsettled effects, and monotonically
increasing durable sequence.

### 24.5 Terminal tests

Pure UI tests feed decoded events and assert state/effects/render model. ANSI
snapshot tests normalize only nondeterministic terminal capability fields, not
content. PTY tests cover multiline Unicode, combining characters, wide glyphs,
bracketed paste, resize during output, history, secret input, approval key race,
Ctrl-C escalation, Ctrl-D, subprocess output flood, and emergency terminal
restoration after injected failure.

Plain and JSON Lines renderers have separate golden contracts. JSON output is
parsed and schema-validated in tests rather than compared only as text.

### 24.6 Agent-loop tests

The scripted provider emits every valid and invalid stream shape at controlled
boundaries. Scenarios cover final text, multiple tool cycles, denial, malformed
tool correction, context overflow, compaction, usage exhaustion, user steering,
provider cancellation, response uncertainty, and resumed semantic transcript.

Spies prove the loop does not call a tool from a stream callback, run two
consequential tools concurrently, repeat a completed provider request during
replay, or complete a turn based solely on provider prose claiming tests passed.

### 24.7 Tool and permission tests

Every built-in tool has parser, normalization, precondition, approval summary,
execution, release, cancellation, reconciliation, and output-bound tests.
Permission matrices cover product modes, administrator floors, user/project
precedence, exact and glob scopes, unknown attributes, changed preconditions,
grant expiry, stale UI decisions, and headless ask-to-deny behavior.

Mutation testing targets policy comparisons, path containment, approval hash
binding, reducer guards, and recovery decisions. Surviving mutants in a
security-critical branch block release until reviewed.

### 24.8 Persistence tests

The fault-injection suite enumerates every append byte/flush boundary and each
CAS, snapshot, index, journal, lock, truncate, and migration operation. For each
crash image, a fresh process opens raw state. It must recover the prior/new
commit, repair only a valid torn tail, or quarantine; it must never skip middle
corruption or append from an unproven chain head.

Long-run tests append and replay millions of bounded synthetic events under a
disk quota, rotate snapshots, run CAS collection, interrupt exports, and verify
stable memory. Concurrent processes contest locks and indexes.

### 24.9 Security tests

Adversarial corpora include prompt injections in every content source, sentinel
secrets in every error shape, symlink and case races, malicious Git names,
terminal escape sequences, process output control bytes, oversized/deep JSON,
provider and MCP protocol confusion, extension manifest substitution, and
configuration source spoofing.

Tests assert that displayed untrusted output is escaped, secrets never reach
captured provider requests or children, path escapes never reach filesystem
mutation, denied calls never execute, and repository changes cannot grant trust
or permissions.

### 24.10 Platform matrix

Release qualification covers supported Node/runtime version, CPU architecture,
macOS versions/filesystem case modes, and Linux distributions/filesystem/
sandbox combinations. Git minimum and current supported versions are tested.
Terminal tests run against virtual PTY plus representative terminal capability
profiles.

Native Windows remains preview or unsupported until its complete conformance
row passes. WSL results are reported separately for Linux and mounted Windows
filesystems.

### 24.11 End-to-end acceptance scenarios

The packaged CLI must pass these synthetic-provider scenarios in disposable
real repositories:

1. first run, question, clean final response;
2. search, read, one approved edit, targeted passing test, final diff;
3. failing test, follow-up edit, passing retry;
4. denied command with useful unverified final result;
5. pre-existing dirty file preserved through conflict and retry;
6. Ctrl-C during provider stream and successful resume;
7. Ctrl-C during process with descendant termination evidence;
8. crash after edit rename and exact reconciliation;
9. resume after external HEAD/file changes;
10. headless JSON Lines with no interactive approval read;
11. credential missing/rejected without secret leakage;
12. corrupt tail repair and middle-corruption quarantine;
13. provider capability mismatch before any billed request;
14. Git commit of exact reviewed Robin paths with unrelated unstaged work
    preserved;
15. uninstall/reinstall preserving sessions and credential references.

Extension milestones add hook, skill, MCP, and subagent/worktree scenarios
before those features are declared supported.

### 24.12 Live-provider tests

Live tests are opt-in, cost-capped, tagged by adapter/model, and use disposable
repositories with no private source. They verify authentication, simple text,
one harmless tool round trip, cancellation behavior where testable, usage
mapping, and safe error classification. They do not replace recorded protocol
fixtures because remote behavior and availability are nondeterministic.

### 24.13 Release evidence and traceability

All 213 unique requirement IDs in the Product Requirements, including the
`NFR-A11Y-*` identifiers, map individually to:

- owning package and interface;
- threat-model entry where relevant;
- unit/contract/integration/end-to-end test IDs;
- supported platform capability;
- documentation and help snapshot;
- release artifact test;
- known limitation or explicit non-claim.

A release gate is satisfied by tests run from the packed artifact and retained
machine-readable reports. A source-level test alone does not prove executable
permissions, package contents, install paths, migrations, or terminal behavior
of the distributed product.

## 25. Future client protocol and editor boundary

The CLI remains the first complete client. A future VS Code extension or
Code-OSS evaluation must consume a stable Robin application protocol instead of
embedding a second agent loop.

The local protocol exposes authenticated same-user operations for session
list/open/fork, submit/steer/cancel, approval response, transcript query, diff
query, configuration explanation, and canonical event subscription. Requests
carry protocol version, client instance, session sequence/cursor, and idempotent
command ID where applicable. The engine remains the only owner of provider
credentials, tools, permissions, and durable append.

Editor-specific context such as selected text, open files, and diagnostics
enters through typed attachments with workspace path, version, hash, trust, and
byte bounds. An editor cannot label unsaved bytes as the current on-disk file
without a distinct overlay identity. Edits still return through Robin's patch
and permission pipeline.

A Code-OSS fork is considered only if a normal extension cannot deliver
required, measured product behavior. Editor update maintenance, extension-host
trust, marketplace compatibility, signing, and distribution are separate
architectural costs, not prerequisites for proving Robin's coding agent.

## 26. Architecture completion criteria

This target architecture becomes a truthful implemented architecture only when:

- package boundaries exist and dependency checks prevent forbidden imports;
- default and initial-prompt invocations start the real interactive coding
  session;
- the headless surface uses the identical agent/session/tool services;
- the direct-model loop streams one production provider and the synthetic
  provider through the normalized contract;
- prompt assembly records exact selected context and respects tested budgets;
- real workspace reads, conflict-safe edits, supervised processes, and Git
  inspection pass platform integration tests;
- permission modes and exact approval binding sit in front of every
  consequential tool;
- local framed persistence, CAS, locks, snapshots, tail repair, quarantine, and
  unsettled-effect reconciliation pass crash injection;
- configuration precedence, project trust, and credential leases pass sentinel-
  secret tests;
- cancellation and backpressure remain bounded under adversarial streams;
- installed-artifact end-to-end scenarios pass on every supported platform;
- documentation distinguishes implemented guarantees, optional/degraded tiers,
  and planned extensions.

Until then, the repository README and release notes must continue to state which
vertical slices are implemented. The architecture directs implementation; it
does not turn planned subsystems into shipped capabilities by description.
