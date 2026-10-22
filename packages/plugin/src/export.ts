import { dayKey } from "./html";
import type { BrokerClient } from "./net/broker";
import { activityFlagLabels, entryFlags } from "./render/activity";
import { textSchema } from "./sql/schema";
import type { ActivityEntry } from "./types";
import { splitWholeDays } from "./views/activity";

// The Audit Trail export's model, kept free of the DOM: what has been read from the broker,
// which period or days are picked, and whether that scope is complete enough to save.

export type ExportPeriod = "today" | "last7" | "month" | "all" | "pick";
export type ExportFormat = "md" | "csv" | "json";

const at = (e: ActivityEntry) => e.decidedAt ?? e.createdAt;

// Strictly older in the broker's (decidedAt, id) order, the order its cursor pages on.
const older = (a: ActivityEntry, b: ActivityEntry) =>
  at(a) < at(b) || (at(a) === at(b) && a.id < b.id);

export interface FeedFailure {
  // The first page never arrived, so nothing is listed.
  first: boolean;
  // The broker did not answer at all, rather than answering with an error.
  unreachable: boolean;
}

// The export's own read of the trail, newest first, independent of the list's pages so the two
// never share a cursor. A loop reads toward a target and stops as soon as the target holds: a
// recent period needs only the pages that reach past its first day.
export class ExportFeed {
  entries: ActivityEntry[] = [];
  // The broker's last answer: undefined before the first page.
  more: boolean | undefined;
  // The first page came from a broker that predates paging: it may have cut the oldest day.
  legacy = false;
  failed: FeedFailure | null = null;
  private target: () => boolean = () => true;
  private onPage: () => void = () => {};
  private reading: Promise<void> | null = null;
  private gen = 0;

  private readonly broker: Pick<BrokerClient, "activity">;
  private readonly scope: string | undefined;

  constructor(broker: Pick<BrokerClient, "activity">, scope: string | undefined) {
    this.broker = broker;
    this.scope = scope;
  }

  get ended(): boolean {
    return this.more === false;
  }

  // Every decision from `start` on has been read: one strictly older was accepted, or none is
  // left. A decision at exactly `start` proves nothing, since another can share its millisecond.
  covers(start: number): boolean {
    if (this.legacy) return false;
    const oldest = this.entries.at(-1);
    return this.ended || (oldest !== undefined && at(oldest) < start);
  }

  // Days whose every decision has arrived: all but the oldest one while older pages remain.
  wholeEntries(): ActivityEntry[] {
    return splitWholeDays(this.entries, this.more === true)[0];
  }

  oldestRead(): number | null {
    const oldest = this.entries.at(-1);
    return oldest ? at(oldest) : null;
  }

  get busy(): boolean {
    return this.reading !== null;
  }

  // Reads until `target` holds, the history ends, or a page fails. A call while a read runs
  // only replaces its target, so a wider choice (All after Last 7 days) continues that read.
  read(target: () => boolean, onPage: () => void): Promise<void> {
    this.target = target;
    this.onPage = onPage;
    if (!this.reading) {
      const gen = this.gen;
      this.reading = (async () => {
        try {
          // Checked again once a loop settles, with no await before the finally: a target
          // widened while the last page landed starts another pass instead of being dropped.
          do {
            await this.loop(gen);
          } while (gen === this.gen && this.wanting());
        } finally {
          // A stale loop must not release the slot a newer generation now holds.
          if (gen === this.gen) this.reading = null;
        }
      })();
    }
    return this.reading;
  }

  private wanting(): boolean {
    return !this.failed && !this.legacy && !this.ended && !this.target();
  }

  // Drops a failure so the next read retries from the last accepted entry.
  retry(): void {
    this.failed = null;
  }

  // Abandons any read in flight: its pages are dropped when they arrive.
  stop(): void {
    this.gen++;
    this.reading = null;
  }

  private async loop(gen: number): Promise<void> {
    while (gen === this.gen && this.wanting()) {
      const cursor = this.entries.at(-1);
      const first = !cursor;
      try {
        const page = await this.broker.activity(this.scope, cursor);
        if (gen !== this.gen) return;
        if (page === null) {
          this.failed = { first, unreachable: false };
        } else if (typeof page.more !== "boolean") {
          // Without paging the single page may end mid-day; on a later page it means an old
          // broker took the port and ignored the cursor.
          if (first) this.legacy = true;
          else this.failed = { first, unreachable: false };
        } else if (!page.activity.length) {
          // An empty page that claims more would spin forever.
          if (page.more) this.failed = { first, unreachable: false };
          else this.more = false;
        } else if (cursor && !older(page.activity[0], cursor)) {
          // A page that does not start strictly older than the cursor would repeat entries.
          this.failed = { first, unreachable: false };
        } else {
          this.entries.push(...page.activity);
          this.more = page.more;
        }
      } catch {
        if (gen !== this.gen) return;
        this.failed = { first, unreachable: true };
      }
      this.onPage();
    }
  }
}

// Captured when the dialog opens: the three periods' first instants and tomorrow's, which ends
// them all. Local midnights from date components, so a day across a clock change keeps its 23
// or 25 hours.
export interface PeriodBounds {
  today: number;
  last7: number;
  month: number;
  end: number;
}

export function periodBounds(now: Date): PeriodBounds {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  return {
    today: new Date(y, m, d).getTime(),
    last7: new Date(y, m, d - 6).getTime(),
    month: new Date(y, m, 1).getTime(),
    end: new Date(y, m, d + 1).getTime(),
  };
}

// A month key (YYYY-MM) to its first local midnight.
export function monthStart(month: string): number {
  return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).getTime();
}

const monthOf = (day: string) => day.slice(0, 7);

