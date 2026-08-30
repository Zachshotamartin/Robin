# Guarded Agent: Threat Model

## 1. Scope and Security Objective

The threat model covers a local coding-agent runtime that sends selected context to a hosted model, receives proposed tool calls, applies policy and approval decisions, executes bounded work in a disposable worktree/container, and persists audit/recovery state.

Primary objective: prevent an untrusted model, malicious repository, malformed provider response, or stale client from obtaining context or causing effects beyond the authority represented by the pinned policy, exact approval, and sandbox profile.

This is not a claim that containers defeat every kernel exploit or that a local administrator cannot tamper with their own data.

## 2. Assets

### 2.1 High-value assets

- Source code, including unreleased work
- Repository history and protected branches
- Environment variables and local credential files
- Provider API keys and spend allowance
- SSH agent, cloud credentials, package-registry credentials, and Git credentials
- Host filesystem outside the disposable worktree
- Host network identity and reachable internal services
- Policy definitions and immutable snapshots
- Approval identity and decision integrity
- Event history and artifact integrity
- Sandbox images and execution configuration
- Eval baselines and security claims

### 2.2 Availability assets

- Developer machine CPU, memory, disk, and process table
- Provider quota and monetary budget
- PostgreSQL availability
- Daemon and local socket
- Ability to cleanly inspect, cancel, and recover runs

## 3. Actors

- Legitimate local developer
- Legitimate policy/security reviewer
- Untrusted hosted model output
- Malicious or compromised repository author
- Malicious dependency or package lifecycle script
- Compromised provider or network response
- Stale or buggy CLI/editor client
- Other unprivileged local process
- Malicious local administrator, outside the defendable local boundary
- Vulnerable third-party dependency or sandbox image

## 4. Trust Assumptions

- Operating system, container runtime, Git, PostgreSQL, Node runtime, and standard cryptographic implementation are trusted within documented limits.
- The local user invoking Guarded Agent is authorized to inspect the selected repository.
- A local administrator can defeat local controls and is not fully contained.
- Hosted provider receives context explicitly released to it; confidentiality after release depends on provider terms and configuration.
- Container isolation reduces risk but does not prove resistance to unknown kernel/runtime vulnerabilities.
- The original Git repository may contain malicious content but Git itself is treated as a trusted primitive.

## 5. Trust Boundaries

```text
Boundary A: User terminal/editor -> local daemon
Boundary B: Local daemon -> hosted provider
Boundary C: Repository/worktree -> context broker
Boundary D: Provider tool call -> tool gateway
Boundary E: Tool gateway -> policy and approval services
Boundary F: Tool gateway -> sandbox/container
Boundary G: Runtime -> PostgreSQL and artifact store
Boundary H: Daemon -> CLI/VS Code subscribers
Boundary I: Build/release system -> distributed packages and images
```

Every boundary has versioned input, size limits, validation, safe errors, and audit identity.

## 6. Data Flows

### 6.1 Run creation

User objective, repository path, configuration, and budgets cross Boundary A. Daemon resolves repository and configuration, pins trusted snapshots, and stores run events across Boundary G.

### 6.2 Model request

Context broker reads repository data across Boundary C, applies policy/redaction, and sends a selected model request across Boundary B. Provider credentials remain in the daemon.

### 6.3 Tool request

Provider output returns across Boundary B and D. Gateway validates, canonicalizes, policy evaluates, optionally obtains approval across Boundary A/E, and dispatches across Boundary F.

### 6.4 Result and audit

Sandbox output returns through Boundary F, is bounded and filtered, persists across Boundary G, then becomes a model-safe observation across Boundary B and human event view across Boundary H.

## 7. Threats by Attack Surface

### 7.1 Repository content and prompt injection

Threats:

- Source comments instruct model to exfiltrate secrets
- Filenames or test output contain instructions
- README claims higher authority
- Malicious code causes misleading error output
- Large files exhaust context or memory
- Encoded or split secrets evade simple classifiers

Controls:

- Repository content labeled untrusted
- Context tools only; no whole-repository upload
- Path policy before open
- Content classification and budgets
- Model has no direct capability
- Tool output crosses broker before model
- Deterministic policy/gateway enforcement independent of prompt obedience

Evidence:

- Hostile fixture provider-input captures
- Secret hashes absent from requests/artifacts
- Injection text can influence proposals but cannot bypass denied gateway actions

Residual risk:

- Allowed source may contain confidential information not classified as a secret
- A model may infer sensitive facts from legitimately released context

### 7.2 Paths and filesystem

Threats:

- `../` traversal
- Absolute, UNC, drive, Unicode, or encoded alternate paths
- Prefix collision such as `/repo` versus `/repo2`
- Symlink or hard-link escape
- Time-of-check/time-of-use replacement
- Special files, devices, sockets, or FIFOs
- Excessive file size or sparse-file behavior

Controls:

