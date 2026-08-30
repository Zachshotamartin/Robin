# Guarded Agent: Threat Model

## 1. Scope and Security Objective

The threat model covers a local general agent runtime that releases selected context to an interchangeable model or external agent, receives proposed capability actions and outcomes, applies policy and approval decisions, executes bounded effects through profile-specific adapters, and persists audit/recovery state. Coding worktrees and containers are the highest-risk reference profile; local-corpus research is the non-coding reference profile.

Primary objective: prevent an untrusted agent/model, malicious source, malformed provider/protocol response, compromised adapter, or stale client from obtaining context or causing effects beyond the authority represented by the pinned task profile, policy, exact approval, compatibility tier, and execution profile.

This is not a claim that containers defeat every kernel exploit or that a local administrator cannot tamper with their own data.

## 2. Assets

### 2.1 High-value assets

- Source code, documents, datasets, structured records, media, and derived artifacts, including unreleased work
- Repository history and protected branches
- Environment variables and local credential files
- Provider/API credentials, credential-store references, endpoint origin bindings, and spend allowance
- SSH agent, cloud credentials, package-registry credentials, and Git credentials
- Host filesystem outside the disposable worktree
- Host network identity and reachable internal services
- Policy definitions and immutable snapshots
- Approval identity and decision integrity
- Event history and artifact integrity
- Sandbox images and execution configuration
- Eval baselines and security claims
- Task-profile, driver, model-capability, context-source, capability-pack, protocol-mapping, and compatibility-tier integrity

### 2.2 Availability assets

- Developer machine CPU, memory, disk, and process table
- Provider quota and monetary budget
- PostgreSQL availability
- Daemon and local socket
- Ability to cleanly inspect, cancel, and recover runs

## 3. Actors

- Legitimate local developer
- Legitimate policy/security reviewer
- Untrusted hosted/local model output
- Untrusted or compromised external agent process/service
- Malicious or compromised source author, including repository or document content
- Malicious dependency or package lifecycle script
- Compromised provider, custom endpoint, protocol peer, or network response
- Stale or buggy CLI/editor client
- Other unprivileged local process
- Malicious local administrator, outside the defendable local boundary
- Vulnerable third-party dependency or sandbox image

## 4. Trust Assumptions

- Operating system, container runtime, Git, PostgreSQL, Node runtime, and standard cryptographic implementation are trusted within documented limits.
- The local user invoking Guarded Agent is authorized to inspect the selected repository.
- A local administrator can defeat local controls and is not fully contained.
- A remote provider or hosted agent receives context explicitly released to it; confidentiality after release depends on its terms, implementation, and configuration.
- In-process provider/agent/capability adapters are trusted supply-chain code; unreviewed or task-supplied executable adapters are not loaded.
- MCP/ACP capability metadata and permission messages are untrusted protocol input, not authorization evidence.
- Container isolation reduces risk but does not prove resistance to unknown kernel/runtime vulnerabilities.
- The original Git repository may contain malicious content but Git itself is treated as a trusted primitive.

## 5. Trust Boundaries

```text
Boundary A: User terminal/editor -> local daemon
Boundary B: Local daemon -> hosted provider
Boundary C: Source adapters -> context broker
Boundary D: Agent/model/protocol action proposal -> capability gateway
Boundary E: Capability gateway -> policy and approval services
Boundary F: Capability gateway -> effect adapter/sandbox
Boundary G: Runtime -> PostgreSQL and artifact store
Boundary H: Daemon -> CLI/VS Code subscribers
Boundary I: Build/release system -> distributed packages and images
Boundary J: Daemon -> OS credential store and credential-aware transport
Boundary K: Daemon -> external ACP/MCP/CLI/hosted agent
```

Every boundary has versioned input, size limits, validation, safe errors, and audit identity.

## 6. Data Flows

### 6.1 Run creation

User objective, task profile, source bindings, agent/model selection, credential reference, configuration, and budgets cross Boundary A. Daemon resolves installed adapters and configuration, pins trusted manifests/snapshots, and stores run events across Boundary G.

### 6.2 Model request

