import assert from "node:assert/strict";
import {
  execFile as execFileCallback,
  spawn,
} from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { GENERATED_BUILD_METADATA } from "./generated-build-metadata.js";

const execFile = promisify(execFileCallback);
const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));
const SYNTHETIC_OBJECTIVE = fileURLToPath(
  new URL("../testdata/synthetic-payload.json", import.meta.url),
);
const CODING_OBJECTIVE = fileURLToPath(
  new URL("../testdata/coding-objective.json", import.meta.url),
);
const STRICT_POLICY = fileURLToPath(
  new URL("../testdata/strict.guard", import.meta.url),
);
const POLICY_CASES = fileURLToPath(
  new URL("../testdata/policy-cases-v1.json", import.meta.url),
);
const ALLOW_POLICY = fileURLToPath(
  new URL("../testdata/allow-pure.guard", import.meta.url),
);
const DENY_POLICY = fileURLToPath(
  new URL("../testdata/deny-pure.guard", import.meta.url),
);
const POLICY_ACTION = fileURLToPath(
  new URL("../testdata/policy-action.json", import.meta.url),
);
const POLICY_ACTIONS = fileURLToPath(
  new URL("../testdata/policy-actions-v1.json", import.meta.url),
);
const COLD_PATH_LOADER = fileURLToPath(
  new URL("../scripts/reject-warm-cli-imports.mjs", import.meta.url),
);
const COLD_SIDE_EFFECT_SENTINEL = fileURLToPath(
  new URL("../scripts/reject-cold-side-effects.mjs", import.meta.url),
);
const PROCESS_INTERNALS = process as typeof process & {
  readonly binding?: (name: string) => unknown;
  readonly _debugProcess?: (processId: number) => void;
  readonly _kill?: (processId: number, signal: number) => unknown;
  readonly _linkedBinding?: (name: string) => unknown;
};

test("help, version, and parse failures never resolve the warm CLI graph", async () => {
  const cases = [
    {
      argv: ["--version"],
      stdout: new RegExp(`^${escapeRegExp(GENERATED_BUILD_METADATA.version)}\\n$`, "u"),
      stderr: /^$/u,
      code: 0,
    },
    { argv: ["--help"], stdout: /^Usage: robin /u, stderr: /^$/u, code: 0 },
    { argv: ["run", "--help"], stdout: /^Usage: robin run /u, stderr: /^$/u, code: 0 },
    { argv: ["policy", "--help"], stdout: /^Usage: robin policy /u, stderr: /^$/u, code: 0 },
    { argv: ["policy", "check", "--help"], stdout: /^Usage: robin policy check /u, stderr: /^$/u, code: 0 },
    { argv: ["policy", "format", "--help"], stdout: /^Usage: robin policy format /u, stderr: /^$/u, code: 0 },
    { argv: ["policy", "test", "--help"], stdout: /^Usage: robin policy test /u, stderr: /^$/u, code: 0 },
    { argv: ["policy", "explain", "--help"], stdout: /^Usage: robin policy explain /u, stderr: /^$/u, code: 0 },
    { argv: ["policy", "simulate", "--help"], stdout: /^Usage: robin policy simulate /u, stderr: /^$/u, code: 0 },
    {
      argv: ["--unknown-cold-path-option"],
      stdout: /^$/u,
      stderr: /^robin: Unknown option: --unknown-cold-path-option\./u,
      code: 2,
    },
  ] as const;

  for (const fixture of cases) {
    const result = await executeCold(fixture.argv);
    assert.equal(result.code, fixture.code, fixture.argv.join(" "));
    assert.match(result.stdout, fixture.stdout, fixture.argv.join(" "));
    assert.match(result.stderr, fixture.stderr, fixture.argv.join(" "));
  }

  const armedSentinel = await executeCold(["-p", "prove the warm boundary"]);
  assert.equal(armedSentinel.code, 7);
  assert.match(armedSentinel.stderr, /robin_cold_path_warm_import/u);

  const forbiddenBuiltinImport = await executeNode([
    "--no-warnings",
    "--experimental-loader",
    pathToFileURL(COLD_PATH_LOADER).href,
    "--input-type=module",
    "--eval",
    "await import('node:fs')",
  ]);
  assert.notEqual(forbiddenBuiltinImport.code, 0);
  assert.match(
    forbiddenBuiltinImport.stderr,
    /robin_cold_path_warm_import/u,
  );

  const sideEffectProbes = [
    "await fetch('https://example.invalid')",
    "process.stdin.setRawMode(true)",
  ];
  if (typeof process.getBuiltinModule === "function") {
    sideEffectProbes.push("process.getBuiltinModule('node:fs')");
    sideEffectProbes.push(
      "process.getBuiltinModule('node:module').createRequire(import.meta.url)('node:fs')",
    );
  }
  if (typeof PROCESS_INTERNALS.binding === "function") {
    sideEffectProbes.push("process.binding('fs')");
  }
  if (typeof PROCESS_INTERNALS._linkedBinding === "function") {
    sideEffectProbes.push("process._linkedBinding('fs')");
  }
  if (typeof PROCESS_INTERNALS._kill === "function") {
    sideEffectProbes.push("process._kill(process.pid, 0)");
  }
  if (typeof PROCESS_INTERNALS._debugProcess === "function") {
    sideEffectProbes.push("process._debugProcess(process.pid)");
  }
  if (typeof process.dlopen === "function") {
    sideEffectProbes.push("process.dlopen({}, '/tmp/robin-cold-path-probe.node')");
  }
  if (typeof process.execve === "function" && process.platform !== "win32") {
    sideEffectProbes.push("process.execve('/usr/bin/true', ['true'], {})");
  }
  if (typeof process.report?.writeReport === "function") {
    sideEffectProbes.push(
      `process.report.writeReport(${JSON.stringify(process.platform === "win32" ? "NUL" : "/dev/null")})`,
    );
  }
  for (const probe of sideEffectProbes) {
    const result = await executeNode([
      "--no-warnings",
      "--import",
      pathToFileURL(COLD_SIDE_EFFECT_SENTINEL).href,
      "--input-type=module",
      "--eval",
      probe,
    ]);
    assert.notEqual(result.code, 0, probe);
    assert.match(result.stderr, /robin_cold_path_side_effect/u, probe);
  }
});

