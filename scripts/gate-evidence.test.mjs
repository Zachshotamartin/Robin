import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import {
  captureGateEvidence,
  validateCaptureConfig,
  validateGateEvidenceManifest,
  validateResolvedNodeRuntime,
  verifyGateEvidenceManifest,
} from "./gate-evidence.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// macOS sandbox-exec profiles do not nest. The enclosing evidence command
// remains sandboxed; recursive controller integration cases run in full in CI
// and direct local gates, and appear as explicit skips only during self-capture.
const recursiveCaptureTest =
  process.env.ROBIN_EVIDENCE_CAPTURE === "1"
    ? (name, ...args) => test.skip(name, ...args)
    : test;

function gateManifestPath(root) {
  return path.join(root, "evidence", "manifests", "r0.json");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createFixtureRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "robin-evidence-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await execFile("git", ["init", "--quiet"], { cwd: root });
  await execFile("git", ["config", "user.email", "robin-test@example.invalid"], {
    cwd: root,
  });
  await execFile("git", ["config", "user.name", "Robin Evidence Test"], {
    cwd: root,
  });

  await writeJson(path.join(root, "package.json"), {
    name: "robin",
    version: "1.2.3",
  });
  await writeJson(path.join(root, "cli-package.json"), {
    name: "@example/robin",
    version: "1.2.3",
  });
  await writeFile(path.join(root, "package-lock.json"), "fixture-lock\n", "utf8");
  await writeFile(path.join(root, "fixture.json"), "{\"schemaVersion\":1}\n", "utf8");
  await writeFile(
    path.join(root, "BUILD_PLAN.md"),
    "| Requirement | Tickets | Evidence |\n| --- | --- | --- |\n| `FR-CLI-006` | R0.06/R0.09 | package paths |\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "OPERATIONS_TEST_PLAN.md"),
    "| Requirement | Terminal gate | Required tests | Evidence |\n| --- | --- | --- | --- |\n| `FR-CLI-006` | R10 | UNIT-001, PTY-014 | `package-smoke` |\n",
    "utf8",
  );
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
}

function captureConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    gate: "R0",
    versionManifest: "package.json",
    cliVersionManifest: "cli-package.json",
    dependencyLock: "package-lock.json",
    traceability: {
      buildPlan: "BUILD_PLAN.md",
      operationsTestPlan: "OPERATIONS_TEST_PLAN.md",
    },
    commands: [
      {
        id: "package-smoke",
        executable: "node",
        args: ["-e", "process.stdout.write('package smoke passed\\n')"],
        timeoutMs: 30_000,
      },
    ],
    requirements: [
      {
        requirementId: "FR-CLI-006",
        terminalGate: "R10",
        status: "partial",
        ticketIds: ["R0.06", "R0.09"],
        testIds: ["UNIT-001", "PTY-014"],
        commandIds: ["package-smoke"],
        note: "R0 establishes the package paths; R10 owns terminal completion.",
      },
    ],
    fixtures: [
      { id: "fixture", path: "fixture.json", schemaVersion: 1 },
    ],
    artifacts: [
      {
        id: "root-manifest",
        path: "package.json",
        mediaType: "application/json",
      },
    ],
    supportedClaims: ["The recorded package smoke passed at the tested commit."],
    deferredClaims: ["No production provider is claimed."],
    knownLimitations: [
      {
        id: "synthetic-only",
        summary: "Only deterministic synthetic behavior is in scope.",
        impact: "This evidence does not establish provider compatibility.",
      },
    ],
    ...overrides,
  };
}

