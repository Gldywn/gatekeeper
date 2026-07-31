import {
  activityNote,
  capitalize,
  clockTime,
  dayKey,
  dayLabel,
  escapeHtml,
  outcomeMeta,
  previewSql,
} from "../html";
import { chevronDown, copyIcon, downloadIcon, harnessIcon } from "../icons";
import { formatSql } from "../sql/format";
import { highlight } from "../sql/highlight";
import type { ActivityEntry } from "../types";

export function activityShell(body: string, connectionName: string): string {
  const conn = connectionName ? escapeHtml(connectionName) : "";
  return `
      <div class="detail-card activity-card">
        <div class="detail-head">
          <span class="detail-who">Activity</span>
          ${conn ? `<span class="act-conn">${conn}</span>` : ""}
          <button class="detail-close" type="button" data-close aria-label="Close activity">&times;</button>
        </div>
        <div class="act-body">${body}</div>
      </div>`;
}

// Group the feed by day, then by session within each day, preserving the
// server's newest-first order for both the groups and the entries inside them.
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
  return days
    .map(
      (d) => `
        <section class="act-day">
          <div class="act-day-head">${escapeHtml(d.label)}</div>
          ${[...d.sessions.entries()].map(([sid, entries]) => activityGroupHtml(d.key, sid, entries, expanded)).join("")}
        </section>`,
    )
    .join("");
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
  const label = project ? escapeHtml(project) : escapeHtml(harness || sessionId);
  const intent = first.sessionLabel?.trim();
  return `
        <section class="act-group">
          <div class="act-group-head">
            <span class="harness-badge">${harnessIcon(harness)}</span>
            <span class="act-group-label">${label}</span>
            ${intent ? `<span class="act-group-intent" title="${escapeHtml(capitalize(intent))}">${escapeHtml(capitalize(intent))}</span>` : ""}
            <span class="act-group-sess">${escapeHtml(sessionId)}</span>
            <button class="act-export" type="button" data-export="${escapeHtml(`${day}|${sessionId}`)}">${downloadIcon}Export</button>
          </div>
          <div class="act-entries">${entries.map((e) => activityEntryHtml(e, expanded)).join("")}</div>
        </section>`;
}

export function activityEntryHtml(e: ActivityEntry, expanded: Set<string>): string {
  const ts = e.decidedAt ?? e.createdAt;
  const { cls, label } = outcomeMeta(e.state);
  const note = activityNote(e);
  const intent = e.intent?.trim();
  const headline = intent ? capitalize(intent) : previewSql(e.sql);
  const isExpanded = expanded.has(e.id);
  // The row note truncates; the full reason/error rides the expanded panel.
  const detailNote =
    e.state === "rejected" && e.reason ? e.reason : e.state === "failed" && e.error ? e.error : "";
  return `
          <div class="act-entry${isExpanded ? " open" : ""}" data-act="${escapeHtml(e.id)}">
            <button class="act-row" type="button" data-act-sql="${escapeHtml(e.id)}" aria-expanded="${isExpanded}">
              <span class="chev">${chevronDown}</span>
              <span class="act-time">${escapeHtml(clockTime(ts))}</span>
              <span class="hstatus ${cls}">${escapeHtml(label)}</span>
              <span class="act-intent">${escapeHtml(headline)}</span>
              ${note ? `<span class="act-note">${escapeHtml(note)}</span>` : ""}
            </button>
            <div class="act-detail"${isExpanded ? "" : " hidden"}>
              <div class="act-meta">${escapeHtml(e.id)} &middot; ${escapeHtml(new Date(ts).toLocaleString())}</div>
              ${detailNote ? `<div class="detail-outcome">${escapeHtml(detailNote)}</div>` : ""}
              <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="${escapeHtml(e.sql)}" aria-label="Copy SQL">${copyIcon}</button><code>${highlight(formatSql(e.sql))}</code></pre>
            </div>
          </div>`;
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
