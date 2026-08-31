import path from "node:path";

import {
  classifyText,
  decodeConservativeUtf8,
  type PromptInjectionTag,
  type SecretCategoryCount,
} from "@guard/context-broker";

import type { FileBinding, PhysicalObjectKind } from "./workspace-identity.js";
import type { WorkspaceRelativePath } from "./physical-path.js";

export type TextEncoding =
  | "utf8"
  | "utf8_bom"
  | "utf16le_bom"
  | "utf16be_bom"
  | "binary"
  | "invalid_utf8";

export type NewlineStyle = "none" | "lf" | "crlf" | "mixed";

export interface PathClassification {
  readonly kind: PhysicalObjectKind;
  readonly generated: boolean;
  readonly secretLikely: boolean;
  readonly hidden: boolean;
  readonly mediaType: string;
  readonly size: number;
  readonly links: number;
}

export interface TextClassification {
  readonly accepted: boolean;
  readonly encoding: TextEncoding;
  readonly newlineStyle: NewlineStyle;
  readonly text: string | null;
  readonly secretCategories: readonly SecretCategoryCount[];
  readonly promptInjectionTags: readonly PromptInjectionTag[];
  readonly withheldReason:
    | "binary"
    | "invalid_encoding"
    | "secret_content"
    | null;
}

const GENERATED_COMPONENTS = new Set([
  ".cache",
  ".next",
  ".parcel-cache",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

const SECRET_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

const SECRET_EXTENSIONS = new Set([
  ".der",
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pfx",
  ".pem",
]);

export function classifyWorkspacePath(
  workspacePath: WorkspaceRelativePath,
  binding: FileBinding,
): PathClassification {
  const components = workspacePath.split("/");
  const basename = components.at(-1) ?? "";
  const lowerBasename = basename.toLocaleLowerCase("en-US");
  const lowerComponents = components.map((component) =>
    component.toLocaleLowerCase("en-US"),
  );
  const extension = path.posix.extname(lowerBasename);
  const secretLikely =
    SECRET_BASENAMES.has(lowerBasename) ||
    lowerBasename.startsWith(".env.") ||
    lowerBasename.endsWith(".credentials") ||
    lowerBasename.endsWith(".secret") ||
    SECRET_EXTENSIONS.has(extension) ||
    lowerComponents.includes(".aws") ||
    lowerComponents.includes(".ssh") ||
    lowerComponents.includes(".gnupg");
  return Object.freeze({
    kind: binding.identity.kind,
    generated: lowerComponents.some((component) =>
      GENERATED_COMPONENTS.has(component),
    ),
    secretLikely,
    hidden: components.some((component) => component.startsWith(".")),
    mediaType: mediaTypeForPath(workspacePath),
    size: binding.size,
    links: binding.links,
  });
}

export function classifyTextBytes(
  bytes: Uint8Array,
  mediaType: string,
  maximumControlCharacterRatio = 0.02,
): TextClassification {
  const bom = detectBom(bytes);
  if (bom.encoding === "utf16le_bom" || bom.encoding === "utf16be_bom") {
    return Object.freeze({
      accepted: false,
      encoding: bom.encoding,
      newlineStyle: "none",
      text: null,
      secretCategories: Object.freeze([]),
      promptInjectionTags: Object.freeze([]),
      withheldReason: "invalid_encoding",
    });
  }
  const body = bytes.subarray(bom.offset);
  const decoded = decodeConservativeUtf8(
    body,
    mediaType,
    maximumControlCharacterRatio,
  );
  if (!decoded.accepted) {
    return Object.freeze({
      accepted: false,
      encoding:
        decoded.reason === "invalid_utf8" || decoded.reason === "invalid_json"
          ? "invalid_utf8"
          : "binary",
      newlineStyle: "none",
      text: null,
      secretCategories: Object.freeze([]),
      promptInjectionTags: Object.freeze([]),
      withheldReason:
        decoded.reason === "invalid_utf8" || decoded.reason === "invalid_json"
          ? "invalid_encoding"
          : "binary",
    });
  }
  const classified = classifyText(decoded.text);
  const secretCategories = Object.freeze([...classified.categories]);
  const promptInjectionTags = Object.freeze([...classified.promptInjectionTags]);
  return Object.freeze({
    accepted: secretCategories.length === 0,
    encoding: bom.offset === 0 ? "utf8" : "utf8_bom",
    newlineStyle: detectNewlineStyle(decoded.text),
    text: secretCategories.length === 0 ? decoded.text : null,
    secretCategories,
    promptInjectionTags,
    withheldReason: secretCategories.length === 0 ? null : "secret_content",
  });
}

export function mediaTypeForPath(workspacePath: string): string {
  const extension = path.posix.extname(workspacePath).toLocaleLowerCase("en-US");
  const exact: Readonly<Record<string, string>> = Object.freeze({
    ".c": "text/plain",
    ".cc": "text/plain",
    ".conf": "text/plain",
    ".cpp": "text/plain",
    ".css": "text/css",
    ".csv": "text/csv",
    ".go": "text/plain",
    ".h": "text/plain",
    ".hpp": "text/plain",
    ".html": "text/html",
    ".java": "text/plain",
    ".js": "text/javascript",
    ".json": "text/plain",
    ".jsx": "text/javascript",
    ".md": "text/markdown",
    ".mjs": "text/javascript",
    ".py": "text/x-python",
    ".rb": "text/plain",
    ".rs": "text/plain",
    ".sh": "text/x-shellscript",
    ".sql": "text/plain",
    ".toml": "text/plain",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".txt": "text/plain",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  });
  return exact[extension] ?? "text/plain";
}

function detectBom(bytes: Uint8Array): {
  readonly encoding: "utf8_bom" | "utf16le_bom" | "utf16be_bom" | "none";
  readonly offset: number;
} {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return Object.freeze({ encoding: "utf8_bom", offset: 3 });
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return Object.freeze({ encoding: "utf16le_bom", offset: 2 });
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return Object.freeze({ encoding: "utf16be_bom", offset: 2 });
  }
  return Object.freeze({ encoding: "none", offset: 0 });
}

function detectNewlineStyle(text: string): NewlineStyle {
  let lf = 0;
  let crlf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x0a) continue;
    if (index > 0 && text.charCodeAt(index - 1) === 0x0d) crlf += 1;
    else lf += 1;
  }
  if (lf === 0 && crlf === 0) return "none";
  if (lf > 0 && crlf > 0) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}
