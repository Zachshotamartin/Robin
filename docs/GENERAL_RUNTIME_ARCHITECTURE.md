# Robin: Internal Runtime Substrate Architecture

Document status: retained internal architecture. It is not the Robin product
definition or build-order authority. See [ADR-0007](decisions/ADR-0007-robin-coding-agent-product-pivot.md),
[Product Requirements](PRODUCT_REQUIREMENTS.md), and
[Robin CLI Architecture](ROBIN_CLI_ARCHITECTURE.md).

Robin is a coding-agent CLI. This document describes the general policy,
context, event, and adapter substrate that can be reused inside the coding
agent without making a general control plane the user-facing product. Coding
sessions, repository tools, Git, terminal interaction, and provider-driven tool
loops are assembled in the Robin application layer above this kernel.

The reusable internal harness contains:

- Agent drivers decide what to propose next.
- Model adapters translate different model APIs and modalities.
- Context-source adapters expose typed resources through policy.
- Capability packs define guarded actions and their execution contracts.
- Task profiles compose drivers, models, context, capabilities, budgets, outcomes, and evals.
- The same event, policy, approval, artifact, credential, recovery, and client infrastructure applies to every profile.

## 1. Internal Substrate Boundary

The substrate can support:

- Direct hosted or local generative models.
- External agent processes and hosted agent APIs.
- Scripted deterministic agents used for tests and workflows.
- Tool-calling, structured-output, and planning-only models.
- Text, image, audio, document, and structured-data content blocks when a profile and adapter support them.
- Single-agent v1 execution and later explicitly modeled multi-agent coordination.
- Coding, research, data, browser, operations, support, and domain-specific capability packs.

The core does not promise that every arbitrary model or agent can execute every capability safely. An adapter must translate the protocol, a profile must define the intended semantics, and the runtime must have an enforcement point for every effect.

## 2. Layered Architecture

```text
Client
  CLI / VS Code / other local client
                 |
                 v
Run and Task Profile
  objective schema
  agent driver
  model bindings by role
  context sources
  capability packs
  outcome schema
  budgets and evals
                 |
                 v
Generic Runtime Kernel
  reducer
  event ledger
  command planner
  approvals
  recovery
                 |
        +--------+--------+
        |                 |
        v                 v
Agent Driver        Policy Boundary
  direct model        context broker
  external ACP        action policy
  MCP bridge          output release
  scripted            approval binding
        |                 |
        +--------+--------+
                 |
                 v
Capability Gateway
  repository / process / HTTP / browser / SQL / domain API
                 |
                 v
Effect Adapters and Sandboxes
```

The kernel knows runs, intents, actions, observations, artifacts, budgets, and outcomes. It does not know that one action is a Git patch or another is a database query. Those semantics belong to versioned capability packs.

## 3. Core Generic Primitives

### 3.1 Task profile

```ts
export interface TaskProfile {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly objectiveSchema: JsonSchema;
  readonly driverProfile: AgentDriverProfile;
  readonly modelBindings: readonly ModelProfileBinding[];
  readonly contextSources: readonly ContextSourceBinding[];
  readonly capabilityPacks: readonly CapabilityPackBinding[];
  readonly policyProfileId: string;
  readonly outcomeSchema: JsonSchema;
  readonly budgetPolicy: BudgetPolicy;
  readonly evidenceMode: EvidenceMode;
  readonly evaluationProfileId: string;
}

export interface ModelProfileBinding {
  readonly bindingId: string;
  readonly roleId: string;
  readonly authority: "planner" | "auxiliary";
  readonly modelProfileId: string;
  readonly mayProposeActions: boolean;
}
```

The profile is immutable for a run. A change produces a new profile version. A direct-model driver has exactly one `planner` binding. A profile may additionally bind auxiliary `embedding`, `reranker`, `classifier`, `grader`, or domain-defined non-authorizing model roles. Scripted or external-agent profiles may have none. V1 does not switch a planner binding inside a run; an explicit fork pins a new profile and discloses continuity loss. Repository/source configuration may select an installed profile and supply bounded values, but it cannot load executable adapter code.

