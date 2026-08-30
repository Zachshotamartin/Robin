# Repository Instructions

## Product Boundary

Guarded Agent treats models, repository content, tool arguments, and tool output as untrusted. Enforcement belongs in the context broker, policy engine, approval service, tool gateway, sandbox manager, and durable runtime. A UI or prompt must never be treated as an enforcement boundary.

## Architecture

- Domain packages define ports and must not import adapters.
- Normalize untrusted input once, evaluate the normalized value, and execute that exact value.
- Reducers and policy evaluation remain deterministic and free of I/O.
- Replay applies events to state and never performs effects.
- Every event and boundary schema is explicitly versioned.
- Consequential actions require a recorded policy decision.
- Unknown boundary input fails closed.

## Implementation Sequence

Follow `docs/BUILD_PLAN.md` and `docs/IMPLEMENTATION_GUIDE.md`. Complete the fake-provider vertical slice before adding a real provider. Complete CLI v1 before building the VS Code client.

## Dependencies

Do not add an agent framework, workflow engine, authorization engine, or ORM. Narrow libraries for transport, database access, JSON Schema validation, parsing utilities, and testing require a documented justification. Never invent cryptography or process isolation.

## Verification

Run `npm test` before committing documentation changes. Once implementation packages exist, the root `check` command must cover formatting, type checking, unit tests, integration tests, and deterministic evals.

## Security

- Never commit provider keys, credentials, real secrets, or captured private source code.
- Never pass host credentials into sandboxes.
- Never execute model-provided shell strings.
- Never mutate a user's original checkout during an agent run.
- Every discovered bypass becomes a permanent minimal regression fixture.
