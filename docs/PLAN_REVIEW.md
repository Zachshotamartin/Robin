# Policy-Enforced Coding Agent Plan Review

## Verdict

Proceed. The project has a coherent product thesis, unusually strong portfolio depth, and broad relevance to security, AI infrastructure, backend, platform, and developer-tool roles.

The best part of the design is not the editor surface or the model call. It is the deterministic boundary around the model: controlled context, policy-evaluated actions, exact approvals, isolated execution, durable history, and adversarial evaluation.

## Strongest Architectural Decisions

- CLI and headless runtime before an editor client
- Model treated as an untrusted proposer
- Custom policy language with deterministic explanation traces
- Tool execution through one guarded gateway
- Disposable Git worktrees and container isolation
- Append-only events with reducer-based state transitions
- Deterministic fake provider before real-model testing
- VS Code extension as a daemon client rather than a second runtime
- Code-OSS fork deferred behind a concrete API limitation

## Corrections Applied

### 1. Narrow dependencies are safer than reimplementation

The original version proposed a handwritten streaming API client and handwritten tool validators. Those are technically possible but distract from the differentiating work and create avoidable boundary bugs. The revised plan uses the official OpenAI JavaScript SDK for transport and Ajv for strict JSON Schema validation. All orchestration and enforcement remain custom.

### 2. Tool calls remain serial in v1

Parallel tool calls create causal ordering, overlapping file-write, approval, lease, and rollback questions before the single-action semantics are proven. The provider configuration disables them initially, and unexpected batches fail closed.

### 3. Model calls are not ordinary retryable jobs

A worker can often reconcile a filesystem side effect after a crash. It cannot safely assume that an ambiguous model request was free or never processed. The revised event model records uncertain attempts, preserves completed responses, and charges every retry against the run budget.

### 4. Approval preconditions are stronger

Binding an approval to a command and Git revision was not sufficient. The revised design also binds relevant file hashes, resolved executable identity, and sandbox profile so time-of-check/time-of-use changes invalidate approval.

### 5. Provider privacy is explicit

Provider-side response storage is disabled by default where supported. Conversation state is reconstructed from the local ledger. Any change to that behavior becomes a documented configuration decision.

### 6. The estimate is now credible

The original estimate for the complete CLI was optimistic for one person building policy parsing, isolation, durable recovery, adversarial evals, and release-quality documentation. The revised target is:

- Deterministic MVP: 8–12 weeks part-time
- Full CLI portfolio v1: 18–24 weeks part-time
- VS Code extension: 4–6 additional weeks

## Primary Remaining Risks

### Scope risk

The project contains four portfolio-scale subsystems. The mitigation is to maintain a working vertical slice at every phase and treat the extension as optional until the CLI release is strong.

### Sandbox claims

Containers reduce risk but are not a formal security boundary against every hostile workload. Documentation and demos must state actual restrictions and residual risks precisely.

### Policy bypass through alternate representations

Paths, commands, network destinations, patches, and tool output can describe the same operation in multiple ways. Normalize once, evaluate the normalized form, and pass that exact value to execution.

### Event-schema evolution

An event log becomes difficult to change after fixtures and users depend on it. Version every event payload from day one and test upcasting old fixture histories.

### Security theater

A polished approval screen is not evidence of enforcement. Every claimed control needs a bypass test showing it fails at the trusted boundary.

## Go/No-Go Gates

### Gate A — After the deterministic vertical slice

Continue only if the fake provider can complete a patch task entirely through events and guarded tools.

### Gate B — After the policy/context milestone

Continue to containers only if hostile path, symlink, secret, malformed-call, and approval-mutation fixtures fail closed.

### Gate C — Before the real model

Connect a real provider only after the deterministic suite is reliable enough to distinguish runtime regressions from model variance.

### Gate D — Before VS Code

Build the extension only if the CLI demo, documentation, recovery behavior, and eval report already form a publishable portfolio project.

### Gate E — Before a Code-OSS fork

Fork only if a documented, high-value workflow cannot be implemented using stable extension APIs. The daemon remains the source of truth either way.

## Final Recommendation

Build the plan in its revised order. Optimize for a defensible security and systems story, not maximum feature count. The project succeeds when a reviewer can see exactly what the model requested, why the runtime allowed or denied it, what actually executed, how the system recovered, and which adversarial tests prove the claim.
