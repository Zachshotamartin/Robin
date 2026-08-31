import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import {
  createR1RobinApplication,
  type R1RobinApplication,
} from "@guard/robin-application";

import { CliUsageError } from "./argv.js";
import {
  executeSessionCommand,
  sanitizeTerminalDiagnostic,
  sanitizeTerminalText,
  type SessionCommandDependencies,
} from "./session-command.js";
import { InterruptEscalator } from "./signal-handler.js";

function writer(): { write(chunk: string): void; value: string } {
  return {
    value: "",
    write(chunk: string) {
      this.value += chunk;
    },
  };
}

function dependencies(
  input: SessionCommandDependencies["input"] = Readable.from([]),
  overrides: Partial<SessionCommandDependencies> = {},
): SessionCommandDependencies {
  return {
    input,
    environment: { TERM: "dumb", LANG: "en_US.UTF-8" },
    createApplication: createR1RobinApplication,
    nextSessionId: () => "ephemeral-r1-cli-test",
    ...overrides,
  };
}

function requireApplication(
  application: R1RobinApplication | null,
): R1RobinApplication {
  if (application === null) throw new Error("application was not created");
  return application;
}

function rawInput(): {
  readonly input: PassThrough;
  readonly rawModes: boolean[];
  readonly isRaw: () => boolean;
} {
  const input = new PassThrough();
  const rawModes: boolean[] = [];
  let currentRawMode = false;
  Object.defineProperties(input, {
    isTTY: { value: true },
    isRaw: { get: () => currentRawMode },
    setRawMode: {
      value: (enabled: boolean) => {
        currentRawMode = enabled;
        rawModes.push(enabled);
      },
    },
  });
  return { input, rawModes, isRaw: () => currentRawMode };
}

function rawOutput(): PassThrough {
  const output = new PassThrough();
  Object.defineProperties(output, {
    isTTY: { value: true },
    columns: { value: 80 },
    rows: { value: 24 },
  });
  return output;
}

test("headless text and JSON use the complete two-tool coordinator", async () => {
  const textOut = writer();
  const textCode = await executeSessionCommand(
    {
      kind: "print",
      prompt: "Why does the fixture fail?",
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
      outputFormat: "text",
      save: false,
      maximumTurns: 16,
    },
    textOut,
    writer(),
    dependencies(),
  );
  assert.equal(textCode, 0);
  assert.match(textOut.value, /src\/calculate\.ts/u);
  assert.match(textOut.value, /total - value/u);

  const jsonOut = writer();
  await executeSessionCommand(
    {
      kind: "print",
      prompt: "Why does the fixture fail?",
      provider: "synthetic",
      model: null,
      permissionMode: "plan",
      outputFormat: "json",
      save: false,
      maximumTurns: 7,
    },
    jsonOut,
    writer(),
    dependencies(),
  );
  const decoded = JSON.parse(jsonOut.value) as {
    readonly status: string;
    readonly stability: string;
    readonly permissionMode: string;
    readonly permissions: string;
    readonly usedAgentTurns: number;
    readonly result: string;
    readonly events: readonly { readonly sequence: number; readonly type: string }[];
  };
  assert.equal(decoded.status, "completed");
  assert.equal(decoded.stability, "experimental");
  assert.equal(decoded.permissionMode, "plan");
  assert.equal(decoded.permissions, "synthetic-fixture-tools");
  assert.equal(decoded.usedAgentTurns, 1);
  assert.equal(
    decoded.events.filter((event) => event.type === "ToolCallStarted").length,
    2,
  );
  assert.deepEqual(
    decoded.events.map((event) => event.sequence),
    [...decoded.events.map((event) => event.sequence)].sort((a, b) => a - b),
  );
  assert.match(decoded.result, /No physical repository was read or changed/u);
});

test("flat interactive mode supports queued multi-turn conversation", async () => {
  const stdout = writer();
  const stderr = writer();
  const code = await executeSessionCommand(
    {
      kind: "interactive",
      prompt: "Why does the fixture fail?",
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
    },
    stdout,
    stderr,
    dependencies(
      Readable.from(["What exact change should I make?\n"]),
    ),
  );
  assert.equal(code, 0);
  assert.match(stdout.value, /\[tool:started\] robin\.synthetic\.workspace_summary@1/u);
  assert.match(stdout.value, /\[tool:completed\] robin\.synthetic\.inspect_file@1/u);
  assert.match(stdout.value, /Replace subtraction with addition/u);
  assert.match(stderr.value, /ephemeral conversation was not saved/u);
});

