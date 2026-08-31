# Robin: Product Requirements and User Flows

Document status: normative product specification for the Robin pivot.

Implementation status: the repository contains the completed deterministic
runtime and policy/context substrate from Milestones A and B plus an initial-R1
preview: a line-oriented, ephemeral provider-neutral text conversation driven by
a credential-free synthetic provider through one application path in interactive
and `--print` modes. The preview's JSON and streaming-JSON envelopes are
experimental; it currently spells target `default` permission as `ask` and uses
temporary `--output-format` and `--no-save` flags. It has no physical repository,
process, Git, credential, network, durable-session, or resume capability. The
complete R1 terminal/event/tool gate and the stable R7 automation contract do
not exist yet. The full coding-agent product described here remains planned until
each release gate names passing evidence. Current behavior is summarized in the
repository README.

## 1. Product Definition

Robin is a local-first, provider-flexible coding agent for the terminal. A
developer starts `robin` inside a repository, explains a goal in natural
language, and collaborates with an agent that can inspect the codebase, edit
files, run commands and tests, reason about failures, and help prepare Git
changes. Conversations are resumable. Every consequential action is visible,
bounded by permissions, and represented in a reviewable transcript.

Robin owns the coding-agent loop. It is not merely a launcher for a model API,
a wrapper around another coding CLI, or a policy gateway that expects another
product to provide the developer experience. Provider adapters supply model
inference. Robin supplies repository context, tools, orchestration, sessions,
permissions, user interaction, recovery, and Git workflows.

The internal policy runtime remains a differentiator, but it is subordinate to
the coding workflow. Most users should be able to install Robin, select a
provider, approve a credential source, and solve a real repository task without
learning the policy language.

### 1.1 One-sentence pitch

Robin is the coding agent in your terminal that works with your choice of model,
shows its work, remembers the session, and gives you precise control over what
it may read, change, execute, and contact.

### 1.2 Flagship demonstration

The portfolio demonstration starts from a real, intentionally broken
repository:

1. The developer runs `robin`.
2. Robin discovers the repository, active branch, relevant instructions, and
   available verification commands.
3. The developer asks Robin to diagnose and fix a failing feature.
4. Robin searches and reads relevant code, explains a short plan, proposes
   edits, receives the configured permission decision, applies the patch, and
   shows a concise diff summary.
5. Robin runs targeted tests, interprets a failure, makes a bounded follow-up
   edit, and reruns verification.
6. The developer asks a follow-up question without restarting the task.
7. The terminal is closed. `robin --continue` restores the same conversation,
   repository binding, model selection, and unfinished work.
8. Robin shows the final diff and Git status, writes a proposed commit message,
   and performs the commit only after permission is granted.
9. The transcript identifies the model requests, tool calls, approvals,
   commands, changed files, verification results, token usage, and cost estimate
   without exposing the API key.

The same engine must support a deterministic synthetic provider in tests and at
least one real direct provider in the first usable release.

### 1.3 Product hierarchy

When priorities conflict, the product is ordered as follows:

1. a coherent interactive coding workflow;
2. correct repository inspection, editing, execution, and verification;
3. recoverable sessions and comprehensible progress;
4. provider and model portability;
5. explicit permissions and trustworthy action review;
6. automation-friendly headless operation;
7. extensibility;
8. stronger isolation, background durability, and additional clients.

Deep control-plane work that does not unlock or protect one of these journeys
does not precede the journey.

## 2. Primary Users and Jobs

### 2.1 Individual developer

The primary user wants to implement features, fix bugs, understand unfamiliar
code, write tests, resolve build failures, refactor safely, and prepare a clean
Git change without leaving the terminal.

Required jobs:

- start in an existing repository with minimal setup;
- ask questions before authorizing changes;
- see which files and commands Robin is using;
- interrupt or redirect the agent;
- review a patch before or after application according to permission mode;
- resume work after terminal or process exit;
- use an API provider and model the developer already has access to;
- understand failures without opening internal event records.

### 2.2 Power user and maintainer

This user wants reproducible automation, model selection, reusable repository
instructions, custom tools, hooks, precise permissions, machine-readable
output, multiple concurrent worktrees, and diagnostic evidence.

### 2.3 Team or security owner

This later-stage user wants committed project settings, policy floors, provider
allowlists, credential separation, audit export, extension review, network
restrictions, and enforceable defaults that local repository content cannot
weaken.

### 2.4 Provider or extension integrator

This user implements and tests a provider adapter, MCP server, skill, hook, or
client. They need versioned interfaces, conformance fixtures, capability
negotiation, deterministic errors, and explicit compatibility tiers.

### 2.5 Portfolio reviewer

This user needs to see that Robin contains real systems work rather than a thin
chat wrapper: a streaming agent loop, terminal interaction, repository tools,
safe patch application, process control, provider normalization, persistent
sessions, configuration precedence, permissions, evaluation, and evidence.

## 3. Product Principles

### 3.1 Coding agent first

The primary entry point is a conversation in the current repository. Policy,
evaluation, provider, and diagnostic commands support that experience; they do
not replace it.

### 3.2 One engine across surfaces

Interactive mode, print mode, future editor clients, CI, and a future daemon
must call the same session and agent-loop application services. Presentation
may differ. Tool semantics, permissions, provider normalization, and persisted
state may not diverge.

### 3.3 Provider-flexible, capability-honest

Robin separates the model-provider port from the coding agent. It supports any
provider/model combination for which an adapter can satisfy the declared
capability contract and pass conformance tests. Robin never promises that every
API key, endpoint, model, or external agent will work without an adapter.

### 3.4 Local by default

Repository data, transcripts, settings, and tool execution stay local except
for context deliberately sent to the selected model provider or an explicitly
enabled network tool. The UI makes provider egress and external tool boundaries
understandable.

### 3.5 Visible agency

Robin streams intent, tool calls, permission prompts, command output, edits,
verification, and final state. It does not show fabricated hidden reasoning.
Concise summaries are generated from observable actions and results.

### 3.6 Safe defaults without security theater

Read-only repository operations may be allowed by default inside the bound
workspace. File mutation, shell commands, network access, Git writes, and
external tools follow explicit permission rules. Robin distinguishes a client
permission decision, a command sandbox, and whole-process isolation in both
documentation and diagnostics.

### 3.7 Git remains the source of recovery

Robin may keep edit checkpoints for convenience, but it does not represent them
as a replacement for Git. Robin preserves pre-existing user changes, never
silently resets the repository, and names exactly which changes it created when
that can be proven.

### 3.8 Progressive disclosure

The common path is simple. Advanced settings, policies, provider internals,
events, and extension diagnostics are available without overwhelming first
run.

### 3.9 Deterministic boundaries

Model behavior is probabilistic; Robin's parsing, path validation, permission
evaluation, patching, command lifecycle, persistence, and exit codes are
deterministic and testable.

### 3.10 Three explicit event layers

Robin does not use “event” to mean three incompatible things. The layers are:

1. **Live agent events:** bounded in-process observations from the agent loop,
   provider collector, tool pipeline, and process supervisor. Text/output deltas
   and transient interaction phases may be coalesced only by declared delivery
   rules.
2. **Application events:** the versioned provider-neutral surface contract for
   the interactive terminal, text output, streaming JSON, daemon, and future
   editor. Renderers cannot consume provider callbacks directly.
3. **Canonical durable events:** validated, framed, hash-chained semantic facts
   for replay, recovery, and audit. Complete content is sealed; original chunk
   cadence is not durable authority.

