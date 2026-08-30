import { snapshotBoundaryJsonObject } from "@guard/contracts";

import type {
  CompiledGlob,
  CompiledGlobAtom,
  CompiledGlobSegment,
} from "./types.js";

export interface GlobLimits {
  readonly maximumBytes: number;
  readonly maximumSegments: number;
  readonly maximumWildcards: number;
}

export const DEFAULT_GLOB_LIMITS: GlobLimits = Object.freeze({
  maximumBytes: 512,
  maximumSegments: 64,
  maximumWildcards: 64,
});

const COMPILED_GLOBS = new WeakSet<object>();

export class GlobSyntaxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GlobSyntaxError";
    this.code = code;
  }
}

/** Compiles the small v1 path-glob language without creating a RegExp. */
export function compileAnchoredPathGlob(
  source: string,
  limits: GlobLimits = DEFAULT_GLOB_LIMITS,
): CompiledGlob {
  if (typeof source !== "string") {
    throw new TypeError("A path glob must be a string.");
  }
  const parsedLimits = validateLimits(limits);
  if (new TextEncoder().encode(source).byteLength > parsedLimits.maximumBytes) {
    throw syntax("glob_too_large", "The path glob exceeds its byte limit.");
  }
  if (source.length === 0) {
    throw syntax("glob_empty", "A path glob cannot be empty.");
  }
  if (source.normalize("NFC") !== source) {
    throw syntax(
      "glob_not_unicode_canonical",
      "A path glob must use Unicode NFC canonical form.",
    );
  }
  if (
    source.startsWith("/") ||
    source.endsWith("/") ||
    source.includes("\\") ||
    source.includes("\0")
  ) {
    throw syntax(
      "glob_not_canonical",
      "A path glob must be a relative forward-slash path.",
    );
  }
  if ([...source].some((character) => "[]{}".includes(character))) {
    throw syntax(
      "glob_unsupported_syntax",
      "Character classes and brace expansion are not supported in v1 globs.",
    );
  }
  if ([...source].some((character) => isForbiddenControl(character))) {
    throw syntax("glob_control_character", "A path glob contains a control character.");
  }

  const rawSegments = source.split("/");
  if (
    rawSegments.length > parsedLimits.maximumSegments ||
    rawSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw syntax(
      "glob_invalid_segment",
      "A path glob contains an empty, dot, or parent segment, or too many segments.",
    );
  }

  let wildcardCount = 0;
  const segments: CompiledGlobSegment[] = rawSegments.map((segment) => {
    if (segment === "**") {
      wildcardCount += 1;
      return Object.freeze({ recursive: true, atoms: Object.freeze([]) });
    }
    if (segment.includes("**")) {
      throw syntax(
        "glob_invalid_recursive_wildcard",
        "A recursive wildcard must occupy an entire path segment.",
      );
    }
    const atoms: CompiledGlobAtom[] = [];
    let literal = "";
    const flushLiteral = (): void => {
      if (literal.length === 0) return;
      atoms.push(Object.freeze({ kind: "literal", value: literal }));
      literal = "";
    };
    for (const character of segment) {
      if (character === "*") {
        flushLiteral();
        wildcardCount += 1;
        if (atoms.at(-1)?.kind !== "star") {
          atoms.push(Object.freeze({ kind: "star" }));
        }
      } else if (character === "?") {
        flushLiteral();
        wildcardCount += 1;
        atoms.push(Object.freeze({ kind: "single" }));
      } else {
        literal += character;
      }
    }
    flushLiteral();
    return Object.freeze({ recursive: false, atoms: Object.freeze(atoms) });
  });
  if (wildcardCount > parsedLimits.maximumWildcards) {
    throw syntax("glob_too_complex", "The path glob exceeds its wildcard limit.");
  }
  const compiled = Object.freeze({ source, segments: Object.freeze(segments) });
  COMPILED_GLOBS.add(compiled);
  return compiled;
}

/** Anchored, case-sensitive matching over an already canonical path. */
export function matchAnchoredPathGlob(glob: CompiledGlob, path: string): boolean {
  if (!COMPILED_GLOBS.has(glob) || typeof path !== "string") {
    throw new TypeError("Matching requires a recognized compiled glob and string path.");
  }
  const pathSegments = canonicalPathSegments(path);
  const memo = new Map<string, boolean>();
  const visit = (globIndex: number, pathIndex: number): boolean => {
    const key = `${globIndex}:${pathIndex}`;
    const previous = memo.get(key);
    if (previous !== undefined) return previous;
    const segment = glob.segments[globIndex];
    let result: boolean;
    if (segment === undefined) {
      result = pathIndex === pathSegments.length;
    } else if (segment.recursive) {
      result =
        visit(globIndex + 1, pathIndex) ||
        (pathIndex < pathSegments.length && visit(globIndex, pathIndex + 1));
    } else {
      const candidate = pathSegments[pathIndex];
      result =
        candidate !== undefined &&
        matchSegment(segment, candidate) &&
        visit(globIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

export function isCanonicalPolicyPath(path: string): boolean {
  try {
    canonicalPathSegments(path);
    return true;
  } catch {
    return false;
  }
}

function canonicalPathSegments(path: string): readonly string[] {
  if (
    path.length === 0 ||
    path.normalize("NFC") !== path ||
    new TextEncoder().encode(path).byteLength > 4096 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    [...path].some((character) => "[]{}*?".includes(character)) ||
    [...path].some((character) => isForbiddenControl(character))
  ) {
    throw syntax("path_not_canonical", "A matched path is not canonical.");
  }
  const segments = path.split("/");
  if (
    segments.length > 256 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw syntax("path_not_canonical", "A matched path is not canonical.");
  }
  return segments;
}

function matchSegment(segment: CompiledGlobSegment, value: string): boolean {
  const characters = [...value];
  const memo = new Map<string, boolean>();
  const visit = (atomIndex: number, characterIndex: number): boolean => {
    const key = `${atomIndex}:${characterIndex}`;
    const previous = memo.get(key);
    if (previous !== undefined) return previous;
    const atom = segment.atoms[atomIndex];
    let result: boolean;
    if (atom === undefined) {
      result = characterIndex === characters.length;
    } else if (atom.kind === "star") {
      result =
        visit(atomIndex + 1, characterIndex) ||
        (characterIndex < characters.length && visit(atomIndex, characterIndex + 1));
    } else if (atom.kind === "single") {
      result =
        characterIndex < characters.length &&
        visit(atomIndex + 1, characterIndex + 1);
    } else {
      const literal = [...atom.value];
      result = literal.every(
        (character, offset) => characters[characterIndex + offset] === character,
      ) && visit(atomIndex + 1, characterIndex + literal.length);
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

function validateLimits(limits: GlobLimits): GlobLimits {
  const parsed = snapshotBoundaryJsonObject(limits);
  const expected = ["maximumBytes", "maximumSegments", "maximumWildcards"];
  if (
    Object.keys(parsed).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(parsed, key))
  ) {
    throw new TypeError("Glob limits have unknown or missing properties.");
  }
  for (const value of [
    parsed["maximumBytes"],
    parsed["maximumSegments"],
    parsed["maximumWildcards"],
  ]) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Glob limits must be positive safe integers.");
    }
  }
  return Object.freeze({
    maximumBytes: parsed["maximumBytes"] as number,
    maximumSegments: parsed["maximumSegments"] as number,
    maximumWildcards: parsed["maximumWildcards"] as number,
  });
}

function isForbiddenControl(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
}

function syntax(code: string, message: string): GlobSyntaxError {
  return new GlobSyntaxError(code, message);
}
