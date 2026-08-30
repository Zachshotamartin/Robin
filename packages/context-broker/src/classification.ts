import { createDomainError } from "@guard/contracts";
import type { JsonValue } from "@guard/contracts";

import { deepFreeze, snapshotBoundaryObject } from "./immutable.js";
import type {
  PromptInjectionTag,
  SecretCategory,
  SecretCategoryCount,
  SecretRange,
} from "./context-boundary.js";

export interface CustomSecretClassifierInput {
  readonly classifierId: string;
  readonly pattern: string;
  readonly caseInsensitive?: boolean;
}

export interface CompiledCustomSecretClassifier {
  readonly classifierId: string;
  readonly source: string;
  readonly caseInsensitive: boolean;
  readonly expression: RegExp;
}

export interface ClassifiedText {
  readonly ranges: readonly SecretRange[];
  readonly categories: readonly SecretCategoryCount[];
  readonly promptInjectionTags: readonly PromptInjectionTag[];
}

export interface ClassifiedJson {
  readonly value: JsonValue;
  readonly categories: readonly SecretCategoryCount[];
  readonly promptInjectionTags: readonly PromptInjectionTag[];
}

export interface CrossValueSecretDetection {
  readonly categories: readonly SecretCategoryCount[];
  readonly occurrenceIndexes: readonly number[];
}

const CATEGORY_ORDER: readonly SecretCategory[] = Object.freeze([
  "private_key",
  "api_token",
  "assigned_secret",
  "custom",
  "high_entropy_token",
]);

const COMMON_TOKEN_EXPRESSIONS: readonly RegExp[] = Object.freeze([
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\bgh[oprsu]_[A-Za-z0-9]{20,255}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/gu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,255}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/gu,
  /\bAIza[0-9A-Za-z_-]{30,100}\b/gu,
]);

const PRIVATE_KEY_EXPRESSION =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/gu;

const ASSIGNMENT_EXPRESSION =
  /\b[A-Za-z_][A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*\s*(?::|=)\s*(?:["']([^"'\r\n]{4,})["']|([^\s,;#]{4,}))/giu;

const HIGH_ENTROPY_CANDIDATE = /\b[A-Za-z0-9_+/=-]{32,512}\b/gu;
const PERCENT_ENCODED_CANDIDATE = /(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}){12,1024}/gu;
const ESCAPED_CANDIDATE =
  /(?:[A-Za-z0-9_.-]|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}){12,1024}/gu;
const BASE64_CANDIDATE =
  /(?<![A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4}){4,128}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![A-Za-z0-9+/=])/gu;
const MAXIMUM_CLASSIFIED_UTF16_LENGTH = 16 * 1024 * 1024;
const MAXIMUM_STRING_OCCURRENCES = 1_024;
const MAXIMUM_SPLIT_COMPARISONS = 10_000;

const INJECTION_PATTERNS: Readonly<
  Record<PromptInjectionTag, readonly RegExp[]>
> = Object.freeze({
  authority_impersonation: Object.freeze([
    /\b(?:system|developer)\s+(?:message|instruction|prompt)\b/iu,
    /\byou\s+are\s+(?:chatgpt|the\s+system|an?\s+administrator)\b/iu,
  ]),
  instruction_override: Object.freeze([
    /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?\b/iu,
    /\bdisregard\s+(?:the\s+)?(?:policy|rules?|instructions?)\b/iu,
    /\bdo\s+not\s+follow\s+(?:the\s+)?(?:policy|rules?|instructions?)\b/iu,
  ]),
  secret_exfiltration: Object.freeze([
    /\b(?:print|send|upload|exfiltrat\w*)\b[^\r\n]{0,80}\b(?:secret|credentials?|token|password|key)\b/iu,
    /\breveal\s+(?:the\s+)?(?:system\s+prompt|hidden\s+instructions?)\b/iu,
  ]),
  tool_coercion: Object.freeze([
    /\b(?:call|invoke|run|execute)\s+(?:the\s+)?(?:tool|command|shell|terminal)\b/iu,
    /\b(?:disable|bypass)\s+(?:the\s+)?(?:sandbox|approval|policy|gateway)\b/iu,
  ]),
});

export function compileCustomSecretClassifiers(
  inputs: readonly CustomSecretClassifierInput[],
): readonly CompiledCustomSecretClassifier[] {
  const detached = snapshotBoundaryObject(
    { inputs },
    "Custom secret classifier configuration",
  )["inputs"];
  if (!Array.isArray(detached) || detached.length > 64) {
    throw invalidInput("Custom secret classifiers must be a bounded array.");
  }
  const ids = new Set<string>();
  const compiled: CompiledCustomSecretClassifier[] = [];
  for (const input of detached) {
    if (!isPlainObject(input) || !hasAllowedKeys(input, [
      "classifierId",
      "pattern",
      "caseInsensitive",
    ])) {
      throw invalidInput("A custom secret classifier is malformed.");
    }
    const classifierId = dataString(input, "classifierId");
    const pattern = dataString(input, "pattern");
    const caseInsensitive = input.caseInsensitive ?? false;
    if (typeof caseInsensitive !== "boolean") {
      throw invalidInput("A custom classifier caseInsensitive flag must be boolean.");
    }
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(classifierId) || ids.has(classifierId)) {
      throw invalidInput("Custom classifier IDs must be unique canonical identifiers.");
    }
    if (!isSafeCustomPattern(pattern)) {
      throw invalidInput("A custom classifier pattern exceeds the safe regex subset.");
    }
    let expression: RegExp;
    try {
      expression = new RegExp(pattern, caseInsensitive ? "giu" : "gu");
    } catch {
      throw invalidInput("A custom classifier pattern is not a valid regular expression.");
    }
    ids.add(classifierId);
    compiled.push(
      Object.freeze({ classifierId, source: pattern, caseInsensitive, expression }),
    );
  }
  return Object.freeze(compiled);
}

