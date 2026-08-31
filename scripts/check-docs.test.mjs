import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants as fileSystemConstants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

const legacyProductName = ["Guarded", "Agent"].join(" ");
const legacyFixtureSentence = ["Guarded", "agents", "transform", "bounded", "data."].join(
  " "
);
const legacyFixtureResult = legacyFixtureSentence.toUpperCase();
const legacyFixturePatternSource = `${legacyFixtureSentence.slice(0, -1)}\\.`;
const legacyFixtureResultPatternSource = `${legacyFixtureResult.slice(0, -1)}\\.`;
const legacyPackageSlug = ["guarded", "agent"].join("-");
const legacyCliPackageName = ["@guard", "cli"].join("/");
const legacyExecutableName = ["gu", "ard"].join("");
const repositoryOwner = "Zachshotamartin";
const maximumTrackedIdentityBytes = 16 * 1024 * 1024;
const maximumTrackedJsonIdentityBytes = 4 * 1024 * 1024;
const maximumAggregateIdentityBytes = 256 * 1024 * 1024;
const maximumIdentityDecodingLayers = 8;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const legacyProductPattern = new RegExp(
  `\\b${escapeRegExp(legacyProductName)}s?\\b`,
  "giu"
);
const legacyPackageSlugPattern = new RegExp(
  `\\b${escapeRegExp(legacyPackageSlug)}\\b`,
  "giu"
);
const legacyRepositoryUrlPattern = new RegExp(
  `(?:git\\+https?://github\\.com/|https?://github\\.com/|git@github\\.com:)${escapeRegExp(repositoryOwner)}/${escapeRegExp(legacyPackageSlug)}(?=\\.git\\b|\\b)`,
  "giu"
);
const legacyInstallTargetPattern = new RegExp(
  `(?:${escapeRegExp(legacyPackageSlug)}|${escapeRegExp(legacyCliPackageName)})(?![A-Za-z0-9._-])`,
  "giu"
);
const legacyCliPackagePattern = new RegExp(
  `(?<![A-Za-z0-9._-])${escapeRegExp(legacyCliPackageName)}(?![A-Za-z0-9._-])`,
  "giu"
);
const packageManagerVerbs = new Map([
  [
    "npm",
    new Set([
      "add",
      "i",
      "in",
      "ins",
      "inst",
      "insta",
      "instal",
      "install",
      "isnt",
      "isnta",
      "isntal",
      "isntall",
      "it",
      "x",
      "exec",
    ]),
  ],
  ["pnpm", new Set(["i", "install", "add", "dlx", "exec"])],
  ["yarn", new Set(["add", "dlx", "exec"])],
  ["bun", new Set(["i", "install", "add", "x"])],
]);

// These are protocol/history fixtures, not current public product identity. Each
// exception is pinned to a path, exact surrounding text, and occurrence count so
// an unrelated legacy label in the same file still fails the architecture check.
const legacyProductReferenceAllowlist = [
  // Normative rule text and accepted historical ADR prose.
  ["docs/BUILD_PLAN.md", `\`${legacyProductName}\` product label after R0.`, 1],
  [
    "docs/decisions/ADR-0002-uuidv7-identifier-generation.md",
    `${legacyProductName} identifiers must be opaque, sortable, validated at every boundary`,
    1,
  ],
  [
    "docs/decisions/ADR-0007-robin-coding-agent-product-pivot.md",
    `repository was renamed from ${legacyProductName} to Robin`,
    1,
  ],
  // Byte-exact deterministic sample text and the assertions that protect it.
  ["apps/cli/src/subprocess.test.ts", legacyFixtureResultPatternSource, 1],
  ["packages/capability-synthetic/src/synthetic-capability.test.ts", legacyFixtureSentence, 2],
  ["packages/capability-synthetic/src/synthetic-capability.ts", legacyFixtureSentence, 2],
  ["packages/milestone-a-scenarios/fixtures/synthetic-transform.broker-current.history.json", legacyFixtureSentence, 3],
  ["packages/milestone-a-scenarios/fixtures/synthetic-transform.broker-current.history.json", legacyFixtureResult, 3],
  ["packages/milestone-a-scenarios/fixtures/synthetic-transform.history.json", legacyFixtureSentence, 3],
  ["packages/milestone-a-scenarios/fixtures/synthetic-transform.history.json", legacyFixtureResult, 3],
  ["packages/milestone-a-scenarios/src/scenarios.test.ts", legacyFixtureResult, 1],
  ["packages/milestone-a-scenarios/src/synthetic-scenario.ts", legacyFixtureSentence, 1],
  ["packages/milestone-b-scenarios/fixtures/generic-safe.history.json", legacyFixtureSentence, 3],
  ["packages/milestone-b-scenarios/fixtures/generic-safe.history.json", legacyFixtureResult, 4],
  ["packages/milestone-b-scenarios/fixtures/generic-safe.provider-requests.json", legacyFixtureSentence, 2],
  ["packages/milestone-b-scenarios/fixtures/generic-safe.provider-requests.json", legacyFixtureResult, 1],
  ["packages/milestone-b-scenarios/src/gate-b.test.ts", legacyFixturePatternSource, 1],
  ["packages/milestone-b-scenarios/src/gate-b.test.ts", legacyFixtureResultPatternSource, 1],
  ["packages/milestone-b-scenarios/src/safe-scenarios.ts", legacyFixtureSentence, 1],
];

