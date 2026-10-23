import type { Column } from "@beekeeperstudio/plugin";
import { describe, expect, it, vi } from "vitest";
import { SchemaAnnotator } from "./annotate";

function columns(...names: string[]): Column[] {
  return names.map((name) => ({ name, type: "text" }));
}

describe("SchemaAnnotator.schemaFor", () => {
  it("exposes incomplete analysis instead of treating failed metadata as clean", async () => {
    const annotator = new SchemaAnnotator({
      getColumns: async () => columns("quantity"),
      getMetadata: async () => {
        throw new Error("private database detail");
      },
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });
    const sql = "SELECT quantity FROM public.products WHERE quantity > 0";
    expect((await annotator.schemaFor(sql))?.analysis).toEqual({
      complete: false,
      reasons: ["Metadata query failed"],
    });
    expect(await annotator.inspectRead(sql)).toEqual({
      complete: false,
      reasons: ["Metadata query failed"],
    });
  });
  it.each(["mysql", "sqlserver", "sqlite"])(
    "never sends PostgreSQL catalog SQL on a %s connection",
    async (dialect) => {
      const getMetadata = vi.fn(async () => []);
      const annotator = new SchemaAnnotator({
        getColumns: async () => columns("quantity"),
        getMetadata,
        dialect: () => dialect,
        defaultSchema: () => "public",
        generation: () => 0,
      });
      expect(await annotator.inspectRead("SELECT quantity FROM public.products")).toEqual({
        complete: false,
        reasons: ["Auto mode beta supports PostgreSQL only"],
      });
      await annotator.schemaFor("SELECT quantity FROM public.products");
      expect(getMetadata).not.toHaveBeenCalled();
    },
  );
  it("checks the search path before running the catalog query", async () => {
    const getMetadata = vi.fn(async () => [{ path: '["public","pg_catalog"]' }]);
    const annotator = new SchemaAnnotator({
      getColumns: async () => [],
      getMetadata,
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });
    expect(await annotator.inspectRead("SELECT quantity FROM public.products")).toEqual({
      complete: false,
      reasons: ["PostgreSQL catalog must come first in the search path"],
    });
    expect(getMetadata).toHaveBeenCalledOnce();
  });
  it("does not blame the host for catalog SQL it could not build", async () => {
    const getMetadata = vi.fn(async () => [{ path: '["pg_catalog","public"]' }]);
    const annotator = new SchemaAnnotator({
      getColumns: async () => [],
      getMetadata,
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });
    // A function name over PostgreSQL's 63-byte limit plans, then fails as a catalog literal.
    const sql = `SELECT ${"f".repeat(64)}(quantity) FROM public.products`;
    expect(await annotator.inspectRead(sql)).toEqual({
      complete: false,
      reasons: ["Metadata unavailable"],
    });
    expect(getMetadata).toHaveBeenCalledOnce();
  });
  it("discards a snapshot when catalog identity changes while a table is loading", async () => {
    let resolve!: (rows: Record<string, unknown>[]) => void;
    const annotator = new SchemaAnnotator({
      getColumns: async () => [],
      getMetadata: () =>
        new Promise((r) => {
          resolve = r;
        }),
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });
    const pending = annotator.inspectRead("SELECT quantity FROM public.products");
    annotator.clearCache();
    resolve([]);
    expect(await pending).toBeUndefined();
  });
  it("returns the tables and PII/client/literal annotation for a query", async () => {
    const getColumns = vi.fn(async () => columns("id", "email", "company_name", "status"));
    const annotator = new SchemaAnnotator({
      getColumns,
      dialect: () => "postgresql",
      defaultSchema: () => undefined,
      generation: () => 0,
    });

    const schema = await annotator.schemaFor("SELECT * FROM customers WHERE company_name = 'ACME'");

    expect(schema).not.toBeNull();
    expect(schema?.tables).toEqual(["customers"]);
    expect(schema?.pii).toEqual(["email"]);
    expect(schema?.client).toEqual(["company_name"]);
    expect(schema?.literals).toEqual(["ACME"]);
    expect(schema?.star).toBe(true);
  });

  it("flags aliased name columns across a cross-schema join", async () => {
    // Each table lives in its own schema; the two "name" columns are only sensitive
    // under the output names the query gives them (customer_name, company_name).
    const getColumns = vi.fn(async (table: string) =>
      table === "wallet_holders"
        ? columns("id", "holder_kind", "holder_ref")
        : columns("id", "name", "status", "updatedAt"),
    );
    const annotator = new SchemaAnnotator({
      getColumns,
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });

    const schema = await annotator.schemaFor(
      `SELECT w.id AS wallet_id, w.name AS customer_name, w.status, w."updatedAt" wallet_updated_at,
              h.holder_kind, g.id AS company_id, g.name AS company_name
         FROM ledger.wallets w
         JOIN ledger.wallet_holders h ON h.id = w.holder_id
         LEFT JOIN directory.organizations g ON g.id::text = h.holder_ref AND h.holder_kind = 'ORG'
        WHERE w.status <> 'ACTIVE'
        ORDER BY w.status, w."updatedAt"`,
    );

    expect(schema?.tables).toEqual([
      "ledger.wallets",
      "ledger.wallet_holders",
      "directory.organizations",
    ]);
    expect(getColumns.mock.calls).toEqual([
      ["wallets", "ledger"],
      ["wallet_holders", "ledger"],
      ["organizations", "directory"],
    ]);
    expect(schema?.client).toEqual(["customer_name", "company_name"]);
    expect(schema?.pii).toEqual([]);
    expect(schema?.literals).toEqual([]);
    expect(schema?.star).toBe(false);
  });

  it("flags the keys read out of a JSON column, and a literal bound to one", async () => {
    // The stored document is opaque to the schema: only the accessor keys say what
    // the query actually reads out of it.
    const getColumns = vi.fn(async () => columns("id", "profile"));
    const annotator = new SchemaAnnotator({
      getColumns,
      dialect: () => "postgresql",
      defaultSchema: () => undefined,
      generation: () => 0,
    });

    const schema = await annotator.schemaFor(
      "SELECT profile->>'email' FROM crm.people WHERE profile->>'company_name' = 'ACME'",
    );

    expect(schema?.tables).toEqual(["crm.people"]);
    expect(schema?.pii).toEqual(["email"]);
    expect(schema?.client).toEqual(["company_name"]);
    expect(schema?.literals).toEqual(["ACME"]);
    expect(schema?.star).toBe(false);
  });

  it("annotates the value a write assigns to a sensitive column", async () => {
    // Writes reach the card too (once write mode is armed), and the value they carry
    // sits in the statement itself, not in a WHERE comparison.
    const getColumns = vi.fn(async () => columns("id", "company_name", "status"));
    const annotator = new SchemaAnnotator({
      getColumns,
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });

    const schema = await annotator.schemaFor(
      "UPDATE billing.firms SET company_name = 'ACME' WHERE id = 1",
    );

    expect(schema?.tables).toEqual(["billing.firms"]);
    expect(schema?.client).toEqual(["company_name"]);
    expect(schema?.literals).toEqual(["ACME"]);
    expect(schema?.star).toBe(false);
  });

  it("flags the value of a filter that wraps its sensitive column", async () => {
    const getColumns = vi.fn(async () => columns("id", "company_name", "status"));
    const annotator = new SchemaAnnotator({
      getColumns,
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });

    const schema = await annotator.schemaFor(
      "SELECT id FROM billing.firms WHERE lower(company_name) = 'acme'",
    );

    expect(schema?.client).toEqual(["company_name"]);
    expect(schema?.literals).toEqual(["acme"]);
  });

  it("flags a sensitive output name a RETURNING clause introduces", async () => {
    // No table column is sensitive on its own: the write only exposes the value under
    // the output name it assigns in RETURNING.
    const getColumns = vi.fn(async () => columns("id", "name", "status"));
    const annotator = new SchemaAnnotator({
      getColumns,
      dialect: () => "postgresql",
      defaultSchema: () => undefined,
      generation: () => 0,
    });

    const schema = await annotator.schemaFor(
      "UPDATE billing.firms SET status = 'closed' RETURNING name AS contact_email",
    );

    expect(schema?.tables).toEqual(["billing.firms"]);
    expect(schema?.pii).toEqual(["contact_email"]);
    expect(schema?.client).toEqual([]);
    expect(schema?.star).toBe(false);
  });

  it("flags a sensitive output name a derived table's column list introduces", async () => {
    const getColumns = vi.fn(async () => columns("id", "name", "status"));
    const annotator = new SchemaAnnotator({
      getColumns,
      dialect: () => "postgresql",
      defaultSchema: () => undefined,
      generation: () => 0,
    });

    const schema = await annotator.schemaFor(
      "SELECT * FROM (SELECT name FROM billing.firms) f(company_name)",
    );

    expect(schema?.tables).toEqual(["billing.firms"]);
    expect(schema?.client).toEqual(["company_name"]);
    expect(schema?.pii).toEqual([]);
    // The outer * expands the mocked columns too, so the flag can only come from the alias.
    expect(schema?.star).toBe(true);
  });

  it("returns null when the SQL will not parse", async () => {
    const getColumns = vi.fn(async () => columns());
    const annotator = new SchemaAnnotator({
      getColumns,
      dialect: () => "postgresql",
      defaultSchema: () => undefined,
      generation: () => 0,
    });

    expect(await annotator.schemaFor("this is not a query at all !@#")).toBeNull();
    expect(getColumns).not.toHaveBeenCalled();
  });

  it("returns undefined when the generation changes during the awaited column fetch", async () => {
    let generation = 0;
    // The connection switch lands while the column fetch is in flight, exactly the
    // race the guard exists to catch: the columns now belong to a different database.
    const getColumns = vi.fn(async () => {
      generation++;
      return columns("id", "email");
    });
    const annotator = new SchemaAnnotator({
      getColumns,
      dialect: () => "postgresql",
      defaultSchema: () => undefined,
      generation: () => generation,
    });

    expect(await annotator.schemaFor("SELECT id, email FROM users")).toBeUndefined();
    expect(getColumns).toHaveBeenCalledTimes(1);
  });

  it("caches columns per table until clearCache drops them", async () => {
    const getColumns = vi.fn(async () => columns("id", "email"));
    const annotator = new SchemaAnnotator({
      getColumns,
      dialect: () => "postgresql",
      defaultSchema: () => undefined,
      generation: () => 0,
    });

    await annotator.schemaFor("SELECT id, email FROM users");
    await annotator.schemaFor("SELECT id, email FROM users");
    expect(getColumns).toHaveBeenCalledTimes(1);

    annotator.clearCache();
    await annotator.schemaFor("SELECT id, email FROM users");
    expect(getColumns).toHaveBeenCalledTimes(2);
  });
});

