import { describe, expect, it } from "vitest";
import { MAX_WAIT_MS } from "./config.js";
import { cancelQuery, getQueryResult, pollResults, submitQuery } from "./service.js";
import { RequestStore } from "./store.js";

// A wait driven by a fake clock: every sleep jumps the deadline clock forward, so a
// bounded wait reaches its deadline without any real time passing.
function fakeWait() {
  const clock = { t: 0 };
  return {
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    elapsed: () => clock.t,
  };
}

// Every submit path is gated on a session label, so seed one for s1; tests that
// need a label-less session make their own bare store.
function fresh() {
  const store = new RequestStore({ proposalTtlMs: 10_000 });
  store.upsertSession({ sessionId: "s1" });
  store.setSessionLabel("s1", "audit");
  return store;
}

describe("submitQuery", () => {
  it("enqueues a read-only query as pending", () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1", intent: "x" });
    expect(ticket.state).toBe("pending");
    expect(ticket.requestId).toMatch(/^req_/);
    expect(ticket.terminal).toBeUndefined();
  });

  it("now forwards a write/destructive query (advisory), stamping its class for the audit", () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "DELETE FROM t" });
    expect(ticket.state).toBe("pending");
    const stored = store.get(ticket.requestId);
    expect((stored?.policy as { class?: string })?.class).toBe("destructive");
  });

  it("still rejects an empty or multi-statement query before it is enqueued", () => {
    const store = fresh();
    expect(() => submitQuery(store, { sessionId: "s1", sql: "   " })).toThrowError(
      /INVALID_SQL_POLICY/,
    );
    expect(() =>
      submitQuery(store, { sessionId: "s1", sql: "SELECT 1; DROP TABLE t" }),
    ).toThrowError(/INVALID_SQL_POLICY/);
  });

  it("rejects a query when the session has no label, and succeeds once labeled", () => {
    const store = new RequestStore({ proposalTtlMs: 10_000 });
    expect(() => submitQuery(store, { sessionId: "s9", sql: "SELECT 1" })).toThrowError(
      /NO_SESSION_LABEL/,
    );
    store.upsertSession({ sessionId: "s9" });
    store.setSessionLabel("s9", "audit");
    expect(submitQuery(store, { sessionId: "s9", sql: "SELECT 1" }).state).toBe("pending");
  });
});

describe("getQueryResult", () => {
  it("returns pending immediately when waitMs is 0", async () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    const read = await getQueryResult(store, "s1", ticket.requestId, 0);
    expect(read.state).toBe("pending");
  });

  it("returns the approved terminal once the broker resolves it", async () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    const claimed = store.claimNext("plugin", 1000)!;
    store.resolve(claimed.id, claimed.leaseId!, {
      status: "approved",
      rows: [{ ok: 1 }],
      fields: [{ name: "ok" }],
    });
    const read = await getQueryResult(store, "s1", ticket.requestId, 0);
    expect(read.state).toBe("approved");
    expect(read.terminal).toEqual({
      status: "approved",
      rows: [{ ok: 1 }],
      fields: [{ name: "ok" }],
      truncated: false,
      rowCount: 1,
    });
  });

  it("carries the changed-row count of an approved write", async () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "UPDATE t SET a = 1" });
    const claimed = store.claimNext("plugin", 1000)!;
    store.resolve(claimed.id, claimed.leaseId!, {
      status: "approved",
      rows: [],
      fields: [],
      affectedRows: 3,
    });
    const read = await getQueryResult(store, "s1", ticket.requestId, 0);
    expect(read.terminal).toEqual({
      status: "approved",
      rows: [],
      fields: [],
      truncated: false,
      rowCount: 0,
      affectedRows: 3,
    });
  });

  it("waits and returns once the request resolves during the wait", async () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    let resolved = false;
    const sleep = async () => {
      if (!resolved) {
        const claimed = store.claimNext("plugin", 1000)!;
        store.resolve(claimed.id, claimed.leaseId!, { status: "rejected", reason: "no" });
        resolved = true;
      }
    };
    const read = await getQueryResult(store, "s1", ticket.requestId, 5000, sleep);
    expect(read.state).toBe("rejected");
    expect(read.terminal?.reason).toBe("no");
  });

  // The contract every tool description and the skill promise: a wait that runs out is a
  // checkpoint, not an answer. If this ever became a throw or an error ticket, every one of
  // those surfaces would be lying.
  it("hands back the still-pending ticket when the wait runs out", async () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    const wait = fakeWait();
    const read = await getQueryResult(store, "s1", ticket.requestId, 5_000, wait.sleep, wait.now);
    expect(read.state).toBe("pending");
    expect(read.terminal).toBeUndefined();
    expect(wait.elapsed()).toBeGreaterThanOrEqual(5_000);
  });

  it("clamps a wait longer than the cap", async () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    const wait = fakeWait();
    await getQueryResult(store, "s1", ticket.requestId, MAX_WAIT_MS * 4, wait.sleep, wait.now);
    expect(wait.elapsed()).toBeLessThan(MAX_WAIT_MS * 2);
  });

  it("enforces ownership", async () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    await expect(getQueryResult(store, "s2", ticket.requestId, 0)).rejects.toThrowError(
      /NOT_OWNER/,
    );
  });
});

