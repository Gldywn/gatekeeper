process.env.TZ = "UTC";

import type { ActivityPage } from "@gatekeeper/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry } from "../types";

const save = vi.hoisted(() => vi.fn());
vi.mock("@beekeeperstudio/plugin", () => ({ log: { error: vi.fn() }, requestFileSave: save }));

import { ExportDialog } from "./export";

const NOW = Date.UTC(2026, 9, 22, 15);

function entry(id: string, hoursAgo: number): ActivityEntry {
  const decidedAt = NOW - hoursAgo * 3_600_000;
  return {
    id,
    createdAt: decidedAt - 1000,
    decidedAt,
    sessionId: "s1",
    harness: "claude-code",
    project: "billing-api",
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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

// Plain objects stand in for the overlay and the few controls the dialog updates in place.
function harness(activity: (scope?: string, before?: unknown) => Promise<ActivityPage | null>) {
  const node = () => ({
    innerHTML: "",
    hidden: false,
    disabled: false,
    textContent: "",
    focus: vi.fn(),
  });
  const body = node();
  const retry = node();
  const doc: { activeElement: unknown } = { activeElement: body };
  // The Retry row lives in #exFeed: emptying it removes a focused Retry, as the browser would.
  let feedHtml = "";
  const feed = {
    ...node(),
    get innerHTML() {
      return feedHtml;
    },
    set innerHTML(html: string) {
      feedHtml = html;
      if (!html.includes("data-act-retry") && doc.activeElement === retry) {
        doc.activeElement = body;
      }
    },
  };
  const parts: Record<string, ReturnType<typeof node>> = {
    "#exStatus": node(),
    "[data-export-go]": node(),
    "#exForm": node(),
    "#exFeed": feed,
    '[data-export-when="all"]': node(),
    'input[name="exPeriod"]:checked': node(),
    "[data-export-close]": node(),
    "[data-act-retry]": retry,
  };
  const panel = {
    hidden: true,
    innerHTML: "",
    ownerDocument: doc,
    contains: (el: unknown) => el !== body && el !== null,
    querySelector: (sel: string) => (panel.innerHTML ? (parts[sel] ?? null) : null),
  };
  const handlers: Record<string, ((e: unknown) => void)[]> = {};
  const root = {
    querySelector: (sel: string) => (sel === "#export" ? panel : null),
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      handlers[type] = [...(handlers[type] ?? []), fn];
    },
  };
  const broker = vi.fn(activity);
  const dialog = new ExportDialog({
    root: root as unknown as HTMLElement,
    broker: { activity: broker },
    scope: () => "scope",
    connectionName: () => "billing-staging",
    databaseType: () => "postgresql",
  });
  // A click on one control, as the delegated listener sees it.
  const click = (selector: string) => {
    const target = {
      closest: (sel: string) => (sel === "#export" ? panel : sel === selector ? parts[sel] : null),
    };
    for (const fn of handlers.click ?? []) fn({ target, shiftKey: false });
  };
  const choosePeriod = (value: string) => {
    const target = {
      name: "exPeriod",
      value,
      dataset: {},
      closest: (sel: string) => (sel === "#export" ? panel : null),
    };
    for (const fn of handlers.change ?? []) fn({ target });
  };
  return { dialog, panel, parts, doc, retry, broker, click, choosePeriod };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  save.mockReset();
});