### 3.2 Objective

An objective is versioned structured data, not necessarily a chat string:

```ts
export interface ObjectiveEnvelope {
  readonly schemaVersion: number;
  readonly profileId: string;
  readonly objectiveType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly submittedBy: ActorIdentity;
  readonly submittedAt: string;
}
```

Examples:

- Coding: repository, requested change, acceptance tests.
- Research: question, allowed corpus, citation requirements.
- Data analysis: dataset references, analysis question, output format.
- Browser workflow: target application, permitted operations, completion condition.
- Operations: service target, requested diagnosis, maximum effect class.

The original objective remains immutable. Follow-up intent is a separate event with its own schema and actor.

### 3.3 Resource reference

```ts
export interface ResourceRef {
  readonly scheme: string;
  readonly sourceId: string;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly mediaType: string | null;
  readonly classification: string;
}
```

Scheme examples include `repo`, `artifact`, `document`, `http`, `browser`, `database`, and `domain`. The locator is validated by the owning context-source adapter. The agent/model never invents a host path, database connection string, or credential-bearing URL that bypasses that adapter.

### 3.4 Action

```ts
export interface NormalizedAction {
  readonly actionId: ActionId;
  readonly capabilityPackId: string;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly subject: SubjectAttributes;
  readonly resource: ResourceAttributes;
  readonly environment: EnvironmentAttributes;
  readonly request: RequestAttributes;
  readonly normalizedInput: Readonly<Record<string, unknown>>;
  readonly sideEffectClass: "none" | "local_reversible" | "local_irreversible" | "external";
  readonly preconditions: readonly Precondition[];
}
```

Policy evaluates this generic representation. The operation handler receives the same immutable normalized input. Each capability pack supplies its own structural schema, semantic normalizer, precondition builder, human display, executor, reconciler, output classifier, and tests.

### 3.5 Observation

An effect result becomes four related views:

- Raw adapter result, retained only inside the trusted boundary.
- Audit view with hashes, IDs, timings, classifications, and bounded safe facts.
- Human view suitable for the selected client.
- Agent view released through context and output policy.

No agent driver receives a raw capability result merely because it initiated the action.

### 3.6 Outcome

Profiles define a typed terminal outcome:

- Coding profile: patch, checkpoint, test report, changed-path manifest.
- Research profile: answer, citations, source manifest, uncertainty report.
- Data profile: analysis report, query manifest, derived dataset artifacts.
- Browser profile: completion receipt, state evidence, screenshots with redaction.
- Operations profile: diagnosis or approved change receipt.

The runtime validates the outcome schema before `RunCompleted`.

Outcome validation is a pipeline, not a JSON-schema-only check:

1. Validate the complete envelope and reject unknown fields.
2. Resolve every artifact/resource/citation reference against objects released or produced in this run.
3. Run the profile's pure semantic validator and completeness rules.
4. Re-evaluate outcome-release policy for sensitive content and external identifiers.
5. Verify claimed action/test/source evidence against canonical events and artifact hashes.
6. Append `OutcomeValidated` containing safe evidence references, then and only then append `RunCompleted`.

An invalid outcome becomes a bounded observation when recovery is safe and budget remains; otherwise the run fails with the candidate retained as an untrusted artifact.

### 3.7 Content blocks

```ts
export interface ContentBlockBase {
  readonly blockId: string;
  readonly modality: "text" | "json" | "image" | "audio" | "document" | "embedding";
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly classification: string;
  readonly provenance: ContentProvenance;
  readonly retentionClass: string;
  readonly transformation: TransformationRecord | null;
}

export type ContentBlock =
  | TextContentBlock
  | JsonContentBlock
  | ImageContentBlock
  | AudioContentBlock
  | DocumentContentBlock
  | EmbeddingReferenceBlock;
```

Large or binary bytes remain in the artifact store; the envelope carries an authorized artifact reference and bounded preview/metadata. JSON blocks hold schema ID/version. Text blocks declare encoding and normalization. Image/audio/document blocks declare dimensions, duration/page count when available, safe-decoder identity, and derived-byte hash. Embedding blocks reference vectors inside a dedicated store and never serialize high-dimensional arrays into ordinary model context, events, or logs.

