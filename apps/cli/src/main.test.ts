import assert from "node:assert/strict";
import test from "node:test";

import { EXIT_CODES, exitCodeForResult, runCli, type CliDependencies } from "./main.js";
import type { RenderableEvent } from "./render.js";

test("CLI buffers and writes only the selected renderer output", async () => {
  const stdout = writer();
  const stderr = writer();
  let calls = 0;
  const dependencies = successfulDependencies(() => {
    calls += 1;
  });
  const code = await runCli(
    ["run", "--profile", "synthetic-demo", "--format", "quiet"],
    stdout,
    stderr,
    dependencies,
  );
  assert.equal(code, EXIT_CODES.success);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(stdout.value), OUTCOME);
  assert.equal(stderr.value, "");
  assert.equal(stdout.writes, 1);
});

test("usage failures never start a scenario or leak following option values", async () => {
  const stdout = writer();
  const stderr = writer();
  let calls = 0;
  const secret = "cli-secret-canary";
  const code = await runCli(
    ["run", "--profile", "synthetic-demo", "--api-key", secret],
    stdout,
    stderr,
    successfulDependencies(() => {
      calls += 1;
    }),
  );
  assert.equal(code, EXIT_CODES.invalidConfiguration);
  assert.equal(calls, 0);
  assert.equal(stdout.value, "");
  assert.match(stderr.value, /^robin: Unknown option: --api-key\.\n/u);
  assert.match(stderr.value, /Try 'robin --help'\./u);
  assert.doesNotMatch(stderr.value, new RegExp(secret, "u"));
});

test("objective mismatch is rejected before the scenario is called", async () => {
  const stdout = writer();
  const stderr = writer();
  let calls = 0;
  const code = await runCli(
    [
      "run",
      "--profile",
      "synthetic-demo",
      "--objective-json",
      '{"recordId":"other","mode":"uppercase"}',
    ],
    stdout,
    stderr,
    successfulDependencies(() => {
      calls += 1;
    }),
  );
  assert.equal(code, EXIT_CODES.invalidConfiguration);
  assert.equal(calls, 0);
  assert.equal(stdout.value, "");
});

