# Guarded Agent

Guarded Agent is a general policy-enforced agent runtime. An interchangeable
agent driver may propose context reads, capability actions, and outcomes, but
trusted local components validate and record each boundary crossing. Coding is
the first reference capability pack and flagship demo, not the kernel's product
boundary.

The project is CLI-first. A future VS Code extension is planned as a client of
the same runtime rather than a second enforcement implementation.

## Current Status

Milestone A remains complete as the deterministic runtime foundation.
Milestone B is complete: the policy engine and context boundary are implemented.
The runnable profiles remain deliberately scripted, synthetic, virtual, in
memory, and credential-free. Two broker-current CLI scenarios complete through
the same strict contracts, policy snapshots, context broker, gateway, reducer,
command planner, and runtime host:

- a generic synthetic profile releases bounded reviewed context, transforms it
  through a versioned capability, validates a typed outcome, and records a
  23-event canonical history;
- a coding profile lists, searches, reads, proposes, and inspects against a
  virtual repository, records a 40-event canonical history, and proves the
  original fixture is unchanged.

The historical 19-event synthetic and 33-event coding v1 fixtures remain
byte-exact replay compatibility evidence; fresh executions use separately
versioned broker-current goldens. Milestones C through H are planned. Milestone
B does not claim host Git/worktree mutation, process/container isolation,
durable restart recovery, live approvals, arbitrary agents/models or API keys,
provider connectivity, credential storage, a daemon, or editor integration.

## What Milestones A and B Implement

- Versioned generic contracts for branded UUIDv7 IDs, task profiles,
  objectives, resources, content, normalized actions, observations, outcomes,
  evidence, results, domain errors, and 43 event types.
- Bounded, descriptor-safe boundary snapshots and canonical JSON; known event
  payloads reject unknown fields and malformed nested data.
- One shared strict JSON Schema compiler boundary for profile objective/outcome
  schemas and capability operation schemas.
- An atomic in-memory compare-and-swap event store with strict custom-family
  parser registration, duplicate-ID protection, immutable reads, batch bounds,
  and envelope byte limits.
- A pure `decide`/`evolve`/`planEffects`/`replay` runtime kernel with explicit
  legal states, semantic guards, budget counters, identifier ledgers, terminal
  invariants, and at most one outstanding consequential command.
- Generic `AgentDriver` and `ModelProvider` ports, a deterministic
  `ScriptedAgentDriver`, and a `SyntheticModelProvider` test adapter.
- Version-pinned profile, context-source, and capability-pack registries; a
  context broker and gateway that expose only bounded released views.
- A generic synthetic transform capability and a virtual repository capability
  with `list_files`, `search_text`, `read_file`, `propose_patch`, and
  `inspect_diff` operations. None mutates the host filesystem or invokes Git or
  a process.
- A synchronous in-process runtime host that drains a bounded FIFO, executes
  only installed exact-version ports after pinned policy evaluation, and
  records decisions and results as events.
- Checked-in canonical golden histories, byte-for-byte determinism tests, and
  replay tests whose fail-on-effect spies prove projection rebuild performs no
  I/O or adapter calls.
- A minimal `guard run` CLI whose human, JSONL, and quiet renderers consume
  completed run history rather than making authorization decisions.
- A handwritten `.guard` frontend with bounded UTF-8 lexer, Pratt parser,
  source-span diagnostics, canonical formatter, generative round trips, and
  reviewed production examples.
- Closed, composable attribute catalogs; typed three-valued evaluation with
  explicit presence, deterministic deny/approval/allow combining, secret-safe
  traces, immutable snapshot sets, exact case corpora, and paged simulation.
- `guard policy check|format|test|explain|simulate`, including bounded regular
  file reads, exact snapshot/corpus binding, stable JSON envelopes, independent
  old/new catalogs, whole-corpus totals, and effect-free execution.
- A domain-neutral context broker with source registration, canonical resource
  references, byte/item/run budgets, binary/media checks, secret classifiers,
  prompt-injection tagging, release manifests, and immutable run-pinned policy.
- A contained repository source and virtual pack with hostile-path and TOCTOU
  defenses, literal search, line reads, structural unified-diff inspection,
  byte-free pre-policy normalization, exact multi-path input authorization, and
  independently policy-mediated output paths, filenames, snippets, and patches.
- One-use gateway-owned evaluated-action receipts: denied and approval-gated
  operations cannot reach handlers, while allowed execution receives the exact
  immutable normalized object evaluated by policy. Denied output release also
  suppresses pack-provided audit and human payloads.
