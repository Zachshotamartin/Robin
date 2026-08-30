import { isProxy } from "node:util/types";

import { createDomainError } from "@guard/contracts";

import { ContextBroker } from "./context-broker.js";
import type {
  AgentContextAssembly,
  AgentContextAssemblyRequest,
  CapabilityOutputReleaseRequest,
  ContextReleaseResult,
  SourceContextReleaseRequest,
} from "./context-boundary.js";

/** Minimal runtime-host seam; every operation remains owned by one run broker. */
export interface ContextBrokerIntegration {
  releasePlannedSource(
    request: SourceContextReleaseRequest,
  ): Promise<ContextReleaseResult>;
  releaseCapabilityAgentView(
    request: CapabilityOutputReleaseRequest,
  ): Promise<ContextReleaseResult>;
  assembleAgentContext(request: AgentContextAssemblyRequest): AgentContextAssembly;
}

export function createContextBrokerIntegration(
  broker: ContextBroker,
): ContextBrokerIntegration {
  if (!(broker instanceof ContextBroker) || isProxy(broker)) {
    throw createDomainError({
      code: "invalid_input",
      message: "A runtime context integration requires a recognized run broker.",
    });
  }
  return Object.freeze({
    releasePlannedSource: broker.releaseSource.bind(broker),
    releaseCapabilityAgentView: broker.releaseCapabilityOutput.bind(broker),
    assembleAgentContext: broker.assembleAgentContext.bind(broker),
  });
}
