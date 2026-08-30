# Guarded Agent: Installation, Testing, Operations, and Release Plan

This document covers the parts of the project lifecycle that are not contained inside one runtime module: repository setup, developer installation, dependency policy, local infrastructure, test policy, CI, packaging, user installation, upgrades, rollback, data retention, incident response, and project governance.

It is a required part of the build plan. The project is not complete because the agent loop works on one developer's machine.

## 1. Lifecycle Coverage

The plan covers each stage explicitly:

1. Repository creation and protection
2. Developer machine bootstrap
3. Dependency installation and verification
4. Local configuration and credentials
5. Incremental implementation
6. Unit, integration, contract, adversarial, end-to-end, performance, and compatibility testing
7. Continuous integration
8. Security review and release readiness
9. CLI packaging and installation
10. Daemon startup and lifecycle
11. VS Code extension packaging and installation
12. Upgrade and database migration
13. Rollback and recovery
14. Artifact retention and deletion
15. Diagnostics and incident response
16. Deprecation and uninstall

## 2. Supported Environment Policy

### 2.1 Initial support matrix

| Dimension | Required v1 support | Tested but secondary | Deferred |
|---|---|---|---|
| Host OS | Current macOS, current Ubuntu LTS | Another maintained Linux distribution | Windows |
| CPU | arm64 macOS, x64 Linux | arm64 Linux | Other architectures |
| Node.js | 22 LTS line | Next LTS after explicit compatibility test | Older releases |
| Package manager | npm version compatible with Node 22 | None | pnpm, Yarn as developer requirements |
| Git | Version supporting worktrees and required diff flags | Newer stable versions | Alternative VCS |
| Database | PostgreSQL 17 | PostgreSQL 16 after compatibility tests | Managed cloud database requirement |
| Sandbox | Docker Desktop on macOS, Docker Engine on Linux | Podman adapter after Docker path is stable | Kubernetes |
| Editor | CLI on any terminal; VS Code after Phase 9 | Compatible Code-OSS distributions after tests | Maintained editor fork |

Do not describe an environment as supported until CI or a documented manual release test covers it.

### 2.2 Compatibility record

Every release records:

- Node and npm versions used to build
- Minimum and tested Git versions
- PostgreSQL major versions tested
- Docker/Podman versions tested
- Sandbox image digests
- Host OS images or runner versions
- VS Code engine range for the extension
- Provider adapter and API assumptions

Store the record in the release artifact and `docs/compatibility/<version>.md`.

## 3. Git Repository Setup

### 3.1 Initial local repository

1. Create a dedicated sibling directory under `portfolio_projects`.
2. Copy only Guarded Agent files; do not nest it in the Site DNA repository.
3. Initialize Git with `main` as the initial branch.
4. Verify no parent repository captures the new directory.
5. Run the documentation bootstrap test.
6. Review `git status --short` and the exact initial diff.
7. Create one initial commit containing documentation, repository policy, and validation script.

### 3.2 Remote repository

Create a GitHub repository named `guarded-agent` under the intended account. The portfolio intent suggests public visibility, but keep it private until the first implementation milestone if unfinished design exposure is undesirable.

After creation:

1. Add `origin` using SSH or HTTPS according to the authenticated local setup.
2. Push `main` and set upstream.
3. Verify `git ls-remote origin` returns the pushed commit.
4. Add repository description and topics: `ai-agents`, `authorization`, `developer-tools`, `sandbox`, `event-sourcing`, `typescript`.
5. Enable issues and discussions only if they will be monitored.
6. Disable the wiki unless project documentation will intentionally use it.
7. Configure security reporting before a public security claim.

### 3.3 Branch protection

Once CI exists, protect `main` with:

- Pull request required
- Required status checks
- Conversation resolution required
- Force push disabled
- Branch deletion disabled
- Linear history preferred
- Signed commits or vigilant mode when practical
- Administrator bypass reserved for repository recovery

Before CI exists, avoid enabling an impossible required-check configuration that blocks all work.

### 3.4 Labels and milestones

Create labels:

- `area:runtime`
- `area:policy`
- `area:context`
- `area:tools`
- `area:sandbox`
- `area:persistence`
- `area:evals`
- `area:cli`
- `area:vscode`
- `type:security`
- `type:bug`
- `type:feature`
- `type:documentation`
- `type:refactor`
- `risk:high`
- `blocked`

