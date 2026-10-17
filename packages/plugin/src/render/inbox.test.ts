import { describe, expect, it } from "vitest";
import type { ActivityEntry, Card, HistItem } from "../types";
import { auditItem, queueRowHtml, recentRowHtml } from "./inbox";
import { AUTO_EVALUATING } from "./queue";

const T = new Date("2026-01-01T00:00:00Z").getTime();

const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
  id: "q_ab12",
  createdAt: T - 5000,
  decidedAt: T,
  sessionId: "s1",
  harness: "claude-code",
  project: "gatekeeper",
  sessionLabel: "audit review",
  sql: "SELECT 1",
  intent: "count users",
  state: "approved",
  reason: null,
  error: null,
  rowCount: null,
  affectedRows: null,
  ...over,
});

const card = (over: Partial<Card>): Card => ({
  id: "q_cd34",
  sql: "SELECT 1",
  intent: "count users",
  createdAt: T - 12_000,
  expiresAt: T + 90_000,
  leaseId: "lease-1",
  leaseExpiresAt: T + 90_000,
  sessionId: "s1",
  session: {
    sessionId: "s1",
    harness: "claude-code",
    harnessVersion: null,
    project: "gatekeeper",
    sessionLabel: "audit review",
  },
  state: "ready",
  ...over,
});

describe("auditItem", () => {
  it("keeps the counts of an approved read but holds no rows", () => {
    const item = auditItem(entry({ rowCount: 12 }), "app_db");
    expect(item.status).toBe("approved");
    expect(item.note).toBe("12 rows returned");
    expect(item.connection).toBe("app_db");
    expect(item.result).toEqual({ fields: [], rows: [], rowCount: 12, truncated: false });
  });

  it("keeps a zero count, so the detail says no rows came back", () => {
    expect(auditItem(entry({ rowCount: 0 }), null).result?.rowCount).toBe(0);
  });

  it("leads with what a write changed, even without a returned count", () => {
    const item = auditItem(entry({ affectedRows: 2 }), null);
    expect(item.note).toBe("2 rows changed");
    expect(item.result).toMatchObject({ rowCount: null, affectedRows: 2, rows: [] });
  });

  it("claims no result when the server recorded no count", () => {
    const item = auditItem(entry({}), null);
    expect(item.note).toBe("");
    expect(item.result).toBeUndefined();
  });

  it("carries the reason, the error, or the cancellation as the row's fact", () => {
    expect(auditItem(entry({ state: "rejected", reason: " too wide " }), null)).toMatchObject({
      status: "rejected",
      note: "too wide",
    });
    expect(auditItem(entry({ state: "rejected" }), null).note).toBe("declined");
    expect(auditItem(entry({ state: "failed", error: "syntax error" }), null)).toMatchObject({
      status: "failed",
      note: "syntax error",
    });
    expect(auditItem(entry({ state: "cancelled" }), null)).toMatchObject({
      status: "expired",
      note: "cancelled by the agent",
      result: undefined,
    });
  });

  it("dates an undecided entry by its creation", () => {
    expect(auditItem(entry({ state: "expired", decidedAt: null }), null).resolvedAt).toBe(T - 5000);
  });
});

describe("queueRowHtml", () => {
  it("shows a ready proposal's lease, amber once it runs low", () => {
    expect(queueRowHtml(card({}), "read", false, T)).toContain(
      '<span class="ix-side" data-lease>1:30</span>',
    );
    expect(queueRowHtml(card({ expiresAt: T + 30_000 }), "read", false, T)).toContain(
      '<span class="ix-side low" data-lease>0:30</span>',
    );
  });

  it("marks a held proposal with the dot, and with the bolt while Jev evaluates it", () => {
    expect(queueRowHtml(card({}), "read", false, T)).toContain('class="ix-dot"');
    expect(queueRowHtml(card({ autoStatus: AUTO_EVALUATING }), "read", false, T)).toContain(
      'class="ix-bolt"',
    );
  });

  it("shows a running query's clock and a busy card's state", () => {
    const running = queueRowHtml(
      card({ state: "executing", run: { startedAt: T - 7000, limitMs: 0, ended: false } }),
      "read",
      true,
      T,
    );
    expect(running).toContain('<span class="ix-side run" data-run="q_cd34">0:07</span>');
    expect(running).toContain('class="spin"');
    expect(running).toContain('aria-current="true"');
    expect(queueRowHtml(card({ state: "posting" }), "read", false, T)).toContain(
      '<span class="ix-side busy">Returning rows</span>',
    );
  });

  it("names a write and falls back to the id without an intent", () => {
    const html = queueRowHtml(card({ intent: undefined }), "write", false, T);
    expect(html).toContain('<span class="ix-risk write">write</span>');
    expect(html).toContain('<span class="ix-title">q_cd34</span>');
  });
});

describe("recentRowHtml", () => {
  const item: HistItem = {
    id: "q_ef56",
    status: "rejected",
    note: "",
    sql: "DELETE FROM users WHERE id = 1",
    resolvedAt: T,
    connection: "app_db",
  };

  it("opens the local history, titled by the SQL when there is no intent", () => {
    const html = recentRowHtml(item, false);
    expect(html).toContain('data-row="q_ef56" data-select="hist" aria-current="false"');
    expect(html).toContain('<span class="ix-title">DELETE FROM users WHERE id = 1</span>');
    expect(html).toContain(`data-age="${T}"`);
    expect(html).not.toContain("ix-note");
  });

  it("marks an automatic approval with the Auto glyph instead of the check", () => {
    const html = recentRowHtml(
      { ...item, status: "approved", approval: { source: "automatic" } },
      false,
    );
    expect(html).toContain('title="Approved automatically"');
  });
});
