# Robin Coding-Agent CLI: Installation, Testing, Operations, and Release Plan

Document status: normative lifecycle, verification, and release specification
for the Robin product pivot.

Last revised: 2026-08-30.

Companion sources of truth:

- [Product requirements and user flows](PRODUCT_REQUIREMENTS.md)
- [Exhaustive build plan](BUILD_PLAN.md)
- [Coding-agent CLI architecture](ROBIN_CLI_ARCHITECTURE.md)
- [Provider, credential, and external-agent compatibility](PROVIDER_AGENT_COMPATIBILITY.md)
- [Threat model](THREAT_MODEL.md)
- [ADR-0007: Make Robin a coding-agent CLI product](decisions/ADR-0007-robin-coding-agent-product-pivot.md)

This plan governs the complete lifecycle of Robin as a terminal coding agent:
developer bootstrap, repository protection, dependencies, local data,
configuration, credentials, test design, CI, packaging, installation, updates,
rollback, deletion, diagnostics, privacy, incident response, and R0–R12 release
evidence.

Robin's default architecture is one local CLI process operating on the user's
repository and an owner-only file-backed session store. **Local Robin does not
require PostgreSQL, Docker or Podman, a resident daemon, a cloud Robin service,
or an editor.** A supported platform sandbox may be enabled for commands. A
container runtime may be used by isolated CI or optional sandbox conformance
tests, but it is not part of normal installation or first run. A later editor
client launches or connects to the same local engine contract without creating
a second agent loop.

The repository currently contains the accepted Milestones A and B substrate and
an in-progress R1 preview: an ephemeral, multi-turn, provider-neutral session
path backed only by the credential-free synthetic provider. The full R0 and R1
gates remain open. Real workspace tools, file-backed resume, hosted providers,
credentials, sandboxing, release packaging, and later extension surfaces are
planned until their named gates in this document pass.

## 1. Operating Model and Lifecycle Invariants

### 1.1 Lifecycle coverage

This document supplies concrete controls for all of these stages:

1. Create, protect, and maintain the Git repository.
2. Bootstrap a clean developer machine without hidden global state.
3. Review, pin, install, update, and remove dependencies.
4. Resolve platform support and optional enforcement capabilities.
5. Create and protect local configuration, state, cache, logs, and credentials.
6. Persist sessions and artifacts without a database or daemon.
7. Validate configuration and workspace trust before repository or provider I/O.
8. Test terminal behavior, the agent loop, providers, repository tools, edits,
   processes, Git, sessions, permissions, credentials, context, and extensions.
9. Separate deterministic CI from protected secret-bearing workflows.
10. Measure latency, memory, disk, cancellation, and output behavior.
11. Build and verify source, npm, archive, and optional standalone artifacts.
12. Install, update, roll back, uninstall, and purge exact owned resources.
13. Diagnose failures and create redacted support bundles.
14. Apply explicit privacy, retention, and deletion rules.
15. Respond to credential, mutation, sandbox, provider, session, and supply-chain
    incidents.
16. Close R0 through R12 only with requirement-linked evidence.

### 1.2 Default local process topology

The normal interactive path is deliberately small:

```text
developer terminal
       |
       v
one robin process
  terminal controller
  session coordinator
  direct-model agent loop
  provider adapter and credential broker
  repository, edit, process, and Git tools
  permission evaluator
       |
       +---- owner-only local files and OS credential store
       +---- selected model endpoint
       +---- child command processes, optionally sandboxed
```

The CLI owns its terminal, foreground session, child process groups, provider
requests, and file-store writer lock. It releases all of them on handled exit.
An interactive session does not connect to PostgreSQL and does not start or
require a background service. Headless mode invokes the same application
services in the same process.

At R9, an explicitly requested background session may use a separately launched
Robin supervisor process with an authenticated local protocol and an exact
session lease. Foreground operation remains available without installing that
supervisor as a service. Background supervision cannot become a prerequisite
for `robin`, `robin --print`, `robin --continue`, local session inspection, or
local deletion.

### 1.3 Non-negotiable operations invariants

- A user-facing claim is current only after its named automated and manual
  evidence passes on the supported matrix.
- No real provider call occurs in ordinary tests. Ordinary tests also do not
  contact a package registry, update service, Git host, analytics service, or
  arbitrary network endpoint.
- A raw provider credential never appears in argv, project configuration,
  session frames, transcripts, logs, child environments, diagnostic bundles,
  package artifacts, Git, or CI artifacts.
- Provider egress is disabled until the user selects a provider, resolves a
  credential strategy if needed, and accepts workspace/configuration trust.
- Project files cannot weaken user or managed policy, enable bypass mode, add a
  trusted credential source, or approve their own extensions.
- Every repository mutation, command, Git write, network action, extension
  effect, and external provider request has a normalized owner and bounded
  lifecycle.
- Pre-existing user changes are never reset, cleaned, overwritten, attributed
  to Robin, or deleted by a recovery or uninstall flow.
- Session replay, migration inspection, export, doctor, and dry-run deletion do
  not call a provider or execute a coding tool.
- Consequential effects with uncertain outcomes are reconciled before retry.
- Strict sandbox mode never falls back silently. Permission approval is never
  described as process isolation.
- Every cleanup or purge resolves exact targets, validates Robin ownership, and
  reports partial failure without broad recursive deletion.
- Release automation publishes only the exact reviewed commit and immutable
  dependency lock, and it produces provenance for every artifact.

### 1.4 Status vocabulary

Lifecycle documentation uses these terms:

| Term | Meaning |
| --- | --- |
| Implemented | Present on the release commit and covered by its required evidence. |
| Preview | Shipped behind an explicit preview channel or flag with documented limitations and rollback. |
| Planned | Specified but unavailable; no current support claim is permitted. |
| Supported | Tested on every required matrix cell and covered by release support policy. |
| Compatible | Passed a named subset or adapter contract; unsupported behavior is listed. |
| Experimental | Manually enabled development path excluded from release support and compatibility guarantees. |
| Deferred | Deliberately outside the active gate and forbidden as a completion dependency. |

### 1.5 Global release pass rule

A gate passes only when all applicable checks are green from the same commit:

- source and generated-file policy;
- strict type checking and architecture boundaries;
- deterministic unit, golden, contract, integration, adversarial, and
  end-to-end suites assigned to the gate;
- supported-platform matrix;
- package installation and uninstall smoke tests;
- migration and rollback fixtures for persisted changes;
- redaction scan over logs and uploaded artifacts;
- requirement-to-evidence validator;
- documentation that separates current from planned behavior;
- no unresolved critical or high security defect in the shipped scope.

Rerunning only a failed job does not erase the first failure. The release record
links both attempts and explains whether the cause was code, test nondeterminism,
or external infrastructure.

## 2. Supported Environment and Capability Matrix

### 2.1 Support tiers

- **Tier 1:** every pull request runs deterministic coverage; every release
  candidate runs installation, terminal, repository, session, provider-contract,
  and package tests.
- **Tier 2:** main and release candidates run the complete applicable suite;
  known platform differences are documented and no Tier 1 parity claim is made.
- **Preview:** selected maintainers run a versioned manual/automated checklist;
  limitations appear in `robin doctor` and release notes.
- **Unsupported:** startup may work, but Robin makes no operational or sandbox
  guarantee and issue reports require reproduction on a supported target.

### 2.2 Host operating-system matrix

The exact patch versions used by a release are recorded in its compatibility
manifest. The initial target matrix is:

| Platform | Architecture | Tier | Required behavior |
| --- | --- | --- | --- |
| macOS 15 and macOS 26 | arm64 | Tier 1 | Source/npm install, interactive terminal, file sessions, R7+ Keychain credentials, process groups, Git, optional verified Seatbelt adapter. |
| macOS 15 and macOS 26 on Intel models supported by the tested Node line | x64 | Tier 2 while hosted runners and Node support remain available | Same CLI semantics; standalone artifact and sandbox claim require a tested x64 build. |
| Ubuntu 24.04 LTS and 26.04 LTS | x64 | Tier 1 | Source/npm install, interactive terminal, file sessions, R7+ Secret Service or deliberate non-plaintext fallback credential source, process groups, Git, optional bubblewrap adapter. |
| Ubuntu 24.04 LTS and 26.04 LTS | arm64 | Tier 2 | Same source behavior; standalone package and sandbox backend require arm64 evidence. |
| WSL2 with Ubuntu 24.04 LTS on Windows 11 24H2 or 25H2 | x64 | Preview through R10 | Linux CLI, file store, Git, and PTY paths; host/guest path performance and sandbox limitations reported explicitly. |
| Native Windows 11 24H2 and 25H2 | x64 and arm64 | Deferred until a dedicated R10 portability gate | No release claim until path, ConPTY, process-tree, ACL, credential, atomic-write, Git, and sandbox contracts pass. |
| Other Linux distributions | supported Node architectures | Experimental | May run from source; distro-specific credential, PTY, filesystem, and sandbox behavior is unclaimed. |

“Maintained release” does not automatically add support. A newly released OS
enters Tier 2 first, completes the compatibility suite, and moves to Tier 1 in a
documented Robin release.

### 2.3 Node.js and npm matrix

| Component | Minimum | Release matrix | Policy |
| --- | --- | --- | --- |
| Node.js source runtime | 22.0.0 | Latest security patch of Node 22 and Node 24 while both remain supported by Robin | `package.json` enforces the minimum. A new even-numbered release begins in Tier 2 after provider, PTY, filesystem, and package tests. |
| npm | 10.0.0 | npm version bundled with each tested Node line plus the repository minimum | CI uses `npm ci --ignore-scripts`; dependency changes use reviewed exact-version installation. |
| TypeScript | Exact lockfile version | One version per commit | Compiler changes require full type, declaration, fixture, and package checks. |

`robin --help` and `robin --version` must work without loading provider,
repository, credential, session, or terminal-raw-mode modules. A standalone
binary embeds its own Node runtime and reports that runtime in `robin --version`.

### 2.4 Git matrix

Robin requires Git 2.39 or newer for supported repository workflows. Release CI
tests the oldest supported version where a runner image can provide it and the
current Git packages on every Tier 1 operating system.

Required Git behaviors include:

- `status --porcelain=v2 -z` parsing;
- no-ext-diff and no-textconv diff inspection;
- exact pathspec handling, including pathspec-from-file where used;
- detached HEAD, unborn branches, linked worktrees, and separate Git common
  directories;
- staging and commit without shell interpolation;
- disabled terminal prompting in automated/read-only operations;
- safe detection of hooks, filters, signing requirements, submodules, sparse
  checkouts, LFS pointers, and repository ownership warnings.

Robin does not depend on a global Git alias, shell function, credential helper,
diff driver, pager, or user hook for correctness. When an intentional user Git
operation may invoke a hook or signing program, the permission view and result
identify that possibility.

### 2.5 Terminal matrix

| Terminal mode | Tier | Required contract |
| --- | --- | --- |
| macOS Terminal and iTerm2 | Tier 1 | UTF-8, resize, raw mode, bracketed paste, color detection, hyperlinks when enabled, terminal restoration, Ctrl-C/Ctrl-D. |
| GNOME Terminal and common VTE terminals on Ubuntu | Tier 1 | Same semantic keyboard and restoration contract; rendering snapshots account for capability detection. |
| VS Code integrated terminal | Tier 1 after R1 | Interactive flow works without editor APIs and remains a plain CLI. |
| `tmux` on a Tier 1 host | Tier 2 | Resize, color, paste, interrupt, and nested terminal restoration pass. |
| `TERM=dumb`, screen-reader mode, or no cursor addressing | Tier 1 | Append-only flat renderer, no color-only state, no cursor-motion dependency. |
| Non-TTY stdin/stdout | Tier 1 | Explicit headless mode, stable stdout/stderr separation, no ANSI, bounded stdin, deterministic exit codes. |
| Full-screen child TUI inside Robin's process tool | Unsupported in first release | Robin refuses or clearly exits the unsupported mode; it does not scrape terminal screens. |

Terminal support is semantic rather than a promise for every emulator version.
The release record names emulator, `$TERM` value, locale, dimensions, multiplexer,
and capability overrides used by manual checks.

### 2.6 Filesystem matrix

Tier 1 tests cover:

- default case-insensitive and case-preserving macOS filesystems;
- case-sensitive Linux filesystems;
- Unicode names, spaces, leading dashes, long components, empty files, CRLF,
  LF, missing final newline, executable bits, hard links, and symlinks;
- atomic rename within a state directory;
- owner-only permissions or equivalent ACLs;
- disk-full, quota, permission, antivirus/indexer interference where injectable,
  and concurrent external mutation.

Network filesystems, cloud-synchronized folders, removable media, and WSL paths
mounted from Windows are detected when practical and labeled degraded. Strict
session durability or atomic edit support must fail with an actionable message
when the backend cannot provide the required primitive.

### 2.7 Sandbox capability matrix

Sandboxing is optional for installation and mandatory only when the selected
permission mode or release claim says it is mandatory.

| Backend | Platform | Installation prerequisite | Claim |
| --- | --- | --- | --- |
| Direct process with permissions | All supported hosts | None | Robin controls normalized approval, environment, working directory, timeout, output, and cancellation; it does not claim filesystem or network isolation. |
| Seatbelt profile adapter | Supported macOS releases | Supported system facility detected by `robin doctor sandbox`; no third-party runtime | Filesystem/network restrictions only for rules verified by the backend probe and hostile tests. |
| bubblewrap plus kernel namespaces | Tier 1 Linux | `bubblewrap` package and required unprivileged namespace support | Read/write roots, process view, devices, and network namespace according to achieved probe report. |
| Docker or Podman sandbox adapter | Isolated development or CI only until separately released | Explicit runtime install and reviewed image digest | Container boundary for the child command; never a normal Robin prerequisite. |
| Native Windows sandbox | Deferred | Dedicated adapter and conformance evidence | No strict claim before R10 portability acceptance. |

`robin doctor sandbox` is read-only. It reports backend binary or system
facility, version, kernel/OS support, user-namespace status, readable/writable
probe results, network probe result, resource-limit support, and achieved tier.
It creates probes only inside a temporary Robin-owned directory and removes
them after verification.

When strict mode is selected, missing or failed sandbox evidence blocks the
command before spawn. Best-effort direct execution requires an explicit trusted
setting, is visible for every affected command, and records that no filesystem
or network isolation was achieved.

### 2.8 Per-release compatibility manifest

Every release artifact contains a machine-readable compatibility manifest with:

- Robin version, commit, build ID, channel, and build timestamp;
- Node, npm, TypeScript, Git, OS, architecture, libc, and terminal matrix;
- credential backends and versions exercised;
- filesystem and atomic-write capabilities exercised;
- sandbox backend versions, probe results, and policy hashes;
- provider adapter, API dialect, model capability, and fixture versions;
- session, configuration, event, export, tool, permission, and extension schema
  ranges;
- npm tarball hash, standalone/archive hashes, SBOM hash, and provenance link;
- known exclusions, capability degradations, and manual-test record IDs.

The compatibility manifest is generated from test facts. Release automation
fails if a claimed Tier 1 cell lacks an associated successful job and artifact.

## 3. Repository, Git, and Branch Protection

### 3.1 Canonical repository identity

The canonical remote is:

```text
https://github.com/Zachshotamartin/Robin.git
```

The repository name, default branch, npm package metadata, binary, help,
documentation, issue templates, release artifacts, and provenance must use
Robin. Historical `@guard/*` internal packages and `.guard` policy files remain
allowed until a separate schema/namespace ADR migrates them.

Verify a clone without modifying it:

```bash
git clone https://github.com/Zachshotamartin/Robin.git
cd Robin
git remote get-url origin
git branch --show-current
git status --short
git rev-parse --show-toplevel
```

The expected default branch is `main`, `git status --short` is empty, and the
resolved top level is the cloned `Robin` directory rather than a parent
repository.

### 3.2 Working branches

- Direct feature work uses `codex/<short-topic>` in Codex-managed sessions or a
  contributor branch with an equally descriptive non-protected name.
- One branch owns one coherent review scope. Security fixes may include the
  regression test and fix together but do not absorb unrelated refactors.
- Before editing, record `git status --short`, the current branch, and the base
  commit. Preserve unrelated user changes and never stage them.
- Stage explicit paths. `git add -A` is not used when unrelated changes exist.
- Rebase or merge only through non-destructive commands and only after reviewing
  local changes. Automation never uses `git reset --hard`, `git clean -fd`, or a
  forced checkout to recover a test fixture or worktree.
- Generated artifacts are committed only when repository policy names them as
  source-controlled evidence. Build directories, temporary sessions, real
  credentials, diagnostic bundles, and live provider captures are ignored.

### 3.3 Pull-request requirements

Every pull request includes:

- user-visible problem and outcome;
- gate and requirement IDs affected;
- exact packages/documents changed;
- current-versus-planned claim impact;
- risk classification: data, credential, provider egress, workspace mutation,
  process, Git, update, extension, or none;
- tests run with commands and platform;
- new fixtures, snapshots, schemas, migrations, dependencies, and release impact;
- failure and rollback behavior;
- retained limitations and follow-up issues.

Changes to path normalization, writes, process supervision, Git mutation,
permissions, credential handling, provider transport, session durability,
migration, update verification, sandboxing, MCP, hooks, or subagent isolation
require a security-boundary reviewer. Snapshot changes are reviewed semantically;
regeneration alone is not approval.

### 3.4 `main` branch protection

Once each job exists, protect `main` with:

- pull request required;
- at least one approving review and two for security-boundary or release changes;
- latest approved commit required after material changes;
- required conversation resolution;
- required status checks pinned to the current workflow names;
- force pushes and branch deletion disabled;
- repository administrators subject to the same rules except documented outage
  recovery;
- GitHub Actions token default permissions set to `contents: read`;
- release environment approval separate from merge approval;
- tag protection for `v*` and immutable published releases.

The initial required checks are `docs-policy`, `static`, `unit-contract`, and
`package-smoke`. R1 adds `pty-linux`; R2 adds `repository-tools`; R3 adds
`session-recovery`; R4 adds `provider-contract` and `credential-redaction`; R5
adds `permission-sandbox`; R7 adds the provider/Node/OS matrix; R10 adds the full
release candidate workflow. A required check is enabled only after it exists on
the default branch so protection does not create an impossible merge state.

### 3.5 Release tags and protected artifacts

- Release candidates use annotated tags `vMAJOR.MINOR.PATCH-rc.N`.
- Public releases use annotated, protected `vMAJOR.MINOR.PATCH` tags.
- The tag points to the commit whose CI run built the artifacts; release jobs do
  not rebuild from a moving branch.
- Changelog, compatibility manifest, SBOM, checksums, provenance, npm tarball,
  archives, and standalone artifacts share one release ID.
- A tag is never moved. A faulty release is deprecated or revoked and replaced
  by a new patch release.
- Before 1.0, breaking schema or CLI changes still receive explicit migration
  notes and rollback limits.

### 3.6 Fixture repository governance

Repository/Git fixtures are generated or checked in from synthetic content.
Each fixture declares:

- fixture schema and generator version;
- initial commit hash and branch topology;
- expected dirty, staged, untracked, ignored, submodule, worktree, hook, filter,
  or conflict state;
- supported operating systems;
- expected cleanup inventory;
- absence of real credentials and private source.

Tests clone a fixture into a unique temporary directory. They do not run
mutation tests against the Robin source checkout. Failure retention prints the
exact temporary path only in local/CI logs and never uploads repository content
without an explicit safe-artifact rule.

### 3.7 Repository security settings

- Enable private vulnerability reporting before public release.
- Enable dependency alerts and lockfile review.
- Keep secret scanning enabled; use only synthetic documented canaries in tests.
- Disable workflow execution from untrusted forks with repository/provider
  secrets.
- Require approval for first-time contributors before privileged workflows.
- Pin third-party GitHub Actions to immutable commit hashes and record their
  licenses and permissions.
- Disable wiki and unused package/repository features unless they have an owner
  and lifecycle plan.

## 4. Exact Developer Bootstrap

### 4.1 Required prerequisites

A clean source build requires only:

- a Tier 1 or Tier 2 host from Section 2;
- Node.js 22 or 24 and compatible npm;
- Git 2.39 or newer;
- enough local disk for `node_modules`, build output, temporary fixtures, and
  test sessions.

PostgreSQL, Docker, Podman, a Robin daemon, a model server, provider credentials,
and an editor extension are not prerequisites.

Inspect prerequisites without installing or changing them:

```bash
node --version
npm --version
git --version
git config --show-origin --get-regexp '^(core\.hooksPath|filter\.|diff\.|credential\.)'
```

The Git configuration report is diagnostic; no matching configuration may
produce no output and a nonzero command status without representing a missing
prerequisite. The report may contain helper names and paths, so it stays local
and is not uploaded automatically. A configured hook, filter, diff driver, or
credential helper is not removed by bootstrap.

### 4.2 Clean clone and deterministic install

Use this exact source bootstrap:

```bash
git clone https://github.com/Zachshotamartin/Robin.git
cd Robin
git status --short
npm ci --ignore-scripts
npm run check
npm run build
node apps/cli/dist/bin.js --version
node apps/cli/dist/bin.js --help
```

Pass criteria:

- the clone is on `main` with an empty status before installation;
- `npm ci --ignore-scripts` consumes the committed lock without rewriting it;
- no dependency lifecycle script runs;
- `npm run check` passes static, architecture, repository-policy, unit,
  scenario, and CLI tests currently assigned to the repository;
- `npm run build` produces every workspace distribution without source changes;
- version/help identify the product and binary as Robin;
- `git status --short` after build contains only explicitly documented ignored
  build output and no tracked changes.

The current deterministic fixture CLI may then be exercised without a key:

```bash
node apps/cli/dist/bin.js run --profile synthetic-demo
node apps/cli/dist/bin.js run --profile coding-virtual
```

Those commands are current substrate checks, not the planned interactive
product.

The in-progress R1 preview must also receive three credential-free smoke checks
on every developer bootstrap and package-smoke job:

```bash
node apps/cli/dist/bin.js
node apps/cli/dist/bin.js "summarize this synthetic session"
node apps/cli/dist/bin.js -p "summarize this synthetic session"
```

The first command must enter the Robin composer and complete a synthetic turn;
the second must seed the same multi-turn application with an initial prompt;
the third must produce one headless preview result with no ANSI on stdout. These
preview smokes are ephemeral, perform no repository I/O, create no durable
session, use no API key, and contact no network endpoint. The currently
implemented preview spells machine presentation as `--output-format` and
ephemeral operation as `--no-save`. The stable R7 surface intentionally migrates
those spellings to `--output` and `--no-session`; until R7, documentation and
tests must state which generation they exercise and must not imply that the
preview schemas are stable.

### 4.3 Daily branch bootstrap

Before a new work item:

```bash
git fetch --prune origin
git switch --create codex/session-store-recovery origin/main
git status --short
npm ci --ignore-scripts
npm run check
```

Use a concrete lowercase hyphenated branch matching the owned work item; the
example uses `codex/session-store-recovery`. If the working tree is not clean,
stop and identify ownership of the changes. Do not hide them with stash, reset,
clean, or checkout unless the owner explicitly chooses a recoverable operation.

### 4.4 Planned developer doctor

At R1, `npm run doctor:dev` becomes a read-only source-tree check. At R4 the
packaged equivalent is `robin doctor`. The developer doctor reports:

- OS, architecture, Node, npm, Git, locale, terminal, and filesystem capability;
- repository root, branch, HEAD, worktree/common-dir identity, and dirty-state
  summary;
- package-lock consistency and unexpected lifecycle scripts;
- writable temporary, config, data, state, and cache directories;
- owner-only permission/ACL support;
- optional credential-store create/get/delete probe using a synthetic value;
- optional sandbox backend/version/probe without enabling it;
- free disk thresholds for build, tests, and session fixtures;
- active environment overrides by name with secret-shaped values redacted;
- exact remediation code and documentation section for every failure.

The doctor never installs packages, edits shell startup files, starts a service,
changes Git configuration, creates a provider credential, contacts a provider,
or repairs permissions unless the user invokes a separate exact `fix` action.

### 4.5 Optional sandbox bootstrap

Source development and all deterministic non-sandbox suites work without a
sandbox backend.

For Linux bubblewrap tests, a maintainer may install the distribution package
and verify it:

```bash
sudo apt-get update
sudo apt-get install bubblewrap
bwrap --version
```

The use of `sudo` is outside Robin and must be an explicit developer choice.
Robin never runs these commands itself. CI images preinstall and pin the tested
package rather than mutating a shared runner during the test.

macOS uses a platform adapter only when its read-only capability probe succeeds;
there is no Robin bootstrap command that modifies macOS security settings.
Docker or Podman may be installed separately for the optional container-backend
conformance job, but normal `npm run check`, interactive coding, direct provider
use, session resume, and package smoke tests do not depend on either runtime.

### 4.6 Bootstrap failure policy

- Unsupported Node/npm/Git versions fail before build with exact observed and
  required ranges.
- A lockfile mismatch fails; bootstrap does not run `npm install` to repair it.
- A lifecycle script requirement fails dependency review rather than bypassing
  `--ignore-scripts` silently.
- A missing optional sandbox marks only the sandbox-specific suite unavailable.
- A missing provider key never blocks deterministic development or help/version.
- A dirty source tree is reported, not cleaned.
- Failure output contains no environment values, credential bytes, repository
  file contents, or absolute home path in uploaded CI annotations.

## 5. Dependency and Supply-Chain Policy

### 5.1 Exact-version and lockfile rules

- Runtime and development dependencies are exact-pinned in package manifests.
- `package-lock.json` is the only supported dependency lock for source and CI.
- CI and clean bootstrap use `npm ci --ignore-scripts`.
- `npm install` is permitted only on a deliberate dependency-change branch.
- Manifest and lockfile changes land in the same commit or pull request.
- Registry, resolved URL, integrity hash, package count, license, scripts, native
  binary, and transitive changes are reviewed before merge.
- Git URL, local path, mutable tag, unpinned pre-release, and arbitrary binary
  download dependencies require an accepted supply-chain ADR.
- Production packaging does not run dependency install scripts.

### 5.2 Dependency intake record

Every new runtime dependency has a review record containing:

1. exact problem and owning boundary;
2. why Node, the OS, Git, or an existing dependency is insufficient;
3. package name, exact version, registry source, maintainers, and release cadence;
4. direct and transitive package count and installed size;
5. license and notice obligations;
6. lifecycle scripts, native modules, bundled binaries, network downloads, and
   post-install behavior;
7. public vulnerability and maintenance history relevant to Robin's use;
8. permissions and data reachable at runtime;
9. serialization or protocol formats introduced;
10. deterministic test seam and synthetic substitute;
11. update, rollback, and removal cost;
12. alternative considered and reason rejected.

The record is linked from the pull request and included in the release SBOM.

### 5.3 Allowed dependency categories

After review, Robin may use:

- Ajv behind the repository's strict schema-validation boundary;
- UUID generation behind branded identifier constructors;
- official provider SDKs inside provider-specific adapters, with exact request
  capture and synthetic transport tests;
- narrow OS credential-store bindings or platform commands behind a broker;
- Unicode width/grapheme data or a focused terminal primitive when the standard
  library is insufficient;
- audited archive, checksum, signing, SBOM, and standalone-build tooling used
  only in release jobs;
- a focused PTY binding if system PTY harnesses cannot meet the supported matrix
  and its native build/supply-chain review passes;
- Git and optional ripgrep as external executables through argument-vector
  adapters with version/capability checks;
- bubblewrap, Seatbelt facilities, Docker, or Podman as external optional
  sandbox backends rather than application dependencies.

### 5.4 Core implementation exclusions

Robin implements its coding-agent application services, direct-model loop,
terminal state reducer, normalized event stream, local session journal,
provider normalization, prompt/context compiler, repository/edit/process/Git
tool semantics, permissions, checkpoint ledger, extension lifecycle, and eval
runner in this repository.

Do not substitute:

- an agent-loop or agent-framework package;
- a general workflow/orchestration engine;
- an authorization/policy framework for Robin's permission model;
- an ORM or server database for the local file-backed session store;
- a general job queue or resident service for ordinary CLI use;
- a second terminal coding agent hidden behind Robin;
- a library that executes model-produced shell text without Robin normalization,
  permission, and process supervision;
- a second editor-specific agent or permission implementation.

An exception requires an ADR showing why the dependency does not replace the
portfolio's differentiating implementation and how it is contained and tested.

### 5.5 Update workflow

1. Create a dedicated dependency-update branch.
2. Record the old and proposed exact versions.
3. Review upstream release notes, integrity source, license, scripts, native
   artifacts, and transitive delta.
4. Update through npm with exact-save behavior.
5. Inspect `package.json` and `package-lock.json` as text and through a lockfile
   policy script.
6. Run `npm ci --ignore-scripts` in a new temporary clone.
7. Run static, unit, contract, integration, package, and affected platform tests.
8. Regenerate only semantically affected goldens and review every changed field.
9. Build the package tarball and scan its file inventory.
10. Record rollback to the prior lockfile and any persisted-format impact.

Patch updates may share a pull request only when boundaries and failure modes
are related. Major provider SDK, TypeScript, terminal, schema, credential, or
packaging updates require a dedicated compatibility record.

### 5.6 Supply-chain release controls

- Generate CycloneDX or SPDX SBOMs for npm and standalone artifacts.
- Produce checksums after final signing/notarization and before upload.
- Generate build provenance from an isolated release job with the Git commit,
  lockfile hash, runner image, Node version, and build command.
- Pin third-party workflow actions by commit, not mutable tag.
- Do not expose npm publishing tokens to tests or build scripts.
- Use registry provenance and short-lived trusted publishing when available.
- Compare the packed file list against an allowlist; source fixtures, local
  sessions, credentials, `.env` files, diagnostic bundles, test secrets, and
  developer paths block publishing.
- Verify the downloaded/published artifact in a clean job rather than trusting
  the pre-upload workspace.

## 6. Local Data, Configuration, Cache, and Credential Locations

### 6.1 Platform path resolution

Robin resolves distinct configuration, durable-data, operational-state/log,
cache, and runtime-lock purposes. It does not place mutable global state in the
installation directory or analyzed repository.

