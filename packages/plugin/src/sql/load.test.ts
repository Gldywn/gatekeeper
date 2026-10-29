import { describe, expect, it } from "vitest";
import {
  agentMessage,
  checkLoad,
  type Facts,
  type Line,
  loadStatsSql,
  parseLoadStats,
  planLoad,
  type RelFacts,
  relKey,
} from "./load";

const text = (line: Line) =>
  line.map((s) => (typeof s === "string" ? s : `\`${s.code}\``)).join("");

function facts(entries: Record<string, Partial<RelFacts>>): Facts {
  const map: Facts = new Map();
  for (const [name, f] of Object.entries(entries)) {
    const [schema, table] = name.includes(".") ? name.split(".") : [null, name];
    map.set(relKey({ schema, table }), {
      rows: 0,
      rls: false,
      indexed: new Set(["id"]),
      leading: new Set(["id"]),
      unique: [["id"]],
      columns: null,
      ...f,
    });
  }
  return map;
}

function check(sql: string, f: Facts | "pending" | "timeout" = new Map(), dialect = "postgresql") {
  const result = checkLoad(planLoad(sql, dialect), f);
  return { ...result, lines: result.lines.map(text), notes: result.notes.map(text) };
}

const BIG = 41_200_000;

describe("rows changed", () => {
  it("flags UPDATE and DELETE without WHERE whatever the size, in every dialect", () => {
    for (const dialect of ["postgresql", "mysql"]) {
      expect(check("DELETE FROM sessions", new Map(), dialect).lines).toEqual([
        "DELETE without WHERE removes every row of `sessions`",
      ]);
      expect(check("UPDATE sessions SET a = 1", new Map(), dialect).lines).toEqual([
        "UPDATE without WHERE changes every row of `sessions`",
      ]);
    }
  });

  it("does not call a joined MySQL write unbounded", () => {
    for (const sql of [
      "UPDATE a JOIN b ON a.id = b.a_id SET a.x = 1",
      "DELETE a FROM a JOIN b ON a.id = b.a_id",
    ])
      expect(check(sql, new Map(), "mysql").lines).toEqual([]);
  });

  it("reads WHERE TRUE and WHERE 1 = 1 as no WHERE", () => {
    expect(check("DELETE FROM public.t WHERE TRUE").lines).toHaveLength(1);
    expect(check("DELETE FROM public.t WHERE 1 = 1").lines).toHaveLength(1);
    expect(check("DELETE FROM public.t WHERE id = 1").lines).toEqual([]);
  });

  it("ignores a plain EXPLAIN and checks what EXPLAIN ANALYZE runs", () => {
    expect(check("EXPLAIN DELETE FROM public.t").lines).toEqual([]);
    expect(check("EXPLAIN ANALYZE DELETE FROM public.t").lines).toHaveLength(1);
  });

  it("reads a write inside a CTE, and leaves a statement the parser rejects incomplete", () => {
    expect(check("WITH d AS (DELETE FROM public.t RETURNING id) SELECT id FROM d").lines).toEqual([
      "DELETE without WHERE removes every row of `t`",
    ]);
    const r = check("DELETE FROM");
    expect(r.lines).toEqual([]);
    expect(r.complete).toBe(false);
  });

  it("flags a large write whose filter uses no index", () => {
    const f = facts({ "public.payment_intent": { rows: 18_400_000 } });
    const sql = `UPDATE public.payment_intent SET status = 'EXPIRED' WHERE "updatedAt" < now()`;
    const r = check(sql, f);
    expect(r.lines).toEqual([
      "Filter on `updatedAt` uses no index and may scan all of `payment_intent`",
    ]);
    expect(r.estimates).toEqual([
      { table: "payment_intent", ref: "public.payment_intent", rows: 18_400_000 },
    ]);
    expect(r.heavy).toBe(true);
  });

  it("accepts a large write filtered on an indexed column, whatever the key", () => {
    const f = facts({ "public.t": { rows: BIG, indexed: new Set(["id", "company_id"]) } });
    for (const sql of [
      "UPDATE public.t SET a = 1 WHERE id = 7",
      "UPDATE public.t SET a = 1 WHERE 7 = id",
      "DELETE FROM public.t WHERE id IN (1, 2)",
      "UPDATE public.t SET plan = 'pro' WHERE company_id = 42",
    ])
      expect(check(sql, f).lines).toEqual([]);
  });

  it("flags a large write that no condition filters", () => {
    const f = facts({ "public.t": { rows: BIG }, "public.u": { rows: BIG } });
    expect(check("UPDATE public.t SET a = 1 WHERE now() > '2020-01-01'", f).lines).toEqual([
      "UPDATE may change every row of `t` since no condition filters it",
    ]);
    expect(check("UPDATE public.t SET a = u.b FROM public.u WHERE t.uid = u.id", f).lines).toEqual([
      "UPDATE may change every row of `t` since no condition filters it",
      "Reads every row of `u` since no condition filters it",
    ]);
  });

  it("never treats a small write target as large", () => {
    const f = facts({ "public.t": { rows: 10 } });
    expect(check("UPDATE public.t SET a = 1 WHERE b = 2", f).lines).toEqual([]);
  });
});