test("evidence binds the PATH-resolved Node runtime to its controller", () => {
  assert.deepEqual(
    validateResolvedNodeRuntime({
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
    {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  );
  assert.throws(
    () => validateResolvedNodeRuntime({
      version: "v0.0.0-mismatch",
      platform: process.platform,
      arch: process.arch,
    }),
    /resolved PATH node version .* differs from evidence controller/u,
  );
  assert.throws(
    () => validateResolvedNodeRuntime({
      version: process.version,
      platform: process.platform,
      arch: "mismatched-architecture",
    }),
    /resolved PATH node architecture .* differs from evidence controller/u,
  );
});

recursiveCaptureTest("capture writes a validated manifest for the exact clean tested commit", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  const outputPath = gateManifestPath(root);
  await writeJson(configPath, captureConfig());
  await execFile("git", ["add", "capture.json"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "capture config"], {
    cwd: root,
  });
  const { stdout: expectedCommit } = await execFile("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });

  const manifest = await captureGateEvidence({
    repositoryRoot: root,
    configPath,
    outputPath,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
  });

  assert.equal(manifest.commit, expectedCommit.trim());
  assert.equal(manifest.dirty, false);
  assert.equal(manifest.robinVersion, "1.2.3");
  assert.match(manifest.dependencyLockSha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.generatedAt, "2026-08-30T12:00:00.000Z");
  assert.deepEqual(
    manifest.environment.map(({ name }) => name),
    ["platform", "arch", "node", "npm", "git", "commandIsolation"],
  );
  assert.equal(manifest.commands.length, 1);
  assert.deepEqual(manifest.commands[0].args, [
    "-e",
    "process.stdout.write('package smoke passed\\n')",
  ]);
  assert.equal(manifest.commands[0].exitCode, 0);
  assert.equal(manifest.commands[0].signal, null);
  assert.equal(manifest.commands[0].status, "passed");
  assert.match(manifest.commands[0].display, /^\["node",/u);
  assert.match(manifest.commands[0].stdout.observed.sha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.commands[0].stdout.replay.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.commands[0].stdout.observed.bytes, 21);
  assert.equal(manifest.commands[0].stderr.observed.bytes, 0);
  assert.match(manifest.commands[0].summary, /^passed;/u);
  assert.ok(Number.isSafeInteger(manifest.commands[0].observedDurationMs));
  assert.deepEqual(manifest.requirements, captureConfig().requirements);
  assert.equal(manifest.fixtures[0].path, "fixture.json");
  assert.equal(manifest.artifacts[0].path, "package.json");
  assert.doesNotThrow(() => validateGateEvidenceManifest(manifest));

  const persisted = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(persisted, manifest);
  await assert.doesNotReject(
    verifyGateEvidenceManifest({
      repositoryRoot: root,
      manifest: persisted,
      manifestPath: outputPath,
      configPath,
    }),
  );
  const tampered = structuredClone(persisted);
  tampered.artifacts[0].sha256 = "f".repeat(64);
  await writeJson(outputPath, tampered);
  await assert.rejects(
    verifyGateEvidenceManifest({
      repositoryRoot: root,
      manifest: tampered,
      manifestPath: outputPath,
      configPath,
    }),
    /artifact descriptors or hashes differ from the tested commit/u,
  );
  const tamperedEnvironment = structuredClone(persisted);
  tamperedEnvironment.environment.find(({ name }) => name === "node").value =
    "v999.0.0-forged";
  await writeJson(outputPath, tamperedEnvironment);
  await assert.rejects(
    verifyGateEvidenceManifest({
      repositoryRoot: root,
      manifest: tamperedEnvironment,
      manifestPath: outputPath,
      configPath,
    }),
    /environment differs from the verification environment/u,
  );
  const tamperedProof = structuredClone(persisted);
  tamperedProof.commands[0].stdout.replay.sha256 =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  await writeJson(outputPath, tamperedProof);
  await assert.rejects(
    verifyGateEvidenceManifest({
      repositoryRoot: root,
      manifest: tamperedProof,
      manifestPath: outputPath,
      configPath,
    }),
    /stdout evidence differs from re-execution/u,
  );
  const tamperedRawOutput = structuredClone(persisted);
  tamperedRawOutput.commands[0].stdout.observed.sha256 = "0".repeat(64);
  await writeJson(outputPath, tamperedRawOutput);
  await assert.rejects(
    verifyGateEvidenceManifest({
      repositoryRoot: root,
      manifest: tamperedRawOutput,
      manifestPath: outputPath,
      configPath,
    }),
    /stdout evidence differs from re-execution/u,
  );
  const tamperedDuration = structuredClone(persisted);
  tamperedDuration.commands[0].observedDurationMs = 29_999;
  tamperedDuration.commands[0].summary =
    `passed; observed duration=29999ms; stdout=${tamperedDuration.commands[0].stdout.observed.bytes} bytes; stderr=${tamperedDuration.commands[0].stderr.observed.bytes} bytes`;
  await writeJson(outputPath, tamperedDuration);
  await assert.rejects(
    verifyGateEvidenceManifest({
      repositoryRoot: root,
      manifest: tamperedDuration,
      manifestPath: outputPath,
      configPath,
    }),
    /duration lies outside the v1 replay envelope/u,
  );
  const { stdout: status } = await execFile(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(status, "?? evidence/manifests/r0.json\n");
});

recursiveCaptureTest("capture rejects a dirty tree before executing commands", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  await writeJson(configPath, captureConfig());
  await execFile("git", ["add", "capture.json"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "capture config"], {
    cwd: root,
  });
  await writeFile(path.join(root, "untracked.txt"), "dirty\n", "utf8");

  await assert.rejects(
    captureGateEvidence({
      repositoryRoot: root,
      configPath,
      outputPath: gateManifestPath(root),
    }),
    /clean Git worktree/u,
  );
});

recursiveCaptureTest("capture terminates a command that exceeds its bounded output stream", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  const outputPath = gateManifestPath(root);
  await writeJson(
    configPath,
    captureConfig({
      commands: [
        {
          id: "oversized-output",
          executable: "node",
          args: ["-e", "process.stdout.write('x'.repeat(4096))"],
          timeoutMs: 30_000,
        },
      ],
      requirements: [],
    }),
  );
  await execFile("git", ["add", "capture.json"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "bounded output config"], {
    cwd: root,
  });

  await assert.rejects(
    captureGateEvidence({
      repositoryRoot: root,
      configPath,
      outputPath,
      maximumCommandStreamBytes: 1024,
    }),
    /oversized-output stdout exceeded the 1024-byte stream limit/u,
  );
  await assert.rejects(stat(outputPath), /ENOENT/u);
});

recursiveCaptureTest("capture audits source bytes independently of assume-unchanged index flags", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  const outputPath = gateManifestPath(root);
  await writeFile(path.join(root, "hidden-dirty.txt"), "committed\n", "utf8");
  await writeJson(configPath, captureConfig());
  await execFile("git", ["add", "capture.json", "hidden-dirty.txt"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "hidden dirty probe"], {
    cwd: root,
  });
  await writeFile(path.join(root, "hidden-dirty.txt"), "mutated\n", "utf8");
  await execFile(
    "git",
    ["update-index", "--assume-unchanged", "hidden-dirty.txt"],
    { cwd: root },
  );

  await assert.rejects(
    captureGateEvidence({ repositoryRoot: root, configPath, outputPath }),
    /tracked tree audit hidden-dirty\.txt differs/u,
  );
  await assert.rejects(readFile(outputPath, "utf8"), /ENOENT/u);
});

recursiveCaptureTest("capture cannot overwrite a noncanonical repository file", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  const packageBefore = await readFile(path.join(root, "package.json"), "utf8");
  await writeJson(configPath, captureConfig());
  await execFile("git", ["add", "capture.json"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "capture config"], {
    cwd: root,
  });

  await assert.rejects(
    captureGateEvidence({
      repositoryRoot: root,
      configPath,
      outputPath: path.join(root, "package.json"),
    }),
    /output path must be evidence\/manifests\/r0\.json/u,
  );
  assert.equal(
    await readFile(path.join(root, "package.json"), "utf8"),
    packageBefore,
  );
});

recursiveCaptureTest("capture rejects an ignored config that is absent from the tested commit", async (t) => {
  const root = await createFixtureRepository(t);
  await writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8");
  await execFile("git", ["add", ".gitignore"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "ignore capture scratch"], {
    cwd: root,
  });
  const configPath = path.join(root, "ignored", "capture.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeJson(configPath, captureConfig());

  await assert.rejects(
    captureGateEvidence({
      repositoryRoot: root,
      configPath,
      outputPath: gateManifestPath(root),
    }),
    /ignored\/capture.json must be tracked at tested commit/u,
  );
});

recursiveCaptureTest("capture rejects ignored command-generated fixture and artifact paths", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  await writeFile(path.join(root, ".gitignore"), "generated/\n", "utf8");
  await writeJson(
    configPath,
    captureConfig({
      commands: [
        {
          id: "generate-report",
          executable: "node",
          args: [
            "-e",
            "require('node:fs').mkdirSync('generated'); require('node:fs').writeFileSync('generated/report.json', '{}\\n')",
          ],
          timeoutMs: 30_000,
        },
      ],
      requirements: [],
      fixtures: [],
      artifacts: [
        {
          id: "generated-report",
          path: "generated/report.json",
          mediaType: "application/json",
        },
      ],
    }),
  );
  await execFile("git", ["add", ".gitignore", "capture.json"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "generated report config"], {
    cwd: root,
  });

  await assert.rejects(
    captureGateEvidence({
      repositoryRoot: root,
      configPath,
      outputPath: gateManifestPath(root),
    }),
    /generated\/report\.json must be tracked at tested commit/u,
  );
});

recursiveCaptureTest("capture rejects a tracked config symlink before parsing it", async (t) => {
  const root = await createFixtureRepository(t);
  const realConfigPath = path.join(root, "capture-real.json");
  const linkedConfigPath = path.join(root, "capture-link.json");
  await writeJson(realConfigPath, captureConfig());
  await symlink("capture-real.json", linkedConfigPath);
  await execFile("git", ["add", "capture-real.json", "capture-link.json"], {
    cwd: root,
  });
  await execFile("git", ["commit", "--quiet", "-m", "capture config link"], {
    cwd: root,
  });

  await assert.rejects(
    captureGateEvidence({
      repositoryRoot: root,
      configPath: linkedConfigPath,
      outputPath: gateManifestPath(root),
    }),
    /capture config must not contain a symbolic-link path component/u,
  );
});

recursiveCaptureTest(
  "capture rejects a descriptor whose parent symlink aliases the output",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await createFixtureRepository(t);
    const configPath = path.join(root, "capture.json");
    const evidenceDirectory = path.join(root, "evidence", "manifests");
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(path.join(evidenceDirectory, "r0.json"), "stale\n", "utf8");
    await symlink("evidence/manifests", path.join(root, "alias"));
    await writeJson(
      configPath,
      captureConfig({
        requirements: [],
        fixtures: [],
        artifacts: [
          {
            id: "aliased-manifest",
            path: "alias/r0.json",
            mediaType: "application/json",
          },
        ],
      }),
    );
    await execFile(
      "git",
      ["add", "capture.json", "evidence/manifests/r0.json", "alias"],
      { cwd: root },
    );
    await execFile("git", ["commit", "--quiet", "-m", "aliased output"], {
      cwd: root,
    });

    await assert.rejects(
      captureGateEvidence({
        repositoryRoot: root,
        configPath,
        outputPath: path.join(evidenceDirectory, "r0.json"),
      }),
      /(?:must be tracked at tested commit|symbolic-link path component|tested commit must contain only regular tracked files)/u,
    );
  },
);

