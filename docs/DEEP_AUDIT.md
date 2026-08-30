# Guarded Agent: Deep Plan Audit and Resolution Register

This document records the end-to-end design audit performed after the initial plan was assembled. It is not a claim that the system is implemented. It identifies contradictions, unsafe ambiguities, missing mechanics, and sequencing errors, then records the decision that the source documents must follow.

## 1. Audit Verdict

The initial plan was broad and substantially more detailed than a normal portfolio blueprint, but it was not implementation-complete. It named most major subsystems and test classes, yet several cross-subsystem contracts could not be implemented safely without inventing behavior:

- Durable replay conflicted with hashes-only model-context retention.
- A writable sandbox mount allowed tests to mutate the canonical run workspace outside the patch gateway.
- Patch rollback could erase earlier accepted work.
- The command schema referenced reconciliation state it did not store.
- Approval and event transactions had no global lock order.
- The policy language did not define missing-value logic.
- Provider-neutral conversation records could omit provider-required opaque reasoning items.
- Artifact deduplication conflicted with one-run ownership.
- Daemon restart was an acceptance criterion before the daemon existed.
- The local RPC design did not fully define peer identity, binary transfer, notification backpressure, or idempotency retention.

The corrected plan is implementation-ready only when every critical and high finding below is reflected in the source-of-truth documents and protected by a named test.

## 2. Audit Method

The audit read every tracked repository document and inspected:

1. Product requirement to architecture mapping.
2. Architecture to schema and algorithm mapping.
3. Security claim to enforcement boundary and negative test mapping.
4. Event, state, command, approval, and artifact consistency.
5. Crash windows and effect-reconciliation behavior.
6. Git, filesystem, process, and container trust boundaries.
7. Provider request fidelity and provider-specific protocol requirements.
8. Installation, migration, rollback, cleanup, and release behavior.
9. CLI, daemon, RPC, and editor-client consistency.
10. Milestone order, prerequisites, and evidence gates.

Current provider-specific assumptions were checked against the official OpenAI Responses API reference. Those assumptions remain adapter contracts and must be rechecked when the SDK or target model changes.

## 3. Severity and Status

| Severity | Meaning |
|---|---|
| Critical | The design could violate a core security or durability claim. |
| High | Implementation would be ambiguous at a consequential boundary or fail under a credible operating condition. |
| Medium | A required lifecycle, compatibility, or test detail was missing. |
| Low | Documentation, portfolio presentation, or later-operability detail needed correction. |

Status values:

- resolved-in-plan: the governing documents now contain the decision and implementation mechanics.
- gated-deferred: the capability is outside v1 and has an explicit fail-closed behavior and entry gate.
- accepted-risk: the limitation remains and must appear in security and release documentation.
- implementation-evidence-required: the design is resolved, but no guarantee may be claimed until its tests pass.

## 4. Findings Register

