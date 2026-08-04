// TZ is pinned before the module's Date rendering so clockTime()/toLocaleString()
// are byte-stable on any machine (dev or CI).
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../types";
import { activityEntryHtml, activityMarkdown } from "./activity";

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
    expect(activityEntryHtml(approved, new Set(["q_ab12"]))).toBe(
      '\n          <div class="act-entry open" data-act="q_ab12">\n            <button class="act-row" type="button" data-act-sql="q_ab12" aria-expanded="true">\n              <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>\n              <span class="act-time">09:30 AM</span>\n              <span class="act-state approved">Approved</span>\n              <span class="act-intent">List account contacts</span>\n              <span class="act-flags" data-act-flags="q_ab12"></span>\n              <span class="act-lat">5.0s</span>\n            </button>\n            <div class="act-detail">\n              <div class="act-meta">q_ab12 &middot; 1/1/2026, 9:30:00 AM &middot; 3 rows</div>\n              \n              <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="SELECT email FROM audit.users" aria-label="Copy SQL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button><code><span class="kw">SELECT</span>\n  email\n<span class="kw">FROM</span> audit.users</code></pre>\n            </div>\n          </div>',
    );
  });

  it("renders a collapsed rejected entry", () => {
    expect(activityEntryHtml(rejected, new Set())).toBe(
      '\n          <div class="act-entry" data-act="q_cd34">\n            <button class="act-row" type="button" data-act-sql="q_cd34" aria-expanded="false">\n              <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>\n              <span class="act-time">09:29 AM</span>\n              <span class="act-state rejected">Rejected</span>\n              <span class="act-intent">Remove a user</span>\n              <span class="act-flags" data-act-flags="q_cd34"></span>\n              <span class="act-lat">—</span>\n            </button>\n            <div class="act-detail" hidden>\n              <div class="act-meta">q_cd34 &middot; 1/1/2026, 9:29:30 AM</div>\n              <div class="act-enote rejected">read-only only</div>\n              <pre class="sql"><button class="copy-sql" type="button" data-copy-sql="DELETE FROM audit.users WHERE id = 1" aria-label="Copy SQL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button><code><span class="kw">DELETE</span>\n<span class="kw">FROM</span> audit.users\n<span class="kw">WHERE</span> id = 1</code></pre>\n            </div>\n          </div>',
    );
  });

  it("renders a session-day markdown export", () => {
    expect(activityMarkdown("2026-01-01", "s1", [approved, rejected], "prod-analytics")).toBe(
      "# Gatekeeper activity\n\n- Connection: prod-analytics\n- Day: 2026-01-01\n- Session: gatekeeper (s1)\n- Harness: claude-code\n- Task: audit review\n\n## 9:29:30 AM · rejected\n- Intent: remove a user\n- Request: q_cd34\n- Reason: read-only only\n\n```sql\nDELETE FROM audit.users WHERE id = 1\n```\n\n## 9:30:00 AM · approved\n- Intent: list account contacts\n- Request: q_ab12\n- Rows: 3\n\n```sql\nSELECT email FROM audit.users\n```\n",
    );
  });
});
