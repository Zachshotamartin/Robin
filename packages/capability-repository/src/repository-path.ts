import { createDomainError } from "@guard/contracts";

const MAXIMUM_PATH_BYTES = 4_096;

/** Canonical forward-slash repository-relative path for virtual fixtures. */
export function normalizeRepositoryPath(
  value: unknown,
  options: { readonly allowRoot: boolean },
): string {
  if (typeof value !== "string") {
    throw invalidPath("Repository paths must be strings.");
  }
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES) {
    throw invalidPath("Repository path exceeds the configured byte bound.");
  }
  if (value.length === 0) {
    if (options.allowRoot) return "";
    throw invalidPath("A file path must not be empty.");
  }
  if (
    value.includes("\u0000") ||
    value.includes("\\") ||
    value.includes("%") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/u.test(value)
  ) {
    throw invalidPath("Repository path uses an absolute, encoded, or unsupported form.");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw invalidPath("Repository path contains an empty, dot, or traversal segment.");
  }
  const canonical = segments.map((segment) => segment.normalize("NFC")).join("/");
  if (canonical === "." || canonical === "..") {
    throw invalidPath("Repository path is not relative to the fixture root.");
  }
  return canonical;
}

function invalidPath(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
