# Guarded Agent: Open Questions and Deferred Decisions

A forward-looking register of decisions the plan intentionally defers. Each entry names its current fail-closed position and the concrete trigger that reopens it. Closing an entry requires an ADR under `docs/decisions/` and, where marked, new threat-model and test coverage. This register complements the [deep audit](./DEEP_AUDIT.md), which records resolved findings.

| ID | Question | Current position | Reopen trigger |
|---|---|---|---|
| OQ-01 | Networked dependency installation and general egress | Denied; only offline installs from verified prepopulated inputs (DA-018) | Design of the policy-enforcing egress proxy with its own threat model and destination/method/byte/audit policy |
| OQ-02 | Runtime regular expressions in the policy language | Not in v1; `matches` is a compiled anchored glob (DA-011) | A recorded policy need that globs cannot express, plus complexity and ReDoS bounds |
| OQ-03 | Concurrent multi-agent coordination | One active driver per run; coordination explicitly deferred (DA-067) | A coordinator contract covering identities, context sharing, delegation schema, budgets, causality, approvals, and recovery |
| OQ-04 | Cross-machine backup restore and key recovery | Same-user, same-machine restore only; key IDs verified in restore preflight (DA-055) | A reviewed key-wrapping and recovery design with wrong-key and rotation-interruption tests |
| OQ-05 | Release signing identity and process | Deferred until publishing begins (DA-045) | First signed release: define key ownership, protected signing environment, rotation, revocation, and compromise runbook |
| OQ-06 | Public launch timing, package naming, and trademark review | Repository may stay private through early milestones; MIT license accepted in ADR-0001 (DA-050) | Before the first public release or package publication |
| OQ-07 | Windows support | Out of scope for v1 | Post-v1 demand; requires named-pipe transport, path/filesystem semantics review, and CI coverage |
| OQ-08 | Embedded database adapter for easier installation | PostgreSQL is the only v1 store | Post-portfolio-release installability work; must not weaken queue and locking semantics |
| OQ-09 | Parallel consequential actions | Serialized in v1; unexpected batches fail closed | A deliberate design for causal ordering, overlapping effects, approvals, leases, and rollback |
| OQ-10 | Code-OSS fork | Not planned; extension APIs first (Plan-review Gate E) | A documented high-value workflow provably impossible through stable VS Code extension APIs |
| OQ-11 | Browser, data-analysis, and operations capability packs | Deferred pack sketches only | Each pack requires its own threat-model section, policy attributes, sandbox profile, and adversarial suite before installation |
| OQ-12 | Hosted or remote-agent execution mode | Local-only daemon; hosted agents limited to Tier B/D adapters | Any remote deployment; requires new identity, transport-security, and multi-user threat modeling |
| OQ-13 | Isolated runner infrastructure for hostile container tests | Required by policy (DA-039) but not yet provisioned | Before the sandbox milestone's escape-regression suite first runs in CI |
| OQ-14 | Rename detection semantics in diffs and patch policy | Disabled for stable path accounting | A policy design that gives renames explicit semantics in path rules and approvals |

Review this register at every phase boundary; an entry may not be silently implemented ahead of its trigger.
