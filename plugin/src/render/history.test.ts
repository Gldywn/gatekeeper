import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HistItem } from "../types";
import { historyRow } from "./history";

// Byte-for-byte lock on the extracted history builder: an approved row with an
// intent, and a rejected row without one so the previewSql fallback and the
// data-no-intent path (plus the placeholder harness icon) are covered.

const T = new Date("2026-01-01T00:00:00Z").getTime();

const approved: HistItem = {
  id: "q_ab12",
  status: "ok",
  note: "3 rows",
  sql: "SELECT email FROM audit.users WHERE email = 'jane@acme.io'",
  resolvedAt: T - 5_000,
  connection: "prod",
  session: {
    sessionId: "s1",
    harness: "claude-code",
    harnessVersion: null,
    project: "gatekeeper",
    sessionLabel: "audit review",
  },
  intent: "check a user's email",
};

const rejected: HistItem = {
  id: "q_cd34",
  status: "no",
  note: "not read-only",
  sql: "DELETE FROM audit.users WHERE id = 7",
  resolvedAt: T - 5_000,
  connection: "prod",
  session: null,
};

// relAge() reads Date.now(); freeze it so the resolved-age render is stable.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterAll(() => {
  vi.useRealTimers();
});

describe("render/history", () => {
  it("renders an approved row with an intent and highlighted SQL", () => {
    expect(historyRow(approved)).toBe(
      '\n        <button class="hrow" type="button" data-hist="q_ab12" title="q_ab12">\n          <span class="harness-badge"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n  <title>Claude Code</title>\n  <path clip-rule="evenodd"\n        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"\n        fill="#D97757"\n        fill-rule="evenodd" />\n</svg></span>\n          <span class="hwho" title="gatekeeper">gatekeeper</span>\n          <span class="hstatus ok">approved</span>\n          <span class="hintent">Check a user\'s email</span>\n          <span class="hsql"><span class="kw">SELECT</span> email <span class="kw">FROM</span> audit.users <span class="kw">WHERE</span> email = <span class="st">\'jane@acme.io\'</span></span>\n          <span class="htime">\n            <span class="hnote">3 rows</span>\n            <span aria-hidden="true">&middot;</span>\n            <span class="hage" data-age="1767225595000">5s ago</span>\n          </span>\n        </button>',
    );
  });

  it("falls back to previewSql and marks data-no-intent for a rejected row", () => {
    expect(historyRow(rejected)).toBe(
      '\n        <button class="hrow" type="button" data-hist="q_cd34" data-no-intent title="q_cd34">\n          <span class="harness-badge"><svg viewBox="0 0 20 22" aria-hidden="true"><polygon points="10,1.2 18.7,6.1 18.7,15.9 10,20.8 1.3,15.9 1.3,6.1" opacity="0.55"/></svg></span>\n          <span class="hwho" title="q_cd34">q_cd34</span>\n          <span class="hstatus no">rejected</span>\n          <span class="hintent">DELETE FROM audit.users WHERE id = 7</span>\n          <span class="hsql"><span class="kw">DELETE</span> <span class="kw">FROM</span> audit.users <span class="kw">WHERE</span> id = 7</span>\n          <span class="htime">\n            <span class="hnote">not read-only</span>\n            <span aria-hidden="true">&middot;</span>\n            <span class="hage" data-age="1767225595000">5s ago</span>\n          </span>\n        </button>',
    );
  });
});
