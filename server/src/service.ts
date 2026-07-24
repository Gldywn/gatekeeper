import { MAX_WAIT_MS, POLL_MS } from "./config.js";
import { assessReadOnly } from "./policy.js";
import type { GatekeeperRequest, RequestState, RequestStore } from "./store.js";

const TERMINAL_STATES: ReadonlySet<RequestState> = new Set([
  "approved",
  "rejected",
  "failed",
  "expired",
  "cancelled",
]);

export function isTerminal(state: RequestState): boolean {
  return TERMINAL_STATES.has(state);
}

export class ServiceError extends Error {
  constructor(
    readonly code: "INVALID_SQL_POLICY",
    detail: string,
  ) {
    super(`[${code}] ${detail}`);
    this.name = "ServiceError";
  }
}

export interface TerminalResult {
  status: "approved" | "rejected" | "failed" | "expired" | "cancelled";
  rows?: unknown[];
  fields?: unknown[];
  reason?: string;
  error?: string;
}

export interface Ticket {
  requestId: string;
  state: RequestState;
  createdAt: number;
  expiresAt: number;
  terminal?: TerminalResult;
}

function terminalOf(req: GatekeeperRequest): TerminalResult {
  const result = (req.result ?? {}) as {
    rows?: unknown[];
    fields?: unknown[];
    reason?: string | null;
    error?: string;
  };
  switch (req.state) {
    case "approved":
      return { status: "approved", rows: result.rows ?? [], fields: result.fields ?? [] };
    case "rejected":
      return { status: "rejected", reason: result.reason ?? undefined };
    case "failed":
      return { status: "failed", error: result.error ?? "unknown" };
    case "expired":
      return { status: "expired" };
    default:
      return { status: "cancelled" };
  }
}

export function toTicket(req: GatekeeperRequest): Ticket {
  const ticket: Ticket = {
    requestId: req.id,
    state: req.state,
    createdAt: req.createdAt,
    expiresAt: req.expiresAt,
  };
  if (isTerminal(req.state)) {
    ticket.terminal = terminalOf(req);
  }
  return ticket;
}

export interface SubmitInput {
  sessionId: string;
  sql: string;
  intent?: string;
  idempotencyKey?: string;
}

/** Preflight the policy and enqueue a read-only proposal, returning a ticket. */
export function submitQuery(store: RequestStore, input: SubmitInput): Ticket {
  const policy = assessReadOnly(input.sql);
  if (!policy.readOnly) {
    throw new ServiceError(
      "INVALID_SQL_POLICY",
      policy.reason ?? "Only read-only SELECT queries are allowed",
    );
  }
  const req = store.submit({
    sessionId: input.sessionId,
    sql: input.sql,
    intent: input.intent,
    idempotencyKey: input.idempotencyKey,
    policy,
  });
  return toTicket(req);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Read a ticket, optionally waiting (bounded) for it to reach a terminal state. */
export async function getQueryResult(
  store: RequestStore,
  sessionId: string,
  requestId: string,
  waitMs = 0,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
): Promise<Ticket> {
  let req = store.getForSession(requestId, sessionId);
  const deadline = now() + Math.max(0, Math.min(waitMs, MAX_WAIT_MS));
  while (!isTerminal(req.state) && now() < deadline) {
    await sleep(POLL_MS);
    store.sweep();
    req = store.getForSession(requestId, sessionId);
  }
  return toTicket(req);
}

/** Withdraw a pending or leased request the agent no longer wants. */
export function cancelQuery(store: RequestStore, sessionId: string, requestId: string): Ticket {
  return toTicket(store.cancel(requestId, sessionId));
}
