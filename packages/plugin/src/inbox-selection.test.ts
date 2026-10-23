import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "./types";

vi.mock("@beekeeperstudio/plugin", () => ({
  appStorage: { getItem: vi.fn(), setItem: vi.fn() },
  log: { error: vi.fn() },
  addNotificationListener: vi.fn(),
  broadcast: {},
  clipboard: {},
  getColumns: vi.fn(),
  getConnectionInfo: vi.fn(),
  openExternal: vi.fn(),
  runQuery: vi.fn(),
  setTabTitle: vi.fn(),
}));
vi.mock("./anim", () => ({ enter: vi.fn(), reveal: vi.fn(), pulse: vi.fn() }));

import { Gatekeeper } from "./app";

const card = (id: string): Card => ({
  id,
  sql: "SELECT 1",
  state: "ready",
  leaseId: "lease",
  leaseExpiresAt: Date.now() + 60_000,
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
  sessionId: "s1",
  session: null,
});

// The real selection paths on an app whose DOM and renderers are stubbed: what is checked is
// which selection each tab keeps and when the right pane is redrawn.
function harness() {
  const app = Object.create(Gatekeeper.prototype);
  Object.assign(app, {
    cards: [card("a"), card("b")],
    history: [],
    denyDrafts: new Map(),
    connGeneration: 0,
    connectionName: "test",
    tab: "queue",
    selection: { queue: null, audit: null },
    root: { querySelector: () => null },
    settingsStore: { get: () => ({ recentlyResolved: 20, resultCacheMb: 4 }) },
    confirmModal: { dismissFor: vi.fn() },
    detailView: { setPendingCount: vi.fn(), shrink: vi.fn(() => false), close: vi.fn() },
    renderQueueList: vi.fn(),
    renderSelection: vi.fn(),
    updateTabTitle: vi.fn(),
    autoHold: vi.fn(),
  });
  return app;
}

beforeEach(() => {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
});

describe("Inbox selection", () => {
  it("never picks a row on its own when proposals arrive", () => {
    const app = harness();
    app.renderQueue("b");
    expect(app.selection.queue).toBeNull();
    expect(app.renderSelection).toHaveBeenCalledOnce();
  });

  it("gives the enlarged rows the tab's own count of what waits, executing cards apart", () => {
    const app = harness();
    app.cards[1].state = "executing";
    app.renderQueue();
    expect(app.detailView.setPendingCount).toHaveBeenLastCalledWith(1);
    app.cards = [];
    app.renderQueue();
    expect(app.detailView.setPendingCount).toHaveBeenLastCalledWith(0);
  });

  it("goes from the enlarged rows to the Queue's list and tab, keeping its selection", () => {
    const app = harness();
    app.tab = "audit";
    app.selection = { queue: { kind: "hist", id: "h" }, audit: { kind: "audit", id: "x" } };
    const inbox = { setAttribute: vi.fn() };
    const tab = { focus: vi.fn() };
    app.root = {
      querySelector: (s: string) => (s === "#inbox" ? inbox : s === "#tabQueue" ? tab : null),
    };
    app.applyTab = vi.fn();
    app.exportDialog = { close: vi.fn() };
    app.activityView = { close: vi.fn() };
    app.openQueue();
    expect(app.detailView.shrink).toHaveBeenCalledWith(false);
    expect(app.tab).toBe("queue");
    expect(app.selection.queue).toEqual({ kind: "hist", id: "h" });
    expect(inbox.setAttribute).toHaveBeenCalledWith("data-show", "list");
    expect(tab.focus).toHaveBeenCalledOnce();
  });

  it("rebuilds the open card for its own changes only", () => {
    const app = harness();
    app.selection.queue = { kind: "card", id: "a" };
    app.renderQueue("b");
    expect(app.renderSelection).not.toHaveBeenCalled();
    app.renderQueue("a");
    expect(app.renderSelection).toHaveBeenCalledOnce();
  });

  it("keeps a decided card open as its outcome", () => {
    const app = harness();
    app.selection.queue = { kind: "card", id: "a" };
    app.finish("a", "approved", "1 row returned");
    expect(app.selection.queue).toEqual({ kind: "hist", id: "a", item: app.history[0] });
    expect(app.history[0]).toMatchObject({ id: "a", status: "approved" });
    expect(app.renderSelection).toHaveBeenCalledWith(true);
  });

  it("leaves the Audit Trail's open entry alone when the queue's card is decided", () => {
    const app = harness();
    app.tab = "audit";
    app.selection = { queue: { kind: "card", id: "a" }, audit: { kind: "audit", id: "x" } };
    app.finish("a", "rejected", "declined");
    expect(app.selection.queue).toMatchObject({
      kind: "hist",
      id: "a",
      item: { status: "rejected" },
    });
    expect(app.selection.audit).toEqual({ kind: "audit", id: "x" });
    expect(app.renderSelection).not.toHaveBeenCalled();
  });

  it("lets the open detail go of rows Result memory sheds, and leaves other details alone", () => {
    const app = harness();
    const rows = () => ({ fields: [{ name: "a" }], rows: [{ a: 1 }], rowCount: 1, bytes: 10 });
    const record = { id: "x", status: "approved", note: "", sql: "SELECT 1" };
    app.tab = "audit";
    app.selection.audit = { kind: "audit", id: "x", item: record };
    app.history = [{ ...record, result: rows() }];
    let shown = "y";
    app.detailView = { showing: () => shown };
    app.settingsStore = { get: () => ({ recentlyResolved: 20, resultCacheMb: 0 }) };
    app.enforceHistoryBudget();
    expect(app.renderSelection).not.toHaveBeenCalled();
    app.history[0].result = rows();
    shown = "x";
    app.enforceHistoryBudget();
    expect(app.renderSelection).toHaveBeenCalledWith(true);
    expect(app.withLocalRows(record)).toBe(record);
  });

  it("drops another card without touching the open one", () => {
    const app = harness();
    app.selection.queue = { kind: "card", id: "a" };
    app.finish("b", "expired", "expired");
    expect(app.selection.queue).toEqual({ kind: "card", id: "a" });
    expect(app.renderSelection).not.toHaveBeenCalled();
  });
});

