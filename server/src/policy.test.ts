import { describe, expect, it } from "vitest";
import { classifyRisk, type RiskClass } from "./policy.js";

const classCases: Array<[string, RiskClass]> = [
  ["SELECT 1", "read"],
  ["select * from users", "read"],
  ["  SELECT 1  ", "read"],
  ["WITH t AS (SELECT 1) SELECT * FROM t", "read"],
  ["/* note */ SELECT 1", "read"],
  ["EXPLAIN SELECT * FROM t", "read"],
  // A common string function must not read as destructive.
  ["SELECT REPLACE(name, 'a', 'b') FROM t", "read"],
  ["INSERT INTO t VALUES (1)", "write"],
  ["UPDATE users SET x = 1", "write"],
  ["INSERT INTO audit SELECT * FROM users", "write"],
  ["DELETE FROM users", "destructive"],
  ["DROP TABLE t", "destructive"],
  ["TRUNCATE users", "destructive"],
  ["ALTER TABLE users ADD COLUMN x int", "destructive"],
  ["GRANT SELECT ON users TO bob", "destructive"],
  // A data-modifying CTE hidden under a read lead escalates.
  ["WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "destructive"],
  ["EXPLAIN ANALYZE DELETE FROM users", "destructive"],
  // An unrecognised leading keyword fails safe.
  ["VACUUM", "destructive"],
];

describe("classifyRisk", () => {
  it.each(classCases)("%s -> class=%s", (sql, expected) => {
    const r = classifyRisk(sql);
    expect(r.class).toBe(expected);
    expect(r.ok).toBe(true);
  });

  it("forwards a non-read statement (ok:true), unlike the old hard block", () => {
    for (const sql of ["DELETE FROM users", "UPDATE t SET a = 1", "-- SELECT 1\nDELETE FROM t"]) {
      expect(classifyRisk(sql).ok, sql).toBe(true);
    }
  });

  it("refuses only empty and multi-statement input", () => {
    for (const sql of ["", "   ", "SELECT 1; DROP TABLE t", "SELECT 1; SELECT 2"]) {
      expect(classifyRisk(sql).ok, sql).toBe(false);
    }
  });

  it("fails closed on a semicolon inside a string literal (known limitation)", () => {
    expect(classifyRisk("SELECT 'a;b'").ok).toBe(false);
  });
});
