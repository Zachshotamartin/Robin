# Robin gate evidence

This directory contains the versioned input, schema, and capture workflow for
Robin local gate-command evidence. It does not contain a placeholder R0
or R1 acceptance record. A candidate manifest is created only after every
configured command passes from a clean, committed source tree; GitHub settings,
hosted CI, pull-request review, prerequisite status, and mainline merge remain
separate gate-acceptance records.

## Tested-commit semantics

`commit` is the exact clean `HEAD` whose files and commands were tested. The
capture program checks cleanliness before the first command and again after the
last command, including staged, unstaged, and untracked files. It also proves
that the capture config, both version manifests, `package-lock.json`, and both
traceability documents exist in that `HEAD`.

Only after those checks pass does the program atomically write the output
manifest. Writing that file necessarily makes a source checkout dirty when the
output is new or changed. Therefore:

- a CI job may upload the generated manifest as an artifact for the tested
  commit; or
- a follow-up evidence commit may track the generated manifest while its
  `commit` field continues to identify the tested source commit.

The second form is not same-commit evidence for the follow-up commit. It is a
tracked record of evidence for the commit named inside the manifest. The
manifest never lists itself as a hashed artifact, so it makes no impossible
self-hash claim.

## R0 capture

The tracked [R0 capture config](config/r0.json) runs the lifecycle-disabled,
noninteractive dependency install; emits the complete installed dependency tree;
then runs `docs-policy`, `static`, `unit-contract`, `package-smoke`, and the
complete accepted Gate A/B regressions. Requirement entries remain `partial`
when their terminal owning gate is later than R0.

From a clean candidate commit:

```console
npm run evidence:validate-config:r0
npm run evidence:capture:r0
npm run evidence:validate -- --manifest evidence/manifests/r0.json
```

Capture rejects a dirty tree, a missing/ignored tracked input, a command timeout
or nonzero status, a changed `HEAD`, any tracked or untracked command output,
path escape, symlinked hashed input, mismatched Robin versions, or a requirement
completion claim unsupported by schema v1.

## R1 candidate capture

The tracked [R1 capture config](config/r1.json) inherits Gate B and adds the
versioned session/application/agent/terminal unit corpus, local real-PTY suite,
and installed-package PTY/install/uninstall smoke. It hashes the R1 PTY driver,
application-event and turn-reducer contracts, terminal compatibility matrix,
and reviewed 59-file package inventory.

From a clean R1 candidate commit:

```console
npm run evidence:validate-config:r1
npm run evidence:capture:r1
npm run evidence:validate -- --manifest evidence/manifests/r1.json
```

The resulting manifest is deliberately local candidate evidence. It cannot
accept R1 while R0 is unaccepted, does not contain GitHub-hosted Linux/macOS job
identity, and does not exercise a physical repository, real model API, API key,
process/Git effect, durable session, or public distribution channel.

Control/configuration inputs are limited to 4 MiB, generated and loaded
manifests to 8 MiB, tracked audit or hashed evidence files to 64 MiB each, and
the tracked/hash audit aggregate to 1 GiB. Commands are limited to 100; other
evidence collections to 1,000 items; and each command's stdout and stderr to
64 MiB. Fixture and artifact hashes are computed sequentially so those declared
bounds cannot become multi-gigabyte concurrent Buffer allocations.

Schema v1 deliberately permits only `partial` requirement status. A later
schema must bind implemented test IDs to reviewed jobs and enforcement points
before any manifest may mark a normative requirement `complete`. Every declared
fixture and artifact is also required to be a tracked regular input at the
tested commit; ignored command-generated output cannot become gate evidence.

The tool launches structured executable-and-argument arrays with `shell: false`.
It clones the exact tested commit without hard links into a disposable checkout,
removes the clone's source remote before running any configured command,
then runs every configured command there. The source checkout therefore receives
no build, install, cache, or ignored-file output; its only possible new path is
the final manifest written after all checks. The disposable checkout must remain
Git-clean apart from intentionally ignored build/install products and is removed
after capture.

Child commands receive a temporary task-specific evidence root, XDG directories,
empty npm user config, and isolated Git global/system config. The manifest records
only the fixed platform/architecture/Node/npm/Git/command-isolation allowlist.
The capture command does not print or retain raw child output. The manifest
retains only byte counts, strict raw SHA-256 digests, and an additional
replay-checkable SHA-256 proof that collapses variable ASCII-number runs; it
never retains output text or ambient environment variables. Full validation
re-executes every configured command and requires both the raw and normalized
proofs to match, as well as the current allowlisted environment. Normalization
is supplemental diagnostic metadata and cannot make changed raw output pass.

The dependency install uses `npm ci --ignore-scripts --silent --no-audit
--no-fund` because npm's ordinary success line embeds elapsed time. The next
command, `npm ls --all --json`, independently emits and attests the complete
resolved dependency tree. A failed silent install causes capture to fail closed
without writing a manifest. It should then be rerun manually without `--silent`
to obtain human-readable diagnostics.