describe("ExportDialog", () => {
  it("drops a page that lands after it closed, and reads afresh when reopened", async () => {
    const late = deferred<ActivityPage>();
    const activity = vi
      .fn()
      .mockReturnValueOnce(late.promise)
      .mockResolvedValue({ activity: [], more: false });
    const { dialog, panel, parts } = harness(activity);
    dialog.open();
    expect(panel.hidden).toBe(false);
    expect(dialog.close()).toBe(true);
    expect(dialog.close()).toBe(false);
    late.resolve({ activity: [entry("q1", 1)], more: false });
    await flush();
    expect(panel.innerHTML).toBe("");
    expect(parts["#exStatus"].innerHTML).not.toContain("1</b> query");
    dialog.open();
    await flush();
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity.mock.calls[1][1]).toBeUndefined();
  });

  it("saves what its button named, then closes", async () => {
    const { dialog, panel, parts, click } = harness(async () => ({
      activity: [entry("q2", 2), entry("q1", 30)],
      more: false,
    }));
    save.mockResolvedValue(undefined);
    dialog.open();
    await flush();
    expect(parts["[data-export-go]"].textContent).toBe("Export 2 queries");
    expect(parts["[data-export-go]"].disabled).toBe(false);
    click("[data-export-go]");
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    const args = save.mock.calls[0][0];
    expect(args.fileName).toBe("gatekeeper-audit-trail-billing-staging-2026-10-21_2026-10-22.md");
    expect(args.data).toContain("# Gatekeeper Audit Trail");
    expect(args.data).toContain("- Request: q1");
    expect(args.data).not.toContain('"rows"');
    expect(panel.hidden).toBe(true);
  });

  it("stays open with the host's error when the save fails, and can try again", async () => {
    const { dialog, panel, parts, click } = harness(async () => ({
      activity: [entry("q1", 1)],
      more: false,
    }));
    save.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    dialog.open();
    await flush();
    click("[data-export-go]");
    await flush();
    expect(panel.hidden).toBe(false);
    expect(parts["#exStatus"].innerHTML).toContain("The file could not be saved.");
    expect(parts["#exStatus"].innerHTML).toContain("EACCES: permission denied");
    expect(parts["#exForm"].disabled).toBe(false);
    expect(parts["[data-export-go]"].disabled).toBe(false);
  });

  it("Retry asks again for the page that failed, even with the period already whole", async () => {
    const page1 = [entry("q2", 1), entry("q1", 216)];
    const activity = vi
      .fn()
      .mockResolvedValueOnce({ activity: page1, more: true })
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ activity: [entry("q0", 400)], more: false });
    const { dialog, parts, broker, click, choosePeriod } = harness(activity);
    dialog.open();
    await flush();
    expect(broker).toHaveBeenCalledTimes(1);
    // Everything reads on, and its next page fails.
    choosePeriod("all");
    await flush();
    expect(parts["#exStatus"].innerHTML).toContain("Every older day must load");
    // Back on Last 7 days the scope is whole, and Retry stays in view for the older days.
    choosePeriod("last7");
    expect(parts["[data-export-go]"].textContent).toBe("Export 1 query");
    expect(parts["#exFeed"].innerHTML).toContain("data-act-retry");
    click("[data-act-retry]");
    await flush();
    expect(broker).toHaveBeenCalledTimes(3);
    expect(broker.mock.calls[2][1]).toBe(page1[1]);
    expect(parts["#exFeed"].innerHTML).toContain("data-act-retry");
    click("[data-act-retry]");
    await flush();
    expect(broker).toHaveBeenCalledTimes(4);
    expect(broker.mock.calls[3][1]).toBe(page1[1]);
    expect(parts["#exFeed"].innerHTML).toBe("");
  });

  it("keeps the focus in the dialog when the focused Retry goes away", async () => {
    const activity = vi
      .fn()
      .mockResolvedValueOnce({ activity: [entry("q2", 1), entry("q1", 216)], more: true })
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ activity: [entry("q0", 400)], more: false });
    const { dialog, parts, doc, retry, click, choosePeriod } = harness(activity);
    dialog.open();
    await flush();
    choosePeriod("all");
    await flush();
    doc.activeElement = retry;
    click("[data-act-retry]");
    await flush();
    expect(parts["#exFeed"].innerHTML).toBe("");
    expect(parts['input[name="exPeriod"]:checked'].focus).toHaveBeenCalled();
  });
});