recursiveCaptureTest(
  "verification rejects a manifest reached through a parent symlink alias",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await createFixtureRepository(t);
    const configPath = path.join(root, "capture.json");
    const outputPath = gateManifestPath(root);
    await writeJson(configPath, captureConfig());
    await execFile("git", ["add", "capture.json"], { cwd: root });
    await execFile("git", ["commit", "--quiet", "-m", "capture config"], {
      cwd: root,
    });
    const manifest = await captureGateEvidence({
      repositoryRoot: root,
      configPath,
      outputPath,
    });
    await symlink("evidence", path.join(root, "alias"));

    await assert.rejects(
      verifyGateEvidenceManifest({
        repositoryRoot: root,
        manifest,
        manifestPath: path.join(root, "alias", "r0.json"),
        configPath,
      }),
      /symbolic-link path component/u,
    );
  },
);

recursiveCaptureTest("capture rejects a tracked version-manifest symlink", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  await writeJson(configPath, captureConfig());
  await unlink(path.join(root, "cli-package.json"));
  await symlink("package.json", path.join(root, "cli-package.json"));
  await execFile("git", ["add", "capture.json", "cli-package.json"], {
    cwd: root,
  });
  await execFile("git", ["commit", "--quiet", "-m", "linked version input"], {
    cwd: root,
  });

  await assert.rejects(
    captureGateEvidence({
      repositoryRoot: root,
      configPath,
      outputPath: gateManifestPath(root),
    }),
    /tested commit must contain only regular tracked files/u,
  );
});

