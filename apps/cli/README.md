# `guard` CLI

The in-process CLI exposes two deterministic run demonstrations and the
Milestone B policy debugger:

```text
guard run --profile synthetic-demo --format human
guard run --profile coding-virtual --format jsonl
guard run --profile synthetic-demo --quiet

guard policy check policy.guard [--catalog catalog.json] [--json]
guard policy format policy.guard [--json]
guard policy test policy.guard --cases cases.json [--catalog catalog.json]
guard policy explain policy.guard --action action.json [--catalog catalog.json]
guard policy simulate --from old.guard --to new.guard --actions actions.json
```

`check` parses and type-checks all rules and reports every bounded diagnostic.
`format` emits the canonical Guard-language representation. `test` binds a
versioned table corpus to the exact policy content hash. `explain` evaluates one
full normalized action and emits its deny-overrides trace without running an
operation. `simulate` evaluates stable pages of recorded normalized actions
against old and candidate snapshots; its opaque cursor is bound to both
snapshot hashes and the sorted action corpus.

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

All policy inputs are bounded regular UTF-8 files. The parser supports an
end-of-options `--` terminator and rejects unknown, duplicated, ambiguous,
sparse, accessor-backed, proxied, or oversized argument arrays before any file
read. Policy commands buffer validated output and never execute capability
effects.

The `run` command still accepts only the built-in scripted scenarios. It does
not accept API keys, provider credentials, agent selection, filesystem
repositories, or network configuration. An objective file or inline JSON value
must exactly match the selected fixture objective (or its payload shorthand).
Durable cancellation and live progress streaming remain assigned to later
milestones.

Exit codes are stable: `0` success, `2` invalid input/configuration, `3` policy
denial, `4` approval pending, `5` budget exhaustion, `6` task or policy-table
failure, `7` infrastructure failure, and `8` cancellation.
