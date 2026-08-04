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
import { chevronDown, copyIcon, downloadIcon, harnessIcon, historyIcon } from "../icons";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import type { SchemaContext } from "../sql/schema";
import type { ActivityEntry } from "../types";

export function activityShell(body: string, connChip: string): string {
  return `
      <div class="detail-card activity-card">
        <div class="panel-head">
          <span class="panel-head-ico">${historyIcon}</span>
          <span class="panel-title">Audit trail</span>
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
            <button class="act-export" type="button" data-export="${escapeHtml(`${day}|${sessionId}`)}">${downloadIcon}Export</button>
          </div>
          <div class="act-entries">${entries.map((e) => activityEntryHtml(e, expanded)).join("")}</div>
        </section>`;
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
              <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(e.sql)}" aria-label="Copy SQL">${copyIcon}</button><code>${highlight(formatSql(e.sql))}</code></pre>
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

export function activityMarkdown(
  day: string,
  sessionId: string,
  entries: ActivityEntry[],
  connectionName: string,
): string {
  const first = entries[0];
  const label = first.project?.trim() || first.harness?.trim() || sessionId;
  const lines: string[] = ["# Gatekeeper activity", ""];
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
  lines.push("");
  // Oldest-first reads as a timeline.
  for (const e of [...entries].reverse()) {
    const ts = e.decidedAt ?? e.createdAt;
    lines.push(`## ${new Date(ts).toLocaleTimeString()} · ${outcomeMeta(e.state).label}`);
    if (e.intent?.trim()) {
      lines.push(`- Intent: ${e.intent.trim()}`);
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
