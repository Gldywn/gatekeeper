import type { RunQueryResult } from "@beekeeperstudio/plugin";
import type { RunState } from "../types";
import { runErrorText } from "./readonly-probe";

// Beekeeper's plugin API cannot cancel a runQuery, so a stop asks the database itself,
// through a second runQuery, to cancel the session whose current statement starts with
// the comment tag this execution was sent with. See SECURITY.md, "Stopping a running query".
export type StopEngine = "postgresql" | "mysql";

export type StopOutcome =
  | { kind: "sent" }
  | { kind: "notFound" }
  | { kind: "error"; message: string };

const REQUEST_ID = /^req_[0-9a-f]{12}$/;
const TAG = /^\/\* gatekeeper (req_[0-9a-f]{12} )?[0-9a-f]{12} \*\/$/;
// Older servers let a KILL QUERY that lands between statements interrupt the next one
// (MySQL bug #29969769, fixed in 8.0.19), which is exactly the collateral a stop must avoid.
const MYSQL_MIN = 8_000_019;

export function unavailableOn(what: string): string {
  return `This feature is not available on ${what}.`;
}

// Why stopping is unavailable on this connection, or null when it is available.
export function stopUnavailable(
  databaseType: string,
  displayName: string,
  readOnly: boolean,
  serverVersion: string | null,
): string | null {
  if (databaseType === "postgresql") {
    const server = postgresBelowMin(serverVersion);
    return server ? unavailableOn(server) : null;
  }
  if (databaseType !== "mysql") return unavailableOn(displayName);
  // MySQL can only cancel through KILL, which Beekeeper's read-only mode refuses.
  if (readOnly) return unavailableOn("read-only MySQL connections");
  const server = mysqlServerBelowMin(serverVersion);
  return server ? unavailableOn(server) : null;
}

// The stop statement filters on pg_stat_activity.backend_type, which PostgreSQL 10 added.
function postgresBelowMin(version: string | null): string | null {
  const m = version ? /^PostgreSQL (\d+)(\.\d+)?/.exec(version) : null;
  if (!m) return "this PostgreSQL server";
  return Number(m[1]) >= 10 ? null : `PostgreSQL ${m[1]}${m[2] ?? ""}`;
}

function mysqlServerBelowMin(version: string | null): string | null {
  if (version && /mariadb/i.test(version)) return "MariaDB";
  if (version && /tidb/i.test(version)) return "TiDB";
  const m = version ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  if (!m) return "this MySQL server";
  const n = Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
  return n >= MYSQL_MIN ? null : `MySQL ${m[0]}`;
}

// Fresh for every execution, so a stop can only ever match this execution's text.
export function newStopToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function stopTag(requestId: string, token: string): string {
  const id = REQUEST_ID.test(requestId) ? `${requestId} ` : "";
  return `/* gatekeeper ${id}${token} */`;
}

// One call to the database. PostgreSQL looks up and signals in a single statement, and
// signals only when exactly one session matches. MySQL has no cancel function, so the batch
// prepares KILL QUERY for the single match, or a no-op, in the same round trip.
export function stopStatement(engine: StopEngine, tag: string): string {
  if (!TAG.test(tag)) throw new Error("Invalid stop tag");
  if (engine === "postgresql") {
    // Parallel workers report the leader's query text, so only the client backend counts;
    // cancelling it stops its workers. usename is the login role, which SET ROLE leaves alone.
    return (
      "SELECT CASE WHEN count(*) = 1 THEN pg_cancel_backend(min(pid)) END AS sent, count(*) AS matches " +
      "FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active' " +
      `AND usename = session_user AND pid <> pg_backend_pid() AND left(query, ${tag.length}) = '${tag}'`
    );
  }
  return [
    "SELECT COUNT(*), MIN(ID) FROM information_schema.PROCESSLIST WHERE COMMAND = 'Query' " +
      "AND ID <> CONNECTION_ID() AND USER = SUBSTRING_INDEX(USER(), '@', 1) " +
      `AND LEFT(INFO, ${tag.length}) = '${tag}' INTO @gk_matches, @gk_target`,
    "SET @gk_stop := IF(@gk_matches = 1, CONCAT('KILL QUERY ', @gk_target), 'DO 0')",
    "PREPARE gk_stop FROM @gk_stop",
    "EXECUTE gk_stop",
    "DEALLOCATE PREPARE gk_stop",
    "SELECT @gk_matches AS matches",
    "SET @gk_matches := NULL, @gk_target := NULL, @gk_stop := NULL",
  ].join(";\n");
}

export function readStop(engine: StopEngine, result: RunQueryResult): StopOutcome {
  if (result.error) return { kind: "error", message: runErrorText(result.error) };
  const row = result.results.map((r) => r.rows[0]).find((r) => r && "matches" in r);
  const matches = Number(row?.matches);
  if (!row || !Number.isInteger(matches)) {
    return { kind: "error", message: "Unexpected answer to the stop request" };
  }
  if (matches === 0) return { kind: "notFound" };
  if (matches > 1) return { kind: "error", message: `${matches} running queries matched` };
  if (engine === "postgresql" && row.sent !== true) {
    return { kind: "error", message: "pg_cancel_backend returned false" };
  }
  return { kind: "sent" };
}

// States what happened without claiming the stop caused the error: "Stop requested" is the
// stable prefix the skill keys on, the rest is whatever the database returned.
export function stopNote(run: RunState | undefined, error: string): string {
  const stop = run?.stop;
  if (!run || !stop) return error;
  const who =
    stop.by === "limit"
      ? `auto-stop at the ${run.limitMs / 60_000} min limit set on this connection`
      : `the operator after ${duration(stop.atMs)}`;
  return `Stop requested by ${who}. The query then ended with: ${error}`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
