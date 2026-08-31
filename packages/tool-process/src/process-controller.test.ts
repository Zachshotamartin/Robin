import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProcessController,
  parseProcessRequestV1,
  prepareProcessExecution,
  type ProcessLifecycleEvent,
} from "./index.js";

test("spawns exact argv without a shell and returns ordered bounded output", async (t) => {
  const workspace = await temporaryWorkspace(t);
  const request = requestFor(
    [
      "-e",
      "process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),mode:process.env.PROJECT_MODE}));process.stderr.write('warn')",
      "$(literal);*.ts",
      "",
      "unicodé",
    ],
    { PROJECT_MODE: "test" },
  );
  const prepared = await prepare(workspace, request);
  const events: ProcessLifecycleEvent[] = [];
  const result = await new ProcessController().run(prepared, {
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.classification, "success");
  assert.equal(result.exitCode, 0);
  assert.equal(result.sandbox.sandboxed, false);
  assert.equal(result.sandbox.filesystemIsolation, "none");
  const payload = JSON.parse(result.output.stdout.headText) as {
    argv: string[];
    cwd: string;
    mode: string;
  };
  assert.deepEqual(payload.argv, ["$(literal);*.ts", "", "unicodé"]);
  assert.equal(payload.cwd, await realpath(workspace));
  assert.equal(payload.mode, "test");
  assert.equal(result.output.stderr.headText, "warn");
  assert.equal(events[0]?.type, "prepared");
  assert.ok(events.some((event) => event.type === "started"));
  assert.equal(events.at(-1)?.type, "settled");
});

test("distinguishes nonzero child exit from spawn infrastructure failure", async (t) => {
  const workspace = await temporaryWorkspace(t);
  const nonzero = await new ProcessController().run(
    await prepare(workspace, requestFor(["-e", "process.exit(7)"])),
    { signal: new AbortController().signal },
  );
  assert.equal(nonzero.classification, "nonzero_exit");
  assert.equal(nonzero.exitCode, 7);

  const prepared = await prepare(workspace, requestFor(["-e", "process.exit(0)"]));
  const forged = Object.freeze({
    ...prepared,
    executable: Object.freeze({
      ...prepared.executable,
      physicalPath: path.join(workspace, "missing-executable"),
      candidatePath: path.join(workspace, "missing-executable"),
    }),
  });
  await assert.rejects(new ProcessController().run(forged, {
    signal: new AbortController().signal,
  }));
});

test("timeout sends graceful then forceful group termination and seals once", async (t) => {
  if (process.platform === "win32") t.skip("R2 process-group proof is POSIX-only.");
  const workspace = await temporaryWorkspace(t);
  const request = requestFor(
    [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('started');setInterval(()=>{},1000)",
    ],
    {},
    { timeoutMs: 80, terminationGraceMs: 30 },
  );
  const result = await new ProcessController({ forceWaitMs: 500 }).run(
    await prepare(workspace, request),
    { signal: new AbortController().signal },
  );
  assert.equal(result.classification, "timed_out");
  assert.equal(result.termination.gracefulSignalSent, true);
  assert.equal(result.termination.forceSignalSent, true);
  assert.equal(result.termination.groupReaped, true);
  assert.equal(result.output.stdout.headText, "started");
});

test("user cancellation propagates after start and confirms settlement", async (t) => {
  if (process.platform === "win32") t.skip("R2 process-group proof is POSIX-only.");
  const workspace = await temporaryWorkspace(t);
  const controller = new AbortController();
  const result = await new ProcessController({ forceWaitMs: 500 }).run(
    await prepare(
      workspace,
      requestFor(["-e", "setInterval(()=>{},1000)"], {}, {
        timeoutMs: 5_000,
        terminationGraceMs: 30,
      }),
    ),
    {
      signal: controller.signal,
      onEvent(event) {
        if (event.type === "started") controller.abort("test cancellation");
      },
    },
  );
  assert.equal(result.classification, "cancelled");
  assert.equal(result.termination.groupReaped, true);
});

test("absolute output flood terminates the process while retention stays bounded", async (t) => {
  if (process.platform === "win32") t.skip("R2 process-group proof is POSIX-only.");
  const workspace = await temporaryWorkspace(t);
  const request = requestFor(
    ["-e", "for(;;){process.stdout.write(Buffer.alloc(65536,120))}"],
    {},
    {
      output: {
        retainedHeadBytes: 32,
        retainedTailBytes: 32,
        absoluteBytes: 1_024,
      },
      timeoutMs: 5_000,
      terminationGraceMs: 20,
    },
  );
  const result = await new ProcessController({ forceWaitMs: 500 }).run(
    await prepare(workspace, request),
    { signal: new AbortController().signal },
  );
  assert.equal(result.classification, "output_limit_exceeded");
  assert.equal(result.output.limitExceeded, true);
  assert.equal(result.output.retainedByteLength <= 64, true);
  assert.equal(result.termination.groupReaped, true);
});

test("an already-aborted request never spawns", async (t) => {
  const workspace = await temporaryWorkspace(t);
  const controller = new AbortController();
  controller.abort("before run");
  const events: ProcessLifecycleEvent[] = [];
  const result = await new ProcessController().run(
    await prepare(workspace, requestFor(["-e", "process.exit(99)"])),
    { signal: controller.signal, onEvent: (event) => events.push(event) },
  );
  assert.equal(result.classification, "cancelled");
  assert.equal(result.pid, null);
  assert.equal(events.some((event) => event.type === "started"), false);
});

test("cancellation reaps a grandchild that remains in Robin's process group", async (t) => {
  if (process.platform === "win32") t.skip("R2 process-group proof is POSIX-only.");
  const workspace = await temporaryWorkspace(t);
  const controller = new AbortController();
  let grandchildPid: number | null = null;
  const script =
    "const {spawn}=require('node:child_process');" +
    "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
    "process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)";
  const result = await new ProcessController({ forceWaitMs: 1_000 }).run(
    await prepare(
      workspace,
      requestFor(["-e", script], {}, {
        timeoutMs: 5_000,
        terminationGraceMs: 30,
      }),
    ),
    {
      signal: controller.signal,
      onEvent(event) {
        if (event.type !== "output" || event.chunk.channel !== "stdout") return;
        const parsed = Number.parseInt(event.chunk.safeText.trim(), 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          grandchildPid = parsed;
          controller.abort("grandchild observed");
        }
      },
    },
  );
  assert.equal(result.classification, "cancelled");
  assert.equal(result.termination.groupReaped, true);
  assert.notEqual(grandchildPid, null);
  assert.throws(() => process.kill(grandchildPid!, 0));
});

test("timeout remains armed after the leader exits while a descendant holds the pipes", async (t) => {
  if (process.platform === "win32") t.skip("R2 process-group proof is POSIX-only.");
  const workspace = await temporaryWorkspace(t);
  const events: ProcessLifecycleEvent[] = [];
  const result = await new ProcessController({ forceWaitMs: 1_000 }).run(
    await prepare(
      workspace,
      requestFor(["-e", leaderExitWithPipeHoldingDescendant()], {}, {
        timeoutMs: 120,
        terminationGraceMs: 30,
      }),
    ),
    {
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    },
  );

  const descendantPid = Number.parseInt(result.output.stdout.headText.trim(), 10);
  assert.equal(result.classification, "timed_out");
  assert.equal(result.termination.requestedReason, "timeout");
  assert.equal(result.termination.gracefulSignalSent, true);
  assert.equal(result.termination.groupReaped, true);
  assert.equal(events.some((event) => event.type === "leader_exited"), true);
  assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true);
  assert.throws(() => process.kill(descendantPid, 0));
});

