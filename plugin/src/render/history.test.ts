import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HistItem } from "../types";
import { historyRow } from "./history";

const T = new Date("2026-01-01T00:00:00Z").getTime();

const approved: HistItem = {
  id: "q_ab12",
  status: "approved",
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
  status: "rejected",
  note: "declined",
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
  it("renders identity as project then session label, before the approved status", () => {
    const html = historyRow(approved);
    expect(html).toContain('class="hrow approved"');
    // icon . project . label . status: the label sits between who and the status badge
    expect(html).toContain(
      '<span class="hwho" title="gatekeeper">gatekeeper</span>\n          <span class="hlabel" title="Audit review">Audit review</span>\n          <span class="hstatus approved">approved</span>',
    );
    expect(html).toContain('<span class="hintent">Check a user\'s email</span>');
    expect(html).toContain("<span class=\"st\">'jane@acme.io'</span>");
  });

  it("marks a rejected row distinctly, with an empty label slot and the data-no-intent fallback", () => {
    const html = historyRow(rejected);
    expect(html).toContain('class="hrow rejected"');
    expect(html).toContain("data-no-intent");
    expect(html).toContain('<span class="hlabel" title=""></span>');
    expect(html).toContain('<span class="hstatus rejected">rejected</span>');
    expect(html).not.toContain("approved");
  });
});