Context broker reads source data across Boundary C, applies policy/redaction/transformation, and sends a selected driver request across Boundary B or K. Provider credentials cross only Boundary J inside the trusted transport and never enter the driver semantic request.

### 6.3 Tool request

Agent/model output returns across Boundary B/K and D. Gateway validates, canonicalizes, policy evaluates, optionally obtains approval across Boundary A/E, and dispatches across Boundary F.

### 6.4 Result and audit

Effect output returns through Boundary F, is bounded and filtered, persists across Boundary G, then becomes an agent-safe observation across Boundary B/K and human event view across Boundary H.

## 7. Threats by Attack Surface

### 7.1 Source content and prompt injection

Threats:

- Source comments instruct model to exfiltrate secrets
- Filenames or test output contain instructions
- README claims higher authority
- Malicious code causes misleading error output
- Large files exhaust context or memory
- Encoded or split secrets evade simple classifiers

Controls:

- All repository/document/dataset/media content and identifiers labeled untrusted
- Context-broker access only; no implicit whole-source upload
- Path policy before open. Repository capability normalization is provider-byte-free,
  exposes every canonical scalar or multi-path input to policy, and defers
  existence, range, source-hash, and preimage checks until authorized execution.
- Content classification and budgets
- Model has no direct capability
- Capability output crosses broker before agent/model
- Deterministic policy/gateway enforcement independent of prompt obedience

Evidence:

- Exact serialized provider-request captures from hostile fixtures
- Raw, encoded, split, filename, search-output, and transformed synthetic canaries absent from requests and artifacts
- Counting-provider evidence proves mixed safe/secret search and multi-section
  diff denial performs zero content opens or reads before handler dispatch
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
- A failed later patch rolls back earlier accepted work
- A test or build mutates accepted source outside the patch gateway

Controls:

- Parse and bound exact patch bytes
- Reject unsupported patch classes
- Store content-addressed patch artifact
- `git apply --check`
- Disable hooks where applicable and use controlled environment
- Apply exact approved bytes
- Verify changed-path set and postimage hashes
- Create a trusted internal checkpoint after each accepted write
- Restore only the pre-action checkpoint on verification failure
- Run untrusted processes in disposable snapshots that are never merged back
- Reject unsupported repository filters, transformations, submodules, and LFS checkout behavior

Evidence:

- Malicious patch fixtures
- Approved hash equals executed artifact hash
- Original checkout comparison
- Multi-patch test proves later rollback preserves earlier checkpoint
- Hostile process mutates its snapshot while authoritative checkpoint stays unchanged

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
- Writable authoritative worktree lets subprocess bypass patch review
- Live Git pointer exposes or mutates the source repository's common Git directory

Controls:

- Reviewed image pinned by digest
- Non-root user, dropped capabilities, no-new-privileges
- Read-only root and narrow disposable execution-snapshot mount
- No live Git metadata and no authoritative-worktree mount
- Network none
- CPU, memory, PID, tmpfs, time, and output limits
- No credential or engine-socket mounts
- Container-level stop/kill
- Image scanning and SBOM

Evidence:

- Sandbox integration suite
- Network and host-path probes
- Resource exhaustion fixtures on isolated runners
- Snapshot source-mutation test and authoritative checkpoint comparison

Residual risk:

- Container runtime or kernel vulnerability
- Intentional writable execution snapshot may contain damage until it is discarded
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
- Three-valued missing-attribute logic, explicit presence tests, deny-overrides combination, and default deny
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
- Credential leaks into event, query, redirect, diagnostic, protocol message, child process, or sandbox
- Malformed stream or tool call
- Multiple parallel calls bypass serial assumption
- Ambiguous request causes duplicate cost or divergent plan
- Provider-side retention exceeds expectation
- Cost exhaustion
- Stateless reconstruction drops required call IDs, ordering, or opaque reasoning items
- Metadata-only retention is mistaken for durable replay capability

Controls:

- Captured-request tests
- OS credential store, origin-bound credential-aware transport, redirect denial, fixed auth strategies, and redaction
- Provider event normalization and strict terminal validation
- Parallel calls disabled and unexpected batches rejected
- Uncertain-attempt events and explicit retry budget
- Storage disabled by default where supported
- Turn/token/tool/time/cost budgets
- Lossless provider-protocol item storage alongside the safe semantic transcript
- Local authenticated encryption for durable transcripts
- Explicit non-resumable behavior for metadata-only process loss
- Local custom-function-call budget independent of provider built-in-tool limits

