import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { type ConnectionSnapshot, sanitizeConnection } from "./connection.js";

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
  connection: string | null;
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

export interface SessionMeta {
  sessionId: string;
  harness: string | null;
  harnessVersion: string | null;
  project: string | null;
  createdAt: number;
  lastSeen: number;
  lastActive: number;
  connection: string | null;
  leftAt: number | null;
}

export interface SessionRoster extends SessionMeta {
  pendingCount: number;
}

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
  /** How long terminal rows, old audit, and dead sessions are kept. */
  retentionMs?: number;
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
  connection: string | null;
}

interface SessionRow {
  session_id: string;
  harness: string | null;
  harness_version: string | null;
  project: string | null;
  created_at: number;
  last_seen: number;
  last_active: number | null;
  connection: string | null;
  left_at: number | null;
}

const OPEN_STATES = "('pending','leased','executing')";

function token(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function toSessionMeta(row: SessionRow): SessionMeta {
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
  };
}

// Store a digest, never the raw SQL, so the audit trail carries no PII.
function digest(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
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
    connection: raw.connection,
  };
}

export class RequestStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxPending: number;
  private readonly resultTtl: number;
  private readonly retention: number;

  constructor(options: StoreOptions = {}) {
    this.db = new Database(options.path ?? ":memory:");
    this.db.pragma("foreign_keys = ON");
    // WAL is only meaningful for on-disk databases.
    if (options.path && options.path !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
    // Multiple gatekeeper processes share one DB file; wait for the write lock
    // instead of failing immediately with SQLITE_BUSY.
    this.db.pragma("busy_timeout = 5000");
    this.now = options.now ?? Date.now;
    this.ttl = options.proposalTtlMs ?? 15 * 60_000;
    this.maxPending = options.maxPendingPerSession ?? 32;
    this.resultTtl = options.resultTtlMs ?? 10 * 60_000;
    this.retention = options.retentionMs ?? 24 * 60 * 60_000;
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
        expires_at INTEGER NOT NULL,
        connection TEXT
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

      CREATE TABLE IF NOT EXISTS connection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        harness TEXT,
        harness_version TEXT,
        project TEXT,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        last_active INTEGER,
        connection TEXT,
        left_at INTEGER
      );
    `);
    // Add columns introduced after the first release to pre-existing databases.
    for (const alter of [
      "ALTER TABLE requests ADD COLUMN connection TEXT",
      "ALTER TABLE sessions ADD COLUMN last_active INTEGER",
      "ALTER TABLE sessions ADD COLUMN connection TEXT",
      "ALTER TABLE sessions ADD COLUMN left_at INTEGER",
    ]) {
      try {
        this.db.exec(alter);
      } catch {
        // already present
      }
    }
  }

  /** Enqueue a proposal, or return the existing one for a repeated idempotency key. */
  submit(input: {
    sessionId: string;
    sql: string;
    intent?: string;
    idempotencyKey?: string;
    policy?: unknown;
  }): GatekeeperRequest {
    // IMMEDIATE so the idempotency check, the backpressure count, and the insert
    // are one atomic unit across processes; a lost idempotency race falls back to
    // the row the other process inserted.
    const run = this.db.transaction((): GatekeeperRequest => {
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
        connection: this.getConnection()?.connectionName || null,
      };
      try {
        this.db
          .prepare(
            `INSERT INTO requests
              (id, created_at, session_id, sql, intent, idempotency_key, state,
               lease_id, lease_expires_at, plugin_id, decided_at, result_json, policy_json, expires_at, connection)
             VALUES
              (@id, @created_at, @session_id, @sql, @intent, @idempotency_key, @state,
               @lease_id, @lease_expires_at, @plugin_id, @decided_at, @result_json, @policy_json, @expires_at, @connection)`,
          )
          .run(row);
      } catch (err) {
        if (input.idempotencyKey && isUniqueViolation(err)) {
          const existing = this.db
            .prepare("SELECT * FROM requests WHERE session_id = ? AND idempotency_key = ?")
            .get(input.sessionId, input.idempotencyKey) as RawRow | undefined;
          if (existing) {
            return toRequest(existing);
          }
        }
        throw err;
      }
      this.logAudit({
        requestId: row.id,
        event: "submitted",
        toState: "pending",
        sessionId: row.session_id,
        sqlDigest: digest(row.sql),
      });
      return toRequest(row);
    });
    return run.immediate();
  }

  /** Claim the oldest pending proposal under a fresh lease (non-destructive). */
  claimNext(
    pluginId: string,
    leaseMs: number,
    connection: string | null = null,
  ): GatekeeperRequest | null {
    const claim = this.db.transaction((): GatekeeperRequest | null => {
      this.sweep();
      // Offer a proposal only if it is unstamped or stamped with the plugin's
      // current connection, so a query submitted for one database never runs on
      // another after a connection switch.
      const oldest = this.db
        .prepare(
          `SELECT * FROM requests
             WHERE state = 'pending' AND (connection IS NULL OR connection = ?)
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(connection) as RawRow | undefined;
      if (!oldest) {
        return null;
      }
      const now = this.now();
      const leaseId = token("lease");
      // Conditional on state so a concurrent claim in another process is never
      // overwritten (IMMEDIATE below already serializes; this is the guard).
      const info = this.db
        .prepare(
          `UPDATE requests
             SET state = 'leased', lease_id = ?, lease_expires_at = ?, plugin_id = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(leaseId, now + leaseMs, pluginId, oldest.id);
      if (info.changes !== 1) {
        return null;
      }
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
    // BEGIN IMMEDIATE takes the write lock up front, so the read-then-write is
    // not racy across processes.
    return claim.immediate();
  }

  /** Extend a held lease; the plugin calls this while a card stays open. */
  renewLease(id: string, leaseId: string, leaseMs: number): GatekeeperRequest {
    const row = this.requireLease(id, leaseId);
    const now = this.now();
    const expires = now + leaseMs;
    const info = this.db
      .prepare(
        `UPDATE requests SET lease_expires_at = ?
           WHERE id = ? AND lease_id = ? AND state IN ('leased', 'executing') AND lease_expires_at >= ?`,
      )
      .run(expires, id, leaseId, now);
    if (info.changes !== 1) {
      throw new StoreError("LEASE_CONFLICT", `Lease on request ${id} changed concurrently`);
    }
    return { ...row, leaseExpiresAt: expires };
  }

  /** Mark execution started (before runQuery) so a crash is recoverable. */
  markExecuting(id: string, leaseId: string): GatekeeperRequest {
    const row = this.requireLease(id, leaseId);
    if (row.state !== "leased") {
      throw new StoreError("INVALID_STATE", `Cannot execute from state ${row.state}`);
    }
    const now = this.now();
    this.db.transaction(() => {
      const info = this.db
        .prepare(
          `UPDATE requests SET state = 'executing'
             WHERE id = ? AND lease_id = ? AND state = 'leased' AND lease_expires_at >= ?`,
        )
        .run(id, leaseId, now);
      if (info.changes !== 1) {
        throw new StoreError("LEASE_CONFLICT", `Request ${id} changed concurrently`);
      }
      this.logAudit({
        requestId: id,
        event: "executing",
        fromState: "leased",
        toState: "executing",
      });
    })();
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
    this.db.transaction(() => {
      const info = this.db
        .prepare(
          `UPDATE requests SET state = ?, result_json = ?, decided_at = ?, lease_id = NULL, lease_expires_at = NULL
             WHERE id = ? AND lease_id = ? AND state IN ('leased', 'executing') AND lease_expires_at >= ?`,
        )
        .run(state, JSON.stringify(result), now, id, leaseId, now);
      if (info.changes !== 1) {
        throw new StoreError("LEASE_CONFLICT", `Request ${id} changed concurrently`);
      }
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
    })();
    return { ...row, state, result, decidedAt: now, leaseId: null, leaseExpiresAt: null };
  }

  /** Withdraw a request the agent no longer wants (owner-checked). */
  cancel(id: string, sessionId: string): GatekeeperRequest {
    const row = this.getForSession(id, sessionId);
    if (row.state !== "pending" && row.state !== "leased") {
      throw new StoreError("INVALID_STATE", `Cannot cancel from state ${row.state}`);
    }
    const now = this.now();
    this.db.transaction(() => {
      const info = this.db
        .prepare(
          `UPDATE requests SET state = 'cancelled', decided_at = ?, lease_id = NULL, lease_expires_at = NULL
             WHERE id = ? AND session_id = ? AND state IN ('pending', 'leased')`,
        )
        .run(now, id, sessionId);
      if (info.changes !== 1) {
        throw new StoreError("INVALID_STATE", `Request ${id} changed concurrently`);
      }
      this.logAudit({
        requestId: id,
        event: "cancelled",
        fromState: row.state,
        toState: "cancelled",
      });
    })();
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

    // Retention: drop terminal requests, old audit rows, and dead sessions so a
    // long-lived database stays bounded.
    const cutoff = now - this.retention;
    this.db
      .prepare("DELETE FROM requests WHERE decided_at IS NOT NULL AND decided_at < ?")
      .run(cutoff);
    this.db.prepare("DELETE FROM audit WHERE ts < ?").run(cutoff);
    this.db.prepare("DELETE FROM sessions WHERE last_seen < ?").run(cutoff);
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

  /** Persist the plugin's non-sensitive connection context, shared across processes. */
  setConnection(input: Record<string, unknown>): ConnectionSnapshot {
    const snapshot = sanitizeConnection(input, this.now());
    this.db
      .prepare("INSERT OR REPLACE INTO connection (id, snapshot_json) VALUES (1, ?)")
      .run(JSON.stringify(snapshot));
    return snapshot;
  }

  getConnection(): ConnectionSnapshot | null {
    const row = this.db.prepare("SELECT snapshot_json FROM connection WHERE id = 1").get() as
      | { snapshot_json: string }
      | undefined;
    return row ? (JSON.parse(row.snapshot_json) as ConnectionSnapshot) : null;
  }

  /** Record or refresh an agent session's identity (harness, project) for grouping. */
  upsertSession(input: {
    sessionId: string;
    harness?: string | null;
    harnessVersion?: string | null;
    project?: string | null;
  }): void {
    const now = this.now();
    const connection = this.getConnection()?.connectionName ?? null;
    this.db
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
  heartbeatSession(sessionId: string): void {
    // Liveness only: never re-tag the session's connection here, or a passive
    // agent would be dragged onto whatever connection Beekeeper currently shows.
    this.db
      .prepare("UPDATE sessions SET last_seen = ? WHERE session_id = ?")
      .run(this.now(), sessionId);
  }

  /** Record a clean disconnect so the roster shows the agent as gone at once. */
  markSessionLeft(sessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET left_at = ? WHERE session_id = ?")
      .run(this.now(), sessionId);
  }

  /** Sessions for a connection, each with its count of still-open requests. */
  listSessions(connection: string | null): SessionRoster[] {
    // Scope pending_count to the queried connection so it matches what claimNext
    // would actually offer there, not the session's total across connections.
    const rows = this.db
      .prepare(
        `SELECT s.*,
           (SELECT count(*) FROM requests r
              WHERE r.session_id = s.session_id AND r.state IN ${OPEN_STATES}
                AND (r.connection IS NULL OR r.connection = @connection)) AS pending_count
         FROM sessions s
         WHERE s.connection IS NULL OR s.connection = @connection
         ORDER BY s.created_at ASC`,
      )
      .all({ connection }) as (SessionRow & { pending_count: number })[];
    return rows.map((row) => ({ ...toSessionMeta(row), pendingCount: row.pending_count }));
  }

  getSession(sessionId: string): SessionMeta | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
      | SessionRow
      | undefined;
    return row ? toSessionMeta(row) : null;
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