The current `EphemeralRobinApplication` directly yields the preview
`RobinAgentEvent` live union. That is a temporary initial-R1 seam. R1 completion
maps live events into versioned application events; R3 adds canonical durable
events and replayed application views without changing renderer semantics. The
minimum mapping is:

| Live observation | Application view | Canonical durable fact |
| --- | --- | --- |
| preview `turn_started` | `TurnQueued` plus context progress | `UserSubmissionAccepted`, `TurnStarted` |
| assistant/provider text delta | `ProviderTextDelta` | later `ProviderContentSealed`, `AssistantMessageSealed`; no frame per delta |
| provider tool fragments | bounded progress only | none until the complete call is sealed |
| complete normalized tool call | `ProviderToolCallCompleted`, `ToolRequestNormalized` | `ProviderToolCallSealed`, `ToolCallReceived`, `ToolCallNormalized` or `ToolCallRejected` |
| permission evaluation/response | `PermissionDecided`, `ApprovalRequested`, `ApprovalResolved` | `PermissionEvaluated`, `ApprovalRequested`, `ApprovalResponded` |
| tool/process lifecycle | start/output/terminal application events | `ToolExecutionPrepared`, `ToolExecutionStarted`, `ToolOutputSealed`, then one terminal tool event |
| provider usage | `ProviderUsageReported` | `ProviderUsageRecorded` |
| preview completion/failure/cancel | matching terminal application event | assistant seal plus `TurnCompleted`; provider/tool failure plus `TurnFailed`; or `TurnCancellationRequested` then `TurnCancelled` |

Only canonical durable events receive monotonic session sequence numbers. A
live-only application event carries a live ordering key and no fabricated
durable sequence.

### 3.11 No silent degradation

When a selected model lacks tool calling, a sandbox is unavailable, a session
cannot be persisted, structured output cannot be enforced, or a provider
feature is emulated, Robin either selects an explicitly documented fallback or
fails with an actionable message. It does not silently claim the stronger
behavior.

## 4. Scope

### 4.1 Required for the first supported, first usable developer release

This release is one cumulative bundle produced only after R8. R1 preview, R4
hosted-provider alpha, and R7 provider/automation conformance builds are evidence
checkpoints, not earlier supported releases.

- `robin` interactive mode in a real local Git repository;
- `robin "prompt"` interactive mode with an initial request;
- `robin --print "prompt"` non-interactive mode using the same loop;
- streamed assistant text, tool activity, command output, and terminal status;
- provider-neutral model port plus a deterministic test provider;
- the first hosted adapter, OpenAI Responses through the reviewed pinned official
  JavaScript SDK, plus the R7 Anthropic and explicitly profiled generic
  OpenAI-compatible families;
- provider and model selection through settings and CLI flags;
- bring-your-own API credential from a supported secure source;
- repository discovery and bounded file listing, search, and reading;
- structural patch proposal, preview, application, and conflict reporting;
- bounded command execution with cancellation and output limits;
- Git status and diff inspection;
- the canonical `default`, `plan`, `accept-edits`, `locked`, and `bypass`
  permission modes, with headless ask-to-deny behavior treated as a surface
  policy rather than another mode;
- explicit approval prompts that show the exact requested scope;
- local session persistence, naming, listing, continue, and resume;
- project and user instructions;
- configuration precedence and project trust, skills, hooks, and MCP with their
  distinct trust and permission boundaries;
- context and usage display;
- interruption, graceful cancellation, and crash-safe transcript writes;
- installation, doctor, uninstall, and clean-data documentation;
- stable `--output <text|json|stream-json>` and `--no-session` automation
  contracts, with published schemas and exit codes;
- a versioned checksummed developer bundle, exact support/evidence manifest, and
  no subagent, isolated-worktree, background, or 1.0 distribution claim;
- deterministic unit, integration, PTY, Git, provider-contract, and end-to-end
  tests.

### 4.2 Required for Robin 1.0

- every supported developer-bundle capability above remains green;
- signed/checksummed stable distribution, provenance, SBOM, and
  upgrade/rollback operations;
- supported-platform installers plus verified uninstall/reinstall behavior;
- complete local-session-store migrations and compatibility fixtures;
- robust doctor, `robin support bundle --dry-run`, privacy controls, data export,
  recoverable trash, and exact project/global purge;
- performance, redaction, migration, recovery, and adversarial release suites;
- threat-model closure and complete user/provider/extension/operator/contributor
  documentation.

### 4.3 Required only after 1.0 before an editor fork is considered

- R9 subagents with independent context, tools, permissions, and budgets;
- R9 isolated Git worktrees for parallel or risky tasks;
- R9 background sessions with durable supervision;
- a stable local client protocol;
- a VS Code extension that consumes the same engine and exposes inline diffs,
  selected-code context, plan review, sessions, and approvals;
- evidence that an editor client needs capabilities unavailable through a
  normal extension before evaluating a Code-OSS fork.

### 4.4 Explicit non-goals for the first release

- training or hosting foundation models;
- claiming universal compatibility with arbitrary APIs or agent binaries;
- a general-purpose enterprise agent control plane as the main product;
- a hosted multi-tenant Robin service;
- autonomous deployment to production;
- whole-machine administration;
- replacing Git or a developer's code review process;
- running destructive commands without an explicit high-risk mode;
- a Code-OSS fork before the CLI engine and client protocol are stable;
- full Windows command sandbox equivalence when the operating system cannot
  provide it;
- storing raw API keys in project files, command history, transcripts, logs, or
  Git.

## 5. Product Modes and Command Surface

The exact option names are versioned with CLI snapshots. The required semantic
surface is:

| Invocation | Required behavior |
| --- | --- |
| `robin` | Start or offer to start an interactive session for the current repository. |
| `robin "prompt"` | Start an interactive session and submit the initial prompt. |
| `robin --print "prompt"` | Run headlessly, print the final result, and exit with a stable code. |
| `input \| robin --print "prompt"` | Add bounded standard input to a headless prompt without treating it as trusted instructions. |
| `robin --continue` | Resume the most recent resumable session bound to the current repository. |
| `robin --resume [id-or-name]` | Open a picker or resume the exact selected session. |
| `robin sessions` | List, inspect, export, rename, and delete local sessions. |
| `robin auth` | Add, inspect, validate, rotate, and remove credential records. |
| `robin models` | List configured providers and discovered or declared model capabilities. |
| `robin config` | Inspect effective configuration, sources, validation, and safe edits. |
| `robin doctor` | Run read-only installation, provider, repository, sandbox, and local session-store diagnostics. |
| `robin support bundle --dry-run` | Inventory exact local diagnostic files/fields, exclusions, redactions, hashes, sizes, and projected archive metadata without creating or uploading a bundle. |
| `robin policy` | Expose the advanced policy debugger without placing it in first-run onboarding. |
| `robin mcp` | Manage MCP servers after the extension milestone. |

No subcommand is interpreted as a prompt unless it is not a reserved command.
Unknown reserved-command misspellings return a suggestion and do not send the
text to a provider.

The target public types are:

```ts
type PermissionMode = "default" | "plan" | "accept-edits" | "locked" | "bypass";
type HeadlessOutput = "text" | "json" | "stream-json";
```

Headless is the `--print` surface, not a permission value. Its target flags are
`--output <text|json|stream-json>` and `--no-session`. The initial-R1 preview
currently accepts `ask`, `--output-format`, and `--no-save`; these are temporary
implementation spellings, not stable aliases. Before the R7 public command
snapshot, `ask` maps to `default`, `--output-format` becomes `--output`, and
`--no-save` becomes `--no-session`. `robin auth`, `robin models`, `robin doctor`,
and `robin support` are target/reserved commands and must not be described as
implemented until their owning gates pass.