Evidence:

- Synthetic provider contract suite shared across every adapter
- Seeded credential canary scan across every serialized and child-process surface
- Budget exhaustion tests
- Official provider configuration inspection
- Multi-turn stateless reasoning-continuity contract test
- Durable and metadata-only restart behavior tests

Residual risk:

- Provider service behavior and retention outside local control
- Unknown actual cost after ambiguous failure

### 7.8a Model capabilities and modalities

Threats:

- Runtime advertises tools to a model that cannot safely return structured calls
- Prose, code fences, or JSON-looking text is parsed into an executable action
- Provider/model silently executes a server-side shell, browser, file, or code tool
- Parallel calls create approval or causality ambiguity
- Unsupported roles, media, or continuation data are dropped or reordered
- Image/audio/document transformation reveals denied bytes, metadata, hidden pages, or steganographic content
- Embedding/reranker/classifier score is mistaken for authorization

Controls:

- Pinned adapter/model capability manifest validated before any credentialed content request
- Native-call, strict-schema, and text-only modes with no prose-to-action parser
- Only client-executed declared operations in Tier A; provider-executed capabilities disabled unless separately modeled
- Consequential action serialization and rejection of unexpected batches
- Lossless ordered provider items and conformance corpus per model/profile
- Bounded, policy-checked deterministic media transforms with source/released/transformed/provider-visible hashes and metadata stripping
- Model-service scores are untrusted data and cannot set policy or approval state

Evidence:

- Cross-provider golden request/stream/continuation fixtures
- Adversarial text that resembles commands produces no action event or handler call
- Multimodal canary and metadata corpus
- Capability-manifest mismatch fails before provider transmission

Residual risk:

- Provider behavior can change outside the pinned client contract
- Secret classification in complex media can miss content; unsupported transforms must remain disabled

### 7.8b Credentials and custom endpoints

Threats:

- Malicious adapter reads arbitrary stored credentials
- Endpoint redirects authentication to another origin
- User-configured headers/query parameters smuggle or expose secrets
- SDK debug hooks, proxy errors, request dumps, or crash reports serialize auth
- Environment inheritance leaks keys to external agents or containers
- Rotation/removal races create confusing or unauthorized attempts
- A nominally compatible endpoint behaves differently from the claimed dialect

Controls:

- In-process adapter is reviewed trusted code but receives only unsigned request construction; credential bytes remain in narrow transport
- Credential reference binds reviewed auth strategy and exact HTTPS origin; redirects and arbitrary auth/header/query templates rejected
- Daemon starts from a constructed environment and external children receive explicit allowlists
- Transport sanitizes diagnostics before adapter/domain serialization
- Attempt records pin safe credential-version metadata; rotation applies to new attempts and removal blocks them
- Generic endpoints must pass a named, versioned conformance dialect; loopback HTTP is explicit development-only
- Task/source configuration cannot load executable adapters

Evidence:

- Synthetic OS-store lifecycle tests
- Origin, port, redirect, header/query, proxy, retry, cancel, and error canary suite
- Child process/container/protocol environment scan
- Adapter package hash/signature/SBOM and conformance report

Residual risk:

- A compromised trusted in-process adapter or dependency can access daemon memory
- The OS credential store inherits the local account's security boundary

### 7.8c External agent and protocol adapters

Threats:

- ACP agent receives direct filesystem/terminal access instead of virtual guarded capabilities
- ACP permission request is mistaken for runtime approval
- MCP annotations or descriptions are trusted as authorization/effect metadata
- Repository supplies a malicious MCP server or executable adapter
- Black-box CLI agent reads secrets, changes authoritative state, or makes invisible network calls
- Protocol peer requests unknown capabilities, duplicates/reorders IDs, sends oversized/partial frames, or survives the run
- UI/export claims Tier A control for an opaque Tier B/C/D integration

Controls:

