# `robin` CLI

The active R2 candidate is an ephemeral, Claude Code-style coding-agent CLI
that operates on the current physical Git worktree. It owns the agent loop,
tool dispatch, terminal approval flow, and repository review path. R2 is not a
general coding model release: its only model is the credential-free,
deterministic `synthetic-r2-v1` workflow used to prove the real tool loop. The
candidate remains unaccepted until its complete branch gate passes and merges.

## Start a session

Build Robin from the repository, change into a Git worktree, and invoke the
compiled entry point:

```text
robin
robin "find and fix the deterministic fixture bug"
robin --provider synthetic --model synthetic-r2-v1 "fix the fixture"
robin --permission-mode plan "inspect without changing anything"
robin -p "one headless inspection"
robin --print --output-format json "one headless inspection"
robin --print --output-format stream-json "one headless inspection"
```

The default R2 composition requires the launch directory to be inside a
physical Git worktree. Startup discovers and binds its canonical root, captures
initial HEAD/branch/status facts, and prints the root, branch state, and whether
the worktree was initially dirty. It does not silently substitute the Robin
source checkout or an in-memory repository.

With interactive stdin and stdout, a capable terminal enters raw mode and uses
a grapheme-aware editor plus a cursor-addressed, diff-based renderer. A
non-TTY, `TERM=dumb`, or screen-reader session selects the append-only flat
renderer. Both show streamed assistant text, tool boundaries, bounded live
stdout/stderr with channel order, usage, queue state, cancellation, approvals,
and the `ephemeral` session status.

Press Enter to submit. While a turn is active, submitted prompts enter a
bounded FIFO queue of at most eight messages. Raw mode responds to terminal
resize events and treats bracketed paste as inert text: pasted newlines and
command-looking content do not submit until a separate Enter. The first Ctrl-C
during work requests cancellation; a second Ctrl-C inside the bounded
escalation window forces exit with the cancellation exit code. Ctrl-D closes an
idle session. `/help`, `/exit`, and `/quit` are available as local commands.
Robin restores terminal input mode, bracketed-paste state, cursor visibility,
and style on its tested exit and error paths.

## What the R2 fixture agent does

`synthetic-r2-v1` derives each next action from the provider-neutral transcript
and exact tool observations. It is deliberately narrow and deterministic:

1. list eligible files in the bound worktree;
2. search those explicit paths for the exact literal `total - value`;
3. read the single matched file and bind its complete hash and size;
4. request approval to replace that exact occurrence with `total + value`;
5. request approval to run direct `npm test`;
6. if the test exits nonzero, re-read the same file, recognize the exact
   follow-up `return label.toLowerCase();` defect, request a second edit, and
   request a second `npm test` run;
7. after a passing test, inspect bounded Git status and the working-tree diff;
8. report the verified edit count and explicit no-sandbox facts.

An arbitrary prompt does not turn this fixture into an arbitrary model. Hosted
providers, local model endpoints, BYOK, model discovery, provider switching,
and external-agent adapters remain R4 or later work.

The exact installed R2 tools are:

| Tool | Current effect and permission |
| --- | --- |
| `robin.repo.list_files@1` | Bounded physical metadata listing; allowed in the bound worktree. |
| `robin.repo.search_text@1` | Bounded literal search over an explicit released path list; allowed. |
| `robin.repo.read_file@1` | Bounded whole/byte/line text read with classification and preimage facts; allowed. |
| `robin.edit.apply_patch@1` | One-file exact-preimage atomic replacement; asks for one-use approval. |
| `robin.edit.create_file@1` | Atomic creation of one absent bounded text file; asks for one-use approval. |
| `robin.process.run@1` | Direct trusted executable plus argv with bounded output; asks for one-use approval. |
| `robin.git.status@1` | Controlled, bounded, read-only status and attribution; allowed. |
| `robin.git.diff@1` | Controlled, bounded working or staged diff; allowed. |

No R2 tool deletes or moves a file, invokes shell command text, enables a
workspace executable, contacts a model API, or mutates Git state. Robin does
not stage, commit, reset, checkout, branch, merge, push, or open a pull request.

