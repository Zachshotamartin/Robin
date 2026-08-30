import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  AgentAttemptIdKind,
  DriverProposalIdKind,
  RunIdKind,
  canonicalize,
  createDomainError,
  isDomainError,
} from "@guard/contracts";
import type {
  ContentBlock,
  ObjectiveEnvelope,
  Observation,
  OutcomeEnvelope,
} from "@guard/contracts";

import {
  ScriptedAgentDriver,
  type AgentDriverEvent,
  type AgentTurnRequest,
  type ScriptedAgentDriverScript,
} from "./index.js";

const RUN_ID = RunIdKind.parse("run_018f05a0-7b01-7000-8000-000000000001");
const ATTEMPT_ID = AgentAttemptIdKind.parse(
  "att_018f05a0-7b01-7000-8000-000000000002",
);
const ACTION_ID = ActionIdKind.parse("act_018f05a0-7b01-7000-8000-000000000003");
const PROPOSAL_ID = DriverProposalIdKind.parse(
  "dpr_018f05a0-7b01-7000-8000-000000000004",
);

const RESOURCE = {
  schemaVersion: 1,
  scheme: "fixture",
  sourceId: "source:driver-test",
  locator: { record: "alpha" },
  mediaType: "text/plain",
  classification: "internal",
} as const;

function textBlock(id: string, text: string): ContentBlock {
  return {
    schemaVersion: 1,
    blockId: id,
    modality: "text",
    mediaType: "text/plain",
    byteLength: Buffer.byteLength(text),
    contentHash: `sha256:${id}`,
    classification: "internal",
    provenance: {
      source: RESOURCE,
      producer: { kind: "runtime", id: "runtime:test" },
      capturedAt: "2026-08-30T00:00:00.000Z",
    },
    retentionClass: "run",
    transformation: null,
    text,
    encoding: "utf-8",
    normalization: "none",
  };
}

function objective(question = "Which document defines the policy boundary?"): ObjectiveEnvelope {
  return {
    schemaVersion: 1,
    profileId: "local-research",
    profileVersion: 1,
    objectiveType: "answer_question",
    objectiveTypeVersion: 1,
    payload: { question },
    submittedBy: { kind: "user", id: "fixture-user" },
    submittedAt: "2026-08-30T00:00:00.000Z",
  };
}

function observation(status: "succeeded" | "denied" = "succeeded"): Observation {
  return {
    schemaVersion: 1,
    observationId: "observation-1",
    actionId: ACTION_ID,
    status,
    audit: { documentsMatched: status === "succeeded" ? 1 : 0 },
    human: [textBlock("human-observation", status)],
    agent: [textBlock("agent-observation", status)],
    error: null,
    occurredAt: "2026-08-30T00:00:01.000Z",
  };
}

function outcome(): OutcomeEnvelope {
  return {
    schemaVersion: 1,
    outcomeId: "outcome-1",
    profileId: "local-research",
    profileVersion: 1,
    outcomeType: "research_answer",
    outcomeTypeVersion: 1,
    payload: { answer: "The capability gateway owns the policy boundary." },
    evidence: [
      {
        kind: "observation",
        referenceId: "observation-1",
        contentHash: "sha256:observation-1",
      },
    ],
    proposedAt: "2026-08-30T00:00:02.000Z",
  };
}

function turn(
  turnNumber: number,
  observations: readonly Observation[] = [],
  overrides: Partial<AgentTurnRequest> = {},
): AgentTurnRequest {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    turnNumber,
    objective: objective(),
    advertisedOperations: [
      {
        capabilityPackId: "capability:documents",
        capabilityPackVersion: 1,
        operationId: "documents.search",
        operationVersion: 1,
        description: "Search the released local corpus.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: { query: { type: "string" } },
        },
      },
    ],
    context: [textBlock("context-1", "The gateway mediates all effects.")],
    observations,
    ...overrides,
  };
}

const FIRST_EVENTS: readonly AgentDriverEvent[] = [
  { type: "content_delta", channel: "analysis", delta: "I should search." },
  {
    type: "content_completed",
    channel: "analysis",
    content: textBlock("analysis-1", "I should search the corpus."),
  },
  {
    type: "action_proposed",
    proposalId: PROPOSAL_ID,
    capabilityPackId: "capability:documents",
    capabilityPackVersion: 1,
    operationId: "documents.search",
    operationVersion: 1,
    input: { query: "policy boundary" },
  },
  { type: "usage_reported", dimensions: { planning_units: 7 } },
];