describe("scans", () => {
  const f = facts({ "public.payment_attempt": { rows: BIG } });

  it("flags an unfiltered read of a large table", () => {
    const r = check("SELECT status, count(*) FROM public.payment_attempt GROUP BY status", f);
    expect(r.lines).toEqual(["Reads every row of `payment_attempt` without a `WHERE` clause"]);
    expect(r.estimates).toEqual([
      { table: "payment_attempt", ref: "public.payment_attempt", rows: BIG },
    ]);
    expect(r.complete).toBe(true);
  });

  it("exempts a small unfiltered preview, but not with an offset, an order, an aggregate or RLS", () => {
    for (const sql of [
      "SELECT * FROM public.payment_attempt LIMIT 50",
      "SELECT * FROM public.payment_attempt WHERE 1 = 1 LIMIT 50",
      "SELECT lower(status) FROM public.payment_attempt LIMIT 50",
    ])
      expect(check(sql, f).lines, sql).toEqual([]);
    for (const sql of [
      "SELECT * FROM public.payment_attempt LIMIT 50 OFFSET 10",
      "SELECT * FROM public.payment_attempt ORDER BY created_at LIMIT 50",
      "SELECT count(*) FROM public.payment_attempt LIMIT 50",
      "SELECT coalesce(sum(amount), 0) FROM public.payment_attempt LIMIT 50",
      "SELECT * FROM public.payment_attempt LIMIT 5000",
    ])
      expect(check(sql, f).lines).toHaveLength(1);
    const rls = facts({ "public.payment_attempt": { rows: BIG, rls: true } });
    expect(check("SELECT * FROM public.payment_attempt LIMIT 50", rls).lines).toHaveLength(1);
  });

  it("flags a filter on columns no index covers, LIMIT included", () => {
    const r = check(
      "SELECT id FROM public.payment_attempt WHERE failure_code = 'card_declined' LIMIT 20",
      f,
    );
    expect(r.lines).toEqual([
      "Filter on `failure_code` uses no index and may scan all of `payment_attempt` despite the `LIMIT`",
    ]);
  });

  it("stays silent when a filtered column is indexed at any position", () => {
    const indexed = facts({
      "public.payment_attempt": { rows: BIG, indexed: new Set(["id", "failure_code"]) },
    });
    expect(
      check("SELECT id FROM public.payment_attempt WHERE failure_code = 'x'", indexed).lines,
    ).toEqual([]);
    // Documented false negative: an indexed range can still read most of the table.
    expect(check("SELECT id FROM public.payment_attempt WHERE id > 0", f).lines).toEqual([]);
  });

  it("says so when the index list is unavailable", () => {
    const missing = facts({ "public.payment_attempt": { rows: BIG, indexed: null } });
    const r = check("SELECT id FROM public.payment_attempt WHERE failure_code = 'x'", missing);
    expect(r.lines).toEqual([]);
    expect(r.notes).toEqual(["Index lists require Beekeeper 5.5 or later"]);
    expect(r.complete).toBe(false);
  });

  it("does not let a correlated subquery filter the outer table", () => {
    const both = facts({
      "public.a": { rows: BIG },
      "public.b": { rows: BIG, indexed: new Set(["a_id"]) },
    });
    const r = check(
      "SELECT a.id FROM public.a WHERE EXISTS (SELECT 1 FROM public.b WHERE b.a_id = a.id)",
      both,
    );
    expect(r.lines).toEqual(["Reads every row of `a` since no condition filters it"]);
  });

  it("restores quoted PostgreSQL names", () => {
    const quoted = facts({ 'public.Payment "Attempt"': { rows: BIG } });
    expect(check('SELECT * FROM public."Payment ""Attempt"""', quoted).lines).toEqual([
      'Reads every row of `Payment "Attempt"` without a `WHERE` clause',
    ]);
  });

  it("binds unqualified columns through the table columns", () => {
    const two = facts({
      "public.a": { rows: BIG, columns: ["id", "name"] },
      "public.b": { rows: BIG, columns: ["id", "a_id", "status"], indexed: new Set(["id"]) },
    });
    const r = check(
      "SELECT name FROM public.a JOIN public.b ON a.id = b.a_id WHERE status = 'x'",
      two,
    );
    expect(r.lines).toEqual(["Filter on `a_id`, `status` uses no index and may scan all of `b`"]);
  });

  it("notes an unknown estimate instead of guessing", () => {
    const view = new Map([
      [
        relKey({ schema: "reporting", table: "daily_settlement" }),
        {
          rows: null,
          kind: "view" as const,
          rls: false,
          indexed: null,
          columns: null,
        },
      ],
    ]);
    const r = check("SELECT * FROM reporting.daily_settlement WHERE day = '2026-10-08'", view);
    expect(r.notes).toEqual(["`daily_settlement` is a view with no row estimate"]);
    expect(r.heavy).toBe(false);
    expect(r.complete).toBe(false);
  });

  it("keeps the SQL-only findings while statistics are pending or late", () => {
    const pending = check("DELETE FROM public.t", "pending");
    expect(pending.lines).toHaveLength(1);
    expect(pending.notes).toEqual([]);
    expect(pending.complete).toBe(false);
    const late = check("DELETE FROM public.t", "timeout");
    expect(late.lines).toHaveLength(1);
    expect(late.notes).toEqual(["Statistics did not return within 5 seconds"]);
  });

  it("applies no size rule outside PostgreSQL, even on an engine read with its grammar", () => {
    for (const engine of ["mysql", "redshift"]) {
      const r = check("SELECT * FROM payment_attempt", f, engine);
      expect(r.lines, engine).toEqual([]);
      expect(r.complete, engine).toBe(true);
    }
  });

  it("reads the queries a statement runs inside it", () => {
    const big = facts({ "public.big": { rows: BIG }, "public.small": { rows: 10 } });
    for (const sql of [
      "CREATE TABLE public.copy AS SELECT * FROM public.big",
      "SELECT id, (SELECT count(*) FROM public.big) AS n FROM public.small WHERE id = 1",
      "UPDATE public.small SET n = (SELECT count(*) FROM public.big) WHERE id = 1",
    ])
      expect(check(sql, big).lines, sql).toEqual([
        "Reads every row of `big` without a `WHERE` clause",
      ]);
    expect(
      check("CREATE TABLE public.copy AS SELECT * FROM public.big WITH NO DATA", big).lines,
    ).toEqual([]);
  });

  it("sees a CTE only where PostgreSQL does", () => {
    const big = facts({ big: { rows: BIG } });
    expect(check("WITH big AS (SELECT * FROM big) SELECT count(*) FROM big", big).lines).toEqual([
      "Reads every row of `big` without a `WHERE` clause",
    ]);
    expect(
      check(
        "WITH RECURSIVE big AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM big WHERE n < 3) SELECT n FROM big",
        big,
      ).lines,
    ).toEqual([]);
  });
});