describe("SchemaAnnotator.inspectLoad", () => {
  const PATH = [{ path: '["pg_catalog","public"]' }];
  const stats = (rows: number) => [
    {
      i: 0,
      schema: "public",
      kind: "r",
      rls: false,
      deeper: false,
      parts: JSON.stringify([["r", rows, 0]]),
    },
  ];
  const text = (line: (string | { code: string })[]) =>
    line.map((s) => (typeof s === "string" ? s : s.code)).join("");

  function annotator(metadata: Record<string, unknown>[][], getIndexes = vi.fn(async () => [])) {
    const getMetadata = vi.fn(async () => metadata.shift() ?? []);
    const a = new SchemaAnnotator({
      getColumns: async () => columns("id", "failure_code"),
      getMetadata,
      getIndexes,
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });
    return { a, getMetadata, getIndexes };
  }

  it("checks the search path before reading statistics, and reads indexes for large tables only", async () => {
    const getIndexes = vi.fn(async () => [
      {
        id: "1",
        table: "t",
        schema: "public",
        name: "t_pkey",
        columns: [{ name: "id" }],
        unique: true,
        primary: true,
      },
    ]);
    const { a, getMetadata } = annotator([PATH, stats(2_000_000)], getIndexes);
    const result = await a.inspectLoad("SELECT id FROM public.t WHERE failure_code = 'x'");
    expect(getMetadata.mock.calls[0][0]).toContain("current_schemas");
    expect(getMetadata.mock.calls[1][0]).toContain("pg_catalog.pg_inherits");
    expect(getIndexes).toHaveBeenCalledWith("t", "public");
    expect(result?.lines.map(text)).toEqual([
      "Filter on failure_code uses no index and may scan all of t",
    ]);

    const small = annotator([PATH, stats(10)]);
    expect(
      (await small.a.inspectLoad("SELECT id FROM public.t WHERE failure_code = 'x'"))?.heavy,
    ).toBe(false);
    expect(small.getIndexes).not.toHaveBeenCalled();
  });

  it("reads a composite unique index as a key a join can match in full", async () => {
    const getIndexes = vi.fn(async () => [
      {
        id: "1",
        table: "users",
        schema: "public",
        name: "users_pkey",
        columns: [{ name: "tenant_id" }, { name: "id" }],
        unique: true,
        primary: true,
      },
    ]);
    const two = [
      { ...stats(50_000)[0], i: 0 },
      { ...stats(40_000_000)[0], i: 1 },
    ];
    const join =
      "SELECT c.name FROM public.customers c JOIN public.users u ON u.tenant_id = c.tenant_id";
    const key = await annotator([PATH, two], getIndexes).a.inspectLoad(
      `${join} AND u.id = c.user_id`,
    );
    expect(key?.lines).toEqual([]);
    const part = await annotator([PATH, two], getIndexes).a.inspectLoad(join);
    expect(part?.lines.map(text)).toEqual([
      "Reads every row of users since no condition filters it",
    ]);
  });

  it("reports statistics as unavailable when the search path is not trusted or the read fails", async () => {
    const untrusted = annotator([[{ path: '["public","pg_catalog"]' }]]);
    const r = await untrusted.a.inspectLoad("SELECT id FROM public.t");
    expect(r?.notes.map(text)).toEqual(["Statistics are unavailable on this connection"]);
    expect(untrusted.getMetadata).toHaveBeenCalledOnce();
    const failing = new SchemaAnnotator({
      getColumns: async () => [],
      getMetadata: async () => {
        throw new Error("private database detail");
      },
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });
    expect((await failing.inspectLoad("DELETE FROM public.t"))?.lines.map(text)).toEqual([
      "DELETE without WHERE removes every row of t",
    ]);
  });

  it("drops an answer that a connection switch made stale", async () => {
    let generation = 0;
    const a = new SchemaAnnotator({
      getColumns: async () => [],
      getMetadata: async () => {
        generation++;
        return PATH;
      },
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => generation,
    });
    expect(await a.inspectLoad("SELECT id FROM public.t")).toBeUndefined();
  });

  it("never sends catalog SQL outside PostgreSQL", async () => {
    const getMetadata = vi.fn(async () => []);
    const a = new SchemaAnnotator({
      getColumns: async () => [],
      getMetadata,
      dialect: () => "mysql",
      defaultSchema: () => "app",
      generation: () => 0,
    });
    expect((await a.inspectLoad("DELETE FROM sessions"))?.heavy).toBe(true);
    expect(getMetadata).not.toHaveBeenCalled();
  });
});

