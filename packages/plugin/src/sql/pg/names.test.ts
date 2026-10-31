import { describe, expect, it } from "vitest";
import { classifyQuery } from "../classify";
import { analyzeSql, analyzeTableOps, sensitiveLiterals } from "../inspect";
import { planRead } from "../read-analysis";
import { identifierLiteral, validIdentifier } from "./catalog";

describe("PostgreSQL names on its own grammar", () => {
  it("folds unquoted names and keeps quoted ones as written", () => {
    expect(
      analyzeSql(
        `SELECT "createdAt" FROM Public.Products /* "ignored" /* inner */ end */ WHERE code = 'MiXeD "value"' AND other = $tag$UPPER "value"$tag$`,
        "postgresql",
      ),
    ).toMatchObject({
      tables: [{ schema: "public", name: "products" }],
      columns: ["createdAt", "code", "other"],
    });
  });
  it("reads doubled quotes and separators inside quoted names", () => {
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
  it("blocks a second statement hidden behind a comment line ending", () => {
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
  ])("classifies quoted names: %s", (sql, risk) => {
    expect(classifyQuery(sql).class).toBe(risk);
  });
  it("bounds names by PostgreSQL bytes and escapes metadata literals", () => {
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
  ])("does not authorize text PostgreSQL rejects: %s", (sql) =>
    expect(classifyQuery(sql).parseOk).toBe(false),
  );
  it("reads a Unicode-escaped name at the gate but keeps it out of Auto", () => {
    const sql = 'SELECT U&"d\\0061t" FROM public.products';
    expect(classifyQuery(sql)).toEqual({ class: "read", parseOk: true, blocked: false });
    expect(typeof planRead(sql, "postgresql")).toBe("string");
  });
});