- ACP virtual workspace maps reads/writes/terminal to context/action intents and exposes no authoritative worktree
- Runtime approval is a separate state-bound artifact; protocol permissions are display hints only
- Run-scoped stdio MCP bridge advertises only installed operations and treats all annotations as untrusted
- No arbitrary or task-supplied server/adapters; installed code is supply-chain trusted and pinned
- Black-box CLI uses a filtered disposable snapshot, no credentials, bounded resources/network, and candidate-output import only
- Versioned message schemas, size/time/count budgets, session ownership, fail-closed unknown methods, and process-tree cleanup
- Compatibility tier and unobservable surfaces are pinned and exported; claims cannot exceed conformance evidence

Evidence:

- Hostile ACP/MCP protocol corpus with authorization-handler spies
- Snapshot and environment canaries for contained CLI agents
- Adapter crash/disconnect/reordering/reconnect tests
- Golden audit exports for Tiers A, B, C, and D

Residual risk:

- Tier B cannot claim exact provider context without provider visibility
- Tier C cannot mediate or explain intermediate actions; containment depends on sandbox strength
- Hosted agents may have server-side state or tools outside local observation and must be downgraded accordingly

### 7.9 Durable execution

Threats:

- Duplicate side effect after crash
- Two workers own same work
- Stale worker records completion
- Event gap or overwrite
- Payload-only hash leaves envelope metadata unauthenticated
- Projection diverges
- Retry hides policy or budget change
- Replay calls external adapter

Controls:

- Optimistic append
- Transactional command creation
- Leases using database time
- Owner-checked heartbeat/completion
- Lease generation checked on heartbeat and completion
- Tool-specific reconciliation
- Pinned policy and action hashes
- Pure reducer replay
- Projection rebuild comparison
- Canonical full-envelope hash chained to the previous stream event

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
- One-run ownership deletes a deduplicated object still referenced elsewhere
- Transcript encryption key is unavailable, revoked, or rotated incorrectly
- Backup mismatch between DB and files
- SQL injection

Controls:

- Parameterized SQL
- Payload schemas and canonical chained envelope hashes
- Content-addressed internal paths
- Separate immutable artifact objects and reference rows
- Central redaction
- Preflight quota, emergency disk reserve, reference-safe retention and GC
- Shared backup cutoff ID
- Optional hash chain described as tamper-evident
- Vetted authenticated encryption with OS credential-store key, random nonce, key ID, version, and authenticated metadata

Evidence:

- Artifact path tests
- Seeded-secret bundle scan
- Restore test
- Tamper diagnostic test
- Shared-object reference deletion test
- Key loss, wrong key, nonce uniqueness, and rotation-interruption tests

Residual risk:

- Local administrator controlling database and filesystem can replace full histories

### 7.11 Daemon and clients

Threats:

- Unauthorized local client
- Socket permission weakness
- PID reuse or stale-lock race starts two daemons
- Oversized JSON-RPC body
- Duplicate mutating request
- Slow-client memory exhaustion
- Cursor skips or duplicates events
- Artifact chunk reads escape storage root or cross run authorization
- Extension webview injection
- Workspace-trust bypass

Controls:

- Owner-only Unix socket
- Advisory lifetime lock and operating-system peer-credential verification
- Framing/body limits and schema validation
- Client request hash, caller, method, result, and expiry idempotency record
- Durable cursors, explicit server notifications, and bounded buffers
- Authorized artifact chunks with offsets, size caps, no-follow reads, and final hash
- Webview CSP, nonce, message schema
- Daemon remains enforcement point
- Workspace trust before run creation

Evidence:

