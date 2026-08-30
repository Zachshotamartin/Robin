import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RunIdKind,
  isDomainError,
  sha256Hex,
} from "@guard/contracts";

import {
  LocalContentAddressedArtifactStore,
  parseArtifactReferenceId,
  parseSha256ContentHash,
  type ArtifactWriteDescriptor,
  type Sha256ContentHash,
} from "./index.js";

const CREATED_AT = "2026-08-30T08:00:00.000Z";

function domainCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => isDomainError(error) && error.code === code;
}

function contentHash(bytes: Uint8Array): Sha256ContentHash {
  return parseSha256ContentHash(`sha256:${sha256Hex(bytes)}`);
}

function descriptor(
  bytes: Uint8Array,
  overrides: Partial<ArtifactWriteDescriptor> = {},
): ArtifactWriteDescriptor {
  return {
    byteLength: bytes.byteLength,
    kind: "test-output",
    mediaType: "application/octet-stream",
    displayName: null,
    expectedContentHash: contentHash(bytes),
    ...overrides,
  };
}

async function* chunks(...values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

async function fixture(
  options: Readonly<Record<string, unknown>> = {},
): Promise<{
  readonly root: string;
  readonly store: LocalContentAddressedArtifactStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "guard-artifact-store-"));
  await chmod(root, 0o700);
  return {
    root,
    store: new LocalContentAddressedArtifactStore({
      rootDirectory: root,
      maximumObjectBytes: 1_024,
      maximumRunBytes: 4_096,
      maximumStoreBytes: 8_192,
      maximumChunkBytes: 512,
      minimumFreeBytes: 0,
      now: () => CREATED_AT,
      ...options,
    }),
  };
}

async function allFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files.push(child.slice(root.length + 1));
    }
  }
  await visit(root);
  return files.sort();
}

test("writes exact streamed bytes to the sha256 CAS and returns an immutable run reference", async () => {
  const { root, store } = await fixture();
  const runId = RunIdKind.generate();
  const first = Buffer.from("exact ");
  const second = Buffer.from("artifact bytes\n");
  const bytes = Buffer.concat([first, second]);

  const reference = await store.write(
    runId,
    descriptor(bytes, { displayName: "result.bin" }),
    chunks(first, second),
  );

  const hash = sha256Hex(bytes);
  assert.equal(reference.contentHash, `sha256:${hash}`);
  assert.equal(reference.byteLength, bytes.byteLength);
  assert.equal(reference.runId, runId);
  assert.equal(reference.createdAt, CREATED_AT);
  assert.equal(Object.isFrozen(reference), true);
  assert.deepEqual(await store.read(runId, reference.artifactReferenceId), bytes);
  assert.deepEqual(await store.inspect(runId, reference.artifactReferenceId), reference);
  assert.deepEqual(await readFile(join(root, "sha256", hash.slice(0, 2), hash)), bytes);

  const objectStat = await lstat(join(root, "sha256", hash.slice(0, 2), hash));
  assert.equal(objectStat.isFile(), true);
  assert.equal(objectStat.mode & 0o077, 0);
});

test("accepts exact object, run, store, and chunk byte ceilings", async () => {
  const bytes = Buffer.from("12345678");
  const { store } = await fixture({
    maximumObjectBytes: bytes.byteLength,
    maximumRunBytes: bytes.byteLength,
    maximumStoreBytes: bytes.byteLength,
    maximumChunkBytes: bytes.byteLength,
  });

  const reference = await store.write(
    RunIdKind.generate(),
    descriptor(bytes),
    chunks(bytes),
  );
  assert.equal(reference.byteLength, bytes.byteLength);
});

test("rejects one byte over every configured ceiling without a final object or reference", async () => {
  const cases = [
    { maximumObjectBytes: 7 },
    { maximumRunBytes: 7 },
    { maximumStoreBytes: 7 },
    { maximumChunkBytes: 7 },
  ] as const;
  const bytes = Buffer.from("12345678");

  for (const options of cases) {
    const { root, store } = await fixture(options);
    await assert.rejects(
      store.write(RunIdKind.generate(), descriptor(bytes), chunks(bytes)),
      domainCode("budget_exceeded"),
    );
    assert.equal(
      (await allFiles(root)).some((path) => /^[^/]*sha256\//u.test(path)),
      false,
    );
  }
});

test("quota denial occurs before the untrusted content iterator is invoked", async () => {
  const bytes = Buffer.from("too-large");
  const { store } = await fixture({ maximumObjectBytes: bytes.byteLength - 1 });
  let iteratorCalls = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      iteratorCalls += 1;
      throw new Error("secret-iterator-canary");
    },
  };

  await assert.rejects(
    store.write(RunIdKind.generate(), descriptor(bytes), source),
    domainCode("budget_exceeded"),
  );
  assert.equal(iteratorCalls, 0);
});

