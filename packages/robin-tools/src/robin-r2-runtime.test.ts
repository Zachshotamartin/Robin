import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  CapabilityGateway,
  type CapabilityApprovalChallenge,
  type CapabilityOperation,
  type PinnedPolicyEvaluator,
  type PolicyDecision,
} from "@guard/capability-gateway";
import {
  ActionIdKind,
  ApprovalIdKind,
  PolicyVersionIdKind,
  isDomainError,
  sha256Hex,
  type JsonObject,
  type NormalizedAction,
} from "@guard/contracts";
import { ControlledGitRunner, GitReadService } from "@guard/tool-git";
import { ProcessController } from "@guard/tool-process";
import { discoverPhysicalWorkspace, type GitWorkspaceProbeResult } from "@guard/tool-workspace";

import {
  ROBIN_R2_TOOL_DEFINITIONS,
  createRobinR2CapabilityRuntime,
  type RobinR2CapabilityRuntime,
  type RobinR2SafeProcessLifecycleEvent,
} from "./index.js";

const exec = promisify(execFile);
const POLICY_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000201",
);
test("runtime installs and advertises exactly the eight R2 tools", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(fixture.runtime.packs.length, 4);
  assert.deepEqual(
    fixture.runtime.advertisement.operations.map(
      (operation) => `${operation.packId}.${operation.operationId}@${operation.operationVersion}`,
    ),
    ROBIN_R2_TOOL_DEFINITIONS.map((entry) => entry.toolId),
  );
  assert.equal(
    fixture.runtime.packs.flatMap((pack) => pack.operations).length,
    ROBIN_R2_TOOL_DEFINITIONS.length,
  );
});

test("direct operation calls cannot forge effect authority", async (t) => {
  const fixture = await createFixture(t);
  const operation = findOperation(fixture.runtime, "create_file");
  await assert.rejects(
    Promise.resolve(operation.execute(
      { operationId: "create_file" } as NormalizedAction,
      { signal: new AbortController().signal },
    )),
    (error: unknown) => domainCode(error, "approval_invalid"),
  );
  await assert.rejects(readFile(path.join(fixture.root, "forged.txt")), /ENOENT/u);
});

test("all five read-only tools execute through exact policy authority", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.root, "tracked.txt"), "alpha\nchanged\n");
  const gateway = approvalGateway(fixture.runtime);
  const calls: readonly [string, string, JsonObject][] = [
    ["robin.repo", "list_files", { root: "" }],
    ["robin.repo", "search_text", { query: "alpha", paths: ["tracked.txt"] }],
    ["robin.repo", "read_file", { path: "tracked.txt", selector: { kind: "whole" } }],
    ["robin.git", "status", {}],
    ["robin.git", "diff", { scope: "working" }],
  ];
  for (let index = 0; index < calls.length; index += 1) {
    const [packId, operationId, input] = calls[index]!;
    const prepared = await normalize(
      gateway,
      fixture.runtime,
      packId,
      operationId,
      input,
      10 + index,
    );
    const authorized = gateway.authorize(gateway.evaluate(prepared));
    assert.equal(authorized.status, "authorized");
    if (authorized.status !== "authorized") throw new Error("expected policy authority");
    const result = await fixture.runtime.executeAuthorized(
      gateway,
      authorized.authorization,
      { signal: new AbortController().signal },
    ).catch((error: unknown) => {
      throw new Error(`${operationId} failed`, { cause: error });
    });
    assert.equal(result.status, "executed", operationId);
  }
});

test("an approved create is one-use, attributed, and rescanned", async (t) => {
  const fixture = await createFixture(t);
  const gateway = approvalGateway(fixture.runtime);
  const prepared = await normalize(
    gateway,
    fixture.runtime,
    "robin.edit",
    "create_file",
    {
      path: "created.txt",
      expectedAbsent: true,
      content: "created by Robin\n",
    },
    1,
  );
  const summary = fixture.runtime.approvalSummary(prepared);
  assert.equal(summary["toolId"], "robin.edit.create_file@1");
  assert.equal(summary["expectedAbsent"], true);
  const authorization = approve(gateway, prepared, summary);
  const executed = await fixture.runtime.executeAuthorized(gateway, authorization, {
    signal: new AbortController().signal,
  });
  assert.equal(executed.status, "executed");
  if (executed.status !== "executed") throw new Error("expected execution");
  assert.equal(await readFile(path.join(fixture.root, "created.txt"), "utf8"), "created by Robin\n");
  assert.equal(executed.result.agent["operation"], "create_file");
  const postGit = executed.result.agent["postGit"] as JsonObject;
  assert.equal(postGit["status"], "released");
  const entries = postGit["entries"] as readonly JsonObject[];
  assert.equal(entries.some((entry) => entry["path"] === "created.txt"), true);
  await assert.rejects(
    fixture.runtime.executeAuthorized(gateway, authorization, {
      signal: new AbortController().signal,
    }),
    (error: unknown) => domainCode(error, "invariant_violated"),
  );
});

