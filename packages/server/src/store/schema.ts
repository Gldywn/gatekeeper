import { type SchemaSnapshot, sanitizeSchema } from "../schema.js";
import type { StoreContext } from "./db.js";

/** Persist the plugin's last-posted structural schema, shared across processes. */
export function setSchema(ctx: StoreContext, input: Record<string, unknown>): SchemaSnapshot {
  const snapshot = sanitizeSchema(input, ctx.now());
  ctx.db
    .prepare("INSERT OR REPLACE INTO db_schema (id, schema_json) VALUES (1, ?)")
    .run(JSON.stringify(snapshot));
  return snapshot;
}

export function getSchema(ctx: StoreContext): SchemaSnapshot | null {
  const row = ctx.db.prepare("SELECT schema_json FROM db_schema WHERE id = 1").get() as
    | { schema_json: string }
    | undefined;
  return row ? (JSON.parse(row.schema_json) as SchemaSnapshot) : null;
}

// The plugin's liveness ping: bump capturedAt so the snapshot stays within its TTL while the
// plugin is open with schema access on. A no-op when nothing is stored.
export function touchSchema(ctx: StoreContext): void {
  const snap = getSchema(ctx);
  if (!snap) {
    return;
  }
  snap.capturedAt = ctx.now();
  ctx.db
    .prepare("INSERT OR REPLACE INTO db_schema (id, schema_json) VALUES (1, ?)")
    .run(JSON.stringify(snap));
}
