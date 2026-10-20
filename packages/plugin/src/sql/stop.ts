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

// What stopping needs, stated as a requirement when this connection does not meet it.
const STOP_NEEDS = {
  engine: "PostgreSQL or MySQL is required to stop a query.",
  postgres: "PostgreSQL 10 or later is required to stop a query.",
  mysql: "MySQL 8.0.19 or later is required to stop a query.",
  writable: "A writable connection is required to stop a MySQL query.",
};

// Why stopping is unavailable on this connection, or null when it is available.
export function stopUnavailable(
  databaseType: string,
  readOnly: boolean,
  serverVersion: string | null,
): string | null {
  if (databaseType === "postgresql")
    return postgresAtMin(serverVersion) ? null : STOP_NEEDS.postgres;
  if (databaseType !== "mysql") return STOP_NEEDS.engine;
  // MySQL can only cancel through KILL, which Beekeeper's read-only mode refuses.
  if (readOnly) return STOP_NEEDS.writable;
  return mysqlAtMin(serverVersion) ? null : STOP_NEEDS.mysql;
}

// The stop statement filters on pg_stat_activity.backend_type, which PostgreSQL 10 added; an
// unknown version cannot be shown to meet it.
function postgresAtMin(version: string | null): boolean {
  const m = version ? /^PostgreSQL (\d+)/.exec(version) : null;
  return m !== null && Number(m[1]) >= 10;
}

// MariaDB and TiDB answer as MySQL but are not the MySQL whose KILL behaviour this relies on.
function mysqlAtMin(version: string | null): boolean {
  if (!version || /mariadb|tidb/i.test(version)) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]) >= MYSQL_MIN;
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

// The note stopNote() wrote, split back into the stop line a human reads and the message the
// query ended with. It proves a stop was requested, not that it took effect.
export function parseStopNote(note: string): { stop: string; message: string } | null {
  const m = /^Stop requested by (.+?)\. The query then ended with: ([\s\S]*)$/.exec(note);
  if (!m) return null;
  const operator = /^the operator after (.+)$/.exec(m[1]);
  const limit = /^auto-stop (.+)$/.exec(m[1]);
  const stop = operator
    ? `Stop requested by you after ${operator[1]}.`
    : limit
      ? `Auto-stop requested ${limit[1]}.`
      : `Stop requested by ${m[1]}.`;
  return { stop, message: m[2] };
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
