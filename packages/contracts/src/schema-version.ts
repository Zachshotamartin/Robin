import { createDomainError } from "./errors.js";

/** Current wire version for the first stable Milestone A contract family. */
export const CONTRACT_SCHEMA_VERSION = 1 as const;
export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;

export interface VersionedContract {
  readonly schemaVersion: ContractSchemaVersion;
}

export function isContractSchemaVersion(
  value: unknown
): value is ContractSchemaVersion {
  return value === CONTRACT_SCHEMA_VERSION;
}

export function assertContractSchemaVersion(
  value: unknown,
  contractName = "contract"
): asserts value is ContractSchemaVersion {
  if (!isContractSchemaVersion(value)) {
    throw createDomainError({
      code: "invalid_input",
      message: `Unsupported ${contractName} schema version.`,
      details: {
        expected: CONTRACT_SCHEMA_VERSION,
        received: describeBoundaryValue(value),
      },
    });
  }
}

export function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function describeBoundaryValue(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return typeof value;
}