- RPC fuzz/size tests
- Duplicate request tests
- Slow subscriber test
- Peer-identity, lock-race, idempotency-mismatch, and artifact-chunk tests
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
| Package install needs registry under default profile | Runtime denies the cache miss; approval never silently enables network |
| User approves patch, file changes before apply | Preconditions mismatch and approval invalidates |
| Worker dies after patch application | Reconciliation detects postimage and does not reapply |
| Provider returns two tool calls | Turn fails closed under serialized v1 semantics |
| Extension sends forged approval | Daemon checks live request, identity, expiry, and preconditions |
| Slow client stops reading events | Subscription closes with resumable cursor |
| Process emits gigabytes of output | Stream truncates to bounded artifact and process limit applies |
| Artifact path contains traversal | Internal content-addressed path ignores untrusted filename |
| Replay runs completed history | Reducer rebuilds state without adapter calls |
| Test process rewrites source files | Disposable snapshot is discarded and authoritative checkpoint is unchanged |
| Later patch fails after earlier patch succeeded | Only the later action rolls back to its pre-action checkpoint |
| Metadata-only run loses its process | Run ends as non-resumable without regenerating provider history |
| Text-only model prints a shell command or tool-call-shaped JSON | Content remains non-executable; no action or handler invocation exists |
| Model profile claims unsupported tool or media capability | Startup rejects before credential resolution or source transmission |
| Endpoint redirects a bearer credential | Trusted transport rejects redirect and sends no authentication to the new origin |
| ACP agent asks the user for permission | Request may be displayed, but no Guarded approval exists and action cannot execute |
| MCP server marks a dangerous tool read-only | Annotation is ignored for enforcement; installed operation metadata and policy decide |
| Repository requests installation of its own MCP server/adapter | Runtime refuses executable extension loading from analyzed content |
| Contained CLI agent searches for API keys | No key is mounted/inherited; filtered snapshot and egress policy contain the attempt |
| Research agent cites an unreleased document | Outcome validator rejects completion and records a safe citation error |
| UI calls a Tier C agent “fully mediated” | Audit/renderer derives and displays Tier C from pinned evidence; stronger label is rejected |

## 9. Security Invariants and Tests

| Invariant | Primary test |
|---|---|
| No denied bytes enter agent/provider input | Exact serialized request/protocol scan for raw, encoded, split, identifier, filename, search-output, and transformed synthetic canaries |
| No denied action reaches handler | Capability-gateway handler spy across all driver/protocol ingress paths |
| No stale approval executes | Preconditions mutation matrix |
| No original checkout mutation | Before/after Git and filesystem comparison |
| No replayed side effect | Replay with all effect adapters configured to throw |
| No duplicate recovered patch | Crash-after-apply fault case |
| No credential serialization or inheritance | Seeded canary scan of events, logs, artifacts, requests after auth stripping, RPC, protocol, extension state, and child/container environments |
| No network in default sandbox | Connection probes in container |
| No unbounded boundary allocation | Oversize path, RPC, tool output, diff, and provider stream tests |
| No process mutation of accepted source | Hostile snapshot mutation followed by authoritative checkpoint comparison |
| No artifact cross-reference deletion | Two-run shared object test with one reference tombstoned |
| No stale lease completion | Lease-generation takeover and stale completion rejection |
| No coding/provider assumption in kernel | Package/import graph plus synthetic and research profiles executed with coding/provider packages absent |
| No prose-to-effect path | Text-only hostile output corpus with action/event/handler spies |
| No unsupported model capability use | Manifest mismatch matrix fails before secret resolution or source transmission |
| No protocol metadata authorization | ACP permission and MCP annotation mutation corpus leaves policy/approval outcome unchanged |
| No compatibility-tier overclaim | Golden audit/CLI/report views for Tier A/B/C/D derive solely from pinned conformance evidence |
| No unverified research citation | Outcome validator maps every citation to a released resource hash and allowed span |

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
- Compromised trusted adapter code can access daemon memory despite port separation
- Hosted/protocol agents may perform server-side operations that lower their achievable guarantee tier
- Multimodal secret detection and metadata stripping remain imperfect
- A nominally compatible local/custom endpoint can change behavior after conformance unless version and deployment are pinned

Each release reviews the register, links mitigations completed, and avoids stronger claims than evidence supports.

## 11. Review Cadence

Review this threat model:

- Before real provider integration
- Before adding a provider family, model modality, auth strategy, local/custom endpoint, or external-agent protocol
- Before enabling a new context source or capability pack
- Before process or network tool addition
- Before PostgreSQL durability release
- Before VS Code publication
- Before any remote or multi-user deployment
- After every security incident or bypass
- At each public minor or major release

A threat-model change that adds an asset, boundary, actor, or residual risk must update the corresponding adversarial test plan.