| Platform | Configuration root | Data root | State/log root | Cache root | Runtime locks |
| --- | --- | --- | --- | --- | --- |
| macOS | `~/Library/Application Support/Robin/config` | `~/Library/Application Support/Robin/data` | `~/Library/Application Support/Robin/state` and `~/Library/Logs/Robin` | `~/Library/Caches/Robin` | Durable data, with each session's durable `writer.lock` in its session directory. |
| Linux and WSL | `${XDG_CONFIG_HOME:-~/.config}/robin` | `${XDG_DATA_HOME:-~/.local/share}/robin` | `${XDG_STATE_HOME:-~/.local/state}/robin` | `${XDG_CACHE_HOME:-~/.cache}/robin` | `${XDG_RUNTIME_DIR}/robin` when available, with durable identity mirrored in data and each session's `writer.lock` retained in its session directory. |
| Native Windows after support | `%APPDATA%\Robin\config` | `%LOCALAPPDATA%\Robin\data` | `%LOCALAPPDATA%\Robin\state` | `%LOCALAPPDATA%\Robin\cache` | User-private runtime directory selected by the future Windows platform adapter, with durable identity mirrored in data. |

Tests and portable development may set the separate `ROBIN_CONFIG_HOME`,
`ROBIN_DATA_HOME`, `ROBIN_STATE_HOME`, and `ROBIN_CACHE_HOME` overrides. Each
override must be an absolute path, is resolved without shell expansion, and is
reported by name in diagnostics. Production rejects a relative path, NUL byte,
non-directory component, symbolic-link escape under a managed root, or a root
that aliases another security-sensitive root unexpectedly.

No single `ROBIN_HOME` override combines secrets, sessions, logs, and cache.
Robin never automatically loads a repository `.env` file.

### 6.2 Owner and permission requirements

On POSIX platforms:

- roots are created with mode `0700` subject to verification after creation;
- configuration, session, log, lock, and metadata files use mode `0600`;
- executable helper files are not written into data roots;
- group/world-writable existing roots fail sensitive operations;
- ownership mismatch fails before credential or session access;
- a process umask is set narrowly for Robin-created state and restored only by
  process exit, not exported to child commands.

On supported Windows, equivalent user-only ACLs replace mode checks. ACL tests
must prove another ordinary local account cannot read session or credential
metadata before Windows enters the support matrix.

Permission repair is a separate `robin doctor fix-permissions` action. It prints
the exact files and intended permission delta, refuses symbolic links and
unowned paths, and never recursively changes a broad home or project directory.

### 6.3 Global directory layout

The target layout is:

```text
config-root/
  settings.json
  providers.json
  models.json
  credentials.json
  permissions.guard
  extensions.json

data-root/
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

state-root/
  indexes/
  update-state.json
  locks/
  diagnostics/
  crash-reports/

logs-root/
  robin.log
  robin.log.1

cache-root/
  provider-metadata/
  model-metadata/
  update-metadata/
  extension-downloads/
  repository-indexes/
```

`<session-id>` is a validated Robin session identifier resolved as one path
component. It is not taken directly from user input. Session names live in
metadata and never become directory names.

Configuration is user-edited and atomically updated. Data is authoritative and
backed up before destructive migration. State indexes are rebuildable. Cache is
disposable. Logs are bounded. Credentials contain references and redacted
fingerprints only; secret bytes live in the OS credential backend or an explicit
one-time source during import.

### 6.4 Project-local files

After workspace trust, Robin may read:

```text
<repository>/.robin/settings.json
<repository>/.robin/settings.local.json
<repository>/ROBIN.md
<repository>/AGENTS.md
```

- `.robin/settings.json` may be committed and cannot contain secrets.
- `.robin/settings.local.json` is user-local, recommended for `.gitignore`, and
  still cannot contain raw provider credentials.
- `ROBIN.md` and compatible `AGENTS.md` are instruction sources, not executable
  configuration or permission grants.
- Robin does not create or edit these files without showing exact targets and
  obtaining permission.
- A project cannot change the global data root, credential backend, update
  channel, bypass availability, managed policy floor, or trust status.

### 6.5 Credential locations and backends

Credential metadata in `credentials.json` contains:

- credential ID and display name;
- provider adapter and authentication strategy;
- exact allowed endpoint origins;
- backend type and opaque backend reference;
- redacted fingerprint;
- creation, last validation, rotation, and status timestamps;
- profiles that reference it.

Secret bytes use:

- an exact named environment variable or one-time hidden session input at R4;
- macOS Keychain for Tier 1 macOS beginning at R7;
- Secret Service through a reviewed adapter for Tier 1 Linux desktops beginning
  at R7 where available;
- a deliberate hidden-input-to-owner-only encrypted backend only after its key
  source, file format, locking, recovery, and threat model pass a separate gate;
- provider-native login only for an implemented and reviewed flow;
- no backend for explicitly no-credential local endpoints after that profile
  class becomes supported at R7.

Robin never stores a raw key in `credentials.json`. `robin auth add` reads
hidden terminal input, a deliberately selected stdin stream, or one exact named
environment variable. It never accepts a key as a positional or flag value.
Environment import does not load `.env`, records only the variable name, and
clears application references after broker storage. Child processes, hooks,
skills, MCP servers, subagents, diagnostic commands, and editor clients receive
no provider credential by default.

### 6.6 Configuration backups and sensitive copies

- Atomic config writes retain at most one verified prior revision until the new
  revision is parsed successfully.
- Backups contain credential references, never secret values.
- A support bundle excludes configuration values by default and includes a
  schema-key inventory plus redacted effective values only after preview.
- Editor backups, shell history, clipboard automation, and repository files are
  not credential backends.
- Test credentials are unmistakable synthetic canaries and use isolated test
  backend namespaces that cleanup verifies.

## 7. Configuration, Workspace Trust, and Startup Validation

### 7.1 Precedence

Configuration resolves from lowest to highest precedence:

1. compiled safe defaults;
2. managed policy floor;
3. user configuration;
4. trusted project configuration;
5. trusted local-project configuration;
6. allowlisted non-secret environment overrides;
7. explicit settings file;
8. CLI flags.

Higher precedence can select a stricter value. It cannot weaken a managed floor
or turn repository content into a credential, trust, update, or bypass source.
Every effective value records its winning source and safely summarized
overridden sources for `robin config explain`.

This is the complete R8 configuration contract. R1 uses compiled preview
defaults and explicit preview flags only; R3 persists the exact active snapshot;
R4 adds the minimum user-level provider/model/credential references required for
the first hosted adapter. Project/local-project scopes, managed floors, general
configuration writes, trust activation, instruction imports, and
`robin config explain` do not become supported until R8.

### 7.2 Startup validation order

Robin performs these steps before the first provider request or workspace
mutation:

1. Parse argv without filesystem, environment, provider, or repository effects.
2. Handle cold `--help`, `--version`, and completion paths if selected.
3. Resolve platform roots and validate ownership/permissions.
4. Load compiled defaults and managed policy.
5. Parse user configuration with byte, depth, item, and schema bounds.
6. Resolve physical working directory and repository identity.
7. Determine whether the workspace and project configuration revision are
   already trusted.
8. If not trusted, show exact project files and material capabilities before
   reading their content into effective configuration.
9. Parse trusted project/local configuration and instruction imports without
   executing code.
10. Merge configuration and validate unknown fields, types, ranges, and floors.
11. Resolve tool registry, permission snapshot, sandbox requirements, retention,
    and budgets.
12. Resolve provider/model profile and declared capabilities without sending
    repository content.
13. Resolve credential metadata and exact endpoint binding without exposing the
    secret.
14. Open or create the session store and acquire a single-writer lease.
15. Persist the workspace and configuration snapshot before accepting a turn.

Failure at any step releases locks and terminal state and identifies whether no
external effect occurred. A provider authentication validation that performs
network I/O is a separate explicit action and never part of passive startup.

### 7.3 Workspace trust record

A trust decision binds:

- physical repository/workspace identity;
- Git common directory and worktree identity where available;
- project configuration and instruction content hashes;
- extension and MCP definitions visible at decision time;
- requested capabilities and material risk summary;
- decision source, timestamp, and optional expiration.

A material configuration, instruction import, hook, skill, MCP, subagent,
sandbox, or permission change invalidates the applicable part of trust. Branch
switch alone does not silently trust changed project configuration. Trust can be
revoked without deleting sessions. An untrusted workspace permits help,
read-only diagnostics, trust preview, and session listing; it does not activate
project instructions, execute commands, load extensions, or contact a provider
with project content.

### 7.4 Strict schema behavior

- Every config has a schema version and maximum bytes, depth, items, strings,
  import depth, and import count.
- Unknown security-relevant fields fail. Explicit extension namespaces may
  retain unknown fields only when their version contract says so.
- Duplicate JSON keys are rejected before object construction.
- Accessor, proxy, prototype-polluting, non-plain, and executable formats are
  not accepted.
- Import paths resolve relative to the importing file, remain within their
  allowed root, detect cycles, and retain source provenance.
- A newer unsupported schema opens read-only diagnostics and migration preview;
  Robin does not rewrite it.
- Secret-shaped values in non-secret config fail with a safe migration path.

## 8. Local File-Backed Session Store

### 8.1 Store objective

The local store makes interactive and headless sessions resumable without a
database or daemon. It supplies:

- single-writer ordered session events;
- atomic session manifest and snapshot replacement;
- content-addressed storage for bounded large content;
- owner-only permissions;
- tail repair for a demonstrably torn final frame;
- quarantine for mid-log corruption or unknown required schema;
- rebuildable global indexes;
- restartable migrations and exact backups;
- dry-run inventory and ownership-safe deletion.

It does not supply distributed transactions, multi-host leases, remote
coordination, or a false exactly-once guarantee for external effects.

### 8.2 Session layout and ownership

Each session directory contains exactly these authoritative classes:

- `manifest.json`: schema, session ID/name, workspace identity, status, event
  tip, latest valid snapshot, created/updated times, Robin version, and
  retention class;
- `events.rlog`: append-only canonical event file with one file header followed
  by committed binary frames;
- `snapshots/<sequence>-<projection-hash>.snapshot`: immutable reducer snapshots
  written through temporary file, flush, rename, verification, and
  parent-directory flush where supported;
- `cas/sha256/<first-two-hex>/<remaining-hex>.blob`: immutable session-local
  content-addressed objects for transcript, process, diff, attachment, and
  provider content;
- `writer.lock`: current single-writer lease, acquired by exclusive creation;
- `journals/edits`, `journals/git`, and `journals/extensions`: operation-specific
  recovery records whose transitions are referenced by durable events;
- `recovery/` and `trash/`: exact session-owned recovery evidence and
  recoverable deletion state;
- temporary files with a fixed `.robin-tmp-<nonce>` naming pattern that recovery
  classifies before removal.

CAS authority is scoped to the owning session; cross-session deduplication is
not part of format version 1. A canonical event or snapshot carries the object
hash, media/type metadata, byte length, retention class, and purpose needed to
interpret each CAS reference. The session ID in the directory, manifest, file
header, frame envelope, snapshot, lock, and index must match. Any mismatch
quarantines the session. Robin validates that every path component and opened
file belongs to the expected directory and is not a symbolic-link substitution.

### 8.3 Event file and frame format

`events.rlog` begins with this fixed, checksummed version-1 file header. Every
integer is little-endian:

| Header field | Encoding | Rule |
| --- | --- | --- |
| File magic | 8 bytes | ASCII `RBNELOG1`. |
| Format version | unsigned 16-bit | Selects the supported decoder; version 1 is the initial value. |
| Header length | unsigned 16-bit | Bounds the complete header and permits registered additive fields. |
| Flags | unsigned 32-bit | Declares registered compression/encryption modes; unknown required flags fail closed. |
| Session identity | 16 UUID bytes | Matches the validated session directory and manifest identity. |
| Created time | signed 64-bit Unix milliseconds | Diagnostic creation fact, never an authorization input. |
| Initial chain seed | 32 bytes | Domain-separated predecessor for the first committed frame. |
| Header hash | 32-byte SHA-256 | Covers the registered header bytes and detects header corruption. |

The header is written, flushed, and directory-synced before the empty session is
acknowledged. It is never repeated between frames. Every following frame uses
this exact layout, again with little-endian integers:

| Frame field | Encoding | Rule |
| --- | --- | --- |
| Frame magic | 8 bytes | ASCII `RBNFRM01`. |
| Header length | unsigned 32-bit little endian | Bounds and versions the fixed plus registered extension header. |
| Flags | unsigned 32-bit little endian | Declares per-frame encoding facts; unknown required flags fail closed. |
| Sequence | unsigned 64-bit | Starts at 1 and increments by exactly 1. |
| Payload length | unsigned 64-bit | Bounded before allocation; large content is stored in the session-local CAS. |
| Payload CRC32C | unsigned 32-bit | CRC32C of the exact payload bytes for fast corruption detection. |
| Reserved | unsigned 32-bit | Zero in version 1; nonzero fails closed. |
| Previous-frame SHA-256 | 32 bytes | Initial chain seed for sequence 1; otherwise the exact prior committed frame hash. |
| Payload SHA-256 | 32 bytes | SHA-256 of the exact canonical payload bytes. |
| Payload | declared bytes | Canonical UTF-8 JSON durable-event envelope. |
| Frame SHA-256 | 32 bytes | SHA-256 over the domain, complete header, and payload; used by the next frame and manifest tip. |
| Commit marker | 8 bytes | ASCII `RBNCMT01`; absence means the final frame is uncommitted. |

`frameHash` is SHA-256 over the domain string `robin-session-frame-v1`, the
complete fixed and registered extension header bytes, and the exact payload.
The parser reads exact lengths, bounds allocation before payload reads, validates
CRC32C before trusting payload structure, validates the payload and frame
SHA-256 values, checks canonical JSON and durable-event schema, and checks
session ID, sequence, and previous-frame chain. Only an incomplete region that
begins exactly where the next frame is expected after a fully valid history may
be treated as a torn tail. A CRC, hash, commit-marker, sequence, or schema failure
inside committed history is middle corruption and quarantines the session. A
scanner never searches forward for another magic value. Hashes and CRCs provide
integrity/corruption evidence, not authorization or origin authentication.

### 8.4 Append protocol

One process may append a session at a time:

1. Resolve and open the session directory without following a final symlink.
2. Acquire `writer.lock` through exclusive creation and flush the lock record.
3. Revalidate session identity and scan from the latest verified snapshot/tip.
4. Validate the expected sequence and previous frame hash.
5. Canonicalize and size-check the event before opening the append handle.
6. Write the complete frame through its frame SHA-256 with an explicit
   short-write loop, then write `RBNCMT01` as the final commit marker.
7. Flush committed event bytes, including the marker, to the documented platform
   durability level before advancing the in-memory chain head.
8. Atomically replace and flush `manifest.json` with the new tip.
9. Acknowledge persistence to the application service.
10. Update rebuildable indexes after authority is durable.

If event flush succeeds but manifest replacement does not, recovery derives the
tip from the valid log and repairs the manifest. If the event write is torn,
recovery may truncate only the invalid final frame after proving every earlier
frame and recording a repair fact. It never skips a corrupt middle frame.

### 8.5 Writer lease

The version-1 lock record includes schema version, session ID, installation ID,
hostname digest, process ID, process-start identity, random lease nonce, Robin
build, acquisition time, and heartbeat time. It is flushed before ownership is
assumed. Heartbeat renewal uses atomic replacement while retaining the nonce and
process identity. Process ID or heartbeat age alone is not proof that a stale
lock can be deleted because identifiers are reused and filesystems may delay
visibility.

On open:

- a live matching writer blocks a second writer and offers read-only inspection;
- a demonstrably dead writer on the same host enters recovery after exact lock
  identity and log inspection; the prior lock is moved into session recovery
  evidence before takeover;
- ambiguous liveness, remote filesystem semantics, or mismatched identity
  refuses writes and directs the user to
  `robin sessions recover --force-lock <session-id>`, which first displays and
  preserves the exact recovery evidence;
- `--force` never bypasses integrity checks or overwrites a live lock;
- lock cleanup verifies nonce and session before unlinking.

### 8.6 Content-addressed objects

Large assistant content, provider items, process output, patches, attachments,
and exports are written to the owning session's SHA-256 CAS:

1. Stream plaintext into an owner-only same-filesystem spool while hashing and
   enforcing source, retained, and absolute drain limits.
2. Derive the logical `sha256:<lowercase-hex>` key and plaintext byte count from
   the complete input.
3. Build a private object temporary containing a versioned header with media-type
   category, plaintext length, storage encoding, and checksum followed by the
   deterministically encoded payload; compression never changes the logical key.
4. Flush and close the object temporary, then derive its final session-local path
   from the complete digest.
5. If an object already exists, stream-verify its decoded length and plaintext
   hash, discard the temporary, and return the existing typed reference.
6. Otherwise install the temporary without overwriting an existing object using
   the strongest atomic no-replace primitive available, and flush containing
   directories where supported.
7. Reopen the published object and verify decoded length and plaintext hash.
8. Append the canonical durable event that references the object only after
   verification; the event includes hash, bytes, media/type, purpose, and
   retention metadata.
9. Update rebuildable discovery indexes only after session authority is durable;
   an index never owns or reference-counts the object.

Garbage collection derives live references by replaying validated events and
snapshots within that session. It never trusts a stale count alone. Objects
younger than the configured safety window or referenced by a session backup or
migration are retained. Hash mismatch quarantines the object and makes the
owning session read-only until repair or deletion. Cross-session deduplication
is deliberately absent from version 1, which makes exact session deletion and
backup ownership auditable.

### 8.7 Snapshots and indexes

- Snapshots are acceleration only; replayed events remain authoritative.
- A snapshot records schema and reducer versions, session ID, covered sequence
  and frame hash, canonical serialized projection, projection hash, referenced
  CAS manifest, Robin build, and migration provenance.
- Opening validates the snapshot against the event frame at its covered tip and
  replays later events.
- Snapshot mismatch discards the snapshot and replays from an earlier verified
  point; event mismatch quarantines the session.
- Session-name, workspace, recent-session, and object-reference indexes are
  rebuildable and carry their source tip/hash.
- An index is never used to authorize deletion, resume, workspace binding, or a
  consequential retry without validating the underlying session.

### 8.8 Crash classification and recovery

Recovery classifies incomplete state as:

- **not started:** no durable prepared/start fact and no observed effect;
- **known failed:** durable terminal failure and no unresolved side effect;
- **known completed:** durable terminal receipt and matching external state;
- **uncertain:** an effect may have occurred without sufficient terminal proof;
- **corrupt:** local integrity cannot establish the ordered history;
- **unsupported version:** valid data requires a schema newer than this binary.

Read-only idempotent operations may retry within budget. File, process, Git,
network, provider, credential, extension, and update effects each require their
own reconciliation oracle. Recovery never calls a provider merely to recreate
lost text and never labels an optimistic assistant message as task success.

### 8.9 Migration protocol

Each store/config schema migration has:

- numeric ID, source range, target version, implementation hash, and owning
  Robin release;
- read-only preflight and exact affected session/object inventory;
- free-space requirement and backup plan;
- per-session idempotent cursor;
- old-version fixtures, interrupted-step fixtures, and corrupt-input cases;
- verification hashes/counts before switching the manifest version;
- rollback boundary and minimum binary that can read the result.

Migration uses copy/verify/switch for destructive representation changes. It
never rewrites the only copy of an event log in place. An interruption resumes
from the durable migration cursor. Old backups are removed only after the
documented rollback window and explicit validation.

### 8.10 Session store pass criteria

The store is not accepted until tests prove:

- gap-free append and side-effect-free replay;
- two writers cannot both append the same sequence;
- a torn final frame is repaired without losing a prior valid frame;
- middle-frame, chain, payload, object, snapshot, and manifest corruption fail
  closed;
- a killed process leaves a recoverable or explicitly uncertain session;
- migrations resume after every injected interruption;
- deletion cannot escape the exact validated session directory;
- indexes can be removed and rebuilt without behavior change;
- all authoritative files and objects meet permission/ACL requirements;
- no provider, daemon, database, or network is needed for local resume.

## 9. Test Policy and Harness Rules

### 9.1 Evidence purpose

Tests prove named claims at the boundary that enforces them. Coverage percentage
alone does not prove permission, isolation, redaction, workspace preservation,
session recovery, provider normalization, or terminal restoration.

Every security, privacy, compatibility, recovery, and user-flow claim maps to:

- a requirement ID;
- an owning package or application boundary;
- one deterministic enforcement-boundary test;
- applicable integration and platform tests;
- a user-visible failure category;
- a release gate and evidence artifact.

### 9.2 Taxonomy

| Class | Purpose | External dependency | Frequency |
| --- | --- | --- | --- |
| Static/architecture | Types, imports, public naming, schema registries, forbidden dependencies, package inventory | None | Every PR |
| Unit | Pure reducers, parsers, normalization, state transitions, calculations | None | Every PR |
| Golden | Help, terminal models, JSON/JSONL, schemas, events, diagnostics, migration fixtures | None | Every PR; updates require semantic review |
| Property/generative | Paths, patches, event sequences, Unicode input, config, provider chunks | Seeded generators | Every PR with bounded seed corpus |
| Contract | Provider, tool, credential, terminal, storage, sandbox, extension, protocol ports | Synthetic adapters | Every PR for affected boundary |
| Integration | Real temporary filesystem, Git, child processes, PTY, local sockets, OS credential test namespace | Host primitives only | Relevant PR, main, release matrix |
| Fault injection | Crashes, short writes, disk full, signal races, partial streams, external drift | Injectable adapters and child processes | Relevant PR and main |
| Adversarial | Traversal, injection, redaction canaries, stale approvals, hostile extensions, malformed frames | Synthetic hostile fixtures | Every PR for deterministic subset; full set on main |
| Mutation | Kill critical enforcement-branch mutants | Mutator on pure/boundary packages | Main, security PRs, release |
| End to end | Packaged CLI through user-visible outcome and cleanup | Synthetic provider and temporary repo | Main and release |
| Live provider | Real credential, endpoint, usage, tool loop, redaction smoke | Protected secret-bearing environment | Manual/scheduled and release approval only |
| Performance | Latency, memory, disk, throughput, cancellation, render responsiveness | Controlled dedicated runner | Nightly and release |
| Manual accessibility/UX | Keyboard, screen-reader/flat mode, approval comprehension, install/update/uninstall | Packaged candidate | Release candidate |

### 9.3 Determinism controls

Ordinary tests inject or pin:

- wall and monotonic clocks;
- ID generator and random seed;
- terminal dimensions, capabilities, locale, and input bytes;
- filesystem adapter/fault schedule where needed;
- Git fixture commit and configuration;
- provider request/response scripts, attempt IDs, retry hints, and usage;
- pricing catalog and effective date;
- process executable, output chunks, timing, signals, and exit status;
- sandbox capability report;
- credential backend and synthetic secret canaries;
- configuration source order and trust decisions;
- session schema/migration origin;
- network endpoints restricted to a unique loopback synthetic server.

Production uses real monotonic time, UTC timestamps, UUIDv7 identifiers,
cryptographic nonces, OS/filesystem primitives, and selected provider transport.
Tests never weaken production validation to obtain deterministic output.

No real provider call occurs in ordinary tests.

### 9.4 Test isolation and cleanup

Each test receives unique temporary roots for repository, config, data, state,
cache, logs, credential namespace, sockets, session IDs, process groups, and
provider server ports. Tests do not share mutable singleton state.

Cleanup:

1. cancels and reaps every child/process group;
2. closes provider servers, file handles, watchers, and sockets;
3. releases exact writer locks;
4. removes only the verified temporary root created for the test;
5. deletes synthetic credential records and verifies absence;
6. reports residual processes/files as test failures;
7. retains a redacted failing fixture only when the test explicitly opts in.

Cleanup runs from `finally`, but cleanup success cannot turn a failed assertion
green. A suite-level leak detector checks active handles, child PIDs, open ports,
temporary roots, and credential fixtures at process exit.

### 9.5 Test file and fixture conventions

- Unit tests live next to source as `*.test.ts`.
- Cross-adapter contract suites export one reusable function and are instantiated
  by every implementation.
- OS integration tests live under package-specific `test/integration/` folders.
- Packaged CLI/PTy/e2e tests live under `tests/e2e/`.
- Hostile inputs live under `testdata/adversarial/` with provenance and expected
  classification.
- Persisted compatibility fixtures live under `testdata/compatibility/<schema>/`.
- Golden updates run through a review command that prints the semantic diff.
- Every regression title includes its issue, incident, or requirement ID.
- No fixture contains a real provider key, user repository source, personal
  path, production hostname, or copied private transcript.

### 9.6 Timeouts and retries

- Every async test has a bounded test timeout and shorter operation timeout.
- A test retry is allowed only for identified external runner infrastructure; a
  deterministic code test is not retried to conceal a race.
- Failing property tests print the seed and minimized input.
- Timing assertions use monotonic elapsed time and dedicated-runner tolerances.
- Signal/cancellation tests synchronize on explicit readiness records rather
  than fixed sleeps.
- A quarantined flaky test blocks the affected release claim, has an owner and
  issue, and is excluded only with an accepted time-bounded waiver.

### 9.7 Assertions and failure artifacts

Tests assert trusted state, not only rendered prose. Depending on the boundary,
they inspect exact normalized action, handler call count, event frames, session
tip, filesystem hashes, Git status, process descendants, provider request bytes,
credential backend contents, redacted logs, exit code, and terminal restore
bytes.

Failure artifacts are allowlisted. They contain fixture IDs, hashes, counts,
seeds, state-machine states, and redacted diagnostics. Repository content,
session text, command output, provider payloads, credentials, absolute user
paths, and environment values are excluded unless the fixture is checked-in
synthetic content and the job's artifact policy names it.

## 10. Shared Test Harnesses and Oracles

### 10.1 Terminal byte harness

The terminal harness owns the public terminal contract in
`packages/robin-terminal`. It feeds decoded key events, raw byte sequences,
resize events, timers, and application events into the pure UI reducer. It
records state revisions, emitted effects, render models, ANSI bytes, cursor
position, raw-mode transitions, and cleanup bytes. A reference virtual screen
interprets the supported ANSI subset and rejects writes outside its dimensions.

### 10.2 PTY harness

The PTY harness launches the built or packed `robin` executable under a real
pseudo-terminal, waits on explicit prompt markers, sends bytes/signals/resizes,
captures the complete transcript, then verifies terminal flags with a sibling
probe. Linux and macOS adapters have the same semantic test corpus. If a focused
native PTY dependency is adopted, it must pass the dependency policy and expose
no shell-string execution path.

### 10.3 Synthetic provider server

A loopback-only server implements scripted provider dialects. It:

- binds an OS-assigned loopback port and rejects non-loopback peers;
- optionally serves a test TLS certificate through a test-only trust adapter;
- captures exact method, path, headers after redaction checks, and body bytes;
- emits configured JSON, SSE, or framed chunks with explicit boundaries;
- can delay headers/chunks, close before or after bytes, redirect, reset, send
  malformed UTF-8/JSON/SSE, duplicate IDs, reorder events, and report usage;
- records connection count, received-byte count, abort, and response completion;
- never receives or logs a real credential.

Adapter tests compare normalized events and exact safe request fingerprints
against reviewed fixtures.

### 10.4 Repository and Git fixture factory

The factory creates temporary repositories with explicit content, commit graph,
worktree/common-dir layout, config, attributes, ignores, modes, symlinks,
submodules, staged/unstaged/untracked state, hooks, filters, conflicts, detached
HEAD, or unborn branch. It snapshots every file identity/hash and Git porcelain
state before the test and verifies preservation or the exact expected delta
afterward.

### 10.5 Filesystem fault adapter

The adapter injects a named fault after an exact operation count: open, stat,
read, write, short write, flush, close, rename, directory flush, chmod, link,
unlink, directory enumeration, or free-space check. Integration tests combine it
with real files to prove rollback/residual-state behavior rather than mocking
the full tool.

### 10.6 Process fixture executable

A checked-in test helper provides deterministic modes for stdout/stderr chunks,
binary bytes, output flood, delayed exit, signal handling, ignored graceful
signal, descendant/grandchild creation, detached-child attempt, stdin echo,
working-directory/environment report, PTY detection, partial line, and exit by
code or signal. Tests launch the helper by argument vector and verify exact
process-tree cleanup.

### 10.7 Credential and redaction canary harness

Each run generates unique synthetic canaries in raw, URL-encoded, base64,
split-fragment, JSON-escaped, header, filename, environment, provider-error,
repository, tool-output, and Unicode-normalized forms. After the scenario, the
harness scans provider captures, events, session objects, snapshots, indexes,
logs, JSON/JSONL, human output, diagnostics, package artifacts, child
environments, hook/MCP frames, and uploaded test artifacts according to the
expected release policy.

### 10.8 Session crash harness

The crash harness runs Robin in a child process, waits for a durable fault marker,
terminates without normal cleanup, then opens the same test state with a fresh
process. Fault markers exist before and after every authoritative write and
external-effect boundary. The oracle compares event tip/hash, manifest, lock,
snapshot, objects, workspace/Git state, process descendants, provider attempts,
budgets, and user-visible recovery classification.

### 10.9 Network deny harness

Ordinary tests install a transport that permits only the exact synthetic
loopback server. Unexpected DNS, proxy, update, telemetry, Git-host, MCP, or
provider connections fail the test with destination metadata but no payload.
Sandbox tests use an independent external observation endpoint or namespace
probe to prove deny behavior rather than trusting Robin's report.

## 11. Detailed Verification Matrices

Each matrix row is a required named test family. “Pass” means the stated oracle
holds on every assigned platform and no leak detector reports residual state.
Gate assignments are the earliest gate that must pass the row; later gates keep
the row as regression coverage.