Create milestones matching the implementation guide's Milestones A through G. Every issue belongs to one milestone or the explicitly deferred backlog.

## 4. Developer Bootstrap

### 4.1 Prerequisite verification

The developer setup command eventually becomes `npm run doctor:dev`. It checks and reports without mutating the machine:

- Supported OS and architecture
- Node and npm versions
- Git availability and version
- Docker or Podman availability, daemon access, and architecture
- PostgreSQL client availability when needed
- Availability of an unoccupied configured port
- Filesystem support for Unix sockets and owner-only permissions
- Adequate disk space for worktrees, images, artifacts, and database data
- Repository path and Git status
- Whether required environment variables exist without printing values

Each failed check gives a remediation category and documentation link. The doctor command never installs software itself.

### 4.2 Clone and install

The documented clean setup sequence is:

```bash
git clone <guarded-agent-remote>
cd guarded-agent
npm ci
npm run doctor:dev
npm run build
npm test
```

Replace the remote placeholder in published documentation with the actual repository URL before release. `npm ci` is required in CI and release verification; `npm install` is used only when intentionally changing dependencies.

### 4.3 Local data directory

Choose an OS-appropriate application data path through a small platform adapter. It contains:

```text
guarded-agent-data/
  config.json
  daemon/
    guardd.sock
    guardd.lock
  artifacts/
  runs/
  logs/
  diagnostics/
```

Create directories with owner-only permissions. Refuse startup if the data directory is group/world writable unless the user explicitly repairs permissions.

### 4.4 Environment template

Commit `.env.example` only after the provider milestone begins. It documents variable names without sample secrets:

```text
OPENAI_API_KEY=
GUARDED_AGENT_DATABASE_URL=
GUARDED_AGENT_DATA_DIR=
GUARDED_AGENT_LOG_LEVEL=info
```

The application does not automatically load arbitrary `.env` files from analyzed repositories. Development-only loading must target the Guarded Agent repository's known configuration path.

## 5. Dependency Installation Policy

### 5.1 Adding a dependency

Before installation, record:

- Problem being solved
- Why a standard library or existing narrow dependency cannot solve it
- Package owner and maintenance status
- License compatibility
- Transitive dependency count
- Install scripts
- Native code or binary downloads
- Security history relevant to use
- Exact runtime boundary where it is used
- Removal or replacement difficulty

Then:

1. Install with an exact version because `.npmrc` enables `save-exact`.
2. Review lockfile changes.
3. Inspect new lifecycle scripts.
4. Run unit, integration, and deterministic eval suites.
5. Update the dependency decision record.
6. Commit the manifest and lockfile together.

### 5.2 Allowed dependency categories

- Official OpenAI SDK for provider transport
- PostgreSQL driver
- Ajv for JSON Schema validation
- Maintained UUID/ULID generator
- TypeScript compiler and focused development tooling
- VS Code extension development/test packages in the extension workspace

### 5.3 Prohibited dependency substitutions

Do not add a library that replaces the learning and portfolio core:

- Agent loop framework
- General workflow engine
- Policy or authorization engine
- General job queue
- ORM
- Prebuilt agent evaluation platform
- Wrapper that executes shell commands from model text

An exception requires an ADR explaining why the project thesis remains intact.

### 5.4 Dependency updates

- Patch updates may be grouped after automated tests pass.
- Minor updates receive provider/schema/adapter contract tests.
- Major updates require an ADR or migration note.
- Security updates with reachable impact are prioritized and backported to supported releases.
- Lockfile-only updates are reviewed for unexpected package-source or integrity changes.

## 6. Local Infrastructure Installation

### 6.1 PostgreSQL development profile

Provide a Docker Compose profile once Phase 6 begins. It must:

- Pin PostgreSQL major version and image digest for reproducible CI
- Bind only to loopback when a host port is needed
- Use a dedicated database and non-superuser application role
- Store development data in a named volume
- Expose a health check
- Avoid default production credentials in published examples

Development setup flow:

1. Create a random local password through a setup command.
2. Store it in an owner-only Guarded Agent development config, not in Git.
3. Start the database profile.
4. Wait for the health check.
5. Create role and database if absent.
6. Run migrations under a migration role.
7. Connect as the restricted application role.
8. Run persistence and queue smoke tests.

### 6.2 Migration command policy

