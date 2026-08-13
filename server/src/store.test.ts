import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectionScopeKey } from "./connection.js";
import { pollResults } from "./service.js";
import { RequestStore, StoreError } from "./store.js";

// The composite scope key the store now stamps for a connection, matching the
// { name, postgresql, name } shape every setConn helper below posts.
const scopeOf = (name: string) =>
  connectionScopeKey({ connectionName: name, databaseType: "postgresql", databaseName: name });

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

  it("returns the same request for a repeated idempotency key with the same SQL", () => {
    const { store } = makeStore();
    const a = store.submit({ sessionId: "s1", sql: "SELECT 1", idempotencyKey: "k1" });
    const b = store.submit({ sessionId: "s1", sql: "SELECT 1", idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
    expect(b.sql).toBe("SELECT 1");
  });

  it("rejects a repeated idempotency key carrying different SQL", () => {
    const { store } = makeStore();
    store.submit({ sessionId: "s1", sql: "SELECT 1", idempotencyKey: "k1" });
    expect(() =>
      store.submit({ sessionId: "s1", sql: "SELECT 2", idempotencyKey: "k1" }),
    ).toThrowError(StoreError);
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
    expect(done.result).toEqual({
      rows: [{ ok: 1 }],
      fields: [{ name: "ok" }],
      truncated: false,
      rowCount: 1,
    });
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

describe("inflight re-hydration", () => {
  it("returns the leased proposals held by a plugin, scoped to it", () => {
    const { store } = makeStore();
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    store.submit({ sessionId: "s1", sql: "SELECT 2" });
    const claimed = store.claimNext("plugin-a", LEASE)!;
    // only the leased one (not the still-pending sibling), and only for its holder
    expect(store.listInflight("plugin-a", null).map((p) => p.id)).toEqual([claimed.id]);
    expect(store.listInflight("plugin-b", null)).toEqual([]);
  });

  it("omits a proposal whose lease has expired", () => {
    const { store, clock } = makeStore();
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    store.claimNext("plugin-a", LEASE);
    clock.t += LEASE + 1;
    expect(store.listInflight("plugin-a", null)).toEqual([]);
  });

  it("scopes to the queried connection", () => {
    const { store } = makeStore();
    store.setConnection({
      connectionName: "A",
      databaseType: "postgresql",
      databaseName: "A",
      readOnly: false,
    });
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    store.claimNext("plugin-a", LEASE, scopeOf("A"));
    expect(store.listInflight("plugin-a", scopeOf("A"))).toHaveLength(1);
    expect(store.listInflight("plugin-a", scopeOf("B"))).toEqual([]);
  });

  it("omits an executing proposal (it is not re-adopted)", () => {
    const { store } = makeStore();
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("plugin-a", LEASE)!;
    store.markExecuting(claimed.id, claimed.leaseId!);
    expect(store.listInflight("plugin-a", null)).toEqual([]);
  });
});

describe("session-wide result polling", () => {
  it("lists open and recently-decided requests as states, dropping stale ones", () => {
    const { store, clock } = makeStore({ resultTtlMs: 1_000 });
    store.submit({ sessionId: "s1", sql: "SELECT 1", intent: "one" });
    store.submit({ sessionId: "s1", sql: "SELECT 2", intent: "two" });
    const claimed = store.claimNext("p", LEASE)!;
    store.resolve(claimed.id, claimed.leaseId!, { status: "rejected", reason: "no" });
    // the decided one (rejected) plus the still-pending one, states only, never rows
    const list = store.listSessionRequests("s1");
    expect(list.map((r) => r.state).sort()).toEqual(["pending", "rejected"]);
    expect(JSON.stringify(list)).not.toContain("rows");
    expect(store.listSessionRequests("other")).toEqual([]);
    // once the decided one ages past resultTtl, it drops off; the pending stays
    clock.t += 1_001;
    expect(store.listSessionRequests("s1").map((r) => r.state)).toEqual(["pending"]);
  });

  it("poll_results returns a snapshot with the pending count", async () => {
    const { store } = makeStore();
    store.submit({ sessionId: "s1", sql: "SELECT 1" });
    store.submit({ sessionId: "s1", sql: "SELECT 2" });
    const snap = await pollResults(store, "s1", 0);
    expect(snap.pending).toBe(2);
    expect(snap.results.every((r) => r.state === "pending")).toBe(true);
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

describe("multi-process (two connections, one file)", () => {
  function tmpDbPath(): string {
    return join(tmpdir(), `gk-mp-${Math.random().toString(36).slice(2)}.db`);
  }
  function cleanup(path: string): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }

  it("shares the queue between two connections", () => {
    const path = tmpDbPath();
    const now = () => 1000;
    const a = new RequestStore({ path, now });
    const b = new RequestStore({ path, now });
    try {
      const req = a.submit({ sessionId: "s1", sql: "SELECT 1" });
      expect(b.get(req.id)?.state).toBe("pending");
    } finally {
      a.close();
      b.close();
      cleanup(path);
    }
  });

  it("never lets two connections claim the same proposal", () => {
    const path = tmpDbPath();
    const now = () => 1000;
    const a = new RequestStore({ path, now });
    const b = new RequestStore({ path, now });
    try {
      a.submit({ sessionId: "s1", sql: "SELECT 1" });
      const first = a.claimNext("plugin-a", 1000);
      const second = b.claimNext("plugin-b", 1000);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    } finally {
      a.close();
      b.close();
      cleanup(path);
    }
  });

  it("refuses a stale lease holder after the proposal is re-offered to another connection", () => {
    const path = tmpDbPath();
    const clock = { t: 1000 };
    const now = () => clock.t;
    const a = new RequestStore({ path, now });
    const b = new RequestStore({ path, now });
    try {
      const req = a.submit({ sessionId: "s1", sql: "SELECT 1" });
      const held = a.claimNext("plugin-a", 1000)!;
      clock.t += 1001; // a's lease expires
      b.sweep(); // b re-offers it
      const reclaimed = b.claimNext("plugin-b", 1000)!;
      expect(reclaimed.id).toBe(req.id);
      // a is now a stale writer; its lease must be refused
      expect(() =>
        a.resolve(held.id, held.leaseId!, { status: "approved", rows: [], fields: [] }),
      ).toThrowError(/LEASE_CONFLICT|does not hold/);
      // b, the current owner, resolves fine
      expect(
        b.resolve(reclaimed.id, reclaimed.leaseId!, {
          status: "approved",
          rows: [],
          fields: [],
        }).state,
      ).toBe("approved");
    } finally {
      a.close();
      b.close();
      cleanup(path);
    }
  });
});

describe("session identity", () => {
  it("records and refreshes a session's harness and project", () => {
    const { store, clock } = makeStore();
    store.upsertSession({
      sessionId: "s1",
      harness: "claude-code",
      harnessVersion: "1.2.3",
      project: "gatekeeper",
    });
    expect(store.getSession("s1")).toMatchObject({
      sessionId: "s1",
      harness: "claude-code",
      harnessVersion: "1.2.3",
      project: "gatekeeper",
    });
    // a later partial upsert keeps prior non-null values and bumps last_seen
    clock.t += 100;
    store.upsertSession({ sessionId: "s1", project: "gatekeeper" });
    const s = store.getSession("s1")!;
    expect(s.harness).toBe("claude-code");
    expect(s.lastSeen).toBe(clock.t);
  });

  it("returns null for an unknown session", () => {
    expect(makeStore().store.getSession("nope")).toBeNull();
  });
});

describe("retention", () => {
  it("deletes terminal requests, audit, and dead sessions past the window", () => {
    const { store, clock } = makeStore({ retentionMs: 1_000 });
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("p", LEASE)!;
    store.resolve(claimed.id, claimed.leaseId!, { status: "rejected", reason: "no" });
    store.upsertSession({ sessionId: "s1", harness: "codex" });
    clock.t += 1_001;
    store.sweep();
    expect(store.get(req.id)).toBeNull();
    expect(store.readAudit(req.id)).toHaveLength(0);
    expect(store.getSession("s1")).toBeNull();
  });

  it("keeps terminal rows within the window", () => {
    const { store } = makeStore({ retentionMs: 60_000 });
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("p", LEASE)!;
    store.resolve(claimed.id, claimed.leaseId!, { status: "rejected", reason: "no" });
    store.sweep();
    expect(store.get(req.id)?.state).toBe("rejected");
  });
});

describe("connection binding", () => {
  function setConn(store: RequestStore, name: string): void {
    store.setConnection({
      connectionName: name,
      databaseType: "postgresql",
      databaseName: name,
      readOnly: false,
    });
  }

  it("offers a proposal only on the connection it was submitted under", () => {
    const { store } = makeStore();
    setConn(store, "prod");
    const a = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    setConn(store, "local");
    const b = store.submit({ sessionId: "s1", sql: "SELECT 2" });
    // a plugin on "local" gets only the local-stamped proposal
    expect(store.claimNext("p", LEASE, scopeOf("local"))?.id).toBe(b.id);
    expect(store.claimNext("p", LEASE, scopeOf("local"))).toBeNull();
    // the prod-stamped one waits for a prod plugin
    expect(store.claimNext("p", LEASE, scopeOf("prod"))?.id).toBe(a.id);
  });

  it("still offers unstamped proposals to any connection", () => {
    const { store } = makeStore();
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    expect(store.claimNext("p", LEASE, "whatever")?.id).toBe(req.id);
  });
});

describe("presence", () => {
  function setConn(store: RequestStore, name: string): void {
    store.setConnection({
      connectionName: name,
      databaseType: "postgresql",
      databaseName: name,
      readOnly: false,
    });
  }

  it("records identity and activity on upsert; heartbeat refreshes presence only", () => {
    const { store, clock } = makeStore();
    store.upsertSession({ sessionId: "s1", harness: "claude-code", project: "gatekeeper" });
    const created = store.getSession("s1");
    expect(created?.harness).toBe("claude-code");
    expect(created?.lastActive).toBe(clock.t);
    expect(created?.leftAt).toBeNull();

    clock.t += 5_000;
    store.heartbeatSession("s1");
    const beat = store.getSession("s1");
    expect(beat?.lastSeen).toBe(clock.t);
    // A heartbeat is presence, not activity: last_active must not move.
    expect(beat?.lastActive).toBe(created?.lastActive);
  });

  it("marks a session as left, and a later upsert revives it", () => {
    const { store, clock } = makeStore();
    store.upsertSession({ sessionId: "s1" });
    clock.t += 1_000;
    store.markSessionLeft("s1");
    expect(store.getSession("s1")?.leftAt).toBe(clock.t);
    store.upsertSession({ sessionId: "s1" });
    expect(store.getSession("s1")?.leftAt).toBeNull();
  });

  it("lists sessions for a connection with their open request counts", () => {
    const { store } = makeStore();
    setConn(store, "staging");
    store.upsertSession({ sessionId: "s1", harness: "claude-code" });
    store.setSessionLabel("s1", "audit");
    store.submit({ sessionId: "s1", sql: "SELECT 1", intent: "check tables" });
    setConn(store, "other");
    store.upsertSession({ sessionId: "s2", harness: "codex" });
    store.setSessionLabel("s2", "audit");

    const staging = store.listSessions(scopeOf("staging"));
    expect(staging.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(staging[0].pendingCount).toBe(1);
    expect(staging[0].connection).toBe(scopeOf("staging"));
    expect(staging[0].lastIntent).toBe("check tables");

    const other = store.listSessions(scopeOf("other"));
    expect(other.map((s) => s.sessionId)).toEqual(["s2"]);
    expect(other[0].pendingCount).toBe(0);
  });

  it("scopes each session's pending count to the queried connection", () => {
    const { store } = makeStore();
    store.upsertSession({ sessionId: "s1" }); // unstamped: visible on every connection
    store.setSessionLabel("s1", "audit");
    setConn(store, "A");
    store.submit({ sessionId: "s1", sql: "SELECT 1" }); // request stamped A
    expect(store.listSessions(scopeOf("A"))[0].pendingCount).toBe(1);
    expect(store.listSessions(scopeOf("B"))[0].pendingCount).toBe(0);
  });

  it("heartbeat does not re-tag the session's connection", () => {
    const { store } = makeStore();
    setConn(store, "A");
    store.upsertSession({ sessionId: "s1" });
    setConn(store, "B");
    store.heartbeatSession("s1");
    expect(store.getSession("s1")?.connection).toBe(scopeOf("A"));
  });

  it("stores an agent-set session label surfaced in the roster", () => {
    const { store } = makeStore();
    setConn(store, "staging");
    store.upsertSession({ sessionId: "s1", harness: "claude-code" });
    // No label yet: getSession has none and the roster hides the agent.
    expect(store.getSession("s1")?.sessionLabel).toBeNull();
    expect(store.listSessions(scopeOf("staging"))).toHaveLength(0);
    store.setSessionLabel("s1", "Support SUP-1042");
    expect(store.listSessions(scopeOf("staging"))[0].sessionLabel).toBe("Support SUP-1042");
    // getSession carries the label too, so /pending can surface it in detail.
    expect(store.getSession("s1")?.sessionLabel).toBe("Support SUP-1042");
  });

  it("hides a label-less session from the roster until it is labeled", () => {
    const { store } = makeStore();
    setConn(store, "staging");
    store.upsertSession({ sessionId: "s1", harness: "claude-code" });
    expect(store.listSessions(scopeOf("staging"))).toHaveLength(0);
    // A whitespace-only label does not count as a label.
    store.setSessionLabel("s1", "   ");
    expect(store.listSessions(scopeOf("staging"))).toHaveLength(0);
    store.setSessionLabel("s1", "audit");
    expect(store.listSessions(scopeOf("staging")).map((s) => s.sessionId)).toEqual(["s1"]);
  });

  it("drops a session idle past the roster TTL even while it heartbeats", () => {
    const { store, clock } = makeStore({ rosterIdleTtlMs: 1_000 });
    setConn(store, "staging");
    store.upsertSession({ sessionId: "s1", harness: "claude-code" });
    store.setSessionLabel("s1", "audit");
    clock.t += 2_000;
    store.heartbeatSession("s1");
    expect(store.listSessions(scopeOf("staging"))).toHaveLength(0);
    // It returns on its next real action.
    store.upsertSession({ sessionId: "s1", harness: "claude-code" });
    expect(store.listSessions(scopeOf("staging"))).toHaveLength(1);
  });
});

describe("listActivity", () => {
  function setConn(store: RequestStore, name: string): void {
    store.setConnection({
      connectionName: name,
      databaseType: "postgresql",
      databaseName: name,
      readOnly: false,
    });
  }

  it("returns terminal requests newest-first, connection-scoped, with no row data", () => {
    const { store, clock } = makeStore();
    setConn(store, "prod");
    store.upsertSession({ sessionId: "s1", harness: "claude-code", project: "gatekeeper" });

    // Approved: rows carry secrets that must never reach the activity feed.
    const approved = store.submit({
      sessionId: "s1",
      sql: "SELECT email FROM users",
      intent: "peek",
    });
    const ca = store.claimNext("p", LEASE, scopeOf("prod"))!;
    store.resolve(ca.id, ca.leaseId!, {
      status: "approved",
      rows: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
      fields: [{ name: "email" }],
    });

    // Rejected with a human reason.
    clock.t += 10;
    const rejected = store.submit({ sessionId: "s1", sql: "DELETE FROM users", intent: "cleanup" });
    const cr = store.claimNext("p", LEASE, scopeOf("prod"))!;
    store.resolve(cr.id, cr.leaseId!, { status: "rejected", reason: "not read-only" });

    // Failed with an engine error.
    clock.t += 10;
    const failed = store.submit({ sessionId: "s1", sql: "SELECT * FROM missing" });
    const cf = store.claimNext("p", LEASE, scopeOf("prod"))!;
    store.resolve(cf.id, cf.leaseId!, { status: "failed", error: "relation does not exist" });

    // A still-pending request is not terminal and must not appear.
    store.submit({ sessionId: "s1", sql: "SELECT 1" });

    // A terminal request on another connection must not appear.
    setConn(store, "other");
    const elsewhere = store.submit({ sessionId: "s1", sql: "SELECT 9" });
    const ce = store.claimNext("p", LEASE, scopeOf("other"))!;
    store.resolve(ce.id, ce.leaseId!, { status: "rejected", reason: "no" });

    const activity = store.listActivity(scopeOf("prod"));
    // Newest-first; the pending and the other-connection entries are excluded.
    expect(activity.map((e) => e.id)).toEqual([failed.id, rejected.id, approved.id]);
    expect(activity.map((e) => e.id)).not.toContain(elsewhere.id);

    // No result-row content anywhere in the payload.
    const serialized = JSON.stringify(activity);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("bob@example.com");

    const a = activity.find((e) => e.id === approved.id)!;
    // The approved entry contributes only a scalar count and its metadata.
    expect(a.state).toBe("approved");
    expect(a.rowCount).toBe(2);
    expect(a.reason).toBeNull();
    expect(a).not.toHaveProperty("rows");
    expect(a).not.toHaveProperty("result");
    expect(a.sql).toBe("SELECT email FROM users");
    expect(a.intent).toBe("peek");
    // Session identity is joined from the sessions table.
    expect(a.harness).toBe("claude-code");
    expect(a.project).toBe("gatekeeper");

    const r = activity.find((e) => e.id === rejected.id)!;
    expect(r.reason).toBe("not read-only");
    expect(r.rowCount).toBeNull();

    const f = activity.find((e) => e.id === failed.id)!;
    expect(f.error).toBe("relation does not exist");
  });

  it("carries no row content once an approved result is purged", () => {
    const { store, clock } = makeStore({ resultTtlMs: 1_000 });
    setConn(store, "prod");
    store.submit({ sessionId: "s1", sql: "SELECT ssn FROM people" });
    const c = store.claimNext("p", LEASE, scopeOf("prod"))!;
    store.resolve(c.id, c.leaseId!, {
      status: "approved",
      rows: [{ ssn: "123-45-6789" }],
      fields: [{ name: "ssn" }],
    });
    clock.t += 1_001;
    store.sweep(); // strips the rows, leaving an approved-but-purged terminal
    const entry = store.listActivity(scopeOf("prod"))[0];
    expect(entry.state).toBe("approved");
    expect(entry.rowCount).toBeNull();
    expect(JSON.stringify(entry)).not.toContain("123-45-6789");
  });

  it("honours the row limit", () => {
    const { store, clock } = makeStore();
    setConn(store, "prod");
    for (let i = 0; i < 5; i++) {
      clock.t += 1;
      store.submit({ sessionId: "s1", sql: `SELECT ${i}` });
      const c = store.claimNext("p", LEASE, scopeOf("prod"))!;
      store.resolve(c.id, c.leaseId!, { status: "rejected", reason: "no" });
    }
    expect(store.listActivity(scopeOf("prod"), 2)).toHaveLength(2);
  });

  it("still lists an unstamped terminal request on any connection", () => {
    const { store } = makeStore();
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    const c = store.claimNext("p", LEASE)!;
    store.resolve(c.id, c.leaseId!, { status: "rejected", reason: "no" });
    expect(store.listActivity("whatever").map((e) => e.id)).toEqual([req.id]);
  });
});

describe("composite connection scope", () => {
  function setConn(store: RequestStore, name: string, type: string, db: string): void {
    store.setConnection({
      connectionName: name,
      databaseType: type,
      databaseName: db,
      readOnly: false,
    });
  }
  const key = (name: string, type: string, db: string) =>
    connectionScopeKey({ connectionName: name, databaseType: type, databaseName: db });

  it("never claims another connection's queries when the display name collides", () => {
    const { store } = makeStore();
    // Same display name, different engine: a Postgres and a MySQL "gatekeeper_test".
    setConn(store, "gatekeeper_test", "postgresql", "gatekeeper_test");
    const pg = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    setConn(store, "gatekeeper_test", "mysql", "gatekeeper_test");
    const my = store.submit({ sessionId: "s1", sql: "SELECT 2" });

    const pgKey = key("gatekeeper_test", "postgresql", "gatekeeper_test");
    const myKey = key("gatekeeper_test", "mysql", "gatekeeper_test");
    expect(pgKey).not.toBe(myKey);

    // The MySQL plugin claims only the MySQL-stamped proposal, never the Postgres one.
    expect(store.claimNext("p", LEASE, myKey)?.id).toBe(my.id);
    expect(store.claimNext("p", LEASE, myKey)).toBeNull();
    // The Postgres-stamped one still waits for its own plugin.
    expect(store.claimNext("p", LEASE, pgKey)?.id).toBe(pg.id);
  });

  it("separates the roster and activity for same-named different-engine connections", () => {
    const { store } = makeStore();
    const pgKey = key("gk", "postgresql", "gk");
    const myKey = key("gk", "mysql", "gk");

    setConn(store, "gk", "postgresql", "gk");
    store.upsertSession({ sessionId: "s-pg", harness: "claude-code" });
    store.setSessionLabel("s-pg", "pg audit");
    const pgReq = store.submit({ sessionId: "s-pg", sql: "SELECT 1" });
    const cp = store.claimNext("p", LEASE, pgKey)!;
    store.resolve(cp.id, cp.leaseId!, { status: "rejected", reason: "no" });

    setConn(store, "gk", "mysql", "gk");
    store.upsertSession({ sessionId: "s-my", harness: "codex" });
    store.setSessionLabel("s-my", "my audit");
    const myReq = store.submit({ sessionId: "s-my", sql: "SELECT 2" });
    const cm = store.claimNext("p", LEASE, myKey)!;
    store.resolve(cm.id, cm.leaseId!, { status: "rejected", reason: "no" });

    expect(store.listSessions(pgKey).map((s) => s.sessionId)).toEqual(["s-pg"]);
    expect(store.listSessions(myKey).map((s) => s.sessionId)).toEqual(["s-my"]);
    expect(store.listActivity(pgKey).map((e) => e.id)).toEqual([pgReq.id]);
    expect(store.listActivity(myKey).map((e) => e.id)).toEqual([myReq.id]);
  });

  it("still shares state across the identical connection (same name, engine, database)", () => {
    const { store } = makeStore();
    const k = key("gk", "postgresql", "app");
    setConn(store, "gk", "postgresql", "app");
    const req = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    // A second plugin instance on the exact same connection claims and re-adopts it.
    const claimed = store.claimNext("plugin-x", LEASE, k)!;
    expect(claimed.id).toBe(req.id);
    expect(store.listInflight("plugin-x", k).map((p) => p.id)).toEqual([req.id]);
  });

  it("separates two connections that differ only by database name", () => {
    const { store } = makeStore();
    const appKey = key("gk", "postgresql", "app");
    const analyticsKey = key("gk", "postgresql", "analytics");
    expect(appKey).not.toBe(analyticsKey);

    setConn(store, "gk", "postgresql", "app");
    const appReq = store.submit({ sessionId: "s1", sql: "SELECT 1" });
    expect(store.claimNext("p", LEASE, analyticsKey)).toBeNull();
    expect(store.claimNext("p", LEASE, appKey)?.id).toBe(appReq.id);
  });
});
