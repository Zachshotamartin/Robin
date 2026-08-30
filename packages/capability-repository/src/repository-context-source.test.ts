import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  PolicyVersionIdKind,
  canonicalize,
  isDomainError,
  sha256Hex,
} from "@guard/contracts";
import type { JsonObject, NormalizedAction } from "@guard/contracts";
import {
  BrokerContextSourceRegistry,
  CONTEXT_POLICY_ATTRIBUTE_CATALOG,
  ContextBroker,
  createContextReleasePolicySnapshot,
  createPinnedContextPolicyAdapter,
} from "@guard/context-broker";
import type {
  ContextBudgetLimits,
  ContextResourceMetadata,
  NormalizedResourceRequest,
  OpenedContextResource,
  SourceReadBudget,
} from "@guard/context-broker";
import {
  BASE_POLICY_ATTRIBUTE_CATALOG,
  compilePolicySnapshot,
  composePolicyAttributeCatalogs,
  createPinnedPolicyEvaluator,
} from "@guard/policy-engine";
import type { PinnedPolicyEvaluator, PolicyDecision } from "@guard/policy-engine";

import {
  REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
  RepositoryContextSource,
  normalizeRepositoryPath,
} from "./index.js";

const executeFile = promisify(execFile);
const POLICY_ID = PolicyVersionIdKind.parse(
  "pol_018f05a0-7b01-7000-8000-000000000301",
);
const DEFAULT_BUDGETS: ContextBudgetLimits = Object.freeze({
  maximumResourceBytes: 64 * 1024,
  maximumRequestBytes: 32 * 1024,
  maximumItemsPerTurn: 16,
  maximumBytesPerTurn: 64 * 1024,
  maximumItemsPerRun: 32,
  maximumBytesPerRun: 128 * 1024,
  maximumControlCharacterRatio: 0.05,
});
const OBSERVED_SOURCE_OPENS = new WeakMap<ObservedRepositoryContextSource, number>();

class ObservedRepositoryContextSource extends RepositoryContextSource {
  public constructor(root: string) {
    super({
      sourceId: "coding.repository",
      sourceVersion: 1,
      description: "Pinned repository context fixture.",
      repositoryRoot: root,
      branch: "feature/context-boundary",
      classification: "internal",
      maximumFileBytes: 256 * 1024,
      maximumByteSpan: 64 * 1024,
      maximumLineSpan: 1_000,
    });
    OBSERVED_SOURCE_OPENS.set(this, 0);
  }

  public override async openBounded(
    request: NormalizedResourceRequest,
    expected: ContextResourceMetadata,
    budget: SourceReadBudget,
    signal: AbortSignal,
  ): Promise<OpenedContextResource> {
    OBSERVED_SOURCE_OPENS.set(this, this.openCalls + 1);
    return super.openBounded(request, expected, budget, signal);
  }

  public get openCalls(): number {
    return OBSERVED_SOURCE_OPENS.get(this) ?? 0;
  }
}

function isCode(error: unknown, code: string): boolean {
  return isDomainError(error) && error.code === code;
}

async function fixtureRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "guard-repository-source-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function source(root: string): RepositoryContextSource {
  return new RepositoryContextSource({
    sourceId: "coding.repository",
    sourceVersion: 1,
    description: "Pinned repository context fixture.",
    repositoryRoot: root,
    branch: "feature/context-boundary",
    classification: "internal",
    maximumFileBytes: 256 * 1024,
    maximumByteSpan: 64 * 1024,
    maximumLineSpan: 1_000,
  });
}

function evaluator(observed: NormalizedAction[] = []): PinnedPolicyEvaluator {
  return Object.freeze({
    policyVersionId: POLICY_ID,
    evaluate(action: NormalizedAction): PolicyDecision {
      observed.push(action);
      const sourceCatalog = action.preconditions.find(
        (item) => item.preconditionType === "context.policy-catalog",
      )!;
      return Object.freeze({
        policyVersionId: POLICY_ID,
        effect: "allow",
        winningPolicyName: "allow_context_fixture",
        reason: "Reviewed repository context fixture.",
        matchedPolicyNames: Object.freeze(["allow_context_fixture"]),
        trace: Object.freeze({
          result: "allow",
          attributeCatalogs: Object.freeze([
            Object.freeze({
              catalogId: CONTEXT_POLICY_ATTRIBUTE_CATALOG.catalogId,
              schemaVersion: CONTEXT_POLICY_ATTRIBUTE_CATALOG.schemaVersion,
              contentHash: CONTEXT_POLICY_ATTRIBUTE_CATALOG.contentHash,
            }),
            Object.freeze({
              catalogId: sourceCatalog.attributes["catalogId"] as string,
              schemaVersion: sourceCatalog.attributes["catalogVersion"] as number,
              contentHash: sourceCatalog.attributes["contentHash"] as string,
            }),
          ]),
        }),
      });
    },
  });
}

