import type { AutoEvaluation } from "@gatekeeper/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { AUTO_APPROVED, SAVED_KEY_MASK } from "./render/auto";
import { ConfirmModal } from "./render/confirm";
import { cardHtml } from "./render/queue";
import type { LoadResult } from "./sql/load";
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

const LIGHT: LoadResult = { lines: [], notes: [], estimates: [], heavy: false, complete: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// On a stoppable connection the approved statement leaves behind a comment tag
// (sql/stop.ts); what follows the tag must still be the statement, byte for byte.
const TAG = /^\/\* gatekeeper (req_[0-9a-f]{12} )?[0-9a-f]{12} \*\/ /;
function untag(sent: string): string {
  return sent.replace(TAG, "");
}
function executed(sql: string) {
  return expect.toSatisfy(
    (sent: unknown) => typeof sent === "string" && TAG.test(sent) && untag(sent) === sql,
  );
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
    // claim() gives every card a load check; these cards found nothing heavy.
    load: Promise.resolve(LIGHT),
    loadResult: LIGHT,
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
    autoRuns: 0,
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
    settingsStore: { get: () => ({ confirmWrites: true }) },
    confirmModal: { dismissFor: vi.fn() },
    archive: { seal: vi.fn(async () => "c2VhbGVk") },
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
  app.serverVersion = "PostgreSQL 16.2 on x86_64-pc-linux-gnu";
  app.annotator = new SchemaAnnotator({
    dialect: () => app.dialect,
    generation: () => app.connGeneration,
    defaultSchema: () => "public",
    getColumns: async () => [],
    getMetadata: async (sql) => {
      const result = await query(sql);
      if (result.error) throw new Error("Metadata query failed");
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
    policy: "auto-beta-8",
    evaluatedAt: Date.now(),
    sqlDigest: "a".repeat(64),
    eligible: true,
    reasons: [],
    probabilities: {
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
    expect(query).toHaveBeenLastCalledWith(executed(sql));
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
    expect(query).toHaveBeenLastCalledWith(executed(sql));
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
    expect(query).toHaveBeenLastCalledWith(executed(sql));
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
  it("brings the endpoint check forward when an approved query errors", async () => {
    const { app, card } = harness();
    app.nextCheckAt = Number.MAX_SAFE_INTEGER;
    query.mockResolvedValueOnce({ results: [], error: "Connection terminated unexpectedly" });
    await app.approve(card.id);
    expect(query).toHaveBeenCalledWith(executed(card.sql));
    expect(app.finish).toHaveBeenCalledWith(card.id, "failed", "query failed", {
      reason: "Connection terminated unexpectedly",
      recorded: true,
    });
    expect(app.nextCheckAt).toBe(0);
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
    expect(card.autoStatus).toContain("Metadata query failed");
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
    });
    card.sql = sql;
    card.schema = { tables: [], pii: [], client: [], complete: true };
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
    // What confirming does to Auto mode is one line of its own, naming the mode it enables.
    const mode = next === "write" ? "Write" : "Destructive";
    expect(panel.innerHTML).toContain(`Enabling ${mode} mode automatically turns off Auto mode.`);
    expect(panel.innerHTML).toContain('<p class="confirm-auto">');
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

describe("Auto mode queue while an approved read executes", () => {
  const empty = { results: [{ rows: [], fields: [] }] };

  // Two reads, both cleared by Jev; the host metadata step is stubbed out.
  function twoReads() {
    const { app, card } = harness();
    const next: Card = {
      ...card,
      id: "next",
      leaseId: "next-lease",
      sql: "SELECT price FROM public.products LIMIT 5",
    };
    app.cards.push(next);
    vi.spyOn(app.annotator, "inspectRead").mockImplementation(async (sql: string) => ({
      complete: true,
      reasons: [],
      input: { dialect: "postgresql", sql, dependencies: [] },
    }));
    app.broker.evaluate.mockImplementation(async () => evaluation());
    return { app, card, next };
  }

  it("evaluates and runs the next read while the first one is still executing", async () => {
    const { app, card, next } = twoReads();
    const first = deferred<typeof empty>();
    query.mockImplementation((sql: string) =>
      untag(sql) === card.sql ? first.promise : Promise.resolve(empty),
    );
    const pending = app.evaluateNext();
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith(executed(next.sql)));
    expect(card.state).toBe("executing");
    expect(card.autoStatus).toBe(AUTO_APPROVED);
    const html = cardHtml(card, "postgresql", new Map());
    expect(html).not.toContain("Evaluating with Jev");
    expect(html).toContain("This read was approved automatically");
    first.resolve(empty);
    await pending;
    expect(app.broker.executing.mock.calls.map((c: unknown[]) => c[0])).toEqual([card.id, next.id]);
    for (const call of app.broker.executing.mock.calls) {
      expect(call[2]).toMatchObject({ source: "automatic" });
    }
    // The second read delivered its result while the first was still running.
    expect(app.broker.result.mock.calls.map((c: unknown[]) => c[0])).toEqual([next.id, card.id]);
  });

  it("evaluates no new read while three automatic reads are still running", async () => {
    const { app, card } = twoReads();
    const reads: Card[] = [1, 2, 3].map((n) => ({
      ...card,
      id: `read-${n}`,
      leaseId: `lease-${n}`,
      sql: `SELECT price FROM public.products LIMIT ${n}`,
    }));
    app.cards = [card, ...reads];
    const held = new Map<string, ReturnType<typeof deferred<typeof empty>>>();
    query.mockImplementation((sent: string) => {
      const sql = untag(sent);
      if (sql === reads[2].sql) return Promise.resolve(empty);
      const gate = deferred<typeof empty>();
      held.set(sql, gate);
      return gate.promise;
    });
    const pending = app.evaluateNext();
    await vi.waitFor(() => expect(held.size).toBe(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(app.broker.evaluate).toHaveBeenCalledTimes(3);
    expect(reads[2].state).toBe("ready");
    held.get(card.sql)?.resolve(empty);
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith(executed(reads[2].sql)));
    for (const gate of held.values()) gate.resolve(empty);
    await pending;
  });

  it("keeps the first approval when the next read's evaluation is aborted before its SQL", async () => {
    const { app, card, next } = twoReads();
    const executing = deferred<boolean>();
    const nextAnswer = deferred<AutoEvaluation>();
    app.broker.executing.mockImplementation(async (id: string) =>
      id === card.id ? executing.promise : true,
    );
    app.broker.evaluate.mockImplementation(async (id: string) =>
      id === next.id ? nextAnswer.promise : evaluation(),
    );
    const pending = app.evaluateNext();
    // The first read must be held before its SQL, the window where its approval is checked.
    await vi.waitFor(() => {
      expect(app.broker.executing.mock.calls.some((c: unknown[]) => c[0] === card.id)).toBe(true);
      expect(app.broker.evaluate).toHaveBeenCalledTimes(2);
    });
    // A human approves the next card mid-evaluation, which aborts that evaluation only.
    await app.approve(next.id);
    executing.resolve(true);
    nextAnswer.resolve(evaluation());
    await pending;
    expect(
      query.mock.calls.filter((c: unknown[]) => untag(String(c[0])) === card.sql),
    ).toHaveLength(1);
    expect(app.broker.withdrawExecution).not.toHaveBeenCalledWith(card.id, card.leaseId);
  });

  it("still withdraws the first read if Auto mode is disabled before its SQL", async () => {
    const { app, card, next } = twoReads();
    const executing = deferred<boolean>();
    const nextAnswer = deferred<AutoEvaluation>();
    app.broker.executing.mockImplementation(async (id: string) =>
      id === card.id ? executing.promise : true,
    );
    app.broker.evaluate.mockImplementation(async (id: string) =>
      id === next.id ? nextAnswer.promise : evaluation(),
    );
    const pending = app.evaluateNext();
    // The first read must be held before its SQL, the window where its approval is checked.
    await vi.waitFor(() => {
      expect(app.broker.executing.mock.calls.some((c: unknown[]) => c[0] === card.id)).toBe(true);
      expect(app.broker.evaluate).toHaveBeenCalledTimes(2);
    });
    app.resetAuto("Auto mode disabled");
    executing.resolve(true);
    nextAnswer.resolve(evaluation());
    await pending;
    expect(query).not.toHaveBeenCalledWith(executed(card.sql));
    expect(app.broker.withdrawExecution).toHaveBeenCalledWith(card.id, card.leaseId);
    expect(card.state).toBe("ready");
    expect(card.autoStatus).toMatch(/^Needs review: /);
  });

  describe("15 s evaluation budget", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal("window", { setTimeout, clearTimeout });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("stops at Jev's answer instead of running over the execution preamble", async () => {
      const { app, card } = harness();
      vi.spyOn(app.annotator, "inspectRead").mockResolvedValue({
        complete: true,
        reasons: [],
        input: { dialect: "postgresql", sql: card.sql, dependencies: [] },
      });
      app.broker.evaluate.mockResolvedValue(evaluation());
      const executing = deferred<boolean>();
      app.broker.executing.mockReturnValue(executing.promise);
      const pending = app.evaluateNext();
      await vi.waitFor(() => expect(app.broker.executing).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(16_000);
      executing.resolve(true);
      await pending;
      expect(query).toHaveBeenCalledWith(executed(card.sql));
      expect(app.broker.withdrawExecution).not.toHaveBeenCalled();
    });

    it("still sends a slow evaluation to manual review", async () => {
      const { app, card } = harness();
      vi.spyOn(app.annotator, "inspectRead").mockResolvedValue({
        complete: true,
        reasons: [],
        input: { dialect: "postgresql", sql: card.sql, dependencies: [] },
      });
      const answer = deferred<AutoEvaluation>();
      app.broker.evaluate.mockReturnValue(answer.promise);
      const pending = app.evaluateNext();
      await vi.waitFor(() => expect(app.broker.evaluate).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(15_000);
      expect(card.autoStatus).toBe("Needs review: Evaluation timed out. Approve manually");
      answer.resolve(evaluation());
      await pending;
      expect(app.broker.executing).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    // Held by the evaluator, the queued read would never be evaluated nor left to a human, so its
    // alert would stay owed to Auto mode for good.
    it("frees the evaluator at the deadline when a host call never answers", async () => {
      const { app, card } = harness();
      const queued: Card = { ...card, id: "req_b", leaseId: "lease_b" };
      app.cards.push(queued);
      const stuck = deferred<null>();
      const inspect = vi
        .spyOn(app.annotator, "inspectRead")
        .mockReturnValueOnce(stuck.promise)
        .mockReturnValueOnce(new Promise(() => {}));
      const first = app.evaluateNext();
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(15_000);
      expect(card.autoStatus).toBe("Needs review: Evaluation timed out. Approve manually");
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
      expect(queued.autoStatus).toBe("Evaluating with Jev");
      // The first evaluation settling late leaves the one now running alone.
      stuck.resolve(null);
      await first;
      expect(app.autoBusy).toBe(true);
      expect(app.autoCard).toBe(queued);
    });
  });
});

describe("stopping a running query", () => {
  type Answer = { results: { rows: Record<string, unknown>[]; fields: [] }[]; error?: unknown };
  const answer = (row: Record<string, unknown>): Answer => ({
    results: [{ rows: [row], fields: [] }],
  });
  const sent = answer({ sent: true, matches: "1" });
  const notFound = answer({ sent: null, matches: "0" });
  const cancelled: Answer = {
    results: [],
    error: { message: "canceling statement due to user request" },
  };

  // The approved query is held on `run`; every stop statement goes through `stop`.
  function running(onStop: (sql: string) => Promise<Answer>, minutes = 0) {
    const { app, card } = harness();
    app.settingsStore = {
      get: () => ({ confirmWrites: true, autoStopMinutes: minutes }),
    };
    const run = deferred<Answer>();
    const stop = vi.fn(onStop);
    query.mockImplementation((sql: string) => (TAG.test(sql) ? run.promise : stop(sql)));
    const pending = app.approve(card.id);
    return { app, card, run, stop, pending };
  }

  it("cancels through the database and reports the request as a fact", async () => {
    const { app, card, run, stop, pending } = running(async () => sent);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    await vi.waitFor(() => expect(card.run.stop.state).toBe("sent"));
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.calls[0][0]).toContain(`= '${card.run.tag}'`);
    run.resolve(cancelled);
    await pending;
    const message = app.broker.result.mock.calls[0][2].error;
    expect(message).toMatch(
      /^Stop requested by the operator after \d+s\. The query then ended with: canceling statement due to user request$/,
    );
    expect(app.finish).toHaveBeenCalledWith(card.id, "failed", "query failed", {
      reason: message,
      recorded: true,
    });
  });

  it("delivers the normal result when the query finishes before the stop lands", async () => {
    const { app, card, run, pending } = running(async () => notFound);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    run.resolve(answer({ quantity: 3 }));
    await pending;
    const body = app.broker.result.mock.calls[0][2];
    expect(body.status).toBe("approved");
    expect(body.error).toBeUndefined();
    expect(body.rows).toEqual([{ quantity: 3 }]);
  });

  it("never sends a stop once the query has settled", async () => {
    const { app, card, run, stop, pending } = running(async () => notFound);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    run.resolve(answer({ quantity: 3 }));
    await pending;
    app.tickRuns(Date.now());
    app.requestStop(card, "operator");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps one stop request in flight, however often it is asked", async () => {
    const { app, card, stop } = running(() => new Promise<Answer>(() => {}));
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    app.requestStop(card, "operator");
    app.tickRuns(Date.now());
    app.tickRuns(Date.now() + 1000);
    expect(stop).toHaveBeenCalledOnce();
    expect(card.run.stop.state).toBe("pending");
  });

  it("ignores a stop answer that arrives after a connection switch", async () => {
    const late = deferred<Answer>();
    const { app, card, run, pending } = running(() => late.promise);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    app.onConnectionSwitch();
    late.resolve(sent);
    run.resolve(cancelled);
    await pending;
    expect(card.run.stop.state).toBe("pending");
    expect(card.run.stop.sentAt).toBeUndefined();
  });

  it("shows the database's refusal and lets the operator try again", async () => {
    const refusals: Answer[] = [
      { results: [], error: { message: "permission denied to cancel query" } },
      sent,
    ];
    const { app, card, stop } = running(async () => refusals.shift() ?? sent);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    await vi.waitFor(() => expect(card.run.stop.error).toBe("permission denied to cancel query"));
    expect(card.run.stop.state).toBe("idle");
    app.requestStop(card, "operator");
    await vi.waitFor(() => expect(card.run.stop.state).toBe("sent"));
    expect(card.run.stop.error).toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("gives up after a few attempts that do not find the query", async () => {
    const { app, card, stop } = running(async () => notFound);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    for (let i = 1; i < 5; i++) {
      await vi.waitFor(() => expect(card.run.stop.inFlight).toBe(false));
      app.tickRuns(Date.now());
    }
    await vi.waitFor(() =>
      expect(card.run.stop.error).toBe(
        "The running query was not found in the database's activity",
      ),
    );
    expect(stop).toHaveBeenCalledTimes(5);
  });

  it("auto-stops at the limit captured when the query started", async () => {
    const { app, card, run, stop, pending } = running(async () => sent, 1);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.settingsStore = {
      get: () => ({ confirmWrites: true, autoStopMinutes: 0 }),
    };
    app.tickRuns(card.run.startedAt + 59_000);
    expect(stop).not.toHaveBeenCalled();
    app.tickRuns(card.run.startedAt + 60_000);
    await vi.waitFor(() => expect(card.run.stop.state).toBe("sent"));
    expect(card.run.stop.by).toBe("limit");
    run.resolve(cancelled);
    await pending;
    expect(app.broker.result.mock.calls[0][2].error).toBe(
      "Stop requested by auto-stop at the 1 min limit set on this connection. The query then ended with: canceling statement due to user request",
    );
  });

  it("keeps the operator's request when the limit is reached afterwards", async () => {
    const { app, card } = running(async () => sent, 1);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    await vi.waitFor(() => expect(card.run.stop.state).toBe("sent"));
    app.tickRuns(card.run.startedAt + 60_000);
    expect(card.run.stop.by).toBe("operator");
  });

  it.each([
    ["sqlite", false, "PostgreSQL or MySQL is required to stop a query."],
    ["mysql", true, "A writable connection is required to stop a MySQL query."],
  ])("runs the untouched SQL and offers no stop on %s (read-only %s)", async (type, ro, why) => {
    const { app, card } = harness();
    connection.mockResolvedValue({
      id: 1,
      connectionName: "test",
      databaseType: type,
      databaseName: "test",
      defaultSchema: "public",
      readOnlyMode: ro,
    });
    Object.assign(app.conn, { databaseType: type, readOnly: ro });
    app.serverVersion = "8.4.0";
    const run = deferred<Answer>();
    query.mockReturnValue(run.promise);
    const pending = app.approve(card.id);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    expect(query).toHaveBeenCalledWith(card.sql);
    expect(card.run.unavailable).toBe(why);
    app.requestStop(card, "operator");
    run.resolve(answer({ quantity: 3 }));
    await pending;
    expect(query).toHaveBeenCalledOnce();
  });

  it("sends MySQL 8.0.19+ a single KILL QUERY batch", async () => {
    const { app, card } = harness();
    connection.mockResolvedValue({
      id: 1,
      connectionName: "test",
      databaseType: "mysql",
      databaseName: "test",
      defaultSchema: "public",
      readOnlyMode: false,
    });
    Object.assign(app.conn, { databaseType: "mysql" });
    app.serverVersion = "8.0.36";
    const run = deferred<Answer>();
    const stop = vi.fn(async () => ({
      results: [
        { rows: [], fields: [] },
        { rows: [{ matches: 1 }], fields: [] },
      ],
    }));
    query.mockImplementation((sql: string) => (TAG.test(sql) ? run.promise : stop(sql)));
    const pending = app.approve(card.id);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    await vi.waitFor(() => expect(card.run.stop.state).toBe("sent"));
    expect(stop.mock.calls[0][0]).toContain("CONCAT('KILL QUERY ', @gk_target)");
    run.resolve(cancelled);
    await pending;
  });

  it("records the request without claiming it caused an unrelated failure", async () => {
    const { app, card, run, pending } = running(async () => ({
      results: [],
      error: { message: "permission denied to cancel query" },
    }));
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    await vi.waitFor(() => expect(card.run.stop.state).toBe("idle"));
    run.resolve({ results: [], error: { message: 'duplicate key value violates "users_pkey"' } });
    await pending;
    expect(app.broker.result.mock.calls[0][2].error).toMatch(
      /^Stop requested by the operator after \d+s\. The query then ended with: duplicate key value violates "users_pkey"$/,
    );
  });

  it("lets the operator try again when an accepted cancel did not end the query", async () => {
    const { app, card, stop } = running(async () => sent);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.requestStop(card, "operator");
    await vi.waitFor(() => expect(card.run.stop.state).toBe("sent"));
    app.tickRuns(card.run.stop.sentAt + 9_999);
    expect(card.run.stop.state).toBe("sent");
    app.tickRuns(card.run.stop.sentAt + 10_000);
    expect(card.run.stop.state).toBe("idle");
    app.requestStop(card, "operator");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
  });

  it("still stops a query whose lease was lost while it runs", async () => {
    const { app, card, stop } = running(async () => sent);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    card.authorityLost = true;
    app.requestStop(card, "operator");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("forgets the server version with the endpoint check on a switch or a reactivation", () => {
    const { app } = harness();
    app.resetCheck();
    expect(app.serverVersion).toBeNull();
  });

  it("offers no Stop until a check has reported the server version", async () => {
    const { app, card } = harness();
    connection.mockResolvedValue({
      id: 1,
      connectionName: "test",
      databaseType: "mysql",
      databaseName: "test",
      defaultSchema: "public",
      readOnlyMode: false,
    });
    Object.assign(app.conn, { databaseType: "mysql" });
    app.serverVersion = null;
    const run = deferred<Answer>();
    query.mockReturnValue(run.promise);
    const pending = app.approve(card.id);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    expect(card.run.unavailable).toBe("MySQL 8.0.19 or later is required to stop a query.");
    expect(query).toHaveBeenCalledWith(card.sql);
    run.resolve(answer({ quantity: 3 }));
    await pending;
  });
});

describe("sensitivity recorded with the decision", () => {
  it("keeps raw flags on the card even when the display toggles hide them", async () => {
    const { app, card } = harness();
    app.renderCardSchema = vi.fn();
    card.sql = "SELECT email FROM public.users";
    await app.analyzeSchema(card);
    expect(card.schema?.pii).toEqual([]);
    expect(card.sensitivity).toEqual({ pii: true, value: false, client: false });
  });

  it("falls back to the SQL text when the decision lands before the analysis", async () => {
    const { app, card } = harness();
    card.sql = "SELECT email FROM public.users";
    await app.postExecuting(card);
    expect(app.broker.executing.mock.calls[0][3]).toEqual({
      pii: true,
      value: false,
      client: false,
    });
  });

  it("records no flags for an output it could not fully trace, even with PII known in it", async () => {
    const { app, card } = harness();
    app.renderCardSchema = vi.fn();
    card.sql = "SELECT u.email, f.* FROM public.users u, contact_points(u.id) f";
    await app.analyzeSchema(card);
    expect(card.schema?.complete).toBe(false);
    expect(card.sensitivity).toBeUndefined();
    await app.postExecuting(card);
    await app.postResult(card, { status: "rejected" });
    expect(app.broker.executing.mock.calls[0][3]).toBeUndefined();
    expect(app.broker.result.mock.calls[0][2].sensitivity).toBeUndefined();
  });

  it("posts the card's analysis with an approval and with a rejection", async () => {
    const { app, card } = harness();
    const recorded = { pii: false, value: true, client: true };
    card.sensitivity = recorded;
    await app.postExecuting(card);
    await app.postResult(card, { status: "rejected" });
    expect(app.broker.executing.mock.calls[0][3]).toEqual(recorded);
    expect(app.broker.result.mock.calls[0][2]).toMatchObject({ sensitivity: recorded });
  });
});

describe("generation changes during an approved run", () => {
  const rows = { results: [{ rows: [{ quantity: 3 }], fields: [{ name: "quantity" }] }] };

  it("delivers the result when only the schema changed while the query ran", async () => {
    const { app, card } = harness();
    const run = deferred<typeof rows>();
    query.mockReturnValue(run.promise);
    const pending = app.approve(card.id);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    // What the tablesChanged handler does to the generation; it keeps the cards.
    app.connGeneration++;
    run.resolve(rows);
    await pending;
    expect(app.broker.result.mock.calls[0][2]).toMatchObject({
      status: "approved",
      rows: [{ quantity: 3 }],
    });
    expect(app.finish).toHaveBeenCalledWith(
      card.id,
      "approved",
      expect.any(String),
      expect.anything(),
    );
  });

  it("still withholds the rows after a connection switch", async () => {
    const { app, card } = harness();
    const run = deferred<typeof rows>();
    query.mockReturnValue(run.promise);
    const pending = app.approve(card.id);
    await vi.waitFor(() => expect(card.state).toBe("executing"));
    app.onConnectionSwitch();
    run.resolve(rows);
    await pending;
    expect(app.broker.result).not.toHaveBeenCalled();
  });

  it("withholds the rows when the connection switches while they are sealed", async () => {
    const { app, card } = harness();
    const sealing = deferred<string>();
    app.archive.seal = vi.fn(() => sealing.promise);
    query.mockResolvedValue(rows);
    const pending = app.approve(card.id);
    await vi.waitFor(() => expect(app.archive.seal).toHaveBeenCalled());
    app.onConnectionSwitch();
    sealing.resolve("c2VhbGVk");
    await pending;
    expect(app.broker.result).not.toHaveBeenCalled();
  });
});

describe("kept results", () => {
  const rows = { results: [{ rows: [{ quantity: 3 }], fields: [{ name: "quantity" }] }] };

  it("seals what the agent is sent and posts it with the decision", async () => {
    const { app, card } = harness();
    query.mockResolvedValue(rows);
    await app.approve(card.id);
    const [sealedResult, requestId] = app.archive.seal.mock.calls[0];
    expect(requestId).toBe(card.id);
    const body = app.broker.result.mock.calls[0][2];
    expect(sealedResult).toEqual({
      fields: body.fields,
      rows: body.rows,
      rowCount: body.rowCount,
      truncated: body.truncated,
    });
    expect(body.archive).toBe("c2VhbGVk");
    expect(app.finish).toHaveBeenCalledWith(card.id, "approved", expect.any(String), {
      result: sealedResult,
      recorded: true,
      kept: true,
    });
  });

  it("keeps renewing the execution lease while the result is sealed", async () => {
    const { app, card } = harness();
    const sealing = deferred<string>();
    app.archive.seal = vi.fn(() => sealing.promise);
    app.broker.renew = vi.fn(async () => ({ ok: true, leaseExpiresAt: Date.now() + 30_000 }));
    query.mockResolvedValue(rows);
    const pending = app.approve(card.id);
    await vi.waitFor(() => expect(app.archive.seal).toHaveBeenCalled());
    expect(card.state).toBe("executing");
    await app.renew();
    expect(app.broker.renew).toHaveBeenCalledWith(card.id, card.leaseId);
    sealing.resolve("c2VhbGVk");
    await pending;
    expect(app.broker.result.mock.calls[0][2].archive).toBe("c2VhbGVk");
  });

  it.each([
    ["acknowledged", true],
    ["refused", false],
  ])("lists a decline as recorded only when the server %s it", async (_, ok) => {
    const { app, card } = harness();
    app.setCardState = vi.fn();
    app.broker.result = vi.fn(async () => ok);
    await app.reject(card.id, "use the replica");
    expect(app.broker.result.mock.calls[0][2]).toMatchObject({ declinedBy: "human" });
    expect(app.finish).toHaveBeenCalledWith(card.id, "rejected", "declined", {
      reason: "use the replica",
      declinedBy: "human",
      recorded: ok,
      sent: ok ? "use the replica" : undefined,
    });
  });

  it("still delivers the rows to the agent when they cannot be sealed", async () => {
    const { app, card } = harness();
    app.archive.seal = vi.fn(async () => {
      throw new Error("Result key was not stored");
    });
    query.mockResolvedValue(rows);
    await app.approve(card.id);
    const body = app.broker.result.mock.calls[0][2];
    expect(body).toMatchObject({ status: "approved", rows: [{ quantity: 3 }] });
    expect(body).not.toHaveProperty("archive");
  });
});

describe("load check", () => {
  const HEAVY: LoadResult = {
    lines: [["Reads every row of ", { code: "big" }, " without a ", { code: "WHERE" }, " clause"]],
    notes: [],
    estimates: [{ table: "big", rows: 2_000_000 }],
    heavy: true,
    complete: true,
  };
  const UNKNOWN: LoadResult = {
    lines: [],
    notes: [[{ code: "daily" }, " is a view with no row estimate"]],
    estimates: [],
    heavy: false,
    complete: false,
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function arrive(
    app: ReturnType<typeof harness>["app"],
    card: Card,
    result: Promise<LoadResult | undefined>,
    autoDenyHeavy = true,
    loaded = true,
  ) {
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    app.settingsStore = {
      get: () => ({ confirmWrites: true, autoDenyHeavy }),
      loadedForConnection: () => loaded,
    };
    vi.spyOn(app.annotator, "inspectLoad").mockReturnValue(result);
    app.startLoad(card, true);
  }

  it("holds a heavy read before anything leaves for the provider", async () => {
    const { app, card } = harness();
    card.load = Promise.resolve(HEAVY);
    const inspect = vi.spyOn(app.annotator, "inspectRead");
    await app.evaluateNext();
    expect(card.autoStatus).toBe("Needs review: Heavy query");
    expect(inspect).not.toHaveBeenCalled();
    expect(app.broker.evaluate).not.toHaveBeenCalled();
    expect(app.broker.executing).not.toHaveBeenCalled();
  });

  it.each([
    ["incomplete", Promise.resolve(UNKNOWN)],
    ["never started", undefined],
  ])("lets a read whose load check is %s go on to the usual evaluation", async (_, load) => {
    const { app, card } = harness();
    card.load = load;
    const inspect = vi
      .spyOn(app.annotator, "inspectRead")
      .mockResolvedValue({ complete: false, reasons: ["Metadata unavailable"] });
    await app.evaluateNext();
    expect(inspect).toHaveBeenCalled();
    expect(card.autoStatus).toBe("Needs review: Metadata unavailable");
  });

  it("auto-denies a heavy query on arrival with hints from its SQL only", async () => {
    const { app, card } = harness();
    app.autoEnabled = false;
    card.sql = "SELECT count(*) FROM public.big";
    arrive(app, card, Promise.resolve(HEAVY));
    await flush();
    const sent =
      "Rejected automatically by the load check. The query reads a table without a WHERE clause.";
    expect(app.broker.result).toHaveBeenCalledWith(
      card.id,
      card.leaseId,
      expect.objectContaining({ status: "rejected", reason: sent }),
    );
    expect(app.broker.result.mock.calls[0][2]).toMatchObject({ declinedBy: "load" });
    expect(app.finish).toHaveBeenCalledWith(card.id, "rejected", "heavy query, auto-denied", {
      declinedBy: "load",
      recorded: true,
      sent,
      autoDenied: true,
    });
  });

  it("wins against Auto mode and never lets the read run", async () => {
    const { app, card } = harness();
    const settled = deferred<LoadResult | undefined>();
    arrive(app, card, settled.promise);
    const evaluating = app.evaluateNext();
    settled.resolve(HEAVY);
    await evaluating;
    await flush();
    expect(app.broker.result).toHaveBeenCalledOnce();
    expect(app.broker.result).toHaveBeenCalledWith(
      card.id,
      card.leaseId,
      expect.objectContaining({ autoHold: { sent: false, reason: "Heavy query" } }),
    );
    expect(app.broker.evaluate).not.toHaveBeenCalled();
    expect(app.broker.executing).not.toHaveBeenCalled();
  });

  it("leaves the card for review when the setting is off or nothing is heavy", async () => {
    for (const [result, setting] of [
      [HEAVY, false],
      [UNKNOWN, true],
    ] as const) {
      const { app, card } = harness();
      arrive(app, card, Promise.resolve(result), setting);
      await flush();
      expect(app.broker.result).not.toHaveBeenCalled();
      expect(card.state).toBe("ready");
      expect(card.loadResult).toBe(result);
    }
  });

  it("never auto-denies a card a human is already approving or a removed card", async () => {
    const { app, card } = harness();
    const settled = deferred<LoadResult | undefined>();
    arrive(app, card, settled.promise);
    card.state = "approving";
    settled.resolve(HEAVY);
    await flush();
    expect(app.broker.result).not.toHaveBeenCalled();

    const second = harness();
    const late = deferred<LoadResult | undefined>();
    arrive(second.app, second.card, late.promise);
    second.app.cards = [];
    late.resolve(HEAVY);
    await flush();
    expect(second.app.broker.result).not.toHaveBeenCalled();
    expect(second.card.loadResult?.heavy).toBe(false);
  });

  it("never auto-denies on a recheck after a schema change", async () => {
    const { app, card } = harness();
    arrive(app, card, Promise.resolve(HEAVY));
    app.startLoad(card, false);
    await flush();
    expect(app.broker.result).not.toHaveBeenCalled();
    expect(card.loadResult).toBe(HEAVY);
  });

  it("returns the card to review when the rejection cannot be delivered", async () => {
    const { app, card } = harness();
    app.broker.result.mockResolvedValueOnce(false);
    arrive(app, card, Promise.resolve(HEAVY));
    await flush();
    expect(app.finish).not.toHaveBeenCalled();
    expect(card.state).toBe("ready");
  });

  it("settles to a timeout note that keeps the SQL-only findings", async () => {
    vi.useFakeTimers();
    try {
      const { app, card } = harness();
      card.sql = "DELETE FROM public.sessions";
      vi.stubGlobal("window", { setTimeout, clearTimeout });
      arrive(app, card, new Promise(() => {}), false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(card.loadResult?.heavy).toBe(true);
      expect(card.loadResult?.notes).toEqual([["Statistics did not return within 5 seconds"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("appends SQL-only hints to the rejection of a flagged card and records them once delivered", async () => {
    const { app, card } = harness();
    card.sql = "DELETE FROM public.sessions";
    card.loadResult = HEAVY;
    await app.reject(card.id, "Narrow it to last week.");
    const sent = "Narrow it to last week. The DELETE has no WHERE clause.";
    expect(app.broker.result).toHaveBeenCalledWith(
      card.id,
      card.leaseId,
      expect.objectContaining({ status: "rejected", reason: sent }),
    );
    expect(app.broker.result.mock.calls[0][2]).toMatchObject({
      declinedBy: "human",
      reasonTyped: true,
    });
    expect(app.finish).toHaveBeenCalledWith(card.id, "rejected", "declined", {
      reason: "Narrow it to last week.",
      declinedBy: "human",
      recorded: true,
      sent,
    });

    const failed = harness();
    failed.card.sql = "DELETE FROM public.sessions";
    failed.card.loadResult = HEAVY;
    failed.app.broker.result.mockResolvedValueOnce(false);
    await failed.app.reject(failed.card.id);
    expect(failed.app.finish).toHaveBeenCalledWith(failed.card.id, "rejected", "declined", {
      reason: undefined,
      declinedBy: "human",
      recorded: false,
      sent: undefined,
    });
  });

  it("sends no hint with the decline of a card that showed no alert", async () => {
    const { app, card } = harness();
    card.sql = "SELECT * FROM public.feature_flags";
    await app.reject(card.id);
    expect(app.broker.result).toHaveBeenCalledWith(
      card.id,
      card.leaseId,
      expect.objectContaining({ status: "rejected", reason: undefined }),
    );
  });
});

describe("load check binding", () => {
  const HEAVY: LoadResult = {
    lines: [["Reads every row of ", { code: "big" }]],
    notes: [],
    estimates: [],
    heavy: true,
    complete: true,
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function start(app: ReturnType<typeof harness>["app"], card: Card, loaded = true) {
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    app.settingsStore = {
      get: () => ({ confirmWrites: true, autoDenyHeavy: true }),
      loadedForConnection: () => loaded,
    };
    const settled = deferred<LoadResult | undefined>();
    const inspect = vi.spyOn(app.annotator, "inspectLoad").mockReturnValue(settled.promise);
    app.startLoad(card, true);
    return { settled, live: inspect.mock.calls[0][1] as () => boolean };
  }

  it("waits for the current connection's preferences before auto-denying", async () => {
    const { app, card } = harness();
    const { settled } = start(app, card, false);
    settled.resolve(HEAVY);
    await flush();
    expect(app.broker.result).not.toHaveBeenCalled();
    expect(card.state).toBe("ready");
  });

  it("never auto-denies after a re-pair or under a replaced lease", async () => {
    const repaired = harness();
    const a = start(repaired.app, repaired.card);
    repaired.app.activeGen++;
    expect(a.live()).toBe(false);
    a.settled.resolve(HEAVY);
    await flush();
    expect(repaired.app.broker.result).not.toHaveBeenCalled();

    const reoffered = harness();
    const b = start(reoffered.app, reoffered.card);
    reoffered.card.leaseId = "fresh-lease";
    b.settled.resolve(HEAVY);
    await flush();
    expect(reoffered.app.broker.result).not.toHaveBeenCalled();
  });

  it("stops starting host work once the card is decided or the deadline passed", async () => {
    vi.useFakeTimers();
    try {
      const { app, card } = harness();
      vi.stubGlobal("window", { setTimeout, clearTimeout });
      const { live } = start(app, card);
      expect(live()).toBe(true);
      card.state = "approving";
      expect(live()).toBe(false);
      card.state = "ready";
      await vi.advanceTimersByTimeAsync(5000);
      expect(live()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a delivered rejection even if the schema changed while it was in flight", async () => {
    const { app, card } = harness();
    const delivered = deferred<boolean>();
    app.broker.result.mockReturnValueOnce(delivered.promise);
    const { settled } = start(app, card);
    settled.resolve(HEAVY);
    await flush();
    expect(card.state).toBe("rejecting");
    app.connGeneration++;
    delivered.resolve(true);
    await flush();
    expect(app.finish).toHaveBeenCalledWith(
      card.id,
      "rejected",
      "heavy query, auto-denied",
      expect.objectContaining({ autoDenied: true, recorded: true }),
    );
  });

  it("releases an undelivered rejection without leaving Auto mode's evaluating status", async () => {
    const { app, card } = harness();
    app.broker.result.mockResolvedValueOnce(false);
    const { settled } = start(app, card);
    card.autoStatus = "Evaluating with Jev";
    settled.resolve(HEAVY);
    await flush();
    expect(card.state).toBe("ready");
    expect(card.autoStatus).toBe("Needs review: Heavy query");
    expect(app.finish).not.toHaveBeenCalled();
  });
});

describe("load check after a re-pair", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const setup = () => {
    const { app, card } = harness();
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    app.settingsStore = {
      get: () => ({ confirmWrites: true, autoDenyHeavy: true }),
      loadedForConnection: () => true,
    };
    return { app, card, inspect: vi.spyOn(app.annotator, "inspectLoad") };
  };

  it("restarts a check cut short once the card is claimed again", async () => {
    const { app, card, inspect } = setup();
    inspect.mockResolvedValueOnce(undefined);
    app.startLoad(card, true);
    app.activeGen++;
    await flush();
    inspect.mockResolvedValueOnce(LIGHT);
    app.claim({ ...card });
    await flush();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(card.loadResult).toBe(LIGHT);
  });

  it("restarts a check still waiting on the host when the card is claimed again", async () => {
    const { app, card, inspect } = setup();
    const old = deferred<LoadResult | undefined>();
    inspect.mockReturnValueOnce(old.promise);
    app.startLoad(card, true);
    app.activeGen++;
    inspect.mockResolvedValueOnce(LIGHT);
    app.claim({ ...card });
    await flush();
    old.resolve(undefined);
    await flush();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(card.loadResult).toBe(LIGHT);
  });

  it("keeps a check of the same session when a re-offer claims the card again", async () => {
    const { app, card, inspect } = setup();
    inspect.mockResolvedValueOnce(LIGHT);
    app.startLoad(card, true);
    app.claim({ ...card });
    await flush();
    expect(inspect).toHaveBeenCalledOnce();
  });
});

describe("decision-time flags", () => {
  it("keeps the /executing snapshot when the column analysis lands after the approval", async () => {
    const { app, card } = harness();
    card.sql = "SELECT * FROM public.users";
    await app.postExecuting(card);
    const posted = app.broker.executing.mock.calls[0][3];
    // The analysis finishes mid-run and finds PII the SQL text alone could not show.
    card.sensitivity = { pii: true, value: false, client: false };
    await app.postResult(card, { status: "approved" });
    expect(app.broker.result.mock.calls[0][2].sensitivity).toEqual(posted);
    // The local row shows what the trail recorded, not the later analysis.
    Object.assign(app, {
      finish: Gatekeeper.prototype["finish" as keyof Gatekeeper],
      decided: [],
      unrecorded: new WeakSet(),
      selection: {},
      drop: vi.fn(),
      refreshRecent: vi.fn(),
      settingsStore: { get: () => ({ recentlyResolved: 20 }) },
    });
    app.finish(card.id, "approved", "", { recorded: true });
    expect(app.decided[0].sensitivity).toEqual(posted);
    expect(app.decided[0].sensitivity?.pii).not.toBe(true);
  });

  it("posts fresh flags with the next decision once an execution is withdrawn", async () => {
    const { app, card } = harness();
    await app.postExecuting(card);
    card.decisionSensitivity!.standing = false;
    card.sensitivity = { pii: true, value: false, client: false };
    await app.postResult(card, { status: "rejected" });
    expect(app.broker.result.mock.calls[0][2].sensitivity).toEqual({
      pii: true,
      value: false,
      client: false,
    });
  });

  it("keeps the broker's flags when a withdrawn request expires with no new decision", () => {
    const { app, card } = harness();
    const recorded = { pii: true, value: false, client: false };
    card.decisionSensitivity = { value: recorded, standing: false };
    card.sql = "SELECT * FROM public.users";
    Object.assign(app, {
      finish: Gatekeeper.prototype["finish" as keyof Gatekeeper],
      decided: [],
      unrecorded: new WeakSet(),
      selection: {},
      drop: vi.fn(),
      refreshRecent: vi.fn(),
      settingsStore: { get: () => ({ recentlyResolved: 20 }) },
    });
    app.finish(card.id, "expired", "expired", { recorded: true });
    expect(app.decided[0].sensitivity).toEqual(recorded);
  });
});

describe("holds that are not Auto mode's", () => {
  it("keeps a human approval's failed connection check out of Auto mode and the trail", async () => {
    const { app, card } = harness();
    app.autoEnabled = false;
    app.checkConnection = vi.fn(async () => false);
    await app.approve(card.id);
    expect(card.state).toBe("ready");
    expect(card.autoStatus).toBeUndefined();
    expect(card.executionNotice).toBe("Connection or approval authority changed");
    expect(app.autoHold(card)).toBeUndefined();
  });

  it("keeps a later hold beside a favourable evaluation, and none for a refusal", () => {
    const { app, card } = harness();
    card.evaluation = evaluation();
    card.autoSent = true;
    card.autoStatus = "Needs review: Execution stopped before SQL ran. Approval authority changed";
    expect(app.autoHold(card)).toEqual({
      sent: true,
      reason: "Execution stopped before SQL ran. Approval authority changed",
    });
    card.autoStatus = "Needs review: Evaluator uncertainty or stale policy/model";
    expect(app.autoHold(card)).toBeUndefined();
  });
});

describe("schema repaint", () => {
  it("repaints the matrix, the legend and the SQL marks from one analysis", () => {
    const { app, card } = harness();
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    const el = () => ({ innerHTML: "" });
    const nodes: Record<string, { innerHTML: string }> = {
      "#cm-req": el(),
      "#cs-req": el(),
      "#sqlbody-req": el(),
    };
    app.root = { querySelector: (sel: string) => nodes[sel] ?? null };
    card.sql = "SELECT email FROM public.users";
    card.schema = {
      tables: ["public.users"],
      pii: ["email"],
      client: [],
      complete: true,
    };
    app.renderCardSchema(card);
    expect(nodes["#cs-req"].innerHTML).toContain('class="lg pii"');
    expect(nodes["#sqlbody-req"].innerHTML).toContain('class="pii-col"');
    // The PII display toggle turned off: neither the legend nor the SQL marks the column.
    card.schema = { ...card.schema, pii: [] };
    app.renderCardSchema(card);
    expect(nodes["#cs-req"].innerHTML).toBe("");
    expect(nodes["#sqlbody-req"].innerHTML).not.toContain("pii-col");
  });
});

describe("the poll's report to the broker", () => {
  const answer = (status = 204) => ({ status, ok: status < 300, headers: { get: () => null } });
  function polling(cards: Partial<Card>[]) {
    const { app, card } = harness();
    app.cards = cards.map((c, i) => ({ ...card, id: `req_${i}`, leaseId: `lease_${i}`, ...c }));
    const pending = vi.fn(async (..._args: unknown[]) => answer());
    const settings = { confirmWrites: true, autoDenyHeavy: false };
    Object.assign(app, {
      polling: true,
      pollFailures: 0,
      broker: { ...app.broker, pending },
      setServerHeader: vi.fn(),
      setConnectionState: vi.fn(),
      settingsStore: { get: () => settings, loadedForConnection: () => true },
    });
    const sent = (call = 0) => pending.mock.calls[call]?.[1];
    return { app, pending, sent, settings };
  }

  it("names what waits for a human, never what Auto mode is evaluating or will evaluate", async () => {
    const { app, sent } = polling([
      { autoAttempt: 1, autoStatus: "Needs review: Sensitive source or alias: email" },
      {},
      { autoAttempt: 1, autoStatus: "Evaluating with Jev" },
      { sql: "DELETE FROM public.products" },
    ]);
    app.autoCard = app.cards[2];
    app.autoAbort = new AbortController();
    await app.poll();
    expect(sent()).toEqual({ auto: true, heavy: false, attention: ["req_0", "req_3"] });
    await app.poll();
    expect(sent(1)).toEqual({ auto: true, heavy: false, attention: [] });
  });

  it("names a card whose evaluation timed out, before its calls settle", async () => {
    const { app, sent } = polling([{ autoAttempt: 1, autoStatus: "Evaluating with Jev" }]);
    app.autoCard = app.cards[0];
    app.autoAbort = new AbortController();
    app.autoAbort.abort();
    await app.poll();
    expect(sent()).toEqual({ auto: true, heavy: false, attention: ["req_0"] });
  });

  it("still names waiting cards with Auto mode off, the moment it was switched off", async () => {
    const { app, sent } = polling([{}, {}]);
    app.autoEnabled = false;
    await app.poll();
    expect(sent()).toEqual({ auto: false, heavy: false, attention: ["req_0", "req_1"] });
  });

  it("names a card again unless the broker answered while it still waited under that lease", async () => {
    const { app, pending, sent } = polling([
      { autoAttempt: 1 },
      { autoAttempt: 1 },
      { autoAttempt: 1 },
    ]);
    pending.mockImplementationOnce(async () => {
      app.cards[0].leaseId = "lease_new";
      app.cards[1].state = "approving";
      return answer();
    });
    await app.poll();
    app.cards[1].state = "ready";
    await app.poll();
    expect(sent(1)).toEqual({ auto: true, heavy: false, attention: ["req_0", "req_1"] });
  });

  it("names a card again after a failed answer", async () => {
    const { app, pending, sent } = polling([{ autoAttempt: 1 }]);
    pending.mockResolvedValueOnce(answer(500));
    await app.poll();
    await app.poll();
    expect(sent(1)).toEqual({ auto: true, heavy: false, attention: ["req_0"] });
  });

  it("names at most 64 cards a poll, the rest on the next", async () => {
    const { app, sent } = polling(Array.from({ length: 70 }, () => ({ autoAttempt: 1 })));
    await app.poll();
    await app.poll();
    expect(sent(0)).toEqual({
      auto: true,
      heavy: false,
      attention: expect.toSatisfy((ids: string[]) => ids.length === 64),
    });
    expect(sent(1)).toEqual({
      auto: true,
      heavy: false,
      attention: expect.toSatisfy((ids: string[]) => ids.length === 6),
    });
  });

  // Auto-deny may still reject a card nobody needs to see: it is named once its check settled.
  it("names a card only after its load check, while heavy queries are auto-denied", async () => {
    const { app, sent, settings } = polling([{ sql: "DELETE FROM public.products" }]);
    app.autoEnabled = false;
    settings.autoDenyHeavy = true;
    await app.poll();
    expect(sent()).toEqual({ auto: false, heavy: true, attention: [] });
    app.cards[0].loadChecked = true;
    await app.poll();
    expect(sent(1)).toEqual({ auto: false, heavy: true, attention: ["req_0"] });
  });

  it("marks the card checked in the tick auto-deny reserves a heavy one", async () => {
    const { app } = polling([{ sql: "SELECT count(*) FROM public.big" }]);
    app.autoEnabled = false;
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    Object.assign(app, { renderCardLoad: vi.fn(), setCardState: vi.fn() });
    app.settingsStore = {
      get: () => ({ confirmWrites: true, autoDenyHeavy: true }),
      loadedForConnection: () => true,
    };
    const card = app.cards[0];
    const settled = deferred<undefined>();
    vi.spyOn(app.annotator, "inspectLoad").mockReturnValue(settled.promise);
    app.startLoad(card, true);
    expect(card.loadChecked).toBeUndefined();
    settled.resolve(undefined);
    await vi.waitFor(() => expect(card.loadChecked).toBe(true));
  });

  it("keeps one call in flight, and a poke during it polls right after", async () => {
    const { app, pending } = polling([{ autoAttempt: 1 }]);
    const reply = deferred<ReturnType<typeof answer>>();
    pending.mockImplementationOnce(() => reply.promise);
    const timer = vi.fn();
    vi.stubGlobal("window", { setTimeout: timer, clearTimeout });
    const first = app.poll();
    await app.poll();
    expect(pending).toHaveBeenCalledOnce();
    reply.resolve(answer());
    await first;
    expect(timer).toHaveBeenCalledOnce();
    expect(timer.mock.calls[0][1]).toBe(0);
  });
});

describe("heavy query repaint", () => {
  const HEAVY: LoadResult = {
    lines: [
      [
        "Reads every row of ",
        { code: "big", ref: "public.big" },
        " without a ",
        { code: "WHERE", kw: true },
        " clause",
      ],
    ],
    notes: [],
    estimates: [{ table: "big", ref: "public.big", rows: 2_000_000 }],
    heavy: true,
    complete: true,
  };
  const schema = { tables: ["public.big"], pii: [], client: [], literals: [], star: true };

  function painted() {
    const { app, card } = harness();
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    const el = () => ({ innerHTML: "" });
    const nodes: Record<string, { innerHTML: string }> = {
      "#hb-req": el(),
      "#cm-req": el(),
      "#cl-req": el(),
      "#cs-req": el(),
      "#sqlbody-req": el(),
    };
    app.root = { querySelector: (sel: string) => nodes[sel] ?? null };
    card.sql = "SELECT * FROM public.big";
    return { app, card, nodes };
  }

  it("keeps the estimate on the table's name whichever of the load and the analysis lands last", () => {
    const loadFirst = painted();
    loadFirst.card.loadResult = HEAVY;
    loadFirst.app.renderCardLoad(loadFirst.card);
    expect(loadFirst.nodes["#hb-req"].innerHTML).toContain("Heavy query");
    expect(loadFirst.nodes["#cm-req"].innerHTML).toContain('data-ref="public.big"');
    expect(loadFirst.nodes["#cl-req"].innerHTML).toContain("cs-heavy");
    loadFirst.card.schema = schema;
    loadFirst.app.renderCardSchema(loadFirst.card);
    expect(loadFirst.nodes["#cm-req"].innerHTML).toContain('data-ref="public.big"');

    const schemaFirst = painted();
    schemaFirst.card.schema = schema;
    schemaFirst.app.renderCardSchema(schemaFirst.card);
    expect(schemaFirst.nodes["#cm-req"].innerHTML).not.toContain("est-tip");
    schemaFirst.card.loadResult = HEAVY;
    schemaFirst.app.renderCardLoad(schemaFirst.card);
    expect(schemaFirst.nodes["#cm-req"].innerHTML).toContain('data-ref="public.big"');
  });

  it("drops the previous result's badge and estimates as soon as a check restarts", () => {
    const { app, card, nodes } = painted();
    app.settingsStore = {
      get: () => ({ confirmWrites: true, autoDenyHeavy: true }),
      loadedForConnection: () => true,
    };
    card.loadResult = HEAVY;
    app.renderCardLoad(card);
    vi.spyOn(app.annotator, "inspectLoad").mockReturnValue(new Promise(() => {}));
    app.startLoad(card, false);
    expect(nodes["#hb-req"].innerHTML).toBe("");
    expect(nodes["#cm-req"].innerHTML).not.toContain("est-tip");
    expect(nodes["#cl-req"].innerHTML).toBe("");
  });
});

describe("heavy query focus", () => {
  // Regions that hold one focusable entry per painted data-ref and record what took focus.
  function regions() {
    const focused: string[] = [];
    const doc = { activeElement: null as unknown };
    type Entry = { getAttribute: (a: string) => string; focus: () => void };
    const region = () => {
      let entries: Entry[] = [];
      return {
        ownerDocument: doc,
        get entries() {
          return entries;
        },
        set innerHTML(html: string) {
          entries = [...html.matchAll(/data-ref="([^"]+)"/g)].map(([, ref]) => ({
            getAttribute: () => ref,
            focus: () => focused.push(ref),
          }));
        },
        contains: (n: unknown) => entries.includes(n as Entry),
        querySelector: (s: string) =>
          entries.find((e) => s === `[data-ref="${e.getAttribute("data-ref")}"]`) ?? null,
      };
    };
    return { doc, focused, matrix: region(), cause: region() };
  }

  it("keeps the focus on the table across a repaint, else hands it to the open row", () => {
    const { app, card } = harness();
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    const r = regions();
    app.root = {
      querySelector: (sel: string) => ({ "#cm-req": r.matrix, "#cl-req": r.cause })[sel] ?? null,
    };
    app.focusSelectedRow = vi.fn();
    card.sql = "SELECT * FROM public.big";
    card.schema = { tables: ["public.big"], pii: [], client: [], literals: [], star: true };
    card.loadResult = {
      lines: [["Reads every row of ", { code: "big", ref: "public.big" }]],
      notes: [],
      estimates: [{ table: "big", ref: "public.big", rows: 2_000_000 }],
      heavy: true,
      complete: true,
    };
    app.renderCardLoad(card);
    r.doc.activeElement = r.matrix.entries[0];
    app.renderCardLoad(card);
    expect(r.focused).toEqual(["public.big"]);
    // A recheck drops the estimate: the focus goes to the open row, never to the page.
    r.doc.activeElement = r.matrix.entries[0];
    card.loadResult = { ...card.loadResult, lines: [], estimates: [], heavy: false };
    app.renderCardLoad(card);
    expect(app.focusSelectedRow).toHaveBeenCalledOnce();
    // Focus elsewhere is left alone.
    r.doc.activeElement = {};
    app.renderCardLoad(card);
    expect(app.focusSelectedRow).toHaveBeenCalledOnce();
  });
});
