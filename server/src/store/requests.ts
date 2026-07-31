import { logAudit } from "./audit.js";
import { getConnection } from "./connection.js";
import { digest, isUniqueViolation, OPEN_STATES, type StoreContext, token } from "./db.js";
import { type RawRow, toRequest } from "./rows.js";
import { type GatekeeperRequest, type Outcome, type RequestState, StoreError } from "./types.js";

/** Enqueue a proposal, or return the existing one for a repeated idempotency key. */
export function submit(
  ctx: StoreContext,
  input: {
    sessionId: string;
    sql: string;
    intent?: string;
    idempotencyKey?: string;
    policy?: unknown;
  },
): GatekeeperRequest {
  // IMMEDIATE so the idempotency check, the backpressure count, and the insert
  // are one atomic unit across processes; a lost idempotency race falls back to
  // the row the other process inserted.
  const run = ctx.db.transaction((): GatekeeperRequest => {
    sweep(ctx);

    if (input.idempotencyKey) {
      const existing = ctx.db
        .prepare("SELECT * FROM requests WHERE session_id = ? AND idempotency_key = ?")
        .get(input.sessionId, input.idempotencyKey) as RawRow | undefined;
      if (existing) {
        return toRequest(existing);
      }
    }

    const pending = ctx.db
      .prepare(
        `SELECT count(*) AS n FROM requests WHERE session_id = ? AND state IN ${OPEN_STATES}`,
      )
      .get(input.sessionId) as { n: number };
    if (pending.n >= ctx.maxPending) {
      throw new StoreError(
        "QUEUE_FULL",
        `Session has ${pending.n} open requests (max ${ctx.maxPending})`,
      );
    }

    const now = ctx.now();
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
      expires_at: now + ctx.ttl,
      connection: getConnection(ctx)?.connectionName || null,
    };
    try {
      ctx.db
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
        const existing = ctx.db
          .prepare("SELECT * FROM requests WHERE session_id = ? AND idempotency_key = ?")
          .get(input.sessionId, input.idempotencyKey) as RawRow | undefined;
        if (existing) {
          return toRequest(existing);
        }
      }
      throw err;
    }
    logAudit(ctx, {
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
export function claimNext(
  ctx: StoreContext,
  pluginId: string,
  leaseMs: number,
  connection: string | null = null,
): GatekeeperRequest | null {
  const claim = ctx.db.transaction((): GatekeeperRequest | null => {
    sweep(ctx);
    // Offer a proposal only if it is unstamped or stamped with the plugin's
    // current connection, so a query submitted for one database never runs on
    // another after a connection switch.
    const oldest = ctx.db
      .prepare(
        `SELECT * FROM requests
             WHERE state = 'pending' AND (connection IS NULL OR connection = ?)
           ORDER BY created_at ASC LIMIT 1`,
      )
      .get(connection) as RawRow | undefined;
    if (!oldest) {
      return null;
    }
    const now = ctx.now();
    const leaseId = token("lease");
    // Conditional on state so a concurrent claim in another process is never
    // overwritten (IMMEDIATE below already serializes; this is the guard).
    const info = ctx.db
      .prepare(
        `UPDATE requests
             SET state = 'leased', lease_id = ?, lease_expires_at = ?, plugin_id = ?
           WHERE id = ? AND state = 'pending'`,
      )
      .run(leaseId, now + leaseMs, pluginId, oldest.id);
    if (info.changes !== 1) {
      return null;
    }
    logAudit(ctx, {
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
export function renewLease(
  ctx: StoreContext,
  id: string,
  leaseId: string,
  leaseMs: number,
): GatekeeperRequest {
  const row = requireLease(ctx, id, leaseId);
  const now = ctx.now();
  const expires = now + leaseMs;
  const info = ctx.db
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
export function markExecuting(ctx: StoreContext, id: string, leaseId: string): GatekeeperRequest {
  const row = requireLease(ctx, id, leaseId);
  if (row.state !== "leased") {
    throw new StoreError("INVALID_STATE", `Cannot execute from state ${row.state}`);
  }
  const now = ctx.now();
  ctx.db.transaction(() => {
    const info = ctx.db
      .prepare(
        `UPDATE requests SET state = 'executing'
             WHERE id = ? AND lease_id = ? AND state = 'leased' AND lease_expires_at >= ?`,
      )
      .run(id, leaseId, now);
    if (info.changes !== 1) {
      throw new StoreError("LEASE_CONFLICT", `Request ${id} changed concurrently`);
    }
    logAudit(ctx, {
      requestId: id,
      event: "executing",
      fromState: "leased",
      toState: "executing",
    });
  })();
  return { ...row, state: "executing" };
}

/** Resolve a leased/executing request to its terminal state. */
export function resolve(
  ctx: StoreContext,
  id: string,
  leaseId: string,
  outcome: Outcome,
): GatekeeperRequest {
  const row = requireLease(ctx, id, leaseId);
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
  const now = ctx.now();
  ctx.db.transaction(() => {
    const info = ctx.db
      .prepare(
        `UPDATE requests SET state = ?, result_json = ?, decided_at = ?, lease_id = NULL, lease_expires_at = NULL
             WHERE id = ? AND lease_id = ? AND state IN ('leased', 'executing') AND lease_expires_at >= ?`,
      )
      .run(state, JSON.stringify(result), now, id, leaseId, now);
    if (info.changes !== 1) {
      throw new StoreError("LEASE_CONFLICT", `Request ${id} changed concurrently`);
    }
    logAudit(ctx, {
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
export function cancel(ctx: StoreContext, id: string, sessionId: string): GatekeeperRequest {
  const row = getForSession(ctx, id, sessionId);
  if (row.state !== "pending" && row.state !== "leased") {
    throw new StoreError("INVALID_STATE", `Cannot cancel from state ${row.state}`);
  }
  const now = ctx.now();
  ctx.db.transaction(() => {
    const info = ctx.db
      .prepare(
        `UPDATE requests SET state = 'cancelled', decided_at = ?, lease_id = NULL, lease_expires_at = NULL
             WHERE id = ? AND session_id = ? AND state IN ('pending', 'leased')`,
      )
      .run(now, id, sessionId);
    if (info.changes !== 1) {
      throw new StoreError("INVALID_STATE", `Request ${id} changed concurrently`);
    }
    logAudit(ctx, {
      requestId: id,
      event: "cancelled",
      fromState: row.state,
      toState: "cancelled",
    });
  })();
  return { ...row, state: "cancelled", decidedAt: now, leaseId: null, leaseExpiresAt: null };
}

export function get(ctx: StoreContext, id: string): GatekeeperRequest | null {
  const row = ctx.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RawRow | undefined;
  return row ? toRequest(row) : null;
}

export function getForSession(ctx: StoreContext, id: string, sessionId: string): GatekeeperRequest {
  const row = get(ctx, id);
  if (!row) {
    throw new StoreError("NOT_FOUND", `Unknown request ${id}`);
  }
  if (row.sessionId !== sessionId) {
    throw new StoreError("NOT_OWNER", `Request ${id} belongs to another session`);
  }
  return row;
}

// Lightweight status of the session's in-flight and recently-decided requests
// (states only), so an agent can poll all its proposals in one call.
export function listSessionRequests(
  ctx: StoreContext,
  sessionId: string,
): { id: string; intent: string | null; state: RequestState }[] {
  const cutoff = ctx.now() - ctx.resultTtl;
  return ctx.db
    .prepare(
      `SELECT id, intent, state FROM requests
           WHERE session_id = @sessionId
             AND (state IN ('pending', 'leased', 'executing') OR decided_at >= @cutoff)
           ORDER BY created_at ASC`,
    )
    .all({ sessionId, cutoff }) as { id: string; intent: string | null; state: RequestState }[];
}

// A reopened plugin re-adopts the proposals this pluginId still holds under a
// live lease, so the fresh tab shows them at once instead of waiting out the lease.
export function listInflight(
  ctx: StoreContext,
  pluginId: string,
  connection: string | null,
): GatekeeperRequest[] {
  const rows = ctx.db
    .prepare(
      `SELECT * FROM requests
           WHERE state = 'leased' AND plugin_id = @pluginId AND lease_expires_at > @now
             AND (connection IS NULL OR connection = @connection)
           ORDER BY created_at ASC`,
    )
    .all({ pluginId, connection, now: ctx.now() }) as RawRow[];
  return rows.map(toRequest);
}

// Expired leases return to pending; a lease that expired mid-execution fails
// as execution_unknown, because the query may already have run.
export function sweep(ctx: StoreContext): void {
  const now = ctx.now();
  const reoffered = ctx.db
    .prepare(
      "UPDATE requests SET state = 'pending', lease_id = NULL, lease_expires_at = NULL, plugin_id = NULL WHERE state = 'leased' AND lease_expires_at < ? RETURNING id",
    )
    .all(now) as { id: string }[];
  for (const row of reoffered) {
    logAudit(ctx, {
      requestId: row.id,
      event: "lease_expired",
      fromState: "leased",
      toState: "pending",
    });
  }
  const unknown = ctx.db
    .prepare(
      "UPDATE requests SET state = 'failed', result_json = ?, decided_at = ?, lease_id = NULL, lease_expires_at = NULL WHERE state = 'executing' AND lease_expires_at < ? RETURNING id",
    )
    .all(JSON.stringify({ error: "execution_unknown" }), now, now) as { id: string }[];
  for (const row of unknown) {
    logAudit(ctx, {
      requestId: row.id,
      event: "execution_unknown",
      fromState: "executing",
      toState: "failed",
    });
  }
  const expired = ctx.db
    .prepare(
      "UPDATE requests SET state = 'expired', decided_at = ? WHERE state = 'pending' AND expires_at < ? RETURNING id",
    )
    .all(now, now) as { id: string }[];
  for (const row of expired) {
    logAudit(ctx, {
      requestId: row.id,
      event: "expired",
      fromState: "pending",
      toState: "expired",
    });
  }
  // Strip approved result rows once their retention window passes. The audit
  // trail already recorded the decision and row count, so no PII lingers and
  // the request stays queryable as an approved-but-purged terminal.
  const stripped = ctx.db
    .prepare(
      `UPDATE requests SET result_json = ?
           WHERE state = 'approved' AND decided_at IS NOT NULL AND decided_at < ?
             AND result_json LIKE '{"rows":%' RETURNING id`,
    )
    .all(JSON.stringify({ purged: true }), now - ctx.resultTtl) as { id: string }[];
  for (const row of stripped) {
    logAudit(ctx, {
      requestId: row.id,
      event: "result_purged",
      fromState: "approved",
      toState: "approved",
    });
  }

  // Retention: drop terminal requests, old audit rows, and dead sessions so a
  // long-lived database stays bounded.
  const cutoff = now - ctx.retention;
  ctx.db
    .prepare("DELETE FROM requests WHERE decided_at IS NOT NULL AND decided_at < ?")
    .run(cutoff);
  ctx.db.prepare("DELETE FROM audit WHERE ts < ?").run(cutoff);
  ctx.db.prepare("DELETE FROM sessions WHERE last_seen < ?").run(cutoff);
}

export function requireLease(ctx: StoreContext, id: string, leaseId: string): GatekeeperRequest {
  const row = get(ctx, id);
  if (!row) {
    throw new StoreError("NOT_FOUND", `Unknown request ${id}`);
  }
  if (row.leaseId !== leaseId) {
    throw new StoreError("LEASE_CONFLICT", `Lease ${leaseId} does not hold request ${id}`);
  }
  // Refuse an expired lease even before the sweep re-offers it, so a stalled
  // holder cannot mark executing or resolve on a lease it has effectively lost.
  if (row.leaseExpiresAt !== null && row.leaseExpiresAt < ctx.now()) {
    throw new StoreError("LEASE_CONFLICT", `Lease ${leaseId} on request ${id} has expired`);
  }
  return row;
}
