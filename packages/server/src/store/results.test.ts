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
  it.each(["human", "gate"] as const)("records a %s decline and serves it back", (by) => {
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
});
