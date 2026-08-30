# Robin: Provider, Model, Credential, and Agent Compatibility Plan

Document status: normative for provider/model/credential compatibility and
informative for external-agent adapters planned after the direct coding-agent
product is mature.

Robin owns the default coding-agent loop. This document defines how that loop
can use different model APIs, model capability types, local endpoints, and
bring-your-own credentials without coupling repository tools or sessions to one
provider. It also defines weaker, later compatibility tiers for ACP, hosted, or
sandboxed external agents. Those adapters do not replace Robin's core product
and cannot inherit stronger security claims than their observable boundaries.

## 1. Exact Compatibility Goal

The direct-product target is:

1. A developer may select any implemented provider adapter, model profile, and
   one of their own credential records for a Robin coding session.
2. A new direct model API can be added without changing the terminal UI,
   semantic transcript, repository tools, permission model, session store, or
   Git workflows.
3. Interactive and headless surfaces use the same provider port and agent loop.
4. Provider capabilities are negotiated before the first billable request, and
   unsupported workflow requirements fail with an exact diagnostic.
5. A later external agent may participate through a reviewed protocol adapter
   only when Robin can mediate the context and tools claimed by that tier.

“Any provider” means any provider for which a compatible adapter,
authentication strategy, and conformance result exist. “Any model” means a
model whose declared capabilities satisfy the active Robin workflow. “Any API
key” means a user may bind their own key through a supported credential strategy;
it does not mean an unrelated key can drive an unknown API. “Any agent” means a
later external agent implements a supported protocol or runs in the explicitly
weaker containment-only adapter. Arbitrary software never receives Robin's full
guarantees automatically.

## 2. Internal Evidence Tiers and Public Compatibility Names

The A–D letters are internal evidence tiers. Product UI, documentation, and
support matrices use the public names in Product Requirements section 11. The
mapping is explicit:

| Internal tier | Integration and achieved control | Product public tier name | Permitted claim |
| --- | --- | --- | --- |
| A | Robin direct-model session; Robin owns prompt input, provider request, client tools, permissions, semantic transcript, budgets, and credential injection | **Conformant direct provider** for a full hosted adapter; **Compatible endpoint** for a generic tested subset; **Local model endpoint** for a tested local transport/profile | Only the capabilities and workflow covered by the adapter/model/endpoint conformance result |
| B | Pinned mediated external protocol with Robin-owned advertised tools and context channel, and no undisclosed filesystem/process/network path | **External agent bridge** — mediated | Tool/context mediation only for traffic that crosses the bridge; provider-input claims require separate visibility evidence |
| C | Sandboxed black-box CLI or hosted agent operating on a filtered disposable workspace and returning an untrusted candidate | **External agent bridge** — containment-only | Containment, resource/network policy, and candidate-import review; no per-internal-action or exact model-context claim |
| D | Observe-only import of external status, transcript, or final artifacts | **External agent bridge** — observe-only | Audit assistance for imported facts; no prevention, mediation, or containment claim |

**Unsupported experiment** is the public name for a manually configured path
that has not passed its applicable conformance and release gates. It is outside
the A–D support mapping rather than a way to self-assert one of those tiers.

Robin records the public name, internal evidence tier, conformance version, and
known blind spots in session configuration and transcript export. An adapter
reports primitive capabilities; trusted Robin code computes the achieved tier.

## 3. Core Architecture

```text
developer / CLI / future client
              |
              v
      Robin session application
              |
       +------+-------------------------+
       |                                |
       v                                v
direct-model coding loop        later AgentBackend adapter
       |                         mediated / contained / observe
       v                                |
production ModelProviderAdapter         |
       |                                |
OpenAI / Anthropic / compatible         |
SDK or bounded transport                |
       +---------------+----------------+
                       |
       normalized content, tool proposals,
         or contained candidate artifacts
                       |
 permission / approval / candidate-import gateway
                       |
             workspace / process / Git / MCP
                       |
            canonical Robin session store
```

