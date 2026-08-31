import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPORTER_FORMAT = "robin-node-test-report";
export const REPORTER_VERSION = 1;
export const REPORTER_LIMITS = Object.freeze({
  maxEvents: 100_000,
  maxBufferedBytes: 64 * 1024 * 1024,
});
export const REPOSITORY_ROOT = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);

const ROOT_GROUP = "\u0000robin-report-root";
const MAX_VALUE_DEPTH = 32;
const MAX_VALUE_NODES = 100_000;
const MAX_ARRAY_LENGTH = 100_000;
const MAX_BIGINT_MAGNITUDE = 10n ** 10_000n;
const NATIVE_ERROR_STACK_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  new Error(),
  "stack",
);
const CURRENT_WORKING_DIRECTORY = path.resolve(process.cwd());
const textPathIdentities = Object.freeze(
  [
    ...textIdentityRoots(REPOSITORY_ROOT).map((root) =>
      createTextPathIdentity(root, "repo"),
    ),
    ...(CURRENT_WORKING_DIRECTORY === REPOSITORY_ROOT
      ? []
      : textIdentityRoots(CURRENT_WORKING_DIRECTORY).map((root) =>
          createTextPathIdentity(root, "cwd"),
        )),
  ]
    .filter(
      (identity, index, identities) =>
        identities.findIndex(({ root }) => root === identity.root) === index,
    )
    .sort((left, right) => right.root.length - left.root.length),
);
const durationDiagnosticPattern =
  /^duration_ms (?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const nodeInternalStackFramePattern =
  /^\s*at\s+(?:(?:async|new)\s+)*(?:(?:node:|internal\/)|.*(?:\(|\s)(?:node:|internal\/))/u;

class ReporterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RobinDeterministicTestReporterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReporterError(code, message);
}

function readDataProperty(value, key, fallback) {
  let current = value;
  for (let depth = 0; current !== null; depth += 1) {
    if (depth > MAX_VALUE_DEPTH) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
        "structured value has an excessively deep prototype chain",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, "value")) {
        fail(
          "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
          "structured values with accessor properties are unsupported",
        );
      }
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  return fallback;
}

function readErrorText(value, key, fallback) {
  const candidate = readDataProperty(value, key, fallback) ?? fallback;
  if (
    (typeof candidate === "object" && candidate !== null) ||
    typeof candidate === "function"
  ) {
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
      `Error ${key} must be a primitive value`,
    );
  }
  return String(candidate);
}

function readErrorStack(value) {
  const descriptor = Object.getOwnPropertyDescriptor(value, "stack");
  if (
    descriptor !== undefined &&
    !Object.hasOwn(descriptor, "value") &&
    descriptor.get === NATIVE_ERROR_STACK_DESCRIPTOR?.get &&
    descriptor.set === NATIVE_ERROR_STACK_DESCRIPTOR?.set &&
    typeof descriptor.get === "function"
  ) {
    return Reflect.apply(descriptor.get, value, []);
  }
  return readDataProperty(value, "stack", undefined);
}

function readFunctionName(value) {
  const name = readDataProperty(value, "name", "");
  if (typeof name !== "string") {
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
      "Function name must be a string",
    );
  }
  return name || "anonymous";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalArrayIndex(key, length = Number.MAX_SAFE_INTEGER) {
  if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function assertNoUnexpectedEnumerableProperties(value, allowed, typeName) {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || allowed(key)) continue;
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
      `${typeName} contains an unsupported enumerable custom property`,
    );
  }
}

function requireRecord(value, location) {
  if (!isRecord(value)) {
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_EVENT",
      `${location} must be an object`,
    );
  }
  return value;
}

