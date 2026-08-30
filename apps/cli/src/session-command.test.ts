import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import {
  EphemeralRobinApplication,
  createPreviewRobinApplication,
  type EphemeralRobinApplicationOptions,
} from "@guard/robin-application";

import { CliUsageError } from "./argv.js";
import { executeSessionCommand, sanitizeTerminalText } from "./session-command.js";

function writer(): { write(chunk: string): void; value: string } {
  return {
    value: "",
    write(chunk: string) {
      this.value += chunk;
    },
  };
}

test("headless text and JSON modes use the same application turn", async () => {
  const textOut = writer();
  const textErr = writer();
  const textCode = await executeSessionCommand(
    {
      kind: "print",
      prompt: "Explain Robin.",
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
      outputFormat: "text",
      save: false,
      maximumTurns: 16,
    },
    textOut,
    textErr,
    {
      input: Readable.from([]),
      createApplication: createPreviewRobinApplication,
      nextSessionId: () => "ephemeral-text-test",
    },
  );
  assert.equal(textCode, 0);
  assert.match(textOut.value, /^Robin received: Explain Robin\./u);
  assert.match(textOut.value, /no repository files were read or changed/u);
  assert.equal(textErr.value, "");

  const jsonOut = writer();
  await executeSessionCommand(
    {
      kind: "print",
      prompt: "Explain Robin.",
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
      outputFormat: "json",
      save: false,
      maximumTurns: 16,
    },
    jsonOut,
    writer(),
    {
      input: Readable.from([]),
      createApplication: createPreviewRobinApplication,
      nextSessionId: () => "ephemeral-json-test",
    },
  );
  const decoded = JSON.parse(jsonOut.value) as {
    readonly persistence: string;
    readonly saved: boolean;
    readonly result: string;
    readonly stability: string;
    readonly sessionId: string;
    readonly events: readonly {
      readonly sequence: number;
      readonly event: { readonly schemaVersion: number; readonly type: string };
    }[];
  };
  assert.equal(decoded.persistence, "ephemeral");
  assert.equal(decoded.saved, false);
  assert.equal(decoded.stability, "experimental");
  assert.equal(decoded.sessionId, "ephemeral-json-test");
  assert.deepEqual(
    decoded.events.map((record) => record.sequence),
    decoded.events.map((_, index) => index + 1),
  );
  assert.equal(decoded.events.every((record) => record.event.schemaVersion === 1), true);
  assert.match(decoded.result, /Synthetic preview only/u);
});

test("interactive mode accepts multiple turns and closes explicitly", async () => {
  const stdout = writer();
  const stderr = writer();
  const code = await executeSessionCommand(
    {
      kind: "interactive",
      prompt: "First prompt.",
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
    },
    stdout,
    stderr,
    {
      input: Readable.from(["Second prompt.\n", "/exit\n"]),
      createApplication: createPreviewRobinApplication,
    },
  );

  assert.equal(code, 0);
  assert.match(stdout.value, /Robin received: First prompt\./u);
  assert.match(stdout.value, /Robin received: Second prompt\./u);
  assert.match(stdout.value, /ephemeral/u);
  assert.match(stderr.value, /was not saved/u);
});

test("interactive TTY mode binds terminal output and restores raw input", async () => {
  const rawModes: boolean[] = [];
  let isRaw = false;
  const input = Readable.from(["/exit\n"]);
  Object.defineProperties(input, {
    isTTY: { value: true },
    isRaw: { get: () => isRaw },
    setRawMode: {
      value: (mode: boolean) => {
        isRaw = mode;
        rawModes.push(mode);
      },
    },
  });
  const stdout = new PassThrough();
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { value: 80 },
  });
  let rendered = "";
  stdout.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
  });

  const code = await executeSessionCommand(
    {
      kind: "interactive",
      prompt: null,
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
    },
    stdout,
    writer(),
    {
      input,
      createApplication: createPreviewRobinApplication,
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(isRaw, false);
  assert.match(rendered, /^Robin · synthetic preview/u);
});

