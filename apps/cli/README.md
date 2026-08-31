# `robin` CLI

The current R1 candidate is an ephemeral, Claude Code-style coding-agent CLI
backed by deterministic synthetic fixtures. It uses the same in-memory
application/session path for interactive and headless execution. This is a gate
candidate, not an accepted R1 release.

Start the coding-agent experience with:

```text
robin
robin "initial prompt"
robin --provider synthetic --model synthetic-r1-v1 "initial prompt"
robin -p "one headless prompt"
robin --print --output-format json "one headless prompt"
robin --print --output-format stream-json "one headless prompt"
```

With interactive stdin and stdout, a capable terminal enters raw mode and uses
a grapheme-aware editor plus a cursor-addressed, diff-based renderer. A
non-TTY, `TERM=dumb`, or screen-reader session selects the append-only flat
renderer instead. Both renderers show streamed assistant text, tool boundaries,
usage, queue state, cancellation, and the `ephemeral` session status.

Press Enter to submit. While a turn is active, submitted prompts enter a
bounded FIFO queue of at most eight messages. Raw mode responds to terminal
resize events and treats bracketed paste as one inert text insertion: pasted
newlines and command-looking text do not submit until a separate Enter. The
first Ctrl-C during work requests cancellation; a second Ctrl-C inside the
bounded escalation window forces exit with the cancellation exit code. Ctrl-D
closes an idle session. `/help`, `/exit`, and `/quit` are available as local
commands. Robin restores the terminal's original input mode and
bracketed-paste state, cursor visibility, and terminal style on its tested exit
and error paths.

The only available coding-session provider is `synthetic`, with model
`synthetic-r1-v1`. Its deterministic first-turn fixture streams text, calls
`robin.synthetic.workspace_summary@1` and
`robin.synthetic.inspect_file@1` through the application tool loop, then
answers a fixture debugging question. A follow-up answer depends on observations
retained earlier in the same process. The tools inspect an in-memory fixture;
they do not read or modify the current directory.

Print mode requires exactly one prompt and never enters raw mode. `text` emits
the final answer, `json` emits one versioned result envelope containing the
application events, and `stream-json` emits one JSON object per versioned
application event with a monotonic sequence. Both machine formats declare
`stability: "experimental"`; their stable automation contract remains assigned
to a later release gate.
`--maximum-turns` is bounded from 1 through 256; the current one-prompt
invocation consumes only one turn. `--no-save` is an explicit statement of the
current ephemeral behavior. Raw API keys are never accepted in arguments.

Provider text is sanitized before terminal rendering so ESC, BEL, carriage
return, C1 control bytes, and other unsafe controls are displayed as escaped
text. Machine modes preserve the parsed semantic string while serializing
terminal controls and Unicode line separators as standard JSON escapes, and
contain no ANSI presentation bytes.

Every coding session is in-memory and disappears at exit. The R1 candidate has
no physical repository access, file editing, command/process execution, Git
integration, network access, provider API calls, credentials/API keys, durable
save, continuation, or resume. `ask` remains the preview spelling for the
future `default` permission mode; `plan` is also accepted. The two pinned,
non-consequential synthetic fixture tools are the only tool effects.

The raw-terminal scenarios are verified locally under a real macOS PTY,
including two turns, the two fixture tools, queue promotion, resize, paste,
single/double interrupt behavior, failure paths, and terminal restoration.
Required hosted Linux and hosted macOS evidence is still pending, so this
documentation does not claim that R1 is accepted. See
[Terminal Compatibility](../../docs/TERMINAL_COMPATIBILITY.md) for the exact
matrix and fallback behavior.

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
