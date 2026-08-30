import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, dirname, join } from "node:path";
import { isProxy, isUint8Array } from "node:util/types";

import {
  ArtifactIdKind,
  CONTRACT_SCHEMA_VERSION,
  RunIdKind,
  createDomainError,
  isDomainError,
} from "@guard/contracts";
import type {
  ArtifactId,
  DomainError,
  RunId,
} from "@guard/contracts";

import type {
  ArtifactReference,
  ArtifactReferenceId,
  ArtifactStore,
  ArtifactWriteDescriptor,
  Sha256ContentHash,
} from "./artifact-store.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PREFIX_PATTERN = /^[0-9a-f]{2}$/u;
const KIND_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
const MAXIMUM_MEDIA_TYPE_BYTES = 256;
const MAXIMUM_DISPLAY_NAME_BYTES = 512;
const MAXIMUM_METADATA_BYTES = 16_384;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export const DEFAULT_MAXIMUM_ARTIFACT_OBJECT_BYTES = 67_108_864;
export const DEFAULT_MAXIMUM_ARTIFACT_RUN_BYTES = 536_870_912;
export const DEFAULT_MAXIMUM_ARTIFACT_STORE_BYTES = 2_147_483_648;
export const DEFAULT_MAXIMUM_ARTIFACT_CHUNK_BYTES = 1_048_576;
export const DEFAULT_MAXIMUM_ARTIFACT_CHUNKS = 65_536;
export const DEFAULT_MINIMUM_ARTIFACT_FREE_BYTES = 67_108_864;

export interface LocalContentAddressedArtifactStoreOptions {
  readonly rootDirectory: string;
  readonly maximumObjectBytes?: number;
  readonly maximumRunBytes?: number;
  readonly maximumStoreBytes?: number;
  readonly maximumChunkBytes?: number;
  readonly maximumChunks?: number;
  readonly minimumFreeBytes?: number;
  readonly now?: () => string;
}

interface ParsedOptions {
  readonly rootDirectory: string;
  readonly maximumObjectBytes: number;
  readonly maximumRunBytes: number;
  readonly maximumStoreBytes: number;
  readonly maximumChunkBytes: number;
  readonly maximumChunks: number;
  readonly minimumFreeBytes: number;
  readonly now: () => unknown;
}

interface ObjectRecord {
  readonly schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  readonly artifactId: ArtifactId;
  readonly byteLength: number;
  readonly contentHash: Sha256ContentHash;
  readonly createdAt: string;
}

interface CapacityReservation {
  readonly runId: RunId;
  readonly runBytes: number;
  readonly storeBytes: number;
  released: boolean;
}

interface OpenedTemp {
  readonly path: string;
  readonly handle: FileHandle;
}

interface StoredContent {
  readonly path: string;
  readonly byteLength: number;
  readonly contentHash: Sha256ContentHash;
}

interface PublishedObject {
  readonly record: ObjectRecord;
  readonly created: boolean;
}

const OPTION_KEYS = new Set<PropertyKey>([
  "rootDirectory",
  "maximumObjectBytes",
  "maximumRunBytes",
  "maximumStoreBytes",
  "maximumChunkBytes",
  "maximumChunks",
  "minimumFreeBytes",
  "now",
]);
const DESCRIPTOR_KEYS = new Set<PropertyKey>([
  "byteLength",
  "kind",
  "mediaType",
  "displayName",
  "expectedContentHash",
]);
const OBJECT_RECORD_KEYS = new Set<PropertyKey>([
  "schemaVersion",
  "artifactId",
  "byteLength",
  "contentHash",
  "createdAt",
]);
const REFERENCE_KEYS = new Set<PropertyKey>([
  "schemaVersion",
  "artifactReferenceId",
  "artifactId",
  "runId",
  "byteLength",
  "contentHash",
  "kind",
  "mediaType",
  "displayName",
  "createdAt",
]);

const defaultNow = (): string => new Date().toISOString();

/** Strictly parses the lowercase, algorithm-qualified object hash. */
export function parseSha256ContentHash(value: unknown): Sha256ContentHash {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidInput("Expected a lowercase sha256 content hash.");
  }
  return value as Sha256ContentHash;
}

/** Strictly parses a reference identifier without accepting filesystem syntax. */
export function parseArtifactReferenceId(value: unknown): ArtifactReferenceId {
  if (
    typeof value !== "string" ||
    !value.startsWith("aref_") ||
    !ArtifactIdKind.is(`art_${value.slice(5)}`)
  ) {
    throw invalidInput("Expected an artifact reference identifier.");
  }
  return value as ArtifactReferenceId;
}

/**
 * Hardened Milestone C single-process adapter. Objects and immutable run
 * references are published only after exact length/hash verification. The
 * configured root and every store-created directory must be owner-only on one
 * filesystem. Capacity reservations are intentionally not cross-process or
 * transactional; Milestone E supplies that durability boundary.
 */
export class LocalContentAddressedArtifactStore implements ArtifactStore {
  readonly #options: ParsedOptions;
  readonly #rootDirectory: string;
  readonly #sha256Directory: string;
  readonly #temporaryDirectory: string;
  readonly #lockDirectory: string;
  readonly #referenceDirectory: string;

  #initialization: Promise<void> | null = null;
  #rootDevice: bigint | number | null = null;
  #objects = new Map<Sha256ContentHash, ObjectRecord>();
  #runBytes = new Map<RunId, number>();
  #reservedRunBytes = new Map<RunId, number>();
  #storeBytes = 0;
  #reservedStoreBytes = 0;
  #stateTail: Promise<void> = Promise.resolve();

  public constructor(options: LocalContentAddressedArtifactStoreOptions) {
    this.#options = parseOptions(options);
    this.#rootDirectory = this.#options.rootDirectory;
    this.#sha256Directory = join(this.#rootDirectory, "sha256");
    this.#temporaryDirectory = join(this.#rootDirectory, "tmp");
    this.#lockDirectory = join(this.#rootDirectory, "locks");
    this.#referenceDirectory = join(this.#rootDirectory, "references");
  }