- Deterministic Gate B scenarios that inspect exact broker and synthetic-provider
  request bytes, scan all persisted/provider surfaces for raw, encoded, split,
  identifier, filename, search, summary, and hash canaries, and prove replay
  performs no effects.

See [Event Model v1](docs/event-model.md) for envelope fields, event inventory,
state transitions, intent legality, command planning, replay, and current
storage limits.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Git for cloning and contributing

PostgreSQL, Docker or Podman, provider accounts, API keys, and agent
credentials are not needed for Milestone B. They become relevant only in the
later milestones that introduce those adapters.

## Install and Verify

From the repository root:

```bash
npm ci --ignore-scripts
npm run check
npm run build
```

`npm run check` runs strict TypeScript checks, repository documentation and
architecture/policy guards, and every workspace unit/scenario/CLI test. The
separate build command verifies all distributable workspace outputs.

The repository has two exact-pinned direct external runtime dependencies:
`uuid@14.0.2` behind the branded-ID boundary and `ajv@8.20.0` behind the shared
schema-validation boundary. Internal workspace packages are also pinned to
`0.0.0`; TypeScript and Node type definitions are development dependencies.
Install scripts are not required.

## Run the Deterministic Demos

Build first, then invoke the compiled workspace binary. The human renderer is
the default:

```bash
node apps/cli/dist/bin.js run --profile synthetic-demo
node apps/cli/dist/bin.js run --profile coding-virtual
```

Select a stable JSON Lines event stream or a completed-outcome-only view with:

```bash
node apps/cli/dist/bin.js run --profile synthetic-demo --format jsonl
node apps/cli/dist/bin.js run --profile coding-virtual --format quiet
```

The built-in objective is used when no objective option is present. A file,
inline JSON option, or post-`--` shorthand is accepted only when it exactly
matches the selected golden fixture's full envelope or payload shorthand:

```bash
node apps/cli/dist/bin.js run --profile coding-virtual \
  --objective-file apps/cli/testdata/coding-objective.json
node apps/cli/dist/bin.js run --profile synthetic-demo --quiet -- \
  '{"recordId":"greeting","mode":"uppercase"}'
```

Objective input is limited to 65,536 UTF-8 bytes and bounded JSON object depth
and node count. File input must be a regular file. The three objective forms
and the three format selectors are each mutually exclusive.

Use `node apps/cli/dist/bin.js --help` and
`node apps/cli/dist/bin.js run --help` for the exact local command reference.
Milestone B accepts only its two fixed deterministic run profiles. It
intentionally rejects provider, external-agent, model, API-key, credential,
network, and real repository flags rather than accepting a value it cannot
enforce safely.

The policy debugger operates on bounded local files and never executes a
capability effect:

```bash
node apps/cli/dist/bin.js policy check policies/strict.guard --json
node apps/cli/dist/bin.js policy format policies/default.guard
node apps/cli/dist/bin.js policy test apps/cli/testdata/strict.guard \
  --cases apps/cli/testdata/policy-cases-v1.json
node apps/cli/dist/bin.js policy explain policies/strict.guard \
  --action apps/cli/testdata/policy-action.json --json
node apps/cli/dist/bin.js policy simulate \
  --from apps/cli/testdata/allow-pure.guard \
  --to apps/cli/testdata/deny-pure.guard \
  --actions apps/cli/testdata/policy-actions-v1.json --json
```

See [Policy Language v1](docs/policy-language.md) for the grammar, catalog
schema, evaluation semantics, trace behavior, case corpus, and simulator.

No demo or policy command above contacts a network service, reads an environment
credential, starts a model server, mutates a checkout, or launches a container.
The virtual coding run returns patch data as an observation and outcome; it does
not apply that patch.

Output is buffered until the scenario completes. In this in-process slice,
`SIGINT` exits without a partial progress stream and does not append a durable
cancellation event. Exit codes are `0` success, `2` invalid input or
configuration, `3` policy denial or invalid approval, `4` approval pending,
`5` budget exhaustion, `6` task failure, `7` infrastructure failure, and `8`
cancellation.

## Implemented Guarantees and Evidence

The following claims are implemented and tested for the Milestone B in-process
profiles:

- Kernel packages do not import coding, Git, provider SDK, or external-agent
  implementations. Architecture tests enforce the dependency direction and
  scan kernel sources for forbidden provider/coding coupling.
- Profile, capability-pack, and operation identities are exact-version bound.
  Inputs are schema-validated, normalized once, and executed using the captured
  immutable prepared object.
- The scripted driver sees only advertised operations, broker-released context,
  and agent-safe observation views; raw capability results are not included in
  its turn request or golden history.
