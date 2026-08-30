export const ACTOR_KINDS = [
  "user",
  "client",
  "runtime",
  "agent_driver",
  "provider",
  "context_source",
  "capability_worker",
] as const;

export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface ActorIdentity {
  readonly kind: ActorKind;
  readonly id: string;
}
