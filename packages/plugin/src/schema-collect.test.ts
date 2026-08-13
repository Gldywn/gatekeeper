import { describe, expect, it, vi } from "vitest";

vi.mock("@beekeeperstudio/plugin", () => ({
  getSchemas: vi.fn(async () => ["public"]),
  getTables: vi.fn(async () => [{ name: "users", schema: "public" }]),
  getColumns: vi.fn(async () => [
    { name: "id", type: "int4" },
    { name: "company_id", type: "int4" },
    { name: "email", type: "text" },
  ]),
  getPrimaryKeys: vi.fn(async () => [{ columnName: "id", position: 1 }]),
  getOutgoingKeys: vi.fn(async () => [
    {
      fromColumn: "company_id",
      toTable: "companies",
      toSchema: "public",
      toColumn: "id",
      isComposite: false,
    },
  ]),
}));

import { collectSchema } from "./schema-collect";

describe("collectSchema", () => {
  it("maps SDK introspection into a structural payload with PK and FK", async () => {
    const s = await collectSchema("prod", "prodpostgresqlapp");
    expect(s).toMatchObject({
      connectionName: "prod",
      scope: "prodpostgresqlapp",
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
  });
});
