import type { ApprovalAttribution, AutoEvaluation } from "@gatekeeper/shared";
import { escapeHtml } from "../html";
import { AUTO_POLICY, AUTO_THRESHOLDS } from "../sql/auto";
import type { AutoHold } from "../types";

export const autoIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13 3-9 11h7l-1 7 10-12h-7z"/></svg>';
export const autoDisclosure =
  "Eligible reads execute automatically and return results to the requesting agent. TypeSafe receives SQL structure and referenced schema names and types. Free literals and known sensitive inputs stay local. No result rows are sent to TypeSafe. Names can still be confidential. Jev can be wrong, and this beta has not been calibrated with live evaluations. Confirming Write or Destructive turns off Auto mode. Disabling Auto mode directly leaves Read only and does not stop SQL already running.";

// Stands in for a saved key, so the field reads as filled without the key ever returning
// to the page. Bullets fall outside the key alphabet, so the mask can never pass as a key.
export const SAVED_KEY_MASK = "\u2022".repeat(24);

// The same sentences on the pending card and on the kept record.
export const AUTO_LEADS = {
  local: "A local check flagged this read before evaluation",
  unfinished: "The evaluation did not finish",
  refused: "The evaluation did not clear this read",
  cleared: "The evaluation cleared this read",
  automatic: "This read was approved automatically",
} as const;
export const NOTHING_SENT = '<b class="auto-strong">Nothing was sent to TypeSafe.</b>';

const title = `<span class="sa-pt">${autoIcon}Auto mode <span class="set-rec auto">beta</span></span>`;

// Both states are rendered once and swapped by data-on on the wrapper, like Schema access.
export function autoPopHtml(): string {
  return `<span class="sa-pop auto-body">
          <span class="sa-body sa-off">
            ${title}
            <p>Eligible <code>SELECT</code> reads run automatically and return their results to your agent. Everything else waits for you, and <b>Write and Destructive always need your approval</b>. TypeSafe receives the SQL structure and the schema names it reads, never result rows.</p>
            <button class="sa-enable" type="button" data-auto-toggle>Enable Auto mode</button>
            <p class="auto-message" data-auto-message role="status"></p>
          </span>
          <span class="sa-body sa-on">
            ${title}
            <p>Eligible <code>SELECT</code> reads now run without your approval. Everything else still waits for you, and <b>confirming Write or Destructive turns off Auto mode</b>.</p>
            <button class="sa-enable tonal" type="button" data-auto-toggle>Disable Auto mode</button>
          </span>
        </span>`;
}

// The key stays editable in both states and saves as typed; the app mirrors data-on onto
// the #autoSettings wrapper so this markup is never rebuilt under the cursor.
export function autoSettingsHtml(enabled: boolean, keySaved = false): string {
  return `<div class="set-row recommend auto auto-body">
            <div class="set-text">
              <span class="set-name"><span class="set-ico">${autoIcon}</span>Auto mode <span class="set-rec auto">beta</span></span>
              <span class="set-desc">${autoDisclosure}</span>
              <div class="auto-key"><label class="set-name" for="autoKey">TypeSafe API key</label><input id="autoKey" class="confirm-input" type="password" data-auto-key autocomplete="off" spellcheck="false" maxlength="4096" placeholder="apikey_0123456789"${keySaved ? ` value="${SAVED_KEY_MASK}"` : ""}></div>
              <p class="auto-message" data-auto-message role="status"></p>
              <span class="set-desc">Stored in Beekeeper encrypted storage. Sent only to the local broker and TypeSafe.</span>
            </div>
            <span class="set-control"><input class="switch" type="checkbox" role="switch" data-auto-toggle aria-label="Auto mode"${enabled ? " checked" : ""} /></span>
          </div>`;
}

export function approvalLabel(approval?: ApprovalAttribution): string {
  return approval?.source === "automatic"
    ? "Approved automatically"
    : approval?.source === "human"
      ? "Approved by you"
      : "Approval source not recorded";
}

export function approvalHtml(
  approval?: ApprovalAttribution,
  evaluation?: AutoEvaluation,
  hold?: AutoHold,
): string {
  const e = approval?.evaluation ?? evaluation;
  // No evaluation: either Auto mode held the read before it ever left, which is worth
  // recording on its own, or Auto mode never touched it and there is nothing to say.
  if (!e) {
    if (!hold) return "";
    const lead = hold.sent ? `${AUTO_LEADS.unfinished}.` : `${AUTO_LEADS.local}. ${NOTHING_SENT}`;
    return `<div class="auto-trace">
      <div class="auto-trace-line">${autoIcon}<span><b>Auto mode:</b> ${lead}</span></div>
      <div class="auto-reasons"><span class="auto-reason over">${escapeHtml(hold.reason.replace(/\.$/, ""))}</span></div>
    </div>`;
  }
  const lead =
    approval?.source === "automatic"
      ? `${AUTO_LEADS.automatic}.`
      : e.eligible && !e.reasons.length
        ? `${AUTO_LEADS.cleared}.`
        : `${AUTO_LEADS.refused}.`;
  // Cutoffs only mean something for the policy they were written for; an older
  // evaluation keeps its numbers without a verdict painted on them.
  const graded = e.policy === AUTO_POLICY;
  const axes = Object.entries(e.probabilities)
    .map(([id, value]) => {
      const cutoff = AUTO_THRESHOLDS[id as keyof typeof AUTO_THRESHOLDS];
      const over =
        graded && cutoff !== undefined && (id === "read_only" ? value < cutoff : value > cutoff);
      return `<span class="auto-reason metric${over ? " over" : ""}">${escapeHtml(id)} ${escapeHtml(String(value))}</span>`;
    })
    .join("");
  const reasons = e.reasons
    .map((reason) => `<span class="auto-reason over">${escapeHtml(reason)}</span>`)
    .join("");
  return `<div class="auto-trace">
      <div class="auto-trace-line">${autoIcon}<span><b>Auto mode:</b> ${lead}</span></div>
      ${reasons ? `<div class="auto-reasons">${reasons}</div>` : ""}
      <div class="auto-reasons">${axes}</div>
      <div class="auto-trace-meta">${escapeHtml(e.provider)} &middot; ${escapeHtml(e.model)} &middot; policy ${escapeHtml(e.policy)} &middot; ${escapeHtml(new Date(e.evaluatedAt).toISOString())} &middot; ${escapeHtml(e.sqlDigest)}</div>
    </div>`;
}
