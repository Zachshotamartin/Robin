# Guarded Agent: Provider, Credential, and External-Agent Compatibility Plan

This document defines how Guarded Agent can run with different model APIs, model capability types, bring-your-own credentials, MCP-capable clients, ACP agents, hosted agents, and sandboxed command-line agents without pretending that every integration has the same security properties. Coding is the first protocol-mapping profile, not a restriction on the driver interface.

## 1. Exact Compatibility Goal

The target is:

1. A user may select any implemented model-provider adapter and one of their own credential profiles per run.
2. A new direct model API can be added without changing the runtime, policy language, context broker, capability gateway, event reducer, approvals, sandbox, or eval format.
3. An external agent can participate through a reviewed protocol adapter when Guarded Agent can mediate every context source and capability required by the selected task profile.
4. An MCP-capable agent can call installed Guarded Agent operations through a run-scoped bridge.
5. A black-box CLI agent can run inside a filtered disposable snapshot and return an untrusted candidate profile outcome, such as a coding patch.

“Any provider” means any provider for which a compatible adapter and authentication strategy exist. “Any agent” means any agent that implements a supported protocol or can run inside the containment-only CLI adapter. It does not mean arbitrary software receives the full Guarded Agent guarantee automatically.

## 2. Compatibility and Guarantee Tiers

| Tier | Integration | Guarded Agent controls | Claims allowed |
|---|---|---|---|
| A | Direct model API adapter | Exact model input, operation schemas/execution, provider transcript, budgets, credential injection | Full context, policy, approval, sandbox, transcript, and replay claims after evidence passes |
| B | Protocol-controlled external agent | Mapped protocol capabilities or exclusive MCP operations, filtered sources, process sandbox, outcome gateway | Policy and isolation claims only for mediated operations; provider-request claims require adapter visibility |
| C | Sandboxed black-box CLI agent | Initial filtered snapshot, network profile, resource limits, candidate outcome import | Containment and final-outcome claims; no granular action-decision or exact provider-context claim |
| D | Observe-only host agent | Event import or final outcome inspection only | Audit assistance only; no prevention claim |

The CLI and UI display the tier before a run starts and include it in every exported audit. A configuration may not claim a stronger tier than its adapter capability evidence.

## 3. Core Architecture

```text
                          +--------------------------+
User and CLI ------------> Run configuration         |
                          | provider or agent profile |
                          +-------------+------------+
                                        |
                      +-----------------+-----------------+
                      |                                   |
              Direct model path                   External agent path
                      |                                   |
          ModelProviderAdapter              AgentProtocolAdapter
                      |                         ACP / MCP / CLI
          Provider request compiler                    |
                      |                          guarded capability map
          Credential-aware transport                   |
                      |                                   |
                      +---------------+-------------------+
                                      |
                       Existing runtime and event loop
                                      |
          context broker -> policy -> approval -> capability gateway
                                      |
                     checkpoint and sandbox managers
```

Direct-provider adapters translate protocol representations. They do not own authorization or execute tools. External-agent adapters translate protocol operations into the same guarded intents and never become an alternate execution path.

## 4. Direct Model Provider Port

The provider-neutral port expands to:

```ts
export interface ProviderDescriptor {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly protocolFamily: string;
  readonly authStrategyId: string;
  readonly allowedEndpointOrigins: readonly string[];
  readonly capabilities: ProviderCapabilities;
}

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly clientFunctionTools: boolean;
  readonly parallelToolCallsControllable: boolean;
  readonly providerStorageControllable: boolean;
  readonly exactUsageReporting: boolean;
  readonly requestIdentifiers: boolean;
  readonly statelessContinuation: boolean;
  readonly opaqueContinuationItems: boolean;
  readonly imageInput: boolean;
  readonly cancellation: "confirmed" | "best_effort" | "unsupported";
}

export interface ModelProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  validateProfile(profile: ProviderProfile): readonly ConfigurationDiagnostic[];
  estimateInput(request: SemanticModelRequest): TokenEstimate;
  compileRequest(request: SemanticModelRequest): UnsignedProviderRequest;
  normalizeStream(
    response: ProviderTransportResponse,
    signal: AbortSignal
  ): AsyncIterable<NormalizedProviderEvent>;
  reconstructInput(items: readonly PersistedTranscriptItem[]): ProviderInput;
  classifyFailure(error: unknown, transmission: TransmissionEvidence): ProviderFailure;
}
```

