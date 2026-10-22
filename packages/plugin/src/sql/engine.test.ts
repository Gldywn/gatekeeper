import { describe, expect, it } from "vitest";
import { engineFor } from "./engine";

describe("engineFor", () => {
  it("reads SQL Server with node-sql-parser's transactsql grammar", () => {
    expect(engineFor("sqlserver").dialect).toBe("transactsql");
  });

  it("reads engines with a grammar of their own with it", () => {
    for (const type of ["mysql", "mariadb", "sqlite", "bigquery", "snowflake"]) {
      expect(engineFor(type).dialect, type).toBe(type);
    }
  });

  it("reads engines without a grammar of their own with the PostgreSQL one", () => {
    for (const type of ["redshift", "duckdb", "oracle", "cockroach", ""]) {
      expect(engineFor(type).dialect, type).toBe("postgresql");
    }
  });
});
