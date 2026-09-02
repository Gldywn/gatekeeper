import { describe, expect, it } from "vitest";
import { formatSql } from "./format";

describe("formatSql", () => {
  it("puts each SELECT column on its own line and each clause on its own line", () => {
    const out = formatSql(
      "SELECT id, email, created_at FROM users WHERE id = 5 ORDER BY created_at DESC LIMIT 10",
    );
    expect(out).toBe(
      [
        "SELECT",
        "  id,",
        "  email,",
        "  created_at",
        "FROM users",
        "WHERE id = 5",
        "ORDER BY created_at DESC",
        "LIMIT 10",
      ].join("\n"),
    );
  });

  it("keeps a function call tight and breaks the join onto its own line", () => {
    const out = formatSql(
      "select u.id, count(o.id) as n from users u join orders o on o.user_id = u.id group by u.id",
    );
    expect(out).toBe(
      [
        "select",
        "  u.id,",
        "  count(o.id) as n",
        "from users u",
        "join orders o on o.user_id = u.id",
        "group by u.id",
      ].join("\n"),
    );
  });

  it("leaves a subquery inline rather than exploding it", () => {
    const out = formatSql(
      "SELECT id FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > 100)",
    );
    expect(out).toBe(
      [
        "SELECT",
        "  id",
        "FROM users",
        "WHERE id IN (SELECT user_id FROM orders WHERE total > 100)",
      ].join("\n"),
    );
  });

  it("never splits inside a string literal, even on a comma", () => {
    const out = formatSql("SELECT name FROM t WHERE label = 'hello world, foo'");
    expect(out).toBe(["SELECT", "  name", "FROM t", "WHERE label = 'hello world, foo'"].join("\n"));
    expect(out).toContain("'hello world, foo'");
  });

  it("keeps a JSON accessor operator in one piece", () => {
    expect(formatSql("SELECT profile->>'email' FROM crm.people")).toBe(
      ["SELECT", "  profile ->> 'email'", "FROM crm.people"].join("\n"),
    );
    expect(formatSql("SELECT profile#>>'{contact,email}' FROM crm.people")).toBe(
      ["SELECT", "  profile #>> '{contact,email}'", "FROM crm.people"].join("\n"),
    );
  });

  it("is idempotent", () => {
    for (const sql of [
      "SELECT a, b FROM t WHERE a = 1",
      "select 1",
      "SELECT * FROM x LEFT OUTER JOIN y ON y.id = x.id",
      "SELECT id FROM users WHERE id IN (SELECT user_id FROM orders)",
    ]) {
      const once = formatSql(sql);
      expect(formatSql(once)).toBe(once);
    }
  });

  it("preserves every token (whitespace-insensitive) so meaning cannot change", () => {
    const strip = (s: string) => s.replace(/\s+/g, "");
    for (const sql of [
      "SELECT a,b,c FROM t",
      "SELECT count(*) AS n FROM users u JOIN orders o ON o.uid=u.id",
      "SELECT id FROM a UNION ALL SELECT id FROM b",
      "SELECT id FROM t WHERE x>=1 AND y<>2",
    ]) {
      // These queries hold no spaces inside their string tokens, so raw whitespace
      // stripping is a fair token-equality proxy.
      expect(strip(formatSql(sql))).toBe(strip(sql));
    }
  });

  it("does not throw on empty or non-SQL input", () => {
    expect(formatSql("")).toBe("");
    expect(() => formatSql("!!! not a query")).not.toThrow();
  });
});
