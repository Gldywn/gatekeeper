import {
  activityLatency,
  capitalize,
  clockTime,
  dayKey,
  dayLabel,
  escapeHtml,
  outcomeMeta,
  previewSql,
} from "../html";
import {
  chevronDown,
  copyIcon,
  downloadIcon,
  harnessIcon,
  historyIcon,
  markdownIcon,
  tableIcon,
} from "../icons";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import type { SchemaContext } from "../sql/schema";
import type { ActivityEntry } from "../types";

export function activityShell(body: string, connChip: string): string {
  return `
      <div class="detail-card activity-card">
        <div class="panel-head">
          <span class="panel-head-ico">${historyIcon}</span>
          <span class="panel-title">Audit Trail</span>
          ${connChip}
          <button class="detail-close" type="button" data-close aria-label="Close audit trail">&times;</button>
        </div>
        <div class="act-body">${body}</div>
      </div>`;
}

// Group the feed by day, then by session within each day, preserving the server's
// newest-first order throughout. Today lands open; older days fold so the log opens
// on the latest activity, one click from any deeper day.
export function activityDaysHtml(activity: ActivityEntry[], expanded: Set<string>): string {
  const days: { key: string; label: string; sessions: Map<string, ActivityEntry[]> }[] = [];
  for (const e of activity) {
    const ts = e.decidedAt ?? e.createdAt;
    const key = dayKey(ts);
    let day = days.find((d) => d.key === key);
    if (!day) {
      day = { key, label: dayLabel(ts), sessions: new Map() };
      days.push(day);
    }
    const arr = day.sessions.get(e.sessionId);
    if (arr) {
      arr.push(e);
    } else {
      day.sessions.set(e.sessionId, [e]);
    }
  }
  const today = dayKey(Date.now());
  // Today when present, else the newest day, so exactly one day starts open.
  const openKey = days.find((d) => d.key === today)?.key ?? days[0]?.key;
  return days
    .map((d) => {
      const total = [...d.sessions.values()].reduce((n, arr) => n + arr.length, 0);
      const sessions = d.sessions.size;
      const collapsed = d.key !== openKey;
      const count = `&middot; ${total} ${total === 1 ? "query" : "queries"} &middot; ${sessions} ${sessions === 1 ? "session" : "sessions"}`;
      const groups = [...d.sessions.entries()]
        .map(([sid, entries]) => activityGroupHtml(d.key, sid, entries, expanded))
        .join("");
      return `
        <section class="act-day${collapsed ? " collapsed" : ""}">
          <button class="act-day-head" type="button" data-day="${escapeHtml(d.key)}" aria-expanded="${!collapsed}">
            <span class="act-day-chev">${chevronDown}</span>
            <span class="act-day-label">${escapeHtml(d.label)}</span>
            <span class="act-day-count">${count}</span>
          </button>
          <div class="act-day-body">${groups}</div>
        </section>`;
    })
    .join("");
}

// Cryptic session ids are long; keep a recognisable head and tail so a group still
// maps back to its agent without spanning the whole row.
function shortSession(id: string): string {
  return id.length > 14 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id;
}

function sessionMeta(
  project: string | undefined,
  harness: string | null,
  sessionId: string,
): string {
  const parts: string[] = [];
  if (project) {
    parts.push(`<span class="act-proj">${escapeHtml(project)}</span>`);
  }
  if (harness) {
    parts.push(escapeHtml(harness));
  }
  parts.push(escapeHtml(shortSession(sessionId)));
  return parts.join(" &middot; ");
}

export function activityGroupHtml(
  day: string,
  sessionId: string,
  entries: ActivityEntry[],
  expanded: Set<string>,
): string {
  const first = entries[0];
  const harness = first.harness?.trim() || null;
  const project = first.project?.trim();
  // The session task is the group's hero; the meta line above it carries the context.
  const title = first.sessionLabel?.trim();
  const titleText = title ? escapeHtml(capitalize(title)) : "";
  return `
        <section class="act-group">
          <div class="act-group-head">
            <span class="act-avatar">${harnessIcon(harness)}</span>
            <span class="act-sess-idblock">
              <span class="act-sess-meta">${sessionMeta(project, harness, sessionId)}</span>
              ${title ? `<span class="act-sess-title" title="${titleText}">${titleText}</span>` : ""}
            </span>
            <span class="act-sess-n">${entries.length}</span>
            ${exportControl(day, sessionId)}
          </div>
          <div class="act-entries">${entries.map((e) => activityEntryHtml(e, expanded)).join("")}</div>
        </section>`;
}