Commands:

- `npm run db:status`
- `npm run db:migrate`
- `npm run db:verify`
- `npm run db:rebuild-test`

Each migration has a numeric ID, name, checksum, and transaction policy. The migration table records ID, checksum, application version, and applied timestamp.

Never silently modify an already-applied migration. A checksum mismatch blocks startup and explains recovery options.

### 6.3 Sandbox image setup

Provide one reviewed base image for the flagship TypeScript fixture. Build steps:

1. Use a minimal maintained base image.
2. Pin the base image digest.
3. Install only Node, npm, Git if required inside the sandbox, and test utilities.
4. Create a non-root user with a fixed UID/GID strategy.
5. Remove package-manager caches.
6. Set a non-root default user.
7. Generate image metadata and SBOM.
8. Scan the image.
9. Record final digest in sandbox-profile configuration.

The agent cannot modify the trusted sandbox image during a run. Dependency installation occurs in the disposable worktree/container layer and requires approval.

### 6.4 Infrastructure cleanup

Document commands that separately remove:

- Stopped run containers
- Orphaned worktrees proven to belong to Guarded Agent
- Expired artifacts
- Development database volume
- Sandbox images

Default cleanup preserves the database and retained artifacts. Destructive full cleanup requires an explicit confirmation listing exact paths and Docker resources.

## 7. Configuration Validation

### 7.1 Startup sequence

At startup:

1. Determine data directory.
2. Validate directory ownership and permissions.
3. Load built-in defaults.
4. Load and validate user config.
5. Locate repository config and verify containment.
6. Merge configuration using documented precedence.
7. Parse and pin policy files.
8. Validate sandbox profiles and image digests.
9. Validate database connectivity and schema version when required.
10. Validate provider configuration without making a paid request.
11. Produce a redacted effective-config fingerprint.

Startup fails before any run is accepted if a required layer is invalid.

### 7.2 Configuration test cases

- Unknown keys
- Wrong primitive types
- Unsupported schema version
- Relative path escaping config root
- Duplicate policy IDs
- Missing policy file
- Invalid sandbox digest
- Unsupported tool capability
- Budget below safe minimum or above administrative maximum
- Invalid log level
- Environment secret accidentally present in printable configuration

## 8. Testing Policy

### 8.1 Purpose

Tests provide evidence for specific claims. Code coverage alone does not prove authorization, isolation, or recovery. Every security and durability guarantee maps to at least one deterministic test at the enforcement boundary.

### 8.2 Test categories

| Category | Scope | External dependencies | PR requirement |
|---|---|---|---|
| Unit | Pure functions and one module | None | Every PR |
| Golden | Parser, formatter, event and audit output | None | Every PR |
| Generative | Policies, paths, event sequences | None | Every PR with bounded seed set |
| Contract | Provider, tool, RPC, event schemas | Fake adapters | Every PR |
| Integration | PostgreSQL, Git, filesystem, Docker | Local service/container | Relevant PRs and main |
| End-to-end | CLI through final patch | Full local stack | Main and release |
| Adversarial | Bypass and malicious fixtures | Fake provider and sandbox | Every PR for deterministic set |
| Fault injection | Crash and partial failure | PostgreSQL and adapters | Main and relevant PRs |
| Performance | Latency, memory, throughput, artifact size | Controlled runner | Nightly and release |
| Compatibility | OS, Node, Git, PostgreSQL, Docker | Matrix runners | Main and release |
| Real-model eval | Stochastic task behavior | API credential and spend | Nightly/manual release gate |
| Manual UX | Terminal and extension workflows | Packaged build | Release candidate |

### 8.3 Test location and naming

- Unit tests live beside source as `*.test.ts`.
- Integration tests live in the package's `test/integration/` directory.
- Cross-package end-to-end tests live in `tests/e2e/`.
- Adversarial cases live in `evals/cases/` with synthetic fixtures under `fixtures/`.
- Golden outputs live under a named `testdata/` directory and require explicit review to update.
- Every regression test includes the issue or incident identifier in its title or metadata.

### 8.4 Determinism

Tests control:

- Clock
- ID generator
- Random seed
- Fake provider output
- Database time where practical through injected time or tolerance windows
- Sandbox image digest
- Fixture Git commit
- Process output and exit timing

