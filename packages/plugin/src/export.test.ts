// Periods are cut on local midnights; Paris leaves summer time on 2026-10-25, a 25-hour day.
process.env.TZ = "Europe/Paris";

import type { ActivityPage } from "@gatekeeper/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("@beekeeperstudio/plugin", () => ({ log: { error: vi.fn() }, requestFileSave: vi.fn() }));

import {
  ExportFeed,
  emptyPick,
  exportFileName,
  exportFlags,
  exportMonths,
  isTicked,
  monthStart,
  monthState,
  periodBounds,
  scopeOf,
  tickDay,
  tickMonth,
  totals,
} from "./export";
import type { ActivityEntry } from "./types";

const H = 3_600_000;
let seq = 0;

// Local wall-clock time in Paris, so a fixture lands on the day its name says.
function at(day: number, hour = 12, month = 10): number {
  return new Date(2026, month - 1, day, hour).getTime();
}

function entry(
  decidedAt: number,
  sessionId = "s1",
  extra: Partial<ActivityEntry> = {},
): ActivityEntry {
  seq++;
  return {
    id: `q_${String(seq).padStart(6, "0")}`,
    createdAt: decidedAt - 1000,
    decidedAt,
    sessionId,
    harness: null,
    project: null,
    sessionLabel: null,
    sql: "SELECT 1",
    intent: "check",
    state: "approved",
    reason: null,
    error: null,
    rowCount: 1,
    affectedRows: null,
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function broker(pages: (ActivityPage | null | Error)[]) {
  const activity = vi.fn(async (_scope?: string, _before?: unknown) => {
    const next = pages.shift();
    if (next instanceof Error) throw next;
    return next ?? null;
  });
  return { activity };
}

const NOW = new Date(2026, 9, 22, 15);
const bounds = periodBounds(NOW);

describe("periodBounds", () => {
  it("cuts calendar days on local midnights, so the day the clocks change keeps 25 hours", () => {
    const b = periodBounds(new Date(2026, 9, 25, 12));
    expect(b.end - b.today).toBe(25 * H);
    expect(new Date(b.today).getHours()).toBe(0);
    expect(new Date(b.last7).getDate()).toBe(19);
    expect(new Date(b.last7).getHours()).toBe(0);
    expect(new Date(b.month).getDate()).toBe(1);
    expect(monthStart("2026-10")).toBe(new Date(2026, 9, 1).getTime());
  });
});

describe("ExportFeed", () => {
  it("stops once a page reaches past a recent period's first day, though older pages remain", async () => {
    const page1 = [entry(at(22)), entry(at(20)), entry(at(18, 15))];
    // Oct 18 continues on the next page: the day is split across the boundary.
    const page2 = [entry(at(18, 9)), entry(at(15))];
    const b = broker([
      { activity: page1, more: true },
      { activity: page2, more: true },
      { activity: [entry(at(10))], more: false },
    ]);
    const feed = new ExportFeed(b, "scope");
    await feed.read(
      () => feed.covers(bounds.last7),
      () => {},
    );
    expect(b.activity).toHaveBeenCalledTimes(2);
    expect(b.activity.mock.calls[1][1]).toBe(page1[2]);
    expect(feed.covers(bounds.last7)).toBe(true);
    expect(feed.ended).toBe(false);
    const scope = scopeOf(feed, "last7", bounds, emptyPick());
    expect(scope.complete).toBe(true);
    // Oct 15 is before the period; both halves of Oct 18 are in it.
    expect(scope.entries.map((e) => e.id)).toEqual([...page1, page2[0]].map((e) => e.id));
    expect(totals(scope.entries)).toEqual({ queries: 4, days: 3, sessions: 1 });
  });

  it("reads one page more when the oldest decision sits exactly on the period's start", async () => {
    const start = bounds.last7;
    const b = broker([
      { activity: [entry(at(21)), entry(start)], more: true },
      { activity: [entry(start - 1)], more: true },
    ]);
    const feed = new ExportFeed(b, undefined);
    await feed.read(
      () => feed.covers(start),
      () => {},
    );
    expect(b.activity).toHaveBeenCalledTimes(2);
    expect(feed.covers(start)).toBe(true);
  });

  it("widening the target to everything continues from the last page read", async () => {
    const b = broker([
      { activity: [entry(at(21)), entry(at(10))], more: true },
      { activity: [entry(at(2))], more: true },
      { activity: [entry(at(20, 12, 9))], more: false },
    ]);
    const feed = new ExportFeed(b, undefined);
    await feed.read(
      () => feed.covers(bounds.last7),
      () => {},
    );
    expect(b.activity).toHaveBeenCalledTimes(1);
    await feed.read(
      () => false,
      () => {},
    );
    expect(b.activity).toHaveBeenCalledTimes(3);
    expect(feed.ended).toBe(true);
    expect(new Set(feed.entries.map((e) => e.id)).size).toBe(4);
    expect(scopeOf(feed, "all", bounds, emptyPick()).complete).toBe(true);
  });

  it("a target widened while a page is in flight is read by the same loop", async () => {
    const first = deferred<ActivityPage>();
    const activity = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ activity: [entry(at(1, 12, 9))], more: false });
    const feed = new ExportFeed({ activity }, undefined);
    const running = feed.read(
      () => feed.covers(bounds.today),
      () => {},
    );
    feed.read(
      () => false,
      () => {},
    );
    first.resolve({ activity: [entry(at(22)), entry(at(21))], more: true });
    await running;
    expect(activity).toHaveBeenCalledTimes(2);
    expect(feed.ended).toBe(true);
  });

  it("marks a first page without paging as a legacy broker that never covers a period", async () => {
    const feed = new ExportFeed(broker([{ activity: [entry(at(22)), entry(at(1))] }]), undefined);
    await feed.read(
      () => false,
      () => {},
    );
    expect(feed.legacy).toBe(true);
    expect(feed.covers(bounds.last7)).toBe(false);
    expect(scopeOf(feed, "last7", bounds, emptyPick()).complete).toBe(false);
  });

  it("fails on a later page without paging, an empty page claiming more, or a repeated page", async () => {
    const top = entry(at(22));
    for (const bad of [
      { activity: [entry(at(10))] },
      { activity: [], more: true },
      { activity: [top], more: true },
    ] as ActivityPage[]) {
      const feed = new ExportFeed(broker([{ activity: [top], more: true }, bad]), undefined);
      await feed.read(
        () => false,
        () => {},
      );
      expect(feed.failed).toEqual({ first: false, unreachable: false });
      expect(feed.entries).toEqual([top]);
    }
  });

  it("keeps what it read on a failure, and Retry resumes from the last page", async () => {
    const page1 = [entry(at(22)), entry(at(12))];
    const b = broker([
      { activity: page1, more: true },
      new Error("connection refused"),
      { activity: [entry(at(1))], more: false },
    ]);
    const feed = new ExportFeed(b, undefined);
    await feed.read(
      () => false,
      () => {},
    );
    expect(feed.failed).toEqual({ first: false, unreachable: true });
    // A recent period already read stays exportable while older days wait for Retry.
    expect(scopeOf(feed, "last7", bounds, emptyPick()).complete).toBe(true);
    expect(scopeOf(feed, "all", bounds, emptyPick()).complete).toBe(false);
    feed.retry();
    await feed.read(
      () => false,
      () => {},
    );
    expect(b.activity.mock.calls[2][1]).toBe(page1[1]);
    expect(feed.ended).toBe(true);
  });

  it("drops a page that lands after stop, without touching a newer read", async () => {
    const late = deferred<ActivityPage>();
    const activity = vi.fn().mockReturnValueOnce(late.promise);
    const feed = new ExportFeed({ activity }, undefined);
    const onPage = vi.fn();
    const stale = feed.read(() => false, onPage);
    feed.stop();
    late.resolve({ activity: [entry(at(22))], more: false });
    await stale;
    expect(feed.entries).toEqual([]);
    expect(onPage).not.toHaveBeenCalled();
    expect(feed.busy).toBe(false);
  });
});