function broker(
  repositorySource: RepositoryContextSource,
  observed: NormalizedAction[] = [],
  pinnedEvaluator: PinnedPolicyEvaluator = evaluator(observed),
) {
  const releasePolicy = createContextReleasePolicySnapshot({
    releasePolicyId: "context.repository.fixture",
    releasePolicyVersion: 1,
    secretDisposition: "redact",
    promptInjectionDisposition: "tag",
    truncatedDisposition: "deny",
  });
  const policy = createPinnedContextPolicyAdapter({
    evaluator: pinnedEvaluator,
    releasePolicy,
  });
  return new ContextBroker({
    runId: "run.repository-context",
    policySnapshotId: pinnedEvaluator.policyVersionId,
    releasePolicy,
    sources: new BrokerContextSourceRegistry([repositorySource]),
    policy,
    budgets: DEFAULT_BUDGETS,
  });
}

test("composes repository context policy before media classification or content open", async (t) => {
  const root = await fixtureRoot(t);
  await mkdir(path.join(root, "config"));
  await writeFile(path.join(root, "safe.ts"), "export const reviewed = true;\n");
  await writeFile(path.join(root, "config", ".env.production"), "SAFE_FIXTURE=yes\n");
  await writeFile(path.join(root, "safe.opaque"), "opaque fixture\n");
  const [baseContextPolicy, repositoryContextPolicy] = await Promise.all([
    readFile(new URL("../../../policies/context.guard", import.meta.url), "utf8"),
    readFile(new URL("../policies/context.guard", import.meta.url), "utf8"),
  ]);
  const policySource = `${baseContextPolicy.trimEnd()}\n\n${repositoryContextPolicy.trimEnd()}\n`;
  const catalogs = composePolicyAttributeCatalogs([
    BASE_POLICY_ATTRIBUTE_CATALOG,
    CONTEXT_POLICY_ATTRIBUTE_CATALOG,
    REPOSITORY_POLICY_ATTRIBUTE_CATALOG,
  ]);
  const compiled = compilePolicySnapshot(
    {
      policyVersionId: POLICY_ID,
      source: policySource,
      sourceId:
        "policies/context.guard+packages/capability-repository/policies/context.guard",
      defaultEffect: "deny",
    },
    {},
    catalogs,
  );
  assert.equal(compiled.ok, true, canonicalize(compiled.diagnostics));
  if (!compiled.ok) return;
  assert.deepEqual(compiled.snapshot.attributeCatalogs.manifest, [
    {
      catalogId: "guard.base",
      schemaVersion: 1,
      contentHash: BASE_POLICY_ATTRIBUTE_CATALOG.contentHash,
    },
    {
      catalogId: "guard.context",
      schemaVersion: 1,
      contentHash: CONTEXT_POLICY_ATTRIBUTE_CATALOG.contentHash,
    },
    {
      catalogId: "guard.repo",
      schemaVersion: 2,
      contentHash: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
    },
  ]);
  const repositorySource = new ObservedRepositoryContextSource(root);
  const contextBroker = broker(
    repositorySource,
    [],
    createPinnedPolicyEvaluator(compiled.snapshot, {
      secretCorrelationToken: "repository-context-policy-test-token-0001",
    }),
  );

  const allowed = await contextBroker.releaseSource({
    turnId: "turn.policy.allow",
    sourceId: "coding.repository",
    sourceVersion: 1,
    request: { path: "safe.ts", selector: { kind: "whole" } },
    maximumBytes: 4 * 1024,
    reason: "coding.read_file",
    signal: new AbortController().signal,
  });
  assert.equal(allowed.status, "released");
  assert.equal(repositorySource.openCalls, 1);

  const opensBeforeSecretDenial = repositorySource.openCalls;
  const denied = await contextBroker.releaseSource({
    turnId: "turn.policy.deny",
    sourceId: "coding.repository",
    sourceVersion: 1,
    request: {
      path: "config/.env.production",
      selector: { kind: "whole" },
    },
    maximumBytes: 4 * 1024,
    reason: "coding.read_file",
    signal: new AbortController().signal,
  });
  assert.equal(denied.status, "denied");
  assert.equal(denied.manifest.resource, null);
  assert.equal(denied.manifest.reason, "context.policy.metadata_denied");
  assert.equal(canonicalize(denied.manifest).includes(".env.production"), false);
  assert.equal(
    repositorySource.openCalls,
    opensBeforeSecretDenial,
    "metadata policy denial must precede media classification and content open",
  );

  const unsupported = await contextBroker.releaseSource({
    turnId: "turn.policy.unsupported-media",
    sourceId: "coding.repository",
    sourceVersion: 1,
    request: { path: "safe.opaque", selector: { kind: "whole" } },
    maximumBytes: 4 * 1024,
    reason: "coding.read_file",
    signal: new AbortController().signal,
  });
  assert.equal(unsupported.status, "denied");
  assert.equal(unsupported.manifest.reason, "unsupported_media");
  assert.equal(
    repositorySource.openCalls,
    opensBeforeSecretDenial,
    "unsupported media must be rejected before content open",
  );
});

