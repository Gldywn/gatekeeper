import { connectionScopeKey } from "../connection.js";
import { getConnection } from "./connection.js";
import { OPEN_STATES, type StoreContext } from "./db.js";
import { type SessionRow, toSessionMeta } from "./rows.js";
import type { SessionMeta, SessionRoster } from "./types.js";

/** Record or refresh an agent session's identity (harness, project) for grouping. */
export function upsertSession(
  ctx: StoreContext,
  input: {
    sessionId: string;
    harness?: string | null;
    harnessVersion?: string | null;
    project?: string | null;
  },
): void {
  const now = ctx.now();
  const conn = getConnection(ctx);
  const connection = conn ? connectionScopeKey(conn) : null;
  ctx.db
    .prepare(
      `INSERT INTO sessions (session_id, harness, harness_version, project, created_at, last_seen, last_active, connection, left_at)
         VALUES (@session_id, @harness, @harness_version, @project, @now, @now, @now, @connection, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           harness = COALESCE(excluded.harness, sessions.harness),
           harness_version = COALESCE(excluded.harness_version, sessions.harness_version),
           project = COALESCE(excluded.project, sessions.project),
           last_seen = excluded.last_seen,
           last_active = excluded.last_active,
           connection = COALESCE(excluded.connection, sessions.connection),
           left_at = NULL`,
    )
    .run({
      session_id: input.sessionId,
      harness: input.harness ?? null,
      harness_version: input.harnessVersion ?? null,
      project: input.project ?? null,
      connection,
      now,
    });
}

/** Presence ping: keep last_seen fresh while the agent's stdio pipe is open. */
export function heartbeatSession(ctx: StoreContext, sessionId: string): void {
  // Liveness only: never re-tag the session's connection here, or a passive
  // agent would be dragged onto whatever connection Beekeeper currently shows.
  ctx.db
    .prepare("UPDATE sessions SET last_seen = ? WHERE session_id = ?")
    .run(ctx.now(), sessionId);
}

/** Record a clean disconnect so the roster shows the agent as gone at once. */
export function markSessionLeft(ctx: StoreContext, sessionId: string): void {
  ctx.db.prepare("UPDATE sessions SET left_at = ? WHERE session_id = ?").run(ctx.now(), sessionId);
}

/** An agent-set, session-level label shown in the roster (the task at hand). */
export function setSessionLabel(ctx: StoreContext, sessionId: string, label: string): void {
  ctx.db
    .prepare("UPDATE sessions SET session_label = ? WHERE session_id = ?")
    .run(label, sessionId);
}

/** Sessions for a connection, each with its count of still-open requests. */
export function listSessions(ctx: StoreContext, connection: string | null): SessionRoster[] {
  // Idle past the TTL (on last action, or last_seen if it never acted) drops
  // from the roster; it returns on its next action.
  const idleCutoff = ctx.now() - ctx.rosterIdleTtl;
  // Scope pending_count to the queried connection so it matches what claimNext
  // would actually offer there, not the session's total across connections.
  const rows = ctx.db
    .prepare(
      `SELECT s.*,
           (SELECT count(*) FROM requests r
              WHERE r.session_id = s.session_id AND r.state IN ${OPEN_STATES}
                AND (r.connection IS NULL OR r.connection = @connection)) AS pending_count,
           (SELECT r2.intent FROM requests r2
              WHERE r2.session_id = s.session_id
                AND (r2.connection IS NULL OR r2.connection = @connection)
              ORDER BY r2.created_at DESC LIMIT 1) AS last_intent
         FROM sessions s
         WHERE (s.connection IS NULL OR s.connection = @connection)
           AND COALESCE(s.last_active, s.last_seen) >= @idleCutoff
           AND s.session_label IS NOT NULL AND trim(s.session_label) != ''
         ORDER BY s.created_at ASC`,
    )
    .all({ connection, idleCutoff }) as (SessionRow & {
    pending_count: number;
    last_intent: string | null;
  })[];
  return rows.map((row) => ({
    ...toSessionMeta(row),
    pendingCount: row.pending_count,
    lastIntent: row.last_intent,
  }));
}

export function getSession(ctx: StoreContext, sessionId: string): SessionMeta | null {
  const row = ctx.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
    | SessionRow
    | undefined;
  return row ? toSessionMeta(row) : null;
}