describe("joins", () => {
  it("flags sources no condition links", () => {
    const r = check("SELECT * FROM public.a, public.b WHERE a.x = 1");
    expect(r.lines).toEqual([
      "Missing join condition pairs every row of `a` with every row of `b`",
    ]);
  });

  it("accepts linking conditions in WHERE, ON and USING", () => {
    for (const sql of [
      "SELECT * FROM public.a, public.b WHERE a.id = b.a_id",
      "SELECT * FROM public.a JOIN public.b ON a.id = b.a_id",
      "SELECT * FROM public.a JOIN public.b USING (id)",
      "SELECT * FROM public.a CROSS JOIN public.b WHERE a.id = b.a_id",
    ])
      expect(check(sql).lines).toEqual([]);
  });

  it("does not let an OR link two sources", () => {
    expect(
      check("SELECT * FROM public.a, public.b WHERE a.id = b.a_id OR a.x = 1").lines,
    ).toHaveLength(1);
  });

  it("finds the unlinked third source", () => {
    expect(check("SELECT * FROM public.a, public.b JOIN public.c ON b.id = c.b_id").lines).toEqual([
      "Missing join condition pairs every row of `a` with every row of `b`",
    ]);
    const comma = "SELECT * FROM public.a JOIN public.b ON a.id = b.a_id, public.c";
    expect(check(comma).lines).toEqual([
      "Missing join condition pairs every row of `a` with every row of `c`",
    ]);
    // node-sql-parser's PostgreSQL grammar swallows a comma after JOIN ... ON into the ON clause.
    expect(check(comma, new Map(), "redshift").complete).toBe(false);
  });

  it("flags an explicit CROSS JOIN only when both sizes make it large", () => {
    const sql = "SELECT * FROM public.a CROSS JOIN public.b";
    expect(check(sql).lines).toEqual([]);
    const big = facts({ "public.a": { rows: 5_000 }, "public.b": { rows: 5_000 } });
    expect(check(sql, big).lines).toHaveLength(1);
    // A filter makes the size of its side unknown.
    expect(check(`${sql} WHERE a.id = 7`, big).lines).toEqual([]);
  });
});

describe("locks", () => {
  const f = facts({
    "public.big": { rows: BIG },
    "public.small": { rows: 10 },
    "public.mv": { rows: BIG },
  });

  it("flags locking DDL on a large table only", () => {
    expect(check("CREATE INDEX i ON public.big (a)", f).lines).toEqual([
      "CREATE INDEX without CONCURRENTLY blocks writes on `big` during the build",
    ]);
    expect(check("CREATE INDEX CONCURRENTLY i ON public.big (a)", f).lines).toEqual([]);
    expect(check("CREATE INDEX i ON public.small (a)", f).lines).toEqual([]);
    expect(check("ALTER TABLE public.big ADD COLUMN x int", f).lines).toEqual([
      "ALTER TABLE may lock and rewrite `big`",
    ]);
    expect(check("LOCK TABLE public.big", f).lines).toEqual([
      "LOCK TABLE holds an explicit lock on `big`",
    ]);
  });

  it("reads the maintenance commands that lock whole tables", () => {
    expect(check("VACUUM FULL public.big", f).lines).toEqual([
      "VACUUM FULL locks and rewrites `big`",
    ]);
    expect(check("VACUUM (FULL) public.big, public.mv", f).lines).toEqual([
      "VACUUM FULL locks and rewrites `big`",
      "VACUUM FULL locks and rewrites `mv`",
    ]);
    expect(check("VACUUM (FULL false) public.big", f).lines).toEqual([]);
    expect(check("VACUUM public.big", f).lines).toEqual([]);
    expect(check("VACUUM FULL", f).lines).toEqual([
      "VACUUM FULL locks and rewrites the tables it covers",
    ]);
    expect(check("CLUSTER public.big", f).lines).toEqual(["CLUSTER locks and rewrites `big`"]);
    expect(check("REINDEX TABLE public.big", f).lines).toEqual([
      "REINDEX without CONCURRENTLY blocks writes on `big`",
    ]);
    expect(check("REINDEX TABLE CONCURRENTLY public.big", f).lines).toEqual([]);
    expect(check("REFRESH MATERIALIZED VIEW public.mv", f).lines).toEqual([
      "REFRESH MATERIALIZED VIEW without CONCURRENTLY blocks reads of `mv`",
    ]);
    expect(check("/* VACUUM FULL */ SELECT 1", f).lines).toEqual([]);
  });

  it("leaves DDL alone outside PostgreSQL", () => {
    expect(check("ALTER TABLE big ADD COLUMN x int", new Map(), "mysql").lines).toEqual([]);
    expect(check("ALTER TABLE public.big ADD COLUMN x int", f, "redshift").lines).toEqual([]);
  });
});

describe("agent hints", () => {
  it("come from the SQL text alone", () => {
    const sql = "SELECT * FROM public.payment_attempt WHERE failure_code = 'x'";
    expect(planLoad(sql, "postgresql").hints).toEqual([]);
    expect(planLoad("DELETE FROM public.t", "postgresql").hints).toEqual([
      "The DELETE has no WHERE clause.",
    ]);
    expect(planLoad("SELECT count(*) FROM public.t", "postgresql").hints).toEqual([
      "The query reads a table without a WHERE clause.",
    ]);
    expect(planLoad("SELECT * FROM public.t LIMIT 10", "postgresql").hints).toEqual([]);
    expect(planLoad("SELECT * FROM public.a, public.b WHERE a.x = 1", "postgresql").hints).toEqual([
      "No join condition links a and b.",
    ]);
  });

  it("put the operator's note first", () => {
    expect(agentMessage(" Narrow it. ", ["The DELETE has no WHERE clause."])).toBe(
      "Narrow it. The DELETE has no WHERE clause.",
    );
    expect(agentMessage(undefined, [])).toBeUndefined();
  });
});

