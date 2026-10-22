import type { ActivityEntry, Proposal } from "@gatekeeper/shared";
import { ResultArchive } from "../src/archive";
import { activity, keptResults, proposals, roster, scenario } from "./fixtures";

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
// Sealed rows by request id: what the plugin posted with a decision, or today's seeded rows
// sealed on first read under the plugin's own key, which the fake host storage shares.
const sealed = new Map<string, string>();
const seeded = keptResults();
const archive = new ResultArchive();

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
    const size = Math.min(Number(url.searchParams.get("limit") ?? PAGE) || PAGE, PAGE);
    return json({ activity: older.slice(0, size), more: older.length > size });
  }
  const kept = /^\/results\/(req_[0-9a-f]+)$/.exec(path)?.[1];
  if (method === "GET" && kept) {
    const rows = seeded.get(kept);
    if (!sealed.has(kept) && rows) sealed.set(kept, await archive.seal(rows, kept));
    const payload = sealed.get(kept);
    return payload ? json({ payload }) : json({ error: "not found" }, 404);
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
      if (state === "approved" && typeof body.archive === "string") sealed.set(p.id, body.archive);
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
        sensitivity: body.sensitivity,
        kept: sealed.has(p.id),
        ...(state === "rejected" && body.declinedBy ? { declinedBy: body.declinedBy } : {}),
        ...(state === "rejected" && body.reasonTyped === true ? { reasonTyped: true } : {}),
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
  const native = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
      location.href,
    );
    // The PostgreSQL grammar's WASM is a static asset of this page, not a broker call.
    if (url.origin === location.origin && url.pathname.endsWith("/libpg-query.wasm")) {
      return native(input, init);
    }
    if (url.origin !== BROKER) {
      throw new Error(`[preview broker] blocked ${url.href}`);
    }
    return route(url, init);
  };
}