### 11.1 Core unit and contract matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| UNIT-001 | Parse empty argv, help/version, interactive prompt, print mode, resume/continue, administrative commands, duplicate flags, conflicting flags, end-of-options, oversized argument count, oversized bytes, sparse/accessor/proxy arrays. | Parsing is side-effect free; valid requests are immutable and exact; invalid input returns the stable usage category before filesystem/provider access. | R0 |
| UNIT-002 | Generate and parse every branded identifier with fixed clock/randomness, wrong prefix, wrong version, malformed length, mixed case, Unicode confusable, and cross-type substitution. | Valid IDs round-trip canonically; every invalid/cross-type value fails at the boundary; ordering is deterministic where specified. | R0 |
| UNIT-003 | Canonicalize nested domain values, object key order, numbers, strings, arrays, unknown properties, duplicate JSON keys, depth/item/byte limits, non-plain objects, accessors, and mutation after parse. | Accepted bytes are stable; invalid representations fail closed; captured normalized values cannot change after authorization. | R0 |
| UNIT-004 | Exercise every currently registered session, turn, provider, permission, tool, and terminal state transition plus duplicate, out-of-order, unknown-version, and post-terminal events; extend the same table when R6 registers checkpoint state. | Legal transitions produce the expected state/event/effect plan; illegal or not-yet-registered transitions return typed errors; replay invokes no external adapter. | R1 |
| UNIT-005 | Decode event frames with short headers, excessive lengths, sequence gaps, wrong session, previous-hash mismatch, frame-hash mismatch, invalid canonical JSON, unknown required flags, torn tail, and valid concatenation. | Parser bounds allocation and reads; only a demonstrably torn last frame is repairable; middle corruption and unsupported required versions quarantine. | R3 |
| UNIT-006 | Accumulate turns, invocations, attempts, tool calls, tokens, cost, context bytes, process time, wall time, output, artifacts, and resumed-session budget semantics at below/equal/above limits. | Limits are monotonic, overflow-safe, and locally enforced before the next operation; estimates and provider-reported usage remain distinguished. | R1 |
| UNIT-007 | Normalize POSIX and platform paths containing dot segments, separators, prefixes, leading dashes, NUL, Unicode forms, case aliases, device names, and root-prefix collisions. | Only valid workspace-relative canonical paths survive; string-prefix containment is never used as the sole oracle. | R2 |
| UNIT-008 | Parse R2 structural create/modify patches with zero-context hunks, CRLF, no final newline, overlapping hunks, mismatched headers, path disagreement, integer overflow, excessive output, binary markers, and malformed UTF-8. | Accepted create/modify patch IR is bounded and canonical; delete, rename, batch, full-file replacement, and every ambiguous or unsupported form fail before a write/permission receipt until their R6 operations register. | R2 |
| UNIT-009 | Normalize direct-process requests with executable, argv, cwd, stdin, environment delta, timeout, output limits, PTY request, sandbox request, and network request. | Direct execution never invokes a shell; secret environment keys, invalid cwd, unbounded values, shell syntax, background mode, and unsupported capability combinations fail. | R2 |
| UNIT-010 | Parse NUL-delimited Git status v2 and bounded diff metadata for clean, staged, unstaged, untracked, ignored, rename, copy, conflict, submodule, detached, and unborn fixtures. | Paths and states remain byte/encoding safe and structurally distinct; truncation is explicit; parser never treats human prose as authority. | R2 |
| UNIT-011 | Feed provider normalizers every legal text/tool/usage/notice/stop event plus duplicate completion, missing IDs, unknown event, malformed arguments, out-of-order result, conflicting usage, and partial UTF-8. | Normalized order and identifiers are stable; incomplete calls remain inert; unknown/malformed frames cannot dispatch a tool. | R1 |
| UNIT-012 | Merge defaults, managed, user, project, local-project, environment, explicit-file, and CLI values with conflicts, floors, unknown fields, unsupported schemas, and source mutations. | Winning value/source is deterministic; managed floors cannot weaken; secret-shaped non-secret values fail; snapshot hash changes for every request-affecting value. | R8 |
| UNIT-013 | Combine allow, ask, and deny across built-in mode, managed policy, user rules, project restrictions, operation defaults, and approval cache with missing/unknown attributes. | `deny > ask > allow`; repository sources never grant forbidden authority; trace is stable and secret-safe. | R5 |
| UNIT-014 | Allocate provider context across instructions, conversation, tools, attachments, repository content, output reserve, reasoning reserve, and compaction thresholds. | Total never exceeds declared model window; tool/output reserve is subtracted before input; omitted/truncated items carry reason and provenance. | R1 |
| UNIT-015 | Redact raw, encoded, split, normalized, nested, error-cause, header, URL, filename, and object-key canaries in human/JSON/JSONL/diagnostic/log views. | Forbidden bytes and reversible encodings are absent; safe structural metadata remains; redaction is idempotent. | R0 |
| UNIT-016 | Map usage, permission, approval, budget, task, provider, infrastructure, cancellation, recovery, migration, and structured-output failures to exit codes and safe diagnostics. | Each category has one stable code and next-action class; raw cause/stack appears only in explicit redacted debug output. | R0 |
| UNIT-017 | Validate tool definitions: identity/version, input/output schemas, normalization, permission attributes, side-effect class, concurrency declaration, redaction, renderer, and handler binding. | Missing or inconsistent fields block registration; duplicate identity/version fails; handler receives the exact captured normalized object. | R2 |
| UNIT-018 | Reduce application events into headless final text, final JSON, JSONL, and human terminal views under success, tool failure, failed verification, cancellation, and uncertain outcome. | Renderers never authorize effects; machine stdout is parseable and ANSI-free; assistant optimism cannot override recorded verification failure. | R1 |

### 11.2 Terminal reducer and renderer matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| TERM-001 | Feed printable ASCII, multibyte Unicode, combining marks, emoji grapheme clusters, zero-width joiners, wide characters, and invalid byte sequences into the editor decoder. | Cursor and deletion operate on grapheme boundaries; invalid bytes produce a safe diagnostic; no render row splits a grapheme. | R1 |
| TERM-002 | Exercise insertion, backspace, delete, home/end, word movement, multiline newline, submit, undo if shipped, history up/down, history search, and cancel. | Pure reducer state matches the editor specification and emits only permitted UI effects. | R1 |
| TERM-003 | Paste single-line, multiline, oversized, control-character, ANSI-bearing, and bracketed-paste input. | Paste is bounded, control bytes are displayed/removed per policy, ANSI is inert content, and oversized input is rejected without corrupting the composer. | R1 |
| TERM-004 | Resize from wide to narrow, narrow to wide, one-row, very tall, and zero/unknown dimensions during text, tool output, picker, and approval views. | Render model reflows deterministically; approval identity remains unchanged; no out-of-bounds cursor movement occurs. | R1 |
| TERM-005 | Render assistant deltas split at UTF-8, word, Markdown, and ANSI-looking boundaries while user input remains active. | Local input echo stays within latency budget; provider text cannot inject terminal control sequences; sealed text equals normalized accumulated bytes. | R1 |
| TERM-006 | Interleave stdout, stderr, assistant text, tool status, usage, backpressure, warning, and terminal-state events. | Channel/order metadata is preserved; throttling coalesces repaint only, not durable content or status transitions. | R1 |
| TERM-007 | Display short, multiline, long, Unicode, path-heavy, shell, network, Git, sandbox-degraded, and persistent-rule approval records. | Exact normalized scope, preconditions, risk, and choice labels are visible without relying on color; no key is active before the complete record is rendered. | R5 |
| TERM-008 | Deliver resize, provider delta, cancellation, stale approval, and session-close events while approval input is pending. | A response remains bound to the displayed decision ID/hash or is rejected as stale; unrelated events cannot change its meaning. | R5 |
| TERM-009 | Send first, second, and third interrupt events while idle-empty, idle-with-input, streaming model, awaiting approval, executing process, and cancelling. | Each state follows documented escalation; no interrupt approves; terminal restoration effect is emitted on final exit. | R1 |
| TERM-010 | Send end-of-input with empty and non-empty composer during ready, working, and approval modes. | Ctrl-D closes/submits only where specified and never answers approval or truncates a durable active turn silently. | R1 |
| TERM-011 | Switch to `TERM=dumb`, no-color, no-hyperlink, reduced-motion, screen-reader, and explicitly narrow-width modes. | Append-only renderer remains understandable; state is carried by text; no cursor control or animation is emitted. | R1 |
| TERM-012 | Render JSON and JSONL with every event family, unknown optional field, diagnostic, binary/artifact reference, and secret canary. | Each record is schema-versioned, ordered, one-line where required, ANSI-free, and redacted before serialization. | R7 |
| TERM-013 | Simulate renderer exception, stdout/stderr EPIPE, closed terminal, and application error during a repaint. | Controller stops rendering safely, restores terminal mode, preserves/seals durable session facts when possible, and returns classified failure. | R1 |
| TERM-014 | Traverse command menu, file/resource picker, session picker, model picker, and permission-mode selector entirely by keyboard. | Focus order and selected identity are deterministic; cancellation returns to the prior composer without unintended application effects. | R8 |
| TERM-015 | Replay a long session with transcript paging and a bounded in-memory row window. | Visible content matches durable query results; memory remains bounded; scrolling cannot trigger provider/tool work. | R3 |
| TERM-016 | Compare repeated renders of identical state and render after state revision rollback attempt. | Identical state/capabilities produce identical bytes; stale revision never overwrites a newer screen. | R1 |

### 11.3 Real PTY and terminal-lifecycle matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| PTY-001 | Launch packed `robin` with no arguments under a real PTY and synthetic config/provider. | Interactive prompt appears, session context is shown, no provider request occurs before user submit, and exit is zero after clean close. | R1 |
| PTY-002 | Launch with an initial positional prompt, then submit a follow-up turn. | Initial prompt is accepted once, both turns use one session, and transcript order is exact. | R1 |
| PTY-003 | Type multibyte/grapheme input one byte at a time and edit across line wraps. | Screen and submitted UTF-8 match intended text; cursor never lands inside a grapheme. | R1 |
| PTY-004 | Paste multiline text containing ANSI controls, shell-looking text, and a trailing newline. | Content is inert user input, bounded, visibly represented, and submitted only by the documented paste/submit rule. | R1 |
| PTY-005 | Resize during composer editing, assistant streaming, process output, and approval. | Prompt redraw is coherent, no text is lost/duplicated semantically, and selected approval identity remains stable. | R1 |
| PTY-006 | Send Ctrl-C during provider stream and wait for abort acknowledgement. | Provider abort fires, turn becomes interrupted/cancelled as specified, UI remains usable, and no orphan request/tool remains. | R1 |
| PTY-007 | Send first and second Ctrl-C during a descendant process fixture that ignores graceful termination. | UI acknowledges within budget; graceful then forceful process-group termination occurs; all descendants are reaped. | R2 |
| PTY-008 | Send Ctrl-D with empty composer, non-empty composer, and pending approval. | Only documented close/submit behavior occurs; approval is never granted; terminal exits cleanly where applicable. | R1 |
| PTY-009 | Terminate with SIGTERM while idle, streaming, writing session state, and running a process. | Terminal flags restore; process/session outcome is classified; next open recovers without fabricated completion. | R3 |
| PTY-010 | Inject application exceptions before raw mode, after raw mode, during render, and during cleanup. | Terminal canonical/echo flags equal their pre-launch values; emergency restoration emits no secret/session content. | R1 |
| PTY-011 | Run under `TERM=dumb`, redirected stdout, redirected stderr, and piped stdin with/without `--print`. | Invalid ambiguous mode fails early; valid headless mode emits no ANSI and preserves stdout/stderr contract. | R1 |
| PTY-012 | Close the reading end of stdout or stderr during streamed output. | EPIPE is classified, child/provider work is cancelled as specified, terminal/session cleanup completes, and no crash loop occurs. | R1 |
| PTY-013 | Suspend/resume where supported, resize while suspended, then continue input. | Terminal modes restore during suspension and re-enable on resume; dimensions are reprobed; session identity persists. | R3 |
| PTY-014 | Start from an npm-installed tarball in a temporary prefix with a path containing spaces and Unicode. | `robin` resolves assets/config correctly, completes the synthetic session, and uninstall removes the binary without removing data. | R1 |
| PTY-015 | Run in a Tier 1 terminal with no color, screen-reader flat mode, and narrow 40-column dimensions. | Full coding/approval/cancel flow is keyboard-complete and text state remains understandable. | R5 |
| PTY-016 | Run an eight-hour accelerated stream fixture with periodic turns/resizes and bounded transcript paging. | No terminal corruption, handle leak, unbounded row growth, or input latency regression beyond the defined budget. | R10 |

### 11.4 Provider synthetic-server and adapter matrix

R4's real-provider rows qualify the first hosted alpha only:
`packages/provider-openai` implements the OpenAI Responses API behind a reviewed,
pinned official OpenAI JavaScript SDK. SDK retries, implicit environment-key
discovery, debug logging, telemetry, and provider storage defaults are disabled
or explicitly wrapped so Robin owns attempts, normalization, budgets,
credentials, and tool dispatch. Additional hosted families, compatible dialects,
and registered local endpoints do not become release claims until R7.

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| PROV-001 | Send one normalized text request and stream text in one chunk and many boundary-split chunks. | Exact normalized sealed text, stop reason, request ID, and usage are identical across chunking. | R1 |
| PROV-002 | Stream one tool call with name and JSON arguments split at every byte boundary. | No handler call occurs before provider completion; one complete canonical tool request is emitted afterward. | R1 |
| PROV-003 | Emit two tool calls sequentially and concurrently despite a declared serialized mode. | Serialized legal calls retain order; prohibited parallel calls fail with provider-protocol category and execute nothing. | R1 |
| PROV-004 | Emit malformed JSON, duplicate keys, invalid UTF-8, excessive nesting/bytes, unknown tool, missing call ID, duplicate ID, and conflicting completion. | Every input is bounded and rejected; tool handler and permission grant spies remain uncalled. | R1 |
| PROV-005 | Exercise provider-native text, tool delta, complete tool, usage, notice, content filter, truncation, incomplete, cancellation, and unknown stop variants. | Each maps to a stable normalized event/outcome; unknown variants are safe diagnostics and cannot imply success. | R4 |
| PROV-006 | Return 400, 401, 403, 404, 408, 409, 429, 500, 502, 503, and malformed error bodies with provider request IDs. | Stable categories distinguish configuration, auth, capability, rate limit, transient, permanent, and malformed response; bodies/IDs are redacted. | R4 |
| PROV-007 | Disconnect before request bytes, during headers, after body bytes, before response, mid-stream, and after terminal response bytes. | Retry occurs only when transmission/result certainty permits; ambiguous attempts are visible and never silently duplicated. | R4 |
| PROV-008 | Supply valid, excessive, negative, inconsistent, missing, and delayed usage reports. | Valid provider usage is recorded; invalid/missing values become labeled estimates/unknown; budgets never underflow or overflow. | R4 |
| PROV-009 | Send Retry-After as seconds/date, excessive hint, invalid hint, and repeated rate limits under injected clock/randomness. | Backoff is bounded and deterministic in tests, honors safe hints, stops at attempt/wall/cost budget, and is cancellable. | R4 |
| PROV-010 | Cancel before connect, during upload, before first delta, mid-text, mid-tool arguments, and after complete response. | Abort reaches transport; incomplete tool is inert; terminal certainty and retained partial text follow the adapter contract. | R4 |
| PROV-011 | Redirect same-origin, cross-origin, HTTP downgrade, loop, and credential-bearing URL. | Credentialed transport rejects redirects unless a reviewed strategy explicitly permits an exact safe case; no auth reaches the redirect target. | R4 |
| PROV-012 | Capture exact request bytes for system instructions, conversation, tool schemas/results, model, endpoint, storage control, parallel control, reasoning settings, and metadata. | Request equals reviewed dialect fixture; every request-affecting field changes fingerprint; no repository bytes beyond released context appear. | R4 |
| PROV-013 | Reconstruct multi-turn continuation containing text, tool IDs/results, opaque provider items, and compacted history. | Required item order/identity remains lossless; opaque bytes are byte-identical and never rendered/logged. | R4 |
| PROV-014 | Select a model missing tool calls, required context, system role, structured output, image, usage, or cancellation support. | Capability validation fails before provider egress or applies only a documented permitted emulation recorded in the configuration snapshot. | R4 |
| PROV-015 | Configure generic OpenAI-compatible endpoints with named conformant, partially conformant, and lying capability profiles. | Only the tested named dialect is accepted; label/URL shape alone never grants support; mismatch fails at conformance/startup. | R7 |
| PROV-016 | Configure the R4 HTTPS hosted endpoint with correct origin, HTTP downgrade, userinfo URL, query credential, disallowed port, and cross-origin redirect. | Origin/scheme/auth policy is exact; insecure remote, userinfo, query credentials, and mismatched origin fail before source content is sent. | R4 |
| PROV-017 | Inject provider error text containing raw, encoded, split, header, request, repository, and credential canaries. | Normalized error, logs, session, terminal, JSON, diagnostics, and CI artifact scans contain none of the forbidden canaries. | R4 |
| PROV-018 | Run the same semantic tool scenario through every production adapter. | Normalized conversation/tool/result/usage semantics match the shared corpus; adapter-specific differences are confined to descriptors and safe notices. | R7 |
| PROV-019 | Simulate provider-side storage controllable, uncontrollable, disabled, and unknown. | Robin sets required disable controls where supported, labels the achieved retention claim, and blocks profiles requiring a stronger guarantee. | R4 |
| PROV-020 | Simulate server-side tools advertised by the provider or included unexpectedly in output. | Robin does not enable provider-executed repository/shell tools; unexpected server-side effects fail the compatibility tier and produce no local authority. | R7 |
| PROV-021 | Run a synthetic stream at maximum allowed chunk/event rate with a slow renderer. | Backpressure bounds memory, seals exact semantic content, preserves abort responsiveness, and does not block network drainage. | R4 |
| PROV-022 | Change model alias resolution between session creation and resume. | Pinned model/revision is retained or the user sees an explicit switch/fork decision; silent semantic change is impossible. | R4 |
| PROV-023 | Configure R7 generic-compatible and local endpoints as loopback no-credential, loopback credential, HTTPS hosted compatible, HTTP remote, userinfo/query credential, and disallowed port profiles. | Only registered R7 adapter/profile classes may omit credentials; origin/scheme/auth policy is exact; a hosted endpoint cannot inherit no-key behavior; insecure remote and URL-carried credentials fail before source content is sent. | R7 |

### 11.5 Repository and filesystem read-tool matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| FS-001 | Discover repository from root, nested directory, linked worktree, submodule, bare repository, non-repository, inaccessible parent, and `.git` file indirection. | Physical workspace, Git common-dir/worktree identity, HEAD, and capability are correct; unsupported forms fail without mutation. | R2 |
| FS-002 | Resolve paths with `..`, `.`, repeated separators, absolute roots, leading dash, NUL, drive/device form, root-prefix collision, and percent-encoded text. | Invalid/escaping paths fail before open; accepted paths are one canonical workspace-relative identity. | R2 |
| FS-003 | Read symlink within root, symlink outside root, symlink chain, loop, dangling link, directory link, and swap target between validation/open. | Operation-specific policy is enforced with descriptor/identity revalidation; no outside bytes are released. | R2 |
| FS-004 | Read hard-linked in-root file whose other link is outside the workspace and mutate through the outside link during read. | Identity/pre/post metadata detects drift where required; Robin never claims exclusive workspace containment for hard-linked content. | R2 |
| FS-005 | List empty, shallow, deep, very wide, hidden, ignored, generated, permission-denied, symlinked, and concurrently changing directory trees. | Stable bounded pages report skipped/truncated/error counts; traversal does not escape or allocate unbounded memory. | R2 |
| FS-006 | Resume listing with valid, stale, tampered, wrong-workspace, and wrong-option continuation tokens. | Cursor is bound to workspace/options/snapshot rules; invalid cursor fails; duplicates/omissions follow the documented consistency model. | R2 |
| FS-007 | Search literal strings containing regex metacharacters, Unicode, NUL attempt, long needle, empty needle, binary files, huge lines, many matches, ignored files, and timeout. | Literal search stays literal, honors file/match/byte/time bounds, reports skipped inputs, and returns stable order. | R2 |
| FS-008 | Compare built-in search and optional ripgrep adapter on the shared literal corpus. | Semantic results and bounds agree; missing/incompatible ripgrep falls back visibly without changing authorization. | R2 |
| FS-009 | Read line windows and byte windows from LF, CRLF, mixed newline, no-final-newline, empty, UTF-8 BOM, invalid UTF-8, binary, large, sparse, and concurrently truncated files. | Returned bytes/lines and truncation metadata are exact; unsupported encoding/binary is explicit; no partial read is misreported as complete. | R2 |
| FS-010 | Change file before open, after metadata capture, during read, after read before release, and after release. | Pre-release drift is detected according to the consistency contract; released manifest identifies exact hash/version; later drift invalidates cache. | R2 |
| FS-011 | Use case aliases and Unicode normalization aliases on case-insensitive/case-sensitive fixtures. | Canonical identity and collision rules are platform-correct; a model cannot address one alias while permission evaluated another. | R2 |
| FS-012 | Attempt reads of `.git`, credential/config roots, sockets, FIFOs, devices, directories, executable helpers, and explicit additional roots. | Non-regular/sensitive files are denied by default; granted additional roots are separately identified and bounded. | R2 |
| FS-013 | Combine Git ignore, Robin ignore, provider exclusion, secret exclusion, hidden policy, and explicit user override. | Each exclusion reason is distinct; secret/managed denial cannot be overridden by project/user convenience flags. | R2 |
| FS-014 | Seed repository file names/content with prompt injection, fake tool results, terminal controls, and fake system messages. | Content retains repository trust class, terminal controls are inert, and it cannot alter permission/configuration precedence. | R2 |
| FS-015 | Release safe and denied read results together in one requested result group. | Mixed unauthorized read release fails or releases only according to its explicit result atomicity contract; forbidden filenames/snippets/hashes never reach provider/render surfaces. This is not the R6 multi-file edit batch. | R2 |
| FS-016 | Run reads on paths with spaces, tabs, newlines, leading dashes, shell metacharacters, emoji, combining characters, and maximum component length. | Argument-vector/file APIs preserve exact identity; no shell parsing occurs; renderer safely escapes the path. | R2 |
| FS-017 | Measure access-time behavior on supported and unsupported filesystems. | Robin uses no-atime mechanism when reliably available and reports when no guarantee is possible; correctness never depends on atime. | R2 |
| FS-018 | Exhaust item, byte, time, open-file, and provider-release budgets independently. | The exact exhausted dimension is reported; already authorized results remain bounded; next operation does not start. | R2 |
| FS-019 | Delete/recreate a file with the same path/content between observation and later tool use. | File identity/precondition rules detect replacement where applicable; path/content equality alone is not silently treated as the original observation. | R2 |
| FS-020 | Remove permissions or repository root during a session and restore them later. | Read failure is classified, session remains inspectable, and revalidation is required before subsequent effects. | R2 |

### 11.6 Edit and checkpoint matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| EDIT-001 | Apply one valid hunk to a clean tracked text file with expected preimage hash. | Exact intended bytes are written atomically; before/after hash, diff, changed path, and permission receipt are durable. | R2 |
| EDIT-002 | Attempt stale preimage, shifted context, ambiguous repeated context, overlapping hunks, and path-header mismatch. | Patch fails before write; original file/hash/mode remain unchanged; model receives a bounded conflict result. | R2 |
| EDIT-003 | Create an empty file, text file, nested file, existing-path collision, case-alias collision, and parent-symlink target. | Only valid create reaches atomic publish; no overwrite/escape occurs; path/mode/final-newline metadata is exact. | R2 |
| EDIT-004 | Delete empty/nonempty tracked file, untracked pre-existing file, changed-since-read file, directory, symlink, and missing file through the distinct R6 delete operation. | Permission/action kind is delete; precondition mismatch refuses; directories are not recursively deleted; user-owned untracked content is preserved. | R6 |
| EDIT-005 | Rename within directory, across directories on same filesystem, case-only, Unicode-normalization alias, overwrite target, symlink, and cross-filesystem through the distinct R6 move operation. | Supported move is journaled and atomic where possible; collisions/cross-filesystem ambiguity fail without partial target; no implicit delete/create bypass. | R6 |
| EDIT-006 | Preserve LF/CRLF, UTF-8 BOM policy, final newline, executable bit, read-only mode, and empty-file state through modification. | Configured metadata is preserved or exact requested change is separately authorized and recorded. | R2 |
| EDIT-007 | Attempt the R6 full-file write below/equal/above byte limit and use it to replace stale content. | Distinct full-write operation is bounded, requires expected preimage, and cannot bypass patch conflict or permission class. | R6 |
| EDIT-008 | Inject short write, ENOSPC, quota, EACCES, flush failure, close failure, rename failure, directory-flush failure, and antivirus-style transient lock. | Original is preserved where the platform contract promises atomicity; residual temp/target state is classified exactly; no success event is appended. | R2 |
| EDIT-009 | Swap symlink/file identity after approval and immediately before open/rename. | Stale approval/precondition is invalidated; outside target is unchanged; handler reports no applied edit. | R2 |
| EDIT-010 | Apply an R6 multi-file batch and inject failure before each temporary write, after each flush, and before/after each publish. | Journal identifies committed and uncommitted paths; rollback restores only Robin-owned transitions with matching postimages or enters recovery-required; unrelated files remain unchanged. | R6 |
| EDIT-011 | Modify the same target externally before write and after write before durable edit-event append. | Robin detects drift, reconciles exact before/after hashes, and never overwrites an unknown external edit automatically. | R2 |
| EDIT-012 | Begin with staged, unstaged, and untracked user changes adjacent to and overlapping Robin targets. | Initial snapshot is retained; only proven Robin transitions are attributed; cumulative diff labels ambiguous overlap. | R2 |
| EDIT-013 | Create R6 checkpoints after one turn, multiple turns, no-op turn, failed edit, and external command mutation. | Checkpoint parent/order and owned path manifest are exact; no-op/failed operations do not fabricate changed paths. | R6 |
| EDIT-014 | Rewind an R6 checkpoint with unchanged postimages, one externally changed path, deleted path, and changed Git index. | Preview lists exact effects; clean match rewinds Robin edits; any ambiguous precondition refuses without partial rewind. | R6 |
| EDIT-015 | Crash after prepared R2 edit, temp write, temp flush, publish rename, durable edit event, and manifest update. | Fresh process classifies each state, records at most one accepted edit, removes/quarantines only owned temps, and never repeats blindly. | R3 |
| EDIT-016 | Feed binary patch, submodule entry, sparse path, LFS pointer, huge diff, unsupported encoding, and path outside checkout. | Unsupported edit types fail before approval/execution or route to an explicitly different tool; no text-patch claim is made. | R2 |
| EDIT-017 | Render diff containing ANSI, bidi controls, very long line, no-newline marker, secret canary, binary indication, and unusual path. | Display is safe/bounded, controls are visible/inert, secrets follow release policy, and displayed hash binds approval to exact full diff. | R2 |
| EDIT-018 | Have a provider emit two independent registered R2 create/modify tool calls together, and race one with a process/Git write. | The scheduler serializes independent consequential calls; the second revalidates against the first result; no overlapping writer runs. This is not the R6 atomic multi-file batch operation. | R2 |
| EDIT-019 | Run formatter/test command that changes generated and source files after a Robin edit. | Workspace rescan records observed command effects separately; caches/approvals invalidate; precise model-edit attribution is not claimed without proof. | R2 |
| EDIT-020 | Generate a cumulative session diff after external edits, checkpoint rewind, staging, and file move. | Result is reconciled from current Git/filesystem plus edit ledger, labels Robin-owned/observed/ambiguous changes, and never omits pre-existing state. | R6 |
| EDIT-021 | Crash before and after R6 batch prepare, each path publish, checkpoint creation, rewind inverse prepare, each inverse publish, and terminal receipt. | Recovery uses the durable journal and current postimages to finish, roll back only proven Robin transitions, or stop in recovery-required state; it never repeats a delete/move/rewind or overwrites external drift. | R6 |

### 11.7 Process tree, cancellation, PTY-child, and output-flood matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| PROC-001 | Launch a direct executable with spaces, metacharacters, empty args, Unicode, leading dashes, and explicit cwd. | Child receives exact argv/cwd; no shell interpolation occurs; execution receipt records resolved executable identity. | R2 |
| PROC-002 | Launch the R5 explicit shell tool with command text containing pipelines, redirection, substitution, quotes, and newlines. | Permission view shows exact shell and text; direct mode never accepts syntax as shell; selected shell comes from trusted user/managed config and the shell tool follows R5 permission/sandbox enforcement. | R5 |
| PROC-003 | Resolve executable from trusted PATH, workspace-shadowed PATH, absolute path, symlink, changed binary, missing binary, and non-executable file. | Policy/approval binds the resolved identity; stale or workspace-controlled substitution is rejected according to rule; failed spawn is distinct from child failure. | R2 |
| PROC-004 | Construct environment from allowlist with project variables, secret-shaped values, provider credentials, locale, terminal, temporary path, and user overrides. | Only reviewed keys/values reach child; provider secret and broker handles are absent; effective environment metadata is redacted. | R2 |
| PROC-005 | Stream alternating stdout/stderr chunks, partial UTF-8, binary bytes, partial lines, and terminal controls. | Byte/channel/order metadata is retained; binary/invalid text is classified; terminal controls are inert; provider release is separately bounded. | R2 |
| PROC-006 | Emit retained-limit, drain-limit, and absolute-limit floods while reader/renderer is slow. | Pipes continue draining after retention truncation; memory remains bounded; absolute limit terminates the tree; no deadlock occurs. | R2 |
| PROC-007 | Exit zero, nonzero, by signal, before exec, and after writing output. | Result distinguishes success, test/task failure, spawn infrastructure failure, signal, and cancellation; output is sealed once. | R2 |
| PROC-008 | Exceed timeout before spawn, during silent wait, during output, and while graceful termination is ignored. | Monotonic timeout starts at documented boundary; graceful then forceful tree termination completes within budget; no descendant remains. | R2 |
| PROC-009 | Cancel parent, child, grandchild, and grandchild that attempts new session/process group. | Supported platform adapter reaches/reaps descendants or reports exact escape limitation; release sandbox claim matches evidence. | R2 |
| PROC-010 | Race natural exit, timeout, user cancellation, output limit, and process error. | Exactly one terminal classification wins deterministically; secondary facts are retained; no duplicate completion/event/budget release. | R2 |
| PROC-011 | Close stdin by default, send bounded inline bytes, stream file-derived stdin, and attempt unlimited/interactively requested input. | Input mode is explicit and approved; byte/time limits hold; model cannot answer credential/confirmation prompts automatically. | R2 |
| PROC-012 | Launch PTY child that checks TTY, requests resize, prompts for input, enters full-screen mode, and emits ANSI. | Allowed PTY mode has separate approval/transcript/resize; unsupported full-screen or arbitrary prompt stops safely; parent terminal restores. | R5 |
| PROC-013 | Run command that creates/modifies/deletes/renames files, changes modes, stages Git, and spawns a file watcher. | Post-command rescan records observed effects, invalidates caches/approvals, and does not claim exact edit authorship without manifest proof. | R2 |
| PROC-014 | Run with cwd outside workspace, symlinked cwd, deleted cwd, and separately granted additional root. | Unauthorized/invalid cwd fails before spawn; granted root is explicit in permission/sandbox plan and revalidated. | R2 |
| PROC-015 | Run strict sandbox with backend success, unavailable backend, partial probe, profile compile failure, and runtime enforcement failure. | Strict failure never falls back; achieved backend/report is durable; handler does not spawn on preflight failure. | R5 |
| PROC-016 | Attempt network in deny, loopback-only, allowlisted-host, and unenforceable best-effort modes. | Independent probe verifies achieved policy; strict mismatch blocks/terminates; best-effort lack of enforcement is prominently recorded. | R5 |
| PROC-017 | Attempt reads/writes outside sandbox roots, session/config/credential roots, Git common dir, devices, and runtime sockets. | Independent host assertions prove protected targets unchanged/unreadable according to backend claim; Robin parent retains required access. | R5 |
| PROC-018 | Start background process, inspect status/logs, close session, resume, cancel, expire retention, and attempt cross-session handle use. | Handle is session-owned and unguessable; lifecycle is explicit; cross-session control fails; no orphan remains after terminal cleanup. | R9 |
| PROC-019 | Crash Robin while child runs and reopen the session. | Recovery discovers/terminates or classifies the exact owned process using identity evidence; PID reuse cannot target an unrelated process. | R3 |
| PROC-020 | Run many sequential and bounded-concurrent read-only processes up to concurrency/resource budgets. | Slots enforce configured maximum, cancellation frees once, ordering is deterministic where required, and memory/FD/PID limits remain within budget. | R9 |

