# Event Model v1

This document is the user-facing reference for the event model implemented by
Milestone A. It describes the current v1 contracts, in-memory event store,
pure runtime reducer, command planner, synchronous host, and replay behavior.
The TypeScript contracts in `packages/contracts/src/events.ts` and transition
rules in `packages/runtime/src/` remain the executable source of truth.

Milestone A is deterministic and provider-free. Its records have the shape
needed by a future durable runtime, but the current event store and command
queue are process memory. PostgreSQL persistence, transactional command
insertion, leases, restart recovery, and a daemon are planned for Milestone E;
they are not properties of the v1 implementation described here.

## Aggregate and Stream

One run is one aggregate. Its `RunId` is also the event store's `streamId`.
Events for that run form a gap-free, one-based sequence ordered by
`streamVersion`.

The current implementation does not have a separate global sequence number.
UUIDv7 identifiers are useful for locality and diagnostics, but identifier or
timestamp ordering never replaces `streamVersion` when reconstructing a run.

```text
run stream
  version 1     version 2           version 3       ...     version N
  RunCreated -> TaskProfilePinned -> RunStarted ->          terminal event
```

The in-memory store implements optimistic concurrency. A caller appends one
non-empty batch with an `expectedVersion`; the entire append fails with a
`conflict` error if the stream's current version differs. Validation, duplicate
event-ID detection, envelope creation, and size checks finish before the new
array is published, so a rejected batch cannot expose a prefix. Defaults are
100 events per batch and 1 MiB of canonical UTF-8 per completed envelope.

## New Event and Stored Envelope

Code that decides or observes a fact creates a `NewEvent`. The store adds the
three ordering fields to produce an `EventEnvelope`.

| Field | Added by | Meaning |
|---|---|---|
| `eventId` | producer | Globally unique `evt_<lowercase-uuidv7>` identity. |
| `eventType` | producer | One of the 43 v1 generic event types listed below. |
| `eventSchemaVersion` | producer | Payload contract version; Milestone A accepts version `1`. |
| `occurredAt` | producer | Canonical ISO-8601 time at which the fact occurred. |
| `actor` | producer | Strict actor identity containing the actor kind and ID. |
| `correlationId` | producer | Groups related work. The Milestone A host uses the run ID. |
| `causationId` | producer | Event that directly caused this fact, or `null` at the root. |
| `payload` | producer | Strict event-specific JSON payload. Unknown or missing fields fail validation. |
| `streamId` | event store | Owning `run_<lowercase-uuidv7>` aggregate. |
| `streamVersion` | event store | Gap-free, one-based per-run sequence number. |
| `recordedAt` | event store | Canonical ISO-8601 time at which the append was recorded. |

All known payloads are parsed at the boundary. Event framing and payload
objects are detached from caller-owned data and deeply frozen. Canonical JSON
and boundary snapshots are bounded by depth, node count, container size,
string bytes, and total canonical bytes. Proxies, accessors, sparse arrays,
cycles, non-JSON values, unknown fields, malformed IDs, and non-canonical
timestamps fail closed with domain errors.

`occurredAt` and `recordedAt` answer different questions. The former belongs
to the fact; the latter belongs to storage. The reducer permits equal record
times but rejects a `recordedAt` value that moves backwards within a stream.

## Identifier and Causation Rules

Every branded ID uses `<kind>_<lowercase-uuidv7>`. Relevant prefixes include
`run`, `evt`, `att` (agent attempt), `dpr` (driver proposal), `act`, `apr`
(approval), `cmd`, `pol` (policy version), and `art` (artifact).

The runtime enforces these ordering and identity rules:

1. The first envelope is `RunCreated` at stream version 1.
2. Each next envelope has exactly the previous `streamVersion + 1`.
3. An initialized projection never changes `streamId`.
4. One event ID may be recorded only once, including across streams in the
   current store instance.
