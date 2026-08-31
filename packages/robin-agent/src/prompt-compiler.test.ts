import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentAttemptIdKind,
  canonicalBytes,
  isDomainError,
} from "@guard/contracts";
import type { SemanticOperationDefinition } from "@guard/model-provider";

import {
  PromptCompiler,
  createAssistantConversationItem,
  createOperationObservationItem,
  createUserConversationItem,
} from "./index.js";

const ATTEMPT_ID = AgentAttemptIdKind.parse(
  "att_018f05a0-7b01-7000-8000-000000000001",
);
const TIMESTAMP = "2026-08-30T00:00:00.000Z";

function operation(): SemanticOperationDefinition {
  return {
    capabilityPackId: "robin.coding",
    capabilityPackVersion: 1,
    operationId: "workspace.read_text",
    operationVersion: 1,
    description: "Read bounded UTF-8 text from the workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" } },
    },
  };
}

function domainCode(code: string): (error: unknown) => boolean {
  return (error) => isDomainError(error) && error.code === code;
}

test("builds stable text and correlated JSON conversation items", () => {
  const user = createUserConversationItem({
    sessionId: "session-1",
    turnNumber: 1,
    text: "Read the file.",
    capturedAt: TIMESTAMP,
  });
  const assistant = createAssistantConversationItem({
    sessionId: "session-1",
    turnNumber: 1,
    requestNumber: 1,
    text: "I will inspect it.",
    capturedAt: TIMESTAMP,
  });
  const observationValue = { path: "README.md", text: "hello" };
  const observation = createOperationObservationItem({
    sessionId: "session-1",
    turnNumber: 1,
    requestNumber: 1,
    callId: "call-1",
    observation: observationValue,
    capturedAt: TIMESTAMP,
  });

  assert.equal(user.role, "user");
  assert.equal(user.content[0]?.modality, "text");
  assert.equal(assistant.role, "assistant");
  assert.equal(observation.role, "operation");
  assert.equal(observation.correlationId, "call-1");
  assert.equal(
    observation.content[0]?.byteLength,
    canonicalBytes(observationValue).byteLength,
  );
  assert.equal(Object.isFrozen(observation.content[0]), true);
  assert.equal(
    createUserConversationItem({
      sessionId: "session-1",
      turnNumber: 1,
      text: "Read the file.",
      capturedAt: TIMESTAMP,
    }).content[0]?.blockId,
    user.content[0]?.blockId,
  );
});

test("preserves bounded opaque provider call IDs as observation correlations", () => {
  for (const callId of ["call id", "调用-1", "tool 🔧 request"]) {
    const observation = createOperationObservationItem({
      sessionId: "session-1",
      turnNumber: 1,
      requestNumber: 1,
      callId,
      observation: { ok: true },
      capturedAt: TIMESTAMP,
    });
    assert.equal(observation.correlationId, callId);
  }

  for (const callId of [
    "",
    "   ",
    "call\n1",
    "call\u20281",
    "\ud800",
    "x".repeat(257),
  ]) {
    assert.throws(
      () =>
        createOperationObservationItem({
          sessionId: "session-1",
          turnNumber: 1,
          requestNumber: 1,
          callId,
          observation: { ok: true },
          capturedAt: TIMESTAMP,
        }),
      domainCode("invalid_input"),
    );
  }
});

test("compiles provider-neutral structured requests and snapshots advertisements", () => {
  const mutableOperation = operation();
  const compiler = new PromptCompiler({
    sessionId: "session-1",
    modelId: "synthetic-coding-v1",
    instructions: ["Use only observable tool results."],
    operations: [mutableOperation],
    maximumOutputUnits: 4096,
  });
  (mutableOperation.inputSchema as { required: string[] }).required[0] = "tampered";
  const user = createUserConversationItem({
    sessionId: "session-1",
    turnNumber: 1,
    text: "Read README.md.",
    capturedAt: TIMESTAMP,
  });

  const request = compiler.compile({
    attemptId: ATTEMPT_ID,
    turnNumber: 1,
    requestNumber: 2,
    conversation: [user],
    maximumOutputUnits: 2048,
  });

  assert.equal(request.schemaVersion, 1);
  assert.equal(request.actionMode, "structured");
  assert.equal(request.maximumOutputUnits, 2048);
  assert.equal(request.model.modelId, "synthetic-coding-v1");
  assert.deepEqual(request.model.settings, {});
  assert.deepEqual(request.metadata, {
    sessionId: "session-1",
    turnNumber: 1,
    requestNumber: 2,
  });
  assert.deepEqual(request.operations[0]?.inputSchema["required"], ["path"]);
  assert.equal(Object.isFrozen(request.operations[0]?.inputSchema), true);
  assert.equal(request.conversation[0], user);
});

test("uses action mode none when no tool operations are advertised", () => {
  const compiler = new PromptCompiler({
    sessionId: "session-1",
    modelId: "synthetic-coding-v1",
    instructions: ["Answer safely."],
    operations: [],
    maximumOutputUnits: 100,
  });
  const request = compiler.compile({
    attemptId: ATTEMPT_ID,
    turnNumber: 1,
    requestNumber: 1,
    conversation: [
      createUserConversationItem({
        sessionId: "session-1",
        turnNumber: 1,
        text: "Hello.",
        capturedAt: TIMESTAMP,
      }),
    ],
  });
  assert.equal(request.actionMode, "none");
  assert.deepEqual(request.operations, []);
});

test("rejects duplicate operation identities, invalid timestamps, and empty conversations", () => {
  assert.throws(
    () =>
      new PromptCompiler({
        sessionId: "session-1",
        modelId: "synthetic-coding-v1",
        instructions: ["Safe."],
        operations: [operation(), operation()],
        maximumOutputUnits: 100,
      }),
    domainCode("conflict"),
  );
  assert.throws(
    () =>
      createUserConversationItem({
        sessionId: "session-1",
        turnNumber: 1,
        text: "Hello.",
        capturedAt: "not-a-timestamp",
      }),
    domainCode("infrastructure_failed"),
  );

  const compiler = new PromptCompiler({
    sessionId: "session-1",
    modelId: "synthetic-coding-v1",
    instructions: ["Safe."],
    operations: [],
    maximumOutputUnits: 100,
  });
  assert.throws(
    () =>
      compiler.compile({
        attemptId: ATTEMPT_ID,
        turnNumber: 1,
        requestNumber: 1,
        conversation: [],
      }),
    domainCode("invalid_input"),
  );
  assert.throws(
    () =>
      compiler.compile({
        attemptId: "wrong-brand" as typeof ATTEMPT_ID,
        turnNumber: 1,
        requestNumber: 1,
        conversation: [
          createUserConversationItem({
            sessionId: "session-1",
            turnNumber: 1,
            text: "Hello.",
            capturedAt: TIMESTAMP,
          }),
        ],
      }),
    domainCode("invalid_input"),
  );
});
