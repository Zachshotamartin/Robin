# Terminal Compatibility

## Status and Scope

Robin's current R1 candidate provides a Claude Code-style coding-agent terminal
experience over one ephemeral, in-memory application session. The only coding
provider is the deterministic `synthetic` provider and the only model is
`synthetic-r1-v1`.

R1 is **not accepted**. Local macOS real-PTY evidence and the configured hosted
Linux/macOS PTY, package-smoke, and aggregate jobs passed on stacked candidate
`dc39937`. R0 is accepted on `main` at `2c042ca`; R1 still requires fresh
exact-head evidence after its base update and a mainline merge. This page
describes candidate behavior; it is not a cross-platform support promise.

## Mode Selection

| Invocation/environment | Mode | Behavior |
| --- | --- | --- |
| `robin` or `robin "prompt"` with interactive stdin and stdout, cursor-addressed terminal, and no screen-reader override | Raw interactive | Grapheme-aware editor, diff-based terminal frames, streamed text, visible tool/usage state, resize, queue, and interrupt handling. |
| Interactive command with non-TTY streams, `TERM=dumb`, or `ROBIN_SCREEN_READER=1` | Flat interactive | Append-only, line-oriented event output with no cursor-addressed UI. It preserves textual session, assistant, tool, usage, queue, cancellation, and error state. |
| `robin -p "prompt"` or `robin --print "prompt"` | Headless | Exactly one prompt, no raw mode. `text` emits the final answer; `json` emits one result envelope; `stream-json` emits one object per application event. |

`NO_COLOR=1` disables color but does not by itself select flat mode.
`ROBIN_REDUCED_MOTION=1` requests reduced motion. `ROBIN_UNICODE=0` disables
Unicode presentation where the terminal capability detector supports an ASCII
fallback. Machine JSON formats contain no ANSI presentation bytes and remain
explicitly experimental.

## Raw Interactive Behavior

- Enter submits the current composer. When a turn is already active, the prompt
  joins a FIFO queue capped at eight messages and its position is displayed.
- Backspace, Delete, arrows, Home, End, Ctrl-A/E/U/K/W, and printable UTF-8 edit
  at grapheme boundaries.
- A bracketed paste is one inert text event capped at 65,536 UTF-8 bytes.
  Embedded newlines, terminal escapes, and command-looking strings are not
  interpreted as key presses or submitted automatically; a separate Enter is
  required. An oversized paste is discarded as a whole, reports its full
  discarded byte count, and leaves the existing composer unchanged. The
  composer itself has the same 65,536-byte cap; an insertion that would cross
  it is rejected as a whole, including when multibyte text lands exactly on the
  boundary.
- `SIGWINCH`/terminal resize updates the measured rows and columns and redraws
  without changing the semantic transcript or composer.
- The first Ctrl-C during an active turn requests cancellation and displays the
  cancelling state. A second Ctrl-C within the 750 ms escalation window forces
  bounded shutdown with exit code `8`.
- Ctrl-D closes an idle session. `/exit` and `/quit` close locally; `/help`
  displays the interactive help.
- Application shutdown has a 2,000 ms default deadline and rejects configured
  deadlines outside 1–30,000 ms. If a provider ignores cancellation, Robin
  records the cancellation/close boundary, fences late provider output, and
  completes cleanup without waiting indefinitely.
- On tested exits, Robin disables bracketed paste, makes the cursor visible,
  resets terminal style, leaves raw mode, and writes the final line. Provider
  text and tool output are escaped before rendering so terminal-control content
  remains inert.

The flat fallback does not emulate the raw editor or cursor-addressed resize
behavior. It accepts line-delimited prompts and preserves the same application
session and bounded FIFO turn queue while rendering state as append-only text.

## Deterministic Fixture Loop

The synthetic provider streams a deterministic first turn that invokes both:

- `robin.synthetic.workspace_summary@1`
- `robin.synthetic.inspect_file@1`

Their observations describe an in-memory fixture repository and fixture source
lines. The final answer identifies the fixture's negative-total bug, and a
follow-up turn depends on the observations already retained in the same
process. This exercises the provider-to-application event mapping, serialized
tool loop, usage events, replay projection, and terminal rendering without a
physical side effect.

The R1 candidate does **not** read or change the working directory, edit files,
run commands or child processes, invoke Git, access the network, contact a model
API, accept API keys, store credentials, save sessions, or support continuation
or resume. Exiting discards the entire coding session.

## Verification Matrix

| Environment/evidence | Current status | What the status means |
| --- | --- | --- |
| Local macOS real PTY, source-built CLI | Verified locally | No-argument and positional-prompt sessions, two fixture-tool turns, usage, FIFO queue promotion after cancellation, resize, inert bracketed paste, one- and two-interrupt paths, provider/tool failures, cleanup bytes, and termios restoration are exercised by the PTY harness. |
| Local macOS isolated npm-prefix package test | Verified locally | The packed CLI is installed outside the workspace, completes the happy-path PTY fixture, restores terminal state, and uninstalls from the temporary prefix. This is development evidence, not hosted release evidence. |
| Non-TTY `TERM=dumb` flat path | Deterministically tested locally | Output is append-only and contains no ANSI bytes while retaining synthetic tool and usage events. |
| Hosted Ubuntu/Linux `pty-linux` job | Candidate verified on `dc39937` | The real-PTY semantic matrix, signals, resize, restoration, headless split, and leak checks passed; a base update requires a fresh exact-head run. |
| Hosted Tier-1 macOS integration | Candidate verified on `dc39937` | The configured macOS PTY semantics, package execution, and cleanup passed; this is candidate rather than release-support evidence. |
| Windows/ConPTY and other terminals | Not claimed for R1 | No compatibility or release-support statement is made from the current evidence. |

Passing local and hosted candidate tests must not be reported as R1 acceptance
until the refreshed exact head is merged into `main`.

Developers can exercise the current deterministic checks from the repository
root:

```text
npm run test:pty
npm run test:package
```

The aggregate candidate command is `npm run test:gate:r1`, but its local result
does not replace the hosted evidence required by the build and operations
plans.

## Fallbacks and Troubleshooting

- Use `TERM=dumb robin` or `ROBIN_SCREEN_READER=1 robin` to request the flat,
  append-only experience.
- Use `NO_COLOR=1` when terminal color is undesirable without otherwise
  disabling raw mode.
- Use `robin --print --output-format text "prompt"` when only the final answer
  should be written to stdout. Choose `json` or `stream-json` only when an
  experimental machine envelope is acceptable.
- If a process is interrupted outside Robin's tested cleanup path and the shell
  is left in an unusual terminal state, use the terminal's documented reset
  procedure, then capture the Robin version and exact terminal/PTY facts for a
  reproducible issue.

The authoritative acceptance boundary remains
[R1 in the Build Plan](BUILD_PLAN.md#69-acceptance-evidence), with verification
mechanics in the
[Operations and Test Plan](OPERATIONS_TEST_PLAN.md#113-real-pty-and-terminal-lifecycle-matrix).
