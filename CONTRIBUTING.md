# Contributing

Guarded Agent is built milestone by milestone. Preserve the distinction between
implemented evidence and planned guarantees: Milestone A is the current
implementation; Milestones B through H remain planned.

## Before Making a Change

Read the sections of the [build plan](docs/BUILD_PLAN.md),
[implementation guide](docs/IMPLEMENTATION_GUIDE.md),
[threat model](docs/THREAT_MODEL.md), and [Event Model v1](docs/event-model.md)
that govern the change. Identify:

1. the trusted and untrusted sides of every affected boundary;
2. the exact versioned contract and package that owns it;
3. the intent, event, projection, and command behavior affected;
4. normalization, policy, failure, cancellation, and budget semantics;
5. replay and recovery consequences;
6. the deterministic tests and residual-risk documentation required.

Do not add coding, provider, Git, filesystem, process, credential, daemon, or UI
concepts to generic kernel packages to make an adapter easier to implement.

## Bootstrap and Required Checks

Use Node.js 22 or newer and npm 10 or newer. From the repository root:

```bash
npm ci --ignore-scripts
npm run check
npm run build
```

`npm run check` is the local merge gate. It runs strict workspace type checks,
repository documentation/architecture/policy tests, and all workspace unit,
scenario, and CLI tests. `npm run build` separately verifies every declared
workspace build. Run the smallest affected workspace test while iterating, then
run the complete commands above before requesting review.

For contract-facing work, also run the root contract suite:

```bash
npm run test:contracts
```

Do not weaken a root check, omit a new workspace from it, or regenerate a
golden fixture merely to make a failure disappear. Explain and review every
intentional contract or golden-history change.

## Test-First Change Flow

1. Add the smallest failing test or fixture that expresses the missing
   behavior or former bypass.
2. Confirm the failure occurs at the intended enforcement point.
3. Implement the smallest complete change without introducing a parallel
   validation or execution path.
4. Add boundary-equality tests: exact limit accepted and one unit beyond
   rejected.
5. Cover malformed data, unknown fields, wrong versions, mutation after call,
   proxy/accessor inputs, duplicate identities, and wrong-state transitions
   when relevant.
6. Verify replay remains effect-free and deterministic whenever events,
   projection state, or command planning changes.
7. Run the affected workspace suite, then the full merge gate and build.
8. Update current-status, event-model, threat, or residual-risk documentation
   whenever the claim surface changes.

Tests must be deterministic and credential-free in pull-request CI. Never use
the public network, a real API key, a private repository, the developer's home
directory, or an unbounded clock/random source in a deterministic fixture.

## Contract and Boundary Rules

- Treat every adapter, CLI input, stored record, schema document, and returned
  value as untrusted until the owning boundary has parsed it.
- Use the existing contracts and shared schema-validation package. Do not add a
  second Ajv instance or an ad hoc schema compiler in another workspace.
- Reject unknown fields and unsupported versions. Validation must not coerce,
  remove, default, or mutate caller data.
- Capture caller-owned structures once into bounded, detached, immutable data
  before validation, hashing, normalization, storage, or execution.
- Normalization is semantic and happens once. Execute the exact immutable
  prepared value that policy evaluated; do not reconstruct it from raw input.
- Keep size, depth, node, string, array, object, turn, action, and dispatch
  limits finite. Test limits at their exact boundary.
- Preserve the canonical domain-error taxonomy and avoid leaking hostile input,
  credentials, raw content, paths, or provider payloads through messages and
  details.
- Pin component, profile, schema, capability-pack, and operation versions. A
  convenient latest-version lookup is not valid run evidence.

## Event and Runtime Rules

- Facts are events; effects are command data. `decide`, `evolve`,
  `planEffects`, and `replay` remain pure.
- A new event type needs a strict payload contract, parser, legal-state entry,
  reducer behavior, command-planning decision, malformed-input tests, legal and
  illegal transition tests, replay coverage, and event-model documentation.
- Preserve gap-free per-run `streamVersion`, unique event IDs, explicit
  causation, nondecreasing record time, and optimistic append semantics.
