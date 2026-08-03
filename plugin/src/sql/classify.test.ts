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

  it("unwraps EXPLAIN ANALYZE of a modifying statement to its risk", () => {
    expect(classifyQuery("EXPLAIN ANALYZE DELETE FROM users", pg).class).toBe("destructive");
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
