import type {
  ActivityEntry,
  Proposal,
  RequestState,
  SessionMeta,
  SessionRoster,
} from "@gatekeeper/shared";
import type { HistResult } from "./result";
import type { SchemaContext } from "./sql/schema";

// Re-export the shared wire contract so existing `./types` imports keep resolving here.
export type { ActivityEntry, Proposal, RequestState, SessionMeta, SessionRoster };

export type CardState = "ready" | "approving" | "executing" | "posting" | "rejecting";

export type ConnectionState = "connecting" | "reconnecting" | "connected" | "error";

export type Presence = "active" | "idle" | "gone";

export interface Card extends Proposal {
  state: CardState;
  // Host-side only: which tables/PII the query touches, for the human's eyes.
  // Never posted to the broker, so the agent never learns the schema.
  schema?: SchemaContext | null;
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
