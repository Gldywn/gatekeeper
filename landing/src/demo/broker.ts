import type { ActivityEntry, Proposal } from "@gatekeeper/shared";
import { ResultArchive } from "../../../packages/plugin/src/archive";
import { activity, evaluation, keptResults, roster } from "./scenario";

// The broker the plugin polls, answered in memory as in the plugin's fixture preview. A request
// to any other origin fails and never reaches the network.

const BROKER = "http://localhost:9999";
const IDENTITY = encodeURIComponent(JSON.stringify(__GK_BUILD__));
const PAGE = 40;

const offered: Proposal[] = [];
let feed: ActivityEntry[] | undefined;
// The decisions taken in the replay, oldest first. Past this many, the oldest leaves the trail
// with its sealed rows, so a replay left open for hours stays the same size.
const made: string[] = [];
const MADE_MAX = 150;
const claimed = new Map<string, Proposal>();
// Who approved a query arrives with /executing, before it runs, as the server records it.
const approvals = new Map<string, Pick<ActivityEntry, "approval" | "sensitivity">>();
// Sealed rows by request id: what the plugin posted with a decision, or a seeded decision's rows
// sealed on first read under the plugin's own key, which the fake host storage holds.
const sealed = new Map<string, string>();
const seeded = keptResults();
let archive: ResultArchive | undefined;
// As the server keeps it: a heavy flag posted with /executing survives a /result without one.
const heavy = new Set<string>();

function trail(): ActivityEntry[] {
  if (!feed) feed = activity();
  return feed;
}

/** Hands the plugin a new proposal on its next poll. */
export function offer(p: Proposal): void {
  offered.push(p);
}

/** Whether a proposal still waits for a decision: offered, or held by the plugin. */
export function isOpen(id: string): boolean {
  return claimed.has(id) || offered.some((p) => p.id === id);
}

// The server ends a request still waiting at its expiry and records it; one already running
// ends with its result instead.
function sweep(): void {
  const now = Date.now();
  for (const p of [...claimed.values()]) {
    if (p.expiresAt > now || approvals.has(p.id)) continue;
    claimed.delete(p.id);
    record(p, { status: "expired" });
  }
  for (let i = offered.length - 1; i >= 0; i--) {
    if (offered[i].expiresAt <= now) record(offered.splice(i, 1)[0], { status: "expired" });
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Gatekeeper-Server": IDENTITY },
  });
const empty = (status = 204) =>
  new Response(null, { status, headers: { "X-Gatekeeper-Server": IDENTITY } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The server's order and cursor: newest first by (decidedAt, id), strictly older than the last
// entry the plugin holds, as the fixture preview serves them.
function page(url: URL): { activity: ActivityEntry[]; more: boolean } {
  const before = url.searchParams.get("before");
  const beforeId = url.searchParams.get("beforeId") ?? "";
  const at = (e: ActivityEntry) => e.decidedAt ?? e.createdAt;
  const sorted = [...trail()].sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : -1));
  const older = before
    ? sorted.filter((e) => at(e) < Number(before) || (at(e) === Number(before) && e.id < beforeId))
    : sorted;
  const size = Math.min(Number(url.searchParams.get("limit") ?? PAGE) || PAGE, PAGE);
  return { activity: older.slice(0, size), more: older.length > size };
}

// A decision taken in the replay, by Auto mode or by a visitor, joins the Audit Trail.
function record(p: Proposal, body: Record<string, unknown>): void {
  const state =
    body.status === "approved"
      ? body.error
        ? "failed"
        : "approved"
      : body.status === "expired"
        ? "expired"
        : "rejected";
  made.push(p.id);
  if (made.length > MADE_MAX) {
    const oldest = made.shift();
    const at = trail().findIndex((e) => e.id === oldest);
    if (at >= 0) trail().splice(at, 1);
    if (oldest) sealed.delete(oldest);
  }
  const approved = approvals.get(p.id);
  approvals.delete(p.id);
  if (body.heavy === true) heavy.add(p.id);
  if (state === "approved" && typeof body.archive === "string") sealed.set(p.id, body.archive);
  trail().unshift({
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
    reason: (body.reason as string | undefined) ?? null,
    error: (body.error as string | undefined) ?? null,
    rowCount: (body.rowCount as number | undefined) ?? null,
    affectedRows: (body.affectedRows as number | undefined) ?? null,
    approval: approved?.approval,
    autoHold: body.autoHold as ActivityEntry["autoHold"],
    sensitivity: (body.sensitivity as ActivityEntry["sensitivity"]) ?? approved?.sensitivity,
    kept: sealed.has(p.id),
    ...(state === "rejected" && body.declinedBy
      ? { declinedBy: body.declinedBy as ActivityEntry["declinedBy"] }
      : {}),
    ...(state === "rejected" && body.reasonTyped === true ? { reasonTyped: true } : {}),
    ...(heavy.has(p.id) ? { heavy: true as const } : {}),
  });
  heavy.delete(p.id);
}

async function keptRows(id: string): Promise<string | undefined> {
  const rows = seeded.get(id);
  if (!sealed.has(id) && rows) {
    if (!archive) archive = new ResultArchive();
    sealed.set(id, await archive.seal(rows, id));
  }
  return sealed.get(id);
}

async function route(url: URL, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const path = url.pathname;
  sweep();
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
  if (method === "GET" && path === "/activity") return json(page(url));
  const kept = /^\/results\/(req_[0-9a-f]+)$/.exec(path)?.[1];
  if (method === "GET" && kept) {
    const payload = await keptRows(kept);
    return payload ? json({ payload }) : json({ error: "not found" }, 404);
  }
  if (method === "GET" && path === "/pair/status") return json({ ok: true });
  if (method === "POST" && path === "/lease/renew") {
    return json({ leaseExpiresAt: Date.now() + 30_000 });
  }
  if (method === "POST" && path === "/executing") {
    approvals.set(body.id, { approval: body.approval, sensitivity: body.sensitivity });
    if (body.heavy === true) heavy.add(body.id);
    return json({ ok: true });
  }
  if (method === "POST" && path === "/execution/withdraw") {
    approvals.delete(body.id);
    return json({ ok: true });
  }
  if (method === "POST" && path === "/result") {
    const p = claimed.get(body.id);
    claimed.delete(body.id);
    if (p) record(p, body);
    return json({ ok: true });
  }
  if (method === "POST" && ["/connection", "/schema", "/schema/touch"].includes(path)) {
    return empty();
  }
  if (method === "POST" && path === "/evaluate/check") return json({ status: "valid" });
  if (method === "POST" && path === "/evaluate") {
    // Jev's answer, after the time an evaluation takes.
    await wait(2400);
    return json(evaluation(Date.now(), await digest(body.input.sql)));
  }
  return empty(404);
}

export function installBroker(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
      location.href,
    );
    if (url.origin !== BROKER) throw new Error(`blocked ${url.href}`);
    return route(url, init);
  };
}