## 6. Core User Flows

### 6.1 Installation and provenance

1. The user installs a signed or checksummed Robin distribution through a
   documented channel.
2. The installer places one `robin` executable and does not modify shell startup
   files without a displayed, confirmed action.
3. `robin --version` reports Robin version, build identifier, platform, install
   channel, and update channel in human form; `--json` provides a stable object.
4. `robin doctor` verifies executable provenance, writable state directories,
   Git availability, terminal capabilities, credential-store availability, and
   optional sandbox dependencies.
5. Uninstall instructions distinguish removing the executable from deleting
   local sessions, settings, credentials, caches, plugins, and worktrees.

### 6.2 First run

1. Robin resolves the physical working directory and repository root.
2. If the directory is not a repository, Robin offers read-only question mode
   or requires an explicit `--workspace` choice before enabling mutation.
3. Robin loads only trusted user settings before asking whether project settings
   and instructions should be trusted.
4. Robin checks for a valid provider profile and credential reference.
5. If none exists, the first-run wizard asks for provider type, endpoint when
   applicable, model, authentication strategy, and credential source.
6. Secret input uses hidden input. Robin validates the credential with the
   narrowest non-generative provider call available, or labels a minimal model
   request and its possible cost before sending it.
7. Robin writes non-secret settings atomically, stores or references the secret
   through the chosen credential backend, and prints where each value lives.
8. Robin starts the interactive session and displays repository, branch,
   provider/model, permission mode, and session identifier.

### 6.3 Interactive coding turn

1. The user submits a prompt.
2. Robin appends it durably before provider transmission.
3. The prompt compiler assembles bounded instructions, relevant conversation,
   repository metadata, released context, available tool schemas, and provider
   parameters.
4. The provider adapter streams normalized assistant text and tool calls.
5. Robin displays progress without exposing provider-specific protocol noise.
6. Each complete tool call is schema-validated and normalized.
7. The permission engine decides allow, ask, or deny for the normalized request.
8. Ask decisions pause only the affected action and display exact scope,
   rationale, risk, persistence choice, and safe alternatives.
9. Allowed tools execute through the workspace boundary. Results are bounded,
   classified, persisted, and returned to the model.
10. The loop continues until the model provides a final response, a budget or
    turn limit is reached, the user interrupts, or a terminal error occurs.
11. Robin displays a final summary with files changed, verification performed,
    unresolved failures, usage, and session continuity.

### 6.4 Plan-first work

1. The user selects plan mode at launch or during a session.
2. Mutation, command execution, network access, and Git writes are unavailable
   to the model; repository reads remain governed by policy.
3. Robin may ask focused clarification questions.
4. The model emits a structured plan with goals, affected areas, verification,
   risks, and explicit unknowns.
5. The user accepts, edits, or rejects the plan.
6. Acceptance transitions to the selected execution permission mode and records
   the exact accepted plan version. Acceptance does not preapprove individual
   high-risk tools unless the displayed scope says it does.

### 6.5 Patch review and application

1. An edit tool receives expected file identity, preimage hash or exact range,
   and replacement content.
2. Robin revalidates the path beneath the bound workspace and compares the
   expected preimage against the current file.
3. Robin rejects stale or ambiguous changes rather than forcing them.
4. In preview-required mode, Robin renders a bounded unified diff before
   application.
5. On approval, Robin writes through an atomic temporary-file and rename path
   when the filesystem supports it, preserves documented metadata, and verifies
   the resulting content hash.
6. The session records the before hash, after hash, diff artifact, approval, and
   whether the original was already dirty.
7. The user can inspect the cumulative diff and request a bounded checkpoint
   rewind. Rewind refuses to overwrite external changes detected after the
   checkpoint.

### 6.6 Command execution and verification

1. Robin displays the command, resolved working directory, environment policy,
   network policy, timeout, and sandbox status before an ask decision.
2. Commands spawn without a shell when the tool schema supplies an executable
   and argument vector. Explicit shell mode is a distinct request type.
3. Robin streams bounded stdout and stderr while retaining enough tail output
   for failure diagnosis.
4. The user can send an interrupt. Robin signals the process group, waits a
   bounded grace period, escalates termination if necessary, and records the
   outcome.
5. Output truncation is explicit and points to a local artifact when retained.
6. The model receives a structured result containing exit status, signal,
   duration, truncation, and released output.
7. Robin distinguishes a test failure from failure to start the test process.

### 6.7 Continue and resume

1. Robin identifies sessions by opaque ID and optional user name.
2. `--continue` filters by canonical repository identity, not merely the current
   directory string.
3. Resume validates that the repository still exists and detects branch, HEAD,
   index, and worktree drift.
4. Robin restores conversation, tool history, provider/model selection,
   permission mode, compacted context summaries, task state, and budgets that
   are defined as resumable.
5. Launch-only settings and missing extensions are reported before the next
   provider request.
6. If workspace drift invalidates pending edits or approvals, Robin marks them
   stale and requires new inspection.

### 6.8 Headless automation

1. `--print` accepts a prompt argument or bounded standard input.
2. It never opens an interactive approval prompt when stdin is not a TTY.
3. The caller selects one of the canonical permission modes; headless interaction
   converts any unresolved `ask` result to `deny` unless an exact predeclared
   rule or framed permission callback resolves it.
4. Target `--output text|json|stream-json` modes have documented schemas, and
   target `--no-session` explicitly disables durable conversation retention.
5. Every JSON stream record contains a schema version, session ID, sequence,
   type, timestamp, and typed payload.
6. Optional maximum turns, wall time, provider tokens, estimated cost, tool
   calls, and command time are enforced locally.
7. Structured final output is validated against the requested JSON Schema; a
   validation failure is a distinct exit condition and does not masquerade as a
   successful task.
8. Hermetic mode accepts an explicit set of configuration sources and disables
   implicit user memory, project extensions, and unlisted MCP servers.

### 6.9 Git workflow

1. Robin reads status, branch, HEAD, remotes, and diff through structured Git
   operations.
2. Existing user changes are inventoried before the first mutation.
3. Robin attributes only changes supported by its edit ledger; ambiguous changes
   are labeled mixed or external.
4. Staging, branch creation, commit, push, and pull-request creation are separate
   consequential tools with separate permission scopes.
5. A commit request shows selected paths, summary, proposed message, hooks that
   may run, and current verification state.
6. Robin never uses destructive reset, checkout, clean, force push, branch
   deletion, or history rewriting without an explicit high-risk operation and
   fresh approval.
7. Pull-request creation uses a reviewed Git hosting adapter or an explicitly
   approved CLI command and records the resulting URL.

### 6.10 Provider and model switching

1. The user can inspect configured providers and models without revealing
   credentials.
2. Switching models records a conversation boundary and capability differences.
3. Robin prevents a switch when the new model cannot represent pending tool
   results or required modalities, unless a documented conversion is possible.
4. A pinned model ID is available for reproducible sessions; aliases are labeled
   mutable.
5. Provider failure may trigger a configured fallback only if the user selected
   that behavior and data-egress implications remain within policy.

### 6.11 Failure recovery

1. User messages, accepted model items, tool requests, permission decisions,
   tool results, and terminal state are appended atomically enough to avoid a
   fabricated completed turn after a crash.
2. On restart, Robin classifies incomplete operations as not started, known
   failed, known completed, or uncertain.
3. Read-only idempotent operations may be retried automatically within budget.
4. File, command, network, and Git effects with uncertain outcomes require
   reconciliation before retry.
