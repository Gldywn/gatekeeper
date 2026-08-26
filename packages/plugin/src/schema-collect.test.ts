import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@beekeeperstudio/plugin", () => ({
  getSchemas: vi.fn(),
  getTables: vi.fn(),
  getColumns: vi.fn(),
  getPrimaryKeys: vi.fn(),
  getOutgoingKeys: vi.fn(),
}));

import {
  getColumns,
  getOutgoingKeys,
  getPrimaryKeys,
  getSchemas,
  getTables,
} from "@beekeeperstudio/plugin";
import { collectSchema } from "./schema-collect";

const schemas = vi.mocked(getSchemas);
const tables = vi.mocked(getTables);

beforeEach(() => {
  vi.clearAllMocks();
  schemas.mockResolvedValue(["public"]);
  tables.mockResolvedValue([{ name: "users", schema: "public" }] as never);
  vi.mocked(getColumns).mockResolvedValue([
    { name: "id", type: "int4" },
    { name: "company_id", type: "int4" },
    { name: "email", type: "text" },
  ] as never);
  vi.mocked(getPrimaryKeys).mockResolvedValue([{ columnName: "id", position: 1 }] as never);
  vi.mocked(getOutgoingKeys).mockResolvedValue([
    {
      fromColumn: "company_id",
      toTable: "companies",
      toSchema: "public",
      toColumn: "id",
      isComposite: false,
    },
  ] as never);
});

describe("collectSchema", () => {
  it("maps SDK introspection into a structural payload with PK and FK", async () => {
    const s = await collectSchema("prod", "prodpostgresqlapp", "postgresql");
    expect(s).toMatchObject({
      connectionName: "prod",
      scope: "prodpostgresqlapp",
      access: true,
    });
    expect(s.tables).toHaveLength(1);
    const t = s.tables[0];
    expect(t).toMatchObject({ schema: "public", name: "users" });
    expect(t.columns).toEqual([
      { name: "id", type: "int4", primaryKey: true },
      { name: "company_id", type: "int4", primaryKey: false },
      { name: "email", type: "text", primaryKey: false },
    ]);
    expect(t.foreignKeys).toEqual([
      { column: "company_id", refTable: "public.companies", refColumn: "id" },
    ]);
    expect(s.excludedSchemas).toEqual([]);
  });

  it("skips Postgres catalogs, keeps other user schemas, and never lists their tables", async () => {
    schemas.mockResolvedValue([
      "public",
      "information_schema",
      "pg_catalog",
      "pg_toast",
      "topology",
    ]);
    tables.mockImplementation((async (schema?: string) => [
      { name: "users", schema: schema ?? "public" },
    ]) as never);

    const s = await collectSchema("prod", "scope", "postgresql");

    expect(s.excludedSchemas).toEqual(["information_schema", "pg_catalog", "pg_toast"]);
    expect(s.tables.map((t) => t.schema)).toEqual(["public", "topology"]);
    expect(tables.mock.calls.map(([schema]) => schema)).toEqual(["public", "topology"]);
  });

  it("skips the MySQL catalogs", async () => {
    schemas.mockResolvedValue([
      "gatekeeper_test",
      "information_schema",
      "mysql",
      "performance_schema",
      "sys",
    ]);
    tables.mockImplementation((async (schema?: string) => [
      { name: "orders", schema: schema ?? "" },
    ]) as never);

    const s = await collectSchema("prod", "scope", "mysql");

    expect(s.excludedSchemas).toEqual(["information_schema", "mysql", "performance_schema", "sys"]);
    expect(s.tables.map((t) => t.schema)).toEqual(["gatekeeper_test"]);
  });

  it("keeps a pg_-named schema on an engine that does not reserve the prefix", async () => {
    schemas.mockResolvedValue(["pg_backup", "information_schema"]);
    tables.mockImplementation((async (schema?: string) => [
      { name: "snapshots", schema: schema ?? "" },
    ]) as never);

    const s = await collectSchema("prod", "scope", "bigquery");

    expect(s.excludedSchemas).toEqual(["information_schema"]);
    expect(s.tables.map((t) => t.schema)).toEqual(["pg_backup"]);
  });

  it("drops SQLite internal tables, which live under no schema at all", async () => {
    schemas.mockResolvedValue([]);
    tables.mockResolvedValue([
      { name: "sqlite_sequence" },
      { name: "sqlite_stat1" },
      { name: "orders" },
    ] as never);

    const s = await collectSchema("prod", "scope", "sqlite");

    expect(s.excludedSchemas).toEqual([]);
    expect(s.tables.map((t) => t.name)).toEqual(["orders"]);
  });

  it("still filters catalog tables when every schema is a catalog", async () => {
    schemas.mockResolvedValue(["information_schema", "pg_catalog"]);
    tables.mockResolvedValue([
      { name: "pg_class", schema: "pg_catalog" },
      { name: "columns", schema: "information_schema" },
      { name: "leftovers", schema: "public" },
    ] as never);

    const s = await collectSchema("prod", "scope", "postgresql");

    expect(s.tables.map((t) => t.name)).toEqual(["leftovers"]);
  });
});
