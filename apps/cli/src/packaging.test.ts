import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const execFile = promisify(execFileCallback);
const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY_ROOT = resolve(APP_ROOT, "../..");
const COLD_PATH_LOADER = join(
  APP_ROOT,
  "scripts",
  "reject-warm-cli-imports.mjs",
);
const COLD_SIDE_EFFECT_SENTINEL = join(
  APP_ROOT,
  "scripts",
  "reject-cold-side-effects.mjs",
);
const PTY_DRIVER = join(
  REPOSITORY_ROOT,
  "tests",
  "pty",
  "robin_pty_driver.py",
);
const PYTHON = process.env.ROBIN_TEST_PYTHON ?? "/usr/bin/python3";
const R2_APPROVAL_TOOLS = Object.freeze([
  "robin.edit.apply_patch@1",
  "robin.process.run@1",
  "robin.edit.apply_patch@1",
  "robin.process.run@1",
]);
const INITIAL_CODING_SOURCE = [
  "export function calculateTotal(values: readonly number[]): number {",
  "  return values.reduce((total, value) => total - value, 0);",
  "}",
  "",
  "export function formatLabel(label: string): string {",
  "  return label.toLowerCase();",
  "}",
  "",
].join("\n");
const REPAIRED_CODING_SOURCE = INITIAL_CODING_SOURCE
  .replace("total - value", "total + value")
  .replace("return label.toLowerCase();", "return label.toUpperCase();");

interface PackResult {
  readonly filename: string;
  readonly files: readonly {
    readonly path: string;
    readonly mode: number;
    readonly size: number;
  }[];
  readonly integrity: string;
  readonly name: string;
  readonly npmVersion: string;
  readonly shasum: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly version: string;
}

interface ReviewedPackInventory {
  readonly schemaVersion: number;
  readonly packageName: string;
  readonly archive: {
    readonly filename: string;
    readonly tar: {
      readonly bytes: number;
      readonly sha256: string;
    };
    readonly compressionProfiles: readonly {
      readonly id: string;
      readonly platform: NodeJS.Platform;
      readonly arch: NodeJS.Architecture;
      readonly npmVersion: string;
      readonly bytes: number;
      readonly sha256: string;
    }[];
  };
  readonly files: readonly {
    readonly path: string;
    readonly type: "file";
    readonly mode: "0644" | "0755";
    readonly bytes: number;
    readonly sha256: string;
  }[];
}

const MAXIMUM_PACK_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_PACK_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAXIMUM_PACK_FILE_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const REVIEWED_PACK_INVENTORY_PATH = join(
  REPOSITORY_ROOT,
  "evidence",
  "inventory",
  "r2-cli-tarball-v1.json",
);
const REVIEWED_PACK_INVENTORY = await loadReviewedPackInventory();

test("npm pack dry-run contains only the reviewed runtime inventory", async () => {
  const result = await npmPack(["--dry-run", "--json"]);
  assertReviewedPackInventory(result);
});

test("the compiled Robin entry point is directly executable", async () => {
  const metadata = await stat(join(APP_ROOT, "dist", "bin.js"));
  assert.notEqual(metadata.mode & 0o111, 0);
});

