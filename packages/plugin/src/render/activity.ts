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
import {
  agentBadge,
  alertTriangleIcon,
  chevronDown,
  downloadIcon,
  jsonIcon,
  markdownIcon,
  tableIcon,
} from "../icons";
import { classifyQuery } from "../sql/classify";
import { visibleControls } from "../sql/sanitize";
import { type SchemaContext, sensitivityOf, textSchema } from "../sql/schema";
import type { ActivityEntry } from "../types";
import { approvalLabel, autoIcon } from "./auto";
import { flyoutMenu } from "./controls";
import { auditItem, doneRowHtml } from "./inbox";

// The Audit Trail in the Inbox's left pane: its rows, then the tail that loads older days.
export function activityShell(): string {
  return '<div class="act-body"></div><div class="act-tail" aria-live="polite"></div>';
}

// Group the feed by day, then by session within each day, preserving the server's
// newest-first order throughout. Today lands open; older days fold so the log opens
// on the latest activity, one click from any deeper day.
export function activityDaysHtml(
  activity: ActivityEntry[],
  selected: string | null,
  dialect: string,
  // false for an older page appended below: it arrives all folded.
  openNewest = true,
): string {
  const days: { key: string; label: string; entries: ActivityEntry[] }[] = [];
  for (const e of activity) {
    const ts = e.decidedAt ?? e.createdAt;
    const key = dayKey(ts);
    const day = days.find((d) => d.key === key);
    if (day) {
      day.entries.push(e);
    } else {
      days.push({ key, label: dayLabel(ts), entries: [e] });
    }
  }
  const today = dayKey(Date.now());
  // Today when present, else the newest day, so exactly one day starts open.
  const openKey = openNewest ? (days.find((d) => d.key === today)?.key ?? days[0]?.key) : null;
  return days
    .map((d) => {
      const total = d.entries.length;
      const sessions = new Set(d.entries.map((e) => e.sessionId)).size;
      const collapsed = d.key !== openKey;
      const count = `&middot; ${total} ${total === 1 ? "query" : "queries"} &middot; ${sessions} ${sessions === 1 ? "session" : "sessions"}`;
      // A folded day ships without its rows: the view builds them on first unfold, so a
      // long prefetched history costs one line per day.
      const body = collapsed ? "" : activityDayBodyHtml(d.key, d.entries, selected, dialect);
      return `
        <section class="act-day${collapsed ? " collapsed" : ""}">
          <button class="act-day-head" type="button" data-day="${escapeHtml(d.key)}" aria-expanded="${!collapsed}">
            <span class="act-day-chev">${chevronDown}</span>
            <span class="act-day-label">${escapeHtml(d.label)}</span>
            <span class="act-day-count">${count}</span>
          </button>
          <div class="act-day-body">${body}</div>
        </section>`;
    })
    .join("");
}

// One day's rows, grouped by session in first-seen (newest-first) order.
export function activityDayBodyHtml(
  day: string,
  entries: ActivityEntry[],
  selected: string | null,
  dialect: string,
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
    .map(([sid, group]) => activityGroupHtml(day, sid, group, selected, dialect))
    .join("");
}

