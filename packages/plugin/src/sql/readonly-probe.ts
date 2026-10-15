import type { RunQueryResult } from "@beekeeperstudio/plugin";

// Stays host-side and is never sent to the agent; it only tones the read-only layers.
export interface EndpointReadOnly {
  // A physical read replica (e.g. an Aurora reader), or a server explicitly set read-only,
  // that rejects writes server-side.
  replica: boolean;
  // The session is read-only (transaction_read_only = on).
  sessionReadOnly: boolean;
}

// The driver's error stays local: it explains a failed check in the popover, never reaches
// the broker.
export type ProbeOutcome = { readOnly: EndpointReadOnly } | { error: string };

type RunQuery = (sql: string) => Promise<RunQueryResult>;

export function runErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Query execution failed";
}

// Drivers may return a real boolean or "t"/"true"/1; anything else is false so an
// unrecognised value never gets read as "read-only".
function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

async function firstRow(
  run: RunQuery,
  sql: string,
): Promise<{ row: Record<string, unknown> } | { error: string }> {
  const result = await run(sql);
  if (result.error) {
    return { error: runErrorText(result.error) };
  }
  const row = result.results[0]?.rows[0];
  return row ? { row } : { error: "The check returned no row" };
}

async function probePostgres(run: RunQuery): Promise<ProbeOutcome> {
  const r = await firstRow(
    run,
    "SELECT pg_is_in_recovery() AS replica, current_setting('transaction_read_only') = 'on' AS session_read_only",
  );
  if ("error" in r) return r;
  return {
    readOnly: { replica: asBool(r.row.replica), sessionReadOnly: asBool(r.row.session_read_only) },
  };
}

// read_only alone: super_read_only forces it on anyway, and MariaDB (even under Beekeeper's
// MySQL type) and MySQL before 5.7.8 lack super_read_only, which would fail every check.
async function probeMysql(run: RunQuery): Promise<ProbeOutcome> {
  const r = await firstRow(run, "SELECT @@global.read_only AS read_only");
  if ("error" in r) return r;
  return { readOnly: { replica: asBool(r.row.read_only), sessionReadOnly: false } };
}

// Keyed by Beekeeper's raw databaseType, never the parser dialect: mapDialect() folds every
// engine it does not know into "postgresql", which would send this SQL to Oracle or ClickHouse.
const PROBES: Record<string, (run: RunQuery) => Promise<ProbeOutcome>> = {
  postgresql: probePostgres,
  mysql: probeMysql,
  mariadb: probeMysql,
};

export function hasProbe(databaseType: string): boolean {
  return Object.hasOwn(PROBES, databaseType);
}

// Host-side (not the approval gate); null means this engine has no check.
export async function probeReadOnly(
  databaseType: string,
  run: RunQuery,
): Promise<ProbeOutcome | null> {
  if (!hasProbe(databaseType)) {
    return null;
  }
  try {
    return await PROBES[databaseType](run);
  } catch (err) {
    return { error: runErrorText(err) };
  }
}