If a test fails intermittently, quarantine is not the default response. Reproduce with its recorded seed, fix the race or timing assumption, and retain the failing seed as a regression.

### 8.5 Isolation

Each test receives unique:

- Temporary directory
- Repository fixture clone or worktree
- Database schema or database name
- Run IDs
- Socket path
- Artifact directory
- Worker IDs

Tests never share mutable global state. Cleanup runs in `finally`, while failure output preserves the exact location of intentionally retained diagnostics.

### 8.6 Unit test inventory

Contracts:

- ID parsing and generation
- Canonical JSON
- Hash stability
- Error serialization and redaction
- Exhaustive event type handling

Policy language:

- Every token and escape
- Unicode and byte/source spans
- Operator precedence
- Parentheses and prefix negation
- Multi-error recovery
- Formatter idempotence
- Type mismatch diagnostics
- Unknown attributes
- Deterministic precedence and tie breaking
- Secret-safe traces

Runtime:

- Legal transition for every state
- Illegal intent rejection
- Terminal-state immutability
- Budget accumulation
- Cancellation states
- Approval waiting and resumption
- Replay equality
- Unknown event-version failure

Context broker:

- Path normalization
- Component-wise root containment
- Symlink behavior
- Bounded line and byte reads
- UTF-8 validation
- Binary detection
- Secret detectors and redaction overlap
- Manifest hashes and token estimates
- Denied-content non-retention

Tool gateway:

- Schema rejection
- Unknown property rejection
- Semantic normalization
- Canonical action hashes
- Policy effect routing
- Approval binding
- Reconciliation decisions
- Output bounding and artifact fallback

### 8.7 Policy testing policy

Every policy file ships with table-driven cases covering:

- At least one matching example per rule
- At least one near miss per rule
- Deny precedence over allow
- Approval precedence over allow
- No-match default
- Equal-priority deterministic order
- Missing optional attributes
- Canonically equivalent paths and commands
- Policy snapshot immutability
- Old action-schema compatibility or explicit failure

Policy changes require simulation against the recorded adversarial action corpus. The pull request includes counts for newly allowed, newly denied, and newly approval-gated actions. Any newly allowed consequential action needs explicit review.

### 8.8 Generative and fuzz testing

Policy generator:

- Produces bounded valid ASTs
- Formats then parses them
- Compares ASTs after normalization
- Evaluates against generated attribute environments
- Compares optimized evaluator to a small reference interpreter

Path generator:

- Produces separators, dot segments, Unicode normalization, long names, reserved names, encoded traversal, symlink graphs, and prefix-collision roots
- Asserts accepted paths remain component-wise under root
- Asserts rejected paths never reach filesystem adapters

Event-sequence generator:

- Generates legal intents and injected duplicates
- Asserts stream versions remain gap-free
- Asserts terminal states do not return to active states
- Asserts one consequential command maximum in v1
- Asserts replay never invokes an effect adapter

Fuzz targets receive maximum input size and execution time. A crashing or hanging input is minimized and committed as a regression fixture.

### 8.9 PostgreSQL integration tests

- Append new stream
- Append expected-version success
- Concurrent expected-version conflict
- Gap and duplicate rejection
- Transaction rollback with no partial events
- Command insertion in the same transaction
- `SKIP LOCKED` claims across workers
- Heartbeat ownership
- Expired lease recovery
- Stale worker completion rejection
- Approval consume transaction
- Projection rebuild equality
- Migration from every supported schema fixture
- Connection loss and retry classification
- Database restart during leased command

Use real PostgreSQL, not an in-memory SQL substitute.

### 8.10 Git and filesystem integration tests

- Clean repository worktree creation
- Dirty repository refusal
- Detached worktree base commit
- Original checkout unchanged
- Patch path validation
- Patch check failure
- Changed-path set verification
- Executable-bit change handling
- Rename policy behavior
- Submodule and binary patch rejection
- Worktree retention and cleanup
- Orphan quarantine
- Repository path containing spaces and Unicode

### 8.11 Sandbox integration tests

- Non-root identity
- Read-only root filesystem
- Writable worktree only
- No host environment leakage
- No model API key
- No Docker socket
- Network denied
- Memory limit enforcement
- PID limit enforcement
- Timeout termination
- Child-process termination
- Output limit enforcement
- Image digest recorded
- Malicious package lifecycle script contained
- Host path outside worktree unreadable