| ID | Severity | Finding | Required resolution | Status |
|---|---|---|---|---|
| DA-001 | Critical | Hash-only context metadata cannot reconstruct exact model input after a crash. | Durable mode stores the exact provider-visible semantic transcript as locally encrypted artifacts. Metadata-only mode is non-resumable across process loss. | resolved-in-plan |
| DA-002 | Critical | Mounting the canonical run worktree read-write lets untrusted tests alter source without a patch decision. | Execute processes in a disposable copy or overlay of the latest approved checkpoint. Discard source mutations and import only declared artifacts. | resolved-in-plan |
| DA-003 | Critical | Resetting the worktree to the base commit after a failed later patch destroys earlier accepted patches. | Create an internal checkpoint after every verified write and roll back only to the recorded pre-action checkpoint. | resolved-in-plan |
| DA-004 | Critical | Applying a patch to a persistent index accumulates prior staged changes and makes per-action verification ambiguous. | Internal checkpoint commits clear the index between writes; verification compares the pre-action checkpoint to the post-action candidate. | resolved-in-plan |
| DA-005 | Critical | Approval flow could lock approval then stream while other flows lock stream then approval. | Every multi-row domain transaction locks the event stream first, then approval, command, projection, and idempotency rows in a fixed order. | resolved-in-plan |
| DA-006 | Critical | Expired commands referenced a reconciliation-required flag absent from the schema. | Add reconciliation-required state, reconciliation reason, and a lease generation token. | resolved-in-plan |
| DA-007 | High | Uniqueness on event and command type prevents two same-type commands caused by one event. | Use deterministic command ID plus a unique event-local command ordinal. | resolved-in-plan |
| DA-008 | Critical | Content-addressed artifacts had one owning stream, which conflicts with deduplication and shared eval baselines. | Separate immutable artifact objects from mutable artifact references. | resolved-in-plan |
| DA-009 | High | A payload-only hash does not authenticate event type, sequence, actor, or causation. | Hash canonical envelope fields and the previous event hash. Describe the chain as tamper-evident, not tamper-proof. | resolved-in-plan |
| DA-010 | Critical | Boolean negation over absent policy attributes could turn unknown into allow. | Use three-valued expression logic. Only true matches; negated unknown remains unknown; add explicit presence testing. | resolved-in-plan |
| DA-011 | High | The matches operator did not define regex versus glob semantics or case behavior. | Define matches as a compiled, anchored path glob over canonical forward-slash paths; no runtime regex in v1. | resolved-in-plan |
| DA-012 | High | Priority wording implied it could override deny while the algorithm used deny-overrides. | Effects combine as deny-overrides, approval-overrides-allow. Priority chooses the dominant explanation only within the winning effect. | resolved-in-plan |
| DA-013 | High | Secret trace hashes can permit offline guessing of low-entropy values. | Store category, count, and random correlation token. Hash only high-entropy canaries where an explicit test policy permits it. | resolved-in-plan |
| DA-014 | High | Token estimation and enforcement were unspecified. | Enforce bytes independently, use a conservative provider/model estimator for preflight, and reconcile final usage from provider-reported accounting. | resolved-in-plan |
| DA-015 | High | File names and search results could leak secrets or prompt injection text. | Context policy and model-safe transformation apply to path names, match snippets, and all search output. | resolved-in-plan |
| DA-016 | Critical | Repository-controlled Git filters, text conversion, hooks, attributes, or configuration could execute code or transform reviewed bytes. | Trusted Git adapter uses a sanitized environment, disables hooks and external helpers, avoids text conversion and smudge filters, and rejects unsupported submodule or LFS states. | resolved-in-plan |
| DA-017 | High | The sandbox Git pointer could point outside the mount or expose the user's common Git directory. | Untrusted process workspaces do not receive writable live Git metadata. Trusted host-side adapters perform patch and Git accounting. | resolved-in-plan |
| DA-018 | High | Approved dependency installation conflicted with a network-disabled sandbox. | v1 may run only lockfile-satisfied installs from prepopulated, verified inputs without network. Networked package resolution is a deferred proxy capability. | gated-deferred |
| DA-019 | High | An approval display promised exact lockfile effects before an install could know them. | Display declared manifest delta, registry, lifecycle risk, network profile, and whether lockfile effects are predicted or observed in an ephemeral preflight. | resolved-in-plan |
| DA-020 | Critical | Stateless Responses API reconstruction omitted opaque encrypted reasoning continuity. | Where supported, request and persist encrypted reasoning items as opaque provider-protocol records and send them back unchanged. | resolved-in-plan |
| DA-021 | High | Provider-neutral records could drop call IDs or item ordering required by the provider. | Persist exact normalized semantic items plus lossless provider-protocol envelopes needed for the next request. | resolved-in-plan |
| DA-022 | High | Provider custom-tool call budgets could be mistaken for the provider's built-in-tool limit. | Enforce custom tool-call count, turn count, and consequential-action limits in the local runtime. | resolved-in-plan |
| DA-023 | High | Retry design did not distinguish local attempt identity, SDK request identity, and provider response identity. | Record all three, transmission state, retry cause, and budget effect. Never assume provider idempotency. | resolved-in-plan |
| DA-024 | High | Provider configuration fingerprint omitted several replay-relevant fields. | Hash model ID, reasoning configuration, developer instructions, tool schemas, SDK version, request parameters, and adapter version. | resolved-in-plan |
| DA-025 | High | Encryption was named without key storage, nonce, algorithm, or rotation. | Use a vetted authenticated-encryption library, random nonce, OS credential-store master key, key ID, version, authenticated metadata, and documented rotation. | resolved-in-plan |
| DA-026 | High | Artifact writes lacked preflight quota and disk-full reserve behavior. | Reserve capacity before writes, keep an emergency metadata reserve, bound temporary files, and apply backpressure. | resolved-in-plan |
| DA-027 | High | The artifact stream RPC did not define binary framing. | Replace it with bounded base64 chunks, byte cursors, per-response limits, and final hash verification. | resolved-in-plan |
| DA-028 | High | RPC subscriptions were described as if standard request responses could stream indefinitely. | Use explicit server notifications, sequence cursors, bounded queues, resumable closure, and a catch-up/register/catch-up algorithm. | resolved-in-plan |
| DA-029 | High | Socket permissions alone did not verify peer identity. | Verify peer credentials where supported, validate data-directory ownership, and fail closed on platforms without the required local guarantees. | resolved-in-plan |
| DA-030 | High | PID and start-time lock files still permit races and PID reuse. | Hold an OS advisory lock for daemon lifetime; metadata is diagnostic only. | resolved-in-plan |
| DA-031 | Medium | Client request deduplication had no schema, retention, or mismatch behavior. | Persist method, canonical request hash, response, expiry, and caller identity; reject reused IDs with different bytes. | resolved-in-plan |
| DA-032 | High | Follow-up intent was a product requirement without a CLI or RPC operation. | Add a run-message CLI command and append-intent RPC, preserving the immutable original objective. | resolved-in-plan |
| DA-033 | High | Policy denial did not say whether the model may recover. | Return a bounded denial observation for recoverable action denials, enforce a repeated-denial budget, and terminate on invariant or protocol denial. | resolved-in-plan |
| DA-034 | High | The run state diagram omitted cancellation-requested, paused, recovering, uncertain, and orphaned states. | Define the complete lifecycle and legal transitions in the runtime guide. | resolved-in-plan |
| DA-035 | High | Event vocabulary omitted cancellation request, approval invalidation, command reconciliation, and provider completion or failure details. | Separate domain events from operational telemetry and define the authoritative domain-event vocabulary. | resolved-in-plan |
| DA-036 | Medium | Lease heartbeats risked flooding the aggregate event stream. | Store lease mechanics in command rows and metrics; emit domain events only when business-visible state changes. | resolved-in-plan |
| DA-037 | High | Daemon restart was required before the daemon milestone existed. | Introduce a minimal headless daemon with PostgreSQL durability, then add multi-client hardening and VS Code later. | resolved-in-plan |
| DA-038 | Medium | The phase estimate did not include enough integration and hardening contingency. | Use effort ranges with entry dependencies, evidence gates, and explicit contingency rather than one optimistic calendar total. | resolved-in-plan |
| DA-039 | Medium | Real security tests could run dangerous fixtures on shared hosted runners. | Run hostile container and escape tests only on disposable isolated runners with no organization credentials. | resolved-in-plan |
| DA-040 | High | A forbidden-content assertion based on one hash can miss encoding, slicing, or transformation. | Seed unique canaries in raw, encoded, split, filename, and output forms; inspect exact serialized provider request bytes. | resolved-in-plan |
| DA-041 | Medium | Security-sensitive decision code lacked mutation-testing requirements. | Mutation-test policy combination, normalization, approval checks, gateway denial, reducer guards, and reconciliation. | resolved-in-plan |
| DA-042 | High | PostgreSQL tests did not explicitly exercise lock order and isolation anomalies. | Add concurrent approval and append deadlock tests, stale-lease generation tests, and tests at the selected transaction isolation level. | resolved-in-plan |
| DA-043 | Medium | Policy, event, and RPC migration compatibility lacked a permanent corpus. | Keep versioned golden fixtures for every supported persisted and wire version. | resolved-in-plan |
| DA-044 | Medium | Sandbox image provenance stopped at a digest and scan. | Record source Dockerfile hash, base digest, software bill of materials, builder identity, build workflow, and signature or provenance when distributing. | resolved-in-plan |
| DA-045 | Medium | Release signing was named without key ownership, rotation, or recovery. | Define release identity, protected signing environment, rotation, revocation, and compromise runbook before publishing signed claims. | gated-deferred |
| DA-046 | High | Automatic cleanup could race a recovering run or shared artifact reference. | Cleanup uses ownership records, terminal and lease checks, tombstone state, dry run, and reference-safe object sweep. | resolved-in-plan |
| DA-047 | Medium | macOS and Linux container user behavior was treated as identical. | The execution-copy adapter owns permissions and validates writability per platform instead of assuming host user equivalence. | resolved-in-plan |
| DA-048 | High | A local administrator can replace the database and artifact history. | Retain this as an explicit trust limitation; optional external signatures are a later enhancement. | accepted-risk |
| DA-049 | High | Container isolation is not a proof against kernel or runtime escape. | Retain container escape as residual risk and require patched runtime, minimal mounts, and isolated hostile-test runners. | accepted-risk |
| DA-050 | Medium | Public MIT licensing and package scope were implicit decisions. | Record licensing, package naming, public or private launch timing, and trademark checks in decision records before external release. | implementation-evidence-required |
| DA-051 | High | Test subprocess writes and dependency caches could create unreviewed changes that later contaminate final diffs. | Process execution copies are discarded; only patch-gateway checkpoints define source state. | resolved-in-plan |
| DA-052 | High | Exact durable resume and strict data minimization were presented as simultaneously unconditional. | Make the tradeoff a visible run mode with startup validation and audit metadata. | resolved-in-plan |
| DA-053 | Critical | Approval uniqueness allowed only one request per action, so invalidation could not issue a fresh bound approval. | Add request-ordinal uniqueness and a partial unique index allowing exactly one pending request per action while preserving history. | resolved-in-plan |
| DA-054 | Critical | Ordinary worktree checkout could invoke repository-controlled content filters before later Git commands disabled helpers. | Create the worktree without checkout, populate the index, and materialize raw blobs through a bounded no-follow writer after rejecting unsupported attributes. | resolved-in-plan |
| DA-055 | High | Database and artifact backup could restore ciphertext without the credential-store key needed to decrypt it. | Record required key IDs, verify them in restore preflight, and do not claim cross-machine restore until a reviewed key-recovery design exists. | resolved-in-plan |
| DA-056 | High | A provider terminal response could be lost between stream completion and event append. | Write an encrypted bounded response spool with a flushed terminal marker, item count, and hash; reconcile only complete spools and mark incomplete ones uncertain. | resolved-in-plan |
| DA-057 | Critical | The earlier kernel vocabulary and requirements hard-coded model, tool, repository, patch, and Git concepts, so “general agent runtime” was only a label. | Define task-profile, agent-driver, model-provider, context-source, capability-pack, resource, content-block, action, observation, and outcome ports; forbid coding/provider imports in kernel packages; prove with a non-coding research profile. | resolved-in-plan |
| DA-058 | High | “Any provider” was incorrectly treated as equivalent to “any agent.” A model API adapter and an autonomous external agent expose different control points. | Separate `ModelProviderAdapter` from `AgentDriver`; define direct-model, scripted, ACP, MCP-mediated, hosted, and contained-CLI driver contracts and evidence. | resolved-in-plan |
| DA-059 | Critical | A text-only model could become an effect path if prose, Markdown, or JSON-looking text were opportunistically parsed as a tool call. | Text-only models are answer/planning-only; only native complete calls or a strict versioned schema envelope can create `ActionProposed`; adversarial prose never reaches a handler. | resolved-in-plan |
| DA-060 | High | “Any model type” omitted modality-specific content classification, transformations, bounds, lineage, and provider encoding. | Add versioned text/image/audio/document/structured blocks, transformation hashes and metadata stripping, manifest negotiation, unsupported-mode rejection, and multimodal canary tests. | resolved-in-plan |
| DA-061 | Critical | ACP permission requests and MCP tool annotations could be mistaken for Guarded authorization. | Treat them as untrusted display hints; every operation still traverses normalization, policy, exact approval, execution, reconciliation, and release; prove mutations cannot change the decision. | resolved-in-plan |
| DA-062 | Critical | The earlier key plan was OpenAI/environment-variable centric and lacked origin binding, redirect behavior, lifecycle, or a narrow secret boundary. | Store secret bytes in an OS credential store; use opaque references, reviewed auth strategies, unsigned request compilation, exact-origin trusted transport, redirect denial, rotation/removal, and whole-surface canary scans. | resolved-in-plan |
| DA-063 | High | A single “compatible” label would overclaim controls for opaque agents and custom endpoints. | Define evidence-backed Tiers A–D, pin the tier to the run, export limitations, require conformance, and reject UI/report claims stronger than the achieved tier. | resolved-in-plan |
| DA-064 | Critical | An ACP or CLI agent given a live repository, terminal, credential, or authoritative worktree could bypass the gateway completely. | ACP receives a virtual guarded workspace/terminal; CLI agents receive credential-free disposable filtered snapshots and can return only candidate artifacts; authoritative resources remain unmounted. | resolved-in-plan |
| DA-065 | High | No second task profile proved that policy, events, durability, budgets, and outcomes were actually domain-neutral. | Implement a local-corpus research profile with search/read/citation operations and a verified outcome, and run kernel tests with coding packages absent. | resolved-in-plan |
| DA-066 | High | A generic OpenAI-compatible endpoint could redirect or deviate from the expected dialect while receiving a credential and private context. | Bind credentials to an exact origin, reject redirects, require a named versioned conformance dialect, permit loopback HTTP only in explicit development, and pin deployment/model/adapter evidence. | resolved-in-plan |
| DA-067 | High | “Multi-agent” could imply concurrent delegation even though ordering, budgets, identities, context sharing, approval causality, and recovery were undefined. | Support multiple interchangeable single-agent driver types in v1; explicitly defer concurrent multi-agent coordination until a coordinator contract and event semantics are separately designed. | resolved-in-plan |
| DA-068 | High | External/hosted agents may use server-side tools or hidden memory outside Guarded visibility, invalidating exact-context and per-action claims. | Capability manifests identify unobservable operations; disable them for strong tiers or downgrade to the evidence-supported tier and export the blind spots. | resolved-in-plan |
| DA-069 | High | A task profile allowed only one optional model, contradicting auxiliary embedding, reranking, classifier, and grader model support. | Use role-based model bindings: exactly one action-capable planner for a direct-model driver plus zero or more non-authorizing auxiliary bindings; pin all bindings and forbid in-place planner switching. | resolved-in-plan |
| DA-070 | Critical | An adapter could self-report capabilities or a strong compatibility tier without proving the OS/sandbox controls required by that claim. | Adapters report primitive capabilities; the trusted profile validator computes Tier A/B/C/D from capabilities, installed enforcement, enabled operations, and a pinned conformance result. | resolved-in-plan |
| DA-071 | High | JSON Schema alone could accept a syntactically valid but fabricated outcome containing unproduced artifacts, citations, tests, or source evidence. | Add semantic completeness, reference/provenance, event/artifact evidence, and output-policy validation before `OutcomeValidated` and `RunCompleted`. | resolved-in-plan |
| DA-072 | Critical | The durable schema still keyed approvals by tool calls and stored only provider transcripts, making protocol/scripted drivers and non-tool actions second-class. | Key approvals by generic action and pack/operation/profile versions; persist generic driver transcript items with optional provider/protocol fields; add immutable profile and secret-free credential-reference tables. | resolved-in-plan |