## 4. Agent Driver Abstraction

An agent driver is the planning source. It may call a model, host an external agent protocol, or be deterministic.

```ts
export interface AgentDriver {
  readonly descriptor: AgentDriverDescriptor;
  initialize(context: DriverInitialization): Promise<DriverState>;
  next(
    state: DriverState,
    turn: DriverTurnInput,
    signal: AbortSignal
  ): AsyncIterable<DriverEvent>;
  resume(
    state: DriverState,
    transcript: readonly DriverTranscriptItem[]
  ): Promise<DriverState>;
  cancel(state: DriverState): Promise<CancellationEvidence>;
}
```

The pinned descriptor includes:

```ts
export interface AgentDriverCapabilities {
  readonly driverKind: "scripted" | "direct_model" | "protocol" | "hosted" | "contained_cli" | "coordinator";
  readonly contextDelivery: "mediated_items" | "filtered_snapshot" | "remote_package" | "opaque";
  readonly actionDelivery: "structured" | "protocol_mapped" | "candidate_outcome" | "none";
  readonly transcriptVisibility: "exact" | "protocol_only" | "opaque";
  readonly credentialOwnership: "guard_transport" | "agent_process" | "none";
  readonly resume: "lossless" | "best_effort" | "unsupported";
  readonly cancellation: "confirmed" | "best_effort" | "unsupported";
  readonly canSpawnUndeclaredAgents: false;
}
```

The adapter reports primitive capabilities, but the profile validator computes the achieved A/B/C/D tier from those capabilities, installed OS/sandbox enforcement, conformance evidence, and enabled operations. An adapter cannot self-assert a stronger tier. `canSpawnUndeclaredAgents` must remain false in v1; an observed recursive agent launch or undeclared remote-agent request fails policy or downgrades the mode before work starts.

Normalized driver events:

- `AgentTextDelta`
- `AgentContentCompleted`
- `AgentActionProposed`
- `AgentOutcomeProposed`
- `AgentUsageReported`
- `AgentPaused`
- `AgentCompleted`
- `AgentFailed`

The direct-model driver converts provider events into this vocabulary. ACP, MCP-mediated, hosted-agent, scripted, and future multi-agent coordinators implement the same port.

## 5. Model Type Abstraction

### 5.1 Model capability manifest

```ts
export interface ModelCapabilities {
  readonly inputModalities: readonly Modality[];
  readonly outputModalities: readonly Modality[];
  readonly structuredActions: "native_tools" | "schema_output" | "none";
  readonly streaming: boolean;
  readonly statelessContinuation: boolean;
  readonly opaqueContinuationItems: boolean;
  readonly maximumInputBytes: Readonly<Partial<Record<Modality, number>>>;
  readonly maximumOutputBytes: Readonly<Partial<Record<Modality, number>>>;
  readonly usageDimensions: readonly string[];
}
```

Modalities begin with `text`, `json`, `image`, `audio`, `document`, and `embedding`. Every content block has media type, byte length, content hash, classification, provenance, retention class, and model-safe transformation.

### 5.2 Tool-calling models

Native structured tool use is the preferred action path. Complete calls validate and enter the generic action gateway. Partial streamed arguments are inert.

### 5.3 Schema-output models

A model that supports reliable constrained JSON but not native tools may emit one versioned `AgentProposal` schema containing text, one action proposal, or one outcome proposal. The runtime validates the complete constrained output. Free-form prose is never parsed with regular expressions into a consequential action.

### 5.4 Text-only models

A text-only model without constrained structured output operates in planning or answer-only mode. It may produce human text and request additional predeclared context through a deterministic host workflow, but it cannot propose consequential actions. This is a capability limitation, not an adapter error.

### 5.5 Multimodal models

Image, audio, and document inputs cross modality-specific brokers:

- Decode limits and media validation occur before allocation.
- Metadata and embedded content receive classification.
- Active content, scripts, macros, and external references are rejected or rendered through a safe converter.
- Redaction produces a derived artifact with provenance to the source.
- The exact derived bytes sent to the provider follow evidence-mode retention.

