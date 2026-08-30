const ENCODER = new TextEncoder();

/** Locale-free bytewise UTF-8 ordering for security-sensitive canonical order. */
export function compareUtf8(left: string, right: string): number {
  const leftBytes = ENCODER.encode(left);
  const rightBytes = ENCODER.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
