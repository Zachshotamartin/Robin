import type { JsonObject } from "@guard/contracts";

import {
  createWorkspaceIgnorePolicy,
  type IgnorePolicyOptions,
} from "./ignore-rules.js";
import {
  walkPhysicalWorkspace,
  type FileWalkDependencies,
  type FileWalkLimits,
} from "./file-walker.js";
import type { WorkspaceHandle } from "./physical-workspace.js";

export interface PhysicalListFilesRequest {
  readonly root: string;
  readonly includeHidden: boolean;
  readonly includeGenerated: boolean;
  readonly explicitIncludes?: readonly string[];
  readonly limits: FileWalkLimits;
}

export interface PhysicalListFilesResult extends JsonObject {
  readonly files: readonly JsonObject[];
  readonly omissions: readonly JsonObject[];
  readonly truncated: boolean;
  readonly optionsHash: string;
}

export async function listPhysicalFiles(
  workspace: WorkspaceHandle,
  request: PhysicalListFilesRequest,
  signal: AbortSignal,
  dependencies: FileWalkDependencies &
    Pick<IgnorePolicyOptions, "gitIgnoreProbe"> = {},
): Promise<PhysicalListFilesResult> {
  const ignore = await createWorkspaceIgnorePolicy(workspace, {
    includeHidden: request.includeHidden,
    includeGenerated: request.includeGenerated,
    ...(request.explicitIncludes === undefined
      ? {}
      : { explicitIncludes: request.explicitIncludes }),
    ...(dependencies.gitIgnoreProbe === undefined
      ? {}
      : { gitIgnoreProbe: dependencies.gitIgnoreProbe }),
  });
  const walked = await walkPhysicalWorkspace(
    workspace,
    request.root,
    ignore,
    request.limits,
    signal,
    dependencies,
  );
  return Object.freeze({
    files: Object.freeze(
      walked.entries.map((entry) =>
        Object.freeze({
          path: entry.path,
          kind: entry.binding.identity.kind,
          size: entry.binding.size,
          links: entry.binding.links,
          generated: entry.classification.generated,
          hidden: entry.classification.hidden,
          mediaType: entry.classification.mediaType,
        }),
      ),
    ),
    omissions: Object.freeze(
      walked.omissions.map((entry) => Object.freeze({ ...entry })),
    ),
    truncated: walked.truncated,
    optionsHash: walked.optionsHash,
  });
}