describe("day picks", () => {
  it("leaves a day unticked inside a ticked month out, and ticks it back", () => {
    const pick = emptyPick();
    tickDay(pick, "2026-09-03", true);
    tickMonth(pick, "2026-09", "mixed");
    // Ticking the month absorbs the hand-ticked day.
    expect(pick.days.size).toBe(0);
    tickDay(pick, "2026-09-05", false);
    expect(isTicked(pick, "2026-09-05")).toBe(false);
    expect(isTicked(pick, "2026-09-06")).toBe(true);
    tickDay(pick, "2026-09-05", true);
    expect(pick.excluded.size).toBe(0);
  });

  it("derives a month's tick from the month, its exceptions and whether it was fully read", () => {
    const pick = emptyPick();
    const listed = ["2026-09-30", "2026-09-29"];
    expect(monthState(pick, "2026-09", listed, true)).toBe("none");
    tickDay(pick, "2026-09-30", true);
    expect(monthState(pick, "2026-09", listed, true)).toBe("mixed");
    tickDay(pick, "2026-09-29", true);
    // Every listed day ticked by hand, but older days of the month may still arrive.
    expect(monthState(pick, "2026-09", listed, false)).toBe("mixed");
    expect(monthState(pick, "2026-09", listed, true)).toBe("checked");
    tickMonth(pick, "2026-09", "mixed");
    expect(monthState(pick, "2026-09", listed, false)).toBe("checked");
    tickDay(pick, "2026-09-29", false);
    // Mixed even when every listed day is excluded: unread days of the month stay ticked.
    tickDay(pick, "2026-09-30", false);
    expect(monthState(pick, "2026-09", listed, false)).toBe("mixed");
    tickMonth(pick, "2026-09", "mixed");
    expect(pick.excluded.size).toBe(0);
    expect(monthState(pick, "2026-09", listed, false)).toBe("checked");
    tickMonth(pick, "2026-09", "checked");
    expect(monthState(pick, "2026-09", listed, false)).toBe("none");
  });

  it("lists only whole days, and a ticked month waits until reading passes its first day", async () => {
    const b = broker([
      { activity: [entry(at(22)), entry(at(3, 12, 9)), entry(at(2, 12, 9))], more: true },
      { activity: [entry(at(31, 12, 8))], more: false },
    ]);
    const feed = new ExportFeed(b, undefined);
    await feed.read(
      () => feed.entries.length > 0,
      () => {},
    );
    // Sep 2 is the oldest day read and may continue on the next page: not listed yet.
    expect(exportMonths(feed, emptyPick()).map((m) => [m.key, m.days.map((d) => d.key)])).toEqual([
      ["2026-10", ["2026-10-22"]],
      ["2026-09", ["2026-09-03"]],
    ]);
    const pick = emptyPick();
    tickMonth(pick, "2026-09", "none");
    expect(scopeOf(feed, "pick", bounds, pick).complete).toBe(false);
    await feed.read(
      () => false,
      () => {},
    );
    const scope = scopeOf(feed, "pick", bounds, pick);
    expect(scope.complete).toBe(true);
    expect(scope.entries.map((e) => new Date(e.decidedAt!).getDate())).toEqual([3, 2]);
  });
});