  public async write(
    runId: RunId,
    descriptorValue: ArtifactWriteDescriptor,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<ArtifactReference> {
    try {
      throwIfAborted(signal);
      validateRunId(runId);
      const descriptor = parseWriteDescriptor(descriptorValue);
      await this.#ensureInitialized();
      throwIfAborted(signal);
      const createdAt = readClock(this.#options.now);
      const reservation = await this.#reserve(runId, descriptor, signal);
      let temporary: OpenedTemp | null = null;

      try {
        // Quotas are reserved before invoking the untrusted iterable at all.
        const iterator = inspectAsyncIterator(content);
        temporary = await this.#openTemporaryFile();
        const stored = await this.#consumeContent(
          temporary,
          descriptor,
          iterator,
          signal,
        );
        throwIfAborted(signal);

        return await this.#withStateLock(async () => {
          throwIfAborted(signal);
          const published = await this.#publishObject(stored, createdAt);
          if (!this.#objects.has(published.record.contentHash)) {
            this.#objects.set(published.record.contentHash, published.record);
            this.#storeBytes = addSafe(
              this.#storeBytes,
              published.record.byteLength,
              "Artifact store usage overflowed.",
            );
          }
          const reference = await this.#publishReference(
            runId,
            descriptor,
            published.record,
            createdAt,
          );
          this.#runBytes.set(
            runId,
            addSafe(
              this.#runBytes.get(runId) ?? 0,
              reference.byteLength,
              "Artifact run usage overflowed.",
            ),
          );
          this.#releaseReservationLocked(reservation);
          return reference;
        });
      } catch (error: unknown) {
        if (temporary !== null) {
          await closeQuietly(temporary.handle);
          await unlinkQuietly(temporary.path);
        }
        await this.#releaseReservation(reservation);
        throw normalizeOperationalFailure(error);
      }
    } catch (error: unknown) {
      throw normalizeOperationalFailure(error);
    }
  }

  public async inspect(
    runId: RunId,
    artifactReferenceId: ArtifactReferenceId,
    signal?: AbortSignal,
  ): Promise<ArtifactReference> {
    try {
      throwIfAborted(signal);
      validateRunId(runId);
      const parsedReferenceId = parseArtifactReferenceId(artifactReferenceId);
      await this.#ensureInitialized();
      const reference = await this.#loadAuthorizedReference(
        runId,
        parsedReferenceId,
        signal,
      );
      await this.#readVerifiedObject(reference, signal);
      return reference;
    } catch (error: unknown) {
      throw normalizeOperationalFailure(error);
    }
  }

  public async read(
    runId: RunId,
    artifactReferenceId: ArtifactReferenceId,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      throwIfAborted(signal);
      validateRunId(runId);
      const parsedReferenceId = parseArtifactReferenceId(artifactReferenceId);
      await this.#ensureInitialized();
      const reference = await this.#loadAuthorizedReference(
        runId,
        parsedReferenceId,
        signal,
      );
      return await this.#readVerifiedObject(reference, signal);
    } catch (error: unknown) {
      throw normalizeOperationalFailure(error);
    }
  }

  async #ensureInitialized(): Promise<void> {
    this.#initialization ??= this.#initialize();
    try {
      await this.#initialization;
    } catch (error: unknown) {
      this.#initialization = null;
      throw error;
    }
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#rootDirectory, {
      recursive: true,
      mode: DIRECTORY_MODE,
    }).catch((error: unknown) => {
      throw filesystemFailure(error, "The artifact root could not be created.");
    });
    const root = await verifyOwnedDirectory(this.#rootDirectory);
    this.#rootDevice = root.dev;

    for (const path of [
      this.#sha256Directory,
      this.#temporaryDirectory,
      this.#lockDirectory,
      this.#referenceDirectory,
    ]) {
      await ensureOwnedDirectory(path, root.dev);
    }

    const objects = await this.#scanObjects();
    const usage = await this.#scanReferences(objects);
    let storeBytes = 0;
    for (const object of objects.values()) {
      storeBytes = addSafe(
        storeBytes,
        object.byteLength,
        "Artifact store usage overflowed.",
      );
    }
    if (storeBytes > this.#options.maximumStoreBytes) {
      throw invariantFailure("Existing artifact objects exceed the configured store quota.");
    }

    this.#objects = objects;
    this.#runBytes = usage;
    this.#storeBytes = storeBytes;
  }

  async #scanObjects(): Promise<Map<Sha256ContentHash, ObjectRecord>> {
    const objects = new Map<Sha256ContentHash, ObjectRecord>();
    const prefixes = await readDirectoryEntries(this.#sha256Directory);
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !PREFIX_PATTERN.test(prefix.name)) {
        throw invariantFailure("The artifact object directory contains an unknown entry.");
      }
      const directory = join(this.#sha256Directory, prefix.name);
      await verifyOwnedDirectory(directory, this.#rootDevice);
      const entries = await readDirectoryEntries(directory);
      const objectNames = new Set<string>();
      const manifestNames = new Set<string>();
      for (const entry of entries) {
        if (!entry.isFile()) {
          throw invariantFailure("The artifact object directory contains a non-file entry.");
        }
        if (HEX_SHA256_PATTERN.test(entry.name)) {
          objectNames.add(entry.name);
        } else if (
          entry.name.endsWith(".json") &&
          HEX_SHA256_PATTERN.test(entry.name.slice(0, -5))
        ) {
          manifestNames.add(entry.name.slice(0, -5));
        } else {
          throw invariantFailure("The artifact object directory contains an unknown file.");
        }
      }
      if (
        objectNames.size !== manifestNames.size ||
        [...objectNames].some((name) => !manifestNames.has(name))
      ) {
        throw invariantFailure("Artifact object data and metadata are incomplete.");
      }

      for (const hexHash of objectNames) {
        if (!hexHash.startsWith(prefix.name)) {
          throw invariantFailure("An artifact object is outside its content-hash prefix.");
        }
        const expectedHash = parseSha256ContentHash(`sha256:${hexHash}`);
        const manifest = await readObjectRecord(
          join(directory, `${hexHash}.json`),
        );
        if (manifest.contentHash !== expectedHash) {
          throw invariantFailure("Artifact object metadata does not match its path.");
        }
        await readAndVerifyFile({
          path: join(directory, hexHash),
          expectedLength: manifest.byteLength,
          expectedHash,
          maximumBytes: this.#options.maximumObjectBytes,
          signal: undefined,
        });
        if (objects.has(expectedHash)) {
          throw invariantFailure("An artifact content hash was recorded more than once.");
        }
        objects.set(expectedHash, manifest);
      }
    }
    return objects;
  }

  async #scanReferences(
    objects: ReadonlyMap<Sha256ContentHash, ObjectRecord>,
  ): Promise<Map<RunId, number>> {
    const usage = new Map<RunId, number>();
    for (const runEntry of await readDirectoryEntries(this.#referenceDirectory)) {
      if (!runEntry.isDirectory() || !RunIdKind.is(runEntry.name)) {
        throw invariantFailure("The artifact reference directory contains an unknown entry.");
      }
      const runId = runEntry.name;
      const runDirectory = join(this.#referenceDirectory, runId);
      await verifyOwnedDirectory(runDirectory, this.#rootDevice);
      let runBytes = 0;
      for (const entry of await readDirectoryEntries(runDirectory)) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          throw invariantFailure("The artifact run directory contains an unknown entry.");
        }
        let referenceId: ArtifactReferenceId;
        try {
          referenceId = parseArtifactReferenceId(entry.name.slice(0, -5));
        } catch {
          throw invariantFailure("An artifact run directory contains a malformed reference.");
        }
        const reference = await readArtifactReference(join(runDirectory, entry.name));
        if (
          reference.runId !== runId ||
          reference.artifactReferenceId !== referenceId
        ) {
          throw invariantFailure("Artifact reference ownership metadata is inconsistent.");
        }
        const object = objects.get(reference.contentHash);
        if (
          object === undefined ||
          object.artifactId !== reference.artifactId ||
          object.byteLength !== reference.byteLength
        ) {
          throw invariantFailure("An artifact reference does not identify a stored object.");
        }
        runBytes = addSafe(
          runBytes,
          reference.byteLength,
          "Artifact run usage overflowed.",
        );
      }
      if (runBytes > this.#options.maximumRunBytes) {
        throw invariantFailure("Existing artifact references exceed the configured run quota.");
      }
      usage.set(runId, runBytes);
    }
    return usage;
  }

  async #reserve(
    runId: RunId,
    descriptor: ArtifactWriteDescriptor,
    signal: AbortSignal | undefined,
  ): Promise<CapacityReservation> {
    return await this.#withStateLock(async () => {
      throwIfAborted(signal);
      if (descriptor.byteLength > this.#options.maximumObjectBytes) {
        throw budgetFailure("The artifact exceeds the per-object byte quota.");
      }

      const runBytes = addSafe(
        this.#runBytes.get(runId) ?? 0,
        this.#reservedRunBytes.get(runId) ?? 0,
        "Artifact run reservation overflowed.",
      );
      if (
        descriptor.byteLength > this.#options.maximumRunBytes - runBytes
      ) {
        throw budgetFailure("The artifact exceeds the owning run's byte quota.");
      }

      const expectedObject = descriptor.expectedContentHash === null
        ? undefined
        : this.#objects.get(descriptor.expectedContentHash);
      if (
        expectedObject !== undefined &&
        expectedObject.byteLength !== descriptor.byteLength
      ) {
        throw invariantFailure("Stored artifact metadata conflicts with the declared length.");
      }
      const storeReservation = expectedObject === undefined
        ? descriptor.byteLength
        : 0;
      const currentStoreCommitment = addSafe(
        this.#storeBytes,
        this.#reservedStoreBytes,
        "Artifact store reservation overflowed.",
      );
      if (
        storeReservation > this.#options.maximumStoreBytes - currentStoreCommitment
      ) {
        throw budgetFailure("The artifact exceeds the total store byte quota.");
      }
      await this.#enforceFreeSpace(storeReservation);

      this.#reservedRunBytes.set(
        runId,
        addSafe(
          this.#reservedRunBytes.get(runId) ?? 0,
          descriptor.byteLength,
          "Artifact run reservation overflowed.",
        ),
      );
      this.#reservedStoreBytes = addSafe(
        this.#reservedStoreBytes,
        storeReservation,
        "Artifact store reservation overflowed.",
      );
      return {
        runId,
        runBytes: descriptor.byteLength,
        storeBytes: storeReservation,
        released: false,
      };
    });
  }

  async #enforceFreeSpace(reservation: number): Promise<void> {
    if (this.#options.minimumFreeBytes === 0 && reservation === 0) return;
    let available: bigint;
    try {
      const statistics = await statfs(this.#rootDirectory, { bigint: true });
      available = statistics.bavail * statistics.bsize;
    } catch (error: unknown) {
      throw filesystemFailure(error, "Artifact filesystem capacity could not be inspected.");
    }
    const required = BigInt(reservation) + BigInt(this.#options.minimumFreeBytes);
    if (available < required) {
      throw budgetFailure("The artifact store's reserved free-space floor would be crossed.");
    }
  }

  async #releaseReservation(reservation: CapacityReservation): Promise<void> {
    await this.#withStateLock(() => {
      this.#releaseReservationLocked(reservation);
    });
  }

  #releaseReservationLocked(reservation: CapacityReservation): void {
    if (reservation.released) return;
    const runReserved = this.#reservedRunBytes.get(reservation.runId) ?? 0;
    if (
      runReserved < reservation.runBytes ||
      this.#reservedStoreBytes < reservation.storeBytes
    ) {
      throw invariantFailure("Artifact capacity reservation accounting diverged.");
    }
    const remainingRun = runReserved - reservation.runBytes;
    if (remainingRun === 0) this.#reservedRunBytes.delete(reservation.runId);
    else this.#reservedRunBytes.set(reservation.runId, remainingRun);
    this.#reservedStoreBytes -= reservation.storeBytes;
    reservation.released = true;
  }

  async #openTemporaryFile(): Promise<OpenedTemp> {
    await verifyOwnedDirectory(this.#temporaryDirectory, this.#rootDevice);
    const path = join(this.#temporaryDirectory, `${randomUUID()}.part`);
    const handle = await openExclusiveNoFollow(path);
    try {
      await verifyOwnedFileHandle(handle, this.#rootDevice);
      return { path, handle };
    } catch (error: unknown) {
      await closeQuietly(handle);
      await unlinkQuietly(path);
      throw error;
    }
  }

  async #consumeContent(
    temporary: OpenedTemp,
    descriptor: ArtifactWriteDescriptor,
    iterator: AsyncIterator<Uint8Array>,
    signal: AbortSignal | undefined,
  ): Promise<StoredContent> {
    const hash = createHash("sha256");
    let bytesWritten = 0;
    let chunksRead = 0;
    let completed = false;

    try {
      while (true) {
        throwIfAborted(signal);
        const result = await awaitWithAbort(callIteratorNext(iterator), signal);
        const inspected = inspectIteratorResult(result);
        if (inspected.done) {
          completed = true;
          break;
        }
        chunksRead += 1;
        if (chunksRead > this.#options.maximumChunks) {
          throw budgetFailure("The artifact exceeds the chunk-count quota.");
        }
        const chunk = copyChunk(inspected.value);
        if (chunk.byteLength > this.#options.maximumChunkBytes) {
          throw budgetFailure("An artifact chunk exceeds the configured byte quota.");
        }
        if (chunk.byteLength > descriptor.byteLength - bytesWritten) {
          throw invalidInput("The artifact stream exceeds its declared byte length.");
        }
        throwIfAborted(signal);
        await writeAll(temporary.handle, chunk);
        hash.update(chunk);
        bytesWritten += chunk.byteLength;
      }
      if (bytesWritten !== descriptor.byteLength) {
        throw invalidInput("The artifact stream does not match its declared byte length.");
      }
      const contentHash = parseSha256ContentHash(`sha256:${hash.digest("hex")}`);
      if (
        descriptor.expectedContentHash !== null &&
        descriptor.expectedContentHash !== contentHash
      ) {
        throw invalidInput("The artifact stream does not match its expected content hash.");
      }

      await temporary.handle.sync();
      const stats = await temporary.handle.stat();
      verifyOwnedFileStats(stats, this.#rootDevice);
      if (stats.size !== bytesWritten) {
        throw invariantFailure("The temporary artifact size changed before publication.");
      }
      await temporary.handle.close();
      return {
        path: temporary.path,
        byteLength: bytesWritten,
        contentHash,
      };
    } finally {
      if (!completed) closeIteratorQuietly(iterator);
      await closeQuietly(temporary.handle);
    }
  }

  async #publishObject(
    stored: StoredContent,
    createdAt: string,
  ): Promise<PublishedObject> {
    const hexHash = stored.contentHash.slice("sha256:".length);
    const prefix = hexHash.slice(0, 2);
    const prefixDirectory = join(this.#sha256Directory, prefix);
    await verifyOwnedDirectory(this.#sha256Directory, this.#rootDevice);
    await ensureOwnedDirectory(prefixDirectory, this.#rootDevice);
    await verifyOwnedDirectory(this.#lockDirectory, this.#rootDevice);

    const objectPath = join(prefixDirectory, hexHash);
    const manifestPath = join(prefixDirectory, `${hexHash}.json`);
    const lockPath = join(this.#lockDirectory, `${hexHash}.lock`);
    const lock = await openExclusiveNoFollow(lockPath);

    let createdObject = false;
    try {
      await verifyOwnedFileHandle(lock, this.#rootDevice);
      const known = this.#objects.get(stored.contentHash);
      if (known !== undefined) {
        if (known.byteLength !== stored.byteLength) {
          throw invariantFailure("Stored artifact metadata conflicts with exact content.");
        }
        await this.#verifyObjectRecord(known);
        await unlinkQuietly(stored.path);
        return { record: known, created: false };
      }

      const objectExists = await pathExistsNoFollow(objectPath);
      const manifestExists = await pathExistsNoFollow(manifestPath);
      if (objectExists !== manifestExists) {
        throw invariantFailure("Artifact object data and metadata are incomplete.");
      }
      if (objectExists) {
        const record = await readObjectRecord(manifestPath);
        if (
          record.contentHash !== stored.contentHash ||
          record.byteLength !== stored.byteLength
        ) {
          throw invariantFailure("Existing artifact metadata conflicts with exact content.");
        }
        await this.#verifyObjectRecord(record);
        await unlinkQuietly(stored.path);
        return { record, created: false };
      }

      const record: ObjectRecord = Object.freeze({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        artifactId: ArtifactIdKind.generate(),
        byteLength: stored.byteLength,
        contentHash: stored.contentHash,
        createdAt,
      });
      try {
        await rename(stored.path, objectPath);
        createdObject = true;
        await syncDirectory(prefixDirectory);
        await writeImmutableJson(
          manifestPath,
          record,
          prefixDirectory,
          this.#temporaryDirectory,
          this.#rootDevice,
        );
      } catch (error: unknown) {
        if (createdObject) {
          await unlinkQuietly(objectPath);
          await unlinkQuietly(manifestPath);
          await syncDirectoryQuietly(prefixDirectory);
        }
        throw filesystemFailure(error, "The artifact object could not be published.");
      }
      await this.#verifyObjectRecord(record);
      return { record, created: true };
    } finally {
      await closeQuietly(lock);
      await unlinkQuietly(lockPath);
      await syncDirectoryQuietly(this.#lockDirectory);
      if (!createdObject) await unlinkQuietly(stored.path);
    }
  }

  async #verifyObjectRecord(record: ObjectRecord): Promise<void> {
    const hexHash = record.contentHash.slice("sha256:".length);
    const prefixDirectory = join(this.#sha256Directory, hexHash.slice(0, 2));
    await verifyOwnedDirectory(prefixDirectory, this.#rootDevice);
    const diskRecord = await readObjectRecord(join(prefixDirectory, `${hexHash}.json`));
    if (
      diskRecord.artifactId !== record.artifactId ||
      diskRecord.byteLength !== record.byteLength ||
      diskRecord.contentHash !== record.contentHash ||
      diskRecord.createdAt !== record.createdAt
    ) {
      throw invariantFailure("Artifact object metadata was modified after publication.");
    }
    await readAndVerifyFile({
      path: join(prefixDirectory, hexHash),
      expectedLength: record.byteLength,
      expectedHash: record.contentHash,
      maximumBytes: this.#options.maximumObjectBytes,
      signal: undefined,
    });
  }

  async #publishReference(
    runId: RunId,
    descriptor: ArtifactWriteDescriptor,
    object: ObjectRecord,
    createdAt: string,
  ): Promise<ArtifactReference> {
    await verifyOwnedDirectory(this.#referenceDirectory, this.#rootDevice);
    const runDirectory = join(this.#referenceDirectory, runId);
    await ensureOwnedDirectory(runDirectory, this.#rootDevice);
    const artifactReferenceId = generateArtifactReferenceId();
    const reference: ArtifactReference = Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      artifactReferenceId,
      artifactId: object.artifactId,
      runId,
      byteLength: object.byteLength,
      contentHash: object.contentHash,
      kind: descriptor.kind,
      mediaType: descriptor.mediaType,
      displayName: descriptor.displayName,
      createdAt,
    });
    await writeImmutableJson(
      join(runDirectory, `${artifactReferenceId}.json`),
      reference,
      runDirectory,
      this.#temporaryDirectory,
      this.#rootDevice,
    );
    return reference;
  }

  async #loadAuthorizedReference(
    runId: RunId,
    artifactReferenceId: ArtifactReferenceId,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactReference> {
    throwIfAborted(signal);
    await verifyOwnedDirectory(this.#referenceDirectory, this.#rootDevice);
    const runDirectory = join(this.#referenceDirectory, runId);
    try {
      await verifyOwnedDirectory(runDirectory, this.#rootDevice);
    } catch (error: unknown) {
      if (nodeErrorCode(error) === "ENOENT") {
        throw unavailableReference();
      }
      throw error;
    }
    let reference: ArtifactReference;
    try {
      reference = await readArtifactReference(
        join(runDirectory, `${artifactReferenceId}.json`),
      );
    } catch (error: unknown) {
      if (nodeErrorCode(error) === "ENOENT") {
        throw unavailableReference();
      }
      throw error;
    }
    throwIfAborted(signal);
    if (
      reference.runId !== runId ||
      reference.artifactReferenceId !== artifactReferenceId
    ) {
      throw invariantFailure("Artifact reference ownership metadata is inconsistent.");
    }
    return reference;
  }

  async #readVerifiedObject(
    reference: ArtifactReference,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const hexHash = reference.contentHash.slice("sha256:".length);
    const prefixDirectory = join(this.#sha256Directory, hexHash.slice(0, 2));
    await verifyOwnedDirectory(this.#sha256Directory, this.#rootDevice);
    await verifyOwnedDirectory(prefixDirectory, this.#rootDevice);
    const manifest = await readObjectRecord(join(prefixDirectory, `${hexHash}.json`));
    if (
      manifest.artifactId !== reference.artifactId ||
      manifest.byteLength !== reference.byteLength ||
      manifest.contentHash !== reference.contentHash
    ) {
      throw invariantFailure("Artifact reference and object metadata do not agree.");
    }
    return await readAndVerifyFile({
      path: join(prefixDirectory, hexHash),
      expectedLength: reference.byteLength,
      expectedHash: reference.contentHash,
      maximumBytes: this.#options.maximumObjectBytes,
      signal,
    });
  }

  async #withStateLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#stateTail;
    let release: (() => void) | undefined;
    this.#stateTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function parseOptions(value: unknown): ParsedOptions {
  const options = inspectDataRecord(value, OPTION_KEYS, "artifact-store options");
  const rootDirectory = options["rootDirectory"];
  if (
    typeof rootDirectory !== "string" ||
    rootDirectory.length === 0 ||
    rootDirectory.includes("\0") ||
    !isAbsolute(rootDirectory) ||
    dirname(rootDirectory) === rootDirectory
  ) {
    throw invalidInput("The artifact-store root must be a non-root absolute path.");
  }

  const maximumObjectBytes = parsePositiveLimit(
    options["maximumObjectBytes"],
    DEFAULT_MAXIMUM_ARTIFACT_OBJECT_BYTES,
  );
  const maximumRunBytes = parsePositiveLimit(
    options["maximumRunBytes"],
    DEFAULT_MAXIMUM_ARTIFACT_RUN_BYTES,
  );
  const maximumStoreBytes = parsePositiveLimit(
    options["maximumStoreBytes"],
    DEFAULT_MAXIMUM_ARTIFACT_STORE_BYTES,
  );
  const maximumChunkBytes = parsePositiveLimit(
    options["maximumChunkBytes"],
    DEFAULT_MAXIMUM_ARTIFACT_CHUNK_BYTES,
  );
  const maximumChunks = parsePositiveLimit(
    options["maximumChunks"],
    DEFAULT_MAXIMUM_ARTIFACT_CHUNKS,
  );
  const minimumFreeBytes = parseNonNegativeLimit(
    options["minimumFreeBytes"],
    DEFAULT_MINIMUM_ARTIFACT_FREE_BYTES,
  );
  const now = options["now"] ?? defaultNow;
  if (typeof now !== "function") {
    throw invalidInput("The artifact-store clock must be a function.");
  }

  return Object.freeze({
    rootDirectory,
    maximumObjectBytes,
    maximumRunBytes,
    maximumStoreBytes,
    maximumChunkBytes,
    maximumChunks,
    minimumFreeBytes,
    now: now as () => unknown,
  });
}

function parseWriteDescriptor(value: unknown): ArtifactWriteDescriptor {
  const descriptor = inspectDataRecord(value, DESCRIPTOR_KEYS, "artifact descriptor");
  if (Reflect.ownKeys(descriptor).length !== DESCRIPTOR_KEYS.size) {
    throw invalidInput("The artifact descriptor must contain every required field.");
  }
  const byteLength = descriptor["byteLength"];
  const kind = descriptor["kind"];
  const mediaType = descriptor["mediaType"];
  const displayName = descriptor["displayName"];
  const expected = descriptor["expectedContentHash"];
  if (!isNonNegativeSafeInteger(byteLength)) {
    throw invalidInput("The artifact byte length must be a non-negative safe integer.");
  }
  if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) {
    throw invalidInput("The artifact kind must be a bounded lowercase identifier.");
  }
  if (!isMediaType(mediaType)) {
    throw invalidInput("The artifact media type is invalid or too large.");
  }
  if (!isDisplayName(displayName)) {
    throw invalidInput("The artifact display name is invalid or too large.");
  }
  const expectedContentHash = expected === null
    ? null
    : parseSha256ContentHash(expected);
  return Object.freeze({
    byteLength,
    kind,
    mediaType,
    displayName,
    expectedContentHash,
  });
}

function inspectDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<PropertyKey>,
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    ) {
      throw new TypeError("invalid record");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => !allowedKeys.has(key))) {
      throw new TypeError("unknown record key");
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("symbol record key");
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (
        property === undefined ||
        !("value" in property) ||
        property.enumerable !== true
      ) {
        throw new TypeError("non-data property");
      }
      Object.defineProperty(result, key, {
        value: property.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(result);
  } catch {
    throw invalidInput(`Invalid ${label}.`);
  }
}

function parsePositiveLimit(value: unknown, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || typeof selected !== "number" || selected <= 0) {
    throw invalidInput("Artifact-store limits must be positive safe integers.");
  }
  return selected;
}

function parseNonNegativeLimit(value: unknown, fallback: number): number {
  const selected = value ?? fallback;
  if (!isNonNegativeSafeInteger(selected)) {
    throw invalidInput("Artifact-store free-space limits must be non-negative safe integers.");
  }
  return selected;
}

function validateRunId(value: unknown): asserts value is RunId {
  if (!RunIdKind.is(value)) {
    throw invalidInput("Expected a run identifier.");
  }
}

function generateArtifactReferenceId(): ArtifactReferenceId {
  const artifactId = ArtifactIdKind.generate();
  return `aref_${artifactId.slice(4)}` as ArtifactReferenceId;
}

function readClock(now: () => unknown): string {
  let value: unknown;
  try {
    value = now();
  } catch (error: unknown) {
    throw filesystemFailure(error, "The artifact-store clock failed.");
  }
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw invariantFailure("The artifact-store clock returned an invalid timestamp.");
  }
  return value;
}

function isMediaType(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_MEDIA_TYPE_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1;
}

function isDisplayName(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_DISPLAY_NAME_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function inspectAsyncIterator(value: unknown): AsyncIterator<Uint8Array> {
  try {
    if (
      (typeof value !== "object" && typeof value !== "function") ||
      value === null ||
      isProxy(value)
    ) {
      throw new TypeError("invalid async iterable");
    }
    const method = findDataMethod(value, Symbol.asyncIterator);
    if (method === null) throw new TypeError("missing async iterator");
    const iterator: unknown = method.call(value);
    if (
      (typeof iterator !== "object" && typeof iterator !== "function") ||
      iterator === null ||
      isProxy(iterator) ||
      findDataMethod(iterator, "next") === null
    ) {
      throw new TypeError("invalid async iterator");
    }
    return iterator as AsyncIterator<Uint8Array>;
  } catch {
    throw invalidInput("Artifact content must be a strict async byte iterable.");
  }
}

function findDataMethod(
  value: object | Function,
  key: PropertyKey,
): ((...args: readonly unknown[]) => unknown) | null {
  let candidate: object | null = value;
  for (let depth = 0; candidate !== null && depth < 16; depth += 1) {
    if (isProxy(candidate)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor !== undefined) {
      return "value" in descriptor && typeof descriptor.value === "function"
        ? descriptor.value as (...args: readonly unknown[]) => unknown
        : null;
    }
    candidate = Object.getPrototypeOf(candidate) as object | null;
  }
  return null;
}

function callIteratorNext(iterator: AsyncIterator<Uint8Array>): Promise<unknown> {
  try {
    const method = findDataMethod(iterator as object, "next");
    if (method === null) throw new TypeError("missing iterator next");
    return Promise.resolve(method.call(iterator));
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}

function inspectIteratorResult(value: unknown): {
  readonly done: boolean;
  readonly value: unknown;
} {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new TypeError("invalid iterator result");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => key !== "done" && key !== "value") ||
      !keys.includes("done")
    ) {
      throw new TypeError("invalid iterator result keys");
    }
    const done = Object.getOwnPropertyDescriptor(value, "done");
    const item = Object.getOwnPropertyDescriptor(value, "value");
    if (
      done === undefined ||
      !("value" in done) ||
      typeof done.value !== "boolean" ||
      (item !== undefined && !("value" in item))
    ) {
      throw new TypeError("invalid iterator result properties");
    }
    return { done: done.value, value: item?.value };
  } catch {
    throw invalidInput("The artifact byte stream returned an invalid iterator result.");
  }
}

function copyChunk(value: unknown): Buffer {
  try {
    if (!isUint8Array(value) || isProxy(value)) {
      throw new TypeError("invalid byte chunk");
    }
    return Buffer.from(value);
  } catch {
    throw invalidInput("Artifact streams may contain only Uint8Array chunks.");
  }
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return await promise;
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(cancelledFailure());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Abort can occur after the initial check but before listener registration.
    // Recheck only after the listener is installed so that transition cannot be
    // lost while awaiting a source-controlled promise.
    if (signal.aborted) onAbort();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function closeIteratorQuietly(iterator: AsyncIterator<Uint8Array>): void {
  try {
    const method = findDataMethod(iterator as object, "return");
    if (method !== null) {
      void Promise.resolve(method.call(iterator)).catch(() => undefined);
    }
  } catch {
    // Best-effort source cleanup must not replace the store failure.
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) {
      throw invariantFailure("The artifact temporary file stopped accepting bytes.");
    }
    offset += result.bytesWritten;
  }
}

async function openExclusiveNoFollow(path: string): Promise<FileHandle> {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw infrastructureFailure("This platform does not provide no-follow file opens.");
  }
  try {
    return await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      FILE_MODE,
    );
  } catch (error: unknown) {
    if (nodeErrorCode(error) === "EEXIST") {
      throw conflictFailure("An immutable artifact path already exists.");
    }
    throw filesystemFailure(error, "An exclusive artifact file could not be opened.");
  }
}

async function openReadNoFollow(path: string): Promise<FileHandle> {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw infrastructureFailure("This platform does not provide no-follow file opens.");
  }
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (nodeErrorCode(error) === "ELOOP") {
      throw invariantFailure("An artifact file was replaced by a symbolic link.");
    }
    throw error;
  }
}

async function ensureOwnedDirectory(
  path: string,
  expectedDevice: bigint | number | null,
): Promise<Stats> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== "EEXIST") {
      throw filesystemFailure(error, "An artifact directory could not be created.");
    }
  }
  return await verifyOwnedDirectory(path, expectedDevice);
}

async function verifyOwnedDirectory(
  path: string,
  expectedDevice: bigint | number | null = null,
): Promise<Stats> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error: unknown) {
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw invariantFailure("An artifact directory is not a real directory.");
  }
  verifyOwnerAndMode(stats, DIRECTORY_MODE);
  if (expectedDevice !== null && stats.dev !== expectedDevice) {
    throw invariantFailure("Artifact temporary and final paths are not on one filesystem.");
  }
  return stats;
}

