import type { ExportFormat, ExportMonth, ExportPeriod } from "../export";
import { escapeHtml, formatCount } from "../html";
import { alertTriangleIcon, chevronDown, downloadIcon, xCircleIcon, xIcon } from "../icons";
import { activityTailError, dayCount, dayTitleHtml } from "./activity";

// The Audit Trail export: its trigger in the list pane's head, and the dialog that picks a period
// or days and a format. Pure markup; views/export.ts owns the state and the updates.

export function exportTriggerHtml(): string {
  return `<button class="detail-close ex-trigger" type="button" data-export-open aria-label="Export the Audit Trail" title="Export the Audit Trail">${downloadIcon}</button>`;
}

const PERIODS: [ExportPeriod, string][] = [
  ["today", "Today"],
  ["last7", "Last 7 days"],
  ["month", "This month"],
  ["all", "Everything"],
  ["pick", "Choose days"],
];

const FORMATS: [ExportFormat, string][] = [
  ["md", "Markdown"],
  ["csv", "CSV"],
  ["json", "JSON"],
];

const head = `<div class="panel-head"><span class="panel-head-ico">${downloadIcon}</span><span class="panel-title" id="exportTitle">Export the Audit Trail</span><button class="detail-close" type="button" data-export-close aria-label="Close" title="Close">${xIcon}</button></div>`;

const card = (body: string) =>
  `<div class="detail-card export-card" role="dialog" aria-modal="true" aria-labelledby="exportTitle">${head}${body}</div>`;

// The dialog's frame: the period with its dates, the days (shown for Choose days), the format,
// then the status line the Export button is described by. The fieldset holds every choice, so
// freezing it while the file is prepared disables them all at once.
export function exportDialogHtml(
  period: ExportPeriod,
  format: ExportFormat,
  when: Partial<Record<ExportPeriod, string>>,
): string {
  const periods = PERIODS.map(
    ([p, name]) =>
      `<label class="ex-opt"><input class="ex-radio" type="radio" name="exPeriod" value="${p}"${p === period ? " checked" : ""}><span class="ex-name">${name}</span><span class="ex-when" data-export-when="${p}">${escapeHtml(when[p] ?? "")}</span></label>`,
  ).join("");
  const formats = FORMATS.map(
    ([f, name]) =>
      `<label class="ex-fmt"><input class="ex-radio" type="radio" name="exFormat" value="${f}"${f === format ? " checked" : ""}>${name}<span class="ex-ext">.${f}</span></label>`,
  ).join("");
  return card(`
      <fieldset class="ex-form" id="exForm">
        <div class="ex-sec">
          <span class="set-group-name" id="exPeriodLabel">Period</span>
          <div class="ex-opts" role="radiogroup" aria-labelledby="exPeriodLabel">${periods}</div>
          <div class="ex-feed" id="exFeed"></div>
          <div class="ex-days" id="exDays"${period === "pick" ? "" : " hidden"}></div>
        </div>
        <div class="ex-sec">
          <span class="set-group-name" id="exFormatLabel">Format</span>
          <div class="ex-fmts" role="radiogroup" aria-labelledby="exFormatLabel">${formats}</div>
          <p class="set-note">Each query with its SQL, intent, session and outcome. Result rows are never included.</p>
        </div>
      </fieldset>
      <div class="ex-status" id="exStatus" aria-live="polite"></div>
      <div class="confirm-actions">
        <button class="confirm-cancel" type="button" data-export-close>Cancel</button>
        <button class="confirm-go write" type="button" data-export-go aria-describedby="exStatus" disabled>Export</button>
      </div>`);
}

// A broker from before paging can cut its single page mid-day, so nothing it sends is a whole
// period: the dialog states the requirement and offers nothing to pick.
export function exportLegacyHtml(): string {
  return card(`
      <div class="nb-msg" data-export-legacy>${alertTriangleIcon}<span>An updated Gatekeeper server is required to export the Audit Trail.</span></div>
      <p class="set-note">This server only sends its latest queries, which can cut a day short.</p>
      <div class="confirm-actions"><button class="confirm-cancel" type="button" data-export-close>Close</button></div>`);
}

