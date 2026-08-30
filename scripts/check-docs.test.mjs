import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function collectMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolutePath);
    }
  }

  return files.sort();
}

function localMarkdownLinks(markdown) {
  const links = [];
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;

  for (const match of markdown.matchAll(pattern)) {
    const target = match[1];
    if (
      target !== undefined &&
      !target.startsWith("http://") &&
      !target.startsWith("https://") &&
      !target.startsWith("mailto:") &&
      !target.startsWith("#")
    ) {
      links.push(target.split("#", 1)[0]);
    }
  }

  return links;
}

function uniqueRequirementIds(markdown) {
  return [
    ...new Set(
      [...markdown.matchAll(/\b(?:FR|NFR)-[A-Z0-9]+-\d{3}\b/g)].map(
        (match) => match[0]
      )
    ),
  ].sort();
}

function terminalGateMap(markdown, sectionHeading) {
  const sectionOffset = markdown.indexOf(sectionHeading);
  assert.notEqual(sectionOffset, -1, `missing trace section ${sectionHeading}`);
  const section = markdown.slice(sectionOffset);
  const gates = new Map();
  for (const match of section.matchAll(
    /^\| `((?:FR|NFR)-[A-Z0-9]+-\d{3})` \| ([^|\n]+) \|/gm
  )) {
    const requirementId = match[1];
    const gateCell = match[2];
    assert.equal(gates.has(requirementId), false, `duplicate trace row ${requirementId}`);
    const gateNumbers = [...gateCell.matchAll(/\bR(\d{1,2})(?:\.\d+)?\b/g)].map(
      (gateMatch) => Number(gateMatch[1])
    );
    assert.ok(gateNumbers.length > 0, `${requirementId} has no terminal R gate`);
    gates.set(requirementId, Math.max(...gateNumbers));
  }
  return gates;
}

test("Markdown files have balanced fences, no trailing whitespace, and valid local links", async () => {
  const files = await collectMarkdownFiles(repositoryRoot);
  assert.ok(files.length >= 10, "expected complete repository documentation set");

  for (const file of files) {
    const markdown = await readFile(file, "utf8");
    const relativeFile = path.relative(repositoryRoot, file);
    const fenceCount = markdown
      .split("\n")
      .filter((line) => line.startsWith("```")).length;

    assert.equal(fenceCount % 2, 0, `${relativeFile} has unbalanced code fences`);
    assert.equal(/[ \t]+$/mu.test(markdown), false, `${relativeFile} has trailing whitespace`);
    assert.equal(markdown.endsWith("\n"), true, `${relativeFile} lacks a final newline`);

    for (const link of localMarkdownLinks(markdown)) {
      const decodedLink = decodeURIComponent(link);
      const linkedPath = path.resolve(path.dirname(file), decodedLink);
      const linkedStat = await stat(linkedPath);
      assert.ok(linkedStat.isFile() || linkedStat.isDirectory(), `${relativeFile} has missing link ${link}`);
    }
  }
});

