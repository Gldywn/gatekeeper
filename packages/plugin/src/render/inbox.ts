import {
  capitalize,
  clock,
  escapeHtml,
  previewSql,
  relAge,
  rowsLabel,
  sessionDisplayName,
} from "../html";
import { agentBadge, harnessIcon } from "../icons";
import type { RiskClass } from "../sql/classify";
import type { ActivityEntry, Card, HistItem, Presence, SessionRoster } from "../types";
import { autoIcon } from "./auto";
import { CANCELLED_NOTE } from "./detail";
import { AUTO_EVALUATING, busyLabel } from "./queue";
import { rosterRow } from "./roster";
import { statusIcon } from "./status";

// The Inbox: one list on the left (the queue, or the Audit Trail), the selected item in full
// on the right. Rows here are compact and selectable; the full card and the detail keep their
// own renderers so every gate and annotation stays in one place.

const RISK_WORD: Partial<Record<RiskClass, string>> = {
  write: "write",
  destructive: "destructive",
};

function who(session: Card["session"], fallback: string): string {
  return escapeHtml(sessionDisplayName(session, fallback));
}

// A pending proposal: the held dot (or the Auto bolt while Jev evaluates it, or the spinner
// once it left "ready"), the intent, who asked, and the clock that matters for its state.
export function queueRowHtml(
  card: Card,
  cls: RiskClass,
  selected: boolean,
  now = Date.now(),
): string {
  const evaluating = card.state === "ready" && card.autoStatus === AUTO_EVALUATING;
  const mark =
    card.state !== "ready"
      ? '<span class="spin" aria-hidden="true"></span>'
      : evaluating
        ? `<span class="ix-bolt" aria-hidden="true">${autoIcon}</span>`
        : '<span class="ix-dot" aria-hidden="true"></span>';
  const risk = RISK_WORD[cls]
    ? `<span aria-hidden="true">&middot;</span><span class="ix-risk ${cls}">${RISK_WORD[cls]}</span>`
    : "";
  let side: string;
  if (card.state === "executing" && card.run) {
    side = `<span class="ix-side run" data-run="${escapeHtml(card.id)}">${clock(now - card.run.startedAt)}</span>`;
  } else if (card.state !== "ready") {
    side = `<span class="ix-side busy">${busyLabel(card.state)}</span>`;
  } else {
    const left = card.expiresAt - now;
    side = `<span class="ix-side${left <= 45_000 ? " low" : ""}" data-lease>${clock(left)}</span>`;
  }
  const title = card.intent ? capitalize(card.intent) : card.id;
  return `<button class="ix-row pend" type="button" data-row="${escapeHtml(card.id)}" data-select="card" aria-current="${selected}">
      <span class="ix-mark">${mark}</span>
      <span class="ix-main"><span class="ix-title">${escapeHtml(title)}</span><span class="ix-meta">${agentBadge(card.session?.harness?.trim() || null)}<span class="ix-who">${who(card.session, card.sessionId)}</span>${risk}</span></span>
      ${side}
    </button>`;
}

// A decided request, local (Recently resolved) or from the Audit Trail: the outcome glyph, the
// intent, who asked and what came of it, and when.
export function doneRowHtml(
  item: HistItem,
  selected: boolean,
  select: "hist" | "audit",
  side: string,
  cls: RiskClass = "read",
): string {
  const risk = RISK_WORD[cls]
    ? `<span aria-hidden="true">&middot;</span><span class="ix-risk ${cls}">${RISK_WORD[cls]}</span>`
    : "";
  const glyph =
    item.status === "approved" && item.approval?.source === "automatic"
      ? `<span class="hstate auto" title="Approved automatically" aria-label="Approved automatically">${autoIcon}</span>`
      : statusIcon(item.status);
  const title = item.intent ? capitalize(item.intent) : previewSql(item.sql);
  return `<button class="ix-row done" type="button" data-row="${escapeHtml(item.id)}" data-select="${select}" aria-current="${selected}">
      <span class="ix-mark">${glyph}</span>
      <span class="ix-main"><span class="ix-title">${escapeHtml(title)}</span><span class="ix-meta">${agentBadge(item.session?.harness?.trim() || null)}<span class="ix-who">${who(item.session, item.id)}</span>${risk}${item.note ? `<span aria-hidden="true">&middot;</span><span class="ix-note" title="${escapeHtml(item.note)}">${escapeHtml(item.note)}</span>` : ""}</span></span>
      ${side}
    </button>`;
}

export function recentRowHtml(item: HistItem, selected: boolean, cls: RiskClass = "read"): string {
  return doneRowHtml(
    item,
    selected,
    "hist",
    `<span class="ix-side"><span class="hage" data-age="${item.resolvedAt}">${relAge(item.resolvedAt)}</span></span>`,
    cls,
  );
}

export function groupHeadHtml(label: string, count: number, hot = false): string {
  return `<div class="ix-group${hot ? " hot" : ""}">${label}<span class="n">${count || ""}</span></div>`;
}

