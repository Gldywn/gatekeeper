import type { ApprovalAttribution, AutoEvaluation } from "@gatekeeper/shared";
import { escapeHtml } from "../html";
import { AUTO_MODEL, AUTO_POLICY, AUTO_THRESHOLDS, recordedCutoffs } from "../sql/auto";
import type { AutoHold } from "../types";

export const autoIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13 3-9 11h7l-1 7 10-12h-7z"/></svg>';

// Stands in for a saved key, so the field reads as filled without the key ever returning
// to the page. Bullets fall outside the key alphabet, so the mask can never pass as a key.
export const SAVED_KEY_MASK = "\u2022".repeat(24);

// The same sentences on the pending card and on the kept record, for every evaluator: a hold
// says only where it happened, on this machine before anything left, or at the evaluator.
export const AUTO_LEADS = {
  held: "Held on this machine before evaluation",
  cleared: "The evaluation cleared this read",
  automatic: "This read was approved automatically",
} as const;
export const NOTHING_SENT = '<b class="auto-strong">Nothing was sent to the evaluator.</b>';

// Names the model only when an answer from it is on record; a timeout or an error has none.
function refusedLead(model?: string): string {
  return `${model ? escapeHtml(model) : "The evaluator"} did not clear this read`;
}

// A hold says where it happened, and a local one that nothing left the machine.
export function holdText(sent: boolean, tail = "", model?: string): string {
  return `${sent ? refusedLead(model) : AUTO_LEADS.held}.${tail}${sent ? "" : ` ${NOTHING_SENT}`}`;
}

// The products behind the provider ids a record can carry.
const PROVIDER_NAMES: Record<string, string> = { typesafe: "TypeSafe" };

// Card status once the evaluator cleared a read and Gatekeeper took it to execution; it
// replaces the evaluating state, which would otherwise stay up for the whole run.
export const AUTO_APPROVED = "Approved automatically";

const title = `<span class="sa-pt">${autoIcon}Auto mode</span>`;

// Both states are rendered once and swapped by data-on on the wrapper, like Schema access.
export function autoPopHtml(): string {
  return `<span class="sa-pop auto-body">
          <span class="sa-body sa-off">
            ${title}
            <p>Eligible <code class="kw">SELECT</code> reads run automatically and return their results to your agent. Everything else waits for you, and <b>Write and Destructive always need your approval</b>. TypeSafe receives the SQL structure and the schema names it reads, never result rows.</p>
            <button class="sa-enable" type="button" data-auto-toggle>Enable Auto mode</button>
            <p class="auto-message" data-auto-message role="status"></p>
          </span>
          <span class="sa-body sa-on">
            ${title}
            <p>Eligible <code class="kw">SELECT</code> reads now run without your approval. Everything else still waits for you, and <b>confirming Write or Destructive turns off Auto mode</b>.</p>
            <button class="sa-enable tonal" type="button" data-auto-toggle>Disable Auto mode</button>
          </span>
        </span>`;
}

// The key stays editable in both states and saves as typed; the app mirrors data-on onto
// the #autoSettings wrapper so this markup is never rebuilt under the cursor.
export function autoSettingsHtml(enabled: boolean, keySaved = false): string {
  return `<div class="set-row recommend auto auto-body">
            <div class="set-text">
              <span class="set-name"><span class="set-ico">${autoIcon}</span>Auto mode</span>
              <span class="set-desc">Run eligible reads without your approval and return their results to your agent.</span>
              <span class="set-note">PostgreSQL only. TypeSafe sees the SQL structure and the schema names and types it reads, never result rows.</span>
              <div class="auto-key"><label class="set-name" for="autoKey">API key</label><input id="autoKey" class="confirm-input" type="password" data-auto-key autocomplete="off" spellcheck="false" maxlength="4096" placeholder="apikey_0123456789"${keySaved ? ` value="${SAVED_KEY_MASK}"` : ""}></div>
              <p class="auto-message" data-auto-message role="status"></p>
              <span class="set-note">Stored in Beekeeper encrypted storage. Sent only to the local broker and the evaluator.</span>
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
  // With an evaluation its verdict is the sentence, so a read Jev cleared and a later check
  // held never reads as both cleared and not.
  if (!e) {
    return hold
      ? `<div class="auto-trace"><div class="auto-trace-line">${autoIcon}<span><b>Auto mode:</b> ${holdText(hold.sent)}</span></div></div>`
      : "";
  }
  const lead =
    approval?.source === "automatic"
      ? `${AUTO_LEADS.automatic}.`
      : e.eligible && !e.reasons.length
        ? `${AUTO_LEADS.cleared}.`
        : `${refusedLead(e.model)}.`;
  // Cutoffs only mean something for the rule they were recorded with: the record's own, else
  // the built-in ones for the exact evaluator and policy they were written for. Anything else,
  // malformed recorded cutoffs included, keeps its numbers without a verdict painted on them.
  const cutoffs =
    e.thresholds !== undefined
      ? recordedCutoffs(e.thresholds)
      : e.provider === "typesafe" && e.model === AUTO_MODEL && e.policy === AUTO_POLICY
        ? (AUTO_THRESHOLDS as Record<string, number>)
        : undefined;
  const axes = Object.entries(e.probabilities)
    .map(([id, value]) => {
      const cutoff = cutoffs?.[id];
      const over = cutoff !== undefined && value > cutoff;
      return `<span class="auto-reason metric${over ? " over" : ""}">${escapeHtml(id)} ${escapeHtml(String(value))}</span>`;
    })
    .join("");
  const provider = Object.hasOwn(PROVIDER_NAMES, e.provider)
    ? PROVIDER_NAMES[e.provider]
    : e.provider;
  return `<div class="auto-trace">
      <div class="auto-trace-line">${autoIcon}<span><b>Auto mode:</b> ${lead} <span class="auto-who">Evaluated by ${escapeHtml(e.model)} on ${escapeHtml(provider)}.</span></span></div>
      <div class="auto-reasons">${axes}</div>
      <div class="auto-trace-meta"><span>policy ${escapeHtml(e.policy)}</span><span>${escapeHtml(new Date(e.evaluatedAt).toISOString())}</span><span>${escapeHtml(e.sqlDigest)}</span></div>
    </div>`;
}

/** The reason the app records when an evaluation refuses a read (app.ts evaluateNext). */
export function refusalReason(evaluation: AutoEvaluation): string {
  return evaluation.reasons?.join(". ") || "Evaluator uncertainty or stale policy/model";
}