function verifyOwnerAndMode(stats: Stats, expectedMode: number): void {
  const getuid = process.getuid;
  if (typeof getuid !== "function") {
    throw infrastructureFailure("Owner-only artifact storage requires POSIX ownership checks.");
  }
  if (stats.uid !== getuid()) {
    throw invariantFailure("An artifact path is not owned by the current user.");
  }
  if ((stats.mode & 0o077) !== 0 || (stats.mode & 0o700) !== expectedMode) {
    throw invariantFailure("An artifact path is not owner-only.");
  }
}

async function verifyOwnedFileHandle(
  handle: FileHandle,
  expectedDevice: bigint | number | null,
): Promise<void> {
  const stats = await handle.stat();
  verifyOwnedFileStats(stats, expectedDevice);
}

function verifyOwnedFileStats(
  stats: Stats,
  expectedDevice: bigint | number | null,
): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw invariantFailure("An artifact object is not a private regular file.");
  }
  verifyOwnerAndMode(stats, FILE_MODE);
  if (expectedDevice !== null && stats.dev !== expectedDevice) {
    throw invariantFailure("Artifact temporary and final files are not on one filesystem.");
  }
}

async function readAndVerifyFile(input: {
  readonly path: string;
  readonly expectedLength: number;
  readonly expectedHash: Sha256ContentHash;
  readonly maximumBytes: number;
  readonly signal: AbortSignal | undefined;
}): Promise<Buffer> {
  if (
    input.expectedLength > input.maximumBytes ||
    !isNonNegativeSafeInteger(input.expectedLength)
  ) {
    throw invariantFailure("Artifact metadata exceeds the configured read bound.");
  }
  let handle: FileHandle | null = null;
  try {
    handle = await openReadNoFollow(input.path);
    const before = await handle.stat();
    verifyOwnedFileStats(before, null);
    if (before.size !== input.expectedLength) {
      throw invariantFailure("Artifact object length does not match immutable metadata.");
    }
    const bytes = Buffer.allocUnsafe(input.expectedLength);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < bytes.byteLength) {
      throwIfAborted(input.signal);
      const length = Math.min(65_536, bytes.byteLength - offset);
      const result = await handle.read(bytes, offset, length, offset);
      if (result.bytesRead <= 0) {
        throw invariantFailure("Artifact object ended before its immutable length.");
      }
      hash.update(bytes.subarray(offset, offset + result.bytesRead));
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const trailing = await handle.read(extra, 0, 1, offset);
    if (trailing.bytesRead !== 0) {
      throw invariantFailure("Artifact object grew beyond its immutable length.");
    }
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      throw invariantFailure("Artifact object changed during verification.");
    }
    const actualHash = parseSha256ContentHash(`sha256:${hash.digest("hex")}`);
    if (actualHash !== input.expectedHash) {
      throw invariantFailure("Artifact object content does not match immutable metadata.");
    }
    throwIfAborted(input.signal);
    return bytes;
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    if (nodeErrorCode(error) === "ENOENT") {
      throw invariantFailure("An artifact object is missing.");
    }
    throw filesystemFailure(error, "An artifact object could not be read safely.");
  } finally {
    if (handle !== null) await closeQuietly(handle);
  }
}

