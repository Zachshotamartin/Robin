import assert from "node:assert/strict";
import test from "node:test";

import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

import {
  canonicalBytes,
  isDomainError,
  type DomainError,
  type JsonObject,
  type VersionedSchema,
} from "@guard/contracts";

import {
  compileTrustedJsonObjectSchema,
  type TrustedSchemaValidationLimits,
} from "./index.js";

const BASE_SCHEMA: VersionedSchema = {
  schemaId: "schema:test-object",
  schemaVersion: 1,
  document: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string" },
      count: { type: "integer", default: 7 },
      nested: {
        type: "object",
        additionalProperties: false,
        required: ["enabled"],
        properties: { enabled: { type: "boolean" } },
      },
    },
  },
};

function limits(overrides: Partial<TrustedSchemaValidationLimits> = {}) {
  return {
    maxSchemaBytes: canonicalBytes(BASE_SCHEMA).byteLength,
    maxValueBytes: 1_024,
    ...overrides,
  };
}

function captureDomainError(
  operation: () => unknown,
  code: "invalid_input" | "invariant_violated" = "invalid_input",
): DomainError {
  let captured: DomainError | undefined;
  assert.throws(operation, (error: unknown) => {
    if (isDomainError(error) && error.code === code) {
      captured = error;
      return true;
    }
    return false;
  });
  if (captured === undefined) {
    assert.fail("Expected a DomainError to be captured.");
  }
  return captured;
}

test("compiles a trusted schema into an immutable detached validator", () => {
  const sourceSchema = structuredClone(BASE_SCHEMA);
  const compiled = compileTrustedJsonObjectSchema(sourceSchema, limits());
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.validate), true);
  assert.equal(compiled.schemaId, BASE_SCHEMA.schemaId);
  assert.equal(compiled.schemaVersion, BASE_SCHEMA.schemaVersion);
  assert.equal(compiled.maxValueBytes, 1_024);

  const source = { name: "alpha", nested: { enabled: true } };
  const validated = compiled.validate(source);
  assert.deepEqual(validated, source);
  assert.notStrictEqual(validated, source);
  assert.notStrictEqual(validated["nested"], source.nested);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated["nested"]), true);

  source.name = "mutated";
  source.nested.enabled = false;
  assert.equal(validated["name"], "alpha");
  assert.deepEqual(validated["nested"], { enabled: true });

  const document = sourceSchema.document as Record<string, unknown>;
  document["type"] = "string";
  assert.deepEqual(compiled.validate({ name: "still-valid" }), {
    name: "still-valid",
  });
});

test("strict startup compilation rejects invalid, async, remote, and formatted schemas", () => {
  const documents: readonly JsonObject[] = [
    { type: "object", unreviewedKeyword: true },
    { $async: true, type: "object" },
    { $ref: "https://schemas.invalid/remote.json" },
    {
      type: "object",
      properties: { email: { type: "string", format: "email" } },
    },
  ];
  for (const document of documents) {
    const schema = { ...BASE_SCHEMA, document };
    const error = captureDomainError(() =>
      compileTrustedJsonObjectSchema(schema, {
        maxSchemaBytes: canonicalBytes(schema).byteLength,
        maxValueBytes: 1_024,
      }),
    );
    assert.equal(error.details?.["reason"], "invalid_schema");
  }
});

test("schema and value byte limits are positive, exact, and checked canonically", () => {
  const schemaBytes = canonicalBytes(BASE_SCHEMA).byteLength;
  assert.doesNotThrow(() =>
    compileTrustedJsonObjectSchema(BASE_SCHEMA, {
      maxSchemaBytes: schemaBytes,
      maxValueBytes: 1,
    }),
  );
  const schemaLimit = captureDomainError(() =>
    compileTrustedJsonObjectSchema(BASE_SCHEMA, {
      maxSchemaBytes: schemaBytes - 1,
      maxValueBytes: 1,
    }),
  );
  assert.equal(schemaLimit.details?.["reason"], "schema_byte_limit");

  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    captureDomainError(() =>
      compileTrustedJsonObjectSchema(BASE_SCHEMA, {
        maxSchemaBytes: invalid,
        maxValueBytes: 1,
      }),
    );
    captureDomainError(() =>
      compileTrustedJsonObjectSchema(BASE_SCHEMA, {
        maxSchemaBytes: schemaBytes,
        maxValueBytes: invalid,
      }),
    );
  }

  const exactValue = { name: "é" };
  const exactBytes = canonicalBytes(exactValue).byteLength;
  const compiled = compileTrustedJsonObjectSchema(BASE_SCHEMA, {
    maxSchemaBytes: schemaBytes,
    maxValueBytes: exactBytes,
  });
  assert.deepEqual(compiled.validate(exactValue), exactValue);
  const over = captureDomainError(() => compiled.validate({ name: "éx" }));
  assert.equal(over.details?.["reason"], "value_byte_limit");
  assert.equal(over.details?.["maxBytes"], exactBytes);
});