// The Audit Trail keeps the request's server facts; this shapes them for the shared detail. No
// rows: /activity serves only the counts, so the detail says the rows are not held.
export function auditItem(e: ActivityEntry, connection: string | null): HistItem {
  const status =
    e.state === "approved" || e.state === "rejected" || e.state === "failed" ? e.state : "expired";
  // The row's one fact: what an approved write changed, else what the query returned, never a
  // filler when the count is unknown. The detail shows both counts.
  const note =
    e.state === "approved"
      ? e.affectedRows != null
        ? rowsLabel(e.affectedRows, "changed")
        : e.rowCount != null
          ? rowsLabel(e.rowCount, "returned")
          : ""
      : e.state === "rejected"
        ? e.reason?.trim() || "declined"
        : e.state === "failed"
          ? e.error?.trim() || "query failed"
          : e.state === "cancelled"
            ? CANCELLED_NOTE
            : e.state;
  const counted = e.state === "approved" && (e.rowCount != null || e.affectedRows != null);
  return {
    id: e.id,
    status,
    note,
    sql: e.sql,
    resolvedAt: e.decidedAt ?? e.createdAt,
    connection,
    session: {
      sessionId: e.sessionId,
      harness: e.harness,
      harnessVersion: null,
      project: e.project,
      sessionLabel: e.sessionLabel,
    },
    intent: e.intent ?? undefined,
    result: counted
      ? {
          fields: [],
          rows: [],
          rowCount: e.rowCount,
          ...(e.affectedRows != null ? { affectedRows: e.affectedRows } : {}),
          truncated: false,
        }
      : undefined,
    approval: e.approval,
    evaluation: e.evaluation,
    autoHold: e.autoHold,
  };
}

// One chip per agent in the strip: presence, harness, project, what it is doing, and how many
// of its proposals wait for you.
export function agentChipHtml(s: SessionRoster, p: Presence): string {
  const name = escapeHtml(s.project?.trim() || s.harness?.trim() || s.sessionId);
  const meta =
    p === "active"
      ? "active"
      : p === "idle"
        ? `idle <span class="rage" data-age="${s.lastActive}">${relAge(s.lastActive)}</span>`
        : `left <span class="rage" data-age="${s.leftAt ?? s.lastSeen}">${relAge(s.leftAt ?? s.lastSeen)}</span>`;
  const pending = s.pendingCount > 0 ? `<span class="ac-n">${s.pendingCount} pending</span>` : "";
  const task = s.sessionLabel?.trim();
  return `<span class="agent-chip" data-presence="${p}"${task ? ` title="${escapeHtml(capitalize(task))}"` : ""}><span class="presence-dot"></span><span class="harness-badge">${harnessIcon(s.harness?.trim() || null)}</span><span class="ac-name">${name}</span><span class="ac-meta">${meta}</span>${pending}</span>`;
}

export function agentsEmptyHtml(): string {
  return `<div class="agents-empty"><span class="ae-marks" aria-hidden="true"><span class="ae-tile">${harnessIcon("claude")}</span><span class="ae-tile">${harnessIcon("codex")}</span><span class="ae-tile">${harnessIcon("opencode")}</span></span><span class="ae-text"><span class="ae-title">No agent connected</span><span class="ae-sub">An agent shows up here once it calls the Gatekeeper MCP server.</span></span></div>`;
}

// The strip shows the chips that fit on one line; the rest fold into "+N more", which opens
// the full roster. The app measures and sets the hidden chips after each render.
export function agentsStripHtml(rows: { s: SessionRoster; p: Presence }[], live: number): string {
  if (!rows.length) {
    return `<span class="strip-label">Agents</span>${agentsEmptyHtml()}`;
  }
  return `<span class="strip-label">Agents<span class="strip-n">${live}</span></span>
    <div class="chips">${rows.map(({ s, p }) => agentChipHtml(s, p)).join("")}</div>
    <span class="more-wrap">
      <button class="agent-chip more" type="button" data-agents-more aria-haspopup="true" aria-expanded="false" aria-controls="agentsPop" hidden></button>
      <div class="agents-pop" id="agentsPop" role="region" aria-label="Connected agents" hidden><div class="pop-head">Connected agents</div><div class="roster-list">${rows.map(({ s, p }) => rosterRow(s, p)).join("")}</div></div>
    </span>`;
}

// What the right pane shows with nothing selected.
export function paneEmptyHtml(waiting: number, tab: "queue" | "audit"): string {
  if (tab === "audit") {
    return `<div class="pane-empty"><span class="pe-title">Select an entry</span><span class="pe-sub">Its query, its outcome and who asked appear here.</span></div>`;
  }
  if (!waiting) {
    return `<div class="waiting"><span class="waiting-mark" aria-hidden="true"></span><span>Waiting for a query proposal...</span></div>`;
  }
  const what = waiting === 1 ? "1 proposal waits for you" : `${waiting} proposals wait for you`;
  return `<div class="pane-empty"><span class="pe-title">${what}</span><span class="pe-sub">Select one on the left to review it.</span></div>`;
}
