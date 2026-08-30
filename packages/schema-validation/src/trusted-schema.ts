import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";

import {
  canonicalBytes,
  createDomainError,
  parseVersionedSchema,
  snapshotBoundaryJsonObject,
  type JsonObject,
  type VersionedSchema,
} from "@guard/contracts";

export interface TrustedSchemaValidationLimits {
  /** Maximum canonical UTF-8 bytes for the complete VersionedSchema envelope. */
  readonly maxSchemaBytes: number;
  /** Maximum canonical UTF-8 bytes for each value before Ajv is called. */
  readonly maxValueBytes: number;
}

export interface CompiledJsonObjectSchema {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly maxValueBytes: number;
  /**
   * Detaches one lossless JSON-object snapshot, bounds it, validates that exact
   * frozen snapshot, and returns it. Caller-owned values are never passed to Ajv.
   */
  validate(value: unknown): JsonObject;
}

const LIMIT_KEYS: ReadonlySet<string> = new Set([
  "maxSchemaBytes",
  "maxValueBytes",
]);

/**
 * Compiles one reviewed, versioned JSON Schema eagerly. Ajv stays private to
 * this package and is deliberately configured without mutation, remote schema
 * loading, formats, or custom keywords.
 */
export function compileTrustedJsonObjectSchema(
  schema: VersionedSchema,
  limits: TrustedSchemaValidationLimits,
): CompiledJsonObjectSchema {
  const safeLimits = parseLimits(limits);
  const trustedSchema = parseTrustedSchema(schema);
  if (canonicalBytes(trustedSchema).byteLength > safeLimits.maxSchemaBytes) {
    throw invalidInput("The trusted schema exceeds its configured byte limit.", {
      reason: "schema_byte_limit",
      maxBytes: safeLimits.maxSchemaBytes,
    });
  }

  const ajv = new Ajv({
    strict: true,
    allErrors: false,
    validateSchema: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });
  let compiled: ValidateFunction;
  try {
    compiled = ajv.compile(trustedSchema.document);
    if (
      (compiled as ValidateFunction & { readonly $async?: boolean }).$async ===
      true
    ) {
      throw new TypeError("Asynchronous schemas are not supported.");
    }
  } catch {
    throw invalidInput("The trusted schema is invalid in strict mode.", {
      reason: "invalid_schema",
    });
  }

  const validate = Object.freeze((value: unknown): JsonObject => {
    const snapshot = parseValueSnapshot(value);
    if (canonicalBytes(snapshot).byteLength > safeLimits.maxValueBytes) {
      throw invalidInput("The schema value exceeds its configured byte limit.", {
        reason: "value_byte_limit",
        maxBytes: safeLimits.maxValueBytes,
      });
    }

    let result: unknown;
    try {
      result = compiled(snapshot);
    } catch {
      throw invariantFailure();
    }
    if (typeof result !== "boolean") {
      if (result instanceof Promise) {
        void result.catch(() => undefined);
      }
      throw invariantFailure();
    }
    if (!result) {
      throw invalidInput("The value does not satisfy the trusted schema.", {
        reason: "schema_violation",
        violations: safeViolations(compiled),
      });
    }
    return snapshot;
  });
  const validator: CompiledJsonObjectSchema = {
    schemaId: trustedSchema.schemaId,
    schemaVersion: trustedSchema.schemaVersion,
    maxValueBytes: safeLimits.maxValueBytes,
    validate,
  };
  return Object.freeze(validator);
}

function parseLimits(value: unknown): TrustedSchemaValidationLimits {
  let snapshot: JsonObject;
  try {
    snapshot = snapshotBoundaryJsonObject(value);
  } catch {
    throw invalidInput("Schema validation limits are malformed.", {
      reason: "invalid_limits",
    });
  }
  const keys = Object.keys(snapshot);
  if (
    keys.length !== LIMIT_KEYS.size ||
    keys.some((key) => !LIMIT_KEYS.has(key)) ||
    !positiveSafeInteger(snapshot["maxSchemaBytes"]) ||
    !positiveSafeInteger(snapshot["maxValueBytes"])
  ) {
    throw invalidInput("Schema validation limits are malformed.", {
      reason: "invalid_limits",
    });
  }
  return snapshot as unknown as TrustedSchemaValidationLimits;
}

function parseTrustedSchema(value: unknown): VersionedSchema {
  try {
    return parseVersionedSchema(value);
  } catch {
    throw invalidInput("The trusted schema envelope is malformed.", {
      reason: "invalid_schema",
    });
  }
}

function parseValueSnapshot(value: unknown): JsonObject {
  try {
    return snapshotBoundaryJsonObject(value);
  } catch {
    throw invalidInput("The schema value must be a lossless JSON object.", {
      reason: "invalid_value",
    });
  }
}

function safeViolations(
  validator: ValidateFunction,
): readonly Readonly<{ readonly keyword: string }>[] {
  let first: ErrorObject | undefined;
  try {
    first = Array.isArray(validator.errors) ? validator.errors[0] : undefined;
  } catch {
    first = undefined;
  }
  let keyword = "schema";
  try {
    if (
      first !== undefined &&
      typeof first.keyword === "string" &&
      /^[A-Za-z0-9_$-]{1,64}$/u.test(first.keyword)
    ) {
      keyword = first.keyword;
    }
  } catch {
    keyword = "schema";
  }
  return [{ keyword }];
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function invalidInput(message: string, details: JsonObject) {
  return createDomainError({
    code: "invalid_input",
    message,
    details,
  });
}

function invariantFailure() {
  return createDomainError({
    code: "invariant_violated",
    message: "The compiled schema validator failed unexpectedly.",
    details: { reason: "validator_failure" },
  });
}
