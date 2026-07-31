import type { RunQueryResult } from "@beekeeperstudio/plugin";

// Stays host-side and is never sent to the agent; it only tones the header badge.
export interface EndpointReadOnly {
  // A physical read replica (e.g. an Aurora reader) that rejects writes server-side.
  replica: boolean;
  // The session is read-only (transaction_read_only = on).
  sessionReadOnly: boolean;
}

type RunQuery = (sql: string) => Promise<RunQueryResult>;

// Drivers may return a real boolean or "t"/"true"/1; anything else is false so an
// unrecognised value never gets read as "read-only".
function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

async function probePostgres(run: RunQuery): Promise<EndpointReadOnly | null> {
  const result = await run(
    "SELECT pg_is_in_recovery() AS replica, current_setting('transaction_read_only') = 'on' AS session_read_only",
  );
  if (result.error) {
    return null;
  }
  const row = result.results[0]?.rows[0];
  if (!row) {
    return null;
  }
  return {
    replica: asBool(row.replica),
    sessionReadOnly: asBool(row.session_read_only),
  };
}

// Keyed by dialect so MySQL etc. can be added later; an absent dialect resolves to
// null ("not verified"), never "writable".
const PROBES: Record<string, (run: RunQuery) => Promise<EndpointReadOnly | null>> = {
  postgresql: probePostgres,
};

// Host-side (not the approval gate); null means "not verified", the safe default
// for a non-implemented dialect or any error.
export async function probeReadOnly(
  dialect: string,
  run: RunQuery,
): Promise<EndpointReadOnly | null> {
  const probe = PROBES[dialect];
  if (!probe) {
    return null;
  }
  try {
    return await probe(run);
  } catch {
    return null;
  }
}
