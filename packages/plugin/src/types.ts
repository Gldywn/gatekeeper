export type { AutoHold } from "@gatekeeper/shared";

import type {
  ActivityEntry,
  AutoHold,
  Proposal,
  RequestState,
  SessionMeta,
  SessionRoster,
} from "@gatekeeper/shared";
import type { HistResult } from "./result";
import type { LoadResult } from "./sql/load";
import type { SchemaContext } from "./sql/schema";

// Re-export the shared wire contract so existing `./types` imports keep resolving here.
export type { ActivityEntry, Proposal, RequestState, SessionMeta, SessionRoster };

export type CardState = "ready" | "approving" | "executing" | "posting" | "rejecting";

export type ConnectionState = "connecting" | "reconnecting" | "connected" | "error";

export type Presence = "active" | "idle" | "gone";

export interface Card extends Proposal {
  state: CardState;
  autoAttempt?: number;
  autoStatus?: string;
  // Why the last human approval stopped before the SQL ran: a plain fact, never an Auto mode hold.
  executionNotice?: string;
  /** Set once the query left for the provider, so the card can say what was shared. */
  autoSent?: boolean;
  evaluation?: import("@gatekeeper/shared").AutoEvaluation;
  approval?: import("@gatekeeper/shared").ApprovalAttribution;
  authorityLost?: boolean;
  // Host-side only: which tables/PII the query touches, for the human's eyes.
  // Never posted to the broker, so the agent never learns the schema.
  schema?: SchemaContext | null;
  // Raw flags from that analysis, posted with the decision for the audit trail: presence
  // only, so no table or column name ever reaches the broker.
  sensitivity?: import("@gatekeeper/shared").SensitivityRecord;
  // The flags the broker holds for this request, so the local row never shows a flag the trail
  // lacks. `standing` false after a withdrawal: the broker keeps them, the next post replaces them.
  decisionSensitivity?: {
    value: import("@gatekeeper/shared").SensitivityRecord | undefined;
    standing: boolean;
  };
  run?: RunState;
  // Host-side only, like schema. Auto mode and auto-deny read the settled promise; the card
  // renders loadResult, which starts with the SQL-only findings.
  load?: Promise<LoadResult>;
  loadResult?: LoadResult;
  loadSession?: number;
}

// One approved execution, from the moment its SQL leaves for the host until it settles.
export interface RunState {
  startedAt: number;
  // Captured at start, so a later settings change cannot stop a query approved under
  // another limit. 0 means no auto-stop.
  limitMs: number;
  // Either both engine and tag (stopping is available) or the reason it is not.
  engine?: import("./sql/stop").StopEngine;
  tag?: string;
  unavailable?: string;
  // Set the moment the host answers, before any posting, so no stop is sent after it.
  ended: boolean;
  stop?: StopState;
}

export interface StopState {
  // The first request wins: a later auto-stop never relabels the operator's click.
  by: "operator" | "limit";
  atMs: number;
  // pending: keep trying (not found yet); sent: the database accepted the cancel;
  // idle: nothing in progress, Stop is clickable again.
  state: "pending" | "sent" | "idle";
  inFlight: boolean;
  attempts: number;
  sentAt?: number;
  error?: string;
}

export interface HistItem {
  id: string;
  status: "approved" | "rejected" | "failed" | "expired";
  note: string;
  // How the plugin itself ended it ("blocked", "lease lost"...), never the raw error the note may be.
  outcome?: string;
  // The words a person typed when declining, kept apart so a typed "declined" is still theirs.
  reason?: string;
  sql: string;
  resolvedAt: number;
  connection: string | null;
  session: SessionMeta | null;
  intent?: string;
  result?: HistResult;
  approval?: import("@gatekeeper/shared").ApprovalAttribution;
  evaluation?: import("@gatekeeper/shared").AutoEvaluation;
  autoHold?: AutoHold;
  // The exact rejection text the agent received, when there was one.
  sent?: string;
  autoDenied?: boolean;
  // The flags recorded with the decision, so the local row shows the same chips as the trail.
  sensitivity?: import("@gatekeeper/shared").SensitivityRecord;
}