Direct-provider packages translate one model API dialect. External-agent
packages translate one backend protocol or candidate format. Neither path may
write the workspace, mint an approval, resolve arbitrary credentials, or create
an alternate durable authority.

## 4. Canonical Production Provider Port

The R4 production port is the port frozen in
[Robin CLI Architecture section 10](ROBIN_CLI_ARCHITECTURE.md#10-provider-architecture):

```ts
interface ModelProviderAdapter {
  readonly descriptor: ProviderDescriptor;

  probe(
    request: ProviderProbeRequest,
    credential: CredentialLease | null,
    signal: AbortSignal,
  ): Promise<ProviderProbeResult>;

  countInput(
    request: ProviderNeutralRequest,
    model: ModelDescriptor,
  ): Promise<TokenCountResult>;

  invoke(
    request: ProviderNeutralRequest,
    credentialRef: CredentialLeaseReference,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedProviderEvent>;

  classifyUnknownError(error: unknown): ProviderFailure;
  redactDiagnostic(input: unknown): SafeDiagnostic;
}
```

`probe` negotiates bounded provider/model facts. `countInput` performs preflight
accounting. `invoke` owns request compilation, transport, stream normalization,
and continuation reconstruction and yields only normalized provider events.
Unknown thrown values and diagnostic objects leave the package only through
`classifyUnknownError` and `redactDiagnostic`.

The repository's current initial-R1 preview uses
`ModelProvider.respond(SemanticModelRequest, AbortSignal)`. That method is a
temporary preview shim for the credential-free provider-neutral text slice; it
is not a second production extension point. R4 adapts synthetic fixtures to the
canonical port, migrates product call sites to `invoke`, and retires the shim
from product composition after compatibility tests pass.

Request compilation, wire-stream normalization, and continuation
reconstruction remain internal adapter-pipeline helpers. Functions such as
`compileSemanticRequest`, `normalizeProviderStream`, or
`reconstructContinuation` are not public peer ports and cannot be called by
application or session code. Provider SDK request, response, error, and
continuation types stop inside the provider package.

The public port carries a credential lease reference, not raw secret bytes or a
general secret map. Immediately before authenticated transport, the adapter
requests a provider/origin/invocation/deadline-bound lease, validates the exact
origin, disables redirects or applies the reviewed origin policy, injects
authentication, and redacts transport objects before diagnostics.

## 5. Provider Capability Negotiation

Every invocation pins the intersection of adapter conformance, exact endpoint
and authentication profile, exact or explicitly mutable model capability,
bounded probe results, and selected Robin workflow requirements. Negotiation
finishes before secret resolution, repository egress, or a potentially billed
request.

Required checks:

- Can the API accept client-defined structured tools?
- Can parallel tool calls be disabled, or must batches fail closed locally?
- Can provider-side response storage be disabled?
- Which ordered items must be returned for stateless continuation?
- Are usage totals exact, delayed, or unavailable?
- Which request and response IDs are exposed?
- Can an in-flight request be cancelled and what does cancellation prove?
- Which roles, content blocks, schemas, and maximum sizes are accepted?
- Does the provider execute any enabled tool server-side outside Robin?

Unknown capability is not true. If client-side tool mediation is unavailable,
the adapter cannot receive Tier A evidence for a coding workflow. Provider-
executed shell, code, browser, computer, or filesystem tools remain disabled
unless a separate product contract and threat model are approved.

## 6. Initial Direct Provider Adapters

### 6.1 OpenAI Responses adapter

The first hosted production adapter is `packages/provider-openai`. R4 targets
the OpenAI Responses API through a reviewed and pinned official JavaScript SDK.
SDK retries, implicit environment-key discovery, debug logging, telemetry, and
provider storage defaults are disabled or explicitly wrapped so Robin owns
attempt evidence, normalization, retry classification, retention requests,
budgets, transcript items, and tool dispatch. The SDK stays behind injected
adapter and transport seams; no SDK type crosses the production provider port.

The adapter uses client function tools, initially disables parallel tool
execution, preserves call/result association and required continuation items,
and passes recorded, fake-transport, malformed-stream, cancellation, retry,
usage, and redaction suites. Current protocol details are pinned against the
official
[Responses create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

### 6.2 Anthropic Messages adapter

R7 adds this adapter through the same request-encoder, event-decoder,
tool/result-codec, error-classifier, model-catalog, retention, transport, and
fixture boundaries. It maps Robin tools to client-executed user-defined tools,
normalizes `tool_use`, and returns bounded `tool_result` content associated with
the exact call. Server-executed tools remain outside the direct coding claim.
Anthropic documents the application-owned pattern in its
[tool-use contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works).

### 6.3 Generic OpenAI-compatible and local adapter

R7 supports endpoints that pass a versioned conformance suite for an explicitly
selected Responses, chat-completions, local-tool, or text-only subset.
“OpenAI-compatible” is not accepted from a label alone. The endpoint must
demonstrate:

- Tool schema acceptance and complete structured arguments.
- Stable call IDs and result association.
- Streaming frame termination.
- Error and usage normalization.
- Configured storage and parallel-call behavior.
- Maximum request and response limits.
- No silent server-side tool execution.

Hosted credential-bearing origins require HTTPS and exact audience binding.
Explicit loopback or Unix-socket local profiles may use no credential, but
local model transport is not a claim that Robin tools or extensions have no
egress.

### 6.4 Later providers and third-party adapters

Gemini and additional provider families follow only after the R7 adapters prove
the shared boundary. A future adapter SDK supplies schemas, synthetic transport,
golden fixtures, and the same conformance harness. Third-party adapter code is
trusted supply-chain code when loaded in-process. No adapter is enabled merely
because analyzed repository content declares executable code.

## 7. Bring-Your-Own Credential System

### 7.1 Credential records

Credential metadata and secret bytes are separate. R4 supports one exact
allowlisted environment-variable reference for the selected provider and
hidden session input held only for process life. It stores the environment
variable name, never its value; session input must be entered again after
restart before another provider invocation.

R7 adds reviewed macOS Keychain and Linux Secret Service adapters, rotation
generations, and reconciled removal. When an OS store is unavailable, Robin
offers the documented environment-reference or session-only path. It never
falls back to plaintext configuration, a repository `.env`, an arbitrary
secret file, or a homemade encrypted credential file.

Repository and local-project configuration store only `credential_ref`. The key never appears in a repository file, command-line argument, prompt/context,
session event, CAS object, JSON/JSONL output, child environment, log, support
bundle, editor state, Git data, or provider-safe diagnostic.

### 7.2 Supported authentication strategies

Reviewed adapters may implement fixed strategies:

- bearer token in the fixed authorization header;
- a fixed provider-specific key header;
- provider-native login after its refresh contract exists; or
- no credential for an explicit local profile.

Configuration cannot invent arbitrary secret-bearing headers, query parameters,
or templates. Every record is bound to provider, authentication strategy, and
exact allowed origin. Authenticated redirects are disabled by default, and
authorization never crosses an origin boundary.

### 7.3 Credential CLI

The target product commands are:

```text
robin auth add openai-personal
robin auth add openai-environment --from-env OPENAI_API_KEY
robin auth list
robin auth inspect openai-personal
robin auth validate openai-personal
robin auth rotate openai-personal
robin auth remove openai-personal

robin models list
robin models inspect <model-id>
robin doctor
robin support bundle --dry-run
```

R4 implements add/list/inspect/validate/remove for environment and session
sources. Rotation and persistent OS-store behavior arrive in R7. `auth add`
never accepts a raw secret as a flag, positional argument, or ordinary stdin
stream. `--from-env` accepts only the exact provider-supported variable name
and stores the reference rather than copying its value.

`auth validate` first checks metadata, source availability, origin binding, and
format locally. A network probe identifies its origin, data, and potential cost
before sending it, sends no repository content, and records only safe status
and provider request ID.

Removal shows dependent provider profiles and sessions. An active invocation
keeps its already-issued bounded lease until settlement; removal blocks new
leases and reports secret-backend and metadata outcomes separately. Rotation
validates a new generation before atomically switching future invocations; it
does not rewrite historical provider records.

### 7.4 Provider profiles

A provider profile contains no secret:

```json
{
  "schemaVersion": 1,
  "profileId": "openai-coding",
  "adapterId": "openai-responses",
  "credentialRef": "openai-personal",
  "endpointOrigin": "https://api.openai.com",
  "modelId": "configured-and-contract-tested-model-id",
  "capabilityManifestHash": "sha256:validated-manifest",
  "providerStorageRequest": "disabled",
  "requestLimits": { "maximumOutputTokens": 8192 },
  "pricingMetadataId": "reviewed-pricing-snapshot"
}
```

Model aliases are labeled mutable. Every invocation records the exact selected
identifier, known revision, adapter/version, negotiated capability snapshot,
endpoint, credential-reference generation, request-affecting configuration,
usage quality, and retention request. No profile claims durable transcript
encryption; initial local durability uses the canonical session-store controls.

Configuration precedence remains defaults → managed → user → project →
local-project → environment → explicit settings file → CLI. Named profiles live
inside those scopes. Interactive model/provider choices are nonpersisted
session/turn overrides recorded in the configuration snapshot, not another
configuration scope.

## 8. Running Direct Providers

The normal interactive path is:

```text
robin --provider openai --model <tested-model-id> \
  "add rate limiting and verify the focused tests"
```

The same application service, session, and loop support the headless surface:

```text
robin --print --output text "summarize the current diff"
robin --print --output json --permission-mode locked "run the allowed checks"
robin --print --output stream-json --no-session "inspect this repository"
```

`--output` and `--no-session` are the target flags. `default`, `plan`,
`accept-edits`, `locked`, and `bypass` are permission modes; headless is a
surface, not a mode. The current preview spelling `ask` maps to `default`.
Unmatched asks on a headless surface become deny unless an exact rule or framed
permission callback applies. `--no-session` writes no transcript or CAS and
therefore disables resume/background recovery; it cannot suppress operational
evidence required by managed policy.

R4 starts with one hosted provider and no cross-provider automatic fallback.
R7 may switch provider/model only between completed turns, after checking
credential, egress, context, tool/modality, pending continuation, and
compaction requirements. If semantic continuity cannot be represented, Robin
creates an inspectable fork/compaction boundary instead of silently discarding
provider-private state.

## 9. Later External-Agent Backends

External-agent breadth is an R9 concern, after the direct CLI, durable sessions,
permissions, provider breadth, configuration, MCP client, and worktree
isolation pass their gates.

### 9.1 ACP client adapter

Robin acts as the ACP client and launches a version-pinned agent over stdio.
ACP provides initialization, sessions, prompt turns, cancellation, file and
terminal operations, permission requests, and streamed updates. The current
protocol overview is maintained by the
[Agent Client Protocol project](https://agentclientprotocol.com/get-started/introduction).

Security mapping:

- ACP absolute file paths are mapped from the advertised synthetic workspace root to Robin canonical repository-relative paths.
- `fs/read_text_file` becomes a context-broker request.
- `fs/write_text_file` becomes a candidate patch derived from the bound preimage and requested full content; it never writes directly.
- `terminal/create` becomes a normalized process recipe in a disposable execution snapshot.
- Terminal output becomes bounded artifacts and model-safe observations.
- `session/request_permission` is treated as display intent only. Robin permission
  and approval run for every consequential method even when the agent never asks
  ACP permission.
- `session/cancel` maps to durable cancellation and full contained process termination.
- ACP updates are untrusted display data and cannot mark a Robin command successful.

For Tier B, the agent has no host repository mount, applicable future supervisor
socket, provider credential, or undisclosed process/network capability. It
receives context and tools only through the reviewed protocol. Requiring a
direct host channel reclassifies it as Tier C or refuses startup.

### 9.2 MCP tool bridge

Robin acts as an MCP client in R8 before it later exposes a bridge for external
agents. A bridge capability is scoped to one session and backend instance.
`tools/list` returns deterministic namespaced schemas, and `tools/call` routes
through validation, normalization, permission, approval, execution, and durable
settlement. The bridge exposes no provider credential or applicable future
supervisor-socket authority.

The MCP specification describes tool annotations as untrusted hints. Robin ignores MCP read-only, destructive, idempotent, and open-world hints for authorization and uses its own versioned operation definitions. See the official [MCP tools specification](https://modelcontextprotocol.io/specification/draft/server/tools).

Robin can prove what the bridge received, decided, executed, and returned. It
cannot infer other context or tools an external agent used. Tier B therefore
requires the bridge to be the agent's exclusive repository/process capability;
otherwise the backend is Tier C or an unsupported experiment.

### 9.3 Sandboxed CLI adapter

For an agent without ACP or a usable client-tool protocol:

1. Robin creates a policy-filtered disposable snapshot or owned isolated
   worktree from the session's accepted workspace checkpoint.
2. Sandbox launches the exact executable and version with a minimal environment.
3. Network is disabled or restricted to an explicitly reviewed profile.
4. The agent may mutate only its disposable snapshot.
5. Robin captures bounded output and exit status.
6. The resulting diff is treated as an untrusted candidate patch.
7. Patch parsing, permission, approval, application, checkpoint, and tests occur
   through normal Robin boundaries.
8. Snapshot is discarded.

This mode cannot provide per-internal-tool permission decisions, exact provider
transcript replay, or proof that the agent did not read an allowed snapshot
file. Its public claim is **External agent bridge — containment-only**, not a
mediated-agent claim.

### 9.4 Hosted agent API adapter

A hosted agent can qualify for Tier B only if its API exposes enough structure to:

- Send a policy-selected context package rather than uploading the repository.
- Disable or replace its native filesystem, shell, network, and deployment tools.
- Return structured proposed operations with stable IDs.
- Accept tool results from Robin.
- Expose cancellation, terminal status, usage, and session continuation.

If the service requires a repository upload or executes its own unmediated tools, it is not compatible with the full harness. It may be evaluated in a separate remote-agent mode whose data-transfer and side-effect claims are explicitly weaker.

## 10. External-Agent Identity and Credential Ownership

The exact public registration command is deferred to the R9 CLI snapshot. The
old runtime-era `robin run --profile ... --objective-file ...` examples are not
part of Robin's target coding-session surface.

A future backend record pins executable/package identity, adapter and protocol
versions, requested capabilities, context route, environment allowlist,
network/sandbox profile, model owner, credential owner, and conformance result.
A changed executable or package invalidates the registration until reviewed.

Credential ownership is expressed as capabilities, not the legacy
`guard_transport` identifier:

- no credential is required;
- Robin owns provider transport and the external backend receives no secret;
- a reviewed one-shot broker channel delivers one audience-bound lease to the
  registered backend; or
- an explicit containment fallback places one selected credential into only the
  constructed agent sandbox environment.

Delegating a credential to an external agent means that agent and its children
can read it. Robin records that disclosure and cannot make the direct-model
credential-confinement claim. Credential bytes never travel in argv, repository
files, normal protocol diagnostics, or an ambient daemon environment.

Rotation affects future backend attempts. Removal blocks new leases and reports
active session/backend dependencies; it does not use a legacy “nonterminal run”
record or mutate a settled historical transcript.

The coding session selects exactly one top-level backend. The normal direct-
model backend uses the session's provider/model profile. A later external
backend owns some planning behavior, so Robin retains only the guarantees
supported by its displayed tier.

## 11. Events, Phases, and Canonical Persistence

Compatibility adapters use the event planes defined in
[Robin CLI Architecture section 6](ROBIN_CLI_ARCHITECTURE.md#6-canonical-events-and-normalized-streaming):

| Backend observation | Live agent event | Application event | Canonical durable result |
| --- | --- | --- | --- |
| Text/content delta | bounded assistant delta | `ProviderTextDelta` or backend-neutral content delta | no per-delta event; seal complete/partial content into CAS and append its semantic event |
| Complete provider or external tool proposal | sealed normalized proposal | `ProviderToolCallCompleted`, then `ToolRequestNormalized` | proposal bytes and IDs sealed before `ToolCallReceived`/`ToolCallNormalized` |
| Permission or execution lifecycle | Robin subsystem phase | `PermissionDecided`, approval events, tool start/output/terminal events | committed permission request/response and prepared/started/settled tool events |
| Usage, warning, or safe backend status | bounded usage/status update | normalized usage/progress/diagnostic event | durable usage or configuration fact only when semantically required |
| Backend completion, failure, or cancellation | classified terminal observation | assistant/turn terminal application event | sealed content plus exactly one legal durable terminal turn event |

Renderers consume application events, never provider SDK callbacks or raw agent
frames. Live deltas may be coalesced under declared backpressure rules; durable
sequence numbers apply only to committed canonical events.

Interaction phases such as `compiling_context`, `requesting_provider`,
`collecting_provider_items`, `waiting_for_approval`, `executing_tool`, and
`finalizing_assistant_message` are transient coordinator/UI facts and may recur
within one turn. They are not persisted as turn status. The durable projection
uses only `accepted`, `active`, `cancellation_requested`, `interrupted`,
`cancelled`, `failed`, `provider_result_uncertain`, `recovery_required`, and
`completed`, derived from committed semantic events. Crash recovery inspects
prepared/started/settled records and appends a safe result; it never fabricates
the last visible interaction phase.

The framed Robin event log, CAS, snapshots, locks, migrations, and session
reducer in Architecture section 13 remain the one canonical session store.
Provider continuation items and external protocol artifacts are retained only
when required, bounded, attributed, and referenced through that store. An
adapter cannot create a second authoritative run ledger.

Initial releases claim private filesystem permissions, secret exclusion,
redaction, bounded retention, export, and purge—not transcript-at-rest
encryption. Unknown provider/agent frames fail closed and may be retained only
as a policy-permitted redacted or opaque diagnostic artifact. Authenticated
encryption becomes a claim only after its separate key lifecycle, crash,
rotation, recovery, and platform gate passes.

## 12. Threats and Controls

| Threat | Control |
|---|---|
| Malicious provider endpoint steals a key | Credential bound to exact reviewed origin, TLS required, redirects disabled |
| Custom adapter reads every credential | Adapter receives unsigned requests, not raw secret map; third-party in-process adapters are trusted code and require review |
| External agent bypasses ACP permission | OS removes host access; every client file and terminal method independently enters Robin policy |
| External agent reads repository directly | Tier B process has no repository mount; Tier C receives only filtered disposable snapshot |
| MCP annotations claim a destructive tool is safe | Ignore hints for enforcement and use Robin operation metadata |
| Agent also has unguarded MCP or filesystem tools | Tier downgrade or startup refusal for exclusive-capability mode |
| Key appears in process listing | Never pass a key as argv; use credential broker or minimal environment only for registered agent |
| Key leaks through logs or crash dump | Central redaction, no raw request headers, child dump policy, seeded-key serialization tests |
| Provider changes protocol behavior | Pinned adapter, contract smoke test, capability fingerprint, fail-closed unknown variant |
| Generic compatible endpoint is only partially compatible | Mandatory conformance suite and explicit capability limitations |
| Switching providers corrupts history | Permit only between completed turns; validate semantic continuity and require disclosed compaction/fork when lossless conversion is impossible |

## 13. Test Matrix

Every production direct-provider adapter passes shared tests for:

- semantic request mapping and provider-object import boundaries;
- text/tool/result streaming across adversarial chunk boundaries;
- duplicate, malformed, unknown, oversized, incomplete, and post-terminal
  events;
- serialized multiple-tool semantics and exact call/result association;
- usage present, partial, delayed, cumulative, and absent;
- cancellation, timeout, retry-safe failure, post-transmission disconnect, and
  uncertain outcome;
- endpoint, TLS, redirect, proxy, and credential-audience behavior;
- credential canary absence from session, CAS, prompt, children, logs, machine
  output, diagnostics, and support inventory;
- context/output limits, storage/retention request mapping, and declared
  continuation round trip;
- recorded transport fixtures plus one opt-in cost-capped live smoke test on a
  disposable repository.

Credential tests distinguish R4 environment/session sources from R7 OS-store
create/read/replace/delete, rotation, and partial-removal cases. They cover
missing/empty/revoked credentials, origin mismatch, an active invocation lease,
restart re-entry, terminal restoration, process-list/history safety, and seeded
redaction across every output surface.

Later external-backend tests cover handshake/version drift, context/tool
exclusivity, path/process/network/socket escapes, cancellation, hidden-channel
reclassification, credential disclosure, bounded frames/output, isolated
candidate import, authoritative-workspace preservation, and exact public tier/
blind-spot reporting.

## 14. Implementation Order

1. Complete the initial-R1 interactive and headless synthetic-provider loop and
   versioned application-event mapping.
2. Complete real repository tools and the R3 canonical durable session store.
3. Freeze the R4 production provider port and conformance harness.
4. Review and pin the official OpenAI SDK; implement the Responses adapter,
   environment/session BYOK, model catalog, redaction, and first live smoke.
5. Complete R5/R6 permissions, sandbox, daily editing, and Git workflows.
6. In R7, add Anthropic, bounded compatible/local endpoints, persistent OS
   credentials, model switching, and stable headless schemas.
7. In R8, complete configuration precedence, project trust, instructions,
   hooks/skills, and Robin as an MCP client.
8. In R9, add subagents/worktree isolation and only then mediated/contained
   external-agent backends and any session-scoped MCP bridge.
9. Publish third-party adapter authoring guidance only after in-tree adapters
   prove the interface and trust boundary.

## 15. Acceptance Gates

R4's first hosted-provider gate requires one exact supported OpenAI model to
complete Robin's real diagnose/edit/verify/diff workflow through the official-
SDK Responses adapter, with offline conformance, stable failure UX, environment
and session BYOK, redaction canaries, canonical provider-attempt persistence,
restart re-entry, and no change to tool/session/application code.

R7's provider-breadth gate separately requires two hosted provider families and
one no-key local/compatible endpoint to complete the same semantic workflow;
declared subset conformance; safe switching only between terminal turns, with no
in-turn automatic fallback; OS-store rotation/removal; and stable text, JSON,
stream-JSON, structured-result, permission, and `--no-session` behavior.

R9's later external-agent gate requires mediated and contained backends to pass
their distinct escape, cancellation, credential, context/tool exclusivity, and
candidate-import suites. Every exported transcript states its public name,
internal tier, adapter/protocol/model identity, credential owner, endpoint or
executable identity, conformance version, and residual blind spots.

The traceability registry maps each applicable compatibility claim to the
relevant subset of the Product Requirements' 213 unique requirement IDs. No
gate may claim exact provider context, durable encryption, mediation, or
containment that its evidence does not prove.

## 16. Scope and Sequencing Decision

Direct provider abstraction and R4 environment/session credential references
are required for the first live-model alpha. OpenAI Responses through the
official JavaScript SDK is the fixed first hosted implementation. Persistent OS
credential stores and provider breadth are R7, not prerequisites for proving
the first adapter.

MCP client support precedes an external-agent tool bridge. ACP or another
mediated protocol, contained black-box agents, background supervision, and a
multi-client daemon remain R9 work after the durable local CLI. A Code-OSS fork
remains unnecessary unless a shipped extension later encounters a measured,
documented blocking limitation.
