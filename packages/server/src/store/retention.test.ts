import { describe, expect, it, vi } from "vitest";
import { toTicket } from "../service.js";
import { listActivity } from "./audit.js";
import { createContext, migrate } from "./db.js";
import { get, sweep } from "./requests.js";
import { outcomeFacts } from "./rows.js";

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
  ])("extracts only known scalar counts from $result", ({ result, rowCount, affectedRows }) => {
    expect(outcomeFacts("approved", JSON.stringify(result))).toEqual({
      reason: null,
      error: null,
      rowCount,
      affectedRows,
    });
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