- Repository-relative model paths
- Component-wise containment
- `realpath`, `lstat`, `fstat`, type checks, and content hashes
- Immutable Git-object reads for baseline tracked files
- Bounded streaming reads
- Special-file denial
- Disposable worktree with controlled writers
- Approval preconditions bind file hashes

Evidence:

- Generated path corpus
- Symlink graph fixtures
- Handler spy proves rejected paths never open
- Race tests where supported

Residual risk:

- Cross-platform filesystem semantics differ
- Local administrator can replace or inspect local resources

### 7.3 Tool arguments and command injection

Threats:

- Malformed JSON
- Unknown schema properties
- Shell metacharacters
- Executable substitution through `PATH`
- Environment-variable injection
- Argument ambiguity
- Tool-name collision or downgrade

Controls:

- Strict JSON Schema
- Semantic normalization
- Fixed tool name/version advertised per request
- Resolved executable identity
- `spawn` with `shell: false`
- Minimal constructed environment
- Policy and approval over normalized action
- Execution receives same immutable object

Evidence:

- Injection corpus
- Executable mutation invalidates approval
- Unknown tool/version fails closed

### 7.4 Patch manipulation

Threats:

- Patch writes outside worktree
- Binary or submodule changes hide payload
- Patch changes different paths than reviewed
- Model regenerates patch after approval
- Hooks or filters execute during Git operations
- Patch partially applies before failure

Controls:

- Parse and bound exact patch bytes
- Reject unsupported patch classes
- Store content-addressed patch artifact
- `git apply --check`
- Disable hooks where applicable and use controlled environment
- Apply exact approved bytes
- Verify changed-path set and postimage hashes
- Reset only disposable worktree on verification failure

Evidence:

- Malicious patch fixtures
- Approved hash equals executed artifact hash
- Original checkout comparison

### 7.5 Sandbox and process execution

Threats:

- Dependency script reads host secrets
- Network exfiltration
- Fork bomb, memory exhaustion, disk exhaustion
- Child survives cancellation
- Container accesses engine socket
- Privilege escalation or capability abuse
- Malicious image or mutable tag
- Host mount broader than worktree

Controls:

- Reviewed image pinned by digest
- Non-root user, dropped capabilities, no-new-privileges
- Read-only root and narrow worktree mount
- Network none
- CPU, memory, PID, tmpfs, time, and output limits
- No credential or engine-socket mounts
- Container-level stop/kill
- Image scanning and SBOM

Evidence:

- Sandbox integration suite
- Network and host-path probes
- Resource exhaustion fixtures on isolated runners

Residual risk:

- Container runtime or kernel vulnerability
- Intentional writable worktree may contain damage within run scope
- Docker Desktop host-mount behavior depends on platform

### 7.6 Policy language and evaluator

Threats:

- Ambiguous precedence
- Unknown attribute treated as false and accidentally allowed
- Glob mismatch or catastrophic pattern behavior
- Policy edit changes active run
- Explanation differs from enforced decision
- Candidate simulation executes effects
- Canonicalization mismatch between evaluator and executor

Controls:

- Small grammar and closed attribute catalog
- Type checking before load
- Deterministic precedence and default deny
- Compiled immutable snapshots pinned to runs
- Trace produced by evaluator execution
- Pure side-effect-free simulation
- Shared normalized action object

Evidence:

- Reference evaluator generative comparison
- Golden traces
- Policy mutation/pinning tests
- Simulation adapter spies remain unused

### 7.7 Approval flow

Threats:

- User approves vague description
- Arguments change after approval
- Worktree changes after review
- Approval replayed in another run
- Expired approval consumed
- Two workers consume once
- Compromised UI claims approval exists
- User identity spoofed by another local process

Controls:

- Display derived from normalized action
- Action and precondition hashes
- Run/tool/policy binding
- One-time transactional consumption
- Database-time expiry
- Daemon revalidation
- Owner-only socket permissions
- Stronger local session authentication if TCP or multi-user support appears

Evidence:

- Full approval mutation matrix
- Concurrent consumption test
- Stale client test

Residual risk:

- Single-user local identity is bounded by OS account security
- A user may knowingly approve a harmful exact action

### 7.8 Provider interaction

Threats:

- Provider sees denied content through request construction bug
- API key leaks into event or sandbox
- Malformed stream or tool call
- Multiple parallel calls bypass serial assumption
- Ambiguous request causes duplicate cost or divergent plan
- Provider-side retention exceeds expectation
- Cost exhaustion

Controls:

- Captured-request tests
- Central credential handling and redaction
- Provider event normalization and strict terminal validation
- Parallel calls disabled and unexpected batches rejected
- Uncertain-attempt events and explicit retry budget
- Storage disabled by default where supported
- Turn/token/tool/time/cost budgets

Evidence:

- Fake provider contract suite
- Seeded-key scan
- Budget exhaustion tests
- Official provider configuration inspection

Residual risk:

- Provider service behavior and retention outside local control
- Unknown actual cost after ambiguous failure

### 7.9 Durable execution

Threats:

