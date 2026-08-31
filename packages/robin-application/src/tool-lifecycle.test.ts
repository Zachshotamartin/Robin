import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionIdKind,
  ApprovalIdKind,
  PolicyVersionIdKind,
  canonicalSha256Hex,
  type JsonObject,
} from "@guard/contracts";
import type {
  ModelProvider,
  ModelProviderEvent,
  SemanticModelRequest,
} from "@guard/model-provider";
import type { ToolDispatcher } from "@guard/robin-agent";
import type {
  RobinApplicationEvent,
  RobinApprovalDecision,
} from "@guard/robin-session";

import { R1RobinApplication } from "./session-service.js";
import type {
  RobinApplicationToolDispatcherFactory,
  RobinApplicationToolLifecycle,
} from "./tool-lifecycle.js";

const TOOL_NAME = "test.approval.mutate@1";
const ACTION_ID = ActionIdKind.parse(
  "act_018f05a0-7b01-7000-8000-000000000191",
);
const APPROVAL_ID = ApprovalIdKind.parse(
  "apr_018f05a0-7b01-7000-8000-000000000192",
);
const POLICY_VERSION_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000193",
);
const HASHES = Object.freeze({
  action: "1".repeat(64),
  request: "2".repeat(64),
  precondition: "3".repeat(64),
  policy: "4".repeat(64),
});
const DISPLAYED_SUMMARY = Object.freeze({
  schemaVersion: 1,
  operation: "Mutate the deterministic fixture",
  sandboxed: false,
});
let nextApprovalSession = 0;

test("application commits an exact one-use allow-once approval lifecycle", async () => {
  const app = approvalApplication();
  const events: RobinApplicationEvent[] = [];
  for await (const event of app.submit(
    "Request the fixture mutation.",
    new AbortController().signal,
  )) {
    events.push(event);
    if (event.type === "ApprovalRequested") {
      assert.equal(app.resolveApproval("apr_wrong", "allow_once"), false);
      assert.equal(
        app.resolveApproval(event.payload.approvalId, "allow_once"),
        true,
      );
      assert.equal(
        app.resolveApproval(event.payload.approvalId, "allow_once"),
        false,
      );
    }
  }

  assert.deepEqual(toolLifecycle(events), [
    "ToolCallStarted",
    "PermissionDecided",
    "ApprovalRequested",
    "ApprovalResolved",
    "ToolCallCompleted",
  ]);
  const resolved = events.find((event) => event.type === "ApprovalResolved");
  assert.equal(resolved?.payload.decision, "allow_once");
  assert.equal(resolved?.payload.outcome, "granted");
  assert.equal(app.snapshot.events.at(-1)?.type, "TurnCompleted");
});

test("denial is a no-effect observation and cancellation cannot approve", async () => {
  const denied = approvalApplication();
  const deniedEvents: RobinApplicationEvent[] = [];
  for await (const event of denied.submit(
    "Deny the mutation.",
    new AbortController().signal,
  )) {
    deniedEvents.push(event);
    if (event.type === "ApprovalRequested") {
      assert.equal(denied.resolveApproval(event.payload.approvalId, "deny"), true);
    }
  }
  const completed = deniedEvents.find(
    (event) => event.type === "ToolCallCompleted",
  );
  assert.deepEqual(completed?.payload.observation, {
    schemaVersion: 1,
    status: "denied",
    effectOccurred: false,
  });

  const cancelled = approvalApplication();
  const controller = new AbortController();
  let displayedApprovalId: string | null = null;
  const cancelledEvents: RobinApplicationEvent[] = [];
  for await (const event of cancelled.submit(
    "Cancel the approval.",
    controller.signal,
  )) {
    cancelledEvents.push(event);
    if (event.type === "ApprovalRequested") {
      displayedApprovalId = event.payload.approvalId;
      controller.abort("test cancellation");
    }
  }
  assert.notEqual(displayedApprovalId, null);
  assert.equal(cancelled.resolveApproval(displayedApprovalId!, "allow_once"), false);
  assert.deepEqual(
    cancelledEvents
      .filter((event) =>
        [
          "ApprovalRequested",
          "TurnCancellationRequested",
          "ToolCallFailed",
          "TurnCancelled",
        ].includes(event.type),
      )
      .map((event) => event.type),
    [
      "ApprovalRequested",
      "TurnCancellationRequested",
      "ToolCallFailed",
      "TurnCancelled",
    ],
  );
});

