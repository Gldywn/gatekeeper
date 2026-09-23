import type { AutoEvaluation } from "@gatekeeper/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "./types";

const { connection, query, storageRead, storageWrite } = vi.hoisted(() => ({
  connection: vi.fn(),
  query: vi.fn(),
  storageRead: vi.fn(),
  storageWrite: vi.fn(),
}));
vi.mock("@beekeeperstudio/plugin", () => ({
  getConnectionInfo: connection,
  runQuery: query,
  appStorage: { getItem: storageRead, setItem: storageWrite },
  log: { error: vi.fn() },
  addNotificationListener: vi.fn(),
  broadcast: {},
  clipboard: {},
  getColumns: vi.fn(),
  openExternal: vi.fn(),
  setTabTitle: vi.fn(),
}));
vi.mock("./anim", () => ({ enter: vi.fn(), reveal: vi.fn(), pulse: vi.fn() }));

import { SchemaAnnotator } from "./annotate";
import { Gatekeeper } from "./app";
import { SAVED_KEY_MASK } from "./render/auto";
import { ConfirmModal } from "./render/confirm";
import { catalogRows } from "./sql/pg/catalog-fixture";
import { planRead } from "./sql/read-analysis";

// A stand-in enable button: the busy flag is the only DOM state toggleAuto keeps on it.
function control() {
  const attrs = new Map<string, string>();
  return {
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    removeAttribute: (name: string) => attrs.delete(name),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness() {
  // Exercise the real app methods with host/network boundaries replaced, without a browser.
  const app = Object.create(Gatekeeper.prototype);
  const card: Card = {
    id: "req",
    sql: "SELECT quantity FROM public.products LIMIT 10",
    state: "ready",
    leaseId: "lease",
    leaseExpiresAt: Date.now() + 60000,
    expiresAt: Date.now() + 60000,
    createdAt: Date.now(),
    sessionId: "session",
    session: null,
  };
  Object.assign(app, {
    cards: [card],
    denyDrafts: new Map(),
    connGeneration: 0,
    activeGen: 0,
    autoGeneration: 1,
    autoEnabled: true,
    autoKey: "synthetic-key",
    autoDeferred: new Set<string>(),
    autoBusy: false,
    mode: "read",
    dialect: "postgresql",
    conn: {
      id: 1,
      connectionName: "test",
      databaseType: "postgresql",
      databaseName: "test",
      schema: "public",
      readOnly: false,
    },
    root: { querySelector: () => null },
    settingsStore: { get: () => ({ confirmWrites: true, resultCacheMb: 4 }) },
    renderQueue: vi.fn(),
    renderAuto: vi.fn(),
    renderModeSurfaces: vi.fn(),
    renderConnLabel: vi.fn(),
    reportConnection: vi.fn(),
    finish: vi.fn((id: string) => {
      app.cards = app.cards.filter((c: Card) => c.id !== id);
    }),
    broker: {
      executing: vi.fn(async () => true),
      result: vi.fn(async () => true),
      withdrawExecution: vi.fn(async () => true),
      checkKey: vi.fn(async () => "valid"),
      evaluate: vi.fn(),
      renew: vi.fn(),
    },
    onConnectionSwitch: vi.fn(() => {
      app.connGeneration++;
      app.resetAuto("Connection changed");
      app.cards = [];
    }),
  });
  app.annotator = new SchemaAnnotator({
    dialect: () => app.dialect,
    generation: () => app.connGeneration,
    defaultSchema: () => "public",
    getColumns: async () => [],
    getMetadata: async (sql) => {
      const result = await query(sql);
      if (result.error) throw new Error("Metadata unavailable");
      return result.results[0]?.rows ?? [];
    },
  });
  return { app, card };
}

// Synthetic catalog rows for the two host metadata calls: search path, then catalog query.
function mockCatalog(sql: string, relations: Record<string, Record<string, string>>) {
  const plan = planRead(sql, "postgresql");
  if (typeof plan === "string") throw new Error(plan);
  query.mockResolvedValueOnce({
    results: [{ fields: [], rows: [{ path: '["pg_catalog","public"]' }] }],
  });
  query.mockResolvedValueOnce({ results: [{ fields: [], rows: catalogRows(plan, relations) }] });
}

function evaluation(): AutoEvaluation {
  return {
    provider: "typesafe",
    model: "jev-1.13.0",
    policy: "auto-beta-6",
    evaluatedAt: Date.now(),
    sqlDigest: "a".repeat(64),
    eligible: true,
    reasons: [],
    probabilities: {
      read_only: 0.999,
      personal_disclosure: 0.001,
      secret_disclosure: 0.001,
      organization_disclosure: 0.001,
      insufficient_context: 0.001,
    },
  };
}

beforeEach(() => {
  connection.mockReset().mockResolvedValue({
    id: 1,
    connectionName: "test",
    databaseType: "postgresql",
    databaseName: "test",
    defaultSchema: "public",
    readOnlyMode: false,
  });
  query.mockReset().mockResolvedValue({ results: [{ rows: [], fields: [] }] });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("HTMLInputElement", class {});
  storageRead.mockReset();
});

describe("shared manual/automatic execution authority", () => {
  it.each([
    "UPDATE public.products SET price = price RETURNING price",
    "DELETE FROM public.companies WHERE FALSE RETURNING company_name",
    "WITH changed AS (DELETE FROM public.products RETURNING price) SELECT price FROM changed",
    "SELECT price INTO public.product_copy FROM public.products",
  ])("skips %s without annotating it or blocking a later read", async (sql) => {
    const { app, card } = harness();
    const read: Card = { ...card, id: "read", leaseId: "read-lease" };
    card.sql = sql;
    app.cards.push(read);
    const inspect = vi.spyOn(app.annotator, "inspectRead").mockResolvedValue({
      complete: false,
      reasons: ["Metadata unavailable"],
    });
    await app.evaluateNext();
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledWith(read.sql, expect.any(Function));
    expect(card.autoAttempt).toBeUndefined();
    expect(card.autoStatus).toBeUndefined();
    expect(app.autoHold(card)).toBeUndefined();
    expect(read.autoStatus).toBe("Needs review: Metadata unavailable");
    expect(app.broker.evaluate).not.toHaveBeenCalled();
    expect(app.broker.executing).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    "SELECT quantity FROM public.products WHERE sku = 'synthetic-item' ORDER BY quantity LIMIT 5",
    'SELECT "quantity" AS "Stock Value" FROM "Sales"."Products" WHERE "sku" = \'synthetic-item\' ORDER BY "Stock Value" LIMIT 5',
  ])("evaluates dependencies and executes the unchanged read: %s", async (sql) => {
    const { app, card } = harness();
    card.sql = sql;
    const table = sql.includes("Sales") ? "Sales.Products" : "public.products";
    mockCatalog(sql, { [table]: { quantity: "int4", sku: "text" } });
    app.broker.evaluate.mockResolvedValue(evaluation());
    await app.evaluateNext();
    const input = app.broker.evaluate.mock.calls[0][4];
    expect(input.withheldLiterals).toBe(true);
    expect(input.sql).toContain("$1");
    expect(input.sql).not.toContain("synthetic-item");
    expect(input.dependencies.map((d: { column: string }) => d.column)).toEqual([
      "quantity",
      "sku",
    ]);
    expect(query).toHaveBeenLastCalledWith(sql);
    expect(app.broker.executing).toHaveBeenCalledOnce();
  });
  it.each(["disable", "lease", "reject", "schema"])(
    "stops joined-source inspection after %s while metadata is pending",
    async (change) => {
      const { app, card } = harness();
      card.sql = "SELECT p.quantity FROM public.products p JOIN public.rates r ON p.sku = r.sku";
      const gate = deferred<{ results: { rows: Record<string, unknown>[]; fields: [] }[] }>();
      query.mockReturnValueOnce(gate.promise);
      const pending = app.evaluateNext();
      await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
      if (change === "disable") app.resetAuto("Auto mode disabled");
      if (change === "lease") card.authorityLost = true;
      if (change === "reject") await app.reject(card.id);
      if (change === "schema") app.annotator.clearCache();
      gate.resolve({ results: [{ rows: [], fields: [] }] });
      await pending;
      expect(query).toHaveBeenCalledOnce();
      expect(app.broker.evaluate).not.toHaveBeenCalled();
      expect(app.broker.executing).not.toHaveBeenCalled();
    },
  );
  it("sends inspected JSON paths to the evaluator and executes only the original SQL", async () => {
    const { app, card } = harness();
    const sql =
      "SELECT jsonb_typeof(metadata) AS kind, metadata #>> '{levels,status}' AS status FROM public.records WHERE id = 'synthetic-id'";
    card.sql = sql;
    mockCatalog(sql, { "public.records": { metadata: "jsonb", id: "text" } });
    app.broker.evaluate.mockResolvedValue(evaluation());
    await app.evaluateNext();
    expect(query.mock.calls[1][0]).toContain("E'jsonb_typeof'");
    const input = app.broker.evaluate.mock.calls[0][4];
    expect(input.sql).toContain("'{levels,status}'");
    expect(input.sql).not.toContain("synthetic-id");
    expect(input.dependencies).toContainEqual({
      schema: "public",
      table: "records",
      column: "metadata",
      type: "jsonb",
      usage: "output",
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenLastCalledWith(sql);
    expect(app.broker.executing).toHaveBeenCalledOnce();
  });
  it("inspects correlated reporting sources before evaluation and runs the original SQL", async () => {
    const { app, card } = harness();
    const sql = `SELECT o.kind,
      count(*) FILTER (WHERE o."createdAt" >= timestamptz '2026-01-01 00:00:00+00') AS recent,
      min(o."createdAt")::date AS oldest
      FROM public.orders o JOIN public.accounts a ON a.id = o.account_id
      WHERE a.provider = 'synthetic-provider'
      AND NOT EXISTS (SELECT 1 FROM public.attempts t WHERE t.order_id = o.id)
      GROUP BY o.kind`;
    card.sql = sql;
    mockCatalog(sql, {
      "public.orders": { kind: "text", createdAt: "timestamptz", id: "uuid", account_id: "uuid" },
      "public.accounts": { id: "uuid", provider: "text" },
      "public.attempts": { order_id: "uuid" },
    });
    app.broker.evaluate.mockResolvedValue(evaluation());
    await app.evaluateNext();
    const input = app.broker.evaluate.mock.calls[0][4];
    expect(new Set(input.dependencies.map((d: { table: string }) => d.table))).toEqual(
      new Set(["orders", "accounts", "attempts"]),
    );
    expect(input.sql).toContain("NOT EXISTS");
    expect(input.sql).toContain("FILTER (WHERE");
    expect(input.sql).not.toContain("2026-01-01");
    expect(input.sql).not.toContain("synthetic-provider");
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenLastCalledWith(sql);
    expect(app.broker.executing).toHaveBeenCalledOnce();
  });
  it("requires metadata for every joined relation before sharing", async () => {
    const { app, card } = harness();
    card.sql = "SELECT p.quantity FROM public.products p JOIN public.rates r ON p.sku = r.sku";
    mockCatalog(card.sql, { "public.products": { quantity: "int4", sku: "text" } });
    await app.evaluateNext();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("E'rates'");
    expect(app.broker.evaluate).not.toHaveBeenCalled();
    expect(card.autoStatus).toContain("Metadata unavailable");
  });
  it("disables from the marker before any asynchronous work and returns focus", () => {
    const { app } = harness();
    const focus = vi.fn();
    app.root.querySelector = () => ({ focus });
    app.autoAbort = new AbortController();
    const generation = app.autoGeneration;
    void app.toggleAuto({ closest: () => ({}) });
    expect(app.autoEnabled).toBe(false);
    expect(app.autoAbort.signal.aborted).toBe(true);
    expect(app.autoGeneration).toBe(generation + 1);
    expect(app.mode).toBe("read");
    expect(focus).toHaveBeenCalledOnce();
  });
  it("opens Settings without enabling when the popover has no saved key", async () => {
    const { app } = harness();
    app.autoEnabled = false;
    app.openAutoSettings = vi.fn();
    storageRead.mockResolvedValue(null);
    await app.toggleAuto({ ...control(), closest: () => ({ querySelector: () => null }) });
    expect(app.openAutoSettings).toHaveBeenCalledOnce();
    expect(app.autoEnabled).toBe(false);
    expect(app.broker.evaluate).not.toHaveBeenCalled();
  });
  it("checks the saved key with TypeSafe before enabling from the popover", async () => {
    const { app } = harness();
    app.autoEnabled = false;
    app.cards = [];
    app.openAutoSettings = vi.fn();
    storageRead.mockResolvedValue("saved-key");
    app.confirmModal = { cancel: vi.fn() };
    const popover = { ...control(), closest: () => ({ querySelector: () => null }) };
    app.broker.checkKey.mockResolvedValueOnce("invalid");
    await app.toggleAuto(popover);
    expect(app.broker.checkKey).toHaveBeenCalledWith("saved-key");
    expect(app.openAutoSettings).toHaveBeenCalledOnce();
    expect(app.autoEnabled).toBe(false);
    app.broker.checkKey.mockResolvedValueOnce("outdated");
    await app.toggleAuto(popover);
    expect(app.autoEnabled).toBe(false);
    app.broker.checkKey.mockResolvedValueOnce("unavailable");
    await app.toggleAuto(popover);
    expect(app.openAutoSettings).toHaveBeenCalledOnce();
    expect(app.autoEnabled).toBe(false);
    await app.toggleAuto(popover);
    expect(app.autoEnabled).toBe(true);
    expect(app.autoKey).toBe("saved-key");
  });
  it("does not open Settings for a stale credential lookup", async () => {
    const { app } = harness();
    app.autoEnabled = false;
    app.openAutoSettings = vi.fn();
    const gate = deferred<null>();
    storageRead.mockReturnValue(gate.promise);
    const pending = app.toggleAuto({
      ...control(),
      closest: () => ({ querySelector: () => null }),
    });
    app.resetAuto("Connection changed");
    gate.resolve(null);
    await pending;
    expect(app.openAutoSettings).not.toHaveBeenCalled();
    expect(app.autoEnabled).toBe(false);
  });
  it("saves a replacement key while enabled and uses it for the next evaluation", async () => {
    const { app } = harness();
    storageWrite.mockReset().mockResolvedValue(undefined);
    const input = { value: " new-key ", closest: () => null };
    await app.saveAutoKey(input);
    expect(storageWrite).toHaveBeenCalledWith("gatekeeper.typesafe-key", "new-key", {
      encrypted: true,
    });
    expect(app.autoKey).toBe("new-key");
    storageWrite.mockClear();
    await app.saveAutoKey({ value: "bad key", closest: () => null });
    await app.saveAutoKey({ value: SAVED_KEY_MASK, closest: () => null });
    expect(storageWrite).not.toHaveBeenCalled();
    expect(app.autoKey).toBe("new-key");
  });
  it("evaluates only the reads that arrive after activation", async () => {
    const { app, card } = harness();
    app.autoEnabled = false;
    app.autoBusy = false;
    app.confirmModal = { cancel: vi.fn() };
    storageRead.mockResolvedValue("saved-key");
    await app.toggleAuto({ ...control(), closest: () => ({ querySelector: () => null }) });
    expect(app.autoEnabled).toBe(true);
    expect(app.autoDeferred.has(card.id)).toBe(true);
    const later: Card = { ...card, id: "later", leaseId: "lease-later" };
    app.cards.push(later);
    app.autoBusy = false;
    await app.evaluateNext();
    // The waiting one keeps its silence and its manual controls; the fresh one is taken.
    expect(card.autoStatus).toBeUndefined();
    expect(later.autoStatus).toBeTruthy();
    app.resetAuto("Auto mode disabled");
    expect(app.autoDeferred.size).toBe(0);
  });
  it("reserves synchronously so manual and automatic approval run only once", async () => {
    const { app, card } = harness();
    const gate = deferred<boolean>();
    app.broker.executing.mockReturnValue(gate.promise);
    const first = app.approve(card.id, false, evaluation());
    const second = app.approve(card.id);
    await vi.waitFor(() => expect(app.broker.executing).toHaveBeenCalledTimes(1));
    gate.resolve(true);
    await Promise.all([first, second]);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each(["disable", "takeover", "schema", "lease", "sql", "policy", "model"])(
    "stops automatic execution if %s changes during the lease transition",
    async (change) => {
      const { app, card } = harness();
      const e = evaluation();
      const gate = deferred<boolean>();
      app.broker.executing.mockReturnValue(gate.promise);
      const pending = app.approve(card.id, false, e);
      await vi.waitFor(() => expect(app.broker.executing).toHaveBeenCalledOnce());
      if (change === "disable") app.resetAuto("Disabled");
      if (change === "takeover") app.activeGen++;
      if (change === "schema") app.connGeneration++;
      if (change === "lease") card.authorityLost = true;
      if (change === "sql") card.sql = "SELECT other FROM public.products";
      if (change === "policy") e.policy = "auto-beta-2";
      if (change === "model") Object.assign(e, { model: "jev-latest" });
      gate.resolve(true);
      await pending;
      expect(query).not.toHaveBeenCalled();
      expect(app.broker.withdrawExecution).toHaveBeenCalledWith(card.id, "lease");
      expect(card.state).toBe("ready");
    },
  );
  it("fails closed when the final connection check fails", async () => {
    const { app, card } = harness();
    connection
      .mockResolvedValueOnce(await connection())
      .mockRejectedValueOnce(new Error("host down"));
    await app.approve(card.id);
    expect(query).not.toHaveBeenCalled();
    expect(app.broker.withdrawExecution).toHaveBeenCalledOnce();
  });
  it("detects a schema identity change even when connection names match", async () => {
    const { app } = harness();
    connection.mockResolvedValue({
      id: 1,
      connectionName: "test",
      databaseType: "postgresql",
      databaseName: "test",
      defaultSchema: "private",
      readOnlyMode: false,
    });
    expect(await app.checkConnection()).toBe(false);
    expect(app.autoEnabled).toBe(false);
  });
  it("does not execute a late provider answer after human approval", async () => {
    const { app, card } = harness();
    const gate = deferred<AutoEvaluation>();
    app.broker.evaluate.mockReturnValue(gate.promise);
    mockCatalog(card.sql, { "public.products": { quantity: "int4" } });
    const pending = app.evaluateNext();
    await vi.waitFor(() => expect(app.broker.evaluate).toHaveBeenCalledOnce());
    await app.approve(card.id);
    gate.resolve(evaluation());
    await pending;
    expect(app.broker.executing).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(3);
  });
  it("keeps metadata errors manual even with visible detection disabled", async () => {
    const { app, card } = harness();
    query.mockResolvedValue({ error: "metadata unavailable", results: [] });
    await app.evaluateNext();
    expect(card.autoStatus).toContain("Metadata unavailable");
    expect(app.broker.evaluate).not.toHaveBeenCalled();
  });
  it("holds email locally before catalog access or inference", async () => {
    const { app, card } = harness();
    card.sql = "SELECT email FROM public.users LIMIT 5";
    await app.evaluateNext();
    expect(query).not.toHaveBeenCalled();
    expect(app.broker.evaluate).not.toHaveBeenCalled();
    expect(app.broker.executing).not.toHaveBeenCalled();
    expect(card.autoStatus).toContain("Sensitive source or alias: email");
  });
  it("preserves the local hold after disabling and posts its original reason", async () => {
    const { app, card } = harness();
    card.sql = "SELECT email IS NOT NULL AS has_contact FROM public.users LIMIT 1";
    await app.evaluateNext();
    const status = card.autoStatus;
    expect(status).toContain("Sensitive source or alias: email");
    await app.toggleAuto({ closest: () => null });
    expect(card.autoStatus).toBe(status);
    await app.reject(card.id);
    expect(app.broker.result).toHaveBeenCalledWith(
      card.id,
      card.leaseId,
      expect.objectContaining({
        autoHold: { sent: false, reason: "Sensitive source or alias: email" },
      }),
    );
    expect(app.broker.evaluate).not.toHaveBeenCalled();
  });
  it("preserves a completed Jev concern when Auto mode is disabled", async () => {
    const { app, card } = harness();
    vi.spyOn(app.annotator, "inspectRead").mockResolvedValue({
      complete: true,
      reasons: [],
      input: { dialect: "postgresql", sql: card.sql, dependencies: [] },
    });
    const answer = { ...evaluation(), eligible: false, reasons: ["Potential personal disclosure"] };
    app.broker.evaluate.mockResolvedValue(answer);
    await app.evaluateNext();
    await app.toggleAuto({ closest: () => null });
    expect(card.evaluation).toEqual(answer);
    expect(card.autoStatus).toBe("Needs review: Potential personal disclosure");
    expect(app.autoHold(card)).toBeUndefined();
    expect(app.broker.executing).not.toHaveBeenCalled();
  });
  it.each(["off", "write", "destructive"])(
    "records switching to %s during evaluation and ignores a late provider approval",
    async (next) => {
      const { app, card } = harness();
      vi.spyOn(app.annotator, "inspectRead").mockResolvedValue({
        complete: true,
        reasons: [],
        input: { dialect: "postgresql", sql: card.sql, dependencies: [] },
      });
      const response = deferred<AutoEvaluation>();
      app.broker.evaluate.mockReturnValue(response.promise);
      const pending = app.evaluateNext();
      await vi.waitFor(() => expect(app.broker.evaluate).toHaveBeenCalledOnce());
      const signal = app.broker.evaluate.mock.calls[0][5] as AbortSignal;
      if (next === "off") {
        await app.toggleAuto({ closest: () => null });
      } else {
        app.confirmModal = { open: vi.fn() };
        app.requestMode(next);
        expect(app.autoEnabled).toBe(true);
        expect(signal.aborted).toBe(false);
        app.confirmModal.open.mock.calls[0][0].onConfirm();
      }
      expect(app.mode).toBe(next === "off" ? "read" : next);
      expect(signal.aborted).toBe(true);
      expect(card.autoStatus).toBe("Needs review: Auto mode disabled while evaluating");
      response.resolve(evaluation());
      await pending;
      expect(card.autoStatus).toBe("Needs review: Auto mode disabled while evaluating");
      expect(card.evaluation).toBeUndefined();
      expect(query).not.toHaveBeenCalled();
      expect(app.broker.executing).not.toHaveBeenCalled();
      await app.reject(card.id);
      expect(app.broker.result).toHaveBeenCalledWith(
        card.id,
        card.leaseId,
        expect.objectContaining({
          autoHold: { sent: true, reason: "Auto mode disabled while evaluating" },
        }),
      );
    },
  );
  it.each([
    ["SELECT email FROM public.contacts LIMIT 5", "Sensitive source or alias: email"],
    ["SELECT company_name FROM public.firms LIMIT 5", "Sensitive source or alias: company_name"],
    [
      "SELECT quantity FROM public.products WHERE note = 'alex@example.invalid'",
      "Sensitive input stays on this machine",
    ],
  ])("keeps %s local when all display detections are disabled", async (sql, reason) => {
    const { app, card } = harness();
    app.settingsStore.get = () => ({
      piiFlagging: false,
      clientFlagging: false,
      sensitiveValues: false,
    });
    card.sql = sql;
    card.schema = { tables: [], pii: [], client: [], literals: [], star: false };
    await app.evaluateNext();
    expect(card.state).toBe("ready");
    expect(card.autoStatus).toBe(`Needs review: ${reason}`);
    expect(query).not.toHaveBeenCalled();
    expect(app.broker.evaluate).not.toHaveBeenCalled();
    expect(app.broker.executing).not.toHaveBeenCalled();
  });
  it.each([
    [
      "SELECT sku, product_name, price FROM public.products LIMIT 10",
      "products",
      [
        ["sku", "text"],
        ["product_name", "text"],
        ["price", "numeric"],
      ],
    ],
    [
      "SELECT status, total FROM public.orders LIMIT 5",
      "orders",
      [
        ["status", "text"],
        ["total", "numeric"],
      ],
    ],
  ] as const)(
    "sends only referenced metadata for %s and preserves manual approval on concern",
    async (sql, table, columns) => {
      const { app, card } = harness();
      card.sql = sql;
      mockCatalog(sql, {
        [`public.${table}`]: Object.fromEntries([...columns, ["id", "int4"], ["user_id", "int4"]]),
      });
      const concern = evaluation();
      concern.eligible = false;
      concern.reasons = ["Potential access secret disclosure"];
      concern.probabilities.secret_disclosure = 0.5;
      app.broker.evaluate.mockResolvedValue(concern);
      await app.evaluateNext();
      expect(app.broker.evaluate).toHaveBeenCalledOnce();
      expect(app.broker.evaluate.mock.calls[0][4]).toEqual({
        dialect: "postgresql",
        sql: expect.stringContaining(`"public"."${table}"`),
        dependencies: columns.map(([column, type]) => ({
          schema: "public",
          table,
          column,
          type,
          usage: "output",
        })),
      });
      expect(app.broker.executing).not.toHaveBeenCalled();
      expect(card.state).toBe("ready");
      expect(card.evaluation).toEqual(concern);
      await app.approve(card.id);
      expect(app.broker.executing).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledTimes(3);
    },
  );
  it("does not retain malformed provider data that would block a later human approval", async () => {
    const { app, card } = harness();
    mockCatalog(card.sql, { "public.products": { quantity: "int4" } });
    app.broker.evaluate.mockResolvedValue({ eligible: true });
    await app.evaluateNext();
    expect(card.evaluation).toBeUndefined();
    expect(card.autoStatus).toContain("Invalid evaluator response");
    await app.approve(card.id);
    expect(app.broker.executing).toHaveBeenCalledOnce();
  });
  it.each(["write", "destructive"])("keeps Auto mode when cancelling the switch to %s", (next) => {
    const { app } = harness();
    const panel = { innerHTML: "", hidden: true, querySelector: () => ({ focus: vi.fn() }) };
    app.confirmModal = new ConfirmModal({
      addEventListener: vi.fn(),
      querySelector: () => panel,
    } as unknown as HTMLElement);
    const controller = new AbortController();
    app.autoAbort = controller;
    const generation = app.autoGeneration;
    app.requestMode(next);
    expect(app.confirmModal.isOpen).toBe(true);
    expect(panel.innerHTML).toContain("Confirming turns off Auto mode");
    if (next === "destructive") expect(panel.innerHTML).toContain("data-confirm-go disabled");
    expect(app.confirmModal.cancel()).toBe(true);
    expect(app.autoEnabled).toBe(true);
    expect(app.autoGeneration).toBe(generation);
    expect(app.mode).toBe("read");
    expect(controller.signal.aborted).toBe(false);
    expect(app.reportConnection).not.toHaveBeenCalled();
  });
  it.each(["write", "destructive"])(
    "does not let a pending activation override a confirmed switch to %s",
    async (next) => {
      const { app } = harness();
      app.autoEnabled = false;
      app.confirmModal = { open: vi.fn(), cancel: vi.fn() };
      const key = deferred<string>();
      storageRead.mockReturnValue(key.promise);
      const pending = app.toggleAuto({ ...control(), closest: () => null });
      app.requestMode(next);
      app.confirmModal.open.mock.calls[0][0].onConfirm();
      key.resolve("saved-key");
      await pending;
      expect(app.autoEnabled).toBe(false);
      expect(app.mode).toBe(next);
      expect(app.autoKey).toBe("");
      expect(app.reportConnection).toHaveBeenCalledOnce();
      expect(app.broker.checkKey).not.toHaveBeenCalled();
    },
  );
  it("never restores previous write authority when Auto mode is toggled off", async () => {
    const { app } = harness();
    app.autoEnabled = false;
    app.mode = "write";
    app.confirmModal = { cancel: vi.fn() };
    storageRead.mockResolvedValue("saved-key");
    await app.toggleAuto({ ...control(), closest: () => null });
    expect(app.autoEnabled).toBe(true);
    expect(app.mode).toBe("read");
    await app.toggleAuto({ closest: () => null });
    expect(app.autoEnabled).toBe(false);
    expect(app.mode).toBe("read");
  });
});
