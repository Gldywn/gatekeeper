import { capitalize, escapeHtml, previewSql, relAge, sessionDisplayName } from "../html";
import { harnessIcon } from "../icons";
import { highlight } from "../sql/highlight";
import type { HistItem } from "../types";

export function historyRow(item: HistItem): string {
  const harness = item.session?.harness?.trim() || null;
  const who = sessionDisplayName(item.session, item.id);
  return `
        <button class="hrow" type="button" data-hist="${escapeHtml(item.id)}"${item.intent ? "" : " data-no-intent"} title="${escapeHtml(item.id)}">
          <span class="harness-badge">${harnessIcon(harness)}</span>
          <span class="hwho" title="${escapeHtml(who)}">${escapeHtml(who)}</span>
          <span class="hstatus ${item.status}">${item.status === "ok" ? "approved" : "rejected"}</span>
          <span class="hintent">${escapeHtml(item.intent ? capitalize(item.intent) : previewSql(item.sql))}</span>
          <span class="hsql">${highlight(previewSql(item.sql))}</span>
          <span class="htime">
            <span class="hnote">${escapeHtml(item.note)}</span>
            <span aria-hidden="true">&middot;</span>
            <span class="hage" data-age="${item.resolvedAt}">${relAge(item.resolvedAt)}</span>
          </span>
        </button>`;
}
