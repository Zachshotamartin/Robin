export const MAXIMUM_PROVIDER_CALL_ID_BYTES = 256 as const;

/**
 * Provider call identifiers are opaque correlation values, not Robin
 * identifiers. Preserve printable Unicode and spaces exactly while rejecting
 * empty, oversized, control-bearing, or malformed UTF-16 values.
 */
export function isValidProviderCallId(
  value: unknown,
  maximumBytes: number = MAXIMUM_PROVIDER_CALL_ID_BYTES,
): value is string {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    containsUnsafeText(value)
  ) {
    return false;
  }
  return true;
}

function containsUnsafeText(value: string): boolean {
  if (containsUnpairedSurrogate(value)) return true;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        following < 0xdc00 ||
        following > 0xdfff
      ) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
