import { engineFor } from "./engine";
import type { ParsedQuery, Receipt, TableOps } from "./schema";

// What the connection's engine reads in a statement. Null (or empty) when it cannot read it,
// so callers skip the annotation rather than show something wrong.
export function analyzeSql(sql: string, databaseType: string): ParsedQuery | null {
  return engineFor(databaseType).analyze(sql);
}

export function analyzeTableOps(sql: string, databaseType: string): TableOps | null {
  return engineFor(databaseType).tableOps(sql);
}

export function sensitiveLiterals(sql: string, databaseType: string): string[] {
  return engineFor(databaseType).sensitiveLiterals(sql);
}

export function statementReceipt(sql: string, databaseType: string): Receipt | null {
  return engineFor(databaseType).receipt(sql);
}

// A driver's affected count measures rows only for a statement that changes rows: DDL reports a
// conventional zero. SQL the engine cannot read is judged by its leading verb.
export function countsRows(sql: string, databaseType: string): boolean {
  const counted = engineFor(databaseType).countsRows(sql);
  if (counted !== null) return counted;
  const bare = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  return /^\s*(insert|update|delete|replace|merge)\b/i.test(bare);
}