function exactContextRanges(relativeFile, contents) {
  const ranges = [];

  for (const [allowedFile, context, expectedOccurrences] of legacyProductReferenceAllowlist) {
    if (allowedFile !== relativeFile) {
      continue;
    }
    let offset = 0;
    let occurrences = 0;

    while (offset <= contents.length) {
      const contextOffset = contents.indexOf(context, offset);
      if (contextOffset === -1) {
        break;
      }
      ranges.push({
        start: contextOffset,
        end: contextOffset + context.length,
      });
      occurrences += 1;
      offset = contextOffset + context.length;
    }

    assert.equal(
      occurrences,
      expectedOccurrences,
      `${relativeFile} identity allowlist drifted for ${JSON.stringify(context)}`
    );
  }

  return ranges;
}

function isInsideRange(offset, ranges) {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

function lineNumberAt(contents, offset) {
  return contents.slice(0, offset).split("\n").length;
}

function excerptAt(contents, offset) {
  const lineStart = contents.lastIndexOf("\n", offset - 1) + 1;
  const nextNewline = contents.indexOf("\n", offset);
  const lineEnd = nextNewline === -1 ? contents.length : nextNewline;
  const line = contents.slice(lineStart, lineEnd).trim();
  return line.length <= 180 ? line : `${line.slice(0, 177)}...`;
}

function textViolation(kind, relativeFile, contents, match) {
  return {
    kind,
    location: `${relativeFile}:${lineNumberAt(contents, match.index)}`,
    excerpt: excerptAt(contents, match.index),
  };
}

function matchingRanges(contents, pattern) {
  return [...contents.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function legacyInstallCommandMatches(contents) {
  const matches = [];
  let lineOffset = 0;
  const logicalContents = contents.replace(/\\(?:\r\n|\r|\n)/gu, (match) =>
    " ".repeat(match.length)
  );

  for (const line of logicalContents.split(/\r\n|\r|\n/u)) {
    for (const targetMatch of line.matchAll(legacyInstallTargetPattern)) {
      const targetOffset = targetMatch.index;
      if (isPackageManagerInstallPrefix(line.slice(0, targetOffset))) {
        matches.push({
          0: targetMatch[0],
          index: lineOffset + targetOffset,
        });
      }
    }
    lineOffset += line.length + 1;
  }

  return matches;
}

function isPackageManagerInstallPrefix(prefix) {
  const tokens = prefix
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) =>
      token
        .toLowerCase()
        .replace(/^[^a-z0-9@]+|[^a-z0-9@._:-]+$/gu, "")
    )
    .filter(Boolean);

  if (
    tokens.some((token) =>
      ["npx", "bunx"].includes(normalizedExecutableName(token))
    )
  ) {
    return true;
  }
  for (const [manager, verbs] of packageManagerVerbs) {
    const managerIndex = tokens.findIndex(
      (token) => normalizedExecutableName(token) === manager
    );
    if (
      managerIndex !== -1 &&
      tokens.some((candidate, index) => index > managerIndex && verbs.has(candidate))
    ) {
      return true;
    }
  }
  return false;
}

function normalizedExecutableName(value) {
  if (typeof value !== "string") return null;
  const slashNormalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const colonParts = path.posix
    .basename(slashNormalized)
    .split(":")
    .filter(Boolean);
  return colonParts.at(-1)?.toLowerCase() ?? null;
}

function collectLegacyBinMappings(value, jsonPath = "$") {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectLegacyBinMappings(entry, `${jsonPath}[${index}]`)
    );
  }
  if (value === null || typeof value !== "object") {
    return [];
  }

  const mappings = [];
  if (Object.hasOwn(value, "bin")) {
    if (isPlainRecord(value.bin)) {
      for (const executableName of Object.keys(value.bin)) {
        if (normalizedExecutableName(executableName) === legacyExecutableName) {
          mappings.push(`${jsonPath}.bin[${JSON.stringify(executableName)}]`);
        }
      }
    } else if (typeof value.bin === "string" || Array.isArray(value.bin)) {
      const packageExecutable = normalizedExecutableName(value.name);
      const binEntries = Array.isArray(value.bin) ? value.bin : [value.bin];
      if (
        packageExecutable === legacyExecutableName ||
        binEntries.some(
          (entry) => normalizedExecutableName(entry) === legacyExecutableName
        )
      ) {
        mappings.push(`${jsonPath}.bin`);
      }
    }
  }
  if (
    isPlainRecord(value.directories) &&
    Object.hasOwn(value.directories, "bin")
  ) {
    mappings.push(`${jsonPath}.directories.bin`);
  }
  for (const [key, entry] of Object.entries(value)) {
    mappings.push(
      ...collectLegacyBinMappings(entry, `${jsonPath}[${JSON.stringify(key)}]`)
    );
  }
  return mappings;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPackageMetadataFile(relativeFile) {
  return ["package.json", "package-lock.json", "npm-shrinkwrap.json"].includes(
    path.posix.basename(relativeFile)
  );
}