test("Robin's coding-agent product contract remains first-class and status-honest", async () => {
  const requiredFiles = [
    "README.md",
    "docs/README.md",
    "docs/BUILD_PLAN.md",
    "docs/PRODUCT_REQUIREMENTS.md",
    "docs/ROBIN_CLI_ARCHITECTURE.md",
    "docs/decisions/ADR-0007-robin-coding-agent-product-pivot.md",
    "docs/PROVIDER_AGENT_COMPATIBILITY.md",
    "docs/OPERATIONS_TEST_PLAN.md",
    "docs/THREAT_MODEL.md",
    "docs/event-model.md",
    "docs/policy-language.md",
  ];

  for (const relativeFile of requiredFiles) {
    const contents = await readFile(path.join(repositoryRoot, relativeFile), "utf8");
    assert.ok(contents.length > 1_000, `${relativeFile} is unexpectedly incomplete`);
  }

  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
  const documentationIndex = await readFile(
    path.join(repositoryRoot, "docs/README.md"),
    "utf8"
  );
  const buildPlan = await readFile(path.join(repositoryRoot, "docs/BUILD_PLAN.md"), "utf8");
  const requirements = await readFile(path.join(repositoryRoot, "docs/PRODUCT_REQUIREMENTS.md"), "utf8");
  const cliArchitecture = await readFile(
    path.join(repositoryRoot, "docs/ROBIN_CLI_ARCHITECTURE.md"),
    "utf8"
  );
  const productPivot = await readFile(
    path.join(
      repositoryRoot,
      "docs/decisions/ADR-0007-robin-coding-agent-product-pivot.md"
    ),
    "utf8"
  );
  const rootManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8")
  );
  const cliManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "apps/cli/package.json"), "utf8")
  );

  assert.match(readme, /^# Robin$/m);
  assert.match(readme, /local-first, provider-flexible coding agent for the terminal/i);
  assert.match(readme, /same product category[^.]*Claude Code/i);
  assert.match(readme, /Milestones A and B[^.]*accepted/i);
  assert.match(readme, /complete R1 terminal gate[^.]*open/i);
  assert.match(readme, /credential-free synthetic model provider/i);
  assert.match(readme, /node apps\/cli\/dist\/bin\.js run --profile coding-virtual/);
  assert.match(readme, /selecting a real provider[^.]*configuration error/i);
  assert.match(readme, /robin --continue/);
  assert.doesNotMatch(readme, /^# Guarded Agent$/m);
  assert.doesNotMatch(readme, /Guarded Agent is a general policy-enforced agent runtime/i);

  assert.match(documentationIndex, /^## Product-First Source of Truth$/m);
  assert.match(documentationIndex, /\[Product requirements and user flows\]\(PRODUCT_REQUIREMENTS\.md\)/);
  assert.match(documentationIndex, /\[Full Robin build plan\]\(BUILD_PLAN\.md\)/);
  assert.match(documentationIndex, /\[Robin CLI architecture\]\(ROBIN_CLI_ARCHITECTURE\.md\)/);
  assert.match(documentationIndex, /ADR-0007: Make Robin a coding-agent CLI product/);
  assert.match(documentationIndex, /^## Pre-Pivot and Archived References$/m);
  assert.match(documentationIndex, /general-agent\/control-plane framing/i);

  assert.match(buildPlan, /Robin/);
  assert.match(buildPlan, /coding-agent/i);
  assert.match(buildPlan, /interactive/i);
  assert.match(buildPlan, /session/i);
  assert.match(buildPlan, /bring-your-own|BYOK/i);
  assert.match(buildPlan, /provider/i);

  assert.match(cliArchitecture, /coding-agent/i);
  assert.match(cliArchitecture, /terminal/i);
  assert.match(cliArchitecture, /session/i);
  assert.match(cliArchitecture, /provider/i);
  assert.match(cliArchitecture, /tool/i);

  assert.match(productPivot, /^# ADR-0007: Make Robin a coding-agent CLI product$/m);
  assert.match(productPivot, /^- Status: accepted$/m);

  assert.match(requirements, /Robin is a local-first, provider-flexible coding agent for the terminal/i);
  assert.match(requirements, /FR-CLI-001/);
  assert.match(requirements, /FR-SES-001/);
  assert.match(requirements, /FR-PROV-001/);
  assert.match(requirements, /FR-CRED-001/);
  assert.match(requirements, /bring-your-own API credential/i);

  assert.equal(rootManifest.name, "robin");
  assert.equal(
    rootManifest.repository?.url,
    "git+https://github.com/Zachshotamartin/Robin.git"
  );
  assert.equal(
    rootManifest.bugs?.url,
    "https://github.com/Zachshotamartin/Robin/issues"
  );
  assert.equal(cliManifest.bin?.robin, "./dist/bin.js");
  assert.equal(
    cliManifest.repository?.url,
    "git+https://github.com/Zachshotamartin/Robin.git"
  );
  assert.equal(Object.hasOwn(cliManifest.bin ?? {}, "guard"), false);
});

test("supporting registries are complete and internally referential", async () => {
  const [openQuestions, deepAudit, adrTemplate] = await Promise.all([
    readFile(path.join(repositoryRoot, "docs/OPEN_QUESTIONS.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/DEEP_AUDIT.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/decisions/TEMPLATE.md"), "utf8"),
  ]);

  const openQuestionIds = [...openQuestions.matchAll(/\| (OQ-\d{2}) \|/g)].map(
    (match) => match[1]
  );
  assert.ok(openQuestionIds.length >= 14, "open-question register is unexpectedly incomplete");
  assert.equal(
    new Set(openQuestionIds).size,
    openQuestionIds.length,
    "open-question IDs must be unique"
  );

  const registeredAuditIds = new Set(
    [...deepAudit.matchAll(/\| (DA-\d{3}) \|/g)].map((match) => match[1])
  );
  const referencedAuditIds = new Set(
    [...openQuestions.matchAll(/\bDA-\d{3}\b/g)].map((match) => match[0])
  );
  for (const auditId of referencedAuditIds) {
    assert.ok(registeredAuditIds.has(auditId), `${auditId} is not registered in DEEP_AUDIT.md`);
  }

  const decisionsDirectory = path.join(repositoryRoot, "docs/decisions");
  const decisionNames = (await readdir(decisionsDirectory))
    .filter((name) => /^ADR-\d{4}-.+\.md$/.test(name))
    .sort();
  assert.ok(decisionNames.length >= 1, "expected at least one accepted decision record");

  const decisionIds = [];
  for (const decisionName of decisionNames) {
    const contents = await readFile(path.join(decisionsDirectory, decisionName), "utf8");
    const heading = contents.match(/^# (ADR-\d{4}): .+$/m);
    assert.ok(heading, `${decisionName} needs a canonical ADR heading`);
    decisionIds.push(heading[1]);
    assert.match(contents, /^- Status: (?:proposed|accepted|superseded by ADR-\d{4})$/m);
    assert.match(contents, /^- Date: \d{4}-\d{2}-\d{2}$/m);
    assert.match(contents, /^## Context$/m);
    assert.match(contents, /^## Decision$/m);
    assert.match(contents, /^## Alternatives Considered$/m);
    assert.match(contents, /^## Consequences$/m);
  }
  assert.equal(new Set(decisionIds).size, decisionIds.length, "ADR IDs must be unique");
  assert.match(adrTemplate, /^# ADR-NNNN: Title$/m);
  assert.match(adrTemplate, /^## Context$/m);
  assert.match(adrTemplate, /^## Decision$/m);
});

test("provider, BYOK, and resumable-session requirements remain explicit", async () => {
  const [requirements, compatibilityPlan, operationsPlan] = await Promise.all([
    readFile(path.join(repositoryRoot, "docs/PRODUCT_REQUIREMENTS.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/PROVIDER_AGENT_COMPATIBILITY.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/OPERATIONS_TEST_PLAN.md"), "utf8"),
  ]);

  assert.match(requirements, /FR-SES-001/);
  assert.match(requirements, /FR-SES-004/);
  assert.match(requirements, /FR-PROV-001/);
  assert.match(requirements, /FR-PROV-012/);
  assert.match(requirements, /FR-CRED-001/);
  assert.match(requirements, /FR-CRED-003[^\n]*never accepts a raw secret as a command-line argument/i);
  assert.match(requirements, /at\s+least one real direct provider in the first usable release/i);
  assert.match(requirements, /`Any API key` means[^.]*supported authentication strategy/is);

  assert.match(compatibilityPlan, /bring-your-own credentials/i);
  assert.match(compatibilityPlan, /“Any provider” means any provider for which a compatible adapter/i);
  assert.match(compatibilityPlan, /The key never appears in a repository file, command-line argument/i);
  assert.match(operationsPlan, /No real provider call occurs in ordinary tests/i);
});

test("normative Robin plans share one requirement set and durable-session format", async () => {
  const [requirements, buildPlan, architecture, compatibility, operations] =
    await Promise.all([
      readFile(path.join(repositoryRoot, "docs/PRODUCT_REQUIREMENTS.md"), "utf8"),
      readFile(path.join(repositoryRoot, "docs/BUILD_PLAN.md"), "utf8"),
      readFile(path.join(repositoryRoot, "docs/ROBIN_CLI_ARCHITECTURE.md"), "utf8"),
      readFile(path.join(repositoryRoot, "docs/PROVIDER_AGENT_COMPATIBILITY.md"), "utf8"),
      readFile(path.join(repositoryRoot, "docs/OPERATIONS_TEST_PLAN.md"), "utf8"),
    ]);

  const requirementIds = uniqueRequirementIds(requirements);
  assert.equal(
    requirementIds.length,
    213,
    "PRODUCT_REQUIREMENTS.md must retain all 213 unique FR/NFR identifiers"
  );
  for (const accessibilityId of [
    "NFR-A11Y-001",
    "NFR-A11Y-002",
    "NFR-A11Y-003",
    "NFR-A11Y-004",
  ]) {
    assert.ok(requirementIds.includes(accessibilityId), `${accessibilityId} is missing`);
  }

  for (const [name, plan] of [
    ["BUILD_PLAN.md", buildPlan],
    ["OPERATIONS_TEST_PLAN.md", operations],
  ]) {
    const traced = new Set(uniqueRequirementIds(plan));
    const missing = requirementIds.filter((requirementId) => !traced.has(requirementId));
    assert.deepEqual(missing, [], `${name} is missing requirement trace rows`);
  }

  const buildTerminalGates = terminalGateMap(
    buildPlan,
    "## 19. Product Requirement Traceability Matrix"
  );
  const operationsTerminalGates = terminalGateMap(
    operations,
    "## 20. Requirement-to-Evidence Traceability"
  );
  assert.equal(buildTerminalGates.size, 213, "Build trace must contain 213 rows");
  assert.equal(operationsTerminalGates.size, 213, "Operations trace must contain 213 rows");
  for (const requirementId of requirementIds) {
    assert.equal(
      operationsTerminalGates.get(requirementId),
      buildTerminalGates.get(requirementId),
      `${requirementId} has contradictory Build and Operations terminal gates`
    );
  }

  const sessionFormatTokens = [
    "events.rlog",
    "writer.lock",
    "RBNELOG1",
    "RBNFRM01",
    "RBNCMT01",
    "CRC32C",
  ];
  for (const [name, plan] of [
    ["BUILD_PLAN.md", buildPlan],
    ["ROBIN_CLI_ARCHITECTURE.md", architecture],
    ["OPERATIONS_TEST_PLAN.md", operations],
  ]) {
    for (const token of sessionFormatTokens) {
      assert.ok(plan.includes(token), `${name} is missing session-format token ${token}`);
    }
  }
  for (const retiredToken of [
    "events.rbnlog",
    "`RBE1`",
    "`lock.json`",
    "objects/sha256",
  ]) {
    assert.equal(
      operations.includes(retiredToken),
      false,
      `OPERATIONS_TEST_PLAN.md retains retired session format ${retiredToken}`
    );
  }

  for (const plan of [buildPlan, architecture, compatibility]) {
    assert.match(plan, /OpenAI Responses/i);
    assert.match(plan, /official (?:OpenAI )?(?:JavaScript|TypeScript) SDK/i);
    for (const method of [
      "probe(",
      "countInput(",
      "invoke(",
      "classifyUnknownError(",
      "redactDiagnostic(",
    ]) {
      assert.ok(plan.includes(method), `canonical provider port is missing ${method}`);
    }
  }
  for (const plan of [buildPlan, architecture, compatibility, operations]) {
    assert.match(plan, /robin models/);
    assert.match(plan, /robin auth/);
    for (const permissionMode of [
      "default",
      "plan",
      "accept-edits",
      "locked",
      "bypass",
    ]) {
      assert.ok(
        plan.includes(permissionMode),
        `canonical permission vocabulary is missing ${permissionMode}`
      );
    }
  }
});