Run the escape-oriented set only on isolated CI runners suitable for untrusted containers.

### 8.12 Provider contract tests

Use a fake SDK transport or recorded synthetic responses to cover:

- Text-only completion
- One complete function call
- Incremental tool-argument streaming
- Malformed JSON arguments
- Unknown tool
- Multiple tool calls despite disabled parallelism
- Usage report before or with completion
- Rate-limit error
- Authentication error
- Disconnect before transmission
- Ambiguous disconnect after transmission
- User cancellation
- Provider terminal incomplete state
- `store: false` present
- `parallel_tool_calls: false` present
- No denied context in serialized request

Real API smoke tests validate only the live adapter contract and curated task behavior. They do not replace fake contract tests.

### 8.13 Approval security tests

- Action hash mutation
- Tool version mutation
- Policy version mutation
- Base commit mutation
- Input file mutation
- Executable resolution mutation
- Sandbox image mutation
- Network profile mutation
- Expired approval
- Denied approval
- Consumed approval replay
- Approval from another run
- Two concurrent consume attempts
- Stale UI decision after a new request

Every case asserts the tool handler remains uncalled when validation fails.

### 8.14 Crash-recovery matrix

Inject a crash:

- Before command claim
- After claim before handler
- After approval consumption before tool start event
- After tool start before side effect
- During patch write
- After patch side effect before result event
- During process output
- After process exit before result event
- Before artifact rename
- After artifact rename before metadata insert
- Before model transmission
- After possible model transmission
- After provider completion before event append
- During projection update
- During client event delivery

For each point, define expected run state, eligible retry, reconciliation action, budget effect, artifact state, and user-visible explanation.

### 8.15 End-to-end suites

Deterministic smoke:

1. Initialize fixture repository.
2. Start runtime with fake provider and strict policy.
3. Request a small code change.
4. Observe reads and patch proposal.
5. Approve exact patch if policy requires it.
6. Run tests in sandbox.
7. Export final diff.
8. Replay events and compare state.
9. Confirm original checkout is unchanged.

Hostile flagship:

1. Seed prompt injection and fake credentials.
2. Request rate limiting.
3. Verify secret request denied.
4. Verify dependency installation requires approval.
5. Inject a worker crash.
6. Recover without duplicate effects.
7. Complete tests and patch.
8. Generate audit and eval report.

CLI/daemon:

1. Start daemon.
2. Create run through CLI.
3. Disconnect and reconnect from cursor.
4. Approve through another client.
5. Cancel a second run during a process.
6. Restart daemon and inspect both histories.

Extension:

1. Open trusted fixture workspace.
2. Start run from command palette.
3. Observe timeline.
4. Review and approve action.
5. Open native diff.
6. Close and reopen VS Code.
7. Resume from stored cursor.
8. Verify workspace-untrusted mode blocks execution.

### 8.16 Coverage policy

Coverage is a backstop:

- Pure policy, runtime reducer, canonicalization, and approval packages target at least 90% branch coverage after stabilization.
- Boundary adapters target all documented outcome classes rather than an arbitrary percentage.
- Every security invariant needs a named assertion independent of coverage.
- Coverage decreases require explanation and cannot hide untested denial/error branches.

Do not write meaningless tests solely to raise a metric.

### 8.17 Test review policy

A reviewer checks:

- Test fails before the intended fix when it is a regression
- Assertion observes the trusted boundary
- Fixture contains no real secret or private source
- Timeouts are bounded
- Cleanup is safe and target-specific
- Snapshot/golden changes are semantically reviewed
- No real provider call occurs in ordinary tests
- Failure output is redacted

## 9. Performance and Resource Testing

### 9.1 Budgets

Define performance budgets before optimization:

- CLI cold start
- Policy parse and evaluation for a representative policy set
- Context listing/search latency on small and large fixtures
- Event replay throughput
- Event append latency
- Command claim latency under worker contention
- Memory per active run
- Artifact write throughput
- Daemon idle memory
- Extension activation time

Record hardware, OS, dataset size, database configuration, and image digest with results.

### 9.2 Load scenarios

- One run with many read actions
- Many concurrent read-only runs
- Worker contention on pending commands
- Large event history replay
- Slow subscription client
- Large but bounded process output
- Large diff near configured limit
- Approval queue accumulation
- Artifact garbage collection with many unreferenced objects

