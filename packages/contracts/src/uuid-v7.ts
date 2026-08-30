import { v7 as uuidv7 } from "uuid";

export const LOWERCASE_UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function generateUuidV7(): string {
  return uuidv7();
}

export function isLowercaseUuidV7(value: unknown): value is string {
  return typeof value === "string" && LOWERCASE_UUID_V7_PATTERN.test(value);
}