test("cancellation after leader exit terminates its pipe-holding process group", async (t) => {
  if (process.platform === "win32") t.skip("R2 process-group proof is POSIX-only.");
  const workspace = await temporaryWorkspace(t);
  const cancellation = new AbortController();
  const result = await new ProcessController({ forceWaitMs: 1_000 }).run(
    await prepare(
      workspace,
      requestFor(["-e", leaderExitWithPipeHoldingDescendant()], {}, {
        timeoutMs: 5_000,
        terminationGraceMs: 30,
      }),
    ),
    {
      signal: cancellation.signal,
      onEvent(event) {
        if (event.type === "leader_exited") cancellation.abort("leader exited");
      },
    },
  );

  const descendantPid = Number.parseInt(result.output.stdout.headText.trim(), 10);
  assert.equal(result.classification, "cancelled");
  assert.equal(result.termination.requestedReason, "cancelled");
  assert.equal(result.termination.gracefulSignalSent, true);
  assert.equal(result.termination.groupReaped, true);
  assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true);
  assert.throws(() => process.kill(descendantPid, 0));
});

test("preparation observes an already-aborted signal before workspace input", async (t) => {
  const workspace = await temporaryWorkspace(t);
  const cancellation = new AbortController();
  cancellation.abort("cancel preparation");
  let readCalled = false;
  await assert.rejects(
    prepareProcessExecution({
      request: parseProcessRequestV1({
        ...requestFor(["-e", "process.exit(0)"]),
        stdin: {
          kind: "workspace_file",
          path: "input.txt",
          maximumBytes: 64,
          expectedSha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      }),
      workspaceRoot: workspace,
      executablePolicy: executablePolicy(workspace),
      environmentProfile: environmentProfile(workspace),
      ambientEnvironment: {},
      signal: cancellation.signal,
      workspaceFileReader: {
        async read() {
          readCalled = true;
          return new Uint8Array();
        },
      },
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "cancelled",
  );
  assert.equal(readCalled, false);
});

function requestFor(
  argv: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  overrides: {
    readonly timeoutMs?: number;
    readonly terminationGraceMs?: number;
    readonly output?: {
      readonly retainedHeadBytes: number;
      readonly retainedTailBytes: number;
      readonly absoluteBytes: number;
    };
  } = {},
) {
  return parseProcessRequestV1({
    schemaVersion: 1,
    executable: process.execPath,
    argv,
    cwd: ".",
    environment,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    terminationGraceMs: overrides.terminationGraceMs ?? 100,
    output: overrides.output ?? {
      retainedHeadBytes: 16_384,
      retainedTailBytes: 16_384,
      absoluteBytes: 1024 * 1024,
    },
    stdin: { kind: "closed" },
    intent: "verification",
  });
}

async function prepare(
  workspace: string,
  request: ReturnType<typeof requestFor>,
) {
  return prepareProcessExecution({
    request,
    workspaceRoot: workspace,
    executablePolicy: executablePolicy(workspace),
    environmentProfile: environmentProfile(workspace),
    ambientEnvironment: {},
    signal: new AbortController().signal,
  });
}

function executablePolicy(workspace: string) {
  const executableRoot = path.dirname(process.execPath);
  return {
    trustedPath: [executableRoot],
    workspaceRoot: workspace,
    trustedExecutableRoots: [executableRoot],
    allowWorkspaceExecutables: false,
  };
}

function environmentProfile(workspace: string) {
  const executableRoot = path.dirname(process.execPath);
  return {
    profileId: "r2-controller-test",
    inheritedKeys: [],
    fixed: {
      PATH: executableRoot,
      HOME: workspace,
      TMPDIR: workspace,
      CI: "1",
      NO_COLOR: "1",
      TERM: "dumb",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    },
  };
}

function leaderExitWithPipeHoldingDescendant(): string {
  return (
    "const {spawn}=require('node:child_process');" +
    "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});" +
    "c.unref();process.stdout.write(String(c.pid)+'\\n',()=>process.exit(0))"
  );
}

async function temporaryWorkspace(t: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "robin-controller-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}
