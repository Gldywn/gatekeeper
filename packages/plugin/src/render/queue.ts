import { capitalize, clock, escapeHtml, relAge, withSqlKeywords } from "../html";
import {
  buildingIcon,
  clockIcon,
  copyIcon,
  dbReadsIcon,
  messageIcon,
  pencilIcon,
  sendIcon,
  trashIcon,
  warnIcon,
  xCircleIcon,
} from "../icons";
import { classifyQuery, type RiskClass, rank } from "../sql/classify";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import { modeRank, type RiskMode } from "../sql/mode";
import { visibleControls } from "../sql/sanitize";
import { analyzeTableOps, type SchemaContext } from "../sql/schema";
import type { Card, CardState, RunState } from "../types";
import { AUTO_APPROVED, AUTO_LEADS, autoIcon, NOTHING_SENT } from "./auto";

const WRITE_MODE_NOTE = "Write mode required to approve this query.";
const DESTRUCTIVE_MODE_NOTE = "Destructive mode required to approve this query.";
const CONNECTION_NOTE = "Connection is read-only; this write cannot run.";
const MULTI_STATEMENT_NOTE = "A single, non-empty SQL statement is required.";

const ALERT_ICON =
  '<svg viewBox="0 0 16 16" fill="none"><path d="M8 1.7 1 14h14L8 1.7Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.3v3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".8" fill="currentColor"/></svg>';

// The armed-mode decision for one card: risk class, whether Approve is live, its
// label, and (when not) the blocked-note text. Shared with the app's deny form.
export interface CardGate {
  cls: RiskClass;
  approveEnabled: boolean;
  approveLabel: string;
  note: string;
  // False when the statement defeated the parser: it rode the text fallback, so the class
  // is a guess and the card must say so rather than let the verdict look authoritative.
  parseOk: boolean;
}

function approveLabelFor(cls: RiskClass): string {
  return cls === "destructive"
    ? "Approve destructive"
    : cls === "write"
      ? "Approve write"
      : "Approve";
}

export function cardGate(
  sql: string,
  dialect: string,
  mode: RiskMode,
  connReadOnly: boolean,
): CardGate {
  const v = classifyQuery(sql, dialect);
  const cls = v.class;
  const approvable = !v.blocked && rank(cls) <= modeRank(mode);
  // A write/destructive the armed mode would allow, but the connection is definitely
  // unwritable (a read-only Beekeeper connection or a replica endpoint).
  const connBlocked = approvable && cls !== "read" && mode !== "read" && connReadOnly;
  let note = "";
  if (!approvable) {
    note = v.blocked
      ? MULTI_STATEMENT_NOTE
      : cls === "destructive"
        ? DESTRUCTIVE_MODE_NOTE
        : WRITE_MODE_NOTE;
  } else if (connBlocked) {
    note = CONNECTION_NOTE;
  }
  return {
    cls,
    approveEnabled: approvable && !connBlocked,
    approveLabel: approveLabelFor(cls),
    note,
    parseOk: v.parseOk,
  };
}

// The textual fallback can land on any class, not only destructive: a SELECT the parser
// chokes on (an ambiguous backslash in a regex, say) still reads as a read. Name the class
// it guessed rather than claim one.
// Shown standing, not on hover: an unparsed statement's class is a guess, so the note says so
// where the reader looks, in the same voice as Auto mode's review notes.
function unparsedNote(gate: CardGate): string {
  if (gate.parseOk) {
    return "";
  }
  return `<div class="cs-unparsed">${warnIcon}This statement could not be parsed. The ${gate.cls} classification is a guess. Waiting for your review.</div>`;
}

export const AUTO_EVALUATING = "Evaluating with Jev";
const EVAL_NOTE = "Auto mode is evaluating this read with Jev.";

// One line that names Auto mode first, says where the read stands, and only then carries
// the reason. Whether the query ever left the machine is the part a human must not guess.
function autoNote(card: Card): string {
  if (!card.autoStatus) {
    return "";
  }
  if (card.autoStatus === AUTO_EVALUATING) {
    // A human can approve mid-evaluation; once the card left ready, nothing is evaluating it.
    if (card.state !== "ready") return "";
    return `<div class="cs-unparsed auto evaluating" role="status"><span class="auto-bolt">${autoIcon}</span><span><b>Auto mode:</b> <i>${AUTO_EVALUATING}&hellip;</i></span></div>`;
  }
  if (card.autoStatus === AUTO_APPROVED) {
    return `<div class="cs-unparsed auto" role="status">${autoIcon}<span><b>Auto mode:</b> ${AUTO_LEADS.automatic}.</span></div>`;
  }
  const lead = card.evaluation
    ? `${AUTO_LEADS.refused}, waiting for your review.`
    : card.autoSent
      ? `${AUTO_LEADS.unfinished}, waiting for your review.`
      : `${AUTO_LEADS.local}, waiting for your review. ${NOTHING_SENT}`;
  // Each reason reads as its own tag rather than as more sentence: Jev returns them as a
  // list, and a local refusal carries one.
  const reasons = card.evaluation?.reasons?.length
    ? card.evaluation.reasons
    : card.autoStatus
        .replace(/^Needs review:\s*/, "")
        .split(/\.\s+/)
        .filter(Boolean);
  const tags = reasons
    .map(
      (reason) =>
        `<span class="auto-reason over">${withSqlKeywords(reason.replace(/\.$/, ""))}</span>`,
    )
    .join("");
  return `<div class="cs-unparsed auto" role="status">${autoIcon}<span><b>Auto mode:</b> ${lead}<span class="auto-reasons">${tags}</span></span></div>`;
}

