import "./style.css";
import type { ConnectionInfo, RunQueryResult } from "@beekeeperstudio/plugin";
import {
  addNotificationListener,
  appStorage,
  getAppInfo,
  getConnectionInfo,
  log,
  runQuery,
  setTabTitle,
} from "@beekeeperstudio/plugin";
import { enter, type Loop, pulse, reveal } from "./anim";
import { chevronDown, harnessIcon } from "./icons";
import { isReadOnlyQuery, mapDialect } from "./readonly";
import { capResult, cell, type Field, type HistResult } from "./result";

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
  sessionIntent: string | null;
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
}

interface HistItem {
  id: string;
  status: "ok" | "no";
  note: string;
  sql: string;
  resolvedAt: number;
  connection: string | null;
  session: SessionMeta | null;
  result?: HistResult;
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

const HIST_SQL_PREVIEW_CHARS = 140;

// Truncate the raw SQL before highlight()/escapeHtml() run, so highlight() only
// ever wraps complete substrings; slicing already-highlighted HTML could cut a tag.
function previewSql(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > HIST_SQL_PREVIEW_CHARS
    ? `${flat.slice(0, HIST_SQL_PREVIEW_CHARS)}...`
    : flat;
}

function sessionLabel(session: SessionMeta | null, fallback: string): string {
  const project = session?.project?.trim();
  if (project) {
    return project;
  }
  const harness = session?.harness?.trim();
  return harness || session?.sessionId || fallback;
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
  private pollFailures = 0;
  private pollGeneration = 0;
  private connectionState: ConnectionState = "connecting";
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
    this.polling = true;
    void this.poll();
    void this.pollRoster(++this.pollGeneration);
    void this.reportConnection();
    this.startTimers();
  }

  // Derive our cached connection fields from a fresh snapshot. Shared by start()
  // and the connection-switch path so the two can never drift apart.
  private applyConnection(conn: ConnectionInfo): void {
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
    // History and roster are connection-scoped; reset so the old one cannot leak
    // in. The roster re-fetches on its own timer.
    this.history.length = 0;
    this.roster = [];
    this.rosterSig = "";
    this.renderConnLabel();
    void this.reportConnection();
    this.renderQueue();
    this.renderHistory();
    this.renderRoster();
  }

  private renderConnLabel(): void {
    const conn = this.root.querySelector<HTMLSpanElement>("#conn");
    if (conn) {
      conn.innerHTML = `${escapeHtml(this.connectionName)}${this.readOnly ? ' <span class="ro">read-only</span>' : ""}`;
    }
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
        <section class="roster" id="roster"></section>
        <p class="label">Pending approval</p>
        <div class="queue" id="queue"></div>
        <section class="history">
          <button class="disclosure" id="htoggle" aria-expanded="true"><span class="chev">${chevronDown}</span>Recently resolved</button>
          <div class="hist" id="hist"></div>
        </section>
        <div class="detail" id="detail" hidden></div>
      </div>`;
    this.renderConnLabel();
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
    window.setTimeout(() => void this.poll(), POLL_MS);
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
      rows.map((r) => [r.s.sessionId, r.p, r.s.pendingCount, r.s.sessionIntent, r.s.lastIntent]),
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
    const label = project
      ? `${escapeHtml(project)}${harness ? ` <span class="group-harness">${escapeHtml(harness)}</span>` : ""}`
      : escapeHtml(harness || s.sessionId);
    const intent = s.sessionIntent?.trim() || s.lastIntent?.trim();
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
        <span class="roster-label">${label}</span>
        <span class="roster-intent"${intent ? ` title="${escapeHtml(intent)}"` : ""}>${intent ? escapeHtml(intent) : ""}</span>
        <span class="roster-meta">${meta}</span>
      </div>`;
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
      this.breatheLoop?.stop();
      this.breatheLoop = undefined;
      queue.innerHTML = this.queueHtml();
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
      ? `${escapeHtml(project)}${harness ? ` <span class="group-harness">${escapeHtml(harness)}</span>` : ""}`
      : harness
        ? escapeHtml(harness)
        : escapeHtml(cards[0].sessionId ?? "session");
    return `
      <section class="group">
        <div class="group-head">
          <span class="harness-badge">${harnessIcon(harness)}</span>
          <span class="group-label">${label}</span>
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
      this.finish(id, "no", "query failed");
    }
  }

  private async reject(id: string, reason?: string): Promise<void> {
    const card = this.cards.find((c) => c.id === id);
    if (card?.state !== "ready") {
      return;
    }
    // A future deny-with-reason UI passes a human note here; it goes to the agent
    // and is reflected back into the history row. Empty falls back to the defaults.
    const custom = reason?.trim();
    this.setCardState(id, "rejecting");
    await this.postResult(card, { status: "rejected", reason: custom || "Rejected by user." });
    this.finish(id, "no", "declined", undefined, custom || undefined);
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
        const who = sessionLabel(h.session, h.id);
        return `
        <button class="hrow" type="button" data-hist="${escapeHtml(h.id)}" title="${escapeHtml(h.id)}">
          <span class="harness-badge">${harnessIcon(harness)}</span>
          <span class="hwho" title="${escapeHtml(who)}">${escapeHtml(who)}</span>
          <span class="hstatus ${h.status}">${h.status === "ok" ? "approved" : "rejected"}</span>
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
    const harness = item.session?.harness?.trim() || null;
    const who = sessionLabel(item.session, item.id);
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
          <span class="detail-note">${escapeHtml(item.note)}</span>
          <button class="detail-close" type="button" data-close aria-label="Close detail">&times;</button>
        </div>
        <div class="detail-meta">${audit.join(" &middot; ")}</div>
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
