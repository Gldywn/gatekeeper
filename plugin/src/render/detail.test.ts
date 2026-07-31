// TZ is pinned before the module's Date rendering so the audit line's
// toLocaleString() is byte-stable on any machine (dev or CI).
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import type { HistResult } from "../result";
import type { HistItem } from "../types";
import { detailHtml, gridHtml } from "./detail";

// Byte-for-byte lock on the extracted detail builders: an approved read with a
// two-row result grid exercises the audit line, intent, outcome note and table.

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
  status: "ok",
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
  it("renders an approved item with its result grid", () => {
    expect(detailHtml(item)).toBe(
      '\n      <div class="detail-card">\n        <div class="detail-head">\n          <span class="harness-badge"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n  <title>Claude Code</title>\n  <path clip-rule="evenodd"\n        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"\n        fill="#D97757"\n        fill-rule="evenodd" />\n</svg></span>\n          <span class="detail-who">gatekeeper</span>\n          <span class="hstatus ok">approved</span>\n          <span class="detail-scope" title="Audit review">Audit review</span>\n          <button class="detail-close" type="button" data-close aria-label="Close detail">&times;</button>\n        </div>\n        <div class="detail-meta">on prod-analytics &middot; claude-code &middot; s1 &middot; q_ab12 &middot; 1/1/2026, 12:00:00 AM</div>\n        <p class="detail-intent">List account contacts</p>\n        <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="SELECT email, company_name FROM audit.users" aria-label="Copy SQL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button><code class="sql-body" id="detail-sqlbody"><span class="kw">SELECT</span>\n  email,\n  company_name\n<span class="kw">FROM</span> audit.users</code></pre>\n        <div class="card-schema" id="detail-cs"></div>\n        <div class="detail-outcome">2 rows</div>\n        <div class="grid-wrap"><table class="grid"><thead><tr><th>email</th><th>company_name</th></tr></thead><tbody><tr><td>jane@acme.io</td><td>Acme</td></tr><tr><td>john@globex.io</td><td>Globex</td></tr></tbody></table></div>\n      </div>',
    );
  });

  it("renders a result grid on its own", () => {
    expect(gridHtml(result)).toBe(
      '<div class="grid-wrap"><table class="grid"><thead><tr><th>email</th><th>company_name</th></tr></thead><tbody><tr><td>jane@acme.io</td><td>Acme</td></tr><tr><td>john@globex.io</td><td>Globex</td></tr></tbody></table></div>',
    );
  });
});