function publicIdentityViolations(
  relativeFile,
  contents,
  allowedLegacyRanges = [],
  { parsePackageMetadata = true } = {}
) {
  const violations = [];
  const remoteRanges = matchingRanges(contents, legacyRepositoryUrlPattern);
  const installMatches = legacyInstallCommandMatches(contents);
  const installRanges = installMatches.map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));

  for (const match of contents.matchAll(legacyRepositoryUrlPattern)) {
    violations.push(textViolation("legacy GitHub repository URL", relativeFile, contents, match));
  }
  for (const match of installMatches) {
    violations.push(textViolation("legacy public install command", relativeFile, contents, match));
  }
  for (const match of contents.matchAll(legacyPackageSlugPattern)) {
    if (!isInsideRange(match.index, [...remoteRanges, ...installRanges])) {
      violations.push(textViolation("legacy package slug", relativeFile, contents, match));
    }
  }
  for (const match of contents.matchAll(legacyCliPackagePattern)) {
    if (!isInsideRange(match.index, installRanges)) {
      violations.push(
        textViolation("legacy CLI package identity", relativeFile, contents, match)
      );
    }
  }
  for (const match of contents.matchAll(legacyProductPattern)) {
    if (!isInsideRange(match.index, allowedLegacyRanges)) {
      violations.push(textViolation("legacy public product label", relativeFile, contents, match));
    }
  }

  if (
    parsePackageMetadata &&
    isPackageMetadataFile(relativeFile)
  ) {
    let metadata;
    try {
      metadata = JSON.parse(contents);
    } catch (error) {
      violations.push({
        kind: "unparseable public package metadata",
        location: relativeFile,
        excerpt: error instanceof Error ? error.message : String(error),
      });
      return violations;
    }
    for (const mappingPath of collectLegacyBinMappings(metadata)) {
      violations.push({
        kind: "legacy public executable mapping",
        location: `${relativeFile}:${mappingPath}`,
        excerpt: `bin.${legacyExecutableName}`,
      });
    }
  }

  return violations;
}

