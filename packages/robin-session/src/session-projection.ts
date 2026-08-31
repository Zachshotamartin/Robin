import {
  RobinSessionError,
  parseRobinApplicationEvent,
  type RobinApplicationEvent,
  type RobinPermissionMode,
  type RobinTurnApplicationEvent,
} from "./application-event.js";
import { reduceRobinTurn } from "./turn-reducer.js";
import {
  isTerminalTurnStatus,
  turnIdFromEvent,
  type RobinTurnState,
} from "./turn-state.js";

export const MAXIMUM_QUEUED_ROBIN_MESSAGES = 8;

export interface RobinSessionProjection {
  readonly activeTurnId: string | null;
  readonly lastSequence: number;
  readonly permissionMode: RobinPermissionMode | null;
  readonly persistence: "ephemeral";
  readonly providerProfile: "synthetic";
  readonly queuedTurnIds: readonly string[];
  readonly sessionId: string | null;
  readonly status: "empty" | "open" | "closed";
  readonly turns: readonly RobinTurnState[];
}

export function createEmptyRobinSessionProjection(): RobinSessionProjection {
  return Object.freeze({
    activeTurnId: null,
    lastSequence: 0,
    permissionMode: null,
    persistence: "ephemeral",
    providerProfile: "synthetic",
    queuedTurnIds: Object.freeze([]),
    sessionId: null,
    status: "empty",
    turns: Object.freeze([]),
  });
}

/** Applies one event with exact contiguous sequence and one-session checks. */
export function reduceRobinSessionProjection(
  state: RobinSessionProjection,
  rawEvent: unknown,
): RobinSessionProjection {
  const event = parseRobinApplicationEvent(rawEvent);
  if (event.sequence !== state.lastSequence + 1) {
    throw new RobinSessionError(
      "sequence_conflict",
      "Robin application event sequence is not contiguous.",
    );
  }
  if (state.status === "empty") return startSession(state, event);
  if (state.sessionId !== event.sessionId || state.status === "closed") {
    return illegalTransition();
  }

  if (event.type === "SessionStarted") return illegalTransition();
  if (event.type === "PermissionModeChanged") {
    return freezeProjection({
      ...state,
      lastSequence: event.sequence,
      permissionMode: event.payload.permissionMode,
    });
  }
  if (event.type === "SessionClosed") {
    if (state.turns.some((turn) => !isTerminalTurnStatus(turn.status))) {
      return illegalTransition();
    }
    return freezeProjection({
      ...state,
      activeTurnId: null,
      lastSequence: event.sequence,
      queuedTurnIds: Object.freeze([]),
      status: "closed",
    });
  }
  return reduceTurnEvent(state, event);
}

/** Replays untrusted records without invoking providers, tools, or persistence. */
export function replayRobinSession(
  events: readonly unknown[],
): RobinSessionProjection {
  let state = createEmptyRobinSessionProjection();
  for (const event of events) {
    state = reduceRobinSessionProjection(state, event);
  }
  return state;
}

function startSession(
  state: RobinSessionProjection,
  event: RobinApplicationEvent,
): RobinSessionProjection {
  if (event.type !== "SessionStarted" || event.sequence !== 1) {
    return illegalTransition();
  }
  return freezeProjection({
    ...state,
    lastSequence: event.sequence,
    permissionMode: event.payload.permissionMode,
    sessionId: event.sessionId,
    status: "open",
  });
}

function reduceTurnEvent(
  state: RobinSessionProjection,
  event: RobinTurnApplicationEvent,
): RobinSessionProjection {
  const turnId = turnIdFromEvent(event);
  const index = state.turns.findIndex((turn) => turn.turnId === turnId);
  const current = index < 0 ? undefined : state.turns[index];

  if (event.type === "UserMessageQueued") {
    const acceptedForegroundTurns = state.turns.filter(
      (turn) => turn.status === "accepted",
    );
    const hasForegroundOwner =
      state.activeTurnId !== null ||
      (state.activeTurnId === null && acceptedForegroundTurns.length === 1);
    if (
      current !== undefined ||
      !hasForegroundOwner ||
      state.queuedTurnIds.length >= MAXIMUM_QUEUED_ROBIN_MESSAGES ||
      event.payload.position !== state.queuedTurnIds.length + 1
    ) {
      return illegalTransition();
    }
  }
  if (event.type === "UserMessageAccepted") {
    if (state.activeTurnId !== null) return illegalTransition();
    if (
      current !== undefined &&
      (current.status !== "queued" || state.queuedTurnIds[0] !== turnId)
    ) {
      return illegalTransition();
    }
    if (current === undefined && state.queuedTurnIds.length > 0) {
      return illegalTransition();
    }
  }
  if (event.type === "TurnStarted" && state.activeTurnId !== null) {
    return illegalTransition();
  }

  const nextTurn = reduceRobinTurn(current, event);
  const turns = [...state.turns];
  if (index < 0) turns.push(nextTurn);
  else turns[index] = nextTurn;

  let activeTurnId = state.activeTurnId;
  let queuedTurnIds = [...state.queuedTurnIds];
  if (event.type === "UserMessageQueued") queuedTurnIds.push(turnId);
  if (event.type === "UserMessageAccepted" && current?.status === "queued") {
    queuedTurnIds = queuedTurnIds.slice(1);
  }
  if (event.type === "TurnStarted") activeTurnId = turnId;
  if (isTerminalTurnStatus(nextTurn.status)) {
    if (activeTurnId === turnId) activeTurnId = null;
    queuedTurnIds = queuedTurnIds.filter((queued) => queued !== turnId);
  }

  return freezeProjection({
    ...state,
    activeTurnId,
    lastSequence: event.sequence,
    queuedTurnIds: Object.freeze(queuedTurnIds),
    turns: Object.freeze(turns),
  });
}

function freezeProjection(
  state: RobinSessionProjection,
): RobinSessionProjection {
  return Object.freeze(state);
}

function illegalTransition(): never {
  throw new RobinSessionError(
    "illegal_transition",
    "Illegal Robin session transition.",
  );
}
