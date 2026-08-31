# Robin

Robin is a local-first, provider-flexible coding agent for the terminal,
currently available as the accepted deterministic R1 vertical slice described below. Its
intended product workflow is to start `robin` in a repository, describe work in
natural language, and collaborate with an agent that can inspect the codebase,
edit files, run commands and tests, review Git changes, and resume the same
session later.

Robin targets the same product category and terminal interaction model as
Claude Code. It is not a wrapper around Claude Code or another coding-agent
binary. Robin owns the agent loop, repository tools, session model, permission
UX, provider normalization, and verification workflow. Its policy and runtime
control layer is internal infrastructure for that coding experience, not the
product's primary surface.

> **Implementation status:** R0 is accepted on `main` at merge commit
> `2c042ca`. R1 is accepted on `main` at merge commit `fb64cf1`; all nine
> required checks passed both on reviewed pull-request head `9907287` and on
> the merge-triggered `main` workflow.
> `robin` now has a raw-mode TTY editor, a non-TTY/accessible flat renderer,
> streamed multi-turn conversation, prompt queuing, cancellation, resize and
> paste handling, visible usage, and two deterministic read-only coding-tool
> calls. `robin -p` uses the same provider-neutral application path with text,
> JSON, or streaming JSON output. The credential-free synthetic model provider
> and tools use in-memory fixtures: Robin does not yet read or change the
> physical repository,
> run commands or Git, contact a network, store credentials, or persist a
> session. Milestones A and B and Robin R0–R1 are accepted. R2 real-workspace
> tools and approvals are in development and are not current release claims.

## Intended Robin Experience

The first usable Robin release is designed around this workflow:

```text
$ robin
Robin · my-project · main · model: configured-provider/model

> Find the cause of the failing account test and fix it.

Robin searches and reads the relevant files, explains its short plan, requests
permission for consequential actions, applies a reviewable patch, runs targeted
tests, reports failures honestly, and shows the final Git diff.

> Continue by adding the regression test.
```

The same application service will power interactive sessions and headless
automation. Planned entry points include:

| Entry point | Intended behavior |
|---|---|
| `robin` | Start an interactive coding session in the current repository. |
| `robin "prompt"` | Start interactively and submit an initial request. |
| `robin --print "prompt"` | Run the same agent loop headlessly and return a stable result. |
| `robin --continue` | Continue the newest eligible session for this repository. |
| `robin --resume [id-or-name]` | Select or resume an exact saved session. |
| `robin sessions` | List, inspect, rename, export, or delete local sessions. |
| `robin auth` | Add and manage supported credential records without putting keys in arguments. |
| `robin models` | Inspect configured providers, models, and declared capabilities. |
| `robin config` | Explain effective user, project, environment, and CLI configuration. |
| `robin doctor` | Diagnose the installation, repository, provider, state, and sandbox. |
| `robin policy` | Use the advanced policy debugger behind Robin's permission layer. |