test("flat renderer failure closes the ephemeral application", async () => {
  let application: R1RobinApplication | null = null;
  await assert.rejects(
    executeSessionCommand(
      {
        kind: "interactive",
        prompt: null,
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
      },
      {
        write() {
          throw new Error("flat writer unavailable");
        },
      },
      writer(),
      dependencies(Readable.from([]), {
        createApplication: (...args) => {
          application = createR1RobinApplication(...args);
          return application;
        },
      }),
    ),
    /flat writer unavailable/u,
  );
  const capturedApplication = (): R1RobinApplication => {
    if (application === null) throw new Error("application was not created");
    return application;
  };
  assert.equal(capturedApplication().snapshot.closed, true);
});

test(
  "a delayed flat consumer failure closes open input without an unhandled rejection",
  { timeout: 5_000 },
  async () => {
    const input = new PassThrough();
    let application: R1RobinApplication | null = null;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await assert.rejects(
        executeSessionCommand(
          {
            kind: "interactive",
            prompt: "Why does the fixture fail?",
            provider: "synthetic",
            model: null,
            permissionMode: "ask",
          },
          {
            write(chunk: string) {
              if (chunk.startsWith("[assistant]")) {
                throw new Error("delayed flat writer failure");
              }
            },
          },
          writer(),
          dependencies(input, {
            createApplication: (...args) => {
              application = createR1RobinApplication(...args);
              return application;
            },
          }),
        ),
        /delayed flat writer failure/u,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      input.destroy();
    }

    assert.deepEqual(unhandled, []);
    assert.equal(requireApplication(application).snapshot.closed, true);
  },
);

test(
  "flat initial exit closes the application without waiting for input EOF",
  { timeout: 2_000 },
  async () => {
    const input = new PassThrough();
    let application: R1RobinApplication | null = null;
    try {
      const code = await executeSessionCommand(
        {
          kind: "interactive",
          prompt: "/exit",
          provider: "synthetic",
          model: null,
          permissionMode: "ask",
        },
        writer(),
        writer(),
        dependencies(input, {
          createApplication: (...args) => {
            application = createR1RobinApplication(...args);
            return application;
          },
        }),
      );
      assert.equal(code, 0);
    } finally {
      input.destroy();
    }

    const snapshot = requireApplication(application).snapshot;
    assert.equal(snapshot.closed, true);
    assert.equal(snapshot.activeTurn, false);
    assert.equal(
      snapshot.events.some(
        (event) =>
          event.type === "SessionClosed" && event.payload.reason === "user",
      ),
      true,
    );
  },
);

test(
  "flat in-session exit cancels a slow active turn through bounded close",
  { timeout: 5_000 },
  async () => {
    const input = new PassThrough();
    let application: R1RobinApplication | null = null;
    let exitSent = false;
    let rendered = "";
    const stdout = {
      write(chunk: string) {
        rendered += chunk;
        if (!exitSent && chunk.includes("Working on the synthetic fixture")) {
          exitSent = true;
          input.write("/exit\n");
        }
      },
    };
    try {
      const code = await executeSessionCommand(
        {
          kind: "interactive",
          prompt: "[scenario:slow]",
          provider: "synthetic",
          model: null,
          permissionMode: "ask",
        },
        stdout,
        writer(),
        dependencies(input, {
          createApplication: (...args) => {
            application = createR1RobinApplication(...args);
            return application;
          },
        }),
      );
      assert.equal(code, 0);
    } finally {
      input.destroy();
    }

    const snapshot = requireApplication(application).snapshot;
    assert.equal(exitSent, true);
    assert.equal(snapshot.closed, true);
    assert.equal(snapshot.activeTurn, false);
    assert.equal(
      snapshot.events.some((event) => event.type === "TurnCancellationRequested"),
      true,
    );
    assert.equal(
      snapshot.events.some((event) => event.type === "TurnCancelled"),
      true,
    );
    assert.match(rendered, /Cancelling/u);
  },
);

