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
import type {
  AutoEvaluation,
  AutoHold,
  BuildIdentity,
  SensitivityRecord,
} from "@gatekeeper/shared";
import { enter, type Loop, pulse, reveal } from "./anim";
import { SchemaAnnotator } from "./annotate";
import { capitalize, clock, countsLabel, escapeHtml, relAge } from "./html";
import {
  agentBadge,
  alertTriangleIcon,
  botIcon,
  botOffIcon,
  checkIcon,
  chevronLeft,
  copyIcon,
  externalLinkIcon,
  gearIcon,
  historyIcon,
  keyIcon,
  pencilIcon,
  schemaIcon,
  shieldCheckIcon,
  shieldQuestionIcon,
  terminalIcon,
  warnIcon,
  xIcon,
} from "./icons";
import { BrokerClient } from "./net/broker";
import { connectionScopeKey } from "./net/scope";
import { SingleInstance, type SingleInstanceWire } from "./net/singleinstance";
import { overlayScroll } from "./overlay-scroll";
import { agentLinkAge, agentLinkLabel, agentLinkStatusHtml } from "./render/agentlink";
import { AUTO_APPROVED, autoIcon, autoPopHtml, SAVED_KEY_MASK } from "./render/auto";
import { refusalReason } from "./render/autoreasons";
import { ConfirmModal } from "./render/confirm";
import { connChipInner } from "./render/connchip";
import { modeDropdown, switchInput } from "./render/controls";
import { type DbCheck, dbLink, dbLinkLabel, dbStatusHtml, nextCheckText } from "./render/dblink";
import { CANCELLED_NOTE, NOT_DELIVERED_NOTE } from "./render/detail";
import {
  agentsStripHtml,
  auditItem,
  groupHeadHtml,
  paneEmptyHtml,
  queueRowHtml,
  recentRowHtml,
} from "./render/inbox";
import {
  accessMatrix,
  autoNote,
  type CardGate,
  cardGateFor,
  cardHtml,
  LONG_RUN_MS,
  paintLegend,
  readyActions,
} from "./render/queue";
import { type LayerState, readOnlyView } from "./render/readonly";
import { presence } from "./render/roster";
import {
  UPDATE_SKILL_URL,
  updatePrompt,
  versionDockHtml,
  versionDockTitle,
  versionGroupHtml,
} from "./render/version";
import { capResult, type Field, type HistResult } from "./result";
import { collectSchema } from "./schema-collect";
import { filterSchema, resultBudgetBytes, type Settings, SettingsStore } from "./settings";
import { AUTO_KEY, currentEvaluation, validEvaluation } from "./sql/auto";
import { classifyQuery, type RiskClass, rank } from "./sql/classify";
import { formatSql } from "./sql/format";
import { highlight } from "./sql/highlight";
import { modeRank, type RiskMode } from "./sql/mode";
import { mapDialect } from "./sql/readonly";
import { type EndpointReadOnly, hasProbe, probeReadOnly, runErrorText } from "./sql/readonly-probe";
import { sensitivityOf, textSchema } from "./sql/schema";
import {
  newStopToken,
  readStop,
  type StopEngine,
  type StopOutcome,
  stopNote,
  stopStatement,
  stopTag,
  stopUnavailable,
} from "./sql/stop";
import type {
  Card,
  CardState,
  ConnectionState,
  HistItem,
  Presence,
  Proposal,
  RequestState,
  RunState,
  SessionRoster,
} from "./types";
import {
  fetchLatestRelease,
  parseServerIdentity,
  SERVER_IDENTITY_HEADER,
  type VersionStatus,
  versionStatus,
} from "./version";
import { ActivityView } from "./views/activity";
import { DetailView } from "./views/detail";
import { SettingsView } from "./views/settings";

const BROKER_URL = "http://localhost:9999";
const POLL_MS = 1000;
const RENEW_MS = 15_000;
const TICK_MS = 1000;
// A query that started but is not in the database's activity yet gets a few ticks to appear.
const STOP_ATTEMPTS = 5;
const STOP_RETRY_MS = 10_000;
// Auto mode starts no new evaluation while this many automatic reads run. Beekeeper's default
// PostgreSQL pool holds 8 connections; this leaves room for Stop and the operator's own tabs,
// without reserving any.
const AUTO_RUNS_MAX = 3;
const CONN_CHECK_MS = 5000;
// Printable ASCII only, so a pasted key can never smuggle whitespace or control bytes.
const API_KEY_FORMAT = /^[\x21-\x7e]{1,4096}$/;
// What the human typed, or "" while the field still shows the saved-key mask.
const typedKey = (input?: HTMLInputElement | null): string => {
  const value = input?.value.trim() ?? "";
  return value.includes(SAVED_KEY_MASK[0]) ? "" : value;
};
// Re-touch the reported schema this often so it stays inside the server's TTL while the tab
// is active with schema access on; when the tab stops, the snapshot expires and is dropped.
const SCHEMA_HEARTBEAT_MS = 60_000;
// Coalesce a burst of DDL (tablesChanged) notifications into a single re-collection.
const SCHEMA_DEBOUNCE_MS = 2000;
const TOKEN_KEY = "gatekeeper.token";
const ROSTER_POLL_MS = 2000;
// The human starts their agent while looking at the no-broker screen, so re-probe
// on this cadence and move them on to pairing by themselves.
const PROBE_MS = 3000;
// One scalar endpoint check on the user's database, possibly prod, while the tab is visible.
// The operator's bound: a dropped connection must show within about 15 s.
const CHECK_MS = 15_000;

// The read-only layer help sentences, revealed by each row's "?" affordance. Each says where
// the layer sits between this plugin and the database, then what makes it read-only; the
// badge beside it gives the live state, so the text never changes with the mode.
const HELP_GATEKEEPER =
  "This plugin's approval gate, before Beekeeper. In Read-only or Auto mode it lets only reads through.";
const HELP_BEEKEEPER =
  "The saved connection in Beekeeper, between this plugin and the database. With its read-only mode on, it blocks every write.";
const HELP_ENDPOINT =
  "The database server at the end of the connection. A read replica or a read-only server rejects every write.";

// The badge says on or off only in colour and shape, so the button's name carries it too.
function schemaAccessLabel(on: boolean): string {
  return `Schema access is ${on ? "on" : "off"}`;
}

const PRESENCE_ORDER: Record<Presence, number> = { active: 0, idle: 1, gone: 2 };

type InboxTab = "queue" | "audit";
// A card while it waits, a local result once decided (same id), or an Audit Trail entry, kept
// with the item it showed so the pane survives the feed being fetched again.
interface Selection {
  kind: "card" | "hist" | "audit";
  id: string;
  item?: HistItem;
}

// The host sends affectedRows on every result (Beekeeper >= 5.4) but the SDK type does not
// declare it, so read it defensively: an absent count must stay absent rather than become a
// fabricated zero the agent would read as "changed nothing".
function affectedRowsOf(result: unknown): number | undefined {
  const value = (result as { affectedRows?: unknown } | undefined)?.affectedRows;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function runApprovedQuery(
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; fields: Field[]; affectedRows?: number }> {
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
    affectedRows: affectedRowsOf(first),
  };
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

const REPO_URL = "https://github.com/Gldywn/gatekeeper";
const ISSUES_URL = `${REPO_URL}/issues/new/choose`;
const RELEASES_URL = `${REPO_URL}/releases`;
const STARRED_KEY = "gatekeeper.starred";

// The rows forwarded to the agent are capped independently of the local history budget:
// a bulk read must never flood the agent context (and the LLM provider) or overrun the
// broker's body limit. The true count still reaches the agent via rowCount + truncated.
const AGENT_MAX_ROWS = 10_000;
const AGENT_MAX_BYTES = 8 * 1024 * 1024;

// Officially tested engines; every other Beekeeper database type gets the untested notice.
const DB_SUPPORTED = new Set(["postgresql", "mysql"]);
const DB_NAMES: Record<string, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlserver: "SQL Server",
  sqlite: "SQLite",
  oracle: "Oracle",
  cassandra: "Cassandra",
  bigquery: "BigQuery",
  redshift: "Redshift",
  cockroachdb: "CockroachDB",
  duckdb: "DuckDB",
  libsql: "libSQL",
};
function dbDisplayName(type: string): string {
  return DB_NAMES[type] ?? (type ? type[0].toUpperCase() + type.slice(1) : "this database");
}
function dbNoticeKey(type: string): string {
  return `gatekeeper.dbnotice.${type}`;
}

