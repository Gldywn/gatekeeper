import { escapeHtml } from "../html";
import { dbCylinderIcon } from "../icons";

// Shared by the header chip and the audit-trail head so the two can never drift. Only the
// header is live: its database glyph opens the check and read-only layers popover.
export function connChipInner(
  conn: { name: string; dialect: string; path: string },
  live = false,
): string {
  const path = conn.path.trim();
  const db = live
    ? '<span class="chip-db" tabindex="0" role="button" aria-label="Database check and read-only layers">'
    : '<span class="chip-db" aria-hidden="true">';
  return (
    `${db}${dbCylinderIcon}</span>` +
    `<span class="chip-name">${escapeHtml(conn.name)}</span>` +
    `<span class="badge">${escapeHtml(conn.dialect)}</span>` +
    (path ? `<span class="chip-path">${escapeHtml(path)}</span>` : "")
  );
}