5. Agent-attempt, driver-proposal, action, and approval IDs cannot be rebound
   within one run. Their replay-derived ledgers are bounded by the pinned turn
   and action budgets.
6. A generated command uses the causing event's UUID with the `cmd_` prefix and
   stores that event in `causedByEventId`.
7. Effect-result events point back through `causationId`; consumers should use
   this explicit link rather than infer causation from adjacent timestamps.

The two checked-in golden histories demonstrate the complete framing and
causal chain:

- [synthetic transform history](../packages/milestone-a-scenarios/fixtures/synthetic-transform.history.json): 19 events
- [virtual repository history](../packages/milestone-a-scenarios/fixtures/coding-virtual-repository.history.json): 33 events

## Event Type Inventory

The v1 generic family contains exactly 43 event types. The grouping below is
organizational; every item is handled by the same strict parser and reducer.

### Run creation and lifecycle

- `RunCreated` records the validated, version-pinned objective.
- `TaskProfilePinned` records the exact profile, schemas, component bindings,
  evidence mode, and budgets used by the run.
- `RunStarted` moves a configured run into planning.
- `RunIntentAppended` records an additional versioned user intent without
  redefining the current objective.
- `RunPaused` and `RunResumed` represent an explicit idle pause boundary.
- `CancellationRequested` begins cancellation and clears any pending approval.
- `RunCancelled`, `RunFailed`, `RunCompleted`, and `RunOrphaned` are the four
  terminal facts. A completed result must contain the exact validated outcome.

### Agent driver and attempts

- `AgentDriverStarted` pins the installed driver identity and fingerprint.
- `AgentAttemptStarted` opens the next consecutive turn.
- `AgentContentCompleted` records bounded completed content for the attempt.
- `AgentUsageRecorded` records generic, non-negative usage dimensions.
- `AgentAttemptUncertain` records an ambiguous result that requires an explicit
  recovery, retry, or terminal decision.
- `AgentAttemptFailed` records a definite attempt failure.

### Context

- `ContextRequested` identifies one resource request.
- `ContextReleased` records the agent-safe content blocks released for it.
- `ContextDenied` records a domain error instead of content.
- `ContextRedacted` records the transformation IDs applied to an active
  request.

### Actions, policy, execution, and observations

- `ActionProposed` records the exact capability-pack and operation versions
  advertised to the driver plus the proposed JSON input.
- `ActionNormalized` records a stable `NormalizedAction` whose identity and
  pinned versions must match the proposal.
- `PolicyEvaluated` records the policy version, one of `allow`, `deny`, or
  `require_approval`, and an explanation trace.
- `ActionDenied` records the denial error.
- `ActionStarted` opens execution of an allowed or approved action.
- `ActionSucceeded` and `ActionFailed` settle execution.
- `ActionReconciled` records `absent`, `succeeded`, `failed`, or `uncertain`
  after recovery inspection.
- `ObservationReleased` records the bounded human, agent, and audit views. The
  expected status and error identity must agree with the action result.

Milestone A's installed policy permits only operations normalized with
`sideEffectClass: "none"`; all other classes are denied. It does not yet
implement the policy language, real approvals, or external execution.

### Approvals

- `ApprovalRequested` binds an approval ID to an action and precondition hash.
- `ApprovalGranted` and `ApprovalDenied` record the review decision.
- `ApprovalExpired` and `ApprovalInvalidated` reject a stale or changed request.
- `ApprovalConsumed` binds one granted approval to its action before execution.

The contracts and reducer validate these facts, but the Milestone A host's
pure-or-deny policy makes the approval command path unreachable. Durable
approval storage, expiry processing, one-time consumption, and restart-safe
precondition checks arrive in Milestone E.

### Outcomes and artifacts

- `OutcomeProposed` records the driver-proposed, profile-bound outcome.
- `OutcomeValidated` records matching evidence and the validation time.
- `ArtifactReferenced` records a unique artifact ID, content hash, and media
  type without embedding an artifact store in the kernel.

### Budget, retry, and recovery

