import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import {
  ActionIdKind,
  ApprovalIdKind,
  PolicyVersionIdKind,
  canonicalSha256Hex,
} from "@guard/contracts";
import {
  R1RobinApplication,
  type R1RobinApplicationOptions,
  type RobinApplicationToolDispatcherFactory,
} from "@guard/robin-application";

import type { InteractiveCliRequest } from "./argv.js";
import {
  executeInteractiveSession,
  type InteractiveOutput,
} from "./interactive.js";

const REQUEST: InteractiveCliRequest = Object.freeze({
  kind: "interactive",
  prompt: "Apply the exact fixture repair.",
  provider: "synthetic",
  model: null,
  permissionMode: "ask",
});
const ACTION_ID = ActionIdKind.parse(
  "act_018f05a0-7b01-7000-8000-000000000391",
);
const APPROVAL_ID = ApprovalIdKind.parse(
  "apr_018f05a0-7b01-7000-8000-000000000392",
);
const POLICY_VERSION_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000393",
);
const SUMMARY = Object.freeze({
  schemaVersion: 1,
  operation: "Replace exact text in src/calculate.ts",
  beforeHash: "a".repeat(64),
  afterHash: "b".repeat(64),
  sandboxed: false,
});
const HASHES = Object.freeze({
  action: "1".repeat(64),
  request: "2".repeat(64),
  precondition: "3".repeat(64),
  policy: "4".repeat(64),
});
const TOOL_NAME = "test.interactive.approval.mutate@1";
let nextSession = 0;

test(
  "flat approval shows complete scope and routes only an exact explicit decision",
  { timeout: 5_000 },
  async () => {
    const input = new PassThrough();
    const application = approvalApplication();
    let rendered = "";
    let rejectedInputs = 0;
    let sentEmpty = false;
    let sentUnrelated = false;
    let sentApproval = false;
    let ended = false;
    const output = {
      write(chunk: string) {
        rendered += chunk;
        if (!sentEmpty && chunk.includes("Decision: type exactly")) {
          sentEmpty = true;
          queueMicrotask(() => input.write("\n"));
        } else if (chunk.includes("approval_decision_required")) {
          rejectedInputs += 1;
          if (!sentUnrelated) {
            sentUnrelated = true;
            queueMicrotask(() => input.write("unrelated prompt text\n"));
          } else if (!sentApproval) {
            sentApproval = true;
            queueMicrotask(() => input.write("allow-once\n"));
          }
        } else if (!ended && chunk.startsWith("[completed]")) {
          ended = true;
          queueMicrotask(() => input.end());
        }
      },
    };

    const code = await executeInteractiveSession(
      REQUEST,
      application,
      input,
      output,
      { write() {} },
      { TERM: "dumb", LANG: "en_US.UTF-8" },
    );

    assert.equal(code, 0);
    assert.equal(rejectedInputs, 2);
    assert.equal(sentApproval, true);
    assert.match(rendered, /Approval ID: apr_018f05a0/u);
    assert.match(rendered, /Action ID: act_018f05a0/u);
    assert.match(rendered, /Normalized request hash: 2{64}/u);
    assert.match(rendered, /Precondition hash: 3{64}/u);
    assert.match(rendered, /Policy snapshot hash: 4{64}/u);
    assert.match(
      rendered,
      /Canonical summary: \{"afterHash":"b{64}","beforeHash":"a{64}"/u,
    );
    assert.match(rendered, /decision=allow_once outcome=granted/u);
    assert.equal(rendered.includes("\u001b"), false);
    assert.equal(
      application.snapshot.events.filter(
        (event) => event.type === "UserMessageAccepted",
      ).length,
      1,
    );
    const resolution = application.snapshot.events.find(
      (event) => event.type === "ApprovalResolved",
    );
    assert.equal(resolution?.payload.decision, "allow_once");
    assert.equal(resolution?.payload.outcome, "granted");
  },
);

test(
  "flat EOF while approval is pending cancels without granting authority",
  { timeout: 5_000 },
  async () => {
    const application = approvalApplication();
    const rendered: string[] = [];
    const code = await executeInteractiveSession(
      REQUEST,
      application,
      Readable.from([]),
      { write: (chunk: string) => rendered.push(chunk) },
      { write() {} },
      { TERM: "dumb", LANG: "en_US.UTF-8" },
    );

    assert.equal(code, 0);
    assert.equal(
      application.snapshot.events.some((event) => event.type === "ApprovalResolved"),
      false,
    );
    assert.equal(
      application.snapshot.events.some((event) => event.type === "TurnCancelled"),
      true,
    );
    assert.match(rendered.join(""), /Approval required/u);
  },
);

test(
  "raw approval survives resize, rejects empty Enter, and records denial",
  { timeout: 5_000 },
  async () => {
    const terminal = rawTerminal();
    const application = approvalApplication();
    let rendered = "";
    let resized = false;
    let sentEmpty = false;
    let sentDeny = false;
    let closed = false;
    terminal.output.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      rendered += text;
      if (!resized && text.includes("Canonical summary:")) {
        resized = true;
        terminal.resize(101, 31);
      }
      if (!sentEmpty && text.includes("Decision: type exactly")) {
        sentEmpty = true;
        queueMicrotask(() => terminal.input.write("\r"));
      } else if (!sentDeny && text.includes("approval_decision_required")) {
        sentDeny = true;
        queueMicrotask(() => terminal.input.write("deny\r"));
      } else if (!closed && sentDeny && text.includes("Robin · ready")) {
        closed = true;
        queueMicrotask(() => terminal.input.write(Buffer.from([0x04])));
      }
    });

    const code = await executeInteractiveSession(
      REQUEST,
      application,
      terminal.input,
      terminal.output,
      { write() {} },
      { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    );

    assert.equal(code, 0);
    assert.equal(resized, true);
    assert.equal(sentEmpty, true);
    assert.equal(sentDeny, true);
    assert.match(rendered, /Approval ID: apr_018f05a0/u);
    assert.match(rendered, /Canonical summary:/u);
    assert.match(rendered, /no execution authority was granted/u);
    const resolution = application.snapshot.events.find(
      (event) => event.type === "ApprovalResolved",
    );
    assert.equal(resolution?.payload.decision, "deny");
    assert.equal(resolution?.payload.outcome, "denied");
    assert.deepEqual(terminal.rawModes, [true, false]);
  },
);

