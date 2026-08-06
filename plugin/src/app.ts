import type { ConnectionInfo, JsonValue, RunQueryResult } from "@beekeeperstudio/plugin";
import {
  addNotificationListener,
  appStorage,
  broadcast,
  clipboard,
  getColumns,
  getConnectionInfo,
  log,
  openExternal,
  runQuery,
  setTabTitle,
} from "@beekeeperstudio/plugin";
import { enter, type Loop, pulse, reveal } from "./anim";
import { SchemaAnnotator } from "./annotate";
import { clock, escapeHtml, relAge } from "./html";
import {
  alertTriangleIcon,
  checkIcon,
  chevronDown,
  copyIcon,
  externalLinkIcon,
  gearIcon,
  historyIcon,
  pencilIcon,
  shieldCheckIcon,
  shieldQuestionIcon,
  warnIcon,
  xIcon,
} from "./icons";
import { BrokerClient } from "./net/broker";
import { connectionScopeKey } from "./net/scope";
import { SingleInstance, type SingleInstanceWire } from "./net/singleinstance";
import { ConfirmModal } from "./render/confirm";
import { connChipInner } from "./render/connchip";
import { modeDropdown, switchInput } from "./render/controls";
import {
  buildDevCard,
  type DevCardType,
  devBundle,
  devCardSpec,
  devPanelHtml,
} from "./render/devcards";
import { historyRow } from "./render/history";
import { type CardGate, cardGate, queueHtml, readyActions, schemaInner } from "./render/queue";
import { type LayerState, readOnlyView } from "./render/readonly";
import { devRosterRow, presence, rosterRow } from "./render/roster";
import { capResult, type Field, type HistResult } from "./result";
import { collectSchema } from "./schema-collect";
import { filterSchema, resultBudgetBytes, type Settings, SettingsStore } from "./settings";
import { classifyQuery, type RiskClass, rank } from "./sql/classify";
import { formatSql } from "./sql/format";
import { highlight } from "./sql/highlight";
import { modeRank, type RiskMode } from "./sql/mode";
import { isReadOnlyQuery, mapDialect } from "./sql/readonly";
import { type EndpointReadOnly, probeReadOnly } from "./sql/readonly-probe";
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
import { SettingsView } from "./views/settings";

const BROKER_URL = "http://localhost:9999";
const POLL_MS = 1000;
const RENEW_MS = 15_000;
const TICK_MS = 1000;
const CONN_CHECK_MS = 5000;
const TOKEN_KEY = "gatekeeper.token";
const ROSTER_POLL_MS = 2000;

// The read-only layer help sentences, revealed by each row's "?" affordance. The
// Gatekeeper one tracks the armed mode: read-only by default, wider once armed.
function helpGatekeeper(mode: RiskMode): string {
  if (mode === "write") {
    return "Write mode is armed: Gatekeeper may run an approved INSERT or UPDATE, still one human approval at a time.";
  }
  if (mode === "destructive") {
    return "Destructive mode is armed: Gatekeeper may run an approved write, up to DELETE, DROP, or TRUNCATE, still one human approval at a time.";
  }
  return "Gatekeeper only ever runs read-only SELECT queries. It never sends a write to the database, whatever the connection would allow.";
}
const HELP_BEEKEEPER =
  "Beekeeper's own connection read-only mode. When on, Beekeeper blocks any write on this connection by itself.";
const HELP_ENDPOINT =
  "The database endpoint this connection actually reaches. A read replica (such as an Aurora reader) rejects writes at the server, even if the credentials could write.";

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

// A quick-menu switch row: the setting name and its live, persisted toggle.
function quickSwitch(setting: string, label: string, checked: boolean): string {
  return `<label class="qs-row switch-row"><span class="qs-name">${label}</span>${switchInput(setting, label, checked)}</label>`;
}

function newInstanceId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Placeholder until the public repo exists; both open in the user's browser via the host.
const REPO_URL = "https://github.com/gatekeeper/gatekeeper";
const ISSUES_URL = `${REPO_URL}/issues/new/choose`;
const STARRED_KEY = "gatekeeper.starred.v2";

const starGlyph =
  '<svg class="star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
const feedbackGlyph =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/><path d="M9.5 9h5M9.5 13h3"/></svg>';

function layerGlyph(state: LayerState): string {
  return state === "ok" ? shieldCheckIcon : state === "warn" ? warnIcon : shieldQuestionIcon;
}

