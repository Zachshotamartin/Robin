export const MAXIMUM_APPROVAL_INPUT_UTF8_BYTES = 32;

export type TerminalApprovalDecision = "allow_once" | "deny";
export type TerminalApprovalOutcome = "granted" | "denied" | "stale";
export type TerminalApprovalInvalidationReason =
  | "approval_expired"
  | "preconditions_changed";

export interface TerminalApprovalBinding {
  readonly actionHash: string;
  readonly actionId: string;
  readonly approvalId: string;
  readonly callId: string;
  readonly displayedSummaryHash: string;
  readonly expiresAt: string;
  readonly normalizedRequestHash: string;
  readonly policySnapshotHash: string;
  readonly preconditionHash: string;
  readonly requestedAt: string;
  readonly toolName: string;
  readonly turnId: string;
}

export interface TerminalApprovalRequest extends TerminalApprovalBinding {
  /** Complete, key-sorted JSON for the exact summary whose hash is displayed. */
  readonly canonicalSummary: string;
}

export interface TerminalApprovalResolution extends TerminalApprovalBinding {
  readonly decision: TerminalApprovalDecision;
  readonly outcome: TerminalApprovalOutcome;
  readonly resolvedAt: string;
}

export interface TerminalApprovalInvalidation extends TerminalApprovalBinding {
  readonly invalidatedAt: string;
  readonly observedPreconditionHash: string | null;
  readonly reason: TerminalApprovalInvalidationReason;
}

/**
 * Approval input is deliberately exact and case-sensitive. Whitespace,
 * aliases such as "yes", and an empty line never grant authority.
 */
export function parseTerminalApprovalDecision(
  value: string,
): TerminalApprovalDecision | null {
  if (value === "y" || value === "allow-once") return "allow_once";
  if (value === "n" || value === "deny") return "deny";
  return null;
}

export function sameTerminalApprovalBinding(
  left: TerminalApprovalBinding,
  right: TerminalApprovalBinding,
): boolean {
  return APPROVAL_BINDING_KEYS.every((key) => left[key] === right[key]);
}

const APPROVAL_BINDING_KEYS = Object.freeze([
  "actionHash",
  "actionId",
  "approvalId",
  "callId",
  "displayedSummaryHash",
  "expiresAt",
  "normalizedRequestHash",
  "policySnapshotHash",
  "preconditionHash",
  "requestedAt",
  "toolName",
  "turnId",
] as const);
