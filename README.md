# Guarded Agent

Guarded Agent is a general policy-enforced agent runtime. An interchangeable model or external agent may propose context reads and actions, but deterministic local systems decide what it may see, what may execute, whether approval is required, and how every action is recorded and recovered. Coding is the first reference capability pack and flagship demo, not the runtime's product boundary.

The project is CLI-first. A VS Code extension will become a client of the same local daemon after the runtime, policy boundary, sandbox, recovery model, and evaluation suite are independently useful.

## Current Status

The repository is at the start of Phase 1 (Milestone A). The product blueprint and implementation mechanics are specified, and the first kernel package, `@guard/contracts`, provides branded identifiers, the canonical domain-error taxonomy, and canonical JSON serialization with hashing, all covered by unit tests. All security and durability guarantees remain unimplemented design targets until their milestone evidence passes. Implementation continues with a deterministic scripted-driver and synthetic-provider vertical slice; a real model or external agent is intentionally deferred until the runtime can be tested without model variance.

## Documentation

- [Full build plan](docs/BUILD_PLAN.md)
- [Critical plan review](docs/PLAN_REVIEW.md)
- [Deep plan audit and resolution register](docs/DEEP_AUDIT.md)
- [General multi-agent and multi-model runtime architecture](docs/GENERAL_RUNTIME_ARCHITECTURE.md)
- [Provider, API-key, and external-agent compatibility](docs/PROVIDER_AGENT_COMPATIBILITY.md)
- [Detailed implementation guide](docs/IMPLEMENTATION_GUIDE.md)
- [Installation, testing, operations, and release plan](docs/OPERATIONS_TEST_PLAN.md)
- [Product requirements and user flows](docs/PRODUCT_REQUIREMENTS.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Glossary](docs/GLOSSARY.md)
- [Open questions and deferred decisions](docs/OPEN_QUESTIONS.md)
- [Architecture decision records](docs/decisions/)
- [Documentation index](docs/README.md)

## Intended Guarantees

- An agent or model never executes guarded capabilities directly.
- Context and capability output cross a deterministic policy boundary before reaching an agent or model.
- Consequential actions bind approvals to normalized arguments and observed execution state.
- Coding-profile changes occur through trusted checkpoints in a detached Git worktree rather than the original checkout.
- Untrusted processes run from disposable snapshots in a constrained container with network disabled by default.
- Append-only events support audit, replay, and crash recovery without replaying effects.
- Deterministic adversarial evaluations verify security and durability claims.

These are design targets until the corresponding milestone and tests are implemented. Repository documentation distinguishes implemented behavior from planned behavior.

## Development Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Git
- PostgreSQL 17 when the durability milestone begins
- Docker or Podman when the sandbox milestone begins
- A key for the selected hosted provider only when that adapter is exercised; scripted and local no-credential profiles require none

## Repository Check

The repository has no runtime dependencies; TypeScript and Node type definitions are the only development dependencies. Validate the documentation and all package tests with:

```bash
npm ci
npm test
```

## Planned Build Order

1. Generic task-profile/runtime contracts, scripted driver, synthetic provider, and in-memory event store
2. Policy language, evaluator, traces, and simulator
3. Generic context and capability gateways plus the coding reference pack
4. Git worktrees and container sandbox for coding operations
5. Direct-model driver, BYOK credential broker, and first hosted/local provider paths
6. PostgreSQL, minimal daemon, approvals, leases, encrypted evidence, and recovery
7. Evaluation control plane, local-corpus research profile, and release-quality CLI
8. Anthropic, Gemini, compatible/local endpoints, ACP, MCP, and contained CLI-agent compatibility
9. Multi-client daemon hardening and VS Code extension as a coding-focused client

## License

[MIT](LICENSE)
