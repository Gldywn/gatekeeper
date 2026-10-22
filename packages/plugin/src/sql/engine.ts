import { nspEngine } from "./nsp/engine";
import { pgEngine } from "./pg/engine";
import type { RiskVerdict } from "./risk";
import type { ParsedQuery, Receipt, TableOps } from "./schema";

// What the plugin needs from a SQL parser, whichever engine's grammar backs it. Each method
// answers from that engine's own parse and returns null (or empty) when it cannot read the
// statement; the shared callers decide what an unread statement means.
export interface SqlEngine {
  // The grammar the engine reads SQL with, shown on the connection chip.
  readonly dialect: string;
  classify(sql: string): RiskVerdict | null;
  analyze(sql: string): ParsedQuery | null;
  tableOps(sql: string): TableOps | null;
  sensitiveLiterals(sql: string): string[];
  receipt(sql: string): Receipt | null;
  countsRows(sql: string): boolean | null;
}

// The single place that maps Beekeeper's databaseType to a parser. Only a real PostgreSQL
// connection gets PostgreSQL's own grammar: Redshift or DuckDB merely look like it.
export function engineFor(databaseType: string): SqlEngine {
  return databaseType === "postgresql" ? pgEngine : nspEngine(databaseType);
}