## 5. Governing Cross-Cutting Decisions

### 5.1 Evidence and privacy modes

Every run selects one immutable local evidence mode:

| Mode | Local content behavior | Crash resume | Exact driver/provider continuation |
|---|---|---|---|
| durable_encrypted | Encrypt exact agent-visible semantic items and required opaque driver/provider protocol items locally. | Supported after the durability milestone when the selected driver supplies a lossless resume contract. | Supported for recorded completed turns, subject to driver/adapter compatibility. |
| ephemeral_metadata | Retain hashes, classifications, sizes, and safe audit metadata only. | Only while the owning process retains the in-memory transcript. A process loss ends the run as non-resumable. | Not supported. |

Both modes request provider/hosted-agent storage to be disabled where supported. Neither mode stores denied secret bytes. The selected mode, key ID when applicable, retention policy, and resumability consequence are part of run creation and the driver/provider configuration fingerprint.

### 5.2 Authoritative source workspace

The detached run worktree is controlled by trusted host-side adapters. The only accepted source mutations are exact patch artifacts that pass validation, policy, approval when required, application, changed-set verification, and checkpoint creation.

Untrusted process tools receive a disposable execution snapshot of the latest accepted checkpoint. They never receive a writable mount of the authoritative run worktree or writable access to its Git common directory. Their source mutations are discarded. Test reports and other declared outputs may cross back through the artifact gateway after type, size, and secret checks.

