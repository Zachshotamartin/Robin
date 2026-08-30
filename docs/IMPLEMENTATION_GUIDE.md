# Guarded Agent: Detailed Implementation Guide

This document explains how to implement the system described in the full build plan. It is deliberately concrete about data flow, algorithms, transaction boundaries, failure cases, and tests. The full plan defines product scope and sequencing; this guide defines implementation mechanics.

## 1. Engineering Rules That Shape Every Module

### 1.1 Dependency direction

Use a ports-and-adapters layout with one-way dependencies:

```text
contracts
  ^
  |-- profile-registry
  |-- agent-driver ports
  |-- model-provider ports
  |-- policy-language
  |-- event-store interfaces
  |-- context-source ports
  |-- capability-pack ports
  ^
runtime application layer
  ^
adapters and packs: PostgreSQL, providers, ACP, MCP, credentials, repository,
                    research, Docker, Git, CLI, JSON-RPC, VS Code
```

The domain packages must not import PostgreSQL, a provider SDK, an agent protocol, an OS credential API, Docker, Git process helpers, CLI rendering, or VS Code APIs. Adapters implement ports defined by the domain. The generic runtime and reducer must not import coding or research capability packs.

Enforce the boundary in three ways:

1. Give every package an explicit `exports` map.
2. Use TypeScript project references so packages compile independently.
3. Add a repository test that rejects imports containing another package's `/src/` path.

### 1.2 Normalize once

Untrusted data follows a single pipeline:

```text
raw agent-driver action proposal
  -> JSON parse
  -> operation-envelope and JSON Schema validation
  -> semantic validation
  -> canonicalization
  -> immutable NormalizedAction
  -> policy evaluation
  -> optional approval
  -> execution of the same NormalizedAction
```

Never reconstruct execution arguments from raw model or external-agent output after policy evaluation. Freeze the normalized object in development, serialize it canonically, hash the canonical bytes, and pass that exact object to the capability handler.

### 1.3 Separate decisions from effects

Pure code decides what should happen. Adapter code performs effects.

- `decide(state, intent)` returns domain events or a rejection.
- `evolve(state, event)` returns a new state.
- `planEffects(state, event)` returns commands for external adapters.
- Workers execute commands and append result events.

This structure allows replay to call only `evolve`; replay never calls an adapter.

### 1.4 Fail closed at boundaries

Unknown profile, driver event, model capability, content block, event version, capability/operation, policy attribute, schema property, decision effect, provider output type, protocol message, or run state must produce a typed failure. Do not silently ignore unknown input in security-sensitive code.

### 1.5 Preserve evidence without preserving secrets

For sensitive content, store:

- Policy rule ID
- Resource identifier
- Byte count
- Cryptographic hash when hashing is permitted
- Detector category
- Denial reason

Do not store the matched secret, a surrounding excerpt, or the raw provider request containing it.

### 1.6 Keep the kernel domain-neutral

The kernel owns `TaskProfile`, `ObjectiveEnvelope`, `ResourceRef`, `ContentBlock`, `NormalizedAction`, `Observation`, `OutcomeEnvelope`, budgets, approvals, commands, and generic events. Coding owns repository paths, Git revisions, patches, checkpoints, and test reports. Research owns corpus locators, document spans, citations, and source manifests. Provider adapters own protocol call IDs and opaque continuation items. Agent adapters own protocol session IDs.

Enforce this separation with an architectural test that scans runtime imports and compiled dependency graphs. A generic-kernel package fails CI if it imports a capability pack or switches on a provider brand, protocol family, `repo:` scheme, Git field, patch field, citation field, or operation ID. Cross-domain behavior is dispatched through installed ports and schemas.

The detailed generic contracts and adapter capability matrix live in [GENERAL_RUNTIME_ARCHITECTURE.md](./GENERAL_RUNTIME_ARCHITECTURE.md) and [PROVIDER_AGENT_COMPATIBILITY.md](./PROVIDER_AGENT_COMPATIBILITY.md); their ports are implementation requirements, not optional future notes.

## 2. Repository Bootstrap

### 2.1 Root files

Create these files before implementation begins:

| File | Purpose |
|---|---|
| `README.md` | Product pitch, current status, quick start, guarantees, limitations |
| `LICENSE` | MIT license unless a different distribution decision is made before publication |
| `package.json` | Private npm workspace root and development scripts |
| `package-lock.json` | Reproducible dependency graph |
| `tsconfig.base.json` | Strict shared compiler configuration |
| `.editorconfig` | UTF-8, LF, final newline, two-space indentation |
| `.gitignore` | Dependencies, build products, credentials, run artifacts, database volumes |
| `.npmrc` | Exact engine behavior and lockfile policy |
| `AGENTS.md` | Repository-specific agent instructions and security constraints |
| `SECURITY.md` | Supported versions and private vulnerability-reporting process |
| `CONTRIBUTING.md` | Setup, tests, architecture rules, change checklist |

### 2.2 Workspace scripts

The root scripts should have one stable entry point per concern:

```json
{
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "check": "npm run typecheck && npm run lint && npm test",
    "clean": "npm run clean --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "test:integration": "npm run test:integration --workspace @guard/integration-tests",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

Do not add a production dependency until a short architecture note explains why the dependency is safer or more economical than a local implementation.

### 2.3 TypeScript baseline

Enable at least:

- `strict`
- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `useUnknownInCatchVariables`
- `noImplicitOverride`
- `noFallthroughCasesInSwitch`
- `verbatimModuleSyntax`
- `isolatedModules`
- `composite`
- declaration output for packages

Treat unsafe casts as review points. Boundary adapters may narrow `unknown`; domain code should receive validated types.

## 3. Domain Types and Error Model

### 3.1 Branded identifiers

Use constructor functions to validate IDs at boundaries. Do not scatter casts.

```ts
declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & {
  readonly [brand]: Name;
};

export type RunId = Brand<string, "RunId">;
export type EventId = Brand<string, "EventId">;
export type AgentAttemptId = Brand<string, "AgentAttemptId">;
export type DriverProposalId = Brand<string, "DriverProposalId">;
export type ActionId = Brand<string, "ActionId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type CommandId = Brand<string, "CommandId">;
export type PolicyVersionId = Brand<string, "PolicyVersionId">;
export type ArtifactId = Brand<string, "ArtifactId">;
```

Generate opaque sortable IDs with a maintained UUID or ULID implementation. ID generation is not a useful cryptographic reinvention target.

### 3.2 Error taxonomy

All expected failures become serializable domain errors:

- `invalid_input`
- `policy_denied`
- `approval_required`
- `approval_invalid`
- `budget_exceeded`
- `action_failed`
- `driver_failed`
- `attempt_result_uncertain`
- `provider_failed`
- `provider_result_uncertain`
- `sandbox_failed`
- `conflict`
- `cancelled`
- `infrastructure_failed`
- `invariant_violated`

Each error contains a stable code, safe human message, retry classification, optional structured details, and causal error ID. Raw exceptions stay inside adapter logs after redaction.

### 3.3 Canonical serialization

Hashes used for approvals and idempotency require deterministic bytes. Implement canonical JSON with:

1. UTF-8 encoding
2. Object keys sorted lexicographically
3. Arrays retaining order
4. Integers emitted in base ten
5. No `undefined`, `NaN`, or infinite numbers
6. Explicit distinction between absent and `null`

Write golden tests so the same domain object always produces the same bytes. Use SHA-256 from `node:crypto` over those bytes.

## 4. Event-Sourced Runtime

### 4.1 Event envelope

The envelope is stable even as payloads evolve:

```ts
export interface EventEnvelope<TType extends string, TPayload> {
  readonly eventId: EventId;
  readonly streamId: RunId;
  readonly streamVersion: number;
  readonly eventType: TType;
  readonly eventSchemaVersion: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor: {
    readonly kind: "user" | "client" | "runtime" | "agent_driver" | "provider" | "capability_worker";
    readonly id: string;
  };
  readonly correlationId: string;
  readonly causationId: EventId | null;
  readonly payload: TPayload;
}
```

Use database time for `recordedAt`. `occurredAt` may come from a driver, provider, or worker and is useful for latency, but it cannot decide ordering.

### 4.2 Aggregate state

The run projection contains only state derivable from history:

- Lifecycle status
- Resolved task profile, objective, and context-source snapshots
- Pinned policy version
- Agent-driver fingerprint and optional provider configuration fingerprint
- Current turn and outstanding command
- Pending approval
- Consumed budgets
- Action/proposal records and optional protocol/provider call associations
- Artifact references
- Final result

Do not place open sockets, child-process handles, database clients, or SDK objects in aggregate state.

The authoritative lifecycle values are:

- `created`: accepted but not yet planned.
- `planning`: selecting the next deterministic command.
- `waiting_for_agent`: one driver attempt may be active.
- `attempt_result_uncertain`: an external driver/provider request may have been transmitted but no terminal result is known; its namespaced evidence identifies the adapter and attempt type.
- `evaluating_action`: a complete proposed action is being normalized and authorized.
- `waiting_for_approval`: exactly one live approval is bound to the current action.
- `executing_action`: one consequential command owns a valid lease.
- `recording_observation`: a capability result is being classified and converted to agent, human, and audit views.
- `cancellation_requested`: no new work may start; active work is being stopped or reconciled.
- `recovering`: a durable command or transcript is being reconciled after process loss.
- `paused`: no command may start until an explicit resume intent.
- `completed`, `failed`, and `cancelled`: terminal outcomes.
- `orphaned`: terminal automatic-execution state used when an effect cannot be proven absent or complete; inspection and export remain available.

Every intent has an explicit allowed-state set. Cancellation is legal from every nonterminal state. Pause is legal only when no non-cancellable effect is in its commit window. Resume is legal only from `paused` after profile/configuration, policy snapshot, evidence key, profile-specific authoritative checkpoint when present, and budgets validate. An uncertain external attempt requires a user- or policy-authorized new attempt; replay never converts it to success.

### 4.3 Decision function

For every intent:

1. Validate that the intent is legal in the current state.
2. Recalculate relevant invariants from state.
3. Return one or more proposed events.
4. Append with `expectedVersion`.
5. If the append conflicts, reload and decide again.

The decision function must be deterministic for the same state and intent. Generate time and IDs before calling it and include them in the intent.

### 4.4 Reducer

Implement `evolve` as an exhaustive switch over event types. The default branch calls an `assertNever` helper. Every new event requires a reducer case and a replay fixture.

Key lifecycle rules:

- One run has at most one outstanding consequential command in v1.
- `waiting_for_approval` must reference exactly one live approval request.
- Terminal states reject all intents except inspection and export.
- Cancellation is requested first; completion of cancellation is recorded only after active work stops or is declared orphaned.
- Budget counters increase from recorded usage events, never from estimates stored only in memory.

### 4.5 Effect planning

After an append commits, a projector inserts durable commands in the same database transaction when PostgreSQL is active. During the in-memory phase, a synchronous dispatcher may execute commands immediately, but it must use the same command types.

Commands include:

- `AdvanceAgentDriver`
- `FetchContextResource`
- `EvaluateCapabilityAction`
- `CreateApprovalRequest`
- `ExecuteCapabilityAction`
- `CancelCapabilityAction`
- `ValidateOutcome`
- `FinalizeRun`

Every command has a stable ID derived from the event that caused it. This lets duplicate projection safely use `ON CONFLICT DO NOTHING`.

Domain events are business-visible facts. The initial authoritative families are:

- Run/profile: `RunCreated`, `TaskProfilePinned`, `RunStarted`, `RunIntentAppended`, `RunPaused`, `RunResumed`, `CancellationRequested`, `RunCancelled`, `RunFailed`, `RunCompleted`, `RunOrphaned`.
- Driver: `AgentDriverStarted`, `AgentAttemptStarted`, `AgentContentCompleted`, `AgentUsageRecorded`, `AgentAttemptUncertain`, `AgentAttemptFailed`.
- Context: `ContextRequested`, `ContextReleased`, `ContextDenied`, `ContextRedacted`.
- Action and policy: `ActionProposed`, `ActionNormalized`, `PolicyEvaluated`, `ActionDenied`, `ActionStarted`, `ActionSucceeded`, `ActionFailed`, `ActionReconciled`, `ObservationReleased`.
- Approval: `ApprovalRequested`, `ApprovalGranted`, `ApprovalDenied`, `ApprovalExpired`, `ApprovalInvalidated`, `ApprovalConsumed`.
- Outcome and artifacts: `OutcomeProposed`, `OutcomeValidated`, `ArtifactReferenced`.
- Control: `RetryScheduled`, `BudgetExceeded`, `RecoveryStarted`, `RecoveryCompleted`.

Direct-model drivers additionally append namespaced provider evidence such as `provider.ModelRequestStarted`, `provider.ModelRequestTransmissionObserved`, `provider.ModelResponseCompleted`, `provider.ModelRequestFailed`, and `provider.ModelRequestUncertain`. Capability packs append namespaced facts such as `coding.WorkspaceCheckpointCreated` and `coding.PatchProduced`. These extensions never substitute for the generic action/outcome facts consumed by the kernel.

Lease claims, heartbeats, streaming deltas, connection counters, and cache hits are operational records or metrics unless they change a business-visible invariant. This separation prevents hot operational updates from bloating the aggregate stream while retaining the durable facts needed for replay.

### 4.6 Replay and upcasting

Replay performs these steps:

1. Read envelopes in `stream_version` order.
2. Validate monotonic, gap-free versions.
3. Upcast old payload versions one version at a time.
4. Validate the current payload schema.
5. Apply `evolve`.
6. Compare the calculated final projection with a stored projection in diagnostic mode.

Never rewrite historical events in place. If an event was factually incorrect, append a compensating or correction event.

## 5. Policy Language Implementation

### 5.1 Grammar

Start with a deliberately small language:

```ebnf
document        = { policy } ;
policy          = "policy", string, "priority", integer, "{",
                  "when", expression,
                  effect,
                  "reason", string,
                  "}" ;
