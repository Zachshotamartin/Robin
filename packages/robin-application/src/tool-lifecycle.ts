import { createDomainError } from "@guard/contracts";
import type {
  RobinApprovalDecision,
  RobinApprovalInvalidatedPayload,
  RobinApprovalRequestedPayload,
  RobinApprovalResolvedPayload,
  RobinPermissionDecidedPayload,
} from "@guard/robin-session";
import type { ToolDispatcher } from "@guard/robin-agent";

export type RobinToolPermissionDecision = Omit<
  RobinPermissionDecidedPayload,
  "turnId"
>;
export type RobinToolApprovalRequest = Omit<
  RobinApprovalRequestedPayload,
  "turnId"
>;
export type RobinToolApprovalResolution = Omit<
  RobinApprovalResolvedPayload,
  "turnId"
>;
export type RobinToolApprovalInvalidation = Omit<
  RobinApprovalInvalidatedPayload,
  "turnId"
>;

/**
 * Application-owned lifecycle boundary used by a trusted tool dispatcher.
 * Tool implementations cannot append session facts or obtain user authority
 * directly; the active application validates each fact against its serialized
 * call before committing it.
 */
export interface RobinApplicationToolLifecycle {
  permissionDecided(decision: RobinToolPermissionDecision): void;
  requestApproval(
    request: RobinToolApprovalRequest,
    signal: AbortSignal,
  ): Promise<RobinApprovalDecision>;
  approvalResolved(resolution: RobinToolApprovalResolution): void;
  approvalInvalidated(invalidation: RobinToolApprovalInvalidation): void;
}

export type RobinApplicationToolDispatcherFactory = (
  lifecycle: RobinApplicationToolLifecycle,
) => ToolDispatcher;

export function captureApprovalDecision(value: unknown): RobinApprovalDecision {
  if (value !== "allow_once" && value !== "deny") {
    throw createDomainError({
      code: "invalid_input",
      message: "An approval decision must be allow_once or deny.",
    });
  }
  return value;
}