recursiveCaptureTest("capture rejects tracked changes made by a gate command", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  await writeJson(
    configPath,
    captureConfig({
      commands: [
        {
          id: "mutating-check",
          executable: "node",
          args: [
            "-e",
            "require('node:fs').writeFileSync('package.json', '{}\\n')",
          ],
          timeoutMs: 30_000,
        },
      ],
      requirements: [],
    }),
  );
  await execFile("git", ["add", "capture.json"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "capture config"], {
    cwd: root,
  });

  await assert.rejects(
    captureGateEvidence({
      repositoryRoot: root,
      configPath,
      outputPath: gateManifestPath(root),
    }),
    /tracked tree audit package\.json differs/u,
  );
});

recursiveCaptureTest("capture audits the tracked tree after every command before a later restore", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  const outputPath = gateManifestPath(root);
  await writeFile(path.join(root, "probe.txt"), "committed\n", "utf8");
  await writeJson(
    configPath,
    captureConfig({
      commands: [
        {
          id: "mutate-tracked",
          executable: "node",
          args: ["-e", "require('node:fs').writeFileSync('probe.txt','mutated\\n')"],
          timeoutMs: 30_000,
        },
        {
          id: "observe-mutated",
          executable: "node",
          args: ["-e", "if(require('node:fs').readFileSync('probe.txt','utf8')!=='mutated\\n')process.exit(9)"],
          timeoutMs: 30_000,
        },
        {
          id: "restore-tracked",
          executable: "node",
          args: ["-e", "require('node:fs').writeFileSync('probe.txt','committed\\n')"],
          timeoutMs: 30_000,
        },
      ],
      requirements: [],
    }),
  );
  await execFile("git", ["add", "capture.json", "probe.txt"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "transient mutation probe"], {
    cwd: root,
  });

  await assert.rejects(
    captureGateEvidence({ repositoryRoot: root, configPath, outputPath }),
    /tracked tree audit probe\.txt differs/u,
  );
  await assert.rejects(readFile(outputPath, "utf8"), /ENOENT/u);
});