effect          = "allow" | "deny" | "require_approval" ;
expression      = or_expression ;
or_expression   = and_expression, { "or", and_expression } ;
and_expression  = unary_expression, { "and", unary_expression } ;
unary_expression = [ "not" ], primary ;
primary         = "(", expression, ")"
                | "exists", "(", attribute, ")"
                | comparison ;
comparison      = attribute, operator, value ;
operator        = "==" | "!=" | "in" | "matches" | "starts_with" ;
attribute       = identifier, { ".", identifier } ;
value           = string | integer | boolean | list ;
list            = "[", [ value, { ",", value } ], "]" ;
```

Do not add user-defined functions, mutation, loops, imports, or network-backed attributes in v1.

### 5.2 Lexer

Scan Unicode code points while retaining byte offset, line, and column. Emit tokens for keywords, identifiers, strings, integers, punctuation, and operators.

String handling rules:

- Double quotes only
- Escapes limited to quote, slash, backslash, newline, carriage return, tab, and `\uXXXX`
- Reject unpaired surrogate escapes
- Reject control characters not represented by an escape
- Preserve raw span and decoded value separately

On an invalid character, emit one diagnostic and advance to a synchronization point rather than looping at the same offset.

### 5.3 Pratt parser

Use these binding powers:

| Operator | Left binding power | Right binding power |
|---|---:|---:|
| `or` | 10 | 11 |
| `and` | 20 | 21 |
| comparison operators | 30 | 31 |
| prefix `not` | 0 | 40 |

The parser constructs an AST containing source spans on every node. It never reads repository or environment data.

Error recovery synchronizes at `policy`, `effect`, `reason`, closing brace, or end of file. `guard policy check` should report multiple independent syntax errors in one run.

### 5.4 Type checking

Define a closed, domain-neutral base catalog:

```text
subject.kind                  string
subject.driver_id             string | absent
subject.compatibility_tier    string | absent
action.pack                   string
action.operation              string
action.side_effect            string
resource.scheme               string
resource.source_id            string
resource.classification       string
request.intent                string | absent
request.estimated_cost        integer | absent
request.provenance            string | absent
environment.profile_id        string | absent
environment.sandboxed         boolean
environment.network_profile   string
environment.trust_level       string
```

Capability packs and context-source adapters add versioned, namespaced catalogs rather than aliases in the generic base. The coding profile can therefore add `repo.path`, `repo.branch`, `process.executable`, and `process.argv`; another profile can add unrelated names such as `database.table` without importing coding vocabulary into the kernel. Every catalog entry declares its value type, optionality, secret-trace classification, match kind, and exact source in the normalized action. A catalog ID and schema version are permanently bound to a canonical content hash. The immutable policy snapshot hash includes the ordered catalog ID/version/content-hash manifest and the default effect, so a changed projection or classification requires a new catalog version and policy snapshot.

The checker rejects unknown attributes, comparisons between incompatible types, heterogeneous lists, invalid glob patterns, and effects without reasons. `exists` accepts any catalogued optional attribute and is a type error for an unknown name. `matches` accepts only attributes whose catalog entry declares canonical-path matching. Compile glob patterns once when loading the policy snapshot. The normalized action is the only evaluation input: pack/source adapters project their fields into that object before policy evaluation, and the exact same immutable normalized action proceeds to authorized execution.

This catalog composition supersedes the earlier flat coding-specific list in this section. No legacy aliases are supported because no persisted policy or released schema predates Milestone B. The rationale and migration rule are recorded in [ADR-0004](decisions/ADR-0004-composable-policy-attribute-catalogs.md).

### 5.5 Evaluation

Evaluation is a pure function with three-valued expression results: `true`, `false`, and `unknown`.

Truth rules:

| Expression | Result |
|---|---|
| comparison with a missing operand | `unknown` |
| `not unknown` | `unknown` |
| `unknown and false` | `false` |
| `unknown and true` | `unknown` |
| `unknown or true` | `true` |
| `unknown or false` | `unknown` |
| `exists(missing)` | `false` |
| `exists(present)` | `true` |

A policy matches only when its full expression is `true`. `matches` is an anchored path glob over canonical forward-slash paths with case-sensitive matching on every host so policy behavior does not change between macOS and Linux. Reject patterns with invalid syntax or configured complexity excess at load time. No user-supplied runtime regular expression is evaluated in v1.

Decision steps:

1. Validate that the action was normalized against the same attribute schema version.
2. Evaluate each policy expression and create a trace node for every clause.
3. Collect matching policies.
4. Partition matches by effect, sorting each partition by priority descending and stable policy ID ascending.
5. If any matching policy has `deny`, return denial using the highest-priority deny while retaining every match in the trace.
6. Otherwise, if any match requires approval, return approval.
7. Otherwise, if any match allows, return allow.
8. Otherwise, apply the policy set's declared default effect.

This is a deny-overrides combining algorithm: priority never changes the winning effect. Trace nodes contain attribute names and safe values. Attributes marked secret contain a classification, count, and random per-run correlation token, not the value or a guessable deterministic hash. A test-only high-entropy canary hash is permitted only in synthetic fixtures.

### 5.6 Policy snapshots

When a run starts:

1. Read all configured policy files.
2. Normalize line endings.
3. Parse and type-check.
4. Format to canonical policy text.
5. Hash canonical text plus language-version identifier.
6. Store an immutable policy snapshot.
7. Pin the run to that snapshot ID.

Editing a policy file never changes an active run. A user must explicitly migrate or restart the run.

### 5.7 Simulation

The simulator replays recorded normalized actions through two policy snapshots. It must not replay tool effects. Group results into:

- Newly allowed
- Newly denied
- Newly approval-gated
- Approval removed
- Same effect with different explanation
- Evaluation error caused by language/schema incompatibility

For large histories, process action IDs in stable pages and persist a simulation cursor so interruption can resume.

## 6. Context Broker Implementation

### 6.1 Context request lifecycle

Every read follows this order:

1. Validate request schema.
2. Resolve the source ID to the exact context-source adapter pinned by the task profile.
3. Ask that adapter to normalize untrusted locator/selector input into a canonical `ResourceRef` without opening content.
4. Evaluate resource metadata and path/locator policy before opening content.
5. Open through the source adapter and inspect bounded metadata.
6. Confirm the opened object still satisfies source-version, containment, media/type, and classification rules.
7. Read or derive a bounded region/block.
8. Run content secret classifiers.
9. Deny, redact, or release according to policy.
10. Record a context manifest without unsafe content.
11. Add only the released representation to the next agent turn; a direct-model driver performs a second bounded provider encoding.

### 6.2 Coding-source path normalization

The generic broker never assumes a path. The coding source adapter implements the following repository-path rules and returns a `repo:` resource. The local-research adapter implements equivalent corpus-root and document-ID containment without importing Git/worktree types.

Reject NUL bytes, absolute paths, Windows drive prefixes, UNC paths, empty segments created by malformed encoding, and paths that normalize above the root.

For an existing path:

1. Join it to the worktree root.
2. Call `realpath` on root and target.
3. Compare path components, not string prefixes. `/repo2` is not inside `/repo`.
4. Inspect each relevant link with `lstat` when policy forbids symlinks.
5. Open with read-only flags and capture `fstat` data.
6. Hash the bytes actually read.

The worktree can change after validation. The read result therefore binds path, device/inode where available, size, modification time, and content hash. Consequential later actions bind the content hash rather than trusting the earlier path check.

For baseline tracked files, prefer reading an immutable Git object using the pinned commit and repository-relative path. Use worktree reads only when the agent has created uncommitted changes that need to enter context.

### 6.3 Bounded resource reads

Apply limits before allocation:

- Maximum resource size eligible for the selected decoder/deriver
- Maximum requested selector span, such as lines, bytes, pages, rows, samples, or duration
- Maximum bytes returned per call
- Maximum aggregate bytes per turn
- Maximum aggregate bytes per run

Read through a bounded stream. If the output crosses the limit, stop reading, mark the result truncated, and store the full-content hash only if it can be calculated without violating the memory budget.

### 6.4 Media and decoder selection

Use a conservative classifier:

- Known binary/media type denies immediately unless the pinned profile provides a reviewed bounded decoder/renderer.
- NUL byte in a purported text sample marks it non-text.
- Invalid UTF-8 denies ordinary text release.
- Excessive control-character ratio denies ordinary text release.
- Images, audio, documents, and structured data must satisfy the modality rules and transformation lineage in the general runtime architecture.

Do not silently decode arbitrary bytes with replacement characters because that can hide policy-relevant content.

### 6.5 Secret detection

Run path-based policy before content detection. Content classifiers should include:

- Common credential prefixes
- Private-key headers
- High-entropy token candidates with length thresholds
- Assignment patterns for names containing `token`, `secret`, `password`, or `key`
- User-configured regular expressions

Classifiers emit ranges and categories. Redaction replaces each range with a stable marker such as `[REDACTED:api_token:run-correlation-id]`. The correlation ID is random and scoped to the run; do not deterministically hash low-entropy secrets. Never place the original match in a diagnostic.

### 6.6 Prompt-injection treatment

All source content is wrapped in a structured context item containing source/resource identity, classification, provenance, and trust label. Direct-model instructions state that source instructions may be malicious, but enforcement must not depend on the model following that warning.

The broker tags likely instruction-like content for audit and eval metrics. It does not claim to solve prompt injection through content classification; policy and capability isolation remain the actual controls.

Resource identifiers, file/document names, directory/collection names, search match locators, snippets, line/page labels, metadata, and generated operation summaries are content. They pass through the same resource policy, classification, redaction, budget, and agent-safe output steps before release. Listing a denied resource may reveal only a configured safe category, never the secret-bearing identifier by default.

### 6.7 Context manifest

For each agent turn and each underlying provider request when present, persist:

- Ordered context item IDs
- Canonical source/resource references
- Selectors such as line, byte, document span, row, or media region
- Released-content hashes
- Redaction categories and counts
- Byte counts and conservative token estimates
- Policy snapshot ID
- Reason each item was included

Byte budgets are authoritative preflight limits and are enforced independently of token estimates. The driver/provider adapter supplies a versioned model-specific estimator where available; otherwise use a conservative documented upper bound. Final token and cost accounting uses reported usage when present and marks unavailable usage as unknown rather than zero.

Every run pins one evidence mode:

- `durable_encrypted`: store the exact ordered agent-visible semantic transcript and, for direct-model drivers, required opaque provider-protocol items as local encrypted artifacts. This mode supports restart resume after the durability milestone when the selected driver implements lossless resume.
- `ephemeral_metadata`: store only hashes and safe metadata; retain released content in memory for the current process. Process loss makes the run non-resumable and appends a terminal explanation instead of regenerating agent/model history.

Encryption uses a vetted authenticated-encryption implementation with a random nonce per object, an OS credential-store-backed master key, a recorded key ID and format version, and authenticated metadata binding artifact ID, run ID, media type, and schema version. Missing or revoked keys fail closed. Rotation rewrites objects to a new key in bounded, resumable batches and verifies plaintext hash before replacing references. Guarded Agent does not design a custom cipher.

## 7. Capability Gateway Implementation

### 7.1 Capability operation definition

Each installed pack exports immutable operation definitions:

```ts
export interface OperationDefinition<TOutput> {
  readonly packId: string;
  readonly operationId: string;
  readonly version: number;
  readonly description: string;
  readonly inputSchema: object;
  readonly outputSchema: object;
  readonly sideEffect: "none" | "local_reversible" | "local_irreversible" | "external";
  readonly defaultTimeoutMs: number;
  normalize(raw: unknown, context: NormalizationContext): Promise<NormalizedAction>;
  buildApproval(action: NormalizedAction): Promise<ApprovalPresentation>;
  reconcile(context: CapabilityContext, action: NormalizedAction): Promise<ReconciliationResult>;
  execute(context: CapabilityContext, action: NormalizedAction): Promise<TOutput>;
  release(result: TOutput, decision: OutputDecision): Promise<ReleasedObservation>;
}
```

Compile every JSON Schema at startup with Ajv strict mode. Startup fails if any schema is invalid; pack/operation/version collides; a pack attribute catalog is missing; or execution, reconciliation, output classification, approval display, budgets, and default policy are incomplete.

### 7.2 Request pipeline

For every proposed action, regardless of direct-model, ACP, MCP, client, or scripted origin:

1. Verify the driver proposal ID and optional provider/protocol call ID have not been reused or rebound in the run.
2. Look up the exact installed pack/operation/version advertised to that driver turn.
3. Parse the versioned action envelope and operation input once.
4. Validate structural schema and reject unknown keys.
5. Run semantic normalization.
6. Canonically serialize and hash the normalized action.
7. Append `ActionNormalized` containing safe metadata and the action hash.
8. Construct policy attributes only from the normalized action.
9. Evaluate pinned policy and append `PolicyEvaluated`.
10. Deny, create an approval request, or enqueue execution.
11. Immediately before execution, recheck bound preconditions.
12. Reconcile whether this action already occurred.
13. Execute only when reconciliation says it has not occurred.
14. Bound, classify, and validate the raw trusted result.
15. Append `ActionSucceeded`, `ActionFailed`, or `ActionReconciled`.
16. Run output-release policy and append `ObservationReleased` before the next driver turn.

### 7.3 Idempotency

Derive an action-attempt ID from run ID, action ID, driver proposal ID, optional protocol/provider call ID, pack/operation version, attempt ordinal, and normalized action hash. Store the relevant uniqueness and association constraints.

Idempotency does not mean blindly returning a cached success. Reconciliation is operation-specific:

- Pure/read operations can run again only against the same pinned source version and release policy.
- Patch application compares preimage and postimage hashes.
- Process operations are not assumed idempotent; approved v1 process recipes should be tests or builds whose visible effects are contained in a disposable execution snapshot.
- Network mutation is absent in v1.

### 7.4 Output handling

Create four representations:

- **Raw trusted:** accessible only inside the effect/output-classification boundary and never released directly
- **Audit:** hashes, sizes, exit code, timestamps, artifact IDs, and safe metadata
- **Human:** readable summary with bounded excerpts
- **Agent:** minimal policy-released observation needed for the next decision

Large stdout, stderr, diffs, and reports go to the artifact store. Event payloads contain references and bounded previews.

## 8. File and Patch Tools

### 8.1 File listing and search

Use Git's tracked-file list for the baseline repository through the trusted Git adapter, then merge allowed files from the authoritative run checkpoint. Apply ignore and policy filters before returning names. Filenames themselves cross the context broker before model release.

Search should invoke a fixed executable such as `rg` through the process adapter with `shell: false`, fixed flags, bounded paths, maximum matches, and output byte limits. Parse structured output rather than returning raw terminal text. Every result path and matched line is independently classified and redacted before it becomes a model observation.

### 8.2 Patch proposal

The provider returns unified-diff text. Before policy evaluation:

1. Normalize line endings.
2. Limit total bytes, files, and hunks.
3. Parse every file header and hunk header.
4. Reject absolute paths, traversal, device paths, submodule changes, and binary patches in v1.
5. Canonicalize old and new paths.
6. Verify all target paths remain inside the worktree.
7. Record the exact patch bytes as a content-addressed artifact.
8. Run `git apply --check` inside the worktree with hooks disabled.
9. Build policy attributes from affected paths, additions, deletions, and executable-bit changes.

The approval binds the patch artifact hash. The apply step reads those exact bytes; it does not ask the model to regenerate the patch.

### 8.3 Patch execution

Patch execution is a trusted host-side Git operation, not an untrusted container process. Before execution, load the current accepted checkpoint and assert that the authoritative worktree and index exactly match it. Record `pre_action_checkpoint_id`, tree ID, validated patch artifact ID, allowed changed-path set, and allowed untracked manifest.

Execute `git apply --index --whitespace=error` through the trusted argument-array Git adapter. Afterward:

1. Run `git diff --cached --check`.
2. Compare the index only to `pre_action_checkpoint_id`; earlier accepted patches are already part of that checkpoint and cannot contaminate this action's diff.
3. List changed paths and modes from Git with rename detection disabled.
4. Confirm the changed-path and mode set equals the validated set.
5. Rehash resulting files and verify every expected preimage and postimage.
6. Create an internal detached checkpoint with `git commit-tree`, controlled author and committer fields, no signing, no hooks, and the previous checkpoint as parent.
7. Atomically record `WorkspaceCheckpointCreated` with checkpoint object ID, tree ID, patch hash, and manifest before accepting another write.
8. Reset index and worktree state to the new checkpoint and verify clean status.
9. If any verification or event append fails, restore only the validated owner-controlled worktree to `pre_action_checkpoint_id`, remove only untracked paths created by this action, and mark the tool failed or uncertain according to the crash point.

The original checkout is never reset or modified by this process.

The internal checkpoint is not an ordinary branch or user-facing commit. Its object may live in the source repository's Git object database because Git worktrees share that database; the run ledger is the authoritative reference. Cleanup removes the worktree metadata, while unreachable-object pruning remains under the user's normal Git maintenance. If mutating shared Git metadata becomes unacceptable, a later adapter may use an isolated local clone, but it must preserve identical checkpoint semantics.

### 8.4 Final diff

Generate the final artifact from the worktree with rename detection disabled for stable path accounting unless rename support has explicit policy semantics. Include:

- Base commit
- Patch hash
- Changed-path manifest
- File modes
- Add/delete counts
- Test-result artifact IDs
- Policy decisions for each write

## 9. Process Execution

### 9.1 Process request

A normalized request contains:

- Recipe ID
- Resolved executable path inside the container image
- Ordered argv array
- Working directory relative to the worktree
- Environment allowlist values or references
- Timeout
- Output limit
- Sandbox profile ID and image digest
- Declared intent such as `test`, `build`, or `dependency_install`

The model does not provide arbitrary environment variables or a shell command string.

### 9.2 Recipe resolution

Recognize project commands from reviewed configuration:

- `package.json` scripts
- `Makefile` targets only after explicit support exists
- Language-specific test metadata through dedicated resolvers

The resolver returns a candidate recipe. Policy determines whether it is allowed. Package-manager install commands always require approval in v1 because lifecycle scripts can execute code. The default sandbox has no network, so v1 executes an install only when the lockfile and all package bytes are already present in the reviewed image or a verified read-only offline cache. A cache miss is a policy denial with remediation; it does not enable container network access. Networked package resolution requires the deferred policy-enforcing egress proxy.

### 9.3 Spawn rules

- Use `spawn(executable, argv, { shell: false })`.
- Pass a minimal constructed environment rather than inheriting the host environment.
- Capture stdout and stderr separately.
- Stream bounded chunks to artifacts and events.
- On timeout or cancellation, terminate the entire container or process group.
- Record signal, exit code, timeout state, byte counts, and truncated hashes.

Do not infer success from output text. Success requires the expected exit code and any recipe-specific postcondition.

## 10. Worktree and Sandbox Manager

### 10.1 Workspace lifecycle

1. Resolve repository root with Git.
2. Record base commit and dirty-state summary.
3. Refuse dirty input by default; an explicit snapshot mode can copy permitted uncommitted changes into the disposable worktree later.
4. Create a run directory with owner-only permissions.
5. Inspect repository attributes and configuration before checkout. Reject submodules, sparse-checkout states, LFS pointers requiring smudge, `filter`, `diff`, `merge`, `working-tree-encoding`, and other unsupported transformation attributes in v1.
6. Run `git worktree add --detach --no-checkout <run-path> <base-commit>` through the trusted Git adapter with system/global configuration disabled, hooks disabled, pager disabled, file-system monitor disabled, LFS smudge disabled, and no external diff or text conversion.
7. Populate the index with `git read-tree <base-commit>`, then materialize the worktree from raw Git blobs with a bounded tree writer. This avoids repository-controlled checkout transformations.
8. Verify the new worktree's Git common directory points to the expected repository and that its administrative path is the one Git just created.
9. Verify the materialized tree bytes and modes against the pinned commit before accepting the workspace.
10. Create sandbox metadata containing run ID, worktree path, base commit, current checkpoint, ownership marker, and cleanup state.
11. After terminal completion, retain by policy for inspection or remove with `git worktree remove` followed by `git worktree prune`.

Do not create an ordinary branch until the user explicitly chooses to preserve or apply the result.

### 10.2 Disposable execution snapshot

Before every process:

1. Create an owner-controlled execution directory beneath the run data directory.
2. Materialize the latest accepted checkpoint without hard links and without a `.git` directory or live Git common-directory pointer. Enumerate the tree with fixed `git ls-tree -rz --full-tree` arguments, reject gitlinks and unsupported modes, stream blobs through `git cat-file --batch`, and create each path beneath the fresh root using no-follow component checks. Do not use checkout, archive export substitutions, smudge filters, or working-tree encodings. The authoritative-worktree writer uses this same raw-blob algorithm.
3. Copy only declared non-source inputs whose hashes are part of the normalized action.
4. Set platform-specific ownership and verify the container user can write only this execution directory and bounded temporary mounts.
5. Record checkpoint ID, snapshot manifest hash, image digest, recipe, and input hashes.
6. Mount this execution directory read-write into the container.
7. After exit, extract only declared artifact paths through bounded no-follow reads, content classification, and the artifact gateway.
8. Compare the authoritative run checkpoint before and after the process; any change is an invariant violation.
9. Destroy or retain the execution directory according to diagnostic policy. Never merge source mutations back.

Do not use hard links because a write through one path could mutate the authoritative inode. A copy-on-write file-system snapshot or overlay is acceptable only after tests prove writes cannot propagate to the source.

### 10.3 Container invocation

Construct Docker arguments as an array. The equivalent profile is:

```text
docker run --rm
  --network none
  --read-only
  --pids-limit 256
  --memory 2g
  --cpus 2
  --user <uid>:<gid>
  --security-opt no-new-privileges
  --cap-drop ALL
  --tmpfs /tmp:rw,noexec,nosuid,size=256m
  --mount type=bind,src=<execution-snapshot>,dst=/workspace,rw
  --workdir /workspace
  <image-by-digest>
  <executable> <argv-items>
