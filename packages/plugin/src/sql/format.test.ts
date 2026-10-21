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

  it("lists SET assignments and WHERE conditions one per line, RETURNING on its own", () => {
    const out = formatSql(
      "UPDATE invoices AS i SET status = 'void', voided_at = now() WHERE i.id = 'x' AND i.amount_eur = 120 OR i.copies > 1 RETURNING i.id, i.status",
    );
    expect(out).toBe(
      [
        "UPDATE invoices AS i",
        "SET",
        "  status = 'void',",
        "  voided_at = now()",
        "WHERE i.id = 'x'",
        "  AND i.amount_eur = 120",
        "  OR i.copies > 1",
        "RETURNING i.id, i.status",
      ].join("\n"),
    );
  });

  it("keeps the AND of a BETWEEN, any inside a CASE, and those of a subquery on their line", () => {
    expect(formatSql("SELECT id FROM t WHERE a BETWEEN 1 AND 5 AND b = 2")).toBe(
      ["SELECT", "  id", "FROM t", "WHERE a BETWEEN 1 AND 5", "  AND b = 2"].join("\n"),
    );
    expect(
      formatSql("SELECT id FROM t WHERE CASE WHEN a = 1 AND b = 2 THEN true END AND c = 3"),
    ).toBe(
      [
        "SELECT",
        "  id",
        "FROM t",
        "WHERE CASE WHEN a = 1 AND b = 2 THEN true END",
        "  AND c = 3",
      ].join("\n"),
    );
    expect(
      formatSql("SELECT id FROM t WHERE NOT EXISTS (SELECT 1 FROM u WHERE u.a = 1 AND u.b = 2)"),
    ).toContain("WHERE NOT EXISTS (SELECT 1 FROM u WHERE u.a = 1 AND u.b = 2)");
    // A BETWEEN inside a CASE must not swallow the next top-level AND.
    expect(
      formatSql("SELECT id FROM t WHERE CASE WHEN a BETWEEN 1 AND 5 THEN 1 END = 1 AND b = 2"),
    ).toContain("END = 1\n  AND b = 2");
  });

  it("is idempotent", () => {
    for (const sql of [
      "SELECT a, b FROM t WHERE a = 1",
      "select 1",
      "SELECT * FROM x LEFT OUTER JOIN y ON y.id = x.id",
      "SELECT id FROM users WHERE id IN (SELECT user_id FROM orders)",
      "UPDATE t SET a = 1, b = 2 WHERE x = 1 AND y BETWEEN 1 AND 2 RETURNING id",
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