test(
  "raw interactive mode restores terminal state after a complete turn",
  { timeout: 5_000 },
  async () => {
    const input = new PassThrough();
    const rawModes: boolean[] = [];
    let isRaw = false;
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
    const output = new PassThrough();
    Object.defineProperties(output, {
      isTTY: { value: true },
      columns: { value: 80 },
      rows: { value: 24 },
    });
    let rendered = "";
    let sawWorking = false;
    let closeSent = false;
    output.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      rendered += text;
      if (text.includes("working")) sawWorking = true;
      if (sawWorking && text.includes("ready") && !closeSent) {
        closeSent = true;
        input.write(Buffer.from([0x04]));
      }
    });

    const running = executeSessionCommand(
      {
        kind: "interactive",
        prompt: null,
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
      },
      output,
      writer(),
      dependencies(input, {
        environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      }),
    );
    queueMicrotask(() => input.write("Why does the fixture fail?\r"));
    const code = await running;
    assert.equal(code, 0);
    assert.deepEqual(rawModes, [true, false]);
    assert.equal(isRaw, false);
    assert.match(rendered, /\u001b\[\?2004h/u);
    assert.match(rendered, /\u001b\[\?2004l/u);
    assert.match(rendered, /\u001b\[\?25h/u);
    assert.equal(closeSent, true);
  },
);

test(
  "raw local commands leave an active slow turn and application queue unchanged",
  { timeout: 5_000 },
  async () => {
    const terminalInput = rawInput();
    const output = rawOutput();
    let application: R1RobinApplication | null = null;
    const commandSnapshots: Array<{
      readonly activeTurn: boolean;
      readonly queueDepth: number;
    }> = [];
    let phase:
      | "waiting_for_work"
      | "waiting_for_help"
      | "waiting_for_unknown"
      | "waiting_for_cancel"
      | "closing" = "waiting_for_work";
    let rendered = "";
    output.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      rendered += text;
      if (
        phase === "waiting_for_work" &&
        text.includes("Working on the synthetic fixture")
      ) {
        phase = "waiting_for_help";
        terminalInput.input.write("/help\r");
      } else if (
        phase === "waiting_for_help" &&
        text.includes("Enter a prompt")
      ) {
        const snapshot = requireApplication(application).snapshot;
        commandSnapshots.push({
          activeTurn: snapshot.activeTurn,
          queueDepth: snapshot.queueDepth,
        });
        phase = "waiting_for_unknown";
        terminalInput.input.write("/unknown\r");
      } else if (
        phase === "waiting_for_unknown" &&
        text.includes("Unknown local command")
      ) {
        const snapshot = requireApplication(application).snapshot;
        commandSnapshots.push({
          activeTurn: snapshot.activeTurn,
          queueDepth: snapshot.queueDepth,
        });
        phase = "waiting_for_cancel";
        terminalInput.input.write(Buffer.from([0x03]));
      } else if (
        phase === "waiting_for_cancel" &&
        text.includes("Robin · ready")
      ) {
        phase = "closing";
        terminalInput.input.write(Buffer.from([0x04]));
      }
    });

    const running = executeSessionCommand(
      {
        kind: "interactive",
        prompt: null,
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
      },
      output,
      writer(),
      dependencies(terminalInput.input, {
        environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        createApplication: (...args) => {
          application = createR1RobinApplication(...args);
          return application;
        },
      }),
    );
    queueMicrotask(() => terminalInput.input.write("[scenario:slow]\r"));
    const code = await running;

    assert.equal(code, 0);
    assert.deepEqual(commandSnapshots, [
      { activeTurn: true, queueDepth: 0 },
      { activeTurn: true, queueDepth: 0 },
    ]);
    const snapshot = requireApplication(application).snapshot;
    assert.equal(
      snapshot.events.filter((event) => event.type === "UserMessageAccepted")
        .length,
      1,
    );
    assert.equal(
      snapshot.events.filter((event) => event.type === "UserMessageQueued").length,
      0,
    );
    assert.match(rendered, /Enter a prompt/u);
    assert.match(rendered, /Unknown local command/u);
    assert.deepEqual(terminalInput.rawModes, [true, false]);
    assert.equal(terminalInput.isRaw(), false);
  },
);