describe("statistics", () => {
  it("passes every name as an escaped literal", () => {
    const sql = loadStatsSql([
      { schema: null, table: "plain" },
      { schema: "Odd'Schema", table: "back\\slash" },
    ]);
    expect(sql).toContain("(0, NULL::pg_catalog.text, E'plain')");
    expect(sql).toContain("(1, E'Odd''Schema', E'back\\\\slash')");
    expect(sql).not.toContain("pg_partition_tree");
    expect(() => loadStatsSql([{ schema: null, table: "x".repeat(64) }])).toThrow();
  });

  const rels = [{ schema: null, table: "t" }];
  const row = (parts: unknown[], kind = "r") => [
    { i: 0, schema: "public", kind, rls: false, deeper: false, parts: JSON.stringify(parts) },
  ];

  it("uses the live counter for a never analyzed table, 0 included while statistics are collected", () => {
    expect(parseLoadStats(rels, row([["r", -1, 42]]))?.[0].rows).toBe(42);
    expect(parseLoadStats(rels, row([["r", 1200, 42]]))?.[0].rows).toBe(1200);
    // An empty table autovacuum never analyzed, the common case on a real database.
    const counted = [{ ...row([["r", -1, 0]])[0], track_counts: "on" }];
    expect(parseLoadStats(rels, counted)?.[0].rows).toBe(0);
    // Without collected statistics the counter reads 0 whatever the table holds.
    expect(parseLoadStats(rels, row([["r", -1, 0]]))?.[0].rows).toBeNull();
    const off = [{ ...row([["r", -1, 0]])[0], track_counts: "off" }];
    expect(parseLoadStats(rels, off)?.[0].rows).toBeNull();
  });

  it("never reads a malformed value as zero rows", () => {
    for (const part of [
      ["r", null, null],
      ["r", "", ""],
      ["r", false, false],
      ["r", 5],
      ["x", 5, 5],
    ])
      expect(parseLoadStats(rels, row([part]))?.[0].rows).toBeNull();
    expect(parseLoadStats(rels, [{ i: null, kind: "r", deeper: false, parts: "[]" }])).toBeNull();
    expect(
      parseLoadStats(rels, [
        {
          i: 0,
          kind: "r",
          deeper: false,
          parts: JSON.stringify([
            ["r", 1e308, 0],
            ["r", 1e308, 0],
          ]),
        },
      ])?.[0].rows,
    ).toBeNull();
  });

  it("reads RLS and depth truncation strictly", () => {
    expect(
      parseLoadStats(rels, [{ i: 0, kind: "r", deeper: false, parts: '[["r",5,0]]' }])?.[0].rls,
    ).toBeNull();
    expect(
      parseLoadStats(rels, [
        { i: 0, kind: "r", rls: "t", deeper: false, parts: '[["r",5,0]]' },
      ])?.[0].rls,
    ).toBe(true);
    // Children past the traversal depth make a small sum unknown, never complete.
    expect(
      parseLoadStats(rels, [{ i: 0, kind: "p", deeper: true, parts: '[["p",-1,0]]' }])?.[0].rows,
    ).toBeNull();
    expect(
      parseLoadStats(rels, [{ i: 0, kind: "p", deeper: "t", parts: '[["r",2000000,0]]' }])?.[0]
        .rows,
    ).toBe(2_000_000);
  });

  it("sums partitions and inherited children, and reads an unknown leaf as unknown", () => {
    expect(
      parseLoadStats(
        rels,
        row(
          [
            ["p", -1, 0],
            ["r", 600, 0],
            ["r", 400, 0],
          ],
          "p",
        ),
      )?.[0].rows,
    ).toBe(1000);
    expect(
      parseLoadStats(
        rels,
        row([
          ["r", 2_000_000, 0],
          ["r", 10, 0],
        ]),
      )?.[0].rows,
    ).toBe(2_000_010);
    expect(
      parseLoadStats(
        rels,
        row(
          [
            ["p", -1, 0],
            ["f", -1, 0],
            ["r", 10, 0],
          ],
          "p",
        ),
      )?.[0].rows,
    ).toBeNull();
    expect(
      parseLoadStats(
        rels,
        row(
          [
            ["p", -1, 0],
            ["f", -1, 0],
            ["r", 2_000_000, 0],
          ],
          "p",
        ),
      )?.[0].rows,
    ).toBe(2_000_000);
  });

  it("reads views, foreign tables, missing relations and malformed rows as unknown", () => {
    expect(parseLoadStats(rels, [{ i: 0, kind: "v", parts: null }])?.[0]).toMatchObject({
      rows: null,
      kind: "view",
    });
    expect(parseLoadStats(rels, [{ i: 0, kind: "f", parts: null }])?.[0].kind).toBe("foreign");
    expect(parseLoadStats(rels, [{ i: 0, kind: null, parts: null }])?.[0].rows).toBeNull();
    expect(parseLoadStats(rels, [{ i: 0, kind: "r", parts: "{oops" }])?.[0].rows).toBeNull();
    expect(parseLoadStats(rels, [])).toBeNull();
    expect(parseLoadStats(rels, [{ i: 3, kind: "r", parts: "[]" }])).toBeNull();
  });
});