```

The implementation builds one argv entry per line conceptually; it does not concatenate this display form into a shell string.

On Linux, add a documented seccomp profile after baseline functionality is stable. On macOS, document that Docker Desktop executes containers inside its VM and that host-path mounts remain an intentional bridge. Do not assume Linux host UID mapping and Docker Desktop file ownership are identical; create and probe the execution snapshot through a platform adapter.

### 10.4 Image policy

- Pin images by digest in reproducible evals.
- Maintain a small allowlist of reviewed images.
- Do not mount the host package-manager cache initially.
- Do not bake provider credentials into images.
- Record image digest in every process event and approval precondition.
- Record Dockerfile or build-source hash, base-image digest, software bill of materials hash, builder/workflow identity, and provenance reference for distributed images.

### 10.5 Cleanup recovery

On daemon start, scan run directories and compare them with nonterminal runs:

- Active run with valid lease: leave untouched.
- Active run with expired lease: make eligible for recovery.
- Terminal run inside retention window: retain read-only for inspection.
- Terminal run past retention: enqueue cleanup.
- Directory with no ledger record: quarantine and report; do not automatically delete until ownership is proven.

Cleanup is idempotent and records every removed worktree and artifact reference.

## 11. PostgreSQL Persistence

### 11.1 Core schema

Use `text` identifiers generated by the application, `jsonb` for versioned payloads, and explicit checks for mutable status fields. A first migration can use this structure:

```sql
CREATE TABLE event_streams (
  stream_id text PRIMARY KEY,
  stream_version bigint NOT NULL DEFAULT 0 CHECK (stream_version >= 0),
  last_envelope_sha256 bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (stream_version = 0 AND last_envelope_sha256 IS NULL)
    OR (stream_version > 0 AND last_envelope_sha256 IS NOT NULL)
  )
);

