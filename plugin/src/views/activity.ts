import { log, requestFileSave } from "@beekeeperstudio/plugin";
import { dayKey } from "../html";
import type { BrokerClient } from "../net/broker";
import { activityDaysHtml, activityMarkdown, activityShell } from "../render/activity";
import type { ActivityEntry } from "../types";

interface ActivityViewDeps {
  root: HTMLElement;
  broker: BrokerClient;
  connectionName: () => string;
  // Raw connection name for the broker's scope header, which unlike the display
  // connectionName has no databaseName/"connection" fallback.
  scope: () => string | undefined;
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

  constructor(deps: ActivityViewDeps) {
    this.root = deps.root;
    this.broker = deps.broker;
    this.connectionName = deps.connectionName;
    this.scope = deps.scope;
  }

  async open(): Promise<void> {
    const panel = this.root.querySelector<HTMLDivElement>("#activity");
    if (!panel) {
      return;
    }
    // A fresh open forgets which rows were expanded last time.
    this.activityExpanded.clear();
    panel.innerHTML = activityShell(
      '<p class="act-status">Loading activity...</p>',
      this.connectionName(),
    );
    panel.hidden = false;
    await this.loadActivity();
  }

  close(): void {
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
    this.setActivityBody(
      this.activity.length
        ? activityDaysHtml(this.activity, this.activityExpanded)
        : '<p class="act-status">No activity on this connection yet.</p>',
    );
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

  // Deliberate human export: write one session-day's timeline as markdown via the
  // host's save dialog. The SQL is host-side only and no result rows are included;
  // an approved query contributes just its scalar row count.
  async exportSession(key: string): Promise<void> {
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
        data: activityMarkdown(day, sessionId, entries, this.connectionName()),
        fileName: `gatekeeper-activity-${day}-${slug}.md`,
        encoding: "utf8",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }
}
