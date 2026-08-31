import { createDomainError } from "@guard/contracts";

export interface CancellationScope {
  readonly signal: AbortSignal;
  readonly closed: boolean;
  close(): void;
}

class LinkedCancellationScope implements CancellationScope {
  readonly #controller = new AbortController();
  readonly #parents: readonly AbortSignal[];
  readonly #onAbort: () => void;
  #closed = false;

  public constructor(parents: readonly AbortSignal[]) {
    this.#parents = Object.freeze([...parents]);
    this.#onAbort = () => this.abort();
    for (const parent of this.#parents) {
      if (parent.aborted) {
        this.abort();
        break;
      }
      parent.addEventListener("abort", this.#onAbort, { once: true });
    }
  }

  public get signal(): AbortSignal {
    return this.#controller.signal;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public abort(reason?: unknown): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    this.close();
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const parent of this.#parents) {
      parent.removeEventListener("abort", this.#onAbort);
    }
  }
}

interface SessionScopes {
  readonly scope: LinkedCancellationScope;
  turn: LinkedCancellationScope | null;
  readonly tools: Set<LinkedCancellationScope>;
}

/** Root → session → turn → tool cancellation ownership for the R1 process. */
export class CancellationTree {
  readonly #root = new LinkedCancellationScope([]);
  readonly #sessions = new Map<string, SessionScopes>();

  public get signal(): AbortSignal {
    return this.#root.signal;
  }

  public openSession(sessionId: string): CancellationScope {
    if (this.#sessions.has(sessionId)) conflict("Session cancellation scope exists.");
    const scope = new LinkedCancellationScope([this.#root.signal]);
    this.#sessions.set(sessionId, { scope, turn: null, tools: new Set() });
    return scope;
  }

  public openTurn(sessionId: string): CancellationScope {
    const session = this.#requireSession(sessionId);
    if (session.turn !== null) conflict("A turn cancellation scope is active.");
    const turn = new LinkedCancellationScope([session.scope.signal]);
    session.turn = turn;
    return turn;
  }

  public openTool(sessionId: string): CancellationScope {
    const session = this.#requireSession(sessionId);
    if (session.turn === null) conflict("A tool requires an active turn scope.");
    const tool = new LinkedCancellationScope([session.turn.signal]);
    session.tools.add(tool);
    return Object.freeze({
      get signal() {
        return tool.signal;
      },
      get closed() {
        return tool.closed;
      },
      close() {
        tool.close();
        session.tools.delete(tool);
      },
    });
  }

  public abortTurn(sessionId: string, reason: unknown = "turn_cancelled"): void {
    const session = this.#requireSession(sessionId);
    session.turn?.abort(reason);
    this.closeTurn(sessionId);
  }

  public closeTurn(sessionId: string): void {
    const session = this.#requireSession(sessionId);
    for (const tool of session.tools) tool.close();
    session.tools.clear();
    session.turn?.close();
    session.turn = null;
  }

  public abortSession(
    sessionId: string,
    reason: unknown = "session_cancelled",
  ): void {
    const session = this.#requireSession(sessionId);
    session.scope.abort(reason);
    for (const tool of session.tools) tool.close();
    session.turn?.close();
    this.#sessions.delete(sessionId);
  }

  public close(): void {
    this.#root.abort("application_shutdown");
    for (const session of this.#sessions.values()) {
      for (const tool of session.tools) tool.close();
      session.turn?.close();
      session.scope.close();
    }
    this.#sessions.clear();
  }

  #requireSession(sessionId: string): SessionScopes {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw createDomainError({
        code: "invalid_input",
        message: "The session cancellation scope does not exist.",
      });
    }
    return session;
  }
}

function conflict(message: string): never {
  throw createDomainError({ code: "conflict", message });
}