test("interactive mode rejects unknown slash commands locally", async () => {
  const stdout = writer();
  await executeSessionCommand(
    {
      kind: "interactive",
      prompt: null,
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
    },
    stdout,
    writer(),
    {
      input: Readable.from(["/not-a-command\n", "/exit\n"]),
      createApplication: createPreviewRobinApplication,
    },
  );
  assert.match(stdout.value, /Unknown local command/u);
  assert.doesNotMatch(stdout.value, /Robin received: \/not-a-command/u);
});

test("synthetic preview rejects an unsupported model before creating a session", async () => {
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
      {
        input: Readable.from([]),
        createApplication: (...args) => {
          created = true;
          return createPreviewRobinApplication(...args);
        },
      },
    ),
    CliUsageError,
  );
  assert.equal(created, false);
});

test("terminal sanitization neutralizes control sequences", () => {
  const value = sanitizeTerminalText(
    "safe\u001b]52;secret\u0007\rnext\u0085\u009dhidden\u009c\u2028line\u2029paragraph",
  );
  assert.equal(value.includes("\u001b"), false);
  assert.equal(value.includes("\u0007"), false);
  assert.equal(value.includes("\r"), false);
  assert.equal(value.includes("\u0085"), false);
  assert.equal(value.includes("\u009d"), false);
  assert.equal(value.includes("\u009c"), false);
  assert.equal(value.includes("\u2028"), false);
  assert.equal(value.includes("\u2029"), false);
  assert.match(value, /\\u\{1b\}/u);
  assert.match(value, /\\u\{07\}/u);
  assert.match(value, /\\u\{85\}/u);
  assert.match(value, /\\u\{9d\}/u);
  assert.match(value, /\\u\{2028\}/u);
  assert.match(value, /\\u\{2029\}/u);
});

test("JSON renderers are terminal-safe without changing parsed provider text", async () => {
  const expected =
    "visible\u001b]52;secret\u0007\u009dhidden\u009c\u2028line\u2029paragraph";
  for (const outputFormat of ["json", "stream-json"] as const) {
    const stdout = writer();
    await executeSessionCommand(
      {
        kind: "print",
        prompt: "Emit hostile text.",
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
        outputFormat,
        save: false,
        maximumTurns: 1,
      },
      stdout,
      writer(),
      {
        input: Readable.from([]),
        createApplication: (sessionId, modelId = "synthetic-preview-v1") =>
          new EphemeralRobinApplication({
            sessionId,
            modelId,
            provider: hostileTextProvider(),
          }),
      },
    );
    assert.equal(stdout.value.includes("\u001b"), false);
    assert.equal(stdout.value.includes("\u009d"), false);
    assert.equal(stdout.value.includes("\u2028"), false);
    assert.equal(stdout.value.includes("\u2029"), false);
    assert.equal(stdout.value.includes("\\u001b"), true);
    assert.equal(stdout.value.includes("\\u009d"), true);
    assert.equal(stdout.value.includes("\\u2028"), true);
    assert.equal(stdout.value.includes("\\u2029"), true);
    if (outputFormat === "json") {
      const result = JSON.parse(stdout.value) as {
        readonly result: string;
        readonly events: readonly {
          readonly event: { readonly type: string; readonly delta?: string };
        }[];
      };
      assert.equal(result.result, expected);
      assert.equal(
        result.events.find((record) => record.event.type === "assistant_text_delta")
          ?.event.delta,
        expected,
      );
    } else {
      const records = stdout.value.trimEnd().split("\n").map((line) =>
        JSON.parse(line) as {
          readonly event: { readonly type: string; readonly delta?: string };
        },
      );
      assert.equal(
        records.find((record) => record.event.type === "assistant_text_delta")
          ?.event.delta,
        expected,
      );
    }
  }
});

