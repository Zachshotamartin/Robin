# Documentation Index

## Implemented Reference

- [Event Model v1](event-model.md): envelope fields, identifiers,
  ordering, causation, event inventory, reducer lifecycle, legal intents,
  command flow, replay behavior, schema evolution plan, and current in-memory
  limits
- [Policy Language v1](policy-language.md): Guard grammar, canonical formatting,
  attribute catalogs, three-valued semantics, precedence, safe traces, case
  corpora, simulation, CLI use, and Milestone B limitations

The repository root [README](../README.md) is the current implementation and
quick-start snapshot. Milestone B is implemented; Milestones C through H remain
planned until their evidence gates pass.

## Source of Truth

- [Build plan](BUILD_PLAN.md): product definition, architecture, scope, milestones, and definition of done
- [Plan review](PLAN_REVIEW.md): architectural critique, corrections, risks, and go/no-go gates
- [Deep plan audit](DEEP_AUDIT.md): cross-document contradictions, security-critical gaps, resolutions, and evidence gates
- [General runtime architecture](GENERAL_RUNTIME_ARCHITECTURE.md): agent drivers, model types, context sources, capability packs, task profiles, and coding as a reference pack
- [Provider and agent compatibility](PROVIDER_AGENT_COMPATIBILITY.md): direct model adapters, bring-your-own credentials, MCP, ACP, external agents, and guarantee tiers
- [Implementation guide](IMPLEMENTATION_GUIDE.md): algorithms, schemas, transactions, adapters, testing, and milestone mechanics
- [Operations and test plan](OPERATIONS_TEST_PLAN.md): installation, testing policy, CI, packaging, upgrades, rollback, retention, and release gates
- [Product requirements](PRODUCT_REQUIREMENTS.md): users, functional requirements, flows, error behavior, and non-functional requirements
- [Threat model](THREAT_MODEL.md): assets, actors, boundaries, abuse cases, controls, evidence, and residual risk

## Supporting References

- [Glossary](GLOSSARY.md): canonical definitions for the controlled vocabulary; conflicts are fixed, not locally redefined
- [Open questions](OPEN_QUESTIONS.md): deferred decisions, their fail-closed positions, and reopen triggers
- [Decision records](decisions/): accepted ADRs and the [template](decisions/TEMPLATE.md) for new ones

## Documentation Rules

- Planned behavior must be labeled as planned until tests demonstrate it.
- Current implementation claims must identify their milestone and must not
  promote in-memory evidence into a durability, sandbox, approval, provider, or
  daemon guarantee.
- Security guarantees require a named enforcement point and adversarial evidence.
- Task-profile, driver, model, source, capability, credential-metadata, event, policy, configuration, protocol, and RPC formats are versioned before release.
- Architecture decisions that reverse an accepted plan choice receive an ADR under `docs/decisions/`.