recursiveCaptureTest("capture ignores command-controlled index flags when auditing tracked bytes", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  const outputPath = gateManifestPath(root);
  await writeFile(path.join(root, "probe.txt"), "committed\n", "utf8");
  await writeJson(
    configPath,
    captureConfig({
      commands: [
        {
          id: "hide-tracked-mutation",
          executable: "node",
          args: [
            "-e",
            "const fs=require('node:fs'),{execFileSync}=require('node:child_process');fs.writeFileSync('probe.txt','mutated\\n');execFileSync('git',['update-index','--assume-unchanged','probe.txt'])",
          ],
          timeoutMs: 30_000,
        },
      ],
      requirements: [],
    }),
  );
  await execFile("git", ["add", "capture.json", "probe.txt"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "index mutation probe"], {
    cwd: root,
  });

  await assert.rejects(
    captureGateEvidence({ repositoryRoot: root, configPath, outputPath }),
    /(?:exited with status|tracked tree audit probe\.txt differs)/u,
  );
  await assert.rejects(readFile(outputPath, "utf8"), /ENOENT/u);
});

recursiveCaptureTest("capture rejects untracked files made by a gate command", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  await writeJson(
    configPath,
    captureConfig({
      commands: [
        {
          id: "untracked-output",
          executable: "node",
          args: [
            "-e",
            "require('node:fs').writeFileSync('unexpected.txt', 'output\\n')",
          ],
          timeoutMs: 30_000,
        },
      ],
      requirements: [],
    }),
  );
  await execFile("git", ["add", "capture.json"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "capture config"], {
    cwd: root,
  });

  await assert.rejects(
    captureGateEvidence({
      repositoryRoot: root,
      configPath,
      outputPath: gateManifestPath(root),
    }),
    /changed the tested worktree/u,
  );
  await assert.rejects(readFile(gateManifestPath(root), "utf8"), /ENOENT/u);
});

recursiveCaptureTest("commands run in a disposable checkout and leave ignored output out of the source", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  const outputPath = gateManifestPath(root);
  await writeFile(path.join(root, ".gitignore"), "ignored-output/\n", "utf8");
  await writeJson(
    configPath,
    captureConfig({
      commands: [
        {
          id: "ignored-build-output",
          executable: "node",
          args: [
            "-e",
            "require('node:fs').mkdirSync('ignored-output'); require('node:fs').writeFileSync('ignored-output/cache', 'generated\\n')",
          ],
          timeoutMs: 30_000,
        },
      ],
      requirements: [],
    }),
  );
  await execFile("git", ["add", ".gitignore", "capture.json"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "isolated output config"], {
    cwd: root,
  });

  await captureGateEvidence({ repositoryRoot: root, configPath, outputPath });

  await assert.rejects(stat(path.join(root, "ignored-output")), /ENOENT/u);
  const { stdout: status } = await execFile(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(status, "?? evidence/manifests/r0.json\n");
});

recursiveCaptureTest("disposable gate commands cannot discover source or identity through clone metadata", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  const outputPath = gateManifestPath(root);
  await writeJson(
    configPath,
    captureConfig({
      commands: [
        {
          id: "no-source-remote",
          executable: "node",
          args: [
            "-e",
            "const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'); if(execFileSync('git',['remote'],{encoding:'utf8'}).trim())process.exit(9); if(fs.existsSync('.git/logs'))process.exit(10); const stack=['.git']; while(stack.length){const current=stack.pop(); const stat=fs.lstatSync(current); if(stat.isDirectory()){for(const entry of fs.readdirSync(current))stack.push(path.join(current,entry));}else if(stat.isFile()){const text=fs.readFileSync(current); if(text.includes(Buffer.from(process.argv[1]))||text.includes(Buffer.from('robin-test@example.invalid'))||text.includes(Buffer.from('Robin Evidence Test')))process.exit(11);}}",
            root,
          ],
          timeoutMs: 30_000,
        },
      ],
      requirements: [],
    }),
  );
  await execFile("git", ["add", "capture.json"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "remote isolation"], {
    cwd: root,
  });

  await assert.doesNotReject(
    captureGateEvidence({ repositoryRoot: root, configPath, outputPath }),
  );
});

recursiveCaptureTest(
  "capture terminates and rejects descendants left in a successful command group",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await createFixtureRepository(t);
    const configPath = path.join(root, "capture.json");
    await writeJson(
      configPath,
      captureConfig({
        commands: [
          {
            id: "lingering-child",
            executable: "node",
            args: [
              "-e",
              "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'}).unref()",
            ],
            timeoutMs: 30_000,
          },
        ],
        requirements: [],
      }),
    );
    await execFile("git", ["add", "capture.json"], { cwd: root });
    await execFile("git", ["commit", "--quiet", "-m", "lingering command"], {
      cwd: root,
    });

    await assert.rejects(
      captureGateEvidence({
        repositoryRoot: root,
        configPath,
        outputPath: gateManifestPath(root),
      }),
      /left a descendant in its process group after exit/u,
    );
  },
);