test("stream JSON carries one monotonic experimental envelope per event", async () => {
  const stdout = writer();
  const code = await executeSessionCommand(
    {
      kind: "print",
      prompt: "Stream metadata.",
      provider: "synthetic",
      model: null,
      permissionMode: "plan",
      outputFormat: "stream-json",
      save: false,
      maximumTurns: 7,
    },
    stdout,
    writer(),
    {
      input: Readable.from([]),
      createApplication: createPreviewRobinApplication,
      nextSessionId: () => "ephemeral-stream-test",
    },
  );
  assert.equal(code, 0);
  const records = stdout.value.trimEnd().split("\n").map((line) =>
    JSON.parse(line) as {
      readonly sequence: number;
      readonly stability: string;
      readonly sessionId: string;
      readonly permissionMode: string;
      readonly permissions: string;
      readonly maximumAgentTurns: number;
      readonly event: { readonly schemaVersion: number; readonly type: string };
    },
  );
  assert.deepEqual(
    records.map((record) => record.sequence),
    records.map((_, index) => index + 1),
  );
  assert.equal(records.every((record) => record.stability === "experimental"), true);
  assert.equal(records.every((record) => record.sessionId === "ephemeral-stream-test"), true);
  assert.equal(records.every((record) => record.permissionMode === "plan"), true);
  assert.equal(
    records.every((record) => record.permissions === "inactive-no-tools"),
    true,
  );
  assert.equal(records.every((record) => record.maximumAgentTurns === 7), true);
  assert.equal(records.every((record) => record.event.schemaVersion === 1), true);
});

test("machine modes end provider failures with structured terminal records", async () => {
  for (const outputFormat of ["json", "stream-json"] as const) {
    const stdout = writer();
    const stderr = writer();
    const code = await executeSessionCommand(
      {
        kind: "print",
        prompt: "Fail safely.",
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
        outputFormat,
        save: false,
        maximumTurns: 1,
      },
      stdout,
      stderr,
      {
        input: Readable.from([]),
        createApplication: (sessionId, modelId = "synthetic-preview-v1") =>
          new EphemeralRobinApplication({
            sessionId,
            modelId,
            provider: failingProvider(),
          }),
        nextSessionId: () => `ephemeral-failure-${outputFormat}`,
      },
    );
    assert.equal(code, 7);
    assert.equal(stderr.value, "");
    const records = stdout.value.trimEnd().split("\n").map((line) => JSON.parse(line));
    if (outputFormat === "json") {
      const result = records[0] as {
        readonly status: string;
        readonly error: { readonly code: string; readonly retry: string };
        readonly events: readonly {
          readonly event: { readonly type: string };
        }[];
      };
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "provider_failed");
      assert.equal(result.error.retry, "terminal");
      assert.equal(result.events.at(-1)?.event.type, "turn_failed");
    } else {
      const terminal = records.at(-1) as {
        readonly event: {
          readonly type: string;
          readonly error: { readonly code: string };
        };
      };
      assert.equal(terminal.event.type, "turn_failed");
      assert.equal(terminal.event.error.code, "provider_failed");
    }
  }
});

test("text mode reports a provider failure on stderr with the shared exit code", async () => {
  const stdout = writer();
  const stderr = writer();
  const code = await executeSessionCommand(
    {
      kind: "print",
      prompt: "Fail as text.",
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
      outputFormat: "text",
      save: false,
      maximumTurns: 1,
    },
    stdout,
    stderr,
    {
      input: Readable.from([]),
      createApplication: (sessionId, modelId = "synthetic-preview-v1") =>
        new EphemeralRobinApplication({
          sessionId,
          modelId,
          provider: failingProvider(),
        }),
    },
  );
  assert.equal(code, 7);
  assert.equal(stdout.value, "");
  assert.match(stderr.value, /^robin: Turn failed \(provider_failed\):/u);
});

