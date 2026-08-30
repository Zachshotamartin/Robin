import type {
  ArtifactId,
  Brand,
  RunId,
  VersionedContract,
} from "@guard/contracts";

export type ArtifactReferenceId = Brand<string, "ArtifactReferenceId">;
export type Sha256ContentHash = Brand<string, "Sha256ContentHash">;

export interface ArtifactWriteDescriptor {
  readonly byteLength: number;
  readonly kind: string;
  readonly mediaType: string;
  readonly displayName: string | null;
  readonly expectedContentHash: Sha256ContentHash | null;
}

export interface ArtifactReference extends VersionedContract {
  readonly artifactReferenceId: ArtifactReferenceId;
  readonly artifactId: ArtifactId;
  readonly runId: RunId;
  readonly byteLength: number;
  readonly contentHash: Sha256ContentHash;
  readonly kind: string;
  readonly mediaType: string;
  readonly displayName: string | null;
  readonly createdAt: string;
}

export interface ArtifactStore {
  write(
    runId: RunId,
    descriptor: ArtifactWriteDescriptor,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<ArtifactReference>;

  inspect(
    runId: RunId,
    artifactReferenceId: ArtifactReferenceId,
    signal?: AbortSignal,
  ): Promise<ArtifactReference>;

  read(
    runId: RunId,
    artifactReferenceId: ArtifactReferenceId,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}
