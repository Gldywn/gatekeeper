import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  planRead,
  readMetadataSql,
  readSearchPathSql,
  resolveRead,
  searchPathVerified,
} from "../read-analysis";
import { ACCEPTANCE_QUERIES } from "./catalog-fixture";

// The only check against a real PostgreSQL catalog. Nothing here connects to a database:
// an operator captures the rows through Gatekeeper from the synthetic test database
// (docs/AUTO-MODE.md, "Real catalog check") and points GK_REAL_CATALOG at the saved JSON.
const captured = process.env.GK_REAL_CATALOG;

function plan(sql: string) {
  const result = planRead(sql, "postgresql");
  if (typeof result === "string") throw new Error(result);
  return result;
}

describe("real catalog capture instructions", () => {
  it.runIf(process.env.GK_REAL_CATALOG_PRINT)("prints the catalog-only SQL to submit", () => {
    const statements = [
      ["searchPath", readSearchPathSql()],
      ...Object.entries(ACCEPTANCE_QUERIES).map(([id, sql]) => [id, readMetadataSql(plan(sql))]),
    ];
    for (const [id, sql] of statements) console.log(`-- ${id}\n${sql};\n`);
    expect(statements).toHaveLength(3);
  });
});

describe.runIf(captured)("real PostgreSQL catalog captured from test-db/auto-catalog", () => {
  type Capture = {
    variant: "fixture" | "negative";
    searchPath: Record<string, unknown>[];
    attempts: Record<string, unknown>[];
    statuses: Record<string, unknown>[];
  };
  // Read inside each test: describe bodies are collected even when the suite is skipped.
  const load = (): Capture => JSON.parse(readFileSync(String(captured), "utf8"));
  it("verifies the search path before the catalog query", () => {
    const rows = load();
    expect(searchPathVerified(rows.searchPath)).toBe(true);
  });
  it("resolves both acceptance queries as the fixture variant expects", () => {
    const rows = load();
    const attempts = resolveRead(plan(ACCEPTANCE_QUERIES.attempts), rows.attempts);
    const statuses = resolveRead(plan(ACCEPTANCE_QUERIES.statuses), rows.statuses);
    if (rows.variant === "fixture") {
      expect(attempts.reasons).toEqual([]);
      expect(statuses.reasons).toEqual([]);
    } else {
      expect(attempts.reasons[0]).toMatch(
        /Custom function or operator needs manual review: array_agg/,
      );
      expect(statuses.reasons[0]).toMatch(/RLS/);
    }
  });
});
