# Policy-Enforced Agent Runtime Plan Review

## Verdict

Proceed. The project has a coherent product thesis, unusually strong portfolio depth, and broad relevance to security, AI infrastructure, backend, platform, and developer-tool roles.

The best part of the design is not the editor surface or one model call. It is the deterministic boundary around interchangeable agents and models: controlled context, policy-evaluated actions, exact approvals, isolated execution, durable history, compatibility evidence, and adversarial evaluation.

## Strongest Architectural Decisions

- CLI and headless runtime before an editor client
- Agent/model treated as an untrusted proposer
- Generic task profiles, driver/provider separation, context sources, capability packs, and typed outcomes
- Custom policy language with deterministic explanation traces
- Capability execution through one guarded gateway
- Detached authoritative Git worktrees, trusted write checkpoints, and disposable process snapshots
- Append-only events with reducer-based state transitions
- Deterministic scripted driver and synthetic provider before real-model/agent testing
- VS Code extension as a daemon client rather than a second runtime
- Code-OSS fork deferred behind a concrete API limitation

## Corrections Applied

### 1. Narrow dependencies are safer than reimplementation

The original version proposed a handwritten streaming API client and handwritten action validators. Those are technically possible but distract from the differentiating work and create avoidable boundary bugs. The revised plan uses official provider SDKs as narrow transport dependencies and Ajv for strict JSON Schema validation. All orchestration, profile composition, credential brokering, conformance, and enforcement remain custom.

### 2. Consequential actions remain serial in v1

Parallel proposals create causal ordering, overlapping effects, approval, lease, and rollback questions before the single-action semantics are proven. Direct providers disable parallel tool calls when supported, and every driver fails closed on unexpected consequential batches.

### 3. Model calls are not ordinary retryable jobs

A worker can often reconcile a filesystem side effect after a crash. It cannot safely assume that an ambiguous model request was free or never processed. The revised event model records uncertain attempts, preserves completed responses, and charges every retry against the run budget.

### 4. Approval preconditions are stronger

Binding an approval to a command and Git revision was not sufficient. The revised design also binds relevant file hashes, resolved executable identity, and sandbox profile so time-of-check/time-of-use changes invalidate approval.

### 5. Provider privacy is explicit

Provider-side response storage is disabled by default where supported. The second-pass audit found that hashes alone cannot reconstruct changed or transient agent/model-visible content after a crash. Durable runs therefore store exact ordered semantic and required opaque driver/provider protocol items under local authenticated encryption. Metadata-only runs explicitly give up process-loss resume. This tradeoff is selected and pinned when the run starts.

### 6. The estimate is now credible

The original estimate for the complete CLI was optimistic for one person building policy parsing, isolation, durable recovery, adversarial evals, and release-quality documentation. The revised target is:

- Deterministic MVP: 10–14 weeks part-time
- Full durable CLI portfolio v1: 24–36 weeks part-time
- Broad provider/external-agent compatibility: 8–12 additional weeks
- VS Code extension: a further 5–8 weeks

### 7. The authoritative workspace cannot be a process sandbox

The first revision mounted the run worktree read-write for tests and builds. That permits untrusted code to create source changes outside the patch gateway. The corrected design keeps one trusted authoritative worktree, checkpoints every accepted patch, and runs each process in a disposable snapshot whose source mutations are discarded.

### 8. Durability needs schema-level mechanics

The second-pass audit added lease generations, explicit reconciliation state, a global database lock order, separate artifact objects and references, a full-envelope hash chain, exact crash oracles, and an orphaned state for effects that cannot be proven. Restart recovery moves into the same milestone as a minimal daemon rather than being tested before that process exists.

### 9. Provider neutrality cannot erase protocol fidelity

The domain exposes neutral semantic events, but the provider adapter also retains the smallest lossless protocol record needed for continuation: ordering, call IDs, function outputs, and opaque encrypted reasoning items where required. Local custom-function budgets remain authoritative because provider tool-call limits may cover different tool categories.

The complete finding register and evidence gates are maintained in [the deep plan audit](./DEEP_AUDIT.md).

### 10. Generality requires separate agent, model, source, and capability ports

The earlier plan could swap a provider but still assumed one coding-agent loop, repository context, tool calls, patches, and Git outcomes. The corrected design makes `TaskProfile` the composition root, `AgentDriver` the proposer, `ModelProviderAdapter` an optional dependency of one driver, and context/capability packs domain extensions. A local-corpus research profile must pass without coding packages, otherwise the generic claim fails.

External agents receive explicit evidence tiers. A direct model API can be fully mediated; an ACP/MCP agent can claim only the operations Guarded actually maps; a black-box CLI can claim containment and candidate-output validation, not exact per-action authorization. BYOK is a credential broker and origin-bound transport, not a collection of API-key environment variables.

## Primary Remaining Risks

### Scope risk

The project contains several portfolio-scale subsystems. The mitigation is to maintain a working vertical slice at every phase, release the durable coding/research CLI before broad compatibility, and treat the extension as optional until both are strong.

### Sandbox claims

Containers reduce risk but are not a formal security boundary against every hostile workload. Documentation and demos must state actual restrictions and residual risks precisely.

### Policy bypass through alternate representations

Resource locators, commands, network destinations, patches, protocol messages, and capability output can describe the same operation in multiple ways. Normalize once, evaluate the normalized form, and pass that exact value to execution.

### Event-schema evolution

An event log becomes difficult to change after fixtures and users depend on it. Version every event payload from day one and test upcasting old fixture histories.

### Security theater

A polished approval screen is not evidence of enforcement. Every claimed control needs a bypass test showing it fails at the trusted boundary.

## Go/No-Go Gates

### Gate A — After the deterministic vertical slice

Continue only if a scripted driver can complete generic and coding tasks entirely through events and guarded capabilities without provider credentials or domain-specific kernel branches.

### Gate B — After the policy/context milestone

Continue to containers only if hostile path, symlink, secret, malformed-call, and approval-mutation fixtures fail closed.

### Gate C — Before the real model

Connect a real provider only after the deterministic suite is reliable enough to distinguish runtime regressions from model variance.

### Gate D — Before VS Code

Before the editor, broad compatibility must prove at least two hosted provider families, a local no-key path, ACP, MCP-mediated, and contained-CLI tiers without credential leakage or kernel changes. Build the extension only if the CLI demos, documentation, recovery behavior, compatibility report, and eval report already form a publishable portfolio project.

### Gate E — Before a Code-OSS fork

Fork only if a documented, high-value workflow cannot be implemented using stable extension APIs. The daemon remains the source of truth either way.

## Final Recommendation

Build the plan in its revised order. Optimize for a defensible security and systems story, not maximum feature count. The project succeeds when a reviewer can see exactly what an agent and any underlying model received and proposed, why the runtime allowed or denied it, what actually executed, which guarantee tier applied, how the system recovered, and which adversarial tests prove the claim.