- Duplicate side effect after crash
- Two workers own same work
- Stale worker records completion
- Event gap or overwrite
- Projection diverges
- Retry hides policy or budget change
- Replay calls external adapter

Controls:

- Optimistic append
- Transactional command creation
- Leases using database time
- Owner-checked heartbeat/completion
- Tool-specific reconciliation
- Pinned policy and action hashes
- Pure reducer replay
- Projection rebuild comparison

Evidence:

- Crash matrix
- Concurrent worker tests
- Adapter spies during replay
- Historical event fixture migration

### 7.10 Database and artifact store

Threats:

- Event or artifact tampering
- Secret stored in JSON/logs
- Path traversal in artifact location
- Orphaned artifact fills disk
- Backup mismatch between DB and files
- SQL injection

Controls:

- Parameterized SQL
- Payload schemas and hashes
- Content-addressed internal paths
- Central redaction
- Size/retention limits and GC
- Shared backup cutoff ID
- Optional hash chain described as tamper-evident

Evidence:

- Artifact path tests
- Seeded-secret bundle scan
- Restore test
- Tamper diagnostic test

Residual risk:

- Local administrator controlling database and filesystem can replace full histories

### 7.11 Daemon and clients

Threats:

- Unauthorized local client
- Socket permission weakness
- Oversized JSON-RPC body
- Duplicate mutating request
- Slow-client memory exhaustion
- Cursor skips or duplicates events
- Extension webview injection
- Workspace-trust bypass

Controls:

- Owner-only Unix socket
- Framing/body limits and schema validation
- Client request idempotency
- Durable cursors and bounded buffers
- Webview CSP, nonce, message schema
- Daemon remains enforcement point
- Workspace trust before run creation

Evidence:

- RPC fuzz/size tests
- Duplicate request tests
- Slow subscriber test
- Extension CSP/trust tests

### 7.12 Supply chain and release

Threats:

- Compromised npm package
- Dependency lifecycle script
- Mutable CI action tag
- Malicious sandbox base image
- Stolen publishing credential
- Built artifact differs from reviewed source

Controls:

- Exact dependency versions and lockfile review
- Dependency decision records
- Pinned CI actions and least privilege
- Image digest, scan, and SBOM
- Protected publishing environment
- Signed tags/artifacts when release begins
- Build and eval release artifact in CI

Evidence:

- Lockfile/source checks
- Provenance and checksums
- Clean-machine install test

## 8. Abuse Cases

| Abuse case | Expected outcome |
|---|---|
| Repository asks model to read `.env` | Broker denies before content release |
| Model calls unknown `shell` tool | Gateway rejects unknown tool |
| Model puts `; curl` in argv item | No shell interpretation; policy sees literal normalized argv |
| Package install tries network under default profile | Container network fails; action was approval-gated |
| User approves patch, file changes before apply | Preconditions mismatch and approval invalidates |
| Worker dies after patch application | Reconciliation detects postimage and does not reapply |
| Provider returns two tool calls | Turn fails closed under serialized v1 semantics |
| Extension sends forged approval | Daemon checks live request, identity, expiry, and preconditions |
| Slow client stops reading events | Subscription closes with resumable cursor |
| Process emits gigabytes of output | Stream truncates to bounded artifact and process limit applies |
| Artifact path contains traversal | Internal content-addressed path ignores untrusted filename |
| Replay runs completed history | Reducer rebuilds state without adapter calls |

## 9. Security Invariants and Tests

| Invariant | Primary test |
|---|---|
| No denied bytes enter provider input | Seeded content hash exclusion test |
| No denied action reaches handler | Gateway handler spy test |
| No stale approval executes | Preconditions mutation matrix |
| No original checkout mutation | Before/after Git and filesystem comparison |
| No replayed side effect | Replay with all effect adapters configured to throw |
| No duplicate recovered patch | Crash-after-apply fault case |
| No API key serialization | Seeded-key scan of events, logs, artifacts, RPC, extension state |
| No network in default sandbox | Connection probes in container |
| No unbounded boundary allocation | Oversize path, RPC, tool output, diff, and provider stream tests |

## 10. Residual Risk Register

- Unknown container/kernel escape
- Allowed source contains sensitive material not recognized by policy
- User approves an exact but harmful action
- Hosted provider retains or processes released data according to external service behavior
- Local administrator tampers with full database and artifact history
- Package-manager scripts exploit a vulnerability inside the sandbox stack
- Cross-platform path or filesystem behavior differs from tested systems
- Model call outcome/cost remains unknowable after some network failures
- Classification and redaction produce false negatives or false positives

Each release reviews the register, links mitigations completed, and avoids stronger claims than evidence supports.

## 11. Review Cadence

Review this threat model:

- Before real provider integration
- Before process or network tool addition
- Before PostgreSQL durability release
- Before VS Code publication
- Before any remote or multi-user deployment
- After every security incident or bypass
- At each public minor or major release

A threat-model change that adds an asset, boundary, actor, or residual risk must update the corresponding adversarial test plan.
