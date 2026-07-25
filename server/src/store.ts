import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";

export type RequestState =
  | "pending"
  | "leased"
  | "executing"
  | "approved"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

export type StoreErrorCode =
  | "QUEUE_FULL"
  | "NOT_FOUND"
  | "NOT_OWNER"
  | "LEASE_CONFLICT"
  | "INVALID_STATE";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    detail: string,
  ) {
    super(`[${code}] ${detail}`);
    this.name = "StoreError";
  }
}

export interface GatekeeperRequest {
  id: string;
  createdAt: number;
  sessionId: string;
  sql: string;
  intent: string | null;
  idempotencyKey: string | null;
  state: RequestState;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  pluginId: string | null;
  decidedAt: number | null;
  result: unknown;
  policy: unknown;
  expiresAt: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  requestId: string;
  event: string;
  fromState: string | null;
  toState: string;
  sessionId: string | null;
  pluginId: string | null;
  sqlDigest: string | null;
  detail: string | null;
}

export type Outcome =
  | { status: "approved"; rows: unknown[]; fields: unknown[] }
  | { status: "rejected"; reason?: string }
  | { status: "failed"; error: string };

export interface StoreOptions {
  /** File path, or omit for a private in-memory database (tests). */
  path?: string;
  /** Injectable clock so lease/TTL logic is deterministic under test. */
  now?: () => number;
  /** How long a pending proposal lives before it self-expires. */
  proposalTtlMs?: number;
  /** Cap on un-terminal proposals per session (backpressure). */
  maxPendingPerSession?: number;
  /** How long an approved result is retained before its rows are stripped. */
  resultTtlMs?: number;
}

interface RawRow {
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
}

const OPEN_STATES = "('pending','leased','executing')";