describe("SchemaAnnotator.inspectLoad host work", () => {
  const PATH = [{ path: '["pg_catalog","public"]' }];

  it("starts no host call for a statement over the relation budget", async () => {
    const getMetadata = vi.fn(async () => []);
    const getColumns = vi.fn(async () => []);
    const a = new SchemaAnnotator({
      getColumns,
      getMetadata,
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });
    const tables = Array.from({ length: 17 }, (_, i) => `public.t${i}`).join(", ");
    const r = await a.inspectLoad(`SELECT 1 FROM ${tables}`);
    expect(getMetadata).not.toHaveBeenCalled();
    expect(getColumns).not.toHaveBeenCalled();
    expect(r?.complete).toBe(false);
  });

  it("sends nothing more once the caller withdraws authority", async () => {
    let allowed = true;
    const getMetadata = vi.fn(async () => {
      allowed = false;
      return PATH;
    });
    const a = new SchemaAnnotator({
      getColumns: async () => [],
      getMetadata,
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });
    expect(await a.inspectLoad("SELECT id FROM public.t", () => allowed)).toBeUndefined();
    expect(getMetadata).toHaveBeenCalledOnce();
  });

  it("does not ask the new connection for columns after a switch during the index call", async () => {
    let generation = 0;
    const getColumns = vi.fn(async () => []);
    const metadata = [
      PATH,
      [
        {
          i: 0,
          schema: "public",
          kind: "r",
          rls: false,
          deeper: false,
          parts: '[["r",2000000,0]]',
        },
      ],
    ];
    const a = new SchemaAnnotator({
      getColumns,
      getMetadata: async () => metadata.shift() ?? [],
      getIndexes: async () => {
        generation++;
        return [];
      },
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => generation,
    });
    expect(await a.inspectLoad("SELECT id FROM public.t WHERE x = 1")).toBeUndefined();
    expect(getColumns).not.toHaveBeenCalled();
  });
});

describe("SchemaAnnotator.inspectLoad on never analyzed tables", () => {
  it("reads an empty table autovacuum never analyzed as empty, not unknown", async () => {
    const metadata = [
      [{ path: '["pg_catalog","public"]' }],
      [
        {
          i: 0,
          schema: "treasury",
          kind: "r",
          rls: false,
          deeper: false,
          track_counts: "on",
          parts: '[["r",-1,0]]',
        },
      ],
    ];
    const a = new SchemaAnnotator({
      getColumns: async () => [],
      getMetadata: async () => metadata.shift() ?? [],
      dialect: () => "postgresql",
      defaultSchema: () => "public",
      generation: () => 0,
    });
    const r = await a.inspectLoad("SELECT count(*) FROM treasury.mangopay_to_swan_migration");
    expect(r).toMatchObject({ lines: [], notes: [], heavy: false, complete: true });
  });
});