function approvalApplication(): R1RobinApplication {
  let timestamp = 0;
  nextApprovalSession += 1;
  return new R1RobinApplication({
    sessionId: `session:approval-${nextApprovalSession}`,
    provider: approvalProvider(),
    modelId: "approval-test-v1",
    now: () =>
      new Date(Date.UTC(2026, 7, 30, 2, 0, timestamp++)).toISOString(),
    monotonicNow: () => timestamp,
    toolDispatcherFactory: approvalDispatcherFactory(),
  });
}

function approvalProvider(): ModelProvider {
  return {
    descriptor: Object.freeze({
      adapterId: "approval-test-provider",
      adapterVersion: "1.0.0",
      capabilities: Object.freeze({
        streaming: true,
        structuredActions: true,
        exactUsage: false,
        cancellation: "confirmed" as const,
      }),
    }),
    async *respond(
      request: SemanticModelRequest,
      signal: AbortSignal,
    ): AsyncIterable<ModelProviderEvent> {
      if (signal.aborted) return;
      const observed = request.conversation.some(
        (item) => item.role === "operation",
      );
      if (!observed) {
        yield {
          type: "action_started",
          callId: "approval-call-1",
          capabilityPackId: "test.approval",
          capabilityPackVersion: 1,
          operationId: "mutate",
          operationVersion: 1,
        };
        yield {
          type: "action_arguments_delta",
          callId: "approval-call-1",
          delta: "{}",
        };
        yield {
          type: "action_completed",
          callId: "approval-call-1",
          capabilityPackId: "test.approval",
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
  return (lifecycle: RobinApplicationToolLifecycle): ToolDispatcher => ({
    advertisedOperations: Object.freeze([
      Object.freeze({
        capabilityPackId: "test.approval",
        capabilityPackVersion: 1,
        operationId: "mutate",
        operationVersion: 1,
        description: "Exercise the application approval boundary.",
        inputSchema: Object.freeze({
          type: "object",
          additionalProperties: false,
          properties: Object.freeze({}),
        }),
      }),
    ]),
    async dispatch(call, signal): Promise<JsonObject> {
      const binding = approvalBinding();
      lifecycle.permissionDecided({
        actionHash: HASHES.action,
        actionId: ACTION_ID,
        callId: call.callId,
        effect: "require_approval",
        policySnapshotHash: HASHES.policy,
        policyVersionId: POLICY_VERSION_ID,
        toolName: TOOL_NAME,
        winningPolicyName: "approval-test",
      });
      const decision = await lifecycle.requestApproval(
        {
          ...binding,
          callId: call.callId,
          toolName: TOOL_NAME,
          displayedSummary: DISPLAYED_SUMMARY,
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
      return decisionObservation(decision);
    },
  });
}

function approvalBinding() {
  return Object.freeze({
    actionHash: HASHES.action,
    actionId: ACTION_ID,
    approvalId: APPROVAL_ID,
    displayedSummaryHash: canonicalSha256Hex(DISPLAYED_SUMMARY),
    expiresAt: "2026-08-30T02:05:00.000Z",
    normalizedRequestHash: HASHES.request,
    policySnapshotHash: HASHES.policy,
    preconditionHash: HASHES.precondition,
    requestedAt: "2026-08-30T02:00:01.000Z",
  });
}

function decisionObservation(decision: RobinApprovalDecision): JsonObject {
  return Object.freeze({
    schemaVersion: 1,
    status: decision === "allow_once" ? "executed" : "denied",
    effectOccurred: decision === "allow_once",
  });
}

function toolLifecycle(events: readonly RobinApplicationEvent[]): readonly string[] {
  return events
    .filter((event) => "callId" in event.payload)
    .map((event) => event.type);
}