describe("pollResults", () => {
  it("returns the states with a pending count when the wait runs out", async () => {
    const store = fresh();
    submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    submitQuery(store, { sessionId: "s1", sql: "SELECT 2" });
    const wait = fakeWait();
    const snap = await pollResults(store, "s1", 5_000, wait.sleep, wait.now);
    expect(snap.pending).toBe(2);
    expect(snap.results.every((r) => r.state === "pending")).toBe(true);
    expect(wait.elapsed()).toBeGreaterThanOrEqual(5_000);
  });

  it("returns as soon as one of several open proposals resolves", async () => {
    const store = fresh();
    submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    submitQuery(store, { sessionId: "s1", sql: "SELECT 2" });
    const wait = fakeWait();
    let resolved = false;
    const sleep = async (ms: number) => {
      await wait.sleep(ms);
      if (!resolved) {
        const claimed = store.claimNext("plugin", 1000)!;
        store.resolve(claimed.id, claimed.leaseId!, { status: "rejected", reason: "no" });
        resolved = true;
      }
    };
    const snap = await pollResults(store, "s1", MAX_WAIT_MS, sleep, wait.now);
    expect(snap.pending).toBe(1);
    expect(wait.elapsed()).toBeLessThan(MAX_WAIT_MS);
  });
});

describe("cancelQuery", () => {
  it("cancels a pending request", () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    expect(cancelQuery(store, "s1", ticket.requestId).state).toBe("cancelled");
  });
});

describe("submitQuery desktop alert", () => {
  function fakeNotifier(active = true) {
    const labels: (string | null | undefined)[] = [];
    return {
      notifier: {
        active,
        probe: () => {},
        notify: (l: string | null | undefined) => labels.push(l),
      },
      labels,
    };
  }

  it("alerts once for a fresh proposal, carrying the session label", () => {
    const store = fresh();
    const { notifier, labels } = fakeNotifier();
    submitQuery(store, { sessionId: "s1", sql: "SELECT 1" }, notifier);
    expect(labels).toEqual(["audit"]);
  });

  it("raises nothing when no notifier is passed, which is what keeps the suite silent", () => {
    const store = fresh();
    expect(() => submitQuery(store, { sessionId: "s1", sql: "SELECT 1" })).not.toThrow();
  });

  it("raises nothing on an idempotency replay", () => {
    const store = fresh();
    const { notifier, labels } = fakeNotifier();
    const input = { sessionId: "s1", sql: "SELECT 1", idempotencyKey: "k1" };
    submitQuery(store, input, notifier);
    submitQuery(store, input, notifier);
    expect(labels).toHaveLength(1);
  });

  it("collapses a burst of fresh proposals into one alert", () => {
    const store = fresh();
    const { notifier, labels } = fakeNotifier();
    submitQuery(store, { sessionId: "s1", sql: "SELECT 1" }, notifier);
    submitQuery(store, { sessionId: "s1", sql: "SELECT 2" }, notifier);
    submitQuery(store, { sessionId: "s1", sql: "SELECT 3" }, notifier);
    expect(labels).toHaveLength(1);
  });

  // Off macOS the notifier reports itself inactive, and the cooldown row must not be
  // spent either, since the feature documents itself as absent there.
  it("does not even claim the cooldown when the notifier is inactive", () => {
    const store = fresh();
    const { notifier, labels } = fakeNotifier(false);
    submitQuery(store, { sessionId: "s1", sql: "SELECT 1" }, notifier);
    expect(labels).toEqual([]);
    expect(store.claimAlert(10_000)).toBe(true);
  });

  it("never lets a failing alert path break an accepted submit", () => {
    const store = fresh();
    const exploding = {
      active: true,
      probe: () => {},
      notify: () => {
        throw new Error("boom");
      },
    };
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1" }, exploding);
    expect(ticket.state).toBe("pending");
    expect(ticket.requestId).toMatch(/^req_/);
  });
});