5. The user sees a plain-language recovery explanation and safe next actions.

## 7. Functional Requirements

### 7.1 CLI bootstrap and terminal lifecycle

- `FR-CLI-001`: The `robin` binary with no arguments starts interactive mode
  when stdin and stdout are terminals.
- `FR-CLI-002`: A positional prompt starts interactive mode with that prompt;
  `--print` starts noninteractive mode.
- `FR-CLI-003`: Piped stdin is accepted only through an explicit or unambiguous
  mode and is bounded by bytes and read duration.
- `FR-CLI-004`: Argument parsing is side-effect free, validates duplicate and
  conflicting flags, and never reads secret values from argv.
- `FR-CLI-005`: Unknown commands and options fail before provider or repository
  mutation and suggest a command only above a deterministic similarity
  threshold.
- `FR-CLI-006`: Help, version, completion, and command-schema snapshots are
  testable without a provider or repository.
- `FR-CLI-007`: Terminal capability detection covers color, hyperlinks, Unicode,
  width, TTY state, raw mode, and screen-reader mode with explicit overrides.
- `FR-CLI-008`: SIGINT first requests graceful turn cancellation; a second
  interrupt within a bounded interval requests process shutdown; active child
  processes receive deterministic termination handling.
- `FR-CLI-009`: SIGTERM performs bounded shutdown and returns a stable cancelled
  or infrastructure exit code.
- `FR-CLI-010`: Terminal state is restored after success, error, interruption,
  approval prompts, and unexpected exceptions.
- `FR-CLI-011`: Human output goes to stderr in machine-output mode so stdout
  remains parseable.
- `FR-CLI-012`: Exit codes distinguish success, invalid input/configuration,
  permission denial, approval unavailable, budget exhaustion, task failure,
  provider failure, infrastructure failure, cancellation, and structured-output
  failure.

### 7.2 Interactive input and rendering

- `FR-UI-001`: The input editor supports insertion, deletion, cursor movement,
  multiline input, submit, history, and cancel on supported terminals.
- `FR-UI-002`: Rendering handles terminal resize and wide or combining Unicode
  without corrupting the prompt.
- `FR-UI-003`: Assistant text streams incrementally and tool activity appears as
  structured status rather than fabricated assistant text.
- `FR-UI-004`: Long command output is collapsible or summarized in interactive
  mode and remains available through a bounded artifact reference.
- `FR-UI-005`: The persistent status surface identifies repository, branch,
  model, permission mode, context usage, estimated session cost, and background
  activity when space permits.
- `FR-UI-006`: `/` invokes built-in and extension commands; `@` resolves
  repository files and registered resources; explicit shell entry uses a
  visually distinct mode.
- `FR-UI-007`: Prompts submitted while a turn is active are queued visibly and
  may be reordered or removed before consumption.
- `FR-UI-008`: The user can interrupt a tool, the current model turn, or the
  entire session without guessing which scope is affected.
- `FR-UI-009`: A flat streaming renderer is available for screen readers and
  terminals that do not support cursor addressing.
- `FR-UI-010`: Color is never the sole carrier of permission, error, diff, or
  task state.
- `FR-UI-011`: Renderers consume normalized application events and cannot make
  permission or tool-execution decisions.
- `FR-UI-012`: Secrets and secret-derived fields are redacted before reaching
  every renderer.

### 7.3 Sessions and conversation

- `FR-SES-001`: Every session has an opaque ID, optional validated name,
  canonical workspace identity, creation time, last activity, status, and
  schema version.
- `FR-SES-002`: Every accepted user message is persisted before it is sent to a
  provider.
- `FR-SES-003`: Normalized assistant items, tool calls, approvals, results,
  context summaries, and usage are ordered and replayable.
- `FR-SES-004`: `--continue` resumes the newest eligible session in the current
  repository; `--resume` accepts exact ID or name and otherwise opens a picker.
- `FR-SES-005`: Session names are unique within the configured namespace or
  produce an explicit disambiguation error.
- `FR-SES-006`: A user may branch a session at a durable message boundary while
  preserving ancestry and creating an independent continuation.
- `FR-SES-007`: The user can list, inspect, rename, export, archive, and delete
  sessions without contacting a provider.
- `FR-SES-008`: Deletion is scoped to exact session-owned records and artifacts,
  supports dry-run inventory, and does not delete repository files.
- `FR-SES-009`: Session resume performs workspace-drift reconciliation before
  enabling pending consequential actions.
- `FR-SES-010`: Corrupt records are quarantined or rejected with diagnostics;
  Robin never silently drops transcript items and continues.
- `FR-SES-011`: Storage writes use atomic replacement or transactional append,
  owner-only permissions, checksums where needed, and crash-injection tests.
- `FR-SES-012`: Exported human and machine transcripts label omitted secret,
  encrypted, binary, and oversized content.

### 7.4 Agent loop

- `FR-AGT-001`: One application service owns the direct-model loop for
  interactive and headless modes.
- `FR-AGT-002`: A turn distinguishes repeatable interaction phases (`queued`,
  `persisting_user_message`, `compiling_context`, `requesting_provider`,
  `collecting_provider_items`, `normalizing_tool_request`,
  `evaluating_permission`, `waiting_for_approval`, `executing_tool`,
  `returning_denial`, `persisting_tool_result`,
  `finalizing_assistant_message`, and temporary `cancelling`) from the smaller
  durable projection statuses (`accepted`, `active`,
  `cancellation_requested`, `interrupted`, `cancelled`, `failed`,
  `provider_result_uncertain`, `recovery_required`, and `completed`).
  `UserSubmissionAccepted`, `TurnStarted`, and
  `TurnCancellationRequested` project the first three durable statuses; exactly
  one terminal semantic event projects a terminal status. A crash never
  serializes the last visible interaction phase as durable truth.
- `FR-AGT-003`: Provider output cannot invoke code directly; only complete,
  normalized tool calls enter the tool dispatcher.
- `FR-AGT-004`: The loop validates tool call IDs, argument schemas, duplicate
  calls, result pairing, ordering constraints, and provider continuation
  protocol.
- `FR-AGT-005`: Tool batches execute serially by default. Parallel execution is
  allowed only for operations declared read-only and concurrency-safe.
- `FR-AGT-006`: Maximum turns, model requests, tool calls, wall time, tokens,
  estimated cost, command time, and released context are enforced locally.
- `FR-AGT-007`: User cancellation propagates through provider stream,
  permission wait, tool execution, and renderer.
- `FR-AGT-008`: Provider retry applies only to classified transient failures,
  uses bounded backoff and jitter, honors retry hints, and does not duplicate
  uncertain consequential tool effects.
- `FR-AGT-009`: The final response is stored separately from task success;
  Robin reports failed verification even if the model writes optimistic prose.
- `FR-AGT-010`: A synthetic scripted provider can deterministically exercise
  text, tool, malformed-stream, retry, cancellation, budget, and context-limit
  paths.
- `FR-AGT-011`: Agent-loop events contain observable decisions and results, not
  hidden chain-of-thought.
- `FR-AGT-012`: A loop implementation is replaceable only through a versioned
  driver contract that preserves session, permission, tool, and evidence
  semantics.

### 7.5 Prompt and context construction

- `FR-CTX-001`: Robin builds provider input from versioned roles: product system
  contract, provider adaptations, user instructions, project instructions,
  selected skills, conversation, repository context, and tool schemas.
- `FR-CTX-002`: Configuration text and repository content remain tagged by
  source and trust class; repository content cannot become a higher-precedence
  system instruction merely by resembling one.