### 5.3 Internal checkpoints

Each successful write produces a trusted internal checkpoint:

1. Record the current checkpoint object ID, tree ID, index state, and allowed untracked manifest.
2. Apply exact approved patch bytes to a clean index based on that checkpoint.
3. Verify changed paths, modes, preimages, postimages, and patch semantics.
4. Create an internal no-hook checkpoint commit with a controlled identity.
5. Store checkpoint ID and manifest in the event ledger.
6. Clear transient index state.

Failure restores only the pre-action checkpoint. The exported result is the diff from the original pinned base commit to the final accepted checkpoint.

### 5.4 Transaction and lock order

All transactions that touch multiple mutable domain records acquire locks in this order:

1. Event-stream row.
2. Approval row.
3. Command row.
4. Projection row.
5. Client-idempotency row.

Artifact objects are immutable and are inserted with conflict-safe content identity. References are attached after object verification under the owning stream transaction. Code must not introduce an inverse order. The integration suite runs concurrent inverse-pressure scenarios and treats a deadlock as a defect.

### 5.5 Policy truth model

Expression evaluation returns true, false, or unknown.

- A missing optional attribute yields unknown for comparisons.
- Negated unknown remains unknown.
- Unknown and false is false; unknown and true is unknown.
- Unknown or true is true; unknown or false is unknown.
- A policy matches only when its complete expression is true.
- The explicit presence operator is the only v1 way to test presence directly.

