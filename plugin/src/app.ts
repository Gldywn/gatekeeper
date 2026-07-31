import type { ConnectionInfo, RunQueryResult } from "@beekeeperstudio/plugin";
import {
  addNotificationListener,
  clipboard,
  getColumns,
  getConnectionInfo,
  log,
  runQuery,
  setTabTitle,
} from "@beekeeperstudio/plugin";
import { enter, type Loop, pulse, reveal } from "./anim";
import { SchemaAnnotator } from "./annotate";
import { clock, escapeHtml, relAge } from "./html";
import { checkIcon, chevronDown, copyIcon, historyIcon } from "./icons";
import { BrokerClient } from "./net/broker";
import { historyRow } from "./render/history";
import { queueHtml, readyActions, schemaInner } from "./render/queue";
import { presence, rosterRow } from "./render/roster";
import { capResult, type Field, type HistResult } from "./result";
import { formatSql } from "./sql/format";
import { highlight } from "./sql/highlight";
import { isReadOnlyQuery, mapDialect } from "./sql/readonly";
import type {
  Card,
  CardState,
  ConnectionState,
  HistItem,
  Presence,
  Proposal,
  SessionRoster,
} from "./types";
import { ActivityView } from "./views/activity";
import { DetailView } from "./views/detail";

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

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "connecting...",
  reconnecting: "reconnecting...",
  connected: "connected",
  error: "unreachable",
};

const PRESENCE_ORDER: Record<Presence, number> = { active: 0, idle: 1, gone: 2 };

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
  // Host-side schema annotation for the approval cards; owns its own column cache
  // and reads connGeneration through a getter so a mid-fetch switch invalidates it.
  private readonly annotator = new SchemaAnnotator({
    getColumns,
    dialect: () => this.dialect,
    defaultSchema: () => this.conn?.schema ?? undefined,
    generation: () => this.connGeneration,
  });
  // Open deny forms and their in-progress reason text, keyed by card id, so a
  // half-typed reason survives a queue rebuild from a concurrent proposal.
  private readonly denyDrafts = new Map<string, string>();
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
  private pollTimer?: number;
  private pollFailures = 0;
  private pollGeneration = 0;
  private connectionState: ConnectionState = "connecting";
  private readonly root: HTMLElement;
  private readonly broker = new BrokerClient({ baseUrl: BROKER_URL, tokenKey: TOKEN_KEY });
  private readonly detailView: DetailView;
  private readonly activityView: ActivityView;

  constructor(root: HTMLElement) {
    this.root = root;
    this.detailView = new DetailView({ root, annotator: this.annotator });
    this.activityView = new ActivityView({
      root,
      broker: this.broker,
      connectionName: () => this.connectionName,
      scope: () => this.conn?.connectionName,
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.activityView.close();
        this.detailView.close();
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
    this.token = await this.broker.loadToken();
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
    addNotificationListener("tablesChanged", () => this.annotator.clearCache());
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
      const inflight = await this.broker.inflight(this.conn?.connectionName);
      if (inflight === null) {
        return;
      }
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
    this.annotator.clearCache();
    // History, activity, and roster are connection-scoped; reset so the old one
    // cannot leak in. The roster re-fetches on its own timer; the activity overlay
    // is closed because it now shows a different connection's audit trail.
    this.history.length = 0;
    this.activityView.reset();
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
      await this.broker.postConnection(this.conn);
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
      await this.broker.setToken(value);
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
        this.detailView.open(item);
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
        this.detailView.close();
      }
    });
    this.root
      .querySelector<HTMLButtonElement>("#activityBtn")!
      .addEventListener("click", () => void this.activityView.open());
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
        void this.activityView.exportSession(exp.getAttribute("data-export")!);
        return;
      }
      const sql = target.closest<HTMLElement>("[data-act-sql]");
      if (sql) {
        this.activityView.toggle(sql.getAttribute("data-act-sql")!);
        return;
      }
      if (target === activity || target.closest("[data-close]")) {
        this.activityView.close();
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
      const res = await this.broker.pending(this.conn?.connectionName);
      if (res.status === 401) {
        this.polling = false;
        this.token = null;
        await this.broker.clearToken();
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
      const sessions = await this.broker.sessions(this.conn?.connectionName);
      if (sessions !== null) {
        this.roster = sessions;
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
      ? rows.map(({ s, p }) => rosterRow(s, p)).join("")
      : '<div class="empty">No agents connected.</div>';
    el.innerHTML = `<div class="roster-head"><span class="label">Connected agents</span><span class="roster-count">${live}</span></div><div class="roster-list">${list}</div>`;
    for (const loop of this.rosterLoops) {
      loop.stop();
    }
    this.rosterLoops = [
      ...el.querySelectorAll('.roster-row[data-presence="active"] .presence-dot'),
    ].map((dot) => pulse(dot));
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
    const schema = await this.annotator.schemaFor(card.sql);
    // A mid-fetch connection switch yields null; leave the prior annotation rather
    // than blanking a card whose columns simply could not be resolved this time.
    if (schema === undefined) {
      return;
    }
    card.schema = schema;
    this.renderCardSchema(card);
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
        const res = await this.broker.renew(card.id, card.leaseId);
        if (res.ok) {
          card.leaseExpiresAt = res.leaseExpiresAt;
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
      queue.innerHTML = queueHtml(this.cards, this.dialect, this.denyDrafts);
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

  private renderCardSchema(card: Card): void {
    const el = this.root.querySelector<HTMLElement>(`#cs-${CSS.escape(card.id)}`);
    if (el) {
      el.innerHTML = schemaInner(card.schema);
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
    actions.outerHTML = readyActions(id, isReadOnlyQuery(card.sql, this.dialect), this.denyDrafts);
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
    actions.outerHTML = readyActions(id, isReadOnlyQuery(card.sql, this.dialect), this.denyDrafts);
    this.root.querySelector<HTMLButtonElement>(`[data-card="${id}"] .deny-open`)?.focus();
  }

  private async postExecuting(card: Card): Promise<boolean> {
    try {
      return await this.broker.executing(card.id, card.leaseId);
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
      return false;
    }
  }

  private async postResult(card: Card, body: Record<string, unknown>): Promise<void> {
    try {
      await this.broker.result(card.id, card.leaseId, body);
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
      .map((h) => historyRow(h))
      .join("");
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
}
