import { MAX_WAIT_MS, POLL_MS } from "./config.js";
import { classifyRisk } from "./policy.js";
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
    readonly code: "INVALID_SQL_POLICY" | "NO_SESSION_LABEL",
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
  /** True when the result rows were stripped after the retention window. */
  purged?: boolean;
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
    purged?: boolean;
  };
  switch (req.state) {
    case "approved":
      if (result.purged) {
        return { status: "approved", purged: true, rows: [], fields: [] };
      }
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
  harness?: string | null;
  harnessVersion?: string | null;
  project?: string | null;
}

/** Preflight the advisory policy and enqueue a proposal, returning a ticket. */
export function submitQuery(store: RequestStore, input: SubmitInput): Ticket {
  // Advisory now: only empty/multi-statement are refused here. A write/destructive is
  // forwarded and shown to the human, who arms the matching mode and approves it.
  const risk = classifyRisk(input.sql);
  if (!risk.ok) {
    throw new ServiceError(
      "INVALID_SQL_POLICY",
      risk.reason ?? "Only a single valid statement is allowed",
    );
  }
  // Gate every submission on a session label so a human can tell the agents apart
  // in the roster before deciding whether to approve their queries.
  const label = store.getSession(input.sessionId)?.sessionLabel;
  if (label === null || label === undefined || label.trim() === "") {
    throw new ServiceError(
      "NO_SESSION_LABEL",
      "Set a session label with set_session_label before proposing a query.",
    );
  }
  store.upsertSession({
    sessionId: input.sessionId,
    harness: input.harness,
    harnessVersion: input.harnessVersion,
    project: input.project,
  });
  const req = store.submit({
    sessionId: input.sessionId,
    sql: input.sql,
    intent: input.intent,
    idempotencyKey: input.idempotencyKey,
    // Stamp the risk class into the persisted policy for the audit trail.
    policy: { class: risk.class, ok: risk.ok },
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
    req = store.getForSession(requestId, sessionId);
  }
  return toTicket(req);
}

export interface SessionResult {
  requestId: string;
  intent: string | null;
  state: RequestState;
}

// Status of every recent request in the session at once, optionally waiting
// (bounded) until at least one still-open one resolves, so the agent can work in
// parallel and collect approvals as they land instead of blocking on one id.
export async function pollResults(
  store: RequestStore,
  sessionId: string,
  waitMs = 0,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
): Promise<{ results: SessionResult[]; pending: number }> {
  const openIds = store
    .listSessionRequests(sessionId)
    .filter((r) => !isTerminal(r.state))
    .map((r) => r.id);
  const deadline = now() + Math.max(0, Math.min(waitMs, MAX_WAIT_MS));
  while (openIds.length > 0 && now() < deadline) {
    const open = new Set(
      store
        .listSessionRequests(sessionId)
        .filter((r) => !isTerminal(r.state))
        .map((r) => r.id),
    );
    if (openIds.some((id) => !open.has(id))) {
      break;
    }
    await sleep(POLL_MS);
  }
  const rows = store.listSessionRequests(sessionId);
  return {
    results: rows.map((r) => ({ requestId: r.id, intent: r.intent, state: r.state })),
    pending: rows.filter((r) => !isTerminal(r.state)).length,
  };
}

/** Withdraw a pending or leased request the agent no longer wants. */
export function cancelQuery(store: RequestStore, sessionId: string, requestId: string): Ticket {
  return toTicket(store.cancel(requestId, sessionId));
}