function decodedJsonIdentityText(contents, relativeFile) {
  const encodedBytes = Buffer.byteLength(contents, "utf8");
  if (encodedBytes > maximumTrackedJsonIdentityBytes) {
    return {
      violations: [
        {
          kind: "unbounded tracked JSON identity input",
          location: relativeFile,
          excerpt: `encoded JSON exceeds ${maximumTrackedJsonIdentityBytes} bytes`,
        },
      ],
      text: "",
    };
  }
  let root;
  try {
    root = JSON.parse(contents);
  } catch (error) {
    return {
      violations: [
        {
          kind: "unparseable tracked JSON",
          location: relativeFile,
          excerpt: error instanceof Error ? error.message : String(error),
        },
      ],
      text: "",
    };
  }

  const strings = [];
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > 1_000_000) {
      return {
        violations: [
          {
            kind: "unbounded tracked JSON identity input",
            location: relativeFile,
            excerpt: "more than 1000000 JSON nodes",
          },
        ],
        text: "",
      };
    }
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value, "utf8");
      if (bytes > maximumTrackedIdentityBytes) {
        return {
          violations: [
            {
              kind: "unbounded tracked JSON identity input",
              location: relativeFile,
              excerpt: `decoded strings exceed ${maximumTrackedIdentityBytes} bytes`,
            },
          ],
          text: "",
        };
      }
      const nested = parseNestedJsonString(value);
      if (nested !== undefined) {
        if (depth >= maximumIdentityDecodingLayers) {
          return {
            violations: [
              {
                kind: "unbounded tracked JSON identity input",
                location: relativeFile,
                excerpt: `nested JSON exceeds ${maximumIdentityDecodingLayers} decoding layers`,
              },
            ],
            text: "",
          };
        }
        stack.push({ value: nested, depth: depth + 1 });
      }
      if (nested === undefined) strings.push(value);
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth });
      }
    } else if (isPlainRecord(value)) {
      for (const [key, entry] of Object.entries(value).reverse()) {
        stack.push({ value: entry, depth });
        stack.push({ value: key, depth });
      }
    }
  }
  return { violations: [], text: strings.join("\n") };
}

function parseNestedJsonString(value) {
  const trimmed = value.trim();
  if (
    trimmed.length < 2 ||
    !["{", "[", '"'].includes(trimmed[0])
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" && parsed === value ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function percentDecodedIdentityText(contents) {
  let decoded = contents;
  for (let pass = 0; pass < maximumIdentityDecodingLayers; pass += 1) {
    const next = decodeHtmlIdentityEntities(
      decoded.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (encoded) => {
        try {
          return decodeURIComponent(encoded);
        } catch {
          return encoded;
        }
      })
    );
    if (next === decoded) break;
    decoded = next;
  }
  const oneMore = decodeHtmlIdentityEntities(
    decoded.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    })
  );
  assert.equal(
    oneMore,
    decoded,
    `identity encoding exceeds ${maximumIdentityDecodingLayers} decoding layers`
  );
  return decoded === contents ? null : decoded;
}

function decodeHtmlIdentityEntities(contents) {
  const named = new Map([
    ["amp", "&"],
    ["colon", ":"],
    ["commat", "@"],
    ["equals", "="],
    ["hyphen", "-"],
    ["newline", "\n"],
    ["nbsp", " "],
    ["num", "#"],
    ["period", "."],
    ["quest", "?"],
    ["sol", "/"],
    ["tab", "\t"],
  ]);
  return contents.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|colon|commat|equals|hyphen|newline|nbsp|num|period|quest|sol|tab);/giu,
    (encoded, body) => {
      const normalized = body.toLowerCase();
      if (!normalized.startsWith("#")) return named.get(normalized) ?? encoded;
      const hexadecimal = normalized.startsWith("#x");
      const codePoint = Number.parseInt(
        normalized.slice(hexadecimal ? 2 : 1),
        hexadecimal ? 16 : 10
      );
      return Number.isSafeInteger(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : encoded;
    }
  );
}

