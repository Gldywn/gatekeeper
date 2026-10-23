import { describe, expect, it, vi } from "vitest";
import { toTicket } from "../service.js";
import { listActivity } from "./audit.js";
import { createContext, migrate } from "./db.js";
import { get, sweep } from "./requests.js";

// One decided request with this raw result_json, read back through the activity view.
function factsOf(state: string, resultJson: string | null) {
  const ctx = createContext();
  try {
    migrate(ctx.db);
    ctx.db
      .prepare(`INSERT INTO requests (id, created_at, session_id, sql, state, decided_at, result_json, expires_at)
        VALUES ('r', 1, 's1', 'SELECT 1', ?, 2, ?, 3)`)
      .run(state, resultJson);
    const [e] = listActivity(ctx, null);
    return { reason: e.reason, error: e.error, rowCount: e.rowCount, affectedRows: e.affectedRows };
  } finally {
    ctx.db.close();
  }
}

describe("durable audit counts", () => {
  it.each([
    { result: { purged: true }, rowCount: null, affectedRows: null },
    { result: { purged: true, rowCount: 0, affectedRows: 0 }, rowCount: 0, affectedRows: 0 },
    {
      result: { rows: [{ a: 1 }], rowCount: 50, affectedRows: 70 },
      rowCount: 50,
      affectedRows: 70,
    },
    {
      result: { purged: true, rowCount: "3", affectedRows: -1 },
      rowCount: null,
      affectedRows: null,
    },
    {
      result: { purged: true, rowCount: 0.5, affectedRows: 1e20 },
      rowCount: null,
      affectedRows: null,
    },
    { result: { rows: [{ a: 1 }, { a: 2 }] }, rowCount: 2, affectedRows: null },
    { result: { rows: "two" }, rowCount: null, affectedRows: null },
  ])("extracts only known scalar counts from $result", ({ result, rowCount, affectedRows }) => {
    expect(factsOf("approved", JSON.stringify(result))).toEqual({
      reason: null,
      error: null,
      rowCount,
      affectedRows,
    });
  });

  it("keeps a decline's reason and a failure's error, and reads a malformed record as unknown", () => {
    expect(factsOf("rejected", JSON.stringify({ reason: "use the replica" })).reason).toBe(
      "use the replica",
    );
    expect(factsOf("rejected", JSON.stringify({ reason: 7 })).reason).toBeNull();
    expect(factsOf("failed", JSON.stringify({ error: "boom" })).error).toBe("boom");
    expect(factsOf("approved", "{not json")).toEqual({
      reason: null,
      error: null,
      rowCount: null,
      affectedRows: null,
    });
    expect(factsOf("approved", null).rowCount).toBeNull();
  });

  it("never brings a result's rows into JavaScript to count them", () => {
    const ctx = createContext();
    const parse = vi.spyOn(JSON, "parse");
    try {
      migrate(ctx.db);
      const insert = ctx.db.prepare(`INSERT INTO requests
        (id, created_at, session_id, sql, state, decided_at, result_json, expires_at)
        VALUES (?, 1, 's1', 'SELECT 1', 'approved', ?, ?, 3)`);
      // Results still inside their agent window, 1 MiB of rows each.
      const rows = Array.from({ length: 4_096 }, (_, i) => ({ i, pad: "x".repeat(240) }));
      const big = JSON.stringify({
        rows,
        fields: [{ name: "i" }],
        truncated: true,
        rowCount: 9_000,
      });
      for (let i = 0; i < 20; i++) insert.run(`r${i}`, i + 2, big);
      parse.mockClear();
      const activity = listActivity(ctx, null, 20);
      expect(activity.map((e) => e.rowCount)).toEqual(Array(20).fill(9_000));
      const largest = Math.max(0, ...parse.mock.calls.map(([text]) => String(text).length));
      expect(largest).toBeLessThan(1_024);
    } finally {
      parse.mockRestore();
      ctx.db.close();
    }
  });

  it("keeps old purged entries unknown after migration and through the agent response", () => {
    const ctx = createContext();
    try {
      migrate(ctx.db);
      ctx.db
        .prepare(`INSERT INTO requests
        (id, created_at, session_id, sql, state, decided_at, result_json, expires_at)
        VALUES ('old', 1, 's1', 'SELECT 1', 'approved', 2, '{"purged":true}', 3)`)
        .run();
      migrate(ctx.db);
      sweep(ctx);
      expect(listActivity(ctx, null)[0]).toMatchObject({ rowCount: null, affectedRows: null });
      expect(toTicket(get(ctx, "old")!).terminal).toEqual({
        status: "approved",
        purged: true,
        rows: [],
        fields: [],
      });
    } finally {
      ctx.db.close();
    }
  });

  it("bounds activity reads and indexes cleanup with 100,000 retained synthetic decisions", () => {
    const ctx = createContext({ now: () => 10 ** 12 });
    try {
      migrate(ctx.db);
      const beforeBytes =
        Number(ctx.db.pragma("page_count", { simple: true })) *
        Number(ctx.db.pragma("page_size", { simple: true }));
      const evaluation = {
        provider: "typesafe",
        model: "jev-1.13.0",
        policy: "auto-beta-4",
        evaluatedAt: 1,
        sqlDigest: "a".repeat(64),
        eligible: true,
        reasons: [],
        probabilities: {
          read_only: 0.99,
          personal_disclosure: 0.01,
          organization_disclosure: 0.01,
          secret_disclosure: 0.01,
          insufficient_context: 0.01,
        },
      };
      const policy = JSON.stringify({ approval: { source: "automatic", evaluation }, evaluation });
      ctx.db
        .prepare(`INSERT INTO sessions (session_id, created_at, last_seen, session_label)
        VALUES ('s1', 1, 1, 'Synthetic retained session')`)
        .run();
      const insert = ctx.db.prepare(`INSERT INTO requests
        (id, created_at, session_id, sql, intent, state, decided_at, result_json, policy_json, expires_at, connection)
        VALUES (?, 1, 's1', ?, ?, 'approved', ?, '{"purged":true,"rowCount":5,"affectedRows":0}', ?, 3, ?)`);
      ctx.db.transaction(() => {
        for (let i = 0; i < 100_000; i++) {
          insert.run(
            String(i).padStart(6, "0"),
            "SELECT status, SUM(total) AS total FROM public.orders WHERE total > 0 GROUP BY status ORDER BY total DESC LIMIT 5",
            "Review synthetic grouped commercial totals for the monthly report",
            Math.floor(i / 2),
            policy,
            [null, "alpha", "beta"][i % 3],
          );
        }
        // Every tenth decision kept its sealed rows, so the kept flag has both answers to find.
        const keep = ctx.db.prepare("INSERT INTO results VALUES (?, ?, 1)");
        for (let i = 0; i < 100_000; i += 10) {
          keep.run(String(i).padStart(6, "0"), Buffer.alloc(256, 1));
        }
      })();
      const afterBytes =
        Number(ctx.db.pragma("page_count", { simple: true })) *
        Number(ctx.db.pragma("page_size", { simple: true }));
      const prepare = vi.spyOn(ctx.db, "prepare");
      const started = performance.now();
      const activity = listActivity(ctx, "alpha");
      const elapsed = performance.now() - started;
      expect(activity).toHaveLength(200);
      const expectedIds = Array.from({ length: 100_000 }, (_, i) => i)
        .filter((i) => i % 3 !== 2)
        .reverse()
        .slice(0, 200)
        .map((i) => String(i).padStart(6, "0"));
      expect(activity.map((entry) => entry.id)).toEqual(expectedIds);
      expect(activity[0]).toMatchObject({
        sessionLabel: "Synthetic retained session",
        rowCount: 5,
        affectedRows: 0,
        evaluation,
      });
      expect(activity.every((entry) => entry.kept === (Number(entry.id) % 10 === 0))).toBe(true);
      expect(listActivity(ctx, null)).toHaveLength(200);
      expect(listActivity(ctx, null).every((entry) => Number(entry.id) % 3 === 0)).toBe(true);
      sweep(ctx);
      const statements = prepare.mock.calls.map(([sql]) => sql);
      prepare.mockRestore();
      const activitySql = statements.find((sql) => sql.includes("WITH recent"))!;
      const activityPlan = ctx.db
        .prepare(`EXPLAIN QUERY PLAN ${activitySql}`)
        .all({ connection: "alpha", limit: 200 });
      expect(
        JSON.stringify(activityPlan).match(/USING COVERING INDEX idx_requests_activity/g),
      ).toHaveLength(2);
      // The kept flag is one primary-key probe per served entry, never a scan of the payloads.
      expect(JSON.stringify(activityPlan)).toContain(
        "SEARCH k USING COVERING INDEX sqlite_autoindex_results_1 (request_id=?)",
      );
      const purgeSql = statements.find((sql) => sql.includes("AS row_count"))!;
      expect(
        JSON.stringify(ctx.db.prepare(`EXPLAIN QUERY PLAN ${purgeSql}`).all(10 ** 12)),
      ).toContain("idx_requests_result_purge");
      const sessionsSql = statements.find((sql) => sql.includes("DELETE FROM sessions"))!;
      const sessionsPlan = JSON.stringify(
        ctx.db.prepare(`EXPLAIN QUERY PLAN ${sessionsSql}`).all(10 ** 12),
      );
      expect(sessionsPlan).toContain("idx_sessions_last_seen");
      expect(sessionsPlan).toContain("idx_requests_session");
      expect(ctx.db.prepare("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 100_000 });
      expect(listActivity(ctx, "alpha")[0].sessionLabel).toBe("Synthetic retained session");
      console.info(
        `Synthetic audit: ${Math.round((afterBytes - beforeBytes) / 100_000)} bytes/decision including indexes, 200 entries read in ${elapsed.toFixed(1)} ms`,
      );
    } finally {
      ctx.db.close();
    }
  });
});

describe("activity paging", () => {
  it("walks the whole retained history once, in order, across tied timestamps", () => {
    const ctx = createContext({ now: () => 10 ** 12 });
    try {
      migrate(ctx.db);
      const insert = ctx.db.prepare(`INSERT INTO requests
        (id, created_at, session_id, sql, state, decided_at, result_json, expires_at, connection)
        VALUES (?, 1, 's1', 'SELECT 1', 'rejected', ?, '{"reason":null}', 3, ?)`);
      const id = (i: number) => `req_${i.toString(16).padStart(12, "0")}`;
      ctx.db.transaction(() => {
        for (let i = 0; i < 450; i++) {
          // Three rows per timestamp, one per scope, so every page edge cuts a tie.
          insert.run(id(i), Math.floor(i / 3), [null, "alpha", "beta"][i % 3]);
        }
      })();
      const expected = Array.from({ length: 450 }, (_, i) => i)
        .filter((i) => i % 3 !== 2)
        .reverse()
        .map(id);

      const prepare = vi.spyOn(ctx.db, "prepare");
      const seen: string[] = [];
      let page = listActivity(ctx, "alpha", 199);
      while (page.length) {
        seen.push(...page.map((e) => e.id));
        const last = page[page.length - 1];
        page = listActivity(ctx, "alpha", 199, { decidedAt: last.decidedAt!, id: last.id });
      }
      expect(seen).toEqual(expected);

      const cursorSql = prepare.mock.calls
        .map(([sql]) => sql)
        .find((s) => s.includes("@beforeAt"))!;
      prepare.mockRestore();
      const plan = ctx.db
        .prepare(`EXPLAIN QUERY PLAN ${cursorSql}`)
        .all({ connection: "alpha", limit: 199, beforeAt: 100, beforeId: id(300) });
      expect(
        JSON.stringify(plan).match(/USING COVERING INDEX idx_requests_activity/g),
      ).toHaveLength(2);
      // A seek, not a filtered scan: both branches bound the index range by the cursor.
      expect(
        plan.filter((step) =>
          String((step as { detail: string }).detail).includes("(decided_at,id)<(?,?)"),
        ),
      ).toHaveLength(2);
    } finally {
      ctx.db.close();
    }
  });
});

describe("sensitivity record read back", () => {
  it("reads a malformed stored record as not recorded", () => {
    const ctx = createContext({ now: () => 10 ** 12 });
    try {
      migrate(ctx.db);
      ctx.db
        .prepare(`INSERT INTO requests
          (id, created_at, session_id, sql, state, decided_at, result_json, policy_json, expires_at)
          VALUES ('req_000000000001', 1, 's1', 'SELECT 1', 'rejected', 2, '{"reason":null}', ?, 3)`)
        .run(JSON.stringify({ sensitivity: { pii: "yes", value: false, client: false } }));
      expect(listActivity(ctx, null)[0].sensitivity).toBeUndefined();
    } finally {
      ctx.db.close();
    }
  });
});

describe("request history", () => {
  it("refuses the delete servers before 0.3.0 still run, and keeps the request", () => {
    const ctx = createContext();
    try {
      migrate(ctx.db);
      ctx.db
        .prepare(`INSERT INTO requests
        (id, created_at, session_id, sql, state, decided_at, expires_at)
        VALUES ('old', 1, 's1', 'SELECT 1', 'approved', 2, 3)`)
        .run();
      // The retention statement of 0.1.x and 0.2.0, verbatim.
      const legacy = ctx.db.prepare(
        "DELETE FROM requests WHERE decided_at IS NOT NULL AND decided_at < ?",
      );
      expect(() => legacy.run(Date.now())).toThrow("Request history is kept");
      // Opening the store again and today's sweep are unaffected.
      migrate(ctx.db);
      sweep(ctx);
      expect(get(ctx, "old")?.id).toBe("old");
    } finally {
      ctx.db.close();
    }
  });
});
