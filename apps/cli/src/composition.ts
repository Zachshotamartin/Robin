import {
  createR2RobinApplication,
  createR1RobinApplication,
  type R1RobinApplication,
  type R2RobinApplicationMetadata,
} from "@guard/robin-application";

import type { SessionPermissionMode } from "./argv.js";

const R2_SESSION_METADATA = new WeakMap<
  R1RobinApplication,
  R2RobinApplicationMetadata
>();

/** CLI bootstrap only; provider/tool/turn logic stays in lower layers. */
export async function createCliSessionApplication(
  sessionId: string,
  modelId: string,
  maximumTurns: number,
  permissionMode: SessionPermissionMode,
): Promise<R1RobinApplication> {
  if (modelId === "synthetic-r1-v1") {
    return createR1RobinApplication(
      sessionId,
      modelId,
      maximumTurns,
      permissionMode,
    );
  }
  const bootstrap = await createR2RobinApplication({
    sessionId,
    startDirectory: process.cwd(),
    modelId,
    maximumTurns,
    permissionMode,
    ambientEnvironment: process.env,
  });
  R2_SESSION_METADATA.set(bootstrap.application, bootstrap.metadata);
  return bootstrap.application;
}

/** Presentation-only R2 bootstrap facts; never an execution authority source. */
export function cliSessionMetadata(
  application: R1RobinApplication,
): R2RobinApplicationMetadata | null {
  return R2_SESSION_METADATA.get(application) ?? null;
}
