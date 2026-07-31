import { type ConnectionSnapshot, sanitizeConnection } from "../connection.js";
import type { StoreContext } from "./db.js";

/** Persist the plugin's non-sensitive connection context, shared across processes. */
export function setConnection(
  ctx: StoreContext,
  input: Record<string, unknown>,
): ConnectionSnapshot {
  const snapshot = sanitizeConnection(input, ctx.now());
  ctx.db
    .prepare("INSERT OR REPLACE INTO connection (id, snapshot_json) VALUES (1, ?)")
    .run(JSON.stringify(snapshot));
  return snapshot;
}

export function getConnection(ctx: StoreContext): ConnectionSnapshot | null {
  const row = ctx.db.prepare("SELECT snapshot_json FROM connection WHERE id = 1").get() as
    | { snapshot_json: string }
    | undefined;
  return row ? (JSON.parse(row.snapshot_json) as ConnectionSnapshot) : null;
}