test("declared length and expected hash must match exact streamed bytes", async () => {
  const bytes = Buffer.from("verified");
  for (const invalid of [
    descriptor(bytes, { byteLength: bytes.byteLength + 1 }),
    descriptor(bytes, {
      expectedContentHash: contentHash(Buffer.from("different")),
    }),
  ]) {
    const { root, store } = await fixture();
    await assert.rejects(
      store.write(RunIdKind.generate(), invalid, chunks(bytes)),
      domainCode("invalid_input"),
    );
    assert.equal((await allFiles(root)).some((path) => path.startsWith("sha256/")), false);
  }
});

test("cancellation before and during a stream leaves no object, reference, or partial temp file", async () => {
  const bytes = Buffer.from("cancel-me");

  {
    const { root, store } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      store.write(RunIdKind.generate(), descriptor(bytes), chunks(bytes), controller.signal),
      domainCode("cancelled"),
    );
    assert.deepEqual(await allFiles(root), []);
  }

  {
    const { root, store } = await fixture();
    const controller = new AbortController();
    async function* cancelling(): AsyncIterable<Uint8Array> {
      yield bytes.subarray(0, 3);
      controller.abort();
      yield bytes.subarray(3);
    }
    await assert.rejects(
      store.write(RunIdKind.generate(), descriptor(bytes), cancelling(), controller.signal),
      domainCode("cancelled"),
    );
    assert.equal((await allFiles(root)).some((path) => path.endsWith(".part")), false);
    assert.equal((await allFiles(root)).some((path) => path.startsWith("sha256/")), false);
  }
});

test("cancellation interrupts a stalled async source and removes its temporary file", async () => {
  const { root, store } = await fixture();
  const controller = new AbortController();
  const stalled: AsyncIterable<Uint8Array> & AsyncIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      return await new Promise<IteratorResult<Uint8Array>>(() => undefined);
    },
  };
  const pending = store.write(
    RunIdKind.generate(),
    descriptor(Buffer.from("x")),
    stalled,
    controller.signal,
  );
  queueMicrotask(() => controller.abort());

  await assert.rejects(pending, domainCode("cancelled"));
  assert.equal((await allFiles(root)).some((path) => path.endsWith(".part")), false);
});

test("cancellation cannot be lost between the initial check and abort-listener registration", async () => {
  const { root, store } = await fixture();
  const controller = new AbortController();
  const signal = controller.signal;
  const addEventListener = signal.addEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    value(...arguments_: Parameters<AbortSignal["addEventListener"]>) {
      controller.abort();
      return Reflect.apply(addEventListener, signal, arguments_);
    },
  });
  const source: AsyncIterable<Uint8Array> & AsyncIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return { done: true, value: undefined };
    },
  };

  await assert.rejects(
    store.write(
      RunIdKind.generate(),
      descriptor(Buffer.from("x")),
      source,
      signal,
    ),
    domainCode("cancelled"),
  );
  assert.equal((await allFiles(root)).some((path) => path.endsWith(".part")), false);
});

test("temporary writes stay owner-only and on the final store filesystem", async () => {
  const { root, store } = await fixture();
  const bytes = Buffer.from("device-bound");
  let inspected = false;
  async function* inspecting(): AsyncIterable<Uint8Array> {
    yield bytes.subarray(0, 2);
    const temporaryNames = await readdir(join(root, "tmp"));
    assert.equal(temporaryNames.length, 1);
    const temporaryStats = await lstat(join(root, "tmp", temporaryNames[0] as string));
    const rootStats = await lstat(root);
    assert.equal(temporaryStats.isFile(), true);
    assert.equal(temporaryStats.mode & 0o077, 0);
    assert.equal(temporaryStats.dev, rootStats.dev);
    inspected = true;
    yield bytes.subarray(2);
  }

  await store.write(RunIdKind.generate(), descriptor(bytes), inspecting());
  assert.equal(inspected, true);
  assert.deepEqual(await readdir(join(root, "tmp")), []);
});

