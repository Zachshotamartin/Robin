import {
  CONTRACT_SCHEMA_VERSION,
  canonicalSha256Hex,
} from "@guard/contracts";
import type { JsonObject, NormalizedAction } from "@guard/contracts";

import type {
  CapabilityAgentContextReleaseClaim,
  CapabilityAgentContextReleaseDescriptor,
} from "./capability-types.js";

/**
 * Constructs an operation-owned binding claim. The gateway independently
 * snapshots and verifies every field before returning the public descriptor.
 */
export function bindCapabilityAgentContextRelease(
  descriptor: CapabilityAgentContextReleaseDescriptor,
  action: NormalizedAction,
  rawResult: JsonObject,
  agentView: JsonObject,
): CapabilityAgentContextReleaseClaim {
  return Object.freeze({
    descriptor,
    binding: Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      normalizedActionHash: canonicalSha256Hex(action),
      rawResultHash: canonicalSha256Hex(rawResult),
      agentViewHash: canonicalSha256Hex(agentView),
      descriptorHash: canonicalSha256Hex(descriptor),
    }),
  });
}
