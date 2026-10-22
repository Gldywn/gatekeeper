import type { ActivityEntry, Proposal } from "@gatekeeper/shared";
import { activity, proposals, roster, scenario } from "./fixtures";

// The broker the plugin polls, answered in memory. Installed before the app boots; a request to
// any other origin, or to a route this table does not know, fails loudly and never reaches the
// network, so the preview cannot touch the operator's broker on port 9999.

const BROKER = "http://localhost:9999";
const IDENTITY = encodeURIComponent(
  JSON.stringify({ version: "0.3.1", dev: { branch: "preview" } }),
);
// Smaller than the server's 200 by default, so a few weeks of fixtures exercise paging and its tail.
const PAGE = scenario.page;

const offered = proposals();
const feed: ActivityEntry[] = activity();
const claimed = new Map<string, Proposal>();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Gatekeeper-Server": IDENTITY },
  });
const empty = (status = 204) =>
  new Response(null, { status, headers: { "X-Gatekeeper-Server": IDENTITY } });

async function route(url: URL, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const path = url.pathname;
  if (method === "GET" && path === "/pending") {
    const next = offered.shift();
    if (!next) return empty();
    claimed.set(next.id, next);
    return json(next);
  }
  if (method === "GET" && path === "/inflight") return json({ inflight: [] });
  if (method === "GET" && path === "/sessions") {
    const sessions = roster().map((s) => ({
      ...s,
      pendingCount: [...claimed.values()].filter((p) => p.sessionId === s.sessionId).length,
    }));
    return json({ sessions });
  }
  if (method === "GET" && path === "/activity") {
    // The server's order and cursor: newest first by (decidedAt, id), strictly older than the
    // last entry the plugin holds, so ties on a timestamp are never skipped.
    const before = url.searchParams.get("before");
    const beforeId = url.searchParams.get("beforeId") ?? "";
    const at = (e: ActivityEntry) => e.decidedAt ?? e.createdAt;
    const sorted = [...feed].sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : -1));
    const older = before
      ? sorted.filter(
          (e) => at(e) < Number(before) || (at(e) === Number(before) && e.id < beforeId),
        )
      : sorted;
    return json({ activity: older.slice(0, PAGE), more: older.length > PAGE });
  }
  if (method === "GET" && path === "/pair/status") return json({ ok: true });
  if (method === "POST" && path === "/lease/renew") {
    return json({ leaseExpiresAt: Date.now() + 30_000 });
  }
  if (method === "POST" && (path === "/executing" || path === "/execution/withdraw")) {
    return json({ ok: true });
  }
  if (method === "POST" && path === "/result") {
    const p = claimed.get(body.id);
    claimed.delete(body.id);
    if (p) {
      const state = body.status === "approved" ? (body.error ? "failed" : "approved") : "rejected";
      feed.unshift({
        id: p.id,
        createdAt: p.createdAt,
        decidedAt: Date.now(),
        sessionId: p.sessionId,
        harness: p.session?.harness ?? null,
        project: p.session?.project ?? null,
        sessionLabel: p.session?.sessionLabel ?? null,
        sql: p.sql,
        intent: p.intent ?? null,
        state,
        reason: body.reason ?? null,
        error: body.error ?? null,
        rowCount: body.rowCount ?? null,
        affectedRows: body.affectedRows ?? null,
      });
    }
    return json({ ok: true });
  }
  if (method === "POST" && ["/connection", "/schema", "/schema/touch"].includes(path)) {
    return empty();
  }
  if (method === "POST" && path === "/evaluate/key") return json({ status: "invalid" });
  throw new Error(`[preview broker] no fixture for ${method} ${path}`);
}

export function installBroker(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== BROKER) {
      throw new Error(`[preview broker] blocked ${url.href}`);
    }
    return route(url, init);
  };
}