test("a rendering canary fails without partial stdout", async () => {
  const stdout = writer();
  const stderr = writer();
  const history = [event(1, "RunCreated", { invalid: 1n })];
  const dependencies: CliDependencies = {
    readObjectiveFile: async () => ({}),
    runSynthetic: async () => ({
      execution: { history, state: { result: COMPLETED_RESULT } },
    }),
    runCoding: async () => ({
      execution: { history, state: { result: COMPLETED_RESULT } },
    }),
    executePolicy: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  const code = await runCli(
    ["run", "--profile", "synthetic-demo", "--format", "jsonl"],
    stdout,
    stderr,
    dependencies,
  );
  assert.equal(code, EXIT_CODES.infrastructureFailed);
  assert.equal(stdout.value, "");
  assert.match(stderr.value, /before a terminal result/u);
});

test("stable exit mapping covers every Milestone A class", () => {
  assert.equal(exitCodeForResult(COMPLETED_RESULT), 0);
  assert.equal(exitCodeForResult({ status: "cancelled", reason: null }), 8);
  assert.equal(exitCodeForResult({ status: "orphaned", error: error("driver_failed") }), 7);
  assert.equal(exitCodeForResult({ status: "failed", error: error("policy_denied") }), 3);
  assert.equal(
    exitCodeForResult({ status: "failed", error: error("approval_required") }),
    4,
  );
  assert.equal(exitCodeForResult({ status: "failed", error: error("budget_exceeded") }), 5);
  assert.equal(exitCodeForResult({ status: "failed", error: error("action_failed") }), 6);
  assert.equal(
    exitCodeForResult({ status: "failed", error: error("infrastructure_failed") }),
    7,
  );
  assert.equal(exitCodeForResult(null), 7);
});

test("a revoked thrown proxy is contained as infrastructure failure", async () => {
  const stdout = writer();
  const stderr = writer();
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const dependencies = successfulDependencies();
  const hostileDependencies: CliDependencies = {
    ...dependencies,
    runSynthetic: async () => Promise.reject(revoked.proxy),
  };
  const code = await runCli(
    ["run", "--profile", "synthetic-demo"],
    stdout,
    stderr,
    hostileDependencies,
  );
  assert.equal(code, EXIT_CODES.infrastructureFailed);
  assert.equal(stdout.value, "");
});

test("policy commands are dispatched without starting a run", async () => {
  const stdout = writer();
  const stderr = writer();
  let runCalls = 0;
  let policyCalls = 0;
  const base = successfulDependencies(() => {
    runCalls += 1;
  });
  const dependencies: CliDependencies = {
    ...base,
    executePolicy: async (request) => {
      policyCalls += 1;
      assert.equal(request.kind, "policy-check");
      return {
        exitCode: 2,
        stdout: "",
        stderr: "policy diagnostics\n",
      };
    },
  };
  const code = await runCli(
    ["policy", "check", "default.guard"],
    stdout,
    stderr,
    dependencies,
  );
  assert.equal(code, 2);
  assert.equal(policyCalls, 1);
  assert.equal(runCalls, 0);
  assert.equal(stdout.value, "");
  assert.equal(stderr.value, "policy diagnostics\n");
});

test("coding-session modes dispatch without starting a compatibility scenario", async () => {
  const stdout = writer();
  const stderr = writer();
  let runCalls = 0;
  let sessionCalls = 0;
  const outputFailure = new AbortController();
  const base = successfulDependencies(() => {
    runCalls += 1;
  });
  const dependencies: CliDependencies = {
    ...base,
    executeSession: async (request, sessionStdout, _sessionStderr, runtime) => {
      sessionCalls += 1;
      assert.equal(request.kind, "print");
      assert.equal(runtime?.outputFailureSignal, outputFailure.signal);
      sessionStdout.write("session result\n");
      return 0;
    },
  };
  const code = await runCli(
    ["-p", "explain this repository"],
    stdout,
    stderr,
    dependencies,
    { outputFailureSignal: outputFailure.signal },
  );
  assert.equal(code, 0);
  assert.equal(sessionCalls, 1);
  assert.equal(runCalls, 0);
  assert.equal(stdout.value, "session result\n");
  assert.equal(stderr.value, "");
});

test("continue and resume fail clearly before starting any session", async () => {
  for (const argv of [["--continue"], ["--resume", "session-1"]] as const) {
    const stdout = writer();
    const stderr = writer();
    let sessionCalls = 0;
    const code = await runCli(argv, stdout, stderr, {
      ...successfulDependencies(),
      executeSession: async () => {
        sessionCalls += 1;
        return 0;
      },
    });
    assert.equal(code, EXIT_CODES.invalidConfiguration);
    assert.equal(sessionCalls, 0);
    assert.equal(stdout.value, "");
    assert.match(stderr.value, /Session persistence and resume are not implemented/u);
  }
});

test("root and policy help list every debugger command", async () => {
  const dependencies = successfulDependencies();
  for (const [argv, pattern] of [
    [["--help"], /^Usage: robin \[options\] \[prompt\]/u],
    [["policy", "--help"], /simulate/u],
    [["policy", "check", "--help"], /--catalog/u],
    [["policy", "format", "--help"], /canonicalText/u],
    [["policy", "test", "--help"], /--cases/u],
    [["policy", "explain", "--help"], /correlation tokens/u],
    [["policy", "simulate", "--help"], /--cursor/u],
  ] as const) {
    const stdout = writer();
    const stderr = writer();
    const code = await runCli(argv, stdout, stderr, dependencies);
    assert.equal(code, 0);
    assert.match(stdout.value, pattern);
    assert.equal(stderr.value, "");
  }
});

const RUN_ID = "run_018f0001-0000-7000-8000-010000000001";
const OUTCOME = Object.freeze({
  schemaVersion: 1,
  outcomeId: "out_fixture",
  profileId: "synthetic-transform",
  profileVersion: 1,
  outcomeType: "synthetic.transform.completed",
  outcomeTypeVersion: 1,
  payload: { transformed: "GUARDED" },
  evidence: [],
  proposedAt: "2026-01-02T03:04:05.000Z",
});
const COMPLETED_RESULT = Object.freeze({
  status: "completed",
  outcome: OUTCOME,
});
const SUCCESS_HISTORY: readonly RenderableEvent[] = Object.freeze([
  event(1, "RunCreated", { objective: {} }),
  event(2, "RunCompleted", { result: COMPLETED_RESULT }),
]);

function successfulDependencies(onRun: () => void = () => undefined): CliDependencies {
  const run = async () => {
    onRun();
    return {
      execution: {
        history: SUCCESS_HISTORY,
        state: { result: COMPLETED_RESULT },
      },
    };
  };
  return {
    readObjectiveFile: async () => ({ recordId: "greeting", mode: "uppercase" }),
    runSynthetic: run,
    runCoding: run,
    executePolicy: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
}

function writer(): { write(chunk: string): void; value: string; writes: number } {
  return {
    value: "",
    writes: 0,
    write(chunk: string) {
      this.value += chunk;
      this.writes += 1;
    },
  };
}

function error(code: string): Readonly<Record<string, string>> {
  return Object.freeze({ code });
}

function event(
  streamVersion: number,
  eventType: string,
  payload: unknown,
): RenderableEvent {
  return Object.freeze({
    eventSchemaVersion: 1,
    streamVersion,
    recordedAt: "2026-01-02T03:04:06.000Z",
    eventType,
    streamId: RUN_ID,
    payload,
  });
}
