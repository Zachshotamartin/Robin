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