- Every action crosses the pinned policy evaluator. A deny or approval decision
  cannot execute; only an exact gateway-owned allow receipt reaches its handler.
- Every scenario transition is represented by a strict event envelope. Fresh
  executions are canonically identical to their checked-in golden histories.
- Replaying either history reconstructs the exact terminal projection without
  invoking an effect port.
- The virtual coding fixture remains byte-for-byte unchanged after its run.
- Unknown, malformed, absent, or mismatched policy data fails closed. Every
  shipped policy file owns a reviewed ten-category evidence matrix and a
  fail-closed initial-rollout simulation over its exact recorded action corpus.
- Forbidden source bytes and repository identifiers do not reach exact
  serialized agent/provider input, released observations, audit/human views,
  histories, manifests, or artifacts in the deterministic adversarial corpus.
- Mixed safe and forbidden repository paths deny before handler dispatch or
  provider reads; independently forbidden output paths deny after the bounded
  handler without releasing pack views.
- Boundary mutation tests kill all 14 configured critical mutants and policy
  mutation tests kill all 23, both at the required 100% score.

These are deterministic in-process policy/context claims, not host isolation,
production-provider, approval, or durability claims.

## Current Limitations

- Events and commands live only in process memory. A process exit loses active
  state; there is no restart/resume contract, durable command queue, lease,
  reaper, projection database, or crash reconciliation.
- Policy `require_approval` is represented and routed, but the durable human
  approval service, expiry, consumption, and live precondition revalidation are
  Milestone E work.
- CLI coding runs still use a closed virtual fixture. Milestone B tests a
  no-follow contained host-repository read source, but there is no Git
  repository/worktree manager, patch application, shell/process runner,
  container sandbox, or process-mutation isolation claim yet.
- `ScriptedAgentDriver` and `SyntheticModelProvider` are deterministic adapters.
  There is no direct-model driver, provider HTTP adapter, API-key transport,
  OS credential store, local model endpoint, ACP, MCP, or contained CLI-agent
  integration yet.
- There is no daemon, PostgreSQL database, live approval inbox, multi-client
  protocol, release package, VS Code extension, or Code-OSS fork.
- The CLI runs two built-in evidence scenarios plus the local policy debugger.
  Complete run management, diagnostics, cleanup/export flows, installation
  packaging, and release-quality UX arrive in Milestone F.

## Documentation

- [Full build plan](docs/BUILD_PLAN.md)
- [Critical plan review](docs/PLAN_REVIEW.md)
- [Deep plan audit and resolution register](docs/DEEP_AUDIT.md)
- [General multi-agent and multi-model runtime architecture](docs/GENERAL_RUNTIME_ARCHITECTURE.md)
- [Provider, API-key, and external-agent compatibility](docs/PROVIDER_AGENT_COMPATIBILITY.md)
- [Detailed implementation guide](docs/IMPLEMENTATION_GUIDE.md)
- [Installation, testing, operations, and release plan](docs/OPERATIONS_TEST_PLAN.md)
- [Product requirements and user flows](docs/PRODUCT_REQUIREMENTS.md)
- [Event Model v1](docs/event-model.md)
- [Policy Language v1](docs/policy-language.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Glossary](docs/GLOSSARY.md)
- [Open questions and deferred decisions](docs/OPEN_QUESTIONS.md)
- [Architecture decision records](docs/decisions/)
- [Documentation index](docs/README.md)

## Planned Milestones

The accepted implementation sequence is:

1. **C — Isolated real filesystem execution:** Git adapter, disposable
   worktrees, validated patches, shell-free process recipes, and container
   isolation.
2. **D — Direct models and credentials:** provider-neutral direct-model driver,
   local no-key endpoint, OS credential boundary, and first hosted provider.
3. **E — Durability, daemon, and approvals:** PostgreSQL event/command storage,
   workers and leases, encrypted evidence, reconciliation, restart recovery,
   and precondition-bound approvals.
4. **F — Evaluation and release-quality CLI:** deterministic eval control
   plane, local-corpus research profile, adversarial corpus, complete CLI,
   packaging, clean-machine install, and portfolio release evidence.
5. **G — Broad compatibility:** additional provider families, compatible/local
   endpoint conformance, ACP, MCP, and containment-labeled CLI agents.
6. **H — Multi-client and editor:** hardened authenticated daemon protocol,
   cursor subscriptions and chunked artifacts, daemon-client CLI, and VS Code
   integration.

Planned behavior remains a design target until its milestone-specific tests and
evidence gates pass.

## License

[MIT](LICENSE)