test(
  "TurnCancelled resets the two-stage interrupt window before the next turn",
  { timeout: 5_000 },
  async () => {
    const terminalInput = rawInput();
    const output = rawOutput();
    let application: R1RobinApplication | null = null;
    let now = 100;
    let phase:
      | "first_working"
      | "first_cancelling"
      | "second_working"
      | "second_cancelling"
      | "closing" = "first_working";
    output.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (
        phase === "first_working" &&
        text.includes("Working on the synthetic fixture")
      ) {
        phase = "first_cancelling";
        terminalInput.input.write(Buffer.from([0x03]));
      } else if (
        phase === "first_cancelling" &&
        text.includes("Robin · ready")
      ) {
        now = 101;
        phase = "second_working";
        terminalInput.input.write("[scenario:slow]\r");
      } else if (
        phase === "second_working" &&
        text.includes("Working on the synthetic fixture")
      ) {
        phase = "second_cancelling";
        terminalInput.input.write(Buffer.from([0x03]));
      } else if (
        phase === "second_cancelling" &&
        text.includes("Robin · ready")
      ) {
        phase = "closing";
        terminalInput.input.write(Buffer.from([0x04]));
      }
    });

    const running = executeSessionCommand(
      {
        kind: "interactive",
        prompt: null,
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
      },
      output,
      writer(),
      dependencies(terminalInput.input, {
        environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        createApplication: (...args) => {
          application = createR1RobinApplication(...args);
          return application;
        },
      }),
      {
        interruptEscalator: new InterruptEscalator({
          now: () => now,
          windowMs: 750,
        }),
      },
    );
    queueMicrotask(() => terminalInput.input.write("[scenario:slow]\r"));
    const code = await running;

    assert.equal(code, 0);
    assert.equal(phase, "closing");
    assert.equal(
      requireApplication(application).snapshot.events.filter(
        (event) => event.type === "TurnCancelled",
      ).length,
      2,
    );
    assert.deepEqual(terminalInput.rawModes, [true, false]);
    assert.equal(terminalInput.isRaw(), false);
  },
);