test("the actual tarball installs with its local workspace closure and runs offline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "Robin package Ω space-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const pack = await npmPack(["--json", "--pack-destination", directory]);
  assertReviewedPackInventory(pack);
  const tarball = join(directory, pack.filename);
  await assertPackArchiveIntegrity(pack, tarball);
  const installRoot = join(directory, "install");
  await mkdir(installRoot);
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify({ name: "robin-cli-install-smoke", private: true })}\n`,
    "utf8",
  );
  const dependencyPaths = await localDependencyPaths(directory);
  await execFile(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--no-save",
      tarball,
      ...dependencyPaths,
    ],
    {
      cwd: installRoot,
      env: await isolatedNpmEnvironment(join(directory, "install-npm-environment")),
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  await assertSelfContainedInstallation(installRoot);
  const installedManifest = JSON.parse(
    await readFile(
      join(
        installRoot,
        "node_modules",
        "@zachshotamartin",
        "robin",
        "package.json",
      ),
      "utf8",
    ),
  ) as {
    readonly bin?: Readonly<Record<string, string>>;
    readonly name: string;
    readonly version: string;
  };
  assert.equal(installedManifest.name, REVIEWED_PACK_INVENTORY.packageName);
  assert.equal(installedManifest.bin?.["robin"], "./dist/bin.js");
  assert.match(installedManifest.version, /^[0-9]+\.[0-9]+\.[0-9]+/u);
  const installedPackageRoot = join(
    installRoot,
    "node_modules",
    "@zachshotamartin",
    "robin",
  );
  await assertPackedContentsContainNoDevelopmentIdentity(
    installedPackageRoot,
  );
  const installedSentinelRoot = join(installedPackageRoot, "scripts");
  await mkdir(installedSentinelRoot);
  const installedColdPathLoader = join(
    installedSentinelRoot,
    "reject-warm-cli-imports.mjs",
  );
  const installedColdSideEffectSentinel = join(
    installedSentinelRoot,
    "reject-cold-side-effects.mjs",
  );
  await Promise.all([
    cp(COLD_PATH_LOADER, installedColdPathLoader),
    cp(COLD_SIDE_EFFECT_SENTINEL, installedColdSideEffectSentinel),
  ]);

  const installedCommand = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "robin.cmd" : "robin",
  );
  const stateCanaryRoot = join(directory, "cold-state-canary");
  const coldWorkingDirectory = join(directory, "cold-working-directory");
  await mkdir(stateCanaryRoot);
  await mkdir(coldWorkingDirectory);
  const coldEnvironment: NodeJS.ProcessEnv = {
    CI: "1",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    HOME: join(stateCanaryRoot, "home"),
    USERPROFILE: join(stateCanaryRoot, "user-profile"),
    APPDATA: join(stateCanaryRoot, "app-data"),
    LOCALAPPDATA: join(stateCanaryRoot, "local-app-data"),
    TEMP: join(stateCanaryRoot, "temp"),
    TMP: join(stateCanaryRoot, "tmp"),
    TMPDIR: join(stateCanaryRoot, "tmpdir"),
    ROBIN_CONFIG_HOME: join(stateCanaryRoot, "robin-config"),
    ROBIN_DATA_HOME: join(stateCanaryRoot, "robin-data"),
    ROBIN_STATE_HOME: join(stateCanaryRoot, "robin-state"),
    ROBIN_CACHE_HOME: join(stateCanaryRoot, "robin-cache"),
    XDG_CONFIG_HOME: join(stateCanaryRoot, "config"),
    XDG_DATA_HOME: join(stateCanaryRoot, "data"),
    XDG_STATE_HOME: join(stateCanaryRoot, "state"),
    XDG_CACHE_HOME: join(stateCanaryRoot, "cache"),
    XDG_RUNTIME_DIR: join(stateCanaryRoot, "runtime"),
    // Node 22.23+ may create its own module compile cache below TMPDIR before
    // Robin's entry point runs. Disable that runtime-owned cache so this
    // canary measures only filesystem state created by the installed CLI.
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: [
      "--no-warnings",
      `--import=${pathToFileURL(installedColdSideEffectSentinel).href}`,
      `--experimental-loader=${pathToFileURL(installedColdPathLoader).href}`,
    ].join(" "),
  };
  copyPlatformCommandEnvironment(coldEnvironment);
  Object.freeze(coldEnvironment);
  const coldCases = [
    { argv: ["--version"], output: `${installedManifest.version}\n` },
    { argv: ["--help"], output: /^Usage: robin \[options\]/u },
    { argv: ["run", "--help"], output: /^Usage: robin run /u },
    { argv: ["policy", "--help"], output: /^Usage: robin policy /u },
    { argv: ["policy", "check", "--help"], output: /^Usage: robin policy check /u },
    { argv: ["policy", "format", "--help"], output: /^Usage: robin policy format /u },
    { argv: ["policy", "test", "--help"], output: /^Usage: robin policy test /u },
    { argv: ["policy", "explain", "--help"], output: /^Usage: robin policy explain /u },
    { argv: ["policy", "simulate", "--help"], output: /^Usage: robin policy simulate /u },
  ] as const;
  const developmentPaths = new Set([
    REPOSITORY_ROOT,
    APP_ROOT,
    process.cwd(),
    directory,
    installRoot,
  ]);
  for (const fixture of coldCases) {
    const commandResult = await execFile(installedCommand, fixture.argv, {
      cwd: coldWorkingDirectory,
      env: coldEnvironment,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(commandResult.stderr, "", fixture.argv.join(" "));
    if (typeof fixture.output === "string") {
      assert.equal(commandResult.stdout, fixture.output);
    } else {
      assert.match(commandResult.stdout, fixture.output);
    }
    for (const developmentPath of developmentPaths) {
      assert.equal(
        commandResult.stdout.includes(developmentPath),
        false,
        `installed ${fixture.argv.join(" ")} leaked ${developmentPath}`,
      );
    }
  }
  assert.deepEqual(await readdir(stateCanaryRoot, { recursive: true }), []);
  assert.deepEqual(await readdir(coldWorkingDirectory, { recursive: true }), []);

  assert.equal(
    await readFile(
      join(
        installRoot,
        "node_modules",
        "@zachshotamartin",
        "robin",
        "LICENSE",
      ),
      "utf8",
    ),
    await readFile(join(REPOSITORY_ROOT, "LICENSE"), "utf8"),
  );

  const scenarioFixture = await readFile(
    join(
      installRoot,
      "node_modules",
      "@guard",
      "milestone-a-scenarios",
      "fixtures",
      "synthetic-transform.history.json",
    ),
    "utf8",
  );
  assert.equal(Array.isArray(JSON.parse(scenarioFixture) as unknown), true);

  const result = await execFile(
    process.execPath,
    [
      join(
        installRoot,
        "node_modules",
        "@zachshotamartin",
        "robin",
        "dist",
        "bin.js",
      ),
      "--version",
    ],
    { cwd: installRoot, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(result.stdout, `${installedManifest.version}\n`);
  assert.equal(result.stderr, "");

  const previewResult = await execFile(
    installedCommand,
    [
      "-p",
      "--model",
      "synthetic-r1-v1",
      "Verify the installed Robin preview.",
    ],
    {
      cwd: installRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(previewResult.stderr, "");
  assert.match(
    previewResult.stdout,
    /^I’ll inspect the deterministic workspace summary/u,
  );
  assert.match(previewResult.stdout, /No physical repository was read or changed/u);

  const installedBin = join(
    installRoot,
    "node_modules",
    "@zachshotamartin",
    "robin",
    "dist",
    "bin.js",
  );
  const testdata = join(APP_ROOT, "testdata");
  const runPolicy = async (args: readonly string[]) =>
    execFile(process.execPath, [installedBin, "policy", ...args], {
      cwd: installRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });

  const policyResult = await runPolicy([
    "check",
    join(testdata, "strict.guard"),
    "--json",
  ]);
  assert.equal(policyResult.stderr, "");
  assert.equal((JSON.parse(policyResult.stdout) as { readonly ok: boolean }).ok, true);

  const formatResult = await runPolicy([
    "format",
    join(testdata, "strict.guard"),
    "--json",
  ]);
  assert.equal(formatResult.stderr, "");
  assert.match(
    (JSON.parse(formatResult.stdout) as { readonly canonicalText: string })
      .canonicalText,
    /policy /u,
  );

  const testResult = await runPolicy([
    "test",
    join(testdata, "strict.guard"),
    "--cases",
    join(testdata, "policy-cases-v1.json"),
    "--json",
  ]);
  assert.equal(testResult.stderr, "");
  const testPayload = JSON.parse(testResult.stdout) as {
    readonly failed: number;
    readonly passed: number;
  };
  assert.equal(testPayload.failed, 0);
  assert.ok(testPayload.passed >= 25);

  const explainResult = await runPolicy([
    "explain",
    join(testdata, "strict.guard"),
    "--action",
    join(testdata, "policy-action.json"),
    "--json",
  ]);
  assert.equal(explainResult.stderr, "");
  assert.equal(
    typeof (JSON.parse(explainResult.stdout) as { readonly effect: unknown }).effect,
    "string",
  );

  const simulationResult = await runPolicy([
    "simulate",
    "--from",
    join(testdata, "allow-pure.guard"),
    "--to",
    join(testdata, "deny-pure.guard"),
    "--actions",
    join(testdata, "policy-actions-v1.json"),
    "--json",
  ]);
  assert.equal(simulationResult.stderr, "");
  const simulationPayload = JSON.parse(simulationResult.stdout) as {
    readonly totalActions: number;
    readonly counts: Readonly<Record<string, number>>;
  };
  assert.ok(simulationPayload.totalActions >= 1);
  assert.ok((simulationPayload.counts["newly_denied"] ?? 0) >= 1);

  const installedPtyWorkingDirectory = join(
    directory,
    "installed PTY working directory Ω",
  );
  const installedPtyGitConfig = join(directory, "installed-pty.gitconfig");
  await mkdir(installedPtyWorkingDirectory);
  await writeFile(installedPtyGitConfig, "", "utf8");
  const installedPtyEnvironment: NodeJS.ProcessEnv = {
    ...coldEnvironment,
    // The macOS system Python otherwise writes imported-module bytecode under
    // HOME/Library/Caches/com.apple.python. That is harness state, not Robin
    // state, and would invalidate the empty-home canary before it can measure
    // the installed CLI accurately.
    PYTHONDONTWRITEBYTECODE: "1",
    GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
    GIT_AUTHOR_EMAIL: "robin-fixture@example.invalid",
    GIT_AUTHOR_NAME: "Robin Fixture",
    GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
    GIT_COMMITTER_EMAIL: "robin-fixture@example.invalid",
    GIT_COMMITTER_NAME: "Robin Fixture",
    GIT_CONFIG_GLOBAL: installedPtyGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_cache: join(directory, "installed-pty-npm-cache"),
    npm_config_update_notifier: "false",
  };
  delete installedPtyEnvironment.NODE_OPTIONS;
  Object.freeze(installedPtyEnvironment);
  const installedPtyResult = await execFile(
    PYTHON,
    [
      PTY_DRIVER,
      "--scenario",
      "happy",
      "--cwd",
      installedPtyWorkingDirectory,
      "--node",
      process.execPath,
      "--binary",
      installedCommand,
    ],
    {
      cwd: installedPtyWorkingDirectory,
      env: installedPtyEnvironment,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(installedPtyResult.stderr, "");
  const installedPtyPayload = JSON.parse(installedPtyResult.stdout) as {
    readonly schemaVersion: number;
    readonly scenario: string;
    readonly exitCode: number;
    readonly termiosRestored: boolean;
    readonly transcriptBase64: string;
    readonly normalizedTranscript: string;
  };
  assert.equal(installedPtyPayload.schemaVersion, 1);
  assert.equal(installedPtyPayload.scenario, "happy");
  assert.equal(installedPtyPayload.exitCode, 0);
  assert.equal(
    installedPtyPayload.termiosRestored,
    true,
    installedPtyPayload.normalizedTranscript,
  );
  assert.match(
    installedPtyPayload.normalizedTranscript,
    /robin\.synthetic\.workspace_summary@1/u,
  );
  assert.match(
    installedPtyPayload.normalizedTranscript,
    /robin\.synthetic\.inspect_file@1/u,
  );
  const installedPtyTranscript = Buffer.from(
    installedPtyPayload.transcriptBase64,
    "base64",
  ).toString("utf8");
  assert.match(installedPtyTranscript, /\u001b\[\?2004h/u);
  assert.match(installedPtyTranscript, /\u001b\[\?2004l/u);
  assert.match(installedPtyTranscript, /\u001b\[\?25h/u);
  assert.match(installedPtyTranscript, /\u001b\[0m\r+\n/u);
  assert.deepEqual(await readdir(stateCanaryRoot, { recursive: true }), []);
  assert.deepEqual(
    await readdir(installedPtyWorkingDirectory, { recursive: true }),
    [],
  );

  const installedR2Fixture = join(directory, "installed R2 coding fixture Ω");
  await createInstalledCodingFixture(
    installedR2Fixture,
    installedPtyEnvironment,
  );
  const installedR2InitialWorkspace = await snapshotFixtureTree(
    installedR2Fixture,
    true,
  );
  const installedR2GitDirectory = await gitText(
    installedR2Fixture,
    ["rev-parse", "--absolute-git-dir"],
    installedPtyEnvironment,
  );
  const installedR2InitialGitStorage = await snapshotFixtureTree(
    installedR2GitDirectory,
    false,
  );
  const installedR2InitialHead = await gitText(
    installedR2Fixture,
    ["rev-parse", "--verify", "HEAD"],
    installedPtyEnvironment,
  );
  const installedR2InitialIndex = await readFile(
    join(installedR2GitDirectory, "index"),
  );

  const installedR2PtyResult = await execFile(
    PYTHON,
    [
      PTY_DRIVER,
      "--scenario",
      "r2_approve",
      "--cwd",
      installedR2Fixture,
      "--node",
      process.execPath,
      "--binary",
      installedCommand,
    ],
    {
      cwd: installedR2Fixture,
      env: installedPtyEnvironment,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(installedR2PtyResult.stderr, "");
  const installedR2PtyPayload = JSON.parse(installedR2PtyResult.stdout) as {
    readonly schemaVersion: number;
    readonly scenario: string;
    readonly modelId: string;
    readonly exitCode: number;
    readonly approvalTools: readonly string[];
    readonly termiosRestored: boolean;
    readonly transcriptBase64: string;
    readonly normalizedTranscript: string;
  };
  assert.equal(installedR2PtyPayload.schemaVersion, 1);
  assert.equal(installedR2PtyPayload.scenario, "r2_approve");
  assert.equal(installedR2PtyPayload.modelId, "synthetic-r2-v1");
  assert.equal(installedR2PtyPayload.exitCode, 0);
  assert.deepEqual(installedR2PtyPayload.approvalTools, R2_APPROVAL_TOOLS);
  assert.equal(
    installedR2PtyPayload.termiosRestored,
    true,
    installedR2PtyPayload.normalizedTranscript,
  );
  assert.match(
    installedR2PtyPayload.normalizedTranscript,
    /robin\.edit\.apply_patch@1/u,
  );
  assert.match(
    installedR2PtyPayload.normalizedTranscript,
    /robin\.process\.run@1/u,
  );
  assert.match(
    installedR2PtyPayload.normalizedTranscript,
    /robin\.git\.status@1/u,
  );
  assert.match(
    installedR2PtyPayload.normalizedTranscript,
    /robin\.git\.diff@1/u,
  );
  assert.match(
    installedR2PtyPayload.normalizedTranscript,
    /direct npm test verification passed after 2 attempts/u,
  );
  const installedR2Transcript = Buffer.from(
    installedR2PtyPayload.transcriptBase64,
    "base64",
  ).toString("utf8");
  assert.match(installedR2Transcript, /\u001b\[\?2004h/u);
  assert.match(installedR2Transcript, /\u001b\[\?2004l/u);
  assert.match(installedR2Transcript, /\u001b\[\?25h/u);
  assert.match(installedR2Transcript, /\u001b\[0m\r+\n/u);

  assert.equal(
    await readFile(join(installedR2Fixture, "src", "calculate.ts"), "utf8"),
    REPAIRED_CODING_SOURCE,
  );
  assert.equal(
    await readFile(
      join(installedR2Fixture, "notes", "user-notes.txt"),
      "utf8",
    ),
    "keep this user-authored baseline\npre-existing uncommitted note\n",
  );
  assert.equal(
    await readFile(join(installedR2Fixture, "scratch-user.txt"), "utf8"),
    "pre-existing untracked user content\n",
  );
  const installedR2FinalWorkspace = await snapshotFixtureTree(
    installedR2Fixture,
    true,
  );
  assertOnlyFixtureSourceChanged(
    installedR2InitialWorkspace,
    installedR2FinalWorkspace,
  );
  assert.equal(
    await gitText(
      installedR2Fixture,
      ["rev-parse", "--verify", "HEAD"],
      installedPtyEnvironment,
    ),
    installedR2InitialHead,
  );
  assert.deepEqual(
    await readFile(join(installedR2GitDirectory, "index")),
    installedR2InitialIndex,
  );
  assert.deepEqual(
    await snapshotFixtureTree(installedR2GitDirectory, false),
    installedR2InitialGitStorage,
  );
  const installedR2Status = await gitBuffer(
    installedR2Fixture,
    [
      "-c",
      "core.quotepath=false",
      "-c",
      "status.renames=false",
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ],
    installedPtyEnvironment,
  );
  const installedR2StatusText = installedR2Status.toString("utf8");
  assert.match(installedR2StatusText, /src\/calculate\.ts/u);
  assert.match(installedR2StatusText, /notes\/user-notes\.txt/u);
  assert.match(installedR2StatusText, /\? scratch-user\.txt\0/u);
  assert.deepEqual(await readdir(stateCanaryRoot, { recursive: true }), []);

  await execFile(
    "npm",
    [
      "uninstall",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--no-save",
      REVIEWED_PACK_INVENTORY.packageName,
    ],
    {
      cwd: installRoot,
      env: await isolatedNpmEnvironment(
        join(directory, "uninstall-npm-environment"),
      ),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  await assertPathMissing(installedPackageRoot);
  await assertPathMissing(installedCommand);
});

interface FixtureTreeEntry {
  readonly dev: string;
  readonly ino: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly nlink: number;
  readonly path: string;
  readonly sha256?: string;
  readonly size?: number;
}

async function createInstalledCodingFixture(
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await Promise.all([
    mkdir(join(workspaceRoot, "src"), { recursive: true }),
    mkdir(join(workspaceRoot, "notes"), { recursive: true }),
    mkdir(join(workspaceRoot, "test"), { recursive: true }),
  ]);
  await gitBuffer(
    workspaceRoot,
    ["init", "--initial-branch=main"],
    environment,
  );
  await Promise.all([
    writeFile(
      join(workspaceRoot, "README.md"),
      "# Robin repository fixture\n",
      "utf8",
    ),
    writeFile(join(workspaceRoot, "src", "answer.txt"), "41\n", "utf8"),
    writeFile(join(workspaceRoot, "conflict.txt"), "shared baseline\n", "utf8"),
    writeFile(join(workspaceRoot, ".gitignore"), "ignored/\n*.generated\n", "utf8"),
    writeFile(
      join(workspaceRoot, ".gitattributes"),
      "*.txt text\n*.bin binary\n",
      "utf8",
    ),
    writeFile(join(workspaceRoot, "verify-fixture.sh"), "#!/bin/sh\nexit 0\n", "utf8"),
  ]);
  await chmod(join(workspaceRoot, "verify-fixture.sh"), 0o755);
  await gitBuffer(workspaceRoot, ["add", "--all"], environment);
  await gitBuffer(
    workspaceRoot,
    ["commit", "-m", "fixture baseline"],
    environment,
  );

  await Promise.all([
    writeFile(
      join(workspaceRoot, "src", "calculate.ts"),
      INITIAL_CODING_SOURCE,
      "utf8",
    ),
    writeFile(
      join(workspaceRoot, "test", "calculate.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFile } from "node:fs/promises";',
        'import test from "node:test";',
        "",
        'test("calculation and label regressions are fixed", async () => {',
        '  const source = await readFile(new URL("../src/calculate.ts", import.meta.url), "utf8");',
        '  assert.match(source, /total \\+ value/u, "the reducer must add each value");',
        '  assert.match(source, /return label\\.toUpperCase\\(\\);/u, "labels must be uppercase");',
        "});",
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "robin-r2-coding-fixture",
          private: true,
          scripts: { test: "node --test test/calculate.test.mjs" },
          type: "module",
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      join(workspaceRoot, "notes", "user-notes.txt"),
      "keep this user-authored baseline\n",
      "utf8",
    ),
  ]);
  await gitBuffer(workspaceRoot, ["add", "--all"], environment);
  await gitBuffer(
    workspaceRoot,
    ["commit", "-m", "add deterministic coding scenario"],
    environment,
  );
  await Promise.all([
    writeFile(
      join(workspaceRoot, "notes", "user-notes.txt"),
      "keep this user-authored baseline\npre-existing uncommitted note\n",
      "utf8",
    ),
    writeFile(
      join(workspaceRoot, "scratch-user.txt"),
      "pre-existing untracked user content\n",
      "utf8",
    ),
  ]);
}

async function gitBuffer(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const result = await execFile("git", [...args], {
    cwd,
    env: environment,
    encoding: null,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout, "utf8");
}

async function gitText(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return (await gitBuffer(cwd, args, environment)).toString("utf8").trimEnd();
}

async function snapshotFixtureTree(
  root: string,
  excludeGitDirectory: boolean,
): Promise<readonly FixtureTreeEntry[]> {
  const entries: FixtureTreeEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    );
    for (const child of children) {
      if (excludeGitDirectory && child.name === ".git") continue;
      const absolutePath = join(directory, child.name);
      const metadata = await lstat(absolutePath);
      const path = relative(root, absolutePath).split(sep).join("/");
      const common = {
        dev: String(metadata.dev),
        ino: String(metadata.ino),
        mode: metadata.mode & 0o7777,
        nlink: metadata.nlink,
        path,
      };
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        entries.push({ ...common, kind: "directory" });
        await visit(absolutePath);
      } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        const contents = await readFile(absolutePath);
        entries.push({
          ...common,
          kind: "file",
          sha256: createHash("sha256").update(contents).digest("hex"),
          size: contents.length,
        });
      } else {
        assert.fail(`unexpected fixture entry type at ${path}`);
      }
    }
  };
  await visit(root);
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function assertOnlyFixtureSourceChanged(
  before: readonly FixtureTreeEntry[],
  after: readonly FixtureTreeEntry[],
): void {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  assert.deepEqual([...afterByPath.keys()], [...beforeByPath.keys()]);
  for (const [path, beforeEntry] of beforeByPath) {
    const afterEntry = afterByPath.get(path);
    assert.notEqual(afterEntry, undefined, `fixture entry disappeared: ${path}`);
    if (path === "src/calculate.ts") {
      assert.notDeepEqual(afterEntry, beforeEntry);
    } else {
      assert.deepEqual(afterEntry, beforeEntry, `unexpected fixture change: ${path}`);
    }
  }
}

async function assertPathMissing(filePath: string): Promise<void> {
  await assert.rejects(
    lstat(filePath),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT",
    `expected npm uninstall to remove ${filePath}`,
  );
}

function assertReviewedPackInventory(result: PackResult): void {
  assert.equal(result.name, REVIEWED_PACK_INVENTORY.packageName);
  assert.match(result.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u);
  const actual = result.files
    .map((file) => ({
      path: file.path,
      mode: file.mode.toString(8).padStart(4, "0"),
      bytes: file.size,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expected = REVIEWED_PACK_INVENTORY.files
    .map(({ path, mode, bytes }) => ({ path, mode, bytes }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set(actual.map((file) => file.path));
  assert.equal(paths.size, actual.length, "tarball inventory repeats a path");
  assert.deepEqual(actual, expected);
  assert.equal(result.filename, REVIEWED_PACK_INVENTORY.archive.filename);
  assert.equal(result.size, currentCompressionProfile(result.npmVersion).bytes);
  assert.ok(result.size <= MAXIMUM_PACK_ARCHIVE_BYTES);
  assert.ok(result.unpackedSize <= MAXIMUM_PACK_UNPACKED_BYTES);
  assert.equal([...paths].some((path) => /(?:^|\/)src\//u.test(path)), false);
  assert.equal(
    [...paths].some((path) => /\.test\.(?:d\.ts|js)(?:\.map)?$/u.test(path)),
    false,
  );
  assert.equal([...paths].some((path) => /(?:^|\/)scripts\//u.test(path)), false);
  assert.equal([...paths].some((path) => /(?:^|\/)\.env(?:\.|$)/u.test(path)), false);
}

async function assertPackArchiveIntegrity(
  pack: PackResult,
  tarball: string,
): Promise<void> {
  assert.ok(pack.size <= MAXIMUM_PACK_ARCHIVE_BYTES);
  assert.ok(pack.unpackedSize <= MAXIMUM_PACK_UNPACKED_BYTES);
  const contents = await readBoundedFile(
    tarball,
    MAXIMUM_PACK_ARCHIVE_BYTES,
    "Robin package archive",
  );
  assert.equal(contents.length, pack.size, "npm-reported tarball size differs from bytes");
  assert.equal(pack.filename, REVIEWED_PACK_INVENTORY.archive.filename);
  const compressionProfile = currentCompressionProfile(pack.npmVersion);
  assert.equal(contents.length, compressionProfile.bytes);
  assert.equal(
    createHash("sha256").update(contents).digest("hex"),
    compressionProfile.sha256,
    `actual tarball SHA-256 differs from reviewed ${compressionProfile.id}`,
  );
  assert.equal(
    createHash("sha1").update(contents).digest("hex"),
    pack.shasum,
    "npm-reported tarball shasum differs from bytes",
  );
  assert.equal(
    `sha512-${createHash("sha512").update(contents).digest("base64")}`,
    pack.integrity,
    "npm-reported tarball integrity differs from bytes",
  );
  assert.equal(
    pack.files.reduce((total, file) => total + file.size, 0),
    pack.unpackedSize,
    "npm-reported unpacked size differs from its file inventory",
  );
  assert.deepEqual(
    parseReviewedTarEntries(contents),
    [...REVIEWED_PACK_INVENTORY.files].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    "actual tar entries differ from the reviewed types, modes, sizes, or hashes",
  );
}

function parseReviewedTarEntries(archive: Buffer): readonly ReviewedPackInventory["files"][number][] {
  const tar = gunzipSync(archive, { maxOutputLength: MAXIMUM_PACK_UNPACKED_BYTES });
  assert.equal(
    tar.length,
    REVIEWED_PACK_INVENTORY.archive.tar.bytes,
    "uncompressed tar size differs from the reviewed archive",
  );
  assert.equal(
    createHash("sha256").update(tar).digest("hex"),
    REVIEWED_PACK_INVENTORY.archive.tar.sha256,
    "uncompressed tar SHA-256 differs from the reviewed archive",
  );
  const entries: ReviewedPackInventory["files"][number][] = [];
  const paths = new Set<string>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.equal(
        tar.subarray(offset).every((byte) => byte === 0),
        true,
        "tarball contains nonzero bytes after its end marker",
      );
      break;
    }
    const storedChecksum = parseTarOctal(header.subarray(148, 156), "checksum");
    let computedChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      computedChecksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    }
    assert.equal(computedChecksum, storedChecksum, "tar entry checksum differs");
    const name = readTarText(header.subarray(0, 100));
    const prefix = readTarText(header.subarray(345, 500));
    const archivePath = prefix.length === 0 ? name : `${prefix}/${name}`;
    assert.match(archivePath, /^package\//u);
    const relativePath = archivePath.slice("package/".length);
    assert.equal(paths.has(relativePath), false, `duplicate tar entry ${relativePath}`);
    paths.add(relativePath);
    const typeFlag = header[156];
    assert.ok(typeFlag === 0 || typeFlag === 0x30, `${relativePath} is not a regular tar file`);
    const mode = parseTarOctal(header.subarray(100, 108), `${relativePath} mode`);
    const bytes = parseTarOctal(header.subarray(124, 136), `${relativePath} size`);
    assert.ok(bytes <= MAXIMUM_PACK_FILE_BYTES, `${relativePath} exceeds the file-size bound`);
    const contentStart = offset + 512;
    const contentEnd = contentStart + bytes;
    assert.ok(contentEnd <= tar.length, `${relativePath} extends beyond the tarball`);
    entries.push({
      path: relativePath,
      type: "file",
      mode: (mode & 0o777).toString(8).padStart(4, "0") as "0644" | "0755",
      bytes,
      sha256: createHash("sha256")
        .update(tar.subarray(contentStart, contentEnd))
        .digest("hex"),
    });
    offset = contentStart + Math.ceil(bytes / 512) * 512;
  }
  assert.equal(entries.length, REVIEWED_PACK_INVENTORY.files.length);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function readTarText(field: Buffer): string {
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function parseTarOctal(field: Buffer, location: string): number {
  const text = readTarText(field).trim();
  assert.match(text, /^[0-7]+$/u, `${location} is not a bounded octal field`);
  const value = Number.parseInt(text, 8);
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${location} is out of range`);
  return value;
}