### 11.8 Git behavior and preservation matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| GIT-001 | Snapshot clean, staged, unstaged, untracked, ignored, conflicted, detached, unborn, submodule-dirty, and linked-worktree states. | Parsed status preserves every state/path and initial HEAD/common-dir identity; no repository mutation occurs. | R2 |
| GIT-002 | Parse paths containing spaces, tabs, newlines, leading dashes, Unicode normalization, invalid bytes where representable, and rename arrows as literal names. | NUL-delimited parsing retains exact safe identity; human decorations are never parsed as path syntax. | R2 |
| GIT-003 | Inspect working, staged, commit-range, rename, binary, submodule, huge, external-diff-configured, and textconv-configured diffs. | External helpers/pager are disabled for inspection; bounds/truncation are explicit; no diff output executes terminal control. | R2 |
| GIT-004 | Configure aliases, pager, hooks path, smudge/clean filters, fsmonitor, external diff, signing, and credential helpers. | Read operations ignore unsafe helpers; write operations disclose intentional hook/signing behavior; no alias changes invoked command semantics. | R2 |
| GIT-005 | Stage exact one/multiple paths with neighboring dirty files, renames, deletions, intent-to-add, and pathspec metacharacters. | Only displayed exact path identities are staged; index/worktree state is rechecked after approval; unrelated changes remain untouched. | R6 |
| GIT-006 | Change file/index/HEAD between stage preview, approval, and effect. | Bound approval becomes stale; stage does not run or result is reconciled; no outdated diff is silently staged. | R6 |
| GIT-007 | Commit staged Robin-only changes, mixed user changes, empty index, hook-modified index, failing hook, signing success/failure, and concurrent HEAD movement. | Commit is created only from exact reviewed tree/preconditions; hook/signing outcome is explicit; mixed/changed state refuses or asks a precise new decision. | R6 |
| GIT-008 | Generate commit message containing quotes, newlines, Unicode, shell syntax, issue refs, and oversized text. | Message is passed through a file or exact argv-safe mechanism, bounded, and never interpreted by a shell. | R6 |
| GIT-009 | Create a branch from expected HEAD with valid/invalid/conflicting names, detached HEAD, and concurrent ref creation. | Git validates normalized name; expected base is bound; collision/drift fails without moving another ref. | R6 |
| GIT-010 | Attempt reset, clean, checkout overwrite, force push, rebase, filter-branch, and history-rewriting commands in normal mode and trusted high-risk mode. | Normal mode denies before Git; repository config cannot enable high-risk mode; explicit launch/approval remains visible and exact if the later mode is shipped. | R6 |
| GIT-011 | Inspect remotes with HTTPS, SSH, scp-like, local path, credential-in-URL, multiple URLs, and unusual names. | Safe normalized remote identity is displayed; embedded credentials are redacted/rejected; network action has exact remote/refspec. | R6 |
| GIT-012 | Fetch/push to a loopback synthetic Git remote with success, auth failure, rejected update, disconnect, hook rejection, and uncertain transport. | Permission and network boundary apply; result certainty is classified; no automatic retry of uncertain push. | R6 |
| GIT-013 | Prepare PR title/body without host adapter, then create through a synthetic host adapter with stale branch/commit and auth failure. | Local preparation always remains reviewable; remote creation requires exact commit/repo/base/head and approval; failure does not misreport PR creation. | R6 |
| GIT-014 | Create/delete isolated worktree with normal common dir, moved repository, existing destination, malicious ownership marker, nested repo, and cleanup interruption. | Only Robin-proven worktree/directory is removed; Git common-dir semantics are correct; original checkout and unrelated worktrees remain unchanged. | R9 |
| GIT-015 | Run session from submodule, sparse checkout, partial clone, LFS pointer, and repository with worktree config. | Capability is detected; unsupported write/verification behavior fails visibly; no false full-repository claim. | R2 |
| GIT-016 | Change branch/HEAD externally during session and resume from a different worktree. | Workspace reconciliation detects identity/drift, invalidates pending edits/approvals, and requires explicit fork/rebind where necessary. | R3 |
| GIT-017 | Use repository with ownership safety warning and safe.directory configuration absent/present. | Robin does not auto-modify global Git config; diagnostic explains exact user-owned remediation; no command bypasses Git safety. | R2 |
| GIT-018 | Verify original status/hashes before and after every synthetic/hostile e2e, failure, cancellation, and cleanup path. | Delta equals only explicitly expected Robin/user fixture changes; unexpected mutation is a test failure with exact path hash metadata. | R2 |
| GIT-019 | Attempt to stage/commit `.git` internals, Robin global state, credentials, session objects, diagnostics, and ignored local config through misleading paths/symlinks. | Sensitive/outside targets cannot enter exact pathspec; no secret/state artifact is committed. | R6 |
| GIT-020 | Run commit/push then crash before session terminal event. | Recovery verifies exact HEAD/ref/remote state, records known completed or uncertain outcome, and never duplicates commit/push blindly. | R6 |

### 11.9 Configuration and workspace-trust matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| CONF-001 | Load each configuration scope alone and every conflict across defaults, managed, user, project, local-project, environment, explicit file, and CLI. | Effective value and provenance follow exact precedence; managed floors and non-project-settable keys cannot be weakened. | R8 |
| CONF-002 | Parse empty, valid, unknown-key, duplicate-key, wrong-type, excessive depth/items/bytes, malformed UTF-8/JSON, prototype key, and unsupported schema files across the complete configuration surface. | Valid config is immutable/canonical; invalid config fails before provider/repository effect with safe location diagnostics. | R8 |
| CONF-003 | Write a user/project setting with unrelated known fields, comments unsupported, newer schema, concurrent edit, disk full, short write, and rename failure. | Atomic update preserves unrelated supported fields, never overwrites newer/concurrent data, and reports original/residual state. | R8 |
| CONF-004 | Set provider/model, permission, sandbox, tool, budget, rendering, retention, telemetry, update, extension, and data-root values from every eligible source. | Source allowlist is enforced per key; project/environment cannot set credential secret, managed floor, trust, global root, or bypass availability. | R8 |
| CONF-005 | Insert raw, encoded, JSON-escaped, split, and secret-shaped values in all non-secret configuration files. | Validation refuses storage and gives an auth-import path without echoing the value; no rejected bytes enter logs/diagnostics. | R8 |
| CONF-006 | Resolve instruction imports with relative paths, nested imports, cycle, repeated file, symlink escape, outside root, excessive depth/count/bytes, and changed file. | Valid imports retain source/order/scope; cycles/escapes/bounds fail; a changed instruction invalidates pinned trust/config before next turn. | R8 |
| CONF-007 | Present `ROBIN.md` only, `AGENTS.md` only, both compatible, both conflicting, nested scoped files, and untrusted files. | Resolver follows documented precedence/scope, surfaces conflict, and never silently elevates repository text to system/managed authority. | R8 |
| CONF-008 | Trust a workspace, change settings/instructions/hook/skill/MCP definitions, switch branch, move worktree, revoke trust, and reopen. | Trust binds exact physical identity and material hashes; changes require scoped reapproval; revocation blocks activation without deleting history. | R8 |
| CONF-009 | Attempt trust through project config, model output, hook output, environment file, imported instructions, or stale approval response. | Only explicit trusted user/managed action can grant trust; every other path is inert/denied. | R8 |
| CONF-010 | Open untrusted workspace and invoke help, doctor, trust preview, session listing, provider turn, command, Git write, hook, and MCP tool. | Read-only administrative actions work; project content/provider egress/execution/extensions remain blocked until trust. | R8 |
| CONF-011 | Run `robin config explain` for normal, overridden, managed, secret metadata, unknown, invalid, and path-scoped keys. | Output shows safe effective value, winning source, overridden sources, validation/floor, and never raw credential/instruction-secret bytes. | R8 |
| CONF-012 | Set config roots through each platform default and ROBIN override with absolute, relative, symlinked, aliased, nonexistent, unowned, world-writable, and overlapping paths. | Only valid separate roots are accepted/created with owner-only controls; failure occurs before sensitive state access. | R3 |
| CONF-013 | Modify the complete R8 configuration during an active provider invocation, permission wait, tool execution, and between turns. | Active invocation/tool stays pinned; next eligible boundary creates a new snapshot; stale permission/config state cannot cross. | R8 |
| CONF-014 | Load project `.env`, shell startup, Git config values, provider SDK defaults, and ambient proxy variables without explicit allowlist. | Robin does not auto-load project `.env` or arbitrary ambient config; accepted proxy/environment settings have named trusted sources and redacted diagnostics. | R8 |
| CONF-015 | Migrate each supported config schema, interrupt before/after temp/rename/version switch, and open with older/newer binaries. | Migration is idempotent, backed up where destructive, validates result, and obeys documented rollback/read-only limits. | R10 |
| CONF-016 | Change a path-scoped instruction target through rename, case alias, symlink, and Git branch switch. | Scope matches canonical current paths only; cached instruction activation invalidates on identity/config change. | R8 |

### 11.10 Credential broker and redaction matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| CRED-001 | Add a synthetic credential through hidden TTY input with backspace, cancel, empty, oversized, invalid format, and successful value. | Secret never echoes/history/logs; cancellation stores nothing; valid secret reaches only the isolated backend and metadata stores only a redacted fingerprint. | R4 |
| CRED-002 | Import one exact named environment variable in interactive and explicitly selected headless secret-input surfaces; test missing, empty, invalid name, multiple variables, and project `.env`. | Only the named process variable is read; value is not printed/persisted outside its one-time lease; `.env` and other variables are untouched. | R4 |
| CRED-003 | Attempt secret input as positional arg, `--api-key`, URL userinfo/query, config JSON, project setting, model prompt, and stdin without explicit secret mode. | Parser/config/transport rejects before use; shell history/process listing/session never receives a supported raw-secret path. | R4 |
| CRED-004 | Exercise the R7 macOS Keychain/Secret Service test namespace add, get, update, remove, locked/unavailable backend, denied user prompt, duplicate ID, and cleanup. | Broker maps stable outcomes, never falls back silently to plaintext, and leaves no synthetic secret after suite. | R7 |
| CRED-005 | Bind one credential to exact adapter, auth strategy, HTTPS origin, scheme, host, port, and profile; attempt use on each mismatched component. | Broker/transport refuses mismatch before resolving/injecting secret; no bytes reach wrong endpoint. | R4 |
| CRED-006 | Inject key into reviewed header then trigger redirect, retry, proxy, SDK debug logging, thrown request object, and malformed response. | Authorization bytes exist only at final transport write to allowed origin and are absent from every capture/exception/log/diagnostic. | R4 |
| CRED-007 | Validate metadata-only, local format, and explicit network authentication probe under success, rejection, scope failure, network error, rate limit, and possible-cost warning. | Passive checks make no network call; active probe requires confirmation, sends no repository/session content, and stores only safe status/request ID. | R4 |
| CRED-008 | List/inspect/export credential records with names, fingerprints, endpoints, status, timestamps, and referencing profiles. | Output is useful but contains no secret/backend access token; machine and human views share redaction. | R4 |
| CRED-009 | Rotate with valid replacement, invalid replacement, backend write failure, validation failure, crash before switch, crash after switch, and concurrent provider request. | Old credential remains active until verified atomic switch; in-flight request pins prior safe reference; no key bytes enter event log. | R7 |
| CRED-010 | Remove unreferenced, referenced, active-use, already missing, backend-failure, metadata-failure, and partially removed records. | Dry run names dependent profiles/sessions; active use blocks; outcomes reconcile backend and metadata without claiming deletion falsely. | R7 |
| CRED-011 | Start repository commands, hooks, MCP servers, plugins, subagents, sandbox children, diagnostics, and editor client after provider key resolution. | Child environments/handles contain no provider secret unless a separately approved agent-owned credential mode explicitly says so. | R8 |
| CRED-012 | Place canaries in provider key, repository, environment, filenames, provider error, tool output, config error, and extension output. | Full-surface byte scan finds zero forbidden occurrences in events, objects, snapshots, indexes, logs, renderers, diagnostics, packages, child envs, hooks, MCP, or uploaded artifacts. | R4 |
| CRED-013 | Trigger process crash/core-report path, unhandled exception, SIGTERM, and debug mode while secret is resolved. | Support/crash data is redacted or disabled before secret resolution; no raw secret persists outside backend/provider transport. | R4 |
| CRED-014 | Configure the R7 no-credential local endpoint and a hosted endpoint accidentally marked no-credential. | No-key mode is permitted only for registered local/compatible adapter-profile origins; it never suppresses required hosted auth. | R7 |
| CRED-015 | Use two credential records for the same provider and switch profile/model between turns and on session resume. | Exact credential reference/version is pinned per provider attempt; UI identifies safe record name; switch never leaks or rewrites history. | R7 |
| CRED-016 | Back up, export, uninstall, project-purge, and global-purge with credential metadata and backend entries present. | Ordinary backup/export excludes secret; uninstall preserves backend by default; purge inventories and separately confirms exact backend deletion. | R10 |

### 11.11 Permission and approval matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| PERM-001 | Evaluate every tool operation with complete normalized attributes: tool/version, workspace, paths, command, network, Git target, extension, mutability, sandbox, and risk. | Decision is based on the exact immutable object later executed; missing required attribute fails closed. | R5 |
| PERM-002 | Combine built-in `default`, `plan`, `accept-edits`, `locked`, and `bypass` modes with user rules, project restrictions, and managed floors for read/edit/process/Git/network/extension actions. | `deny > ask > allow`; each mode matches the canonical enum; lower-trust source cannot weaken a higher floor; the current preview's `ask` spelling migrates to `default`. | R5 |
| PERM-003 | Request bounded repository reads, outside-root reads, edits, ordinary command, shell command, Git stage/commit/push, network, hook, MCP, and destructive Git action under default mode. | Reads follow bounded default; consequential actions ask; high-risk actions deny unless explicitly enabled through eligible trusted source. | R5 |
| PERM-004 | Run plan mode and attempt create/modify/delete/rename, process, Git write, network, hook, and model-emitted self-approval. | Every mutation/execution is denied before handler; read-only planning remains possible; model text cannot change mode. | R5 |
| PERM-005 | Run accept-edits mode for exact bounded edits, commands, Git writes, network, and edits outside permitted path scope. | Eligible edits may allow; commands/Git/network retain ask/deny; outside/stale edits do not inherit acceptance. | R5 |
| PERM-006 | Run the headless surface under each canonical permission mode where a decision is ask with no callback, valid callback, malformed callback, timeout, disconnect, and stale answer. | Headless is a surface, not a sixth permission mode; ask becomes stable denial/unavailable without a configured callback; callback is framed/bounded; malformed/timeout/stale response executes nothing. | R7 |
| PERM-007 | Render allow-once, turn-scoped, session-scoped, and persistent-rule choices for eligible/ineligible actions. | Choice scope is explicit and bound; persistent rule preview shows exact rule/destination before atomic write; ineligible high-risk persistence is unavailable. | R5 |
| PERM-008 | Mutate tool version, arguments, path identity/hash, executable, cwd, env, sandbox backend/profile, network target, Git HEAD/index, provider/model, policy, extension, or expiration after approval. | Any bound material change invalidates approval; handler remains uncalled until a new exact decision. | R5 |
| PERM-009 | Reuse consumed approval, use approval across session/turn/tool, duplicate concurrent consume, and replay approval event. | One exact use wins where one-time; all replays/cross-scope uses fail; replay never dispatches effects. | R5 |
| PERM-010 | Race approval response with denial-rule update, trust revocation, cancellation, process completion, and session close. | Stream/order rule produces one deterministic outcome; stricter current policy/cancellation prevents stale execution; no deadlock. | R5 |
| PERM-011 | Feed secret attributes, raw command output, repository content, provider fields, and extension metadata into policy explanation. | Trace uses safe normalized attributes and redacted categories/counts; secrets/source content do not leak. | R5 |
| PERM-012 | Attempt bypass activation through project config, environment, alias, model tool, hook, MCP, subagent, resumed session, and ordinary runtime command. | Only explicit launch flag plus trusted confirmation can enable; managed policy can disable; UI persistently shows bypass state. | R5 |
| PERM-013 | Deny input action before handler and deny output release after a bounded handler result. | Pre-deny handler count is zero; post-deny suppresses provider/human/audit payload bytes while retaining only safe fact metadata. | R5 |
| PERM-014 | Evaluate a provider proposal group containing mixed safe/unsafe independent registered operations and compare per-item versus reject-all policy. | One approval cannot smuggle an unreviewed item; exact executed set equals evaluated set. The R6 atomic multi-file edit batch remains unavailable until R6 and then inherits this regression. | R5 |
| PERM-015 | Change user/persistent rule file concurrently and inject write/rename/permission failure. | Atomic rule update does not lose unrelated rules or corrupt policy; failed persistence does not grant session authority. | R5 |
| PERM-016 | Simulate policy change against recorded action corpus with newly allowed, denied, and asked outcomes. | Counts and exact changed action IDs are stable; newly allowed consequential behavior requires explicit review before merge. | R5 |
| PERM-017 | Run sandbox-required action with sandbox success, degraded, unavailable, and false capability report. | Permission and isolation claims remain separate; strict requirement blocks degraded/unavailable execution; independent probe catches false report. | R5 |
| PERM-018 | Attempt prompt injection that prints fake approval UI, fake policy rule, or fake tool result. | Provider/repository text is rendered as untrusted content and cannot generate a permission decision ID or handler receipt. | R5 |

### 11.12 Session crash, recovery, concurrency, and migration matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| SES-001 | Create/open/close/reopen a session with canonical workspace, name, timestamps, config snapshot, and no turns. | Manifest/events/replay agree; close is not deletion; no provider/network required. | R3 |
| SES-002 | Persist user submission then crash before context assembly and before provider send. | Submission appears exactly once on resume; provider was not contacted; user may continue or discard through explicit action. | R3 |
| SES-003 | Crash before, during, and after an event frame write and manifest update. | Valid prior frames survive; torn final frame is repaired/recorded; middle/hash corruption quarantines; no sequence gap is accepted. | R3 |
| SES-004 | Open the same session with two writers simultaneously and with a read-only inspector. | One writer lease wins; second writer cannot append; inspector reads a verified tip and cannot mutate lock/session. | R3 |
| SES-005 | Kill writer, reuse PID with another process, leave fresh/stale lock, change host identity, and corrupt lock JSON. | Recovery uses nonce/start/host/log evidence, never PID alone; ambiguous lock refuses writes; unrelated process is never signaled. | R3 |
| SES-006 | Crash before provider transmission, after possible request transmission, mid-stream, after terminal provider frame, and before sealed event append. | Not-sent may retry; possible-send becomes uncertain; complete verified spool seals once; no provider call is silently repeated to rebuild history. | R4 |
| SES-007 | Crash after tool normalization, permission evaluation, approval display, approval response, approval consumption, and execution preparation. | Resume shows exact durable phase; consumed decision cannot replay; changed preconditions require new decision; no unprepared tool executes. | R5 |
| SES-008 | Crash before edit temp write, during write, after flush, after atomic rename, after edit receipt, and after durable edit event. | Workspace/hash/journal reconciliation yields not-started, completed, or uncertain; exact edit occurs at most once; user changes remain. | R3 |
| SES-009 | Crash before process spawn, after spawn, during output, during cancellation, after child exit, and before terminal receipt. | Owned process is reaped/classified without PID-reuse hazard; verified output/exit seals once; unknown exit is never success. | R3 |
| SES-010 | Crash before/after Git stage, commit, branch ref update, push request, and host PR response. | Index/HEAD/ref/remote/host oracles classify exact outcome; uncertain network effect does not auto-retry; no duplicate commit/PR. | R6 |
| SES-011 | Crash before CAS temp flush, after flush, after publish, before session ref, after ref, and during reference-index update. | No ref targets incomplete object; orphan object is safely retained/collected; live object remains; index rebuild matches scan. | R3 |
| SES-012 | Crash before snapshot temp, after snapshot rename, before manifest pointer, and with snapshot/state hash mismatch. | Events remain authoritative; valid orphan snapshot may be adopted only by exact tip/hash; invalid snapshot is ignored/quarantined, never overrides events. | R3 |
| SES-013 | Delete global indexes and caches, corrupt them, or leave update partially written. | Rebuild from validated sessions restores names/recent/workspace/object refs; authorization/resume behavior is unchanged. | R3 |
| SES-014 | Resolve `--continue` across no sessions, one, closed, archived, quarantined, different workspaces, same workspace aliases, and equal timestamps. | Newest eligible session uses canonical workspace and deterministic tie-break; ineligible sessions never resume silently. | R3 |
| SES-015 | Resolve `--resume` by exact ID, unique name, duplicate/ambiguous name, unknown, malformed, archived, quarantined, and different workspace. | Exact/unique selection works; ambiguity opens picker/errors as mode permits; workspace mismatch triggers explicit reconciliation/rebind/fork. | R3 |
| SES-016 | Rename/list/inspect/export/archive/delete sessions while provider unavailable and while another session is active. | Administrative actions need no provider; writer ownership rules hold; export is versioned/redacted; exact session scope is maintained. | R3 |
| SES-017 | Branch session at valid durable message boundary, mid-tool, uncertain effect, corrupt tail, and changed workspace. | Only safe boundary forks; ancestry/tip/config are explicit; child continuation is independent; unsafe cases require recovery first. | R3 |
| SES-018 | Resume after workspace unchanged, HEAD changed, branch changed, file changed, path moved, repository moved, and worktree replaced. | Drift report is exact; pending consequential actions/approvals invalidate; read-only history remains; unsafe resume requires fork/rebind. | R3 |
| SES-019 | Fill disk/quota during event, manifest, snapshot, object, index, export, and migration writes. | No fabricated durable acknowledgment; authoritative prior data remains readable; low-space diagnostic and exact residual temp inventory are produced. | R3 |
| SES-020 | Corrupt first/middle/final frame, payload length, sequence, previous hash, payload JSON, object, ref, snapshot, manifest, and event version. | Repair is limited to proven torn final frame/rebuildable state; authority corruption quarantines and never silently drops records. | R3 |
| SES-021 | Migrate from every supported version to current, including empty, large, archived, corrupt, unknown-future, and object-sharing fixtures. | Counts/hashes/replay match; corrupt/future fail read-only; object references remain exact; old copy/backup follows retention rule. | R10 |
| SES-022 | Interrupt migration before/after backup, each session copy, verification, per-session switch, global schema switch, and cleanup. | Restart resumes idempotently from cursor; no session has mixed authoritative version; rollback boundary is enforced. | R10 |
| SES-023 | Open migrated state with last rollback-compatible binary and one older incompatible binary. | Compatible rollback reads exact data; incompatible binary refuses writes with upgrade guidance; neither mutates newer state. | R10 |
| SES-024 | Delete session with active writer, session-local CAS objects, backups, quarantined files, symlink substitution, ownership mismatch, and injected unlink failure. | Dry-run inventory is exact; active/unsafe target blocks; only the exact session-owned resources are removed; partial failure is reported and retryable. | R3 |
| SES-025 | Replay a long session repeatedly under different renderer/provider availability and injected effect spies. | Projection and final hashes are identical; no provider, tool, credential, process, Git, hook, or MCP adapter is called. | R3 |
| SES-026 | Append at high frequency while a slow inspector tails the session and snapshots rotate. | Writer latency/memory remain bounded; inspector uses verified cursors and tolerates new frames; no partial frame is treated as durable. | R10 |

### 11.13 Prompt context, release, and compaction matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| CTX-001 | At R1 build the prompt from product system contract, current conversation, synthetic-provider adaptation, tool schemas, and current user turn; extend the same versioned assembler with R2 repository releases, R3 durable history, and R8 settings/project instructions/selected skills only when those gates register them. | At every gate, order/role/source/trust metadata for the registered sources matches specification; unavailable later sources are absent, and lower-trust text cannot impersonate a higher role. | R1 |
| CTX-002 | Start small/large repositories with hidden, ignored, generated, binary, secret, and unusual files. | Startup sends only bounded metadata and never reads/uploads full tree; every released resource has explicit cause. | R2 |
| CTX-003 | Release file through tool read, user attachment, approved discovery, and index result; attempt unapproved implicit inclusion. | Valid route records identity/hash/media/bytes/truncation/redaction/request; unapproved content is absent from exact provider bytes. | R2 |
| CTX-004 | Apply secret classifiers to safe text, known patterns, high-entropy strings, split values, binary, filenames, and false-positive fixtures. | Selected policy deterministically deny/redact/ask; traces are safe; false-positive behavior is documented/tested rather than bypassed. | R2 |
| CTX-005 | Allocate context at exact model window with tools, output reserve, reasoning reserve, images, provider overhead, and uncertain token estimate. | Robin stays below declared hard limit with safety margin; unavailable estimate fails or uses documented conservative fallback. | R4 |
| CTX-006 | Trigger compaction by token, byte, message, memory, user request, and provider context error. | Compaction occurs only at safe durable boundary; source range and reason are recorded; no pending tool result is dropped. | R3 |
| CTX-007 | Compact session containing active task, decisions, changed files, test results, failures, approvals, rejected actions, provider items, and attachments. | Typed summary includes required fields and evidence refs, labels omission/uncertainty, and remains schema-valid/bounded. | R3 |
| CTX-008 | Inject summary text that claims approval, changed precondition, completed test, or tool result absent from ledger. | Validator rejects or labels unsupported claim; summary cannot authorize or replace live precondition/evidence. | R3 |
| CTX-009 | Resume from compacted summary with provider supporting lossless continuation, translated continuation, and no compatible continuation. | Exact compatible items resume; translation is disclosed and tested; incompatible case requires new turn/fork rather than silent loss. | R3 |
| CTX-010 | Inspect context composition in human/JSON output with secret/denied/binary/oversized items. | Safe source/hash/size/reason metadata appears; forbidden bytes do not; inspection makes no provider request. | R3 |
| CTX-011 | Change instruction, file, attachment, tool schema, provider/model, permission, or summary source after context compilation and before send. | Pinned request either sends exact compiled snapshot or is invalidated before transmission; no mixed snapshot. | R4 |
| CTX-012 | Return tool output at handler, persistence, renderer, and provider-release limits independently. | Each view is separately bounded and records truncation/artifact; denied provider view does not remove safe operational evidence. | R2 |
| CTX-013 | Include prompt injection and fake system/tool/approval text from repository, command, MCP, hook, and provider notice. | Each retains its trust/content type; parser/UI never converts content into authority or an executable call. | R8 |
| CTX-014 | Use text, image, binary attachment, unsupported media, decompression bomb, huge metadata, and changed attachment file. | Supported modalities are hashed/bounded/transformed per manifest; unsupported/bomb/drift fails before provider transmission. | R7 |
| CTX-015 | Reproduce exact prompt with fixed session/config/provider/resource facts across process restart. | Semantic normalized request and fingerprint match; volatile transport fields are excluded or separately recorded. | R4 |
| CTX-016 | Exhaust context-release budget across many small reads, one large read, repeated cached read, redacted bytes, and resumed session. | Accounting rules are explicit/monotonic, duplicates follow declared charging, resume displays remaining/reset behavior, and no over-budget send occurs. | R2 |

### 11.14 Hooks, skills, MCP, and subagent matrix for later gates

These surfaces remain planned until R8 or R9. Their tests must exist before the
feature flag or documentation advertises them.

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| EXT-001 | Discover user/project skills with valid metadata, duplicate ID/version, unknown schema, oversized metadata, symlink escape, untrusted project, and changed integrity. | Only trusted, versioned, bounded skills register; metadata load performs no instruction/resource read beyond declared bounds. | R8 |
| EXT-002 | Select/invoke skill and lazily load bounded instructions, relative resources, scripts, missing resource, cycle, binary, and outside-root reference. | Exact selected content retains provenance/trust; invalid/escaping resource fails; skill text cannot grant permission. | R8 |
| EXT-003 | Define hooks for each lifecycle event with matcher, sync/process type, timeout, concurrency, permission behavior, and failure policy. | Strict schema and deterministic matching hold; unsupported event/field/failure policy blocks registration. | R8 |
| EXT-004 | Run hook success, nonzero, timeout, signal, output flood, malformed frame, duplicate response, and crash. | Hook is supervised/bounded, result classification follows configured fail-open/fail-closed eligibility, and primary session remains consistent. | R8 |
| EXT-005 | Have hook attempt to forge permission, tool result, session event, config/trust change, raw executable action, and provider credential request. | Only registered schema control responses are accepted; forged authority is rejected; credential/environment is absent. | R8 |
| EXT-006 | Start local MCP stdio server with valid initialize/capabilities/list/call/result/cancel lifecycle. | Frames are bounded/versioned, exact server identity/scope is pinned, tools map through Robin normalization/permission/execution, and server dies with scope. | R8 |
| EXT-007 | Send unknown method, duplicate/reordered ID, malformed JSON-RPC, oversized frame, partial frame, invalid UTF-8, slowloris, unsolicited result, and reconnect. | Protocol fails closed without memory/handle leak; no tool dispatch from malformed/unsolicited frames. | R8 |
| EXT-008 | Advertise MCP annotations, titles, descriptions, risk, read-only, destructive, idempotent, and open-world hints that contradict configured mapping. | Annotations remain untrusted metadata; Robin's reviewed operation definition controls policy/risk/effect. | R8 |
| EXT-009 | Configure remote MCP HTTPS endpoint with redirect, auth, origin mismatch, certificate failure, network denial, and server capability drift. | Exact transport/origin/credential/network policy applies; drift invalidates pinned snapshot; no repository/provider credential leaks. | R8 |
| EXT-010 | Invoke MCP resource/prompt containing prompt injection, secret canary, huge/binary content, and fake tool result. | Content follows context release/trust/redaction bounds and cannot become authority. | R8 |
| EXT-011 | Launch subagent with explicit model, prompt, tools, permissions, context, budget, concurrency, worktree, and result schema. | Child receives no undeclared resource; identity/config/budget are durable; result is schema-validated and attributed. | R9 |
| EXT-012 | Have subagent request disallowed tool, broaden path/network, change model, start another agent, ask parent approval, and forge parent result. | Parent boundary denies undeclared expansion; user sees exact child request if eligible; no silent delegation beyond allowlist. | R9 |
| EXT-013 | Cancel subagent before model, during stream, permission wait, process, and result return. | Cancellation propagates, child processes/worktree are handled, budget/result state is exact, and parent session remains usable. | R9 |
| EXT-014 | Run two read-only subagents concurrently and two mutating subagents in same/separate worktrees. | Read-only concurrency honors limits; mutable work uses proven separate worktrees or serial scheduler; same-authority overlap never executes. | R9 |
| EXT-015 | Crash parent, child, supervisor, and worktree cleanup at every durable boundary. | Resume reconstructs parent/child relationship and exact outcome; unproven worktree/process is quarantined, not deleted/retried blindly. | R9 |
| EXT-016 | Return subagent success, task failure, provider failure, partial result, schema-invalid result, and uncertain effect. | Parent receives normalized bounded result/evidence; assistant prose cannot override failure/uncertainty; context inclusion is explicit. | R9 |
| EXT-017 | Install/update/remove user extension with valid signature/hash, tamper, downgrade, missing dependency, active use, and rollback. | Integrity/source/version are pinned; active sessions keep old snapshot; unsafe/tampered install never loads; rollback is exact. | R10 |
| EXT-018 | Change project hook/skill/MCP configuration after workspace trust and during a session. | Material change invalidates trust/config snapshot for future execution; active exact call cannot be swapped. | R8 |
| EXT-019 | Scan hook/MCP/subagent process argv, environment, cwd, mounts, network, files, logs, and frames for provider/repository canaries. | Only explicitly released data/capabilities appear; credential and global session store handles remain absent. | R8 |
| EXT-020 | Disable every extension class and run the core coding e2e. | Core interactive/headless agent loop remains complete; extension packages are acyclic leaves and not required for ordinary operation. | R8 |