export function classifyText(
  text: string,
  customClassifiers: readonly CompiledCustomSecretClassifier[] = [],
): ClassifiedText {
  if (text.length > MAXIMUM_CLASSIFIED_UTF16_LENGTH) {
    throw createDomainError({
      code: "budget_exceeded",
      message: "Context text exceeds the bounded classification window.",
    });
  }
  const ranges: SecretRange[] = [];
  appendCoreMatches(text, customClassifiers, ranges);
  appendDerivedEncodingMatches(text, ranges);
  ranges.sort(compareRanges);
  const frozenRanges = Object.freeze(ranges.map((range) => Object.freeze(range)));
  return Object.freeze({
    ranges: frozenRanges,
    categories: countSecretCategories(frozenRanges),
    promptInjectionTags: detectPromptInjection(text),
  });
}

function appendCoreMatches(
  text: string,
  customClassifiers: readonly CompiledCustomSecretClassifier[],
  ranges: SecretRange[],
): void {
  for (const expression of COMMON_TOKEN_EXPRESSIONS) {
    appendMatches(text, expression, "api_token", ranges);
  }
  appendMatches(text, PRIVATE_KEY_EXPRESSION, "private_key", ranges);
  appendAssignmentMatches(text, ranges);
  for (const classifier of customClassifiers) {
    appendMatches(text, classifier.expression, "custom", ranges);
  }
  appendHighEntropyMatches(text, ranges);
}

export function redactClassifiedText(
  text: string,
  classified: ClassifiedText,
  runCorrelationId: string,
): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(runCorrelationId)) {
    throw new TypeError("A run correlation ID must be an opaque base64url value.");
  }
  const merged = mergeRanges(classified.ranges);
  let result = text;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const range = merged[index]!;
    const marker = `[REDACTED:${range.category}:${runCorrelationId}]`;
    result = `${result.slice(0, range.startUtf16)}${marker}${result.slice(
      range.endUtf16,
    )}`;
  }
  return result;
}

