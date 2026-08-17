import { describe, expect, it } from "vitest";
import { pairingMessage, pairingUrl } from "./pairing.js";
import { type PairingLimits, RequestStore } from "./store.js";

const TTL = 5 * 60_000;
const IDLE = 2 * 60_000;
const LIMITS: PairingLimits = { maxAttempts: 5, burst: 5, refillMs: 60_000 };

function fresh(): { store: RequestStore; tick: (ms: number) => void } {
  let clock = 1_000_000;
  const store = new RequestStore({ now: () => clock });
  return {
    store,
    tick: (ms) => {
      clock += ms;
    },
  };
}

function issue(store: RequestStore): string {
  const code = store.issuePairingCode(TTL, IDLE);
  if (!code) {
    throw new Error("expected a code");
  }
  return code.code;
}

describe("issuing a code", () => {
  it("mints six digits, leading zeros kept", () => {
    const { store } = fresh();
    const wide = { ...LIMITS, burst: 1_000 };
    for (let i = 0; i < 300; i++) {
      // idle 0 keeps minting past the pairing each redeem records.
      const code = store.issuePairingCode(TTL, 0)?.code;
      expect(code).toMatch(/^\d{6}$/);
      store.redeemPairingCode(code ?? "", wide);
    }
  });

  it("reuses the live one, so a half-typed code never moves under the human", () => {
    const { store, tick } = fresh();
    const first = issue(store);
    tick(60_000);
    expect(issue(store)).toBe(first);
  });

  it("mints a new one once the old expired", () => {
    const { store, tick } = fresh();
    const first = issue(store);
    tick(TTL + 1);
    const second = issue(store);
    expect(second).not.toBe(first);
    expect(store.redeemPairingCode(first, LIMITS)).toEqual({ ok: false, reason: "invalid" });
  });

  it("hands out nothing while a plugin is still authenticating", () => {
    const { store, tick } = fresh();
    store.markPaired();
    expect(store.issuePairingCode(TTL, IDLE)).toBeNull();
    tick(IDLE + 1);
    expect(store.issuePairingCode(TTL, IDLE)).not.toBeNull();
  });
});

describe("redeeming a code", () => {
  it("works once, then the code is gone", () => {
    const { store } = fresh();
    const code = issue(store);
    expect(store.redeemPairingCode(code, LIMITS)).toEqual({ ok: true });
    expect(store.redeemPairingCode(code, LIMITS)).toEqual({ ok: false, reason: "expired" });
  });

  it("records the pairing, which is what stops the tools asking for a code", () => {
    const { store } = fresh();
    expect(store.pairedAt()).toBeNull();
    store.redeemPairingCode(issue(store), LIMITS);
    expect(store.pairedAt()).not.toBeNull();
  });

  it("burns the code after the attempt cap, so a guesser never gets a sixth try", () => {
    const { store } = fresh();
    // A wide budget, to watch the attempt cap on its own.
    const wide = { ...LIMITS, burst: 50 };
    const code = issue(store);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < wide.maxAttempts; i++) {
      expect(store.redeemPairingCode(wrong, wide)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(store.redeemPairingCode(code, wide)).toEqual({ ok: false, reason: "expired" });
  });

  it("reports expiry rather than a wrong code once nothing is live", () => {
    const { store } = fresh();
    expect(store.redeemPairingCode("123456", LIMITS)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("the guess budget", () => {
  it("paces guesses once the burst is spent", () => {
    const { store } = fresh();
    const code = issue(store);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < LIMITS.burst; i++) {
      store.redeemPairingCode(wrong, LIMITS);
    }
    const blocked = store.redeemPairingCode(wrong, LIMITS);
    expect(blocked.ok).toBe(false);
    expect(blocked).toMatchObject({ reason: "throttled" });
  });

  it("refills over time and never past the burst", () => {
    const { store, tick } = fresh();
    const code = issue(store);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < LIMITS.burst + 3; i++) {
      store.redeemPairingCode(wrong, LIMITS);
    }
    tick(LIMITS.refillMs * 50);
    for (let i = 0; i < LIMITS.burst; i++) {
      expect(store.redeemPairingCode(wrong, LIMITS)).not.toMatchObject({ reason: "throttled" });
    }
    expect(store.redeemPairingCode(wrong, LIMITS)).toMatchObject({ reason: "throttled" });
  });

  // The deliberate trade-off: a page draining the budget also locks the human out for a
  // while. Confidentiality of the token beats availability of pairing.
  it("refuses even the right code when the budget is spent, and keeps it for later", () => {
    const { store, tick } = fresh();
    const narrow: PairingLimits = { ...LIMITS, burst: 2 };
    const code = issue(store);
    const wrong = code === "000000" ? "111111" : "000000";
    store.redeemPairingCode(wrong, narrow);
    store.redeemPairingCode(wrong, narrow);
    expect(store.redeemPairingCode(code, narrow)).toMatchObject({ reason: "throttled" });
    tick(narrow.refillMs);
    expect(store.redeemPairingCode(code, narrow)).toEqual({ ok: true });
  });
});

describe("the agent-facing notice", () => {
  it("carries the code and where to type it", () => {
    const text = pairingMessage("041302");
    expect(text).toContain("041302");
    expect(text).toContain("Beekeeper Studio");
    expect(text).toContain(pairingUrl());
  });

  it("still tells the human where to go without a code", () => {
    expect(pairingMessage(null)).toContain(pairingUrl());
  });

  // An agent handed a description of the state greps the codebase for the cause and
  // retries in a loop instead of relaying the code, so the wording has to forbid both.
  it("orders the agent to relay, and to neither investigate nor retry", () => {
    for (const text of [pairingMessage("041302"), pairingMessage(null)]) {
      expect(text.startsWith("PAIRING REQUIRED.")).toBe(true);
      expect(text).toContain("ask the human");
      expect(text).toMatch(/do not investigate/i);
      expect(text).toMatch(/do not call this tool again/i);
      expect(text).not.toMatch(/retry this call/i);
    }
  });
});