const SECOND_EVENTS: readonly AgentDriverEvent[] = [
  {
    type: "content_completed",
    channel: "answer",
    content: textBlock("answer-1", "The gateway owns the boundary."),
  },
  { type: "outcome_proposed", outcome: outcome() },
  { type: "usage_reported", dimensions: { planning_units: 3 } },
  { type: "completed" },
];

function driverScript(): ScriptedAgentDriverScript {
  return {
    scriptId: "research-driver-golden-v1",
    turns: [
      { expectedRequest: turn(1), events: FIRST_EVENTS },
      { expectedRequest: turn(2, [observation()]), events: SECOND_EVENTS },
    ],
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function isDomainCode(error: unknown, code: string): boolean {
  return isDomainError(error) && error.code === code;
}

function firstAdvertisedOperation(request: AgentTurnRequest): Record<string, unknown> {
  const operation = request.advertisedOperations[0];
  assert.notEqual(operation, undefined);
  return operation as unknown as Record<string, unknown>;
}

function scriptWithRequestOperationMutation(
  mutate: (operation: Record<string, unknown>) => void,
): ScriptedAgentDriverScript {
  const script = structuredClone(driverScript()) as ScriptedAgentDriverScript;
  const request = script.turns[0]?.expectedRequest;
  assert.notEqual(request, undefined);
  mutate(firstAdvertisedOperation(request as AgentTurnRequest));
  return script;
}

function scriptWithActionMutation(
  mutate: (event: Record<string, unknown>) => void,
): ScriptedAgentDriverScript {
  const script = structuredClone(driverScript()) as ScriptedAgentDriverScript;
  const events = script.turns[0]?.events;
  assert.notEqual(events, undefined);
  const event = events?.find((candidate) => candidate.type === "action_proposed");
  assert.notEqual(event, undefined);
  mutate(event as unknown as Record<string, unknown>);
  return script;
}

test("asserts every turn input and emits deterministic immutable generic events", async () => {
  const mutableScript = structuredClone(driverScript()) as ScriptedAgentDriverScript;
  const driver = new ScriptedAgentDriver(mutableScript);
  const firstRequest = turn(1);
  const before = canonicalize(firstRequest);

  assert.equal(driver.descriptor.capabilities.credentialOwnership, "none");
  assert.equal(driver.descriptor.capabilities.cancellation, "confirmed");
  assert.equal(Object.isFrozen(driver.descriptor), true);
  assert.equal(Object.isFrozen(driver.descriptor.capabilities), true);

  const mutableTurns = mutableScript.turns as unknown as Array<{
    expectedRequest: AgentTurnRequest;
    events: AgentDriverEvent[];
  }>;
  mutableTurns[0]!.events[0] = {
    type: "content_delta",
    channel: "analysis",
    delta: "tampered",
  };
  (mutableTurns[0]!.expectedRequest as { turnNumber: number }).turnNumber = 99;

  const first = await collect(driver.advance(firstRequest, new AbortController().signal));
  const second = await collect(
    driver.advance(turn(2, [observation()]), new AbortController().signal),
  );
  const replayDriver = new ScriptedAgentDriver(driverScript());
  const replay = [
    ...(await collect(replayDriver.advance(turn(1), new AbortController().signal))),
    ...(await collect(
      replayDriver.advance(turn(2, [observation()]), new AbortController().signal),
    )),
  ];

  assert.deepEqual(first, FIRST_EVENTS);
  assert.deepEqual(second, SECOND_EVENTS);
  assert.deepEqual(replay, [...first, ...second]);
  assert.equal(canonicalize(firstRequest), before, "the caller's request was not mutated");
  assert.equal(Object.isFrozen(first[1]), true);
  assert.equal(
    Object.isFrozen((first[1] as { content: ContentBlock }).content),
    true,
  );
  assert.throws(() => {
    (first[0] as { delta: string }).delta = "changed";
  }, TypeError);
  driver.assertExhausted();
});

test("snapshots scripts before validation without invoking proxy get traps", async () => {
  const secret = "agent-driver-proxy-get-canary";
  let getCalls = 0;
  const proxied = new Proxy(driverScript(), {
    get() {
      getCalls += 1;
      throw new Error(secret);
    },
  });

  const driver = new ScriptedAgentDriver(proxied);
  assert.equal(getCalls, 0);
  assert.deepEqual(
    await collect(driver.advance(turn(1), new AbortController().signal)),
    FIRST_EVENTS,
  );
  assert.equal(getCalls, 0);
});

test("turn requests are detached before validation and hostile proxies fail safely", async () => {
  const secret = "agent-driver-hostile-request-canary";
  let getCalls = 0;
  const proxiedRequest = new Proxy(turn(1), {
    get() {
      getCalls += 1;
      throw new Error(secret);
    },
  });
  const driver = new ScriptedAgentDriver(driverScript());
  assert.deepEqual(
    await collect(driver.advance(proxiedRequest, new AbortController().signal)),
    FIRST_EVENTS,
  );
  assert.equal(getCalls, 0);

  const revocable = Proxy.revocable(driverScript(), {});
  revocable.revoke();
  assert.throws(
    () => new ScriptedAgentDriver(revocable.proxy),
    (error: unknown) => {
      assert.equal(isDomainCode(error, "invalid_input"), true);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );

  const hostile = new Proxy(driverScript(), {
    ownKeys() {
      throw createDomainError({ code: "driver_failed", message: secret });
    },
  });
  assert.throws(
    () => new ScriptedAgentDriver(hostile),
    (error: unknown) => {
      assert.equal(isDomainCode(error, "invalid_input"), true);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
});

test("fails closed for divergence in turn, objective, operations, context, or observations", async () => {
  const expected = turn(1);
  const differentPackId = structuredClone(expected);
  firstAdvertisedOperation(differentPackId)["capabilityPackId"] =
    "capability:other-documents";
  const differentPackVersion = structuredClone(expected);
  firstAdvertisedOperation(differentPackVersion)["capabilityPackVersion"] = 2;
  const divergences: readonly AgentTurnRequest[] = [
    turn(2),
    turn(1, [], { objective: objective("A different question") }),
    turn(1, [], { advertisedOperations: [] }),
    differentPackId,
    differentPackVersion,
    turn(1, [], { context: [textBlock("context-2", "Different context")] }),
    turn(1, [observation("denied")]),
  ];

  for (const divergent of divergences) {
    const driver = new ScriptedAgentDriver({
      scriptId: "single-turn",
      turns: [{ expectedRequest: expected, events: FIRST_EVENTS }],
    });
    await assert.rejects(
      collect(driver.advance(divergent, new AbortController().signal)),
      (error: unknown) => isDomainCode(error, "invariant_violated"),
    );
    assert.equal(driver.remainingTurns, 1, "a divergent request did not consume the turn");
  }
});

test("validates exact capability identity on requests, scripts, and proposals", () => {
  const requestMutations: readonly ((operation: Record<string, unknown>) => void)[] = [
    (operation) => { delete operation["capabilityPackId"]; },
    (operation) => { operation["capabilityPackId"] = ""; },
    (operation) => { delete operation["capabilityPackVersion"]; },
    (operation) => { operation["capabilityPackVersion"] = 0; },
    (operation) => { operation["capabilityPackVersion"] = -1; },
    (operation) => { operation["capabilityPackVersion"] = 1.5; },
    (operation) => { operation["capabilityPackVersion"] = "1"; },
  ];
  for (const mutate of requestMutations) {
    assert.throws(
      () => new ScriptedAgentDriver(scriptWithRequestOperationMutation(mutate)),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }

  const actionMutations: readonly ((event: Record<string, unknown>) => void)[] = [
    (event) => { delete event["capabilityPackId"]; },
    (event) => { event["capabilityPackId"] = ""; },
    (event) => { delete event["capabilityPackVersion"]; },
    (event) => { event["capabilityPackVersion"] = 0; },
    (event) => { event["capabilityPackVersion"] = -1; },
    (event) => { event["capabilityPackVersion"] = 1.5; },
    (event) => { event["capabilityPackVersion"] = "1"; },
  ];
  for (const mutate of actionMutations) {
    assert.throws(
      () => new ScriptedAgentDriver(scriptWithActionMutation(mutate)),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }

  assert.throws(
    () =>
      new ScriptedAgentDriver(
        scriptWithActionMutation((event) => {
          event["capabilityPackVersion"] = 2;
        }),
      ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("operation uniqueness and proposal matching include the pack identity", () => {
  const request = turn(1);
  const operation = request.advertisedOperations[0];
  assert.notEqual(operation, undefined);
  const withSameOperationInAnotherPack: AgentTurnRequest = {
    ...request,
    advertisedOperations: [
      operation!,
      {
        ...operation!,
        capabilityPackId: "capability:archive-documents",
        capabilityPackVersion: 3,
      },
    ],
  };
  assert.doesNotThrow(
    () =>
      new ScriptedAgentDriver({
        scriptId: "pack-qualified-operations",
        turns: [{ expectedRequest: withSameOperationInAnotherPack, events: FIRST_EVENTS }],
      }),
  );

  assert.throws(
    () =>
      new ScriptedAgentDriver({
        scriptId: "duplicate-pack-qualified-operation",
        turns: [
          {
            expectedRequest: {
              ...request,
              advertisedOperations: [operation!, structuredClone(operation!)],
            },
            events: FIRST_EVENTS,
          },
        ],
      }),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});

test("detects incomplete and exhausted scripts", async () => {
  const driver = new ScriptedAgentDriver(driverScript());
  assert.throws(
    () => driver.assertExhausted(),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );

  await collect(driver.advance(turn(1), new AbortController().signal));
  await collect(driver.advance(turn(2, [observation()]), new AbortController().signal));
  driver.assertExhausted();

  await assert.rejects(
    collect(driver.advance(turn(3), new AbortController().signal)),
    (error: unknown) => isDomainCode(error, "invariant_violated"),
  );
});

test("honors cancellation before and during a scripted turn", async () => {
  const beforeStart = new AbortController();
  beforeStart.abort();
  const untouched = new ScriptedAgentDriver(driverScript());
  await assert.rejects(
    collect(untouched.advance(turn(1), beforeStart.signal)),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
  assert.equal(untouched.remainingTurns, 2);

  const during = new AbortController();
  const driver = new ScriptedAgentDriver(driverScript());
  const iterator = driver.advance(turn(1), during.signal)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: FIRST_EVENTS[0] });
  during.abort("stop");
  await assert.rejects(
    iterator.next(),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );
});

test("rejects malformed scripts and events before a run begins", () => {
  const failure = createDomainError({
    code: "driver_failed",
    message: "Synthetic driver failure.",
  });
  const invalidScripts: readonly unknown[] = [
    { scriptId: "", turns: [] },
    { scriptId: "empty", turns: [] },
    {
      scriptId: "bad-turn",
      turns: [{ expectedRequest: turn(0), events: FIRST_EVENTS }],
    },
    {
      scriptId: "unknown-event",
      turns: [{ expectedRequest: turn(1), events: [{ type: "provider_event" }] }],
    },
    {
      scriptId: "terminal-not-last",
      turns: [
        {
          expectedRequest: turn(1),
          events: [{ type: "completed" }, FIRST_EVENTS[0]],
        },
      ],
    },
    {
      scriptId: "negative-usage",
      turns: [
        {
          expectedRequest: turn(1),
          events: [{ type: "usage_reported", dimensions: { planning_units: -1 } }],
        },
      ],
    },
    {
      scriptId: "failure-not-last",
      turns: [
        {
          expectedRequest: turn(1),
          events: [{ type: "failed", error: failure }, FIRST_EVENTS[0]],
        },
      ],
    },
  ];

  for (const invalid of invalidScripts) {
    assert.throws(
      () => new ScriptedAgentDriver(invalid as ScriptedAgentDriverScript),
      (error: unknown) => isDomainCode(error, "invalid_input"),
    );
  }
});

test("emits generic pauses and failures without model-provider vocabulary", async () => {
  const failure = createDomainError({
    code: "driver_failed",
    message: "Synthetic driver failure.",
  });
  const events: readonly AgentDriverEvent[] = [
    { type: "content_delta", channel: "analysis", delta: "Cannot continue." },
    { type: "failed", error: failure },
  ];
  const failed = new ScriptedAgentDriver({
    scriptId: "failed-turn",
    turns: [{ expectedRequest: turn(1), events }],
  });
  const pauseEvents: readonly AgentDriverEvent[] = [
    { type: "paused", reason: "awaiting_observation" },
  ];
  const paused = new ScriptedAgentDriver({
    scriptId: "paused-turn",
    turns: [{ expectedRequest: turn(1), events: pauseEvents }],
  });

  const failureOutput = await collect(
    failed.advance(turn(1), new AbortController().signal),
  );
  assert.deepEqual(failureOutput, events);
  assert.deepEqual(
    await collect(paused.advance(turn(1), new AbortController().signal)),
    pauseEvents,
  );
  assert.doesNotMatch(JSON.stringify(failureOutput), /provider|model/i);
});