- `FR-CTX-003`: Initial repository context contains bounded metadata rather than
  an unconditional full-repository upload.
- `FR-CTX-004`: Files enter provider context through explicit tool reads,
  user attachment, approved automatic discovery, or a documented index.
- `FR-CTX-005`: Every released resource records canonical identity, version or
  hash, media type, byte count, truncation, redaction, and provider request.
- `FR-CTX-006`: Binary, generated, ignored, oversized, secret-classified, and
  unsupported files receive deterministic handling.
- `FR-CTX-007`: Context-window accounting reserves provider-specific output and
  tool overhead before sending a request.
- `FR-CTX-008`: Compaction creates a typed summary with covered message range,
  active task, decisions, changed files, verification, open failures, and
  retained evidence references.
- `FR-CTX-009`: The user can inspect context composition and request compaction
  without viewing secret bytes.
- `FR-CTX-010`: A compacted summary never authorizes a tool or substitutes for a
  stale precondition.
- `FR-CTX-011`: User and project instruction files have documented precedence,
  import bounds, cycle detection, path scopes, and trust prompts.
- `FR-CTX-012`: Robin supports `ROBIN.md` and may read compatible `AGENTS.md`
  instructions through an explicit documented resolver; conflicting files are
  surfaced rather than silently combined.

### 7.6 Repository discovery and read tools

- `FR-REP-001`: Robin binds to a physical canonical workspace root and records
  repository identity, Git common directory, worktree identity, and initial
  HEAD when available.
- `FR-REP-002`: All tool paths are workspace-relative normalized paths; absolute
  paths, parent traversal, NUL bytes, ambiguous separators, and platform device
  paths are rejected unless an additional root was explicitly granted.
- `FR-REP-003`: Symlinks are handled by operation-specific policy with
  containment revalidation at effect time.
- `FR-REP-004`: `list_files` supports bounded depth, count, ignored-file policy,
  hidden-file policy, stable ordering, and continuation.
- `FR-REP-005`: `search_text` uses literal search by default, bounds patterns,
  files, matches, bytes, and time, and reports skipped inputs.
- `FR-REP-006`: `read_file` supports line or byte windows, detects encoding,
  returns stable line metadata, and reports truncation.
- `FR-REP-007`: Repository metadata tools expose status, diff, log, branch, and
  remotes through parsed structures rather than prompt-only shell text.
- `FR-REP-008`: Read tools do not mutate access times when the platform offers a
  practical supported mechanism; Robin makes no guarantee where the filesystem
  cannot provide it.
- `FR-REP-009`: Ignore behavior distinguishes Git ignore, Robin ignore, provider
  exclusion, secret exclusion, and an explicit user override.
- `FR-REP-010`: Tool results are bounded before persistence, rendering, and
  provider release independently.

### 7.7 File editing and checkpoints

- `FR-EDIT-001`: The primary edit operation is structural patch application with
  explicit path and expected preimage.
- `FR-EDIT-002`: Full-file writes are available only through a distinct bounded
  operation and are not used to bypass patch conflict checks.
- `FR-EDIT-003`: New file creation, modification, move, and deletion are
  distinguishable permission actions.
- `FR-EDIT-004`: Patch parsing rejects malformed headers, path disagreement,
  overlapping hunks, unsupported encodings, and unbounded output before effect.
- `FR-EDIT-005`: Application revalidates file identity and preimage immediately
  before writing.
- `FR-EDIT-006`: Writes are atomic where supported and preserve configured mode,
  newline, encoding, and final-newline behavior.
- `FR-EDIT-007`: Robin records before/after hashes and a bounded diff artifact
  for every successful edit.
- `FR-EDIT-008`: Pre-existing dirty content is never labeled as Robin-created.
- `FR-EDIT-009`: Checkpoints group Robin-owned edits at stable turn boundaries
  and may rewind only when postimage preconditions still match.
- `FR-EDIT-010`: Rewind previews affected files and refuses ambiguous external
  changes unless the user chooses a separate explicit conflict workflow.
- `FR-EDIT-011`: Filesystem-full, permission, rename, antivirus-lock,
  case-collision, and concurrent-edit failures preserve the original file or
  report exact residual state.
- `FR-EDIT-012`: The cumulative session diff is derived from current repository
  state and the edit ledger; neither source alone is treated as sufficient
  attribution evidence.

### 7.8 Process and shell tools

- `FR-PROC-001`: Structured process execution accepts executable, argument
  vector, working directory, bounded environment changes, timeout, and output
  limits.
- `FR-PROC-002`: Shell syntax requires an explicit shell operation and displays
  the exact shell and command text.
- `FR-PROC-003`: The environment starts from a reviewed allowlist or documented
  inherited profile and removes provider credentials unless the operation
  explicitly needs them.
- `FR-PROC-004`: Child processes run in a dedicated process group or platform
  equivalent so cancellation reaches descendants.
- `FR-PROC-005`: stdout and stderr streaming preserves channel, order metadata,
  byte counts, truncation, and terminal exit.
- `FR-PROC-006`: Time, output, process count, and optional memory/CPU limits are
  enforced at the strongest available layer and diagnosed when unavailable.
- `FR-PROC-007`: Sandbox mode reports enforcement backend, read/write roots,
  network policy, fallback behavior, and unsupported platform limitations.
- `FR-PROC-008`: A sandbox failure never silently falls back when strict mode is
  selected.
- `FR-PROC-009`: Background processes have explicit handles, logs, status,
  cancellation, retention, and session ownership.
- `FR-PROC-010`: Common verification commands are suggestions discovered from
  project metadata; they are not executed before permission evaluation.

### 7.9 Git tools

- `FR-GIT-001`: Robin snapshots initial status and HEAD before its first
  repository mutation.
- `FR-GIT-002`: Status and diff parsers handle spaces, unusual Unicode, renames,
  submodules, untracked files, conflicts, unborn branches, and detached HEAD.
- `FR-GIT-003`: Read-only Git operations are separated from staging, commit,
  branch, fetch, pull, push, merge, rebase, reset, clean, and hosting actions.
- `FR-GIT-004`: Staging selects exact path identities and rechecks the displayed
  diff before effect.
- `FR-GIT-005`: Commit creation records the exact tree/commit result and reports
  hook modifications or failures.
- `FR-GIT-006`: Remote network operations show remote identity and refspec.
- `FR-GIT-007`: Destructive or history-rewriting operations are denied by
  default and require an explicit high-risk mode that cannot be enabled by
  repository configuration.
- `FR-GIT-008`: Worktree isolation uses Git's actual common-dir semantics,
  validates ownership markers, and never deletes an unproven directory.
- `FR-GIT-009`: Robin detects index/worktree drift between approval and Git
  effect and invalidates stale approval.
- `FR-GIT-010`: Pull-request integration degrades to a prepared title/body when
  hosting authentication or a supported adapter is unavailable.

### 7.10 Providers and models

The checked-in `ModelProvider.respond(request, signal)` contract is a temporary
initial-R1 preview port. The canonical production R4 adapter exposes only
`probe`, `countInput`, `invoke`, `classifyUnknownError`, and
`redactDiagnostic`; `invoke` accepts a provider-neutral conversation request and
returns an abortable asynchronous stream of normalized items. Request compilers,
stream normalizers, and continuation reconstruction helpers are internal
provider-package pipeline modules (for example `compileSemanticRequest`,
`normalizeProviderStream`, and `reconstructContinuation`), not alternative
public ports. The first hosted implementation remains OpenAI Responses through
the reviewed pinned official JavaScript SDK.