test("deduplicates equal objects across runs while keeping distinct run-scoped references", async () => {
  const { root, store } = await fixture();
  const bytes = Buffer.from("shared object");
  const firstRun = RunIdKind.generate();
  const secondRun = RunIdKind.generate();

  const [first, second] = await Promise.all([
    store.write(firstRun, descriptor(bytes), chunks(bytes)),
    store.write(secondRun, descriptor(bytes), chunks(bytes)),
  ]);

  assert.equal(first.artifactId, second.artifactId);
  assert.equal(first.contentHash, second.contentHash);
  assert.notEqual(first.artifactReferenceId, second.artifactReferenceId);
  const hash = sha256Hex(bytes);
  const objectFiles = (await allFiles(root)).filter(
    (path) => path === `sha256/${hash.slice(0, 2)}/${hash}`,
  );
  assert.equal(objectFiles.length, 1);
});

test("a full physical store still accepts a verified reference to an existing shared object", async () => {
  const bytes = Buffer.from("fills-store");
  const { store } = await fixture({ maximumStoreBytes: bytes.byteLength });
  const first = await store.write(
    RunIdKind.generate(),
    descriptor(bytes),
    chunks(bytes),
  );
  const second = await store.write(
    RunIdKind.generate(),
    descriptor(bytes),
    chunks(bytes),
  );
  assert.equal(first.artifactId, second.artifactId);
});

test("objects, references, and quota accounting survive adapter restart", async () => {
  const { root, store } = await fixture();
  const runId = RunIdKind.generate();
  const bytes = Buffer.from("restart durable");
  const reference = await store.write(runId, descriptor(bytes), chunks(bytes));

  const restarted = new LocalContentAddressedArtifactStore({
    rootDirectory: root,
    maximumObjectBytes: 1_024,
    maximumRunBytes: bytes.byteLength,
    maximumStoreBytes: bytes.byteLength,
    maximumChunkBytes: 512,
    minimumFreeBytes: 0,
    now: () => CREATED_AT,
  });
  assert.deepEqual(await restarted.read(runId, reference.artifactReferenceId), bytes);
  await assert.rejects(
    restarted.write(runId, descriptor(Buffer.from("x")), chunks(Buffer.from("x"))),
    domainCode("budget_exceeded"),
  );
  const shared = await restarted.write(
    RunIdKind.generate(),
    descriptor(bytes),
    chunks(bytes),
  );
  assert.equal(shared.artifactId, reference.artifactId);
});

test("a reference is rejected for every run except its immutable owner", async () => {
  const { store } = await fixture();
  const bytes = Buffer.from("private reference");
  const owner = RunIdKind.generate();
  const other = RunIdKind.generate();
  const reference = await store.write(owner, descriptor(bytes), chunks(bytes));

  await assert.rejects(
    store.read(other, reference.artifactReferenceId),
    domainCode("invalid_input"),
  );
  await assert.rejects(
    store.inspect(other, reference.artifactReferenceId),
    domainCode("invalid_input"),
  );
  assert.deepEqual(await store.read(owner, reference.artifactReferenceId), bytes);
});

test("strict identifier and hash parsers reject malformed, uppercase, and traversal-shaped input", async () => {
  const { store } = await fixture();
  const runId = RunIdKind.generate();
  const malformedReferences = ["", "../escape", "aref_not-a-uuid", "art_018f0000-0000-7000-8000-000000000000"];
  const malformedHashes = ["", "sha256:abc", `sha256:${"A".repeat(64)}`, `sha512:${"a".repeat(64)}`];

  for (const value of malformedReferences) {
    assert.throws(() => parseArtifactReferenceId(value), domainCode("invalid_input"));
    await assert.rejects(
      store.read(runId, value as never),
      domainCode("invalid_input"),
    );
  }
  for (const value of malformedHashes) {
    assert.throws(() => parseSha256ContentHash(value), domainCode("invalid_input"));
  }
});

