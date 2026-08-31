import {
  createR1RobinApplication,
  type R1RobinApplication,
} from "@guard/robin-application";

import type { SessionPermissionMode } from "./argv.js";

/** CLI bootstrap only; provider/tool/turn logic stays in lower layers. */
export function createCliSessionApplication(
  sessionId: string,
  modelId: string,
  maximumTurns: number,
  permissionMode: SessionPermissionMode,
): R1RobinApplication {
  return createR1RobinApplication(
    sessionId,
    modelId,
    maximumTurns,
    permissionMode,
  );
}