export function cardHtml(
  card: Card,
  dialect: string,
  denyDrafts: Map<string, string>,
  mode: RiskMode = "read",
  connReadOnly = false,
): string {
  const evaluating = card.state === "ready" && card.autoStatus === AUTO_EVALUATING;
  // An evaluation in flight borrows the blocked-Approve chrome: the reason rides in the
  // same popover, and Reject stays open for a human who has already made up their mind.
  const gate = evaluating
    ? { ...cardGate(card.sql, dialect, mode, connReadOnly), approveEnabled: false, note: EVAL_NOTE }
    : cardGate(card.sql, dialect, mode, connReadOnly);
  const remaining = card.expiresAt - Date.now();
  const run = card.state === "executing" ? card.run : undefined;
  let actions: string;
  if (run) {
    actions = runningActions(card.id, run);
  } else if (card.state !== "ready") {
    actions = `<div class="actions"><span class="busy"><span class="spin"></span>${busyLabel(card.state)}&hellip;</span></div>`;
  } else {
    actions = readyActions(card.id, gate, denyDrafts);
  }
  const badge = riskBadge(gate.cls);
  const riskAnno = riskAnnotation(card.sql, dialect, gate.cls);
  // The expiry clock only means something while the proposal waits for a decision.
  const lease =
    card.state === "ready"
      ? `<span class="${remaining <= 45_000 ? "lease low" : "lease"}">${clock(remaining)}</span>`
      : "";
  return `
      <div class="card ${cardClassFor(gate)}${evaluating ? " auto-eval" : ""}${run ? runClass(run) : ""}" data-card="${card.id}">
        <div class="top">
          ${badge}${evaluating ? `<span class="auto-mark" title="${EVAL_NOTE}" aria-label="${EVAL_NOTE}">${autoIcon}</span>` : ""}${card.intent ? `<span class="intent">${escapeHtml(capitalize(card.intent))}</span>` : `<span class="intent">${escapeHtml(card.id)}</span>`}
          ${lease}
        </div>
        <div class="meta">${escapeHtml(card.id)} &middot; ${relAge(card.createdAt)}</div>
        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(visibleControls(card.sql))}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="sqlbody-${card.id}">${highlight(formatSql(card.sql), card.schema?.pii, card.schema?.client, card.schema?.literals)}</code></pre>
        ${unparsedNote(gate)}${riskAnno}<div class="card-schema" id="cs-${card.id}">${schemaInner(card.schema, gate.cls !== "read")}</div>
        ${autoNote(card)}${actions}
      </div>`;
}

// The card's risk tokens: a write/destructive class colour, plus .blocked when the
// armed mode or the connection stops approval (reuses today's chrome).
function cardClassFor(gate: CardGate): string {
  const risk = gate.cls === "write" ? "write" : gate.cls === "destructive" ? "destructive" : "";
  const blocked = gate.approveEnabled ? "" : "blocked";
  return [risk, blocked].filter(Boolean).join(" ");
}

// The class chip in .top: none for a read, "Write" (amber) or "Destructive" (red),
// matching the mode names.
function riskBadge(cls: RiskClass): string {
  if (cls === "write") {
    return `<span class="risk-badge write">Write</span>`;
  }
  if (cls === "destructive") {
    return `<span class="risk-badge destructive">Destructive</span>`;
  }
  return "";
}

// The tables a statement touches, by role in one word: Delete for what removes data (DELETE,
// DROP, TRUNCATE), Write for every other change, Read for what a mixed statement reads.
function riskAnnotation(sql: string, dialect: string, cls: RiskClass): string {
  if (cls === "read") {
    return "";
  }
  const ops = analyzeTableOps(sql, dialect);
  if (!ops) {
    return "";
  }
  const removes = ["delete", "drop", "truncate"].includes(ops.writeOp ?? "");
  const label = removes ? "Delete" : "Write";
  const icon = removes ? trashIcon : pencilIcon;
  const tone = cls === "destructive" ? "destructive" : "write";
  const writesLine = ops.writes.length
    ? `<div class="cs-writes ${tone}"><span class="cs-writes-k">${icon}${label}</span>${tblChips(ops.writes)}</div>`
    : "";
  const readsLine = ops.reads.length
    ? `<div class="cs-reads"><span class="cs-reads-k">${dbReadsIcon}Read</span>${tblChips(ops.reads)}</div>`
    : "";
  if (!writesLine && !readsLine) {
    return "";
  }
  return `<div class="card-risk">${writesLine}${readsLine}</div>`;
}

function tblChips(tables: string[]): string {
  return tables.map((t) => `<span class="tbl-chip">${escapeHtml(t)}</span>`).join("");
}