test("source-installed bin runs the synthetic human profile", async () => {
  const result = await execute([
    "run",
    "--profile",
    "synthetic-demo",
    "--format",
    "human",
    "--objective-file",
    SYNTHETIC_OBJECTIVE,
  ]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Robin run run_/u);
  assert.match(result.stdout, /RunCompleted/u);
  assert.match(result.stdout, /Status: completed/u);
  assert.match(result.stdout, /GUARDED AGENTS TRANSFORM BOUNDED DATA\./u);
  assert.equal(result.stderr, "");
});

test("source-installed bin runs the coding profile as clean JSONL", async () => {
  const result = await execute([
    "run",
    "--profile",
    "coding-virtual",
    "--jsonl",
    "--objective-file",
    CODING_OBJECTIVE,
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length > 20, true);
  const decoded = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const item of decoded) {
    assert.deepEqual(Object.keys(item), [
      "schemaVersion",
      "cursor",
      "timestamp",
      "type",
      "runId",
      "payload",
    ]);
  }
  assert.equal(decoded.at(-1)?.["type"], "RunCompleted");
  assert.equal(decoded.at(-1)?.["cursor"], 40);
});

test("source-installed bin runs quiet shorthand without progress contamination", async () => {
  const result = await execute([
    "run",
    "--profile",
    "synthetic-demo",
    "--quiet",
    "--",
    '{"recordId":"greeting","mode":"uppercase"}',
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output["outcomeType"], "synthetic.transform.completed");
  assert.equal(result.stdout.trimEnd().split("\n").length, 1);
});

test("source-installed bin rejects API-key flags without leaking the value", async () => {
  const secret = "subprocess-secret-canary";
  const result = await execute([
    "run",
    "--profile",
    "synthetic-demo",
    "--api-key",
    secret,
  ]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown option: --api-key/u);
  assert.doesNotMatch(result.stderr, new RegExp(secret, "u"));
});

test("source-installed bin runs one headless Robin preview turn", async () => {
  const result = await execute([
    "-p",
    "--model",
    "synthetic-r1-v1",
    "Explain the current slice.",
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^I’ll inspect the deterministic workspace summary/u);
  assert.match(result.stdout, /src\/calculate\.ts/u);
  assert.match(result.stdout, /No physical repository was read or changed/u);
});

test("source-installed bin emits parseable stream JSON for a preview turn", async () => {
  const result = await execute([
    "--print",
    "--model",
    "synthetic-r1-v1",
    "--output-format",
    "stream-json",
    "Stream one turn.",
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const records = result.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      readonly schemaVersion: number;
      readonly persistence: string;
      readonly event: { readonly type: string };
    });
  assert.equal(records.length > 3, true);
  assert.equal(records.every((record) => record.schemaVersion === 1), true);
  assert.equal(records.every((record) => record.persistence === "ephemeral"), true);
  assert.equal(records[0]?.event.type, "UserMessageAccepted");
  assert.equal(records.at(-1)?.event.type, "TurnCompleted");
});

test("default headless R2 binds the physical repository and denies edits", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "robin-cli-r2-print-"));
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  const repositoryRoot = path.join(fixtureRoot, "repository");
  await mkdir(path.join(repositoryRoot, "src"), { recursive: true });
  const sourcePath = path.join(repositoryRoot, "src", "calculate.ts");
  const initialSource = [
    "export function calculate(values: readonly number[]): number {",
    "  let total = 0;",
    "  for (const value of values) total = total - value;",
    "  return total;",
    "}",
    "",
    "export function normalizeLabel(label: string): string {",
    "  return label.toLowerCase();",
    "}",
    "",
  ].join("\n");
  await writeFile(sourcePath, initialSource, "utf8");
  await writeFile(
    path.join(repositoryRoot, "package.json"),
    `${JSON.stringify({ name: "robin-cli-r2-print", private: true })}\n`,
    "utf8",
  );
  await execFile("git", ["init", "--quiet", repositoryRoot]);
  await execFile("git", ["-C", repositoryRoot, "add", "--", "package.json", "src/calculate.ts"]);
  await execFile(
    "git",
    [
      "-C",
      repositoryRoot,
      "-c",
      "user.name=Robin CLI Test",
      "-c",
      "user.email=robin-cli@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
  );

  const result = await execute(
    ["--print", "--output-format", "json", "Fix the deterministic defect."],
    { cwd: repositoryRoot },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(await readFile(sourcePath, "utf8"), initialSource);
  const decoded = JSON.parse(result.stdout) as {
    readonly permissions: string;
    readonly sandboxed: boolean;
    readonly workspace: {
      readonly physicalRoot: string;
      readonly initialDirty: boolean;
      readonly filesystemIsolation: string;
      readonly networkIsolation: string;
    };
    readonly events: readonly {
      readonly type: string;
      readonly payload?: { readonly decision?: string };
    }[];
    readonly result: string;
  };
  assert.equal(decoded.permissions, "live-workspace-manual-approval");
  assert.equal(decoded.sandboxed, false);
  assert.equal(decoded.workspace.physicalRoot, await realpath(repositoryRoot));
  assert.equal(decoded.workspace.initialDirty, false);
  assert.equal(decoded.workspace.filesystemIsolation, "none");
  assert.equal(decoded.workspace.networkIsolation, "none");
  assert.equal(
    decoded.events.filter((event) => event.type === "ApprovalRequested").length,
    1,
  );
  assert.equal(
    decoded.events.some(
      (event) =>
        event.type === "ApprovalResolved" && event.payload?.decision === "deny",
    ),
    true,
  );
  assert.match(decoded.result, /denied/u);
});

test(
  "source-installed bin cancels a slow headless turn when its output pipe closes",
  { timeout: 30_000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        BIN,
        "--print",
        "--model",
        "synthetic-r1-v1",
        "--output-format",
        "stream-json",
        "[scenario:slow]",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await once(child.stdout, "data");
    child.stdout.destroy();
    const [code, signal] = (await once(child, "close")) as [
      number | null,
      NodeJS.Signals | null,
    ];

    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error' event|node:events/u);
  },
);

test("source-installed bin checks, formats, and tests policies", async () => {
  const checked = await execute(["policy", "check", STRICT_POLICY, "--json"]);
  assert.equal(checked.code, 0);
  assert.equal(checked.stderr, "");
  const checkedPayload = JSON.parse(checked.stdout) as Record<string, unknown>;
  assert.equal(checkedPayload["ok"], true);

  const formatted = await execute(["policy", "format", ALLOW_POLICY]);
  assert.equal(formatted.code, 0);
  assert.equal(formatted.stderr, "");
  assert.match(formatted.stdout, /^policy "allow-pure" priority 50/u);

  const tested = await execute([
    "policy",
    "test",
    STRICT_POLICY,
    "--cases",
    POLICY_CASES,
    "--json",
  ]);
  assert.equal(tested.code, 0);
  assert.equal(tested.stderr, "");
  const testedPayload = JSON.parse(tested.stdout) as Record<string, unknown>;
  assert.equal(testedPayload["passed"], 31);
  assert.equal(testedPayload["failed"], 0);
});

test("source-installed bin explains and simulates without effects", async () => {
  const explained = await execute([
    "policy",
    "explain",
    ALLOW_POLICY,
    "--action",
    POLICY_ACTION,
    "--json",
  ]);
  assert.equal(explained.code, 0);
  assert.equal(explained.stderr, "");
  const explainedPayload = JSON.parse(explained.stdout) as Record<string, unknown>;
  assert.equal(explainedPayload["effect"], "allow");
  assert.equal(explainedPayload["winningPolicyName"], "allow-pure");

  const simulated = await execute([
    "policy",
    "simulate",
    "--from",
    ALLOW_POLICY,
    "--to",
    DENY_POLICY,
    "--actions",
    POLICY_ACTIONS,
    "--json",
  ]);
  assert.equal(simulated.code, 0);
  assert.equal(simulated.stderr, "");
  const simulatedPayload = JSON.parse(simulated.stdout) as {
    readonly entries: readonly { readonly category: string }[];
  };
  assert.equal(simulatedPayload.entries[0]?.category, "newly_denied");
});

async function execute(
  argv: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return executeNode([BIN, ...argv], options);
}

async function executeCold(argv: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return executeNode([
    "--no-warnings",
    "--import",
    pathToFileURL(COLD_SIDE_EFFECT_SENTINEL).href,
    "--experimental-loader",
    pathToFileURL(COLD_PATH_LOADER).href,
    BIN,
    ...argv,
  ]);
}

async function executeNode(
  argv: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const result = await execFile(process.execPath, argv, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!isExecFileError(error)) throw error;
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
    };
  }
}

function isExecFileError(value: unknown): value is {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
} {
  return typeof value === "object" && value !== null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