// Choose days: days ticked one by one, and whole months ticked as calendar months (days not read
// yet included) minus the days unticked inside them.
export interface DayPick {
  days: Set<string>;
  months: Set<string>;
  excluded: Set<string>;
}

export const emptyPick = (): DayPick => ({
  days: new Set(),
  months: new Set(),
  excluded: new Set(),
});

export function isTicked(pick: DayPick, day: string): boolean {
  return pick.days.has(day) || (pick.months.has(monthOf(day)) && !pick.excluded.has(day));
}

export function tickDay(pick: DayPick, day: string, on: boolean): void {
  if (pick.months.has(monthOf(day))) {
    pick.days.delete(day);
    if (on) pick.excluded.delete(day);
    else pick.excluded.add(day);
  } else if (on) {
    pick.days.add(day);
  } else {
    pick.days.delete(day);
  }
}

export type MonthState = "checked" | "mixed" | "none";

// Checked: the month ticked whole with nothing left out, or every day of a fully read month
// ticked. Mixed: anything between, including hand-ticked days while unread days remain.
export function monthState(
  pick: DayPick,
  month: string,
  listed: string[],
  fullyRead: boolean,
): MonthState {
  if (pick.months.has(month)) {
    return [...pick.excluded].some((d) => monthOf(d) === month) ? "mixed" : "checked";
  }
  const ticked = listed.filter((d) => isTicked(pick, d)).length;
  if (!ticked) return "none";
  return ticked === listed.length && fullyRead ? "checked" : "mixed";
}

// A checked month unticks whole; an unticked or mixed one ticks whole, its exceptions cleared.
export function tickMonth(pick: DayPick, month: string, state: MonthState): void {
  for (const set of [pick.days, pick.excluded]) {
    for (const d of [...set]) if (monthOf(d) === month) set.delete(d);
  }
  if (state === "checked") pick.months.delete(month);
  else pick.months.add(month);
}

export interface ExportDay {
  key: string;
  ts: number;
  queries: number;
  sessions: number;
}

export interface ExportMonth {
  key: string;
  label: string;
  days: ExportDay[];
  state: MonthState;
  open: boolean;
}

// The whole days read so far, newest first, grouped by month for the Choose days list. A month's
// tick state needs to know whether every one of its days has been read.
export function exportMonths(feed: ExportFeed, pick: DayPick): ExportMonth[] {
  const months = new Map<
    string,
    { ts: number; days: Map<string, ExportDay & { ids: Set<string> }> }
  >();
  for (const e of feed.wholeEntries()) {
    const ts = at(e);
    const key = dayKey(ts);
    const month = months.get(monthOf(key)) ?? { ts, days: new Map() };
    months.set(monthOf(key), month);
    const day = month.days.get(key) ?? { key, ts, queries: 0, sessions: 0, ids: new Set<string>() };
    month.days.set(key, day);
    day.queries++;
    day.ids.add(e.sessionId);
    day.sessions = day.ids.size;
  }
  return [...months].map(([key, m]) => {
    const days = [...m.days.values()].map(({ ids: _ids, ...d }) => d);
    return {
      key,
      label: new Date(m.ts).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      days,
      state: monthState(
        pick,
        key,
        days.map((d) => d.key),
        feed.covers(monthStart(key)),
      ),
      open: false,
    };
  });
}

export interface ExportScope {
  entries: ActivityEntry[];
  // Every decision the scope covers has been read, so its counts and its file are final.
  complete: boolean;
}

export function scopeOf(
  feed: ExportFeed,
  period: ExportPeriod,
  bounds: PeriodBounds,
  pick: DayPick,
): ExportScope {
  if (period === "all") {
    return { entries: feed.entries, complete: feed.ended };
  }
  if (period === "pick") {
    // Only whole days are listed, so a ticked day is complete; a ticked month waits for its start.
    const complete = [...pick.months].every((m) => feed.covers(monthStart(m)));
    return {
      entries: feed.wholeEntries().filter((e) => isTicked(pick, dayKey(at(e)))),
      complete,
    };
  }
  const start = bounds[period];
  return {
    entries: feed.entries.filter((e) => at(e) >= start && at(e) < bounds.end),
    complete: feed.covers(start),
  };
}

export function totals(entries: ActivityEntry[]): {
  queries: number;
  days: number;
  sessions: number;
} {
  return {
    queries: entries.length,
    days: new Set(entries.map((e) => dayKey(at(e)))).size,
    sessions: new Set(entries.map((e) => e.sessionId)).size,
  };
}

// The sensitivity labels the row chips show, per entry. A recorded flag set is read as is; only
// an entry without one parses its SQL, in batches that let the dialog repaint between them.
export async function exportFlags(
  entries: ActivityEntry[],
  dialect: string,
  progress: (done: number) => void,
  alive: () => boolean,
): Promise<Map<string, string[]> | null> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const found = entryFlags(e, null) ?? entryFlags(e, textSchema(e.sql, dialect));
    const labels = found ? activityFlagLabels(found) : [];
    if (labels.length) flags.set(e.id, labels);
    if ((i + 1) % 200 === 0 && i + 1 < entries.length) {
      progress(i + 1);
      await new Promise((resolve) => setTimeout(resolve));
      if (!alive()) return null;
    }
  }
  return flags;
}

// gatekeeper-audit-trail-<connection>-<first day>[_<last day>].<ext>, from the entries' own days.
export function exportFileName(
  connection: string,
  entries: ActivityEntry[],
  format: ExportFormat,
): string {
  const slug =
    connection
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "connection";
  const days = entries.map((e) => dayKey(at(e))).sort();
  const first = days[0];
  const last = days.at(-1);
  const range = first === last ? first : `${first}_${last}`;
  return `gatekeeper-audit-trail-${slug}-${range}.${format}`;
}