async function readObjectRecord(path: string): Promise<ObjectRecord> {
  const value = await readJsonNoFollow(path);
  let record: Readonly<Record<string, unknown>>;
  try {
    record = inspectDataRecord(value, OBJECT_RECORD_KEYS, "artifact object metadata");
  } catch {
    throw invariantFailure("Artifact object metadata is invalid.");
  }
  if (Reflect.ownKeys(record).length !== OBJECT_RECORD_KEYS.size) {
    throw invariantFailure("Artifact object metadata is incomplete.");
  }
  const schemaVersion = record["schemaVersion"];
  const artifactId = record["artifactId"];
  const byteLength = record["byteLength"];
  const contentHash = record["contentHash"];
  const createdAt = record["createdAt"];
  if (
    schemaVersion !== CONTRACT_SCHEMA_VERSION ||
    !ArtifactIdKind.is(artifactId) ||
    !isNonNegativeSafeInteger(byteLength) ||
    !isIsoTimestamp(createdAt)
  ) {
    throw invariantFailure("Artifact object metadata is invalid.");
  }
  let parsedHash: Sha256ContentHash;
  try {
    parsedHash = parseSha256ContentHash(contentHash);
  } catch {
    throw invariantFailure("Artifact object metadata contains an invalid hash.");
  }
  return Object.freeze({
    schemaVersion,
    artifactId,
    byteLength,
    contentHash: parsedHash,
    createdAt,
  });
}