async function loadReviewedPackInventory(): Promise<ReviewedPackInventory> {
  const decoded = JSON.parse(
    await readFile(REVIEWED_PACK_INVENTORY_PATH, "utf8"),
  ) as unknown;
  assert.equal(
    decoded !== null && typeof decoded === "object" && !Array.isArray(decoded),
    true,
    "reviewed tarball inventory must be an object",
  );
  const inventory = decoded as Partial<ReviewedPackInventory> &
    Readonly<Record<string, unknown>>;
  assert.deepEqual(Object.keys(inventory).sort(), [
    "archive",
    "files",
    "packageName",
    "schemaVersion",
  ]);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.packageName, "@zachshotamartin/robin");
  assert.deepEqual(Object.keys(inventory.archive ?? {}).sort(), [
    "compressionProfiles",
    "filename",
    "tar",
  ]);
  assert.match(inventory.archive!.filename, /^zachshotamartin-robin-[0-9A-Za-z.+-]+\.tgz$/u);
  assert.deepEqual(Object.keys(inventory.archive!.tar ?? {}).sort(), [
    "bytes",
    "sha256",
  ]);
  assert.ok(
    Number.isSafeInteger(inventory.archive!.tar.bytes) &&
      inventory.archive!.tar.bytes > 0 &&
      inventory.archive!.tar.bytes <= MAXIMUM_PACK_UNPACKED_BYTES,
  );
  assert.match(inventory.archive!.tar.sha256, SHA256_PATTERN);
  assert.equal(Array.isArray(inventory.archive!.compressionProfiles), true);
  assert.ok(inventory.archive!.compressionProfiles.length > 0);
  const compressionProfileIds = new Set<string>();
  const compressionPlatformCells = new Set<string>();
  for (const [index, profile] of inventory.archive!.compressionProfiles.entries()) {
    assert.deepEqual(Object.keys(profile).sort(), [
      "arch",
      "bytes",
      "id",
      "npmVersion",
      "platform",
      "sha256",
    ]);
    assert.match(profile.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.equal(
      compressionProfileIds.has(profile.id),
      false,
      `duplicate compression profile ID at index ${index}`,
    );
    compressionProfileIds.add(profile.id);
    assert.match(profile.platform, /^[a-z0-9]+$/u);
    assert.match(profile.arch, /^[a-z0-9_]+$/u);
    assert.match(
      profile.npmVersion,
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    );
    const cell = `${profile.platform}/${profile.arch}/npm-${profile.npmVersion}`;
    assert.equal(
      compressionPlatformCells.has(cell),
      false,
      `duplicate compression platform cell ${cell}`,
    );
    compressionPlatformCells.add(cell);
    assert.ok(
      Number.isSafeInteger(profile.bytes) &&
        profile.bytes > 0 &&
        profile.bytes <= MAXIMUM_PACK_ARCHIVE_BYTES,
    );
    assert.match(profile.sha256, SHA256_PATTERN);
  }
  assert.equal(Array.isArray(inventory.files), true);
  assert.equal(inventory.files!.length, 59);
  const paths = new Set<string>();
  let aggregateBytes = 0;
  for (const [index, file] of inventory.files!.entries()) {
    assert.deepEqual(Object.keys(file).sort(), [
      "bytes",
      "mode",
      "path",
      "sha256",
      "type",
    ]);
    assert.match(file.path, /^(?:LICENSE|README\.md|package\.json|dist\/[a-z0-9-]+\.(?:d\.ts|d\.ts\.map|js|js\.map))$/u);
    assert.equal(file.path.includes(".."), false);
    assert.equal(paths.has(file.path), false, `duplicate inventory path at index ${index}`);
    paths.add(file.path);
    assert.equal(file.type, "file");
    assert.match(file.mode, /^0(?:644|755)$/u);
    assert.ok(
      Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        file.bytes <= MAXIMUM_PACK_FILE_BYTES,
      `invalid reviewed byte size for ${file.path}`,
    );
    aggregateBytes += file.bytes;
    assert.ok(aggregateBytes <= MAXIMUM_PACK_UNPACKED_BYTES);
    assert.match(file.sha256, SHA256_PATTERN);
    assert.equal(
      file.mode === "0755",
      file.path === "dist/bin.js",
      `only dist/bin.js may be executable: ${file.path}`,
    );
  }
  return inventory as ReviewedPackInventory;
}

