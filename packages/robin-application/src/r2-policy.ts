import type { PinnedPolicyEvaluator } from "@guard/policy-engine";
import {
  compilePolicySnapshot,
  createPinnedPolicyEvaluator,
  type PolicySnapshot,
} from "@guard/policy-engine";

export type RobinR2PermissionMode = "ask" | "plan";

const READ_POLICY_SOURCE = `policy "allow-robin-repo-list" priority 100 {
  when action.pack == "robin.repo" and action.operation == "list_files" and action.side_effect == "none"
  allow
  reason "Bounded workspace metadata listing is allowed."
}

policy "allow-robin-repo-search" priority 100 {
  when action.pack == "robin.repo" and action.operation == "search_text" and action.side_effect == "none"
  allow
  reason "Bounded literal workspace search is allowed."
}

policy "allow-robin-repo-read" priority 100 {
  when action.pack == "robin.repo" and action.operation == "read_file" and action.side_effect == "none"
  allow
  reason "Bounded eligible workspace file reads are allowed."
}

policy "allow-robin-git-status" priority 100 {
  when action.pack == "robin.git" and action.operation == "status" and action.side_effect == "none"
  allow
  reason "Controlled read-only Git status is allowed."
}

policy "allow-robin-git-diff" priority 100 {
  when action.pack == "robin.git" and action.operation == "diff" and action.side_effect == "none"
  allow
  reason "Controlled read-only Git diff is allowed."
}
`;

const ASK_POLICY_SOURCE = `${READ_POLICY_SOURCE}
policy "approve-robin-edit-apply" priority 100 {
  when action.pack == "robin.edit" and action.operation == "apply_patch" and action.side_effect == "local_reversible"
  require_approval
  reason "A live-workspace patch requires exact allow-once approval."
}

policy "approve-robin-edit-create" priority 100 {
  when action.pack == "robin.edit" and action.operation == "create_file" and action.side_effect == "local_reversible"
  require_approval
  reason "Creating a live-workspace file requires exact allow-once approval."
}

policy "approve-robin-process-run" priority 100 {
  when action.pack == "robin.process" and action.operation == "run" and action.side_effect == "local_irreversible"
  require_approval
  reason "An unsandboxed direct process requires exact allow-once approval."
}
`;

const ASK_SNAPSHOT = compileSnapshot(
  "pol_018f05a0-7b01-7000-8000-000000000201",
  "robin-r2-ask.guard",
  ASK_POLICY_SOURCE,
);
const PLAN_SNAPSHOT = compileSnapshot(
  "pol_018f05a0-7b01-7000-8000-000000000202",
  "robin-r2-plan.guard",
  READ_POLICY_SOURCE,
);

/** Creates the immutable R2 policy selected before a session starts. */
export function createRobinR2PolicyEvaluator(
  mode: RobinR2PermissionMode,
  secretCorrelationToken?: string,
): PinnedPolicyEvaluator {
  const snapshot = mode === "ask" ? ASK_SNAPSHOT : PLAN_SNAPSHOT;
  return secretCorrelationToken === undefined
    ? createPinnedPolicyEvaluator(snapshot)
    : createPinnedPolicyEvaluator(snapshot, { secretCorrelationToken });
}

export function robinR2PolicySnapshot(
  mode: RobinR2PermissionMode,
): PolicySnapshot {
  return mode === "ask" ? ASK_SNAPSHOT : PLAN_SNAPSHOT;
}

function compileSnapshot(
  policyVersionId: string,
  sourceId: string,
  source: string,
): PolicySnapshot {
  const result = compilePolicySnapshot({
    policyVersionId,
    sourceId,
    source,
    defaultEffect: "deny",
  });
  if (!result.ok) {
    throw new Error(
      `Robin R2 policy failed to compile: ${result.diagnostics
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return result.snapshot;
}
