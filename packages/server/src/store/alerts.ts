import { AUTO_LIVE_MS } from "../config.js";
import type { StoreContext } from "./db.js";

// Nobody decided yet and the proposal is still alive. A leased row can outlive its TTL, since
// a sweep only expires pending rows, so the deadline is checked here too.
const WAITING = "state IN ('pending', 'leased') AND expires_at > @now";
// The plugin covers a request while it reports in for the request's connection, or for
// a request with none, which that plugin can claim too (see claimNext).
const COVERED = `EXISTS (SELECT 1 FROM alerts WHERE id = 1 AND auto_seen_at > @now - ${AUTO_LIVE_MS}
  AND (requests.connection IS NULL OR requests.connection = auto_scope))`;
// Half a proposal's life: a request still waiting rings by then, whatever else holds it.
const PAST_HALF = "created_at + expires_at <= 2 * @now";

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

// A reminder keeps a window of its own: it stays quiet next to any recent sound, but claiming
// the alert window would swallow the banner of a request arriving just after it.
function claimReminder(ctx: StoreContext, cooldownMs: number, now: number): boolean {
  ctx.db.prepare("INSERT OR IGNORE INTO alerts (id) VALUES (1)").run();
  const info = ctx.db
    .prepare(
      `UPDATE alerts SET last_remind_at = @now WHERE id = 1
         AND (last_alert_at = 0 OR last_alert_at <= @since)
         AND (last_remind_at = 0 OR last_remind_at <= @since)`,
    )
    .run({ now, since: now - cooldownMs });
  return info.changes === 1;
}

export function claimAlert(ctx: StoreContext, cooldownMs: number): boolean {
  return ctx.db.transaction(() => claimWindow(ctx, cooldownMs, ctx.now())).immediate();
}

// Moves every matching request to `stage` and rings at most once for all of them: rows that
// come due together get one sound, and a window already claimed means one just rang. Returns
// the session of a moved row when this call rings.
function advance(
  ctx: StoreContext,
  stage: string,
  where: string,
  params: Record<string, unknown>,
  claim: (now: number) => boolean,
): string | null {
  const now = ctx.now();
  const run = ctx.db.transaction((): string | null => {
    const moved = ctx.db
      .prepare(`UPDATE requests SET alert_stage = ${stage} WHERE ${where} RETURNING session_id`)
      .all({ ...params, now }) as { session_id: string }[];
    return moved.length && claim(now) ? moved[0].session_id : null;
  });
  return run.immediate();
}

// A first alert past half a proposal's life stands for its reminder too, so it never rings
// twice in a row.
function alerted(ctx: StoreContext, where: string, params: Record<string, unknown>, cd: number) {
  return advance(ctx, `CASE WHEN ${PAST_HALF} THEN 2 ELSE 1 END`, where, params, (now) =>
    claimWindow(ctx, cd, now),
  );
}

// Blind to the query on purpose: only the plugin knows what Auto mode and its load check will
// decide, and a submitting process may run an older server than the one serving the plugin.
/** Whether a request submitted now for this connection waits for the plugin to call a human. */
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

/** The plugin reporting in for this connection scope, or no plugin to wait for (`null`). */
export function stampAuto(ctx: StoreContext, scope: string | null): void {
  ctx.db
    .prepare(
      `INSERT INTO alerts (id, auto_seen_at, auto_scope) VALUES (1, @at, @scope)
         ON CONFLICT (id) DO UPDATE SET auto_seen_at = @at, auto_scope = @scope`,
    )
    .run({ at: scope === null ? 0 : ctx.now(), scope });
}

/** Requests the plugin leaves to a human, once nothing else will decide them. */
export function handOffAlerts(ctx: StoreContext, ids: string[], cooldownMs: number): string | null {
  if (!ids.length) return null;
  const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const list = ids.map((_, i) => `@id${i}`).join(", ");
  return alerted(ctx, `alert_stage = 0 AND id IN (${list}) AND ${WAITING}`, params, cooldownMs);
}

// Also any still owed at half their life: with every Auto mode run taken by long queries, the
// plugin may never get to them.
/** Requests the plugin no longer covers: gone quiet, an older plugin, or another connection. */
export function releaseAlerts(ctx: StoreContext, cooldownMs: number): string | null {
  return alerted(
    ctx,
    `alert_stage = 0 AND ${WAITING} AND (NOT ${COVERED} OR ${PAST_HALF})`,
    {},
    cooldownMs,
  );
}

/** The one reminder a request a human was alerted to gets, once half its life has passed. */
export function remindAlerts(ctx: StoreContext, cooldownMs: number): boolean {
  const due = `alert_stage = 1 AND ${WAITING} AND ${PAST_HALF}`;
  const now = ctx.now();
  // Claimed before any row moves: a reminder kept quiet next to a recent sound is due again on
  // the next sweep, so it comes late rather than never.
  const run = ctx.db.transaction((): boolean => {
    if (!ctx.db.prepare(`SELECT 1 FROM requests WHERE ${due} LIMIT 1`).get({ now })) return false;
    if (!claimReminder(ctx, cooldownMs, now)) return false;
    ctx.db.prepare(`UPDATE requests SET alert_stage = 2 WHERE ${due}`).run({ now });
    return true;
  });
  return run.immediate();
}
