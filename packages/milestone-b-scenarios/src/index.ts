export {
  CalibrationAgentDriver,
  InvariantProviderBoundaryProbeDriver,
  PROVIDER_BOUNDARY_DRIVER_COMPONENT_ID,
  ProviderBoundaryProbeDriver,
  ZeroCallProviderBoundaryProbeDriver,
  mapAgentTurnToSemanticRequest,
  providerScriptFor,
  scanEvidenceSurfaces,
} from "./provider-boundary-probe.js";
export type {
  EvidenceSurfaceInput,
  EvidenceSurfaceMatch,
  ProbeTranscript,
} from "./provider-boundary-probe.js";

export {
  CODING_SAFE_NAMESPACE,
  GENERIC_SAFE_NAMESPACE,
  SAFE_GREETING_PATH,
  SAFE_PROPOSED_PATCH,
  SAFE_SEARCH_PATH,
  SAFE_SEARCH_SNIPPET,
  runCodingSafeScenario,
  runGenericSafeScenario,
} from "./safe-scenarios.js";
export type {
  CodingSafeArtifacts,
  GenericSafeArtifacts,
} from "./safe-scenarios.js";

export {
  runBrokerInfrastructureFailureScenario,
  runConfigurationMismatchProbe,
  runCredentialCorpusScenario,
  runInjectionAuthorityScenario,
  runRepositoryOutputCanaryScenario,
  runRepositoryPathOutputScenario,
  runRepositoryPathPolicyScenario,
  runSourceDenialScenario,
  runSplitSecretAssemblyScenario,
} from "./adversarial-scenarios.js";
export type {
  AdversarialArtifacts,
  ConfigurationMismatchProbe,
  RepositoryOutputCanaryKind,
  RepositoryPathOutputKind,
  SourceDenialKind,
} from "./adversarial-scenarios.js";

export {
  createCredentialCanaryCorpus,
} from "./adversarial-fixtures.js";
export type { CredentialCanaryCorpus } from "./adversarial-fixtures.js";

export {
  GATE_B_BROKER_BUDGETS,
  GATE_B_OCCURRED_AT,
  GATE_B_RECORDED_AT,
  REPOSITORY_CONTEXT_POLICY_SOURCE,
  ROOT_CONTEXT_POLICY_SOURCE,
} from "./scenario-support.js";
export type {
  EffectCounters,
  GateBScenarioResult,
} from "./scenario-support.js";
