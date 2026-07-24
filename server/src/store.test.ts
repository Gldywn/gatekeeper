import { describe, it, expect } from "vitest";
import { RequestStore, StoreError } from "./store.js";

function makeStore(overrides: Record<string, unknown> = {}) {
  const clock = { t: 1000 };
  const store = new RequestStore({
    now: () => clock.t,
    proposalTtlMs: 10_000,
    maxPendingPerSession: 3,
    ...overrides,
  });
  return { store, clock };
}

const LEASE = 1_000;

describe("submit", () => {
  it("enqueues a pending request", () => {
    const { store } = makeStore();
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1", intent: "check" });
    expect(req.state).toBe("pending");
    expect(req.sql).toBe("SELECT 1");
    expect(req.intent).toBe("check");
    expect(store.get(req.id)?.state).toBe("pending");
  });

  it("returns the same request for a repeated idempotency key", () => {
    const { store } = makeStore();
    const a = store.submit({ sessionId: "s1", sql: "SELECT 1", idempotencyKey: "k1" });
    const b = store.submit({ sessionId: "s1", sql: "SELECT 2", idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
    expect(b.sql).toBe("SELECT 1");
  });

  it("enforces per-session backpressure", () => {
    const { store } = makeStore({ maxPendingPerSession: 2 });
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    store.submit({ sessionId: "s1", sql: "SELECT 2" });
    expect(() => store.submit({ sessionId: "s1", sql: "SELECT 3" })).toThrowError(
      StoreError,
    );
    // a different session is unaffected
    expect(store.submit({ sessionId: "s2", sql: "SELECT 9" }).state).toBe("pending");
  });
});

describe("claim + resolve", () => {
  it("claims the oldest pending under a lease without removing it", () => {
    const { store, clock } = makeStore();
    const first = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    clock.t += 5;
    store.submit({ sessionId: "s1", sql: "SELECT 2" });

    const claimed = store.claimNext("plugin-a", LEASE);
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.state).toBe("leased");
    expect(claimed?.leaseId).toBeTruthy();
    // non-destructive: still present, now leased
    expect(store.get(first.id)?.state).toBe("leased");
  });

  it("returns null when nothing is pending", () => {
    const { store } = makeStore();
    expect(store.claimNext("plugin-a", LEASE)).toBeNull();
  });

  it("resolves approved with the held lease", () => {
    const { store } = makeStore();
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("plugin-a", LEASE)!;
    const done = store.resolve(claimed.id, claimed.leaseId!, {
      status: "approved",
      rows: [{ ok: 1 }],
      fields: [{ name: "ok" }],
    });
    expect(done.state).toBe("approved");
    expect(done.result).toEqual({ rows: [{ ok: 1 }], fields: [{ name: "ok" }] });
  });

  it("rejects a stale lease and cannot double-resolve", () => {
    const { store } = makeStore();
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("plugin-a", LEASE)!;
    store.resolve(claimed.id, claimed.leaseId!, { status: "rejected", reason: "no" });
    expect(() =>
      store.resolve(claimed.id, claimed.leaseId!, {
        status: "approved",
        rows: [],
        fields: [],
      }),
    ).toThrowError(/LEASE_CONFLICT|does not hold/);
  });
});

describe("lease recovery", () => {
  it("re-offers a proposal whose lease expired before a decision", () => {
    const { store, clock } = makeStore();
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    store.claimNext("plugin-a", LEASE);
    clock.t += LEASE + 1;
    // sweep runs inside claimNext; the abandoned proposal is claimable again
    const reclaimed = store.claimNext("plugin-b", LEASE);
    expect(reclaimed?.id).toBe(req.id);
    expect(reclaimed?.pluginId).toBe("plugin-b");
  });

  it("fails an execution whose lease expired as execution_unknown", () => {
    const { store, clock } = makeStore();
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("plugin-a", LEASE)!;
    store.markExecuting(claimed.id, claimed.leaseId!);
    clock.t += LEASE + 1;
    store.sweep();
    const after = store.get(req.id);
    expect(after?.state).toBe("failed");
    expect(after?.result).toEqual({ error: "execution_unknown" });
    // it must NOT be re-offered
    expect(store.claimNext("plugin-b", LEASE)).toBeNull();
  });
});

describe("cancel + expiry + ownership", () => {
  it("cancels a pending request but not a terminal one", () => {
    const { store } = makeStore();
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    expect(store.cancel(req.id, "s1").state).toBe("cancelled");
    expect(() => store.cancel(req.id, "s1")).toThrowError(/INVALID_STATE/);
  });

  it("expires a pending proposal past its TTL", () => {
    const { store, clock } = makeStore({ proposalTtlMs: 500 });
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    clock.t += 501;
    store.sweep();
    expect(store.get(req.id)?.state).toBe("expired");
  });

  it("guards ownership on lookup", () => {
    const { store } = makeStore();
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    expect(() => store.getForSession(req.id, "s2")).toThrowError(/NOT_OWNER/);
    expect(() => store.getForSession("req_missing", "s1")).toThrowError(/NOT_FOUND/);
  });
});