// The Export trigger and its compact format menu. The trigger toggles the menu; each
// option carries both the session-day key and its format, so the click handler stays
// stateless. Kept lighter than the mode dropdown: two icon rows, no descriptions.
function exportControl(day: string, sessionId: string): string {
  const key = escapeHtml(`${day}|${sessionId}`);
  const opt = (fmt: "md" | "csv", icon: string, name: string) =>
    `<button class="act-export-opt" type="button" role="menuitem" data-export="${key}" data-export-fmt="${fmt}">${icon}${name}<span class="act-export-ext">.${fmt}</span></button>`;
  return `<span class="act-export-wrap">
              <button class="act-export" type="button" data-export-trigger="${key}" aria-haspopup="menu" aria-expanded="false">${downloadIcon}Export<span class="act-export-chev">${chevronDown}</span></button>
              <div class="act-export-menu" data-export-menu role="menu" hidden>
                ${opt("md", markdownIcon, "Markdown")}
                ${opt("csv", tableIcon, "CSV")}
              </div>
            </span>`;
}

export function activityEntryHtml(e: ActivityEntry, expanded: Set<string>): string {
  const ts = e.decidedAt ?? e.createdAt;
  const intent = e.intent?.trim();
  const headline = intent ? capitalize(intent) : previewSql(e.sql);
  const isExpanded = expanded.has(e.id);
  const state = e.state;
  const label = capitalize(outcomeMeta(state).label);
  // The full reason/error rides the expanded panel, tinted toward the outcome colour.
  const note = state === "rejected" ? e.reason?.trim() : state === "failed" ? e.error?.trim() : "";
  const rows = state === "approved" && e.rowCount != null ? ` &middot; ${e.rowCount} rows` : "";
  return `
          <div class="act-entry${isExpanded ? " open" : ""}" data-act="${escapeHtml(e.id)}">
            <button class="act-row" type="button" data-act-sql="${escapeHtml(e.id)}" aria-expanded="${isExpanded}">
              <span class="chev">${chevronDown}</span>
              <span class="act-time">${escapeHtml(clockTime(ts))}</span>
              <span class="act-state ${escapeHtml(state)}">${escapeHtml(label)}</span>
              <span class="act-intent">${escapeHtml(headline)}</span>
              <span class="act-flags" data-act-flags="${escapeHtml(e.id)}"></span>
              <span class="act-lat">${escapeHtml(activityLatency(e))}</span>
            </button>
            <div class="act-detail"${isExpanded ? "" : " hidden"}>
              <div class="act-meta">${escapeHtml(e.id)} &middot; ${escapeHtml(new Date(ts).toLocaleString())}${rows}</div>
              ${note ? `<div class="act-enote ${escapeHtml(state)}">${escapeHtml(note)}</div>` : ""}
              <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(e.sql)}" aria-label="Copy SQL">${copyIcon}</button><code data-act-sqlbody="${escapeHtml(e.id)}">${highlight(formatSql(e.sql))}</code></pre>
            </div>
          </div>`;
}

// The condensed sensitivity flags on a row: presence only, never which columns. Patched
// in after render because they need the schema, which is fetched and cached per table.
export function activityFlagsHtml(schema: SchemaContext): string {
  let html = "";
  if (schema.pii.length) {
    html += '<span class="act-flag pii">PII</span>';
  }
  if (schema.literals.length) {
    html += '<span class="act-flag val">Value</span>';
  }
  if (schema.client.length) {
    html += '<span class="act-flag client">Client</span>';
  }
  return html;
}

// Spelled-out sensitivity labels for the export, from the same schema the row chips
// read: PII columns, sensitive literals in a filter, and client-confidential columns.
// Presence only, never which columns, so the export stays as PII-safe as the trail.
export function activityFlagLabels(schema: SchemaContext): string[] {
  const labels: string[] = [];
  if (schema.pii.length) {
    labels.push("PII");
  }
  if (schema.literals.length) {
    labels.push("sensitive value");
  }
  if (schema.client.length) {
    labels.push("client-data");
  }
  return labels;
}

// Per-entry sensitivity labels, resolved host-side by the caller (schema is cached per
// table) and keyed by entry id. Both exports read this map so markdown and CSV agree.
export type ActivityFlagMap = ReadonlyMap<string, string[]>;

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
    if (e.state === "approved" && e.rowCount != null) {
      lines.push(`- Rows: ${e.rowCount}`);
    }
    if (e.reason?.trim()) {
      lines.push(`- Reason: ${e.reason.trim()}`);
    }
    if (e.error?.trim()) {
      lines.push(`- Error: ${e.error.trim()}`);
    }
    lines.push("", "```sql", e.sql.trim(), "```", "");
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
  "rows",
  "reason",
  "error",
  "sql",
];

// RFC 4180 field: double internal quotes and wrap when the value carries a comma,
// quote, or newline. A leading =, +, -, or @ is neutralised with a ' so a spreadsheet
// imports it as text, not a formula (CSV-injection guard).
function csvField(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
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
      e.reason?.trim() ?? "",
      e.error?.trim() ?? "",
      e.sql.replace(/\s+/g, " ").trim(),
    ]
      .map(csvField)
      .join(",");
  });
  const body = [CSV_HEADER.join(","), ...rows].join("\r\n");
  // Lead with a UTF-8 BOM so Excel decodes accented intents as UTF-8, not Latin-1.
  return `﻿${body}\r\n`;
}