// While an older page loads: placeholder day heads shaped like what is coming, so the list
// keeps reading as a list rather than ending on a status line.
export function activityTailLoading(): string {
  const row =
    '<div class="act-tail-row act-skel" aria-hidden="true"><span class="act-tail-slot"><span class="act-skel-dot"></span></span><span class="act-skel-bar"></span><span class="act-skel-bar"></span></div>';
  return `<div role="status" aria-label="Loading older days">${row}${row}${row}</div>`;
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

// One agent session within a day: who it was and what it worked on, its count, and the export
// of that session-day, then its decisions.
export function activityGroupHtml(
  _day: string,
  sessionId: string,
  entries: ActivityEntry[],
  selected: string | null,
  dialect: string,
): string {
  const first = entries[0];
  const harness = first.harness?.trim() || null;
  const name = first.project?.trim() || harness || shortSession(sessionId);
  const title = first.sessionLabel?.trim();
  const titleText = title ? escapeHtml(capitalize(title)) : "";
  // TODO(v1-19): count and export hidden during the Inbox redesign; a global export (pick the
  // days) brings export back in its own PR, which can reuse `exportControl` below.
  return `
        <section class="act-group">
          <div class="act-group-head" title="${escapeHtml(sessionId)}">
            ${agentBadge(harness)}
            <span class="act-sess-name">${escapeHtml(name)}</span>
            ${title ? `<span class="act-sess-title" title="${titleText}">${titleText}</span>` : ""}
          </div>
          <div class="act-entries">${entries.map((e) => activityEntryHtml(e, selected === e.id, dialect)).join("")}</div>
        </section>`;
}

// The per-session-day export: the shared flyout keyed on the session-day so the click
// handler stays stateless, offering the whole timeline as Markdown, CSV, or JSON.
export function exportControl(day: string, sessionId: string): string {
  return flyoutMenu("export", `${day}|${sessionId}`, downloadIcon, "Export", [
    { fmt: "md", icon: markdownIcon, name: "Markdown" },
    { fmt: "csv", icon: tableIcon, name: "CSV" },
    { fmt: "json", icon: jsonIcon, name: "JSON" },
  ]);
}

// Auto mode evaluated or held this read but a human decided: a quiet bolt says it was involved.
// When Auto mode approved it, the row's own glyph is already the bolt.
function autoFlag(e: ActivityEntry): string {
  const evaluation = e.approval?.evaluation ?? e.evaluation;
  if (e.approval?.source === "automatic" || (!evaluation && !e.autoHold)) {
    return "";
  }
  const label = evaluation
    ? "Evaluated by Auto mode, decided by you"
    : "Auto mode stopped this read before evaluation";
  return `<span class="act-flag auto" title="${label}" aria-label="${label}">${autoIcon}</span>`;
}

// One decision as a selectable row; the right pane shows it in full. The sensitivity flags
// stay on the row so the eye finds them while scanning.
export function activityEntryHtml(e: ActivityEntry, selected: boolean, dialect: string): string {
  const ts = e.decidedAt ?? e.createdAt;
  const flags = entryFlags(e, textSchema(e.sql, dialect));
  const side = `<span class="ix-side">${autoFlag(e)}${flags ? `<span class="act-flags">${activityFlagsHtml(flags)}</span>` : ""}<span class="act-time">${escapeHtml(clockTime(ts))}</span></span>`;
  return doneRowHtml(
    auditItem(e, null),
    selected,
    "audit",
    side,
    classifyQuery(e.sql, dialect).class,
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

// The condensed sensitivity flags on a row: presence only, never which columns.
export function activityFlagsHtml(flags: SensitivityRecord): string {
  let html = "";
  if (flags.pii) {
    html += '<span class="act-flag pii">PII</span>';
  }
  if (flags.value) {
    html += '<span class="act-flag val">Value</span>';
  }
  if (flags.client) {
    html += '<span class="act-flag client">Client</span>';
  }
  return html;
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

export function activityMarkdown(
  day: string,
  sessionId: string,
  entries: ActivityEntry[],
  connectionName: string,
  flags: ActivityFlagMap = new Map(),
): string {
  const first = entries[0];
  const label = first.project?.trim() || first.harness?.trim() || sessionId;
  const lines: string[] = ["# Gatekeeper Audit Trail", ""];
  if (connectionName) {
    lines.push(`- Connection: ${connectionName}`);
  }
  lines.push(`- Day: ${day}`, `- Session: ${label} (${sessionId})`);
  if (first.harness?.trim()) {
    lines.push(`- Harness: ${first.harness.trim()}`);
  }
  if (first.sessionLabel?.trim()) {
    lines.push(`- Task: ${first.sessionLabel.trim()}`);
  }
  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.state] = (acc[e.state] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(counts)
    .map(([s, n]) => `${n} ${capitalize(outcomeMeta(s).label)}`)
    .join(" · ");
  lines.push(`- Queries: ${entries.length}${breakdown ? ` (${breakdown})` : ""}`);
  lines.push("");
  // Oldest-first reads as a timeline.
  for (const e of [...entries].reverse()) {
    const ts = e.decidedAt ?? e.createdAt;
    const status = capitalize(outcomeMeta(e.state).label);
    const intent = e.intent?.trim();
    lines.push(
      `## ${new Date(ts).toLocaleTimeString()} · ${intent ? `${status} · ${capitalize(intent)}` : status}`,
    );
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
  }
  return lines.join("\n");
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
      outcomeMeta(e.state).label,
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
      status: outcomeMeta(e.state).label,
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