function currentCompressionProfile(
  npmVersion: string,
): ReviewedPackInventory["archive"]["compressionProfiles"][number] {
  const matches = REVIEWED_PACK_INVENTORY.archive.compressionProfiles.filter(
    (profile) =>
      profile.platform === process.platform &&
      profile.arch === process.arch &&
      profile.npmVersion === npmVersion,
  );
  assert.equal(
    matches.length,
    1,
    `npm archive compression is not reviewed for ${process.platform}/${process.arch}/npm-${npmVersion}`,
  );
  return matches[0]!;
}

async function assertPackedContentsContainNoDevelopmentIdentity(
  installedPackageRoot: string,
): Promise<void> {
  const forbiddenPaths = [REPOSITORY_ROOT, APP_ROOT];
  const credentialPatterns = [
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\b(?:sk|rk|pk)-(?:live|test|proj)-[A-Za-z0-9_-]{20,}\b/u,
    /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  ];
  for (const reviewedFile of REVIEWED_PACK_INVENTORY.files) {
    const relativePath = reviewedFile.path;
    const installedPath = join(installedPackageRoot, relativePath);
    const metadata = await lstat(installedPath);
    assert.equal(metadata.isSymbolicLink(), false, `${relativePath} must not be a symlink`);
    assert.equal(metadata.isFile(), true, `${relativePath} must be a regular file`);
    assert.equal(metadata.size, reviewedFile.bytes, `${relativePath} size differs`);
    if (process.platform !== "win32") {
      assert.equal(
        (metadata.mode & 0o777).toString(8).padStart(4, "0"),
        reviewedFile.mode,
        `${relativePath} installed mode differs`,
      );
    }
    const bytes = await readBoundedFile(
      installedPath,
      MAXIMUM_PACK_FILE_BYTES,
      `installed ${relativePath}`,
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      reviewedFile.sha256,
      `${relativePath} content hash differs`,
    );
    const contents = bytes.toString("utf8");
    for (const forbiddenPath of forbiddenPaths) {
      assert.equal(
        contents.includes(forbiddenPath),
        false,
        `packed ${relativePath} embeds development path ${forbiddenPath}`,
      );
    }
    for (const pattern of credentialPatterns) {
      assert.equal(
        pattern.test(contents),
        false,
        `packed ${relativePath} contains a credential-shaped value`,
      );
    }
  }
}

