import type { EvaluationInput } from "@gatekeeper/shared";
import { classifyQuery } from "./classify";
import { catalogFirst, SEARCH_PATH_SQL } from "./pg/catalog";
import { type PgReadPlan, pgMetadataSql, planPg, resolvePg } from "./pg/plan";
import { preparePgSql } from "./pg/syntax";
import { analyzeSql, sensitiveLiterals, sensitiveReference } from "./schema";

export { sensitiveReference };
export type ReadPlan = PgReadPlan;
export interface ReadSnapshot {
  complete: boolean;
  reasons: string[];
  input?: EvaluationInput;
}

/** Shared read analysis, independent of activation and display preferences. */
export function planRead(sql: string, dialect: string): ReadPlan | string {
  // Auto mode is PostgreSQL only: other dialects never reach catalog SQL.
  if (dialect !== "postgresql") return "Auto mode beta supports PostgreSQL only";
  if (sql.length > 12000) return "Query exceeds the automatic evaluation budget";
  const verdict = classifyQuery(sql, dialect);
  if (!verdict.parseOk || verdict.blocked || verdict.class !== "read")
    return "A parsed single read is required";
  const parsed = analyzeSql(sql, dialect);
  if (!parsed) return "Unresolved SQL dependencies";
  if (sensitiveLiterals(sql, dialect).length) return "Sensitive input stays on this machine";
  // Relation names describe context, not selected values. Jev receives that context.
  for (const name of [...parsed.columns, ...parsed.jsonKeys]) {
    if (sensitiveReference(name)) return `Sensitive source or alias: ${name}`;
  }
  // The parser can locate this literal, but its value depends on the live PG setting.
  if (preparePgSql(sql).ordinaryBackslash) return "String escape semantics require manual review";
  return planPg(sql);
}

// Metadata runs in two catalog-only steps: the search path is verified before any query
// whose unqualified operators could otherwise resolve to custom code.
export const readSearchPathSql = (): string => SEARCH_PATH_SQL;
export const searchPathVerified = catalogFirst;

export function readMetadataSql(plan: ReadPlan): string {
  return pgMetadataSql(plan);
}

export function resolveRead(plan: ReadPlan, rows: Record<string, unknown>[]): ReadSnapshot {
  return resolvePg(plan, rows);
}
