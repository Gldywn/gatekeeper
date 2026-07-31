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
  sessionLabel: string | null;
}

export interface SessionRoster extends SessionMeta {
  pendingCount: number;
  lastIntent: string | null;
}

export interface ActivityEntry {
  id: string;
  createdAt: number;
  decidedAt: number | null;
  sessionId: string;
  harness: string | null;
  project: string | null;
  sessionLabel: string | null;
  sql: string;
  intent: string | null;
  state: RequestState;
  // Scalar outcome facts drawn from result_json only, never the result rows.
  reason: string | null;
  error: string | null;
  rowCount: number | null;
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
  /** How long a session may be idle before the roster stops listing it. */
  rosterIdleTtlMs?: number;
}