function isIdentityBoundary(value) {
  return (
    value === undefined ||
    /[\s"'`()\[\]{},;:=!?<>.#?]/u.test(value)
  );
}

function replaceDelimitedIdentity(value, target, replacement) {
  let cursor = 0;
  let output = "";
  while (cursor < value.length) {
    const index = value.indexOf(target, cursor);
    if (index === -1) {
      output += value.slice(cursor);
      break;
    }
    const before = index === 0 ? undefined : value[index - 1];
    const afterIndex = index + target.length;
    const after = afterIndex === value.length ? undefined : value[afterIndex];
    output += value.slice(cursor, index);
    if (isIdentityBoundary(before) && isIdentityBoundary(after)) {
      output += replacement;
    } else {
      output += target;
    }
    cursor = afterIndex;
  }
  return output;
}

function normalizeText(value) {
  let normalized = value;
  for (const identity of textPathIdentities) {
    normalized = normalized
      .replaceAll(identity.fileUrlPrefix, `file://${identity.replacement}/`)
      .replaceAll(identity.pathPrefix, `${identity.replacement}/`);
    normalized = replaceDelimitedIdentity(
      normalized,
      identity.fileUrl,
      `file://${identity.replacement}`,
    );
    normalized = replaceDelimitedIdentity(
      normalized,
      identity.root,
      identity.replacement,
    );
    if (
      normalized.includes(identity.fileUrl) ||
      normalized.includes(identity.root)
    ) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_AMBIGUOUS_PATH",
        "text contains a checkout identity outside a recognized path boundary",
      );
    }
  }
  return normalized;
}

function createTextPathIdentity(root, label) {
  const pathPrefix = `${root}${path.sep}`;
  return Object.freeze({
    root,
    pathPrefix,
    fileUrl: pathToFileURL(root).href,
    fileUrlPrefix: pathToFileURL(pathPrefix).href,
    replacement: `<${label}>`,
  });
}

function textIdentityRoots(root) {
  const roots = [root];
  if (process.platform === "darwin") {
    if (root.startsWith("/private/")) roots.push(root.slice("/private".length));
    else if (root.startsWith("/var/") || root.startsWith("/tmp/")) {
      roots.push(`/private${root}`);
    }
  }
  return roots;
}

function toPortablePath(value) {
  return value.split(path.sep).join("/");
}

function absolutePath(value) {
  return path.resolve(process.cwd(), value);
}

function isWithinRoot(root, value) {
  const relative = path.relative(root, value);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function normalizeFile(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_EVENT",
      "event file must be a string when present",
    );
  }
  const resolved = absolutePath(value);
  if (isWithinRoot(REPOSITORY_ROOT, resolved)) {
    const relative = path.relative(REPOSITORY_ROOT, resolved);
    return relative === "" ? "." : toPortablePath(relative);
  }
  if (
    CURRENT_WORKING_DIRECTORY !== REPOSITORY_ROOT &&
    isWithinRoot(CURRENT_WORKING_DIRECTORY, resolved)
  ) {
    const relative = path.relative(CURRENT_WORKING_DIRECTORY, resolved);
    return relative === ""
      ? "<cwd>"
      : `<cwd>/${toPortablePath(relative)}`;
  }
  let physicalResolved;
  try {
    physicalResolved = realpathSync(resolved);
  } catch {
    physicalResolved = undefined;
  }
  if (
    physicalResolved !== undefined &&
    isWithinRoot(REPOSITORY_ROOT, physicalResolved)
  ) {
    const relative = path.relative(REPOSITORY_ROOT, physicalResolved);
    return relative === "" ? "." : toPortablePath(relative);
  }
  if (
    physicalResolved !== undefined &&
    CURRENT_WORKING_DIRECTORY !== REPOSITORY_ROOT &&
    isWithinRoot(CURRENT_WORKING_DIRECTORY, physicalResolved)
  ) {
    const relative = path.relative(CURRENT_WORKING_DIRECTORY, physicalResolved);
    return relative === ""
      ? "<cwd>"
      : `<cwd>/${toPortablePath(relative)}`;
  }
  fail(
    "ERR_ROBIN_TEST_REPORTER_EXTERNAL_PATH",
    "event file resolves outside the reporter repository and working directory",
  );
}

function normalizeLocation(data) {
  const result = {};
  const file = normalizeFile(data.file);
  if (file !== undefined) result.file = file;
  if (Number.isInteger(data.line)) result.line = data.line;
  if (Number.isInteger(data.column)) result.column = data.column;
  if (Number.isInteger(data.nesting)) result.nesting = data.nesting;
  const entryFile = normalizeFile(data.entryFile);
  if (entryFile !== undefined) result.entryFile = entryFile;
  return result;
}

