import { capitalize, clock, escapeHtml, relAge } from "../html";
import {
  checkIcon,
  clockIcon,
  copyIcon,
  messageIcon,
  sendIcon,
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
import { AUTO_APPROVED, AUTO_LEADS, autoIcon, holdText } from "./auto";

const WRITE_MODE_NOTE = "Write mode is required to approve this query.";
const DESTRUCTIVE_MODE_NOTE = "Destructive mode is required to approve this query.";
const CONNECTION_NOTE = "A writable connection is required to run this write.";
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

// One line that names Auto mode first and says where the read was held. Whether the query
// ever left the machine is the part a human must not guess.
function autoNote(card: Card): string {
  if (!card.autoStatus) {
    return "";
  }
  // An evaluation in flight speaks from the decision bar, where it blocks Approve.
  if (card.autoStatus === AUTO_EVALUATING) {
    return "";
  }
  if (card.autoStatus === AUTO_APPROVED) {
    return `<div class="cs-unparsed auto" role="status">${autoIcon}<span><b>Auto mode:</b> ${AUTO_LEADS.automatic}.</span></div>`;
  }
  return `<div class="cs-unparsed auto" role="status">${autoIcon}<span><b>Auto mode:</b> ${holdText(Boolean(card.autoSent), " Waiting for your review.")}</span></div>`;
}

// Why the last human approval did not run, in its own words: never an Auto mode fact.
const EXECUTION_NOTICES: Record<string, string> = {
  "Connection or approval authority changed":
    "The connection check failed or approval authority changed before execution.",
  "Execution stopped before SQL ran. Approval authority changed":
    "Execution was stopped before the SQL ran because the connection, approval authority or approval requirements could not be confirmed.",
};
function executionNote(card: Card): string {
  if (!card.executionNotice) return "";
  const text = Object.hasOwn(EXECUTION_NOTICES, card.executionNotice)
    ? EXECUTION_NOTICES[card.executionNotice]
    : escapeHtml(card.executionNotice);
  return `<div class="cs-unparsed" role="status">${warnIcon}<span>${text}</span></div>`;
}

// An evaluation in flight blocks Approve like a gate, its sentence above the actions, while
// Reject stays open. Shared with the app, so an action row rebuilt in place matches the card.
export function cardGateFor(
  card: Card,
  dialect: string,
  mode: RiskMode,
  connReadOnly: boolean,
): CardGate {
  const gate = cardGate(card.sql, dialect, mode, connReadOnly);
  return card.state === "ready" && card.autoStatus === AUTO_EVALUATING
    ? { ...gate, approveEnabled: false, note: EVAL_NOTE }
    : gate;
}

export function cardHtml(
  card: Card,
  dialect: string,
  denyDrafts: Map<string, string>,
  mode: RiskMode = "read",
  connReadOnly = false,
): string {
  const evaluating = card.state === "ready" && card.autoStatus === AUTO_EVALUATING;
  const gate = cardGateFor(card, dialect, mode, connReadOnly);
  const run = card.state === "executing" ? card.run : undefined;
  let bar: string;
  if (run) {
    bar = runningActions(card.id, run);
  } else if (card.state !== "ready") {
    bar = `<div class="actions"><span class="busy"><span class="spin"></span>${busyLabel(card.state)}&hellip;</span></div>`;
  } else {
    const blocker = gate.note
      ? `<div class="nb-msg${evaluating ? " auto" : ""}" id="gate-${card.id}"${evaluating ? ' role="status"' : ""}>${evaluating ? autoIcon : ALERT_ICON}<span>${escapeHtml(gate.note)}</span></div>`
      : "";
    bar = blocker + readyActions(card.id, gate, denyDrafts, card.expiresAt);
  }
  const sql = `<pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(visibleControls(card.sql))}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="sqlbody-${card.id}">${highlight(formatSql(card.sql), card.schema?.pii, card.schema?.client, card.schema?.literals)}</code></pre>`;
  // While Auto mode evaluates, the ring the card frame used to carry runs round the SQL.
  const sqlBlock = evaluating ? `<div class="sql-ring">${sql}</div>` : sql;
  return `
      <div class="card ${cardClassFor(gate)}${run ? runClass(run) : ""}" data-card="${card.id}">
        <div class="top">
          ${riskBadge(gate.cls)}<span class="intent">${escapeHtml(card.intent ? capitalize(card.intent) : card.id)}</span>
        </div>
        <div class="meta">${escapeHtml(card.id)} &middot; Requested ${relAge(card.createdAt)}</div>
        <div class="cs-matrix" id="cm-${card.id}">${accessMatrix(card.sql, dialect, gate.cls, card.schema)}</div>
        ${unparsedNote(gate)}<div class="cs-legend" id="cs-${card.id}">${sensitiveLegend(card.schema, card.id)}</div>
        ${sqlBlock}
        <div class="cs-auto">${autoNote(card)}</div>${executionNote(card)}<div class="dbar">${bar}</div>
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
export function riskBadge(cls: RiskClass): string {
  if (cls === "write") {
    return `<span class="risk-badge write">Write</span>`;
  }
  if (cls === "destructive") {
    return `<span class="risk-badge destructive">Destructive</span>`;
  }
  return "";
}

// Which tables the statement reads, writes or deletes from, one row per table: a table both
// read and written keeps both marks. Delete only for what removes data (DELETE, DROP, TRUNCATE);
// a read's tables come from the column analysis once it lands, from the SQL text until then.
export function accessMatrix(
  sql: string,
  dialect: string,
  cls: RiskClass,
  schema?: SchemaContext | null,
): string {
  const ops = analyzeTableOps(sql, dialect);
  const roles = new Map<string, Set<Role>>();
  const add = (table: string, role: Role) =>
    roles.set(table, (roles.get(table) ?? new Set()).add(role));
  if (cls !== "read") {
    const removes = ["delete", "drop", "truncate"].includes(ops?.writeOp ?? "");
    for (const t of ops?.writes ?? []) add(t, removes ? "Delete" : "Write");
    for (const t of ops?.reads ?? []) add(t, "Read");
  } else {
    for (const t of schema?.tables ?? ops?.reads ?? []) add(t, "Read");
  }
  if (!roles.size) {
    return "";
  }
  const cell = (on: boolean, role: Role) =>
    on
      ? `<td class="mk on ${role.toLowerCase()}">${checkIcon}<span class="sr-only">Yes</span></td>`
      : '<td class="mk"><span class="sr-only">No</span></td>';
  const rows = [...roles]
    .map(
      ([t, set]) =>
        `<tr><th scope="row" class="nm">${escapeHtml(t)}</th>${ROLES.map((r) => cell(set.has(r), r)).join("")}</tr>`,
    )
    .join("");
  return `<table class="mx"><thead><tr><th scope="col">Table</th>${ROLES.map((r) => `<th scope="col">${r}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

type Role = "Read" | "Write" | "Delete";
const ROLES: Role[] = ["Read", "Write", "Delete"];

// What the SQL marks, explained once just above it: each category written as it is marked in
// the query, with how many. Nothing when the analysis found nothing to mark.
export function sensitiveLegend(schema: SchemaContext | null | undefined, id: string): string {
  if (!schema) {
    return "";
  }
  const values = schema.literals.map((v) => `'${v}'`);
  const groups: [string, string, string[]][] = [
    ["pii", "Possible PII", schema.pii],
    ["client", "Client data", schema.client],
    ["val", values.length > 1 ? "Sensitive values" : "Sensitive value", values],
  ];
  // Each entry names its objects on hover and keyboard focus, so a reader who cannot tell the
  // colours apart, or a SELECT * whose columns the SQL never spells out, still gets the names.
  return groups
    .filter(([, , items]) => items.length > 0)
    .map(
      ([k, label, items]) =>
        `<span class="lg-slot"><button class="lg ${k}" type="button" aria-describedby="lg-${k}-${id}"><span class="sw">${label}</span><span class="ct">${items.length}</span></button><span class="lg-pop" id="lg-${k}-${id}" role="tooltip">${items.map(escapeHtml).join(", ")}</span></span>`,
    )
    .join("");
}

// The legend is rebuilt when an analysis lands; a reader on one of its entries stays on the
// same category, or on the first one left.
export function paintLegend(
  host: HTMLElement,
  schema: SchemaContext | null | undefined,
  id: string,
): void {
  const active = host.ownerDocument?.activeElement;
  const was = active && host.contains(active) ? active.getAttribute("aria-describedby") : null;
  host.innerHTML = sensitiveLegend(schema, id);
  if (was) {
    (
      host.querySelector<HTMLElement>(`[aria-describedby="${CSS.escape(was)}"]`) ??
      host.querySelector<HTMLElement>(".lg")
    )?.focus();
  }
}

export function readyActions(
  id: string,
  gate: CardGate,
  denyDrafts: Map<string, string>,
  expiresAt?: number,
  now = Date.now(),
): string {
  const revise = denyDrafts.has(id)
    ? denyField(id, denyDrafts.get(id) ?? "")
    : `<button class="deny-open" type="button" data-deny-open="${id}" title="Reject and ask the agent to change something">${messageIcon}Request changes</button>`;
  const tone = gate.cls === "destructive" ? " destructive" : gate.cls === "write" ? " write" : "";
  // A blocked Approve points at the reason written just above the actions.
  const described = gate.note ? ` aria-describedby="gate-${id}"` : "";
  const approve = `<button class="btn approve${tone}" type="button" data-approve="${id}"${described} ${gate.approveEnabled ? "" : "disabled"}>${gate.approveLabel}</button>`;
  // The expiry clock only means something while the proposal waits for a decision.
  const left = (expiresAt ?? now) - now;
  const due =
    expiresAt === undefined
      ? ""
      : `<span class="nb-due">Expires in <span class="${left <= 45_000 ? "lease low" : "lease"}">${clock(left)}</span></span>`;
  return `<div class="actions">
             ${approve}
             <button class="btn reject" type="button" data-reject="${id}">Reject</button>
             ${revise}${due}
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
    ? `<div class="cs-unparsed stop-error" role="status">${xCircleIcon}<span class="stop-msg"><span>${stop.by === "limit" ? "Auto-stop could not be confirmed." : "Stop could not be confirmed."}</span><span class="stop-raw">${escapeHtml(stop.error)}</span></span></div>`
    : "";
  return `<div class="actions">${control}<span class="run"><span class="spin"></span>Running<span class="clock run-clock">${clock(elapsed)}</span></span>${limit}</div>${error}`;
}
