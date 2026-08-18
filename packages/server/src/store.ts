import type { ConnectionSnapshot } from "./connection.js";
import type { SchemaSnapshot } from "./schema.js";
import { claimAlert } from "./store/alerts.js";
import { listActivity, readAudit } from "./store/audit.js";
import { getConnection, setConnection } from "./store/connection.js";
import { createContext, migrate, type StoreContext } from "./store/db.js";
import {
  issuePairingCode,
  markPaired,
  type PairingCode,
  type PairingLimits,
  pairedAt,
  type RedeemResult,
  redeemPairingCode,
} from "./store/pairing.js";
import {
  cancel,
  claimNext,
  get,
  getForSession,
  listInflight,
  listSessionRequests,
  markExecuting,
  renewLease,
  resolve,
  type SubmitOutcome,
  submit,
  sweep,
} from "./store/requests.js";
import { getSchema, setSchema, touchSchema } from "./store/schema.js";
import {
  getSession,
  heartbeatSession,
  listSessions,
  markSessionLeft,
  setSessionLabel,
  upsertSession,
} from "./store/sessions.js";
import type {
  ActivityEntry,
  AuditEntry,
  GatekeeperRequest,
  Outcome,
  RequestState,
  SessionMeta,
  SessionRoster,
  StoreOptions,
} from "./store/types.js";

export type { PairingCode, PairingLimits, RedeemResult } from "./store/pairing.js";
export type { SubmitOutcome } from "./store/requests.js";
export type {
  ActivityEntry,
  AuditEntry,
  GatekeeperRequest,
  Outcome,
  RequestState,
  SessionMeta,
  SessionRoster,
  StoreErrorCode,
  StoreOptions,
} from "./store/types.js";
export { StoreError } from "./store/types.js";

// Thin facade: owns the one shared context and delegates each public method to
// the per-aggregate module that holds its body (and its whole transaction).
export class RequestStore {
  private readonly ctx: StoreContext;

  constructor(options: StoreOptions = {}) {
    this.ctx = createContext(options);
    migrate(this.ctx.db);
  }

  /** Enqueue a proposal. Callers that raise a desktop alert want `submitNew` instead. */
  submit(input: {
    sessionId: string;
    sql: string;
    intent?: string;
    idempotencyKey?: string;
    policy?: unknown;
  }): GatekeeperRequest {
    return submit(this.ctx, input).request;
  }

  /** Like `submit`, for the caller that needs to tell a new proposal from a replay. */
  submitNew(input: {
    sessionId: string;
    sql: string;
    intent?: string;
    idempotencyKey?: string;
    policy?: unknown;
  }): SubmitOutcome {
    return submit(this.ctx, input);
  }

  /** True for the one process allowed to raise a desktop alert in this window. */
  claimAlert(cooldownMs: number): boolean {
    return claimAlert(this.ctx, cooldownMs);
  }

  claimNext(
    pluginId: string,
    leaseMs: number,
    connection: string | null = null,
  ): GatekeeperRequest | null {
    return claimNext(this.ctx, pluginId, leaseMs, connection);
  }

  renewLease(id: string, leaseId: string, leaseMs: number): GatekeeperRequest {
    return renewLease(this.ctx, id, leaseId, leaseMs);
  }

  markExecuting(id: string, leaseId: string): GatekeeperRequest {
    return markExecuting(this.ctx, id, leaseId);
  }

  resolve(id: string, leaseId: string, outcome: Outcome): GatekeeperRequest {
    return resolve(this.ctx, id, leaseId, outcome);
  }

  cancel(id: string, sessionId: string): GatekeeperRequest {
    return cancel(this.ctx, id, sessionId);
  }

  get(id: string): GatekeeperRequest | null {
    return get(this.ctx, id);
  }

  getForSession(id: string, sessionId: string): GatekeeperRequest {
    return getForSession(this.ctx, id, sessionId);
  }

  listSessionRequests(
    sessionId: string,
  ): { id: string; intent: string | null; state: RequestState }[] {
    return listSessionRequests(this.ctx, sessionId);
  }

  sweep(): void {
    sweep(this.ctx);
  }

  readAudit(requestId?: string): AuditEntry[] {
    return readAudit(this.ctx, requestId);
  }

  setConnection(input: Record<string, unknown>): ConnectionSnapshot {
    return setConnection(this.ctx, input);
  }

  getConnection(): ConnectionSnapshot | null {
    return getConnection(this.ctx);
  }

  setSchema(input: Record<string, unknown>): SchemaSnapshot {
    return setSchema(this.ctx, input);
  }

  getSchema(): SchemaSnapshot | null {
    return getSchema(this.ctx);
  }

  touchSchema(): void {
    touchSchema(this.ctx);
  }

  upsertSession(input: {
    sessionId: string;
    harness?: string | null;
    harnessVersion?: string | null;
    project?: string | null;
  }): void {
    upsertSession(this.ctx, input);
  }

  heartbeatSession(sessionId: string): void {
    heartbeatSession(this.ctx, sessionId);
  }

  markSessionLeft(sessionId: string): void {
    markSessionLeft(this.ctx, sessionId);
  }

  setSessionLabel(sessionId: string, label: string): void {
    setSessionLabel(this.ctx, sessionId, label);
  }

  listSessions(connection: string | null): SessionRoster[] {
    return listSessions(this.ctx, connection);
  }

  listActivity(connection: string | null, limit = 200): ActivityEntry[] {
    return listActivity(this.ctx, connection, limit);
  }

  listInflight(pluginId: string, connection: string | null): GatekeeperRequest[] {
    return listInflight(this.ctx, pluginId, connection);
  }

  issuePairingCode(ttlMs: number, idleMs: number): PairingCode | null {
    return issuePairingCode(this.ctx, ttlMs, idleMs);
  }

  redeemPairingCode(submitted: string, limits: PairingLimits): RedeemResult {
    return redeemPairingCode(this.ctx, submitted, limits);
  }

  pairedAt(): number | null {
    return pairedAt(this.ctx);
  }

  markPaired(): void {
    markPaired(this.ctx);
  }

  getSession(sessionId: string): SessionMeta | null {
    return getSession(this.ctx, sessionId);
  }

  close(): void {
    this.ctx.db.close();
  }
}
