import "./style.css";
import type { RunQueryResult } from "@beekeeperstudio/plugin";
import {
  addNotificationListener,
  appStorage,
  getAppInfo,
  getConnectionInfo,
  log,
  runQuery,
  setTabTitle,
} from "@beekeeperstudio/plugin";
import { Parser } from "node-sql-parser";

const BROKER_URL = "http://localhost:9999";
const POLL_MS = 1000;
const RENEW_MS = 15_000;
const TICK_MS = 1000;
const TOKEN_KEY = "gatekeeper.token";
const HIST_MAX = 20;
// Results are held in the iframe only to power the detail view, so bound them:
// per item by rows and serialized bytes, and across all items by total bytes.
const HIST_MAX_ROWS = 200;
const HIST_MAX_ITEM_BYTES = 512 * 1024;
const HIST_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

type CardState = "ready" | "approving" | "executing" | "posting" | "rejecting";

interface Proposal {
  id: string;
  sql: string;
  intent?: string;
  createdAt: number;
  expiresAt: number;
  leaseId: string;
  leaseExpiresAt: number;
}

interface Card extends Proposal {
  state: CardState;
}

interface Field {
  name: string;
}

interface HistResult {
  fields: Field[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

interface HistItem {
  id: string;
  status: "ok" | "no";
  note: string;
  sql: string;
  time: string;
  result?: HistResult;
}

const parser = new Parser();
const FORBIDDEN =
  /"type"\s*:\s*"(delete|update|insert|replace|create|drop|alter|truncate|call|use|grant|revoke|set|lock)"/i;

function mapDialect(databaseType: string): string {
  switch (databaseType) {
    case "sqlserver":
      return "transactsql";
    case "mariadb":
    case "mysql":
    case "sqlite":
    case "bigquery":
    case "snowflake":
      return databaseType;
    default:
      return "postgresql";
  }
}

function conservativeReadOnly(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  if (stripped.length === 0) {
    return false;
  }
  const single = stripped.replace(/;\s*$/, "");
  if (single.includes(";")) {
    return false;
  }
  return /^(select|with)\b/i.test(single);
}

// The plugin is the only component that can call runQuery, so the read-only rule
// lives here. A dialect-aware parse fails closed: exactly one SELECT with no
// data-modifying node anywhere. Parser gaps fall back to a leading-keyword check.
export function isReadOnlyQuery(sql: string, dialect = "postgresql"): boolean {
  try {
    const ast = parser.astify(sql, { database: dialect });
    const statements = Array.isArray(ast) ? ast : [ast];
    if (statements.length !== 1) {
      return false;
    }
    if ((statements[0] as { type?: string }).type !== "select") {
      return false;
    }
    return !FORBIDDEN.test(JSON.stringify(ast));
  } catch {
    return conservativeReadOnly(sql);
  }
}

async function runApprovedQuery(
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; fields: Field[] }> {
  const result: RunQueryResult = await runQuery(sql);
  const first = result.results[0];
  return {
    rows: first?.rows ?? [],
    fields: (first?.fields ?? []).map((f) => ({ name: f.name })),
  };
}

// Keep at most HIST_MAX_ROWS, then shrink further until the serialized payload
// fits the per-item byte budget; the flag lets the detail view say it truncated.
function capResult(rows: Record<string, unknown>[], fields: Field[]): HistResult {
  const rowCount = rows.length;
  let kept = rows.slice(0, HIST_MAX_ROWS);
  let truncated = rows.length > kept.length;
  while (kept.length > 0 && JSON.stringify(kept).length > HIST_MAX_ITEM_BYTES) {
    kept = kept.slice(0, Math.floor(kept.length / 2));
    truncated = true;
  }
  return { fields, rows: kept, rowCount, truncated };
}

function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
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

function highlight(sql: string): string {
  return escapeHtml(sql)
    .replace(
      /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|LIMIT|AS|AND|OR|JOIN|ON|INTERVAL|DELETE|UPDATE|INSERT|WITH)\b/g,
      '<span class="kw">$1</span>',
    )
    .replace(/\b(count|sum|now|avg|max|min)\b/g, '<span class="fn">$1</span>')
    .replace(/('[^']*')/g, '<span class="st">$1</span>');
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
    <span class="count" id="count" aria-live="polite"></span>
  </header>`;

export class Gatekeeper {
  private token: string | null = null;
  private connectionName = "";
  private readOnly = false;
  private dialect = "postgresql";
  private conn: {
    connectionName: string;
    databaseType: string;
    databaseName: string;
    schema: string | null;
    readOnly: boolean;
  } | null = null;
  private readonly cards: Card[] = [];
  private readonly history: HistItem[] = [];
  private polling = false;
  private lastTitle = "";
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.closeDetail();
      }
    });
  }

  async start(): Promise<void> {
    this.token = await loadToken();
    try {
      const conn = await getConnectionInfo();
      this.connectionName = conn.connectionName || conn.databaseName || "connection";
      this.readOnly = conn.readOnlyMode;
      this.dialect = mapDialect(conn.databaseType);
      this.conn = {
        connectionName: conn.connectionName,
        databaseType: conn.databaseType,
        databaseName: conn.databaseName,
        schema: conn.defaultSchema ?? null,
        readOnly: conn.readOnlyMode,
      };
    } catch {
      // Connection info is best-effort; the queue still works without it.
    }
    if (!this.token) {
      this.renderPairing();
      return;
    }
    this.renderShell();
    this.polling = true;
    void this.poll();
    void this.reportConnection();
    window.setInterval(() => void this.renew(), RENEW_MS);
    window.setInterval(() => this.tick(), TICK_MS);
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
      void this.poll();
      void this.reportConnection();
      window.setInterval(() => void this.renew(), RENEW_MS);
      window.setInterval(() => this.tick(), TICK_MS);
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
        <div class="status" id="status"></div>
        <p class="label">Pending approval</p>
        <div class="queue" id="queue"></div>
        <section class="history">
          <button class="disclosure" id="htoggle" aria-expanded="true"><span class="chev">&#9662;</span> Recently resolved</button>
          <div class="hist" id="hist"></div>
        </section>
        <div class="detail" id="detail" hidden></div>
      </div>`;
    const conn = this.root.querySelector<HTMLSpanElement>("#conn")!;
    conn.innerHTML = `${escapeHtml(this.connectionName)}${this.readOnly ? ' <span class="ro">read-only</span>' : ""}`;
    const toggle = this.root.querySelector<HTMLButtonElement>("#htoggle")!;
    const hist = this.root.querySelector<HTMLDivElement>("#hist")!;
    toggle.addEventListener("click", () => {
      const open = hist.style.display !== "none";
      hist.style.display = open ? "none" : "";
      toggle.setAttribute("aria-expanded", String(!open));
    });
    this.root.querySelector<HTMLDivElement>("#queue")!.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const a = target.closest<HTMLElement>("[data-approve]");
      const r = target.closest<HTMLElement>("[data-reject]");
      if (a) {
        void this.approve(a.getAttribute("data-approve")!);
      } else if (r) {
        void this.reject(r.getAttribute("data-reject")!);
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
      // Close on the backdrop or the close button, not on the card itself.
      if (target === detail || target.closest("[data-close]")) {
        this.closeDetail();
      }
    });
    this.renderQueue();
    this.renderHistory();
  }