function stackFramePath(line) {
  const withoutTerminator = line.replace(/(?:\r\n|\r|\n)$/u, "");
  if (!/^\s*at\s+/u.test(withoutTerminator)) return undefined;
  const locationSuffix = /:\d+:\d+\)?$/u.exec(withoutTerminator);
  if (locationSuffix === null) return undefined;
  const prefix = withoutTerminator.slice(0, locationSuffix.index);
  const openingParenthesis = prefix.lastIndexOf("(");
  let candidate =
    openingParenthesis === -1
      ? prefix.slice(prefix.lastIndexOf(" ") + 1)
      : prefix.slice(openingParenthesis + 1);
  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      fail(
        "ERR_ROBIN_TEST_REPORTER_EXTERNAL_PATH",
        "stack frame contains an invalid file URL",
      );
    }
  }
  if (/^[A-Za-z]:[\\/]/u.test(candidate) && process.platform !== "win32") {
    fail(
      "ERR_ROBIN_TEST_REPORTER_EXTERNAL_PATH",
      "stack frame resolves outside the reporter repository and working directory",
    );
  }
  if (!path.isAbsolute(candidate)) return undefined;
  return candidate;
}

function assertStackFramePathAllowed(line) {
  const candidate = stackFramePath(line);
  if (candidate === undefined) return;
  const resolved = absolutePath(candidate);
  if (
    isWithinRoot(REPOSITORY_ROOT, resolved) ||
    isWithinRoot(CURRENT_WORKING_DIRECTORY, resolved)
  ) {
    return;
  }
  let physical;
  try {
    physical = realpathSync(resolved);
  } catch {
    physical = undefined;
  }
  if (
    physical !== undefined &&
    (isWithinRoot(REPOSITORY_ROOT, physical) ||
      isWithinRoot(CURRENT_WORKING_DIRECTORY, physical))
  ) {
    return;
  }
  fail(
    "ERR_ROBIN_TEST_REPORTER_EXTERNAL_PATH",
    "stack frame resolves outside the reporter repository and working directory",
  );
}

function normalizeStack(value) {
  const originalLines = value.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu) ?? [];
  for (const line of originalLines) assertStackFramePathAllowed(line);
  const normalized = normalizeText(value);
  const lines = normalized.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu) ?? [];
  return lines
    .filter((line) => line.length > 0 && !nodeInternalStackFramePattern.test(line))
    .join("");
}

function preflightStructuredValue(
  value,
  maximumBytes,
  reportLimit = maximumBytes,
) {
  let estimatedBytes = 0;
  let nodes = 0;
  const seen = new WeakSet();

  function charge(bytes) {
    estimatedBytes += bytes;
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > maximumBytes) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_BYTE_LIMIT",
        `report exceeds ${reportLimit} buffered bytes during value serialization`,
      );
    }
  }

  function visit(entry, depth) {
    if (depth > MAX_VALUE_DEPTH) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
        `structured value exceeds maximum depth ${MAX_VALUE_DEPTH}`,
      );
    }
    if (typeof entry === "string") {
      charge(entry.length * 6 + 2);
      return;
    }
    if (typeof entry === "bigint") {
      if (entry <= -MAX_BIGINT_MAGNITUDE || entry >= MAX_BIGINT_MAGNITUDE) {
        fail(
          "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
          "bigint exceeds the 10000-digit serialization limit",
        );
      }
      charge(entry.toString(10).length * 6 + 64);
      return;
    }
    if (typeof entry === "symbol") {
      charge((entry.description?.length ?? 0) * 6 + 64);
      return;
    }
    if (typeof entry === "function") {
      charge(readFunctionName(entry).length * 6 + 64);
      return;
    }
    if (
      entry === null ||
      typeof entry === "boolean" ||
      typeof entry === "number" ||
      typeof entry === "undefined"
    ) {
      charge(64);
      return;
    }
    if (seen.has(entry)) {
      charge(32);
      return;
    }
    seen.add(entry);
    nodes += 1;
    if (nodes > MAX_VALUE_NODES) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
        `structured value exceeds maximum node count ${MAX_VALUE_NODES}`,
      );
    }
    charge(64);
    if (entry instanceof ArrayBuffer) {
      charge(4 * Math.ceil(entry.byteLength / 3));
      return;
    }
    if (ArrayBuffer.isView(entry)) {
      charge(4 * Math.ceil(entry.byteLength / 3));
      return;
    }
    if (entry instanceof RegExp) {
      charge(entry.source.length * 6 + entry.flags.length * 6 + 64);
      visit(readDataProperty(entry, "lastIndex", 0), depth + 1);
      return;
    }
    if (entry instanceof URL) {
      charge(entry.href.length * 6 + 64);
      return;
    }
    if (entry instanceof Date) {
      charge(128);
      return;
    }
    if (entry instanceof Error) {
      const name = readErrorText(entry, "name", "Error");
      const message = readErrorText(entry, "message", "");
      const stack = readErrorStack(entry);
      const cause = readDataProperty(entry, "cause", undefined);
      if (stack !== undefined && typeof stack !== "string") {
        fail(
          "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
          "Error stack must be a string when defined",
        );
      }
      charge(name.length * 6 + 64);
      charge(message.length * 6 + 64);
      if (stack !== undefined) charge(stack.length * 6 + 64);
      if (cause !== undefined) visit(cause, depth + 1);
    }
    if (Array.isArray(entry)) {
      if (entry.length > MAX_ARRAY_LENGTH) {
        fail(
          "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
          `array exceeds maximum length ${MAX_ARRAY_LENGTH}`,
        );
      }
      charge(entry.length * 24 + 64);
      for (let index = 0; index < entry.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (descriptor === undefined) continue;
        if (!Object.hasOwn(descriptor, "value")) {
          charge(64);
          continue;
        }
        visit(descriptor.value, depth + 1);
      }
      for (const key of Reflect.ownKeys(entry)) {
        if (key === "length" || isCanonicalArrayIndex(key, entry.length)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (descriptor?.enumerable === true) {
          fail(
            "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
            "Array contains an unsupported enumerable custom property",
          );
        }
      }
      return;
    }
    if (entry instanceof Map) {
      for (const [key, item] of entry) {
        visit(key, depth + 1);
        visit(item, depth + 1);
      }
      return;
    }
    if (entry instanceof Set) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (!(entry instanceof Error)) {
      const name = constructorName(entry);
      if (name !== "Object" && name !== "null-prototype") {
        fail(
          "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
          "structured value has an unsupported internal-slot or custom-class type",
        );
      }
      charge(name.length * 6 + 64);
    }
    for (const key of Reflect.ownKeys(entry)) {
      charge(String(propertyKeyName(key)).length * 6 + 2);
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (descriptor === undefined) continue;
      if (!Object.hasOwn(descriptor, "value")) {
        charge(64);
        continue;
      }
      visit(descriptor.value, depth + 1);
    }
  }

  visit(value, 0);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function propertyKeyName(value) {
  if (typeof value === "symbol") {
    return `$symbol:${normalizeText(value.description ?? "")}`;
  }
  const normalized = normalizeText(value);
  return normalized.startsWith("$symbol:") || normalized.startsWith("$string:")
    ? `$string:${normalized}`
    : normalized;
}