const githubMark =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
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
  private autoEnabled = false;
  private autoGeneration = 0;
  private autoKey = "";
  private autoBusy = false;
  // Automatic executions still running. Never reset: each run decrements its own count when
  // it settles, even after a switch or a disable.
  private autoRuns = 0;
  private autoAbort?: AbortController;
  private autoCard?: Card;
  // Proposals already waiting when Auto mode was switched on. Enabling delegates the
  // approvals to come, never the ones a human may already be weighing up.
  private autoDeferred = new Set<string>();
  private keySaveTimer?: number;
  // Only whether a key exists, so Settings can show it is set without the key itself.
  private keySaved = false;
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
    getMetadata: async (sql) => {
      const result = await runQuery(sql);
      if (result.error) throw new Error("Metadata unavailable");
      return result.results[0]?.rows ?? [];
    },
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
  private stripObserver?: ResizeObserver;
  private overlayScrolls: (() => void)[] = [];
  // The Inbox: which list the left pane shows, and what each list has open on the right. Each
  // list keeps its own selection, so coming back to a tab finds what was open there. Nothing
  // is ever selected for the human: a new or next proposal never lands under the pointer.
  private tab: InboxTab = "queue";
  private readonly selection: Record<InboxTab, Selection | null> = { queue: null, audit: null };
  private polling = false;
  private lastTitle = "";
  private lastConnCheck = 0;
  private connCheckInFlight = false;
  private connGeneration = 0;
  // Host-side endpoint check, reset per connection. endpointRO is the last verdict a passed
  // check confirmed (null: none yet); a later failure keeps it and only adds to the count.
  private endpointRO: EndpointReadOnly | null = null;
  // PostgreSQL 10+ and MySQL 8.0.19+ only can be stopped, see sql/stop.ts. Read once per
  // connection by the endpoint check and reset with it (resetCheck); a failed or dropped
  // re-check keeps it, so a schema change never blanks it.
  private serverVersion: string | null = null;
  private checkedAt = 0;
  private nextCheckAt = 0;
  private checkFailures = 0;
  private checkError: string | null = null;
  // Owned by the host call itself and released only when it settles, never by a reset, so a
  // connection switch can never stack a second check on a hung one.
  private checkInFlight = false;
  // What the header chip and its two popover parts last rendered (see renderConnLabel).
  private connEl: Element | null = null;
  private connHtml = "";
  private statusHtml = "";
  private layersHtml = "";
  private renewTimer?: number;
  private tickTimer?: number;
  private schemaTimer?: number;
  private schemaReportTimer?: number;
  private schemaReportSeq = 0;
  private pollTimer?: number;
  private probeTimer?: number;
  private pollFailures = 0;
  private pollGeneration = 0;
  private single?: SingleInstance;
  private wiredNotifications = false;
  private starred = false;
  // Bumped on every activate/deactivate so an async activate() that was overtaken by a
  // demotion bails before it starts polling (a standby must never touch the broker).
  private activeGen = 0;
  private connectionState: ConnectionState = "connecting";
  // The last 2xx from the broker, 0 before the first one.
  private brokerAnsweredAt = 0;
  // The raw X-Gatekeeper-Server value last seen: undefined until the broker first answers
  // (the corner indicator stays hidden), null once it is missing or the broker is gone.
  private serverHeader: string | null | undefined = undefined;
  private serverIdentity: BuildIdentity | null = null;
  private latestRelease: string | null = null;
  private latestChecked = false;
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
      dialect: () => this.dialect,
    });
    this.activityView = new ActivityView({
      root,
      broker: this.broker,
      connectionName: () => this.connectionName,
      scope: () => this.connScopeKey(),
      dialect: () => this.dialect,
      selected: () => this.selection.audit?.id ?? null,
    });
    this.settingsView = new SettingsView({
      root,
      settings: () => this.settingsStore.get(),
      mode: () => this.mode,
      auto: () => this.autoEnabled,
      keySaved: () => this.keySaved,
      version: () => versionGroupHtml(this.versionStatus()),
    });
    root.addEventListener("click", (e) => {
      // The confirm overlay is rebuilt on every open, so its copy button delegates off
      // the root like the modal's own actions. Copying leaves the dialog as it is.
      const copyInConfirm = (e.target as HTMLElement).closest<HTMLElement>(
        "#confirm [data-copy-sql]",
      );
      if (copyInConfirm) {
        this.copySql(copyInConfirm);
        return;
      }
      if ((e.target as HTMLElement).closest("[data-auto-settings]")) {
        this.openAutoSettings();
        return;
      }
      const toggle = (e.target as HTMLElement).closest<HTMLButtonElement | HTMLInputElement>(
        "[data-auto-toggle]",
      );
      if (toggle) void this.toggleAuto(toggle);
    });
    // The mask is not editable text: focusing clears it for a paste, leaving empty restores it.
    root.addEventListener("focusin", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-auto-key]");
      if (input?.value === SAVED_KEY_MASK) input.value = "";
    });
    root.addEventListener("focusout", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-auto-key]");
      if (input && !input.value && this.keySaved) input.value = SAVED_KEY_MASK;
    });
    root.addEventListener("input", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-auto-key]");
      if (!input) return;
      window.clearTimeout(this.keySaveTimer);
      this.keySaveTimer = window.setTimeout(() => void this.saveAutoKey(input), 400);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // The arm/confirm modal sits on top of everything; it swallows the first
        // Escape (cancelling) before any overlay beneath it can close.
        if (this.confirmModal.cancel()) {
          return;
        }
        // An open mode or flyout menu swallows the first Escape so it dismisses without
        // also tearing down the overlay or popover it sits inside.
        if (
          this.closeModeMenus() ||
          this.closeFlyoutMenus() ||
          this.dismissAgentPop() ||
          this.dismissLegendPop() ||
          this.setAgentsPopOpen(false)
        ) {
          return;
        }
        // Then one layer per press: Settings, the settings popover, and in a narrow tab the
        // list behind an open item. The database notice stays until its own buttons.
        const settings = this.root.querySelector<HTMLElement>("#settings");
        if (settings && !settings.hidden) {
          this.settingsView.close();
          return;
        }
        const pop = this.root.querySelector<HTMLElement>("#settingsPop");
        if (pop && !pop.hidden) {
          this.setSettingsOpen(false);
          return;
        }
        if (!this.root.querySelector<HTMLElement>("#notice")?.hidden) {
          return;
        }
        const list = this.root.querySelector<HTMLElement>(".pane-list");
        if (this.root.querySelector('#inbox[data-show="detail"]') && list?.offsetParent === null) {
          this.showList();
        }
      }
    });
    document.addEventListener("mouseover", (e) => this.enterPopGlyph(e));
    document.addEventListener("focusin", (e) => this.enterPopGlyph(e));
    // The agents list folded behind "+N more" closes on any click outside it.
    document.addEventListener("click", (e) => {
      const target = e.target as Element;
      if (!target.closest("#agentsPop, [data-agents-more]")) this.setAgentsPopOpen(false);
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
    try {
      this.keySaved = Boolean(await appStorage.getItem<string>(AUTO_KEY, { encrypted: true }));
    } catch {
      this.keySaved = false;
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
    void this.checkLatestRelease();
    this.token = await this.broker.loadToken();
    try {
      const connection = await getConnectionInfo();
      if (gen !== this.activeGen) return;
      this.applyConnection(connection);
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
      await this.renderUnpaired();
      return;
    }
    await this.settingsStore.load(this.connectionName);
    if (gen !== this.activeGen) {
      return;
    }
    // A promotion may land on another connection than the last one this tab checked.
    this.resetCheck();
    this.renderShell();
    // The schema annotation caches columns per table; a DDL change invalidates it.
    if (!this.wiredNotifications) {
      this.wiredNotifications = true;
      addNotificationListener("tablesChanged", () => {
        this.resetAuto("Schema changed. Enable Auto mode again after review");
        this.applyMode("read");
        this.connGeneration++;
        this.annotator.clearCache();
        this.scheduleSchemaReport();
      });
    }
    this.polling = true;
    void this.loadInflight();
    void this.poll();
    void this.pollRoster(++this.pollGeneration);
    void this.reportConnection();
    void this.reportSchema();
    this.startTimers();
    this.maybeCheckEndpoint();
    void this.maybeShowDbNotice();
  }

  // Lost the election (another tab owns the slot): stop every broker-touching loop and
  // show the inert standby screen. A later promotion re-runs activate().
  private deactivate(): void {
    this.resetAuto("Tab ownership changed");
    this.mode = "read";
    this.connGeneration++;
    this.cards.length = 0;
    this.history.length = 0;
    this.annotator.clearCache();
    this.activeGen++;
    this.polling = false;
    this.pollGeneration++;
    // Another tab may own a different broker by the time this one is promoted again.
    this.serverHeader = undefined;
    this.serverIdentity = null;
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
    if (this.schemaTimer !== undefined) {
      window.clearInterval(this.schemaTimer);
      this.schemaTimer = undefined;
    }
    if (this.schemaReportTimer !== undefined) {
      window.clearTimeout(this.schemaReportTimer);
      this.schemaReportTimer = undefined;
    }
    for (const loop of this.rosterLoops) {
      loop.stop();
    }
    this.rosterLoops = [];
    this.breatheLoop?.stop();
    this.breatheLoop = undefined;
    this.rosterSig = "";
    this.resetInbox();
    this.stopProbe();
    this.renderStandby();
  }

  private renderStandby(): void {
    this.releaseOverlayScrolls();
    this.root.innerHTML = `
      <div class="standby">
        <div class="standby-card">
          <span class="standby-ico">${copyIcon}</span>
          <h1>Open in another tab</h1>
          <p>Only one tab can approve at a time, so two tabs never race an approval. This tab is inactive.</p>
          <button class="btn approve" id="takeover" type="button">Use Gatekeeper here</button>
        </div>
      </div>`;
    this.root
      .querySelector<HTMLButtonElement>("#takeover")
      ?.addEventListener("click", () => this.single?.takeOver());
  }

  // Which unpaired screen to show depends on whether a broker answers at all: with
  // none, a pairing field is a dead end, since the code it wants only exists once
  // the server has run.
  private async renderUnpaired(errorMessage = ""): Promise<void> {
    const gen = this.activeGen;
    const alive = await this.broker.probe();
    if (gen !== this.activeGen) {
      return;
    }
    if (alive) {
      this.renderPairing(errorMessage);
    } else {
      this.renderNoBroker();
    }
  }

  private renderNoBroker(): void {
    this.releaseOverlayScrolls();
    this.stopProbe();
    this.root.innerHTML = `
      <div class="standby">
        <div class="standby-card">
          <span class="standby-ico">${terminalIcon}</span>
          <h1>Start your agent once</h1>
          <p>A running Gatekeeper MCP server is required to pair this tab.
            Start the agent you configured it in (Claude Code, Codex, ...) and this screen moves on by itself.</p>
          <button class="btn approve" id="recheck" type="button">Check again</button>
        </div>
      </div>`;
    this.root
      .querySelector<HTMLButtonElement>("#recheck")
      ?.addEventListener("click", () => void this.renderUnpaired());
    this.probeTimer = window.setTimeout(() => void this.renderUnpaired(), PROBE_MS);
  }

  private stopProbe(): void {
    if (this.probeTimer !== undefined) {
      window.clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }
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

  // Show the "not officially tested" notice on every connection to an untested engine, unless
  // the human dismissed it for that engine with "Don't show this again".
  private async maybeShowDbNotice(): Promise<void> {
    const type = this.conn?.databaseType ?? "";
    if (!type || DB_SUPPORTED.has(type)) {
      return;
    }
    let hushed = false;
    try {
      hushed = (await appStorage.getItem<boolean>(dbNoticeKey(type))) === true;
    } catch {
      hushed = false;
    }
    // A connection switch during the async read may have changed the engine; re-check.
    if (hushed || this.conn?.databaseType !== type) {
      return;
    }
    const overlay = this.root.querySelector<HTMLElement>("#notice");
    if (overlay) {
      overlay.innerHTML = this.dbNoticeHtml(type);
      overlay.hidden = false;
    }
  }

  private hideDbNotice(): void {
    const overlay = this.root.querySelector<HTMLElement>("#notice");
    if (overlay) {
      overlay.hidden = true;
      overlay.innerHTML = "";
    }
  }

  private dbNoticeHtml(type: string): string {
    const name = escapeHtml(dbDisplayName(type));
    return `<div class="detail-card db-notice">
        <h2 class="dbn-title"><span class="dbn-ico">${alertTriangleIcon}</span>Not officially tested with ${name} yet</h2>
        <p class="dbn-body">SQL execution uses Beekeeper Studio's database APIs. PostgreSQL and MySQL are officially tested so far. Support for ${name} has not been verified end to end.</p>
        <div class="dbn-enc">
          <div class="dbn-h">Help make ${name} official</div>
          <p class="dbn-p">This project is open source. If you run it on ${name} and can help put it through its paces, even a short set of test notes or a small fix is enough for us to move it onto the officially supported list, for you and everyone who comes after. Contributions are genuinely welcome.</p>
          <div class="dbn-foot">
            <button class="dbn-gh" type="button" data-notice-contribute>${githubMark}Contribute on GitHub</button>
          </div>
        </div>
        <div class="dbn-actions">
          <span class="dbn-link" data-notice-hush>Don't show this again</span>
          <button class="dbn-go" type="button" data-notice-continue>Continue</button>
        </div>
      </div>`;
  }

  // Re-adopt the proposals still leased to this plugin so a reopened tab shows them
  // at once; renew right away so a near-expiry lease does not lapse before the timer.
  private async loadInflight(): Promise<void> {
    try {
      const gen = this.connGeneration;
      const active = this.activeGen;
      const inflight = await this.broker.inflight(this.connScopeKey());
      if (inflight === null) {
        return;
      }
      // A connection switch mid-fetch means these belong to the old database.
      if (gen !== this.connGeneration || active !== this.activeGen) {
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

  private async checkConnection(): Promise<boolean> {
    const generation = this.connGeneration;
    const active = this.activeGen;
    let conn: ConnectionInfo;
    try {
      conn = await getConnectionInfo();
    } catch {
      return false;
    }
    if (generation !== this.connGeneration || active !== this.activeGen) return false;
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
    if (
      this.conn?.id === conn.id &&
      this.connScopeKey() === nextKey &&
      this.conn.schema === (conn.defaultSchema ?? null)
    ) {
      const flipped = this.conn.readOnly !== conn.readOnlyMode;
      this.applyConnection(conn);
      // Beekeeper's own read-only switch is not an identity change, but the layers, the card
      // gates and the agent's snapshot all read it.
      if (flipped) {
        this.renderConnLabel();
        this.renderQueue();
        void this.reportConnection();
      }
      return true;
    }
    this.applyConnection(conn);
    this.onConnectionSwitch();
    return false;
  }

  private onConnectionSwitch(): void {
    this.resetAuto("Connection changed");
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
    // History, activity, roster and what the Inbox shows are connection-scoped; reset so the
    // old one cannot leak in. The roster re-fetches on its own timer, and an open Audit Trail
    // reloads for the new connection.
    this.history.length = 0;
    this.resetInbox();
    if (this.tab === "audit") void this.activityView.open();
    this.roster = [];
    this.rosterSig = "";
    // The endpoint belongs to the old database; check the new one from scratch.
    this.resetCheck();
    // Settings are per connection; the overlay now shows a different scope, so close
    // it and reload (which re-syncs the quick-menu switches and the activity trigger).
    this.settingsView.close();
    this.hideDbNotice();
    this.renderConnLabel();
    this.renderModeSurfaces();
    void this.reportConnection();
    this.maybeCheckEndpoint();
    // Load the NEW connection's settings before reporting its schema, so schema access is
    // read from the connection the human is now on, never from the previous one's consent.
    void (async () => {
      await this.reloadSettings();
      await this.reportSchema();
    })();
    this.renderQueue();
    this.renderHistory();
    this.renderRoster();
    void this.maybeShowDbNotice();
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
    // No schema: a proposal can target any of them, so the session's current schema
    // would describe the connection, not the queries this queue governs.
    return {
      name: c.connectionName || this.connectionName,
      dialect: mapDialect(c.databaseType),
      path: c.databaseName?.trim() ?? "",
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
    el.dataset.link = this.conn ? dbLink(this.dbCheck()) : "";
    // The chip and its glyph are rebuilt only when the identity changes, and each popover
    // part only when its own content does, so a check landing every 15 s never drops the
    // keyboard focus or the hover.
    const chip = data
      ? `${connChipInner(data, true)}<span class="ro-pop" id="connPop" role="tooltip"><div class="db-slot"></div><div class="ro-layers"></div></span>`
      : this.connectionName
        ? escapeHtml(this.connectionName)
        : "";
    if (el !== this.connEl || chip !== this.connHtml) {
      el.innerHTML = chip;
      this.connEl = el;
      this.connHtml = chip;
      this.statusHtml = "";
      this.layersHtml = "";
    }
    const engine = dbDisplayName(this.conn?.databaseType ?? "");
    el.querySelector(".chip-db")?.setAttribute("aria-label", dbLinkLabel(this.dbCheck(), engine));
    const slot = el.querySelector(".db-slot");
    const status = dbStatusHtml(this.dbCheck());
    if (slot && status !== this.statusHtml) {
      slot.innerHTML = status;
      this.statusHtml = status;
    }
    const layers = el.querySelector(".ro-layers");
    const rows = this.layerRows();
    if (layers && rows !== this.layersHtml) {
      const focused = [...layers.querySelectorAll(".ro-help")].indexOf(
        document.activeElement as Element,
      );
      layers.innerHTML = rows;
      this.layersHtml = rows;
      if (focused >= 0) {
        layers.querySelectorAll<HTMLElement>(".ro-help")[focused]?.focus();
      }
    }
    this.renderCheckTimes();
  }

  private dbCheck(): DbCheck {
    return {
      supported: hasProbe(this.conn?.databaseType ?? ""),
      checkedAt: this.checkedAt,
      failures: this.checkFailures,
      error: this.checkError,
    };
  }

  // The popover's lower part, under the last check. The Gatekeeper layer is read-only only
  // while the armed mode is "read".
  private layerRows(): string {
    const view = readOnlyView(this.mode === "read", this.conn?.readOnly ?? false, this.endpointRO);
    return (
      '<div class="ro-pop-head">Read-only layers</div>' +
      this.roRow("Gatekeeper", HELP_GATEKEEPER, view.gatekeeper.label, view.gatekeeper.state) +
      this.roRow("Beekeeper", HELP_BEEKEEPER, view.beekeeper.label, view.beekeeper.state) +
      this.roRow("Endpoint", HELP_ENDPOINT, view.endpoint.label, view.endpoint.state)
    );
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
    const seq = ++this.schemaReportSeq;
    try {
      const payload = on
        ? await collectSchema(name, scope, this.conn.databaseType)
        : { connectionName: name, scope, access: false, tables: [], excludedSchemas: [] };
      // Re-validate after the slow collect: a switch, a toggle flip or a newer report since
      // must not post a wrong-database, unconsented or superseded schema.
      if (
        seq !== this.schemaReportSeq ||
        (this.connScopeKey() ?? "") !== scope ||
        this.settingsStore.get().schemaAccess !== on
      ) {
        return;
      }
      await this.broker.postSchema(payload);
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }

  // A big schema re-collects with many host round-trips, so under DDL churn debounce it: one
  // re-collection after the burst settles, not one per tablesChanged.
  private scheduleSchemaReport(): void {
    if (this.schemaReportTimer !== undefined) {
      window.clearTimeout(this.schemaReportTimer);
    }
    this.schemaReportTimer = window.setTimeout(() => void this.reportSchema(), SCHEMA_DEBOUNCE_MS);
  }

  // Leaves checkInFlight alone: a call still pending belongs to the old connection and
  // releases the guard itself when it settles.
  private resetCheck(): void {
    this.endpointRO = null;
    this.serverVersion = null;
    this.checkedAt = 0;
    this.nextCheckAt = 0;
    this.checkFailures = 0;
    this.checkError = null;
  }

  // A Gatekeeper tab behind another Beekeeper tab still has a visible document (it follows
  // the window); a hidden iframe is expected to have no viewport, so size gates it too.
  private checkEligible(): boolean {
    return (
      this.polling &&
      Boolean(this.token) &&
      document.visibilityState === "visible" &&
      window.innerHeight > 0
    );
  }

  private maybeCheckEndpoint(): void {
    if (
      this.checkInFlight ||
      Date.now() < this.nextCheckAt ||
      !this.checkEligible() ||
      !hasProbe(this.conn?.databaseType ?? "")
    ) {
      return;
    }
    void this.checkEndpoint();
  }

  // Runs via runQuery directly (host-side, not the approval gate); the outcome stays on the
  // class, never posted to the broker. A result for an older connection or tab ownership is
  // dropped and leaves the check due, so the next tick runs it for the current one.
  private async checkEndpoint(): Promise<void> {
    const gen = this.connGeneration;
    const active = this.activeGen;
    this.checkInFlight = true;
    let outcome: Awaited<ReturnType<typeof probeReadOnly>> = null;
    try {
      // runQuery takes no connection id and the 5 s refresh may not have seen a switch yet:
      // re-read the connection first so the probe's SQL fits the engine it lands on.
      if (!(await this.checkConnection()) || !this.checkEligible()) {
        return;
      }
      outcome = await probeReadOnly(this.conn?.databaseType ?? "", runQuery);
    } finally {
      this.checkInFlight = false;
    }
    if (!outcome || gen !== this.connGeneration || active !== this.activeGen) {
      return;
    }
    this.checkedAt = Date.now();
    this.nextCheckAt = this.checkedAt + CHECK_MS;
    if ("error" in outcome) {
      this.checkFailures++;
      this.checkError = outcome.error;
    } else {
      const wasReadOnly = this.connectionReadOnly();
      this.checkFailures = 0;
      this.checkError = null;
      this.endpointRO = outcome.readOnly;
      if (outcome.version) this.serverVersion = outcome.version;
      // A failover can turn a replica into a primary or back, which moves the card gates.
      if (this.connectionReadOnly() !== wasReadOnly) {
        this.renderQueue();
      }
    }
    this.renderConnLabel();
  }

  private renderCheckTimes(): void {
    const age = this.root.querySelector<HTMLElement>("#conn .db-age");
    if (age) {
      age.textContent = relAge(this.checkedAt);
    }
    const next = this.root.querySelector<HTMLElement>("#conn .db-next");
    if (next) {
      next.textContent = nextCheckText(this.nextCheckAt, Date.now());
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
    if (this.schemaTimer !== undefined) {
      window.clearInterval(this.schemaTimer);
    }
    this.renewTimer = window.setInterval(() => void this.renew(), RENEW_MS);
    this.tickTimer = window.setInterval(() => this.tick(), TICK_MS);
    this.schemaTimer = window.setInterval(() => {
      if (this.settingsStore.get().schemaAccess) {
        void this.broker.touchSchema();
      }
    }, SCHEMA_HEARTBEAT_MS);
  }

  private renderPairing(errorMessage = ""): void {
    this.releaseOverlayScrolls();
    this.stopProbe();
    this.resetInbox();
    this.root.innerHTML = `
      <div class="standby">
        <div class="standby-card">
          <span class="standby-ico">${keyIcon}</span>
          <h1>Enter the pairing code</h1>
          <p>Your agent shows a 6-digit code the first time it reaches for Gatekeeper. Type it here to
            connect this tab to it.</p>
          <div class="pair-row">
            <input id="code" type="text" inputmode="numeric" maxlength="6" placeholder="000000"
              autocomplete="one-time-code" spellcheck="false" aria-label="Pairing code" />
            <button class="btn approve" id="pair-btn" type="button">Pair</button>
          </div>
          <div class="err">${escapeHtml(errorMessage)}</div>
          <button class="pair-link" id="pair-page" type="button">No code yet? Show me one</button>
        </div>
      </div>`;
    const input = this.root.querySelector<HTMLInputElement>("#code")!;
    const err = this.root.querySelector<HTMLElement>(".err")!;
    const save = async () => {
      const value = input.value.trim();
      if (!value) {
        return;
      }
      const attempt = this.activeGen;
      const outcome = await this.broker.exchange(value);
      if (attempt !== this.activeGen) return;
      if (!outcome.ok) {
        err.textContent = outcome.error;
        input.select();
        return;
      }
      const gen = ++this.activeGen;
      this.resetAuto("Pairing changed");
      // Re-pairing is a fresh session; the armed mode never survives it.
      this.mode = "read";
      this.token = await this.broker.loadToken();
      await this.settingsStore.load(this.connectionName);
      // Demoted while pairing (another tab took the slot): never start polling.
      if (gen !== this.activeGen) {
        return;
      }
      this.polling = true;
      this.resetCheck();
      this.renderShell();
      void this.loadInflight();
      void this.poll();
      void this.pollRoster(++this.pollGeneration);
      void this.reportConnection();
      void this.reportSchema();
      this.startTimers();
      this.maybeCheckEndpoint();
    };
    this.root
      .querySelector<HTMLButtonElement>("#pair-btn")!
      .addEventListener("click", () => void save());
    // The page is served by the broker itself and deliberately carries no CORS headers,
    // so it has to open in a real browser window rather than be fetched from here.
    this.root
      .querySelector<HTMLButtonElement>("#pair-page")!
      .addEventListener("click", () => void openExternal(`${BROKER_URL}/pair`));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        void save();
      }
    });
    input.focus();
  }

  // The header quick menu ("Guards") reflects the live per-connection settings, so it
  // is built here rather than as a static const.
  private headerHtml(): string {
    const s = this.settingsStore.get();
    return `
  <header class="bar">
    <span class="hive-wrap" aria-hidden="true"><span class="hive"></span></span>
    <span class="conn-chip" id="conn"></span>
    <span class="agent-link" id="agentLink">
      <span class="ag-ico" tabindex="0" role="img" aria-describedby="agentPop">${botIcon}${botOffIcon}</span>
      <span class="ro-pop ag-pop" id="agentPop" role="tooltip"><div class="ro-pop-head" aria-hidden="true">Gatekeeper server</div><div class="ag-slot"></div></span>
      <span class="sr-only" id="agentLive" aria-live="polite"></span>
    </span>
    <span class="armed" id="armed"></span>
    <span class="bar-right">
      <span class="sa-hint-wrap auto" id="autoHint" data-on="${this.autoEnabled}">
        <button class="sa-hint" type="button" data-auto-settings aria-label="Auto mode">${autoIcon}<span class="sa-dot"></span><span class="sa-check">${checkIcon}</span></button>
        ${autoPopHtml()}
      </span>
      <span class="sa-hint-wrap" id="schemaHint" data-on="${s.schemaAccess}">
        <button class="sa-hint" type="button" data-schema-settings aria-label="${schemaAccessLabel(s.schemaAccess)}">
          ${schemaIcon}
          <span class="sa-dot"></span>
          <span class="sa-check">${checkIcon}</span>
        </button>
        <span class="sa-pop">
          <span class="sa-body sa-off">
            <span class="sa-pt">${schemaIcon}Schema access</span>
            <p>Without this, agents guess your table and column names. Turn it on so they read the real structure through <code class="tool">get_schema</code> and write sharper queries. <b>No row data is ever exposed.</b></p>
            <button class="sa-enable" type="button" data-schema-toggle>Enable Schema access</button>
          </span>
          <span class="sa-body sa-on">
            <span class="sa-pt">${schemaIcon}Schema access</span>
            <p>Agents now read your tables, columns, types and keys through <code class="tool">get_schema</code>, which is what makes their queries sharper. <b>No row data is ever exposed.</b></p>
            <button class="sa-enable tonal" type="button" data-schema-toggle>Disable Schema access</button>
          </span>
        </span>
      </span>
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

  // The thumbs observe the Inbox's panes; every render that replaces the root lets them go.
  private releaseOverlayScrolls(): void {
    for (const dispose of this.overlayScrolls) dispose();
    this.overlayScrolls = [];
  }

  private renderShell(): void {
    // The fresh markup opens on the Queue with nothing selected, whatever the last shell showed.
    this.tab = "queue";
    this.resetInbox();
    this.stripObserver?.disconnect();
    this.releaseOverlayScrolls();
    this.root.innerHTML = `
      <div class="gk">
        <div class="app-top">
          ${this.headerHtml()}
          <section class="agents-strip" id="roster" aria-label="Connected agents"></section>
        </div>
        <div class="inbox" id="inbox" data-show="list">
          <div class="inbox-panes">
          <section class="pane pane-list" aria-label="Queue and Audit Trail">
            <div class="pane-head">
              <div class="pane-tabs" role="tablist" aria-label="Lists">
                <button class="pane-tab" role="tab" type="button" id="tabQueue" data-tab="queue" aria-selected="true" aria-controls="listQueue">Queue<span class="n" id="queueCount"></span></button>
                <button class="pane-tab" role="tab" type="button" id="tabAudit" data-tab="audit" aria-selected="false" aria-controls="listAudit" tabindex="-1">${historyIcon}Audit Trail</button>
              </div>
              <span class="pane-actions" id="auditActions" hidden></span>
            </div>
            <div class="ov-rail" aria-hidden="true"></div><div class="pane-body" id="listQueue" role="tabpanel" aria-labelledby="tabQueue"></div>
            <div class="ov-rail" aria-hidden="true"></div><div class="pane-body" id="listAudit" role="tabpanel" aria-labelledby="tabAudit" hidden></div>
          </section>
          <section class="pane pane-detail" aria-label="Selected">
            <div class="ov-rail" aria-hidden="true"></div><div class="pane-body" id="detailBody">
              <button class="pane-back" type="button" data-back>${chevronLeft}Back to the list</button>
              <div class="pane-empty-host" id="paneEmpty"></div>
              <div class="queue" id="queue"></div>
              <div class="detail-host" id="detail" hidden></div>
            </div>
          </section>
          </div>
        </div>
        <footer class="status-bar">
          <button class="ver-dock" id="verDock" type="button" hidden></button>
          <div class="cta-cluster" id="ctaCluster">
            <button class="cta-fab star${this.starred ? "" : " twinkle"}" type="button" data-gh-star aria-label="Star Gatekeeper on GitHub">${starGlyph}<span class="cta-lbl">Star on GitHub</span></button>
            <button class="cta-fab fb" type="button" data-gh-feedback aria-label="Request a feature">${feedbackGlyph}<span class="cta-lbl">Request a feature</span></button>
          </div>
        </footer>
        <div class="detail settings-overlay" id="settings" hidden></div>
        <div class="detail confirm-overlay" id="confirm" hidden></div>
        <div class="detail db-notice-overlay" id="notice" hidden></div>
      </div>`;
    this.renderConnLabel();
    this.renderArmed();
    const strip = this.root.querySelector<HTMLElement>("#roster")!;
    strip.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-agents-more]")) {
        const pop = strip.querySelector<HTMLElement>("#agentsPop");
        this.setAgentsPopOpen(Boolean(pop?.hidden));
      }
    });
    // Remeasured on width changes, so the chips that fit follow the tab's size.
    this.stripObserver = new ResizeObserver(() => this.layoutStrip());
    this.stripObserver.observe(strip);
    this.overlayScrolls = [...this.root.querySelectorAll<HTMLElement>(".ov-rail")].map((rail) =>
      overlayScroll(rail.nextElementSibling as HTMLElement, rail),
    );
    const inbox = this.root.querySelector<HTMLElement>("#inbox")!;
    inbox.addEventListener("click", (e) => this.onInboxClick(e));
    inbox.addEventListener("keydown", (e) => this.onInboxKey(e));
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
    this.root.querySelector<HTMLElement>("#schemaHint")?.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-schema-toggle]")) {
        await this.updateSetting("schemaAccess", !this.settingsStore.get().schemaAccess);
        const enabled = this.settingsStore.get().schemaAccess;
        this.root
          .querySelector<HTMLElement>(
            `#schemaHint .${enabled ? "sa-on" : "sa-off"} [data-schema-toggle]`,
          )
          ?.focus();
      } else if (target.closest("[data-schema-settings]")) {
        this.setSettingsOpen(false);
        this.settingsView.open();
        this.root.querySelector<HTMLElement>('#settings [data-setting="schemaAccess"]')?.focus();
      }
    });
    this.root
      .querySelector<HTMLButtonElement>("#verDock")
      ?.addEventListener("click", () => this.openVersionSettings());
    this.renderVersion();
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
        void this.updateSetting(input.dataset.setting!, input.checked);
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
      if (target.closest("[data-releases]")) {
        void openExternal(RELEASES_URL);
        return;
      }
      if (target.closest("[data-skill-link]")) {
        void openExternal(UPDATE_SKILL_URL);
        return;
      }
      const copyPrompt = target.closest<HTMLElement>("[data-copy-prompt]");
      if (copyPrompt) {
        void this.copyUpdatePrompt(copyPrompt);
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
    const notice = this.root.querySelector<HTMLElement>("#notice")!;
    notice.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-notice-contribute]")) {
        void openExternal(REPO_URL);
        return;
      }
      if (target.closest("[data-notice-hush]")) {
        const type = this.conn?.databaseType ?? "";
        if (type) {
          void appStorage.setItem(dbNoticeKey(type), true);
        }
        this.hideDbNotice();
        return;
      }
      if (target.closest("[data-notice-continue]") || target === notice) {
        this.hideDbNotice();
      }
    });
    settings.addEventListener("change", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-setting]");
      if (el instanceof HTMLSelectElement) {
        void this.updateSetting(el.dataset.setting!, Number(el.value));
      } else if (el instanceof HTMLInputElement) {
        void this.updateSetting(el.dataset.setting!, el.checked);
      }
    });
    this.applyTab();
    this.renderQueue();
    this.renderRoster();
    this.renderSelection(true);
    // Rebuilt DOM has a blank glyph; force it back to the initial state (the guard in
    // setConnectionState would otherwise skip writing the new node).
    this.setConnectionState("connecting", true);
    const gk = this.root.querySelector(".gk");
    if (gk) {
      reveal([...gk.children].filter((c) => !(c as HTMLElement).hidden));
    }
  }

  // One delegate for both panes: lists, the selected card's actions, the detail's menus, the
  // Audit Trail's days and exports. Menus and copies come first so a click inside them never
  // also selects a row.
  private onInboxClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const copy = target.closest<HTMLElement>("[data-copy-sql]");
    if (copy) {
      this.copySql(copy);
      return;
    }
    const opt = target.closest<HTMLElement>("[data-flyout-action]");
    if (opt) {
      this.closeFlyoutMenus();
      const fmt = opt.getAttribute("data-flyout-fmt")!;
      const action = opt.getAttribute("data-flyout-action");
      if (opt.closest("#listAudit")) {
        if (action === "export") {
          void this.activityView.exportSession(
            opt.getAttribute("data-flyout-key")!,
            fmt as "md" | "csv" | "json",
          );
        }
      } else if (action === "export") {
        void this.detailView.exportResult(fmt as "csv" | "json");
      } else {
        void this.detailView.copyResult(fmt as "md");
      }
      return;
    }
    const trigger = target.closest<HTMLElement>("[data-flyout-trigger]");
    if (trigger) {
      this.toggleFlyoutMenu(trigger);
      return;
    }
    this.closeFlyoutMenus();
    const tab = target.closest<HTMLElement>("[data-tab]");
    if (tab) {
      this.setTab(tab.dataset.tab as InboxTab);
      return;
    }
    const row = target.closest<HTMLElement>("[data-select]");
    if (row) {
      this.select({ kind: row.dataset.select as Selection["kind"], id: row.dataset.row! });
      return;
    }
    if (target.closest("[data-back]")) {
      this.showList();
      return;
    }
    const dayHead = target.closest<HTMLElement>("[data-day]");
    if (dayHead) {
      this.activityView.toggleDay(dayHead);
      return;
    }
    const monthHead = target.closest<HTMLElement>("[data-month]");
    if (monthHead) {
      this.activityView.toggleMonth(monthHead);
      return;
    }
    if (target.closest("[data-act-retry], [data-act-older]")) {
      void this.activityView.loadOlder();
      return;
    }
    const a = target.closest<HTMLElement>("[data-approve]");
    const r = target.closest<HTMLElement>("[data-reject]");
    const denyOpen = target.closest<HTMLElement>("[data-deny-open]");
    const deny = target.closest<HTMLElement>("[data-deny]");
    const stop = target.closest<HTMLElement>("[data-stop]");
    if (stop) {
      const card = this.cards.find((c) => c.id === stop.getAttribute("data-stop"));
      if (card) this.requestStop(card, "operator");
    } else if (a) {
      void this.approve(a.getAttribute("data-approve")!);
    } else if (r) {
      void this.reject(r.getAttribute("data-reject")!);
    } else if (denyOpen) {
      this.openDeny(denyOpen.getAttribute("data-deny-open")!);
    } else if (deny) {
      this.confirmDeny(deny.getAttribute("data-deny")!);
    }
  }

  private onInboxKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    const input = target.closest<HTMLElement>("[data-deny-input]");
    if (input) {
      const id = input.getAttribute("data-deny-input")!;
      if (e.key === "Enter") {
        e.preventDefault();
        this.confirmDeny(id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeDeny(id);
      }
      return;
    }
    // The arrow keys move between the tabs; Enter or Space opens one, since opening the Audit
    // Trail fetches it and passing over it must not.
    const tab = target.closest<HTMLElement>("[data-tab]");
    if (tab && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const other = tab.dataset.tab === "queue" ? "audit" : "queue";
      this.root.querySelector<HTMLElement>(`[data-tab="${other}"]`)?.focus();
    }
  }

  private setTab(tab: InboxTab): void {
    if (tab === this.tab) {
      return;
    }
    this.tab = tab;
    this.applyTab();
    // Fresh on every open, as before: decisions taken since then must show.
    if (tab === "audit") {
      void this.activityView.open();
    } else {
      this.activityView.close();
    }
    this.renderSelection(true);
  }

  private applyTab(): void {
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-tab]")) {
      const on = el.dataset.tab === this.tab;
      el.setAttribute("aria-selected", String(on));
      el.tabIndex = on ? 0 : -1;
    }
    const queue = this.root.querySelector<HTMLElement>("#listQueue");
    const audit = this.root.querySelector<HTMLElement>("#listAudit");
    const actions = this.root.querySelector<HTMLElement>("#auditActions");
    if (queue) queue.hidden = this.tab !== "queue";
    if (audit) audit.hidden = this.tab !== "audit";
    if (actions) actions.hidden = this.tab !== "audit";
  }

  private select(next: Selection): void {
    if (next.kind === "audit") {
      const entry = this.activityView.entry(next.id);
      if (!entry) return;
      next.item = auditItem(entry, this.connectionName || null);
    }
    this.selection[this.tab] = next;
    for (const row of this.root.querySelectorAll<HTMLElement>(
      `#${this.tab === "queue" ? "listQueue" : "listAudit"} [data-row]`,
    )) {
      row.setAttribute("aria-current", String(row.dataset.row === next.id));
    }
    // Shown before it renders: the grid sizes itself from the visible pane.
    this.root.querySelector("#inbox")?.setAttribute("data-show", "detail");
    this.renderSelection(true);
    // Narrow: the list just hid under the focused row, so Back takes the focus.
    if (this.root.querySelector<HTMLElement>(".pane-list")?.offsetParent === null) {
      this.root.querySelector<HTMLElement>("[data-back]")?.focus({ preventScroll: true });
    }
  }

  // The server's record stays the fact; rows this tab still holds for the same approved request
  // are attached when it renders, so rows Result memory has since dropped are not shown here.
  private withLocalRows(item: HistItem): HistItem {
    const local = this.history.find((h) => h.id === item.id);
    return item.status === "approved" && local?.status === "approved" && local.result?.rows.length
      ? { ...item, result: local.result }
      : item;
  }

  // Narrow tab: the list and the selection take turns; Back returns to the row it left, or to
  // the open tab when that row is gone or folded away.
  private showList(): void {
    this.root.querySelector("#inbox")?.setAttribute("data-show", "list");
    const id = this.selection[this.tab]?.id;
    const list = this.tab === "queue" ? "#listQueue" : "#listAudit";
    const row = id
      ? this.root.querySelector<HTMLElement>(`${list} [data-row="${CSS.escape(id)}"]`)
      : null;
    if (row?.offsetParent) row.focus({ preventScroll: true });
    else this.focusOpenTab();
  }

  // The right pane shows exactly the current selection. A decided request reopens only when
  // the selection changed (`force`), never on a poll, so its grid keeps its sort and page.
  private renderSelection(force = false): void {
    const sel = this.selection[this.tab];
    const queue = this.root.querySelector<HTMLElement>("#queue");
    const empty = this.root.querySelector<HTMLElement>("#paneEmpty");
    if (!queue || !empty) {
      return;
    }
    if (sel?.kind === "card") {
      const card = this.cards.find((c) => c.id === sel.id);
      if (!card) {
        this.selection[this.tab] = null;
        this.renderSelection(true);
        return;
      }
      this.detailView.close();
      empty.innerHTML = "";
      this.renderSelectedCard(card);
      return;
    }
    if (queue.childElementCount) {
      this.captureDenyDrafts(queue);
      queue.innerHTML = "";
    }
    const item =
      sel?.kind === "hist"
        ? (this.history.find((h) => h.id === sel.id) ?? sel.item)
        : sel?.item && this.withLocalRows(sel.item);
    if (sel?.kind === "hist" && item) sel.item = item;
    if (item) {
      empty.innerHTML = "";
      if (force || this.detailView.showing() !== item.id) {
        this.detailView.open(item, sel?.kind === "hist" ? "live" : "text");
      }
      return;
    }
    this.detailView.close();
    this.breatheLoop?.stop();
    this.breatheLoop = undefined;
    const waiting = this.cards.filter((c) => c.state === "ready").length;
    empty.innerHTML = paneEmptyHtml(waiting, this.tab);
    const mark = empty.querySelector(".waiting-mark");
    if (mark) this.breatheLoop = pulse(mark);
  }

  private renderSelectedCard(card: Card): void {
    const queue = this.root.querySelector<HTMLElement>("#queue");
    if (!queue) {
      return;
    }
    // A rebuild must carry an open deny form's typed text and focus across.
    const focusedDeny = this.captureDenyDrafts(queue);
    const who = card.session?.project?.trim() || card.session?.harness?.trim() || card.sessionId;
    const task = card.session?.sessionLabel?.trim();
    queue.innerHTML = `<div class="pd-who">${agentBadge(card.session?.harness?.trim() || null)}<span class="pd-name">${escapeHtml(who)}</span>${task ? `<span class="pd-task" title="${escapeHtml(capitalize(task))}">${escapeHtml(capitalize(task))}</span>` : ""}</div>${cardHtml(card, this.dialect, this.denyDrafts, this.mode, this.connectionReadOnly())}`;
    if (focusedDeny) {
      const input = queue.querySelector<HTMLInputElement>(`[data-deny-input="${focusedDeny}"]`);
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // Saves every open deny form's text before its markup goes; returns the focused one.
  private captureDenyDrafts(host: HTMLElement): string | null {
    let focused: string | null = null;
    for (const input of host.querySelectorAll<HTMLInputElement>(".deny-reason")) {
      const id = input.getAttribute("data-deny-input");
      if (id) {
        this.denyDrafts.set(id, input.value);
        if (input === document.activeElement) focused = id;
      }
    }
    return focused;
  }

  // Connection switch, demotion and re-pair: nothing from before stays open.
  private resetInbox(): void {
    this.selection.queue = null;
    this.selection.audit = null;
    this.activityView.reset();
    this.detailView.close();
    this.root.querySelector("#inbox")?.setAttribute("data-show", "list");
  }

  private setAgentsPopOpen(open: boolean): boolean {
    const pop = this.root.querySelector<HTMLElement>("#agentsPop");
    const more = this.root.querySelector<HTMLElement>("[data-agents-more]");
    if (!pop || pop.hidden === !open) {
      return false;
    }
    pop.hidden = !open;
    more?.setAttribute("aria-expanded", String(open));
    return true;
  }

  // Hides the chips past the strip's end and counts them on "+N more", which stays visible
  // itself: its own width is reserved before any chip is measured.
  private layoutStrip(): void {
    const box = this.root.querySelector<HTMLElement>("#roster .chips");
    const more = this.root.querySelector<HTMLElement>("#roster [data-agents-more]");
    if (!box || !more) {
      return;
    }
    const focused = document.activeElement === more;
    const chips = [...box.children] as HTMLElement[];
    for (const c of chips) c.hidden = false;
    more.hidden = true;
    if (box.scrollWidth > box.clientWidth) {
      more.textContent = `+${chips.length} more`;
      more.hidden = false;
      const limit = box.getBoundingClientRect().right;
      let hidden = 0;
      for (const c of chips) {
        if (c.getBoundingClientRect().right > limit + 0.5) {
          c.hidden = true;
          hidden++;
        }
      }
      more.textContent = `+${hidden} more`;
    }
    if (focused && more.hidden) this.refocusStrip();
  }

  // A keyboard user keeps "+N more" across a rebuild, or lands on the open tab once it goes.
  private refocusStrip(): void {
    const more = this.root.querySelector<HTMLElement>("#roster [data-agents-more]");
    if (more && !more.hidden) more.focus({ preventScroll: true });
    else this.focusOpenTab();
  }

  private focusOpenTab(): void {
    this.root
      .querySelector<HTMLElement>('[data-tab][aria-selected="true"]')
      ?.focus({ preventScroll: true });
  }

  // Updated in place, never rebuilt, so the live node stays mounted and the glyph keeps the
  // keyboard focus.
  private setConnectionState(state: ConnectionState, force = false): void {
    if (!force && this.connectionState === state) {
      return;
    }
    this.connectionState = state;
    const el = this.root.querySelector<HTMLElement>("#agentLink");
    if (el) {
      const label = agentLinkLabel(state);
      el.dataset.state = state;
      el.querySelector(".ag-ico")?.setAttribute("aria-label", label);
      const live = el.querySelector("#agentLive");
      if (live) {
        live.textContent = label;
      }
      const slot = el.querySelector(".ag-slot");
      if (slot) {
        slot.innerHTML = agentLinkStatusHtml(state);
      }
    }
    this.renderAgentLinkTimes();
  }

  private renderAgentLinkTimes(): void {
    const el = this.root.querySelector<HTMLElement>("#agentLink");
    if (!el) {
      return;
    }
    const age = el.querySelector(".db-age");
    if (age) {
      age.textContent = agentLinkAge(this.connectionState, this.brokerAnsweredAt, Date.now());
    }
    this.placeAgentPop();
  }

  // Escape hides the open server popover. A hovered database glyph wins over it (the CSS shows
  // one status popover at a time), and then this Escape is not the server popover's.
  private dismissAgentPop(): boolean {
    const link = this.root.querySelector<HTMLElement>("#agentLink");
    if (
      !link ||
      link.hasAttribute("data-dismissed") ||
      this.root.querySelector("#conn .chip-db:hover, #connPop:hover") ||
      !link.querySelector(".ag-ico:hover, .ag-pop:hover, .ag-ico:focus-visible")
    ) {
      return false;
    }
    link.toggleAttribute("data-dismissed", true);
    return true;
  }

  // A legend entry's names hide on Escape with the focus kept on the entry, as the server popover.
  private dismissLegendPop(): boolean {
    const slot = this.root.querySelector(
      ".lg-slot:is(:hover, :focus-within):not([data-dismissed])",
    );
    return slot ? slot.toggleAttribute("data-dismissed", true) : false;
  }

  // A popover Escape hid stays hidden until its glyph is entered again from outside,
  // by the pointer or the focus, whatever else still holds it open.
  private enterPopGlyph(e: MouseEvent | FocusEvent): void {
    const glyph = (e.target as Element | null)?.closest?.(".ag-ico, .lg-slot");
    if (!glyph || glyph.contains(e.relatedTarget as Node | null)) {
      return;
    }
    glyph.closest("[data-dismissed]")?.removeAttribute("data-dismissed");
    this.placeAgentPop();
  }

  // The server popover opens leftwards when rightwards would cross the header's edge (a long
  // connection name). Measured on entry and on every tick, so a resize with the focus kept on
  // the glyph is corrected within a second; a geometry fix only, nothing is rebuilt.
  private placeAgentPop(): void {
    const glyph = this.root.querySelector(".ag-ico");
    const pop = this.root.querySelector<HTMLElement>("#agentPop");
    const bar = this.root.querySelector(".bar");
    if (!glyph || !pop || !bar) {
      return;
    }
    const room = bar.getBoundingClientRect().right - glyph.getBoundingClientRect().left;
    pop.toggleAttribute("data-flip", pop.offsetWidth > room);
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

  // A flyout format menu (audit export, result copy/export) opens/closes like the mode
  // menus: one at a time, the trigger toggles, a click elsewhere dismisses.
  private toggleFlyoutMenu(trigger: HTMLElement): void {
    const menu = trigger.parentElement?.querySelector<HTMLElement>("[data-flyout-menu]");
    if (!menu) {
      return;
    }
    const open = menu.hidden;
    this.closeFlyoutMenus();
    if (open) {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    }
  }

  private closeFlyoutMenus(): boolean {
    let closed = false;
    for (const menu of this.root.querySelectorAll<HTMLElement>("[data-flyout-menu]")) {
      if (!menu.hidden) {
        menu.hidden = true;
        closed = true;
      }
    }
    for (const trigger of this.root.querySelectorAll<HTMLElement>("[data-flyout-trigger]")) {
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

  private renderAuto(): void {
    const focused = document.activeElement as HTMLElement | null;
    const on = String(this.autoEnabled);
    for (const el of this.root.querySelectorAll<HTMLElement>("#autoHint, #autoSettings")) {
      el.dataset.on = on;
    }
    const toggle = this.root.querySelector<HTMLInputElement>("#autoSettings [data-auto-toggle]");
    if (toggle) toggle.checked = this.autoEnabled;
    this.renderModeSurfaces();
    // The popover button that just flipped is now hidden, so hand focus to its counterpart.
    if (focused?.closest("#autoHint [data-auto-toggle]")) {
      this.root
        .querySelector<HTMLElement>(
          `#autoHint .${this.autoEnabled ? "sa-on" : "sa-off"} [data-auto-toggle]`,
        )
        ?.focus();
    }
  }

  private openAutoSettings(): void {
    this.setSettingsOpen(false);
    this.settingsView.open();
    const section = this.root.querySelector<HTMLElement>("#autoSettings");
    section?.scrollIntoView({ block: "center" });
    section
      ?.querySelector<HTMLElement>("[data-auto-key], [data-auto-toggle]")
      ?.focus({ preventScroll: true });
  }

  private versionInputs(): [BuildIdentity, BuildIdentity | null, string | null] {
    return [__GK_BUILD__, this.serverIdentity, this.latestRelease];
  }

  private versionStatus(): VersionStatus {
    return versionStatus(...this.versionInputs());
  }

  private setServerHeader(raw: string | null): void {
    if (raw === this.serverHeader) return;
    this.serverHeader = raw;
    this.serverIdentity = parseServerIdentity(raw);
    this.renderVersion();
  }

  // Touches only the corner indicator and the Version group, so an open Settings keeps
  // whatever else is being edited.
  private renderVersion(): void {
    const status = this.versionStatus();
    const dock = this.root.querySelector<HTMLButtonElement>("#verDock");
    if (dock) {
      const { cls, html } = versionDockHtml(status.dock);
      const title = versionDockTitle(...this.versionInputs());
      dock.className = `ver-dock${cls ? ` ${cls}` : ""}`;
      dock.innerHTML = html;
      dock.title = title;
      dock.setAttribute("aria-label", `${title}. Open version settings.`);
      dock.hidden = this.serverHeader === undefined;
    }
    const group = this.root.querySelector<HTMLElement>("#settings:not([hidden]) #versionSettings");
    if (group) group.innerHTML = versionGroupHtml(status);
  }

  // Once per plugin start, and never from a dev build: Vite reloads would otherwise spend
  // GitHub's anonymous rate limit, and a dev build gets no update advice anyway.
  private async checkLatestRelease(): Promise<void> {
    if (this.latestChecked || __GK_BUILD__.dev) return;
    this.latestChecked = true;
    this.latestRelease = await fetchLatestRelease();
    this.renderVersion();
  }

  private openVersionSettings(): void {
    this.setSettingsOpen(false);
    this.settingsView.open();
    const section = this.root.querySelector<HTMLElement>("#versionSettings");
    section?.scrollIntoView({ block: "center" });
    section?.focus({ preventScroll: true });
  }

  private async copyUpdatePrompt(button: HTMLElement): Promise<void> {
    let copied = true;
    try {
      await clipboard.writeText(updatePrompt(...this.versionInputs()));
    } catch {
      copied = false;
    }
    button.classList.toggle("copied", copied);
    button.innerHTML = copied
      ? `${checkIcon}<span>Copied</span>`
      : `${copyIcon}<span>Copy failed, try again</span>`;
    window.setTimeout(() => {
      button.classList.remove("copied");
      button.innerHTML = `${copyIcon}<span>Copy prompt</span>`;
    }, 1600);
  }

  private resetAuto(reason: string): void {
    this.autoEnabled = false;
    this.autoGeneration++;
    this.autoAbort?.abort();
    this.autoKey = "";
    this.autoDeferred.clear();
    for (const card of this.cards) {
      // Reset authority without overwriting an already established review reason.
      if (card.autoStatus === "Evaluating with Jev" && !card.evaluation) {
        card.autoStatus = `Needs review: ${reason === "Auto mode disabled" ? "Auto mode disabled while evaluating" : reason}`;
      }
    }
    this.renderAuto();
    this.renderQueue();
  }

  private async toggleAuto(toggle: HTMLElement): Promise<void> {
    if (this.autoEnabled || (toggle instanceof HTMLInputElement && !toggle.checked)) {
      const fromMarker = toggle.closest("#armed");
      this.resetAuto("Auto mode disabled");
      this.applyMode("read");
      if (fromMarker) this.root.querySelector<HTMLElement>("#autoHint .sa-hint")?.focus();
      return;
    }
    // One check at a time per control, and the control shows it is working meanwhile.
    if (toggle.getAttribute("aria-busy") === "true") return;
    const body = toggle.closest<HTMLElement>(".auto-body");
    const input = body?.querySelector<HTMLInputElement>("[data-auto-key]");
    const entered = typedKey(input);
    const generation = ++this.autoGeneration;
    const connection = this.connGeneration;
    const active = this.activeGen;
    const message = body?.querySelector<HTMLElement>("[data-auto-message]");
    const fail = (text: string, keyField = false): void => {
      if (message) {
        message.textContent = text;
        message.dataset.tone = "";
      }
      if (toggle instanceof HTMLInputElement) toggle.checked = false;
      if (keyField) input?.focus();
    };
    const stale = () =>
      generation !== this.autoGeneration ||
      connection !== this.connGeneration ||
      active !== this.activeGen;
    // A missing or refused key is fixed in Settings, so the popover sends the user there
    // and the reason shows under the key field.
    const keyProblem = (text: string): void => {
      if (input) {
        fail(text, true);
        return;
      }
      this.openAutoSettings();
      const note = this.root.querySelector<HTMLElement>("#autoSettings [data-auto-message]");
      if (note) {
        note.textContent = text;
        note.dataset.tone = "";
      }
    };
    if (message) {
      message.textContent =
        toggle instanceof HTMLInputElement ? "Checking the key with TypeSafe…" : "";
      message.dataset.tone = "busy";
    }
    toggle.setAttribute("aria-busy", "true");
    try {
      const key = entered || (await appStorage.getItem<string>(AUTO_KEY, { encrypted: true }));
      if (stale()) return;
      if (!key) {
        keyProblem("Paste your TypeSafe API key first.");
        return;
      }
      if (!API_KEY_FORMAT.test(key)) {
        keyProblem("This API key is not valid.");
        return;
      }
      if (entered) await appStorage.setItem(AUTO_KEY, entered, { encrypted: true });
      const verdict = await this.broker.checkKey(key);
      if (stale()) return;
      if (verdict === "invalid") {
        keyProblem("TypeSafe refused this API key.");
        return;
      }
      if (verdict === "outdated") {
        fail("Restart the Gatekeeper server to use Auto mode. It predates this plugin.");
        return;
      }
      if (verdict === "unavailable") {
        fail("TypeSafe could not be reached. Try again.");
        return;
      }
      if (!(await this.checkConnection())) {
        fail("The connection could not be verified. Try again.");
        return;
      }
      if (stale()) return;
      this.confirmModal.cancel();
      this.applyMode("read");
      this.autoKey = key;
      this.autoDeferred = new Set(this.cards.map((c) => c.id));
      this.autoEnabled = true;
      this.renderAuto();
      await this.reportConnection();
      void this.evaluateNext();
    } catch {
      fail("Auto mode could not be enabled. Check the key, encrypted storage and connection.");
    } finally {
      toggle.removeAttribute("aria-busy");
      if (message?.dataset.tone === "busy") message.textContent = "";
    }
  }

  // Saved as typed, so replacing the key never requires turning Auto mode off; a running
  // Auto mode uses the new key from its next evaluation.
  private async saveAutoKey(input: HTMLInputElement): Promise<void> {
    const key = typedKey(input);
    const message = input.closest(".auto-body")?.querySelector<HTMLElement>("[data-auto-message]");
    const say = (text: string, ok = false): void => {
      if (!message) return;
      message.textContent = text;
      message.dataset.tone = ok ? "ok" : "";
    };
    if (!key) return;
    if (!API_KEY_FORMAT.test(key)) {
      say("This API key is not valid.");
      return;
    }
    try {
      await appStorage.setItem(AUTO_KEY, key, { encrypted: true });
      if (this.autoEnabled) this.autoKey = key;
      this.keySaved = true;
      say("Key saved.", true);
    } catch {
      say("The key could not be saved to encrypted storage.");
    }
  }

  // `auto` false: a human approval stopped before the SQL ran. That is no Auto mode hold, so it
  // reads as its own notice and never becomes an Auto status or an Audit Trail hold.
  private reviewCard(card: Card, reason: string, auto = true): void {
    if (!this.cards.includes(card)) return;
    card.state = "ready";
    if (card.authorityLost) {
      this.drop(card.id);
      return;
    }
    if (auto) card.autoStatus = `Needs review: ${reason}`;
    else card.executionNotice = reason;
    this.renderQueue();
  }

  private async evaluateNext(): Promise<void> {
    if (!this.autoEnabled || this.autoBusy || this.autoRuns >= AUTO_RUNS_MAX) return;
    const card = this.cards.find(
      (c) =>
        c.state === "ready" &&
        c.autoAttempt !== this.autoGeneration &&
        !c.authorityLost &&
        !this.autoDeferred.has(c.id) &&
        classifyQuery(c.sql, this.dialect).class === "read",
    );
    if (!card) return;
    const generation = this.autoGeneration;
    const conn = this.connGeneration;
    const active = this.activeGen;
    const lease = card.leaseId;
    const sql = card.sql;
    card.autoAttempt = generation;
    const valid = () =>
      this.autoEnabled &&
      generation === this.autoGeneration &&
      conn === this.connGeneration &&
      active === this.activeGen &&
      this.cards.includes(card) &&
      card.state === "ready" &&
      !card.authorityLost &&
      card.leaseId === lease &&
      card.sql === sql &&
      card.expiresAt > Date.now() &&
      card.leaseExpiresAt > Date.now();
    this.autoBusy = true;
    this.autoCard = card;
    const controller = new AbortController();
    this.autoAbort = controller;
    const timer = window.setTimeout(() => {
      controller.abort();
      if (valid()) this.reviewCard(card, "Evaluation timed out. Approve manually");
    }, 15000);
    let run: Promise<void> | undefined;
    try {
      card.autoStatus = "Evaluating with Jev";
      this.renderQueue();
      if (!(await this.checkConnection()) || !valid() || controller.signal.aborted) return;
      const analysis = await this.annotator.inspectRead(
        sql,
        () => valid() && !controller.signal.aborted,
      );
      if (!valid() || controller.signal.aborted) return;
      if (!analysis?.complete || !analysis.input) {
        this.reviewCard(card, analysis?.reasons[0] ?? "Metadata unavailable");
        return;
      }
      if (!(await this.checkConnection()) || !valid() || controller.signal.aborted) return;
      card.autoSent = true;
      const evaluation = await this.broker.evaluate(
        card.id,
        lease,
        this.connScopeKey()!,
        this.autoKey,
        analysis.input,
        controller.signal,
      );
      if (!valid() || controller.signal.aborted) return;
      if (!validEvaluation(evaluation)) {
        this.reviewCard(card, "Invalid evaluator response or stale policy/model");
        return;
      }
      card.evaluation = evaluation;
      if (!currentEvaluation(evaluation)) {
        this.reviewCard(card, refusalReason(evaluation));
        return;
      }
      card.autoStatus = AUTO_APPROVED;
      // approve() reserves the card before its first await, so the finally below frees the
      // evaluator for the next read while this one executes.
      this.autoRuns++;
      run = this.approve(card.id, false, evaluation);
    } catch {
      if (valid()) this.reviewCard(card, "Evaluator or metadata unavailable. Approve manually");
    } finally {
      window.clearTimeout(timer);
      this.autoBusy = false;
      this.autoCard = undefined;
      if (card.state === "ready" && card.autoStatus === "Evaluating with Jev")
        this.reviewCard(card, "Evaluation cancelled or authority changed");
      void this.evaluateNext();
    }
    if (!run) return;
    try {
      await run;
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    } finally {
      this.autoRuns--;
      void this.evaluateNext();
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
    const autoNotice = this.autoEnabled ? " Confirming turns off Auto mode." : "";
    if (next === "write") {
      this.confirmModal.open({
        tone: "write",
        heading: "Enable Write Mode",
        body: `Write mode lets you approve INSERT and UPDATE statements. Each still runs only on your one-click approval, one at a time.${autoNotice}`,
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
      body: `Destructive mode lets you approve DELETE, DROP, TRUNCATE and other data-changing statements. Type the database name to confirm.${autoNotice}`,
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
    // Invalidate running evaluations and pending activation before granting write authority.
    if (next !== "read") this.resetAuto("Auto mode disabled");
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
      header.innerHTML = modeDropdown(this.mode, true, this.autoEnabled);
    }
    const overlay = this.root.querySelector<HTMLElement>("#modeCtlSettings");
    if (overlay) {
      overlay.innerHTML = modeDropdown(this.mode, false, this.autoEnabled);
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
    // Auto mode forces read, so it takes the same slot and never shares it.
    if (this.autoEnabled) {
      el.innerHTML = `<span class="armed-chip auto"><span class="armed-ico">${autoIcon}</span>AUTO MODE<button class="armed-off" type="button" data-auto-toggle title="Disable Auto mode" aria-label="Disable Auto mode">${xIcon}</button></span>`;
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
      const on = this.settingsStore.get().schemaAccess;
      hint.dataset.on = String(on);
      hint.querySelector(".sa-hint")?.setAttribute("aria-label", schemaAccessLabel(on));
    }
    this.trimHistory();
    this.renderHistory();
    for (const card of [...this.cards]) {
      void this.analyzeSchema(card);
    }
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
    const connection = this.connGeneration;
    const active = this.activeGen;
    try {
      const res = await this.broker.pending(this.connScopeKey());
      if (connection !== this.connGeneration || active !== this.activeGen) return;
      if (res.status === 401) {
        this.polling = false;
        this.token = null;
        this.serverHeader = undefined;
        this.serverIdentity = null;
        this.resetAuto("Pairing lost");
        this.activeGen++;
        this.mode = "read";
        await this.broker.clearToken();
        this.renderPairing("This tab was unpaired. Enter a fresh code to reconnect.");
        return;
      }
      // The broker stamps every authenticated answer, its errors included, so each one is
      // current; one without the header is not from a Gatekeeper that reports its version.
      this.setServerHeader(res.headers.get(SERVER_IDENTITY_HEADER));
      // Only a 2xx is an answer: an error status still counts as connected below, but the
      // popover's "Last answer" age keeps growing.
      if (res.ok) {
        this.brokerAnsweredAt = Date.now();
      }
      if (res.status === 200) {
        claimed = true;
        const proposal = (await res.json()) as Proposal;
        if (connection !== this.connGeneration || active !== this.activeGen) return;
        this.claim(proposal);
      }
      this.pollFailures = 0;
      this.setConnectionState("connected");
    } catch (err) {
      // Stay quiet through a brief blip (e.g. the broker failing over during an
      // MCP reconnect); only surface the error once it has actually persisted.
      this.pollFailures++;
      if (this.pollFailures >= 3) {
        this.setConnectionState("error");
        if (active === this.activeGen) this.setServerHeader(null);
      } else if (this.connectionState !== "connecting") {
        this.setConnectionState("reconnecting");
      }
      log.error(err instanceof Error ? err : String(err));
    } finally {
      if (this.polling && active === this.activeGen) {
        this.pollTimer = window.setTimeout(() => void this.poll(), claimed ? 0 : POLL_MS);
      }
    }
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
    // Skip the rebuild (and the pulse restart) when only the relative ages moved;
    // tick() keeps those fresh in place.
    const sig = JSON.stringify(
      rows.map((r) => [r.s.sessionId, r.p, r.s.sessionLabel, r.s.lastIntent]),
    );
    if (sig === this.rosterSig) {
      return;
    }
    this.rosterSig = sig;
    const live = rows.filter((r) => r.p !== "gone").length;
    const open = this.root.querySelector<HTMLElement>("#agentsPop")?.hidden === false;
    const focused = el.contains(document.activeElement);
    el.innerHTML = agentsStripHtml(rows, live);
    this.layoutStrip();
    if (open) this.setAgentsPopOpen(true);
    if (focused) this.refocusStrip();
    for (const loop of this.rosterLoops) {
      loop.stop();
    }
    this.rosterLoops = [...el.querySelectorAll('[data-presence="active"] .presence-dot')].map(
      (dot) => pulse(dot),
    );
  }

  private claim(proposal: Proposal): void {
    const existing = this.cards.find((c) => c.id === proposal.id);
    if (existing) {
      // Keep the fresher lease if /inflight and a re-offered /pending race on the
      // same proposal, so a live lease is never overwritten by a stale one.
      if (proposal.leaseExpiresAt >= existing.leaseExpiresAt) {
        if (proposal.leaseId !== existing.leaseId) {
          existing.autoAttempt = undefined;
          existing.authorityLost = false;
          existing.evaluation = undefined;
        }
        existing.leaseId = proposal.leaseId;
        existing.leaseExpiresAt = proposal.leaseExpiresAt;
      }
      void this.evaluateNext();
      return;
    }
    // Skip a proposal already past its TTL (re-adopted from /inflight right after a
    // reload, before the broker swept it) so it never flashes at 0:00 then vanishes.
    if (proposal.expiresAt - Date.now() <= 0) {
      return;
    }
    const card: Card = { ...proposal, state: "ready" };
    this.cards.push(card);
    this.renderQueue(card.id);
    void this.analyzeSchema(card);
    void this.evaluateNext();
  }

  // Annotate the card with the tables and PII-suspect columns the query touches. Only the
  // presence flags derived from it ride the decision to the broker, never a table or column
  // name, so the agent gains no schema knowledge.
  private async analyzeSchema(card: Card): Promise<void> {
    const settings = this.settingsStore.get();
    const schema = await this.annotator.schemaFor(card.sql);
    // A mid-fetch connection switch yields undefined; leave the prior annotation
    // rather than blanking a card whose columns simply could not be resolved.
    if (schema === undefined) {
      return;
    }
    card.schema = filterSchema(schema, settings);
    // Raw, before the display toggles: the audit trail is a durable security record, so it
    // keeps every flag even on a connection whose detection toggles are off.
    if (schema) {
      card.sensitivity = sensitivityOf(schema);
    }
    this.renderCardSchema(card);
  }

  private async renew(): Promise<void> {
    for (const card of [...this.cards]) {
      // Renew while a human deliberates (ready) and while the approved query
      // runs (executing). An unrenewed executing card would expire mid-query
      // and be failed as execution_unknown even though it actually succeeded.
      if (card.state !== "ready" && card.state !== "executing" && card.state !== "approving") {
        continue;
      }
      const leaseId = card.leaseId;
      try {
        const res = await this.broker.renew(card.id, leaseId);
        if (card.leaseId !== leaseId) continue;
        if (res.ok) {
          card.leaseExpiresAt = res.leaseExpiresAt;
          continue;
        }
        // Re-claimed under a fresh lease while this call was in flight: it lives on.
        if (card.leaseId !== leaseId) {
          continue;
        }
        this.resolveLostLease(card, res.state);
      } catch {
        // Transient broker error; keep the card and retry next cycle.
      }
    }
  }

  // An executing card is never dropped here: approve() owns it and writes a history row
  // down every one of its paths, and finish() is a no-op once the card is gone, so
  // dropping it lost the record of a query that really ran.
  private resolveLostLease(card: Card, state?: RequestState): void {
    card.authorityLost = true;
    if (card.state !== "ready") {
      return;
    }
    if (state === "expired") {
      this.finish(card.id, "expired", "expired");
      return;
    }
    // No word of its own: the row would read as a timeout, so the note carries the truth.
    if (state === "cancelled") {
      this.finish(card.id, "expired", CANCELLED_NOTE);
      return;
    }
    // Back in the pool (or the broker said nothing): the next poll re-offers it.
    this.drop(card.id);
  }

  private tick(): void {
    this.maybeCheckConnection();
    this.maybeCheckEndpoint();
    this.renderCheckTimes();
    this.renderAgentLinkTimes();
    const now = Date.now();
    for (const card of [...this.cards]) {
      if (card.state === "ready" && card.expiresAt - now <= 0) {
        this.finish(card.id, "expired", "expired");
        continue;
      }
      if (card.state !== "ready") continue;
      const remaining = card.expiresAt - now;
      const leaseEl = this.root.querySelector<HTMLSpanElement>(`[data-card="${card.id}"] .lease`);
      if (leaseEl) {
        leaseEl.className = remaining <= 45_000 ? "lease low" : "lease";
        leaseEl.textContent = clock(remaining);
      }
      const rowEl = this.root.querySelector<HTMLSpanElement>(
        `[data-row="${card.id}"] [data-lease]`,
      );
      if (rowEl) {
        rowEl.classList.toggle("low", remaining <= 45_000);
        rowEl.textContent = clock(remaining);
      }
    }
    this.tickRuns(now);
    // Keep the resolved-history and roster ages current without re-rendering.
    this.root.querySelectorAll<HTMLSpanElement>("#listQueue .hage, #roster .rage").forEach((el) => {
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

  // The queue list and, when a card is open on the right, that card. Counts: the tab says
  // how many wait for the human (as the Beekeeper tab title does), the group how many it lists.
  // `changed`: the one card this update is about. The open card is rebuilt only for its own
  // changes, so a proposal arriving elsewhere never resets a selection, a tooltip or a scroll.
  private renderQueue(changed?: string): void {
    const ready = this.cards.filter((c) => c.state === "ready").length;
    const count = this.root.querySelector<HTMLSpanElement>("#queueCount");
    if (count) {
      count.textContent = ready > 0 ? String(ready) : "";
    }
    this.renderQueueList();
    // The empty pane counts what waits, so it follows the queue too.
    const sel = this.selection[this.tab];
    if (!sel || (sel.kind === "card" && (changed === undefined || changed === sel.id))) {
      this.renderSelection();
    }
    this.updateTabTitle();
  }

  private renderHistory(): void {
    this.renderQueueList();
  }

  private renderQueueList(): void {
    const list = this.root.querySelector<HTMLElement>("#listQueue");
    if (!list) {
      return;
    }
    const selected = this.selection.queue?.id ?? null;
    const now = Date.now();
    // What waits for a decision; running rows say their own state.
    const ready = this.cards.filter((c) => c.state === "ready").length;
    const pending = this.cards.length
      ? this.cards
          .map((c) =>
            queueRowHtml(c, classifyQuery(c.sql, this.dialect).class, c.id === selected, now),
          )
          .join("")
      : '<p class="ix-none">Nothing waiting.</p>';
    // Defense in depth: a switch already clears history, but never render a row
    // stamped under a different connection than the one on screen now.
    const current = this.connectionName || null;
    const recent = this.history.filter((h) => h.connection === current);
    const focused = list.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.row
      : undefined;
    list.innerHTML = `${groupHeadHtml("Pending approval", ready, ready > 0)}${pending}${
      recent.length
        ? `${groupHeadHtml("Recently resolved", 0)}${recent
            .map((h) => recentRowHtml(h, h.id === selected, this.dialect))
            .join("")}`
        : ""
    }`;
    for (const row of list.querySelectorAll<HTMLElement>('[data-select="card"]')) {
      if (row.dataset.row && !this.prevCardIds.has(row.dataset.row)) enter(row);
    }
    // A keyboard user keeps the row they were on (a decided card is now its outcome row), or
    // lands on the open tab once that row is gone.
    if (focused !== undefined) {
      const row = list.querySelector<HTMLElement>(`[data-row="${focused}"]`);
      if (row) row.focus({ preventScroll: true });
      else this.focusOpenTab();
    }
    this.prevCardIds = new Set(this.cards.map((c) => c.id));
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
    // The matrix (a read's tables come from this analysis), the legend and the SQL marks move
    // together, so none of them describes a different analysis than the others.
    const id = CSS.escape(card.id);
    const matrix = this.root.querySelector<HTMLElement>(`#cm-${id}`);
    if (matrix) {
      const cls = classifyQuery(card.sql, this.dialect).class;
      matrix.innerHTML = accessMatrix(card.sql, this.dialect, cls, card.schema);
    }
    const legend = this.root.querySelector<HTMLElement>(`#cs-${id}`);
    if (legend) {
      paintLegend(legend, card.schema, card.id);
    }
    // Auto mode's note names an object only when the card does not show it, so it follows too.
    const note = this.root.querySelector<HTMLElement>(`#ca-${id}`);
    if (note) {
      note.innerHTML = autoNote(card);
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
      this.renderQueue(id);
    }
  }

  private async approve(id: string, confirmed = false, evaluation?: AutoEvaluation): Promise<void> {
    const card = this.cards.find((c) => c.id === id);
    if (card?.state !== "ready" || card.authorityLost) {
      return;
    }
    if (!evaluation && this.autoCard === card) this.autoAbort?.abort();
    // this.autoAbort moves on to the next read's evaluation once this card is reserved, so
    // keep the signal of the evaluation that cleared this one.
    const autoSignal = evaluation ? this.autoAbort?.signal : undefined;
    const gen = this.connGeneration;
    const active = this.activeGen;
    const auto = this.autoGeneration;
    const lease = card.leaseId;
    const sql = card.sql;
    const valid = () =>
      gen === this.connGeneration &&
      active === this.activeGen &&
      this.cards.includes(card) &&
      !card.authorityLost &&
      card.leaseId === lease &&
      card.sql === sql &&
      card.expiresAt > Date.now() &&
      card.leaseExpiresAt > Date.now() &&
      (!evaluation ||
        (this.autoEnabled &&
          auto === this.autoGeneration &&
          this.mode === "read" &&
          !autoSignal?.aborted &&
          currentEvaluation(evaluation)));
    // Reserve synchronously, before the host round-trip, for both approval sources.
    card.executionNotice = undefined;
    this.setCardState(id, "approving");
    if (!(await this.checkConnection()) || !valid()) {
      this.reviewCard(card, "Connection or approval authority changed", Boolean(evaluation));
      return;
    }
    // SAFETY-CRITICAL: the real gate. Never run a statement the armed mode cannot
    // approve, nor a blocked (empty or multi-statement) one.
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
      this.setCardState(id, "ready");
      const destructive = verdict.class === "destructive";
      this.confirmModal.open({
        tone: destructive ? "destructive" : "write",
        heading: destructive ? "Run this destructive statement?" : "Run this write?",
        body: destructive
          ? "This statement runs on the live database the moment you confirm. There is no undo action in this plugin."
          : "This changes data on the live database the moment you confirm.",
        sql: card.sql,
        schema: card.schema ?? undefined,
        confirmLabel: destructive ? "Run destructive" : "Run write",
        onConfirm: () => void this.approve(id, true),
      });
      return;
    }
    card.approval = {
      source: evaluation ? "automatic" : "human",
      evaluation: evaluation ?? card.evaluation,
    };
    // If the broker refuses the executing transition (the request was cancelled,
    // or the lease was lost), do not run the query: its result could never be
    // delivered, and the human approval no longer maps to a live proposal.
    if (!(await this.postExecuting(card))) {
      this.finish(id, "failed", "lease lost");
      return;
    }
    // Final anti-race guard: the connection poll is throttled, so a switch during the
    // postExecuting round-trip could go unseen; re-read live before touching the DB.
    const connected = await this.checkConnection();
    const finalVerdict = classifyQuery(card.sql, this.dialect);
    if (
      !connected ||
      !valid() ||
      finalVerdict.blocked ||
      rank(finalVerdict.class) > modeRank(this.mode)
    ) {
      try {
        if (!(await this.broker.withdrawExecution(id, lease))) card.authorityLost = true;
      } catch {
        card.authorityLost = true;
      }
      // Withdrawn, the request is leased again: the broker keeps these flags until the next
      // decision posts its own, and an expiry or cancellation before then keeps them for good.
      if (card.decisionSensitivity) card.decisionSensitivity.standing = false;
      this.reviewCard(
        card,
        "Execution stopped before SQL ran. Approval authority changed",
        Boolean(evaluation),
      );
      return;
    }
    const run = this.startRun(card);
    card.run = run;
    this.setCardState(id, "executing");
    try {
      // The tag is a plain leading comment: the statement the gate classified is unchanged.
      const { rows, fields, affectedRows } = await runApprovedQuery(
        run.tag ? `${run.tag} ${sql}` : sql,
      ).finally(() => {
        run.ended = true;
      });
      // A switch drops the cards, so never deliver rows to an old proposal; a schema change
      // bumps connGeneration but keeps them, and must not strand this card running.
      if (!this.cards.includes(card) || active !== this.activeGen) {
        return;
      }
      this.setCardState(id, "posting");
      // Cap what the agent receives, and keep the true count so it learns the shape.
      const forAgent = capResult(rows, fields, AGENT_MAX_BYTES, AGENT_MAX_ROWS);
      const posted = await this.postResult(card, {
        status: "approved",
        rows: forAgent.rows,
        fields: forAgent.fields,
        truncated: forAgent.truncated,
        rowCount: forAgent.rowCount,
        // Only a write answers "how many rows did this change". On a read most drivers
        // report 0, which would read as an answer instead of a non-answer.
        ...(verdict.class !== "read" && affectedRows !== undefined ? { affectedRows } : {}),
      });
      // The rows already ran on the live database; if the outcome never reached the
      // broker the agent cannot see them, so record a failure rather than a false approve.
      if (!posted) {
        this.finish(id, "failed", NOT_DELIVERED_NOTE);
        return;
      }
      // A write reports what it changed, a read what it returned, and a write that also
      // returns rows says both. Tell the human too when the agent got fewer rows.
      const changed = verdict.class !== "read" ? affectedRows : undefined;
      const counts = countsLabel({ rowCount: forAgent.rowCount, affectedRows: changed });
      const note = forAgent.truncated
        ? `${counts} (agent received ${forAgent.rows.length})`
        : counts;
      this.finish(
        id,
        "approved",
        note,
        capResult(rows, fields, resultBudgetBytes(this.settingsStore.get()), undefined, changed),
      );
    } catch (err) {
      const message = stopNote(run, err instanceof Error ? err.message : String(err));
      // The failure may be the connection itself: check on the next tick, not in 15 s.
      this.nextCheckAt = 0;
      await this.postResult(card, { status: "approved", error: message });
      this.finish(id, "failed", "query failed", undefined, message);
    }
  }

  private startRun(card: Card): RunState {
    const type = this.conn?.databaseType ?? "";
    const run: RunState = {
      startedAt: Date.now(),
      limitMs: (this.settingsStore.get().autoStopMinutes ?? 0) * 60_000,
      ended: false,
    };
    const unavailable = stopUnavailable(type, this.conn?.readOnly ?? false, this.serverVersion);
    if (unavailable) {
      run.unavailable = unavailable;
    } else {
      run.engine = type as StopEngine;
      run.tag = stopTag(card.id, newStopToken());
    }
    return run;
  }

  // The operator's click or the auto-stop limit. The first request is the one reported.
  private requestStop(card: Card, by: "operator" | "limit"): void {
    const run = card.run;
    if (card.state !== "executing" || !run?.engine || run.ended || !this.cards.includes(card)) {
      return;
    }
    if (run.stop && (run.stop.state !== "idle" || run.stop.inFlight)) return;
    if (run.stop) {
      Object.assign(run.stop, { state: "pending", attempts: 0, error: undefined });
    } else {
      run.stop = {
        by,
        atMs: Date.now() - run.startedAt,
        state: "pending",
        inFlight: false,
        attempts: 0,
      };
    }
    this.renderQueue(card.id);
    void this.sendStop(card);
  }

  // At most one stop request in flight per card; "not found yet" is retried by the tick.
  private async sendStop(card: Card): Promise<void> {
    const run = card.run;
    const stop = run?.stop;
    if (!run?.engine || !run.tag || !stop || stop.state !== "pending" || stop.inFlight) return;
    if (run.ended || !this.cards.includes(card)) return;
    const gen = this.connGeneration;
    const active = this.activeGen;
    stop.inFlight = true;
    stop.attempts++;
    let outcome: StopOutcome;
    try {
      outcome = readStop(run.engine, await runQuery(stopStatement(run.engine, run.tag)));
    } catch (err) {
      outcome = { kind: "error", message: runErrorText(err) };
    }
    stop.inFlight = false;
    // A switched connection or a query that already settled makes the answer moot.
    if (
      gen !== this.connGeneration ||
      active !== this.activeGen ||
      !this.cards.includes(card) ||
      card.run !== run ||
      run.ended ||
      stop.state !== "pending"
    ) {
      return;
    }
    if (outcome.kind === "sent") {
      stop.state = "sent";
      stop.sentAt = Date.now();
    } else if (outcome.kind === "error") {
      stop.state = "idle";
      stop.error = outcome.message;
    } else if (stop.attempts >= STOP_ATTEMPTS) {
      stop.state = "idle";
      stop.error = "The running query was not found in the database's activity";
    } else {
      return;
    }
    this.renderQueue(card.id);
  }

  private tickRuns(now: number): void {
    let rerender = false;
    for (const card of [...this.cards]) {
      const run = card.state === "executing" ? card.run : undefined;
      if (!run || run.ended) continue;
      const elapsed = now - run.startedAt;
      const stop = run.stop;
      if (run.engine && run.limitMs && !stop && elapsed >= run.limitMs) {
        this.requestStop(card, "limit");
        continue;
      }
      if (stop?.state === "pending" && !stop.inFlight) void this.sendStop(card);
      // An accepted cancel normally ends the query at once; if it did not, let the
      // operator try again rather than leave Stop disabled for the rest of the run.
      if (stop?.state === "sent" && now - (stop.sentAt ?? now) >= STOP_RETRY_MS) {
        stop.state = "idle";
        rerender = true;
      }
      const rowClock = this.root.querySelector<HTMLElement>(`[data-run="${card.id}"]`);
      if (rowClock) {
        rowClock.textContent = clock(elapsed);
        rowClock.classList.toggle("long", elapsed >= LONG_RUN_MS);
      }
      const el = this.root.querySelector<HTMLElement>(`[data-card="${card.id}"]`);
      if (!el) continue;
      el.classList.toggle("long", elapsed >= LONG_RUN_MS);
      const elapsedEl = el.querySelector<HTMLElement>(".run-clock");
      if (elapsedEl) elapsedEl.textContent = clock(elapsed);
      const leftEl = el.querySelector<HTMLElement>(".autostop-clock");
      if (leftEl) leftEl.textContent = clock(run.limitMs - elapsed);
    }
    if (rerender) this.renderQueue();
  }

  private async reject(id: string, reason?: string): Promise<void> {
    const card = this.cards.find((c) => c.id === id);
    if (card?.state !== "ready") {
      return;
    }
    if (this.autoCard === card) this.autoAbort?.abort();
    // The deny-with-reason form passes the human note here; it goes to the agent
    // and is reflected back into the history row. A plain decline carries no note: the
    // state already says a human declined, and a placeholder would sit in the audit
    // record for good.
    const custom = reason?.trim();
    this.setCardState(id, "rejecting");
    await this.postResult(card, { status: "rejected", reason: custom || undefined });
    this.finish(id, "rejected", "declined", undefined, custom || undefined);
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
    actions.outerHTML = readyActions(id, this.gateFor(card), this.denyDrafts, card.expiresAt);
    this.root.querySelector<HTMLInputElement>(`[data-card="${id}"] .deny-reason`)?.focus();
  }

  private confirmDeny(id: string): void {
    const reason = this.root
      .querySelector<HTMLInputElement>(`[data-card="${id}"] .deny-reason`)
      ?.value.trim();
    this.denyDrafts.delete(id);
    // Empty note means a plain decline, with no reason attached; never send "".
    void this.reject(id, reason || undefined);
  }

  private closeDeny(id: string): void {
    const card = this.cards.find((c) => c.id === id);
    const actions = this.root.querySelector<HTMLElement>(`[data-card="${id}"] .actions`);
    this.denyDrafts.delete(id);
    if (!card || !actions) {
      return;
    }
    actions.outerHTML = readyActions(id, this.gateFor(card), this.denyDrafts, card.expiresAt);
    this.root.querySelector<HTMLButtonElement>(`[data-card="${id}"] .deny-open`)?.focus();
  }

  // The armed-mode verdict for one card, matching what the queue renders.
  private gateFor(card: Card): CardGate {
    return cardGateFor(card, this.dialect, this.mode, this.connectionReadOnly());
  }

  private modeBlockReason(blocked: boolean, cls: RiskClass): string {
    if (blocked) {
      return "Blocked: only a single statement can be approved.";
    }
    return cls === "destructive"
      ? "Blocked: destructive mode is not armed."
      : "Blocked: write mode is not armed.";
  }

  // Frozen as the decision is recorded, never awaited: the card's schema analysis if it has
  // finished, else what the SQL text alone shows (none when it will not parse).
  private sensitivity(card: Card): SensitivityRecord | undefined {
    return card.sensitivity ?? this.textSensitivity(card);
  }

  private textSensitivity(card: Card): SensitivityRecord | undefined {
    const text = textSchema(card.sql, this.dialect);
    return text ? sensitivityOf(text) : undefined;
  }

  private async postExecuting(card: Card): Promise<boolean> {
    try {
      card.decisionSensitivity = { value: this.sensitivity(card), standing: true };
      return await this.broker.executing(
        card.id,
        card.leaseId,
        card.approval,
        card.decisionSensitivity.value,
      );
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
      return false;
    }
  }

  // What Auto mode did with a read it did not approve itself. It rides every result so the
  // audit trail can still say, later, whether anything ever left this machine.
  private autoHold(card: Card): AutoHold | undefined {
    if (!card.autoStatus || card.autoStatus === AUTO_APPROVED) {
      return undefined;
    }
    const reason = card.autoStatus.replace(/^Needs review:\s*/, "");
    // A refusal is the evaluation record itself; a later hold, even after a favourable
    // evaluation, is a fact of its own and rides along with it.
    if (card.evaluation && reason === refusalReason(card.evaluation)) {
      return undefined;
    }
    return { sent: Boolean(card.autoSent), reason: reason.slice(0, 200) };
  }

  private async postResult(card: Card, body: Record<string, unknown>): Promise<boolean> {
    try {
      // While an /executing snapshot stands the broker keeps it; otherwise this one applies.
      if (!card.decisionSensitivity?.standing) {
        card.decisionSensitivity = { value: this.sensitivity(card), standing: true };
      }
      return await this.broker.result(card.id, card.leaseId, {
        ...body,
        autoHold: this.autoHold(card),
        sensitivity: card.decisionSensitivity.value,
      });
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
      return false;
    }
  }

  private drop(id: string): void {
    this.denyDrafts.delete(id);
    const index = this.cards.findIndex((c) => c.id === id);
    if (index !== -1) {
      this.cards.splice(index, 1);
      this.renderQueue(id);
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
    const el = this.root.querySelector<HTMLElement>(`[data-row="${id}"]`);
    // A custom reason replaces the terse default label; the row and the detail both read
    // HistItem.note, so nothing here is hardcoded.
    const displayNote = reason?.trim() || note;
    const generation = this.connGeneration;
    const commit = () => {
      if (generation !== this.connGeneration || !this.cards.includes(card)) return;
      const item: HistItem = {
        id,
        status,
        note: displayNote,
        outcome: note,
        sql: card.sql,
        resolvedAt: Date.now(),
        connection: this.connectionName || null,
        session: card.session,
        intent: card.intent,
        result,
        approval: card.approval,
        evaluation: card.evaluation,
        autoHold: this.autoHold(card),
        // The broker's snapshot for this decision; with none posted (an expiry), what the trail
        // falls back to: the SQL text alone.
        sensitivity: card.decisionSensitivity
          ? card.decisionSensitivity.value
          : this.textSensitivity(card),
      };
      // An open card stays open as its outcome: same request, now decided. The selection holds
      // the item itself, so it outlives the Recently resolved cap while another tab shows.
      const open = this.selection.queue?.kind === "card" && this.selection.queue.id === id;
      if (open) this.selection.queue = { kind: "hist", id, item };
      this.drop(id);
      this.history.unshift(item);
      if (this.history.length > this.settingsStore.get().recentlyResolved) {
        this.history.pop();
      }
      this.enforceHistoryBudget();
      this.renderHistory();
      // The Audit Trail's open entry, if that tab shows, keeps its grid's sort and page.
      if (open && this.tab === "queue") this.renderSelection(true);
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
    let shownShed = false;
    for (const item of this.history) {
      if (!item.result || item.result.rows.length === 0) {
        continue;
      }
      const size = item.result.bytes ?? JSON.stringify(item.result.rows).length;
      if (total + size > budget) {
        item.result = { ...item.result, rows: [], truncated: true, bytes: 0 };
        shownShed ||= item.id === this.detailView.showing();
      } else {
        total += size;
      }
    }
    // The open detail lets go of rows just shed, from either tab, keeping its request and counts.
    if (shownShed) this.renderSelection(true);
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