test("descriptor and option boundaries reject unknown fields, accessors, and proxies without invoking canaries", async () => {
  const bytes = Buffer.from("boundary");
  const { store } = await fixture();
  let getterCalls = 0;
  const hostile = {
    byteLength: bytes.byteLength,
    kind: "test-output",
    mediaType: "application/octet-stream",
    displayName: null,
  } as Record<string, unknown>;
  Object.defineProperty(hostile, "expectedContentHash", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return contentHash(bytes);
    },
  });
  await assert.rejects(
    store.write(
      RunIdKind.generate(),
      hostile as unknown as ArtifactWriteDescriptor,
      chunks(bytes),
    ),
    domainCode("invalid_input"),
  );
  assert.equal(getterCalls, 0);

  const unknown = { ...descriptor(bytes), unexpected: true };
  await assert.rejects(
    store.write(
      RunIdKind.generate(),
      unknown as ArtifactWriteDescriptor,
      chunks(bytes),
    ),
    domainCode("invalid_input"),
  );

  let proxyCalls = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() {
      proxyCalls += 1;
      throw new Error("secret-proxy-canary");
    },
    ownKeys() {
      proxyCalls += 1;
      throw new Error("secret-proxy-canary");
    },
  });
  assert.throws(
    () => new LocalContentAddressedArtifactStore(
      proxy as unknown as ConstructorParameters<typeof LocalContentAddressedArtifactStore>[0],
    ),
    domainCode("invalid_input"),
  );
  assert.equal(proxyCalls, 0);
});

test("tampered object bytes are never returned by read or accepted by inspect", async () => {
  const { root, store } = await fixture();
  const bytes = Buffer.from("untampered");
  const runId = RunIdKind.generate();
  const reference = await store.write(runId, descriptor(bytes), chunks(bytes));
  const hash = sha256Hex(bytes);
  await writeFile(join(root, "sha256", hash.slice(0, 2), hash), "corruption", { mode: 0o600 });

  await assert.rejects(
    store.read(runId, reference.artifactReferenceId),
    domainCode("invariant_violated"),
  );
  await assert.rejects(
    store.inspect(runId, reference.artifactReferenceId),
    domainCode("invariant_violated"),
  );
});

test("no-follow reads reject object, reference, and prefix symlinks", { skip: constants.O_NOFOLLOW === undefined }, async () => {
  const bytes = Buffer.from("symlink target");

  {
    const { root, store } = await fixture();
    const runId = RunIdKind.generate();
    const reference = await store.write(runId, descriptor(bytes), chunks(bytes));
    const hash = sha256Hex(bytes);
    const objectPath = join(root, "sha256", hash.slice(0, 2), hash);
    const target = join(root, "target-object");
    await writeFile(target, bytes, { mode: 0o600 });
    await unlink(objectPath);
    await symlink(target, objectPath);
    await assert.rejects(
      store.read(runId, reference.artifactReferenceId),
      domainCode("invariant_violated"),
    );
  }

  {
    const { root, store } = await fixture();
    const runId = RunIdKind.generate();
    const reference = await store.write(runId, descriptor(bytes), chunks(bytes));
    const referencePath = join(
      root,
      "references",
      runId,
      `${reference.artifactReferenceId}.json`,
    );
    const target = join(root, "target-reference");
    await writeFile(target, JSON.stringify(reference), { mode: 0o600 });
    await unlink(referencePath);
    await symlink(target, referencePath);
    await assert.rejects(
      store.read(runId, reference.artifactReferenceId),
      domainCode("invariant_violated"),
    );
  }

  {
    const { root, store } = await fixture();
    const prefix = sha256Hex(bytes).slice(0, 2);
    const outside = join(root, "outside-prefix");
    await mkdir(outside, { mode: 0o700 });
    await mkdir(join(root, "sha256"), { mode: 0o700 });
    await symlink(outside, join(root, "sha256", prefix));
    await assert.rejects(
      store.write(RunIdKind.generate(), descriptor(bytes), chunks(bytes)),
      domainCode("invariant_violated"),
    );
  }
});

test("source failures are sanitized and leave no partial final object", async () => {
  const { root, store } = await fixture();
  const bytes = Buffer.from("source failure");
  async function* failing(): AsyncIterable<Uint8Array> {
    yield bytes.subarray(0, 2);
    throw new Error("secret-source-canary");
  }

  await assert.rejects(
    store.write(RunIdKind.generate(), descriptor(bytes), failing()),
    (error: unknown) => {
      assert.equal(isDomainError(error), true);
      assert.equal(JSON.stringify(error).includes("secret-source-canary"), false);
      return isDomainError(error) && error.code === "infrastructure_failed";
    },
  );
  assert.equal((await allFiles(root)).some((path) => path.endsWith(".part")), false);
  assert.equal((await allFiles(root)).some((path) => path.startsWith("sha256/")), false);
});
