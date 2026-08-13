import { classifyQuery, rank } from "./classify";

// The armed access mode. Ephemeral (in-memory only): it resets to "read" on load
// and on a connection switch, and is never persisted.
export type RiskMode = "read" | "write" | "destructive";

const MODE_RANK: Record<RiskMode, number> = { read: 0, write: 1, destructive: 2 };

export function modeRank(mode: RiskMode): number {
  return MODE_RANK[mode];
}

// Whether the armed mode may approve this query: never a blocked (multi-statement,
// unparseable) one, and only up to the mode's own risk rank.
export function isApprovable(sql: string, dialect: string, mode: RiskMode): boolean {
  const v = classifyQuery(sql, dialect);
  return !v.blocked && rank(v.class) <= modeRank(mode);
}