### 9.3 Performance regression gate

PR CI runs small stable microbenchmarks only when relevant. Nightly jobs run larger scenarios. Release candidates compare medians and tail percentiles against a versioned baseline. A regression beyond threshold requires investigation or an accepted performance note.

## 10. CI Pipeline

### 10.1 Bootstrap CI

Before implementation packages exist, CI runs:

- Documentation link/fence/whitespace validation
- Secret scan
- License and repository-policy check

### 10.2 Implementation CI jobs

Add jobs in this order:

1. `static`: formatting, lint, forbidden imports, type check
2. `unit`: unit, golden, bounded generative tests
3. `contracts`: schemas, fake provider, RPC protocol
4. `postgres`: migrations, event store, queue, approvals
5. `git-filesystem`: worktree and patch integration
6. `sandbox-linux`: container restrictions and process lifecycle
7. `eval-deterministic`: full fake-provider adversarial suite
8. `e2e-cli`: packaged CLI against local daemon
9. `package`: produce but do not publish artifacts

Use job-specific permissions. Default GitHub token permissions to read-only. Upload only redacted test artifacts with short retention.

### 10.3 Secret-bearing workflows

Real-model evaluation runs only from protected branches, scheduled workflows, or manually approved environments. It never runs for forked pull requests. Apply:

- Hard token and currency budget
- Allowed model list
- Maximum case count
- Concurrency limit of one until spend behavior is established
- Provider request metadata for cost attribution
- Automatic cancellation when budget is reached

### 10.4 CI failure policy

- Deterministic test failure blocks merge.
- Known flaky test blocks release and receives an owner; it is not silently retried until green.
- Infrastructure outage may be rerun, with the original failure retained.
- Real-model statistical regression requires human review and does not overwrite the last passing baseline.
- Security scan findings are triaged by reachability, exploitability, and affected boundary.

## 11. User Installation Design

### 11.1 CLI distribution stages

Stage 1, source installation:

```bash
git clone <guarded-agent-remote>
cd guarded-agent
npm ci
npm run build
npm link
guard doctor
```

Stage 2, npm package after release hardening:

```bash
npm install --global <published-cli-package>
guard doctor
guard init
```

Stage 3, signed standalone binaries is optional and requires a maintained bundling, update, and signing process. Do not advertise standalone installation before macOS and Linux release artifacts are tested from clean machines.

### 11.2 First-run flow

`guard init` performs only project-local, reversible setup:

1. Confirm current Git repository.
2. Show files it proposes to create.
3. Create `.guarded-agent/config.json` with safe defaults.
4. Create `policies/default.guard` if absent.
5. Add recommended run-artifact paths to `.gitignore` only with confirmation.
6. Run policy check.
7. Run environment doctor.
8. Explain that provider credentials are not required for fake-provider demo.

Do not automatically start Docker, install PostgreSQL, create a Git commit, or make a paid model call.

### 11.3 Daemon installation

Initial releases support foreground start for transparency:

```bash
guard daemon start --foreground
```

Background service integration comes after lifecycle behavior is reliable:

- `launchd` user agent on macOS
- `systemd --user` service on Linux

Service install commands print and require confirmation for the exact service file. Uninstall stops the service and removes only Guarded Agent-owned service definitions.

### 11.4 VS Code extension installation

Development:

1. Build daemon and extension.
2. Start VS Code extension development host.
3. Configure path to local daemon build.
4. Run integration fixture.

Release candidate:

1. Package VSIX.
2. Install VSIX into a clean VS Code profile.
3. Verify engine compatibility.
4. Run trusted and untrusted workspace flows.
5. Verify uninstall leaves daemon data intact and explains separate deletion.

Marketplace publication requires privacy disclosure, permissions explanation, screenshots without secrets, support URL, and version matching the daemon protocol compatibility range.

## 12. Upgrade and Migration

### 12.1 Versioning

Use semantic versioning after the first public release:

- Patch: compatible bug/security fix
- Minor: backward-compatible capability, event upcaster, policy syntax addition, or RPC method
- Major: incompatible CLI, policy, event, data, or daemon protocol change

Before 1.0, still document breaking changes explicitly and avoid unnecessary churn in persisted formats.

### 12.2 Upgrade preflight

Before upgrading:

