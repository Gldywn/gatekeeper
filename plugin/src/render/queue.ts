import { capitalize, clock, escapeHtml, relAge } from "../html";
import {
  buildingIcon,
  copyIcon,
  dbReadsIcon,
  flaskIcon,
  harnessIcon,
  messageIcon,
  sendIcon,
  warnIcon,
} from "../icons";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import { isReadOnlyQuery } from "../sql/readonly";
import type { SchemaContext } from "../sql/schema";
import type { Card, CardState, SessionMeta } from "../types";

export function queueHtml(cards: Card[], dialect: string, denyDrafts: Map<string, string>): string {
  if (!cards.length) {
    return `<div class="waiting"><svg class="waiting-mark" viewBox="0 0 24 26" fill="none" aria-hidden="true"><polygon points="12,1.4 22,7 22,19 12,24.6 2,19 2,7" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><polygon points="12,7.4 16.8,10.2 16.8,15.8 12,18.6 7.2,15.8 7.2,10.2" fill="currentColor" fill-opacity="0.85"/></svg><span>Waiting for a query proposal...</span></div>`;
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
  return groups.map((g) => groupHtml(g.session, g.cards, dialect, denyDrafts)).join("");
}

export function groupHtml(
  session: SessionMeta | null,
  cards: Card[],
  dialect: string,
  denyDrafts: Map<string, string>,
): string {
  const project = session?.project?.trim();
  const harness = session?.harness?.trim() || null;
  const label = project
    ? escapeHtml(project)
    : harness
      ? escapeHtml(harness)
      : escapeHtml(cards[0].sessionId ?? "session");
  const intent = session?.sessionLabel?.trim();
  // A synthetic session: swap the fill-forced harness badge for the stroke flask
  // and tag the group so it reads as dev, matching the blue cards inside it.
  const dev = cards.some((c) => c.dev);
  return `
      <section class="group${dev ? " dev" : ""}">
        <div class="group-head">
          <span class="${dev ? "dev-flask" : "harness-badge"}">${dev ? flaskIcon : harnessIcon(harness)}</span>
          <span class="group-label">${label}</span>${dev ? `<span class="dev-tag">dev</span>` : ""}
          ${intent ? `<span class="group-intent" title="${escapeHtml(capitalize(intent))}">${escapeHtml(capitalize(intent))}</span>` : ""}
          <span class="group-count count-badge">${cards.length}</span>
        </div>
        ${cards.map((c) => cardHtml(c, dialect, denyDrafts)).join("")}
      </section>`;
}

export function cardHtml(card: Card, dialect: string, denyDrafts: Map<string, string>): string {
  const readOnly = isReadOnlyQuery(card.sql, dialect);
  const remaining = card.expiresAt - Date.now();
  let actions: string;
  if (card.state !== "ready") {
    actions = `<div class="actions"><span class="busy"><span class="spin"></span>${busyLabel(card.state)}...</span></div>`;
  } else {
    actions = readyActions(card.id, readOnly, denyDrafts);
  }
  const blockedNote = readOnly
    ? ""
    : '<p class="blocked-note"><svg viewBox="0 0 16 16" fill="none"><path d="M8 1.7 1 14h14L8 1.7Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.3v3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".8" fill="currentColor"/></svg>Read-only only. This query can be rejected.</p>';
  return `
      <div class="card ${card.dev ? "dev" : readOnly ? "" : "blocked"}" data-card="${card.id}">
        <div class="top">
          ${card.dev ? `<span class="dev-flask">${flaskIcon}</span>` : ""}${card.intent ? `<span class="intent">${escapeHtml(capitalize(card.intent))}</span>` : `<span class="intent">${escapeHtml(card.id)}</span>`}${card.dev ? `<span class="dev-tag">dev</span>` : ""}
          <span class="${remaining <= 45_000 ? "lease low" : "lease"}">${clock(remaining)}</span>
        </div>
        <div class="meta">${escapeHtml(card.id)} &middot; ${relAge(card.createdAt)}</div>
        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(card.sql)}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="sqlbody-${card.id}">${highlight(formatSql(card.sql), card.schema?.pii, card.schema?.client, card.schema?.literals)}</code></pre>
        <div class="card-schema" id="cs-${card.id}">${schemaInner(card.schema)}</div>
        ${blockedNote}${actions}
      </div>`;
}

export function readyActions(
  id: string,
  readOnly: boolean,
  denyDrafts: Map<string, string>,
): string {
  const revise = denyDrafts.has(id)
    ? denyField(id, denyDrafts.get(id) ?? "")
    : `<button class="deny-open" type="button" data-deny-open="${id}" title="Reject and ask the agent to change something">${messageIcon}Request changes</button>`;
  return `<div class="actions">
             <button class="btn approve" type="button" data-approve="${id}" ${readOnly ? "" : "disabled"}>Approve</button>
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

// Compact under-SQL annotation: the tables read and a possible-PII flag. Empty
// (collapsed by CSS) until the async analysis lands or when nothing is known.
export function schemaInner(schema: SchemaContext | null | undefined): string {
  if (!schema) {
    return "";
  }
  // The "reads" line needs a resolved table; the flags stand on their own, so a
  // table-less query (a synthetic dev card, or a CTE-only read) still surfaces them.
  const tables = schema.tables.length
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