export function readyActions(id: string, gate: CardGate, denyDrafts: Map<string, string>): string {
  const revise = denyDrafts.has(id)
    ? denyField(id, denyDrafts.get(id) ?? "")
    : `<button class="deny-open" type="button" data-deny-open="${id}" title="Reject and ask the agent to change something">${messageIcon}Request changes</button>`;
  const tone = gate.cls === "destructive" ? " destructive" : gate.cls === "write" ? " write" : "";
  const approveBtn = `<button class="btn approve${tone}" type="button" data-approve="${id}" ${gate.approveEnabled ? "" : "disabled"}>${gate.approveLabel}</button>`;
  // When blocked, the reason rides in a hover popover above the disabled Approve,
  // not as a loose line in the card body.
  const approve = gate.note
    ? `<span class="approve-slot">${approveBtn}<span class="approve-pop" role="tooltip">${ALERT_ICON}${escapeHtml(gate.note)}</span></span>`
    : approveBtn;
  return `<div class="actions">
             ${approve}
             <button class="btn reject" type="button" data-reject="${id}">Reject</button>
             ${revise}
           </div>`;
}

// Reject-with-a-revision: an inline field, right of Reject, whose note is the
// change the human wants; sent to the agent on Enter or the send affordance.
export function denyField(id: string, value = ""): string {
  return `<div class="deny-field">
             <input class="deny-reason" type="text" maxlength="140" data-deny-input="${id}" aria-label="What should the agent change?" placeholder="What should the agent change?" autocomplete="off" spellcheck="false" value="${escapeHtml(value)}" />
             <button class="deny-send" type="button" data-deny="${id}" aria-label="Send to the agent">${sendIcon}</button>
           </div>`;
}

// hideReads drops the "Reads" line on a write/destructive card, whose tables the risk
// annotation already lists; the sensitive-column flags still stand on their own.
export function schemaInner(schema: SchemaContext | null | undefined, hideReads = false): string {
  if (!schema) {
    return "";
  }
  const tables =
    !hideReads && schema.tables.length
      ? `<div class="cs-reads"><span class="cs-reads-k">${dbReadsIcon}Read</span>${schema.tables.map((t) => `<span class="tbl-chip">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";
  const pii = schema.pii.length
    ? `<div class="cs-line cs-pii"><span class="cs-warn">${warnIcon}possible PII</span><span class="cs-list">${schema.pii.map(escapeHtml).join(" &middot; ")}</span></div>`
    : "";
  const client = schema.client.length
    ? `<div class="cs-line cs-client"><span class="cs-warn">${buildingIcon}client data</span><span class="cs-list">${schema.client.map(escapeHtml).join(" &middot; ")}</span></div>`
    : "";
  const literal = schema.literals.length
    ? `<div class="cs-line cs-literal"><span class="cs-warn">${warnIcon}sensitive value</span><span class="cs-list">${schema.literals.map((v) => escapeHtml(`'${v}'`)).join(" &middot; ")}</span></div>`
    : "";
  return tables + pii + client + literal;
}

export function busyLabel(state: CardState): string {
  if (state === "approving") return "Approving";
  if (state === "executing") return "Running";
  if (state === "posting") return "Returning rows";
  return "Rejecting";
}

// Past this, a run reads as long: the clock and Stop turn amber and Stop pulses.
export const LONG_RUN_MS = 45_000;

export function runClass(run: RunState, now = Date.now()): string {
  return now - run.startedAt >= LONG_RUN_MS ? " running long" : " running";
}

// Stop takes Approve's place, live from the first frame. Unavailable reads as a warning
// on the disabled button; a failed stop is an error note with the database's own text.
export function runningActions(id: string, run: RunState, now = Date.now()): string {
  const elapsed = now - run.startedAt;
  const stop = run.stop;
  const stopping = stop?.state === "pending" || stop?.state === "sent";
  const button = `<button class="btn stop" type="button" data-stop="${id}"${run.unavailable || stopping ? " disabled" : ""}><span class="sq" aria-hidden="true"></span>${stopping ? "Stopping&hellip;" : "Stop"}</button>`;
  const control = run.unavailable
    ? `<span class="approve-slot">${button}<span class="approve-pop warn" role="tooltip">${ALERT_ICON}${escapeHtml(run.unavailable)}</span></span>`
    : button;
  const limit =
    run.limitMs && !run.unavailable && !stop
      ? `<span class="autostop" title="Auto-stop is set to ${run.limitMs / 60_000} min on this connection">${clockIcon}Auto-stop in<span class="clock autostop-clock">${clock(run.limitMs - elapsed)}</span></span>`
      : "";
  const error = stop?.error
    ? `<div class="cs-unparsed stop-error" role="status">${xCircleIcon}<span class="stop-msg"><span>An error occurred while stopping the query.</span><span class="stop-raw">${escapeHtml(stop.error)}</span></span></div>`
    : "";
  return `<div class="actions">${control}<span class="run"><span class="spin"></span>Running<span class="clock run-clock">${clock(elapsed)}</span></span>${limit}</div>${error}`;
}