test("handpicked binary text fixture is denied after one bounded source read", async (t) => {
  const root = await fixtureRoot(t);
  await writeFile(path.join(root, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
  const repositorySource = new ObservedRepositoryContextSource(root);
  const result = await broker(repositorySource).releaseSource({
    turnId: "turn.binary",
    sourceId: "coding.repository",
    sourceVersion: 1,
    request: { path: "binary.txt", selector: { kind: "whole" } },
    maximumBytes: 4 * 1024,
    reason: "coding.read_file",
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "denied");
  assert.equal(result.manifest.reason, "binary_nul");
  assert.equal(repositorySource.openCalls, 1);
});

test("canonicalizes repository paths and rejects hostile alternate forms", () => {
  assert.equal(
    normalizeRepositoryPath("src/cafe\u0301 file.ts", { allowRoot: false }),
    "src/café file.ts",
  );
  assert.equal(normalizeRepositoryPath("", { allowRoot: true }), "");

  for (const candidate of [
    "",
    ".",
    "..",
    "../secret",
    "src/../secret",
    "src/./file",
    "src//file",
    "/etc/passwd",
    "//server/share",
    "C:/Windows/system.ini",
    "C:\\Windows\\system.ini",
    "\\\\server\\share\\file",
    "%2e%2e/secret",
    "src/%2fetc",
    "src:file",
    "src\\file",
    "src/\u0000secret",
    "src/line\nfeed",
  ]) {
    assert.throws(
      () => normalizeRepositoryPath(candidate, { allowRoot: false }),
      (error: unknown) => isCode(error, "invalid_input"),
      JSON.stringify(candidate),
    );
  }

  let getterCalls = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "allowRoot", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return false;
    },
  });
  assert.throws(
    () =>
      normalizeRepositoryPath(
        "safe.txt",
        accessorOptions as { readonly allowRoot: boolean },
      ),
    (error: unknown) => isCode(error, "invalid_input"),
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () =>
      normalizeRepositoryPath(
        "safe.txt",
        new Proxy({ allowRoot: false }, {}) as { readonly allowRoot: boolean },
      ),
    (error: unknown) => isCode(error, "invalid_input"),
  );
});

