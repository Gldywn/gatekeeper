import type { SensitivityRecord } from "@gatekeeper/shared";
import { csvFormulaGuard, csvQuote } from "../csv";
import {
  activityLatency,
  capitalize,
  clockTime,
  dayKey,
  dayLabel,
  escapeHtml,
  outcomeMeta,
} from "../html";
import { agentBadge, alertTriangleIcon, chevronDown } from "../icons";
import { textSchema } from "../sql/inspect";
import { visibleControls } from "../sql/sanitize";
import { type SchemaContext, sensitivityOf } from "../sql/schema";
import type { ActivityEntry } from "../types";
import { approvalLabel } from "./auto";
import { auditItem, doneRowHtml } from "./inbox";

// The Audit Trail in the Inbox's left pane: its rows, then the tail that loads older days.
export function activityShell(): string {
  return '<div class="act-body"></div><div class="act-tail" aria-live="polite"></div>';
}

// The days of one feed, newest first: the current month's days stand on their own, and every
// earlier day goes under its month, which arrives folded.
export interface DayChunk {
  // YYYY-MM for a past month's days; null for the current month's.
  month: string | null;
  monthLabel: string;
  html: string;
  // Holds the one day that starts open, so its month starts open too.
  open: boolean;
}

const monthOf = (key: string) => key.slice(0, 7);

// Group the feed by day, then by session within each day, preserving the server's
// newest-first order throughout. Today lands open; older days fold so the log opens
// on the latest activity, one click from any deeper day.
export function activityDayChunks(
  activity: ActivityEntry[],
  selected: string | null,
  databaseType: string,
  // false for an older page appended below: it arrives all folded.
  openNewest = true,
): DayChunk[] {
  const days: { key: string; ts: number; entries: ActivityEntry[] }[] = [];
  for (const e of activity) {
    const ts = e.decidedAt ?? e.createdAt;
    const key = dayKey(ts);
    const day = days.find((d) => d.key === key);
    if (day) {
      day.entries.push(e);
    } else {
      days.push({ key, ts, entries: [e] });
    }
  }
  const now = Date.now();
  const today = dayKey(now);
  const thisMonth = monthOf(today);
  // Today when present, else the newest day, so exactly one day starts open.
  const openKey = openNewest ? (days.find((d) => d.key === today)?.key ?? days[0]?.key) : null;
  const chunks: DayChunk[] = [];
  for (const d of days) {
    const month = monthOf(d.key) === thisMonth ? null : monthOf(d.key);
    const html = dayHtml(d.key, d.ts, d.entries, d.key === openKey, selected, databaseType);
    const open = d.key === openKey;
    const last = chunks.at(-1);
    if (last && last.month === month) {
      last.html += html;
      last.open ||= open;
    } else {
      const label = new Date(d.ts).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
      chunks.push({ month, monthLabel: label, html, open });
    }
  }
  return chunks;
}

// A past month: a head that folds its days, folded unless it holds the one open day.
export function activityMonthHtml(chunk: DayChunk, open = false): string {
  return `
        <section class="act-month${open ? "" : " collapsed"}" data-month-key="${escapeHtml(chunk.month ?? "")}">
          <button class="act-month-head" type="button" data-month="${escapeHtml(chunk.month ?? "")}" aria-expanded="${open}">
            <span class="act-month-label">${escapeHtml(chunk.monthLabel)}</span>
            <span class="act-day-chev">${chevronDown}</span>
          </button>
          <div class="act-month-body">${chunk.html}</div>
        </section>`;
}

export function activityDaysHtml(
  activity: ActivityEntry[],
  selected: string | null,
  databaseType: string,
  openNewest = true,
): string {
  return activityDayChunks(activity, selected, databaseType, openNewest)
    .map((c) => (c.month === null ? c.html : activityMonthHtml(c, c.open)))
    .join("");
}

// A day's name beside its tile: Today or Yesterday spelled out, the weekday and month after it.
export function dayTitleHtml(ts: number): string {
  const named = dayLabel(ts);
  // Built from parts: a combined weekday-and-month format comes out "Jan Thu" in some runtimes.
  const date = new Date(ts);
  const short = `${date.toLocaleDateString(undefined, { weekday: "short" })}, ${date.toLocaleDateString(undefined, { month: "short" })}`;
  return named === "Today" || named === "Yesterday"
    ? `${named}<span class="act-day-sub">${escapeHtml(short)}</span>`
    : escapeHtml(short);
}

export function dayCount(queries: number, sessions: number): string {
  return `${queries} ${queries === 1 ? "query" : "queries"}, ${sessions} ${sessions === 1 ? "session" : "sessions"}`;
}

