import { describe, expect, it } from "vitest";
import { isReadOnlyQuery, mapDialect } from "./readonly";

describe("isReadOnlyQuery", () => {
  it("allows a plain SELECT", () => {
    expect(isReadOnlyQuery("SELECT 1")).toBe(true);
    expect(isReadOnlyQuery("select id, name from users where id = 1")).toBe(true);
  });

  it("allows a read-only CTE", () => {
    expect(isReadOnlyQuery("WITH t AS (SELECT 1 AS n) SELECT * FROM t")).toBe(true);
  });

  it("blocks single data-modifying statements", () => {
    for (const sql of [
      "DELETE FROM users",
      "UPDATE users SET name = 'x'",
      "INSERT INTO users (id) VALUES (1)",
      "DROP TABLE users",
      "TRUNCATE users",
      "ALTER TABLE users ADD COLUMN x int",
      "CREATE TABLE t (id int)",
      "GRANT SELECT ON users TO bob",
    ]) {
      expect(isReadOnlyQuery(sql), sql).toBe(false);
    }
  });

  it("blocks a write smuggled after a SELECT as a second statement", () => {
    expect(isReadOnlyQuery("SELECT 1; DROP TABLE users")).toBe(false);
    expect(isReadOnlyQuery("SELECT 1; DELETE FROM users")).toBe(false);
  });

  it("accepts a SELECT with a trailing comment, rejects a commented write", () => {
    expect(isReadOnlyQuery("SELECT 1 -- trailing comment")).toBe(true);
    expect(isReadOnlyQuery("DELETE FROM t -- comment")).toBe(false);
  });

  it("rejects empty or comment-only input", () => {
    expect(isReadOnlyQuery("")).toBe(false);
    expect(isReadOnlyQuery("   ")).toBe(false);
    expect(isReadOnlyQuery("-- just a comment")).toBe(false);
  });
});

describe("mapDialect", () => {
  it("maps sqlserver to the parser's transactsql", () => {
    expect(mapDialect("sqlserver")).toBe("transactsql");
  });

  it("passes through parser-supported dialects", () => {
    expect(mapDialect("mysql")).toBe("mysql");
    expect(mapDialect("sqlite")).toBe("sqlite");
  });

  it("defaults unknown database types to postgresql", () => {
    expect(mapDialect("cockroach")).toBe("postgresql");
    expect(mapDialect("")).toBe("postgresql");
  });
});