function trackedTextIdentityViolations(
  relativeFile,
  contents,
  { decodeJson = true, isSymbolicLink = false } = {}
) {
  const violations = publicIdentityViolations(
    relativeFile,
    contents,
    exactContextRanges(relativeFile, contents),
    { parsePackageMetadata: !isSymbolicLink }
  );
  if (isSymbolicLink && isPackageMetadataFile(relativeFile)) {
    violations.push({
      kind: "symlinked public package metadata",
      location: relativeFile,
      excerpt: "package metadata must be a tracked regular file",
    });
  }
  const percentDecoded = percentDecodedIdentityText(contents);
  const isJson = decodeJson && /\.json$/iu.test(relativeFile);
  if (percentDecoded !== null && !isJson) {
    violations.push(
      ...publicIdentityViolations(
        relativeFile,
        percentDecoded,
        exactContextRanges(relativeFile, percentDecoded),
        { parsePackageMetadata: false }
      )
    );
  }
  if (!isJson) return violations;

  const decoded = decodedJsonIdentityText(contents, relativeFile);
  violations.push(...decoded.violations);
  if (decoded.violations.length === 0) {
    violations.push(
      ...publicIdentityViolations(
        relativeFile,
        decoded.text,
        exactContextRanges(relativeFile, decoded.text),
        { parsePackageMetadata: false }
      )
    );
    const decodedPercent = percentDecodedIdentityText(decoded.text);
    if (decodedPercent !== null) {
      violations.push(
        ...publicIdentityViolations(
          relativeFile,
          decodedPercent,
          exactContextRanges(relativeFile, decodedPercent),
          { parsePackageMetadata: false }
        )
      );
    }
  }
  return violations;
}

async function readTrackedIdentityText(relativeFile, root = repositoryRoot) {
  const absolutePath = path.join(root, relativeFile);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    const contents = await readlink(absolutePath, "utf8");
    const bytes = Buffer.byteLength(contents, "utf8");
    assert.ok(
      bytes <= maximumTrackedIdentityBytes,
      `${relativeFile} symbolic-link blob exceeds the identity scan bound`
    );
    return { contents, bytes, isSymbolicLink: true };
  }
  assert.equal(
    metadata.isFile(),
    true,
    `${relativeFile} must be a regular file or a scanned symbolic-link blob`
  );
  assert.ok(
    metadata.size <= maximumTrackedIdentityBytes,
    `${relativeFile} exceeds the ${maximumTrackedIdentityBytes}-byte identity scan bound`
  );
  const handle = await open(
    absolutePath,
    fileSystemConstants.O_RDONLY | (fileSystemConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const openedMetadata = await handle.stat();
    assert.equal(openedMetadata.isFile(), true, `${relativeFile} changed file type`);
    assert.equal(openedMetadata.dev, metadata.dev, `${relativeFile} changed while opening`);
    assert.equal(openedMetadata.ino, metadata.ino, `${relativeFile} changed while opening`);
    assert.ok(
      openedMetadata.size <= maximumTrackedIdentityBytes,
      `${relativeFile} changed beyond the identity scan bound while being opened`
    );
    const bytes = await readBoundedHandle(
      handle,
      maximumTrackedIdentityBytes,
      relativeFile
    );
    assert.ok(
      bytes.length <= maximumTrackedIdentityBytes,
      `${relativeFile} changed beyond the identity scan bound while being read`
    );
    const completedMetadata = await handle.stat();
    assert.equal(completedMetadata.dev, openedMetadata.dev, `${relativeFile} changed device while reading`);
    assert.equal(completedMetadata.ino, openedMetadata.ino, `${relativeFile} changed inode while reading`);
    assert.equal(completedMetadata.size, bytes.length, `${relativeFile} changed size while reading`);
    assert.equal(completedMetadata.mtimeMs, openedMetadata.mtimeMs, `${relativeFile} changed content time while reading`);
    return {
      contents: bytes.toString("utf8"),
      bytes: bytes.length,
      isSymbolicLink: false,
    };
  } finally {
    await handle.close();
  }
}

