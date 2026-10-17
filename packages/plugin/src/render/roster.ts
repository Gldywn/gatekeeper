import { capitalize, escapeHtml, relAge } from "../html";
import { harnessIcon } from "../icons";
import type { Presence, SessionRoster } from "../types";

// Mirror the server's SESSION_HEARTBEAT_MS margin: active if it acted recently,
// gone once its presence ping has been silent well past one heartbeat.
const SESSION_ACTIVE_MS = 30_000;
const SESSION_GONE_MS = 45_000;

export function presence(s: SessionRoster, now: number): Presence {
  if (s.leftAt !== null || now - s.lastSeen > SESSION_GONE_MS) {
    return "gone";
  }
  return now - s.lastActive <= SESSION_ACTIVE_MS ? "active" : "idle";
}

export function rosterRow(s: SessionRoster, p: Presence): string {
  const harness = s.harness?.trim() || null;
  const project = s.project?.trim();
  const who = project ? escapeHtml(project) : escapeHtml(harness || s.sessionId);
  // Every listed session has a non-empty label (the roster query filters the
  // rest out), so render it directly with no placeholder branch.
  const scope = capitalize(s.sessionLabel?.trim() ?? "");
  const meta =
    p === "active"
      ? "active"
      : p === "idle"
        ? `idle <span class="rage" data-age="${s.lastActive}">${relAge(s.lastActive)}</span>`
        : `left <span class="rage" data-age="${s.leftAt ?? s.lastSeen}">${relAge(s.leftAt ?? s.lastSeen)}</span>`;
  return `
      <div class="roster-row" data-presence="${p}">
        <span class="presence-dot"></span>
        <span class="harness-badge">${harnessIcon(harness)}</span>
        <span class="roster-label">${who}</span>
        <span class="roster-intent" title="${escapeHtml(scope)}">${escapeHtml(scope)}</span>
        <span class="roster-meta">${meta}</span>
      </div>`;
}
