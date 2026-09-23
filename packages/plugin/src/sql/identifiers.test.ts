import { describe, expect, it } from "vitest";
import { classifyQuery } from "./classify";
import { prepareSql } from "./identifiers";
import { identifierLiteral, validIdentifier } from "./pg/syntax";
import { analyzeSql, analyzeTableOps, sensitiveLiterals } from "./schema";
import { parser } from "./sql-parser";

describe("PostgreSQL identifier parser contract", () => {
  it("represents ordered array aggregation and text formatting explicitly", () => {
    const ast = parser.astify(
      "SELECT array_agg(kind || ':' || amount::text ORDER BY kind) AS attempts FROM public.attempts",
      { database: "postgresql" },
    );
    expect(ast).toMatchObject({
      columns: [
        {
          expr: {
            type: "aggr_func",
            name: "ARRAY_AGG",
            args: {
              expr: { type: "binary_expr", operator: "||" },
              orderby: [{ expr: { type: "column_ref" } }],
            },
          },
        },
      ],
    });
  });
  it("preserves JSON function arguments and extraction paths", () => {
    const ast = parser.astify(
      "SELECT jsonb_typeof(metadata), jsonb_exists(metadata, 'levels'), metadata #>> '{levels,PVID}', jsonb_typeof(metadata -> 'lastIdentification') FROM public.records",
      { database: "postgresql" },
    );
    expect(ast).toMatchObject({
      columns: [
        { expr: { type: "function", name: { name: [{ value: "jsonb_typeof" }] } } },
        {
          expr: {
            type: "function",
            args: {
              value: [{ type: "column_ref" }, { type: "single_quote_string", value: "levels" }],
            },
          },
        },
        { expr: { type: "binary_expr", operator: "#>>", right: { value: "{levels,PVID}" } } },
        { expr: { type: "function", args: { value: [{ type: "binary_expr", operator: "->" }] } } },
      ],
    });
  });
  it("represents EXISTS as an existence check", () => {
    const ast = parser.astify(
      "SELECT o.quantity FROM public.orders o WHERE EXISTS (SELECT 1 FROM public.attempts o WHERE o.order_id = 1)",
      { database: "postgresql" },
    ) as unknown as { where: unknown };
    expect(ast.where).toMatchObject({
      type: "function",
      name: { name: [{ type: "default", value: "EXISTS" }] },
      args: { type: "expr_list", value: [{ ast: { type: "select" } }] },
    });
  });
  it.each([
    "SELECT count(*) FILTER (WHERE created_at > 0) FROM public.orders",
    "SELECT created_at FROM public.orders WHERE created_at >= timestamptz '2026-01-01 00:00:00+00'",
    "SELECT min(created_at)::date FROM public.orders",
    "SELECT o.id FROM public.orders o WHERE NOT EXISTS (SELECT 1 FROM public.attempts t WHERE t.order_id = o.id)",
  ])("parses reporting read syntax: %s", (sql) => {
    expect(() =>
      parser.astify(prepareSql(sql, "postgresql").sql, { database: "postgresql" }),
    ).not.toThrow();
  });
  it("represents reporting expressions explicitly", () => {
    const ast = parser.astify(
      "SELECT count(*) FILTER (WHERE created_at >= CAST('2026-01-01 00:00:00+00' AS TIMESTAMPTZ)), min(created_at)::date FROM public.orders o WHERE NOT EXISTS (SELECT 1 FROM public.attempts t WHERE t.order_id = o.id)",
      { database: "postgresql" },
    );
    expect(ast).toMatchObject({
      columns: [
        { expr: { type: "aggr_func", filter: { keyword: "filter" } } },
        { expr: { type: "cast", target: [{ dataType: "DATE" }] } },
      ],
      where: { type: "unary_expr", operator: "NOT EXISTS", expr: { ast: { type: "select" } } },
    });
  });
  it.each([
    [
      'SELECT "P"."createdAt" AS "Created On" FROM "Sales"."Products" AS "P"',
      "Sales",
      "Products",
      "P",
      "createdAt",
      "Created On",
    ],
    [
      "SELECT P.CreatedAt AS CreatedOn FROM Sales.Products AS P",
      "sales",
      "products",
      "p",
      "createdat",
      "createdon",
    ],
    [
      'SELECT "a""b"."créé le" AS "x""y" FROM "s""c"."t""b" AS "a""b"',
      's"c',
      't"b',
      'a"b',
      "créé le",
      'x"y',
    ],
  ])("preserves PostgreSQL names: %s", (sql, schema, table, alias, column, output) => {
    const input = prepareSql(sql, "postgresql");
    const ast = input.restoreAst(parser.astify(input.sql, { database: "postgresql" }));
    expect(ast).toMatchObject({
      from: [{ db: schema, table, as: alias }],
      columns: [
        {
          expr: { type: "column_ref", table: alias, column: { expr: { value: column } } },
          as: output,
        },
      ],
    });
    const serialized = input.restoreSql(
      parser.sqlify(parser.astify(input.sql, { database: "postgresql" }) as never, {
        database: "postgresql",
      }),
    );
    const again = prepareSql(serialized, "postgresql");
    expect(again.restoreAst(parser.astify(again.sql, { database: "postgresql" }))).toEqual(ast);
  });
  it("keeps strings, dollar strings and nested comments separate from identifiers", () => {
    const input = prepareSql(
      `SELECT "createdAt" FROM Public.Products /* "ignored" /* inner */ end */ WHERE code = 'MiXeD "value"' AND other = $tag$UPPER "value"$tag$ -- "ignored"\r; DELETE FROM public.products`,
      "postgresql",
    );
    expect(input.sql).toContain(`'MiXeD "value"'`);
    expect(input.sql).toContain('$tag$UPPER "value"$tag$');
    expect(input.sql).not.toContain("ignored");
    expect(input.sql).toContain("delete from public.products");
    expect(
      classifyQuery(
        'SELECT "createdAt" FROM public.products -- comment\r; DELETE FROM public.products',
      ).blocked,
    ).toBe(true);
  });
  it.each([
    ['UPDATE "Sales"."t""b" SET "createdAt" = NULL', "write"],
    ['DELETE FROM "Sales"."t""b"', "destructive"],
    ['SELECT "createdAt" INTO "Sales"."t""b" FROM public.products', "destructive"],
    ['WITH gone AS (DELETE FROM "Sales"."t""b" RETURNING *) SELECT * FROM gone', "destructive"],
  ])("preserves execution classification: %s", (sql, risk) => {
    expect(classifyQuery(sql).class).toBe(risk);
  });
  it("restores names for shared display and sensitive-literal checks", () => {
    expect(
      analyzeSql('SELECT "Email", "a::b" AS "Contact Email" FROM "s::c"."t""b"', "postgresql"),
    ).toMatchObject({
      tables: [{ schema: "s::c", name: 't"b' }],
      columns: ["Email", "a::b"],
      aliases: ["Contact Email"],
      star: false,
    });
    expect(
      analyzeTableOps('UPDATE "S"."t""b" SET "CreatedAt" = NULL', "postgresql")?.writes,
    ).toEqual(['S.t"b']);
    expect(
      sensitiveLiterals(
        `SELECT "id" FROM "S"."t""b" WHERE "Company Name" = 'Synthetic Co'`,
        "postgresql",
      ),
    ).toEqual(["Synthetic Co"]);
  });
  it("avoids collisions with real names and values", () => {
    const input = prepareSql(
      `SELECT "gkquoted_0", gkquoted__0 FROM public.products WHERE code = 'gkquoted___0'`,
      "postgresql",
    );
    const ast = parser.astify(input.sql, { database: "postgresql" });
    const result = input.restoreSql(parser.sqlify(ast as never, { database: "postgresql" }));
    expect(result).toContain('"gkquoted_0"');
    expect(result).toContain("gkquoted__0");
    expect(result).toContain("'gkquoted___0'");
  });
  it("bounds decoded names by PostgreSQL bytes and escapes metadata literals", () => {
    expect(validIdentifier("é".repeat(31))).toBe(true);
    expect(validIdentifier("é".repeat(32))).toBe(false);
    expect(validIdentifier("x\0")).toBe(false);
    expect(identifierLiteral("a\\'; DROP TABLE t; --")).toBe("E'a\\\\''; DROP TABLE t; --'");
  });
  it.each([
    'SELECT "unterminated',
    'SELECT "" FROM public.products',
    'SELECT "x\0" FROM public.products',
    "SELECT 1 /* unfinished",
    "SELECT 'unfinished",
    "SELECT $$unfinished",
    'SELECT U&"d\\0061t" FROM public.products',
  ])("does not authorize syntax the adapter cannot preserve: %s", (sql) =>
    expect(classifyQuery(sql).parseOk).toBe(false),
  );
});