describe("overlay thumbs", () => {
  it("lets them go when the Inbox leaves for standby or the no-server screen", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }), setTimeout: vi.fn() });
    for (const leave of ["renderStandby", "renderNoBroker"] as const) {
      const app = harness();
      const dispose = [vi.fn(), vi.fn()];
      app.overlayScrolls = [...dispose];
      app.stopProbe = vi.fn();
      app.root = { innerHTML: "", querySelector: () => null };
      // An open confirm, Settings, notice or export must not keep its hold on the shell being replaced.
      app.confirmModal = { cancel: vi.fn() };
      app.settingsView = { close: vi.fn() };
      const noticeRelease = vi.fn();
      app.noticeRelease = noticeRelease;
      app.exportDialog = { close: vi.fn() };
      app.detailView = { close: vi.fn() };
      app[leave]();
      for (const d of dispose) expect(d).toHaveBeenCalledOnce();
      expect(app.overlayScrolls).toEqual([]);
      expect(app.confirmModal.cancel).toHaveBeenCalledOnce();
      expect(app.settingsView.close).toHaveBeenCalledOnce();
      expect(noticeRelease).toHaveBeenCalledOnce();
      expect(app.noticeRelease).toBeUndefined();
      expect(app.exportDialog.close).toHaveBeenCalledOnce();
      // The detail's grid too, enlarged or not.
      expect(app.detailView.close).toHaveBeenCalledOnce();
    }
  });
});

describe("the database notice", () => {
  it("opens as a modal dialog on Continue, and lets the page go when it closes", async () => {
    const app = harness();
    app.conn = { databaseType: "sqlite" };
    const focused: string[] = [];
    const background = { inert: false, hidden: false };
    const overlay = {
      hidden: true,
      innerHTML: "",
      parentElement: { children: [] as object[] },
      querySelector: (s: string) => ({ focus: () => focused.push(s) }),
    };
    overlay.parentElement.children.push(background, overlay);
    app.root = { querySelector: (s: string) => (s === "#notice" ? overlay : null) };
    // Rows enlarged meanwhile go back first, the focus left to the notice.
    app.detailView.shrink = vi.fn(() => {
      expect(background.inert).toBe(false);
      return true;
    });
    await app.maybeShowDbNotice();
    expect(app.detailView.shrink).toHaveBeenCalledWith(false);
    expect(overlay.hidden).toBe(false);
    expect(overlay.innerHTML).toContain(
      'role="dialog" aria-modal="true" aria-labelledby="dbnTitle"',
    );
    expect(overlay.innerHTML).toContain('<button class="dbn-link" type="button" data-notice-hush>');
    expect(focused).toEqual(["[data-notice-continue]"]);
    expect(background.inert).toBe(true);
    app.hideDbNotice();
    expect(overlay.hidden).toBe(true);
    expect(background.inert).toBe(false);
    expect(app.noticeRelease).toBeUndefined();
  });
});