describe("coverage", () => {
  const BIG_ROWS = 41_200_000;

  it("says so when a column cannot be matched to its table", () => {
    const f = facts({
      "public.a": { rows: BIG_ROWS, columns: null },
      "public.b": { rows: BIG_ROWS, columns: null },
    });
    const r = check("SELECT * FROM public.a JOIN public.b ON a.id = b.a_id WHERE status = 'x'", f);
    expect(r.lines).toEqual([]);
    expect(r.notes).toEqual(["Part of this query could not be checked"]);
    expect(r.complete).toBe(false);
  });

  it("exempts a preview only for a known ordinary table without row security", () => {
    const sql = "SELECT * FROM public.t LIMIT 10";
    const missing = check(sql, new Map());
    expect(missing.notes).toEqual(["`t` has no row estimate yet"]);
    expect(missing.complete).toBe(false);
    const view = check(sql, facts({ "public.t": { rows: null, kind: "view", indexed: null } }));
    expect(view.notes).toEqual(["`t` is a view with no row estimate"]);
    expect(check(sql, facts({ "public.t": { rows: BIG_ROWS, rls: null } })).lines).toHaveLength(1);
    expect(check(sql, facts({ "public.t": { rows: BIG_ROWS } })).complete).toBe(true);
  });

  it("claims every row only for a single-table write", () => {
    const r = check("UPDATE public.t SET x = 1 FROM public.u");
    expect(r.lines).toEqual([
      "Missing join condition pairs every row of `t` with every row of `u`",
    ]);
    expect(planLoad("UPDATE public.t SET x = 1 FROM public.u", "postgresql").hints).toContain(
      "The UPDATE has no WHERE clause.",
    );
    expect(check("UPDATE a, b SET a.x = 1 WHERE a.id = b.id", new Map(), "mysql").complete).toBe(
      false,
    );
  });

  it("links a USING join to the side it joins only", () => {
    expect(check("SELECT * FROM public.a, public.b JOIN public.c USING (id)").lines).toEqual([
      "Missing join condition pairs every row of `a` with every row of `b`",
    ]);
  });

  it("links two sources through any condition naming both, an OR only when every branch does", () => {
    for (const sql of [
      "SELECT * FROM public.s, public.e WHERE e.ts BETWEEN s.start_at AND s.end_at AND s.id = 3",
      "SELECT * FROM public.a JOIN public.b ON b.id IN (a.x, a.y)",
      "SELECT * FROM public.a JOIN public.b ON st_dwithin(a.geom, b.geom, 100)",
      "SELECT m.body FROM public.messages m, public.users u WHERE u.id = m.sender_id OR u.id = m.recipient_id",
    ])
      expect(check(sql).lines).toEqual([]);
    expect(
      check("SELECT * FROM public.a, public.b WHERE a.id = b.a_id OR b.y = 1").lines,
    ).toHaveLength(1);
  });

  it("never reads a function, LATERAL item, derived table or CTE in FROM as a missing join", () => {
    for (const sql of [
      "SELECT o.id FROM public.orders o, jsonb_array_elements(o.items) AS i WHERE o.id = 42",
      "SELECT u.id FROM public.users u, LATERAL (SELECT count(*) AS n FROM public.orders WHERE orders.user_id = u.id) x WHERE u.id = 42",
      "SELECT o.id FROM public.orders o, (SELECT max(total) AS m FROM public.orders) top WHERE o.id = 1",
      // A table joined through the item is linked through it.
      "SELECT g.name FROM public.orders o, unnest(o.tag_ids) AS t(tag_id), public.tags g WHERE g.id = t.tag_id AND o.id = 42",
      "SELECT u.id, p.name FROM public.users u, LATERAL (SELECT 1 AS product_id) x, public.products p WHERE p.id = x.product_id AND u.id = 42",
      "SELECT u.id, i.name FROM public.users u LEFT JOIN LATERAL (SELECT 1 AS item_id) l ON true LEFT JOIN public.items i ON i.id = l.item_id WHERE u.id = 42",
    ])
      expect(check(sql).lines).toEqual([]);
  });

  it("reads no missing join into a JOIN ... ON it cannot link", () => {
    for (const sql of [
      "SELECT m.body FROM public.messages m JOIN public.users u ON u.id = m.sender_id OR u.id = m.recipient_id WHERE m.thread_id = 5",
      "SELECT u.email FROM public.users u JOIN public.orders o ON o.id = (SELECT max(o2.id) FROM public.orders o2 WHERE o2.user_id = u.id) WHERE u.id = 42",
      "SELECT * FROM public.a JOIN public.b ON true WHERE a.id = 1",
    ])
      expect(check(sql).lines).toEqual([]);
  });

  it("sizes an explicit CROSS JOIN over every group, and stays silent when a size is unknown", () => {
    const sql = "SELECT * FROM public.a CROSS JOIN public.b CROSS JOIN public.c";
    const hundred = facts({
      "public.a": { rows: 100 },
      "public.b": { rows: 100 },
      "public.c": { rows: 100 },
    });
    expect(check(sql, hundred).lines).toEqual([
      "CROSS JOIN pairs every row of `a` with every row of `b`",
    ]);
    expect(check(sql).lines).toEqual([]);
  });

  it("leaves LATERAL, table functions and unmodelled statements incomplete", () => {
    expect(
      check("SELECT * FROM public.a, LATERAL (SELECT 1 FROM public.b WHERE b.a_id = a.id) x")
        .complete,
    ).toBe(false);
    expect(check("SELECT * FROM generate_series(1, 10) g").complete).toBe(false);
    expect(check("TRUNCATE public.t").complete).toBe(false);
  });

  it("makes no claim on REINDEX INDEX or on an ALTER that is not ALTER TABLE", () => {
    for (const sql of [
      "REINDEX INDEX public.t_pkey",
      "ALTER SEQUENCE public.orders_id_seq RESTART WITH 1000",
    ])
      expect(check(sql).lines).toEqual([]);
  });
});