recursiveCaptureTest(
  "capture hard-settles after an escaped descendant retains command pipes",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await createFixtureRepository(t);
    const configPath = path.join(root, "capture.json");
    await writeJson(
      configPath,
      captureConfig({
        commands: [
          {
            id: "escaped-pipe-child",
            executable: "node",
            args: [
              "-e",
              "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]}); child.unref()",
            ],
            timeoutMs: 1_000,
          },
        ],
        requirements: [],
      }),
    );
    await execFile("git", ["add", "capture.json"], { cwd: root });
    await execFile("git", ["commit", "--quiet", "-m", "escaped pipe command"], {
      cwd: root,
    });

    const started = Date.now();
    await assert.rejects(
      captureGateEvidence({
        repositoryRoot: root,
        configPath,
        outputPath: gateManifestPath(root),
      }),
      /escaped-pipe-child exceeded its 1000ms timeout/u,
    );
    assert.ok(Date.now() - started < 8_000);
  },
);

recursiveCaptureTest(
  "macOS capture denies source writes from a reparented detached process group",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await createFixtureRepository(t);
    const canaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "robin-evidence-detached-canary-"),
    );
    t.after(async () => {
      await rm(canaryRoot, { recursive: true, force: true });
    });
    const sourceMarker = path.join(root, "late.txt");
    const completionCanary = path.join(canaryRoot, "completed.txt");
    const detachedProgram = [
      "const fs=require('node:fs');",
      "setTimeout(()=>{",
      `try{fs.writeFileSync(${JSON.stringify(sourceMarker)},'late\\n')}catch{}`,
      `fs.writeFileSync(${JSON.stringify(completionCanary)},'completed\\n')`,
      "},150)",
    ].join("");
    const configPath = path.join(root, "capture.json");
    await writeJson(
      configPath,
      captureConfig({
        commands: [
          {
            id: "detached-source-write",
            executable: "node",
            args: [
              "-e",
              `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(detachedProgram)}],{detached:true,stdio:'ignore'}).unref()`,
            ],
            timeoutMs: 30_000,
          },
        ],
        requirements: [],
      }),
    );
    await execFile("git", ["add", "capture.json"], { cwd: root });
    await execFile("git", ["commit", "--quiet", "-m", "detached source probe"], {
      cwd: root,
    });

    await assert.doesNotReject(
      captureGateEvidence({
        repositoryRoot: root,
        configPath,
        outputPath: gateManifestPath(root),
      }),
    );
    await waitForPath(completionCanary);
    await assert.rejects(stat(sourceMarker), /ENOENT/u);
  },
);

recursiveCaptureTest("capture refuses failed commands and does not emit acceptance evidence", async (t) => {
  const root = await createFixtureRepository(t);
  const configPath = path.join(root, "capture.json");
  const outputPath = gateManifestPath(root);
  await writeJson(
    configPath,
    captureConfig({
      commands: [
        {
          id: "failing-check",
          executable: "node",
          args: ["-e", "process.exitCode = 7"],
          timeoutMs: 30_000,
        },
      ],
      requirements: [],
    }),
  );
  await execFile("git", ["add", "capture.json"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "capture config"], {
    cwd: root,
  });

  await assert.rejects(
    captureGateEvidence({ repositoryRoot: root, configPath, outputPath }),
    /failing-check exited with status 7/u,
  );
  await assert.rejects(readFile(outputPath, "utf8"), /ENOENT/u);
});

test("schema v1 rejects requirement completion until implemented-test proof exists", async () => {
  const buildPlan =
    "| `FR-CLI-006` | R0.06/R0.09 | package paths |\n";
  const operationsTestPlan =
    "| `FR-CLI-006` | R10 | UNIT-001, PTY-014 | `package-smoke` |\n";
  const config = captureConfig({
    requirements: [
      {
        ...captureConfig().requirements[0],
        status: "complete",
      },
    ],
  });

  assert.throws(
    () => validateCaptureConfig(config, { buildPlan, operationsTestPlan }),
    /status complete is unsupported by evidence schema v1/u,
  );
});

test("requirement categories may contain digits", () => {
  const requirement = {
    requirementId: "NFR-A11Y-001",
    terminalGate: "R1",
    status: "partial",
    ticketIds: ["R0.06"],
    testIds: ["PTY-003"],
    commandIds: ["package-smoke"],
    note: "R0 begins flat output; R1 owns this accessibility requirement.",
  };
  assert.doesNotThrow(() =>
    validateCaptureConfig(captureConfig({ requirements: [requirement] }), {
      buildPlan: "| `NFR-A11Y-001` | R0.06, R1.07 | terminal |\n",
      operationsTestPlan: "| `NFR-A11Y-001` | R1 | PTY-003 | `package-smoke`, pty-linux |\n",
    }),
  );
});

