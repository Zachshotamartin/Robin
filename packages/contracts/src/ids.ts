import { randomUUID } from "node:crypto";

import type { Brand } from "./brand.js";
import { createDomainError } from "./errors.js";

export type RunId = Brand<string, "RunId">;
export type EventId = Brand<string, "EventId">;
export type AgentAttemptId = Brand<string, "AgentAttemptId">;
export type DriverProposalId = Brand<string, "DriverProposalId">;
export type ActionId = Brand<string, "ActionId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type CommandId = Brand<string, "CommandId">;
export type PolicyVersionId = Brand<string, "PolicyVersionId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

export interface IdKind<TId extends string> {
  readonly prefix: string;
  generate(): TId;
  /** Validates untrusted input at a boundary; throws an `invalid_input` domain error. */
  parse(value: string): TId;
  is(value: unknown): value is TId;
}

const LOWERCASE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function defineIdKind<TId extends string>(prefix: string): IdKind<TId> {
  const expectedStart = `${prefix}_`;

  function is(value: unknown): value is TId {
    return (
      typeof value === "string" &&
      value.startsWith(expectedStart) &&
      LOWERCASE_UUID_PATTERN.test(value.slice(expectedStart.length))
    );
  }

  return Object.freeze({
    prefix,
    generate(): TId {
      return `${expectedStart}${randomUUID()}` as TId;
    },
    parse(value: string): TId {
      if (!is(value)) {
        throw createDomainError({
          code: "invalid_input",
          message: `Expected a ${prefix} identifier of the form ${expectedStart}<lowercase-uuid>.`,
        });
      }
      return value;
    },
    is,
  });
}

export const RunIdKind: IdKind<RunId> = defineIdKind("run");
export const EventIdKind: IdKind<EventId> = defineIdKind("evt");
export const AgentAttemptIdKind: IdKind<AgentAttemptId> = defineIdKind("att");
export const DriverProposalIdKind: IdKind<DriverProposalId> = defineIdKind("dpr");
export const ActionIdKind: IdKind<ActionId> = defineIdKind("act");
export const ApprovalIdKind: IdKind<ApprovalId> = defineIdKind("apr");
export const CommandIdKind: IdKind<CommandId> = defineIdKind("cmd");
export const PolicyVersionIdKind: IdKind<PolicyVersionId> = defineIdKind("pol");
export const ArtifactIdKind: IdKind<ArtifactId> = defineIdKind("art");
export const IdempotencyKeyKind: IdKind<IdempotencyKey> = defineIdKind("idk");
