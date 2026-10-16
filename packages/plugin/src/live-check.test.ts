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

const info = (databaseType = "postgresql", readOnlyMode = false, id = 1) => ({
  id,
  connectionName: "test",
  databaseType,
  databaseName: "test",
  defaultSchema: "public",
  readOnlyMode,
});

// The real check methods on an app whose host, broker and DOM boundaries are stubbed. The
// host keeps reporting the same connection unless a test says otherwise.
function harness(databaseType = "postgresql") {
  connection.mockResolvedValue(info(databaseType));
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

// Lets the awaited host calls and the code after them run.
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  query.mockReset().mockResolvedValue(row(false));
  connection.mockReset();
  vi.stubGlobal("document", { visibilityState: "visible", activeElement: null });
  vi.stubGlobal("window", { innerHeight: 800 });
});

describe("periodic endpoint check", () => {
  it("runs one check when due, never stacks a second on a pending one, then waits 15 s", async () => {
    const app = harness();
    const pending = deferred<ReturnType<typeof row>>();
    query.mockReturnValueOnce(pending.promise);
    app.maybeCheckEndpoint();
    app.maybeCheckEndpoint();
    await settle();
    app.maybeCheckEndpoint();
    expect(query).toHaveBeenCalledOnce();
    pending.resolve(row(false));
    await settle();
    expect(app.checkInFlight).toBe(false);
    expect(app.nextCheckAt - app.checkedAt).toBe(15_000);
    expect(dbLink(app.dbCheck())).toBe("passed");
    app.maybeCheckEndpoint();
    await settle();
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([
    ["unpaired after a 401", { token: null }],
    ["not polling", { polling: false }],
  ])("does not check while %s", async (_, patch) => {
    const app = harness();
    Object.assign(app, patch);
    app.maybeCheckEndpoint();
    await settle();
    expect(query).not.toHaveBeenCalled();
  });

  it("does not check while the window is hidden", async () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    harness().maybeCheckEndpoint();
    await settle();
    expect(query).not.toHaveBeenCalled();
  });

  it("pauses while the Gatekeeper view has no size, and resumes once it is shown again", async () => {
    const app = harness();
    vi.stubGlobal("window", { innerHeight: 0 });
    app.maybeCheckEndpoint();
    await settle();
    expect(query).not.toHaveBeenCalled();
    vi.stubGlobal("window", { innerHeight: 640 });
    app.maybeCheckEndpoint();
    await settle();
    expect(query).toHaveBeenCalledOnce();
  });

  // A card stranded outside `ready` (tablesChanged or a 401 mid-approval) must not switch the
  // check off for the rest of the connection.
  it("keeps checking while a card is executing or Auto mode inspects the catalog", async () => {
    const app = harness();
    Object.assign(app, { autoBusy: true, cards: [{ state: "executing" }, { state: "posting" }] });
    app.maybeCheckEndpoint();
    await settle();
    expect(query).toHaveBeenCalledOnce();
  });

  it.each(["oracle", "redshift", "sqlite"])(
    "never sends the PostgreSQL check to %s, even though its parser dialect falls back to it",
    async (type) => {
      const app = harness(type);
      app.maybeCheckEndpoint();
      await settle();
      expect(query).not.toHaveBeenCalled();
      expect(dbLink(app.dbCheck())).toBe("none");
    },
  );

  it("re-reads the connection first, so a switch not yet seen never gets the old engine's probe", async () => {
    const app = harness();
    app.onConnectionSwitch = vi.fn();
    connection.mockResolvedValue(info("oracle", false, 2));
    app.maybeCheckEndpoint();
    await settle();
    expect(app.onConnectionSwitch).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(app.checkInFlight).toBe(false);
  });

  it.each([
    ["the tab is demoted", (app: ReturnType<typeof harness>) => app.activeGen++],
    ["the view is hidden", () => vi.stubGlobal("window", { innerHeight: 0 })],
    [
      "the tab is unpaired",
      (app: ReturnType<typeof harness>) => Object.assign(app, { token: null }),
    ],
  ])("drops the check when %s while the connection is re-read", async (_, change) => {
    const app = harness();
    const refresh = deferred<ReturnType<typeof info>>();
    connection.mockReturnValueOnce(refresh.promise);
    app.maybeCheckEndpoint();
    change(app);
    refresh.resolve(info());
    await settle();
    expect(query).not.toHaveBeenCalled();
    expect(app.checkInFlight).toBe(false);
  });

  it("drops a result from before a switch and checks the new connection once the old call settles", async () => {
    const app = harness();
    const old = deferred<ReturnType<typeof row>>();
    query.mockReturnValueOnce(old.promise);
    app.maybeCheckEndpoint();
    await settle();
    app.connGeneration++;
    app.resetCheck();
    app.maybeCheckEndpoint();
    await settle();
    expect(query).toHaveBeenCalledOnce();
    old.resolve(row(true));
    await settle();
    expect(app.endpointRO).toBeNull();
    expect(app.checkedAt).toBe(0);
    app.maybeCheckEndpoint();
    await settle();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("checks again on the next tick after a schema change discards a check", async () => {
    const app = harness();
    const pending = deferred<ReturnType<typeof row>>();
    query.mockReturnValueOnce(pending.promise);
    app.maybeCheckEndpoint();
    await settle();
    app.connGeneration++;
    pending.resolve(row(false));
    await settle();
    app.maybeCheckEndpoint();
    await settle();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("counts failures in a row, keeps the last verdict, and resets on the next pass", async () => {
    const app = harness();
    await app.checkEndpoint();
    expect(app.endpointRO).toEqual({ replica: false, sessionReadOnly: false });
    query.mockResolvedValue({ results: [], error: "permission denied for function" });
    for (const expected of ["failed", "failed", "failing"]) {
      await app.checkEndpoint();
      expect(dbLink(app.dbCheck())).toBe(expected);
    }
    expect(app.checkFailures).toBe(3);
    expect(app.checkError).toBe("permission denied for function");
    expect(app.endpointRO).toEqual({ replica: false, sessionReadOnly: false });
    query.mockResolvedValue(row(false));
    await app.checkEndpoint();
    expect(app.checkFailures).toBe(0);
    expect(app.checkError).toBeNull();
  });

  it("shows a check that never worked as failing too", async () => {
    const app = harness("mariadb");
    query.mockResolvedValue({ results: [], error: "Access denied" });
    for (let i = 0; i < 3; i++) await app.checkEndpoint();
    expect(dbLink(app.dbCheck())).toBe("failing");
    expect(app.endpointRO).toBeNull();
  });

  it("moves the card gates only when a failover flips the replica flag", async () => {
    const app = harness();
    await app.checkEndpoint();
    expect(app.renderQueue).not.toHaveBeenCalled();
    query.mockResolvedValue(row(true));
    await app.checkEndpoint();
    expect(app.connectionReadOnly()).toBe(true);
    expect(app.renderQueue).toHaveBeenCalledOnce();
    await app.checkEndpoint();
    expect(app.renderQueue).toHaveBeenCalledOnce();
  });
});

describe("Beekeeper read-only switch", () => {
  it("redraws the layers, the gates and the agent snapshot when it flips on the same connection", async () => {
    const app = harness();
    connection.mockResolvedValue(info("postgresql", true));
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
    await settle();
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
    await app.checkEndpoint();
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
    await settle();
    expect(query).toHaveBeenCalledOnce();
  });
});

type Fake = ReturnType<typeof fakeEl>;

// Just enough of an element for renderConnLabel: counted innerHTML writes, attributes, and
// children recreated on every write the way a real innerHTML replacement does.
function fakeEl(makeChildren?: (el: Fake) => Record<string, Fake>) {
  const el = {
    writes: 0,
    html: "",
    textContent: "",
    dataset: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: {} as Record<string, Fake>,
    helps: [] as { focus: ReturnType<typeof vi.fn> }[],
    get innerHTML() {
      return el.html;
    },
    set innerHTML(value: string) {
      el.writes++;
      el.html = value;
      el.helps = (value.match(/class="ro-help"/g) ?? []).map(() => ({ focus: vi.fn() }));
      el.children = makeChildren?.(el) ?? {};
    },
    setAttribute: (name: string, value: string) => {
      el.attrs[name] = value;
    },
    querySelector: (selector: string): Fake | null => el.children[selector] ?? null,
    querySelectorAll: (selector: string) => (selector === ".ro-help" ? el.helps : []),
  };
  return el;
}

function fakeHeader() {
  const conn = fakeEl(() => ({
    ".chip-db": fakeEl(),
    ".db-slot": fakeEl(),
    ".ro-layers": fakeEl(),
  }));
  const age = fakeEl();
  const next = fakeEl();
  const root = {
    querySelector: (s: string) =>
      s === "#conn"
        ? conn
        : s === "#conn .db-age" && conn.children[".db-slot"]?.html.includes("db-age")
          ? age
          : s === "#conn .db-next" && conn.children[".db-slot"]?.html.includes("db-next")
            ? next
            : null,
  };
  const part = (s: string) => conn.children[s] as Fake;
  return { conn, root, age, next, part };
}

function liveHeader(app: ReturnType<typeof harness>) {
  const dom = fakeHeader();
  delete app.renderConnLabel;
  app.root = dom.root;
  return dom;
}

describe("header chip rendering", () => {
  it("rebuilds only the popover part that changed, never the database glyph", async () => {
    const app = harness();
    const dom = liveHeader(app);
    app.renderConnLabel();
    expect(dom.conn.writes).toBe(1);
    expect(dom.conn.dataset.link).toBe("pending");
    expect(dom.conn.html).toContain('tabindex="0"');
    expect(dom.part(".chip-db").attrs["aria-label"]).toBe("Database check pending");
    const slot = dom.part(".db-slot");
    const layers = dom.part(".ro-layers");
    await app.checkEndpoint();
    await app.checkEndpoint();
    expect(slot.writes).toBe(1);
    expect(slot.html).toContain("Last check passed");
    // unknown -> writable once, then unchanged
    expect(layers.writes).toBe(2);
    query.mockResolvedValue({ results: [], error: "Connection terminated unexpectedly" });
    for (let i = 0; i < 4; i++) await app.checkEndpoint();
    expect(dom.conn.dataset.link).toBe("failing");
    expect(slot.html).toContain("4 checks failed in a row");
    expect(dom.part(".chip-db").attrs["aria-label"]).toBe("4 database checks failed in a row");
    // failed (1st), same failed (2nd, no write), 3 in a row, 4 in a row
    expect(slot.writes).toBe(4);
    expect(layers.writes).toBe(2);
    expect(dom.conn.writes).toBe(1);
  });

  it("fills both popover parts again when the header is rebuilt", async () => {
    const app = harness();
    liveHeader(app);
    await app.checkEndpoint();
    const rebuilt = liveHeader(app);
    app.renderConnLabel();
    expect(rebuilt.part(".db-slot").html).toContain("Last check passed");
    expect(rebuilt.part(".ro-layers").html).toContain("Read-only layers");
  });

  it("writes the age and the countdown into the popover", async () => {
    const app = harness();
    const dom = liveHeader(app);
    await app.checkEndpoint();
    expect(dom.age.textContent).toBe("0s ago");
    expect(dom.next.textContent).toBe("Checking again in 15s.");
  });

  it("puts the keyboard focus back on the same help control when the layers change", () => {
    const app = harness();
    const dom = liveHeader(app);
    app.renderConnLabel();
    const layers = dom.part(".ro-layers");
    vi.stubGlobal("document", { visibilityState: "visible", activeElement: layers.helps[1] });
    app.mode = "write";
    app.renderConnLabel();
    expect(layers.writes).toBe(2);
    expect(layers.helps[1].focus).toHaveBeenCalledOnce();
    expect(layers.helps[0].focus).not.toHaveBeenCalled();
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