// Choose days: each month a head (its tick and its fold, two sibling controls), then its whole
// days in the trail's own anatomy. A mixed month gets `data-mixed`; only script can show it so.
export function exportDaysHtml(
  months: ExportMonth[],
  ticked: (day: string) => boolean,
  tail: string,
): string {
  const rows = months
    .map((m) => {
      const days = m.days
        .map(
          (d) =>
            `<label class="ex-day"><input class="ex-check" type="checkbox" data-export-day="${d.key}"${ticked(d.key) ? " checked" : ""}><span class="act-day-tile">${new Date(d.ts).getDate()}</span><span class="act-day-text"><span class="act-day-label">${dayTitleHtml(d.ts)}</span><span class="act-day-count">${dayCount(d.queries, d.sessions)}</span></span></label>`,
        )
        .join("");
      return `<div class="ex-month"><input class="ex-check" type="checkbox" data-export-month="${m.key}" aria-label="${escapeHtml(m.label)}"${m.state === "checked" ? " checked" : ""}${m.state === "mixed" ? " data-mixed" : ""}><button class="ex-month-toggle" type="button" data-export-fold="${m.key}" aria-expanded="${m.open}" aria-controls="exm-${m.key}">${escapeHtml(m.label)}<span class="act-day-chev">${chevronDown}</span></button></div><div class="ex-month-body" id="exm-${m.key}"${m.open ? "" : " hidden"}>${days}</div>`;
    })
    .join("");
  return `<div class="ex-days-bar"><button class="act-retry" type="button" data-export-clear>Clear</button></div>${rows}${tail}`;
}

// While older pages load: one quiet row in the trail's tail grammar.
export function exportReadingRowHtml(): string {
  return '<div class="act-tail-row"><span class="act-tail-slot"><span class="ex-dot" aria-hidden="true"></span></span><span class="act-tail-msg">Reading older days</span></div>';
}

// A failed page: the trail's own error row, its Retry continuing from the last page read.
export function exportFailedRowHtml(first: boolean, unreachable: boolean): string {
  return activityTailError(first, unreachable);
}

export type ExportStatus =
  | { kind: "reading"; back: string | null }
  | { kind: "blocked"; all: boolean }
  | { kind: "none-ticked" }
  | { kind: "empty" }
  | { kind: "scope"; queries: number; days: number; sessions: number }
  | { kind: "preparing"; done: number; total: number };

const plural = (n: number, one: string, many: string) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

// The one line above the actions: the scope as facts once it is complete, how far reading got
// before that, or the requirement a failed read leaves unmet.
export function exportStatusHtml(s: ExportStatus, saveError?: string): string {
  let line: string;
  switch (s.kind) {
    case "reading":
      line = `<p class="ex-scope"><span class="ex-dot" aria-hidden="true"></span><span>${s.back ? `Reading older days, back to ${escapeHtml(s.back)}.` : "Reading the Audit Trail."}</span></p>`;
      break;
    case "blocked":
      line = `<div class="nb-msg">${alertTriangleIcon}<span>${s.all ? "Every older day must load to export everything." : "Older days must load to export this period."}</span></div>`;
      break;
    case "none-ticked":
      line = '<p class="ex-scope">No day ticked.</p>';
      break;
    case "empty":
      line = '<p class="ex-scope">No query was decided in this period.</p>';
      break;
    case "scope": {
      const q = s.queries === 1 ? "query" : "queries";
      const d = s.days === 1 ? "day" : "days";
      const n = s.sessions === 1 ? "session" : "sessions";
      line = `<p class="ex-scope"><span><b>${formatCount(s.queries)}</b> ${q} over <b>${formatCount(s.days)}</b> ${d}, from <b>${formatCount(s.sessions)}</b> ${n}.</span></p>`;
      break;
    }
    case "preparing":
      line = `<p class="ex-scope"><span class="ex-dot" aria-hidden="true"></span><span>Preparing the file, <b>${formatCount(s.done)}</b> of <b>${formatCount(s.total)}</b> queries.</span></p>`;
      break;
  }
  const failure = saveError
    ? `<div class="cs-unparsed stop-error" role="status">${xCircleIcon}<span class="stop-msg"><span>The file could not be saved.</span><span class="stop-raw">${escapeHtml(saveError)}</span></span></div>`
    : "";
  return line + failure;
}

// The action names what it saves once the scope is final.
export function exportGoLabel(s: ExportStatus): string {
  if (s.kind === "scope") return `Export ${plural(s.queries, "query", "queries")}`;
  if (s.kind === "preparing") return `Export ${plural(s.total, "query", "queries")}`;
  return "Export";
}
