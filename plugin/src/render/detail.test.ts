// TZ is pinned before the module's Date rendering so the audit line's
// toLocaleString() is byte-stable on any machine (dev or CI).
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import type { HistResult } from "../result";
import type { HistItem } from "../types";
import { detailHtml, gridHtml } from "./detail";

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
  it("renders an approved item: identity (who, label) then status, meta, formatted SQL, grid", () => {
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
    expect(html).toContain('<div class="detail-outcome">2 rows</div>');
  });

  it("renders a result grid on its own", () => {
    expect(gridHtml(result)).toBe(
      '<div class="grid-wrap"><table class="grid"><thead><tr><th>email</th><th>company_name</th></tr></thead><tbody><tr><td>jane@acme.io</td><td>Acme</td></tr><tr><td>john@globex.io</td><td>Globex</td></tr></tbody></table></div>',
    );
  });
});
