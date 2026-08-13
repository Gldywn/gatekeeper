import { capitalize, escapeHtml, outcomeMeta } from "../html";
import { checkIcon, clockIcon, xCircleIcon } from "../icons";

// Status as a coloured glyph, the colour being the code and the word on its tooltip. Shared
// by the Recently-resolved rows and the detail head so the two can never drift; the label
// comes from the one outcomeMeta vocabulary.
export function statusIcon(status: string): string {
  const icons: Record<string, string> = {
    approved: checkIcon,
    rejected: xCircleIcon,
    failed: xCircleIcon,
    expired: clockIcon,
  };
  const icon = icons[status] ?? clockIcon;
  const label = capitalize(outcomeMeta(status).label);
  return `<span class="hstate ${escapeHtml(status)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</span>`;
}
