# `robin` CLI

The Robin CLI now exposes an early ephemeral conversation preview, two retained
deterministic run demonstrations, and the Milestone B policy debugger.

The preview uses one provider-neutral multi-turn session path for interactive
and headless execution:

```text
robin
robin "initial prompt"
robin --provider synthetic --model synthetic-preview-v1 "initial prompt"
robin -p "one headless prompt"
robin --print --output-format json "one headless prompt"
robin --print --output-format stream-json "one headless prompt"
```

Interactive mode accepts multiple prompts and supports `/help`, `/exit`, and
`/quit`. It is currently line-oriented rather than the planned raw-mode terminal
editor. The banner identifies the selected synthetic provider, `ask` or `plan`
permission label, and ephemeral persistence. `ask` is the preview label that
will migrate to the target `default` permission mode; neither label authorizes
tools because this slice has none. The synthetic provider performs no
filesystem, process, Git, credential, or network I/O. Selecting any other
provider fails explicitly.

Print mode requires exactly one prompt. `text` emits the final answer, `json`
emits one versioned result envelope, and `stream-json` emits one JSON object per
versioned Robin agent preview event, wrapped with a monotonic CLI sequence
number. Both machine formats declare `stability: "experimental"`.
`--maximum-turns` is bounded from 1 through 256; the current one-prompt
invocation consumes only one turn. `--no-save` is an explicit statement of the
current ephemeral behavior. Raw API keys are never accepted in arguments.

Provider text is sanitized before terminal rendering so ESC, BEL, carriage
return, C1 control bytes, and other unsafe controls are displayed as escaped
text. Machine modes preserve the parsed semantic string while serializing
terminal controls and Unicode line separators as standard JSON escapes, and
contain no ANSI presentation bytes. The complete R1 raw-terminal, resize,
queued-input, cancellation, synthetic-tool, and PTY restoration gate remains
planned.

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