async function readArtifactReference(path: string): Promise<ArtifactReference> {
  const value = await readJsonNoFollow(path);
  let record: Readonly<Record<string, unknown>>;
  try {
    record = inspectDataRecord(value, REFERENCE_KEYS, "artifact reference metadata");
  } catch {
    throw invariantFailure("Artifact reference metadata is invalid.");
  }
  if (Reflect.ownKeys(record).length !== REFERENCE_KEYS.size) {
    throw invariantFailure("Artifact reference metadata is incomplete.");
  }
  const schemaVersion = record["schemaVersion"];
  const artifactId = record["artifactId"];
  const runId = record["runId"];
  const byteLength = record["byteLength"];
  const kind = record["kind"];
  const mediaType = record["mediaType"];
  const displayName = record["displayName"];
  const createdAt = record["createdAt"];
  if (
    schemaVersion !== CONTRACT_SCHEMA_VERSION ||
    !ArtifactIdKind.is(artifactId) ||
    !RunIdKind.is(runId) ||
    !isNonNegativeSafeInteger(byteLength) ||
    typeof kind !== "string" ||
    !KIND_PATTERN.test(kind) ||
    !isMediaType(mediaType) ||
    !isDisplayName(displayName) ||
    !isIsoTimestamp(createdAt)
  ) {
    throw invariantFailure("Artifact reference metadata is invalid.");
  }
  let artifactReferenceId: ArtifactReferenceId;
  let contentHash: Sha256ContentHash;
  try {
    artifactReferenceId = parseArtifactReferenceId(record["artifactReferenceId"]);
    contentHash = parseSha256ContentHash(record["contentHash"]);
  } catch {
    throw invariantFailure("Artifact reference metadata contains an invalid identifier.");
  }
  return Object.freeze({
    schemaVersion,
    artifactReferenceId,
    artifactId,
    runId,
    byteLength,
    contentHash,
    kind,
    mediaType,
    displayName,
    createdAt,
  });
}