test("exports the versioned secret-safe guard.repo policy vocabulary", () => {
  assert.equal(REPOSITORY_POLICY_ATTRIBUTE_CATALOG.catalogId, "guard.repo");
  assert.equal(REPOSITORY_POLICY_ATTRIBUTE_CATALOG.schemaVersion, 2);
  assert.equal(
    REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
    "8fc8e73ec11aa524659588abcf360cf86f0ac34dbf3f2922fffeef590d8bb24e",
  );
  assert.deepEqual(
    REPOSITORY_POLICY_ATTRIBUTE_CATALOG.attributes.map((attribute) => ({
      name: attribute.name,
      type: attribute.type,
      optional: attribute.optional,
      classification: attribute.secretClassification,
      matchKind: attribute.matchKind,
      source: attribute.source,
    })),
    [
      {
        name: "repo.path",
        type: "string",
        optional: true,
        classification: "repository_path",
        matchKind: "canonical_path",
        source: {
          kind: "object_field",
          section: "resource",
          field: "path",
        },
      },
      {
        name: "repo.paths",
        type: "list<string>",
        optional: true,
        classification: "repository_paths",
        matchKind: "canonical_path",
        source: {
          kind: "object_field",
          section: "resource",
          field: "outputPaths",
        },
      },
      {
        name: "repo.branch",
        type: "string",
        optional: true,
        classification: "repository_branch",
        matchKind: "none",
        source: {
          kind: "object_field",
          section: "resource",
          field: "branch",
        },
      },
    ],
  );
  assert.equal(
    REPOSITORY_POLICY_ATTRIBUTE_CATALOG.attributes.some(
      (attribute) => attribute.name === "resource.path",
    ),
    false,
  );
});

test("reads whole, byte, and line selectors through one pinned open handle", async (t) => {
  const root = await fixtureRoot(t);
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "café file.ts"),
    "alpha\nbéta\ngamma\ndelta\n",
    "utf8",
  );
  const repositorySource = source(root);

  const lineRequest = repositorySource.normalizeResourceRequest({
    path: "src/cafe\u0301 file.ts",
    selector: { kind: "lines", startLine: 2, endLine: 3 },
  });
  const lineMetadata = await repositorySource.inspectMetadata(
    lineRequest,
    new AbortController().signal,
  );
  assert.equal(lineMetadata.policyProjection.catalogId, "guard.repo");
  assert.equal(
    lineMetadata.policyProjection.catalogContentHash,
    REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
  );
  assert.deepEqual(lineMetadata.policyProjection.resourceAttributes, {
    branch: "feature/context-boundary",
    path: "src/café file.ts",
  });
  assert.equal(lineMetadata.selectedByteLength, null);
  const lines = await repositorySource.openBounded(
    lineRequest,
    lineMetadata,
    { maximumBytes: 128 },
    new AbortController().signal,
  );
  assert.equal(Buffer.from(lines.bytes).toString("utf8"), "béta\ngamma");
  assert.equal(lines.selectionComplete, true);
  assert.equal(lines.truncated, false);
  assert.equal(lines.contentHash, sha256Hex(lines.bytes));

  const byteRequest = repositorySource.normalizeResourceRequest({
    path: "src/café file.ts",
    selector: { kind: "bytes", offset: 6, length: 5 },
  });
  const byteMetadata = await repositorySource.inspectMetadata(
    byteRequest,
    new AbortController().signal,
  );
  assert.equal(byteMetadata.selectedByteLength, 5);
  const selectedBytes = await repositorySource.openBounded(
    byteRequest,
    byteMetadata,
    { maximumBytes: 5 },
    new AbortController().signal,
  );
  assert.equal(Buffer.from(selectedBytes.bytes).toString("utf8"), "béta");
  assert.equal(selectedBytes.selectionComplete, true);

  const wholeRequest = repositorySource.normalizeResourceRequest({
    path: "src/café file.ts",
    selector: { kind: "whole" },
  });
  const wholeMetadata = await repositorySource.inspectMetadata(
    wholeRequest,
    new AbortController().signal,
  );
  const truncated = await repositorySource.openBounded(
    wholeRequest,
    wholeMetadata,
    { maximumBytes: 5 },
    new AbortController().signal,
  );
  assert.equal(Buffer.from(truncated.bytes).toString("utf8"), "alpha");
  assert.equal(truncated.selectionComplete, false);
  assert.equal(truncated.truncated, true);
});