1. Confirm no active consequential tools or pause new run creation.
2. Record current application and schema versions.
3. Verify database backup when migration is nontrivial.
4. Verify artifact directory accessibility and free space.
5. Check daemon/client compatibility.
6. Validate migration checksums.
7. Produce a dry-run migration plan.

### 12.3 Database migration

Use expand/migrate/contract:

1. Expand schema with backward-compatible columns/tables.
2. Deploy code capable of reading old and new representations.
3. Backfill in bounded resumable batches with progress events.
4. Verify counts, hashes, and replay.
5. Switch reads to new representation.
6. Remove old representation only in a later release after rollback window closes.

Large backfills do not run inside one transaction. Each batch is idempotent and records a cursor.

### 12.4 Policy and event migration

- Policies include language version and receive an explicit formatter/migrator.
- Event payloads upcast in memory; historical rows remain unchanged.
- RPC performs capability negotiation so an older client receives a clear incompatibility response.
- Eval fixtures include histories from supported older versions.

### 12.5 Rollback

Application rollback is permitted only while the old binary can read the expanded schema and newer event types. Release notes state the last safe rollback point.

If an irreversible migration has begun:

- Stop new work
- Preserve database and artifacts
- Restore from verified backup into a separate environment
- Reconcile external/local side effects from the event ledger
- Never overwrite the only affected database during diagnosis

## 13. Backup and Restore

### 13.1 Backup scope

Back up together:

- PostgreSQL database
- Artifact directory
- Policy snapshots
- Application configuration excluding externally stored credentials
- Release/compatibility metadata

The database and artifact snapshot need a shared backup ID and cutoff position so references are consistent.

### 13.2 Restore test

At release checkpoints:

1. Create synthetic completed, active, approval-waiting, and failed runs.
2. Take backup.
3. Restore into an isolated directory and database.
4. Run migrations if required.
5. Rebuild projections.
6. Verify artifact hashes.
7. Inspect audit timelines.
8. Resume only the synthetic active run.
9. Confirm no completed side effect repeats.

A backup is not considered valid until restore is tested.

## 14. Data Retention and Privacy

### 14.1 Data classes

- Event metadata
- Provider-visible context metadata
- Optional released-content artifacts
- Source-code patches
- Process output
- Policy snapshots
- Approval identities
- Eval results
- Operational logs

For each class, document purpose, default retention, deletion mechanism, and whether it may contain source code or personal data.

### 14.2 Defaults

- Denied secret content: never retained
- API keys: never retained
- Event metadata: retained with run until deletion
- Worktrees: short retention after terminal state for review
- Large process output: shorter retention than audit metadata
- Eval baselines: retained while referenced
- Operational logs: rotating local retention with size cap

Provider-side storage is disabled by default where supported.

### 14.3 Run deletion

Deletion is a deliberate command with dry run:

1. Resolve exact run.
2. List worktree, events, approvals, artifacts, and eval references.
3. Refuse if artifacts are shared with retained baselines unless `--detach-shared` behavior is defined.
4. Stop active work.
5. Delete or tombstone database records according to audit policy.
6. Remove unreferenced artifacts.
7. Remove owned worktree.
8. Record local deletion receipt outside deleted run data if configured.

The portfolio local version may choose hard deletion because there is no organizational compliance requirement. It must state that choice.

## 15. Troubleshooting and Diagnostics

### 15.1 Doctor categories

- `host`
- `git`
- `database`
- `sandbox`
- `provider`
- `policy`
- `daemon`
- `filesystem_permissions`
- `disk_capacity`

Each check returns stable code, severity, message, safe evidence, and remediation URL or command.

### 15.2 Common failure runbooks

Document procedures for:

- Daemon socket exists but process is absent
- PostgreSQL unavailable
- Migration checksum mismatch
- Worktree cannot be created
- Worktree cleanup interrupted
- Docker daemon unavailable
- Sandbox image digest missing
- Provider authentication failure
- Provider rate limit
- Approval invalidated repeatedly
- Run stuck with expired lease
- Artifact hash mismatch
- Projection mismatch
- CLI/daemon protocol incompatibility
- Extension cannot reconnect
- Disk full during artifact write

Each runbook starts with non-mutating inspection, identifies exact safe repair actions, and labels any data-destructive step.

### 15.3 Diagnostic bundle verification

Seed fake secrets in environment, config, repository, provider error, tool output, and policy-denied content. Generate a diagnostic bundle and scan every byte for those seeds. The test fails if any seed appears.