- `FR-PROV-001`: The production provider port implements `probe`, `countInput`,
  `invoke`, `classifyUnknownError`, and `redactDiagnostic` with the responsibility
  split above; preview `respond` is retired from production composition during
  R4 migration.
- `FR-PROV-002`: Normalized items cover text deltas, complete text, tool-call
  deltas, complete tool calls, usage, provider notices, stop reason, and typed
  failure.
- `FR-PROV-003`: Adapters validate provider identifiers, endpoint schemes,
  authentication strategies, request limits, response structure, and stream
  framing.
- `FR-PROV-004`: Each adapter declares capabilities for tool calling, parallel
  tools, system roles, images, structured output, prompt caching, reasoning
  controls, context size, output size, usage, and cancellation.
- `FR-PROV-005`: The prompt compiler selects only transformations permitted by
  that manifest and records any emulation.
- `FR-PROV-006`: Unknown provider fields and stop reasons are retained safely for
  diagnostics but do not bypass normalized state validation.
- `FR-PROV-007`: HTTP retries are restricted by method/result certainty and
  classified status; rate limits honor bounded provider delay hints.
- `FR-PROV-008`: Provider errors map to stable categories while retaining a
  redacted provider request identifier.
- `FR-PROV-009`: The generic OpenAI-compatible adapter requires an explicit
  capability profile; Robin does not infer full compatibility from endpoint
  shape alone.
- `FR-PROV-010`: Local model endpoints use the same adapter contract and can
  declare no-credential authentication.
- `FR-PROV-011`: Model aliases are labeled mutable; pinned IDs and provider
  revisions are recorded for reproducibility.
- `FR-PROV-012`: Every production adapter passes recorded-response,
  synthetic-server, malformed-stream, cancellation, timeout, retry, usage,
  tool-call, and redaction conformance tests.

### 7.11 Credentials and authentication

- `FR-CRED-001`: A credential record stores identifier, provider, auth type,
  secret backend reference, creation time, last validation, and redacted
  fingerprint; it never stores secret bytes in normal configuration.
- `FR-CRED-002`: Supported sources include OS credential storage, one-time hidden
  input, a deliberately named environment variable, provider-native login when
  implemented, and no-credential local endpoints.
- `FR-CRED-003`: Robin never accepts a raw secret as a command-line argument.
- `FR-CRED-004`: Environment import reads only the exact named variable and does
  not automatically load repository `.env` files.
- `FR-CRED-005`: Provider adapters receive credentials at request time through a
  broker and cannot serialize them into session events.
- `FR-CRED-006`: Validation distinguishes missing, rejected, insufficient scope,
  endpoint mismatch, network failure, and unavailable validation.
- `FR-CRED-007`: List, inspect, export diagnostics, and logs show only redacted
  metadata.
- `FR-CRED-008`: Removal identifies profiles that will break and requires exact
  confirmation; secret-backend deletion and metadata deletion have reconciled
  outcomes.
- `FR-CRED-009`: Rotation creates and validates the replacement before switching
  profiles when the backend permits it.
- `FR-CRED-010`: Child commands, hooks, MCP servers, and plugins do not inherit
  model credentials by default.

### 7.12 Configuration and instructions

- `FR-CONF-001`: Configuration scopes are defaults, managed policy, user,
  project, local-project, environment, explicit settings file, and CLI, with a
  documented precedence model.
- `FR-CONF-002`: Managed policy sets a floor that lower-precedence sources cannot
  weaken.
- `FR-CONF-003`: Project configuration is not loaded until workspace trust is
  established, and material changes trigger re-approval.
- `FR-CONF-004`: Every configuration file is size-bounded, schema-versioned,
  strict about unknown security-relevant fields, and parsed without code
  execution.
- `FR-CONF-005`: `robin config explain <key>` shows the effective redacted value,
  winning source, overridden sources, and validation.
- `FR-CONF-006`: Writes use atomic update, preserve unrelated known fields, and
  refuse a newer unsupported schema.
- `FR-CONF-007`: Settings may select provider/model, permissions, tools, budgets,
  rendering, instructions, hooks, skills, MCP, sandbox, retention, telemetry,
  and update channel.
- `FR-CONF-008`: Secret-shaped values in non-secret settings are rejected with a
  migration path.
- `FR-CONF-009`: Instruction imports resolve relative to the importing file,
  enforce root and depth bounds, detect cycles, and show source provenance.
- `FR-CONF-010`: Path-scoped instructions activate only for matching canonical
  repository paths.

### 7.13 Permissions and policy

The canonical `PermissionMode` enum is exactly `default | plan | accept-edits |
locked | bypass`. `--print`/headless is a presentation and interaction surface,
not a permission mode. Initial-preview `ask` is migrated to `default`.

- `FR-PERM-001`: Every tool operation has a normalized permission action with
  tool, operation, workspace, paths, command, network target, Git target,
  extension identity, mutability, and risk attributes as applicable.
- `FR-PERM-002`: Decisions are allow, ask, or deny with precedence
  `deny > ask > allow`.
- `FR-PERM-003`: The default mode allows bounded repository reads, asks for
  edits and ordinary commands, and denies high-risk operations unless enabled
  through trusted user or managed configuration.
- `FR-PERM-004`: Plan mode denies mutation and execution; accept-edits mode may
  allow bounded file edits while retaining command and Git prompts; locked mode
  requires exact allow rules.
- `FR-PERM-005`: The headless surface converts ask to deny unless an exact
  predeclared allow rule or external permission callback is explicitly
  configured; this behavior does not add a permission enum value.
- `FR-PERM-006`: Approval displays exact normalized scope, expected preconditions,
  risk, likely effect, and whether the choice applies once, for the session, or
  to a persistent rule.
- `FR-PERM-007`: Persistent approval edits a user-visible rule only after showing
  the proposed rule and destination.
- `FR-PERM-008`: Approval is bound to tool definition version, normalized
  arguments, workspace state preconditions, policy snapshot, and expiration.
- `FR-PERM-009`: A changed file, command, target, provider, model, policy,
  extension, or relevant repository state invalidates stale approval.
- `FR-PERM-010`: Repository content cannot enable bypass mode, approve itself, or
  weaken user/managed denial.
- `FR-PERM-011`: Bypass mode requires an explicit launch flag and confirmation,
  is visibly persistent in the UI, and is unavailable when managed policy
  disables it.
- `FR-PERM-012`: Policy explanation uses safe attributes and never reveals
  secret values.

### 7.14 Usage, budgets, and cost

- `FR-BUD-001`: Budgets exist for turns, model requests, input/output tokens,
  estimated provider cost, tool calls, command duration, wall time, context
  release, and retained artifacts.
- `FR-BUD-002`: Provider usage is preferred when present; local estimates are
  labeled estimates.
- `FR-BUD-003`: Cost calculation records pricing-table source and effective date
  and remains optional when reliable pricing is unavailable.
- `FR-BUD-004`: Approaching a limit is visible before a consequential action
  when enough information exists.
- `FR-BUD-005`: Exceeding a hard limit prevents the next bounded operation and
  records a terminal or resumable budget state.
- `FR-BUD-006`: A resumed session identifies which budgets reset, continue, or
  require explicit replenishment.

### 7.15 Headless and SDK-facing contracts

- `FR-AUTO-001`: Text output contains only the final assistant result unless
  verbose diagnostics are explicitly selected.
- `FR-AUTO-002`: JSON output is one versioned final envelope; streaming JSON is
  newline-delimited and sequence-ordered.
- `FR-AUTO-003`: Input and output schemas are published with fixtures and
  compatibility tests.