Model-produced images, audio, files, or structured data become untrusted artifacts. They do not execute and do not enter another model's context until an output policy releases them.

### 5.6 Embedding, reranking, and classifier models

These are auxiliary model services rather than autonomous drivers. A context-source or grader adapter may call them through the same provider, credential, budget, retention, and event infrastructure. Their output cannot authorize an action; it can rank or classify candidates that deterministic policy still evaluates.

### 5.7 Local models

A local inference adapter uses `authStrategyId: none`, a pinned endpoint or executable hash, resource limits, and a capability conformance suite. Local does not automatically mean private: the audit records process mounts, network profile, model artifact hash, and whether prompts leave the host.

## 6. Context-Source Adapter

```ts
export interface ContextSourceAdapter {
  readonly sourceDescriptor: ContextSourceDescriptor;
  normalizeRequest(input: unknown): Result<NormalizedContextRequest, BoundaryError>;
  classifyMetadata(request: NormalizedContextRequest): Promise<ResourceMetadata>;
  readBounded(
    request: NormalizedContextRequest,
    budget: ContextBudget,
    signal: AbortSignal
  ): Promise<RawContextItem>;
  deriveAgentSafe(
    raw: RawContextItem,
    policy: ContextReleaseDecision
  ): Promise<AgentSafeContextItem>;
}
```

Initial sources:

- Coding reference: immutable Git objects and accepted run checkpoint.
- Local document reference: owner-selected corpus directory copied into an indexed content store.
- Artifact source: results from earlier guarded actions in the same run.
- HTTP and browser sources: deferred until network proxy and origin policy exist.
- Database source: deferred until query and row/column release policy exist.

Source adapters may not invoke capability handlers. Reads that cause external side effects must be modeled as actions.

## 7. Capability Pack Contract

```ts
export interface CapabilityPack {
  readonly packId: string;
  readonly packVersion: number;
  readonly operations: readonly OperationDefinition[];
  registerSchemas(registry: BoundarySchemaRegistry): void;
  createContext(): CapabilityPackContext;
}

export interface OperationDefinition {
  readonly operationId: string;
  readonly version: number;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly sideEffectClass: NormalizedAction["sideEffectClass"];
  normalize(input: unknown, context: NormalizationContext): Promise<NormalizedAction>;
  buildApproval(action: NormalizedAction): Promise<ApprovalPresentation>;
  execute(action: NormalizedAction, context: EffectContext): Promise<RawOperationResult>;
  reconcile(action: NormalizedAction, context: ReconciliationContext): Promise<ReconciliationResult>;
  release(result: RawOperationResult, decision: OutputDecision): Promise<ReleasedObservation>;
}
```

Capability packs are installed trusted code. Repository content can request an installed operation but cannot provide its executor. Every pack has an owner, version, dependency record, threat-model section, default policy, sandbox profile, crash matrix, and conformance tests.

## 8. Reference Capability Packs

### 8.1 Coding pack

Includes repository listing, bounded reads, search, patch proposal, trusted checkpoint application, disposable process recipes, test reports, and final diff export. This remains the flagship portfolio demonstration.

### 8.2 Local research pack

The second reference profile proves that the kernel is not coding-specific:

- User selects a synthetic or local document corpus.
- Context broker indexes safe metadata and reads bounded document-derived text.
- Agent searches, reads, and cites only released corpus items.
- Outcome is an answer, ordered citations, source manifest, and uncertainty statement.
- No repository, Git, patch, or process capability is loaded.
- Deterministic scripted driver and at least two direct model adapters run the same eval.

### 8.3 Data-analysis pack

Deferred pack with read-only dataset sources, declarative query operations, contained compute recipes, derived artifact outputs, and column-level release policy. Database credentials and arbitrary SQL require a separate threat model.

### 8.4 Browser pack

Deferred pack with origin-scoped navigation, safe page observations, form actions, download quarantine, screenshot redaction, and approval for consequential submission. General browser control is not part of coding v1.

### 8.5 Operations pack

