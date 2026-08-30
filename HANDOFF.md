# Guarded Agent Handoff

## Current Milestone

Milestone B — Policy and context boundary is complete on local branch
`milestone/b-policy-context-boundary`. Milestone A remains preserved as the
deterministic runtime foundation; Milestones C through H remain planned and
must proceed in order.

The implemented runtime is still intentionally in process, provider-free, and
credential-free. It supports interchangeable generic ports, but its runnable
profiles use the scripted driver, synthetic provider probe, in-memory event
store, brokered in-memory/contained-repository sources, and virtual capability
fixtures. It does not yet run an arbitrary model or agent, accept an API key,
mutate a host checkout, execute a process/container, persist to PostgreSQL, or
serve a daemon/editor client.

## Milestone B Gate Evidence

- `@guard/policy-language` implements the bounded handwritten Guard v1 lexer,
  Pratt parser, precise UTF-8/source spans, multi-error recovery, typed AST,
  canonical formatter, idempotent round trips, hostile nesting handling, and
  checked-in examples. Its final suite passes 34/34.
- `@guard/policy-engine` composes closed versioned attribute catalogs, type
  checks rules, implements complete three-valued truth tables and explicit
  presence, deterministic deny/approval/allow precedence, anchored canonical
  path globs, secret-safe traces, immutable run-pinned snapshots and sets,
  exact table corpora, and paged effect-free simulation. Its final suite passes
  19/19.
- Every shipped policy owns the ten categories required by Operations Plan
  section 8.7. Structural inapplicability assertions are bound to exact rule
  signatures so a later policy edit invalidates the waiver. Initial-rollout
  simulation uses an exact nonmatching default-deny baseline and recorded
  normalized-action corpus.
- Initial rollout counts are listed as `newly allowed / newly denied / newly
  approval-gated`: root default `1/0/2`; repository context `4/0/0`; generic
  context `4/0/0`; root strict `8/0/4`; CLI allow-pure `1/0/0`; CLI deny-pure
  `0/0/0`. The CLI strict copy is byte/corpus-bound to root strict. Every newly
  allowed action is asserted `sideEffectClass: "none"`; no consequential action
  became newly allowed.
- The production default policy additionally rejects sandboxed `run_tests`
  actions unless the side-effect class is exactly `none` and the network
  profile is exactly `disabled`. Dedicated external-side-effect and outbound-
  network near misses reproduce and prevent the former forward-safety gap.
- `@guard/context-broker` implements immutable source registration, generic
  resource canonicalization, per-resource/turn/run byte and item budgets,
  bounded media/binary handling, secret and prompt-injection classification,
  manifest accounting, exact policy projection, release deduplication, and
  cross-item secret checks. Its final suite passes 39/39.
- `@guard/capability-repository` owns portable canonical path semantics,
  descriptor-safe/no-follow contained reads, symlink/hard-link/sparse/FIFO/
  socket and TOCTOU defenses, literal search, bounded line reads and patches,
  structural unified-diff inspection, `guard.repo` v3 multi-path input policy,
  and independently brokered output identifiers. Its final suite passes 49/49.
- The gateway executes only a one-use receipt it issued after evaluating the
  exact immutable normalized action. Deny and approval decisions keep handler
  spies at zero; malformed decisions fail closed; allowed handlers and output
  classifiers receive the same action object. Repository normalization does no
  source read before authorization. Denied/failed capability-output release
  suppresses pack-provided audit and human payloads as defense in depth.
- Broker-current Milestone A scenarios now produce exact 23-event synthetic
  and 40-event coding histories. Historical 19/33 v1 histories remain
  byte-exact replay fixtures. Replay is pure and records zero source, handler,
  broker, driver, and provider effects.
- `@guard/milestone-b-scenarios` passes 16/16 deterministic Gate B cases:
  generic/coding safe runs, exact provider-boundary bytes, raw/encoded/split/
  identifier/filename/search/summary canaries, restricted/binary/`.env` source
  denial, prompt injection without authority, mixed-path zero-read denial,
  output-path denial, secret content/hash surface scans, infrastructure failure,
  and broker configuration mutation.
- Boundary mutation testing kills 14/14 configured critical mutants (100%);
  policy mutation testing kills 23/23 (100%). There are no critical survivors
  or claimed equivalent mutants.
- The CLI passes 65/65 tests, including source-installed subprocess runs,
  offline tarball installation with the local workspace closure, strict input
  files, and `policy check|format|test|explain|simulate` without effects.
- Repository checks pass 20/20 and enforce documentation integrity, package
  direction, generic-kernel isolation, exact dependency/lockfile policy,
  credential scanning, Gate B aggregation, mutation configuration, and pinned
  read-only CI actions.

## Last Green Verification

