import { capitalize, clock, escapeHtml, relAge } from "../html";
import {
  buildingIcon,
  copyIcon,
  dbReadsIcon,
  harnessIcon,
  messageIcon,
  pencilIcon,
  sendIcon,
  trashIcon,
  warnIcon,
} from "../icons";
import { classifyQuery, type RiskClass, rank } from "../sql/classify";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import { modeRank, type RiskMode } from "../sql/mode";
import { visibleControls } from "../sql/sanitize";
import { analyzeTableOps, type SchemaContext } from "../sql/schema";
import type { Card, CardState, SessionMeta } from "../types";

const WRITE_MODE_NOTE = "Write mode required to approve this query.";
const DESTRUCTIVE_MODE_NOTE = "Destructive mode required to approve this query.";
const CONNECTION_NOTE = "Connection is read-only; this write cannot run.";
const MULTI_STATEMENT_NOTE = "Only a single statement can be approved.";

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

// Shown standing, not on hover: an unreadable statement is exactly the one the human must
// read for themselves, so it cannot hide behind the Approve tooltip.
function unparsedNote(gate: CardGate): string {
  if (gate.parseOk) {
    return "";
  }
  return `<div class="cs-unparsed">${warnIcon}Gatekeeper could not read this statement, so it is treated as destructive. Check it yourself before approving.</div>`;
}

export function queueHtml(
  cards: Card[],
  dialect: string,
  denyDrafts: Map<string, string>,
  mode: RiskMode = "read",
  connReadOnly = false,
): string {
  if (!cards.length) {
    return `<div class="waiting"><span class="waiting-mark" aria-hidden="true"></span><span>Waiting for a query proposal...</span></div>`;
  }
  // Group by session, keeping the arrival order of both groups and cards.
  // Always render the session header, even for a single session, so the human
  // can see which agent is asking.
  const groups: { session: SessionMeta | null; cards: Card[] }[] = [];
  for (const card of cards) {
    let group = groups.find((g) => g.cards[0]?.sessionId === card.sessionId);
    if (!group) {
      group = { session: card.session, cards: [] };
      groups.push(group);
    }
    group.cards.push(card);
  }
  return groups
    .map((g) => groupHtml(g.session, g.cards, dialect, denyDrafts, mode, connReadOnly))
    .join("");
}

export function groupHtml(
  session: SessionMeta | null,
  cards: Card[],
  dialect: string,
  denyDrafts: Map<string, string>,
  mode: RiskMode = "read",
  connReadOnly = false,
): string {
  const project = session?.project?.trim();
  const harness = session?.harness?.trim() || null;
  const label = project
    ? escapeHtml(project)
    : harness
      ? escapeHtml(harness)
      : escapeHtml(cards[0].sessionId ?? "session");
  const intent = session?.sessionLabel?.trim();
  return `
      <section class="group">
        <div class="group-head">
          <span class="harness-badge">${harnessIcon(harness)}</span>
          <span class="group-label">${label}</span>
          ${intent ? `<span class="group-intent" title="${escapeHtml(capitalize(intent))}">${escapeHtml(capitalize(intent))}</span>` : ""}
          <span class="group-count count-badge">${cards.length}</span>
        </div>
        ${cards.map((c) => cardHtml(c, dialect, denyDrafts, mode, connReadOnly)).join("")}
      </section>`;
}

export function cardHtml(
  card: Card,
  dialect: string,
  denyDrafts: Map<string, string>,
  mode: RiskMode = "read",
  connReadOnly = false,
): string {
  const gate = cardGate(card.sql, dialect, mode, connReadOnly);
  const remaining = card.expiresAt - Date.now();
  let actions: string;
  if (card.state !== "ready") {
    actions = `<div class="actions"><span class="busy"><span class="spin"></span>${busyLabel(card.state)}...</span></div>`;
  } else {
    actions = readyActions(card.id, gate, denyDrafts);
  }
  const badge = riskBadge(gate.cls);
  const riskAnno = riskAnnotation(card.sql, dialect, gate.cls);
  return `
      <div class="card ${cardClassFor(gate)}" data-card="${card.id}">
        <div class="top">
          ${badge}${card.intent ? `<span class="intent">${escapeHtml(capitalize(card.intent))}</span>` : `<span class="intent">${escapeHtml(card.id)}</span>`}
          <span class="${remaining <= 45_000 ? "lease low" : "lease"}">${clock(remaining)}</span>
        </div>
        <div class="meta">${escapeHtml(card.id)} &middot; ${relAge(card.createdAt)}</div>
        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(visibleControls(card.sql))}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="sqlbody-${card.id}">${highlight(formatSql(card.sql), card.schema?.pii, card.schema?.client, card.schema?.literals)}</code></pre>
        ${unparsedNote(gate)}${riskAnno}<div class="card-schema" id="cs-${card.id}">${schemaInner(card.schema, gate.cls !== "read")}</div>
        ${actions}
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

// The specific destructive verb from the parsed operation, so a DROP does not read
// as "Delete"; falls back to a generic verb the rare time the op is unknown.
function destructiveVerb(op: string | null): string {
  switch (op) {
    case "delete":
      return "Delete";
    case "drop":
      return "Drop";
    case "truncate":
      return "Truncate";
    case "alter":
      return "Alter";
    case "create":
      return "Create";
    case "rename":
      return "Rename";
    default:
      return "Change";
  }
}

// The tables written, named by the actual verb (Write / Delete / Drop / …) with a
// pencil for a write and a trash for a destructive; plus the tables read on a mixed
// statement (INSERT ... SELECT).
function riskAnnotation(sql: string, dialect: string, cls: RiskClass): string {
  if (cls === "read") {
    return "";
  }
  const ops = analyzeTableOps(sql, dialect);
  if (!ops) {
    return "";
  }
  const destructive = cls === "destructive";
  const label = destructive ? destructiveVerb(ops.writeOp) : "Write";
  const icon = destructive ? trashIcon : pencilIcon;
  const tone = destructive ? "destructive" : "write";
  const writesLine = ops.writes.length
    ? `<div class="cs-writes ${tone}"><span class="cs-writes-k">${icon}${label}</span>${tblChips(ops.writes)}</div>`
    : "";
  const readsLine = ops.reads.length
    ? `<div class="cs-reads"><span class="cs-reads-k">${dbReadsIcon}Reads</span>${tblChips(ops.reads)}</div>`
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
      ? `<div class="cs-reads"><span class="cs-reads-k">${dbReadsIcon}Reads</span>${schema.tables.map((t) => `<span class="tbl-chip">${escapeHtml(t)}</span>`).join("")}</div>`
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
  if (state === "approving") return "approving";
  if (state === "executing") return "running on connection";
  if (state === "posting") return "returning rows";
  return "rejecting";
}