describe("closing the open item", () => {
  it("clears this tab's selection only, and gives the focus back to its row or the tab", () => {
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    const app = harness();
    const row = { offsetParent: {} as unknown, focus: vi.fn(), setAttribute: vi.fn() };
    const tab = { focus: vi.fn() };
    let held: typeof row | null = row;
    const inbox = { setAttribute: vi.fn() };
    app.root = {
      querySelector: (s: string) =>
        s === "#inbox"
          ? inbox
          : s === '#listQueue [data-row="a"]'
            ? held
            : s === '[data-tab][aria-selected="true"]'
              ? tab
              : null,
      querySelectorAll: () => (held ? [held] : []),
    };
    app.selection = { queue: { kind: "card", id: "a" }, audit: { kind: "audit", id: "x" } };
    app.closeSelection();
    expect(app.selection).toEqual({ queue: null, audit: { kind: "audit", id: "x" } });
    expect(row.setAttribute).toHaveBeenCalledWith("aria-current", "false");
    expect(app.renderSelection).toHaveBeenCalledWith(true);
    // A later narrow layout opens on the list.
    expect(inbox.setAttribute).toHaveBeenCalledWith("data-show", "list");
    expect(row.focus).toHaveBeenCalledOnce();
    // Its row gone from the list: the open tab takes the focus.
    held = null;
    app.selection.queue = { kind: "hist", id: "a" };
    app.closeSelection();
    expect(tab.focus).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("takes an Escape from the Inbox, never one from a field inside it", () => {
    const app = harness();
    const from = (inside: boolean, field: boolean) => ({
      target: {
        closest: (s: string) => (s === "#inbox" ? inside : field ? {} : null),
      },
    });
    expect(app.inInbox(from(true, false))).toBe(true);
    expect(app.inInbox(from(true, true))).toBe(false);
    expect(app.inInbox(from(false, false))).toBe(false);
    // The focus on the body: the clicked control is gone, the Escape is still the Inbox's.
    const body = { closest: () => null } as { closest: () => null; ownerDocument?: unknown };
    body.ownerDocument = { body };
    expect(app.inInbox({ target: body })).toBe(true);
  });

  it("hands the focus to the open row when a rebuild took the focused control", () => {
    const app = harness();
    delete app.renderSelection;
    const button = {};
    const doc = { activeElement: button as unknown };
    vi.stubGlobal("document", doc);
    app.root = {
      querySelector: (s: string) =>
        s === "#detailBody" ? { contains: (el: unknown) => el === button } : null,
    };
    app.focusSelectedRow = vi.fn();
    app.paintSelection = vi.fn(() => {
      doc.activeElement = {};
    });
    app.renderSelection(true);
    expect(app.paintSelection).toHaveBeenCalledWith(true);
    expect(app.focusSelectedRow).toHaveBeenCalledOnce();
    // A rebuild that keeps the focus in the pane (an open reason field) leaves it there.
    doc.activeElement = button;
    app.paintSelection = vi.fn();
    app.renderSelection();
    // Nor does one while the focus is elsewhere.
    doc.activeElement = {};
    app.renderSelection();
    expect(app.focusSelectedRow).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("keeps the focus in the enlarged rows, and finds the row when they go", () => {
    const app = harness();
    delete app.renderSelection;
    const holder = {};
    const doc = { activeElement: holder as unknown };
    vi.stubGlobal("document", doc);
    let enlarged = true;
    app.root = {
      querySelector: (s: string) =>
        s === "#results:not([hidden])" && enlarged
          ? { contains: (el: unknown) => el === holder }
          : null,
    };
    app.focusSelectedRow = vi.fn();
    app.paintSelection = vi.fn();
    app.renderSelection();
    expect(app.focusSelectedRow).not.toHaveBeenCalled();
    // Shed rows or another selection close the dialog under the focus.
    app.paintSelection = vi.fn(() => {
      enlarged = false;
      doc.activeElement = {};
    });
    app.renderSelection(true);
    expect(app.focusSelectedRow).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe("the Audit Trail's first view", () => {
  const entry = {
    id: "e1",
    createdAt: 1,
    decidedAt: 2,
    sessionId: "s1",
    harness: null,
    project: null,
    sessionLabel: null,
    sql: "SELECT 1",
    intent: null,
    state: "approved",
    reason: null,
    error: null,
    rowCount: 1,
    affectedRows: null,
  };

  it("opens on the first decision it lists, and keeps one already open", () => {
    const app = harness();
    const row = { dataset: { row: "e1" }, setAttribute: vi.fn() };
    app.tab = "audit";
    app.root = { querySelector: () => row };
    app.activityView = {
      entry: (id: string) => (id === "e1" ? entry : undefined),
      newest: () => entry,
    };
    app.openNewestAudit();
    expect(app.selection.audit).toMatchObject({ kind: "audit", id: "e1" });
    expect(row.setAttribute).toHaveBeenCalledWith("aria-current", "true");
    expect(app.renderSelection).toHaveBeenCalledWith(true);
    app.selection.audit = { kind: "audit", id: "older" };
    app.openNewestAudit();
    expect(app.selection.audit.id).toBe("older");
  });

  it("shows its empty state when it holds nothing, and has no close of its own", () => {
    const app = harness();
    app.tab = "audit";
    app.root = { querySelector: () => null };
    app.activityView = { entry: () => undefined, newest: () => undefined };
    app.openNewestAudit();
    expect(app.selection.audit).toBeNull();
    expect(app.renderSelection).toHaveBeenCalledWith(true);
    app.selection.audit = { kind: "audit", id: "e1" };
    app.closeSelection();
    expect(app.selection.audit).toEqual({ kind: "audit", id: "e1" });
  });
});