The following completed successfully on 2026-08-30 from clean committed
implementation HEAD `099b5116ea0c8dfd4d6ec749992e78db8b1c9549`:

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm run test:gate:b
git diff --check
git fsck --no-dangling --no-reflogs
```

`npm ci --ignore-scripts` added 27 packages, audited 45, and reported zero
vulnerabilities. `npm run check` typechecked and tested all 17 workspaces plus
20 repository checks. `npm run build` built all 17 workspaces. The Gate B
aggregate reran the 20 repository checks, all contract workspaces, the 16-case
deterministic eval, and both 100% mutation suites. Generated mutation state was
removed by the runner; the final worktree was clean. The local runtime was
Node.js 26.7.0 with npm 11.19.0; CI remains configured for Node.js 22.

## Repository and Remote State

No `origin` remote is configured. The installed GitHub CLI credential was
previously invalid, so this run could not create/push a remote repository, open
a pull request, observe hosted CI, or perform a remote merge. Do not claim any
of those occurred. The local milestone branch and commits are the available
review history.

After a remote credential becomes available, create or select the intended
private repository, add `origin`, and push without exposing a token in command
arguments, files, fixtures, logs, events, or transcripts.

## Environment-Gated Suites

Milestone B has no PostgreSQL or container integration suite, so no applicable
Gate B evidence was skipped. Docker CLI is installed but its daemon was not
reachable in this environment. The PostgreSQL client is installed, but
`pg_isready` found no server on the default socket/port. Milestone C must report
container tests explicitly skipped for missing Docker infrastructure while
still running all host Git/filesystem tests; Milestone E must do the same for
PostgreSQL. Missing infrastructure must never be presented as passing evidence.

## Next Unfinished Step

Merge the green Milestone B branch locally into up-to-date `main`, then create
`milestone/c-isolated-filesystem-execution`. Before an adapter is introduced,
write an ADR for prepared patch validation receipts and exact artifact
application. Then add the domain-neutral lifecycle/compensation, run-scoped
composition, namespaced-event, and live-cancellation seams required by real
effects without importing Git/process vocabulary into kernel packages.

Continue Milestone C in this order:

1. local content-addressed artifact storage with bounded atomic writes and
   immutable run references;
2. trusted argv-only Git adapter, repository inspection, owner-only run
   directories, raw-blob tree materialization, and detached worktrees;
3. exact patch parsing, post-policy source validation, artifact binding,
   `git apply --check`, trusted application, internal no-hook checkpoints,
   pre-action-only rollback, and stable final diff export;
4. reviewed process-recipe resolution and shell-free execution contracts;
5. disposable no-hard-link execution snapshots with no `.git` or authoritative
   worktree mount;
6. Docker capability detection and pinned network-disabled sandbox profiles;
7. timeout, cancellation, bounded stdout/stderr artifacts, process-tree stop,
   and idempotent owned-orphan cleanup;
8. a scripted coding run that applies only exact validated artifact bytes in a
   disposable worktree, runs tests in an execution snapshot, returns a tested
   final patch, and proves the original checkout is byte-for-byte unchanged on
   success, failure, and cancellation.

Gate C additionally requires trusted checkpoints, later-write rollback that
preserves earlier writes, no process access to authoritative state, inert
repository hooks/filters/text conversion, and fail-closed submodule/LFS/
unsupported-attribute handling. Do not start Milestone D until those claims are
demonstrated or honestly environment-gated where Docker is required.

## Open Decisions

Accepted implementation decisions are ADR-0001 through ADR-0006. Milestone B
did not reopen OQ-01 (network egress remains denied) or OQ-02 (Guard `matches`
remains an anchored glob, not runtime regular expressions). A genuine design
contradiction requires a new ADR plus the named threat and test updates.

## Current Known Limitations

- Events, commands, policy pins, manifests, and active state are process memory;
  process loss has no durable resume contract.
- `require_approval` stops dispatch, but no durable approval inbox, decision,
  expiry, consumption, or precondition revalidation service exists yet.
- Real repository reads are contained and brokered, but capability mutation
  remains virtual. There is no Git worktree manager, patch application,
  authoritative checkpoint, process runner, execution snapshot, or sandbox.
- Scripted/synthetic adapters do not connect to a hosted/local model or
  external agent. The CLI accepts no API key or credential reference.
- There is no PostgreSQL store, daemon, worker/lease recovery, encrypted
  transcript, evaluation control plane, research profile, ACP/MCP/contained
  agent bridge, VS Code extension, or Code-OSS fork.

The root [README](README.md), [Event Model v1](docs/event-model.md), and
[Policy Language v1](docs/policy-language.md) are the implemented user-facing
references. Longer plans describe future milestones unless a current evidence
section says otherwise.
