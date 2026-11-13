import type { ApprovalAttribution, AutoEvaluation, EvaluationFailure } from "@gatekeeper/shared";
import {
  AXES,
  AXIS_CONCERNS,
  AXIS_LABELS,
  type Axis,
  builtInAvailable,
  type EvaluatorSettings,
  firstMissing,
  HOSTED_MODELS,
  keyRequired,
  PROVIDER_NAMES,
  type Provider,
  recipient,
} from "../evaluator";
import { escapeHtml } from "../html";
import { chevronLeft, chevronRight, copyIcon, xIcon } from "../icons";
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

// The cutoffs a record is graded by: its own, else the built-in ones for the exact evaluator and
// policy they were written for. Anything else, malformed recorded cutoffs included, has none.
function cutoffsOf(e: AutoEvaluation): Record<string, number> | undefined {
  return e.thresholds !== undefined
    ? recordedCutoffs(e.thresholds)
    : e.provider === "typesafe" && e.model === AUTO_MODEL && e.policy === AUTO_POLICY
      ? (AUTO_THRESHOLDS as Record<string, number>)
      : undefined;
}

// The questions that went over their cutoff, as the decision itself compares: strictly above.
function concerns(e: AutoEvaluation): string | undefined {
  const cutoffs = cutoffsOf(e);
  const over = AXES.filter((id) => {
    const p = e.probabilities[id];
    return cutoffs?.[id] !== undefined && typeof p === "number" && p > cutoffs[id];
  });
  return over.length
    ? new Intl.ListFormat("en", { type: "conjunction" }).format(over.map((id) => AXIS_CONCERNS[id]))
    : undefined;
}

// A reason up to its first colon, as the record keeps it: what follows may name a source.
const firstSentence = (reason: string) =>
  reason
    .split(":")[0]
    .split(/\.\s/)[0]
    .replace(/[.\s]+$/, "");

function failureText(model: string | undefined, f: EvaluationFailure): string {
  const who = model ?? "The evaluator";
  if (f.stage === "timeout") return `${who} did not answer in time.`;
  if (f.stage === "network") return `${who} could not be reached.`;
  if (f.stage === "http")
    return `${who} answered with an error${f.status ? ` (HTTP ${f.status})` : ""}.`;
  if (f.stage === "response") return `${who} returned an invalid answer.`;
  return "The evaluation did not finish.";
}

/** What Auto mode did with a read, as plain text (escape it where it meets HTML): the same
 *  sentence on the pending card, in the history and in the export. The evaluator gives a
 *  probability per question and no words, so the reason is the questions it went over. */
export function autoOutcome(evaluation?: AutoEvaluation, hold?: AutoHold): string {
  if (hold?.failure) return failureText(hold.model ?? evaluation?.model, hold.failure);
  if (evaluation) {
    if (!evaluation.eligible || evaluation.reasons.length) {
      const why = concerns(evaluation);
      return `${evaluation.model} did not clear this read${why ? `: ${why}` : ""}.`;
    }
    return hold
      ? `${evaluation.model} cleared this read, then it was held: ${firstSentence(hold.reason)}.`
      : `${AUTO_LEADS.cleared}.`;
  }
  if (hold?.sent)
    return `The evaluation did not finish${hold.reason ? `: ${firstSentence(hold.reason)}` : ""}.`;
  return `${AUTO_LEADS.held}${hold?.reason ? `: ${firstSentence(hold.reason)}` : ""}.`;
}

// Nothing left the machine: the one fact a local hold adds after its sentence.
export const heldLocally = (evaluation?: AutoEvaluation, hold?: AutoHold) =>
  !evaluation && !hold?.sent;

// Card status once the evaluator cleared a read and Gatekeeper took it to execution; it
// replaces the evaluating state, which would otherwise stay up for the whole run.
export const AUTO_APPROVED = "Approved automatically";

const title = `<span class="sa-pt">${autoIcon}Auto mode</span>`;

// The recipient is the one name the copy keeps: enabling consents to sending it the input.
// The app rewrites these spans when the evaluator changes, without rebuilding their markup.
export function recipientHtml(s: EvaluatorSettings | undefined): string {
  return `<span data-auto-recipient>${escapeHtml(recipient(s))}</span>`;
}

