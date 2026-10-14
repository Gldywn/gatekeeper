import type { StoreContext } from "./db.js";

// Exactly-once per proposal still means N banners for a burst, since every process
// submits its own. The conditional UPDATE is the cross-process coalescing point:
// whichever process wins the write lock in the window alerts, the others lose silently.
export function claimAlert(ctx: StoreContext, cooldownMs: number): boolean {
  const now = ctx.now();
  const run = ctx.db.transaction((): boolean => {
    ctx.db.prepare("INSERT OR IGNORE INTO alerts (id) VALUES (1)").run();
    // The `= 0` arm is "never alerted", which the age comparison alone would refuse on
    // any clock smaller than one cooldown, injected or otherwise.
    const info = ctx.db
      .prepare(
        "UPDATE alerts SET last_alert_at = ? WHERE id = 1 AND (last_alert_at = 0 OR last_alert_at <= ?)",
      )
      .run(now, now - cooldownMs);
    return info.changes === 1;
  });
  return run.immediate();
}

// Resetting to "never alerted" lets the next proposal ring right after "handled". One
// statement, so a concurrent submission either blocks the sound or rings its own alert.
export function claimAutoAlert(ctx: StoreContext): boolean {
  // An automatic execution can still be withdrawn to review with nobody at the card; a human
  // one is withdrawn in front of the human, and a long one must not mute every Auto sound.
  return (
    ctx.db
      .prepare(
        `UPDATE alerts SET last_alert_at = 0 WHERE id = 1 AND last_alert_at != 0
           AND NOT EXISTS (SELECT 1 FROM requests WHERE expires_at > ? AND (
             state IN ('pending', 'leased') OR (state = 'executing'
               AND json_extract(policy_json, '$.approval.source') = 'automatic')))`,
      )
      .run(ctx.now()).changes === 1
  );
}