async function readBoundedHandle(handle, maximumBytes, relativeFile) {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      null
    );
    if (bytesRead === 0) return buffer.subarray(0, offset);
    offset += bytesRead;
  }
  assert.fail(`${relativeFile} exceeded the identity scan bound while being read`);
}

async function gitTrackedFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean).sort();
}

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

test("public identity classifier rejects every retired external surface", () => {
  const fixtures = [
    {
      relativeFile: "README.md",
      contents: `# ${legacyProductName}\n`,
      expectedKind: "legacy public product label",
    },
    {
      relativeFile: "README.md",
      contents: `Download the ${legacyPackageSlug} release archive.\n`,
      expectedKind: "legacy package slug",
    },
    {
      relativeFile: "README.md",
      contents: `npm install --global ${legacyCliPackageName}\n`,
      expectedKind: "legacy public install command",
    },
    {
      relativeFile: "package.json",
      contents: JSON.stringify({
        repository: {
          url: `git+https://github.com/${repositoryOwner}/${legacyPackageSlug}.git`,
        },
      }),
      expectedKind: "legacy GitHub repository URL",
    },
    {
      relativeFile: "apps/example/package.json",
      contents: JSON.stringify({
        bin: { [legacyExecutableName]: "./dist/bin.js" },
      }),
      expectedKind: "legacy public executable mapping",
    },
  ];

  for (const fixture of fixtures) {
    assert.deepEqual(
      publicIdentityViolations(fixture.relativeFile, fixture.contents).map(
        (violation) => violation.kind
      ),
      [fixture.expectedKind],
      `${fixture.expectedKind} fixture was not rejected`
    );
  }

  for (const command of [
    `npm add ${legacyCliPackageName}`,
    `npm in ${legacyCliPackageName}`,
    `npm ins ${legacyCliPackageName}`,
    `npm it ${legacyCliPackageName}`,
    `npm x ${legacyCliPackageName}`,
    `/usr/bin/npm install ${legacyCliPackageName}`,
    `npm --global install ${legacyCliPackageName}`,
    `pnpm i ${legacyCliPackageName}`,
    `yarn global add ${legacyCliPackageName}`,
    `bunx ${legacyCliPackageName}`,
    `Run \`npm install ${legacyCliPackageName}\`.`,
    `npm install \\\n+${legacyCliPackageName}`,
  ]) {
    assert.deepEqual(
      publicIdentityViolations("README.md", `${command}\n`).map(
        (violation) => violation.kind
      ),
      ["legacy public install command"],
      `${command} was not rejected`
    );
  }
  assert.deepEqual(
    publicIdentityViolations(
      "README.md",
      `Mention ${legacyCliPackageName}; then npm install ${legacyCliPackageName}\n`
    ).map((violation) => violation.kind),
    ["legacy public install command", "legacy CLI package identity"],
    "plain mention and later install must both be rejected"
  );
  assert.deepEqual(
    publicIdentityViolations(
      "README.md",
      "npm install @guard/client\n"
    ),
    [],
    "a longer nonlegacy package name must not be prefix-matched"
  );
  assert.deepEqual(
    publicIdentityViolations(
      "apps/example/package.json",
      JSON.stringify({ dependencies: { [legacyCliPackageName]: "1.0.0" } })
    ).map((violation) => violation.kind),
    ["legacy CLI package identity"],
    "retired CLI package metadata was not rejected"
  );

  for (const bin of [
    { robin: "./dist/bin.js", [`./${legacyExecutableName}`]: "./legacy.js" },
    { [`prefix:${legacyExecutableName}`]: "./legacy.js" },
    { [`prefix:${legacyExecutableName}:`]: "./legacy.js" },
    [`./${legacyExecutableName}`],
    [`prefix:${legacyExecutableName}`],
    [`prefix:${legacyExecutableName}:`],
    `./${legacyExecutableName}`,
    `${legacyExecutableName}:`,
  ]) {
    assert.deepEqual(
      publicIdentityViolations(
        "apps/example/package.json",
        JSON.stringify({ name: legacyExecutableName, bin })
      ).map((violation) => violation.kind),
      ["legacy public executable mapping"],
      `npm-normalized bin mapping ${JSON.stringify(bin)} was not rejected`
    );
  }
  assert.deepEqual(
    publicIdentityViolations(
      "apps/example/package.json",
      JSON.stringify({ directories: { bin: "./bin" } })
    ).map((violation) => violation.kind),
    ["legacy public executable mapping"],
    "npm directories.bin mapping was not rejected"
  );

  assert.deepEqual(
    trackedTextIdentityViolations(
      "README.md",
      `# ${legacyProductName.replace(" ", "&nbsp;")}\n`
    ).map((violation) => violation.kind),
    ["legacy public product label"],
    "HTML-entity product identity was not rejected"
  );

  let excessivelyNestedJson = legacyProductName.replace(" ", "\\u0020");
  for (let layer = 0; layer < maximumIdentityDecodingLayers + 2; layer += 1) {
    excessivelyNestedJson = JSON.stringify(excessivelyNestedJson);
  }
  assert.deepEqual(
    trackedTextIdentityViolations("nested.json", excessivelyNestedJson).map(
      (violation) => violation.kind
    ),
    ["unbounded tracked JSON identity input"],
    "excessively nested JSON identity encoding must fail closed"
  );

  const escapedLegacyProduct = JSON.stringify({ title: legacyProductName }).replace(
    " ",
    "\\u0020"
  );
  assert.deepEqual(
    trackedTextIdentityViolations("metadata.json", escapedLegacyProduct).map(
      (violation) => violation.kind
    ),
    ["legacy public product label"],
    "JSON-escaped product identity was not rejected"
  );
  const nestedEscapedLegacyProduct = JSON.stringify({
    payload: JSON.stringify({ title: legacyProductName }).replace(" ", "\\u0020"),
  });
  assert.deepEqual(
    trackedTextIdentityViolations(
      "metadata.JSON",
      nestedEscapedLegacyProduct
    ).map((violation) => violation.kind),
    ["legacy public product label"],
    "nested JSON-escaped product identity was not rejected"
  );
  assert.deepEqual(
    trackedTextIdentityViolations(
      "metadata.json",
      JSON.stringify({
        repository: `https://github.com/${repositoryOwner}/${[
          "guarded",
          "%2Dagent",
        ].join("")}`,
      })
    ).map((violation) => violation.kind),
    ["legacy GitHub repository URL"],
    "percent-encoded repository identity was not rejected"
  );
  for (const relativeFile of [
    "nested/package-lock.json",
    "nested/npm-shrinkwrap.json",
  ]) {
    assert.deepEqual(
      publicIdentityViolations(
        relativeFile,
        JSON.stringify({ packages: { nested: { bin: { "prefix:guard": "x" } } } })
      ).map((violation) => violation.kind),
      ["legacy public executable mapping"],
      `${relativeFile} nested bin mapping was not rejected`
    );
  }
  assert.deepEqual(
    publicIdentityViolations("README.md", `\0# ${legacyProductName}\n`).map(
      (violation) => violation.kind
    ),
    ["legacy public product label"],
    "a NUL byte must not exempt the rest of a tracked text file"
  );

  assert.deepEqual(
    publicIdentityViolations(
      "packages/contracts/package.json",
      JSON.stringify({ name: "@guard/contracts" })
    ),
    [],
    "private workspace package identifiers remain stable"
  );
  assert.deepEqual(
    publicIdentityViolations(
      "docs/policy-language.md",
      "Internal policy.guard and guard.base protocol identifiers remain stable.\n"
    ),
    [],
    "policy-language and serialized protocol identifiers remain stable"
  );

  const historicalPath =
    "docs/decisions/ADR-0007-robin-coding-agent-product-pivot.md";
  const historicalContext = `The repository was renamed from ${legacyProductName} to Robin.`;
  assert.deepEqual(
    publicIdentityViolations(
      historicalPath,
      historicalContext,
      exactContextRanges(historicalPath, historicalContext)
    ),
    [],
    "the exact historical context remains allowed"
  );
  const leakedHeading = `${historicalContext}\n# ${legacyProductName}\n`;
  assert.deepEqual(
    publicIdentityViolations(
      historicalPath,
      leakedHeading,
      exactContextRanges(historicalPath, leakedHeading)
    ).map((violation) => violation.kind),
    ["legacy public product label"],
    "the path allowlist must not excuse a new product heading"
  );
});