test(
  "raw Ctrl-D and Ctrl-C during approval can never approve",
  { timeout: 5_000 },
  async () => {
    const terminal = rawTerminal();
    const application = approvalApplication();
    let sentSafetyControls = false;
    let closed = false;
    terminal.output.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (!sentSafetyControls && text.includes("Decision: type exactly")) {
        sentSafetyControls = true;
        queueMicrotask(() => {
          terminal.input.write(Buffer.from([0x04]));
          terminal.input.write(Buffer.from([0x03]));
        });
      } else if (!closed && sentSafetyControls && text.includes("Robin · ready")) {
        closed = true;
        queueMicrotask(() => terminal.input.write(Buffer.from([0x04])));
      }
    });

    const code = await executeInteractiveSession(
      REQUEST,
      application,
      terminal.input,
      terminal.output,
      { write() {} },
      { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    );

    assert.equal(code, 0);
    assert.equal(sentSafetyControls, true);
    assert.equal(
      application.snapshot.events.some((event) => event.type === "ApprovalResolved"),
      false,
    );
    assert.equal(
      application.snapshot.events.some((event) => event.type === "TurnCancelled"),
      true,
    );
    assert.deepEqual(terminal.rawModes, [true, false]);
  },
);

function approvalApplication(): R1RobinApplication {
  nextSession += 1;
  let timestamp = 0;
  return new R1RobinApplication({
    sessionId: `interactive-approval-${nextSession}`,
    provider: approvalProvider(),
    modelId: "interactive-approval-v1",
    now: () =>
      new Date(Date.UTC(2026, 7, 30, 2, 0, timestamp++)).toISOString(),
    monotonicNow: () => timestamp,
    toolDispatcherFactory: approvalDispatcherFactory(),
  });
}

