import { capitalize, escapeHtml, relAge, sessionDisplayName } from "../html";
import {
  agentBadge,
  checkIcon,
  chevronLeft,
  chevronRight,
  clockIcon,
  copyIcon,
  messageIcon,
  xCircleIcon,
} from "../icons";
import { cell, HIST_PAGE_SIZE, type HistResult, pageSlice } from "../result";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import { classifyColumn } from "../sql/schema";
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
          <span class="hstatus ${item.status}">${item.status}</span>
          <button class="detail-close" type="button" data-close aria-label="Close detail">&times;</button>
        </div>
        <div class="detail-meta">${audit.join(" &middot; ")}</div>
        ${item.intent ? `<p class="detail-intent">${escapeHtml(capitalize(item.intent))}</p>` : ""}
        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(item.sql)}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="detail-sqlbody">${highlight(formatSql(item.sql))}</code></pre>
        <div class="card-schema" id="detail-cs"></div>
        ${outcomeHtml(item)}
      </div>`;
}

// The recessed well: everything about the outcome sits in one sunken tray, tinted by
// status, keyed off item.status so each terminal state reads at a glance.
function outcomeHtml(item: HistItem): string {
  return `<div class="detail-well ${item.status}">${outcomeInner(item)}</div>`;
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
    return (
      ocHead(messageIcon, "Changes requested", relAge(item.resolvedAt)) +
      ocNote(item.note?.trim() || "Changes were requested without a note.")
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
  return `${head}<div class="detail-oc-body" id="detail-grid">${gridHtml(result, 0)}</div>`;
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

// The held rows are already capped (capResult, at decision time); page over them in
// place, never a re-query. Returns the table plus a footer that states the true
// total, the shown slice, the cap, and the pager over the held rows only.
export function gridHtml(result: HistResult, page = 0): string {
  const cols = result.fields.length
    ? result.fields.map((f) => f.name)
    : Object.keys(result.rows[0] ?? {});
  const colCls = cols.map((c) => classifyColumn(c));
  const head = cols.map((c, i) => `<th${colAttr(colCls[i])}>${escapeHtml(c)}</th>`).join("");
  const { rows, page: cur, pageCount } = pageSlice(result.rows, page);
  const body = rows
    .map(
      (row) =>
        `<tr>${cols.map((c, i) => `<td${colAttr(colCls[i])}>${escapeHtml(cell(row[c]))}</td>`).join("")}</tr>`,
    )
    .join("");
  const table = `<div class="grid-wrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  return table + gridFoot(result, cur, pageCount, rows.length);
}

function colAttr(cls: "pii" | "client" | null): string {
  return cls ? ` class="${cls}"` : "";
}

function gridFoot(result: HistResult, page: number, pageCount: number, sliceLen: number): string {
  const noun = result.rowCount === 1 ? "row" : "rows";
  const multi = pageCount > 1;
  const start = page * HIST_PAGE_SIZE + 1;
  const end = page * HIST_PAGE_SIZE + sliceLen;
  const showing = multi
    ? ` &middot; showing <b>${formatCount(start)}&ndash;${formatCount(end)}</b>`
    : "";
  const capTag = result.truncated
    ? ` <span class="cap-tag">first ${formatCount(result.rows.length)} held</span>`
    : "";
  const rc = `<span class="rc"><b>${formatCount(result.rowCount)}</b> ${noun}${showing}${capTag}</span>`;
  const pager = multi ? gridPager(page, pageCount) : "";
  return `<div class="grid-foot">${rc}${pager}</div>`;
}

function gridPager(page: number, pageCount: number): string {
  const prev = page <= 0 ? " disabled" : "";
  const next = page >= pageCount - 1 ? " disabled" : "";
  return `<span class="pager"><button type="button" class="pager-btn" data-page="prev" aria-label="Previous page"${prev}>${chevronLeft}</button><span class="pg">${page + 1} / ${pageCount}</span><button type="button" class="pager-btn" data-page="next" aria-label="Next page"${next}>${chevronRight}</button></span>`;
}

// Thousands separators without toLocaleString, so the rendered count is byte-stable
// regardless of the host's locale.
function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