export function classifyAndTransformJson(
  value: JsonValue,
  effect: "allow" | "redact",
  runCorrelationId: string,
  customClassifiers: readonly CompiledCustomSecretClassifier[] = [],
): ClassifiedJson {
  const counts = new Map<SecretCategory, number>();
  const tags = new Set<PromptInjectionTag>();
  const occurrences = collectStringOccurrences(value);
  const cross = detectCrossOccurrenceSecrets(
    occurrences.map((item) => item.text),
    customClassifiers,
  );
  addCounts(counts, cross.categories);
  const crossIndexes = new Set(cross.occurrenceIndexes);
  const joinedTags = detectPromptInjection(occurrences.map((item) => item.text).join(""));
  for (const tag of joinedTags) tags.add(tag);
  let occurrenceIndex = 0;

  function visit(candidate: JsonValue): JsonValue {
    if (typeof candidate === "string") {
      const classified = classifyText(candidate, customClassifiers);
      addCounts(counts, classified.categories);
      for (const tag of classified.promptInjectionTags) tags.add(tag);
      const index = occurrenceIndex;
      occurrenceIndex += 1;
      if (effect === "redact" && crossIndexes.has(index)) {
        const category = cross.categoryByOccurrence.get(index) ?? "custom";
        return `[REDACTED:${category}:${runCorrelationId}]`;
      }
      return effect === "redact"
        ? redactClassifiedText(candidate, classified, runCorrelationId)
        : candidate;
    }
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (Array.isArray(candidate)) {
      return Object.freeze(candidate.map((item) => visit(item)));
    }
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(candidate)) {
      const keyClassified = classifyText(key, customClassifiers);
      addCounts(counts, keyClassified.categories);
      for (const tag of keyClassified.promptInjectionTags) tags.add(tag);
      const keyIndex = occurrenceIndex;
      occurrenceIndex += 1;
      const safeKey = effect === "redact"
        ? crossIndexes.has(keyIndex)
          ? `[REDACTED:${cross.categoryByOccurrence.get(keyIndex) ?? "custom"}:${runCorrelationId}:key${String(keyIndex)}]`
          : redactClassifiedText(key, keyClassified, runCorrelationId)
        : key;
      if (Object.hasOwn(output, safeKey)) {
        throw createDomainError({
          code: "conflict",
          message: "Redaction caused two context object keys to collide.",
        });
      }
      output[safeKey] = visit(child);
    }
    return Object.freeze(output);
  }

  return deepFreeze({
    value: visit(value),
    categories: categoriesFromMap(counts),
    promptInjectionTags: orderedTags(tags),
  });
}