test("file preimage and create parent replacement produce stale no-effect results", async (t) => {
  const fixture = await createFixture(t);
  const gateway = approvalGateway(fixture.runtime);
  const original = "alpha\nbeta\n";
  await writeFile(path.join(fixture.root, "tracked.txt"), original);
  const patchPrepared = await normalize(
    gateway,
    fixture.runtime,
    "robin.edit",
    "apply_patch",
    {
      path: "tracked.txt",
      expectedSha256: sha256Hex(original),
      expectedSize: Buffer.byteLength(original),
      hunks: [{ oldText: "beta", newText: "gamma", expectedOccurrences: 1 }],
    },
    2,
  );
  const patchAuthorization = approve(
    gateway,
    patchPrepared,
    fixture.runtime.approvalSummary(patchPrepared),
  );
  await writeFile(path.join(fixture.root, "tracked.txt"), "outside canary\n");
  const stalePatch = await fixture.runtime.executeAuthorized(gateway, patchAuthorization, {
    signal: new AbortController().signal,
  });
  assert.equal(stalePatch.status, "stale");
  assert.equal(JSON.stringify(stalePatch).includes("outside canary"), false);
  assert.equal(await readFile(path.join(fixture.root, "tracked.txt"), "utf8"), "outside canary\n");

  await mkdir(path.join(fixture.root, "dir"));
  const createPrepared = await normalize(
    gateway,
    fixture.runtime,
    "robin.edit",
    "create_file",
    { path: "dir/new.txt", expectedAbsent: true, content: "new\n" },
    3,
  );
  const createAuthorization = approve(
    gateway,
    createPrepared,
    fixture.runtime.approvalSummary(createPrepared),
  );
  await rename(path.join(fixture.root, "dir"), path.join(fixture.root, "old-dir"));
  await mkdir(path.join(fixture.root, "dir"));
  const staleCreate = await fixture.runtime.executeAuthorized(gateway, createAuthorization, {
    signal: new AbortController().signal,
  });
  assert.equal(staleCreate.status, "stale");
  await assert.rejects(readFile(path.join(fixture.root, "dir/new.txt")), /ENOENT/u);
});

test("process approval states no sandbox and executable changes stale before spawn", async (t) => {
  const fixture = await createFixture(t, true);
  await mkdir(path.join(fixture.root, "bin"));
  const executable = path.join(fixture.root, "bin/tool");
  await writeFile(executable, "#!/bin/sh\nprintf original\\n\n");
  await chmod(executable, 0o755);
  const gateway = approvalGateway(fixture.runtime);
  const prepared = await normalize(
    gateway,
    fixture.runtime,
    "robin.process",
    "run",
    processInput("bin/tool"),
    4,
  );
  const summary = fixture.runtime.approvalSummary(prepared);
  assert.equal(summary["sandboxed"], false);
  assert.equal(summary["filesystemIsolation"], "none");
  assert.equal(summary["networkIsolation"], "none");
  assert.match(String(summary["warning"]), /not sandboxed/u);
  const authorization = approve(gateway, prepared, summary);
  await writeFile(executable, "#!/bin/sh\nprintf changed-canary\\n\n");
  await chmod(executable, 0o755);
  const stale = await fixture.runtime.executeAuthorized(gateway, authorization, {
    signal: new AbortController().signal,
  });
  assert.equal(stale.status, "stale");
  assert.equal(JSON.stringify(stale).includes("changed-canary"), false);
});