Deferred high-risk pack. Read-only inspection ships before mutation. Deployment, cloud, ticketing, or messaging actions require external-effect reconciliation, stronger identity, and narrowly scoped credentials.

## 9. Generic Policy Attributes

The base catalog remains domain-independent:

```text
subject.kind
subject.driver_id
subject.compatibility_tier
action.pack
action.operation
action.side_effect
resource.scheme
resource.source_id
resource.classification
request.intent
request.estimated_cost
request.provenance
environment.profile_id
environment.sandboxed
environment.network_profile
environment.trust_level
```

Capability packs add namespaced attributes such as `repo.path`, `http.origin`, `database.table`, or `browser.form_action`. A policy snapshot declares required pack attribute-schema versions. Unknown pack attributes fail policy loading.

## 10. Generic Budgets

Base dimensions:

- Wall time.
- Turns.
- Agent-driver attempts.
- Input and output bytes per modality.
- Provider usage and monetary cost.
- Context-source reads.
- Action proposals.
- Consequential actions.
- Approval requests.
- Repeated denials.
- Artifact bytes.
- External requests.

Capability packs may add bounded dimensions. Budget counters come from durable facts, and unavailable usage remains unknown rather than zero.

## 11. Generic Run Configuration and CLI

The pre-pivot architecture requires internal profile-registry operations to
enumerate, inspect, and validate installed profiles. It does not define a
separate public profile-management binary or command contract. Robin exposes
only the coding-agent command surface specified by the product-first documents;
internal profile diagnostics are reached through that surface when implemented.

Coding run:

```text
robin \
  --profile coding-local \
  --objective-file examples/objectives/add-rate-limiting.json \
  --provider openai-coding
```

Research run:

```text
robin \
  --profile research-local-corpus \
  --objective-file examples/objectives/compare-runtime-designs.json \
  --provider claude-research
```

External agent:

```text
robin \
  --profile coding-external-agent \
  --objective-file examples/objectives/add-rate-limiting.json \
  --agent review-agent
```

The profile determines valid flags. A scripted driver accepts neither provider nor external-agent selection; a direct-model driver accepts one planner-provider selection plus only profile-declared auxiliary model bindings; an external-agent driver accepts one agent selection. A future coordinator profile may own multiple drivers only after the coordination contract is implemented.

## 12. Multi-Agent Position

The architecture is multi-agent-capable, but v1 executes one active agent driver per run. Multi-agent execution is not simulated by letting several agents write concurrently.

A future coordinator is itself an `AgentDriver`. It must define:

- Agent identities and roles.
- Which context each agent may receive.
- Delegation action schema.
- Shared and private transcript rules.
- Per-agent and aggregate budgets.
- Causal ordering and concurrency.
- Capability ownership and write serialization.
- Approval attribution.
- Agent failure, cancellation, and replacement.
- Outcome merge and conflict rules.
- Replay and eval semantics.

Until those rules exist, multiple agents run as separate Guarded runs and exchange only explicit exported artifacts through policy.

## 13. Generic Events

The base event vocabulary uses `Agent`, `Action`, `Observation`, and `Outcome` concepts. Provider-specific and capability-specific details stay in namespaced payloads.

Required generic facts:

- `RunCreated`
- `TaskProfilePinned`
- `RunStarted`
- `RunIntentAppended`
- `AgentDriverStarted`
- `AgentAttemptStarted`
- `AgentAttemptUncertain`
- `AgentAttemptFailed`
- `AgentContentCompleted`
- `AgentUsageRecorded`
- `ContextRequested`
- `ContextReleased`
- `ContextDenied`
- `ContextRedacted`
- `ActionProposed`
- `ActionNormalized`
- `PolicyEvaluated`
- `ActionDenied`
- `ApprovalRequested`
- `ApprovalGranted`
- `ApprovalDenied`
- `ApprovalExpired`
- `ApprovalInvalidated`
- `ApprovalConsumed`
- `ActionStarted`
- `ActionSucceeded`
- `ActionFailed`
- `ActionReconciled`
- `ObservationReleased`
- `RetryScheduled`
- `BudgetExceeded`
- `OutcomeProposed`
- `OutcomeValidated`
- `ArtifactReferenced`
- `CancellationRequested`
- `RecoveryStarted`
- `RecoveryCompleted`
- `RunPaused`
- `RunResumed`
- `RunCancelled`
- `RunFailed`
- `RunOrphaned`
- `RunCompleted`

