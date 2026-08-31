import { createDomainError } from "@guard/contracts";
import { isProxy } from "node:util/types";

export const ROBIN_APPLICATION_COMMAND_SCHEMA_VERSION = 1 as const;
export const MAXIMUM_APPLICATION_MESSAGE_BYTES = 65_536;
export const MAXIMUM_APPLICATION_IDENTIFIER_BYTES = 256;

interface CommandBase {
  readonly schemaVersion: typeof ROBIN_APPLICATION_COMMAND_SCHEMA_VERSION;
  readonly sessionId: string;
}

export type RobinApplicationCommand = CommandBase &
  (
    | {
        readonly type: "start_session";
        readonly permissionMode: "ask" | "plan";
        readonly providerProfile: "synthetic";
        readonly modelId: string;
        readonly maximumTurns: number;
      }
    | {
        readonly type: "submit_message";
        readonly commandId: string;
        readonly text: string;
      }
    | {
        readonly type: "cancel_turn";
        readonly reason: "user_interrupt" | "session_close" | "shutdown";
      }
    | { readonly type: "close_session" }
    | {
        readonly type: "set_permission_mode";
        readonly permissionMode: "ask" | "plan";
      }
  );

export function parseRobinApplicationCommand(
  value: unknown,
): RobinApplicationCommand {
  const record = plainRecord(value, "Application command");
  if (record["schemaVersion"] !== ROBIN_APPLICATION_COMMAND_SCHEMA_VERSION) {
    invalid("Application command schemaVersion must be 1.");
  }
  const sessionId = identifier(record["sessionId"], "sessionId");
  const type = record["type"];
  switch (type) {
    case "start_session":
      exactKeys(record, [
        "schemaVersion",
        "type",
        "sessionId",
        "permissionMode",
        "providerProfile",
        "modelId",
        "maximumTurns",
      ]);
      if (record["providerProfile"] !== "synthetic") {
        invalid("R1 supports only the synthetic provider profile.");
      }
      if (
        !Number.isSafeInteger(record["maximumTurns"]) ||
        (record["maximumTurns"] as number) < 1 ||
        (record["maximumTurns"] as number) > 256
      ) {
        invalid("maximumTurns must be an integer from 1 through 256.");
      }
      return Object.freeze({
        schemaVersion: 1,
        type,
        sessionId,
        permissionMode: permissionMode(record["permissionMode"]),
        providerProfile: "synthetic",
        modelId: identifier(record["modelId"], "modelId"),
        maximumTurns: record["maximumTurns"] as number,
      });
    case "submit_message":
      exactKeys(record, [
        "schemaVersion",
        "type",
        "sessionId",
        "commandId",
        "text",
      ]);
      return Object.freeze({
        schemaVersion: 1,
        type,
        sessionId,
        commandId: identifier(record["commandId"], "commandId"),
        text: boundedText(record["text"], "message text"),
      });
    case "cancel_turn":
      exactKeys(record, ["schemaVersion", "type", "sessionId", "reason"]);
      if (
        record["reason"] !== "user_interrupt" &&
        record["reason"] !== "session_close" &&
        record["reason"] !== "shutdown"
      ) {
        invalid("The cancellation reason is unsupported.");
      }
      return Object.freeze({
        schemaVersion: 1,
        type,
        sessionId,
        reason: record["reason"],
      });
    case "close_session":
      exactKeys(record, ["schemaVersion", "type", "sessionId"]);
      return Object.freeze({ schemaVersion: 1, type, sessionId });
    case "set_permission_mode":
      exactKeys(record, [
        "schemaVersion",
        "type",
        "sessionId",
        "permissionMode",
      ]);
      return Object.freeze({
        schemaVersion: 1,
        type,
        sessionId,
        permissionMode: permissionMode(record["permissionMode"]),
      });
    default:
      invalid("The application command type is unknown.");
  }
}

function plainRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid(`${label} must be a plain object.`);
  }
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid(`${label} has an invalid property.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      invalid(`${label} has an unsafe property.`);
    }
    captured[key] = descriptor.value;
  }
  return Object.freeze(captured);
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const keys = Object.keys(record);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key))
  ) {
    invalid("Application command has unknown or missing properties.");
  }
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_APPLICATION_IDENTIFIER_BYTES
  ) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_APPLICATION_MESSAGE_BYTES
  ) {
    invalid(`${label} is empty or exceeds its byte bound.`);
  }
  return value;
}

function permissionMode(value: unknown): "ask" | "plan" {
  if (value !== "ask" && value !== "plan") {
    invalid("permissionMode must be ask or plan.");
  }
  return value;
}

function invalid(message: string): never {
  throw createDomainError({ code: "invalid_input", message });
}
