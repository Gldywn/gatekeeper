// The wire contract between the server (producer) and the plugin (consumer). Types only,
// no runtime: both sides import these with `import type`, so this file never ships as code.

export type AccessMode = "read" | "write" | "destructive";

export type RequestState =
  | "pending"
  | "leased"
  | "executing"
  | "approved"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

// Session identity carried on the wire: embedded in a proposal and shown in the roster.
// The server's fuller session record is a superset and assigns into this cleanly.
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

// A proposal offered to the plugin by GET /pending and /inflight.
export interface Proposal {
  id: string;
  sql: string;
  intent?: string;
  // Advisory server class; the plugin re-classifies authoritatively before it runs.
  class?: AccessMode | null;
  createdAt: number;
  expiresAt: number;
  leaseId: string;
  leaseExpiresAt: number;
  sessionId: string;
  session: SessionMeta | null;
}

// PII-safe audit record served by GET /activity: never result rows, only a scalar count.
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
  reason: string | null;
  error: string | null;
  rowCount: number | null;
}

// The plugin POSTs ConnectionInput; the server stamps capturedAt and serves/stores the
// ConnectionSnapshot. Never carries host, user, or credentials; informational only.
export interface ConnectionInput {
  connectionName: string;
  databaseType: string;
  databaseName: string;
  schema: string | null;
  readOnly: boolean;
  mode: AccessMode;
}

export interface ConnectionSnapshot extends ConnectionInput {
  capturedAt: number;
}