export class Gatekeeper {
  private token: string | null = null;
  private connectionName = "";
  private dialect = "postgresql";
  // Ephemeral armed access mode: in-memory only, never persisted. Resets to "read"
  // on load, on a connection switch, and on re-pair.
  private mode: RiskMode = "read";
  private conn: {
    id: number;
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
  // Monotonic counter for synthetic dev-card ids, so a bundle injected in one tick
  // never collides on id.
  private devSeq = 0;
  private readonly history: HistItem[] = [];
  private roster: SessionRoster[] = [];
  private rosterSig = "";
  private rosterOpen = true;
  private rosterLive = -1;
  private rosterLoops: Loop[] = [];
  private breatheLoop?: Loop;
  private prevCardIds = new Set<string>();
  private polling = false;
  private lastTitle = "";
  private lastConnCheck = 0;
  private connCheckInFlight = false;
  private connGeneration = 0;
  // Host-side endpoint read-only probe result, reset per connection. null once
  // probed means "not verified" (non-Postgres or error); endpointProbed keeps the
  // pending state distinct from a probe that ran and could not confirm.
  private endpointRO: EndpointReadOnly | null = null;
  private endpointProbed = false;
  private renewTimer?: number;
  private tickTimer?: number;
  private pollTimer?: number;
  private pollFailures = 0;
  private pollGeneration = 0;
  private single?: SingleInstance;
  private wiredNotifications = false;
  private starred = false;
  // Bumped on every activate/deactivate so an async activate() that was overtaken by a
  // demotion bails before it starts polling (a standby must never touch the broker).
  private activeGen = 0;
  private connectionState: ConnectionState = "connecting";
  private readonly root: HTMLElement;
  private readonly broker = new BrokerClient({ baseUrl: BROKER_URL, tokenKey: TOKEN_KEY });
  private readonly settingsStore = new SettingsStore();
  private readonly detailView: DetailView;
  private readonly activityView: ActivityView;
  private readonly settingsView: SettingsView;
  private readonly confirmModal: ConfirmModal;

  constructor(root: HTMLElement) {
    this.root = root;
    this.confirmModal = new ConfirmModal(root);
    this.detailView = new DetailView({
      root,
      annotator: this.annotator,
      settings: () => this.settingsStore.get(),
    });
    this.activityView = new ActivityView({
      root,
      broker: this.broker,
      connectionName: () => this.connectionName,
      scope: () => this.connScopeKey(),
      connChip: () => {
        const data = this.connChipData();
        return data ? `<span class="conn-chip">${connChipInner(data)}</span>` : "";
      },
      // The raw annotator, deliberately not filterSchema: the audit trail is a durable
      // security record, so it always flags PII/client/values even on a connection whose
      // detection toggles are off (unlike the pending cards and the detail, which honour them).
      schemaFor: (sql) => this.annotator.schemaFor(sql),
      dialect: () => this.dialect,
    });
    this.settingsView = new SettingsView({
      root,
      settings: () => this.settingsStore.get(),
      mode: () => this.mode,
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // The arm/confirm modal sits on top of everything; it swallows the first
        // Escape (cancelling) before any overlay beneath it can close.
        if (this.confirmModal.cancel()) {
          return;
        }
        // An open mode or export menu swallows the first Escape so it dismisses without
        // also tearing down the overlay or popover it sits inside.
        if (this.closeModeMenus() || this.closeExportMenus()) {
          return;
        }
        this.activityView.close();
        this.detailView.close();
        this.settingsView.close();
        this.setSettingsOpen(false);
      }
    });
    // A click anywhere outside the gear or the open popover dismisses it. Bound
    // once (the gear/popover are re-created per render, so this reads them live).
    document.addEventListener("click", (e) => {
      const pop = this.root.querySelector<HTMLElement>("#settingsPop");
      if (!pop || pop.hidden) {
        return;
      }
      const target = e.target as Node;
      if (pop.contains(target) || this.root.querySelector("#settingsGear")?.contains(target)) {
        return;
      }
      this.setSettingsOpen(false);
    });
    // The styled mode dropdowns (settings overlay and quick popover) open/close like
    // the gear popover: the trigger toggles, a click outside dismisses. Selecting an
    // option requests that mode (a raise confirms; a drop applies at once).
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const trigger = target.closest<HTMLElement>("[data-mode-trigger]");
      if (trigger) {
        this.toggleModeMenu(trigger);
        return;
      }
      const opt = target.closest<HTMLElement>("[data-mode-opt]");
      if (opt) {
        this.closeModeMenus();
        this.requestMode(opt.getAttribute("data-mode-opt") as RiskMode);
        return;
      }
      if (target.closest("[data-mode-menu]")) {
        return;
      }
      this.closeModeMenus();
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
    try {
      this.starred = (await appStorage.getItem<boolean>(STARRED_KEY)) === true;
    } catch {
      this.starred = false;
    }
    // Gate the whole boot behind a cross-tab election: only the active instance talks to
    // the broker, the rest sit inert, so several open tabs never double-poll or race.
    this.single = new SingleInstance(
      {
        post: (m) => broadcast.post(m as unknown as JsonValue),
        subscribe: (h) => broadcast.on((m) => h(m as unknown as SingleInstanceWire)),
        now: () => Date.now(),
        onActive: () => void this.activate(),
        onStandby: () => this.deactivate(),
      },
      newInstanceId(),
    );
    window.addEventListener("pagehide", () => this.single?.dispose());
    this.single.join();
  }

  private async activate(): Promise<void> {
    const gen = ++this.activeGen;
    this.token = await this.broker.loadToken();
    try {
      this.applyConnection(await getConnectionInfo());
      this.lastConnCheck = Date.now();
    } catch {
      // Connection info is best-effort; the queue still works without it. A
      // failed initial read leaves lastConnCheck at 0 so the first tick retries.
    }
    // A demotion during the awaits above wins: bail before polling or rendering the shell.
    if (gen !== this.activeGen) {
      return;
    }
    if (!this.token) {
      this.renderPairing();
      return;
    }
    await this.settingsStore.load(this.connectionName);
    if (gen !== this.activeGen) {
      return;
    }
    this.renderShell();
    // The schema annotation caches columns per table; a DDL change invalidates it.
    if (!this.wiredNotifications) {
      this.wiredNotifications = true;
      addNotificationListener("tablesChanged", () => {
        this.annotator.clearCache();
        void this.reportSchema();
      });
    }
    this.polling = true;
    void this.loadInflight();
    void this.poll();
    void this.pollRoster(++this.pollGeneration);
    void this.reportConnection();
    void this.reportSchema();
    void this.probeEndpoint();
    this.startTimers();
  }