// One day: its date as a calendar tile, Today or Yesterday by name, its totals, then its rows.
function dayHtml(
  key: string,
  ts: number,
  entries: ActivityEntry[],
  open: boolean,
  selected: string | null,
  databaseType: string,
): string {
  const count = dayCount(entries.length, new Set(entries.map((e) => e.sessionId)).size);
  // A folded day ships without its rows: the view builds them on first unfold, so a
  // long prefetched history costs one line per day.
  const body = open ? activityDayBodyHtml(key, entries, selected, databaseType) : "";
  return `
        <section class="act-day${open ? "" : " collapsed"}">
          <button class="act-day-head" type="button" data-day="${escapeHtml(key)}" aria-expanded="${open}">
            <span class="act-day-tile">${new Date(ts).getDate()}</span>
            <span class="act-day-text"><span class="act-day-label">${dayTitleHtml(ts)}</span><span class="act-day-count">${count}</span></span>
            <span class="act-day-chev">${chevronDown}</span>
          </button>
          <div class="act-day-body">${body}</div>
        </section>`;
}

// One day's rows, grouped by session in first-seen (newest-first) order.
export function activityDayBodyHtml(
  day: string,
  entries: ActivityEntry[],
  selected: string | null,
  databaseType: string,
): string {
  const sessions = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    const arr = sessions.get(e.sessionId);
    if (arr) {
      arr.push(e);
    } else {
      sessions.set(e.sessionId, [e]);
    }
  }
  return [...sessions.entries()]
    .map(([sid, group]) => activityGroupHtml(day, sid, group, selected, databaseType))
    .join("");
}

// While an older page loads: placeholder day heads shaped like what is coming, so the list
// keeps reading as a list rather than ending on a status line.
export function activityTailLoading(): string {
  const row =
    '<div class="act-tail-row act-skel" aria-hidden="true"><span class="act-tail-slot"><span class="act-skel-dot"></span></span><span class="act-skel-bar"></span><span class="act-skel-bar"></span></div>';
  return `<div role="status" aria-label="Loading older days">${row}${row}${row}</div>`;
}

// Older days exist: the list ends on the control that loads them, beside the prefetch on scroll.
export function activityTailMore(): string {
  return '<div class="act-tail-row"><button class="act-retry" type="button" data-act-older>Load older days</button></div>';
}

// A failed page: what is shown stays, and the list ends on this row. `first`: nothing was
// shown yet. `unreachable`: the broker never answered, rather than answering with an error.
export function activityTailError(first: boolean, unreachable: boolean): string {
  const what = first ? "The audit trail did not load." : "Older days did not load.";
  const why = unreachable ? " The broker did not answer." : "";
  return `<div class="act-tail-row act-tail-err"><span class="act-tail-slot">${alertTriangleIcon}</span><span class="act-tail-msg">${what}${why}</span><button class="act-retry" type="button" data-act-retry>Retry</button></div>`;
}

// Cryptic session ids are long; keep a recognisable head and tail so a group still
// maps back to its agent without spanning the whole row.
function shortSession(id: string): string {
  return id.length > 14 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id;
}

// One agent session within a day: who it was and what it worked on, then its decisions. The whole
// trail exports from the list pane's head, never from a session.
export function activityGroupHtml(
  _day: string,
  sessionId: string,
  entries: ActivityEntry[],
  selected: string | null,
  databaseType: string,
): string {
  const first = entries[0];
  const harness = first.harness?.trim() || null;
  const name = first.project?.trim() || harness || shortSession(sessionId);
  const title = first.sessionLabel?.trim();
  const titleText = title ? escapeHtml(capitalize(title)) : "";
  return `
        <section class="act-group">
          <div class="act-group-head" title="${escapeHtml(sessionId)}">
            ${agentBadge(harness)}
            <span class="act-sess-name">${escapeHtml(name)}</span>
            ${title ? `<span class="act-sess-title" title="${titleText}">${titleText}</span>` : ""}
          </div>
          <div class="act-entries">${entries.map((e) => activityEntryHtml(e, selected === e.id, databaseType)).join("")}</div>
        </section>`;
}

// One decision as a selectable row; the right pane shows it in full. The sensitivity flags
// stay on the row so the eye finds them while scanning.
export function activityEntryHtml(
  e: ActivityEntry,
  selected: boolean,
  databaseType: string,
): string {
  const ts = e.decidedAt ?? e.createdAt;
  return doneRowHtml(
    auditItem(e, null),
    selected,
    "audit",
    `<span class="act-time">${escapeHtml(clockTime(ts))}</span>`,
    databaseType,
    entryFlags(e, textSchema(e.sql, databaseType)),
    true,
  );
}