### 11.15 Security, fuzz, property, and mutation matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| SEC-001 | Coverage-guided fuzz argv/config/event/frame/provider/tool/patch/MCP parsers with per-target byte/time/memory limits. | No crash, hang, unbounded allocation, prototype mutation, handler dispatch, or secret-bearing diagnostic; minimized failures become fixtures. | R1 onward |
| SEC-002 | Generate legal/illegal session and turn event sequences with duplicates, reordering, version changes, terminal transitions, and injected crashes. | Reducer preserves invariants, terminal states do not reactivate improperly, replay invokes no effects, and invalid sequence fails typed. | R1 |
| SEC-003 | Generate path components, separators, Unicode normalization, case collisions, symlink/hard-link graphs, mount/junction forms, and concurrent swaps. | Accepted effect paths remain within authorized roots at operation time; rejected paths never reach adapter. | R2 |
| SEC-004 | Generate bounded valid patches then format/parse/apply against reference implementation; mutate headers, sizes, paths, hunks, and encodings. | Round-trip semantics hold for supported subset; mutation cannot escape, overlap, overrun, or bypass preimage. | R2 |
| SEC-005 | Generate terminal byte/event streams with invalid UTF-8, ANSI/OSC/DCS, bracketed paste, resize, interrupts, and provider/process interleaving. | Reducer/render virtual screen stays valid, terminal controls from content are inert, and cleanup state is always reachable. | R1 |
| SEC-006 | Generate provider chunks/call IDs/JSON boundaries/stop sequences and compare streaming normalizer with a whole-response reference oracle. | Equivalent legal streams normalize identically; illegal partial/duplicate states execute nothing. | R1 |
| SEC-007 | Generate R8 configuration graphs/imports/scopes/floors and compare the optimized merge/evaluator with a small reference implementation. | Result/provenance match; cycles/bounds/unknown security fields fail deterministically. | R8 |
| SEC-008 | Generate permission actions/rules/missing attributes and compare decision combiner with complete `deny > ask > allow` reference tables. | Effects/traces match; no unknown/missing value yields accidental allow. | R5 |
| SEC-009 | Mutate policy deny/ask precedence, receipt ownership, normalization capture, precondition recheck, and handler reachability branches. | 100% of non-equivalent critical permission mutants are killed; surviving critical mutant blocks R5. | R5 |
| SEC-010 | Mutate path containment, symlink revalidation, patch bound/preimage, atomic write, process group termination, Git pathspec, and session frame-chain branches. | All non-equivalent critical workspace/durability mutants are killed; waiver requires security ADR and no release claim. | R2–R5 |
| SEC-011 | Seed fake credentials/source canaries across every boundary and scan exact bytes plus reversible encodings after each deterministic e2e. | Forbidden escape count is zero; expected intentionally transmitted provider bytes are attributable to released resources and exclude credentials. | R4 |
| SEC-012 | Run hostile repository containing fake config, executable shadow, hooks, filters, symlinks, sockets, huge files, device-looking paths, terminal controls, and prompt injections. | Trust/config/tool/process/Git boundaries prevent escalation; original fixture outside expected targets is unchanged. | R2 |
| SEC-013 | Attempt resource denial with argument flood, deep config, many files, long lines, output flood, provider chunk flood, many events, CAS objects, approval queue, hooks, MCP frames, and subagents. | Every boundary enforces byte/item/time/concurrency/disk budgets and returns stable failure without host-wide exhaustion. | Relevant gate |
| SEC-014 | Race file/symlink/Git/config/policy/model/extension state between inspect, permission, and effect using synchronized barriers. | Operation-time precondition catches change; stale approval never dispatches mismatched action. | R5 |
| SEC-015 | Verify sandbox escape corpus for read/write roots, network, devices, process namespace, signals, runtime sockets, credentials, and Git common dir on isolated runners. | Independent host oracle proves achieved restrictions; backend-specific failure blocks that sandbox tier and does not affect direct-mode support. | R5 |
| SEC-016 | Tamper npm tarball, checksum, SBOM, provenance, standalone binary, update manifest, signature, channel, and downgrade metadata. | Install/update verifier rejects tamper/mismatch/replay/downgrade before replacing executable or migrating data. | R10 |
| SEC-017 | Feed decompression/archive traversal, absolute paths, duplicate entries, symlinks, hard links, excessive ratio/count/size, and signature-after-extract attacks to packaging/update extractors. | Verification occurs before trusted extraction; extractor stays in exact temp root and enforces limits; no target file changes on failure. | R10 |
| SEC-018 | Run static forbidden-import and package-boundary scans with intentional violation fixtures. | UI/provider/extensions cannot import tool handlers/storage internals improperly; kernel cannot import product/provider implementations; test catches each fixture. | R0 onward |
| SEC-019 | Scan source, lockfile, package inventory, built output, npm tarball, archives, SBOM, and docs for real-secret patterns, developer paths, old public binary, and unexpected executable files. | No forbidden artifact ships; allowlisted synthetic canaries and internal `@guard` identifiers are documented exact exceptions. | R0/R10 |
| SEC-020 | Reproduce every security incident/regression in a deterministic minimized fixture and run adjacent-boundary corpus. | Regression fails on vulnerable commit, passes on fix, has requirement/threat/evidence links, and remains in permanent suite. | Relevant gate |

### 11.16 End-to-end and live-provider matrix

| ID | Mechanics | Pass criteria | Earliest gate |
| --- | --- | --- | --- |
| E2E-001 | Install npm tarball in isolated prefix, launch interactive PTY with scripted provider, complete two conversational turns, close, and uninstall binary. | User flow/terminal/session outcome is correct; uninstall removes package only; no provider/network/daemon/database used. | R1 |
| E2E-002 | Open temporary real Git repo, ask synthetic agent to search/read/edit/run failing then passing test, and inspect diff. | Only intended files change, verification facts are accurate, permissions appear, final diff/status match, and fixture cleanup finds no orphan. | R2 |
| E2E-003 | Kill Robin after first edit/turn, reopen with `--continue`, reconcile unchanged workspace, finish second turn, export transcript, and delete session. | Conversation/edit evidence resumes exactly; no effect repeats; export is redacted/versioned; repository survives session deletion. | R3 |
| E2E-004 | Configure one production adapter through hidden BYOK onboarding, run a bounded real-repository task, cancel one turn, resume, and remove credential after session. | Provider/tool stream works, capability/usage/request IDs are recorded safely, key never leaks, spend stays under cap, removal lifecycle is accurate. | R4 |
| E2E-005 | Seed hostile prompt injection, fake key, unsafe command, symlink escape, stale edit, output flood, and provider disconnect into one synthetic scenario. | Unsafe operations deny/ask correctly, original/outside state is unchanged, cancellation/recovery is exact, and canary scan finds zero leak. | R5 |
| E2E-006 | Stage exact Robin edits, create commit with hooks disabled or explicitly reviewed per mode, prepare PR text, and simulate host creation failure/success. | User changes remain separate, exact tree/commit/remote facts are recorded, failure never claims PR, and no push occurs without approval. | R6 |
| E2E-007 | Run equivalent prompt in interactive, `--print`, final JSON, and JSONL streaming modes with fixed synthetic provider/session config. | Same application/tool outcome and durable events result; presentation/exit semantics match each published contract; machine output has no ANSI. | R7 |
| E2E-008 | Run shared deterministic scenario across every released direct adapter through synthetic servers and one protected smoke per live provider family. | Normalized tool semantics match, each adapter passes its dialect contract, and no shared code changes are needed for model/provider selection. | R7 |
| E2E-009 | Trust a fixture project, invoke one skill, one hook, and one local MCP tool, then change extension config and rerun. | Lazy load/lifecycle/permission/trust invalidation are visible; extensions cannot bypass core tool path; core session remains recoverable. | R8 |
| E2E-010 | Delegate two read-only tasks and one mutable task to subagents with separate worktree, cancel one, integrate accepted result, and resume after parent crash. | Budgets/permissions/worktrees/results are isolated, cancellation cleans descendants, parent history is exact, and no unproven directory is deleted. | R9 |
| E2E-011 | Install release candidate on clean macOS and Ubuntu, run doctor/provider setup/coding flow, update to next candidate, roll back within compatibility window, uninstall, and separately purge. | Every lifecycle step follows documented targets, verifies provenance, preserves or removes data as selected, and needs no PostgreSQL/Docker/daemon. | R10 |
| E2E-012 | Launch future editor prototype against packaged local engine, share one session with headless query, approve through one client, reconnect from cursor, and close editor. | One engine/permission path exists, cursor handles duplicate delivery, CLI remains functional alone, and extension stores no provider key. | R11 |
| E2E-013 | Install selected editor release in clean trusted/untrusted profiles, run selected-context/edit/diff/approval/session flows, disable/uninstall extension, and continue in CLI. | Workspace trust and CSP/message checks hold; no second agent loop; CLI owns portable session; uninstall leaves data according to policy. | R12 |
| LIVE-001 | Perform explicit provider credential validation with no repository/session content. | Auth/capability result and redacted request ID are recorded; user accepted any network/spend; key is absent from artifacts. | R4 |
| LIVE-002 | Run a fixed consented public fixture task once per supported provider/model with strict token, cost, turn, tool, time, and network budgets. | Task reaches defined outcome or classified failure; budget cannot exceed cap; exact release/adapter/model revision is recorded. | R4/R7 |
| LIVE-003 | Force provider rate limit/overload where a safe test mechanism exists, otherwise use a protected synthetic equivalent and one observed real failure fixture. | Retry/backoff/category align with contract; no repository mutation duplicates; spend/attempts remain visible. | R7 |
| LIVE-004 | Cancel a real streaming request at first text and at a tool-call boundary. | Transport abort behavior matches declared provider capability; partial call remains inert; usage/cost uncertainty is truthful. | R4/R7 |
| LIVE-005 | Compare released-resource manifest and exact client request capture available before transport with provider-side request metadata. | Only intentionally released source is sent; storage/caching controls and compatibility tier match documented provider behavior. | R4/R7 |

### 11.17 Live-provider workflow controls

Live tests supplement but never replace synthetic provider contracts. They run
only from a protected environment after explicit approval and use:

- dedicated low-scope test credentials, not a developer's ordinary key;
- a public/synthetic repository fixture with no private content;
- an allowlisted provider origin and exact adapter/model profile;
- maximum one concurrent case until cost and cancellation evidence mature;
- hard token, request, turn, wall-time, and currency caps enforced locally;
- provider account-side spend alert and limit when available;
- no unreviewed hooks, MCP, subagents, network tools, package install, push, or
  deployment capability;
- redacted captures and short artifact retention;
- automatic secret revocation/rotation after suspected leak;
- manual review of outcome and provider-side usage before baseline promotion.

Fork pull requests and ordinary branch CI never receive provider, npm publish,
signing, notarization, Git host, or update-service credentials. A live test that
cannot prove its budget or fixture isolation does not run.

## 12. Continuous Integration and Protected Workflows

### 12.1 CI principles

- Pull-request CI is deterministic, network-minimized, and secret-free.
- Jobs receive the least GitHub token permissions; the default is
  `contents: read` with no write, package, issue, OIDC, or deployment authority.
- Dependency install uses the committed lock and `--ignore-scripts`.
- Test commands run from the checked-out commit, not generated workflow input.
- Third-party actions are pinned to immutable commit hashes.
- Caches are performance hints, never test authority. Cache keys include OS,
  architecture, Node, lockfile hash, and job schema; a clean-cache job verifies
  every release candidate.
- Untrusted pull-request code never runs on a credential-bearing or persistent
  self-hosted runner.
- Hostile sandbox tests run only on disposable isolated workers with no
  organization credentials, privileged sibling workloads, or reusable state.
- Artifacts are allowlisted, redacted, checksummed, and retained only for the
  documented period.
- A green aggregate cannot hide a skipped required matrix cell.

### 12.2 Job inventory and pass criteria

| Job | Trigger and runner | Work | Secrets | Pass criteria |
| --- | --- | --- | --- | --- |
| `docs-policy` | Every PR; Ubuntu | Markdown links/fences/whitespace, public Robin identity, current/planned claims, requirement IDs, ADR registry, secret/path scan | None | All docs parse; local links exist; product-first assertions and trace schema pass; no forbidden public old name or developer path. |
| `static` | Every PR; Ubuntu, Node minimum | `npm ci --ignore-scripts`, typecheck, architecture/import checks, lock/dependency policy, formatting/lint when configured | None | No source/lock rewrite, type/import violation, unregistered schema, or unexpected lifecycle/native artifact. |
| `unit-contract` | Every PR; Ubuntu, Node minimum/current | Unit, golden, reducer, schema, provider synthetic adapter, storage parser, tool and CLI contract suites | None | Deterministic suite passes once with fixed seeds; leak detector is empty. |
| `generative-seeds` | Every PR bounded; nightly expanded | Property/fuzz regression seed corpus and bounded generated cases | None | No crash/hang/invariant failure; seed/minimized input emitted on failure. |
| `package-smoke` | Every PR; Ubuntu | Build, `npm pack --dry-run`, tarball allowlist, install in temporary prefix, version/help/current deterministic run, uninstall | None | Packed inventory/hash valid; executable bit/name works; no hidden file/credential/path; data separation holds. |
| `pty-linux` | R1+ every PR; Ubuntu | Real PTY interactive synthetic corpus, signal/resize/restoration, headless split | None | PTY semantic matrix passes; no terminal/process/handle leak. |
| `repository-tools` | R2+ relevant PR and main; Ubuntu | Real temporary filesystem/Git, read/edit/process/Git parser and preservation suites | None | Expected exact delta only; original/outside fixtures unchanged; process groups reaped. |
| `session-recovery` | R3+ every relevant PR; Ubuntu | File journal, locks, CAS, snapshots, crash harness, resume/continue, migration origin fixtures | None | Every fault reaches expected classification/tip/hash; no database/daemon/network call. |
| `provider-contract` | R4+ every provider PR; Ubuntu | Loopback synthetic server, recorded dialect fixtures, capability, retry/cancel/usage/redaction | Synthetic auth only | Shared and adapter-specific suites pass; unexpected network denied. |
| `credential-redaction` | R4+ credential/provider PR; disposable OS matrix | Test credential namespace plus whole-surface canary scan | Synthetic canaries only | Backend cleanup verified and forbidden occurrence count is zero. |
| `permission-direct` | R5+ every relevant PR; Ubuntu/macOS | Policy/mode/approval/staleness/handler reachability using direct process backend | None | Decision matrices pass; denied/stale handler count remains zero. |
| `sandbox-linux` | R5+ relevant PR/main; disposable isolated Linux | bubblewrap and optional container hostile process/network/root/resource corpus | None | Independent host oracle verifies achieved tier; worker is fully torn down. |
| `macos-integration` | Main and every release; Tier 1 macOS | PTY, filesystem/edit/process/Git/session, Keychain test namespace, Seatbelt capability if released | Synthetic canaries only | All required macOS cells pass with exact OS/arch record and no residual key/process/temp. |
| `node-os-matrix` | Main/nightly and release | Node 22/24, Ubuntu matrix, macOS matrix, selected arm64/WSL preview | None | Supported combinations pass; required cell cannot be skipped; preview failures update limitations. |
| `extension-contract` | R8+ relevant PR; Ubuntu/macOS | Skills, hooks, MCP framing/trust/permission and hostile protocol corpus | None | Extension cannot bypass authority/credential boundary; all children/servers cleaned. |
| `subagent-worktree` | R9+ main and relevant PR | Parent/child budgets/cancel/crash, worktree isolation, concurrency scheduler | None | No cross-agent widening/overlap; owned worktrees/processes recover/clean exactly. |
| `mutation-critical` | Main, security PR, release | Policy, path, edit, process, Git, frame/recovery critical mutation set | None | Required non-equivalent mutant score is met and every surviving critical mutant is resolved/waived by accepted ADR. |
| `performance-smoke` | Relevant PR on dedicated stable runner | Small CLI/render/session/provider/process benchmarks | None | No threshold regression beyond noise policy; full benchmark remains nightly. |
| `performance-full` | Nightly and release on dedicated runners | Section 13 datasets and long-run/resource profiles | None | p50/p95/p99, memory/disk/FD/PID, cancel/orphan targets meet platform budget or block claim. |
| `live-provider-smoke` | Manual/scheduled protected environment; never forks | Fixed public fixture against exact allowlisted real profiles | Dedicated provider key | Spend/case/concurrency limits hold; redaction scan zero; results reviewed before release evidence. |
| `release-candidate` | Protected RC tag/environment | Clean source build, complete matrix evidence query, package/archive/standalone, SBOM, checksums, provenance, install/update/rollback/uninstall/purge | Signing/notarization only in isolated signing steps | All gate evidence from same commit; artifacts verify in clean jobs; compatibility/release notes complete. |
| `publish-npm` | Approved final tag after RC verification | Download exact verified tarball, compare hash, publish with provenance, reinstall from registry | Short-lived trusted publishing identity | Registry tarball hash/inventory/version match approved artifact; smoke/unpublish-deprecation plan recorded. |
| `publish-release` | Approved final tag | Upload signed archives/standalone, checksums, SBOM, provenance, compatibility manifest, notes | Release write plus isolated signing/notarization | Uploaded bytes match verified hashes; release/tag immutable; download/install verification passes. |

### 12.3 Deterministic workflow network policy

After dependency restore, deterministic jobs deny outbound network except where
the runner cannot enforce denial and a connection-audit shim is used. Permitted
test network is loopback to an exact test-owned server. Tests must not use live
DNS names for fixtures.

Provider, update, Git-host, remote MCP, telemetry, and package-registry adapters
receive synthetic transports. `npm ci` network access, if cache is cold, occurs
in the dependency-restore step before test secrets (none) and is separated from
application tests. Release verification includes one install from a clean npm
registry path only after the package is published.

### 12.4 Secret-bearing workflow separation

Protected workflows use distinct environments and credentials:

| Credential | Accessible step | Scope and lifetime |
| --- | --- | --- |
| Provider test key | One live-provider adapter process | Dedicated test project/account, allowlisted origin/model, low spend, short rotation, no repository-host or publish scope. |
| npm trusted publisher | Publish npm step only | Exact package and protected tag/environment; no test/build step access. |
| macOS signing identity/notarization | Isolated signing/notarization step | Submitted artifact hash only; no provider/repository-write credentials. |
| GitHub release token | Upload release step | Contents/releases write for protected tag only. |
| Optional Git host integration test identity | Protected loopback/staging host job only | Test repository only; no organization-wide or production repository access. |

Environment approval records approver, commit, artifact hash, workflow run, and
budget. Secret-bearing jobs cannot check out or execute code from forks. Logs
masking is a defense in depth, not the redaction oracle.

### 12.5 Workflow artifact policy

Allowed pull-request artifacts:

- test report with test IDs/status/durations;
- coverage and mutation summaries without source/session payloads;
- package file inventory and checksums;
- redacted failure diagnostics with fixture IDs, hashes, counts, and seeds;
- synthetic golden diffs already present in the repository.

Prohibited uploads:

- real/synthetic raw credential values;
- arbitrary environment dumps;
- user or private repository content;
- local session logs/objects/transcripts;
- raw provider request/response bodies from live tests;
- core dumps or memory captures after credential resolution;
- unredacted command output;
- archives of an entire temporary or home directory.

Default PR artifact retention is 7 days, main deterministic evidence 30 days,
release evidence for the supported release lifetime plus 90 days, and live
provider raw safe metadata 7 days. Public release artifacts and provenance are
retained for the release's public availability period.

### 12.6 Failure, skip, and flake policy

- A deterministic failure blocks merge.
- A required platform/test skip is a failure unless the job proves the feature
  is disabled and that matrix cell is not claimed.
- An infrastructure retry links the original attempt and does not relabel a code
  failure as infrastructure without evidence.
- A flaky test is assigned an owner, reproduction seed/trace, and deadline; the
  affected gate remains blocked.
- A real-provider stochastic task failure does not erase adapter conformance.
  It is reviewed against the versioned eval threshold and last accepted baseline.
- Security scanning findings are triaged by reachability, data/effect boundary,
  exploitability, and shipped support, not score alone.
- No release job publishes after an upstream required job is manually cancelled,
  skipped, or rerun against a different commit.

### 12.7 Release evidence query

Before artifact construction, CI evaluates the traceability registry and
compatibility manifest for the target gate. It verifies:

- every required evidence ID points to a successful job from the release commit;
- every claimed OS/arch/Node/Git/terminal/provider/sandbox cell has evidence;
- every shipped schema has old/current fixtures and migration result;
- every release package has a clean install/update/rollback/uninstall result;
- every current user-visible claim maps to an accepted requirement;
- no evidence is expired by a later code/schema/fixture change;
- unresolved waiver IDs have not expired and do not cover critical/high issues.

## 13. Performance and Resource Budgets

### 13.1 Measurement rules

- Budgets are gates on reference hardware, not universal latency promises.
- Each result records CPU, memory, disk/filesystem, OS, architecture, Node,
  terminal mode, Git, sandbox backend, repository/session dataset, provider
  fixture, power mode, and background load policy.
- Run warmup separately, then report sample count, p50, p95, p99, maximum, and
  confidence/noise estimate where meaningful.
- Use monotonic time. Provider network latency and model generation are reported
  separately from Robin overhead.
- Compare release candidate with the latest accepted release using identical
  dataset/runner. A runner/image change creates a new baseline and overlapping
  comparison run.
- Optimization cannot weaken flush, validation, redaction, permission,
  cancellation, or integrity behavior.

### 13.2 Initial budgets

The reference target is the user-experience objective measured on the named
reference machine. The CI ceiling is the hard regression limit on the controlled
CI runner. A release records both; it cannot substitute the looser ceiling for
the target in a public performance claim.

| Metric | Workload | Target and pass rule | Gate |
| --- | --- | --- | --- |
| Warm help/version | Installed package, warm filesystem cache, no repo/provider/session load | Reference target: p95 under 150 ms. CI ceiling: p95 under 250 ms. Both require zero provider/repository/credential/session module construction. | R0/R10 |
| Cold interactive prompt | Installed package, trusted small fixture, existing valid config, synthetic provider not contacted | Reference target: p95 under 500 ms to usable prompt. CI ceiling: p95 under 750 ms. | R1 |
| Local input echo | 10,000 key events while assistant/process events stream | p95 under 16 ms; p99 under 32 ms from decoded key to render write. | R1 |
| Render frame work | 120-column transcript with active tool/process output | p95 under 8 ms, p99 under 16 ms; at most 30 visual refreshes/second; semantic events not dropped. | R1 |
| First SIGINT acknowledgement | Active provider and active process cases | UI state acknowledgement under 100 ms p95; provider abort/process graceful signal dispatched under 150 ms p95. | R1/R2 |
| Process tree termination | Child/grandchild ignores graceful signal | No owned descendant 2 seconds after configured grace interval plus platform kill overhead; orphan count zero. | R2 |
| Session append | 2 KiB canonical event with flush on local SSD | p95 under 25 ms and p99 under 75 ms on reference host; acknowledgment occurs only after documented flush level. | R3 |
| Session reopen | 10,000 events plus valid snapshot covering 9,500 | Reference target: p95 under 250 ms. CI ceiling: p95 under 500 ms. Both require exact replayed state hash and no full object-content load. | R3 |
| Full session replay | 100,000 small events without snapshot | At least 25,000 events/second on reference host with bounded memory; exact state hash. | R3 |
| CAS write | 10 MiB synthetic output | At least 100 MiB/second on reference local SSD excluding mandatory flush; peak memory under 16 MiB above stream buffers. | R3 |
| Repository startup | 100,000-path fixture with 2 GiB content | p95 under 750 ms to prompt metadata; zero full-file hashes/content reads at startup. | R2 |
| Bounded literal search | 10,000 text files, 100 MiB total, 100-result cap | p95 under 1.5 seconds on reference SSD; respects byte/time/result cap and cancellation. | R2 |
| File read | 1 MiB UTF-8 file, 64 KiB window | p95 under 50 ms excluding cold network filesystem; exact hash/window/truncation. | R2 |
| Patch apply | 100 KiB file, 20 hunks, atomic write and diff | p95 under 150 ms excluding permission wait; pre/post flush and hashes correct. | R2 |
| Provider stream overhead | 5,000 synthetic deltas/second, slow 30 fps renderer | Peak queued semantic bytes within configured bound; p95 normalization under 2 ms/event; abort stays under target. | R4 |
| Tool-call completion | 1 MiB maximum argument stream | Peak memory under 2.5 times configured accumulator bound; no parse/dispatch before completion. | R4 |
| Context compilation | 500 messages, 100 tool schemas, 2 MiB candidate resources | p95 under 250 ms excluding token API/network; deterministic fingerprint and bound. | R4 |
| Compaction local overhead | 5,000-message synthetic session excluding model summary latency | p95 under 500 ms to select/serialize bounded source package; in-memory window remains bounded. | R7 |
| Idle memory | Interactive ready session with one small transcript | Resident memory target under 120 MiB for source/npm Node build on reference host. | R10 |
| Long-session memory | 8-hour accelerated, 20,000 events, 1 GiB streamed output retained by references | Resident memory target under 300 MiB, no monotonic leak beyond bounded caches, file descriptor growth under 5 from baseline. | R10 |
| Disk bound | Session configured for 100 MiB retained artifact budget | Robin stops next retaining operation at cap, reports exact usage, and does not exceed cap by more than one bounded temporary object that cleanup classifies. | R3 |
| Headless JSONL throughput | 100,000 synthetic live records to consuming pipe | At least 20,000 records/second on reference host, sequence exact, no ANSI, bounded backpressure. | R7 |
| Doctor cold run | No network validation, valid install/small repo | p95 under 1 second excluding optional OS credential/sandbox probes; each slow probe separately timed. | R10 |

Targets are revised only through a reviewed evidence change that includes old/new
measurements and user impact. A failing budget may be labeled preview/degraded;
the number is not silently removed from the release gate.

### 13.3 Resource leak oracles

Performance and e2e processes record before/after:

- resident/heap/external memory and high-water marks;
- file descriptors/handles and watchers;
- child and descendant PIDs/process groups;
- sockets/listeners and pending provider requests;
- terminal raw/canonical flags;
- session locks and temporary files;
- credential test records;
- temporary repositories/worktrees;
- CAS object/reference counts;
- cache/log/disk byte totals.

A stable expected runtime cache may remain only if its maximum, key, invalidation,
and teardown are documented. Unbounded monotonic growth or residual authority
blocks release.

### 13.4 Benchmark datasets

Checked-in generators create:

- small repository: 100 files, 1 MiB;
- medium repository: 10,000 files, 100 MiB;
- large metadata repository: 100,000 paths, 2 GiB sparse/generated content;
- short session: 20 events and 2 objects;
- long session: 100,000 events, snapshots every configured interval, 10,000 CAS
  references, compaction boundaries, and safe synthetic content;
- output flood: deterministic stdout/stderr/binary streams from 1 KiB through
  the absolute drain cap;
- provider flood: deterministic legal and hostile chunk scripts;
- Unicode/path corpus: checked-in generated names and platform exclusions.

Generators are versioned and record hash/seed. Benchmarks never download a
third-party repository or submit benchmark content to a real provider.

## 14. Packaging and Artifact Construction

### 14.1 Package identity and artifact stages

The CLI package is `@zachshotamartin/robin` and exposes the `robin` executable.
It remains private at R0 until publication readiness is accepted.

Packaging progresses through these stages:

1. **R0 source build and local tarball:** build workspaces, verify executable,
   run `npm pack --dry-run`, install tarball in temporary prefix, do not publish.
2. **R1–R4 preview npm tarball:** CI produces an immutable artifact for testers;
   package remains unpublished or preview-channel only.
3. **R7 npm preview publication:** publish protected prerelease versions after
   multi-provider/headless package evidence passes.
4. **R10 stable npm publication:** publish stable package with provenance,
   compatibility manifest, SBOM, lifecycle docs, and registry reinstall test.
5. **R10 signed archives:** provide platform-named archives containing the
   executable launcher/runtime files, licenses, compatibility manifest, and
   uninstall manifest.
6. **R10 optional standalone executables:** ship only after a dedicated Node SEA
   or equivalent bundling ADR, reproducible build analysis, signing, notarization,
   native dependency audit, and clean-machine lifecycle matrix.