  // Lost the election (another tab owns the slot): stop every broker-touching loop and
  // show the inert standby screen. A later promotion re-runs activate().
  private deactivate(): void {
    this.activeGen++;
    this.polling = false;
    this.pollGeneration++;
    if (this.pollTimer !== undefined) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.renewTimer !== undefined) {
      window.clearInterval(this.renewTimer);
      this.renewTimer = undefined;
    }
    if (this.tickTimer !== undefined) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    for (const loop of this.rosterLoops) {
      loop.stop();
    }
    this.rosterLoops = [];
    this.breatheLoop?.stop();
    this.breatheLoop = undefined;
    this.rosterSig = "";
    this.rosterLive = -1;
    this.renderStandby();
  }

  private renderStandby(): void {
    this.root.innerHTML = `
      <div class="standby">
        <div class="standby-card">
          <span class="standby-ico">${copyIcon}</span>
          <h1>Open in another tab</h1>
          <p>Gatekeeper runs in a single tab so two tabs never race an approval. This tab is inactive.</p>
          <button class="btn approve" id="takeover" type="button">Use Gatekeeper here</button>
        </div>
      </div>`;
    this.root
      .querySelector<HTMLButtonElement>("#takeover")
      ?.addEventListener("click", () => this.single?.takeOver());
  }

  // Once the human has starred (from anywhere), the home star stops twinkling for good.
  private async markStarred(): Promise<void> {
    if (this.starred) {
      return;
    }
    this.starred = true;
    for (const el of this.root.querySelectorAll(".cta-fab.star")) {
      el.classList.remove("twinkle");
    }
    try {
      await appStorage.setItem(STARRED_KEY, true);
    } catch {
      // A failed write just risks the star twinkling again next launch; harmless.
    }
  }

  // Re-adopt the proposals still leased to this plugin so a reopened tab shows them
  // at once; renew right away so a near-expiry lease does not lapse before the timer.
  private async loadInflight(): Promise<void> {
    try {
      const gen = this.connGeneration;
      const inflight = await this.broker.inflight(this.connScopeKey());
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
      id: conn.id,
      connectionName: conn.connectionName,
      databaseType: conn.databaseType,
      databaseName: conn.databaseName,
      schema: conn.defaultSchema ?? null,
      readOnly: conn.readOnlyMode,
    };
  }

  // The scoping identity sent to the broker: composite so a same-named connection
  // on a different engine/database never claims this one's queries, roster, or
  // activity. undefined pre-snapshot, so the header is omitted until we know it.
  private connScopeKey(): string | undefined {
    return this.conn ? connectionScopeKey(this.conn) : undefined;
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
    // Detect a switch by the composite identity, not the display name alone: two
    // connections can share a name yet point at different engines/databases, and
    // those must not silently keep the prior scope, cards, or history.
    const nextKey = connectionScopeKey({
      connectionName: conn.connectionName,
      databaseType: conn.databaseType,
      databaseName: conn.databaseName,
    });
    // SAFETY-CRITICAL: also key the switch on Beekeeper's stable connection id, so an
    // armed mode never carries across two connections that share name+engine+database
    // but point at different hosts (the scope key alone cannot tell them apart).
    if (this.conn?.id === conn.id && this.connScopeKey() === nextKey) {
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
    // SAFETY-CRITICAL: the armed mode belongs to the old connection; a new database
    // must never inherit write/destructive. Drop any half-open arm dialog too.
    this.mode = "read";
    this.confirmModal.cancel();
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
    // The endpoint belongs to the old database; re-probe the new one from scratch.
    this.endpointRO = null;
    this.endpointProbed = false;
    // Settings are per connection; the overlay now shows a different scope, so close
    // it and reload (which re-syncs the quick-menu switches and the activity trigger).
    this.settingsView.close();
    this.renderConnLabel();
    this.renderModeSurfaces();
    void this.reportConnection();
    void this.probeEndpoint();
    // Load the NEW connection's settings before reporting its schema, so schema access is
    // read from the connection the human is now on, never from the previous one's consent.
    void (async () => {
      await this.reloadSettings();
      await this.reportSchema();
    })();
    this.renderQueue();
    this.renderHistory();
    this.renderRoster();
  }

  private async reloadSettings(): Promise<void> {
    await this.settingsStore.load(this.connectionName);
    this.onSettingsChanged();
  }

  // The connection identity's display parts, shared by the header chip and the
  // audit-trail head. null pre-snapshot, when only the bare name is known.
  private connChipData(): { name: string; dialect: string; path: string } | null {
    const c = this.conn;
    if (!c) {
      return null;
    }
    const path = [c.databaseName?.trim(), c.schema?.trim()]
      .filter((part): part is string => Boolean(part))
      .join(" / ");
    return {
      name: c.connectionName || this.connectionName,
      dialect: mapDialect(c.databaseType),
      path,
    };
  }

  // The connection context lives once, in the header: what database the whole
  // queue governs. Reads this.conn; falls back to the bare name pre-snapshot.
  private renderConnLabel(): void {
    const el = this.root.querySelector<HTMLSpanElement>("#conn");
    if (!el) {
      return;
    }
    const data = this.connChipData();
    if (!data) {
      el.innerHTML = this.connectionName ? escapeHtml(this.connectionName) : "";
      return;
    }
    el.innerHTML = `${connChipInner(data)}<span class="dsep"></span>${this.readOnlyBadge()}`;
  }

  // Aggregate over the three layers (Gatekeeper mode, Beekeeper mode, endpoint): green
  // when any blocks writes, amber when all would accept one, muted when it cannot be told.
  private readOnlyBadge(): string {
    // The Gatekeeper layer is read-only only while the armed mode is "read"; a raised
    // mode makes it a writer, so the aggregate rides the lower layers.
    const view = readOnlyView(
      this.mode === "read",
      this.conn?.readOnly ?? false,
      this.endpointRO,
      this.endpointProbed,
    );
    const rows =
      this.roRow(
        "Gatekeeper",
        helpGatekeeper(this.mode),
        view.gatekeeper.label,
        view.gatekeeper.state,
      ) +
      this.roRow("Beekeeper", HELP_BEEKEEPER, view.beekeeper.label, view.beekeeper.state) +
      this.roRow("Endpoint", HELP_ENDPOINT, view.endpoint.label, view.endpoint.state);

    const { kind, label } = view.chip;
    const title =
      kind === "ok"
        ? "Read-only: a layer blocks writes, hover for details"
        : kind === "warn"
          ? "Writable: every layer would accept a write, hover for details"
          : "Read-only status unknown, hover for details";
    // The chevron signals the badge expands into the layer breakdown on hover/focus.
    return `<span class="ro-wrap" tabindex="0">
      <span class="ro ${kind}" title="${title}">${layerGlyph(kind)}${label}<span class="ro-caret" aria-hidden="true">${chevronDown}</span></span>
      <span class="ro-pop" role="tooltip">
        <div class="ro-pop-head">Read-only layers</div>
        ${rows}
      </span>
    </span>`;
  }

  // A layer row: name, a "?" help affordance revealing the explanation on hover and
  // keyboard focus (with an aria-label for screen readers), then the state chip.
  private roRow(name: string, help: string, label: string, state: LayerState): string {
    return `<div class="ro-row"><span class="ro-help" tabindex="0" role="button" aria-label="${escapeHtml(help)}">?<span class="ro-tip" role="tooltip">${escapeHtml(help)}</span></span><span class="ro-name">${name}</span><span class="ro-state ${state}">${layerGlyph(state)}${label}</span></div>`;
  }

  // Hand the agent non-sensitive context (dialect, database, schema, read-only)
  // so it can target the right database; never host, user, or credentials.
  private async reportConnection(): Promise<void> {
    if (!this.conn) {
      return;
    }
    try {
      await this.broker.postConnection({ ...this.conn, mode: this.mode });
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }

  // Push the structural schema for get_schema when the human has schema access on, or an
  // explicit "off" so a switched-away or opted-out connection never serves a stale schema.
  private async reportSchema(): Promise<void> {
    if (!this.conn) {
      return;
    }
    const scope = this.connScopeKey() ?? "";
    const name = this.connectionName;
    const on = this.settingsStore.get().schemaAccess;
    try {
      const payload = on
        ? await collectSchema(name, scope)
        : { connectionName: name, scope, access: false, tables: [] };
      // Re-validate after the (possibly slow) collect: a connection switch or a toggle flip
      // in between must never post a schema for the wrong database, or one without consent.
      if ((this.connScopeKey() ?? "") !== scope || this.settingsStore.get().schemaAccess !== on) {
        return;
      }
      await this.broker.postSchema(payload);
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }

  // connGeneration-guarded like the annotator: a switch mid-probe discards the
  // result. Runs via runQuery directly (host-side, not the approval gate) and is
  // stored on the class only, never posted to the broker.
  private async probeEndpoint(): Promise<void> {
    if (!this.conn) {
      return;
    }
    const gen = this.connGeneration;
    const result = await probeReadOnly(this.dialect, runQuery);
    if (gen !== this.connGeneration) {
      return;
    }
    this.endpointRO = result;
    this.endpointProbed = true;
    this.renderConnLabel();
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
      const gen = this.activeGen;
      // Re-pairing is a fresh session; the armed mode never survives it.
      this.mode = "read";
      await this.broker.setToken(value);
      this.token = value;
      await this.settingsStore.load(this.connectionName);
      // Demoted while pairing (another tab took the slot): never start polling.
      if (gen !== this.activeGen) {
        return;
      }
      this.polling = true;
      this.renderShell();
      void this.loadInflight();
      void this.poll();
      void this.pollRoster(++this.pollGeneration);
      void this.reportConnection();
      void this.reportSchema();
      void this.probeEndpoint();
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

  // The header quick menu ("Guards") reflects the live per-connection settings, so it
  // is built here rather than as a static const.
  private headerHtml(): string {
    const s = this.settingsStore.get();
    return `
  <header class="bar">
    <span class="hive-wrap" aria-hidden="true"><span class="hive"></span></span>
    <span class="brand">
      <span class="mark" aria-hidden="true"></span>
      <span class="wordmark">Gatekeeper</span>
    </span>
    <span class="conn-chip" id="conn"></span>
    <span class="armed" id="armed"></span>
    <span class="bar-right">
      <span class="sa-hint-wrap" id="schemaHint" data-on="${s.schemaAccess}">
        <button class="sa-hint" type="button" data-schema-hint aria-label="Schema access">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg>
          <span class="sa-dot"></span>
          <span class="sa-check">${checkIcon}</span>
        </button>
        <span class="sa-pop">
          <span class="sa-body sa-off">
            <span class="sa-pt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>Sharper queries</span>
            <p>Without this, agents guess your table and column names. Turn on Schema access so they read the real structure through get_schema and write accurate SQL. Never exposes any row data.</p>
            <button class="sa-enable" type="button" data-schema-enable>Enable Schema access</button>
          </span>
          <span class="sa-body sa-on">
            <span class="sa-pt ok"><span class="sa-pt-ico">${checkIcon}</span>Sharper queries</span>
            <p>Schema access is on. Agents read your structure (tables, columns, types, keys) through get_schema and write more accurate SQL. Never exposes any row data.</p>
          </span>
        </span>
      </span>
      <span class="conn-status" id="connStatus" aria-live="polite"></span>
      <span class="dsep"></span>
      <span class="gear-wrap">
        <button class="gear" id="settingsGear" type="button" aria-label="Settings" aria-haspopup="true" aria-expanded="false">${gearIcon}</button>
        <div class="settings-pop" id="settingsPop" role="menu" aria-label="Settings" hidden>
          <div class="pop-group">
            <div class="pop-eyebrow">Access</div>
            <div class="qs-row"><span class="qs-name">Mode</span><span class="qs-ctl" id="modeCtlHeader">${modeDropdown(this.mode, true)}</span></div>
            <div id="confirmQuickRow"${this.mode === "read" ? " hidden" : ""}>${quickSwitch("confirmWrites", "Double confirmation", s.confirmWrites)}</div>
          </div>
          <div class="pop-group">
            <div class="pop-eyebrow">Detection</div>
            ${quickSwitch("schemaAnnotation", "Schema annotation", s.schemaAnnotation)}
            ${quickSwitch("piiFlagging", "PII flagging", s.piiFlagging)}
            ${quickSwitch("clientFlagging", "Client-data flagging", s.clientFlagging)}
            ${quickSwitch("sensitiveValues", "Sensitive-value detection", s.sensitiveValues)}
          </div>
          <div class="pop-foot">
            <button class="pop-full" id="settingsAll" type="button">Open all settings ${externalLinkIcon}</button>
          </div>
        </div>
      </span>
    </span>
  </header>`;
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="gk">
        ${this.headerHtml()}
        <div class="rail" id="rail">
          <section class="roster" id="roster"></section>
        </div>
        <div class="main" id="main">
          <div id="devPanel"></div>
          <p class="label">Pending approval <span class="count-badge" id="pendingCount" aria-live="polite"></span></p>
          <div class="queue" id="queue"></div>
          <section class="history">
            <div class="history-head">
              <button class="disclosure" id="htoggle" aria-expanded="true"><span class="chev">${chevronDown}</span>Recently resolved</button>
              <button class="activity-link" id="activityBtn" type="button">${historyIcon}Audit Trail</button>
            </div>
            <div class="hist" id="hist"></div>
          </section>
        </div>
        <div class="detail" id="detail" hidden></div>
        <div class="detail activity-overlay" id="activity" hidden></div>
        <div class="detail settings-overlay" id="settings" hidden></div>
        <div class="detail confirm-overlay" id="confirm" hidden></div>
        <div class="cta-cluster" id="ctaCluster">
          <button class="cta-fab star${this.starred ? "" : " twinkle"}" type="button" data-gh-star aria-label="Star Gatekeeper on GitHub">${starGlyph}<span class="cta-lbl">Star on GitHub</span></button>
          <button class="cta-fab fb" type="button" data-gh-feedback aria-label="Request a feature">${feedbackGlyph}<span class="cta-lbl">Request a feature</span></button>
        </div>
      </div>`;
    this.renderConnLabel();
    this.renderArmed();
    const toggle = this.root.querySelector<HTMLButtonElement>("#htoggle")!;
    const hist = this.root.querySelector<HTMLDivElement>("#hist")!;
    toggle.addEventListener("click", () => {
      const open = hist.style.display !== "none";
      hist.style.display = open ? "none" : "";
      toggle.setAttribute("aria-expanded", String(!open));
    });
    const rosterEl = this.root.querySelector<HTMLElement>("#roster")!;
    rosterEl.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest("[data-roster-toggle]")) {
        return;
      }
      this.rosterOpen = !this.rosterOpen;
      rosterEl
        .querySelector("[data-roster-toggle]")
        ?.setAttribute("aria-expanded", String(this.rosterOpen));
      if (this.rosterOpen) {
        // Re-arm the cascade: drop .play, force one reflow, re-add so it replays.
        const rows = [...rosterEl.querySelectorAll<HTMLElement>(".roster-row")];
        for (const r of rows) {
          r.classList.remove("play");
        }
        void rosterEl.offsetWidth;
        for (const r of rows) {
          r.classList.add("play");
        }
      }
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
    // Developer-only generator panel; the whole subtree is empty (and inert) unless
    // dev mode is on, so this handler never fires for a real user.
    this.root.querySelector<HTMLElement>("#devPanel")!.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-dev-bundle]")) {
        this.injectDevBundle();
        return;
      }
      if (target.closest("[data-dev-reload]")) {
        // Re-fetches the iframe's plugin:// URL from disk so a rebuild shows without a
        // tab close/reopen; resets state like a reopen, the host bridge is stateless.
        if (this.settingsStore.get().developerMode) {
          window.location.reload();
        }
        return;
      }
      const chip = target.closest<HTMLElement>("[data-dev-chip]");
      if (chip) {
        this.injectDevCard(chip.getAttribute("data-dev-chip") as DevCardType);
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
    // The armed banner's X drops straight back to read-only (no confirm on a drop).
    this.root.querySelector<HTMLElement>("#armed")!.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-disarm]")) {
        this.applyMode("read");
      }
    });
    this.root.querySelector<HTMLButtonElement>("#settingsGear")!.addEventListener("click", (e) => {
      // Stop the bubble so the document dismiss handler does not immediately
      // re-close the popover this same click just opened.
      e.stopPropagation();
      const pop = this.root.querySelector<HTMLElement>("#settingsPop")!;
      this.setSettingsOpen(pop.hidden);
    });
    this.root.querySelector<HTMLButtonElement>("#settingsAll")!.addEventListener("click", () => {
      this.setSettingsOpen(false);
      this.settingsView.open();
    });
    // The header schema hint (and its Enable button) opens the settings, never toggles
    // Schema access directly, so enabling it stays a deliberate act in one place.
    this.root.querySelector<HTMLElement>("#schemaHint")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-schema-enable], [data-schema-hint]")) {
        this.setSettingsOpen(false);
        this.settingsView.open();
      }
    });
    this.root.querySelector<HTMLElement>("#ctaCluster")?.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-gh-star]")) {
        void this.markStarred();
        void openExternal(REPO_URL);
      } else if (target.closest("[data-gh-feedback]")) {
        void openExternal(ISSUES_URL);
      }
    });
    // The quick-menu switches are real inputs; persist on toggle and re-sync surfaces.
    this.root.querySelector<HTMLElement>("#settingsPop")!.addEventListener("change", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-setting]");
      if (input) {
        this.onSettingInput(input.dataset.setting!, input.checked, input);
      }
    });
    const settings = this.root.querySelector<HTMLDivElement>("#settings")!;
    settings.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-gh-star]")) {
        void this.markStarred();
        void openExternal(REPO_URL);
        return;
      }
      if (target.closest("[data-gh-feedback]")) {
        void openExternal(ISSUES_URL);
        return;
      }
      if (target.closest("[data-reset-settings]")) {
        this.confirmModal.open({
          tone: "destructive",
          heading: "Reset all settings?",
          body: "Every setting on this connection goes back to its default: detection, double confirmation, schema access, and result memory. This can't be undone.",
          confirmLabel: "Reset to defaults",
          onConfirm: () => void this.resetSettings(),
        });
        return;
      }
      if (target === settings || target.closest("[data-close]")) {
        this.settingsView.close();
      }
    });
    settings.addEventListener("change", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-setting]");
      if (el instanceof HTMLSelectElement) {
        void this.updateSetting(el.dataset.setting!, Number(el.value));
      } else if (el instanceof HTMLInputElement) {
        this.onSettingInput(el.dataset.setting!, el.checked, el);
      }
    });
    const activity = this.root.querySelector<HTMLDivElement>("#activity")!;
    activity.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const copy = target.closest<HTMLElement>("[data-copy-sql]");
      if (copy) {
        this.copySql(copy);
        return;
      }
      const fmt = target.closest<HTMLElement>("[data-export-fmt]");
      if (fmt) {
        this.closeExportMenus();
        void this.activityView.exportSession(
          fmt.getAttribute("data-export")!,
          fmt.getAttribute("data-export-fmt") as "md" | "csv",
        );
        return;
      }
      const expTrigger = target.closest<HTMLElement>("[data-export-trigger]");
      if (expTrigger) {
        this.toggleExportMenu(expTrigger);
        return;
      }
      // Any other click in the panel dismisses an open format menu.
      this.closeExportMenus();
      const dayHead = target.closest<HTMLElement>("[data-day]");
      if (dayHead) {
        this.activityView.toggleDay(dayHead);
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
    this.renderDevPanel();
    this.renderQueue();
    this.renderHistory();
    this.renderRoster(); // Rebuilt DOM has a blank pill; force it back to the initial state (the
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

  // Show or hide the safeguards popover, keeping the gear's aria-expanded and
  // open styling in sync. No-ops on screens without the header (e.g. pairing).
  private setSettingsOpen(open: boolean): void {
    const gear = this.root.querySelector<HTMLButtonElement>("#settingsGear");
    const pop = this.root.querySelector<HTMLElement>("#settingsPop");
    if (!gear || !pop) {
      return;
    }
    pop.hidden = !open;
    gear.setAttribute("aria-expanded", String(open));
    gear.classList.toggle("open", open);
    if (!open) {
      this.closeModeMenus();
    }
  }

  // The export format menu opens/closes like the mode menus: one at a time, trigger
  // toggles, a click elsewhere dismisses.
  private toggleExportMenu(trigger: HTMLElement): void {
    const menu = trigger.parentElement?.querySelector<HTMLElement>("[data-export-menu]");
    if (!menu) {
      return;
    }
    const open = menu.hidden;
    this.closeExportMenus();
    if (open) {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    }
  }

  private closeExportMenus(): boolean {
    let closed = false;
    for (const menu of this.root.querySelectorAll<HTMLElement>("[data-export-menu]")) {
      if (!menu.hidden) {
        menu.hidden = true;
        closed = true;
      }
    }
    for (const trigger of this.root.querySelectorAll<HTMLElement>("[data-export-trigger]")) {
      trigger.setAttribute("aria-expanded", "false");
    }
    return closed;
  }

  // Show one mode menu at a time, closing any other first.
  private toggleModeMenu(trigger: HTMLElement): void {
    const menu = trigger.parentElement?.querySelector<HTMLElement>("[data-mode-menu]");
    if (!menu) {
      return;
    }
    const open = menu.hidden;
    this.closeModeMenus();
    if (open) {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    }
  }

  // Close every open mode menu; returns whether one was actually open.
  private closeModeMenus(): boolean {
    let closed = false;
    for (const menu of this.root.querySelectorAll<HTMLElement>("[data-mode-menu]")) {
      if (!menu.hidden) {
        menu.hidden = true;
        closed = true;
      }
    }
    for (const trigger of this.root.querySelectorAll<HTMLElement>("[data-mode-trigger]")) {
      trigger.setAttribute("aria-expanded", "false");
    }
    return closed;
  }

  private async updateSetting(key: string, value: boolean | number): Promise<void> {
    await this.settingsStore.set({ [key]: value });
    this.onSettingsChanged();
    // Turning schema access on/off must push (or clear) the schema right away.
    if (key === "schemaAccess") {
      void this.reportSchema();
    }
  }

  private async resetSettings(): Promise<void> {
    await this.settingsStore.reset();
    // Re-render the open overlay to the defaults, re-sync the quick menu and hint, and clear
    // the schema (schemaAccess is back off).
    this.settingsView.open();
    this.onSettingsChanged();
    void this.reportSchema();
  }

  // A toggle from either settings surface. Enabling developer mode confirms through the
  // shared modal (a raise); disabling, and every other toggle, applies immediately.
  private onSettingInput(key: string, value: boolean, inputEl?: HTMLInputElement): void {
    if (key === "developerMode" && value === true) {
      this.confirmModal.open({
        tone: "exec",
        heading: "Enable Developer Mode",
        body: "Developer mode adds synthetic proposals and a fake agent for local testing. It only ever runs neutral read-only queries and never touches your data.",
        confirmLabel: "Enable Developer Mode",
        onConfirm: () => void this.updateSetting(key, true),
        onCancel: () => {
          if (inputEl) {
            inputEl.checked = false;
          }
        },
      });
      return;
    }
    void this.updateSetting(key, value);
  }

  // Selecting a mode: a drop (or read) applies at once; a raise opens the confirm modal,
  // which applies it only once the human confirms (destructive also types the db name).
  private requestMode(next: RiskMode): void {
    if (next === this.mode) {
      return;
    }
    if (modeRank(next) <= modeRank(this.mode)) {
      this.applyMode(next);
      return;
    }
    this.openModeArm(next);
  }

  private openModeArm(next: RiskMode): void {
    if (next === "write") {
      this.confirmModal.open({
        tone: "write",
        heading: "Enable Write Mode",
        body: "Write mode lets you approve INSERT and UPDATE statements. Each still runs only on your one-click approval, one at a time.",
        confirmLabel: "Enable Write Mode",
        onConfirm: () => this.applyMode("write"),
      });
      return;
    }
    // Destructive types the database name to confirm; a blank target (no connection
    // captured) can never match, so the confirm stays locked, fail-closed.
    this.confirmModal.open({
      tone: "destructive",
      heading: "Enable Destructive Mode",
      body: "Destructive mode lets you approve DELETE, DROP, TRUNCATE and other data-changing statements. Type the database name to confirm.",
      confirmLabel: "Enable Destructive Mode",
      challenge: {
        label: "Type the database name to confirm",
        expected: this.conn?.databaseName ?? "",
        placeholder: this.conn?.databaseName || "database name",
      },
      onConfirm: () => this.applyMode("destructive"),
    });
  }

  // Commit a mode change: re-render the badge, mode surfaces and armed banner, re-gate
  // the queue, and re-post the snapshot so the agent sees the new mode.
  private applyMode(next: RiskMode): void {
    if (next === this.mode) {
      return;
    }
    this.mode = next;
    this.renderConnLabel();
    this.renderModeSurfaces();
    this.renderQueue();
    void this.reportConnection();
  }

  // Re-render both mode dropdowns (header popover, settings overlay when open) and the
  // armed banner in place, without a full shell rebuild.
  private renderModeSurfaces(): void {
    const header = this.root.querySelector<HTMLElement>("#modeCtlHeader");
    if (header) {
      header.innerHTML = modeDropdown(this.mode, true);
    }
    const overlay = this.root.querySelector<HTMLElement>("#modeCtlSettings");
    if (overlay) {
      overlay.innerHTML = modeDropdown(this.mode);
    }
    // Double-confirmation only matters once a write/destructive mode is armed, so the quick
    // menu surfaces it only then; the full settings screen always shows it to preconfigure.
    const confirmRow = this.root.querySelector<HTMLElement>("#confirmQuickRow");
    if (confirmRow) {
      confirmRow.hidden = this.mode === "read";
    }
    this.renderArmed();
  }

  // The header armed banner, present only when a mode is armed: a toned chip with an X
  // that drops back to read-only.
  private renderArmed(): void {
    const el = this.root.querySelector<HTMLElement>("#armed");
    if (!el) {
      return;
    }
    if (this.mode === "read") {
      el.innerHTML = "";
      return;
    }
    const tone = this.mode === "destructive" ? "destructive" : "write";
    const label = this.mode === "destructive" ? "DESTRUCTIVE MODE" : "WRITE MODE";
    const icon = this.mode === "destructive" ? alertTriangleIcon : pencilIcon;
    el.innerHTML = `<span class="armed-chip ${tone}"><span class="armed-ico">${icon}</span>${label}<button class="armed-off" type="button" data-disarm title="Disarm, back to read-only" aria-label="Disarm, back to read-only">${xIcon}</button></span>`;
  }

  // A setting changed (from either surface): re-sync both control surfaces, re-apply
  // the activity-log visibility and history cap, and re-annotate the pending cards so
  // a dropped detection axis stops flagging at once.
  private onSettingsChanged(): void {
    this.syncSettingControls();
    const hint = this.root.querySelector<HTMLElement>("#schemaHint");
    if (hint) {
      hint.dataset.on = String(this.settingsStore.get().schemaAccess);
    }
    this.trimHistory();
    this.renderHistory();
    for (const card of [...this.cards]) {
      void this.analyzeSchema(card);
    }
    this.syncDevMode();
  }

  // Dev mode gates every dev surface; when it goes off, drop any synthetic cards so
  // nothing dev survives the toggle, then re-render the panel, queue, and roster so
  // the panel and fake agent appear or disappear together.
  private syncDevMode(): void {
    if (!this.settingsStore.get().developerMode) {
      for (let i = this.cards.length - 1; i >= 0; i--) {
        if (this.cards[i].dev) {
          this.denyDrafts.delete(this.cards[i].id);
          this.cards.splice(i, 1);
        }
      }
    }
    this.renderDevPanel();
    this.renderQueue();
    this.renderRoster();
  }

  private renderDevPanel(): void {
    const el = this.root.querySelector<HTMLElement>("#devPanel");
    if (el) {
      el.innerHTML = this.settingsStore.get().developerMode ? devPanelHtml() : "";
    }
  }

  private nextDevId(): string {
    return `dev_${(this.devSeq++).toString(36).padStart(4, "0")}`;
  }

  private injectDevBundle(): void {
    if (!this.settingsStore.get().developerMode) {
      return;
    }
    for (const spec of devBundle()) {
      this.addDevCard(buildDevCard(spec, this.nextDevId(), Date.now()));
    }
  }

  private injectDevCard(type: DevCardType): void {
    if (!this.settingsStore.get().developerMode) {
      return;
    }
    this.addDevCard(buildDevCard(devCardSpec(type), this.nextDevId(), Date.now()));
  }

  // A synthetic card joins the same queue and schema annotation as a real one, so it
  // renders identically; only its resolve path (approve/reject) diverges, staying local.
  private addDevCard(card: Card): void {
    this.cards.push(card);
    this.renderQueue();
    void this.analyzeSchema(card);
  }

  // Mirror the live settings into every rendered control (quick menu and overlay)
  // by property, not a rebuild, so the input the human just touched keeps its focus.
  private syncSettingControls(): void {
    const s = this.settingsStore.get();
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-setting]")) {
      const key = el.dataset.setting as keyof Settings;
      const value = s[key];
      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        el.checked = Boolean(value);
      } else if (el instanceof HTMLSelectElement) {
        el.value = String(value);
      }
    }
  }

  private trimHistory(): void {
    const cap = this.settingsStore.get().recentlyResolved;
    if (this.history.length > cap) {
      this.history.length = cap;
    }
    this.enforceHistoryBudget();
  }

  private async poll(): Promise<void> {
    if (!this.polling) {
      return;
    }
    let claimed = false;
    try {
      const res = await this.broker.pending(this.connScopeKey());
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
      const sessions = await this.broker.sessions(this.connScopeKey());
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
    // The fake agent is pinned first and counted; fold dev mode into the signature
    // so toggling it forces a rebuild.
    const dev = this.settingsStore.get().developerMode;
    // Skip the rebuild (and the pulse restart) when only the relative ages moved;
    // tick() keeps those fresh in place.
    const sig = JSON.stringify([
      dev,
      rows.map((r) => [r.s.sessionId, r.p, r.s.pendingCount, r.s.sessionLabel, r.s.lastIntent]),
    ]);
    if (sig === this.rosterSig) {
      return;
    }
    this.rosterSig = sig;
    const live = rows.filter((r) => r.p !== "gone").length + (dev ? 1 : 0);
    // Cascade only when the roster grew (an agent joined) or first populated, never on a
    // minor in-place update, so the list does not re-animate on every pending tick.
    const grew = live > this.rosterLive;
    this.rosterLive = live;
    const realList = rows.map(({ s, p }) => rosterRow(s, p)).join("");
    const list = dev
      ? devRosterRow() + realList
      : realList || '<div class="empty">No agents connected.</div>';
    el.innerHTML = `<button class="disclosure roster-toggle" type="button" data-roster-toggle aria-expanded="${this.rosterOpen}"><span class="chev">${chevronDown}</span>Connected agents<span class="roster-count count-badge">${live}</span></button><div class="roster-fold"><div class="roster-fold-inner"><div class="roster-list">${list}</div></div></div>`;
    // Stagger index for the unfold cascade, set here so the row markup (and its test)
    // stays free of presentation state.
    const rowEls = [...el.querySelectorAll<HTMLElement>(".roster-row")];
    rowEls.forEach((r, i) => {
      r.style.setProperty("--i", String(i));
    });
    if (this.rosterOpen && grew) {
      for (const r of rowEls) {
        r.classList.add("play");
      }
    }
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
    // Skip a proposal already past its TTL (re-adopted from /inflight right after a
    // reload, before the broker swept it) so it never flashes at 0:00 then vanishes.
    if (proposal.expiresAt - Date.now() <= 0) {
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
    const settings = this.settingsStore.get();
    // schemaAnnotation off skips the fetch entirely; re-enabling re-runs this.
    if (!settings.schemaAnnotation) {
      card.schema = null;
      this.renderCardSchema(card);
      return;
    }
    const schema = await this.annotator.schemaFor(card.sql);
    // A mid-fetch connection switch yields undefined; leave the prior annotation
    // rather than blanking a card whose columns simply could not be resolved.
    if (schema === undefined) {
      return;
    }
    card.schema = filterSchema(schema, settings);
    this.renderCardSchema(card);
  }

  private async renew(): Promise<void> {
    for (const card of [...this.cards]) {
      // Dev cards hold no broker lease; their countdown is purely local.
      if (card.dev) {
        continue;
      }
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
        this.finish(card.id, "expired", "expired");
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

  // Definitely-unwritable: a read-only Beekeeper connection or a replica endpoint. A
  // write/destructive card is blocked-by-connection when a mode is armed but this holds.
  private connectionReadOnly(): boolean {
    return (this.conn?.readOnly ?? false) || this.endpointRO?.replica === true;
  }

  private renderQueue(): void {
    const count = this.root.querySelector<HTMLSpanElement>("#pendingCount");
    if (count) {
      const n = this.cards.length;
      count.textContent = n > 0 ? String(n) : "";
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
      queue.innerHTML = queueHtml(
        this.cards,
        this.dialect,
        this.denyDrafts,
        this.mode,
        this.connectionReadOnly(),
      );
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
      // A write/destructive card lists its tables in the risk annotation, so drop the
      // duplicate reads line here; the sensitive-column flags still render.
      const cls = card.dev ? "read" : classifyQuery(card.sql, this.dialect).class;
      el.innerHTML = schemaInner(card.schema, cls !== "read");
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

  private async approve(id: string, confirmed = false): Promise<void> {
    // Developer-mode cards resolve locally and never reach the broker safety core;
    // branch before any connection/lease work so the two paths cannot entangle.
    const devCard = this.cards.find((c) => c.id === id && c.dev);
    if (devCard) {
      await this.approveDev(devCard);
      return;
    }
    // Catch a switch since the last throttled poll before touching the database.
    await this.checkConnection();
    const card = this.cards.find((c) => c.id === id);
    if (card?.state !== "ready") {
      return;
    }
    const gen = this.connGeneration;
    // SAFETY-CRITICAL: the real gate. Never run a statement the armed mode cannot
    // approve, nor a blocked (multi-statement, unparseable) one.
    const verdict = classifyQuery(card.sql, this.dialect);
    if (verdict.blocked || rank(verdict.class) > modeRank(this.mode)) {
      await this.postResult(card, {
        status: "rejected",
        reason: this.modeBlockReason(verdict.blocked, verdict.class),
      });
      this.finish(id, "failed", "blocked");
      return;
    }
    // Second gate: an opt-out double-confirmation before a write or destructive runs.
    // Reads never prompt. The confirm re-enters approve() with confirmed=true, which
    // re-runs every check above (connection, lease, mode) against live state.
    if (!confirmed && verdict.class !== "read" && this.settingsStore.get().confirmWrites) {
      const destructive = verdict.class === "destructive";
      this.confirmModal.open({
        tone: destructive ? "destructive" : "write",
        heading: destructive ? "Run this destructive statement?" : "Run this write?",
        body: destructive
          ? "This deletes or drops data on the live database the moment you confirm, and Gatekeeper cannot undo it."
          : "This changes data on the live database the moment you confirm.",
        sql: card.sql,
        confirmLabel: destructive ? "Run destructive" : "Run write",
        onConfirm: () => void this.approve(id, true),
      });
      return;
    }
    this.setCardState(id, "executing");
    // If the broker refuses the executing transition (the request was cancelled,
    // or the lease was lost), do not run the query: its result could never be
    // delivered, and the human approval no longer maps to a live proposal.
    if (!(await this.postExecuting(card))) {
      this.finish(id, "failed", "lease lost");
      return;
    }
    // Final anti-race guard: the connection poll is throttled, so a switch during the
    // postExecuting round-trip could go unseen; re-read live before touching the DB.
    await this.checkConnection();
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
      this.finish(
        id,
        "approved",
        `${rows.length} rows`,
        capResult(rows, fields, resultBudgetBytes(this.settingsStore.get())),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.postResult(card, { status: "approved", error: message });
      this.finish(id, "failed", "query failed", undefined, message);
    }
  }

  private async reject(id: string, reason?: string): Promise<void> {
    // Dev cards (plain reject or request-changes) resolve locally, no broker.
    const devCard = this.cards.find((c) => c.id === id && c.dev);
    if (devCard) {
      this.rejectDev(devCard, reason);
      return;
    }
    const card = this.cards.find((c) => c.id === id);
    if (card?.state !== "ready") {
      return;
    }
    // The deny-with-reason form passes the human note here; it goes to the agent
    // and is reflected back into the history row. Empty falls back to the defaults.
    const custom = reason?.trim();
    this.setCardState(id, "rejecting");
    await this.postResult(card, { status: "rejected", reason: custom || "Rejected by user." });
    this.finish(id, "rejected", "declined", undefined, custom || undefined);
  }

  // Local dev resolve: run the neutral SELECT once through the host runQuery, then
  // commit to history via finish() (broker-free). No executing/result/renew ever
  // fires, so a dev card leaves no trace on the server, roster, or audit trail.
  private async approveDev(card: Card): Promise<void> {
    if (card.state !== "ready") {
      return;
    }
    // The read-only guarantee holds even for synthetic cards: never run a non-SELECT.
    if (!isReadOnlyQuery(card.sql, this.dialect)) {
      this.finish(card.id, "failed", "blocked");
      return;
    }
    this.setCardState(card.id, "executing");
    try {
      const { rows, fields } = await runApprovedQuery(card.sql);
      this.finish(
        card.id,
        "approved",
        `${rows.length} rows`,
        capResult(rows, fields, resultBudgetBytes(this.settingsStore.get())),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.finish(card.id, "failed", "query failed", undefined, message);
    }
  }

  private rejectDev(card: Card, reason?: string): void {
    if (card.state !== "ready") {
      return;
    }
    const custom = reason?.trim();
    this.finish(card.id, "rejected", "declined", undefined, custom || undefined);
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
    actions.outerHTML = readyActions(id, this.gateFor(card), this.denyDrafts);
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
    actions.outerHTML = readyActions(id, this.gateFor(card), this.denyDrafts);
    this.root.querySelector<HTMLButtonElement>(`[data-card="${id}"] .deny-open`)?.focus();
  }

  // The armed-mode verdict for one card, matching what the queue renders; dev cards
  // stay on the plain read path.
  private gateFor(card: Card): CardGate {
    return card.dev
      ? { cls: "read", approveEnabled: true, approveLabel: "Approve", note: "" }
      : cardGate(card.sql, this.dialect, this.mode, this.connectionReadOnly());
  }

  private modeBlockReason(blocked: boolean, cls: RiskClass): string {
    if (blocked) {
      return "Blocked: only a single, parseable statement can be approved.";
    }
    return cls === "destructive"
      ? "Blocked: destructive mode is not armed."
      : "Blocked: write mode is not armed.";
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
    status: "approved" | "rejected" | "failed" | "expired",
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
      if (this.history.length > this.settingsStore.get().recentlyResolved) {
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

  // Retain the newest results within the configured byte budget; older items keep
  // their row and SQL but shed their rows so memory stays bounded.
  private enforceHistoryBudget(): void {
    const budget = resultBudgetBytes(this.settingsStore.get());
    let total = 0;
    for (const item of this.history) {
      if (!item.result || item.result.rows.length === 0) {
        continue;
      }
      const size = item.result.bytes ?? JSON.stringify(item.result.rows).length;
      if (total + size > budget) {
        item.result = { ...item.result, rows: [], truncated: true, bytes: 0 };
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