test("manifest validation rejects unredacted environment fields and self hashes", () => {
  const manifest = {
    schemaVersion: 1,
    gate: "R0",
    commit: "a".repeat(40),
    dirty: false,
    robinVersion: "1.2.3",
    dependencyLockSha256: "b".repeat(64),
    environment: [{ name: "HOME", value: "/Users/example" }],
    commands: [
      {
        id: "package-smoke",
        executable: "npm",
        args: ["run", "test"],
        display: '["npm","run","test"]',
        timeoutMs: 30_000,
        exitCode: 0,
        signal: null,
        status: "passed",
        observedDurationMs: 1,
        durationVerification: {
          mode: "replay-envelope-v1",
          factor: 4,
          slackMs: 1_000,
        },
        stdout: {
          observed: { bytes: 0, sha256: "d".repeat(64) },
          replay: {
            normalization: "ascii-digit-runs-v1",
            bytes: 0,
            sha256: "d".repeat(64),
          },
        },
        stderr: {
          observed: { bytes: 0, sha256: "d".repeat(64) },
          replay: {
            normalization: "ascii-digit-runs-v1",
            bytes: 0,
            sha256: "d".repeat(64),
          },
        },
        summary: "passed; observed duration=1ms; stdout=0 bytes; stderr=0 bytes",
      },
    ],
    requirements: [],
    fixtures: [],
    artifacts: [
      {
        id: "manifest",
        path: "evidence/manifests/r0.json",
        mediaType: "application/json",
        bytes: 1,
        sha256: "c".repeat(64),
      },
    ],
    supportedClaims: [],
    deferredClaims: [],
    knownLimitations: [],
    generatedAt: "2026-08-30T12:00:00.000Z",
  };

  assert.throws(
    () =>
      validateGateEvidenceManifest(manifest, {
        manifestPath: "evidence/manifests/r0.json",
      }),
    /environment name HOME is not in the redacted allowlist/u,
  );
  manifest.environment = [
    { name: "platform", value: "darwin" },
    { name: "arch", value: "arm64" },
    { name: "node", value: "v26.7.0" },
    { name: "npm", value: "11.6.0" },
    { name: "git", value: "git version 2.51.0" },
    { name: "commandIsolation", value: "macos-sandbox-exec-source-deny" },
  ];
  assert.throws(
    () =>
      validateGateEvidenceManifest(manifest, {
        manifestPath: "evidence/manifests/r0.json",
      }),
    /must not hash itself/u,
  );
});

