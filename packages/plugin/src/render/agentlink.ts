import type { ConnectionState } from "../types";

// The link to the Gatekeeper server, where agents send their queries. There is no separate
// health check: the plugin asks the server for work every second (GET /pending), and each
// answer is the check, so the popover shows no countdown.

const LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting to the Gatekeeper server",
  reconnecting: "Reconnecting to the Gatekeeper server",
  connected: "Connected to the Gatekeeper server",
  error: "Gatekeeper server unreachable",
};

// The glyph shows no word, so its name and the live announcement carry the state.
export function agentLinkLabel(state: ConnectionState): string {
  return LABEL[state];
}

// The dot tones reuse the database check's: green, amber, red.
const STATUS: Record<ConnectionState, [tone: string, title: string, next: string]> = {
  connected: ["passed", "Last answer", "Checking every second."],
  connecting: ["failed", "Connecting", "Waiting for the first answer."],
  reconnecting: ["failed", "Last check failed", "Retrying every second."],
  error: ["failing", "No answer", "Retrying every second."],
};

// The age is left empty here and filled by the 1 s tick, so the popover is never rebuilt
// under the cursor or the keyboard focus.
export function agentLinkStatusHtml(state: ConnectionState): string {
  const [tone, title, next] = STATUS[state];
  const age = state === "connected" || state === "error" ? '<span class="db-age"></span>' : "";
  return `<div class="db-status ${tone}"><span class="db-dot"></span><span class="db-stack"><span class="db-title">${title}${age}</span><span class="db-next">${next}</span></span></div>`;
}

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

// answeredAt is the last successful answer, 0 before the first one.
export function agentLinkAge(state: ConnectionState, answeredAt: number, now: number): string {
  if (!answeredAt) return "";
  if (state === "connected") return `${span(now - answeredAt)} ago`;
  if (state === "error") return `for ${span(now - answeredAt)}`;
  return "";
}