export function detectCrossValueSecrets(
  values: readonly JsonValue[],
  customClassifiers: readonly CompiledCustomSecretClassifier[] = [],
): CrossValueSecretDetection {
  const occurrences: IndexedStringOccurrence[] = [];
  let combinedLength = 0;
  for (const [valueIndex, value] of values.entries()) {
    for (const item of collectStringOccurrences(value)) {
      if (occurrences.length >= MAXIMUM_STRING_OCCURRENCES) {
        throw createDomainError({
          code: "budget_exceeded",
          message: "Context contains too many string fields for split-secret analysis.",
        });
      }
      combinedLength += item.text.length;
      if (combinedLength > MAXIMUM_CLASSIFIED_UTF16_LENGTH) {
        throw createDomainError({
          code: "budget_exceeded",
          message: "Combined context strings exceed the bounded classification window.",
        });
      }
      occurrences.push({
        text: item.text,
        occurrenceIndex: occurrences.length,
        valueIndex,
      });
    }
  }

  const trailing = indexUniqueFragments(occurrences, trailingTokenFragment);
  const leading = indexUniqueFragments(occurrences, leadingTokenFragment);
  const classificationCache = new Map<string, ReadonlySet<SecretCategory>>();
  const involved = new Set<number>();
  const crossRanges: SecretRange[] = [];
  const pairCategories = new Set<string>();
  let examinedPairs = 0;

  for (const [left, leftOccurrences] of trailing) {
    for (const [right, rightOccurrences] of leading) {
      const leftParticipants = leftOccurrences.filter((candidate) =>
        rightOccurrences.some(
          (other) => candidate.valueIndex < other.valueIndex,
        ),
      );
      if (leftParticipants.length === 0) continue;
      const rightParticipants = rightOccurrences.filter((candidate) =>
        leftOccurrences.some(
          (other) => other.valueIndex < candidate.valueIndex,
        ),
      );
      if (rightParticipants.length === 0 || left.length + right.length > 1_024) {
        continue;
      }
      examinedPairs += 1;
      if (examinedPairs > MAXIMUM_SPLIT_COMPARISONS) {
        throw createDomainError({
          code: "budget_exceeded",
          message: "Context exceeds the bounded split-secret comparison budget.",
        });
      }

      const combinedRanges: SecretRange[] = [];
      appendCoreMatches(`${left}${right}`, customClassifiers, combinedRanges);
      appendDerivedEncodingMatches(`${left}${right}`, combinedRanges);
      const leftCategories = cachedFragmentCategories(
        left,
        customClassifiers,
        classificationCache,
      );
      const rightCategories = cachedFragmentCategories(
        right,
        customClassifiers,
        classificationCache,
      );
      for (const range of combinedRanges) {
        if (
          range.category === "high_entropy_token" ||
          leftCategories.has(range.category) ||
          rightCategories.has(range.category) ||
          range.startUtf16 >= left.length ||
          range.endUtf16 <= left.length
        ) {
          continue;
        }
        const pairKey = `${left}\u0000${right}\u0000${range.category}`;
        if (pairCategories.has(pairKey)) continue;
        pairCategories.add(pairKey);
        crossRanges.push(range);
        for (const occurrence of [...leftParticipants, ...rightParticipants]) {
          involved.add(occurrence.occurrenceIndex);
        }
      }
    }
  }

  return Object.freeze({
    categories: countSecretCategories(crossRanges),
    occurrenceIndexes: Object.freeze([...involved].sort((left, right) => left - right)),
  });
}

export function countSecretCategories(
  ranges: readonly SecretRange[],
): readonly SecretCategoryCount[] {
  const counts = new Map<SecretCategory, number>();
  for (const range of ranges) {
    counts.set(range.category, (counts.get(range.category) ?? 0) + 1);
  }
  return categoriesFromMap(counts);
}

export function mergeSecretCategoryCounts(
  groups: readonly (readonly SecretCategoryCount[])[],
): readonly SecretCategoryCount[] {
  const counts = new Map<SecretCategory, number>();
  for (const group of groups) addCounts(counts, group);
  return categoriesFromMap(counts);
}

export function mergePromptInjectionTags(
  groups: readonly (readonly PromptInjectionTag[])[],
): readonly PromptInjectionTag[] {
  const tags = new Set<PromptInjectionTag>();
  for (const group of groups) {
    for (const tag of group) tags.add(tag);
  }
  return orderedTags(tags);
}

function appendMatches(
  text: string,
  expression: RegExp,
  category: SecretCategory,
  output: SecretRange[],
): void {
  expression.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    if (match[0].length === 0) {
      expression.lastIndex += 1;
      continue;
    }
    output.push({
      category,
      startUtf16: match.index,
      endUtf16: match.index + match[0].length,
    });
  }
}

function appendAssignmentMatches(text: string, output: SecretRange[]): void {
  ASSIGNMENT_EXPRESSION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ASSIGNMENT_EXPRESSION.exec(text)) !== null) {
    const secret = match[1] ?? match[2];
    if (secret === undefined) continue;
    const relative = match[0].lastIndexOf(secret);
    output.push({
      category: "assigned_secret",
      startUtf16: match.index + relative,
      endUtf16: match.index + relative + secret.length,
    });
  }
}

function appendHighEntropyMatches(text: string, output: SecretRange[]): void {
  HIGH_ENTROPY_CANDIDATE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HIGH_ENTROPY_CANDIDATE.exec(text)) !== null) {
    const candidate = match[0];
    if (characterClasses(candidate) < 3 || shannonEntropy(candidate) < 3.5) {
      continue;
    }
    output.push({
      category: "high_entropy_token",
      startUtf16: match.index,
      endUtf16: match.index + candidate.length,
    });
  }
}

