import {
  ActionIdKind,
  type ActionId,
  type JsonObject,
} from "@guard/contracts";
import {
  CapabilityGateway,
  CapabilityPackRegistry,
  type CapabilityAdvertisement,
} from "@guard/capability-gateway";
import {
  ROBIN_SYNTHETIC_CODING_POLICY_SNAPSHOT,
  ROBIN_SYNTHETIC_INSPECT_FILE_REFERENCE,
  ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_REFERENCE,
  createRobinSyntheticCodingPack,
} from "@guard/capability-synthetic";
import type { SemanticOperationDefinition } from "@guard/model-provider";
import { createPinnedPolicyEvaluator } from "@guard/policy-engine";
import type {
  CompletedProviderToolCall,
  ToolDispatcher,
} from "@guard/robin-agent";

export interface R1GatewayActionIdSource {
  nextActionId(): ActionId;
}

/** Application-owned gateway adapter behind the agent's narrow tool port. */
export class R1GatewayToolDispatcher implements ToolDispatcher {
  public readonly advertisedOperations: readonly SemanticOperationDefinition[];
  readonly #gateway: CapabilityGateway;
  readonly #advertisement: CapabilityAdvertisement;
  readonly #ids: R1GatewayActionIdSource;

  public constructor(
    ids: R1GatewayActionIdSource = Object.freeze({
      nextActionId: () => ActionIdKind.generate(),
    }),
  ) {
    const registry = new CapabilityPackRegistry([
      createRobinSyntheticCodingPack(),
    ]);
    this.#advertisement = registry.createAdvertisement([
      ROBIN_SYNTHETIC_WORKSPACE_SUMMARY_REFERENCE,
      ROBIN_SYNTHETIC_INSPECT_FILE_REFERENCE,
    ]);
    this.#gateway = new CapabilityGateway(
      registry,
      createPinnedPolicyEvaluator(ROBIN_SYNTHETIC_CODING_POLICY_SNAPSHOT, {
        secretCorrelationToken: "robin-r1-application-policy-token-0001",
      }),
      {
        maximumInputBytes: 16_384,
        maximumRawOutputBytes: 65_536,
        maximumReleasedViewBytes: 65_536,
        maximumCombinedReleasedViewBytes: 196_608,
      },
    );
    this.#ids = Object.freeze({ nextActionId: ids.nextActionId.bind(ids) });
    this.advertisedOperations = Object.freeze(
      this.#advertisement.operations.map((operation) =>
        Object.freeze({
          capabilityPackId: operation.packId,
          capabilityPackVersion: operation.packVersion,
          operationId: operation.operationId,
          operationVersion: operation.operationVersion,
          description: operation.description,
          inputSchema: operation.inputSchema.document,
        }),
      ),
    );
  }

  public async dispatch(
    call: CompletedProviderToolCall,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    const prepared = await this.#gateway.normalize(
      {
        schemaVersion: 1,
        packId: call.capabilityPackId,
        packVersion: call.capabilityPackVersion,
        operationId: call.operationId,
        operationVersion: call.operationVersion,
        input: call.arguments,
      },
      {
        actionId: this.#ids.nextActionId(),
        subject: {
          kind: "agent_driver",
          driverId: "robin.turn-coordinator",
        },
        environment: {
          profileId: "robin-r1-synthetic",
          sandboxed: true,
          networkProfile: "disabled",
          trustLevel: "trusted_fixture",
        },
      },
      this.#advertisement,
    );
    const result = await this.#gateway.execute(
      this.#gateway.evaluate(prepared),
      { signal },
    );
    return result.agent;
  }
}

export function r1ToolDisplayName(call: {
  readonly capabilityPackId: string;
  readonly operationId: string;
  readonly operationVersion: number;
}): string {
  return `${call.capabilityPackId}.${call.operationId}@${call.operationVersion}`;
}
