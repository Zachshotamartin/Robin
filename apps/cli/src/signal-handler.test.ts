import assert from "node:assert/strict";
import test from "node:test";

import {
  InteractiveInterruptController,
  InterruptEscalator,
} from "./signal-handler.js";

test("a second interrupt inside the window forces exit", () => {
  let now = 100;
  const handler = new InterruptEscalator({ now: () => now, windowMs: 750 });
  assert.equal(handler.interrupt(), "cancel");
  assert.equal(handler.armed, true);
  now = 849;
  assert.equal(handler.interrupt(), "force_exit");
  assert.equal(handler.armed, false);
});

test("expired and reset interrupt windows begin a new cancellation", () => {
  let now = 100;
  const handler = new InterruptEscalator({ now: () => now, windowMs: 10 });
  assert.equal(handler.interrupt(), "cancel");
  now = 111;
  assert.equal(handler.interrupt(), "cancel");
  handler.reset();
  assert.equal(handler.armed, false);
  assert.equal(handler.interrupt(), "cancel");
});

test("an outside-window interrupt re-requests cancellation before escalation", () => {
  let now = 100;
  const controller = new InteractiveInterruptController(
    new InterruptEscalator({ now: () => now, windowMs: 10 }),
  );

  assert.equal(controller.interrupt("working"), "apply_key");
  now = 111;
  assert.equal(controller.interrupt("cancelling"), "request_cancel");
  now = 120;
  assert.equal(controller.interrupt("cancelling"), "force_exit");
});

test("terminal settlement resets escalation before idle input handling", () => {
  let now = 100;
  const controller = new InteractiveInterruptController(
    new InterruptEscalator({ now: () => now, windowMs: 750 }),
  );

  assert.equal(controller.interrupt("working"), "apply_key");
  controller.reset();
  now = 101;
  assert.equal(controller.interrupt("ready"), "apply_key");
});
