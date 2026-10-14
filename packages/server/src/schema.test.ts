import { describe, expect, it } from "vitest";
import { type ConnectionSnapshot, connectionScopeKey } from "./connection.js";
import { schemaPayload } from "./mcp.js";
import { type SchemaSnapshot, sanitizeSchema } from "./schema.js";
import { RequestStore } from "./store.js";

const conn = (name: string): ConnectionSnapshot => ({
  connectionName: name,
  databaseType: "postgresql",
  databaseName: name,
  schema: "public",
  readOnly: false,
  mode: "read",
  capturedAt: 1,
});

describe("sanitizeSchema", () => {
  it("keeps a structural skeleton and coerces loose fields", () => {
    const snap = sanitizeSchema(
      {
        connectionName: "prod",
        access: true,
        tables: [
          {
            schema: "public",
            name: "users",
            columns: [
              { name: "id", type: "int4", primaryKey: true },
              { name: "email", type: "text" },
            ],
            foreignKeys: [{ column: "company_id", refTable: "public.companies", refColumn: "id" }],
          },
        ],
      },
      42,
    );
    expect(snap.access).toBe(true);
    expect(snap.capturedAt).toBe(42);
    expect(snap.tables[0].columns).toEqual([
      { name: "id", type: "int4", primaryKey: true },
      { name: "email", type: "text", primaryKey: false },
    ]);
    expect(snap.tables[0].foreignKeys[0].refTable).toBe("public.companies");
  });

  it("carries the excluded catalog names and drops the empty ones", () => {
    const snap = sanitizeSchema(
      {
        connectionName: "prod",
        access: true,
        tables: [],
        excludedSchemas: ["information_schema", "", "pg_catalog", 7],
      },
      1,
    );
    expect(snap.excludedSchemas).toEqual(["information_schema", "pg_catalog"]);
  });

  it("empties the tables when access is off", () => {
    const snap = sanitizeSchema(
      { connectionName: "prod", access: false, tables: [{ name: "users", columns: [] }] },
      1,
    );
    expect(snap.access).toBe(false);
    expect(snap.tables).toEqual([]);
  });

  it("survives a malformed payload", () => {
    const snap = sanitizeSchema({ access: true, tables: "nope" as unknown }, 1);
    expect(snap.connectionName).toBe("");
    expect(snap.tables).toEqual([]);
  });

  it("stamps the collection time and reads an older plugin's silence as unknown", () => {
    const snap = sanitizeSchema({ connectionName: "prod", access: true, tables: [] }, 7);
    expect(snap.collectedAt).toBe(7);
    expect(snap.complete).toBeNull();
    expect(sanitizeSchema({ access: true, tables: [], complete: true }, 7).complete).toBe(true);
  });

  it("marks a table the plugin could not read or a cap cut, and the snapshot with it", () => {
    const wide = Array.from({ length: 1001 }, (_, i) => ({ name: `c${i}`, type: "int4" }));
    const snap = sanitizeSchema(
      {
        access: true,
        complete: true,
        tables: [
          { schema: "public", name: "unread", columns: [], incomplete: true },
          { schema: "public", name: "wide", columns: wide },
          { schema: "public", name: "ok", columns: [{ name: "id", type: "int4" }] },
        ],
      },
      1,
    );
    expect(snap.tables.map((t) => t.incomplete)).toEqual([true, true, undefined]);
    expect(snap.tables[1].columns).toHaveLength(1000);
    expect(snap.complete).toBe(false);
  });

  it("reports a snapshot cut at the table cap as incomplete", () => {
    const tables = Array.from({ length: 5001 }, (_, i) => ({ name: `t${i}`, columns: [] }));
    expect(sanitizeSchema({ access: true, complete: true, tables }, 1).complete).toBe(false);
  });

  it("marks a table whose key list a cap cut, or whose name or type a length cap clipped", () => {
    const fks = Array.from({ length: 1001 }, () => ({
      column: "a",
      refTable: "b",
      refColumn: "c",
    }));
    const long = "x".repeat(513);
    const snap = sanitizeSchema(
      {
        access: true,
        complete: true,
        tables: [
          { name: "keys", columns: [], foreignKeys: fks },
          { name: "typed", columns: [{ name: "status", type: `enum(${long})` }] },
          { name: long, columns: [] },
          { schema: long, name: "ok", columns: [] },
        ],
      },
      1,
    );
    expect(snap.tables.map((t) => t.incomplete)).toEqual([true, true, true, true]);
    expect(snap.complete).toBe(false);
  });
});

