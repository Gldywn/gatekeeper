import type { HistResult } from "./result";
import type { SchemaContext } from "./sql/schema";

export type CardState = "ready" | "approving" | "executing" | "posting" | "rejecting";

export type ConnectionState = "connecting" | "reconnecting" | "connected" | "error";

export interface SessionMeta {
  sessionId: string;
  harness: string | null;
  harnessVersion: string | null;
  project: string | null;
  sessionLabel: string | null;
}

export interface SessionRoster {
  sessionId: string;
  harness: string | null;
  harnessVersion: string | null;
  project: string | null;
  createdAt: number;
  lastSeen: number;
  lastActive: number;
  connection: string | null;
  leftAt: number | null;
  pendingCount: number;
  lastIntent: string | null;
  sessionLabel: string | null;
}

export type Presence = "active" | "idle" | "gone";

export interface Proposal {
  id: string;
  sql: string;
  intent?: string;
  createdAt: number;
  expiresAt: number;
  leaseId: string;
  leaseExpiresAt: number;
  sessionId: string;
  session: SessionMeta | null;
}

export interface Card extends Proposal {
  state: CardState;
  // Host-side only: which tables/PII the query touches, for the human's eyes.
  // Never posted to the broker, so the agent never learns the schema.
  schema?: SchemaContext | null;
  // Developer-mode synthetic card: resolves down a fully local path that never
  // calls the broker, lease, roster, or audit trail. Absent on real cards.
  dev?: boolean;
}

export interface HistItem {
  id: string;
  status: "approved" | "rejected" | "failed" | "expired";
  note: string;
  sql: string;
  resolvedAt: number;
  connection: string | null;
  session: SessionMeta | null;
  intent?: string;
  result?: HistResult;
}

// The durable, PII-safe audit record served by GET /activity. It never carries
// result rows: an approved query contributes a scalar rowCount only.
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
  state: string;
  reason: string | null;
  error: string | null;
  rowCount: number | null;
}
