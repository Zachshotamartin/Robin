# Robin Handoff

## Product Direction

Robin is a provider-flexible coding-agent CLI in the product category of Claude
Code. The default experience is a persistent terminal conversation inside a
repository: Robin understands code, invokes repository tools, edits files, runs
development commands, verifies the result, and supports Git review. The policy,
context, event, gateway, and isolation components are internal infrastructure;
they are not the product center.

The pivot is recorded in
[ADR-0007](docs/decisions/ADR-0007-robin-coding-agent-product-pivot.md).
Normative direction lives in:

- [Product Requirements](docs/PRODUCT_REQUIREMENTS.md)
- [Robin CLI Architecture](docs/ROBIN_CLI_ARCHITECTURE.md)
- [Build Plan](docs/BUILD_PLAN.md)
- [Provider Compatibility](docs/PROVIDER_AGENT_COMPATIBILITY.md)
- [Operations and Test Plan](docs/OPERATIONS_TEST_PLAN.md)

## Repository and Git State

- Local repository: `/Users/zacharymartin/Desktop/portfolio_projects/Robin`
- GitHub repository: `https://github.com/Zachshotamartin/Robin`
- Visibility: private
- Origin: `https://github.com/Zachshotamartin/Robin.git`
- Active pivot branch: `codex/robin-cli-pivot`
- Pivot base: main commit `77902fd`, the green Milestone B baseline
- Superseded draft pull request: #1, closed with an archival explanation

The unfinished Milestone C runtime prototype is preserved on
`milestone/c-isolated-filesystem-execution` at commit `4743044`. Its audit is
`docs/MILESTONE_C_WIP_AUDIT.md` on that branch. It has known artifact-store,
worktree, gateway, and lockfile defects and must not be merged wholesale.
Review and port individual pieces only when a Robin coding-agent vertical slice
needs them.

## Implemented Baseline

Milestones A and B remain complete for their narrow claims:

- strict generic contracts and UUIDv7 identifiers;
- a deterministic pure run kernel and replay;
- an in-memory event store;
- scripted agent and synthetic provider test ports;
- a handwritten `.guard` policy language and deterministic policy engine;
- a bounded context broker;
- virtual and contained-read repository capabilities;
- a policy-mediated capability gateway;
- deterministic synthetic and virtual-coding histories;
- policy, context, canary, replay, mutation, packaging, and repository tests.

This baseline is internal substrate. The pivot branch additionally provides an
early ephemeral multi-turn synthetic session and headless output path. It does
not yet provide real workspace mutation, process execution, local session
resume, live provider/API-key use, Git write tools, MCP client, hooks, skills,
subagents, a daemon, or an editor client.

## Pivot Work on the Active Branch

The active branch contains or is expected to contain:

- the public repository and executable identity `Robin` / `robin`;
- root package name `robin`;
- CLI package `@zachshotamartin/robin`, private until publication ownership and
  packaging are explicitly verified;
- an executable-bit packaging regression for the compiled binary;
- `packages/robin-agent`, a provider-neutral text-only multi-turn loop plus a
  deterministic no-I/O preview provider;
- `packages/robin-application`, the shared ephemeral session application path;
- `robin`, `robin "prompt"`, and `robin -p` preview modes with text, JSON, and
  stream-JSON rendering, terminal-control sanitization, and offline package
  installation coverage;
- rewritten coding-agent-first requirements, architecture, build plan, README,
  documentation index, compatibility plan, and repository instructions;
- internal `@guard/*` workspace names and `.guard` policy syntax preserved
  temporarily to avoid invalidating deterministic fixtures during the product
  pivot.

Before publishing an npm package, verify ownership of the chosen scope and
global executable collision behavior. The unscoped `robin` and `robin-cli`
package names are not assumed available.

## Immediate Implementation Sequence

1. Finish and verify the R0 documentation/identity pivot and initial R1 preview
   slice.
2. Push `codex/robin-cli-pivot` and open a new truthful draft pull request.
3. Complete R1 with the versioned application-event/reducer model, deterministic
   synthetic tool calls, queued input, signal cancellation, raw terminal input,
   renderer state, PTY restoration tests, and terminal compatibility evidence.
4. Complete R2 repository understanding and bounded workspace mutation in
   temporary Git fixtures: status, list/search/read, diff, exact-preimage apply,
   create, structured direct process execution, focused verification, and final
   status/diff. Register but deny delete, move, shell, network, and Git writes;
   disclose that R2 has manual approval but no strict sandbox guarantee.
5. Complete R3 local durable sessions, recovery, continue, and resume on the
   R2 tool path.
6. Complete R4 with one hosted direct provider and session-scoped BYOK
   onboarding after the semantic loop and repository tools are provider-neutral.
7. Complete R5 persistent permission modes/rules, approvals, explicit shell,
   strict sandbox backends, stronger process limits, and cancellation evidence;
   then R6 batch/delete/move, checkpoints, rewind, and daily Git workflow.
8. Continue through provider breadth and stable automation in R7,
   configuration/trust/instructions in R8, and the remaining post-1.0 gates in
   `docs/BUILD_PLAN.md`.

## Required Verification

Run from the repository root:

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm run test:gate:b
git diff --check
```

Interactive work additionally requires PTY or terminal-double tests. Workspace
work requires real temporary Git repositories, dirty-state preservation,
symlink/path traversal, stale-preimage, cancellation, and process-tree tests.
Provider work requires synthetic-server conformance and credential-canary scans.

## Rules That Must Survive the Pivot

- Do not claim planned coding-agent behavior is already implemented.
- Do not expose or accept a raw API key through argv, logs, transcripts, project
  files, tool results, diagnostics, or child environments.
- Do not execute partial or unvalidated provider tool calls.
- Permission must evaluate the same immutable normalized action that executes.
- Preserve pre-existing and subsequent user workspace changes.
- Do not silently fall back from a requested strict sandbox.
- Do not turn an incomplete or uncertain effect into a successful resumed turn.
- Do not build a VS Code fork before the CLI engine and client protocol prove
  that an ordinary extension is insufficient.
