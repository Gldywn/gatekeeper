import { log, requestFileSave } from "@beekeeperstudio/plugin";
import { dayKey } from "../html";
import type { BrokerClient } from "../net/broker";
import {
  activityCsv,
  activityDaysHtml,
  activityFlagLabels,
  activityFlagsHtml,
  activityMarkdown,
  activityShell,
} from "../render/activity";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import type { SchemaContext } from "../sql/schema";
import type { ActivityEntry } from "../types";

interface ActivityViewDeps {
  root: HTMLElement;
  broker: BrokerClient;
  connectionName: () => string;
  // Raw connection name for the broker's scope header, which unlike the display
  // connectionName has no databaseName/"connection" fallback.
  scope: () => string | undefined;
  // The audit-trail head's connection chip, built from the live snapshot by app.ts.
  connChip: () => string;
  // Host-side schema resolver (app's annotator): null when the SQL won't parse,
  // undefined when a connection switch invalidated the fetch mid-flight.
  schemaFor: (sql: string) => Promise<SchemaContext | null | undefined>;
  // The connection dialect, so each entry's read/write/destructive class can be parsed.
  dialect: () => string;
}

// Owns the connection-scoped activity overlay (#activity): a durable, PII-safe audit
// of what ran on this connection. Holds the fetched feed and which rows are expanded;
// reuses the .detail overlay chrome and is refreshed on every open.
export class ActivityView {
  // The durable activity feed, fetched fresh each time the overlay opens; the set
  // tracks which entries have their full SQL expanded in place.
  private activity: ActivityEntry[] = [];
  private readonly activityExpanded = new Set<string>();
  private readonly root: HTMLElement;
  private readonly broker: BrokerClient;
  private readonly connectionName: () => string;
  private readonly scope: () => string | undefined;
  private readonly connChip: () => string;
  private readonly schemaFor: (sql: string) => Promise<SchemaContext | null | undefined>;
  private readonly dialect: () => string;
  // Bumped on every open and on close, so a slow flag pass abandons itself once its
  // feed is gone (a reopen or a connection switch) rather than patching stale rows.
  private flagGen = 0;

  constructor(deps: ActivityViewDeps) {
    this.root = deps.root;
    this.broker = deps.broker;
    this.connectionName = deps.connectionName;
    this.scope = deps.scope;
    this.connChip = deps.connChip;
    this.schemaFor = deps.schemaFor;
    this.dialect = deps.dialect;
  }

  async open(): Promise<void> {
    const panel = this.root.querySelector<HTMLDivElement>("#activity");
    if (!panel) {
      return;
    }
    // A fresh open forgets which rows were expanded last time.
    this.activityExpanded.clear();
    panel.innerHTML = activityShell(
      '<p class="act-status">Loading audit trail...</p>',
      this.connChip(),
    );
    panel.hidden = false;
    await this.loadActivity();
  }

  close(): void {
    // Abandon any in-flight flag pass; its rows are about to be torn down.
    this.flagGen++;
    const panel = this.root.querySelector<HTMLDivElement>("#activity");
    if (panel && !panel.hidden) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }

  // Connection switch: drop the feed and close the overlay, which now shows a
  // different connection's audit trail.
  reset(): void {
    this.activity = [];
    this.activityExpanded.clear();
    this.close();
  }

  private async loadActivity(): Promise<void> {
    const panel = this.root.querySelector<HTMLDivElement>("#activity");
    if (!panel || panel.hidden) {
      return;
    }
    try {
      const activity = await this.broker.activity(this.scope());
      if (activity === null) {
        this.setActivityBody('<p class="act-status">Could not load activity.</p>');
        return;
      }
      this.activity = activity;
      this.renderActivity();
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
      this.setActivityBody('<p class="act-status">Broker unreachable.</p>');
    }
  }

  private setActivityBody(html: string): void {
    const body = this.root.querySelector<HTMLElement>("#activity .act-body");
    if (body) {
      body.innerHTML = html;
    }
  }

  private renderActivity(): void {
    if (!this.activity.length) {
      this.setActivityBody('<p class="act-status">No activity on this connection yet.</p>');
      return;
    }
    this.setActivityBody(activityDaysHtml(this.activity, this.activityExpanded, this.dialect()));
    // The list is on screen now; the sensitivity flags fill in as the schema resolves.
    void this.patchFlags();
  }

  // Flags need the schema, fetched (and cached) per table, so they can't be known at
  // first render. Resolve them after the fact and patch each row in place, leaving the
  // day folds and expanded rows the human may already be reading untouched.
  private async patchFlags(): Promise<void> {
    const gen = ++this.flagGen;
    for (const e of this.activity) {
      const schema = await this.schemaFor(e.sql);
      // A newer pass, a reopen, or a connection switch has superseded this one.
      if (gen !== this.flagGen) {
        return;
      }
      // null: the SQL would not parse. undefined: a switch invalidated the fetch.
      if (!schema) {
        continue;
      }
      // Light the sensitive columns/values in the SQL, exactly as the pending card and the
      // detail do, so the audit trail stops dropping the red the schema already knows about.
      const code = this.root.querySelector<HTMLElement>(
        `#activity [data-act-sqlbody="${CSS.escape(e.id)}"]`,
      );
      if (code) {
        code.innerHTML = highlight(formatSql(e.sql), schema.pii, schema.client, schema.literals);
      }
      const html = activityFlagsHtml(schema);
      if (!html) {
        continue;
      }
      const el = this.root.querySelector<HTMLElement>(
        `#activity [data-act-flags="${CSS.escape(e.id)}"]`,
      );
      if (el) {
        el.innerHTML = html;
      }
    }
  }

  // Fold a day open or closed in place: days are pure DOM state, so nothing here
  // touches the fetched feed or the expanded-row set.
  toggleDay(head: HTMLElement): void {
    const day = head.closest<HTMLElement>(".act-day");
    if (!day) {
      return;
    }
    const collapsed = day.classList.toggle("collapsed");
    head.setAttribute("aria-expanded", String(!collapsed));
  }

  // Toggle a single entry's full SQL in place so expanding one row never rebuilds
  // the list or loses the scroll position.
  toggle(id: string): void {
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

  // Deliberate human export of one session-day's timeline via the host's save dialog,
  // as markdown or CSV. The SQL is host-side only and no result rows are included; an
  // approved query contributes just its scalar row count.
  async exportSession(key: string, format: "md" | "csv"): Promise<void> {
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
    // Sensitivity flags are not stored on the entry: resolve them from the same cached
    // schema the row chips use. A parse miss or a mid-flight switch just leaves it blank.
    const flags = new Map<string, string[]>();
    for (const e of entries) {
      const schema = await this.schemaFor(e.sql);
      const labels = schema ? activityFlagLabels(schema) : [];
      if (labels.length) {
        flags.set(e.id, labels);
      }
    }
    const first = entries[0];
    const who = (first.project?.trim() || first.harness?.trim() || sessionId).toLowerCase();
    const slug = who.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "session";
    const csv = format === "csv";
    try {
      await requestFileSave({
        data: csv
          ? activityCsv(entries, flags)
          : activityMarkdown(day, sessionId, entries, this.connectionName(), flags),
        fileName: `gatekeeper-activity-${day}-${slug}.${csv ? "csv" : "md"}`,
        encoding: "utf8",
        filters: [
          csv ? { name: "CSV", extensions: ["csv"] } : { name: "Markdown", extensions: ["md"] },
        ],
      });
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }
}
