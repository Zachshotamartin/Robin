import { isProxy } from "node:util/types";

import {
  canonicalize,
  createDomainError,
  isDomainError,
} from "@guard/contracts";

import {
  ContextBroker,
  isRecognizedContextBroker,
  type ContextBrokerOptions,
} from "./context-broker.js";
import type {
  AgentContextAssembly,
  AgentContextAssemblyRequest,
  CapabilityOutputReleaseRequest,
  ContextBrokerConfigurationDescriptor,
  ContextBrokerIntegrationDescriptor,
  ContextReleaseResult,
  SourceContextReleaseRequest,
} from "./context-boundary.js";
import { snapshotBoundaryObject } from "./immutable.js";

/** Minimal runtime seam; every operation and item remains owned by one run broker. */
export interface ContextBrokerIntegration {
  readonly descriptor: ContextBrokerIntegrationDescriptor;
  releasePlannedSource(
    request: SourceContextReleaseRequest,
  ): Promise<ContextReleaseResult>;
  releaseCapabilityAgentView(
    request: CapabilityOutputReleaseRequest,
  ): Promise<ContextReleaseResult>;
  assembleAgentContext(
    request: AgentContextAssemblyRequest,
  ): Promise<AgentContextAssembly>;
}

export interface ContextBrokerIntegrationFactoryRequest {
  readonly runId: string;
}

export type ContextBrokerIntegrationFactoryOptions = Omit<
  ContextBrokerOptions,
  "runId"
>;

/** Recognized configuration owner that creates exactly one broker for each run ID. */
export interface ContextBrokerIntegrationFactory {
  readonly configurationDescriptor: ContextBrokerConfigurationDescriptor;
  createForRun(
    request: ContextBrokerIntegrationFactoryRequest,
  ): ContextBrokerIntegration;
}

const RECOGNIZED_INTEGRATIONS = new WeakSet<object>();
const RECOGNIZED_FACTORIES = new WeakSet<object>();
const INTEGRATED_BROKERS = new WeakSet<object>();

export function createContextBrokerIntegration(
  broker: ContextBroker,
): ContextBrokerIntegration {
  if (!isRecognizedContextBroker(broker)) {
    throw invalidInput("A runtime context integration requires a recognized run broker.");
  }
  if (INTEGRATED_BROKERS.has(broker)) {
    throw conflict("A run broker may be captured by only one runtime integration.");
  }
  INTEGRATED_BROKERS.add(broker);
  const integration: ContextBrokerIntegration = Object.freeze({
    descriptor: broker.descriptor,
    releasePlannedSource: broker.releaseSource.bind(broker),
    releaseCapabilityAgentView: broker.releaseCapabilityOutput.bind(broker),
    assembleAgentContext: broker.assembleAgentContext.bind(broker),
  });
  RECOGNIZED_INTEGRATIONS.add(integration);
  return integration;
}

export function captureContextBrokerIntegration(
  value: unknown,
): ContextBrokerIntegration {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    !RECOGNIZED_INTEGRATIONS.has(value)
  ) {
    throw invalidInput("A runtime requires a recognized context-broker integration.");
  }
  return value as ContextBrokerIntegration;
}

export function createContextBrokerIntegrationFactory(
  options: ContextBrokerIntegrationFactoryOptions,
): ContextBrokerIntegrationFactory {
  const captured = captureFactoryOptions(options);
  const validationBroker = new ContextBroker({
    runId: "context.integration.factory.validation",
    ...captured,
  });
  const expectedConfigurationContentHash =
    validationBroker.descriptor.configurationContentHash;
  const configurationDescriptor: ContextBrokerConfigurationDescriptor =
    Object.freeze({
      schemaVersion: validationBroker.descriptor.schemaVersion,
      policySnapshotId: validationBroker.descriptor.policySnapshotId,
      releasePolicyId: validationBroker.descriptor.releasePolicyId,
      releasePolicyVersion: validationBroker.descriptor.releasePolicyVersion,
      releasePolicyContentHash:
        validationBroker.descriptor.releasePolicyContentHash,
      sourceDescriptors: validationBroker.descriptor.sourceDescriptors,
      budgets: validationBroker.descriptor.budgets,
      configurationContentHash:
        validationBroker.descriptor.configurationContentHash,
    });
  const usedRunIds = new Set<string>();
  const factory: ContextBrokerIntegrationFactory = Object.freeze({
    configurationDescriptor,
    createForRun(request: ContextBrokerIntegrationFactoryRequest) {
      const runId = parseFactoryRequest(request);
      if (usedRunIds.has(runId)) {
        throw conflict("A context-broker factory cannot recreate a broker for one run.");
      }
      usedRunIds.add(runId);
      const broker = new ContextBroker({ runId, ...captured });
      if (
        broker.descriptor.configurationContentHash !==
          expectedConfigurationContentHash ||
        !sameConfigurationDescriptor(
          broker.descriptor,
          configurationDescriptor,
        )
      ) {
        throw createDomainError({
          code: "invariant_violated",
          message: "Captured context-broker configuration changed between runs.",
        });
      }
      return createContextBrokerIntegration(broker);
    },
  });
  RECOGNIZED_FACTORIES.add(factory);
  return factory;
}

