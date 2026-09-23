import { preparePgSql } from "./pg/syntax";

export type PreparedSql = ReturnType<typeof preparePgSql>;

// Only PostgreSQL needs quoting adapted before node-sql-parser sees it. Other dialects
// keep their text unchanged, so shared callers never depend on PostgreSQL internals.
export function prepareSql(sql: string, dialect: string): PreparedSql {
  if (dialect === "postgresql") return preparePgSql(sql);
  return {
    sql,
    ordinaryBackslash: false,
    name: (v) => v,
    restoreSql: (v) => v,
    restoreAst: (v) => v,
  };
}
