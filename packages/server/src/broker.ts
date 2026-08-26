import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AccessMode, ActivityEntry, Proposal, SessionRoster } from "@gatekeeper/shared";
import {
  BROKER_HOST,
  brokerPort,
  LEASE_MS,
  PAIRING_ATTEMPT_BURST,
  PAIRING_ATTEMPT_REFILL_MS,
  PAIRING_CODE_TTL_MS,
  PAIRING_IDLE_MS,
  PAIRING_MAX_ATTEMPTS,
} from "./config.js";
import { connectionScopeKey } from "./connection.js";
import { pairingPage } from "./pairing-page.js";
import { type Outcome, type RequestStore, StoreError } from "./store.js";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Gatekeeper-Connection",
  // The plugin runs on a secure plugin:// origin; Chromium's Private Network
  // Access gates its fetch to loopback unless the preflight grants this.
  "Access-Control-Allow-Private-Network": "true",
};
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const PAIRING_BODY_BYTES = 1024;
// The plugin polls at 1 Hz; coalesce its presence writes to this cadence.
const PRESENCE_STAMP_MS = 15_000;

interface Broker {
  store: RequestStore;
  pluginId: string;
  allowedHosts: Set<string>;
  token: string;
  /** Last presence stamp, so the plugin's 1 Hz poll does not write on every request. */
  stampedAt: number;
}

