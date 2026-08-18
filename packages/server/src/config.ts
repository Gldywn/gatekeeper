import { homedir } from "node:os";
import { join } from "node:path";

export const LEASE_MS = 30_000;
export const MAX_WAIT_MS = 25_000;
export const POLL_MS = 250;
export const PROPOSAL_TTL_MS = 15 * 60_000;
// Keep an approved result long enough for the agent to fetch it, then strip it.
export const RESULT_TTL_MS = 10 * 60_000;
// Delete terminal requests, old audit rows, and dead sessions after this, so a
// long-lived database does not grow without bound.
export const RETENTION_MS = 24 * 60 * 60_000;
export const MAX_PENDING_PER_SESSION = 32;
export const SWEEP_INTERVAL_MS = 5_000;
// The MCP server pings its session row on this cadence while its stdio pipe is
// open, so an idle-but-connected agent keeps a fresh last_seen (presence).
export const SESSION_HEARTBEAT_MS = 10_000;
// Drop a session from the roster once it has been idle (no query) this long,
// even if its process still heartbeats; it reappears on its next action. Keeps
// the roster to who is actually around rather than yesterday's dead tabs.
export const ROSTER_IDLE_TTL_MS = 30 * 60_000;
// Pairing: a 6-digit code carries the capability token from the broker to the plugin
// through the one channel a web page cannot observe, the human's eyes.
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
// Wrong guesses that burn a code. Any page the human visits can POST the exchange
// route, so this and the budget below are the whole defence.
export const PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_ATTEMPT_BURST = 5;
export const PAIRING_ATTEMPT_REFILL_MS = 60_000;
// No code is issued while a plugin still authenticates on this cadence: nothing is
// waiting to be paired, and a live code is only something for a guesser to aim at.
export const PAIRING_IDLE_MS = 2 * 60_000;
// One desktop alert per window, claimed atomically in the shared database. A burst
// of proposals, from one agent or several processes, is one banner, not N.
export const NOTIFY_COOLDOWN_MS = 10_000;
// Enough for the helper to answer, short enough never to be felt on a submit.
export const NOTIFY_TIMEOUT_MS = 5_000;
// The first proposal on a machine raises the macOS permission dialog and waits for a
// human to click. Killing it there loses the prompt, and nothing awaits the notifier.
export const NOTIFY_PROMPT_TIMEOUT_MS = 120_000;
export const BROKER_HOST = "127.0.0.1";
// A process that loses the race for the broker port retries on this cadence, so
// the broker role fails over to a live process if the current owner exits.
export const REBIND_INTERVAL_MS = 1_000;
export const REBIND_JITTER_MS = 1_000;

export function brokerPort(): number {
  return Number(process.env.GATEKEEPER_BROKER_PORT ?? 9999);
}

export function dbPath(): string {
  return process.env.GATEKEEPER_DB ?? join(homedir(), ".gatekeeper", "requests.db");
}

export function tokenPath(): string {
  return join(homedir(), ".gatekeeper", "broker-token");
}