test("live process output is escaped, bounded, raw-free, and followed by Git facts", async (t) => {
  const fixture = await createFixture(t);
  const gateway = approvalGateway(fixture.runtime);
  const prepared = await normalize(
    gateway,
    fixture.runtime,
    "robin.process",
    "run",
    processInput(process.execPath, ["-e", "process.stdout.write('ok\\u001b[31m')"]),
    5,
  );
  const authorization = approve(
    gateway,
    prepared,
    fixture.runtime.approvalSummary(prepared),
  );
  const events: RobinR2SafeProcessLifecycleEvent[] = [];
  const result = await fixture.runtime.executeAuthorized(gateway, authorization, {
    signal: new AbortController().signal,
    lifecycleSink: { publish(event) { events.push(event); } },
  });
  assert.equal(result.status, "executed");
  if (result.status !== "executed") throw new Error("expected execution");
  const output = events.find((event) => event.type === "output");
  assert.ok(output?.type === "output");
  assert.equal(output.safeText.includes("\u001b"), false);
  assert.match(output.safeText, /\\(?:x1b|u\{1b\})/u);
  assert.equal(Object.hasOwn(output, "rawBase64"), false);
  assert.equal(result.result.agent["sandboxed"], false);
  assert.equal((result.result.agent["postGit"] as JsonObject)["status"], "released");
});

interface Fixture {
  readonly root: string;
  readonly runtime: RobinR2CapabilityRuntime;
}

async function createFixture(
  t: { after(fn: () => Promise<void>): void },
  allowWorkspaceExecutables = false,
): Promise<Fixture> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "robin-tools-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const home = path.join(temporary, "home");
  await mkdir(root);
  await mkdir(home);
  const gitExecutable = await findGit();
  await runGit(gitExecutable, root, home, ["init", "-q", "-b", "main"]);
  await runGit(gitExecutable, root, home, ["config", "user.name", "Robin Test"]);
  await runGit(gitExecutable, root, home, ["config", "user.email", "robin@example.invalid"]);
  await writeFile(path.join(root, "tracked.txt"), "alpha\nbeta\n");
  await runGit(gitExecutable, root, home, ["add", "--", "tracked.txt"]);
  await runGit(gitExecutable, root, home, ["commit", "-q", "-m", "initial"]);
  const runner = new ControlledGitRunner({
    gitExecutable,
    cwd: root,
    environment: { PATH: path.dirname(gitExecutable), HOME: home, TMPDIR: os.tmpdir() },
    timeoutMs: 5_000,
    maximumStdoutBytes: 4 * 1024 * 1024,
    maximumStderrBytes: 256 * 1024,
  });
  const git = await GitReadService.open(runner);
  const workspace = await discoverPhysicalWorkspace(
    { startDirectory: root, createdFrom: "explicit_flag" },
    { gitProbe: { inspect: async () => workspaceGitFacts(git) } },
  );
  const runtime = createRobinR2CapabilityRuntime({
    workspace,
    git,
    process: {
      controller: new ProcessController({ forceWaitMs: 250, pollIntervalMs: 5 }),
      executablePolicy: {
        trustedPath: [path.dirname(process.execPath), "/usr/bin", "/bin"],
        workspaceRoot: workspace.identity.physicalRoot,
        trustedExecutableRoots: [path.dirname(process.execPath), "/usr/bin", "/bin"],
        allowWorkspaceExecutables,
      },
      environmentProfile: {
        profileId: "robin-test",
        inheritedKeys: [],
        fixed: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
      },
      ambientEnvironment: {},
    },
    clock: { now: () => "2026-08-30T12:00:00.000Z" },
  });
  return { root, runtime };
}

function workspaceGitFacts(git: GitReadService): GitWorkspaceProbeResult {
  const identity = git.identity;
  return {
    worktreeRoot: identity.workspaceRoot,
    commonDirectory: identity.commonDirectory,
    gitDirectory: identity.gitDirectory,
    objectFormat: identity.objectFormat,
    initialHead: identity.branch.oid,
    branch: identity.branch.head,
    linked: identity.linkedWorktree,
    bare: identity.bare,
    shallow: identity.shallow,
    sparse: identity.sparse,
    submodule: identity.submodule,
    operationState: identity.operationState[0] ?? "none",
    initialStatusHash: git.initialStatus.statusSha256,
  };
}