function createSerializationContext() {
  return {
    seen: new WeakMap(),
    symbols: new Map(),
    nextReference: 1,
    nodes: 0,
  };
}

function registerSymbol(value, context, depth) {
  if (depth > MAX_VALUE_DEPTH) {
    fail(
      "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
      `structured value exceeds maximum depth ${MAX_VALUE_DEPTH}`,
    );
  }
  const existingReference = context.symbols.get(value);
  if (existingReference !== undefined) {
    return { reference: existingReference, repeated: true };
  }
  context.nodes += 1;
  if (context.nodes > MAX_VALUE_NODES) {
    fail(
      "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
      `structured value exceeds maximum node count ${MAX_VALUE_NODES}`,
    );
  }
  const reference = context.nextReference;
  context.nextReference += 1;
  context.symbols.set(value, reference);
  return { reference, repeated: false };
}

function registerObject(value, context, depth) {
  if (depth > MAX_VALUE_DEPTH) {
    fail(
      "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
      `structured value exceeds maximum depth ${MAX_VALUE_DEPTH}`,
    );
  }
  const existingReference = context.seen.get(value);
  if (existingReference !== undefined) {
    return { reference: existingReference, repeated: true };
  }
  context.nodes += 1;
  if (context.nodes > MAX_VALUE_NODES) {
    fail(
      "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
      `structured value exceeds maximum node count ${MAX_VALUE_NODES}`,
    );
  }
  const reference = context.nextReference;
  context.nextReference += 1;
  context.seen.set(value, reference);
  return { reference, repeated: false };
}

function serializeOwnProperties(value, excludedKeys, context, depth) {
  const result = {};
  const keys = Reflect.ownKeys(value).sort((left, right) =>
    compareStrings(propertyKeyName(left), propertyKeyName(right)),
  );
  for (const key of keys) {
    if (typeof key === "string" && excludedKeys.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    const outputKey = propertyKeyName(key);
    if (Object.hasOwn(result, outputKey)) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
        "structured object contains property keys with colliding normalized identities",
      );
    }
    if (Object.hasOwn(descriptor, "value")) {
      result[outputKey] = stableValue(descriptor.value, context, depth + 1);
      continue;
    }
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
      "structured values with accessor properties are unsupported",
    );
  }
  return result;
}

