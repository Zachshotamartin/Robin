import assert from "node:assert/strict";
import test from "node:test";

import { detectTerminalCapabilities } from "./terminal-capabilities.js";

test("detects rich interactive, non-TTY, dumb, and machine terminal tiers", () => {
  const rich = detectTerminalCapabilities({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    term: "xterm-256color",
    locale: "en_US.UTF-8",
    columns: 120,
    rows: 40,
  });
  assert.deepEqual(rich, {
    inputIsTTY: true,
    outputIsTTY: true,
    interactive: true,
    machineMode: false,
    flat: false,
    rawMode: true,
    cursorAddressing: true,
    color: true,
    unicode: true,
    reducedMotion: false,
    hyperlinks: true,
    screenReader: false,
    dimensionsKnown: true,
    columns: 120,
    rows: 40,
    reason: "interactive",
  });

  const nonTty = detectTerminalCapabilities({
    stdinIsTTY: false,
    stdoutIsTTY: false,
    locale: "C",
  });
  assert.equal(nonTty.flat, true);
  assert.equal(nonTty.rawMode, false);
  assert.equal(nonTty.unicode, false);
  assert.equal(nonTty.reason, "non-tty");
  assert.equal(nonTty.columns, 80);
  assert.equal(nonTty.rows, 24);
  assert.equal(nonTty.dimensionsKnown, false);

  const dumb = detectTerminalCapabilities({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    term: "dumb",
  });
  assert.equal(dumb.flat, true);
  assert.equal(dumb.cursorAddressing, false);
  assert.equal(dumb.reason, "term-dumb");

  const machine = detectTerminalCapabilities({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    machineMode: true,
    colorOverride: true,
    hyperlinkOverride: true,
  });
  assert.equal(machine.interactive, false);
  assert.equal(machine.machineMode, true);
  assert.equal(machine.flat, true);
  assert.equal(machine.rawMode, false);
  assert.equal(machine.color, false);
  assert.equal(machine.hyperlinks, false);
  assert.equal(machine.reason, "machine");
});

test("honors no-color, CI, accessibility, dimensions, and explicit overrides", () => {
  const ci = detectTerminalCapabilities({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    term: "xterm",
    ci: "1",
    noColor: "1",
    columns: 0,
    rows: Number.NaN,
  });
  assert.equal(ci.color, false);
  assert.equal(ci.hyperlinks, false);
  assert.equal(ci.reducedMotion, true);
  assert.equal(ci.dimensionsKnown, false);

  const accessible = detectTerminalCapabilities({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    screenReader: true,
    noColor: "1",
    locale: "C",
    colorOverride: false,
    unicodeOverride: true,
    reducedMotionOverride: false,
    hyperlinkOverride: false,
  });
  assert.equal(accessible.flat, true);
  assert.equal(accessible.screenReader, true);
  assert.equal(accessible.unicode, true);
  assert.equal(accessible.reducedMotion, false);
  assert.equal(accessible.reason, "screen-reader");
  assert.equal(Object.isFrozen(accessible), true);
});
