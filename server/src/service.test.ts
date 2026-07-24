import { describe, it, expect } from "vitest";
import { RequestStore } from "./store.js";
import { submitQuery, getQueryResult, cancelQuery } from "./service.js";

function fresh() {
  return new RequestStore({ proposalTtlMs: 10_000 });
}

describe("submitQuery", () => {
  it("enqueues a read-only query as pending", () => {
    const store = fresh();
    const ticket = submitQuery(store, { sessionId: "s1", sql: "SELECT 1", intent: "x" });
    expect(ticket.state).toBe("pending");
    expect(ticket.requestId).toMatch(/^req_/);
    expect(ticket.terminal).toBeUndefined();
  });

  it("rejects a non-read-only query before it is enqueued", () => {
    const store = fresh();
    expect(() => submitQuery(store, { sessionId: "s1", sql: "DELETE FROM t" })).toThrowError(
      /INVALID_SQL_POLICY/,
    );
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