function serializeError(value, context, depth, reference) {
  const excluded = new Set(["name", "message", "stack", "cause"]);
  const properties = serializeOwnProperties(value, excluded, context, depth);
  const name = readErrorText(value, "name", "Error");
  const message = readErrorText(value, "message", "");
  const stack = readErrorStack(value);
  const cause = readDataProperty(value, "cause", undefined);
  if (stack !== undefined && typeof stack !== "string") {
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
      "Error stack must be a string when defined",
    );
  }
  const result = {
    $type: "Error",
    $id: reference,
    name: normalizeText(name),
    message: normalizeText(message),
  };
  if (stack !== undefined) {
    result.stack = normalizeStack(stack);
    result.stackPolicy = "node-internal-frames-omitted-v1";
  }
  if (cause !== undefined) {
    result.cause = stableValue(cause, context, depth + 1);
  }
  const promotedKeys = [
    "code",
    "failureType",
    "operator",
    "actual",
    "expected",
    "generatedMessage",
    "diff",
  ];
  for (const key of promotedKeys) {
    if (!Object.hasOwn(properties, key)) continue;
    result[key] = properties[key];
    delete properties[key];
  }
  if (Object.keys(properties).length > 0) result.properties = properties;
  return result;
}

function constructorName(value) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return "null-prototype";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    return "Object";
  }
  return descriptor.value.name || "Object";
}

function stableValue(value, context = createSerializationContext(), depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return normalizeText(value);
  if (typeof value === "number") {
    if (Object.is(value, -0)) return { $type: "number", value: "-0" };
    if (Number.isFinite(value)) return value;
    if (Number.isNaN(value)) return { $type: "number", value: "NaN" };
    return {
      $type: "number",
      value: value === Number.POSITIVE_INFINITY ? "Infinity" : "-Infinity",
    };
  }
  if (typeof value === "bigint") {
    if (value <= -MAX_BIGINT_MAGNITUDE || value >= MAX_BIGINT_MAGNITUDE) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
        "bigint exceeds the 10000-digit serialization limit",
      );
    }
    return { $type: "bigint", value: value.toString(10) };
  }
  if (typeof value === "undefined") return { $type: "undefined" };
  if (typeof value === "symbol") {
    const registration = registerSymbol(value, context, depth);
    if (registration.repeated) return { $ref: registration.reference };
    return {
      $type: "symbol",
      $id: registration.reference,
      value: normalizeText(value.description ?? ""),
    };
  }
  if (typeof value === "function") {
    const registration = registerObject(value, context, depth);
    if (registration.repeated) return { $ref: registration.reference };
    assertNoUnexpectedEnumerableProperties(value, () => false, "Function");
    return {
      $type: "function",
      $id: registration.reference,
      name: normalizeText(readFunctionName(value)),
    };
  }

  const registration = registerObject(value, context, depth);
  if (registration.repeated) return { $ref: registration.reference };
  const reference = registration.reference;

  if (value instanceof Error) {
    return serializeError(value, context, depth, reference);
  }
  if (value instanceof Date) {
    assertNoUnexpectedEnumerableProperties(value, () => false, "Date");
    return {
      $type: "Date",
      $id: reference,
      value: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString(),
    };
  }
  if (value instanceof RegExp) {
    assertNoUnexpectedEnumerableProperties(value, () => false, "RegExp");
    const escapedIdentities = textPathIdentities.flatMap((identity) => [
      identity.root.replaceAll("\\", "\\\\").replaceAll("/", "\\/"),
      identity.fileUrl.replaceAll("\\", "\\\\").replaceAll("/", "\\/"),
    ]);
    if (escapedIdentities.some((identity) => value.source.includes(identity))) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_AMBIGUOUS_PATH",
        "regular expression contains an encoded checkout identity",
      );
    }
    return {
      $type: "RegExp",
      $id: reference,
      source: normalizeText(value.source),
      flags: value.flags,
      lastIndex: stableValue(
        readDataProperty(value, "lastIndex", 0),
        context,
        depth + 1,
      ),
    };
  }
  if (value instanceof URL) {
    assertNoUnexpectedEnumerableProperties(value, () => false, "URL");
    return { $type: "URL", $id: reference, value: normalizeText(value.href) };
  }
  if (value instanceof ArrayBuffer) {
    assertNoUnexpectedEnumerableProperties(value, () => false, "ArrayBuffer");
    return {
      $type: "ArrayBuffer",
      $id: reference,
      base64: Buffer.from(value).toString("base64"),
    };
  }
  if (ArrayBuffer.isView(value)) {
    assertNoUnexpectedEnumerableProperties(
      value,
      (key) => isCanonicalArrayIndex(key, value.length ?? 0),
      value.constructor.name,
    );
    return {
      $type: value.constructor.name,
      $id: reference,
      base64: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).toString("base64"),
    };
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_VALUE_LIMIT",
        `array exceeds maximum length ${MAX_ARRAY_LENGTH}`,
      );
    }
    assertNoUnexpectedEnumerableProperties(
      value,
      (key) => isCanonicalArrayIndex(key, value.length),
      "Array",
    );
    return {
      $type: "Array",
      $id: reference,
      values: Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) return { $type: "array-hole" };
        if (!Object.hasOwn(descriptor, "value")) {
          fail(
            "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
            "structured values with accessor properties are unsupported",
          );
        }
        return stableValue(descriptor.value, context, depth + 1);
      }),
    };
  }
  if (value instanceof Map) {
    assertNoUnexpectedEnumerableProperties(value, () => false, "Map");
    return {
      $type: "Map",
      $id: reference,
      entries: Array.from(value, ([key, entry]) => [
        stableValue(key, context, depth + 1),
        stableValue(entry, context, depth + 1),
      ]),
    };
  }
  if (value instanceof Set) {
    assertNoUnexpectedEnumerableProperties(value, () => false, "Set");
    return {
      $type: "Set",
      $id: reference,
      values: Array.from(value, (entry) =>
        stableValue(entry, context, depth + 1),
      ),
    };
  }

  const name = normalizeText(constructorName(value));
  if (name !== "Object" && name !== "null-prototype") {
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_VALUE",
      `unsupported structured value type ${JSON.stringify(name)}`,
    );
  }
  const properties = serializeOwnProperties(value, new Set(), context, depth);
  return { $type: name, $id: reference, properties };
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function canonicalizeCoverageArray(value, location) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_EVENT",
      `${location} must be an array when present`,
    );
  }
  return value
    .map((entry, index) => ({
      entry,
      index,
      key: canonicalJson(stableValue(entry)),
    }))
    .sort((left, right) => {
      const comparison = compareStrings(left.key, right.key);
      return comparison === 0 ? left.index - right.index : comparison;
    })
    .map(({ entry }) => entry);
}