test("repository R0 capture config and JSON schemas stay structurally valid", async () => {
  const [
    config,
    buildPlan,
    operationsTestPlan,
    manifestSchema,
    configSchema,
    evidenceReadme,
    testSource,
  ] =
    await Promise.all([
      readFile(path.join(repositoryRoot, "evidence/config/r0.json"), "utf8").then(JSON.parse),
      readFile(path.join(repositoryRoot, "docs/BUILD_PLAN.md"), "utf8"),
      readFile(path.join(repositoryRoot, "docs/OPERATIONS_TEST_PLAN.md"), "utf8"),
      readFile(
        path.join(
          repositoryRoot,
          "evidence/schema/gate-evidence-manifest-v1.schema.json",
        ),
        "utf8",
      ).then(JSON.parse),
      readFile(
        path.join(
          repositoryRoot,
          "evidence/schema/gate-evidence-capture-config-v1.schema.json",
        ),
        "utf8",
      ).then(JSON.parse),
      readFile(path.join(repositoryRoot, "evidence/README.md"), "utf8"),
      readFile(
        path.join(repositoryRoot, "scripts/gate-evidence.test.mjs"),
        "utf8",
      ),
    ]);

  assert.doesNotThrow(() =>
    validateCaptureConfig(config, { buildPlan, operationsTestPlan }),
  );
  assert.equal(manifestSchema.$id, "https://robin.invalid/schema/gate-evidence-manifest-v1.json");
  assert.equal(configSchema.$id, "https://robin.invalid/schema/gate-evidence-capture-config-v1.json");
  assert.equal(manifestSchema.additionalProperties, false);
  assert.equal(configSchema.additionalProperties, false);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  const validateConfigSchema = ajv.compile(configSchema);
  const validateManifestSchema = ajv.compile(manifestSchema);
  assert.equal(
    validateConfigSchema(config),
    true,
    JSON.stringify(validateConfigSchema.errors),
  );
  assert.match(
    manifestSchema.$defs.requirement.properties.requirementId.pattern,
    /A-Z0-9/u,
  );
  assert.match(
    configSchema.$defs.requirement.properties.requirementId.pattern,
    /A-Z0-9/u,
  );
  assert.deepEqual(
    config.commands.map(({ id }) => id),
    [
      "dependency-install",
      "dependency-tree",
      "docs-policy",
      "static",
      "unit-contract",
      "package-smoke",
      "gate-a",
      "gate-b",
    ],
  );
  assert.equal(
    [...testSource.matchAll(/^recursiveCaptureTest\(/gmu)].length,
    21,
  );
  assert.match(
    testSource,
    /process\.env\.ROBIN_EVIDENCE_CAPTURE === "1"/u,
  );
  assert.match(evidenceReadme, /21 evidence-controller integration cases/u);
  assert.equal(
    config.knownLimitations.some(
      ({ id }) => id === "nonrecursive-controller-self-capture",
    ),
    true,
  );
  const schemaManifest = {
    schemaVersion: 1,
    gate: config.gate,
    commit: "a".repeat(40),
    dirty: false,
    robinVersion: "0.0.0",
    dependencyLockSha256: "b".repeat(64),
    environment: [
      { name: "platform", value: "darwin" },
      { name: "arch", value: "arm64" },
      { name: "node", value: "v22.23.2" },
      { name: "npm", value: "10.9.8" },
      { name: "git", value: "git version 2.51.0" },
      { name: "commandIsolation", value: "macos-sandbox-exec-source-deny" },
    ],
    commands: config.commands.map((command) => ({
      ...command,
      display: JSON.stringify([command.executable, ...command.args]),
      exitCode: 0,
      signal: null,
      status: "passed",
      observedDurationMs: 1,
      durationVerification: {
        mode: "replay-envelope-v1",
        factor: 4,
        slackMs: 1_000,
      },
      stdout: {
        observed: { bytes: 0, sha256: "c".repeat(64) },
        replay: {
          normalization: "ascii-digit-runs-v1",
          bytes: 0,
          sha256: "c".repeat(64),
        },
      },
      stderr: {
        observed: { bytes: 0, sha256: "d".repeat(64) },
        replay: {
          normalization: "ascii-digit-runs-v1",
          bytes: 0,
          sha256: "d".repeat(64),
        },
      },
      summary: "passed; observed duration=1ms; stdout=0 bytes; stderr=0 bytes",
    })),
    requirements: config.requirements,
    fixtures: config.fixtures.map((fixture) => ({
      ...fixture,
      bytes: 1,
      sha256: "e".repeat(64),
    })),
    artifacts: config.artifacts.map((artifact) => ({
      ...artifact,
      bytes: 1,
      sha256: "f".repeat(64),
    })),
    supportedClaims: config.supportedClaims,
    deferredClaims: config.deferredClaims,
    knownLimitations: config.knownLimitations,
    generatedAt: "2026-08-30T12:00:00.000Z",
  };
  assert.equal(
    validateManifestSchema(schemaManifest),
    true,
    JSON.stringify(validateManifestSchema.errors),
  );

  const whitespaceClaim = structuredClone(config);
  whitespaceClaim.supportedClaims = [" surrounding whitespace "];
  assert.equal(validateConfigSchema(whitespaceClaim), false);
  assert.throws(
    () => validateCaptureConfig(whitespaceClaim, { buildPlan, operationsTestPlan }),
    /must not have surrounding whitespace/u,
  );
  const uppercaseMediaType = structuredClone(config);
  uppercaseMediaType.artifacts[0].mediaType = "APPLICATION/JSON";
  assert.equal(validateConfigSchema(uppercaseMediaType), false);
  assert.throws(
    () => validateCaptureConfig(uppercaseMediaType, { buildPlan, operationsTestPlan }),
    /must be a lowercase media type/u,
  );
  const invalidIsolation = structuredClone(schemaManifest);
  invalidIsolation.environment.find(({ name }) => name === "commandIsolation").value =
    "unreviewed-isolation-mode";
  assert.equal(validateManifestSchema(invalidIsolation), false);
  assert.throws(
    () => validateGateEvidenceManifest(invalidIsolation),
    /commandIsolation is inconsistent/u,
  );
  const semanticCrossFieldMismatch = structuredClone(schemaManifest);
  semanticCrossFieldMismatch.commands[0].stdout.replay.bytes = 1;
  assert.equal(validateManifestSchema(semanticCrossFieldMismatch), true);
  assert.throws(
    () => validateGateEvidenceManifest(semanticCrossFieldMismatch),
    /replay.bytes must be between 0 and observed bytes/u,
  );
  const relativePathPattern = new RegExp(configSchema.$defs.relativePath.pattern, "u");
  for (const invalidPath of [".", "a//b", "a/./b", "a/../b", "a/"]) {
    assert.equal(relativePathPattern.test(invalidPath), false, invalidPath);
  }
  assert.equal(configSchema.properties.commands.maxItems, 100);
  assert.equal(
    manifestSchema.$defs.observedStreamDigest.properties.bytes.maximum,
    64 * 1024 * 1024,
  );
});

async function waitForPath(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}