describe("no false alert on bounded queries", () => {
  const BIG_ROWS = 2_000_000;
  const big = facts({
    "public.a": { rows: BIG_ROWS },
    "public.b": { rows: BIG_ROWS },
    "public.t": { rows: BIG_ROWS },
  });

  it("counts USING columns as a condition on both sides, like ON", () => {
    expect(
      check("SELECT a.id FROM public.a a JOIN public.b b USING (id) WHERE b.id = 7", big).lines,
    ).toEqual([]);
    expect(
      check("SELECT a.id FROM public.a a JOIN public.b b USING (ref) WHERE b.id = 7", big).lines,
    ).toEqual(["Filter on `ref` uses no index and may scan all of `a`"]);
  });

  it("lets the enclosing query filter or preview a derived table or CTE", () => {
    for (const sql of [
      "SELECT p.id FROM (SELECT id FROM public.t) p WHERE p.id = 7",
      "WITH p AS (SELECT id FROM public.t) SELECT id FROM p WHERE id = 7",
      "SELECT * FROM (SELECT * FROM public.t) p LIMIT 10",
    ])
      expect(check(sql, big).lines).toEqual([]);
    // Nothing filters the CTE, so it is still read in full.
    expect(check("WITH p AS (SELECT * FROM public.t) SELECT count(*) FROM p", big).lines).toEqual([
      "Reads every row of `t` without a `WHERE` clause",
    ]);
  });

  it("binds a column-list alias to its source", () => {
    expect(check("SELECT * FROM (SELECT * FROM public.t) p(x) WHERE p.x = 7", big).lines).toEqual(
      [],
    );
  });

  it("reads WHERE FALSE and WHERE 1 = 0 as reading nothing, also through AND or a wrapper", () => {
    for (const sql of [
      "SELECT * FROM public.t WHERE FALSE",
      "SELECT id FROM public.t WHERE 1 = 0",
      "UPDATE public.t SET x = 1 WHERE FALSE",
      "SELECT * FROM public.t WHERE FALSE AND status = 'x'",
      "SELECT * FROM (SELECT * FROM public.t) p WHERE FALSE",
    ])
      expect(check(sql, big).lines).toEqual([]);
  });

  it("reads two different numbers or booleans as reading nothing, never a string or a cast", () => {
    for (const sql of [
      "SELECT * FROM public.t WHERE 1.5 = 2.5",
      "SELECT * FROM public.t WHERE true = false",
    ])
      expect(check(sql, big).lines, sql).toEqual([]);
    // PostgreSQL types each string as the other side ('1' is 1, 'true' is true), and a collation
    // may equate two spellings: the table is read.
    for (const sql of [
      "SELECT * FROM public.t WHERE '1' = 1",
      "SELECT * FROM public.t WHERE 'true' = true",
      "SELECT * FROM public.t WHERE 'false' = false",
      "SELECT * FROM public.t WHERE 'a' = 'b'",
      "UPDATE public.t SET x = 1 WHERE 'true' = true",
    ])
      expect(check(sql, big).lines, sql).toHaveLength(1);
  });

  it("reads an aliased join as one source the enclosing query filters, however nested", () => {
    for (const sql of [
      "SELECT * FROM (public.a JOIN public.b USING (id)) j, public.c WHERE j.id = c.id AND c.id = 1",
      "SELECT * FROM ((public.a JOIN public.b USING (id)) j JOIN public.c USING (id)) k WHERE k.id = 1",
      "SELECT * FROM ((public.a NATURAL JOIN public.b) j NATURAL JOIN public.c) k WHERE k.id = 1",
      "SELECT * FROM (SELECT * FROM (SELECT * FROM public.t) x) y WHERE y.id = 1",
    ])
      expect(check(sql, big).lines, sql).toEqual([]);
    expect(check("SELECT * FROM (public.a JOIN public.b USING (id)) j", big).lines).toEqual([
      "Reads every row of `a` since no condition filters it",
      "Reads every row of `b` since no condition filters it",
    ]);
  });

  it("never lets an outer filter bound what must be read in full first", () => {
    for (const sql of [
      "WITH r AS (SELECT count(*) AS n FROM public.t) SELECT * FROM (SELECT * FROM r) y WHERE y.n = 1",
      "WITH r AS (SELECT id, count(*) OVER () AS n FROM public.t) SELECT * FROM (SELECT * FROM r) y WHERE y.id = 1",
      "SELECT * FROM (SELECT count(*) AS n FROM public.t) y WHERE y.n = 1",
      "SELECT * FROM (SELECT DISTINCT id FROM public.t) y WHERE y.id = 1",
      // PostgreSQL computes a materialized CTE, or one used twice, before filtering it.
      "WITH r AS MATERIALIZED (SELECT * FROM public.t) SELECT * FROM r WHERE id = 1",
      "WITH r AS (SELECT * FROM public.t) SELECT * FROM r WHERE id = 1 UNION ALL SELECT * FROM r WHERE id = 2",
    ])
      expect(check(sql, big).lines, sql).toEqual([
        "Reads every row of `t` without a `WHERE` clause",
      ]);
    expect(
      check(
        "WITH r AS NOT MATERIALIZED (SELECT * FROM public.t) SELECT * FROM r WHERE id = 1 UNION ALL SELECT * FROM r WHERE id = 2",
        big,
      ).lines,
    ).toEqual([]);
  });

  it("lets each bound through only where PostgreSQL carries it", () => {
    const indexed = facts({
      "public.t": { rows: BIG_ROWS, leading: new Set(["id", "created_at"]) },
    });
    // An enclosing LIMIT stops at a plain inner LIMIT; WHERE FALSE runs nothing below it.
    for (const sql of [
      "SELECT * FROM (SELECT * FROM public.t LIMIT 10000) y LIMIT 10",
      "SELECT * FROM (SELECT count(*) AS n FROM public.t) y WHERE false",
      "SELECT * FROM (SELECT * FROM public.t LIMIT 10000) y WHERE false",
      "WITH r AS (SELECT * FROM public.t ORDER BY created_at) SELECT * FROM (SELECT * FROM r) y LIMIT 10",
    ])
      expect(check(sql, indexed).lines, sql).toEqual([]);
    // Without an index on the order, the first rows need the whole input sorted.
    expect(
      check(
        "WITH r AS (SELECT * FROM public.t ORDER BY x) SELECT * FROM (SELECT * FROM r) y LIMIT 10",
        indexed,
      ).lines,
    ).toEqual(["Reads every row of `t` without a `WHERE` clause"]);
    // A small LIMIT stops a join of streaming inputs early, cross products included.
    expect(
      check(
        "SELECT * FROM (SELECT * FROM (SELECT * FROM public.a) aa CROSS JOIN (SELECT * FROM public.b) bb) y LIMIT 10",
        big,
      ).lines,
    ).toEqual([]);
    // A write runs in full whatever reads its rows.
    expect(
      check("WITH d AS (DELETE FROM public.t RETURNING id) SELECT * FROM d WHERE false").lines,
    ).toEqual(["DELETE without WHERE removes every row of `t`"]);
  });

  it("lets a UNION ALL's own small LIMIT stop each side, never through a sort or deduplication", () => {
    const union = "SELECT id FROM public.a WHERE id = 1 UNION ALL SELECT id FROM public.b";
    for (const sql of [
      `${union} LIMIT 10`,
      `SELECT * FROM (${union} LIMIT 10) y`,
      `WITH r AS (${union} LIMIT 10) SELECT * FROM r`,
    ])
      expect(check(sql, big).lines, sql).toEqual([]);
    for (const sql of [
      "SELECT id FROM public.a WHERE id = 1 UNION SELECT id FROM public.b LIMIT 10",
      `${union} ORDER BY id LIMIT 10`,
    ])
      expect(check(sql, big).lines, sql).toEqual([
        "Reads every row of `b` without a `WHERE` clause",
      ]);
  });

  it("bounds each side of a set operation by its own LIMIT only", () => {
    expect(
      check(
        "(SELECT id FROM public.a WHERE id = 1) UNION ALL (SELECT id FROM public.b LIMIT 10)",
        big,
      ).lines,
    ).toEqual([]);
    expect(
      check("SELECT * FROM public.a UNION ALL (SELECT * FROM public.b LIMIT 10)", big).lines,
    ).toEqual(["Reads every row of `a` without a `WHERE` clause"]);
  });

  it("stops at the traversal bounds, set operations and aliased joins included", () => {
    let joins = "public.t t0";
    for (let i = 1; i <= 70; i++) joins = `(${joins} JOIN public.t t${i} USING (id)) j${i}`;
    for (const sql of [
      Array.from({ length: 70 }, () => "SELECT id FROM public.t").join(" UNION ALL "),
      `SELECT * FROM ${joins}`,
    ]) {
      const plan = planLoad(sql, "postgresql");
      expect(plan.covered).toBe(false);
      expect(plan.blocks.length).toBeLessThanOrEqual(65);
    }
  });

  it("reads TABLESAMPLE SYSTEM as a fraction of the pages, BERNOULLI as all of them", () => {
    expect(check("SELECT * FROM public.t TABLESAMPLE SYSTEM (1)", big).lines).toEqual([]);
    expect(check("SELECT * FROM public.t TABLESAMPLE BERNOULLI (1)", big).lines).toHaveLength(1);
  });
});