async function readJsonNoFollow(path: string): Promise<unknown> {
  let handle: FileHandle | null = null;
  try {
    handle = await openReadNoFollow(path);
    const stats = await handle.stat();
    verifyOwnedFileStats(stats, null);
    if (stats.size > MAXIMUM_METADATA_BYTES) {
      throw invariantFailure("Artifact metadata exceeds its byte ceiling.");
    }
    const bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead <= 0) {
        throw invariantFailure("Artifact metadata ended before its recorded length.");
      }
      offset += result.bytesRead;
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      throw invariantFailure("Artifact metadata is not exact UTF-8.");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw invariantFailure("Artifact metadata is not valid JSON.");
    }
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw error;
  } finally {
    if (handle !== null) await closeQuietly(handle);
  }
}

async function writeImmutableJson(
  destination: string,
  value: object,
  parentDirectory: string,
  temporaryDirectory: string,
  expectedDevice: bigint | number | null,
): Promise<void> {
  if (await pathExistsNoFollow(destination)) {
    throw conflictFailure("Immutable artifact metadata already exists.");
  }
  await verifyOwnedDirectory(parentDirectory, expectedDevice);
  await verifyOwnedDirectory(temporaryDirectory, expectedDevice);
  const temporary = join(temporaryDirectory, `${randomUUID()}.metadata.part`);
  let handle: FileHandle | null = null;
  try {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    if (bytes.byteLength > MAXIMUM_METADATA_BYTES) {
      throw invariantFailure("Artifact metadata exceeds its byte ceiling.");
    }
    handle = await openExclusiveNoFollow(temporary);
    await verifyOwnedFileHandle(handle, expectedDevice);
    await writeAll(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
    await syncDirectory(parentDirectory);
  } catch (error: unknown) {
    if (handle !== null) await closeQuietly(handle);
    await unlinkQuietly(temporary);
    if (isDomainError(error)) throw error;
    throw filesystemFailure(error, "Immutable artifact metadata could not be written.");
  }
}

async function pathExistsNoFollow(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw filesystemFailure(error, "An artifact path could not be inspected.");
  }
}

