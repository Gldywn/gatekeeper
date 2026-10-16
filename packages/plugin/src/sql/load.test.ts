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
      inherited: false,
      indexed: new Set(["id"]),
      primaryKey: ["id"],
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

  it("leaves a statement the parser rejects incomplete, never clean", () => {
    // node-sql-parser 5.4 rejects RETURNING inside a PostgreSQL CTE.
    const r = check("WITH d AS (DELETE FROM public.t RETURNING id) SELECT id FROM d");
    expect(r.lines).toEqual([]);
    expect(r.complete).toBe(false);
  });

  it("flags a large write not pinned to its primary key", () => {
    const f = facts({ "public.payment_intent": { rows: 18_400_000 } });
    const sql = `UPDATE public.payment_intent SET status = 'EXPIRED' WHERE "updatedAt" < now()`;
    const r = check(sql, f);
    expect(r.lines).toEqual([
      "UPDATE is not limited to primary key values and may change every row of `payment_intent`",
      "Filter on `updatedAt` uses no index and may scan all of `payment_intent`",
    ]);
    expect(r.estimates).toEqual([{ table: "payment_intent", rows: 18_400_000 }]);
    expect(r.heavy).toBe(true);
  });

  it("accepts a write pinned by literal primary key values", () => {
    const f = facts({ "public.t": { rows: BIG } });
    expect(check("UPDATE public.t SET a = 1 WHERE id = 7", f).lines).toEqual([]);
    expect(check("DELETE FROM public.t WHERE id IN (1, 2)", f).lines).toEqual([]);
    expect(check("DELETE FROM public.t WHERE id = 7 OR a = 1", f).lines).toEqual([
      "DELETE is not limited to primary key values and may remove every row of `t`",
    ]);
    expect(check("DELETE FROM public.t WHERE id > 7", f).lines).toHaveLength(1);
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
    expect(r.estimates).toEqual([{ table: "payment_attempt", rows: BIG }]);
    expect(r.complete).toBe(true);
  });

  it("exempts a small unfiltered preview, but not with an offset, an order, an aggregate or RLS", () => {
    expect(check("SELECT * FROM public.payment_attempt LIMIT 50", f).lines).toEqual([]);
    for (const sql of [
      "SELECT * FROM public.payment_attempt LIMIT 50 OFFSET 10",
      "SELECT * FROM public.payment_attempt ORDER BY id LIMIT 50",
      "SELECT count(*) FROM public.payment_attempt LIMIT 50",
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
          primaryKey: null,
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

  it("applies no size rule outside PostgreSQL", () => {
    const r = check("SELECT * FROM payment_attempt", f, "mysql");
    expect(r.lines).toEqual([]);
    expect(r.complete).toBe(true);
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
    // The 5.4 grammar swallows a comma after JOIN ... ON into the ON clause.
    expect(check("SELECT * FROM public.a JOIN public.b ON a.id = b.a_id, public.c").complete).toBe(
      false,
    );
  });

  it("flags an explicit CROSS JOIN only when both sizes make it large", () => {
    const sql = "SELECT * FROM public.a CROSS JOIN public.b";
    expect(check(sql).lines).toEqual([]);
    const big = facts({ "public.a": { rows: 5_000 }, "public.b": { rows: 5_000 } });
    expect(check(sql, big).lines).toHaveLength(1);
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

  it("reads the commands the parser does not know", () => {
    expect(check("VACUUM FULL public.big", f).lines).toEqual([
      "VACUUM FULL locks and rewrites `big`",
    ]);
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

  it("marks a classic inheritance parent, not a partitioned one", () => {
    expect(
      parseLoadStats(
        rels,
        row([
          ["r", 10, 0],
          ["r", 10, 0],
        ]),
      )?.[0].inherited,
    ).toBe(true);
    expect(
      parseLoadStats(
        rels,
        row(
          [
            ["p", -1, 0],
            ["r", 10, 0],
          ],
          "p",
        ),
      )?.[0].inherited,
    ).toBe(false);
    expect(parseLoadStats(rels, row([["r", 10, 0]]))?.[0].inherited).toBe(false);
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
    const view = check(
      sql,
      facts({ "public.t": { rows: null, kind: "view", indexed: null, primaryKey: null } }),
    );
    expect(view.notes).toEqual(["`t` is a view with no row estimate"]);
    expect(check(sql, facts({ "public.t": { rows: BIG_ROWS, rls: null } })).lines).toHaveLength(1);
    expect(check(sql, facts({ "public.t": { rows: BIG_ROWS } })).complete).toBe(true);
  });

  it("never exempts a write on a classic inheritance parent through its key", () => {
    const f = facts({ "public.t": { rows: BIG_ROWS, inherited: true } });
    expect(check("UPDATE public.t SET a = 1 WHERE id = 7", f).lines).toEqual([
      "UPDATE is not limited to primary key values and may change every row of `t`",
    ]);
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

  it("links two sources through any condition naming both, never through an OR", () => {
    for (const sql of [
      "SELECT * FROM public.s, public.e WHERE e.ts BETWEEN s.start_at AND s.end_at AND s.id = 3",
      "SELECT * FROM public.a JOIN public.b ON b.id IN (a.x, a.y)",
      "SELECT * FROM public.a JOIN public.b ON st_dwithin(a.geom, b.geom, 100)",
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

  it("reads WHERE FALSE and WHERE 1 = 0 as reading nothing", () => {
    for (const sql of [
      "SELECT * FROM public.t WHERE FALSE",
      "SELECT id FROM public.t WHERE 1 = 0",
      "UPDATE public.t SET x = 1 WHERE FALSE",
    ])
      expect(check(sql, big).lines).toEqual([]);
  });

  it("pins a primary key written either way round", () => {
    expect(check("UPDATE public.t SET x = 1 WHERE 7 = id", big).lines).toEqual([]);
    expect(check("DELETE FROM public.t WHERE 7 = id", big).lines).toEqual([]);
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

  it("binds a column-list alias to its source", () => {
    const sql =
      "SELECT o.id FROM public.orders o, (VALUES (1, 'a')) AS v(id, label) WHERE o.customer_id = v.id AND o.id = 3";
    expect(check(sql, f).lines).toEqual([]);
  });

  it("separates a typed note from the hints", () => {
    expect(agentMessage("wrong table", ["The DELETE has no WHERE clause."])).toBe(
      "wrong table. The DELETE has no WHERE clause.",
    );
    expect(agentMessage("wrong table", [])).toBe("wrong table");
  });
});