function approvalProvider(): NonNullable<R1RobinApplicationOptions["provider"]> {
  return {
    descriptor: Object.freeze({
      adapterId: "interactive-approval-provider",
      adapterVersion: "1.0.0",
      capabilities: Object.freeze({
        streaming: true,
        structuredActions: true,
        exactUsage: false,
        cancellation: "confirmed" as const,
      }),
    }),
    async *respond(request, signal) {
      if (signal.aborted) return;
      const observed = request.conversation.some(
        (item) => item.role === "operation",
      );
      if (!observed) {
        yield {
          type: "action_started",
          callId: "interactive-approval-call-1",
          capabilityPackId: "test.interactive.approval",
          capabilityPackVersion: 1,
          operationId: "mutate",
          operationVersion: 1,
        };
        yield {
          type: "action_arguments_delta",
          callId: "interactive-approval-call-1",
          delta: "{}",
        };
        yield {
          type: "action_completed",
          callId: "interactive-approval-call-1",
          capabilityPackId: "test.interactive.approval",
          capabilityPackVersion: 1,
          operationId: "mutate",
          operationVersion: 1,
          arguments: {},
        };
        yield { type: "response_completed", finishReason: "action_required" };
        return;
      }
      yield { type: "text_delta", outputIndex: 0, delta: "Settled safely." };
      yield { type: "response_completed", finishReason: "stop" };
    },
  };
}

function approvalDispatcherFactory(): RobinApplicationToolDispatcherFactory {
  return (lifecycle) => ({
    advertisedOperations: Object.freeze([
      Object.freeze({
        capabilityPackId: "test.interactive.approval",
        capabilityPackVersion: 1,
        operationId: "mutate",
        operationVersion: 1,
        description: "Exercise terminal approval routing.",
        inputSchema: Object.freeze({
          type: "object",
          additionalProperties: false,
          properties: Object.freeze({}),
        }),
      }),
    ]),
    async dispatch(call, signal) {
      const binding = approvalBinding();
      lifecycle.permissionDecided({
        actionHash: HASHES.action,
        actionId: ACTION_ID,
        callId: call.callId,
        effect: "require_approval",
        policySnapshotHash: HASHES.policy,
        policyVersionId: POLICY_VERSION_ID,
        toolName: TOOL_NAME,
        winningPolicyName: "interactive-approval-test",
      });
      const decision = await lifecycle.requestApproval(
        {
          ...binding,
          callId: call.callId,
          toolName: TOOL_NAME,
          displayedSummary: SUMMARY,
        },
        signal,
      );
      lifecycle.approvalResolved({
        ...binding,
        callId: call.callId,
        toolName: TOOL_NAME,
        decision,
        outcome: decision === "allow_once" ? "granted" : "denied",
        resolvedAt: "2026-08-30T02:00:02.000Z",
      });
      return Object.freeze({
        schemaVersion: 1,
        status: decision === "allow_once" ? "executed" : "denied",
        effectOccurred: decision === "allow_once",
      });
    },
  });
}

function approvalBinding() {
  return Object.freeze({
    actionHash: HASHES.action,
    actionId: ACTION_ID,
    approvalId: APPROVAL_ID,
    displayedSummaryHash: canonicalSha256Hex(SUMMARY),
    expiresAt: "2026-08-30T02:05:00.000Z",
    normalizedRequestHash: HASHES.request,
    policySnapshotHash: HASHES.policy,
    preconditionHash: HASHES.precondition,
    requestedAt: "2026-08-30T02:00:01.000Z",
  });
}

function rawTerminal(): {
  readonly input: PassThrough;
  readonly output: PassThrough & InteractiveOutput;
  readonly rawModes: boolean[];
  resize(columns: number, rows: number): void;
} {
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & InteractiveOutput;
  const rawModes: boolean[] = [];
  let isRaw = false;
  let columns = 80;
  let rows = 24;
  Object.defineProperties(input, {
    isTTY: { value: true },
    isRaw: { get: () => isRaw },
    setRawMode: {
      value: (enabled: boolean) => {
        isRaw = enabled;
        rawModes.push(enabled);
      },
    },
  });
  Object.defineProperties(output, {
    isTTY: { value: true },
    columns: { get: () => columns },
    rows: { get: () => rows },
  });
  return {
    input,
    output,
    rawModes,
    resize(nextColumns: number, nextRows: number) {
      columns = nextColumns;
      rows = nextRows;
      output.emit("resize");
    },
  };
}
