# Milestone C Prototype Status at the Robin Product Pivot

This branch preserves the unfinished Milestone C runtime substrate that existed
when the product pivoted from a runtime-first roadmap to the Robin coding-agent
CLI. It is an archival work-in-progress checkpoint, not a release claim and not
a merge candidate.

## Preserved work

- ADR-0007 for post-policy preparation, exact artifact-backed execution,
  compensation, reconciliation, and orphaning.
- Namespaced informational event-family registration and generic replay.
- An unfinished capability-gateway lifecycle prototype.
- An unfinished local content-addressed artifact-store prototype.
- An unfinished trusted Git worktree inspection/materialization prototype.

## Known blocking findings

### Capability lifecycle

- A recovered `succeeded` effect can encounter validation or release failure
  without taking the same compensation path as a newly dispatched effect.
- A reconciliation callback or reconciliation-envelope failure can leave a
  prior effect uncertain while returning an ordinary failure classification.
- Artifact hash formatting must be made interoperable with the artifact
  store's algorithm-qualified `sha256:<hex>` contract.
- The run-scoped composition and atomic mixed-family publication seam remain
  unimplemented.

### Artifact store

- Quota and reservation state is instance-local, so two adapters opened on the
  same root can overcommit process-local run/store limits.
- Zero-byte objects can create unbounded reference metadata because reference
  counts and aggregate metadata are not capped.
- A failure after a final rename but before directory synchronization can leave
  a published file that is not reflected in in-memory quota accounting.
- A source-controlled async iterator can throw a crafted domain error whose
  details bypass source-error sanitization.
- Cancellation's check-to-listener race was patched and covered, but the other
  findings above remain open.

### Git worktree adapter

- Repository config includes, conditional includes, and worktree config can
  hide executable filters from the static denylist before `git status` runs.
- Tracked attributes must be read and rejected from raw Git objects before any
  command such as `status` can interpret them.
- Partial-clone/promisor configuration can trigger repository-controlled lazy
  fetch helpers during `cat-file`; lazy fetch, replace objects, and unsupported
  object indirection must be disabled and tested with execution canaries.
- The command runner combines stdout and stderr into one bound, which can reject
  exact-size blobs when platform Git emits a bounded diagnostic. The streams
  need independent limits and a controlled temporary environment.
- Cancellation and timeout currently reject before proving the entire process
  group has exited.
- Data-root/source/common-directory overlap and exact worktree administration
  pointer checks require additional fail-closed validation.

## Reuse decision

Robin still needs these capabilities, but they now sit behind the coding CLI's
tool and permission layer. Resume this branch only after the interactive coding
loop, provider path, repository session, and user-facing permission UX define
the concrete contracts they consume. Port reviewed pieces forward in focused
commits; do not merge this archival checkpoint wholesale.