describe("joins without a filter", () => {
  const BIG_ROWS = 40_000_000;
  const f = facts({
    "public.orders": { rows: BIG_ROWS, indexed: new Set(["id", "customer_id"]) },
    "public.customers": { rows: 50_000, indexed: new Set(["id"]) },
  });

  it("reads every row of a large table joined without any filter", () => {
    const sql =
      "SELECT c.country, count(*) FROM public.orders o JOIN public.customers c ON c.id = o.customer_id GROUP BY c.country";
    expect(check(sql, f).lines).toEqual([
      "Reads every row of `orders` since no condition filters it",
    ]);
  });

  it("stays silent once one side is filtered, or with a small LIMIT and no order", () => {
    for (const sql of [
      "SELECT o.id FROM public.orders o JOIN public.customers c ON c.id = o.customer_id WHERE c.id = 5",
      "SELECT o.id FROM public.orders o JOIN public.customers c ON c.id = o.customer_id LIMIT 10",
    ])
      expect(check(sql, f).lines).toEqual([]);
  });

  it("lets a VALUES list, derived table or CTE bound the join, the index rule judging it", () => {
    for (const sql of [
      "SELECT o.id FROM public.orders o JOIN (VALUES (7), (8)) AS k(id) ON o.id = k.id",
      "SELECT o.id FROM public.orders o JOIN (SELECT 7 AS id) k ON o.id = k.id",
      "WITH r AS (SELECT 7 AS order_id) SELECT o.id FROM public.orders o JOIN r ON r.order_id = o.id",
      "UPDATE public.orders o SET status = v.status FROM (VALUES (1, 'paid')) AS v(id, status) WHERE o.id = v.id",
    ])
      expect(check(sql, f).lines).toEqual([]);
    expect(
      check("SELECT o.id FROM public.orders o JOIN (VALUES ('x')) AS k(ref) ON o.ref = k.ref", f)
        .lines,
    ).toEqual(["Filter on `ref` uses no index and may scan all of `orders`"]);
  });

  it("lets a small table, or a mid-sized one through a unique column, drive the lookups", () => {
    const g = facts({
      "public.users": { rows: 5_000_000 },
      "public.admins": { rows: 30 },
      "public.customers": { rows: 50_000 },
    });
    for (const sql of [
      "SELECT a.role, u.email FROM public.admins a JOIN public.users u ON u.id = a.user_id",
      "SELECT c.name, u.email FROM public.customers c JOIN public.users u ON u.id = c.user_id",
    ])
      expect(check(sql, g).lines).toEqual([]);
    // Without a unique column, a mid-sized table reaches most rows of the large one.
    expect(
      check("SELECT c.name FROM public.customers c JOIN public.users u ON u.team_id = c.id", g)
        .lines,
    ).toEqual(["Reads every row of `users` since no condition filters it"]);
  });

  it("exempts the newest rows of a join read in index order, and the lookups they drive", () => {
    const g = facts({
      "public.orders": {
        rows: BIG_ROWS,
        indexed: new Set(["id", "customer_id", "created_at"]),
        leading: new Set(["id", "created_at"]),
        columns: ["id", "customer_id", "created_at"],
      },
      "public.customers": { rows: 5_000_000, columns: ["id", "name"] },
    });
    for (const sql of [
      "SELECT o.id, c.name FROM public.orders o JOIN public.customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 20",
      "SELECT o.id, c.name FROM public.orders o LEFT JOIN public.customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 20",
      "SELECT o.id, c.name FROM public.orders o JOIN public.customers c ON c.id = o.customer_id ORDER BY created_at DESC LIMIT 20",
    ])
      expect(check(sql, g).lines).toEqual([]);
  });

  it("exempts a small LIMIT over a join whatever bounds its members", () => {
    const g = facts({ "public.users": { rows: 5_000_000 }, "public.roles": { rows: 10 } });
    const sql =
      "SELECT u.email, r.name FROM public.users u JOIN public.roles r ON r.id = u.role_id LIMIT 50";
    expect(check(sql, g).lines).toEqual([]);
  });

  it("lets a staging table bound a write through a composite key", () => {
    const g = facts({
      "public.users": {
        rows: 40_000_000,
        indexed: new Set(["tenant_id", "id"]),
        unique: [["tenant_id", "id"]],
      },
      "public.staging": { rows: 2_000 },
    });
    const sql =
      "UPDATE public.users u SET status = s.status FROM public.staging s WHERE u.tenant_id = s.tenant_id AND u.id = s.id";
    expect(check(sql, g).lines).toEqual([]);
    expect(
      check(
        "UPDATE public.users u SET status = s.status FROM public.staging s WHERE u.tenant_id = s.tenant_id",
        g,
      ).lines,
    ).toEqual(["UPDATE may change every row of `users` since no condition filters it"]);
  });

  it("lets a function of literals bound the join, like a VALUES list", () => {
    const g = facts({
      "public.users": { rows: 5_000_000, indexed: new Set(["id", "created_at"]) },
    });
    for (const sql of [
      "UPDATE public.users u SET plan = v.plan FROM unnest(ARRAY[1, 2], ARRAY['a', 'b']) AS v(id, plan) WHERE u.id = v.id",
      "SELECT d.day, count(u.id) FROM generate_series('2026-10-01'::date, '2026-10-07'::date, interval '1 day') AS d(day) LEFT JOIN public.users u ON u.created_at >= d.day AND u.created_at < d.day + interval '1 day' GROUP BY d.day",
    ])
      expect(check(sql, g).lines).toEqual([]);
  });

  it("still reads in full a table a function explodes, and keeps the join forgotten before it", () => {
    const g = facts({ "public.events": { rows: BIG_ROWS } });
    for (const sql of [
      "SELECT x FROM public.events e, jsonb_array_elements(e.payload) x",
      "SELECT DISTINCT k FROM public.events e, jsonb_array_elements(e.payload->'items') AS i(item), jsonb_object_keys(i.item) AS k",
    ])
      expect(check(sql, g).lines).toEqual([
        "Reads every row of `events` since no condition filters it",
      ]);
    // Exploding a mid-sized table bounds the join no more than that table does.
    const sales = facts({
      "public.products": { rows: 50_000 },
      "public.order_items": { rows: 30_000_000, indexed: new Set(["id", "product_id"]) },
    });
    expect(
      check(
        "SELECT cat, sum(oi.amount) FROM public.products p, unnest(p.categories) AS cat, public.order_items oi WHERE oi.product_id = p.id GROUP BY cat",
        sales,
      ).lines,
    ).toEqual(["Reads every row of `order_items` since no condition filters it"]);
    expect(
      check(
        "SELECT o.id FROM public.orders o, public.customers c, jsonb_array_elements(o.items) i WHERE o.id = 42",
      ).lines,
    ).toEqual(["Missing join condition pairs every row of `o` with every row of `c`"]);
  });

  it("separates a typed note from the hints", () => {
    expect(agentMessage("wrong table", ["The DELETE has no WHERE clause."])).toBe(
      "wrong table. The DELETE has no WHERE clause.",
    );
    expect(agentMessage("wrong table", [])).toBe("wrong table");
  });
});

