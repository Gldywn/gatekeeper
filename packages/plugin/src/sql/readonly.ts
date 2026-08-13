import { classifyQuery } from "./classify";

export { mapDialect } from "./sql-parser";

// A thin shim over the risk classifier so existing call sites and tests stay put:
// read-only means a read-class statement that is not blocked (multi-statement, etc.).
export function isReadOnlyQuery(sql: string, dialect = "postgresql"): boolean {
  const v = classifyQuery(sql, dialect);
  return v.class === "read" && !v.blocked;
}
