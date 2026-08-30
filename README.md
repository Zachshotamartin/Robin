# Guarded Agent

Guarded Agent is a policy-enforced coding-agent runtime. A model may propose context reads and tool calls, but deterministic local systems decide what the model may see, what may execute, whether approval is required, and how every action is recorded and recovered.

The project is CLI-first. A VS Code extension will become a client of the same local daemon after the runtime, policy boundary, sandbox, recovery model, and evaluation suite are independently useful.

## Current Status

The repository is at the reviewed design and bootstrap stage. The product blueprint, critical review, and detailed implementation mechanics are complete. Implementation begins with a deterministic fake-provider vertical slice; a real model is intentionally deferred until the runtime can be tested without model variance.

## Documentation

- [Full build plan](docs/BUILD_PLAN.md)
- [Critical plan review](docs/PLAN_REVIEW.md)
- [Detailed implementation guide](docs/IMPLEMENTATION_GUIDE.md)
- [Installation, testing, operations, and release plan](docs/OPERATIONS_TEST_PLAN.md)
- [Product requirements and user flows](docs/PRODUCT_REQUIREMENTS.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Documentation index](docs/README.md)

## Intended Guarantees

- The model never executes tools directly.
- Context and tool output cross a deterministic policy boundary before reaching the model.
- Consequential actions bind approvals to normalized arguments and observed execution state.
- Agent changes occur in disposable Git worktrees rather than the original checkout.
- Untrusted processes run in a constrained container with network disabled by default.
- Append-only events support audit, replay, and crash recovery without replaying effects.
- Deterministic adversarial evaluations verify security and durability claims.

These are design targets until the corresponding milestone and tests are implemented. Repository documentation distinguishes implemented behavior from planned behavior.

## Development Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Git
- PostgreSQL 17 when the durability milestone begins
- Docker or Podman when the sandbox milestone begins
- An OpenAI API key only when the real-provider milestone begins

## Repository Check

The bootstrap repository has no runtime dependencies. Validate the documentation foundation with:

```bash
npm test
```

## Planned Build Order

1. Deterministic runtime kernel with an in-memory event store
2. Policy language, evaluator, traces, and simulator
3. Context broker and guarded repository tools
4. Git worktrees and container sandbox
5. Real model provider adapter
6. PostgreSQL workers, approvals, leases, and recovery
7. Evaluation control plane and release-quality CLI
8. Local daemon and VS Code extension

## License

[MIT](LICENSE)