- `FR-AUTO-004`: Machine mode never emits terminal control sequences.
- `FR-AUTO-005`: `--no-session` prevents durable conversation retention while
  preserving the minimum local operational evidence explicitly required by the
  selected policy, or fails if those requirements conflict.
- `FR-AUTO-006`: A caller can provide a fixed session ID only in a validated
  namespace designed for idempotent automation.
- `FR-AUTO-007`: Hooks and permission callbacks use framed, bounded,
  schema-versioned input/output with timeouts and fail-closed semantics.
- `FR-AUTO-008`: A future SDK wraps the same application protocol and does not
  reimplement the agent loop.

### 7.16 Hooks, skills, MCP, and subagents

Instructions, skills, hooks, and MCP are in the R8 supported developer bundle.
Subagents, their isolated worktrees, and background supervision are R9 features
and must not ship or be feature-flagged before the accepted 1.0 baseline.

- `FR-EXT-001`: Extension classes are distinct: instructions provide context,
  skills provide reusable procedures, hooks provide deterministic lifecycle
  reactions, MCP provides external tools/resources/prompts, and subagents provide
  delegated context and work.
- `FR-EXT-002`: Project extensions require workspace trust; installed user
  extensions have identity, version, source, and integrity metadata.
- `FR-EXT-003`: Skills load metadata first and bounded instructions/resources
  only when selected or invoked.
- `FR-EXT-004`: Hooks declare event, matcher, execution type, timeout,
  concurrency, permission behavior, and failure policy.
- `FR-EXT-005`: Hook output cannot directly forge a tool result or permission
  decision; supported control responses are schema-validated.
- `FR-EXT-006`: MCP servers are configured by exact transport and scope. Project
  servers cannot self-approve.
- `FR-EXT-007`: MCP tool annotations are treated as untrusted metadata until
  mapped into Robin operation definitions.
- `FR-EXT-008`: Extension processes receive the minimum environment,
  filesystem, network, and credential access selected by policy.
- `FR-EXT-009`: Subagents have explicit model, prompt, tools, permissions,
  context, budget, concurrency, worktree, and result contracts.
- `FR-EXT-010`: A parent may cancel a subagent; a subagent cannot silently widen
  permissions or delegate beyond its allowlist.
- `FR-EXT-011`: Parallel mutable work requires separate worktrees or a scheduler
  that proves non-overlapping effects.
- `FR-EXT-012`: Extension failures are isolated and surfaced without corrupting
  the primary transcript.

### 7.17 Diagnostics, updates, and data lifecycle

- `FR-OPS-001`: `robin doctor` is read-only unless a separate fix action is
  selected.
- `FR-OPS-002`: Diagnostics cover installation, version, state permissions,
  configuration validation, repository identity, Git, provider reachability,
  credentials, sandbox, extensions, local session-store health, disk space, and
  terminal.
- `FR-OPS-003`: A diagnostic bundle inventories every included file, redacts
  secrets, excludes repository content by default, and supports exact local
  preview through `robin support bundle --dry-run` before archive creation.
- `FR-OPS-004`: Logs are structured, level-controlled, bounded, rotated, and
  linked to session/tool/provider request IDs without raw credentials.
- `FR-OPS-005`: Update checks disclose network use, may be disabled, and never
  replace the executable during an active session.
- `FR-OPS-006`: Updates verify signature or checksum and support stable and
  preview channels with rollback instructions.
- `FR-OPS-007`: Data retention is configurable separately for transcripts,
  provider payloads, command output, patches, checkpoints, logs, caches, and
  extension data.
- `FR-OPS-008`: Project purge and global purge provide dry-run, exact target
  inventory, confirmation, ownership validation, and partial-failure reporting.
- `FR-OPS-009`: Schema migrations are versioned, restartable, backed up when
  destructive, and tested from every supported upgrade origin.
- `FR-OPS-010`: Robin can export a redacted support report after a crash without
  reopening the affected provider session.

## 8. Failure UX

Every user-facing failure contains:

1. what operation failed;
2. whether repository, provider, session, or external state may have changed;
3. a stable category or code;
4. the safe next action;
5. a diagnostic reference;
6. whether retry is automatic, safe manually, unsafe until reconciled, or
   impossible with the current configuration.

Robin uses specific messages for:

- no repository or inaccessible workspace;
- untrusted or invalid project settings;
- no provider profile, credential, or model;
- credential rejection or provider authorization failure;
- unsupported model capability;
- provider rate limit, overload, malformed stream, or context overflow;
- stale file preimage or patch conflict;
- permission denial versus an approval unavailable in headless mode;
- command nonzero exit versus command infrastructure failure;
- unavailable or degraded sandbox;
- Git dirty-state conflict or external drift;
- disk full, corrupt session, unsupported schema, or failed migration;
- interrupted turn and uncertain consequential effect;
- structured output that fails schema validation.

Raw stack traces appear only in explicit debug output. Redaction precedes both
normal and debug rendering.

## 9. Non-Functional Requirements

### 9.1 Security

- `NFR-SEC-001`: All untrusted boundary inputs have byte, item, nesting, and time
  bounds where applicable.
- `NFR-SEC-002`: Canonical path containment is rechecked immediately before
  filesystem effects.
- `NFR-SEC-003`: No supported normal flow places a raw provider credential in
  argv, settings, transcript, log, child environment, diagnostic bundle, or Git.
- `NFR-SEC-004`: Permission checks operate on the exact immutable normalized
  action executed by the tool.
- `NFR-SEC-005`: Project content and extensions cannot weaken higher-precedence
  policy.
- `NFR-SEC-006`: Release gates include adversarial path, patch, command, stream,
  credential, configuration, extension, and recovery tests.

### 9.2 Reliability

- `NFR-REL-001`: A crash cannot transform an incomplete turn into a successful
  recorded turn.
- `NFR-REL-002`: Session replay is side-effect free.
- `NFR-REL-003`: Consequential effect retries are driven by explicit idempotency
  and reconciliation contracts.
- `NFR-REL-004`: Terminal, file, Git, and session resources are released on every
  handled shutdown path.
- `NFR-REL-005`: Compatibility migrations have fixtures for the oldest supported
  schema through the current schema.

### 9.3 Performance

The release-qualification p95 SLO targets are 150 ms for warm help/version,
500 ms for cold start to the first usable interactive frame, and 250 ms for
resuming 10,000 events from a valid head snapshot. CI uses separate hard
regression ceilings of 250 ms, 750 ms, and 500 ms respectively. CI ceilings do
not redefine or relax the product SLOs; measurements identify reference hardware,
build, filesystem warmth, and percentile provenance.

- `NFR-PERF-001`: Warm CLI help and version target p95 150 ms (CI hard ceiling
  250 ms) without loading provider or workspace subsystems; cold first-frame
  startup targets p95 500 ms (CI hard ceiling 750 ms).
- `NFR-PERF-002`: Interactive input remains responsive while model, command, or
  background events stream.
- `NFR-PERF-003`: Repository discovery is bounded and lazy; Robin does not hash
  every repository file at startup.
- `NFR-PERF-004`: Long sessions use bounded in-memory windows and incremental
  persistence; resume from a valid head snapshot at 10,000 events targets p95
  250 ms with a 500 ms CI hard ceiling.
- `NFR-PERF-005`: Performance budgets and percentile targets are recorded per
  supported platform before release rather than inferred from one developer
  machine.

### 9.4 Privacy

- `NFR-PRIV-001`: Provider egress is attributable to session, request, released
  resources, and selected provider.
- `NFR-PRIV-002`: Optional telemetry is off until its schema, destination,
  retention, and consent are documented.
