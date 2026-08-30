import type { JsonObject, ResourceRef } from "@guard/contracts";

export interface ContextSourceDescriptor {
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly scheme: string;
  readonly description: string;
}

export interface NormalizedContextRequest {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly resource: ResourceRef;
}

export interface ContextReadBudget {
  readonly maximumItems: number;
  readonly maximumBytes: number;
}

export interface BoundedContextItem {
  readonly resource: ResourceRef;
  readonly value: JsonObject;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface BoundedContextResult {
  readonly items: readonly BoundedContextItem[];
  readonly totalBytes: number;
  readonly truncated: boolean;
}

/**
 * Domain-neutral source port. Source-owned normalization produces an exact
 * versioned resource reference before a bounded read is possible.
 */
export interface ContextSource {
  readonly descriptor: ContextSourceDescriptor;
  normalizeRequest(input: unknown): NormalizedContextRequest;
  readBounded(
    request: NormalizedContextRequest,
    budget: ContextReadBudget,
    signal: AbortSignal,
  ): Promise<BoundedContextResult>;
}
