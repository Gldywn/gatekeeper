import { classifyQuery } from "./classify";

// A thin shim over the risk classifier so existing call sites and tests stay put:
// read-only means a read-class statement that is not blocked (multi-statement, etc.).
export function isReadOnlyQuery(sql: string, databaseType = "postgresql"): boolean {
  const v = classifyQuery(sql, databaseType);
  return v.class === "read" && !v.blocked;
}