- `RetryScheduled` records the attempt kind, ordinal, and schedule time.
- `BudgetExceeded` records the dimension, consumed value, and limit after
  active consequential work has settled.
- `RecoveryStarted` records the recovery identity and previous lifecycle state.
- `RecoveryCompleted` records `recovered`, `orphaned`, or `failed`.

The reducer supports these records and their invariants. Automated durable
recovery and fault reconciliation are Milestone E work.

## Projection Lifecycle

`RunState` is a projection, not a second source of truth. It begins as
`uninitialized`; `evolve(previousState, nextEnvelope)` validates one transition
and returns a new deeply immutable state. The lifecycle statuses are:

```text
uninitialized
  -> created
  -> planning
     <-> waiting_for_agent
     <-> evaluating_action
     <-> waiting_for_approval
     <-> executing_action
     <-> recording_observation
     <-> attempt_result_uncertain
     <-> recovering
     <-> paused
     -> cancellation_requested
  -> completed | failed | cancelled | orphaned
```

This diagram is an overview, not permission to jump between adjacent labels.
`EVENT_LEGAL_STATES` is the authoritative event/status matrix, and semantic
guards narrow it further using the current attempt, action phase, outstanding
command, approval, recovery, profile, outcome, evidence, budget, and IDs.

Important invariants include:

- exactly one active attempt, context request, action, pending approval, and
  consequential command at a time;
- consecutive turn numbers and bounded, non-reused attempt/action identities;
- an action cannot execute before exact-version normalization and policy
  evaluation;
- observations must match the preceding success, failure, reconciliation, or
  denial;
- no new work starts after `BudgetExceeded`;
- a terminal state contains its matching result and no live work;
- `RunCompleted` requires a quiescent run and the exact schema-validated
  outcome and evidence previously proposed.

## Legal Run Intents

`decide(state, intent)` is pure. It checks the intent's framing, the legal state
set, and semantic preconditions, then returns the supplied domain event. It
does not append, generate IDs or time, or execute an adapter.

| Intent | Event | Legal projection and principal semantic guard |
|---|---|---|
| `create_run` | `RunCreated` | `uninitialized`; objective must be structurally valid. |
| `pin_task_profile` | `TaskProfilePinned` | `created`; exact profile ID/version must match the objective and budgets must be valid. |
| `start_run` | `RunStarted` | `created`; a matching profile must already be pinned. |
| `append_run_intent` | `RunIntentAppended` | `created`, `planning`, `waiting_for_agent`, `attempt_result_uncertain`, `evaluating_action`, `waiting_for_approval`, `recording_observation`, or `paused`; intent type and version must be valid. |
| `pause_run` | `RunPaused` | `created`, `planning`, or `attempt_result_uncertain`; no outstanding command or pending approval. |
| `resume_run` | `RunResumed` | `paused`; a resumable predecessor is recorded and no budget has been exceeded. |
| `request_cancellation` | `CancellationRequested` | Any cancellable active state except one already requesting cancellation. |
| `cancel_run` | `RunCancelled` | `cancellation_requested`; consequential work must be settled and result/run IDs must match. |
| `fail_run` | `RunFailed` | A failable active state; `waiting_for_agent` and `executing_action` must first settle their consequential command. |
| `complete_run` | `RunCompleted` | `planning`; the run is quiescent and the result contains the exact validated outcome. |
| `orphan_run` | `RunOrphaned` | `recovering`, `attempt_result_uncertain`, `executing_action`, or `cancellation_requested`; result/run IDs must match. |

An event produced outside `decide` still passes the same envelope, legal-state,
semantic, and invariant checks in `evolve`.

## Event-to-Command Flow

The runtime separates facts from effects:

```text
intent or adapter result
  -> strict NewEvent
  -> optimistic append
  -> stored EventEnvelope
  -> pure evolve + pure planEffects
  -> RuntimeCommand data
  -> host/worker executes one named port
  -> result becomes another strict event
```

