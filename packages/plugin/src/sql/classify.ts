import { engineFor } from "./engine";
import { fallback, type RiskVerdict } from "./risk";

export { type RiskClass, type RiskVerdict, rank } from "./risk";

// The plugin is the only component that runs SQL, so the risk gate lives here: the
// connection engine's own parse when it can read the statement, else the strict text check.
export function classifyQuery(sql: string, databaseType = "postgresql"): RiskVerdict {
  return engineFor(databaseType).classify(sql) ?? fallback(sql);
}