## 16. Incident Response

### 16.1 Severity

- Critical: sandbox escape, credential exfiltration, unauthorized host mutation
- High: policy bypass enabling consequential action, approval replay, cross-run data exposure
- Medium: audit omission, denial-of-service without host compromise, incorrect policy explanation
- Low: non-security defect with limited operational impact

### 16.2 Response steps

1. Stop or disable affected capability.
2. Preserve events, logs, artifacts, configuration fingerprints, and exact release.
3. Rotate exposed credentials through their owning system.
4. Create a synthetic minimal reproduction.
5. Identify the failed trust boundary and why tests missed it.
6. Implement fix and deterministic regression test.
7. Review adjacent representations and tools for the same bypass class.
8. Publish advisory and patched release when public users are affected.
9. Write a postmortem with timeline, impact, root cause, corrective actions, and residual risk.

Do not include real secrets or private repository content in public advisories.

## 17. Release Readiness Checklist

### 17.1 Deterministic MVP

- Product and non-goals approved
- Threat model reviewed
- Domain dependency test passing
- Event envelope versioned
- Reducer replay deterministic
- Fake provider contract enforced
- Virtual tools complete
- CLI vertical slice completes fixture task
- Documentation and clean install verified

### 17.2 Policy/context release gate

- Grammar documented
- Lexer/parser/type checker/evaluator tests passing
- Policy formatter idempotent
- Simulation output reviewed
- Path and secret corpus passing
- Denied content absent from provider captures and artifacts
- Tool handlers unreachable after denial
- At least 25 policy cases

### 17.3 Sandbox release gate

- Worktree ownership verified
- Original checkout unchanged in all lifecycle tests
- Container runs non-root and without network
- Resource and output limits verified
- Process tree terminates on timeout/cancel
- Host credentials absent
- Patch artifact and resulting paths verified
- Escape regression suite passing

### 17.4 Provider release gate

- Official SDK adapter contract tests passing
- Storage disabled by default
- Parallel calls disabled
- Usage and budgets recorded
- Ambiguous requests visible
- Fake key leak test passing
- Credentialed smoke suite spend bounded
- Provider outage behavior documented

### 17.5 Durable CLI v1 gate

- Migrations verified from clean and prior schemas
- Concurrent append conflicts tested
- Worker lease matrix passing
- Approval preconditions and replay tests passing
- Crash matrix passing
- Projection rebuild equality passing
- 40 or more adversarial cases passing
- Packaged CLI tested on macOS and Linux
- Flagship demo reproducible
- Claims tied to measured results

### 17.6 Editor release gate

- Daemon protocol versioned
- Subscription race and reconnect tested
- CLI and extension share one run
- Workspace trust enforced
- Webview CSP and message validation passing
- Native diff uses read-only virtual documents
- API key absent from extension storage
- VSIX clean-profile installation tested
- Marketplace disclosures complete

## 18. Portfolio Quality Gate

Before presenting the project:

- README leads with the problem and proof, not a feature list.
- Architecture diagram shows trust boundaries.
- Demo uses synthetic data and a deterministic fallback.
- Security claims state limitations.
- Eval report is checked into a release or linked artifact.
- Benchmarks identify environment and corpus.
- One crash-recovery scenario is visible.
- One denied-context scenario proves the secret never reached the provider.
- Commit history shows incremental engineering decisions.
- Issues and milestones reflect planned versus implemented status.
- Resume claims use measured counts and outcomes.

## 19. Exhaustiveness Audit

Before each milestone closes, inspect the feature inventory and confirm that every feature has answers for:

- User entry point
- Input schema
- Input normalization
- Trust classification
- Policy decision
- Approval behavior
- Execution adapter
- Isolation boundary
- Event history
- Persistence transaction
- Idempotency or reconciliation
- Retry behavior
- Cancellation behavior
- Timeout behavior
- Budget behavior
- Output bounding
- Secret handling
- Human-readable audit
- Machine-readable output
- Unit tests
- Integration tests
- Adversarial tests
- Fault-injection test
- Performance limit
- Configuration
- Installation impact
- Upgrade impact
- Rollback impact
- Retention and deletion
- Documentation
- Residual risk

A blank answer means the feature is not ready. “Not applicable” must include a reason and be reviewed for security-sensitive fields.
