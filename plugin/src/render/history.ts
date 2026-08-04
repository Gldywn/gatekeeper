import { capitalize, escapeHtml, previewSql, relAge, sessionDisplayName } from "../html";
import { agentBadge, checkIcon, clockIcon, xCircleIcon } from "../icons";
import { highlight } from "../sql/highlight";
import type { HistItem } from "../types";

// Status as a coloured glyph: the colour is already the code, so an icon reads as fast as
// the word and frees the row for the session label. The word rides the tooltip, the full
// outcome is one click away. A rejection reads as "Declined".
function statusIcon(status: string): string {
  const map: Record<string, { icon: string; label: string }> = {
    approved: { icon: checkIcon, label: "Approved" },
    rejected: { icon: xCircleIcon, label: "Declined" },
    failed: { icon: xCircleIcon, label: "Failed" },
    expired: { icon: clockIcon, label: "Expired" },
  };
  const m = map[status] ?? { icon: clockIcon, label: capitalize(status) };
  return `<span class="hstate ${escapeHtml(status)}" title="${escapeHtml(m.label)}" aria-label="${escapeHtml(m.label)}">${m.icon}</span>`;
}

export function historyRow(item: HistItem): string {
  const harness = item.session?.harness?.trim() || null;
  const who = sessionDisplayName(item.session, item.id);
  const label = item.session?.sessionLabel?.trim();
  const labelHtml = label ? escapeHtml(capitalize(label)) : "";
  return `
        <button class="hrow ${item.status}" type="button" data-hist="${escapeHtml(item.id)}"${item.intent ? "" : " data-no-intent"} title="${escapeHtml(item.id)}">
          ${agentBadge(harness)}
          <span class="hwho" title="${escapeHtml(who)}">${escapeHtml(who)}</span>
          <span class="hlabel" title="${labelHtml}">${labelHtml}</span>
          ${statusIcon(item.status)}
          <span class="hintent">${escapeHtml(item.intent ? capitalize(item.intent) : previewSql(item.sql))}</span>
          <span class="hsql">${highlight(previewSql(item.sql))}</span>
          <span class="htime">
            <span class="hnote">${escapeHtml(item.note)}</span>
            <span aria-hidden="true">&middot;</span>
            <span class="hage" data-age="${item.resolvedAt}">${relAge(item.resolvedAt)}</span>
          </span>
        </button>`;
}