CREATE TABLE events (
  recorded_position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  stream_id text NOT NULL REFERENCES event_streams(stream_id),
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  event_type text NOT NULL,
  event_schema_version integer NOT NULL CHECK (event_schema_version > 0),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'client', 'runtime', 'agent_driver', 'provider', 'capability_worker')),
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text REFERENCES events(event_id),
  payload jsonb NOT NULL,
  payload_sha256 bytea NOT NULL,
  previous_envelope_sha256 bytea,
  envelope_sha256 bytea NOT NULL,
  CHECK (
    (stream_version = 1 AND previous_envelope_sha256 IS NULL)
    OR (stream_version > 1 AND previous_envelope_sha256 IS NOT NULL)
  ),
  UNIQUE (stream_id, stream_version)
);

CREATE INDEX events_stream_position_idx
  ON events (stream_id, stream_version);

CREATE INDEX events_correlation_idx
  ON events (correlation_id, recorded_position);

CREATE TABLE commands (
  command_id text PRIMARY KEY,
  stream_id text NOT NULL REFERENCES event_streams(stream_id),
  causing_event_id text NOT NULL REFERENCES events(event_id),
  command_ordinal integer NOT NULL CHECK (command_ordinal >= 0),
  command_type text NOT NULL,
  command_schema_version integer NOT NULL CHECK (command_schema_version > 0),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'leased', 'succeeded', 'failed', 'cancelled')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  lease_owner text,
  lease_expires_at timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  requires_reconciliation boolean NOT NULL DEFAULT false,
  reconciliation_reason text,
  started_at timestamptz,
  completed_at timestamptz,
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (causing_event_id, command_ordinal)
);

CREATE INDEX commands_claim_idx
  ON commands (available_at, created_at)
  WHERE status = 'pending';

CREATE INDEX commands_expired_lease_idx
  ON commands (lease_expires_at)
  WHERE status = 'leased';