test("releases repository content through broker policy projection and provider-safe envelope", async (t) => {
  const root = await fixtureRoot(t);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "safe.ts"), "export const safe = true;\n");
  const observed: NormalizedAction[] = [];
  const contextBroker = broker(source(root), observed);
  const result = await contextBroker.releaseSource({
    turnId: "turn.repository",
    sourceId: "coding.repository",
    sourceVersion: 1,
    request: {
      path: "src/safe.ts",
      selector: { kind: "whole" },
    },
    maximumBytes: 4 * 1024,
    reason: "coding.read_file",
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "released");
  assert.deepEqual(
    observed.map((action) => ({
      operation: action.operationId,
      resource: action.resource,
      request: action.request,
    })),
    [
      {
        operation: "context.read",
        resource: {
          branch: "feature/context-boundary",
          classification: "internal",
          kind: "regular_file",
          mediaType: "text/typescript",
          path: "src/safe.ts",
          scheme: "repo",
          sourceId: "coding.repository",
        },
        request: {
          intent: "context.read",
          kind: "whole",
          reason: "coding.read_file",
          resourceBytes: 26,
          selectedBytes: 26,
          turnId: "turn.repository",
        },
      },
      {
        operation: "context.release",
        resource: {
          branch: "feature/context-boundary",
          classification: "internal",
          kind: "content",
          mediaType: "text/typescript",
          path: "src/safe.ts",
          scheme: "repo",
          sourceId: "coding.repository",
        },
        request: {
          intent: "context.release",
          kind: "whole",
          promptInjectionTags: [],
          reason: "coding.read_file",
          secretCategories: [],
          sourceBytes: 26,
          truncated: false,
          turnId: "turn.repository",
        },
      },
    ],
  );
  for (const action of observed) {
    assert.deepEqual(action.preconditions, [
      {
        preconditionType: "context.release-policy",
        preconditionVersion: 1,
        attributes: {
          releasePolicyId: "context.repository.fixture",
          releasePolicyVersion: 1,
          contentHash: contextBroker.releasePolicy.contentHash,
        },
      },
      {
        preconditionType: "context.policy-catalog",
        preconditionVersion: 1,
        attributes: {
          catalogId: "guard.repo",
          catalogVersion: 2,
          contentHash: REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
        },
      },
    ]);
  }
  const semantic = JSON.parse(result.item.serializedValue) as JsonObject;
  assert.equal(semantic["untrusted"], true);
  assert.equal(semantic["trustLabel"], "untrusted_source_content");
  assert.equal(
    (semantic["provenance"] as JsonObject)["policyCatalogContentHash"],
    REPOSITORY_POLICY_ATTRIBUTE_CATALOG.contentHash,
  );
  const assembly = await contextBroker.assembleAgentContext({
    turnId: "turn.repository",
    agentRequestId: "provider.repository",
    orderedItemIds: [result.item.itemId],
  });
  assert.equal(assembly.utf8Text, result.item.serializedValue);
  assert.equal(assembly.manifest.totalBytes, assembly.utf8ByteLength);
});

test("rejects internal, escaping, and prefix-collision symlink graphs", async (t) => {
  const parent = await fixtureRoot(t);
  const root = path.join(parent, "repo");
  const sibling = path.join(parent, "repo2");
  await mkdir(path.join(root, "real"), { recursive: true });
  await mkdir(sibling);
  await writeFile(path.join(root, "real", "inside.txt"), "inside");
  await writeFile(path.join(sibling, "outside.txt"), "outside");
  await symlink(path.join(root, "real", "inside.txt"), path.join(root, "internal.txt"));
  await symlink(path.join(sibling, "outside.txt"), path.join(root, "external.txt"));
  await symlink(sibling, path.join(root, "prefix"));
  const repositorySource = source(root);

  for (const repositoryPath of [
    "internal.txt",
    "external.txt",
    "prefix/outside.txt",
  ]) {
    const request = repositorySource.normalizeResourceRequest({
      path: repositoryPath,
      selector: { kind: "whole" },
    });
    await assert.rejects(
      repositorySource.inspectMetadata(request, new AbortController().signal),
      (error: unknown) => isCode(error, "invalid_input"),
      repositoryPath,
    );
  }
});

