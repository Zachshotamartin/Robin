# Robin Handoff

## Product Direction

Robin is a provider-flexible coding-agent CLI in the product category of Claude
Code. The primary product is the terminal coding agent: an interactive
conversation that will understand a repository, use coding tools, edit files,
run verification, and help review Git changes. Policy, context, events,
capability mediation, and isolation are internal control-plane layers. The CLI
is a client of those layers, not a policy-debugger product with a thin command
wrapper.

The pivot is recorded in
[ADR-0007](docs/decisions/ADR-0007-robin-coding-agent-product-pivot.md). The
normative plan is split across:

- [Product requirements](docs/PRODUCT_REQUIREMENTS.md)
- [CLI architecture](docs/ROBIN_CLI_ARCHITECTURE.md)
- [Exhaustive build plan](docs/BUILD_PLAN.md)
- [Provider and agent compatibility](docs/PROVIDER_AGENT_COMPATIBILITY.md)
- [Operations and test plan](docs/OPERATIONS_TEST_PLAN.md)
- [Terminal compatibility](docs/TERMINAL_COMPATIBILITY.md)

## Repository and Git State

- Local repository: `/Users/zacharymartin/Desktop/portfolio_projects/Robin`
- GitHub repository: `https://github.com/Zachshotamartin/Robin`
- Origin: `https://github.com/Zachshotamartin/Robin.git`
- Accepted default branch: `main` at `fb64cf1`
- R0 candidate branch: `codex/robin-cli-pivot` at `23c99a8`
- R0 pull request #2 merged with merge commit `2c042ca`; the merge-triggered
  Gate A/B workflow passed, so R0 is accepted.
- R1 branch `codex/robin-r1-interactive-loop` passed all nine required checks at
  reviewed head `9907287` in pull request #3 and merged as `fb64cf1`.
- The merge-triggered `main` workflow also passed all nine R1 jobs, so R1 is
  accepted rather than candidate-only evidence.
- Active R2 branch: `codex/robin-r2-real-tool-loop`, created from accepted R1.
- The repository is public. GitHub secret scanning and push protection are
  enabled.
- Superseded pull request #1 is closed and archival.

The unfinished pre-pivot Milestone C prototype remains preserved on
`milestone/c-isolated-filesystem-execution` at `4743044`. Its audit is
`docs/MILESTONE_C_WIP_AUDIT.md` on that branch. It has known artifact-store,
worktree, gateway, and lockfile defects; port reviewed pieces only when a Robin
vertical slice needs them.

## Accepted Baseline

Milestones A and B remain accepted only for their narrow internal-substrate
claims: strict contracts, deterministic event/replay behavior, policy parsing
and evaluation, bounded context, a capability gateway, virtual repository
fixtures, deterministic scenarios, mutation checks, and their existing evidence.
They are not a usable coding-agent release.

## Accepted R1 Baseline

The R1 branch implements a credential-free, no-network vertical slice of the
terminal product:

- `packages/robin-session`: schema-version-1 application events, strict parsing,
  a pure session reducer, prefix replay, and projections;
- `packages/robin-agent`: provider-item collection, prompt compilation, explicit
  budgets, a provider-neutral multi-request tool loop, and serialized turn
  coordination;
- `packages/robin-application`: one ephemeral application path, an in-memory
  bounded ordered journal, lazy replay-then-live subscriptions with per-reader
  backlog limits, FIFO prompt queue, cancellation ownership, bounded close with
  late-provider fencing, gateway tool dispatch, and deterministic provider
  composition;
- `packages/robin-terminal`: capability detection, grapheme-aware editing,
  exact 65,536-byte composer/paste bounds, reducer-driven terminal state, raw
  and flat renderers, single-owner interrupt escalation, stale-frame rejection,
  and terminal restoration;
- `apps/cli`: `robin`, `robin "prompt"`, and experimental `robin -p` text,
  JSON, and streaming-JSON surfaces over the same application path;
- two pinned read-only synthetic coding tools over immutable in-memory fixtures;
- real-PTY scenarios for multi-turn use, queuing, cancellation escalation,
  resize, bracketed paste, provider/tool failures, flat fallback, and restoration;
- reviewed package inventory generation, isolated offline installation,
  installed raw-PTY execution, state/cwd canaries, and uninstall verification;
- SHA-pinned Linux PTY, macOS PTY, package-smoke, and fail-closed R1 aggregate CI
  jobs plus an R1 evidence-capture descriptor.

The accepted R1 slice does **not** read or modify the physical repository, execute a
process or Git command, call a hosted model, accept an API key, persist or resume
a session, provide a strict sandbox, publish a supported package, or expose the
stable automation protocol. Those capabilities remain owned by later gates.
Those limitations are deliberate R1 boundaries, not missing R1 acceptance
evidence. R2 owns the first physical-workspace and process effects.

## Active R2 Candidate

