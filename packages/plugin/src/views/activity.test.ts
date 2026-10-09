// Days are grouped on local dates; pin the zone so the fixtures land on the same day anywhere.
process.env.TZ = "UTC";

import type { ActivityPage } from "@gatekeeper/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerClient } from "../net/broker";
import type { ActivityEntry } from "../types";

vi.mock("@beekeeperstudio/plugin", () => ({ log: { error: vi.fn() }, requestFileSave: vi.fn() }));

import { ActivityView, splitWholeDays } from "./activity";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 9, 12);
let seq = 0;

// Created newest first: each call is older than the previous one on the same day.
function entry(daysAgo: number): ActivityEntry {
  seq++;
  const decidedAt = T0 - daysAgo * DAY - seq * 1000;
  return {
    id: `req_${seq.toString(16).padStart(12, "0")}`,
    createdAt: decidedAt - 500,
    decidedAt,
    sessionId: "s1",
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

class FakeObserver {
  static current: FakeObserver | null = null;
  disconnected = false;
  constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) {
    FakeObserver.current = this;
  }
  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

function element() {
  return {
    innerHTML: "",
    hidden: true,
    insertAdjacentHTML(_where: string, html: string) {
      this.innerHTML += html;
    },
  };
}

const frames = new Map<number, () => void>();
let frameId = 0;
let tailTop = 500;

function harness() {
  const panel = { ...element(), getBoundingClientRect: () => ({ top: 0, bottom: 800 }) };
  const body = element();
  const tail = {
    ...element(),
    getBoundingClientRect: () => ({ top: tailTop, bottom: tailTop }),
  };
  const nodes: Record<string, unknown> = {
    "#activity": panel,
    "#activity .act-body": body,
    "#activity .act-tail": tail,
  };
  const activity = vi.fn<(scope?: string, before?: unknown) => Promise<ActivityPage | null>>();
  const view = new ActivityView({
    root: { querySelector: (sel: string) => nodes[sel] ?? null } as unknown as HTMLElement,
    broker: { activity } as unknown as BrokerClient,
    connectionName: () => "conn",
    scope: () => "scope",
    connChip: () => "",
    schemaFor: async () => null,
    dialect: () => "postgresql",
  });
  const days = () => [...body.innerHTML.matchAll(/data-day="([^"]+)"/g)].map((m) => m[1]);
  return { view, activity, body, tail, days };
}

const runFrames = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const frame of pending) {
    frame();
  }
};

