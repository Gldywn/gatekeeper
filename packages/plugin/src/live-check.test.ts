import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "./types";

const { connection, query } = vi.hoisted(() => ({
  connection: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@beekeeperstudio/plugin", () => ({
  getConnectionInfo: connection,
  runQuery: query,
  appStorage: { getItem: vi.fn(), setItem: vi.fn() },
  log: { error: vi.fn() },
  addNotificationListener: vi.fn(),
  broadcast: {},
  clipboard: {},
  getColumns: vi.fn(),
  openExternal: vi.fn(),
  setTabTitle: vi.fn(),
}));
vi.mock("./anim", () => ({ enter: vi.fn(), reveal: vi.fn(), pulse: vi.fn() }));

import { Gatekeeper } from "./app";
import { dbLink } from "./render/dblink";
import { mapDialect } from "./sql/readonly";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const row = (replica: boolean) => ({
  results: [{ fields: [], rows: [{ replica, session_read_only: false }] }],
});

// The real check methods on an app whose host, broker and DOM boundaries are stubbed.
function harness(databaseType = "postgresql") {
  const app = Object.create(Gatekeeper.prototype);
  Object.assign(app, {
    polling: true,
    token: "token",
    activeGen: 0,
    connGeneration: 0,
    autoBusy: false,
    cards: [] as Card[],
    mode: "read",
    dialect: mapDialect(databaseType),
    conn: {
      id: 1,
      connectionName: "test",
      databaseType,
      databaseName: "test",
      schema: "public",
      readOnly: false,
    },
    endpointRO: null,
    checkedAt: 0,
    nextCheckAt: 0,
    checkFailures: 0,
    checkError: null,
    checkInFlight: false,
    connEl: null,
    connHtml: "",
    statusHtml: "",
    layersHtml: "",
    root: { querySelector: () => null },
    renderQueue: vi.fn(),
    renderConnLabel: vi.fn(),
    reportConnection: vi.fn(),
  });
  return app;
}

// Lets the awaited host call and the code after it run.
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  query.mockReset().mockResolvedValue(row(false));
  connection.mockReset();
  vi.stubGlobal("document", { visibilityState: "visible" });
});

