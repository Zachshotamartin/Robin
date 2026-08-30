import assert from "node:assert/strict";
import test from "node:test";

import { formatGuardDocument } from "./formatter.js";
import { parseGuardDocument } from "./parser.js";
import { projectGuardDocumentSemantics } from "./semantics.js";

test("bounded seeded policy generation structurally round-trips", () => {
  const random = mulberry32(0x47554152);
  for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
    const policyCount = 1 + integer(random, 4);
    const policies: string[] = [];
    for (let policyIndex = 0; policyIndex < policyCount; policyIndex += 1) {
      policies.push(`policy "generated-${caseIndex}-${policyIndex}" priority ${integer(random, 1_000)} {
  when ${expression(random, 0)}
  ${pick(random, ["allow", "deny", "require_approval"])}
  reason "seeded case ${caseIndex} rule ${policyIndex}"
}`);
    }
    const source = policies.join("\n\n");
    const first = parseGuardDocument(source, { sourceId: `generated-${caseIndex}.guard` });
    assert.equal(first.ok, true, diagnostics(first.diagnostics));
    const canonical = formatGuardDocument(first.document);
    const second = parseGuardDocument(canonical, { sourceId: `canonical-${caseIndex}.guard` });
    assert.equal(second.ok, true, diagnostics(second.diagnostics));
    assert.deepEqual(
      projectGuardDocumentSemantics(second.document),
      projectGuardDocumentSemantics(first.document),
      `semantic mismatch for generated case ${caseIndex}`,
    );
    assert.equal(formatGuardDocument(second.document), canonical);
  }
});

function expression(random: () => number, depth: number): string {
  if (depth >= 3) {
    return primary(random, depth);
  }
  switch (integer(random, 6)) {
    case 0:
      return `${primary(random, depth + 1)} and ${expression(random, depth + 1)}`;
    case 1:
      return `${primary(random, depth + 1)} or ${expression(random, depth + 1)}`;
    case 2:
      return `not ${primary(random, depth + 1)}`;
    case 3:
      return `(${expression(random, depth + 1)})`;
    default:
      return primary(random, depth + 1);
  }
}

function primary(random: () => number, depth: number): string {
  if (integer(random, 6) === 0) {
    return `exists(${pick(random, ["repo.path", "resource.host", "request.intent"])})`;
  }
  const attribute = pick(random, [
    "action.operation",
    "action.pack",
    "repo.path",
    "resource.host",
    "request.intent",
    "environment.sandboxed",
  ]);
  const operator = pick(random, ["==", "!=", "in", "matches", "starts_with"]);
  return `${attribute} ${operator} ${value(random, depth)}`;
}

function value(random: () => number, depth: number): string {
  switch (integer(random, depth >= 3 ? 3 : 4)) {
    case 0:
      return JSON.stringify(pick(random, ["read", "write", "**/.env*", "é😀", ""]));
    case 1:
      return String(integer(random, 500));
    case 2:
      return pick(random, ["true", "false"]);
    default:
      return `[${Array.from(
        { length: integer(random, 4) },
        () => value(random, depth + 1),
      ).join(", ")}]`;
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const selected = values[integer(random, values.length)];
  if (selected === undefined) {
    throw new RangeError("Generator selection was out of range.");
  }
  return selected;
}

function integer(random: () => number, exclusiveMaximum: number): number {
  return Math.floor(random() * exclusiveMaximum);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function diagnostics(values: readonly { readonly code: string; readonly message: string }[]): string {
  return values.map((value) => `${value.code}: ${value.message}`).join("\n");
}