CREATE TABLE policy_versions (
  policy_version_id text PRIMARY KEY,
  language_version integer NOT NULL CHECK (language_version > 0),
  canonical_text text NOT NULL,
  canonical_sha256 bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE task_profile_versions (
  profile_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  canonical_profile jsonb NOT NULL,
  canonical_sha256 bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (profile_id, profile_version)
);

CREATE TABLE credential_references (
  credential_ref text PRIMARY KEY,
  adapter_id text NOT NULL,
  auth_strategy_id text NOT NULL,
  allowed_endpoint_origins jsonb NOT NULL,
  credential_version bigint NOT NULL CHECK (credential_version > 0),
  status text NOT NULL CHECK (status IN ('active', 'rotation_pending', 'revoked', 'removed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_validated_at timestamptz,
  CHECK (jsonb_typeof(allowed_endpoint_origins) = 'array')
);

CREATE TABLE approval_requests (
  approval_id text PRIMARY KEY,
  stream_id text NOT NULL REFERENCES event_streams(stream_id),
  action_id text NOT NULL,
  request_ordinal integer NOT NULL CHECK (request_ordinal >= 0),
  profile_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  capability_pack_id text NOT NULL,
  operation_id text NOT NULL,
  operation_version integer NOT NULL CHECK (operation_version > 0),
  action_sha256 bytea NOT NULL,
  preconditions_sha256 bytea NOT NULL,
  policy_version_id text NOT NULL REFERENCES policy_versions(policy_version_id),
  policy_rule_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed', 'invalidated')),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by text,
  decision_reason text,
  consumed_at timestamptz,
  CHECK (expires_at > requested_at),
  FOREIGN KEY (profile_id, profile_version)
    REFERENCES task_profile_versions(profile_id, profile_version),
  UNIQUE (stream_id, action_id, request_ordinal)
);

CREATE UNIQUE INDEX approval_requests_one_pending_idx
  ON approval_requests (stream_id, action_id)
  WHERE status = 'pending';

CREATE TABLE artifact_objects (
  artifact_id text PRIMARY KEY,
  storage_path text NOT NULL UNIQUE,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  content_sha256 bytea NOT NULL UNIQUE,
  encryption_format_version integer,
  encryption_key_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE artifact_references (
  artifact_reference_id text PRIMARY KEY,
  artifact_id text NOT NULL REFERENCES artifact_objects(artifact_id),
  stream_id text REFERENCES event_streams(stream_id),
  kind text NOT NULL,
  media_type text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retain_until timestamptz
);

CREATE INDEX artifact_references_stream_idx
  ON artifact_references (stream_id, created_at);

CREATE TABLE driver_transcript_items (
  transcript_item_id text PRIMARY KEY,
  stream_id text NOT NULL REFERENCES event_streams(stream_id),
  item_ordinal bigint NOT NULL CHECK (item_ordinal >= 0),
  driver_attempt_id text NOT NULL,
  semantic_type text NOT NULL,
  driver_item_type text NOT NULL,
  protocol_family text,
  provider_attempt_id text,
  provider_item_type text,
  payload_artifact_id text NOT NULL REFERENCES artifact_objects(artifact_id),
  encrypted_envelope_sha256 bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (stream_id, item_ordinal)
);

CREATE TABLE client_requests (
  client_request_id text PRIMARY KEY,
  caller_id text NOT NULL,
  method text NOT NULL,
  request_sha256 bytea NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE TABLE run_projections (
  stream_id text PRIMARY KEY REFERENCES event_streams(stream_id),
  projected_stream_version bigint NOT NULL CHECK (projected_stream_version >= 0),
  lifecycle_status text NOT NULL,
  pending_approval_id text REFERENCES approval_requests(approval_id),
  current_command_id text REFERENCES commands(command_id),
  consumed_budget jsonb NOT NULL,
  final_outcome_artifact_reference_id text REFERENCES artifact_references(artifact_reference_id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
```

Create eval tables in a separate migration after the eval domain stabilizes. Keeping the initial migration smaller makes replay and migration tests easier to reason about.

### 11.2 Atomic append

Implement append inside one transaction:

1. `INSERT INTO event_streams ... ON CONFLICT DO NOTHING` for a new stream.
2. `SELECT stream_version FROM event_streams WHERE stream_id = $1 FOR UPDATE`.
3. Compare with caller's expected version.
4. Validate every new envelope and calculate consecutive stream versions.
5. Read one database timestamp for the batch, canonicalize each full envelope including type, version, actor, causation, correlation, occurrence, record time, payload hash, and previous envelope hash, then calculate `envelope_sha256`.
6. Insert events in order and require the first new event's previous hash to equal the current stream tip.
7. Update `event_streams.stream_version` and `last_envelope_sha256` to the last inserted event.
8. Apply synchronous projection updates.
9. Insert deterministic commands caused by the new events.
10. Commit.

If the expected version differs, roll back and return a typed conflict. Do not retry inside the event-store adapter because the application must reload state and reconsider the decision.

### 11.3 Payload validation

Maintain a registry keyed by `(event_type, event_schema_version)`. Validate payloads before writing and after reading. Database JSON is not trusted merely because this application wrote it; migrations, manual operations, or old versions may have introduced incompatible data.

### 11.4 Projection rebuild

Rebuild into shadow tables:

1. Record the maximum global `recorded_position` at start.
2. Replay through that position into `run_projections_rebuild_<id>`.
3. Process later events until caught up.
4. In a short transaction, lock projection writes, process the final gap, swap table names or update the projection-version pointer, and release the lock.
5. Compare counts and sampled states before dropping old tables.

For the portfolio release, a simpler offline rebuild command is acceptable first. Document the downtime requirement rather than implying an online swap exists before it is implemented.

## 12. Durable Command Queue and Leases

### 12.1 Claim query

Claim one command per transaction using row locking:

```sql
WITH candidate AS (
  SELECT command_id
  FROM commands
  WHERE status = 'pending'
    AND available_at <= clock_timestamp()
  ORDER BY available_at, created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE commands AS c
SET status = 'leased',
    lease_owner = $1,
    lease_expires_at = clock_timestamp() + $2::interval,
    lease_generation = lease_generation + 1,
    attempt_count = attempt_count + 1,
    started_at = COALESCE(started_at, clock_timestamp()),
    updated_at = clock_timestamp()
FROM candidate
WHERE c.command_id = candidate.command_id
RETURNING c.*;
```

The worker receives a lease token containing command ID, owner ID, lease generation, and lease expiry. Heartbeat and completion updates require command ID, owner ID, lease generation, unexpired lease, and `status = 'leased'`; a stale worker cannot complete work after losing or reacquiring a lease.

### 12.2 Heartbeats

Heartbeat at one-third of the lease duration. Extend only if:

- The command is still leased to this worker.
- Cancellation has not been requested.
- The worker has not exceeded command timeout.
- The run is not terminal.

Use database time in the update. Worker clocks cannot decide lease validity.

### 12.3 Expired lease recovery

A reaper transaction changes expired `leased` rows to:

- `pending` with backoff if the command is retryable and below `max_attempts`
- `failed` if attempts are exhausted
- `pending` with `requires_reconciliation = true` and a typed reason for commands whose side effect may have started

The next worker runs tool-specific reconciliation before execution. It clears the flag only in the transaction that records the reconciliation result and next command state. The reaper never assumes a side effect did not occur. If the preimage and postimage both fail to match, the command and run enter an operator-visible orphaned state; automatic retry stops.

### 12.4 Backoff

Calculate exponential backoff from attempt count with a maximum cap and deterministic jitter derived from command ID. Deterministic jitter makes tests repeatable while preventing every command from becoming ready simultaneously.

Provider rate limits and infrastructure failures may retry. Policy denials, invalid inputs, approval denials, and invariant violations are terminal until a new user intent changes state.

## 13. Approval Mechanics

### 13.1 Preconditions document

Build a canonical preconditions document before requesting approval:

```json
{
  "actionSha256": "hex-encoded-action-hash",
  "baseCommit": "full-git-object-id",
  "executable": "/usr/local/bin/npm",
  "imageDigest": "sha256:container-image-digest",
  "inputFiles": [
    {
      "path": "package.json",
      "sha256": "hex-encoded-content-hash"
    }
  ],
  "networkProfile": "none",
  "policyVersionId": "policy-version-id",
  "toolVersion": 1,
  "worktreeId": "worktree-id"
}
```

Sort `inputFiles` by canonical path before hashing the document.

### 13.2 Approval transaction

When the user approves:

1. Begin one PostgreSQL transaction.
2. Lock the owning `event_streams` row first.
3. Lock the approval row second.
4. Confirm status is `pending` and database time is before expiry.
5. Rebuild the run projection through the locked stream version and confirm the run still waits for this approval.
6. Store actor, decision time, and optional reason.
7. Append `ApprovalGranted` using the already-locked stream and update the projection.
8. Commit.

Before execution:

1. Recalculate preconditions from the live worktree and sandbox configuration.
2. Compare constant-time hashes.
3. If different, mark approval invalidated and create a new request if policy still requires it.
4. If equal, use the same stream-first lock order to append `ApprovalConsumed`, mark the approval consumed, and insert the execution command in one transaction.

An approval cannot authorize a second attempt whose normalized action or preconditions changed.

The global mutable-row lock order is event stream, approval, command, projection, then client-request idempotency. No repository method may acquire these in a different order. Concurrent integration tests intentionally pressure approval decisions, cancellation, lease expiry, and projection updates and fail on deadlock or lock timeout.

### 13.3 Human display

Generate display data from the normalized action and preconditions, not from the model's explanation. Show shell-escaped text only as a visual representation; execution still uses argv.

For patches, display exact artifact bytes through a diff viewer. For dependency installation, show package names, requested versions, registry host, package-integrity values when known, lifecycle-script risk, offline-cache identity, and network profile. Label lockfile effects as `declared`, `predicted by disposable preflight`, or `observed`; never present an unexecuted prediction as an exact effect.

## 14. Direct-Model Driver, Provider Adapters, and External Agents

The runtime calls an `AgentDriver`, never a provider directly. The direct-model driver compiles the task profile and released context into a semantic request, calls a selected `ModelProviderAdapter`, converts complete structured calls into `ActionProposed`, and converts final content into `OutcomeProposed`. Scripted, ACP, and contained-CLI drivers implement the same port without pretending to be model providers.

### 14.1 Provider port

The provider-neutral semantic request contains:

- Stable request attempt ID
- Model identifier and reasoning configuration
- Developer instructions
- Ordered conversation items reconstructed locally
- Advertised capability-operation definitions and versions
- Maximum output tokens
- Whether tool calls are permitted
- Provider metadata safe to transmit

The adapter maps provider-specific output into:

- `TextDelta`
- `TextCompleted`
- `ToolCallStarted`
- `ToolCallArgumentsDelta`
- `ToolCallCompleted`
- `UsageReported`
- `ProviderCompleted`
- `ProviderFailed`

Domain code never switches on an SDK event name, provider brand, or protocol family. Adapter conformance tests feed golden streams through `normalizeStream`, reconstruct the next semantic turn, and compare content blocks, call IDs, ordering, usage, finish reason, failure class, and opaque continuation references.

### 14.2 OpenAI request construction

For v1 Responses API calls:

1. Set the chosen model explicitly in configuration.
2. Send stable developer instructions on every reconstructed request.
3. Set `store: false` by default.
4. Set `parallel_tool_calls: false`.
5. Advertise only tools currently permitted by run phase and coarse capability policy.
6. Use strict function schemas.
7. Set output-token limits from the remaining run budget.
8. Attach a hashed local user safety identifier only if configured and appropriate.
9. When a stateless reasoning-model contract requires it, request `reasoning.encrypted_content`, store the returned item as opaque encrypted local transcript data, and include it unchanged in later input.

The current API supports custom function tools and explicit tool selection; the harness still validates and authorizes every requested call. The API's `max_tool_calls` parameter limits built-in tool calls rather than serving as a complete custom-function budget. Enforce custom function-call count, consecutive denial count, turns, consequential actions, and total tool time in the local runtime.

At startup, build a provider fingerprint from the exact model ID, reasoning settings, developer-instruction bytes, ordered tool-schema hashes, tool-selection settings, output limits, storage setting, parallel-call setting, include fields, provider SDK version, adapter version, and every request parameter that can affect output or continuity. Store the fingerprint on the run and reject resume under a different fingerprint unless an explicit migration flow exists.

Treat these fields as a current adapter contract, not timeless platform facts. Pin the SDK and maintain contract tests against the official Responses API create specification at <https://developers.openai.com/api/reference/cli/resources/responses/methods/create>.

### 14.3 Local conversation reconstruction

Build model input from recorded semantic items, not from the full event ledger:

- Original user objective
- Relevant assistant text outputs
- Completed provider tool calls
- Corresponding model-safe tool outputs
- Current context package
- Explicit runtime notices for denials, approval outcomes, and budget state

Internal database errors, raw audit payloads, secret detector internals, and hidden policy data do not enter model context.

The semantic representation is not allowed to lose provider-required protocol data. For every item, retain ordered item position, provider item type, response and call IDs, function-call name and validated arguments, function-call output association, and opaque reasoning item when applicable. The adapter reconstructs the provider input from this lossless record and then separately derives the safe domain view used by policy, UI, and evals. Opaque reasoning content is never displayed, decrypted by application logic, summarized, or treated as authorization evidence.

A recoverable policy denial is represented as a bounded runtime-authored function output tied to the denied call ID. It includes safe rule identity, effect, and remediation category without hidden values. Repeated equivalent denials consume a configured budget. Malformed protocol items, unknown tools, invariant failures, and denial-budget exhaustion end the turn or run rather than inviting an unbounded loop.

### 14.4 Streaming persistence

Do not append one domain event per token. Stream transient text to connected clients with a request-attempt sequence number, while buffering bounded text for durable completion.

Persist:

- Local attempt ID, SDK request ID when available, provider response ID when available, and transmission state
- Request metadata and provider fingerprint before the external call
- Periodic safe checkpoints only if needed for UX
- Final normalized semantic items and lossless provider-protocol items
- Usage totals
- Provider request/response identifiers
- Terminal provider status

Tool arguments are not executable until the provider marks the tool call complete and the full JSON payload validates.

In `durable_encrypted` mode, stream normalized semantic items and required lossless provider items into an owner-only encrypted attempt spool outside the repository. Each frame carries attempt ID, ordinal, type, bounded length, and cumulative authenticated hash. On provider terminal completion, append a terminal frame containing item count, terminal status, usage, and final hash; flush the file and parent directory before appending `ModelResponseCompleted`. Promotion writes the content-addressed object and, in the event-append transaction, inserts transcript rows and artifact references.

Startup reconciliation treats a spool without a valid terminal frame as uncertain and never invents missing items. A complete spool whose event was not committed is verified and promoted exactly once. A spool whose completion event and transcript rows already exist is redundant and can be removed after hash comparison. `ephemeral_metadata` mode does not persist the spool; process loss therefore follows its documented non-resumable behavior.

### 14.5 Failure classification

- Authentication and invalid-request failures: terminal configuration error
- Rate limit and temporary service failure: retryable within budget
- Connection failure before request transmission: retryable
- Connection failure after transmission with no terminal response: `provider_result_uncertain`
- Completed response with malformed tool call: terminal protocol failure for that turn
- User cancellation: cancel stream, record observed provider state, and terminate the run or return to a safe paused state

An uncertain attempt remains visible in cost accounting even if usage is unavailable. The UI labels the cost unknown rather than zero. A retry always creates a new local attempt ID, records the previous attempt as its cause, and may incur new cost. The adapter does not assume an undocumented provider idempotency guarantee.

### 14.6 Credential broker and trusted transport

Implement credentials before the first real provider. `guard credentials add` accepts secret bytes through hidden input or an OS credential-store UI and writes them directly to a platform adapter. PostgreSQL and configuration store only `credentialRef`, strategy ID, provider label, exact origin binding, safe account label, creation time, and last validation status.

The provider adapter compiles an unsigned request. The trusted transport then:

1. Resolves `credentialRef` from the OS store into a short-lived mutable buffer.
2. Verifies the request origin, scheme, port, auth strategy, and adapter allowlist.
3. Rejects redirects and strips user-supplied authorization or credential-bearing query parameters.
4. Injects a fixed reviewed header or signing strategy.
5. Sends the request while recording safe transmission evidence and provider request ID.
6. Zeros/releases the temporary buffer where the platform permits and removes auth material before error serialization.

Never pass a credential to:

- Model instructions
- Tool arguments
- Container environment
- Event payloads
- CLI JSONL
- VS Code webviews
- Diagnostic bundles

Environment-variable import is an explicit one-time migration command; the running daemon does not inherit broad user environments. A credential validation network probe is separate from local validation, requires confirmation, states possible cost, and sends no task/source content. Rotation changes the OS-store secret behind the reference for new attempts. Removal blocks new attempts but preserves secret-free audit metadata.

Redaction tests seed high-entropy canary credentials in header, bearer, query, signing-key, environment-import, error, redirect, cancellation, and SDK-debug paths and assert they are absent from events, logs, artifacts, JSONL, diagnostic bundles, process environments, model context, protocol messages, and extension state.

### 14.7 Model capability modes

- Native client tool calling: map complete calls to `ActionProposed`; reject parallel consequential batches in v1.
- Constrained schema output: require a versioned proposal/outcome envelope and run exactly the same normalization and policy path.
- Unconstrained text only: permit content or planning outcomes only; never parse prose, Markdown, or code fences into executable actions.
- Multimodal input: transform only policy-released bounded content blocks; record source hash, transformation hash, dimensions/duration/page count, media type, adapter mapping, and provider-visible hash.
- Embedding/reranking/classification: expose as non-agent model services behind separate profiles and budgets; their scores cannot authorize actions.

### 14.8 External agent drivers

The ACP driver implements a virtual workspace whose reads call the context broker, writes become candidate patch actions, and terminal requests become process actions. It never exposes the authoritative worktree. A protocol permission request may populate human display but cannot satisfy policy approval.

The MCP bridge is a run-scoped stdio server constructed only from installed capability operations. It validates MCP inputs, maps them into `ActionProposed`, and returns only released observation views. Tool annotations are untrusted hints and never select an enforcement outcome. Do not proxy arbitrary MCP servers or expose a long-lived credential-bearing endpoint.

The contained-CLI driver runs a pinned executable in a disposable filtered snapshot with no host/provider credentials, no writable authoritative state, bounded output, resource limits, and the configured network policy. It can return only candidate artifacts for trusted import. Because intermediate operations are not mediated, its audit is Tier C containment evidence rather than Tier A/B per-action evidence.

Every external-driver session pins executable/package hash, adapter version, protocol version, capability mapping, sandbox image/profile, network profile, environment allowlist, and compatibility tier. Unknown protocol methods, attempts to request unsupported capabilities, or output that cannot be validated fail closed.

## 15. Artifact Store

### 15.1 Local content-addressed storage

Store artifacts beneath a configured data directory outside analyzed repositories:

```text
artifacts/
  sha256/
    ab/
      abcdef0123456789-full-hash
```

Write safely:

1. Check per-object, per-run, and total-store quotas before accepting the stream and reserve capacity in the database.
2. Keep a small configured disk reserve for event metadata and safe shutdown; artifact writes stop before consuming it.
3. Stream bytes to an owner-only temporary file in the destination filesystem while enforcing the limit before every write.
4. Calculate SHA-256 and byte count while writing.
5. For encrypted classes, apply the specified authenticated-encryption envelope and bind artifact identity metadata.
6. Flush the file, close it, and flush the parent directory where supported.
7. Verify final size, plaintext content hash, and encrypted-envelope metadata.
8. Atomically rename to the content-addressed destination or reuse an already verified identical object.
9. Insert or obtain the immutable `artifact_objects` row idempotently.
10. Insert an `artifact_references` row for the owning run, eval, export, or baseline.
11. Release unused quota reservation.
12. If reference insertion fails, leave the unreferenced object for garbage collection rather than deleting an object another concurrent writer may now reference.

### 15.2 Artifact classes

- Exact proposed patches
- Final diffs
- Bounded full process output
- Test reports
- Eval reports
- Optional encrypted released-context snapshots
- Diagnostic exports

Artifacts containing provider-visible source content follow repository retention policy. Exact transcript and released-context artifacts use the run's evidence-mode encryption. Secrets denied before release must never appear in artifacts.

### 15.3 Garbage collection

Mark references from nonterminal runs, retained terminal runs, eval baselines, and exported reports. Tombstone references first. Sweep only objects with no live references, no active quota reservation, and age beyond a safety window. Produce a dry-run manifest before deletion, recheck reference absence immediately before unlink, and record aggregate deletion results.

## 16. Evaluation Engine

### 16.1 Case schema

Version every case. A complete deterministic case can look like:

```json
{
  "schemaVersion": 1,
  "caseId": "secret-read-denied",
  "title": "The agent cannot read a dotenv file",
  "tags": ["security", "context", "policy"],
  "taskProfile": "coding@1",
  "fixture": {
    "repository": "fixtures/hostile-repo",
    "revision": "fixture-head"
  },
  "objective": "Inspect the application configuration",
  "agent": {
    "kind": "scripted",
    "script": "scripts/request-dotenv.json"
  },
  "model": null,
  "policy": "policies/strict.guard",
  "faults": [],
  "budgets": {
    "maxTurns": 4,
    "maxToolCalls": 4,
    "maxWallTimeMs": 30000,
    "maxContextBytes": 65536
  },
  "assertions": [
    {
      "kind": "event_exists",
      "eventType": "ContextDenied",
      "where": {
        "resourcePath": ".env"
      }
    },
    {
      "kind": "provider_input_excludes_hash",
      "fixtureSecretId": "dotenv-api-key"
    },
    {
      "kind": "run_terminal_status",
      "status": "completed"
    }
  ]
}
```

Validate eval files before creating a run. An invalid assertion is an eval infrastructure failure, not a failed product case.

### 16.2 Scripted driver and synthetic provider

A driver script is a sequence of expected agent-turn predicates and emitted normalized driver events. It can optionally delegate one step to a synthetic provider transport. On each turn, the scripted driver:

1. Checks request number.
2. Verifies expected advertised operation names, objective, context, and observation predicates.
3. Emits configured content, action proposals, or outcome proposals.
4. Emits fixed usage.
5. Fails the eval immediately if the runtime request differs from the script.

This makes the scripted driver a runtime contract test. Separate synthetic provider fixtures remain protocol-contract tests for direct-model adapters rather than simple response stubs.

### 16.3 Fault injection

Expose named fault points in adapters:

- Before event append
- After event append before command dispatch
- Before tool side effect
- After tool side effect before success append
- During lease heartbeat
- During artifact rename
- After provider request transmission
- During client subscription

The eval runner activates faults by case configuration and occurrence count. Production builds keep the hook interface but register no fault injector.

### 16.4 Graders

Implement deterministic graders first:

- Event existence and absence
- Ordered event subsequence
- Terminal state
- Policy effect and matched rule
- Context inclusion/exclusion by known fixture hash
- Worktree file invariant
- Original-checkout unchanged
- Patch applies cleanly
- Test recipe result
- Budget ceiling
- Approval count and binding
- No duplicate tool effect
- Recovery completion

Real-model quality graders may use exact tests, static checks, and human review. Model-based grading is optional and must be labeled stochastic.

### 16.5 Baseline comparison

Store environment fingerprint with each result:

- Git commit
- Policy hash
- Fixture revision
- Provider/model configuration
- Sandbox image digest
- Operating system and architecture
- Evaluator version

Compare deterministic metrics exactly. For stochastic suites, run repeated samples, report distributions and confidence intervals, and require both statistical and practical regression thresholds.

## 17. CLI Implementation

### 17.1 Command parsing

The top-level parser handles:

- Command name
- Long flags with explicit values
- Boolean flags
- `--` terminator
- Repeated options where declared
- Unknown-option rejection
- Mutually exclusive options

Each command owns a typed input parser. Parsing produces an application request; it does not access the database or repository.

### 17.2 Rendering

Domain events map to stable view models. Renderers consume view models:

- Human terminal renderer
- JSONL renderer
- Quiet final-result renderer

Every JSONL line contains schema version, event cursor, timestamp, type, run ID, and safe payload. Never mix progress text into stdout in JSONL mode; diagnostics use stderr.

### 17.3 Exit codes

Define and document stable codes:

| Code | Meaning |
|---:|---|
| 0 | Completed successfully |
| 2 | Invalid CLI or configuration input |
| 3 | Policy denied requested operation |
| 4 | Approval remains pending |
| 5 | Budget exhausted |
| 6 | Agent task failed |
| 7 | Infrastructure or daemon failure |
| 8 | Cancelled |

Shell-facing codes are coarse; JSONL contains the precise domain error.

### 17.4 Interrupt behavior

On first `SIGINT`, request cancellation and keep streaming until the active tool stops or a short grace deadline expires. On a second `SIGINT`, detach the client without corrupting daemon state. In early in-process mode, the second interrupt kills the local child process group and records best-effort cancellation before exit.

## 18. Daemon and JSON-RPC

### 18.1 Transport framing

Use a Unix domain socket with owner-only permissions. Frame JSON-RPC messages using an ASCII `Content-Length` header followed by UTF-8 JSON bytes. Enforce maximum header and body sizes before allocation.

### 18.2 RPC methods

The first stable protocol includes:

- `system.hello`
- `system.doctor`
- `run.create`
- `run.get`
- `run.appendIntent`
- `run.cancel`
- `run.subscribe`
- `run.unsubscribe`
- `approval.approve`
- `approval.deny`
- `policy.check`
- `policy.explain`
- `policy.simulate`
- `artifact.getMetadata`
- `artifact.readChunk`
- `eval.start`
- `eval.get`

Every mutating request includes a client request ID. Before executing it, the daemon canonicalizes the validated request and inserts caller identity, method, request hash, processing state, and expiry. An exact duplicate returns the recorded result. Reuse of the same ID with a different caller, method, or request hash is a conflict. A duplicate still marked processing returns an explicit in-progress result and inspection handle; it does not start a second operation. Retention must cover the maximum client retry window and is versioned in protocol policy.

`artifact.readChunk` accepts artifact reference ID, byte offset, and requested length capped by the protocol maximum. It returns base64 bytes, actual offset, next offset, end flag, total length, and whole-object hash. The daemon authorizes the reference, verifies containment under the internal content-addressed root, uses no-follow reads, and never accepts a filesystem path from the client.

### 18.3 Subscription cursors

A subscription request supplies run ID and last observed global or stream position. The initial RPC response returns subscription ID and catch-up boundary. Subsequent committed events use a versioned `run.event` JSON-RPC server notification carrying subscription ID and cursor. The daemon:

1. Authorizes access to the run.
2. Reads persisted events after the cursor.
3. Sends them in order.
4. Registers for committed-event notifications without holding the client write lock.
5. Rechecks the database after registration to close the race between initial read and subscription.
6. Continues with bounded buffering.

If a client falls behind the buffer limit, send a best-effort `run.subscriptionClosed` notification containing the last fully queued durable cursor and close the subscription. The client reconnects from its last processed cursor, not the last received partial frame. Do not let a slow editor consume unbounded daemon memory.

### 18.4 Process ownership

Open the owner-only daemon directory and acquire an OS advisory lock that remains held for the process lifetime. Write PID, process start identity, socket path, and protocol version as diagnostic metadata only; the advisory lock is authoritative. Bind the socket through a temporary owner-only path and atomically publish it where the platform permits. Validate directory and socket ownership and mode before accepting clients.

For every connection, obtain operating-system peer credentials where supported and require the expected local user. Platforms that cannot provide the configured peer-identity guarantee fail startup unless an explicitly designed alternative transport is enabled. A stale socket is removed only while holding the advisory lock and after a connection probe proves no live daemon owns it. Socket-path length is checked before bind, and the configured data path may use a short owner-only indirection directory when necessary.

## 19. VS Code Extension

### 19.1 Extension boundaries

Organize extension code into:

- Daemon client
- Command registrations
- Run tree provider
- Approval webview controller
- Context/audit tree provider
- Diff document content provider
- Status-bar state
- Secure configuration adapter

Only the daemon client knows JSON-RPC. Views receive typed client-domain models.

### 19.2 Run creation

1. Confirm VS Code workspace trust.
2. Resolve the active repository URI.
3. Ask the daemon to run `doctor` for that repository.
4. Collect objective and selected policy profile.
5. Call `run.create` with a client request ID.
6. Subscribe from cursor zero.
7. Store only run ID and last cursor in workspace state.

### 19.3 Diff display

Expose daemon artifacts through read-only virtual-document URIs. Open VS Code's native diff editor between the pinned base file and final worktree file. The webview must not receive raw file content merely to render a diff.

### 19.4 Approval webview

Use a nonce-based content security policy, local bundled assets, no remote scripts, and schema validation on every `postMessage`. The controller obtains approval details from the daemon, renders normalized effects, and sends only approval ID plus user decision back. The daemon revalidates all state.

### 19.5 Extension tests

- Unit tests for view-model mapping
- Fake-daemon protocol tests
- VS Code integration test for run creation
- Webview CSP and message-schema tests
- Reconnect from saved cursor
- Workspace-trust denial
- Confirmation that no provider or external-agent credential enters extension storage

## 20. Configuration and Secrets

### 20.1 Precedence

Use this precedence from lowest to highest:

1. Built-in safe defaults
2. User configuration in the guarded-agent data directory
3. Repository configuration committed with the project
4. Explicit CLI flags

Environment variables may provide secrets and CI overrides, but ordinary environment values should not silently override repository policy.

### 20.2 Task and source configuration

Task-profile and source-local configuration declares identifiers and bounded values, not executable code:

- Policy file paths
- Allowed sandbox profiles
- Recognized test recipes
- Context include/exclude patterns
- Budget defaults
- Artifact retention
- Installed task profile, context-source bindings, and capability-pack options allowed by that profile

Reject unknown fields. Resolve referenced paths relative to the config file and apply the same containment rules as context reads. A coding repository or research corpus cannot supply an executable agent, provider, source, capability, MCP server, credential strategy, or adapter implementation.

### 20.3 Diagnostic export

A diagnostic bundle includes profile/adapter/protocol versions, compatibility tier, safe configuration, event metadata, policy hashes, sandbox status, and redacted errors. It excludes environment variables, credential bytes, raw denied content, provider request bodies, protocol frames containing released content, and artifacts unless the user selects specific artifacts.

## 21. Observability

### 21.1 Structured logs

Every log entry contains:

- Timestamp
- Severity
- Component
- Run ID when applicable
- Command/action/driver/provider attempt ID
- Event ID or cursor
- Stable message code
- Safe structured fields

Run log fields through a central redactor before serialization. Avoid free-form logging of boundary objects.

### 21.2 Metrics

Track:

- Runs by terminal status
- Turn, action-proposal, and executed-action counts
- Policy effects and rule IDs
- Approval request/approve/deny/expire counts
- Capability-operation duration and failure category
- Queue wait and lease-recovery count
- Context requested, released, denied, and redacted bytes
- Driver/provider usage, tokens where applicable, latency, unknown-cost attempts, and estimated cost
- Sandbox starts, failures, and forced kills
- Eval and adapter-conformance pass rate by tag/profile/tier

Use local report generation first. Exporting OpenTelemetry can be an adapter after the metrics names stabilize.

### 21.3 Audit timeline

Build the human audit view from events and projections. Each consequential action should answer:

- Who or what requested it?
- What normalized action was evaluated?
- Which policy version and rule decided it?
- Was human approval required and consumed?
- Which preconditions were checked?
- What executed in which sandbox?
- What result and artifacts were produced?
- Was recovery involved?

## 22. Security and Supply Chain

### 22.1 Dependency policy

- Commit lockfiles.
- Prefer dependencies with narrow purpose and active maintenance.
- Review install scripts before adding packages.
- Run dependency audit in CI, but triage advisories by reachability and impact.
- Pin GitHub Actions by full commit SHA.
- Generate an SBOM for releases.
- Sign release tags and packages when publishing begins.

### 22.2 Repository security

- Protect the default branch after the remote exists.
- Require CI checks before merge.
- Enable secret scanning and dependency alerts on the hosting service.
- Add `SECURITY.md` before public release.
- Keep real provider evals out of untrusted pull-request workflows.

### 22.3 Threat-model maintenance

Each new tool adds:

- Assets it can read or mutate
- New normalization rules
- Policy attributes
- Approval display requirements
- Sandbox requirements
- Reconciliation behavior
- Adversarial cases

A tool is incomplete until all seven are documented and tested.

## 23. Continuous Integration

### 23.1 Pull-request jobs

Run independent jobs for:

1. Formatting and forbidden-import checks
2. Type checking
3. Unit tests
4. Policy parser golden and generative tests
5. Deterministic scripted-driver and synthetic-provider evals
6. PostgreSQL integration tests
7. Docker sandbox tests on Linux
8. Migration up/down and replay tests
9. Secret-leak scan over produced test artifacts
10. Package and license audit

No pull-request job receives a real provider or external-agent credential.

### 23.2 Nightly jobs

- Repeated race and lease tests
- Real-model eval suite with a hard spend cap
- Container escape-regression fixtures
- Projection rebuild from all historical fixtures
- Artifact garbage-collection dry run
- Cross-platform CLI tests on macOS and Linux

### 23.3 Release process

1. Require clean default branch and passing CI.
2. Build packages from the lockfile.
3. Run deterministic eval suite against release artifacts.
4. Generate checksums, SBOM, and changelog.
5. Sign tag and artifacts.
6. Publish CLI package and VSIX only when their respective phases are complete.
7. Create a GitHub release containing guarantees, known limitations, migration notes, and eval summary.

## 24. Detailed Milestone Execution

Milestones map to the build plan's phased roadmap as follows; Phase 0 (specification and threat model) precedes Milestone A and is complete when these documents are accepted.

| Milestone | Build-plan phase |
|---|---|
| A — Deterministic runtime kernel | Phase 1 |
| B — Policy and context boundary | Phases 2–3 |
| C — Isolated real filesystem execution | Phase 4 |
| D — Direct-model driver, credentials, and first real provider | Phase 5 |
| E — PostgreSQL durability, minimal daemon, and approvals | Phase 6 |
| F — Evaluation, research profile, and release-quality CLI | Phases 7–8 |
| G — Broad provider and external-agent compatibility | Phase 9 |
| H — Multi-client daemon hardening and editor client | Phase 10 |

### Milestone A — Deterministic runtime kernel

Implementation order:

1. Create `contracts` with branded IDs, task profiles, objectives, resources, content blocks, actions, observations, outcomes, domain errors, event envelope, and canonical JSON.
2. Create an in-memory event store enforcing optimistic concurrency.
3. Define run intents, state, events, reducer, and illegal-transition tests.
4. Define agent-driver and model-provider ports, a scripted driver, and a synthetic provider.
5. Define context-source and capability-pack ports plus an in-memory generic source and operation.
6. Implement a synthetic non-coding profile; then implement coding list, read, and patch-proposal operations against virtual fixtures without changing kernel packages.
7. Implement a synchronous command dispatcher using durable command types in memory.
8. Add `guard run` that streams event-derived views.
9. Add a golden run history fixture and replay it in tests.

Deliverable: one provider-free generic task and one scripted coding task complete through the same reducer, proving that Git and model-provider concepts are outside the kernel.

### Milestone B — Policy and context boundary

Implementation order:

1. Write grammar and policy examples.
2. Implement lexer, parser, diagnostics, formatter, and round-trip tests.
3. Implement attribute catalog, type checker, evaluator, and trace.
4. Pin policy snapshots to runs.
5. Implement generic resource canonicalization plus the coding repository-path implementation.
6. Add context budgets, media/binary checks, secret classifiers, and manifests.
7. Route every source read and agent-safe capability output through the broker.
8. Integrate policy evaluation into the capability gateway.
9. Implement policy check, test, explain, and simulate CLI commands.
10. Add hostile fixtures for paths, secrets, and injection text.

Deliverable: deterministic evidence that forbidden content never enters scripted-driver/synthetic-provider input and denied actions never reach handlers, for both generic and coding fixtures.

### Milestone C — Isolated real filesystem execution

Implementation order:

1. Add real Git repository adapter and clean-state checks.
2. Add run-directory ownership and disposable worktrees.
3. Implement patch parsing, validation, artifact binding, and `git apply` verification.
4. Implement process recipes and shell-free spawning.
5. Add Docker capability detection and pinned sandbox profiles.
6. Execute tests and builds inside the container.
7. Add cancellation, timeout, output bounding, and orphan cleanup.
8. Verify original checkout remains byte-for-byte unchanged in failure tests.

Deliverable: a local scripted-driver coding run that edits only a disposable worktree and returns a tested patch artifact.

### Milestone D — Direct-model driver, credentials, and first real provider

Implementation order:

1. Implement the direct-model driver and provider-neutral semantic request/content contracts.
2. Implement OS credential-store ports, origin-bound unsigned-request transport, `add|list|inspect|validate|rotate|remove` CLI commands, hidden-input and `add --from-env` import, and leak-canary tests.
3. Implement the local no-credential provider adapter and endpoint profile through the generic provider port.
4. Add the official SDK and first hosted-provider adapter package.
5. Map capability operations to strict client function definitions.
6. Implement local conversation reconstruction.
7. Normalize streaming content, complete calls, usage, terminal status, and opaque continuation items.
8. Set storage and parallel-call safety defaults.
9. Add provider budgets, capability negotiation, and failure classification.
10. Add synthetic HTTP/provider-contract tests without real credentials.
11. Run a small credentialed smoke suite outside pull-request CI.

Deliverable: the same curated task succeeds with synthetic, local no-key, and real hosted providers while producing equivalent generic policy and action audit semantics; no credential canary crosses a forbidden boundary.

### Milestone E — PostgreSQL durability, minimal daemon, and approvals

Implementation order:

1. Add migration runner and core schema.
2. Implement transactional optimistic append.
3. Implement projections and offline rebuild.
4. Insert commands transactionally from committed events.
5. Implement worker claim, heartbeat, completion, and reaper.
6. Extract a minimal foreground `guardd` that owns PostgreSQL connections and workers.
7. Add encrypted transcript storage, key handling, and metadata-only non-resumable behavior.
8. Add approval storage, expiry, preconditions, and consumption.
9. Add capability reconciliation for patches and contained processes.
10. Inject crashes at every side-effect boundary.
11. Add daemon restart recovery tests.

Deliverable: a killed worker resumes without duplicate patch application, and changed preconditions invalidate approval.

### Milestone F — Evaluation, research profile, and release-quality CLI

Implementation order:

1. Version eval schemas plus scripted-driver and synthetic-provider scripts.
2. Implement deterministic graders and fault scheduling.
3. Add security, durability, quality, cost, and latency reports.
4. Add baseline comparison and CI exit behavior.
5. Implement a local-corpus research source, search/read operations, citation validator, source-manifest outcome, and hostile research fixtures.
6. Complete CLI commands, JSONL, diagnostics, cleanup, and documentation.
7. Build the hostile flagship repository and record the demo.
8. Run installation from a clean machine or disposable VM.

Deliverable: publishable CLI v1 with reproducible coding and research demos, at least 40 adversarial cases, and measured claims. Kernel-only tests run without importing coding or research packages.

### Milestone G — Broad provider and external-agent compatibility

Implementation order:

1. Freeze provider and driver capability manifests, compatibility tiers, and conformance-case schemas.
2. Add Anthropic and Gemini adapters with golden request/stream/continuation/error fixtures.
3. Add a versioned OpenAI-compatible conformance dialect and harden the Phase 5 local no-credential endpoint profile through the shared conformance corpus.
4. Add schema-output and text-only planning modes; add bounded modality transforms only where supported by fixtures.
5. Implement ACP virtual workspace/terminal mappings and adversarial protocol tests.
6. Implement a run-scoped stdio MCP bridge and prove annotations cannot authorize.
7. Implement contained-CLI Tier C snapshots, output import, and guarantee labeling.
8. Complete provider/agent/profile CLI commands, adapter SDK docs, cross-adapter credential rotation/removal tests, and compatibility audit export.

Deliverable: multiple provider families, one local model path, and three external-agent integration styles pass their claimed conformance tier without a kernel change or credential leak.

### Milestone H — Multi-client daemon hardening and editor client

Implementation order:

1. Implement peer-authenticated framed JSON-RPC and durable request idempotency.
2. Implement bounded server notifications and subscriptions with replayable cursors.
3. Implement authorized chunked artifact reads.
4. Convert CLI into a daemon client while retaining non-daemon test adapters.
5. Build VS Code run tree, timeline, approvals, context manifest, and diff integration.
6. Add workspace-trust, CSP, reconnect, slow-client, and extension packaging tests.

Deliverable: CLI and editor observe and control one durable run without duplicating enforcement logic.

## 25. Requirements-to-Evidence Matrix

| Claim | Enforcement location | Required evidence |
|---|---|---|
| Kernel is not coding- or provider-specific | Package graph, reducer, profile registry | Generic and research profiles pass without coding imports; adapter swap produces no kernel diff |
| Secret resources do not enter agent/model context | Context broker | Raw, encoded, split, identifier, filename, multimodal-transform, and protocol canaries absent from exact serialized requests and artifacts |
| Denied actions cannot execute | Capability gateway | Handler spy remains uncalled after recorded denial across direct-model, ACP, MCP, and client paths |
| Approvals authorize exact actions | Approval service and precondition checker | Mutated argv, file, image, or policy invalidates approval |
| Original checkout is preserved | Worktree manager | Before/after tree and status comparison across success, crash, cancellation; only expected Git worktree metadata changes occur |
| Untrusted processes cannot alter accepted source | Execution-snapshot manager | Container mutates every writable path, snapshot is discarded, and authoritative checkpoint tree remains identical |
| Processes have no network by default | Sandbox adapter | Connection fixtures fail while ordinary tests run |
| Crashes do not duplicate patch effects | Command queue and patch reconciliation | Fault after side effect, restart, one resulting patch |
| Replay performs no side effects | Reducer/replay path | Adapter spies remain unused during full history replay |
| Capability output is bounded | Capability gateway and artifact store | Excess output becomes bounded preview plus artifact metadata |
| Policy explanations are deterministic | Policy evaluator | Golden trace equality for canonical action and snapshot |
| Real-model variance cannot hide safety regressions | Deterministic eval suite | Safety gates use scripted driver/synthetic provider and exact assertions |
| Editor cannot bypass enforcement | Daemon boundary | Extension tests call RPC only; daemon rejects unauthorized mutation |
| Durable resume uses exact prior model-visible state | Transcript store and provider adapter | Restarted multi-turn contract test reproduces ordered semantic and opaque protocol items byte-for-byte |
| Metadata-only retention does not overclaim recovery | Runtime | Process loss terminates as non-resumable without a replacement model call |
| BYOK secrets remain confined | Credential broker and trusted transport | Canary absent from all serialized/client/child surfaces; origin/redirect tests fail closed; rotation/removal work |
| Compatibility claims match actual control | Adapter registry and audit exporter | Tier A/B/C/D conformance cases and residual limitations are pinned and exported |
| Text-only output cannot become an effect | Direct-model driver | Adversarial prose/code-fence command fixtures remain content and no action event or handler call occurs |
| Multimodal transforms preserve policy lineage | Context broker and provider adapter | Source/released/transformed/provider-visible hashes and bounds reconcile for every supported block |

## 26. Definition of Implementation Completeness

A feature is complete only when it has:

1. Domain types and invariants
2. Boundary schema
3. Normalization rules
4. Policy attributes and default effect
5. Event representation
6. Persistence and replay behavior
7. Failure and cancellation behavior
8. Audit and human display
9. Unit tests
10. Integration tests where an adapter exists
11. At least one adversarial case
12. Documentation of residual risk

This checklist prevents the project from claiming a capability because one happy-path function exists. It also makes future tools and providers follow the same security and durability standard as the initial implementation.