test("rejects hard links, sparse files, directories, FIFOs, and Unix sockets", async (t) => {
  const parent = await fixtureRoot(t);
  const root = path.join(parent, "repo");
  await mkdir(root);
  const outside = path.join(parent, "outside.txt");
  await writeFile(outside, "external inode");
  await link(outside, path.join(root, "hard-link.txt"));
  const sparse = path.join(root, "sparse.bin");
  await writeFile(sparse, "");
  await truncate(sparse, 128 * 1024);
  await mkdir(path.join(root, "directory"));

  const fifo = path.join(root, "named-pipe");
  let fifoCreated = false;
  try {
    await executeFile("mkfifo", [fifo]);
    fifoCreated = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const socket = path.join(root, "context.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const repositorySource = source(root);
  const hostilePaths = ["hard-link.txt", "sparse.bin", "directory", "context.sock"];
  if (fifoCreated) hostilePaths.push("named-pipe");
  for (const repositoryPath of hostilePaths) {
    const request = repositorySource.normalizeResourceRequest({
      path: repositoryPath,
      selector: { kind: "whole" },
    });
    await assert.rejects(
      repositorySource.inspectMetadata(request, new AbortController().signal),
      (error: unknown) => isCode(error, "invalid_input"),
      repositoryPath,
    );
  }
});

test("binds metadata to the exact inode and rejects TOCTOU replacement or mutation", async (t) => {
  const root = await fixtureRoot(t);
  const target = path.join(root, "target.txt");
  await writeFile(target, "approved bytes");
  const repositorySource = source(root);
  const request = repositorySource.normalizeResourceRequest({
    path: "target.txt",
    selector: { kind: "whole" },
  });
  const metadata = await repositorySource.inspectMetadata(
    request,
    new AbortController().signal,
  );
  await rename(target, path.join(root, "old-target.txt"));
  await writeFile(target, "replacement bytes");
  await assert.rejects(
    repositorySource.openBounded(
      request,
      metadata,
      { maximumBytes: 4 * 1024 },
      new AbortController().signal,
    ),
    (error: unknown) => isCode(error, "conflict"),
  );

  const mutationTarget = path.join(root, "mutation.txt");
  await writeFile(mutationTarget, "before");
  const mutationRequest = repositorySource.normalizeResourceRequest({
    path: "mutation.txt",
    selector: { kind: "whole" },
  });
  const mutationMetadata = await repositorySource.inspectMetadata(
    mutationRequest,
    new AbortController().signal,
  );
  await writeFile(mutationTarget, "after-content");
  await assert.rejects(
    repositorySource.openBounded(
      mutationRequest,
      mutationMetadata,
      { maximumBytes: 4 * 1024 },
      new AbortController().signal,
    ),
    (error: unknown) => isCode(error, "conflict"),
  );
});

test("enforces selector, file, cancellation, and constructor boundaries before allocation", async (t) => {
  const root = await fixtureRoot(t);
  await writeFile(path.join(root, "large.txt"), "x".repeat(2_048));
  const constrained = new RepositoryContextSource({
    sourceId: "coding.constrained",
    sourceVersion: 1,
    description: "Constrained repository fixture.",
    repositoryRoot: root,
    branch: null,
    classification: "internal",
    maximumFileBytes: 1_024,
    maximumByteSpan: 16,
    maximumLineSpan: 2,
  });
  assert.throws(
    () =>
      constrained.normalizeResourceRequest({
        path: "large.txt",
        selector: { kind: "bytes", offset: 0, length: 17 },
      }),
    (error: unknown) => isCode(error, "budget_exceeded"),
  );
  assert.throws(
    () =>
      constrained.normalizeResourceRequest({
        path: "large.txt",
        selector: { kind: "lines", startLine: 1, endLine: 3 },
      }),
    (error: unknown) => isCode(error, "budget_exceeded"),
  );
  const request = constrained.normalizeResourceRequest({
    path: "large.txt",
    selector: { kind: "whole" },
  });
  await assert.rejects(
    constrained.inspectMetadata(request, new AbortController().signal),
    (error: unknown) => isCode(error, "budget_exceeded"),
  );

  await writeFile(path.join(root, "small.txt"), "safe");
  const cancelledRequest = constrained.normalizeResourceRequest({
    path: "small.txt",
    selector: { kind: "whole" },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    constrained.inspectMetadata(cancelledRequest, controller.signal),
    (error: unknown) => isCode(error, "cancelled"),
  );

  let optionGetterCalls = 0;
  const hostileOptions = {
    sourceId: "coding.hostile",
    sourceVersion: 1,
    description: "Hostile options.",
    repositoryRoot: root,
    branch: null,
    classification: "internal",
    maximumFileBytes: 1_024,
    maximumByteSpan: 16,
  } as Record<string, unknown>;
  Object.defineProperty(hostileOptions, "maximumLineSpan", {
    enumerable: true,
    get() {
      optionGetterCalls += 1;
      return 2;
    },
  });
  assert.throws(
    () => new RepositoryContextSource(hostileOptions as unknown as never),
    (error: unknown) => isCode(error, "invalid_input"),
  );
  assert.equal(optionGetterCalls, 0);
});
