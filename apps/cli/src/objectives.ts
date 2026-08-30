import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { CliUsageError, type CliProfile } from "./argv.js";

export const MAXIMUM_OBJECTIVE_BYTES = 65_536;
const MAXIMUM_OBJECTIVE_DEPTH = 32;
const MAXIMUM_OBJECTIVE_NODES = 4_096;

const SYNTHETIC_OBJECTIVE = immutable({
  schemaVersion: 1,
  profileId: "synthetic-transform",
  profileVersion: 1,
  objectiveType: "synthetic.transform",
  objectiveTypeVersion: 1,
  payload: { recordId: "greeting", mode: "uppercase" },
  submittedBy: { kind: "user", id: "milestone-a-fixture" },
  submittedAt: "2026-01-02T03:04:05.000Z",
});

const CODING_OBJECTIVE = immutable({
  schemaVersion: 1,
  profileId: "coding-virtual-fixture",
  profileVersion: 1,
  objectiveType: "coding.virtual.change",
  objectiveTypeVersion: 1,
  payload: {
    path: "src/greet.ts",
    instruction: "Capitalize the greeting and add conventional punctuation.",
  },
  submittedBy: { kind: "user", id: "milestone-a-fixture" },
  submittedAt: "2026-01-02T03:04:05.000Z",
});

const EXPECTED_OBJECTIVES = Object.freeze({
  "synthetic-demo": SYNTHETIC_OBJECTIVE,
  "coding-virtual": CODING_OBJECTIVE,
});

/** Reads at most MAXIMUM_OBJECTIVE_BYTES from one already-opened regular file. */
export async function readObjectiveFile(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new CliUsageError("The objective path must identify a regular file.");
    }
    if (metadata.size > MAXIMUM_OBJECTIVE_BYTES) {
      throw new CliUsageError(
        `The objective file exceeds ${String(MAXIMUM_OBJECTIVE_BYTES)} bytes.`,
      );
    }

    const bytes = Buffer.alloc(MAXIMUM_OBJECTIVE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = await handle.read(
        bytes,
        length,
        bytes.byteLength - length,
        null,
      );
      length += read.bytesRead;
      if (length > MAXIMUM_OBJECTIVE_BYTES) {
        throw new CliUsageError(
          `The objective file exceeds ${String(MAXIMUM_OBJECTIVE_BYTES)} bytes.`,
        );
      }
      if (read.bytesRead === 0) break;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      throw new CliUsageError("The objective file must contain valid UTF-8.");
    }
    return parseObjectiveJson(text);
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("Unable to read the objective file.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Parses bounded JSON and returns a descriptor-only, deeply frozen object. */
export function parseObjectiveJson(text: string): Readonly<Record<string, unknown>> {
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_OBJECTIVE_BYTES) {
    throw new CliUsageError(
      `The inline objective exceeds ${String(MAXIMUM_OBJECTIVE_BYTES)} bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new CliUsageError("The objective must be valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new CliUsageError("The objective must be a JSON object.");
  }
  validateAndFreezeJson(parsed);
  return parsed;
}

/**
 * Milestone A scenarios are golden fixtures, not configurable production
 * runners. An override is accepted only when it equals the selected fixture's
 * full envelope or payload shorthand, so the CLI never claims to run input the
 * scenario entrypoint would ignore.
 */
export function validateFixtureObjective(
  profile: CliProfile,
  candidate: unknown,
): void {
  try {
    if (!isRecord(candidate)) {
      throw new CliUsageError("The objective must be a JSON object.");
    }
    const expected = EXPECTED_OBJECTIVES[profile];
    const profileDescriptor = Object.getOwnPropertyDescriptor(candidate, "profileId");
    if (
      profileDescriptor !== undefined &&
      ("get" in profileDescriptor || "set" in profileDescriptor)
    ) {
      throw new CliUsageError("The objective must contain data properties only.");
    }
    if (
      profileDescriptor !== undefined &&
      profileDescriptor.value !== expected.profileId
    ) {
      throw new CliUsageError("The objective profile does not match --profile.");
    }
    if (
      !isDeepStrictEqual(candidate, expected) &&
      !isDeepStrictEqual(candidate, expected.payload)
    ) {
      throw new CliUsageError(
        "The objective must exactly match the selected Milestone A fixture or its payload shorthand.",
      );
    }
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("The objective must be a descriptor-only JSON object.");
  }
}

export function fixtureObjective(profile: CliProfile): Readonly<Record<string, unknown>> {
  return EXPECTED_OBJECTIVES[profile];
}

function validateAndFreezeJson(root: Record<string, unknown>): void {
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAXIMUM_OBJECTIVE_NODES) {
      throw new CliUsageError("The objective contains too many JSON values.");
    }
    if (current.depth > MAXIMUM_OBJECTIVE_DEPTH) {
      throw new CliUsageError("The objective is nested too deeply.");
    }

    const value = current.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new CliUsageError("The objective contains a non-finite number.");
      }
      continue;
    }
    if (typeof value !== "object") {
      throw new CliUsageError("The objective contains a non-JSON value.");
    }

    const prototype = Object.getPrototypeOf(value);
    const expectedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
    if (prototype !== expectedPrototype && prototype !== null) {
      throw new CliUsageError("The objective contains an unsupported object prototype.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor)) {
        throw new CliUsageError("The objective must contain data properties only.");
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
    Object.freeze(value);
  }
}

function immutable<T extends Record<string, unknown>>(value: T): Readonly<T> {
  validateAndFreezeJson(value);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