  private setStatus(text: string, isError = false): void {
    const el = this.root.querySelector<HTMLDivElement>("#status");
    if (el) {
      el.textContent = text;
      el.classList.toggle("err", isError);
    }
  }

  private async poll(): Promise<void> {
    if (!this.polling) {
      return;
    }
    try {
      const res = await this.broker("/pending");
      if (res.status === 401) {
        this.polling = false;
        this.token = null;
        await clearToken();
        this.renderPairing("Token rejected. Paste the current one.");
        return;
      }
      if (res.status === 200) {
        this.claim((await res.json()) as Proposal);
      }
      this.setStatus("");
    } catch (err) {
      this.setStatus(`Broker unreachable at ${BROKER_URL}. Retrying...`, true);
      log.error(err instanceof Error ? err : String(err));
    }
    window.setTimeout(() => void this.poll(), POLL_MS);
  }

  private claim(proposal: Proposal): void {
    const existing = this.cards.find((c) => c.id === proposal.id);
    if (existing) {
      existing.leaseId = proposal.leaseId;
      existing.leaseExpiresAt = proposal.leaseExpiresAt;
      return;
    }
    this.cards.push({ ...proposal, state: "ready" });
    this.renderQueue();
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
  }

  private renderQueue(): void {
    const count = this.root.querySelector<HTMLSpanElement>("#count");
    if (count) {
      count.innerHTML = this.cards.length ? `<b>${this.cards.length}</b> pending` : "clear";
    }
    const queue = this.root.querySelector<HTMLDivElement>("#queue");
    if (!queue) {
      return;
    }
    queue.innerHTML = this.cards.length
      ? this.cards.map((c) => this.cardHtml(c)).join("")
      : '<div class="empty">Waiting for a query proposal...</div>';
    this.updateTabTitle();
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
    const actions =
      card.state === "ready"
        ? `<div class="actions">
             <button class="btn approve" type="button" data-approve="${card.id}" ${readOnly ? "" : "disabled"}>Approve</button>
             <button class="btn reject" type="button" data-reject="${card.id}">Reject</button>
           </div>`
        : `<div class="actions"><span class="busy"><span class="spin"></span>${this.busyLabel(card.state)}...</span></div>`;
    const blockedNote = readOnly
      ? ""
      : '<p class="blocked-note"><svg viewBox="0 0 16 16" fill="none"><path d="M8 1.7 1 14h14L8 1.7Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.3v3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".8" fill="currentColor"/></svg>Read-only only. This query can be rejected.</p>';
    return `
      <div class="card ${readOnly ? "" : "blocked"}" data-card="${card.id}">
        <div class="top">
          ${card.intent ? `<span class="intent">${escapeHtml(card.intent)}</span>` : `<span class="intent">${escapeHtml(card.id)}</span>`}
          <span class="${remaining <= 45_000 ? "lease low" : "lease"}">${clock(remaining)}</span>
        </div>
        <div class="meta">${escapeHtml(card.id)} &middot; ${relAge(card.createdAt)}</div>
        <pre class="sql">${highlight(card.sql)}</pre>
        ${blockedNote}${actions}
      </div>`;
  }

