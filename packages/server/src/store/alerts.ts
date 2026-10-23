import { AUTO_LIVE_MS } from "../config.js";
import type { StoreContext } from "./db.js";

// Nobody decided yet and the proposal is still alive. A leased row can outlive its TTL, since
// a sweep only expires pending rows, so the deadline is checked here too.
const WAITING = "state IN ('pending', 'leased') AND expires_at > @now";
// Auto mode covers a request while its plugin reports in for the request's connection, or for
// a request with none, which that plugin can claim too (see claimNext).
const COVERED = `EXISTS (SELECT 1 FROM alerts WHERE id = 1 AND auto_seen_at > @now - ${AUTO_LIVE_MS}
  AND (requests.connection IS NULL OR requests.connection = auto_scope))`;

// Exactly-once per proposal still means N banners for a burst, since every process
// submits its own. The conditional UPDATE is the cross-process coalescing point:
// whichever process wins the write lock in the window alerts, the others lose silently.
function claimWindow(ctx: StoreContext, cooldownMs: number, now: number): boolean {
  ctx.db.prepare("INSERT OR IGNORE INTO alerts (id) VALUES (1)").run();
  // The `= 0` arm is "never alerted", which the age comparison alone would refuse on
  // any clock smaller than one cooldown, injected or otherwise.
  const info = ctx.db
    .prepare(
      "UPDATE alerts SET last_alert_at = ? WHERE id = 1 AND (last_alert_at = 0 OR last_alert_at <= ?)",
    )
    .run(now, now - cooldownMs);
  return info.changes === 1;
}

export function claimAlert(ctx: StoreContext, cooldownMs: number): boolean {
  return ctx.db.transaction(() => claimWindow(ctx, cooldownMs, ctx.now())).immediate();
}

// Moves every matching request one stage on and rings at most once for all of them: rows that
// come due together get one sound, and a window already claimed means one just rang. Returns
// the session of a moved row when this call rings.
function advance(
  ctx: StoreContext,
  to: 1 | 2,
  where: string,
  params: Record<string, unknown>,
  cooldownMs: number,
): string | null {
  const now = ctx.now();
  const run = ctx.db.transaction((): string | null => {
    const moved = ctx.db
      .prepare(`UPDATE requests SET alert_stage = ${to} WHERE ${where} RETURNING session_id`)
      .all({ ...params, now }) as { session_id: string }[];
    return moved.length && claimWindow(ctx, cooldownMs, now) ? moved[0].session_id : null;
  });
  return run.immediate();
}

/** Whether a read submitted now for this connection can wait for Auto mode to decide. */
export function autoCovers(ctx: StoreContext, connection: string | null): boolean {
  const row = ctx.db.prepare("SELECT auto_seen_at, auto_scope FROM alerts WHERE id = 1").get() as
    | { auto_seen_at: number; auto_scope: string | null }
    | undefined;
  return (
    row !== undefined &&
    row.auto_seen_at > ctx.now() - AUTO_LIVE_MS &&
    (connection === null || connection === row.auto_scope)
  );
}

/** Auto mode on for this connection scope, or off (`null`). */
export function stampAuto(ctx: StoreContext, scope: string | null): void {
  ctx.db
    .prepare(
      `INSERT INTO alerts (id, auto_seen_at, auto_scope) VALUES (1, @at, @scope)
         ON CONFLICT (id) DO UPDATE SET auto_seen_at = @at, auto_scope = @scope`,
    )
    .run({ at: scope === null ? 0 : ctx.now(), scope });
}

/** Requests the plugin leaves to a human, out of Auto mode's hands. */
export function handOffAlerts(ctx: StoreContext, ids: string[], cooldownMs: number): string | null {
  if (!ids.length) return null;
  const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const list = ids.map((_, i) => `@id${i}`).join(", ");
  return advance(ctx, 1, `alert_stage = 0 AND id IN (${list}) AND ${WAITING}`, params, cooldownMs);
}

/** Requests Auto mode no longer covers: switched off, its plugin gone quiet, or elsewhere. */
export function releaseAlerts(ctx: StoreContext, cooldownMs: number): string | null {
  return advance(ctx, 1, `alert_stage = 0 AND ${WAITING} AND NOT ${COVERED}`, {}, cooldownMs);
}

/** The one reminder a request a human was alerted to gets, once half its life has passed. */
export function remindAlerts(ctx: StoreContext, cooldownMs: number): boolean {
  return (
    advance(
      ctx,
      2,
      `alert_stage = 1 AND ${WAITING} AND created_at + expires_at <= 2 * @now`,
      {},
      cooldownMs,
    ) !== null
  );
}
