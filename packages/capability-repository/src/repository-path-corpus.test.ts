import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isDomainError } from "@guard/contracts";
import type {
  ContextResourceMetadata,
  NormalizedResourceRequest,
  OpenedContextResource,
  SourceReadBudget,
} from "@guard/context-broker";

import {
  RepositoryContextSource,
  normalizeRepositoryPath,
} from "./index.js";

interface GeneratorConfig {
  readonly schemaVersion: 1;
  readonly generatorId: "guard.repository-path-adversarial";
  readonly generatorVersion: 1;
  readonly seeds: readonly number[];
  readonly validCasesPerSeed: number;
  readonly invalidCasesPerSeed: number;
  readonly maximumGeneratedCases: number;
  readonly maximumPathBytes: number;
  readonly maximumSegmentBytes: number;
  readonly expectedCorpusSha256: string;
}

interface GeneratedPathCase {
  readonly caseId: string;
  readonly category: string;
  readonly input: string;
  readonly expectedCanonical: string | null;
}

interface SourceMetrics {
  readonly inspectCalls: number;
  readonly openCalls: number;
  readonly successfulReads: number;
}

const METRICS = new WeakMap<ObservedRepositoryContextSource, SourceMetrics>();
const CONFIG_KEYS = [
  "expectedCorpusSha256",
  "generatorId",
  "generatorVersion",
  "invalidCasesPerSeed",
  "maximumGeneratedCases",
  "maximumPathBytes",
  "maximumSegmentBytes",
  "schemaVersion",
  "seeds",
  "validCasesPerSeed",
] as const;
const RESERVED_WINDOWS_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

class ObservedRepositoryContextSource extends RepositoryContextSource {
  public constructor(root: string) {
    super({
      sourceId: "coding.generated-repository",
      sourceVersion: 1,
      description: "Generated adversarial repository fixture.",
      repositoryRoot: root,
      branch: "generated/path-corpus",
      classification: "internal",
      maximumFileBytes: 64 * 1024,
      maximumByteSpan: 16 * 1024,
      maximumLineSpan: 256,
    });
    METRICS.set(this, Object.freeze({
      inspectCalls: 0,
      openCalls: 0,
      successfulReads: 0,
    }));
  }

  public override async inspectMetadata(
    request: NormalizedResourceRequest,
    signal: AbortSignal,
  ): Promise<ContextResourceMetadata> {
    this.#update({ inspectCalls: this.metrics.inspectCalls + 1 });
    return super.inspectMetadata(request, signal);
  }

  public override async openBounded(
    request: NormalizedResourceRequest,
    expected: ContextResourceMetadata,
    budget: SourceReadBudget,
    signal: AbortSignal,
  ): Promise<OpenedContextResource> {
    this.#update({ openCalls: this.metrics.openCalls + 1 });
    const opened = await super.openBounded(request, expected, budget, signal);
    this.#update({ successfulReads: this.metrics.successfulReads + 1 });
    return opened;
  }

  public get metrics(): SourceMetrics {
    return METRICS.get(this) ?? Object.freeze({
      inspectCalls: 0,
      openCalls: 0,
      successfulReads: 0,
    });
  }

  #update(patch: Partial<SourceMetrics>): void {
    METRICS.set(this, Object.freeze({ ...this.metrics, ...patch }));
  }
}

test("versioned repository-path generator is bounded and hash-reproducible", async () => {
  const config = await loadGeneratorConfig();
  const first = generatePathCases(config);
  const second = generatePathCases(config);

  assert.deepEqual(first, second);
  assert.equal(
    first.length,
    config.seeds.length *
      (config.validCasesPerSeed + config.invalidCasesPerSeed),
  );
  assert.equal(first.length <= config.maximumGeneratedCases, true);
  assert.equal(new Set(first.map((entry) => entry.caseId)).size, first.length);
  assert.equal(corpusSha256(first), config.expectedCorpusSha256);

  const categories = new Set(first.map((entry) => entry.category));
  for (const required of [
    "valid-ascii",
    "valid-nfd",
    "mixed-separator",
    "dot-segment",
    "encoded-traversal",
    "control",
    "surrogate",
    "reserved-device",
    "overlong-segment",
    "overlong-path",
  ]) {
    assert.equal(categories.has(required), true, required);
  }
});

