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

  // SECURITY: where node-sql-parser's tree is not the statement the engine runs, the card's
  // flags, the load check and Auto mode get nothing from it either.
  it("answers nothing from a tree that is not the statement the engine runs", () => {
    for (const [type, sql] of [
      ["mysql", "SELECT a /*! , email */ FROM t"],
      ["mariadb", "SELECT a /*M! , email */ FROM t"],
      ["sqlite", "-- x\rSELECT email FROM t"],
      ["redshift", "-- x\rSELECT email FROM t"],
      ["mysql", "SELECT 1--1, email FROM t"],
      ["sqlserver", "SELECT email FROM t SHUTDOWN"],
      ["sqlserver", "SELECT email FROM t u x"],
    ]) {
      const engine = engineFor(type);
      expect(engine.analyze(sql), sql).toBeNull();
      expect(engine.output(sql), sql).toBeNull();
      expect(engine.tableOps(sql), sql).toBeNull();
      expect(engine.receipt(sql), sql).toBeNull();
      expect(engine.sensitiveLiterals(sql), sql).toEqual([]);
      expect(engine.load(sql).covered, sql).toBe(false);
    }
  });
});
