import { log, requestFileSave } from "@beekeeperstudio/plugin";
import { dayKey } from "../html";
import type { BrokerClient } from "../net/broker";
import {
  activityCsv,
  activityDayBodyHtml,
  activityDayChunks,
  activityDaysHtml,
  activityFlagLabels,
  activityJson,
  activityMarkdown,
  activityMonthHtml,
  activityShell,
  activityTailError,
  activityTailLoading,
  activityTailMore,
  entryFlags,
} from "../render/activity";
import { textSchema } from "../sql/schema";
import type { ActivityEntry } from "../types";

// How far below the pane's fold the list end may sit and still start the next load.
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
  // The connection dialect, so each entry's read/write/destructive class can be parsed.
  dialect: () => string;
  // The entry open in the Inbox's right pane, marked as current in the list.
  selected: () => string | null;
}

// Owns the connection-scoped Audit Trail in the Inbox's left pane (#listAudit): a durable,
// PII-safe audit of what ran on this connection. Holds the fetched feed; refreshed every time
// the tab opens.
export class ActivityView {
  // The durable activity feed, fetched fresh each time the tab opens.
  private activity: ActivityEntry[] = [];
  private readonly root: HTMLElement;
  private readonly broker: BrokerClient;
  private readonly connectionName: () => string;
  private readonly scope: () => string | undefined;
  private readonly dialect: () => string;
  private readonly selected: () => string | null;
  // Fetched but not shown: the oldest day reached so far, held until a later page (or the
  // end of history) proves it whole, so every day on screen has its full count and export.
  private partial: ActivityEntry[] = [];
  // The broker's last answer: true while older entries exist; undefined before the first
  // page, and from a broker that predates paging.
  private more: boolean | undefined;
  private loading = false;
  private observer: IntersectionObserver | null = null;
  private frame = 0;
  // Bumped on every open, close and reset, so a slow page load abandons itself once its
  // feed is gone rather than appending stale rows.
  private gen = 0;

  constructor(deps: ActivityViewDeps) {
    this.root = deps.root;
    this.broker = deps.broker;
    this.connectionName = deps.connectionName;
    this.scope = deps.scope;
    this.dialect = deps.dialect;
    this.selected = deps.selected;
  }

  async open(): Promise<void> {
    const panel = this.root.querySelector<HTMLDivElement>("#listAudit");
    if (!panel) {
      return;
    }
    this.stop();
    this.activity = [];
    this.partial = [];
    this.more = undefined;
    panel.innerHTML = activityShell();
    await this.loadOlder();
  }

  close(): void {
    // Abandon any in-flight load; its rows are about to be torn down.
    this.stop();
    const panel = this.root.querySelector<HTMLDivElement>("#listAudit");
    if (panel) {
      panel.innerHTML = "";
    }
  }

  // Connection switch: drop the feed, which belonged to the previous connection.
  reset(): void {
    this.activity = [];
    this.partial = [];
    this.close();
  }

  // An entry already on screen, for the right pane.
  entry(id: string): ActivityEntry | undefined {
    return this.activity.find((e) => e.id === id);
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
        const cursor = this.partial.at(-1) ?? this.activity.at(-1);
        const page = await this.broker.activity(this.scope(), cursor);
        if (gen !== this.gen) {
          return;
        }
        // A cursor answered without `more` means a broker that predates paging took the port:
        // it ignored the cursor and sent its newest page, which must never be appended again.
        if (page === null || (cursor && typeof page.more !== "boolean")) {
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
      // Older whole days only ever go below: what the human has open above stays as is. A
      // page that continues a month already shown lands inside that month, not under a twin.
      this.activity.push(...entries);
      const body = this.root.querySelector<HTMLElement>("#listAudit .act-body");
      for (const chunk of activityDayChunks(entries, this.selected(), this.dialect(), false)) {
        const month =
          chunk.month &&
          body?.querySelector<HTMLElement>(
            `.act-month[data-month-key="${chunk.month}"] .act-month-body`,
          );
        if (month) {
          month.insertAdjacentHTML("beforeend", chunk.html);
        } else {
          body?.insertAdjacentHTML(
            "beforeend",
            chunk.month ? activityMonthHtml(chunk) : chunk.html,
          );
        }
      }
    }
    this.setTail(this.more === true ? activityTailMore() : "");
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
    const panel = this.root.querySelector<HTMLElement>("#listAudit");
    const tail = this.root.querySelector<HTMLElement>("#listAudit .act-tail");
    if (!panel || !tail) {
      return;
    }
    const gen = this.gen;
    if (!this.observer) {
      this.observer = new IntersectionObserver(
        (entries) => {
          // A callback already queued when its list closed must not load into the next one.
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
    const body = this.root.querySelector<HTMLElement>("#listAudit .act-body");
    if (body) {
      body.innerHTML = html;
    }
  }

  private setTail(html: string): void {
    const tail = this.root.querySelector<HTMLElement>("#listAudit .act-tail");
    if (tail) {
      tail.innerHTML = html;
    }
  }

  private renderActivity(): void {
    if (!this.activity.length) {
      this.setActivityBody('<p class="act-status">No activity on this connection yet.</p>');
      return;
    }
    this.setActivityBody(activityDaysHtml(this.activity, this.selected(), this.dialect()));
  }

  // Fold a past month open or closed; its days keep their own state inside.
  toggleMonth(head: HTMLElement): void {
    const month = head.closest<HTMLElement>(".act-month");
    if (month) {
      head.setAttribute("aria-expanded", String(!month.classList.toggle("collapsed")));
    }
  }

  // Fold a day open or closed in place. A day that arrived folded has no rows yet: build
  // them the first time it opens, leaving every other day untouched.
  toggleDay(head: HTMLElement): void {
    const day = head.closest<HTMLElement>(".act-day");
    if (!day) {
      return;
    }
    const collapsed = day.classList.toggle("collapsed");
    head.setAttribute("aria-expanded", String(!collapsed));
    const body = day.querySelector<HTMLElement>(".act-day-body");
    const key = head.getAttribute("data-day");
    if (!collapsed && body && !body.childElementCount && key) {
      body.innerHTML = activityDayBodyHtml(
        key,
        this.activity.filter((e) => dayOf(e) === key),
        this.selected(),
        this.dialect(),
      );
    }
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
    const entries = this.activity.filter((e) => e.sessionId === sessionId && dayOf(e) === day);
    if (!entries.length) {
      return;
    }
    // The same flags the row chips show, computed locally before the only await below, so a
    // connection switch can no longer land between the entries and their labels.
    const dialect = this.dialect();
    const flags = new Map<string, string[]>();
    for (const e of entries) {
      const found = entryFlags(e, textSchema(e.sql, dialect));
      const labels = found ? activityFlagLabels(found) : [];
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
