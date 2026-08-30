import {
  canonicalSha256Hex,
  createDomainError,
  sha256Hex,
} from "@guard/contracts";

import { snapshotBoundaryObject } from "./boundary.js";
import { normalizeRepositoryPath } from "./repository-path.js";

export interface VirtualRepositoryLimits {
  readonly maximumFiles: number;
  readonly maximumFileBytes: number;
}

/** Immutable repository-shaped fixture with no filesystem or process access. */
export class VirtualRepository {
  readonly #files: ReadonlyMap<string, string>;
  readonly #paths: readonly string[];
  readonly snapshotHash: string;

  constructor(
    files: Readonly<Record<string, string>>,
    limits: VirtualRepositoryLimits,
  ) {
    const detachedFiles = snapshotBoundaryObject(
      files,
      "Virtual repository files",
    );
    const detachedLimits = parseLimits(
      snapshotBoundaryObject(limits, "Virtual repository limits"),
    );
    const entries = Object.entries(detachedFiles);
    if (entries.length > detachedLimits.maximumFiles) {
      throw invalidInput("Virtual repository exceeds its configured file-count bound.");
    }

    const stored = new Map<string, string>();
    for (const [rawPath, content] of entries) {
      const path = normalizeRepositoryPath(rawPath, { allowRoot: false });
      if (stored.has(path)) {
        throw createDomainError({
          code: "conflict",
          message: "Two virtual files normalize to the same repository path.",
          details: { path },
        });
      }
      if (typeof content !== "string") {
        throw invalidInput("Virtual repository file content must be UTF-8 text.");
      }
      const byteLength = Buffer.byteLength(content, "utf8");
      if (byteLength > detachedLimits.maximumFileBytes) {
        throw invalidInput("A virtual repository file exceeds its byte bound.", {
          maximumFileBytes: detachedLimits.maximumFileBytes,
          path,
          byteLength,
        });
      }
      stored.set(path, content);
    }

    this.#files = stored;
    this.#paths = Object.freeze([...stored.keys()].sort());
    this.snapshotHash = canonicalSha256Hex(Object.fromEntries(stored));
    Object.freeze(this);
  }

  list(root = ""): readonly string[] {
    const canonicalRoot = normalizeRepositoryPath(root, { allowRoot: true });
    const prefix = canonicalRoot.length === 0 ? "" : `${canonicalRoot}/`;
    return Object.freeze(
      this.#paths.filter(
        (path) =>
          canonicalRoot.length === 0 || path === canonicalRoot || path.startsWith(prefix),
      ),
    );
  }

  read(path: string): string {
    const canonical = normalizeRepositoryPath(path, { allowRoot: false });
    const content = this.#files.get(canonical);
    if (content === undefined) {
      throw invalidInput("The requested virtual repository file does not exist.", {
        path: canonical,
      });
    }
    return content;
  }

  contentHash(path: string): string {
    return sha256Hex(this.read(path));
  }
}

function parseLimits(
  limits: Readonly<Record<string, unknown>>,
): VirtualRepositoryLimits {
  const keys = Object.keys(limits);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(limits, "maximumFiles") ||
    !Object.hasOwn(limits, "maximumFileBytes")
  ) {
    throw invalidInput("Virtual repository limits contain unknown or missing fields.");
  }
  for (const [field, value] of Object.entries(limits)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw invalidInput(`${field} must be a positive safe integer.`);
    }
  }
  return Object.freeze({
    maximumFiles: limits["maximumFiles"] as number,
    maximumFileBytes: limits["maximumFileBytes"] as number,
  });
}

function invalidInput(
  message: string,
  details?: Readonly<Record<string, unknown>>,
) {
  return createDomainError({
    code: "invalid_input",
    message,
    ...(details === undefined ? {} : { details }),
  });
}
