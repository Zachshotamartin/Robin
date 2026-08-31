import type {
  AuthorizedCapabilityAction,
  CapabilityAuthorizedExecutionResult,
  CapabilityGateway,
  CapabilityPack,
  CapabilityPackRegistry,
  CapabilityAdvertisement,
  PreparedCapabilityAction,
} from "@guard/capability-gateway";
import type { JsonObject } from "@guard/contracts";
import type { GitReadService } from "@guard/tool-git";
import type {
  ExecutableResolutionPolicy,
  ProcessController,
  ProcessEnvironmentProfile,
  ProcessLifecycleEvent,
} from "@guard/tool-process";
import type { WorkspaceHandle } from "@guard/tool-workspace";

/** Installation-owned bounds. None of these values are accepted from a model call. */
export interface RobinR2InstalledLimits {
  readonly list: {
    readonly maximumDepth: number;
    readonly maximumEntries: number;
    readonly maximumResults: number;
    readonly maximumPathBytes: number;
    readonly maximumDurationMs: number;
  };
  readonly search: {
    readonly maximumQueryBytes: number;
    readonly maximumFiles: number;
    readonly maximumFileBytes: number;
    readonly maximumTotalBytes: number;
    readonly maximumMatches: number;
    readonly maximumSnippetBytes: number;
    readonly maximumOutputBytes: number;
    readonly maximumDurationMs: number;
  };
  readonly read: {
    readonly maximumFileBytes: number;
    readonly maximumOutputBytes: number;
    readonly maximumLineSpan: number;
  };
  readonly edit: {
    readonly maximumHunks: number;
    readonly maximumAggregateTextBytes: number;
    readonly maximumResultBytes: number;
    readonly maximumFileBytes: number;
    readonly maximumFullDiffBytes: number;
    readonly maximumPreviewBytes: number;
  };
  readonly git: {
    readonly maximumFiles: number;
    readonly maximumRetainedBytes: number;
    readonly maximumAbsoluteBytes: number;
    readonly maximumStatusEntries: number;
  };
  readonly approval: {
    readonly maximumSummaryBytes: number;
    readonly maximumTextPreviewBytes: number;
  };
  readonly lifecycle: {
    readonly maximumEventTextBytes: number;
    readonly maximumPendingEvents: number;
    readonly maximumPendingBytes: number;
  };
}

export interface RobinR2RuntimeOptions {
  /** Opaque workspace handle discovered by the trusted application boundary. */
  readonly workspace: WorkspaceHandle;
  /** Open read-only Git service whose initial snapshot anchors attribution. */
  readonly git: GitReadService;
  readonly process: {
    readonly controller: ProcessController;
    readonly executablePolicy: ExecutableResolutionPolicy;
    readonly environmentProfile: ProcessEnvironmentProfile;
    readonly ambientEnvironment: Readonly<Record<string, string | undefined>>;
  };
  readonly limits?: RobinR2InstalledLimits;
  readonly clock?: { now(): string };
}

/** Safe application-facing process event. Raw bytes and base64 never cross this port. */
export type RobinR2SafeProcessLifecycleEvent =
  | {
      readonly type: "output";
      readonly sequence: number;
      readonly channel: "stdout" | "stderr";
      readonly channelOffset: number;
      readonly byteLength: number;
      readonly safeText: string;
      readonly textTruncated: boolean;
      readonly limitExceeded: boolean;
    }
  | Exclude<ProcessLifecycleEvent, { readonly type: "output" }>;

/** A sink is application presentation, never model input or execution authority. */
export interface RobinR2LifecycleSink {
  publish(event: RobinR2SafeProcessLifecycleEvent): void | Promise<void>;
}

export interface RobinR2ExecuteAuthorizedOptions {
  readonly signal: AbortSignal;
  readonly lifecycleSink?: RobinR2LifecycleSink;
}

export interface RobinR2CapabilityRuntime {
  readonly packs: readonly CapabilityPack[];
  readonly registry: CapabilityPackRegistry;
  readonly advertisement: CapabilityAdvertisement;
  approvalSummary(prepared: PreparedCapabilityAction): JsonObject;
  executeAuthorized(
    gateway: CapabilityGateway,
    authorization: AuthorizedCapabilityAction,
    options: RobinR2ExecuteAuthorizedOptions,
  ): Promise<CapabilityAuthorizedExecutionResult>;
}