function coverageRecord(data) {
  const summary = requireRecord(data.summary, "test:coverage.data.summary");
  if (!Array.isArray(summary.files)) {
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_EVENT",
      "test:coverage.data.summary.files must be an array",
    );
  }
  const files = summary.files.map((entry, index) => {
    const file = requireRecord(
      entry,
      `test:coverage.data.summary.files[${index}]`,
    );
    if (typeof file.path !== "string") {
      fail(
        "ERR_ROBIN_TEST_REPORTER_INVALID_EVENT",
        `test:coverage.data.summary.files[${index}].path must be a string`,
      );
    }
    return {
      ...file,
      path: normalizeFile(file.path),
      ...(file.functions === undefined
        ? {}
        : {
            functions: canonicalizeCoverageArray(
              file.functions,
              `test:coverage.data.summary.files[${index}].functions`,
            ),
          }),
      ...(file.branches === undefined
        ? {}
        : {
            branches: canonicalizeCoverageArray(
              file.branches,
              `test:coverage.data.summary.files[${index}].branches`,
            ),
          }),
      ...(file.lines === undefined
        ? {}
        : {
            lines: canonicalizeCoverageArray(
              file.lines,
              `test:coverage.data.summary.files[${index}].lines`,
            ),
          }),
    };
  });
  const canonicalFiles = canonicalizeCoverageArray(
    files,
    "test:coverage.data.summary.files",
  );
  const normalized = stableValue({
    ...data,
    summary: {
      ...summary,
      files: canonicalFiles,
    },
  });
  return { type: "coverage", data: normalized };
}

function resultStatus(eventType, data) {
  if (data.skip !== undefined) return "skip";
  if (data.todo !== undefined) return "todo";
  return eventType === "test:pass" ? "pass" : "fail";
}

