import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { StoreOptions } from "./types.js";

export const OPEN_STATES = "('pending','leased','executing')";

// The state every module function shares: the one database handle, the injectable
// clock, and the resolved TTL/backpressure knobs. The facade builds it once and
// threads it through each per-aggregate function.
export interface StoreContext {
  db: Database.Database;
  now: () => number;
  /** How long a pending proposal lives before it self-expires. */
  ttl: number;
  /** Cap on un-terminal proposals per session (backpressure). */
  maxPending: number;
  /** How long an approved result is retained before its rows are stripped. */
  resultTtl: number;
  /** How long terminal rows, old audit, and dead sessions are kept. */
  retention: number;
  /** How long a session may be idle before the roster stops listing it. */
  rosterIdleTtl: number;
}

export function createContext(options: StoreOptions = {}): StoreContext {
  const db = new Database(options.path ?? ":memory:");
  db.pragma("foreign_keys = ON");
  // WAL is only meaningful for on-disk databases.
  if (options.path && options.path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  // Multiple gatekeeper processes share one DB file; wait for the write lock
  // instead of failing immediately with SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");
  return {
    db,
    now: options.now ?? Date.now,
    ttl: options.proposalTtlMs ?? 15 * 60_000,
    maxPending: options.maxPendingPerSession ?? 32,
    resultTtl: options.resultTtlMs ?? 10 * 60_000,
    retention: options.retentionMs ?? 24 * 60 * 60_000,
    rosterIdleTtl: options.rosterIdleTtlMs ?? 30 * 60_000,
  };
}

export function migrate(db: Database.Database): void {
  db.exec(`
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

      CREATE TABLE IF NOT EXISTS db_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_json TEXT NOT NULL
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
        left_at INTEGER,
        session_label TEXT
      );
    `);
  // Add columns introduced after the first release to pre-existing databases.
  for (const alter of [
    "ALTER TABLE requests ADD COLUMN connection TEXT",
    "ALTER TABLE sessions ADD COLUMN last_active INTEGER",
    "ALTER TABLE sessions ADD COLUMN connection TEXT",
    "ALTER TABLE sessions ADD COLUMN left_at INTEGER",
    // A fresh DB is already session_label, so this throws and is swallowed;
    // an existing DB still on session_intent is renamed in place.
    "ALTER TABLE sessions RENAME COLUMN session_intent TO session_label",
  ]) {
    try {
      db.exec(alter);
    } catch {
      // already present
    }
  }
}

export function token(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

// Store a digest, never the raw SQL, so the audit trail carries no PII.
export function digest(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