// Both states are rendered once and swapped by data-on on the wrapper, like Schema access.
export function autoPopHtml(s: EvaluatorSettings | undefined): string {
  return `<span class="sa-pop auto-body">
          <span class="sa-body sa-off">
            ${title}
            <p>Eligible <code class="kw">SELECT</code> reads run automatically and return their results to your agent. Everything else waits for you, and <b>Write and Destructive always need your approval</b>. ${recipientHtml(s)} receives the SQL structure and the schema names it reads, never result rows.</p>
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

// The evaluator in one line: model and provider, the state of its cutoffs, and Change, which
// opens the evaluator page. A damaged stored choice reads as none.
function evaluatorLineHtml(s: EvaluatorSettings | undefined): string {
  const missing = s ? firstMissing(s) : "provider";
  const state = !missing
    ? s?.builtIn
      ? "Built-in cutoffs"
      : "Your cutoffs"
    : (AXES as string[]).includes(missing)
      ? "Cutoffs needed"
      : "Setup needed";
  const who = !s
    ? "No evaluator chosen"
    : `<span class="ev-model">${escapeHtml(s.model || "No model")}</span> on ${PROVIDER_NAMES[s.provider]}`;
  return `<button class="ev-row" type="button" data-evaluator-open aria-labelledby="evLabel evLine"><span class="ev-facts" id="evLine"><span class="ev-who">${who}</span><span class="dsep" aria-hidden="true"></span><span class="ev-state${missing ? " need" : ""}">${state}</span></span><span class="ev-go">Change${chevronRight}</span></button>`;
}

// The app mirrors data-on onto the #autoSettings wrapper so this markup is never rebuilt
// under the cursor; the evaluator's own fields live on the evaluator page.
export function autoSettingsHtml(enabled: boolean, s: EvaluatorSettings | undefined): string {
  return `<div class="set-row recommend auto auto-body">
            <div class="set-text">
              <span class="set-name"><span class="set-ico">${autoIcon}</span>Auto mode</span>
              <span class="set-desc">Run eligible reads without your approval and return their results to your agent.</span>
              <span class="set-note">PostgreSQL only. ${recipientHtml(s)} sees the SQL structure and the schema names and types it reads, never result rows.</span>
              <span class="set-name ev-label" id="evLabel">Evaluator</span>
              ${evaluatorLineHtml(s)}
              <p class="auto-message" data-auto-message role="status"></p>
            </div>
            <span class="set-control"><input class="switch" type="checkbox" role="switch" data-auto-toggle aria-label="Auto mode"${enabled ? " checked" : ""} /></span>
          </div>`;
}

const field = (label: string, id: string, input: string) =>
  `<div class="auto-key"><label class="set-name" for="${id}">${label}</label>${input}</div>`;
const textInput = (id: string, name: string, value: string, extra = "") =>
  `<input id="${id}" class="confirm-input" type="text" data-ev-field="${name}" autocomplete="off" spellcheck="false" value="${escapeHtml(value)}"${extra}>`;

// The evaluator page replaces Settings' content in the same dialog. Every field saves on
// change; the key saves as typed, in the slot of the destination it was typed for.
export function evaluatorPageHtml(s: EvaluatorSettings | undefined, keySaved: boolean): string {
  const current: EvaluatorSettings = s ?? {
    provider: "typesafe",
    model: "",
    baseUrl: "",
    builtIn: false,
    cutoffs: Object.fromEntries(AXES.map((id) => [id, null])) as EvaluatorSettings["cutoffs"],
  };
  const providers = (Object.keys(PROVIDER_NAMES) as Provider[])
    .map(
      (p) =>
        `<label class="ex-opt"><input class="ex-radio" type="radio" name="evProvider" id="evProvider-${p}" value="${p}" data-ev-field="provider"${s && s.provider === p ? " checked" : ""}><span class="ex-name">${PROVIDER_NAMES[p]}</span><span class="ex-when">${p === "custom" ? "Self-hosted" : "Hosted"}</span></label>`,
    )
    .join("");
  const where =
    current.provider === "custom"
      ? `<div class="ev-pair">${field("Server URL", "evBaseUrl", textInput("evBaseUrl", "baseUrl", current.baseUrl, ' inputmode="url" maxlength="2048"'))}${field("Model", "evModel", textInput("evModel", "model", current.model, ' maxlength="100"'))}</div>
          <span class="set-note">Plain http is accepted for 127.0.0.1 only.</span>`
      : `${field(
          "Model",
          "evModel",
          `<select class="set-select" id="evModel" data-ev-field="model">${HOSTED_MODELS[
            current.provider
          ]
            .map(
              (m) => `<option value="${m}"${m === current.model ? " selected" : ""}>${m}</option>`,
            )
            .join("")}</select>`,
        )}`;
  const key = `${field(
    "API key",
    "autoKey",
    `<input id="autoKey" class="confirm-input" type="password" data-auto-key autocomplete="off" spellcheck="false" maxlength="4096"${keySaved ? ` value="${SAVED_KEY_MASK}"` : ""}>`,
  )}${!keyRequired(current) ? `<button class="pair-link ev-remove" type="button" data-key-remove${keySaved ? "" : " hidden"}>Remove key</button>` : ""}`;
  const builtIn = builtInAvailable(current);
  const cuts = AXES.map((id) => {
    const v = current.cutoffs[id];
    return `<div class="ev-cut"><label for="evCut-${id}">${AXIS_LABELS[id]}</label><input id="evCut-${id}" class="confirm-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-ev-cut="${id}" value="${v === null ? "" : String(v)}"${current.builtIn ? " disabled" : ""}></div>`;
  }).join("");
  return `
      <div class="detail-card settings-card" role="dialog" aria-modal="true" aria-labelledby="evTitle">
        <div class="panel-head">
          <button class="ev-back" type="button" data-evaluator-back aria-label="Back to Settings">${chevronLeft}</button>
          <span class="panel-title" id="evTitle">Auto mode evaluator</span>
          <button class="detail-close" type="button" data-close aria-label="Close settings">${xIcon}</button>
        </div>
        <div class="ev-page">
          <p class="set-desc">The model that judges each eligible read before it runs, and the cutoffs that decide.</p>
          <div class="ev-sec">
            <span class="set-group-name" id="evProviderLabel">Provider</span>
            <div class="ex-opts" role="radiogroup" aria-labelledby="evProviderLabel">${providers}</div>
          </div>
          <div class="ev-sec">
            ${where}
            ${key}
            <div class="ev-test"><button class="pair-link" type="button" data-evaluator-test>Test connection</button><p class="auto-message" data-ev-message role="status"></p></div>
            <span class="set-note">Stored in Beekeeper encrypted storage. Sent only to the local broker and the evaluator.</span>
          </div>
          <div class="ev-sec">
            <span class="set-group-name">Cutoffs</span>
            ${
              builtIn
                ? `<div class="ev-preset"><input class="ex-check" type="checkbox" id="evBuiltIn" data-ev-field="builtIn"${current.builtIn ? " checked" : ""}><label for="evBuiltIn">Use the built-in cutoffs</label></div>`
                : '<span class="set-desc">No built-in cutoffs for this model.</span>'
            }
            <div class="ev-cuts">${cuts}</div>
            ${
              current.builtIn
                ? ""
                : `<span class="set-note">Your agent can measure them on Gatekeeper's synthetic reads and suggest four values.</span>
            <button class="sa-enable tonal ev-copy" type="button" data-copy-prompt>${copyIcon}Copy prompt for your agent</button>`
            }
          </div>
        </div>
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
  if (!e) {
    return hold
      ? `<div class="auto-trace"><div class="auto-trace-line">${autoIcon}<span><b>Auto mode:</b> ${escapeHtml(autoOutcome(undefined, hold))}${heldLocally(undefined, hold) ? ` ${NOTHING_SENT}` : ""}</span></div></div>`
      : "";
  }
  // The hold rides the final decision, so it outranks an automatic approval left on record by
  // an earlier, withdrawn attempt.
  const lead =
    approval?.source === "automatic" && !hold
      ? `${AUTO_LEADS.automatic}.`
      : escapeHtml(autoOutcome(e, hold));
  // Cutoffs only mean something for the rule they were recorded with; without one, the numbers
  // stand without a verdict painted on them.
  const cutoffs = cutoffsOf(e);
  const axes = Object.entries(e.probabilities)
    .map(([id, value]) => {
      const cutoff = cutoffs?.[id];
      const over = cutoff !== undefined && value > cutoff;
      const label = Object.hasOwn(AXIS_LABELS, id) ? AXIS_LABELS[id as Axis] : id;
      const graded = cutoff === undefined ? "" : ` ${over ? ">" : "≤"} ${cutoff}`;
      return `<span class="auto-reason metric${over ? " over" : ""}">${escapeHtml(`${label} ${value}${graded}`)}</span>`;
    })
    .join("");
  const provider = Object.hasOwn(PROVIDER_NAMES, e.provider)
    ? PROVIDER_NAMES[e.provider as Provider]
    : e.provider;
  // A Custom server is named by the origin its record kept; cutoffs are named only when the
  // user set them, since the built-in ones are the default reading.
  const host = typeof e.endpoint === "string" ? ` at ${safeHost(e.endpoint)}` : "";
  const whose = e.builtIn === false ? ", with your cutoffs" : "";
  return `<div class="auto-trace">
      <div class="auto-trace-line">${autoIcon}<span><b>Auto mode:</b> ${lead} <span class="auto-who">Evaluated by ${escapeHtml(e.model)} on ${escapeHtml(provider)}${escapeHtml(host)}${whose}.</span></span></div>
      <div class="auto-reasons">${axes}</div>
      <div class="auto-trace-meta"><span>policy ${escapeHtml(e.policy)}</span><span>${escapeHtml(new Date(e.evaluatedAt).toISOString())}</span><span>${escapeHtml(e.sqlDigest)}</span></div>
    </div>`;
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.slice(0, 100);
  }
}

/** The reason the app records when an evaluation refuses a read (app.ts evaluateNext). */
export function refusalReason(evaluation: AutoEvaluation): string {
  return evaluation.reasons?.join(". ") || "Evaluator uncertainty or stale policy/model";
}