async function readBoundedFile(
  filePath: string,
  maximumBytes: number,
  location: string,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    assert.equal(before.isFile(), true, `${location} must be a regular file`);
    assert.ok(before.size <= maximumBytes, `${location} exceeds ${maximumBytes} bytes`);
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assert.ok(offset <= maximumBytes, `${location} grew beyond ${maximumBytes} bytes`);
    const after = await handle.stat();
    assert.equal(after.dev, before.dev, `${location} changed device while reading`);
    assert.equal(after.ino, before.ino, `${location} changed inode while reading`);
    assert.equal(after.size, offset, `${location} changed size while reading`);
    assert.equal(after.mtimeMs, before.mtimeMs, `${location} changed while reading`);
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function npmPack(extra: readonly string[]): Promise<PackResult> {
  const environmentRoot = await mkdtemp(join(tmpdir(), "robin-cli-pack-npm-"));
  try {
    const environment = await isolatedNpmEnvironment(environmentRoot);
    const versionResult = await execFile("npm", ["--version"], {
      cwd: APP_ROOT,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const npmVersion = versionResult.stdout.trim();
    assert.match(
      npmVersion,
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    );
    const result = await execFile("npm", ["pack", ...extra], {
      cwd: APP_ROOT,
      env: environment,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const decoded = JSON.parse(result.stdout) as unknown;
    assert.equal(Array.isArray(decoded), true);
    const first = (decoded as PackResult[])[0];
    assert.notEqual(first, undefined);
    return Object.freeze({ ...first!, npmVersion });
  } finally {
    await rm(environmentRoot, { recursive: true, force: true });
  }
}

async function isolatedNpmEnvironment(
  environmentRoot: string,
): Promise<NodeJS.ProcessEnv> {
  const configRoot = join(environmentRoot, "config");
  const cacheRoot = join(environmentRoot, "cache");
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cacheRoot, { recursive: true }),
  ]);
  const userConfig = join(configRoot, "user.npmrc");
  const globalConfig = join(configRoot, "global.npmrc");
  await Promise.all([
    writeFile(userConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 }),
    writeFile(globalConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 }),
  ]);
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_cache: cacheRoot,
    npm_config_fund: "false",
    npm_config_globalconfig: globalConfig,
    npm_config_update_notifier: "false",
    npm_config_userconfig: userConfig,
  };
  copyPlatformCommandEnvironment(environment);
  return environment;
}

function copyPlatformCommandEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
}

async function localDependencyPaths(
  temporaryRoot: string,
): Promise<readonly string[]> {
  const stagedTarballRoot = join(temporaryRoot, "dependency-tarballs");
  await mkdir(stagedTarballRoot);
  const workspacePackages = await workspaceDependencyClosure();
  const workspaceTarballs = await Promise.all(
    workspacePackages.map((source) =>
      packDirectory(source, stagedTarballRoot, temporaryRoot),
    ),
  );
  const registryPackageNames = [
    "uuid",
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
  ];
  const stagedRegistryRoot = join(temporaryRoot, "registry-packages");
  await mkdir(stagedRegistryRoot);
  const registryTarballs = await Promise.all(
    registryPackageNames.map(async (name) => {
      const source = join(REPOSITORY_ROOT, "node_modules", name);
      const destination = join(stagedRegistryRoot, name);
      await cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });

      // The smoke test installs already-built runtime bytes. Local-directory
      // dependencies must not execute upstream development hooks such as
      // prepare while npm materializes the isolated offline installation.
      const manifestPath = join(destination, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts?: unknown;
        devDependencies?: unknown;
        optionalDevDependencies?: unknown;
      };
      delete manifest.scripts;
      delete manifest.devDependencies;
      delete manifest.optionalDevDependencies;
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      return packDirectory(destination, stagedTarballRoot, temporaryRoot);
    }),
  );
  return Object.freeze([...workspaceTarballs, ...registryTarballs]);
}

