import { capitalize, escapeHtml, outcomeMeta, relAge, sessionDisplayName } from "../html";
import { agentBadge, checkIcon, clockIcon, copyIcon, xCircleIcon } from "../icons";
import type { HistResult } from "../result";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import type { HistItem } from "../types";

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
          <span class="hstatus ${item.status}">${escapeHtml(outcomeMeta(item.status).label)}</span>
          <button class="detail-close" type="button" data-close aria-label="Close detail">&times;</button>
        </div>
        <div class="detail-meta">${audit.join(" &middot; ")}</div>
        ${item.intent ? `<p class="detail-intent">${escapeHtml(capitalize(item.intent))}</p>` : ""}
        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(item.sql)}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="detail-sqlbody">${highlight(formatSql(item.sql))}</code></pre>
        <div class="card-schema" id="detail-cs"></div>
        ${outcomeHtml(item)}
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
    // A decline carries no reason to show; state it plainly, no placeholder note.
    return (
      ocHead(xCircleIcon, "Declined", relAge(item.resolvedAt)) +
      ocMsg("You declined this proposal. Nothing ran against the database.")
    );
  }
  return (
    ocHead(clockIcon, "Expired", relAge(item.resolvedAt)) +
    ocMsg("The proposal timed out before a decision. Nothing ran against the database.")
  );
}

function approvedOutcome(item: HistItem): string {
  const result = item.result;
  const rowCount = result?.rowCount ?? 0;
  const head = ocHead(
    checkIcon,
    "Approved",
    `${formatCount(rowCount)} ${rowCount === 1 ? "row" : "rows"}`,
  );
  if (!result || rowCount === 0) {
    return head + ocMsg("The query ran and returned no rows.");
  }
  // rowCount > 0 but the rows were purged (retention or the byte budget): keep the
  // scalar count honest without claiming the data is still here.
  if (result.rows.length === 0) {
    return head + ocMsg(`${formatCount(rowCount)} rows returned, no longer held in memory.`);
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
  const noun = result.rowCount === 1 ? "row" : "rows";
  const capTag = result.truncated
    ? ` <span class="cap-tag">first ${formatCount(result.rows.length)} held</span>`
    : "";
  return `<div class="grid-foot"><span class="rc"><b>${formatCount(result.rowCount)}</b> ${noun}${capTag}</span></div>`;
}

// Thousands separators without toLocaleString, so the rendered count is byte-stable
// regardless of the host's locale.
function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