Npm remains the reference distribution until standalone artifacts equal its
behavior and schema compatibility. A standalone artifact is not advertised
merely because it launches on one machine.

### 14.2 Build sequence

The release build uses a clean checkout at the protected tag:

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm pack --workspace @zachshotamartin/robin --dry-run
npm pack --workspace @zachshotamartin/robin
```

The produced tarball name comes from npm and the exact release version. CI
records its SHA-256. It then installs the tarball into an empty temporary npm
prefix, executes version/help/synthetic/package tests, and uninstalls it.

### 14.3 Npm package allowlist

The package contains only:

- compiled runtime JavaScript, source maps only if reviewed for path/source
  exposure, and type declarations intended for the public API;
- executable entry point with correct mode;
- package manifest and required workspace runtime modules;
- CLI README, license, notices, schemas, and safe built-in non-secret assets;
- deterministic fixture data explicitly intended for the current public CLI.

It excludes:

- TypeScript source unless intentionally published and reviewed;
- arbitrary test files, private fixtures, coverage, mutation output, and
  temporary snapshots;
- `.git`, editor state, shell files, `.env`, local configs, sessions, objects,
  logs, diagnostics, credentials, and cache;
- build/release credentials and workflow metadata not intended for users;
- absolute developer paths, source-map paths that expose them, or symlinks;
- native executable or lifecycle script not declared by the package ADR;
- old `guard` binary alias unless a time-bounded compatibility ADR explicitly
  adds and tests one.

Package-smoke compares the actual tar entry list, types, modes, sizes, and hashes
to this policy.

### 14.4 Archive layout

A signed archive uses a concrete name such as
`robin-v1.0.0-darwin-arm64.tar.gz` and contains one top-level directory:

```text
robin-v1.0.0-darwin-arm64/
  bin/robin
  lib/robin/
  LICENSE
  THIRD_PARTY_NOTICES
  compatibility.json
  install-manifest.json
  SHA256SUMS
```

The archive contains no mutable user data. `install-manifest.json` lists every
relative installed file, hash, mode, and destination class so uninstall can
validate ownership. Extraction rejects absolute paths, parent traversal,
duplicate entries, unexpected links, device files, excessive counts/sizes, and
hash mismatch.

### 14.5 Standalone executable decision and mechanics

Before standalone release, an ADR selects and pins the mechanism. If Node Single
Executable Applications is selected, the pipeline must:

1. bundle the exact ESM application and required assets into a deterministic
   entry artifact through a reviewed build-only tool;
2. generate the SEA preparation blob with the release Node runtime;
3. copy the exact platform Node executable from a verified official distribution;
4. inject the blob and required assets through a pinned reviewed injector;
5. remove or normalize nondeterministic build metadata where supported;
6. sign the final macOS executable and notarize the archive; sign Windows only
   after Windows support exists; publish hashes for Linux;
7. run package, provider, PTY, filesystem, session, migration, update, and
   uninstall suites against the final signed bytes;
8. record embedded Node, ICU, OpenSSL, CA, provider SDK, and native module
   versions in compatibility metadata.

If reproducible byte identity is not achievable because signing/notarization is
nondeterministic, CI records reproducible unsigned payload hash plus final signed
hash and provenance. The standalone build must not download executable code at
first run.

### 14.6 Signing, checksums, SBOM, and provenance

- Calculate checksums after final signing/notarization.
- Sign/checksum the update manifest separately from artifacts.
- Publish SBOM for each materially different artifact.
- Include license notices for every shipped dependency/runtime.
- Verify macOS signature/notarization on a clean machine before upload and again
  after download.
- Verify Linux archive checksum and executable mode after download.
- Verify npm registry provenance, tarball integrity, bin mapping, and package
  owner list.
- Store provenance with commit, tag, lockfile hash, workflow/action digests,
  runner image, build inputs, artifact hashes, and signing step identity.

## 15. Installation, First Run, Update, Rollback, Uninstall, and Purge

### 15.1 Installation guarantees

Every installer/distribution must:

- show or document exact files and destinations;
- verify package integrity/provenance through its channel;
- avoid editing shell startup files automatically;
- avoid requesting administrator rights when a user install works;
- avoid creating a daemon/service, database, container, provider request, or
  repository file during installation;
- keep executable files separate from config/data/state/cache/logs;
- leave a machine-readable install manifest for non-npm installs;
- support `robin --version`, `robin --help`, and read-only `robin doctor` before
  provider setup;
- document how to uninstall binaries without deleting user data.

### 15.2 Source installation for contributors

Source installation is the Section 4 bootstrap. A contributor may create a
temporary global link only for local development:

```bash
npm run build
npm link --workspace @zachshotamartin/robin
robin --version
```

`npm link` is not the end-user release path and may change global npm state. The
developer removes it with npm's corresponding unlink/uninstall command and
verifies which executable resolves before/after. Release docs prioritize packed
artifact tests rather than links.

### 15.3 Npm installation

After publication, the stable example is:

```bash
npm install --global @zachshotamartin/robin@1.0.0 --ignore-scripts
robin --version
robin doctor
```

The actual current version replaces `1.0.0` in release notes. Robin publishes no
required install script. Package-manager permission errors are explained; docs
do not recommend broad recursive ownership changes or running Robin as root.

An npm installation test starts from an empty user/prefix, checks which
executable resolves, invokes help/doctor/synthetic path, creates isolated test
state, uninstalls, and confirms npm-owned files are gone while user data follows
the explicit selection.

### 15.4 Archive or standalone installation

The archive workflow is:

1. Download artifact, checksum file, compatibility manifest, and signature or
   provenance from the same immutable release.
2. Verify checksum/signature before extraction.
3. Inspect supported OS/architecture and minimum requirements.
4. Extract into a new temporary directory with safe archive rules.
5. Run the extracted `robin --version` and signature/integrity self-check.
6. Copy into a user-owned versioned application directory.
7. Atomically update a user-owned `robin` launcher/symlink only after verification.
8. Store `install-manifest.json` with final paths and hashes.
9. Run `robin doctor` without provider/network mutation.

Robin does not supply a `curl | sh` installer before a signed, reviewed,
versioned installer implementation and hostile-input tests exist.

### 15.5 First run and provider onboarding

Installation does not imply configuration. Planned first run:

1. Resolve working directory and show repository/branch or non-repository mode.
2. Show local config/data/state/cache/log locations and privacy defaults.
3. Show project configuration/instruction files before requesting trust.
4. Ask for provider adapter and model or choose the deterministic synthetic
   tutorial when available.
5. For hosted provider, ask for credential source through hidden/auth-specific
   flow; never request a raw argv value.
6. Show endpoint origin, provider egress, model capability, retention behavior,
   and permission/sandbox mode.
7. Run local config/capability validation. Network credential validation is a
   separate opt-in step that sends no repository content.
8. Create owner-only global config/metadata and a local session only after the
   user submits work.
9. Display session ID, repository, model, permission mode, and achieved sandbox
   tier.

First run does not install Docker, initialize PostgreSQL, start a daemon, edit
Git ignore/config, commit code, install hooks/extensions, or make a paid model
request without explicit user action.

### 15.6 Update channels and check behavior

Channels are `stable` and `preview`. Update checks are disabled until the
network destination, signed manifest schema, retention, frequency, and user
control ship at R10. When enabled:

- check only at a documented bounded interval or explicit `robin update check`;
- send only current version, channel, OS, and architecture needed for artifact
  selection, with no repository/session/provider identifier;
- support complete disable and offline use;
- verify signed manifest, channel, version ordering, artifact hash, minimum
  schema, and rollback compatibility;
- never replace the executable during an active session;
- never run a data migration before the new artifact is fully verified and the
  rollback plan is displayed.

Npm installations are updated through npm, not a self-replacing Robin binary:

```bash
npm install --global @zachshotamartin/robin@1.0.1 --ignore-scripts
robin --version
robin doctor
```

Archive/standalone installations may use `robin update download` and
`robin update apply` only after the R10 updater gate. Apply stages a verified
version alongside the current one and atomically switches the launcher.

### 15.7 Update preflight

Before apply/migration:

1. Verify no foreground turn or child effect is active.
2. Record current binary version/hash/channel/install manifest.
3. Read target compatibility manifest and signature/hash.
4. Validate OS/architecture and required credential/sandbox backends.
5. Inventory config/session schema versions and unsupported extensions.
6. Calculate backup and temporary-space requirement.
7. Create/verify a backup when migration is destructive or rollback-sensitive.
8. Dry-run migrations and list exact sessions/configs affected.
9. Display last safe rollback point and data retained if rollback fails.
10. Require explicit confirmation for destructive migration or unsupported
    extension disablement.

Failure before launcher switch leaves the current install active. Failure after
switch invokes the documented rollback decision and preserves both artifact and
state evidence.

### 15.8 Rollback

Binary rollback is allowed only when the prior binary's compatibility manifest
can read current config/session schemas. For archive/standalone installs:

1. stop accepting new turns;
2. close/reconcile active local sessions;
3. verify the retained prior artifact/hash/install manifest;
4. verify persisted schemas are within its read/write range;
5. atomically switch launcher to the prior version;
6. run version, doctor, session read-only scan, and synthetic smoke;
7. re-enable writes only after validation.

If a migration crossed the safe rollback point, rollback restores the verified
pre-migration backup into a separate temporary root first, compares session and
object counts/hashes, then switches data roots only after explicit confirmation.
It never overwrites the only affected state during diagnosis.

Npm rollback installs the exact prior version and runs the same compatibility
preflight. Release notes name the last safe version; “install any older version”
is not a supported recovery plan.

### 15.9 Uninstall binary without deleting data

For npm:

```bash
npm uninstall --global @zachshotamartin/robin
```

For archive/standalone, the uninstall command reads the saved install manifest,
verifies each path/hash or reports user modification, removes only exact owned
binary/library files, and removes empty owned install directories. It does not
follow replaced symlinks or recursively remove an unverified prefix.

Default uninstall preserves:

- user/project configuration;
- sessions, transcripts, objects, checkpoints, and exports;
- credential metadata and OS credential entries;
- logs, diagnostics, and caches;
- repository files and `.robin` project files.

Before removing the last binary, docs explain how to export or purge data and
credentials. Package-manager uninstall cannot claim user data was removed.

### 15.10 Project purge

`robin data purge --project` is planned as a separate destructive action:

1. Resolve exact physical workspace identity.
2. Inventory sessions bound to it, durable CAS references, session-local objects,
   indexes,
   repository cache, trusted-project record, project-local Robin files, and
   active locks/background work.
3. By default exclude repository `.robin` and instruction files because they are
   user/project source; list them separately.
4. Refuse active/ambiguous sessions and ownership mismatch.
5. Show dry-run counts, bytes, paths rooted under known Robin roots, shared
   objects retained, and credential profiles unaffected.
6. Require exact project identity confirmation.
7. Delete sessions through validated exact-session deletion, rebuild indexes,
   remove project cache/trust record, and report partial failures.
8. Verify repository content and Git status are unchanged.

### 15.11 Global purge

Global purge is staged, never one broad recursive command. The dry run has
separate selections for:

- sessions and CAS objects;
- configuration and trust;
- credential metadata;
- OS credential backend entries;
- logs and crash/diagnostic bundles;
- cache and rebuildable indexes;
- backups and quarantine;
- installed extensions and their data;
- optional supervisor/service definitions if R9 introduced any.

Credential secret deletion requires a second explicit confirmation after naming
dependent profiles and warning that it cannot be undone. Encryption-key deletion
warns that retained encrypted content becomes unreadable. Each category validates
ownership and reports exact success/failure. A partial purge is resumable from a
non-secret receipt outside the removed category. Robin never targets a home,
workspace root, `/`, drive root, or unresolved environment variable recursively.

### 15.12 Backup and restore

`robin data backup` creates a versioned archive after acquiring read locks or a
consistent event-tip snapshot. It includes:

- validated config excluding raw credentials;
- trust and permission snapshots;
- session manifests, `events.rlog` files, snapshots, and durable CAS-reference
  events;
- every referenced session-local CAS object;
- migration/compatibility manifest;
- extension metadata according to selection;
- checksums and one backup ID/cutoff.

It excludes cache, rotating logs by default, raw provider credentials, OS
credential backend exports, active temp files, sockets, process handles, and
unselected diagnostic bundles.

Restore runs into a new root, validates archive traversal/limits/checksums/schema,
proves required credential/encryption backend references are available without
exporting them, rebuilds indexes, replays every session, and compares counts and
hashes. Only after validation may the user switch roots. Release qualification
restores synthetic ready, active-at-crash, failed, archived, quarantined, and
compacted sessions and proves no external effect repeats.

## 16. Diagnostics, Logs, and Support Bundles

### 16.1 Doctor contract

`robin doctor` is read-only. Each check returns:

- stable check ID and schema version;
- category and severity;
- `pass`, `warning`, `fail`, `unavailable`, or `skipped` status;
- safe observed metadata and redaction facts;
- affected Robin capability or release claim;
- exact safe next action;
- whether a separate `fix` action exists;
- elapsed time and optional timeout classification.

Human and JSON output derive from the same structured result. Doctor never
prints raw configuration, environment values, provider payloads, repository
content, credentials, session text, command output, or full personal paths by
default.

### 16.2 Doctor categories and required checks

| Category | Checks |
| --- | --- |
| `installation` | Resolved executable, package/channel/version/build ID, signature/checksum/provenance where available, install manifest, duplicate `robin` executables on PATH. |
| `host` | OS/version/architecture, Node/npm for source/npm install, locale, clock sanity, temporary directory, owner identity, supported tier. |
| `terminal` | TTY state, `$TERM` name not value dump, UTF-8 locale, columns/rows, color/hyperlink/raw/bracketed-paste capability, flat/screen-reader override, restoration probe when safe. |
| `filesystem` | Config/data/state/cache/log root resolution, ownership, mode/ACL, symlink/alias, atomic rename/flush capability, free space, filesystem/degraded-network classification. |
| `configuration` | Schema versions, unknown/invalid fields, precedence/floors, secret-shaped values, import graph, effective safe fingerprint. |
| `trust` | Physical workspace identity, trust record/material hashes, changed project settings/instructions/extensions, managed restrictions. |
| `repository` | Workspace root, Git worktree/common-dir, HEAD/branch, dirty-state summary/counts, ignored/sparse/submodule/LFS capability, no content dump. |
| `git` | Resolved Git/version, required command capability, aliases/helpers/hooks/filters/pager/signing safety summary, ownership warning, no auto-repair. |
| `sessions` | Store schema, permissions, lock/liveness, valid tip/snapshot/index, quarantine count, migration requirement, CAS ref integrity sample/full explicit mode. |
| `provider` | Adapter/model/profile/capability manifest, endpoint origin/scheme, cached metadata age; network reachability only with explicit network mode. |
| `credentials` | Metadata/backend availability/reference/origin/status; secret existence checked through broker without displaying it; network validation separate. |
| `permissions` | Mode, managed floor, policy compile/hash, bypass availability/state, sandbox requirement, stale persistent rule diagnostics. |
| `sandbox` | Backend/version, independent temporary read/write/network/process/resource probes, achieved tier, strict fallback behavior. |
| `extensions` | Skill/hook/MCP/subagent definitions, source/trust/integrity/version, executable resolution, capability changes, no start by passive doctor. |
| `update` | Channel, last check metadata, target manifest/signature/hash/compatibility only in explicit network mode, rollback artifact availability. |
| `resources` | Disk/cache/log/session/object/backup/quarantine usage, process/FD limits, configured budgets, safe cleanup candidates. |

### 16.3 Diagnostic fix actions

Fixes are separate commands and never implied by `doctor`. Each fix:

1. reruns the relevant read-only check;
2. displays exact targets and before/after values;
3. validates ownership and rejects symlinks/aliases outside the intended root;
4. obtains confirmation for mutation;
5. applies the narrow change atomically where possible;
6. reruns verification;
7. records a safe local receipt;
8. reports partial failure and rollback instructions.

Eligible fixes include rebuilding an index from valid sessions, removing a
proven dead session lock after recovery, repairing exact Robin file modes,
pruning verified cache, and selecting a valid config value. Doctor does not
automatically rewrite a corrupt event log, change global Git configuration,
install a sandbox, rotate/delete credentials, trust a workspace, delete sessions,
or replace an executable.

### 16.4 Common failure runbooks

| Failure | Read-only inspection | Safe repair path | Forbidden shortcut |
| --- | --- | --- | --- |
| Wrong `robin` executable | Resolve all PATH matches, versions, package managers, signatures/manifests. | Select/uninstall exact stale install; verify final resolution. | Deleting every similarly named file from a broad bin directory. |
| Terminal left in raw/no-echo | Exit process, use terminal/shell's documented reset locally, capture Robin version and PTY test facts. | Reproduce with synthetic session; fix lifecycle/exception path and regression test. | Reading session/provider secret data to diagnose terminal state. |
| State root unsafe | Inspect resolved path components, owner, modes/ACL, symlinks, filesystem. | Exact owner-approved permission fix on Robin-owned paths. | Recursive chmod/chown of home or repository. |
| Stale session lock | Inspect lock nonce/host/process-start and validate event tip. | Recovery command removes exact dead lock after integrity scan. | Killing/removing based only on PID or age. |
| Torn event tail | Validate every prior frame and identify exact incomplete final offset. | Backup, truncate only proven tail, append repair fact, verify replay. | Skipping a corrupt middle record or hand-editing JSON. |
| Session corruption | Verify frames/hash chain/objects/snapshots, create read-only inventory. | Quarantine, restore verified backup, or export safe readable prefix with explicit loss report. | Continuing silently with missing transcript/tool facts. |
| Disk full | Inspect exact Robin roots and safe cleanup candidates; check active temp/migration. | Prune cache/logs first, complete/rollback temp, expand disk, then retry exact operation. | Deleting sessions/objects without reference scan and confirmation. |
| Provider auth failure | Inspect adapter/profile/origin/credential metadata and safe request ID; optional explicit auth probe. | Correct profile/origin, rotate through broker, or reauthenticate. | Printing/pasting key into argv/log or disabling TLS/origin checks. |
| Provider rate/overload | Inspect attempt/retry hint/budget and provider status. | Wait bounded interval, select configured alternative between safe boundaries, or resume later. | Infinite retry or duplicate uncertain paid request. |
| Provider malformed stream | Inspect redacted frame metadata/fixture class and adapter version. | Update/fix adapter, retry only if certainty permits, preserve uncertainty. | Parsing model text as tool call fallback. |
| Sandbox unavailable | Inspect required tier/backend probes. | Install/enable supported backend externally or choose explicit best-effort/direct mode if policy permits. | Silent unsandboxed execution. |
| Patch conflict | Inspect expected/current hashes and bounded diff. | Ask model/user to reread and prepare new patch; preserve current file. | Force apply or overwrite full file without new precondition. |
| Process will not stop | Inspect owned process-group identity and cancellation facts. | Escalate through supervisor, verify descendants, mark uncertainty if identity is lost. | Broad `killall` or signaling a PID without start identity. |
| Git safety/dirty conflict | Inspect porcelain status, HEAD/common dir, helpers/hooks. | Narrow replan/stage exact paths or ask user to resolve; keep pre-existing changes. | Reset, clean, checkout overwrite, force push. |
| Credential backend unavailable | Inspect backend capability/status without reading secret. | Unlock/configure supported backend or add new credential through hidden flow. | Plaintext config fallback. |
| Extension/MCP failure | Inspect pinned identity/version/config, bounded logs, child status. | Disable exact extension for next snapshot, fix/update, resume core session. | Grant broader permissions or expose credential for convenience. |
| Update/migration failure | Inspect current/target binary hashes, schema/cursor/backup, install manifest. | Resume idempotent migration or restore/switch according to safe rollback point. | Overwrite only data copy or downgrade incompatible binary. |

### 16.5 Structured logs

Logs are local, structured, bounded, and off the critical authority path. A log
record includes safe schema/version, severity, category, timestamp, build,
session/turn/tool/provider IDs when applicable, stable diagnostic code, safe
fields, and redaction summary. It never includes raw credentials, authorization
headers, complete provider payloads, repository content, full patch/process
output, opaque provider items, hook/MCP frames, or environment dumps.

Default rotation is 20 MiB per file, five files, and 14 days, whichever removes
an entry first. Debug logging is time-bounded or explicit, follows the same
redaction, and warns that safe metadata volume increases. Logging failure does
not authorize an action or turn a failed durability append into success.

### 16.6 Diagnostic bundle construction

`robin support bundle --dry-run` performs the mandatory preview. A subsequent
confirmed `robin support bundle` performs the explicit owner-private archive
write only when its reviewed dry-run manifest still matches. The workflow is:

1. Enumerate candidate files/fields with category, bytes, source, and inclusion
   reason.
2. Exclude repository content, transcript text, provider bodies, patches,
   command output, raw config, credentials, OS keychain, backups, and arbitrary
   logs by default.
3. Convert included data to bounded versioned safe structures.
4. Redact using the same boundary as normal output plus generated canaries.
5. Scan final bytes for configured secret/canary patterns and absolute personal
   paths.
6. Show manifest and size before writing.
7. Write to an exact user-selected file through temp/flush/rename.
8. Emit checksum and remind the user to inspect before sharing.

The bundle contains its schema, Robin build, compatibility/doctor summaries,
safe error codes, redacted log subset, session IDs hashed with a bundle-local
salt, migration state, package inventory, and inclusion manifest. Upload is not
automatic.

### 16.7 Diagnostic bundle release test

Seed canaries in credential backend, config, environment, repository content,
path names, provider request/error, assistant text, patch, process stdout/stderr,
Git remote, hook, MCP, subagent result, event object, log, and crash report.
Generate every bundle option. The byte scan must find zero forbidden raw,
encoded, split, escaped, or normalized canary occurrences. The manifest must
prove excluded categories and the bundle must remain parseable without Robin.

## 17. Privacy, Retention, Export, and Deletion

### 17.1 Data classes and defaults

| Data class | Location | May contain source/personal data | Default retention | Deletion/egress rule |
| --- | --- | --- | --- | --- |
| User/project configuration | Config root and repository | Instructions, paths, names; never raw provider key | Until user edits/deletes | Local only unless user exports; project files follow Git/user ownership. |
| Credential metadata | Config root | Provider/profile names and redacted fingerprint | Until credential metadata removal | Local; secret backend deletion is separate exact action. |
| Credential secret | OS credential backend | Raw provider token/key | Until rotation/removal/backend policy | Resolved only for exact allowed transport; never normal export/backup. |
| Session event metadata | Data root | Prompts/tool facts may contain source-derived metadata | Until session deletion/archive policy | Local; export is explicit/redacted; provider receives only selected context. |
| Session text/provider items | Session-local CAS and durable event references | Conversation/source content, opaque provider data | Until session deletion or configured transcript period needed for resume | Local encrypted-at-rest option when implemented; selected content sent only to chosen provider. |
| Repository attachments/reads | CAS when retained | Source/code | Until session deletion or shorter content-retention rule | Every provider egress attributable; separately purgeable from metadata where schema permits. |
| Patches/checkpoints/diffs | Session-local CAS, durable events, and repository | Source/code | Until session deletion; checkpoints may use bounded count/age | Never deleted from repository by session purge; CAS copies follow durable event/snapshot references. |
| Process output | Session-local CAS and durable events | Source, paths, test/user data | 30 days after terminal turn by default unless required for active resume/evidence; safe metadata retained with session | Independently configurable; provider release separately bounded. |
| Git/hosting metadata | Durable events | Branch/remotes/commit/PR metadata | Until session deletion | Remote mutation only by explicit approved tool. |
| Operational logs | Logs root | Safe metadata, IDs, paths redacted/shortened | 14 days, 5 files, 20 MiB each | No automatic upload; bundle selects redacted subset. |
| Crash reports | State root | Safe stack/build metadata; must exclude secrets/source | 7 days by default | Local/manual bundle only. |
| Diagnostics bundles | User-selected/state root | Reviewed redacted operational metadata | Until user deletes; doctor warns after 7 days | Never automatic upload. |
| Cache/indexes | Cache/state roots | Provider/model metadata and repository/session lookup metadata | 30 days or 500 MiB default; rebuildable | Local; safe to prune after ownership check. |
| Update metadata/artifacts | Cache/install root | Version/OS/arch/channel | 30 days; current plus prior rollback artifact during window | Network only to disclosed update origin; artifact signed/hashed. |
| Backups | Data root or user-selected | Selected session/config content | Explicit user policy; no automatic expiry without warning | No raw credential; deletion requires exact backup confirmation. |
| Quarantine | Data root | Corrupt session/object content | 30 days with warnings; no auto-delete while sole recovery copy | Never provider/upload; purge exact after inventory. |
| Extension data | Config/data/cache | Tool-specific data/source | Per extension plus global maximum; displayed on install/remove | Separate egress principal; purge inventory exact. |
| Telemetry | None in initial releases | None | None | Off/absent until separate schema, destination, consent, retention, and opt-out gate. |

Denied secret content is not retained as source bytes. Credential values exist
only in the selected credential backend and exact outgoing auth field. Provider
storage/caching controls are set to the strongest supported declared mode and
the achieved provider-side retention claim is shown; Robin cannot delete data a
provider retains outside its contract.

### 17.2 Retention configuration

Retention is independently configurable for:

- conversation/transcript content;
- provider exact/opaque items;
- repository attachments/read content;
- process output;
- patches/diffs/checkpoints;
- operational logs and crash reports;
- cache/indexes/update artifacts;
- diagnostics bundles;
- extension data;
- backups and quarantine.

A shorter retention that would make a session non-resumable shows the exact
loss before acceptance and records the evidence mode. Managed policy may impose
a maximum or minimum for organizational evidence, but project config cannot
silently lengthen global source retention. Expiration jobs validate references
and ownership and report bytes/objects removed; they never run while an object
is actively written/migrated.

### 17.3 Export

Session export supports human Markdown/text and versioned machine JSON/JSONL.
It:

- identifies session/workspace safely, schema, time range, provider/model,
  permission mode, and verification outcome;
- preserves turn/tool/result ordering and explicit omissions;
- labels redacted, expired, encrypted-unavailable, binary, truncated, corrupt,
  and unsupported content;
- omits credential bytes, auth headers, backend handles, hidden reasoning,
  raw debug objects, and unsafe opaque provider items;
- does not call a provider, execute a tool, reactivate an extension, or alter
  retention;
- writes only after path/overwrite confirmation and final byte scan.

### 17.4 Session deletion

Session delete begins with dry-run inventory of manifest, `events.rlog`,
snapshots, durable CAS references, session-local CAS objects, indexes,
`writer.lock`, backups, exports, background handles, and workspace
relationship. It refuses an active or integrity-ambiguous session unless the
user first completes the named recovery/cancellation path.

Deletion removes exact session-owned authority, then garbage-collects objects
only after validated reference scan and safety age. It never deletes repository
files, Git refs/commits, provider data, credential records, another session's
objects, unrelated sessions, or a whole project directory. Partial failure returns a
receipt and next exact retry; it does not claim success based only on manifest
removal.

### 17.5 Privacy verification

Every release runs:

- whole-surface canary scan from Section 11;
- provider request/resource-manifest attribution comparison;
- child/hook/MCP/subagent environment and mount inventory;
- support/export/backup/package archive scan;
- retention expiry/reference integrity test;
- project/global purge with before/after repository and state manifests;
- passive network audit proving no telemetry/update/provider/MCP contact without
  explicit configured action;
- provider-side storage-control fixture and documented limitation review.

## 18. Incident Response and Release Revocation

### 18.1 Severity

| Severity | Examples | Response target |
| --- | --- | --- |
| Critical | Credential exfiltration; unauthorized host/repository mutation outside approved scope; sandbox escape contradicting released strict claim; updater/package compromise; cross-user session disclosure. | Stop affected release/capability immediately; begin containment and credential/artifact revocation; no public distribution remains recommended. |
| High | Permission bypass for consequential action; stale approval replay; session corruption causing duplicated effect; extension/subagent cross-scope access; remote Git action without exact approval. | Disable affected path/channel, produce deterministic reproduction/fix, block release, notify affected users promptly after scope is known. |
| Medium | Source/metadata retained beyond policy; diagnostic/audit omission; cancellation leaves bounded orphan requiring manual cleanup; provider compatibility claim inaccurate without proven exfiltration. | Triage, issue fixed release, correct docs/evidence, and add regression before next release. |
| Low | Non-security UX defect, incomplete safe diagnostic, performance regression without reliability loss. | Normal issue/release process with test and release-note impact. |

### 18.2 Response sequence

1. **Contain:** disable provider adapter, tool, sandbox tier, extension, updater,
   or release channel at the narrowest effective boundary. Deprecate compromised
   npm version and remove update recommendation without moving tags.
2. **Preserve safe evidence:** record release hash, compatibility manifest,
   normalized event IDs, safe logs, artifact hashes, configuration fingerprints,
   provider request IDs, and affected schema. Do not collect raw user source or
   secrets unnecessarily.
3. **Protect credentials:** tell affected users which credential/endpoint may be
   exposed; revoke/rotate through provider/OS store; rotate signing/publish/Git
   credentials if supply chain is involved.
4. **Scope:** determine versions, platforms, adapters, tools, permission modes,
   data classes, and evidence/claim affected. Distinguish possible from confirmed
   effect.
5. **Reproduce:** create a synthetic minimized fixture and verify failure on the
   affected commit without using user data.
6. **Fix:** repair the owning boundary, add deterministic regression and adjacent
   class tests, run complete relevant matrix and mutation set.
7. **Recover:** provide exact workspace/session/credential/package inspection,
   cleanup, rollback, or migration instructions that preserve user changes.
8. **Release/advisory:** ship new immutable patch, checksums/provenance, affected
   ranges, severity, safe mitigations, residual risk, and credit/disclosure policy.
9. **Postmortem:** document timeline, root cause, failed invariant, test/evidence
   gap, corrective actions/owners/deadlines, and whether product claims changed.

Robin has no mandatory telemetry or central service, so the project cannot
assume it knows affected installations. Advisories use repository/security/npm
release channels and avoid claiming automatic remediation.

### 18.3 Boundary-specific containment

- **Credential leak:** stop adapter/transport path, revoke exact keys, scan logs,
  provider request records, diagnostics, packages, CI artifacts, and child
  environments; do not publish the leaked value as evidence.
- **Unauthorized file/Git mutation:** stop mutating tools, snapshot status/hashes,
  identify exact Robin versus user/unknown deltas, provide non-destructive
  recovery; never auto-reset.
- **Sandbox escape:** withdraw the backend/tier claim, stop hostile runner,
  preserve host-independent evidence, rotate any runner credentials even when
  none were expected, rebuild disposable workers.
- **Session corruption/duplicate effect:** switch affected sessions read-only,
  quarantine state, reconcile external effects, validate backup/restore, fix
  frame/migration/retry boundary.
- **Provider egress error:** stop provider sends, compare released-resource
  manifests with captures/request IDs, disclose affected content categories,
  correct context/adapter/redaction path.
- **Package/update compromise:** revoke signing/publish credentials, deprecate
  versions, freeze update manifest, publish known-good hashes, validate clean
  rebuild, and require user reinstall/credential rotation as scope dictates.
- **Extension/MCP/subagent escape:** disable exact extension identity/version,
  revoke project trust where needed, terminate children/servers, inspect released
  resources and effects, keep core sessions read-only/recoverable.

### 18.4 Incident evidence rule

Public reports contain synthetic reproductions, hashes, safe metadata, and
bounded excerpts only when necessary. They do not include a user's repository,
prompt, transcript, provider key, personal path, remote URL credential, or full
command output. The regression fixture records the incident ID and remains in
the permanent suite.

## 19. Release Gates R0–R12

The build plan defines feature work. This section defines the operational and
evidence closure for each gate. A later gate inherits every earlier regression,
installation, migration, privacy, and claim constraint.

### 19.1 R0 — Robin identity and clean substrate baseline

R0 passes when:

- GitHub repository/local folder/origin are Robin and the protected working
  branch preserves the accepted main baseline;
- root package and CLI package describe Robin; bin mapping is exactly `robin`;
- help/version/error/rendered public strings use Robin and load no provider,
  repository, session, credential, or terminal-raw-mode subsystem;
- current deterministic `robin run` and `robin policy` commands remain truthful;
- README/product/build/architecture/operations/ADR source-of-truth order is
  coding-agent-first and planned features are labeled;
- package smoke installs the tarball and executes `robin --version` directly;
- Gate A/B deterministic evidence still passes without changing historical
  semantic fixtures unintentionally;
- Milestone C WIP remains archived/non-merge-ready and supplies no release claim;
- no public package is published and no user-data migration is claimed;
- `docs-policy`, `static`, `unit-contract`, and `package-smoke` evidence from one
  commit is attached to the R0 record.

R0 does not require or claim an interactive agent, local session store, real
repository tools, provider/API key, sandbox, daemon, database, or editor.

### 19.2 R1 — Interactive synthetic coding-agent loop

R1 passes when:

- `robin` and initial prompt start one interactive terminal application with the
  deterministic synthetic provider and normalized coding-agent loop;
- terminal reducer, renderer, input editor, streaming, queued steering,
  cancellation, raw-mode restoration, flat mode, and headless separation pass
  TERM/PTy matrices on Tier 1 platforms assigned to the gate;
- text/tool/malformed/retry/cancel/budget/context paths use synthetic provider
  scripts and complete tool calls remain inert until normalized;
- one application service owns interactive and headless loop semantics;
- ephemeral/in-process session facts are replayable for the running process;
- npm tarball PTY install/execute/uninstall works from a path with spaces/Unicode;
- help/version remain cold and current README says sessions/providers/real tools
  are not yet complete;
- performance budgets for help, prompt, input, render, and interrupt pass;
- required evidence includes `unit-contract`, `pty-linux`, macOS PTY release run,
  `package-smoke`, UNIT/TERM/PTY/PROV-R1 rows, and synthetic e2e E2E-001.

R1 requires no API key, network provider, real workspace mutation, sandbox,
database, or daemon.

### 19.3 R2 — Real repository coding tools

R2 passes when:

- physical workspace/Git identity and path containment are enforced;
- bounded list/search/read, structural create/modify patch, atomic create/modify,
  direct argument-vector process, verification, Git status/diff, and
  changed-path evidence operate in temporary real repositories;
- delete, move/rename, full-file replace, multi-file batch, checkpoint, rewind,
  explicit shell, background process, Git write, and remote Git operations are
  absent or registered as denied according to their later owning gates;
- initial user changes are snapshotted and remain preserved/attributed correctly;
- every edit/process has exact precondition, permission action, result, output
  bound, cancellation, and workspace rescan;
- symlink/hard-link/case/Unicode/TOCTOU/disk/error/process-tree/output/Git parser
  matrices pass on Tier 1 filesystem behavior;
- no ordinary workflow uses reset/clean/checkout overwrite or shell parsing for
  direct execution;
- direct process mode clearly claims no filesystem/network isolation;
- repository startup/search/edit/process budgets pass;
- `repository-tools`, relevant macOS integration, fuzz/mutation critical subsets,
  SEC-012's R2 hostile-repository boundary, and E2E-002 provide evidence.

R2 still requires no hosted provider, credential, strict sandbox, database, or
daemon.

### 19.4 R3 — Local file-backed sessions, continue, and recovery

R3 passes when:

- Section 8 framed journal, single-writer lock, CAS, snapshots, indexes, owner
  permissions, tail repair, quarantine, and schema migration origin are
  implemented;
- the versioned prompt/context compiler, context inspection, safe-boundary
  compaction, typed summary validation, and compacted-session resume behavior
  pass CTX-001 and CTX-005–010 at R3's provider-neutral boundary;
- accepted user input is durable before provider loop consumption;
- `--continue`, `--resume`, session list/inspect/rename/export/archive/delete, and
  safe branch/fork semantics operate without a provider;
- every SES/EDIT/PROC/GIT crash point assigned through R3 reaches its exact
  oracle; R6 batch/checkpoint/rewind crash points are not pulled into R3;
- session replay invokes no provider/tool/process/Git/credential/extension effect;
- workspace drift invalidates pending consequential actions and approvals;
- disk-full, corruption, lock ambiguity, index rebuild, backup/restore, migration
  interruption, and rollback-compatible read tests pass;
- session append/reopen/replay/CAS/memory/disk budgets pass;
- package update/uninstall tests prove user data separation;
- `session-recovery`, Tier 1 filesystem matrix, E2E-003, and trace evidence are
  green from one commit.

Local R3 uses files only. PostgreSQL and a resident daemon are explicitly not
introduced.

### 19.5 R4 — First hosted provider and BYOK alpha

R4 passes when:

- `packages/provider-openai` supplies the first production direct-provider
  adapter for the OpenAI Responses API through a reviewed, pinned official
  OpenAI JavaScript SDK; it owns a fully normalized abortable stream and passes
  every R4-assigned common and OpenAI-dialect PROV row;
- `robin auth add|list|inspect|validate|remove` and
  `robin models list|inspect` are the only provider/model/credential command
  groups introduced for the hosted alpha; R7 stabilizes them across additional
  adapters without adding a competing provider-command family;
- hidden one-time credential input and exact named environment-variable import,
  exact origin binding, validation, redacted metadata, provider injection, and
  in-memory/session-lifetime removal baseline pass;
- persistent macOS Keychain/Secret Service storage, credential rotation, generic
  compatible endpoints, and no-key local endpoints remain R7 work;
- arbitrary key/model/endpoint compatibility is not claimed; selected model
  capability validation occurs before source egress;
- provider attempts/retries/uncertainty/usage/cost/storage/cancellation and
  continuation items are durable and session-resumable according to contract;
- exact provider request capture contains only released resources and no
  credential canary outside auth transport;
- real-provider tests use protected fixed public fixture and hard spend limits;
- no provider secret reaches child command/hook/diagnostic/package/CI artifact;
- provider throughput/context/cancellation budgets pass;
- `provider-contract`, `credential-redaction`, E2E-004, LIVE-001/002/004/005,
  redaction scan, and clean-machine BYOK onboarding evidence are accepted.

R4 remains a local process/file-store product and requires no daemon, database,
or Docker.

### 19.6 R5 — Permissions and supported command sandbox

R5 passes when:

- the exact `default|plan|accept-edits|locked|bypass` permission enum and
  `deny > ask > allow` precedence pass all permission rows;
- `headless` is tested as an invocation surface using those modes, not as a
  permission mode; the current preview spelling `ask` has a documented migration
  to target `default` and is absent from the stable enum;
- approval UI exposes exact action/preconditions/risk/sandbox and prevents stale,
  cross-scope, duplicate, forged, or model-generated decisions;
- handler receives only the immutable normalized object evaluated/approved;
- at least one Tier 1 platform sandbox backend passes independent hostile
  filesystem/network/process/resource evidence;
- strict mode blocks on unavailable/partial backend and direct/best-effort mode
  labels its weaker claim;
- credential/session/global state and Git common directory are absent from child
  sandbox access according to achieved tier;
- critical permission/path/process/sandbox mutation set meets its threshold;
- `permission-direct`, appropriate `sandbox-linux`/macOS backend job, E2E-005,
  policy corpus simulation, and canary evidence are attached.

R5 does not make every supported OS sandbox-equivalent; compatibility manifest
names exact backend/tier per platform.

### 19.7 R6 — Safe daily Git workflow

R6 passes when:

- distinct full-file replace, delete, move/rename, multi-file batch, checkpoint,
  and rewind tools pass atomicity, precondition, durable journal, crash recovery,
  external-drift, and cumulative-diff evidence;
- exact staging, commit, branch, remote/ref, optional push, and PR preparation or
  supported creation use structured Git/host adapters and explicit authority;
- user/staged/untracked changes remain separate and approval rechecks index,
  worktree, HEAD, remote, refspec, hook, signing, and credential conditions;
- destructive/history-rewriting actions remain denied by default and cannot be
  enabled by project/model content;
- commit/hook/signing/push/PR success, rejection, uncertain network, and crash
  recovery matrices pass;
- remote credentials/embedded URL secrets are handled by Git/host credential
  boundary and absent from output/events;
- successful local commit never implies push/PR authority;
- E2E-006 and GIT-005–020 evidence pass on Tier 1 hosts/synthetic remotes.

### 19.8 R7 — Multi-provider conformance and stable automation beta

R7 passes when:

- required provider families, including the named generic-compatible dialect,
  pass shared and provider-specific synthetic conformance;
- persistent OS credential backends, atomic rotation/removal, and registered
  generic-compatible/local no-key endpoint profiles pass CRED/PROV conformance;
- `robin models` and `robin auth` are the only stable provider/model and
  credential command families;
- model/capability/alias/profile/credential switch rules and adapter update
  compatibility are versioned;
- `--print`, target `--output`, target `--no-session`, final JSON, JSONL stream,
  bounded stdin, fixed automation namespace, permission callback, exit codes,
  and schemas are stable; preview `--output-format`/`--no-save` migration and
  rejection/compatibility behavior are tested explicitly;
- compaction/context inspection and long-session provider continuation pass;
- provider/profile/credential rotation/removal/migration workflows pass on clean
  machines;
- no ordinary automated test needs a live key and live thresholds remain
  protected/statistically reviewed;
- provider and headless performance budgets meet targets;
- E2E-007/008 and LIVE R7 rows, `node-os-matrix`, full provider contract, and
  automation compatibility fixtures form evidence.

### 19.9 R8 — Instructions, skills, hooks, and MCP

R8 passes when:

- the complete defaults/managed/user/project/local-project/environment/explicit-
  file/CLI configuration precedence, source eligibility, atomic writes,
  `robin config explain`, trust activation/revocation, `ROBIN.md`/compatible
  `AGENTS.md`, path scopes, imports, and material-change invalidation are
  complete;
- skills lazy-load only trusted bounded content/resources;
- hooks use framed bounded supervised execution and cannot forge authority;
- MCP transports, capability snapshots, framing, lifecycle, tool mapping,
  network/origin/credential, and hostile protocol tests pass;
- project extensions cannot self-trust/self-approve or access provider
  credentials/global sessions outside release;
- extension install/update/remove/rollback and data purge are documented/tested;
- core coding session works with every extension class disabled;
- `extension-contract`, E2E-009, EXT-001–010/017–020, trust and redaction evidence
  are green.

### 19.10 R9 — Subagents, isolated worktrees, and optional background supervision

R9 passes when:

- subagent identity/model/prompt/tools/permissions/context/budget/concurrency/
  worktree/result contracts are versioned and enforced;
- child cannot widen or recursively delegate beyond explicit allowlist;
- parallel mutable work uses proven distinct Git worktrees or serialization;
- parent/child cancellation, crash, recovery, result validation, and context
  import pass;
- worktree creation/ownership/retention/cleanup never deletes an unproven path or
  changes the original checkout;
- optional background supervisor has authenticated local session lease, process
  lifecycle, logs, update compatibility, uninstall, and recovery evidence;
- ordinary foreground Robin remains fully usable with supervisor absent;
- `subagent-worktree`, E2E-010, EXT-011–016, process background, crash, and leak
  evidence pass.

R9 does not require installing a resident service for normal CLI use.

### 19.11 R10 — Robin 1.0 operations, distribution, and evidence

R10 passes when:

- all intended 1.0 features and inherited regression matrices pass on every Tier
  1 OS/arch/Node/Git/terminal cell;
- npm stable package plus selected signed archive/standalone artifacts pass
  clean build, file allowlist, SBOM, provenance, signing/notarization, download,
  install, first run, provider task, update, rollback, uninstall, and purge;
- session/config/credential/extension schema migrations pass from every supported
  origin with interruption and safe rollback evidence;
- doctor, logs, support bundle, backup/restore, retention/expiry, export, project
  purge, global purge, and incident/revocation procedures pass;
- performance-full budgets and eight-hour leak test pass on reference Tier 1
  machines;
- threat model has no unresolved critical/high finding for shipped surfaces;
- live-provider release suite stays within spend and redaction limits;
- compatibility manifest and requirement trace are complete/current;
- user/provider/extension/contributor/security/operations docs are complete and
  current-versus-planned honest;
- E2E-011 and `release-candidate` evidence from the exact tag are approved before
  publish jobs run.

Robin 1.0 remains installable and usable locally without PostgreSQL, Docker,
Podman, a daemon, or an editor.

### 19.12 R11 — Stable local client protocol and editor prototype

R11 passes when:

- a versioned authenticated local protocol exposes session queries, prompt
  submission, normalized event cursor, approvals, cancellation, artifacts, and
  diff context without exposing credential/session-store internals;
- protocol negotiation, duplicate delivery, reconnect, backpressure, client
  crash, engine crash, stale approval, frame bounds, local peer identity, and
  update compatibility pass;
- interactive/headless CLI and editor prototype use the same application/session
  services, agent loop, tools, permissions, and store;
- CLI remains capable of ordinary foreground operation without editor/protocol
  service installation;
- selected context and virtual diff reads use exact bounded protocol resources;
- E2E-012 proves one session and one authority path;
- measured extension limitations, performance, accessibility, distribution, and
  security evidence inform the extension-versus-fork decision.

R11 is post-1.0 and does not itself authorize a Code-OSS fork.

### 19.13 R12 — Selected editor client release

R12 passes when:

- accepted R11 decision selects an extension or separately justified fork and
  records maintenance/security cost;
- editor package has exact engine/protocol compatibility, signed marketplace or
  archive provenance, clean-profile install/update/rollback/uninstall, and
  trusted/untrusted workspace tests;
- selected-context, inline/native diff, prompt, timeline, approval, cancellation,
  session resume, and diagnostics consume the local protocol;
- webview CSP/message validation, URI/path bounds, workspace trust, credential
  absence, extension storage, telemetry disclosure, and accessibility pass;
- editor cannot execute tools or decide permission independently;
- disabling/uninstalling editor leaves Robin CLI sessions intact and purge
  remains separate;
- E2E-013 and editor threat/compatibility/performance evidence pass on supported
  editor versions;
- public docs state whether a fork was rejected or chosen and why.

## 20. Requirement-to-Evidence Traceability

### 20.1 Literal product-requirement map

The tables below are the auditable requirement registry for this plan. They list
all **213 unique** normative IDs in `PRODUCT_REQUIREMENTS.md`; no future registry
is needed to discover whether an ID has a test and evidence owner. “Terminal
gate” is the gate that closes the complete requirement for its applicable
surface. Earlier gates may exercise a subset exactly as described in the build
plan. Named tests resolve to Section 11, and named jobs resolve to Section 12.2.

When `evidence/requirements.json` is implemented, it is a machine-readable mirror
of these rows, not a replacement for them. Its validator must prove a bijection
with this literal set, reject duplicates/omissions, and resolve every test/job in
the same commit's gate evidence manifest.

#### CLI bootstrap and terminal lifecycle

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-CLI-001` | R1 | PTY-001, E2E-001 | `pty-linux` and `package-smoke`: packed no-argument launch enters one interactive synthetic session. |
| `FR-CLI-002` | R1 | PTY-002, E2E-001 | `pty-linux`: positional prompt and follow-up share one ordered session. |
| `FR-CLI-003` | R7 | UNIT-001, PTY-011, E2E-007 | `unit-contract` and `node-os-matrix`: bounded stdin is a distinct attachment and conflicts fail before initialization. |
| `FR-CLI-004` | R10 | UNIT-001, SEC-001 | `unit-contract` establishes the R0 side-effect-free parser corpus; `release-candidate` closes it over every R10 administrative option with duplicate/conflict/oversize coverage. |
| `FR-CLI-005` | R1 | UNIT-001 | `unit-contract`: R0 reserves command parsing and R1 closes prompt-versus-command behavior; close misses fail before workspace/provider construction. |
| `FR-CLI-006` | R10 | UNIT-001, PTY-014 | R0 establishes cold help/version; `package-smoke` and `release-candidate` close installed help/version/completion/schema snapshots for the full command tree. |
| `FR-CLI-007` | R1 | TERM-011, PTY-003, PTY-005, PTY-015 | `pty-linux` plus macOS PTY evidence: capability, width, Unicode, and reduced-motion cells pass. |
| `FR-CLI-008` | R2 | TERM-009, PTY-006, PTY-007 | `pty-linux` and `repository-tools`: first/second interrupt propagation and descendant cleanup are proven. |
| `FR-CLI-009` | R3 | PTY-009, SES-009 | `session-recovery`: SIGTERM restores terminal/process state and resumes without fabricated success. |
| `FR-CLI-010` | R1 | TERM-013, PTY-010, PTY-012 | `pty-linux`: raw mode, cursor, styles, and paste state match pre-launch state on every exit path. |
| `FR-CLI-011` | R7 | TERM-012, PTY-011, E2E-007 | `node-os-matrix`: machine stdout parses with no ANSI or human diagnostics. |
| `FR-CLI-012` | R10 | UNIT-016, E2E-007 | R7 freezes machine exit semantics; `release-candidate` closes stable mappings over every R10 lifecycle/admin result. |

