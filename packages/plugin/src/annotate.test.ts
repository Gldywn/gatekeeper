import type { Column } from "@beekeeperstudio/plugin";
import { describe, expect, it, vi } from "vitest";
import { SchemaAnnotator } from "./annotate";

function columns(...names: string[]): Column[] {
  return names.map((name) => ({ name, type: "text" }));
}

describe("SchemaAnnotator.schemaFor", () => {
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
