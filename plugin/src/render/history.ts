import { capitalize, escapeHtml, outcomeMeta, previewSql, relAge, sessionDisplayName } from "../html";
import { agentBadge, checkIcon, clockIcon, xCircleIcon } from "../icons";
import { highlight } from "../sql/highlight";
import type { HistItem } from "../types";

// Status as a coloured glyph: the colour is already the code, so an icon reads as fast as
// the word and frees the row for the session label. The word rides the tooltip, the full
// outcome is one click away. A rejection reads as "Declined".
function statusIcon(status: string): string {
  const icons: Record<string, string> = {
    approved: checkIcon,
    rejected: xCircleIcon,
    failed: xCircleIcon,
    expired: clockIcon,
  };
  const icon = icons[status] ?? clockIcon;
  // Label from the shared outcomeMeta so the tooltip can't drift from the vocabulary.
  const label = capitalize(outcomeMeta(status).label);
  return `<span class="hstate ${escapeHtml(status)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</span>`;
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