describe("index-served reads", () => {
  const f = facts({ "public.t": { rows: 41_000_000 } });

  it("exempts an ORDER BY or min/max on the leading column of an index", () => {
    for (const sql of [
      "SELECT * FROM public.t ORDER BY id DESC LIMIT 20",
      "SELECT * FROM public.t ORDER BY id DESC LIMIT 20 OFFSET 20",
      "SELECT * FROM public.t WHERE TRUE ORDER BY id DESC LIMIT 20",
      "SELECT * FROM public.t ORDER BY id DESC FETCH FIRST 20 ROWS ONLY",
      "SELECT max(id) FROM public.t WHERE 1::integer = 1::integer",
      "SELECT * FROM public.t WHERE 1::integer = 1::integer LIMIT 10",
      "SELECT * FROM public.t WHERE 1.0 = 1.00 LIMIT 10",
      "SELECT max(id) FROM public.t",
      "SELECT max(id) FROM public.t WHERE 1 = 1",
      "SELECT min(id), max(id) FROM public.t",
    ])
      expect(check(sql, f).lines).toEqual([]);
  });

  it("still flags an order or min/max no index leads, a deep page, a window or row security", () => {
    const g = facts({
      "public.t": {
        rows: 41_000_000,
        indexed: new Set(["id", "status"]),
        leading: new Set(["id"]),
      },
    });
    for (const sql of [
      "SELECT * FROM public.t ORDER BY status LIMIT 20",
      "SELECT max(status) FROM public.t",
      "SELECT * FROM public.t ORDER BY id DESC",
      "SELECT * FROM public.t ORDER BY id DESC LIMIT 20 OFFSET 5000",
      "SELECT max(id) OVER () FROM public.t",
      "SELECT max(id) FILTER (WHERE status = 'paid') FROM public.t",
      // Ties with the tenth row come back too: ten caps nothing.
      "SELECT * FROM public.t ORDER BY id FETCH FIRST 10 ROWS WITH TIES",
    ])
      expect(check(sql, g).lines).toHaveLength(1);
    const rls = facts({ "public.t": { rows: 41_000_000, rls: true } });
    expect(check("SELECT max(id) FROM public.t", rls).lines).toHaveLength(1);
  });

  it("makes no claim on an index-served read when the index list is unavailable", () => {
    const g = facts({
      "public.t": { rows: 41_000_000, indexed: null, leading: null, unique: null },
    });
    const r = check("SELECT * FROM public.t ORDER BY id DESC LIMIT 20", g);
    expect(r.lines).toEqual([]);
    expect(r.complete).toBe(false);
  });
});

describe("estimates tied to one relation", () => {
  it("ties no estimate to a reference two relations share, even when only one has a size", () => {
    const f = facts({ "a.b": { rows: 41_000_000 } });
    const r = check('SELECT * FROM a.b UNION ALL SELECT * FROM "a.b"', f);
    expect(r.lines).toContain("Reads every row of `b` without a `WHERE` clause");
    expect(r.estimates).toEqual([]);
    const plan = planLoad('SELECT * FROM a.b UNION ALL SELECT * FROM "a.b"', "postgresql");
    const raw = checkLoad(plan, f);
    expect(raw.lines.flat().some((s) => typeof s !== "string" && s.ref)).toBe(false);
  });

  it("tags a table it names with its reference, and a keyword as a keyword", () => {
    const r = checkLoad(
      planLoad("SELECT * FROM public.big", "postgresql"),
      facts({ "public.big": { rows: 41_000_000 } }),
    );
    expect(r.lines[0]).toEqual([
      "Reads every row of ",
      { code: "big", ref: "public.big" },
      " without a ",
      { code: "WHERE", kw: true },
      " clause",
    ]);
  });
});