## Permission modes and approval input

`ask` is the default. Bounded repository and Git reads are allowed; every edit
and process run requires a fresh approval bound to the normalized request,
workspace and tool preconditions, and policy snapshot. The terminal displays
the complete canonical summary and binding hashes before accepting a response.

- Type exactly `y` or `allow-once`, then Enter, to grant that one action.
- Type exactly `n` or `deny`, then Enter, to refuse it.
- Empty Enter and unrelated text grant nothing.
- Pasted text cannot answer an approval.
- Ctrl-C cancels; Ctrl-D during approval never grants authority.
- A changed request or precondition invalidates the pending authority rather
  than executing a stale action.

An allow-once grant is consumed by one exact dispatch and cannot be replayed.
Approval and session state exist only in memory. `plan` keeps the same physical
read tools available but policy-denies edit and process effects. Persistent
project/user approval rules arrive in a later gate.

Print mode has no trusted interactive approval channel. If its turn requests an
edit or process run, Robin automatically denies that action instead of hanging
or treating headless execution as consent. Consequently the current
deterministic R2 workflow can inspect in print mode but cannot complete its
mutable repair there.

## Explicit isolation warning

R2 is **not sandboxed**. Approved processes execute directly on the host with
no filesystem isolation and no network isolation. Robin uses a reviewed system
executable path, passes a structured argv without a shell, disables workspace
executables, closes stdin for the fixture test, filters the inherited
environment, bounds stdout/stderr, and owns process-group cancellation. Those
controls reduce accidental ambiguity; they do not constrain what an approved
host executable or its descendants can access.

Run R2 only in a disposable or reviewed repository and inspect every approval.
The session banner, approval summary, tool result, final fixture answer, JSON
metadata, and startup facts all retain the no-sandbox claim. Strict command
sandbox enforcement is R5 work.

## Disposable two-step demonstration

The deterministic provider expects both recognized defects in one source file.
This creates a disposable Git repository whose first test still fails after the
arithmetic fix and passes after the follow-up normalization fix:

```bash
ROBIN_SOURCE=/absolute/path/to/Robin
ROBIN_DEMO_ROOT="$(mktemp -d)"
cd "$ROBIN_DEMO_ROOT"
git init -b main
git config user.name "Robin Fixture"
git config user.email "robin-fixture@example.invalid"
mkdir -p src test
npm init -y
npm pkg set type=module scripts.test="node --test"
printf '%s\n' \
  'export function sum(values) {' \
  '  return values.reduce((total, value) => total - value, 0);' \
  '}' \
  '' \
  'export function normalize(label) {' \
  '  return label.toLowerCase();' \
  '}' > src/calculate.js
printf '%s\n' \
  'import test from "node:test";' \
  'import assert from "node:assert/strict";' \
  'import { normalize, sum } from "../src/calculate.js";' \
  'test("fixture", () => {' \
  '  assert.equal(sum([2, 3]), 5);' \
  '  assert.equal(normalize("Robin"), "ROBIN");' \
  '});' > test/calculate.test.js
git add package.json src/calculate.js test/calculate.test.js
git commit -m "fixture baseline"
node "$ROBIN_SOURCE/apps/cli/dist/bin.js" "repair and verify the fixture"
```

Review four prompts: the first exact edit, first `npm test`, follow-up exact
edit, and second `npm test`. Approving all four leaves two working-tree changes
in `src/calculate.js`; Robin reviews them but does not stage or commit them.
Remove the directory named by `ROBIN_DEMO_ROOT` after inspection to discard the
disposable repository.

## Headless and R1 compatibility behavior

Print mode requires exactly one prompt and never enters raw mode. `text` emits
the final answer, `json` emits one versioned result envelope containing the
application events, and `stream-json` emits one JSON object per versioned event
with a monotonic sequence. R2 machine output includes bound workspace, branch,
initial-dirty, and explicit isolation facts. Both machine formats declare
`stability: "experimental"`; their stable automation contract remains R7 work.
`--maximum-turns` is bounded from 1 through 256. `--no-save` explicitly states
the current ephemeral behavior. Raw API keys are never accepted in argv.