test("generated paths agree with an independent portable-path oracle", async () => {
  const config = await loadGeneratorConfig();
  const cases = generatePathCases(config);

  for (const candidate of cases) {
    const expected = referenceNormalizePath(candidate.input, config);
    assert.equal(
      expected,
      candidate.expectedCanonical,
      `generator expectation drifted for ${candidate.caseId}`,
    );
    if (expected === null) {
      assert.throws(
        () => normalizeRepositoryPath(candidate.input, { allowRoot: false }),
        (error: unknown) => isCode(error, "invalid_input"),
        candidate.caseId,
      );
    } else {
      const actual = normalizeRepositoryPath(candidate.input, {
        allowRoot: false,
      });
      assert.equal(actual, expected, candidate.caseId);
      assert.equal(actual.includes("\\"), false, candidate.caseId);
      assert.equal(actual, actual.normalize("NFC"), candidate.caseId);
      assert.equal(Buffer.byteLength(actual, "utf8") <= config.maximumPathBytes, true);
    }
  }
});

test("real repository source opens only generated canonical paths", async (t) => {
  const config = await loadGeneratorConfig();
  const cases = generatePathCases(config);
  const root = await fixtureRoot(t, "guard-generated-paths-");
  const contents = new Map<string, string>();

  for (const candidate of cases) {
    if (candidate.expectedCanonical === null) continue;
    const target = path.join(root, ...candidate.expectedCanonical.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const content = `generated:${candidate.caseId}\n`;
    await writeFile(target, content, "utf8");
    contents.set(candidate.expectedCanonical, content);
  }

  const repository = new ObservedRepositoryContextSource(root);
  for (const candidate of cases) {
    const before = repository.metrics;
    if (candidate.expectedCanonical === null) {
      assert.throws(
        () =>
          repository.normalizeResourceRequest({
            path: candidate.input,
            selector: { kind: "whole" },
          }),
        (error: unknown) => isCode(error, "invalid_input"),
        candidate.caseId,
      );
      assert.deepEqual(
        repository.metrics,
        before,
        `${candidate.caseId} must fail before metadata inspection or content open`,
      );
      continue;
    }

    const request = repository.normalizeResourceRequest({
      path: candidate.input,
      selector: { kind: "whole" },
    });
    assert.equal(
      request.resource.locator["path"],
      candidate.expectedCanonical,
      candidate.caseId,
    );
    const metadata = await repository.inspectMetadata(
      request,
      new AbortController().signal,
    );
    const opened = await repository.openBounded(
      request,
      metadata,
      { maximumBytes: 1024 },
      new AbortController().signal,
    );
    assert.equal(
      Buffer.from(opened.bytes).toString("utf8"),
      contents.get(candidate.expectedCanonical),
      candidate.caseId,
    );
  }

  const acceptedCount = cases.filter(
    (entry) => entry.expectedCanonical !== null,
  ).length;
  assert.deepEqual(repository.metrics, {
    inspectCalls: acceptedCount,
    openCalls: acceptedCount,
    successfulReads: acceptedCount,
  });
});

test("generated symlink graphs, root-prefix collisions, and link swaps fail closed", async (t) => {
  const config = await loadGeneratorConfig();
  const parent = await fixtureRoot(t, "guard-generated-links-");
  const root = path.join(parent, "repo");
  const sibling = path.join(parent, "repo-prefix-collision");
  await mkdir(root);
  await mkdir(sibling);
  await writeFile(path.join(sibling, "outside.txt"), "outside canary", "utf8");
  await mkdir(path.join(root, "real"));
  await writeFile(path.join(root, "real", "inside.txt"), "inside", "utf8");

  const token = config.seeds[0]!.toString(16);
  const direct = path.join(root, `direct-${token}.txt`);
  const internal = path.join(root, `internal-${token}.txt`);
  const prefix = path.join(root, `prefix-${token}`);
  const chain = path.join(root, `chain-${token}.txt`);
  try {
    await symlink(path.join(sibling, "outside.txt"), direct);
    await symlink(path.join(root, "real", "inside.txt"), internal);
    await symlink(sibling, prefix, process.platform === "win32" ? "junction" : "dir");
    await symlink(direct, chain);
  } catch (error: unknown) {
    if (isUnavailableSymlink(error)) {
      t.diagnostic("symlink creation is unavailable on this platform");
      return;
    }
    throw error;
  }

  const repository = new ObservedRepositoryContextSource(root);
  for (const repositoryPath of [
    `direct-${token}.txt`,
    `internal-${token}.txt`,
    `prefix-${token}/outside.txt`,
    `chain-${token}.txt`,
  ]) {
    const request = repository.normalizeResourceRequest({
      path: repositoryPath,
      selector: { kind: "whole" },
    });
    const before = repository.metrics;
    await assert.rejects(
      repository.inspectMetadata(request, new AbortController().signal),
      (error: unknown) => isCode(error, "invalid_input"),
      repositoryPath,
    );
    assert.equal(repository.metrics.openCalls, before.openCalls);
    assert.equal(repository.metrics.successfulReads, before.successfulReads);
  }

  const swapPath = `swap-${token}.txt`;
  const swapTarget = path.join(root, swapPath);
  await writeFile(swapTarget, "approved", "utf8");
  const swapRequest = repository.normalizeResourceRequest({
    path: swapPath,
    selector: { kind: "whole" },
  });
  const approvedMetadata = await repository.inspectMetadata(
    swapRequest,
    new AbortController().signal,
  );
  await rename(swapTarget, path.join(root, `old-${swapPath}`));
  await symlink(path.join(sibling, "outside.txt"), swapTarget);
  const successfulBeforeSwap = repository.metrics.successfulReads;
  await assert.rejects(
    repository.openBounded(
      swapRequest,
      approvedMetadata,
      { maximumBytes: 1024 },
      new AbortController().signal,
    ),
    (error: unknown) =>
      isCode(error, "invalid_input") || isCode(error, "conflict"),
  );
  assert.equal(repository.metrics.successfulReads, successfulBeforeSwap);
});

async function loadGeneratorConfig(): Promise<GeneratorConfig> {
  const raw: unknown = JSON.parse(
    await readFile(
      new URL("../testdata/repository-path-generator-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(typeof raw, "object");
  assert.notEqual(raw, null);
  assert.equal(Array.isArray(raw), false);
  const value = raw as Readonly<Record<string, unknown>>;
  assert.deepEqual(Object.keys(value).sort(), [...CONFIG_KEYS].sort());
  assert.equal(value["schemaVersion"], 1);
  assert.equal(value["generatorId"], "guard.repository-path-adversarial");
  assert.equal(value["generatorVersion"], 1);
  assert.ok(Array.isArray(value["seeds"]));
  const seeds = value["seeds"] as readonly unknown[];
  assert.equal(seeds.length > 0 && seeds.length <= 8, true);
  assert.equal(
    seeds.every(
      (seed) =>
        Number.isSafeInteger(seed) &&
        (seed as number) > 0 &&
        (seed as number) <= 0xffff_ffff,
    ),
    true,
  );
  assert.equal(new Set(seeds).size, seeds.length);
  for (const field of [
    "validCasesPerSeed",
    "invalidCasesPerSeed",
    "maximumGeneratedCases",
    "maximumPathBytes",
    "maximumSegmentBytes",
  ]) {
    assert.equal(Number.isSafeInteger(value[field]), true, field);
    assert.equal((value[field] as number) > 0, true, field);
  }
  assert.equal(value["maximumPathBytes"], 4096);
  assert.equal(value["maximumSegmentBytes"], 255);
  assert.equal((value["maximumGeneratedCases"] as number) <= 512, true);
  assert.match(value["expectedCorpusSha256"] as string, /^[a-f0-9]{64}$/u);
  return value as unknown as GeneratorConfig;
}

function generatePathCases(
  config: GeneratorConfig,
): readonly GeneratedPathCase[] {
  const generated: GeneratedPathCase[] = [];
  for (const seed of config.seeds) {
    const random = xorshift32(seed);
    const token = `${seed.toString(16)}-${random().toString(36)}`;
    const valid: readonly Omit<GeneratedPathCase, "caseId">[] = [
      {
        category: "valid-ascii",
        input: `src/${token}.ts`,
        expectedCanonical: `src/${token}.ts`,
      },
      {
        category: "valid-nested",
        input: `packages/${token}/index.test.ts`,
        expectedCanonical: `packages/${token}/index.test.ts`,
      },
      {
        category: "valid-nfd",
        input: `src/cafe\u0301-${token}.ts`,
        expectedCanonical: `src/café-${token}.ts`,
      },
      {
        category: "valid-unicode",
        input: `unicode/模块-${token}-🙂.txt`,
        expectedCanonical: `unicode/模块-${token}-🙂.txt`,
      },
    ];
    const invalid: readonly Omit<GeneratedPathCase, "caseId">[] = [
      rejected("mixed-separator", `src\\${token}/file.ts`),
      rejected("empty-segment", `src//${token}.ts`),
      rejected("dot-segment", `src/./${token}.ts`),
      rejected("traversal", `src/../${token}.ts`),
      rejected("traversal", `../${token}.ts`),
      rejected("absolute", `/etc/${token}`),
      rejected("absolute", `C:/${token}`),
      rejected("absolute", `\\\\server\\share\\${token}`),
      rejected("encoded-traversal", `%2e%2e/${token}`),
      rejected("encoded-traversal", `%2E%2E/${token}`),
      rejected("encoded-separator", `src/%2f${token}`),
      rejected("encoded-separator", `src/%5c${token}`),
      rejected("encoded-traversal", `%252e%252e/${token}`),
      rejected("control", `src/\u0000${token}`),
      rejected("control", `src/line\n${token}`),
      rejected("control", `src/\u0085${token}`),
      rejected("surrogate", `src/\ud800${token}`),
      rejected("surrogate", `src/\udc00${token}`),
      rejected("reserved-character", `src/<${token}>.ts`),
      rejected("reserved-character", `src/${token}>.ts`),
      rejected("reserved-character", `src/\"${token}.ts`),
      rejected("reserved-character", `src/${token}|x.ts`),
      rejected("reserved-character", `src/${token}?.ts`),
      rejected("reserved-character", `src/${token}*.ts`),
      rejected("reserved-character", `src:${token}.ts`),
      rejected("reserved-device", `src/CoN`),
      rejected("reserved-device", `src/nul.txt`),
      rejected("reserved-suffix", `src/${token}.`),
      rejected("reserved-suffix", `src/${token} `),
      rejected("overlong-segment", `src/${"a".repeat(256)}`),
      rejected(
        "overlong-path",
        Array.from({ length: 18 }, () => "b".repeat(240)).join("/"),
      ),
      rejected("empty", ""),
    ];
    assert.equal(valid.length, config.validCasesPerSeed);
    assert.equal(invalid.length, config.invalidCasesPerSeed);
    for (const [index, candidate] of [...valid, ...invalid].entries()) {
      generated.push(Object.freeze({
        caseId: `${seed.toString(16)}-${String(index).padStart(2, "0")}`,
        ...candidate,
      }));
    }
  }
  if (generated.length > config.maximumGeneratedCases) {
    throw new Error("Generated repository path corpus exceeded its configured bound.");
  }
  return Object.freeze(generated);
}

function rejected(
  category: string,
  input: string,
): Omit<GeneratedPathCase, "caseId"> {
  return Object.freeze({ category, input, expectedCanonical: null });
}

/** Separate reference grammar: it never calls production path normalization. */
function referenceNormalizePath(
  input: string,
  config: GeneratorConfig,
): string | null {
  if (
    input.length === 0 ||
    !isWellFormedUnicode(input) ||
    Buffer.byteLength(input, "utf8") > config.maximumPathBytes ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(input) ||
    /[<>:"|?*%\\]/u.test(input) ||
    input.startsWith("/")
  ) {
    return null;
  }
  const rawSegments = input.split("/");
  if (
    rawSegments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > config.maximumSegmentBytes,
    )
  ) {
    return null;
  }
  const canonicalSegments = rawSegments.map((segment) => segment.normalize("NFC"));
  if (
    canonicalSegments.some(
      (segment) =>
        Buffer.byteLength(segment, "utf8") > config.maximumSegmentBytes ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        RESERVED_WINDOWS_SEGMENT.test(segment),
    )
  ) {
    return null;
  }
  const canonical = canonicalSegments.join("/");
  return Buffer.byteLength(canonical, "utf8") <= config.maximumPathBytes
    ? canonical
    : null;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function corpusSha256(cases: readonly GeneratedPathCase[]): string {
  return createHash("sha256").update(JSON.stringify(cases), "utf8").digest("hex");
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

async function fixtureRoot(
  t: test.TestContext,
  prefix: string,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function isCode(error: unknown, code: string): boolean {
  return isDomainError(error) && error.code === code;
}

function isUnavailableSymlink(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EPERM" ||
    code === "EACCES" ||
    code === "ENOSYS" ||
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP"
  );
}
