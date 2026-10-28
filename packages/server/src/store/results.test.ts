import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toTicket } from "../service.js";
import { listActivity, readArchive } from "./audit.js";
import { createContext, migrate, type StoreContext } from "./db.js";
import { claimNext, get, resolve, submit, sweep } from "./requests.js";

// Opaque to the server: any bytes of an accepted size stand in for the plugin's envelope.
const SEALED = Buffer.alloc(64, 7);

let ctx: StoreContext;
let clock: number;

beforeEach(() => {
  clock = 1_000;
  ctx = createContext({ now: () => clock, resultTtlMs: 1_000 });
  migrate(ctx.db);
});

afterEach(() => {
  ctx.db.close();
});

function claim(): { id: string; leaseId: string } {
  submit(ctx, { sessionId: "s1", sql: "SELECT 1" });
  const claimed = claimNext(ctx, "p", 30_000)!;
  return { id: claimed.id, leaseId: claimed.leaseId! };
}

function approve(archive?: Buffer): string {
  const { id, leaseId } = claim();
  resolve(ctx, id, leaseId, {
    status: "approved",
    rows: [{ ok: 1 }],
    fields: [{ name: "ok" }],
    ...(archive ? { archive } : {}),
  });
  return id;
}

describe("kept results", () => {
  it("keeps the sealed rows once the agent's copy is stripped", () => {
    const id = approve(SEALED);
    clock += 1_001;
    sweep(ctx);
    expect(toTicket(get(ctx, id)!).terminal).toMatchObject({ purged: true, rows: [] });
    expect(readArchive(ctx, id, null)).toEqual(SEALED);
    expect(listActivity(ctx, null)[0]).toMatchObject({ id, kept: true });
  });

  it("keeps an approved result's counts beside it and lists them from there", () => {
    const id = approve(SEALED);
    expect(
      ctx.db.prepare("SELECT row_count, affected_rows FROM requests WHERE id = ?").get(id),
    ).toEqual({
      row_count: 1,
      affected_rows: null,
    });
    // The columns win over result_json, which the activity view no longer parses for them.
    ctx.db
      .prepare("UPDATE requests SET row_count = 5, affected_rows = 2, result_json = ? WHERE id = ?")
      .run(JSON.stringify({ rows: [{ ok: 1 }], fields: [], rowCount: 9 }), id);
    expect(listActivity(ctx, null)[0]).toMatchObject({ id, rowCount: 5, affectedRows: 2 });
  });

  it("runs no JSON function over a result whose counts are in their columns", () => {
    const parsed: unknown[] = [];
    // An application function overloads SQLite's own, so every call the activity view makes lands here.
    ctx.db.function("json_valid", (text: unknown) => {
      parsed.push(text);
      return 1;
    });
    const id = approve(SEALED);
    listActivity(ctx, null);
    expect(parsed).toEqual([]);
    // A decision from before the columns still has its counts read through result_json.
    ctx.db.prepare("UPDATE requests SET row_count = NULL WHERE id = ?").run(id);
    expect(listActivity(ctx, null)[0].rowCount).toBe(1);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("adds the count columns to a store created before them", () => {
    const old = createContext();
    try {
      old.db.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
        session_id TEXT NOT NULL, sql TEXT NOT NULL, intent TEXT, idempotency_key TEXT,
        state TEXT NOT NULL, lease_id TEXT, lease_expires_at INTEGER, plugin_id TEXT,
        decided_at INTEGER, result_json TEXT, policy_json TEXT, expires_at INTEGER NOT NULL,
        connection TEXT)`);
      old.db
        .prepare(`INSERT INTO requests (id, created_at, session_id, sql, state, decided_at, result_json, expires_at)
          VALUES ('old', 1, 's1', 'SELECT 1', 'approved', 2, '{"purged":true,"rowCount":3}', 3)`)
        .run();
      migrate(old.db);
      const columns = (
        old.db.prepare("PRAGMA table_info(requests)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(["row_count", "affected_rows"]));
      expect(listActivity(old, null)[0]).toMatchObject({ id: "old", rowCount: 3, kept: false });
    } finally {
      old.db.close();
    }
  });

  it("says nothing is kept for a result sent without its sealed rows", () => {
    const id = approve();
    expect(readArchive(ctx, id, null)).toBeNull();
    expect(listActivity(ctx, null)[0]).toMatchObject({ id, kept: false });
  });

  it("records neither the decision nor the rows when the rows cannot be written", () => {
    const { id, leaseId } = claim();
    // A row already standing for this id makes the insert fail inside the decision's transaction.
    ctx.db.prepare("INSERT INTO results VALUES (?, ?, 1)").run(id, Buffer.from("stale"));
    expect(() =>
      resolve(ctx, id, leaseId, { status: "approved", rows: [], fields: [], archive: SEALED }),
    ).toThrow();
    expect(get(ctx, id)?.state).toBe("leased");
    expect(ctx.db.prepare("SELECT payload FROM results WHERE request_id = ?").get(id)).toEqual({
      payload: Buffer.from("stale"),
    });
  });

  it("serves the rows to the request's own connection and to unscoped requests only", () => {
    const scoped = approve(SEALED);
    const legacy = approve(SEALED);
    ctx.db.prepare("UPDATE requests SET connection = 'alpha' WHERE id = ?").run(scoped);
    expect(readArchive(ctx, scoped, "alpha")).toEqual(SEALED);
    expect(readArchive(ctx, scoped, "beta")).toBeNull();
    expect(readArchive(ctx, scoped, null)).toBeNull();
    expect(readArchive(ctx, legacy, "beta")).toEqual(SEALED);
  });

  it("serves nothing for a request that did not complete", () => {
    const { id, leaseId } = claim();
    resolve(ctx, id, leaseId, { status: "rejected" });
    // Only a token holder writing the table directly could attach rows to a declined request.
    ctx.db.prepare("INSERT INTO results VALUES (?, ?, 1)").run(id, SEALED);
    expect(readArchive(ctx, id, null)).toBeNull();
    expect(listActivity(ctx, null)[0]).toMatchObject({ id, kept: false });
  });

  it("overwrites what the sweep frees", () => {
    expect(ctx.db.pragma("secure_delete", { simple: true })).toBe(1);
  });
});

describe("who declined", () => {
  it.each(["human", "gate", "load"] as const)("records a %s decline and serves it back", (by) => {
    const { id, leaseId } = claim();
    resolve(ctx, id, leaseId, { status: "rejected", reason: "no", declinedBy: by });
    expect(listActivity(ctx, null)[0]).toMatchObject({ id, reason: "no", declinedBy: by });
  });

  it("reads an unknown stored author as not recorded", () => {
    const { id, leaseId } = claim();
    resolve(ctx, id, leaseId, { status: "rejected" });
    ctx.db
      .prepare(`UPDATE requests SET policy_json = '{"declinedBy":"someone"}' WHERE id = ?`)
      .run(id);
    expect(listActivity(ctx, null)[0].declinedBy).toBeUndefined();
  });

  it("says a person's reason holds words they typed, and only for a person's decline", () => {
    const typed = claim();
    resolve(ctx, typed.id, typed.leaseId, {
      status: "rejected",
      reason: "Narrow it. The query reads a table without a WHERE clause.",
      declinedBy: "human",
      reasonTyped: true,
    });
    const listed = (id: string) => listActivity(ctx, null).find((e) => e.id === id);
    expect(listed(typed.id)).toMatchObject({ declinedBy: "human", reasonTyped: true });
    const hintsOnly = claim();
    resolve(ctx, hintsOnly.id, hintsOnly.leaseId, {
      status: "rejected",
      reason: "The query reads a table without a WHERE clause.",
      declinedBy: "human",
    });
    expect(listed(hintsOnly.id)?.reasonTyped).toBeUndefined();
    const load = claim();
    resolve(ctx, load.id, load.leaseId, {
      status: "rejected",
      reason: "Rejected automatically by the load check.",
      declinedBy: "load",
      reasonTyped: true,
    });
    expect(listed(load.id)?.reasonTyped).toBeUndefined();
  });
});