These commands are requirements, not current implementation claims. The
current command surface is documented under [Run What Exists Today](#run-what-exists-today).

## Product Boundary

Robin is a coding-agent product, not a general secure-agent control plane with
a small CLI attached. The CLI and agent workflow own:

- streaming conversation, interruption, redirection, and terminal state;
- repository discovery, instructions, search, reads, edits, commands, tests,
  and Git-aware review;
- the direct-model tool loop and normalized provider continuation;
- provider/model selection and bring-your-own-credential onboarding;
- local session persistence, continuation, branching, export, and deletion;
- permissions that show the exact file, command, network, or Git effect;
- observable tool results, verification status, usage, and cost estimates;
- deterministic headless input/output for scripts and CI;
- later extension points for skills, hooks, MCP, subagents, and editor clients.

The existing event kernel, policy language, context broker, capability gateway,
and evidence fixtures support those journeys. They do not define a separate
end-user product. Internal `@guard/*` package names and `.guard` policy files
remain temporarily as versioned substrate identifiers; the public repository,
package, executable, documentation, and product name are Robin.

## Current Implementation

The repository proves inherited Milestones A and B plus accepted Robin R0 and
R1. The reviewed R1 head `9907287` passed all nine required hosted checks, was
merged as `fb64cf1`, and the same nine checks passed on the merge-triggered
`main` workflow. R2 is now implementing real bounded workspace, edit, process,
Git-read, and approval behavior; none of those R2 capabilities is claimed until
its complete gate passes and merges.

| Area | Implemented now | Not implemented now |
|---|---|---|
| CLI | Ephemeral `robin` and `robin "prompt"` raw-mode TTY sessions with streamed output, grapheme-aware editing, bracketed paste, resize, queueing, and one-/two-stage interruption; flat non-TTY/screen-reader fallback; `robin -p` text/JSON/stream-JSON; retained `robin run`; implemented `robin policy` debugger | Setup wizard, durable sessions, auth, models, doctor, shell completion, supported distribution channel |
| Agent and model | Provider-neutral multi-request structured tool loop, bounded provider-item collection, deterministic streaming synthetic provider, turn/tool/output/time budgets, application-wide ordered events, and inherited scripted driver | Hosted/local provider transport, provider onboarding, production model adapters, external-agent bridge |
| Repository work | The interactive loop invokes two gateway-mediated, read-only tools over one immutable TypeScript fixture; retained virtual scenarios cover list/search/read/proposed-patch/diff contracts | Physical repository reads or mutation, real patch application, command/test execution, Git or worktrees |
| Control substrate | Strict contracts, versioned application events, pure turn reducer/replay, cancellation scopes, policy evaluation, context release, capability mediation, and deterministic evidence | Durable approvals, sandbox enforcement, restart reconciliation, production audit storage |
| Persistence | Atomic in-memory event store for deterministic scenarios | Durable transcripts, saved sessions, crash recovery, background supervision |
| Credentials | No credential is needed or read | API-key onboarding, OS credential storage, origin-bound injection, rotation |

The synthetic scenario records a canonical 23-event broker-current history. The
virtual coding scenario records a canonical 40-event history and proves its
fixture repository remains unchanged. Historical 19-event and 33-event golden
histories remain replay-compatibility evidence. These scenarios are development
and security fixtures; they are no longer presented as the finished product.

Implemented Milestone B evidence includes:

- strict versioned contracts and bounded canonical event envelopes;
- a pure state reducer, legal transition checks, command planning, and
  effect-free replay;
- an atomic in-memory compare-and-swap event store;
- exact-version profile, context-source, capability, and policy bindings;
- one-use evaluated-action receipts so denied or approval-gated actions cannot
  dispatch through the capability gateway;
- a bounded `.guard` lexer, parser, formatter, evaluator, case runner, trace,
  and old/new policy simulator;
- descriptor-safe and hostile-path tests for the repository context boundary;
- checked-in byte-exact histories and deterministic adversarial canary scans;
- mutation gates for critical contract and policy boundaries.

See [Event Model v1](docs/event-model.md) and
[Policy Language v1](docs/policy-language.md) for the exact implemented
contracts and current limits.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Git for cloning and contributor workflows

PostgreSQL, Docker or Podman, a provider account, and an API key are not needed
for the current deterministic implementation and synthetic R1 candidate.
There is no public Robin release or global installer yet; use the repository
build below.

## Install and Verify the Current Repository

From the repository root:

```bash
npm ci --ignore-scripts
npm run check
npm run build
node apps/cli/dist/bin.js --version
```

`npm run check` runs strict TypeScript checks, repository architecture and
documentation guards, and all workspace unit, scenario, and CLI tests. The
separate build verifies distributable workspace output. Install scripts are not
required. The direct external runtime dependencies remain exact-pinned behind
reviewed boundaries.

## Run What Exists Today

Build first. The local compiled binary is named `robin`; invoking its JavaScript
entry point avoids implying that a global package has already been published.

Run the ephemeral synthetic coding conversation:

```bash
node apps/cli/dist/bin.js
node apps/cli/dist/bin.js "Explain what this preview can do."
node apps/cli/dist/bin.js -p "Summarize the current implementation."
node apps/cli/dist/bin.js --print --output-format json "Explain Robin."
node apps/cli/dist/bin.js --print --output-format stream-json "Stream one turn."
```

In a capable TTY, interactive mode uses a raw terminal editor. Enter submits,
Ctrl-C cancels the active turn, a second Ctrl-C during the escalation window
forces shutdown, Ctrl-D closes an idle session, and bracketed paste inserts text
without submitting it. A prompt entered while a turn is active is queued. On a
non-TTY, `TERM=dumb`, or the screen-reader override, Robin uses the line-oriented
flat renderer. `/help`, `/exit`, and `/quit` are available in both interactive
forms.

The first synthetic turn visibly invokes
`robin.synthetic.workspace_summary@1` and
`robin.synthetic.inspect_file@1`. Both read only an immutable in-memory fixture;
they do not inspect the checkout from which Robin was launched. A follow-up turn
uses the prior observations to prove in-process conversation continuity. The
banner and shutdown diagnostic state that the conversation is ephemeral. Text
output escapes terminal control characters. The experimental machine formats declare
`stability: "experimental"`; they preserve parsed model text while emitting
terminal controls as standard JSON escapes and contain no ANSI output.

Run the retained deterministic synthetic and virtual-coding fixtures:

```bash
node apps/cli/dist/bin.js run --profile synthetic-demo
node apps/cli/dist/bin.js run --profile coding-virtual
```

Select stable JSON Lines output or the completed-outcome-only view:

```bash
node apps/cli/dist/bin.js run --profile synthetic-demo --format jsonl
node apps/cli/dist/bin.js run --profile coding-virtual --format quiet
```

Use the exact checked-in objective or its bounded payload shorthand:

```bash
node apps/cli/dist/bin.js run --profile coding-virtual \
  --objective-file apps/cli/testdata/coding-objective.json
node apps/cli/dist/bin.js run --profile synthetic-demo --quiet -- \
  '{"recordId":"greeting","mode":"uppercase"}'
```

The compatibility `run` command accepts only the two built-in objectives. The
session surface accepts only `--provider synthetic`; selecting a real provider
returns a clear configuration error. Raw API-key arguments, external agents,
network access, real-repository tools, and durable session flags are not
accepted rather than pretending unsupported configuration is protected.

The advanced policy debugger is also implemented:

```bash
node apps/cli/dist/bin.js policy check policies/strict.guard --json
node apps/cli/dist/bin.js policy format policies/default.guard
node apps/cli/dist/bin.js policy test apps/cli/testdata/strict.guard \
  --cases apps/cli/testdata/policy-cases-v1.json
node apps/cli/dist/bin.js policy explain policies/strict.guard \
  --action apps/cli/testdata/policy-action.json --json
node apps/cli/dist/bin.js policy simulate \
  --from apps/cli/testdata/allow-pure.guard \
  --to apps/cli/testdata/deny-pure.guard \
  --actions apps/cli/testdata/policy-actions-v1.json --json
```

Use `node apps/cli/dist/bin.js --help`,
`node apps/cli/dist/bin.js run --help`, and
`node apps/cli/dist/bin.js policy --help` for the current command reference.

No command above contacts a network service, reads an environment credential,
starts a model server, mutates a checkout, invokes Git, or launches a child
process. Session text streams in-process; compatibility-scenario output remains
buffered until completion. Conversation state lives only in memory, so the
current CLI cannot resume after exit.

## Architecture at a Glance

Robin is organized so every user surface reaches one coding-agent application
core rather than implementing a second agent loop:

```text
terminal CLI / headless CLI / future editor client
                         |
          session and conversation services
                         |
             Robin direct-model agent loop
                         |
       normalized provider and model adapters
                         |
 repository tools -> permissions -> capability execution
                         |
 events, context release, checkpoints, evidence, persistence
```

The accepted R1 baseline contains the first narrow implementation of the upper terminal,
session, application, provider-neutral loop, and synthetic tool layers. It is
intentionally fixture-only and ephemeral. Its reviewed exact-head and
post-merge acceptance evidence is green.
The build order creates a usable vertical coding workflow before deepening
isolation, distributed durability, evaluation infrastructure, or clients.

The detailed component boundaries, turn state machine, streaming contracts,
tool protocol, configuration precedence, session schema, and integration plan
are specified in the [Robin CLI architecture](docs/ROBIN_CLI_ARCHITECTURE.md).

## Providers, Models, Agents, and API Keys

Robin is designed to be provider- and model-flexible without making a false
universal-compatibility promise.

- Robin owns one provider-neutral coding-agent loop. A direct provider adapter
  compiles normalized requests, authenticates through a narrow transport, and
  normalizes text, tool calls, usage, stop reasons, and failures.
- A provider/model pair is supported only when its adapter declares the needed
  capabilities and passes Robin's conformance suite. Entering an arbitrary API
  key does not make an incompatible API, model, or protocol work.
- Bring your own key means selecting a supported adapter and storing or
  referencing the credential through a supported secure source. Robin will not
  accept raw secrets as command-line arguments or save them in repository
  configuration, transcripts, logs, or Git.
- Local endpoints and OpenAI-compatible endpoints use the same capability
  contract and must pass their declared dialect tests; a compatibility label by
  itself is not evidence.
- External coding agents can be added later through reviewed ACP, MCP, or
  contained-process adapters. Robin can only guarantee the context and actions
  it can actually mediate, so those integrations have explicit compatibility
  tiers.

Today, only the synthetic credential-free provider exists. The first
hosted-provider alpha at R4 requires one production direct-provider adapter and
session-scoped BYOK onboarding; it is not yet the first supported developer
release, which requires every gate through R8. See the
[provider, credential, and external-agent compatibility plan](docs/PROVIDER_AGENT_COMPATIBILITY.md)
for the exact claims and limitations.

## Permissions and Isolation

Robin's planned permission UX and its internal policy engine answer whether a
specific normalized action is allowed, denied, or requires approval. Command
sandboxing constrains an allowed process. Whole-process or container isolation
is a separate property. Documentation, diagnostics, and release evidence must
name which boundary is active rather than collapsing all three into a single
"safe" label.

The ordinary workflow will show exact requested scope for file writes,
commands, network access, and Git mutations. Read-only operations may be allowed
inside the bound workspace according to the selected mode. Pre-existing user
changes are preserved and must never be silently reset, overwritten, or labeled
as Robin-created.

## Why the Project Pivoted

The original repository was organized as a general policy-enforced runtime and
scheduled the full CLI late. That order produced valuable deterministic
substrate but not the intended product. Robin reverses the priority: terminal
conversation, real repository work, a provider-backed agent loop, sessions,
and developer feedback come first; the control layer evolves when those
journeys require it.

[ADR-0007](docs/decisions/ADR-0007-robin-coding-agent-product-pivot.md) records
the decision and why a CLI precedes a VS Code extension or Code-OSS fork.

The unfinished runtime-first Milestone C prototype was checkpointed on the
`milestone/c-isolated-filesystem-execution` branch before the pivot. It is
archived reference material, not part of this branch and not a merge-ready
implementation. Worktree, artifact, and gateway pieces may return only through
fresh Robin user-journey requirements, review, and tests.

## Roadmap

The ordered roadmap is:

1. **Completed substrate — Milestones A and B:** contracts, deterministic event
   loop and replay, strict policy engine, context boundary, virtual repository
   capability, golden scenarios, and the renamed fixture CLI.
2. **Coding-agent foundation — R1 accepted:** a normalized
   multi-request synthetic tool loop, shared versioned application path, raw and
   flat terminal renderers, cancellation/queue/resize behavior, headless formats,
   output sanitization, and local plus hosted PTY coverage now exist. The
   reviewed R1 head `9907287` and merge commit `fb64cf1` both have a green
   nine-job hosted gate.
3. **Hosted-provider alpha (R2–R4):** one real direct provider with BYOK setup,
   real repository search/read/edit tools, command and test execution, Git diff
   review, permission prompts, interruption, continue/resume, and a complete
   end-to-end demonstration.
4. **First supported developer bundle (R5–R8):** strict permission/sandbox
   evidence, richer Git workflows and checkpoints, provider breadth, stable
   headless contracts, credential stores, configuration and trust, instructions,
   skills, hooks, and MCP.
5. **Robin 1.0 hardening (R10):** packaging, clean-machine
   install/upgrade/rollback/uninstall, migrations, deterministic evals,
   adversarial evidence, accessibility, and release operations.
6. **Post-1.0 orchestration and clients (R9, R11–R12):** subagents, isolated
   worktrees, background supervision, a stable client protocol, and a VS Code
   extension. A Code-OSS fork is considered only if a documented extension
   limitation justifies its maintenance cost.

Every planned claim remains a design target until its named tests and evidence
gate pass. The [full build plan](docs/BUILD_PLAN.md) defines implementation
order, algorithms, tests, and exit criteria.

## Documentation

Start with the product-first source of truth:

- [Product requirements and user flows](docs/PRODUCT_REQUIREMENTS.md)
- [Full Robin build plan](docs/BUILD_PLAN.md)
- [Robin CLI architecture](docs/ROBIN_CLI_ARCHITECTURE.md)
- [ADR-0007: Robin coding-agent product pivot](docs/decisions/ADR-0007-robin-coding-agent-product-pivot.md)

Implementation, operations, and evidence references:

- [Provider, credential, model, and external-agent compatibility](docs/PROVIDER_AGENT_COMPATIBILITY.md)
- [Implementation guide](docs/IMPLEMENTATION_GUIDE.md)
- [Installation, testing, operations, and release plan](docs/OPERATIONS_TEST_PLAN.md)
- [Terminal compatibility and R1 verification matrix](docs/TERMINAL_COMPATIBILITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Event Model v1](docs/event-model.md)
- [Policy Language v1](docs/policy-language.md)
- [Glossary](docs/GLOSSARY.md)
- [Open questions](docs/OPEN_QUESTIONS.md)
- [Architecture decision records](docs/decisions/)
- [Documentation index](docs/README.md)

The older [general runtime architecture](docs/GENERAL_RUNTIME_ARCHITECTURE.md),
[plan review](docs/PLAN_REVIEW.md), and
[deep audit](docs/DEEP_AUDIT.md) remain useful pre-pivot design and security
references. Where they conflict with the four product-first documents above,
the Robin product requirements, build plan, CLI architecture, and ADR-0007
control.

## License

[MIT](LICENSE)