- `NFR-PRIV-003`: Local data locations and deletion behavior are documented per
  platform.
- `NFR-PRIV-004`: Third-party extensions and MCP servers are separate egress
  principals in permissions and diagnostics.

### 9.5 Accessibility

- `NFR-A11Y-001`: Every interactive workflow has a keyboard path.
- `NFR-A11Y-002`: A no-color, no-animation, flat-output mode remains usable.
- `NFR-A11Y-003`: Motion and repeated status updates respect reduced-motion and
  screen-reader modes.
- `NFR-A11Y-004`: Permission prompts state action and choice text independently
  of layout or color.

### 9.6 Portability

- `NFR-PORT-001`: The supported matrix names exact macOS, Linux, WSL, and
  Windows versions and identifies feature differences.
- `NFR-PORT-002`: Path, signal, process-group, credential-store, terminal, and
  sandbox abstractions have platform contract tests.
- `NFR-PORT-003`: Unsupported enforcement is diagnosed and cannot satisfy a
  strict release gate through fallback.

### 9.7 Maintainability

- `NFR-MAINT-001`: Terminal UI, application/session services, agent loop,
  providers, tools, permissions, persistence, and platform adapters have acyclic
  dependency boundaries.
- `NFR-MAINT-002`: Provider-specific objects do not cross the provider adapter
  boundary into tools or session state.
- `NFR-MAINT-003`: Tool definitions are versioned and pair input/output schemas
  with normalization, permission attributes, execution, redaction, and tests.
- `NFR-MAINT-004`: Current and planned behavior are never mixed in release
  documentation.

## 10. Product Differentiation

Robin does not differentiate by claiming more unrestricted autonomy. It
differentiates through a combination of:

- provider choice without giving up one coherent agent and tool model;
- a terminal product built around reviewable coding work rather than a generic
  run ledger;
- explicit, explainable permissions using the existing policy substrate;
- deterministic tool normalization and evidence suitable for debugging;
- reproducible headless runs and provider conformance;
- local-first session ownership and clear data lifecycle;
- an architecture that can serve a future editor without forking the agent
  engine.

The competitive benchmark is capability coverage and workflow quality, not
copying another product's command names, wording, visual identity, or internal
implementation.

## 11. Compatibility Claims

Robin uses these public tiers:

| Tier | Claim |
| --- | --- |
| Conformant direct provider | Adapter passes the full provider contract for its declared capabilities and Robin owns the complete tool loop. |
| Compatible endpoint | Generic adapter passes a named subset; unsupported features are disabled and listed. |
| Local model endpoint | Direct provider contract passes with an explicit local transport and authentication profile. |
| External agent bridge | Robin mediates only the tools and context that traverse the bridge; no claim is made about the external agent's hidden context or capabilities. |
| Unsupported experiment | May be manually configured for development; not included in release claims or support matrix. |

`Any model` means any model whose adapter and declared capability mode satisfy
the selected Robin workflow. `Any API key` means the user can bind their own
credential through a supported authentication strategy; it does not mean a key
for an unrelated or incompatible service can drive Robin.

## 12. Release Acceptance Hierarchy

### 12.1 Internal substrate baseline

The existing Milestones A and B remain accepted only for their current,
documented deterministic contracts, policy engine, context boundary, and
virtual repository evidence. They do not satisfy a coding-agent product release.

### 12.2 Initial-R1 implementation preview and R1 completion

The checked-in preview proves a shared provider-neutral ephemeral text path in
line-oriented interactive and experimental `--print` modes. It is not a release
or a complete R1 gate. R1 closes only after the versioned application-event
mapping, deterministic synthetic tool cycle, raw terminal editor, queued input,
cancellation, resize, PTY restoration, accessible flat renderer, and complete
failure matrix pass. It makes no repository, provider, credential, persistence,
resume, sandbox, or stable automation claim.

### 12.3 R3 durable synthetic coding gate

R2 and R3 add real bounded repository read/search/edit tools, command execution
and cancellation, visible permission decisions, local session save/continue,
context inspection/compaction, Git diff review, crash recovery, and PTY plus
temporary-repository evidence under the deterministic synthetic provider. R3 is
a durable product-development gate, not a supported release.

### 12.4 R4 first hosted-provider alpha

R4 is only the first end-to-end hosted-provider alpha. It adds OpenAI Responses
through the reviewed pinned official JavaScript SDK, BYOK onboarding, exact
model selection/capability validation, provider/tool streaming, usage/cost,
retry/uncertainty classification, leak-canary evidence, and a recorded
real-repository demo. It does not create a supported release.

### 12.5 R7 provider and automation conformance gate

R5–R7 add the complete canonical permission modes, supported sandbox path,
checkpoint/rewind and Git daily workflow, three direct-provider families,
OS-backed credentials where supported, model switching, and the stable
`--output`/`--no-session` text/JSON/streaming/structured automation contract.
R7 is an internal beta/conformance gate; that stable contract is currently
planned and is not itself the first supported release.

### 12.6 First supported developer release after R8

The first supported developer release is a single bundle after all R0–R8 gates
pass. It adds mature configuration/instructions, project trust, skills, hooks,
and MCP; publishes a checksummed developer package, exact support and evidence
manifest, stable automation schemas, install/remove guidance, and complete
current-versus-planned documentation. It contains no R9 subagent, isolated-
worktree, or background surface and makes no Robin 1.0 claim.

### 12.7 Robin 1.0 after R10

The R10 1.0 gate adds signed/checksummed distribution and upgrade/rollback,
supported-platform installers, complete doctor/support/data lifecycle,
performance and migration qualification, threat-model closure for all shipped
surfaces, no unresolved critical or high security findings, and complete user,
extension, provider, operations, and contributor documentation. R9 remains
absent from the 1.0 package and claims.

### 12.8 Post-1.0 R9 gate

Only after R10 is accepted may R9 add subagents, isolated Git worktrees,
supervised background sessions, a local daemon, delegation/aggregate budgets,
candidate import, and their recovery/cleanup semantics. No pre-1.0 feature flag
or experimental command is an exception.

### 12.9 Later editor gate

An editor client begins only after:

- one stable engine protocol serves interactive and headless CLI clients;
- session and approval semantics are versioned;
- inline diff and selected-context operations are safe through that protocol;
- extension tests can prove no second permission engine exists;
- the product case for an extension versus a Code-OSS fork is revisited with
  measured limitations.

## 13. Success Measures

Before public release, Robin records reproducible measurements for:

- time from installation to first successful provider turn;
- time to first relevant repository read and first verified edit;
- task completion and verification success on a versioned evaluation corpus;
- permission prompt frequency, denial rate, and stale-approval prevention;
- session resume success after normal exit and injected crash;
- provider adapter conformance rate;
- patch conflict and external-change preservation rate;
- command cancellation latency and orphan-process rate;
- p50, p95, and p99 interactive render latency under streamed load;
- secret canary escape count across provider, transcript, log, renderer, child
  process, and diagnostic surfaces;
- percentage of failures with a stable category and safe next action.

Metrics do not justify collecting user repository content. Release benchmarks
use synthetic, consented, or repository-owned fixtures.

## 14. Requirement-to-Evidence Rule

Every implemented requirement must map to:

1. an owning package or application boundary;
2. one or more automated tests;
3. a named user-visible failure path;
4. a release milestone;
5. documentation that distinguishes current support from planned support.

A feature is not complete because a type, parser, or command stub exists. It is
complete when the end-to-end user flow, failure handling, persistence,
permissions, tests, diagnostics, installation impact, and documentation all
meet the applicable release gate.