#### Interactive input and rendering

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-UI-001` | R1 | TERM-001, TERM-002, TERM-003, PTY-003, PTY-004 | `pty-linux`: grapheme editing, history, paste, and submit semantics pass under a real PTY. |
| `FR-UI-002` | R1 | TERM-004, PTY-003, PTY-005 | `pty-linux` plus macOS PTY evidence: resize and wide/combining cursor positions match the virtual-screen oracle. |
| `FR-UI-003` | R2 | TERM-005, TERM-006, PROV-001, E2E-002 | `repository-tools`: normalized assistant deltas and real tool/process activity are visible and ordered. |
| `FR-UI-004` | R2 | TERM-006, PROC-005, PROC-006 | `repository-tools`: flood output remains bounded, expandable by reference, and responsive. |
| `FR-UI-005` | R5 | TERM-006, SES-018, PROV-022, PERM-002 | `permission-direct`: status derives repository/session/provider/model/mode/budget/change facts from state. |
| `FR-UI-006` | R8 | TERM-014, EXT-001, EXT-002 | `extension-contract`: slash dispatch and at-resource/skill resolution retain exact provenance. |
| `FR-UI-007` | R1 | UNIT-004, TERM-006, TERM-009 | `pty-linux`: queued prompts are visible, bounded, and submitted in deterministic order. |
| `FR-UI-008` | R2 | TERM-009, PTY-006, PTY-007, PROC-008 | `repository-tools`: model/tool/process cancellation settles before later mutation. |
| `FR-UI-009` | R1 | TERM-011, PTY-011, PTY-015 | `pty-linux`: flat screen-reader flow is complete without cursor addressing. |
| `FR-UI-010` | R5 | TERM-007, TERM-011, PTY-015 | `permission-direct`: permission/error/diff state remains explicit with no color or symbol dependence. |
| `FR-UI-011` | R11 | UNIT-018, TERM-016, E2E-012 | R11 protocol evidence: terminal/headless/editor renderers consume events and have no enforcement imports. |
| `FR-UI-012` | R10 | UNIT-015, TERM-012, CRED-012 | R4 establishes provider-view redaction; `credential-redaction` plus R10 log/doctor/support evidence closes every rendered surface with zero forbidden occurrences. |

#### Sessions and conversation

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-SES-001` | R3 | SES-001, UNIT-002 | `session-recovery`: opaque identity, name, workspace, and configuration replay exactly. |
| `FR-SES-002` | R3 | SES-002, E2E-003 | `session-recovery`: kill-after-submit proves the user event commits before provider consumption. |
| `FR-SES-003` | R4 | SES-006, SES-007, SES-008, CRED-008 | `provider-contract` plus `session-recovery`: normalized assistant/tool/approval/usage facts survive replay/export. |
| `FR-SES-004` | R3 | SES-014, E2E-003 | `session-recovery`: continue selects only the newest canonical-workspace-eligible session. |
| `FR-SES-005` | R3 | SES-015, SES-016 | `session-recovery`: unique names, ambiguity, rename atomicity, and rebuilt index behavior match. |
| `FR-SES-006` | R6 | SES-017, EDIT-013 | R3 establishes safe session branching; R6 closes branch/checkpoint interaction with immutable ancestry and exact durable boundaries. |
| `FR-SES-007` | R3 | SES-016 | `session-recovery`: list/inspect/rename/export/archive/delete work without a provider in human and JSON forms. |
| `FR-SES-008` | R10 | SES-024, E2E-011 | R3 establishes exact session deletion; `release-candidate` closes retention, recoverable trash, purge, and lifecycle integration over session-owned authority and CAS. |
| `FR-SES-009` | R3 | SES-018, E2E-003 | `session-recovery`: branch/HEAD/index/worktree/config drift is classified before provider/effect. |
| `FR-SES-010` | R3 | SES-003, SES-020 | `session-recovery`: torn-tail repair, middle quarantine, and invalid-snapshot fallback preserve the last proven tip. |
| `FR-SES-011` | R3 | SES-003, SES-011, SES-012, SES-019 | `session-recovery`: every short-write/flush/rename/crash point yields only a documented projection. |
| `FR-SES-012` | R10 | SES-016, CRED-012, E2E-011 | R3 establishes versioned export; R10 support/export evidence closes all omission, uncertainty, and redaction views with zero forbidden bytes. |

#### Direct-model agent loop

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-AGT-001` | R7 | UNIT-004, PROV-018, E2E-008 | cross-adapter evidence: one `robin-agent` coordinator drives synthetic and every released provider/surface. |
| `FR-AGT-002` | R3 | UNIT-004, SEC-002 | `unit-contract` and `session-recovery`: complete legal/illegal turn transition and replay corpus passes. |
| `FR-AGT-003` | R5 | UNIT-017, PROV-002, PERM-001 | `permission-direct`: only sealed, schema-valid calls reach the permission pipeline. |
| `FR-AGT-004` | R5 | UNIT-017, PROV-004, PERM-001 | `permission-direct`: duplicate IDs, malformed args, and unknown tool/version execute nothing. |
| `FR-AGT-005` | R9 | PROV-003, EDIT-018, EXT-014 | R1 establishes serial tool execution; `subagent-worktree` closes the requirement when R9 scheduling proves any concurrency is side-effect/workspace safe. |
| `FR-AGT-006` | R7 | UNIT-006, PROV-009, SES-019 | R1 establishes core limits, R4 adds usage/cost, and R7 closes provider-aware turn/request/tool/time/token/cost/output limits before the next operation. |
| `FR-AGT-007` | R4 | TERM-009, PTY-006, PTY-007, PROV-010 | `provider-contract` and `repository-tools`: cancellation propagates and each adapter records settlement. |
| `FR-AGT-008` | R7 | PROV-007, PROV-009, SES-006, LIVE-003 | provider conformance/live evidence: retry is classification- and certainty-bound with visible attempts. |
| `FR-AGT-009` | R6 | UNIT-018, EDIT-020, E2E-006 | daily-workflow evidence: assistant prose is separate from edit/test/task facts. |
| `FR-AGT-010` | R2 | PROV-001, PROV-002, PROV-003, PROV-004, E2E-001, E2E-002 | R1 establishes the scripted loop; R2 closes deterministic real repository/read/edit/process/verification tool integration. |
| `FR-AGT-011` | R3 | UNIT-004, SEC-002, SES-025 | `session-recovery`: events contain observable facts and replay hashes, never hidden-reasoning claims. |
| `FR-AGT-012` | R7 | PROV-018, E2E-008 | cross-adapter evidence: versioned loop replacement preserves client/tool/session semantics. |

#### Prompt and context

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-CTX-001` | R3 | CTX-001, CTX-015 | `session-recovery`: versioned role/order semantic goldens and restart fingerprints match. |
| `FR-CTX-002` | R8 | CTX-001, CTX-013, CONF-007 | `extension-contract`: source/trust labels prevent repository/config text from becoming product authority. |
| `FR-CTX-003` | R3 | CTX-002, FS-005, CTX-015 | R2 proves bounded repository discovery; R3 closes the versioned prompt compiler with no whole-repository read. |
| `FR-CTX-004` | R3 | CTX-003, FS-015, CTX-015 | R2 establishes explicit release records; R3 closes provider-neutral context assembly so only those records enter request bytes. |
| `FR-CTX-005` | R3 | CTX-003, CTX-010 | `session-recovery`: every context item carries canonical identity/version/hash/range/transformation/provenance. |
| `FR-CTX-006` | R2 | FS-009, FS-013, FS-015, CTX-002 | `repository-tools`: binary/generated/ignored/oversize/secret resources are withheld with reason. |
| `FR-CTX-007` | R7 | UNIT-014, CTX-005, CTX-016 | R3 establishes accounting and R4 the first model profile; R7 closes provider-specific reserve, safety, and hard-window behavior across released adapters. |
| `FR-CTX-008` | R7 | CTX-006, CTX-007, CTX-008, CTX-009, PROV-013 | R3 establishes typed compaction; R7 closes lossless/translated provider continuation across released adapters. |
| `FR-CTX-009` | R3 | CTX-006, CTX-010 | `session-recovery`: inspect/compact is provider-free and reports category/token/omission evidence. |
| `FR-CTX-010` | R3 | CTX-008 | `session-recovery`: summary claims cannot approve, certify effects, or replace live preconditions. |
| `FR-CTX-011` | R8 | CONF-001, CONF-006, CONF-007, CONF-016 | `extension-contract`: instruction precedence, imports, scopes, changes, and active provenance pass. |
| `FR-CTX-012` | R8 | CONF-007, CTX-013 | `extension-contract`: `ROBIN.md` and labeled compatible `AGENTS.md` behavior is bounded and explicit. |

#### Repository discovery and read tools

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-REP-001` | R2 | FS-001, GIT-001, GIT-016 | `repository-tools`: physical root/common-dir/worktree identity and replacement drift are exact. |
| `FR-REP-002` | R2 | UNIT-007, FS-002, FS-011, FS-016 | `repository-tools` plus platform matrix: traversal, aliases, NUL, device, Unicode, and root collisions fail safely. |
| `FR-REP-003` | R2 | FS-003, FS-004, SEC-003 | `repository-tools` and `mutation-critical`: operation-time symlink/hard-link containment keeps outside canaries absent. |
| `FR-REP-004` | R2 | FS-005, FS-006, FS-018 | `repository-tools`: walk depth/count/path/time/ignore/omission and deterministic page order pass. |
| `FR-REP-005` | R2 | FS-007, FS-008, FS-018 | `repository-tools`: literal search bounds and built-in/ripgrep semantic conformance pass. |
| `FR-REP-006` | R2 | FS-009, FS-010, FS-019 | `repository-tools`: line/byte windows, encoding/binary/hash/drift/truncation are exact. |
| `FR-REP-007` | R2 | UNIT-010, GIT-001, GIT-002, GIT-015 | `repository-tools`: structured status/diff/log/branch parsing covers odd paths and bounded output. |
| `FR-REP-008` | R2 | FS-017 | platform integration evidence measures supported no-atime behavior and documents unsupported cases. |
| `FR-REP-009` | R2 | FS-013 | `repository-tools`: Git/Robin/provider/hard exclusion provenance and override floors remain distinct. |
| `FR-REP-010` | R2 | FS-015, FS-018, CTX-012 | `repository-tools`: result bounds apply before persistence, rendering, and model release. |

#### File editing and checkpoints

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-EDIT-001` | R2 | UNIT-008, EDIT-001, EDIT-002 | `repository-tools`: R2 structural create/modify patch applies exact hunks against an exact preimage. |
| `FR-EDIT-002` | R6 | EDIT-003, EDIT-007, EDIT-010 | daily-workflow evidence: R6 full-file replacement and atomic-batch create forms are distinct, bounded, and higher-risk where applicable; the single structural create primitive remains an R2 capability. |
| `FR-EDIT-003` | R6 | EDIT-003, EDIT-004, EDIT-005, EDIT-010, EDIT-021 | daily-workflow evidence: create/update/move/delete within the R6 atomic multi-file operation use separate schemas, exact preconditions, and journal recovery; R2 does not claim this batch contract. |
| `FR-EDIT-004` | R6 | UNIT-008, EDIT-002, EDIT-007, EDIT-010, EDIT-016, SEC-004 | R2 closes only create/modify patch rejection; R6 closes distinct full-file and batch malformed/path/collision/size rejection. |
| `FR-EDIT-005` | R5 | EDIT-002, EDIT-009, EDIT-011, PERM-008, SEC-014 | R2 establishes immediate identity/preimage recheck; R5 closes stale-approval invalidation through the full tool pipeline. |
| `FR-EDIT-006` | R6 | EDIT-006, EDIT-008, EDIT-010 | repository plus daily-workflow platform evidence: atomic create/modify and later batch paths preserve supported metadata or fail exactly. |
| `FR-EDIT-007` | R3 | EDIT-001, EDIT-015, EDIT-017 | `session-recovery`: before/after hashes, bounded diff, full artifact hash, and durable attribution survive crash. |
| `FR-EDIT-008` | R2 | EDIT-012, EDIT-019, GIT-018 | `repository-tools`: pre-existing and external changes remain separately labeled under every outcome. |
| `FR-EDIT-009` | R6 | EDIT-013, EDIT-021 | daily-workflow evidence: checkpoint grouping, parent/order, paths, hashes, CAS, and verification are exact. |
| `FR-EDIT-010` | R6 | EDIT-014, EDIT-021 | daily-workflow evidence: rewind preview and inverse journal refuse any mismatched postimage. |
| `FR-EDIT-011` | R6 | EDIT-008, EDIT-015, EDIT-021 | repository/session/daily-workflow fault evidence covers disk, permission, rename, lock, signal, and partial batch states. |
| `FR-EDIT-012` | R6 | EDIT-020, GIT-018, E2E-006 | daily-workflow evidence derives cumulative diff from current Git/filesystem plus attribution ledger. |

