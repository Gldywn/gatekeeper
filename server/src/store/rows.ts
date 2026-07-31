import type { AuditEntry, GatekeeperRequest, RequestState, SessionMeta } from "./types.js";

export interface RawRow {
  id: string;
  created_at: number;
  session_id: string;
  sql: string;
  intent: string | null;
  idempotency_key: string | null;
  state: RequestState;
  lease_id: string | null;
  lease_expires_at: number | null;
  plugin_id: string | null;
  decided_at: number | null;
  result_json: string | null;
  policy_json: string | null;
  expires_at: number;
  connection: string | null;
}

export interface SessionRow {
  session_id: string;
  harness: string | null;
  harness_version: string | null;
  project: string | null;
  created_at: number;
  last_seen: number;
  last_active: number | null;
  connection: string | null;
  left_at: number | null;
  session_label: string | null;
}

export interface RawAudit {
  id: number;
  ts: number;
  request_id: string;
  event: string;
  from_state: string | null;
  to_state: string;
  session_id: string | null;
  plugin_id: string | null;
  sql_digest: string | null;
  detail: string | null;
}

export function toRequest(raw: RawRow): GatekeeperRequest {
  return {
    id: raw.id,
    createdAt: raw.created_at,
    sessionId: raw.session_id,
    sql: raw.sql,
    intent: raw.intent,
    idempotencyKey: raw.idempotency_key,
    state: raw.state,
    leaseId: raw.lease_id,
    leaseExpiresAt: raw.lease_expires_at,
    pluginId: raw.plugin_id,
    decidedAt: raw.decided_at,
    result: raw.result_json === null ? null : JSON.parse(raw.result_json),
    policy: raw.policy_json === null ? null : JSON.parse(raw.policy_json),
    expiresAt: raw.expires_at,
    connection: raw.connection,
  };
}

export function toSessionMeta(row: SessionRow): SessionMeta {
  return {
    sessionId: row.session_id,
    harness: row.harness,
    harnessVersion: row.harness_version,
    project: row.project,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    // Rows created before the presence columns fall back to last_seen.
    lastActive: row.last_active ?? row.last_seen,
    connection: row.connection,
    leftAt: row.left_at,
    sessionLabel: row.session_label,
  };
}

export function toAudit(raw: RawAudit): AuditEntry {
  return {
    id: raw.id,
    ts: raw.ts,
    requestId: raw.request_id,
    event: raw.event,
    fromState: raw.from_state,
    toState: raw.to_state,
    sessionId: raw.session_id,
    pluginId: raw.plugin_id,
    sqlDigest: raw.sql_digest,
    detail: raw.detail,
  };
}

// Pull ONLY scalar outcome facts from a stored result: the rejection reason, the
// failure error, or an approved row *count*. It never returns row contents, so the
// activity feed can explain an outcome without ever surfacing the data it read.
export function outcomeFacts(
  state: RequestState,
  resultJson: string | null,
): { reason: string | null; error: string | null; rowCount: number | null } {
  const facts: { reason: string | null; error: string | null; rowCount: number | null } = {
    reason: null,
    error: null,
    rowCount: null,
  };
  if (resultJson === null) {
    return facts;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return facts;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return facts;
  }
  const result = parsed as Record<string, unknown>;
  if (state === "rejected") {
    facts.reason = typeof result.reason === "string" ? result.reason : null;
  } else if (state === "failed") {
    facts.error = typeof result.error === "string" ? result.error : null;
  } else if (state === "approved") {
    // A scalar count only: the array length, never its elements.
    facts.rowCount = Array.isArray(result.rows) ? result.rows.length : null;
  }
  return facts;
}