Policy effects use deny-overrides combination. Priority never converts a deny into an allow. It chooses the displayed dominant rule and stable trace ordering within the winning effect.

### 5.6 Provider transcript fidelity

The domain keeps a provider-neutral semantic view for policy, UI, and evaluation, plus the smallest lossless provider-protocol record needed to continue the conversation. For the Responses API adapter this includes item ordering, call IDs, function-call outputs, response and request identifiers, and opaque encrypted reasoning content when required by the selected model and stateless mode.

Opaque reasoning content is never decrypted, summarized, displayed, or interpreted by Guarded Agent. It follows the same local encryption and retention policy as the transcript.

### 5.7 Network and dependency behavior

The v1 sandbox profile is networkless. A run may execute an install only when all inputs are already present in a reviewed image or a verified read-only package cache and the operation can be proven offline. A request requiring registry access is denied with a clear message.

A future networked install capability requires a separate egress proxy with destination, method, byte, time, package-integrity, and audit policy. General container network access is not an acceptable substitute.

## 6. Required Evidence Before Claims

| Claim | Required oracle |
|---|---|
| Denied bytes never reached the provider | Capture the exact serialized request body and scan raw, encoded, split, filename, and transformed canaries. |
| A patch was the only accepted source mutation | Compare authoritative checkpoint trees and verify every changed path maps to one successful patch action. |
| A test could not alter source | Compare authoritative checkpoint before and after the disposable execution snapshot is destroyed. |
| Approval authorized exact execution | Mutate each bound precondition independently and prove the handler remains uncalled. |
| Recovery did not duplicate an effect | Crash after external effect, expire lease, reconcile, and observe one postcondition plus one recovered result. |
| Replay performed no effects | Replay a complete history with every external adapter replaced by a fail-on-call spy. |
| RPC idempotency is safe | Repeat identical bytes and receive the recorded response; reuse the ID with different bytes and receive a conflict. |
| Event chain detects mutation | Modify envelope type, sequence, actor, causation, and payload independently and prove verification fails. |
| Artifact deduplication preserves ownership | Reference one object from multiple runs, delete one run, and prove the retained reference remains readable. |
| Metadata-only mode is honest | Kill the process mid-run and prove the run becomes terminal non-resumable without silently regenerating model output. |
| Kernel is general | Run synthetic and research profiles with coding/provider packages absent and find no domain/brand switches in the runtime graph. |
| Any model mode is bounded | Native calls, schema envelopes, text-only content, and supported multimodal blocks pass their mode-specific conformance and canary suites. |
| Credentials remain confined | Scan every request/log/event/artifact/client/protocol/child surface; verify exact-origin auth, redirect denial, rotation, and removal. |
| External-agent claims are honest | ACP/MCP/CLI hostile corpora prove mediated operations and audit exports never exceed Tier A/B/C/D evidence. |