describe("periodic endpoint check", () => {
  it("runs one check when due, never stacks a second on a pending one, then waits 15 s", async () => {
    const app = harness();
    const pending = deferred<ReturnType<typeof row>>();
    query.mockReturnValueOnce(pending.promise);
    app.maybeCheckEndpoint();
    app.maybeCheckEndpoint();
    expect(query).toHaveBeenCalledOnce();
    pending.resolve(row(false));
    await settle();
    expect(app.checkInFlight).toBe(false);
    expect(app.nextCheckAt - app.checkedAt).toBe(15_000);
    expect(dbLink(app.dbCheck())).toBe("passed");
    app.maybeCheckEndpoint();
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([
    ["unpaired after a 401", { token: null }],
    ["not polling", { polling: false }],
    ["Auto mode inspecting the catalog", { autoBusy: true }],
    ["a query executing", { cards: [{ state: "executing" }] }],
  ])("does not check while %s", (_, patch) => {
    const app = harness();
    Object.assign(app, patch);
    app.maybeCheckEndpoint();
    expect(query).not.toHaveBeenCalled();
  });

  it("does not check while the window is hidden", () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    harness().maybeCheckEndpoint();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["oracle", "redshift", "sqlite"])(
    "never sends the PostgreSQL check to %s, even though its parser dialect falls back to it",
    (type) => {
      const app = harness(type);
      app.maybeCheckEndpoint();
      expect(query).not.toHaveBeenCalled();
      expect(dbLink(app.dbCheck())).toBe("none");
    },
  );

  it("drops a result from before a switch and checks the new connection once the old call settles", async () => {
    const app = harness();
    const old = deferred<ReturnType<typeof row>>();
    query.mockReturnValueOnce(old.promise);
    app.maybeCheckEndpoint();
    app.connGeneration++;
    app.resetCheck();
    app.maybeCheckEndpoint();
    expect(query).toHaveBeenCalledOnce();
    old.resolve(row(true));
    await settle();
    expect(app.endpointRO).toBeNull();
    expect(app.checkedAt).toBe(0);
    app.maybeCheckEndpoint();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("checks again on the next tick after a schema change discards a check", async () => {
    const app = harness();
    const pending = deferred<ReturnType<typeof row>>();
    query.mockReturnValueOnce(pending.promise);
    app.maybeCheckEndpoint();
    app.connGeneration++;
    pending.resolve(row(false));
    await settle();
    app.maybeCheckEndpoint();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("counts failures in a row, keeps the last verdict, and resets on the next pass", async () => {
    const app = harness();
    await app.checkEndpoint("postgresql");
    expect(app.endpointRO).toEqual({ replica: false, sessionReadOnly: false });
    query.mockResolvedValue({ results: [], error: "permission denied for function" });
    for (const expected of ["failed", "failed", "failing"]) {
      await app.checkEndpoint("postgresql");
      expect(dbLink(app.dbCheck())).toBe(expected);
    }
    expect(app.checkFailures).toBe(3);
    expect(app.checkError).toBe("permission denied for function");
    expect(app.endpointRO).toEqual({ replica: false, sessionReadOnly: false });
    query.mockResolvedValue(row(false));
    await app.checkEndpoint("postgresql");
    expect(app.checkFailures).toBe(0);
    expect(app.checkError).toBeNull();
  });

  it("shows a check that never worked as failing too", async () => {
    const app = harness("mariadb");
    query.mockResolvedValue({ results: [], error: "Access denied" });
    for (let i = 0; i < 3; i++) await app.checkEndpoint("mariadb");
    expect(dbLink(app.dbCheck())).toBe("failing");
    expect(app.endpointRO).toBeNull();
  });

  it("moves the card gates only when a failover flips the replica flag", async () => {
    const app = harness();
    await app.checkEndpoint("postgresql");
    expect(app.renderQueue).not.toHaveBeenCalled();
    query.mockResolvedValue(row(true));
    await app.checkEndpoint("postgresql");
    expect(app.connectionReadOnly()).toBe(true);
    expect(app.renderQueue).toHaveBeenCalledOnce();
    await app.checkEndpoint("postgresql");
    expect(app.renderQueue).toHaveBeenCalledOnce();
  });
});

describe("Beekeeper read-only switch", () => {
  const info = (readOnlyMode: boolean) => ({
    id: 1,
    connectionName: "test",
    databaseType: "postgresql",
    databaseName: "test",
    defaultSchema: "public",
    readOnlyMode,
  });

  it("redraws the layers, the gates and the agent snapshot when it flips on the same connection", async () => {
    const app = harness();
    connection.mockResolvedValue(info(true));
    expect(await app.checkConnection()).toBe(true);
    expect(app.conn.readOnly).toBe(true);
    expect(app.renderConnLabel).toHaveBeenCalledOnce();
    expect(app.renderQueue).toHaveBeenCalledOnce();
    expect(app.reportConnection).toHaveBeenCalledOnce();
    expect(await app.checkConnection()).toBe(true);
    expect(app.renderConnLabel).toHaveBeenCalledOnce();
  });
});

describe("check lifecycle", () => {
  it("drops a pending check when the tab loses ownership or re-pairs", async () => {
    const app = harness();
    const pending = deferred<ReturnType<typeof row>>();
    query.mockReturnValueOnce(pending.promise);
    app.maybeCheckEndpoint();
    app.activeGen++;
    pending.resolve(row(true));
    await settle();
    expect(app.checkInFlight).toBe(false);
    expect(app.endpointRO).toBeNull();
    expect(app.checkedAt).toBe(0);
  });

  it("disarms the Gatekeeper layer, forgets the endpoint and checks the new connection on a switch", async () => {
    const app = harness();
    query.mockResolvedValue(row(true));
    await app.checkEndpoint("postgresql");
    app.mode = "write";
    Object.assign(app, {
      resetAuto: vi.fn(),
      denyDrafts: new Map(),
      confirmModal: { cancel: vi.fn() },
      annotator: { clearCache: vi.fn() },
      history: [],
      activityView: { reset: vi.fn() },
      settingsView: { close: vi.fn() },
      renderModeSurfaces: vi.fn(),
      renderHistory: vi.fn(),
      renderRoster: vi.fn(),
      reloadSettings: vi.fn(async () => {}),
      reportSchema: vi.fn(async () => {}),
      maybeShowDbNotice: vi.fn(async () => {}),
    });
    query.mockClear();
    app.onConnectionSwitch();
    expect(app.mode).toBe("read");
    expect(app.endpointRO).toBeNull();
    expect(app.layerRows()).toMatch(/Gatekeeper<\/span><span class="ro-state ok">/);
    expect(app.layerRows()).toMatch(/Endpoint<\/span><span class="ro-state mut">/);
    expect(query).toHaveBeenCalledOnce();
  });
});

// Just enough of an element for renderConnLabel: counted innerHTML writes, and the .ro-help
// controls recreated on every write the way a real innerHTML replacement does.
function fakeEl() {
  const el = {
    writes: 0,
    html: "",
    dataset: {} as Record<string, string>,
    helps: [] as { focus: ReturnType<typeof vi.fn> }[],
    get innerHTML() {
      return el.html;
    },
    set innerHTML(value: string) {
      el.writes++;
      el.html = value;
      el.helps = (value.match(/class="ro-help"/g) ?? []).map(() => ({ focus: vi.fn() }));
    },
    querySelector: (_: string): unknown => null,
    querySelectorAll: (selector: string) => (selector === ".ro-help" ? el.helps : []),
  };
  return el;
}

function fakeHeader() {
  const conn = fakeEl();
  const slot = fakeEl();
  const layers = fakeEl();
  conn.querySelector = (s) => (s === ".db-slot" ? slot : s === ".ro-layers" ? layers : null);
  const root = { querySelector: (s: string) => (s === "#conn" ? conn : null) };
  return { conn, slot, layers, root };
}

describe("header chip rendering", () => {
  it("rebuilds only the popover part that changed, never the database glyph", async () => {
    const app = harness();
    const dom = fakeHeader();
    delete app.renderConnLabel;
    app.root = dom.root;
    vi.stubGlobal("document", { visibilityState: "visible", activeElement: null });
    app.renderConnLabel();
    expect(dom.conn.writes).toBe(1);
    expect(dom.conn.dataset.link).toBe("pending");
    expect(dom.conn.html).toContain('tabindex="0"');
    await app.checkEndpoint("postgresql");
    await app.checkEndpoint("postgresql");
    expect(dom.slot.writes).toBe(1);
    expect(dom.slot.html).toContain("Last check passed");
    // unknown -> writable once, then unchanged
    expect(dom.layers.writes).toBe(2);
    query.mockResolvedValue({ results: [], error: "Connection terminated unexpectedly" });
    for (let i = 0; i < 4; i++) await app.checkEndpoint("postgresql");
    expect(dom.conn.dataset.link).toBe("failing");
    expect(dom.slot.html).toContain("4 checks failed in a row");
    // failed (1st), same failed (2nd, no write), 3 in a row, 4 in a row
    expect(dom.slot.writes).toBe(4);
    expect(dom.layers.writes).toBe(2);
    expect(dom.conn.writes).toBe(1);
  });

  it("puts the keyboard focus back on the same help control when the layers change", () => {
    const app = harness();
    const dom = fakeHeader();
    delete app.renderConnLabel;
    app.root = dom.root;
    vi.stubGlobal("document", { visibilityState: "visible", activeElement: null });
    app.renderConnLabel();
    vi.stubGlobal("document", { visibilityState: "visible", activeElement: dom.layers.helps[1] });
    app.mode = "write";
    app.renderConnLabel();
    expect(dom.layers.writes).toBe(2);
    expect(dom.layers.helps[1].focus).toHaveBeenCalledOnce();
    expect(dom.layers.helps[0].focus).not.toHaveBeenCalled();
  });
});

describe("read-only layers popover", () => {
  it("flips the Gatekeeper layer to writable when a mode is armed and back when disarmed", () => {
    const app = harness();
    const gatekeeperRow = () => app.layerRows().match(/Gatekeeper<\/span>.*?<\/div>/)?.[0] ?? "";
    expect(gatekeeperRow()).toContain("read-only");
    app.mode = "write";
    expect(gatekeeperRow()).toContain("writable");
    app.mode = "destructive";
    expect(gatekeeperRow()).toContain("writable");
    app.mode = "read";
    expect(gatekeeperRow()).toContain("read-only");
  });
});