The adapter returns an unsigned request. The credential-aware transport validates the exact origin, disables redirects, injects authentication according to the reviewed strategy, sends the request, captures request identifiers and transmission evidence, and removes authentication before any diagnostic serialization.

An adapter never receives a general secret map. Domain code never receives raw credential bytes.

## 5. Provider Capability Negotiation

Every provider profile pins a capability manifest. Startup probes static adapter support and validates user assertions before a run is accepted.

Required checks:

- Can the API accept client-defined structured tools?
- Can parallel tool calls be disabled, or must batches fail closed locally?
- Can provider-side response storage be disabled?
- Which ordered items must be returned for stateless continuation?
- Are usage totals exact, delayed, or unavailable?
- Which request and response IDs are exposed?
- Can an in-flight request be cancelled and what does cancellation prove?
- Which roles, content blocks, schemas, and maximum sizes are accepted?
- Does the provider execute any enabled tool server-side outside Guarded Agent?

If client-side tool mediation is unavailable, the adapter cannot be Tier A for coding actions. Provider-executed shell, code, browser, computer, or file tools are disabled unless a separate provider-side threat model and policy mapping exists.

## 6. Initial Direct Provider Adapters

### 6.1 OpenAI Responses adapter

The first implementation uses the official SDK, client function tools, disabled provider storage where supported, serialized tool execution, lossless function call IDs and outputs, and opaque encrypted reasoning continuation where required. The current contract is described in the official [Responses create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

### 6.2 Anthropic Messages adapter

The adapter maps Guarded Agent tools to client-executed user-defined tools, normalizes `tool_use` blocks, and returns model-safe observations as `tool_result` blocks associated with the exact tool-use ID. Server-executed tools remain disabled for Tier A because Guarded Agent would not own their execution. Anthropic documents that client tools are executed by the application, while the model returns structured requests in its [tool-use contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works).

### 6.3 Gemini adapter

The adapter maps tools to Gemini function declarations, normalizes function-call parts, and returns function responses with preserved IDs and ordering required by the selected API generation. Gemini documents the application-owned execution loop in its [function-calling guide](https://ai.google.dev/gemini-api/docs/function-calling).

### 6.4 Generic OpenAI-compatible adapter

This adapter supports endpoints that pass a versioned conformance suite for the selected request and stream dialect. “OpenAI-compatible” is not accepted from a label alone. The endpoint must demonstrate:

- Tool schema acceptance and complete structured arguments.
- Stable call IDs and result association.
- Streaming frame termination.
- Error and usage normalization.
- Configured storage and parallel-call behavior.
- Maximum request and response limits.
- No silent server-side tool execution.

The credential is bound to an exact HTTPS origin. Redirects are rejected. Loopback HTTP is allowed only in an explicit development profile with a warning and no production claim.

### 6.5 Custom provider adapter

A later adapter SDK supplies schemas, a conformance harness, synthetic transport, and golden transcript fixtures. Third-party adapter code is trusted supply-chain code if loaded in-process. The safer extension mode runs an adapter compiler out of process without credentials: it produces a bounded unsigned request for an allowlisted origin, while the Guarded transport injects the secret and performs network I/O.

No custom adapter is enabled merely by placing executable code in an analyzed repository.

## 7. Bring-Your-Own Credential System

### 7.1 Credential records

Credential metadata and secret bytes are separate:

```text
Credential metadata in Guarded database:
  credential_ref
  display_name
  provider_adapter_id
  auth_strategy_id
  allowed_endpoint_origins
  created_at
  last_validated_at
  rotation_due_at
  status

Secret value in OS credential store:
  service = guarded-agent
  account = credential_ref
  value = provider key or token
```

Repository configuration stores only `credential_ref`. The key never appears in a repository file, command-line argument, event, JSONL output, sandbox, editor state, diagnostic bundle, or provider transcript.

### 7.2 Supported authentication strategies

The first credential broker supports reviewed fixed strategies:

- Bearer token in the Authorization header.
- Provider-defined API key header such as Anthropic or Gemini requires.
- Short-lived OAuth access token supplied by a future credential-store refresh adapter.
- Cloud identity adapter deferred until its signing and refresh behavior has contract tests.

User configuration cannot select an arbitrary header name, query parameter, or template containing the secret. Query-string secrets are rejected in v1. Each credential is origin-bound and adapter-bound so a profile cannot reuse it against another host without an explicit rebind confirmation.

### 7.3 Credential CLI

Planned commands:

```text
guard credentials add openai-personal --adapter openai-responses
guard credentials add claude-personal --adapter anthropic-messages
guard credentials add gemini-personal --adapter gemini
guard credentials list
guard credentials inspect claude-personal
guard credentials validate claude-personal
guard credentials rotate claude-personal
guard credentials remove claude-personal
```

`credentials add` prompts through a hidden terminal input and writes directly to the OS credential store. It refuses a noninteractive terminal unless `--from-stdin` is explicitly selected. The secret is never accepted as a positional argument or flag. `--from-env <VARIABLE_NAME>` may perform a one-time import for any reviewed adapter, but it records only the environment variable name, clears application references after storage, and never prints the value.

`credentials validate` always checks metadata, key presence, origin binding, and format locally. A network authentication probe requires confirmation, states whether it may incur cost, sends no repository content, and records only safe status and provider request ID.

Removal first lists every provider profile and nonterminal run that references the credential. Active-use removal is refused. Rotation writes the new key, validates it, atomically switches the credential-store version, and retains the previous version only for a bounded rollback window if the OS store supports versioning.

### 7.4 Provider profiles

A provider profile contains no secret:

```json
{
  "schemaVersion": 1,
  "profileId": "claude-sonnet-personal",
  "adapterId": "anthropic-messages",
  "credentialRef": "claude-personal",
  "endpointOrigin": "https://api.anthropic.com",
  "model": "configured-and-contract-tested-model-id",
  "capabilityManifestHash": "sha256:validated-manifest",
  "supportedEvidenceModes": ["durable_encrypted", "ephemeral_metadata"],
  "providerStorage": "disabled",
  "requestLimits": { "maximumOutputTokens": 8192 },
  "pricingMetadataId": "reviewed-pricing-snapshot"
}
```

The model ID is configuration rather than a permanent example because model availability changes. `guard providers doctor claude-sonnet-personal` resolves the current profile and reports capability mismatches without displaying the key. Task profile and administrative policy own run turns, actions, spend, and evidence-mode selection; the resolved run uses the strictest compatible limits across those layers and rejects an evidence mode the adapter cannot resume safely.

## 8. Running Direct Providers

The user flow is:

```text
guard credentials add openai-personal --adapter openai-responses
guard providers add openai-coding --adapter openai-responses --credential openai-personal
guard providers doctor openai-coding
guard run --profile coding-local --provider openai-coding \
  --objective-file examples/objectives/add-rate-limiting.json
```

Equivalent profiles can select `anthropic-messages`, `gemini`, or a conformant `openai-compatible` adapter. The run pins adapter version, model ID, endpoint origin, credential reference version, capability manifest, evidence mode, tool schemas, and all request-affecting settings.

Changing providers mid-run is denied in v1 because transcript semantics, opaque continuation items, token accounting, and tool representations differ. A later explicit fork creates a new run with a summarized or fully re-released context package and records the loss of exact continuation.

## 9. External Agent Adapters

### 9.1 ACP client adapter

Guarded Agent acts as the ACP client and launches a version-pinned agent over stdio. ACP provides initialization, sessions, prompt turns, cancellation, file operations, terminal operations, permission requests, and streamed updates. The current protocol overview is maintained by the [Agent Client Protocol project](https://agentclientprotocol.com/get-started/introduction).

Security mapping:

- ACP absolute file paths are mapped from the advertised synthetic workspace root to Guarded canonical repository-relative paths.
- `fs/read_text_file` becomes a context-broker request.
- `fs/write_text_file` becomes a candidate patch derived from the bound preimage and requested full content; it never writes directly.
- `terminal/create` becomes a normalized process recipe in a disposable execution snapshot.
- Terminal output becomes bounded artifacts and model-safe observations.
- `session/request_permission` is treated as display intent only. Guarded policy and approval run for every consequential method even when the agent never asks ACP permission.
- `session/cancel` maps to durable cancellation and full contained process termination.
- ACP updates are untrusted display data and cannot mark a Guarded command successful.

For Tier B, launch the ACP agent without a host repository mount. It receives content only through ACP client methods and receives no daemon socket. If the agent requires direct filesystem access, it drops to the sandboxed CLI tier.

### 9.2 MCP tool bridge

Guarded Agent can expose a run-scoped MCP server over stdio. MCP `tools/list` returns deterministic schemas translated from installed Guarded operations. MCP `tools/call` validates, normalizes, authorizes, approves, executes, and records through the capability gateway. The bridge is spawned by Guarded Agent with an in-memory run capability and does not expose the daemon socket or provider credentials.

The MCP specification describes tool annotations as untrusted hints. Guarded Agent ignores MCP read-only, destructive, idempotent, and open-world hints for authorization and uses its own versioned operation definitions. See the official [MCP tools specification](https://modelcontextprotocol.io/specification/draft/server/tools).

An external MCP agent receives only a guarded-tool claim, not an exact-provider-input claim. Guarded Agent can prove what its bridge returned, but not what other context or tools the external agent sent to its model. Tier B requires the Guarded MCP bridge to be the agent's exclusive repository and process capability and requires the agent process to be sandboxed away from the repository.

### 9.3 Sandboxed CLI adapter

For an agent without ACP or a usable client-tool protocol:

1. Broker creates a policy-filtered disposable snapshot from the accepted checkpoint.
2. Sandbox launches the exact executable and version with a minimal environment.
3. Network is disabled or restricted to an explicitly reviewed profile.
4. The agent may mutate only its disposable snapshot.
5. Guarded Agent captures bounded output and exit status.
6. The resulting diff is treated as an untrusted candidate patch.
7. Patch parsing, policy, approval, application, checkpoint, and tests occur through normal Guarded boundaries.
8. Snapshot is discarded.

This mode cannot provide per-internal-tool policy decisions, exact provider transcript replay, or proof that the agent did not read an allowed snapshot file. Its UI and audit must say `sandboxed_black_box`, not `policy_controlled_agent`.

### 9.4 Hosted agent API adapter

A hosted agent can qualify for Tier B only if its API exposes enough structure to:

- Send a policy-selected context package rather than uploading the repository.
- Disable or replace its native filesystem, shell, network, and deployment tools.
- Return structured proposed operations with stable IDs.
- Accept tool results from Guarded Agent.
- Expose cancellation, terminal status, usage, and session continuation.

If the service requires a repository upload or executes its own unmediated tools, it is not compatible with the full harness. It may be evaluated in a separate remote-agent mode whose data-transfer and side-effect claims are explicitly weaker.

## 10. External Agent Registration and Run Flow

Planned commands:

```text
guard agents register review-agent \
  --adapter acp-stdio \
  --executable /opt/review-agent/bin/review-agent

guard agents doctor review-agent

guard run \
  --profile coding-external-agent \
  --objective-file examples/objectives/add-rate-limiting.json \
  --agent review-agent
```

Registration resolves the executable without shell lookup ambiguity, records its hash, version output, adapter version, requested capabilities, environment allowlist, network profile, and credential reference if the agent owns its model connection. A changed executable invalidates the registration until reviewed.

An agent profile declares one credential mode:

- `none`: scripted/local agent needs no secret.
- `guard_transport`: Guarded owns the model API call; the external driver receives no secret.
- `agent_broker_channel`: the registered agent supports a reviewed inherited file descriptor or one-shot local broker protocol and receives only the selected credential.
- `agent_environment`: compatibility fallback that places only the selected credential into that agent's constructed sandbox environment; never the daemon's ambient environment.

An agent-owned credential is delivered only to the exact registered executable/hash, adapter, sandbox, and allowed network origin. It is never passed in argv or a repository file. The agent and its children can read a credential intentionally delivered to it, so the run audit states this explicitly and Tier A credential-confinement claims do not apply. Prefer `guard_transport`; use `agent_broker_channel` next; allow `agent_environment` only after a profile-specific threat review and canary tests.

Rotation and removal use the same credential reference lifecycle as direct providers. A nonterminal attempt pins its safe credential version metadata; rotation applies to a new attempt. Removal blocks new attempts. Crash dumps are disabled where practical, child environments remain allowlisted, outbound origins remain profile-bound, and logs/output are scanned for the delivered canary.

The pinned task profile selects exactly one active driver. A scripted driver requires neither flag; a direct-model driver requires one `--provider`; an external-agent driver requires one `--agent`. A direct provider means Guarded Agent owns the model loop. An external agent means the selected agent adapter owns planning while Guarded Agent retains only the guarantees supported by its tier.

## 11. Events and Persistence

Add:

- `ProviderProfilePinned`
- `CredentialReferenceValidated`
- `AgentProfilePinned`
- `AdapterCapabilityNegotiated`
- `ExternalAgentStarted`
- `ExternalAgentProtocolRequestReceived`
- `ExternalAgentProtocolRequestDenied`
- `ExternalAgentStopped`
- `CompatibilityTierSelected`

Events contain credential reference and version, never credential bytes. Persist adapter ID and version, protocol version, capability manifest hash, executable hash for local agents, endpoint origin, guarantee tier, and conformance-suite version.

External protocol frames containing source content follow the run evidence mode. Unknown ACP, MCP, provider, or agent message variants fail closed and are retained only in encrypted diagnostic form when policy permits.

## 12. Threats and Controls

| Threat | Control |
|---|---|
| Malicious provider endpoint steals a key | Credential bound to exact reviewed origin, TLS required, redirects disabled |
| Custom adapter reads every credential | Adapter receives unsigned requests, not raw secret map; third-party in-process adapters are trusted code and require review |
| External agent bypasses ACP permission | OS removes host access; every client file and terminal method independently enters Guarded policy |
| External agent reads repository directly | Tier B process has no repository mount; Tier C receives only filtered disposable snapshot |
| MCP annotations claim a destructive tool is safe | Ignore hints for enforcement and use Guarded operation metadata |
| Agent also has unguarded MCP or filesystem tools | Tier downgrade or startup refusal for exclusive-capability mode |
| Key appears in process listing | Never pass a key as argv; use credential broker or minimal environment only for registered agent |
| Key leaks through logs or crash dump | Central redaction, no raw request headers, child dump policy, seeded-key serialization tests |
| Provider changes protocol behavior | Pinned adapter, contract smoke test, capability fingerprint, fail-closed unknown variant |
| Generic compatible endpoint is only partially compatible | Mandatory conformance suite and explicit capability limitations |
| Switching providers corrupts history | Deny in-place switch; use explicit fork with disclosed transcript conversion |

## 13. Test Matrix

Every direct provider adapter must pass the same synthetic contract:

- Text completion and terminal status.
- One complete client function call.
- Malformed, unknown, and oversized tool call.
- Multiple calls under serialized semantics.
- Tool result ID and ordering round trip.
- Streaming split at every byte boundary accepted by the protocol.
- Usage available, delayed, and missing.
- Pre-transmission, post-transmission, and ambiguous disconnect.
- Cancellation and timeout.
- Credential absence from serialized requests after header stripping, events, logs, artifacts, and diagnostics.
- Exact provider fingerprint and transcript replay.
- Provider-specific opaque continuation round trip.
- Storage and server-tool safety settings.

Credential tests:

- Hidden input and stdin import.
- Environment import without value logging.
- Wrong adapter and wrong origin rejection.
- Redirect rejection.
- Missing, revoked, rotated, and expired credential.
- Concurrent rotation and active run.
- Uninstall with retained encrypted data.
- Seeded key scan over process listings, environment snapshots, exceptions, JSONL, RPC, diagnostics, and crash artifacts.

ACP tests:

- Capability negotiation and unknown capability rejection.
- Absolute path mapping and escape attempts.
- File read policy and secret redaction.
- Full-content write converted to exact candidate patch.
- Terminal command converted to reviewed recipe.
- Agent omits permission request and Guarded approval still occurs.
- Cancellation kills process and returns protocol outcome.
- Agent tries direct repository access and fails.
- Malformed notification and slow-output backpressure.
- Executable hash changes after registration.

MCP tests:

- Deterministic paginated tool list.
- Schema conversion and unknown fields.
- Tool-name collision and namespace behavior.
- Untrusted annotations do not alter policy.
- Run capability cannot cross to another run.
- Bridge process cannot read key or daemon socket.
- External agent with another filesystem capability is refused in exclusive mode.

CLI-agent tests:

- Snapshot contains only broker-released files.
- Agent mutates every file but authoritative checkpoint stays unchanged.
- Network and host probes fail.
- Candidate diff is denied, approval-gated, or accepted by the normal patch gateway.
- Crash leaves no accepted source mutation.
- Audit labels Tier C and omits unsupported granular claims.

## 14. Implementation Order

1. Generalize the current provider port and capability manifest before the OpenAI adapter is coupled to domain types.
2. Implement OS credential-store broker, metadata schema, hidden-input CLI, origin binding, and seeded-key tests.
3. Implement OpenAI through the generic port and keep all existing provider tests.
4. Extract a reusable provider conformance suite.
5. Implement Anthropic and Gemini adapters.
6. Implement the generic OpenAI-compatible adapter with an explicit conformance command.
7. Add compatibility tier to run creation, event history, audit, and UI.
8. Implement run-scoped MCP stdio bridge.
9. Implement ACP stdio client with no direct workspace mount.
10. Implement sandboxed CLI adapter and candidate-diff import.
11. Add cross-adapter deterministic evals and credential lifecycle tests.
12. Publish an adapter authoring guide only after the in-tree adapters prove the boundary.

## 15. Acceptance Criteria

- One deterministic task passes through OpenAI, Anthropic, and Gemini synthetic transports with equivalent normalized policy and action events.
- At least two live direct providers pass a credentialed smoke task without changing runtime domain code.
- A generic compatible endpoint must pass conformance before run creation.
- The same run fixture works through one ACP agent while direct filesystem and terminal bypass attempts fail.
- One MCP-capable external agent can use only the run-scoped Guarded operation bridge in exclusive mode.
- One black-box CLI agent produces a profile-valid candidate outcome, including a coding-diff example, without changing authoritative source.
- Credential rotation, removal, wrong-origin, and seeded-leak tests pass.
- Every audit clearly states driver kind, model binding roles, provider/agent adapter and protocol versions, credential reference and ownership mode, endpoint origin, executable hash when applicable, computed guarantee tier, and blind spots.
- Documentation never claims exact provider-context control for MCP or CLI integrations that cannot expose it.

## 16. Scope and Sequencing Decision

Direct provider abstraction and credential profiles are required in the core provider milestone. OpenAI remains the first real adapter because implementing three APIs simultaneously would hide runtime defects.

The multi-provider adapters, MCP bridge, ACP client, and sandboxed CLI agent form a dedicated compatibility milestone after the durable CLI core and before the editor client. If schedule pressure forces a choice, ship the direct provider abstraction, secure credential broker, and one second provider before ACP or MCP. A Code-OSS fork remains unnecessary unless the VS Code extension and protocol adapters encounter a documented blocking limitation.
