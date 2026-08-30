import type { JsonObject } from "./json-value.js";
import type { VersionedContract } from "./schema-version.js";

/** Canonical, adapter-owned reference; never a raw secret-bearing locator. */
export interface ResourceRef extends VersionedContract {
  readonly scheme: string;
  readonly sourceId: string;
  readonly locator: JsonObject;
  readonly mediaType: string | null;
  readonly classification: string;
}
