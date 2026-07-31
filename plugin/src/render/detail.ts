import { capitalize, escapeHtml, sessionDisplayName } from "../html";
import { copyIcon, harnessIcon } from "../icons";
import { cell, type HistResult } from "../result";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import type { HistItem } from "../types";

export function detailHtml(item: HistItem): string {
  const grid = item.result ? gridHtml(item.result) : "";
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
          <span class="harness-badge">${harnessIcon(harness)}</span>
          <span class="detail-who">${escapeHtml(who)}</span>
          ${item.session?.sessionLabel ? `<span class="detail-scope" title="${escapeHtml(capitalize(item.session.sessionLabel))}">${escapeHtml(capitalize(item.session.sessionLabel))}</span>` : ""}
          <span class="hstatus ${item.status}">${item.status}</span>
          <button class="detail-close" type="button" data-close aria-label="Close detail">&times;</button>
        </div>
        <div class="detail-meta">${audit.join(" &middot; ")}</div>
        ${item.intent ? `<p class="detail-intent">${escapeHtml(capitalize(item.intent))}</p>` : ""}
        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(item.sql)}" aria-label="Copy SQL">${copyIcon}</button><code class="sql-body" id="detail-sqlbody">${highlight(formatSql(item.sql))}</code></pre>
        <div class="card-schema" id="detail-cs"></div>
        ${item.note ? `<div class="detail-outcome">${escapeHtml(item.note)}</div>` : ""}
        ${grid}
      </div>`;
}

export function gridHtml(result: HistResult): string {
  if (result.rowCount === 0) {
    return '<p class="detail-empty">No rows returned.</p>';
  }
  if (result.rows.length === 0) {
    return `<p class="detail-empty">${result.rowCount} rows returned, no longer held in memory.</p>`;
  }
  const cols = result.fields.length
    ? result.fields.map((f) => f.name)
    : Object.keys(result.rows[0]);
  const head = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = result.rows
    .map((row) => `<tr>${cols.map((c) => `<td>${escapeHtml(cell(row[c]))}</td>`).join("")}</tr>`)
    .join("");
  const note = result.truncated
    ? `<p class="detail-note">Showing ${result.rows.length} of ${result.rowCount} rows.</p>`
    : "";
  return `<div class="grid-wrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${note}`;
}