function approvalGateway(runtime: RobinR2CapabilityRuntime): CapabilityGateway {
  let approvalSequence = 202;
  return new CapabilityGateway(runtime.registry, evaluator(), {
    approvalClock: { now: () => "2026-08-30T12:00:00.000Z" },
    approvalIdSource: {
      nextApprovalId: () => ApprovalIdKind.parse(
        `apr_018f05a0-7b01-7000-8000-${(approvalSequence++).toString().padStart(12, "0")}`,
      ),
    },
  });
}

function evaluator(): PinnedPolicyEvaluator {
  return Object.freeze({
    policyVersionId: POLICY_ID,
    evaluate(action: NormalizedAction): PolicyDecision {
      const effect = action.sideEffectClass === "none" ? "allow" : "require_approval";
      return Object.freeze({
        policyVersionId: POLICY_ID,
        effect,
        winningPolicyName: "robin-r2-test",
        reason: "Test policy",
        matchedPolicyNames: Object.freeze(["robin-r2-test"]),
        trace: Object.freeze({
          languageVersion: "1",
          policyContentHash: "a".repeat(64),
          attributeCatalogs: [],
          combiningAlgorithm: "deny_overrides",
          defaultEffect: "deny",
          result: effect,
          winningPolicyName: "robin-r2-test",
          evaluations: [],
          matchedPolicyNames: ["robin-r2-test"],
        }),
      });
    },
  });
}

async function normalize(
  gateway: CapabilityGateway,
  runtime: RobinR2CapabilityRuntime,
  packId: string,
  operationId: string,
  input: JsonObject,
  sequence: number,
) {
  return gateway.normalize(
    {
      schemaVersion: 1,
      packId,
      packVersion: 1,
      operationId,
      operationVersion: 1,
      input,
    },
    {
      actionId: ActionIdKind.parse(
        `act_018f05a0-7b01-7000-8000-${sequence.toString().padStart(12, "0")}`,
      ),
      subject: { kind: "agent_driver", id: "driver:test" },
      environment: { profileId: "test", sandboxed: false },
    },
    runtime.advertisement,
  );
}

function approve(
  gateway: CapabilityGateway,
  prepared: Awaited<ReturnType<typeof normalize>>,
  summary: JsonObject,
) {
  const evaluated = gateway.evaluate(prepared);
  const challenge = gateway.createApprovalChallenge(evaluated, {
    displayedSummary: summary,
  });
  const resolution = gateway.resolveApproval(challenge, approvalResponse(challenge));
  assert.equal(resolution.status, "granted");
  if (resolution.status !== "granted") throw new Error("expected grant");
  const authorized = gateway.authorize(resolution.grant);
  assert.equal(authorized.status, "authorized");
  if (authorized.status !== "authorized") throw new Error("expected authorization");
  return authorized.authorization;
}

function approvalResponse(challenge: CapabilityApprovalChallenge) {
  return {
    schemaVersion: 1 as const,
    approvalId: challenge.approvalId,
    decision: "allow_once" as const,
    normalizedRequestHash: challenge.normalizedRequestHash,
    preconditionHash: challenge.preconditionHash,
    policySnapshotHash: challenge.policySnapshotHash,
    displayedSummaryHash: challenge.displayedSummaryHash,
  };
}

function processInput(executable: string, argv: readonly string[] = []): JsonObject {
  return {
    schemaVersion: 1,
    executable,
    argv,
    cwd: ".",
    environment: {},
    timeoutMs: 5_000,
    terminationGraceMs: 100,
    output: { retainedHeadBytes: 16_384, retainedTailBytes: 16_384, absoluteBytes: 64 * 1024 },
    stdin: { kind: "closed" },
    intent: "verification",
  };
}

function findOperation(
  runtime: RobinR2CapabilityRuntime,
  operationId: string,
): CapabilityOperation {
  const operation = runtime.packs
    .flatMap((pack) => pack.operations)
    .find((candidate) => candidate.definition.operationId === operationId);
  if (operation === undefined) throw new Error("operation missing");
  return operation;
}

async function findGit(): Promise<string> {
  const result = await exec("/usr/bin/which", ["git"]);
  return result.stdout.trim();
}

async function runGit(
  executable: string,
  root: string,
  home: string,
  args: readonly string[],
): Promise<void> {
  await exec(executable, ["-C", root, ...args], {
    env: { PATH: path.dirname(executable), HOME: home },
    maxBuffer: 4 * 1024 * 1024,
  });
}

function domainCode(error: unknown, code: string): boolean {
  return isDomainError(error) && error.code === code;
}