## 7. Milestone Audit Gates

### Gate A: deterministic kernel

- Complete state and event tables exist.
- Every intent has a legal-state matrix.
- Every event schema has a reducer case and golden fixture.
- Replay invokes no effect adapter.
- Scripted driver and synthetic provider each check the exact semantic transcript they receive at their respective boundary.

### Gate B: policy and context

- Three-valued logic and explicit presence tests have exhaustive truth-table tests.
- Glob behavior is platform-independent over canonical paths.
- Search paths, filenames, snippets, and tool outputs cross the context boundary.
- Canary tests inspect serialized provider-request bytes.
- Policy mutation testing kills the configured minimum mutation score for enforcement branches.

### Gate C: workspace and sandbox

- Trusted internal checkpoints preserve earlier writes.
- Failed later writes restore only their pre-action checkpoint.
- Untrusted processes cannot write the authoritative worktree.
- Repository-controlled hooks, filters, text conversion, and external diff helpers do not execute.
- Git submodule, LFS, and unsupported attribute states fail closed.

### Gate D: provider

- Provider fingerprint covers every request-affecting field.
- Stateless reasoning continuity passes a multi-turn contract test where supported.
- Custom tool-call budgets are enforced locally.
- Ambiguous transmission produces a new visible attempt rather than an invisible retry.
- Both evidence modes exhibit their documented restart behavior.

