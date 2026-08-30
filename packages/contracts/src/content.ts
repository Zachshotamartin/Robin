import type { ActorIdentity } from "./actor.js";
import type { ArtifactId } from "./ids.js";
import type { JsonValue } from "./json-value.js";
import type { ResourceRef } from "./resource.js";
import type { VersionedContract, ContractSchemaVersion } from "./schema-version.js";
import type { VersionedSchema } from "./task-profile.js";

export type ContentModality =
  | "text"
  | "json"
  | "image"
  | "audio"
  | "document"
  | "embedding";

export interface ContentProducer extends ActorIdentity {}

export interface ContentProvenance {
  readonly source: ResourceRef | null;
  readonly producer: ContentProducer;
  readonly capturedAt: string;
}

export interface TransformationRecord extends VersionedContract {
  readonly transformationId: string;
  readonly transformationVersion: number;
  readonly inputContentHashes: readonly string[];
}

export interface ContentBlockBase extends VersionedContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly blockId: string;
  readonly modality: ContentModality;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly classification: string;
  readonly provenance: ContentProvenance;
  readonly retentionClass: string;
  readonly transformation: TransformationRecord | null;
}

export interface TextContentBlock extends ContentBlockBase {
  readonly modality: "text";
  readonly text: string;
  readonly encoding: "utf-8";
  readonly normalization: "none" | "nfc" | "nfkc";
}

export interface JsonContentBlock extends ContentBlockBase {
  readonly modality: "json";
  readonly value: JsonValue;
  readonly jsonSchema: VersionedSchema | null;
}

export interface ImageContentBlock extends ContentBlockBase {
  readonly modality: "image";
  readonly artifactId: ArtifactId;
  readonly width: number;
  readonly height: number;
}

export interface AudioContentBlock extends ContentBlockBase {
  readonly modality: "audio";
  readonly artifactId: ArtifactId;
  readonly durationMs: number;
  readonly sampleRateHz: number;
  readonly channels: number;
}

export interface DocumentContentBlock extends ContentBlockBase {
  readonly modality: "document";
  readonly artifactId: ArtifactId;
  readonly pageCount: number | null;
}

export interface EmbeddingReferenceBlock extends ContentBlockBase {
  readonly modality: "embedding";
  readonly vectorStoreId: string;
  readonly vectorId: string;
  readonly dimensions: number;
  readonly modelProfileId: string;
}

export type ContentBlock =
  | TextContentBlock
  | JsonContentBlock
  | ImageContentBlock
  | AudioContentBlock
  | DocumentContentBlock
  | EmbeddingReferenceBlock;