`planEffects(state, event)` returns immutable command data and never calls an
adapter. Commands carry a schema version, deterministic command ID, stream ID,
causing event ID, `consequential` flag, command type, and JSON payload.

| Command type | Consequential | Planned from |
|---|---:|---|
| `AdvanceAgentDriver` | yes | run start/resume, released context or observation, retry, or recovered work |
| `FetchContextResource` | yes | context request |
| `EvaluateCapabilityAction` | no | action proposal |
| `CreateApprovalRequest` | no | `require_approval` policy decision |
| `ExecuteCapabilityAction` | yes | allowed policy decision or consumed approval |
| `CancelCapabilityAction` | yes | cancellation while consequential work is outstanding |
| `ValidateOutcome` | no | outcome proposal |
| `FinalizeRun` | no | validated outcome, settled cancellation/failure, budget exhaustion, or unrecoverable recovery |

Only consequential commands occupy `RunState.outstandingCommand`, and a second
one cannot be planned until the first is settled by a result event. In
Milestone A, `SynchronousRuntimeHost` drains a bounded FIFO in the same process.
It calls the pinned driver, context source, capability gateway, outcome schema
validator, and terminal finalizer, appending every result before continuing.
The queue itself is not persisted. Milestone E will store commands
transactionally with committed events and add leases, retries, reconciliation,
and restart recovery without changing this command vocabulary casually.

## Replay

Replay is deliberately less capable than live execution:

```text
history -> createInitialRunState -> evolve(event 1) -> ... -> evolve(event N)
```

`replay(history)` calls only the pure reducer path. `evolve` deterministically
re-derives command data so it can reconstruct and validate
`outstandingCommand`, but replay never queues or dispatches that command. It
does not call a driver, provider, context source, capability handler, policy
adapter, clock, ID factory, artifact store, or command worker. It requires one
gap-free stream and re-applies all framing, transition, and projection
invariants.

The Milestone A scenario tests execute each golden history twice, compare
canonical bytes, rebuild the exact terminal projection, and install fail-on-use
spies for every effect port. The replay effect count must remain zero. This is
evidence for deterministic projection rebuild; it is not evidence for restart
recovery because the current store does not survive process exit.

## Schema Evolution and Upcasting

Milestone A supports only contract schema version 1. No upcaster is implemented
and the checked-in golden histories must never be rewritten silently.

When a persisted v2 payload is needed, the planned evolution rule is:

1. Keep the original envelope immutable and retain its event ID, stream
   position, actor, causation, correlation, and timestamps.
2. Register an explicit pure upcaster for each supported adjacent payload
   version; do not infer versions from field presence.
3. Parse and size-bound the stored version before upcasting, then strictly
   parse and size-bound the resulting current-version payload.
4. Make upcasting deterministic and effect-free: no clock, network, file,
   credential, provider, or random input.
5. Test old golden histories, malformed historical payloads, every supported
   version path, and projection equality where semantics are unchanged.
6. Fail closed with a typed incompatibility error when no complete path exists.
7. Treat physical database migrations separately from logical event
   upcasting; neither may mutate audit meaning in place.

That compatibility layer belongs with durable persistence in Milestone E. Until
it exists, changing a v1 event payload requires an explicit compatibility
decision rather than claiming old histories remain readable.

## Milestone A Storage Limitations

The current evidence proves deterministic event representation and replay in
one process. It does not yet prove:

- persistence after process exit;
- atomic event-plus-command insertion in PostgreSQL;
- worker claim, lease, heartbeat, retry, or reaper behavior;
- crash-window reconciliation or idempotent external side effects;
- encrypted durable transcript or artifact retention;
- daemon cursor subscriptions or multi-client ordering;
- live approval expiry and one-time durable consumption;
- compatibility with historical event schema versions.

Those limitations are intentional milestone boundaries. The build plan and
implementation guide define the later evidence gates; documentation must not
present them as current guarantees until their tests pass.
