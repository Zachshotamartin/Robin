# Guarded Agent Handoff

## Current Milestone

Milestone A — Deterministic runtime kernel is complete. Its implementation,
evidence, CLI, CI configuration, and current-status documentation are intended
to be resumed from local `main`. Milestones B through H remain unimplemented
and must proceed in order.

The implemented boundary is intentionally provider-free and in memory. The
repository now proves one generic synthetic task and one virtual coding task
through the same strict contracts, pure reducer, command planner, synchronous
host, event store, and event-derived `guard run` CLI. It does not claim the
durability, policy language, filesystem isolation, provider connectivity,
credential handling, daemon, evaluation, or editor guarantees assigned to
later milestones.

## Milestone A Gate Evidence

- The v1 corpus at
  `packages/runtime/testdata/generic-events-v1.json` contains one strict,
  canonical envelope for each of the 43 generic event types.
- `packages/runtime/src/gate-a-evidence.test.ts` proves every event has a
  reachable reducer/effect/replay oracle, every intent has a complete
  legal-state matrix, terminal projections cannot reactivate, histories reject
  gaps and duplicates, and replay remains deterministic without ambient clock,
  randomness, fetch, or external effects.
- `packages/agent-driver` and `packages/model-provider` verify exact semantic
  transcripts, immutable detached ordinary input, strict nested contracts,
  cancellation, exact capability identities, and fail-closed proxy handling
  without trap execution or script consumption.
- `packages/milestone-a-scenarios` proves the 19-event synthetic transform and
  33-event virtual coding histories byte-for-byte against checked-in goldens.
  Replay uses concrete fail-on-call ports and records zero effect calls. The
  coding fixture remains unchanged.
- `apps/cli` proves human, JSONL, and quiet views, exact objective bounds,
  forbidden provider/agent/credential flags, stable exit codes, real
  subprocess execution of both profiles, and an actual offline tarball install
  with its local workspace dependency closure.
- Architecture tests keep capability packs, provider adapters, task brands,
  and direct Ajv use out of the generic kernel. Repository policy tests enforce
  exact dependencies, the narrow reviewed allowlist, a matching lockfile,
  pinned CI actions, read-only CI permissions, stable text, and credential
  canaries.

## Last Green Verification

The following commands passed on 2026-08-30 from a clean committed lockfile:

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm run test:contracts
git diff --check
git fsck --no-dangling --no-reflogs
```

`npm ci --ignore-scripts` installed 24 packages, audited 39 packages, and
reported zero vulnerabilities. `npm run check` passed 16 repository tests and
289 workspace tests (305 total) after strict typechecking every workspace.
`npm run build` passed for all 14 workspaces. `npm run test:contracts` reran all
289 workspace tests successfully, including both scenario suites and the CLI
package/install tests.

The local verification runtime was Node.js 26.7.0 with npm 11.19.0. CI is
configured for Node.js 22, uses `npm ci --ignore-scripts`, and has static,
deterministic-unit/golden, and Milestone A contract jobs. Hosted CI did not run
because this local repository has no configured remote.

## Repository and Remote State

The repository is a local Git repository under the portfolio projects
directory. No `origin` remote is configured. The installed GitHub CLI reports
that its selected GitHub credential is invalid, so this run could not create a
remote repository, push branches, open a pull request, observe hosted CI, or
perform a remote merge. Do not claim those steps happened.

The Milestone A change set was validated as a clean branch before local merge.
If remote review is required, authenticate `gh`, create or select the intended
private repository, add `origin`, push `main`, and push future milestone
branches. Never place the credential in a command argument, repository file,
event, fixture, or transcript.

## Environment-Gated Suites

Milestone A introduces no PostgreSQL, Git-filesystem, or container integration
suite, so no applicable suite was skipped.

For future milestones, the Docker CLI is installed but its daemon was not
reachable at the end of this run. The PostgreSQL client is installed, but
`pg_isready` found no server on the default local socket/port. Milestone C must
report Linux/container tests as explicitly skipped when the required isolated
runner is unavailable; Milestone E must do the same for PostgreSQL integration
tests. Do not convert absent infrastructure into a passing result.

## Next Unfinished Step

Start Milestone B — Policy and context boundary from up-to-date `main` on
`milestone/b-policy-context-boundary`. Before editing, rerun the clean commands
above and reread the Milestone B sections in the
[implementation guide](docs/IMPLEMENTATION_GUIDE.md),
[build plan](docs/BUILD_PLAN.md), [deep audit](docs/DEEP_AUDIT.md),
[threat model](docs/THREAT_MODEL.md), and
[operations/test plan](docs/OPERATIONS_TEST_PLAN.md).

The first unfinished implementation step is to write the `.guard` grammar and
reviewed policy examples. Continue the binding order without skipping ahead:

1. grammar and examples;
2. lexer, parser, source-span diagnostics, formatter, and round-trip tests;
3. attribute catalog, type checker, three-valued evaluator, precedence, and
   explanation trace;
4. immutable policy snapshots pinned to runs;
5. generic resource canonicalization and the coding repository-path adapter;
6. context byte/item budgets, media/binary handling, secret classifiers, and
   manifests;
7. routing every source read and agent-safe capability view through the broker;
8. policy enforcement in the capability gateway while executing the exact
   immutable normalized object;
9. `policy check`, `test`, `explain`, and `simulate` CLI commands; and
10. hostile path, secret, injection, mutation, and canary corpora required by
    Gate B.

Finish Gate B completely before starting Milestone C. The Gate B definition
requires exhaustive three-valued truth tables and presence tests,
platform-independent canonical globs, all search/path/snippet/tool output to
cross the context boundary, serialized request-byte canaries, and the required
policy mutation score.

## Open Decisions

No Milestone A implementation constraint contradicted an accepted plan choice,
so this milestone added no corrective ADR. The complete deferred-decision
register remains [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md).

Milestone B must preserve OQ-02's current fail-closed choice: v1 `matches` is a
compiled anchored glob, not a runtime regular-expression feature. OQ-01 keeps
general network egress denied. Do not silently reopen either decision; a
triggered change requires an ADR and the named threat/test updates.

## Current Known Limitations

- Events, commands, and active state are process memory only; process exit has
  no durable resume contract.
- Phase-A policy is pure-operation allow, otherwise deny; there is no `.guard`
  parser/evaluator or live approval workflow.
- Repository operations use closed virtual fixtures and cannot touch the host
  filesystem, Git, a process, a container, or a network.
- Scripted/synthetic adapters do not connect to a real model or external agent
  and accept no API key.
- The CLI runs only the two fixed evidence profiles and buffers output until a
  run finishes.
- There is no daemon, PostgreSQL store, credential broker, evaluation control
  plane, ACP/MCP/contained-agent bridge, VS Code extension, or Code-OSS fork.

The [README](README.md) and [Event Model v1](docs/event-model.md) are the
current user-facing references. Planned claims in the longer design documents
remain planned until their milestone gates pass.