function token(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

// Store a digest, never the raw SQL, so the audit trail carries no PII.
function digest(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

interface RawAudit {
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

function toAudit(raw: RawAudit): AuditEntry {
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

function toRequest(raw: RawRow): GatekeeperRequest {
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
  };
}

export class RequestStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxPending: number;
  private readonly resultTtl: number;

  constructor(options: StoreOptions = {}) {
    this.db = new Database(options.path ?? ":memory:");
    this.db.pragma("foreign_keys = ON");
    // WAL is only meaningful for on-disk databases.
    if (options.path && options.path !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
    this.now = options.now ?? Date.now;
    this.ttl = options.proposalTtlMs ?? 15 * 60_000;
    this.maxPending = options.maxPendingPerSession ?? 32;
    this.resultTtl = options.resultTtlMs ?? 10 * 60_000;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        sql TEXT NOT NULL,
        intent TEXT,
        idempotency_key TEXT,
        state TEXT NOT NULL,
        lease_id TEXT,
        lease_expires_at INTEGER,
        plugin_id TEXT,
        decided_at INTEGER,
        result_json TEXT,
        policy_json TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requests_state ON requests(state, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_idem
        ON requests(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        event TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        session_id TEXT,
        plugin_id TEXT,
        sql_digest TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_request ON audit(request_id, id);
    `);
  }

  /** Enqueue a proposal, or return the existing one for a repeated idempotency key. */
  submit(input: {
    sessionId: string;
    sql: string;
    intent?: string;
    idempotencyKey?: string;
    policy?: unknown;
  }): GatekeeperRequest {
    this.sweep();

    if (input.idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM requests WHERE session_id = ? AND idempotency_key = ?")
        .get(input.sessionId, input.idempotencyKey) as RawRow | undefined;
      if (existing) {
        return toRequest(existing);
      }
    }

    const pending = this.db
      .prepare(
        `SELECT count(*) AS n FROM requests WHERE session_id = ? AND state IN ${OPEN_STATES}`,
      )
      .get(input.sessionId) as { n: number };
    if (pending.n >= this.maxPending) {
      throw new StoreError(
        "QUEUE_FULL",
        `Session has ${pending.n} open requests (max ${this.maxPending})`,
      );
    }

    const now = this.now();
    const row: RawRow = {
      id: token("req"),
      created_at: now,
      session_id: input.sessionId,
      sql: input.sql,
      intent: input.intent ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      state: "pending",
      lease_id: null,
      lease_expires_at: null,
      plugin_id: null,
      decided_at: null,
      result_json: null,
      policy_json: input.policy === undefined ? null : JSON.stringify(input.policy),
      expires_at: now + this.ttl,
    };
    this.db
      .prepare(
        `INSERT INTO requests
          (id, created_at, session_id, sql, intent, idempotency_key, state,
           lease_id, lease_expires_at, plugin_id, decided_at, result_json, policy_json, expires_at)
         VALUES
          (@id, @created_at, @session_id, @sql, @intent, @idempotency_key, @state,
           @lease_id, @lease_expires_at, @plugin_id, @decided_at, @result_json, @policy_json, @expires_at)`,
      )
      .run(row);
    this.logAudit({
      requestId: row.id,
      event: "submitted",
      toState: "pending",
      sessionId: row.session_id,
      sqlDigest: digest(row.sql),
    });
    return toRequest(row);
  }

  /** Claim the oldest pending proposal under a fresh lease (non-destructive). */
  claimNext(pluginId: string, leaseMs: number): GatekeeperRequest | null {
    const claim = this.db.transaction((): GatekeeperRequest | null => {
      this.sweep();
      const oldest = this.db
        .prepare("SELECT * FROM requests WHERE state = 'pending' ORDER BY created_at ASC LIMIT 1")
        .get() as RawRow | undefined;
      if (!oldest) {
        return null;
      }
      const now = this.now();
      const leaseId = token("lease");
      this.db
        .prepare(
          `UPDATE requests
             SET state = 'leased', lease_id = ?, lease_expires_at = ?, plugin_id = ?
           WHERE id = ?`,
        )
        .run(leaseId, now + leaseMs, pluginId, oldest.id);
      this.logAudit({
        requestId: oldest.id,
        event: "claimed",
        fromState: "pending",
        toState: "leased",
        pluginId,
      });
      return toRequest({
        ...oldest,
        state: "leased",
        lease_id: leaseId,
        lease_expires_at: now + leaseMs,
        plugin_id: pluginId,
      });
    });
    return claim();
  }

  /** Extend a held lease; the plugin calls this while a card stays open. */
  renewLease(id: string, leaseId: string, leaseMs: number): GatekeeperRequest {
    const row = this.requireLease(id, leaseId);
    const expires = this.now() + leaseMs;
    this.db.prepare("UPDATE requests SET lease_expires_at = ? WHERE id = ?").run(expires, id);
    return { ...row, leaseExpiresAt: expires };
  }

  /** Mark execution started (before runQuery) so a crash is recoverable. */
  markExecuting(id: string, leaseId: string): GatekeeperRequest {
    const row = this.requireLease(id, leaseId);
    if (row.state !== "leased") {
      throw new StoreError("INVALID_STATE", `Cannot execute from state ${row.state}`);
    }
    this.db.prepare("UPDATE requests SET state = 'executing' WHERE id = ?").run(id);
    this.logAudit({
      requestId: id,
      event: "executing",
      fromState: "leased",
      toState: "executing",
    });
    return { ...row, state: "executing" };
  }

  /** Resolve a leased/executing request to its terminal state. */
  resolve(id: string, leaseId: string, outcome: Outcome): GatekeeperRequest {
    const row = this.requireLease(id, leaseId);
    const state: RequestState =
      outcome.status === "approved"
        ? "approved"
        : outcome.status === "rejected"
          ? "rejected"
          : "failed";
    const result =
      outcome.status === "approved"
        ? { rows: outcome.rows, fields: outcome.fields }
        : outcome.status === "rejected"
          ? { reason: outcome.reason ?? null }
          : { error: outcome.error };
    const now = this.now();
    this.db
      .prepare(
        "UPDATE requests SET state = ?, result_json = ?, decided_at = ?, lease_id = NULL, lease_expires_at = NULL WHERE id = ?",
      )
      .run(state, JSON.stringify(result), now, id);
    this.logAudit({
      requestId: id,
      event: state,
      fromState: row.state,
      toState: state,
      detail:
        outcome.status === "approved"
          ? `${outcome.rows.length} rows`
          : outcome.status === "rejected"
            ? (outcome.reason ?? null)
            : outcome.error,
    });
    return { ...row, state, result, decidedAt: now, leaseId: null, leaseExpiresAt: null };
  }

  /** Withdraw a request the agent no longer wants (owner-checked). */
  cancel(id: string, sessionId: string): GatekeeperRequest {
    const row = this.getForSession(id, sessionId);
    if (row.state !== "pending" && row.state !== "leased") {
      throw new StoreError("INVALID_STATE", `Cannot cancel from state ${row.state}`);
    }
    const now = this.now();
    this.db
      .prepare(
        "UPDATE requests SET state = 'cancelled', decided_at = ?, lease_id = NULL, lease_expires_at = NULL WHERE id = ?",
      )
      .run(now, id);
    this.logAudit({
      requestId: id,
      event: "cancelled",
      fromState: row.state,
      toState: "cancelled",
    });
    return { ...row, state: "cancelled", decidedAt: now, leaseId: null, leaseExpiresAt: null };
  }

  get(id: string): GatekeeperRequest | null {
    const row = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as
      | RawRow
      | undefined;
    return row ? toRequest(row) : null;
  }

  getForSession(id: string, sessionId: string): GatekeeperRequest {
    const row = this.get(id);
    if (!row) {
      throw new StoreError("NOT_FOUND", `Unknown request ${id}`);
    }
    if (row.sessionId !== sessionId) {
      throw new StoreError("NOT_OWNER", `Request ${id} belongs to another session`);
    }
    return row;
  }

  // Expired leases return to pending; a lease that expired mid-execution fails
  // as execution_unknown, because the query may already have run.
  sweep(): void {
    const now = this.now();
    const reoffered = this.db
      .prepare(
        "UPDATE requests SET state = 'pending', lease_id = NULL, lease_expires_at = NULL, plugin_id = NULL WHERE state = 'leased' AND lease_expires_at < ? RETURNING id",
      )
      .all(now) as { id: string }[];
    for (const row of reoffered) {
      this.logAudit({
        requestId: row.id,
        event: "lease_expired",
        fromState: "leased",
        toState: "pending",
      });
    }
    const unknown = this.db
      .prepare(
        "UPDATE requests SET state = 'failed', result_json = ?, decided_at = ?, lease_id = NULL, lease_expires_at = NULL WHERE state = 'executing' AND lease_expires_at < ? RETURNING id",
      )
      .all(JSON.stringify({ error: "execution_unknown" }), now, now) as { id: string }[];
    for (const row of unknown) {
      this.logAudit({
        requestId: row.id,
        event: "execution_unknown",
        fromState: "executing",
        toState: "failed",
      });
    }
    const expired = this.db
      .prepare(
        "UPDATE requests SET state = 'expired', decided_at = ? WHERE state = 'pending' AND expires_at < ? RETURNING id",
      )
      .all(now, now) as { id: string }[];
    for (const row of expired) {
      this.logAudit({
        requestId: row.id,
        event: "expired",
        fromState: "pending",
        toState: "expired",
      });
    }
    // Strip approved result rows once their retention window passes. The audit
    // trail already recorded the decision and row count, so no PII lingers and
    // the request stays queryable as an approved-but-purged terminal.
    const stripped = this.db
      .prepare(
        `UPDATE requests SET result_json = ?
           WHERE state = 'approved' AND decided_at IS NOT NULL AND decided_at < ?
             AND result_json LIKE '{"rows":%' RETURNING id`,
      )
      .all(JSON.stringify({ purged: true }), now - this.resultTtl) as { id: string }[];
    for (const row of stripped) {
      this.logAudit({
        requestId: row.id,
        event: "result_purged",
        fromState: "approved",
        toState: "approved",
      });
    }
  }

  /** Read the append-only audit trail, optionally scoped to one request. */
  readAudit(requestId?: string): AuditEntry[] {
    const rows = requestId
      ? this.db.prepare("SELECT * FROM audit WHERE request_id = ? ORDER BY id ASC").all(requestId)
      : this.db.prepare("SELECT * FROM audit ORDER BY id ASC").all();
    return (rows as RawAudit[]).map(toAudit);
  }

  private logAudit(entry: {
    requestId: string;
    event: string;
    fromState?: string | null;
    toState: string;
    sessionId?: string | null;
    pluginId?: string | null;
    sqlDigest?: string | null;
    detail?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit (ts, request_id, event, from_state, to_state, session_id, plugin_id, sql_digest, detail)
         VALUES (@ts, @request_id, @event, @from_state, @to_state, @session_id, @plugin_id, @sql_digest, @detail)`,
      )
      .run({
        ts: this.now(),
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

  close(): void {
    this.db.close();
  }

  private requireLease(id: string, leaseId: string): GatekeeperRequest {
    const row = this.get(id);
    if (!row) {
      throw new StoreError("NOT_FOUND", `Unknown request ${id}`);
    }
    if (row.leaseId !== leaseId) {
      throw new StoreError("LEASE_CONFLICT", `Lease ${leaseId} does not hold request ${id}`);
    }
    // Refuse an expired lease even before the sweep re-offers it, so a stalled
    // holder cannot mark executing or resolve on a lease it has effectively lost.
    if (row.leaseExpiresAt !== null && row.leaseExpiresAt < this.now()) {
      throw new StoreError("LEASE_CONFLICT", `Lease ${leaseId} on request ${id} has expired`);
    }
    return row;
  }
}
