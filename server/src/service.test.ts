import { describe, expect, it } from "vitest";
import { cancelQuery, getQueryResult, submitQuery } from "./service.js";
import { RequestStore } from "./store.js";

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

  it("enforces ownership", async () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    await expect(getQueryResult(store, "s2", ticket.requestId, 0)).rejects.toThrowError(
      /NOT_OWNER/,
    );
  });
});

describe("cancelQuery", () => {
  it("cancels a pending request", () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1" });
    expect(cancelQuery(store, "s1", ticket.requestId).state).toBe("cancelled");
  });
});
