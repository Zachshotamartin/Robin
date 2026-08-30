import { createDomainError } from "@guard/contracts";

export type MediaPreflight =
  | { readonly supported: true; readonly normalizedMediaType: string }
  | {
      readonly supported: false;
      readonly normalizedMediaType: string;
      readonly reason: "unsupported_media";
    };

export type TextDecodeResult =
  | { readonly accepted: true; readonly text: string }
  | {
      readonly accepted: false;
      readonly reason: "binary_nul" | "invalid_utf8" | "excessive_controls" | "invalid_json";
    };

const EXACT_TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-sh",
  "application/x-toml",
  "application/x-yaml",
  "application/yaml",
  "image/svg+xml",
]);

export function preflightTextMediaType(
  mediaType: string,
  additionalReviewedTextMediaTypes: ReadonlySet<string> = new Set(),
): MediaPreflight {
  const normalized = normalizeMediaType(mediaType);
  const supported =
    normalized.startsWith("text/") ||
    normalized.endsWith("+json") ||
    normalized.endsWith("+xml") ||
    EXACT_TEXT_MEDIA_TYPES.has(normalized) ||
    additionalReviewedTextMediaTypes.has(normalized);
  return supported
    ? Object.freeze({ supported: true, normalizedMediaType: normalized })
    : Object.freeze({
        supported: false,
        normalizedMediaType: normalized,
        reason: "unsupported_media" as const,
      });
}

export function decodeConservativeUtf8(
  bytes: Uint8Array,
  mediaType: string,
  maximumControlCharacterRatio: number,
): TextDecodeResult {
  if (
    !Number.isFinite(maximumControlCharacterRatio) ||
    maximumControlCharacterRatio < 0 ||
    maximumControlCharacterRatio > 1
  ) {
    throw new TypeError("Control-character ratio must be between zero and one.");
  }
  if (bytes.includes(0)) {
    return Object.freeze({ accepted: false, reason: "binary_nul" as const });
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return Object.freeze({ accepted: false, reason: "invalid_utf8" as const });
  }
  const codePoints = [...text];
  const controls = codePoints.reduce(
    (count, character) => count + (isDisallowedControl(character) ? 1 : 0),
    0,
  );
  if (
    codePoints.length > 0 &&
    controls / codePoints.length > maximumControlCharacterRatio
  ) {
    return Object.freeze({ accepted: false, reason: "excessive_controls" as const });
  }

  const normalizedMediaType = normalizeMediaType(mediaType);
  if (
    normalizedMediaType === "application/json" ||
    normalizedMediaType.endsWith("+json")
  ) {
    try {
      JSON.parse(text);
    } catch {
      return Object.freeze({ accepted: false, reason: "invalid_json" as const });
    }
  }
  return Object.freeze({ accepted: true, text });
}

export function normalizeMediaType(mediaType: string): string {
  if (typeof mediaType !== "string" || mediaType.trim().length === 0) {
    throw createDomainError({
      code: "invalid_input",
      message: "A context media type must be a non-empty string.",
    });
  }
  const [essence, ...parameters] = mediaType.split(";");
  if (essence === undefined || essence.trim().length === 0) {
    throw createDomainError({
      code: "invalid_input",
      message: "A context media type is malformed.",
    });
  }
  const normalized = essence.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)) {
    throw createDomainError({
      code: "invalid_input",
      message: "A context media type is malformed.",
    });
  }
  for (const parameter of parameters) {
    if (parameter.trim().length === 0) {
      throw createDomainError({
        code: "invalid_input",
        message: "A context media type contains an empty parameter.",
      });
    }
  }
  return normalized;
}

function isDisallowedControl(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    (codePoint >= 0 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    codePoint === 127
  );
}