The coding profile may emit additional checkpoint and patch facts. The direct-model driver may emit provider transmission and usage facts. Reducers ignore none of them; aggregate-specific reducers consume the generic subset and projections index namespaced details.

## 14. Package Boundaries

```text
packages/
  contracts/              generic IDs, schemas, content and action types
  runtime/                reducer, intents, commands and recovery
  policy-language/        generic base attributes and pack namespaces
  context-broker/         release pipeline and source registry
  capability-gateway/     pack registry, action normalization and dispatch
  agent-driver/           driver port and generic driver events
  model-provider/         model adapter port and content modalities
  credentials/            credential references and transport injection
  event-store/            persistence, commands and projections
  artifact-store/         typed content objects and references
  approvals/              generic action approval binding
  eval-engine/            profile-independent runner and assertions
  profile-registry/       installed immutable task profiles
  capability-repository/  coding reference pack
  capability-process/     contained process recipes
  capability-research/    local-corpus reference pack
  adapter-openai/
  adapter-anthropic/
  adapter-gemini/
  adapter-acp/
  bridge-mcp/
```

The runtime and policy packages cannot import a capability pack or provider adapter. Dependency-boundary tests enforce this.

## 15. Tests Proving Generality

- Run the same reducer suite with coding, research, and synthetic no-op profiles.
- Verify runtime packages contain no imports from repository, Git, process, HTTP, browser, SQL, ACP, MCP, or provider adapters.
- Load a profile with no model and a scripted driver.
- Load a text-only answer profile and prove action proposals are impossible.
- Load a multimodal fake model and enforce image/audio byte and artifact policies.
- Run coding profile without research pack installed and research profile without coding pack installed.
- Reject a profile referencing a missing pack, incompatible attribute schema, unsupported modality, or weaker guarantee tier.
- Run one normalized fake task across OpenAI, Anthropic, and Gemini transports.
- Run one coding task through direct-model and ACP drivers while retaining the correct distinct guarantee tier.
- Replay every profile without invoking driver, model, context, capability, credential, or sandbox adapters.

## 16. Historical Runtime-First Implementation Sequence

This sequence is preserved as design history. The active Robin sequence is in
[BUILD_PLAN.md](BUILD_PLAN.md); coding-session vertical slices now precede
further general-runtime expansion.

1. Rename coding-specific domain types in the kernel to generic run, driver, action, observation, and outcome types before implementation makes them expensive to change.
2. Define task-profile, driver, model-capability, content-block, context-source, capability-pack, and outcome schemas.
3. Keep the scripted fake driver and virtual coding pack as the first vertical slice.
4. Implement the coding reference pack behind generic ports.
5. Implement provider and credential abstraction.
6. Implement the local research profile without importing coding packages.
7. Add a cross-profile architecture test that rejects reverse dependencies.
8. Complete durable commands, approvals, transcripts, artifacts, and minimal daemon generically.
9. Add external provider and agent compatibility adapters.
10. Build the VS Code client as a coding-oriented client of the general daemon; do not place coding rules in the daemon protocol.

## 17. Definition of General-Runtime Success

The system is not considered flexible merely because interfaces have generic names. Generality is demonstrated when:

- Coding and local research profiles complete end to end through the same runtime binary.
- The research build excludes Git and patch capability packs.
- A new fake capability pack can be added without editing runtime, event store, policy evaluator, approval service, or daemon.
- A new model adapter can be added without editing capability packs.
- A scripted agent can run with no model or API key.
- A local model can run with no credential.
- Direct providers can use different credential strategies.
- External agents receive their accurately limited compatibility tier.
- Audits and evals remain comparable across profiles while retaining domain-specific evidence.

Coding remains the most sophisticated reference pack and the portfolio centerpiece. The product itself is the policy-enforced runtime that can host many agent and model types.