function appendDerivedEncodingMatches(text: string, output: SecretRange[]): void {
  appendDecodedCandidates(
    text,
    PERCENT_ENCODED_CANDIDATE,
    (candidate) => {
      if (!candidate.includes("%")) return null;
      try {
        return decodeURIComponent(candidate);
      } catch {
        return null;
      }
    },
    output,
  );
  appendDecodedCandidates(
    text,
    ESCAPED_CANDIDATE,
    (candidate) => {
      if (!candidate.includes("\\u") && !candidate.includes("\\x")) return null;
      return candidate
        .replace(/\\u([0-9A-Fa-f]{4})/gu, (_match, hex: string) =>
          String.fromCodePoint(Number.parseInt(hex, 16)),
        )
        .replace(/\\x([0-9A-Fa-f]{2})/gu, (_match, hex: string) =>
          String.fromCodePoint(Number.parseInt(hex, 16)),
        );
    },
    output,
  );
  appendDecodedCandidates(
    text,
    BASE64_CANDIDATE,
    (candidate) => {
      if (candidate.length % 4 !== 0) return null;
      try {
        const bytes = Buffer.from(candidate, "base64");
        if (bytes.byteLength === 0 || bytes.toString("base64").replace(/=+$/u, "") !== candidate.replace(/=+$/u, "")) {
          return null;
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    },
    output,
  );
}

function appendDecodedCandidates(
  text: string,
  expression: RegExp,
  decode: (candidate: string) => string | null,
  output: SecretRange[],
): void {
  expression.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    const decoded = decode(match[0]);
    if (decoded === null || decoded.length > 4_096) continue;
    const derived: SecretRange[] = [];
    appendCoreMatches(decoded, [], derived);
    const categories = [...new Set(derived.map((range) => range.category))];
    for (const category of categories) {
      output.push({
        category,
        startUtf16: match.index,
        endUtf16: match.index + match[0].length,
      });
    }
  }
}

interface StringOccurrence {
  readonly text: string;
}

interface IndexedStringOccurrence extends StringOccurrence {
  readonly occurrenceIndex: number;
  readonly valueIndex: number;
}

function indexUniqueFragments(
  occurrences: readonly IndexedStringOccurrence[],
  fragmentFor: (value: string) => string | null,
): ReadonlyMap<string, readonly IndexedStringOccurrence[]> {
  const indexed = new Map<string, IndexedStringOccurrence[]>();
  for (const occurrence of occurrences) {
    const fragment = fragmentFor(occurrence.text);
    if (fragment === null) continue;
    const prior = indexed.get(fragment);
    if (prior === undefined) indexed.set(fragment, [occurrence]);
    else prior.push(occurrence);
  }
  return indexed;
}

function cachedFragmentCategories(
  fragment: string,
  customClassifiers: readonly CompiledCustomSecretClassifier[],
  cache: Map<string, ReadonlySet<SecretCategory>>,
): ReadonlySet<SecretCategory> {
  const cached = cache.get(fragment);
  if (cached !== undefined) return cached;
  const categories = new Set(
    classifyText(fragment, customClassifiers).categories.map(
      (item) => item.category,
    ),
  );
  cache.set(fragment, categories);
  return categories;
}

interface InternalCrossDetection extends CrossValueSecretDetection {
  readonly categoryByOccurrence: ReadonlyMap<number, SecretCategory>;
}

function collectStringOccurrences(value: JsonValue): readonly StringOccurrence[] {
  const result: StringOccurrence[] = [];
  function append(text: string): void {
    if (result.length >= MAXIMUM_STRING_OCCURRENCES) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "Context contains too many string fields for bounded classification.",
      });
    }
    result.push({ text });
  }
  function visit(candidate: JsonValue): void {
    if (typeof candidate === "string") {
      append(candidate);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child);
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      append(key);
      visit(child);
    }
  }
  visit(value);
  return Object.freeze(result);
}

