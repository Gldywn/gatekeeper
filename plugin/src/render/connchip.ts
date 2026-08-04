import { escapeHtml } from "../html";
import { dbCylinderIcon } from "../icons";

// Shared by the header chip and the audit-trail head so the two can never drift; the
// caller wraps it (the header appends the read-only badge, the audit head a .conn-chip).
export function connChipInner(conn: { name: string; dialect: string; path: string }): string {
  const path = conn.path.trim();
  return (
    `<span class="chip-db" aria-hidden="true">${dbCylinderIcon}</span>` +
    `<span class="chip-name">${escapeHtml(conn.name)}</span>` +
    `<span class="badge">${escapeHtml(conn.dialect)}</span>` +
    (path ? `<span class="chip-path">${escapeHtml(path)}</span>` : "")
  );
}