describe("exportFlags", () => {
  it("reads a recorded flag set as is and parses the SQL only without one", async () => {
    const recorded = entry(at(22), "s1", {
      sql: "SELECT email FROM audit.users",
      sensitivity: { pii: false, value: false, client: false },
    });
    const parsed = entry(at(22), "s1", { sql: "SELECT email FROM audit.users" });
    const flags = await exportFlags(
      [recorded, parsed],
      "postgresql",
      () => {},
      () => true,
    );
    expect(flags?.has(recorded.id)).toBe(false);
    expect(flags?.get(parsed.id)).toEqual(["PII"]);
  });

  it("works in batches it can abandon between two", async () => {
    const entries = Array.from({ length: 450 }, () => entry(at(22)));
    const progress = vi.fn();
    expect((await exportFlags(entries, "postgresql", progress, () => true))?.size).toBe(0);
    expect(progress.mock.calls).toEqual([[200], [400]]);
    let alive = true;
    const stopped = await exportFlags(
      entries,
      "postgresql",
      () => (alive = false),
      () => alive,
    );
    expect(stopped).toBeNull();
  });
});

describe("exportFileName", () => {
  it("names the connection and the first and last day of what it holds", () => {
    const entries = [entry(at(22)), entry(at(16))];
    expect(exportFileName("Billing Staging", entries, "md")).toBe(
      "gatekeeper-audit-trail-billing-staging-2026-10-16_2026-10-22.md",
    );
    expect(exportFileName("", [entries[0]], "csv")).toBe(
      "gatekeeper-audit-trail-connection-2026-10-22.csv",
    );
  });
});
