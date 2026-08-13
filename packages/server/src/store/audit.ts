import type { StoreContext } from "./db.js";
import { outcomeFacts, type RawAudit, toAudit } from "./rows.js";
import type { ActivityEntry, AuditEntry, RequestState } from "./types.js";

export function logAudit(
  ctx: StoreContext,
  entry: {
    requestId: string;
    event: string;
    fromState?: string | null;
    toState: string;
    sessionId?: string | null;
    pluginId?: string | null;
    sqlDigest?: string | null;
    detail?: string | null;
  },
): void {
  ctx.db
    .prepare(
      `INSERT INTO audit (ts, request_id, event, from_state, to_state, session_id, plugin_id, sql_digest, detail)
         VALUES (@ts, @request_id, @event, @from_state, @to_state, @session_id, @plugin_id, @sql_digest, @detail)`,
    )
    .run({
      ts: ctx.now(),
      request_id: entry.requestId,
      event: entry.event,
      from_state: entry.fromState ?? null,
      to_state: entry.toState,
      session_id: entry.sessionId ?? null,
      plugin_id: entry.pluginId ?? null,
      sql_digest: entry.sqlDigest ?? null,
      detail: entry.detail ?? null,
    });
}

/** Read the append-only audit trail, optionally scoped to one request. */
export function readAudit(ctx: StoreContext, requestId?: string): AuditEntry[] {
  const rows = requestId
    ? ctx.db.prepare("SELECT * FROM audit WHERE request_id = ? ORDER BY id ASC").all(requestId)
    : ctx.db.prepare("SELECT * FROM audit ORDER BY id ASC").all();
  return (rows as RawAudit[]).map(toAudit);
}

/** Terminal requests for a connection, newest first, for the host-side activity
 *  view. Each entry carries the SQL and metadata plus scalar outcome facts
 *  (reason / error / row count) from result_json, but never the result rows. */
export function listActivity(
  ctx: StoreContext,
  connection: string | null,
  limit = 200,
): ActivityEntry[] {
  const rows = ctx.db
    .prepare(
      `SELECT r.id, r.created_at, r.decided_at, r.session_id, r.sql, r.intent, r.state, r.result_json,
           s.harness, s.project, s.session_label
         FROM requests r
         LEFT JOIN sessions s ON s.session_id = r.session_id
         WHERE r.decided_at IS NOT NULL
           AND (r.connection IS NULL OR r.connection = @connection)
         ORDER BY r.decided_at DESC, r.id DESC
         LIMIT @limit`,
    )
    .all({ connection, limit }) as {
    id: string;
    created_at: number;
    decided_at: number | null;
    session_id: string;
    sql: string;
    intent: string | null;
    state: RequestState;
    result_json: string | null;
    harness: string | null;
    project: string | null;
    session_label: string | null;
  }[];
  return rows.map((row) => {
    const facts = outcomeFacts(row.state, row.result_json);
    return {
      id: row.id,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      sessionId: row.session_id,
      harness: row.harness,
      project: row.project,
      sessionLabel: row.session_label,
      sql: row.sql,
      intent: row.intent,
      state: row.state,
      reason: facts.reason,
      error: facts.error,
      rowCount: facts.rowCount,
    };
  });
}
