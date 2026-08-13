import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AccessMode, ActivityEntry, Proposal, SessionRoster } from "@gatekeeper/shared";
import { BROKER_HOST, brokerPort, LEASE_MS } from "./config.js";
import { connectionScopeKey } from "./connection.js";
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

export function createBroker(store: RequestStore, pluginId: string, token: string): Server {
  const port = brokerPort();
  const allowedHosts = new Set([`${BROKER_HOST}:${port}`, `localhost:${port}`]);
  return createServer((req, res) => {
    handle(store, pluginId, allowedHosts, token, req, res).catch((err) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handle(
  store: RequestStore,
  pluginId: string,
  allowedHosts: Set<string>,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // DNS-rebinding defense: only serve loopback Host headers.
  const host = req.headers.host;
  if (!host || !allowedHosts.has(host)) {
    send(res, 421, { error: "unexpected Host header" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, baseHeaders());
    res.end();
    return;
  }

  // Any local process can reach loopback, so require the shared capability
  // token on every non-preflight request.
  if (req.headers.authorization !== `Bearer ${token}`) {
    send(res, 401, { error: "unauthorized" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${BROKER_HOST}`);

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
    guarded(res, () => {
      const renewed = store.renewLease(String(body.id), String(body.leaseId), LEASE_MS);
      send(res, 200, { leaseExpiresAt: renewed.leaseExpiresAt });
    });
    return;
  }

  send(res, 404, { error: "not found" });
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

function guarded(res: ServerResponse, fn: () => void): void {
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
      send(res, status, { error: err.message, code: err.code });
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

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { ...baseHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
