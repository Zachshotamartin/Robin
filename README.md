# Guarded Agent

Guarded Agent is a general policy-enforced agent runtime. An interchangeable
agent driver may propose context reads, capability actions, and outcomes, but
trusted local components validate and record each boundary crossing. Coding is
the first reference capability pack and flagship demo, not the kernel's product
boundary.

The project is CLI-first. A future VS Code extension is planned as a client of
the same runtime rather than a second enforcement implementation.

## Current Status

Milestone A is complete: the deterministic runtime kernel is implemented. It
deliberately uses scripted inputs, virtual fixtures, an in-memory event store,
and no model or provider credentials. Two provider-free scenarios complete
through the same strict contracts, reducer, command planner, runtime host, and
event-derived CLI:

- a generic synthetic profile releases bounded context, transforms it through
  a versioned capability, validates a typed outcome, and records a 19-event
  canonical history;
- a coding profile lists and reads a virtual repository, proposes a patch,
  validates a typed outcome, records a 33-event canonical history, and proves
  the original fixture is unchanged.

Milestones B through H are planned. In particular, Milestone A does not claim
durable restart recovery, a real policy language, host filesystem access, Git
mutation, process/container execution, real approvals, hosted/local model
connectivity, credential storage, a daemon, or editor integration.

## What Milestone A Implements

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
  with `list_files`, `read_file`, and `propose_patch` operations. None touches
  the host filesystem, Git, or a process.
- A synchronous in-process runtime host that drains a bounded FIFO, executes
  only the installed exact-version ports, records results as events, and uses a
  Phase-A policy that allows only `sideEffectClass: "none"`.
- Checked-in canonical golden histories, byte-for-byte determinism tests, and
  replay tests whose fail-on-effect spies prove projection rebuild performs no
  I/O or adapter calls.
- A minimal `guard run` CLI whose human, JSONL, and quiet renderers consume
  completed run history rather than making authorization decisions.

See [Event Model v1](docs/event-model.md) for envelope fields, event inventory,
state transitions, intent legality, command planning, replay, and current
storage limits.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Git for cloning and contributing

PostgreSQL, Docker or Podman, provider accounts, API keys, and agent
credentials are not needed for Milestone A. They become relevant only in the
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
Milestone A accepts only its two fixed deterministic profiles. It intentionally
rejects provider, external-agent, model, API-key, credential, network, and real
repository flags rather than accepting a value it cannot enforce safely.

No command above contacts a network service, reads an environment credential,
starts a model server, mutates a checkout, or launches a container. The virtual
coding run returns patch data as an observation and outcome; it does not apply
that patch.

Output is buffered until the scenario completes. In this in-process slice,
`SIGINT` exits without a partial progress stream and does not append a durable
cancellation event. Exit codes are `0` success, `2` invalid input or
configuration, `3` policy denial or invalid approval, `4` approval pending,
`5` budget exhaustion, `6` task failure, `7` infrastructure failure, and `8`
cancellation.

## Implemented Guarantees and Evidence

The following claims are implemented and tested for the Milestone A in-process
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
- The Phase-A host cannot execute a consequential capability. It allows only
  normalized `none` side-effect operations and denies every other class.
- Every scenario transition is represented by a strict event envelope. Fresh
  executions are canonically identical to their checked-in golden histories.
- Replaying either history reconstructs the exact terminal projection without
  invoking an effect port.
- The virtual coding fixture remains byte-for-byte unchanged after its run.

These are deterministic-kernel claims, not broad production security or
durability claims.

## Current Limitations

- Events and commands live only in process memory. A process exit loses active
  state; there is no restart/resume contract, durable command queue, lease,
  reaper, projection database, or crash reconciliation.
- The Phase-A policy is a hard-coded pure-or-deny adapter. The policy grammar,
  parser, type checker, evaluator, trace debugger, simulator, context secret
  classification, and real approval workflow are Milestone B/E work.
- Repository data is a closed virtual fixture. There is no OS filesystem,
  symlink/path boundary, Git repository/worktree, patch application, shell,
  process runner, container sandbox, network policy, or original-checkout
  isolation claim yet.
- `ScriptedAgentDriver` and `SyntheticModelProvider` are deterministic adapters.
  There is no direct-model driver, provider HTTP adapter, API-key transport,
  OS credential store, local model endpoint, ACP, MCP, or contained CLI-agent
  integration yet.
- There is no daemon, PostgreSQL database, live approval inbox, multi-client
  protocol, release package, VS Code extension, or Code-OSS fork.
- The minimal CLI runs the two built-in evidence scenarios. Complete command
  management, diagnostics, cleanup/export flows, installation packaging, and
  release-quality UX arrive in Milestone F.

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
- [Threat model](docs/THREAT_MODEL.md)
- [Glossary](docs/GLOSSARY.md)
- [Open questions and deferred decisions](docs/OPEN_QUESTIONS.md)
- [Architecture decision records](docs/decisions/)
- [Documentation index](docs/README.md)

## Planned Milestones

The accepted implementation sequence is:

1. **B — Policy and context boundary:** policy language/debugger, resource
   canonicalization, release budgets, classifiers, and hostile fixtures.
2. **C — Isolated real filesystem execution:** Git adapter, disposable
   worktrees, validated patches, shell-free process recipes, and container
   isolation.
3. **D — Direct models and credentials:** provider-neutral direct-model driver,
   local no-key endpoint, OS credential boundary, and first hosted provider.
4. **E — Durability, daemon, and approvals:** PostgreSQL event/command storage,
   workers and leases, encrypted evidence, reconciliation, restart recovery,
   and precondition-bound approvals.
5. **F — Evaluation and release-quality CLI:** deterministic eval control
   plane, local-corpus research profile, adversarial corpus, complete CLI,
   packaging, clean-machine install, and portfolio release evidence.
6. **G — Broad compatibility:** additional provider families, compatible/local
   endpoint conformance, ACP, MCP, and containment-labeled CLI agents.
7. **H — Multi-client and editor:** hardened authenticated daemon protocol,
   cursor subscriptions and chunked artifacts, daemon-client CLI, and VS Code
   integration.

Planned behavior remains a design target until its milestone-specific tests and
evidence gates pass.

## License

[MIT](LICENSE)
