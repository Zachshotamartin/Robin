import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { formatGuardDocument } from "./formatter.js";
import { parseGuardDocument } from "./parser.js";

const EXAMPLES = [
  ["default.guard", 3],
  ["strict.guard", 5],
] as const;

for (const [filename, expectedPolicies] of EXAMPLES) {
  test(`${filename} is reviewed, valid, and canonically formatted`, async () => {
    const url = new URL(`../../../policies/${filename}`, import.meta.url);
    const source = await readFile(url, "utf8");
    const parsed = parseGuardDocument(source, { sourceId: `policies/${filename}` });

    assert.equal(
      parsed.ok,
      true,
      parsed.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"),
    );
    assert.equal(parsed.document.policies.length, expectedPolicies);
    assert.equal(formatGuardDocument(parsed.document), source);
  });
}
