import type { ActivityEntry, SessionMeta } from "./types";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Display polish for an agent-written intent: force the first character upper,
// in case it arrived lowercase. A non-letter first char is left as-is.
export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

export function relAge(createdAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

const HIST_SQL_PREVIEW_CHARS = 140;

// Truncate the raw SQL before highlight()/escapeHtml() run, so highlight() only
// ever wraps complete substrings; slicing already-highlighted HTML could cut a tag.
export function previewSql(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > HIST_SQL_PREVIEW_CHARS
    ? `${flat.slice(0, HIST_SQL_PREVIEW_CHARS)}...`
    : flat;
}

export function sessionDisplayName(session: SessionMeta | null, fallback: string): string {
  const project = session?.project?.trim();
  if (project) {
    return project;
  }
  const harness = session?.harness?.trim();
  return harness || session?.sessionId || fallback;
}

// Local calendar-day key (YYYY-MM-DD) that groups the activity feed by day.
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}`;
}

export function dayLabel(ts: number): string {
  const key = dayKey(ts);
  const now = Date.now();
  if (key === dayKey(now)) {
    return "Today";
  }
  if (key === dayKey(now - 86_400_000)) {
    return "Yesterday";
  }
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// Map a terminal state to the shared status tokens: green approved, red
// rejected/failed, faint for the neutral terminals (expired/cancelled).
export function outcomeMeta(state: string): { cls: "ok" | "no" | "mut"; label: string } {
  if (state === "approved") {
    return { cls: "ok", label: "approved" };
  }
  if (state === "rejected") {
    // A rejection is a one-click decline, not a changes-requested round trip.
    return { cls: "no", label: "declined" };
  }
  if (state === "failed") {
    return { cls: "no", label: "failed" };
  }
  return { cls: "mut", label: state };
}

// Execution latency, shown only for outcomes that actually ran a query; a rejected
// or expired proposal never reached the database, so it reads as a dash. Sub-500ms
// stays in milliseconds, above that one decimal second reads more calmly.
export function activityLatency(e: ActivityEntry): string {
  if (e.state !== "approved" && e.state !== "failed") {
    return "—";
  }
  if (e.decidedAt == null) {
    return "—";
  }
  const ms = e.decidedAt - e.createdAt;
  if (ms < 0) {
    return "—";
  }
  return ms >= 500 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// The short outcome note on a collapsed row: a scalar row count, the rejection
// reason, or the failure error. Never any row content.
export function activityNote(e: ActivityEntry): string {
  if (e.state === "approved") {
    return e.rowCount != null ? `${e.rowCount} rows` : "";
  }
  if (e.state === "rejected") {
    return e.reason ?? "";
  }
  if (e.state === "failed") {
    return e.error ?? "";
  }
  return "";
}
