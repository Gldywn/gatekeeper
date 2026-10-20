import {
  capitalize,
  countsLabel,
  escapeHtml,
  formatCount,
  relAge,
  sessionDisplayName,
} from "../html";
import {
  agentBadge,
  checkIcon,
  clockIcon,
  copyIcon,
  downloadIcon,
  jsonIcon,
  markdownIcon,
  tableIcon,
  xCircleIcon,
} from "../icons";
import type { HistResult } from "../result";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import { visibleControls } from "../sql/sanitize";
import type { HistItem } from "../types";
import { approvalHtml } from "./auto";
import { flyoutMenu } from "./controls";
import { statusIcon } from "./status";

// An agent cancellation is stored as an expiry; this note is what tells the two apart.
export const CANCELLED_NOTE = "cancelled by the agent";
// The rows ran but the broker never took the result; and the error the server's sweep records
// when an execution lease lapses with no outcome. Both leave the outcome unconfirmed.
export const NOT_DELIVERED_NOTE = "result not delivered";
export const EXECUTION_UNKNOWN = "execution_unknown";

export function detailHtml(item: HistItem): string {
  const harness = item.session?.harness?.trim() || null;
  const who = sessionDisplayName(item.session, item.id);
  const audit = [
    item.connection ? `on ${escapeHtml(item.connection)}` : "",
    harness ? escapeHtml(harness) : "",
    item.session?.sessionId ? escapeHtml(item.session.sessionId) : "",
    escapeHtml(item.id),
    escapeHtml(new Date(item.resolvedAt).toLocaleString()),
  ].filter(Boolean);
  return `
      <div class="detail-card">
        <div class="detail-head ${item.status}">
          ${agentBadge(harness)}
          <span class="detail-who">${escapeHtml(who)}</span>
          ${item.session?.sessionLabel ? `<span class="detail-scope" title="${escapeHtml(capitalize(item.session.sessionLabel))}">${escapeHtml(capitalize(item.session.sessionLabel))}</span>` : ""}
          ${statusIcon(item.status)}
        </div>
        <div class="detail-meta">${audit.join(" &middot; ")}</div>
        ${item.intent ? `<p class="detail-intent">${escapeHtml(capitalize(item.intent))}</p>` : ""}
        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(visibleControls(item.sql))}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="detail-sqlbody">${highlight(formatSql(item.sql))}</code></pre>
        <div class="card-schema" id="detail-cs"></div>
        ${approvalHtml(item.approval, item.evaluation, item.autoHold)}${outcomeHtml(item)}
      </div>`;
}

// The outcome carries the status colour on a left rail (the title bar stays neutral),
// keyed off item.status so each terminal state reads at a glance.
function outcomeHtml(item: HistItem): string {
  return `<div class="detail-rail ${item.status}">${outcomeInner(item)}</div>`;
}

function outcomeInner(item: HistItem): string {
  if (item.status === "approved") {
    return approvedOutcome(item);
  }
  if (item.status === "failed") {
    return (
      ocHead(xCircleIcon, "Failed", "at execution") +
      ocNote(item.note?.trim() || "The query failed at execution.")
    );
  }
  if (item.status === "rejected") {
    // "declined" is the label a decline without a typed reason carries; only a real reason shows.
    const reason = item.note?.trim();
    return (
      ocHead(xCircleIcon, "Declined", relAge(item.resolvedAt)) +
      ocMsg("You declined this proposal. Nothing ran against the database.") +
      (reason && reason !== "declined" ? ocNote(reason) : "")
    );
  }
  if (item.note === CANCELLED_NOTE) {
    return (
      ocHead(clockIcon, "Cancelled", relAge(item.resolvedAt)) +
      ocMsg(
        "The agent cancelled this proposal before a decision. Nothing ran against the database.",
      )
    );
  }
  return (
    ocHead(clockIcon, "Expired", relAge(item.resolvedAt)) +
    ocMsg("The proposal timed out before a decision. Nothing ran against the database.")
  );
}

function approvedOutcome(item: HistItem): string {
  const result = item.result;
  if (!result) {
    return ocHead(checkIcon, "Approved", "") + ocMsg("The query ran. No count was recorded.");
  }
  // The meta carries the facts: what a write changed, what the query returned, or both.
  const head = ocHead(checkIcon, "Approved", countsLabel(result));
  if (result.rowCount === 0) {
    return head + ocMsg("The query returned no rows.");
  }
  // Rows returned but no longer here (retention or the byte budget): keep the scalar
  // count honest without claiming the data is still around. With no returned count known
  // (a write's Audit Trail entry), the counts in the head say all there is.
  if (result.rows.length === 0) {
    return result.rowCount === null
      ? head
      : head + ocMsg("The rows this query returned are no longer held in memory.");
  }
  return `${head}<div class="detail-oc-body" id="detail-grid">${resultGrid(result)}</div>`;
}

function ocHead(icon: string, title: string, meta: string): string {
  return `<div class="detail-oc">${icon}<span class="detail-oc-title">${title}</span><span class="detail-oc-meta">${escapeHtml(meta)}</span></div>`;
}

function ocMsg(text: string): string {
  return `<div class="detail-oc-body"><div class="detail-oc-msg">${escapeHtml(text)}</div></div>`;
}

function ocNote(text: string): string {
  return `<div class="detail-oc-body"><div class="detail-oc-note">${escapeHtml(text)}</div></div>`;
}

// The held rows are already capped (capResult, at decision time). Tabulator mounts on the
// .gk-grid host once this markup is in the DOM (views/detail.ts) and paginates over them;
// the footer states the true total and the held cap, independent of the paged slice.
function resultGrid(result: HistResult): string {
  return `<div class="gk-grid" data-result-grid></div>${gridFoot(result)}`;
}

export function gridFoot(result: HistResult): string {
  const total = result.rowCount ?? result.rows.length;
  const noun = total === 1 ? "row" : "rows";
  const capTag = result.truncated
    ? ` <span class="cap-tag">first ${formatCount(result.rows.length)} held</span>`
    : "";
  // The copy/export controls act on the rows on screen, so they show only when rows are
  // held; the copy icon is wrapped so a copy can flash a check on it without disturbing
  // the label. When truncated, both operate on the held slice, not the full result.
  const actions = result.rows.length
    ? `<span class="grid-foot-actions">${flyoutMenu(
        "copy",
        "result",
        `<span class="flyout-ico" data-flyout-ico>${copyIcon}</span>`,
        "Copy",
        [{ fmt: "md", icon: markdownIcon, name: "Markdown" }],
      )}${flyoutMenu("export", "result", downloadIcon, "Export", [
        { fmt: "csv", icon: tableIcon, name: "CSV" },
        { fmt: "json", icon: jsonIcon, name: "JSON" },
      ])}</span>`
    : "";
  return `<div class="grid-foot"><span class="rc"><b>${formatCount(total)}</b> ${noun}${capTag}</span>${actions}</div>`;
}