test("validation never coerces, inserts defaults, or removes properties", () => {
  const compiled = compileTrustedJsonObjectSchema(BASE_SCHEMA, limits());

  const missingDefault = { name: "alpha" };
  const validated = compiled.validate(missingDefault);
  assert.equal("count" in missingDefault, false);
  assert.equal("count" in validated, false);

  const wrongType = { name: "alpha", count: "7" };
  const typeError = captureDomainError(() => compiled.validate(wrongType));
  assert.equal(typeError.details?.["reason"], "schema_violation");
  assert.equal(wrongType.count, "7");

  const extra = { name: "alpha", extra: true };
  captureDomainError(() => compiled.validate(extra));
  assert.deepEqual(extra, { name: "alpha", extra: true });
});

test("violations are fail-fast, bounded, and omit untrusted values and paths", () => {
  const canary = "SECRET_SCHEMA_VALUE_CANARY_91d2";
  const compiled = compileTrustedJsonObjectSchema(BASE_SCHEMA, limits());
  const error = captureDomainError(() =>
    compiled.validate({ [canary]: canary, other: canary }),
  );
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes(canary), false);
  const violations = error.details?.["violations"];
  assert.equal(Array.isArray(violations), true);
  assert.equal((violations as readonly unknown[]).length, 1);
});

test("proxy, accessor, and revoked values fail without trap calls or canary leakage", () => {
  const compiled = compileTrustedJsonObjectSchema(BASE_SCHEMA, limits());
  const canary = "SECRET_SCHEMA_TRAP_CANARY_723e";
  let getCalls = 0;
  const proxy = new Proxy(
    { name: "alpha" },
    {
      get(target, key, receiver) {
        getCalls += 1;
        if (key === "name") throw new Error(canary);
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const proxyError = captureDomainError(() => compiled.validate(proxy));
  assert.equal(getCalls, 0);
  assert.equal(JSON.stringify(proxyError).includes(canary), false);

  let accessorCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "name", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      throw new Error(canary);
    },
  });
  const accessorError = captureDomainError(() => compiled.validate(accessor));
  assert.equal(accessorCalls, 0);
  assert.equal(JSON.stringify(accessorError).includes(canary), false);

  const revoked = Proxy.revocable({ name: "alpha" }, {});
  revoked.revoke();
  captureDomainError(() => compiled.validate(revoked.proxy));
});

test("hostile schema and limit objects fail without getter calls or leakage", () => {
  const canary = "SECRET_TRUSTED_SCHEMA_CANARY_04af";
  let schemaGets = 0;
  const schemaProxy = new Proxy(structuredClone(BASE_SCHEMA), {
    get(target, key, receiver) {
      schemaGets += 1;
      if (key === "document") throw new Error(canary);
      return Reflect.get(target, key, receiver);
    },
  });
  const schemaError = captureDomainError(() =>
    compileTrustedJsonObjectSchema(schemaProxy, limits()),
  );
  assert.equal(schemaGets, 0);
  assert.equal(JSON.stringify(schemaError).includes(canary), false);

  let limitGets = 0;
  const hostileLimits = new Proxy(limits(), {
    get(target, key, receiver) {
      limitGets += 1;
      if (key === "maxValueBytes") throw new Error(canary);
      return Reflect.get(target, key, receiver);
    },
  });
  const limitError = captureDomainError(() =>
    compileTrustedJsonObjectSchema(BASE_SCHEMA, hostileLimits),
  );
  assert.equal(limitGets, 0);
  assert.equal(JSON.stringify(limitError).includes(canary), false);
});

test("compiled validator throws and non-boolean results are contained safely", () => {
  const prototype = Ajv.prototype as unknown as {
    compile: (schema: unknown) => ValidateFunction;
  };
  const original = prototype.compile;
  const canary = "SECRET_AJV_FAILURE_CANARY_5b2c";
  try {
    prototype.compile = () => {
      const validator = (() => {
        throw new Error(canary);
      }) as unknown as ValidateFunction;
      return validator;
    };
    const throwing = compileTrustedJsonObjectSchema(BASE_SCHEMA, limits());
    const thrown = captureDomainError(
      () => throwing.validate({ name: "alpha" }),
      "invariant_violated",
    );
    assert.equal(JSON.stringify(thrown).includes(canary), false);

    prototype.compile = () => (() => "not-a-boolean") as unknown as ValidateFunction;
    const nonBoolean = compileTrustedJsonObjectSchema(BASE_SCHEMA, limits());
    captureDomainError(
      () => nonBoolean.validate({ name: "alpha" }),
      "invariant_violated",
    );
  } finally {
    prototype.compile = original;
  }
});
