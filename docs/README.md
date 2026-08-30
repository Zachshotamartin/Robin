# Documentation Index

## Source of Truth

- [Build plan](BUILD_PLAN.md): product definition, architecture, scope, milestones, and definition of done
- [Plan review](PLAN_REVIEW.md): architectural critique, corrections, risks, and go/no-go gates
- [Implementation guide](IMPLEMENTATION_GUIDE.md): algorithms, schemas, transactions, adapters, testing, and milestone mechanics
- [Operations and test plan](OPERATIONS_TEST_PLAN.md): installation, testing policy, CI, packaging, upgrades, rollback, retention, and release gates
- [Product requirements](PRODUCT_REQUIREMENTS.md): users, functional requirements, flows, error behavior, and non-functional requirements
- [Threat model](THREAT_MODEL.md): assets, actors, boundaries, abuse cases, controls, evidence, and residual risk

## Documentation Rules

- Planned behavior must be labeled as planned until tests demonstrate it.
- Security guarantees require a named enforcement point and adversarial evidence.
- Event, policy, tool, configuration, and RPC formats are versioned before release.
- Architecture decisions that reverse an accepted plan choice receive an ADR under `docs/decisions/`.