function resultRecord(eventType, data) {
  const details = requireRecord(data.details, `${eventType}.data.details`);
  const result = {
    type: "test",
    status: resultStatus(eventType, data),
    ...normalizeLocation(data),
  };
  if (Number.isInteger(data.testNumber)) result.number = data.testNumber;
  for (const field of ["testId", "parentId"]) {
    if (data[field] === undefined) continue;
    if (typeof data[field] === "string") {
      result[field] = normalizeText(data[field]);
      continue;
    }
    if (!Number.isSafeInteger(data[field])) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_INVALID_EVENT",
        `${eventType}.data.${field} must be a string or safe integer when present`,
      );
    }
    result[field] = data[field];
  }
  result.name = normalizeText(String(data.name ?? ""));
  result.testType =
    details.type === "suite" || details.type === "test"
      ? details.type
      : "test";
  if (data.skip !== undefined) result.skip = stableValue(data.skip);
  if (data.todo !== undefined) result.todo = stableValue(data.todo);
  if (Array.isArray(data.tags)) result.tags = stableValue(data.tags);
  if (Number.isInteger(details.attempt)) result.attempt = details.attempt;
  if (Number.isInteger(details.passed_on_attempt)) {
    result.passedOnAttempt = details.passed_on_attempt;
  }
  if (eventType === "test:fail") {
    result.failure = stableValue(details.error);
  }
  return result;
}

function diagnosticRecord(data) {
  let message = normalizeText(String(data.message ?? ""));
  if (
    data.file === undefined &&
    data.line === undefined &&
    data.column === undefined &&
    durationDiagnosticPattern.test(message)
  ) {
    message = "duration_ms <nondeterministic>";
  }
  return {
    type: "diagnostic",
    ...normalizeLocation(data),
    level:
      data.level === "warn" || data.level === "error" ? data.level : "info",
    message,
  };
}

function planRecord(data) {
  return {
    type: "plan",
    ...normalizeLocation(data),
    count: data.count,
  };
}

function streamRecord(eventType, data) {
  return {
    type: eventType === "test:stdout" ? "stdout" : "stderr",
    ...normalizeLocation(data),
    message: normalizeText(String(data.message ?? "")),
  };
}

function summaryRecord(data) {
  const result = {
    type: data.file === undefined ? "summary" : "file-summary",
    ...normalizeLocation(data),
    success: data.success === true,
    counts: stableValue(data.counts ?? {}),
  };
  return result;
}

function genericRecord(type, data) {
  return {
    type,
    ...normalizeLocation(data),
    data: stableValue(data),
  };
}

