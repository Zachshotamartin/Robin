import assert from "node:assert/strict";
import test from "node:test";

import { ActionIdKind, canonicalize, isDomainError } from "@guard/contracts";

import { CapabilityGateway, CapabilityPackRegistry } from "@guard/capability-gateway";

import {
  SYNTHETIC_TASK_PROFILE,
  SYNTHETIC_TRANSFORM_REFERENCE,
  createSyntheticContextSource,
  createSyntheticTransformPack,
} from "./index.js";

const ACTION_ID = ActionIdKind.parse(
  "act_018f05a0-7b01-7000-8000-000000000081",
);

function isDomainCode(error: unknown, code: string): boolean {
  return isDomainError(error) && error.code === code;
}

test("exports an immutable non-coding profile that composes only generic bindings", () => {
  const serialized = canonicalize(SYNTHETIC_TASK_PROFILE);

  assert.equal(SYNTHETIC_TASK_PROFILE.profileId, "synthetic-transform");
  assert.equal(SYNTHETIC_TASK_PROFILE.driverProfile.componentId, "scripted");
  assert.equal(SYNTHETIC_TASK_PROFILE.modelBindings.length, 0);
  assert.equal(SYNTHETIC_TASK_PROFILE.contextSources.length, 1);
  assert.equal(SYNTHETIC_TASK_PROFILE.capabilityPacks.length, 1);
  assert.equal(Object.isFrozen(SYNTHETIC_TASK_PROFILE), true);
  assert.equal(Object.isFrozen(SYNTHETIC_TASK_PROFILE.capabilityPacks), true);
  assert.doesNotMatch(serialized, /\b(?:git|repository|patch|process)\b/iu);
});

test("provides a bounded in-memory source fixture through the generic source port", async () => {
  const source = createSyntheticContextSource();
  const request = source.normalizeRequest({ recordId: "greeting" });
  const result = await source.readBounded(
    request,
    { maximumItems: 1, maximumBytes: 256 },
    new AbortController().signal,
  );

  assert.deepEqual(result.items[0]!.value, {
    text: "  Guarded agents transform bounded data.  ",
  });
  assert.equal(result.items[0]!.resource.scheme, "memory");
  assert.equal(result.items[0]!.resource.classification, "synthetic");
});

test("normalizes and executes a deterministic transform through the generic gateway", async () => {
  const registry = new CapabilityPackRegistry([createSyntheticTransformPack()]);
  const gateway = new CapabilityGateway(registry);
  const advertisement = registry.createAdvertisement([
    SYNTHETIC_TRANSFORM_REFERENCE,
  ]);
  const prepared = await gateway.normalize(
    {
      schemaVersion: 1,
      ...SYNTHETIC_TRANSFORM_REFERENCE,
      input: { text: "  Cafe\u0301  ", mode: "uppercase" },
    },
    {
      actionId: ACTION_ID,
      subject: { kind: "scripted", driverId: "driver:synthetic" },
      environment: { profileId: "synthetic-transform", sandboxed: false },
    },
    advertisement,
  );
  const result = await gateway.execute(prepared, {
    signal: new AbortController().signal,
  });

  assert.deepEqual(prepared.action.normalizedInput, {
    mode: "uppercase",
    text: "Café",
  });
  assert.deepEqual(result.raw, {
    inputBytes: 5,
    outputBytes: 5,
    transformed: "CAFÉ",
  });
  assert.deepEqual(result.audit, {
    inputBytes: 5,
    mode: "uppercase",
    outputBytes: 5,
  });
  assert.deepEqual(result.human, { summary: "Transformed 5 bytes into 5 bytes." });
  assert.deepEqual(result.agent, { transformed: "CAFÉ" });
});

test("applies handwritten semantic bounds after schema validation", async () => {
  const registry = new CapabilityPackRegistry([createSyntheticTransformPack()]);
  const gateway = new CapabilityGateway(registry);
  const advertisement = registry.createAdvertisement([
    SYNTHETIC_TRANSFORM_REFERENCE,
  ]);

  await assert.rejects(
    gateway.normalize(
      {
        schemaVersion: 1,
        ...SYNTHETIC_TRANSFORM_REFERENCE,
        input: { text: "x".repeat(257), mode: "lowercase" },
      },
      {
        actionId: ACTION_ID,
        subject: { kind: "scripted" },
        environment: { profileId: "synthetic-transform" },
      },
      advertisement,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  await assert.rejects(
    gateway.normalize(
      {
        schemaVersion: 1,
        ...SYNTHETIC_TRANSFORM_REFERENCE,
        // U+0149 uppercases to U+02BC plus N, increasing UTF-8 byte length.
        input: { text: "\u0149".repeat(86), mode: "uppercase" },
      },
      {
        actionId: ACTION_ID,
        subject: { kind: "scripted" },
        environment: { profileId: "synthetic-transform" },
      },
      advertisement,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  await assert.rejects(
    gateway.normalize(
      {
        schemaVersion: 1,
        ...SYNTHETIC_TRANSFORM_REFERENCE,
        input: { text: "valid", mode: "uppercase", hidden: true },
      },
      {
        actionId: ACTION_ID,
        subject: { kind: "scripted" },
        environment: { profileId: "synthetic-transform" },
      },
      advertisement,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );
});