function detectCrossOccurrenceSecrets(
  occurrences: readonly string[],
  customClassifiers: readonly CompiledCustomSecretClassifier[] = [],
): InternalCrossDetection {
  if (occurrences.length > MAXIMUM_STRING_OCCURRENCES) {
    throw createDomainError({
      code: "budget_exceeded",
      message: "Context contains too many string fields for split-secret analysis.",
    });
  }
  let combinedLength = 0;
  for (const occurrence of occurrences) {
    combinedLength += occurrence.length;
    if (combinedLength > MAXIMUM_CLASSIFIED_UTF16_LENGTH) {
      throw createDomainError({
        code: "budget_exceeded",
        message: "Combined context strings exceed the bounded classification window.",
      });
    }
  }
  const involved = new Set<number>();
  const categoryByOccurrence = new Map<number, SecretCategory>();
  const crossRanges: SecretRange[] = [];
  const pairCategories = new Set<string>();
  let examinedPairs = 0;
  for (let leftIndex = 0; leftIndex < occurrences.length; leftIndex += 1) {
    const left = trailingTokenFragment(occurrences[leftIndex]!);
    if (left === null) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < occurrences.length; rightIndex += 1) {
      const right = leadingTokenFragment(occurrences[rightIndex]!);
      if (right === null || left.length + right.length > 1_024) continue;
      examinedPairs += 1;
      if (examinedPairs > MAXIMUM_SPLIT_COMPARISONS) {
        throw createDomainError({
          code: "budget_exceeded",
          message: "Context exceeds the bounded split-secret comparison budget.",
        });
      }
      const combinedRanges: SecretRange[] = [];
      appendCoreMatches(`${left}${right}`, customClassifiers, combinedRanges);
      appendDerivedEncodingMatches(`${left}${right}`, combinedRanges);
      const leftCategories = new Set(
        classifyText(left, customClassifiers).categories.map((item) => item.category),
      );
      const rightCategories = new Set(
        classifyText(right, customClassifiers).categories.map((item) => item.category),
      );
      for (const range of combinedRanges) {
        // Entropy by itself is not sufficient cross-field evidence: unrelated
        // identifiers commonly become high entropy when concatenated. Known
        // token formats and reviewed custom classifiers retain split support.
        if (range.category === "high_entropy_token") continue;
        // A complete secret followed or preceded by an ordinary identifier is
        // not a split secret. Without this check the token's permissive suffix
        // would taint every later schema key and corrupt the semantic envelope.
        if (
          leftCategories.has(range.category) ||
          rightCategories.has(range.category)
        ) {
          continue;
        }
        if (range.startUtf16 >= left.length || range.endUtf16 <= left.length) continue;
        const key = `${String(leftIndex)}:${String(rightIndex)}:${range.category}`;
        if (pairCategories.has(key)) continue;
        pairCategories.add(key);
        crossRanges.push(range);
        for (const index of [leftIndex, rightIndex]) {
          involved.add(index);
          const previous = categoryByOccurrence.get(index);
          categoryByOccurrence.set(
            index,
            previous === undefined
              ? range.category
              : higherPriority(previous, range.category),
          );
        }
      }
    }
  }
  return Object.freeze({
    categories: countSecretCategories(crossRanges),
    occurrenceIndexes: Object.freeze([...involved].sort((left, right) => left - right)),
    categoryByOccurrence,
  });
}

function trailingTokenFragment(value: string): string | null {
  const match = /[A-Za-z0-9_+/=%\\-]{4,512}$/u.exec(value);
  return match?.[0] ?? null;
}

function leadingTokenFragment(value: string): string | null {
  const match = /^[A-Za-z0-9_+/=%\\-]{4,512}/u.exec(value);
  return match?.[0] ?? null;
}

function detectPromptInjection(text: string): readonly PromptInjectionTag[] {
  const tags = new Set<PromptInjectionTag>();
  for (const [tag, patterns] of Object.entries(INJECTION_PATTERNS) as Array<
    [PromptInjectionTag, readonly RegExp[]]
  >) {
    if (patterns.some((pattern) => pattern.test(text))) tags.add(tag);
  }
  return orderedTags(tags);
}

