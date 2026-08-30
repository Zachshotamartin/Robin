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
  assert.ok(files.length >= 7, "expected repository documentation files");

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
