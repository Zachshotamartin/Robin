# `guard` CLI

Milestone A exposes two deterministic, in-process demonstrations:

```text
guard run --profile synthetic-demo --format human
guard run --profile coding-virtual --format jsonl
guard run --profile synthetic-demo --quiet
```

The CLI accepts only the built-in scripted scenarios. It does not accept API
keys, provider credentials, agent selection, filesystem repositories, or
network configuration. An objective file or inline JSON value must exactly
match the selected fixture objective (or its payload shorthand).

The first Milestone A slice buffers output until a run finishes. `SIGINT`
therefore exits without emitting a partial progress stream, but durable runtime
cancellation is not yet exposed by this in-process command.

Exit codes are stable: `0` success, `2` invalid input/configuration, `3`
policy denial, `4` approval pending, `5` budget exhaustion, `6` task failure,
`7` infrastructure failure, and `8` cancellation.
