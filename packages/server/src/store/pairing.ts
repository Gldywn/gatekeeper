import { randomInt, timingSafeEqual } from "node:crypto";
import type { StoreContext } from "./db.js";

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" }
  | { ok: false; reason: "throttled"; retryAfterMs: number };

export interface PairingLimits {
  /** Wrong guesses that burn a code. */
  maxAttempts: number;
  /** Guesses available back-to-back before the refill paces them. */
  burst: number;
  /** How long one guess takes to come back. */
  refillMs: number;
}

interface Row {
  code: string | null;
  expires_at: number | null;
  attempts: number;
  paired_at: number | null;
  budget: number;
  budget_at: number;
}

// budget_at 0 means the bucket was never touched, and the elapsed-since-epoch that
// implies refills it to full on first read, so a missing row needs no seeding.
const EMPTY: Row = {
  code: null,
  expires_at: null,
  attempts: 0,
  paired_at: null,
  budget: 0,
  budget_at: 0,
};

function read(ctx: StoreContext): Row {
  return (ctx.db.prepare("SELECT * FROM pairing WHERE id = 1").get() as Row | undefined) ?? EMPTY;
}

function ensureRow(ctx: StoreContext): void {
  ctx.db.prepare("INSERT OR IGNORE INTO pairing (id) VALUES (1)").run();
}

function randomCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function sameCode(stored: string, submitted: string): boolean {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(submitted, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The last time a token holder proved itself to the broker; null if none ever has. */
export function pairedAt(ctx: StoreContext): number | null {
  return read(ctx).paired_at;
}

export function markPaired(ctx: StoreContext): void {
  ensureRow(ctx);
  ctx.db.prepare("UPDATE pairing SET paired_at = ? WHERE id = 1").run(ctx.now());
}

// Mint-or-reuse, so the code a human is halfway through typing survives a second
// caller asking for one. Returns null while a plugin is still authenticating: there
// is nothing to pair then, and a live code is only something for a guesser to aim at.
export function issuePairingCode(
  ctx: StoreContext,
  ttlMs: number,
  idleMs: number,
): PairingCode | null {
  const run = ctx.db.transaction((): PairingCode | null => {
    const now = ctx.now();
    const row = read(ctx);
    if (row.paired_at !== null && now - row.paired_at < idleMs) {
      return null;
    }
    if (row.code && row.expires_at !== null && row.expires_at > now) {
      return { code: row.code, expiresAt: row.expires_at };
    }
    const code = randomCode();
    const expiresAt = now + ttlMs;
    ensureRow(ctx);
    ctx.db
      .prepare("UPDATE pairing SET code = ?, expires_at = ?, attempts = 0 WHERE id = 1")
      .run(code, expiresAt);
    return { code, expiresAt };
  });
  return run();
}

// The exchange route is reachable by any web page the human visits, so the guess
// budget gates the comparison itself: the per-code cap alone is unbounded, since a
// dead code is replaced by the next agent call.
export function redeemPairingCode(
  ctx: StoreContext,
  submitted: string,
  limits: PairingLimits,
): RedeemResult {
  const run = ctx.db.transaction((): RedeemResult => {
    const now = ctx.now();
    const row = read(ctx);
    const available = Math.min(limits.burst, row.budget + (now - row.budget_at) / limits.refillMs);
    if (available < 1) {
      return {
        ok: false,
        reason: "throttled",
        retryAfterMs: Math.ceil((1 - available) * limits.refillMs),
      };
    }
    ensureRow(ctx);
    ctx.db
      .prepare("UPDATE pairing SET budget = ?, budget_at = ? WHERE id = 1")
      .run(available - 1, now);

    if (!row.code || row.expires_at === null || row.expires_at <= now) {
      return { ok: false, reason: "expired" };
    }
    if (!sameCode(row.code, submitted)) {
      const attempts = row.attempts + 1;
      if (attempts >= limits.maxAttempts) {
        ctx.db
          .prepare("UPDATE pairing SET code = NULL, expires_at = NULL, attempts = 0 WHERE id = 1")
          .run();
      } else {
        ctx.db.prepare("UPDATE pairing SET attempts = ? WHERE id = 1").run(attempts);
      }
      return { ok: false, reason: "invalid" };
    }
    ctx.db
      .prepare(
        "UPDATE pairing SET code = NULL, expires_at = NULL, attempts = 0, paired_at = ? WHERE id = 1",
      )
      .run(now);
    return { ok: true };
  });
  return run();
}
