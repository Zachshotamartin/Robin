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

test("general runtime and compatibility plans remain first-class documentation", async () => {
  const requiredFiles = [
    "README.md",
    "docs/BUILD_PLAN.md",
    "docs/DEEP_AUDIT.md",
    "docs/GLOSSARY.md",
    "docs/OPEN_QUESTIONS.md",
    "docs/GENERAL_RUNTIME_ARCHITECTURE.md",
    "docs/IMPLEMENTATION_GUIDE.md",
    "docs/OPERATIONS_TEST_PLAN.md",
    "docs/PRODUCT_REQUIREMENTS.md",
    "docs/PROVIDER_AGENT_COMPATIBILITY.md",
    "docs/THREAT_MODEL.md",
  ];

  for (const relativeFile of requiredFiles) {
    const contents = await readFile(path.join(repositoryRoot, relativeFile), "utf8");
    assert.ok(contents.length > 1_000, `${relativeFile} is unexpectedly incomplete`);
  }

  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
  const buildPlan = await readFile(path.join(repositoryRoot, "docs/BUILD_PLAN.md"), "utf8");
  const requirements = await readFile(path.join(repositoryRoot, "docs/PRODUCT_REQUIREMENTS.md"), "utf8");

  assert.match(readme, /general policy-enforced agent runtime/i);
  assert.match(buildPlan, /AgentDriver/);
  assert.match(buildPlan, /local-corpus research/i);
  assert.match(buildPlan, /Multi-provider and external-agent compatibility/);
  assert.match(requirements, /FR-CRED-001/);
  assert.match(requirements, /FR-COMP-001/);
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

test("credential and local-provider milestone vocabulary remains canonical", async () => {
  const [glossary, buildPlan, implementationGuide, operationsPlan] = await Promise.all([
    readFile(path.join(repositoryRoot, "docs/GLOSSARY.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/BUILD_PLAN.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/IMPLEMENTATION_GUIDE.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/OPERATIONS_TEST_PLAN.md"), "utf8"),
  ]);

  assert.match(glossary, /after the durability milestone.*lossless resume contract/);
  assert.match(buildPlan, /credentials add\|list\|inspect\|validate\|rotate\|remove/);
  assert.doesNotMatch(operationsPlan, /credentials import-env/);
  assert.match(implementationGuide, /Implement the local no-credential provider adapter/);
  assert.match(implementationGuide, /harden the Phase 5 local no-credential endpoint profile/);
});