function mergeRanges(ranges: readonly SecretRange[]): readonly SecretRange[] {
  if (ranges.length === 0) return Object.freeze([]);
  const ordered = [...ranges].sort(compareRanges);
  const merged: SecretRange[] = [];
  let current = ordered[0]!;
  for (let index = 1; index < ordered.length; index += 1) {
    const next = ordered[index]!;
    if (next.startUtf16 < current.endUtf16) {
      current = {
        category: higherPriority(current.category, next.category),
        startUtf16: current.startUtf16,
        endUtf16: Math.max(current.endUtf16, next.endUtf16),
      };
    } else {
      merged.push(Object.freeze(current));
      current = next;
    }
  }
  merged.push(Object.freeze(current));
  return Object.freeze(merged);
}

function compareRanges(left: SecretRange, right: SecretRange): number {
  return (
    left.startUtf16 - right.startUtf16 ||
    right.endUtf16 - left.endUtf16 ||
    CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category)
  );
}

function higherPriority(
  left: SecretCategory,
  right: SecretCategory,
): SecretCategory {
  return CATEGORY_ORDER.indexOf(left) <= CATEGORY_ORDER.indexOf(right)
    ? left
    : right;
}

function categoriesFromMap(
  counts: ReadonlyMap<SecretCategory, number>,
): readonly SecretCategoryCount[] {
  return Object.freeze(
    CATEGORY_ORDER.filter((category) => (counts.get(category) ?? 0) > 0).map(
      (category) => Object.freeze({ category, count: counts.get(category)! }),
    ),
  );
}

function addCounts(
  target: Map<SecretCategory, number>,
  source: readonly SecretCategoryCount[],
): void {
  for (const item of source) {
    target.set(item.category, (target.get(item.category) ?? 0) + item.count);
  }
}

function orderedTags(
  tags: ReadonlySet<PromptInjectionTag>,
): readonly PromptInjectionTag[] {
  return Object.freeze([...tags].sort());
}

function characterClasses(candidate: string): number {
  return [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[_+/=-]/u].filter((pattern) =>
    pattern.test(candidate),
  ).length;
}

function shannonEntropy(candidate: string): number {
  const frequencies = new Map<string, number>();
  for (const character of candidate) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / candidate.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isSafeCustomPattern(pattern: string): boolean {
  if (
    pattern.length === 0 ||
    pattern.length > 256 ||
    /[\r\n\u0000|()*+?]/u.test(pattern)
  ) {
    return false;
  }
  let inClass = false;
  let escaped = false;
  let hasConsumableToken = false;
  let maximumExpansion = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (escaped) {
      escaped = false;
      hasConsumableToken = true;
      maximumExpansion += 1;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      if (inClass) return false;
      inClass = true;
      hasConsumableToken = false;
      continue;
    }
    if (character === "]") {
      if (!inClass) return false;
      inClass = false;
      hasConsumableToken = true;
      maximumExpansion += 1;
      continue;
    }
    if (inClass) continue;
    if (character === "{") {
      if (!hasConsumableToken) return false;
      const rest = pattern.slice(index);
      const match = /^\{(\d{1,3})(?:,(\d{1,3}))?\}/u.exec(rest);
      if (match === null) return false;
      const minimum = Number.parseInt(match[1]!, 10);
      const maximum = Number.parseInt(match[2] ?? match[1]!, 10);
      if (minimum > maximum || maximum > 128) return false;
      maximumExpansion += maximum - 1;
      if (maximumExpansion > 4_096) return false;
      index += match[0].length - 1;
      hasConsumableToken = false;
      continue;
    }
    if (character === "}") return false;
    if (character === "^" || character === "$") {
      hasConsumableToken = false;
      continue;
    }
    hasConsumableToken = true;
    maximumExpansion += 1;
    if (maximumExpansion > 4_096) return false;
  }
  return !escaped && !inClass;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function dataString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw invalidInput(`A custom classifier ${field} must be a non-empty string.`);
  }
  return candidate;
}

function invalidInput(message: string) {
  return createDomainError({ code: "invalid_input", message });
}