Provider, repository, filename, tool, and process text is sanitized before
terminal rendering so ESC, BEL, carriage return, C1 controls, and other unsafe
controls appear escaped. Machine modes preserve semantic strings through JSON
escaping and contain no ANSI presentation bytes.

The accepted immutable R1 fixture remains available explicitly:

```text
robin --model synthetic-r1-v1 "inspect the in-memory fixture"
```

That model uses the two R1 synthetic read-only tools and does not inspect or
modify the launch directory. It is retained for compatibility and R1 evidence;
`synthetic-r2-v1` is the default on the active R2 branch.

Every R2 coding session and approval disappears at exit. There is no durable
save, continuation, resume, crash recovery, credential record, provider API
call, or supported global release channel. See
[Terminal Compatibility](../../docs/TERMINAL_COMPATIBILITY.md) for the accepted
R1 matrix; R2 adds candidate approval and live-output PTY coverage without
retroactively widening R1.

Retained compatibility commands are:

```text
robin run --profile synthetic-demo --format human
robin run --profile coding-virtual --format jsonl
robin run --profile synthetic-demo --quiet

robin policy check policy.guard [--catalog catalog.json] [--json]
robin policy format policy.guard [--json]
robin policy test policy.guard --cases cases.json [--catalog catalog.json]
robin policy explain policy.guard --action action.json [--catalog catalog.json]
robin policy simulate --from old.guard --to new.guard --actions actions.json
```

`check` parses and type-checks all rules and reports every bounded diagnostic.
`format` emits the canonical `.guard` policy-language representation. `test` binds a
versioned table corpus to the exact policy content hash. `explain` evaluates one
full normalized action and emits its deny-overrides trace without running an
operation. `simulate` evaluates stable pages of recorded normalized actions
against old and candidate snapshots; its opaque cursor is bound to both
snapshot hashes and the sorted action corpus. Every page reports both its page
counts and exact whole-corpus totals, so review does not depend on which page
happened to be displayed.

The domain-neutral `guard.base` attribute catalog is always present. A
repeatable `--catalog <catalog.json>` adds reviewed, versioned pack/source
attributes. Simulation also accepts `--from-catalog` and `--to-catalog` so the
two snapshots can use different schemas honestly. Catalog JSON has this exact
shape; the implementation computes and binds its canonical content hash:

```json
{
  "catalogId": "example.pack",
  "schemaVersion": 1,
  "attributes": [
    {
      "name": "example.risk",
      "type": "string",
      "optional": true,
      "secretClassification": null,
      "matchKind": "none",
      "source": {
        "kind": "object_field",
        "section": "request",
        "field": "risk"
      }
    }
  ]
}
```

Policy sources use a stable logical CLI source ID so a checked-in case corpus
does not change identity when a project or installed package moves. Each
compile receives a fresh policy-version ID; content identity remains the
canonical policy hash. Explanations replace secret-classified values with
category/count metadata and redact random per-run correlation tokens from
portable output.

All policy inputs are bounded, non-symbolic-link regular UTF-8 files. Reads
must match the pre-read identity and byte length, reach exact EOF, and retain
the same identity and metadata after the read; invalid UTF-8 and files that
change during a read fail closed. The parser supports an end-of-options `--`
terminator and rejects unknown, duplicated, ambiguous, sparse,
accessor-backed, proxied, or oversized argument arrays before any file read.
Policy commands buffer validated output and never execute capability effects.
With `--json`, successful results, compiler diagnostics, and all other
input/configuration failures are versioned JSON envelopes.

The `run` command still accepts only the built-in scripted scenarios. It does
not accept API keys, provider credentials, agent selection, filesystem
repositories, or network configuration. An objective file or inline JSON value
must exactly match the selected fixture objective (or its payload shorthand).
Durable cancellation and compatibility-scenario live progress remain assigned
to later gates.

Exit codes are stable: `0` success, `2` invalid input/configuration, `3` policy
denial, `4` approval pending, `5` budget exhaustion, `6` task or policy-table
failure, `7` infrastructure failure, and `8` cancellation.
