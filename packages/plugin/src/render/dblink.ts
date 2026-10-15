import { escapeHtml } from "../html";
import { alertTriangleIcon } from "../icons";

export type DbLink = "none" | "pending" | "passed" | "failed" | "failing";

// What the last periodic endpoint check observed on the current connection. It says what was
// seen, never why: a failure can be a dropped connection as well as a revoked privilege.
export interface DbCheck {
  supported: boolean;
  // 0 until a check has completed on this connection.
  checkedAt: number;
  // Consecutive failures since the last passed check.
  failures: number;
  error: string | null;
}

const ERROR_CHARS = 200;

// Three in a row turns red, the same rule as the broker status pill.
export function dbLink(check: DbCheck): DbLink {
  if (!check.supported) return "none";
  if (!check.checkedAt) return "pending";
  if (check.failures === 0) return "passed";
  return check.failures < 3 ? "failed" : "failing";
}

// The age and the countdown are left empty here and filled by the 1 s tick, so the popover
// is never rebuilt under the cursor or the keyboard focus.
export function dbStatusHtml(check: DbCheck, engine: string): string {
  const link = dbLink(check);
  if (link === "none") {
    return `<div class="db-note">${alertTriangleIcon}This feature is not available on ${escapeHtml(engine)}.</div>`;
  }
  if (link === "pending") {
    return "";
  }
  const title =
    link === "passed"
      ? 'Last check passed<span class="db-age"></span>'
      : link === "failed"
        ? 'Last check failed<span class="db-age"></span>'
        : `${check.failures} checks failed in a row`;
  const error =
    link !== "passed" && check.error
      ? `<span class="db-err">${escapeHtml(check.error.slice(0, ERROR_CHARS))}</span>`
      : "";
  return `<div class="db-status ${link}"><span class="db-dot"></span><span class="db-stack"><span class="db-title">${title}</span>${error}<span class="db-next"></span></span></div>`;
}

// The glyph's accessible name, since the dot alone says it only in colour.
export function dbLinkLabel(check: DbCheck, engine: string): string {
  switch (dbLink(check)) {
    case "none":
      return `No database check on ${engine}`;
    case "pending":
      return "Database check pending";
    case "passed":
      return "Database check passed";
    case "failed":
      return "Database check failed";
    case "failing":
      return `${check.failures} database checks failed in a row`;
  }
}

export function nextCheckText(nextAt: number, now: number): string {
  const s = Math.ceil((nextAt - now) / 1000);
  return s > 0 ? `Checking again in ${s}s.` : "Checking again shortly.";
}
