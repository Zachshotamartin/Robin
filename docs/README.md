# Robin Documentation Index

Robin is a coding-agent CLI for terminal-based repository work. The event,
policy, context, and capability runtime in this repository is an internal
substrate for that product, not the product definition.

The root [README](../README.md) is the quick start and current implementation
snapshot. It distinguishes the intended interactive and resumable Robin
experience from the accepted Milestones A/B substrate and the in-progress,
ephemeral R1 synthetic conversation preview.

## Product-First Source of Truth

Read these documents first and in this order:

1. [Product requirements and user flows](PRODUCT_REQUIREMENTS.md) defines
   Robin's users, coding workflows, functional and non-functional requirements,
   CLI semantics, session behavior, provider/BYOK contract, permission model,
   release tiers, and acceptance criteria.
2. [Full Robin build plan](BUILD_PLAN.md) defines implementation order,
   component delivery, test-first tickets, dependency gates, release evidence,
   and the boundary between current and planned behavior.
3. [Robin CLI architecture](ROBIN_CLI_ARCHITECTURE.md) defines the terminal
   application, session services, direct-model loop, provider stream, coding
   tools, permission integration, persistence, configuration, and future client
   protocol at implementation depth.
4. [ADR-0007: Make Robin a coding-agent CLI product](decisions/ADR-0007-robin-coding-agent-product-pivot.md)
   records the accepted pivot from a runtime-first plan to a product-first
   coding-agent CLI and governs conflicts with pre-pivot documents.

Together these four documents define what Robin is and what gets built next.
The internal control layer must support their user journeys; it does not
override their product hierarchy.

## Implemented Milestones A and B

These references describe behavior that exists and is covered by deterministic
tests on the current branch:

- [Event Model v1](event-model.md): event envelopes, identifiers, ordering,
  causation, reducer lifecycle, legal intents, command planning, replay, schema
  evolution, and current in-memory limits.
- [Policy Language v1](policy-language.md): `.guard` grammar, canonical
  formatting, attribute catalogs, three-valued evaluation, decision precedence,
  safe traces, case corpora, simulation, CLI commands, and current limitations.

The implemented CLI exposes an early line-oriented `robin` conversation using a
credential-free synthetic provider, `robin -p` text/JSON/stream-JSON output,
`robin run` for the fixed `synthetic-demo` and `coding-virtual` profiles, and
`robin policy`. The preview is ephemeral and has no repository, process, Git,
credential, or network tools. It does not expose provider API access, API-key
onboarding, durable sessions, command execution, or resume. Planned documents
may specify those features only as planned until their evidence gates pass.

## Product Supporting Specifications

- [Provider, credential, and external-agent compatibility](PROVIDER_AGENT_COMPATIBILITY.md):
  direct provider adapters, declared model capabilities, bring-your-own
  credentials, local and compatible endpoints, MCP, ACP, external agents, and
  guarantee tiers. Support requires a conformant adapter; an arbitrary API key
  or executable is not automatically compatible.
- [Installation, testing, operations, and release plan](OPERATIONS_TEST_PLAN.md):
  developer setup, test policy, CI, packaging, clean-machine verification,
  upgrades, rollback, retention, diagnostics, requirement evidence, and release
  gates. It controls verification mechanics while following the Build Plan's
  release ownership and the Architecture's contracts.
- [Implementation guide](IMPLEMENTATION_GUIDE.md): algorithms, schemas,
  transactions, adapters, and test mechanics inherited from the original plan.
  Reuse is selective and must follow the Robin build order.
- [Threat model](THREAT_MODEL.md): assets, actors, trust boundaries, abuse
  cases, controls, evidence, and residual risk. Product-facing claims must still
  distinguish permission decisions, command sandboxing, and whole-process
  isolation.
- [Glossary](GLOSSARY.md): controlled definitions. Legacy `Guard` names remain
  only where they identify existing internal packages, schemas, fixtures, or
  the `.guard` policy language.
- [Open questions](OPEN_QUESTIONS.md): deferred decisions, fail-closed default
  positions, and reopen triggers. Product-order questions are controlled by
  ADR-0007 and the Robin source-of-truth documents.

## Architecture Decisions

- [Decision record directory](decisions/) contains accepted and proposed ADRs.
- [ADR template](decisions/TEMPLATE.md) defines the required decision-record
  structure.
- Product identity, build order, CLI-first delivery, and editor sequencing are
  governed by [ADR-0007](decisions/ADR-0007-robin-coding-agent-product-pivot.md).
- Existing ADRs for UUIDv7, schema validation, policy catalogs, path matching,
  and repository authorization remain valid for the inherited substrate unless
  a later ADR explicitly supersedes them.

## Pre-Pivot and Archived References

The following documents remain useful for implementation ideas, prior risk
analysis, and historical rationale. They no longer define Robin's primary
product or milestone order:

- [General runtime architecture](GENERAL_RUNTIME_ARCHITECTURE.md) describes the
  earlier general-agent/control-plane framing. Treat its reusable ports and
  boundaries as internal design input, not as Robin's product definition.
- [Plan review](PLAN_REVIEW.md) critiques the original runtime-first build plan.
  Its unresolved findings remain evidence inputs where they still apply.
- [Deep plan audit](DEEP_AUDIT.md) records pre-pivot contradictions, security
  gaps, and resolution history. Revalidate each item against the Robin product
  architecture before carrying it forward.

The unfinished runtime-first Milestone C implementation is checkpointed on the
`milestone/c-isolated-filesystem-execution` branch. It is archived WIP, not a
release, not evidence for current claims, and not a merge source. Individual
pieces require new tests and review against Robin's coding-agent journeys before
reuse.

## Conflict and Status Rules

When documents disagree:

1. an accepted ADR controls the decision it explicitly records;
2. `PRODUCT_REQUIREMENTS.md` controls user-visible semantics and acceptance;
3. `BUILD_PLAN.md` controls implementation order and gates;
4. `ROBIN_CLI_ARCHITECTURE.md` controls current target component boundaries;
5. `PROVIDER_AGENT_COMPATIBILITY.md` controls provider, credential, model, and
   external-agent conformance details that do not conflict with items 1–4;
6. `OPERATIONS_TEST_PLAN.md` controls test, evidence, packaging, install, and
   release mechanics that do not conflict with items 1–5;
7. implemented code and passing tests control claims about what works today;
8. pre-pivot documents are non-normative where they conflict with the sources
   above.

Documentation must follow these rules:

- Label planned behavior as planned until its named tests and evidence pass.
- Identify the milestone or release gate behind every implementation claim.
- Never promote in-memory evidence into a durability, session-resume, sandbox,
  provider, approval, or production-isolation guarantee.
- Never imply arbitrary model, endpoint, API key, or external-agent
  compatibility without a supported adapter and declared conformance tier.
- Keep public commands and examples on the `robin` binary. Historical `guard`
  names are limited to internal identifiers and explicitly historical text.
- Bind security claims to a named enforcement point and adversarial evidence.
- Version CLI, session, provider, tool, policy, event, credential-metadata,
  configuration, persistence, protocol, and extension contracts before public
  compatibility promises.
- Record a product or architecture reversal in a new ADR instead of silently
  editing away the earlier decision.