test(
  "tracked identity reads inspect a symbolic-link blob without following it",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "robin-identity-symlink-"));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const target = path.join(root, "outside-target.txt");
    const linkTarget = path.join(root, "outside-target.txt");
    await writeFile(target, `# ${legacyProductName}\n`, "utf8");
    await symlink(linkTarget, path.join(root, "tracked-link.txt"));

    assert.equal(
      (await readTrackedIdentityText("tracked-link.txt", root)).contents,
      linkTarget
    );

    await writeFile(
      path.join(root, "m"),
      JSON.stringify({
        name: "symlink-probe",
        version: "1.0.0",
        bin: { [legacyExecutableName]: "bin.js" },
      }),
      "utf8"
    );
    await symlink("m", path.join(root, "package.json"));
    const symlinkedPackage = await readTrackedIdentityText("package.json", root);
    assert.deepEqual(
      trackedTextIdentityViolations(
        "package.json",
        symlinkedPackage.contents,
        { decodeJson: false, isSymbolicLink: true }
      ).map((violation) => violation.kind),
      ["symlinked public package metadata"],
      "tracked package metadata symlinks must fail closed instead of scanning only the link blob"
    );
  }
);

test("Git-tracked public text exposes only Robin's current product identity", async () => {
  const trackedFiles = await gitTrackedFiles();
  const trackedFileSet = new Set(trackedFiles);

  assert.ok(trackedFileSet.has("README.md"), "identity scan is missing README.md");
  assert.ok(trackedFileSet.has("package-lock.json"), "identity scan is missing package-lock.json");
  assert.deepEqual(
    trackedFiles.filter((relativeFile) => relativeFile.split("/").includes("dist")),
    [],
    "generated dist output must not be an identity-scan input"
  );
  assert.deepEqual(
    [...new Set(legacyProductReferenceAllowlist.map(([relativeFile]) => relativeFile))].filter(
      (relativeFile) => !trackedFileSet.has(relativeFile)
    ),
    [],
    "identity allowlist contains an untracked path"
  );

  const violations = [];
  let aggregateBytes = 0;
  for (const relativeFile of trackedFiles) {
    const identityInput = await readTrackedIdentityText(relativeFile);
    aggregateBytes += identityInput.bytes;
    assert.ok(
      aggregateBytes <= maximumAggregateIdentityBytes,
      `tracked identity input exceeds ${maximumAggregateIdentityBytes} aggregate bytes`
    );
    violations.push(
      ...trackedTextIdentityViolations(
        relativeFile,
        identityInput.contents,
        {
          decodeJson: !identityInput.isSymbolicLink,
          isSymbolicLink: identityInput.isSymbolicLink,
        }
      )
    );
  }

  assert.deepEqual(
    violations,
    [],
    `tracked public identity violations:\n${violations
      .map(
        (violation) =>
          `- ${violation.kind} at ${violation.location}: ${violation.excerpt}`
      )
      .join("\n")}`
  );
});

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
  assert.match(readme, /R1 is accepted[^.]*fb64cf1/i);
  assert.match(readme, /R2[^.]*not current release claims/i);
  assert.match(readme, /credential-free synthetic model provider/i);
  assert.match(readme, /node apps\/cli\/dist\/bin\.js run --profile coding-virtual/);
  assert.match(readme, /selecting a real provider[^.]*configuration error/i);
  assert.match(readme, /robin --continue/);
  assert.doesNotMatch(
    readme,
    new RegExp(`^# ${escapeRegExp(legacyProductName)}$`, "mu")
  );
  assert.doesNotMatch(
    readme,
    new RegExp(
      `${escapeRegExp(legacyProductName)} is a general policy-enforced agent runtime`,
      "iu"
    )
  );

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
  assert.equal(cliManifest.name, "@zachshotamartin/robin");
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
  assert.deepEqual(cliManifest.bin, { robin: "./dist/bin.js" });
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