The unaccepted `codex/robin-r2-real-tool-loop` branch now composes the accepted
R1 terminal and provider-neutral loop with a real coding workflow:

- startup requires and binds the current physical Git worktree, then exposes
  canonical root, repository identity, initial HEAD/branch, and initial dirty
  status as presentation-only facts;
- `packages/tool-workspace` implements bounded list, explicit-path literal
  search, classified whole/byte/line reads, exact-preimage structured patches,
  atomic file creation/replacement, stale checks, and an in-memory edit ledger;
- `packages/tool-process` implements direct executable-plus-argv requests,
  reviewed executable resolution, filtered environments, bounded ordered
  stdout/stderr, timeout/cancellation escalation, and process-group cleanup;
- `packages/tool-git` implements controlled Git discovery plus bounded,
  read-only status and working/staged diff operations;
- `packages/robin-tools` registers exactly eight R2 tools and ensures that the
  normalized action approved by policy is the action dispatched once;
- `packages/robin-session` and `packages/robin-application` record exact
  approval request/resolution/invalidation state and bounded `ToolOutputDelta`
  events without turning replay or UI state into execution authority;
- `packages/robin-terminal` and `apps/cli` present complete approval scope,
  accept only exact typed allow-once/deny decisions, render safe ordered live
  output, and fail closed on cancellation, EOF, paste, or headless approval;
- `synthetic-r2-v1` deterministically lists, searches, reads, edits, runs
  `npm test`, handles one ordinary failure with a re-read and second edit, reruns
  verification, and reviews final Git status/diff in generated repositories;
- the accepted immutable R1 path remains selectable with
  `--model synthetic-r1-v1`.

R2 edits the live checkout immediately after each exact approval. Sessions and
approvals are ephemeral. Approved processes run directly on the host with **no
filesystem isolation and no network isolation**; reduced environment, direct
argv, output bounds, and process ownership are not a sandbox. R2 has no hosted
or local production provider, API-key input, BYOK onboarding, durable resume,
shell tool, network tool, file delete/move, Git mutation, or supported package
release. Provider/model breadth remains R4 and later work.

These are branch-candidate claims backed by current source and focused tests,
not accepted release claims. R2 becomes accepted only after its complete PTY,
repository-safety, packaging, hosted matrix, documentation, and aggregate gate
pass at one reviewed head and the merge-triggered mainline gate also passes.

## Immediate Next Work

1. Finish and freeze the R2 candidate: complete raw/flat PTY approval and
   live-output acceptance, repository safety/oracle checks, source-package
   smoke validation, reviewed package-inventory refresh, hosted R2 candidate
   results, evidence configuration/capture, and truthful live-workspace/no-
   sandbox documentation at one exact commit. Delete, move, shell strings,
   network, workspace executables, and Git writes remain absent or denied at
   this gate.
2. Build R3 durable local sessions, crash recovery, `continue`, and `resume` on
   the R2 tool path.
3. Build R4 around the frozen provider-neutral port with one hosted provider,
   model discovery, session-scoped bring-your-own-key onboarding, redaction, and
   explicit manual real-provider smokes. CI must remain credential-free.
4. Continue through R5 permissions and strict sandboxing, R6 daily Git workflow,
   R7 provider breadth and stable automation, and R8 configuration, trust, and
   instructions before calling Robin a supported first release.

## Verification

Run from the repository root:

```bash
npm ci --ignore-scripts
npm run evidence:validate-config:r1
npm run test:repository
npm run test:unit
npm run test:gate:b
npm test --workspace @guard/tool-workspace
npm test --workspace @guard/tool-process
npm test --workspace @guard/tool-git
npm test --workspace @guard/robin-tools
npm test --workspace @guard/robin-application
npm test --workspace @guard/robin-terminal
npm test --workspace @zachshotamartin/robin
npm run test:pty
npm run test:package
npm run test:gate:r1
npm run test:gate:r2
git diff --check
```

The local aggregate intentionally overlaps narrower commands so that individual
failures remain diagnosable. Local macOS results do not substitute for the
configured hosted Linux and macOS jobs. The reviewed package inventory must be
regenerated only after source freeze and measured on every recorded platform/npm
profile; never infer or hand-author an unmeasured archive hash.

## Invariants That Must Survive

- Planned behavior stays labeled planned; candidate evidence is not acceptance.
- No real secret or private source enters code, fixtures, argv, logs,
  transcripts, diagnostics, package contents, or CI artifacts.
- Partial or unvalidated provider tool calls never execute.
- Policy evaluates the same immutable normalized action that a handler receives.
- Replay never performs effects, and an uncertain effect never becomes success.
- Existing and concurrent user workspace changes must be preserved.
- Requested strict isolation must fail closed instead of silently degrading.
- Provider and UI adapters depend on the shared application contracts; they do
  not fork the agent loop or become enforcement boundaries.
- Do not build a VS Code fork before the CLI engine and client protocol prove
  that an ordinary extension is insufficient.
