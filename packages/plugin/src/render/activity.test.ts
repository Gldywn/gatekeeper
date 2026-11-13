// TZ is pinned before the module's Date rendering so clockTime()/toLocaleString()
// are byte-stable on any machine (dev or CI).
process.env.TZ = "UTC";

import { describe, expect, it, vi } from "vitest";
import { AUTO_POLICY } from "../sql/auto";
import { textSchema } from "../sql/output";
import type { ActivityEntry } from "../types";
import {
  activityCsv,
  activityDaysHtml,
  activityEntryHtml,
  activityFlagLabels,
  activityGroupHtml,
  activityJson,
  activityMarkdownDays,
  entryFlags,
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
  it("renders an approved entry as a selectable row: what came of it, flags and time", () => {
    const html = activityEntryHtml(approved, true, "postgresql");
    expect(html).toContain('data-row="q_ab12" data-select="audit" aria-current="true"');
    expect(html).toContain('<span class="hstate approved" title="Approved"');
    expect(html).toContain('<span class="ix-title">List account contacts</span>');
    expect(html).toContain('<span class="ix-fact">3 rows</span>');
    expect(html).toContain('<span class="act-flag pii">PII</span>');
    expect(html).toContain('<span class="act-time">09:30 AM</span>');
    // Under its session head the row drops who asked: the head names them once.
    expect(html).toContain('class="ix-row done grouped"');
    expect(html).not.toContain("ix-who");
    // The SQL opens on the right now, never inline under the row.
    expect(html).not.toContain("act-detail");
  });

  it("renders a declined entry as Declined, its reason left for the detail", () => {
    const html = activityEntryHtml(rejected, false, "postgresql");
    expect(html).toContain('aria-current="false"');
    expect(html).toContain('<span class="hstate rejected" title="Declined"');
    expect(html).toContain('<span class="ix-fact">Declined</span>');
    // It never ran, so no class mark: the detail says what it would have touched.
    expect(html).not.toContain("ix-risk");
    expect(html).not.toContain("read-only only");
  });

  it("shows no count or export in the session head", () => {
    const html = activityGroupHtml("2026-01-01", "s1", [approved], null, "postgresql");
    expect(html).not.toContain('class="act-sess-n"');
    expect(html).not.toContain("data-flyout-trigger");
  });

  it("renders the Markdown export as days, then sessions, then each decision, oldest first", () => {
    const flags = new Map([["q_ab12", ["PII", "sensitive value"]]]);
    const nextDay: ActivityEntry = {
      ...rejected,
      id: "q_ef56",
      createdAt: T + 86_400_000 - 400,
      decidedAt: T + 86_400_000,
      sessionId: "s2",
      harness: "codex",
      project: null,
      sessionLabel: null,
      sql: "SELECT * FROM orders",
      intent: null,
      state: "failed",
      reason: null,
      error: "statement timeout",
    };
    expect(activityMarkdownDays([nextDay, approved, rejected], "prod-analytics", flags)).toBe(
      "# Gatekeeper Audit Trail\n\n- Connection: prod-analytics\n- Days: 2026-01-01 to 2026-01-02 (2 days)\n- Queries: 3 (1 Failed · 1 Approved · 1 Declined)\n- Sessions: 2\n\n" +
        "## 2026-01-01\n\n### gatekeeper (s1)\n- Harness: claude-code\n- Task: audit review\n\n" +
        "#### 9:29:30 AM · Declined · Remove a user\n- Request: q_cd34\n- Reason: read-only only\n\n```sql\nDELETE FROM audit.users WHERE id = 1\n```\n\n" +
        "#### 9:30:00 AM · Approved · List account contacts\n- Flags: PII, sensitive value\n- Latency: 5.0s\n- Request: q_ab12\n- Rows returned: 3\n\n```sql\nSELECT email FROM audit.users\n```\n\n" +
        "## 2026-01-02\n\n### codex (s2)\n- Harness: codex\n\n" +
        "#### 9:30:00 AM · Failed\n- Latency: 400ms\n- Request: q_ef56\n- Error: statement timeout\n\n```sql\nSELECT * FROM orders\n```\n",
    );
    expect(activityMarkdownDays([approved], "", flags)).toContain("- Day: 2026-01-01\n");
  });

  it("renders a session-day CSV export: BOM, session_id first, flattened SQL", () => {
    const flags = new Map([["q_ab12", ["PII"]]]);
    expect(activityCsv([approved, rejected], flags)).toBe(
      "﻿session_id,timestamp,status,latency_ms,intent,flags,heavy,request_id,rows_returned,rows_changed,reason,error,sql\r\n" +
        "s1,2026-01-01T09:29:30.000Z,declined,,remove a user,,,q_cd34,,,read-only only,,DELETE FROM audit.users WHERE id = 1\r\n" +
        "s1,2026-01-01T09:30:00.000Z,approved,5000,list account contacts,PII,,q_ab12,3,,,,SELECT email FROM audit.users\r\n",
    );
  });

  it("carries the load check's flag into every export, and never writes it as false", () => {
    const heavy: ActivityEntry = { ...approved, heavy: true };
    expect(activityCsv([heavy, rejected]).split("\r\n").slice(1, 3)).toEqual([
      "s1,2026-01-01T09:29:30.000Z,declined,,remove a user,,,q_cd34,,,read-only only,,DELETE FROM audit.users WHERE id = 1",
      "s1,2026-01-01T09:30:00.000Z,approved,5000,list account contacts,,true,q_ab12,3,,,,SELECT email FROM audit.users",
    ]);
    const [older, newer] = JSON.parse(activityJson([heavy, rejected]));
    expect(newer.heavy).toBe(true);
    expect("heavy" in older).toBe(false);
    const md = activityMarkdownDays([heavy, rejected], "prod", new Map());
    expect(md).toContain("- Request: q_ab12\n- Load check: flagged heavy\n- Rows returned: 3\n");
    expect(md.match(/Load check/g)).toHaveLength(1);
  });

  it("marks a heavy query's row with the gauge only where it ran", () => {
    const ran = activityEntryHtml({ ...approved, heavy: true }, false, "postgresql");
    expect(ran).toContain('<span class="ix-risk heavy" title="Heavy query">');
    expect(ran).toContain('<span class="sr-only">Heavy query</span>');
    expect(activityEntryHtml(approved, false, "postgresql")).not.toContain("ix-risk heavy");
    expect(activityEntryHtml({ ...rejected, heavy: true }, false, "postgresql")).not.toContain(
      "ix-risk heavy",
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

  it("exports a statement the gate refused to run as not run, a person's decline as declined", () => {
    const gate: ActivityEntry = { ...rejected, id: "q_gate", declinedBy: "gate" };
    const human: ActivityEntry = { ...rejected, id: "q_human", declinedBy: "human" };
    expect(
      JSON.parse(activityJson([gate, human])).map((r: { status: string }) => r.status),
    ).toEqual(["declined", "not run"]);
    expect(activityCsv([gate])).toContain(",not run,");
    expect(activityMarkdownDays([gate], "prod", new Map())).toContain("· Not run ·");
    // The summary above the entries counts them the same way.
    expect(activityMarkdownDays([gate, human], "prod", new Map())).toContain(
      "- Queries: 2 (1 Not run · 1 Declined)",
    );
  });

  it("uses a Markdown fence longer than any backtick run in the SQL", () => {
    const withBackticks: ActivityEntry = {
      ...approved,
      id: "q_bt",
      sql: "SELECT `a```b` FROM t",
    };
    const md = activityMarkdownDays([withBackticks], "prod", new Map());
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
    const md = activityMarkdownDays([trojan], "prod", new Map());
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

  it("names what an approved write affected, and says Completed when no count is known", () => {
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
    // A write reports what it affected; the returned zero must not stand in for it.
    const affected = activityEntryHtml({ ...base, affectedRows: 3 }, false, "postgresql");
    expect(affected).toContain('<span class="ix-fact">3 affected</span>');
    expect(affected).not.toContain("0 rows");

    // A write with no affected count and an empty result set: a zero would read as an answer.
    const empty = activityEntryHtml(base, false, "postgresql");
    expect(empty).toContain('<span class="ix-fact">Completed</span>');

    // No count recorded at all: Completed, never a zero.
    const unknown = activityEntryHtml({ ...base, rowCount: null }, false, "postgresql");
    expect(unknown).toContain('<span class="ix-fact">Completed</span>');

    // A read keeps its returned count, zero included.
    const read = activityEntryHtml(
      { ...base, sql: "SELECT id FROM audit.users", rowCount: 5 },
      false,
      "postgresql",
    );
    expect(read).toContain('<span class="ix-fact">5 rows</span>');
    const none = activityEntryHtml(
      { ...base, sql: "SELECT id FROM audit.users", rowCount: 0 },
      false,
      "postgresql",
    );
    expect(none).toContain('<span class="ix-fact">0 rows</span>');
  });

  it("tells an unconfirmed or cancelled outcome from a failure or an expiry", () => {
    const unknown = activityEntryHtml(
      { ...approved, state: "failed", error: "execution_unknown", rowCount: null },
      false,
      "postgresql",
    );
    expect(unknown).toContain('<span class="ix-fact">Unconfirmed</span>');
    expect(unknown).toContain('title="Unconfirmed"');
    const failed = activityEntryHtml(
      { ...approved, state: "failed", error: "relation does not exist", rowCount: null },
      false,
      "postgresql",
    );
    expect(failed).toContain('<span class="ix-fact">Failed</span>');
    // In the trail these words can be an error the server recorded: only the reserved
    // execution_unknown leaves the outcome unconfirmed there.
    const undelivered = activityEntryHtml(
      { ...approved, state: "failed", error: "result not delivered", rowCount: null },
      false,
      "postgresql",
    );
    expect(undelivered).toContain('<span class="ix-fact">Failed</span>');
    const cancelled = activityEntryHtml(
      { ...approved, state: "cancelled", rowCount: null },
      false,
      "postgresql",
    );
    expect(cancelled).toContain('<span class="ix-fact">Cancelled</span>');
    expect(cancelled).toContain('title="Cancelled"');
    expect(cancelled).not.toContain("Expired");
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
    // Approved by Auto mode: the row's glyph is the bolt, not the green check.
    const automatic = activityEntryHtml(
      { ...base, approval: { source: "automatic", evaluation } },
      false,
      "postgresql",
    );
    expect(automatic).toContain('<span class="hstate auto" title="Approved automatically"');
    expect(automatic).not.toContain('class="act-flag auto"');

    // Evaluated, then approved by a human: the check stays green and a quiet bolt says Auto
    // mode was involved; the evaluation itself opens with the detail.
    const byHand = activityEntryHtml(
      { ...base, approval: { source: "human", evaluation } },
      true,
      "postgresql",
    );
    expect(byHand).toContain('<span class="hstate approved"');
    expect(byHand).toContain(
      'class="act-flag auto" title="Evaluated by Auto mode, decided by you"',
    );

    // Stopped before evaluation, then declined by a human: marked, and the decline keeps its
    // own glyph.
    const held = activityEntryHtml(
      { ...base, state: "rejected", autoHold: { sent: false, reason: "Sensitive source" } },
      false,
      "postgresql",
    );
    expect(held).toContain('class="act-flag auto"');
    expect(held).toContain('<span class="hstate rejected"');

    // An answer this plugin refused: the row says the evaluation did not finish, as the detail
    // does, rather than "Evaluated by Auto mode".
    const invalid = activityEntryHtml(
      {
        ...base,
        state: "rejected",
        evaluation,
        autoHold: {
          sent: true,
          reason: "Invalid evaluator response",
          failure: { stage: "response" },
        },
      },
      false,
      "postgresql",
    );
    expect(invalid).toContain('title="Auto mode did not finish evaluating this read"');

    // An automatic approval a withdrawn attempt left behind does not hide the final failure.
    const stale = activityEntryHtml(
      {
        ...base,
        state: "rejected",
        approval: { source: "automatic", evaluation },
        autoHold: {
          sent: true,
          reason: "Evaluator or metadata unavailable",
          failure: { stage: "network" },
        },
      },
      false,
      "postgresql",
    );
    expect(stale).toContain('title="Auto mode did not finish evaluating this read"');
    expect(stale).not.toContain('title="Approved automatically"');
  });

  it("exports a refused read's evaluation and why, as the detail says it", () => {
    const refused = {
      id: "r9",
      createdAt: Date.UTC(2026, 0, 1, 10),
      decidedAt: Date.UTC(2026, 0, 1, 10, 1),
      sessionId: "s1",
      harness: null,
      project: null,
      sessionLabel: null,
      sql: "SELECT email FROM customers",
      intent: "Customer emails",
      state: "rejected" as const,
      reason: null,
      error: null,
      rowCount: null,
      affectedRows: null,
      evaluation: {
        provider: "typesafe" as const,
        model: "jev-1.13.0",
        policy: AUTO_POLICY,
        evaluatedAt: 1,
        sqlDigest: "a".repeat(64),
        eligible: false,
        reasons: ["Potential personal disclosure"],
        probabilities: {
          personal_disclosure: 0.91,
          organization_disclosure: 0.06,
          secret_disclosure: 0.01,
          insufficient_context: 0.3,
        },
      },
    };
    const md = activityMarkdownDays([refused], "prod", new Map());
    expect(md).toContain('- Evaluation: {"provider":"typesafe","model":"jev-1.13.0"');
    expect(md).toContain(
      "- Auto mode: jev-1.13.0 did not clear this read: it may reveal personal data.",
    );
    const failed = activityMarkdownDays(
      [
        {
          ...refused,
          evaluation: undefined,
          autoHold: {
            sent: true,
            reason: "Evaluator or metadata unavailable",
            failure: { stage: "http" as const, status: 503 },
            model: "kev-latest",
          },
        },
      ],
      "prod",
      new Map(),
    );
    expect(failed).toContain("- Auto mode: kev-latest answered with an error (HTTP 503).");
    expect(failed).not.toContain("evaluation unfinished");
  });
});

describe("audit flags without the database", () => {
  const star = { ...approved, id: "q_star", sql: "SELECT * FROM audit.users" };

  it("prefers the flags recorded with the decision, which a SELECT * text cannot show", () => {
    const recorded = { pii: true, value: false, client: false };
    expect(entryFlags({ ...star, sensitivity: recorded }, textSchema(star.sql, "postgresql"))).toBe(
      recorded,
    );
    expect(activityEntryHtml({ ...star, sensitivity: recorded }, false, "postgresql")).toContain(
      '<span class="act-flag pii">PII</span>',
    );
  });

  it("keeps the Value mark a decision recorded before literals stopped being flagged", () => {
    const legacy = { pii: true, value: true, client: false };
    const entry = { ...approved, sensitivity: legacy };
    expect(entryFlags(entry, textSchema(entry.sql, "postgresql"))).toBe(legacy);
    expect(activityEntryHtml(entry, false, "postgresql")).toContain(
      '<span class="act-flag val">Value</span>',
    );
    expect(activityFlagLabels(legacy)).toEqual(["PII", "sensitive value"]);
  });

  it("reads unrecorded entries from the SQL text alone", () => {
    expect(entryFlags(approved, textSchema(approved.sql, "postgresql"))).toEqual({
      pii: true,
      value: false,
      client: false,
    });
    expect(activityEntryHtml(star, false, "postgresql")).toContain(
      '<span class="act-flags"></span>',
    );
  });

  it.each([{ pii: "yes" }, { pii: false, value: false }, null])(
    "falls back to the SQL text when a broker sends a record it cannot read: %j",
    (odd) => {
      const entry = { ...approved, sensitivity: odd as never };
      expect(entryFlags(entry, textSchema(entry.sql, "postgresql"))).toMatchObject({ pii: true });
    },
  );

  it("heads each day with its date tile, Today by name and its totals", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    try {
      const html = activityDaysHtml([approved, rejected], null, "postgresql");
      expect(html).toContain('<span class="act-day-tile">1</span>');
      expect(html).toContain('Today<span class="act-day-sub">Thu, Jan</span>');
      expect(html).toContain('<span class="act-day-count">2 queries, 1 session</span>');
      // Today is in the current month: no month head above it.
      expect(html).not.toContain("act-month");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ships folded days without their rows", () => {
    const older = { ...rejected, id: "q_old", decidedAt: T - 3 * 86_400_000 };
    const html = activityDaysHtml([approved, older], null, "postgresql");
    expect(html).toContain('data-row="q_ab12"');
    expect(html).not.toContain('data-row="q_old"');
    expect(html).toContain('<div class="act-day-body"></div>');
  });
});
