import "./style.css";
import type { Column, ConnectionInfo, RunQueryResult } from "@beekeeperstudio/plugin";
import {
  addNotificationListener,
  appStorage,
  clipboard,
  getAppInfo,
  getColumns,
  getConnectionInfo,
  log,
  requestFileSave,
  runQuery,
  setTabTitle,
} from "@beekeeperstudio/plugin";
import { enter, type Loop, pulse, reveal } from "./anim";
import { formatSql } from "./format";
import {
  buildingIcon,
  checkIcon,
  chevronDown,
  copyIcon,
  downloadIcon,
  harnessIcon,
  historyIcon,
  pencilIcon,
  sendIcon,
  warnIcon,
} from "./icons";
import { isReadOnlyQuery, mapDialect } from "./readonly";
import { capResult, cell, type Field, type HistResult } from "./result";
import {
  analyzeSql,
  clientColumns,
  piiColumns,
  type SchemaContext,
  sensitiveLiterals,
} from "./schema";

const BROKER_URL = "http://localhost:9999";
const POLL_MS = 1000;
const RENEW_MS = 15_000;
const TICK_MS = 1000;
const CONN_CHECK_MS = 5000;
const TOKEN_KEY = "gatekeeper.token";
const HIST_MAX = 20;
// Results are held in the iframe only to power the detail view; bound the total
// across all items here (the per-item caps live in ./result).
const HIST_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const ROSTER_POLL_MS = 2000;
// Mirror the server's SESSION_HEARTBEAT_MS margin: active if it acted recently,
// gone once its presence ping has been silent well past one heartbeat.
const SESSION_ACTIVE_MS = 30_000;
const SESSION_GONE_MS = 45_000;

type CardState = "ready" | "approving" | "executing" | "posting" | "rejecting";

type ConnectionState = "connecting" | "reconnecting" | "connected" | "error";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "connecting...",
  reconnecting: "reconnecting...",
  connected: "connected",
  error: "unreachable",
};

interface SessionMeta {
  sessionId: string;
  harness: string | null;
  harnessVersion: string | null;
  project: string | null;
  sessionLabel: string | null;
}

interface SessionRoster {
  sessionId: string;
  harness: string | null;
  harnessVersion: string | null;
  project: string | null;
  createdAt: number;
  lastSeen: number;
  lastActive: number;
  connection: string | null;
  leftAt: number | null;
  pendingCount: number;
  lastIntent: string | null;
  sessionLabel: string | null;
}

type Presence = "active" | "idle" | "gone";

const PRESENCE_ORDER: Record<Presence, number> = { active: 0, idle: 1, gone: 2 };

function presence(s: SessionRoster, now: number): Presence {
  if (s.leftAt !== null || now - s.lastSeen > SESSION_GONE_MS) {
    return "gone";
  }
  return now - s.lastActive <= SESSION_ACTIVE_MS ? "active" : "idle";
}

interface Proposal {
  id: string;
  sql: string;
  intent?: string;
  createdAt: number;
  expiresAt: number;
  leaseId: string;
  leaseExpiresAt: number;
  sessionId: string;
  session: SessionMeta | null;
}

interface Card extends Proposal {
  state: CardState;
  // Host-side only: which tables/PII the query touches, for the human's eyes.
  // Never posted to the broker, so the agent never learns the schema.
  schema?: SchemaContext | null;
}

interface HistItem {
  id: string;
  status: "ok" | "no";
  note: string;
  sql: string;
  resolvedAt: number;
  connection: string | null;
  session: SessionMeta | null;
  intent?: string;
  result?: HistResult;
}

// The durable, PII-safe audit record served by GET /activity. It never carries
// result rows: an approved query contributes a scalar rowCount only.
interface ActivityEntry {
  id: string;
  createdAt: number;
  decidedAt: number | null;
  sessionId: string;
  harness: string | null;
  project: string | null;
  sessionLabel: string | null;
  sql: string;
  intent: string | null;
  state: string;
  reason: string | null;
  error: string | null;
  rowCount: number | null;
}

async function runApprovedQuery(
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; fields: Field[] }> {
  const result: RunQueryResult = await runQuery(sql);
  // runQuery resolves (never throws) with an `error` field when the engine
  // rejects the query or the connection is down; surface it as a failure so the
  // agent gets "failed + reason", not a silent empty result.
  if (result.error) {
    throw new Error(runErrorText(result.error));
  }
  const first = result.results[0];
  return {
    rows: first?.rows ?? [],
    fields: (first?.fields ?? []).map((f) => ({ name: f.name })),
  };
}

function runErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Query execution failed";
}

// The broker token is a capability secret, so it lives in Beekeeper's encrypted
// store (appStorage's `encrypted` option maps to setEncryptedData/getEncryptedData).
async function loadToken(): Promise<string | null> {
  const encrypted = await appStorage.getItem<string>(TOKEN_KEY, { encrypted: true });
  if (encrypted) {
    return encrypted;
  }
  // Migrate a token an earlier build wrote in the clear, then wipe the plaintext.
  const legacy = await appStorage.getItem<string>(TOKEN_KEY);
  if (legacy) {
    await appStorage.setItem(TOKEN_KEY, legacy, { encrypted: true });
    await appStorage.setItem(TOKEN_KEY, "");
    return legacy;
  }
  return null;
}

async function storeToken(value: string): Promise<void> {
  await appStorage.setItem(TOKEN_KEY, value, { encrypted: true });
}