function sameConfigurationDescriptor(
  descriptor: ContextBrokerIntegrationDescriptor,
  expected: ContextBrokerConfigurationDescriptor,
): boolean {
  return (
    descriptor.schemaVersion === expected.schemaVersion &&
    descriptor.policySnapshotId === expected.policySnapshotId &&
    descriptor.releasePolicyId === expected.releasePolicyId &&
    descriptor.releasePolicyVersion === expected.releasePolicyVersion &&
    descriptor.releasePolicyContentHash === expected.releasePolicyContentHash &&
    canonicalEqual(descriptor.sourceDescriptors, expected.sourceDescriptors) &&
    canonicalEqual(descriptor.budgets, expected.budgets) &&
    descriptor.configurationContentHash === expected.configurationContentHash
  );
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

export function captureContextBrokerIntegrationFactory(
  value: unknown,
): ContextBrokerIntegrationFactory {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    !RECOGNIZED_FACTORIES.has(value)
  ) {
    throw invalidInput("A runtime requires a recognized context-broker factory.");
  }
  return value as ContextBrokerIntegrationFactory;
}

function captureFactoryOptions(
  value: unknown,
): ContextBrokerIntegrationFactoryOptions {
  const required = [
    "policySnapshotId",
    "releasePolicy",
    "sources",
    "policy",
    "budgets",
  ];
  const optional = [
    "customSecretClassifiers",
    "additionalReviewedTextMediaTypes",
  ];
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new TypeError("not plain factory options");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (!required.includes(key) && !optional.includes(key)),
      ) ||
      required.some((key) => !keys.includes(key))
    ) {
      throw new TypeError("unknown or missing factory option");
    }
    const fields: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("factory option accessor or hidden property");
      }
      fields[key] = descriptor.value;
    }
    const budgets = snapshotBoundaryObject(fields["budgets"], "Context budgets");
    const customSecretClassifiers = snapshotOptionalArray(
      fields["customSecretClassifiers"],
      "Custom secret classifiers",
    );
    const additionalReviewedTextMediaTypes = snapshotOptionalArray(
      fields["additionalReviewedTextMediaTypes"],
      "Additional reviewed text media types",
    );
    return Object.freeze({
      policySnapshotId:
        fields["policySnapshotId"] as ContextBrokerOptions["policySnapshotId"],
      releasePolicy:
        fields["releasePolicy"] as ContextBrokerOptions["releasePolicy"],
      sources: fields["sources"] as ContextBrokerOptions["sources"],
      policy: fields["policy"] as ContextBrokerOptions["policy"],
      budgets: budgets as unknown as ContextBrokerOptions["budgets"],
      ...(customSecretClassifiers === undefined
        ? {}
        : {
            customSecretClassifiers:
              customSecretClassifiers as NonNullable<
                ContextBrokerOptions["customSecretClassifiers"]
              >,
          }),
      ...(additionalReviewedTextMediaTypes === undefined
        ? {}
        : {
            additionalReviewedTextMediaTypes:
              additionalReviewedTextMediaTypes as NonNullable<
                ContextBrokerOptions["additionalReviewedTextMediaTypes"]
              >,
          }),
    });
  } catch (error: unknown) {
    if (isDomainError(error)) throw error;
    throw invalidInput(
      "Context-broker factory options contain unknown, missing, accessor, or unsafe properties.",
    );
  }
}

function snapshotOptionalArray(
  value: unknown,
  label: string,
): readonly unknown[] | undefined {
  if (value === undefined) return undefined;
  const wrapper = snapshotBoundaryObject({ values: value }, label);
  const values = wrapper["values"];
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  return values;
}

function parseFactoryRequest(value: unknown): string {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new TypeError("not a request object");
    }
    const keys = Reflect.ownKeys(value);
    const descriptor = Object.getOwnPropertyDescriptor(value, "runId");
    if (
      keys.length !== 1 ||
      keys[0] !== "runId" ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(descriptor.value)
    ) {
      throw new TypeError("malformed factory request");
    }
    return descriptor.value;
  } catch {
    throw invalidInput("A context-broker factory request requires one safe run ID.");
  }
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}

function conflict(message: string) {
  return createDomainError({ code: "conflict", message });
}
