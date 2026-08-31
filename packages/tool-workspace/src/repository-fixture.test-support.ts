import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TestContext } from "node:test";

import {
  discoverPhysicalWorkspace,
  type WorkspaceHandle,
} from "./physical-workspace.js";
import type {
  GitWorkspaceProbeResult,
  WorkspaceGitProbe,
} from "./workspace-identity.js";

export interface RepositoryFixture {
  readonly root: string;
  readonly parent: string;
  readonly workspace: WorkspaceHandle;
  readonly gitProbe: WorkspaceGitProbe;
}

export async function createRepositoryFixture(
  t: TestContext,
  files: Readonly<Record<string, string | Uint8Array>> = {},
  overrides: Partial<GitWorkspaceProbeResult> = {},
): Promise<RepositoryFixture> {
  const parent = await mkdtemp(path.join(tmpdir(), "robin-tool-workspace-"));
  const root = path.join(parent, "repo");
  await mkdir(path.join(root, ".git"), { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const facts: GitWorkspaceProbeResult = Object.freeze({
    worktreeRoot: root,
    commonDirectory: path.join(root, ".git"),
    gitDirectory: path.join(root, ".git"),
    objectFormat: "sha1",
    initialHead: "0123456789abcdef0123456789abcdef01234567",
    branch: "main",
    linked: false,
    bare: false,
    shallow: false,
    sparse: false,
    submodule: false,
    operationState: "none",
    initialStatusHash:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ...overrides,
  });
  const gitProbe: WorkspaceGitProbe = Object.freeze({
    async inspect() {
      return facts;
    },
  });
  const workspace = await discoverPhysicalWorkspace(
    { startDirectory: root, createdFrom: "launch_directory" },
    { gitProbe, caseSensitivity: "sensitive", unicodeNormalization: "nfc" },
  );
  t.after(async () => {
    await rm(parent, { recursive: true, force: true });
  });
  return Object.freeze({ root, parent, workspace, gitProbe });
}

export function isDomainCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly code?: unknown }).code === code
  );
}
