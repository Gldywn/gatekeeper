// TZ is pinned before the module's Date rendering so clockTime()/toLocaleString()
// are byte-stable on any machine (dev or CI).
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../types";
import {
  activityCsv,
  activityEntryHtml,
  activityGroupHtml,
  activityJson,
  activityMarkdown,
} from "./activity";

const T = new Date("2026-01-01T09:30:00Z").getTime();

const approved: ActivityEntry = {
  id: "q_ab12",
  createdAt: T - 5000,
  decidedAt: T,
  sessionId: "s1",
  harness: "claude-code",
  project: "gatekeeper",
  sessionLabel: "audit review",
  sql: "SELECT email FROM audit.users",
  intent: "list account contacts",
  state: "approved",
  reason: null,
  error: null,
  rowCount: 3,
};

const rejected: ActivityEntry = {
  id: "q_cd34",
  createdAt: T - 60_000,
  decidedAt: T - 30_000,
  sessionId: "s1",
  harness: "claude-code",
  project: "gatekeeper",
  sessionLabel: "audit review",
  sql: "DELETE FROM audit.users WHERE id = 1",
  intent: "remove a user",
  state: "rejected",
  reason: "read-only only",
  error: null,
  rowCount: null,
};

describe("render/activity", () => {
  it("renders an expanded approved entry", () => {
    expect(activityEntryHtml(approved, new Set(["q_ab12"]), "postgresql")).toBe(
      '\n          <div class="act-entry open" data-act="q_ab12">\n            <button class="act-row" type="button" data-act-sql="q_ab12" aria-expanded="true">\n              <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>\n              <span class="act-time">09:30 AM</span>\n              <span class="act-state approved">Approved</span>\n              <span class="act-intent">List account contacts</span>\n              <span class="act-flags" data-act-flags="q_ab12"></span>\n              <span class="act-metric">3 rows returned</span>\n            </button>\n            <div class="act-detail">\n              <div class="act-meta">q_ab12 &middot; 1/1/2026, 9:30:00 AM &middot; 3 rows returned</div>\n              \n              <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="SELECT email FROM audit.users" aria-label="Copy SQL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button><code data-act-sqlbody="q_ab12"><span class="kw">SELECT</span>\n  email\n<span class="kw">FROM</span> audit.users</code></pre>\n            </div>\n          </div>',
    );
  });

  it("renders a collapsed rejected entry", () => {
    expect(activityEntryHtml(rejected, new Set(), "postgresql")).toBe(
      '\n          <div class="act-entry" data-act="q_cd34">\n            <button class="act-row" type="button" data-act-sql="q_cd34" aria-expanded="false">\n              <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>\n              <span class="act-time">09:29 AM</span>\n              <span class="act-state rejected">Declined</span>\n              <span class="act-risk destructive" title="Destructive"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></span><span class="act-intent">Remove a user</span>\n              <span class="act-flags" data-act-flags="q_cd34"></span>\n              <span class="act-metric"></span>\n            </button>\n            <div class="act-detail" hidden>\n              <div class="act-meta">q_cd34 &middot; 1/1/2026, 9:29:30 AM</div>\n              <div class="act-enote rejected">read-only only</div>\n              <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="DELETE FROM audit.users WHERE id = 1" aria-label="Copy SQL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button><code data-act-sqlbody="q_cd34"><span class="kw">DELETE</span>\n<span class="kw">FROM</span> audit.users\n<span class="kw">WHERE</span> id = 1</code></pre>\n            </div>\n          </div>',
    );
  });

  it("renders the export trigger and its Markdown/CSV/JSON format menu", () => {
    const html = activityGroupHtml("2026-01-01", "s1", [approved], new Set(), "postgresql");
    expect(html).toContain('data-flyout-trigger="2026-01-01|s1"');
    expect(html).toContain("data-flyout-menu");
    expect(html).toContain(
      'data-flyout-action="export" data-flyout-key="2026-01-01|s1" data-flyout-fmt="md"',
    );
    expect(html).toContain(
      'data-flyout-action="export" data-flyout-key="2026-01-01|s1" data-flyout-fmt="csv"',
    );
    expect(html).toContain(
      'data-flyout-action="export" data-flyout-key="2026-01-01|s1" data-flyout-fmt="json"',
    );
  });

  it("renders a session-day markdown export with intent in the title, flags and latency", () => {
    const flags = new Map([["q_ab12", ["PII", "sensitive value"]]]);
    expect(
      activityMarkdown("2026-01-01", "s1", [approved, rejected], "prod-analytics", flags),
    ).toBe(
      "# Gatekeeper Audit Trail\n\n- Connection: prod-analytics\n- Day: 2026-01-01\n- Session: gatekeeper (s1)\n- Harness: claude-code\n- Task: audit review\n- Queries: 2 (1 Approved · 1 Declined)\n\n## 9:29:30 AM · Declined · Remove a user\n- Request: q_cd34\n- Reason: read-only only\n\n```sql\nDELETE FROM audit.users WHERE id = 1\n```\n\n## 9:30:00 AM · Approved · List account contacts\n- Flags: PII, sensitive value\n- Latency: 5.0s\n- Request: q_ab12\n- Rows returned: 3\n\n```sql\nSELECT email FROM audit.users\n```\n",
    );
  });

  it("renders a session-day CSV export: BOM, session_id first, flattened SQL", () => {
    const flags = new Map([["q_ab12", ["PII"]]]);
    expect(activityCsv([approved, rejected], flags)).toBe(
      "﻿session_id,timestamp,status,latency_ms,intent,flags,request_id,rows_returned,rows_changed,reason,error,sql\r\n" +
        "s1,2026-01-01T09:29:30.000Z,declined,,remove a user,,q_cd34,,,read-only only,,DELETE FROM audit.users WHERE id = 1\r\n" +
        "s1,2026-01-01T09:30:00.000Z,approved,5000,list account contacts,PII,q_ab12,3,,,,SELECT email FROM audit.users\r\n",
    );
  });

  it("renders a session-day JSON export: oldest-first, native-typed rows", () => {
    const flags = new Map([["q_ab12", ["PII"]]]);
    expect(JSON.parse(activityJson([approved, rejected], flags))).toEqual([
      {
        session_id: "s1",
        timestamp: "2026-01-01T09:29:30.000Z",
        status: "declined",
        latency_ms: null,
        intent: "remove a user",
        flags: [],
        request_id: "q_cd34",
        rows_returned: null,
        rows_changed: null,
        reason: "read-only only",
        error: null,
        sql: "DELETE FROM audit.users WHERE id = 1",
      },
      {
        session_id: "s1",
        timestamp: "2026-01-01T09:30:00.000Z",
        status: "approved",
        latency_ms: 5000,
        intent: "list account contacts",
        flags: ["PII"],
        request_id: "q_ab12",
        rows_returned: 3,
        rows_changed: null,
        reason: null,
        error: null,
        sql: "SELECT email FROM audit.users",
      },
    ]);
  });

  it("uses a Markdown fence longer than any backtick run in the SQL", () => {
    const withBackticks: ActivityEntry = {
      ...approved,
      id: "q_bt",
      sql: "SELECT `a```b` FROM t",
    };
    const md = activityMarkdown("2026-01-01", "s1", [withBackticks], "prod", new Map());
    // Longest inner run is 3 backticks, so the opening fence must be at least 4.
    expect(md).toContain("````sql\nSELECT `a```b` FROM t\n````");
  });

  it("surfaces bidi controls as visible markers in the Markdown and JSON exports", () => {
    const rlo = String.fromCodePoint(0x202e);
    const trojan: ActivityEntry = {
      ...approved,
      id: "q_bidi",
      sql: `SELECT 1 -- ${rlo}evil`,
    };
    const md = activityMarkdown("2026-01-01", "s1", [trojan], "prod", new Map());
    expect(md).not.toContain(rlo);
    expect(md).toContain("[U+202E]");
    const json = JSON.parse(activityJson([trojan]));
    expect(json[0].sql).not.toContain(rlo);
    expect(json[0].sql).toContain("[U+202E]");
  });

  it("quotes and neutralises CSV fields that could break a spreadsheet", () => {
    const tricky: ActivityEntry = {
      ...approved,
      id: "q_ef56",
      intent: "=SUM(A1:A2)",
      sql: "SELECT a,\n  b FROM t WHERE c = 'x\"y'",
      rowCount: 1,
    };
    const csv = activityCsv([tricky]);
    // Formula-guarded intent, and the SQL flattened + RFC-4180 quoted (doubled quote).
    expect(csv).toContain(",'=SUM(A1:A2),");
    expect(csv).toContain('"SELECT a, b FROM t WHERE c = \'x""y\'"');
  });

  it("names what an approved write changed, and stays blank when no count is known", () => {
    const base = {
      id: "q_w1",
      createdAt: Date.UTC(2026, 0, 1, 9, 30),
      decidedAt: Date.UTC(2026, 0, 1, 9, 30, 2),
      sessionId: "sess_w",
      harness: null,
      project: null,
      sessionLabel: null,
      sql: "UPDATE audit.users SET tier = 'pro'",
      intent: "Promote the pilot accounts",
      state: "approved" as const,
      reason: null,
      error: null,
      rowCount: 0,
    };
    // A write reports what it changed; the returned zero must not stand in for it.
    const changed = activityEntryHtml({ ...base, affectedRows: 3 }, new Set(), "postgresql");
    expect(changed).toContain('<span class="act-metric">3 rows changed</span>');
    expect(changed).not.toContain("3 rows returned");

    // No count reported: the column stays empty rather than showing a zero.
    const unknown = activityEntryHtml({ ...base, rowCount: null }, new Set(), "postgresql");
    expect(unknown).toContain('<span class="act-metric"></span>');

    // A read keeps its returned count, no longer relabelled as affected.
    const read = activityEntryHtml(
      { ...base, sql: "SELECT id FROM audit.users", rowCount: 5 },
      new Set(),
      "postgresql",
    );
    expect(read).toContain('<span class="act-metric">5 rows returned</span>');
  });

  it("marks every row Auto mode touched, and colours the chip when it decided", () => {
    const base = {
      id: "q_a1",
      createdAt: Date.UTC(2026, 0, 1, 9, 30),
      decidedAt: Date.UTC(2026, 0, 1, 9, 30, 1),
      sessionId: "sess_a",
      harness: null,
      project: null,
      sessionLabel: null,
      sql: "SELECT sku FROM audit.products",
      intent: "Read the catalogue",
      state: "approved" as const,
      reason: null,
      error: null,
      rowCount: 3,
      affectedRows: null,
    };
    const evaluation = {
      provider: "typesafe" as const,
      model: "jev-1.13.0",
      policy: "auto-beta-4",
      evaluatedAt: 1,
      sqlDigest: "a".repeat(64),
      eligible: true,
      reasons: [],
      probabilities: { read_only: 0.98 },
    };
    const automatic = activityEntryHtml(
      { ...base, approval: { source: "automatic", evaluation } },
      new Set(),
      "postgresql",
    );
    expect(automatic).toContain('class="act-flag auto"');
    // Approved, but not by a human: the chip carries Auto mode's colour, not the green.
    expect(automatic).toContain('class="act-state approved auto"');

    // Evaluated, then approved by a human: the row reads as a human decision, and the
    // evaluation still shows in the panel below.
    const byHand = activityEntryHtml(
      { ...base, approval: { source: "human", evaluation } },
      new Set(["q_a1"]),
      "postgresql",
    );
    // Auto mode evaluated, so the row is marked, but a human decided and the chip stays
    // the ordinary green.
    expect(byHand).toContain('class="act-flag auto"');
    expect(byHand).toContain('class="act-state approved"');
    expect(byHand).toContain("Auto mode:");

    // Held locally, then declined by a human: same rule, no mark on the row.
    const held = activityEntryHtml(
      { ...base, state: "rejected", autoHold: { sent: false, reason: "Sensitive source" } },
      new Set(),
      "postgresql",
    );
    // Stopped before evaluation: still Auto mode's doing, so the row is marked, and the
    // decline keeps its own colour.
    expect(held).toContain('class="act-flag auto"');
    expect(held).toContain('class="act-state rejected"');
  });
});