- Never execute an effect during replay. Replay tests should replace every
  effect port with a fail-on-use spy.
- At most one consequential command may be outstanding in the current runtime
  projection. Result events must settle it before another starts.
- Terminal events require matching run/result identities and no live work;
  completion additionally requires the exact validated outcome and evidence.
- Checked-in golden histories are immutable compatibility evidence. Update one
  only as part of a reviewed event-contract decision and describe the semantic
  difference in the pull request.

## Capability Change Requirements

A new capability pack or operation must define:

1. exact pack and operation IDs and positive versions;
2. strict bounded input and output JSON Schemas;
3. semantic normalization into a stable `NormalizedAction`;
4. resource, subject, environment, precondition, and side-effect attributes;
5. the default policy effect and a traceable enforcement point;
6. approval display/binding behavior if the operation may become consequential;
7. sandbox or isolation requirements for a future real adapter;
8. idempotency, reconciliation, cancellation, timeout, and retry semantics;
9. bounded raw, agent, human, and audit output views;
10. event and evidence representation;
11. unit, integration, adversarial, mutation, and replay tests;
12. documented residual risk and milestone availability.

Milestone A operations must remain pure and fixture-backed. They may return a
patch proposal or other candidate artifact, but they may not read/write the OS
filesystem, invoke Git, spawn a process, use the network, or consume a secret.

## Driver, Provider, and Credential Rules

The generic `AgentDriver` receives only mediated context, advertised operations,
and agent-safe observations. Provider-specific request fields, SDK objects,
credential bytes, and transport errors stay in adapter packages.

Milestone A contains deterministic scripted/synthetic adapters only. A new real
provider or external-agent integration belongs to its planned milestone and
must include capability negotiation, conformance fixtures, failure certainty,
budget accounting, secret leak canaries, and an honest compatibility tier.
Never put a real credential in source, CLI arguments, fixtures, events, logs,
snapshots, screenshots, issue text, or pull-request output.

## CLI Rules

CLI parsing and rendering are application concerns. The CLI may select a
profile, invoke the host or daemon client appropriate to its milestone, and
render events/results. It must not decide policy, call capability handlers
directly, expose raw results, or invent state absent from recorded events.

Every flag requires strict parsing, help text, conflict/unknown-option tests,
stable output tests, and an intentional exit code. Credential/provider/agent
flags must fail closed until the responsible adapters and secret boundary are
implemented.

## Dependency Changes

The current direct external runtime dependencies are exact-pinned
`uuid@14.0.2` and `ajv@8.20.0`, each isolated behind one reviewed boundary. A
new dependency requires a written review covering purpose, exact version,
license, transitives, lifecycle scripts, native/download behavior,
vulnerability state, data/credential exposure, deterministic-test impact, and
removal difficulty. Commit the resulting lockfile change and keep install
scripts disabled unless the review explicitly justifies one.

## Documentation

Repository documentation is tested. Keep local links valid, fences balanced,
files newline-terminated, and trailing whitespace absent. Use present tense
only for behavior backed by current code and tests. Label later milestone work
as planned and list the current limitation next to any design target that could
otherwise be read as a guarantee.

## Commit Style

Use focused conventional commits with imperative subjects, for example:

```text
feat(runtime): reject reused action identities
test(event-store): cover atomic oversized batch rejection
docs(events): describe v1 causation rules
```

Keep generated output, credentials, local databases, coverage artifacts, and
private fixtures out of commits. Preserve unrelated work in a dirty tree.

## Pull Requests

Describe:

- behavior and claim surface changed;
- enforcement point and package dependency direction;
- failure, cancellation, budget, replay, and recovery semantics;
- tests added and exact commands run;
- schema/event/golden compatibility impact;
- new dependency or credential exposure, if any;
- residual risk and deferred follow-up milestone.

Security fixes must include the smallest reproducible regression fixture that
demonstrates the former bypass without exposing private data. A change is not
ready while required checks are red or current documentation overstates the
evidence.
