import { log, requestFileSave } from "@beekeeperstudio/plugin";
import { dayKey } from "../html";
import type { BrokerClient } from "../net/broker";
import {
  activityCsv,
  activityDaysHtml,
  activityFlagLabels,
  activityFlagsHtml,
  activityJson,
  activityMarkdown,
  activityShell,
  activityTailError,
  activityTailLoading,
} from "../render/activity";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import type { SchemaContext } from "../sql/schema";
import type { ActivityEntry } from "../types";

// How far below the overlay's fold the list end may sit and still start the next load.
const PREFETCH_PX = 240;

const dayOf = (e: ActivityEntry) => dayKey(e.decidedAt ?? e.createdAt);

// Splits newest-first entries into whole days and the oldest day, which may continue on
// the next page. With nothing older on the broker, every day is whole.
export function splitWholeDays(
  entries: ActivityEntry[],
  more: boolean,
): [whole: ActivityEntry[], partial: ActivityEntry[]] {
  if (!more || !entries.length) {
    return [entries, []];
  }
  const oldest = dayOf(entries[entries.length - 1]);
  const cut = entries.findIndex((e) => dayOf(e) === oldest);
  return [entries.slice(0, cut), entries.slice(cut)];
}

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
  // Fetched but not shown: the oldest day reached so far, held until a later page (or the
  // end of history) proves it whole, so every day on screen has its full count and export.
  private partial: ActivityEntry[] = [];
  // The broker's last answer: true while older entries exist; undefined before the first
  // page, and from a broker that predates paging.
  private more: boolean | undefined;
  private loading = false;
  private observer: IntersectionObserver | null = null;
  private frame = 0;
  // Bumped on every open, close and reset, so a slow page load or flag pass abandons
  // itself once its feed is gone rather than patching or appending stale rows.
  private gen = 0;

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
    this.stop();
    // A fresh open forgets the previous feed and which rows were expanded.
    this.activity = [];
    this.partial = [];
    this.more = undefined;
    this.activityExpanded.clear();
    panel.innerHTML = activityShell("", this.connChip());
    panel.hidden = false;
    await this.loadOlder();
  }

  close(): void {
    // Abandon any in-flight load or flag pass; its rows are about to be torn down.
    this.stop();
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
    this.partial = [];
    this.activityExpanded.clear();
    this.close();
  }

  private stop(): void {
    this.gen++;
    this.loading = false;
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.observer = null;
  }

  // Appends the next whole days. Pages repeat until one reaches past the oldest day held
  // so far, or the end of history. The list-end observer and Retry both land here.
  // ponytail: a day loads whole however many pages it spans; page inside a day if one ever holds thousands.
  async loadOlder(): Promise<void> {
    // Past the first answer, only a broker that says more exists is asked again: one that
    // predates paging ignores the cursor and would hand back its newest page a second time.
    const fresh = this.more === undefined && !this.activity.length && !this.partial.length;
    if (this.loading || !(fresh || this.more === true)) {
      return;
    }
    // Any chained load still waiting for its frame is this one now.
    cancelAnimationFrame(this.frame);
    const gen = this.gen;
    const first = !this.activity.length;
    this.loading = true;
    this.setTail(activityTailLoading());
    let whole: ActivityEntry[] = [];
    try {
      do {
        const page = await this.broker.activity(
          this.scope(),
          this.partial.at(-1) ?? this.activity.at(-1),
        );
        if (gen !== this.gen) {
          return;
        }
        if (page === null) {
          this.setTail(activityTailError(first, false));
          return;
        }
        // An empty page ends paging whatever it claims, so a confused broker cannot spin this loop.
        this.more = page.activity.length ? page.more : false;
        [whole, this.partial] = splitWholeDays(
          [...this.partial, ...page.activity],
          this.more === true,
        );
      } while (!whole.length && this.more === true);
    } catch (err) {
      if (gen !== this.gen) {
        return;
      }
      log.error(err instanceof Error ? err : String(err));
      this.setTail(activityTailError(first, true));
      return;
    } finally {
      // A stale load must not release the guard a newer generation now holds.
      if (gen === this.gen) {
        this.loading = false;
      }
    }
    this.append(whole, first);
  }

  private append(entries: ActivityEntry[], first: boolean): void {
    if (first) {
      this.activity = entries;
      this.renderActivity();
    } else {
      // Older whole days only ever go below: what the human has open above stays as is. A new
      // array, so the flag pass still walking the previous one never reaches these rows.
      this.activity = [...this.activity, ...entries];
      this.root
        .querySelector<HTMLElement>("#activity .act-body")
        ?.insertAdjacentHTML(
          "beforeend",
          activityDaysHtml(entries, this.activityExpanded, this.dialect(), false),
        );
      void this.patchFlags(entries);
    }
    this.setTail("");
    if (this.more === true) {
      this.watchTail();
    } else {
      this.observer?.disconnect();
      this.observer = null;
    }
  }

  // Loads the next days while the list end is still within PREFETCH_PX of the fold, so
  // scrolling rarely meets the placeholder rows.
  private watchTail(): void {
    const panel = this.root.querySelector<HTMLElement>("#activity");
    const tail = this.root.querySelector<HTMLElement>("#activity .act-tail");
    if (!panel || !tail) {
      return;
    }
    const gen = this.gen;
    if (!this.observer) {
      this.observer = new IntersectionObserver(
        (entries) => {
          // A callback already queued when its overlay closed must not load into the next one.
          if (gen === this.gen && entries.some((e) => e.isIntersecting)) {
            void this.loadOlder();
          }
        },
        { root: panel, rootMargin: `0px 0px ${PREFETCH_PX}px 0px` },
      );
      // observe() reports the current state at once, which covers a short first page.
      this.observer.observe(tail);
      return;
    }
    // The observer reports crossings only: a tail still in reach after an append fires
    // nothing, so chain the next load here instead.
    this.frame = requestAnimationFrame(() => {
      const t = tail.getBoundingClientRect();
      const v = panel.getBoundingClientRect();
      if (gen === this.gen && t.top < v.bottom + PREFETCH_PX && t.bottom > v.top) {
        void this.loadOlder();
      }
    });
  }

  private setActivityBody(html: string): void {
    const body = this.root.querySelector<HTMLElement>("#activity .act-body");
    if (body) {
      body.innerHTML = html;
    }
  }

  private setTail(html: string): void {
    const tail = this.root.querySelector<HTMLElement>("#activity .act-tail");
    if (tail) {
      tail.innerHTML = html;
    }
  }

  private renderActivity(): void {
    if (!this.activity.length) {
      this.setActivityBody('<p class="act-status">No activity on this connection yet.</p>');
      return;
    }
    this.setActivityBody(activityDaysHtml(this.activity, this.activityExpanded, this.dialect()));
    // The list is on screen now; the sensitivity flags fill in as the schema resolves.
    void this.patchFlags(this.activity);
  }

  // Flags need the schema, fetched (and cached) per table, so they can't be known at
  // first render. Resolve them after the fact and patch each row in place, leaving the
  // day folds and expanded rows the human may already be reading untouched.
  private async patchFlags(entries: ActivityEntry[]): Promise<void> {
    const gen = this.gen;
    for (const e of entries) {
      const schema = await this.schemaFor(e.sql);
      // A reopen, a close or a connection switch has superseded this pass.
      if (gen !== this.gen) {
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

  // Deliberate human export of one session-day's timeline via the host's save dialog, as
  // markdown, CSV, or JSON. The SQL is host-side only and no result rows are included; an
  // approved query contributes just its scalar row count.
  async exportSession(key: string, format: "md" | "csv" | "json"): Promise<void> {
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
    const data =
      format === "csv"
        ? activityCsv(entries, flags)
        : format === "json"
          ? activityJson(entries, flags)
          : activityMarkdown(day, sessionId, entries, this.connectionName(), flags);
    const filter =
      format === "csv"
        ? { name: "CSV", extensions: ["csv"] }
        : format === "json"
          ? { name: "JSON", extensions: ["json"] }
          : { name: "Markdown", extensions: ["md"] };
    try {
      await requestFileSave({
        data,
        fileName: `gatekeeper-activity-${day}-${slug}.${format === "md" ? "md" : format}`,
        encoding: "utf8",
        filters: [filter],
      });
    } catch (err) {
      log.error(err instanceof Error ? err : String(err));
    }
  }
}
