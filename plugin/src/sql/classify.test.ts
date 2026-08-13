import { describe, expect, it } from "vitest";
import { classifyQuery, rank } from "./classify";

const pg = "postgresql";

describe("classifyQuery", () => {
  it("classifies plain reads", () => {
    for (const sql of [
      "SELECT 1",
      "select id, name from users where id = 1",
      "WITH t AS (SELECT 1 AS n) SELECT * FROM t",
    ]) {
      const v = classifyQuery(sql, pg);
      expect(v.class, sql).toBe("read");
      expect(v.blocked, sql).toBe(false);
    }
  });

  it("classifies plain writes", () => {
    expect(classifyQuery("INSERT INTO users (id) VALUES (1)", pg).class).toBe("write");
    expect(classifyQuery("UPDATE users SET name = 'x' WHERE id = 1", pg).class).toBe("write");
  });

  it("classifies destructive statements", () => {
    for (const sql of [
      "DELETE FROM users",
      "DROP TABLE users",
      "TRUNCATE users",
      "ALTER TABLE users ADD COLUMN x int",
      "CREATE TABLE t (id int)",
      "GRANT SELECT ON users TO bob",
    ]) {
      expect(classifyQuery(sql, pg).class, sql).toBe("destructive");
    }
  });

  it("never reads a write hidden inside a read shape", () => {
    // INSERT ... SELECT and a locking read must not classify as a plain read.
    expect(
      rank(classifyQuery("INSERT INTO audit SELECT * FROM users", pg).class),
    ).toBeGreaterThanOrEqual(rank("write"));
    expect(
      rank(classifyQuery("SELECT id FROM users WHERE id = 1 FOR UPDATE", pg).class),
    ).toBeGreaterThanOrEqual(rank("write"));
  });

  it("never reads a write hidden in a MySQL executable comment", () => {
    for (const sql of [
      "SELECT 1 /*!40000 DROP TABLE t */",
      "SELECT 1 /*!, DELETE FROM t */",
      "SELECT * FROM t /*!40000 INTO OUTFILE '/tmp/x' */",
    ]) {
      expect(classifyQuery(sql, "mysql").class, sql).toBe("destructive");
    }
  });

  it("leaves a benign MySQL optimizer hint as a read", () => {
    const v = classifyQuery("SELECT /*!40001 SQL_NO_CACHE */ * FROM t", "mysql");
    expect(v.class).toBe("read");
    expect(v.blocked).toBe(false);
  });

  it("never reads a locking read (FOR SHARE / LOCK IN SHARE MODE)", () => {
    for (const [sql, dialect] of [
      ["SELECT * FROM t FOR SHARE", "postgresql"],
      ["SELECT * FROM t FOR KEY SHARE", "postgresql"],
      ["SELECT * FROM t LOCK IN SHARE MODE", "mysql"],
    ] as const) {
      const v = classifyQuery(sql, dialect);
      expect(v.class === "read" && !v.blocked, sql).toBe(false);
    }
  });

  it("blocks multi-statement input", () => {
    for (const sql of ["SELECT 1; DROP TABLE users", "SELECT 1; SELECT 2"]) {
      expect(classifyQuery(sql, pg).blocked, sql).toBe(true);
    }
  });

  it("never reads a SELECT ... INTO (table create / file write)", () => {
    for (const [sql, dialect] of [
      ["SELECT * INTO stolen FROM users", "postgresql"],
      ["SELECT * FROM users INTO OUTFILE '/tmp/x.csv'", "mysql"],
      ["SELECT * INTO DUMPFILE '/tmp/x' FROM users", "mysql"],
    ] as const) {
      const v = classifyQuery(sql, dialect);
      // The security property: it must never be an approvable read.
      expect(v.class === "read" && !v.blocked, sql).toBe(false);
    }
  });

  it("fails a data-modifying CTE closed, never read", () => {
    expect(classifyQuery("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", pg).class).toBe(
      "destructive",
    );
  });

  it("reads an EXPLAIN of a SELECT, approvable (the parser cannot parse EXPLAIN itself)", () => {
    for (const sql of [
      "EXPLAIN SELECT 1",
      "EXPLAIN VERBOSE SELECT id FROM users",
      "EXPLAIN (FORMAT JSON) SELECT 1",
      "EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM users WHERE id = 1",
      // The reported query: schema-qualified tables, subqueries, ->> JSON access.
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT t.id FROM subvention.subvention_transaction t
       WHERE t.subvention_id = (SELECT subvention_id FROM subvention.subvention_transaction WHERE id = 'x')
         AND t.metadata->>'orderId' IN (SELECT s.metadata->>'orderId' FROM subvention.subvention_transaction s WHERE s.id = 'x')`,
    ]) {
      const v = classifyQuery(sql, pg);
      expect(v.class, sql).toBe("read");
      expect(v.blocked, sql).toBe(false);
    }
  });

  // SECURITY: EXPLAIN ANALYZE (or ANALYSE) actually runs the wrapped statement, so it must
  // carry that statement's risk and never read as a harmless plan.
  it("never lets EXPLAIN ANALYZE hide a modifying statement", () => {
    for (const [sql, cls] of [
      ["EXPLAIN ANALYZE DELETE FROM users", "destructive"],
      ["EXPLAIN ANALYSE DELETE FROM users", "destructive"],
      ["EXPLAIN (ANALYZE, BUFFERS) DELETE FROM users WHERE id = 1", "destructive"],
      ["EXPLAIN (ANALYSE) TRUNCATE users", "destructive"],
      ["EXPLAIN ANALYZE UPDATE users SET name = 'x' WHERE id = 1", "write"],
      ["EXPLAIN (ANALYZE) INSERT INTO users (id) VALUES (1)", "write"],
    ] as const) {
      const v = classifyQuery(sql, pg);
      expect(v.class, sql).toBe(cls);
      // Approvable under the matching mode (not a dead blocked card), but never a read.
      expect(v.class === "read", sql).toBe(false);
      expect(v.blocked, sql).toBe(false);
    }
  });

  // A plain EXPLAIN (no ANALYZE) only plans; it never executes the wrapped DML.
  it("treats a plain EXPLAIN of a modifying statement as a read (plan only)", () => {
    for (const sql of ["EXPLAIN DELETE FROM users", "EXPLAIN VERBOSE UPDATE users SET x = 1"]) {
      const v = classifyQuery(sql, pg);
      expect(v.class, sql).toBe("read");
      expect(v.blocked, sql).toBe(false);
    }
  });

  it("still blocks a multi-statement or empty EXPLAIN", () => {
    for (const sql of ["EXPLAIN SELECT 1; DROP TABLE users", "EXPLAIN"]) {
      expect(classifyQuery(sql, pg).blocked, sql).toBe(true);
    }
  });

  // Nested EXPLAIN is invalid SQL; it must never downgrade an inner ANALYZE modify to read.
  it("blocks a nested EXPLAIN instead of reading its inner ANALYZE", () => {
    for (const sql of [
      "EXPLAIN EXPLAIN ANALYZE DELETE FROM users",
      "EXPLAIN ANALYZE EXPLAIN SELECT 1",
    ]) {
      const v = classifyQuery(sql, pg);
      expect(v.class === "read", sql).toBe(false);
      expect(v.blocked, sql).toBe(true);
    }
  });

  it("treats an unrecognized statement as destructive and blocked (fail safe)", () => {
    const v = classifyQuery("VACUUM", pg);
    expect(v.class).toBe("destructive");
    expect(v.blocked).toBe(true);
  });

  it("classifies a MySQL REPLACE as destructive", () => {
    expect(classifyQuery("REPLACE INTO users (id) VALUES (1)", "mysql").class).toBe("destructive");
  });

  it("blocks empty or comment-only input", () => {
    for (const sql of ["", "   ", "-- just a comment"]) {
      expect(classifyQuery(sql, pg).blocked, sql).toBe(true);
    }
  });
});

describe("rank", () => {
  it("orders read < write < destructive", () => {
    expect(rank("read")).toBeLessThan(rank("write"));
    expect(rank("write")).toBeLessThan(rank("destructive"));
  });
});