test("interactive mode reports one failed turn and continues to the next prompt", async () => {
  const stdout = writer();
  const stderr = writer();
  const provider = failThenSucceedProvider();
  const code = await executeSessionCommand(
    {
      kind: "interactive",
      prompt: "First fails.",
      provider: "synthetic",
      model: null,
      permissionMode: "ask",
    },
    stdout,
    stderr,
    {
      input: Readable.from(["Second succeeds.\n", "/exit\n"]),
      createApplication: (sessionId, modelId = "synthetic-preview-v1") =>
        new EphemeralRobinApplication({ sessionId, modelId, provider }),
    },
  );
  assert.equal(code, 0);
  assert.match(stdout.value, /Robin turn failed \(provider_failed\)/u);
  assert.match(stdout.value, /Recovered on the next prompt\./u);
  assert.match(stderr.value, /was not saved/u);
});

test("interactive failure rendering propagates writer errors", async () => {
  const stdout = {
    write(chunk: string) {
      if (chunk.includes("Robin turn failed")) {
        throw new Error("writer failed");
      }
    },
  };
  await assert.rejects(
    executeSessionCommand(
      {
        kind: "interactive",
        prompt: "Trigger failure.",
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
      },
      stdout,
      writer(),
      {
        input: Readable.from([]),
        createApplication: (sessionId, modelId = "synthetic-preview-v1") =>
          new EphemeralRobinApplication({
            sessionId,
            modelId,
            provider: failingProvider(),
          }),
      },
    ),
    /writer failed/u,
  );
});

test("interactive rendering propagates an undefined thrown value", async () => {
  let rejected = false;
  try {
    await executeSessionCommand(
      {
        kind: "interactive",
        prompt: "Trigger an undefined writer failure.",
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
      },
      {
        write() {
          throw undefined;
        },
      },
      writer(),
      {
        input: Readable.from([]),
        createApplication: createPreviewRobinApplication,
      },
    );
    assert.fail("expected the undefined writer failure to propagate");
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejected, true);
});

test("headless rendering propagates an undefined thrown value", async () => {
  let rejected = false;
  try {
    await executeSessionCommand(
      {
        kind: "print",
        prompt: "Trigger an undefined writer failure.",
        provider: "synthetic",
        model: null,
        permissionMode: "ask",
        outputFormat: "stream-json",
        save: false,
        maximumTurns: 1,
      },
      {
        write() {
          throw undefined;
        },
      },
      writer(),
      {
        input: Readable.from([]),
        createApplication: createPreviewRobinApplication,
      },
    );
    assert.fail("expected the undefined writer failure to propagate");
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejected, true);
});

function hostileTextProvider(): EphemeralRobinApplicationOptions["provider"] {
  const text =
    "visible\u001b]52;secret\u0007\u009dhidden\u009c\u2028line\u2029paragraph";
  return {
    descriptor: {
      adapterId: "test.hostile-text",
      adapterVersion: "1.0.0",
      capabilities: {
        streaming: true,
        structuredActions: false,
        exactUsage: false,
        cancellation: "confirmed",
      },
    },
    async *respond(_request, _signal) {
      yield { type: "text_delta", outputIndex: 0, delta: text } as const;
      yield { type: "response_completed", finishReason: "stop" } as const;
    },
  };
}

function failingProvider(): EphemeralRobinApplicationOptions["provider"] {
  return {
    descriptor: {
      adapterId: "test.failure",
      adapterVersion: "1.0.0",
      capabilities: {
        streaming: true,
        structuredActions: false,
        exactUsage: false,
        cancellation: "confirmed",
      },
    },
    async *respond() {
      yield {
        type: "response_failed",
        failure: {
          code: "test_failure",
          message: "The test provider failed safely.",
          retry: "terminal",
          resultCertainty: "no_result",
        },
      } as const;
    },
  };
}

function failThenSucceedProvider(): EphemeralRobinApplicationOptions["provider"] {
  let calls = 0;
  const failure = failingProvider();
  return {
    descriptor: failure.descriptor,
    async *respond(request, signal) {
      calls += 1;
      if (calls === 1) {
        yield* failure.respond(request, signal);
        return;
      }
      yield {
        type: "text_delta",
        outputIndex: 0,
        delta: "Recovered on the next prompt.",
      } as const;
      yield { type: "response_completed", finishReason: "stop" } as const;
    },
  };
}
