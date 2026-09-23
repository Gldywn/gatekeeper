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

// Host-side audit record served by GET /activity: SQL and metadata, never result rows.
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
  affectedRows: number | null;
  approval?: ApprovalAttribution;
  evaluation?: AutoEvaluation;
  autoHold?: AutoHold;
}

export interface AutoHold {
  /** The plugin attempted provider submission, not proof of provider receipt. */
  sent: boolean;
  reason: string;
}

export interface EvaluationInput {
  dialect: "postgresql";
  sql: string;
  // output: the value is returned or shapes a returned value. control: it filters, joins,
  // groups or orders. Both remain privacy-relevant.
  dependencies: {
    schema: string;
    table: string;
    column: string;
    type: string;
    usage: "output" | "control" | "both";
  }[];
  /** String and numeric values were replaced with stable positional parameters for sharing only. */
  withheldLiterals?: true;
}

export interface AutoEvaluation {
  provider: "typesafe";
  model: "jev-1.13.0";
  policy:
    | "auto-beta-1"
    | "auto-beta-2"
    | "auto-beta-3"
    | "auto-beta-4"
    | "auto-beta-5"
    | "auto-beta-6";
  evaluatedAt: number;
  sqlDigest: string;
  eligible: boolean;
  reasons: string[];
  probabilities: Record<string, number>;
}

export interface ApprovalAttribution {
  source: "human" | "automatic";
  evaluation?: AutoEvaluation;
}

/** What TypeSafe said about an API key: accepted, refused (401/403), or not reachable. */
export type KeyStatus = "valid" | "invalid" | "unavailable";

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