function normalizedPathIdentity(value) {
  if (typeof value !== "string") return undefined;
  const normalized = path.normalize(absolutePath(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isFailedFileCompletion(data) {
  if (!isRecord(data.details) || data.details.passed !== false) return false;
  const fileIdentity = normalizedPathIdentity(data.file);
  const nameIdentity = normalizedPathIdentity(data.name);
  return fileIdentity !== undefined && fileIdentity === nameIdentity;
}

function fileFailureRecord(data) {
  return {
    type: "file-failure",
    ...normalizeLocation(data),
    name: normalizeText(String(data.name ?? "")),
    failure: stableValue(data.details?.error),
  };
}

function validateLimit(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(
      "ERR_ROBIN_TEST_REPORTER_INVALID_LIMIT",
      `${name} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return value;
}

function compareEntries(left, right) {
  const leftIsRoot = left.group === ROOT_GROUP;
  const rightIsRoot = right.group === ROOT_GROUP;
  if (leftIsRoot !== rightIsRoot) return leftIsRoot ? 1 : -1;
  const groupComparison = compareStrings(left.group, right.group);
  if (groupComparison !== 0) return groupComparison;
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return compareStrings(left.line, right.line);
}

export function createDeterministicTestReporter(options = {}) {
  const maxEvents = validateLimit(
    options.maxEvents ?? REPORTER_LIMITS.maxEvents,
    REPORTER_LIMITS.maxEvents,
    "maxEvents",
  );
  const maxBufferedBytes = validateLimit(
    options.maxBufferedBytes ?? REPORTER_LIMITS.maxBufferedBytes,
    REPORTER_LIMITS.maxBufferedBytes,
    "maxBufferedBytes",
  );

  return async function* deterministicTestReporter(source) {
    const header = `${canonicalJson({
      type: "report",
      format: REPORTER_FORMAT,
      version: REPORTER_VERSION,
    })}\n`;
    let bufferedBytes = Buffer.byteLength(header, "utf8");
    if (bufferedBytes > maxBufferedBytes) {
      fail(
        "ERR_ROBIN_TEST_REPORTER_BYTE_LIMIT",
        `report exceeds ${maxBufferedBytes} buffered bytes`,
      );
    }

    const entries = [];
    const pendingFileFailures = [];
    const failingFiles = new Set();
    const sequences = new Map();
    let eventCount = 0;

    function makeEntry(record, file) {
      const group = file ?? ROOT_GROUP;
      const sequence = sequences.get(group) ?? 0;
      sequences.set(group, sequence + 1);
      const line = `${canonicalJson(record)}\n`;
      bufferedBytes += Buffer.byteLength(line, "utf8");
      if (bufferedBytes > maxBufferedBytes) {
        fail(
          "ERR_ROBIN_TEST_REPORTER_BYTE_LIMIT",
          `report exceeds ${maxBufferedBytes} buffered bytes`,
        );
      }
      return { group, sequence, line };
    }

    function append(record, file) {
      entries.push(makeEntry(record, file));
    }

    for await (const event of source) {
      eventCount += 1;
      if (eventCount > maxEvents) {
        fail(
          "ERR_ROBIN_TEST_REPORTER_EVENT_LIMIT",
          `report exceeds ${maxEvents} input events`,
        );
      }
      if (!isRecord(event) || typeof event.type !== "string") {
        fail(
          "ERR_ROBIN_TEST_REPORTER_INVALID_EVENT",
          "test reporter event must be an object with a string type",
        );
      }
      preflightStructuredValue(
        event,
        maxBufferedBytes - bufferedBytes,
        maxBufferedBytes,
      );

      switch (event.type) {
        case "test:pass":
        case "test:fail": {
          const data = requireRecord(event.data, `${event.type}.data`);
          const file = normalizeFile(data.file);
          const record = resultRecord(event.type, data);
          append(record, file);
          if (record.status === "fail") failingFiles.add(file ?? ROOT_GROUP);
          break;
        }
        case "test:diagnostic": {
          const data = requireRecord(event.data, "test:diagnostic.data");
          append(diagnosticRecord(data), normalizeFile(data.file));
          break;
        }
        case "test:plan": {
          const data = requireRecord(event.data, "test:plan.data");
          append(planRecord(data), normalizeFile(data.file));
          break;
        }
        case "test:stdout":
        case "test:stderr": {
          const data = requireRecord(event.data, `${event.type}.data`);
          append(streamRecord(event.type, data), normalizeFile(data.file));
          break;
        }
        case "test:summary": {
          const data = requireRecord(event.data, "test:summary.data");
          append(summaryRecord(data), normalizeFile(data.file));
          break;
        }
        case "test:coverage": {
          const data = requireRecord(event.data, "test:coverage.data");
          append(coverageRecord(data), undefined);
          break;
        }
        case "test:interrupted": {
          const data = requireRecord(event.data, "test:interrupted.data");
          append(genericRecord("interrupted", data), normalizeFile(data.file));
          break;
        }
        case "test:log": {
          const data = requireRecord(event.data, "test:log.data");
          append(genericRecord("log", data), normalizeFile(data.file));
          break;
        }
        case "test:complete": {
          const data = requireRecord(event.data, "test:complete.data");
          if (isFailedFileCompletion(data)) {
            const file = normalizeFile(data.file);
            pendingFileFailures.push({
              file: file ?? ROOT_GROUP,
              entry: makeEntry(fileFailureRecord(data), file),
            });
          }
          break;
        }
        case "test:start":
        case "test:enqueue":
        case "test:dequeue":
          requireRecord(event.data, `${event.type}.data`);
          break;
        case "test:watch:drained":
        case "test:watch:restarted":
          break;
        default:
          fail(
            "ERR_ROBIN_TEST_REPORTER_UNSUPPORTED_EVENT",
            `unsupported node:test event type ${JSON.stringify(event.type)}`,
          );
      }
    }

    for (const candidate of pendingFileFailures) {
      if (!failingFiles.has(candidate.file)) entries.push(candidate.entry);
    }
    entries.sort(compareEntries);

    yield header;
    for (const entry of entries) yield entry.line;
  };
}

const deterministicTestReporter = createDeterministicTestReporter();

export default deterministicTestReporter;
