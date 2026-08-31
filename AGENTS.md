# Repository Instructions

## Product Boundary

Robin is a coding-agent CLI, not a general runtime product. The primary user
flow is an interactive, persistent terminal conversation that inspects and edits
the current repository, runs development commands, verifies work, and supports
Git review through a provider-flexible model loop. The policy/event/context
runtime is internal infrastructure and must be integrated in service of that
flow rather than exposed as the default mental model.

Robin treats models, repository content, tool arguments, tool output, project
configuration, hooks, and extensions as untrusted. Enforcement belongs in the
context boundary, permission engine, approval service, tool dispatcher,
workspace/process adapters, and session application. A UI or prompt must never
be treated as an enforcement boundary.

## Architecture

- Domain packages define ports and must not import adapters.
- Normalize untrusted input once, evaluate the normalized value, and execute that exact value.
- Reducers and policy evaluation remain deterministic and free of I/O.
- Replay applies events to state and never performs effects.
- Every event and boundary schema is explicitly versioned.
- Consequential actions require a recorded policy decision.
- Unknown boundary input fails closed.
- Interactive and headless modes call the same coding-session and agent-loop
  services.
- Provider-specific request/response types stop at the provider adapter.
- A coding session contains multiple user turns; one runtime run is not the
  product-level session.
- Direct workspace edits bind an exact preimage and preserve unrelated or newer
  user changes.

## Implementation Sequence

Follow `docs/PRODUCT_REQUIREMENTS.md`, `docs/ROBIN_CLI_ARCHITECTURE.md`, and
`docs/BUILD_PLAN.md`. Complete the interactive synthetic-provider coding slice,
then real repository tools and local session resume, before adding a real
provider. Complete the direct-model CLI, provider conformance, and daily Git
workflow before building a VS Code client. Do not resume the old runtime-first
Milestone C branch wholesale.

## Dependencies

Do not add an agent framework, workflow engine, authorization engine, terminal
framework, or ORM when the bounded Robin component can reasonably be built and
tested in this repository. Narrow libraries for transport, OS credential access,
Unicode terminal width, platform sandbox integration, JSON Schema validation,
parsing, or testing require documented justification. Database libraries are
out of the local CLI path and require a separate decision for an optional
future service. Never invent cryptography, TLS, credential storage, or process
isolation.

## Verification

Run `npm test` before committing documentation changes. The root `check`
command must cover repository guards, type checking, unit tests, integration
tests, CLI tests, and deterministic evals. Interactive changes require PTY or
terminal-double evidence; workspace changes require real temporary Git
repositories; provider changes require the shared synthetic transport suite.

## Security

- Never commit provider keys, credentials, real secrets, or captured private source code.
- Never pass host credentials into sandboxes.
- Prefer structured executable-and-argument process requests. A raw shell tool,
  if later shipped, is a separate high-risk operation with exact display and
  permission.
- In visible-workspace mode, mutate only through exact-preimage operations,
  inventory pre-existing dirty state, and never overwrite or discard unrelated
  or subsequent user edits.
- In isolated mode, delete only worktrees whose ownership Robin can prove.
- Every discovered bypass becomes a permanent minimal regression fixture.