// The decision's recorded flags when the broker sends a well-formed record, else what the
// SQL text shows. Either way the trail never queries the database it audits.
export function entryFlags(e: ActivityEntry, text: SchemaContext | null): SensitivityRecord | null {
  const r = e.sensitivity;
  if (
    r &&
    typeof r.pii === "boolean" &&
    typeof r.value === "boolean" &&
    typeof r.client === "boolean"
  ) {
    return r;
  }
  return text ? sensitivityOf(text) : null;
}

// Spelled-out sensitivity labels for the export, from the same flags the row chips read.
// Presence only, never which columns, so the export stays as PII-safe as the trail.
export function activityFlagLabels(flags: SensitivityRecord): string[] {
  const labels: string[] = [];
  if (flags.pii) {
    labels.push("PII");
  }
  if (flags.value) {
    labels.push("sensitive value");
  }
  if (flags.client) {
    labels.push("client-data");
  }
  return labels;
}

// Per-entry sensitivity labels from entryFlags, keyed by entry id. Every export reads this
// map so markdown, CSV and JSON agree with the row chips.
export type ActivityFlagMap = ReadonlyMap<string, string[]>;

// CommonMark: a fenced block ends at the first line with at least as many backticks as
// its opening fence, so SQL containing ``` needs an opening fence longer than any run in it.
function codeFence(sql: string): string {
  const longest = Math.max(0, ...(sql.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

// The whole selection as one document, newest-first entries in, oldest first out: its totals, then
// each day, each session in the order it first appears that day, and each of its decisions.
export function activityMarkdownDays(
  entries: ActivityEntry[],
  connectionName: string,
  flags: ActivityFlagMap = new Map(),
): string {
  const oldestFirst = [...entries].reverse();
  const days = new Map<string, Map<string, ActivityEntry[]>>();
  for (const e of oldestFirst) {
    const day = dayKey(e.decidedAt ?? e.createdAt);
    const sessions = days.get(day) ?? new Map<string, ActivityEntry[]>();
    days.set(day, sessions);
    const list = sessions.get(e.sessionId) ?? [];
    sessions.set(e.sessionId, list);
    list.push(e);
  }
  const keys = [...days.keys()];
  const lines: string[] = ["# Gatekeeper Audit Trail", ""];
  if (connectionName) {
    lines.push(`- Connection: ${connectionName}`);
  }
  if (keys.length === 1) {
    lines.push(`- Day: ${keys[0]}`);
  } else if (keys.length) {
    lines.push(`- Days: ${keys[0]} to ${keys.at(-1)} (${keys.length} days)`);
  }
  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    const label = statusLabel(e);
    acc[label] = (acc[label] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(counts)
    .map(([label, n]) => `${n} ${capitalize(label)}`)
    .join(" · ");
  lines.push(`- Queries: ${entries.length}${breakdown ? ` (${breakdown})` : ""}`);
  lines.push(`- Sessions: ${new Set(entries.map((e) => e.sessionId)).size}`, "");
  for (const [day, sessions] of days) {
    lines.push(`## ${day}`, "");
    for (const [sessionId, list] of sessions) {
      const first = list[0];
      const label = first.project?.trim() || first.harness?.trim() || sessionId;
      lines.push(`### ${label} (${sessionId})`);
      if (first.harness?.trim()) {
        lines.push(`- Harness: ${first.harness.trim()}`);
      }
      if (first.sessionLabel?.trim()) {
        lines.push(`- Task: ${first.sessionLabel.trim()}`);
      }
      lines.push("");
      for (const e of list) {
        lines.push(...entryMarkdown(e, flags));
      }
    }
  }
  return lines.join("\n");
}

// The outcome word every export writes, as the trail shows it: a statement the gate refused to run
// was not run, not declined.
function statusLabel(e: ActivityEntry): string {
  return e.state === "rejected" && e.declinedBy === "gate" ? "not run" : outcomeMeta(e.state).label;
}

// One decision under its session: its time, outcome and intent, the facts recorded with it, then
// its SQL fenced so no backtick run inside can close the block early.
function entryMarkdown(e: ActivityEntry, flags: ActivityFlagMap): string[] {
  const ts = e.decidedAt ?? e.createdAt;
  const status = capitalize(statusLabel(e));
  const intent = e.intent?.trim();
  const lines = [
    `#### ${new Date(ts).toLocaleTimeString()} · ${intent ? `${status} · ${capitalize(intent)}` : status}`,
  ];
  const entryFlags = flags.get(e.id);
  if (entryFlags?.length) {
    lines.push(`- Flags: ${entryFlags.join(", ")}`);
  }
  const latency = activityLatency(e);
  if (latency !== "—") {
    lines.push(`- Latency: ${latency}`);
  }
  lines.push(`- Request: ${e.id}`);
  if (e.approval)
    lines.push(
      `- Approval: ${approvalLabel(e.approval)}`,
      `- Evaluation: ${JSON.stringify(e.approval.evaluation ?? null)}`,
    );
  if (e.autoHold)
    lines.push(
      `- Auto mode: ${e.autoHold.sent ? "sent, evaluation unfinished" : "stopped locally, nothing sent"}`,
      `- Auto mode reason: ${e.autoHold.reason}`,
    );
  if (e.state === "approved" && e.affectedRows != null) {
    lines.push(`- Rows changed: ${e.affectedRows}`);
  }
  if (e.state === "approved" && e.rowCount != null) {
    lines.push(`- Rows returned: ${e.rowCount}`);
  }
  if (e.reason?.trim()) {
    lines.push(`- Reason: ${e.reason.trim()}`);
  }
  if (e.error?.trim()) {
    lines.push(`- Error: ${e.error.trim()}`);
  }
  const sqlBody = visibleControls(e.sql.trim());
  const fence = codeFence(sqlBody);
  lines.push("", `${fence}sql`, sqlBody, fence, "");
  return lines;
}

const CSV_HEADER = [
  "session_id",
  "timestamp",
  "status",
  "latency_ms",
  "intent",
  "flags",
  "request_id",
  "rows_returned",
  "rows_changed",
  "reason",
  "error",
  "sql",
];

// Every activity field is free text, so the formula guard always applies before quoting.
function csvField(value: string): string {
  return csvQuote(csvFormulaGuard(value));
}

// session_id leads so exports merge across sessions; the SQL is flattened so a row is
// one line, and a UTF-8 BOM leads the file so Excel reads accented intents as UTF-8.
export function activityCsv(entries: ActivityEntry[], flags: ActivityFlagMap = new Map()): string {
  const rows = [...entries].reverse().map((e) => {
    const ts = e.decidedAt ?? e.createdAt;
    const latency =
      activityLatency(e) !== "—" && e.decidedAt != null ? `${e.decidedAt - e.createdAt}` : "";
    return [
      e.sessionId,
      new Date(ts).toISOString(),
      statusLabel(e),
      latency,
      e.intent?.trim() ?? "",
      (flags.get(e.id) ?? []).join("; "),
      e.id,
      e.rowCount != null ? `${e.rowCount}` : "",
      e.affectedRows != null ? `${e.affectedRows}` : "",
      e.reason?.trim() ?? "",
      e.error?.trim() ?? "",
      visibleControls(e.sql).replace(/\s+/g, " ").trim(),
    ]
      .map(csvField)
      .join(",");
  });
  const body = [CSV_HEADER.join(","), ...rows].join("\r\n");
  // Lead with a UTF-8 BOM so Excel decodes accented intents as UTF-8, not Latin-1.
  return `﻿${body}\r\n`;
}

// The same session-day timeline as an array of native-typed rows: numbers stay numbers,
// absent optionals are null, and the SQL is kept whole rather than flattened onto a line.
export function activityJson(entries: ActivityEntry[], flags: ActivityFlagMap = new Map()): string {
  const rows = [...entries].reverse().map((e) => {
    const ts = e.decidedAt ?? e.createdAt;
    const latencyMs =
      activityLatency(e) !== "—" && e.decidedAt != null ? e.decidedAt - e.createdAt : null;
    return {
      session_id: e.sessionId,
      timestamp: new Date(ts).toISOString(),
      status: statusLabel(e),
      latency_ms: latencyMs,
      intent: e.intent?.trim() || null,
      flags: flags.get(e.id) ?? [],
      request_id: e.id,
      rows_returned: e.rowCount ?? null,
      // An entry from before the count existed reads as unknown, never as zero.
      rows_changed: e.affectedRows ?? null,
      reason: e.reason?.trim() || null,
      error: e.error?.trim() || null,
      sql: visibleControls(e.sql.trim()),
      ...(e.approval ? { approval: e.approval } : {}),
      ...(e.evaluation ? { evaluation: e.evaluation } : {}),
      ...(e.autoHold ? { autoHold: e.autoHold } : {}),
    };
  });
  return `${JSON.stringify(rows, null, 2)}\n`;
}
