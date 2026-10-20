// TZ is pinned before the module's Date rendering so the status line's toLocaleString() is
// byte-stable on any machine (dev or CI).
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import type { HistResult } from "../result";
import type { HistItem } from "../types";
import { CANCELLED_NOTE, detailHtml } from "./detail";

const result: HistResult = {
  fields: [{ name: "email" }, { name: "company_name" }],
  rows: [
    { email: "jane@acme.io", company_name: "Acme" },
    { email: "john@globex.io", company_name: "Globex" },
  ],
  rowCount: 2,
  truncated: false,
};

const item: HistItem = {
  id: "q_ab12",
  status: "approved",
  note: "2 rows returned",
  sql: "SELECT email, company_name FROM audit.users",
  resolvedAt: new Date("2026-01-01T09:30:00Z").getTime(),
  connection: "prod-analytics",
  session: {
    sessionId: "s1",
    harness: "claude-code",
    harnessVersion: null,
    project: "gatekeeper",
    sessionLabel: "audit review",
  },
  intent: "list account contacts",
  approval: { source: "human" },
  result,
};

const pg = "postgresql";
const fact = (html: string) => html.match(/<p class="dt-fact">(.*?)<\/p>/)?.[1] ?? null;
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("render/detail", () => {
  it("leads with the outcome and who decided, then the receipt, the rows and the request", () => {
    const html = detailHtml(item, "hist", pg);
    expect(html).toContain('<div class="dt-status ok"><span class="dt-st">');
    expect(html).toContain("Completed</span>");
    expect(html).toContain(
      '<div class="dt-sub">Approved by you &middot; Resolved Jan 1, 09:30 AM</div>',
    );
    expect(text(fact(html) ?? "")).toBe("SELECT on audit.users completed, returning 2 rows.");
    // The held rows: Copy and Export left, the pager and its position right, no footer.
    expect(html).toContain(
      '<div class="res" id="detail-grid"><div class="res-bar"><span class="res-tools">',
    );
    expect(html).toContain(
      '<span class="res-count" data-grid-count></span><span class="res-pager" data-grid-pager></span>',
    );
    expect(html).toContain(
      'data-flyout-action="copy" data-flyout-key="result" data-flyout-fmt="md"',
    );
    expect(html).not.toContain("grid-foot");
    // Then what was asked, under its line, as the pending card showed it.
    expect(html.indexOf('class="sep-label"')).toBeGreaterThan(html.indexOf("detail-grid"));
    expect(html).toContain(
      '<span class="pd-name">gatekeeper</span><span class="pd-task" title="Audit review">Audit review</span>',
    );
    expect(html).toContain('<span class="intent">List account contacts</span>');
    expect(html).toContain('<div class="meta">q_ab12 &middot; s1 &middot; on prod-analytics</div>');
    expect(html).toContain('<th scope="row" class="nm">audit.users</th><td class="mk on read">');
    expect(html).toContain('<code class="sql-body" id="detail-sqlbody">');
  });

  it("writes the cap the agent's result hit, from the local note", () => {
    const html = detailHtml(
      { ...item, note: "12,400 rows returned (agent received 10000)" },
      "hist",
      pg,
    );
    expect(html).toContain(
      "Only the first 10,000 rows were sent to the agent to avoid context pollution.",
    );
  });

  it("says 0 rows for an empty read, and no grid", () => {
    const html = detailHtml({ ...item, result: { ...result, rows: [], rowCount: 0 } }, "hist", pg);
    expect(text(fact(html) ?? "")).toBe("SELECT on audit.users completed, returning 0 rows.");
    expect(html).not.toContain("detail-grid");
  });

  it("keeps the count of rows no longer held, without a line about where they went", () => {
    const html = detailHtml(
      { ...item, result: { ...result, rows: [], rowCount: 42 } },
      "audit",
      pg,
    );
    expect(text(fact(html) ?? "")).toBe("SELECT on audit.users completed, returning 42 rows.");
    expect(html).toContain("Recorded Jan 1, 09:30 AM");
    expect(html).not.toContain("no longer held");
    expect(html).not.toContain("detail-grid");
  });

  it("puts an execution error in the Message box, and a stop request on its own line", () => {
    const failed = detailHtml(
      { ...item, status: "failed", note: 'relation "customer" does not exist', result: undefined },
      "hist",
      pg,
    );
    expect(failed).toContain('<div class="dt-status fail">');
    expect(failed).toContain(">Failed</span>");
    expect(failed).toContain(
      '<div class="dt-msg err"><span class="q">Message</span>relation &quot;customer&quot; does not exist</div>',
    );
    const stopped = detailHtml(
      {
        ...item,
        status: "failed",
        note: "Stop requested by the operator after 42s. The query then ended with: canceling statement due to user request",
        result: undefined,
      },
      "hist",
      pg,
    );
    expect(stopped).toContain('<div class="dt-sub">Stop requested by you after 42s.</div>');
    expect(stopped).toContain(
      '<span class="q">Message</span>canceling statement due to user request</div>',
    );
    // Still Failed: a stop request is not proof the stop took effect.
    expect(stopped).toContain(">Failed</span>");
  });

  it("names a local decline's author and its reason; an Audit Trail decline names neither author", () => {
    const local = detailHtml(
      { ...item, status: "rejected", note: "use a bind param", result: undefined },
      "hist",
      pg,
    );
    expect(local).toContain(">Declined</span>");
    expect(local).toContain('<div class="dt-sub">Declined by you &middot; Resolved');
    expect(local).toContain('<span class="q">Message</span>use a bind param</div>');
    const plain = detailHtml(
      { ...item, status: "rejected", note: "declined", result: undefined },
      "hist",
      pg,
    );
    expect(plain).not.toContain("dt-msg");
    const audit = detailHtml(
      { ...item, status: "rejected", note: "use a bind param", result: undefined },
      "audit",
      pg,
    );
    expect(audit).toContain('<div class="dt-sub">Recorded Jan 1, 09:30 AM</div>');
  });

  it("tells an agent cancellation apart from an expiry, and both ran nothing", () => {
    const cancelled = detailHtml(
      { ...item, status: "expired", note: CANCELLED_NOTE, result: undefined },
      "hist",
      pg,
    );
    expect(cancelled).toContain(">Cancelled</span>");
    expect(cancelled).toContain("The agent withdrew the proposal before execution.");
    const expired = detailHtml(
      { ...item, status: "expired", note: "expired", result: undefined },
      "hist",
      pg,
    );
    expect(expired).toContain(">Expired</span>");
    expect(expired).toContain("The proposal expired before execution.");
    expect(expired).not.toContain("dt-fact");
  });

  it("tells unconfirmed and not-run outcomes apart from a failure", () => {
    const undelivered = detailHtml(
      { ...item, status: "failed", note: "result not delivered", result: undefined },
      "hist",
      pg,
    );
    expect(undelivered).toContain(">Result delivery unconfirmed</span>");
    const unknown = detailHtml(
      { ...item, status: "failed", note: "execution_unknown", result: undefined },
      "audit",
      pg,
    );
    expect(unknown).toContain(">Execution outcome unknown</span>");
    const blocked = detailHtml(
      { ...item, status: "failed", note: "blocked", result: undefined },
      "hist",
      pg,
    );
    expect(blocked).toContain(">Not run</span>");
    expect(blocked).toContain("Execution was blocked.");
    // In the trail the same words may be a recorded error: they stay a failure.
    const auditUndelivered = detailHtml(
      { ...item, status: "failed", note: "result not delivered", result: undefined },
      "audit",
      pg,
    );
    expect(auditUndelivered).toContain(">Failed</span>");
  });

  it("copies the SQL with its invisible characters spelled out", () => {
    const html = detailHtml({ ...item, sql: "SELECT 1 -- ‮evil" }, "hist", pg);
    expect(html).toContain('data-copy-sql="SELECT 1 -- [U+202E]evil"');
  });

  it("names a write's affected rows, never its empty result set, and both for RETURNING", () => {
    const write = {
      ...item,
      sql: "UPDATE invoices SET status = 'void' WHERE id = 1",
      result: { fields: [], rows: [], rowCount: 0, affectedRows: 2, truncated: false },
    };
    expect(text(fact(detailHtml(write, "hist", pg)) ?? "")).toBe(
      "UPDATE on invoices completed, affecting 2 rows.",
    );
    const returning = {
      ...write,
      sql: "UPDATE invoices SET status = 'void' WHERE id = 1 RETURNING id",
      result: {
        fields: [{ name: "id" }],
        rows: [{ id: 1 }, { id: 2 }],
        rowCount: 2,
        affectedRows: 2,
        truncated: false,
      },
    };
    expect(text(fact(detailHtml(returning, "hist", pg)) ?? "")).toBe(
      "UPDATE on invoices completed, affecting 2 rows and returning 2 rows.",
    );
    // A DROP reports a conventional zero that measures nothing.
    const drop = {
      ...write,
      sql: "DROP TABLE tmp_imports",
      result: { ...write.result, affectedRows: 0 },
    };
    expect(text(fact(detailHtml(drop, "hist", pg)) ?? "")).toBe("DROP on tmp_imports completed.");
    // So does DDL the receipt cannot name, and a zero-row DELETE keeps its real zero.
    const create = { ...drop, sql: "CREATE TABLE example (id int)" };
    expect(text(fact(detailHtml(create, "hist", pg)) ?? "")).toBe("Query completed.");
    const none = { ...drop, sql: "DELETE FROM sessions WHERE id = 0" };
    expect(text(fact(detailHtml(none, "hist", pg)) ?? "")).toBe(
      "DELETE on sessions completed, affecting 0 rows.",
    );
  });

  it("stays generic when the parse cannot vouch for the operation, and never invents a zero", () => {
    const cte = {
      ...item,
      sql: "WITH r AS (SELECT id FROM invoices) UPDATE invoices SET x = 1 WHERE id IN (SELECT id FROM r)",
      result: { fields: [], rows: [], rowCount: 0, affectedRows: 3, truncated: false },
    };
    expect(text(fact(detailHtml(cte, "hist", pg)) ?? "")).toBe(
      "Query completed, affecting 3 rows.",
    );
    const unknown = detailHtml({ ...item, result: undefined }, "audit", pg);
    expect(text(fact(unknown) ?? "")).toBe("SELECT on audit.users completed.");
    expect(unknown).toContain("Approved by you");
    const noSource = detailHtml({ ...item, approval: undefined }, "audit", pg);
    expect(noSource).toContain("Approver not recorded");
  });
});