beforeEach(() => {
  seq = 0;
  frames.clear();
  tailTop = 500;
  FakeObserver.current = null;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.set(++frameId, cb);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

describe("splitWholeDays", () => {
  it("holds back the oldest day while older entries exist", () => {
    const [a, b, c] = [entry(0), entry(0), entry(1)];
    expect(splitWholeDays([a, b, c], true)).toEqual([[a, b], [c]]);
    expect(splitWholeDays([a, b, c], false)).toEqual([[a, b, c], []]);
    expect(splitWholeDays([a, b], true)).toEqual([[], [a, b]]);
  });
});

describe("ActivityView paging", () => {
  it("fetches past a day spanning several pages and shows that day once, whole", async () => {
    const { view, activity, days } = harness();
    const p1 = [entry(0), entry(0)];
    const p2 = [entry(0), entry(0)];
    const p3 = [entry(0), entry(1)];
    activity
      .mockResolvedValueOnce({ activity: p1, more: true })
      .mockResolvedValueOnce({ activity: p2, more: true })
      .mockResolvedValueOnce({ activity: p3, more: true });
    await view.open();
    expect(activity).toHaveBeenCalledTimes(3);
    expect(activity.mock.calls[1][1]).toBe(p1[1]);
    expect(activity.mock.calls[2][1]).toBe(p2[1]);
    expect(days()).toEqual(["2026-10-09"]);
    expect(FakeObserver.current?.disconnected).toBe(false);
  });

  it("keeps a failed page's progress, ends on a retry row, and resumes from it", async () => {
    const { view, activity, body, tail, days } = harness();
    const held = entry(1);
    activity.mockResolvedValueOnce({ activity: [entry(0), held], more: true });
    await view.open();
    const shown = body.innerHTML;

    activity.mockRejectedValueOnce(new TypeError("fetch failed"));
    await view.loadOlder();
    expect(tail.innerHTML).toContain("The broker did not answer.");
    expect(tail.innerHTML).toContain("data-act-retry");
    expect(body.innerHTML).toBe(shown);
    // A failure schedules nothing: only Retry or a fresh scroll into view tries again.
    expect(frames.size).toBe(0);

    activity.mockResolvedValueOnce({ activity: [entry(2)], more: false });
    await view.loadOlder();
    expect(activity.mock.calls[2][1]).toBe(held);
    expect(days()).toEqual(["2026-10-09", "2026-10-08", "2026-10-07"]);
    expect(tail.innerHTML).toBe("");
    expect(FakeObserver.current?.disconnected).toBe(true);
  });

  it("treats an empty page as the end, even one claiming more", async () => {
    const { view, activity, days } = harness();
    activity
      .mockResolvedValueOnce({ activity: [entry(0), entry(1)], more: true })
      .mockResolvedValueOnce({ activity: [], more: true });
    await view.open();
    await view.loadOlder();
    expect(activity).toHaveBeenCalledTimes(2);
    expect(days()).toEqual(["2026-10-09", "2026-10-08"]);
    expect(FakeObserver.current?.disconnected).toBe(true);
  });

  it("loads once when the list end and Retry fire together", async () => {
    const { view, activity } = harness();
    activity.mockResolvedValueOnce({ activity: [entry(0), entry(1)], more: true });
    await view.open();
    const page = deferred<ActivityPage>();
    activity.mockReturnValueOnce(page.promise);
    FakeObserver.current?.callback([{ isIntersecting: true }]);
    void view.loadOlder();
    expect(activity).toHaveBeenCalledTimes(2);
    page.resolve({ activity: [entry(2)], more: false });
  });

  it("drops a page that lands after a reopen, without freeing the newer load's guard", async () => {
    const { view, activity, days } = harness();
    activity.mockResolvedValueOnce({ activity: [entry(0), entry(1)], more: true });
    await view.open();
    const stale = deferred<ActivityPage>();
    activity.mockReturnValueOnce(stale.promise);
    void view.loadOlder();

    const fresh = deferred<ActivityPage>();
    activity.mockReturnValueOnce(fresh.promise);
    const reopened = view.open();
    stale.resolve({ activity: [entry(5)], more: false });
    await stale.promise;
    void view.loadOlder();
    expect(activity).toHaveBeenCalledTimes(3);

    fresh.resolve({ activity: [entry(0)], more: false });
    await reopened;
    expect(days()).toEqual(["2026-10-09"]);
  });

  it("chains loads while the list end stays in reach, and stops once it leaves", async () => {
    const { view, activity } = harness();
    activity
      .mockResolvedValueOnce({ activity: [entry(0), entry(1)], more: true })
      .mockResolvedValueOnce({ activity: [entry(1), entry(2)], more: true })
      .mockResolvedValueOnce({ activity: [entry(2), entry(3)], more: true });
    await view.open();
    await view.loadOlder();
    expect(frames.size).toBe(1);

    runFrames();
    await vi.waitFor(() => expect(frames.size).toBe(1));
    expect(activity).toHaveBeenCalledTimes(3);

    tailTop = 2000;
    runFrames();
    expect(activity).toHaveBeenCalledTimes(3);
  });

  it("cancels a chained load queued before a later load failed", async () => {
    const { view, activity } = harness();
    activity
      .mockResolvedValueOnce({ activity: [entry(0), entry(1)], more: true })
      .mockResolvedValueOnce({ activity: [entry(1), entry(2)], more: true })
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    await view.open();
    await view.loadOlder();
    expect(frames.size).toBe(1);
    // The list end scrolls into view before that frame runs, and this load fails.
    await view.loadOlder();
    runFrames();
    expect(activity).toHaveBeenCalledTimes(3);
  });

  it("ignores an observer callback that outlived its overlay", async () => {
    const { view, activity } = harness();
    activity.mockResolvedValueOnce({ activity: [entry(0), entry(1)], more: true });
    await view.open();
    const stale = FakeObserver.current!;
    view.close();
    stale.callback([{ isIntersecting: true }]);
    expect(activity).toHaveBeenCalledTimes(1);

    activity.mockResolvedValueOnce({ activity: [entry(2)], more: false });
    await view.open();
    stale.callback([{ isIntersecting: true }]);
    expect(activity).toHaveBeenCalledTimes(2);
  });

  it("offers Retry when the first load fails, and resumes from the day it held", async () => {
    const { view, activity, body, tail, days } = harness();
    const held = [entry(0), entry(0)];
    activity
      .mockResolvedValueOnce({ activity: held, more: true })
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    await view.open();
    expect(body.innerHTML).toBe("");
    expect(tail.innerHTML).toContain("The audit trail did not load.");
    expect(tail.innerHTML).toContain("data-act-retry");

    activity.mockResolvedValueOnce({ activity: [entry(0), entry(1)], more: false });
    await view.loadOlder();
    expect(activity.mock.calls[2][1]).toBe(held[1]);
    expect(days()).toEqual(["2026-10-09", "2026-10-08"]);
    expect(tail.innerHTML).toBe("");
  });

  it("shows a pre-paging broker's single page and never asks it again", async () => {
    const { view, activity, days } = harness();
    activity.mockResolvedValueOnce({ activity: [entry(0), entry(1)] });
    await view.open();
    expect(days()).toEqual(["2026-10-09", "2026-10-08"]);
    expect(FakeObserver.current).toBeNull();
    await view.loadOlder();
    expect(activity).toHaveBeenCalledTimes(1);
  });

  it("drops a chained load queued before the overlay closed", async () => {
    const { view, activity } = harness();
    activity
      .mockResolvedValueOnce({ activity: [entry(0), entry(1)], more: true })
      .mockResolvedValueOnce({ activity: [entry(1), entry(2)], more: true });
    await view.open();
    await view.loadOlder();
    view.close();
    runFrames();
    expect(activity).toHaveBeenCalledTimes(2);
  });
});