async function readDirectoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error: unknown) {
    throw filesystemFailure(error, "An artifact directory could not be inspected.");
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error: unknown) {
    const code = nodeErrorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw filesystemFailure(error, "An artifact directory could not be synchronized.");
    }
  } finally {
    if (handle !== null) await closeQuietly(handle);
  }
}

async function syncDirectoryQuietly(path: string): Promise<void> {
  try {
    await syncDirectory(path);
  } catch {
    // Cleanup durability is best effort after the primary operation failed.
  }
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // A previous close or failure must not mask the primary result.
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== "ENOENT") {
      // Cleanup remains best effort. Store-owned roots are revalidated later.
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledFailure();
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function addSafe(left: number, right: number, message: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw invariantFailure(message);
  }
  return result;
}

function nodeErrorCode(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string"
  ) {
    return value.code;
  }
  return null;
}

function normalizeOperationalFailure(error: unknown): DomainError {
  if (isDomainError(error)) return error;
  return infrastructureFailure("The artifact-store operation failed safely.");
}

function filesystemFailure(error: unknown, message: string): DomainError {
  if (isDomainError(error)) return error;
  return createDomainError({
    code: "infrastructure_failed",
    message,
  });
}

function invalidInput(message: string): DomainError {
  return createDomainError({ code: "invalid_input", message });
}

function unavailableReference(): DomainError {
  return invalidInput("The artifact reference is unavailable for this run.");
}

function budgetFailure(message: string): DomainError {
  return createDomainError({ code: "budget_exceeded", message });
}

function conflictFailure(message: string): DomainError {
  return createDomainError({ code: "conflict", message });
}

function cancelledFailure(): DomainError {
  return createDomainError({
    code: "cancelled",
    message: "The artifact-store operation was cancelled.",
  });
}

function invariantFailure(message: string): DomainError {
  return createDomainError({ code: "invariant_violated", message });
}

function infrastructureFailure(message: string): DomainError {
  return createDomainError({ code: "infrastructure_failed", message });
}