#### Process and shell tools

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-PROC-001` | R2 | UNIT-009, PROC-001, PROC-003, PROC-014 | `repository-tools`: executable/argv/cwd/env/time/output schema reaches direct spawn with no shell interpretation. |
| `FR-PROC-002` | R5 | PROC-002 | `permission-direct` and sandbox evidence: explicit shell text/hash/shell identity are displayed and separately authorized. |
| `FR-PROC-003` | R5 | PROC-004, PROC-017, PROC-019, CRED-011 | `permission-direct` plus sandbox canaries: only reviewed environment additions reach children. |
| `FR-PROC-004` | R5 | PTY-007, PROC-007, PROC-008, PROC-009, PROC-017 | R2 establishes direct-process groups and escalation; R5 closes the sandboxed process-controller and descendant isolation cases. |
| `FR-PROC-005` | R2 | PROC-005, PROC-006 | `repository-tools`: stdout/stderr order, bounded head/tail/hash/artifact, and separate views pass. |
| `FR-PROC-006` | R5 | PROC-006, PROC-010, PROC-011, PROC-012 | sandbox evidence: time/output/PID/memory/CPU/file limits and setup failures are independently observed. |
| `FR-PROC-007` | R5 | PROC-016, PROC-017, PROC-018, SEC-015 | `sandbox-linux` or accepted macOS backend evidence records requested/achieved roots/network/resources. |
| `FR-PROC-008` | R5 | PROC-016, PROC-018, PERM-017 | `permission-direct` and sandbox evidence: strict unavailable denies; any weaker mode is explicit. |
| `FR-PROC-009` | R9 | PROC-020, EXT-013, EXT-015 | `subagent-worktree`: background handle/log/status/input/cancel/cleanup/recovery lifecycle passes. |
| `FR-PROC-010` | R6 | PROC-013, PROC-015, EDIT-020, E2E-002, E2E-006 | R2 establishes manifest-derived verification; R6 closes daily-workflow factual/stale verification and final-summary integration. |

#### Git tools

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-GIT-001` | R2 | GIT-001, GIT-003 | `repository-tools`: initial HEAD/branch/status/index is captured before first mutation. |
| `FR-GIT-002` | R2 | UNIT-010, GIT-002 | `repository-tools`: NUL-delimited spaces/tabs/newlines/Unicode/renames/conflicts/submodules parse exactly. |
| `FR-GIT-003` | R6 | GIT-001, GIT-004, GIT-005, GIT-010 | daily-workflow evidence proves read/stage/commit/branch/push/PR classes remain separate. |
| `FR-GIT-004` | R6 | GIT-004, GIT-005, GIT-006 | daily-workflow evidence: exact paths/postimages/staged diff/index precondition survive races and rollback. |
| `FR-GIT-005` | R6 | GIT-007, GIT-008, GIT-020 | daily-workflow/session evidence: exact tree/parent/message/commit/ref and crash reconciliation pass. |
| `FR-GIT-006` | R6 | GIT-011, GIT-012 | daily-workflow evidence: canonical remote/refspec/credential/network display and receipt are exact. |
| `FR-GIT-007` | R6 | GIT-010, GIT-019 | `permission-direct` plus daily-workflow evidence: destructive/history tools are absent or denied before Git. |
| `FR-GIT-008` | R9 | GIT-014, EXT-014, EXT-015 | `subagent-worktree`: common-dir/admin/root/marker/process/import/cleanup worktree fixtures pass. |
| `FR-GIT-009` | R6 | GIT-006, GIT-009, PERM-008 | daily-workflow evidence: HEAD/index/worktree/sequencer/path drift invalidates approval. |
| `FR-GIT-010` | R6 | GIT-013, E2E-006 | daily-workflow evidence: adapter result or truthful local prepared title/body never fabricates a PR. |

#### Providers and models

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-PROV-001` | R4 | PROV-001, PROV-005, PROV-012 | `provider-contract`: semantic request and normalized async events contain no SDK object outside adapter. |
| `FR-PROV-002` | R7 | PROV-001, PROV-002, PROV-005, PROV-018 | R4 establishes the hosted-alpha vocabulary; R7 closes text/tool/usage/stop/warning/failure normalization across every released adapter. |
| `FR-PROV-003` | R7 | PROV-014, PROV-016, PROV-023 | provider conformance: ID/origin/auth/capability validation and registered extension contribution pass. |
| `FR-PROV-004` | R7 | PROV-014, PROV-015, PROV-020 | provider conformance: tool/parallel/structured/modal/context/usage intersection rejects capability lies. |
| `FR-PROV-005` | R7 | CTX-001, CTX-005, PROV-012, PROV-014 | cross-adapter evidence: only negotiated prompt transformations occur; unsupported switches fail. |
| `FR-PROV-006` | R7 | PROV-005, PROV-006, PROV-018 | R4 establishes safe unknown-field handling for the hosted alpha; R7 closes it across compatible and additional hosted dialects. |
| `FR-PROV-007` | R7 | PROV-007, PROV-009, SES-006, LIVE-003 | R4 establishes first-provider retry certainty; R7 closes method/transmission/result tables and visible attempts across released adapters. |
| `FR-PROV-008` | R7 | PROV-006, PROV-017, PROV-018 | R4 establishes alpha error categories; R7 closes shared stable categories and safe request metadata across adapters. |
| `FR-PROV-009` | R7 | PROV-015, PROV-023 | provider conformance: explicit compatible dialect/tier/origin/capability probe has no silent emulation. |
| `FR-PROV-010` | R7 | PROV-023, CRED-014 | provider conformance: registered local endpoints use the same contract and only allowed profiles omit keys. |
| `FR-PROV-011` | R7 | PROV-022, CRED-015 | cross-adapter/session evidence: mutable aliases are labeled and invocation identity is pinned. |
| `FR-PROV-012` | R7 | PROV-001–PROV-023, E2E-008, LIVE-002 | full provider contract plus protected smoke: every released adapter passes recorded/fake/cancel/error/tool/resume cases. |

#### Credentials and authentication

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-CRED-001` | R7 | CRED-003, CRED-008, CRED-009, CRED-010 | R4 establishes secret-free credential metadata; R7 closes persistent backend generation, rotation, removal, and validation records. |
| `FR-CRED-002` | R7 | CRED-001, CRED-002, CRED-004 | OS matrix conformance: hidden/env sources plus macOS Keychain/Secret Service have no plaintext fallback. |
| `FR-CRED-003` | R4 | UNIT-001, CRED-001, CRED-003 | `credential-redaction`: argv/process-list/history canaries prove raw-secret flags and positionals are rejected. |
| `FR-CRED-004` | R4 | CRED-002, PROC-004 | `credential-redaction`: only the exact named environment variable is leased and children never inherit it. |
| `FR-CRED-005` | R7 | CRED-006, CRED-015 | provider/credential evidence: invocation/origin/auth/deadline-bound lease exists only at final transport. |
| `FR-CRED-006` | R4 | CRED-007, PROV-006, LIVE-001 | provider contract/live validation: missing/rejected/scope/model/rate/network categories are distinct. |
| `FR-CRED-007` | R10 | CRED-008, CRED-012, CRED-013 | `credential-redaction` plus release diagnostics: list/export/log/support resolve no secret bytes. |
| `FR-CRED-008` | R7 | CRED-010, CRED-016 | credential lifecycle evidence: exact dependencies/confirmation and backend/metadata partial outcomes reconcile. |
| `FR-CRED-009` | R7 | CRED-009 | OS-store conformance: replacement validates before atomic switch and old generation remains recoverable. |
| `FR-CRED-010` | R8 | PROC-004, PROC-017, CRED-011, EXT-019 | `extension-contract` and sandbox canaries: process/hook/MCP/skill/subagent receive no ambient provider secret. |

#### Configuration and instructions

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-CONF-001` | R8 | UNIT-012, CONF-001 | `extension-contract`: every defaults/managed/user/project/local/env/file/CLI permutation and source trace passes. |
| `FR-CONF-002` | R8 | UNIT-012, CONF-001, CONF-004 | `extension-contract`: every lower source fails to widen a managed provider/tool/sandbox/budget floor. |
| `FR-CONF-003` | R8 | CONF-008, CONF-009, CONF-010 | `extension-contract`: candidate inventory precedes semantic load and exact material change requires reapproval. |
| `FR-CONF-004` | R8 | CONF-002, CONF-014 | `extension-contract`: bytes/version/duplicates/unknowns/nesting/time are bounded with no code execution. |
| `FR-CONF-005` | R8 | CONF-011 | `extension-contract`: `robin config explain` exposes redacted winner/overrides/floor/validation. |
| `FR-CONF-006` | R8 | CONF-003, CONF-015 | config fault/migration evidence: writes are atomic, preserve unrelated fields, and refuse newer schemas. |
| `FR-CONF-007` | R8 | CONF-004, CONF-013 | `extension-contract`: the complete settings surface pins exact active snapshots at eligible boundaries. |
| `FR-CONF-008` | R8 | CONF-005, CRED-012 | config/redaction evidence: secret shapes reject/migrate safely and backups/explain remain secret-free. |
| `FR-CONF-009` | R8 | CONF-006 | `extension-contract`: relative root/depth/count/byte/time/symlink/cycle/provenance import corpus passes. |
| `FR-CONF-010` | R8 | CONF-016 | `extension-contract`: canonical anchored scopes handle match/nonmatch/empty/rename/alias/branch changes. |

#### Permissions and policy

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-PERM-001` | R5 | UNIT-017, PERM-001 | `permission-direct`: every built-in/dynamic tool has complete normalized action facts; missing facts fail closed. |
| `FR-PERM-002` | R5 | UNIT-013, PERM-002, SEC-008 | `permission-direct`: exhaustive `deny > ask > allow` reference table and explanation trace pass. |
| `FR-PERM-003` | R5 | PERM-003 | `permission-direct`: canonical `default` mode covers bounded reads, edits, commands, and high-risk denials. |
| `FR-PERM-004` | R5 | PERM-004, PERM-005 | `permission-direct`: `plan` denies mutation and `accept-edits` cannot authorize commands/Git/network. |
| `FR-PERM-005` | R7 | PERM-006, E2E-007 | headless consumer evidence: ask becomes deny unless an exact framed callback covers the immutable request. |
| `FR-PERM-006` | R5 | TERM-007, PERM-007 | `permission-direct`: exact scope/preconditions/risk/effect/sandbox/choice text is visible before input activates. |
| `FR-PERM-007` | R5 | PERM-007, PERM-015 | `permission-direct`: persistent rule preview and atomic update preserve unrelated rules and cannot grant on failure. |
| `FR-PERM-008` | R5 | PERM-008, PERM-009 | `permission-direct`: fingerprint/request/workspace/policy/expiry binding and one-use consumption pass. |
| `FR-PERM-009` | R8 | PERM-008, PERM-010, CONF-013, EXT-018 | permission/config/extension evidence: every file/command/provider/policy/extension drift invalidates stale approval. |
| `FR-PERM-010` | R8 | PERM-002, PERM-012, CONF-009 | `permission-direct` plus trust evidence: repository/model/extension cannot bypass, self-approve, or weaken denial. |
| `FR-PERM-011` | R8 | PERM-002, PERM-012 | permission/config evidence: `bypass` requires explicit launch confirmation, persistent warning, and permits managed disable. |
| `FR-PERM-012` | R10 | PERM-011, CRED-012, E2E-011 | R5 establishes safe policy traces; R10 closes their doctor/log/support/release surfaces with zero secret canaries. |

#### Usage, budgets, and cost

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-BUD-001` | R9 | UNIT-006, PROV-009, SES-019, EXT-011 | `subagent-worktree` plus prior budget regressions: turn/request/token/cost/tool/process/output/context/child limits pass. |
| `FR-BUD-002` | R7 | UNIT-006, PROV-008 | provider conformance: provider usage wins; estimates remain labeled and reconcile without underflow. |
| `FR-BUD-003` | R10 | PROV-008, LIVE-002 | release evidence records pricing source/version/effective date/currency and safe unknown-price behavior. |
| `FR-BUD-004` | R4 | UNIT-006, PROV-008 | `provider-contract`: soft threshold appears before the next consequential request/action. |
| `FR-BUD-005` | R4 | UNIT-006, PROV-009, FS-018 | `unit-contract` and provider contract: hard limit blocks before the next bounded operation and records category. |
| `FR-BUD-006` | R9 | UNIT-006, SES-018, EXT-011 | `subagent-worktree`: resume/delegation snapshot distinguishes reset, continued, and ancestor-aggregate budgets. |

#### Headless and SDK-facing contracts

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-AUTO-001` | R7 | UNIT-018, PTY-011, E2E-007 | external consumer evidence: text stdout contains only final assistant result; progress/diagnostics use stderr. |
| `FR-AUTO-002` | R7 | TERM-012, E2E-007 | external consumer evidence parses one final envelope or typed monotonic JSON Lines. |
| `FR-AUTO-003` | R10 | UNIT-001, UNIT-016, TERM-012, E2E-011 | R7 freezes input/output/error schemas; `release-candidate` closes their published lifecycle compatibility and fixtures. |
| `FR-AUTO-004` | R7 | TERM-012, PTY-011 | `package-smoke` preserves flat implemented R0 paths; `node-os-matrix` closes machine modes with no ANSI, spinner, carriage-return rewrite, or prefix bytes. |
| `FR-AUTO-005` | R7 | SES-001, E2E-007 | headless persistence evidence: `--no-session` creates no transcript/CAS and explicitly disables resume. |
| `FR-AUTO-006` | R7 | UNIT-002, SES-015 | headless contract evidence: caller IDs are accepted only in the validated namespace without collision. |
| `FR-AUTO-007` | R8 | PERM-006, EXT-003, EXT-007 | permission/extension evidence: framed callbacks enforce length/nonce/hash/schema/time/resource bounds and no stdout spoof. |
| `FR-AUTO-008` | R11 | E2E-012, SEC-018 | R11 protocol evidence: future SDK wraps versioned application methods and cannot bypass enforcement. |

#### Hooks, skills, MCP, and subagents

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-EXT-001` | R9 | EXT-001, EXT-003, EXT-006, EXT-011 | R8 establishes instruction/skill/hook/MCP classes; R9 closes the distinct subagent identity/lifecycle/tool/context/delegation contract. |
| `FR-EXT-002` | R8 | EXT-001, EXT-018, CONF-008 | `extension-contract`: project category trust and user source/version/integrity records pass. |
| `FR-EXT-003` | R8 | EXT-001, EXT-002 | `extension-contract`: startup loads metadata only and selection loads bounded pinned instructions/resources. |
| `FR-EXT-004` | R8 | EXT-003, EXT-004 | `extension-contract`: every hook event/matcher/type/timeout/concurrency/permission/failure combination passes. |
| `FR-EXT-005` | R8 | EXT-004, EXT-005 | `extension-contract`: forged result/allow/authority responses are rejected; only closed controls apply. |
| `FR-EXT-006` | R8 | EXT-006, EXT-007, EXT-009 | `extension-contract`: exact stdio/HTTP transport, scope, lifecycle, origin, and project self-approval denial pass. |
| `FR-EXT-007` | R8 | EXT-008 | `extension-contract`: annotation-lie corpus maps side effects conservatively and never upgrades safety. |
| `FR-EXT-008` | R8 | EXT-004, EXT-009, EXT-019 | `extension-contract` and sandbox canaries: minimum env/root/network/credential plan prevents leak and escape. |
| `FR-EXT-009` | R9 | EXT-011, EXT-016 | `subagent-worktree`: explicit model/prompt/tools/permissions/context/budget/concurrency/worktree/result contract passes. |
| `FR-EXT-010` | R9 | EXT-012, EXT-013 | `subagent-worktree`: authority intersection, descendant ceiling, parent cancellation, and no widening pass. |
| `FR-EXT-011` | R9 | EXT-014, GIT-014 | `subagent-worktree`: shared read snapshot only; parallel mutation uses distinct proven worktrees or serialization. |
| `FR-EXT-012` | R9 | EXT-004, EXT-015, EXT-016, EXT-020 | extension/subagent recovery evidence: failures isolate, record, cancel, and resume without transcript corruption. |

#### Diagnostics, updates, and data lifecycle

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `FR-OPS-001` | R10 | SEC-011, E2E-011 | `release-candidate`: `robin doctor` is read-only by default and labels every active/fix probe separately. |
| `FR-OPS-002` | R10 | E2E-011, CRED-007, PERM-017 | `release-candidate`: install/version/state/Git/provider/model/credential/sandbox/extension/supervisor matrix is complete. |
| `FR-OPS-003` | R10 | CRED-012, CRED-013, E2E-011 | `release-candidate`: `robin support bundle --dry-run` inventories file/field/size/hash/redaction before a verified archive. |
| `FR-OPS-004` | R10 | CRED-012, SEC-013 | release diagnostics evidence: structured logs enforce levels, bounds, rotation, redaction, retention, and failure behavior. |
| `FR-OPS-005` | R10 | SEC-016, E2E-011 | `release-candidate`: update destination/disabling/offline/hermetic behavior is disclosed and sends no repository content. |
| `FR-OPS-006` | R10 | SEC-016, SEC-017, E2E-011 | `release-candidate`: signed/checksummed channel manifest/artifact rejects tamper/replay/downgrade and rolls back safely. |
| `FR-OPS-007` | R10 | SES-024, CRED-016, E2E-011 | release lifecycle evidence: transcript/artifact/log/cache/recovery retention classes and dependencies are independent. |
| `FR-OPS-008` | R10 | SES-024, CRED-016, E2E-011 | `release-candidate`: project/global dry-run, exact trash/purge manifests, partial failure, and broad-root denial pass. |
| `FR-OPS-009` | R10 | SES-021, SES-022, SES-023 | `session-recovery` plus release origins: migrations are versioned, restartable, copy-validate-switch, backed up, and rollback-tested. |
| `FR-OPS-010` | R10 | CRED-012, CRED-013, E2E-011 | `release-candidate`: crash report/support bundle excludes raw credential/content by default and remains actionable. |

#### Security and reliability

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `NFR-SEC-001` | R11 | SEC-001, SEC-013 | per-gate fuzz/property evidence: every untrusted parser enforces byte/item/nesting/time limits and bounded allocation. |
| `NFR-SEC-002` | R6 | FS-002, FS-003, EDIT-009, PERM-008, SEC-003, SEC-014 | `mutation-critical`: physical containment/type/hash preconditions are rechecked immediately before every access/effect. |
| `NFR-SEC-003` | R10 | CRED-003, CRED-011, CRED-012, CRED-013 | `credential-redaction` and release canary scan: raw keys are absent from context/children/state/log/export/support/diagnostics. |
| `NFR-SEC-004` | R5 | UNIT-003, PERM-001, PERM-008, PERM-009, SEC-009 | `permission-direct` and `mutation-critical`: exact immutable normalized/precondition/policy request binds one-use execution. |
| `NFR-SEC-005` | R8 | CONF-001, CONF-008, PERM-012, EXT-005 | config/trust/extension evidence: lower sources and project extensions cannot weaken higher controls. |
| `NFR-SEC-006` | R10 | SEC-001–SEC-020, E2E-005, E2E-011 | `mutation-critical` and `release-candidate`: adversarial path/patch/command/stream/protocol/provider/extension/credential gates pass. |
| `NFR-REL-001` | R9 | UNIT-004, SES-003, SES-006–SES-010, EXT-015 | session/subagent recovery evidence: a crash never fabricates completed turn/effect and every incomplete state is classified. |
| `NFR-REL-002` | R3 | UNIT-004, SES-025, SEC-002 | `session-recovery`: replay hashes match while provider/tool/process/Git/credential/extension spies remain untouched. |
| `NFR-REL-003` | R6 | PROV-007, EDIT-015, EDIT-021, GIT-020, SES-006–SES-010 | recovery evidence: idempotency/reconciliation/uncertainty rules prevent duplicate consequential effects. |
| `NFR-REL-004` | R9 | PTY-010, EDIT-015, PROC-007, SES-005, GIT-014, EXT-015 | platform/resource evidence: terminal/file/Git/session/process/socket/worktree resources clean up or retain exact inventory. |
| `NFR-REL-005` | R10 | CONF-015, SES-021, SES-022, SES-023 | `session-recovery` and `release-candidate`: oldest upgrade/rollback/corrupt/newer-refusal fixtures pass. |

#### Performance

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `NFR-PERF-001` | R10 | UNIT-001, PTY-014 | `package-smoke` proves R0 forbidden-import sentinels; `performance-full` closes packaged warm help/version p95 target 150 ms and CI ceiling 250 ms. |
| `NFR-PERF-002` | R12 | TERM-005, TERM-006, PTY-016 | `performance-full` plus editor performance evidence: input/render p95 remains within Section 13 under load. |
| `NFR-PERF-003` | R10 | FS-005, CTX-002 | `performance-full`: lazy 100,000-path startup proves no full repository scan/hash/content read. |
| `NFR-PERF-004` | R3 | TERM-015, SES-026, CTX-006 | `session-recovery` and performance evidence: windowed memory, snapshots, session-local CAS, incremental replay/compaction pass. |
| `NFR-PERF-005` | R10 | PTY-016, SES-026 | `performance-full`: p50/p95/p99 by platform/build/dataset meet targets and CI ceilings with provenance. |

#### Privacy

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `NFR-PRIV-001` | R7 | CTX-003, PROV-012, LIVE-005 | provider evidence: every egress byte is attributable to session/request/context manifest/provider/origin. |
| `NFR-PRIV-002` | R10 | SEC-011, E2E-011 | `release-candidate`: telemetry remains absent/off until schema/destination/retention/consent evidence exists. |
| `NFR-PRIV-003` | R10 | SES-024, CRED-016, E2E-011 | `release-candidate`: per-platform locations, retention, export, delete, uninstall, and purge behavior pass. |
| `NFR-PRIV-004` | R8 | EXT-009, EXT-010, EXT-019 | `extension-contract`: third-party egress has a separate origin/credential/permission/context boundary. |

#### Accessibility

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `NFR-A11Y-001` | R12 | TERM-002, TERM-014, PTY-015, E2E-013 | terminal and editor accessibility evidence: every interactive workflow completes by keyboard alone. |
| `NFR-A11Y-002` | R12 | TERM-011, PTY-015, E2E-013 | terminal and editor accessibility evidence: no-color, no-animation, flat output remains complete and usable. |
| `NFR-A11Y-003` | R12 | TERM-006, TERM-011, PTY-016, E2E-013 | accessibility/performance evidence: reduced motion and bounded status-announcement cadence hold under load. |
| `NFR-A11Y-004` | R12 | TERM-007, PTY-015, E2E-013 | permission/editor accessibility evidence: action, risk, and every choice are expressed in text independent of color/symbol. |

#### Portability and maintainability

| Requirement | Terminal gate | Required tests | Required gate/release evidence |
| --- | --- | --- | --- |
| `NFR-PORT-001` | R10 | PTY-014, E2E-011 | `node-os-matrix` and compatibility manifest name exact macOS/Linux/WSL/Node/Git/sandbox/credential versions; untested cells are omitted. |
| `NFR-PORT-002` | R7 | FS-002, PTY-009, PROC-007, SES-005, CRED-004 | `node-os-matrix`: path/signal/group/store/terminal differences pass through explicit tested adapters. |
| `NFR-PORT-003` | R10 | PROC-016, PROC-018, PERM-017 | sandbox and doctor evidence: unsupported enforcement is diagnosed and cannot satisfy strict mode. |
| `NFR-MAINT-001` | R12 | SEC-018, E2E-012, E2E-013 | `static` plus editor evidence: `packages/robin-terminal`, application, agent, provider, tools, and state boundaries stay acyclic. |
| `NFR-MAINT-002` | R7 | PROV-012, PROV-018, SEC-018 | `static` and provider conformance: provider SDK/wire objects never cross adapter exports. |
| `NFR-MAINT-003` | R5 | UNIT-017, PERM-001, SEC-018 | `unit-contract` and `permission-direct`: tool schema/version/fingerprint/normalizer/release/reconcile conformance passes. |
| `NFR-MAINT-004` | R10 | SEC-019 | `docs-policy` and `release-candidate`: current/planned status and package/help/demo claims match accepted evidence. |

### 20.2 Test metadata

Each required test exposes or registers:

- stable test ID from Section 11 or a more specific child ID;
- requirement IDs;
- owning enforcement point;
- earliest gate;
- deterministic seed/fixture/schema versions;
- required OS/capabilities;
- secret/network classification;
- timeout and cleanup oracle;
- evidence fields safe to retain.

The validator rejects duplicate IDs, nonexistent implemented tests, a security
requirement mapped only to a snapshot/coverage percentage, and evidence whose
job/commit/platform does not satisfy the claim.

### 20.3 Evidence manifest

A gate/release evidence manifest records:

- schema, gate/release/version/commit/tag/build IDs;
- requirement registry hash;
- build plan/architecture/operations/threat-model hashes;
- CI workflow/job/run/attempt and runner matrix;
- test IDs, counts, seeds, durations, skips, failures, and reruns;
- compatibility cells and capability probes;
- package/artifact/SBOM/provenance/checksum/signature hashes;
- migration origin/result/rollback fixtures;
- performance dataset/runner/baseline/percentiles;
- canary/redaction scan classes and zero/nonzero count;
- live-provider profile/model revision, safe request IDs, spend cap/actual, and
  reviewer without raw payload/key;
- manual UX/accessibility/lifecycle checklist identities;
- issues, accepted waivers, residual risks, and expiration;
- approval identity/time for release environment.

### 20.4 Trace rules

1. Every implemented requirement has at least one deterministic test at its
   enforcement point.
2. Filesystem, process, Git, credential, sandbox, terminal, update, and editor
   requirements also have integration evidence on each claimed platform.
3. Security/privacy requirements map to adversarial or canary assertions, not
   only happy-path tests.
4. Reliability/recovery requirements map to explicit fault points and external
   state oracles.
5. Performance requirements map to versioned dataset, runner, percentile, and
   threshold.
6. Provider compatibility maps to shared conformance plus dialect-specific
   evidence; a live smoke alone is insufficient.
7. Current documentation claims map to accepted requirements; planned claims
   cannot appear as current release features.
8. A test may cover many requirements only when each named assertion observes
   the relevant boundary.
9. Deleting/renaming a test, schema, enforcement point, or doc anchor invalidates
   trace until updated in the same pull request.
10. A release includes only evidence from its exact commit or immutable artifact;
    evidence from an older commit remains historical, not passing.

### 20.5 Waivers

A waiver is allowed only for a non-critical requirement/matrix cell when:

- user impact and unsupported claim are explicit;
- threat/privacy/recovery consequence is assessed;
- feature is disabled or release docs downgrade the support claim;
- owner, issue, start, expiration, and removal test are recorded;
- release approver accepts it.

No waiver can permit raw credential exposure, unauthorized consequential effect,
silent strict-sandbox fallback, destructive cleanup outside owned targets,
fabricated session success, updater signature bypass, or unresolved critical/high
security finding in a shipped path.

## 21. Release Candidate and Portfolio Readiness

Before a public release candidate:

- README's current status equals implemented gate and includes exact install/run
  path;
- demo starts from a clean public synthetic fixture and has a deterministic
  fallback requiring no key;
- architecture diagram and diagnostics distinguish permission, sandbox, and
  whole-process claims;
- compatibility manifest names supported OS/arch/Node/Git/terminal/provider/
  sandbox cells and omissions;
- package/license/notice/SBOM/provenance/checksum/signature artifacts verify;
- clean-machine lifecycle is recorded on macOS and Ubuntu Tier 1;
- one session crash/resume and one uncertain-effect reconciliation are visible;
- one denied-context scenario proves forbidden content absent from exact
  provider request bytes;
- one cancellation/output-flood scenario proves no orphan process;
- one dirty-worktree scenario proves preservation/attribution;
- live-provider smoke uses fixed public fixture, bounded spend, and no secret
  leak;
- benchmark report states hardware/dataset/percentiles and does not generalize
  from one machine;
- threat model, security policy, incident/contact path, privacy/retention, update,
  rollback, uninstall, and purge docs are current;
- issues/milestones and evidence registry show implemented versus planned;
- no placeholder command, package name, URL, checksum, or support claim remains
  in published release instructions.

The portfolio release must demonstrate that Robin owns the coding-agent loop,
terminal experience, tools, sessions, provider normalization, permissions, and
verification. A deep internal control layer is supporting evidence, not a
substitute for the user flow.

## 22. Feature Exhaustiveness Audit

Before any feature or gate closes, its owner answers every applicable field
below in the implementation ticket and trace record:

- user entry point and current/planned documentation;
- owning application/package and dependency direction;
- input schema, byte/item/depth/time bounds, and normalization;
- trust source/class and configuration precedence;
- provider/model capability and egress, if any;
- credential source, endpoint binding, and child visibility;
- permission action/effect class/default mode/approval scope;
- sandbox/enforcement backend and truthful fallback;
- physical workspace/path/file/Git preconditions;
- execution adapter and exact object passed to it;
- durable prepared/start/result/uncertain facts;
- local session append/flush/snapshot/CAS behavior;
- idempotency, retry certainty, and reconciliation oracle;
- cancellation, timeout, signal, child/process cleanup;
- concurrency, single-writer, budget, memory, disk, output, and backpressure;
- renderer, headless JSON/JSONL, exit code, accessibility, and redaction;
- logs, doctor, support bundle, and safe failure next action;
- unit, contract, property, integration, adversarial, fault, mutation,
  performance, e2e, live/manual tests as applicable;
- supported OS/architecture/Node/Git/terminal/filesystem/sandbox matrix;
- dependency/supply-chain/package contents and install impact;
- config/session/tool/protocol schema migration and rollback;
- update compatibility, uninstall, project/global purge, backup/restore;
- data class, retention, export, deletion, provider/extension egress, privacy;
- threat-model entry, incident containment, residual risk, and waiver status;
- requirement IDs, test IDs, evidence IDs, gate, release claim, and reviewers.

“Not applicable” includes a reviewed reason. A missing answer means the feature
is not ready. A command stub, interface, event name, passing happy path, or high
coverage number cannot substitute for the complete user flow and its lifecycle
evidence.