test("raw renderer failure restores input mode and closes the application", async () => {
  const input = new PassThrough();
  const rawModes: boolean[] = [];
  let isRaw = false;
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
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 80,
    rows: 24,
    write(chunk: string) {
      writes.push(chunk);
      if (writes.length === 2) throw new Error("renderer unavailable");
    },
  };
  let application: R1RobinApplication | null = null;

  await assert.rejects(
    executeSessionCommand(
      {
        kind: "interactive",
        prompt: null,
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
      },
      output,
      writer(),
      dependencies(input, {
        environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        createApplication: (...args) => {
          application = createR1RobinApplication(...args);
          return application;
        },
      }),
    ),
    /renderer unavailable/u,
  );

  assert.deepEqual(rawModes, [true, false]);
  assert.equal(isRaw, false);
  const capturedApplication = (): R1RobinApplication => {
    if (application === null) throw new Error("application was not created");
    return application;
  };
  assert.equal(capturedApplication().snapshot.closed, true);
  assert.match(writes.at(-1) ?? "", /\u001b\[\?2004l/u);
  assert.match(writes.at(-1) ?? "", /\u001b\[\?25h/u);
});

test(
  "a late raw renderer failure during exit is retained as infrastructure failure",
  { timeout: 5_000 },
  async () => {
    const terminalInput = rawInput();
    let application: R1RobinApplication | null = null;
    let exitQueued = false;
    let exitProcessed = false;
    let lateFailureThrown = false;
    const writes: string[] = [];
    const output = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write(chunk: string) {
        writes.push(chunk);
        if (
          !exitQueued &&
          chunk.includes("Working on the synthetic fixture")
        ) {
          exitQueued = true;
          queueMicrotask(() => {
            terminalInput.input.write("/exit\r");
            exitProcessed = true;
          });
        }
        if (
          exitProcessed &&
          !lateFailureThrown &&
          !chunk.includes("\u001b[?2004l")
        ) {
          lateFailureThrown = true;
          throw new Error("late shutdown renderer failure");
        }
      },
    };

    const code = await executeSessionCommand(
      {
        kind: "interactive",
        prompt: "[scenario:slow]",
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
      },
      output,
      writer(),
      dependencies(terminalInput.input, {
        environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        createApplication: (...args) => {
          application = createR1RobinApplication(...args);
          return application;
        },
      }),
    );

    assert.equal(code, 7);
    assert.equal(exitQueued, true);
    assert.equal(lateFailureThrown, true);
    assert.equal(requireApplication(application).snapshot.closed, true);
    assert.deepEqual(terminalInput.rawModes, [true, false]);
    assert.equal(terminalInput.isRaw(), false);
    assert.match(writes.at(-1) ?? "", /\u001b\[\?2004l/u);
    assert.match(writes.at(-1) ?? "", /\u001b\[\?25h/u);
  },
);

test("stream JSON exposes monotonic tool and terminal application events", async () => {
  const stdout = writer();
  const code = await executeSessionCommand(
    {
      kind: "print",
      prompt: "Inspect the fixture.",
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
      outputFormat: "stream-json",
      save: false,
      maximumTurns: 16,
    },
    stdout,
    writer(),
    dependencies(),
  );
  assert.equal(code, 0);
  const records = stdout.value.trimEnd().split("\n").map((line) =>
    JSON.parse(line) as {
      readonly sequence: number;
      readonly stability: string;
      readonly event: { readonly type: string };
    },
  );
  assert.equal(records.every((record) => record.stability === "experimental"), true);
  assert.equal(
    records.filter((record) => record.event.type === "ToolCallStarted").length,
    2,
  );
  assert.equal(records.at(-1)?.event.type, "TurnCompleted");
});

test(
  "headless output failure cancels and closes a slow active application",
  { timeout: 5_000 },
  async () => {
    const outputFailure = new AbortController();
    let application: R1RobinApplication | null = null;
    let writes = 0;
    const stdout = {
      write() {
        writes += 1;
        if (!outputFailure.signal.aborted) {
          outputFailure.abort(new Error("synthetic EPIPE"));
        }
      },
    };

    const code = await executeSessionCommand(
      {
        kind: "print",
        prompt: "[scenario:slow]",
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
        outputFormat: "stream-json",
        save: false,
        maximumTurns: 16,
      },
      stdout,
      writer(),
      dependencies(undefined, {
        createApplication: (...args) => {
          application = createR1RobinApplication(...args);
          return application;
        },
      }),
      { outputFailureSignal: outputFailure.signal },
    );

    const snapshot = requireApplication(application).snapshot;
    assert.equal(code, 7);
    assert.equal(writes, 1);
    assert.equal(snapshot.closed, true);
    assert.equal(snapshot.activeTurn, false);
    assert.equal(
      snapshot.events.some((event) => event.type === "TurnCancellationRequested"),
      true,
    );
    assert.equal(
      snapshot.events.some((event) => event.type === "TurnCancelled"),
      true,
    );
  },
);

test("provider and tool failures produce structured terminal results", async () => {
  for (const prompt of ["[scenario:provider-error]", "[scenario:tool-error]"]) {
    const stdout = writer();
    const code = await executeSessionCommand(
      {
        kind: "print",
        prompt,
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
        outputFormat: "json",
        save: false,
        maximumTurns: 1,
      },
      stdout,
      writer(),
      dependencies(),
    );
    const result = JSON.parse(stdout.value) as {
      readonly status: string;
      readonly result: null;
      readonly error: { readonly code: string; readonly message: string };
    };
    assert.notEqual(code, 0);
    assert.equal(result.status, "failed");
    assert.equal(result.result, null);
    assert.equal(typeof result.error.code, "string");
  }
});

test("session options reach application composition and invalid model fails first", async () => {
  const captured: unknown[][] = [];
  const createApplication = (...args: Parameters<SessionCommandDependencies["createApplication"]>) => {
    captured.push(args);
    return createR1RobinApplication(...args);
  };
  await executeSessionCommand(
    {
      kind: "print",
      prompt: "Inspect.",
      provider: "synthetic",
      model: "synthetic-r1-v1",
      permissionMode: "plan",
      outputFormat: "text",
      save: false,
      maximumTurns: 3,
    },
    writer(),
    writer(),
    dependencies(undefined, { createApplication }),
  );
  assert.deepEqual(captured[0], [
    "ephemeral-r1-cli-test",
    "synthetic-r1-v1",
    3,
    "plan",
  ]);

  let created = false;
  await assert.rejects(
    executeSessionCommand(
      {
        kind: "print",
        prompt: "Do not start.",
        provider: "synthetic",
        model: "does-not-exist",
        permissionMode: "ask",
        outputFormat: "text",
        save: false,
        maximumTurns: 1,
      },
      writer(),
      writer(),
      dependencies(undefined, {
        createApplication: (...args) => {
          created = true;
          return createR1RobinApplication(...args);
        },
      }),
    ),
    CliUsageError,
  );
  assert.equal(created, false);
});

test("terminal sanitizers neutralize C0, C1, OSC, and line controls", () => {
  const hostile =
    "safe\u001b]52;secret\u0007\rnext\u0085\u009dhidden\u009c\u2028line\u2029paragraph";
  const text = sanitizeTerminalText(hostile);
  const diagnostic = sanitizeTerminalDiagnostic(hostile + "\nnext");
  for (const unsafe of ["\u001b", "\u0007", "\r", "\u0085", "\u009d", "\u009c", "\u2028", "\u2029"]) {
    assert.equal(text.includes(unsafe), false);
  }
  assert.match(text, /\\u\{1b\}/u);
  assert.match(text, /\\u\{07\}/u);
  assert.equal(diagnostic.includes("\n"), false);
  assert.match(diagnostic, /\\n/u);
});
