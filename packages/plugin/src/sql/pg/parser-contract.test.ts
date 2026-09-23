import { describe, expect, it } from "vitest";
import { parser } from "../sql-parser";

// The read walker accepts only node shapes pinned here. A parser upgrade that changes one
// must fail this file before it can change an analysis.
function column(sql: string): unknown {
  const ast = parser.astify(`SELECT ${sql} FROM public.t`, {
    database: "postgresql",
  }) as unknown as {
    columns: { expr: unknown }[];
  };
  return ast.columns[0].expr;
}
function select(sql: string): Record<string, unknown> {
  return parser.astify(sql, { database: "postgresql" }) as never;
}
const ref = (name: string) => ({ type: "column_ref", column: { expr: { value: name } } });

describe("node-sql-parser PostgreSQL read shapes", () => {
  it("represents window functions and window aggregates with an inline specification", () => {
    expect(column("row_number() OVER (PARTITION BY a ORDER BY b)")).toMatchObject({
      type: "window_func",
      name: "row_number",
      over: {
        type: "window",
        as_window_specification: {
          window_specification: {
            partitionby: [{ type: "expr", expr: ref("a") }],
            orderby: [{ expr: ref("b") }],
            window_frame_clause: null,
          },
        },
      },
    });
    expect(column("sum(c) OVER (PARTITION BY a)")).toMatchObject({
      type: "aggr_func",
      name: "SUM",
    });
  });
  it("keeps frames and named windows outside the modelled shapes", () => {
    expect(
      column("lag(a, 1) OVER (ORDER BY a ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)"),
    ).toMatchObject({
      over: {
        as_window_specification: {
          window_specification: { window_frame_clause: { type: "binary_expr" } },
        },
      },
    });
    expect(select("SELECT a FROM public.t WINDOW w AS (ORDER BY a)").window).toMatchObject({
      type: "window",
    });
  });
  it("represents CASE, casts, typed and numeric literals", () => {
    expect(column("CASE a WHEN 1 THEN 2 ELSE 3 END")).toMatchObject({
      type: "case",
      expr: ref("a"),
      args: [{ type: "when", cond: { type: "number" } }, { type: "else" }],
    });
    expect(column("a::text")).toMatchObject({
      type: "cast",
      symbol: "::",
      target: [{ dataType: "TEXT" }],
    });
    expect(column("CAST(a AS numeric(10,2))")).toMatchObject({
      target: [{ dataType: "NUMERIC", length: 10, scale: 2 }],
    });
    expect(column("1.0")).toEqual({ type: "number", value: "1.0" });
    expect(column("2")).toEqual({ type: "number", value: 2 });
    expect(column("date '2026-01-01'")).toEqual({ type: "date", value: "2026-01-01" });
    expect(column("interval '1 day'")).toMatchObject({
      type: "interval",
      unit: "",
      expr: { type: "single_quote_string", value: "1 day" },
    });
  });
  it("misreads a quoted cast type, which the walker must refuse", () => {
    expect(column('a::"int4"')).toMatchObject({
      type: "cast",
      target: [{ dataType: "INT", length: 4, quoted: '"' }],
    });
  });
  it("represents CTEs, derived tables and scalar or IN subqueries", () => {
    const ast = select(
      "WITH x AS (SELECT a FROM public.t) SELECT (SELECT max(a) FROM x) AS m, d.a FROM (SELECT a FROM public.t) d WHERE d.a IN (SELECT a FROM x)",
    );
    expect(ast).toMatchObject({
      with: [{ name: { value: "x" }, stmt: { type: "select" } }],
      columns: [{ expr: { ast: { type: "select" } } }, {}],
      from: [{ as: "d", expr: { ast: { type: "select" } } }],
      where: { operator: "IN", right: { type: "expr_list", value: [{ ast: { type: "select" } }] } },
    });
    expect(select("WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x").with).toMatchObject([
      { recursive: true },
    ]);
    expect(select("SELECT a FROM public.t UNION SELECT a FROM public.t")).toMatchObject({
      set_op: "union",
    });
    expect(select("SELECT a FROM public.t, LATERAL (SELECT 1) l").from).toMatchObject([
      {},
      { prefix: "LATERAL" },
    ]);
  });
  it("chains set operations left to right and keeps the trailing ORDER BY on the last branch", () => {
    const ast = select(
      "SELECT a FROM public.t UNION ALL SELECT a FROM public.d UNION ALL SELECT a FROM public.e ORDER BY a LIMIT 5",
    );
    expect(ast).toMatchObject({
      set_op: "union all",
      orderby: null,
      _next: {
        set_op: "union all",
        orderby: null,
        _next: { orderby: [{ expr: ref("a") }], limit: { value: [{ value: 5 }] } },
      },
    });
    expect(select("SELECT a FROM public.t INTERSECT SELECT a FROM public.d")).toMatchObject({
      set_op: "intersect",
    });
    expect(() => select("SELECT a FROM public.t INTERSECT ALL SELECT a FROM public.d")).toThrow();
    expect(() => select("SELECT a FROM public.t EXCEPT ALL SELECT a FROM public.d")).toThrow();
  });
  it("turns a parenthesized set operation branch into a FROM item the walker refuses", () => {
    expect(
      select("SELECT a FROM public.t UNION ALL (SELECT a FROM public.d ORDER BY a LIMIT 1)").from,
    ).toMatchObject([{}, { join: "union all", expr: { ast: { type: "select" } } }]);
  });
  it("represents clock keywords, EXTRACT and schema-qualified calls", () => {
    expect(column("current_date")).toMatchObject({
      type: "function",
      name: { name: [{ type: "origin", value: "CURRENT_DATE" }] },
    });
    expect(column("extract(year from a)")).toMatchObject({
      type: "extract",
      args: { field: "year", source: ref("a") },
    });
    expect(column("pg_catalog.lower(a)")).toMatchObject({
      type: "function",
      name: { name: [{ value: "lower" }], schema: { value: "pg_catalog" } },
    });
  });
  it("represents aggregate modifiers explicitly", () => {
    expect(column("string_agg(a, ',' ORDER BY a)")).toMatchObject({
      type: "aggr_func",
      name: "STRING_AGG",
      args: { orderby: [{ expr: ref("a") }], separator: { delimiter: { value: "," } } },
    });
    expect(column("count(DISTINCT a)")).toMatchObject({ args: { distinct: "DISTINCT" } });
    expect(column("count(*) FILTER (WHERE a > 1)")).toMatchObject({
      args: { expr: { type: "star" } },
      filter: { keyword: "filter", where: { type: "binary_expr" } },
    });
    expect(column("percentile_cont(0.5) WITHIN GROUP (ORDER BY a)")).toMatchObject({
      within_group_orderby: [{}],
    });
  });
  it("keeps unmodelled syntax as raw fragments or extra keys, which the walker refuses", () => {
    expect(column("a IS DISTINCT FROM b")).toMatchObject({
      operator: "IS",
      right: { value: 'DISTINCT FROM "b"' },
    });
    expect(column("a ILIKE 'x' ESCAPE '!'")).toMatchObject({
      right: { escape: { type: "ESCAPE" } },
    });
    expect(column("a[1]")).toMatchObject({ type: "column_ref", array_index: [{}] });
    expect(column("ARRAY[1,2]")).toMatchObject({ type: "array" });
    expect(select("SELECT a FROM public.t GROUP BY ROLLUP (a)").groupby).toMatchObject({
      columns: [{ type: "function", name: { name: [{ value: "ROLLUP" }] } }],
    });
    expect(select("SELECT DISTINCT ON (a) a FROM public.t").distinct).toMatchObject({
      type: "DISTINCT ON",
    });
  });
});
