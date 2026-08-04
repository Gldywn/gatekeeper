// TZ is pinned before the module's Date rendering so the audit line's
// toLocaleString() is byte-stable on any machine (dev or CI).
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import type { HistResult } from "../result";
import type { HistItem } from "../types";
import { detailHtml } from "./detail";

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
  note: "2 rows",
  sql: "SELECT email, company_name FROM audit.users",
  resolvedAt: new Date("2026-01-01T00:00:00Z").getTime(),
  connection: "prod-analytics",
  session: {
    sessionId: "s1",
    harness: "claude-code",
    harnessVersion: null,
    project: "gatekeeper",
    sessionLabel: "audit review",
  },
  intent: "list account contacts",
  result,
};

describe("render/detail", () => {
  it("renders an approved item: identity (who, label) then status, meta, formatted SQL, well + grid", () => {
    const html = detailHtml(item);
    // head identity order matches the history row: who, then the scope label, then status
    expect(html).toContain(
      '<span class="detail-who">gatekeeper</span>\n          <span class="detail-scope" title="Audit review">Audit review</span>\n          <span class="hstatus approved">approved</span>',
    );
    expect(html).toContain(
      '<div class="detail-meta">on prod-analytics &middot; claude-code &middot; s1 &middot; q_ab12 &middot; 1/1/2026, 12:00:00 AM</div>',
    );
    expect(html).toContain('<p class="detail-intent">List account contacts</p>');
    // SQL pretty-printed: one column per line.
    expect(html).toContain(
      '<span class="kw">SELECT</span>\n  email,\n  company_name\n<span class="kw">FROM</span> audit.users',
    );
    // The outcome lives in the tinted recessed well: header (icon + word + meta), then the
    // grid host Tabulator mounts into (render/grid.ts), and the plain row-count footer.
    expect(html).toContain(
      '<div class="detail-rail approved"><div class="detail-oc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span class="detail-oc-title">Approved</span><span class="detail-oc-meta">2 rows</span></div><div class="detail-oc-body" id="detail-grid"><div class="gk-grid" data-result-grid></div><div class="grid-foot"><span class="rc"><b>2</b> rows</span></div></div>',
    );
  });

  it("footer states the true total and the held cap when the result was truncated", () => {
    const big: HistResult = {
      fields: [{ name: "id" }, { name: "email" }],
      rows: Array.from({ length: 120 }, (_, i) => ({ id: i + 1, email: `u${i}@x.io` })),
      rowCount: 1240,
      truncated: true,
    };
    const html = detailHtml({ ...item, note: "1,240 rows", result: big });
    expect(html).toContain(
      '<span class="rc"><b>1,240</b> rows <span class="cap-tag">first 120 held</span></span>',
    );
    // The grid host is present but empty; Tabulator fills it at mount time in the DOM.
    expect(html).toContain('<div class="gk-grid" data-result-grid></div>');
  });

  it("shows the empty-result message for an approved query with zero rows", () => {
    const html = detailHtml({
      ...item,
      note: "0 rows",
      result: { fields: [], rows: [], rowCount: 0, truncated: false },
    });
    expect(html).toContain('<div class="detail-rail approved">');
    expect(html).toContain('<span class="detail-oc-meta">0 rows</span>');
    expect(html).toContain(
      '<div class="detail-oc-body"><div class="detail-oc-msg">The query ran and returned no rows.</div></div>',
    );
  });

  it("notes when approved rows were held then purged from memory", () => {
    const html = detailHtml({
      ...item,
      note: "42 rows",
      result: { fields: [{ name: "id" }], rows: [], rowCount: 42, truncated: true },
    });
    expect(html).toContain('<span class="detail-oc-meta">42 rows</span>');
    expect(html).toContain(
      '<div class="detail-oc-msg">42 rows returned, no longer held in memory.</div>',
    );
  });

  it("renders a failed outcome with the error in a mono note block", () => {
    const html = detailHtml({
      ...item,
      status: "failed",
      note: 'relation "customer" does not exist',
      result: undefined,
    });
    expect(html).toContain('<div class="detail-rail failed">');
    expect(html).toContain('<span class="detail-oc-title">Failed</span>');
    expect(html).toContain('<span class="detail-oc-meta">at execution</span>');
    expect(html).toContain(
      '<div class="detail-oc-note">relation &quot;customer&quot; does not exist</div>',
    );
  });

  it("renders a decline outcome as a plain statement, no reason note", () => {
    const declined = detailHtml({
      ...item,
      status: "rejected",
      note: "Please scope this to a single company.",
      result: undefined,
    });
    expect(declined).toContain('<div class="detail-rail rejected">');
    expect(declined).toContain('<span class="detail-oc-title">Declined</span>');
    expect(declined).toContain(
      '<div class="detail-oc-msg">You declined this proposal. Nothing ran against the database.</div>',
    );
    // A decline carries no reason, so the boxed note is gone whatever the stored note.
    expect(declined).not.toContain("detail-oc-note");
  });

  it("renders an expired outcome that ran nothing against the database", () => {
    const html = detailHtml({
      ...item,
      status: "expired",
      note: "expired",
      result: undefined,
    });
    expect(html).toContain('<div class="detail-rail expired">');
    expect(html).toContain('<span class="detail-oc-title">Expired</span>');
    expect(html).toContain(
      '<div class="detail-oc-msg">The proposal timed out before a decision. Nothing ran against the database.</div>',
    );
  });
});
