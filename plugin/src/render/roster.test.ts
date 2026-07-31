import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionRoster } from "../types";
import { presence, rosterRow } from "./roster";

// Byte-for-byte lock on the extracted roster builder: one live session with a
// pending count and an intent exercises the active branch, the harness badge,
// and the escaped intent label.

const T = new Date("2026-01-01T00:00:00Z").getTime();

const live: SessionRoster = {
  sessionId: "s1",
  harness: "claude-code",
  harnessVersion: null,
  project: "gatekeeper",
  createdAt: T - 60_000,
  lastSeen: T - 1_000,
  lastActive: T - 1_000,
  connection: "prod",
  leftAt: null,
  pendingCount: 2,
  lastIntent: "check a user's email",
  sessionLabel: "audit review",
};

// relAge() reads Date.now(); freeze it so any age render is stable.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterAll(() => {
  vi.useRealTimers();
});

describe("render/roster", () => {
  it("classifies a recently active session as active", () => {
    expect(presence(live, T)).toBe("active");
  });

  it("renders a live session row with its pending count and intent", () => {
    expect(rosterRow(live, presence(live, T))).toBe(
      '\n      <div class="roster-row" data-presence="active">\n        <span class="presence-dot"></span>\n        <span class="harness-badge"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n  <title>Claude Code</title>\n  <path clip-rule="evenodd"\n        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"\n        fill="#D97757"\n        fill-rule="evenodd" />\n</svg></span>\n        <span class="roster-label">gatekeeper</span>\n        <span class="roster-intent" title="Audit review">Audit review</span>\n        <span class="roster-meta">active &middot; 2 pending</span>\n      </div>',
    );
  });
});
