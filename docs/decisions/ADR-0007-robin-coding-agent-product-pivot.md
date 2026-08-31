# ADR-0007: Make Robin a coding-agent CLI product

- Status: accepted
- Date: 2026-08-30

## Context

The original plan described the product as a general policy-enforced agent
runtime. Its build order placed a release-quality command-line experience after
the policy language, context boundary, filesystem isolation, provider layer,
durability service, approvals, and evaluation system. At the time of this
decision, the implemented CLI therefore exposed only fixed deterministic
runtime fixtures and the policy debugger; it did not yet behave as a coding
agent. The later ephemeral R1 preview is progress under this decision, not part
of its historical premise.

That ordering does not match the intended product. The user wants a terminal
coding agent in the same product category as Claude Code: a developer starts it
inside a repository, talks to it, lets it inspect and change code, runs commands
and tests through it, reviews its work, and resumes the session later. The
control layer is still valuable, but it is an implementation subsystem that
makes Robin's coding tools safer and more explainable. It is not the primary
user journey or the main product claim.

The repository was renamed from Guarded Agent to Robin. Unfinished Milestone C
work was preserved on its own branch and its draft pull request was closed
rather than merged into the new product branch.

## Decision

Robin is a local-first, provider-flexible coding-agent CLI. The executable is
`robin`. With no subcommand it starts an interactive repository session; with a
prompt it starts the same session with initial work; with `--print` it runs the
same agent loop non-interactively. The first product milestones deliver a
coherent vertical slice of that experience before deepening the internal
control plane.

The product hierarchy is:

1. terminal conversation and clear progress;
2. repository understanding, code edits, command execution, verification, and
   Git-aware review;
3. resumable sessions, configuration, model/provider selection, and bring-your-
   own credentials;
4. explicit permissions and trustworthy approval UX;
5. extensibility through instructions, skills, hooks, MCP, and subagents;
6. optional stronger isolation, durable background work, editor clients, and
   enterprise policy.

The existing event kernel, policy engine, context broker, capability gateway,
and deterministic fixtures remain internal building blocks and test evidence.
They are integrated only when a Robin user journey needs them. Internal
`@guard/*` workspace names, protocol identifiers, `.guard` policy files, and
historical fixtures remain unchanged during the initial pivot so that semantic
product work is not mixed with a risky fixture-breaking namespace migration.
They may be migrated later through a separate, versioned ADR.

The initial direct-model architecture is provider-neutral, but Robin will make
bounded, testable compatibility claims. A provider or model is supported when
an installed adapter can authenticate, negotiate required capabilities,
normalize streaming output and tool calls, classify errors, and pass the
conformance suite. An arbitrary API key or agent executable does not become
compatible merely because it can be entered into configuration.

## Alternatives Considered

### Keep the runtime as the product and add a better CLI late

Rejected because it optimizes internal infrastructure before validating the
developer workflow. It would keep producing a control-plane demo rather than a
useful coding tool.

### Build a VS Code fork first

Rejected for the initial release because a Code-OSS fork adds editor update,
extension compatibility, distribution, signing, and security responsibilities
before the agent loop is proven. A later editor client will consume Robin's
stable session/tool protocol instead of owning a second agent engine.

### Wrap another coding-agent binary

Rejected as the core implementation because it would hide the agent loop,
provider abstraction, tool semantics, session model, and permission boundary
that this portfolio project is intended to demonstrate. External agents may be
optional adapters later.

### Delete the existing runtime substrate and restart

Rejected because Milestones A and B contain useful, tested primitives. The
problem is product ordering and boundaries, not the existence of those
components.

## Consequences

- Product requirements, README content, architecture, build order, tests, and
  release gates must be rewritten around coding-agent user journeys.
- The first usable release must support real repositories and a real provider;
  deterministic scenarios remain development fixtures rather than the main
  demo.
- Interactive and headless operation must share one agent loop so behavior does
  not diverge across surfaces.
- Local session storage and repository UX take priority over PostgreSQL and a
  daemon. Remote/background durability is a later capability.
- Policy commands remain available as an advanced subsystem, but default
  onboarding does not require users to understand a policy language.
- Security claims must distinguish client-side permission checks, command
  sandboxing, and whole-process isolation.
- A future VS Code extension or fork is a client of the Robin engine after its
  protocol and session semantics are stable.
- The archived Milestone C branch is reference material, not a merge source;
  individual pieces require fresh review and tests before reuse.