Observed command duration is operational metadata. Validation rejects a grossly
implausible replay duration through a versioned bounded envelope, but duration is
not part of Robin's deterministic output contract and this manifest is not a
performance attestation. R10 owns supported-platform percentile evidence.

The capture tool itself performs no artifact upload, Git push, package
publication, or release mutation. Its reviewed commands are not network
sandboxed: the configured `npm ci --ignore-scripts` may download locked public
dependencies into its temporary isolated cache. Attaching or committing a
reviewed generated manifest is an explicit later workflow step.
On macOS, each command and every inherited detached descendant runs under a
`sandbox-exec` profile that denies reads and writes to the physical source
checkout. On non-macOS POSIX platforms schema v1 records
process-group/source-audit mode, not an OS sandbox, and assumes reviewed tracked
commands and locked dependencies are not actively malicious. Schema v1 capture
and replay fail closed on Windows because Node does not provide the required
descendant process-tree containment there. This evidence isolation is not a
claim about Robin's future coding-agent execution sandbox.

Apple's `sandbox-exec` profiles cannot be nested. When the repository test suite
is itself a gate-capture child, the 21 evidence-controller integration cases that
would recursively launch another isolated capture are therefore reported as
explicit skips; the five non-recursive schema/runtime cases still execute. The
same 21 integration cases run without skips in ordinary local and hosted CI
gates before capture. The generated gate manifest attests the outer isolated gate
commands, not a recursive self-attestation by the evidence controller.

Process groups provide best-effort descendant termination, not a complete
process-tree boundary: a child can create a new session and briefly outlive its
original group. Robin's timeout watchdog destroys retained command pipes after
a fixed post-kill grace so such a child cannot make evidence capture hang; on
macOS the inherited source-denial policy still applies. Schema v1 does not claim CPU,
memory, PID, disk, or ignored-output quotas. Those controls require a future
cgroup, container, job object, or equivalent OS boundary.

`evidence:validate` is not a schema-only check. It loads the gate's tracked
capture config from the manifest's named commit in another disposable checkout,
then rebinds the version, lock hash, exact command definitions, requirement and
claim text, limitations, and every fixture/artifact hash to that commit.
Both capture and validation require the canonical
`evidence/manifests/<lowercase-gate>.json` path; the output option cannot target
another repository file.

The JSON Schemas are bounded structural interchange contracts. The
dependency-free validators in `scripts/gate-evidence.mjs` are authoritative for
semantic and cross-field rules that JSON Schema cannot fully express here,
including unique identities and paths, command references, replay bytes versus
observed bytes, duration versus timeout, derived display/summary fields,
supported/deferred claim disjointness, canonical/self paths, traceability text,
and Git object/tree binding. Repository tests compile both schemas and exercise
positive and negative parity fixtures; schema validation alone is never gate
acceptance.

## Files

- `config/r0.json` is the reviewed R0 command, trace, claim, deferral, fixture,
  and artifact input.
- `config/r1.json` is the reviewed local R1 candidate command, trace, claim,
  deferral, fixture, and artifact input. It never substitutes for hosted jobs or
  the accepted R0 predecessor.
- `inventory/r0-cli-tarball-v1.json` pins the exact cross-platform uncompressed
  tar SHA-256/size, reviewed platform/architecture/npm-version gzip SHA-256/sizes, and the
  47-file path/type/mode/size/SHA-256 inventory consumed by both dry-run and
  real-tarball smoke tests. The smoke test also checks npm's SHA-1/SHA-512
  metadata against the actual compressed bytes and parses every tar header and
  checksum. npm 10 and npm 11 produce different gzip streams despite identical
  tar bytes; npm 10.9.8 produced the same reviewed stream on macOS arm64 and
  Linux x64. Each verified toolchain cell remains explicit. R0 does not retain
  the private development archive itself as a release artifact.
- `inventory/r1-cli-tarball-v1.json` pins the R1 candidate's cross-platform
  canonical tar plus 59 exact files. Its gzip profiles were measured under
  macOS arm64/npm 10.9.8, macOS arm64/npm 11.19.0, and a pinned, network-disabled
  Linux x64/Node 22/npm 10.9.8 container; unlike the canonical tar, the Linux
  gzip bytes differ from macOS and are recorded separately.
- `schema/gate-evidence-capture-config-v1.schema.json` documents capture input.
- `schema/gate-evidence-manifest-v1.schema.json` documents generated output.
- `manifests/` contains only genuinely captured records and its policy note.
- `scripts/deterministic-test-reporter.mjs` is the bounded, versioned reporter
  that removes Node runner timing and internal stack frames, normalizes checkout
  root identities, and canonicalizes cross-file scheduler interleaving while
  preserving semantic test, failure, stdout/stderr, and line-ending differences.
- `scripts/gate-evidence.mjs` is the dependency-free generator and validator.
- `scripts/generate-cli-pack-inventory.mjs` creates a bounded tar inventory,
  verifies npm's listing against parsed tar headers and file hashes, and merges
  only compression profiles whose canonical tar and full file inventory match.
