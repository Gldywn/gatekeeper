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

  it("drops another card without touching the open one", () => {
    const app = harness();
    app.selection.queue = { kind: "card", id: "a" };
    app.finish("b", "expired", "expired");
    expect(app.selection.queue).toEqual({ kind: "card", id: "a" });
    expect(app.renderSelection).not.toHaveBeenCalled();
  });
});