async function workspaceDependencyClosure(): Promise<readonly string[]> {
  const packageEntries = await readdir(join(REPOSITORY_ROOT, "packages"), {
    withFileTypes: true,
  });
  const packagesByName = new Map<string, string>();
  const manifestsByName = new Map<
    string,
    { readonly dependencies?: Readonly<Record<string, string>> }
  >();
  for (const entry of packageEntries) {
    if (!entry.isDirectory()) continue;
    const packageRoot = join(REPOSITORY_ROOT, "packages", entry.name);
    let manifestText: string;
    try {
      manifestText = await readFile(join(packageRoot, "package.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const manifest = JSON.parse(manifestText) as {
      readonly name: string;
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    packagesByName.set(manifest.name, packageRoot);
    manifestsByName.set(manifest.name, manifest);
  }

  const cliManifest = JSON.parse(
    await readFile(join(APP_ROOT, "package.json"), "utf8"),
  ) as { readonly dependencies?: Readonly<Record<string, string>> };
  const pending = Object.keys(cliManifest.dependencies ?? {}).filter((name) =>
    packagesByName.has(name),
  );
  const selected = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (selected.has(name)) continue;
    selected.add(name);
    for (const dependency of Object.keys(
      manifestsByName.get(name)?.dependencies ?? {},
    )) {
      if (packagesByName.has(dependency) && !selected.has(dependency)) {
        pending.push(dependency);
      }
    }
  }
  return [...selected]
    .sort()
    .map((name) => packagesByName.get(name)!);
}

async function packDirectory(
  source: string,
  destination: string,
  workingDirectory: string,
): Promise<string> {
  const result = await execFile(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination,
      source,
    ],
    {
      cwd: workingDirectory,
      env: await isolatedNpmEnvironment(
        await mkdtemp(join(workingDirectory, "pack-npm-environment-")),
      ),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const decoded = JSON.parse(result.stdout) as PackResult[];
  assert.equal(decoded.length, 1, `expected one tarball for ${source}`);
  return join(destination, decoded[0]!.filename);
}

async function assertSelfContainedInstallation(installRoot: string): Promise<void> {
  const installationPhysicalRoot = await realpath(installRoot);
  const pending = [join(installRoot, "node_modules")];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const metadata = await lstat(entryPath);
      const physicalPath = await realpath(entryPath);
      const relativePhysicalPath = relative(installationPhysicalRoot, physicalPath);
      assert.equal(
        relativePhysicalPath === ".." ||
          relativePhysicalPath.startsWith(`..${sep}`) ||
          isAbsolute(relativePhysicalPath),
        false,
        `installed entry escapes its temporary prefix: ${entryPath} -> ${physicalPath}`,
      );
      assert.equal(
        physicalPath === REPOSITORY_ROOT ||
          physicalPath.startsWith(`${REPOSITORY_ROOT}/`) ||
          physicalPath.startsWith(`${REPOSITORY_ROOT}\\`),
        false,
        `installed entry resolves into the live worktree: ${entryPath}`,
      );
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        pending.push(entryPath);
      }
    }
  }
}