export function createBroker(store: RequestStore, pluginId: string, token: string): Server {
  const port = brokerPort();
  const broker: Broker = {
    store,
    pluginId,
    token,
    allowedHosts: new Set([`${BROKER_HOST}:${port}`, `localhost:${port}`]),
    stampedAt: 0,
  };
  return createServer((req, res) => {
    handle(broker, req, res).catch((err) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handle(broker: Broker, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { store, pluginId, token } = broker;
  // DNS-rebinding defense: only serve loopback Host headers.
  const host = req.headers.host;
  if (!host || !broker.allowedHosts.has(host)) {
    send(res, 421, { error: "unexpected Host header" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, baseHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${BROKER_HOST}`);

  // A plugin holding no token has to tell "no broker running" apart from "broker
  // up, not paired". Deliberately empty: every other route already discloses the
  // broker's existence through a CORS-readable 401.
  if (req.method === "GET" && url.pathname === "/pair/status") {
    send(res, 200, { ok: true });
    return;
  }

  // This page carries the code in the clear, so it must NOT get the CORS headers below:
  // without them a cross-origin caller never sees the body, and a top-level navigation
  // needs no CORS. Triggering it blindly gains nothing: mint-or-reuse keeps a live code.
  if (req.method === "GET" && url.pathname === "/pair") {
    const code = store.issuePairingCode(PAIRING_CODE_TTL_MS, PAIRING_IDLE_MS);
    sendPage(res, pairingPage(code, Date.now()));
    return;
  }

  // The plugin's iframe reads this answer, so it keeps CORS and with it the reach of any
  // web page. The code, its attempt cap and its guess budget are the whole defence.
  if (req.method === "POST" && url.pathname === "/pair/exchange") {
    // Unauthenticated, so it gets a body cap of its own rather than the 32MB one the
    // result payloads need.
    const body = await readJson(req, PAIRING_BODY_BYTES);
    exchange(store, token, typeof body.code === "string" ? body.code : "", res);
    return;
  }

  // Any local process can reach loopback, so require the shared capability
  // token on every non-preflight request.
  if (req.headers.authorization !== `Bearer ${token}`) {
    send(res, 401, { error: "unauthorized" });
    return;
  }

  // A live token holder is a paired plugin: that presence is what stops the agent-facing
  // tools asking for a code, and what stops a fresh code being handed out.
  const now = Date.now();
  if (now - broker.stampedAt > PRESENCE_STAMP_MS) {
    broker.stampedAt = now;
    store.markPaired();
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    const sessions: SessionRoster[] = store.listSessions(resolveConnection(store, req));
    send(res, 200, { sessions });
    return;
  }

  // Host-side audit feed: the plugin's iframe reads it under the same auth and
  // connection scoping as /sessions. Never an MCP tool; the SQL it carries can
  // hold PII literals, so no agent-facing surface exposes it.
  if (req.method === "GET" && url.pathname === "/activity") {
    const activity: ActivityEntry[] = store.listActivity(resolveConnection(store, req));
    send(res, 200, { activity });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pending") {
    const proposal = store.claimNext(pluginId, LEASE_MS, resolveConnection(store, req));
    if (!proposal) {
      res.writeHead(204, baseHeaders());
      res.end();
      return;
    }
    const wire: Proposal = {
      id: proposal.id,
      sql: proposal.sql,
      intent: proposal.intent ?? undefined,
      class: proposalClass(proposal.policy),
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      leaseId: proposal.leaseId!,
      leaseExpiresAt: proposal.leaseExpiresAt!,
      sessionId: proposal.sessionId,
      session: store.getSession(proposal.sessionId),
    };
    send(res, 200, wire);
    return;
  }

  // Re-hydrate a reopened plugin: the proposals this pluginId already holds under
  // a live lease, so a fresh tab shows them without waiting for the lease to lapse.
  if (req.method === "GET" && url.pathname === "/inflight") {
    const inflight: Proposal[] = store.listInflight(pluginId, resolveConnection(store, req)).map(
      (p): Proposal => ({
        id: p.id,
        sql: p.sql,
        intent: p.intent ?? undefined,
        class: proposalClass(p.policy),
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        leaseId: p.leaseId!,
        leaseExpiresAt: p.leaseExpiresAt!,
        sessionId: p.sessionId,
        session: store.getSession(p.sessionId),
      }),
    );
    send(res, 200, { inflight });
    return;
  }

  if (req.method === "POST" && url.pathname === "/executing") {
    const body = await readJson(req);
    guarded(res, () => {
      store.markExecuting(String(body.id), String(body.leaseId));
      send(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/result") {
    const body = await readJson(req);
    guarded(res, () => {
      store.resolve(String(body.id), String(body.leaseId), toOutcome(body));
      send(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/connection") {
    const body = await readJson(req);
    store.setConnection(body);
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/schema") {
    const body = await readJson(req);
    store.setSchema(body);
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/schema/touch") {
    store.touchSchema();
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/lease/renew") {
    const body = await readJson(req);
    guarded(
      res,
      () => {
        const renewed = store.renewLease(String(body.id), String(body.leaseId), LEASE_MS);
        send(res, 200, { leaseExpiresAt: renewed.leaseExpiresAt });
      },
      // A refusal alone cannot tell the plugin whether the proposal died or simply went
      // back in the pool. Settle the row first, so a lapsed lease has already become
      // pending (or expired) rather than reading as still leased.
      () => {
        store.sweep();
        return { state: store.get(String(body.id))?.state ?? null };
      },
    );
    return;
  }

  send(res, 404, { error: "not found" });
}

function exchange(
  store: RequestStore,
  token: string,
  submitted: string,
  res: ServerResponse,
): void {
  // A typo of the wrong shape costs nothing: only a well-formed guess spends the budget.
  if (!/^\d{6}$/.test(submitted)) {
    send(res, 400, { error: "the pairing code is six digits" });
    return;
  }
  const outcome = store.redeemPairingCode(submitted, {
    maxAttempts: PAIRING_MAX_ATTEMPTS,
    burst: PAIRING_ATTEMPT_BURST,
    refillMs: PAIRING_ATTEMPT_REFILL_MS,
  });
  if (outcome.ok) {
    send(res, 200, { token });
    return;
  }
  if (outcome.reason === "throttled") {
    res.writeHead(429, {
      ...baseHeaders(),
      "Content-Type": "application/json",
      "Retry-After": String(Math.ceil(outcome.retryAfterMs / 1000)),
    });
    res.end(
      JSON.stringify({
        error: "too many attempts, wait a moment",
        retryAfterMs: outcome.retryAfterMs,
      }),
    );
    return;
  }
  send(
    res,
    401,
    outcome.reason === "expired"
      ? { error: "no pairing code is active; ask your agent for a new one" }
      : { error: "wrong code" },
  );
}

// The plugin's header carries the composite scope key for the tab making the
// request; only when it is absent do we fall back to the last-posted snapshot
// (shared, so it can lag behind a multi-tab caller's real connection).
function resolveConnection(store: RequestStore, req: IncomingMessage): string | null {
  const header = req.headers["x-gatekeeper-connection"];
  if (typeof header === "string" && header) {
    try {
      return decodeURIComponent(header);
    } catch {
      return header;
    }
  }
  const conn = store.getConnection();
  return conn ? connectionScopeKey(conn) : null;
}

// detail() adds fields to a StoreError body. It runs inside the catch, so it must not
// throw; anything it raises is swallowed and the plain error is sent.
function guarded(
  res: ServerResponse,
  fn: () => void,
  detail?: () => Record<string, unknown>,
): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof StoreError) {
      const status =
        err.code === "NOT_FOUND"
          ? 404
          : err.code === "NOT_OWNER"
            ? 403
            : err.code === "LEASE_CONFLICT" || err.code === "INVALID_STATE"
              ? 409
              : 400;
      let extra: Record<string, unknown> = {};
      try {
        extra = detail?.() ?? {};
      } catch {
        // deliberately ignored
      }
      send(res, status, { error: err.message, code: err.code, ...extra });
      return;
    }
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// The advisory risk class stamped at submit, surfaced on the proposal so the plugin
// can show it while still recomputing authoritatively.
function proposalClass(policy: unknown): AccessMode | null {
  if (policy && typeof policy === "object" && "class" in policy) {
    const c = (policy as { class: unknown }).class;
    return c === "read" || c === "write" || c === "destructive" ? c : null;
  }
  return null;
}

function toOutcome(body: Record<string, unknown>): Outcome {
  if (body.status === "approved") {
    if (body.error) {
      return { status: "failed", error: String(body.error) };
    }
    const rows = Array.isArray(body.rows) ? body.rows : [];
    return {
      status: "approved",
      rows,
      fields: Array.isArray(body.fields) ? body.fields : [],
      truncated: body.truncated === true,
      rowCount: typeof body.rowCount === "number" ? body.rowCount : rows.length,
      // No default: a plugin that cannot report it must leave the agent without an
      // answer rather than with a zero it would trust.
      ...(typeof body.affectedRows === "number" ? { affectedRows: body.affectedRows } : {}),
    };
  }
  return {
    status: "rejected",
    reason: typeof body.reason === "string" ? body.reason : undefined,
  };
}

function baseHeaders(): Record<string, string> {
  return { ...CORS, "Cache-Control": "no-store" };
}

// Deliberately not baseHeaders(): no Access-Control-Allow-Origin, so a cross-origin
// caller never gets to read the code out of this body.
function sendPage(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { ...baseHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJson(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}