  private busyLabel(state: CardState): string {
    if (state === "approving") return "Approving";
    if (state === "executing") return "Running on connection";
    if (state === "posting") return "Returning rows";
    return "Rejecting";
  }

  private setCardState(id: string, state: CardState): void {
    const card = this.cards.find((c) => c.id === id);
    if (card) {
      card.state = state;
      this.renderQueue();
    }
  }

  private async approve(id: string): Promise<void> {
    const card = this.cards.find((c) => c.id === id);
    if (card?.state !== "ready") {
      return;
    }
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
    try {
      const { rows, fields } = await runApprovedQuery(card.sql);
      this.setCardState(id, "posting");
      await this.postResult(card, { status: "approved", rows, fields });
      this.finish(id, "ok", `${rows.length} rows`, capResult(rows, fields));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.postResult(card, { status: "approved", error: message });
      this.finish(id, "no", "query failed");
    }
  }

  private async reject(id: string): Promise<void> {
    const card = this.cards.find((c) => c.id === id);
    if (card?.state !== "ready") {
      return;
    }
    this.setCardState(id, "rejecting");
    await this.postResult(card, { status: "rejected", reason: "Rejected by user." });
    this.finish(id, "no", "declined");
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
    const index = this.cards.findIndex((c) => c.id === id);
    if (index !== -1) {
      this.cards.splice(index, 1);
      this.renderQueue();
    }
  }

  private finish(id: string, status: "ok" | "no", note: string, result?: HistResult): void {
    const card = this.cards.find((c) => c.id === id);
    if (!card) {
      return;
    }
    const el = this.root.querySelector<HTMLElement>(`[data-card="${id}"]`);
    const commit = () => {
      this.drop(id);
      this.history.unshift({ id, status, note, sql: card.sql, time: "just now", result });
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
    hist.innerHTML = this.history
      .map(
        (h) => `
        <button class="hrow" type="button" data-hist="${escapeHtml(h.id)}">
          <span class="hid">${escapeHtml(h.id)}</span>
          <span class="hstatus ${h.status}">${h.status === "ok" ? "approved" : "rejected"}</span>
          <span class="hsql">${escapeHtml(h.sql.split("\n")[0])}</span>
          <span class="htime">${escapeHtml(h.note)} &middot; ${h.time}</span>
        </button>`,
      )
      .join("");
  }

  private openDetail(item: HistItem): void {
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (!panel) {
      return;
    }
    panel.innerHTML = this.detailHtml(item);
    panel.hidden = false;
  }

  private closeDetail(): void {
    const panel = this.root.querySelector<HTMLDivElement>("#detail");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }

  private detailHtml(item: HistItem): string {
    const grid = item.result ? this.gridHtml(item.result) : "";
    return `
      <div class="detail-card">
        <div class="detail-head">
          <span class="detail-id">${escapeHtml(item.id)}</span>
          <span class="hstatus ${item.status}">${item.status === "ok" ? "approved" : "rejected"}</span>
          <span class="detail-note">${escapeHtml(item.note)}</span>
          <button class="detail-close" type="button" data-close aria-label="Close detail">&times;</button>
        </div>
        <pre class="sql">${highlight(item.sql)}</pre>
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
