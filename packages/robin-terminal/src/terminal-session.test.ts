import assert from "node:assert/strict";
import test from "node:test";

import {
  TERMINAL_CLEANUP_BYTES,
  TERMINAL_OPEN_BYTES,
  TerminalSession,
  type SignalRegistrar,
} from "./terminal-session.js";

class Signals implements SignalRegistrar {
  readonly listeners = new Map<NodeJS.Signals, Set<() => void>>();
  readonly removed: NodeJS.Signals[] = [];

  on(signal: NodeJS.Signals, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: NodeJS.Signals, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
    this.removed.push(signal);
  }

  emit(signal: NodeJS.Signals): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

test("raw-mode lifecycle writes setup and exactly one idempotent cleanup", async () => {
  const rawModes: boolean[] = [];
  const writes: string[] = [];
  const signals = new Signals();
  const observedSignals: NodeJS.Signals[] = [];
  const input = {
    isTTY: true,
    isRaw: false,
    setRawMode(enabled: boolean) {
      rawModes.push(enabled);
    },
  };
  const session = new TerminalSession({
    input,
    output: { write: (bytes) => writes.push(bytes) },
    signals,
    onSignal: (signal) => observedSignals.push(signal),
  });

  const result = await session.run(async () => {
    signals.emit("SIGINT");
    return 42;
  });
  session.close();

  assert.equal(result, 42);
  assert.deepEqual(rawModes, [true, false]);
  assert.deepEqual(writes, [TERMINAL_OPEN_BYTES, TERMINAL_CLEANUP_BYTES]);
  assert.deepEqual(observedSignals, ["SIGINT"]);
  assert.deepEqual(signals.removed.sort(), ["SIGINT", "SIGTERM"]);
  assert.equal([...signals.listeners.values()].every((set) => set.size === 0), true);
  assert.equal(session.opened, true);
  assert.equal(session.closed, true);
});

test("operation failure remains first when cleanup also fails", async () => {
  const primary = new Error("operation failed");
  const restore = new Error("raw restore failed");
  let writes = 0;
  const session = new TerminalSession({
    input: {
      isTTY: true,
      isRaw: false,
      setRawMode(enabled: boolean) {
        if (!enabled) throw restore;
      },
    },
    output: {
      write() {
        writes += 1;
        if (writes === 2) throw new Error("cleanup write failed");
      },
    },
  });

  await assert.rejects(
    session.run(async () => {
      throw primary;
    }),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      const aggregate = error as AggregateError;
      assert.equal(aggregate.cause, primary);
      assert.equal(aggregate.errors[0], primary);
      assert.equal((aggregate.errors[1] as Error).message, "cleanup write failed");
      assert.equal(aggregate.errors[2], restore);
      return true;
    },
  );
});

test("setup failures attempt complete restoration and aggregate cleanup errors", () => {
  let raw = false;
  const session = new TerminalSession({
    input: {
      isTTY: true,
      get isRaw() {
        return raw;
      },
      setRawMode(enabled: boolean) {
        raw = enabled;
      },
    },
    output: {
      write() {
        throw new Error("writer unavailable");
      },
    },
  });
  assert.throws(
    () => session.open(),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal((error as AggregateError).errors.length, 2);
      return true;
    },
  );
  assert.equal(raw, false);
  assert.equal(session.closed, true);
});

test("closing an unopened session is inert and remains idempotent", () => {
  const rawModes: boolean[] = [];
  const writes: string[] = [];
  const session = new TerminalSession({
    input: {
      isTTY: true,
      isRaw: true,
      setRawMode: (enabled) => rawModes.push(enabled),
    },
    output: { write: (bytes) => writes.push(bytes) },
  });
  session.close();
  session.close();
  assert.deepEqual(rawModes, []);
  assert.deepEqual(writes, []);
  assert.equal(session.closed, true);
});