### Gate E: durability

- A minimal daemon owns PostgreSQL and workers.
- Schema includes reconciliation and lease-generation fields.
- Global lock order has concurrency tests.
- Every named crash window has a state, retry, reconciliation, budget, artifact, and user-experience oracle.
- Encrypted transcript key loss and unavailable-key behavior fail safely.

### Gate F: release

- Clean-machine installation and uninstall are tested.
- Database and artifact backup restore together.
- Hostile sandbox tests run only on isolated disposable infrastructure.
- Dependency, image, build, and release provenance are recorded.
- Claims are generated from passing evidence and include accepted residual risks.

### Gate G: broad provider and agent compatibility

- OpenAI, Anthropic, Gemini, a named compatible dialect, and a local no-key endpoint pass the shared provider corpus.
- Scripted, direct-model, ACP, MCP-mediated, and contained-CLI drivers pass their applicable driver corpus.
- Text-only output cannot create actions; schema-only and multimodal modes fail closed when unsupported.
- Credential origin, redirect, lifecycle, and canary tests pass.
- Coding and research profiles run through the same kernel without cross-domain imports.
- Compatibility tiers and blind spots are immutable audit facts and all renderers derive from them.

### Gate H: editor

- RPC peer identity, size limits, idempotency expiry, notifications, and artifact chunking pass contract tests.
- CLI and extension reconnect from durable cursors.
- Workspace trust blocks creation and consequential control.
- Webviews receive display-safe representations only.

## 8. What Exhaustive Means for This Project

A subsystem is not implementation-ready merely because its components are listed. For every user or worker operation, the implementation issue must identify:

1. Accepted input bytes and schema version.
2. Structural and semantic normalization.
3. Trust classification and authority.
4. Policy attributes and combination behavior.
5. Approval display, binding, expiry, and invalidation.
6. Transaction boundary and lock order.
7. Command identity, lease, retry, and reconciliation.
8. External effect point and durable before and after records.
9. Cancellation and timeout points.
10. Budget dimensions and accounting source.
11. Output bounds and artifact behavior.
12. Secret and prompt-injection treatment.
13. Human, model, audit, and machine representations.
14. Upgrade, rollback, retention, and cleanup behavior.
15. Unit, generative, integration, adversarial, fault, mutation, compatibility, and performance evidence.
16. Residual risk and the exact claim the implementation may make.

If one answer is absent, the issue remains in design and cannot close as implemented.

## 9. Audit Limitations

This audit resolves design consistency; it does not prove the future code, the container runtime, the provider, or the host operating system. Implementation will reveal additional constraints. Every such discovery must either update the governing documents through an architecture decision record or fail the affected milestone gate. Security claims remain design targets until named evidence passes on a released artifact.
