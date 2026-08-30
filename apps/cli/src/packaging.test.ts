import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFile = promisify(execFileCallback);
const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY_ROOT = resolve(APP_ROOT, "../..");
const NPM_ENV = Object.freeze({
  ...process.env,
  npm_config_cache: join(tmpdir(), "robin-cli-npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
});

interface PackResult {
  readonly filename: string;
  readonly files: readonly { readonly path: string }[];
}

test("npm pack dry-run includes the bin and bounded objective testdata", async () => {
  const result = await npmPack(["--dry-run", "--json"]);
  const paths = new Set(result.files.map((file) => file.path));
  assert.equal(paths.has("dist/bin.js"), true);
  assert.equal(paths.has("package.json"), true);
  assert.equal(paths.has("testdata/synthetic-payload.json"), true);
  assert.equal(paths.has("testdata/coding-objective.json"), true);
  assert.equal(paths.has("testdata/strict.guard"), true);
  assert.equal(paths.has("testdata/policy-cases-v1.json"), true);
  assert.equal(paths.has("testdata/allow-pure.guard"), true);
  assert.equal(paths.has("testdata/allow-pure-policy-cases-v1.json"), true);
  assert.equal(paths.has("testdata/deny-pure.guard"), true);
  assert.equal(paths.has("testdata/deny-pure-policy-cases-v1.json"), true);
  assert.equal(paths.has("testdata/policy-action.json"), true);
  assert.equal(paths.has("testdata/policy-actions-v1.json"), true);
});

test("the compiled Robin entry point is directly executable", async () => {
  const metadata = await stat(join(APP_ROOT, "dist", "bin.js"));
  assert.notEqual(metadata.mode & 0o111, 0);
});

test("the actual tarball installs with its local workspace closure and runs offline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "robin-cli-pack-"));
  const pack = await npmPack(["--json", "--pack-destination", directory]);
  const tarball = join(directory, pack.filename);
  const installRoot = join(directory, "install");
  await mkdir(installRoot);
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify({ name: "robin-cli-install-smoke", private: true })}\n`,
    "utf8",
  );
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
      ...localDependencyPaths(),
    ],
    { cwd: installRoot, env: NPM_ENV, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
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
  ) as { readonly bin?: Readonly<Record<string, string>> };
  assert.equal(installedManifest.bin?.["robin"], "./dist/bin.js");

  const installedCommand = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "robin.cmd" : "robin",
  );
  const commandResult = await execFile(installedCommand, ["--version"], {
    cwd: installRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(commandResult.stdout, "0.0.0\n");
  assert.equal(commandResult.stderr, "");

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
  assert.equal(result.stdout, "0.0.0\n");
  assert.equal(result.stderr, "");

  const previewResult = await execFile(
    installedCommand,
    ["-p", "Verify the installed Robin preview."],
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
    /^Robin received: Verify the installed Robin preview\./u,
  );

  const installedBin = join(
    installRoot,
    "node_modules",
    "@zachshotamartin",
    "robin",
    "dist",
    "bin.js",
  );
  const testdata = join(
    installRoot,
    "node_modules",
    "@zachshotamartin",
    "robin",
    "testdata",
  );
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
});

async function npmPack(extra: readonly string[]): Promise<PackResult> {
  const result = await execFile("npm", ["pack", ...extra], {
    cwd: APP_ROOT,
    env: NPM_ENV,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const decoded = JSON.parse(result.stdout) as unknown;
  assert.equal(Array.isArray(decoded), true);
  const first = (decoded as PackResult[])[0];
  assert.notEqual(first, undefined);
  return first!;
}

function localDependencyPaths(): readonly string[] {
  const workspacePackages = [
    "milestone-a-scenarios",
    "agent-driver",
    "capability-gateway",
    "capability-repository",
    "capability-synthetic",
    "context-broker",
    "contracts",
    "event-store",
    "model-provider",
    "policy-engine",
    "policy-language",
    "profile-registry",
    "robin-agent",
    "robin-application",
    "runtime-host",
    "runtime",
    "schema-validation",
  ].map((name) => join(REPOSITORY_ROOT, "packages", name));
  const registryPackages = [
    "uuid",
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
  ].map((name) => join(REPOSITORY_ROOT, "node_modules", name));
  return Object.freeze([...workspacePackages, ...registryPackages]);
}
