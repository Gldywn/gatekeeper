import { homedir } from "node:os";
import { join } from "node:path";

export const LEASE_MS = 30_000;
export const MAX_WAIT_MS = 25_000;
export const POLL_MS = 250;
export const PROPOSAL_TTL_MS = 15 * 60_000;
// Keep an approved result long enough for the agent to fetch it, then strip it.
export const RESULT_TTL_MS = 10 * 60_000;
export const MAX_PENDING_PER_SESSION = 32;
export const SWEEP_INTERVAL_MS = 5_000;
export const BROKER_HOST = "127.0.0.1";
// A process that loses the race for the broker port retries on this cadence, so
// the broker role fails over to a live process if the current owner exits.
export const REBIND_INTERVAL_MS = 3_000;
export const REBIND_JITTER_MS = 2_000;

export function brokerPort(): number {
  return Number(process.env.GATEKEEPER_BROKER_PORT ?? 9999);
}

export function dbPath(): string {
  return process.env.GATEKEEPER_DB ?? join(homedir(), ".gatekeeper", "requests.db");
}

export function tokenPath(): string {
  return join(homedir(), ".gatekeeper", "broker-token");
}
