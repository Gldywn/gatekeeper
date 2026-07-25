import { describe, expect, it } from "vitest";
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
    expect(() => store.submit({ sessionId: "s1", sql: "SELECT 3" })).toThrowError(StoreError);
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

  it("rejects lease operations once the lease has expired, before any sweep", () => {
    const { store, clock } = makeStore();
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("plugin-a", LEASE)!;
    clock.t += LEASE + 1;
    // no sweep has run yet; the expired lease must still be refused
    expect(() => store.markExecuting(claimed.id, claimed.leaseId!)).toThrowError(/expired/);
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

describe("audit trail", () => {
  it("records the full lifecycle of an approved request", () => {
    const { store } = makeStore();
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("plugin-a", LEASE)!;
    store.markExecuting(claimed.id, claimed.leaseId!);
    store.resolve(claimed.id, claimed.leaseId!, {
      status: "approved",
      rows: [{}, {}],
      fields: [],
    });
    const trail = store.readAudit(req.id);
    expect(trail.map((e) => e.event)).toEqual(["submitted", "claimed", "executing", "approved"]);
    expect(trail.find((e) => e.event === "approved")?.detail).toBe("2 rows");
    expect(trail.find((e) => e.event === "submitted")?.sqlDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records execution_unknown when an executing lease is swept", () => {
    const { store, clock } = makeStore();
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("p", LEASE)!;
    store.markExecuting(claimed.id, claimed.leaseId!);
    clock.t += LEASE + 1;
    store.sweep();
    expect(store.readAudit(req.id).map((e) => e.event)).toContain("execution_unknown");
  });

  it("never stores the raw SQL", () => {
    const { store } = makeStore();
    const req = store.submit({ sessionId: "s1", sql: "SELECT secret FROM users" });
    for (const entry of store.readAudit(req.id)) {
      expect(JSON.stringify(entry)).not.toContain("secret");
    }
  });
});

describe("result retention", () => {
  it("strips approved result rows after the retention window", () => {
    const { store, clock } = makeStore({ resultTtlMs: 1_000 });
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("p", LEASE)!;
    store.resolve(claimed.id, claimed.leaseId!, {
      status: "approved",
      rows: [{ ok: 1 }],
      fields: [{ name: "ok" }],
    });
    // within the window the rows are intact
    store.sweep();
    const before = store.get(claimed.id)!;
    expect((before.result as { rows?: unknown[] }).rows).toEqual([{ ok: 1 }]);

    clock.t += 1_001;
    store.sweep();
    const after = store.get(claimed.id)!;
    expect(after.state).toBe("approved");
    expect((after.result as { purged?: boolean; rows?: unknown[] }).purged).toBe(true);
    expect((after.result as { rows?: unknown[] }).rows).toBeUndefined();
    expect(store.readAudit(claimed.id).map((e) => e.event)).toContain("result_purged");
  });

  it("does not re-purge or touch rejected results", () => {
    const { store, clock } = makeStore({ resultTtlMs: 1_000 });
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("p", LEASE)!;
    store.resolve(claimed.id, claimed.leaseId!, { status: "rejected", reason: "no" });
    clock.t += 5_000;
    store.sweep();
    store.sweep();
    // a rejected outcome carries no rows to strip and logs no purge
    expect(store.readAudit(claimed.id).filter((e) => e.event === "result_purged")).toHaveLength(0);
  });
});