async function clearToken(): Promise<void> {
  await appStorage.setItem(TOKEN_KEY, "", { encrypted: true });
  await appStorage.setItem(TOKEN_KEY, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Display polish for an agent-written intent: force the first character upper,
// in case it arrived lowercase. A non-letter first char is left as-is.
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wrap the given column names where they appear in the highlighted SQL. The guards
// keep a match from landing inside an existing highlight span, a string, or a longer
// word, so passes for different classes compose without corrupting each other.
function markColumns(html: string, columns: readonly string[] | undefined, cls: string): string {
  if (!columns?.length) {
    return html;
  }
  const flag = new RegExp(`(?<![\\w>"'])(${columns.map(escapeRegExp).join("|")})(?![\\w<])`, "gi");
  return html.replace(flag, `<span class="${cls}">$1</span>`);
}

function highlight(
  sql: string,
  pii?: readonly string[],
  client?: readonly string[],
  literals?: readonly string[],
): string {
  const sensitive = new Set(literals ?? []);
  let html = escapeHtml(sql)
    .replace(
      /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|LIMIT|AS|AND|OR|JOIN|ON|INTERVAL|DELETE|UPDATE|INSERT|WITH)\b/g,
      '<span class="kw">$1</span>',
    )
    .replace(/\b(count|sum|now|avg|max|min)\b/g, '<span class="fn">$1</span>')
    // A string literal exposing a sensitive value gets an extra class so the value,
    // not just the column, stands out in the query text.
    .replace(
      /('[^']*')/g,
      (m) => `<span class="st${sensitive.has(m.slice(1, -1)) ? " sensitive-val" : ""}">${m}</span>`,
    );
  html = markColumns(html, pii, "pii-col");
  html = markColumns(html, client, "client-col");
  return html;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

function relAge(createdAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

const HIST_SQL_PREVIEW_CHARS = 140;

// Truncate the raw SQL before highlight()/escapeHtml() run, so highlight() only
// ever wraps complete substrings; slicing already-highlighted HTML could cut a tag.
function previewSql(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > HIST_SQL_PREVIEW_CHARS
    ? `${flat.slice(0, HIST_SQL_PREVIEW_CHARS)}...`
    : flat;
}

function sessionDisplayName(session: SessionMeta | null, fallback: string): string {
  const project = session?.project?.trim();
  if (project) {
    return project;
  }
  const harness = session?.harness?.trim();
  return harness || session?.sessionId || fallback;
}

// Local calendar-day key (YYYY-MM-DD) that groups the activity feed by day.
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}`;
}

function dayLabel(ts: number): string {
  const key = dayKey(ts);
  const now = Date.now();
  if (key === dayKey(now)) {
    return "Today";
  }
  if (key === dayKey(now - 86_400_000)) {
    return "Yesterday";
  }
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// Map a terminal state to the shared status tokens: green approved, red
// rejected/failed, faint for the neutral terminals (expired/cancelled).
function outcomeMeta(state: string): { cls: "ok" | "no" | "mut"; label: string } {
  if (state === "approved") {
    return { cls: "ok", label: "approved" };
  }
  if (state === "rejected") {
    return { cls: "no", label: "rejected" };
  }
  if (state === "failed") {
    return { cls: "no", label: "failed" };
  }
  return { cls: "mut", label: state };
}

// The short outcome note on a collapsed row: a scalar row count, the rejection
// reason, or the failure error. Never any row content.
function activityNote(e: ActivityEntry): string {
  if (e.state === "approved") {
    return e.rowCount != null ? `${e.rowCount} rows` : "";
  }
  if (e.state === "rejected") {
    return e.reason ?? "";
  }
  if (e.state === "failed") {
    return e.error ?? "";
  }
  return "";
}

const HEADER = `
  <header class="bar">
    <svg class="comb" width="118" height="86" viewBox="0 0 118 86" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.1">
      <defs><polygon id="hx" points="6,0 18,0 24,10.4 18,20.8 6,20.8 0,10.4"/></defs>
      <use href="#hx" x="64" y="2"/><use href="#hx" x="82" y="12.4"/><use href="#hx" x="82" y="-8"/>
      <use href="#hx" x="100" y="2"/><use href="#hx" x="100" y="22.8"/><use href="#hx" x="64" y="22.8"/><use href="#hx" x="46" y="12.4"/>
    </svg>
    <svg class="mark" viewBox="0 0 24 26" fill="none" aria-hidden="true">
      <polygon points="12,1.4 22,7 22,19 12,24.6 2,19 2,7" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <polygon points="12,7.4 16.8,10.2 16.8,15.8 12,18.6 7.2,15.8 7.2,10.2" fill="currentColor" fill-opacity="0.92"/>
    </svg>
    <span class="wordmark">Gatekeeper</span>
    <span class="conn" id="conn"></span>
    <span class="conn-status" id="connStatus" aria-live="polite"></span>
    <span class="count" id="count" aria-live="polite"></span>
  </header>`;

export class Gatekeeper {
  private token: string | null = null;
  private connectionName = "";
  private dialect = "postgresql";
  private conn: {
    connectionName: string;
    databaseType: string;
    databaseName: string;
    schema: string | null;
    readOnly: boolean;
  } | null = null;
  private readonly cards: Card[] = [];
  // Columns per "schema.table", populated on demand for the approval-card schema
  // annotation; cleared on a tablesChanged notification and on connection switch.
  private readonly schemaCache = new Map<string, Column[]>();
  // Open deny forms and their in-progress reason text, keyed by card id, so a
  // half-typed reason survives a queue rebuild from a concurrent proposal.
  private readonly denyDrafts = new Map<string, string>();
  private readonly history: HistItem[] = [];
  // The durable activity feed, fetched fresh each time the overlay opens; the set
  // tracks which entries have their full SQL expanded in place.
  private activity: ActivityEntry[] = [];
  private readonly activityExpanded = new Set<string>();
  private roster: SessionRoster[] = [];
  private rosterSig = "";
  private rosterLoops: Loop[] = [];
  private breatheLoop?: Loop;
  private prevCardIds = new Set<string>();
  private polling = false;
  private lastTitle = "";
  private lastConnCheck = 0;
  private connCheckInFlight = false;
  private connGeneration = 0;
  private renewTimer?: number;
  private tickTimer?: number;
  private pollTimer?: number;
  private pollFailures = 0;
  private pollGeneration = 0;
  private connectionState: ConnectionState = "connecting";
  // The history item whose detail overlay is open, so a late schema fetch only paints
  // a detail still on screen.
  private detailItemId: string | null = null;
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.closeActivity();
        this.closeDetail();
      }
    });
    // Refresh the moment the tab is looked at again (reopened or refocused), so
    // the queue is never stale while the human is watching it.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.pokePoll();
      }
    });
    window.addEventListener("focus", () => this.pokePoll());
    window.addEventListener("pageshow", () => this.pokePoll());
  }

  async start(): Promise<void> {
    this.token = await loadToken();
    try {
      this.applyConnection(await getConnectionInfo());
      this.lastConnCheck = Date.now();
    } catch {
      // Connection info is best-effort; the queue still works without it. A
      // failed initial read leaves lastConnCheck at 0 so the first tick retries.
    }
    if (!this.token) {
      this.renderPairing();
      return;
    }
    this.renderShell();
    // The schema annotation caches columns per table; a DDL change invalidates it.
    addNotificationListener("tablesChanged", () => this.schemaCache.clear());
    this.polling = true;
    void this.loadInflight();
    void this.poll();
    void this.pollRoster(++this.pollGeneration);
    void this.reportConnection();
    this.startTimers();
  }

  // Re-adopt the proposals still leased to this plugin so a reopened tab shows them
  // at once; renew right away so a near-expiry lease does not lapse before the timer.
  private async loadInflight(): Promise<void> {
    try {
      const gen = this.connGeneration;
      const res = await this.broker("/inflight", {
        headers: this.conn?.connectionName
          ? { "X-Gatekeeper-Connection": this.conn.connectionName }
          : {},
      });
      if (res.status !== 200) {
        return;
      }
      const { inflight } = (await res.json()) as { inflight: Proposal[] };
      // A connection switch mid-fetch means these belong to the old database.
      if (gen !== this.connGeneration) {
        return;
      }
      for (const proposal of inflight) {
        this.claim(proposal);
      }
      if (inflight.length) {
        void this.renew();
      }
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }

  // Derive our cached connection fields from a fresh snapshot. Shared by start()
  // and the connection-switch path so the two can never drift apart.
  private applyConnection(conn: ConnectionInfo): void {
    this.connectionName = conn.connectionName || conn.databaseName || "connection";
    this.dialect = mapDialect(conn.databaseType);
    this.conn = {
      connectionName: conn.connectionName,
      databaseType: conn.databaseType,
      databaseName: conn.databaseName,
      schema: conn.defaultSchema ?? null,
      readOnly: conn.readOnlyMode,
    };
  }

  // No connectionChanged notification exists, so a switch is caught by re-reading
  // getConnectionInfo(): a postMessage round-trip, throttled to ~5s on the tick
  // (a switch is rare) rather than paid every second.
  private maybeCheckConnection(): void {
    const now = Date.now();
    if (this.connCheckInFlight || now - this.lastConnCheck < CONN_CHECK_MS) {
      return;
    }
    this.lastConnCheck = now;
    this.connCheckInFlight = true;
    void this.checkConnection().finally(() => {
      this.connCheckInFlight = false;
    });
  }

  private async checkConnection(): Promise<void> {
    let conn: ConnectionInfo;
    try {
      conn = await getConnectionInfo();
    } catch {
      return; // Keep the last known connection; retry on the next throttle window.
    }
    const name = conn.connectionName || conn.databaseName || "connection";
    if (name === this.connectionName) {
      return;
    }
    this.applyConnection(conn);
    this.onConnectionSwitch();
  }

  private onConnectionSwitch(): void {
    // SAFETY-CRITICAL: a card claimed under the old connection must not run against
    // the new database. Bump the generation (aborts an in-flight approve) and drop
    // the cards; the broker re-offers still-pending proposals.
    this.connGeneration++;
    this.cards.length = 0;
    this.denyDrafts.clear();
    // The new database has a different schema; drop cached columns so the next
    // card's annotation cannot describe the old connection.
    this.schemaCache.clear();
    // History, activity, and roster are connection-scoped; reset so the old one
    // cannot leak in. The roster re-fetches on its own timer; the activity overlay
    // is closed because it now shows a different connection's audit trail.
    this.history.length = 0;
    this.activity = [];
    this.activityExpanded.clear();
    this.closeActivity();
    this.roster = [];
    this.rosterSig = "";
    this.renderConnLabel();
    void this.reportConnection();
    this.renderQueue();
    this.renderHistory();
    this.renderRoster();
  }

  // The connection context lives once, in the header: what database the whole
  // queue governs. Reads this.conn; falls back to the bare name pre-snapshot.
  private renderConnLabel(): void {
    const el = this.root.querySelector<HTMLSpanElement>("#conn");
    if (!el) {
      return;
    }
    const c = this.conn;
    if (!c) {
      el.innerHTML = this.connectionName ? escapeHtml(this.connectionName) : "";
      return;
    }
    const dialect = mapDialect(c.databaseType);
    const db = c.databaseName?.trim();
    const schema = c.schema?.trim();
    el.innerHTML = `
      <span class="cc-name">${escapeHtml(c.connectionName || this.connectionName)}</span>
      <span class="cc-dialect">${escapeHtml(dialect)}${db ? ` &middot; ${escapeHtml(db)}` : ""}</span>
      ${schema ? `<span class="cc-schema">schema ${escapeHtml(schema)}</span>` : ""}
      ${c.readOnly ? '<span class="cc-ro">read-only</span>' : ""}`;
  }

  // Hand the agent non-sensitive context (dialect, database, schema, read-only)
  // so it can target the right database; never host, user, or credentials.
  private async reportConnection(): Promise<void> {
    if (!this.conn) {
      return;
    }
    try {
      await this.broker("/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.conn),
      });
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }

  // Recreated on every (re-)pair; clear the old handles so re-pairing does not
  // stack duplicate renew/tick intervals for the life of the tab.
  private startTimers(): void {
    if (this.renewTimer !== undefined) {
      window.clearInterval(this.renewTimer);
    }
    if (this.tickTimer !== undefined) {
      window.clearInterval(this.tickTimer);
    }
    this.renewTimer = window.setInterval(() => void this.renew(), RENEW_MS);
    this.tickTimer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private async broker(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${BROKER_URL}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${this.token}` },
    });
  }

  private renderPairing(errorMessage = ""): void {
    this.root.innerHTML = `
      <div class="pair">
        <h1>Pair with the broker</h1>
        <p>Paste the token printed by the Gatekeeper server. It is stored in
          <code>~/.gatekeeper/broker-token</code>.</p>
        <div class="pair-row">
          <input id="token" type="password" placeholder="broker token" autocomplete="off" spellcheck="false" />
          <button class="btn approve" id="pair-btn" type="button">Pair</button>
        </div>
        <div class="err">${escapeHtml(errorMessage)}</div>
      </div>`;
    const input = this.root.querySelector<HTMLInputElement>("#token")!;
    const save = async () => {
      const value = input.value.trim();
      if (!value) {
        return;
      }
      await storeToken(value);
      this.token = value;
      this.polling = true;
      this.renderShell();
      void this.loadInflight();
      void this.poll();
      void this.pollRoster(++this.pollGeneration);
      void this.reportConnection();
      this.startTimers();
    };
    this.root
      .querySelector<HTMLButtonElement>("#pair-btn")!
      .addEventListener("click", () => void save());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        void save();
      }
    });
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="gk">
        ${HEADER}
        <div class="rail" id="rail">
          <section class="roster" id="roster"></section>
        </div>
        <div class="main" id="main">
          <p class="label">Pending approval</p>
          <div class="queue" id="queue"></div>
          <section class="history">
            <div class="history-head">
              <button class="disclosure" id="htoggle" aria-expanded="true"><span class="chev">${chevronDown}</span>Recently resolved</button>
              <button class="activity-link" id="activityBtn" type="button">${historyIcon}Activity</button>
            </div>
            <div class="hist" id="hist"></div>
          </section>
        </div>
        <div class="detail" id="detail" hidden></div>
        <div class="detail activity-overlay" id="activity" hidden></div>
      </div>`;
    this.renderConnLabel();
    const toggle = this.root.querySelector<HTMLButtonElement>("#htoggle")!;
    const hist = this.root.querySelector<HTMLDivElement>("#hist")!;
    toggle.addEventListener("click", () => {
      const open = hist.style.display !== "none";
      hist.style.display = open ? "none" : "";
      toggle.setAttribute("aria-expanded", String(!open));
    });
    const queue = this.root.querySelector<HTMLDivElement>("#queue")!;
    queue.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const copy = target.closest<HTMLElement>("[data-copy-sql]");
      const a = target.closest<HTMLElement>("[data-approve]");
      const r = target.closest<HTMLElement>("[data-reject]");
      const denyOpen = target.closest<HTMLElement>("[data-deny-open]");
      const deny = target.closest<HTMLElement>("[data-deny]");
      if (copy) {
        this.copySql(copy);
      } else if (a) {
        void this.approve(a.getAttribute("data-approve")!);
      } else if (r) {
        void this.reject(r.getAttribute("data-reject")!);
      } else if (denyOpen) {
        this.openDeny(denyOpen.getAttribute("data-deny-open")!);
      } else if (deny) {
        this.confirmDeny(deny.getAttribute("data-deny")!);
      }
    });
    queue.addEventListener("keydown", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLElement>("[data-deny-input]");
      if (!input) {
        return;
      }
      const id = input.getAttribute("data-deny-input")!;
      if (e.key === "Enter") {
        e.preventDefault();
        this.confirmDeny(id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeDeny(id);
      }
    });
    hist.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-hist]");
      if (!row) {
        return;
      }
      const item = this.history.find((h) => h.id === row.getAttribute("data-hist"));
      if (item) {
        this.openDetail(item);
      }
    });
    const detail = this.root.querySelector<HTMLDivElement>("#detail")!;
    detail.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const copy = target.closest<HTMLElement>("[data-copy-sql]");
      if (copy) {
        this.copySql(copy);
        return;
      }
      // Close on the backdrop or the close button, not on the card itself.
      if (target === detail || target.closest("[data-close]")) {
        this.closeDetail();
      }
    });
    this.root
      .querySelector<HTMLButtonElement>("#activityBtn")!
      .addEventListener("click", () => void this.openActivity());
    const activity = this.root.querySelector<HTMLDivElement>("#activity")!;
    activity.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const copy = target.closest<HTMLElement>("[data-copy-sql]");
      if (copy) {
        this.copySql(copy);
        return;
      }
      const exp = target.closest<HTMLElement>("[data-export]");
      if (exp) {
        void this.exportSession(exp.getAttribute("data-export")!);
        return;
      }
      const sql = target.closest<HTMLElement>("[data-act-sql]");
      if (sql) {
        this.toggleActivitySql(sql.getAttribute("data-act-sql")!);
        return;
      }
      if (target === activity || target.closest("[data-close]")) {
        this.closeActivity();
      }
    });
    this.renderQueue();
    this.renderHistory();
    this.renderRoster();
    // Rebuilt DOM has a blank pill; force it back to the initial state (the
    // guard in setConnectionState would otherwise skip writing the new node).
    this.setConnectionState("connecting", "", true);
    const gk = this.root.querySelector(".gk");
    if (gk) {
      reveal([...gk.children].filter((c) => !(c as HTMLElement).hidden));
    }
  }

  private setConnectionState(state: ConnectionState, detail = "", force = false): void {
    if (!force && this.connectionState === state) {
      return;
    }
    this.connectionState = state;
    const el = this.root.querySelector<HTMLSpanElement>("#connStatus");
    if (el) {
      el.dataset.state = state;
      el.textContent = CONNECTION_LABEL[state];
      el.title = detail;
    }
  }

  private async poll(): Promise<void> {
    if (!this.polling) {
      return;
    }
    let claimed = false;
    try {
      const res = await this.broker("/pending", {
        headers: this.conn?.connectionName
          ? { "X-Gatekeeper-Connection": this.conn.connectionName }
          : {},
      });
      if (res.status === 401) {
        this.polling = false;
        this.token = null;
        await clearToken();
        this.renderPairing("Token rejected. Paste the current one.");
        return;
      }
      if (res.status === 200) {
        claimed = true;
        this.claim((await res.json()) as Proposal);
      }
      this.pollFailures = 0;
      this.setConnectionState("connected");
    } catch (err) {
      // Stay quiet through a brief blip (e.g. the broker failing over during an
      // MCP reconnect); only surface the error once it has actually persisted.
      this.pollFailures++;
      if (this.pollFailures >= 3) {
        this.setConnectionState("error", `Broker unreachable at ${BROKER_URL}. Retrying...`);
      } else if (this.connectionState !== "connecting") {
        this.setConnectionState("reconnecting");
      }
      log.error(err instanceof Error ? err : String(err));
    }
    // Drain the queue back-to-back: /pending offers one proposal at a time, so a
    // claim likely means more are waiting; only idle at POLL_MS once it is empty.
    this.pollTimer = window.setTimeout(() => void this.poll(), claimed ? 0 : POLL_MS);
  }

  // Re-poll (and refresh the roster) right now instead of waiting out the
  // interval, so pending proposals appear the instant the tab regains focus or
  // is reopened, without spawning a second poll loop.
  private pokePoll(): void {
    if (!this.polling) {
      return;
    }
    if (this.pollTimer !== undefined) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    void this.poll();
    void this.pollRoster(++this.pollGeneration);
  }

  private async pollRoster(generation: number): Promise<void> {
    // A stale generation means a re-pair superseded this loop; bail so re-pairing
    // cannot leave two roster loops running at once.
    if (!this.polling || generation !== this.pollGeneration) {
      return;
    }
    try {
      const res = await this.broker("/sessions", {
        headers: this.conn?.connectionName
          ? { "X-Gatekeeper-Connection": this.conn.connectionName }
          : {},
      });
      if (res.status === 200) {
        this.roster = ((await res.json()) as { sessions: SessionRoster[] }).sessions;
        this.renderRoster();
      }
    } catch {
      // The roster is low-stakes context; a stale one is fine, and its failures
      // must not fight poll() over the connection-status indicator.
    }
    window.setTimeout(() => void this.pollRoster(generation), ROSTER_POLL_MS);
  }

  private renderRoster(): void {
    const el = this.root.querySelector<HTMLElement>("#roster");
    if (!el) {
      return;
    }
    const now = Date.now();
    const rows = this.roster
      .map((s) => ({ s, p: presence(s, now) }))
      // Keep a gone agent listed only while it still owns an open request the
      // human might act on; otherwise drop it so the roster stays current.
      .filter((r) => r.p !== "gone" || r.s.pendingCount > 0)
      .sort((a, b) => PRESENCE_ORDER[a.p] - PRESENCE_ORDER[b.p] || b.s.lastActive - a.s.lastActive);
    // Skip the rebuild (and the pulse restart) when only the relative ages moved;
    // tick() keeps those fresh in place.
    const sig = JSON.stringify(
      rows.map((r) => [r.s.sessionId, r.p, r.s.pendingCount, r.s.sessionLabel, r.s.lastIntent]),
    );
    if (sig === this.rosterSig) {
      return;
    }
    this.rosterSig = sig;
    const live = rows.filter((r) => r.p !== "gone").length;
    const list = rows.length
      ? rows.map(({ s, p }) => this.rosterRow(s, p)).join("")
      : '<div class="empty">No agents connected.</div>';
    el.innerHTML = `<div class="roster-head"><span class="label">Connected agents</span><span class="roster-count">${live}</span></div><div class="roster-list">${list}</div>`;
    for (const loop of this.rosterLoops) {
      loop.stop();
    }
    this.rosterLoops = [
      ...el.querySelectorAll('.roster-row[data-presence="active"] .presence-dot'),
    ].map((dot) => pulse(dot));
  }

  private rosterRow(s: SessionRoster, p: Presence): string {
    const harness = s.harness?.trim() || null;
    const project = s.project?.trim();
    const who = project ? escapeHtml(project) : escapeHtml(harness || s.sessionId);
    // Every listed session has a non-empty label (the roster query filters the
    // rest out), so render it directly with no placeholder branch.
    const scope = capitalize(s.sessionLabel?.trim() ?? "");
    const pending = s.pendingCount > 0 ? ` &middot; ${s.pendingCount} pending` : "";
    const meta =
      p === "active"
        ? `active${pending}`
        : p === "idle"
          ? `idle <span class="rage" data-age="${s.lastActive}">${relAge(s.lastActive)}</span>${pending}`
          : `left <span class="rage" data-age="${s.leftAt ?? s.lastSeen}">${relAge(s.leftAt ?? s.lastSeen)}</span>`;
    return `
      <div class="roster-row" data-presence="${p}">
        <span class="presence-dot"></span>
        <span class="harness-badge">${harnessIcon(harness)}</span>
        <span class="roster-label">${who}</span>
        <span class="roster-intent" title="${escapeHtml(scope)}">${escapeHtml(scope)}</span>
        <span class="roster-meta">${meta}</span>
      </div>`;
  }

  private claim(proposal: Proposal): void {
    const existing = this.cards.find((c) => c.id === proposal.id);
    if (existing) {
      // Keep the fresher lease if /inflight and a re-offered /pending race on the
      // same proposal, so a live lease is never overwritten by a stale one.
      if (proposal.leaseExpiresAt >= existing.leaseExpiresAt) {
        existing.leaseId = proposal.leaseId;
        existing.leaseExpiresAt = proposal.leaseExpiresAt;
      }
      return;
    }
    const card: Card = { ...proposal, state: "ready" };
    this.cards.push(card);
    this.renderQueue();
    void this.analyzeSchema(card);
  }

  // Annotate the card with the tables and PII-suspect columns the query touches.
  // Runs entirely host-side and stores the result on the card only; nothing here
  // ever reaches the broker, so the agent gains no schema knowledge.
  private async analyzeSchema(card: Card): Promise<void> {
    const schema = await this.schemaFor(card.sql);
    // A mid-fetch connection switch yields null; leave the prior annotation rather
    // than blanking a card whose columns simply could not be resolved this time.
    if (schema === undefined) {
      return;
    }
    card.schema = schema;
    this.renderCardSchema(card);
  }

  // The tables and sensitive columns a query touches. Returns null when the SQL will
  // not parse, or undefined when a connection switch invalidated the column fetch
  // mid-flight. Host-side only: nothing here ever reaches the broker.
  private async schemaFor(sql: string): Promise<SchemaContext | null | undefined> {
    const parsed = analyzeSql(sql, this.dialect);
    if (!parsed) {
      return null;
    }
    const gen = this.connGeneration;
    const fallback = this.conn?.schema ?? undefined;
    const perTable = await Promise.all(
      parsed.tables.map((t) => this.columnsFor(t.name, t.schema ?? fallback)),
    );
    if (gen !== this.connGeneration) {
      return undefined;
    }
    const allColumns = perTable.flat().map((c) => c.name);
    return {
      tables: parsed.tables.map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name)),
      pii: piiColumns(parsed, allColumns),
      client: clientColumns(parsed, allColumns),
      literals: sensitiveLiterals(sql, this.dialect),
      star: parsed.star,
    };
  }

  private async columnsFor(table: string, schema: string | undefined): Promise<Column[]> {
    const key = `${schema ?? ""}.${table}`;
    const cached = this.schemaCache.get(key);
    if (cached) {
      return cached;
    }
    try {
      const columns = await getColumns(table, schema);
      this.schemaCache.set(key, columns);
      return columns;
    } catch {
      // Unknown table (e.g. a CTE name) or a transient host error: no annotation.
      return [];
    }
  }

  private async renew(): Promise<void> {
    for (const card of [...this.cards]) {
      // Renew while a human deliberates (ready) and while the approved query
      // runs (executing). An unrenewed executing card would expire mid-query
      // and be failed as execution_unknown even though it actually succeeded.
      if (card.state !== "ready" && card.state !== "executing") {
        continue;
      }
      try {
        const res = await this.broker("/lease/renew", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: card.id, leaseId: card.leaseId }),
        });
        if (res.ok) {
          card.leaseExpiresAt = ((await res.json()) as { leaseExpiresAt: number }).leaseExpiresAt;
        } else {
          this.drop(card.id);
        }
      } catch {
        // Transient broker error; keep the card and retry next cycle.
      }
    }
  }

  private tick(): void {
    this.maybeCheckConnection();
    for (const card of [...this.cards]) {
      if (card.state === "ready" && card.expiresAt - Date.now() <= 0) {
        this.finish(card.id, "no", "expired");
        continue;
      }
      const leaseEl = this.root.querySelector<HTMLSpanElement>(`[data-card="${card.id}"] .lease`);
      if (leaseEl && card.state === "ready") {
        const remaining = card.expiresAt - Date.now();
        leaseEl.className = remaining <= 45_000 ? "lease low" : "lease";
        leaseEl.textContent = clock(remaining);
      }
    }
    // Keep the resolved-history and roster ages current without re-rendering.
    this.root.querySelectorAll<HTMLSpanElement>("#hist .hage, #roster .rage").forEach((el) => {
      const t = Number(el.dataset.age);
      if (!Number.isNaN(t)) {
        el.textContent = relAge(t);
      }
    });
  }

  private renderQueue(): void {
    const count = this.root.querySelector<HTMLSpanElement>("#count");
    if (count) {
      const n = this.cards.length;
      count.classList.toggle("busy", n > 0);
      count.textContent = n > 0 ? `${n} pending` : "idle";
    }
    const queue = this.root.querySelector<HTMLDivElement>("#queue");
    if (queue) {
      // A concurrent proposal rebuilds the whole queue; carry any open deny form's
      // typed text and focus across the rebuild so a half-composed reason survives.
      let focusedDeny: string | null = null;
      for (const input of queue.querySelectorAll<HTMLInputElement>(".deny-reason")) {
        const id = input.getAttribute("data-deny-input");
        if (id) {
          this.denyDrafts.set(id, input.value);
          if (input === document.activeElement) {
            focusedDeny = id;
          }
        }
      }
      this.breatheLoop?.stop();
      this.breatheLoop = undefined;
      queue.innerHTML = this.queueHtml();
      if (focusedDeny) {
        const input = queue.querySelector<HTMLInputElement>(`[data-deny-input="${focusedDeny}"]`);
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      }
      const waitingMark = queue.querySelector(".waiting-mark");
      if (waitingMark) {
        this.breatheLoop = pulse(waitingMark);
      } else {
        for (const card of queue.querySelectorAll<HTMLElement>(".card")) {
          if (card.dataset.card && !this.prevCardIds.has(card.dataset.card)) {
            enter(card);
          }
        }
      }
      this.prevCardIds = new Set(
        [...queue.querySelectorAll<HTMLElement>(".card")]
          .map((c) => c.dataset.card ?? "")
          .filter(Boolean),
      );
    }
    this.updateTabTitle();
  }

  private queueHtml(): string {
    if (!this.cards.length) {
      return `<div class="waiting"><svg class="waiting-mark" viewBox="0 0 24 26" fill="none" aria-hidden="true"><polygon points="12,1.4 22,7 22,19 12,24.6 2,19 2,7" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><polygon points="12,7.4 16.8,10.2 16.8,15.8 12,18.6 7.2,15.8 7.2,10.2" fill="currentColor" fill-opacity="0.85"/></svg><span>Waiting for a query proposal...</span></div>`;
    }
    // Group by session, keeping the arrival order of both groups and cards.
    // Always render the session header, even for a single session, so the human
    // can see which agent is asking.
    const groups: { session: SessionMeta | null; cards: Card[] }[] = [];
    for (const card of this.cards) {
      let group = groups.find((g) => g.cards[0]?.sessionId === card.sessionId);
      if (!group) {
        group = { session: card.session, cards: [] };
        groups.push(group);
      }
      group.cards.push(card);
    }
    return groups.map((g) => this.groupHtml(g.session, g.cards)).join("");
  }

  private groupHtml(session: SessionMeta | null, cards: Card[]): string {
    const project = session?.project?.trim();
    const harness = session?.harness?.trim() || null;
    const label = project
      ? escapeHtml(project)
      : harness
        ? escapeHtml(harness)
        : escapeHtml(cards[0].sessionId ?? "session");
    const intent = session?.sessionLabel?.trim();
    return `
      <section class="group">
        <div class="group-head">
          <span class="harness-badge">${harnessIcon(harness)}</span>
          <span class="group-label">${label}</span>
          ${intent ? `<span class="group-intent" title="${escapeHtml(capitalize(intent))}">${escapeHtml(capitalize(intent))}</span>` : ""}
          <span class="group-count">${cards.length}</span>
        </div>
        ${cards.map((c) => this.cardHtml(c)).join("")}
      </section>`;
  }

  // Surface the count of queries awaiting a decision in the Beekeeper tab so it
  // reads from the tab strip; only touch the host when the count changes.
  private updateTabTitle(): void {
    const pending = this.cards.filter((c) => c.state === "ready").length;
    const title = pending > 0 ? `Gatekeeper · ${pending}` : "Gatekeeper";
    if (title === this.lastTitle) {
      return;
    }
    this.lastTitle = title;
    void setTabTitle(title);
  }

  private cardHtml(card: Card): string {
    const readOnly = isReadOnlyQuery(card.sql, this.dialect);
    const remaining = card.expiresAt - Date.now();
    let actions: string;
    if (card.state !== "ready") {
      actions = `<div class="actions"><span class="busy"><span class="spin"></span>${this.busyLabel(card.state)}...</span></div>`;
    } else {
      actions = this.readyActions(card.id, readOnly);
    }
    const blockedNote = readOnly
      ? ""
      : '<p class="blocked-note"><svg viewBox="0 0 16 16" fill="none"><path d="M8 1.7 1 14h14L8 1.7Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.3v3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".8" fill="currentColor"/></svg>Read-only only. This query can be rejected.</p>';
    return `
      <div class="card ${readOnly ? "" : "blocked"}" data-card="${card.id}">
        <div class="top">
          ${card.intent ? `<span class="intent">${escapeHtml(capitalize(card.intent))}</span>` : `<span class="intent">${escapeHtml(card.id)}</span>`}
          <span class="${remaining <= 45_000 ? "lease low" : "lease"}">${clock(remaining)}</span>
        </div>
        <div class="meta">${escapeHtml(card.id)} &middot; ${relAge(card.createdAt)}</div>
        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(card.sql)}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="sqlbody-${card.id}">${highlight(formatSql(card.sql), card.schema?.pii, card.schema?.client, card.schema?.literals)}</code></pre>
        <div class="card-schema" id="cs-${card.id}">${this.schemaInner(card.schema)}</div>
        ${blockedNote}${actions}
      </div>`;
  }

  private readyActions(id: string, readOnly: boolean): string {
    const revise = this.denyDrafts.has(id)
      ? this.denyField(id, this.denyDrafts.get(id) ?? "")
      : `<button class="deny-open" type="button" data-deny-open="${id}" aria-label="Reject and ask the agent to change something" title="Ask the agent to change something">${pencilIcon}</button>`;
    return `<div class="actions">
             <button class="btn approve" type="button" data-approve="${id}" ${readOnly ? "" : "disabled"}>Approve</button>
             <button class="btn reject" type="button" data-reject="${id}">Reject</button>
             ${revise}
           </div>`;
  }

  // Reject-with-a-revision: an inline field, right of Reject, whose note is the
  // change the human wants; sent to the agent on Enter or the send affordance.
  private denyField(id: string, value = ""): string {
    return `<div class="deny-field">
             <input class="deny-reason" type="text" maxlength="140" data-deny-input="${id}" aria-label="What should the agent change?" placeholder="What should the agent change?" autocomplete="off" spellcheck="false" value="${escapeHtml(value)}" />
             <button class="deny-send" type="button" data-deny="${id}" aria-label="Send to the agent">${sendIcon}</button>
           </div>`;
  }

  // Compact under-SQL annotation: the tables read and a possible-PII flag. Empty
  // (collapsed by CSS) until the async analysis lands or when nothing is known.
  private schemaInner(schema: SchemaContext | null | undefined): string {
    if (!schema?.tables.length) {
      return "";
    }
    const tables = `<div class="cs-line"><span class="cs-k">reads</span><span class="cs-list">${schema.tables.map(escapeHtml).join(" &middot; ")}</span></div>`;
    const pii = schema.pii.length
      ? `<div class="cs-line cs-pii"><span class="cs-warn">${warnIcon}possible PII</span><span class="cs-list">${schema.pii.map(escapeHtml).join(" &middot; ")}</span></div>`
      : "";
    const client = schema.client.length
      ? `<div class="cs-line cs-client"><span class="cs-warn">${buildingIcon}client data</span><span class="cs-list">${schema.client.map(escapeHtml).join(" &middot; ")}</span></div>`
      : "";
    const literal = schema.literals.length
      ? `<div class="cs-line cs-literal"><span class="cs-warn">${warnIcon}sensitive value</span><span class="cs-list">${schema.literals.map((v) => escapeHtml(`'${v}'`)).join(" &middot; ")}</span></div>`
      : "";
    return tables + pii + client + literal;
  }

  private renderCardSchema(card: Card): void {
    const el = this.root.querySelector<HTMLElement>(`#cs-${CSS.escape(card.id)}`);
    if (el) {
      el.innerHTML = this.schemaInner(card.schema);
    }
    // Re-highlight the SQL now that the sensitive columns are known, so they light
    // up in the query text too, not only in the flags below.
    const body = this.root.querySelector<HTMLElement>(`#sqlbody-${CSS.escape(card.id)}`);
    if (body) {
      body.innerHTML = highlight(
        formatSql(card.sql),
        card.schema?.pii,
        card.schema?.client,
        card.schema?.literals,
      );
    }
  }

  private busyLabel(state: CardState): string {
    if (state === "approving") return "approving";
    if (state === "executing") return "running on connection";
    if (state === "posting") return "returning rows";
    return "rejecting";
  }

  private setCardState(id: string, state: CardState): void {
    const card = this.cards.find((c) => c.id === id);
    if (card) {
      card.state = state;
      this.renderQueue();
    }
  }

  private async approve(id: string): Promise<void> {
    // Catch a switch since the last throttled poll before touching the database.
    await this.checkConnection();
    const card = this.cards.find((c) => c.id === id);
    if (card?.state !== "ready") {
      return;
    }
    const gen = this.connGeneration;
    if (!isReadOnlyQuery(card.sql, this.dialect)) {
      await this.postResult(card, {
        status: "rejected",
        reason: "Blocked: not a read-only SELECT.",
      });
      this.finish(id, "no", "blocked");
      return;
    }
    this.setCardState(id, "executing");
    // If the broker refuses the executing transition (the request was cancelled,
    // or the lease was lost), do not run the query: its result could never be
    // delivered, and the human approval no longer maps to a live proposal.
    if (!(await this.postExecuting(card))) {
      this.finish(id, "no", "lease lost");
      return;
    }
    if (gen !== this.connGeneration) {
      return;
    }
    try {
      const { rows, fields } = await runApprovedQuery(card.sql);
      // The query may have hit the new database after a switch; never deliver its
      // rows against the old proposal.
      if (gen !== this.connGeneration) {
        return;
      }
      this.setCardState(id, "posting");
      await this.postResult(card, { status: "approved", rows, fields });
      this.finish(id, "ok", `${rows.length} rows`, capResult(rows, fields));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.postResult(card, { status: "approved", error: message });
      this.finish(id, "no", "query failed", undefined, message);
    }
  }

  private async reject(id: string, reason?: string): Promise<void> {
    const card = this.cards.find((c) => c.id === id);
    if (card?.state !== "ready") {
      return;
    }
    // The deny-with-reason form passes the human note here; it goes to the agent
    // and is reflected back into the history row. Empty falls back to the defaults.
    const custom = reason?.trim();
    this.setCardState(id, "rejecting");
    await this.postResult(card, { status: "rejected", reason: custom || "Rejected by user." });
    this.finish(id, "no", "declined", undefined, custom || undefined);
  }

  // Swap only this card's action row in place (no renderQueue) so the lease
  // countdown, copy button, and schema annotation survive the reveal.
  private openDeny(id: string): void {
    const card = this.cards.find((c) => c.id === id);
    // Guard the draft too: a form already open must not re-open into a nested one.
    if (card?.state !== "ready" || this.denyDrafts.has(id)) {
      return;
    }
    this.denyDrafts.set(id, "");
    const actions = this.root.querySelector<HTMLElement>(`[data-card="${id}"] .actions`);
    if (!actions) {
      return;
    }
    actions.outerHTML = this.readyActions(id, isReadOnlyQuery(card.sql, this.dialect));
    this.root.querySelector<HTMLInputElement>(`[data-card="${id}"] .deny-reason`)?.focus();
  }

  private confirmDeny(id: string): void {
    const reason = this.root
      .querySelector<HTMLInputElement>(`[data-card="${id}"] .deny-reason`)
      ?.value.trim();
    this.denyDrafts.delete(id);
    // Empty note keeps reject()'s "Rejected by user." fallback; never send "".
    void this.reject(id, reason || undefined);
  }

  private closeDeny(id: string): void {
    const card = this.cards.find((c) => c.id === id);
    const actions = this.root.querySelector<HTMLElement>(`[data-card="${id}"] .actions`);
    this.denyDrafts.delete(id);
    if (!card || !actions) {
      return;
    }
    actions.outerHTML = this.readyActions(id, isReadOnlyQuery(card.sql, this.dialect));
    this.root.querySelector<HTMLButtonElement>(`[data-card="${id}"] .deny-open`)?.focus();
  }

  private async postExecuting(card: Card): Promise<boolean> {
    try {
      const res = await this.broker("/executing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: card.id, leaseId: card.leaseId }),
      });
      return res.ok;
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
      return false;
    }
  }

  private async postResult(card: Card, body: Record<string, unknown>): Promise<void> {
    try {
      await this.broker("/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: card.id, leaseId: card.leaseId, ...body }),
      });
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }

  private drop(id: string): void {
    this.denyDrafts.delete(id);
    const index = this.cards.findIndex((c) => c.id === id);
    if (index !== -1) {
      this.cards.splice(index, 1);
      this.renderQueue();
    }
  }

  private finish(
    id: string,
    status: "ok" | "no",
    note: string,
    result?: HistResult,
    reason?: string,
  ): void {
    const card = this.cards.find((c) => c.id === id);
    if (!card) {
      return;
    }
    const el = this.root.querySelector<HTMLElement>(`[data-card="${id}"]`);
    // A custom reason replaces the terse default label; the row and detail
    // overlay both read HistItem.note, so nothing here is hardcoded.
    const displayNote = reason?.trim() || note;
    const commit = () => {
      this.drop(id);
      this.history.unshift({
        id,
        status,
        note: displayNote,
        sql: card.sql,
        resolvedAt: Date.now(),
        connection: this.connectionName || null,
        session: card.session,
        intent: card.intent,
        result,
      });
      if (this.history.length > HIST_MAX) {
        this.history.pop();
      }
      this.enforceHistoryBudget();
      this.renderHistory();
    };
    if (el && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("leaving");
      window.setTimeout(commit, 200);
    } else {
      commit();
    }
  }

  // Retain the newest results within the total byte budget; older items keep
  // their row and SQL but shed their rows so memory stays bounded.
  private enforceHistoryBudget(): void {
    let total = 0;
    for (const item of this.history) {
      if (!item.result || item.result.rows.length === 0) {
        continue;
      }
      const size = JSON.stringify(item.result.rows).length;
      if (total + size > HIST_MAX_TOTAL_BYTES) {
        item.result = { ...item.result, rows: [], truncated: true };
      } else {
        total += size;
      }
    }
  }

  private renderHistory(): void {
    const hist = this.root.querySelector<HTMLDivElement>("#hist");
    if (!hist) {
      return;
    }
    // Defense in depth: a switch already clears history, but never render a row
    // stamped under a different connection than the one on screen now.
    const current = this.connectionName || null;
    hist.innerHTML = this.history
      .filter((h) => h.connection === current)
      .map((h) => {
        const harness = h.session?.harness?.trim() || null;
        const who = sessionDisplayName(h.session, h.id);
        return `
        <button class="hrow" type="button" data-hist="${escapeHtml(h.id)}"${h.intent ? "" : " data-no-intent"} title="${escapeHtml(h.id)}">
          <span class="harness-badge">${harnessIcon(harness)}</span>
          <span class="hwho" title="${escapeHtml(who)}">${escapeHtml(who)}</span>
          <span class="hstatus ${h.status}">${h.status === "ok" ? "approved" : "rejected"}</span>
          <span class="hintent">${escapeHtml(h.intent ? capitalize(h.intent) : previewSql(h.sql))}</span>
          <span class="hsql">${highlight(previewSql(h.sql))}</span>
          <span class="htime">
            <span class="hnote">${escapeHtml(h.note)}</span>
            <span aria-hidden="true">&middot;</span>
            <span class="hage" data-age="${h.resolvedAt}">${relAge(h.resolvedAt)}</span>
          </span>
        </button>`;
      })
      .join("");
  }

  private openDetail(item: HistItem): void {
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (!panel) {
      return;
    }
    this.detailItemId = item.id;
    panel.innerHTML = this.detailHtml(item);
    panel.hidden = false;
    void this.annotateDetail(item);
  }

  // Match the pending card: once the schema resolves, show the same reads/PII/client
  // annotation under the detail SQL and light the sensitive columns in the query text.
  private async annotateDetail(item: HistItem): Promise<void> {
    const schema = (await this.schemaFor(item.sql)) ?? null;
    if (this.detailItemId !== item.id) {
      return;
    }
    const cs = this.root.querySelector<HTMLElement>("#detail-cs");
    if (cs) {
      cs.innerHTML = this.schemaInner(schema);
    }
    const body = this.root.querySelector<HTMLElement>("#detail-sqlbody");
    if (body) {
      body.innerHTML = highlight(
        formatSql(item.sql),
        schema?.pii,
        schema?.client,
        schema?.literals,
      );
    }
  }

  private closeDetail(): void {
    this.detailItemId = null;
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }

  // The connection-scoped activity view: a durable, PII-safe audit of what ran on
  // this connection. It reuses the .detail overlay and is refreshed on every open.
  private async openActivity(): Promise<void> {
    const panel = this.root.querySelector<HTMLDivElement>("#activity");
    if (!panel) {
      return;
    }
    // A fresh open forgets which rows were expanded last time.
    this.activityExpanded.clear();
    panel.innerHTML = this.activityShell('<p class="act-status">Loading activity...</p>');
    panel.hidden = false;
    await this.loadActivity();
  }

  private closeActivity(): void {
    const panel = this.root.querySelector<HTMLDivElement>("#activity");
    if (panel && !panel.hidden) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }

  private async loadActivity(): Promise<void> {
    const panel = this.root.querySelector<HTMLDivElement>("#activity");
    if (!panel || panel.hidden) {
      return;
    }
    try {
      const res = await this.broker("/activity", {
        headers: this.conn?.connectionName
          ? { "X-Gatekeeper-Connection": this.conn.connectionName }
          : {},
      });
      if (res.status !== 200) {
        this.setActivityBody('<p class="act-status">Could not load activity.</p>');
        return;
      }
      this.activity = ((await res.json()) as { activity: ActivityEntry[] }).activity;
      this.renderActivity();
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
      this.setActivityBody('<p class="act-status">Broker unreachable.</p>');
    }
  }

  private activityShell(body: string): string {
    const conn = this.connectionName ? escapeHtml(this.connectionName) : "";
    return `
      <div class="detail-card activity-card">
        <div class="detail-head">
          <span class="detail-who">Activity</span>
          ${conn ? `<span class="act-conn">${conn}</span>` : ""}
          <button class="detail-close" type="button" data-close aria-label="Close activity">&times;</button>
        </div>
        <div class="act-body">${body}</div>
      </div>`;
  }

  private setActivityBody(html: string): void {
    const body = this.root.querySelector<HTMLElement>("#activity .act-body");
    if (body) {
      body.innerHTML = html;
    }
  }

  private renderActivity(): void {
    this.setActivityBody(
      this.activity.length
        ? this.activityDaysHtml()
        : '<p class="act-status">No activity on this connection yet.</p>',
    );
  }

  // Group the feed by day, then by session within each day, preserving the
  // server's newest-first order for both the groups and the entries inside them.
  private activityDaysHtml(): string {
    const days: { key: string; label: string; sessions: Map<string, ActivityEntry[]> }[] = [];
    for (const e of this.activity) {
      const ts = e.decidedAt ?? e.createdAt;
      const key = dayKey(ts);
      let day = days.find((d) => d.key === key);
      if (!day) {
        day = { key, label: dayLabel(ts), sessions: new Map() };
        days.push(day);
      }
      const arr = day.sessions.get(e.sessionId);
      if (arr) {
        arr.push(e);
      } else {
        day.sessions.set(e.sessionId, [e]);
      }
    }
    return days
      .map(
        (d) => `
        <section class="act-day">
          <div class="act-day-head">${escapeHtml(d.label)}</div>
          ${[...d.sessions.entries()].map(([sid, entries]) => this.activityGroupHtml(d.key, sid, entries)).join("")}
        </section>`,
      )
      .join("");
  }

  private activityGroupHtml(day: string, sessionId: string, entries: ActivityEntry[]): string {
    const first = entries[0];
    const harness = first.harness?.trim() || null;
    const project = first.project?.trim();
    const label = project ? escapeHtml(project) : escapeHtml(harness || sessionId);
    const intent = first.sessionLabel?.trim();
    return `
        <section class="act-group">
          <div class="act-group-head">
            <span class="harness-badge">${harnessIcon(harness)}</span>
            <span class="act-group-label">${label}</span>
            ${intent ? `<span class="act-group-intent" title="${escapeHtml(capitalize(intent))}">${escapeHtml(capitalize(intent))}</span>` : ""}
            <span class="act-group-sess">${escapeHtml(sessionId)}</span>
            <button class="act-export" type="button" data-export="${escapeHtml(`${day}|${sessionId}`)}">${downloadIcon}Export</button>
          </div>
          <div class="act-entries">${entries.map((e) => this.activityEntryHtml(e)).join("")}</div>
        </section>`;
  }

  private activityEntryHtml(e: ActivityEntry): string {
    const ts = e.decidedAt ?? e.createdAt;
    const { cls, label } = outcomeMeta(e.state);
    const note = activityNote(e);
    const intent = e.intent?.trim();
    const headline = intent ? capitalize(intent) : previewSql(e.sql);
    const expanded = this.activityExpanded.has(e.id);
    // The row note truncates; the full reason/error rides the expanded panel.
    const detailNote =
      e.state === "rejected" && e.reason
        ? e.reason
        : e.state === "failed" && e.error
          ? e.error
          : "";
    return `
          <div class="act-entry${expanded ? " open" : ""}" data-act="${escapeHtml(e.id)}">
            <button class="act-row" type="button" data-act-sql="${escapeHtml(e.id)}" aria-expanded="${expanded}">
              <span class="chev">${chevronDown}</span>
              <span class="act-time">${escapeHtml(clockTime(ts))}</span>
              <span class="hstatus ${cls}">${escapeHtml(label)}</span>
              <span class="act-intent">${escapeHtml(headline)}</span>
              ${note ? `<span class="act-note">${escapeHtml(note)}</span>` : ""}
            </button>
            <div class="act-detail"${expanded ? "" : " hidden"}>
              <div class="act-meta">${escapeHtml(e.id)} &middot; ${escapeHtml(new Date(ts).toLocaleString())}</div>
              ${detailNote ? `<div class="detail-outcome">${escapeHtml(detailNote)}</div>` : ""}
              <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(e.sql)}" aria-label="Copy SQL">${copyIcon}</button><code>${highlight(formatSql(e.sql))}</code></pre>
            </div>
          </div>`;
  }

  // Toggle a single entry's full SQL in place so expanding one row never rebuilds
  // the list or loses the scroll position.
  private toggleActivitySql(id: string): void {
    const open = this.activityExpanded.has(id);
    if (open) {
      this.activityExpanded.delete(id);
    } else {
      this.activityExpanded.add(id);
    }
    const entry = this.root.querySelector<HTMLElement>(`#activity [data-act="${CSS.escape(id)}"]`);
    if (!entry) {
      return;
    }
    entry.classList.toggle("open", !open);
    const detail = entry.querySelector<HTMLElement>(".act-detail");
    if (detail) {
      detail.hidden = open;
    }
    entry
      .querySelector<HTMLElement>("[data-act-sql]")
      ?.setAttribute("aria-expanded", String(!open));
  }

  // Deliberate human export: write one session-day's timeline as markdown via the
  // host's save dialog. The SQL is host-side only and no result rows are included;
  // an approved query contributes just its scalar row count.
  private async exportSession(key: string): Promise<void> {
    const sep = key.indexOf("|");
    if (sep === -1) {
      return;
    }
    const day = key.slice(0, sep);
    const sessionId = key.slice(sep + 1);
    const entries = this.activity.filter(
      (e) => e.sessionId === sessionId && dayKey(e.decidedAt ?? e.createdAt) === day,
    );
    if (!entries.length) {
      return;
    }
    const first = entries[0];
    const who = (first.project?.trim() || first.harness?.trim() || sessionId).toLowerCase();
    const slug = who.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "session";
    try {
      await requestFileSave({
        data: this.activityMarkdown(day, sessionId, entries),
        fileName: `gatekeeper-activity-${day}-${slug}.md`,
        encoding: "utf8",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }

  private activityMarkdown(day: string, sessionId: string, entries: ActivityEntry[]): string {
    const first = entries[0];
    const label = first.project?.trim() || first.harness?.trim() || sessionId;
    const lines: string[] = ["# Gatekeeper activity", ""];
    if (this.connectionName) {
      lines.push(`- Connection: ${this.connectionName}`);
    }
    lines.push(`- Day: ${day}`, `- Session: ${label} (${sessionId})`);
    if (first.harness?.trim()) {
      lines.push(`- Harness: ${first.harness.trim()}`);
    }
    if (first.sessionLabel?.trim()) {
      lines.push(`- Task: ${first.sessionLabel.trim()}`);
    }
    lines.push("");
    // Oldest-first reads as a timeline.
    for (const e of [...entries].reverse()) {
      const ts = e.decidedAt ?? e.createdAt;
      lines.push(`## ${new Date(ts).toLocaleTimeString()} · ${outcomeMeta(e.state).label}`);
      if (e.intent?.trim()) {
        lines.push(`- Intent: ${e.intent.trim()}`);
      }
      lines.push(`- Request: ${e.id}`);
      if (e.state === "approved" && e.rowCount != null) {
        lines.push(`- Rows: ${e.rowCount}`);
      }
      if (e.reason?.trim()) {
        lines.push(`- Reason: ${e.reason.trim()}`);
      }
      if (e.error?.trim()) {
        lines.push(`- Error: ${e.error.trim()}`);
      }
      lines.push("", "```sql", e.sql.trim(), "```", "");
    }
    return lines.join("\n");
  }

  private copySql(el: HTMLElement): void {
    const sql = el.dataset.copySql;
    if (!sql) {
      return;
    }
    void clipboard.writeText(sql);
    el.classList.add("copied");
    el.innerHTML = checkIcon;
    window.setTimeout(() => {
      el.classList.remove("copied");
      el.innerHTML = copyIcon;
    }, 1200);
  }

  private detailHtml(item: HistItem): string {
    const grid = item.result ? this.gridHtml(item.result) : "";
    const harness = item.session?.harness?.trim() || null;
    const who = sessionDisplayName(item.session, item.id);
    const audit = [
      item.connection ? `on ${escapeHtml(item.connection)}` : "",
      harness ? escapeHtml(harness) : "",
      item.session?.sessionId ? escapeHtml(item.session.sessionId) : "",
      escapeHtml(item.id),
      escapeHtml(new Date(item.resolvedAt).toLocaleString()),
    ].filter(Boolean);
    return `
      <div class="detail-card">
        <div class="detail-head">
          <span class="harness-badge">${harnessIcon(harness)}</span>
          <span class="detail-who">${escapeHtml(who)}</span>
          <span class="hstatus ${item.status}">${item.status === "ok" ? "approved" : "rejected"}</span>
          ${item.session?.sessionLabel ? `<span class="detail-scope" title="${escapeHtml(capitalize(item.session.sessionLabel))}">${escapeHtml(capitalize(item.session.sessionLabel))}</span>` : ""}
          <button class="detail-close" type="button" data-close aria-label="Close detail">&times;</button>
        </div>
        <div class="detail-meta">${audit.join(" &middot; ")}</div>
        ${item.intent ? `<p class="detail-intent">${escapeHtml(capitalize(item.intent))}</p>` : ""}
        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(item.sql)}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="detail-sqlbody">${highlight(formatSql(item.sql))}</code></pre>
        <div class="card-schema" id="detail-cs"></div>
        ${item.note ? `<div class="detail-outcome">${escapeHtml(item.note)}</div>` : ""}
        ${grid}
      </div>`;
  }

  private gridHtml(result: HistResult): string {
    if (result.rowCount === 0) {
      return '<p class="detail-empty">No rows returned.</p>';
    }
    if (result.rows.length === 0) {
      return `<p class="detail-empty">${result.rowCount} rows returned, no longer held in memory.</p>`;
    }
    const cols = result.fields.length
      ? result.fields.map((f) => f.name)
      : Object.keys(result.rows[0]);
    const head = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    const body = result.rows
      .map((row) => `<tr>${cols.map((c) => `<td>${escapeHtml(cell(row[c]))}</td>`).join("")}</tr>`)
      .join("");
    const note = result.truncated
      ? `<p class="detail-note">Showing ${result.rows.length} of ${result.rowCount} rows.</p>`
      : "";
    return `<div class="grid-wrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${note}`;
  }
}

function applyTheme(cssString: string): void {
  const el = document.getElementById("app-theme");
  if (el) {
    el.textContent = `:root { ${cssString} }`;
  }
}

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    return;
  }
  const app = new Gatekeeper(root);
  void app.start();
  try {
    const appInfo = await getAppInfo();
    applyTheme(appInfo.theme.cssString);
    addNotificationListener("themeChanged", (theme) => applyTheme(theme.cssString));
  } catch (err) {
    log.error(err instanceof Error ? err : String(err));
  }
}

void bootstrap();
