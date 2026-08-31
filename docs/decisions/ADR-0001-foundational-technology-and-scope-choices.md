# ADR-0001: Foundational Technology and Scope Choices

- Status: superseded by ADR-0007
- Date: 2026-08-30
- Related findings or requirements: DA-050 (partially), DA-057, DA-058, PLAN_REVIEW corrections 1, 2, 6, 7, 10

## Context

The planning documents settled a set of foundational choices before
implementation. Those choices were distributed across the build plan, plan
review, and deep audit but were never recorded as explicit decisions with
alternatives. ADR-0007 later reversed the product shape, local persistence,
default workspace, provider-transport preference, and sequencing as a coherent
coding-agent CLI pivot. The language/runtime, narrow-dependency discipline,
policy-language implementation, and MIT license decisions remain applicable
through the newer documents.

## Decision

1. **Language and runtime:** TypeScript on Node.js 22+ with npm workspaces and strict project references.
2. **Persistence:** PostgreSQL 17 with handwritten SQL migrations and queries; no ORM. An embedded-store adapter may improve installability later without replacing the main implementation.
3. **Local transport:** JSON-RPC 2.0 over an owner-only Unix domain socket with OS peer-credential verification.
4. **Isolation:** Docker first, Podman adapter second; detached Git worktrees with trusted host-side patch application and disposable execution snapshots.
5. **Narrow dependencies only:** official provider SDKs as transport, Ajv for JSON Schema validation, a maintained UUID/ULID generator, the PostgreSQL driver, and OS credential-store bindings. No agent framework, workflow engine, policy engine, job queue, or ORM in v1.
6. **Policy language:** a custom `.guard` language with handwritten lexer, Pratt parser, three-valued evaluator, deny-overrides combination, and deterministic traces.
7. **Product shape:** CLI-first general agent runtime; coding is the first reference capability pack and local-corpus research is the generality proof; the VS Code extension is a later client of the same daemon.
8. **Sequencing:** deterministic scripted driver and synthetic provider before any real model; PostgreSQL and the minimal daemon arrive with the durability milestone rather than the first vertical slice.
9. **License:** MIT, already published in the repository.

## Alternatives Considered

- SQLite-first persistence: simpler installation but weaker concurrent-worker, row-locking, and queue semantics for the durability story the project must demonstrate.
- Existing policy engines (OPA, Cedar, Casbin): would outsource the differentiating subsystem the project exists to demonstrate.
- Agent/workflow frameworks (LangChain, Agents SDKs, Temporal, BullMQ): same objection; they replace the thesis.
- Handwritten provider transport and validators: rejected by the plan review as avoidable boundary-bug surface unrelated to the differentiating work.
- Editor-first delivery: rejected because a CLI forces the runtime to work without editor shortcuts and keeps enforcement observable in CI.

## Consequences

- Installation requires PostgreSQL and Docker for the durability and sandbox milestones; the deterministic MVP intentionally requires neither.
- Provider SDK majors and PostgreSQL majors become tracked compatibility surfaces.
- Any future adoption of an excluded framework, a different database, or a non-CLI-first ordering requires a superseding ADR.
- Public launch timing, package naming, and trademark review remain open and are tracked in [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md) until their own decision records exist (DA-050).