describe("schema freshness in the store", () => {
  it("keeps the collection time while the plugin heartbeat bumps liveness", () => {
    const clock = { t: 1000 };
    const store = new RequestStore({ now: () => clock.t });
    store.setSchema({ connectionName: "prod", scope: "s", access: true, tables: [] });
    clock.t = 61_000;
    store.touchSchema();
    expect(store.getSchema()).toMatchObject({ capturedAt: 61_000, collectedAt: 1000 });
    store.close();
  });
});

describe("schemaPayload", () => {
  const snap: SchemaSnapshot = {
    connectionName: "prod",
    scope: connectionScopeKey(conn("prod")),
    access: true,
    tables: [{ schema: "public", name: "users", columns: [], foreignKeys: [] }],
    excludedSchemas: ["information_schema", "pg_catalog"],
    capturedAt: 5,
  };

  const fresh = snap.capturedAt + 1;

  it("refuses a schema with no scope (a forged or empty-scope post)", () => {
    expect(schemaPayload({ ...snap, scope: "" }, conn("prod"), fresh)).toMatchObject({
      available: false,
    });
  });

  it("reports unavailable when nothing is stored", () => {
    expect(schemaPayload(null, conn("prod"), fresh)).toMatchObject({ available: false });
  });

  it("reports unavailable when access is off", () => {
    expect(
      schemaPayload({ ...snap, access: false, tables: [] }, conn("prod"), fresh),
    ).toMatchObject({ available: false });
  });

  it("refuses a schema captured for a different connection (stale after a switch)", () => {
    expect(schemaPayload(snap, conn("staging"), fresh)).toMatchObject({ available: false });
  });

  it("refuses a schema that has gone past its TTL (plugin closed / not refreshing)", () => {
    expect(schemaPayload(snap, conn("prod"), snap.capturedAt + 10 * 60_000)).toMatchObject({
      available: false,
    });
  });

  it("serves the structure for the matching, fresh connection", () => {
    expect(schemaPayload(snap, conn("prod"), fresh)).toMatchObject({
      available: true,
      mode: "detail",
      connectionName: "prod",
      databaseType: "postgresql",
      defaultSchema: "public",
      tableCount: 1,
      excludedSchemas: ["information_schema", "pg_catalog"],
    });
  });

  // An older plugin posts no such field; the agent must still get an array to read.
  it("serves an empty exclusion list for a snapshot that predates the field", () => {
    const legacy = { ...snap } as SchemaSnapshot & { excludedSchemas?: string[] };
    legacy.excludedSchemas = undefined;
    expect(schemaPayload(legacy as SchemaSnapshot, conn("prod"), fresh)).toMatchObject({
      excludedSchemas: [],
    });
  });

  it("reports unknown age and completeness for a snapshot from an older server or plugin", () => {
    expect(schemaPayload(snap, conn("prod"), fresh)).toMatchObject({
      collectedAt: null,
      complete: null,
    });
  });

  type Served = {
    mode: string;
    matched: number;
    returned: number;
    hint?: string;
    tables: { schema: string | null; name: string; columnCount?: number; incomplete?: true }[];
  };
  const table = (schema: string, name: string, columns = 1) => ({
    schema,
    name,
    columns: Array.from({ length: columns }, (_, i) => ({
      name: `column_${i}`,
      type: "character varying",
      primaryKey: false,
    })),
    foreignKeys: [],
  });
  const many: SchemaSnapshot = {
    ...snap,
    complete: true,
    tables: [table("public", "users"), table("audit", "users"), table("public", "orders")],
  };
  const big: SchemaSnapshot = {
    ...snap,
    complete: true,
    tables: Array.from({ length: 200 }, (_, i) => table("public", `table_${i}`, 20)),
  };
  const served = (s: SchemaSnapshot, filter?: Parameters<typeof schemaPayload>[3]) =>
    schemaPayload(s, conn("prod"), fresh, filter) as Served;
  const names = (res: Served) => res.tables.map((t) => `${t.schema}.${t.name}`);

  it("answers unavailable before any filter when access is off or the scope moved", () => {
    const unavailable = { available: false, reason: expect.any(String) };
    expect(
      schemaPayload({ ...many, access: false }, conn("prod"), fresh, { tables: ["users"] }),
    ).toEqual(unavailable);
    expect(schemaPayload(many, conn("staging"), fresh, { tables: ["users"] })).toEqual(unavailable);
  });

  it("matches table names exactly, across schemas unless one is given", () => {
    expect(names(served(many, { tables: ["users"] }))).toEqual(["public.users", "audit.users"]);
    expect(names(served(many, { schema: "audit", tables: ["users"] }))).toEqual(["audit.users"]);
    expect(names(served(many, { schema: "audit" }))).toEqual(["audit.users"]);
    expect(served(many, { tables: ["Users"] })).toMatchObject({ matched: 0, returned: 0 });
  });

  it("counts requested names it cannot find, hedged when the snapshot may be incomplete", () => {
    expect(served(many, { tables: ["users", "ghost"] }).hint).toContain(
      "1 requested table name(s) match no table in this snapshot.",
    );
    expect(served({ ...many, complete: null }, { tables: ["ghost"] }).hint).toContain(
      "may be incomplete",
    );
    expect(served(many, { tables: ["public.users"] }).hint).toContain("unqualified");
  });

  it("switches to an index of names and column counts when the whole schema does not fit", () => {
    const flagged = {
      ...big,
      tables: [{ ...big.tables[0], incomplete: true as const }, ...big.tables.slice(1)],
    };
    const res = served(flagged);
    expect(res).toMatchObject({ mode: "index", matched: 200, returned: 200 });
    expect(res.tables[0]).toEqual({
      schema: "public",
      name: "table_0",
      columnCount: 20,
      incomplete: true,
    });
    expect(res.hint).toContain("Call get_schema with tables");
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(40_000);
  });

  it("cuts an index that is itself too large on whole entries, and says so", () => {
    const huge = {
      ...big,
      tables: Array.from({ length: 3000 }, (_, i) => table("public", `a_long_table_name_${i}`)),
    };
    const res = served(huge);
    expect(res.mode).toBe("index");
    expect(res.returned).toBeGreaterThan(0);
    expect(res.returned).toBeLessThan(3000);
    expect(res.hint).toContain(`Only ${res.returned} of 3000 tables are listed`);
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(40_000);
  });

  it("returns requested tables in detail up to the budget and counts the rest", () => {
    const res = served(big, { tables: big.tables.slice(0, 100).map((t) => t.name) });
    expect(res.mode).toBe("detail");
    expect(res.returned).toBeGreaterThan(0);
    expect(res.returned).toBeLessThan(100);
    expect(res.hint).toContain(`${100 - res.returned} matched table(s) did not fit`);
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(40_000);
  });

  it("reports a table too wide for one response instead of truncating its columns", () => {
    const wide = { ...snap, complete: true, tables: [table("public", "events", 1000)] };
    const res = served(wide, { tables: ["events"] });
    expect(res).toMatchObject({ mode: "detail", matched: 1, returned: 0, tables: [] });
    expect(res.hint).toContain("too large for get_schema");
  });

  it("refuses rather than overflow when the metadata alone is too large", () => {
    const catalogs = Array.from({ length: 100 }, (_, i) => `"${i}`.padEnd(512, "\\"));
    const bloated = sanitizeSchema(
      {
        connectionName: "prod",
        scope: connectionScopeKey(conn("prod")),
        access: true,
        tables: [],
        excludedSchemas: catalogs,
      },
      snap.capturedAt,
    );
    const unavailable = { available: false, reason: expect.stringContaining("too large") };
    expect(schemaPayload(bloated, conn("prod"), fresh)).toEqual(unavailable);
    const wideDefault = { ...conn("prod"), schema: "s".repeat(40_001) };
    expect(schemaPayload(many, wideDefault, fresh)).toEqual(unavailable);
  });

  it("keeps smaller requested tables when an earlier one does not fit", () => {
    const mixed = {
      ...snap,
      complete: true,
      tables: [table("public", "events", 1000), table("public", "users")],
    };
    const res = served(mixed, { tables: ["events", "users"] });
    expect(names(res)).toEqual(["public.users"]);
    expect(res.hint).toContain("1 matched table(s) did not fit");
  });

  it("counts a name found only outside the requested schema as missing, once", () => {
    const res = served(many, { schema: "audit", tables: ["orders", "orders"] });
    expect(res).toMatchObject({ matched: 0, returned: 0 });
    expect(res.hint).toContain(
      "1 requested table name(s) match no table in the requested schema in this snapshot.",
    );
  });

  it("says so when the requested schema matches nothing, instead of an empty silent answer", () => {
    const res = served(many, { schema: "Public" });
    expect(res).toMatchObject({ matched: 0, returned: 0 });
    expect(res.hint).toContain("The requested schema matches no schema in this snapshot.");
  });

  it("points at the schema filter when one name matches in more schemas than fit", () => {
    const tenants = {
      ...snap,
      complete: true,
      tables: Array.from({ length: 300 }, (_, i) => table(`tenant_${i}`, "users", 20)),
    };
    const res = served(tenants, { tables: ["users"] });
    expect(res.returned).toBeLessThan(300);
    expect(res.hint).toContain("narrow with schema when one name matches in several schemas");
  });
});
