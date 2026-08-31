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
- Accepted default branch: `main` at `2c042ca`
- R0 candidate branch: `codex/robin-cli-pivot` at `23c99a8`
- R0 pull request #2 merged with merge commit `2c042ca`; the merge-triggered
  Gate A/B workflow passed, so R0 is accepted.
- R1 candidate branch: `codex/robin-r1-interactive-loop`, stacked on the R0
  source history and awaiting its accepted-main merge commit.
- R1 candidate head: `dc39937`; pull request #3 is stacked on pull request #2.
- The configured Linux PTY, macOS PTY, package-smoke, and R1 aggregate jobs pass
  on that exact stacked head. A base-changing update requires a fresh run.
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

## Unaccepted R1 Candidate

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

This candidate does **not** read or modify the physical repository, execute a
process or Git command, call a hosted model, accept an API key, persist or resume
a session, provide a strict sandbox, publish a supported package, or expose the
stable automation protocol. Those capabilities remain owned by later gates.
R1 remains unaccepted until the candidate is refreshed against accepted
`main`, the exact hosted Linux/macOS/package/aggregate evidence passes again
on that reviewed head, and the candidate is merged.

## Immediate Next Work

1. Retarget pull request #3 to `main`, merge accepted `main` into the R1
   branch without rewriting its evidence history, update acceptance status,
   require `gate-b`, `pty-linux`, `pty-macos`, `package-smoke`, and
   `r1-candidate` to pass again on the exact head, validate the clean-commit R1
   evidence manifest, and only then merge and mark R1 accepted.
2. Build R2 as the first genuinely useful local coding slice: bounded physical
   repository status/list/search/read, exact-preimage create/edit/apply, direct
   argv-based process execution, focused verification, and final status/diff in
   disposable real-Git fixtures. Delete, move, shell strings, network, and Git
   writes remain registered but denied at that gate.
3. Build R3 durable local sessions, crash recovery, `continue`, and `resume` on
   the R2 tool path.
4. Build R4 around the frozen provider-neutral port with one hosted provider,
   model discovery, session-scoped bring-your-own-key onboarding, redaction, and
   explicit manual real-provider smokes. CI must remain credential-free.
5. Continue through R5 permissions and strict sandboxing, R6 daily Git workflow,
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
npm run test:pty
npm run test:package
npm run test:gate:r1
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
