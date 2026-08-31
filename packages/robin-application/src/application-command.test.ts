import assert from "node:assert/strict";
import test from "node:test";

import { isDomainError } from "@guard/contracts";

import {
  MAXIMUM_APPLICATION_MESSAGE_BYTES,
  parseRobinApplicationCommand,
} from "./application-command.js";

test("parses and freezes every R1 application command", () => {
  const commands = [
    {
      schemaVersion: 1,
      type: "start_session",
      sessionId: "session:test",
      permissionMode: "ask",
      providerProfile: "synthetic",
      modelId: "synthetic-r1-v1",
      maximumTurns: 16,
    },
    {
      schemaVersion: 1,
      type: "submit_message",
      sessionId: "session:test",
      commandId: "command:1",
      text: "Inspect the fixture.",
    },
    {
      schemaVersion: 1,
      type: "cancel_turn",
      sessionId: "session:test",
      reason: "user_interrupt",
    },
    {
      schemaVersion: 1,
      type: "set_permission_mode",
      sessionId: "session:test",
      permissionMode: "plan",
    },
    { schemaVersion: 1, type: "close_session", sessionId: "session:test" },
  ];
  for (const candidate of commands) {
    const parsed = parseRobinApplicationCommand(candidate);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(parsed.sessionId, "session:test");
  }
});

test("rejects unknown versions, types, keys, and invalid modes", () => {
  const candidates = [
    { schemaVersion: 2, type: "close_session", sessionId: "session:test" },
    { schemaVersion: 1, type: "unknown", sessionId: "session:test" },
    {
      schemaVersion: 1,
      type: "close_session",
      sessionId: "session:test",
      hidden: true,
    },
    {
      schemaVersion: 1,
      type: "set_permission_mode",
      sessionId: "session:test",
      permissionMode: "bypass",
    },
  ];
  for (const candidate of candidates) {
    assert.throws(
      () => parseRobinApplicationCommand(candidate),
      (error: unknown) => isDomainError(error) && error.code === "invalid_input",
    );
  }
});

test("rejects blank and oversized messages", () => {
  for (const text of ["   ", "x".repeat(MAXIMUM_APPLICATION_MESSAGE_BYTES + 1)]) {
    assert.throws(
      () =>
        parseRobinApplicationCommand({
          schemaVersion: 1,
          type: "submit_message",
          sessionId: "session:test",
          commandId: "command:1",
          text,
        }),
      (error: unknown) => isDomainError(error) && error.code === "invalid_input",
    );
  }
});

test("rejects proxies and accessors without invoking them", () => {
  let invoked = false;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(accessor, {
    schemaVersion: { value: 1, enumerable: true },
    type: {
      get() {
        invoked = true;
        return "close_session";
      },
      enumerable: true,
    },
    sessionId: { value: "session:test", enumerable: true },
  });
  assert.throws(() => parseRobinApplicationCommand(accessor));
  assert.equal(invoked, false);
  assert.throws(() => parseRobinApplicationCommand(new Proxy({}, {})));
});
