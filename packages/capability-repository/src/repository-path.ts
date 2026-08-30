import { isProxy } from "node:util/types";

import { createDomainError } from "@guard/contracts";

const MAXIMUM_PATH_BYTES = 4_096;
const MAXIMUM_SEGMENT_BYTES = 255;
const WINDOWS_RESERVED_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/** Canonical portable forward-slash path for every repository boundary. */
export function normalizeRepositoryPath(
  value: unknown,
  options: { readonly allowRoot: boolean },
): string {
  const allowRoot = parseAllowRoot(options);
  if (typeof value !== "string") {
    throw invalidPath("Repository paths must be strings.");
  }
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES) {
    throw invalidPath("Repository path exceeds the configured byte bound.");
  }
  if (value.length === 0) {
    if (allowRoot) return "";
    throw invalidPath("A file path must not be empty.");
  }
  if (
    !isWellFormedUnicode(value) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    /[<>:"|?*%\\]/u.test(value) ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/u.test(value)
  ) {
    throw invalidPath("Repository path uses an absolute, encoded, or unsupported form.");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > MAXIMUM_SEGMENT_BYTES,
    )
  ) {
    throw invalidPath(
      "Repository path contains an empty, dot, traversal, or oversized segment.",
    );
  }
  const canonicalSegments = segments.map((segment) => segment.normalize("NFC"));
  if (
    canonicalSegments.some(
      (segment) =>
        Buffer.byteLength(segment, "utf8") > MAXIMUM_SEGMENT_BYTES ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED_SEGMENT.test(segment),
    )
  ) {
    throw invalidPath("Repository path uses a non-portable reserved segment.");
  }
  const canonical = canonicalSegments.join("/");
  if (Buffer.byteLength(canonical, "utf8") > MAXIMUM_PATH_BYTES) {
    throw invalidPath("Canonical repository path exceeds the configured byte bound.");
  }
  if (canonical === "." || canonical === "..") {
    throw invalidPath("Repository path is not relative to the fixture root.");
  }
  return canonical;
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

function parseAllowRoot(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidPath("Repository path options must be a plain data object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== 1 ||
    !Object.hasOwn(descriptors, "allowRoot")
  ) {
    throw invalidPath("Repository path options contain unknown or missing fields.");
  }
  const descriptor = descriptors["allowRoot"];
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "boolean" ||
    !descriptor.enumerable
  ) {
    throw invalidPath("Repository path allowRoot must be a boolean data property.");
  }
  return descriptor.value;
}

function invalidPath(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
